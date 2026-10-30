// Small shared helpers
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Cryptographically random URL-safe id (6 bits per char). 24 chars = 144 bits. */
export function rid(len = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += ALPHA[b & 63];
  return s;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function shortDate(ts) {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return clock(ts);
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function detectDeviceName() {
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 1;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) return 'iPad';
  if (/Android/.test(ua)) {
    const brand = /SM-|Samsung/i.test(ua) ? 'Samsung' : /Pixel/.test(ua) ? 'Pixel' : 'Android';
    return /Mobile/.test(ua) ? `${brand} phone` : `${brand} tablet`;
  }
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Device';
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches;
export const isMobileLayout = () => matchMedia('(max-width: 860px)').matches;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;
export function linkify(text) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    out += esc(text.slice(last, m.index));
    out += `<a href="${esc(m[0])}" target="_blank" rel="noopener noreferrer">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}
export function singleUrl(text) {
  const t = text.trim();
  return /^https?:\/\/\S+$/.test(t) ? t : null;
}

const EXT = {
  image: /^(png|jpe?g|gif|webp|avif|heic|heif|bmp|svg|ico|tiff?)$/,
  video: /^(mp4|mov|m4v|webm|mkv|avi|3gp)$/,
  audio: /^(mp3|m4a|aac|wav|ogg|oga|flac|opus|weba)$/,
  pdf: /^pdf$/,
  archive: /^(zip|rar|7z|tar|gz|tgz|bz2|xz|apk|ipa|dmg|iso|exe|msi)$/,
  doc: /^(docx?|odt|rtf|pages|txt|md|epub)$/,
  sheet: /^(xlsx?|ods|csv|numbers|tsv)$/,
  slides: /^(pptx?|odp|key)$/,
  code: /^(js|mjs|ts|json|html?|css|py|java|kt|c|cpp|h|cs|go|rs|php|rb|sh|ya?ml|xml|sql|dart|swift)$/
};
export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}
export function fileKind(type, name) {
  const t = (type || '').toLowerCase();
  const e = extOf(name);
  if (t.startsWith('image/') || EXT.image.test(e)) return 'image';
  if (t.startsWith('video/') || EXT.video.test(e)) return 'video';
  if (t.startsWith('audio/') || EXT.audio.test(e)) return 'audio';
  if (t === 'application/pdf' || EXT.pdf.test(e)) return 'pdf';
  for (const k of ['archive', 'sheet', 'slides', 'doc', 'code']) if (EXT[k].test(e)) return k;
  if (t.startsWith('text/')) return 'doc';
  return 'other';
}
export function kindIcon(kind) {
  return { image: 'image', video: 'video', audio: 'music', archive: 'archive' }[kind] || 'file';
}

/** First meaningful line of a note, without markdown marks */
export function noteTitle(body) {
  for (const raw of (body || '').split('\n')) {
    const line = raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*|\d+\.\s+)/, '').replace(/[*_`~]/g, '').trim();
    if (line) return line.slice(0, 120);
  }
  return 'Untitled';
}
export function noteSnippet(body) {
  const lines = (body || '').split('\n')
    .map((l) => l.trim().replace(/^(#{1,6}\s+|>\s*|(?:[-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?)/, (m, a, x) => (x === undefined ? '' : x === ' ' ? '☐ ' : '☑ ')))
    .filter(Boolean);
  return lines.slice(1).join(' · ').replace(/!\[[^\]]*\]\([^)]*\)/g, '🖼').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').trim().slice(0, 140);
}
const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_-]{1,32})/gu;
export function noteTags(body) {
  const out = new Set();
  for (const m of (body || '').matchAll(TAG_RE)) {
    if (!/^\d+$/.test(m[1])) out.add(m[1].toLowerCase());
  }
  return [...out];
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
