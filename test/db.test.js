import test from 'node:test';
import assert from 'node:assert';

// Mock minimal IndexedDB for Node.js unit testing of db.js helpers
class MockIDBRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
}

class MockObjectStore {
  constructor() {
    this.data = new Map();
  }
  get(key) {
    if (key === undefined) {
      throw new Error("Failed to execute 'get' on 'IDBObjectStore': No key or key range specified.");
    }
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      req.result = this.data.get(key);
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  getAll() {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      req.result = Array.from(this.data.values());
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  put(value) {
    const req = new MockIDBRequest();
    const key = value.key || value.id;
    this.data.set(key, value);
    queueMicrotask(() => {
      req.result = key;
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  add(value) {
    return this.put(value);
  }
  delete(key) {
    const req = new MockIDBRequest();
    this.data.delete(key);
    queueMicrotask(() => {
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  createIndex() {}
}

const stores = {
  notes: new MockObjectStore(),
  settings: new MockObjectStore(),
  sync_queue: new MockObjectStore()
};

globalThis.indexedDB = {
  open: () => {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        transaction: (storeName) => ({
          objectStore: () => stores[storeName],
          oncomplete: null,
          onerror: null,
          onabort: null
        })
      };
      // Trigger oncomplete after microtask
      const origTx = req.result.transaction;
      req.result.transaction = (storeName, mode) => {
        const tx = origTx(storeName);
        queueMicrotask(() => {
          if (tx.oncomplete) tx.oncomplete();
        });
        return tx;
      };
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
};

const {
  getNote,
  saveNote,
  deleteNote,
  getSetting,
  setSetting,
  searchNotes
} = await import('../public/js/db.js');

test('getNote handles undefined and null gracefully without throwing', async () => {
  const r1 = await getNote(undefined);
  assert.strictEqual(r1, null);

  const r2 = await getNote(null);
  assert.strictEqual(r2, null);
});

test('saveNote handles note with undefined id and generates valid id', async () => {
  const note = {
    title: 'Brand New Note',
    content: 'Some markdown content',
    tags: ['first', 'TEST']
  };

  const saved = await saveNote(note, false);
  assert.ok(saved.id.startsWith('note_'));
  assert.strictEqual(saved.title, 'Brand New Note');
  assert.strictEqual(saved.version, 1);
  assert.deepStrictEqual(saved.tags, ['first', 'test']);

  const fetched = await getNote(saved.id);
  assert.strictEqual(fetched.title, 'Brand New Note');
});

test('deleteNote handles undefined safely and marks existing note as tombstone', async () => {
  const rNull = await deleteNote(undefined);
  assert.strictEqual(rNull, null);

  const saved = await saveNote({ title: 'To Delete' }, false);
  const tombstone = await deleteNote(saved.id, false);
  assert.strictEqual(tombstone.isDeleted, true);
  assert.strictEqual(tombstone.version, 2);

  const activeNotes = await searchNotes();
  assert.strictEqual(activeNotes.some(n => n.id === saved.id), false);
});

test('getSetting and setSetting work safely with null keys', async () => {
  assert.strictEqual(await getSetting(null, 'default'), 'default');
  await setSetting('theme', 'dark');
  assert.strictEqual(await getSetting('theme'), 'dark');
});
