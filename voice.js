// ════════════════════════════════════════════
// VOICE — reads questions and the examiner's lines aloud, in every mode.
//
// Natural voice: Kokoro-82M (voice-worker.js), run in the browser. The model
// (~90 MB) is downloaded once and kept by the browser; every clip it makes is
// stored in IndexedDB, so a question heard again (10 homework attempts, a
// retried test) plays at once without being generated again.
// Device voice: the browser's own speechSynthesis, used when the student
// chooses it, while the natural voice is still downloading, or if it fails.
//
//   Voice.say(text)        → Promise, resolved when the clip has finished
//   Voice.prefetch(texts)  → generate upcoming lines in the background
//   Voice.stop()           → silence now (e.g. when recording starts)
//   Voice.unlock()         → call inside a tap: lets iOS play audio later
//   Voice.warm()           → start downloading the natural voice
// ════════════════════════════════════════════
(function () {
  const PREF_KEY = 'speak_voice', READY_KEY = 'speak_voice_ready';
  const VOICES = {
    'kokoro:bf_emma':    'Natural voice — British female (Emma)',
    'kokoro:bm_george':  'Natural voice — British male (George)',
    'kokoro:af_heart':   'Natural voice — American female (Heart)',
    'kokoro:am_michael': 'Natural voice — American male (Michael)',
    'device':            'Device voice (no download)',
    'off':               'Off — show the text only'
  };
  const DEFAULT = (navigator.connection && navigator.connection.saveData) ? 'device' : 'kokoro:bf_emma';
  const CLIP_LIMIT = 400;          // clips kept on the device (oldest go first)
  const GEN_TIMEOUT = 25000;       // longest wait for one clip before the device voice takes over

  const ls = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };

  const V = {
    VOICES,
    state: 'idle',                 // idle | loading | ready | failed
    progress: 0, sizeMb: 0, error: '',
    listeners: [],
    pref() { const p = ls.get(PREF_KEY); return VOICES[p] ? p : DEFAULT; },
    setPref(p) { if (VOICES[p]) { ls.set(PREF_KEY, p); this.stop(); this.emit(); if (p.startsWith('kokoro:')) this.warm(); } },
    mode() { const p = this.pref(); return p.startsWith('kokoro:') ? 'kokoro' : p; },
    kokoroVoice() { return this.pref().split(':')[1] || 'bf_emma'; },
    downloadedBefore() { return ls.get(READY_KEY) === '1'; },
    supported() { return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined'; },
    onChange(fn) { this.listeners.push(fn); },
    emit() { this.listeners.forEach(f => { try { f(this); } catch (e) {} }); },
    statusText() {
      if (this.mode() === 'off') return 'Questions are shown, not read aloud.';
      if (this.mode() === 'device') return "Uses this device's built-in voice — nothing to download.";
      if (!this.supported()) return 'This browser cannot run the natural voice — the device voice is used.';
      if (this.state === 'ready') return 'Natural voice ready ✓ (saved on this device)';
      if (this.state === 'loading') return 'Downloading the natural voice… ' + this.progress + '%' + (this.sizeMb ? ' of ' + this.sizeMb + ' MB' : '') + ' — the device voice is used until it is ready.';
      if (this.state === 'failed') return 'The natural voice could not load on this device (' + this.error + ') — the device voice is used.';
      return this.downloadedBefore() ? 'Natural voice saved on this device — loads in a few seconds.'
        : 'About 90 MB is downloaded the first time (Wi-Fi recommended), then it is kept on this device.';
    }
  };

  // ── the worker ──
  let worker = null, seq = 0;
  const waiting = {};              // id → { resolve, reject }
  function startWorker() {
    if (worker || !V.supported()) return worker;
    try { worker = new Worker('voice-worker.js', { type: 'module' }); }
    catch (e) { fail(e); return null; }
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'progress') { V.progress = m.pct; V.sizeMb = m.mb || V.sizeMb; V.emit(); }
      else if (m.type === 'ready') { V.state = 'ready'; V.progress = 100; ls.set(READY_KEY, '1'); V.emit(); }
      else if (m.type === 'audio') { const w = waiting[m.id]; delete waiting[m.id]; if (w) w.resolve(wavBlob(m.pcm, m.rate)); }
      else if (m.type === 'error') {
        const w = waiting[m.id]; delete waiting[m.id];
        if (w) w.reject(new Error(m.error)); else fail(new Error(m.error));
      }
    };
    worker.onerror = e => { fail(new Error(e.message || 'the voice worker stopped')); };
    return worker;
  }
  function fail(e) {
    V.state = 'failed'; V.error = String((e && e.message) || e).slice(0, 120);
    Object.keys(waiting).forEach(id => { waiting[id].reject(e); delete waiting[id]; });
    try { worker && worker.terminate(); } catch (_) {}
    worker = null; V.emit();
  }
  V.warm = function () {
    if (this.mode() !== 'kokoro' || this.state === 'loading' || this.state === 'ready' || !startWorker()) return;
    this.state = 'loading'; this.error = ''; this.emit();
    worker.postMessage({ type: 'load' });
  };
  const pendingId = new Map();     // clip key → worker job id, while it is queued
  function generate(text, voice, key) {
    if (!startWorker()) return Promise.reject(new Error('no worker'));
    if (V.state === 'idle' || V.state === 'failed') V.warm();
    const id = ++seq;
    pendingId.set(key, id);
    return new Promise((resolve, reject) => { waiting[id] = { resolve, reject }; worker.postMessage({ type: 'speak', id, text, voice, speed: 0.95 }); })
      .finally(() => { if (pendingId.get(key) === id) pendingId.delete(key); });
  }
  function bump(key) { const id = pendingId.get(key); if (id && worker) worker.postMessage({ type: 'bump', id }); }

  // 24 kHz float PCM → 16-bit mono WAV
  function wavBlob(pcm, rate) {
    const dv = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return new Blob([dv], { type: 'audio/wav' });
  }

  // ── clip cache: memory, then IndexedDB ──
  const mem = new Map();           // key → Promise<Blob>
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res) => {
      try {
        const r = indexedDB.open('speak-voice', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('clips');
        r.onsuccess = () => res(r.result); r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  async function idbGet(key) {
    const d = await db(); if (!d) return null;
    return new Promise(res => { try { const q = d.transaction('clips').objectStore('clips').get(key); q.onsuccess = () => res(q.result ? q.result.blob : null); q.onerror = () => res(null); } catch (e) { res(null); } });
  }
  async function idbPut(key, blob) {
    const d = await db(); if (!d) return;
    try {
      const st = d.transaction('clips', 'readwrite').objectStore('clips');
      st.put({ blob, t: Date.now() }, key);
      const c = st.count();
      c.onsuccess = () => { if (c.result > CLIP_LIMIT) pruneOldest(c.result - CLIP_LIMIT); };
    } catch (e) {}
  }
  async function pruneOldest(n) {
    const d = await db(); if (!d) return;
    try {
      const st = d.transaction('clips', 'readwrite').objectStore('clips'), all = [];
      st.openCursor().onsuccess = e => {
        const cur = e.target.result;
        if (cur) { all.push([cur.value.t, cur.key]); cur.continue(); }
        else all.sort((a, b) => a[0] - b[0]).slice(0, n).forEach(([, k]) => st.delete(k));
      };
    } catch (e) {}
  }
  function clean(text) { return String(text || '').replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim(); }
  function clip(text) {
    const voice = V.kokoroVoice(), key = voice + '|' + text;
    if (!mem.has(key)) {
      const p = (async () => {
        const hit = await idbGet(key);
        if (hit) return hit;
        const blob = await generate(text, voice, key);
        idbPut(key, blob);
        return blob;
      })();
      p.catch(() => mem.delete(key));
      mem.set(key, p);
    }
    return mem.get(key);
  }
  async function cached(text) { return !!(mem.has(V.kokoroVoice() + '|' + text) || await idbGet(V.kokoroVoice() + '|' + text)); }

  V.prefetch = function (texts) {
    if (this.mode() !== 'kokoro' || this.state === 'failed') return;
    this.warm();
    (texts || []).map(clean).filter(Boolean).forEach(t => { clip(t).catch(() => {}); });
  };

  // ── playback ──
  const audio = typeof Audio !== 'undefined' ? new Audio() : null;
  let current = null;              // { done } of what is playing now
  V.unlock = function () {
    try {
      if (audio && !audio._unlocked) {
        audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
        const p = audio.play(); if (p && p.catch) p.catch(() => {});
        audio._unlocked = true;
      }
      if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
    } catch (e) {}
  };
  V.stop = function () {
    turn++;
    try { if (audio) audio.pause(); } catch (e) {}
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) {}
    if (current) { const c = current; current = null; c.done(); }
  };
  function playBlob(blob) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob);
      let fin = false, guard = null;
      const done = () => { if (fin) return; fin = true; clearTimeout(guard); URL.revokeObjectURL(url); if (current && current.done === done) current = null; resolve(); };
      current = { done };
      audio.onended = done; audio.onerror = done;
      audio.onloadedmetadata = () => { clearTimeout(guard); guard = setTimeout(done, (audio.duration || 10) * 1000 + 2500); };
      guard = setTimeout(done, 30000);
      audio.src = url;
      const p = audio.play(); if (p && p.catch) p.catch(done);
    });
  }

  // Device voice, sentence by sentence (Chrome cuts long utterances off); each
  // sentence has its own time limit in case the end event never comes.
  let deviceVoice = null;
  function pickDeviceVoice() {
    const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
    const pref = ['Google UK English Female', 'Google UK English Male', 'Serena', 'Daniel', 'Kate', 'Libby', 'Sonia', 'Martha', 'Arthur'];
    deviceVoice = pref.map(n => vs.find(v => v.name.indexOf(n) >= 0)).find(Boolean)
      || vs.find(v => /^en[-_]GB/i.test(v.lang)) || vs.find(v => /^en[-_]US/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
  }
  if (window.speechSynthesis) { try { speechSynthesis.addEventListener('voiceschanged', pickDeviceVoice); } catch (e) {} pickDeviceVoice(); }
  function sayDevice(text) {
    return new Promise(resolve => {
      const synth = window.speechSynthesis;
      const parts = text.match(/[^.!?]+[.!?]*/g) || [text];
      if (!synth) { setTimeout(resolve, 800 + text.split(/\s+/).length * 380); return; }
      if (!deviceVoice) pickDeviceVoice();
      let i = 0, guard = null, stopped = false;
      const fin = () => { clearTimeout(guard); if (current && current.done === stop) current = null; resolve(); };
      const stop = () => { stopped = true; fin(); };
      current = { done: stop };
      const next = () => {
        clearTimeout(guard);
        if (stopped) return;
        if (i >= parts.length) { fin(); return; }
        const s = parts[i++].trim();
        if (!s) { next(); return; }
        const u = new SpeechSynthesisUtterance(s);
        if (deviceVoice) u.voice = deviceVoice;
        u.lang = (deviceVoice && deviceVoice.lang) || 'en-GB';
        u.rate = 0.95;
        let fired = false;
        const go = () => { if (!fired) { fired = true; next(); } };
        u.onend = go; u.onerror = go;
        guard = setTimeout(() => { try { synth.cancel(); } catch (e) {} go(); }, 2500 + s.split(/\s+/).length * 550);
        synth.speak(u);
      };
      try { synth.cancel(); } catch (e) {}
      next();
    });
  }

  // Only the latest say() speaks: one started while an earlier one was still
  // waiting for its clip makes that earlier one return silently.
  let turn = 0;
  V.say = async function (text) {
    text = clean(text);
    this.stop();
    const my = ++turn;
    if (!text || this.mode() === 'off') return;
    if (this.mode() === 'kokoro' && this.supported() && this.state !== 'failed') {
      // Not downloaded yet and nothing cached: speak now with the device
      // voice rather than keep the student waiting.
      if (this.state !== 'ready' && !(await cached(text))) { this.warm(); return my === turn ? sayDevice(text) : undefined; }
      try {
        const p = clip(text);
        bump(V.kokoroVoice() + '|' + text);
        const blob = await Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('slow')), GEN_TIMEOUT))]);
        if (my !== turn) return;
        return await playBlob(blob);
      } catch (e) { console.warn('[voice]', e); return my === turn ? sayDevice(text) : undefined; }
    }
    return sayDevice(text);
  };

  // ── the settings card (Practice page) ──
  V.settingsHtml = function () {
    return `<div class="key-wrap" id="voice-card">
      <div class="key-title"><span class="key-ic">🔊</span>Question voice <small style="font-weight:400;color:var(--g600)">(reads questions aloud in every mode)</small></div>
      <div class="key-row" style="flex-wrap:wrap">
        <select class="form-input" id="voice-sel" style="flex:1;min-width:220px" onchange="Voice.setPref(this.value)">
          ${Object.keys(VOICES).map(k => `<option value="${k}" ${k === this.pref() ? 'selected' : ''}>${VOICES[k]}</option>`).join('')}
        </select>
        <button class="btn btn-outline btn-sm" onclick="Voice.unlock();Voice.say('Hello! Now, I would like to ask you some questions about yourself.')">▶ Test</button>
      </div>
      <div style="font-size:11px;color:var(--g600);margin-top:6px" id="voice-status">${this.statusText()}</div>
    </div>`;
  };
  V.onChange(() => { const el = document.getElementById('voice-status'); if (el) el.textContent = V.statusText(); });

  window.Voice = V;
})();
