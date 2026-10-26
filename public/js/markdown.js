/**
 * SyncPad Zero-Dependency Markdown Parser & Sanitizer
 * Fast, lightweight, secure, and distraction-free.
 */

// Escape HTML special characters
export function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Sanitize URL to prevent javascript: or data: XSS
export function sanitizeUrl(url) {
  if (!url) return '';
  const trimmed = url.trim();
  // Allow safe protocols or relative/anchor links
  if (/^(?:(?:https?|mailto|tel):|#|\/|\.\/|\.\.\/)/i.test(trimmed)) {
    return trimmed;
  }
  return '#unsafe-url';
}

/**
 * Parse Markdown to HTML
 * @param {string} markdown - Raw markdown string
 * @returns {string} Sanitized HTML
 */
export function parseMarkdown(markdown) {
  if (!markdown) return '';

  // Normalize line endings
  let text = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Extract code blocks first to protect them from inline parsing
  const codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_\-\+]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const placeholder = `@@CODEBLOCK${codeBlocks.length}@@`;
    codeBlocks.push({ lang: lang.trim().toLowerCase() || 'text', code });
    return placeholder;
  });

  // Extract inline code to protect from inline formatting
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (match, code) => {
    const placeholder = `@@INLINECODE${inlineCodes.length}@@`;
    inlineCodes.push(code);
    return placeholder;
  });

  // Split into lines for block-level parsing
  const lines = text.split('\n');
  const result = [];
  let inList = false;
  let listType = null; // 'ul' | 'ol'
  let inTable = false;
  let tableHeaders = [];
  let tableRows = [];
  let inBlockquote = false;
  let blockquoteLines = [];

  function closeList() {
    if (inList) {
      result.push(`</${listType}>`);
      inList = false;
      listType = null;
    }
  }

  function closeBlockquote() {
    if (inBlockquote) {
      const parsedContent = parseMarkdown(blockquoteLines.join('\n'));
      result.push(`<blockquote>${parsedContent}</blockquote>`);
      inBlockquote = false;
      blockquoteLines = [];
    }
  }

  function closeTable() {
    if (inTable) {
      let tableHtml = '<div class="table-container"><table>';
      if (tableHeaders.length > 0) {
        tableHtml += '<thead><tr>';
        for (const h of tableHeaders) {
          tableHtml += `<th>${parseInline(h)}</th>`;
        }
        tableHtml += '</tr></thead>';
      }
      if (tableRows.length > 0) {
        tableHtml += '<tbody>';
        for (const row of tableRows) {
          tableHtml += '<tr>';
          for (const cell of row) {
            tableHtml += `<td>${parseInline(cell)}</td>`;
          }
          tableHtml += '</tr>';
        }
        tableHtml += '</tbody>';
      }
      tableHtml += '</table></div>';
      result.push(tableHtml);
      inTable = false;
      tableHeaders = [];
      tableRows = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check code block placeholder
    const codeBlockMatch = line.match(/^@@CODEBLOCK(\d+)@@$/);
    if (codeBlockMatch) {
      closeList();
      closeBlockquote();
      closeTable();
      const idx = parseInt(codeBlockMatch[1], 10);
      const { lang, code } = codeBlocks[idx];
      const escapedCode = escapeHtml(code);
      const safeDataCode = escapeHtml(code);
      result.push(
        `<div class="code-block-wrapper">` +
          `<div class="code-block-header">` +
            `<span class="code-lang">${escapeHtml(lang)}</span>` +
            `<button class="copy-code-btn" type="button" data-code="${safeDataCode}" title="Copy code">` +
              `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>` +
              `<span>Copy</span>` +
            `</button>` +
          `</div>` +
          `<pre><code class="language-${escapeHtml(lang)}">${escapedCode}</code></pre>` +
        `</div>`
      );
      continue;
    }

    // Horizontal Rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      closeList();
      closeBlockquote();
      closeTable();
      result.push('<hr />');
      continue;
    }

    // Headings: # through ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      closeBlockquote();
      closeTable();
      const level = headingMatch[1].length;
      const content = headingMatch[2].trim();
      const slug = content.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
      result.push(`<h${level} id="${slug}">${parseInline(content)}</h${level}>`);
      continue;
    }

    // Blockquote: > line
    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      closeList();
      closeTable();
      inBlockquote = true;
      blockquoteLines.push(bqMatch[1]);
      continue;
    } else if (inBlockquote) {
      closeBlockquote();
    }

    // Table row detection: | Col 1 | Col 2 |
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|')) {
      closeList();
      closeBlockquote();
      const rawCells = trimmed.slice(1, -1).split('|').map(c => c.trim());
      
      // Check if separator row (| --- | --- |)
      const isSeparator = rawCells.every(c => /^:?-+:?$/.test(c));
      if (isSeparator) {
        // Just separator, continue
        continue;
      }

      if (!inTable) {
        inTable = true;
        tableHeaders = rawCells;
      } else {
        tableRows.push(rawCells);
      }
      continue;
    } else if (inTable) {
      closeTable();
    }

    // Task list: - [ ] or - [x]
    const taskMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      closeBlockquote();
      closeTable();
      if (!inList || listType !== 'ul') {
        closeList();
        inList = true;
        listType = 'ul';
        result.push('<ul class="task-list">');
      }
      const checked = taskMatch[2].toLowerCase() === 'x';
      const content = taskMatch[3];
      result.push(
        `<li class="task-list-item">` +
          `<input type="checkbox" disabled ${checked ? 'checked' : ''} /> ` +
          `<span>${parseInline(content)}</span>` +
        `</li>`
      );
      continue;
    }

    // Unordered list: - item or * item
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      closeBlockquote();
      closeTable();
      if (!inList || listType !== 'ul') {
        closeList();
        inList = true;
        listType = 'ul';
        result.push('<ul>');
      }
      result.push(`<li>${parseInline(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list: 1. item
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      closeBlockquote();
      closeTable();
      if (!inList || listType !== 'ol') {
        closeList();
        inList = true;
        listType = 'ol';
        result.push('<ol>');
      }
      result.push(`<li>${parseInline(olMatch[2])}</li>`);
      continue;
    }

    // If we reach here, close open lists
    closeList();

    // Blank line
    if (!trimmed) {
      continue;
    }

    // Regular paragraph
    result.push(`<p>${parseInline(line)}</p>`);
  }

  closeList();
  closeBlockquote();
  closeTable();

  let html = result.join('\n');

  // Restore inline code
  html = html.replace(/@@INLINECODE(\d+)@@/g, (match, idx) => {
    const raw = inlineCodes[parseInt(idx, 10)];
    return `<code>${escapeHtml(raw)}</code>`;
  });

  return html;
}

/**
 * Parse inline Markdown elements
 * Bold, Italic, Strikethrough, Highlight, Links, Images
 */
export function parseInline(text) {
  if (!text) return '';

  // Escape HTML first
  let str = escapeHtml(text);

  // Images: ![alt](url)
  str = str.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    const safeUrl = sanitizeUrl(url);
    return `<img src="${safeUrl}" alt="${alt}" loading="lazy" />`;
  });

  // Links: [text](url)
  str = str.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
    const safeUrl = sanitizeUrl(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Bold + Italic: ***text*** or ___text___
  str = str.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  str = str.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');

  // Bold: **text** or __text__
  str = str.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  str = str.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  str = str.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  str = str.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Strikethrough: ~~text~~
  str = str.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Highlight: ==text==
  str = str.replace(/==([^=]+)==/g, '<mark>$1</mark>');

  return str;
}

/**
 * Calculate Word and Reading Stats
 * @param {string} text
 */
export function getWordStats(text) {
  if (!text || typeof text !== 'string') {
    return { words: 0, chars: 0, charsNoSpaces: 0, readingTimeMinutes: 0, lines: 0 };
  }

  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
  const chars = text.length;
  const charsNoSpaces = text.replace(/\s/g, '').length;
  const lines = text ? text.split('\n').length : 0;
  // Average reading speed: 200 words per minute
  const readingTimeMinutes = Math.max(1, Math.ceil(words / 200));

  return {
    words,
    chars,
    charsNoSpaces,
    readingTimeMinutes,
    lines
  };
}

/**
 * Extract clean plain-text excerpt for note card preview
 * @param {string} text
 * @param {number} maxLength
 */
export function extractExcerpt(text, maxLength = 100) {
  if (!text) return '';
  // Strip code blocks first
  let clean = text.replace(/```[\s\S]*?```/g, ' ');
  // Preserve content of inline code and links
  clean = clean.replace(/`([^`]+)`/g, '$1');
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Strip headers, formatting chars
  clean = clean
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~=#[\]()|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.length <= maxLength) return clean;
  return clean.slice(0, maxLength) + '…';
}

/**
 * Extract first title from markdown (or first line)
 * @param {string} text
 * @param {string} defaultTitle
 */
export function extractFirstTitle(text, defaultTitle = 'Untitled Note') {
  if (!text) return defaultTitle;
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      const match = trimmed.match(/^#+\s*(.+)$/);
      if (match && match[1]) return match[1].trim();
    } else if (trimmed) {
      // First non-empty line
      return trimmed.slice(0, 50).trim();
    }
  }
  return defaultTitle;
}
