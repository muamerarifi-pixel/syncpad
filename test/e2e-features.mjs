// Trash, version history, offline files, removing a device (3 devices)
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const step = (s) => console.log('•', s);
const mk = async (opts, name) => {
  const ctx = await browser.newContext({ ...opts, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/403|409/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  return [ctx, p];
};
const [ctxA, A] = await mk({ viewport: { width: 1280, height: 860 } }, 'A');
const [, B] = await mk({ ...devices['Pixel 7'] }, 'B');
const [, C] = await mk({ ...devices['iPhone 13'] }, 'C');
for (const p of [A, B, C]) { await p.goto(BASE + '/'); await p.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 }); }

// pair B and C with A
await A.click('#btn-connect');
await A.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('#pair-code').textContent));
const code = (await A.textContent('#pair-code')).replace(/\D/g, '');
await A.keyboard.press('Escape');
for (const p of [B, C]) { await p.click('#btn-connect'); await p.fill('#join-code', code); await p.waitForSelector('.toast >> text=Connected'); }
await A.waitForFunction(() => /3 devices/.test(document.querySelector('.status-text').textContent), null, { timeout: 10000 });
step('three devices connected');

// ── Trash
await A.fill('#composer-input', 'Please do not lose me');
await A.keyboard.press('Enter');
await B.waitForSelector('.drop-text >> text=Please do not lose me');
await A.click('.drop:has(.drop-text:text("Please do not lose me")) [data-act="menu"]');
await A.click('.menu button:has-text("Move to Trash")');
await B.waitForFunction(() => !document.body.innerText.includes('Please do not lose me'), null, { timeout: 8000 });
await A.click('#btn-settings');
await A.waitForSelector('#trash-btn-label >> text=Open Trash (1)');
await A.click('#btn-open-trash');
await A.waitForSelector('.trash-row >> text=Please do not lose me');
await A.screenshot({ path: `${OUT}/40-desktop-trash.png` });
await A.click('.trash-row [data-act="restore"]');
await A.keyboard.press('Escape');
await B.waitForSelector('.drop-text >> text=Please do not lose me', { timeout: 8000 });
step('Move to Trash hides it everywhere; Restore brings it back everywhere');

// ── Version history
await A.click('.tab[data-tab="notes"]');
await A.click('#btn-new-note');
await A.keyboard.type('Trip plan');
await A.keyboard.press('Enter');
await A.keyboard.type('Original plan: leave on Friday');
await A.waitForTimeout(1500);
await B.click('.tabbar-btn[data-tab="notes"]');
await B.click('.note-item >> text=Trip plan');
await B.click('#editor-text');
await B.keyboard.press('Control+A');
await B.keyboard.type('Trip plan\nChanged by phone: leave Sunday');
await B.waitForTimeout(1500);
await A.waitForFunction(() => document.querySelector('#editor-text').innerText.includes('Changed by phone'), null, { timeout: 10000 });
await A.click('#btn-note-more');
await A.click('.menu button:has-text("Version history")');
await A.waitForSelector('.history-item[data-hid]:not([data-hid="current"])', { timeout: 8000 });
await A.click('.history-item[data-hid]:not([data-hid="current"])');
await A.waitForSelector('#history-preview >> text=Original plan: leave on Friday');
await A.screenshot({ path: `${OUT}/41-desktop-history.png` });
await A.click('#btn-restore-version');
await A.waitForFunction(() => document.querySelector('#editor-text').innerText.includes('Original plan: leave on Friday'));
await B.waitForFunction(() => document.querySelector('#editor-text').innerText.includes('Original plan: leave on Friday'), null, { timeout: 10000 });
step('version history shows the earlier text and Restore syncs it to the phone');
await B.click('#btn-editor-back');
await B.click('.tabbar-btn[data-tab="drops"]');

// ── Offline file
await A.click('.tab[data-tab="drops"]');
const bytes = Buffer.alloc(300 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13) & 255;
await A.setInputFiles('#file-input', [{ name: 'manual.bin', mimeType: 'application/octet-stream', buffer: bytes }]);
await A.waitForSelector('.drop:has(.drop-title:text("manual.bin")) [data-act="download"]', { timeout: 15000 });
await A.click('.drop:has(.drop-title:text("manual.bin")) [data-act="menu"]');
await A.click('.menu button:has-text("Keep on this device")');
await A.waitForSelector('.drop:has(.drop-title:text("manual.bin")) .pin-flag.off', { timeout: 10000 });
await A.reload();
await A.waitForSelector('.drop-title >> text=manual.bin');
await ctxA.setOffline(true);
const [dl] = await Promise.all([A.waitForEvent('download'), A.click('.drop:has(.drop-title:text("manual.bin")) [data-act="download"]')]);
const got = fs.readFileSync(await dl.path());
if (!got.equals(bytes)) throw new Error('offline copy differs');
await ctxA.setOffline(false);
step('kept-offline file downloads with no internet, bytes identical');

// ── Remove a device
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.click('#btn-settings');
await A.waitForSelector('#settings-devices .dev-row >> text=Pixel phone');
await A.click('#settings-devices .dev-row:has-text("Pixel phone") .dev-remove');
await A.click('#confirm-ok');
await A.waitForSelector('.toast >> text=was removed');
await B.waitForURL(/removed=1|\/$/, { timeout: 15000 });
await B.waitForSelector('.toast >> text=This device was removed', { timeout: 15000 });
const bText = await B.textContent('#feed-inner');
if (bText.includes('Please do not lose me')) throw new Error('removed device still shows data');
await B.screenshot({ path: `${OUT}/42-removed-device.png` });
step('removed phone is signed out and its copy erased');
await A.keyboard.press('Escape');
await A.fill('#composer-input', 'Only for the remaining devices');
await A.keyboard.press('Enter');
await C.waitForSelector('.drop-text >> text=Only for the remaining devices', { timeout: 15000 });
step('the other device (iPhone) switched to the new link automatically and keeps syncing');
const link = await A.evaluate(() => new Promise((r) => { const q = indexedDB.open('syncpad2'); q.onsuccess = () => { const t = q.result.transaction('kv').objectStore('kv'); const a = t.get('space'); const b = t.get('token'); b.onsuccess = () => r([a.result.v, b.result.v]); }; }));
if (link[0] === link[1]) throw new Error('token did not rotate');
const oldLinkStatus = await B.evaluate(async (s) => (await fetch(`/api/s/${s}/sync`, { method: 'POST', body: '{"since":0}' })).status, link[0]);
if (oldLinkStatus !== 403) throw new Error('old link still works: ' + oldLinkStatus);
step('the old link no longer opens anything');
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
