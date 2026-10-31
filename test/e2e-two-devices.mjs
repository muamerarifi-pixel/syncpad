import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
};
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
const ctxB = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
const A = await ctxA.newPage(); watch(A, 'A');
const B = await ctxB.newPage(); watch(B, 'B');
const step = (s) => console.log('•', s);

await A.goto(BASE + '/'); await B.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await B.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
step('both devices online');
await A.screenshot({ path: `${OUT}/01-desktop-empty.png` });
await B.screenshot({ path: `${OUT}/02-mobile-empty.png` });

// Pair B with A using the 6-digit code
await A.click('#btn-connect');
await A.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('#pair-code').textContent), null, { timeout: 10000 });
const code = (await A.textContent('#pair-code')).replace(/\D/g, '');
await A.screenshot({ path: `${OUT}/03-desktop-connect.png` });
await A.keyboard.press('Escape');
await B.click('#btn-connect');
await B.fill('#join-code', code);
await B.waitForSelector('.toast >> text=Connected', { timeout: 10000 });
step('paired with code ' + code);
const spaceA = await A.evaluate(() => new Promise((r) => { const q = indexedDB.open('syncpad2'); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('space'); g.onsuccess = () => r(g.result.v); }; }));
const spaceB = await B.evaluate(() => new Promise((r) => { const q = indexedDB.open('syncpad2'); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('space'); g.onsuccess = () => r(g.result.v); }; }));
if (spaceA !== spaceB) throw new Error('spaces differ');
await A.waitForFunction(() => /2 devices/.test(document.querySelector('.status-text').textContent), null, { timeout: 10000 });
step('A sees 2 devices online');

// Text message A -> B
await A.fill('#composer-input', 'Hello from my laptop 👋 https://example.com');
await A.keyboard.press('Enter');
await B.waitForSelector('.ri-title >> text=Hello from my laptop', { timeout: 8000 });
step('message A → B');

// Message B -> A (mobile send button)
await B.fill('#composer-input', 'Reply from phone');
await B.click('#btn-send');
await A.waitForSelector('.ri-title >> text=Reply from phone', { timeout: 8000 });
step('message B → A');

// File upload (2.5 MB binary) via picker on A
const big = Buffer.alloc(2.5 * 1024 * 1024); for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255;
await A.setInputFiles('#file-input', [{ name: 'report.zip', mimeType: 'application/zip', buffer: big }]);
await B.waitForSelector('.ri-title >> text=report.zip', { timeout: 20000 });
step('2.5 MB file A → B');
const id = await B.getAttribute('.ri:has(.ri-title:text("report.zip"))', 'data-id');
const got = await B.evaluate(async ([s, id]) => { const r = await fetch(`/api/s/${s}/file/${id}?dl=1`); const b = new Uint8Array(await r.arrayBuffer()); let h = 0; for (const x of b) h = (h * 31 + x) >>> 0; return [b.length, h]; }, [spaceB, id]);
let h = 0; for (const x of big) h = (h * 31 + x) >>> 0;
if (got[0] !== big.length || got[1] !== h) throw new Error('file content mismatch ' + got);
step('downloaded bytes match');

// Image via drag & drop on B? (mobile has no DnD) -> do drag&drop on A with a real PNG
const png = fs.readFileSync(new URL('../public/icons/icon-512.png', import.meta.url));
const dt = await A.evaluateHandle((b64) => {
  const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const d = new DataTransfer(); d.items.add(new File([u], 'holiday-photo.png', { type: 'image/png' })); return d;
}, png.toString('base64'));
await A.dispatchEvent('#feed', 'dragenter', { dataTransfer: dt });
await A.dispatchEvent('#feed', 'dragover', { dataTransfer: dt });
await A.screenshot({ path: `${OUT}/04-desktop-dragover.png` });
await A.dispatchEvent('#feed', 'drop', { dataTransfer: dt });
await B.waitForSelector('.ri-title >> text=holiday-photo.png', { timeout: 15000 });
step('drag & drop image A → B with thumbnail');
await A.waitForTimeout(600);
await A.screenshot({ path: `${OUT}/05-desktop-feed.png` });
await B.waitForTimeout(600);
await B.screenshot({ path: `${OUT}/06-mobile-feed.png` });

// Notes: rich text editor — size before typing, colour, highlight, checklist
await B.click('.tabbar-btn[data-tab="notes"]');
await B.click('#fab-new-note');
await B.click('[data-fmt="size"]');
await B.click('.menu button:has-text("Huge")');
await B.keyboard.type('Shopping list');
await B.keyboard.press('Enter');
await B.click('[data-fmt="size"]');
await B.click('.menu button:has-text("Normal")');
await B.keyboard.type('[] Milk');
await B.keyboard.press('Enter');
await B.keyboard.type('Bread');
await B.keyboard.press('Enter');
await B.keyboard.press('Enter');
await B.keyboard.type('Remember the receipt');
await B.keyboard.down('Shift'); for (let i = 0; i < 7; i++) await B.keyboard.press('ArrowLeft'); await B.keyboard.up('Shift');
await B.click('[data-fmt="color"]');
await B.click('.menu button[title="Red"]');
await B.click('[data-fmt="color"]');
await B.click('.menu button[title="Yellow highlight"]');
await B.waitForTimeout(900);
await B.screenshot({ path: `${OUT}/07-mobile-editor.png` });
const bHtml = await B.innerHTML('#editor-text');
if (!/font-size:\s*xx-large[^>]*>Shopping list/.test(bHtml)) throw new Error('size before typing failed: ' + bHtml);
if (!/data-checklist/.test(bHtml) || !/data-checked="false"[^>]*>Milk/.test(bHtml)) throw new Error('checklist failed: ' + bHtml);
if (!/color:\s*rgb\(229, 72, 77\)/.test(bHtml) || !/background-color:\s*rgba\(255, 213, 0, 0.4\)/.test(bHtml)) throw new Error('colour/highlight failed: ' + bHtml);
step('mobile editor: size before typing, checklist via "[] ", red + highlight');
await A.click('.tab[data-tab="notes"]');
await A.waitForSelector('.note-item >> text=Shopping list', { timeout: 10000 });
await A.click('.note-item >> text=Shopping list');
await A.waitForSelector('#editor-text span[style*="xx-large"]', { timeout: 8000 });
await A.waitForSelector('#editor-text span[style*="rgb(229, 72, 77)"]', { timeout: 8000 });
step('formatting arrives on the laptop');
const li = await A.$('#editor-text ul[data-checklist] > li');
const box = await li.boundingBox();
await A.mouse.click(box.x + 10, box.y + 10);
await B.click('#btn-editor-back');
await B.waitForTimeout(300);
await B.click('.note-item >> text=Shopping list');
await B.waitForSelector('#editor-text li[data-checked="true"]', { timeout: 8000 });
step('checklist tick A → B');
// size change AFTER typing: select a word on A and make it Larger
await A.click('#editor-text li >> text=Bread');
await A.keyboard.press('End');
await A.keyboard.down('Shift'); for (let i = 0; i < 5; i++) await A.keyboard.press('ArrowLeft'); await A.keyboard.up('Shift');
await A.click('[data-fmt="size"]');
await A.click('.menu button:has-text("Larger")');
await B.waitForSelector('#editor-text span[style*="x-large"] >> text=Bread', { timeout: 8000 }).catch(async () => {
  await B.click('#btn-editor-back'); await B.waitForTimeout(300); await B.click('.note-item >> text=Shopping list');
  await B.waitForSelector('#editor-text span[style*="x-large"] >> text=Bread', { timeout: 8000 });
});
step('size change after typing syncs');
await A.click('[data-fmt="color"]');
await A.waitForTimeout(200);
await A.screenshot({ path: `${OUT}/08-desktop-notes-palette.png` });
await A.keyboard.press('Escape');
await A.click('#editor-text');

// Delete with undo on A, propagates to B
await A.click('.tab[data-tab="drops"]');
await A.click('.ri:has(.ri-title:text("Reply from phone")) [data-act="menu"]');
await A.click('.menu button.danger');
await A.waitForTimeout(5600);
await B.click('#btn-editor-back'); await B.waitForTimeout(250);
await B.click('.tabbar-btn[data-tab="drops"]');
await B.waitForFunction(() => !document.body.innerText.includes('Reply from phone'), null, { timeout: 8000 });
step('delete A → B');

// Offline edit on B, back online syncs
await ctxB.setOffline(true);
await B.waitForTimeout(500);
await B.fill('#composer-input', 'Written while offline');
await B.click('#btn-send');
await B.waitForTimeout(400);
await B.screenshot({ path: `${OUT}/09-mobile-offline.png` });
await ctxB.setOffline(false);
await B.evaluate(() => dispatchEvent(new Event('online')));
await A.waitForSelector('.ri-title >> text=Written while offline', { timeout: 20000 });
step('offline message synced after reconnect');

// Dark mode + settings on mobile
await B.emulateMedia({ colorScheme: 'dark' });
await B.evaluate(() => { localStorage.setItem('sp-theme', 'dark'); document.documentElement.dataset.theme = 'dark'; });
await B.click('#btn-settings');
await B.waitForTimeout(400);
await B.screenshot({ path: `${OUT}/10-mobile-settings-dark.png` });
await B.keyboard.press('Escape');
await B.screenshot({ path: `${OUT}/11-mobile-feed-dark.png` });

console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
