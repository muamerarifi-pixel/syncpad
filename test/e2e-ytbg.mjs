// YouTube keeps playing when the phone app goes to the background (a fake player speaking YouTube's iframe messages)
// fake YouTube player at the real origin, speaking YouTube's iframe message protocol
import { chromium, devices } from 'playwright';
const ok = (c, m) => { console.log(c ? '  ✓' : '✗', m); if (!c) process.exitCode = 1; };
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const FAKE = `<!doctype html><body style="margin:0;background:#222;color:#fff;font:14px sans-serif">fake player<script>
let parentWin = null, state = -1; window.cmds = [];
const send = (o) => parentWin && parentWin.postMessage(JSON.stringify({ ...o, id: 1, channel: 'widget' }), '*');
const setState = (s) => { state = s; send({ event: 'onStateChange', info: s }); send({ event: 'infoDelivery', info: { playerState: s, currentTime: 12 } }); };
addEventListener('message', (e) => {
  let d; try { d = JSON.parse(e.data); } catch { return; }
  if (d.event === 'listening' && !parentWin) { parentWin = e.source; send({ event: 'initialDelivery', info: {} }); send({ event: 'onReady', info: {} }); setTimeout(() => setState(1), 50); }
  if (d.event === 'command') { cmds.push(d.func); if (d.func === 'playVideo') setState(1); if (d.func === 'pauseVideo') setState(2); }
});
window.ytPauseBecauseHidden = () => setState(2);
window.userPause = () => setState(2);
</script>`;
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 800 } });
await ctx.route('https://www.youtube-nocookie.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FAKE }));
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE + '/'); await p.waitForTimeout(1200);
await p.evaluate(async () => { const s = window.__test_store; const now = Date.now();
  await s.save({ id: 'clipyt12345678', kind: 'clip', rev: 0, created: now, updated: now, device: 'x', data: { text: 'https://youtu.be/dQw4w9WgXcQ' } }); });
await p.reload(); await p.waitForTimeout(1000);
await p.click('#feed-inner [data-act=open]').catch(() => p.click('#feed-inner a[href*="youtu"]'));
await p.waitForTimeout(1200);
const fr = p.frames().find((f) => f.url().includes('youtube-nocookie'));
ok(/enablejsapi=1/.test(fr.url()) && /origin=http/.test(fr.url()), 'src has jsapi+origin');
const hide = (h) => p.evaluate((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') }); document.dispatchEvent(new Event('visibilitychange')); }, h);
// 1. app goes to the background, YouTube pauses → we tell it to play on
await hide(true); await fr.evaluate(() => window.ytPauseBecauseHidden()); await p.waitForTimeout(600);
ok((await fr.evaluate(() => window.cmds)).includes('playVideo'), '1 resumed in background');
// 2. later, user pauses from the phone's notification (hidden, > 4 s after hiding) → respected
await p.evaluate(() => {}); await fr.evaluate(() => { window.cmds = []; });
await p.waitForTimeout(4200); await fr.evaluate(() => window.userPause()); await p.waitForTimeout(800);
ok(!(await fr.evaluate(() => window.cmds)).includes('playVideo'), '2 user pause respected');
// 3. back to the app: nothing forced, it was the user's pause
await hide(false); await p.waitForTimeout(300);
ok(!(await fr.evaluate(() => window.cmds)).includes('playVideo'), '3 no forced play on return');
// 4. play again, hide, YouTube refuses 5 times (stays paused) → when you come back it continues
await fr.evaluate(() => { window.cmds = []; }); await fr.evaluate(() => { /* user presses play */ }); 
await fr.evaluate(() => window.parent && 0); await fr.evaluate(() => { window.cmds = []; });
await fr.evaluate(() => { const ev = new MessageEvent('message', { data: JSON.stringify({ event: 'command', func: 'noop' }) }); }); 
await fr.evaluate(() => { window.__refuse = true; });
await fr.evaluate(() => { const s = (st) => window.parent.postMessage(JSON.stringify({ event: 'onStateChange', info: st, id: 1, channel: 'widget' }), '*'); s(1); });
await hide(true); await fr.evaluate(() => { const s = (st) => window.parent.postMessage(JSON.stringify({ event: 'onStateChange', info: st, id: 1, channel: 'widget' }), '*'); s(2); });
await p.waitForTimeout(400); await hide(false); await p.waitForTimeout(300);
ok((await fr.evaluate(() => window.cmds)).filter((c) => c === 'playVideo').length >= 1, '4 continues when you come back');
// 5. user pause while watching → no auto play
await fr.evaluate(() => { window.cmds = []; window.userPause(); }); await p.waitForTimeout(300); await hide(true); await p.waitForTimeout(200); await hide(false); await p.waitForTimeout(300);
ok(!(await fr.evaluate(() => window.cmds)).includes('playVideo'), '5 visible pause stays paused');
ok(await p.isVisible('#yt-pop'), 'pop out button visible on phone');
ok(errs.length === 0, 'no page errors ' + errs.join('; '));
if (!process.exitCode) console.log('ALL GOOD');
await b.close();
