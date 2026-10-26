/**
 * SyncPad Cloudflare Worker Backend
 * Serves Static Assets from ./public and provides real-time multi-device sync
 * via WebSockets & REST with Cloudflare Durable Objects.
 */

// Lightweight WebSocketPair fallback for Node.js test environments
class SimpleWebSocketPair {
  constructor() {
    const listenersA = new Map();
    const listenersB = new Map();

    const createEndpoint = (myListeners, peerListeners) => ({
      readyState: 1, // OPEN
      accept() {},
      send(data) {
        const cbs = peerListeners.get('message') || [];
        for (const cb of cbs) {
          try { cb({ data }); } catch (err) { console.error(err); }
        }
      },
      close() {
        this.readyState = 3; // CLOSED
        const cbs = peerListeners.get('close') || [];
        for (const cb of cbs) cb();
      },
      addEventListener(type, cb) {
        if (!myListeners.has(type)) myListeners.set(type, []);
        myListeners.get(type).push(cb);
      }
    });

    this[0] = createEndpoint(listenersA, listenersB);
    this[1] = createEndpoint(listenersB, listenersA);
  }
}

const WSPair = typeof WebSocketPair !== 'undefined' ? WebSocketPair : SimpleWebSocketPair;

export class SyncRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map(); // webSocket -> { deviceId }
    this.notes = new Map(); // noteId -> note object

    // Load persisted room notes if storage is available
    if (this.ctx && this.ctx.storage) {
      this.ctx.blockConcurrencyWhile(async () => {
        try {
          const stored = await this.ctx.storage.get('notes');
          if (stored && typeof stored === 'object') {
            this.notes = new Map(Object.entries(stored));
          }
        } catch (err) {
          console.error('Failed to load notes from DO storage:', err);
        }
      });
    }
  }

  shouldApplyNote(incoming, existing) {
    if (!existing) return true;
    const incomingTime = new Date(incoming.updatedAt || 0).getTime();
    const existingTime = new Date(existing.updatedAt || 0).getTime();
    if (incomingTime > existingTime) return true;
    if (incomingTime < existingTime) return false;
    return (incoming.version || 0) >= (existing.version || 0);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket Upgrade
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WSPair();
      const [client, server] = [pair[0], pair[1]];

      const deviceId = url.searchParams.get('deviceId') || `dev_${Math.random().toString(36).slice(2, 8)}`;
      await this.handleSession(server, deviceId);

      try {
        return new Response(null, {
          status: 101,
          webSocket: client
        });
      } catch (_) {
        // Fallback for Node.js test environment where undici restricts Response status to 200-599
        return {
          status: 101,
          webSocket: client,
          headers: new Headers({ Upgrade: 'websocket' })
        };
      }
    }

    // REST Sync Endpoint: POST /api/room/:roomCode/sync or POST /api/sync
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const syncResult = await this.handleRestSync(body);
        return new Response(JSON.stringify(syncResult), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    return new Response(JSON.stringify({ status: 'ok', roomNotesCount: this.notes.size }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  async handleSession(webSocket, deviceId) {
    webSocket.accept();
    this.sessions.set(webSocket, { deviceId });

    // Broadcast presence update to everyone in room
    this.broadcastPresence();

    webSocket.addEventListener('message', async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await this.handleMessage(webSocket, deviceId, msg);
      } catch (err) {
        console.error('Error handling WebSocket message in DO:', err);
      }
    });

    const cleanup = () => {
      this.sessions.delete(webSocket);
      this.broadcastPresence();
    };

    webSocket.addEventListener('close', cleanup);
    webSocket.addEventListener('error', cleanup);
  }

  broadcastPresence() {
    const count = this.sessions.size;
    const payload = JSON.stringify({
      type: 'PEER_PRESENCE',
      count
    });

    for (const [ws] of this.sessions) {
      try {
        ws.send(payload);
      } catch (_) {}
    }
  }

  async handleMessage(senderWs, senderDeviceId, msg) {
    switch (msg.type) {
      case 'PING': {
        try {
          senderWs.send(JSON.stringify({ type: 'PONG' }));
        } catch (_) {}
        break;
      }

      case 'JOIN': {
        // If client sends existing notes on join, merge with room
        if (Array.isArray(msg.notes)) {
          for (const note of msg.notes) {
            if (note && note.id) {
              const existing = this.notes.get(note.id);
              if (this.shouldApplyNote(note, existing)) {
                this.notes.set(note.id, note);
              }
            }
          }
          await this.persistNotes();
        }

        // Send active notes and tombstones so newly joined devices delete removed notes
        const allNotes = Array.from(this.notes.values());
        try {
          senderWs.send(JSON.stringify({
            type: 'ROOM_SYNC_RESPONSE',
            notes: allNotes.filter((n) => !n.isDeleted),
            deletedNotes: allNotes.filter((n) => n.isDeleted)
          }));
        } catch (_) {}
        break;
      }

      case 'ROOM_SYNC_REQUEST': {
        if (Array.isArray(msg.notes)) {
          for (const note of msg.notes) {
            if (note && note.id) {
              const existing = this.notes.get(note.id);
              if (this.shouldApplyNote(note, existing)) {
                this.notes.set(note.id, note);
              }
            }
          }
          await this.persistNotes();
        }

        const allNotes = Array.from(this.notes.values());
        try {
          senderWs.send(JSON.stringify({
            type: 'ROOM_SYNC_RESPONSE',
            notes: allNotes.filter((n) => !n.isDeleted),
            deletedNotes: allNotes.filter((n) => n.isDeleted)
          }));
        } catch (_) {}
        break;
      }

      case 'NOTE_UPDATE': {
        if (!msg.note || !msg.note.id) break;
        const incoming = msg.note;
        const existing = this.notes.get(incoming.id);

        if (this.shouldApplyNote(incoming, existing)) {
          this.notes.set(incoming.id, incoming);
          await this.persistNotes();

          // Broadcast to all other peers in the room
          this.broadcast(JSON.stringify({
            type: 'NOTE_UPDATE',
            deviceId: senderDeviceId,
            note: incoming
          }), senderWs);
        } else {
          // Reject stale edit and notify sender of the authoritative current version
          try {
            senderWs.send(JSON.stringify({
              type: 'NOTE_UPDATE',
              deviceId: 'server',
              note: existing
            }));
          } catch (_) {}
        }
        break;
      }

      case 'NOTE_DELETE': {
        if (!msg.noteId) break;
        const existing = this.notes.get(msg.noteId);
        const tombstone = {
          id: msg.noteId,
          updatedAt: msg.updatedAt || new Date().toISOString(),
          version: msg.version || (existing && existing.version ? existing.version + 1 : 1),
          isDeleted: true
        };

        if (this.shouldApplyNote(tombstone, existing)) {
          this.notes.set(msg.noteId, tombstone);
          await this.persistNotes();

          this.broadcast(JSON.stringify({
            type: 'NOTE_DELETE',
            deviceId: senderDeviceId,
            noteId: msg.noteId,
            updatedAt: tombstone.updatedAt,
            version: tombstone.version
          }), senderWs);
        }
        break;
      }

      default:
        break;
    }
  }

  broadcast(messageString, excludeWs = null) {
    for (const [ws] of this.sessions) {
      if (ws !== excludeWs) {
        try {
          ws.send(messageString);
        } catch (_) {}
      }
    }
  }

  async handleRestSync({ deviceId, changes = [], clientNotes = [] }) {
    const updatedNotes = [];

    // Apply changes from client
    for (const note of changes) {
      if (note && note.id) {
        const existing = this.notes.get(note.id);
        if (this.shouldApplyNote(note, existing)) {
          this.notes.set(note.id, note);
          updatedNotes.push(note);
        }
      }
    }

    // Apply any newer client notes
    for (const clientNote of clientNotes) {
      if (!clientNote || !clientNote.id) continue;
      const existing = this.notes.get(clientNote.id);
      if (this.shouldApplyNote(clientNote, existing)) {
        this.notes.set(clientNote.id, clientNote);
        updatedNotes.push(clientNote);
      }
    }

    if (updatedNotes.length > 0) {
      await this.persistNotes();

      // Broadcast updates to connected WebSocket peers in this room
      for (const note of updatedNotes) {
        this.broadcast(JSON.stringify({
          type: note.isDeleted ? 'NOTE_DELETE' : 'NOTE_UPDATE',
          deviceId: deviceId || 'rest_client',
          noteId: note.id,
          note: note.isDeleted ? undefined : note,
          updatedAt: note.updatedAt,
          version: note.version
        }));
      }
    }

    const all = Array.from(this.notes.values());
    // Return active notes and tombstones
    return {
      notes: all.filter((n) => !n.isDeleted),
      deletedNotes: all.filter((n) => n.isDeleted)
    };
  }

  async persistNotes() {
    if (this.ctx && this.ctx.storage) {
      try {
        const obj = Object.fromEntries(this.notes);
        await this.ctx.storage.put('notes', obj);
      } catch (err) {
        console.error('Error persisting notes in DO:', err);
      }
    }
  }
}

// In-Memory fallback for environments without Durable Object bindings (e.g. tests, standard workers)
const memoryRooms = new Map();

function getMemoryRoom(roomCode) {
  if (!memoryRooms.has(roomCode)) {
    memoryRooms.set(roomCode, new SyncRoom(null, null));
  }
  return memoryRooms.get(roomCode);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API Routes
    if (url.pathname.startsWith('/api/')) {
      // CORS Preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Upgrade'
          }
        });
      }

      // Health Check
      if (url.pathname === '/api/health') {
        return new Response(JSON.stringify({ status: 'ok', app: 'syncpad' }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // Generic /api/room (Generate or inspect room)
      if (url.pathname === '/api/room' || url.pathname === '/api/room/') {
        const prefixes = ['PAD', 'SYNC', 'NOTE', 'ROOM', 'FLOW'];
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const num = Math.floor(100 + Math.random() * 900);
        const roomCode = `${prefix}-${num}`;
        return new Response(JSON.stringify({ status: 'ok', roomCode }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // Generic /api/sync (Sync with room passed in query or body)
      if (url.pathname === '/api/sync' || url.pathname === '/api/sync/') {
        let roomCode = (url.searchParams.get('room') || url.searchParams.get('roomCode') || '').toUpperCase();
        if (!roomCode && request.method === 'POST') {
          const cloned = request.clone();
          try {
            const body = await cloned.json();
            if (body && (body.roomCode || body.room)) {
              roomCode = (body.roomCode || body.room).toUpperCase();
            }
          } catch (_) {}
        }
        roomCode = roomCode || 'DEFAULT';

        if (env && env.SYNC_ROOM) {
          const id = env.SYNC_ROOM.idFromName(roomCode);
          const roomObject = env.SYNC_ROOM.get(id);
          return roomObject.fetch(request);
        }

        const memRoom = getMemoryRoom(roomCode);
        return memRoom.fetch(request);
      }

      // Room routes: /api/room/:roomCode/ws or /api/room/:roomCode/sync
      const roomMatch = url.pathname.match(/^\/api\/room\/([A-Za-z0-9_-]+)(?:\/(ws|sync))?$/);
      if (roomMatch) {
        const roomCode = roomMatch[1].toUpperCase();

        // If Durable Object binding is configured, use DO
        if (env && env.SYNC_ROOM) {
          const id = env.SYNC_ROOM.idFromName(roomCode);
          const roomObject = env.SYNC_ROOM.get(id);
          return roomObject.fetch(request);
        }

        // In-memory fallback
        const memRoom = getMemoryRoom(roomCode);
        return memRoom.fetch(request);
      }

      return new Response(JSON.stringify({ error: 'Endpoint not found' }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Static Assets serving (Cloudflare Workers Static Assets)
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('SyncPad static assets not bound. Please configure Workers Assets.', { status: 404 });
  }
};
