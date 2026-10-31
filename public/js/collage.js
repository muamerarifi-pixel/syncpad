// Collage: many photos in one picture. Grid with N columns; each photo either fits whole
// in its cell or fills it (cropped). Tap two photos to swap them.

import { decode, fitCanvas } from './markup.js';

const MAX_SIDE = 4096;
const MAX_PIXELS = 16e6;
const $ = (s, r = document) => r.querySelector(s);

const autoCols = (n) => (n <= 3 ? n : n === 4 ? 2 : Math.ceil(Math.sqrt(n)));

export class Collage {
  constructor(dialog) {
    this.d = dialog;
    this.stage = $('#cl-stage', dialog);
    this.canvas = $('#cl-canvas', dialog);
    this.ctx = this.canvas.getContext('2d');
    this.pick = $('#cl-pick', dialog);
    this.hint = $('#cl-hint', dialog);
    this.colsLabel = $('#cl-cols', dialog);
    this.btnSave = $('#cl-save', dialog);
    this.trash = $('#cl-trash', dialog);
    this.resolve = null;
    this.imgs = [];
    this.cells = [];

    dialog.addEventListener('click', (e) => {
      const m = e.target.closest('[data-cl-mode]');
      if (m) { this.mode = m.dataset.clMode; return this.render(); }
      const c = e.target.closest('[data-cl-cols]');
      if (c) { this.cols = Math.max(1, Math.min(Math.min(6, this.imgs.length), this.cols + Number(c.dataset.clCols))); return this.render(); }
      const b = e.target.closest('[data-cl-bg]');
      if (b) { this.bg = b.dataset.clBg; return this.render(); }
      if (e.target.closest('#cl-gap')) { this.gap = !this.gap; return this.render(); }
    });
    $('#cl-cancel', dialog).addEventListener('click', () => dialog.close());
    this.btnSave.addEventListener('click', () => this.save());
    this.canvas.addEventListener('click', (e) => this.tap(e));
    dialog.addEventListener('close', () => this.finish(null));
    addEventListener('resize', () => { if (this.d.open) { fitCanvas(this.canvas, this.stage); this.placePick(); } });
  }

  /** blobs: photo files in order. Resolves to { blob, trash } or null. */
  async open(blobs, open) {
    const imgs = [];
    for (const b of blobs) {
      try {
        const im = await decode(b);
        if ((im.width || im.naturalWidth) && (im.height || im.naturalHeight)) imgs.push(im);
      } catch {}
    }
    if (imgs.length < 2) { for (const im of imgs) if (im.close) im.close(); throw new Error('decode'); }
    this.imgs = imgs;
    this.mode = 'fit';
    this.cols = autoCols(imgs.length);
    this.gap = true;
    this.bg = '#ffffff';
    this.sel = null;
    this.trash.checked = false;
    this.hint.hidden = false;
    this.render();
    open(this.d);
    fitCanvas(this.canvas, this.stage);
    return new Promise((r) => { this.resolve = r; });
  }

  finish(v) {
    const r = this.resolve;
    this.resolve = null;
    for (const im of this.imgs) if (im.close) im.close();
    this.imgs = [];
    this.pick.hidden = true;
    if (r) r(v);
  }

  layout() {
    const n = this.imgs.length;
    const cols = this.cols;
    const rows = Math.ceil(n / cols);
    const W = (im) => im.width || im.naturalWidth;
    const H = (im) => im.height || im.naturalHeight;
    const mid = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const ar = Math.max(0.3, Math.min(3, mid(this.imgs.map((im) => W(im) / H(im)))));
    let cw = Math.min(1600, mid(this.imgs.map(W)));
    let ch = cw / ar;
    let gap = this.gap ? Math.round(cw * 0.03) : 0;
    let tw = cols * cw + (cols + 1) * gap;
    let th = rows * ch + (rows + 1) * gap;
    const k = Math.min(1, MAX_SIDE / Math.max(tw, th), Math.sqrt(MAX_PIXELS / (tw * th)));
    cw *= k; ch *= k; gap *= k;
    tw = Math.round(cols * cw + (cols + 1) * gap);
    th = Math.round(rows * ch + (rows + 1) * gap);
    const cells = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const inRow = r === rows - 1 ? n - r * cols : cols;
      const off = ((cols - inRow) * (cw + gap)) / 2; // centre a short last row
      cells.push({ x: gap + off + (i % cols) * (cw + gap), y: gap + r * (ch + gap), w: cw, h: ch });
    }
    return { tw, th, cells };
  }

  render() {
    const { tw, th, cells } = this.layout();
    this.cells = cells;
    const c = this.canvas;
    if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; fitCanvas(c, this.stage); }
    const x = this.ctx;
    x.fillStyle = this.bg;
    x.fillRect(0, 0, tw, th);
    x.imageSmoothingQuality = 'high';
    this.imgs.forEach((im, i) => {
      const cell = cells[i];
      const iw = im.width || im.naturalWidth;
      const ih = im.height || im.naturalHeight;
      if (this.mode === 'crop') {
        const s = Math.max(cell.w / iw, cell.h / ih);
        const sw = cell.w / s;
        const sh = cell.h / s;
        x.drawImage(im, (iw - sw) / 2, (ih - sh) / 2, sw, sh, cell.x, cell.y, cell.w, cell.h);
      } else {
        const s = Math.min(cell.w / iw, cell.h / ih);
        const dw = iw * s;
        const dh = ih * s;
        x.drawImage(im, cell.x + (cell.w - dw) / 2, cell.y + (cell.h - dh) / 2, dw, dh);
      }
    });
    for (const b of this.d.querySelectorAll('[data-cl-mode]')) b.setAttribute('aria-pressed', String(b.dataset.clMode === this.mode));
    for (const b of this.d.querySelectorAll('[data-cl-bg]')) b.setAttribute('aria-pressed', String(b.dataset.clBg === this.bg));
    $('#cl-gap', this.d).setAttribute('aria-pressed', String(this.gap));
    this.colsLabel.textContent = `${this.cols} ${this.cols === 1 ? 'column' : 'columns'}`;
    $('[data-cl-cols="-1"]', this.d).disabled = this.cols <= 1;
    $('[data-cl-cols="1"]', this.d).disabled = this.cols >= Math.min(6, this.imgs.length);
    this.placePick();
  }

  tap(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * this.canvas.width;
    const py = ((e.clientY - r.top) / r.height) * this.canvas.height;
    const i = this.cells.findIndex((c) => px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h);
    if (i < 0) return;
    this.hint.hidden = true;
    if (this.sel == null) { this.sel = i; this.placePick(); return; }
    if (this.sel !== i) [this.imgs[this.sel], this.imgs[i]] = [this.imgs[i], this.imgs[this.sel]];
    this.sel = null;
    this.render();
  }

  placePick() {
    const cell = this.sel != null && this.cells[this.sel];
    if (!cell) { this.pick.hidden = true; return; }
    const s = this.stage.getBoundingClientRect();
    const r = this.canvas.getBoundingClientRect();
    const k = r.width / this.canvas.width;
    Object.assign(this.pick.style, {
      left: r.left - s.left + cell.x * k + 'px',
      top: r.top - s.top + cell.y * k + 'px',
      width: cell.w * k + 'px',
      height: cell.h * k + 'px'
    });
    this.pick.hidden = false;
  }

  save() {
    this.btnSave.disabled = true;
    const trash = this.trash.checked;
    this.sel = null;
    this.render();
    this.canvas.toBlob((blob) => {
      this.btnSave.disabled = false;
      if (!blob) return;
      const r = this.resolve;
      this.resolve = null;
      this.d.close();
      if (r) r({ blob, trash });
    }, 'image/jpeg', 0.9);
  }
}
