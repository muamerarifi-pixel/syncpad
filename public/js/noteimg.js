// Pictures inside normal notes: tap one to place it (left or right with text beside it, centre, full width,
// side by side with other pictures, in line), resize it by dragging the corner, drag ✥ to move it
// anywhere in the text, draw or write on it, or select several pictures and change them together.
const ALIGNS = [
  ['left', 'al-left', 'Picture left, text beside it on the right'],
  ['center', 'al-center', 'Centre'],
  ['right', 'al-right', 'Picture right, text beside it on the left'],
  ['full', 'al-justify', 'Full width'],
  ['side', 'columns', 'Side by side with the next picture (or the selected ones)'],
  ['inline', 'text', 'In line with the text']
];

export class ImageTools {
  constructor({ editor, onChange, onView, onMarkup, toast }) {
    Object.assign(this, { ed: editor, onChange, onView, onMarkup, toast });
    this.img = null;
    this.extra = new Set(); // more pictures selected together with this.img
    this.picking = false;
    this.bar = document.createElement('div');
    this.bar.className = 'img-bar';
    this.bar.hidden = true;
    const ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
    this.bar.innerHTML = ALIGNS.map(([a, i, t]) => `<button class="icon-btn sm" data-al="${a}" title="${t}" aria-label="${t}">${ic(i)}</button>`).join('') +
      '<span class="fmt-sep"></span>' +
      `<button class="icon-btn sm" data-act="smaller" title="Smaller" aria-label="Smaller"><b>−</b></button>` +
      `<button class="icon-btn sm" data-act="bigger" title="Bigger" aria-label="Bigger"><b>+</b></button>` +
      `<button class="icon-btn sm img-move" data-act="move" title="Drag to move the picture" aria-label="Move">${ic('cursor')}</button>` +
      `<button class="icon-btn sm" data-act="markup" title="Draw, mark up or write on the picture" aria-label="Draw on the picture">${ic('pen')}</button>` +
      `<button class="icon-btn sm" data-act="pick" title="Select more pictures (or Shift+click)" aria-label="Select more pictures">${ic('select')}</button>` +
      `<button class="icon-btn sm" data-act="view" title="Open" aria-label="Open">${ic('eye')}</button>` +
      `<button class="icon-btn sm" data-act="del" title="Remove from the note" aria-label="Remove from the note">${ic('trash')}</button>`;
    this.grip = document.createElement('div');
    this.grip.className = 'img-grip';
    this.grip.hidden = true;
    this.grip.title = 'Drag to resize';
    this.caret = document.createElement('div');
    this.caret.className = 'img-caret';
    this.caret.hidden = true;
    document.body.append(this.bar, this.grip, this.caret);

    editor.addEventListener('click', (e) => {
      const im = e.target.closest('img[data-file], a[data-file]');
      if (!im) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.img && im !== this.img && (this.picking || e.shiftKey || e.ctrlKey || e.metaKey)) { this.toggleExtra(im); return; }
      this.select(im);
    }, true);
    editor.addEventListener('dblclick', (e) => { const im = e.target.closest('img[data-file], a[data-file]'); if (im) { e.preventDefault(); this.onView(im); } });
    document.addEventListener('pointerdown', (e) => {
      if (!this.img) return;
      if (this.bar.contains(e.target) || e.target === this.grip || e.target === this.img || this.extra.has(e.target)) return;
      if ((this.picking || e.shiftKey || e.ctrlKey || e.metaKey) && e.target.closest && e.target.closest('img[data-file], a[data-file]') && this.ed.contains(e.target)) return;
      this.select(null);
    }, true);
    editor.addEventListener('scroll', () => this.position(), { passive: true });
    addEventListener('resize', () => this.position());
    editor.addEventListener('input', () => { if (this.img && !this.ed.contains(this.img)) this.select(null); else this.position(); });
    editor.addEventListener('keydown', (e) => {
      if (!this.img) return;
      if (e.key === 'Escape') this.select(null);
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.bar.querySelector('[data-act="del"]').click(); }
      else this.select(null);
    });
    this.bar.addEventListener('mousedown', (e) => e.preventDefault());
    this.bar.addEventListener('click', (e) => this.act(e));
    this.bar.querySelector('[data-act="move"]').addEventListener('pointerdown', (e) => this.drag(e));
    this.grip.addEventListener('pointerdown', (e) => this.resize(e));
  }

  all() { return [this.img, ...this.extra].filter((x) => x && x.isConnected); }
  toggleExtra(im) {
    if (this.extra.has(im)) { this.extra.delete(im); im.classList.remove('img-on'); } else { this.extra.add(im); im.classList.add('img-on'); }
    this.bar.classList.toggle('is-multi', this.extra.size > 0);
    this.sync();
    this.position();
  }
  select(im) {
    if (this.img) this.img.classList.remove('img-on');
    for (const x of this.extra) x.classList.remove('img-on');
    this.extra.clear();
    this.picking = false;
    this.bar.classList.remove('is-multi');
    this.img = im && this.ed.contains(im) ? im : null;
    this.bar.hidden = this.grip.hidden = !this.img;
    if (!this.img) return;
    this.chip = this.img.tagName === 'A';
    this.bar.classList.toggle('is-chip', this.chip);
    this.grip.hidden = this.chip;
    this.img.classList.add('img-on');
    const r = document.createRange();
    r.setStartAfter(this.img);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    this.sync();
    this.position();
  }
  sync() {
    const a = this.img.dataset.align || '';
    for (const b of this.bar.querySelectorAll('[data-al]')) b.setAttribute('aria-pressed', String(b.dataset.al === a));
    const pk = this.bar.querySelector('[data-act="pick"]');
    if (pk) pk.setAttribute('aria-pressed', String(this.picking));
    const mk = this.bar.querySelector('[data-act="markup"]');
    if (mk) mk.hidden = this.chip || this.extra.size > 0 || !this.onMarkup;
  }
  position() {
    if (!this.img) return;
    if (!this.img.isConnected) { this.select(null); return; }
    const r = this.img.getBoundingClientRect();
    const er = this.ed.getBoundingClientRect();
    const visible = r.bottom > er.top && r.top < er.bottom;
    this.bar.hidden = !visible;
    this.grip.hidden = !visible || this.chip;
    if (!visible) return;
    const bw = this.bar.offsetWidth;
    const bh = this.bar.offsetHeight;
    let top = r.top - bh - 8;
    if (top < er.top + 4) top = Math.min(r.bottom + 8, innerHeight - bh - 8);
    this.bar.style.top = top + 'px';
    this.bar.style.left = Math.max(8, Math.min(innerWidth - bw - 8, r.left + r.width / 2 - bw / 2)) + 'px';
    this.grip.style.left = r.right - 9 + 'px';
    this.grip.style.top = r.bottom - 9 + 'px';
  }
  changed() { this.onChange(); this.sync(); requestAnimationFrame(() => this.position()); }

  width() { return this.img.getBoundingClientRect().width / Math.max(1, this.box().width) * 100; }
  box(im = this.img) {
    const p = im.closest('p, div, li, blockquote, h1, h2, h3') || this.ed;
    const r = p.getBoundingClientRect();
    if (p === this.ed) {
      const cs = getComputedStyle(this.ed);
      const z = r.width / (this.ed.offsetWidth || r.width);
      return { width: r.width - (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)) * z };
    }
    return r;
  }
  setWidth(pct, im = this.img) {
    im.style.width = Math.max(8, Math.min(100, pct)).toFixed(1) + '%';
  }

  act(e) {
    const b = e.target.closest('button');
    if (!b || !this.img) return;
    const im = this.img;
    const all = this.all();
    if (b.dataset.al) {
      const a = b.dataset.al;
      if (a === 'side') { this.sideBySide(); return; }
      const off = im.dataset.align === a && all.length === 1;
      for (const x of all) {
        if (off) delete x.dataset.align; else x.dataset.align = a;
        if (a === 'full') x.style.removeProperty('width');
        else if ((a === 'left' || a === 'right') && (!x.style.width || parseFloat(x.style.width) > 70)) this.setWidth(45, x);
        else if (a === 'inline' && !x.style.width) this.setWidth(30, x);
        else if (a === 'center' && !x.style.width) this.setWidth(60, x);
        if (!x.getAttribute('style')) x.removeAttribute('style');
      }
      this.changed();
      return;
    }
    const act = b.dataset.act;
    if (act === 'smaller' || act === 'bigger') {
      for (const x of all) {
        if (x.dataset.align === 'full') delete x.dataset.align;
        const w = (x.getBoundingClientRect().width / Math.max(1, this.box(x).width)) * 100;
        this.setWidth(w + (act === 'bigger' ? 10 : -10), x);
      }
      this.changed();
    } else if (act === 'view') this.onView(im);
    else if (act === 'markup') { if (this.onMarkup && !this.chip) this.onMarkup(im); }
    else if (act === 'pick') {
      this.picking = !this.picking;
      this.sync();
      if (this.picking && this.toast) this.toast('Tap more pictures to select them together');
    } else if (act === 'del') {
      for (const x of all) {
        const p = x.parentElement;
        x.remove();
        if (p && p !== this.ed && !p.textContent.trim() && !p.querySelector('img, br')) p.innerHTML = '<br>';
      }
      this.select(null);
      this.onChange();
    }
  }

  /** put the selected pictures (or this one and the next) in one row, sharing the width */
  sideBySide() {
    let ims = this.all().filter((x) => x.tagName === 'IMG');
    if (ims.length === 1) {
      const every = [...this.ed.querySelectorAll('img[data-file]')];
      const i = every.indexOf(ims[0]);
      const nb = every[i + 1] || every[i - 1];
      if (nb) ims = [ims[0], nb];
      else {
        ims[0].dataset.align = 'side';
        this.setWidth(48, ims[0]);
        this.changed();
        if (this.toast) this.toast('Add another picture after this one and it will sit beside it');
        return;
      }
    }
    ims.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const n = ims.length;
    const w = Math.floor(((100 - 2 * (n - 1)) / n - 0.5) * 10) / 10; // a hair under, so rounding never wraps
    // the row gets a paragraph of its own (text before or after stays on its own lines)
    const row = document.createElement('p');
    const first = ims[0];
    const block = first.parentElement === this.ed ? null : first.closest('p, div, li, blockquote, h1, h2, h3');
    if (!block || block === this.ed) first.before(row); else block.after(row);
    for (const x of ims) {
      const p = x.parentElement;
      row.append(x);
      if (p && p !== this.ed && p !== row && !p.textContent.trim() && !p.querySelector('img, a[data-file]')) p.remove();
    }
    for (const x of ims) { x.dataset.align = 'side'; x.style.width = w + '%'; }
    const keep = this.img;
    this.onChange();
    this.select(keep);
    for (const x of ims) if (x !== keep) this.toggleExtra(x);
  }

  resize(e) {
    e.preventDefault();
    const im = this.img;
    if (!im) return;
    const x0 = e.clientX;
    const w0 = im.getBoundingClientRect().width;
    const full = this.box().width;
    const right = im.dataset.align === 'right';
    if (im.dataset.align === 'full') delete im.dataset.align;
    this.grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = (ev.clientX - x0) * (right ? -1 : 1);
      this.setWidth(((w0 + dx) / full) * 100);
      this.position();
    };
    const up = () => {
      this.grip.removeEventListener('pointermove', move);
      this.grip.removeEventListener('pointerup', up);
      this.grip.removeEventListener('pointercancel', up);
      this.changed();
    };
    this.grip.addEventListener('pointermove', move);
    this.grip.addEventListener('pointerup', up);
    this.grip.addEventListener('pointercancel', up);
  }

  /** drag ✥ and drop the picture at any spot in the text */
  drag(e) {
    e.preventDefault();
    const im = this.img;
    if (!im) return;
    const btn = e.currentTarget;
    btn.setPointerCapture(e.pointerId);
    im.classList.add('img-dragging');
    let range = null;
    let timer = null;
    const at = (x, y) => {
      let r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
      if (!r && document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); }
      }
      if (!r || !this.ed.contains(r.startContainer) || im.contains(r.startContainer)) return null;
      r.collapse(true);
      return r;
    };
    const move = (ev) => {
      const er = this.ed.getBoundingClientRect();
      clearInterval(timer);
      if (ev.clientY < er.top + 40) timer = setInterval(() => { this.ed.scrollTop -= 14; }, 16);
      else if (ev.clientY > er.bottom - 40) timer = setInterval(() => { this.ed.scrollTop += 14; }, 16);
      this.bar.hidden = true;
      this.grip.hidden = true;
      range = at(ev.clientX, ev.clientY);
      if (!range) { this.caret.hidden = true; return; }
      const rr = range.getClientRects()[0] || range.startContainer.nodeType === 1 && range.startContainer.getBoundingClientRect();
      if (!rr) { this.caret.hidden = true; return; }
      Object.assign(this.caret.style, { left: rr.left - 1 + 'px', top: rr.top + 'px', height: Math.max(18, rr.height) + 'px' });
      this.caret.hidden = false;
    };
    const up = () => {
      clearInterval(timer);
      btn.removeEventListener('pointermove', move);
      btn.removeEventListener('pointerup', up);
      btn.removeEventListener('pointercancel', up);
      this.caret.hidden = true;
      im.classList.remove('img-dragging');
      if (range) {
        range.insertNode(im);
        this.onChange();
      }
      this.select(im);
    };
    btn.addEventListener('pointermove', move);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
  }
}
