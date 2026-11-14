// Arrange items by hand. Touch: press and hold an item (it gets selected), then — without lifting the
// finger — drag it where you want it. Mouse: drag an item (the app wires HTML5 drag & drop and uses
// `slot()` to find where it lands).
import { haptic } from './util.js';

/** Where a pointer at (x, y) would drop among `items` (in DOM order): { before, after } elements */
export function slot(items, x, y, skip) {
  const list = items.filter((e) => e !== skip);
  if (!list.length) return { before: null, after: null };
  const rects = list.map((e) => e.getBoundingClientRect());
  const multiCol = new Set(rects.map((r) => Math.round(r.left / 8))).size > 1;
  let best = 0;
  let bd = Infinity;
  rects.forEach((r, i) => {
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = multiCol ? Math.hypot(dx, dy) : dy * 4 + dx;
    if (d < bd) { bd = d; best = i; }
  });
  const r = rects[best];
  const afterIt = multiCol ? (y > r.bottom ? true : y < r.top ? false : x > r.left + r.width / 2) : y > r.top + r.height / 2;
  return afterIt ? { before: list[best], after: list[best + 1] || null, ref: list[best], side: 'after' }
    : { before: list[best - 1] || null, after: list[best], ref: list[best], side: 'before' };
}

/**
 * Touch press-hold-drag on a list.
 * opts: item (selector), scroller, canDrag(), onHold(id), onStart(id) → element|undefined, onDrop(id, prevId, nextId), blockClick()
 */
export function touchReorder(list, opts) {
  const sel = opts.item || '[data-id]';
  const HOLD = 430;
  let s = null;
  const scroller = () => (typeof opts.scroller === 'function' ? opts.scroller() : opts.scroller) || list;
  const items = () => [...list.querySelectorAll(sel)].filter((e) => e.offsetParent !== null);

  list.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !e.isPrimary) return;
    const el = e.target.closest(sel);
    if (!el || !list.contains(el)) return;
    if (opts.ignore && e.target.closest(opts.ignore)) return;
    clearTimeout(s && s.timer);
    s = { id: el.dataset.id, el, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, pid: e.pointerId, held: false, drag: false };
    const me = s;
    s.timer = setTimeout(() => {
      if (s !== me) return;
      s.held = true;
      s.x0 = s.x; s.y0 = s.y;
      haptic('heavy');
      if (opts.blockClick) opts.blockClick();
      if (opts.onHold) opts.onHold(s.id);
      // the list may have been redrawn
      s.el = list.querySelector(`${sel}[data-id="${CSS.escape(s.id)}"]`) || s.el;
      s.el.classList.add('rd-held');
    }, HOLD);
  });
  // while an item is held the page must not scroll under the finger. Touch events keep going to the element
  // the finger first touched even if the list is redrawn, so the listener goes on that element itself.
  const stopScroll = (e) => { if (s && (s.held || s.drag)) e.preventDefault(); };
  list.addEventListener('touchstart', (e) => {
    const t = e.target;
    if (!t || t._rdBound) return;
    t._rdBound = true;
    t.addEventListener('touchmove', stopScroll, { passive: false });
  }, { passive: true });
  list.addEventListener('contextmenu', (e) => { if (s && (s.held || s.drag)) { e.preventDefault(); e.stopPropagation(); } }, true);

  addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.pid) return;
    s.x = e.clientX; s.y = e.clientY;
    if (!s.held) {
      if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) > 9) { clearTimeout(s.timer); s = null; }
      return;
    }
    if (!s.drag) {
      if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) < 8) return;
      if (opts.canDrag && !opts.canDrag(s.id)) return;
      const fresh = opts.onStart && opts.onStart(s.id);
      s.el = fresh || list.querySelector(`${sel}[data-id="${CSS.escape(s.id)}"]`) || s.el;
      if (!s.el || !s.el.isConnected) { end(); return; }
      s.drag = true;
      const r = s.el.getBoundingClientRect();
      s.dx = s.x0 - r.left; s.dy = s.y0 - r.top;
      const g = s.el.cloneNode(true);
      g.classList.add('rd-ghost');
      g.classList.remove('rd-held');
      Object.assign(g.style, { width: r.width + 'px', height: r.height + 'px', left: '0px', top: '0px', position: 'fixed', margin: '0', zIndex: 300, pointerEvents: 'none' });
      document.body.append(g);
      s.ghost = g;
      s.el.classList.add('rd-place');
      document.documentElement.classList.add('rd-dragging');
      tick();
    }
    place();
  }, { passive: true });

  const place = () => {
    if (!s || !s.drag) return;
    s.ghost.style.transform = `translate(${s.x - s.dx}px, ${s.y - s.dy}px) rotate(1.2deg) scale(1.03)`;
    const at = slot(items(), s.x, s.y, s.el);
    if (!at.ref) return;
    if (at.side === 'before' && at.ref.previousElementSibling !== s.el) { at.ref.parentNode.insertBefore(s.el, at.ref); haptic('tick'); }
    else if (at.side === 'after' && at.ref.nextElementSibling !== s.el) { at.ref.parentNode.insertBefore(s.el, at.ref.nextSibling); haptic('tick'); }
  };
  // scroll when the finger is near the top or bottom edge
  const tick = () => {
    if (!s || !s.drag) return;
    const sc = scroller();
    const r = sc.getBoundingClientRect();
    const edge = 70;
    let v = 0;
    if (s.y < r.top + edge) v = -Math.ceil((r.top + edge - s.y) / 5);
    else if (s.y > r.bottom - edge) v = Math.ceil((s.y - (r.bottom - edge)) / 5);
    if (v) { sc.scrollTop += v; place(); }
    s.raf = requestAnimationFrame(tick);
  };
  const end = (e) => {
    if (!s || (e && e.pointerId !== s.pid)) return;
    clearTimeout(s.timer);
    const done = s;
    s = null;
    if (done.el) done.el.classList.remove('rd-held', 'rd-place');
    if (!done.drag) return;
    cancelAnimationFrame(done.raf);
    done.ghost.remove();
    document.documentElement.classList.remove('rd-dragging');
    if (opts.blockClick) opts.blockClick();
    const sib = (dir) => { let n = done.el[dir]; while (n && !(n.matches && n.matches(sel))) n = n[dir]; return n ? n.dataset.id : null; };
    opts.onDrop(done.id, sib('previousElementSibling'), sib('nextElementSibling'));
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  return { busy: () => !!(s && (s.held || s.drag)) };
}

/** A position key between two neighbours (bigger = higher in the list) */
export function between(above, below) {
  if (above == null && below == null) return Date.now();
  if (above == null) return below + 60_000;
  if (below == null) return above - 60_000;
  return (above + below) / 2;
}
