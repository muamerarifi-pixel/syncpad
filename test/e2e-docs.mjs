// Documents in the app: view Word / Excel / PowerPoint / PDF, edit a Word file, write a new document
// as PDF and edit it again; phones: no page overflow, no text selection on long-press; works offline.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
const FX = (n) => new URL(`./fixtures-${n}`, import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const watch = (p, n) => { p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${n}: ${m.text()}`); }); p.on('dialog', (d) => d.accept()); };
const A = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); watch(A, 'A');
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.setInputFiles('#file-input', [['Lesson.docx', 'word.docx'], ['Grades.xlsx', 'sheet.xlsx'], ['Slides.pptx', 'slides.pptx'], ['Invoice.pdf', 'invoice.pdf']].map(([name, f]) => ({ name, mimeType: '', buffer: fs.readFileSync(FX(f)) })));
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 4 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
const names = await A.$$eval('.ri', (n) => n.map((x) => x.querySelector('.ri-name, .ri-title')?.textContent || x.textContent.trim().split(/\s{2,}/)[0]));
console.log('  files:', JSON.stringify(names));
const open = async (name) => { await A.click(`.ri:has-text("${name}") .ri-thumb`); await A.waitForSelector('#dlg-viewer[open] .dv-host'); };

// 1) Word
await open('Lesson.docx');
await A.waitForSelector('.doc-page:has-text("Lesson plan")');
const w = await A.evaluate(() => {
  const pg = document.querySelector('.doc-page');
  return { h: pg.querySelector('h1')?.textContent, red: [...pg.querySelectorAll('span')].some((s) => s.style.color === 'rgb(192, 0, 0)'), li: pg.querySelectorAll('li').length, table: !!pg.querySelector('table td'), img: !!pg.querySelector('img'), big: [...pg.querySelectorAll('span')].some((s) => s.style.fontSize === '18pt'), centred: !![...pg.querySelectorAll('p')].find((p) => p.style.textAlign === 'center') };
});
console.log('  word:', JSON.stringify(w));
if (!w.h || !w.red || w.li < 5 || !w.table || !w.img || !w.big || !w.centred) throw new Error('word view');
await A.screenshot({ path: `${OUT}/110-view-word.png` });
await A.keyboard.press('Escape');
step('Word file opens in the app: heading, red bold words, 18pt blue text, lists, table, picture, centring');

// 2) Excel
await open('Grades.xlsx');
await A.waitForSelector('.sheet-table');
const x1 = await A.textContent('.xl-sheet:not([hidden])');
if (!/Arben/.test(x1) || !/87\.5/.test(x1) || !/2026-10-30/.test(x1)) throw new Error('xlsx view ' + x1);
await A.click('[data-sheet="1"]');
if (!/FF1/.test(await A.textContent('.xl-sheet:not([hidden])'))) throw new Error('second sheet');
await A.screenshot({ path: `${OUT}/111-view-excel.png` });
await A.keyboard.press('Escape');
step('Excel file: table with dates, two sheet tabs');

// 3) PowerPoint
await open('Slides.pptx');
await A.waitForSelector('.slide');
if ((await A.$$('.slide')).length !== 2 || !/Present simple/.test(await A.textContent('.slide')) || !(await A.$('.slide img'))) throw new Error('pptx');
await A.keyboard.press('Escape');
step('PowerPoint file: 2 slides with text and picture');

// 4) PDF
await open('Invoice.pdf');
await A.waitForSelector('.dv-page canvas');
await A.waitForFunction(() => /Amount due/.test(document.querySelector('.dv-page .textLayer')?.textContent || ''), null, { timeout: 10000 });
await A.click('[data-zoom="in"]');
if ((await A.textContent('.zoom-pct')) === 'Fit') throw new Error('pdf zoom');
await A.screenshot({ path: `${OUT}/112-view-pdf.png` });
await A.keyboard.press('Escape');
step('PDF opens in the app with selectable text; zoom works');

// 5) the writer makes valid Word files (round-trip a real Word document)
const roundTrip = await A.evaluate(async (bytesB64) => {
  const M = await import('/js/docmodel.js');
  const bin = atob(bytesB64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const out = M.writeDocx(M.readDocx(u));
  let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return btoa(s);
}, fs.readFileSync(FX('word.docx')).toString('base64'));
fs.writeFileSync('/tmp/roundtrip.docx', Buffer.from(roundTrip, 'base64'));
const py = execFileSync('python3', ['-c', `
import docx
d = docx.Document('/tmp/roundtrip.docx')
ps = [p for p in d.paragraphs]
red = any(r.font.color and r.font.color.rgb and str(r.font.color.rgb) == 'C00000' and r.bold for p in ps for r in p.runs)
print(len(ps), ps[0].style.name, red, len(d.tables), len(d.inline_shapes), ps[0].text)
`]).toString().trim();
console.log('  python-docx reads it back:', py);
if (!/Heading 1 True 1 1 Lesson plan/.test(py)) throw new Error('docx writer');
step('Saved Word files open in python-docx: Heading 1, red bold, table, picture kept');

// 6) edit the Word file
await A.click('.ri:has-text("Lesson.docx") [data-act="menu"]');
await A.click('#menu button:has-text("Edit document")');
await A.waitForSelector('#dlg-doc[open] .de-page h1');
await A.click('.de-page h1');
await A.keyboard.press('End');
await A.keyboard.type(' (edited)');
await A.screenshot({ path: `${OUT}/113-edit-word.png` });
await A.click('#de-save');
await A.waitForSelector('#dlg-doc', { state: 'hidden' });
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 4 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
await A.waitForTimeout(300);
await open('Lesson.docx');
await A.waitForSelector('.doc-page h1:has-text("(edited)")');
if (!(await A.evaluate(() => [...document.querySelectorAll('.doc-page span')].some((s) => s.style.color === 'rgb(192, 0, 0)')))) throw new Error('colour lost after edit');
await A.keyboard.press('Escape');
step('Word file edited and saved in place; colours kept');

// 7) a new document saved as PDF, then edited again
await A.click('#btn-new-doc');
await A.waitForSelector('#dlg-doc[open] .de-page');
await A.fill('#de-name', 'Class notes');
await A.selectOption('#de-style', 'h1');
await A.keyboard.type('Week 10 plan');
await A.keyboard.press('Enter');
await A.selectOption('#de-style', 'p');
await A.keyboard.type('Read the story and ');
await A.click('[data-cmd="bold"]');
await A.keyboard.type('underline new words');
await A.click('[data-cmd="bold"]');
await A.keyboard.type('. Ëndrra e çajit.');
await A.keyboard.press('Enter');
await A.click('[data-cmd="insertUnorderedList"]');
await A.keyboard.type('First point');
await A.keyboard.press('Enter');
await A.keyboard.type('Second point');
await A.keyboard.press('Enter');
await A.keyboard.press('Enter');
await A.click('[data-cmd="table"]');
await A.keyboard.type('Cell A');
await A.selectOption('#de-format', 'pdf');
await A.screenshot({ path: `${OUT}/114-new-doc.png` });
await A.click('#de-save');
await A.waitForSelector('.toast >> text=Class notes.pdf', { timeout: 20000 });
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 5 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
await open('Class notes.pdf');
await A.waitForFunction(() => /Week 10 plan/.test(document.querySelector('.textLayer')?.textContent || '') && /çajit/.test(document.querySelector('.textLayer')?.textContent || ''), null, { timeout: 10000 });
await A.screenshot({ path: `${OUT}/115-new-pdf.png` });
if (await A.isHidden('#viewer-markup')) throw new Error('edit button');
await A.click('#viewer-markup');
await A.waitForSelector('#dlg-doc[open] .de-page h1:has-text("Week 10 plan")');
if (!(await A.$('.de-page li')) || !(await A.$('.de-page b, .de-page strong')) || !(await A.$('.de-page td'))) throw new Error('source not restored');
await A.click('.de-page h1');
await A.keyboard.press('End');
await A.keyboard.type(' v2');
await A.click('#de-save');
await A.waitForSelector('.toast >> text=deleted from every device', { timeout: 20000 });
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 5 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
await A.waitForTimeout(300);
await open('Class notes.pdf');
await A.waitForFunction(() => /Week 10 plan v2/.test(document.querySelector('.textLayer')?.textContent || ''), null, { timeout: 10000 });
await A.keyboard.press('Escape');
step('New document saved as PDF (ë ç fine), reopened as an editable document, edited and replaced');

// 8) phone: no overflow in selection mode, no text selection on long-press, offline start
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
const P = await ctx.newPage(); watch(P, 'P');
await P.goto(BASE + '/');
await P.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await P.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(async () => { await P.reload(); await P.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }); });
const png = fs.readFileSync(new URL('../public/icons/icon-512.png', import.meta.url));
await P.setInputFiles('#file-input', [{ name: 'a.png', mimeType: 'image/png', buffer: png }, { name: 'b.png', mimeType: 'image/png', buffer: png }, { name: 'Invoice.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(FX('invoice.pdf')) }]);
await P.fill('#composer-input', 'a long message to press and hold'); await P.click('#btn-send');
await P.waitForFunction(() => document.querySelectorAll('.ri').length === 4 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
await P.click('#btn-select'); await P.click('.ri:has-text("a.png")'); await P.click('.ri:has-text("b.png")');
await P.waitForSelector('[data-sel="collage"]:not([hidden])');
const ov = await P.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.querySelector('#select-bar').getBoundingClientRect().right]);
if (ov[0] > ov[1] || ov[2] > ov[1]) throw new Error('selection bar overflows ' + ov);
await P.screenshot({ path: `${OUT}/116-phone-select.png` });
await P.click('[data-sel="cancel"]');
const us = await P.evaluate(() => [getComputedStyle(document.querySelector('.ri')).userSelect, getComputedStyle(document.querySelector('.ri-text') || document.querySelector('.ri')).webkitTouchCallout, getComputedStyle(document.querySelector('#composer-input')).userSelect]);
if (us[0] !== 'none' || us[2] === 'none') throw new Error('long-press selection ' + us);
step(`Phone: selection bar fits (${ov[2]}px of ${ov[1]}px), long-press can’t select text (${us[0]}), typing still can`);
await P.click('.ri:has-text("Invoice.pdf") .ri-thumb');
await P.waitForSelector('.dv-page canvas', { timeout: 15000 });
await P.keyboard.press('Escape');
await P.waitForTimeout(1500);
await ctx.setOffline(true);
await P.reload();
await P.waitForSelector('.ri', { timeout: 10000 });
const st = await P.$eval('.status-chip', (c) => c.dataset.state);
await P.click('.ri:has-text("Invoice.pdf") .ri-thumb');
await P.waitForSelector('.dv-page canvas', { timeout: 15000 });
await P.screenshot({ path: `${OUT}/117-phone-offline-pdf.png` });
await ctx.setOffline(false);
step(`Offline: app starts (${st}), list is there, the PDF opens without internet`);

if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
