// In-app document viewer: PDF (pdf.js, selectable text), Word (.docx), spreadsheets (.xlsx/.csv),
// slides (.pptx) and plain text. No external viewers.

const V = '/vendor/pdf/';
let pdfjs = null;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(V + 'pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = V + 'pdf.worker.min.mjs';
  return pdfjs;
}
const attachmentList = (att) => (!att ? [] : att instanceof Map ? [...att].map(([id, a]) => ({ id, ...a })) : Object.entries(att).map(([id, a]) => ({ id, ...a })));
/** The editable source SyncPad puts inside the PDFs it writes (pdf.js 6 loads attachment contents on request) */
async function sourceOf(pdf) {
  const a = attachmentList(await pdf.getAttachments()).find((x) => /syncpad-document\.html$/.test(x.filename || ''));
  if (!a) return null;
  const content = a.content || (pdf.getAttachmentContent ? await pdf.getAttachmentContent(a.id) : null);
  return content ? new TextDecoder().decode(content) : null;
}
const clean = (html) => (window.DOMPurify ? window.DOMPurify.sanitize(html, { ADD_ATTR: ['style'], ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|data:image\/(?:png|jpe?g|gif|webp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i }) : html);

export function docKind(kind, name) {
  const e = (/\.(\w+)$/.exec(name || '') || [])[1]?.toLowerCase() || '';
  if (kind === 'pdf' || e === 'pdf') return 'pdf';
  if (e === 'docx' || e === 'docm' || e === 'dotx') return 'docx';
  if (e === 'xlsx' || e === 'xlsm') return 'xlsx';
  if (e === 'csv' || e === 'tsv') return 'csv';
  if (e === 'pptx') return 'pptx';
  return null;
}

/** Renders a document into `box`. Returns { zoomBy(f), fit(), destroy(), source? } */
export async function viewDocument(box, blob, { kind, onLabel = () => {} } = {}) {
  box.innerHTML = '<div class="dv-loading">Opening…</div>';
  if (kind === 'pdf') return viewPdf(box, blob, onLabel);
  const M = await import('./docmodel.js');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let z = 1;
  const wrap = document.createElement('div');
  wrap.className = 'dv-scroll';
  const inner = document.createElement('div');
  inner.className = 'dv-zoom';
  wrap.append(inner);
  if (kind === 'docx') {
    const blocks = M.readDocx(bytes);
    inner.innerHTML = `<div class="doc-page doc-view">${clean(M.modelToHtml(blocks))}</div>`;
  } else if (kind === 'xlsx' || kind === 'csv') {
    const sheets = kind === 'xlsx' ? M.readXlsx(bytes) : M.readCsv(new TextDecoder().decode(bytes));
    inner.innerHTML = (sheets.length > 1 ? `<div class="sheet-tabs">${sheets.map((s, i) => `<button data-sheet="${i}" aria-pressed="${i === 0}">${s.name.replace(/[<>&"]/g, '')}</button>`).join('')}</div>` : '')
      + sheets.map((s, i) => `<div class="xl-sheet doc-view" data-i="${i}"${i ? ' hidden' : ''}>${s.html}</div>`).join('');
    inner.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sheet]');
      if (!b) return;
      inner.querySelectorAll('[data-sheet]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      inner.querySelectorAll('.xl-sheet').forEach((x) => { x.hidden = x.dataset.i !== b.dataset.sheet; });
    });
  } else if (kind === 'pptx') {
    const slides = M.readPptx(bytes);
    inner.innerHTML = slides.map((h, i) => `<section class="slide doc-view"><span class="slide-no">${i + 1}</span>${clean(h)}</section>`).join('') || '<p class="dv-empty">No slides found.</p>';
  }
  box.replaceChildren(wrap);
  const apply = () => { inner.style.zoom = String(z); onLabel(Math.round(z * 100) + '%'); };
  onLabel('100%');
  return {
    zoomBy(f) { z = Math.max(0.5, Math.min(3, z * f)); apply(); },
    fit() { z = 1; apply(); },
    destroy() {}
  };
}

async function viewPdf(box, blob, onLabel) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = lib.getDocument({ data, isEvalSupported: false, useWasm: false, standardFontDataUrl: V + 'standard_fonts/', verbosity: 0 });
  let pdf;
  try { pdf = await task.promise; } catch (e) {
    box.innerHTML = `<div class="dv-empty">${e && e.name === 'PasswordException' ? 'This PDF is password-protected.' : 'Could not open this PDF.'}</div>`;
    return { zoomBy() {}, fit() {}, destroy() { task.destroy(); } };
  }
  // a document made in SyncPad carries its editable source
  let source = null;
  try { source = await sourceOf(pdf); } catch {}

  const wrap = document.createElement('div');
  wrap.className = 'dv-scroll dv-pdf';
  box.replaceChildren(wrap);
  const pages = [];
  let z = 1;
  const baseWidth = () => Math.min(1000, wrap.clientWidth - (wrap.clientWidth < 600 ? 12 : 40));
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const el = document.createElement('div');
    el.className = 'dv-page';
    el.dataset.n = i;
    wrap.append(el);
    pages.push({ page, el, w: vp1.width, h: vp1.height, rendered: 0 });
  }
  const size = () => {
    for (const p of pages) {
      const s = (baseWidth() / p.w) * z;
      p.scale = s;
      p.el.style.width = Math.floor(p.w * s) + 'px';
      p.el.style.height = Math.floor(p.h * s) + 'px';
    }
  };
  const render = async (p) => {
    const s = p.scale;
    if (p.rendered === s || p.busy) return;
    p.busy = true;
    try {
      const vp = p.page.getViewport({ scale: s });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      await p.page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      const text = document.createElement('div');
      text.className = 'textLayer';
      text.style.setProperty('--scale-factor', String(s));
      text.style.setProperty('--total-scale-factor', String(s));
      p.el.replaceChildren(canvas, text);
      try { await new lib.TextLayer({ textContentSource: p.page.streamTextContent(), container: text, viewport: vp }).render(); } catch {}
      p.rendered = s;
    } catch {} finally {
      p.busy = false;
      if (p.rendered !== p.scale && p.visible) render(p);
    }
  };
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const p = pages.find((x) => x.el === en.target);
      if (!p) continue;
      p.visible = en.isIntersecting;
      if (en.isIntersecting) render(p);
    }
  }, { root: wrap, rootMargin: '600px 0px' });
  size();
  pages.forEach((p) => io.observe(p.el));
  const label = () => onLabel(z === 1 ? 'Fit' : Math.round(z * 100) + '%');
  label();
  const rezoom = (nz) => {
    const anchor = wrap.scrollTop / Math.max(1, wrap.scrollHeight);
    z = Math.max(0.5, Math.min(4, nz));
    size();
    wrap.scrollTop = anchor * wrap.scrollHeight;
    pages.forEach((p) => { if (p.visible) render(p); });
    label();
  };
  wrap.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); rezoom(z * Math.exp(-e.deltaY * 0.01)); } }, { passive: false });
  const onResize = () => rezoom(z);
  addEventListener('resize', onResize);
  return {
    source,
    pages: pdf.numPages,
    zoomBy(f) { rezoom(z * f); },
    fit() { rezoom(1); },
    destroy() { io.disconnect(); removeEventListener('resize', onResize); task.destroy().catch(() => {}); }
  };
}

/** The editable source inside a PDF made with SyncPad's document editor (or null) */
export async function pdfSource(blob) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false, useWasm: false, verbosity: 0 });
  try {
    return await sourceOf(await task.promise);
  } catch { return null; } finally { task.destroy().catch(() => {}); }
}
