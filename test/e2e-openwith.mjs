// "Open with → SyncPad": manifest declares file handlers, files from launchQueue are sent to Home.
// Also guards against the old PowerShell setup coming back (Chrome flags that as a ClickFix scam).
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
// stand-in for Chrome's launchQueue (only exists in an installed desktop app)
await ctx.addInitScript(() => {
  Object.defineProperty(window, 'launchQueue', { configurable: true, value: { setConsumer(fn) { window.__launch = fn; } } });
});
const A = await ctx.newPage();
const errors = [];
A.on('pageerror', (e) => errors.push(e.message));
await A.goto(BASE + '/?open=file');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
if (new URL(A.url()).search) throw new Error('launch url not cleaned');

const m = await (await fetch(BASE + '/app.webmanifest')).json();
const fh = m.file_handlers && m.file_handlers[0];
if (!fh || fh.action !== '/?open=file' || !fh.accept['image/jpeg'] || !fh.accept['application/pdf']) throw new Error('file_handlers');
for (const [t, exts] of Object.entries(fh.accept)) if (!/^[\w.+-]+\/[\w.+-]+$/.test(t) || !exts.every((e) => /^\.[a-z0-9]+$/.test(e))) throw new Error('bad accept ' + t);
step(`Manifest declares Open-with handlers for ${Object.values(fh.accept).flat().length} file types`);

await A.evaluate(async () => {
  const mk = (name, type, text) => ({ kind: 'file', name, getFile: async () => new File([text], name, { type }) });
  await window.__launch({ files: [mk('report.pdf', 'application/pdf', '%PDF-1.4 hello'), mk('notes.txt', 'text/plain', 'hi')] });
});
await A.waitForFunction(() => ['report.pdf', 'notes.txt'].every((n) => [...document.querySelectorAll('.ri')].some((r) => r.textContent.includes(n))) && !document.querySelector('.ri .progress'), null, { timeout: 15000 });
step('Files opened with the app land on Home and upload');

const ps = await fetch(BASE + '/sendto.ps1');
const body = await ps.text();
if (ps.ok && /Install-SyncPad|powershell/i.test(body)) throw new Error('setup script still served');
const html = await (await fetch(BASE + '/')).text();
const js = await (await fetch(BASE + '/js/main.js')).text();
if (/powershell|Win \+ R|Win<\/kbd>/i.test(html + js) || /\biex\(|\birm /.test(html + js)) throw new Error('ClickFix-like text still in the app');
await A.click('#btn-settings');
const txt = await A.textContent('#openwith-text');
if (!/Open with → SyncPad/.test(txt)) throw new Error('settings text');
step('No PowerShell setup anywhere; Settings explains Open with → SyncPad');
if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
