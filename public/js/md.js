// Rich-text helpers: sanitising editor HTML, cleaning pasted HTML, and converting
// v1/v2.0 markdown notes into rich text the first time they are opened.
import { marked } from '/vendor/marked.esm.js';

marked.use({ gfm: true, breaks: true });

const STYLE_OK = new Set(['color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'text-align', 'width']);
const VALUE_OK = /^[#a-z0-9(),.%\s-]+$|^var\(--text\)$/i;

let hooked = false;
function P() {
  const p = window.DOMPurify;
  if (p && !hooked) {
    hooked = true;
    p.addHook('uponSanitizeAttribute', (node, data) => {
      if (data.attrName === 'style') {
        if (P.mode === 'paste') { data.keepAttr = false; return; }
        const kept = [];
        for (const decl of String(data.attrValue).split(';')) {
          const i = decl.indexOf(':');
          if (i < 0) continue;
          const prop = decl.slice(0, i).trim().toLowerCase();
          const val = decl.slice(i + 1).trim();
          if (STYLE_OK.has(prop) && VALUE_OK.test(val) && !/url|expression/i.test(val)) kept.push(`${prop}: ${val}`);
        }
        if (kept.length) data.attrValue = kept.join('; ');
        else data.keepAttr = false;
      } else if (data.attrName === 'class') {
        if (data.attrValue !== 'file-chip') data.keepAttr = false;
      } else if (data.attrName === 'contenteditable') {
        if (node.tagName === 'A' && node.hasAttribute('data-file')) data.attrValue = 'false';
        else data.keepAttr = false;
      }
    });
    p.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && !node.hasAttribute('data-file')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
      if (node.tagName === 'IMG' && node.hasAttribute('data-file')) node.removeAttribute('src');
    });
  }
  return p;
}

const BASE = {
  ALLOWED_TAGS: ['p', 'div', 'br', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'a', 'img', 'h1', 'h2', 'h3',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'mark', 'font', 'sub', 'sup', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: ['href', 'data-file', 'data-checklist', 'data-checked', 'data-align', 'alt', 'style', 'size', 'color', 'class', 'contenteditable', 'target', 'rel'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
};

/** Clean editor HTML before saving or showing it */
export function sanitizeNote(html) {
  const p = P();
  if (!p) return '';
  P.mode = 'note';
  return p.sanitize(String(html || ''), BASE);
}

/** Pasted HTML keeps its structure (lists, headings, bold, links) but loses foreign fonts, sizes and colours */
export function sanitizePaste(html) {
  const p = P();
  if (!p) return '';
  P.mode = 'paste';
  try {
    return p.sanitize(String(html || ''), { ...BASE, ALLOWED_TAGS: BASE.ALLOWED_TAGS.filter((t) => t !== 'font' && t !== 'img') });
  } finally {
    P.mode = 'note';
  }
}

/** Markdown (older notes) → rich text HTML */
export function markdownToHtml(md) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const src = String(md || '')
    .replace(/!\[([^\]]*)\]\(file:([A-Za-z0-9_-]{6,64})\)/g, (m, alt, id) => `<img data-file="${id}" alt="${esc(alt)}">`)
    .replace(/\[([^\]]*)\]\(file:([A-Za-z0-9_-]{6,64})\)/g, (m, t, id) => `<a data-file="${id}" class="file-chip" contenteditable="false">${esc(t)}</a>`)
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  const doc = new DOMParser().parseFromString(marked.parse(src), 'text/html');
  for (const input of doc.querySelectorAll('li input[type="checkbox"]')) {
    const li = input.closest('li');
    li.setAttribute('data-checked', String(input.checked));
    li.parentElement.setAttribute('data-checklist', '');
    input.remove();
  }
  return sanitizeNote(doc.body.innerHTML);
}

/** Plain text → simple paragraphs */
export function textToHtml(text) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return String(text || '').split('\n').map((l) => `<p>${l ? esc(l) : '<br>'}</p>`).join('');
}
