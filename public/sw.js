/* SyncPad v2 service worker: offline app shell, cached file previews, Android share target */
const VERSION = 'v2.10.0';
const SHELL_CACHE = 'sp-shell-' + VERSION;
const FILE_CACHE = 'sp-files';
const SHELL = [
  '/',
  '/css/app.css',
  '/js/theme.js',
  '/js/main.js',
  '/js/util.js',
  '/js/store.js',
  '/js/sync.js',
  '/js/files.js',
  '/js/markup.js',
  '/js/collage.js',
  '/js/zoom.js',
  '/js/pdfedit.js',
  '/js/pdfcore.js',
  '/js/md.js',
  '/vendor/marked.esm.js',
  '/vendor/purify.min.js',
  '/vendor/qrcode.mjs',
  '/icons/favicon.svg',
  '/icons/icon-192.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== FILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Android "Share to SyncPad"
  if (req.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  // Uploaded files: kept-offline copies and small cached previews work without internet
  if (/^\/api\/s\/[^/]+\/file\/[^/]+$/.test(url.pathname)) {
    event.respondWith(fileFirst(req, url));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/app.webmanifest') return;

  // App shell: network first (always fresh when online), cache when offline
  event.respondWith(networkFirst(req, url));
});

async function networkFirst(req, url) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetchWithTimeout(req, 4000);
    if (res.ok && res.type === 'basic') cache.put(url.pathname === '/index.html' ? '/' : req, res.clone());
    return res;
  } catch {
    const hit = (await cache.match(req, { ignoreSearch: req.mode === 'navigate' })) || (req.mode === 'navigate' ? await cache.match('/') : null);
    return hit || new Response('Offline', { status: 503 });
  }
}

async function fileFirst(req, url) {
  const key = url.origin + url.pathname; // the token in the query is not part of the cache key
  let hit = await (await caches.open('sp-offline')).match(key);
  if (!hit) hit = await (await caches.open(FILE_CACHE)).match(key);
  const download = url.searchParams.has('dl');
  const range = req.headers.get('range');
  if (hit) {
    if (range) return rangeFrom(hit, range);
    if (download) {
      const h = new Headers(hit.headers);
      const name = (/filename\*=UTF-8''([^;]+)/.exec(h.get('content-disposition') || '') || [])[1] || 'file';
      h.set('content-disposition', `attachment; filename*=UTF-8''${name}`);
      return new Response(hit.body, { status: 200, headers: h });
    }
    return hit;
  }
  const res = await fetch(req);
  const len = Number(res.headers.get('content-length') || 0);
  if (!download && !range && res.status === 200 && len > 0 && len < 15 * 1024 * 1024) {
    (await caches.open(FILE_CACHE)).put(key, res.clone()).catch(() => {});
  }
  return res;
}

/** Video/audio players ask for byte ranges; answer them from a cached copy */
async function rangeFrom(res, range) {
  const blob = await res.blob();
  const size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = 0;
  let end = size - 1;
  if (m) {
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
  }
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  const h = new Headers(res.headers);
  h.set('content-range', `bytes ${start}-${end}/${size}`);
  h.set('content-length', String(end - start + 1));
  return new Response(blob.slice(start, end + 1), { status: 206, headers: h });
}

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size >= 0 && f.name !== undefined);
    const parts = [];
    for (const k of ['title', 'text', 'url']) {
      const v = (form.get(k) || '').toString().trim();
      if (v && !parts.some((p) => p.includes(v))) parts.push(v);
    }
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('syncpad-share', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('inbox', { autoIncrement: true });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const t = db.transaction('inbox', 'readwrite');
      t.objectStore('inbox').add({ files, text: parts.join('\n'), ts: Date.now() });
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
    db.close();
  } catch {}
  return Response.redirect('/?shared=1', 303);
}

/* ───── notifications: the push carries no content; we ask the server what arrived ───── */

function readKV(keys) {
  return new Promise((resolve) => {
    let r;
    try { r = indexedDB.open('syncpad2'); } catch { return resolve({}); }
    r.onupgradeneeded = () => { try { r.transaction.abort(); } catch {} };
    r.onerror = () => resolve({});
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) { db.close(); return resolve({}); }
      const st = db.transaction('kv').objectStore('kv');
      const out = {};
      let n = keys.length;
      for (const k of keys) {
        const q = st.get(k);
        q.onsuccess = q.onerror = () => {
          if (q.result) out[k] = q.result.v;
          if (--n === 0) { db.close(); resolve(out); }
        };
      }
    };
  });
}

self.addEventListener('push', (event) => event.waitUntil(onPush()));

async function onPush() {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (wins.some((w) => w.visibilityState === 'visible')) return; // the open app already shows it
  let title = 'SyncPad';
  let body = 'Something new arrived from another device';
  try {
    const kv = await readKV(['space', 'token', 'device', 'seq', 'pinOn']);
    if (kv.space && !kv.pinOn) {
      const r = await fetch(`/api/s/${kv.space}/latest?k=${encodeURIComponent(kv.token || kv.space)}&d=${kv.device || ''}&since=${kv.seq || 0}`);
      const j = await r.json();
      if (j.count) {
        const first = j.items[0];
        title = j.count > 1 ? `${j.count} new drops from ${first.from}` : `From ${first.from}`;
        body = j.items.map((i) => (i.kind === 'file' ? `📎 ${i.text}` : i.text)).join('\n');
      }
    } else if (kv.pinOn) {
      body = 'New drop — open SyncPad to see it';
    }
  } catch {}
  try { if (self.navigator.setAppBadge) self.navigator.setAppBadge(); } catch {}
  await self.registration.showNotification(title, {
    body,
    tag: 'syncpad-drops',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: '/' }
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) return w.focus(); }
    return self.clients.openWindow('/');
  })());
});
