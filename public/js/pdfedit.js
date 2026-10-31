// PDF editor: change / delete text lines, delete or add pictures, add text, draw shapes,
// copy & paste anything. Line and picture changes are written into the PDF right away (and the
// page is re-drawn from the new file); added things stay movable until Save bakes them in.

import { applyLineEdit, pickFont, pageInfo, removeImage, addObjects, loadDoc } from './pdfcore.js';

const V = '/vendor/pdf/';
const $ = (s, r = document) => r.querySelector(s);
const SHAPES = new Set(['rect', 'ellipse', 'line', 'arrow', 'check', 'cross']);
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const unhex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
let libs = null;

async function loadLibs() {
  if (libs) return libs;
  const [pdfjs, L] = await Promise.all([import(V + 'pdf.min.mjs'), import(V + 'pdf-lib.esm.min.js')]);
  pdfjs.GlobalWorkerOptions.workerSrc = V + 'pdf.worker.min.mjs';
  if (!window.fontkit) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = V + 'fontkit.umd.min.js';
      s.onload = res;
      s.onerror = rej;
      document.head.append(s);
    });
  }
  libs = { pdfjs, L, fontkit: window.fontkit };
  for (const fam of ['Carlito', 'Caladea']) {
    for (const w of [400, 700]) {
      for (const st of ['normal', 'italic']) {
        try { document.fonts.add(new FontFace(fam, `url(${V}fonts/${fam.toLowerCase()}-latin-${w}-${st}.woff)`, { weight: String(w), style: st })); } catch {}
      }
    }
  }
  return libs;
}
const fontFiles = new Map();
const loadFontFile = (name) => {
  if (!fontFiles.has(name)) fontFiles.set(name, fetch(V + 'fonts/' + name).then((r) => { if (!r.ok) throw new Error('font'); return r.arrayBuffer(); }));
  return fontFiles.get(name);
};

/** Text items → lines (one baseline, no big gaps), upright text only */
function groupLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue; // spaces come back from the gaps
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0 || d <= 0) continue;
    rows.push({ x: e, y: f, w: it.width, size: Math.hypot(c, d) || it.height, str: it.str, font: it.fontName });
  }
  rows.sort((p, q) => (Math.abs(q.y - p.y) > Math.min(p.size, q.size) * 0.35 ? q.y - p.y : p.x - q.x));
  const lines = [];
  for (const r of rows) {
    const l = lines.find((x) => Math.abs(x.y - r.y) < Math.min(x.size, r.size) * 0.35 && r.x >= x.x0 - 1 && r.x - x.x1 < Math.max(x.size, r.size) * 2.2);
    if (l) {
      const gap = r.x - l.x1;
      l.text += (gap > r.size * 0.15 && !/\s$/.test(l.text) && !/^\s/.test(r.str) ? ' ' : '') + r.str;
      l.x1 = Math.max(l.x1, r.x + r.w);
      l.size = Math.max(l.size, r.size);
    } else lines.push({ x0: r.x, x1: r.x + r.w, y: r.y, size: r.size, text: r.str, font: r.font });
  }
  return lines.filter((l) => l.text.trim()).map((l) => ({ ...l, text: l.text.replace(/\s+$/, '') }));
}

/** Background + text colour of an area of the rendered page (0..255) */
function sampleColors(canvas, x, y, w, h) {
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const X = Math.max(0, Math.floor(x));
    const Y = Math.max(0, Math.floor(y));
    const W = Math.max(1, Math.min(canvas.width - X, Math.ceil(w)));
    const H = Math.max(1, Math.min(canvas.height - Y, Math.ceil(h)));
    const d = ctx.getImageData(X, Y, W, H).data;
    const count = new Map();
    const key = (i) => ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    for (let i = 0; i < d.length; i += 4) count.set(key(i), (count.get(key(i)) || 0) + 1);
    const bgk = [...count].sort((p, q) => q[1] - p[1])[0][0];
    const bg = [(bgk >> 10) * 8 + 4, ((bgk >> 5) & 31) * 8 + 4, (bgk & 31) * 8 + 4];
    const far = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
      if (dist > 200) far.set(key(i), (far.get(key(i)) || 0) + dist);
    }
    const tk = far.size ? [...far].sort((p, q) => q[1] - p[1])[0][0] : null;
    const fg = tk == null ? [0, 0, 0] : [(tk >> 10) * 8 + 4, ((tk >> 5) & 31) * 8 + 4, (tk & 31) * 8 + 4];
    return { bg: bg.map((v) => Math.min(255, v)), fg: fg.map((v) => Math.min(255, v)) };
  } catch {
    return { bg: [255, 255, 255], fg: [0, 0, 0] };
  }
}

const dataUrlBytes = (url) => {
  const b = atob(url.split(',')[1]);
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
};

/** Any picture file → { bytes, mime (png|jpeg), w, h, url } */
async function readPicture(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  await img.decode();
  let bytes;
  let mime = blob.type;
  if (/^image\/(png|jpeg)$/.test(blob.type)) bytes = new Uint8Array(await blob.arrayBuffer());
  else {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    bytes = dataUrlBytes(c.toDataURL('image/png'));
    mime = 'image/png';
  }
  return { bytes, mime, w: img.naturalWidth, h: img.naturalHeight, url };
}

let uid = 0;
const nid = () => 'o' + ++uid;

export class PdfEditor {
  constructor(dialog) {
    this.d = dialog;
    this.box = $('#pe-pages', dialog);
    this.status = $('#pe-status', dialog);
    this.btnUndo = $('#pe-undo', dialog);
    this.btnSave = $('#pe-save', dialog);
    this.keep = $('#pe-keep', dialog);
    this.title = $('#pe-title', dialog);
    this.bar = $('#pe-toolbar', dialog);
    this.fileInput = $('#pe-file', dialog);
    this.customColor = $('#pe-color', dialog);
    this.resolve = null;
    this.pages = [];
    this.objs = [];
    this.history = [];
    this.tool = 'select';
    this.colors = { text: [17, 17, 17], shape: [220, 38, 38] };
    this.stroke = 2;
    this.fill = false;
    this.textSize = 12;
    this.clip = null;
    this.sel = null;

    $('#pe-cancel', dialog).addEventListener('click', () => {
      if (!this.dirty() || confirm('Discard your changes to this PDF?')) dialog.close();
    });
    dialog.addEventListener('cancel', (e) => {
      if (this.ed || this.ted || this.sel || this.tool !== 'select') { e.preventDefault(); this.escape(); return; }
      if (this.dirty() && !confirm('Discard your changes to this PDF?')) e.preventDefault();
    });
    dialog.addEventListener('close', () => this.finish(null));
    this.btnUndo.addEventListener('click', () => this.undo());
    this.btnSave.addEventListener('click', () => this.save());
    this.bar.addEventListener('click', (e) => this.onBar(e));
    this.customColor.addEventListener('input', () => this.setColor(unhex(this.customColor.value)));
    this.fileInput.addEventListener('change', () => { this.addPictures([...this.fileInput.files]); this.fileInput.value = ''; });
    this.box.addEventListener('click', (e) => {
      const b = e.target.closest('.pe-line');
      if (b && this.tool === 'select' && !this.busy && !this.justDragged) this.startEdit(+b.closest('.pe-page').dataset.i, +b.dataset.l);
    });
    this.box.addEventListener('dblclick', (e) => {
      const o = e.target.closest('.pe-obj');
      const ob = o && this.obj(o.dataset.id);
      if (ob && ob.type === 'text') this.editText(ob);
    });
    this.box.addEventListener('pointerdown', (e) => this.down(e));
    this.box.addEventListener('pointermove', (e) => this.move(e));
    this.box.addEventListener('pointerup', (e) => this.up(e));
    this.box.addEventListener('pointercancel', (e) => this.up(e));
    document.addEventListener('keydown', (e) => { if (this.d.open && !e.defaultPrevented) this.key(e); }); // focus is often on the page body
    document.addEventListener('paste', (e) => { if (this.d.open) this.onPaste(e); });
  }

  dirty() { return this.history.length > 0; }
  obj(id) { return this.objs.find((o) => o.id === id); }

  /** Resolves to { blob, keep } or null when cancelled */
  async open(blob, name, open) {
    await loadLibs();
    this.bytes = new Uint8Array(await blob.arrayBuffer());
    this.history = [];
    this.objs = [];
    this.sel = null;
    this.title.textContent = name || 'Edit PDF';
    await this.load();
    open(this.d);
    this.setTool('select');
    this.setStatus('Click a line to change it, or a picture to delete it. Use the tools to add text, pictures and shapes.');
    this.sync();
    const done = new Promise((r) => { this.resolve = r; });
    await this.buildPages();
    return done;
  }

  async load() {
    const old = this.task;
    try {
      this.task = libs.pdfjs.getDocument({ data: this.bytes.slice(), isEvalSupported: false, useWasm: false, standardFontDataUrl: V + 'standard_fonts/', verbosity: 0 });
      this.pdf = await this.task.promise;
      this.ldoc = await loadDoc(libs.L, this.bytes);
    } catch (e) {
      throw new Error(e && e.name === 'PasswordException' ? 'password' : /encrypt/i.test(String(e && e.message)) ? 'password' : 'open');
    }
    if (old) Promise.resolve().then(() => old.destroy()).catch(() => {});
  }

  finish(v) {
    const r = this.resolve;
    this.resolve = null;
    if (this.io) this.io.disconnect();
    this.io = null;
    this.ed = null;
    this.ted = null;
    this.sel = null;
    this.drag = null;
    for (const o of this.objs) if (o.url && o.url.startsWith('blob:')) URL.revokeObjectURL(o.url);
    this.objs = [];
    this.box.innerHTML = '';
    this.pages = [];
    if (this.task) { Promise.resolve().then(() => this.task.destroy()).catch(() => {}); this.task = null; }
    this.pdf = null;
    this.ldoc = null;
    this.history = [];
    if (r) r(v);
  }

  setStatus(t, kind = '') {
    this.status.textContent = t;
    this.status.dataset.kind = kind;
  }

  sync() {
    this.btnUndo.disabled = !this.history.length || this.busy;
    this.btnSave.disabled = !this.dirty() || this.busy;
    const s = this.sel;
    const o = s && s.kind === 'obj' ? this.obj(s.id) : null;
    const hasSel = !!(s || this.ed);
    for (const b of this.bar.querySelectorAll('[data-act="copy"], [data-act="delete"]')) b.disabled = !hasSel;
    for (const b of this.bar.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === this.tool));
    const kind = o ? (o.type === 'text' ? 'text' : SHAPES.has(o.type) ? 'shape' : 'image') : this.tool === 'text' ? 'text' : SHAPES.has(this.tool) ? 'shape' : 'none';
    this.bar.dataset.kind = kind;
    const col = o && o.color ? o.color : kind === 'text' ? this.colors.text : this.colors.shape;
    for (const b of this.bar.querySelectorAll('[data-color]')) b.setAttribute('aria-pressed', String(b.dataset.color === hex(col)));
    this.customColor.value = hex(col);
    $('#pe-fill', this.d).setAttribute('aria-pressed', String(o && 'fill' in o ? !!o.fill : this.fill));
    const w = o && o.width ? o.width : this.stroke;
    for (const b of this.bar.querySelectorAll('[data-w]')) b.setAttribute('aria-pressed', String(+b.dataset.w === w));
    this.box.classList.toggle('drawing', this.tool !== 'select');
  }

  /* ───────── pages ───────── */

  async buildPages() {
    this.box.innerHTML = '';
    this.pages = [];
    const width = Math.max(280, Math.min(900, this.box.clientWidth - 32));
    this.io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) this.renderPage(+en.target.dataset.i);
    }, { root: this.box, rootMargin: '800px 0px' });
    for (let i = 0; i < this.pdf.numPages; i++) {
      const page = await this.pdf.getPage(i + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = width / vp1.width;
      const el = document.createElement('div');
      el.className = 'pe-page';
      el.dataset.i = i;
      el.style.width = Math.round(vp1.width * scale) + 'px';
      el.style.height = Math.round(vp1.height * scale) + 'px';
      const objs = document.createElement('div');
      objs.className = 'pe-objs';
      el.append(objs);
      this.box.append(el);
      this.pages.push({ el, objsEl: objs, scale, lines: [], images: [] });
      this.io.observe(el);
    }
  }

  async renderPage(i, force = false) {
    const st = this.pages[i];
    if (!st || (st.done && !force) || st.busy) return;
    st.busy = true;
    try {
      const page = await this.pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: st.scale });
      const T = vp.transform;
      const toView = (x, y) => [T[0] * x + T[2] * y + T[4], T[1] * x + T[3] * y + T[5]];
      const rectOf = (x0, y0, x1, y1) => {
        const [ax, ay] = toView(x0, y0);
        const [bx, by] = toView(x1, y1);
        return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
      };
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const canvas = document.createElement('canvas');
      canvas.className = 'pe-canvas';
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      const tc = await page.getTextContent();
      const lines = groupLines(tc.items);
      let info = { images: [], shows: [] };
      try { info = pageInfo(libs.L, this.ldoc, i); } catch {}
      const layer = document.createElement('div');
      layer.className = 'pe-layer';
      st.images = info.images.map((m, k) => {
        const r = rectOf(m.x0, m.y0, m.x1, m.y1);
        const b = document.createElement('button');
        b.className = 'pe-img';
        b.dataset.k = k;
        b.title = 'Picture: click to select';
        b.setAttribute('aria-label', 'Picture');
        Object.assign(b.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        layer.append(b);
        return { ...m, rect: r };
      });
      lines.forEach((l, j) => {
        l.rect = rectOf(l.x0, l.y - l.size * 0.3, l.x1, l.y + l.size * 0.95);
        const runs = info.shows.filter((s) => Math.abs(s.y - l.y) < l.size * 0.45 && s.x >= l.x0 - l.size * 0.6 && s.x <= l.x1 + l.size * 0.15).sort((a, b) => a.x - b.x);
        if (runs.length) {
          l.fontRes = runs[0].font;
          l.fontName = runs[0].base || '';
          if (runs[0].fill) l.fill = runs[0].fill.map((v) => Math.round(v * 255));
        }
        if (!l.fontName) {
          try { const fo = page.commonObjs.has(l.font) ? page.commonObjs.get(l.font) : null; l.fontName = (fo && fo.name) || ''; } catch { l.fontName = ''; }
        }
        l.bold = /bold|black|heavy|semibold/i.test(l.fontName);
        l.italic = /italic|oblique/i.test(l.fontName);
        const b = document.createElement('button');
        b.className = 'pe-line';
        b.dataset.l = j;
        b.title = 'Click to edit this line';
        b.setAttribute('aria-label', 'Edit line: ' + l.text);
        Object.assign(b.style, { left: l.rect.x - 2 + 'px', top: l.rect.y + 'px', width: l.rect.w + 4 + 'px', height: l.rect.h + 'px' });
        layer.append(b);
      });
      st.lines = lines;
      st.vp = vp;
      st.T = T;
      st.flat = Math.abs(T[1]) < 1e-6 && Math.abs(T[2]) < 1e-6;
      st.canvas = canvas;
      st.dpr = dpr;
      st.el.querySelectorAll('.pe-canvas, .pe-layer, .pe-msg').forEach((n) => n.remove());
      st.el.prepend(canvas, layer);
      st.done = true;
      if (this.sel && this.sel.kind === 'img' && this.sel.page === i) this.select(null);
      if (!lines.length && i === 0 && !this.pages.some((p) => p.lines && p.lines.length)) {
        this.setStatus('No editable text on this page (it may be a scanned picture), but you can still add text, pictures and shapes.', 'warn');
      }
    } catch (e) {
      console.warn('PDF page', i + 1, e);
      const m = document.createElement('div');
      m.className = 'pe-msg';
      m.textContent = 'Could not show this page.';
      st.el.prepend(m);
    } finally {
      st.busy = false;
    }
  }

  /** view (page pixels) ⇄ PDF points */
  toPdf(st, vx, vy) { return [(vx - st.T[4]) / st.T[0], (vy - st.T[5]) / st.T[3]]; }

  activePage() {
    if (this.lastPage != null && this.pages[this.lastPage]) return this.lastPage;
    const top = this.box.getBoundingClientRect();
    let best = 0;
    let area = -1;
    this.pages.forEach((p, i) => {
      const r = p.el.getBoundingClientRect();
      const vis = Math.max(0, Math.min(r.bottom, top.bottom) - Math.max(r.top, top.top));
      if (vis > area) { area = vis; best = i; }
    });
    return best;
  }
  /** a spot in the visible part of a page (page pixels) */
  visibleSpot(i, w = 0, h = 0) {
    const st = this.pages[i];
    const r = st.el.getBoundingClientRect();
    const b = this.box.getBoundingClientRect();
    const top = Math.max(0, b.top - r.top);
    const bottom = Math.min(r.height, b.bottom - r.top);
    return { x: Math.max(8, (r.width - w) / 2), y: Math.max(8, top + (bottom - top - h) / 2) };
  }

  /* ───────── history ───────── */

  snapshot(page = null) {
    this.history.push({ bytes: this.bytes, objs: this.objs.map((o) => ({ ...o })), page });
    if (this.history.length > 40) this.history.shift();
  }

  async undo() {
    if (!this.history.length || this.busy) return;
    this.closeEditor();
    this.closeTextEditor(false);
    this.select(null);
    const h = this.history.pop();
    const bytesChanged = h.bytes !== this.bytes;
    this.bytes = h.bytes;
    this.objs = h.objs;
    if (bytesChanged) {
      this.busy = true;
      try {
        await this.load();
        if (h.page != null) await this.renderPage(h.page, true);
      } finally { this.busy = false; }
    }
    this.renderObjs();
    this.setStatus('Undone.');
    this.sync();
  }

  /* ───────── toolbar ───────── */

  onBar(e) {
    const t = e.target.closest('[data-tool]');
    if (t) { this.setTool(t.dataset.tool); return; }
    const c = e.target.closest('[data-color]');
    if (c) { this.setColor(unhex(c.dataset.color)); return; }
    const w = e.target.closest('[data-w]');
    if (w) { this.setStroke(+w.dataset.w); return; }
    const f = e.target.closest('[data-font]');
    if (f) { this.scaleText(+f.dataset.font); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'picture') this.fileInput.click();
    else if (a.dataset.act === 'fill') this.toggleFill();
    else if (a.dataset.act === 'copy') this.copy();
    else if (a.dataset.act === 'paste') this.paste();
    else if (a.dataset.act === 'delete') this.deleteSel();
  }

  setTool(t) {
    this.closeEditor();
    this.closeTextEditor(true);
    if (t !== 'select') this.select(null);
    this.tool = t;
    const tips = {
      select: 'Click a line to change it, a picture to select it, or something you added to move it.',
      text: 'Click where the new text should go.',
      rect: 'Drag to draw a rectangle.', ellipse: 'Drag to draw a circle / oval.', line: 'Drag to draw a line.',
      arrow: 'Drag from where the arrow starts to where it points.', check: 'Click or drag to place a tick.', cross: 'Click or drag to place a cross.'
    };
    this.setStatus(tips[t] || '');
    this.sync();
  }

  setColor(c) {
    const o = this.sel && this.sel.kind === 'obj' ? this.obj(this.sel.id) : null;
    if (o && o.type !== 'image') {
      this.snapshot();
      o.color = c;
      this.renderObj(o);
    } else if (this.ted) {
      this.ted.obj.color = c;
      this.ted.area.style.color = hex(c);
    } else if (this.tool === 'text') this.colors.text = c;
    else this.colors.shape = c;
    if (!o && !this.ted && this.tool === 'select') this.colors.shape = c;
    this.sync();
  }

  setStroke(w) {
    this.stroke = w;
    const o = this.sel && this.sel.kind === 'obj' ? this.obj(this.sel.id) : null;
    if (o && SHAPES.has(o.type)) { this.snapshot(); o.width = w; this.renderObj(o); }
    this.sync();
  }

  toggleFill() {
    const o = this.sel && this.sel.kind === 'obj' ? this.obj(this.sel.id) : null;
    if (o && (o.type === 'rect' || o.type === 'ellipse')) { this.snapshot(); o.fill = !o.fill; this.renderObj(o); }
    else this.fill = !this.fill;
    this.sync();
  }

  scaleText(dir) {
    const f = dir > 0 ? 1.15 : 1 / 1.15;
    const o = this.ted ? this.ted.obj : this.sel && this.sel.kind === 'obj' ? this.obj(this.sel.id) : null;
    if (o && o.type === 'text') {
      if (!this.ted) this.snapshot();
      o.size = Math.max(4, Math.min(200, Math.round(o.size * f * 10) / 10));
      this.textSize = o.size;
      if (this.ted) this.styleTextArea(this.ted.area, o, this.pages[o.page]);
      else this.renderObj(o);
    } else { this.textSize = Math.max(4, Math.min(200, Math.round(this.textSize * f * 10) / 10)); this.textSizeSet = true; }
    this.setStatus(`Text size ${Math.round((o && o.type === 'text' ? o.size : this.textSize) * 10) / 10} pt`);
  }

  /* ───────── selection ───────── */

  select(s) {
    this.sel = s;
    for (const n of this.box.querySelectorAll('.pe-obj.sel, .pe-img.sel')) n.classList.remove('sel');
    this.box.querySelectorAll('.pe-imgtools').forEach((n) => n.remove());
    if (s && s.kind === 'obj') {
      const el = this.box.querySelector(`.pe-obj[data-id="${s.id}"]`);
      if (el) el.classList.add('sel');
    } else if (s && s.kind === 'img') {
      const st = this.pages[s.page];
      const b = st.el.querySelector(`.pe-img[data-k="${s.k}"]`);
      if (b) {
        b.classList.add('sel');
        const m = st.images[s.k];
        const tools = document.createElement('div');
        tools.className = 'pe-tools pe-imgtools';
        tools.innerHTML = '<button data-pe="delimg">Delete picture</button><button data-pe="copy">Copy</button>';
        Object.assign(tools.style, { left: Math.max(4, m.rect.x) + 'px', top: Math.max(4, m.rect.y - 42) + 'px' });
        tools.addEventListener('click', (e) => {
          const t = e.target.closest('[data-pe]');
          if (t && t.dataset.pe === 'delimg') this.deleteSel();
          else if (t) this.copy();
        });
        st.el.append(tools);
      }
    }
    this.sync();
  }

  escape() {
    if (this.ted) this.closeTextEditor(true);
    else if (this.ed) this.closeEditor();
    else if (this.sel) this.select(null);
    else if (this.tool !== 'select') this.setTool('select');
  }

  key(e) {
    const typing = e.target.closest('input, textarea, [contenteditable="true"]');
    const mod = e.ctrlKey || e.metaKey;
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); }
    else if (mod && e.key.toLowerCase() === 'c') { if (this.sel) { e.preventDefault(); this.copy(); } }
    else if (mod && e.key.toLowerCase() === 'v') {
      // the browser usually follows with a paste event (which may carry outside text / pictures);
      // if it doesn't, paste what was copied here
      clearTimeout(this.pendingPaste);
      this.pendingPaste = setTimeout(() => { if (this.clip) this.paste(); }, 80);
    }
    else if (mod && e.key.toLowerCase() === 'd') { if (this.sel) { e.preventDefault(); this.copy(); this.paste(); } }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); this.deleteSel(); }
    else if (this.sel && this.sel.kind === 'obj' && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const o = this.obj(this.sel.id);
      const d = e.shiftKey ? 10 : 1;
      const [dx, dy] = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
      this.snapshot();
      this.moveObj(o, dx, dy);
      this.renderObj(o);
    }
  }

  /* ───────── pointer: draw / move / resize / pick ───────── */

  pagePoint(e, st) {
    const r = st.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  down(e) {
    if (e.button > 0 || this.busy) return;
    const pageEl = e.target.closest('.pe-page');
    if (!pageEl) return;
    const i = +pageEl.dataset.i;
    const st = this.pages[i];
    if (!st.done) return;
    this.lastPage = i;
    if (e.target.closest('.pe-tools, .pe-input, .pe-textedit')) return;
    const p = this.pagePoint(e, st);
    const handle = e.target.closest('.pe-h');
    const objEl = e.target.closest('.pe-obj');

    if (this.tool !== 'select' && !handle) {
      if (!st.flat) { this.setStatus('Adding things isn’t possible on a turned (rotated) page.', 'warn'); return; }
      e.preventDefault();
      this.closeEditor();
      this.closeTextEditor(true);
      if (this.tool === 'text') { this.newText(i, p.x, p.y); return; }
      const o = SHAPES.has(this.tool) && (this.tool === 'line' || this.tool === 'arrow')
        ? { id: nid(), page: i, type: this.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: this.colors.shape, width: this.stroke }
        : { id: nid(), page: i, type: this.tool, x: p.x, y: p.y, w: 0, h: 0, color: this.colors.shape, width: this.stroke, fill: this.fill };
      this.snapshot();
      this.objs.push(o);
      this.renderObj(o);
      this.drag = { kind: 'draw', o, st, sx: p.x, sy: p.y, id: e.pointerId };
      try { this.box.setPointerCapture(e.pointerId); } catch {}
      return;
    }

    if (handle || objEl) {
      e.preventDefault();
      const o = this.obj((handle || objEl).closest('.pe-obj').dataset.id);
      if (!o) return;
      this.closeEditor();
      if (!this.sel || this.sel.id !== o.id) this.select({ kind: 'obj', id: o.id });
      this.drag = { kind: handle ? 'resize' : 'move', h: handle && handle.dataset.h, o, st, sx: p.x, sy: p.y, orig: { ...o }, moved: false, id: e.pointerId };
      try { this.box.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    const img = e.target.closest('.pe-img');
    if (img && !e.target.closest('.pe-line')) {
      this.closeEditor();
      this.select({ kind: 'img', page: i, k: +img.dataset.k });
      return;
    }
    if (!e.target.closest('.pe-line')) { this.closeEditor(); this.select(null); }
  }

  move(e) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const p = this.pagePoint(e, d.st);
    const o = d.o;
    if (d.kind === 'draw') {
      if (o.type === 'line' || o.type === 'arrow') {
        o.x2 = p.x; o.y2 = p.y;
        if (e.shiftKey) { // straight: horizontal / vertical / 45°
          const a = Math.round(Math.atan2(o.y2 - o.y1, o.x2 - o.x1) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
          o.x2 = o.x1 + Math.cos(a) * len; o.y2 = o.y1 + Math.sin(a) * len;
        }
      } else {
        let w = p.x - d.sx;
        let h = p.y - d.sy;
        if (e.shiftKey || o.type === 'check' || o.type === 'cross') { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
        o.x = Math.min(d.sx, d.sx + w); o.y = Math.min(d.sy, d.sy + h); o.w = Math.abs(w); o.h = Math.abs(h);
      }
      this.renderObj(o);
      return;
    }
    const dx = p.x - d.sx;
    const dy = p.y - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    if (!d.moved) { d.moved = true; this.snapshot(); }
    Object.assign(o, d.orig);
    if (d.kind === 'move') this.moveObj(o, dx, dy);
    else this.resizeObj(o, d.h, dx, dy, e.shiftKey);
    this.renderObj(o);
  }

  up(e) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (d.kind === 'draw') {
      const o = d.o;
      const s = d.st.scale;
      if (o.type === 'line' || o.type === 'arrow') {
        if (Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 6) { o.x2 = o.x1 + 90 * s; o.y2 = o.y1; }
      } else if (o.w < 6 || o.h < 6) {
        const def = o.type === 'check' || o.type === 'cross' ? 22 * s : 90 * s;
        const defH = o.type === 'check' || o.type === 'cross' ? def : 60 * s;
        o.x = d.sx - def / 2; o.y = d.sy - defH / 2; o.w = def; o.h = defH;
      }
      this.renderObj(o);
      this.setTool('select');
      this.select({ kind: 'obj', id: o.id });
      this.setStatus('Drag to move it, use the corners to resize. Delete removes it.');
    } else if (d.moved) {
      this.justDragged = true;
      setTimeout(() => { this.justDragged = false; }, 0);
    }
    this.sync();
  }

  moveObj(o, dx, dy) {
    if ('x1' in o) { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; } else { o.x += dx; o.y += dy; }
  }

  resizeObj(o, h, dx, dy, keep) {
    if (h === 'p1') { o.x1 += dx; o.y1 += dy; return; }
    if (h === 'p2') { o.x2 += dx; o.y2 += dy; return; }
    let { x, y, w } = o;
    let hh = o.h;
    if (h.includes('e')) w += dx;
    if (h.includes('s')) hh += dy;
    if (h.includes('w')) { x += dx; w -= dx; }
    if (h.includes('n')) { y += dy; hh -= dy; }
    if ((keep || o.type === 'image' || o.type === 'check' || o.type === 'cross') && o.w && o.h) {
      const ratio = o.w / o.h;
      if (Math.abs(w / o.w) > Math.abs(hh / o.h)) { const nh = w / ratio; if (h.includes('n')) y += hh - nh; hh = nh; } else { const nw = hh * ratio; if (h.includes('w')) x += w - nw; w = nw; }
    }
    if (w < 8 || hh < 8) return;
    Object.assign(o, { x, y, w, h: hh });
  }

  /* ───────── objects on screen ───────── */

  renderObjs() {
    for (const st of this.pages) st.objsEl.innerHTML = '';
    for (const o of this.objs) this.renderObj(o);
    if (this.sel && this.sel.kind === 'obj' && !this.obj(this.sel.id)) this.sel = null;
    this.select(this.sel);
  }

  renderObj(o) {
    const st = this.pages[o.page];
    if (!st) return;
    let el = st.objsEl.querySelector(`.pe-obj[data-id="${o.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pe-obj';
      el.dataset.id = o.id;
      st.objsEl.append(el);
      if (this.sel && this.sel.id === o.id) el.classList.add('sel');
    }
    el.dataset.type = o.type;
    const s = st.scale;
    const handles = (list) => list.map((h) => `<i class="pe-h" data-h="${h}"></i>`).join('');
    if (o.type === 'text') {
      el.innerHTML = '';
      const span = document.createElement('div');
      span.className = 'pe-text';
      span.textContent = o.text;
      this.styleTextArea(span, o, st);
      el.append(span);
      Object.assign(el.style, { left: o.x + 'px', top: o.y + 'px', width: '', height: '' });
      return;
    }
    if (o.type === 'image') {
      Object.assign(el.style, { left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px' });
      el.innerHTML = `<img src="${o.url}" alt="" draggable="false">${handles(['nw', 'ne', 'sw', 'se'])}`;
      return;
    }
    const sw = Math.max(1, o.width * s);
    const col = hex(o.color);
    if (o.type === 'line' || o.type === 'arrow') {
      const pad = Math.max(10, sw * 4);
      const x0 = Math.min(o.x1, o.x2) - pad;
      const y0 = Math.min(o.y1, o.y2) - pad;
      const W = Math.abs(o.x2 - o.x1) + pad * 2;
      const H = Math.abs(o.y2 - o.y1) + pad * 2;
      const a = [o.x1 - x0, o.y1 - y0];
      const b = [o.x2 - x0, o.y2 - y0];
      let head = '';
      let end = b;
      if (o.type === 'arrow') {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const ux = (b[0] - a[0]) / len;
        const uy = (b[1] - a[1]) / len;
        const hl = Math.min(len * 0.45, Math.max(12, o.width * 5) * s);
        const bx = b[0] - ux * hl;
        const by = b[1] - uy * hl;
        const wx = -uy * hl * 0.55;
        const wy = ux * hl * 0.55;
        head = `<polygon points="${b[0]},${b[1]} ${bx + wx},${by + wy} ${bx - wx},${by - wy}" fill="${col}"/>`;
        end = [b[0] - ux * hl * 0.8, b[1] - uy * hl * 0.8];
      }
      Object.assign(el.style, { left: x0 + 'px', top: y0 + 'px', width: W + 'px', height: H + 'px' });
      el.innerHTML = `<svg width="${W}" height="${H}"><line x1="${a[0]}" y1="${a[1]}" x2="${end[0]}" y2="${end[1]}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>${head}<line class="pe-hit" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="transparent" stroke-width="${Math.max(14, sw + 10)}"/></svg>`
        + `<i class="pe-h" data-h="p1" style="left:${a[0]}px;top:${a[1]}px"></i><i class="pe-h" data-h="p2" style="left:${b[0]}px;top:${b[1]}px"></i>`;
      return;
    }
    Object.assign(el.style, { left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px' });
    const W = o.w;
    const H = o.h;
    const inset = sw / 2;
    let shape = '';
    if (o.type === 'rect') shape = `<rect x="${inset}" y="${inset}" width="${Math.max(0, W - sw)}" height="${Math.max(0, H - sw)}" stroke="${col}" stroke-width="${sw}" fill="${o.fill ? col : 'none'}"/>`;
    else if (o.type === 'ellipse') shape = `<ellipse cx="${W / 2}" cy="${H / 2}" rx="${Math.max(0, W / 2 - inset)}" ry="${Math.max(0, H / 2 - inset)}" stroke="${col}" stroke-width="${sw}" fill="${o.fill ? col : 'none'}"/>`;
    else if (o.type === 'check') shape = `<polyline points="${0.08 * W},${0.5 * H} ${0.38 * W},${0.82 * H} ${0.94 * W},${0.14 * H}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    else if (o.type === 'cross') shape = `<path d="M${0.12 * W} ${0.12 * H} L${0.88 * W} ${0.88 * H} M${0.12 * W} ${0.88 * H} L${0.88 * W} ${0.12 * H}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`;
    el.innerHTML = `<svg width="${W}" height="${H}" overflow="visible">${shape}</svg>${handles(['nw', 'ne', 'sw', 'se'])}`;
  }

  styleTextArea(node, o, st) {
    const pick = pickFont(o.fontName || (o.bold ? 'Helvetica-Bold' : 'Helvetica'));
    Object.assign(node.style, {
      font: `${pick.italic || o.italic ? 'italic ' : ''}${pick.bold || o.bold ? 700 : 400} ${o.size * st.scale}px/1.2 ${pick.css}`,
      color: hex(o.color)
    });
  }

  /* ───────── new text ───────── */

  pageStyle(i) {
    const st = this.pages[i];
    const lines = (st.lines || []).filter((l) => l.fontRes);
    if (!lines.length) return { size: this.textSize, fontName: 'Helvetica', src: null };
    const count = new Map();
    for (const l of lines) count.set(l.fontRes, (count.get(l.fontRes) || 0) + l.text.length);
    const font = [...count].sort((a, b) => b[1] - a[1])[0][0];
    const l = lines.find((x) => x.fontRes === font);
    return { size: Math.round(l.size * 10) / 10, fontName: l.fontName, src: { page: i, font } };
  }

  newText(i, x, y) {
    const sty = this.pageStyle(i);
    const size = this.textSizeSet ? this.textSize : sty.size;
    const o = { id: nid(), page: i, type: 'text', x, y: y - size * this.pages[i].scale * 0.6, text: '', size, color: this.colors.text, fontName: sty.fontName, src: sty.src };
    this.snapshot();
    this.objs.push(o);
    this.renderObj(o);
    this.editText(o, true);
  }

  editText(o, fresh = false) {
    this.closeTextEditor(true);
    const st = this.pages[o.page];
    const el = st.objsEl.querySelector(`.pe-obj[data-id="${o.id}"]`);
    if (el) el.classList.add('editing');
    const area = document.createElement('textarea');
    area.className = 'pe-textedit';
    area.value = o.text;
    area.placeholder = 'Type here';
    area.rows = Math.max(1, o.text.split('\n').length);
    this.styleTextArea(area, o, st);
    Object.assign(area.style, { left: o.x - 3 + 'px', top: o.y - 2 + 'px' });
    const fit = () => {
      area.rows = Math.max(1, area.value.split('\n').length);
      const m = document.createElement('canvas').getContext('2d');
      m.font = area.style.font;
      area.style.width = Math.max(60, ...area.value.split('\n').map((t) => m.measureText(t || ' ').width)) + 14 + 'px';
    };
    fit();
    st.el.append(area);
    this.ted = { obj: o, area, fresh, before: o.text };
    area.addEventListener('input', fit);
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.closeTextEditor(true); this.setTool('select'); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeTextEditor(true); }
    });
    area.addEventListener('blur', () => setTimeout(() => { if (this.ted && this.ted.area === area && !this.bar.contains(document.activeElement)) this.closeTextEditor(true); }, 120));
    this.setStatus('Type the text. Enter = done, Shift+Enter = new line.');
    area.focus();
    this.sync();
  }

  closeTextEditor(commit) {
    const t = this.ted;
    if (!t) return;
    this.ted = null;
    const o = t.obj;
    const text = commit ? t.area.value.replace(/\s+$/, '') : t.before;
    t.area.remove();
    if (!text) {
      if (!t.fresh) { o.text = t.before; this.snapshot(); }
      this.objs = this.objs.filter((x) => x.id !== o.id);
      const el = this.box.querySelector(`.pe-obj[data-id="${o.id}"]`);
      if (el) el.remove();
      if (t.fresh) this.history.pop(); // nothing was added after all
      if (this.sel && this.sel.id === o.id) this.sel = null;
    } else {
      if (!t.fresh && text !== t.before) { const cur = o.text; o.text = t.before; this.snapshot(); o.text = cur; }
      o.text = text;
      this.renderObj(o);
      this.select({ kind: 'obj', id: o.id });
    }
    const el = this.box.querySelector(`.pe-obj[data-id="${o.id}"]`);
    if (el) el.classList.remove('editing');
    this.sync();
  }

  /* ───────── pictures ───────── */

  async addPictures(list) {
    const i = this.activePage();
    const st = this.pages[i];
    if (!st || !st.done) return;
    if (!st.flat) { this.setStatus('Adding things isn’t possible on a turned (rotated) page.', 'warn'); return; }
    let added = 0;
    for (const f of list) {
      if (!/^image\//.test(f.type)) continue;
      try {
        const pic = await readPicture(f);
        const maxW = st.el.clientWidth * 0.45;
        const k = Math.min(1, maxW / pic.w, (st.el.clientHeight * 0.4) / pic.h, st.scale);
        const w = pic.w * k;
        const h = pic.h * k;
        const at = this.visibleSpot(i, w, h);
        if (!added) this.snapshot();
        const o = { id: nid(), page: i, type: 'image', x: at.x + added * 16, y: at.y + added * 16, w, h, url: pic.url, bytes: pic.bytes, mime: pic.mime };
        this.objs.push(o);
        this.renderObj(o);
        this.select({ kind: 'obj', id: o.id });
        added++;
      } catch {}
    }
    this.setTool('select');
    if (added) this.select({ kind: 'obj', id: this.objs[this.objs.length - 1].id });
    this.setStatus(added ? 'Picture added. Drag to move it, use the corners to resize.' : 'That file isn’t a picture this editor can use.', added ? '' : 'err');
  }

  /* ───────── copy / paste / delete ───────── */

  copy() {
    if (this.ed) {
      const st = this.pages[this.ed.i];
      const l = st.lines[this.ed.j];
      this.clip = { type: 'text', text: l.text, size: l.size, color: l.fill || this.ed.fg, fontName: l.fontName, bold: l.bold, italic: l.italic, src: l.fontRes ? { page: this.ed.i, font: l.fontRes } : null, from: { page: this.ed.i, x: l.rect.x, y: l.rect.y } };
      try { navigator.clipboard.writeText(l.text).catch(() => {}); } catch {}
      this.closeEditor();
      this.setStatus('Line copied. Press Paste (Ctrl+V) to add it again, then drag it where you want.');
    } else if (this.sel && this.sel.kind === 'img') {
      const st = this.pages[this.sel.page];
      const m = st.images[this.sel.k];
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(m.rect.w * st.dpr));
      c.height = Math.max(1, Math.round(m.rect.h * st.dpr));
      c.getContext('2d').drawImage(st.canvas, m.rect.x * st.dpr, m.rect.y * st.dpr, c.width, c.height, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/png');
      this.clip = { type: 'image', ref: m.name ? { page: this.sel.page, name: m.name } : null, url, w: m.rect.w, h: m.rect.h, from: { page: this.sel.page, x: m.rect.x, y: m.rect.y } };
      this.setStatus('Picture copied. Press Paste (Ctrl+V) to add a copy.');
    } else if (this.sel && this.sel.kind === 'obj') {
      const o = this.obj(this.sel.id);
      if (!o) return;
      this.clip = { type: 'obj', obj: { ...o } };
      if (o.type === 'text') try { navigator.clipboard.writeText(o.text).catch(() => {}); } catch {}
      this.setStatus('Copied. Press Paste (Ctrl+V) to add a copy.');
    }
    this.sync();
  }

  paste(sys) {
    const i = this.activePage();
    const st = this.pages[i];
    if (!st || !st.done) return;
    if (!st.flat) { this.setStatus('Adding things isn’t possible on a turned (rotated) page.', 'warn'); return; }
    const c = sys || this.clip;
    if (!c) { this.setStatus('Copy a line, a picture or something you added first.', 'warn'); return; }
    const off = (from, w = 0, h = 0) => (from && from.page === i ? { x: from.x + 18, y: from.y + 18 } : this.visibleSpot(i, w, h));
    let o;
    if (c.type === 'text') {
      const sty = c.src ? { size: c.size, fontName: c.fontName, src: c.src } : this.pageStyle(i);
      const at = off(c.from);
      o = { id: nid(), page: i, type: 'text', x: at.x, y: at.y, text: c.text, size: c.size || sty.size, color: c.color || this.colors.text, fontName: c.fontName || sty.fontName, bold: c.bold, italic: c.italic, src: c.src || sty.src };
    } else if (c.type === 'image') {
      const sc = c.from ? st.scale / this.pages[c.from.page].scale : 1;
      const at = off(c.from, c.w * sc, c.h * sc);
      o = { id: nid(), page: i, type: 'image', x: at.x, y: at.y, w: c.w * sc, h: c.h * sc, url: c.url, ref: c.ref, bytes: c.bytes || (c.ref ? null : dataUrlBytes(c.url)), mime: c.mime || 'image/png' };
    } else {
      o = { ...c.obj, id: nid(), page: i };
      const same = c.obj.page === i;
      const dx = same ? 18 : 0;
      if (same) this.moveObj(o, dx, dx);
      else {
        const at = this.visibleSpot(i);
        if ('x1' in o) this.moveObj(o, at.x - Math.min(o.x1, o.x2), at.y - Math.min(o.y1, o.y2));
        else this.moveObj(o, at.x - o.x, at.y - o.y);
      }
      c.obj = { ...o }; // next paste goes a bit further
    }
    this.snapshot();
    this.objs.push(o);
    this.renderObj(o);
    this.setTool('select');
    this.select({ kind: 'obj', id: o.id });
    this.setStatus('Pasted. Drag it where you want it.');
  }

  async onPaste(e) {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    clearTimeout(this.pendingPaste);
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...dt.files].filter((f) => /^image\//.test(f.type));
    if (files.length) { e.preventDefault(); this.addPictures(files); return; }
    const text = dt.getData('text/plain');
    e.preventDefault();
    if (this.clip && (!text || (this.clip.type === 'text' && text.trim() === this.clip.text.trim()) || (this.clip.type === 'obj' && this.clip.obj.type === 'text' && text.trim() === this.clip.obj.text.trim()))) { this.paste(); return; }
    if (text) {
      const i = this.activePage();
      const sty = this.pageStyle(i);
      this.paste({ type: 'text', text: text.replace(/\r/g, ''), size: sty.size, fontName: sty.fontName, src: sty.src, color: this.colors.text });
      return;
    }
    if (this.clip) this.paste();
  }

  async deleteSel() {
    if (this.ed) { this.apply(''); return; }
    const s = this.sel;
    if (!s || this.busy) return;
    if (s.kind === 'obj') {
      this.snapshot();
      this.objs = this.objs.filter((o) => o.id !== s.id);
      const el = this.box.querySelector(`.pe-obj[data-id="${s.id}"]`);
      if (el) el.remove();
      this.select(null);
      this.setStatus('Removed.');
      return;
    }
    if (s.kind === 'img') {
      const st = this.pages[s.page];
      const m = st.images[s.k];
      this.busy = true;
      this.sync();
      this.setStatus('Removing the picture…');
      try {
        const out = await removeImage(libs.L, this.bytes, s.page, m.op);
        this.snapshot(s.page);
        this.bytes = out;
        this.select(null);
        await this.load();
        await this.renderPage(s.page, true);
        this.setStatus('Picture deleted.', 'ok');
      } catch {
        this.setStatus('Could not delete this picture.', 'err');
      } finally {
        this.busy = false;
        this.sync();
      }
    }
  }

  /* ───────── editing an existing line ───────── */

  startEdit(i, j) {
    this.closeEditor();
    this.closeTextEditor(true);
    this.select(null);
    const st = this.pages[i];
    const l = st && st.lines[j];
    if (!l) return;
    this.lastPage = i;
    const r = l.rect;
    const c = sampleColors(st.canvas, r.x * st.dpr, r.y * st.dpr, r.w * st.dpr, r.h * st.dpr);
    const fg = l.fill || c.fg;
    const pick = pickFont(l.fontName);
    const px = l.size * st.scale;
    const font = `${l.italic ? 'italic ' : ''}${l.bold ? 700 : 400} ${px}px ${pick.css}`;
    const wrap = document.createElement('div');
    wrap.className = 'pe-edit';
    const patch = document.createElement('div');
    patch.className = 'pe-patch';
    Object.assign(patch.style, { left: r.x - 3 + 'px', top: r.y - 1 + 'px', width: r.w + 6 + 'px', height: r.h + 2 + 'px', background: `rgb(${c.bg})` });
    const input = document.createElement('input');
    input.className = 'pe-input';
    input.value = l.text;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Line text');
    Object.assign(input.style, { left: r.x + 'px', top: r.y + 'px', height: r.h + 'px', font, color: `rgb(${fg})`, lineHeight: r.h + 'px' });
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = font;
    const grow = () => { input.style.width = Math.max(r.w, meas.measureText(input.value || ' ').width) + 6 + 'px'; };
    grow();
    const tools = document.createElement('div');
    tools.className = 'pe-tools';
    tools.innerHTML = '<button class="pe-apply" data-pe="apply">Apply</button><button data-pe="delete">Delete line</button><button data-pe="copy">Copy</button><button data-pe="cancel">Cancel</button><span>Enter = apply · Esc = cancel</span>';
    const below = r.y + r.h + 46 < st.el.clientHeight;
    Object.assign(tools.style, { left: Math.max(4, Math.min(r.x, st.el.clientWidth - 380)) + 'px', top: (below ? r.y + r.h + 6 : r.y - 42) + 'px' });
    wrap.append(patch, input, tools);
    st.el.append(wrap);
    this.ed = { i, j, wrap, input, bg: c.bg, fg };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.apply(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeEditor(); }
    });
    tools.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pe]');
      if (!b) return;
      if (b.dataset.pe === 'apply') this.apply(input.value);
      else if (b.dataset.pe === 'delete') this.apply('');
      else if (b.dataset.pe === 'copy') this.copy();
      else this.closeEditor();
    });
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    this.sync();
  }

  closeEditor() {
    if (this.ed) this.ed.wrap.remove();
    this.ed = null;
    this.sync();
  }

  async apply(text) {
    const ed = this.ed;
    if (!ed || this.busy) return;
    const st = this.pages[ed.i];
    const l = st.lines[ed.j];
    text = text.replace(/\s+$/, '');
    if (text === l.text) { this.closeEditor(); return; }
    this.busy = true;
    this.sync();
    this.setStatus('Saving the change…');
    ed.wrap.classList.add('busy');
    try {
      const res = await applyLineEdit(libs.L, libs.fontkit, this.bytes, {
        page: ed.i,
        line: { x0: l.x0, x1: l.x1, y: l.y, size: l.size },
        oldText: l.text,
        text,
        bg: ed.bg.map((v) => v / 255),
        color: ed.fg.map((v) => v / 255),
        fontName: l.fontName
      }, loadFontFile);
      this.snapshot(ed.i);
      this.bytes = res.bytes;
      await this.load();
      this.ed = null;
      ed.wrap.remove();
      await this.renderPage(ed.i, true);
      this.setStatus(
        !text ? 'Line deleted.'
          : res.mode === 'same' ? 'Changed in the document’s own font and colour.'
          : res.mode === 'match' ? 'Changed. Some letters aren’t in the document’s font, so a matching font was used (colour kept).'
          : 'Changed (written over the old line).',
        res.mode === 'same' || !text ? 'ok' : 'warn'
      );
    } catch (e) {
      if (!(e && e.message === 'chars')) console.warn('PDF edit', e);
      ed.wrap.classList.remove('busy');
      this.setStatus(e && e.message === 'chars' ? `These characters can’t be added to this PDF: ${e.chars}` : 'Could not change this line.', 'err');
    } finally {
      this.busy = false;
      this.sync();
    }
  }

  /* ───────── save ───────── */

  async save() {
    if (!this.dirty() || this.busy) return;
    this.closeTextEditor(true);
    this.closeEditor();
    this.busy = true;
    this.sync();
    this.setStatus('Saving…');
    try {
      const objs = [];
      for (const o of this.objs) {
        const st = this.pages[o.page];
        if (!st || !st.T) continue;
        const P = (x, y) => this.toPdf(st, x, y);
        const s = st.scale;
        if (o.type === 'text') {
          const [x, y] = P(o.x, o.y + o.size * s * 0.94);
          objs.push({ page: o.page, type: 'text', x, y, size: o.size, lines: o.text.split('\n'), color: o.color, fontName: o.fontName, bold: o.bold, italic: o.italic, src: o.src });
        } else if (o.type === 'line' || o.type === 'arrow') {
          const [x1, y1] = P(o.x1, o.y1);
          const [x2, y2] = P(o.x2, o.y2);
          objs.push({ page: o.page, type: o.type, x1, y1, x2, y2, color: o.color, width: o.width });
        } else {
          const [x, y] = P(o.x, o.y + o.h);
          const base = { page: o.page, type: o.type, x, y, w: o.w / s, h: o.h / s };
          if (o.type === 'image') objs.push({ ...base, ref: o.ref, bytes: o.bytes, mime: o.mime });
          else objs.push({ ...base, color: o.color, width: o.width, fill: !!o.fill });
        }
      }
      const out = objs.length ? await addObjects(libs.L, libs.fontkit, this.bytes, objs, loadFontFile) : this.bytes;
      const r = this.resolve;
      this.resolve = null;
      const result = { blob: new Blob([out], { type: 'application/pdf' }), keep: this.keep.checked };
      this.busy = false;
      this.d.close();
      if (r) r(result);
    } catch (e) {
      console.warn('PDF save', e);
      this.busy = false;
      this.sync();
      this.setStatus(e && e.message === 'chars' ? `These characters can’t be added to this PDF: ${e.chars}` : 'Could not save the PDF.', 'err');
    }
  }
}
