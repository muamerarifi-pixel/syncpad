// 2.22: links typed or pasted in notes become real links (underlined, clickable) with a small preview card.
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const png = fs.readFileSync(new URL('../public/icons/icon-512.png', import.meta.url)).toString('base64');
// the sandbox has no internet: answer link previews like the server would
await ctx.route('**/api/link?*', (r) => {
  const u = new URL(r.request().url()).searchParams.get('url');
  r.fulfill({ contentType: 'application/json', body: JSON.stringify({ title: 'Preview of ' + new URL(u).hostname, site: new URL(u).hostname.replace(/^www\./, ''), desc: 'A page', image: 'data:image/png;base64,' + png }) });
});
const A = await ctx.newPage();
A.on('pageerror', (e) => errors.push(e.message));
A.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.click('.tab[data-tab="notes"]');
await A.click('#btn-new-note');
await A.keyboard.type('Reading list');
await A.keyboard.press('Enter');
await A.keyboard.type('Read https://example.com/article today');
await A.waitForSelector('#editor-text a[href="https://example.com/article"]');
const deco = await A.$eval('#editor-text a[href="https://example.com/article"]', (a) => getComputedStyle(a).textDecorationLine);
if (deco !== 'underline') throw new Error('not underlined');
await A.waitForSelector('#editor-text a.link-card[href="https://example.com/article"] img.lc-img');
await A.keyboard.press('End');
await A.keyboard.press('Enter');
await A.keyboard.type('www.test.org');
await A.keyboard.press('Enter');
await A.waitForSelector('#editor-text a:not(.link-card)[href^="https://www.test.org"]');
step('Typing a link and then space or Enter makes it a real, underlined link; a small preview card with a picture appears');

await A.evaluate(() => { const e = document.querySelector('#editor-text'); e.focus(); const dt = new DataTransfer(); dt.setData('text/plain', 'https://paste.example/x'); e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
await A.waitForSelector('#editor-text a[href="https://paste.example/x"]:not(.link-card)');
await A.waitForSelector('#editor-text a.link-card[href="https://paste.example/x"]');
step('Pasting a link: link + preview card');

// click a link → bubble; remove link
await A.click('#editor-text a:not(.link-card)[href^="https://www.test.org"]');
await A.waitForSelector('.link-bubble:not([hidden]) >> text=test.org');
await A.screenshot({ path: `${OUT}/200-links.png` });
await A.click('.link-bubble [data-lb="unlink"]');
if (await A.$('#editor-text a:not(.link-card)[href^="https://www.test.org"]')) throw new Error('unlink');
// card opens the page
const [pop] = await Promise.all([ctx.waitForEvent('page'), A.click('#editor-text a.link-card[href="https://example.com/article"]')]);
// (no internet here: the new tab opening is what matters)
await pop.close();
step('Tap a link: Open / Copy / Remove bubble; tap a card: the page opens');

// saved: after reload the links and cards are still there
await A.waitForTimeout(1200);
await A.reload();
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.click('.tab[data-tab="notes"]');
await A.click('.note-item:has-text("Reading list")');
await A.waitForSelector('#editor-text a.link-card img.lc-img');
const n = await A.$$eval('#editor-text a.link-card', (l) => l.length);
if (n !== 3) throw new Error('cards after reload ' + n);
step('Links and preview cards are saved with the note');

// drops: a link drop shows the page picture
await A.evaluate(() => localStorage.setItem('sp-send-as', 'drop'));
await A.click('.tab[data-tab="drops"]');
await A.fill('#composer-input', 'https://news.example/story');
await A.click('#btn-send');
await A.waitForSelector('.ri img[src^="data:image/"]', { timeout: 10000 });
step('Drops: a sent link shows the page picture as its thumbnail');
if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
