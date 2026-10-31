// 2.18: swipe between Drops and Notes — finger on phones, two-finger trackpad swipe on computers.
import { chromium, devices } from 'playwright';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); };
const tab = (p) => p.evaluate(() => document.querySelector('.app').dataset.tab);

// computer: trackpad
const A = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); watch(A);
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.mouse.move(700, 400);
for (let k = 0; k < 6; k++) await A.mouse.wheel(40, 2);
await A.waitForTimeout(300);
if ((await tab(A)) !== 'notes') throw new Error('trackpad → notes');
await A.waitForTimeout(400);
await A.mouse.move(160, 400);
for (let k = 0; k < 6; k++) await A.mouse.wheel(-40, 1);
await A.waitForTimeout(300);
if ((await tab(A)) !== 'drops') throw new Error('trackpad → drops');
await A.mouse.move(700, 400);
for (let k = 0; k < 6; k++) await A.mouse.wheel(2, 40); // ordinary scrolling stays put
if ((await tab(A)) !== 'drops') throw new Error('vertical scroll switched tabs');
step('Computer: two-finger swipe left → Notes, right → Drops; normal scrolling unaffected');

// phone: finger
const P = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); watch(P);
await P.goto(BASE + '/');
await P.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
const cdp = await P.context().newCDPSession(P);
const swipe = async (x1, x2, y = 420) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y }] });
  for (let k = 1; k <= 8; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + ((x2 - x1) * k) / 8, y: y + k }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await P.waitForTimeout(350);
};
await swipe(330, 60);
if ((await tab(P)) !== 'notes') throw new Error('phone → notes');
await P.click('#fab-new-note'); await P.keyboard.type('Keep me'); await P.click('#btn-editor-back');
await P.waitForSelector('.note-item:has-text("Keep me")');
const nb = await P.locator('.note-item:has-text("Keep me")').boundingBox();
await swipe(60, 330, nb.y + nb.height / 2); // right swipe on a note: back to Drops, the note stays
if ((await tab(P)) !== 'drops') throw new Error('phone → drops');
await swipe(330, 60);
if (!(await P.isVisible('.note-item:has-text("Keep me")'))) throw new Error('note was deleted by a right swipe');
step('Phone: swipe left → Notes, right → Drops (also on top of a note, which stays)');

if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
