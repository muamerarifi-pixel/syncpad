import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarkdown,
  parseInline,
  escapeHtml,
  sanitizeUrl,
  getWordStats,
  extractExcerpt,
  extractFirstTitle
} from '../public/js/markdown.js';

test('escapeHtml prevents HTML injection', () => {
  const dangerous = '<script>alert("xss")</script>&"\'';
  const escaped = escapeHtml(dangerous);
  assert.equal(escaped, '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&amp;&quot;&#39;');
});

test('sanitizeUrl permits safe URLs and blocks malicious protocols', () => {
  assert.equal(sanitizeUrl('https://example.com'), 'https://example.com');
  assert.equal(sanitizeUrl('http://example.com/page?id=1'), 'http://example.com/page?id=1');
  assert.equal(sanitizeUrl('mailto:test@example.com'), 'mailto:test@example.com');
  assert.equal(sanitizeUrl('#anchor'), '#anchor');
  assert.equal(sanitizeUrl('/relative/path'), '/relative/path');
  
  // Malicious protocols blocked
  assert.equal(sanitizeUrl('javascript:alert(1)'), '#unsafe-url');
  assert.equal(sanitizeUrl('data:text/html,<script>alert(1)</script>'), '#unsafe-url');
  assert.equal(sanitizeUrl('vbscript:msgbox(1)'), '#unsafe-url');
});

test('parseMarkdown formats headings with IDs', () => {
  const md = '# Hello World\n## Secondary Title\n### Level 3';
  const html = parseMarkdown(md);
  assert.ok(html.includes('<h1 id="hello-world">Hello World</h1>'));
  assert.ok(html.includes('<h2 id="secondary-title">Secondary Title</h2>'));
  assert.ok(html.includes('<h3 id="level-3">Level 3</h3>'));
});

test('parseMarkdown handles bold, italic, strikethrough, and highlight', () => {
  const md = '**bold** *italic* ~~struck~~ ==highlight==';
  const html = parseMarkdown(md);
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>italic</em>'));
  assert.ok(html.includes('<del>struck</del>'));
  assert.ok(html.includes('<mark>highlight</mark>'));
});

test('parseMarkdown handles code blocks and escapes inner code', () => {
  const md = '```javascript\nconst a = "<test>&";\n```';
  const html = parseMarkdown(md);
  assert.ok(html.includes('class="language-javascript"'));
  assert.ok(html.includes('&lt;test&gt;&amp;'));
  assert.ok(html.includes('copy-code-btn'));
});

test('parseMarkdown handles inline code without formatting inside', () => {
  const md = 'Here is `**not bold**` code.';
  const html = parseMarkdown(md);
  assert.ok(html.includes('<code>**not bold**</code>'));
});

test('parseMarkdown handles task lists with checked and unchecked states', () => {
  const md = '- [ ] Buy groceries\n- [x] Write code';
  const html = parseMarkdown(md);
  assert.ok(html.includes('<ul class="task-list">'));
  assert.ok(html.includes('<input type="checkbox" disabled  /> <span>Buy groceries</span>'));
  assert.ok(html.includes('<input type="checkbox" disabled checked /> <span>Write code</span>'));
});

test('parseMarkdown handles tables correctly', () => {
  const md = '| Name | Role |\n| --- | --- |\n| Alice | Dev |\n| Bob | Ops |';
  const html = parseMarkdown(md);
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>Name</th>'));
  assert.ok(html.includes('<th>Role</th>'));
  assert.ok(html.includes('<td>Alice</td>'));
  assert.ok(html.includes('<td>Dev</td>'));
});

test('parseMarkdown handles blockquotes', () => {
  const md = '> Quote line 1\n> Quote line 2';
  const html = parseMarkdown(md);
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('Quote line 1'));
});

test('getWordStats accurately computes metrics', () => {
  const emptyStats = getWordStats('');
  assert.equal(emptyStats.words, 0);
  assert.equal(emptyStats.chars, 0);
  assert.equal(emptyStats.lines, 0);

  const sample = 'The quick brown fox jumps over the lazy dog.\nSecond line with five words.';
  const stats = getWordStats(sample);
  assert.equal(stats.words, 14);
  assert.equal(stats.lines, 2);
  assert.equal(stats.readingTimeMinutes, 1);
});

test('extractExcerpt removes markdown syntax cleanly', () => {
  const md = '# Title\n\n**Bold statement** and `code` with [link](https://example.com)';
  const excerpt = extractExcerpt(md, 50);
  assert.ok(!excerpt.includes('#'));
  assert.ok(!excerpt.includes('**'));
  assert.ok(!excerpt.includes('`'));
  assert.ok(excerpt.includes('Bold statement and code'));
});

test('extractFirstTitle finds first heading or non-empty line', () => {
  assert.equal(extractFirstTitle('# My Project\nContent'), 'My Project');
  assert.equal(extractFirstTitle('### Heading 3\nContent'), 'Heading 3');
  assert.equal(extractFirstTitle('Plain text first line\nSecond line'), 'Plain text first line');
  assert.equal(extractFirstTitle(''), 'Untitled Note');
  assert.equal(extractFirstTitle(null), 'Untitled Note');
  assert.equal(extractFirstTitle(undefined), 'Untitled Note');
});

test('parseMarkdown handles empty and boundary inputs safely', () => {
  assert.equal(parseMarkdown(''), '');
  assert.equal(parseMarkdown(null), '');
  assert.equal(parseMarkdown(undefined), '');
  assert.equal(parseMarkdown('   \n\n   '), '');
  // Unclosed markdown
  assert.ok(parseMarkdown('**unclosed bold').includes('unclosed bold'));
  assert.ok(parseMarkdown('`unclosed code').includes('unclosed code'));
});

test('getWordStats handles edge cases including unicode and extra whitespace', () => {
  assert.equal(getWordStats(null).words, 0);
  assert.equal(getWordStats(undefined).words, 0);
  const multiSpace = '   WordOne    WordTwo   WordThree   ';
  assert.equal(getWordStats(multiSpace).words, 3);
  const unicode = 'Hëllö wörld 🚀 测试';
  assert.equal(getWordStats(unicode).words, 4);
});

test('parseInline preserves URLs containing underscores and queries without tag corruption', () => {
  const md = '[Cloudflare Docs](https://developers.cloudflare.com/workers/runtime-apis/web_socket_pair?tab=overview_1)';
  const html = parseInline(md);
  assert.ok(html.includes('href="https://developers.cloudflare.com/workers/runtime-apis/web_socket_pair?tab=overview_1"'));
  assert.ok(!html.includes('<em>socket</em>'));
  assert.ok(!html.includes('<em>1</em>'));
});

test('parseInline preserves image URLs containing underscores', () => {
  const md = '![Diagram](https://example.com/assets/arch_diagram_v1.png)';
  const html = parseInline(md);
  assert.ok(html.includes('src="https://example.com/assets/arch_diagram_v1.png"'));
  assert.ok(!html.includes('<em>diagram</em>'));
});

test('parseInline does not italicize intraword underscores', () => {
  const md = 'The variable my_user_profile_id is integer.';
  const html = parseInline(md);
  assert.ok(html.includes('my_user_profile_id'));
  assert.ok(!html.includes('<em>user</em>'));
});

test('parseMarkdown cleanly separates task list from regular unordered list', () => {
  const md = '- [x] Task completed\n- Regular bullet item';
  const html = parseMarkdown(md);
  assert.ok(html.includes('<ul class="task-list">'));
  assert.ok(html.includes('</ul>\n<ul>'));
});

test('parseMarkdown handles malformed tables without separator as regular paragraphs', () => {
  const md = '| Just some pipe text | without separator |\nRegular line';
  const html = parseMarkdown(md);
  assert.ok(!html.includes('<table>'));
  assert.ok(html.includes('<p>| Just some pipe text | without separator |</p>'));
});

test('extractExcerpt removes HTML tags and image markdown', () => {
  const md = '# Header\n<div class="note">Notice <b>here</b></div>\n![Screenshot](https://example.com/img.png)';
  const excerpt = extractExcerpt(md, 100);
  assert.ok(!excerpt.includes('<div'));
  assert.ok(!excerpt.includes('<b>'));
  assert.ok(!excerpt.includes('https://'));
  assert.ok(excerpt.includes('Notice here Screenshot'));
});

test('sanitizeImageUrl allows safe web images and base64 image data URLs, blocks XSS', async () => {
  const { sanitizeImageUrl } = await import('../public/js/markdown.js');
  
  assert.strictEqual(sanitizeImageUrl('https://example.com/photo.jpg'), 'https://example.com/photo.jpg');
  assert.strictEqual(sanitizeImageUrl('/assets/icon.png'), '/assets/icon.png');
  assert.strictEqual(sanitizeImageUrl('data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA'), 'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA');
  assert.strictEqual(sanitizeImageUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
  
  // Malicious URLs must be neutralized
  assert.strictEqual(sanitizeImageUrl('javascript:alert(1)'), '#unsafe-image-url');
  assert.strictEqual(sanitizeImageUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='), '#unsafe-image-url');
});

test('parseInline renders image data URL with figure, zoomable attribute, and caption', () => {
  const md = '![Diagram Caption](data:image/webp;base64,UklGRg==)';
  const html = parseInline(md);
  assert.ok(html.includes('<figure class="image-figure">'));
  assert.ok(html.includes('src="data:image/webp;base64,UklGRg=="'));
  assert.ok(html.includes('alt="Diagram Caption"'));
  assert.ok(html.includes('data-zoomable="true"'));
  assert.ok(html.includes('<figcaption class="image-caption">Diagram Caption</figcaption>'));
});


