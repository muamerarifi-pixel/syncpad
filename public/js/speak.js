// Read text aloud: Kokoro (natural voice, needs internet the first time) with the device voice as fallback.
const VOICES = [
  ['af_heart', 'Heart (US, female)'], ['af_bella', 'Bella (US, female)'], ['am_michael', 'Michael (US, male)'],
  ['bf_emma', 'Emma (UK, female)'], ['bm_george', 'George (UK, male)'], ['device', 'Device voice (offline)'],
];
const SPEEDS = [0.8, 1, 1.2, 1.4, 1.7];
// phones default to the device voice (the natural one is a big download and slow there); pick a natural voice to use it anyway
const DEF_VOICE = typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches ? 'device' : 'af_heart';
const ls = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lset = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

let worker = null, ctx = null, bar = null;
let job = 0, nextId = 0;
const waiting = new Map();
const state = { playing: false, paused: false, chunks: [], at: 0, src: null, ready: false, pct: 0, mode: 'kokoro' };

function getWorker() {
  if (worker) return worker;
  worker = new Worker('/js/tts-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { state.pct = m.pct; if (m.pct < 100) status(`Downloading the natural voice… ${m.pct}% (only the first time)`); }
    else if (m.type === 'warming') status('Starting the natural voice…');
    else if (m.type === 'ready') { state.ready = true; state.gpu = m.gpu; if (state.playing) status('Preparing audio…'); }
    else if (waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.type === 'error' ? w.reject(new Error(m.message)) : w.resolve(m); }
  };
  worker.onerror = () => { for (const w of waiting.values()) w.reject(new Error('voice failed')); waiting.clear(); };
  return worker;
}
function synth(text) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, type: 'say', text, voice: ls('sp-tts-voice', DEF_VOICE), speed: Number(ls('sp-tts-speed', '1')) });
  });
}

/** Sentences, joined up to ~220 characters, so the first sound starts quickly. */
function chunk(text) {
  const parts = String(text).replace(/\s+/g, ' ').trim().match(/[^.!?;:\n]+[.!?;:]*\s*/g) || [];
  const out = [];
  let cur = '';
  for (const p of parts) {
    const max = out.length ? 220 : 90;
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
    if (p.length > 260) { for (const w of p.match(/.{1,240}(\s|$)/g) || [p]) out.push(w.trim()); continue; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
}

function ensureBar() {
  if (bar) return bar;
  bar = document.createElement('div');
  bar.className = 'tts-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <button class="tts-btn tts-play" aria-label="Pause"><svg class="ic" viewBox="0 0 24 24"><path class="p-pause" d="M8 5v14M16 5v14"/><path class="p-play" d="M8 5v14l11-7z"/></svg></button>
    <div class="tts-mid"><div class="tts-title">Reading aloud</div><div class="tts-status"></div></div>
    <select class="tts-voice" aria-label="Voice">${VOICES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select>
    <button class="tts-btn tts-speed" aria-label="Speed">1×</button>
    <button class="tts-btn tts-stop" aria-label="Stop"><svg class="ic" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>`;
  document.body.append(bar);
  const v = bar.querySelector('.tts-voice');
  v.value = ls('sp-tts-voice', DEF_VOICE);
  v.onchange = () => { lset('sp-tts-voice', v.value); restartFromCurrent(); };
  const sp = bar.querySelector('.tts-speed');
  const showSpeed = () => { sp.textContent = `${Number(ls('sp-tts-speed', '1'))}×`; };
  showSpeed();
  sp.onclick = () => { const s = Number(ls('sp-tts-speed', '1')); lset('sp-tts-speed', String(SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])); showSpeed(); restartFromCurrent(); };
  bar.querySelector('.tts-stop').onclick = stop;
  bar.querySelector('.tts-play').onclick = togglePause;
  return bar;
}
function status(t) { if (bar) bar.querySelector('.tts-status').textContent = t; }
function setPlayingUi() { if (!bar) return; bar.classList.toggle('paused', state.paused); bar.querySelector('.tts-play').setAttribute('aria-label', state.paused ? 'Play' : 'Pause'); }

export function speak(text) {
  const chunks = chunk(text);
  if (!chunks.length) return false;
  stop();
  ensureBar().hidden = false;
  bar.querySelector('.tts-title').textContent = chunks[0].length > 60 ? chunks[0].slice(0, 58) + '…' : chunks[0];
  state.chunks = chunks; state.at = 0; state.playing = true; state.paused = false;
  setPlayingUi();
  run(++job);
  return true;
}
function useDevice() { return ls('sp-tts-voice', DEF_VOICE) === 'device' || !navigator.onLine && !state.ready || !('Worker' in window); }
/** wait for a piece of audio; if the natural voice is far too slow here, say so and use the device voice */
function within(promise, my) {
  return new Promise((resolve, reject) => {
    let waited = 0;
    const iv = setInterval(() => {
      if (my !== job) { clearInterval(iv); return; }
      if (!state.ready) return;                 // still downloading: no limit
      waited += 1;
      if (waited === 2) status('Preparing audio…');
      if (waited >= 30) { clearInterval(iv); reject(new Error('slow')); }
    }, 1000);
    promise.then((v) => { clearInterval(iv); resolve(v); }, (e) => { clearInterval(iv); reject(e); });
  });
}

async function run(my) {
  if (useDevice()) return runDevice(my);
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  status(state.ready ? 'Preparing audio…' : state.pct && state.pct < 100 ? `Downloading the natural voice… ${state.pct}%` : 'Starting the natural voice…');
  let next = synth(state.chunks[state.at]);
  while (my === job && state.at < state.chunks.length) {
    let m;
    try { m = await within(next, my); } catch (e) {
      if (my !== job) return;
      status(e && e.message === 'slow' ? 'The natural voice is too slow on this device — using the device voice.' : 'Natural voice unavailable — using the device voice.');
      return runDevice(my);
    }
    if (my !== job) return;
    status(state.gpu === false ? 'Natural voice (slower on this device)' : '');
    next = state.at + 1 < state.chunks.length ? synth(state.chunks[state.at + 1]) : null;
    await playPcm(m.pcm, m.rate, my);
    if (my !== job) return;
    state.at++;
    if (!next) break;
  }
  if (my === job) finish();
}
function playPcm(pcm, rate, my) {
  return new Promise((resolve) => {
    const buf = ctx.createBuffer(1, pcm.length, rate);
    buf.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination);
    src.onended = () => { if (state.src === src) state.src = null; resolve(); };
    state.src = src;
    src.start();
    const watch = setInterval(() => { if (my !== job) { clearInterval(watch); resolve(); } else if (!state.src) clearInterval(watch); }, 200);
  });
}
function runDevice(my) {
  if (!('speechSynthesis' in window)) { status('This device has no voice.'); return; }
  speechSynthesis.cancel();
  const speakAt = () => {
    if (my !== job) return;
    if (state.at >= state.chunks.length) return finish();
    const u = new SpeechSynthesisUtterance(state.chunks[state.at]);
    u.rate = Number(ls('sp-tts-speed', '1'));
    u.onend = () => { if (my === job && !state.paused) { state.at++; speakAt(); } };
    speechSynthesis.speak(u);
  };
  speakAt();
}
function togglePause() {
  if (!state.playing) return;
  state.paused = !state.paused;
  if (ctx) state.paused ? ctx.suspend() : ctx.resume();
  if ('speechSynthesis' in window) state.paused ? speechSynthesis.pause() : speechSynthesis.resume();
  setPlayingUi();
}
function restartFromCurrent() {
  if (!state.playing) return;
  const at = state.at;
  halt();
  state.at = at; state.playing = true; state.paused = false;
  if (ctx && ctx.state === 'suspended') ctx.resume();
  setPlayingUi();
  run(++job);
}
function halt() {
  job++;
  if (state.src) { try { state.src.onended = null; state.src.stop(); } catch {} state.src = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (ctx && ctx.state === 'suspended') ctx.resume();
}
function finish() { state.playing = false; if (bar) bar.hidden = true; }
export function stop() { halt(); finish(); state.chunks = []; }
export function isSpeaking() { return state.playing; }
/** Start downloading the voice early (when the user is online). */
export function warmUp() { if (navigator.onLine && ls('sp-tts-voice', DEF_VOICE) !== 'device') getWorker().postMessage({ type: 'load' }); }
