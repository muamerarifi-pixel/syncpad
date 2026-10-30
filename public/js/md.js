// Markdown → safe HTML (marked + DOMPurify), with file: links resolved to attachments.
import { marked } from '/vendor/marked.esm.js';

marked.use({ gfm: true, breaks: true });

let hooked = false;
function purify(html) {
  const P = window.DOMPurify;
  if (!P) return html.replace(/</g, '&lt;'); // purify.js is loaded with defer; extremely early calls get plain text
  if (!hooked) {
    hooked = true;
    P.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') || '';
        if (href.includes('/file/')) node.classList.add('file-link');
        else { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
      }
      if (node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox') node.removeAttribute('disabled');
    });
  }
  return P.sanitize(html, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form'],
    FORBID_ATTR: ['style'],
    // default list + blob: (local, not-yet-uploaded attachments)
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  });
}

export function renderMarkdown(body, resolveFile) {
  const src = String(body || '')
    .replace(/\]\(file:([A-Za-z0-9_-]{6,64})\)/g, (m, id) => `](${resolveFile(id)})`)
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  return purify(marked.parse(src));
}

/** Toggle the n-th "- [ ]" checkbox in the markdown source */
export function toggleTask(body, n) {
  let i = -1;
  return body.replace(/^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/gm, (m, a, x, b) => {
    i++;
    if (i !== n) return m;
    return a + (x === ' ' ? 'x' : ' ') + b;
  });
}
