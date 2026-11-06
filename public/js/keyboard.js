/* SyncPad keyboard — an optional on-screen keyboard (English / Albanian) that replaces the phone's own.
   It types straight into the note or the write box, keeps undo, never takes the screen over:
   compact rows, instant keys (fires on touch-down), slide on the space bar to move the cursor,
   hold ⌫ to delete fast, ⇧ once = one capital, twice = CAPS. */

// the same key positions as the phone's own (Samsung-style) English keyboard, for both languages;
// Albanian adds an Ë key on the bottom row and Ç on a long press of C
const QWERTY = [['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫']];
const LAYOUTS = { en: QWERTY, sq: QWERTY };
// hold a key for its second character (shown small in the corner): numbers on the top row, ç on C, comma on the full stop
const ALT = { q: '1', w: '2', e: '3', r: '4', t: '5', y: '6', u: '7', i: '8', o: '9', p: '0', c: 'ç', '.': ',' };
const SPK = '<path d="M4 9.5h3.2L11.5 6v12l-4.3-3.5H4z"/>';
const SPK_ON = `<svg class="ic" viewBox="0 0 24 24">${SPK}<path d="M15 9.2a4 4 0 0 1 0 5.6M17.6 6.8a7.5 7.5 0 0 1 0 10.4"/></svg>`;
const SPK_OFF = `<svg class="ic" viewBox="0 0 24 24">${SPK}<path d="m15.5 10 4 4m0-4-4 4"/></svg>`;
const SYMBOLS = [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], ['@', '#', '€', '&', '-', '+', '(', ')', '/', '"'], ['=\\<', ',', '*', "'", ':', ';', '!', '?', '⌫']];
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
  let kh = Math.max(36, Math.min(84, Number(localStorage.getItem('sp-kb-h')) || 54));
  const setH = (h) => {
    kh = Math.max(36, Math.min(84, Math.round(h)));
    box.style.setProperty('--kh', kh + 'px');
    try { localStorage.setItem('sp-kb-h', String(kh)); } catch {}
    if (!box.hidden) document.documentElement.style.setProperty('--skb-h', box.offsetHeight + 'px');
  };
  box.style.setProperty('--kh', kh + 'px');
  /* how high the keyboard sits above the bottom edge */
  let lift = Math.max(0, Math.min(200, Number(localStorage.getItem('sp-kb-lift')) || 0));
  const setLift = (v) => {
    lift = Math.max(0, Math.min(200, v));
    box.style.setProperty('--lift', lift + 'px');
    try { localStorage.setItem('sp-kb-lift', String(lift)); } catch {}
    if (!box.hidden) document.documentElement.style.setProperty('--skb-h', box.offsetHeight + 'px');
  };
  box.style.setProperty('--lift', lift + 'px');
  /* optional key sound (off by default; no vibration) */
  let sound = localStorage.getItem('sp-kb-sound') === '1';
  let ac = null;
  function click() {
    if (!sound) return;
    try {
      ac ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'triangle'; o.frequency.value = 1800;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.045);
      o.connect(g).connect(ac.destination);
      o.start(); o.stop(ac.currentTime + 0.05);
    } catch {}
  }
  const reopen = document.createElement('button');
  reopen.className = 'skb-open';
  reopen.hidden = true;
  reopen.setAttribute('aria-label', 'Show keyboard');
  reopen.innerHTML = '⌨<span>Keyboard</span>';
  document.body.append(reopen);
  reopen.addEventListener('pointerdown', (e) => { e.preventDefault(); if (target) show(target); });

  const rows = () => (page === 'sym' ? SYMBOLS : page === 'sym2' ? SYMBOLS2 : LAYOUTS[lang]);
  function render() {
    const r = rows();
    const keys = (row) => row.map((k) => {
      if (k === '⇧') return `<button class="k k-fn k-shift${shift ? ' on' : ''}${shift === 2 ? ' lock' : ''}" data-k="shift" aria-label="Shift">⇧</button>`;
      if (k === '⌫') return `<button class="k k-fn k-del" data-k="del" aria-label="Delete">⌫</button>`;
      if (k === '=\\<') return `<button class="k k-fn" data-k="sym2">=\\&lt;</button>`;
      if (k === '123') return `<button class="k k-fn" data-k="sym">123</button>`;
      const ch = page === 'abc' && shift ? k.toUpperCase() : k;
      const label = page === 'abc' ? k.toUpperCase() : k;
      const alt = page === 'abc' && ALT[k] && !(k === 'c' && lang !== 'sq') ? (shift ? ALT[k].toUpperCase() : ALT[k]) : '';
      return `<button class="k" data-ch="${ch.replace(/"/g, '&quot;')}"${alt ? ` data-alt="${alt}"` : ''}>${label.replace(/</g, '&lt;')}${alt ? `<sup>${alt}</sup>` : ''}</button>`;
    }).join('');
    box.innerHTML = `
      <div class="skb-bar" data-bar="1">
        <span class="skb-size">
          <button class="skb-mini" data-k="smaller" aria-label="Smaller keys">A−</button>
          <span class="skb-grip" aria-hidden="true"></span>
          <button class="skb-mini" data-k="bigger" aria-label="Bigger keys">A+</button>
        </span>
        <span class="skb-tools">
          <button class="skb-mini" data-k="sound" aria-label="Key sound" aria-pressed="${sound}">${sound ? SPK_ON : SPK_OFF}</button>
          <button class="skb-mini" data-k="lift-down" aria-label="Move the keyboard down">▼</button>
          <button class="skb-mini" data-k="lift-up" aria-label="Move the keyboard up">▲</button>
          <button class="skb-hide" data-k="hide" aria-label="Hide keyboard">Hide <b>⌄</b></button>
        </span>
      </div>
      <div class="skb-row">${keys(r[0])}</div>
      <div class="skb-row${r[1].length < r[0].length ? ' inset' : ''}">${keys(r[1])}</div>
      <div class="skb-row">${keys(r[2])}</div>
      <div class="skb-row skb-bottom">
        <button class="k k-fn k-sym" data-k="${page === 'abc' ? 'sym' : 'abc'}">${page === 'abc' ? '!#1' : 'ABC'}</button>
        <button class="k k-space" data-k="space" aria-label="Space — slide to move the cursor"><span class="k-lang" data-k="lang" aria-label="Switch language">‹</span><span>${lang === 'sq' ? 'Shqip' : 'English (US)'}</span><span class="k-lang" data-k="lang" aria-label="Switch language">›</span></button>
        ${lang === 'sq' && page === 'abc' ? `<button class="k k-e" data-ch="${shift ? 'Ë' : 'ë'}">Ë</button>` : ''}
        <button class="k k-dot" data-ch="." data-alt=",">.<sup>,</sup></button>
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
  let rep = 0, repT = 0, slide = null, hold = null, dsl = null;
  /* where the cursor was when ⌫ went down, then select n words back from there */
  function caretStart() {
    if (isText()) return { pos: target.selectionEnd };
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return { node: r.endContainer, off: r.endOffset };
  }
  function selectWordsBack(st, n) {
    if (!st || !target) return;
    if (isText()) {
      let p = st.pos;
      const v = target.value;
      for (let i = 0; i < n && p > 0; i++) { while (p > 0 && /\s/.test(v[p - 1])) p--; while (p > 0 && !/\s/.test(v[p - 1])) p--; }
      target.setSelectionRange(p, st.pos, 'backward');
      return;
    }
    const sel = getSelection();
    try { sel.collapse(st.node, st.off); } catch { return; }
    for (let i = 0; i < n; i++) sel.modify('extend', 'backward', 'word');
  }
  const afterChar = () => { if (shift === 1) { shift = 0; render(); } };
  const stopRepeat = () => { clearTimeout(repT); clearInterval(rep); repT = rep = 0; };
  box.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.k, .skb-mini, .skb-hide');
    e.preventDefault(); // never take focus away from the text
    if (!b) {
      if (e.target.closest('[data-bar]')) { drag = { y: e.clientY, h: kh }; box.setPointerCapture(e.pointerId); box.classList.add('resizing'); }
      return;
    }
    if (b.classList.contains('skb-mini')) {
      const m = b.dataset.k;
      if (m === 'sound') { sound = !sound; try { localStorage.setItem('sp-kb-sound', sound ? '1' : '0'); } catch {} click(); render(); return; }
      if (m === 'lift-up') { setLift(lift + 16); return; }
      if (m === 'lift-down') { setLift(lift - 16); return; }
      setH(kh + (m === 'bigger' ? 6 : -6));
      return;
    }
    b.classList.add('down');
    click();
    const k = b.dataset.k;
    // the arrows on the space bar switch the language
    if (e.target.closest('.k-lang')) { lang = lang === 'sq' ? 'en' : 'sq'; try { localStorage.setItem('sp-kb-lang', lang); } catch {} render(); return; }
    if (b.dataset.ch) {
      if (b.dataset.alt) {
        // a quick tap types the letter, holding types the small character in the corner
        hold = { ch: b.dataset.ch, alt: b.dataset.alt, done: false };
        hold.t = setTimeout(() => { if (hold) { hold.done = true; type(hold.alt); click(); afterChar(); } }, 330);
        return;
      }
      type(b.dataset.ch);
      afterChar();
      return;
    }
    if (k === 'del') {
      // tap = delete one; hold = delete fast; slide left = select words backwards, let go = delete them
      dsl = { x0: e.clientX, n: 0, sliding: false, start: caretStart() };
      b.setPointerCapture(e.pointerId);
      repT = setTimeout(() => { if (dsl && !dsl.sliding) { dsl.repeated = true; del(); rep = setInterval(del, 55); } }, 380);
      return;
    }
    if (k === 'space') { slide = { x: e.clientX, moved: 0 }; b.setPointerCapture(e.pointerId); return; }
    if (k === 'shift') { const now = Date.now(); shift = shift === 0 ? (now - lastShift < 320 ? 2 : 1) : (shift === 1 && now - lastShift < 320 ? 2 : 0); lastShift = now; render(); return; }
    if (k === 'enter') { enter(); return; }
    if (k === 'sym' || k === 'sym2' || k === 'abc') { page = k; render(); return; }
    if (k === 'lang') { lang = lang === 'sq' ? 'en' : 'sq'; try { localStorage.setItem('sp-kb-lang', lang); } catch {} render(); return; }
    if (k === 'hide') { hide(false); }
  });
  let drag = null;
  box.addEventListener('pointermove', (e) => {
    if (drag) {
      const dy = e.clientY - drag.y; // up = bigger
      const h = drag.h - dy / 4.6;
      if (h < 30 && dy > 90) { drag = null; box.classList.remove('resizing'); hide(false); return; } // pulled all the way down: hide
      setH(h);
      return;
    }
    if (dsl) {
      const n = Math.max(0, Math.floor((dsl.x0 - e.clientX) / 18));
      if (!dsl.sliding && n >= 1) { dsl.sliding = true; stopRepeat(); box.classList.add('del-sliding'); }
      if (dsl.sliding && n !== dsl.n) { dsl.n = n; selectWordsBack(dsl.start, n); }
      return;
    }
    if (!slide) return;
    const steps = Math.trunc((e.clientX - slide.x) / 14);
    if (steps) { moveCaret(steps); slide.x += steps * 14; slide.moved += Math.abs(steps); }
  });
  const up = (e) => {
    if (hold) { clearTimeout(hold.t); const h = hold; hold = null; if (!h.done && e.type === 'pointerup') { type(h.ch); afterChar(); } }
    if (drag) { drag = null; box.classList.remove('resizing'); }
    stopRepeat();
    for (const d of box.querySelectorAll('.k.down')) d.classList.remove('down');
    if (slide) { if (!slide.moved && e.type === 'pointerup') type(' '); slide = null; }
    if (dsl) {
      const d = dsl;
      dsl = null;
      box.classList.remove('del-sliding');
      if (e.type !== 'pointerup') return;
      if (d.sliding) { if (d.n > 0) del(); } // the selected words go in one go
      else if (!d.repeated) del();
    }
  };
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);
  box.addEventListener('contextmenu', (e) => e.preventDefault());

  /* show for the note and the write box; the phone's keyboard stays closed (inputmode none) */
  function show(t) {
    target = t;
    reopen.hidden = true;
    if (!box.hidden) return;
    page = t.dataset && t.dataset.skbIm === 'numeric' ? 'sym' : 'abc'; // number fields open on the numbers
    render();
    box.hidden = false;
    document.documentElement.style.setProperty('--skb-h', box.offsetHeight + 'px');
    document.documentElement.classList.add('skb-on');
    onShow && onShow();
    requestAnimationFrame(keepCaretVisible);
  }
  function hide(blur) {
    // still writing (hidden on purpose): a small button brings it back
    reopen.hidden = !(enabled && !blur && target && document.activeElement === target);
    if (box.hidden) return;
    box.hidden = true;
    document.documentElement.classList.remove('skb-on');
    if (blur && target) target.blur();
    onHide && onHide();
  }
  let enabled = false;
  /* every text field in the app gets the SyncPad keyboard, so the phone's keyboard has nowhere to pop up:
     marked up front, again for anything added later, and at the very touch that focuses a field */
  const FIELDS = 'textarea, input:not([type]), input[type=text], input[type=search], input[type=url], input[type=email], input[type=tel], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
  const fieldOf = (t) => (t && t.closest ? t.closest(FIELDS) : null);
  const markOne = (f) => { if (f && !f.closest('.skb') && f.getAttribute('inputmode') !== 'none') { f.dataset.skbIm = f.getAttribute('inputmode') || ''; f.setAttribute('inputmode', 'none'); } };
  const unmarkOne = (f) => { if (f.dataset.skbIm === undefined) return; const was = f.dataset.skbIm; delete f.dataset.skbIm; if (f.id === 'editor-text' && f.classList.contains('sel-mode')) return; if (was) f.setAttribute('inputmode', was); else f.removeAttribute('inputmode'); };
  const mark = (on) => {
    if (on) document.querySelectorAll(FIELDS).forEach(markOne);
    else document.querySelectorAll('[data-skb-im]').forEach(unmarkOne);
  };
  new MutationObserver((ms) => {
    if (!enabled) return;
    for (const m of ms) {
      if (m.type === 'attributes') { const f = fieldOf(m.target); if (f) markOne(f); continue; }
      for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches(FIELDS)) markOne(n); n.querySelectorAll && n.querySelectorAll(FIELDS).forEach(markOne); }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['contenteditable', 'inputmode'] });
  document.addEventListener('pointerdown', (e) => { if (enabled) { const f = fieldOf(e.target); if (f) markOne(f); } }, true);
  document.addEventListener('focusin', (e) => { if (enabled) { const f = fieldOf(e.target); if (f) markOne(f); } }, true);
  document.addEventListener('focusin', (e) => { if (enabled && isTarget(e.target)) show(e.target); else if (!box.contains(e.target)) hide(false); });
  document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement || !isTarget(document.activeElement)) { hide(false); reopen.hidden = true; } }, 120));
  // tapping into the text again brings the keyboard back after it was hidden
  document.addEventListener('pointerup', (e) => { if (enabled && box.hidden && isTarget(document.activeElement) && document.activeElement.contains(e.target)) show(document.activeElement); });
  return {
    setEnabled(on) { enabled = !!on; mark(enabled); if (!enabled) hide(false); else if (isTarget(document.activeElement)) show(document.activeElement); },
    get enabled() { return enabled; },
    refreshTargets() { mark(enabled); }
  };
}
