import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');

test('1. Undo/Redo buttons in Notes and Canvas (markup, wiring, focus protection)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.ok(html.includes('id="btn-note-undo"'), 'btn-note-undo should be present in top editor bar');
  assert.ok(html.includes('id="btn-note-redo"'), 'btn-note-redo should be present in top editor bar');
  assert.ok(html.includes('data-fmt="undo"'), 'data-fmt="undo" should be present in formatting bar');
  assert.ok(html.includes('data-fmt="redo"'), 'data-fmt="redo" should be present in formatting bar');

  const mainJs = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
  assert.ok(mainJs.includes('doNoteUndo'), 'main.js should define doNoteUndo');
  assert.ok(mainJs.includes('doNoteRedo'), 'main.js should define doNoteRedo');
  assert.ok(mainJs.includes('syncNoteUndoRedo'), 'main.js should define syncNoteUndoRedo');
  
  // Verify mousedown preventDefault is applied to prevent focus theft and mobile keyboard dismissal
  assert.ok(mainJs.includes("btnNoteUndo.addEventListener('mousedown'"), 'btnNoteUndo must preventDefault on mousedown');
  assert.ok(mainJs.includes("btnNoteRedo.addEventListener('mousedown'"), 'btnNoteRedo must preventDefault on mousedown');
  assert.ok(mainJs.includes('ui.noteEdits'), 'ui.noteEdits should track editing sessions so undo stays accessible');
});

test('2. PDF viewer HD rendering and robust cancelation queue', () => {
  const docviewJs = fs.readFileSync(path.join(ROOT, 'public/js/docview.js'), 'utf8');
  assert.ok(docviewJs.includes('Math.min(3, Math.max(1, window.devicePixelRatio || 1))'), 'DPR cap should be at least 3 for HD');
  assert.ok(docviewJs.includes('p.pendingScale = s'), 'Pending scale should be tracked during in-flight renders');
  assert.ok(docviewJs.includes('p.renderTask.cancel()'), 'In-flight PDF render task should be cancelled on zoom to prevent blur/exceptions');
  assert.ok(docviewJs.includes('p.pendingScale != null || p.rendered !== p.scale'), 'Finally block must re-execute pending renders on cancellation');
  assert.ok(docviewJs.includes('Math.min(6, nz)'), 'Zoom ceiling should allow up to 600%');

  // Pinpoint zoom & pan verification
  assert.ok(docviewJs.includes('getAnchor'), 'docview.js must define getAnchor to calculate pinpoint zoom target');
  assert.ok(docviewJs.includes('fracX = Math.max(0, Math.min(1, (anchor.clientX - pr.left) / Math.max(1, pr.width)))'), 'Must calculate exact fractional position under cursor');
  assert.ok(docviewJs.includes('targetScrollLeft = newPageX + (fracX * newPageW) - anchor.localX'), 'Must align zoomed point directly under cursor x');
  assert.ok(docviewJs.includes('targetScrollTop = newPageY + (fracY * newPageH) - anchor.localY'), 'Must align zoomed point directly under cursor y');
  assert.ok(docviewJs.includes('isDragging'), 'docview.js must support mouse drag-to-pan');
  assert.ok(docviewJs.includes('touchPinch'), 'docview.js must support 2-finger pinch and pan');
  assert.ok(docviewJs.includes('wrap.scrollLeft -= dx'), 'docview.js must pan scrollLeft during gesture');
  assert.ok(docviewJs.includes('wrap.scrollTop -= dy'), 'docview.js must pan scrollTop during gesture');

  const css = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');
  assert.ok(css.includes('.dv-scroll.is-zoomed'), 'CSS must define grab cursor when zoomed in');
  assert.ok(css.includes('.dv-scroll.is-panning'), 'CSS must define grabbing cursor while panning');
  assert.ok(css.includes('.dv-pdf-pages'), 'CSS must define dv-pdf-pages to prevent negative flex centering data loss');
});

test('3. PDF text highlighting and PDF editing support', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.ok(html.includes('data-tool="highlight"'), 'Highlight tool button should exist in PDF editor toolbar');
  assert.ok(html.includes('data-color="#fde047"'), 'Yellow swatch should exist in PDF editor color bar');

  const docviewJs = fs.readFileSync(path.join(ROOT, 'public/js/docview.js'), 'utf8');
  assert.ok(docviewJs.includes('dv-hl-pop'), 'docview.js should support floating highlight popup on text selection');
  assert.ok(docviewJs.includes('dv-highlights'), 'docview.js should create dv-highlights layer');
  assert.ok(docviewJs.includes('firstRect.top < 65'), 'docview.js should prevent popup overflow near top of screen');

  const pdfeditJs = fs.readFileSync(path.join(ROOT, 'public/js/pdfedit.js'), 'utf8');
  assert.ok(pdfeditJs.includes("'highlight'"), "pdfedit.js should include highlight in SHAPES");
  assert.ok(pdfeditJs.includes('pe-hl'), "pdfedit.js should add pe-hl class for highlight rendering");
  assert.ok(pdfeditJs.includes('data-pe="highlight"'), "pdfedit.js line editor should have highlight button");

  const pdfcoreJs = fs.readFileSync(path.join(ROOT, 'public/js/pdfcore.js'), 'utf8');
  assert.ok(pdfcoreJs.includes("o.type === 'highlight'"), 'pdfcore.js addObjects should support highlight type');
  assert.ok(pdfcoreJs.includes('rgbOf'), 'pdfcore.js should define robust rgbOf parsing hex and array');
  assert.ok(pdfcoreJs.includes('opacity:'), 'pdfcore.js highlight should draw with semi-transparency');
});

test('4. Status bar and theme color alignment across all 9 paper textures', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.ok(html.includes('id="meta-theme-color"'), 'meta-theme-color should be identified');
  assert.ok(!html.includes('media="(prefers-color-scheme: dark)"'), 'Static prefers-color-scheme dark override should be removed');

  const themeJs = fs.readFileSync(path.join(ROOT, 'public/js/theme.js'), 'utf8');
  assert.ok(themeJs.includes('meta[name="theme-color"]'), 'theme.js should dynamically set theme-color before first paint');
  assert.ok(themeJs.includes('colorScheme'), 'theme.js should set root style.colorScheme');

  const css = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');
  assert.ok(css.includes('html {'), 'app.css should style html');
  assert.ok(css.includes('background: var(--bg);'), 'html must have background: var(--bg) for Android navigation bar');

  // Verify worker manifest endpoint
  const resLight = await fetch('http://127.0.0.1:8787/app.webmanifest');
  const mfLight = await resLight.json();
  assert.equal(mfLight.theme_color, '#ffffff');
  assert.equal(mfLight.background_color, '#f6f7f9');

  const resDark = await fetch('http://127.0.0.1:8787/app.webmanifest?theme=dark');
  const mfDark = await resDark.json();
  assert.equal(mfDark.theme_color, '#16181e');
  assert.equal(mfDark.background_color, '#0e1014');

  const resClassic = await fetch('http://127.0.0.1:8787/app.webmanifest?bg=classic');
  const mfClassic = await resClassic.json();
  assert.equal(mfClassic.theme_color, '#f2e8d0');
  assert.equal(mfClassic.background_color, '#f4ecd8');

  const resVintageDark = await fetch('http://127.0.0.1:8787/app.webmanifest?theme=dark&bg=vintage');
  const mfVintageDark = await resVintageDark.json();
  assert.equal(mfVintageDark.theme_color, '#2a2015');
  assert.equal(mfVintageDark.background_color, '#241c12');
});

test('5. Pinch to zoom in notes list: logical mode progression from compact to large', () => {
  const mainJs = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
  assert.ok(mainJs.includes('function setupNoteListPinch()'), 'setupNoteListPinch function should exist');
  
  // Verify ordered list: List Small -> List Medium -> List Large -> Grid Small -> Grid Medium -> Grid Large
  const listSmallIdx = mainJs.indexOf("view: 'list', size: 's'");
  const listMedIdx = mainJs.indexOf("view: 'list', size: 'm'");
  const listLrgIdx = mainJs.indexOf("view: 'list', size: 'l'");
  const gridSmallIdx = mainJs.indexOf("view: 'grid', size: 's'");
  const gridMedIdx = mainJs.indexOf("view: 'grid', size: 'm'");
  const gridLrgIdx = mainJs.indexOf("view: 'grid', size: 'l'");

  assert.ok(listSmallIdx < listMedIdx, 'List Small should come before List Medium');
  assert.ok(listMedIdx < listLrgIdx, 'List Medium should come before List Large');
  assert.ok(listLrgIdx < gridSmallIdx, 'List Large should transition into Grid Small on zoom in');
  assert.ok(gridSmallIdx < gridMedIdx, 'Grid Small should come before Grid Medium');
  assert.ok(gridMedIdx < gridLrgIdx, 'Grid Medium should come before Grid Large');

  assert.ok(mainJs.includes('notesPane') || mainJs.includes("closest('.notes-pane')"), 'Pinch handler should attach to notes-pane container');
});

test('6. Paper textures removed: the app background is always plain', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.ok(!html.includes('id="set-bg-grid"'), 'no paper texture picker in settings');
  const theme = fs.readFileSync(path.join(ROOT, 'public/js/theme.js'), 'utf8');
  assert.ok(theme.includes("removeItem('sp-bg')"), 'an old texture choice is cleared on start');
});
