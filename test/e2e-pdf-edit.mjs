// PDF text editing: change a number in the document's own font, delete a line, undo,
// refuse characters that no font here has, save (replaces the original), reopen and check.
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
const PDF = process.env.PDF || new URL('./fixtures-invoice.pdf', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const A = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
A.on('pageerror', (e) => errors.push(e.message));
A.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
A.on('dialog', (d) => d.accept());
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.setInputFiles('#file-input', [{ name: 'Invoice.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(PDF) }]);
await A.waitForFunction(() => document.querySelector('.ri') && !document.querySelector('.ri .progress'), null, { timeout: 15000 });

const openEditor = async () => {
  await A.click('.ri .ri-thumb', { button: 'right' });
  await A.click('#menu button:has-text("Edit text")');
  await A.waitForSelector('#dlg-pdf[open] .pe-line', { timeout: 20000 });
};
const lineTexts = () => A.$$eval('.pe-line', (b) => b.map((x) => x.getAttribute('aria-label').replace('Edit line: ', '')));

await openEditor();
const t0 = await lineTexts();
console.log('  lines:', JSON.stringify(t0));
step('Edit text opens the PDF with clickable lines');

// 1) change the amount
await A.click('.pe-line[aria-label^="Edit line: Amount due"]');
await A.waitForSelector('.pe-input');
await A.screenshot({ path: `${OUT}/100-pdf-editing.png` });
await A.fill('.pe-input', 'Amount due: 1.520,00 EUR');
await A.keyboard.press('Enter');
await A.waitForFunction(() => /own font/.test(document.querySelector('#pe-status').textContent), null, { timeout: 15000 });
if (!(await lineTexts()).includes('Amount due: 1.520,00 EUR')) throw new Error('amount not changed');
step('Amount changed → “Changed in the document’s own font.”');

// 2) delete a line, undo it, delete again
await A.click('.pe-line[aria-label^="Edit line: Pay before"]');
await A.click('.pe-tools [data-pe="delete"]');
await A.waitForFunction(() => /Line deleted/.test(document.querySelector('#pe-status').textContent), null, { timeout: 15000 });
if ((await lineTexts()).some((t) => t.startsWith('Pay before'))) throw new Error('line not deleted');
await A.click('#pe-undo');
await A.waitForFunction(() => [...document.querySelectorAll('.pe-line')].some((b) => /Pay before/.test(b.getAttribute('aria-label'))), null, { timeout: 15000 });
await A.click('.pe-line[aria-label^="Edit line: Pay before"]');
await A.click('.pe-tools [data-pe="delete"]');
await A.waitForFunction(() => /Line deleted/.test(document.querySelector('#pe-status').textContent), null, { timeout: 15000 });
step('Delete line, Undo brings it back, delete again');

// 3) a character no font here has
await A.click('.pe-line[aria-label^="Edit line: Invoice"]');
await A.fill('.pe-input', 'Invoice ✓');
await A.keyboard.press('Enter');
await A.waitForFunction(() => /can’t be added/.test(document.querySelector('#pe-status').textContent), null, { timeout: 15000 });
await A.keyboard.press('Escape');
if (await A.$('.pe-input')) throw new Error('Esc should close the line editor');
if (!(await A.$('#dlg-pdf[open]'))) throw new Error('Esc should not close the PDF editor while a line was open');
step('Unsupported character → clear message, nothing changed; Esc closes only the line');

// 4) new letters not in the original font (subset) → matching font
await A.click('.pe-line[aria-label^="Edit line: Item one"]');
await A.fill('.pe-input', 'Item QWXZ');
await A.keyboard.press('Enter');
await A.waitForFunction(() => /Changed/.test(document.querySelector('#pe-status').textContent), null, { timeout: 15000 });
console.log('  status:', await A.textContent('#pe-status'));
await A.screenshot({ path: `${OUT}/101-pdf-after.png` });

// 5) save → replaces the original
await A.click('#pe-save');
await A.waitForSelector('.toast >> text=deleted from every device', { timeout: 15000 });
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 1 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
await A.waitForTimeout(400);
await openEditor();
const t1 = await lineTexts();
console.log('  after save:', JSON.stringify(t1));
if (!t1.includes('Amount due: 1.520,00 EUR') || t1.some((t) => /Pay before|1\.250/.test(t)) || !t1.some((t) => t.startsWith('Item QWXZ'))) throw new Error('saved PDF wrong');
await A.click('#pe-cancel');
step('Saved: reopened file has the new amount, no deleted line, no old text');

const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) { console.log(real); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
