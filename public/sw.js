/* SyncPad v2 service worker: offline app shell, cached file previews, Android share target */
const VERSION = 'v2.0.0';
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

  // Uploaded files: cache small ones so previews work offline
  if (/^\/api\/s\/[^/]+\/file\/[^/]+$/.test(url.pathname) && !url.search && !req.headers.has('range')) {
    event.respondWith(fileFirst(req));
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

async function fileFirst(req) {
  const cache = await caches.open(FILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  const len = Number(res.headers.get('content-length') || 0);
  if (res.status === 200 && len > 0 && len < 15 * 1024 * 1024) cache.put(req, res.clone()).catch(() => {});
  return res;
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
