import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
const browser = await chromium.launch();
const errors = [];
const watch = (page, name) => { page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); }); };
const step = (s) => console.log('•', s);
const space = (p) => p.evaluate(() => new Promise((r) => { const q = indexedDB.open('syncpad2'); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('space'); g.onsuccess = () => r(g.result && g.result.v); }; }));

// 1) v1 migration: seed the old database, then open the new app
const png = fs.readFileSync(new URL('../public/icons/icon-192.png', import.meta.url)).toString('base64');
const ctx = await browser.newContext({ viewport: { width: 1200, height: 780 } });
const P = await ctx.newPage(); watch(P, 'P');
await P.goto(BASE + '/api/health');
await P.evaluate((png) => new Promise((res) => {
  const r = indexedDB.open('syncpad_db', 1);
  r.onupgradeneeded = () => { const db = r.result; db.createObjectStore('notes', { keyPath: 'id' }); db.createObjectStore('settings', { keyPath: 'key' }); db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true }); };
  r.onsuccess = () => {
    const t = r.result.transaction('notes', 'readwrite');
    t.objectStore('notes').put({ id: 'note_lx9_abc1234', title: 'Old lesson plan', content: 'Unit 4 vocabulary\n\n![Board](attachment:img-1)', tags: ['school'], pinned: true, updatedAt: new Date().toISOString(), version: 3, isDeleted: false, images: [{ id: 'img-1', name: 'Board', dataUrl: 'data:image/png;base64,' + png, size: 1000 }] });
    t.objectStore('notes').put({ id: 'note_lx9_del0000', title: 'Deleted', content: '', isDeleted: true });
    t.oncomplete = () => { r.result.close(); res(); };
  };
}), png);
await P.goto(BASE + '/');
await P.waitForSelector('.toast >> text=Moved 1 note', { timeout: 10000 });
await P.click('.tab[data-tab="notes"]');
await P.waitForSelector('.note-item >> text=Old lesson plan');
await P.waitForFunction(() => { const i = document.querySelector('#editor-text img[data-file]'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 10000 });
await P.waitForSelector('#editor-text h1 >> text=Old lesson plan');
step('v1 note + embedded image imported, image renders from cloud');
await P.screenshot({ path: `${OUT}/12-migrated-note.png` });

// 2) Share target via the service worker
await P.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(async () => { await P.reload(); await P.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }); });
await P.evaluate(async () => {
  const f = new FormData();
  f.append('title', 'Interesting article');
  f.append('url', 'https://example.org/article');
  f.append('files', new File([new Uint8Array(3000)], 'scan.pdf', { type: 'application/pdf' }));
  const r = await fetch('/share-target', { method: 'POST', body: f, redirect: 'manual' });
  return r.type;
});
await P.goto(BASE + '/?shared=1');
await P.waitForSelector('.ri-title >> text=scan.pdf', { timeout: 15000 });
await P.waitForSelector('.ri-title >> text=example.org/article', { timeout: 5000 });
step('Android share target → file + link land in Drops');

// 3) Join by link on a device that already has content → confirm → merged
const ctx2 = await browser.newContext({ ...devices['iPhone 13'] });
const Q = await ctx2.newPage(); watch(Q, 'Q');
await Q.goto(BASE + '/');
await Q.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await Q.fill('#composer-input', 'Note from the iPhone before joining');
await Q.click('#btn-send');
await Q.waitForTimeout(800);
const key = await space(P);
await Q.goto(BASE + '/#join=' + key);
await Q.waitForSelector('#dlg-confirm[open]', { timeout: 8000 });
await Q.screenshot({ path: `${OUT}/13-mobile-join-confirm.png` });
await Q.click('#confirm-ok');
await Q.waitForSelector('.ri-title >> text=scan.pdf', { timeout: 15000 });
await P.waitForSelector('.ri-title >> text=Note from the iPhone before joining', { timeout: 15000 });
if ((await space(Q)) !== key) throw new Error('not joined');
step('join link with confirm merges both sides');
await Q.screenshot({ path: `${OUT}/14-iphone-feed.png` });
await P.click('.tab[data-tab="drops"]');
await P.waitForTimeout(500);
await P.screenshot({ path: `${OUT}/15-desktop-feed2.png` });
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
