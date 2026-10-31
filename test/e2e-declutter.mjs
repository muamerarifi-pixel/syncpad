// De-clutter: AI text pasted into Drops becomes clean plain text, into Notes becomes real formatting;
// Undo / Ctrl+Shift+V / the Settings switch keep the original.
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log('•', s);
const browser = await chromium.launch();
const errors = [];
const A = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
A.on('pageerror', (e) => errors.push(e.message));
A.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await A.goto(BASE + '/');
await A.waitForSelector('.status-chip[data-state="online"]', { timeout: 15000 });

const AI = `Sure! Here's a clear plan for the lesson:

## 🚀 Week 10 Plan

**Goal:** finish *Unit 5* and review vocabulary【4†source】.

---

1. **Warm-up** — 10 minutes ([BBC](https://www.bbc.com/learning?utm_source=chatgpt.com))
2. Reading: "The Story"[1][2]
   - underline new words
   - discuss \`present perfect\`

- [ ] print worksheets
- [x] book the room

| Group | Day | Time |
|---|---|---|
| FF1 | Mon | 17:00 |
| EP2 | **Wed** | 18:30 |

The area is \\( \\frac{a}{b} \\times 2^2 \\) cm​.

If you want, I can also:

* make a shorter version
* translate it to Albanian

Hope this helps! 😊`;

const paste = (sel, text, html = '') => A.evaluate(([sel, text, html]) => {
  const t = document.querySelector(sel);
  t.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  if (html) dt.setData('text/html', html);
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  t.dispatchEvent(ev);
  return ev.defaultPrevented;
}, [sel, text, html]);

// 1) Drops: clean plain text
await paste('#composer-input', AI);
let v = await A.inputValue('#composer-input');
console.log(v.split('\n').map((l) => '    ' + l).join('\n'));
for (const bad of ['**', '##', '【', '[1]', 'utm_source', 'Sure!', 'Hope this helps', 'If you want', '---', '\\(', '​', '|---']) if (v.includes(bad)) throw new Error('drop still has ' + bad);
for (const good of ['Week 10 Plan', 'Goal: finish Unit 5', '1. Warm-up', '◦ underline new words', '☐ print worksheets', '☑ book the room', 'FF1 · Mon · 17:00', 'a/b × 2² cm.']) if (!v.includes(good)) throw new Error('drop is missing ' + good);
await A.waitForSelector('.toast >> text=Cleaned AI text');
await A.screenshot({ path: `${OUT}/120-declutter-drop.png` });
await A.locator('.toast button:has-text("Undo")').last().click();
v = await A.inputValue('#composer-input');
if (v !== AI) throw new Error('undo did not restore the original');
await A.fill('#composer-input', '');
await paste('#composer-input', AI);
await A.click('#btn-send');
await A.waitForSelector('.ri >> text=Goal: finish Unit 5');
step('Drops: AI text pasted as clean plain text (bullets, checkboxes, table rows, maths); Undo brings back the original');

// 2) normal text is left alone
if (await paste('#composer-input', 'Hi team,\n\nThe meeting moved to 3pm.\n\nLet me know if you can\'t make it.')) throw new Error('normal text was changed');
step('Ordinary text is pasted untouched');

// 3) Ctrl+Shift+V keeps the original
await A.focus('#composer-input');
await A.keyboard.down('Control'); await A.keyboard.down('Shift'); await A.keyboard.press('V'); await A.keyboard.up('Shift'); await A.keyboard.up('Control');
if (await paste('#composer-input', AI)) throw new Error('Ctrl+Shift+V should paste raw');
step('Ctrl+Shift+V pastes it exactly as copied');

// 4) Notes: real formatting
await A.click('.tab[data-tab="notes"]');
await A.click('#btn-new-note');
await A.waitForSelector('#editor-text:focus');
await paste('#editor-text', AI);
const note = await A.$eval('#editor-text', (e) => ({
  html: e.innerHTML,
  h2: e.querySelector('h2')?.textContent,
  strong: !!e.querySelector('strong, b'),
  em: !!e.querySelector('em, i'),
  ol: e.querySelectorAll('ol > li').length,
  check: e.querySelectorAll('ul[data-checklist] > li').length,
  checked: !!e.querySelector('li[data-checked="true"]'),
  table: e.querySelectorAll('table tr').length,
  code: !!e.querySelector('code'),
  text: e.innerText
}));
for (const bad of ['**', '##', '【', '[1]', 'Sure!', 'Hope this helps', 'If you want']) if (note.text.includes(bad)) throw new Error('note still has ' + bad);
if (note.h2 !== 'Week 10 Plan' || !note.strong || !note.em || note.ol !== 2 || note.check !== 2 || !note.checked || note.table !== 3 || !note.code) { console.log(note); throw new Error('note formatting'); }
await A.screenshot({ path: `${OUT}/121-declutter-note.png` });
await A.locator('.toast button:has-text("Undo")').last().click();
if (!(await A.$eval('#editor-text', (e) => e.innerText.includes('**Goal:**')))) throw new Error('note undo');
step(`Notes: heading, bold, italic, numbered list, checklist, table (${note.table} rows) and code — no ** or ## left; Undo works`);

// 5) the "De-clutter text" button cleans what is already in a note
await A.click('#btn-note-more');
await A.click('.menu button:has-text("De-clutter text")');
await A.waitForSelector('#editor-text h2');
const t2 = await A.$eval('#editor-text', (e) => e.innerText);
if (/\*\*|##|Hope this helps/.test(t2)) throw new Error('de-clutter note button');
step('“De-clutter text” in the note menu cleans an existing note');

// 6) formatted copy from the ChatGPT page (no markdown): chips, hidden marks and filler removed
await A.evaluate(() => { const e = document.querySelector('#editor-text'); e.innerHTML = '<p><br></p>'; e.focus(); });
const html = '<p data-start="0" data-end="20">Sure! Here is the summary:</p><h4 data-start="1">Key points</h4><p data-start="2">Kosovo declared independence in 2008.​ <span><a href="https://en.wikipedia.org/wiki/Kosovo?utm_source=chatgpt.com"><span>Wikipedia</span></a></span></p><hr><ul><li><p>🔹 First idea</p></li><li><p>Second idea</p></li></ul><p>Let me know if you want more details!</p>';
const text = 'Sure! Here is the summary:\nKey points\nKosovo declared independence in 2008. Wikipedia\n🔹 First idea\nSecond idea\nLet me know if you want more details!';
await paste('#editor-text', text, html);
const n3 = await A.$eval('#editor-text', (e) => ({ text: e.innerText, h3: e.querySelector('h3')?.textContent, hr: !!e.querySelector('hr'), li: e.querySelectorAll('li').length }));
if (/Sure!|Wikipedia|Let me know|🔹|​/.test(n3.text) || n3.h3 !== 'Key points' || n3.hr || n3.li !== 2) { console.log(n3); throw new Error('html paste'); }
step('Formatted copy from a chat page: source chips, hidden marks, emoji and filler removed, structure kept');

// 7) Settings switch off → untouched
await A.click('#btn-settings').catch(() => A.click('[aria-label="Settings"]'));
await A.waitForSelector('#dlg-settings[open]');
await A.selectOption('#set-declutter', 'off');
await A.keyboard.press('Escape');
await A.click('.tab[data-tab="drops"]');
if (await paste('#composer-input', AI)) throw new Error('setting off still cleans');
await A.click('#btn-settings').catch(() => A.click('[aria-label="Settings"]'));
await A.selectOption('#set-declutter', 'plain');
await A.keyboard.press('Escape');
await paste('#composer-input', 'Here’s the plan:\n\n**Step one** — call “Ana”…\n\n- a\n- b');
v = await A.inputValue('#composer-input');
if (!v.includes('Step one - call "Ana"...')) throw new Error('plain punctuation: ' + v);
step('Settings: Off pastes as is; “plain dashes and quotes” also swaps — “ ” …');

if (errors.length) { console.log(errors); throw new Error('page errors'); }
await browser.close();
console.log('ALL OK');
