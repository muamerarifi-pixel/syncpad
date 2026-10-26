/**
 * SyncPad Real-Time Synchronization Module
 * Handles WebSocket connection, room coordination, peer presence, and offline queue flushing.
 */

import {
  getPendingSyncItems,
  clearPendingSyncItems,
  applyRemoteNote,
  getAllNotes,
  getOrCreateDeviceId,
  getSetting,
  setSetting
} from './db.js';

export const SyncStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  SYNCING: 'syncing',
  OFFLINE: 'offline'
};

class SyncManager {
  constructor() {
    this.ws = null;
    this.roomCode = null;
    this.deviceId = null;
    this.status = SyncStatus.DISCONNECTED;
    this.peerCount = 1;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.listeners = new Map(); // event -> Set of callbacks
    this.isFlushing = false;

    // Monitor browser online/offline events
    window.addEventListener('online', () => {
      this.notifyStatus(SyncStatus.CONNECTING);
      this.reconnectAttempts = 0;
      this.connect();
    });

    window.addEventListener('offline', () => {
      this.notifyStatus(SyncStatus.OFFLINE);
      if (this.ws) {
        try { this.ws.close(); } catch (_) {}
        this.ws = null;
      }
    });
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      for (const cb of this.listeners.get(event)) {
        try {
          cb(data);
        } catch (err) {
          console.error(`Error in sync event listener [${event}]:`, err);
        }
      }
    }
  }

  notifyStatus(status) {
    this.status = status;
    this.emit('statusChange', { status, roomCode: this.roomCode, peerCount: this.peerCount });
  }

  /**
   * Generate a readable room code e.g. "PAD-742" or "SYNC-894"
   */
  generateRoomCode() {
    const prefixes = ['PAD', 'SYNC', 'NOTE', 'ROOM', 'FLOW'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const num = Math.floor(100 + Math.random() * 900);
    return `${prefix}-${num}`;
  }

  /**
   * Sanitize room code to uppercase alphanumeric with optional hyphen
   */
  sanitizeRoomCode(code) {
    if (!code) return '';
    return code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16);
  }

  /**
   * Initialize sync manager with room code from URL or stored settings
   */
  async init() {
    this.deviceId = await getOrCreateDeviceId();

    // Check URL search param (?room=XYZ) or hash (#room=XYZ)
    const urlParams = new URLSearchParams(window.location.search);
    let roomFromUrl = urlParams.get('room');
    if (!roomFromUrl && window.location.hash) {
      const hash = window.location.hash.replace(/^#/, '');
      const hashParams = new URLSearchParams(hash);
      roomFromUrl = hashParams.get('room') || (hash.startsWith('room=') ? hash.split('=')[1] : null);
    }

    if (roomFromUrl) {
      this.roomCode = this.sanitizeRoomCode(roomFromUrl);
      await setSetting('roomCode', this.roomCode);
    } else {
      this.roomCode = await getSetting('roomCode');
      if (!this.roomCode) {
        this.roomCode = this.generateRoomCode();
        await setSetting('roomCode', this.roomCode);
      }
    }

    // Connect to room
    this.connect();
    return this.roomCode;
  }

  /**
   * Switch or join a new room
   */
  async joinRoom(newRoomCode) {
    const sanitized = this.sanitizeRoomCode(newRoomCode);
    if (!sanitized) return;

    if (this.roomCode === sanitized && this.status === SyncStatus.CONNECTED) {
      return; // Already in this room
    }

    this.roomCode = sanitized;
    await setSetting('roomCode', this.roomCode);

    // Update URL query param without reload
    const url = new URL(window.location.href);
    url.searchParams.set('room', this.roomCode);
    window.history.replaceState({}, '', url.toString());

    // Reconnect
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.reconnectAttempts = 0;
    this.connect();
  }

  /**
   * Connect to WebSocket endpoint
   */
  connect() {
    if (!navigator.onLine) {
      this.notifyStatus(SyncStatus.OFFLINE);
      return;
    }

    if (!this.roomCode) return;

    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingInterval);

    this.notifyStatus(SyncStatus.CONNECTING);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/room/${encodeURIComponent(this.roomCode)}/ws?deviceId=${encodeURIComponent(this.deviceId)}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = async () => {
        this.reconnectAttempts = 0;
        this.notifyStatus(SyncStatus.CONNECTED);

        // Send JOIN announcement
        this.send({
          type: 'JOIN',
          roomCode: this.roomCode,
          deviceId: this.deviceId,
          timestamp: new Date().toISOString()
        });

        // Request initial full room sync
        const localNotes = await getAllNotes();
        this.send({
          type: 'ROOM_SYNC_REQUEST',
          roomCode: this.roomCode,
          deviceId: this.deviceId,
          knownNotes: localNotes.map((n) => ({ id: n.id, updatedAt: n.updatedAt, version: n.version }))
        });

        // Flush queued offline items
        this.flushPendingQueue();

        // Start ping heartbeat (every 25 seconds)
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.send({ type: 'PING' });
          }
        }, 25000);
      };

      this.ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          await this.handleMessage(msg);
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err, event.data);
        }
      };

      this.ws.onclose = () => {
        clearInterval(this.pingInterval);
        this.ws = null;
        if (navigator.onLine) {
          this.notifyStatus(SyncStatus.DISCONNECTED);
          this.scheduleReconnect();
        } else {
          this.notifyStatus(SyncStatus.OFFLINE);
        }
      };

      this.ws.onerror = (err) => {
        console.warn('WebSocket error, falling back to reconnect/REST:', err);
        // If WebSocket fails (e.g. static dev server or blocked WS), fallback to REST sync
        this.fallbackRestSync();
      };
    } catch (err) {
      console.error('WebSocket connection error:', err);
      this.notifyStatus(SyncStatus.DISCONNECTED);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    // Exponential backoff: 1s, 2s, 4s, 8s, up to 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
        return true;
      } catch (err) {
        console.error('Error sending WS message:', err);
        return false;
      }
    }
    return false;
  }

  /**
   * Broadcast local note update to all peers in room
   */
  broadcastNoteUpdate(note) {
    const sent = this.send({
      type: 'NOTE_UPDATE',
      roomCode: this.roomCode,
      deviceId: this.deviceId,
      note
    });

    if (!sent) {
      // If offline or WS closed, the note is already in IndexedDB sync_queue!
      this.notifyStatus(navigator.onLine ? SyncStatus.DISCONNECTED : SyncStatus.OFFLINE);
    }
  }

  /**
   * Broadcast note deletion to all peers in room
   */
  broadcastNoteDelete(noteId, updatedAt) {
    this.send({
      type: 'NOTE_DELETE',
      roomCode: this.roomCode,
      deviceId: this.deviceId,
      noteId,
      updatedAt
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  async handleMessage(msg) {
    switch (msg.type) {
      case 'PEER_PRESENCE': {
        this.peerCount = msg.count || 1;
        this.emit('presence', { count: this.peerCount, peers: msg.peers });
        break;
      }

      case 'NOTE_UPDATE': {
        if (!msg.note) break;
        // Skip echo of own update if deviceId matches
        if (msg.deviceId === this.deviceId) break;

        const { applied, note } = await applyRemoteNote(msg.note);
        if (applied) {
          this.emit('remoteNoteChange', { note, action: 'update' });
        }
        break;
      }

      case 'NOTE_DELETE': {
        if (msg.deviceId === this.deviceId) break;

        const tombstone = {
          id: msg.noteId,
          updatedAt: msg.updatedAt || new Date().toISOString(),
          isDeleted: true
        };
        const { applied } = await applyRemoteNote(tombstone);
        if (applied) {
          this.emit('remoteNoteChange', { note: tombstone, action: 'delete' });
        }
        break;
      }

      case 'ROOM_SYNC_RESPONSE': {
        // Bulk sync received from server or peer
        if (Array.isArray(msg.notes)) {
          let updatedAny = false;
          for (const remoteNote of msg.notes) {
            const { applied } = await applyRemoteNote(remoteNote);
            if (applied) updatedAny = true;
          }
          if (updatedAny) {
            this.emit('roomSynced', { count: msg.notes.length });
          }
        }
        break;
      }

      case 'ROOM_SYNC_REQUEST': {
        // Another peer requested room sync; send our active notes
        if (msg.deviceId !== this.deviceId) {
          const notes = await getAllNotes();
          this.send({
            type: 'ROOM_SYNC_RESPONSE',
            roomCode: this.roomCode,
            deviceId: this.deviceId,
            targetDeviceId: msg.deviceId,
            notes
          });
        }
        break;
      }

      case 'PONG': {
        // Heartbeat ACK
        break;
      }

      default:
        break;
    }
  }

  /**
   * Flush pending offline edits to the server
   */
  async flushPendingQueue() {
    if (this.isFlushing) return;
    this.isFlushing = true;

    try {
      const items = await getPendingSyncItems();
      if (!items || items.length === 0) {
        this.isFlushing = false;
        return;
      }

      this.notifyStatus(SyncStatus.SYNCING);
      const processedIds = [];

      for (const item of items) {
        if (item.action === 'UPSERT') {
          const success = this.send({
            type: 'NOTE_UPDATE',
            roomCode: this.roomCode,
            deviceId: this.deviceId,
            note: item.data
          });
          if (success) processedIds.push(item.id);
        } else if (item.action === 'DELETE') {
          const success = this.send({
            type: 'NOTE_DELETE',
            roomCode: this.roomCode,
            deviceId: this.deviceId,
            noteId: item.noteId,
            updatedAt: item.data?.updatedAt
          });
          if (success) processedIds.push(item.id);
        }
      }

      if (processedIds.length > 0) {
        await clearPendingSyncItems(processedIds);
      }

      this.notifyStatus(SyncStatus.CONNECTED);
    } catch (err) {
      console.error('Error flushing sync queue:', err);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Fallback REST sync when WebSockets are unavailable
   */
  async fallbackRestSync() {
    if (!navigator.onLine || !this.roomCode) return;

    try {
      const pending = await getPendingSyncItems();
      const localNotes = await getAllNotes();

      const response = await fetch(`/api/room/${encodeURIComponent(this.roomCode)}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: this.deviceId,
          changes: pending.map((p) => p.data),
          clientNotes: localNotes
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data && Array.isArray(data.notes)) {
          for (const note of data.notes) {
            await applyRemoteNote(note);
          }
          if (pending.length > 0) {
            await clearPendingSyncItems(pending.map((p) => p.id));
          }
          this.emit('roomSynced', { count: data.notes.length });
        }
      }
    } catch (_) {
      // Quietly ignore REST failure
    }
  }
}

export const syncManager = new SyncManager();
