// One-click text case: cycles the selected text (or the current paragraph) through
// Sentence case → UPPERCASE → lowercase, keeping bold, colours and links.
const BLOCK = /^(P|DIV|LI|H1|H2|H3|BLOCKQUOTE|PRE|TD|TH)$/;

function blockOf(node, root) {
  for (let n = node.nodeType === 1 ? node : node.parentNode; n && n !== root; n = n.parentNode) if (BLOCK.test(n.tagName)) return n;
  return root;
}
const mapChars = (s, f) => [...s].map((c) => { const t = f(c); return t.length === c.length ? t : c; }).join('');

/** Returns the case that was applied ('sentence' | 'upper' | 'lower') or null */
export function cycleCase(root, force) {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  let r = sel.getRangeAt(0);
  if (!root.contains(r.commonAncestorContainer)) return null;
  if (r.collapsed) {
    r = document.createRange();
    r.selectNodeContents(blockOf(sel.anchorNode, root));
  }
  const parts = [];
  const w = document.createTreeWalker(r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const n = w.currentNode;
    if (!r.intersectsNode(n)) continue;
    const a = n === r.startContainer ? r.startOffset : 0;
    const b = n === r.endContainer ? r.endOffset : n.data.length;
    if (b > a) parts.push({ n, a, b });
  }
  if (!parts.length) return null;
  const text = parts.map((p) => p.n.data.slice(p.a, p.b)).join('');
  if (!/\p{L}/u.test(text)) return null;
  const mode = force || (text === text.toUpperCase() ? 'lower' : text === text.toLowerCase() ? 'sentence' : 'upper');
  // does the selection start a sentence?
  const pre = document.createRange();
  const first = parts[0];
  pre.setStart(blockOf(first.n, root), 0);
  pre.setEnd(first.n, first.a);
  let start = !/\S/.test(pre.toString()) || /[.!?…]\s*$/.test(pre.toString());
  let blk = blockOf(first.n, root);
  for (const p of parts) {
    const s = p.n.data.slice(p.a, p.b);
    let t;
    if (mode === 'upper') t = mapChars(s, (c) => c.toUpperCase());
    else if (mode === 'lower') t = mapChars(s, (c) => c.toLowerCase());
    else {
      const b = blockOf(p.n, root);
      if (b !== blk) { blk = b; start = true; }
      t = '';
      for (const c of s) {
        if (/\p{L}/u.test(c)) {
          const u = start ? c.toUpperCase() : c.toLowerCase();
          t += u.length === c.length ? u : c;
          start = false;
        } else {
          t += c;
          if (/[.!?…\n]/.test(c)) start = true;
        }
      }
    }
    p.n.data = p.n.data.slice(0, p.a) + t + p.n.data.slice(p.b);
  }
  const last = parts[parts.length - 1];
  const nr = document.createRange();
  nr.setStart(first.n, first.a);
  nr.setEnd(last.n, last.b);
  sel.removeAllRanges();
  sel.addRange(nr);
  return mode;
}
export const CASE_LABEL = { sentence: 'Sentence case', upper: 'UPPERCASE', lower: 'lowercase' };
