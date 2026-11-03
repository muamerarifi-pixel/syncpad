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
  const rawBytes = new Uint8Array(await blob.arrayBuffer());
  const task = lib.getDocument({ data: rawBytes, isEvalSupported: false, useWasm: false, standardFontDataUrl: V + 'standard_fonts/', verbosity: 0 });
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
    const hlLayer = document.createElement('div');
    hlLayer.className = 'dv-highlights';
    el.append(hlLayer);
    wrap.append(el);
    pages.push({
      page,
      el,
      hlLayer,
      num: i,
      w: vp1.width,
      h: vp1.height,
      rendered: 0,
      scale: 1,
      highlights: [],
      renderTask: null,
      busy: false,
      visible: false
    });
  }

  const renderHighlights = (p) => {
    p.hlLayer.innerHTML = '';
    const pw = p.el.offsetWidth;
    const ph = p.el.offsetHeight;
    if (!pw || !ph) return;
    p.highlights.forEach((h, idx) => {
      const el = document.createElement('div');
      el.className = 'dv-hl';
      el.style.left = (h.x * pw) + 'px';
      el.style.top = (h.y * ph) + 'px';
      el.style.width = (h.w * pw) + 'px';
      el.style.height = (h.h * ph) + 'px';
      el.style.setProperty('--hl-c', h.color || 'rgba(254, 240, 138, 0.48)');
      el.title = 'Click to remove highlight';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        p.highlights.splice(idx, 1);
        renderHighlights(p);
      });
      p.hlLayer.append(el);
    });
  };

  const size = () => {
    for (const p of pages) {
      const s = (baseWidth() / p.w) * z;
      p.scale = s;
      p.el.style.width = Math.floor(p.w * s) + 'px';
      p.el.style.height = Math.floor(p.h * s) + 'px';
      renderHighlights(p);
    }
  };

  const render = async (p) => {
    const s = p.scale;
    if (p.rendered === s && p.el.querySelector('canvas')) return;
    p.pendingScale = s;
    if (p.renderTask) {
      try { p.renderTask.cancel(); } catch {}
      return;
    }
    if (p.busy) return;
    p.busy = true;
    p.pendingScale = null;
    try {
      const vp = p.page.getViewport({ scale: s });
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const ctx = canvas.getContext('2d');
      const renderContext = {
        canvasContext: ctx,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
      };
      p.renderTask = p.page.render(renderContext);
      await p.renderTask.promise;
      p.renderTask = null;

      const text = document.createElement('div');
      text.className = 'textLayer';
      text.style.setProperty('--scale-factor', String(s));
      text.style.setProperty('--total-scale-factor', String(s));
      p.el.replaceChildren(canvas, p.hlLayer, text);
      renderHighlights(p);
      try { await new lib.TextLayer({ textContentSource: p.page.streamTextContent(), container: text, viewport: vp }).render(); } catch {}
      p.rendered = s;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') {
        // cancellation is normal when zooming
      }
    } finally {
      p.busy = false;
      p.renderTask = null;
      if (p.visible && (p.pendingScale != null || p.rendered !== p.scale)) {
        render(p);
      }
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

  let zoomTimer = 0;
  const rezoom = (nz) => {
    const anchor = wrap.scrollTop / Math.max(1, wrap.scrollHeight);
    z = Math.max(0.5, Math.min(6, nz));
    size();
    wrap.scrollTop = anchor * wrap.scrollHeight;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      pages.forEach((p) => { if (p.visible) render(p); });
    }, 40);
    label();
  };

  wrap.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      rezoom(z * Math.exp(-e.deltaY * 0.01));
    }
  }, { passive: false });

  // Touch Pinch-to-zoom for PDF viewer
  const touches = new Map();
  let pinchStartDist = 0;
  let pinchStartZ = 1;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        const pts = [...touches.values()];
        pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pinchStartZ = z;
      }
    }
  });
  wrap.addEventListener('pointermove', (e) => {
    if (touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2 && pinchStartDist > 10) {
        const pts = [...touches.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        rezoom(pinchStartZ * (dist / pinchStartDist));
      }
    }
  });
  const onPointerUp = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchStartDist = 0;
  };
  wrap.addEventListener('pointerup', onPointerUp);
  wrap.addEventListener('pointercancel', onPointerUp);

  /* ──────── Text Highlighting Toolbar ──────── */
  let popEl = null;
  const hidePop = () => { if (popEl) { popEl.remove(); popEl = null; } };

  const checkSelection = () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hidePop(); return; }
    const text = sel.toString().trim();
    if (!text) { hidePop(); return; }
    const range = sel.getRangeAt(0);
    const rects = [...range.getClientRects()];
    if (!rects.length) { hidePop(); return; }
    if (!wrap.contains(range.commonAncestorContainer)) { hidePop(); return; }

    const firstRect = rects[0];
    if (!popEl) {
      popEl = document.createElement('div');
      popEl.className = 'dv-hl-pop';
      popEl.innerHTML = `
        <button class="dv-hl-btn" title="Highlight selection"><svg class="ic" viewBox="0 0 24 24"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg><span>Highlight</span></button>
        <div class="dv-hl-colors">
          <button class="dv-hl-swatch" data-c="rgba(254, 240, 138, 0.5)" style="background:#fde047" title="Yellow" aria-label="Yellow"></button>
          <button class="dv-hl-swatch" data-c="rgba(134, 239, 172, 0.5)" style="background:#86efac" title="Green" aria-label="Green"></button>
          <button class="dv-hl-swatch" data-c="rgba(244, 114, 182, 0.5)" style="background:#f472b6" title="Pink" aria-label="Pink"></button>
          <button class="dv-hl-swatch" data-c="rgba(103, 232, 249, 0.5)" style="background:#67e8f9" title="Cyan" aria-label="Cyan"></button>
        </div>`;
      document.body.append(popEl);

      const applyHl = (color) => {
        const curSel = document.getSelection();
        if (!curSel || curSel.isCollapsed || !curSel.rangeCount) { hidePop(); return; }
        const r = curSel.getRangeAt(0);
        const rRects = [...r.getClientRects()];
        for (const p of pages) {
          const pRect = p.el.getBoundingClientRect();
          const pageRects = rRects.filter((cr) =>
            cr.top < pRect.bottom && cr.bottom > pRect.top &&
            cr.left < pRect.right && cr.right > pRect.left
          );
          if (pageRects.length) {
            for (const cr of pageRects) {
              if (cr.width < 1 || cr.height < 1) continue;
              const x = Math.max(0, (cr.left - pRect.left) / pRect.width);
              const y = Math.max(0, (cr.top - pRect.top) / pRect.height);
              const w = Math.min(1 - x, cr.width / pRect.width);
              const h = Math.min(1 - y, cr.height / pRect.height);
              if (w > 0 && h > 0) {
                p.highlights.push({ x, y, w, h, color });
              }
            }
            renderHighlights(p);
          }
        }
        curSel.removeAllRanges();
        hidePop();
      };

      popEl.querySelector('.dv-hl-btn').addEventListener('click', () => applyHl('rgba(254, 240, 138, 0.5)'));
      popEl.querySelector('.dv-hl-colors').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-c]');
        if (b) applyHl(b.dataset.c);
      });
    }

    const cx = Math.max(100, Math.min(window.innerWidth - 100, firstRect.left + firstRect.width / 2));
    const isNearTop = firstRect.top < 65;
    popEl.style.left = cx + 'px';
    popEl.style.top = (isNearTop ? firstRect.bottom + 8 : firstRect.top) + 'px';
    popEl.classList.toggle('dv-hl-below', isNearTop);
  };

  wrap.addEventListener('pointerup', () => setTimeout(checkSelection, 30));
  wrap.addEventListener('touchend', () => setTimeout(checkSelection, 50));
  wrap.addEventListener('scroll', () => { if (popEl) checkSelection(); }, { passive: true });
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) hidePop();
  });

  const onResize = () => rezoom(z);
  addEventListener('resize', onResize);

  return {
    source,
    pages: pdf.numPages,
    zoomBy(f) { rezoom(z * f); },
    fit() { rezoom(1); },
    destroy() {
      hidePop();
      io.disconnect();
      removeEventListener('resize', onResize);
      pages.forEach((p) => { if (p.renderTask) { try { p.renderTask.cancel(); } catch {} } });
      task.destroy().catch(() => {});
    }
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
