// ════════════════════════════════════════════
// VOICE — the examiner's lines and questions in Test Simulation, read with
// the device's own voice (speechSynthesis): nothing to download, starts at
// once. Also used for the "▶ Model" word in the pronunciation feedback.
//
//   Voice.say(text)  → Promise, resolved when the line has been read
//   Voice.stop()     → silence now (e.g. when recording starts)
//   Voice.unlock()   → call inside a tap: lets iOS speak later
// ════════════════════════════════════════════
(function () {
  // Always the device voice; there is no setting. A browser without speech
  // (mode 'off') shows the text for about the time it takes to read it.
  const V = {
    mode() { return window.speechSynthesis ? 'device' : 'off'; },
    // Whether any line has actually started playing on this device.
    heard: false,
    // Set by the caller: called once if a line was sent but never started.
    onSilent: null
  };

  const ls = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  const OK_KEY = 'speak_voice_ok';           // the voice that last played on this device
  const START_MS = 3000;                      // a line that has not started by then failed
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // Voices to try, best first: the one that worked here before, preferred
  // British voices, the browser's default (null), then any local English
  // voice. A voice that errors or stays silent is skipped for the rest of
  // the visit, so one broken voice (an online voice without network, a
  // macOS voice that is listed but not installed…) cannot silence the test.
  const failed = new Set();
  const nameOf = v => v ? v.name : 'browser default';
  function candidates() {
    const vs = ((window.speechSynthesis && speechSynthesis.getVoices()) || []).filter(v => /^en/i.test(v.lang));
    const pref = ['Google UK English Female', 'Google UK English Male', 'Serena', 'Daniel', 'Kate', 'Libby', 'Sonia', 'Martha', 'Arthur'];
    const okName = ls.get(OK_KEY);
    const saved = okName === nameOf(null) ? null : vs.find(v => v.name === okName);
    const gb = v => /^en[-_]GB/i.test(v.lang);
    const local = vs.filter(v => v.localService);
    const list = [saved].concat(pref.map(n => vs.find(v => v.name.indexOf(n) >= 0)), [null],
      local.filter(gb), local.filter(v => !gb(v)), vs.filter(gb), vs);
    const seen = new Set(), out = [];
    list.forEach(v => { if (v === undefined) return; const n = nameOf(v); if (!seen.has(n) && !failed.has(n)) { seen.add(n); out.push(v); } });
    return out;
  }
  // What happened, for the "Listen" check: voices seen, tries and results.
  V.diag = { voices: 0, tries: [] };
  function note(v, result) {
    V.diag.voices = ((window.speechSynthesis && speechSynthesis.getVoices()) || []).length;
    V.diag.tries.push(nameOf(v) + (v ? ' (' + v.lang + (v.localService ? '' : ', online') + ')' : '') + ': ' + result);
    if (V.diag.tries.length > 8) V.diag.tries.shift();
  }
  if (window.speechSynthesis) { try { speechSynthesis.addEventListener('voiceschanged', () => {}); speechSynthesis.getVoices(); } catch (e) {} }

  let current = null;              // { done } of the line being read
  let turn = 0;                    // only the latest say() speaks
  const keep = new Set();          // utterances kept alive (Chrome drops events of collected ones)
  const busy = s => s && (s.speaking || s.pending);

  // iOS only lets a page speak after speech has started inside a tap.
  V.unlock = function () {
    if (!isIOS) return;
    try { if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch (e) {}
  };
  V.stop = function () {
    turn++;
    try { busy(window.speechSynthesis) && speechSynthesis.cancel(); } catch (e) {}
    if (current) { const c = current; current = null; c.done(); }
  };

  // Sentence by sentence (Chrome cuts long utterances off); each sentence has
  // its own time limit in case the end event never comes.
  function sayDevice(text) {
    return new Promise(resolve => {
      const synth = window.speechSynthesis;
      const parts = text.match(/[^.!?]+[.!?]*/g) || [text];
      if (!synth) { setTimeout(resolve, 800 + text.split(/\s+/).length * 380); return; }
      let i = 0, timers = [], stopped = false;
      const clear = () => { timers.forEach(clearTimeout); timers = []; };
      const fin = () => { clear(); if (current && current.done === stop) current = null; resolve(); };
      const stop = () => { stopped = true; fin(); };
      current = { done: stop };
      const next = () => {
        clear();
        if (stopped) return;
        if (i >= parts.length) { fin(); return; }
        const s = parts[i++].trim();
        if (!s) { next(); return; }
        speakPart(s, 0);
      };
      const speakPart = (s, tries) => {
        clear();
        if (stopped) return;
        const v = candidates()[0];
        if (v === undefined || tries >= 4) {          // nothing left to try: the text stays on screen
          if (!V.heard && V.onSilent) { const f = V.onSilent; V.onSilent = null; f(); }
          next(); return;
        }
        let u;
        try {
          u = new SpeechSynthesisUtterance(s);
          if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-GB';
          u.rate = 0.95;
        } catch (e) { failed.add(nameOf(v)); note(v, 'unusable'); speakPart(s, tries + 1); return; }
        let done = false, started = false;
        const end = () => { if (!done) { done = true; keep.delete(u); next(); } };
        const fail = why => {
          if (done) return;
          done = true; keep.delete(u); clear();
          failed.add(nameOf(v)); note(v, why);
          if (ls.get(OK_KEY) === nameOf(v)) ls.set(OK_KEY, '');
          try { synth.cancel(); } catch (e) {}
          timers.push(setTimeout(() => speakPart(s, tries + 1), 150));
        };
        u.onstart = () => {
          started = true;
          if (!V.heard) note(v, 'playing');
          V.heard = true;
          if (ls.get(OK_KEY) !== nameOf(v)) ls.set(OK_KEY, nameOf(v));
          clear();
          timers.push(setTimeout(() => { try { synth.cancel(); } catch (e) {} end(); }, 2500 + s.split(/\s+/).length * 550));
        };
        u.onend = () => end();
        u.onerror = e => {
          const code = (e && e.error) || 'error';
          if (code === 'interrupted' || code === 'canceled' || stopped) end();   // our own cancel()
          else fail(code);
        };
        timers.push(setTimeout(() => { if (!started) fail('did not start'); }, START_MS));
        keep.add(u);
        try { synth.resume(); } catch (e) {}     // Chrome can sit "paused" after a tab switch
        try { synth.speak(u); } catch (e) { fail('refused'); }
      };
      // Safari and some Chrome builds drop a speak() issued straight after
      // cancel(): clear the queue only if something is in it, then wait a beat.
      let wasBusy = false;
      try { wasBusy = busy(synth); if (wasBusy) synth.cancel(); } catch (e) {}
      timers.push(setTimeout(next, wasBusy ? 150 : 0));
    });
  }

  // While a line is being read, <html> carries .voice-on (speaking-head icons animate).
  let speakingN = 0;
  function speaking(d) { speakingN = Math.max(0, speakingN + d); document.documentElement.classList.toggle('voice-on', speakingN > 0); }

  V.say = function (text) {
    text = String(text || '').replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
    this.stop();
    const my = ++turn;
    if (!text) return Promise.resolve();
    if (this.mode() === 'off') return new Promise(r => setTimeout(r, 800 + text.split(/\s+/).length * 380));
    speaking(1);
    return (my === turn ? sayDevice(text) : Promise.resolve()).finally(() => speaking(-1));
  };

  // Speaking-head icon: the head in the deep accent, sound waves in the accent.
  V.icon = function (size) {
    const z = size || 18;
    return `<svg class="vo-ic" width="${Math.round(z * 26 / 24)}" height="${z}" viewBox="0 0 26 24" aria-hidden="true">
      <path fill="var(--blue-d)" transform="translate(.6 1.6) scale(.84)" d="M4.6 21v-4.6C3 15.1 2.2 13.2 2.2 11.1 2.2 6.6 5.6 3.2 9.9 3.2c3.5 0 6 2.3 6.4 5.5l1.5 2.7c.25.45-.05.95-.55.95h-.95v1.7c0 1-.8 1.75-1.75 1.75h-1.9V21z"/>
      <g fill="none" stroke="var(--blue)" stroke-width="1.9" stroke-linecap="round">
        <path class="w w1" d="M17.43 9.7a3 3 0 0 1 0 4.6"/>
        <path class="w w2" d="M19.23 7.53a5.8 5.8 0 0 1 0 8.94"/>
        <path class="w w3" d="M21.03 5.38a8.6 8.6 0 0 1 0 13.24"/>
      </g></svg>`;
  };

  window.Voice = V;
  document.querySelectorAll('[data-vo-ic]').forEach(el => { el.innerHTML = V.icon(+el.dataset.voIc || 18); });
})();
