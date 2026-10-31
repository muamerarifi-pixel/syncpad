// 2.16: notes list (grid, size, sort, colours, folders by drag, swipe to Trash), fonts, sepia paper,
// text case, quick new note, file chips, canvas (text tool, drop at cursor, file cards, layout kept, PNG/PDF export).
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const watch = (p, n) => { p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${n}: ${m.text()}`); }); p.on('dialog', (d) => d.accept()); };
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const A = await ctx.newPage(); watch(A, 'A');
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
const png = fs.readFileSync(new URL('../public/icons/icon-512.png', import.meta.url));

// quick new note from the Drops screen
const chipW = await A.$eval('.status-chip', (c) => c.getBoundingClientRect().width);
if (chipW > 40) throw new Error('status chip still wide ' + chipW);
await A.click('#btn-quick-note');
await A.waitForSelector('#editor-text:focus');
await A.keyboard.type('zebra notes');
await A.keyboard.press('Enter');
await A.keyboard.type('hello world. this is fine');
step(`Quick “new note” button works from Drops; sync status is a small dot (${chipW}px)`);

// text case: one click each
await A.keyboard.press('Shift+Home');
const cases = [];
for (let k = 0; k < 3; k++) { await A.click('[data-fmt="case"]'); cases.push(await A.$eval('#editor-text > :last-child', (p) => p.textContent)); }
if (cases.join('|') !== 'Hello world. This is fine|HELLO WORLD. THIS IS FINE|hello world. this is fine') throw new Error('case ' + cases.join('|'));
step('Aa: Sentence case → UPPERCASE → lowercase, one click each');

// font, paper, colour from ⋯
const pick = async (menu, label) => { await A.click('#btn-note-more'); await A.click(`.menu button:has-text("${menu}")`); await A.click(`.menu button:has-text("${label}")`); };
await pick('Font…', 'Lora');
await pick('Paper…', 'Sepia, lined');
await pick('Colour…', 'Blue');
const look = await A.$eval('#editor', (e) => ({ f: getComputedStyle(e.querySelector('.editor-text')).fontFamily, bg: getComputedStyle(e).backgroundColor, c: e.dataset.color }));
if (!/Lora/.test(look.f) || look.bg !== 'rgb(244, 236, 216)' || look.c !== 'blue') throw new Error('look ' + JSON.stringify(look));
await A.waitForSelector('.note-item[data-color="blue"]');
await A.waitForFunction(() => document.fonts.check('16px Lora'));
await A.screenshot({ path: `${OUT}/150-lora-sepia.png` });
step('Font Lora, sepia lined paper and a blue colour tag — the list shows the colour');

// more notes, sort + grid + size
for (const t of ['apple pie', 'mango list']) { await A.click('#btn-new-note'); await A.keyboard.type(t); await A.waitForTimeout(600); }
await A.click('#btn-notes-view'); await A.click('.menu button:has-text("Sort: title A–Z")');
let titles = await A.$$eval('.note-item .t span', (l) => l.map((s) => s.textContent));
if (titles.join(',') !== 'apple pie,mango list,zebra notes') throw new Error('sort ' + titles);
await A.click('#btn-notes-view'); await A.click('.menu button:has-text("Grid")');
await A.click('#btn-notes-view'); await A.click('.menu button:has-text("Size: large")');
if (!(await A.$eval('#note-list', (l) => l.classList.contains('view-grid') && l.classList.contains('size-l')))) throw new Error('grid');
await A.screenshot({ path: `${OUT}/151-notes-grid.png` });
step('Sort by title, grid view, large cards');

// folders: create, drag a note onto it, filter
await A.click('[data-nf="+new"]');
await A.fill('#prompt-input', 'Class 9B');
await A.keyboard.press('Enter');
await A.waitForSelector('.nf-chips .chip:has-text("Class 9B")');
await A.dragAndDrop('.note-item:has-text("mango list")', '.nf-chips .chip:has-text("Class 9B")');
await A.waitForSelector('.toast >> text=Moved to “Class 9B”');
await A.click('.nf-chips .chip:has-text("Class 9B")');
titles = await A.$$eval('.note-item .t span', (l) => l.map((s) => s.textContent));
if (titles.join(',') !== 'mango list') throw new Error('folder filter ' + titles);
await A.click('[data-nf="all"]');
step('Notes folder made, a note dragged onto it, the folder shows just that note');
await A.click('#btn-notes-view'); await A.click('.menu button:has-text("List")');

// a file chip in a note: tap → open / move / remove
await A.click('.note-item:has-text("apple pie")');
await A.setInputFiles('#note-file-input', [{ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }]);
await A.waitForSelector('#editor-text a[data-file]');
await A.click('#editor-text a[data-file]');
await A.waitForSelector('.img-bar.is-chip:not([hidden])');
await A.click('.img-bar [data-act="del"]');
if (await A.$('#editor-text a[data-file]')) throw new Error('chip not removed');
step('Files in notes: tap to open, move or remove');

// canvas: text tool places text where you click
await A.click('#btn-new-canvas');
await A.waitForSelector('#note-canvas:not([hidden]) .cv-world');
await A.click('[data-cv="text"]');
const wr = await A.$eval('.cv-world', (w) => { const r = w.getBoundingClientRect(); return { x: r.left, y: r.top, s: r.width / 1000 }; });
await A.mouse.click(wr.x + 600 * wr.s, wr.y + 300 * wr.s);
await A.keyboard.type('Right here');
await A.keyboard.press('Escape');
const tb = await A.$eval('.cv-obj.cv-text', (e) => ({ x: parseFloat(e.style.left), y: parseFloat(e.style.top) }));
if (Math.abs(tb.x - 592) > 3 || Math.abs(tb.y - 280) > 3) throw new Error('text tool place ' + JSON.stringify(tb));
step('Canvas: T then click — the text box starts exactly where you clicked');

// drop a picture and a document at the cursor
const drop = (name, type, data, x, y) => A.evaluate(([name, type, data, x, y]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name, { type }));
  const t = document.elementFromPoint(x, y);
  for (const ev of ['dragenter', 'dragover', 'drop']) t.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
}, [name, type, data, x, y]);
await drop('photo.png', 'image/png', png.toString('base64'), wr.x + 400 * wr.s, wr.y + 700 * wr.s);
await A.waitForSelector('.cv-obj.cv-img');
const ib = await A.$eval('.cv-obj.cv-img', (e) => ({ cx: parseFloat(e.style.left) + parseFloat(e.style.width) / 2, cy: parseFloat(e.style.top) + parseFloat(e.style.height) / 2 }));
if (Math.abs(ib.cx - 400) > 4 || Math.abs(ib.cy - 700) > 4) throw new Error('drop place ' + JSON.stringify(ib));
await drop('report.pdf', 'application/pdf', fs.readFileSync(new URL('./fixtures-invoice.pdf', import.meta.url)).toString('base64'), wr.x + 760 * wr.s, wr.y + 480 * wr.s);
await A.waitForSelector('.cv-obj.cv-file >> text=report.pdf');
await A.dblclick('.cv-obj.cv-file');
await A.waitForSelector('#dlg-viewer[open]');
await A.keyboard.press('Escape');
step('Dropped picture lands where the mouse was let go; a PDF becomes a file card that opens on double-click');

// shape, then canvas → normal → canvas keeps the layout
await A.click('[data-cv="shapes"]'); await A.click('.cv-pop [data-k="star"]');
await A.waitForTimeout(800);
const layout = async () => (await A.$$eval('.cv-obj', (l) => l.map((e) => [e.className.replace(' on', ''), Math.round(parseFloat(e.style.left)), Math.round(parseFloat(e.style.top))].join(':')))).sort().join('|');
const before = await layout();
await A.click('#btn-note-more'); await A.click('.menu button:has-text("Turn into normal note")'); await A.click('#confirm-ok');
await A.waitForSelector('#editor-text:not([hidden])');
await A.click('#btn-note-more'); await A.click('.menu button:has-text("Turn into canvas")');
await A.waitForSelector('#note-canvas:not([hidden]) .cv-obj.cv-shape');
const after = await layout();
if (after !== before) throw new Error('layout lost\n' + before + '\n' + after);
step('Canvas → normal note → canvas: the layout (and the star) come back exactly');

// export PNG + PDF with a crop
await A.click('[data-cv="export"]');
await A.waitForSelector('dialog.cvx[open] .cvx-img');
await A.waitForFunction(() => document.querySelector('.cvx-img').naturalWidth > 0);
const h = await A.locator('.cvx-crop [data-h="e"]').boundingBox();
await A.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await A.mouse.down(); await A.mouse.move(h.x - 60, h.y + h.height / 2, { steps: 4 }); await A.mouse.up();
await A.screenshot({ path: `${OUT}/152-canvas-export.png` });
const [dl] = await Promise.all([A.waitForEvent('download'), A.click('dialog.cvx [data-png]')]);
const pngPath = await dl.path();
const sig = fs.readFileSync(pngPath).subarray(0, 8).toString('hex');
if (sig !== '89504e470d0a1a0a' || fs.statSync(pngPath).size < 5000) throw new Error('png');
await A.click('[data-cv="export"]');
await A.waitForSelector('dialog.cvx[open] .cvx-img');
const [dl2] = await Promise.all([A.waitForEvent('download'), A.click('dialog.cvx [data-pdf]')]);
const pdf = fs.readFileSync(await dl2.path());
if (pdf.subarray(0, 4).toString() !== '%PDF') throw new Error('pdf');
fs.copyFileSync(pngPath, `${OUT}/153-exported.png`);
step(`Canvas saved as PNG (${Math.round(fs.statSync(pngPath).size / 1024)} KB, cropped) and PDF`);

// theme colour for the phone bars
await A.click('#btn-settings'); await A.click('[data-theme-opt="dark"]'); await A.keyboard.press('Escape');
const tc = await A.$$eval('meta[name="theme-color"]', (l) => l.map((m) => m.content + (m.media || '')));
if (tc.some((v) => v !== '#14161c')) throw new Error('theme-color ' + tc);
await A.click('#btn-settings'); await A.click('[data-theme-opt="light"]'); await A.keyboard.press('Escape');
step('Phone status bar colour follows the app theme (light/dark)');

// phone: swipe a note away
const P = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); watch(P, 'P');
await P.goto(BASE + '/');
await P.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.click('#btn-connect');
await A.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('#pair-code').textContent));
const code = (await A.textContent('#pair-code')).replace(/\D/g, '');
await A.keyboard.press('Escape');
await P.click('#btn-connect'); await P.fill('#join-code', code); await P.waitForSelector('.toast >> text=Connected');
await P.click('.tabbar-btn[data-tab="notes"]');
await P.waitForSelector('.note-item:has-text("zebra notes")', { timeout: 10000 });
await P.$eval('.note-item:has-text("zebra notes")', (b) => {
  const r = b.getBoundingClientRect();
  const o = (x) => ({ bubbles: true, pointerId: 9, pointerType: 'touch', clientX: x, clientY: r.top + 20, isPrimary: true });
  b.dispatchEvent(new PointerEvent('pointerdown', o(r.left + 40)));
  for (let x = 60; x <= 320; x += 30) b.dispatchEvent(new PointerEvent('pointermove', o(r.left + x)));
  b.dispatchEvent(new PointerEvent('pointerup', o(r.left + 320)));
});
await P.waitForSelector('.toast >> text=Undo');
await P.waitForFunction(() => ![...document.querySelectorAll('.note-item')].some((b) => /zebra notes/.test(b.textContent)));
await P.screenshot({ path: `${OUT}/154-phone-swipe.png` });
step('Phone: swipe a note sideways → Trash, with Undo');

if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
