/**
 * SyncPad IndexedDB Offline Storage Module
 * Provides reliable, zero-dependency offline persistence for notes, settings, and sync queue.
 */

const DB_NAME = 'syncpad_db';
const DB_VERSION = 1;

let dbInstance = null;

/**
 * Initialize IndexedDB instance
 */
export function initDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Notes store
      if (!db.objectStoreNames.contains('notes')) {
        const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
        notesStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        notesStore.createIndex('pinned', 'pinned', { unique: false });
        notesStore.createIndex('isDeleted', 'isDeleted', { unique: false });
      }

      // Settings store
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // Sync queue store (for offline edits queued to sync when back online)
      if (!db.objectStoreNames.contains('sync_queue')) {
        const queueStore = db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
        queueStore.createIndex('timestamp', 'timestamp', { unique: false });
        queueStore.createIndex('noteId', 'noteId', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('IndexedDB open error:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Generate a unique ID for notes and devices
 */
export function generateId(prefix = 'note') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 9);
  return `${prefix}_${ts}_${rand}`;
}

/**
 * Helper to run a transaction
 */
function runTransaction(storeName, mode, callback) {
  return initDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);

      let result;
      try {
        result = callback(store, tx);
      } catch (err) {
        reject(err);
        return;
      }

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  });
}

/**
 * Retrieve all active notes, sorted with pinned first, then newest updatedAt
 */
export function getAllNotes() {
  return runTransaction('notes', 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const notes = (request.result || [])
          .filter((note) => !note.isDeleted)
          .sort((a, b) => {
            // Pinned notes first
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            // Then newest updatedAt
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
          });
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Retrieve a note by ID
 */
export function getNote(id) {
  return runTransaction('notes', 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Save or update a note locally and optionally add to sync queue
 */
export async function saveNote(note, enqueue = true) {
  const now = new Date().toISOString();
  const existing = await getNote(note.id);

  const cleanNote = {
    id: note.id || generateId('note'),
    title: note.title ? note.title.trim() : 'Untitled Note',
    content: note.content || '',
    tags: Array.isArray(note.tags) ? Array.from(new Set(note.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))) : [],
    pinned: Boolean(note.pinned),
    createdAt: existing ? existing.createdAt : (note.createdAt || now),
    updatedAt: now,
    version: (existing && existing.version ? existing.version : 0) + 1,
    isDeleted: false
  };

  await runTransaction('notes', 'readwrite', (store) => {
    store.put(cleanNote);
  });

  if (enqueue) {
    await enqueueSyncItem('UPSERT', cleanNote.id, cleanNote);
  }

  return cleanNote;
}

/**
 * Apply remote note update from server or peer with conflict resolution (LWW)
 * @returns {Promise<{ applied: boolean, note: object }>}
 */
export async function applyRemoteNote(remoteNote) {
  if (!remoteNote || !remoteNote.id) {
    return { applied: false, note: null };
  }

  const local = await getNote(remoteNote.id);

  const sanitizedRemote = {
    ...remoteNote,
    tags: Array.isArray(remoteNote.tags) ? remoteNote.tags : [],
    pinned: Boolean(remoteNote.pinned)
  };

  // If local does not exist, insert remote note
  if (!local) {
    if (sanitizedRemote.isDeleted) {
      // Remote already deleted and we don't have it, nothing to do
      return { applied: true, note: sanitizedRemote };
    }
    await runTransaction('notes', 'readwrite', (store) => {
      store.put(sanitizedRemote);
    });
    return { applied: true, note: sanitizedRemote };
  }

  // Conflict resolution: Last-Write-Wins (LWW) based on UTC timestamp & version
  const localTime = new Date(local.updatedAt || 0).getTime();
  const remoteTime = new Date(sanitizedRemote.updatedAt || 0).getTime();

  let remoteWins = false;
  if (remoteTime > localTime) {
    remoteWins = true;
  } else if (remoteTime === localTime) {
    remoteWins = (sanitizedRemote.version || 0) >= (local.version || 0);
  }

  if (remoteWins) {
    await runTransaction('notes', 'readwrite', (store) => {
      store.put(sanitizedRemote);
    });
    return { applied: true, note: sanitizedRemote };
  }

  // Local was newer than remote; local wins, keep local note
  return { applied: false, note: local };
}

/**
 * Delete a note (soft-delete tombstone for sync)
 */
export async function deleteNote(id, enqueue = true) {
  const existing = await getNote(id);
  const now = new Date().toISOString();

  const tombstone = {
    id,
    title: existing ? existing.title : 'Deleted Note',
    content: '',
    tags: [],
    pinned: false,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    version: (existing && existing.version ? existing.version : 0) + 1,
    isDeleted: true
  };

  await runTransaction('notes', 'readwrite', (store) => {
    store.put(tombstone);
  });

  if (enqueue) {
    await enqueueSyncItem('DELETE', id, tombstone);
  }

  return tombstone;
}

/**
 * Enqueue change for sync
 */
export function enqueueSyncItem(action, noteId, data) {
  return runTransaction('sync_queue', 'readwrite', (store) => {
    store.add({
      action,
      noteId,
      data,
      timestamp: new Date().toISOString()
    });
  });
}

/**
 * Get all pending sync queue items
 */
export function getPendingSyncItems() {
  return runTransaction('sync_queue', 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Clear sync queue items by keys
 */
export function clearPendingSyncItems(itemKeys) {
  if (!itemKeys || itemKeys.length === 0) return Promise.resolve();

  return runTransaction('sync_queue', 'readwrite', (store) => {
    for (const key of itemKeys) {
      store.delete(key);
    }
  });
}

/**
 * Settings helpers
 */
export function getSetting(key, defaultValue = null) {
  return runTransaction('settings', 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result !== undefined && request.result !== null) {
          resolve(request.result.value);
        } else {
          resolve(defaultValue);
        }
      };
      request.onerror = () => reject(request.error);
    });
  });
}

export function setSetting(key, value) {
  return runTransaction('settings', 'readwrite', (store) => {
    store.put({ key, value });
  });
}

/**
 * Persistent device identifier for presence and conflict tracking
 */
export async function getOrCreateDeviceId() {
  let deviceId = await getSetting('deviceId');
  if (!deviceId) {
    deviceId = generateId('device');
    await setSetting('deviceId', deviceId);
  }
  return deviceId;
}

/**
 * Filter notes by query string and/or tag
 */
export async function searchNotes(query = '', activeTag = null) {
  const all = await getAllNotes();
  const q = query.trim().toLowerCase();

  return all.filter((note) => {
    const tags = Array.isArray(note.tags) ? note.tags : [];
    if (activeTag && !tags.some((t) => t.toLowerCase() === activeTag.toLowerCase())) {
      return false;
    }
    if (!q) return true;

    const inTitle = note.title && note.title.toLowerCase().includes(q);
    const inContent = note.content && note.content.toLowerCase().includes(q);
    const inTags = tags.some((t) => t.toLowerCase().includes(q));

    return inTitle || inContent || inTags;
  });
}
