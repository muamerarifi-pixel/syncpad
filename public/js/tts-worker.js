// Kokoro voice, run fully inside this worker so the app never freezes.
// The model (~90 MB) downloads once from Hugging Face and is then kept by the browser.
import { KokoroTTS } from '/vendor/kokoro.web.js';

let tts = null;
let loading = null;

function load() {
  if (tts) return Promise.resolve(tts);
  if (!loading) {
    const seen = new Map();
    loading = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          seen.set(p.file, [p.loaded, p.total]);
          let a = 0, b = 0;
          for (const [l, t] of seen.values()) { a += l; b += t; }
          postMessage({ type: 'progress', pct: Math.round((a / b) * 100) });
        }
      },
    }).then((t) => { tts = t; postMessage({ type: 'ready' }); return t; })
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
