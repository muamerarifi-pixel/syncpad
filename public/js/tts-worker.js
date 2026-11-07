// Kokoro voice, run fully inside this worker so the app never freezes.
// The model (~90 MB) downloads once from Hugging Face and is then kept by the browser.
import { KokoroTTS } from '/vendor/kokoro.web.js';

let tts = null;
let loading = null;

async function hasGpu() {
  try { return !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter()); } catch { return false; }
}

function load() {
  if (tts) return Promise.resolve(tts);
  if (!loading) {
    const seen = new Map();
    loading = hasGpu().then((gpu) => KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      // the graphics chip is ~10x faster; without one, the small model on the processor
      dtype: gpu ? 'fp32' : 'q8',
      device: gpu ? 'webgpu' : 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          seen.set(p.file, [p.loaded, p.total]);
          let a = 0, b = 0;
          for (const [l, t] of seen.values()) { a += l; b += t; }
          postMessage({ type: 'progress', pct: Math.round((a / b) * 100) });
        }
      },
    }).then(async (t) => {
      postMessage({ type: 'warming', gpu });
      try { await t.generate('Hi.', { voice: 'af_heart' }); } catch {}   // first run compiles; do it before the real text
      tts = t; postMessage({ type: 'ready', gpu }); return t;
    }))
      .catch((e) => { loading = null; throw e; });
  }
  return loading;
}

onmessage = async (e) => {
  const { id, type, text, voice, speed } = e.data;
  try {
    if (type === 'load') { await load(); return; }
    if (type === 'say') {
      const t = await load();
      const audio = await t.generate(text, { voice: voice || 'af_heart', speed: speed || 1 });
      const pcm = audio.audio;
      postMessage({ type: 'audio', id, pcm, rate: audio.sampling_rate }, [pcm.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id, message: String((err && err.message) || err) });
  }
};
