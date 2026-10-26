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

test('Worker /api/room generates valid roomCode with CORS headers', async () => {
  const req = new Request('https://syncpad.internal/api/room');
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.match(data.roomCode, /^[A-Z]+-\d+$/);
});

test('Worker /api/sync endpoint routes correctly with room query param', async () => {
  const note = {
    id: 'note_sync_api',
    title: 'Via Generic Sync',
    content: 'Content here',
    updatedAt: new Date().toISOString(),
    version: 1
  };

  const req = new Request('https://syncpad.internal/api/sync?room=GEN-SYNC', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'dev_test',
      changes: [note]
    })
  });

  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.notes.length, 1);
  assert.equal(data.notes[0].title, 'Via Generic Sync');
});

test('SyncRoom WebSockets: upgrades, broadcasts presence, and syncs messages across multiple clients', async () => {
  const room = new SyncRoom(null, null);

  // Client 1 connects
  const req1 = new Request('https://syncpad.internal/api/room/REALTIME/ws?deviceId=dev1', {
    headers: { Upgrade: 'websocket' }
  });
  const res1 = await room.fetch(req1);
  assert.equal(res1.status, 101);
  const ws1 = res1.webSocket;

  const ws1Messages = [];
  ws1.addEventListener('message', (e) => {
    ws1Messages.push(JSON.parse(e.data));
  });

  // Client 2 connects
  const req2 = new Request('https://syncpad.internal/api/room/REALTIME/ws?deviceId=dev2', {
    headers: { Upgrade: 'websocket' }
  });
  const res2 = await room.fetch(req2);
  assert.equal(res2.status, 101);
  const ws2 = res2.webSocket;

  const ws2Messages = [];
  ws2.addEventListener('message', (e) => {
    ws2Messages.push(JSON.parse(e.data));
  });

  // ws1 should have received PEER_PRESENCE with count 2
  const presenceMsg = ws1Messages.find((m) => m.type === 'PEER_PRESENCE' && m.count === 2);
  assert.ok(presenceMsg, 'Expected presence update of 2 devices');

  // Client 1 sends a note update
  const newNote = {
    id: 'note_rt_1',
    title: 'Real-Time Sync Title',
    content: 'Live content from dev1',
    updatedAt: new Date().toISOString(),
    version: 1
  };

  ws1.send(JSON.stringify({
    type: 'NOTE_UPDATE',
    roomCode: 'REALTIME',
    deviceId: 'dev1',
    note: newNote
  }));

  // Wait for async DO message handling and persist
  await new Promise((r) => setTimeout(r, 20));

  // Client 2 should receive the broadcast
  const receivedOnClient2 = ws2Messages.find((m) => m.type === 'NOTE_UPDATE' && m.note?.id === 'note_rt_1');
  assert.ok(receivedOnClient2, 'Expected client 2 to receive real-time note update from client 1');
  assert.equal(receivedOnClient2.note.title, 'Real-Time Sync Title');

  // Deletion broadcast
  ws1.send(JSON.stringify({
    type: 'NOTE_DELETE',
    roomCode: 'REALTIME',
    deviceId: 'dev1',
    noteId: 'note_rt_1',
    updatedAt: new Date().toISOString(),
    version: 2
  }));

  await new Promise((r) => setTimeout(r, 20));

  const deleteOnClient2 = ws2Messages.find((m) => m.type === 'NOTE_DELETE' && m.noteId === 'note_rt_1');
  assert.ok(deleteOnClient2, 'Expected client 2 to receive note deletion broadcast');
});

test('SyncRoom WebSockets: rejects stale note update and sends authoritative version to sender', async () => {
  const room = new SyncRoom(null, null);

  const req = new Request('https://syncpad.internal/api/room/STALE-TEST/ws?deviceId=dev_tester', {
    headers: { Upgrade: 'websocket' }
  });
  const res = await room.fetch(req);
  const ws = res.webSocket;

  const messages = [];
  ws.addEventListener('message', (e) => {
    messages.push(JSON.parse(e.data));
  });

  // Send authoritative version 2
  ws.send(JSON.stringify({
    type: 'NOTE_UPDATE',
    roomCode: 'STALE-TEST',
    deviceId: 'dev_tester',
    note: {
      id: 'conflict_note',
      title: 'Authoritative V2',
      updatedAt: '2026-10-26T12:00:00.000Z',
      version: 2
    }
  }));

  // Send stale version 1
  ws.send(JSON.stringify({
    type: 'NOTE_UPDATE',
    roomCode: 'STALE-TEST',
    deviceId: 'dev_tester',
    note: {
      id: 'conflict_note',
      title: 'Stale V1',
      updatedAt: '2026-10-26T11:00:00.000Z',
      version: 1
    }
  }));

  // Sender should receive correction from server
  const correction = messages.find((m) => m.type === 'NOTE_UPDATE' && m.deviceId === 'server');
  assert.ok(correction, 'Expected server correction for stale edit');
  assert.equal(correction.note.title, 'Authoritative V2');
});
