// Home screen: compact list, grid, filters, folders (create, drag in, move, delete), multi-select, phone chips
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

const png = fs.readFileSync(new URL('../public/icons/icon-512.png', import.meta.url));
const png2 = fs.readFileSync(new URL('../public/icons/apple-touch-icon.png', import.meta.url));
await A.setInputFiles('#file-input', [
  { name: 'Screenshot_bank.png', mimeType: 'image/png', buffer: png },
  { name: 'holiday.png', mimeType: 'image/png', buffer: png2 },
  { name: 'Homework week 9.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') },
  { name: 'project.zip', mimeType: 'application/zip', buffer: Buffer.alloc(40000, 1) }
]);
await A.fill('#composer-input', 'https://example.com/article');
await A.keyboard.press('Enter');
await A.fill('#composer-input', 'Buy bread and milk on the way home, and call the school about Friday.');
await A.keyboard.press('Enter');
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 6 && !document.querySelector('.ri .progress'), null, { timeout: 20000 });
await A.waitForTimeout(500);
await A.screenshot({ path: `${OUT}/50-home-desktop-list.png` });
step('Home: 6 drops in compact rows, newest first');

// type filters (inside the current place)
await A.click('#type-chips [data-type="media"]');
if ((await A.$$('.ri')).length !== 2) throw new Error('photos filter');
await A.click('#type-chips [data-type="files"]');
if ((await A.$$('.ri')).length !== 2) throw new Error('files filter');
await A.click('#type-chips [data-type="all"]');
step('type filters: Photos & videos (2), Files (2)');

// create folder
await A.click('.drops-side [data-act="new-folder"]');
await A.fill('#prompt-input', 'School');
await A.keyboard.press('Enter');
await A.waitForSelector('#dh-title >> text=School');
await A.click('.nav-item[data-view="home"]');
// drag a row (by its icon) onto the folder → it leaves Home
await A.dragAndDrop('.ri:has(.ri-title:text("Homework week 9.pdf")) .ri-thumb', '.nav-item[data-folder-drop]');
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 5 && !document.body.innerText.includes('Homework week 9.pdf'), null, { timeout: 8000 });
step('dragged into the folder → no longer on Home');

// drag a selection box across two rows (start in the empty margin left of the list)
const r1 = await (await A.$('.ri:nth-child(1)')).boundingBox();
const r2 = await (await A.$('.ri:nth-child(2)')).boundingBox();
await A.mouse.move(r1.x - 12, r1.y - 10);
await A.mouse.down();
await A.mouse.move(r1.x + 200, r1.y + 20, { steps: 5 });
await A.mouse.move(r2.x + 300, r2.y + r2.height / 2, { steps: 8 });
await A.screenshot({ path: `${OUT}/51-home-desktop-marquee.png` });
await A.mouse.up();
await A.waitForSelector('#sel-count >> text=2 selected');
step('drag-box selection picked 2 drops');
await A.click('[data-sel="move"]');
await A.click('.menu button:has-text("School")');
await A.waitForSelector('.toast >> text=Moved 2 items');
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 3, null, { timeout: 8000 });
await A.click('.nav-item[data-folder-drop]');
if ((await A.$$('.ri')).length !== 3) throw new Error('folder should have 3');
step('Move → folder has 3, Home has 3');
// Ctrl-click + Delete key → Trash
await A.click('.ri:nth-child(1) .ri-meta', { modifiers: ['Control'] });
await A.waitForSelector('#sel-count >> text=1 selected');
await A.keyboard.press('Delete');
await A.waitForSelector('.toast >> text=moved to Trash');
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 2);
step('Ctrl-click + Delete key moves to Trash');
// Ctrl+A selects everything here
await A.keyboard.press('Control+a');
await A.waitForSelector('#sel-count >> text=2 selected');
await A.keyboard.press('Escape');
// new file sent while the folder is open goes into it
await A.setInputFiles('#file-input', [{ name: 'timetable.txt', mimeType: 'text/plain', buffer: Buffer.from('Mon: English') }]);
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 3, null, { timeout: 15000 });
step('new file sent while the folder is open goes into it');
// search looks inside folders too
await A.click('.nav-item[data-view="home"]');
await A.fill('#search', 'timetable');
await A.waitForSelector('.ri-title >> text=timetable.txt');
await A.fill('#search', '');
await A.dispatchEvent('#search', 'input');
step('search finds drops inside folders');
// grid
await A.click('[data-layout="grid"]');
await A.waitForSelector('.tile-grid .tile');
await A.waitForTimeout(400);
await A.screenshot({ path: `${OUT}/52-home-desktop-grid.png` });
await A.click('[data-layout="list"]');
step('grid view');

// phone: chips + folder
await B.waitForSelector('.drop-chips .chip >> text=School', { timeout: 10000 });
await B.waitForTimeout(500);
await B.screenshot({ path: `${OUT}/53-home-phone-list.png` });
await B.click('.drop-chips .chip >> text=School');
await B.waitForFunction(() => document.querySelectorAll('.ri').length === 3, null, { timeout: 10000 });
await B.screenshot({ path: `${OUT}/54-home-phone-folder.png` });
await B.click('[data-layout="grid"]');
await B.click('.drop-chips .chip[data-view="home"]');
await B.waitForTimeout(400);
await B.screenshot({ path: `${OUT}/55-home-phone-grid.png` });
step('phone: folder chip shows the same 3 items; grid on phone');

// delete folder keeps items
await A.click('.nav-item[data-folder-drop]');
await A.click('#btn-folder-more');
await A.click('.menu button:has-text("Delete folder")');
await A.click('#confirm-ok');
await A.waitForSelector('#dh-title >> text=Home');
if ((await A.$$('.ri')).length !== 6) throw new Error('items lost after folder delete: ' + (await A.$$('.ri')).length);
step('deleting the folder puts its items back on Home');
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
