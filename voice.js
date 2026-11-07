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

  // Best English voice on this device, British first.
  let deviceVoice = null;
  function pickDeviceVoice() {
    const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
    const pref = ['Google UK English Female', 'Google UK English Male', 'Serena', 'Daniel', 'Kate', 'Libby', 'Sonia', 'Martha', 'Arthur'];
    deviceVoice = pref.map(n => vs.find(v => v.name.indexOf(n) >= 0)).find(Boolean)
      || vs.find(v => /^en[-_]GB/i.test(v.lang)) || vs.find(v => /^en[-_]US/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
  }
  if (window.speechSynthesis) { try { speechSynthesis.addEventListener('voiceschanged', pickDeviceVoice); } catch (e) {} pickDeviceVoice(); }

  let current = null;              // { done } of the line being read
  let turn = 0;                    // only the latest say() speaks
  const keep = new Set();          // utterances kept alive (Chrome drops events of collected ones)
  const busy = s => s && (s.speaking || s.pending);

  V.unlock = function () {
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
        let fired = false, started = false;
        const go = () => { if (!fired) { fired = true; keep.delete(u); next(); } };
        u.onstart = () => { started = true; V.heard = true; };
        u.onend = go; u.onerror = go;
        guard = setTimeout(() => { try { synth.cancel(); } catch (e) {} go(); }, 2500 + s.split(/\s+/).length * 550);
        // Never started after 3 s: tell the caller once (muted tab, no voice…).
        setTimeout(() => { if (!started && !fired && !V.heard && V.onSilent) { const f = V.onSilent; V.onSilent = null; f(); } }, 3000);
        keep.add(u);
        try { synth.resume(); } catch (e) {}     // Chrome can sit "paused" after a tab switch
        synth.speak(u);
      };
      // Safari and some Chrome builds drop a speak() issued straight after
      // cancel(): clear the queue only if something is in it, then wait a beat.
      let wasBusy = false;
      try { wasBusy = busy(synth); if (wasBusy) synth.cancel(); } catch (e) {}
      setTimeout(next, wasBusy ? 120 : 0);
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
