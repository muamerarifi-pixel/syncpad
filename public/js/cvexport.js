// Save a canvas note as PNG or PDF, cropped to any rectangle (any aspect ratio).
import { shapeSvg, lineSvg, penSvg, lineGeom, extent, pageHeight } from './canvas.js';

const FONT = {
  outfit: ["'Outfit',sans-serif", '/vendor/fonts/outfit-latin-wght-normal.woff2', 'Outfit'],
  lora: ["'Lora',Georgia,serif", '/vendor/fonts/lora-latin-wght-normal.woff2', 'Lora'],
  caveat: ["'Caveat',cursive", '/vendor/fonts/caveat-latin-wght-normal.woff2', 'Caveat']
};
const SYS = "system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
const PAPER = { sepia: '#f4ecd8', 'sepia-lined': '#f4ecd8' };
const INK = { sepia: '#3b2f20', 'sepia-lined': '#3b2f20' };
const TEXT_CSS = 'h1{font-size:1.6em;margin:.15em 0 .3em;line-height:1.2}h2{font-size:1.35em;margin:.15em 0 .3em;line-height:1.2}h3{font-size:1.15em;margin:.15em 0 .3em}' +
  'p,div{margin:0}p+p{margin-top:.35em}ul,ol{margin:.15em 0 .35em;padding-left:1.3em}a{color:#4f46e5}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.2em .45em}' +
  'ul[data-checklist]{list-style:none;padding-left:.2em}ul[data-checklist]>li::before{content:"☐ "}ul[data-checklist]>li[data-checked="true"]::before{content:"☑ "}';

const ns = (svg) => svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
const asImage = (svg) => new Promise((resolve, reject) => {
  const im = new Image();
  im.onload = () => resolve(im);
  im.onerror = () => reject(new Error('svg'));
  im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
});
let fontCache = {};
async function fontFace(font) {
  const f = FONT[font];
  if (!f) return '';
  if (!fontCache[font]) {
    const buf = new Uint8Array(await (await fetch(f[1])).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    fontCache[font] = `@font-face{font-family:'${f[2]}';src:url(data:font/woff2;base64,${btoa(s)}) format('woff2');font-weight:100 900}`;
  }
  return fontCache[font];
}

export function contentBox(data, margin = 30) {
  const items = (data && data.items) || [];
  if (!items.length) return { x: 0, y: 0, w: 1000, h: 600 };
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const o of items) {
    const b = o.t === 'line' ? (() => { const g = lineGeom(o); return { x: g.left + g.pad / 2, y: g.top + g.pad / 2, w: g.w - g.pad, h: g.h - g.pad }; })() : extent(o);
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  x1 = Math.max(0, x1 - margin); y1 = Math.max(0, y1 - margin);
  x2 = Math.min(1000, x2 + margin);
  return { x: x1, y: y1, w: Math.max(20, x2 - x1), h: Math.max(20, y2 + margin - y1) };
}

/** Draws the canvas (only the crop) onto a <canvas> at `scale` pixels per page unit */
export async function render(data, { crop, scale, paper = '', font = '', loadImage, sanitize }) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(crop.w * scale));
  c.height = Math.max(1, Math.round(crop.h * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = PAPER[paper] || '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  ctx.translate(-crop.x, -crop.y);
  if (paper === 'sepia-lined') {
    ctx.strokeStyle = 'rgba(120,90,50,.18)';
    ctx.lineWidth = 1.2;
    for (let y = 60; y < crop.y + crop.h; y += 38) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1000, y); ctx.stroke(); }
  }
  const ink = INK[paper] || '#16181d';
  const fix = (svg) => ns(svg).replace(/var\(--cv-ink\)/g, ink);
  const face = await fontFace(font);
  const fam = (FONT[font] || [SYS])[0];
  for (const o of (data && data.items) || []) {
    try {
      if (o.t === 'line') {
        const g = lineGeom(o);
        ctx.drawImage(await asImage(fix(lineSvg(o))), g.left, g.top, g.w, g.h);
        continue;
      }
      ctx.save();
      ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
      if (o.r) ctx.rotate((o.r * Math.PI) / 180);
      const x = -o.w / 2;
      const y = -o.h / 2;
      if (o.t === 'shape') ctx.drawImage(await asImage(fix(shapeSvg(o))), x, y, o.w, o.h);
      else if (o.t === 'pen') ctx.drawImage(await asImage(fix(penSvg(o))), x, y, o.w, o.h);
      else if (o.t === 'img') { const im = await loadImage(o.file); if (im) ctx.drawImage(im, x, y, o.w, o.h); }
      else if (o.t === 'emoji') {
        ctx.font = `${o.h * 0.82}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(o.ch || '', 0, o.h * 0.04);
      } else if (o.t === 'file') {
        ctx.fillStyle = '#f1f3f5';
        ctx.strokeStyle = '#ced4da';
        ctx.beginPath();
        ctx.roundRect(x, y, o.w, o.h, 12);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = ink;
        ctx.font = `600 20px ${SYS}`;
        ctx.textBaseline = 'middle';
        ctx.fillText('📎 ' + (o.name || 'file'), x + 16, 0, o.w - 28);
      } else if (o.t === 'text') {
        const box = document.createElement('div');
        box.innerHTML = sanitize(o.html || '');
        const st = `font-family:${fam};font-size:${o.fs || 24}px;color:${o.color || ink};text-align:${o.align || 'left'};` +
          `${o.bold ? 'font-weight:700;' : ''}${o.italic ? 'font-style:italic;' : ''}${o.bg && o.bg !== 'none' ? `background:${o.bg};` : ''}` +
          `line-height:1.4;padding:.2em .35em;overflow-wrap:anywhere;width:${o.w}px;box-sizing:border-box;border-radius:6px;margin:0`;
        box.setAttribute('style', st);
        const style = document.createElement('style');
        style.textContent = face + TEXT_CSS;
        box.prepend(style);
        const xhtml = new XMLSerializer().serializeToString(box);
        const h = (o.h || 40) + 6;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${o.w}" height="${h}"><foreignObject x="0" y="0" width="${o.w}" height="${h}">${xhtml}</foreignObject></svg>`;
        ctx.drawImage(await asImage(svg), x, y, o.w, h);
      }
      ctx.restore();
    } catch { try { ctx.restore(); } catch {} }
  }
  return c;
}

const toBlob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));

export async function toPdf(c, crop) {
  const L = await import('/vendor/pdf/pdf-lib.esm.min.js');
  const doc = await L.PDFDocument.create();
  const png = await doc.embedPng(await (await toBlob(c)).arrayBuffer());
  const k = 0.595; // 1000 page units = A4 width
  const page = doc.addPage([crop.w * k, crop.h * k]);
  page.drawImage(png, { x: 0, y: 0, width: crop.w * k, height: crop.h * k });
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

/** The "Save canvas" sheet: preview, crop with 8 handles, PNG / PDF */
export function openExport({ data, title, paper, font, loadImage, sanitize, save }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet sheet-wide cvx';
  const hs = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  dlg.innerHTML = `<div class="sheet-head"><h2>Save canvas</h2><button class="icon-btn" data-x aria-label="Close"><svg class="ic"><use href="#i-x"/></svg></button></div>
    <div class="sheet-body">
      <small class="muted">Drag the edges or corners to crop away blank space — any shape. Drag inside to move the frame.</small>
      <div class="cvx-stage"><img class="cvx-img" alt="Canvas preview"><div class="cvx-crop">${hs.map((h) => `<i data-h="${h}"></i>`).join('')}</div></div>
      <div class="row cvx-row"><button class="btn btn-soft btn-sm" data-fit>Fit to content</button><button class="btn btn-soft btn-sm" data-all>Whole page</button><span class="muted small cvx-size"></span></div>
      <label class="cvx-check"><input type="checkbox" data-drops> Also put a copy in Drops (on all my devices)</label>
      <div class="row cvx-row"><button class="btn btn-primary" data-png>Save PNG</button><button class="btn btn-primary" data-pdf>Save PDF</button></div>
    </div>`;
  document.body.appendChild(dlg);
  const img = dlg.querySelector('.cvx-img');
  const box = dlg.querySelector('.cvx-crop');
  const size = dlg.querySelector('.cvx-size');
  const H = Math.max(400, pageHeight(data) - 200);
  const page = { x: 0, y: 0, w: 1000, h: H };
  let crop = contentBox(data);
  const k = () => img.clientWidth / 1000;
  const draw = () => {
    Object.assign(box.style, { left: crop.x * k() + 'px', top: crop.y * k() + 'px', width: crop.w * k() + 'px', height: crop.h * k() + 'px' });
    size.textContent = `${Math.round(crop.w * 2)} × ${Math.round(crop.h * 2)} px`;
  };
  render(data, { crop: page, scale: 0.75, paper, font, loadImage, sanitize }).then((c) => { img.src = c.toDataURL('image/png'); img.onload = draw; });
  dlg.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-h]');
    if (!h && e.target !== box) return;
    e.preventDefault();
    const mode = h ? h.dataset.h : 'move';
    const c0 = { ...crop };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev) => {
      const dx = (ev.clientX - x0) / k();
      const dy = (ev.clientY - y0) / k();
      let { x, y, w, h: hh } = c0;
      if (mode === 'move') { x = Math.min(Math.max(0, x + dx), 1000 - w); y = Math.min(Math.max(0, y + dy), H - hh); }
      else {
        if (mode.includes('w')) { const nx = Math.min(Math.max(0, x + dx), x + w - 20); w += x - nx; x = nx; }
        if (mode.includes('e')) w = Math.min(Math.max(20, w + dx), 1000 - x);
        if (mode.includes('n')) { const ny = Math.min(Math.max(0, y + dy), y + hh - 20); hh += y - ny; y = ny; }
        if (mode.includes('s')) hh = Math.min(Math.max(20, hh + dy), H - y);
      }
      crop = { x, y, w, h: hh };
      draw();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-x')) return close();
    if (b.hasAttribute('data-fit')) { crop = contentBox(data); draw(); return; }
    if (b.hasAttribute('data-all')) { crop = { ...page }; draw(); return; }
    const pdf = b.hasAttribute('data-pdf');
    if (!pdf && !b.hasAttribute('data-png')) return;
    b.disabled = true;
    const label = b.textContent;
    b.textContent = 'Saving…';
    try {
      const c = await render(data, { crop, scale: 2, paper, font, loadImage, sanitize });
      const blob = pdf ? await toPdf(c, crop) : await toBlob(c);
      const name = `${(title || 'Canvas').replace(/[\\/:*?"<>|]+/g, '').slice(0, 60) || 'Canvas'}.${pdf ? 'pdf' : 'png'}`;
      await save(blob, name, dlg.querySelector('[data-drops]').checked);
      close();
    } catch (err) {
      b.disabled = false;
      b.textContent = label;
      size.textContent = 'Could not save: ' + (err && err.message ? err.message : 'error');
    }
  });
  dlg.showModal();
  addEventListener('resize', draw, { once: true });
}
