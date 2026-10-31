import { cycleCase, CASE_LABEL } from './textcase.js';

// Canvas notes: a fixed-width page (1000 units, scaled to the screen so it looks the same on every device)
// where text boxes, pictures, shapes, lines/arrows, emojis and pen strokes can be placed, moved,
// resized and rotated freely. Stored in note.data.canvas = { v: 1, items: [...] }.

const W = 1000;
const MIN_H = 1414;
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rad = (d) => (d * Math.PI) / 180;
const rot = (x, y, deg) => { const a = rad(deg); const c = Math.cos(a); const s = Math.sin(a); return { x: x * c - y * s, y: x * s + y * c }; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = (v) => Math.round(v * 10) / 10;

const INKS = ['', '#ffffff', '#868e96', '#e03131', '#f08c00', '#fab005', '#2f9e44', '#1c7ed6', '#7048e8', '#d6336c', '#000000'];
const FILLS = ['none', '#ffe8a3', '#ffd8a8', '#ffc9c9', '#d3f9d8', '#d0ebff', '#e5dbff', '#f1f3f5', '#ffffff', '#fab005', '#e03131', '#2f9e44', '#1c7ed6', '#7048e8', '#16181d'];
const SHAPES = [
  ['rect', 'Rectangle'], ['round', 'Rounded box'], ['ellipse', 'Circle'], ['tri', 'Triangle'],
  ['diamond', 'Diamond'], ['star', 'Star'], ['hex', 'Hexagon'], ['bubble', 'Speech bubble'], ['heart', 'Heart']
];
const LINES = [['line', 'Line'], ['arrow', 'Arrow'], ['arrow2', 'Two-way arrow'], ['dash', 'Dashed arrow']];
const EMOJI = {
  '😀': '😀 😃 😄 😁 😆 😅 😂 🤣 😊 🙂 😉 😍 🥰 😘 😎 🤓 🤔 🤨 😐 😴 😮 😲 😢 😭 😡 🤯 🥳 😇 🙃 😬 🤗 🤩 😤 🥺',
  '👍': '👍 👎 👏 🙌 👋 ✌️ 🤞 👌 🤝 🙏 💪 👀 👉 👈 👆 👇 ✋ 🧠 👩‍🏫 👨‍🏫 🧑‍🎓 👨‍💻 👩‍💻 🏃 🙋 🤷',
  '📚': '📚 📖 📝 ✏️ 🖊️ 📌 📍 📎 📅 ⏰ ⏳ 📊 📈 📉 💡 🔔 📢 🎓 🏫 💻 📱 📁 🔑 🔒 🗓️ 🧾 💼 🧮',
  '✅': '✅ ❌ ⚠️ ❗ ❓ ⭐ 🌟 ✨ 🔥 💯 ❤️ 💙 💚 💛 🧡 💜 ➡️ ⬅️ ⬆️ ⬇️ ↗️ 🔁 ➕ ➖ ✔️ ☑️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪',
  '🌸': '☀️ 🌙 ⛅ 🌧️ ❄️ 🌈 🌸 🌻 🌳 🍀 🐱 🐶 🦁 🐼 🦋 🍎 🍕 🍔 ☕ 🍰 🎂 🍉 🍫 🥐',
  '🎉': '🎉 🎈 🎁 🏆 🥇 🎯 🎨 🎵 🎮 ⚽ 🏀 🚗 ✈️ 🚀 🏠 🌍 🗺️ 📷 🎬 💤 💬 💭 🇽🇰 🇦🇱'
};

/* ───────────── drawing ───────────── */

function bbox(o) {
  if (o.t === 'line') {
    const x = Math.min(o.x1, o.x2);
    const y = Math.min(o.y1, o.y2);
    return { x, y, w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h || 0 };
}
/** Outer box after rotation (for page height and snapping) */
function extent(o) {
  const b = bbox(o);
  if (!o.r || o.t === 'line') return b;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => rot((sx * b.w) / 2, (sy * b.h) / 2, o.r));
  const xs = pts.map((p) => cx + p.x);
  const ys = pts.map((p) => cy + p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

const ink = (c) => (c ? c : 'var(--cv-ink)');
function shapeSvg(o) {
  const w = Math.max(1, o.w);
  const h = Math.max(1, o.h);
  const sw = o.stroke === 'none' ? 0 : o.sw != null ? o.sw : 3;
  const i = sw / 2 + 0.5;
  const st = `style="fill:${o.fill === 'none' ? 'none' : o.fill || '#ffe8a3'};stroke:${o.stroke === 'none' ? 'none' : ink(o.stroke)};stroke-width:${sw}px;stroke-linejoin:round"`;
  const poly = (pts) => `<polygon points="${pts.map((p) => p.map(r1).join(',')).join(' ')}" ${st}/>`;
  let body;
  switch (o.kind) {
    case 'round': body = `<rect x="${i}" y="${i}" width="${w - 2 * i}" height="${h - 2 * i}" rx="${Math.min(w, h) * 0.16}" ${st}/>`; break;
    case 'ellipse': body = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(1, w / 2 - i)}" ry="${Math.max(1, h / 2 - i)}" ${st}/>`; break;
    case 'tri': body = poly([[w / 2, i], [w - i, h - i], [i, h - i]]); break;
    case 'diamond': body = poly([[w / 2, i], [w - i, h / 2], [w / 2, h - i], [i, h / 2]]); break;
    case 'hex': body = poly([[w * 0.25, i], [w * 0.75, i], [w - i, h / 2], [w * 0.75, h - i], [w * 0.25, h - i], [i, h / 2]]); break;
    case 'star': {
      const pts = [];
      for (let k = 0; k < 10; k++) {
        const a = rad(-90 + k * 36);
        const f = k % 2 ? 0.45 : 1;
        pts.push([w / 2 + Math.cos(a) * (w / 2 - i) * f, h / 2 + 0.06 * h + Math.sin(a) * (h / 2 - i) * f]);
      }
      body = poly(pts);
      break;
    }
    case 'bubble': {
      const b = h * 0.76;
      const r = Math.min(w, b) * 0.18;
      body = `<path d="M${i + r},${i} H${w - i - r} Q${w - i},${i} ${w - i},${i + r} V${b - r} Q${w - i},${b} ${w - i - r},${b} H${w * 0.4} L${w * 0.2},${h - i} L${w * 0.24},${b} H${i + r} Q${i},${b} ${i},${b - r} V${i + r} Q${i},${i} ${i + r},${i} Z" ${st}/>`;
      break;
    }
    case 'heart':
      body = `<path d="M${w / 2},${h - i} C${w * 0.1},${h * 0.62} ${i},${h * 0.42} ${i},${h * 0.27} C${i},${h * 0.1} ${w * 0.16},${i} ${w * 0.3},${i} C${w * 0.4},${i} ${w * 0.47},${h * 0.07} ${w / 2},${h * 0.17} C${w * 0.53},${h * 0.07} ${w * 0.6},${i} ${w * 0.7},${i} C${w * 0.84},${i} ${w - i},${h * 0.1} ${w - i},${h * 0.27} C${w - i},${h * 0.42} ${w * 0.9},${h * 0.62} ${w / 2},${h - i} Z" ${st}/>`;
      break;
    default: body = `<rect x="${i}" y="${i}" width="${w - 2 * i}" height="${h - 2 * i}" ${st}/>`;
  }
  return `<svg class="cv-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}

function lineGeom(o) {
  const sw = o.sw != null ? o.sw : 4;
  const pad = Math.max(24, sw * 4);
  const b = bbox(o);
  return { pad, sw, left: b.x - pad, top: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
}
function lineSvg(o) {
  const g = lineGeom(o);
  const x1 = o.x1 - g.left;
  const y1 = o.y1 - g.top;
  const x2 = o.x2 - g.left;
  const y2 = o.y2 - g.top;
  const a = Math.atan2(y2 - y1, x2 - x1);
  const L = Math.max(16, g.sw * 3.4);
  const hw = L * 0.72;
  const col = ink(o.stroke);
  const head = (tx, ty, ang) => {
    const bx = tx - Math.cos(ang) * L;
    const by = ty - Math.sin(ang) * L;
    const px = -Math.sin(ang) * hw;
    const py = Math.cos(ang) * hw;
    return `<polygon points="${r1(tx)},${r1(ty)} ${r1(bx + px)},${r1(by + py)} ${r1(bx - px)},${r1(by - py)}" style="fill:${col};stroke:${col};stroke-width:${Math.max(1, g.sw / 2)}px;stroke-linejoin:round"/>`;
  };
  const end = o.kind !== 'line';
  const start = o.kind === 'arrow2';
  const len = Math.hypot(x2 - x1, y2 - y1);
  const cut = Math.min(L * 0.8, len / 2.2);
  const sx = start ? x1 + Math.cos(a) * cut : x1;
  const sy = start ? y1 + Math.sin(a) * cut : y1;
  const ex = end ? x2 - Math.cos(a) * cut : x2;
  const ey = end ? y2 - Math.sin(a) * cut : y2;
  const dash = o.kind === 'dash' ? `stroke-dasharray:${g.sw * 2.5}px ${g.sw * 2}px;` : '';
  return `<svg class="cv-svg" width="${g.w}" height="${g.h}" viewBox="0 0 ${g.w} ${g.h}">` +
    `<line x1="${r1(sx)}" y1="${r1(sy)}" x2="${r1(ex)}" y2="${r1(ey)}" style="stroke:${col};stroke-width:${g.sw}px;stroke-linecap:round;${dash}"/>` +
    `<line class="cv-hit" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" style="stroke:transparent;stroke-width:${Math.max(22, g.sw + 16)}px;stroke-linecap:round"/>` +
    (end ? head(x2, y2, a) : '') + (start ? head(x1, y1, a + Math.PI) : '') + '</svg>';
}

function penPath(pts, sx = 1, sy = 1) {
  if (!pts.length) return '';
  const p = pts.map(([x, y]) => [x * sx, y * sy]);
  if (p.length < 3) return `M${p.map((q) => q.map(r1).join(',')).join(' L')}${p.length === 1 ? ` l0.1,0.1` : ''}`;
  let d = `M${r1(p[0][0])},${r1(p[0][1])}`;
  for (let k = 1; k < p.length - 1; k++) {
    const mx = (p[k][0] + p[k + 1][0]) / 2;
    const my = (p[k][1] + p[k + 1][1]) / 2;
    d += ` Q${r1(p[k][0])},${r1(p[k][1])} ${r1(mx)},${r1(my)}`;
  }
  const q = p[p.length - 1];
  return d + ` L${r1(q[0])},${r1(q[1])}`;
}
function penSvg(o) {
  const sw = o.sw || 4;
  const pad = sw;
  const sx = o.ow ? (o.w - 2 * pad) / Math.max(1, o.ow) : 1;
  const sy = o.oh ? (o.h - 2 * pad) / Math.max(1, o.oh) : 1;
  return `<svg class="cv-svg" width="${o.w}" height="${o.h}" viewBox="${-pad} ${-pad} ${o.w} ${o.h}"><path d="${penPath(o.pts || [], sx, sy)}" style="fill:none;stroke:${ink(o.stroke)};stroke-width:${sw}px;stroke-linecap:round;stroke-linejoin:round"/></svg>`;
}

function textStyle(o) {
  return `font-size:${o.fs || 24}px;color:${o.color || 'var(--cv-ink)'};text-align:${o.align || 'left'};` +
    `${o.bold ? 'font-weight:700;' : ''}${o.italic ? 'font-style:italic;' : ''}${o.bg && o.bg !== 'none' ? `background:${o.bg};` : ''}`;
}

/** Builds (or rebuilds) the element for one item */
function drawItem(o, fileSrc, sanitize) {
  const e = document.createElement('div');
  e.className = `cv-obj cv-${o.t}`;
  e.dataset.id = o.id;
  fillItem(e, o, fileSrc, sanitize);
  return e;
}
function fillItem(e, o, fileSrc, sanitize) {
  if (o.t === 'text') e.innerHTML = `<div class="cv-tx" style="${textStyle(o)}">${sanitize(o.html || '') || '<br>'}</div>`;
  else if (o.t === 'img') e.innerHTML = `<img alt="" draggable="false" src="${esc(fileSrc(o.file) || '')}">`;
  else if (o.t === 'shape') e.innerHTML = shapeSvg(o);
  else if (o.t === 'line') e.innerHTML = lineSvg(o);
  else if (o.t === 'pen') e.innerHTML = penSvg(o);
  else if (o.t === 'emoji') e.innerHTML = `<span class="cv-emo" style="font-size:${o.h * 0.82}px;line-height:${o.h}px">${esc(o.ch || '🙂')}</span>`;
  else if (o.t === 'file') e.innerHTML = `<div class="cv-filecard"><svg class="ic"><use href="#i-file"/></svg><span>${esc(o.name || 'File')}</span></div>`;
  place(e, o);
}
function place(e, o) {
  if (o.t === 'line') {
    const g = lineGeom(o);
    Object.assign(e.style, { left: g.left + 'px', top: g.top + 'px', width: g.w + 'px', height: g.h + 'px', transform: '' });
    return;
  }
  e.style.left = o.x + 'px';
  e.style.top = o.y + 'px';
  e.style.width = o.w + 'px';
  e.style.height = o.t === 'text' ? '' : o.h + 'px';
  e.style.transform = o.r ? `rotate(${o.r}deg)` : '';
}

export { shapeSvg, lineSvg, penSvg, lineGeom, extent };
export function pageHeight(data) {
  let h = MIN_H;
  for (const o of (data && data.items) || []) { const b = extent(o); h = Math.max(h, b.y + b.h + 320); }
  return Math.ceil(h);
}

/** Read-only picture of a canvas (version history preview) */
export function renderStatic(host, data, { fileSrc, sanitize }) {
  host.innerHTML = '<div class="cv-static"><div class="cv-world"></div></div>';
  const world = host.querySelector('.cv-world');
  const items = (data && data.items) || [];
  for (const o of items) world.appendChild(drawItem(o, fileSrc, sanitize));
  const h = Math.max(600, ...items.map((o) => { const b = extent(o); return b.y + b.h + 40; }));
  const fit = () => {
    const s = Math.min(1, (host.clientWidth || 600) / W);
    world.style.transform = `scale(${s})`;
    world.style.height = h + 'px';
    host.firstElementChild.style.height = h * s + 'px';
  };
  fit();
  requestAnimationFrame(fit);
}

/** Text and pictures in reading order: used for the note title, search, previews and older app versions */
export function fallback(data, sanitize) {
  const items = [...((data && data.items) || [])].filter((o) => o.t === 'text' || o.t === 'img' || o.t === 'emoji' || o.t === 'file')
    .sort((a, b) => (Math.abs(a.y - b.y) < 20 ? a.x - b.x : a.y - b.y));
  const parts = [];
  const lines = [];
  for (const o of items) {
    if (o.t === 'img') parts.push(`<p><img data-file="${esc(o.file)}" alt=""></p>`);
    else if (o.t === 'file') parts.push(`<p><a data-file="${esc(o.file)}" class="file-chip" contenteditable="false">📎 ${esc(o.name || 'File')}</a></p>`);
    else if (o.t === 'emoji') { parts.push(`<p>${esc(o.ch)}</p>`); }
    else {
      const html = sanitize(o.html || '');
      if (!html.replace(/<[^>]+>/g, '').trim()) continue;
      parts.push(/^\s*<(p|h[1-3]|ul|ol|div|blockquote|pre)\b/i.test(html) ? html : `<p>${html}</p>`);
      const d = document.createElement('div');
      d.innerHTML = html.replace(/<\/(p|h[1-3]|li|div|blockquote)>|<br\s*\/?>/gi, '$&\n');
      lines.push(d.textContent.replace(/\n{3,}/g, '\n\n').trim());
    }
  }
  return { html: parts.join(''), text: lines.filter(Boolean).join('\n\n') };
}

/** A normal note's HTML → canvas items (headings start a new text box; pictures become their own items) */
export async function fromHtml(html, { imageSize }) {
  const box = document.createElement('div');
  box.innerHTML = html || '';
  const items = [];
  let cur = [];
  const flush = () => {
    const h = cur.map((n) => (n.nodeType === 1 ? n.outerHTML : esc(n.textContent))).join('').trim();
    if (h.replace(/<[^>]+>/g, '').trim()) items.push({ id: uid(), t: 'text', x: 70, y: 0, w: 860, h: 40, fs: 24, html: h });
    cur = [];
  };
  for (const n of [...box.childNodes]) {
    if (n.nodeType === 3 && !n.textContent.trim()) continue;
    const imgs = n.nodeType === 1 ? (n.matches('img[data-file]') ? [n] : [...n.querySelectorAll('img[data-file]')]) : [];
    if (imgs.length) {
      for (const im of imgs) im.remove();
      if (n.textContent.trim()) cur.push(n);
      flush();
      for (const im of imgs) {
        const sz = (await imageSize(im.dataset.file)) || { w: 4, h: 3 };
        const w = Math.min(620, Math.max(160, sz.w));
        items.push({ id: uid(), t: 'img', file: im.dataset.file, x: 70, y: 0, w, h: Math.round((w * sz.h) / sz.w) });
      }
      continue;
    }
    if (n.nodeType === 1 && /^H[1-3]$/.test(n.tagName)) flush();
    cur.push(n);
  }
  flush();
  return { v: 1, items };
}

/* ───────────── the editor ───────────── */

export class NoteCanvas {
  constructor({ host, bar, fileSrc, upload, sanitize, menu, onChange, cleanText, onOpen, onExport, toast }) {
    Object.assign(this, { host, bar, fileSrc, upload, sanitize, menu, onChange, cleanText, onOpen, onExport, toast });
    this.items = [];
    this.sel = null;
    this.editing = null;
    this.tool = null; // 'pen' or null
    this.pen = { stroke: '#1c7ed6', sw: 4 };
    this.undoStack = [];
    this.redoStack = [];
    this.clip = null;
    this.zoom = (() => { try { return Number(localStorage.getItem('sp-cvzoom')) || 1; } catch { return 1; } })();
    host.innerHTML = `<div class="cv-scroll"><div class="cv-stage"><div class="cv-world" tabindex="0" aria-label="Canvas">
      <div class="cv-guides"></div><div class="cv-sel" hidden></div></div></div></div>
      <input type="file" accept="image/*" multiple hidden class="cv-file">`;
    this.scroll = host.querySelector('.cv-scroll');
    this.stage = host.querySelector('.cv-stage');
    this.world = host.querySelector('.cv-world');
    this.guides = host.querySelector('.cv-guides');
    this.frame = host.querySelector('.cv-sel');
    this.fileInput = host.querySelector('.cv-file');
    this.fileInput.addEventListener('change', () => { const f = [...this.fileInput.files]; this.fileInput.value = ''; if (f.length) this.addFiles(f); });
    this.buildBar();
    this.world.addEventListener('pointerdown', (e) => this.down(e));
    this.world.addEventListener('dblclick', (e) => this.dbl(e));
    this.world.addEventListener('contextmenu', (e) => this.context(e));
    this.world.addEventListener('keydown', (e) => this.key(e));
    this.world.addEventListener('input', (e) => this.textInput(e));
    this.world.addEventListener('focusout', (e) => { if (this.editing && e.target.closest('.cv-tx') && !this.world.contains(e.relatedTarget) && !(e.relatedTarget && this.bar.contains(e.relatedTarget))) this.stopEdit(); });
    host.addEventListener('paste', (e) => this.paste(e));
    host.addEventListener('dragover', (e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); });
    this.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e);
    }, { passive: false });
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.scroll);
    this.closePop = (e) => { if (this.pop && !this.pop.contains(e.target) && !e.target.closest('[data-pop]')) this.hidePop(); };
    document.addEventListener('pointerdown', this.closePop, true);
    if (window.visualViewport) visualViewport.addEventListener('resize', () => {
      if (!this.editing) return;
      const e = this.elOf(this.editing);
      if (e) setTimeout(() => e.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 60);
    });
    this.touches = new Map();
    const lift = (e) => this.touches.delete(e.pointerId);
    this.world.addEventListener('pointerup', lift);
    this.world.addEventListener('pointercancel', lift);
  }

  destroy() { this.ro.disconnect(); document.removeEventListener('pointerdown', this.closePop, true); this.hidePop(); }

  /* ───── data ───── */
  load(data, keepSel = false) {
    const sel = keepSel ? this.sel : null;
    if (this.editing) this.stopEdit(true);
    this.items = JSON.parse(JSON.stringify((data && data.items) || []));
    if (!keepSel) { this.undoStack = []; this.redoStack = []; }
    this.sel = sel && this.items.some((o) => o.id === sel) ? sel : null;
    this.renderAll();
  }
  data() { return { v: 1, items: JSON.parse(JSON.stringify(this.items)) }; }
  get(id) { return this.items.find((o) => o.id === id); }
  elOf(id) { return this.world.querySelector(`.cv-obj[data-id="${id}"]`); }

  snapshot() { return JSON.stringify(this.items); }
  /** Call before a change: remembers the state for Undo */
  remember() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 120) this.undoStack.shift();
    this.redoStack = [];
  }
  commit() { this.layout(); this.renderSel(); this.syncBar(); this.onChange && this.onChange(); }
  undo() {
    if (this.editing) this.stopEdit();
    const s = this.undoStack.pop();
    if (s == null) return;
    this.redoStack.push(this.snapshot());
    this.items = JSON.parse(s);
    if (this.sel && !this.get(this.sel)) this.sel = null;
    this.renderAll();
    this.onChange && this.onChange();
  }
  redo() {
    const s = this.redoStack.pop();
    if (s == null) return;
    this.undoStack.push(this.snapshot());
    this.items = JSON.parse(s);
    if (this.sel && !this.get(this.sel)) this.sel = null;
    this.renderAll();
    this.onChange && this.onChange();
  }

  /* ───── drawing ───── */
  renderAll() {
    for (const e of [...this.world.querySelectorAll('.cv-obj')]) e.remove();
    const frag = document.createDocumentFragment();
    for (const o of this.items) frag.appendChild(drawItem(o, this.fileSrc, this.sanitize));
    this.world.insertBefore(frag, this.guides);
    this.measureTexts();
    this.layout();
    this.renderSel();
    this.syncBar();
  }
  redraw(o) {
    const e = this.elOf(o.id);
    if (!e) return;
    if (o.t === 'text' && this.editing === o.id) { place(e, o); e.firstElementChild.setAttribute('style', textStyle(o)); }
    else fillItem(e, o, this.fileSrc, this.sanitize);
    if (o.t === 'text') o.h = e.offsetHeight;
  }
  measureTexts() { for (const o of this.items) if (o.t === 'text') { const e = this.elOf(o.id); if (e) o.h = e.offsetHeight; } }
  pageHeight() {
    let h = MIN_H;
    for (const o of this.items) { const b = extent(o); h = Math.max(h, b.y + b.h + 320); }
    return Math.ceil(h);
  }
  layout() {
    const avail = Math.max(200, this.scroll.clientWidth - 24);
    this.base = Math.min(avail, 900) / W;
    this.s = this.base * this.zoom;
    this.H = this.pageHeight();
    this.world.style.height = this.H + 'px';
    this.world.style.transform = `scale(${this.s})`;
    this.world.style.setProperty('--k', String(1 / this.s));
    this.stage.style.width = W * this.s + 'px';
    this.stage.style.height = this.H * this.s + 'px';
  }
  setZoom(z, at) {
    const old = this.s;
    this.zoom = clamp(z, 0.5, 5);
    try { localStorage.setItem('sp-cvzoom', String(this.zoom)); } catch {}
    const r = this.scroll.getBoundingClientRect();
    const ax = at ? at.clientX - r.left : this.scroll.clientWidth / 2;
    const ay = at ? at.clientY - r.top : this.scroll.clientHeight / 2;
    const wx = (this.scroll.scrollLeft + ax) / old;
    const wy = (this.scroll.scrollTop + ay) / old;
    this.layout();
    this.scroll.scrollLeft = wx * this.s - ax;
    this.scroll.scrollTop = wy * this.s - ay;
    this.onZoom && this.onZoom(this.zoom);
  }
  zoomStep(dir) {
    const Z = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];
    let i = Z.findIndex((v) => v >= this.zoom - 0.001);
    if (i < 0) i = Z.length - 1;
    if (dir > 0 && Z[i] <= this.zoom + 0.001) i++;
    if (dir < 0) i--;
    if (dir === 0) { this.setZoom(1); return; }
    this.setZoom(Z[clamp(i, 0, Z.length - 1)]);
  }
  /** client point → page units */
  pt(e) {
    const r = this.world.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.s, y: (e.clientY - r.top) / this.s };
  }
  /** middle of what is visible now (where new things appear) */
  centre() {
    const r = this.scroll.getBoundingClientRect();
    const p = this.pt({ clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 320) });
    return { x: clamp(p.x, 120, W - 120), y: Math.max(80, p.y) };
  }

  renderSel() {
    const o = this.sel && this.get(this.sel);
    const f = this.frame;
    if (!o) { f.hidden = true; this.world.classList.remove('has-sel'); return; }
    this.world.classList.add('has-sel');
    f.hidden = false;
    f.className = `cv-sel cv-sel-${o.t}${this.editing ? ' editing' : ''}`;
    const sig = o.t === 'line' ? 'line' : o.t === 'text' ? 'text' : 'box';
    if (f.dataset.sig !== sig) {
      f.dataset.sig = sig;
      const hs = sig === 'line' ? [] : sig === 'text' ? ['w', 'e'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      f.innerHTML = sig === 'line'
        ? '<i class="cv-h cv-h-pt" data-h="p1"></i><i class="cv-h cv-h-pt" data-h="p2"></i>'
        : hs.map((h) => `<i class="cv-h cv-h-${h}" data-h="${h}"></i>`).join('') + '<i class="cv-h cv-h-rot" data-h="rot"></i>';
    }
    if (o.t === 'line') {
      Object.assign(f.style, { left: '0px', top: '0px', width: '0px', height: '0px', transform: '' });
      Object.assign(f.children[0].style, { left: o.x1 + 'px', top: o.y1 + 'px' });
      Object.assign(f.children[1].style, { left: o.x2 + 'px', top: o.y2 + 'px' });
      return;
    }
    Object.assign(f.style, { left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: (o.h || 0) + 'px', transform: o.r ? `rotate(${o.r}deg)` : '' });
  }

  /* ───── adding things ───── */
  add(o, at, exact) {
    this.remember();
    const c = at || this.centre();
    if (exact && o.t !== 'line') { o.w = Math.min(o.w, W - Math.max(0, c.x)); c.x += o.w / 2; c.y += (o.h || 40) / 2; }
    o.id = uid();
    if (o.t === 'line') {
      const dx = (o.x2 || 0) - (o.x1 || 0);
      const dy = (o.y2 || 0) - (o.y1 || 0);
      o.x1 = c.x - dx / 2; o.y1 = c.y - dy / 2; o.x2 = c.x + dx / 2; o.y2 = c.y + dy / 2;
    } else {
      o.x = clamp(c.x - o.w / 2, 0, W - o.w);
      o.y = Math.max(0, c.y - (o.h || 40) / 2);
    }
    // don't land exactly on top of something just added
    for (let k = 0; k < 12 && !exact && this.items.some((q) => q.t === o.t && Math.abs(bbox(q).x - bbox(o).x) < 4 && Math.abs(bbox(q).y - bbox(o).y) < 4); k++) this.move(o, 24, 24);
    this.items.push(o);
    this.world.insertBefore(drawItem(o, this.fileSrc, this.sanitize), this.guides);
    if (o.t === 'text') o.h = this.elOf(o.id).offsetHeight;
    this.select(o.id);
    this.commit();
    return o;
  }
  addText(at, exact) {
    const o = this.add({ t: 'text', w: 360, h: 40, fs: 26, html: '' }, at, exact);
    this.startEdit(o.id);
  }
  addShape(kind) {
    const sq = kind === 'ellipse' || kind === 'star' || kind === 'hex' || kind === 'heart';
    this.add({ t: 'shape', kind, w: sq ? 200 : 240, h: sq ? 200 : kind === 'bubble' ? 190 : 160, fill: kind === 'bubble' ? '#ffffff' : '#ffe8a3', stroke: '', sw: 3 });
  }
  addLine(kind) { this.add({ t: 'line', kind, x1: 0, y1: 0, x2: 260, y2: 0, stroke: '', sw: 5 }); }
  addEmoji(ch) {
    if (this.editing) { document.execCommand('insertText', false, ch); return; }
    this.add({ t: 'emoji', ch, w: 110, h: 110 });
  }
  async addFiles(list, at) {
    if (!list.length) return;
    const made = await this.upload(list);
    let c = at || this.centre();
    for (const m of made) {
      if (m.image) {
        const w = Math.min(560, Math.max(120, m.w || 480));
        const h = Math.round((w * (m.h || 3)) / (m.w || 4));
        this.add({ t: 'img', file: m.id, w, h }, c);
      } else this.add({ t: 'file', file: m.id, name: m.name, w: 320, h: 64 }, c);
      c = { x: c.x + 30, y: c.y + 30 };
    }
  }
  move(o, dx, dy) {
    if (o.t === 'line') { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; } else { o.x += dx; o.y += dy; }
  }

  select(id) {
    if (this.editing && this.editing !== id) this.stopEdit();
    this.sel = id;
    for (const e of this.world.querySelectorAll('.cv-obj.on')) e.classList.remove('on');
    if (id) { const e = this.elOf(id); if (e) e.classList.add('on'); }
    this.renderSel();
    this.syncBar();
  }

  /* ───── text editing ───── */
  startEdit(id, at) {
    const o = this.get(id);
    if (!o || o.t !== 'text') return;
    this.editing = id;
    this.editBefore = this.snapshot();
    const t = this.elOf(id).firstElementChild;
    t.contentEditable = 'true';
    t.focus({ preventScroll: true });
    const sel = getSelection();
    let r = at && document.caretRangeFromPoint ? document.caretRangeFromPoint(at.clientX, at.clientY) : null;
    if (!r || !t.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(t); r.collapse(false); }
    sel.removeAllRanges();
    sel.addRange(r);
    this.renderSel();
    this.syncBar();
  }
  stopEdit(silent) {
    const id = this.editing;
    if (!id) return;
    this.editing = null;
    const o = this.get(id);
    const e = this.elOf(id);
    if (!o || !e) return;
    const t = e.firstElementChild;
    t.contentEditable = 'false';
    const html = this.sanitize(t.innerHTML).replace(/^(<br>)+$/, '');
    if (!html.replace(/<[^>]+>/g, '').trim() && !/<img/.test(html)) {
      const fresh = this.editBefore && !JSON.parse(this.editBefore).find((q) => q.id === id && (q.html || '').replace(/<[^>]+>/g, '').trim());
      this.items = this.items.filter((q) => q.id !== id);
      e.remove();
      if (this.sel === id) this.sel = null;
      if (fresh && this.undoStack.length) { this.undoStack.pop(); this.editBefore = null; }
    } else {
      o.html = html;
      o.h = e.offsetHeight;
    }
    if (!silent) {
      if (this.editBefore && this.editBefore !== this.snapshot()) { this.undoStack.push(this.editBefore); this.redoStack = []; }
      this.commit();
    }
    this.editBefore = null;
    this.renderSel();
    this.syncBar();
  }
  textInput(e) {
    const t = e.target.closest && e.target.closest('.cv-tx');
    if (!t || !this.editing) return;
    const o = this.get(this.editing);
    o.html = t.innerHTML;
    o.h = t.parentElement.offsetHeight;
    this.renderSel();
    this.layout();
    this.onChange && this.onChange();
  }

  /* ───── pointer ───── */
  down(e) {
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) { this.startPinch(); return; }
      if (this.touches.size > 2) return;
    }
    if (e.button === 2) return;
    const h = e.target.closest('.cv-h');
    const objEl = e.target.closest('.cv-obj');
    if (objEl && this.editing === objEl.dataset.id && e.target.closest('.cv-tx')) return; // caret / text selection
    this.world.focus({ preventScroll: true });
    if (this.tool === 'pen' && !h) { this.drawPen(e); return; }
    if (this.tool === 'text' && !h) {
      e.preventDefault();
      const p = this.pt(e);
      this.setTool(null);
      const hit = objEl && this.get(objEl.dataset.id);
      if (hit && hit.t === 'text') { this.select(hit.id); this.startEdit(hit.id, e); return; }
      this.addText({ x: p.x - 8, y: p.y - 20 }, true);
      return;
    }
    if (h) { this.dragHandle(e, h.dataset.h); return; }
    if (objEl) {
      const id = objEl.dataset.id;
      e.preventDefault();
      const was = this.sel === id;
      this.select(id);
      this.dragMove(e, id, was);
      return;
    }
    if (this.editing) this.stopEdit();
    if (this.sel) this.select(null);
    if (e.pointerType === 'touch') this.panScroll(e);
  }
  /** one finger on empty paper scrolls the page */
  panScroll(e) {
    let last = { x: e.clientX, y: e.clientY };
    this.track(e, (ev) => {
      this.scroll.scrollLeft -= ev.clientX - last.x;
      this.scroll.scrollTop -= ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
    }, () => {});
  }
  dbl(e) {
    const objEl = e.target.closest('.cv-obj');
    if (objEl) {
      const o = this.get(objEl.dataset.id);
      if (o && o.t === 'text' && this.editing !== o.id) this.startEdit(o.id, e);
      else if (o && (o.t === 'img' || o.t === 'file') && this.onOpen) this.onOpen(o.file);
      return;
    }
    if (!this.tool && !e.target.closest('.cv-sel')) this.addText(this.pt(e));
  }
  context(e) {
    const objEl = e.target.closest('.cv-obj');
    if (!objEl || (this.editing && e.target.closest('.cv-tx'))) return;
    e.preventDefault();
    this.select(objEl.dataset.id);
    this.objMenu({ x: e.clientX, y: e.clientY });
  }
  objMenu(at) {
    const id = this.sel;
    if (!id || !this.menu) return;
    const o = this.get(id);
    this.menu(at, [
      ...((o.t === 'img' || o.t === 'file') && this.onOpen ? [{ icon: 'eye', label: 'Open', run: () => this.onOpen(o.file) }] : []),
      { icon: 'copy', label: 'Duplicate', run: () => this.duplicate() },
      { icon: 'box', label: 'Bring to front', run: () => this.order(1) },
      { icon: 'box', label: 'Send to back', run: () => this.order(-1) },
      { icon: 'trash', label: 'Delete', danger: true, run: () => this.remove() }
    ]);
  }

  track(e, onMove, onUp) {
    const target = this.world; // stays in place while items are redrawn under the finger
    try { target.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => { if (ev.pointerId === e.pointerId && !this.pinching) onMove(ev); };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      this.touches.delete(ev.pointerId);
      this.guides.innerHTML = '';
      onUp(ev);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  dragMove(e, id, wasSelected) {
    const o = this.get(id);
    const el = this.elOf(id);
    const p0 = this.pt(e);
    const start = JSON.stringify(o);
    const b0 = bbox(o);
    let moved = false;
    let hold = e.pointerType !== 'mouse' ? setTimeout(() => { if (!moved) { hold = 'menu'; this.objMenu({ x: e.clientX, y: e.clientY }); } }, 550) : null;
    this.track(e, (ev) => {
      const p = this.pt(ev);
      let dx = p.x - p0.x;
      let dy = p.y - p0.y;
      if (!moved && Math.hypot(dx, dy) * this.s < 4) return;
      if (!moved) { moved = true; clearTimeout(hold); this.remember(); }
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const snap = this.snap({ x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h }, id);
      dx += snap.dx;
      dy += snap.dy;
      Object.assign(o, JSON.parse(start));
      this.move(o, dx, dy);
      if (o.t === 'line') fillItem(el, o, this.fileSrc, this.sanitize); else place(el, o);
      this.renderSel();
      if (bbox(o).y + bbox(o).h + 320 > this.H) this.layout();
    }, (ev) => {
      clearTimeout(hold);
      if (moved) { this.commit(); return; }
      if (hold === 'menu') return;
      if (wasSelected && o.t === 'text' && this.editing !== id) this.startEdit(id, ev);
      else if (wasSelected && o.t === 'file' && this.onOpen) this.onOpen(o.file);
    });
  }

  /** Snap the moving box to the page centre and other items' edges/centres */
  snap(b, skip) {
    const tol = 7 / this.s;
    const xs = [W / 2];
    const ys = [];
    for (const q of this.items) {
      if (q.id === skip) continue;
      const e = extent(q);
      xs.push(e.x, e.x + e.w / 2, e.x + e.w);
      ys.push(e.y, e.y + e.h / 2, e.y + e.h);
    }
    let best = { d: tol, dx: 0, gx: null };
    for (const v of [b.x, b.x + b.w / 2, b.x + b.w]) for (const t of xs) { const d = Math.abs(t - v); if (d < best.d) best = { d, dx: t - v, gx: t }; }
    let bestY = { d: tol, dy: 0, gy: null };
    for (const v of [b.y, b.y + b.h / 2, b.y + b.h]) for (const t of ys) { const d = Math.abs(t - v); if (d < bestY.d) bestY = { d, dy: t - v, gy: t }; }
    this.guides.innerHTML = (best.gx != null ? `<i class="cv-gx" style="left:${best.gx}px"></i>` : '') + (bestY.gy != null ? `<i class="cv-gy" style="top:${bestY.gy}px"></i>` : '');
    return { dx: best.dx, dy: bestY.dy };
  }

  dragHandle(e, h) {
    e.preventDefault();
    e.stopPropagation();
    const o = this.get(this.sel);
    if (!o) return;
    const el = this.elOf(o.id);
    const s0 = JSON.parse(JSON.stringify(o));
    const p0 = this.pt(e);
    let moved = false;
    this.track(e, (ev) => {
      const p = this.pt(ev);
      if (!moved) { moved = true; this.remember(); }
      Object.assign(o, JSON.parse(JSON.stringify(s0)));
      if (h === 'p1' || h === 'p2') {
        let x = p.x;
        let y = p.y;
        const ox = h === 'p1' ? o.x2 : o.x1;
        const oy = h === 'p1' ? o.y2 : o.y1;
        if (ev.shiftKey || this.nearAngle(x - ox, y - oy)) {
          const a = Math.round(Math.atan2(y - oy, x - ox) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(x - ox, y - oy);
          x = ox + Math.cos(a) * len;
          y = oy + Math.sin(a) * len;
        }
        if (h === 'p1') { o.x1 = x; o.y1 = y; } else { o.x2 = x; o.y2 = y; }
        fillItem(el, o, this.fileSrc, this.sanitize);
      } else if (h === 'rot') {
        const cx = o.x + o.w / 2;
        const cy = o.y + o.h / 2;
        let a = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
        const step = ev.shiftKey ? 15 : 0;
        if (step) a = Math.round(a / step) * step;
        else for (const t of [0, 90, 180, 270, 360, -90]) if (Math.abs(a - t) < 4) a = t;
        o.r = Math.round((((a % 360) + 360) % 360) * 10) / 10;
        if (o.r === 360) o.r = 0;
        place(el, o);
      } else {
        const sx = h.includes('e') ? 1 : h.includes('w') ? -1 : 0;
        const sy = h.includes('s') ? 1 : h.includes('n') ? -1 : 0;
        const d = rot(p.x - p0.x, p.y - p0.y, -(o.r || 0));
        let nw = Math.max(o.t === 'text' ? 60 : 16, s0.w + sx * d.x);
        let nh = Math.max(16, s0.h + sy * d.y);
        const lock = (o.t === 'img' || o.t === 'emoji') ? !ev.shiftKey : ev.shiftKey;
        if (lock && sx && sy) {
          const k = Math.abs(d.x) / s0.w > Math.abs(d.y) / s0.h ? nw / s0.w : nh / s0.h;
          nw = Math.max(16, s0.w * k);
          nh = Math.max(16, s0.h * k);
        } else if (lock && (o.t === 'img' || o.t === 'emoji')) {
          if (sx) nh = (s0.h * nw) / s0.w; else nw = (s0.w * nh) / s0.h;
        }
        if (o.t === 'text') nh = s0.h;
        const c0 = { x: s0.x + s0.w / 2, y: s0.y + s0.h / 2 };
        const a = rot((-sx * s0.w) / 2, (-sy * s0.h) / 2, o.r || 0);
        const A = { x: c0.x + a.x, y: c0.y + a.y };
        const b = rot((-sx * nw) / 2, (-sy * nh) / 2, o.r || 0);
        const c1 = { x: A.x - b.x, y: A.y - b.y };
        o.w = nw;
        o.h = nh;
        o.x = c1.x - nw / 2;
        o.y = c1.y - nh / 2;
        if (o.t === 'text') { place(el, o); o.h = el.offsetHeight; } else fillItem(el, o, this.fileSrc, this.sanitize);
      }
      this.renderSel();
    }, () => { if (moved) this.commit(); });
  }
  nearAngle(dx, dy) {
    const a = (Math.atan2(dy, dx) * 180) / Math.PI;
    return [-180, -90, 0, 90, 180].some((t) => Math.abs(a - t) < 3);
  }

  drawPen(e) {
    e.preventDefault();
    this.pinchSeen = false;
    if (this.sel) this.select(null);
    const pts = [];
    const p = this.pt(e);
    pts.push([p.x, p.y]);
    const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tmp.setAttribute('class', 'cv-ink-live');
    tmp.setAttribute('width', W);
    tmp.setAttribute('height', this.H);
    tmp.innerHTML = `<path style="fill:none;stroke:${ink(this.pen.stroke)};stroke-width:${this.pen.sw}px;stroke-linecap:round;stroke-linejoin:round"/>`;
    this.world.appendChild(tmp);
    const path = tmp.firstElementChild;
    this.track(e, (ev) => {
      const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      for (const c of evs.length ? evs : [ev]) {
        const q = this.pt(c);
        const last = pts[pts.length - 1];
        if (Math.hypot(q.x - last[0], q.y - last[1]) > 1.2) pts.push([q.x, q.y]);
      }
      path.setAttribute('d', penPath(pts));
    }, () => {
      tmp.remove();
      if (this.pinchSeen) return;
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const ow = Math.max(1, Math.max(...xs) - minX);
      const oh = Math.max(1, Math.max(...ys) - minY);
      const sw = this.pen.sw;
      const simple = pts.filter((q, k) => k % (pts.length > 400 ? 2 : 1) === 0 || k === pts.length - 1).map(([x, y]) => [r1(x - minX), r1(y - minY)]);
      this.remember();
      const o = { id: uid(), t: 'pen', x: minX - sw, y: minY - sw, w: ow + 2 * sw, h: oh + 2 * sw, ow, oh, pts: simple, stroke: this.pen.stroke, sw };
      this.items.push(o);
      this.world.insertBefore(drawItem(o, this.fileSrc, this.sanitize), this.guides);
      this.commit();
    });
  }

  /** two fingers: pinch to zoom, move to scroll */
  startPinch() {
    const [a, b] = [...this.touches.values()];
    const mid = (p, q) => ({ clientX: (p.x + q.x) / 2, clientY: (p.y + q.y) / 2 });
    this.pinchSeen = true;
    this.pinching = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: this.zoom, last: mid(a, b) };
    const move = (ev) => {
      if (!this.touches.has(ev.pointerId) || !this.pinching) return;
      this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const [p, q] = [...this.touches.values()];
      if (!p || !q) return;
      const m = mid(p, q);
      this.setZoom(this.pinching.z * (Math.hypot(p.x - q.x, p.y - q.y) / this.pinching.d), m);
      this.scroll.scrollLeft -= m.clientX - this.pinching.last.clientX;
      this.scroll.scrollTop -= m.clientY - this.pinching.last.clientY;
      this.pinching.last = m;
    };
    const up = (ev) => {
      this.touches.delete(ev.pointerId);
      if (this.touches.size < 2) {
        this.pinching = null;
        this.world.removeEventListener('pointermove', move);
        this.world.removeEventListener('pointerup', up);
        this.world.removeEventListener('pointercancel', up);
      }
    };
    this.world.addEventListener('pointermove', move);
    this.world.addEventListener('pointerup', up);
    this.world.addEventListener('pointercancel', up);
  }

  /* ───── keyboard, clipboard ───── */
  key(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (this.editing) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.stopEdit(); this.world.focus({ preventScroll: true }); }
      return;
    }
    const k = e.key.toLowerCase();
    let done = true;
    if (mod && k === 'z') { if (e.shiftKey) this.redo(); else this.undo(); }
    else if (mod && k === 'y') this.redo();
    else if (mod && k === 'd' && this.sel) this.duplicate();
    else if (mod && k === 'c' && this.sel) { this.clip = JSON.stringify(this.get(this.sel)); try { navigator.clipboard.writeText(this.plainOf(this.get(this.sel))); } catch {} }
    else if (mod && k === 'x' && this.sel) { this.clip = JSON.stringify(this.get(this.sel)); this.remove(); }
    else if (mod && k === 'a') { /* nothing to select-all yet */ }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) this.remove();
    else if (e.key === 'Escape') { if (this.tool) this.setTool(null); else this.select(null); }
    else if (e.key === 'Enter' && this.sel && this.get(this.sel).t === 'text') this.startEdit(this.sel);
    else if (e.key.startsWith('Arrow') && this.sel) {
      const o = this.get(this.sel);
      const n = e.shiftKey ? 10 : 1;
      if (!this.nudging) { this.remember(); this.nudging = true; }
      this.move(o, k === 'arrowleft' ? -n : k === 'arrowright' ? n : 0, k === 'arrowup' ? -n : k === 'arrowdown' ? n : 0);
      this.redraw(o);
      this.renderSel();
      clearTimeout(this.nudgeT);
      this.nudgeT = setTimeout(() => { this.nudging = false; this.commit(); }, 400);
    } else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  }
  plainOf(o) {
    if (!o) return '';
    if (o.t === 'text') { const d = document.createElement('div'); d.innerHTML = o.html || ''; return d.textContent; }
    return o.t === 'emoji' ? o.ch : '';
  }
  paste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    e.stopPropagation();
    const fl = [...(cd.files || [])];
    const text = cd.getData('text/plain');
    if (this.editing) {
      e.preventDefault();
      if (text) document.execCommand('insertText', false, this.cleanText ? this.cleanText(text, cd.getData('text/html')) : text);
      return;
    }
    e.preventDefault();
    if (fl.length) { this.addFiles(fl); return; }
    if (this.clip && (!text || text === this.plainOf(JSON.parse(this.clip)))) {
      const o = JSON.parse(this.clip);
      this.add(Object.assign(o, { r: o.r || 0 }), (() => { const b = bbox(o); return { x: b.x + b.w / 2 + 30, y: b.y + b.h / 2 + 30 }; })());
      this.clip = JSON.stringify(this.get(this.sel));
      return;
    }
    if (text && text.trim()) {
      const clean = this.cleanText ? this.cleanText(text, cd.getData('text/html')) : text;
      const html = clean.split('\n').map((l) => `<div>${esc(l) || '<br>'}</div>`).join('');
      this.add({ t: 'text', w: Math.min(860, Math.max(280, Math.min(clean.length, 60) * 13)), h: 40, fs: 24, html });
    }
  }

  /* ───── actions on the selected item ───── */
  remove() {
    const id = this.sel;
    if (!id) return;
    if (this.editing) this.stopEdit(true);
    this.remember();
    this.items = this.items.filter((o) => o.id !== id);
    const e = this.elOf(id);
    if (e) e.remove();
    this.sel = null;
    this.commit();
  }
  duplicate() {
    const o = this.get(this.sel);
    if (!o) return;
    if (this.editing) this.stopEdit();
    const c = JSON.parse(JSON.stringify(o));
    const b = bbox(o);
    this.add(c, { x: b.x + b.w / 2 + 30, y: b.y + b.h / 2 + 30 });
  }
  order(dir) {
    const i = this.items.findIndex((o) => o.id === this.sel);
    if (i < 0) return;
    this.remember();
    const [o] = this.items.splice(i, 1);
    if (dir > 0) this.items.push(o); else this.items.unshift(o);
    const id = this.sel;
    this.renderAll();
    this.select(id);
    this.onChange && this.onChange();
  }
  set(props) {
    const o = this.get(this.sel);
    if (!o) {
      if (this.tool === 'pen') { Object.assign(this.pen, props); this.syncBar(); }
      return;
    }
    this.remember();
    Object.assign(o, props);
    if (o.t === 'text' && this.editing === o.id) {
      const t = this.elOf(o.id).firstElementChild;
      t.setAttribute('style', textStyle(o));
      o.h = t.parentElement.offsetHeight;
    } else this.redraw(o);
    if (o.t === 'pen' || o.t === 'line') { if (props.stroke !== undefined) this.pen.stroke = props.stroke; if (props.sw !== undefined) this.pen.sw = props.sw; }
    this.commit();
  }
  setTool(t) {
    this.tool = t;
    if (t) { if (this.editing) this.stopEdit(); this.select(null); }
    this.world.classList.toggle('pen-mode', t === 'pen');
    this.syncBar();
  }

  /* ───── toolbar ───── */
  buildBar() {
    const b = (cv, icon, title, extra = '') => `<button class="icon-btn sm" data-cv="${cv}" title="${title}" aria-label="${title}" ${extra}><svg class="ic"><use href="#i-${icon}"/></svg></button>`;
    this.bar.innerHTML =
      `<div class="cv-tools">${b('text', 'text', 'Text box')}${b('shapes', 'square', 'Shapes', 'data-pop')}${b('lines', 'arrow', 'Lines and arrows', 'data-pop')}` +
      `<button class="icon-btn sm cv-emoji-btn" data-cv="emoji" data-pop title="Emoji" aria-label="Emoji">🙂</button>${b('pic', 'image', 'Picture')}${b('pen', 'pen', 'Draw')}` +
      '<span class="fmt-sep"></span>' + b('undo', 'undo', 'Undo (Ctrl+Z)') + b('redo', 'redo', 'Redo (Ctrl+Y)') + b('export', 'download', 'Save as PNG or PDF') + '</div>' +
      '<div class="cv-props"></div>';
    this.props = this.bar.querySelector('.cv-props');
    this.bar.addEventListener('mousedown', (e) => { if (e.target.closest('button') && this.editing) e.preventDefault(); });
    this.bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cv]');
      if (!btn) return;
      const c = btn.dataset.cv;
      const o = this.get(this.sel);
      switch (c) {
        case 'text': this.setTool(this.tool === 'text' ? null : 'text'); break;
        case 'export': this.setTool(null); if (this.editing) this.stopEdit(); this.onExport && this.onExport(); break;
        case 'open': if (o && this.onOpen) this.onOpen(o.file); break;
        case 'case': this.textCase(); break;
        case 'shapes': this.showPop(btn, this.gridPop(SHAPES.map(([k, l]) => [k, l, shapeSvg({ kind: k, w: 30, h: 26, fill: 'none', stroke: '', sw: 2 })]), (k) => { this.setTool(null); this.addShape(k); })); break;
        case 'lines': this.showPop(btn, this.gridPop(LINES.map(([k, l]) => [k, l, `<svg width="30" height="26" viewBox="0 0 30 26">${lineSvg({ t: 'line', kind: k, x1: 4, y1: 22, x2: 26, y2: 4, sw: 2 }).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg>`]), (k) => { this.setTool(null); this.addLine(k); })); break;
        case 'emoji': this.showPop(btn, this.emojiPop()); break;
        case 'pic': this.setTool(null); this.fileInput.click(); break;
        case 'pen': this.setTool(this.tool === 'pen' ? null : 'pen'); break;
        case 'undo': this.undo(); break;
        case 'redo': this.redo(); break;
        case 'bold':
          if (this.editing && !getSelection().isCollapsed) document.execCommand('bold');
          else this.set({ bold: !o.bold });
          break;
        case 'italic':
          if (this.editing && !getSelection().isCollapsed) document.execCommand('italic');
          else this.set({ italic: !o.italic });
          break;
        case 'smaller': if (o) this.set(o.t === 'emoji' ? this.scaled(o, 0.85) : { fs: Math.max(10, Math.round((o.fs || 24) / 1.15)) }); break;
        case 'bigger': if (o) this.set(o.t === 'emoji' ? this.scaled(o, 1.18) : { fs: Math.min(200, Math.round((o.fs || 24) * 1.15)) }); break;
        case 'align': if (o) this.set({ align: { left: 'center', center: 'right', right: 'left' }[o.align || 'left'] }); break;
        case 'color': this.showPop(btn, this.colorPop(INKS, (v) => (this.editing && !getSelection().isCollapsed ? document.execCommand('foreColor', false, v || '#16181d') : this.set(o && o.t === 'text' ? { color: v } : { stroke: v })))); break;
        case 'fill': this.showPop(btn, this.colorPop(FILLS, (v) => this.set(o && o.t === 'text' ? { bg: v } : { fill: v }))); break;
        case 'outline': this.showPop(btn, this.colorPop(['none', ...INKS], (v) => this.set({ stroke: v }))); break;
        case 'width': this.showPop(btn, this.widthPop()); break;
        case 'kind': if (o && o.t === 'line') { const ks = LINES.map((l) => l[0]); this.set({ kind: ks[(ks.indexOf(o.kind) + 1) % ks.length] }); } break;
        case 'front': this.order(1); break;
        case 'back': this.order(-1); break;
        case 'dup': this.duplicate(); break;
        case 'del': this.remove(); break;
      }
    });
  }
  textCase() {
    const o = this.get(this.sel);
    if (!o || o.t !== 'text') return;
    const t = this.elOf(o.id).firstElementChild;
    if (!this.editing) {
      const r = document.createRange();
      r.selectNodeContents(t);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
    this.remember();
    const mode = cycleCase(t);
    if (!mode) { this.undoStack.pop(); return; }
    o.html = this.editing ? t.innerHTML : this.sanitize(t.innerHTML);
    if (!this.editing) getSelection().removeAllRanges();
    this.commit();
    if (this.toast) this.toast(CASE_LABEL[mode]);
  }
  scaled(o, k) {
    const nw = clamp(o.w * k, 24, 900);
    return { x: o.x + (o.w - nw) / 2, y: o.y + (o.h - nw) / 2, w: nw, h: nw };
  }
  syncBar() {
    const o = this.get(this.sel);
    const pen = this.tool === 'pen';
    for (const b of this.bar.querySelectorAll('[data-cv="pen"]')) b.setAttribute('aria-pressed', String(pen));
    for (const b of this.bar.querySelectorAll('[data-cv="text"]')) b.setAttribute('aria-pressed', String(this.tool === 'text'));
    this.world.classList.toggle('text-mode', this.tool === 'text');
    const und = this.bar.querySelector('[data-cv="undo"]');
    const red = this.bar.querySelector('[data-cv="redo"]');
    if (und) und.disabled = !this.undoStack.length && !this.editing;
    if (red) red.disabled = !this.redoStack.length;
    const btn = (cv, inner, title, pressed) => `<button class="icon-btn sm" data-cv="${cv}" title="${title}" aria-label="${title}"${pressed != null ? ` aria-pressed="${pressed}"` : ''}>${inner}</button>`;
    const ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
    const sw = (c, cls = '') => `<span class="cv-swatch ${cls}" style="--c:${c === 'none' ? 'transparent' : c || 'var(--cv-ink)'}"></span>`;
    let h = '';
    if (pen && !o) h = btn('color', sw(this.pen.stroke), 'Pen colour') + btn('width', '<b class="cv-w">' + this.pen.sw + '</b>', 'Pen size');
    else if (o) {
      if (o.t === 'text') {
        h = btn('smaller', '<b>A−</b>', 'Smaller text') + btn('bigger', '<b>A+</b>', 'Bigger text') + btn('bold', ic('bold'), 'Bold', !!o.bold) + btn('italic', ic('italic'), 'Italic', !!o.italic) +
          btn('case', '<b>Aa</b>', 'Sentence case / UPPERCASE / lowercase') + btn('align', ic(`al-${o.align === 'center' ? 'center' : o.align === 'right' ? 'right' : 'left'}`), 'Alignment') + btn('color', sw(o.color), 'Text colour') + btn('fill', sw(o.bg || 'none', 'fill'), 'Background');
      } else if (o.t === 'shape') h = btn('fill', sw(o.fill || '#ffe8a3', 'fill'), 'Fill') + btn('outline', sw(o.stroke, 'ring'), 'Outline') + btn('width', `<b class="cv-w">${o.sw != null ? o.sw : 3}</b>`, 'Outline width');
      else if (o.t === 'line') h = btn('color', sw(o.stroke), 'Colour') + btn('width', `<b class="cv-w">${o.sw != null ? o.sw : 5}</b>`, 'Thickness') + btn('kind', ic(o.kind === 'line' ? 'line' : 'arrow'), 'Line / arrow type');
      else if (o.t === 'pen') h = btn('color', sw(o.stroke), 'Colour') + btn('width', `<b class="cv-w">${o.sw}</b>`, 'Thickness');
      else if (o.t === 'emoji') h = btn('smaller', '<b>A−</b>', 'Smaller') + btn('bigger', '<b>A+</b>', 'Bigger');
      else if (o.t === 'img' || o.t === 'file') h = btn('open', ic('eye'), 'Open');
      h += (h ? '<span class="fmt-sep"></span>' : '') + btn('front', '<b class="cv-lyr">⬆</b>', 'Bring to front') + btn('back', '<b class="cv-lyr">⬇</b>', 'Send to back') + btn('dup', ic('copy'), 'Duplicate (Ctrl+D)') + btn('del', ic('trash'), 'Delete');
    }
    this.props.innerHTML = h ? '<span class="fmt-sep"></span>' + h : '';
  }

  /* ───── pop-ups ───── */
  showPop(anchor, content) {
    this.hidePop();
    const p = document.createElement('div');
    p.className = 'cv-pop';
    p.appendChild(content);
    document.body.appendChild(p);
    const r = anchor.getBoundingClientRect();
    const pw = p.offsetWidth;
    p.style.left = clamp(r.left, 8, innerWidth - pw - 8) + 'px';
    p.style.top = r.bottom + 6 + 'px';
    this.pop = p;
  }
  hidePop() { if (this.pop) { this.pop.remove(); this.pop = null; } }
  gridPop(list, pick) {
    const d = document.createElement('div');
    d.className = 'cv-grid';
    d.innerHTML = list.map(([k, l, svg]) => `<button data-k="${k}" title="${l}" aria-label="${l}">${svg}</button>`).join('');
    d.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) { this.hidePop(); pick(b.dataset.k); } });
    return d;
  }
  colorPop(list, pick) {
    const d = document.createElement('div');
    d.className = 'cv-colors';
    d.innerHTML = list.map((c) => `<button data-c="${c}" title="${c === '' ? 'Automatic' : c === 'none' ? 'None' : c}" class="${c === 'none' ? 'none' : ''}" style="--c:${c === 'none' ? 'transparent' : c || 'var(--cv-ink)'}"></button>`).join('') +
      '<label class="cv-custom" title="Any colour"><input type="color" value="#1c7ed6"><span>+</span></label>';
    d.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) { this.hidePop(); pick(b.dataset.c); } });
    d.querySelector('input').addEventListener('change', (e) => { this.hidePop(); pick(e.target.value); });
    return d;
  }
  widthPop() {
    const d = document.createElement('div');
    d.className = 'cv-widths';
    d.innerHTML = [1, 2, 3, 5, 8, 12, 18].map((w) => `<button data-w="${w}" title="${w}"><i style="height:${Math.max(1, w * 0.8)}px"></i></button>`).join('');
    d.addEventListener('click', (e) => { const b = e.target.closest('[data-w]'); if (b) { this.hidePop(); this.set({ sw: Number(b.dataset.w) }); } });
    return d;
  }
  emojiPop() {
    const d = document.createElement('div');
    d.className = 'cv-emojis';
    const cats = Object.keys(EMOJI);
    const draw = (cat) => {
      d.innerHTML = `<div class="cv-etabs">${cats.map((c) => `<button data-cat="${c}" aria-pressed="${c === cat}">${c}</button>`).join('')}</div>` +
        `<div class="cv-egrid">${EMOJI[cat].split(' ').map((ch) => `<button data-e="${ch}">${ch}</button>`).join('')}</div>`;
    };
    draw(cats[0]);
    d.addEventListener('click', (e) => {
      const c = e.target.closest('[data-cat]');
      if (c) { draw(c.dataset.cat); return; }
      const b = e.target.closest('[data-e]');
      if (b) { this.hidePop(); this.setTool(null); this.addEmoji(b.dataset.e); }
    });
    d.addEventListener('mousedown', (e) => { if (this.editing) e.preventDefault(); });
    return d;
  }
}
