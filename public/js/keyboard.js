/* SyncPad keyboard — an optional on-screen keyboard (English / Albanian) that replaces the phone's own.
   It types straight into the note or the write box, keeps undo, never takes the screen over:
   compact rows, instant keys (fires on touch-down), slide on the space bar to move the cursor,
   hold ⌫ to delete fast, ⇧ once = one capital, twice = CAPS. */

const LAYOUTS = {
  en: [['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫']],
  sq: [['q', 'w', 'e', 'r', 't', 'z', 'u', 'i', 'o', 'p', 'ç'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ë'], ['⇧', 'y', 'x', 'c', 'v', 'b', 'n', 'm', '⌫']]
};
const SYMBOLS = [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], ['@', '#', '€', '&', '-', '+', '(', ')', '/', '"'], ['=\\<', '*', "'", ':', ';', '!', '?', '%', '⌫']];
const SYMBOLS2 = [['~', '`', '|', '•', '√', 'π', '÷', '×', '§', '°'], ['$', '£', '¥', '^', '_', '[', ']', '{', '}', '<'], ['123', '>', '\\', '©', '®', '™', '✓', '…', '⌫']];

export function createKeyboard({ isTarget, onShow, onHide }) {
  const box = document.createElement('div');
  box.className = 'skb';
  box.hidden = true;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'SyncPad keyboard');
  document.body.append(box);
  let lang = localStorage.getItem('sp-kb-lang') === 'en' ? 'en' : 'sq';
  let page = 'abc'; // abc | sym | sym2
  let shift = 0; // 0 off, 1 once, 2 caps lock
  let lastShift = 0;
  let target = null;

  const rows = () => (page === 'sym' ? SYMBOLS : page === 'sym2' ? SYMBOLS2 : LAYOUTS[lang]);
  function render() {
    const r = rows();
    const keys = (row) => row.map((k) => {
      if (k === '⇧') return `<button class="k k-fn k-shift${shift ? ' on' : ''}${shift === 2 ? ' lock' : ''}" data-k="shift" aria-label="Shift">⇧</button>`;
      if (k === '⌫') return `<button class="k k-fn k-del" data-k="del" aria-label="Delete">⌫</button>`;
      if (k === '=\\<') return `<button class="k k-fn" data-k="sym2">=\\&lt;</button>`;
      if (k === '123') return `<button class="k k-fn" data-k="sym">123</button>`;
      const ch = page === 'abc' && shift ? k.toUpperCase() : k;
      return `<button class="k" data-ch="${ch.replace(/"/g, '&quot;')}">${ch.replace(/</g, '&lt;')}</button>`;
    }).join('');
    box.innerHTML = `
      <div class="skb-row">${keys(r[0])}</div>
      <div class="skb-row${r[1].length < r[0].length ? ' inset' : ''}">${keys(r[1])}</div>
      <div class="skb-row">${keys(r[2])}</div>
      <div class="skb-row skb-bottom">
        <button class="k k-fn" data-k="${page === 'abc' ? 'sym' : 'abc'}">${page === 'abc' ? '?123' : 'ABC'}</button>
        <button class="k k-fn k-lang" data-k="lang" aria-label="Language">${lang === 'sq' ? 'SQ' : 'EN'}</button>
        <button class="k" data-ch=",">,</button>
        <button class="k k-space" data-k="space" aria-label="Space — slide to move the cursor">${lang === 'sq' ? 'Shqip' : 'English'}</button>
        <button class="k" data-ch=".">.</button>
        <button class="k k-fn" data-k="hide" aria-label="Hide keyboard">⌄</button>
        <button class="k k-fn k-enter" data-k="enter" aria-label="New line">⏎</button>
      </div>`;
  }

  /* typing into the note (contenteditable) or a text box, keeping undo */
  const isText = () => target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
  function type(s) {
    if (!target) return;
    if (document.activeElement !== target) target.focus({ preventScroll: true });
    if (!document.execCommand('insertText', false, s) && isText()) {
      const a = target.selectionStart, b = target.selectionEnd;
      target.setRangeText(s, a, b, 'end');
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    keepCaretVisible();
  }
  function del() {
    if (!target) return;
    if (document.activeElement !== target) target.focus({ preventScroll: true });
    if (!document.execCommand('delete') && isText()) {
      const a = target.selectionStart, b = target.selectionEnd;
      if (a === b && a > 0) target.setRangeText('', a - 1, a, 'end');
      else target.setRangeText('', a, b, 'end');
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  function enter() {
    if (!target) return;
    if (isText()) { type('\n'); return; }
    // the note's own Enter logic (lists, checklists) listens to the key; fall back to a new paragraph
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    if (target.dispatchEvent(ev)) document.execCommand('insertParagraph');
    keepCaretVisible();
  }
  function moveCaret(n) {
    const sel = getSelection();
    if (isText()) { const p = Math.max(0, Math.min(target.value.length, target.selectionStart + n)); target.setSelectionRange(p, p); return; }
    for (let i = 0; i < Math.abs(n); i++) sel.modify('move', n > 0 ? 'forward' : 'backward', 'character');
    keepCaretVisible();
  }
  function keepCaretVisible() {
    const sel = getSelection();
    if (!sel.rangeCount || isText()) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const limit = box.getBoundingClientRect().top - 12;
    if (r.bottom > limit && r.height) {
      let sc = target;
      while (sc && sc !== document.body && !(sc.scrollHeight > sc.clientHeight && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
      if (sc && sc !== document.body) sc.scrollTop += r.bottom - limit + 24;
    }
  }

  /* keys fire on touch-down for speed; held ⌫ repeats; the space bar slides the cursor */
  let rep = 0, repT = 0, slide = null;
  const stopRepeat = () => { clearTimeout(repT); clearInterval(rep); repT = rep = 0; };
  box.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.k');
    e.preventDefault(); // never take focus away from the text
    if (!b) return;
    b.classList.add('down');
    try { navigator.vibrate && navigator.vibrate(8); } catch {}
    const k = b.dataset.k;
    if (b.dataset.ch) {
      type(b.dataset.ch);
      if (shift === 1) { shift = 0; render(); }
      return;
    }
    if (k === 'del') { del(); repT = setTimeout(() => { rep = setInterval(del, 55); }, 380); return; }
    if (k === 'space') { slide = { x: e.clientX, moved: 0 }; b.setPointerCapture(e.pointerId); return; }
    if (k === 'shift') { const now = Date.now(); shift = shift === 0 ? (now - lastShift < 320 ? 2 : 1) : (shift === 1 && now - lastShift < 320 ? 2 : 0); lastShift = now; render(); return; }
    if (k === 'enter') { enter(); return; }
    if (k === 'sym' || k === 'sym2' || k === 'abc') { page = k; render(); return; }
    if (k === 'lang') { lang = lang === 'sq' ? 'en' : 'sq'; try { localStorage.setItem('sp-kb-lang', lang); } catch {} render(); return; }
    if (k === 'hide') { hide(true); }
  });
  box.addEventListener('pointermove', (e) => {
    if (!slide) return;
    const steps = Math.trunc((e.clientX - slide.x) / 14);
    if (steps) { moveCaret(steps); slide.x += steps * 14; slide.moved += Math.abs(steps); }
  });
  const up = (e) => {
    stopRepeat();
    for (const d of box.querySelectorAll('.k.down')) d.classList.remove('down');
    if (slide) { if (!slide.moved && e.type === 'pointerup') type(' '); slide = null; }
  };
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);
  box.addEventListener('contextmenu', (e) => e.preventDefault());

  /* show for the note and the write box; the phone's keyboard stays closed (inputmode none) */
  function show(t) {
    target = t;
    if (!box.hidden) return;
    page = 'abc';
    render();
    box.hidden = false;
    document.documentElement.style.setProperty('--skb-h', box.offsetHeight + 'px');
    document.documentElement.classList.add('skb-on');
    onShow && onShow();
    requestAnimationFrame(keepCaretVisible);
  }
  function hide(blur) {
    if (box.hidden) return;
    box.hidden = true;
    document.documentElement.classList.remove('skb-on');
    if (blur && target) target.blur();
    onHide && onHide();
  }
  let enabled = false;
  const mark = (on) => { for (const t of document.querySelectorAll('#editor-text, #composer-input')) { if (on) t.setAttribute('inputmode', 'none'); else if (!(t.id === 'editor-text' && t.classList.contains('sel-mode'))) t.removeAttribute('inputmode'); } };
  document.addEventListener('focusin', (e) => { if (enabled && isTarget(e.target)) show(e.target); else if (!box.contains(e.target)) hide(false); });
  document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement || !isTarget(document.activeElement)) hide(false); }, 120));
  // tapping into the text again brings the keyboard back after it was hidden
  document.addEventListener('pointerup', (e) => { if (enabled && box.hidden && isTarget(document.activeElement) && document.activeElement.contains(e.target)) show(document.activeElement); });
  return {
    setEnabled(on) { enabled = !!on; mark(enabled); if (!enabled) hide(false); else if (isTarget(document.activeElement)) show(document.activeElement); },
    get enabled() { return enabled; },
    refreshTargets() { mark(enabled); }
  };
}
