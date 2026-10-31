// Simple document editor: write or edit, save as Word / Google Docs (.docx) or PDF.
import { htmlToModel, modelToHtml, readDocx, writeDocx, writePdf } from './docmodel.js';

const $ = (s, r = document) => r.querySelector(s);
const PDFV = '/vendor/pdf/';
let pdfLibs = null;
async function loadPdfWriter() {
  if (pdfLibs) return pdfLibs;
  const L = await import(PDFV + 'pdf-lib.esm.min.js');
  if (!window.fontkit) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = PDFV + 'fontkit.umd.min.js';
      s.onload = res;
      s.onerror = rej;
      document.head.append(s);
    });
  }
  pdfLibs = { L, fontkit: window.fontkit };
  return pdfLibs;
}
const fontFiles = new Map();
const loadFontFile = (name) => {
  if (!fontFiles.has(name)) fontFiles.set(name, fetch(PDFV + 'fonts/' + name).then((r) => { if (!r.ok) throw new Error('font'); return r.arrayBuffer(); }));
  return fontFiles.get(name);
};
const clean = (html) => (window.DOMPurify ? window.DOMPurify.sanitize(html, { ADD_ATTR: ['style'], ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|data:image\/(?:png|jpe?g|gif|webp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i }) : html);

/** A picture file → data URL, upright and at most 1600 px (PNG keeps transparency, photos become JPEG) */
async function pictureUrl(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bmp) throw new Error('picture');
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const x = c.getContext('2d');
  const png = /png|gif|webp/.test(file.type) && file.size < 1.5e6;
  if (!png) { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
  x.drawImage(bmp, 0, 0, c.width, c.height);
  return { src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88), w: c.width, h: c.height };
}
/** GIF / WebP pictures → PNG so Word and PDF can hold them */
async function normalisePictures(root) {
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (/^data:image\/(png|jpe?g);/.test(src)) continue;
    try {
      const b = await (await fetch(src)).blob();
      const p = await pictureUrl(new File([b], 'x.png', { type: 'image/png' }));
      img.setAttribute('src', p.src);
    } catch { img.remove(); }
  }
}

export class DocEditor {
  constructor(dialog) {
    this.d = dialog;
    this.page = $('#de-page', dialog);
    this.name = $('#de-name', dialog);
    this.status = $('#de-status', dialog);
    this.format = $('#de-format', dialog);
    this.btnSave = $('#de-save', dialog);
    this.style = $('#de-style', dialog);
    this.size = $('#de-size', dialog);
    this.color = $('#de-color', dialog);
    this.picInput = $('#de-pic-input', dialog);
    this.resolve = null;

    $('#de-cancel', dialog).addEventListener('click', () => { if (!this.dirty || confirm('Close without saving?')) dialog.close(); });
    dialog.addEventListener('cancel', (e) => { if (this.dirty && !confirm('Close without saving?')) e.preventDefault(); });
    dialog.addEventListener('close', () => this.finish(null));
    this.btnSave.addEventListener('click', () => this.save());
    this.page.addEventListener('input', () => { this.dirty = true; this.sync(); });
    this.page.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); this.cmd(e.shiftKey ? 'outdent' : 'indent'); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); }
    });
    this.page.addEventListener('paste', (e) => {
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
      if (file) { e.preventDefault(); this.insertPicture(file); return; }
      const html = e.clipboardData && e.clipboardData.getData('text/html');
      if (html) { e.preventDefault(); this.insertHtml(clean(html.replace(/<(meta|style|script|title)[^>]*>[\s\S]*?<\/\1>|<meta[^>]*>/gi, ''))); }
    });
    document.addEventListener('selectionchange', () => { if (this.d.open) this.reflect(); });
    $('.de-toolbar', dialog).addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // keep the text selection
    $('.de-toolbar', dialog).addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      const c = b.dataset.cmd;
      if (c === 'picture') { this.picInput.click(); return; }
      if (c === 'table') { this.insertTable(3, 3); return; }
      if (c === 'hilite') { this.cmd('hiliteColor', b.getAttribute('aria-pressed') === 'true' ? 'transparent' : '#fff59d'); return; }
      this.cmd(c);
    });
    this.style.addEventListener('change', () => { this.cmd('formatBlock', this.style.value); this.page.focus(); });
    this.size.addEventListener('change', () => { this.setSize(+this.size.value); });
    this.color.addEventListener('input', () => { this.restore(); this.cmd('foreColor', this.color.value); $('.de-color span', dialog).style.borderBottomColor = this.color.value; });
    this.color.addEventListener('pointerdown', () => this.remember());
    this.size.addEventListener('pointerdown', () => this.remember());
    this.style.addEventListener('pointerdown', () => this.remember());
    this.picInput.addEventListener('change', async () => {
      const f = this.picInput.files[0];
      this.picInput.value = '';
      if (f) await this.insertPicture(f);
    });
  }

  /** Opens the editor. src: null (new) | { kind:'docx', bytes } | { kind:'html', html }. Resolves { blob, name, format } or null. */
  async open(src, name, format, open) {
    let html = '<p><br></p>';
    if (src && src.kind === 'docx') html = modelToHtml(readDocx(src.bytes)) || html;
    else if (src && src.kind === 'html') html = src.html;
    this.page.innerHTML = clean(html);
    this.name.value = (name || 'Untitled document').replace(/\.(docx|pdf)$/i, '');
    this.format.value = format || 'docx';
    this.dirty = !src;
    this.setStatus(src ? '' : 'New document');
    this.sync();
    open(this.d);
    this.page.focus();
    const r = document.createRange();
    r.selectNodeContents(this.page);
    r.collapse(!src);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    return new Promise((res) => { this.resolve = res; });
  }

  finish(v) {
    const r = this.resolve;
    this.resolve = null;
    this.page.innerHTML = '';
    if (r) r(v);
  }

  setStatus(t, kind = '') { this.status.textContent = t; this.status.dataset.kind = kind; }
  sync() { this.btnSave.disabled = !!this.busy; }

  remember() {
    const s = getSelection();
    if (s.rangeCount && this.page.contains(s.anchorNode)) this.saved = s.getRangeAt(0).cloneRange();
  }
  restore() {
    if (!this.saved) return;
    this.page.focus();
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(this.saved);
  }

  cmd(name, value = null) {
    this.page.focus();
    document.execCommand('styleWithCSS', false, /foreColor|hiliteColor|justify/.test(name));
    document.execCommand(name, false, value);
    this.dirty = true;
    this.reflect();
  }

  setSize(pt) {
    this.restore();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('fontSize', false, '7');
    for (const f of this.page.querySelectorAll('font[size="7"]')) {
      const span = document.createElement('span');
      span.style.fontSize = pt + 'pt';
      span.append(...f.childNodes);
      f.replaceWith(span);
    }
    this.dirty = true;
    this.page.focus();
  }

  insertTable(rows, cols) {
    this.page.focus();
    const s = getSelection();
    let node = s.rangeCount && this.page.contains(s.anchorNode) ? s.anchorNode : this.page.lastChild;
    let block = node;
    while (block && block.parentNode !== this.page) block = block.parentNode;
    const table = document.createElement('table');
    table.className = 'doc-table';
    table.style.width = '100%';
    const body = table.createTBody();
    for (let r = 0; r < rows; r++) { const tr = body.insertRow(); for (let c = 0; c < cols; c++) tr.insertCell().innerHTML = '<br>'; }
    if (!block) this.page.append(table);
    else if (block.nodeType === 1 && /^P$|^H[1-6]$/.test(block.tagName) && !block.textContent.trim() && !block.querySelector('img')) block.replaceWith(table);
    else block.after(table);
    if (!table.nextElementSibling) { const p = document.createElement('p'); p.innerHTML = '<br>'; table.after(p); }
    const r = document.createRange();
    r.setStart(table.rows[0].cells[0], 0);
    r.collapse(true);
    s.removeAllRanges();
    s.addRange(r);
    this.dirty = true;
    this.reflect();
  }

  insertHtml(html) {
    this.page.focus();
    document.execCommand('insertHTML', false, html);
    this.dirty = true;
  }

  async insertPicture(file) {
    try {
      this.restore();
      const p = await pictureUrl(file);
      const w = Math.min(p.w, 600);
      this.insertHtml(`<img src="${p.src}" style="width:${w}px;max-width:100%">`);
    } catch { this.setStatus('Could not add this picture.', 'err'); }
  }

  /** Light up the toolbar for where the cursor is */
  reflect() {
    const s = getSelection();
    if (!s.rangeCount || !this.page.contains(s.anchorNode)) return;
    for (const b of this.d.querySelectorAll('[data-cmd][data-state]')) {
      let on = false;
      try { on = document.queryCommandState(b.dataset.cmd); } catch {}
      b.setAttribute('aria-pressed', String(on));
    }
    let n = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
    const block = n && n.closest('h1,h2,h3,p,li,div');
    this.style.value = block && /^H[123]$/.test(block.tagName) ? block.tagName.toLowerCase() : 'p';
    const fs = n ? parseFloat(getComputedStyle(n).fontSize) * 0.75 : 11;
    const opt = [...this.size.options].map((o) => +o.value).reduce((a, b) => (Math.abs(b - fs) < Math.abs(a - fs) ? b : a), 11);
    this.size.value = String(opt);
    const hl = n && getComputedStyle(n).backgroundColor;
    const hb = $('[data-cmd="hilite"]', this.d);
    if (hb) hb.setAttribute('aria-pressed', String(!!hl && hl !== 'rgba(0, 0, 0, 0)' && hl !== 'transparent'));
  }

  async save() {
    if (this.busy) return;
    this.busy = true;
    this.sync();
    this.setStatus('Saving…');
    try {
      const work = document.createElement('div');
      work.innerHTML = this.page.innerHTML;
      await normalisePictures(work);
      const blocks = htmlToModel(work);
      const name = (this.name.value.trim() || 'Untitled document').replace(/[\\/:*?"<>|]+/g, '-');
      let blob;
      if (this.format.value === 'pdf') {
        const { L, fontkit } = await loadPdfWriter();
        const bytes = await writePdf(L, fontkit, blocks, { loadFontFile, sourceHtml: modelToHtml(blocks), title: name });
        blob = new Blob([bytes], { type: 'application/pdf' });
      } else {
        blob = new Blob([writeDocx(blocks)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      }
      const r = this.resolve;
      this.resolve = null;
      this.dirty = false;
      this.d.close();
      if (r) r({ blob, name: `${name}.${this.format.value}`, format: this.format.value });
    } catch (e) {
      console.warn('save document', e);
      this.setStatus('Could not save. Try again.', 'err');
    } finally {
      this.busy = false;
      this.sync();
    }
  }
}
