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
  const PICK_KEY = 'speak_voice_pick';       // a voice the student chose on this device
  const BAD_KEY = 'speak_voice_bad';         // voices that failed here: { name: time }
  const BAD_DAYS = 3;
  const START_MS = 3000;                      // a line that has not started by then failed
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // How natural an English voice sounds, best first. Neural voices (Edge's
  // "Online (Natural)", Chrome's Google voices, Apple's Premium/Enhanced)
  // sound human; macOS novelty and old formant voices sound robotic.
  const ROBOT = /\b(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy|Grandma|Grandpa|Eddy|Flo|Reed|Rocko|Sandy|Shelley|eSpeak)\b/i;
  function quality(v) {
    const n = v.name;
    let q = 0;
    if (/Natural|Neural/i.test(n)) q = 100;
    else if (/^Google/i.test(n)) q = 90;
    else if (/Premium/i.test(n)) q = 85;
    else if (/Enhanced/i.test(n)) q = 80;
    else if (/^Microsoft/i.test(n)) q = 45;
    else if (/^(Daniel|Serena|Kate|Martha|Arthur|Oliver|Stephanie|Samantha|Karen|Moira|Tessa|Rishi|Veena|Ava|Allison|Susan|Tom|Evan|Nathan|Joelle|Zoe|Nicky|Aaron)\b/.test(n)) q = 50;
    else q = 30;
    if (ROBOT.test(n)) q = -100;
    if (/^en[-_]GB/i.test(v.lang)) q += 6; else if (/^en[-_]US/i.test(v.lang)) q += 3;
    if (/Sonia|UK English Female/i.test(n)) q += 3;                       // clear British examiner voices
    else if (/Libby|Maisie|Ryan|Thomas/i.test(n)) q += 2;
    return q;
  }

  // Voices to try, best first: the student's choice, then by quality, the
  // browser's default (null) after every decent voice. A voice that errors
  // or stays silent is skipped (for a few days), so one broken voice — an
  // online voice without network, a voice listed but not installed — cannot
  // silence the test.
  const failed = new Set();
  const nameOf = v => v ? v.name : 'browser default';
  const bad = () => { try { return JSON.parse(ls.get(BAD_KEY) || '{}'); } catch (e) { return {}; } };
  const isBad = n => { const t = bad()[n]; return !!t && Date.now() - t < BAD_DAYS * 86400000; };
  function markBad(n, on) { const b = bad(); if (on) b[n] = Date.now(); else delete b[n]; ls.set(BAD_KEY, JSON.stringify(b)); }
  function englishVoices() {
    return ((window.speechSynthesis && speechSynthesis.getVoices()) || []).filter(v => /^en/i.test(v.lang))
      .map(v => ({ v, q: quality(v) })).sort((a, b) => b.q - a.q);
  }
  function candidates(auto) {
    const ranked = englishVoices();
    const pick = !auto && ranked.find(x => x.v.name === ls.get(PICK_KEY));
    const good = ranked.filter(x => x.q > 0 && !isBad(x.v.name)).map(x => x.v);
    const list = [pick ? pick.v : undefined].concat(good, [null], ranked.filter(x => x.q > 0).map(x => x.v));
    const seen = new Set(), out = [];
    list.forEach(v => { if (v === undefined) return; const n = nameOf(v); if (!seen.has(n) && !failed.has(n)) { seen.add(n); out.push(v); } });
    return out;
  }
  // For a voice menu: the decent English voices here, best first.
  V.voiceList = () => englishVoices().filter(x => x.q > 0).map(x => ({ name: x.v.name, lang: x.v.lang, natural: x.q >= 80 }));
  V.picked = () => ls.get(PICK_KEY) || '';
  V.pick = name => { ls.set(PICK_KEY, name || ''); if (name) { failed.delete(name); markBad(name, false); } };
  V.current = () => nameOf(candidates(true)[0]);     // what "Automatic" plays
  // What happened, for the "Listen" check: voices seen, tries and results.
  V.diag = { voices: 0, tries: [] };
  function note(v, result) {
    V.diag.voices = ((window.speechSynthesis && speechSynthesis.getVoices()) || []).length;
    V.diag.tries.push(nameOf(v) + (v ? ' (' + v.lang + (v.localService ? '' : ', online') + ')' : '') + ': ' + result);
    if (V.diag.tries.length > 8) V.diag.tries.shift();
  }
  // Voices load late in Chrome/Edge; tell a voice menu when they arrive.
  if (window.speechSynthesis) { try { speechSynthesis.addEventListener('voiceschanged', () => { if (V.onVoices) V.onVoices(); }); speechSynthesis.getVoices(); } catch (e) {} }

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
          if (v) markBad(v.name, true);
          try { synth.cancel(); } catch (e) {}
          timers.push(setTimeout(() => speakPart(s, tries + 1), 150));
        };
        u.onstart = () => {
          started = true;
          if (!V.heard) note(v, 'playing');
          V.heard = true;
          if (v && isBad(v.name)) markBad(v.name, false);
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
