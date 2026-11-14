// De-clutter: tidies text copied from AI chat apps (ChatGPT, Gemini, Claude, Copilot, Perplexity…)
// right on the device with plain JavaScript + regex — no API key, works offline.
//   isAiText(text, html)  → does this paste look like it came from an AI chat?
//   plainText(text, o)    → clean plain text (Drops)
//   markdown(text, o)     → clean markdown, ready to become rich text (Notes)
//   tidyHtml(html, o)     → clean already-formatted HTML (Notes, when the copy has no markdown)
//   looksMarkdown(text)   → does the text still carry markdown symbols?
// o.punct: also swap — dashes, “curly” quotes and … for plain ones.

const HIDDEN = /[​‌⁠-⁤﻿­‎‏‪-‮⁦-⁩᠎\u206A-\u206F]/g;
const STRAY_ZWJ = /(?<!\p{Extended_Pictographic}️?)‍|‍(?!\p{Extended_Pictographic})/gu;
const ODD_SPACE = /[  -   　]/g;
const PRIVATE = /[-]/g;
const EMO = '(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}{2})\\uFE0F?(?:\\u200D\\p{Extended_Pictographic}\\uFE0F?)*';
const LEAD_EMOJI = new RegExp(`^([ \\t]*(?:#{1,6}[ \\t]+|[-*+•][ \\t]+|\\d{1,3}[.)][ \\t]+|>[ \\t]*)?)((?:${EMO}[ \\t]*)+)(?=\\S)`, 'u');
const KEEP_EMOJI = /^[✅❌✔✖☑⚠❗❓✓✗️\s]+$/u; // these carry meaning (yes / no / warning)
const KEYCAP = /^([ \t]*)([0-9])️?⃣[ \t]*/gm;

const INTERJ = '(?:sure|certainly|absolutely|of course|definitely|okay|ok|alright|got it|no problem|no worries|understood|perfect|great|excellent|gladly|for sure|you bet|totally|yes|hello|hi|hey|sigurisht|patjetër|po patjetër|natyrisht|me kënaqësi|me shumë kënaqësi|në rregull|shumë mirë|dakord|përshëndetje|po)';
const INTRO = new RegExp(
  `^(?:${INTERJ}[!.,—–-]?\\s*$` +
  `|(?:(?:${INTERJ}|(?:great|good|excellent|nice|interesting|fair|that(?:'|’)s a great) (?:question|idea|point|catch|choice)|thanks for (?:asking|sharing)[^!.,\\n]{0,60}|pyetje e mirë)\\s*[!.,—–-]+\\s*)?` +
  `(?:here(?:'|’)s|here (?:is|are)|below (?:is|are|you(?:'|’)ll find)|i(?:'|’)ve (?:rewritten|revised|updated|cleaned|polished|put together|created|made|written|drafted|summarized|organized|prepared)|i(?:'|’)ll (?:break|walk|explain|give|summarize|outline|show)|i(?:'|’)d be (?:happy|glad) to|i(?:'|’)m (?:happy|glad) to|let(?:'|’)s (?:break|go|look|walk|dive|get started)|based on (?:your|the) [^\\n]{1,60},|ja(?:\\s|,)|këtu (?:është|janë|e ke|i ke|ke)|më poshtë (?:është|janë|e ke|ke|po|do të gjesh)|po ta (?:shpjegoj|jap|përmbledh))[^\\n]{0,220}[:.!]?` +
  `|(?:that(?:'|’)s a )?(?:great|good|excellent|nice|interesting|fair) (?:question|idea|point|catch|choice)[!.]?\\s*$|pyetje e mirë[!.]?\\s*$|(?:i(?:'|’)d be |i(?:'|’)m )?(?:happy|glad) to help[^\\n]{0,120}[!.:]?)$`, 'iu');
const LEAD_INTERJ = new RegExp(`^(?:${INTERJ}|(?:that(?:'|’)s a )?(?:great|good|excellent) question|pyetje e mirë)\\s*[!.,—–-]+\\s+(?=\\S)`, 'iu');
const CLOSE = /^[-—*_\s]*(?:i hope (?:this|that|it|these)|hope (?:this|that|it) helps|let me know|please let me know|just let me know|feel free|don(?:'|’)t hesitate|ask away\b|would you like|do you want|want me to|need me to|if you(?:'|’)d like|if you want|if you need|if needed,? i can|if anything (?:is unclear|needs)|i can also|i could also|shall i|should i also|need anything else|anything else\b|is there anything|is this what you|was this helpful|tell me (?:if|what) you|just say the word|next steps (?:you|we) can|happy to help|glad (?:i could|to) help|good luck|best of luck|shpresoj|më trego|më thuaj|më njofto|nëse dëshiron|nëse do\b|nëse ke nevojë|nëse të duhet|nëse të intereson|dëshiron (?:që|të)|a do (?:që|të)|a dëshiron|a do të doje|mund ta bëj|mund të bëj edhe|mos hezito|mos ngurro|suksese\b|fat të mbarë)/iu;
const UI_CHROME_LINE = /^[ \t]*(?:show thinking|hide thinking|thinking process:?|thinking\.{0,3}|thought for \d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes)|searched(?: \d+)? (?:web )?pages?|read \d+ web pages?|analyzed(?: \d+ sources?| with \w+)|copy code|copy|regenerate|was this helpful\??|like|dislike|share|(?:you|chatgpt|gemini|claude|copilot|deepseek|grok|perplexity|assistant) said:?|(?:bash|sh|zsh|powershell|ps1|cmd|python|py|js|jsx|ts|tsx|javascript|typescript|json|yaml|yml|toml|xml|html|css|scss|sql|go|rust|rs|java|kotlin|swift|c|cpp|csharp|cs|php|ruby|rb|r|dart|lua|text|plaintext|markdown|md|diff)[ \t]*copy(?:[ \t]+code)?)[ \t]*$/i;

const LIST_LINE = /^[ \t]*(?:[-*+•●▪◦‣∙]|\d{1,3}[.)])[ \t]+\S/;
const HR = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/* ───── shared steps ───── */

function dedentOutsideCode(text) {
  const lines = text.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = /^[ ]*/.exec(l);
    min = Math.min(min, m ? m[0].length : 0);
    if (min < 2) return text;
  }
  if (!Number.isFinite(min) || min < 2) return text;
  const cut = ' '.repeat(min);
  return lines.map((l) => (l.startsWith(cut) ? l.slice(min) : l)).join('\n');
}

function stripUiChrome(text) {
  return text.split('\n').filter((l) => !UI_CHROME_LINE.test(l.trim())).join('\n').replace(/^\n+|\n+$/g, '');
}

function base(text, dedent = true) {
  const s = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u2028|\u2029/g, '\n')
    .replace(HIDDEN, '')
    .replace(STRAY_ZWJ, '')
    .replace(ODD_SPACE, ' ')
    .replace(/\t/g, '    ');
  return dedent ? dedentOutsideCode(s) : s;
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

const TRACKING_PARAM = /^(?:utm_|fbclid$|gclid$|yclid$|mc_cid$|mc_eid$|igshid$|igsh$|_hsenc$|_hsmi$|srsltid$|ref_src$|ref_url$)/i;
const AI_CITE_URL = /utm_source=(?:chatgpt\.com|openai|perplexity|gemini|copilot)|[?&]source=perplexity/i;

function cleanUrl(u) {
  try {
    const x = new URL(u);
    let changed = false;
    for (const k of [...x.searchParams.keys()]) if (TRACKING_PARAM.test(k)) { x.searchParams.delete(k); changed = true; }
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
    s = s.replace(/[ \t]?\(\s*\[[^\]\n]{1,80}\]\[[^\]\n]+\](?:\s*[,;]?\s*\[[^\]\n]{1,80}\]\[[^\]\n]+\])*(?:\s*\+\d+)?\s*\)/g, '');
    s = s.replace(/\[([^\]\n]+)\]\[([^\]\n]*)\]/g, (m, t, k) => {
      const u = defs.get((k || t).trim().toLowerCase());
      if (!u) return m;
      return keepLinks ? `[${t}](${u})` : t;
    });
  }
  // inline citation pills: ([Reuters](https://…)) or ([BBC](…), [CNN](…) +2)
  s = s.replace(/[ \t]?\(\s*\[[^\]\n]{1,80}\]\(https?:[^)\s]+\)(?:\s*[,;]?\s*\[[^\]\n]{1,80}\]\(https?:[^)\s]+\))*(?:\s*\+\d+)?\s*\)/g, '');
  // strip trailing AI "Sources / Citations" block when it consists only of AI-tracked source pills/links
  s = s.replace(/\n{1,2}(?:#{1,3}[ \t]+)?(?:\*{1,2})?(?:Sources|Citations|References)(?:\*{1,2})?:?[ \t]*\n([\s\S]{1,1200})$/i, (m, tail) => {
    const ls = tail.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!ls.length) return '';
    const isAiSrcLine = (x) => AI_CITE_URL.test(x) || /^(?:[-*•]|\d+[.)])?\s*(?:\[[^\]]+\]\([^)]+\)|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\s*\+\d+)?)\s*$/i.test(x);
    return ls.every(isAiSrcLine) && ls.some((x) => AI_CITE_URL.test(x) || /\+\d+/.test(x)) ? '' : m;
  });
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
    .replace(/(?<=[\p{L}\p{N}.,;:!?)"'”’\]\u0000])[ \t]*\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\](?![(:])/gu, '')
    .replace(/(?<=[\p{L}\p{N}.,;:!?)"'”’\]\u0000])[ \t]*\(\s*[a-z0-9-]+(?:\.[a-z0-9-]+)+\s+\+\d+\s*\)/giu, '')
    .replace(/(?:^|\n)[ \t]*[Aa]s an AI(?: language model| assistant| model)?,\s*/g, (m) => (m.startsWith('\n') ? '\n' : ''))
    .replace(/\b[Aa]s an AI(?: language model| assistant| model)?,\s*/g, '')
    .replace(PRIVATE, '');
}

/* ───── maths (\( x^2 \), $$ \frac{a}{b} $$) → readable text ───── */
const TEX = { times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', approx: '≈', neq: '≠', ne: '≠', leq: '≤', le: '≤', geq: '≥', ge: '≥',
  equiv: '≡', cong: '≅', propto: '∝', sim: '∼', simeq: '≃', ll: '≪', gg: '≫',
  to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←', Leftarrow: '⇐', leftrightarrow: '↔', iff: '⇔', implies: '⇒', mapsto: '↦',
  infty: '∞', circ: '°', degree: '°', deg: '°', angle: '∠', perp: '⊥', parallel: '∥',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', Theta: 'Θ', iota: 'ι', kappa: 'κ', lambda: 'λ', Lambda: 'Λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', Pi: 'Π', rho: 'ρ', sigma: 'σ', Sigma: 'Σ', tau: 'τ', phi: 'φ', Phi: 'Φ', chi: 'χ', psi: 'ψ', Psi: 'Ψ', omega: 'ω', Omega: 'Ω',
  sum: 'Σ', prod: 'Π', int: '∫', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  ldots: '…', dots: '…', cdots: '⋯', quad: ' ', qquad: '  ', percent: '%', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', cap: '∩', cup: '∪' };
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', n: 'ⁿ', '+': '⁺', '-': '⁻' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
const BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ' };
function tex(src) {
  const wrap = (x) => (/^[\w.]+$/.test(x.trim()) ? x.trim() : `(${x.trim()})`);
  let t = src.trim();
  for (let k = 0; k < 4; k++) {
    t = t.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (m, a, b) => `${wrap(a)}/${wrap(b)}`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (m, a) => `√${wrap(a)}`)
      .replace(/\\mathbb\s*\{([RNZQC])\}/g, (m, c) => BLACKBOARD[c] || c)
      .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|textbf|textit|boxed|mbox)\s*\{([^{}]*)\}/g, '$1');
  }
  return t.replace(/\\left|\\right/g, '')
    .replace(/\\([A-Za-z]+)/g, (m, k) => (k in TEX ? TEX[k] : m))
    .replace(/\\([%$&#_{}])/g, '$1')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\^\{\s*-1\s*\}/g, '⁻¹')
    .replace(/\^\{?([0-9n])\}?/g, (m, d) => SUP[d] || `^${d}`)
    .replace(/\_\{?([0-9])\}?/g, (m, d) => SUB[d] || `_${d}`)
    .replace(/[_^]\{([^{}]*)\}/g, (m, a) => (m[0] === '^' ? '^' : '_') + a)
    .replace(/[{}]/g, '')
    .replace(/[ \t]{2,}/g, ' ');
}
const maths = (s) => s
  .replace(/\$\$([\s\S]+?)\$\$/g, (m, a) => tex(a))
  .replace(/\\\[([\s\S]+?)\\\]/g, (m, a) => tex(a))
  .replace(/\\\(([\s\S]+?)\\\)/g, (m, a) => tex(a))
  .replace(/(?<![\\\w$])\$(?!\s)([^$\n]{1,120}?)(?<!\s)\$(?!\d)/g, (m, a) => {
    const inner = a.trim();
    if (/^\d[\d.,]*(?:\s|$)/.test(inner)) return m;
    if (/\\[A-Za-z]+|\^|_|\{[^}]+\}|^[A-Za-z]\s*[=<>±≈≠≤≥]\s*[A-Za-z0-9()+\-*/^_\\ ]+$/.test(inner)) return tex(inner);
    return m;
  });

/* ───── "Sure! Here's…" and "Let me know if…" ───── */
function trimFiller(s) {
  let paras = s.split(/\n[ \t]*\n/);
  const text = (p) => p.replace(/^[ \t>#*_-]+|[*_]+/g, '').trim();
  for (let round = 0; round < 2 && paras.length > 1; round++) {
    const first = text(paras[0]);
    if (!first.includes('\n') && first.length <= 240 && INTRO.test(first)) { paras.shift(); continue; }
    const nl = paras[0].indexOf('\n');
    if (nl > 0) {
      const l1 = text(paras[0].slice(0, nl));
      if (l1.length <= 220 && INTRO.test(l1)) { paras[0] = paras[0].slice(nl + 1); continue; }
    }
    break;
  }
  if (paras.length) paras[0] = paras[0].replace(LEAD_INTERJ, '').replace(/^\S/, (c) => c.toUpperCase());
  for (let round = 0; round < 4 && paras.length > 1; round++) {
    let cut = -1;
    for (let i = paras.length - 1; i >= Math.max(1, paras.length - 4); i--) {
      const p = text(paras[i]);
      if (p.length <= 340 && CLOSE.test(p)) { cut = i; break; }
      if (!paras[i].split('\n').every((l) => !l.trim() || LIST_LINE.test(l) || /^[ \t]{2,}\S/.test(l))) break;
    }
    if (cut < 1) break;
    if (!paras.slice(cut + 1).every((p) => p.split('\n').every((l) => !l.trim() || LIST_LINE.test(l) || /^[ \t]{2,}\S/.test(l) || CLOSE.test(text(l))))) break;
    paras = paras.slice(0, cut);
    while (paras.length > 1 && HR.test(paras[paras.length - 1].trim())) paras.pop();
  }
  while (paras.length > 1 && HR.test(paras[0].trim())) paras.shift();
  while (paras.length > 1 && HR.test(paras[paras.length - 1].trim())) paras.pop();
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
  return /(?:^|[\s("“'\[>])\*\*[^*\n]+?\*\*|^\s{0,3}#{1,6}[ \t]+\S|^\s*\|.+\|\s*\n\s*\|?\s*:?-{3,}|^\s*[-*+][ \t]+\[[ xX]\][ \t]|\[[^\]\n]+\]\(https?:|^[ \t]*```|`[^`\n]+`|^[ \t]*>[ \t]+\S|^[ \t]{0,3}(?:---|\*\*\*|___)[ \t]*$/m.test(t) ||
    (t.match(/^\s*(?:[-*+•]|\d{1,3}[.)])[ \t]+\S/gm) || []).length >= 2;
}

export function aiScore(text, html = '') {
  const t = String(text || '');
  const h = String(html || '');
  let n = 0;
  if (/data-start="\d+"|data-end="\d+"|data-message-author-role|font-claude|data-is-streaming|standard-markdown|model-response|message-content|ds-markdown|cib-|ac-textBlock|markdown prose|data-sourcepos|utm_source=(?:chatgpt\.com|perplexity|gemini|copilot)/.test(h)) n += 3;
  if (/utm_source=(?:chatgpt\.com|openai|perplexity|gemini|copilot)|[?&]source=perplexity|【[^】\n]*】|oaicite|contentReference\[|\bturn\d+(?:search|news|view|fetch)\d+|[-]/.test(t)) n += 3;
  if (/[​‌⁠﻿]/.test(t)) n += 2;
  if (t.split('\n').some((l) => UI_CHROME_LINE.test(l.trim()))) n += 2;
  if (/(^|[\s("“'\[>])\*\*[^*\n]+\*\*/m.test(t)) n += 2;
  if (/^\s{0,3}#{1,6}[ \t]+\S/m.test(t)) n += 2;
  if (/^\s*\|.+\|\s*\n\s*\|?\s*:?-{3,}/m.test(t)) n += 2;
  if (/^[ \t]*```/m.test(t)) n += 2;
  if (/\\\(|\\\[|\$\$|\\(?:frac|times|approx|leq|geq|rightarrow)/.test(t)) n += 1;
  if (/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/m.test(t)) n += 1;
  if ((t.match(/^\s*(?:[-*+•]|\d{1,3}[.)])[ \t]+\S/gm) || []).length >= 2) n += 1;
  if (/\[[^\]\n]+\]\(https?:/.test(t)) n += 1;
  if (/(?<=[\p{L}.,;:!?)])\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]/u.test(t)) n += 1;
  if ((t.match(/—/g) || []).length >= 2) n += 1;
  const lines = t.split('\n');
  if (lines.filter((l) => { const m = LEAD_EMOJI.exec(l); return m && !KEEP_EMOJI.test(m[2]); }).length >= 2) n += 1;
  const paras = t.trim().split(/\n\s*\n/);
  const firstL = (paras[0] || '').split('\n')[0].trim();
  const hasIntro = !!(firstL && INTRO.test(firstL));
  const hasClose = !!(paras.length > 1 && CLOSE.test(paras[paras.length - 1].trim()));
  if (hasIntro) n += 1;
  if (hasClose) n += 1;
  if (hasIntro && hasClose) n += 1;
  return n;
}
export const isAiText = (text, html) => !!String(text || '').trim() && aiScore(text, html) >= 2;

export function plainText(text, o = {}) {
  let s = base(text);
  let bag;
  [s, bag] = protect(s);
  s = stripUiChrome(s);
  s = maths(cleanUrls(stripCites(refLinks(s, false))));
  s = mdToPlain(emojiLines(trimFiller(s)));
  if (o.punct) s = plainPunct(s);
  return restore(tidy(s), bag, true);
}

export function markdown(text, o = {}) {
  let s = base(text);
  let bag;
  [s, bag] = protect(s);
  s = stripUiChrome(s);
  s = maths(cleanUrls(stripCites(refLinks(s, true))));
  s = emojiLines(trimFiller(s))
    .split('\n').filter((l) => !HR.test(l)).join('\n')
    .replace(/^([ \t]{0,3})#{4,6}(?=[ \t])/gm, '$1###')
    .replace(/^([ \t]*)[•●▪◦‣∙][ \t]+/gm, '$1- ');
  if (o.punct) s = plainPunct(s);
  return restore(tidy(s), bag, false);
}

function inlineMdToDom(tn) {
  const txt = tn.nodeValue;
  if (!/(?:\*\*\*[^*\n]+?\*\*\*|\*\*[^*\n]+?\*\*|`[^`\n]+`|~~[^~\n]+?~~|==[^=\n]+?==|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|(?<![\p{L}\p{N}*\\])\*(?=[^\s*])[^*\n]+?(?<=[^\s*\\])\*(?![\p{L}\p{N}*]))/u.test(txt)) return;
  const re = /(\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|`([^`\n]+)`|~~([^~\n]+?)~~|==([^=\n]+?)==|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\p{L}\p{N}*\\])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*\\])\*(?![\p{L}\p{N}*]))/gu;
  const frag = document.createDocumentFragment();
  let last = 0;
  let m;
  let changed = false;
  while ((m = re.exec(txt))) {
    if (m.index > last) frag.append(txt.slice(last, m.index));
    changed = true;
    if (m[2] != null) { const b = document.createElement('b'); const em = document.createElement('i'); em.textContent = m[2]; b.append(em); frag.append(b); }
    else if (m[3] != null) { const el = document.createElement('b'); el.textContent = m[3]; frag.append(el); }
    else if (m[4] != null) { const el = document.createElement('code'); el.textContent = m[4]; frag.append(el); }
    else if (m[5] != null) { const el = document.createElement('s'); el.textContent = m[5]; frag.append(el); }
    else if (m[6] != null) { const el = document.createElement('mark'); el.textContent = m[6]; frag.append(el); }
    else if (m[7] != null && m[8] != null) {
      const el = document.createElement('a');
      el.href = cleanUrl(m[8]);
      el.textContent = m[7];
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
      frag.append(el);
    } else if (m[9] != null) {
      const el = document.createElement('i');
      el.textContent = m[9];
      frag.append(el);
    }
    last = re.lastIndex;
  }
  if (!changed) return;
  if (last < txt.length) frag.append(txt.slice(last));
  tn.replaceWith(frag);
}

/** Formatted copy (no markdown): drop citation chips, hidden characters, foreign styles, rules, filler blocks */
export function tidyHtml(html, o = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const root = tpl.content;
  // Unwrap AI chat container divs/sections/articles so blocks sit at the top level
  for (let pass = 0; pass < 4; pass++) {
    let unwrapped = false;
    for (const box of [...root.querySelectorAll('div, section, article')]) {
      if (box.closest('pre, code, table')) continue;
      if (box.querySelector('p, div, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, hr, section, article')) {
        box.replaceWith(...box.childNodes);
        unwrapped = true;
      }
    }
    if (!unwrapped) break;
  }
  // Normalize h4-h6 down to h3 so hierarchy stays clean inside notes
  for (const h of [...root.querySelectorAll('h4, h5, h6')]) {
    const h3 = document.createElement('h3');
    h3.append(...h.childNodes);
    h.replaceWith(h3);
  }
  // Strip foreign web background/font/color styles while preserving user marks, callouts, files, and links
  for (const el of [...root.querySelectorAll('span, font, p, div, li, h1, h2, h3, blockquote, b, strong, i, em, u, s, td, th')]) {
    if (el.closest('pre, code, .kp, .link-card, [data-file]')) continue;
    if (el.hasAttribute('style')) {
      if (el.tagName === 'IMG') continue;
      el.removeAttribute('style');
    }
    if (el.tagName === 'FONT') { el.replaceWith(...el.childNodes); continue; }
    if (el.tagName === 'SPAN' && !el.attributes.length) el.replaceWith(...el.childNodes);
  }
  // Split double <br> breaks inside <p>/<div> into real paragraphs, or single <br> lines if list/heading markers exist
  for (const el of [...root.querySelectorAll('p, div')]) {
    if (el.closest('pre, code, table, li, blockquote')) continue;
    const h = el.innerHTML;
    if (!/(?:<br\s*\/?>\s*){2,}/i.test(h)) continue;
    const parts = h.split(/(?:<br\s*\/?>\s*){2,}/i).map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1) {
      el.replaceWith(...parts.map((part) => { const p = document.createElement('p'); p.innerHTML = part; return p; }));
    }
  }
  for (const sup of root.querySelectorAll('sup')) {
    if (/^\s*\[?\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]?\s*$/.test(sup.textContent)) dropChip(sup);
  }
  for (const a of root.querySelectorAll('a[href]')) {
    if (a.hasAttribute('data-file') || a.classList.contains('link-card')) continue;
    const href = a.getAttribute('href') || '';
    const label = a.textContent.trim();
    if ((AI_CITE_URL.test(href) && label.length <= 48 && label.split(/\s+/).length <= 5 && !a.closest('li, td')) ||
        (/^https?:/.test(href) && /^\[?\d{1,3}\]?$/.test(label))) {
      dropChip(a);
      continue;
    }
    if (/^https?:/.test(href)) a.setAttribute('href', cleanUrl(href));
  }
  for (const bq of root.querySelectorAll('blockquote.kp')) bq.remove();
  for (const e of root.querySelectorAll('hr')) e.remove();
  for (const p of [...root.querySelectorAll('p')]) {
    const raw = (p.textContent || '').trim();
    if (HR.test(raw) && !p.querySelector('img, a[data-file], .audio-card, .link-card')) p.remove();
  }
  root.normalize();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const tn of texts) {
    if (tn.parentElement && tn.parentElement.closest('pre, code, .link-card, [data-file]')) continue;
    let v = maths(stripCites(base(tn.nodeValue, false).replace(/ {4}/g, ' ')));
    v = v.replace(/[ \t]{2,}/g, ' ');
    if (o.punct) v = plainPunct(v);
    if (v !== tn.nodeValue) tn.nodeValue = v;
    if (!tn.parentElement || !tn.parentElement.closest('a, pre, code')) inlineMdToDom(tn);
  }
  // Drop UI chrome blocks ("Copy code", "ChatGPT said:", "Thought for 4s"…) and convert heading-prefixed <p>/<div>s
  for (const b of [...root.querySelectorAll('p, div, h1, h2, h3, blockquote')]) {
    if (b.closest('pre, code, table, li, .kp')) continue;
    const raw = b.textContent.trim();
    if (!raw && !b.querySelector('img, br, a[data-file]')) { b.remove(); continue; }
    if (UI_CHROME_LINE.test(raw) && !b.querySelector('img, a[data-file]')) { b.remove(); continue; }
    if (/^(P|DIV)$/.test(b.tagName) && !b.querySelector('img, a[data-file], pre, table, ul, ol')) {
      const hm = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(raw);
      if (hm) {
        const tag = hm[1].length <= 1 ? 'h1' : hm[1].length === 2 ? 'h2' : 'h3';
        const hx = document.createElement(tag);
        hx.textContent = hm[2];
        b.replaceWith(hx);
      }
    }
  }
  // Merge consecutive bullet / numbered <p>/<div> paragraphs into proper <ul>/<ol> lists
  let curList = null;
  let curKind = '';
  for (const kid of [...root.children]) {
    const isPlain = /^(P|DIV)$/.test(kid.tagName) && !kid.querySelector('img, a[data-file], ul, ol, pre, table, br');
    const txt = isPlain ? kid.textContent.trim() : '';
    const bm = isPlain ? /^([-*+•●▪◦‣∙])\s+(\S[\s\S]*)$/.exec(txt) : null;
    const nm = !bm && isPlain ? /^(\d{1,3})[.)]\s+(\S[\s\S]*)$/.exec(txt) : null;
    if (bm || nm) {
      const want = nm ? 'ol' : 'ul';
      if (!curList || curKind !== want) {
        curList = document.createElement(want);
        curKind = want;
        kid.before(curList);
      }
      const li = document.createElement('li');
      const leadRe = nm ? /^\s*\d{1,3}[.)]\s+/ : /^\s*[-*+•●▪◦‣∙]\s+/;
      li.append(...kid.childNodes);
      const ft = firstText(li);
      if (ft) ft.nodeValue = ft.nodeValue.replace(leadRe, '');
      curList.append(li);
      kid.remove();
    } else {
      curList = null;
      curKind = '';
    }
  }
  for (const b of root.querySelectorAll('p, li, h1, h2, h3, div, blockquote')) {
    const first = firstText(b);
    if (!first) continue;
    const m = LEAD_EMOJI.exec(first.nodeValue);
    if (m && !KEEP_EMOJI.test(m[2])) first.nodeValue = m[1] + first.nodeValue.slice(m[0].length);
  }
  const blocks = () => [...root.children].filter((e) => e.textContent.trim() || e.querySelector('img, a[data-file]'));
  for (let round = 0; round < 2; round++) {
    const bs = blocks();
    if (bs.length > 1 && !bs[0].matches('ul, ol, table, pre') && bs[0].textContent.trim().length <= 240 && INTRO.test(bs[0].textContent.trim())) {
      bs[0].remove();
    } else break;
  }
  const bs0 = blocks();
  if (bs0.length && !bs0[0].matches('ul, ol, table, pre, h1, h2, h3')) {
    const w = document.createTreeWalker(bs0[0], NodeFilter.SHOW_TEXT);
    let ft;
    while ((ft = w.nextNode())) {
      if (ft.nodeValue && ft.nodeValue.trim()) {
        const stripped = ft.nodeValue.replace(LEAD_INTERJ, '');
        if (stripped !== ft.nodeValue) ft.nodeValue = stripped;
        break;
      }
    }
  }
  for (let round = 0; round < 4; round++) {
    const bs = blocks();
    if (bs.length < 2) break;
    const last = bs[bs.length - 1];
    const prev = bs[bs.length - 2];
    if (!last.matches('ul, ol, table, pre') && last.textContent.trim().length <= 340 && CLOSE.test(last.textContent.trim())) last.remove();
    else if (last.matches('ul, ol') && bs.length > 2 && !prev.matches('ul, ol, table, pre') && prev.textContent.trim().length <= 340 && CLOSE.test(prev.textContent.trim())) { last.remove(); prev.remove(); }
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
const ABBR = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|p\.sh|etj|nr|fig|vol|no|approx|zt|znj|ing|av|kap|fq)|\b[A-Z]|\d)\.$/i;

export function sentences(text) {
  const parts = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…؟]["”’»)\]]?)\s+(?=["“«'(\[]?[\p{Lu}\p{Lo}\d])/u);
  const out = [];
  for (const p of parts) {
    if (out.length && ABBR.test(out[out.length - 1])) out[out.length - 1] += ' ' + p;
    else if (p) out.push(p);
  }
  return out;
}

/** Strips any legacy auto-generated Key points box without altering or adding prose */
export function readable(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  for (const o of [...tpl.content.querySelectorAll('blockquote.kp')]) {
    const nx = o.nextElementSibling;
    o.remove();
    if (nx && nx.tagName === 'HR') nx.remove();
  }
  return tpl.innerHTML;
}
