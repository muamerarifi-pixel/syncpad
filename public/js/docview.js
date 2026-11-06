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
export async function viewDocument(box, blob, { kind, onLabel = () => {}, page = 0, key = '' } = {}) {
  box.innerHTML = '<div class="dv-loading">Opening…</div>';
  if (kind === 'pdf') return viewPdf(box, blob, onLabel, page, key);
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

async function viewPdf(box, blob, onLabel, startPage = 0, key = '') {
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
  wrap.className = 'dv-scroll';
  const pagesBox = document.createElement('div');
  pagesBox.className = 'dv-pdf-pages';
  wrap.append(pagesBox);
  const pageNo = document.createElement('div');
  pageNo.className = 'dv-pageno';
  pageNo.hidden = pdf.numPages < 2;
  box.replaceChildren(wrap, pageNo);
  const pages = [];
  let z = 1;
  const baseWidth = () => Math.min(1000, wrap.clientWidth - (wrap.clientWidth < 600 ? 12 : 40));

  // Only the first page is read up front; every page starts with its size and is read when it comes near
  // the screen, so even a book with hundreds of pages opens at once.
  const first = await pdf.getPage(1);
  const vpf = first.getViewport({ scale: 1 });
  for (let i = 1; i <= pdf.numPages; i++) {
    const el = document.createElement('div');
    el.className = 'dv-page';
    el.dataset.n = i;
    const hlLayer = document.createElement('div');
    hlLayer.className = 'dv-highlights';
    el.append(hlLayer);
    pagesBox.append(el);
    pages.push({ page: i === 1 ? first : null, el, hlLayer, num: i, w: vpf.width, h: vpf.height, rendered: 0, scale: 1, highlights: [], renderTask: null, busy: false, visible: false, near: false });
  }

  const renderHighlights = (p) => {
    p.hlLayer.innerHTML = '';
    if (!p.highlights.length) return;
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

  const sizeOne = (p) => {
    const s = (baseWidth() / p.w) * z;
    p.scale = s;
    p.el.style.width = Math.floor(p.w * s) + 'px';
    p.el.style.height = Math.floor(p.h * s) + 'px';
  };
  const size = () => { for (const p of pages) { sizeOne(p); if (p.highlights.length) renderHighlights(p); } };

  // canvases are big: keep only the pages near the screen drawn (phones run out of memory otherwise)
  const MAX_PX = 10_000_000;
  const drawn = new Set();
  const unrender = (p) => {
    if (p.renderTask) { try { p.renderTask.cancel(); } catch {} }
    for (const c of p.el.querySelectorAll('canvas, .textLayer')) c.remove();
    p.rendered = 0;
    drawn.delete(p);
    if (p.page && p.num !== 1) { try { p.page.cleanup(); } catch {} }
  };
  const render = async (p) => {
    const s = p.scale;
    if (p.rendered === s && p.el.querySelector('canvas')) return;
    p.pendingScale = s;
    if (p.renderTask) { try { p.renderTask.cancel(); } catch {} return; }
    if (p.busy) return;
    p.busy = true;
    p.pendingScale = null;
    try {
      if (!p.page) {
        p.page = await pdf.getPage(p.num);
        const v1 = p.page.getViewport({ scale: 1 });
        if (Math.abs(v1.width - p.w) > 0.5 || Math.abs(v1.height - p.h) > 0.5) {
          // this page has its own size: keep what's on screen in place while it changes
          const before = p.el.getBoundingClientRect();
          const above = before.bottom < wrap.getBoundingClientRect().top;
          const oldH = p.el.offsetHeight;
          p.w = v1.width; p.h = v1.height;
          sizeOne(p);
          if (above) wrap.scrollTop += p.el.offsetHeight - oldH;
        }
      }
      if (!p.near) return;
      const sc = p.scale;
      const vp = p.page.getViewport({ scale: sc });
      let dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      if (vp.width * vp.height * dpr * dpr > MAX_PX) dpr = Math.max(0.5, Math.sqrt(MAX_PX / (vp.width * vp.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const ctx = canvas.getContext('2d');
      p.renderTask = p.page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await p.renderTask.promise;
      p.renderTask = null;
      if (!p.near) { canvas.width = canvas.height = 0; return; }
      const text = document.createElement('div');
      text.className = 'textLayer';
      text.style.setProperty('--scale-factor', String(sc));
      text.style.setProperty('--total-scale-factor', String(sc));
      for (const old of p.el.querySelectorAll('canvas, .textLayer')) { if (old.tagName === 'CANVAS') old.width = old.height = 0; old.remove(); }
      p.el.prepend(canvas);
      p.el.append(text);
      p.rendered = sc;
      drawn.add(p);
      renderHighlights(p);
      try { await new lib.TextLayer({ textContentSource: p.page.streamTextContent(), container: text, viewport: vp }).render(); } catch {}
      // never more than ~14 pages drawn at once
      if (drawn.size > 14) {
        const mid = currentPage();
        const far = [...drawn].filter((q) => !q.visible).sort((a, b) => Math.abs(b.num - mid) - Math.abs(a.num - mid));
        for (const q of far.slice(0, drawn.size - 14)) unrender(q);
      }
    } catch (err) {
      // cancelled while zooming: normal
    } finally {
      p.busy = false;
      p.renderTask = null;
      if (p.near && (p.pendingScale != null || p.rendered !== p.scale)) render(p);
    }
  };

  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const p = pages[Number(en.target.dataset.n) - 1];
      if (!p) continue;
      p.visible = en.isIntersecting;
      p.near = en.isIntersecting;
      if (en.isIntersecting) render(p);
    }
  }, { root: wrap, rootMargin: '800px 0px' });
  const ioFar = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const p = pages[Number(en.target.dataset.n) - 1];
      if (p && !en.isIntersecting) { p.near = false; if (p.rendered || p.renderTask) unrender(p); }
    }
  }, { root: wrap, rootMargin: '2600px 0px' });

  size();
  pages.forEach((p) => { io.observe(p.el); ioFar.observe(p.el); });
  const label = () => onLabel(Math.abs(z - 1) < 0.01 ? 'Fit' : Math.round(z * 100) + '%');
  label();

  const currentPage = () => {
    const r = wrap.getBoundingClientRect();
    const y = r.top + r.height * 0.35;
    let lo = 0; let hi = pages.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pages[m].el.getBoundingClientRect().bottom < y) lo = m + 1; else hi = m; }
    return lo + 1;
  };
  let pnT = 0;
  const showPageNo = () => {
    if (pageNo.hidden) return;
    pageNo.textContent = `${currentPage()} / ${pdf.numPages}`;
    pageNo.classList.add('on');
    clearTimeout(pnT);
    pnT = setTimeout(() => pageNo.classList.remove('on'), 1400);
  };
  wrap.addEventListener('scroll', () => requestAnimationFrame(showPageNo), { passive: true });

  /* ── where you are reading: a page and a spot on it, so zooming, resizing and reopening never lose the line ── */
  const pageAtY = (y) => pages.find((q) => { const pr = q.el.getBoundingClientRect(); return y >= pr.top - 7 && y <= pr.bottom + 7; }) || pages[currentPage() - 1];
  const spotAt = (x, y) => {
    const under = pageAtY(y);
    const pr = under.el.getBoundingClientRect();
    return { under, fx: (x - pr.left) / Math.max(1, pr.width), fy: (y - pr.top) / Math.max(1, pr.height) };
  };
  const putSpot = (sp, x, y) => {
    const r = wrap.getBoundingClientRect();
    const pr = sp.under.el.getBoundingClientRect();
    // move by the difference, so it is exact whatever the page's offset parent is
    const nx = pr.left + sp.fx * pr.width;
    const ny = pr.top + sp.fy * pr.height;
    wrap.scrollLeft += nx - x;
    wrap.scrollTop += ny - y;
    void r;
  };
  const commitZoom = (nz, sp, x, y) => {
    z = Math.max(0.5, Math.min(6, nz));
    if (Math.abs(z - 1) < 0.06) z = 1;
    size();
    putSpot(sp, x, y);
    wrap.classList.toggle('is-zoomed', z > 1.05);
    for (const p of pages) if (p.near) render(p);
    label();
    saveView();
  };
  const rezoom = (nz, at = null) => {
    const targetZ = Math.max(0.5, Math.min(6, nz));
    if (Math.abs(targetZ - z) < 0.001) return;
    const r = wrap.getBoundingClientRect();
    const ax = at ? at.clientX : r.left + r.width / 2;
    const ay = at ? at.clientY : r.top + r.height / 2;
    commitZoom(targetZ, spotAt(ax, ay), ax, ay);
  };

  /* ── live zoom preview: the pages are only scaled on the GPU while the gesture runs (silky, even with
        hundreds of pages); the real re-layout happens once, when the fingers lift or the trackpad stops ── */
  let live = null;
  const startLive = (x, y) => {
    const st = { sp: spotAt(x, y), o: pagesBox.getBoundingClientRect(), x0: x, y0: y, k: 1, x, y, z0: z };
    pagesBox.style.transformOrigin = '0 0';
    pagesBox.style.willChange = 'transform';
    return st;
  };
  const showLive = (st, k, x, y) => {
    st.k = Math.max(0.5 / st.z0, Math.min(6 / st.z0, k));
    st.x = x; st.y = y;
    const tx = x - st.o.left - st.k * (st.x0 - st.o.left);
    const ty = y - st.o.top - st.k * (st.y0 - st.o.top);
    pagesBox.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${st.k})`;
  };
  const endLive = (st) => {
    pagesBox.style.transform = '';
    pagesBox.style.willChange = '';
    commitZoom(st.z0 * st.k, st.sp, st.x, st.y);
  };

  // Trackpad pinch & Ctrl+wheel: smooth preview, committed 160 ms after the fingers stop
  let wheelT = 0;
  wrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!live) live = startLive(e.clientX, e.clientY);
    const step = Math.max(-0.25, Math.min(0.25, -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0085)));
    showLive(live, live.k * Math.exp(step), live.x0, live.y0);
    clearTimeout(wheelT);
    wheelT = setTimeout(() => { const st = live; live = null; if (st) endLive(st); }, 160);
  }, { passive: false });

  // double-click / double-tap: zoom in at that spot, or back to fit
  const toggleAt = (x, y) => { if (z > 1.1) rezoom(1, { clientX: x, clientY: y }); else rezoom(2.2, { clientX: x, clientY: y }); };
  wrap.addEventListener('dblclick', (e) => {
    if (e.target.closest('.dv-hl-pop, .dv-hl, button')) return;
    toggleAt(e.clientX, e.clientY);
  });

  // Touch: one finger scrolls natively in every direction (with momentum); two fingers pinch.
  let pinch = null;
  let lastTap = null;
  const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      // stop any fling first, so the page doesn't slide away under the fingers
      const sl = wrap.scrollLeft, st = wrap.scrollTop;
      wrap.style.overflow = 'hidden';
      wrap.scrollLeft = sl; wrap.scrollTop = st;
      const m = mid(e.touches);
      pinch = { d0: dist(e.touches), live: startLive(m.x, m.y) };
      lastTap = null;
    } else if (e.touches.length > 2 && pinch) { endPinch(); }
  }, { passive: true });
  wrap.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    if (e.cancelable) e.preventDefault();
    const m = mid(e.touches);
    showLive(pinch.live, dist(e.touches) / pinch.d0, m.x, m.y);
  }, { passive: false });
  const endPinch = () => {
    if (!pinch) return;
    const p = pinch;
    pinch = null;
    wrap.style.overflow = '';
    endLive(p.live);
  };
  wrap.addEventListener('touchend', (e) => {
    if (pinch && e.touches.length < 2) { endPinch(); return; }
    if (e.touches.length || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const now = Date.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 30 && !(getSelection() && String(getSelection()))) {
      lastTap = null;
      if (e.cancelable) e.preventDefault();
      toggleAt(t.clientX, t.clientY);
      return;
    }
    lastTap = { t: now, x: t.clientX, y: t.clientY };
  }, { passive: false });
  wrap.addEventListener('touchcancel', () => { if (pinch) endPinch(); }, { passive: true });

  /* ── remember the view of this document: zoom and the line at the top of the screen ── */
  const VKEY = key ? 'sp-dv-' + key : '';
  let saveT = 0;
  const readTop = () => { const r = wrap.getBoundingClientRect(); return spotAt(r.left + 1, r.top + 2); };
  let lastView = null;
  const writeView = () => {
    if (!VKEY || !lastView) return;
    try {
      localStorage.setItem(VKEY, JSON.stringify(lastView));
      // keep only the 60 most recent documents
      const ks = Object.keys(localStorage).filter((k) => k.startsWith('sp-dv-'));
      if (ks.length > 60) ks.map((k) => [k, (JSON.parse(localStorage.getItem(k) || '{}').t || 0)]).sort((a, b) => a[1] - b[1]).slice(0, ks.length - 60).forEach(([k]) => localStorage.removeItem(k));
    } catch {}
  };
  function saveView() {
    if (!VKEY || !wrap.isConnected || !wrap.clientHeight) return;
    const sp = readTop();
    lastView = { z: +z.toFixed(3), n: sp.under.num, fx: +sp.fx.toFixed(4), fy: +sp.fy.toFixed(4), t: Date.now() };
    clearTimeout(saveT);
    saveT = setTimeout(writeView, 250);
  }
  wrap.addEventListener('scroll', () => { if (!live && !pinch) saveView(); }, { passive: true });

  // Mouse: drag to pan when zoomed in (or hold Space, or middle button)
  let isDragging = false;
  let dragStart = { x: 0, y: 0, sl: 0, st: 0, id: null };
  let spaceDown = false;
  const onKeyDown = (e) => {
    if (e.code === 'Space' && wrap.isConnected && !(e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]'))) {
      spaceDown = true;
      wrap.classList.add('is-panning-ready');
    }
  };
  const onKeyUp = (e) => {
    if (e.code === 'Space') { spaceDown = false; wrap.classList.remove('is-panning-ready'); }
  };
  const onPointerDown = (e) => {
    if (e.pointerType === 'touch') return; // fingers scroll natively
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target.closest('.dv-hl-pop, .dv-hl, button')) return;
    if (!(spaceDown || e.button === 1 || (z > 1.05 && !e.shiftKey))) return;
    isDragging = true;
    dragStart = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop, id: e.pointerId };
    try { wrap.setPointerCapture(e.pointerId); } catch {}
    wrap.classList.add('is-panning');
    e.preventDefault();
  };
  const onPointerMove = (e) => {
    if (!isDragging || e.pointerId !== dragStart.id) return;
    wrap.scrollLeft = dragStart.sl - (e.clientX - dragStart.x);
    wrap.scrollTop = dragStart.st - (e.clientY - dragStart.y);
  };
  const onPointerUp = (e) => {
    if (!isDragging || (e.pointerId != null && e.pointerId !== dragStart.id)) return;
    isDragging = false;
    wrap.classList.remove('is-panning');
    try { wrap.releasePointerCapture(dragStart.id); } catch {}
  };
  wrap.addEventListener('pointerdown', onPointerDown);
  wrap.addEventListener('pointermove', onPointerMove);
  wrap.addEventListener('pointerup', onPointerUp);
  wrap.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  /* ──────── Text highlighting ──────── */
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
        const rRects = [...curSel.getRangeAt(0).getClientRects()];
        for (const p of pages) {
          if (!p.rendered) continue;
          const pRect = p.el.getBoundingClientRect();
          const pageRects = rRects.filter((cr) => cr.top < pRect.bottom && cr.bottom > pRect.top && cr.left < pRect.right && cr.right > pRect.left);
          if (!pageRects.length) continue;
          for (const cr of pageRects) {
            if (cr.width < 1 || cr.height < 1) continue;
            const x = Math.max(0, (cr.left - pRect.left) / pRect.width);
            const y = Math.max(0, (cr.top - pRect.top) / pRect.height);
            const w = Math.min(1 - x, cr.width / pRect.width);
            const h = Math.min(1 - y, cr.height / pRect.height);
            if (w > 0 && h > 0) p.highlights.push({ x, y, w, h, color });
          }
          renderHighlights(p);
        }
        curSel.removeAllRanges();
        hidePop();
      };
      popEl.querySelector('.dv-hl-btn').addEventListener('click', () => applyHl('rgba(254, 240, 138, 0.5)'));
      popEl.querySelector('.dv-hl-colors').addEventListener('click', (ev) => { const b = ev.target.closest('[data-c]'); if (b) applyHl(b.dataset.c); });
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
  const onSelChange = () => { const sel = document.getSelection(); if (!sel || sel.isCollapsed) hidePop(); };
  document.addEventListener('selectionchange', onSelChange);

  let lastW = wrap.clientWidth;
  const onResize = () => { if (Math.abs(wrap.clientWidth - lastW) < 2) return; lastW = wrap.clientWidth; const r = wrap.getBoundingClientRect(); const sp = readTop(); size(); putSpot(sp, r.left + 1, r.top + 2); for (const p of pages) if (p.near) render(p); };
  addEventListener('resize', onResize);

  // open at a page (e.g. a search hit)
  if (startPage > 1 && pages[startPage - 1]) requestAnimationFrame(() => { wrap.scrollTop = pages[startPage - 1].el.offsetTop - 8; showPageNo(); });
  else if (VKEY) {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(VKEY) || 'null'); } catch {}
    if (v && pages[v.n - 1]) requestAnimationFrame(() => {
      if (v.z && Math.abs(v.z - 1) > 0.01) { z = Math.max(0.5, Math.min(6, v.z)); size(); wrap.classList.toggle('is-zoomed', z > 1.05); label(); }
      const r = wrap.getBoundingClientRect();
      putSpot({ under: pages[v.n - 1], fx: v.fx || 0, fy: v.fy || 0 }, r.left + 1, r.top + 2);
      for (const p of pages) if (p.near) render(p);
      showPageNo();
    });
  }

  return {
    source,
    pages: pdf.numPages,
    zoomBy(f) { rezoom(z * f); },
    fit() { rezoom(1); },
    goto(n) { const p = pages[Math.max(1, Math.min(pages.length, n)) - 1]; wrap.scrollTop = p.el.offsetTop - 8; },
    destroy() {
      clearTimeout(saveT); writeView();
      clearTimeout(wheelT);
      hidePop();
      io.disconnect();
      ioFar.disconnect();
      clearTimeout(pnT);
      removeEventListener('resize', onResize);
      document.removeEventListener('selectionchange', onSelChange);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      pages.forEach((p) => { if (p.renderTask) { try { p.renderTask.cancel(); } catch {} } for (const c of p.el.querySelectorAll('canvas')) { c.width = c.height = 0; } });
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
