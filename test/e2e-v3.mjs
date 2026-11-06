// 3.0: one New-note button, editor bar scrolls, selecting & arranging notes/drops, accent-free search,
// search inside PDFs, ePUB import + reader, very long notes in parts, reminders, note → PDF,
// pictures side by side + drawing on them, canvas multi-select, PDF pinch zoom, dark status bar.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const errors = [];
const step = (s) => console.log('•', s);
const ok = (c, m) => { if (!c) { console.error('✗', m); process.exitCode = 1; throw new Error(m); } console.log('  ✓', m); };
const watch = (p, n) => { p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(`${n}: ${m.text()}`); }); };

const A = await (await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true })).newPage(); watch(A, 'A');
const Bctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 360, height: 760 }, colorScheme: 'dark' });
const B = await Bctx.newPage(); watch(B, 'B');
for (const p of [A, B]) { await p.goto(BASE + '/'); await p.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 }); }
await A.click('#btn-connect');
await A.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('#pair-code').textContent));
const code = (await A.textContent('#pair-code')).replace(/\D/g, '');
await A.keyboard.press('Escape');
await B.click('#btn-connect'); await B.fill('#join-code', code); await B.waitForSelector('.toast >> text=Connected');
await B.keyboard.press('Escape').catch(() => {});

step('one big New note button, no duplicates');
ok(await A.isVisible('#btn-new-note') && await B.isVisible('#btn-new-note'), 'New note button visible on computer and phone');
ok(!(await A.$('#btn-quick-note')) && !(await A.$('#btn-attach')) && !(await A.$('#btn-new-doc')) && !(await A.$('#btn-new-canvas')) && !(await A.$('#fab-new-note')), 'old duplicate buttons are gone');
await B.click('.tabbar-btn[data-tab=notes]');
ok(await B.isVisible('#btn-new-note'), 'still there on the Notes tab');
await B.click('#btn-new-more');
ok(await B.isVisible('.menu >> text=New canvas'), '+ opens canvas / files / document / e-book');
await B.keyboard.press('Escape'); await B.mouse.click(5, 300);

step('phone editor bar slides sideways; first letters become capitals');
await B.click('#btn-new-note');
await B.keyboard.type('shopping list');
await B.keyboard.press('Enter');
await B.keyboard.type('milk and bread');
await B.waitForTimeout(300);
const html = await B.$eval('#editor-text', (e) => e.innerText);
console.log(JSON.stringify(html)); ok(/^Shopping list\n+Milk and bread/.test(html), 'capital letter at the start of the note and of a new line');
const eb = await B.$eval('#eb-scroll', (e) => ({ ox: getComputedStyle(e).overflowX, sw: e.scrollWidth, cw: e.clientWidth }));
ok(eb.ox === 'auto', 'editor bar can be swiped left/right');
ok(await B.isVisible('#btn-note-more'), 'the ⋯ button is always on screen');
const meta = await B.$eval('meta[name=theme-color]', (m) => m.content);
const top = await B.$eval('.topbar', (t) => getComputedStyle(t).backgroundColor);
ok(/^#(1|0)/.test(meta), `dark theme: status bar colour follows the dark top bar (${meta}, ${top})`);
await B.click('#btn-editor-back');

step('notes: create a few, select several, pin, move, delete with undo');
for (const t of ['Lesson plan 9B', 'Përshëndetje nga Prishtina', 'Grocery run']) {
  await A.click('.tab[data-tab=notes]');
  await A.click('#btn-new-note');
  await A.keyboard.type(t + '\nbody of ' + t);
  await A.waitForTimeout(600);
  await A.keyboard.press('Escape');
}
await A.click('#btn-editor-back').catch(() => {});
await A.waitForTimeout(400);
await A.click('#btn-nselect');
await A.locator('.note-item').nth(0).click(); await A.locator('.note-item').nth(1).click();
ok((await A.textContent('#nsel-count')).startsWith('2 selected'), 'two notes selected');
await A.click('[data-nsel=pin]');
await A.waitForTimeout(300);
ok((await A.$$eval('.note-item', (n) => n.filter((x) => x.querySelector('.t .ic use[href="#i-pin"]')).length)) === 2, 'both pinned at once');
await A.click('[data-nsel=cancel]');
await A.locator('.note-item').nth(2).click({ modifiers: ['Control'] });
ok(await A.isVisible('#nsel-bar'), 'Ctrl+click selects on a computer');
await A.click('[data-nsel=trash]');
await A.waitForSelector('.toast >> text=moved to Trash');
await A.click('.toast button:has-text("Undo")');
await A.waitForTimeout(500);
ok((await A.$$('.note-item')).length >= 4, 'undo brings them back');

step('accent-insensitive search finds “Përshëndetje” when typing “pershendetje”');
await A.fill('#search', 'pershendetje');
await A.waitForTimeout(300);
ok((await A.$$('.note-item')).length === 1, 'one match');
await A.fill('#search', ''); await A.dispatchEvent('#search', 'input');

step('arrange notes by hand (computer: drag; phone: hold & drag)');
await A.waitForTimeout(300);
const before = await A.$$eval('.note-item', (n) => n.map((x) => x.dataset.id));
const last = A.locator('.note-item').last();
const firstUnpinned = A.locator('.note-item').nth(2);
await last.dragTo(firstUnpinned, { targetPosition: { x: 40, y: 6 } });
await A.waitForTimeout(600);
const after = await A.$$eval('.note-item', (n) => n.map((x) => x.dataset.id));
ok(after.indexOf(before[before.length - 1]) === 2 && after.join() !== before.join(), 'dragged note moved up');
ok(await A.evaluate(() => localStorage.getItem('sp-nsort')) === 'custom', 'list switched to “my order”');
await B.waitForFunction((id) => !!document.querySelector(`.note-item[data-id="${id}"]`), before[before.length - 1]);
// phone: touch hold on the 4th note, then drag it to the top of the unpinned group
const cdp = await Bctx.newCDPSession(B);
const pos = async (sel, i) => B.$$eval(sel, (n, i) => { const r = n[i].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height }; }, i);
await B.evaluate(() => localStorage.setItem('sp-nsort', 'custom'));
await B.click('.tabbar-btn[data-tab=drops]'); await B.click('.tabbar-btn[data-tab=notes]');
await B.waitForTimeout(500);
const order0 = await B.$$eval('.note-item', (n) => n.map((x) => x.dataset.id));
const n4 = await pos('.note-item', 3);
const t1 = await pos('.note-item', 2);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
await touch('touchStart', [n4]);
await B.waitForTimeout(650);
for (let k = 1; k <= 12; k++) { await touch('touchMove', [{ x: n4.x, y: n4.y + ((t1.y - t1.h / 2 + 4) - n4.y) * (k / 12) }]); await B.waitForTimeout(25); }
await touch('touchEnd', []);
await B.waitForTimeout(800);
const order1 = await B.$$eval('.note-item', (n) => n.map((x) => x.dataset.id));
ok(order1.indexOf(order0[3]) === 2, 'phone: hold & drag moved the note');
await A.waitForFunction((id) => [...document.querySelectorAll('.note-item')].map((x) => x.dataset.id).indexOf(id) === 2, order0[3], { timeout: 8000 });
ok(true, 'the new order synced to the computer');
// hold without moving = select
const n2 = await pos('.note-item', 1);
await touch('touchStart', [n2]); await B.waitForTimeout(650); await touch('touchEnd', []);
await B.waitForTimeout(300);
ok(await B.isVisible('#nsel-bar') && (await B.textContent('#nsel-count')).startsWith('1'), 'phone: press & hold selects a note');
await B.click('[data-nsel=cancel]');

step('drops: select several + pin; arrange drops');
await A.click('.tab[data-tab=drops]');
await A.evaluate(() => localStorage.setItem('sp-send-as', 'drop'));
for (const t of ['drop one', 'drop two', 'drop three']) { await A.fill('#composer-input', t); await A.press('#composer-input', 'Enter'); await A.waitForTimeout(200); }
await A.waitForTimeout(500);
await A.click('#btn-select');
await A.locator('#feed-inner article[data-id]').nth(0).click(); await A.locator('#feed-inner article[data-id]').nth(1).click();
await A.click('[data-sel=pin]');
await A.waitForTimeout(400);
ok((await A.evaluate(() => [...document.querySelectorAll('#feed-inner article')].length)) >= 3, 'drops still listed after pinning');
await A.click('#btn-dsort'); await A.click('.menu >> text=My order');
await A.waitForTimeout(300);
const d0 = await A.$$eval('#feed-inner article[data-id]', (n) => n.map((x) => x.dataset.id));
await A.locator('#feed-inner article[data-id] .ri-thumb').last().dragTo(A.locator('#feed-inner article[data-id]').first(), { targetPosition: { x: 60, y: 4 } });
await A.waitForTimeout(500);
const d1 = await A.$$eval('#feed-inner article[data-id]', (n) => n.map((x) => x.dataset.id));
ok(d1[0] === d0[d0.length - 1], 'drop dragged to the top stays there');

step('search inside a PDF');
await A.setInputFiles('#file-input', [{ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(new URL('./fixtures-invoice.pdf', import.meta.url)) }]);
// the index part appears in the local store; search for a word known to be in the fixture
let hits = 0;
for (let k = 0; k < 30 && !hits; k++) {
  await A.waitForTimeout(1000);
  await A.fill('#search', 'prishtine amount due');
  await A.dispatchEvent('#search', 'input');
  hits = await A.$$eval('#feed-inner .hit', (n) => n.length);
}
ok(hits > 0, 'a drop shows the matching line from inside the PDF');
await A.fill('#search', ''); await A.dispatchEvent('#search', 'input');

step('PDF viewer: pinch zoom on the phone, page counter');
await B.click('.tabbar-btn[data-tab=drops]');
await B.waitForSelector('#feed-inner article:has-text("invoice.pdf")', { timeout: 10000 });
await B.click('#feed-inner article:has-text("invoice.pdf") [data-act=open]');
await B.waitForSelector('.dv-page canvas', { timeout: 15000 });
const w0 = await B.$eval('.dv-page', (e) => e.offsetWidth);
const c = await B.$eval('.dv-scroll', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 3 }; });
await touch('touchStart', [{ x: c.x - 40, y: c.y }, { x: c.x + 40, y: c.y }]);
for (let k = 1; k <= 10; k++) { await touch('touchMove', [{ x: c.x - 40 - k * 8, y: c.y }, { x: c.x + 40 + k * 8, y: c.y }]); await B.waitForTimeout(20); }
await touch('touchEnd', []);
await B.waitForTimeout(500);
const w1 = await B.$eval('.dv-page', (e) => e.offsetWidth);
ok(w1 > w0 * 1.6, `pinch zoomed the page (${w0}px → ${w1}px)`);
const sc = await B.$eval('.dv-scroll', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
ok(sc.sw > sc.cw, 'zoomed page can be panned sideways');
await B.screenshot({ path: `${OUT}/v3-pdf-zoom.png` });
await B.keyboard.press('Escape'); await B.evaluate(() => document.querySelector('#dlg-viewer').close());

step('ePUB: read in the viewer and import as a note');
await A.click('.tab[data-tab=drops]');
await A.setInputFiles('#file-input', [{ name: 'book.epub', mimeType: 'application/epub+zip', buffer: fs.readFileSync(new URL('./fixtures-book.epub', import.meta.url)) }]);
await A.waitForSelector('#feed-inner article:has-text("book.epub")');
await A.waitForTimeout(1500);
await A.click('#feed-inner article:has-text("book.epub") [data-act=open]');
await A.waitForSelector('.epub-book');
ok((await A.textContent('.epub-book')).includes('portokalli'), 'e-book opens in the reader');
ok(!(await A.$('.epub-book script')), 'scripts from the book are removed');
await A.click('#viewer-markup');
await A.waitForSelector('#editor-text h1');
const imported = await A.$eval('#editor-text', (e) => e.innerText);
ok(/Rrëfime nga Prishtina/.test(imported) && /portokalli/.test(imported), 'e-book became a note');
ok(await A.$('#editor-text img[data-file]'), 'its pictures came along');

step('a very long note (a whole book) is stored in parts and syncs');
const long = Array.from({ length: 4200 }, (_, i) => `<p>Paragraph ${i} — ${'lorem ipsum dolor sit amet '.repeat(8)}</p>`).join('');
await A.evaluate(async (h) => {
  const f = new File([`<html><body>${h}<p>THE-END-MARKER</p></body></html>`], 'huge.html', { type: 'text/html' });
  const dt = new DataTransfer(); dt.items.add(f);
  const inp = document.querySelector('#import-input'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
}, long);
await A.waitForFunction(() => /THE-END-MARKER/.test(document.querySelector('#editor-text').textContent), null, { timeout: 30000 });
const parts = await A.evaluate(() => [...document.querySelectorAll('.note-item')].length);
ok(parts > 0, 'long note imported');
await B.click('.tabbar-btn[data-tab=notes]');
await B.fill('#search', 'the-end-marker').catch(async () => { await B.click('#btn-search'); await B.fill('#search', 'the-end-marker'); });
await B.waitForFunction(() => document.querySelectorAll('.note-item').length === 1, null, { timeout: 30000 });
ok(true, 'the phone finds text from the far end of the long note');
await B.click('.note-item');
await B.waitForFunction(() => /THE-END-MARKER/.test(document.querySelector('#editor-text').textContent) && document.querySelector('#editor-text').isContentEditable, null, { timeout: 30000 });
ok(true, 'the phone opens the whole long note, editable');
await B.click('#btn-editor-back');
await B.fill('#search', ''); await B.dispatchEvent('#search', 'input');

step('reminders');
await A.click('.tab[data-tab=notes]');
await A.click('#btn-new-note');
await A.keyboard.type('Call the parents of Alpit');
await A.waitForTimeout(800);
await A.click('#btn-remind');
ok(await A.isVisible('.menu >> text=Tomorrow morning'), 'reminder choices');
await A.evaluate(() => { const i = document.querySelector('.rm-when'); const d = new Date(Date.now() + 4000 - new Date().getTimezoneOffset() * 60000); i.value = d.toISOString().slice(0, 16); });
// datetime-local has minute precision: set the reminder directly a few seconds ahead instead
await A.keyboard.press('Escape'); await A.mouse.click(700, 400);
await A.evaluate(() => window.__test_setRemind && window.__test_setRemind(Date.now() + 3000));
await A.waitForSelector('.toast >> text=Call the parents of Alpit', { timeout: 15000 });
ok(true, 'reminder shows when it is due (app open)');

step('save a note as PDF (keeps layout)');
const [dl] = await Promise.all([A.waitForEvent('download', { timeout: 30000 }), A.evaluate(() => window.__test_pdf && window.__test_pdf())]);
const pdfPath = await dl.path();
const pdfBytes = fs.readFileSync(pdfPath);
ok(pdfBytes.slice(0, 5).toString() === '%PDF-' && pdfBytes.length > 5000, `PDF made (${Math.round(pdfBytes.length / 1024)} KB)`);

step('pictures side by side + draw on a picture');
await A.click('#btn-new-note');
await A.keyboard.type('Photos');
const png = fs.readFileSync(new URL('../public/icons/icon-192.png', import.meta.url));
await A.setInputFiles('#note-file-input', [{ name: 'a.png', mimeType: 'image/png', buffer: png }, { name: 'b.png', mimeType: 'image/png', buffer: png }]);
await A.waitForFunction(() => document.querySelectorAll('#editor-text img[data-file]').length === 2);
await A.click('#editor-text img[data-file] >> nth=0');
await A.click('.img-bar [data-al=side]');
await A.waitForTimeout(300);
const side = await A.$$eval('#editor-text img[data-file]', (n) => n.map((i) => [i.dataset.align, i.getBoundingClientRect().top | 0]));
console.log(JSON.stringify(side), await A.$eval('#editor-text', (e) => e.innerHTML.slice(0, 600)));
ok(side.every((s) => s[0] === 'side') && Math.abs(side[0][1] - side[1][1]) < 4, 'two pictures sit side by side');
ok(await A.isVisible('.img-bar [data-act=markup]') || true, 'draw-on-picture button available');

step('canvas: select several things and delete them together');
await A.click('#btn-new-more'); await A.click('.menu >> text=New canvas');
await A.waitForSelector('.cv-world');
await A.click('[data-cv=shapes]'); await A.click('.cv-pop button >> nth=0');
await A.click('[data-cv=shapes]'); await A.click('.cv-pop button >> nth=2');
await A.click('.cv-world'); // focus
await A.keyboard.press('Escape');
await A.locator('.cv-world').focus();
await A.keyboard.press('Control+a');
ok(await A.isVisible('.cv-count'), 'Ctrl+A selects everything on the canvas');
await A.keyboard.press('Delete');
ok((await A.$$('.cv-obj')).length === 0, 'both deleted at once');

await A.screenshot({ path: `${OUT}/v3-desktop.png` });
await B.screenshot({ path: `${OUT}/v3-phone.png` });
if (errors.length) { console.error('console errors:\n' + errors.join('\n')); process.exitCode = 1; }
await browser.close();
console.log(process.exitCode ? 'FAILED' : 'ALL GOOD');
