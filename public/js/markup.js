// Photo markup: cover or scribble over details, then export a brand-new image.
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
    this.tool = 'box';
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
      if (!this.ops.length || confirm('Discard your changes to this photo?')) dialog.close();
    });
    this.btnSave.addEventListener('click', () => this.save());
    dialog.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); }
    });
    dialog.addEventListener('cancel', (e) => {
      if (this.ops.length && !confirm('Discard your changes to this photo?')) e.preventDefault();
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
    if (this.base && this.base.close) this.base.close();
    this.base = null;
    this.ops = [];
    if (r) r(v);
  }

  setTool(t) {
    this.tool = t;
    for (const b of this.d.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    this.d.classList.toggle('mk-pen', t === 'pen');
    this.hint.textContent = t === 'pen' ? 'Draw over what you want to hide.' : 'Drag a box over what you want to hide.';
  }
  setColor(c) {
    this.color = c;
    for (const b of this.d.querySelectorAll('[data-color]')) b.setAttribute('aria-pressed', String(b.dataset.color === c));
  }
  setSize(s) {
    this.size = s;
    for (const b of this.d.querySelectorAll('[data-size]')) b.setAttribute('aria-pressed', String(+b.dataset.size === s));
  }

  sync() {
    this.btnUndo.disabled = !this.ops.length;
    this.btnSave.disabled = !this.ops.length;
    this.hint.hidden = !!this.ops.length;
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
    if (e.button > 0) return;
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
    if (!this.ops.length) return;
    this.ops.pop();
    this.redraw();
    this.sync();
  }

  save() {
    if (!this.ops.length) return;
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
