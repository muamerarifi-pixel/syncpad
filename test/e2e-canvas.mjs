// Freedom in Notes: pictures in normal notes (align, wrap, resize, move) and canvas notes
// (text boxes, shapes, arrows, emoji, pictures, pen; move / resize / rotate; undo; sync; convert).
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const watch = (p, n) => { p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${n}: ${m.text()}`); }); p.on('dialog', (d) => d.accept()); };
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const A = await ctxA.newPage(); watch(A, 'A');
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
const png = fs.readFileSync(new URL('../public/icons/icon-512.png', import.meta.url));
const objs = (P = A) => P.$$eval('.cv-obj', (l) => l.map((e) => ({ id: e.dataset.id, cls: e.className, left: parseFloat(e.style.left), top: parseFloat(e.style.top), w: parseFloat(e.style.width), h: e.offsetHeight, tr: e.style.transform })));
const centre = async (sel, P = A) => { const b = await P.locator(sel).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const drag = async (from, to, P = A) => { await P.mouse.move(from.x, from.y); await P.mouse.down(); await P.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 }); await P.mouse.move(to.x, to.y, { steps: 6 }); await P.mouse.up(); };

// ── 1) pictures in a normal note
await A.click('.tab[data-tab="notes"]');
await A.click('#btn-new-note');
await A.keyboard.type('Lesson pictures');
await A.keyboard.press('Enter');
await A.keyboard.type('This paragraph should wrap around the picture when it floats to the right side of the page. '.repeat(3));
await A.keyboard.press('Enter');
await A.setInputFiles('#note-file-input', [{ name: 'pic.png', mimeType: 'image/png', buffer: png }]);
await A.waitForSelector('#editor-text img[data-file]');
await A.waitForFunction(() => document.querySelector('#editor-text img').complete && document.querySelector('#editor-text img').naturalWidth > 0);
await A.click('#editor-text img');
await A.waitForSelector('.img-bar:not([hidden])');
await A.click('.img-bar [data-al="right"]');
let im = await A.$eval('#editor-text img', (i) => ({ al: i.dataset.align, w: i.style.width, float: getComputedStyle(i).float }));
if (im.al !== 'right' || parseFloat(im.w) !== 45 || im.float !== 'right') throw new Error('align right ' + JSON.stringify(im));
await A.click('.img-bar [data-act="bigger"]');
im = await A.$eval('#editor-text img', (i) => parseFloat(i.style.width));
if (im < 54 || im > 56) throw new Error('bigger ' + im);
const g = await centre('.img-grip');
await drag(g, { x: g.x - 120, y: g.y });
const w2 = await A.$eval('#editor-text img', (i) => parseFloat(i.style.width));
if (!(w2 > im + 5)) throw new Error('resize grip (right-aligned grows to the left) ' + w2);
// move the picture to the very start of the first paragraph
const firstP = await A.$eval('#editor-text > :nth-child(2)', (p) => { const r = p.getBoundingClientRect(); return { x: r.left + 2, y: r.top + 8 }; });
await drag(await centre('.img-bar [data-act="move"]'), firstP);
const order = await A.$eval('#editor-text', (e) => [...e.children].map((c) => (c.querySelector('img') ? 'IMG+' : '') + c.tagName).join(','));
if (!/^[A-Z0-9]+,IMG\+/.test(order) && !/^IMG\+/.test(order)) throw new Error('move picture: ' + order);
await A.screenshot({ path: `${OUT}/130-note-picture-wrap.png` });
await A.waitForTimeout(800);
step(`Normal note: picture floats right with text wrapping, − / + and corner drag resize (${w2.toFixed(0)}%), ✥ moves it into the text`);

// ── 2) a new canvas
await A.click('#btn-new-canvas');
await A.waitForSelector('#note-canvas:not([hidden]) .cv-world');
if (!(await A.isVisible('#cv-bar')) || (await A.isVisible('#fmt-bar'))) throw new Error('canvas toolbar');
await A.click('[data-cv="text"]');
await A.keyboard.type('Unit 5 – mind map');
await A.keyboard.press('Escape');
let o = await objs();
if (o.length !== 1 || !/cv-text/.test(o[0].cls)) throw new Error('text box ' + JSON.stringify(o));
// bigger + bold
await A.click('.cv-obj.cv-text');
await A.click('[data-cv="bigger"]');
await A.click('[data-cv="bold"]');
const fs1 = await A.$eval('.cv-tx', (t) => [t.style.fontSize, t.style.fontWeight]);
if (fs1[0] !== '30px' || fs1[1] !== '700') throw new Error('text style ' + fs1);
// shapes
await A.click('[data-cv="shapes"]');
await A.click('.cv-pop [data-k="ellipse"]');
await A.click('[data-cv="shapes"]');
await A.click('.cv-pop [data-k="star"]');
o = await objs();
if (o.filter((x) => /cv-shape/.test(x.cls)).length !== 2) throw new Error('shapes');
// move the star
const star = o[o.length - 1];
const before = { left: star.left, top: star.top };
const sc = await centre(`.cv-obj[data-id="${star.id}"]`);
await drag(sc, { x: sc.x + 200, y: sc.y + 150 });
o = await objs();
let st = o.find((x) => x.id === star.id);
if (!(st.left > before.left + 150 && st.top > before.top + 100)) throw new Error('move star ' + JSON.stringify([before, st]));
// resize via the corner handle
await drag(await centre('.cv-h-se'), { x: (await centre('.cv-h-se')).x + 80, y: (await centre('.cv-h-se')).y + 80 });
st = (await objs()).find((x) => x.id === star.id);
if (!(st.w > star.w + 50)) throw new Error('resize star');
// rotate
const rc = await centre('.cv-h-rot');
const cc = await centre(`.cv-obj[data-id="${star.id}"]`);
await drag(rc, { x: cc.x + 200, y: cc.y });
st = (await objs()).find((x) => x.id === star.id);
if (!/rotate\(9\d/.test(st.tr)) throw new Error('rotate ' + st.tr);
// fill colour
await A.click('[data-cv="fill"]');
await A.click('.cv-pop [data-c="#d0ebff"]');
if (!(await A.$eval(`.cv-obj[data-id="${star.id}"] polygon`, (p) => p.style.fill)).includes('208, 235, 255')) throw new Error('fill');
step('Canvas: text box (bigger, bold), circle and star; star dragged, resized from the corner, rotated 90°, recoloured');

// arrow + endpoint drag
await A.click('[data-cv="lines"]');
await A.click('.cv-pop [data-k="arrow"]');
const p2 = await centre('.cv-h[data-h="p2"]');
await drag(p2, { x: p2.x + 40, y: p2.y + 120 });
const line = await A.$eval('.cv-obj.cv-line', (e) => e.querySelectorAll('polygon').length);
if (line !== 1) throw new Error('arrow head');
// emoji
await A.click('[data-cv="emoji"]');
await A.click('.cv-pop [data-cat="✅"]');
await A.click('.cv-pop [data-e="⭐"]');
// picture
await A.setInputFiles('.cv-file', [{ name: 'photo.png', mimeType: 'image/png', buffer: png }]);
await A.waitForSelector('.cv-obj.cv-img img');
await A.waitForFunction(() => document.querySelector('.cv-obj.cv-img img').naturalWidth > 0);
// pen
await A.click('[data-cv="pen"]');
const wr = await A.$eval('.cv-world', (w) => { const r = w.getBoundingClientRect(); return { x: r.left, y: r.top }; });
await A.mouse.move(wr.x + 80, wr.y + 600); await A.mouse.down();
for (let k = 1; k <= 12; k++) await A.mouse.move(wr.x + 80 + k * 18, wr.y + 600 + Math.sin(k / 2) * 30);
await A.mouse.up();
await A.click('[data-cv="pen"]');
o = await objs();
const kinds = o.map((x) => x.cls.replace('cv-obj cv-', '').replace(' on', '')).sort().join(',');
if (kinds !== 'emoji,img,line,pen,shape,shape,text') throw new Error('kinds ' + kinds);
// undo / redo
await A.click('[data-cv="undo"]');
if ((await objs()).length !== 6) throw new Error('undo');
await A.click('[data-cv="redo"]');
if ((await objs()).length !== 7) throw new Error('redo');
// duplicate + delete with keys
await A.$eval('.cv-obj.cv-emoji', (e) => { const r = e.getBoundingClientRect(); const o = { bubbles: true, pointerId: 7, clientX: r.left + 5, clientY: r.top + 5, button: 0, pointerType: 'mouse' }; e.dispatchEvent(new PointerEvent('pointerdown', o)); e.closest('.cv-world').dispatchEvent(new PointerEvent('pointerup', o)); });
await A.keyboard.press('Control+d');
if ((await objs()).length !== 8) throw new Error('duplicate');
await A.keyboard.press('Delete');
if ((await objs()).length !== 7) throw new Error('delete');
await A.screenshot({ path: `${OUT}/131-canvas.png` });
step('Arrow (end dragged), emoji, picture, pen drawing; Undo / Redo, Ctrl+D duplicate, Delete');

// ── 3) saved and synced: reload, and a second device sees the same canvas
await A.waitForTimeout(1500);
const layoutA = (await objs()).map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.w)].join(':')).sort().join('|');
await A.reload();
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });
await A.click('.tab[data-tab="notes"]');
await A.click('.note-item:has-text("Unit 5")');
await A.waitForSelector('.cv-obj.cv-img');
const layoutR = (await objs()).map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.w)].join(':')).sort().join('|');
if (layoutR !== layoutA) throw new Error('reload layout differs');
if (!(await A.$eval('.note-item:has-text("Unit 5") .t', (t) => !!t.querySelector('use[href="#i-canvas"]')))) throw new Error('list icon');
step('Saved: after reload every item is exactly where it was; the list marks it as a canvas');

// a phone on the same link sees the same canvas
{
  const ctxB = await browser.newContext({ ...devices['Pixel 7'] });
  const B = await ctxB.newPage(); watch(B, 'B');
  await B.goto(BASE + '/');
  await B.waitForSelector('.status-chip[data-state="online"]', { timeout: 20000 });
  await A.click('#btn-connect');
  await A.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('#pair-code').textContent));
  const code = (await A.textContent('#pair-code')).replace(/\D/g, '');
  await A.keyboard.press('Escape');
  await B.click('#btn-connect');
  await B.fill('#join-code', code);
  await B.waitForSelector('.toast >> text=Connected');
  await B.click('.tabbar-btn[data-tab="notes"]');
  await B.click('.note-item:has-text("Unit 5")');
  await B.waitForSelector('.cv-obj.cv-img', { timeout: 10000 });
  const layoutB = (await objs(B)).map((x) => [Math.round(x.left), Math.round(x.top), Math.round(x.w)].join(':')).sort().join('|');
  if (layoutB !== layoutA) throw new Error('phone layout differs');
  const fit = await B.evaluate(() => [document.querySelector('.cv-stage').getBoundingClientRect().width, innerWidth]);
  if (fit[0] > fit[1]) throw new Error('canvas wider than the phone ' + fit);
  const t = await B.locator('.cv-obj.cv-text').boundingBox();
  await B.touchscreen.tap(t.x + 10, t.y + 5);
  await B.waitForSelector('.cv-sel:not([hidden])');
  await B.screenshot({ path: `${OUT}/132-canvas-phone.png` });
  step(`Phone: same layout scaled to the screen (${Math.round(fit[0])}px of ${fit[1]}px), tap selects`);
  await ctxB.close();
}

// ── 4) turn a normal note into a canvas and back
await A.click('.note-item:has-text("Lesson pictures")');
await A.waitForSelector('#editor-text img');
await A.click('#btn-note-more');
await A.click('.menu button:has-text("Turn into canvas")');
await A.waitForSelector('#note-canvas:not([hidden]) .cv-obj.cv-img');
o = await objs();
if (o.filter((x) => /cv-text/.test(x.cls)).length < 1 || o.filter((x) => /cv-img/.test(x.cls)).length !== 1) throw new Error('to canvas ' + JSON.stringify(o));
const tops = o.map((x) => x.top);
if (new Set(tops).size !== tops.length) throw new Error('blocks overlap');
await A.click('#btn-note-more');
await A.click('.menu button:has-text("Turn into normal note")');
await A.waitForSelector('#editor-text:not([hidden]) img[data-file]');
if (!(await A.$eval('#editor-text', (e) => /Lesson pictures/.test(e.innerText)))) throw new Error('back to note');
step('“Turn into canvas” makes text blocks and the picture movable; “Turn into normal note” brings it back');

if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
