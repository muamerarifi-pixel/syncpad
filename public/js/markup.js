// Photo editor: crop, cover or scribble over details, then export a brand-new image.
// The result is re-encoded from the canvas, so covered pixels (and EXIF data such as GPS) are gone.

const MAX_SIDE = 4096;
const MAX_PIXELS = 16e6; // iOS canvas limit

const $ = (s, r = document) => r.querySelector(s);

async function decode(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch {}
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export class Markup {
  constructor(dialog) {
    this.d = dialog;
    this.stage = $('#mk-stage', dialog);
    this.canvas = $('#mk-canvas', dialog);
    this.ctx = this.canvas.getContext('2d');
    this.preview = $('#mk-preview', dialog);
    this.hint = $('#mk-hint', dialog);
    this.btnSave = $('#mk-save', dialog);
    this.btnUndo = $('#mk-undo', dialog);
    this.keep = $('#mk-keep', dialog);
    this.cropBox = $('#mk-crop', dialog);
    this.btnApply = $('#mk-apply', dialog);
    this.tool = 'box';
    this.stack = []; // undo steps: 'op' or a saved state from before a crop
    this.crop = null;
    this.color = '#000000';
    this.size = 2; // 1..3
    this.ops = [];
    this.cur = null;
    this.pointers = new Set();
    this.resolve = null;

    dialog.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tool]');
      if (t) return this.setTool(t.dataset.tool);
      const c = e.target.closest('[data-color]');
      if (c) return this.setColor(c.dataset.color);
      const z = e.target.closest('[data-size]');
      if (z) return this.setSize(+z.dataset.size);
    });
    this.btnUndo.addEventListener('click', () => this.undo());
    $('#mk-cancel', dialog).addEventListener('click', () => {
      if (!this.dirty() || confirm('Discard your changes to this photo?')) dialog.close();
    });
    this.btnSave.addEventListener('click', () => this.save());
    this.btnApply.addEventListener('click', () => { this.applyCrop(); this.setTool('box'); });
    this.cropBox.addEventListener('pointerdown', (e) => this.cropDown(e));
    this.cropBox.addEventListener('pointermove', (e) => this.cropMove(e));
    this.cropBox.addEventListener('pointerup', () => { this.cropDrag = null; });
    this.cropBox.addEventListener('pointercancel', () => { this.cropDrag = null; });
    dialog.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); }
      else if (e.key === 'Enter' && this.tool === 'crop') { e.preventDefault(); this.applyCrop(); this.setTool('box'); }
    });
    dialog.addEventListener('cancel', (e) => {
      if (this.dirty() && !confirm('Discard your changes to this photo?')) e.preventDefault();
    });
    dialog.addEventListener('close', () => this.finish(null));

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e, true));
    c.addEventListener('lostpointercapture', (e) => this.pointers.delete(e.pointerId));
    addEventListener('resize', () => { if (this.d.open) this.fit(); });
  }

  /** Scale the canvas to fit the free space, keeping its shape */
  fit() {
    const s = getComputedStyle(this.stage);
    const aw = this.stage.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    const ah = this.stage.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
    const k = Math.min(aw / this.canvas.width, ah / this.canvas.height);
    this.canvas.style.width = Math.max(1, Math.floor(this.canvas.width * k)) + 'px';
    this.canvas.style.height = Math.max(1, Math.floor(this.canvas.height * k)) + 'px';
    this.placeCrop();
  }

  /** Opens the editor. Resolves to { blob, keep } or null when cancelled. */
  async open(blob, type, open) {
    this.base = await decode(blob);
    const w0 = this.base.width || this.base.naturalWidth;
    const h0 = this.base.height || this.base.naturalHeight;
    if (!w0 || !h0) throw new Error('decode');
    const k = Math.min(1, MAX_SIDE / Math.max(w0, h0), Math.sqrt(MAX_PIXELS / (w0 * h0)));
    this.canvas.width = Math.round(w0 * k);
    this.canvas.height = Math.round(h0 * k);
    this.type = /^image\/(jpeg|webp)$/.test(type) ? type : 'image/png';
    this.ops = [];
    this.stack = [];
    this.cur = null;
    this.keep.checked = false;
    this.setTool('box');
    this.redraw();
    this.sync();
    open(this.d);
    this.fit();
    return new Promise((r) => { this.resolve = r; });
  }

  finish(v) {
    const r = this.resolve;
    this.resolve = null;
    this.preview.hidden = true;
    this.cropBox.hidden = true;
    this.crop = null;
    if (this.base && this.base.close) this.base.close();
    for (const e of this.stack) if (e !== 'op' && e.base && e.base.close) e.base.close();
    this.base = null;
    this.ops = [];
    this.stack = [];
    if (r) r(v);
  }

  setTool(t) {
    this.tool = t;
    for (const b of this.d.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    this.d.classList.toggle('mk-pen', t === 'pen');
    this.d.classList.toggle('mk-cropping', t === 'crop');
    this.hint.textContent = t === 'pen' ? 'Draw over what you want to hide.'
      : t === 'crop' ? 'Drag the corners, then tap Apply.' : 'Drag a box over what you want to hide.';
    if (t === 'crop') {
      this.crop = { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
      this.cropBox.hidden = false;
      this.placeCrop();
      this.hint.hidden = false;
    } else {
      this.crop = null;
      this.cropBox.hidden = true;
    }
    this.sync();
  }
  setColor(c) {
    this.color = c;
    for (const b of this.d.querySelectorAll('[data-color]')) b.setAttribute('aria-pressed', String(b.dataset.color === c));
  }
  setSize(s) {
    this.size = s;
    for (const b of this.d.querySelectorAll('[data-size]')) b.setAttribute('aria-pressed', String(+b.dataset.size === s));
  }

  dirty() { return this.stack.length > 0 || this.cropPending(); }
  cropPending() {
    const c = this.crop;
    return !!c && (c.x > 0.5 || c.y > 0.5 || c.w < this.canvas.width - 0.5 || c.h < this.canvas.height - 0.5);
  }

  sync() {
    this.btnUndo.disabled = !this.stack.length;
    this.btnSave.disabled = !this.dirty();
    this.btnApply.disabled = !this.cropPending();
    if (this.tool !== 'crop') this.hint.hidden = !!this.stack.length;
  }

  /* ── crop ── */

  placeCrop() {
    const c = this.crop;
    if (!c || this.cropBox.hidden) return;
    const s = this.stage.getBoundingClientRect();
    const r = this.canvas.getBoundingClientRect();
    const k = r.width / this.canvas.width;
    const st = this.cropBox.style;
    st.left = r.left - s.left + c.x * k + 'px';
    st.top = r.top - s.top + c.y * k + 'px';
    st.width = c.w * k + 'px';
    st.height = c.h * k + 'px';
  }

  cropDown(e) {
    if (e.button > 0 || !this.crop) return;
    e.preventDefault();
    this.cropBox.setPointerCapture(e.pointerId);
    const h = e.target.closest('[data-h]');
    this.cropDrag = { mode: h ? h.dataset.h : 'move', p: this.pt(e), c: { ...this.crop } };
    this.hint.hidden = true;
  }

  cropMove(e) {
    const d = this.cropDrag;
    if (!d) return;
    const p = this.pt(e);
    const W = this.canvas.width;
    const H = this.canvas.height;
    const min = Math.max(8, Math.min(W, H) * 0.04);
    const dx = p.x - d.p.x;
    const dy = p.y - d.p.y;
    let { x, y, w, h } = d.c;
    if (d.mode === 'move') {
      x = Math.max(0, Math.min(W - w, x + dx));
      y = Math.max(0, Math.min(H - h, y + dy));
    } else {
      let x2 = x + w;
      let y2 = y + h;
      if (d.mode.includes('w')) x = Math.max(0, Math.min(x2 - min, x + dx));
      if (d.mode.includes('e')) x2 = Math.min(W, Math.max(x + min, x2 + dx));
      if (d.mode.includes('n')) y = Math.max(0, Math.min(y2 - min, y + dy));
      if (d.mode.includes('s')) y2 = Math.min(H, Math.max(y + min, y2 + dy));
      w = x2 - x;
      h = y2 - y;
    }
    this.crop = { x, y, w, h };
    this.placeCrop();
    this.sync();
  }

  applyCrop() {
    if (!this.cropPending()) return;
    const c = this.crop;
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    const w = Math.max(1, Math.round(Math.min(c.w, this.canvas.width - x)));
    const h = Math.max(1, Math.round(Math.min(c.h, this.canvas.height - y)));
    const next = document.createElement('canvas');
    next.width = w;
    next.height = h;
    next.getContext('2d').drawImage(this.canvas, x, y, w, h, 0, 0, w, h); // keeps covers / pen made so far
    this.stack.push({ base: this.base, ops: this.ops, w: this.canvas.width, h: this.canvas.height });
    this.base = next;
    this.ops = [];
    this.canvas.width = w;
    this.canvas.height = h;
    this.crop = { x: 0, y: 0, w, h };
    this.redraw();
    this.fit();
    this.sync();
  }

  lineWidth() {
    const m = Math.min(this.canvas.width, this.canvas.height);
    return Math.max(4, m * [0, 0.012, 0.03, 0.06][this.size]);
  }

  pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(this.canvas.width, ((e.clientX - r.left) / r.width) * this.canvas.width)),
      y: Math.max(0, Math.min(this.canvas.height, ((e.clientY - r.top) / r.height) * this.canvas.height))
    };
  }

  down(e) {
    if (e.button > 0 || this.tool === 'crop') return;
    this.pointers.add(e.pointerId);
    if (this.pointers.size > 1) { this.abort(); return; } // a second finger means a gesture, not a stroke
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.pt(e);
    this.cur = this.tool === 'pen'
      ? { t: 'pen', color: this.color, w: this.lineWidth(), pts: [p] }
      : { t: 'box', color: this.color, x0: p.x, y0: p.y, x1: p.x, y1: p.y, cx: e.clientX, cy: e.clientY };
    if (this.cur.t === 'pen') this.drawDot(p, this.cur);
    this.hint.hidden = true;
  }

  move(e) {
    const c = this.cur;
    if (!c || !this.pointers.has(e.pointerId)) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (c.t === 'pen') {
      for (const ev of evs.length ? evs : [e]) {
        const p = this.pt(ev);
        const last = c.pts[c.pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) < 1) continue;
        c.pts.push(p);
        this.drawSeg(last, p, c);
      }
    } else {
      const p = this.pt(e);
      c.x1 = p.x;
      c.y1 = p.y;
      this.showPreview(c, e);
    }
  }

  up(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    this.preview.hidden = true;
    if (cancelled) { this.redraw(); this.sync(); return; }
    if (c.t === 'box') {
      const p = this.pt(e);
      c.x1 = p.x;
      c.y1 = p.y;
      const w = Math.abs(c.x1 - c.x0);
      const h = Math.abs(c.y1 - c.y0);
      if (w < 3 || h < 3) { this.sync(); return; } // a tap is not a box
      this.drawOp(c);
    }
    this.ops.push(c);
    this.stack.push('op');
    this.sync();
  }

  abort() {
    if (!this.cur) return;
    this.cur = null;
    this.preview.hidden = true;
    this.redraw();
    this.sync();
  }

  showPreview(c, e) {
    const s = this.stage.getBoundingClientRect();
    const r = this.canvas.getBoundingClientRect();
    const cx = Math.max(r.left, Math.min(r.right, e.clientX));
    const cy = Math.max(r.top, Math.min(r.bottom, e.clientY));
    const st = this.preview.style;
    st.left = Math.min(c.cx, cx) - s.left + 'px';
    st.top = Math.min(c.cy, cy) - s.top + 'px';
    st.width = Math.abs(cx - c.cx) + 'px';
    st.height = Math.abs(cy - c.cy) + 'px';
    st.background = c.color;
    this.preview.hidden = false;
  }

  drawDot(p, c) {
    const x = this.ctx;
    x.fillStyle = c.color;
    x.beginPath();
    x.arc(p.x, p.y, c.w / 2, 0, Math.PI * 2);
    x.fill();
  }
  drawSeg(a, b, c) {
    const x = this.ctx;
    x.strokeStyle = c.color;
    x.lineWidth = c.w;
    x.lineCap = 'round';
    x.lineJoin = 'round';
    x.beginPath();
    x.moveTo(a.x, a.y);
    x.lineTo(b.x, b.y);
    x.stroke();
  }
  drawOp(o) {
    const x = this.ctx;
    if (o.t === 'box') {
      x.fillStyle = o.color;
      x.fillRect(Math.min(o.x0, o.x1), Math.min(o.y0, o.y1), Math.abs(o.x1 - o.x0), Math.abs(o.y1 - o.y0));
      return;
    }
    if (o.pts.length === 1) return this.drawDot(o.pts[0], o);
    x.strokeStyle = o.color;
    x.lineWidth = o.w;
    x.lineCap = 'round';
    x.lineJoin = 'round';
    x.beginPath();
    x.moveTo(o.pts[0].x, o.pts[0].y);
    for (const p of o.pts.slice(1)) x.lineTo(p.x, p.y);
    x.stroke();
  }

  redraw() {
    const { width: w, height: h } = this.canvas;
    this.ctx.clearRect(0, 0, w, h);
    if (this.type !== 'image/png') { this.ctx.fillStyle = '#fff'; this.ctx.fillRect(0, 0, w, h); }
    if (this.base) this.ctx.drawImage(this.base, 0, 0, w, h);
    for (const o of this.ops) this.drawOp(o);
  }

  undo() {
    const e = this.stack.pop();
    if (!e) return;
    if (e === 'op') this.ops.pop();
    else {
      this.base = e.base;
      this.ops = e.ops;
      this.canvas.width = e.w;
      this.canvas.height = e.h;
      this.fit();
    }
    if (this.tool === 'crop') this.crop = { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
    this.redraw();
    this.placeCrop();
    this.sync();
  }

  save() {
    if (this.cropPending()) this.applyCrop();
    if (!this.stack.length) return;
    this.btnSave.disabled = true;
    const keep = this.keep.checked;
    this.canvas.toBlob((blob) => {
      if (!blob) { this.btnSave.disabled = false; return; }
      const r = this.resolve;
      this.resolve = null;
      this.d.close();
      if (r) r({ blob, keep });
    }, this.type, 0.92);
  }
}
