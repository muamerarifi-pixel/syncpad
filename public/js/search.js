// Search helpers: accent-insensitive matching ("pershendetje" finds "përshëndetje"), every word must
// appear (in any order), short snippets around the first hit, and text extraction from documents
// (PDF, Word, PowerPoint, Excel, ePUB, plain text) so their contents can be searched too.

/** lower-case, no accents, ë→e ç→c, ß→ss … */
export function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[łŁ]/g, 'l')
    .replace(/[øØ]/g, 'o')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

/** A query → list of folded words. Quoted phrases stay together: "dita e mesuesit" */
export function terms(q) {
  const out = [];
  String(q || '').replace(/"([^"]+)"|(\S+)/g, (_, ph, w) => { const t = fold(ph || w).trim(); if (t) out.push(t); return ''; });
  return out;
}

/** true when every term appears somewhere in one of the texts */
export function matches(ts, ...texts) {
  if (!ts.length) return true;
  const hay = texts.filter(Boolean).map(fold).join('\n');
  return ts.every((t) => hay.includes(t));
}

/** ~160 characters around the first hit, with the hit marked <mark> (HTML-escaped) */
export function snippet(text, ts, len = 160) {
  const src = String(text || '');
  if (!src || !ts.length) return '';
  const f = fold(src);
  // folding can change length (ß → ss); map back via a cheap proportional fallback
  const same = f.length === src.length;
  let at = -1;
  let hit = '';
  for (const t of ts) { const i = f.indexOf(t); if (i >= 0 && (at < 0 || i < at)) { at = i; hit = t; } }
  if (at < 0) return '';
  const start = Math.max(0, at - Math.floor(len / 3));
  const end = Math.min(src.length, start + len);
  const piece = (same ? src : f).slice(start, end).replace(/\s+/g, ' ');
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fp = fold(piece);
  let html = '';
  let i = 0;
  const marks = [];
  for (const t of ts) { let j = fp.indexOf(t); while (j >= 0) { marks.push([j, j + t.length]); j = fp.indexOf(t, j + t.length); } }
  marks.sort((a, b) => a[0] - b[0]);
  for (const [a, b] of marks) { if (a < i) continue; html += esc(piece.slice(i, a)) + '<mark>' + esc(piece.slice(a, b)) + '</mark>'; i = b; }
  html += esc(piece.slice(i));
  return (start > 0 ? '…' : '') + html + (end < src.length ? '…' : '');
}

/** page number (1-based) of the first hit in a document text where pages are separated by \f */
export function pageOf(text, ts) {
  if (!text || text.indexOf('\f') < 0) return 0;
  const f = fold(text);
  let at = -1;
  for (const t of ts) { const i = f.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return 0;
  let n = 1;
  for (let i = text.indexOf('\f'); i >= 0 && i < at; i = text.indexOf('\f', i + 1)) n++;
  return n;
}

/* ───────────── document text extraction ───────────── */

export const INDEX_VERSION = 1;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|xml|html?|css|js|mjs|ts|py|java|c|cpp|h|cs|rb|go|rs|php|sh|yml|yaml|ini|srt|vtt)$/i;

/** Which documents can be searched inside */
export function indexable(type, name) {
  const n = String(name || '');
  if (/pdf/i.test(type || '') || /\.pdf$/i.test(n)) return 'pdf';
  if (/\.(docx|docm|dotx)$/i.test(n)) return 'docx';
  if (/\.pptx$/i.test(n)) return 'pptx';
  if (/\.(xlsx|xlsm)$/i.test(n)) return 'xlsx';
  if (/\.epub$/i.test(n) || /epub/i.test(type || '')) return 'epub';
  if (/^text\//i.test(type || '') || TEXT_EXT.test(n)) return 'text';
  return null;
}

const htmlText = (html) => {
  const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const b of d.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, br, section, article')) b.append('\n');
  return (d.body.textContent || '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
};

/** Plain text of a document. PDF pages are separated by \f so a hit can say which page. */
export async function extractText(blob, kind, { maxChars = 4_000_000, onProgress } = {}) {
  if (kind === 'text') return (await blob.text()).slice(0, maxChars);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (kind === 'pdf') {
    const V = '/vendor/pdf/';
    const lib = await import(V + 'pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = V + 'pdf.worker.min.mjs';
    const task = lib.getDocument({ data: bytes, isEvalSupported: false, useWasm: false, verbosity: 0 });
    const pdf = await task.promise;
    const out = [];
    let total = 0;
    try {
      for (let i = 1; i <= pdf.numPages && total < maxChars; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        let s = '';
        for (const it of tc.items) s += (it.str || '') + (it.hasEOL ? '\n' : ' ');
        s = s.replace(/[ \t]+/g, ' ').trim();
        out.push(s);
        total += s.length + 1;
        page.cleanup();
        if (onProgress && i % 10 === 0) onProgress(i, pdf.numPages);
      }
      return { text: out.join('\f').slice(0, maxChars), pages: pdf.numPages };
    } finally { task.destroy().catch(() => {}); }
  }
  if (kind === 'epub') {
    const { readEpub } = await import('./epub.js');
    const book = await readEpub(bytes, { images: false });
    return book.chapters.map((c) => htmlText(c.html)).join('\f').slice(0, maxChars);
  }
  const M = await import('./docmodel.js');
  if (kind === 'docx') return htmlText(M.modelToHtml(M.readDocx(bytes))).slice(0, maxChars);
  if (kind === 'pptx') return M.readPptx(bytes).map(htmlText).join('\f').slice(0, maxChars);
  if (kind === 'xlsx') return M.readXlsx(bytes).map((s) => s.name + '\n' + htmlText(s.html)).join('\f').slice(0, maxChars);
  return '';
}
