// Kokoro-82M text-to-speech in a worker, so generating a clip never freezes
// the page. The model (~90 MB, q8) is downloaded from Hugging Face the first
// time and cached by the browser; later sessions load it from that cache.
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let loading = null;

function load() {
  if (!loading) {
    const files = {};
    loading = KokoroTTS.from_pretrained(MODEL, {
      dtype: 'q8', device: 'wasm',
      // One progress figure across every file the model needs.
      progress_callback: p => {
        if (p.status !== 'progress' || !p.total) return;
        files[p.file] = [p.loaded, p.total];
        let got = 0, all = 0;
        Object.values(files).forEach(([l, t]) => { got += l; all += t; });
        self.postMessage({ type: 'progress', pct: Math.round(got / all * 100), mb: Math.round(all / 1048576) });
      }
    }).then(tts => { self.postMessage({ type: 'ready' }); return tts; },
            err => { loading = null; throw err; });
  }
  return loading;
}

// One clip at a time (the model cannot run two at once), in the order asked,
// except that a clip the student is waiting for now jumps the queue.
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const m = queue.shift();
    try {
      const tts = await load();
      const out = await tts.generate(m.text, { voice: m.voice, speed: m.speed || 1 });
      const pcm = out.audio;
      self.postMessage({ type: 'audio', id: m.id, pcm, rate: out.sampling_rate }, [pcm.buffer]);
    } catch (e) {
      self.postMessage({ type: 'error', id: m.id, error: String((e && e.message) || e) });
    }
  }
  busy = false;
}

self.onmessage = ({ data: m }) => {
  if (m.type === 'load') {
    load().catch(e => self.postMessage({ type: 'error', error: String((e && e.message) || e) }));
  } else if (m.type === 'speak') {
    queue.push(m); pump();
  } else if (m.type === 'bump') {
    const i = queue.findIndex(j => j.id === m.id);
    if (i > 0) queue.unshift(queue.splice(i, 1)[0]);
  }
};
