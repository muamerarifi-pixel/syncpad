/**
 * SyncPad v2 — Cloudflare Worker + Durable Object backend
 *
 * One Durable Object instance per "space" (a private, unguessable 144-bit key shared
 * by all of your devices). Notes, clips and file metadata live in the object's SQLite
 * database; file bytes are stored in 1 MiB chunks in the same database, so no extra
 * Cloudflare resources (R2, KV, D1) are needed and everything stays on the free plan.
 *
 * A single "__global__" instance handles 6-digit pairing codes and a storage cap that
 * protects the account-wide 5 GB free Durable Object storage your other apps share.
 */
import { DurableObject } from 'cloudflare:workers';
import { getLinkPreview } from './src/linkmeta.js';

const VERSION = '2.0.0';
const CHUNK = 1024 * 1024;                 // bytes per stored chunk (DO row limit is 2 MB)
const MAX_FILE = 200 * 1024 * 1024;        // 200 MB per file
const GLOBAL_CAP = 3 * 1024 * 1024 * 1024; // 3 GB across all spaces (account free tier: 5 GB)
const KEY_RE = /^[A-Za-z0-9_-]{20,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const KINDS = new Set(['note', 'clip', 'file', 'settings']);
const PAIR_TTL = 10 * 60 * 1000;
const ROUTE = /^\/api\/s\/([A-Za-z0-9_-]{20,64})\/(ws|sync|file\/([A-Za-z0-9_-]{6,64})(?:\/(\d{1,4}|have))?)$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

function globalStub(env) {
  return env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName('__global__'));
}

function manifest(url) {
  const s = url.searchParams.get('s');
  // The space key in start_url lets iOS home-screen installs (which get their own
  // storage, separate from Safari) open already connected.
  const start = s && KEY_RE.test(s) ? `/?s=${s}` : '/';
  return new Response(
    JSON.stringify({
      id: '/',
      name: 'SyncPad',
      short_name: 'SyncPad',
      description: 'Send files, links and notes between all your devices.',
      start_url: start,
      scope: '/',
      display: 'standalone',
      background_color: '#f6f7f9',
      theme_color: '#ffffff',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ],
      share_target: {
        action: '/share-target',
        method: 'POST',
        enctype: 'multipart/form-data',
        params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: ['*/*'] }] }
      }
    }),
    { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' } }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/api/health') return json({ ok: true, version: VERSION });
      if (p === '/app.webmanifest') return manifest(url);
      // Only reached when the service worker isn't active yet (first visit)
      if (p === '/share-target') return Response.redirect(new URL('/?shared=0', url).href, 303);

      if (p === '/api/pair' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!KEY_RE.test(body.space || '')) return json({ error: 'bad space' }, 400);
        return json(await globalStub(env).createCode(body.space));
      }
      if (p === '/api/pair/claim' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const ip = request.headers.get('cf-connecting-ip') || 'local';
        const res = await globalStub(env).claimCode(String(body.code || '').replace(/\D/g, ''), ip);
        return json(res, res.space ? 200 : res.error === 'slow' ? 429 : 404);
      }
      if (p === '/api/link') {
        if (!KEY_RE.test(url.searchParams.get('s') || '')) return json({ error: 'forbidden' }, 403);
        return json(await getLinkPreview(url.searchParams.get('url') || ''));
      }

      const m = p.match(ROUTE);
      if (m) {
        const stub = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName('space:' + m[1]));
        return stub.fetch(request);
      }
      if (p.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: 'server', message: String(err && err.message || err) }, 500);
    }
  }
};

export class SyncRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ready = false;
    this.globalReady = false;
    this.lastClean = 0;
    this.globalTotal = null;
  }

  /* ───────────────────────── space: setup ───────────────────────── */

  init() {
    if (this.ready) return;
    const s = this.sql;
    s.exec(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, rev INTEGER NOT NULL, seq INTEGER NOT NULL,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, device TEXT, deleted INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL)`);
    s.exec('CREATE INDEX IF NOT EXISTS items_seq ON items(seq)');
    s.exec(`CREATE TABLE IF NOT EXISTS chunks (
      file TEXT NOT NULL, idx INTEGER NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, data BLOB,
      PRIMARY KEY (file, idx))`);
    s.exec('CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT, seen INTEGER)');
    this.seq = s.exec('SELECT COALESCE(MAX(seq), 0) AS v FROM items').one().v;
    this.bytes = s.exec('SELECT COALESCE(SUM(size), 0) AS v FROM chunks').one().v;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.ready = true;
  }

  async fetch(request) {
    this.init();
    const url = new URL(request.url);
    const m = url.pathname.match(ROUTE);
    if (!m) return json({ error: 'not found' }, 404);
    const [, , action, fileId, sub] = m;
    const method = request.method;

    if (action === 'ws') return this.openSocket(request, url);
    if (action === 'sync' && method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: 'bad json' }, 400);
      return json(await this.sync(body, null));
    }
    if (fileId) {
      if (sub === 'have' && method === 'GET') return json({ have: this.haveChunks(fileId) });
      if (sub !== undefined && sub !== 'have' && method === 'PUT') return this.putChunk(fileId, Number(sub), request);
      if (sub === undefined && (method === 'GET' || method === 'HEAD')) return this.readFile(fileId, request, url);
    }
    return json({ error: 'not found' }, 404);
  }

  /* ───────────────────────── space: realtime ───────────────────────── */

  openSocket(request, url) {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
    const device = clean(url.searchParams.get('d'), 64) || 'unknown';
    const name = clean(url.searchParams.get('n'), 40) || 'Device';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ device, name });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    this.init();
    let m;
    try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    if (m.t === 'hi') {
      if (m.name) { att.name = clean(m.name, 40); ws.serializeAttachment(att); }
      this.touchDevice(att.device, att.name, true);
      this.broadcastPresence();
    } else if (m.t === 'sync') {
      const res = await this.sync({ ...m, device: att.device, name: att.name }, ws);
      try { ws.send(JSON.stringify({ t: 'sync', rid: m.rid, ...res })); } catch {}
    }
  }

  async webSocketClose(ws, code) {
    this.init();
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch {}
    this.broadcastPresence(ws);
  }

  async webSocketError(ws) {
    this.init();
    this.broadcastPresence(ws);
  }

  touchDevice(id, name, force) {
    if (!id || id === 'unknown') return;
    const now = Date.now();
    const row = this.sql.exec('SELECT name, seen FROM devices WHERE id = ?', id).toArray()[0];
    if (!force && row && row.name === name && now - row.seen < 10 * 60 * 1000) return;
    this.sql.exec(
      'INSERT INTO devices (id, name, seen) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, seen = excluded.seen',
      id, name || (row && row.name) || 'Device', now
    );
  }

  broadcastPresence(exclude) {
    const online = new Set();
    for (const s of this.ctx.getWebSockets()) {
      if (s === exclude) continue;
      const a = s.deserializeAttachment();
      if (a && a.device) online.add(a.device);
    }
    const devices = this.sql
      .exec('SELECT id, name, seen FROM devices ORDER BY seen DESC LIMIT 30')
      .toArray()
      .map((d) => ({ ...d, online: online.has(d.id) }));
    const msg = JSON.stringify({ t: 'presence', online: online.size, devices });
    for (const s of this.ctx.getWebSockets()) {
      if (s === exclude) continue;
      try { s.send(msg); } catch {}
    }
  }

  poke(exclude) {
    const msg = JSON.stringify({ t: 'poke', seq: this.seq });
    for (const s of this.ctx.getWebSockets()) {
      if (s === exclude) continue;
      try { s.send(msg); } catch {}
    }
  }

  /* ───────────────────────── space: sync ───────────────────────── */

  async sync(body, ws) {
    const device = clean(body.device, 64) || 'unknown';
    const since = Math.max(0, Math.floor(Number(body.since) || 0));
    const ops = Array.isArray(body.ops) ? body.ops.slice(0, 100) : [];
    const now = Date.now();
    const acks = [];
    let changed = false;
    const bytesBefore = this.bytes;

    for (const op of ops) {
      let ack;
      try { ack = this.applyOp(op, device, now); } catch { ack = { id: op && op.id, ok: false, err: 'bad' }; }
      acks.push(ack);
      if (ack.ok && !ack.noop) changed = true;
    }
    if (now - this.lastClean > 60 * 60 * 1000) {
      this.lastClean = now;
      if (this.cleanup(now)) changed = true;
    }
    if (!ws) this.touchDevice(device, clean(body.name, 40), false);
    if (this.bytes !== bytesBefore || this.globalTotal === null) await this.reportUsage();

    const rows = this.sql.exec('SELECT * FROM items WHERE seq > ? ORDER BY seq LIMIT 500', since).toArray();
    const more = rows.length === 500;
    if (changed) this.poke(ws);
    return {
      seq: more ? rows[rows.length - 1].seq : this.seq,
      more,
      changes: rows.map(rowOut),
      acks,
      usage: this.bytes,
      total: this.globalTotal,
      cap: GLOBAL_CAP,
      maxFile: MAX_FILE,
      chunk: CHUNK,
      now
    };
  }

  getRow(id) {
    return this.sql.exec('SELECT * FROM items WHERE id = ?', id).toArray()[0];
  }

  applyOp(op, device, now) {
    const id = String((op && op.id) || '');
    const kind = op && op.kind;
    if (!ID_RE.test(id) || !KINDS.has(kind)) return { id, ok: false, err: 'bad' };
    const deleted = !!op.deleted;
    const data = deleted ? {} : sanitize(kind, op.data);
    if (!data) return { id, ok: false, err: 'bad' };
    const dataStr = JSON.stringify(data);
    if (dataStr.length > 1_500_000) return { id, ok: false, err: 'too_big' };

    const ex = this.getRow(id);
    if (ex && ex.kind !== kind) return { id, ok: false, err: 'kind' };
    const baseRev = Math.floor(Number(op.baseRev) || 0);

    if (ex && ex.deleted && deleted) return { id, ok: true, rev: ex.rev, noop: true };

    if (kind === 'file' && !deleted && (!ex || ex.deleted)) {
      const missing = this.missingChunks(id, data.size);
      if (missing) return { id, ok: false, err: 'incomplete', have: this.haveChunks(id) };
    }

    // Two devices edited the same note without seeing each other's change:
    // keep the server copy and save the incoming text as a separate "conflict" note.
    if (ex && !ex.deleted && !deleted && kind === 'note' && baseRev < ex.rev && ex.device !== device) {
      const old = JSON.parse(ex.data);
      if (old.body === data.body) {
        return { id, ok: true, rev: ex.rev, noop: true, item: rowOut(ex) };
      }
      const cid = (id.slice(0, 44) + '-c' + now.toString(36)).slice(0, 64);
      const seq = ++this.seq;
      this.sql.exec(
        'INSERT INTO items (id, kind, rev, seq, created, updated, device, deleted, data) VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?)',
        cid, kind, seq, now, now, device, JSON.stringify({ ...data, pinned: false, conflictOf: id })
      );
      return { id, ok: true, rev: ex.rev, conflict: cid, item: rowOut(ex) };
    }

    const rev = (ex ? ex.rev : 0) + 1;
    const seq = ++this.seq;
    const created = ex ? ex.created : clampTime(op.created, now);
    this.sql.exec(
      `INSERT INTO items (id, kind, rev, seq, created, updated, device, deleted, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET rev = excluded.rev, seq = excluded.seq, updated = excluded.updated,
       device = excluded.device, deleted = excluded.deleted, data = excluded.data`,
      id, kind, rev, seq, created, now, device, deleted ? 1 : 0, dataStr
    );
    if (deleted && kind === 'file') this.freeChunks(id);
    if (deleted && kind === 'note') {
      // Files attached inside a deleted note go with it
      const kids = this.sql
        .exec(`SELECT id FROM items WHERE kind = 'file' AND deleted = 0 AND json_extract(data, '$.parent') = ?`, id)
        .toArray();
      for (const k of kids) this.tombstone(k.id, now);
    }
    return { id, ok: true, rev };
  }

  tombstone(id, now) {
    const seq = ++this.seq;
    this.sql.exec(
      `UPDATE items SET deleted = 1, data = '{}', rev = rev + 1, seq = ?, updated = ?, device = 'server' WHERE id = ?`,
      seq, now, id
    );
    this.freeChunks(id);
  }

  cleanup(now) {
    let changed = false;
    // Chunks from uploads that were never finished
    const orphans = this.sql
      .exec(
        `SELECT DISTINCT file FROM chunks WHERE created < ?
         AND file NOT IN (SELECT id FROM items WHERE kind = 'file' AND deleted = 0)`,
        now - 24 * 60 * 60 * 1000
      )
      .toArray();
    for (const o of orphans) this.freeChunks(o.file);

    // Optional auto-delete of old drops (files + clips that aren't kept/pinned)
    const st = this.getRow('settings');
    const days = st && !st.deleted ? Number(JSON.parse(st.data).autodel) || 0 : 0;
    if (days > 0) {
      const old = this.sql
        .exec(`SELECT id, kind, data FROM items WHERE deleted = 0 AND kind IN ('file', 'clip') AND created < ?`, now - days * 86400000)
        .toArray();
      for (const r of old) {
        const d = JSON.parse(r.data);
        if (d.keep || (r.kind === 'file' && d.parent)) continue;
        this.tombstone(r.id, now);
        changed = true;
      }
    }
    return changed;
  }

  /* ───────────────────────── space: files ───────────────────────── */

  haveChunks(id) {
    return this.sql.exec('SELECT idx FROM chunks WHERE file = ? ORDER BY idx', id).toArray().map((r) => r.idx);
  }

  missingChunks(id, size) {
    const need = Math.ceil(size / CHUNK);
    const r = this.sql
      .exec(
        `SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s, COALESCE(MAX(idx), -1) AS mx,
         COALESCE(SUM(CASE WHEN idx < ? AND size != ? THEN 1 ELSE 0 END), 0) AS bad FROM chunks WHERE file = ?`,
        need - 1, CHUNK, id
      )
      .one();
    return !(r.c === need && r.s === size && r.mx === need - 1 && r.bad === 0);
  }

  freeChunks(id) {
    const r = this.sql.exec('SELECT COALESCE(SUM(size), 0) AS s FROM chunks WHERE file = ?', id).one();
    if (r.s > 0 || this.sql.exec('SELECT 1 FROM chunks WHERE file = ? LIMIT 1', id).toArray().length) {
      this.sql.exec('DELETE FROM chunks WHERE file = ?', id);
      this.bytes -= r.s;
    }
  }

  async reportUsage() {
    try {
      const res = await globalStub(this.env).report(this.ctx.id.toString(), this.bytes);
      this.globalTotal = res.total;
    } catch {}
  }

  async putChunk(id, idx, request) {
    if (!(idx >= 0 && idx < Math.ceil(MAX_FILE / CHUNK))) return json({ error: 'range' }, 400);
    const ex = this.getRow(id);
    if (ex && (ex.kind !== 'file' || ex.deleted)) return json({ error: 'gone' }, 410);
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > CHUNK) return json({ error: 'size' }, 400);

    const prev = this.sql.exec('SELECT size FROM chunks WHERE file = ? AND idx = ?', id, idx).toArray()[0];
    const delta = buf.byteLength - (prev ? prev.size : 0);
    if (delta > 0) {
      let res;
      try { res = await globalStub(this.env).reserve(this.ctx.id.toString(), this.bytes, delta); } catch { res = { ok: true }; }
      if (res.total != null) this.globalTotal = res.total;
      if (!res.ok) return json({ error: 'full', total: res.total, cap: GLOBAL_CAP }, 507);
    }
    this.sql.exec(
      'INSERT OR REPLACE INTO chunks (file, idx, size, created, data) VALUES (?, ?, ?, ?, ?)',
      id, idx, buf.byteLength, Date.now(), buf
    );
    this.bytes += delta;
    return json({ ok: true });
  }

  readFile(id, request, url) {
    const row = this.getRow(id);
    if (!row || row.deleted || row.kind !== 'file') return new Response('Not found', { status: 404 });
    const d = JSON.parse(row.data);
    const size = d.size;
    let start = 0;
    let end = size - 1;
    let status = 200;
    const headers = new Headers({
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    });
    const range = request.headers.get('range');
    if (range && size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') start = Math.max(0, size - Number(m[2]));
        else {
          start = Number(m[1]);
          if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
        }
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        }
        status = 206;
        headers.set('content-range', `bytes ${start}-${end}/${size}`);
      }
    }
    const { type, disposition } = serveType(d.type, url.searchParams.has('dl'));
    headers.set('content-type', type);
    headers.set('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(d.name || 'file')}`);
    if (!type.startsWith('application/pdf')) {
      // Uploaded HTML/SVG can never run scripts on the app's origin
      headers.set('content-security-policy', "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    }
    const length = size === 0 ? 0 : end - start + 1;
    headers.set('content-length', String(length));
    if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers });

    const sql = this.sql;
    let pos = start;
    const source = new ReadableStream({
      pull(controller) {
        if (pos > end) { controller.close(); return; }
        const idx = Math.floor(pos / CHUNK);
        const r = sql.exec('SELECT data FROM chunks WHERE file = ? AND idx = ?', id, idx).toArray()[0];
        if (!r) { controller.error(new Error('missing chunk')); return; }
        const off = pos - idx * CHUNK;
        const len = Math.min(r.data.byteLength - off, end - pos + 1);
        controller.enqueue(new Uint8Array(r.data, off, len));
        pos += len;
      }
    });
    const { readable, writable } = new FixedLengthStream(length);
    source.pipeTo(writable).catch(() => {});
    return new Response(readable, { status, headers });
  }

  /* ───────────────────────── global: pairing + storage cap ───────────────────────── */

  initGlobal() {
    if (this.globalReady) return;
    const s = this.sql;
    s.exec('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, space TEXT NOT NULL, expires INTEGER NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS tries (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS spaces (sid TEXT PRIMARY KEY, bytes INTEGER NOT NULL)');
    this.total = s.exec('SELECT COALESCE(SUM(bytes), 0) AS v FROM spaces').one().v;
    this.globalReady = true;
  }

  async createCode(space) {
    this.initGlobal();
    const now = Date.now();
    this.sql.exec('DELETE FROM codes WHERE expires < ?', now);
    const ex = this.sql.exec('SELECT code, expires FROM codes WHERE space = ? ORDER BY expires DESC LIMIT 1', space).toArray()[0];
    if (ex && ex.expires - now > 3 * 60 * 1000) return { code: ex.code, expires: ex.expires };
    let code = '';
    for (let i = 0; i < 25; i++) {
      code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      if (!this.sql.exec('SELECT 1 FROM codes WHERE code = ?', code).toArray().length) break;
    }
    const expires = now + PAIR_TTL;
    this.sql.exec('INSERT OR REPLACE INTO codes (code, space, expires) VALUES (?, ?, ?)', code, space, expires);
    return { code, expires };
  }

  async claimCode(code, ip) {
    this.initGlobal();
    const now = Date.now();
    const t = this.sql.exec('SELECT n, reset FROM tries WHERE ip = ?', ip).toArray()[0];
    if (t && t.reset > now && t.n >= 12) return { error: 'slow', retry: t.reset - now };
    const row = /^\d{6}$/.test(code)
      ? this.sql.exec('SELECT space, expires FROM codes WHERE code = ?', code).toArray()[0]
      : null;
    if (!row || row.expires < now) {
      if (!t || t.reset <= now) this.sql.exec('INSERT OR REPLACE INTO tries (ip, n, reset) VALUES (?, 1, ?)', ip, now + 10 * 60 * 1000);
      else this.sql.exec('UPDATE tries SET n = n + 1 WHERE ip = ?', ip);
      return { error: 'invalid' };
    }
    return { space: row.space };
  }

  setSpaceBytes(sid, bytes) {
    const row = this.sql.exec('SELECT bytes FROM spaces WHERE sid = ?', sid).toArray()[0];
    const old = row ? row.bytes : 0;
    if (row && old === bytes) return;
    this.sql.exec('INSERT INTO spaces (sid, bytes) VALUES (?, ?) ON CONFLICT(sid) DO UPDATE SET bytes = excluded.bytes', sid, bytes);
    this.total += bytes - old;
  }

  async reserve(sid, current, incoming) {
    this.initGlobal();
    const row = this.sql.exec('SELECT bytes FROM spaces WHERE sid = ?', sid).toArray()[0];
    const projected = this.total - (row ? row.bytes : 0) + current + incoming;
    if (projected > GLOBAL_CAP) {
      this.setSpaceBytes(sid, current);
      return { ok: false, total: this.total };
    }
    this.setSpaceBytes(sid, current + incoming);
    return { ok: true, total: this.total };
  }

  async report(sid, current) {
    this.initGlobal();
    this.setSpaceBytes(sid, current);
    return { total: this.total };
  }
}

/* ───────────────────────── helpers ───────────────────────── */

function rowOut(r) {
  return {
    id: r.id,
    kind: r.kind,
    rev: r.rev,
    seq: r.seq,
    created: r.created,
    updated: r.updated,
    device: r.device,
    deleted: !!r.deleted,
    data: JSON.parse(r.data)
  };
}

function clampTime(t, now) {
  const n = Number(t);
  return Number.isFinite(n) && n > 1420070400000 && n < now + 86400000 ? Math.floor(n) : now;
}

function sanitize(kind, d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (kind === 'file') {
    const size = Math.floor(Number(d.size));
    if (!(size >= 0 && size <= MAX_FILE)) return null;
    const out = {
      name: clean(d.name, 255) || 'file',
      size,
      type: /^[\w.+-]+\/[\w.+-]+$/.test(d.type || '') ? String(d.type).slice(0, 100) : '',
      parent: d.parent && ID_RE.test(d.parent) ? d.parent : null,
      keep: !!d.keep
    };
    if (typeof d.thumb === 'string' && d.thumb.startsWith('data:image/') && d.thumb.length < 200000) out.thumb = d.thumb;
    if (Number.isFinite(d.w) && Number.isFinite(d.h)) { out.w = Math.floor(d.w); out.h = Math.floor(d.h); }
    return out;
  }
  return d;
}

function serveType(type, download) {
  const t = String(type || '').toLowerCase();
  const valid = /^[\w.+-]+\/[\w.+-]+$/.test(t);
  const inlineOk = /^(image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)$/.test(t);
  if (download || !inlineOk) return { type: download && valid ? t : 'application/octet-stream', disposition: 'attachment' };
  return { type: t === 'text/plain' ? 'text/plain; charset=utf-8' : t, disposition: 'inline' };
}
