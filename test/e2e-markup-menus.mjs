// Right-click / two-finger-tap menus + photo editor (crop, cover box, pen), synced to a second device
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const step = (s) => console.log('•', s);
const watch = (p, n) => { p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n}: ${m.text()}`); }); };
const A = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage(); watch(A, 'A');
const B = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); watch(B, 'B');
for (const p of [A, B]) { await p.goto(BASE + '/'); await p.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 }); }
await A.click('#btn-connect');
await A.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('#pair-code').textContent));
const code = (await A.textContent('#pair-code')).replace(/\D/g, '');
await A.keyboard.press('Escape');
await B.click('#btn-connect'); await B.fill('#join-code', code); await B.waitForSelector('.toast >> text=Connected');

// a "card photo" with a fake test number
const dataUrl = await A.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 760;
  const x = c.getContext('2d');
  x.fillStyle = '#1e3a8a'; x.fillRect(0, 0, 1200, 760);
  x.fillStyle = '#fff'; x.font = 'bold 88px monospace'; x.fillText('4111 1111 1111 1111', 90, 420);
  x.font = '48px sans-serif'; x.fillText('VALID 12/30   CVV 123', 90, 560);
  return c.toDataURL('image/jpeg', 0.9);
});
await A.setInputFiles('#file-input', [{ name: 'card.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') }]);
await A.fill('#composer-input', 'hello from the laptop');
await A.keyboard.press('Enter');
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 2 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
const origId = await A.$eval('.ri:has(.ri-thumb img)', (n) => n.dataset.id);

// 1) right-click on blank space
const feed = await A.$('#feed');
const fb = await feed.boundingBox();
await A.mouse.click(fb.x + fb.width / 2, fb.y + fb.height - 40, { button: 'right' });
await A.waitForSelector('#menu:not([hidden])');
const blank = await A.$$eval('#menu button', (b) => b.map((x) => x.textContent.trim()));
if (!blank.includes('Send files…') || !blank.includes('Select all')) throw new Error('blank menu: ' + blank);
const mpos = await A.$eval('#menu', (m) => m.getBoundingClientRect().toJSON());
if (Math.abs(mpos.left - (fb.x + fb.width / 2)) > 4 && mpos.right > 1280) throw new Error('menu not at cursor');
await A.keyboard.press('Escape');
step('Right-click on empty space → Send files / New folder / Select all, at the cursor');

// 2) right-click on the photo row → its own menu (not the browser's)
const row = await A.$(`.ri[data-id="${origId}"] .ri-thumb`);
const rb = await row.boundingBox();
await A.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2, { button: 'right' });
await A.waitForSelector('#menu:not([hidden])');
const items = await A.$$eval('#menu button', (b) => b.map((x) => x.textContent.trim()));
if (!items.includes('Edit (crop / hide details)') || !items.includes('Move to Trash')) throw new Error('item menu: ' + items);
if (!(await A.$('.ri.ctx'))) throw new Error('no highlight on the right-clicked row');
await A.screenshot({ path: `${OUT}/70-context-menu.png` });
step('Right-click on a photo → SyncPad menu with “Edit (crop / hide details)”, row highlighted');

// 3) cover box + pen + undo, then save (replace original)
await A.click('#menu button:has-text("Edit (crop")');
await A.waitForSelector('#dlg-markup[open] canvas');
await A.waitForTimeout(200);
const cv = await (await A.$('#mk-canvas')).boundingBox();
const sx = cv.width / 1200; const sy = cv.height / 760;
// box over the card number (canvas px 80..1150 x 330..450)
await A.mouse.move(cv.x + 80 * sx, cv.y + 330 * sy);
await A.mouse.down();
await A.mouse.move(cv.x + 600 * sx, cv.y + 400 * sy, { steps: 5 });
if (!(await A.$('#mk-preview:not([hidden])'))) throw new Error('no box preview');
await A.mouse.move(cv.x + 1150 * sx, cv.y + 450 * sy, { steps: 5 });
await A.mouse.up();
// pen scribble over CVV, then one extra stroke that we undo
await A.click('[data-tool="pen"]');
await A.click('[data-size="3"]');
await A.click('[data-color="#ef4444"]');
await A.mouse.move(cv.x + 700 * sx, cv.y + 545 * sy); await A.mouse.down();
await A.mouse.move(cv.x + 900 * sx, cv.y + 545 * sy, { steps: 12 }); await A.mouse.up();
await A.mouse.move(cv.x + 100 * sx, cv.y + 100 * sy); await A.mouse.down();
await A.mouse.move(cv.x + 300 * sx, cv.y + 120 * sy, { steps: 6 }); await A.mouse.up();
await A.click('#mk-undo');
await A.screenshot({ path: `${OUT}/71-markup.png` });
// crop: drag the bottom-right corner in, apply, undo it, then crop again and Save without pressing Apply
const dragSE = async (toX, toY) => {
  const h = await (await A.$('#mk-crop i[data-h="se"]')).boundingBox();
  await A.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await A.mouse.down();
  const c = await (await A.$('#mk-canvas')).boundingBox();
  await A.mouse.move(c.x + toX * (c.width / 1200), c.y + toY * (c.height / 760), { steps: 8 }); await A.mouse.up();
};
await A.click('[data-tool="crop"]');
if (await A.$eval('#mk-apply', (b) => !b.disabled)) throw new Error('apply should wait for a change');
await dragSE(1000, 700);
await A.screenshot({ path: `${OUT}/75-crop.png` });
await A.click('#mk-apply');
const cw = await A.$eval('#mk-canvas', (c) => [c.width, c.height]);
if (Math.abs(cw[0] - 1000) > 15 || Math.abs(cw[1] - 700) > 15) throw new Error('crop size ' + cw);
await A.click('#mk-undo');
if (await A.$eval('#mk-canvas', (c) => c.width) !== 1200) throw new Error('undo crop');
await A.click('[data-tool="crop"]');
await dragSE(1000, 700);
await A.click('#mk-save');
await A.waitForSelector('.toast >> text=deleted from every device');
await A.waitForFunction((id) => !document.querySelector(`.ri[data-id="${id}"]`) && document.querySelectorAll('.ri').length === 2 && !document.querySelector('.ri .progress'), origId, { timeout: 20000 });
const newId = await A.$eval('.ri:has(.ri-thumb img)', (n) => n.dataset.id);
const order = await A.$$eval('.ri', (n) => n.map((x) => x.dataset.id));
if (order[1] !== newId) throw new Error('replaced photo should keep its place (older than the text)');
step('Cover box + pen + undo + crop (apply, undo, re-crop, save) → replaces the photo in place');

// 4) the phone sees only the edited photo, and its pixels really are covered
await B.waitForFunction((ids) => !document.querySelector(`.ri[data-id="${ids[0]}"]`) && !!document.querySelector(`.ri[data-id="${ids[1]}"] .ri-thumb img`), [origId, newId], { timeout: 20000 });
await B.click(`.ri[data-id="${newId}"] .ri-thumb`);
await B.waitForSelector('#dlg-viewer[open] #viewer-body img');
const src = await B.$eval('#viewer-body img', (i) => i.src);
const check = await B.evaluate(async ([u, oldId, nid]) => {
  const r = await fetch(u);
  const b = await r.blob();
  const bm = await createImageBitmap(b);
  const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext('2d'); x.drawImage(bm, 0, 0);
  const at = (X, Y) => [...x.getImageData(X, Y, 1, 1).data].slice(0, 3);
  const old = await fetch(u.replace(nid, oldId));
  return { type: b.type, w: bm.width, box: at(400, 400), cvv: at(800, 545), corner: at(150, 110), old: old.status };
}, [src, origId, newId]);
console.log('  saved image:', JSON.stringify(check));
if (check.box.some((v) => v > 30)) throw new Error('box area not black');
if (!(check.cvv[0] > 180 && check.cvv[1] < 110)) throw new Error('pen area not red');
if (check.corner[2] < 100) throw new Error('undone stroke still there');
if (check.type !== 'image/jpeg' || Math.abs(check.w - 1000) > 15) throw new Error('type/size wrong: ' + check.w);
if (check.old < 400) throw new Error('original still downloadable: ' + check.old);
await B.keyboard.press('Escape');
step(`Phone: only the edited photo, cropped to ${check.w}px; number black, CVV scribbled, undone stroke gone; original → ${check.old}`);

// 5) viewer has an "Edit" button; "keep original" makes a copy
await A.click(`.ri[data-id="${newId}"] .ri-thumb`);
await A.waitForSelector('#dlg-viewer[open] #viewer-markup:not([hidden])');
await A.click('#viewer-markup');
await A.waitForSelector('#dlg-markup[open]');
await A.waitForTimeout(150);
const cv2 = await (await A.$('#mk-canvas')).boundingBox();
await A.mouse.move(cv2.x + 20, cv2.y + 20); await A.mouse.down(); await A.mouse.move(cv2.x + 120, cv2.y + 80, { steps: 4 }); await A.mouse.up();
await A.check('#mk-keep');
await A.click('#mk-save');
await A.waitForSelector('.toast >> text=new copy');
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 3 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
if (await A.$('#dlg-viewer[open]')) throw new Error('viewer should close');
step('Viewer “Edit” + “Keep the original too” → a new copy, original kept');

// 6) right-click a folder in the sidebar, and a note in the list
await A.waitForSelector('.toast', { state: 'detached', timeout: 10000 }).catch(() => {});
await A.mouse.click(fb.x + 40, fb.y + fb.height - 40, { button: 'right' });
await A.click('#menu button:has-text("New folder")');
await A.fill('#prompt-input', 'Bank');
await A.press('#prompt-input', 'Enter');
await A.click('.nav-item[data-view="home"]');
await A.click('.nav-item[data-folder-drop]', { button: 'right' });
const fitems = await A.$$eval('#menu button', (b) => b.map((x) => x.textContent.trim()));
if (!fitems.includes('Rename folder') || !fitems.includes('Open')) throw new Error('folder menu: ' + fitems);
await A.keyboard.press('Escape');
await A.click('.tab[data-tab="notes"]');
await A.click('#btn-new-note').catch(() => {});
await A.waitForTimeout(300);
await A.keyboard.type('Shopping list');
await A.waitForSelector('.note-item');
await A.click('.note-item', { button: 'right' });
const nitems = await A.$$eval('#menu button', (b) => b.map((x) => x.textContent.trim()));
if (!nitems.includes('Pin to top') || !nitems.includes('Move to Trash')) throw new Error('note menu: ' + nitems);
await A.click('#menu button:has-text("Pin to top")');
await A.waitForSelector('.note-item .t svg');
step('Right-click a folder → Open / Rename / Delete; right-click a note → Pin works');

// 7) Shift + right-click keeps the browser menu (we must not cancel the event)
const prevented = await A.evaluate(() => {
  const n = document.querySelector('.note-item');
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true });
  n.dispatchEvent(ev);
  return ev.defaultPrevented;
});
if (prevented) throw new Error('shift right-click was blocked');
step('Shift + right-click still opens the normal browser menu');

await B.screenshot({ path: `${OUT}/72-phone-after-markup.png` });
const real = errors.filter((e) => !/404 \(Not Found\)/.test(e)); // the test itself requests the deleted original
if (real.length) { console.log(real); throw new Error('console errors'); }
await browser.close();
console.log('ALL OK');
