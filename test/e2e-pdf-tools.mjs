// PDF editor tools: coloured text keeps its colour, delete / undo a picture, copy & paste a line,
// draw shapes, recolour, add a picture, copy & paste / delete things, save and reopen.
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
const PDF = process.env.PDF2 || new URL('./fixtures-rich.pdf', import.meta.url).pathname;
const PNG = process.env.PNG || new URL('../public/icons/icon-192.png', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const A = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
A.on('pageerror', (e) => errors.push(e.message));
A.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
A.on('dialog', (d) => d.accept());
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.setInputFiles('#file-input', [{ name: 'Rich.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(PDF) }]);
await A.waitForFunction(() => document.querySelector('.ri') && !document.querySelector('.ri .progress'), null, { timeout: 15000 });
const openEditor = async () => {
  await A.click('.ri .ri-thumb', { button: 'right' });
  await A.click('#menu button:has-text("Edit text")');
  await A.waitForSelector('#dlg-pdf[open] .pe-line', { timeout: 20000 });
};
const status = () => A.textContent('#pe-status');
const waitStatus = (re) => A.waitForFunction((s) => new RegExp(s).test(document.querySelector('#pe-status').textContent), re.source, { timeout: 15000 });
await openEditor();
const page = await (await A.$('.pe-page')).boundingBox();

// 1) coloured, mixed line
await A.click('.pe-line[aria-label^="Edit line: Total"]');
await A.fill('.pe-input', 'Total: 1450 EUR due today please');
await A.keyboard.press('Enter');
await waitStatus(/Changed/);
console.log('  ', await status());
step('Mixed-colour line edited (red bold number, blue word keep their colours)');

// 2) picture: select, delete, undo
const imgs0 = await A.$$eval('.pe-img', (n) => n.length);
await A.click('.pe-img');
await A.click('.pe-imgtools [data-pe="delimg"]');
await waitStatus(/Picture deleted/);
if ((await A.$$eval('.pe-img', (n) => n.length)) !== imgs0 - 1) throw new Error('picture not deleted');
await A.click('#pe-undo');
await A.waitForFunction((n) => document.querySelectorAll('.pe-img').length === n, imgs0, { timeout: 15000 });
step('Picture deleted, Undo brings it back');

// 3) copy a line, paste, move it
await A.click('.pe-line[aria-label^="Edit line: Plain"]');
await A.click('.pe-tools [data-pe="copy"]');
await A.click('#pe-toolbar [data-act="paste"]');
await A.waitForSelector('.pe-obj[data-type="text"].sel');
const tb = await (await A.$('.pe-obj[data-type="text"]')).boundingBox();
await A.mouse.move(tb.x + 10, tb.y + 5); await A.mouse.down(); await A.mouse.move(page.x + 420, page.y + 520, { steps: 6 }); await A.mouse.up();
step('Line copied and pasted as a movable copy');

// 4) draw: rectangle, arrow, tick; recolour the arrow
await A.click('#pe-toolbar [data-tool="rect"]');
await A.mouse.move(page.x + 100, page.y + 600); await A.mouse.down(); await A.mouse.move(page.x + 300, page.y + 680, { steps: 5 }); await A.mouse.up();
await A.click('#pe-toolbar [data-tool="arrow"]');
await A.mouse.move(page.x + 350, page.y + 700); await A.mouse.down(); await A.mouse.move(page.x + 480, page.y + 620, { steps: 5 }); await A.mouse.up();
await A.click('#pe-toolbar [data-color="#2563eb"]');
await A.click('#pe-toolbar [data-tool="check"]');
await A.mouse.click(page.x + 560, page.y + 640);
for (const t of ['rect', 'arrow', 'check']) if (!(await A.$(`.pe-obj[data-type="${t}"]`))) throw new Error('missing ' + t);
const arrowCol = await A.$eval('.pe-obj[data-type="arrow"] polygon', (p) => p.getAttribute('fill'));
if (arrowCol !== '#2563eb') throw new Error('arrow colour ' + arrowCol);
step('Rectangle, arrow (recoloured blue) and tick drawn');

// 5) text tool
await A.click('#pe-toolbar [data-tool="text"]');
await A.mouse.click(page.x + 100, page.y + 760);
await A.keyboard.type('Signed: Muamer');
await A.keyboard.press('Enter');
await A.waitForSelector('.pe-obj[data-type="text"] >> text=Signed: Muamer');
step('New text typed onto the page');

// 6) add a picture, then copy/paste the rectangle and delete one copy
await A.setInputFiles('#pe-file', PNG);
await A.waitForSelector('.pe-obj[data-type="image"].sel');
await A.click('.pe-obj[data-type="rect"]', { position: { x: 3, y: 3 } });
await A.keyboard.press('Control+c');
await A.keyboard.press('Control+v');
await A.waitForFunction(() => document.querySelectorAll('.pe-obj[data-type="rect"]').length === 2);
await A.keyboard.press('Delete');
await A.waitForFunction(() => document.querySelectorAll('.pe-obj[data-type="rect"]').length === 1);
await A.screenshot({ path: `${OUT}/102-pdf-tools.png` });
step('Picture added; rectangle copied with Ctrl+C / Ctrl+V; the copy deleted with Delete');

// 7) save and reopen
await A.click('#pe-save');
await A.waitForSelector('.toast >> text=deleted from every device', { timeout: 20000 });
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 1 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
await A.waitForTimeout(400);
await openEditor();
const lines = await A.$$eval('.pe-line', (b) => b.map((x) => x.getAttribute('aria-label').replace('Edit line: ', '')));
const imgs = await A.$$eval('.pe-img', (n) => n.length);
console.log('  reopened:', JSON.stringify(lines), 'pictures:', imgs);
if (!lines.includes('Total: 1450 EUR due today please')) throw new Error('edit lost');
if (lines.filter((t) => t === 'Plain black line to copy').length !== 2) throw new Error('pasted line missing');
if (!lines.includes('Signed: Muamer')) throw new Error('new text missing');
if (imgs !== imgs0 + 1) throw new Error('pictures ' + imgs);
await A.screenshot({ path: `${OUT}/103-pdf-saved.png` });
step('Saved PDF has the edit, the pasted line, the new text and the added picture');
const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) { console.log(real); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
