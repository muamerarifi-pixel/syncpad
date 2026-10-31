// Privacy: hide the notes list (remembered on this device) and present one note full screen.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Permissions check failed/.test(m.text())) errors.push(m.text()); }); };
const A = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); watch(A);
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.click('.tab[data-tab="notes"]');
for (const t of ['Private: salaries', 'Class 9B reading']) {
  await A.click('#btn-new-note');
  await A.keyboard.type(t);
  await A.keyboard.press('Enter');
  await A.keyboard.type('Some text for ' + t);
  await A.waitForTimeout(700);
}
// hide the list
await A.click('#btn-toggle-list');
if (await A.isVisible('.notes-pane')) throw new Error('list still visible');
if (!(await A.isVisible('#editor-text'))) throw new Error('editor hidden');
await A.reload();
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.click('.tab[data-tab="notes"]');
if (await A.isVisible('.notes-pane')) throw new Error('hidden list not remembered');
if (await A.isVisible('#btn-show-list')) await A.click('#btn-show-list'); else await A.click('#btn-toggle-list');
await A.waitForSelector('.notes-pane');
await A.click('.note-item:has-text("Class 9B")');
await A.keyboard.press('Control+\\');
if (await A.isVisible('.notes-pane')) throw new Error('Ctrl+\\ did not hide');
await A.screenshot({ path: `${OUT}/140-list-hidden.png` });
step('Notes list hides with one button (or Ctrl+\\), stays hidden after reload, “Show the notes list” brings it back');

// present
await A.keyboard.press('Control+\\');
await A.click('#btn-present');
await A.waitForFunction(() => document.querySelector('.app').classList.contains('presenting'));
const vis = await A.evaluate(() => ['.topbar', '.notes-pane', '.editor-bar', '.editor-foot'].map((s) => { const e = document.querySelector(s); return e && e.offsetParent !== null; }));
if (vis.some(Boolean)) throw new Error('chrome visible while presenting ' + vis);
if (!(await A.isVisible('#editor-text >> text=Class 9B reading'))) throw new Error('note not shown');
// writing while presenting: type, make a word bold with the formatting bar
await A.mouse.move(640, 400);
await A.waitForSelector('.fmt-bar', { state: 'visible' });
await A.click('#editor-text >> text=Some text for Class 9B reading');
await A.keyboard.press('End');
await A.keyboard.press('Enter');
await A.click('[data-fmt="bold"]');
await A.keyboard.type('Homework: page 42');
const typed = await A.$eval('#editor-text', (e) => [...e.querySelectorAll('b, strong, span')].some((b) => b.textContent.includes('Homework: page 42') && (b.tagName !== 'SPAN' || /bold|700/.test(b.style.fontWeight))));
if (!typed) { console.log(await A.$eval('#editor-text', (e) => e.innerHTML)); throw new Error('typing / bold while presenting'); }
await A.waitForTimeout(3200);
if ((await A.$eval('.fmt-bar', (b) => getComputedStyle(b).opacity)) !== '0') throw new Error('toolbar should fade while idle');
// pop-ups stay quiet: a drop from another device arrives
await A.evaluate(() => { const b = document.querySelector('.present-bar'); b.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); });
await A.mouse.move(600, 400);
await A.waitForSelector('.present-bar.show');
await A.click('.present-bar .zi');
const z = await A.textContent('.present-bar .zv');
if (z === '100%') throw new Error('zoom on the presenting bar');
await A.screenshot({ path: `${OUT}/141-presenting.png` });
await A.keyboard.press('Escape');
await A.waitForFunction(() => !document.querySelector('.app').classList.contains('presenting'));
if (!(await A.isVisible('.notes-pane'))) throw new Error('exit present');
await A.click('.note-item:has-text("Class 9B")');
if (!(await A.isVisible('#editor-text >> text=Homework: page 42'))) throw new Error('text typed while presenting was not saved');
await A.click('.present-bar .zv', { force: true }).catch(() => {});
step(`Present: only the note on screen (no list or titles); you can still type and format — the tools fade while the mouse rests; zoom ${z}; Esc leaves, the new text is saved`);

// canvas presents too
await A.click('#btn-new-canvas');
await A.click('[data-cv="text"]'); await A.click('.cv-world', { position: { x: 120, y: 80 } });
await A.keyboard.type('Projector canvas');
await A.keyboard.press('Escape');
await A.click('#btn-present');
await A.waitForFunction(() => document.querySelector('.app').classList.contains('presenting'));
if (!(await A.isVisible('.cv-obj.cv-text'))) throw new Error('canvas not shown');
await A.mouse.move(500, 300);
await A.click('[data-cv="shapes"]');
await A.click('.cv-pop [data-k="rect"]');
if ((await A.$$('.cv-obj')).length !== 2) throw new Error('adding a shape while presenting');
await A.keyboard.press('Escape');
step('A canvas presents the same way and can still be edited (a box added live)');

// phone: present from the note menu, back button leaves
const P = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); watch(P);
await P.goto(BASE + '/');
await P.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await P.click('.tabbar-btn[data-tab="notes"]');
await P.click('#fab-new-note');
await P.keyboard.type('Phone slide');
await P.click('#btn-note-more');
await P.click('.menu button:has-text("Present")');
await P.waitForFunction(() => document.querySelector('.app').classList.contains('presenting'));
await P.screenshot({ path: `${OUT}/142-phone-present.png` });
await P.goBack();
await P.waitForFunction(() => !document.querySelector('.app').classList.contains('presenting'));
if (!(await P.isVisible('#editor-text'))) throw new Error('phone back left the note');
step('Phone: Present from ⋯, the Back button returns to the note');

if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
