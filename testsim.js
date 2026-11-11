// ════════════════════════════════════════════
// TEST SIMULATION — a full IELTS Speaking test, Part 1 → 2 → 3, run the way
// the exam room runs it. The student pastes question banks for each part;
// the app picks 3 Part 1 topics (10–12 questions), one Part 2 cue card and
// 5–6 Part 3 questions. The examiner's lines are read aloud by the browser
// and shown as a script. Answers are recorded and transcribed in the
// background without being shown, and the whole test is graded once at the
// end with the same grader and CEFR/collocation analysis as practice.
//
// Uses from index.html: A, toast, ic, _h, gasCall, transcribeGroq, pickMime,
// prepareAnalysis, gradeAnswers, avg, calcOverall, saveAttempt, renderResults,
// buildReport, buildAnalysisPayload, gateBlocked, studentTab, SS.
// ════════════════════════════════════════════

const TS_TOPIC = 'Test Simulation';
const TS_P1_MIN_TOPICS = 4;
const TS_P1_MIN_Q = 10, TS_P1_MAX_Q = 12;
const TS_P3_MIN_Q = 5,  TS_P3_MAX_Q = 6;
const TS_PREP_SEC = 60, TS_LONG_TURN_SEC = 120;
const TS_MAX_ANSWER = { part1: 60, part3: 90 };   // the examiner moves on after this

const TS_SCRIPT = {
  p1First: t => `Now, in this first part, I'm going to ask you some questions about ${t}.`,
  p1Next:  t => `Now, let's talk about ${t}.`,
  p2Intro: "Now, I'm going to give you a topic, and I'd like you to talk about it for one to two minutes. " +
           "Before you talk, you'll have one minute to think about what you're going to say. " +
           "You can make some notes if you wish. Here's some paper and a pencil to make notes, and here is your topic. " +
           "Your one minute begins now.",
  p2Go:    'Your one minute preparation is up. Please start speaking for one to two minutes.',
  p2End:   'Thank you.',
  p3Intro: "Now, let's move to the final part of your speaking test.",
  end:     'That is the end of the speaking test. Thank you.'
};

// ── PARSING ─────────────────────────────────
// A line is a question when it ends in "?" or opens like one; a short line
// that does neither ("Study", "Accommodation:") is a topic name.
const TS_QWORD = /^(what|what's|how|why|when|where|who|whom|whose|which|do|does|did|don't|doesn't|is|isn't|are|aren't|was|were|can|could|would|will|should|shall|may|might|have|has|had|tell|describe|talk|explain|compare|if|in|on|at|for|from|to|so|and|but|now|let's|please|some|many|people|imagine|suppose|say|give)\b/i;

function tsLines(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}
// Drop list markers: "1.", "2)", "Q3:", "-", "•", "a)".
function tsStrip(line) {
  return String(line).replace(/^(?:[-–—•*·▪◦]+|q?\d{1,2}\s*[.):]|[a-z]\))\s*/i, '').trim();
}
function tsIsHeader(s) {
  if (/\?\s*$/.test(s)) return false;
  if (/:\s*$/.test(s)) return true;
  const words = s.replace(/[.:]+$/, '').split(/\s+/).length;
  return words <= 6 && !TS_QWORD.test(s);
}
function tsTopicName(s) {
  return String(s).replace(/^(?:topic|chủ đề)\s*\d*\s*[:.\-–—)]\s*/i, '').replace(/[.:]+\s*$/, '').trim();
}

// Part 1: "Topic 1: Study" (or just "Study") followed by its questions.
function tsParsePart1(text) {
  const topics = [];
  let cur = null;
  tsLines(text).forEach(line => {
    if (/^part\s*1\b[\s:.\-–—]*$/i.test(line)) return;          // a bare "Part 1" heading
    const bare = tsStrip(line.replace(/^part\s*1\b[\s:.\-–—]*/i, ''));
    if (!bare) return;
    if (/^(?:topic|chủ đề)\s*\d*\s*[:.\-–—)]/i.test(bare) || tsIsHeader(bare)) {
      cur = { name: tsTopicName(bare) || 'Topic ' + (topics.length + 1), qs: [] };
      topics.push(cur);
      return;
    }
    if (!cur) { cur = { name: 'General', qs: [] }; topics.push(cur); }
    cur.qs.push(bare);
  });
  return topics.filter(t => t.qs.length);
}

// Part 2: each cue card starts with "Describe…"; the lines under it are the
// prompts ("You should say: …"). A "Part 3" line after the prompts starts the
// discussion questions that go with that card.
function tsParsePart2(text) {
  const cards = [];
  let cur = null, inP3 = false;
  tsLines(text).forEach(line => {
    if (/^part\s*3\b/i.test(line)) {
      inP3 = true;
      const rest = tsStrip(line.replace(/^part\s*3\b[\s:.\-–—]*/i, ''));
      if (cur && rest && !tsIsHeader(rest)) cur.p3.push(rest);
      return;
    }
    const l = line.replace(/^part\s*2\b[\s:.\-–—]*/i, '').trim();
    if (!l) return;
    const bare = tsStrip(l).replace(/^(?:topic|cue card)\s*\d*\s*[:.\-–—)]\s*/i, '');
    if (/^describe\b/i.test(bare)) { cur = { cue: bare, points: [], p3: [] }; cards.push(cur); inP3 = false; return; }
    if (!cur) return;                                              // nothing before the first "Describe"
    if (inP3) { const q = tsStrip(l); if (q && !tsIsHeader(q)) cur.p3.push(q); }
    else cur.points.push(l);
  });
  return cards;
}

// Part 3 box: a plain list of discussion questions (headings are skipped).
function tsParsePart3(text) {
  return tsLines(text)
    .map(l => tsStrip(l.replace(/^part\s*3\b[\s:.\-–—]*/i, '')))
    .filter(q => q && !tsIsHeader(q));
}

function tsRand(n) { return Math.floor(Math.random() * n); }
function tsShuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = tsRand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// n items from list, in their original order. keepFirst keeps the opener
// ("Do you work or study?") where an examiner would start.
function tsSample(list, n, keepFirst) {
  n = Math.min(n, list.length);
  if (n <= 0) return [];
  const idx = list.map((_, i) => i);
  const head = keepFirst ? [0] : [];
  const rest = tsShuffle(idx.slice(head.length)).slice(0, n - head.length);
  return head.concat(rest).sort((a, b) => a - b).map(i => list[i]);
}

// The test the student will sit: { part1: [{topic, qs}], card, part3: [q] }.
function tsBuildPlan(p1, cards, pool) {
  const target = TS_P1_MIN_Q + tsRand(TS_P1_MAX_Q - TS_P1_MIN_Q + 1);
  // Three random topics; reshuffle a few times if they hold too few questions.
  let best = null;
  for (let t = 0; t < 30; t++) {
    const pick = tsShuffle(p1).slice(0, 3);
    const tot = pick.reduce((n, x) => n + x.qs.length, 0);
    if (!best || Math.min(tot, target) > Math.min(best.tot, target)) best = { pick, tot };
    if (tot >= target) break;
  }
  const quota = best.pick.map(() => 0);
  for (let sum = 0, moved = true; sum < target && moved;) {
    moved = false;
    best.pick.forEach((tp, i) => { if (sum < target && quota[i] < tp.qs.length) { quota[i]++; sum++; moved = true; } });
  }
  const part1 = best.pick.map((tp, i) => ({ topic: tp.name, qs: tsSample(tp.qs, quota[i], true) }));

  // Prefer a card whose discussion reaches 5 questions (its own Part 3, topped
  // up from the Part 3 box); failing that, the card with the most.
  const reach = c => c.p3.length + pool.filter(q => c.p3.indexOf(q) < 0).length;
  const full = cards.filter(c => reach(c) >= TS_P3_MIN_Q);
  const most = Math.max(...cards.map(reach));
  const pickFrom = full.length ? full : cards.filter(c => reach(c) === most);
  const card = pickFrom[tsRand(pickFrom.length)];
  const n3 = TS_P3_MIN_Q + tsRand(TS_P3_MAX_Q - TS_P3_MIN_Q + 1);
  const mine = tsSample(card.p3, n3, true);
  const extra = tsSample(pool.filter(q => card.p3.indexOf(q) < 0), n3 - mine.length, false);
  return { part1, card, part3: mine.concat(extra) };
}

// What the setup boxes hold, and whether a test can be built from them.
function tsCheck() {
  const v = id => document.getElementById(id)?.value || '';
  const p1 = tsParsePart1(v('ts-p1')), cards = tsParsePart2(v('ts-p2')), pool = tsParsePart3(v('ts-p3'));
  const p3total = pool.length + cards.reduce((n, c) => n + c.p3.length, 0);
  const errors = [];
  if (p1.length < TS_P1_MIN_TOPICS) errors.push(`Part 1 needs at least ${TS_P1_MIN_TOPICS} topics (found ${p1.length}).`);
  if (!cards.length) errors.push('Part 2 needs at least one cue card starting with "Describe…".');
  if (cards.length && !p3total) errors.push('Add Part 3 questions: after a "Part 3" line in the Part 2 box, or in the Part 3 box.');
  const warnings = [];
  const p1max = p1.map(t => t.qs.length).sort((a, b) => b - a).slice(0, 3).reduce((a, n) => a + n, 0);
  if (p1.length >= TS_P1_MIN_TOPICS && p1max < TS_P1_MIN_Q) warnings.push(`Part 1 will have only ${p1max} questions — add more so it reaches ${TS_P1_MIN_Q}.`);
  const p3max = cards.length ? Math.max(...cards.map(c => c.p3.length + pool.filter(q => c.p3.indexOf(q) < 0).length)) : 0;
  if (p3total && p3max < TS_P3_MIN_Q) warnings.push(`Part 3 will have only ${p3max} questions — add more so it reaches ${TS_P3_MIN_Q}.`);
  return { p1, cards, pool, p3total, errors, warnings };
}

// ── SETUP SCREEN ────────────────────────────
function tsDraftKey() { return 'speak_test_draft_' + (A.user?.studentId || ''); }
function tsLoadDraft() { try { return JSON.parse(localStorage.getItem(tsDraftKey()) || '{}'); } catch (e) { return {}; } }
function tsSaveDraft() {
  try { localStorage.setItem(tsDraftKey(), JSON.stringify({ p1: document.getElementById('ts-p1').value, p2: document.getElementById('ts-p2').value, p3: document.getElementById('ts-p3').value })); } catch (e) {}
}

function openTestSim() {
  if (gateBlocked()) return;
  tsInjectStyles();
  const d = tsLoadDraft();
  const c = document.getElementById('student-content');
  c.innerHTML = `
    <button class="btn btn-outline btn-sm" onclick="studentTab('practice')" style="margin-bottom:16px">← Back</button>
    <h2 style="margin-bottom:6px"><span class="h-ic">${ic('exam')}</span>Test Simulation</h2>
    <p style="font-size:13px;color:var(--g600);margin-bottom:18px;line-height:1.6">Paste your question bank into the three boxes. The app picks
      <strong>3 Part 1 topics (10–12 questions)</strong>, <strong>1 Part 2 cue card</strong> and <strong>5–6 Part 3 questions</strong>,
      then runs the test like the real exam room, in full screen. It takes about 11–14 minutes.</p>

    <div class="card ts-box">
      <div class="ts-box-hd"><span class="ts-num">1</span><div><div class="ts-box-title">Part 1 — at least 4 topics</div>
        <div class="ts-box-sub">Write the topic name, then its questions underneath. Start a new topic with its name or <code>Topic 2: …</code></div></div></div>
      <textarea id="ts-p1" class="form-input ts-ta" rows="9" oninput="tsOnInput()" placeholder="Topic 1: Study&#10;Do you work or study?&#10;Why did you choose that subject?&#10;&#10;Topic 2: Accommodation&#10;Do you live in a house or a flat?&#10;…">${_h(d.p1 || '')}</textarea>
      <div class="ts-status" id="ts-st1"></div>
    </div>

    <div class="card ts-box">
      <div class="ts-box-hd"><span class="ts-num">2</span><div><div class="ts-box-title">Part 2 — one or more cue cards (+ their Part 3)</div>
        <div class="ts-box-sub">Each card starts with <code>Describe…</code>. Its Part 3 questions can follow under a <code>Part 3</code> line.</div></div></div>
      <textarea id="ts-p2" class="form-input ts-ta" rows="9" oninput="tsOnInput()" placeholder="Describe a book you enjoyed reading.&#10;You should say:&#10;what the book was&#10;when you read it&#10;and explain why you enjoyed it.&#10;Part 3&#10;Do people read less than they used to?&#10;…">${_h(d.p2 || '')}</textarea>
      <div class="ts-status" id="ts-st2"></div>
    </div>

    <div class="card ts-box">
      <div class="ts-box-hd"><span class="ts-num">3</span><div><div class="ts-box-title">Part 3 — optional</div>
        <div class="ts-box-sub">Leave empty if Part 3 is already in box 2. Questions here are used when the chosen card has too few of its own.</div></div></div>
      <textarea id="ts-p3" class="form-input ts-ta" rows="5" oninput="tsOnInput()" placeholder="One question per line">${_h(d.p3 || '')}</textarea>
      <div class="ts-status" id="ts-st3"></div>
    </div>

    <div class="card" style="background:var(--blue-l);border-color:var(--blue-m)">
      <div class="ts-tip">Before you start: turn the sound on (headphones are best), allow the microphone,
        and sit somewhere quiet. Answer as you would to a real examiner — your words are not shown during the test.
        <br><em>Bật loa (nên dùng tai nghe), cho phép micro, ngồi chỗ yên tĩnh. Trong lúc thi, bài nói không hiện lên màn hình.</em></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <select id="ts-voice-sel" class="form-input" style="flex:1;min-width:200px;max-width:360px;padding:7px 10px;font-size:13px" onchange="Voice.pick(this.value);tsVoiceCheck()" aria-label="Examiner voice"></select>
        <button class="btn btn-outline btn-sm" id="ts-voice-btn" onclick="tsVoiceCheck()">${Voice.icon(16)} Listen · Nghe thử</button>
      </div>
      <div id="ts-voice-st" style="font-size:12px;margin-top:6px"></div>
    </div>
    <div id="ts-errors" class="ts-errors"></div>
    <button class="btn btn-primary" id="ts-start" style="width:100%;justify-content:center;padding:14px;font-size:1rem" onclick="tsStart()">${ic('rocket')}Start the test</button>`;
  tsOnInput(true);
  tsVoiceMenu();
  Voice.onVoices = tsVoiceMenu;
}

let _tsInputTm = null;
function tsOnInput(now) {
  clearTimeout(_tsInputTm);
  _tsInputTm = setTimeout(() => {
    tsSaveDraft();
    const r = tsCheck();
    const ok = (el, html, good) => { const e = document.getElementById(el); if (e) { e.innerHTML = html; e.className = 'ts-status ' + (good ? 'ok' : 'bad'); } };
    ok('ts-st1', r.p1.length
      ? `${r.p1.length} topic${r.p1.length === 1 ? '' : 's'}: ` + r.p1.map(t => `<b>${_h(t.name)}</b> (${t.qs.length})`).join(' · ')
      : 'No topics yet', r.p1.length >= TS_P1_MIN_TOPICS);
    ok('ts-st2', r.cards.length
      ? `${r.cards.length} cue card${r.cards.length === 1 ? '' : 's'}: ` + r.cards.map(c => `<b>${_h(c.cue.length > 60 ? c.cue.slice(0, 57) + '…' : c.cue)}</b>` +
          (c.p3.length ? ` + ${c.p3.length} Part 3` : '')).join(' · ')
      : 'No cue card yet', r.cards.length > 0);
    ok('ts-st3', r.pool.length ? `${r.pool.length} question${r.pool.length === 1 ? '' : 's'}` : (r.p3total ? 'Not needed — Part 3 is in box 2' : 'Empty'), r.pool.length || r.p3total);
    const errs = document.getElementById('ts-errors');
    if (errs) errs.innerHTML = (r.errors.length && !now ? r.errors.map(e => `<div>• ${_h(e)}</div>`).join('') : '') +
      r.warnings.map(w => `<div class="ts-warn">• ${_h(w)}</div>`).join('');
  }, now ? 0 : 250);
}

// ── THE TEST ────────────────────────────────
const TS_STOP = new Error('ts-stop');
const TS = { on: false, stopped: false, stream: null, mime: '', ac: null, analyser: null, voice: null,
             plan: null, recs: [], trq: Promise.resolve(), done: 0, waiters: [], keyBad: false, t0: null, step: 0, steps: 0,
             grades: {}, reports: {} };

function tsSleep(ms) {
  return new Promise(res => { const t = setTimeout(res, ms); TS.waiters.push(() => { clearTimeout(t); res(); }); });
}
function tsGuard() { if (TS.stopped) throw TS_STOP; }

// The examiner voice menu: "Automatic" (the most natural voice that works
// here) or one of this device's English voices, natural ones marked ★.
function tsVoiceMenu() {
  const sel = document.getElementById('ts-voice-sel');
  if (!sel) return;
  const list = Voice.voiceList(), picked = Voice.picked();
  sel.innerHTML = `<option value="">Automatic — most natural voice${list.length ? ' (' + _h(Voice.current()) + ')' : ''}</option>` +
    list.map(v => `<option value="${_h(v.name)}" ${v.name === picked ? 'selected' : ''}>${v.natural ? '★ ' : ''}${_h(v.name)} · ${_h(v.lang)}</option>`).join('');
  sel.style.display = list.length ? '' : 'none';
  if (document.getElementById('ts-voice-btn')?.disabled) sel.hidden = true;   // a line is playing
}
// Plays one line so the student can check the sound before the test, and
// says which voice played (or what each voice tried answered) for support.
function tsVoiceCheck() {
  const st = document.getElementById('ts-voice-st');
  const say = m => { if (st) st.innerHTML = m; };
  if (Voice.mode() === 'off') { say('<span style="color:var(--red-d)">This browser cannot read aloud — the questions will be shown as text. Try Chrome or Safari.<br><em>Trình duyệt này không đọc được — câu hỏi chỉ hiện chữ. Hãy dùng Chrome hoặc Safari.</em></span>'); return; }
  // While the line plays, the voice menu is put away and Listen is off, so
  // nobody can switch voices half-way; both come back when it ends.
  const sel = document.getElementById('ts-voice-sel'), btn = document.getElementById('ts-voice-btn');
  const busy = on => { if (sel) sel.hidden = on; if (btn) btn.disabled = on; };
  busy(true);
  say('▶ Playing ' + _h(Voice.picked() || Voice.current()) + '… · Đang phát…');
  Voice.onSilent = null;
  Voice.heard = false;
  Voice.diag.tries = [];
  Voice.unlock();
  Voice.say('Hello! In this test, I will ask you some questions about yourself.').then(() => {
    busy(false);
    tsVoiceMenu();
    const d = Voice.diag, log = `<div style="color:var(--g500);margin-top:4px">${d.voices} voices · ${d.tries.map(_h).join(' · ')}</div>`;
    say(Voice.heard
      ? `<span style="color:var(--green-d)">✓ The device played the voice. If you heard nothing, check the speaker / output device and volume. · Máy đã phát giọng; nếu không nghe thấy, kiểm tra loa / thiết bị phát và âm lượng.</span>${log}`
      : TS_SILENT_MSG + log);
  });
}
const TS_SILENT_MSG = '<span style="color:var(--red-d)">The device did not play the voice. Turn the volume up, switch off silent mode, and check that this tab is not muted; or try Chrome. The questions are always shown on screen too.<br><em>Máy không phát giọng đọc. Tăng âm lượng, tắt chế độ im lặng, kiểm tra tab không bị tắt tiếng, hoặc thử Chrome. Câu hỏi vẫn luôn hiện trên màn hình.</em></span>';

async function tsStart() {
  const r = tsCheck();
  if (r.errors.length) { document.getElementById('ts-errors').innerHTML = r.errors.map(e => `<div>• ${_h(e)}</div>`).join(''); return; }
  A.gkey    = localStorage.getItem('speak_gemini_key') || A.gkey || '';
  A.groqKey = localStorage.getItem('speak_groq_key') || A.groqKey || '';
  if (!A.gkey)    { toast('Please enter your Gemini API key in Practice first', 'error'); return; }
  if (!A.groqKey) { toast('Please enter your Groq API key in Practice first', 'error'); return; }

  // Everything that needs the click itself happens before the first await:
  // full screen, unlocking speech on iOS, starting the audio context.
  try { const el = document.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {}); } catch (e) {}
  tsUnlockSpeech();
  loadPronPolicy();          // settles long before the first part is checked
  Voice.onSilent = () => { const a = document.getElementById('ts-alert'); if (a && !TS.keyBad) { a.style.display = 'block'; a.innerHTML = TS_SILENT_MSG; } };
  try { TS.ac = new (window.AudioContext || window.webkitAudioContext)(); TS.ac.resume?.(); } catch (e) { TS.ac = null; }

  Object.assign(TS, { on: true, stopped: false, recs: [], trq: Promise.resolve(), done: 0, waiters: [], keyBad: false, limitShown: false, retrying: false, t0: new Date().toISOString(), grades: {}, reports: {} });
  TS.plan = tsBuildPlan(r.p1, r.cards, r.pool);
  TS.steps = TS.plan.part1.reduce((n, t) => n + t.qs.length, 0) + 1 + TS.plan.part3.length;
  TS.step = 0;
  tsOpenStage();
  try {
    TS.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    tsCloseStage();
    toast('Microphone blocked — allow it in the browser and try again (' + e.message + ')', 'error', 7000);
    return;
  }
  TS.mime = pickMime();
  try { if (TS.ac) { TS.analyser = TS.ac.createAnalyser(); TS.analyser.fftSize = 512; TS.ac.createMediaStreamSource(TS.stream).connect(TS.analyser); } } catch (e) { TS.analyser = null; }


  try { await tsRun(); }
  catch (e) {
    if (e !== TS_STOP) { console.error('[test]', e); toast('The test stopped: ' + e.message, 'error', 8000); tsTeardown(); studentTab('practice'); }
  }
}

async function tsRun() {
  const P = TS.plan;
  await tsCountdown();
  tsPart('Part 1', 'Introduction and interview');
  for (let ti = 0; ti < P.part1.length; ti++) {
    const tp = P.part1[ti], name = tsSpokenTopic(tp.topic);
    await tsSay(ti === 0 ? TS_SCRIPT.p1First(name) : TS_SCRIPT.p1Next(name));
    for (const q of tp.qs) {
      await tsAsk(q, 'Part 1 · ' + tp.topic);
      await tsAnswer({ part: 'part1', topic: tp.topic, question: q, max: TS_MAX_ANSWER.part1 });
    }
  }
  tsQueueGrade('part1');     // marked while the student does Part 2 and 3

  tsPart('Part 2', 'Individual long turn');
  TS.step++;
  tsProgress('Part 2 · Long turn');
  tsShowQ('');
  await tsSay(TS_SCRIPT.p2Intro);
  tsShowCard(P.card);
  tsNotes(true);
  await tsRing(TS_PREP_SEC, 'Preparation');
  await tsSay(TS_SCRIPT.p2Go);
  tsHideCard(true);          // as in the exam room: talk from your notes
  await tsAnswer({ part: 'part2', topic: P.card.cue, question: [P.card.cue].concat(P.card.points).join('\n'), max: TS_LONG_TURN_SEC, ring: true });
  tsNotes(false);
  tsQueueGrade('part2');
  await tsSay(TS_SCRIPT.p2End);

  tsPart('Part 3', 'Two-way discussion');
  tsShowQ('');
  await tsSay(TS_SCRIPT.p3Intro);
  for (const q of P.part3) {
    await tsAsk(q, 'Part 3');
    await tsAnswer({ part: 'part3', topic: P.card.cue, question: q, max: TS_MAX_ANSWER.part3 });
  }
  tsQueueGrade('part3');
  tsShowQ('');
  await tsSay(TS_SCRIPT.end);
  await tsFinish();
}

// "Study" → "study", but "Ho Chi Minh City" stays as written.
function tsSpokenTopic(t) {
  const w = String(t).split(/\s+/);
  return w.length && /^[A-Z][a-z]+$/.test(w[0]) && w.slice(1).every(x => x === x.toLowerCase()) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

// ── EXAMINER VOICE ──────────────────────────
// voice.js speaks with the device voice. With the voice
// off, the script stays on screen for about the time it takes to read it.
function tsUnlockSpeech() { Voice.unlock(); }
function tsSpeak(text) {
  if (Voice.mode() === 'off') return tsSleep(800 + String(text).split(/\s+/).length * 380);
  return Voice.say(text);
}
// The examiner's own lines show in the examiner box; a question is shown once,
// large, below it (tsShowQ), and the box only carries a short cue meanwhile.
async function tsSay(text, isQuestion) {
  tsGuard();
  tsRecUI(isQuestion ? 'idle' : false);
  const sc = document.getElementById('ts-script');
  const box = sc && sc.closest('.ts-examiner');
  if (isQuestion) tsCue('Listen to the question.'); else if (sc) sc.textContent = text;
  if (box) box.classList.add('speaking');
  await tsSpeak(text);
  if (box) box.classList.remove('speaking');
  tsGuard();
  await tsSleep(350);
  tsGuard();
}
async function tsAsk(q, label) {
  tsGuard();
  TS.step++;
  tsProgress(label);
  tsShowQ(q);
  await tsSay(q, true);
}

// ── RECORDING ───────────────────────────────
let _tsFinish = null;
function tsDone() { if (_tsFinish) _tsFinish(); }

async function tsAnswer(item) {
  tsGuard();
  // Each answer carries its part, so the grader, the results and the Doc
  // can all tell Part 1 from Part 3.
  const label = item.part === 'part1' ? '[Part 1 · ' + item.topic + '] ' : item.part === 'part2' ? '[Part 2] ' : '[Part 3] ';
  const rec = { part: item.part, topic: item.topic || '', label, question: label + item.question, studentAnswer: '', keywords: [], _words: [], _dur: 0, secs: 0, err: '' };
  TS.recs.push(rec);
  let mr;
  try { mr = TS.mime ? new MediaRecorder(TS.stream, { mimeType: TS.mime }) : new MediaRecorder(TS.stream); }
  catch (e) { mr = new MediaRecorder(TS.stream); }
  const chunks = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { mr.onstop = res; });
  mr.start(250);
  const t0 = Date.now();
  tsRecUI(true, item.part === 'part2' ? 'I have finished' : 'Finish answer', item.max);
  if (item.part !== 'part2') tsCue('Your turn — answer now.');
  if (item.ring) tsRingShow('Speaking time');

  await new Promise(res => {
    let enableAt = t0 + 1500;
    const btn = document.getElementById('ts-done');
    if (btn) btn.disabled = true;
    const tick = () => {
      const el = Math.floor((Date.now() - t0) / 1000);
      const tEl = document.getElementById('ts-rec-time');
      if (tEl) tEl.textContent = tsClock(Math.min(el, item.max));
      if (item.ring) tsRingSet(Math.max(0, item.max - el), item.max);
      if (btn && Date.now() >= enableAt) btn.disabled = false;
      if (el >= item.max || TS.stopped) finish();
    };
    const iv = setInterval(tick, 250);
    const finish = () => { clearInterval(iv); _tsFinish = null; res(); };
    _tsFinish = () => { if (Date.now() >= enableAt) finish(); };
    TS.waiters.push(finish);
    tick();
  });

  try { mr.stop(); } catch (e) {}
  await stopped;
  rec.secs = Math.round((Date.now() - t0) / 1000);
  tsRecUI(false);
  if (item.ring) tsRingHide();
  tsGuard();
  const mime = mr.mimeType || TS.mime || 'audio/webm';
  const blob = new Blob(chunks, { type: mime });
  TS.trq = TS.trq.then(() => tsTranscribe(rec, blob, mime));
}

// One answer at a time, in the order spoken, so a fast talker never hits the
// transcription rate limit. Nothing is shown to the student.
// A rate-limited key (Groq's free tier caps audio per hour — easily reached
// when several students share one key) is waited out instead of dropping
// the answer; the recording is kept so a failed answer can be sent again.
async function tsTranscribe(rec, blob, mime) {
  if (TS.stopped && !TS.retrying) return;
  rec._blob = blob; rec._mime = mime;
  if (!blob || blob.size < 1500) { rec.err = 'silent'; TS.done++; tsProcStatus(); return; }
  for (let k = 0; k < 5; k++) {
    try {
      const tr = await transcribeGroq(blob, mime);
      rec.studentAnswer = tr.text || ''; rec._words = tr.words || []; rec._dur = tr.duration || 0; rec.err = '';
      // Checked when the part ends (tsQueueGrade), all at once: the
      // pronunciation server then runs for a minute, not for the whole test.
      if (pronMode('test')) rec._pronIn = { blob, mime, text: tr.text, words: tr.words, vocab: [] };
      break;
    } catch (e) {
      rec.err = e.message || String(e);
      if (/key/i.test(rec.err)) { tsKeyProblem(rec.err); break; }
      const limited = /rate limit/i.test(rec.err);
      if (limited) tsLimitNotice();
      else if (k >= 1) break;                    // other errors: two tries
      await new Promise(r => setTimeout(r, limited ? 20000 : 1500));
      if (TS.stopped && !TS.retrying) break;
    }
  }
  TS.done++;
  tsProcStatus();
}
function tsLimitNotice() {
  if (TS.limitShown || TS.keyBad) return;
  TS.limitShown = true;
  const a = document.getElementById('ts-alert');
  if (a) { a.style.display = 'block'; a.innerHTML = '<strong>Groq is limiting your key right now</strong> (free tier: audio per hour — is the key shared with others?). Keep going: your answers are kept and sent again automatically.<br><em>Groq đang giới hạn key của bạn (gói miễn phí giới hạn số giây ghi âm mỗi giờ — có dùng chung key không?). Cứ tiếp tục thi: bài nói được giữ lại và tự gửi lại.</em>'; }
}
// Why no answer could be transcribed, in words the student can act on.
function tsFailReason() {
  const errs = TS.recs.map(r => r.err || ((r.studentAnswer || '').trim() ? '' : 'empty'));
  const has = re => errs.some(e => re.test(e));
  if (TS.keyBad || has(/key/i)) return { kind: 'key', text: 'Your Groq key was rejected — paste it again in Practice (from console.groq.com). · Groq từ chối key — vào Practice dán lại key (lấy ở console.groq.com).' };
  if (has(/rate limit/i)) return { kind: 'rate', text: 'Groq\'s free limit for your key was reached (audio seconds per hour — often because a key is shared). Wait about an hour, or use your own key, then press Send again. · Key Groq đã hết lượt miễn phí trong giờ (thường do dùng chung key). Đợi khoảng 1 tiếng hoặc dùng key riêng rồi bấm Gửi lại.' };
  if (has(/load failed|failed to fetch|network|timed? ?out/i)) return { kind: 'network', text: 'The connection dropped while sending your answers. Check Wi-Fi, then press Send again. · Mạng bị lỗi khi gửi bài. Kiểm tra Wi-Fi rồi bấm Gửi lại.' };
  if (errs.every(e => e === 'silent' || e === 'empty')) return { kind: 'mic', text: 'The microphone recorded only silence. Check that the right microphone is selected and not muted, then take the test again. · Micro chỉ thu được im lặng. Kiểm tra đúng micro và không bị tắt tiếng rồi thi lại.' };
  return { kind: 'other', text: 'Transcription failed: ' + (errs.find(e => e && e !== 'empty' && e !== 'silent') || 'unknown error') + ' · Không chuyển được giọng nói thành chữ.' };
}
// After a failed test: show why, and (unless the mic or key is the problem)
// let the student send the kept recordings again instead of re-taking it.
function tsShowFailure() {
  const why = tsFailReason();
  const c = document.getElementById('student-content');
  const canRetry = (why.kind === 'rate' || why.kind === 'network' || why.kind === 'other') && TS.recs.some(r => r._blob && r._blob.size >= 1500);
  if (!c) { toast(why.text, 'error', 15000); return; }
  c.innerHTML = `<div class="card" style="max-width:620px;margin:20px auto;text-align:center">
      <div style="font-size:1.2rem;font-weight:800;color:var(--red-d);margin-bottom:8px">None of your answers could be transcribed</div>
      <div style="font-size:14px;line-height:1.7;color:var(--g700)">${_h(why.text)}</div>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap">
        ${canRetry ? '<button class="btn btn-primary" onclick="tsRetryFailed()">Send again · Gửi lại</button>' : ''}
        <button class="btn btn-outline" onclick="studentTab(\'practice\')">Back to Practice</button>
      </div>
      <div id="ts-retry-st" style="font-size:12px;color:var(--g500);margin-top:10px"></div>
    </div>`;
}
async function tsRetryFailed() {
  const st = document.getElementById('ts-retry-st');
  const todo = TS.recs.filter(r => !(r.studentAnswer || '').trim() && r._blob && r._blob.size >= 1500);
  A.groqKey = localStorage.getItem('speak_groq_key') || A.groqKey || '';   // a key just fixed in Practice
  TS.retrying = true; TS.keyBad = false;
  let n = 0;
  for (const r of todo) {
    if (st) st.textContent = 'Sending ' + (++n) + ' / ' + todo.length + '…';
    await tsTranscribe(r, r._blob, r._mime);
  }
  TS.retrying = false;
  const answered = TS.recs.filter(r => (r.studentAnswer || '').trim());
  if (!answered.length) { tsShowFailure(); return; }
  ['part1', 'part2', 'part3'].forEach(tsPronPart);   // parts with no mark are marked again in tsCollectGrades
  await tsGradeAndSave(answered, TS.recs.length - answered.length);
}
function tsKeyProblem(msg) {
  if (TS.keyBad) return;
  TS.keyBad = true;
  const a = document.getElementById('ts-alert');
  if (a) { a.style.display = 'block'; a.innerHTML = '<strong>Your Groq key was rejected, so answers cannot be transcribed.</strong> Exit the test, fix the key in Practice and start again.<br><em>Groq key bị từ chối — hãy thoát, sửa key rồi thi lại.</em>'; }
}

// ── STAGE UI ────────────────────────────────
function tsOpenStage() {
  tsInjectStyles();
  let st = document.getElementById('ts-stage');
  if (st) st.remove();
  st = document.createElement('div');
  st.id = 'ts-stage';
  st.innerHTML = `
    <div class="ts-top"><div class="ts-top-in">
      <div class="ts-brand"><span class="ts-brand-ic">${ic('mic')}</span>
        <div><div class="ts-brand-t">Speaking Test</div><div class="ts-brand-s">IELTS-style Practice</div></div></div>
      <button class="ts-exit" onclick="tsExit()">${ic('logout')}<span>Exit test</span></button>
    </div></div>
    <div class="ts-body">
      <div class="ts-head">
        <div class="ts-head-row"><span class="ts-part" id="ts-part">Test</span><span class="ts-part-sub" id="ts-part-sub"></span><span class="ts-prog-txt" id="ts-prog-txt"></span></div>
        <div class="ts-prog-bar"><div id="ts-prog-fill"></div></div>
      </div>
      <div class="ts-alert" id="ts-alert" style="display:none"></div>
      <div class="ts-examiner"><span class="ts-ex-ic">${Voice.icon(28)}</span>
        <div class="ts-ex-txt"><div class="ts-ex-lbl">Examiner</div><div class="ts-script" id="ts-script"></div></div></div>
      <div class="ts-q" id="ts-q" style="display:none"></div>
      <div class="ts-mid">
        <div class="ts-ring" id="ts-ring" style="display:none">
          <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="ts-ring-bg"/><circle cx="60" cy="60" r="52" class="ts-ring-fg" id="ts-ring-fg"/></svg>
          <div class="ts-ring-in"><div class="ts-ring-num" id="ts-ring-num">60</div><div class="ts-ring-lbl" id="ts-ring-lbl"></div></div>
        </div>
        <div class="ts-notes" id="ts-notes" style="display:none">
          ${[1, 2, 4, 3].map(n => `<label class="ts-note"><span>${n}</span><textarea aria-label="Note ${n}"></textarea></label>`).join('')}
        </div>
      </div>
      <div class="ts-recwrap" id="ts-recwrap" style="display:none">
        <div class="ts-div"><span>${ic('mic')}</span></div>
        <div class="ts-rec" id="ts-rec">
          <div class="ts-rec-row"><span class="ts-rec-on"><span class="ts-dot"></span>Recording</span>
            <span class="ts-time"><b id="ts-rec-time">0:00</b> / <span id="ts-rec-max">1:00</span></span></div>
          <div class="ts-wave" id="ts-wave">${'<i></i>'.repeat(TS_WAVE_BARS)}</div>
        </div>
        <button class="ts-mic" id="ts-done" onclick="tsDone()" aria-label="Stop recording and finish the answer">${ic('stop')}</button>
        <div class="ts-mic-lbl" id="ts-done-lbl">Finish answer</div>
        <div class="ts-hint" id="ts-hint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.01"/></svg>
          <span class="ts-hint-key">Click the stop button or press <b>SPACE</b> when you have finished · Bấm nút dừng hoặc SPACE khi trả lời xong</span><span class="ts-hint-touch">Tap the stop button when you have finished · Chạm nút dừng khi trả lời xong</span></div>
      </div>
    </div>
    <div class="ts-count" id="ts-count"></div>
    <canvas class="ts-confetti" id="ts-confetti"></canvas>
    <div class="ts-congrats" id="ts-congrats" style="display:none"></div>`;
  document.body.appendChild(st);
  document.body.classList.add('ts-lock');
  document.addEventListener('keydown', tsKey, true);
  tsMeterLoop();
}
function tsKey(e) {
  if (!TS.on) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (e.code === 'Space' && !e.repeat && tag !== 'textarea' && tag !== 'input') { e.preventDefault(); e.stopPropagation(); tsDone(); }
}
function tsPart(name, sub) {
  const p = document.getElementById('ts-part'), s = document.getElementById('ts-part-sub');
  if (p) p.textContent = name;
  if (s) s.textContent = sub;
}
function tsProgress(label) {
  const t = document.getElementById('ts-prog-txt'), f = document.getElementById('ts-prog-fill');
  if (t) { t.textContent = TS.step + ' / ' + TS.steps; t.title = label; }
  if (f) f.style.width = Math.round(TS.step / TS.steps * 100) + '%';
}
function tsShowQ(q) {
  const el = document.getElementById('ts-q');
  if (!el) return;
  el.className = 'ts-q';
  el.style.display = q ? '' : 'none';
  el.textContent = q;
}
function tsShowCard(card) {
  const el = document.getElementById('ts-q');
  if (!el) return;
  el.className = 'ts-q ts-card';
  el.style.display = '';
  el.innerHTML = `<div class="ts-card-top"><div class="ts-card-lbl">Candidate task card</div>
      <button class="ts-card-btn" id="ts-card-toggle" onclick="tsToggleCard()">🙈 Hide question</button></div>
    <div class="ts-card-body"><div class="ts-card-cue">${_h(card.cue)}</div>` +
    (card.points.length ? `<div class="ts-card-pts">${card.points.map(p => `<div>${_h(p)}</div>`).join('')}</div>` : '') + `</div>
    <div class="ts-card-gone">The task card is put away while you speak, as in the real test. Use your notes.</div>`;
}
// Part 2 notes: four boxes, numbered clockwise (1 2 / 4 3), one per point.
function tsNotes(on) {
  const n = document.getElementById('ts-notes');
  if (!n) return;
  n.style.display = on ? '' : 'none';
  if (on) n.querySelectorAll('textarea').forEach(t => { t.value = ''; });
}
// The task card disappears once the long turn starts; the student can peek.
function tsHideCard(hide) {
  const el = document.getElementById('ts-q');
  if (!el || !el.classList.contains('ts-card')) return;
  el.classList.toggle('ts-card-hidden', hide);
  const b = document.getElementById('ts-card-toggle');
  if (b) b.textContent = hide ? '👁 Show question' : '🙈 Hide question';
}
function tsToggleCard() {
  const el = document.getElementById('ts-q');
  if (el) tsHideCard(!el.classList.contains('ts-card-hidden'));
}
// on: true = recording (red stop square), 'idle' = a question is being read
// (grey microphone, not yet recording), false = hidden.
function tsRecUI(on, label, max) {
  const w = document.getElementById('ts-recwrap'), l = document.getElementById('ts-done-lbl'), m = document.getElementById('ts-rec-max'),
    b = document.getElementById('ts-done');
  if (w) { w.style.display = on ? '' : 'none'; w.classList.toggle('idle', on === 'idle'); }
  if (b && on) {
    const rec = on === true;
    b.innerHTML = ic(rec ? 'stop' : 'mic');
    b.setAttribute('aria-label', rec ? 'Stop recording and finish the answer' : 'Recording starts after the question');
    if (!rec) b.disabled = true;
  }
  if (l) l.textContent = on === 'idle' ? 'Recording starts after the question' : (label || l.textContent);
  if (m && max) m.textContent = tsClock(max);
  if (on) { const t = document.getElementById('ts-rec-time'); if (t) t.textContent = '0:00'; tsWave.fill(0); }
}
function tsClock(sec) { return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
// The examiner box while a question is read or answered: a short cue, never
// the question itself (that is shown once, large, below).
function tsCue(text) {
  const sc = document.getElementById('ts-script');
  if (sc) sc.innerHTML = '<span class="ts-cue">' + _h(text) + '</span>';
}
// Waveform: the loudness of the last TS_WAVE_BARS moments, newest on the right.
const TS_WAVE_BARS = 36;
const tsWave = new Array(TS_WAVE_BARS).fill(0);
function tsMeterLoop() {
  const buf = new Uint8Array(512);
  let last = 0;
  const step = now => {
    if (!document.getElementById('ts-stage')) return;
    const wrap = document.getElementById('ts-recwrap');
    if (TS.analyser && wrap && wrap.style.display !== 'none' && now - last > 70) {
      last = now;
      TS.analyser.getByteTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      tsWave.shift(); tsWave.push(Math.min(1, Math.sqrt(sum / buf.length) * 5));
      const bars = document.getElementById('ts-wave').children;
      for (let i = 0; i < bars.length; i++) bars[i].style.transform = 'scaleY(' + Math.max(0.12, tsWave[i]).toFixed(2) + ')';
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Circular countdown (Part 2 preparation and long turn).
const TS_RING_LEN = 2 * Math.PI * 52;
function tsRingShow(label) {
  const r = document.getElementById('ts-ring'), l = document.getElementById('ts-ring-lbl');
  if (r) r.style.display = '';
  if (l) l.textContent = label;
}
function tsRingHide() { const r = document.getElementById('ts-ring'); if (r) r.style.display = 'none'; }
function tsRingSet(left, total) {
  const fg = document.getElementById('ts-ring-fg'), n = document.getElementById('ts-ring-num');
  if (fg) { fg.style.strokeDasharray = TS_RING_LEN; fg.style.strokeDashoffset = TS_RING_LEN * (1 - left / total); fg.classList.toggle('low', left <= 10); }
  if (n) n.textContent = total > 60 ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : left;
}
async function tsRing(secs, label) {
  tsGuard();
  tsRingShow(label);
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) {
    tsRingSet(Math.ceil((end - Date.now()) / 1000), secs);
    await tsSleep(200);
    tsGuard();
  }
  tsRingSet(0, secs);
  tsRingHide();
}

// 5 · 4 · 3 · 2 · 1 · Start
async function tsCountdown() {
  const o = document.getElementById('ts-count');
  if (!o) return;
  o.style.display = 'flex';
  for (const n of ['5', '4', '3', '2', '1', 'Start']) {
    tsGuard();
    o.innerHTML = `<div class="ts-count-n${n === 'Start' ? ' go' : ''}">${n}</div>`;
    await tsSleep(1000);
  }
  o.style.display = 'none';
  tsGuard();
}

// ── END OF THE TEST ─────────────────────────
function tsConfetti() {
  const cv = document.getElementById('ts-confetti');
  if (!cv) return;
  const ctx = cv.getContext('2d'), W = cv.width = innerWidth, H = cv.height = innerHeight;
  const cols = ['#E0895F', '#F4C95D', '#6CC4A1', '#7AA7E8', '#C792EA', '#FF7A90'];
  const ps = Array.from({ length: 180 }, () => ({ x: Math.random() * W, y: -20 - Math.random() * H * 0.6, vx: (Math.random() - 0.5) * 3,
    vy: 2 + Math.random() * 3.5, r: 4 + Math.random() * 5, a: Math.random() * 6.28, va: (Math.random() - 0.5) * 0.25, c: cols[tsRand(cols.length)] }));
  const t0 = performance.now();
  const frame = t => {
    if (!document.getElementById('ts-confetti')) return;
    ctx.clearRect(0, 0, W, H);
    ps.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.a += p.va; p.vy += 0.03;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    });
    if (t - t0 < 5000) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
  };
  requestAnimationFrame(frame);
}
function tsProcStatus() {
  const el = document.getElementById('ts-proc');
  if (el) el.textContent = `Preparing your feedback… ${TS.done} / ${TS.recs.length} answers processed`;
}

async function tsFinish() {
  tsRecUI(false);
  TS.on = false;
  const cg = document.getElementById('ts-congrats');
  if (cg) {
    cg.style.display = 'flex';
    cg.innerHTML = `<div class="ts-cg-card"><div class="ts-cg-ic">${ic('check')}</div>
      <div class="ts-cg-title">Congratulations!</div>
      <div class="ts-cg-sub">You have completed the full Speaking test.<br><em>Chúc mừng bạn đã hoàn thành bài thi!</em></div>
      <div class="ts-proc" id="ts-proc"></div><div class="spinner" style="margin:14px auto 0;width:26px;height:26px;border-width:2px"></div></div>`;
  }
  tsConfetti();
  tsProcStatus();
  const shownAt = Date.now();
  try { TS.stream?.getTracks().forEach(t => t.stop()); } catch (e) {}
  await TS.trq;
  if (Date.now() - shownAt < 3500) await new Promise(r => setTimeout(r, 3500 - (Date.now() - shownAt)));

  const answered = TS.recs.filter(r => (r.studentAnswer || '').trim());
  const missing = TS.recs.length - answered.length;
  tsTeardown();
  if (!answered.length) {
    await studentTab('practice');
    tsShowFailure();
    return;
  }
  await tsGradeAndSave(answered, missing);
}

// ── MARKING, ONE PART AT A TIME ──
// Each part is marked as soon as its answers are transcribed, while the
// student goes on with the next part: the wait at the end is only Part 3, and
// each request is small. A part that fails is tried again at the end.
const TS_PART_NAME = { part1: 'Part 1', part2: 'Part 2', part3: 'Part 3' };
function tsQueueGrade(part) {
  const transcribed = TS.trq;   // this part's answers are all queued before it
  TS.grades[part] = transcribed.then(() => { if (TS.stopped) return null; tsPronPart(part); return tsGradePart(part); });
}
function tsPronPart(part) {
  TS.recs.filter(r => r.part === part && r._pronIn).forEach(r => { const o = r._pronIn; delete r._pronIn; Pron.start(r, o); });
}
async function tsGradePart(part) {
  const list = TS.recs.filter(r => r.part === part && (r.studentAnswer || '').trim());
  if (!list.length) return null;
  let ctx = { evidence: '', caps: {} };
  try {
    try { await LexCoach.ready(2500); } catch (_) {}
    list.forEach(r => { r._m = localMetrics(r.studentAnswer); r._echo = questionEcho(r.question.replace(/^\[[^\]]*\]\s*/, ''), r.studentAnswer); });
    const words = list.reduce((a, r) => a.concat(r._words || []), []), dur = list.reduce((a, r) => a + (r._dur || 0), 0);
    const la = analyzeLanguage(list.map(r => r.studentAnswer).join(' '), prosodyFrom(words, dur));
    ctx = { evidence: la.evidence, caps: la.caps || {} };
  } catch (e) { console.warn('[test] part analysis', e); }
  // One try here; tsCollectGrades tries a failed part once more at the end,
  // minutes later, rather than hammering a grader that is overloaded now.
  // Graded in the background while the student goes on, so the
  // pronunciation evidence can be waited for (a cold server needs a moment).
  if (window.Pron) await Pron.wait(list, 90000);
  try {
    const g = await gradeAnswers(list, 'test', ctx);
    TS.reports[part] = g.rpt;
    return Object.assign({ ok: true, part }, g);
  } catch (e) { return { ok: false, part, err: e.message || String(e) }; }
}
// Waits for the three parts; a part that failed is marked once more now.
async function tsCollectGrades(only) {
  const out = { errors: [], gradedBy: '' };
  for (const part of only || ['part1', 'part2', 'part3']) {
    setGradingStatus('Marking ' + TS_PART_NAME[part] + '…');
    let g = !only && TS.grades[part] ? await TS.grades[part] : null;
    if (!g || !g.ok) g = await tsGradePart(part);
    if (!g) continue;
    if (g.ok) { if (!out.gradedBy || !/^gemini/i.test(g.gradedBy)) out.gradedBy = g.gradedBy; }
    else out.errors.push(TS_PART_NAME[part] + ': ' + g.err);
  }
  return out;
}
function tsMergedReport() { return mergeReports(['part1', 'part2', 'part3'].map(p => TS.reports[p])); }

async function tsGradeAndSave(answered, missing) {
  A.mode = 'test'; A.topic = TS_TOPIC; A.assignId = ''; A.t0 = TS.t0;
  A.qs = TS.recs.map(r => ({ question: r.question, keywords: [] }));
  A.testInfo = { missing, total: TS.recs.length, part2Secs: (TS.recs.find(r => r.part === 'part2') || {}).secs || 0 };
  await prepareAnalysis(answered);

  let attemptNo = 1;
  try {
    await flushOutbox(true, true);
    const chk = await gasCall('speak.findExisting', { topic: TS_TOPIC, type: 'test', part: 'test' });
    if (chk.success && chk.exists) attemptNo = (chk.attemptCount || 0) + 1;
  } catch (e) {}

  renderResults(answered, null, false, attemptNo, null, null, null, null, null, '', true);
  const col = await tsCollectGrades();
  const rpt = tsMergedReport(), gradedBy = col.gradedBy, gradeError = col.errors.join('  ·  ');
  const graded = !col.errors.length && answered.some(r => r.scores);
  const gradedCount = answered.filter(r => r.scores).length;

  const fc = avg(answered, 'fluency'), lr = avg(answered, 'lexical'), gr = avg(answered, 'grammar'), p = avg(answered, 'pronunciation');
  const overall = calcOverall(fc, lr, gr, p);
  let recordedNo = attemptNo;
  try {
    const saved = await saveAttempt({
      assignId: '', topic: TS_TOPIC, part: 'test', mode: 'test', type: 'test',
      startTime: TS.t0, endTime: new Date().toISOString(),
      durationMin: Math.max(1, Math.round((Date.now() - new Date(TS.t0)) / 60000)),
      retryCount: attemptNo - 1, attemptNo, isMilestone: graded,
      gradeError, gradedBy,
      overall: graded ? overall : '', fc: graded ? fc : '', lr: graded ? lr : '', gr: graded ? gr : '', p: graded ? p : '',
      questionsJSON: A.qs,
      resultsJSON: answered.map(r => ({
        question: r.question, part: r.part, keywords: [], studentAnswer: r.studentAnswer, overall: r.overall || '',
        scores: r.scores || null, errors: r.errors || [], suggestion: r.suggestion || '', natural: r.natural || '', logic: r.logic || null, seconds: r.secs || 0
      })),
      reportText: buildReport(answered, rpt, graded, attemptNo),
      analysis: buildAnalysisPayload(),
      docPayload: tsDocPayload(answered, rpt, { overall, fc, lr, gr, p, graded, gradedBy, gradeError })
    });
    if (saved.success) { A.lastSessionId = saved.sessionId || ''; if (saved.attemptNo) recordedNo = saved.attemptNo; }
    else {
      A.lastSessionId = '';
      toast('This test has not reached the server yet (' + (saved.error || 'network') + '). It is kept on this device and will be sent automatically.', 'error', 10000);
    }
  } catch (e) { toast('Could not save this test: ' + e.message, 'error', 8000); }
  A.retryCount = recordedNo;
  if (!graded) toast('Grading failed — the test was saved without a score', 'error', 8000);
  A.testDocUrl = ''; A.testDocBusy = !!A.lastSessionId;
  A.testAnswered = answered; A.testGradedBy = gradedBy;
  renderResults(answered, rpt, graded, recordedNo, overall, fc, lr, gr, p, gradeError, false, gradedBy, gradedCount);
  if (A.lastSessionId) tsMakeDoc(A.lastSessionId);
}

// Grading failed: mark the same answers again (no need to sit the test
// again), put the bands on the attempt line and make a new Doc.
async function tsRegrade(btn) {
  if (A.testRegrading) return;              // already marking: ignore extra clicks
  const answered = A.testAnswered;
  if (!answered || !A.lastSessionId) { toast('Nothing to grade — this test is no longer open on this page.', 'error'); return; }
  A.testRegrading = true;
  const spin = '<span class="spinner" style="width:15px;height:15px;border-width:2px;margin:0 6px 0 0;display:inline-block;vertical-align:-3px"></span>';
  if (btn) { btn.disabled = true; btn.innerHTML = spin + 'Grading… please wait'; }
  try {
    // The Doc of the unmarked test may still be saving; marking waits for it.
    while (A.testDocBusy) { if (btn) btn.innerHTML = spin + 'Saving your test first…'; await new Promise(r => setTimeout(r, 500)); }
    await tsRegradeNow(answered);
  } finally { A.testRegrading = false; }
}
async function tsRegradeNow(answered) {
  const no = A.retryCount;
  renderResults(answered, null, false, no, null, null, null, null, null, '', true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setGradingStatus('Grading again — this takes about a minute. Please keep this page open.');
  // Only the parts still unmarked go back to the grader.
  const todo = ['part1', 'part2', 'part3'].filter(p => answered.some(r => r.part === p && !r.scores));
  const col = await tsCollectGrades(todo);
  if (col.errors.length) { renderResults(answered, null, false, no, '', '', '', '', '', col.errors.join('  ·  '), false); return; }
  const rpt = tsMergedReport(), gradedBy = col.gradedBy || A.testGradedBy || '', gradedCount = answered.filter(r => r.scores).length;
  const fc = avg(answered, 'fluency'), lr = avg(answered, 'lexical'), gr = avg(answered, 'grammar'), p = avg(answered, 'pronunciation');
  const overall = calcOverall(fc, lr, gr, p);
  const res = await gasCall('speak.regradeTest', { sessionId: A.lastSessionId, overall, fc, lr, gr, p, gradedBy,
    reportText: buildReport(answered, rpt, true, no),
    docPayload: tsDocPayload(answered, rpt, { overall, fc, lr, gr, p, graded: true, gradedBy, gradeError: '' }) });
  if (!res.success) toast('Graded, but the score could not be saved: ' + res.error, 'error', 9000);
  A.testDocUrl = ''; A.testDocBusy = !!res.success;
  renderResults(answered, rpt, true, no, overall, fc, lr, gr, p, '', false, gradedBy, gradedCount);
  if (res.success) { clearTabCache(); tsMakeDoc(A.lastSessionId); }
}

// ── GOOGLE DOCS: the only lasting copy of a test ──
// The full test goes into one Doc; the app keeps just the attempt line
// (date, scores, Doc link). Apps Script builds the Doc from the record saved
// above and then deletes that record.
async function tsMakeDoc(sessionId, asTeacher) {
  A.testDocBusy = true; tsDocSlot();
  try {
    const res = await gasCall(asTeacher ? 'teacher.exportDoc' : 'speak.exportDoc', { sessionId });
    if (!res.success) throw new Error(res.error || 'Doc not created');
    if (!res.testDoc) toast('Apps Script is still running the old Code.gs — paste the new one and deploy a New version so tests move fully into Docs.', 'error', 9000);
    A.testDocUrl = res.url;
    clearTabCache();
    toast('Your test is saved in Google Docs', 'success', 4000);
  } catch (e) {
    toast('Could not create the Google Doc yet (' + e.message + '). Press "Create Docs" to try again — your test is kept until then.', 'error', 9000);
  } finally { A.testDocBusy = false; tsDocSlot(); }
}
function tsDocSlotHtml() {
  if (A.testDocUrl) return `<button class="btn btn-green" onclick="tsOpenDoc('${_h(A.testDocUrl)}')">📄 Open Docs</button>`;
  if (A.testDocBusy) return `<button class="btn btn-green" disabled>⏳ Saving to Google Docs…</button>`;
  return A.lastSessionId ? `<button class="btn btn-green" onclick="tsMakeDoc('${_h(A.lastSessionId)}')">📄 Create Docs</button>` : '';
}
function tsDocSlot() { const el = document.getElementById('ts-doc-slot'); if (el) el.innerHTML = tsDocSlotHtml(); }
// History / teacher: a test opens its own Doc, or builds it if that never happened.
function tsOpenDoc(url, sessionId, asTeacher, studentId) {
  if (url) {
    const win = window.open('about:blank', '_blank');
    gasCall(asTeacher ? 'teacher.formatDoc' : 'speak.formatDoc', { url, studentId })
      .then(res => { if (res && !res.success) toast('Could not apply document formatting: ' + (res.error || 'unknown error'), 'error', 7000); })
      .catch(err => toast('Could not apply document formatting: ' + err.message, 'error', 7000))
      .finally(() => { if (win && !win.closed) win.location.href = url; else window.open(url, '_blank', 'noopener'); });
    return;
  }
  if (sessionId) tsMakeDoc(sessionId, asTeacher).then(() => { if (A.testDocUrl) window.open(A.testDocUrl, '_blank', 'noopener'); });
}

// Everything the Doc shows, measured on this device: CEFR mix, words by
// level, words per sentence, sentence types, grammar, delivery, accuracy,
// collocations, and each answer with its B1+ words coloured by level.
// `meta` lets JAM use the same Doc data: { kind, topic, startTime, durationMin, info }.
function tsDocPayload(answered, rpt, g, meta) {
  meta = meta || {};
  const LV = { B1: 1, B2: 1, C1: 1, C2: 1 };
  const sentStats = text => {
    const ss = String(text || '').split(/[.!?]+/).map(x => x.trim()).filter(x => /[a-z]/i.test(x));
    const words = (String(text || '').match(/\b[a-z][a-z'-]*\b/gi) || []).length;
    return { words, sentences: ss.length, perSentence: ss.length ? Math.round(words / ss.length * 10) / 10 : 0 };
  };
  const segments = text => {
    const out = [];
    const push = (t, l) => { if (out.length && out[out.length - 1][1] === l) out[out.length - 1][0] += t; else out.push([t, l]); };
    String(text || '').split(/([A-Za-z][A-Za-z'-]*)/).forEach((part, i) => {
      if (!part) return;
      if (i % 2 === 0) { push(part, ''); return; }
      if (FILLER_RE.test(part)) { FILLER_RE.lastIndex = 0; push(part, 'f'); return; }
      FILLER_RE.lastIndex = 0;
      const hit = cefrReady() ? cefrWord(part.toLowerCase()) : null;
      push(part, hit && CONTENT_POS[hit.pos] && LV[hit.level] ? hit.level : '');
    });
    return out;
  };
  const lexOf = (text, q) => { try { return typeof LexCoach !== 'undefined' ? LexCoach.analyze(text, q) : null; } catch (e) { return null; } };
  const colloc = a => a ? {
    level: a.level ? a.level.label : '', mix: a.level ? a.level.pct : null,
    used: a.used.concat(a.ielts).map(u => ({ said: u.said, vi: u.vi || '' })).slice(0, 12),
    suggest: a.suggest.map(x => ({ word: x.word, options: x.options.map(o => o.phrase + (o.vi ? ' (' + o.vi + ')' : '')).slice(0, 3) })).slice(0, 6),
    overused: a.overused.map(o => ({ word: o.word, n: o.n, alts: o.alts.slice(0, 4) })).slice(0, 6),
    topic: (a.topic || []).map(t => ({ phrase: t.phrase, vi: t.vi || '', band: t.band || '' })).slice(0, 6)
  } : null;

  const all = A.langText || answered.map(r => r.studentAnswer).join(' ');
  const lex = (() => { try { return cefrProfile(all); } catch (e) { return null; } })();
  const gram = (() => { try { return grammarProfile(all); } catch (e) { return null; } })();
  const acc = (() => { try { return grammarErrorScan(all); } catch (e) { return null; } })();
  const st = sentStats(all);
  const GNAME = { presentCont: 'present continuous', pastCont: 'past continuous', presentPerfect: 'present perfect', pastPerfect: 'past perfect',
    perfectCont: 'perfect continuous', future: 'future forms', modal: 'modal verbs', passive: 'passive', conditional: 'conditionals',
    relativeClause: 'relative clauses', comparative: 'comparatives', superlative: 'superlatives', gerundInfin: 'gerund / infinitive patterns',
    linker: 'linking words', pastSimple: 'past simple' };
  const f = gram ? gram.features : {};
  const info = meta.info || A.testInfo || {};
  const t0 = meta.startTime || TS.t0 || A.t0;
  return {
    v: 1, kind: meta.kind || 'test', topic: meta.topic || '',
    startTime: t0, durationMin: meta.durationMin || Math.max(1, Math.round((Date.now() - new Date(t0)) / 60000)),
    bands: { overall: g.overall || '', fc: g.fc || '', lr: g.lr || '', gr: g.gr || '', p: g.p || '' }, graded: !!g.graded, gradedBy: g.gradedBy || '', gradeError: g.gradeError || '',
    parts: tsPartBands(answered), missing: info.missing || 0, total: info.total || answered.length, part2Secs: info.part2Secs || 0,
    profile: {
      words: st.words, uniqueWords: lex ? lex.uniqueWords : 0, sentences: st.sentences, perSentence: st.perSentence,
      contentWords: lex ? lex.counted : 0,
      cefrPct: lex ? lex.pct : null, cefrCounts: lex ? lex.counts : null,
      levelWords: lex ? { B1: lex.samples.B1, B2: lex.samples.B2, C1: lex.samples.C1, C2: lex.samples.C2 } : null,
      sentenceTypes: gram ? gram.sentences : null,
      grammarUsed: Object.keys(GNAME).filter(k => f[k] > 0).map(k => GNAME[k] + ' ×' + f[k]),
      grammarMissing: ['presentPerfect', 'conditional', 'relativeClause', 'passive', 'comparative', 'pastPerfect'].filter(k => !f[k]).map(k => GNAME[k]),
      tenseVariety: f.tenseVariety || 0,
      prosody: A.prosody ? { wpm: A.prosody.wpm, pauses: A.prosody.pauses, longPauses: A.prosody.longPauses, longestPause: A.prosody.longestPause,
        silencePct: A.prosody.silencePct, mlr: A.prosody.mlr } : null,
      accuracy: acc ? acc.findings.slice(0, 10).map(x => ({ said: x.snippet.trim(), fix: x.fix, type: x.type })) : [],
      colloc: colloc(lexOf(all, ''))
    },
    report: rpt || null,
    answers: answered.map(r => {
      const s2 = sentStats(r.studentAnswer);
      const lx = (() => { try { return cefrProfile(r.studentAnswer); } catch (e) { return null; } })();
      const sec = Math.round(r._dur || r.secs || 0);
      return {
        part: r.part, topic: r.topic || '', question: String(r.question || '').replace(/^\[[^\]]*\]\s*/, ''),
        label: r.part === 'part1' ? 'Part 1 · ' + r.topic : r.part === 'part2' ? 'Part 2 · Long turn' : r.part === 'jam' ? 'JAM · ' + r.topic : 'Part 3',
        segments: segments(r.studentAnswer), seconds: r.secs || 0,
        words: s2.words, sentences: s2.sentences, perSentence: s2.perSentence,
        wpm: sec ? Math.round(s2.words / sec * 60) : 0,
        b1plus: lx ? Math.round((lx.pct.B1 + lx.pct.B2 + lx.pct.C1 + lx.pct.C2) * 10) / 10 : null,
        overall: r.overall || '', scores: r.scores ? { fc: r.scores.fluency?.score, lr: r.scores.lexical?.score, gr: r.scores.grammar?.score, p: r.scores.pronunciation?.score } : null,
        errors: r.errors || [], suggestion: r.suggestion || '', natural: r.natural || '', logic: r.logic || null,
        vocab: colloc(lexOf(r.studentAnswer, r.question))
      };
    })
  };
}

// Band per part, for the results summary.
function tsPartBands(answered) {
  return ['part1', 'part2', 'part3'].map(k => {
    const v = answered.filter(r => r.part === k).map(r => parseFloat(r.overall) || 0).filter(Boolean);
    return { part: k, n: answered.filter(r => r.part === k).length, band: v.length ? Math.round(v.reduce((a, x) => a + x, 0) / v.length * 2) / 2 : '' };
  });
}
function tsResultsSummary(answered) {
  const info = A.testInfo || {};
  const bands = tsPartBands(answered);
  const p2 = info.part2Secs ? Math.floor(info.part2Secs / 60) + ':' + String(info.part2Secs % 60).padStart(2, '0') : '';
  return `<div class="card">
    <div class="card-title" style="margin-bottom:10px">Test Simulation — by part</div>
    <div class="crit-grid" style="grid-template-columns:repeat(3,1fr)">
      ${bands.map(b => `<div class="crit-box"><div class="crit-score">${b.band || '—'}</div><div class="crit-name">${b.part.replace('part', 'Part ')} · ${b.n} Q</div></div>`).join('')}
    </div>
    <div style="font-size:12px;color:var(--g600);margin-top:10px;line-height:1.7">
      ${p2 ? `Part 2 long turn: <strong>${p2}</strong>${info.part2Secs < 60 ? ' — under one minute; aim for the full two minutes.' : ''}<br>` : ''}
      ${info.missing ? `<span style="color:var(--red-d)">${info.missing} of ${info.total} answers were silent or could not be transcribed, so they are not marked.</span>` : `All ${info.total || answered.length} answers were marked.`}
    </div>
  </div>`;
}

function tsTeardown() {
  TS.on = false;
  Voice.stop();
  try { TS.stream?.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { TS.ac?.close(); } catch (e) {}
  TS.analyser = null; TS.ac = null;
  tsCloseStage();
}
function tsCloseStage() {
  document.removeEventListener('keydown', tsKey, true);
  document.getElementById('ts-stage')?.remove();
  document.body.classList.remove('ts-lock');
  try { if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {}
}
function tsExit() {
  if (!confirm('Exit the test? Nothing from this attempt will be saved.\nThoát bài thi? Lượt thi này sẽ không được lưu.')) return;
  TS.stopped = true;
  TS.waiters.splice(0).forEach(f => { try { f(); } catch (e) {} });
  tsTeardown();
  studentTab('practice');
}

// ── STYLES ──────────────────────────────────
function tsInjectStyles() {
  if (document.getElementById('ts-styles')) return;
  const s = document.createElement('style');
  s.id = 'ts-styles';
  s.textContent = `
.ts-box{margin-bottom:14px}
.ts-box-hd{display:flex;gap:12px;align-items:flex-start;margin-bottom:10px}
.ts-num{flex-shrink:0;width:30px;height:30px;border-radius:50%;background:var(--blue);color:var(--ink-on-accent);display:flex;align-items:center;justify-content:center;font-weight:800}
.ts-box-title{font-weight:700;color:var(--ink-strong)}
.ts-box-sub{font-size:12px;color:var(--g600);margin-top:2px;line-height:1.6}
.ts-box-sub code{font-size:11px;background:var(--g100);padding:1px 5px;border-radius:5px}
.ts-ta{width:100%;font-family:var(--f);font-size:14px;line-height:1.6;resize:vertical;min-height:110px}
.ts-status{font-size:12px;margin-top:8px;line-height:1.6}
.ts-status.ok{color:var(--green-d)} .ts-status.bad{color:var(--g500)}
.ts-errors{color:var(--red-d);font-size:13px;font-weight:600;margin:10px 0;line-height:1.7}
.ts-warn{color:var(--gold-d);font-weight:500}
.ts-tip{font-size:13px;color:var(--g700);line-height:1.7}
body.ts-lock{overflow:hidden}
#ts-stage{position:fixed;inset:0;z-index:9000;color:var(--ink-strong);display:flex;flex-direction:column;overflow-y:auto;
  background:radial-gradient(120% 55% at 50% 0%,rgba(var(--acc-rgb),.10),transparent 70%),radial-gradient(90% 45% at 50% 100%,rgba(var(--acc-rgb),.08),transparent 70%),var(--bg)}
.ts-top{border-bottom:1px solid var(--line);background:rgba(var(--acc-rgb),.03)}
.ts-top-in{max-width:760px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:14px 20px}
.ts-brand{display:flex;align-items:center;gap:12px;min-width:0}
.ts-brand-ic{flex-shrink:0;width:44px;height:44px;border-radius:14px;background:var(--blue);color:var(--ink-on-accent);display:flex;align-items:center;justify-content:center;box-shadow:0 6px 16px rgba(var(--acc-rgb),.3)}
.ts-brand-ic svg{width:22px;height:22px}
.ts-brand-t{font-weight:800;font-size:1.1rem;line-height:1.2;color:var(--ink-strong)}
.ts-brand-s{font-size:12px;color:var(--g500)}
.ts-exit{margin-left:auto;display:flex;align-items:center;gap:7px;background:var(--white);border:1px solid var(--line2);color:var(--g700);border-radius:12px;padding:9px 14px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.ts-exit svg{width:16px;height:16px}
.ts-exit:hover{color:var(--red);border-color:var(--red)}
.ts-body{flex:1;width:100%;max-width:760px;margin:0 auto;padding:22px 20px 40px;display:flex;flex-direction:column;align-items:center;gap:22px}
.ts-head{width:100%}
.ts-head-row{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.ts-part{flex-shrink:0;background:var(--blue);color:var(--ink-on-accent);font-weight:800;font-size:14px;border-radius:999px;padding:5px 14px}
.ts-part-sub{font-size:14px;font-weight:600;color:var(--g700);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ts-prog-txt{margin-left:auto;font-size:14px;font-weight:700;color:var(--g600);font-variant-numeric:tabular-nums;white-space:nowrap}
.ts-prog-bar{height:8px;background:rgba(var(--acc-rgb),.14);border-radius:6px;overflow:hidden}
.ts-prog-bar>div{height:100%;width:0;background:var(--blue);border-radius:6px;transition:width .4s}
.ts-alert{width:100%;background:var(--red-l);border:1px solid var(--red);color:var(--red-d);border-radius:12px;padding:12px 16px;font-size:13px;line-height:1.6}
.ts-examiner{width:100%;display:flex;gap:16px;align-items:center;background:var(--white);border:1px solid var(--line);border-radius:22px;padding:20px 22px;box-shadow:0 12px 32px rgba(0,0,0,.08)}
.ts-ex-ic{flex-shrink:0;width:58px;height:58px;border-radius:50%;background:var(--blue-l);display:flex;align-items:center;justify-content:center}
.ts-examiner.speaking .ts-ex-ic{animation:tsPulse 1s ease-in-out infinite}
.ts-ex-txt{min-width:0}
.ts-ex-lbl{font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--blue);margin-bottom:4px}
.ts-script{font-size:16px;line-height:1.65;color:var(--g700);min-height:24px}
.ts-cue{color:var(--g500);font-style:italic}
.ts-q{width:100%;font-family:var(--f);font-weight:800;font-size:clamp(1.5rem,5.6vw,2.2rem);line-height:1.3;letter-spacing:-.01em;color:var(--ink-strong);text-align:center;padding:4px 6px}
.ts-card{font-family:var(--f);font-weight:400;letter-spacing:0;text-align:left;background:var(--white);border:2px solid var(--blue-m);border-radius:18px;padding:22px 24px;font-size:1rem}
.ts-card-lbl{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--blue);margin-bottom:8px}
.ts-card-cue{font-family:var(--fs);font-size:clamp(1.2rem,2.8vw,1.6rem);font-weight:600;line-height:1.4;margin-bottom:10px}
.ts-card-pts{font-size:15px;line-height:1.8;color:var(--g700)}
.ts-mid{width:100%;display:flex;gap:20px;align-items:center;justify-content:center;flex-wrap:wrap}
.ts-ring{position:relative;width:150px;height:150px}
.ts-ring svg{width:100%;height:100%;transform:rotate(-90deg)}
.ts-ring-bg{fill:none;stroke:var(--g100);stroke-width:9}
.ts-ring-fg{fill:none;stroke:var(--blue);stroke-width:9;stroke-linecap:round;transition:stroke-dashoffset .25s linear}
.ts-ring-fg.low{stroke:var(--red)}
.ts-ring-in{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ts-ring-num{font-size:2.2rem;font-weight:800;color:var(--ink-strong);line-height:1}
.ts-ring-lbl{font-size:11px;color:var(--g500);margin-top:4px;text-transform:uppercase;letter-spacing:.08em}
.ts-notes{flex:1;min-width:260px;max-width:560px;display:grid;grid-template-columns:1fr 1fr;border:1.5px solid var(--ink-strong);border-radius:10px;overflow:hidden;background:var(--white)}
.ts-note{position:relative;display:block;border-right:1px solid var(--line2);border-bottom:1px solid var(--line2)}
.ts-note:nth-child(2n){border-right:none}.ts-note:nth-child(n+3){border-bottom:none}
.ts-note span{position:absolute;top:6px;left:10px;font-weight:700;font-size:15px;color:var(--ink-strong);pointer-events:none}
.ts-note textarea{display:block;width:100%;height:110px;border:none;outline:none;resize:none;background:transparent;color:var(--ink-strong);font:inherit;font-size:14px;line-height:1.5;padding:28px 10px 8px}
.ts-note textarea:focus{background:rgba(var(--acc-rgb),.05)}
.ts-card-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.ts-card-top .ts-card-lbl{margin:0}
.ts-card-btn{background:none;border:1px solid var(--line2);border-radius:999px;padding:4px 12px;font:inherit;font-size:12px;color:var(--g600);cursor:pointer}
.ts-card-gone{display:none;font-size:14px;color:var(--g500);font-style:italic}
.ts-card-hidden .ts-card-body{display:none}.ts-card-hidden .ts-card-gone{display:block}
.ts-recwrap{width:100%;display:flex;flex-direction:column;align-items:center;gap:18px}
.ts-div{width:100%;display:flex;align-items:center;gap:14px;color:var(--g500)}
.ts-div::before,.ts-div::after{content:"";flex:1;height:1px;background:var(--line2)}
.ts-div span{width:34px;height:34px;border-radius:50%;border:1px solid var(--line2);background:var(--white);display:flex;align-items:center;justify-content:center}
.ts-div svg{width:16px;height:16px}
.ts-rec{width:100%;max-width:440px;background:var(--white);border:1px solid var(--line);border-radius:20px;padding:14px 18px 16px;box-shadow:0 10px 28px rgba(0,0,0,.07)}
.ts-rec-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.ts-rec-on{display:flex;align-items:center;gap:8px;font-weight:700;color:var(--red)}
.ts-dot{width:10px;height:10px;border-radius:50%;background:var(--red);animation:tsBlink 1s infinite}
.ts-time{font-variant-numeric:tabular-nums;color:var(--g500);font-size:15px}
.ts-time b{color:var(--ink-strong)}
.ts-wave{height:44px;display:flex;align-items:center;gap:3px}
.ts-wave i{flex:1;height:100%;border-radius:3px;background:var(--red);opacity:.85;transform:scaleY(.12);transition:transform .07s linear}
.ts-mic{margin-top:10px;width:112px;height:112px;border-radius:50%;border:none;background:var(--red);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;
  box-shadow:0 0 0 12px rgba(226,93,116,.16),0 0 0 26px rgba(226,93,116,.07);animation:tsRing 1.8s ease-out infinite;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.ts-mic svg{width:44px;height:44px}
.ts-mic:disabled{opacity:.55;cursor:default}
.ts-recwrap.idle .ts-rec,.ts-recwrap.idle .ts-hint{display:none}
.ts-recwrap.idle .ts-mic{background:var(--g100);color:var(--g500);opacity:1;animation:none;box-shadow:0 0 0 12px rgba(var(--acc-rgb),.06)}
.ts-recwrap.idle .ts-mic-lbl{font-weight:600;font-size:14px;color:var(--g500)}
.ts-mic:not(:disabled):active{transform:scale(.94)}
.ts-mic-lbl{font-weight:800;font-size:1.1rem;color:var(--ink-strong);margin-top:6px}
.ts-hint{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--g600);background:var(--white);border:1px solid var(--line);border-radius:999px;padding:9px 16px;max-width:100%;line-height:1.45}
.ts-hint svg{flex-shrink:0;width:17px;height:17px;color:var(--blue)}
.ts-hint-touch{display:none}
@media (pointer:coarse){.ts-hint-key{display:none}.ts-hint-touch{display:inline}}
.ts-count{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);z-index:5}
.ts-count-n{font-size:clamp(5rem,20vw,11rem);font-weight:800;color:#fff;animation:tsPop 1s ease both}
.ts-count-n.go{color:var(--blue);font-size:clamp(3.5rem,13vw,7rem)}
.ts-confetti{position:fixed;inset:0;pointer-events:none;z-index:7}
.ts-congrats{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:6;padding:20px}
.ts-cg-card{background:var(--white);border-radius:22px;padding:30px 34px;text-align:center;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.ts-cg-ic{width:60px;height:60px;margin:0 auto 12px;border-radius:50%;background:var(--green-l);color:var(--green-d);display:flex;align-items:center;justify-content:center}
.ts-cg-ic svg{width:30px;height:30px}
.ts-cg-title{font-size:1.6rem;font-weight:800;color:var(--ink-strong)}
.ts-cg-sub{font-size:14px;color:var(--g600);margin-top:6px;line-height:1.6}
.ts-proc{font-size:12px;color:var(--g500);margin-top:14px}
@keyframes tsPop{0%{transform:scale(.4);opacity:0}25%{transform:scale(1.12);opacity:1}70%{transform:scale(1);opacity:1}100%{transform:scale(.9);opacity:0}}
@keyframes tsBlink{50%{opacity:.25}}
@keyframes tsRing{0%{box-shadow:0 0 0 0 rgba(226,93,116,.40),0 0 0 12px rgba(226,93,116,.16),0 0 0 26px rgba(226,93,116,.07)}100%{box-shadow:0 0 0 34px rgba(226,93,116,0),0 0 0 12px rgba(226,93,116,.16),0 0 0 26px rgba(226,93,116,.07)}}
@keyframes tsPulse{50%{box-shadow:0 0 0 8px rgba(var(--acc-rgb),.18)}}
@media (max-width:600px){.ts-top-in{padding:10px 16px}.ts-brand-ic{width:38px;height:38px;border-radius:12px}.ts-brand-ic svg{width:19px;height:19px}.ts-brand-t{font-size:1rem}.ts-exit{padding:8px 11px}
  .ts-body{padding:14px 16px 24px;gap:14px}.ts-head-row{margin-bottom:8px}.ts-examiner{padding:12px 14px;gap:12px;border-radius:18px}.ts-ex-ic{width:46px;height:46px}.ts-ex-ic svg{transform:scale(.85)}
  .ts-script{font-size:15px}.ts-part-sub{font-size:13px}.ts-ring{width:120px;height:120px}
  .ts-recwrap{gap:12px}.ts-rec{padding:12px 14px}.ts-rec-row{margin-bottom:8px}.ts-wave{height:34px}
  .ts-mic{margin-top:8px;width:96px;height:96px}.ts-mic svg{width:38px;height:38px}.ts-mic-lbl{margin-top:4px;font-size:1rem}.ts-hint{font-size:12px;padding:8px 14px}}
@media (max-width:600px) and (max-height:700px){.ts-div{display:none}}
`;
  document.head.appendChild(s);
}
