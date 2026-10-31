// PDF text editor: shows the pages, click a line to change or delete it.
// The change is written into the PDF itself (see pdfcore.js) and the page is re-drawn from
// the new file, so what you see is exactly what will be saved.

import { applyLineEdit, pickFont } from './pdfcore.js';

const V = '/vendor/pdf/';
const $ = (s, r = document) => r.querySelector(s);
let libs = null;

async function loadViewer() {
  if (libs) return libs;
  const pdfjs = await import(V + 'pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = V + 'pdf.worker.min.mjs';
  libs = { pdfjs };
  // look-alike fonts for the live preview while typing
  for (const fam of ['Carlito', 'Caladea']) {
    for (const w of [400, 700]) {
      for (const st of ['normal', 'italic']) {
        try { document.fonts.add(new FontFace(fam, `url(${V}fonts/${fam.toLowerCase()}-latin-${w}-${st}.woff)`, { weight: String(w), style: st })); } catch {}
      }
    }
  }
  return libs;
}
async function loadWriter() {
  if (!libs.L) libs.L = await import(V + 'pdf-lib.esm.min.js');
  if (!window.fontkit) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = V + 'fontkit.umd.min.js';
      s.onload = res;
      s.onerror = rej;
      document.head.append(s);
    });
  }
  libs.fontkit = window.fontkit;
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

/** Background + text colour of a line, read from the rendered page */
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

export class PdfEditor {
  constructor(dialog) {
    this.d = dialog;
    this.box = $('#pe-pages', dialog);
    this.status = $('#pe-status', dialog);
    this.btnUndo = $('#pe-undo', dialog);
    this.btnSave = $('#pe-save', dialog);
    this.keep = $('#pe-keep', dialog);
    this.title = $('#pe-title', dialog);
    this.resolve = null;
    this.pages = [];

    $('#pe-cancel', dialog).addEventListener('click', () => {
      if (!this.history.length || confirm('Discard your changes to this PDF?')) dialog.close();
    });
    dialog.addEventListener('cancel', (e) => {
      if (this.ed) { e.preventDefault(); this.closeEditor(); return; }
      if (this.history.length && !confirm('Discard your changes to this PDF?')) e.preventDefault();
    });
    dialog.addEventListener('close', () => this.finish(null));
    this.btnUndo.addEventListener('click', () => this.undo());
    this.btnSave.addEventListener('click', () => this.save());
    this.box.addEventListener('click', (e) => {
      const b = e.target.closest('.pe-line');
      if (b && !this.busy) this.startEdit(+b.closest('.pe-page').dataset.i, +b.dataset.l);
    });
    dialog.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !this.ed) { e.preventDefault(); this.undo(); }
    });
  }

  /** Resolves to { blob, keep } or null when cancelled */
  async open(blob, name, open) {
    await loadViewer();
    this.bytes = new Uint8Array(await blob.arrayBuffer());
    this.history = [];
    this.title.textContent = name || 'Edit PDF';
    await this.load();
    open(this.d);
    this.setStatus('Click any line to change it. Clear a line to delete it.');
    this.sync();
    const done = new Promise((r) => { this.resolve = r; });
    await this.buildPages();
    return done;
  }

  async load() {
    const old = this.task;
    try {
      this.task = libs.pdfjs.getDocument({
        data: this.bytes.slice(),
        isEvalSupported: false,
        useWasm: false,
        standardFontDataUrl: V + 'standard_fonts/',
        verbosity: 0
      });
      this.pdf = await this.task.promise;
    } catch (e) {
      throw new Error(e && e.name === 'PasswordException' ? 'password' : 'open');
    }
    if (old) Promise.resolve().then(() => old.destroy()).catch(() => {});
  }

  finish(v) {
    const r = this.resolve;
    this.resolve = null;
    if (this.io) this.io.disconnect();
    this.io = null;
    this.ed = null;
    this.box.innerHTML = '';
    this.pages = [];
    if (this.task) { Promise.resolve().then(() => this.task.destroy()).catch(() => {}); this.task = null; }
    this.pdf = null;
    this.history = [];
    if (r) r(v);
  }

  setStatus(t, kind = '') {
    this.status.textContent = t;
    this.status.dataset.kind = kind;
  }

  sync() {
    this.btnUndo.disabled = !this.history.length || this.busy;
    this.btnSave.disabled = !this.history.length || this.busy;
  }

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
      this.box.append(el);
      this.pages.push({ el, scale, lines: [] });
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
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      const ctx = canvas.getContext('2d');
      await page.render({ canvas, canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      const tc = await page.getTextContent();
      const lines = groupLines(tc.items);
      const layer = document.createElement('div');
      layer.className = 'pe-layer';
      lines.forEach((l, j) => {
        const T = vp.transform;
        const pt = (x, y) => [T[0] * x + T[2] * y + T[4], T[1] * x + T[3] * y + T[5]];
        const [ax, ay] = pt(l.x0, l.y - l.size * 0.3);
        const [bx, by] = pt(l.x1, l.y + l.size * 0.95);
        l.rect = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
        try {
          const fo = page.commonObjs.has(l.font) ? page.commonObjs.get(l.font) : null;
          l.fontName = (fo && fo.name) || '';
          l.bold = !!(fo && (fo.bold || fo.black)) || /bold|black|heavy/i.test(l.fontName);
          l.italic = !!(fo && fo.italic) || /italic|oblique/i.test(l.fontName);
        } catch { l.fontName = ''; }
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
      st.canvas = canvas;
      st.dpr = dpr;
      st.el.replaceChildren(canvas, layer);
      st.done = true;
      if (!lines.length && i === 0 && !this.pages.some((p) => p.lines && p.lines.length)) {
        this.setStatus('No editable text found on this page — it may be a scanned picture.', 'warn');
      }
    } catch (e) {
      console.warn('PDF page', i + 1, e);
      st.el.textContent = 'Could not show this page.';
    } finally {
      st.busy = false;
    }
  }

  startEdit(i, j) {
    this.closeEditor();
    const st = this.pages[i];
    const l = st && st.lines[j];
    if (!l) return;
    const r = l.rect;
    const c = sampleColors(st.canvas, r.x * st.dpr, r.y * st.dpr, r.w * st.dpr, r.h * st.dpr);
    const css = pickFont(l.fontName).css;
    const px = l.size * st.scale;
    const font = `${l.italic ? 'italic ' : ''}${l.bold ? 700 : 400} ${px}px ${css}`;

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
    Object.assign(input.style, { left: r.x + 'px', top: r.y + 'px', height: r.h + 'px', font, color: `rgb(${c.fg})`, lineHeight: r.h + 'px' });
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = font;
    const grow = () => { input.style.width = Math.max(r.w, meas.measureText(input.value || ' ').width) + 6 + 'px'; };
    grow();
    const tools = document.createElement('div');
    tools.className = 'pe-tools';
    tools.innerHTML = '<button class="pe-apply" data-pe="apply">Apply</button><button data-pe="delete">Delete line</button><button data-pe="cancel">Cancel</button><span>Enter = apply · Esc = cancel</span>';
    const below = r.y + r.h + 46 < st.el.clientHeight;
    Object.assign(tools.style, { left: Math.max(4, Math.min(r.x, st.el.clientWidth - 330)) + 'px', top: (below ? r.y + r.h + 6 : r.y - 42) + 'px' });
    wrap.append(patch, input, tools);
    st.el.append(wrap);
    this.ed = { i, j, wrap, input, bg: c.bg, fg: c.fg };
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
      else this.closeEditor();
    });
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  closeEditor() {
    if (this.ed) this.ed.wrap.remove();
    this.ed = null;
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
      await loadWriter();
      const res = await applyLineEdit(libs.L, libs.fontkit, this.bytes, {
        page: ed.i,
        line: { x0: l.x0, x1: l.x1, y: l.y, size: l.size },
        text,
        bg: ed.bg.map((v) => v / 255),
        color: ed.fg.map((v) => v / 255),
        fontName: l.fontName
      }, loadFontFile);
      this.history.push({ bytes: this.bytes, page: ed.i });
      if (this.history.length > 30) this.history.shift();
      this.bytes = res.bytes;
      await this.load();
      this.closeEditor();
      await this.renderPage(ed.i, true);
      this.setStatus(
        !text ? 'Line deleted.'
          : res.mode === 'same' ? 'Changed in the document’s own font.'
          : res.mode === 'match' ? 'Changed. Some letters aren’t in the document’s font, so a matching font was used.'
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

  async undo() {
    if (!this.history.length || this.busy) return;
    this.closeEditor();
    this.busy = true;
    const h = this.history.pop();
    this.bytes = h.bytes;
    try {
      await this.load();
      await this.renderPage(h.page, true);
      this.setStatus('Undone.');
    } finally {
      this.busy = false;
      this.sync();
    }
  }

  save() {
    if (!this.history.length || this.busy) return;
    const r = this.resolve;
    this.resolve = null;
    const out = { blob: new Blob([this.bytes], { type: 'application/pdf' }), keep: this.keep.checked };
    this.d.close();
    if (r) r(out);
  }
}
