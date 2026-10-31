// 2.17: Notes opens on the list/grid (no note forced open); canvas page can be cropped to any shape.
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const A = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
A.on('pageerror', (e) => errors.push(e.message));
A.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.click('.tab[data-tab="notes"]');
await A.click('#btn-new-canvas');
await A.click('[data-cv="shapes"]'); await A.click('.cv-pop [data-k="star"]');
await A.setInputFiles('.cv-file', [{ name: 'p.png', mimeType: 'image/png', buffer: fs.readFileSync(new URL('../public/icons/icon-512.png', import.meta.url)) }]);
await A.waitForSelector('.cv-obj.cv-img');
await A.waitForTimeout(600);
// crop the page to the content
await A.click('[data-cv="page"]');
await A.waitForSelector('.cv-pagecrop');
await A.click('[data-cv="crop-fit"]');
// then pull the right edge in a little more (free aspect ratio)
const e = await A.locator('.cv-ph[data-ph="s"]').boundingBox();
await A.mouse.move(e.x + e.width / 2, e.y + e.height / 2); await A.mouse.down(); await A.mouse.move(e.x + e.width / 2, e.y - 40, { steps: 4 }); await A.mouse.up();
await A.screenshot({ path: `${OUT}/160-page-crop.png` });
await A.click('[data-cv="crop-done"]');
const pg = await A.$eval('.cv-world', (w) => ({ w: parseFloat(w.style.width), h: parseFloat(w.style.height), clip: getComputedStyle(w).overflow }));
if (!(pg.w < 700 && pg.h < 900 && pg.clip === 'hidden')) throw new Error('crop ' + JSON.stringify(pg));
await A.screenshot({ path: `${OUT}/161-page-cropped.png` });
await A.click('[data-cv="undo"]');
if (parseFloat(await A.$eval('.cv-world', (w) => w.style.width)) !== 1000) throw new Error('undo crop');
await A.click('[data-cv="redo"]');
await A.waitForTimeout(1200);
step(`Canvas page cropped to ${pg.w} × ${pg.h} (blank space gone, any shape); Undo / Redo work`);
// export starts from the cropped page
await A.click('[data-cv="export"]');
await A.waitForSelector('dialog.cvx[open] .cvx-img');
await A.waitForFunction(() => document.querySelector('.cvx-img').naturalWidth > 0);
const sz = await A.textContent('.cvx-size');
if (sz !== `${pg.w * 2} × ${pg.h * 2} px`) throw new Error('export size ' + sz);
await A.click('dialog.cvx [data-x]');
step(`Save as PNG/PDF uses the cropped page (${sz})`);
// reload: Notes shows the list only; a click opens the note; Back returns to the list
await A.reload();
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.click('.tab[data-tab="notes"]');
await A.waitForSelector('.note-item');
if (await A.isVisible('#editor-pane')) throw new Error('a note opened by itself');
const lw = await A.$eval('.notes-pane', (p) => p.getBoundingClientRect().width);
if (lw < 1000) throw new Error('list not full width ' + lw);
await A.screenshot({ path: `${OUT}/162-notes-list-only.png` });
await A.click('.note-item');
await A.waitForSelector('.cv-world');
if (parseFloat(await A.$eval('.cv-world', (w) => w.style.width)) !== pg.w) throw new Error('crop not saved');
await A.click('#btn-editor-back');
if (await A.isVisible('#editor-pane')) throw new Error('back');
step('Notes opens on the list/grid only (full width); clicking opens the note, Back returns; the cropped page was saved');
if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
