// Save notes as an A4 PDF that looks like the note: same fonts, colours, pictures (side by side,
// wrapped text), checklists and paper. Pages break between paragraphs, never through a line of text.
// Very long notes are drawn one page at a time, so hundreds of pages work too.

const PAGE_W = 794;              // A4 at 96 dpi
const PAGE_H = 1123;
const M = 64;                    // margins
const SCALE = 2;                 // drawing resolution
const FONTS = {
  '': ["'Outfit',system-ui,sans-serif", '/vendor/fonts/outfit-latin-wght-normal.woff2', 'Outfit'],
  outfit: ["'Outfit',system-ui,sans-serif", '/vendor/fonts/outfit-latin-wght-normal.woff2', 'Outfit'],
  lora: ["'Lora',Georgia,serif", '/vendor/fonts/lora-latin-wght-normal.woff2', 'Lora'],
  caveat: ["'Caveat',cursive", '/vendor/fonts/caveat-latin-wght-normal.woff2', 'Caveat'],
  system: ["system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif", null, null]
};
// paper: [background, ink, rule colour, pattern]
const PAPERS = {
  '': ['#ffffff', '#16181d', '', ''],
  smooth: ['#ffffff', '#16181d', '', ''],
  sepia: ['#f4ecd8', '#3b2f20', '', ''],
  'sepia-lined': ['#f4ecd8', '#3b2f20', 'rgba(120,90,50,.28)', 'lined'],
  lined: ['#fdfdfb', '#1d2433', 'rgba(70,110,170,.25)', 'lined'],
  grid: ['#fcfcfa', '#1d2433', 'rgba(70,110,170,.16)', 'grid'],
  dots: ['#fcfbf8', '#1d2433', 'rgba(60,70,90,.32)', 'dots'],
  recycled: ['#e9e3d6', '#2f2a22', '', ''],
  kraft: ['#d9c4a0', '#2b2116', '', ''],
  linen: ['#f2eee6', '#24221e', '', ''],
  mint: ['#eaf6ef', '#16302a', '', ''],
  night: ['#1c1f26', '#e6e8ec', '', '']
};

const CSS = (font, ink, rule) => `
*{box-sizing:border-box}
.np{font:16px/1.65 ${font};color:${ink};overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}
.np>:first-child{margin-top:0}
.np p,.np div{margin:0 0 .35em}
.np h1,.np h2,.np h3{line-height:1.25;letter-spacing:-.015em;margin:.9em 0 .35em}
.np h1{font-size:1.75em}.np h2{font-size:1.4em}.np h3{font-size:1.15em}
.np ul,.np ol{padding-left:1.5em;margin:.2em 0 .6em}.np li{margin:.15em 0}
.np ul[data-checklist]{list-style:none;padding-left:2px}
.np ul[data-checklist]>li{position:relative;padding-left:30px}
.np ul[data-checklist]>li::before{content:"";position:absolute;left:2px;top:.25em;width:18px;height:18px;border-radius:5px;border:2px solid #9aa1ab;box-sizing:border-box}
.np ul[data-checklist]>li[data-checked="true"]::before{border-color:#0b8a57;background:#0b8a57}
.np ul[data-checklist]>li[data-checked="true"]{text-decoration:line-through;opacity:.6}
.np blockquote{border-left:3px solid #0b8a57;padding:2px 14px;margin:0 0 .6em;opacity:.85}
.np code{font:.88em ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,.06);padding:.1em .35em;border-radius:5px}
.np pre{background:rgba(0,0,0,.05);padding:12px 14px;border-radius:10px;white-space:pre-wrap}
.np table{border-collapse:collapse;margin:.3em 0 .8em;font-size:.95em}
.np th,.np td{border:1px solid ${rule || 'rgba(0,0,0,.18)'};padding:5px 9px;text-align:left;vertical-align:top}
.np img{max-width:100%;border-radius:10px;display:block;margin:8px 0;height:auto}
.np img[data-align="left"]{float:left;margin:4px 18px 10px 0}
.np img[data-align="right"]{float:right;margin:4px 0 10px 18px}
.np img[data-align="center"]{margin-left:auto;margin-right:auto}
.np img[data-align="full"]{width:100%}
.np img[data-align="inline"]{display:inline-block;vertical-align:middle;margin:2px 6px}
.np img[data-align="side"]{display:inline-block;vertical-align:top;margin:6px 2% 6px 0}
.np img[data-align="side"]:last-child{margin-right:0}
.np a{color:#087a4c}.np a.file-chip{display:inline-block;padding:1px 8px;border-radius:6px;background:rgba(0,0,0,.06);color:inherit;text-decoration:none}
.np a.link-card{display:block;max-width:460px;margin:6px 0 10px;padding:8px 12px;border:1px solid rgba(0,0,0,.15);border-radius:10px;color:inherit;text-decoration:none}
.np a.link-card .lc-img{float:left;width:48px;height:48px;object-fit:cover;margin:0 10px 0 0;border-radius:6px}
.np a.link-card .lc-d{font-size:.8em;opacity:.7}
.np hr{border:0;border-top:1px solid ${rule || 'rgba(0,0,0,.18)'};margin:1.4em 0}
.np mark{border-radius:3px;padding:0 2px}
.np font[size="1"]{font-size:10px}.np font[size="2"]{font-size:13px}.np font[size="4"]{font-size:18px}.np font[size="5"]{font-size:24px}.np font[size="6"]{font-size:32px}.np font[size="7"]{font-size:48px}
.np::after{content:"";display:block;clear:both}`;

const fontCache = {};
async function fontFace(key) {
  const f = FONTS[key] || FONTS[''];
  if (!f[1]) return '';
  if (!fontCache[key]) {
    const buf = new Uint8Array(await (await fetch(f[1])).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    fontCache[key] = `@font-face{font-family:'${f[2]}';src:url(data:font/woff2;base64,${btoa(s)}) format('woff2');font-weight:100 900}`;
  }
  return fontCache[key];
}

function patternCss(kind, rule, off = 0) {
  const LH = 16 * 1.65;
  if (kind === 'lined') return `background-image:repeating-linear-gradient(to bottom,transparent 0,transparent ${LH - 1}px,${rule} ${LH - 1}px,${rule} ${LH}px);background-position:0 ${M - (off % LH)}px`;
  if (kind === 'grid') return `background-image:linear-gradient(${rule} 1px,transparent 1px),linear-gradient(90deg,${rule} 1px,transparent 1px);background-size:24px 24px`;
  if (kind === 'dots') return `background-image:radial-gradient(${rule} 1.1px,transparent 1.4px);background-size:22px 22px`;
  return '';
}

/** picture → data: URL (scaled down so a PDF with many photos stays a sensible size) */
async function inlineImage(src) {
  try {
    const im = new Image();
    im.decoding = 'async';
    im.src = src;
    await im.decode();
    const k = Math.min(1, 1500 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(im.naturalWidth * k));
    c.height = Math.max(1, Math.round(im.naturalHeight * k));
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    // keep transparency for PNG-like pictures, JPEG (smaller) for photos
    const alpha = /\.(png|gif|webp)$|image\/(png|gif|webp)/i.test(src) || c.width * c.height < 250_000;
    return c.toDataURL(alpha ? 'image/png' : 'image/jpeg', 0.88);
  } catch { return null; }
}

const xhtml = (html) => new XMLSerializer().serializeToString(Object.assign(document.createElement('div'), { innerHTML: html })).replace(/^<div[^>]*>|<\/div>$/g, '');
const asImage = (svg) => new Promise((resolve, reject) => {
  const im = new Image();
  im.onload = () => resolve(im);
  im.onerror = () => reject(new Error('Could not draw this page'));
  im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
});

/**
 * docs: [{ html, font, paper, color }]  →  PDF Blob (A4)
 * fileUrl(id) gives a URL for a picture stored in SyncPad.
 */
export async function notesPdf(docs, { fileUrl, onProgress } = {}) {
  const L = await import('/vendor/pdf/pdf-lib.esm.min.js');
  const pdf = await L.PDFDocument.create();
  for (const d of docs) {
    const fk = FONTS[d.font] ? d.font : '';
    const [bg, ink, rule, pat] = PAPERS[d.paper] || PAPERS[''];
    const base = CSS(FONTS[fk][0], ink, rule);
    const css = (await fontFace(fk)) + base; // the page images carry their own font; the app already has it loaded
    // pictures inside the note become part of the page
    const host = document.createElement('div');
    host.innerHTML = d.html || '';
    for (const im of host.querySelectorAll('img')) {
      const id = im.getAttribute('data-file');
      const src = id ? fileUrl(id) : im.getAttribute('src');
      const data = src ? await inlineImage(src) : null;
      if (data) im.setAttribute('src', data); else im.remove();
      im.removeAttribute('loading');
    }
    for (const a of host.querySelectorAll('a')) a.removeAttribute('contenteditable');
    const content = host.innerHTML;

    // measure where pages can break (between top-level blocks) using the same CSS
    const meas = document.createElement('div');
    meas.style.cssText = `position:fixed;left:-20000px;top:0;width:${PAGE_W - 2 * M}px;visibility:hidden;pointer-events:none`;
    meas.innerHTML = `<style>${base}</style><div class="np">${content}</div>`;
    document.body.append(meas);
    await document.fonts.ready;
    await Promise.all([...meas.querySelectorAll('img')].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
    const np = meas.querySelector('.np');
    const total = Math.max(1, np.scrollHeight);
    const avail = PAGE_H - 2 * M;
    const top0 = np.getBoundingClientRect().top;
    // places a page may end: above any paragraph, list item, heading, table row or picture (not floated ones)
    const cuts = [];
    for (const b of np.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr, hr, table, img, ul, ol')) {
      if (b.closest('[data-align="left"], [data-align="right"]') || getComputedStyle(b).float !== 'none') continue;
      const r = b.getBoundingClientRect();
      if (r.height) cuts.push([r.top - top0, r.bottom - top0]);
    }
    cuts.sort((x, y) => x[0] - y[0]);
    // choose page breaks: as late as possible, at the top of a block that would not fit
    const breaks = [0];
    let start = 0;
    while (start + avail < total) {
      let cut = start + avail;
      for (const [t] of cuts) if (t > start + 40 && t <= start + avail) cut = t;
      if (cut <= start) cut = start + avail;
      breaks.push(cut);
      start = cut;
    }
    meas.remove();

    for (let i = 0; i < breaks.length; i++) {
      const off = breaks[i];
      const pageBg = `background-color:${bg};${patternCss(pat, rule, off)}`;
      const h = Math.min(avail, (breaks[i + 1] ?? total) - off);
      const page = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${PAGE_W}px;height:${PAGE_H}px;${pageBg};position:relative;overflow:hidden">` +
        `<style>${css}</style>` +
        (d.color ? `<div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${d.color}"></div>` : '') +
        `<div style="position:absolute;left:${M}px;top:${M}px;width:${PAGE_W - 2 * M}px;height:${h + 2}px;overflow:hidden">` +
        `<div class="np" style="margin-top:${-off}px">${xhtml(content)}</div></div>` +
        (breaks.length > 1 ? `<div style="position:absolute;bottom:26px;left:0;right:0;text-align:center;font:11px system-ui,sans-serif;color:${ink};opacity:.45">${i + 1} / ${breaks.length}</div>` : '') +
        '</div>';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}"><foreignObject x="0" y="0" width="${PAGE_W}" height="${PAGE_H}">${page}</foreignObject></svg>`;
      const im = await asImage(svg);
      const c = document.createElement('canvas');
      c.width = PAGE_W * SCALE;
      c.height = PAGE_H * SCALE;
      const g = c.getContext('2d');
      g.fillStyle = bg;
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(im, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      const jpg = await pdf.embedJpg(await blob.arrayBuffer());
      const pg = pdf.addPage([595.28, 841.89]);
      pg.drawImage(jpg, { x: 0, y: 0, width: 595.28, height: 841.89 });
      c.width = c.height = 0;
      if (onProgress) onProgress(i + 1, breaks.length);
    }
  }
  const bytes = await pdf.save();
  return new Blob([bytes], { type: 'application/pdf' });
}
