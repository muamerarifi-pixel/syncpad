// Pictures inside normal notes: tap one to align it (left / centre / right with text wrapping, full width,
// in line), resize it by dragging the corner, or drag ✥ to move it anywhere in the text.
const ALIGNS = [
  ['left', 'al-left', 'Left, text wraps around'],
  ['center', 'al-center', 'Centre'],
  ['right', 'al-right', 'Right, text wraps around'],
  ['full', 'al-justify', 'Full width'],
  ['inline', 'text', 'In line with the text']
];

export class ImageTools {
  constructor({ editor, onChange, onView }) {
    Object.assign(this, { ed: editor, onChange, onView });
    this.img = null;
    this.bar = document.createElement('div');
    this.bar.className = 'img-bar';
    this.bar.hidden = true;
    const ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
    this.bar.innerHTML = ALIGNS.map(([a, i, t]) => `<button class="icon-btn sm" data-al="${a}" title="${t}" aria-label="${t}">${ic(i)}</button>`).join('') +
      '<span class="fmt-sep"></span>' +
      `<button class="icon-btn sm" data-act="smaller" title="Smaller" aria-label="Smaller"><b>−</b></button>` +
      `<button class="icon-btn sm" data-act="bigger" title="Bigger" aria-label="Bigger"><b>+</b></button>` +
      `<button class="icon-btn sm img-move" data-act="move" title="Drag to move the picture" aria-label="Move">${ic('cursor')}</button>` +
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
      this.select(im);
    }, true);
    editor.addEventListener('dblclick', (e) => { const im = e.target.closest('img[data-file], a[data-file]'); if (im) { e.preventDefault(); this.onView(im); } });
    document.addEventListener('pointerdown', (e) => {
      if (!this.img) return;
      if (this.bar.contains(e.target) || e.target === this.grip || e.target === this.img) return;
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

  select(im) {
    if (this.img) this.img.classList.remove('img-on');
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
  box() {
    const p = this.img.closest('p, div, li, blockquote, h1, h2, h3') || this.ed;
    const r = p.getBoundingClientRect();
    if (p === this.ed) {
      const cs = getComputedStyle(this.ed);
      const z = r.width / (this.ed.offsetWidth || r.width);
      return { width: r.width - (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)) * z };
    }
    return r;
  }
  setWidth(pct) {
    this.img.style.width = Math.max(8, Math.min(100, pct)).toFixed(1) + '%';
  }

  act(e) {
    const b = e.target.closest('button');
    if (!b || !this.img) return;
    const im = this.img;
    if (b.dataset.al) {
      const a = b.dataset.al;
      if (im.dataset.align === a) delete im.dataset.align;
      else im.dataset.align = a;
      if (a === 'full') im.style.removeProperty('width');
      else if ((a === 'left' || a === 'right') && !im.style.width) this.setWidth(45);
      else if (a === 'inline' && !im.style.width) this.setWidth(30);
      if (!im.getAttribute('style')) im.removeAttribute('style');
      this.changed();
      return;
    }
    const act = b.dataset.act;
    if (act === 'smaller' || act === 'bigger') {
      if (im.dataset.align === 'full') delete im.dataset.align;
      this.setWidth(this.width() + (act === 'bigger' ? 10 : -10));
      this.changed();
    } else if (act === 'view') this.onView(im);
    else if (act === 'del') {
      const p = im.parentElement;
      im.remove();
      if (p && p !== this.ed && !p.textContent.trim() && !p.querySelector('img, br')) p.innerHTML = '<br>';
      this.select(null);
      this.onChange();
    }
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
