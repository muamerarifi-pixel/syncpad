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
step('compact list: 6 drops, newest first, grouped by day');

// filters
await A.click('.nav-item[data-view="media"]');
if ((await A.$$('.ri')).length !== 2) throw new Error('photos filter');
await A.click('.nav-item[data-view="files"]');
if ((await A.$$('.ri')).length !== 2) throw new Error('files filter');
await A.click('.nav-item[data-view="all"]');
step('filters: Photos & videos (2), Files (2)');

// create folder
await A.click('.drops-side [data-act="new-folder"]');
await A.fill('#prompt-input', 'School');
await A.keyboard.press('Enter');
await A.waitForSelector('#dh-title >> text=School');
await A.click('.nav-item[data-view="all"]');
// drag a row onto the folder
await A.dragAndDrop('.ri:has(.ri-title:text("Homework week 9.pdf"))', '.nav-item[data-folder-drop]');
await A.waitForSelector('.ri:has(.ri-title:text("Homework week 9.pdf")) .fchip >> text=School');
step('drag a drop onto the folder in the sidebar');
// multi-select + move
await A.click('#btn-select');
await A.click('.ri:has(.ri-title:text("Buy bread"))');
await A.click('.ri:has(.ri-title:text("project.zip"))');
await A.waitForSelector('#sel-count >> text=2 selected');
await A.screenshot({ path: `${OUT}/51-home-desktop-select.png` });
await A.click('[data-sel="move"]');
await A.click('.menu button:has-text("School")');
await A.waitForSelector('.toast >> text=Moved 2 items');
await A.click('.nav-item[data-folder-drop]');
if ((await A.$$('.ri')).length !== 3) throw new Error('folder should have 3');
step('select 2 + Move → folder has 3 items');
// drop a new file while the folder is open → lands in the folder
await A.setInputFiles('#file-input', [{ name: 'timetable.txt', mimeType: 'text/plain', buffer: Buffer.from('Mon: English') }]);
await A.waitForFunction(() => document.querySelectorAll('.ri').length === 4, null, { timeout: 15000 });
step('new file sent while the folder is open goes into it');
// grid
await A.click('.nav-item[data-view="all"]');
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
await B.waitForFunction(() => document.querySelectorAll('.ri').length === 4, null, { timeout: 10000 });
await B.screenshot({ path: `${OUT}/54-home-phone-folder.png` });
await B.click('[data-layout="grid"]');
await B.click('.drop-chips .chip[data-view="all"]');
await B.waitForTimeout(400);
await B.screenshot({ path: `${OUT}/55-home-phone-grid.png` });
step('phone: folder chip shows the same 4 items; grid on phone');

// delete folder keeps items
await A.click('.nav-item[data-folder-drop]');
await A.click('#btn-folder-more');
await A.click('.menu button:has-text("Delete folder")');
await A.click('#confirm-ok');
await A.waitForSelector('#dh-title >> text=All drops');
if ((await A.$$('.ri')).length !== 7) throw new Error('items lost after folder delete');
step('deleting the folder keeps its items in All drops');
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
