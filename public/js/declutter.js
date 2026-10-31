// De-clutter: tidies text copied from AI chat apps (ChatGPT, Gemini, Claude, Copilot, Perplexity…)
// right on the device with plain JavaScript + regex — no API key, works offline.
//   isAiText(text, html)  → does this paste look like it came from an AI chat?
//   plainText(text, o)    → clean plain text (Drops)
//   markdown(text, o)     → clean markdown, ready to become rich text (Notes)
//   tidyHtml(html, o)     → clean already-formatted HTML (Notes, when the copy has no markdown)
//   looksMarkdown(text)   → does the text still carry markdown symbols?
// o.punct: also swap — dashes, “curly” quotes and … for plain ones.

const HIDDEN = /[​‌⁠-⁤﻿­‎‏‪-‮⁦-⁩᠎]/g;
const STRAY_ZWJ = /(?<!\p{Extended_Pictographic}️?)‍|‍(?!\p{Extended_Pictographic})/gu;
const ODD_SPACE = /[  -   　]/g;
const PRIVATE = /[-]/g;
const EMO = '(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}{2})\\uFE0F?(?:\\u200D\\p{Extended_Pictographic}\\uFE0F?)*';
const LEAD_EMOJI = new RegExp(`^([ \\t]*(?:#{1,6}[ \\t]+|[-*+•][ \\t]+|\\d{1,3}[.)][ \\t]+|>[ \\t]*)?)((?:${EMO}[ \\t]*)+)(?=\\S)`, 'u');
const KEEP_EMOJI = /^[✅❌✔✖☑⚠❗❓✓✗️\s]+$/u; // these carry meaning (yes / no / warning)
const KEYCAP = /^([ \t]*)([0-9])️?⃣[ \t]*/gm;

const INTERJ = '(?:sure|certainly|absolutely|of course|definitely|okay|ok|alright|got it|no problem|understood|perfect|great|excellent|sigurisht|patjetër|natyrisht|me kënaqësi|në rregull|shumë mirë|dakord)';
const INTRO = new RegExp(
  `^(?:${INTERJ}[!.,]?\\s*$` + // just "Sure!"
  `|(?:(?:${INTERJ}|(?:great|good|excellent|nice|interesting|fair) (?:question|idea|point|catch|choice)|pyetje e mirë)[!.,]\\s*)?` +
  `(?:here(?:'|’)s|here (?:is|are)|below (?:is|are)|i(?:'|’)ve (?:rewritten|revised|updated|cleaned|polished|put together|created|made|written|drafted)|i(?:'|’)ll (?:break|walk|explain|give)|let(?:'|’)s (?:break|go|look|walk)|ja(?:\\s|,)|këtu (?:është|janë|e ke|i ke|ke)|më poshtë (?:është|janë|e ke|ke|po)|po ta (?:shpjegoj|jap))[^\\n]{0,200}[:.!]` +
  `|(?:great|good|excellent|nice|interesting|fair) (?:question|idea|point|catch|choice)[!.]?\\s*$|pyetje e mirë[!.]?\\s*$|(?:i(?:'|’)d be |i(?:'|’)m )?(?:happy|glad) to help[^\\n]{0,120}[!.:]?)$`, 'iu');
const LEAD_INTERJ = new RegExp(`^(?:${INTERJ}|(?:great|good|excellent) question|pyetje e mirë)[!.,]\\s+(?=\\S)`, 'iu');
const CLOSE = /^[-—*_\s]*(?:i hope (?:this|that|it|these)|hope (?:this|that|it) helps|let me know|feel free|would you like|do you want|want me to|if you(?:'|’)d like|if you want|if you need|if needed,? i can|i can also|i could also|shall i|should i also|need anything else|anything else\b|is there anything|happy to help|glad (?:i could|to) help|good luck|best of luck|shpresoj|më trego|më thuaj|më njofto|nëse dëshiron|nëse do\b|nëse ke nevojë|nëse të duhet|nëse të intereson|dëshiron (?:që|të)|a do (?:që|të)|a dëshiron|mund ta bëj|mund të bëj edhe|mos hezito|mos ngurro|suksese\b|fat të mbarë)/iu;

const LIST_LINE = /^[ \t]*(?:[-*+•●▪◦‣∙]|\d{1,3}[.)])[ \t]+\S/;
const HR = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/* ───── shared steps ───── */

function base(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u2028|\u2029/g, '\n')
    .replace(HIDDEN, '')
    .replace(STRAY_ZWJ, '')
    .replace(ODD_SPACE, ' ')
    .replace(/\t/g, '    ');
}

/** Code is left alone: fenced blocks and `inline code` are parked while the rest is cleaned */
function protect(s) {
  const bag = [];
  const park = (m) => { bag.push(m); return `\u0000${bag.length - 1}\u0000`; };
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/gm, park);
  s = s.replace(/`[^`\n]+`/g, park);
  return [s, bag];
}
function restore(s, bag, plain) {
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => {
    const c = bag[Number(i)];
    if (!plain) return c;
    if (c.startsWith('`') && !/^`{3}/.test(c)) return c.slice(1, -1);
    return c.split('\n').slice(1, -1).join('\n');
  });
}

function cleanUrl(u) {
  try {
    const x = new URL(u);
    let changed = false;
    for (const k of [...x.searchParams.keys()]) if (/^(?:utm_|fbclid$|gclid$)/i.test(k)) { x.searchParams.delete(k); changed = true; }
    if (!changed) return u;
    return x.toString().replace(/\?(?=#|$)/, '');
  } catch { return u; }
}
const cleanUrls = (s) => s.replace(/\bhttps?:\/\/[^\s<>"'`)\]]+/g, cleanUrl);

/** Reference-style links ([Site][1] … [1]: https://…) and citation pills in brackets */
function refLinks(s, keepLinks) {
  const defs = new Map();
  s = s.replace(/^[ \t]{0,3}\[([^\]\n^]+)\]:[ \t]*<?(\S+?)>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/gm, (m, k, u) => { defs.set(k.trim().toLowerCase(), u); return ''; });
  s = s.replace(/^[ \t]{0,3}\[\^[^\]\n]+\]:.*$/gm, ''); // footnote definitions
  if (defs.size) {
    s = s.replace(/[ \t]?\(\s*\[[^\]\n]{1,80}\]\[[^\]\n]+\](?:\s*[,;]?\s*\[[^\]\n]{1,80}\]\[[^\]\n]+\])*\s*\)/g, '');
    s = s.replace(/\[([^\]\n]+)\]\[([^\]\n]*)\]/g, (m, t, k) => {
      const u = defs.get((k || t).trim().toLowerCase());
      if (!u) return m;
      return keepLinks ? `[${t}](${u})` : t;
    });
  }
  // inline pills: ([Reuters](https://…)) or ([BBC](…), [CNN](…))
  s = s.replace(/[ \t]?\(\s*\[[^\]\n]{1,80}\]\(https?:[^)\s]+\)(?:\s*[,;]?\s*\[[^\]\n]{1,80}\]\(https?:[^)\s]+\))*\s*\)/g, '');
  return s;
}

function stripCites(s) {
  return s
    .replace(/[ \t]?[^\n]*/g, '')
    .replace(/[ \t]?【[^】\n]{0,80}】/g, '')
    .replace(/[ \t]?:?contentReference\[oaicite:\d+\](?:\{index=\d+\})?/g, '')
    .replace(/[ \t]?\[oaicite:\d+\](?:\{index=\d+\})?/g, '')
    .replace(/[ \t]?\bcite(?:turn\d+[a-z]+\d+)+\b/gi, '')
    .replace(/[ \t]?\bturn\d+(?:search|news|view|fetch|file|image|product)\d+\b/gi, '')
    .replace(/[ \t]?\[\^\d{1,3}\]/g, '')
    .replace(/(?<=[\p{L}\p{N}.,;:!?)"'”’\]])[ \t]?\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\](?![(:])/gu, '')
    .replace(/\b[Aa]s an AI(?: language model| assistant| model)?,\s*/g, '')
    .replace(PRIVATE, '');
}

/* ───── maths (\( x^2 \), $$ \frac{a}{b} $$) → readable text ───── */
const TEX = { times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', approx: '≈', neq: '≠', ne: '≠', leq: '≤', le: '≤', geq: '≥', ge: '≥',
  to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←', implies: '⇒', infty: '∞', circ: '°', degree: '°', alpha: 'α', beta: 'β',
  gamma: 'γ', delta: 'δ', Delta: 'Δ', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', Sigma: 'Σ', omega: 'ω', Omega: 'Ω',
  sum: 'Σ', ldots: '…', dots: '…', cdots: '⋯', quad: ' ', qquad: '  ', percent: '%', in: '∈', cap: '∩', cup: '∪' };
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
function tex(src) {
  const wrap = (x) => (/^[\w.]+$/.test(x.trim()) ? x.trim() : `(${x.trim()})`);
  let t = src.trim();
  for (let k = 0; k < 4; k++) {
    t = t.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (m, a, b) => `${wrap(a)}/${wrap(b)}`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (m, a) => `√${wrap(a)}`)
      .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|textbf|textit|boxed|mbox)\s*\{([^{}]*)\}/g, '$1');
  }
  return t.replace(/\\left|\\right/g, '')
    .replace(/\\([A-Za-z]+)/g, (m, k) => (k in TEX ? TEX[k] : m))
    .replace(/\\([%$&#_{}])/g, '$1')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\^\{?(\d)\}?/g, (m, d) => SUP[d])
    .replace(/[_^]\{([^{}]*)\}/g, (m, a) => (m[0] === '^' ? '^' : '_') + a)
    .replace(/[{}]/g, '')
    .replace(/[ \t]{2,}/g, ' ');
}
const maths = (s) => s
  .replace(/\$\$([\s\S]+?)\$\$/g, (m, a) => tex(a))
  .replace(/\\\[([\s\S]+?)\\\]/g, (m, a) => tex(a))
  .replace(/\\\(([\s\S]+?)\\\)/g, (m, a) => tex(a));

/* ───── "Sure! Here's…" and "Let me know if…" ───── */
function trimFiller(s) {
  let paras = s.split(/\n[ \t]*\n/);
  const text = (p) => p.replace(/^[ \t>#*_-]+|[*_]+/g, '').trim();
  if (paras.length > 1) {
    const first = text(paras[0]);
    if (!first.includes('\n') && first.length <= 220 && INTRO.test(first)) paras.shift();
  }
  if (paras.length) paras[0] = paras[0].replace(LEAD_INTERJ, (m) => '').replace(/^\S/, (c) => c.toUpperCase());
  for (let round = 0; round < 3 && paras.length > 1; round++) {
    let cut = -1;
    for (let i = paras.length - 1; i >= Math.max(1, paras.length - 4); i--) {
      const p = text(paras[i]);
      if (p.length <= 320 && CLOSE.test(p)) { cut = i; break; }
      if (!paras[i].split('\n').every((l) => !l.trim() || LIST_LINE.test(l) || /^[ \t]{2,}\S/.test(l))) break;
    }
    if (cut < 1) break;
    if (!paras.slice(cut + 1).every((p) => p.split('\n').every((l) => !l.trim() || LIST_LINE.test(l) || /^[ \t]{2,}\S/.test(l) || CLOSE.test(text(l))))) break;
    paras = paras.slice(0, cut);
    while (paras.length > 1 && HR.test(paras[paras.length - 1].trim())) paras.pop();
  }
  return paras.join('\n\n');
}

/* ───── decorative emoji at the start of lines ───── */
function emojiLines(s) {
  const lines = s.replace(KEYCAP, '$1$2. ').split('\n');
  const deco = lines.map((l) => { const m = LEAD_EMOJI.exec(l); return m && !KEEP_EMOJI.test(m[2]) ? m : null; });
  return lines.map((l, i) => {
    const m = deco[i];
    if (!m) return l;
    const rest = l.slice(m[0].length);
    const bare = !m[1].trim();
    const run = (deco[i - 1] && !deco[i - 1][1].trim()) || (deco[i + 1] && !deco[i + 1][1].trim());
    return bare && run && rest.length < 400 ? `${m[1]}- ${rest}` : m[1] + rest;
  }).join('\n');
}

function plainPunct(s) {
  return s.replace(/[ \t]*—[ \t]*/g, ' - ')
    .replace(/(\d)[ \t]*–[ \t]*(\d)/g, '$1-$2')
    .replace(/[ \t]+–[ \t]+/g, ' - ')
    .replace(/^ - /gm, '- ')
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/…/g, '...');
}

function tidy(s) {
  return s.replace(/[ \t]+$/gm, '')
    .replace(/(\S)[ \t]{2,}(?=\S)/g, '$1 ')
    .replace(/[ \t]+([,.;:!?])(?=[\s)\]]|$)/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/* ───── markdown → plain text ───── */
function inlinePlain(s) {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, a, u) => u)
    .replace(/\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, t, u) => {
      const tt = t.trim();
      return tt === u || tt === u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') || /^https?:/.test(tt) ? u : `${tt} (${u})`;
    })
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/(\*\*\*|___)(?=\S)([^\n]+?)(?<=\S)\1/g, '$2')
    .replace(/(\*\*|__)(?=\S)([^\n]+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\p{L}\p{N}*\\])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*\\])\*(?![\p{L}\p{N}*])/gu, '$1')
    .replace(/(?<![\p{L}\p{N}_\\])_(?=[^\s_])([^_\n]+?)(?<=[^\s_\\])_(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '$1')
    .replace(/==(?=\S)([^=\n]+?)(?<=\S)==/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, '$1');
}

const isRow = (l) => /^\s*\|?[^|\n]*\|[^\n]*$/.test(l) && l.includes('|');
const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => inlinePlain(c.trim()));

function mdToPlain(s) {
  const lines = s.split('\n');
  const out = [];
  const stack = [];
  const MARK = ['• ', '◦ ', '▪ '];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const rows = [cells(l)];
      i += 2;
      while (i < lines.length && isRow(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      if (out.length && out[out.length - 1].trim()) out.push('');
      for (const r of rows) out.push(r.filter((c, k) => c || k < r.length - 1).join(' · '));
      out.push('');
      stack.length = 0;
      continue;
    }
    if (HR.test(l)) { out.push(''); stack.length = 0; continue; }
    if (/^[ \t]{0,3}=+[ \t]*$/.test(l) && out.length && out[out.length - 1].trim()) continue; // setext underline
    l = l.replace(/^(?:[ \t]{0,3}>[ \t]?)+/, '');
    let m = /^[ \t]{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(l);
    if (m) {
      if (out.length && out[out.length - 1].trim()) out.push('');
      out.push(inlinePlain(m[1]));
      stack.length = 0;
      continue;
    }
    m = /^([ \t]*)([-*+•●▪◦‣∙]|\d{1,3}[.)])[ \t]+(?:\[([ xX])\][ \t]+)?(.*)$/.exec(l);
    if (m && m[4].trim()) {
      const ind = m[1].length;
      while (stack.length && ind < stack[stack.length - 1]) stack.pop();
      if (!stack.length || ind > stack[stack.length - 1]) stack.push(ind);
      const lvl = Math.min(stack.length - 1, 4);
      const mark = m[3] != null ? (m[3] === ' ' ? '☐ ' : '☑ ') : /\d/.test(m[2]) ? m[2].replace(')', '.') + ' ' : MARK[Math.min(lvl, 2)];
      out.push('   '.repeat(lvl) + mark + inlinePlain(m[4]));
      continue;
    }
    if (!l.trim()) { out.push(''); continue; }
    if (stack.length && /^[ \t]{2,}\S/.test(l)) { out.push('   '.repeat(Math.min(stack.length, 4)) + inlinePlain(l.trim())); continue; }
    stack.length = 0;
    out.push(inlinePlain(l));
  }
  // keep list items together (AI often leaves blank lines between them)
  const kind = (l) => { const m = /^\s*([•◦▪]|[☐☑]|\d{1,3}\.)\s/.exec(l || ''); return m ? (/\d/.test(m[1]) ? 'n' : /[☐☑]/.test(m[1]) ? 'c' : 'b') : null; };
  return out.filter((l, i) => !(l === '' && i > 0 && kind(out[i - 1]) && kind(out[i - 1]) === kind(out[i + 1]))).join('\n');
}

/* ───── public ───── */

export function looksMarkdown(text) {
  const t = String(text || '');
  return /(^|\s)\*\*[^*\n]+\*\*|^\s{0,3}#{1,6}[ \t]+\S|^\s*\|.+\|\s*\n\s*\|?\s*:?-{3,}|^\s*[-*+][ \t]+\[[ xX]\][ \t]|\[[^\]\n]+\]\(https?:|^[ \t]*```/m.test(t) ||
    (t.match(/^\s*[-*+][ \t]+\S/gm) || []).length >= 2;
}

export function aiScore(text, html = '') {
  const t = String(text || '');
  const h = String(html || '');
  let n = 0;
  if (/data-start="\d+"|data-message-author-role|font-claude|model-response|markdown prose|data-sourcepos|utm_source=chatgpt\.com/.test(h)) n += 3;
  if (/utm_source=chatgpt\.com|【[^】\n]*】|oaicite|contentReference\[|\bturn\d+(?:search|news|view|fetch)\d+|[-]/.test(t)) n += 3;
  if (/[​‌⁠﻿]/.test(t)) n += 2;
  if (/(^|\s)\*\*[^*\n]+\*\*/m.test(t)) n += 2;
  if (/^\s{0,3}#{1,6}[ \t]+\S/m.test(t)) n += 2;
  if (/^\s*\|.+\|\s*\n\s*\|?\s*:?-{3,}/m.test(t)) n += 2;
  if (/\\\(|\\\[|\$\$/.test(t)) n += 1;
  if (/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/m.test(t)) n += 1;
  if ((t.match(/^\s*[-*+•][ \t]+\S/gm) || []).length >= 2) n += 1;
  if (/(?<=[\p{L}.,;:!?)])\[\d{1,2}\]/u.test(t)) n += 1;
  const lines = t.split('\n');
  if (lines.filter((l) => { const m = LEAD_EMOJI.exec(l); return m && !KEEP_EMOJI.test(m[2]); }).length >= 2) n += 1;
  const paras = t.trim().split(/\n\s*\n/);
  if (paras.length > 1 && (INTRO.test(paras[0].trim()) || CLOSE.test(paras[paras.length - 1].trim()))) n += 1;
  return n;
}
export const isAiText = (text, html) => !!String(text || '').trim() && aiScore(text, html) >= 2;

export function plainText(text, o = {}) {
  let s = base(text);
  let bag;
  [s, bag] = protect(s);
  s = maths(cleanUrls(stripCites(refLinks(s, false))));
  s = mdToPlain(emojiLines(trimFiller(s)));
  if (o.punct) s = plainPunct(s);
  return restore(tidy(s), bag, true);
}

export function markdown(text, o = {}) {
  let s = base(text);
  let bag;
  [s, bag] = protect(s);
  s = maths(cleanUrls(stripCites(refLinks(s, true))));
  s = emojiLines(trimFiller(s))
    .split('\n').filter((l) => !HR.test(l)).join('\n')
    .replace(/^([ \t]{0,3})#{4,6}(?=[ \t])/gm, '$1###')
    .replace(/^([ \t]*)[•●▪◦‣∙][ \t]+/gm, '$1- ');
  if (o.punct) s = plainPunct(s);
  return restore(tidy(s), bag, false);
}

/** Formatted copy (no markdown): drop citation chips, hidden characters, rules, filler blocks */
export function tidyHtml(html, o = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const root = tpl.content;
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    const label = a.textContent.trim();
    if (/utm_source=chatgpt\.com/.test(href) && label.length <= 48 && label.split(/\s+/).length <= 5 && !a.closest('li, td') ) {
      dropChip(a);
      continue;
    }
    if (/^https?:/.test(href)) a.setAttribute('href', cleanUrl(href));
  }
  for (const e of root.querySelectorAll('hr')) e.remove();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const tn of texts) {
    let v = stripCites(base(tn.nodeValue).replace(/ {4}/g, ' '));
    if (!tn.parentElement || !tn.parentElement.closest('pre, code')) v = v.replace(/[ \t]{2,}/g, ' ');
    if (o.punct) v = plainPunct(v);
    if (v !== tn.nodeValue) tn.nodeValue = v;
  }
  for (const b of root.querySelectorAll('p, li, h1, h2, h3, div, blockquote')) {
    const first = firstText(b);
    if (!first) continue;
    const m = LEAD_EMOJI.exec(first.nodeValue);
    if (m && !KEEP_EMOJI.test(m[2])) first.nodeValue = m[1] + first.nodeValue.slice(m[0].length);
  }
  const blocks = () => [...root.children].filter((e) => e.textContent.trim() || e.querySelector('img'));
  let bs = blocks();
  if (bs.length > 1 && !bs[0].matches('ul, ol, table') && bs[0].textContent.trim().length <= 220 && INTRO.test(bs[0].textContent.trim())) bs[0].remove();
  for (let round = 0; round < 3; round++) {
    bs = blocks();
    if (bs.length < 2) break;
    const last = bs[bs.length - 1];
    const prev = bs[bs.length - 2];
    if (!last.matches('ul, ol, table') && last.textContent.trim().length <= 320 && CLOSE.test(last.textContent.trim())) last.remove();
    else if (last.matches('ul, ol') && bs.length > 2 && !prev.matches('ul, ol, table') && prev.textContent.trim().length <= 320 && CLOSE.test(prev.textContent.trim())) { last.remove(); prev.remove(); }
    else break;
  }
  for (const p of root.querySelectorAll('p, div, h1, h2, h3, li')) if (!p.textContent.trim() && !p.querySelector('img, br, a[data-file]')) p.remove();
  // squeeze runs of empty paragraphs to one
  for (const p of [...root.querySelectorAll('p')]) {
    const empty = (e) => e && e.tagName === 'P' && !e.textContent.trim() && !e.querySelector('img, a[data-file]');
    if (empty(p) && (empty(p.previousElementSibling) || !p.previousElementSibling || !p.nextElementSibling)) p.remove();
  }
  return tpl.innerHTML;
}

function firstText(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) if (w.currentNode.nodeValue.trim()) return w.currentNode;
  return null;
}
function dropChip(a) {
  let node = a;
  while (node.parentElement && node.parentElement.tagName === 'SPAN' && node.parentElement.textContent.trim() === a.textContent.trim()) node = node.parentElement;
  const prev = node.previousSibling;
  const next = node.nextSibling;
  node.remove();
  if (prev && prev.nodeType === 3 && next && next.nodeType === 3 && /\(\s*$/.test(prev.nodeValue) && /^\s*\)/.test(next.nodeValue)) {
    prev.nodeValue = prev.nodeValue.replace(/\s*\(\s*$/, '');
    next.nodeValue = next.nodeValue.replace(/^\s*\)/, '');
  }
  if (prev && prev.nodeType === 3 && (!next || (next.nodeType === 3 && /^[\s.,;:!?]/.test(next.nodeValue)))) prev.nodeValue = prev.nodeValue.replace(/\s+$/, '');
}
