// PDF text editing core (no UI). Finds the text-showing operators of one line in a page's
// content stream, removes them for real (not just covered), and writes the new text in the
// original font when every character exists in it — otherwise in the closest matching font.
// Works with pdf-lib (passed in as `L`).

/* ───────── bytes ⇄ binary-safe strings ───────── */

export function bytesToStr(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
}
export function strToBytes(s) {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
  return u;
}

/* ───────── content stream lexer ───────── */

const isWS = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

function readLiteral(s, i) {
  // s[i] === '('
  let depth = 1;
  let out = '';
  i++;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const n = s[i + 1];
      if (n === undefined) { i++; break; }
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      if (n in map) { out += map[n]; i += 2; continue; }
      if (n >= '0' && n <= '7') {
        let o = n; i += 2;
        for (let k = 0; k < 2 && s[i] >= '0' && s[i] <= '7'; k++) o += s[i++];
        out += String.fromCharCode(parseInt(o, 8) & 255);
        continue;
      }
      if (n === '\r') { i += s[i + 2] === '\n' ? 3 : 2; continue; }
      if (n === '\n') { i += 2; continue; }
      out += n; i += 2; continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
    out += ch;
    i++;
  }
  return { v: out, end: i };
}

/** Tokenise a content stream into operators with their operands and source ranges */
export function parseContent(s) {
  const ops = [];
  let operands = [];
  let opStart = -1;
  const stack = []; // open arrays
  let i = 0;
  const push = (tok, start) => {
    if (opStart < 0 && !stack.length) opStart = start;
    else if (opStart < 0) opStart = start;
    if (stack.length) stack[stack.length - 1].push(tok);
    else operands.push(tok);
  };
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (isWS(c)) { i++; continue; }
    if (c === 37) { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; } // % comment
    const start = i;
    if (c === 40) { const r = readLiteral(s, i); i = r.end; push({ t: 'str', v: r.v, raw: s.slice(start, i) }, start); continue; }
    if (c === 60 && s[i + 1] === '<') { // dictionary: keep raw, skip nested
      let depth = 0;
      while (i < s.length) {
        if (s[i] === '<' && s[i + 1] === '<') { depth++; i += 2; continue; }
        if (s[i] === '>' && s[i + 1] === '>') { depth--; i += 2; if (!depth) break; continue; }
        if (s[i] === '(') { i = readLiteral(s, i).end; continue; }
        i++;
      }
      push({ t: 'dict', raw: s.slice(start, i) }, start);
      continue;
    }
    if (c === 60) {
      const j = s.indexOf('>', i);
      const hex = s.slice(i + 1, j < 0 ? s.length : j).replace(/[^0-9a-fA-F]/g, '');
      const h = hex.length % 2 ? hex + '0' : hex;
      let v = '';
      for (let k = 0; k < h.length; k += 2) v += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
      i = j < 0 ? s.length : j + 1;
      push({ t: 'str', v, raw: s.slice(start, i), hex: true }, start);
      continue;
    }
    if (c === 91) { if (opStart < 0) opStart = start; const arr = []; arr.start = start; stack.push(arr); i++; continue; }
    if (c === 93) {
      i++;
      const arr = stack.pop() || [];
      const tok = { t: 'arr', v: arr, raw: s.slice(arr.start ?? start, i) };
      if (stack.length) stack[stack.length - 1].push(tok); else operands.push(tok);
      continue;
    }
    if (c === 47) { // name
      i++;
      while (i < s.length && !isWS(s.charCodeAt(i)) && !isDelim(s.charCodeAt(i))) i++;
      push({ t: 'name', v: s.slice(start + 1, i).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), raw: s.slice(start, i) }, start);
      continue;
    }
    // number or operator keyword
    while (i < s.length && !isWS(s.charCodeAt(i)) && !isDelim(s.charCodeAt(i))) i++;
    if (i === start) { i++; continue; } // stray delimiter like ')' '>' '{' '}'
    const word = s.slice(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { push({ t: 'num', v: parseFloat(word), raw: word }, start); continue; }
    if (word === 'true' || word === 'false' || word === 'null') { push({ t: 'kw', v: word, raw: word }, start); continue; }
    // operator
    if (stack.length) { stack[stack.length - 1].push({ t: 'kw', v: word, raw: word }); continue; }
    if (word === 'BI') { // inline image: skip to EI after the binary data
      const id = s.indexOf('ID', i);
      let k = id < 0 ? s.length : id + 3;
      let end = s.length;
      while (k < s.length - 1) {
        if (s[k] === 'E' && s[k + 1] === 'I' && isWS(s.charCodeAt(k - 1)) && (k + 2 >= s.length || isWS(s.charCodeAt(k + 2)))) { end = k + 2; break; }
        k++;
      }
      ops.push({ op: 'BI', args: [], s0: opStart < 0 ? start : opStart, s1: end });
      i = end; operands = []; opStart = -1;
      continue;
    }
    ops.push({ op: word, args: operands, s0: opStart < 0 ? start : opStart, s1: i });
    operands = [];
    opStart = -1;
  }
  return ops;
}

/* ───────── fonts ───────── */

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]
];

let CP1252 = null;
function cp1252() {
  if (CP1252) return CP1252;
  const dec = new TextDecoder('windows-1252');
  const to = new Map();
  const from = new Map();
  for (let b = 32; b < 256; b++) {
    const ch = dec.decode(new Uint8Array([b]));
    if (ch && ch !== '�') { to.set(b, ch); if (!from.has(ch)) from.set(ch, b); }
  }
  return (CP1252 = { to, from });
}

function parseToUnicode(str) {
  const map = new Map(); // code → unicode string
  let bytes = 1;
  const hexToStr = (h) => { let o = ''; for (let k = 0; k + 3 < h.length + 0; k += 4) o += String.fromCharCode(parseInt(h.slice(k, k + 4), 16)); return o; };
  const u16 = (h) => (h.length <= 2 ? String.fromCharCode(parseInt(h, 16)) : hexToStr(h.padEnd(Math.ceil(h.length / 4) * 4, '0')));
  for (const m of str.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      bytes = Math.max(bytes, p[1].length / 2);
      map.set(parseInt(p[1], 16), u16(p[2]));
    }
  }
  for (const m of str.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      bytes = Math.max(bytes, p[1].length / 2);
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      if (hi - lo > 65535) continue;
      if (p[4] !== undefined) {
        const base = u16(p[4]);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      } else {
        const list = [...p[5].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => u16(x[1]));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
      }
    }
  }
  return { map, bytes };
}

function makeFontReader(L, doc, fontsDict) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFNumber, decodePDFRawStream } = L;
  const cache = new Map();
  const num = (o) => (o instanceof PDFNumber ? o.asNumber() : typeof o?.asNumber === 'function' ? o.asNumber() : NaN);
  const look = (dict, key) => { try { return dict.lookup(PDFName.of(key)); } catch { return undefined; } };
  const nameOf = (o) => (o && typeof o.decodeText === 'function' ? o.decodeText() : o ? String(o).replace(/^\//, '') : '');
  return (res) => {
    if (cache.has(res)) return cache.get(res);
    let info = { res, base: '', bpc: 1, widths: new Map(), dw: 500, toUni: null, fromUni: null, subset: false, ok: false };
    try {
      const fd = fontsDict && fontsDict.lookup(PDFName.of(res));
      if (fd instanceof PDFDict) {
        const sub = nameOf(look(fd, 'Subtype'));
        info.base = nameOf(look(fd, 'BaseFont'));
        info.subset = /^[A-Z]{6}\+/.test(info.base);
        info.type0 = sub === 'Type0';
        const tu = look(fd, 'ToUnicode');
        if (tu instanceof PDFRawStream) {
          const p = parseToUnicode(bytesToStr(decodePDFRawStream(tu).decode()));
          info.toUni = p.map;
          info.bpc = info.type0 ? Math.max(2, p.bytes) : 1;
        }
        if (info.type0) {
          info.bpc = Math.max(info.bpc, 2);
          const enc = nameOf(look(fd, 'Encoding'));
          info.identity = /Identity-H/.test(enc);
          const df = look(fd, 'DescendantFonts');
          const d0 = df instanceof PDFArray ? df.lookup(0) : null;
          if (d0 instanceof PDFDict) {
            const dw = num(look(d0, 'DW'));
            info.dw = Number.isFinite(dw) ? dw : 1000;
            const W = look(d0, 'W');
            if (W instanceof PDFArray) {
              const a = W.asArray().map((x) => doc.context.lookup(x) || x);
              for (let k = 0; k < a.length;) {
                const c0 = num(a[k]);
                const nx = a[k + 1];
                if (nx instanceof PDFArray) {
                  nx.asArray().forEach((w, j) => info.widths.set(c0 + j, num(doc.context.lookup(w) || w)));
                  k += 2;
                } else {
                  const c1 = num(nx);
                  const w = num(a[k + 2]);
                  for (let c = c0; c <= c1 && c - c0 < 65536; c++) info.widths.set(c, w);
                  k += 3;
                }
              }
            }
          }
        } else {
          const first = num(look(fd, 'FirstChar'));
          const W = look(fd, 'Widths');
          if (W instanceof PDFArray && Number.isFinite(first)) W.asArray().forEach((w, j) => info.widths.set(first + j, num(doc.context.lookup(w) || w)));
          const desc = look(fd, 'FontDescriptor');
          const mw = desc instanceof PDFDict ? num(look(desc, 'MissingWidth')) : NaN;
          info.dw = Number.isFinite(mw) ? mw : info.widths.size ? 0 : 500;
          const enc = look(fd, 'Encoding');
          info.encName = nameOf(enc instanceof PDFDict ? look(enc, 'BaseEncoding') : enc);
          info.differences = enc instanceof PDFDict && !!look(enc, 'Differences');
          info.embedded = desc instanceof PDFDict && !!(look(desc, 'FontFile') || look(desc, 'FontFile2') || look(desc, 'FontFile3'));
        }
        // characters we may write with this font
        if (info.toUni) {
          info.fromToUnicode = true;
          info.fromUni = new Map();
          for (const [code, u] of info.toUni) if (u.length === 1 && !info.fromUni.has(u)) info.fromUni.set(u, code);
        } else if (!info.type0 && !info.differences && (/WinAnsi/.test(info.encName) || (!info.encName && !info.embedded))) {
          info.fromUni = new Map(cp1252().from);
          info.toUni = cp1252().to;
        }
        info.ok = true;
      }
    } catch {}
    cache.set(res, info);
    return info;
  };
}

function codesOf(str, bpc) {
  const out = [];
  for (let k = 0; k + bpc <= str.length; k += bpc) {
    let c = 0;
    for (let j = 0; j < bpc; j++) c = c * 256 + str.charCodeAt(k + j);
    out.push(c);
  }
  return out;
}

/* ───────── interpreter: where every piece of text lands ───────── */

export function locateText(ops, fontOf) {
  const shows = [];
  const gstack = [];
  let g = { ctm: [1, 0, 0, 1, 0, 0], font: null, size: 0, Tc: 0, Tw: 0, Tz: 100, TL: 0, Ts: 0, fill: null, fillCS: 'DeviceGray' };
  let Tm = [1, 0, 0, 1, 0, 0];
  let Tlm = [1, 0, 0, 1, 0, 0];
  let bt = -1;
  const nums = (a) => a.map((x) => (x.t === 'num' ? x.v : 0));
  const td = (tx, ty) => { Tlm = mul([1, 0, 0, 1, tx, ty], Tlm); Tm = Tlm.slice(); };
  const advance = (tx) => { Tm = mul([1, 0, 0, 1, tx, 0], Tm); };
  const show = (i, op, items) => {
    const f = g.font ? fontOf(g.font) : null;
    const bpc = f ? f.bpc : 1;
    const Th = g.Tz / 100;
    const M = mul(Tm, g.ctm);
    const x = M[2] * g.Ts + M[4];
    const y = M[3] * g.Ts + M[5];
    const codes = [];
    for (const it of items) {
      if (it.t === 'num') { advance(-(it.v / 1000) * g.size * Th); continue; }
      if (it.t !== 'str') continue;
      for (const c of codesOf(it.v, bpc)) {
        codes.push(c);
        const w0 = f ? (f.widths.has(c) ? f.widths.get(c) : f.dw) : 500;
        advance((w0 / 1000 * g.size + g.Tc + (bpc === 1 && c === 32 ? g.Tw : 0)) * Th);
      }
    }
    const M2 = mul(Tm, g.ctm);
    shows.push({ i, op, bt, x, y, x2: M2[2] * g.Ts + M2[4], font: g.font, size: g.size, eff: g.size * Math.hypot(M[2], M[3]), up: Math.abs(M[1]) < 1e-3 && Math.abs(M[2]) < 1e-3 && M[0] > 0 && M[3] > 0, fill: g.fill, fillCS: g.fillCS, codes });
  };
  ops.forEach((o, i) => {
    const a = o.args;
    switch (o.op) {
      case 'q': gstack.push({ ...g, ctm: g.ctm.slice() }); break;
      case 'Q': if (gstack.length) g = gstack.pop(); break;
      case 'cm': g.ctm = mul(nums(a), g.ctm); break;
      case 'BT': bt = i; Tm = [1, 0, 0, 1, 0, 0]; Tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'ET': bt = -1; break;
      case 'Tf': g.font = a[0] && a[0].t === 'name' ? a[0].v : g.font; g.size = a[1] && a[1].t === 'num' ? a[1].v : g.size; break;
      case 'Tc': g.Tc = nums(a)[0] || 0; break;
      case 'Tw': g.Tw = nums(a)[0] || 0; break;
      case 'Tz': g.Tz = nums(a)[0] ?? 100; break;
      case 'TL': g.TL = nums(a)[0] || 0; break;
      case 'Ts': g.Ts = nums(a)[0] || 0; break;
      case 'Td': { const [x, y] = nums(a); td(x, y); break; }
      case 'TD': { const [x, y] = nums(a); g.TL = -y; td(x, y); break; }
      case 'Tm': Tlm = nums(a).slice(0, 6); Tm = Tlm.slice(); break;
      case 'T*': td(0, -g.TL); break;
      case 'Tj': show(i, o, a.filter((x) => x.t === 'str')); break;
      case 'TJ': show(i, o, (a.find((x) => x.t === 'arr') || { v: [] }).v); break;
      case "'": td(0, -g.TL); show(i, o, a.filter((x) => x.t === 'str')); break;
      case '"': { const n = nums(a); g.Tw = n[0]; g.Tc = n[1]; td(0, -g.TL); show(i, o, a.filter((x) => x.t === 'str')); break; }
      case 'g': g.fill = { cs: 'gray', v: nums(a) }; g.fillCS = 'DeviceGray'; break;
      case 'rg': g.fill = { cs: 'rgb', v: nums(a) }; g.fillCS = 'DeviceRGB'; break;
      case 'k': g.fill = { cs: 'cmyk', v: nums(a) }; g.fillCS = 'DeviceCMYK'; break;
      case 'cs': g.fillCS = a[0] && a[0].t === 'name' ? a[0].v : g.fillCS; g.fill = null; break;
      case 'sc': case 'scn': {
        const n = a.filter((x) => x.t === 'num').map((x) => x.v);
        g.fill = n.length === 1 ? { cs: 'gray', v: n } : n.length === 3 ? { cs: 'rgb', v: n } : n.length === 4 ? { cs: 'cmyk', v: n } : null;
        break;
      }
      default: break;
    }
  });
  return shows;
}

/* ───────── choosing a look-alike font ───────── */

export function pickFont(base) {
  const n = String(base || '').replace(/^[A-Z]{6}\+/, '');
  const bold = /bold|black|heavy|semibold|demi/i.test(n);
  const italic = /italic|oblique|-it\b|ital/i.test(n);
  const style = `${bold ? 700 : 400}-${italic ? 'italic' : 'normal'}`;
  if (/calibri|carlito/i.test(n)) return { file: `carlito-latin-${style}.woff`, css: 'Carlito, Calibri, sans-serif' };
  if (/cambria|caladea/i.test(n)) return { file: `caladea-latin-${style}.woff`, css: 'Caladea, Cambria, serif' };
  if (/courier|mono|consol|menlo|code/i.test(n)) return { std: bold ? (italic ? 'CourierBoldOblique' : 'CourierBold') : italic ? 'CourierOblique' : 'Courier', css: '"Courier New", monospace', bold, italic };
  if (/times|georgia|garamond|book|roman|minion|palatino|serif/i.test(n) && !/sans/i.test(n)) {
    return { std: bold ? (italic ? 'TimesRomanBoldItalic' : 'TimesRomanBold') : italic ? 'TimesRomanItalic' : 'TimesRoman', css: '"Times New Roman", Times, serif', bold, italic };
  }
  return { std: bold ? (italic ? 'HelveticaBoldOblique' : 'HelveticaBold') : italic ? 'HelveticaOblique' : 'Helvetica', css: 'Arial, Helvetica, sans-serif', bold, italic };
}

function toRgb(L, fill, fallback) {
  const c = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  if (fill && fill.cs === 'gray') return L.rgb(c(fill.v[0]), c(fill.v[0]), c(fill.v[0]));
  if (fill && fill.cs === 'rgb') return L.rgb(c(fill.v[0]), c(fill.v[1]), c(fill.v[2]));
  if (fill && fill.cs === 'cmyk') { const [C, M, Y, K] = fill.v.map(c); return L.rgb((1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)); }
  const f = fallback || [0, 0, 0];
  return L.rgb(c(f[0]), c(f[1]), c(f[2]));
}

/* ───────── the edit ───────── */

/**
 * Replace (or delete, when text is '') one line of text on a page.
 * edit = { page, line: { x0, x1, y, size }, text, bg: [r,g,b], color: [r,g,b] } (colours 0..1, PDF user space)
 * loadFontFile(name) → ArrayBuffer of a bundled look-alike font; fontkit: the fontkit module.
 * Returns { bytes, mode: 'same' | 'match' | 'cover' }.
 */
export async function applyLineEdit(L, fontkit, bytes, edit, loadFontFile) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream, StandardFonts } = L;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(edit.page);
  const contents = page.node.Contents();
  const parts = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : contents ? [contents] : [];
  const src = parts.map((st) => {
    if (st instanceof PDFRawStream) return bytesToStr(decodePDFRawStream(st).decode());
    if (st && typeof st.getUnencodedContents === 'function') return bytesToStr(st.getUnencodedContents());
    if (st && typeof st.getContents === 'function') return bytesToStr(st.getContents());
    return '';
  }).join('\n');

  const res = page.node.Resources();
  const fontsDict = res ? res.lookupMaybe(PDFName.of('Font'), PDFDict) : undefined;
  const fontOf = makeFontReader(L, doc, fontsDict);
  const ops = parseContent(src);
  const shows = locateText(ops, fontOf);

  const { x0, x1, y, size } = edit.line;
  const hit = shows.filter((r) => r.up && Math.abs(r.y - y) < size * 0.45 && r.x >= x0 - size * 0.6 && r.x <= x1 + size * 0.15 && r.x2 > r.x - 1e-6);
  const removed = new Set(hit.map((r) => r.i));

  // a kept piece of text that continues right after a removed one (no new position) would shift
  let conflict = false;
  if (removed.size) {
    let pending = false;
    for (let i = 0; i < ops.length && !conflict; i++) {
      const o = ops[i].op;
      if (o === 'BT' || o === 'ET' || o === 'Td' || o === 'TD' || o === 'Tm' || o === 'T*') pending = false;
      else if (o === 'Tj' || o === 'TJ' || o === "'" || o === '"') {
        if (removed.has(i)) pending = true;
        else if (pending && (o === 'Tj' || o === 'TJ')) conflict = true;
        else pending = false;
      }
    }
  }

  const text = String(edit.text || '');
  let mode = 'same';
  let drawAt = null;
  let cover = null;
  let anchor = null;
  let codes = null;
  let f = null;

  if (!removed.size || conflict) {
    // fallback: paint over the line, then write the new text on top (the old text stays underneath)
    mode = 'cover';
    removed.clear();
    cover = { x: x0 - size * 0.12, y: y - size * 0.3, w: x1 - x0 + size * 0.24, h: size * 1.25 };
    drawAt = { x: x0, y, size, color: toRgb(L, null, edit.color), base: edit.fontName || '' };
  } else {
    anchor = hit.slice().sort((a, b) => a.x - b.x)[0];
    f = fontOf(anchor.font);
    if (text && f.ok && f.fromUni && (!f.type0 || f.identity)) {
      // subset fonts only carry the letters the document used
      const used = f.subset && !f.fromToUnicode ? new Set(shows.filter((r) => r.font === anchor.font).flatMap((r) => r.codes)) : null;
      codes = [];
      for (const ch of text) {
        const code = f.fromUni.get(ch);
        if (code == null || (used && !used.has(code))) { codes = null; break; }
        codes.push(code);
      }
    }
    if (text && !codes) {
      mode = 'match';
      drawAt = { x: anchor.x, y: anchor.y, size: anchor.eff || size, color: toRgb(L, anchor.fill, edit.color), base: f.base || edit.fontName || '' };
    }
  }
  const showOf = (o) => {
    const hex = codes.map((c) => c.toString(16).padStart(f.bpc * 2, '0')).join('').toUpperCase();
    const tj = `<${hex}> Tj`;
    if (o.op === "'") return `T* ${tj}`;
    if (o.op === '"') return `${o.args[0]?.raw || 0} Tw ${o.args[1]?.raw || 0} Tc T* ${tj}`;
    return tj;
  };
  const positionOnly = (o) => (o.op === "'" ? 'T*' : o.op === '"' ? `${o.args[0]?.raw || 0} Tw ${o.args[1]?.raw || 0} Tc T*` : '');
  let out = '';
  let last = 0;
  ops.forEach((o, i) => {
    if (!removed.has(i)) return;
    out += src.slice(last, o.s0);
    out += anchor && i === anchor.i && codes && codes.length ? showOf(o) : positionOnly(o);
    last = o.s1;
  });
  out += src.slice(last);
  // keep the page's own drawing state from leaking into what we add after it
  if (!out.startsWith('q %sp\n')) out = `q %sp\n${out}\nQ %sp`;
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(strToBytes(out))));
  if (cover) page.drawRectangle({ x: cover.x, y: cover.y, width: cover.w, height: cover.h, color: toRgb(L, null, edit.bg || [1, 1, 1]) });

  if (drawAt && text) {
    const pick = pickFont(drawAt.base);
    let font;
    const tryStd = async (key) => doc.embedFont(StandardFonts[key]);
    try {
      if (pick.file) {
        doc.registerFontkit(fontkit);
        font = await doc.embedFont(await loadFontFile(pick.file), { subset: true });
      } else font = await tryStd(pick.std);
      font.encodeText(text); // standard fonts throw when a character isn't available
      const fk = font.embedder && font.embedder.font;
      if (fk && [...text].some((ch) => ch.trim() && !fk.hasGlyphForCodePoint(ch.codePointAt(0)))) throw new Error('glyph');
    } catch {
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(await loadFontFile(`carlito-latin-${pick.bold ? 700 : 400}-${pick.italic ? 'italic' : 'normal'}.woff`), { subset: true });
      const fk = font.embedder && font.embedder.font;
      const missing = [...new Set([...text].filter((ch) => ch.trim() && fk && !fk.hasGlyphForCodePoint(ch.codePointAt(0))))];
      if (missing.length) { const e = new Error('chars'); e.chars = missing.join(' '); throw e; }
    }
    page.drawText(text, { x: drawAt.x, y: drawAt.y, size: drawAt.size, font, color: drawAt.color });
  }

  return { bytes: await doc.save(), mode };
}
