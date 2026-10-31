// Documents without outside viewers: a small shared model
//   blocks: { t:'p', style:'normal'|'h1'|'h2'|'h3', align, runs:[…], list?:{kind:'bullet'|'number', level, id} }
//           { t:'img', src(dataURL), w, h, align }       { t:'table', rows:[[ [blocks…] … ] … ] }
//   runs:   { text, b, i, u, s, color:'rrggbb', size(pt), hl:'rrggbb', href } | { br:true } | { img:{src,w,h} }
// ↔ editor HTML, ↔ Word .docx (read + write), → PDF (with the editable source attached),
// and read-only HTML for spreadsheets (.xlsx / .csv) and slides (.pptx).

import { unzipSync, zipSync, strToU8, strFromU8 } from '/vendor/doc/fflate.mjs';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const xesc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const HL = { yellow: 'ffff00', green: '00ff00', cyan: '00ffff', magenta: 'ff00ff', blue: '0000ff', red: 'ff0000', darkBlue: '000080', darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000', darkYellow: '808000', darkGray: '808080', lightGray: 'c0c0c0', black: '000000', white: 'ffffff' };
const SIZES = { normal: 11, h1: 20, h2: 16, h3: 13 };

/* ───────── colours ───────── */

function cssToHex(c) {
  if (!c) return null;
  c = String(c).trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(c);
  if (m) return m[1];
  m = /^#([0-9a-f]{3})$/.exec(c);
  if (m) return m[1].split('').map((x) => x + x).join('');
  m = /^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[,/ ]+([\d.]+))?\)$/.exec(c);
  if (m) {
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, +v)).toString(16).padStart(2, '0')).join('');
  }
  const named = { black: '000000', white: 'ffffff', red: 'ff0000', blue: '0000ff', green: '008000', yellow: 'ffff00', gray: '808080', grey: '808080', orange: 'ffa500', purple: '800080' };
  return named[c] || null;
}
function sizeToPt(v) {
  if (!v) return null;
  const m = /^([\d.]+)(px|pt|em|rem|%)?$/.exec(String(v).trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2] || 'px';
  const pt = u === 'pt' ? n : u === 'px' ? n * 0.75 : u === '%' ? (n / 100) * 11 : n * 11;
  return Math.round(pt * 2) / 2;
}
const FONT_TAG_SIZES = { 1: 7.5, 2: 10, 3: 12, 4: 13.5, 5: 18, 6: 24, 7: 36 };

/* ───────── editor HTML → model ───────── */

export function htmlToModel(root) {
  const blocks = [];
  let listSeq = 0;
  const blockTags = /^(P|DIV|H1|H2|H3|H4|H5|H6|UL|OL|LI|TABLE|BLOCKQUOTE|PRE|SECTION|ARTICLE|HEADER|FOOTER|FIGURE)$/;

  const fmtOf = (el, f) => {
    const n = { ...f };
    const tag = el.tagName;
    if (tag === 'B' || tag === 'STRONG') n.b = true;
    if (tag === 'I' || tag === 'EM') n.i = true;
    if (tag === 'U' || tag === 'INS') n.u = true;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') n.s = true;
    if (tag === 'A' && el.getAttribute('href')) n.href = el.getAttribute('href');
    if (tag === 'FONT') {
      if (el.getAttribute('color')) n.color = cssToHex(el.getAttribute('color')) || n.color;
      if (el.getAttribute('size')) n.size = FONT_TAG_SIZES[el.getAttribute('size')] || n.size;
    }
    const st = el.style;
    if (st) {
      if (st.fontWeight && (st.fontWeight === 'bold' || +st.fontWeight >= 600)) n.b = true;
      if (st.fontWeight && (st.fontWeight === 'normal' || +st.fontWeight < 600 && +st.fontWeight > 0)) n.b = false;
      if (st.fontStyle === 'italic') n.i = true;
      const td = `${st.textDecoration || ''} ${st.textDecorationLine || ''}`;
      if (/underline/.test(td)) n.u = true;
      if (/line-through/.test(td)) n.s = true;
      if (st.color) n.color = cssToHex(st.color) || n.color;
      if (st.backgroundColor) { const h = cssToHex(st.backgroundColor); if (h && h !== 'ffffff') n.hl = h; }
      if (st.fontSize) n.size = sizeToPt(st.fontSize) || n.size;
    }
    return n;
  };

  const inline = (node, f, runs) => {
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(/[\s ]+/g, (m) => (m.includes(' ') ? m.replace(/[^ ]/g, ' ').replace(/ /g, ' ') : ' '));
      if (t) runs.push({ ...f, text: t });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'BR') { runs.push({ br: true }); return; }
    if (tag === 'IMG') { const im = imgOf(node); if (im) runs.push({ img: im }); return; }
    const nf = fmtOf(node, f);
    for (const c of node.childNodes) inline(c, nf, runs);
  };

  const imgOf = (img) => {
    const src = img.getAttribute('src') || '';
    if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(src)) return null;
    const w = Math.round(parseFloat(img.style.width) || img.width || img.naturalWidth || 300);
    const ratio = (img.naturalHeight && img.naturalWidth) ? img.naturalHeight / img.naturalWidth : (img.height && img.width ? img.height / img.width : 0.66);
    return { src, w, h: Math.round(w * ratio) };
  };

  const alignOf = (el) => {
    const a = ((el.style && el.style.textAlign) || el.getAttribute('align') || '').toLowerCase();
    return /center|right|justify/.test(a) ? a.replace('start', 'left') : 'left';
  };

  const para = (el, style, list, out, baseFmt = {}) => {
    const runs = [];
    // a paragraph may hold block children (a pasted <div><p>…): split them out
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const r = [];
      for (const n of buf) inline(n, fmtOf(el, baseFmt), r);
      buf = [];
      pushPara(r, style, alignOf(el), list, out);
    };
    for (const c of el.childNodes) {
      if (c.nodeType === 1 && blockTags.test(c.tagName)) { flush(); walk(c, out, list); }
      else buf.push(c);
    }
    flush();
    return runs;
  };

  const pushPara = (runs, style, align, list, out) => {
    // trim spaces at the paragraph edges
    while (runs.length && runs[0].text !== undefined && !runs[0].text.trim()) runs.shift();
    if (runs.length && runs[0].text) runs[0] = { ...runs[0], text: runs[0].text.replace(/^ +/, '') };
    const last = runs[runs.length - 1];
    if (last && last.text) runs[runs.length - 1] = { ...last, text: last.text.replace(/ +$/, '') };
    while (runs.length && runs[runs.length - 1].br) runs.pop();
    // a paragraph that is only one picture becomes a picture block
    const real = runs.filter((r) => !(r.text !== undefined && !r.text.trim()));
    if (real.length === 1 && real[0].img && !list) { out.push({ t: 'img', ...real[0].img, align }); return; }
    out.push({ t: 'p', style, align, runs, ...(list ? { list } : {}) });
  };

  const walk = (el, out, list) => {
    const tag = el.tagName;
    if (tag === 'UL' || tag === 'OL') {
      const level = list ? list.level + 1 : 0;
      const id = tag === 'OL' ? ++listSeq : 0;
      for (const li of el.children) {
        if (li.tagName !== 'LI') { walk(li, out, list); continue; }
        para(li, 'normal', { kind: tag === 'OL' ? 'number' : 'bullet', level: Math.min(level, 2), id }, out);
      }
      return;
    }
    if (tag === 'TABLE') {
      const rows = [];
      for (const tr of el.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr')) {
        const row = [];
        for (const td of tr.children) {
          if (!/^T[DH]$/.test(td.tagName)) continue;
          const cell = [];
          const hasBlocks = [...td.children].some((c) => blockTags.test(c.tagName));
          if (hasBlocks) for (const c of td.childNodes) { if (c.nodeType === 1 && blockTags.test(c.tagName)) walk(c, cell); else if (c.nodeType === 3 && c.nodeValue.trim()) pushPara([{ text: c.nodeValue }], 'normal', 'left', null, cell); }
          else para(td, 'normal', null, cell, td.tagName === 'TH' ? { b: true } : {});
          row.push(cell.length ? cell : [{ t: 'p', style: 'normal', align: 'left', runs: [] }]);
        }
        if (row.length) rows.push(row);
      }
      if (rows.length) out.push({ t: 'table', rows });
      return;
    }
    if (tag === 'IMG') { const im = imgOf(el); if (im) out.push({ t: 'img', ...im, align: 'left' }); return; }
    if (tag === 'HR' || tag === 'SCRIPT' || tag === 'STYLE') return;
    const style = /^H1$/.test(tag) ? 'h1' : /^H2$/.test(tag) ? 'h2' : /^H[3-6]$/.test(tag) ? 'h3' : 'normal';
    para(el, style, list, out);
  };

  // top level: loose inline content between blocks becomes paragraphs
  let loose = [];
  const flushLoose = () => {
    if (!loose.length) return;
    const runs = [];
    for (const n of loose) inline(n, {}, runs);
    loose = [];
    if (runs.some((r) => r.img || (r.text && r.text.trim()))) pushPara(runs, 'normal', 'left', null, blocks);
  };
  for (const c of root.childNodes) {
    if (c.nodeType === 1 && (blockTags.test(c.tagName) || c.tagName === 'IMG' || c.tagName === 'HR')) { flushLoose(); walk(c, blocks); }
    else loose.push(c);
  }
  flushLoose();
  return blocks;
}

/* ───────── model → HTML (editor & viewer) ───────── */

function runsHTML(runs) {
  return runs.map((r) => {
    if (r.br) return '<br>';
    if (r.img) return `<img src="${esc(r.img.src)}" style="width:${r.img.w}px;max-width:100%">`;
    let h = esc(r.text || '');
    const st = [];
    if (r.color) st.push(`color:#${r.color}`);
    if (r.hl) st.push(`background-color:#${r.hl}`);
    if (r.size) st.push(`font-size:${r.size}pt`);
    if (st.length) h = `<span style="${st.join(';')}">${h}</span>`;
    if (r.b) h = `<b>${h}</b>`;
    if (r.i) h = `<i>${h}</i>`;
    if (r.u) h = `<u>${h}</u>`;
    if (r.s) h = `<s>${h}</s>`;
    if (r.href && /^(https?:|mailto:)/i.test(r.href)) h = `<a href="${esc(r.href)}">${h}</a>`;
    return h;
  }).join('');
}

export function modelToHtml(blocks) {
  let out = '';
  const stack = []; // open lists: { tag, level, id }
  const close = (level) => { while (stack.length && stack[stack.length - 1].level >= level) out += `</${stack.pop().tag}>`; };
  for (const b of blocks) {
    if (b.t === 'p' && b.list) {
      const tag = b.list.kind === 'number' ? 'ol' : 'ul';
      const lv = b.list.level;
      close(lv + 1);
      const top = stack[stack.length - 1];
      if (top && top.level === lv && (top.tag !== tag || top.id !== b.list.id)) close(lv);
      while (!stack.length || stack[stack.length - 1].level < lv) {
        out += `<${tag}>`;
        stack.push({ tag, level: stack.length ? stack[stack.length - 1].level + 1 : 0, id: b.list.id });
      }
      out += `<li${b.align !== 'left' ? ` style="text-align:${b.align}"` : ''}>${runsHTML(b.runs) || '<br>'}</li>`;
      continue;
    }
    close(0);
    if (b.t === 'p') {
      const tag = b.style === 'normal' ? 'p' : b.style;
      out += `<${tag}${b.align && b.align !== 'left' ? ` style="text-align:${b.align}"` : ''}>${runsHTML(b.runs) || '<br>'}</${tag}>`;
    } else if (b.t === 'img') {
      out += `<p${b.align && b.align !== 'left' ? ` style="text-align:${b.align}"` : ''}><img src="${esc(b.src)}" style="width:${b.w}px;max-width:100%"></p>`;
    } else if (b.t === 'table') {
      out += '<table class="doc-table"><tbody>' + b.rows.map((row) => '<tr>' + row.map((cell) => `<td>${modelToHtml(cell)}</td>`).join('') + '</tr>').join('') + '</tbody></table><p><br></p>';
    }
  }
  close(0);
  return out;
}

/* ───────── .docx → model ───────── */

const kids = (el, name) => [...el.childNodes].filter((n) => n.nodeType === 1 && n.localName === name);
const kid = (el, name) => (el ? kids(el, name)[0] : undefined);
const wval = (el) => (el ? el.getAttributeNS(W, 'val') || el.getAttribute('w:val') : null);
const onOff = (el) => !!el && !/^(false|0|off|none)$/i.test(wval(el) || 'true');

export function readDocx(bytes) {
  const z = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const txt = (p) => (z[p] ? strFromU8(z[p]) : null);
  const xml = (p) => { const t = txt(p); return t ? new DOMParser().parseFromString(t, 'application/xml') : null; };
  const doc = xml('word/document.xml');
  if (!doc) throw new Error('not a Word document');
  const rels = {};
  const relDoc = xml('word/_rels/document.xml.rels');
  if (relDoc) for (const r of relDoc.getElementsByTagName('Relationship')) rels[r.getAttribute('Id')] = { target: r.getAttribute('Target'), mode: r.getAttribute('TargetMode') };
  // heading styles by id
  const styleName = {};
  const styleNum = {}; // list styles ("List Bullet") carry their numbering in the style
  const basedOn = {};
  const st = xml('word/styles.xml');
  if (st) for (const s of st.getElementsByTagNameNS(W, 'style')) {
    const id = s.getAttributeNS(W, 'styleId');
    styleName[id] = (wval(kid(s, 'name')) || '').toLowerCase();
    basedOn[id] = wval(kid(s, 'basedOn'));
    const np = kid(kid(s, 'pPr'), 'numPr');
    if (np) styleNum[id] = { numId: wval(kid(np, 'numId')), ilvl: wval(kid(np, 'ilvl')) };
  }
  const numOfStyle = (id) => { for (let k = 0; id && k < 5; k++, id = basedOn[id]) if (styleNum[id]) return styleNum[id]; return null; };
  // list kinds: numId → abstract → level formats
  const numFmt = {};
  const nd = xml('word/numbering.xml');
  if (nd) {
    const abs = {};
    for (const a of nd.getElementsByTagNameNS(W, 'abstractNum')) {
      const lv = {};
      for (const l of kids(a, 'lvl')) lv[l.getAttributeNS(W, 'ilvl')] = wval(kid(l, 'numFmt')) || 'bullet';
      abs[a.getAttributeNS(W, 'abstractNumId')] = lv;
    }
    for (const n of nd.getElementsByTagNameNS(W, 'num')) numFmt[n.getAttributeNS(W, 'numId')] = abs[wval(kid(n, 'abstractNumId'))] || {};
  }
  const media = (target) => {
    const path = target.startsWith('/') ? target.slice(1) : 'word/' + target.replace(/^\.\//, '');
    const data = z[path.replace(/[^/]+\/\.\.\//g, '')];
    if (!data) return null;
    const ext = (/\.(\w+)$/.exec(path) || [])[1] || 'png';
    const mime = /jpe?g/i.test(ext) ? 'image/jpeg' : /gif/i.test(ext) ? 'image/gif' : /png/i.test(ext) ? 'image/png' : null;
    if (!mime) return null;
    let bin = '';
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    return `data:${mime};base64,${btoa(bin)}`;
  };

  const runFmt = (rPr, base = {}) => {
    const f = { ...base };
    if (!rPr) return f;
    if (kid(rPr, 'b')) f.b = onOff(kid(rPr, 'b'));
    if (kid(rPr, 'i')) f.i = onOff(kid(rPr, 'i'));
    if (kid(rPr, 'u')) f.u = (wval(kid(rPr, 'u')) || 'single') !== 'none';
    if (kid(rPr, 'strike') || kid(rPr, 'dstrike')) f.s = onOff(kid(rPr, 'strike') || kid(rPr, 'dstrike'));
    const c = wval(kid(rPr, 'color'));
    if (c && /^[0-9a-f]{6}$/i.test(c) && c.toLowerCase() !== '000000') f.color = c.toLowerCase();
    const sz = wval(kid(rPr, 'sz'));
    if (sz) f.size = +sz / 2;
    const hl = wval(kid(rPr, 'highlight'));
    if (hl && HL[hl]) f.hl = HL[hl];
    const shd = kid(rPr, 'shd');
    const fill = shd && (shd.getAttributeNS(W, 'fill') || '');
    if (fill && /^[0-9a-f]{6}$/i.test(fill) && fill.toLowerCase() !== 'ffffff') f.hl = fill.toLowerCase();
    return f;
  };

  const runsOf = (p, base, runs, href) => {
    for (const n of p.childNodes) {
      if (n.nodeType !== 1) continue;
      const ln = n.localName;
      if (ln === 'r') {
        const f = runFmt(kid(n, 'rPr'), base);
        if (href) f.href = href;
        for (const c of n.childNodes) {
          if (c.nodeType !== 1) continue;
          if (c.localName === 't') runs.push({ ...f, text: c.textContent });
          else if (c.localName === 'tab') runs.push({ ...f, text: '    ' });
          else if (c.localName === 'br' || c.localName === 'cr') runs.push({ br: true });
          else if (c.localName === 'drawing' || c.localName === 'pict') {
            const blip = c.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')[0];
            const rid = blip && (blip.getAttributeNS(R, 'embed') || blip.getAttribute('r:embed'));
            const ext = c.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'extent')[0];
            const src = rid && rels[rid] ? media(rels[rid].target) : null;
            if (src) {
              const w = ext ? Math.round(+ext.getAttribute('cx') / 9525) : 300;
              const h = ext ? Math.round(+ext.getAttribute('cy') / 9525) : 200;
              runs.push({ img: { src, w: Math.min(w, 640), h: Math.round(h * Math.min(1, 640 / Math.max(1, w))) } });
            }
          }
        }
      } else if (ln === 'hyperlink') {
        const rid = n.getAttributeNS(R, 'id') || n.getAttribute('r:id');
        runsOf(n, base, runs, rid && rels[rid] ? rels[rid].target : href);
      } else if (ln === 'ins' || ln === 'smartTag' || ln === 'fldSimple' || ln === 'sdt' || ln === 'sdtContent' || ln === 'customXml') {
        runsOf(ln === 'sdt' ? kid(n, 'sdtContent') || n : n, base, runs, href);
      }
    }
    return runs;
  };

  let seq = 0;
  const lastNum = {};
  const blocksOf = (container, out) => {
    for (const n of container.childNodes) {
      if (n.nodeType !== 1) continue;
      if (n.localName === 'p') {
        const pPr = kid(n, 'pPr');
        const sid = wval(kid(pPr, 'pStyle')) || '';
        const sname = styleName[sid] || sid.toLowerCase();
        const lvl = /(heading|überschrift|titre|titolo)\s*(\d)/.exec(sname) || /^heading(\d)$/.exec(sid.toLowerCase());
        const style = /^title$/.test(sname) ? 'h1' : /^subtitle$/.test(sname) ? 'h2' : lvl ? ['h1', 'h1', 'h2', 'h3'][Math.min(3, +(lvl[2] || lvl[1]) || 1)] : 'normal';
        const jc = wval(kid(pPr, 'jc')) || 'left';
        const align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : jc === 'both' || jc === 'distribute' ? 'justify' : 'left';
        const numPr = kid(pPr, 'numPr');
        const sNum = numOfStyle(sid);
        let list = null;
        if (numPr || sNum || /^list (bullet|number)/.test(sname)) {
          const numId = wval(kid(numPr, 'numId')) || (sNum && sNum.numId) || (/number/.test(sname) ? 'style-number' : 'style-bullet');
          const ilvl = wval(kid(numPr, 'ilvl')) || (sNum && sNum.ilvl) || ((/(\d)$/.exec(sname) || [])[1] ? String(+/(\d)$/.exec(sname)[1] - 1) : '0');
          if (numId && numId !== '0') {
            const fmtv = (numFmt[numId] || {})[ilvl] || (numId === 'style-number' ? 'decimal' : 'bullet');
            const kind = fmtv === 'bullet' || fmtv === 'none' ? 'bullet' : 'number';
            if (kind === 'number' && lastNum.numId !== numId) { lastNum.numId = numId; lastNum.id = ++seq; }
            list = { kind, level: Math.min(2, +ilvl || 0), id: kind === 'number' ? lastNum.id : 0 };
          }
        }
        const runs = runsOf(n, {}, []);
        const imgs = runs.filter((r) => r.img);
        if (imgs.length === 1 && runs.every((r) => r.img || (r.text !== undefined && !r.text.trim()))) out.push({ t: 'img', ...imgs[0].img, align });
        else out.push({ t: 'p', style, align, runs, ...(list ? { list } : {}) });
      } else if (n.localName === 'tbl') {
        const rows = [];
        for (const tr of kids(n, 'tr')) {
          const row = [];
          for (const tc of kids(tr, 'tc')) { const cell = []; blocksOf(tc, cell); row.push(cell.length ? cell : [{ t: 'p', style: 'normal', align: 'left', runs: [] }]); }
          if (row.length) rows.push(row);
        }
        if (rows.length) out.push({ t: 'table', rows });
      } else if (n.localName === 'sdt') {
        const c = kid(n, 'sdtContent');
        if (c) blocksOf(c, out);
      }
    }
  };
  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  const blocks = [];
  if (body) blocksOf(body, blocks);
  return blocks;
}

/* ───────── model → .docx ───────── */

const dataUrlBytes = (src) => {
  const m = /^data:(image\/[\w+.-]+);base64,(.*)$/.exec(src);
  if (!m) return null;
  const bin = atob(m[2]);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return { mime: m[1], bytes: u };
};

export function writeDocx(blocks) {
  const rels = [];
  const media = {};
  let rid = 3;
  let pic = 0;
  const nums = []; // numbered lists, each restarts at 1
  const numFor = {};
  const addRel = (type, target, external) => {
    const id = 'rId' + ++rid;
    rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${xesc(target)}"${external ? ' TargetMode="External"' : ''}/>`);
    return id;
  };
  const imageXml = (im, maxW = 605) => {
    const d = dataUrlBytes(im.src);
    if (!d) return '';
    let png = /png/.test(d.mime);
    let bytes = d.bytes;
    if (!/png|jpe?g|gif/.test(d.mime)) return ''; // webp is converted by the editor before saving
    const ext = png ? 'png' : /gif/.test(d.mime) ? 'gif' : 'jpeg';
    const name = `image${++pic}.${ext}`;
    media['word/media/' + name] = bytes;
    const id = addRel('image', 'media/' + name);
    const k = Math.min(1, maxW / Math.max(1, im.w));
    const cx = Math.round(im.w * k * 9525);
    const cy = Math.round(im.h * k * 9525);
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${pic}" name="Picture ${pic}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${pic}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };
  const runXml = (r, maxW) => {
    if (r.br) return '<w:r><w:br/></w:r>';
    if (r.img) return imageXml(r.img, maxW);
    if (!r.text) return '';
    let pr = '';
    if (r.href) pr += '<w:rStyle w:val="Hyperlink"/>';
    if (r.b) pr += '<w:b/><w:bCs/>';
    if (r.i) pr += '<w:i/><w:iCs/>';
    if (r.s) pr += '<w:strike/>';
    if (r.color) pr += `<w:color w:val="${r.color.toUpperCase()}"/>`;
    if (r.size) pr += `<w:sz w:val="${Math.round(r.size * 2)}"/><w:szCs w:val="${Math.round(r.size * 2)}"/>`;
    if (r.u) pr += '<w:u w:val="single"/>';
    if (r.hl) pr += `<w:shd w:val="clear" w:color="auto" w:fill="${r.hl.toUpperCase()}"/>`;
    const x = `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${xesc(r.text)}</w:t></w:r>`;
    return r.href && /^(https?:|mailto:)/i.test(r.href) ? `<w:hyperlink r:id="${addRel('hyperlink', r.href, true)}">${x}</w:hyperlink>` : x;
  };
  const paraXml = (b, maxW) => {
    if (b.t === 'img') return `<w:p>${b.align !== 'left' ? `<w:pPr><w:jc w:val="${b.align === 'justify' ? 'both' : b.align}"/></w:pPr>` : ''}${imageXml(b, maxW)}</w:p>`;
    if (b.t === 'table') return tableXml(b);
    let pPr = '';
    if (b.style !== 'normal') pPr += `<w:pStyle w:val="${{ h1: 'Heading1', h2: 'Heading2', h3: 'Heading3' }[b.style]}"/>`;
    else if (b.list) pPr += '<w:pStyle w:val="ListParagraph"/>';
    if (b.list) {
      let numId = 1;
      if (b.list.kind === 'number') {
        if (!numFor[b.list.id]) { nums.push(b.list.id); numFor[b.list.id] = nums.length + 1; }
        numId = numFor[b.list.id];
      }
      pPr += `<w:numPr><w:ilvl w:val="${b.list.level}"/><w:numId w:val="${numId}"/></w:numPr>`;
    }
    if (b.align && b.align !== 'left') pPr += `<w:jc w:val="${b.align === 'justify' ? 'both' : b.align}"/>`;
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${b.runs.map((r) => runXml(r, maxW)).join('')}</w:p>`;
  };
  const tableXml = (t) => {
    const cols = Math.max(...t.rows.map((r) => r.length));
    const total = 9638; // A4 text width in twips (17 cm)
    const cw = Math.floor(total / cols);
    const border = '<w:top w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:left w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:right w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>';
    return `<w:tbl><w:tblPr><w:tblW w:w="${cw * cols}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${'<w:gridCol w:w="' + cw + '"/>'.repeat(cols)}</w:tblGrid>`
      + t.rows.map((row) => `<w:tr>${Array.from({ length: cols }, (_, k) => {
        const cell = row[k] || [{ t: 'p', style: 'normal', align: 'left', runs: [] }];
        const inner = cell.map((b) => paraXml(b, (cw / 1440) * 96 - 10)).join('') || '<w:p/>';
        return `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/></w:tcPr>${inner.endsWith('</w:p>') || inner.endsWith('<w:p/>') ? inner : inner + '<w:p/>'}</w:tc>`;
      }).join('')}</w:tr>`).join('') + '</w:tbl><w:p/>';
  };

  const body = blocks.map((b) => paraXml(b, 605)).join('');
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const lvl = (i, fmt, text, font) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="360"/></w:pPr>${font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr>` : ''}</w:lvl>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${W}">`
    + `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, 'bullet', '•', 'Arial')}${lvl(1, 'bullet', 'o', 'Courier New')}${lvl(2, 'bullet', '▪', 'Arial')}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, 'decimal', '%1.')}${lvl(1, 'lowerLetter', '%2.')}${lvl(2, 'lowerRoman', '%3.')}</w:abstractNum>`
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + nums.map((_, k) => `<w:num w:numId="${k + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('')
    + '</w:numbering>';
  const heading = (id, name, size, color) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${+id.slice(-1) - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${W}">`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + heading('Heading1', 'heading 1', 20, '1F3864') + heading('Heading2', 'heading 2', 16, '2F5496') + heading('Heading3', 'heading 3', 13, '2F5496')
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
    + '</w:styles>';
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${rels.join('')}</Relationships>`;
  const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="708"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>SyncPad</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const root = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
  const files = {
    '[Content_Types].xml': strToU8(types),
    '_rels/.rels': strToU8(root),
    'docProps/core.xml': strToU8(core),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(styles),
    'word/numbering.xml': strToU8(numbering),
    'word/settings.xml': strToU8(settings),
    'word/_rels/document.xml.rels': strToU8(docRels),
    ...media
  };
  return zipSync(files, { level: 6 });
}

/* ───────── model → PDF (pdf-lib) ───────── */

const hexRgb = (L, h) => (h ? L.rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255) : L.rgb(0, 0, 0));

export async function writePdf(L, fontkit, blocks, { loadFontFile, sourceHtml, title } = {}) {
  const doc = await L.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts = {};
  const fontFor = async (b, i) => {
    const key = `${b ? 700 : 400}-${i ? 'italic' : 'normal'}`;
    if (!fonts[key]) fonts[key] = await doc.embedFont(await loadFontFile(`carlito-latin-${key}.woff`), { subset: true });
    return fonts[key];
  };
  const reg = await fontFor(false, false);
  const fk = reg.embedder && reg.embedder.font;
  const safe = (t) => [...t].map((ch) => (ch === '\t' ? '    ' : !fk || fk.hasGlyphForCodePoint(ch.codePointAt(0)) ? ch : '?')).join('');
  if (title) doc.setTitle(title);
  doc.setCreator('SyncPad');
  const PW = 595.28, PH = 841.89, M = 56.7;
  let page = doc.addPage([PW, PH]);
  let y = PH - M;
  const newPage = () => { page = doc.addPage([PW, PH]); y = PH - M; };
  const images = new Map();
  const embedImg = async (src) => {
    if (images.has(src)) return images.get(src);
    const d = dataUrlBytes(src);
    let img = null;
    try { img = d && (/png/.test(d.mime) ? await doc.embedPng(d.bytes) : /jpe?g/.test(d.mime) ? await doc.embedJpg(d.bytes) : null); } catch { img = null; }
    images.set(src, img);
    return img;
  };

  // lay out runs into lines inside [x, x+width]; draw=false only measures
  const layoutPara = async (b, x, width, draw, startY) => {
    const base = SIZES[b.style] || 11;
    const bold = b.style !== 'normal';
    const color0 = b.style === 'h1' ? '1f3864' : b.style !== 'normal' ? '2f5496' : null;
    // words with their style
    const words = [];
    for (const r of b.runs) {
      if (r.br) { words.push({ br: true }); continue; }
      if (r.img) { words.push({ img: r.img }); continue; }
      const size = r.size || base;
      const font = await fontFor(r.b || bold, r.i);
      const parts = safe(r.text || '').split(/( +)/);
      for (const t of parts) if (t) words.push({ t, size, font, color: r.color || color0, u: r.u || !!r.href, s: r.s, hl: r.hl, space: /^ +$/.test(t), href: r.href });
    }
    const lines = [];
    let line = [];
    let lw = 0;
    const push = () => { lines.push({ items: line, w: lw }); line = []; lw = 0; };
    for (const w of words) {
      if (w.br) { push(); continue; }
      if (w.img) {
        if (line.length) push();
        lines.push({ img: w.img, w: 0 });
        continue;
      }
      let ww = w.font.widthOfTextAtSize(w.t, w.size);
      if (w.space && !line.length) continue;
      if (lw + ww > width && line.length && !w.space) {
        push();
      }
      if (ww > width && !w.space) { // a very long word: break it
        let piece = '';
        for (const ch of w.t) {
          const cw = w.font.widthOfTextAtSize(piece + ch, w.size);
          if (cw > width && piece) { line.push({ ...w, t: piece, w: w.font.widthOfTextAtSize(piece, w.size) }); lw += line[line.length - 1].w; push(); piece = ch; }
          else piece += ch;
        }
        ww = w.font.widthOfTextAtSize(piece, w.size);
        line.push({ ...w, t: piece, w: ww });
        lw += ww;
        continue;
      }
      line.push({ ...w, w: ww });
      lw += ww;
    }
    if (line.length || !lines.length) push();
    let cy = startY;
    let height = 0;
    for (let li = 0; li < lines.length; li++) {
      const L0 = lines[li];
      if (L0.img) {
        const im = draw ? await embedImg(L0.img.src) : null;
        const k = Math.min(1, width / (L0.img.w * 0.75));
        const iw = L0.img.w * 0.75 * k;
        const ih = L0.img.h * 0.75 * k;
        if (draw && cy - ih < M && cy < PH - M - 1) { newPage(); cy = y; }
        if (draw && im) page.drawImage(im, { x, y: cy - ih, width: iw, height: ih });
        cy -= ih + 4;
        height += ih + 4;
        continue;
      }
      while (L0.items.length && L0.items[L0.items.length - 1].space) { L0.w -= L0.items.pop().w; }
      const maxSize = Math.max(base, ...L0.items.map((it) => it.size));
      const lh = maxSize * 1.32;
      if (draw && cy - lh < M) { newPage(); cy = y; }
      const baseline = cy - maxSize * 1.02;
      let sx = x;
      let extra = 0;
      if (b.align === 'center') sx += (width - L0.w) / 2;
      else if (b.align === 'right') sx += width - L0.w;
      else if (b.align === 'justify' && li < lines.length - 1) {
        const spaces = L0.items.filter((it) => it.space).length;
        if (spaces) extra = (width - L0.w) / spaces;
      }
      if (draw) {
        let px = sx;
        for (const it of L0.items) {
          const w = it.w + (it.space ? extra : 0);
          if (it.hl) page.drawRectangle({ x: px, y: baseline - it.size * 0.25, width: w, height: it.size * 1.2, color: hexRgb(L, it.hl) });
          px += w;
        }
        px = sx;
        for (const it of L0.items) {
          const w = it.w + (it.space ? extra : 0);
          const color = hexRgb(L, it.href && !it.color ? '0563c1' : it.color);
          if (!it.space) page.drawText(it.t, { x: px, y: baseline, size: it.size, font: it.font, color });
          if (it.u) page.drawLine({ start: { x: px, y: baseline - it.size * 0.12 }, end: { x: px + w, y: baseline - it.size * 0.12 }, thickness: Math.max(0.5, it.size * 0.055), color });
          if (it.s) page.drawLine({ start: { x: px, y: baseline + it.size * 0.3 }, end: { x: px + w, y: baseline + it.size * 0.3 }, thickness: Math.max(0.5, it.size * 0.055), color });
          px += w;
        }
      }
      cy -= lh;
      height += lh;
    }
    return { height, firstSize: base, endY: cy };
  };

  const listCounters = {};
  const drawBlock = async (b, x, width) => {
    if (b.t === 'img') {
      const im = await embedImg(b.src);
      if (!im) return;
      let iw = b.w * 0.75;
      let ih = b.h * 0.75;
      const k = Math.min(1, width / iw, (PH - 2 * M) / ih);
      iw *= k; ih *= k;
      if (y - ih < M) newPage();
      const ix = b.align === 'center' ? x + (width - iw) / 2 : b.align === 'right' ? x + width - iw : x;
      page.drawImage(im, { x: ix, y: y - ih, width: iw, height: ih });
      y -= ih + 8;
      return;
    }
    if (b.t === 'table') {
      const cols = Math.max(...b.rows.map((r) => r.length));
      const cw = width / cols;
      const pad = 4;
      for (const row of b.rows) {
        // measure
        let rh = 0;
        for (let k = 0; k < cols; k++) {
          let h = pad;
          for (const cb of row[k] || []) if (cb.t === 'p') h += (await layoutPara(cb, 0, cw - pad * 2, false, 0)).height + 2;
          rh = Math.max(rh, h + pad);
        }
        if (y - rh < M) newPage();
        for (let k = 0; k < cols; k++) {
          const cx = x + k * cw;
          page.drawRectangle({ x: cx, y: y - rh, width: cw, height: rh, borderColor: L.rgb(0.65, 0.65, 0.65), borderWidth: 0.6 });
          let cyy = y - pad;
          for (const cb of row[k] || []) if (cb.t === 'p') { const r = await layoutPara(cb, cx + pad, cw - pad * 2, true, cyy); cyy = r.endY - 2; }
        }
        y -= rh;
      }
      y -= 10;
      return;
    }
    // paragraph (maybe a list item)
    let indent = 0;
    if (b.list) {
      indent = 18 * (b.list.level + 1);
      const size = SIZES.normal;
      if (y - size * 1.32 < M) newPage();
      const by = y - size * 1.02;
      if (b.list.kind === 'bullet') page.drawCircle({ x: x + indent - 9, y: by + size * 0.3, size: b.list.level === 1 ? 1.8 : 2.1, color: L.rgb(0.1, 0.1, 0.1), borderColor: b.list.level === 1 ? L.rgb(0.1, 0.1, 0.1) : undefined, borderWidth: 0 });
      else {
        const key = `${b.list.id}:${b.list.level}`;
        listCounters[key] = (listCounters[key] || 0) + 1;
        for (const k of Object.keys(listCounters)) if (k.startsWith(`${b.list.id}:`) && +k.split(':')[1] > b.list.level) delete listCounters[k];
        const n = listCounters[key];
        const label = b.list.level === 1 ? String.fromCharCode(96 + ((n - 1) % 26) + 1) + '.' : `${n}.`;
        page.drawText(label, { x: x + indent - 16, y: by, size, font: reg, color: L.rgb(0.1, 0.1, 0.1) });
      }
    } else {
      for (const k of Object.keys(listCounters)) delete listCounters[k];
    }
    if (b.style !== 'normal') {
      const h = SIZES[b.style];
      if (y - h * 3 < M) newPage(); // keep a heading with what follows
      y -= h * 0.4;
    }
    const r = await layoutPara(b, x + indent, width - indent, true, y);
    y = r.endY - (b.list ? 2 : (SIZES[b.style] || 11) * 0.55);
  };

  for (const b of blocks) await drawBlock(b, M, PW - 2 * M);
  if (sourceHtml) {
    try { await doc.attach(strToU8(sourceHtml), 'syncpad-document.html', { mimeType: 'text/html', description: 'Editable SyncPad document' }); } catch {}
  }
  return doc.save();
}

/* ───────── spreadsheets, slides, CSV → read-only HTML ───────── */

const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

function tableHtml(rows) {
  const cols = Math.min(60, Math.max(1, ...rows.map((r) => r.length)));
  let h = '<table class="sheet-table"><thead><tr><th></th>';
  for (let c = 0; c < cols; c++) h += `<th>${colName(c)}</th>`;
  h += '</tr></thead><tbody>';
  rows.slice(0, 3000).forEach((r, i) => {
    h += `<tr><th>${i + 1}</th>`;
    for (let c = 0; c < cols; c++) {
      const v = r[c] == null ? '' : String(r[c]);
      h += `<td${/^-?[\d.,]+%?$/.test(v) ? ' class="num"' : ''}>${esc(v)}</td>`;
    }
    h += '</tr>';
  });
  return h + '</tbody></table>' + (rows.length > 3000 ? `<p class="muted">Showing the first 3,000 of ${rows.length} rows.</p>` : '');
}

export function readXlsx(bytes) {
  const z = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const xml = (p) => (z[p] ? new DOMParser().parseFromString(strFromU8(z[p]), 'application/xml') : null);
  const shared = [];
  const ss = xml('xl/sharedStrings.xml');
  if (ss) for (const si of ss.getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  const wb = xml('xl/workbook.xml');
  const rels = {};
  const rd = xml('xl/_rels/workbook.xml.rels');
  if (rd) for (const r of rd.getElementsByTagName('Relationship')) rels[r.getAttribute('Id')] = r.getAttribute('Target');
  // which number formats are dates
  const dateStyles = new Set();
  const st = xml('xl/styles.xml');
  if (st) {
    const custom = {};
    for (const nf of st.getElementsByTagName('numFmt')) custom[nf.getAttribute('numFmtId')] = nf.getAttribute('formatCode') || '';
    const xfs = st.getElementsByTagName('cellXfs')[0];
    if (xfs) [...xfs.getElementsByTagName('xf')].forEach((xf, i) => {
      const id = +xf.getAttribute('numFmtId');
      if ((id >= 14 && id <= 22) || (custom[id] && /[dy]/i.test(custom[id].replace(/"[^"]*"/g, '')) && !/^\[/.test(custom[id]))) dateStyles.add(i);
    });
  }
  const sheets = [];
  for (const s of wb ? wb.getElementsByTagName('sheet') : []) {
    const rid = s.getAttribute('r:id') || s.getAttributeNS(R, 'id');
    let target = rels[rid] || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    const sd = xml(target);
    if (!sd) continue;
    const rows = [];
    for (const row of sd.getElementsByTagName('row')) {
      const ri = (+row.getAttribute('r') || rows.length + 1) - 1;
      const out = [];
      for (const c of row.getElementsByTagName('c')) {
        const ref = c.getAttribute('r');
        const ci = ref ? colIndex(ref) : out.length;
        const t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0];
        let val = v ? v.textContent : '';
        if (t === 's') val = shared[+val] ?? '';
        else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
        else if (t === 'b') val = val === '1' ? 'TRUE' : 'FALSE';
        else if (val !== '' && dateStyles.has(+c.getAttribute('s'))) {
          const d = new Date(Math.round((+val - 25569) * 86400000));
          val = isNaN(d) ? val : d.toISOString().slice(0, +val % 1 ? 16 : 10).replace('T', ' ');
        } else if (/^-?\d+\.\d{6,}$/.test(val)) val = String(Math.round(+val * 1e6) / 1e6);
        out[ci] = val;
      }
      rows[ri] = out;
      if (rows.length > 20000) break;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    while (rows.length && !rows[rows.length - 1].some((x) => x != null && x !== '')) rows.pop();
    sheets.push({ name: s.getAttribute('name') || `Sheet ${sheets.length + 1}`, html: tableHtml(rows) });
  }
  return sheets;
}

export function readCsv(text) {
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : text.includes('\t') && !text.includes(',') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return [{ name: 'Sheet', html: tableHtml(rows) }];
}

export function readPptx(bytes) {
  const z = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const xml = (p) => (z[p] ? new DOMParser().parseFromString(strFromU8(z[p]), 'application/xml') : null);
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const pres = xml('ppt/presentation.xml');
  const prels = {};
  const pr = xml('ppt/_rels/presentation.xml.rels');
  if (pr) for (const r of pr.getElementsByTagName('Relationship')) prels[r.getAttribute('Id')] = r.getAttribute('Target');
  const order = pres ? [...pres.getElementsByTagNameNS('http://schemas.openxmlformats.org/presentationml/2006/main', 'sldId')].map((s) => prels[s.getAttributeNS(R, 'id') || s.getAttribute('r:id')]).filter(Boolean) : [];
  const slides = [];
  for (const t of order) {
    const path = 'ppt/' + t.replace(/^\.?\//, '');
    const sd = xml(path);
    if (!sd) continue;
    const rels = {};
    const rd = xml(path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'));
    if (rd) for (const r of rd.getElementsByTagName('Relationship')) rels[r.getAttribute('Id')] = r.getAttribute('Target');
    let html = '';
    for (const p of sd.getElementsByTagNameNS(A, 'p')) {
      const text = [...p.getElementsByTagNameNS(A, 't')].map((x) => x.textContent).join('');
      if (text.trim()) html += `<p>${esc(text)}</p>`;
    }
    for (const b of sd.getElementsByTagNameNS(A, 'blip')) {
      const target = rels[b.getAttributeNS(R, 'embed') || b.getAttribute('r:embed')];
      if (!target) continue;
      const mp = 'ppt/' + target.replace(/^\.\.\//, '');
      const data = z[mp];
      if (!data || data.length > 6e6) continue;
      const mime = /\.png$/i.test(mp) ? 'image/png' : /\.jpe?g$/i.test(mp) ? 'image/jpeg' : /\.gif$/i.test(mp) ? 'image/gif' : null;
      if (!mime) continue;
      let bin = '';
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
      html += `<img src="data:${mime};base64,${btoa(bin)}" alt="">`;
    }
    slides.push(html || '<p class="muted">(empty slide)</p>');
  }
  return slides;
}
