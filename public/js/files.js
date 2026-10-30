// File uploads (chunked, resumable, offline-queued), thumbnails, downloads and sharing.
import { rid, fileKind, fmtBytes, sleep, isTouch } from './util.js';

const CHUNK = 1024 * 1024;
const PARALLEL = 3;

export class Files extends EventTarget {
  constructor(store, sync) {
    super();
    this.store = store;
    this.sync = sync;
    this.progress = new Map(); // id -> {sent, total, state: 'up'|'wait'|'err', err}
    this.mem = new Map();      // id -> Blob kept in memory for this session (instant previews)
    this.urls = new Map();     // id -> object URL
    this.queue = [];
    this.busy = false;
    this.published = new Set();
    this.prefetched = new Map();

    sync.addEventListener('incomplete', (e) => this.requeue(e.detail.id, e.detail.have));
    sync.addEventListener('synced', () => this.dropSentBlobs());
    store.addEventListener('deleted', (e) => e.detail.forEach((id) => this.forget(id)));
  }

  get space() { return this.store.get('space'); }
  get maxFile() { return (this.sync.info && this.sync.info.maxFile) || 200 * 1024 * 1024; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  url(id, download = false) { return `/api/s/${this.space}/file/${id}${download ? '?dl=1' : ''}`; }

  /** Best URL to show a file: local copy if we have one, else the cloud copy */
  src(id) {
    if (this.urls.has(id)) return this.urls.get(id);
    const b = this.mem.get(id);
    if (b) {
      const u = URL.createObjectURL(b);
      this.urls.set(id, u);
      return u;
    }
    return this.url(id);
  }

  async add(fileList, { parent = null } = {}) {
    const created = [];
    for (const file of fileList) {
      if (file.size > this.maxFile) {
        this.emit('error', { message: `“${file.name}” is ${fmtBytes(file.size)} — the limit is ${fmtBytes(this.maxFile)} per file.` });
        continue;
      }
      const id = rid(16);
      const now = Date.now();
      const name = !file.name || /^image\.\w{2,5}$/i.test(file.name) ? defaultName(file) : file.name;
      const data = { name, size: file.size, type: file.type || '', parent };
      try { Object.assign(data, (await withTimeout(makeThumb(file), 3000)) || {}); } catch {}
      const item = { id, kind: 'file', rev: 0, created: now, updated: now, device: this.store.get('device'), data, local: { up: true } };
      this.mem.set(id, file);
      await this.store.save(item, { sync: false });
      this.store.putBlob(id, file).catch(() => {});
      this.progress.set(id, { sent: 0, total: file.size, state: 'up' });
      this.queue.push({ id, have: [] });
      created.push(item);
    }
    this.pump();
    return created;
  }

  /** Resume uploads that were interrupted (app closed, offline, moved to another space) */
  resumeAll() {
    for (const it of this.store.list('file')) {
      if (it.local && it.local.up && !this.queue.some((j) => j.id === it.id)) {
        this.progress.set(it.id, { sent: 0, total: it.data.size, state: 'wait' });
        this.queue.push({ id: it.id });
      }
    }
    this.pump();
  }

  requeue(id, have) {
    const it = this.store.items.get(id);
    if (!it) return;
    it.local = { ...(it.local || {}), up: true };
    this.store.save(it, { sync: false });
    this.queue.push({ id, have: have || [] });
    this.pump();
  }

  setProg(id, p) {
    this.progress.set(id, { ...(this.progress.get(id) || {}), ...p });
    this.emit('progress', { id });
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const job = this.queue[0];
        let res;
        try { res = await this.uploadOne(job); } catch { res = 'retry'; }
        if (res === 'retry') {
          await waitForNetwork(8000);
          continue;
        }
        this.queue.shift();
      }
    } finally {
      this.busy = false;
    }
  }

  async uploadOne(job) {
    const id = job.id;
    const item = this.store.items.get(id);
    if (!item || !item.local || !item.local.up) { this.progress.delete(id); return 'done'; }
    if (!navigator.onLine) { this.setProg(id, { state: 'wait' }); return 'retry'; }

    let blob = this.mem.get(id) || (await this.store.getBlob(id).catch(() => null));
    if (!blob && item.local.from) {
      const r = await fetch(`/api/s/${item.local.from}/file/${id}`).catch(() => null);
      if (r && r.ok) blob = await r.blob();
      else if (r && r.status === 404) { await this.store.remove(item); return 'done'; }
      else return 'retry';
    }
    if (!blob) {
      this.setProg(id, { state: 'err', err: 'Not on this device any more — add it again' });
      return 'done';
    }
    this.mem.set(id, blob);

    let have = job.have;
    if (!have) {
      have = await fetch(`/api/s/${this.space}/file/${id}/have`).then((r) => r.json()).then((j) => j.have || []).catch(() => null);
      if (!have) return 'retry';
    }
    const total = blob.size;
    const n = Math.ceil(total / CHUNK);
    const doneSet = new Set(have);
    let sent = 0;
    const todo = [];
    for (let i = 0; i < n; i++) {
      if (doneSet.has(i)) sent += Math.min(CHUNK, total - i * CHUNK);
      else todo.push(i);
    }
    this.setProg(id, { sent, total, state: 'up', err: null });
    let failed = null;
    const space = this.space;

    const worker = async () => {
      while (todo.length && !failed) {
        const i = todo.shift();
        if (!this.store.items.has(id)) { failed = 'gone'; return; }
        const part = blob.slice(i * CHUNK, Math.min(total, (i + 1) * CHUNK));
        for (let attempt = 1; ; attempt++) {
          try {
            const r = await fetch(`/api/s/${space}/file/${id}/${i}`, { method: 'PUT', body: part });
            if (r.status === 507) { failed = 'full'; return; }
            if (r.status === 410) { failed = 'gone'; return; }
            if (!r.ok) throw new Error('http ' + r.status);
            sent += part.size;
            this.setProg(id, { sent, total, state: 'up' });
            break;
          } catch {
            if (attempt >= 4 || !navigator.onLine) { failed = 'net'; todo.unshift(i); return; }
            await sleep(700 * attempt);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));

    if (failed === 'gone') { this.progress.delete(id); return 'done'; }
    if (failed === 'full') {
      this.setProg(id, { state: 'err', err: 'Cloud storage is full' });
      this.emit('full');
      return 'done';
    }
    if (failed === 'net') {
      this.setProg(id, { state: 'wait' });
      job.have = null;
      return 'retry';
    }

    const cur = this.store.items.get(id);
    if (!cur) return 'done';
    delete cur.local;
    await this.store.save(cur); // queues the file entry, which makes it appear everywhere
    this.progress.delete(id);
    this.emit('progress', { id });
    this.published.add(id);
    this.sync.schedule();
    return 'done';
  }

  async dropSentBlobs() {
    for (const id of [...this.published]) {
      const it = this.store.items.get(id);
      if (!it || it.rev > 0) {
        this.published.delete(id);
        this.store.delBlob(id).catch(() => {});
      }
    }
  }

  forget(id) {
    const u = this.urls.get(id);
    if (u) URL.revokeObjectURL(u);
    this.urls.delete(id);
    this.mem.delete(id);
    this.progress.delete(id);
    if ('caches' in window) caches.open('sp-files').then((c) => c.delete(this.url(id))).catch(() => {});
  }

  /* ───── getting files out ───── */

  download(item) {
    const a = document.createElement('a');
    a.href = this.mem.has(item.id) ? this.src(item.id) : this.url(item.id, true);
    a.download = item.data.name || 'file';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  canShare() {
    try {
      return isTouch() && !!navigator.canShare && navigator.canShare({ files: [new File([''], 'x.txt', { type: 'text/plain' })] });
    } catch { return false; }
  }

  /** Start fetching a file early so the share sheet can open instantly on tap */
  prefetch(item) {
    if (this.mem.has(item.id) || this.prefetched.has(item.id) || item.data.size > 60 * 1024 * 1024) return;
    const p = fetch(this.url(item.id)).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
    this.prefetched.set(item.id, p);
  }

  async blobOf(item) {
    if (this.mem.has(item.id)) return this.mem.get(item.id);
    const p = this.prefetched.get(item.id) || fetch(this.url(item.id)).then((r) => (r.ok ? r.blob() : null));
    const b = await p;
    if (b) this.mem.set(item.id, b);
    return b;
  }

  async share(item) {
    const blob = await this.blobOf(item);
    if (!blob) throw new Error('unavailable');
    const file = new File([blob], item.data.name || 'file', { type: item.data.type || blob.type || 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      this.download(item);
    }
  }

  async copyImage(item) {
    const png = (async () => {
      const blob = await this.blobOf(item);
      if (blob.type === 'image/png') return blob;
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      return new Promise((res) => c.toBlob(res, 'image/png'));
    })();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  }
}

function defaultName(file) {
  const ext = (file.type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${file.type.startsWith('image/') ? 'Screenshot' : 'File'} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${ext}`;
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
}

function waitForNetwork(ms) {
  return new Promise((res) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); removeEventListener('online', done); res(); }
    addEventListener('online', done);
  });
}

async function makeThumb(file) {
  const kind = fileKind(file.type, file.name);
  if (kind === 'image' && file.size < 60 * 1024 * 1024) {
    const bmp = await createImageBitmap(file);
    const out = drawThumb(bmp, bmp.width, bmp.height);
    bmp.close && bmp.close();
    return out;
  }
  if (kind === 'video') {
    const url = URL.createObjectURL(file);
    try {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
      v.currentTime = Math.min(1, (v.duration || 2) / 3);
      await new Promise((res) => { v.onseeked = res; setTimeout(res, 1500); });
      return drawThumb(v, v.videoWidth, v.videoHeight);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return null;
}

function drawThumb(src, w, h) {
  if (!w || !h) return null;
  const scale = Math.min(1, 440 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0, c.width, c.height);
  let thumb = c.toDataURL('image/webp', 0.72);
  if (!thumb.startsWith('data:image/webp') || thumb.length > 150000) {
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    thumb = c.toDataURL('image/jpeg', 0.7);
  }
  return { thumb, w, h };
}
