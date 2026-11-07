// ════════════════════════════════════════════
// PRONUNCIATION CHECK — phone-level evidence for free speech.
//
// Each graded answer's recording is sent, with its Whisper transcript and word
// timings, to the pronunciation service (pronounce-space/, a Hugging Face
// Space). The service compares, word by word, the phones the dictionary
// expects (US and UK) with the phones actually heard, and counts recurring
// patterns (dropped final consonants, /θ/ said as /t/…).
//
// It runs in the background and never holds up the session: results appear
// in the feedback when they arrive, and are given to the grader as evidence
// for Pronunciation when they are ready in time. With no service configured
// (PRON_URL empty) nothing here runs at all.
//
//   Pron.start(rec, {blob, mime, text, words, vocab})  → begins a check, result lands on rec._pron
//   Pron.wait(recs, ms)        → resolves when those checks finish, or after ms
//   Pron.evidence(rec)         → one line for the grading prompt ('' if none)
//   Pron.slot(rec)             → placeholder HTML, filled when the result arrives
//   Pron.compact(rec)          → small summary to store with the attempt
// ════════════════════════════════════════════
(function () {
  // The Space URL, e.g. 'https://<user>-speaking-pronounce.hf.space'. A
  // per-browser override (localStorage 'speak_pron_url') is for testing.
  const PRON_URL = 'https://l2practice--speaking-pronounce-web.us-east.modal.run';
  const TIMEOUT = 180000;

  const ls = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let seq = 0;
  const live = {};                 // id → rec, while its slot may be on screen

  const P = {
    url() { return (ls('speak_pron_url') || PRON_URL || '').replace(/\/+$/, ''); },
    enabled() { return !!this.url(); },

    // A sleeping Space takes a minute or two to start: wake it when a graded
    // session begins, so it is up by the time the first answer arrives.
    wake() {
      if (!this.enabled() || this._woke) return;
      this._woke = true;
      fetch(this.url() + '/health', { mode: 'cors' }).catch(() => {});
    },

    start(rec, o) {
      if (!this.enabled() || !rec || !o || !o.blob || o.blob.size < 1500) return null;
      if (String(o.text || '').trim().split(/\s+/).length < 3) return null;
      rec._pronId = rec._pronId || ('pr' + (++seq));
      rec._pron = null; rec._pronErr = '';
      live[rec._pronId] = rec;
      const p = check(this.url(), o).then(r => { rec._pron = r; return r; },
        e => { rec._pronErr = String((e && e.message) || e); console.warn('[pron]', rec._pronErr); return null; });
      rec._pronP = p;
      p.then(() => { if (rec._pronP === p) fill(rec); });
      fill(rec);
      return p;
    },

    async wait(recs, ms) {
      const ps = (recs || []).map(r => r && r._pronP).filter(Boolean);
      if (!ps.length) return;
      await Promise.race([Promise.all(ps), new Promise(r => setTimeout(r, ms))]);
    },

    // One bracketed line per answer for the grader. It is evidence, not a
    // verdict: a lower bound from a phone recogniser, for Pronunciation only.
    evidence(rec) {
      const r = rec && rec._pron;
      if (!r || !r.phones_checked) return '';
      const bits = [];
      if (r.accuracy != null) bits.push(Math.round(r.accuracy * 100) + '% of ' + r.phones_checked + ' phones heard as expected');
      const pats = (r.patterns || []).filter(p => p.count >= 2).slice(0, 4)
        .map(p => p.label + ' ×' + p.count + ' (' + p.words.slice(0, 3).join(', ') + ')');
      if (pats.length) bits.push('recurring: ' + pats.join('; '));
      const words = (r.issues || []).filter(w => w.flagged).slice(0, 5).map(w => w.word + ' /' + w.expected + '/ heard /' + w.heard + '/');
      if (words.length) bits.push('mispronounced: ' + words.join(', '));
      return '\n[PRONUNCIATION EVIDENCE — phone recogniser on the audio, a lower bound; use it for Pronunciation only and judge intelligibility, not accent: ' + bits.join(' · ') + ']';
    },

    compact(rec) {
      const r = rec && rec._pron;
      if (!r) return null;
      return {
        accuracy: r.accuracy, phones: r.phones_checked, words: r.words_checked, flagged: r.flagged,
        patterns: (r.patterns || []).map(p => ({ key: p.key, label: p.label, vi: p.vi, count: p.count, words: p.words.slice(0, 4) })),
        issues: (r.issues || []).slice(0, 10).map(w => ({ word: w.word, expected: w.expected, heard: w.heard, flagged: w.flagged, patterns: w.patterns })),
        vocab: r.vocab || []
      };
    },

    slot(rec) {
      if (!rec || !rec._pronId) return '';
      return `<div class="pron-slot" data-pron-id="${rec._pronId}">${render(rec)}</div>`;
    }
  };

  async function check(url, o) {
    const form = new FormData();
    const ext = /mp4|aac|m4a/.test(o.mime || '') ? 'm4a' : /wav/.test(o.mime || '') ? 'wav' : 'webm';
    form.append('audio', o.blob, 'answer.' + ext);
    form.append('transcript', o.text || '');
    form.append('words', JSON.stringify((o.words || []).map(w => ({ word: w.word, start: w.start, end: w.end }))));
    form.append('vocab', JSON.stringify(o.vocab || []));
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), TIMEOUT);
      try {
        const res = await fetch(url + '/assess', { method: 'POST', body: form, signal: ctl.signal });
        if (res.ok) return await res.json();
        if (res.status === 503 || res.status === 502 || res.status === 504) {      // busy / waking up
          const wait = Math.min(120, parseFloat(res.headers.get('Retry-After')) || 30);
          await new Promise(r => setTimeout(r, wait * 1000));
          continue;
        }
        let msg = 'HTTP ' + res.status;
        try { msg = (await res.json()).detail || msg; } catch (e) {}
        const err = new Error(msg); err.final = res.status < 500;   // a request the service refuses will not succeed later
        throw err;
      } catch (e) {
        if (e.name === 'AbortError') throw new Error('the pronunciation service did not answer in time');
        if (attempt === 2 || e.final) throw e;
        await new Promise(r => setTimeout(r, 15000));      // network hiccup or a Space still starting
      } finally { clearTimeout(t); }
    }
    throw new Error('the pronunciation service is busy');
  }

  function fill(rec) {
    document.querySelectorAll(`.pron-slot[data-pron-id="${rec._pronId}"]`).forEach(el => { el.innerHTML = render(rec); });
  }

  // Only the words to work on: each mispronounced word with the dictionary
  // pronunciation and what was heard, plus one line naming any recurring pattern.
  function render(rec) {
    const r = rec._pron;
    const head = `<div class="qs-lbl" style="margin-top:12px">🗣️ Pronunciation <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--g500)">· Từ phát âm chưa đúng</span></div>`;
    if (!r) {
      if (rec._pronErr) return head + `<div style="font-size:12px;color:var(--g500)">The pronunciation check could not run this time.</div>`;
      return head + `<div style="font-size:12px;color:var(--g500);display:flex;align-items:center;gap:8px"><span class="spinner" style="width:14px;height:14px;border-width:2px;margin:0"></span>Checking your pronunciation…</div>`;
    }
    const pats = (r.patterns || []).filter(p => p.count >= 2);
    const words = (r.issues || []).filter(w => w.flagged || (w.patterns || []).some(k => pats.some(p => p.key === k))).slice(0, 10);
    if (!words.length) return head + `<div style="font-size:12px;color:var(--green-d)">✓ No clear pronunciation problem found.</div>`;
    return head + `
      <div style="display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px">${words.map(w => `
        <span><strong>${esc(w.word)}</strong> <span style="font-family:var(--fm,monospace);color:var(--g600)">/${esc(w.expected)}/</span>
        <span style="color:var(--red)">→ /${esc(w.heard || '—')}/</span></span>`).join('')}</div>
      ${pats.length ? `<div style="font-size:11.5px;color:var(--gold-d);margin-top:6px">Lặp lại nhiều: ${pats.map(p => esc(p.vi) + ' ×' + p.count).join(' · ')}</div>` : ''}`;
  }

  window.Pron = P;
})();
