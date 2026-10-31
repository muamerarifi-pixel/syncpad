// Photo text (size A+/A−, colour, shadow, move) and collages (fit / fill, columns, swap, trash originals)
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const A = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
A.on('pageerror', (e) => errors.push(e.message));
A.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });

const mk = (w, h, color) => A.evaluate(([w, h, color]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h);
  return c.toDataURL('image/png').split(',')[1];
}, [w, h, color]);
await A.setInputFiles('#file-input', [
  { name: 'red.png', mimeType: 'image/png', buffer: Buffer.from(await mk(1200, 800, '#dc2626'), 'base64') },
  { name: 'green.png', mimeType: 'image/png', buffer: Buffer.from(await mk(800, 1200, '#16a34a'), 'base64') },
  { name: 'blue.png', mimeType: 'image/png', buffer: Buffer.from(await mk(1000, 1000, '#2563eb'), 'base64') }
]);
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 3 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });

// pixels of a drop's file, read through the viewer
const pixels = (id, pts) => A.evaluate(async ([id, pts]) => {
  const bm = document.querySelector('#viewer-body img'); // the editor's result is shown from memory (blob URL)
  await bm.decode();
  const c = new OffscreenCanvas(bm.naturalWidth, bm.naturalHeight); const x = c.getContext('2d'); x.drawImage(bm, 0, 0);
  const box = (X, Y, R) => { const d = x.getImageData(X - R, Y - R, R * 2, R * 2).data; let yellow = 0, white = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 200 && d[i + 1] > 170 && d[i + 2] < 90) yellow++; if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++; } return { yellow, white }; };
  return { w: bm.naturalWidth, h: bm.naturalHeight, px: pts.map(([X, Y]) => [...x.getImageData(X, Y, 1, 1).data].slice(0, 3)), boxes: pts.map(([X, Y]) => box(X, Y, 60)) };
}, [id, pts]);

// ── 1) text on the red photo
const oldRed = await A.$eval('.ri:has-text("red.png")', (n) => n.dataset.id);
await A.click('.ri:has-text("red.png") .ri-thumb');
await A.click('#viewer-markup');
await A.waitForSelector('#dlg-markup[open]');
await A.click('[data-tool="text"]');
if (!(await A.isVisible('#mk-text'))) throw new Error('text field hidden');
const cv = await (await A.$('#mk-canvas')).boundingBox();
const k = cv.width / 1200;
await A.mouse.click(cv.x + 600 * k, cv.y + 300 * k);
await A.keyboard.type('Hello SyncPad');
await A.click('[data-font="1"]'); await A.click('[data-font="1"]');
await A.click('[data-color="#facc15"]');
await A.screenshot({ path: `${OUT}/82-text.png` });
// drag it lower
const tb = await (await A.$('#mk-textbox')).boundingBox();
await A.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2); await A.mouse.down();
await A.mouse.move(cv.x + 600 * k, cv.y + 560 * k, { steps: 8 }); await A.mouse.up();
await A.click('#mk-text-done');
if (await A.isVisible('#mk-textbox')) throw new Error('box should hide after Done');
// a second text, then undo it
await A.mouse.click(cv.x + 300 * k, cv.y + 120 * k);
await A.keyboard.type('remove me');
await A.click('#mk-text-done');
await A.click('#mk-undo');
await A.screenshot({ path: `${OUT}/83-text-done.png` });
await A.click('#mk-save');
await A.waitForSelector('.toast >> text=deleted from every device');
await A.waitForFunction((old) => { const r = document.querySelector('.ri:has(.ri-thumb img)') && [...document.querySelectorAll('.ri')].find((n) => n.textContent.includes('red.png')); return r && r.dataset.id !== old && document.querySelectorAll('.ri').length === 3 && !document.querySelector('.ri .progress'); }, oldRed, { timeout: 20000 });
await A.waitForTimeout(300);
const redId = await A.$eval('.ri:has-text("red.png")', (n) => n.dataset.id);
await A.click(`.ri[data-id="${redId}"] .ri-thumb`);
await A.waitForSelector('#dlg-viewer[open] #viewer-body img');
const t = await pixels(redId, [[600, 560], [600, 300], [300, 120]]);
console.log('  text check:', JSON.stringify(t.boxes));
if (t.boxes[0].yellow < 40) throw new Error('yellow text not at its new place');
if (t.boxes[1].yellow > 5) throw new Error('text still at the old place');
if (t.boxes[2].white > 5 || t.boxes[2].yellow > 5) throw new Error('undone text still there');
await A.keyboard.press('Escape');
step('Text: tap, type, A+ ×2, yellow, drag to move, Done; second text undone; saved into the photo');

// ── 2) collage of the three photos
await A.click('#btn-select');
for (const n of ['red.png', 'green.png', 'blue.png']) await A.click(`.ri:has-text("${n}")`);
await A.waitForSelector('[data-sel="collage"]:not([hidden])');
await A.click('[data-sel="collage"]');
await A.waitForSelector('#dlg-collage[open]');
await A.waitForTimeout(200);
await A.screenshot({ path: `${OUT}/84-collage-fit.png` });
const dims = await A.$eval('#cl-canvas', (c) => [c.width, c.height]);
if (dims[0] !== 3120 || dims[1] !== 1060) throw new Error('layout ' + dims);
const fitPx = await A.$eval('#cl-canvas', (c) => [...c.getContext('2d').getImageData(40, 40, 1, 1).data].slice(0, 3));
if (fitPx.join() !== '255,255,255') throw new Error('fit should letterbox the wide photo: ' + fitPx);
await A.click('[data-cl-mode="crop"]');
await A.click('[data-cl-cols="-1"]');
if ((await A.textContent('#cl-cols')) !== '2 columns') throw new Error('cols');
await A.click('[data-cl-cols="1"]');
// swap the first two
const cc = await (await A.$('#cl-canvas')).boundingBox();
const s = cc.width / 3120;
await A.mouse.click(cc.x + 500 * s, cc.y + 500 * s);
if (!(await A.isVisible('#cl-pick'))) throw new Error('pick');
await A.mouse.click(cc.x + 1560 * s, cc.y + 500 * s);
await A.screenshot({ path: `${OUT}/85-collage-fill.png` });
await A.check('#cl-trash');
await A.click('#cl-save');
await A.waitForSelector('.toast >> text=Collage saved');
await A.waitForFunction(() => [...document.querySelectorAll('.ri')].some((n) => /Collage .*\.jpg/.test(n.textContent)) && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
const left = await A.$$eval('.ri', (n) => n.map((x) => x.querySelector('.ri-name, .ri-title, .ri-main')?.textContent || x.textContent));
if (left.length !== 1) throw new Error('originals should be in Trash: ' + left.length);
const cid = await A.$eval('.ri', (n) => n.dataset.id);
await A.click(`.ri[data-id="${cid}"] .ri-thumb`);
await A.waitForSelector('#dlg-viewer[open] #viewer-body img');
const c = await pixels(cid, [[40, 40], [1070, 40], [2100, 40]]);
console.log('  collage:', c.w + 'x' + c.h, JSON.stringify(c.px));
const near = (p, q) => p.every((v, i) => Math.abs(v - q[i]) < 40);
if (!near(c.px[0], [22, 163, 74]) || !near(c.px[1], [220, 38, 38]) || !near(c.px[2], [37, 99, 235])) throw new Error('fill/swap order wrong');
await A.keyboard.press('Escape');
step(`Collage: Fit letterboxes, Fill crops, columns −/+, swap by tapping; saved ${c.w}×${c.h} JPEG; originals → Trash`);

// ── 3) phone layout of both editors
const P = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
P.on('pageerror', (e) => errors.push('P: ' + e.message));
await P.goto(BASE + '/'); await P.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await P.setInputFiles('#file-input', [
  { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(await mk(1200, 800, '#dc2626'), 'base64') },
  { name: 'b.png', mimeType: 'image/png', buffer: Buffer.from(await mk(800, 1200, '#16a34a'), 'base64') }
]);
await P.waitForFunction(() => document.querySelectorAll('.ri').length === 2 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
await P.click('.ri:has-text("a.png") .ri-thumb'); await P.click('#viewer-markup'); await P.waitForSelector('#dlg-markup[open]');
await P.click('[data-tool="text"]');
const pc = await (await P.$('#mk-canvas')).boundingBox();
await P.touchscreen.tap(pc.x + pc.width / 2, pc.y + pc.height / 2);
await P.keyboard.type('Phone text');
await P.screenshot({ path: `${OUT}/86-phone-text.png` });
await P.click('#mk-cancel').catch(() => {});
P.on('dialog', (d) => d.accept());
await P.click('#mk-cancel').catch(() => {});
await P.waitForTimeout(300);
await P.keyboard.press('Escape');
await P.click('#btn-select');
await P.click('.ri:has-text("a.png")'); await P.click('.ri:has-text("b.png")');
await P.click('[data-sel="collage"]');
await P.waitForSelector('#dlg-collage[open]'); await P.waitForTimeout(200);
await P.screenshot({ path: `${OUT}/87-phone-collage.png` });
step('Phone layouts captured');

if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
