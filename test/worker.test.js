import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { SyncRoom } from '../worker.js';

test('Worker health endpoint returns ok', async () => {
  const req = new Request('https://syncpad.internal/api/health');
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.app, 'syncpad');
});

test('Worker OPTIONS preflight returns CORS headers', async () => {
  const req = new Request('https://syncpad.internal/api/room/TEST-123/sync', {
    method: 'OPTIONS'
  });
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('SyncRoom REST sync saves and returns notes', async () => {
  const room = new SyncRoom(null, null);

  const initialNote = {
    id: 'note_test_1',
    title: 'Initial Title',
    content: 'Initial Content',
    tags: ['test'],
    pinned: false,
    updatedAt: '2026-10-26T10:00:00.000Z',
    version: 1,
    isDeleted: false
  };

  const req1 = new Request('https://syncpad.internal/api/room/TEST-100/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'dev_laptop',
      changes: [initialNote],
      clientNotes: [initialNote]
    })
  });

  const res1 = await room.fetch(req1);
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.equal(data1.notes.length, 1);
  assert.equal(data1.notes[0].title, 'Initial Title');

  // Device 2 sends newer update
  const updatedNote = {
    ...initialNote,
    title: 'Updated From Phone',
    updatedAt: '2026-10-26T10:05:00.000Z',
    version: 2
  };

  const req2 = new Request('https://syncpad.internal/api/room/TEST-100/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'dev_phone',
      changes: [updatedNote],
      clientNotes: [updatedNote]
    })
  });

  const res2 = await room.fetch(req2);
  const data2 = await res2.json();
  assert.equal(data2.notes.length, 1);
  assert.equal(data2.notes[0].title, 'Updated From Phone');
  assert.equal(data2.notes[0].version, 2);

  // Deletion test
  const deletedNote = {
    id: 'note_test_1',
    updatedAt: '2026-10-26T10:10:00.000Z',
    isDeleted: true
  };

  const req3 = new Request('https://syncpad.internal/api/room/TEST-100/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'dev_laptop',
      changes: [deletedNote]
    })
  });

  const res3 = await room.fetch(req3);
  const data3 = await res3.json();
  // Deleted note should be filtered from active notes
  assert.equal(data3.notes.length, 0);
});

test('Worker returns 404 for unknown API path', async () => {
  const req = new Request('https://syncpad.internal/api/unknown-endpoint');
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 404);
});
