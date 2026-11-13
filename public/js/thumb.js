// Universal client-side thumbnail generator for every file type in SyncPad Drops.
// Lazy-loaded by files.js; relies only on Canvas 2D + bundled parsers (pdf.js, docmodel, epub, fflate).

import { fileKind, extOf, fmtBytes } from './util.js';

const TARGET = 440;
const PDF_VENDOR = '/vendor/pdf/';

const KIND_THEME = {
  image:   { accent: '#0369a1', tint: '#e0f2fe', ink: '#0c4a6e', label: 'Image' },
  video:   { accent: '#be185d', tint: '#fce7f3', ink: '#831843', label: 'Video' },
  audio:   { accent: '#b45309', tint: '#fef3c7', ink: '#78350f', label: 'Audio' },
  pdf:     { accent: '#e03131', tint: '#fee2e2', ink: '#7f1d1d', label: 'PDF' },
  archive: { accent: '#6d28d9', tint: '#ede9fe', ink: '#4c1d95', label: 'Archive' },
  doc:     { accent: '#1d4ed8', tint: '#dbeafe', ink: '#1e3a8a', label: 'Document' },
  sheet:   { accent: '#15803d', tint: '#dcfce7', ink: '#14532d', label: 'Spreadsheet' },
  slides:  { accent: '#c2410c', tint: '#ffedd5', ink: '#7c2d12', label: 'Presentation' },
  code:    { accent: '#334155', tint: '#e2e8f0', ink: '#0f172a', label: 'Code' },
  other:   { accent: '#475569', tint: '#f1f5f9', ink: '#1e293b', label: 'File' }
};

/* ───────────────────────── canvas & image primitives ───────────────────────── */

function makeCanvas(w, h, bg = '#ffffff') {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return { canvas, ctx, w: canvas.width, h: canvas.height };
}

export function encodeCanvas(canvas, origW, origH, { quality = 0.76 } = {}) {
  const w = Math.round(origW || canvas.width || 1);
  const h = Math.round(origH || canvas.height || 1);
  try {
    let thumb = canvas.toDataURL('image/webp', quality);
    if (!thumb.startsWith('data:image/webp') || thumb.length > 150000) {
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      thumb = canvas.toDataURL('image/jpeg', Math.min(0.74, quality));
    }
    canvas.width = canvas.height = 0;
    if (!thumb || thumb.length > 170000) return null;
    return { thumb, w, h };
  } catch {
    canvas.width = canvas.height = 0;
    return null;
  }
}

export function drawImageFitted(src, w, h, { max = TARGET, bg = null } = {}) {
  if (!w || !h) return null;
  const scale = Math.min(1, max / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const { canvas, ctx } = makeCanvas(cw, ch, bg);
  ctx.drawImage(src, 0, 0, cw, ch);
  return encodeCanvas(canvas, w, h, { quality: 0.74 });
}

function rrect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function loadImgSrc(src, timeout = 3500) {
  return new Promise((res, rej) => {
    const img = new Image();
    const timer = setTimeout(() => { cleanup(); rej(new Error('img-timeout')); }, timeout);
    const cleanup = () => { clearTimeout(timer); img.onload = null; img.onerror = null; };
    img.onload = () => { cleanup(); res(img); };
    img.onerror = () => { cleanup(); rej(new Error('img-error')); };
    img.src = src;
  });
}

async function imgFromBlob(blob, timeout = 3500) {
  const url = URL.createObjectURL(blob);
  try {
    return await loadImgSrc(url, timeout);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fitText(ctx, str, maxW) {
  const s = String(str || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo) + '…' : '';
}

function wrapLines(ctx, text, maxW, maxLines) {
  const out = [];
  const rawLines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  for (const para of rawLines) {
    if (out.length >= maxLines) break;
    const clean = para.replace(/\t/g, '  ').trimEnd();
    if (!clean.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    let line = '';
    for (const token of clean.split(/( +)/)) {
      if (out.length >= maxLines) break;
      const cand = line + token;
      if (ctx.measureText(cand).width <= maxW) {
        line = cand;
        continue;
      }
      if (line.trim()) {
        out.push(line.trimEnd());
        line = token.trim() ? token : '';
      }
      while (line && ctx.measureText(line).width > maxW && out.length < maxLines) {
        let cut = 1;
        while (cut < line.length && ctx.measureText(line.slice(0, cut + 1)).width <= maxW) cut++;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line.trim() && out.length < maxLines) out.push(line.trimEnd());
  }
  return out.slice(0, maxLines);
}

function fontStack(mono = false) {
  return mono
    ? 'ui-monospace, "Cascadia Mono", Consolas, monospace'
    : 'system-ui, -apple-system, "Segoe UI", sans-serif';
}

/* ───────────────────────── generic card & binary fallback ───────────────────────── */

function renderCardThumb({ kind = 'other', ext = '', name = 'File', size = 0, subtitle = '', rows = [], motif = 'sheet' }) {
  const th = KIND_THEME[kind] || KIND_THEME.other;
  const W = 420, H = 420;
  const { canvas, ctx } = makeCanvas(W, H, '#ffffff');

  // Soft tinted header strip
  ctx.fillStyle = th.tint;
  ctx.fillRect(0, 0, W, 118);
  ctx.fillStyle = th.accent;
  ctx.fillRect(0, 0, W, 8);

  // Subtle decorative motif in header
  if (motif === 'video') {
    ctx.fillStyle = 'rgba(190, 24, 93, 0.14)';
    for (let x = 22; x < W - 20; x += 34) {
      rrect(ctx, x, 18, 18, 12, 3);
      ctx.fill();
    }
  } else {
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 118);
    ctx.lineTo(W, 118);
    ctx.stroke();
  }

  // Type pill in header
  const badge = (ext || th.label || 'FILE').slice(0, 6).toUpperCase();
  ctx.font = `800 22px ${fontStack()}`;
  const bw = Math.max(76, ctx.measureText(badge).width + 32);
  ctx.fillStyle = th.accent;
  rrect(ctx, 26, 40, bw, 44, 12);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(badge, 26 + (bw - ctx.measureText(badge).width) / 2, 62);

  // Size & subtitle next to pill
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = th.ink;
  ctx.font = `700 18px ${fontStack()}`;
  ctx.fillText(fitText(ctx, subtitle || th.label, W - bw - 68), 38 + bw, 59);
  ctx.fillStyle = '#64748b';
  ctx.font = `600 15px ${fontStack()}`;
  ctx.fillText(size > 0 ? fmtBytes(size) : 'File', 38 + bw, 82);

  // Filename title
  ctx.fillStyle = '#0f172a';
  ctx.font = `700 20px ${fontStack()}`;
  const nameLines = wrapLines(ctx, name, W - 56, 2);
  let y = 158;
  for (const ln of nameLines) {
    ctx.fillText(ln, 28, y);
    y += 28;
  }

  // Body rows (either structured details/hex lines or clean stylized placeholder lines)
  y += 14;
  ctx.strokeStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.moveTo(28, y - 8);
  ctx.lineTo(W - 28, y - 8);
  ctx.stroke();
  y += 18;

  if (rows.length) {
    for (const r of rows.slice(0, 6)) {
      if (y > H - 40) break;
      ctx.font = `600 ${r.mono ? 13.5 : 15}px ${fontStack(!!r.mono)}`;
      ctx.fillStyle = r.muted ? '#64748b' : '#334155';
      ctx.fillText(fitText(ctx, r.text || r, W - 56), 28, y);
      y += r.mono ? 23 : 26;
    }
  } else {
    const bars = [0.88, 0.72, 0.94, 0.6, 0.8];
    for (let i = 0; i < bars.length; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#f1f5f9' : '#f8fafc';
      rrect(ctx, 28, y - 10, Math.round((W - 56) * bars[i]), 14, 7);
      ctx.fill();
      y += 28;
    }
  }

  return encodeCanvas(canvas, W, H);
}

/* ───────────────────────── media: image, video, pdf ───────────────────────── */

async function renderImageThumb(blob, meta) {
  const isSvg = meta.ext === 'svg' || (meta.type || '').includes('svg');
  if (isSvg) {
    try {
      const img = await imgFromBlob(blob, 3000);
      const nw = img.naturalWidth || 440;
      const nh = img.naturalHeight || 440;
      const scale = Math.min(2, TARGET / Math.max(nw, nh));
      const cw = Math.max(48, Math.round(nw * scale));
      const ch = Math.max(48, Math.round(nh * scale));
      const { canvas, ctx } = makeCanvas(cw, ch, '#ffffff');
      ctx.drawImage(img, 0, 0, cw, ch);
      return encodeCanvas(canvas, nw, nh);
    } catch {
      const text = await blob.slice(0, 16384).text().catch(() => '');
      if (text) return renderCodeThumb(text, 'svg', meta);
    }
  }
  if (blob.size < 60 * 1024 * 1024 && typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      const out = drawImageFitted(bmp, bmp.width, bmp.height);
      bmp.close && bmp.close();
      if (out) return out;
    } catch {}
  }
  try {
    const img = await imgFromBlob(blob, 3500);
    const out = drawImageFitted(img, img.naturalWidth, img.naturalHeight);
    if (out) return out;
  } catch {}
  return renderCardThumb({
    kind: 'image',
    ext: meta.ext || 'IMG',
    name: meta.name,
    size: meta.size,
    subtitle: 'Image file'
  });
}

async function renderVideoThumb(blob, meta) {
  const url = URL.createObjectURL(blob);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.src = url;
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('video-timeout')), 3500);
      v.onloadeddata = () => { clearTimeout(timer); res(); };
      v.onerror = () => { clearTimeout(timer); rej(new Error('video-err')); };
    });
    v.currentTime = Math.min(1, (v.duration || 2) / 3);
    await new Promise((res) => {
      const timer = setTimeout(res, 1200);
      v.onseeked = () => { clearTimeout(timer); res(); };
    });
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      const out = drawImageFitted(v, v.videoWidth, v.videoHeight);
      if (out) return out;
    }
  } catch {} finally {
    URL.revokeObjectURL(url);
  }
  return renderCardThumb({
    kind: 'video',
    ext: meta.ext || 'VID',
    name: meta.name,
    size: meta.size,
    subtitle: 'Video clip',
    motif: 'video'
  });
}

export async function renderPdfThumb(input) {
  let bytes;
  try {
    if (input instanceof Uint8Array) bytes = input;
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (input && typeof input.arrayBuffer === 'function') bytes = new Uint8Array(await input.arrayBuffer());
    else return null;
  } catch (err) {
    console.warn('renderPdfThumb bytes error', err);
    return null;
  }

  try {
    const lib = await import(PDF_VENDOR + 'pdf.min.mjs');
    if (!lib.GlobalWorkerOptions.workerSrc) {
      lib.GlobalWorkerOptions.workerSrc = PDF_VENDOR + 'pdf.worker.min.mjs';
    }
    const task = lib.getDocument({
      data: bytes,
      isEvalSupported: false,
      useWasm: false,
      standardFontDataUrl: PDF_VENDOR + 'standard_fonts/',
      verbosity: 0
    });
    const pdf = await task.promise;
    try {
      const page = await pdf.getPage(1);
      const vp0 = page.getViewport({ scale: 1 });
      const scale = Math.min(2, TARGET / Math.max(vp0.width, vp0.height));
      const vp = page.getViewport({ scale });
      const { canvas, ctx } = makeCanvas(vp.width, vp.height, '#ffffff');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();
      return encodeCanvas(canvas, vp0.width, vp0.height, { quality: 0.75 });
    } finally {
      task.destroy().catch(() => {});
    }
  } catch (err) {
    console.warn('renderPdfThumb render error', err);
    const locked = err && err.name === 'PasswordException';
    return { error: locked ? 'Password protected PDF' : 'PDF Document', failed: true };
  }
}

/* ───────────────────────── text, markdown, html, code, rtf ───────────────────────── */

function renderTextPageThumb(text, meta, { label = '', kind = 'doc' } = {}) {
  const th = KIND_THEME[kind] || KIND_THEME.doc;
  const W = 340, H = 440, M = 22;
  const { canvas, ctx } = makeCanvas(W, H, '#ffffff');
  // Subtle top accent bar & document title
  ctx.fillStyle = th.tint;
  ctx.fillRect(0, 0, W, 40);
  ctx.fillStyle = th.accent;
  ctx.fillRect(0, 0, W, 4);
  ctx.font = `700 13.5px ${fontStack()}`;
  ctx.fillStyle = th.ink;
  ctx.fillText(fitText(ctx, label || meta.name || 'Text Document', W - M * 2), M, 26);

  ctx.font = `400 12px ${fontStack()}`;
  ctx.fillStyle = '#1f2937';
  const lines = wrapLines(ctx, text.slice(0, 6000), W - M * 2, 22);
  let y = 64;
  for (const ln of lines) {
    if (y > H - 18) break;
    if (ln) ctx.fillText(ln, M, y);
    y += ln ? 17 : 9;
  }
  return encodeCanvas(canvas, W, H);
}

function renderMarkdownThumb(text, meta) {
  const W = 340, H = 440, M = 22;
  const { canvas, ctx } = makeCanvas(W, H, '#ffffff');
  const rawLines = String(text || '').replace(/\r\n?/g, '\n').split('\n').slice(0, 60);
  let y = 30;
  for (let raw of rawLines) {
    if (y > H - 16) break;
    const trimmed = raw.trim();
    if (!trimmed) { y += 8; continue; }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      ctx.strokeStyle = '#e2e8f0';
      ctx.beginPath(); ctx.moveTo(M, y - 4); ctx.lineTo(W - M, y - 4); ctx.stroke();
      y += 10;
      continue;
    }
    const hm = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (hm) {
      const lvl = hm[1].length;
      const sz = lvl === 1 ? 19 : lvl === 2 ? 15 : 13;
      const lh = sz + 5;
      ctx.font = `700 ${sz}px ${fontStack()}`;
      ctx.fillStyle = lvl === 1 ? '#0f172a' : '#1e3a8a';
      for (const ln of wrapLines(ctx, hm[2].replace(/[*_`]/g, ''), W - M * 2, 2)) {
        if (y > H - 14) break;
        ctx.fillText(ln, M, y);
        y += lh;
      }
      y += 4;
      continue;
    }
    let indent = 0;
    let isBullet = false;
    let isQuote = false;
    if (/^>\s?/.test(trimmed)) {
      isQuote = true;
      raw = trimmed.replace(/^>\s?/, '');
      indent = 12;
    } else if (/^[-*+]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      isBullet = true;
      indent = 14;
      raw = trimmed.replace(/^([-*+]|\d+[.)])\s+/, '');
    }
    raw = raw.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`~]/g, '');
    ctx.font = `400 11.5px ${fontStack()}`;
    ctx.fillStyle = isQuote ? '#475569' : '#1f2937';
    const lines = wrapLines(ctx, raw, W - M * 2 - indent, 4);
    for (let i = 0; i < lines.length; i++) {
      if (y > H - 14) break;
      if (isQuote) {
        ctx.fillStyle = '#94a3b8';
        ctx.fillRect(M + 2, y - 10, 3, 13);
        ctx.fillStyle = '#475569';
      } else if (isBullet && i === 0) {
        ctx.fillStyle = '#2563eb';
        ctx.beginPath(); ctx.arc(M + 5, y - 3.5, 2.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1f2937';
      }
      ctx.fillText(lines[i], M + indent, y);
      y += 16;
    }
  }
  return encodeCanvas(canvas, W, H);
}

function renderHtmlThumb(html, meta) {
  try {
    const doc = new DOMParser().parseFromString(html.slice(0, 32768), 'text/html');
    const title = doc.title ? doc.title.trim() : '';
    const items = [];
    for (const n of doc.querySelectorAll('h1, h2, h3, p, li')) {
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) items.push({ tag: n.tagName.toLowerCase(), text: t });
      if (items.length >= 25) break;
    }
    if (items.length || title) {
      const W = 340, H = 440, M = 20;
      const { canvas, ctx } = makeCanvas(W, H, '#ffffff');
      // Browser-like top bar
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(0, 0, W, 32);
      ctx.fillStyle = '#cbd5e1';
      [14, 24, 34].forEach((cx) => { ctx.beginPath(); ctx.arc(cx, 16, 3.2, 0, Math.PI * 2); ctx.fill(); });
      ctx.fillStyle = '#ffffff';
      rrect(ctx, 48, 7, W - 62, 18, 6);
      ctx.fill();
      ctx.font = `600 10.5px ${fontStack()}`;
      ctx.fillStyle = '#475569';
      ctx.fillText(fitText(ctx, title || meta.name, W - 76), 55, 19.5);

      let y = 56;
      if (!items.length && title) items.push({ tag: 'h1', text: title });
      for (const it of items) {
        if (y > H - 16) break;
        const head = /^h[1-3]$/.test(it.tag);
        const sz = it.tag === 'h1' ? 18 : it.tag === 'h2' ? 14.5 : head ? 12.5 : 11;
        ctx.font = `${head ? 700 : 400} ${sz}px ${fontStack()}`;
        ctx.fillStyle = head ? '#0f172a' : '#334155';
        const lines = wrapLines(ctx, (it.tag === 'li' ? '• ' : '') + it.text, W - M * 2, head ? 2 : 3);
        for (const ln of lines) {
          if (y > H - 14) break;
          ctx.fillText(ln, M, y);
          y += sz + 4.5;
        }
        y += head ? 5 : 3;
      }
      return encodeCanvas(canvas, W, H);
    }
  } catch {}
  return renderCodeThumb(html, meta.ext || 'html', meta);
}

const CODE_KW = /^(?:const|let|var|function|return|if|else|for|while|import|export|from|class|extends|async|await|try|catch|def|elif|pass|with|public|private|static|void|int|string|bool|true|false|null|undefined|None|True|False|SELECT|FROM|WHERE|INSERT|UPDATE|CREATE|TABLE|struct|impl|fn|pub|use|type|interface)$/;

function renderCodeThumb(raw, ext, meta) {
  let text = String(raw || '');
  if (ext === 'json' && !text.includes('\n') && text.length < 12000) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
  }
  const W = 400, H = 440;
  const { canvas, ctx } = makeCanvas(W, H, '#f8fafc');
  // Gutter
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(0, 0, 38, H);
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(38, 0, 1, H);
  // Top file tab bar
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(0, 0, W, 28);
  ctx.fillStyle = '#f8fafc';
  rrect(ctx, 8, 4, Math.min(240, W - 20), 24, 6);
  ctx.fill();
  ctx.font = `700 11px ${fontStack(true)}`;
  ctx.fillStyle = '#1e293b';
  ctx.fillText(fitText(ctx, meta.name || ('file.' + ext), 210), 16, 19);

  const lines = text.replace(/\r\n?/g, '\n').split('\n').slice(0, 25);
  ctx.font = `400 11.5px ${fontStack(true)}`;
  let y = 48;
  for (let idx = 0; idx < lines.length; idx++) {
    if (y > H - 10) break;
    ctx.fillStyle = '#94a3b8';
    const num = String(idx + 1);
    ctx.fillText(num, 31 - ctx.measureText(num).width, y);

    const ln = lines[idx].replace(/\t/g, '  ').slice(0, 80);
    let x = 46;
    if (/^\s*(\/\/|#|\/\*|--|<!--)/.test(ln)) {
      ctx.fillStyle = '#64748b';
      ctx.fillText(fitText(ctx, ln, W - x - 10), x, y);
    } else {
      const tokens = ln.match(/"[^"]*"|'[^']*'|`[^`]*`|\b[A-Za-z_][\w$-]*\b|\b\d+(?:\.\d+)?\b|./g) || [];
      for (const tok of tokens) {
        if (x > W - 14) break;
        if (/^["'`]/.test(tok)) ctx.fillStyle = '#15803d';
        else if (/^\d/.test(tok)) ctx.fillStyle = '#c2410c';
        else if (CODE_KW.test(tok)) ctx.fillStyle = '#0369a1';
        else if (/^[A-Za-z_<]/.test(tok)) ctx.fillStyle = '#0f172a';
        else ctx.fillStyle = '#475569';
        const tw = ctx.measureText(tok).width;
        if (x + tw > W - 10) {
          ctx.fillText(fitText(ctx, tok, W - x - 8), x, y);
          break;
        }
        ctx.fillText(tok, x, y);
        x += tw;
      }
    }
    y += 16;
  }
  return encodeCanvas(canvas, W, H);
}

function stripRtf(s) {
  let out = '';
  let skipDepth = 0;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      depth++;
      if (!skipDepth && /^\\(\*|(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|fldinst)\b)/.test(s.slice(i + 1, i + 20))) {
        skipDepth = depth;
      }
    } else if (ch === '}') {
      if (skipDepth === depth) skipDepth = 0;
      depth = Math.max(0, depth - 1);
    } else if (skipDepth) {
      continue;
    } else if (ch === '\\') {
      const rest = s.slice(i + 1, i + 32);
      const hex = /^'([0-9a-fA-F]{2})/.exec(rest);
      if (hex) {
        out += String.fromCharCode(parseInt(hex[1], 16));
        i += 3;
      } else if (/^(par|line)\b/.test(rest)) {
        out += '\n';
        const m = /^[a-z]+ ?/.exec(rest);
        i += m[0].length;
      } else if (/^tab\b/.test(rest)) {
        out += '  ';
        i += 3;
      } else if (/^[{}\\]/.test(rest)) {
        out += rest[0];
        i += 1;
      } else {
        const m = /^[a-zA-Z]+-?\d* ?/.exec(rest);
        if (m) i += m[0].length;
      }
    } else if (ch !== '\r' && ch !== '\n') {
      out += ch;
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function extractLegacyDocText(bytes) {
  // Scan Word binary stream for clean UTF-16LE and ASCII runs
  const chunks = [];
  let run = '';
  for (let i = 0; i < bytes.length - 1; i += 2) {
    const lo = bytes[i], hi = bytes[i + 1];
    const code = lo | (hi << 8);
    if ((code >= 32 && code <= 126) || code === 13 || code === 10 || (code >= 0x00c0 && code <= 0x024f)) {
      run += code === 13 ? '\n' : String.fromCharCode(code);
    } else {
      if (run.length >= 16 && /[A-Za-z]{3,}/.test(run)) chunks.push(run.trim());
      run = '';
    }
    if (chunks.length >= 40) break;
  }
  if (!chunks.length) {
    run = '';
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if ((c >= 32 && c <= 126) || c === 13 || c === 10) run += c === 13 ? '\n' : String.fromCharCode(c);
      else {
        if (run.length >= 24 && /[A-Za-z]{4,}/.test(run) && !/^(Microsoft|Root Entry|Word\.Document|SummaryInformation)/.test(run)) {
          chunks.push(run.trim());
        }
        run = '';
      }
      if (chunks.length >= 30) break;
    }
  }
  return chunks.filter((c) => !/^[A-Z0-9 _.-]{12,}$/.test(c)).join('\n');
}

/* ───────────────────────── rich Office documents (.docx, .xlsx, .pptx, .epub, .odt/.ods/.odp) ───────────────────────── */

async function renderDocxThumb(bytes, meta) {
  const { readDocx } = await import('./docmodel.js');
  const blocks = readDocx(bytes);
  if (!blocks || !blocks.length) {
    return renderCardThumb({ kind: 'doc', ext: meta.ext || 'DOCX', name: meta.name, size: meta.size, subtitle: 'Word Document' });
  }
  const W = 340, H = 440, M = 22;
  const { canvas, ctx } = makeCanvas(W, H, '#ffffff');
  let y = 26;
  const listCount = {};

  for (const b of blocks.slice(0, 60)) {
    if (y > H - 14) break;
    if (b.t === 'img' && b.src) {
      try {
        const im = await loadImgSrc(b.src, 1500);
        const maxW = W - M * 2;
        const maxH = Math.min(130, H - y - 16);
        const sc = Math.min(1, maxW / im.naturalWidth, maxH / im.naturalHeight);
        const dw = Math.max(12, Math.round(im.naturalWidth * sc));
        const dh = Math.max(12, Math.round(im.naturalHeight * sc));
        const dx = b.align === 'center' ? (W - dw) / 2 : b.align === 'right' ? W - M - dw : M;
        ctx.drawImage(im, dx, y, dw, dh);
        y += dh + 8;
      } catch {}
      continue;
    }
    if (b.t === 'table' && b.rows && b.rows.length) {
      const cols = Math.min(4, Math.max(1, ...b.rows.map((r) => r.length)));
      const cw = (W - M * 2) / cols;
      const rh = 18;
      for (let ri = 0; ri < Math.min(5, b.rows.length); ri++) {
        if (y + rh > H - 12) break;
        const row = b.rows[ri];
        for (let ci = 0; ci < cols; ci++) {
          const cellBlocks = row[ci] || [];
          const txt = cellBlocks.map((cb) => (cb.runs || []).map((r) => r.text || '').join('')).join(' ').trim();
          const cx = M + ci * cw;
          if (ri === 0) {
            ctx.fillStyle = '#f1f5f9';
            ctx.fillRect(cx, y, cw, rh);
          }
          ctx.strokeStyle = '#cbd5e1';
          ctx.lineWidth = 0.8;
          ctx.strokeRect(cx, y, cw, rh);
          ctx.font = `${ri === 0 ? 700 : 400} 9.5px ${fontStack()}`;
          ctx.fillStyle = '#1e293b';
          ctx.fillText(fitText(ctx, txt, cw - 6), cx + 3, y + 12.5);
        }
        y += rh;
      }
      y += 8;
      continue;
    }
    if (b.t !== 'p') continue;
    const text = (b.runs || []).map((r) => (r.br ? '\n' : r.text || '')).join('').trim();
    if (!text) {
      y += 7;
      continue;
    }
    const sz = b.style === 'h1' ? 18 : b.style === 'h2' ? 14.5 : b.style === 'h3' ? 12.5 : 10.5;
    const isBold = b.style !== 'normal' || b.runs.some((r) => r.b);
    const isItal = !isBold && b.runs.some((r) => r.i);
    ctx.font = `${isItal ? 'italic ' : ''}${isBold ? 700 : 400} ${sz}px ${fontStack()}`;
    const firstCol = b.runs.find((r) => r.color)?.color;
    ctx.fillStyle = b.style === 'h1' ? '#1f3864' : b.style !== 'normal' ? '#2f5496' : firstCol ? '#' + firstCol : '#1f2937';

    let indent = 0;
    let prefix = '';
    if (b.list) {
      indent = 12 * (b.list.level + 1);
      if (b.list.kind === 'number') {
        const lk = `${b.list.id}:${b.list.level}`;
        listCount[lk] = (listCount[lk] || 0) + 1;
        prefix = listCount[lk] + '. ';
      } else {
        prefix = '• ';
      }
    }
    const lines = wrapLines(ctx, prefix + text, W - M * 2 - indent, b.style === 'normal' ? 4 : 2);
    for (const ln of lines) {
      if (y > H - 12) break;
      ctx.fillText(ln, M + indent, y);
      y += sz * 1.38;
    }
    y += b.style === 'normal' ? 4 : 6;
  }
  return encodeCanvas(canvas, W, H);
}

function parseTableRowsFromHtml(html, maxRows = 16, maxCols = 6) {
  const m = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(html);
  const body = m ? m[1] : html;
  // Parse only top tr slice cleanly with DOMParser
  const trParts = body.split(/<\/tr>/i).slice(0, maxRows).join('</tr>') + '</tr>';
  const doc = new DOMParser().parseFromString(`<table><tbody>${trParts}</tbody></table>`, 'text/html');
  const rows = [];
  for (const tr of doc.querySelectorAll('tr')) {
    const row = [];
    for (const td of tr.querySelectorAll('td')) {
      row.push((td.textContent || '').trim());
      if (row.length >= maxCols) break;
    }
    if (row.length) rows.push(row);
    if (rows.length >= maxRows) break;
  }
  return rows;
}

function renderSheetGridThumb(rows, sheetName, sheetCount, meta) {
  const W = 420, H = 420;
  const { canvas, ctx } = makeCanvas(W, H, '#ffffff');

  // Sheet header bar
  ctx.fillStyle = '#ecfdf5';
  ctx.fillRect(0, 0, W, 38);
  ctx.fillStyle = '#15803d';
  ctx.fillRect(0, 0, W, 5);
  ctx.font = `700 13.5px ${fontStack()}`;
  ctx.fillStyle = '#14532d';
  ctx.fillText(fitText(ctx, sheetName || meta.name || 'Sheet 1', W - 96), 14, 25);
  if (sheetCount > 1) {
    ctx.font = `600 11.5px ${fontStack()}`;
    ctx.fillStyle = '#15803d';
    const lbl = `${sheetCount} sheets`;
    ctx.fillText(lbl, W - 14 - ctx.measureText(lbl).width, 25);
  }

  const colCount = Math.min(5, Math.max(3, ...rows.map((r) => r.length)));
  const rowGutter = 28;
  const colW = (W - rowGutter) / colCount;
  const colHdrH = 24;
  const rowH = 23;

  // Column letters header (A, B, C...)
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 38, W, colHdrH);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 38 + colHdrH);
  ctx.lineTo(W, 38 + colHdrH);
  ctx.moveTo(rowGutter, 38);
  ctx.lineTo(rowGutter, H);
  ctx.stroke();

  ctx.font = `700 11px ${fontStack()}`;
  ctx.fillStyle = '#64748b';
  for (let c = 0; c < colCount; c++) {
    const cx = rowGutter + c * colW;
    const ch = String.fromCharCode(65 + c);
    ctx.fillText(ch, cx + (colW - ctx.measureText(ch).width) / 2, 54);
    ctx.beginPath();
    ctx.moveTo(cx + colW, 38);
    ctx.lineTo(cx + colW, H);
    ctx.stroke();
  }

  const startY = 38 + colHdrH;
  const maxVisibleRows = Math.floor((H - startY) / rowH);
  for (let r = 0; r < maxVisibleRows; r++) {
    const ry = startY + r * rowH;
    const dataRow = rows[r] || [];
    // Row number gutter
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, ry, rowGutter - 0.5, rowH);
    ctx.fillStyle = '#64748b';
    ctx.font = `600 10.5px ${fontStack()}`;
    const rn = String(r + 1);
    ctx.fillText(rn, (rowGutter - ctx.measureText(rn).width) / 2, ry + 15.5);

    if (r === 0 && rows.length > 0) {
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(rowGutter + 0.5, ry, W - rowGutter, rowH);
    }

    ctx.strokeStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(0, ry + rowH);
    ctx.lineTo(W, ry + rowH);
    ctx.stroke();

    for (let c = 0; c < colCount; c++) {
      const val = dataRow[c] == null ? '' : String(dataRow[c]);
      if (!val) continue;
      const cx = rowGutter + c * colW;
      const isNum = r > 0 && /^-?[\d.,]+%?$/.test(val);
      ctx.font = `${r === 0 ? 700 : 400} 11px ${fontStack()}`;
      ctx.fillStyle = r === 0 ? '#0f172a' : '#1e293b';
      const txt = fitText(ctx, val, colW - 10);
      const tx = isNum ? cx + colW - 5 - ctx.measureText(txt).width : cx + 5;
      ctx.fillText(txt, tx, ry + 15.5);
    }
  }
  return encodeCanvas(canvas, W, H);
}

async function renderSheetThumb(blob, meta) {
  const { ext } = meta;
  if (ext === 'csv' || ext === 'tsv') {
    const { readCsv } = await import('./docmodel.js');
    const sample = await blob.slice(0, 32768).text();
    const sheets = readCsv(sample);
    const rows = parseTableRowsFromHtml(sheets[0].html);
    return renderSheetGridThumb(rows, meta.name, 1, meta);
  }
  if (ext === 'xlsx' || ext === 'xlsm') {
    const { readXlsx } = await import('./docmodel.js');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sheets = readXlsx(bytes);
    if (sheets.length) {
      const rows = parseTableRowsFromHtml(sheets[0].html);
      if (rows.length) return renderSheetGridThumb(rows, sheets[0].name, sheets.length, meta);
    }
  }
  const zipImg = await extractZipThumbImage(bytesOrNull(blob), ['Thumbnails/thumbnail.png', 'docProps/thumbnail.jpeg', 'docProps/thumbnail.png', 'QuickLook/Thumbnail.jpg', 'preview.jpg']);
  if (zipImg) return zipImg;
  if (ext === 'ods') {
    const odsRows = await extractOdfSheetRows(blob);
    if (odsRows.length) return renderSheetGridThumb(odsRows, meta.name, 1, meta);
  }
  return renderCardThumb({ kind: 'sheet', ext: ext || 'XLS', name: meta.name, size: meta.size, subtitle: 'Spreadsheet' });
}

async function bytesOrNull(blob) {
  try { return new Uint8Array(await blob.arrayBuffer()); } catch { return null; }
}

function hasVisualContent(img) {
  try {
    const { canvas, ctx } = makeCanvas(24, 24, '#ffffff');
    ctx.drawImage(img, 0, 0, 24, 24);
    const data = ctx.getImageData(0, 0, 24, 24).data;
    canvas.width = canvas.height = 0;
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) nonWhite++;
    }
    return nonWhite > 8;
  } catch {
    return true;
  }
}

async function extractZipThumbImage(bytesPromise, candidates) {
  const bytes = await bytesPromise;
  if (!bytes) return null;
  try {
    const { unzipSync } = await import('/vendor/doc/fflate.mjs');
    const want = new Set(candidates.map((c) => c.toLowerCase()));
    const files = unzipSync(bytes, { filter: (f) => want.has(f.name.toLowerCase()) });
    for (const k of Object.keys(files)) {
      const data = files[k];
      if (!data || !data.length) continue;
      const mime = /\.png$/i.test(k) ? 'image/png' : 'image/jpeg';
      const img = await imgFromBlob(new Blob([data], { type: mime }), 2500);
      if (!hasVisualContent(img)) continue;
      return drawImageFitted(img, img.naturalWidth, img.naturalHeight, { bg: '#ffffff' });
    }
  } catch {}
  return null;
}

async function extractOdfText(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { unzipSync, strFromU8 } = await import('/vendor/doc/fflate.mjs');
    const files = unzipSync(bytes, { filter: (f) => f.name.toLowerCase() === 'content.xml' });
    if (!files['content.xml']) return '';
    const doc = new DOMParser().parseFromString(strFromU8(files['content.xml']), 'application/xml');
    const out = [];
    for (const el of doc.querySelectorAll('*')) {
      if (el.localName === 'h' || el.localName === 'p') {
        const t = (el.textContent || '').trim();
        if (t) out.push(t);
        if (out.length >= 40) break;
      }
    }
    return out.join('\n');
  } catch { return ''; }
}

async function extractOdfSheetRows(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { unzipSync, strFromU8 } = await import('/vendor/doc/fflate.mjs');
    const files = unzipSync(bytes, { filter: (f) => f.name.toLowerCase() === 'content.xml' });
    if (!files['content.xml']) return [];
    const doc = new DOMParser().parseFromString(strFromU8(files['content.xml']), 'application/xml');
    const rows = [];
    for (const tr of doc.getElementsByTagName('*')) {
      if (tr.localName !== 'table-row') continue;
      const row = [];
      for (const tc of tr.childNodes) {
        if (tc.nodeType === 1 && tc.localName === 'table-cell') {
          row.push((tc.textContent || '').trim());
          if (row.length >= 6) break;
        }
      }
      if (row.some(Boolean)) rows.push(row);
      if (rows.length >= 16) break;
    }
    return rows;
  } catch { return []; }
}

async function renderSlidesThumb(blob, meta) {
  const bytes = await bytesOrNull(blob);

  if (meta.ext === 'pptx' && bytes) {
    try {
      const { readPptx } = await import('./docmodel.js');
      const slides = readPptx(bytes);
      if (slides && slides.length) {
        const doc = new DOMParser().parseFromString(`<div>${slides[0]}</div>`, 'text/html');
        const paras = [...doc.querySelectorAll('p')].map((p) => p.textContent.trim()).filter(Boolean);
        let imEl = doc.querySelector('img');
        // If slide 1 has no image, borrow thumbnail visual from slide 2 only if slide 1 is very sparse
        if (!imEl && slides.length > 1 && paras.length <= 2) {
          const doc2 = new DOMParser().parseFromString(`<div>${slides[1]}</div>`, 'text/html');
          imEl = doc2.querySelector('img');
        }
        const W = 420, H = 420;
        const { canvas, ctx } = makeCanvas(W, H, '#ffffff');
        // Slide accent header
        ctx.fillStyle = '#c2410c';
        ctx.fillRect(0, 0, W, 8);
        ctx.fillStyle = '#fff7ed';
        ctx.fillRect(0, 8, W, 94);

        let y = 52;
        if (paras.length) {
          ctx.font = `700 22px ${fontStack()}`;
          ctx.fillStyle = '#0f172a';
          for (const ln of wrapLines(ctx, paras[0], W - 48, 2)) {
            ctx.fillText(ln, 24, y);
            y += 28;
          }
        } else {
          ctx.font = `700 18px ${fontStack()}`;
          ctx.fillStyle = '#7c2d12';
          ctx.fillText(fitText(ctx, meta.name, W - 48), 24, 58);
        }

        let textRight = W - 24;
        if (imEl && imEl.src) {
          try {
            const im = await loadImgSrc(imEl.src, 1500);
            const maxW = 148, maxH = 180;
            const sc = Math.min(1, maxW / im.naturalWidth, maxH / im.naturalHeight);
            const dw = Math.round(im.naturalWidth * sc);
            const dh = Math.round(im.naturalHeight * sc);
            ctx.drawImage(im, W - 24 - dw, 128, dw, dh);
            textRight = W - 40 - dw;
          } catch {}
        }

        y = 142;
        if (paras.length > 1) {
          ctx.font = `500 15px ${fontStack()}`;
          ctx.fillStyle = '#334155';
          for (const p of paras.slice(1, 8)) {
            if (y > H - 48) break;
            for (const ln of wrapLines(ctx, '• ' + p, textRight - 24, 3)) {
              if (y > H - 48) break;
              ctx.fillText(ln, 24, y);
              y += 22;
            }
            y += 6;
          }
        }
        ctx.font = `700 12.5px ${fontStack()}`;
        ctx.fillStyle = '#9a3412';
        ctx.fillText(`Slide 1 of ${slides.length}`, 24, H - 22);
        return encodeCanvas(canvas, W, H);
      }
    } catch {}
  }

  const embedded = await extractZipThumbImage(Promise.resolve(bytes), [
    'Thumbnails/thumbnail.png', 'QuickLook/Thumbnail.jpg', 'preview.jpg', 'docProps/thumbnail.jpeg', 'docProps/thumbnail.png'
  ]);
  if (embedded) return embedded;

  return renderCardThumb({ kind: 'slides', ext: meta.ext || 'PPT', name: meta.name, size: meta.size, subtitle: 'Presentation' });
}

async function renderEpubThumb(blob, meta) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { readEpub } = await import('./epub.js');
    const book = await readEpub(bytes, { images: true });
    if (book.cover && book.images.get(book.cover)) {
      const covImg = await imgFromBlob(book.images.get(book.cover), 2500);
      const out = drawImageFitted(covImg, covImg.naturalWidth, covImg.naturalHeight, { bg: '#ffffff' });
      if (out) return out;
    }
    // Styled classic book cover fallback
    const W = 320, H = 440;
    const { canvas, ctx } = makeCanvas(W, H, '#fdfbf7');
    ctx.fillStyle = '#e0e7ff';
    ctx.fillRect(0, 0, 22, H);
    ctx.fillStyle = '#4338ca';
    ctx.fillRect(22, 0, 4, H);
    ctx.strokeStyle = '#c7d2fe';
    ctx.strokeRect(42, 24, W - 64, H - 48);

    ctx.font = `700 22px Georgia, serif`;
    ctx.fillStyle = '#1e1b4b';
    let y = 84;
    for (const ln of wrapLines(ctx, book.title || meta.name, W - 92, 4)) {
      ctx.fillText(ln, 58, y);
      y += 28;
    }
    if (book.author) {
      y += 12;
      ctx.font = `italic 14px Georgia, serif`;
      ctx.fillStyle = '#4338ca';
      ctx.fillText(fitText(ctx, book.author, W - 92), 58, y);
    }
    if (book.chapters && book.chapters[0]) {
      const doc = new DOMParser().parseFromString(`<div>${book.chapters[0].html}</div>`, 'text/html');
      const excerpt = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
      if (excerpt) {
        y = Math.max(y + 42, 230);
        ctx.font = `400 11.5px Georgia, serif`;
        ctx.fillStyle = '#475569';
        for (const ln of wrapLines(ctx, excerpt, W - 92, 7)) {
          if (y > H - 44) break;
          ctx.fillText(ln, 58, y);
          y += 16;
        }
      }
    }
    return encodeCanvas(canvas, W, H);
  } catch {
    return renderCardThumb({ kind: 'doc', ext: 'EPUB', name: meta.name, size: meta.size, subtitle: 'ePUB E-book' });
  }
}

/* ───────────────────────── archives (.zip, .apk, .ipa, .jar, .tar) ───────────────────────── */

async function listZipEntries(blob) {
  // Read EOCD from last 65KB without decompressing a single file
  const tailLen = Math.min(blob.size, 65560);
  const tailStart = blob.size - tailLen;
  const tail = new Uint8Array(await blob.slice(tailStart, blob.size).arrayBuffer());
  const dv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd >= 0) {
    const totalEntries = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (cdOffset !== 0xffffffff && cdSize > 0 && cdSize < 8 * 1024 * 1024 && cdOffset + cdSize <= blob.size) {
      let cdBytes;
      if (cdOffset >= tailStart) {
        cdBytes = tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
      } else {
        cdBytes = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
      }
      const cdv = new DataView(cdBytes.buffer, cdBytes.byteOffset, cdBytes.byteLength);
      const dec = new TextDecoder('utf-8', { fatal: false });
      const entries = [];
      let totalUnpacked = 0;
      let off = 0;
      while (off + 46 <= cdBytes.length) {
        if (cdv.getUint32(off, true) !== 0x02014b50) break;
        const uSize = cdv.getUint32(off + 24, true);
        const fnLen = cdv.getUint16(off + 28, true);
        const exLen = cdv.getUint16(off + 30, true);
        const cmLen = cdv.getUint16(off + 32, true);
        const name = dec.decode(cdBytes.subarray(off + 46, off + 46 + fnLen));
        const isDir = name.endsWith('/');
        if (!isDir) totalUnpacked += uSize;
        if (!/^(__MACOSX\/|\.DS_Store$)/.test(name)) entries.push({ name, size: uSize, isDir });
        off += 46 + fnLen + exLen + cmLen;
      }
      return { entries, totalEntries: entries.length || totalEntries, totalUnpacked };
    }
  }
  // Fallback: scan local headers in head 64KB
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer());
  const hdv = new DataView(head.buffer);
  const dec = new TextDecoder('utf-8', { fatal: false });
  const entries = [];
  for (let i = 0; i + 30 < head.length;) {
    if (hdv.getUint32(i, true) === 0x04034b50) {
      const fnLen = hdv.getUint16(i + 26, true);
      const exLen = hdv.getUint16(i + 28, true);
      const cSize = hdv.getUint32(i + 18, true);
      const uSize = hdv.getUint32(i + 22, true);
      const name = dec.decode(head.subarray(i + 30, Math.min(head.length, i + 30 + fnLen)));
      entries.push({ name, size: uSize, isDir: name.endsWith('/') });
      i += 30 + fnLen + exLen + Math.max(1, cSize);
    } else i++;
  }
  return entries.length ? { entries, totalEntries: entries.length, totalUnpacked: 0 } : null;
}

async function listTarEntries(blob) {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer());
  const dec = new TextDecoder('utf-8', { fatal: false });
  const entries = [];
  let off = 0;
  let totalUnpacked = 0;
  while (off + 512 <= head.length) {
    const hdr = head.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const rawName = dec.decode(hdr.subarray(0, 100)).replace(/\0.*$/, '');
    const sizeOct = dec.decode(hdr.subarray(124, 136)).replace(/[\0 ]+/g, '');
    const size = parseInt(sizeOct || '0', 8) || 0;
    const isDir = hdr[156] === 53 || rawName.endsWith('/');
    if (rawName) {
      entries.push({ name: rawName, size, isDir });
      if (!isDir) totalUnpacked += size;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries.length ? { entries, totalEntries: entries.length, totalUnpacked } : null;
}

function renderArchiveListThumb(info, meta) {
  const { entries, totalEntries, totalUnpacked } = info;
  const W = 420, H = 420;
  const { canvas, ctx } = makeCanvas(W, H, '#ffffff');
  ctx.fillStyle = '#f3f0ff';
  ctx.fillRect(0, 0, W, 62);
  ctx.fillStyle = '#6d28d9';
  ctx.fillRect(0, 0, W, 6);

  ctx.font = `700 15px ${fontStack()}`;
  ctx.fillStyle = '#4c1d95';
  const countStr = `${totalEntries} item${totalEntries === 1 ? '' : 's'}`;
  const sub = totalUnpacked > 0 ? `${countStr} · ${fmtBytes(totalUnpacked)} unpacked` : `${countStr} · ${fmtBytes(meta.size)}`;
  ctx.fillText(fitText(ctx, meta.name, W - 36), 18, 28);
  ctx.font = `600 12px ${fontStack()}`;
  ctx.fillStyle = '#6d28d9';
  ctx.fillText(sub, 18, 48);

  let y = 86;
  const shown = entries.slice(0, 11);
  for (const e of shown) {
    if (y > H - 24) break;
    // Tiny folder or file glyph
    if (e.isDir) {
      ctx.fillStyle = '#a78bfa';
      rrect(ctx, 18, y - 10, 15, 11, 2.5);
      ctx.fill();
    } else {
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1.3;
      ctx.strokeRect(20, y - 11, 11, 13);
    }
    const label = e.name.replace(/\/$/, '').split('/').slice(-2).join('/');
    const szStr = !e.isDir && e.size > 0 ? fmtBytes(e.size) : '';
    ctx.font = `600 13.5px ${fontStack()}`;
    const szW = szStr ? ctx.measureText(szStr).width + 14 : 0;
    ctx.fillStyle = '#1e293b';
    ctx.fillText(fitText(ctx, label, W - 62 - szW), 42, y);
    if (szStr) {
      ctx.font = `500 11.5px ${fontStack()}`;
      ctx.fillStyle = '#64748b';
      ctx.fillText(szStr, W - 18 - ctx.measureText(szStr).width, y);
    }
    y += 29;
  }
  if (entries.length > shown.length) {
    ctx.font = `600 11.5px ${fontStack()}`;
    ctx.fillStyle = '#6d28d9';
    ctx.fillText(`+ ${entries.length - shown.length} more items`, 42, H - 18);
  }
  return encodeCanvas(canvas, W, H);
}

/* ───────────────────────── audio: cover art, duration, waveform ───────────────────────── */

function parseId3v2(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
  const ver = bytes[3];
  if (ver !== 3 && ver !== 4) return null;
  const synchsafe = (o) => ((bytes[o] & 0x7f) << 21) | ((bytes[o + 1] & 0x7f) << 14) | ((bytes[o + 2] & 0x7f) << 7) | (bytes[o + 3] & 0x7f);
  const u32 = (o) => ((bytes[o] << 24) >>> 0) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
  const tagEnd = Math.min(bytes.length, 10 + synchsafe(6));
  const out = { title: '', artist: '', cover: null };
  let off = 10;

  const decodeText = (slice) => {
    if (!slice.length) return '';
    const enc = slice[0];
    const body = slice.subarray(1);
    const name = enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : 'utf-8';
    try { return new TextDecoder(name, { fatal: false }).decode(body).replace(/\0+$/, '').trim(); } catch { return ''; }
  };

  while (off + 10 <= tagEnd) {
    const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = ver === 4 ? synchsafe(off + 4) : u32(off + 4);
    if (fsize <= 0 || off + 10 + fsize > tagEnd) break;
    const payload = bytes.subarray(off + 10, off + 10 + fsize);
    if (id === 'TIT2') out.title = decodeText(payload);
    else if (id === 'TPE1') out.artist = decodeText(payload);
    else if (id === 'APIC' && payload.length > 12 && !out.cover) {
      const enc = payload[0];
      let p = 1;
      while (p < payload.length && payload[p] !== 0) p++;
      const mime = String.fromCharCode(...payload.subarray(1, p)) || 'image/jpeg';
      p += 2; // null + picture type
      if (enc === 1 || enc === 2) {
        while (p + 1 < payload.length && !(payload[p] === 0 && payload[p + 1] === 0)) p += 2;
        p += 2;
      } else {
        while (p < payload.length && payload[p] !== 0) p++;
        p += 1;
      }
      if (p < payload.length) out.cover = new Blob([payload.subarray(p)], { type: mime.includes('/') ? mime : 'image/jpeg' });
    }
    off += 10 + fsize;
  }
  return out;
}

async function probeAudioInfo(blob) {
  let duration = 0;
  const url = URL.createObjectURL(blob);
  try {
    const a = new Audio();
    a.preload = 'metadata';
    a.src = url;
    await new Promise((res) => {
      const timer = setTimeout(res, 2000);
      a.onloadedmetadata = () => { clearTimeout(timer); duration = Number.isFinite(a.duration) ? a.duration : 0; res(); };
      a.onerror = () => { clearTimeout(timer); res(); };
    });
  } catch {} finally {
    URL.revokeObjectURL(url);
  }

  let peaks = null;
  if (blob.size <= 6 * 1024 * 1024 && typeof OfflineAudioContext !== 'undefined') {
    try {
      const ctx = new OfflineAudioContext(1, 44100, 44100);
      const buf = await Promise.race([
        ctx.decodeAudioData(await blob.arrayBuffer()),
        new Promise((_, rej) => setTimeout(() => rej(new Error('dec-timeout')), 1500))
      ]);
      const data = buf.getChannelData(0);
      const bars = 34;
      const step = Math.max(1, Math.floor(data.length / bars));
      const raw = [];
      let peakMax = 0.01;
      for (let i = 0; i < bars; i++) {
        let sum = 0, cnt = 0;
        const start = i * step;
        const stride = Math.max(1, Math.floor(step / 64));
        for (let j = start; j < Math.min(data.length, start + step); j += stride) {
          sum += Math.abs(data[j]);
          cnt++;
        }
        const v = cnt ? sum / cnt : 0;
        if (v > peakMax) peakMax = v;
        raw.push(v);
      }
      peaks = raw.map((v) => Math.max(0.12, Math.min(1, v / peakMax)));
    } catch {}
  }
  return { duration, peaks };
}

async function renderAudioThumb(blob, meta) {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 768 * 1024)).arrayBuffer());
  const id3 = parseId3v2(head);
  if (id3 && id3.cover) {
    try {
      const img = await imgFromBlob(id3.cover, 2000);
      const out = drawImageFitted(img, img.naturalWidth, img.naturalHeight, { bg: '#ffffff' });
      if (out) return out;
    } catch {}
  }

  const { duration, peaks } = await probeAudioInfo(blob);
  const W = 420, H = 420;
  const { canvas, ctx } = makeCanvas(W, H, '#fffbeb');
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#fef3c7');
  grad.addColorStop(1, '#fffbeb');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#d97706';
  ctx.fillRect(0, 0, W, 6);

  // Title & Artist
  const title = (id3 && id3.title) || meta.name.replace(/\.[^.]+$/, '');
  const sub = (id3 && id3.artist) || fmtBytes(meta.size);
  ctx.font = `700 20px ${fontStack()}`;
  ctx.fillStyle = '#451a03';
  const tLines = wrapLines(ctx, title, W - 56, 2);
  let y = 58;
  for (const ln of tLines) {
    ctx.fillText(ln, 28, y);
    y += 26;
  }
  ctx.font = `600 14px ${fontStack()}`;
  ctx.fillStyle = '#92400e';
  ctx.fillText(fitText(ctx, sub, W - 56), 28, y + 6);

  // Waveform bars across center-bottom
  const bars = peaks || Array.from({ length: 34 }, (_, i) => {
    const seed = (meta.size + i * 37 + (meta.name.charCodeAt(i % meta.name.length) || 41)) % 100;
    const env = Math.sin(((i + 0.5) / 34) * Math.PI);
    return Math.max(0.16, Math.min(1, (0.28 + 0.72 * (seed / 100)) * (0.45 + 0.55 * env)));
  });
  const baseY = 266;
  const maxBarH = 112;
  const bw = 6.5, gap = 4.2;
  const startX = (W - (bars.length * (bw + gap) - gap)) / 2;
  for (let i = 0; i < bars.length; i++) {
    const bh = Math.max(10, Math.round(bars[i] * maxBarH));
    ctx.fillStyle = i % 3 === 0 ? '#b45309' : '#d97706';
    rrect(ctx, startX + i * (bw + gap), baseY - bh / 2, bw, bh, 3.2);
    ctx.fill();
  }

  // Duration footer
  if (duration > 0) {
    const m = Math.floor(duration / 60);
    const s = String(Math.floor(duration % 60)).padStart(2, '0');
    ctx.font = `700 15px ${fontStack()}`;
    ctx.fillStyle = '#78350f';
    ctx.fillText(`${m}:${s}`, 28, H - 36);
  }
  return encodeCanvas(canvas, W, H);
}

/* ───────────────────────── fonts & generic/other sniff ───────────────────────── */

async function renderFontThumb(blob, meta) {
  if (typeof FontFace !== 'function' || blob.size > 10 * 1024 * 1024) return null;
  const fam = 'spFontPrev_' + Math.random().toString(36).slice(2, 8);
  let face;
  try {
    face = new FontFace(fam, await blob.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    const W = 420, H = 420;
    const { canvas, ctx } = makeCanvas(W, H, '#ffffff');
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(0, 0, W, 44);
    ctx.font = `600 13px ${fontStack()}`;
    ctx.fillStyle = '#334155';
    ctx.fillText(fitText(ctx, meta.name, W - 36), 18, 27);

    ctx.fillStyle = '#0f172a';
    ctx.font = `400 76px "${fam}", serif`;
    ctx.fillText('Aa Bb', 24, 150);
    ctx.font = `400 28px "${fam}", serif`;
    ctx.fillText('The quick brown fox', 24, 214);
    ctx.fillText('jumps over 0123456789', 24, 254);
    ctx.fillStyle = '#475569';
    ctx.font = `400 20px "${fam}", serif`;
    ctx.fillText('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 24, 314);
    ctx.fillText('abcdefghijklmnopqrstuvwxyz', 24, 346);
    return encodeCanvas(canvas, W, H);
  } catch {
    return null;
  } finally {
    if (face && document.fonts) document.fonts.delete(face);
  }
}

function isProbablyUtf8Text(bytes) {
  if (!bytes || !bytes.length) return false;
  let bad = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) return false;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) bad++;
  }
  return bad / bytes.length < 0.03;
}

const MAGIC_DESCS = [
  ['SQLite format 3', 'SQLite Database', '#0f766e', '#ccfbf1'],
  ['8BPS', 'Photoshop Document', '#1d4ed8', '#dbeafe'],
  ['Rar!', 'RAR Archive', '#6d28d9', '#ede9fe'],
  ['7z\xbc\xaf\x27\x1c', '7-Zip Archive', '#6d28d9', '#ede9fe'],
  ['\x1f\x8b', 'GZIP Archive', '#6d28d9', '#ede9fe'],
  ['BZh', 'BZIP2 Archive', '#6d28d9', '#ede9fe'],
  ['\xfd7zXZ', 'XZ Archive', '#6d28d9', '#ede9fe'],
  ['MZ', 'Windows Application', '#475569', '#f1f5f9'],
  ['\x7fELF', 'Linux ELF Binary', '#475569', '#f1f5f9'],
  ['OggS', 'Ogg Media Container', '#b45309', '#fef3c7'],
  ['fLaC', 'FLAC Lossless Audio', '#b45309', '#fef3c7'],
  ['\x1aE\xdf\xa3', 'Matroska / WebM Media', '#be185d', '#fce7f3']
];

async function renderOtherOrBinaryThumb(blob, meta) {
  if (blob) {
    if (/^(ttf|otf|woff2?)$/i.test(meta.ext)) {
      const ft = await renderFontThumb(blob, meta);
      if (ft) return ft;
    }
    const sample = new Uint8Array(await blob.slice(0, Math.min(blob.size, 8192)).arrayBuffer());
    const latin = String.fromCharCode(...sample.subarray(0, 64));

    if (latin.startsWith('%PDF-')) {
      const pdfRes = await renderPdfThumb(blob);
      if (pdfRes && !pdfRes.failed) return pdfRes;
    }
    if (latin.startsWith('{\\rtf')) {
      const rtfText = stripRtf(await blob.slice(0, 24576).text());
      if (rtfText) return renderTextPageThumb(rtfText, meta);
    }

    if (isProbablyUtf8Text(sample)) {
      const txt = new TextDecoder('utf-8', { fatal: false }).decode(sample);
      const t = txt.trimStart();
      if (/^(<!doctype html|<html|<svg|<\?xml|\{|\[)/i.test(t) || /=/.test(t.split('\n')[0])) {
        return renderCodeThumb(txt, meta.ext || 'txt', meta);
      }
      return renderTextPageThumb(txt, meta, { kind: fileKind(meta.type, meta.name) });
    }

    let magicInfo = null;
    for (const [sig, label] of MAGIC_DESCS) {
      if (latin.startsWith(sig)) { magicInfo = label; break; }
    }
    const hexRows = [];
    for (let i = 0; i < Math.min(48, sample.length); i += 8) {
      const chunk = sample.subarray(i, i + 8);
      const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const asc = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      hexRows.push({ text: `${i.toString(16).padStart(4, '0')}  ${hex.padEnd(23, ' ')}  ${asc}`, mono: true, muted: true });
    }
    return renderCardThumb({
      kind: fileKind(meta.type, meta.name),
      ext: meta.ext || 'FILE',
      name: meta.name,
      size: meta.size,
      subtitle: magicInfo || friendlyExtLabel(meta.ext, meta.type),
      rows: hexRows
    });
  }

  return renderCardThumb({
    kind: fileKind(meta.type, meta.name),
    ext: meta.ext || 'FILE',
    name: meta.name,
    size: meta.size,
    subtitle: friendlyExtLabel(meta.ext, meta.type)
  });
}

function friendlyExtLabel(ext, type) {
  const map = {
    rar: 'RAR Archive', '7z': '7-Zip Archive', gz: 'GZIP Archive', tgz: 'Compressed Archive',
    bz2: 'BZIP2 Archive', xz: 'XZ Archive', dmg: 'macOS Disk Image', iso: 'Disc Image',
    exe: 'Windows Executable', msi: 'Windows Installer', psd: 'Photoshop Document',
    ai: 'Illustrator Artwork', fig: 'Figma Design', sketch: 'Sketch Design',
    ttf: 'TrueType Font', otf: 'OpenType Font', woff: 'Web Font', woff2: 'Web Font',
    sqlite: 'SQLite Database', db: 'Database File', doc: 'Word Document', xls: 'Excel Workbook'
  };
  if (map[ext]) return map[ext];
  if (type) return type.split('/').pop().slice(0, 24).toUpperCase();
  return ext ? `${ext.toUpperCase()} File` : 'Binary File';
}

/* ───────────────────────── main entry point ───────────────────────── */

/**
 * Generates `{ thumb, w, h }` for ANY file type (`Blob | File | Uint8Array | ArrayBuffer | null`).
 * Never throws; falls back cleanly to stylized preview cards when codecs/decoders reject.
 */
export async function makeFileThumb(input, metaIn = {}) {
  const blob = input instanceof Blob ? input
    : (input instanceof Uint8Array || input instanceof ArrayBuffer) ? new Blob([input], { type: metaIn.type || '' })
    : null;
  const name = metaIn.name || (blob && blob.name) || 'File';
  const type = (metaIn.type || (blob && blob.type) || '').toLowerCase();
  const size = metaIn.size != null ? metaIn.size : (blob ? blob.size : 0);
  const ext = extOf(name);
  const meta = { name, type, size, ext };
  const kind = fileKind(type, name);

  if (!blob) {
    return renderOtherOrBinaryThumb(null, meta);
  }

  try {
    if (kind === 'image') return await renderImageThumb(blob, meta);
    if (kind === 'video') return await renderVideoThumb(blob, meta);

    if (kind === 'pdf') {
      const pdfRes = blob.size < 60 * 1024 * 1024 ? await renderPdfThumb(blob) : null;
      if (pdfRes && !pdfRes.failed) return pdfRes;
      return renderCardThumb({ kind: 'pdf', ext: 'PDF', name, size, subtitle: (pdfRes && pdfRes.error) || 'PDF Document' });
    }

    if (kind === 'doc') {
      if (ext === 'epub' || type.includes('epub')) {
        if (blob.size <= 40 * 1024 * 1024) return await renderEpubThumb(blob, meta);
      } else if (/^(docx|docm|dotx)$/.test(ext)) {
        if (blob.size <= 40 * 1024 * 1024) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          return await renderDocxThumb(bytes, meta);
        }
      } else if (ext === 'odt') {
        if (blob.size <= 40 * 1024 * 1024) {
          const odtImg = await extractZipThumbImage(bytesOrNull(blob), ['Thumbnails/thumbnail.png']);
          if (odtImg) return odtImg;
          const odtText = await extractOdfText(blob);
          if (odtText) return renderTextPageThumb(odtText, meta);
        }
      } else if (ext === 'pages') {
        if (blob.size <= 40 * 1024 * 1024) {
          const pgImg = await extractZipThumbImage(bytesOrNull(blob), ['QuickLook/Thumbnail.jpg', 'preview.jpg']);
          if (pgImg) return pgImg;
        }
      } else if (ext === 'rtf') {
        const raw = await blob.slice(0, 24576).text();
        const plain = stripRtf(raw);
        if (plain) return renderTextPageThumb(plain, meta);
      } else if (ext === 'doc') {
        const bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, 98304)).arrayBuffer());
        const docText = extractLegacyDocText(bytes);
        if (docText && docText.length > 20) return renderTextPageThumb(docText, meta);
      } else if (/^(md|markdown)$/.test(ext)) {
        const txt = await blob.slice(0, 16384).text();
        return renderMarkdownThumb(txt, meta);
      } else {
        const sample = new Uint8Array(await blob.slice(0, Math.min(blob.size, 16384)).arrayBuffer());
        if (isProbablyUtf8Text(sample)) {
          const txt = new TextDecoder('utf-8', { fatal: false }).decode(sample);
          return renderTextPageThumb(txt, meta);
        }
      }
      return renderCardThumb({ kind: 'doc', ext: ext || 'DOC', name, size, subtitle: friendlyExtLabel(ext, type) });
    }

    if (kind === 'sheet') {
      if (blob.size <= 40 * 1024 * 1024 || ext === 'csv' || ext === 'tsv') {
        return await renderSheetThumb(blob, meta);
      }
      return renderCardThumb({ kind: 'sheet', ext: ext || 'XLS', name, size, subtitle: 'Spreadsheet' });
    }

    if (kind === 'slides') {
      if (blob.size <= 45 * 1024 * 1024) return await renderSlidesThumb(blob, meta);
      return renderCardThumb({ kind: 'slides', ext: ext || 'PPT', name, size, subtitle: 'Presentation' });
    }

    if (kind === 'code') {
      const sample = await blob.slice(0, 32768).text();
      if (ext === 'html' || ext === 'htm') return renderHtmlThumb(sample, meta);
      return renderCodeThumb(sample, ext, meta);
    }

    if (kind === 'audio') {
      return await renderAudioThumb(blob, meta);
    }

    if (kind === 'archive') {
      const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 512)).arrayBuffer());
      const isZip = /^(zip|jar|apk|ipa|cbz|xpi)$/.test(ext) || (head[0] === 0x50 && head[1] === 0x4b);
      if (isZip) {
        const info = await listZipEntries(blob).catch(() => null);
        if (info && info.entries.length) return renderArchiveListThumb(info, meta);
      }
      const isTar = ext === 'tar' || (head.length > 262 && String.fromCharCode(...head.subarray(257, 262)) === 'ustar');
      if (isTar) {
        const info = await listTarEntries(blob).catch(() => null);
        if (info && info.entries.length) return renderArchiveListThumb(info, meta);
      }
      return renderOtherOrBinaryThumb(blob, meta);
    }

    return await renderOtherOrBinaryThumb(blob, meta);
  } catch (err) {
    console.warn('makeFileThumb fallback for', name, err);
    return renderCardThumb({ kind, ext: ext || 'FILE', name, size, subtitle: friendlyExtLabel(ext, type) });
  }
}
