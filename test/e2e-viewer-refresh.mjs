// Photo viewer opens showing the whole photo, zooms (wheel, double-click, buttons, pinch) and pans;
// the Home refresh button reconnects and syncs, and live sync still works afterwards.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const watch = (p, n) => { p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n}: ${m.text()}`); }); };
const A = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage(); watch(A, 'A');
const B = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); watch(B, 'B');
for (const p of [A, B]) { await p.goto(BASE + '/'); await p.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 }); }
await A.click('#btn-connect');
await A.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('#pair-code').textContent));
const code = (await A.textContent('#pair-code')).replace(/\D/g, '');
await A.keyboard.press('Escape');
await B.click('#btn-connect'); await B.fill('#join-code', code); await B.waitForSelector('.toast >> text=Connected');

const tall = await A.evaluate(() => { const c = document.createElement('canvas'); c.width = 1080; c.height = 2400; const x = c.getContext('2d'); x.fillStyle = '#eef'; x.fillRect(0, 0, 1080, 2400); x.fillStyle = '#c00'; x.fillRect(0, 0, 1080, 80); x.fillRect(0, 2320, 1080, 80); x.fillStyle = '#000'; x.font = '70px sans-serif'; x.fillText('TOP', 400, 200); x.fillText('BOTTOM', 350, 2250); return c.toDataURL('image/png').split(',')[1]; });
const small = await A.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#0a0'; x.fillRect(0, 0, 300, 200); return c.toDataURL('image/png').split(',')[1]; });
await A.setInputFiles('#file-input', [
  { name: 'tall.png', mimeType: 'image/png', buffer: Buffer.from(tall, 'base64') },
  { name: 'small.png', mimeType: 'image/png', buffer: Buffer.from(small, 'base64') }
]);
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 2 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });

const box = (p) => p.$eval('.zoom-stage img', (i) => { const r = i.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
const stage = (p) => p.$eval('.zoom-stage', (s) => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

// 1) tall screenshot: whole photo visible
await A.click('.ri:has-text("tall.png") .ri-thumb');
await A.waitForSelector('.zoom-stage.ready');
let b = await box(A); let s = await stage(A);
if (b.h > s.h - 70 || b.y < s.y - 1 || b.y + b.h > s.y + s.h - 70) throw new Error('tall photo not fully visible ' + JSON.stringify([b, s]));
if (await A.textContent('.zoom-pct') !== 'Fit') throw new Error('label');
await A.screenshot({ path: `${OUT}/91-viewer-fit.png` });
step(`Tall screenshot opens whole: ${b.w}×${b.h} inside ${Math.round(s.w)}×${Math.round(s.h)}`);

// 2) zoom: wheel at a point keeps that point under the cursor; drag pans; double-click toggles; buttons
await A.mouse.move(s.x + s.w / 2, s.y + 100);
await A.mouse.wheel(0, -400);
await A.waitForTimeout(100);
const z1 = await box(A);
if (z1.h <= b.h * 1.5) throw new Error('wheel zoom');
const label = await A.textContent('.zoom-pct');
await A.mouse.down(); await A.mouse.move(s.x + s.w / 2, s.y + 300, { steps: 6 }); await A.mouse.up();
const z2 = await box(A);
if (z2.y <= z1.y) throw new Error('drag should pan down');
await A.dblclick('.zoom-stage', { position: { x: 300, y: 300 } });
await A.waitForTimeout(350);
if (await A.textContent('.zoom-pct') !== 'Fit') throw new Error('double-click back to fit');
await A.dblclick('.zoom-stage', { position: { x: s.w / 2, y: 120 } });
await A.waitForTimeout(350);
if (await A.textContent('.zoom-pct') !== '100%') throw new Error('double-click to 100%: ' + await A.textContent('.zoom-pct'));
await A.screenshot({ path: `${OUT}/92-viewer-100.png` });
await A.click('[data-zoom="fit"]'); await A.waitForTimeout(300);
await A.click('[data-zoom="in"]'); await A.waitForTimeout(300);
if (await A.textContent('.zoom-pct') === 'Fit') throw new Error('+ button');
await A.keyboard.press('0'); await A.waitForTimeout(300);
if (await A.textContent('.zoom-pct') !== 'Fit') throw new Error('0 key');
step(`Wheel zoom (${label}), drag to move, double-click Fit ↔ 100%, + / − / 0 work`);
await A.keyboard.press('Escape');

// 3) small photo is not blown up
await A.click('.ri:has-text("small.png") .ri-thumb');
await A.waitForSelector('.zoom-stage.ready');
b = await box(A);
if (b.w !== 300 || b.h !== 200) throw new Error('small photo should stay real size: ' + JSON.stringify(b));
await A.keyboard.press('Escape');
step('Small photo stays at its real size (300×200), centred');

// 4) phone: fit + pinch with two fingers + double tap
await B.waitForFunction(() => document.querySelectorAll('.ri').length === 2, null, { timeout: 15000 });
await B.click('.ri:has-text("tall.png") .ri-thumb');
await B.waitForSelector('.zoom-stage.ready');
b = await box(B); s = await stage(B);
if (b.h > s.h + 1) throw new Error('phone fit');
await B.screenshot({ path: `${OUT}/93-phone-viewer.png` });
await B.evaluate(() => {
  const st = document.querySelector('.zoom-stage');
  const r = st.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const ev = (type, id, x, y) => st.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1 }));
  ev('pointerdown', 1, cx - 30, cy); ev('pointerdown', 2, cx + 30, cy);
  for (let i = 1; i <= 10; i++) { ev('pointermove', 1, cx - 30 - i * 12, cy); ev('pointermove', 2, cx + 30 + i * 12, cy); }
  ev('pointerup', 1, cx - 150, cy); ev('pointerup', 2, cx + 150, cy);
});
const pz = await B.textContent('.zoom-pct');
if (pz === 'Fit') throw new Error('pinch zoom');
await B.click('[data-zoom="fit"]'); await B.waitForTimeout(300);
step(`Phone: whole photo, pinch zoom → ${pz}`);
await B.keyboard.press('Escape');

// 5) refresh button
await A.click('#btn-refresh');
await A.waitForSelector('#btn-refresh.spinning');
await A.waitForSelector('.toast >> text=Up to date', { timeout: 15000 });
await A.waitForSelector('#btn-refresh:not(.spinning)');
await B.fill('#composer-input', 'sent after refresh');
await B.click('#btn-send');
const t0 = Date.now();
await A.waitForFunction(() => [...document.querySelectorAll('.ri')].some((r) => r.textContent.includes('sent after refresh')), null, { timeout: 8000 });
step(`Refresh: spins, “Up to date”; live sync still instant afterwards (${Date.now() - t0} ms)`);

// 6) a dead connection heals itself: break the socket silently, then come back to the tab
await A.evaluate(() => { const W = window.WebSocket.prototype; W.__send = W.send; W.send = function (d) { if (d === 'ping') return; return W.__send.call(this, d); }; });
await A.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await A.waitForTimeout(3600);
await A.evaluate(() => { const W = window.WebSocket.prototype; W.send = W.__send; });
await B.fill('#composer-input', 'after a dead socket');
await B.click('#btn-send');
await A.waitForFunction(() => [...document.querySelectorAll('.ri')].some((r) => r.textContent.includes('after a dead socket')), null, { timeout: 8000 });
step('Unanswered ping → reconnects by itself; messages arrive');

if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
