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
  const PREF_KEY = 'speak_voice';
  const VOICES = {
    device: 'Device voice',
    off:    'Off — show the text only'
  };
  const ls = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };

  const V = {
    VOICES,
    // An older choice of a downloadable voice falls back to the device voice.
    pref() { const p = ls.get(PREF_KEY); return VOICES[p] ? p : 'device'; },
    setPref(p) { if (VOICES[p]) { ls.set(PREF_KEY, p); this.stop(); } },
    mode() { return this.pref(); },
    statusText() {
      return this.mode() === 'off' ? 'The examiner\'s lines are shown, not read aloud.'
        : window.speechSynthesis ? 'Uses this device\'s built-in English voice.' : 'This browser cannot read aloud — the text is shown.';
    }
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

  V.unlock = function () {
    try { if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch (e) {}
  };
  V.stop = function () {
    turn++;
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) {}
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

  // While a line is being read, <html> carries .voice-on (speaking-head icons animate).
  let speakingN = 0;
  function speaking(d) { speakingN = Math.max(0, speakingN + d); document.documentElement.classList.toggle('voice-on', speakingN > 0); }

  V.say = function (text) {
    text = String(text || '').replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
    this.stop();
    const my = ++turn;
    if (!text || this.mode() === 'off') return Promise.resolve();
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

  // The settings card (Practice page).
  V.settingsHtml = function () {
    return `<div class="key-wrap" id="voice-card">
      <div class="key-title"><span class="key-ic">${this.icon(18)}</span>Examiner voice <small style="font-weight:400;color:var(--g600)">(Test Simulation)</small></div>
      <div class="key-row" style="flex-wrap:wrap">
        <select class="form-input" id="voice-sel" style="flex:1;min-width:200px" onchange="Voice.setPref(this.value);document.getElementById('voice-status').textContent=Voice.statusText()">
          ${Object.keys(VOICES).map(k => `<option value="${k}" ${k === this.pref() ? 'selected' : ''}>${VOICES[k]}</option>`).join('')}
        </select>
        <button class="btn btn-outline btn-sm" onclick="Voice.unlock();Voice.say('Hello! Now, I would like to ask you some questions about yourself.')">▶ Listen</button>
      </div>
      <div style="font-size:11px;color:var(--g600);margin-top:6px" id="voice-status">${this.statusText()}</div>
    </div>`;
  };

  window.Voice = V;
  document.querySelectorAll('[data-vo-ic]').forEach(el => { el.innerHTML = V.icon(+el.dataset.voIc || 18); });
})();
