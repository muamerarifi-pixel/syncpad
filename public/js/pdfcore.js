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

/* ───────── interpreter: where every piece of text and every picture lands ───────── */

const POS_OPS = new Set(['BT', 'ET', 'Td', 'TD', 'Tm', 'T*']);

export function locateText(ops, fontOf) {
  const shows = [];
  const draws = [];
  const gstack = [];
  let g = { ctm: [1, 0, 0, 1, 0, 0], font: null, size: 0, Tc: 0, Tw: 0, Tz: 100, TL: 0, Ts: 0, fill: null, fillCS: 'DeviceGray' };
  let Tm = [1, 0, 0, 1, 0, 0];
  let Tlm = [1, 0, 0, 1, 0, 0];
  let bt = -1;
  let cont = false; // the next show continues where the previous one ended
  const nums = (a) => a.map((x) => (x.t === 'num' ? x.v : 0));
  const td = (tx, ty) => { Tlm = mul([1, 0, 0, 1, tx, ty], Tlm); Tm = Tlm.slice(); };
  const advance = (tx) => { Tm = mul([1, 0, 0, 1, tx, 0], Tm); };
  const show = (i, op, items, repositioned) => {
    const f = g.font ? fontOf(g.font) : null;
    const bpc = f ? f.bpc : 1;
    const Th = g.Tz / 100;
    let M = mul(Tm, g.ctm);
    let x = M[2] * g.Ts + M[4];
    let y = M[3] * g.Ts + M[5];
    const codes = [];
    for (const it of items) {
      if (it.t === 'num') { advance(-(it.v / 1000) * g.size * Th); continue; }
      if (it.t !== 'str') continue;
      for (const c of codesOf(it.v, bpc)) {
        if (!codes.length) { M = mul(Tm, g.ctm); x = M[2] * g.Ts + M[4]; y = M[3] * g.Ts + M[5]; } // where the first letter really starts
        codes.push(c);
        const w0 = f ? (f.widths.has(c) ? f.widths.get(c) : f.dw) : 500;
        advance((w0 / 1000 * g.size + g.Tc + (bpc === 1 && c === 32 ? g.Tw : 0)) * Th);
      }
    }
    const M2 = mul(Tm, g.ctm);
    shows.push({
      i, op, bt, x, y, x2: M2[2] * g.Ts + M2[4], font: g.font, size: g.size, Tc: g.Tc, Tw: g.Tw, Th, sx: M[0],
      eff: g.size * Math.hypot(M[2], M[3]), up: Math.abs(M[1]) < 1e-3 && Math.abs(M[2]) < 1e-3 && M[0] > 0 && M[3] > 0,
      fill: g.fill, codes, cont: cont && !repositioned
    });
    cont = true;
  };
  ops.forEach((o, i) => {
    const a = o.args;
    if (POS_OPS.has(o.op)) cont = false;
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
      case "'": td(0, -g.TL); show(i, o, a.filter((x) => x.t === 'str'), true); break;
      case '"': { const n = nums(a); g.Tw = n[0]; g.Tc = n[1]; td(0, -g.TL); show(i, o, a.filter((x) => x.t === 'str'), true); break; }
      case 'g': g.fill = { cs: 'gray', v: nums(a) }; g.fillCS = 'DeviceGray'; break;
      case 'rg': g.fill = { cs: 'rgb', v: nums(a) }; g.fillCS = 'DeviceRGB'; break;
      case 'k': g.fill = { cs: 'cmyk', v: nums(a) }; g.fillCS = 'DeviceCMYK'; break;
      case 'cs': g.fillCS = a[0] && a[0].t === 'name' ? a[0].v : g.fillCS; g.fill = null; break;
      case 'sc': case 'scn': {
        const n = a.filter((x) => x.t === 'num').map((x) => x.v);
        g.fill = n.length === 1 ? { cs: 'gray', v: n } : n.length === 3 ? { cs: 'rgb', v: n } : n.length === 4 ? { cs: 'cmyk', v: n } : null;
        break;
      }
      case 'Do': if (a[0] && a[0].t === 'name') draws.push({ i, name: a[0].v, ctm: g.ctm.slice() }); break;
      case 'BI': draws.push({ i, inline: true, ctm: g.ctm.slice() }); break;
      default: break;
    }
  });
  return { shows, draws };
}

/* ───────── choosing a look-alike font ───────── */

export function pickFont(base) {
  const n = String(base || '').replace(/^[A-Z]{6}\+/, '');
  const bold = /bold|black|heavy|semibold|demi/i.test(n);
  const italic = /italic|oblique|-it\b|ital/i.test(n);
  const style = `${bold ? 700 : 400}-${italic ? 'italic' : 'normal'}`;
  if (/calibri|carlito/i.test(n)) return { file: `carlito-latin-${style}.woff`, css: 'Carlito, Calibri, sans-serif', bold, italic };
  if (/cambria|caladea/i.test(n)) return { file: `caladea-latin-${style}.woff`, css: 'Caladea, Cambria, serif', bold, italic };
  if (/courier|mono|consol|menlo|code/i.test(n)) return { std: bold ? (italic ? 'CourierBoldOblique' : 'CourierBold') : italic ? 'CourierOblique' : 'Courier', css: '"Courier New", monospace', bold, italic };
  if (/times|georgia|garamond|book|roman|minion|palatino|serif/i.test(n) && !/sans/i.test(n)) {
    return { std: bold ? (italic ? 'TimesRomanBoldItalic' : 'TimesRomanBold') : italic ? 'TimesRomanItalic' : 'TimesRoman', css: '"Times New Roman", Times, serif', bold, italic };
  }
  return { std: bold ? (italic ? 'HelveticaBoldOblique' : 'HelveticaBold') : italic ? 'HelveticaOblique' : 'Helvetica', css: 'Arial, Helvetica, sans-serif', bold, italic };
}

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
/** fill colour → [r,g,b] 0..1 (null when unknown, e.g. patterns) */
export function fillRgb(fill) {
  if (!fill) return null;
  if (fill.cs === 'gray') return [clamp01(fill.v[0]), clamp01(fill.v[0]), clamp01(fill.v[0])];
  if (fill.cs === 'rgb') return fill.v.slice(0, 3).map(clamp01);
  if (fill.cs === 'cmyk') { const [C, M, Y, K] = fill.v.map(clamp01); return [(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)]; }
  return null;
}
const toRgb = (L, fill, fallback) => { const c = fillRgb(fill) || fallback || [0, 0, 0]; return L.rgb(clamp01(c[0]), clamp01(c[1]), clamp01(c[2])); };

/* ───────── reading / writing a page ───────── */

export function loadDoc(L, bytes) {
  return L.PDFDocument.load(bytes, { updateMetadata: false });
}

function readPage(L, doc, index) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = L;
  const page = doc.getPage(index);
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
  const xobjs = res ? res.lookupMaybe(PDFName.of('XObject'), PDFDict) : undefined;
  const fontOf = makeFontReader(L, doc, fontsDict);
  const ops = parseContent(src);
  const { shows, draws } = locateText(ops, fontOf);
  return { page, src, ops, shows, draws, fontOf, fontsDict, xobjs, res };
}

function writePage(L, doc, P, out) {
  if (!out.startsWith('q %sp\n')) out = `q %sp\n${out}\nQ %sp`; // the page's own drawing state can't leak into what we add after it
  P.page.node.set(L.PDFName.of('Contents'), doc.context.register(doc.context.flateStream(strToBytes(out))));
}

/** Rewrite the stream: replace / drop operators (by index) */
function rewrite(src, ops, repl) {
  let out = '';
  let last = 0;
  ops.forEach((o, i) => {
    if (!repl.has(i)) return;
    out += src.slice(last, o.s0) + repl.get(i);
    last = o.s1;
  });
  return out + src.slice(last);
}

const positionOnly = (o) => (o.op === "'" ? 'T*' : o.op === '"' ? `${o.args[0]?.raw || 0} Tw ${o.args[1]?.raw || 0} Tc T*` : '');

/** Same text-show operator, but starting n thousandths of an em further left (negative n = right) */
function shifted(o, n) {
  const k = Math.round(n * 100) / 100;
  if (o.op === 'TJ') {
    const arr = o.args.find((x) => x.t === 'arr');
    return `[${k} ${arr ? arr.raw.slice(1, -1) : ''}] TJ`;
  }
  const strs = o.args.filter((x) => x.t === 'str').map((x) => x.raw).join(' ');
  return `${positionOnly(o)} [${k} ${strs}] TJ`.trim();
}

/** What a page holds: text pieces and pictures (for the editor's hit boxes) */
export function pageInfo(L, doc, index) {
  const P = readPage(L, doc, index);
  const images = [];
  for (const d of P.draws) {
    let isImage = !!d.inline;
    if (!isImage && P.xobjs) {
      try {
        const x = P.xobjs.lookup(L.PDFName.of(d.name));
        const sub = x && x.dict ? x.dict.lookup(L.PDFName.of('Subtype')) : null;
        isImage = !!sub && String(sub) === '/Image';
      } catch {}
    }
    if (!isImage) continue;
    const m = d.ctm;
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    images.push({ op: d.i, name: d.inline ? null : d.name, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
  }
  const shows = P.shows.filter((r) => r.up).map((r) => ({ x: r.x, y: r.y, x2: r.x2, font: r.font, eff: r.eff, fill: fillRgb(r.fill), base: P.fontOf(r.font).base }));
  return { images, shows };
}

/** Remove one picture (the operator that draws it) */
export async function removeImage(L, bytes, index, op) {
  const doc = await loadDoc(L, bytes);
  const P = readPage(L, doc, index);
  const o = P.ops[op];
  if (!o || (o.op !== 'Do' && o.op !== 'BI')) throw new Error('gone');
  writePage(L, doc, P, rewrite(P.src, P.ops, new Map([[op, '']])));
  return doc.save();
}

/* ───────── fonts for new text ───────── */

async function lookAlike(L, doc, fontkit, base, text, loadFontFile) {
  const pick = pickFont(base);
  let font;
  try {
    if (pick.file) {
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(await loadFontFile(pick.file), { subset: true });
    } else font = await doc.embedFont(L.StandardFonts[pick.std]);
    font.encodeText(text); // standard fonts throw when a character isn't available
    const fk = font.embedder && font.embedder.font;
    if (fk && typeof fk.hasGlyphForCodePoint === 'function' && [...text].some((ch) => ch.trim() && !fk.hasGlyphForCodePoint(ch.codePointAt(0)))) throw new Error('glyph');
  } catch {
    doc.registerFontkit(fontkit);
    font = await doc.embedFont(await loadFontFile(`carlito-latin-${pick.bold ? 700 : 400}-${pick.italic ? 'italic' : 'normal'}.woff`), { subset: true });
    const fk = font.embedder && font.embedder.font;
    const missing = [...new Set([...text].filter((ch) => ch.trim() && fk && !fk.hasGlyphForCodePoint(ch.codePointAt(0))))];
    if (missing.length) { const e = new Error('chars'); e.chars = missing.join(' '); throw e; }
  }
  return font;
}

/** Codes for text in a page font, or null when a letter isn't available in it */
function encodeIn(f, text, usedCodes) {
  if (!f || !f.ok || !f.fromUni || (f.type0 && !f.identity)) return null;
  const used = f.subset && !f.fromToUnicode ? usedCodes : null;
  const codes = [];
  for (const ch of text) {
    const c = f.fromUni.get(ch);
    if (c == null || (used && !used.has(c))) return null;
    codes.push(c);
  }
  return codes;
}
const hexOf = (codes, bpc) => '<' + codes.map((c) => c.toString(16).padStart(bpc * 2, '0')).join('').toUpperCase() + '>';

/* ───────── editing one line ───────── */

/**
 * Change (or delete, when text is '') one line. Only the part that changed is rewritten, so the
 * other words keep their own colour / font, and words after the change move with it.
 * edit = { page, line: { x0, x1, y, size }, oldText, text, bg, color, fontName } (colours 0..1, PDF space)
 * Returns { bytes, mode: 'same' | 'match' | 'cover' }.
 */
export async function applyLineEdit(L, fontkit, bytes, edit, loadFontFile) {
  const doc = await loadDoc(L, bytes);
  const P = readPage(L, doc, edit.page);
  const { ops, shows, fontOf, src, page } = P;
  const { x0, x1, y, size } = edit.line;
  const text = String(edit.text || '').replace(/\s+$/, '');
  const runs = shows
    .filter((r) => r.up && Math.abs(r.y - y) < size * 0.45 && r.x >= x0 - size * 0.6 && r.x <= x1 + size * 0.15)
    .sort((a, b) => a.x - b.x);

  if (!runs.length) {
    // text we can't reach (e.g. inside a form object): paint over it and write on top
    writePage(L, doc, P, src);
    page.drawRectangle({ x: x0 - size * 0.12, y: y - size * 0.3, width: x1 - x0 + size * 0.24, height: size * 1.25, color: toRgb(L, null, edit.bg || [1, 1, 1]) });
    if (text) {
      const font = await lookAlike(L, doc, fontkit, edit.fontName, text, loadFontFile);
      page.drawText(text, { x: x0, y, size, font, color: toRgb(L, null, edit.color) });
    }
    return { bytes: await doc.save(), mode: 'cover' };
  }

  // which pieces changed? (compare the old and new line, keep unchanged pieces at both ends)
  let first = 0;
  let last = runs.length - 1;
  let middle = text;
  const dec = runs.map((r) => { const f = fontOf(r.font); return f.toUni ? r.codes.map((c) => f.toUni.get(c) ?? '').join('') : null; });
  if (text && dec.every((d) => d != null)) {
    let S = '';
    const spans = [];
    runs.forEach((r, k) => {
      let t = dec[k].replace(/\s+/g, ' ');
      if (k > 0 && r.x - runs[k - 1].x2 > size * 0.15 && !S.endsWith(' ') && !t.startsWith(' ')) S += ' ';
      if (S.endsWith(' ') && t.startsWith(' ')) t = t.slice(1);
      spans.push([S.length, S.length + t.length]);
      S += t;
    });
    const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    if (norm(S) === norm(edit.oldText) && S === S.trimStart()) {
      const T = norm(text) + (S.match(/\s*$/)[0] || '');
      let p = 0;
      while (p < S.length && p < T.length && S[p] === T[p]) p++;
      let s = 0;
      while (s < S.length - p && s < T.length - p && S[S.length - 1 - s] === T[T.length - 1 - s]) s++;
      const inPrefix = (k) => spans[k][1] <= p;
      const inSuffix = (k) => spans[k][0] >= S.length - s;
      const mids = runs.map((_, k) => k).filter((k) => !inPrefix(k) && !inSuffix(k));
      if (mids.length) { first = mids[0]; last = mids[mids.length - 1]; }
      else { const at = spans.findIndex((sp) => sp[0] >= p); first = last = at < 0 ? runs.length - 1 : at; }
      while (first > 0 && spans[first][0] > p) first--;
      while (last < runs.length - 1 && spans[last][1] < S.length - s) last++;
      const mStart = spans[first][0];
      const mEnd = spans[last][1];
      middle = T.slice(mStart, T.length - (S.length - mEnd));
    }
  }

  const mid = runs.slice(first, last + 1);
  const anchor = mid[0];
  const f = fontOf(anchor.font);
  const usedCodes = new Set(shows.filter((r) => r.font === anchor.font).flatMap((r) => r.codes));
  const codes = middle ? encodeIn(f, middle, usedCodes) : null;
  let mode = 'same';
  let font = null;
  let newWidth = 0;
  if (middle && codes) {
    for (const c of codes) newWidth += (((f.widths.has(c) ? f.widths.get(c) : f.dw) / 1000) * anchor.size + anchor.Tc + (f.bpc === 1 && c === 32 ? anchor.Tw : 0)) * anchor.Th * anchor.sx;
  } else if (middle) {
    mode = 'match';
    font = await lookAlike(L, doc, fontkit, f.base || edit.fontName, middle, loadFontFile);
    newWidth = font.widthOfTextAtSize(middle, anchor.eff || size);
  }
  const oldWidth = Math.max(...mid.map((r) => r.x2)) - anchor.x;
  const dx = newWidth - oldWidth;

  // pass 1: replace the changed pieces
  const repl = new Map();
  const midIdx = new Set(mid.map((r) => r.i));
  for (const r of mid) {
    const o = ops[r.i];
    if (r === anchor && mode === 'same' && codes && codes.length) {
      const tj = `${hexOf(codes, f.bpc)} Tj`;
      repl.set(r.i, o.op === "'" ? `T* ${tj}` : o.op === '"' ? `${positionOnly(o)} ${tj}` : tj);
    } else repl.set(r.i, positionOnly(o));
  }
  const out1 = rewrite(src, ops, repl);

  // pass 2: everything that came after must stay where it was (words after the change move by dx)
  const ops2 = parseContent(out1);
  const shows2 = locateText(ops2, fontOf).shows;
  const kept = shows.filter((r) => !midIdx.has(r.i));
  const replaced = mode === 'same' && codes && codes.length;
  const at = replaced ? kept.filter((r) => r.i < anchor.i).length : -1; // the new piece's place among the shows
  const suffix = new Set(runs.slice(last + 1).map((r) => r.i));
  const repl2 = new Map();
  if (shows2.length === kept.length + (replaced ? 1 : 0)) {
    let carry = 0;
    let k = 0;
    shows2.forEach((r2, j) => {
      if (!r2.cont) carry = 0;
      if (j === at) return; // the rewritten piece sits where the old one started
      const r = kept[k++];
      const want = r.x + (suffix.has(r.i) ? dx : 0);
      const need = want - (r2.x + carry);
      if (Math.abs(need) > Math.max(0.05, size * 0.01) && r2.size && r2.sx) {
        repl2.set(r2.i, shifted(ops2[r2.i], -(need / r2.sx) * 1000 / (r2.size * r2.Th)));
        carry += need;
      }
    });
  }
  writePage(L, doc, P, repl2.size ? rewrite(out1, ops2, repl2) : out1);
  if (mode === 'match') page.drawText(middle, { x: anchor.x, y: anchor.y, size: anchor.eff || size, font, color: toRgb(L, anchor.fill, edit.color) });
  return { bytes: await doc.save(), mode: text ? mode : 'same' };
}

/* ───────── new things on the page: text, pictures, shapes ───────── */

/**
 * objs (PDF space, per page): { page, type, ... }
 *   text:   { x, y (baseline), size, lines: [..], color, fontName, src: { page, font } }
 *   image:  { x, y, w, h, ref: { page, name } | bytes + mime }
 *   rect / ellipse: { x, y, w, h, color, fill, width }
 *   line / arrow: { x1, y1, x2, y2, color, width }   check / cross: { x, y, w, h, color, width }
 */
export async function addObjects(L, fontkit, bytes, objs, loadFontFile) {
  if (!objs.length) return bytes;
  const { PDFName, PDFDict } = L;
  const doc = await loadDoc(L, bytes);
  const wrapped = new Set();
  let n = 0;
  const rgbOf = (c) => L.rgb(clamp01(c[0] / 255), clamp01(c[1] / 255), clamp01(c[2] / 255));
  const resDict = (page, key) => {
    const res = page.node.Resources() || page.node.normalizedEntries().Resources;
    let d = res.lookupMaybe(PDFName.of(key), PDFDict);
    if (!d) { d = doc.context.obj({}); res.set(PDFName.of(key), d); }
    return d;
  };
  const addStream = (page, s) => page.node.addContentStream(doc.context.register(doc.context.flateStream(strToBytes(s))));

  for (const o of objs) {
    const page = doc.getPage(o.page);
    page.contentStream = undefined; // each new thing gets its own stream, so they stack in the order made
    page.contentStreamRef = undefined;
    if (!wrapped.has(o.page)) { wrapped.add(o.page); const P = readPage(L, doc, o.page); writePage(L, doc, P, P.src); page.node.normalize(); }
    const color = rgbOf(o.color || [0, 0, 0]);
    if (o.type === 'text') {
      const lines = o.lines.filter((t) => t !== undefined);
      let sameName = null;
      let sf = null;
      if (o.src) {
        try {
          const SP = readPage(L, doc, o.src.page);
          const ref = SP.fontsDict && SP.fontsDict.get(PDFName.of(o.src.font));
          sf = SP.fontOf(o.src.font);
          const used = new Set(SP.shows.filter((r) => r.font === o.src.font).flatMap((r) => r.codes));
          if (ref && lines.every((t) => !t || encodeIn(sf, t, used))) {
            sameName = `SPF${++n}${Date.now() % 1000}`;
            resDict(page, 'Font').set(PDFName.of(sameName), ref);
            const c = (o.color || [0, 0, 0]).map((v) => (v / 255).toFixed(3)).join(' ');
            let s = `q ${c} rg BT /${sameName} ${o.size} Tf`;
            lines.forEach((t, k) => {
              if (!t) return;
              s += ` 1 0 0 1 ${o.x.toFixed(2)} ${(o.y - k * o.size * 1.2).toFixed(2)} Tm ${hexOf(encodeIn(sf, t, used), sf.bpc)} Tj`;
            });
            addStream(page, s + ' ET Q');
          }
        } catch { sameName = null; }
      }
      if (!sameName) {
        const all = lines.join('');
        const font = await lookAlike(L, doc, fontkit, o.fontName || (o.bold ? 'Helvetica-Bold' : 'Helvetica'), all || ' ', loadFontFile);
        lines.forEach((t, k) => { if (t) page.drawText(t, { x: o.x, y: o.y - k * o.size * 1.2, size: o.size, font, color }); });
      }
    } else if (o.type === 'image') {
      if (o.ref) {
        const SP = readPage(L, doc, o.ref.page);
        const ref = SP.xobjs && SP.xobjs.get(PDFName.of(o.ref.name));
        if (ref) {
          const name = `SPI${++n}${Date.now() % 1000}`;
          resDict(page, 'XObject').set(PDFName.of(name), ref);
          addStream(page, `q ${o.w.toFixed(3)} 0 0 ${o.h.toFixed(3)} ${o.x.toFixed(3)} ${o.y.toFixed(3)} cm /${name} Do Q`);
          continue;
        }
      }
      const img = /png/.test(o.mime) ? await doc.embedPng(o.bytes) : await doc.embedJpg(o.bytes);
      page.drawImage(img, { x: o.x, y: o.y, width: o.w, height: o.h });
    } else if (o.type === 'rect') {
      page.drawRectangle({ x: o.x, y: o.y, width: o.w, height: o.h, borderColor: color, borderWidth: o.width, color: o.fill ? color : undefined });
    } else if (o.type === 'ellipse') {
      page.drawEllipse({ x: o.x + o.w / 2, y: o.y + o.h / 2, xScale: o.w / 2, yScale: o.h / 2, borderColor: color, borderWidth: o.width, color: o.fill ? color : undefined });
    } else if (o.type === 'line' || o.type === 'arrow') {
      const { x1, y1, x2, y2 } = o;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      const head = o.type === 'arrow' ? Math.min(len * 0.45, Math.max(12, o.width * 5)) : 0;
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2 - ux * head * 0.8, y: y2 - uy * head * 0.8 }, thickness: o.width, color, lineCap: L.LineCapStyle ? L.LineCapStyle.Round : undefined });
      if (head) {
        const bx = x2 - ux * head;
        const by = y2 - uy * head;
        const wx = -uy * head * 0.55;
        const wy = ux * head * 0.55;
        const pts = [[x2, y2], [bx + wx, by + wy], [bx - wx, by - wy]];
        page.drawSvgPath(`M ${pts.map((p) => `${p[0]} ${-p[1]}`).join(' L ')} Z`, { x: 0, y: 0, color, borderWidth: 0 });
      }
    } else if (o.type === 'check' || o.type === 'cross') {
      const P = (u, v) => ({ x: o.x + u * o.w, y: o.y + v * o.h });
      const segs = o.type === 'check' ? [[P(0.08, 0.5), P(0.38, 0.18)], [P(0.38, 0.18), P(0.94, 0.86)]] : [[P(0.12, 0.12), P(0.88, 0.88)], [P(0.12, 0.88), P(0.88, 0.12)]];
      for (const [a, b] of segs) page.drawLine({ start: a, end: b, thickness: o.width, color, lineCap: L.LineCapStyle ? L.LineCapStyle.Round : undefined });
    }
  }
  return doc.save();
}
