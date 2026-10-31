// Photo viewer with zoom: opens showing the whole photo (never blown up past its real size),
// then pinch / wheel / double-click (double-tap) to zoom and drag to move around.

export class ZoomView {
  constructor(stage, img, onChange = () => {}) {
    this.stage = stage;
    this.img = img;
    this.onChange = onChange;
    this.s = 1;
    this.x = 0;
    this.y = 0;
    this.pts = new Map();
    this.ready = false;
    this.lastTap = 0;
    this.lastTouch = 0;

    this.onResize = () => { if (!this.ready) return; const wasFit = this.atFit(); if (wasFit) this.fit(); else { this.clamp(); this.apply(); } };
    addEventListener('resize', this.onResize);
    stage.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    stage.addEventListener('pointerdown', (e) => this.down(e));
    stage.addEventListener('pointermove', (e) => this.move(e));
    stage.addEventListener('pointerup', (e) => this.up(e));
    stage.addEventListener('pointercancel', (e) => this.up(e));
    stage.addEventListener('dblclick', (e) => { if (Date.now() - this.lastTouch > 800) this.toggle(this.local(e)); });

    const start = () => {
      this.nw = img.naturalWidth;
      this.nh = img.naturalHeight;
      if (!this.nw || !this.nh) return;
      img.style.width = this.nw + 'px';
      img.style.height = this.nh + 'px';
      this.ready = true;
      this.fit();
      stage.classList.add('ready');
    };
    if (img.complete && img.naturalWidth) start();
    else img.addEventListener('load', start, { once: true });
  }

  destroy() { removeEventListener('resize', this.onResize); }

  get W() { return this.stage.clientWidth; }
  get H() { return this.stage.clientHeight; }
  /** the free area for the whole photo: a little margin, and room for the zoom bar at the bottom */
  area() {
    const side = this.W < 600 ? 8 : 16;
    return { x: side, y: 4, w: Math.max(1, this.W - side * 2), h: Math.max(1, this.H - 4 - 72) };
  }
  fitScale() { const a = this.area(); return Math.min(1, a.w / this.nw, a.h / this.nh); }
  maxScale() { return Math.max(4, this.fitScale() * 4); }
  atFit() { return Math.abs(this.s - this.fitScale()) < 0.002; }

  local(e) {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  apply(animate = false) {
    this.img.classList.toggle('anim', animate);
    this.img.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.s})`;
    this.stage.classList.toggle('zoomed', !this.atFit());
    this.onChange(this.atFit() ? 'Fit' : Math.round(this.s * 100) + '%');
  }

  clamp() {
    const sw = this.nw * this.s;
    const sh = this.nh * this.s;
    const a = this.area();
    // fits in the free area → centre it there; bigger → may use the whole screen, but no empty gaps
    this.x = sw <= a.w ? a.x + (a.w - sw) / 2 : Math.min(0, Math.max(this.W - sw, this.x));
    this.y = sh <= a.h ? a.y + (a.h - sh) / 2 : Math.min(0, Math.max(this.H - sh, this.y));
  }

  fit(animate = false) {
    if (!this.ready) return;
    this.s = this.fitScale();
    this.clamp();
    this.apply(animate);
  }

  zoomAt(p, ns, animate = false) {
    if (!this.ready) return;
    ns = Math.max(this.fitScale(), Math.min(this.maxScale(), ns));
    this.x = p.x - ((p.x - this.x) * ns) / this.s;
    this.y = p.y - ((p.y - this.y) * ns) / this.s;
    this.s = ns;
    this.clamp();
    this.apply(animate);
  }

  zoomBy(f) { this.zoomAt({ x: this.W / 2, y: this.H / 2 }, this.s * f, true); }

  /** fit ↔ a closer look (real size for big photos, 2.5× for small ones) */
  toggle(p = { x: this.W / 2, y: this.H / 2 }) {
    if (!this.ready) return;
    if (!this.atFit()) return this.fit(true);
    const f = this.fitScale();
    this.zoomAt(p, f < 0.8 ? 1 : f * 2.5, true);
  }

  wheel(e) {
    if (!this.ready) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const f = Math.exp((-e.deltaY * unit) * (e.ctrlKey ? 0.01 : 0.0025)); // ctrl = touchpad pinch
    this.zoomAt(this.local(e), this.s * f);
  }

  down(e) {
    if (!this.ready || e.button > 0) return;
    if (e.pointerType === 'touch') this.lastTouch = Date.now();
    try { this.stage.setPointerCapture(e.pointerId); } catch {}
    this.pts.set(e.pointerId, this.local(e));
    if (this.pts.size === 2) {
      const [a, b] = [...this.pts.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: this.s, cx: ((a.x + b.x) / 2 - this.x) / this.s, cy: ((a.y + b.y) / 2 - this.y) / this.s };
      this.drag = null;
    } else if (this.pts.size === 1) {
      const p = this.local(e);
      this.drag = { px: p.x, py: p.y, x: this.x, y: this.y, moved: false, t: Date.now() };
    }
  }

  move(e) {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.set(e.pointerId, this.local(e));
    if (this.pinch && this.pts.size >= 2) {
      const [a, b] = [...this.pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const ns = Math.max(this.fitScale() * 0.9, Math.min(this.maxScale(), (this.pinch.s * d) / this.pinch.d));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      this.s = ns;
      this.x = mx - this.pinch.cx * ns;
      this.y = my - this.pinch.cy * ns;
      this.clamp();
      this.apply();
      return;
    }
    const g = this.drag;
    if (!g) return;
    const p = this.local(e);
    if (Math.hypot(p.x - g.px, p.y - g.py) > 4) g.moved = true;
    if (this.atFit()) return;
    this.x = g.x + (p.x - g.px);
    this.y = g.y + (p.y - g.py);
    this.clamp();
    this.apply();
  }

  up(e) {
    if (!this.pts.has(e.pointerId)) return;
    const p = this.local(e);
    this.pts.delete(e.pointerId);
    if (this.pinch) {
      if (this.pts.size < 2) {
        this.pinch = null;
        if (this.s < this.fitScale()) this.fit(true);
        const rest = [...this.pts.values()][0];
        this.drag = rest ? { px: rest.x, py: rest.y, x: this.x, y: this.y, moved: true } : null;
      }
      return;
    }
    const g = this.drag;
    this.drag = null;
    if (e.pointerType === 'touch' && g && !g.moved) {
      const now = Date.now();
      if (now - this.lastTap < 320) { this.lastTap = 0; this.toggle(p); } // double tap
      else this.lastTap = now;
    }
  }
}
