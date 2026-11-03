const fs = require('fs');

// Fix docview.js - simplify drag-to-pan guard
let dv = fs.readFileSync('public/js/docview.js', 'utf8');

// Replace the onMouseDown function
const oldMouseDown = `  const onMouseDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target.closest('.dv-hl-pop, .dv-hl, button')) return;

    const isText = !!e.target.closest('.textLayer span');
    const allowDrag = spaceDown || e.button === 1 || (z > 1.05 && (!isText || e.altKey));

    if (allowDrag) {
      isDragging = true;
      dragStart = {
        x: e.clientX,
        y: e.clientY,
        sl: wrap.scrollLeft,
        st: wrap.scrollTop,
        moved: false
      };
      wrap.classList.add('is-panning');
      if (spaceDown || e.button === 1 || e.altKey) e.preventDefault();
    }
  };`;

const newMouseDown = `  const onMouseDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target.closest('.dv-hl-pop, .dv-hl, button')) return;

    const allowDrag = spaceDown || e.button === 1 || z > 1.05;

    if (allowDrag) {
      e.preventDefault();
      isDragging = true;
      dragStart = {
        x: e.clientX,
        y: e.clientY,
        sl: wrap.scrollLeft,
        st: wrap.scrollTop,
        moved: false
      };
      wrap.classList.add('is-panning');
    }
  };`;

// Normalize line endings for matching
const oldNorm = oldMouseDown.replace(/\r\n/g, '\n');
const dvNorm = dv.replace(/\r\n/g, '\n');

if (!dvNorm.includes(oldNorm)) {
  console.error('ERROR: Could not find onMouseDown block in docview.js');
  process.exit(1);
}

dv = dvNorm.replace(oldNorm, newMouseDown.replace(/\r\n/g, '\n'));

// Write back with original CRLF
fs.writeFileSync('public/js/docview.js', dv.replace(/\n/g, '\r\n'), 'utf8');
console.log('docview.js: onMouseDown fixed');

// Fix app.css - add user-select:none to is-zoomed, remove duplicate .dv-page
let css = fs.readFileSync('public/css/app.css', 'utf8').replace(/\r\n/g, '\n');

// Update .dv-scroll.is-zoomed to also disable user-select
css = css.replace(
  '.dv-scroll.is-zoomed { cursor: grab; }',
  '.dv-scroll.is-zoomed { cursor: grab; user-select: none; }'
);

// Remove the second .dv-page definition at the bottom that conflicts (adds user-select: text)
const secondDvPage = `.dv-page {
  position: relative;
  flex: none;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .15), 0 6px 20px rgba(0, 0, 0, .08);
  touch-action: pan-x pan-y;
  user-select: text;
}`;

if (css.includes(secondDvPage)) {
  // Replace with version that respects zoomed parent
  css = css.replace(secondDvPage, `.dv-page {
  position: relative;
  flex: none;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .15), 0 6px 20px rgba(0, 0, 0, .08);
  touch-action: pan-x pan-y;
}`);
  console.log('app.css: removed user-select:text from .dv-page');
} else {
  console.log('app.css: second .dv-page block not found (may already be fixed)');
}

fs.writeFileSync('public/css/app.css', css.replace(/\n/g, '\r\n'), 'utf8');
console.log('app.css: is-zoomed updated');

console.log('Done!');
