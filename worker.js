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

/**
 * Safe SSRF check: prevents requests to private, internal or loopback IP ranges
 */
export function isPrivateOrLocalHost(hostname) {
  if (!hostname) return true;
  const host = hostname.toLowerCase().trim();
  
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === 'instance-data'
  ) {
    return true;
  }

  // IPv4 check: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (link-local)
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = parseInt(ipv4Match[1], 10);
    const b = parseInt(ipv4Match[2], 10);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // cloud metadata / link-local
  }

  return false;
}

/**
 * Decode HTML entities in extracted metadata
 */
export function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .trim();
}

/**
 * Extract OpenGraph and HTML metadata from HTML text
 */
export function extractHtmlMetadata(html, targetUrl) {
  const result = {
    title: '',
    description: '',
    image: '',
    siteName: '',
    favicon: ''
  };

  try {
    const baseUrl = new URL(targetUrl);
    result.siteName = baseUrl.hostname.replace(/^www\./i, '');
    result.favicon = `https://${baseUrl.hostname}/favicon.ico`;

    // 1. Title (og:title -> twitter:title -> <title>)
    const ogTitleMatch = html.match(/<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                         html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    const twTitleMatch = html.match(/<meta\s+[^>]*name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i) ||
                         html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:title["']/i);
    const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

    if (ogTitleMatch && ogTitleMatch[1]) {
      result.title = decodeHtmlEntities(ogTitleMatch[1]);
    } else if (twTitleMatch && twTitleMatch[1]) {
      result.title = decodeHtmlEntities(twTitleMatch[1]);
    } else if (titleTagMatch && titleTagMatch[1]) {
      result.title = decodeHtmlEntities(titleTagMatch[1]);
    }

    // 2. Description (og:description -> twitter:description -> meta description)
    const ogDescMatch = html.match(/<meta\s+[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                        html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
    const twDescMatch = html.match(/<meta\s+[^>]*name=["']twitter:description["'][^>]*content=["']([^"']+)["']/i) ||
                        html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:description["']/i);
    const metaDescMatch = html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                          html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);

    if (ogDescMatch && ogDescMatch[1]) {
      result.description = decodeHtmlEntities(ogDescMatch[1]);
    } else if (twDescMatch && twDescMatch[1]) {
      result.description = decodeHtmlEntities(twDescMatch[1]);
    } else if (metaDescMatch && metaDescMatch[1]) {
      result.description = decodeHtmlEntities(metaDescMatch[1]);
    }

    // 3. Image (og:image -> twitter:image -> link image_src)
    const ogImgMatch = html.match(/<meta\s+[^>]*property=["']og:image(?::url)?["'][^>]*content=["']([^"']+)["']/i) ||
                       html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:image(?::url)?["']/i);
    const twImgMatch = html.match(/<meta\s+[^>]*name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i) ||
                       html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["']/i);
    const linkImgMatch = html.match(/<link\s+[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["']/i);

    let rawImg = '';
    if (ogImgMatch && ogImgMatch[1]) {
      rawImg = ogImgMatch[1].trim();
    } else if (twImgMatch && twImgMatch[1]) {
      rawImg = twImgMatch[1].trim();
    } else if (linkImgMatch && linkImgMatch[1]) {
      rawImg = linkImgMatch[1].trim();
    }

    if (rawImg) {
      try {
        result.image = new URL(rawImg, targetUrl).href;
      } catch (_) {
        result.image = rawImg;
      }
    }

    // 4. Site Name
    const siteNameMatch = html.match(/<meta\s+[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
    if (siteNameMatch && siteNameMatch[1]) {
      result.siteName = decodeHtmlEntities(siteNameMatch[1].trim());
    }

    // 5. Favicon
    const iconMatch = html.match(/<link\s+[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*href=["']([^"']+)["']/i);
    if (iconMatch && iconMatch[1]) {
      try {
        result.favicon = new URL(iconMatch[1].trim(), targetUrl).href;
      } catch (_) {}
    }
  } catch (_) {}

  return result;
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

      // Link Metadata Endpoint: GET /api/link-metadata?url=...
      if (url.pathname === '/api/link-metadata') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
          return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        let parsedTarget;
        try {
          parsedTarget = new URL(targetUrl);
        } catch (_) {
          return new Response(JSON.stringify({ error: 'Invalid URL' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
          return new Response(JSON.stringify({ error: 'Protocol not allowed' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        if (isPrivateOrLocalHost(parsedTarget.hostname)) {
          return new Response(JSON.stringify({ error: 'Target host is not permitted' }), {
            status: 403,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 7500);

          const upstreamRes = await fetch(targetUrl, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/*,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9'
            },
            redirect: 'follow'
          });
          clearTimeout(timeoutId);

          if (!upstreamRes.ok) {
            return new Response(JSON.stringify({
              error: `Upstream website returned ${upstreamRes.status}`,
              status: upstreamRes.status
            }), {
              status: upstreamRes.status >= 400 && upstreamRes.status < 500 ? upstreamRes.status : 502,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }

          const contentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();

          // If the URL directly points to an image
          if (contentType.startsWith('image/')) {
            const pathname = parsedTarget.pathname;
            const fileName = pathname.substring(pathname.lastIndexOf('/') + 1) || 'image';
            return new Response(JSON.stringify({
              status: 'ok',
              url: targetUrl,
              isImage: true,
              title: fileName,
              description: '',
              image: targetUrl,
              siteName: parsedTarget.hostname.replace(/^www\./i, ''),
              contentType
            }), {
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }

          // Otherwise parse HTML (read first 512KB to avoid memory bloat)
          const text = await upstreamRes.text();
          const sample = text.slice(0, 524288);
          const meta = extractHtmlMetadata(sample, targetUrl);

          return new Response(JSON.stringify({
            status: 'ok',
            url: targetUrl,
            isImage: false,
            title: meta.title || parsedTarget.hostname,
            description: meta.description || '',
            image: meta.image || '',
            siteName: meta.siteName || parsedTarget.hostname.replace(/^www\./i, ''),
            favicon: meta.favicon || ''
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        } catch (err) {
          const isTimeout = err.name === 'AbortError';
          return new Response(JSON.stringify({
            error: isTimeout ? 'Request timed out' : (err.message || 'Failed to fetch link metadata')
          }), {
            status: isTimeout ? 504 : 502,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      }

      // Proxy Image / Resource Endpoint: GET /api/proxy?url=...
      if (url.pathname === '/api/proxy') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
          return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        let parsedTarget;
        try {
          parsedTarget = new URL(targetUrl);
        } catch (_) {
          return new Response(JSON.stringify({ error: 'Invalid URL' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
          return new Response(JSON.stringify({ error: 'Protocol not allowed' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        if (isPrivateOrLocalHost(parsedTarget.hostname)) {
          return new Response(JSON.stringify({ error: 'Target host is not permitted' }), {
            status: 403,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);

          const upstreamRes = await fetch(targetUrl, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9'
            },
            redirect: 'follow'
          });
          clearTimeout(timeoutId);

          if (!upstreamRes.ok) {
            return new Response(JSON.stringify({
              error: `Upstream returned ${upstreamRes.status}`,
              status: upstreamRes.status
            }), {
              status: upstreamRes.status >= 400 && upstreamRes.status < 500 ? upstreamRes.status : 502,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }

          const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';
          const headers = new Headers();
          headers.set('Content-Type', contentType);
          headers.set('Access-Control-Allow-Origin', '*');
          headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
          headers.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
          headers.set('X-Content-Type-Options', 'nosniff');

          return new Response(upstreamRes.body, {
            status: 200,
            headers
          });
        } catch (err) {
          const isTimeout = err.name === 'AbortError';
          return new Response(JSON.stringify({
            error: isTimeout ? 'Request timed out' : (err.message || 'Failed to proxy resource')
          }), {
            status: isTimeout ? 504 : 502,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
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
