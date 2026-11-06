// ePUB e-books: read the chapters (in reading order), title, author, cover and pictures.
import { unzipSync, strFromU8 } from '/vendor/doc/fflate.mjs';

const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const dir = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
function resolve(base, href) {
  const parts = (dir(base) + decodeURIComponent(href.split('#')[0])).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

/**
 * → { title, author, chapters: [{ title, html }], images: Map(path → Blob), cover: path|null }
 * Chapter HTML has no scripts/styles; <img src> point at the image paths (keys of `images`).
 */
export async function readEpub(bytes, { images = true } = {}) {
  const z = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const get = (p) => z[p] || z[Object.keys(z).find((k) => k.toLowerCase() === p.toLowerCase())];
  const container = get('META-INF/container.xml');
  if (!container) throw new Error('Not an ePUB file');
  const opfPath = xml(strFromU8(container)).querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath || !get(opfPath)) throw new Error('This ePUB has no table of contents');
  const opf = xml(strFromU8(get(opfPath)));
  const meta = (n) => opf.getElementsByTagNameNS('*', n)[0]?.textContent?.trim() || '';
  const manifest = new Map();
  for (const it of opf.getElementsByTagNameNS('*', 'item')) {
    manifest.set(it.getAttribute('id'), { href: resolve(opfPath, it.getAttribute('href') || ''), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' });
  }
  // chapter titles from the navigation document (EPUB 3) or toc.ncx (EPUB 2)
  const titles = new Map();
  try {
    const nav = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
    if (nav && get(nav.href)) {
      const d = new DOMParser().parseFromString(strFromU8(get(nav.href)), 'text/html');
      for (const a of d.querySelectorAll('nav a[href]')) { const p = resolve(nav.href, a.getAttribute('href')); if (!titles.has(p)) titles.set(p, a.textContent.trim()); }
    }
    const ncx = [...manifest.values()].find((m) => /ncx/.test(m.type));
    if (ncx && get(ncx.href)) {
      const d = xml(strFromU8(get(ncx.href)));
      for (const np of d.getElementsByTagNameNS('*', 'navPoint')) {
        const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src');
        const label = np.getElementsByTagNameNS('*', 'text')[0]?.textContent?.trim();
        if (src && label) { const p = resolve(ncx.href, src); if (!titles.has(p)) titles.set(p, label); }
      }
    }
  } catch {}

  const imgs = new Map();
  const chapters = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    const m = manifest.get(ref.getAttribute('idref'));
    if (!m || !/html|xml/.test(m.type) || !get(m.href)) continue;
    const doc = new DOMParser().parseFromString(strFromU8(get(m.href)), /xhtml|xml/.test(m.type) ? 'application/xhtml+xml' : 'text/html');
    const body = doc.body || doc.getElementsByTagName('body')[0];
    if (!body) continue;
    for (const n of body.querySelectorAll('script, style, link, iframe, object, embed, form, input, button, nav[epub\\:type="toc"]')) n.remove();
    for (const im of body.querySelectorAll('img, image')) {
      const src = im.getAttribute('src') || im.getAttribute('xlink:href') || im.getAttribute('href');
      if (!src || /^(data|https?):/i.test(src)) continue;
      const p = resolve(m.href, src);
      if (images && get(p) && !imgs.has(p)) {
        const ext = (p.split('.').pop() || '').toLowerCase();
        imgs.set(p, new Blob([get(p)], { type: MIME[ext] || 'image/jpeg' }));
      }
      const img = doc.createElement('img');
      img.setAttribute('src', p);
      img.setAttribute('alt', im.getAttribute('alt') || '');
      (im.closest('svg') || im).replaceWith(img);
    }
    for (const a of body.querySelectorAll('a[href]')) { if (!/^https?:/i.test(a.getAttribute('href'))) a.removeAttribute('href'); }
    const html = body.innerHTML.replace(/\sxmlns(:\w+)?="[^"]*"/g, '').replace(/<(\/?)(\w+):(\w+)/g, '<$1$3');
    const text = body.textContent.trim();
    if (!text && !body.querySelector('img')) continue;
    chapters.push({ title: titles.get(m.href) || '', html });
  }
  // cover picture
  let cover = null;
  const cm = [...opf.getElementsByTagNameNS('*', 'meta')].find((x) => x.getAttribute('name') === 'cover');
  const cItem = (cm && manifest.get(cm.getAttribute('content'))) || [...manifest.values()].find((x) => /cover-image/.test(x.props));
  if (cItem && get(cItem.href)) {
    cover = cItem.href;
    if (images && !imgs.has(cover)) imgs.set(cover, new Blob([get(cover)], { type: cItem.type || 'image/jpeg' }));
  }
  return { title: meta('title') || 'E-book', author: meta('creator'), chapters, images: imgs, cover };
}
