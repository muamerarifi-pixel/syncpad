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

/* ───────────────── Readable: make a long, flat wall of text easy to read (on this device, no AI service) ─────────────────
   • a short "Key points" box at the top (the most telling sentences, in their order)
   • short lines that work as titles become headings; "Note:", "Important:"… labels are bold
   • very long paragraphs are cut into short ones, at the natural turns ("However…", "For example…")
   • inline lists ("1) … 2) …", "First… Second… Finally…", "you need: a, b, c and d") become real lists
   Pictures, files, tables, existing lists and headings are left exactly as they are. */
const KP_TITLE = 'Key points';
const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have he her him his how i if in into is it its just me more most my no not of on or our out over she so some than that the their them then there these they this those to too up us very was we were what when which who why will with would you your also about after again all any because before being both down during each few further here just only other own same should such through under until while yet one two get got make made like ' +
  'dhe në një për me që se nga të e i u ka kanë është janë do edhe por apo ose si ku kur më mos jo po ky kjo këtë këto ato ai ajo ata ato tij saj tyre ne ju unë ti jemi jeni isha ishte kishte kemi keni pra nëse sepse deri pas para mbi nën tek te pa duke qe qenë do të gjithë çdo vetëm shumë pak tani atëherë këtu atje').split(' '));
const TURN = /^(another|one more|the idea|however|but|also|additionally|moreover|furthermore|in addition|for example|for instance|on the other hand|in contrast|meanwhile|finally|in conclusion|to sum up|overall|first|second|third|next|then|lastly|as a result|therefore|so,|instead|still|megjithatë|por|gjithashtu|për shembull|nga ana tjetër|në fund|përfundimisht|si rezultat|prandaj|pra,|së pari|së dyti|së treti|më pas|pastaj|ndërkohë)\b/i;
const LABEL = /^(note|important|tip|warning|remember|caution|summary|example|key|reminder|shënim|kujdes|këshillë|e rëndësishme|kujtesë|shembull|përmbledhje)\s*[:\-–—]\s*/i;
const ORDINAL = /^(first(ly)?|second(ly)?|third(ly)?|fourth|fifth|next|then|after that|finally|lastly|së pari|së dyti|së treti|së katërti|më pas|pastaj|në fund)\b[,:]?\s*/i;
const ABBR = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|p\.sh|etj|nr|fig|vol|no|approx|zt|znj|ing|av|kap|fq)|\b[A-Z]|\d)\.$/i;
const isRtl = (t) => (t.match(/[֐-ࣿ]/g) || []).length > t.replace(/\s/g, '').length * 0.3;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const words = (t) => (t.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);

export function sentences(text) {
  const parts = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…؟]["”’»)\]]?)\s+(?=["“«'(\[]?[\p{Lu}\p{Lo}\d])/u);
  const out = [];
  for (const p of parts) {
    if (out.length && ABBR.test(out[out.length - 1])) out[out.length - 1] += ' ' + p;
    else if (p) out.push(p);
  }
  return out;
}

/** a flat paragraph → short paragraphs (and lists where the text is really a list) */
function splitBlock(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  // "1) a 2) b 3) c" / "1. a 2. b 3. c" inside one paragraph
  const num = t.split(/\s(?=\(?\d{1,2}[.)]\s+\S)/);
  if (num.length >= 3 && num.slice(1).every((x) => /^\(?\d{1,2}[.)]\s/.test(x))) {
    const lead = /^\(?\d{1,2}[.)]\s/.test(num[0]) ? '' : num.shift();
    return [...(lead ? [{ p: lead }] : []), { ol: num.map((x) => x.replace(/^\(?\d{1,2}[.)]\s+/, '')) }];
  }
  // "you will need: eggs, milk, flour, sugar and butter."
  const ss = sentences(t);
  if (ss.length === 1 && colonList(t)) { const cl = colonList(t); return [{ p: cl.lead }, { ul: cl.items }]; }
  // "First, … Second, … Finally, …"
  const ord = ss.filter((x) => ORDINAL.test(x)).length;
  if (ord >= 3 && ord >= ss.length * 0.5) {
    const lead = [];
    while (ss.length && !ORDINAL.test(ss[0])) lead.push(ss.shift());
    const items = [];
    for (const x of ss) { if (ORDINAL.test(x) || !items.length) items.push(x.replace(ORDINAL, (m) => m)); else items[items.length - 1] += ' ' + x; }
    return [...(lead.length ? [{ p: lead.join(' ') }] : []), { ol: items.map((x) => x.replace(ORDINAL, '').replace(/^\p{Ll}/u, (c) => c.toUpperCase())) }];
  }
  if (t.length < 380 || ss.length < 4) {
    const k = ss.findIndex((x) => colonList(x));
    if (k < 0 || ss.length === 1) return [{ p: t }];
  }
  // cut into paragraphs of 2–3 sentences, preferring the natural turns
  const paras = [];
  let cur = [];
  let len = 0;
  for (const x of ss) {
    const turn = TURN.test(x) && cur.length >= 1;
    if (cur.length && (turn || len + x.length > 340 || cur.length >= 3)) { paras.push(cur.join(' ')); cur = []; len = 0; }
    cur.push(x);
    len += x.length;
  }
  if (cur.length) {
    // a lone short last sentence joins the paragraph before it
    if (paras.length && cur.length === 1 && cur[0].length < 90) paras[paras.length - 1] += ' ' + cur[0];
    else paras.push(cur.join(' '));
  }
  // a lone short sentence joins the paragraph before it (unless it starts a new turn)
  const merged = [];
  for (const p of paras) {
    if (merged.length && sentences(p).length === 1 && p.length < 140 && !TURN.test(p)) merged[merged.length - 1] += ' ' + p;
    else merged.push(p);
  }
  // "…you will need: a, b, c and d." inside a paragraph becomes its own list
  const out = [];
  for (const p of merged) {
    const ps = sentences(p);
    const k = ps.findIndex((x) => colonList(x));
    if (k < 0) { out.push({ p }); continue; }
    const cl = colonList(ps[k]);
    if (k > 0) out.push({ p: ps.slice(0, k).join(' ') });
    out.push({ p: cl.lead }, { ul: cl.items });
    if (k < ps.length - 1) out.push({ p: ps.slice(k + 1).join(' ') });
  }
  return out;
}
function colonList(t) {
  const m = t.match(/^(.{3,140}?):\s+(.+)$/);
  if (!m) return null;
  const items = m[2].replace(/[.;]\s*$/, '').split(/\s*[,;]\s*|\s+(?:and|or|dhe|ose)\s+(?=[^,]+$)/i).filter(Boolean);
  return items.length >= 4 && items.every((x) => x.split(' ').length <= 6) ? { lead: m[1] + ':', items } : null;
}

function keyPoints(allSentences, nWords) {
  const freq = new Map();
  for (const s of allSentences) for (const w of words(s.text)) if (w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)) freq.set(w, (freq.get(w) || 0) + 1);
  const top = Math.max(1, ...freq.values());
  const scored = allSentences.map((s, i) => {
    const ws = words(s.text);
    if (ws.length < 6 || ws.length > 45) return { i, s, v: -1 };
    // a line that only introduces a quote or a list ("…said:") is not a point by itself
    if (/[:：]\s*$/.test(s.text) || /^["“«'„]/.test(s.text.trim())) return { i, s, v: -1 };
    let v = 0;
    for (const w of ws) v += (freq.get(w) || 0) / top;
    v = v / Math.sqrt(ws.length);
    if (s.first) v *= 1.25; // a paragraph's opening sentence usually carries its point
    if (/\d/.test(s.text)) v *= 1.1;
    if (/\?$/.test(s.text.trim())) v *= 0.6;
    return { i, s, v };
  });
  const n = nWords > 900 ? 5 : nWords > 450 ? 4 : 3;
  const pick = scored.filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, n).sort((a, b) => a.i - b.i);
  return pick.map((x) => x.s.text.length > 220 ? x.s.text.slice(0, 217).replace(/\s+\S*$/, '') + '…' : x.s.text);
}

/** returns new HTML, or the same HTML when there is nothing worth changing */
export function readable(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const root = tpl.content;
  // an earlier "Key points" box is rebuilt, not doubled
  for (const o of [...root.children].filter((q) => q.tagName === 'BLOCKQUOTE').filter((q) => q.classList.contains('kp') || (q.firstElementChild && q.firstElementChild.tagName === 'B' && q.firstElementChild.textContent.trim() === KP_TITLE))) { const nx = o.nextElementSibling; o.remove(); if (nx && nx.tagName === 'HR') nx.remove(); }
  const plainBlock = (e) => /^(P|DIV)$/.test(e.tagName) && !e.querySelector('img, a[data-file], table, ul, ol, pre, h1, h2, h3, blockquote, br + br') && !isRtl(e.textContent);
  const kids = [...root.children];
  const all = [];
  let nWords = 0;
  let changed = false;
  kids.forEach((e, idx) => {
    const text = e.textContent.replace(/\s+/g, ' ').trim();
    if (!text) return;
    nWords += words(text).length;
    if (!plainBlock(e)) { if (/^(P|DIV|LI|BLOCKQUOTE)$/.test(e.tagName)) sentences(text).forEach((s, k) => all.push({ text: s, first: k === 0 })); return; }
    const hasInline = !!e.querySelector('b, strong, i, em, u, a, mark, span[style], font');
    // a short line on its own, followed by a longer paragraph → heading
    const next = kids.slice(idx + 1).find((x) => x.textContent.trim());
    const nextLen = next ? next.textContent.trim().length : 0;
    if (text.length <= 70 && text.split(' ').length <= 9 && !/[.,;!?…]$/.test(text) && nextLen > 120 && idx > 0 || (/^[^.!?]{3,60}:$/.test(text) && nextLen > 60)) {
      const h = document.createElement('h3');
      h.textContent = text.replace(/:$/, '');
      e.replaceWith(h);
      changed = true;
      return;
    }
    sentences(text).forEach((s, k) => all.push({ text: s, first: k === 0 }));
    if (hasInline) return; // keep the user's own formatting untouched
    const parts = splitBlock(text);
    const lab = LABEL.exec(text);
    if (parts.length === 1 && parts[0].p && !lab) return;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part.p) {
        const p = document.createElement('p');
        const m = LABEL.exec(part.p);
        if (m) { const b = document.createElement('b'); b.textContent = m[0].trim().replace(/[:\-–—]$/, '') + ':'; p.append(b, ' ' + part.p.slice(m[0].length)); }
        else p.textContent = part.p;
        frag.append(p);
      } else {
        const list = document.createElement(part.ol ? 'ol' : 'ul');
        for (const it of part.ol || part.ul) { const li = document.createElement('li'); li.textContent = it.replace(/[;,]\s*$/, ''); list.append(li); }
        frag.append(list);
      }
    }
    e.replaceWith(frag);
    changed = true;
  });
  if (nWords >= 220 && all.length >= 8) {
    const kp = keyPoints(all, nWords);
    if (kp.length >= 2) {
      const bq = document.createElement('blockquote');
      bq.className = 'kp';
      bq.innerHTML = `<b>${KP_TITLE}</b><ul>${kp.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
      // the note's title (its first short line) stays first; the box goes right under it
      const first = [...root.children].find((x) => x.textContent.trim());
      const isTitle = first && (/^H[1-3]$/.test(first.tagName) || (first.textContent.trim().length <= 120 && !first.matches('ul, ol, table, blockquote')));
      if (isTitle) first.after(bq, document.createElement('hr'));
      else root.prepend(bq, document.createElement('hr'));
      changed = true;
    }
  }
  return changed ? tpl.innerHTML : String(html || '');
}
