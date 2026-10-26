/**
 * SyncPad Cloudflare Worker Backend
 * Serves Static Assets from ./public and provides real-time multi-device sync
 * via WebSockets & REST with Cloudflare Durable Objects.
 */

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

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket Upgrade
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const deviceId = url.searchParams.get('deviceId') || `dev_${Math.random().toString(36).slice(2, 8)}`;
      await this.handleSession(server, deviceId);

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    // REST Sync Endpoint: POST /api/room/:roomCode/sync
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const responseNotes = await this.handleRestSync(body);
        return new Response(JSON.stringify({ notes: responseNotes }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response(JSON.stringify({ status: 'ok', roomNotesCount: this.notes.size }), {
      headers: { 'Content-Type': 'application/json' }
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
        // Welcome and send initial notes state to the newly joined device
        const activeNotes = Array.from(this.notes.values()).filter((n) => !n.isDeleted);
        try {
          senderWs.send(JSON.stringify({
            type: 'ROOM_SYNC_RESPONSE',
            notes: activeNotes
          }));
        } catch (_) {}
        break;
      }

      case 'ROOM_SYNC_REQUEST': {
        // Client requesting latest notes
        const activeNotes = Array.from(this.notes.values()).filter((n) => !n.isDeleted);
        try {
          senderWs.send(JSON.stringify({
            type: 'ROOM_SYNC_RESPONSE',
            notes: activeNotes
          }));
        } catch (_) {}
        break;
      }

      case 'NOTE_UPDATE': {
        if (!msg.note || !msg.note.id) break;
        const incoming = msg.note;
        const existing = this.notes.get(incoming.id);

        let shouldApply = false;
        if (!existing) {
          shouldApply = true;
        } else {
          const incomingTime = new Date(incoming.updatedAt || 0).getTime();
          const existingTime = new Date(existing.updatedAt || 0).getTime();
          if (incomingTime > existingTime) {
            shouldApply = true;
          } else if (incomingTime === existingTime) {
            shouldApply = (incoming.version || 0) >= (existing.version || 0);
          }
        }

        if (shouldApply) {
          this.notes.set(incoming.id, incoming);
          await this.persistNotes();

          // Broadcast to all other peers in the room
          this.broadcast(JSON.stringify({
            type: 'NOTE_UPDATE',
            deviceId: senderDeviceId,
            note: incoming
          }), senderWs);
        }
        break;
      }

      case 'NOTE_DELETE': {
        if (!msg.noteId) break;
        const tombstone = {
          id: msg.noteId,
          updatedAt: msg.updatedAt || new Date().toISOString(),
          isDeleted: true
        };

        this.notes.set(msg.noteId, tombstone);
        await this.persistNotes();

        this.broadcast(JSON.stringify({
          type: 'NOTE_DELETE',
          deviceId: senderDeviceId,
          noteId: msg.noteId,
          updatedAt: tombstone.updatedAt
        }), senderWs);
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
    // Apply changes from client
    for (const note of changes) {
      if (note && note.id) {
        this.notes.set(note.id, note);
      }
    }

    // Apply any newer client notes
    for (const clientNote of clientNotes) {
      if (!clientNote || !clientNote.id) continue;
      const existing = this.notes.get(clientNote.id);
      if (!existing) {
        this.notes.set(clientNote.id, clientNote);
      } else {
        const clientTime = new Date(clientNote.updatedAt || 0).getTime();
        const existingTime = new Date(existing.updatedAt || 0).getTime();
        if (clientTime > existingTime) {
          this.notes.set(clientNote.id, clientNote);
        }
      }
    }

    await this.persistNotes();
    return Array.from(this.notes.values()).filter((n) => !n.isDeleted);
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
          headers: { 'Content-Type': 'application/json' }
        });
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
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Static Assets serving (Cloudflare Workers Static Assets)
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('SyncPad static assets not bound. Please configure Workers Assets.', { status: 404 });
  }
};
