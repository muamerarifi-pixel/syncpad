// Local-first storage: everything is written to IndexedDB first, then synced.
const DB_NAME = 'syncpad2';

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export class Store extends EventTarget {
  constructor() {
    super();
    this.items = new Map();   // id -> item {id, kind, rev, created, updated, device, data, local?}
    this.outbox = new Map();  // id -> {id, lv, baseRev, op}
    this.kv = new Map();
    this.lv = 0;
  }

  async open() {
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const [name, key] of [['items', 'id'], ['outbox', 'id'], ['blobs', 'id'], ['kv', 'k']]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: key });
        }
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const [items, kv, outbox] = await Promise.all([this.all('items'), this.all('kv'), this.all('outbox')]);
    for (const i of items) this.items.set(i.id, i);
    for (const e of kv) this.kv.set(e.k, e.v);
    for (const o of outbox) { this.outbox.set(o.id, o); this.lv = Math.max(this.lv, o.lv); }
  }

  all(store) { return req(this.db.transaction(store).objectStore(store).getAll()); }
  get(k, dflt) { return this.kv.has(k) ? this.kv.get(k) : dflt; }
  async set(k, v) {
    this.kv.set(k, v);
    await req(this.db.transaction('kv', 'readwrite').objectStore('kv').put({ k, v }));
  }

  emit(ids, remote = false) {
    if (ids.length) this.dispatchEvent(new CustomEvent('change', { detail: { ids, remote } }));
  }

  list(kind) {
    const out = [];
    for (const i of this.items.values()) if (!kind || i.kind === kind) out.push(i);
    return out;
  }

  /** Save a local change and queue it for sync */
  async save(item, { sync = true } = {}) {
    item.updated = Date.now();
    this.items.set(item.id, item);
    const t = this.db.transaction(['items', 'outbox'], 'readwrite');
    t.objectStore('items').put(item);
    if (sync) {
      const e = {
        id: item.id, lv: ++this.lv, baseRev: item.rev || 0,
        op: { id: item.id, kind: item.kind, deleted: false, data: item.data, created: item.created }
      };
      this.outbox.set(item.id, e);
      t.objectStore('outbox').put(e);
    }
    await done(t);
    this.emit([item.id]);
  }

  /** Delete locally and queue a delete for all devices */
  async remove(item) {
    this.items.delete(item.id);
    const t = this.db.transaction(['items', 'outbox', 'blobs'], 'readwrite');
    t.objectStore('items').delete(item.id);
    t.objectStore('blobs').delete(item.id);
    const e = { id: item.id, lv: ++this.lv, baseRev: item.rev || 0, op: { id: item.id, kind: item.kind, deleted: true } };
    this.outbox.set(item.id, e);
    t.objectStore('outbox').put(e);
    await done(t);
    this.emit([item.id]);
  }

  pendingOps(limit = 50) {
    return [...this.outbox.values()].slice(0, limit);
  }

  /** Process server acknowledgements for the ops we sent. Returns events for the UI. */
  async handleAcks(sent, acks, myDevice) {
    const events = [];
    const ids = [];
    if (!acks || !acks.length) return events;
    const t = this.db.transaction(['items', 'outbox'], 'readwrite');
    const ib = t.objectStore('items');
    const ob = t.objectStore('outbox');
    const dropEntry = (e) => {
      const cur = this.outbox.get(e.id);
      if (cur && cur.lv === e.lv) { this.outbox.delete(e.id); ob.delete(e.id); return null; }
      return cur || null;
    };
    acks.forEach((a, i) => {
      const e = sent[i];
      if (!e || !a || a.id !== e.id) return;
      if (a.ok && a.conflict) {
        // Server kept the other device's version; our text lives on as a copy.
        const pending = dropEntry(e);
        const now = Date.now();
        const data = { ...((pending && pending.op.data) || e.op.data), pinned: false, conflictOf: e.id };
        const copy = { id: a.conflict, kind: 'note', rev: 1, created: now, updated: now, device: myDevice, data };
        this.items.set(copy.id, copy);
        ib.put(copy);
        if (pending) {
          this.outbox.delete(e.id);
          ob.delete(e.id);
          const ce = { id: copy.id, lv: ++this.lv, baseRev: 1, op: { id: copy.id, kind: 'note', deleted: false, data, created: now } };
          this.outbox.set(copy.id, ce);
          ob.put(ce);
        }
        const srv = fromServer(a.item);
        this.items.set(srv.id, srv);
        ib.put(srv);
        ids.push(srv.id, copy.id);
        events.push({ type: 'conflict', from: e.id, to: copy.id });
      } else if (a.ok) {
        if (a.item && !this.outbox.has(e.id)) {
          const srv = fromServer(a.item);
          this.items.set(srv.id, srv);
          ib.put(srv);
          ids.push(srv.id);
        }
        const it = this.items.get(e.id);
        if (it) { it.rev = a.rev; ib.put(it); }
        const cur = dropEntry(e);
        if (cur) { cur.baseRev = a.rev; ob.put(cur); }
      } else {
        dropEntry(e);
        events.push({ type: a.err === 'incomplete' ? 'incomplete' : 'rejected', id: e.id, err: a.err, have: a.have || [] });
      }
    });
    await done(t);
    this.emit(ids, true);
    return events;
  }

  /** Apply changes from the server. Local pending edits win until they are pushed. */
  async applyRemote(changes) {
    if (!changes || !changes.length) return [];
    const ids = [];
    const deleted = [];
    const t = this.db.transaction(['items', 'blobs'], 'readwrite');
    const ib = t.objectStore('items');
    for (const c of changes) {
      if (this.outbox.has(c.id)) continue;
      if (c.deleted) {
        if (this.items.has(c.id)) {
          this.items.delete(c.id);
          ib.delete(c.id);
          t.objectStore('blobs').delete(c.id);
          ids.push(c.id);
          deleted.push(c.id);
        }
        continue;
      }
      const cur = this.items.get(c.id);
      if (cur && cur.rev >= c.rev && !cur.local) continue;
      const it = fromServer(c);
      this.items.set(it.id, it);
      ib.put(it);
      ids.push(it.id);
    }
    await done(t);
    this.emit(ids, true);
    if (deleted.length) this.dispatchEvent(new CustomEvent('deleted', { detail: deleted }));
    return ids;
  }

  /* ───── file blobs waiting to be uploaded ───── */
  putBlob(id, blob) { return req(this.db.transaction('blobs', 'readwrite').objectStore('blobs').put({ id, blob })); }
  async getBlob(id) {
    const r = await req(this.db.transaction('blobs').objectStore('blobs').get(id));
    return r ? r.blob : null;
  }
  delBlob(id) { return req(this.db.transaction('blobs', 'readwrite').objectStore('blobs').delete(id)); }

  /** Switch to another space: everything local gets re-sent there. */
  async moveToSpace(key) {
    const t = this.db.transaction(['items', 'outbox', 'kv'], 'readwrite');
    const ib = t.objectStore('items');
    const ob = t.objectStore('outbox');
    ob.clear();
    this.outbox.clear();
    for (const it of [...this.items.values()]) {
      if (it.kind === 'settings') { this.items.delete(it.id); ib.delete(it.id); continue; }
      it.rev = 0;
      ib.put(it);
      if (it.kind === 'file') continue; // files re-upload themselves (see files.js)
      const e = { id: it.id, lv: ++this.lv, baseRev: 0, op: { id: it.id, kind: it.kind, deleted: false, data: it.data, created: it.created } };
      this.outbox.set(it.id, e);
      ob.put(e);
    }
    this.kv.set('space', key);
    this.kv.set('seq', 0);
    t.objectStore('kv').put({ k: 'space', v: key });
    t.objectStore('kv').put({ k: 'seq', v: 0 });
    await done(t);
    this.emit([...this.items.keys()]);
  }

  async wipe() {
    this.db.close();
    await req(indexedDB.deleteDatabase(DB_NAME)).catch(() => {});
  }
}

function fromServer(c) {
  return { id: c.id, kind: c.kind, rev: c.rev, created: c.created, updated: c.updated, device: c.device, data: c.data || {} };
}

/** Read notes saved by SyncPad v1 (database "syncpad_db") without creating it. */
export function readV1Notes() {
  return new Promise((resolve) => {
    let fresh = false;
    let r;
    try { r = indexedDB.open('syncpad_db'); } catch { return resolve([]); }
    r.onupgradeneeded = (e) => {
      if (e.oldVersion === 0) { fresh = true; r.transaction.abort(); }
    };
    r.onerror = () => {
      if (fresh) try { indexedDB.deleteDatabase('syncpad_db'); } catch {}
      resolve([]);
    };
    r.onblocked = () => resolve([]);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('notes')) { db.close(); return resolve([]); }
      const q = db.transaction('notes').objectStore('notes').getAll();
      q.onsuccess = () => { db.close(); resolve((q.result || []).filter((n) => n && !n.isDeleted)); };
      q.onerror = () => { db.close(); resolve([]); };
    };
  });
}
