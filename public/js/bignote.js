// Very long notes (whole books, imported documents with hundreds of pages) are saved in pieces
// ("parts") so each piece stays well under the sync limit. Piece boundaries depend on the content
// itself, so editing one chapter only re-sends that chapter's piece, not the whole book.

export const BIG = 700_000;        // a note whose HTML is longer than this is stored in parts
const MIN_PART = 90_000;           // smallest piece before we look for a natural cut
const MAX_PART = 300_000;          // hard upper limit per piece

export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const escText = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Top-level pieces of HTML (strings). Oversized wrappers are opened up so no piece is too big. */
function blocks(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.nodeType === 3) { if (n.data.trim()) out.push(escText(n.data)); continue; }
      if (n.nodeType !== 1) continue;
      const h = n.outerHTML;
      if (h.length > MAX_PART && n.childNodes.length > 1) {
        // a huge <div>/<section>: split its children, keep the wrapper's tag on every piece
        const open = h.slice(0, h.indexOf('>') + 1);
        const close = `</${n.localName}>`;
        const inner = [];
        const before = out.length;
        walk([...n.childNodes]);
        inner.push(...out.splice(before));
        let cur = '';
        for (const b of inner) {
          if (cur && cur.length + b.length > MAX_PART - 200) { out.push(open + cur + close); cur = ''; }
          cur += b;
        }
        if (cur) out.push(open + cur + close);
      } else out.push(h);
    }
  };
  walk([...t.content.childNodes]);
  return out;
}

/** HTML → list of segments; cuts fall where the content says so (stable across small edits) */
export function splitHtml(html) {
  const segs = [];
  let cur = '';
  for (const b of blocks(html)) {
    if (cur && cur.length + b.length > MAX_PART) { segs.push(cur); cur = ''; }
    cur += b;
    if (cur.length >= MIN_PART && parseInt(hash(b), 36) % 7 === 0) { segs.push(cur); cur = ''; }
  }
  if (cur) segs.push(cur);
  return segs;
}

export function textOf(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  for (const b of d.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, br, blockquote, pre')) b.append('\n');
  return (d.textContent || '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** stable id for a piece of a note */
export function partId(noteId, seg, used) {
  let id = `${noteId.slice(0, 46)}_${hash(seg)}`;
  for (let k = 2; used.has(id); k++) id = `${noteId.slice(0, 46)}_${hash(seg)}${k}`;
  used.add(id);
  return id;
}
