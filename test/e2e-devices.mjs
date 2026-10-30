// Settings → device list: names, online state, last seen
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const A = await (await browser.newContext({ viewport: { width: 1200, height: 860 } })).newPage();
const B = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
for (const [p, n] of [[A, 'A'], [B, 'B']]) {
  p.on('pageerror', (e) => errors.push(n + ': ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(n + ': ' + m.text()); });
}
const rows = (p) => p.$$eval('#settings-devices .dev-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ').trim()).join(' | '));

await A.goto(BASE + '/');
await B.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]');
await B.waitForSelector('.status-chip[data-state="online"]');
await A.click('#btn-connect');
await A.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('#pair-code').textContent));
const code = (await A.textContent('#pair-code')).replace(/\D/g, '');
await A.keyboard.press('Escape');
await B.click('#btn-connect');
await B.fill('#join-code', code);
await B.waitForSelector('.toast >> text=Connected');

await A.click('#btn-settings');
await A.fill('#set-name', 'Office laptop');
await A.press('#set-name', 'Tab');
await A.waitForFunction(() => document.querySelectorAll('#settings-devices .dev-row').length === 2, null, { timeout: 10000 });
await A.waitForSelector('#settings-devices .dev-row.on >> text=Pixel phone', { timeout: 10000 });
console.log('• laptop sees:', await rows(A));
await A.screenshot({ path: `${OUT}/30-desktop-settings-devices.png` });

await B.click('#btn-settings');
await B.waitForSelector('#settings-devices .dev-row >> text=Office laptop', { timeout: 10000 });
console.log('• phone sees:', await rows(B));
await B.screenshot({ path: `${OUT}/31-mobile-settings-devices.png` });

await B.close();
await A.waitForSelector('#settings-devices .dev-row:not(.on) >> text=Pixel phone', { timeout: 10000 });
console.log('• after the phone closed, laptop sees:', await rows(A));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
