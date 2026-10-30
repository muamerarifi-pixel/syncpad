import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const step = (s) => console.log('•', s);
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
const P = await ctx.newPage();
P.on('pageerror', (e) => errors.push(e.message));
P.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await P.goto(BASE + '/');
await P.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });

// zoom
await P.click('.tabbar-btn[data-tab="notes"]');
await P.click('#fab-new-note');
await P.keyboard.type('Zoom test note');
await P.keyboard.press('Enter');
await P.keyboard.type('Some text to read more comfortably.');
await P.click('#btn-zoom-in');
await P.click('#btn-zoom-in');
const z = await P.evaluate(() => getComputedStyle(document.querySelector('#editor-text')).zoom);
if (Math.abs(Number(z) - 1.3) > 0.01) throw new Error('zoom not applied: ' + z);
if ((await P.textContent('#btn-zoom-reset')).trim() !== '130%') throw new Error('zoom label');
await P.keyboard.type(' Still typing after zoom.');
const html = await P.innerHTML('#editor-text');
if (!html.includes('comfortably. Still typing after zoom.')) throw new Error('typing after zoom broke: ' + html);
await P.waitForTimeout(700);
await P.screenshot({ path: `${OUT}/20-mobile-zoom.png` });
step('A+ zooms note text to 130%, typing still works');
await P.click('#btn-editor-back');

// set PIN
await P.click('#btn-settings');
await P.click('#btn-pin-set');
for (const d of '1234') await P.click(`.key[data-k="${d}"]`);
await P.click('#lock-next');
await P.screenshot({ path: `${OUT}/21-mobile-pin-confirm.png` });
for (const d of '1234') await P.click(`.key[data-k="${d}"]`);
await P.waitForSelector('.toast >> text=PIN is on');
await P.waitForSelector('#btn-lock:not([hidden])');
step('PIN set via keypad (4 digits, confirmed)');

// reload → locked, content hidden
await P.reload();
await P.waitForSelector('#lock:not([hidden])');
const vis = await P.evaluate(() => getComputedStyle(document.querySelector('#app')).visibility);
if (vis !== 'hidden') throw new Error('content visible while locked');
await P.screenshot({ path: `${OUT}/22-mobile-locked.png` });
for (const d of '0000') await P.click(`.key[data-k="${d}"]`);
await P.waitForSelector('#lock-msg >> text=Wrong PIN');
for (const d of '1234') await P.click(`.key[data-k="${d}"]`);
await P.waitForSelector('#lock', { state: 'hidden', timeout: 5000 });
if ((await P.evaluate(() => getComputedStyle(document.querySelector('#app')).visibility)) !== 'visible') throw new Error('not visible after unlock');
const z2 = await P.evaluate(() => localStorage.getItem('sp-zoom'));
if (z2 !== '1.3') throw new Error('zoom not remembered');
step('reload asks for PIN; wrong PIN rejected; right PIN unlocks; zoom remembered');

// lock now + hardware keyboard
await P.click('#btn-lock');
await P.waitForSelector('#lock:not([hidden])');
await P.keyboard.type('1234');
await P.waitForSelector('#lock', { state: 'hidden', timeout: 5000 });
step('Lock now button + keyboard unlock');

// turn off
await P.click('#btn-settings');
await P.click('#btn-pin-remove');
await P.waitForSelector('#lock:not([hidden])');
await P.keyboard.type('1234');
await P.waitForSelector('.toast >> text=PIN turned off');
await P.reload();
await P.waitForSelector('.status-chip', { timeout: 10000 });
if (!(await P.isHidden('#lock'))) throw new Error('still locked after PIN off');
step('PIN turned off');
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
