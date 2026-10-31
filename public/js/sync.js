// Sync engine: WebSocket for instant pokes + presence, the same sync call over HTTP as fallback.
import { rid, sleep } from './util.js';

export class Sync extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.ws = null;
    this.state = 'connecting'; // connecting | online | offline
    this.wsOpen = false;
    this.backoff = 1000;
    this.running = false;
    this.again = false;
    this.waiters = new Map();
    this.devices = [];
    this.onlineCount = 0;
    this.info = null; // usage, cap, maxFile, chunk
    this.stopped = true;
    this.lastOk = 0;
    this.schedule = this.schedule.bind(this);
  }

  get space() { return this.store.get('space'); }
  get device() { return this.store.get('device'); }
  get name() { return this.store.get('deviceName'); }
  get token() { return this.store.get('token') || this.space; }

  /** Credentials sent with every request: space token + this device's id and private secret */
  headers(extra = {}) {
    return { 'x-k': this.token, 'x-d': this.device, 'x-ds': this.store.get('secret') || '', ...extra };
  }

  async setToken(token) {
    if (!token || token === this.token) return;
    await this.store.set('token', token);
    this.emit('token');
    if (this.ws) { try { this.ws.close(); } catch {} }
  }

  start() {
    this.stopped = false;
    if (!this.listening) {
      this.listening = true;
      addEventListener('online', () => {
        this.backoff = 1000;
        if (this.wsOpen) this.setState('online');
        this.connect();
        this.schedule();
      });
      addEventListener('offline', () => this.setState('offline'));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { this.checkAlive(3000); this.connect(); this.schedule(); }
      });
      // Safety net when WebSockets are blocked (some proxies / captive networks)
      setInterval(() => {
        if (!this.stopped && !this.wsOpen && navigator.onLine && document.visibilityState === 'visible') this.syncNow();
      }, 15000);
      setInterval(() => this.checkAlive(10000), 30000);
    }
    this.connect();
    this.syncNow();
  }

  /** A socket can look open after sleep / network changes but be dead: ping it, reconnect if no answer */
  checkAlive(wait) {
    const ws = this.ws;
    if (!this.wsOpen || !ws) return;
    const sent = Date.now();
    try { ws.send('ping'); } catch { return this.reconnect(); }
    setTimeout(() => { if (this.ws === ws && this.wsOpen && (this.lastPong || 0) < sent) this.reconnect(); }, wait);
  }

  /** Drop the current socket (without the usual close handling) and open a fresh one */
  reconnect() {
    const old = this.ws;
    if (old) {
      old.onopen = old.onmessage = old.onclose = null;
      try { old.close(); } catch {}
    }
    this.ws = null;
    this.wsOpen = false;
    for (const w of this.waiters.values()) w.reject(new Error('closed')); // in-flight calls fall back to HTTP
    this.waiters.clear();
    this.backoff = 1000;
    clearTimeout(this.reconnectTimer);
    this.connect();
  }

  /** The refresh button: fresh connection + a full sync round now. Resolves true when synced. */
  async refresh() {
    if (this.stopped || this.denied || !this.space) return false;
    const done = new Promise((res) => {
      const on = () => { clearTimeout(t); res(true); };
      const t = setTimeout(() => { this.removeEventListener('synced', on); res(false); }, 12000);
      this.addEventListener('synced', on, { once: true });
    });
    this.reconnect();
    await sleep(0);
    this.syncNow();
    return done;
  }

  stop() {
    this.stopped = true;
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.wsOpen = false;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state');
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  connect() {
    if (this.stopped || this.denied || !this.space || !navigator.onLine) {
      if (!navigator.onLine) this.setState('offline');
      return;
    }
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    clearTimeout(this.reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = new URLSearchParams({ d: this.device, n: this.name || '', k: this.token, ds: this.store.get('secret') || '' });
    let ws;
    try { ws = new WebSocket(`${proto}://${location.host}/api/s/${this.space}/ws?${qs}`); } catch { return this.retry(); }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.wsOpen = true;
      this.backoff = 1000;
      ws.send(JSON.stringify({ t: 'hi', name: this.name }));
      this.setState('online');
      this.syncNow();
    };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong') { this.lastPong = Date.now(); return; }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'poke') {
        if (m.seq > (this.store.get('seq') || 0)) this.schedule();
      } else if (m.t === 'presence') {
        this.devices = m.devices || [];
        this.onlineCount = m.online || 0;
        this.emit('presence');
      } else if (m.t === 'token') {
        this.setToken(m.token);
      } else if (m.t === 'revoked') {
        this.stop();
        this.emit('revoked');
      } else if (m.t === 'sync' && this.waiters.has(m.rid)) {
        this.waiters.get(m.rid).resolve(m);
        this.waiters.delete(m.rid);
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.wsOpen = false;
      for (const w of this.waiters.values()) w.reject(new Error('closed'));
      this.waiters.clear();
      this.onlineCount = 0;
      this.emit('presence');
      if (this.stopped) return;
      this.setState(navigator.onLine ? (Date.now() - this.lastOk < 60000 ? 'online' : 'connecting') : 'offline');
      if (!opened) this.syncNow(); // the HTTP call tells us if the link changed or access was removed
      this.retry();
    };
    ws.onerror = () => {};
  }

  retry() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  /** Coalesce bursts of local edits into one round trip */
  schedule() {
    clearTimeout(this.schedTimer);
    this.schedTimer = setTimeout(() => this.syncNow(), 120);
  }

  async syncNow() {
    if (this.stopped || this.denied || !this.space) return;
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.round();
      } while (this.again && !this.stopped);
    } catch (err) {
      if (!this.wsOpen) this.setState(navigator.onLine ? 'connecting' : 'offline');
      // retry soon if there is unsent work
      if (this.store.outbox.size) setTimeout(() => this.schedule(), 5000);
    } finally {
      this.running = false;
    }
  }

  async round() {
    for (let i = 0; i < 25; i++) {
      const sent = this.store.pendingOps(50);
      const ops = sent.map((e) => ({ ...e.op, baseRev: e.baseRev }));
      this.emit('busy', true);
      let res;
      try {
        res = await this.call({ since: this.store.get('seq') || 0, ops, device: this.device, name: this.name });
      } finally {
        this.emit('busy', false);
      }
      if (res.error) throw new Error(res.error);
      this.lastOk = Date.now();
      this.setState('online');
      const events = await this.store.handleAcks(sent, res.acks, this.device);
      await this.store.applyRemote(res.changes);
      await this.store.set('seq', res.seq);
      this.info = { usage: res.usage, total: res.total, cap: res.cap, maxFile: res.maxFile, chunk: res.chunk };
      this.emit('info');
      for (const ev of events) this.emit(ev.type, ev);
      if (!res.more && sent.length < 50) break;
    }
    this.emit('synced');
  }

  async call(body, retried = false) {
    if (this.wsOpen && this.ws) {
      const id = rid(10);
      const p = new Promise((resolve, reject) => {
        this.waiters.set(id, { resolve, reject });
        setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); reject(new Error('timeout')); } }, 9000);
      });
      try {
        this.ws.send(JSON.stringify({ t: 'sync', rid: id, ...body }));
        return await p;
      } catch (e) {
        // fall through to HTTP
      }
    }
    const r = await fetch(`/api/s/${this.space}/sync`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body)
    });
    if (r.status === 409 && !retried) {
      const j = await r.json().catch(() => ({}));
      if (j.token) { await this.setToken(j.token); return this.call(body, true); }
    }
    if (r.status === 403) {
      const j = await r.json().catch(() => ({}));
      if (j.revoked) { this.stop(); this.emit('revoked'); }
      else { this.denied = true; this.setState('denied'); this.emit('denied'); }
      throw new Error('auth');
    }
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }

  /** Wait until the outbox is empty (used before leaving a space) */
  async flush(timeout = 8000) {
    const t0 = Date.now();
    while (this.store.outbox.size && Date.now() - t0 < timeout) {
      await this.syncNow();
      await sleep(300);
    }
  }
}
