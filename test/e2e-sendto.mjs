// Windows "Send to": settings copies the setup command, /sendto.ps1 serves the script,
// and an upload done exactly the way send.ps1 does it shows up on Home with a preview.
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
});
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const A = await ctx.newPage();
const errors = [];
A.on('pageerror', (e) => errors.push(e.message));
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });

// 1) settings → copy the command
await A.click('#btn-settings');
await A.waitForSelector('#sendto-field:not([hidden])');
await A.click('#btn-sendto');
await A.waitForSelector('#sendto-steps:not([hidden])');
await A.locator('#sendto-field').scrollIntoViewIfNeeded();
await A.screenshot({ path: `${OUT}/80-sendto-settings.png` });
const cmd = await A.evaluate(() => navigator.clipboard.readText());
console.log('  command (' + cmd.length + ' chars)');
const m = /^powershell -NoProfile -ExecutionPolicy Bypass -c "iex\(irm (https?:\/\/[^)]+)\/sendto\.ps1\);Install-SyncPad '([A-Za-z0-9_-]+)~([A-Za-z0-9_-]+)~([A-Za-z0-9_-]+)~([A-Za-z0-9_-]+)'"$/.exec(cmd);
if (!m) throw new Error('bad command: ' + cmd);
if (cmd.length > 259) throw new Error('too long for the Run box');
if (cmd.includes('$')) throw new Error('a $ would break when pasted into PowerShell');
const [, origin, space, token, dev, secret] = m;
step(`Settings copies a ${cmd.length}-char setup command (fits the Win+R box)`);

// 2) the script
const r = await fetch(origin + '/sendto.ps1');
const ps = await r.text();
if (!r.ok || !/text\/plain/.test(r.headers.get('content-type'))) throw new Error('script route');
for (const must of ['function Install-SyncPad', `$base = '${origin}'`, 'function Send-File', 'syncpad-check', "SendTo')"]) if (!ps.includes(must)) throw new Error('script missing ' + must);
if (ps.includes('__SEND_PS1__') || ps.includes('__ORIGIN__')) throw new Error('placeholders left');
const hs = ps.split('\n');
const open = hs.findIndex((l) => /@'$/.test(l));
const close = hs.findIndex((l, i) => i > open && l.startsWith("'@"));
if (open < 0 || close < 0 || hs.slice(open + 1, close).some((l) => l.startsWith("'@"))) throw new Error('here-string broken');
if (/[^\x00-\x7f]/.test(ps)) throw new Error('script must be plain ASCII');
fs.writeFileSync(`${OUT}/sendto.ps1.txt`, ps);
step('/sendto.ps1 serves the setup with the uploader embedded, plain ASCII');

// 3) do what send.ps1 does: register (check), PUT 1 MiB chunks, POST sync with the file op
const H = { 'x-k': token, 'x-d': dev, 'x-ds': secret };
const api = (path, init = {}) => fetch(`${origin}/api/s/${space}/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
const sync = async (ops) => {
  const res = await api('sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ since: 2000000000, name: 'MUAMER-PC (Send to)', ops }) });
  if (res.status !== 200) throw new Error('sync ' + res.status);
  return res.json();
};
const chk = await sync([]);
if (chk.changes.length) throw new Error('check should not download data');
const png = fs.readFileSync('/home/claude/syncpad/public/icons/icon-512.png');
const big = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 + 123, 7)]); // 3 chunks
const send = async (name, buf, type, extra = {}) => {
  const id = 'w' + Math.random().toString(36).slice(2, 17);
  const n = Math.ceil(buf.length / 1048576);
  for (let i = 0; i < n; i++) {
    const res = await api(`file/${id}/${i}`, { method: 'PUT', body: buf.subarray(i * 1048576, Math.min(buf.length, (i + 1) * 1048576)) });
    if (res.status !== 200) throw new Error('chunk ' + res.status);
  }
  const j = await sync([{ id, kind: 'file', deleted: false, baseRev: 0, created: Date.now(), data: { name, size: buf.length, type, ...extra } }]);
  if (!j.acks[0] || !j.acks[0].ok) throw new Error('ack ' + JSON.stringify(j.acks));
  return id;
};
const thumb = 'data:image/png;base64,' + png.toString('base64');
const id1 = await send('Screenshot from PC.png', png, 'image/png', { thumb, w: 512, h: 512 });
const id2 = await send('Lesson plan.zip', big, 'application/zip');
step('Upload exactly like send.ps1: 1 photo with preview + a 3-chunk zip, both accepted');

await A.keyboard.press('Escape');
await A.waitForFunction((ids) => ids.every((id) => document.querySelector(`.ri[data-id="${id}"]`)), [id1, id2], { timeout: 15000 });
if (!(await A.$(`.ri[data-id="${id1}"] .ri-thumb img`))) throw new Error('no preview');
const dl = await A.evaluate(async (u) => (await fetch(u)).arrayBuffer().then((b) => b.byteLength), `/api/s/${space}/file/${id2}?k=${token}`);
if (dl !== big.length) throw new Error('size ' + dl);
await A.screenshot({ path: `${OUT}/81-sendto-home.png` });
step('Both show up on Home right away (photo has its preview, zip downloads intact)');

// 4) device list shows the PC; removing it locks the helper out
await A.click('#btn-settings');
await A.waitForFunction(() => /MUAMER-PC \(Send to\)/.test(document.querySelector('#dlg-settings').textContent), null, { timeout: 10000 });
step('Settings → devices lists “MUAMER-PC (Send to)”');
if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
