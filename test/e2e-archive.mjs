// 2.20: phones — press and hold a note for its menu; swipe right = Archive, swipe left = Trash.
import { chromium, devices } from 'playwright';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const P = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
P.on('pageerror', (e) => errors.push(e.message));
P.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await P.goto(BASE + '/');
await P.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await P.click('.tabbar-btn[data-tab="notes"]');
for (const t of ['Alpha note', 'Beta note', 'Gamma note']) { await P.click('#fab-new-note'); await P.keyboard.type(t); await P.click('#btn-editor-back'); await P.waitForSelector(`.note-item:has-text("${t}")`); }
const cdp = await P.context().newCDPSession(P);
const at = async (name) => { const b = await P.locator(`.note-item:has-text("${name}")`).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const swipe = async (name, dx) => {
  const p = await at(name);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
  for (let k = 1; k <= 8; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x + (dx * k) / 8, y: p.y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await P.waitForTimeout(450);
};
const tab = () => P.evaluate(() => document.querySelector('.app').dataset.tab);

// press and hold → menu
const h = await at('Alpha note');
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [h] });
await P.waitForTimeout(700);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await P.waitForSelector('#menu:not([hidden]) button:has-text("Archive")');
if (await P.isVisible('#editor-text')) throw new Error('hold opened the note');
await P.screenshot({ path: `${OUT}/190-hold-menu.png` });
await P.click('#menu button:has-text("Colour")');
await P.click('#menu button:has-text("Green")');
await P.waitForSelector('.note-item[data-color="green"]:has-text("Alpha note")');
step('Press and hold a note → its menu (Open, Pin, Copy, Folder, Colour, Archive, Trash); the note doesn’t open');

// swipe right → Archive
await swipe('Beta note', 260);
await P.waitForSelector('.toast >> text=Note archived');
if ((await tab()) !== 'notes') throw new Error('swipe on a note switched tabs');
if (await P.isVisible('.note-item:has-text("Beta note")')) throw new Error('not archived');
await P.click('[data-nf="archive"]');
await P.waitForSelector('.note-item:has-text("Beta note")');
await swipe('Beta note', 260); // in Archive: right swipe brings it back
await P.waitForSelector('.toast >> text=Note back in your notes');
await P.click('[data-nf="all"]').catch(() => {});
await P.waitForSelector('.note-item:has-text("Beta note")');
step('Swipe right → Archive (with Undo); the Archive chip lists it; swiping right there brings it back');

// swipe left → Trash
await swipe('Gamma note', -260);
await P.waitForSelector('.toast >> text=Undo');
await P.waitForFunction(() => ![...document.querySelectorAll('.note-item')].some((b) => /Gamma note/.test(b.textContent)));
step('Swipe left → Trash (with Undo)');

if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
