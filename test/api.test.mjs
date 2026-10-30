// API tests against a running `wrangler dev` (BASE env, default http://127.0.0.1:8787)
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const key = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sync = async (s, body) => (await post(`/api/s/${s}/sync`, body)).json();

test('old short room codes are rejected', async () => {
  const r = await post('/api/s/PAD-742/sync', { since: 0 });
  assert.equal(r.status, 404);
});

test('notes sync between devices with server ordering', async () => {
  const s = key();
  const a = await sync(s, { device: 'devA', since: 0, ops: [{ id: 'note000001', kind: 'note', baseRev: 0, data: { body: 'hello' } }] });
  assert.equal(a.acks[0].ok, true);
  assert.equal(a.acks[0].rev, 1);
  const b = await sync(s, { device: 'devB', since: 0, ops: [] });
  assert.equal(b.changes.length, 1);
  assert.equal(b.changes[0].data.body, 'hello');
  // same device can update quickly without conflicts
  const a2 = await sync(s, { device: 'devA', since: a.seq, ops: [{ id: 'note000001', kind: 'note', baseRev: 0, data: { body: 'hello 2' } }] });
  assert.equal(a2.acks[0].rev, 2);
  // other device editing a stale copy creates a conflict copy, nothing is lost
  const b2 = await sync(s, { device: 'devB', since: b.seq, ops: [{ id: 'note000001', kind: 'note', baseRev: 1, data: { body: 'from B' } }] });
  assert.ok(b2.acks[0].conflict);
  assert.equal(b2.acks[0].item.data.body, 'hello 2');
  const copy = b2.changes.find((c) => c.id === b2.acks[0].conflict);
  assert.equal(copy.data.body, 'from B');
  assert.equal(copy.data.conflictOf, 'note000001');
});

test('chunked file upload, completeness check, range download, delete', async () => {
  const s = key();
  const CHUNK = 1024 * 1024;
  const size = CHUNK * 2 + 1234;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31) & 255;
  const op = { id: 'file000001', kind: 'file', baseRev: 0, data: { name: 'test.bin', size, type: 'application/octet-stream' } };
  const early = await sync(s, { device: 'd', since: 0, ops: [op] });
  assert.equal(early.acks[0].err, 'incomplete');
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}/api/s/${s}/file/file000001/${i}`, { method: 'PUT', body: bytes.slice(i * CHUNK, (i + 1) * CHUNK) });
    assert.equal(r.status, 200);
  }
  const have = await (await fetch(`${BASE}/api/s/${s}/file/file000001/have`)).json();
  assert.deepEqual(have.have, [0, 1, 2]);
  const done = await sync(s, { device: 'd', since: 0, ops: [op] });
  assert.equal(done.acks[0].ok, true);
  assert.equal(done.usage, size);
  const full = new Uint8Array(await (await fetch(`${BASE}/api/s/${s}/file/file000001`)).arrayBuffer());
  assert.equal(full.length, size);
  assert.deepEqual(full.slice(CHUNK - 5, CHUNK + 5), bytes.slice(CHUNK - 5, CHUNK + 5));
  const part = await fetch(`${BASE}/api/s/${s}/file/file000001`, { headers: { range: `bytes=${CHUNK - 2}-${CHUNK + 1}` } });
  assert.equal(part.status, 206);
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes.slice(CHUNK - 2, CHUNK + 2));
  const del = await sync(s, { device: 'd', since: done.seq, ops: [{ id: 'file000001', kind: 'file', baseRev: 1, deleted: true }] });
  assert.equal(del.usage, 0);
  assert.equal((await fetch(`${BASE}/api/s/${s}/file/file000001`)).status, 404);
});

test('uploaded HTML is sandboxed and served as a download', async () => {
  const s = key();
  const html = new TextEncoder().encode('<script>alert(1)</script>');
  await fetch(`${BASE}/api/s/${s}/file/file000002/0`, { method: 'PUT', body: html });
  await sync(s, { device: 'd', since: 0, ops: [{ id: 'file000002', kind: 'file', data: { name: 'x.html', size: html.length, type: 'text/html' } }] });
  const r = await fetch(`${BASE}/api/s/${s}/file/file000002`);
  assert.match(r.headers.get('content-disposition'), /^attachment/);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
});

test('6-digit pairing code resolves to the space', async () => {
  const s = key();
  const c = await (await post('/api/pair', { space: s })).json();
  assert.match(c.code, /^\d{6}$/);
  const again = await (await post('/api/pair', { space: s })).json();
  assert.equal(again.code, c.code);
  const claim = await (await post('/api/pair/claim', { code: c.code })).json();
  assert.equal(claim.space, s);
  const bad = await post('/api/pair/claim', { code: '000000' === c.code ? '111111' : '000000' });
  assert.equal(bad.status, 404);
});

const hdr = (k, dev) => ({ 'content-type': 'application/json', 'x-k': k, 'x-d': dev.d, 'x-ds': dev.ds });
const devCall = (s, dev, k, body, path = 'sync') =>
  fetch(`${BASE}/api/s/${s}/${path}`, { method: 'POST', headers: hdr(k, dev), body: JSON.stringify(body) });

test('removing a device: it is locked out, other devices get the new token', async () => {
  const s = key();
  const A = { d: 'deviceAAAA', ds: key() };
  const B = { d: 'deviceBBBB', ds: key() };
  const C = { d: 'deviceCCCC', ds: key() };
  for (const dev of [A, B, C]) assert.equal((await devCall(s, dev, s, { since: 0, ops: [] })).status, 200);
  // someone who knows a device id but not its secret is refused
  assert.equal((await devCall(s, { d: 'deviceAAAA', ds: key() }, s, { since: 0 })).status, 403);
  const t2 = key();
  assert.equal((await devCall(s, A, s, { remove: ['deviceBBBB'], token: t2 }, 'rotate')).status, 200);
  const rb = await devCall(s, B, s, { since: 0 });
  assert.equal(rb.status, 403);
  assert.equal((await rb.json()).revoked, true);
  // the old link alone no longer works
  assert.equal((await fetch(`${BASE}/api/s/${s}/sync`, { method: 'POST', body: '{"since":0}' })).status, 403);
  // C still has the old token: it is handed the new one
  const rc = await devCall(s, C, s, { since: 0 });
  assert.equal(rc.status, 409);
  assert.equal((await rc.json()).token, t2);
  assert.equal((await devCall(s, C, t2, { since: 0 })).status, 200);
  // a brand-new device joining with the new token works
  assert.equal((await devCall(s, { d: 'deviceDDDD', ds: key() }, t2, { since: 0 })).status, 200);
  const list = await (await fetch(`${BASE}/api/s/${s}/devices?k=${t2}`)).json();
  assert.ok(!list.devices.some((d) => d.id === 'deviceBBBB'));
  // files need the token too
  assert.equal((await fetch(`${BASE}/api/s/${s}/file/abcdefgh`)).status, 403);
});

test('note history keeps earlier versions', async () => {
  const s = key();
  const A = { d: 'deviceAAAA', ds: key() };
  const B = { d: 'deviceBBBB', ds: key() };
  const r1 = await (await devCall(s, A, s, { since: 0, ops: [{ id: 'note000009', kind: 'note', baseRev: 0, data: { html: '<p>v1</p>', text: 'v1' } }] })).json();
  await devCall(s, A, s, { since: r1.seq, ops: [{ id: 'note000009', kind: 'note', baseRev: 1, data: { html: '<p>v2</p>', text: 'v2' } }] });
  await devCall(s, B, s, { since: 0, ops: [{ id: 'note000009', kind: 'note', baseRev: 2, data: { html: '<p>v3 from B</p>', text: 'v3 from B' } }] });
  const h = await (await fetch(`${BASE}/api/s/${s}/history/note000009`)).json();
  assert.deepEqual(h.versions.map((v) => v.preview), ['v2', 'v1']);
  const item = await (await fetch(`${BASE}/api/s/${s}/history/note000009/${h.versions[1].hid}`)).json();
  assert.equal(item.data.html, '<p>v1</p>');
});

test('push: other devices get a VAPID-signed push when a drop arrives', async () => {
  const http = await import('node:http');
  const got = [];
  const srv = http.createServer((req, res) => { got.push({ url: req.url, auth: req.headers.authorization }); res.end('ok'); });
  await new Promise((r) => srv.listen(9911, '127.0.0.1', r));
  try {
    const s = key();
    const A = { d: 'deviceAAAA', ds: key() };
    const B = { d: 'deviceBBBB', ds: key() };
    await devCall(s, A, s, { since: 0 });
    assert.equal((await devCall(s, A, s, { endpoint: 'http://127.0.0.1:9911/push/A' }, 'push')).status, 200);
    await devCall(s, B, s, { since: 0, ops: [{ id: 'clip000001', kind: 'clip', baseRev: 0, data: { text: 'hello phone' } }] });
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(got.length, 1);
    assert.equal(got[0].url, '/push/A');
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(got[0].auth);
    assert.ok(m, got[0].auth);
    const dec = (x) => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const pub = await crypto.subtle.importKey('raw', dec(m[4]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, dec(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
    assert.ok(ok, 'JWT signature verifies');
    assert.equal(JSON.parse(dec(m[2]).toString()).aud, 'http://127.0.0.1:9911');
    const key2 = await (await fetch(`${BASE}/api/push/key`)).json();
    assert.equal(key2.key, m[4]);
    const latest = await (await fetch(`${BASE}/api/s/${s}/latest?since=0&d=deviceAAAA`)).json();
    assert.equal(latest.items[0].text, 'hello phone');
  } finally {
    srv.close();
  }
});
