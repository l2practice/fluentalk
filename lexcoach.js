// ════════════════════════════════════════════
// LEXICAL COACH — vocabulary level + collocation feedback, no AI tokens.
//
// Data (same folder, loaded once in the background):
//   collocations.json  headword → { c:[{e,v}], e, v, n }   3,000 words A2–C2
//   ielts-vocab.json   item → { band, cefr, vi, collocations[], speaking_example, topics }
// Needs cefr-dict.js (CEFR_MAP, cefrOf, cefrLemma).
//
// LexCoach.load()            start loading; returns a promise (never rejects)
// LexCoach.ready(ms)         wait for the data, at most ms
// LexCoach.analyze(text, q)  feedback for one answer (q = the question)
// LexCoach.evidence(text)    short lines for the AI grading prompt
// ════════════════════════════════════════════
(function (global) {
  'use strict';

  let COL = null, IEL = null, INDEX = null, _loading = null;

  const LV = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
  const CONTENT = { noun: 1, verb: 1, adj: 1, adv: 1 };
  // Intensifiers make "very convenient" look like a collocation; it is not one.
  const WEAK = /^(very|really|so|quite|too|much|more|most|just|also|a|an|the|to|of|for|in|on|at|with|and|or|be|is|are|was|were|it|this|that)$/;
  const POSS = /^(my|your|his|her|its|our|their)$/;
  const ANY = /^(someone|somebody|something|sb|sth|sb's|sth's|one|someone's)$/;
  // Words in every question; they say nothing about the topic.
  const GENERIC = /^(be|is|are|was|were|am|been|being|describe|explain|say|tell|think|feel|felt|time|thing|people|person|like|way|kind|do|have|get|go|make|use|want|also|usually|often|why|what|when|where|how|who|which|you|your|would|could|should|there|some|any|many|much|lot|important|good|bad|place|day|year|life|answer|question|talk)$/;

  // Basic words learners lean on, with stronger replacements. Hand-picked:
  // the collocation list starts at A2 and does not cover these.
  const BASIC = {
    good: ['beneficial', 'rewarding', 'worthwhile', 'enjoyable'],
    bad: ['harmful', 'unpleasant', 'disappointing', 'serious'],
    big: ['huge', 'enormous', 'substantial', 'spacious'],
    small: ['tiny', 'compact', 'minor', 'modest'],
    nice: ['pleasant', 'charming', 'delightful', 'welcoming'],
    beautiful: ['stunning', 'picturesque', 'breathtaking', 'gorgeous'],
    happy: ['delighted', 'thrilled', 'content', 'cheerful'],
    sad: ['upset', 'heartbroken', 'disappointed', 'down'],
    interesting: ['fascinating', 'intriguing', 'eye-opening', 'gripping'],
    important: ['essential', 'crucial', 'vital', 'significant'],
    very: ['extremely', 'incredibly', 'remarkably', 'particularly'],
    like: ['enjoy', 'be keen on', 'be fond of', 'be into'],
    thing: ['aspect', 'feature', 'issue', 'factor'],
    many: ['numerous', 'a wide range of', 'plenty of', 'countless'],
    think: ['believe', 'reckon', 'feel that', 'in my view'],
    difficult: ['challenging', 'demanding', 'tough', 'tricky'],
    easy: ['straightforward', 'effortless', 'simple', 'manageable'],
    funny: ['hilarious', 'amusing', 'entertaining', 'witty'],
    old: ['ancient', 'historic', 'traditional', 'elderly'],
    new: ['modern', 'brand-new', 'up-to-date', 'innovative'],
    help: ['assist', 'support', 'benefit', 'contribute to'],
    get: ['obtain', 'receive', 'gain', 'achieve'],
    use: ['make use of', 'rely on', 'take advantage of', 'apply']
  };
  const BASIC_MIN = { very: 3, like: 3, think: 3, get: 3, use: 3, many: 3, thing: 2 };

  // Question words that point to an IELTS topic but rarely appear inside the
  // vocabulary items themselves. Matched against topic names by first word.
  const TOPIC_HINTS = {
    hometown: 'Cities', city: 'Cities', town: 'Cities', building: 'Cities', neighbourhood: 'Cities', neighborhood: 'Cities', house: 'Cities', home: 'Cities', apartment: 'Cities', place: 'Cities', village: 'Cities',
    festival: 'History', tradition: 'History', celebrate: 'History', holiday: 'History', history: 'History', historical: 'History', custom: 'History',
    job: 'Work', work: 'Work', office: 'Work', career: 'Work', colleague: 'Work', boss: 'Work', appointment: 'Work', meeting: 'Work',
    trip: 'Travel', travel: 'Travel', journey: 'Travel', holidays: 'Travel', tourist: 'Travel', visit: 'Travel', abroad: 'Travel',
    bicycle: 'Transport', bike: 'Transport', car: 'Transport', bus: 'Transport', traffic: 'Transport', transport: 'Transport', late: 'Transport',
    shop: 'Fashion', shopping: 'Fashion', clothes: 'Fashion', buy: 'Fashion', store: 'Fashion', fashion: 'Fashion',
    food: 'Food', cook: 'Food', meal: 'Food', restaurant: 'Food', eat: 'Food', dish: 'Food',
    family: 'Family', friend: 'Family', parent: 'Family', relative: 'Family', sibling: 'Family',
    society: 'Social', contribute: 'Social', poor: 'Social', help: 'Social', volunteer: 'Social', charity: 'Social',
    story: 'Art', book: 'Art', film: 'Art', movie: 'Art', painting: 'Art', art: 'Art', music: 'Art', song: 'Art', creative: 'Art',
    animal: 'Animals', pet: 'Animals', wildlife: 'Animals', zoo: 'Animals',
    technology: 'Technology', invention: 'Technology', computer: 'Technology', phone: 'Technology', app: 'Technology',
    internet: 'Internet', online: 'Internet', website: 'Internet', social: 'Internet',
    school: 'Education', study: 'Education', student: 'Education', teacher: 'Education', learn: 'Education', university: 'Education',
    sport: 'Sport', exercise: 'Sport', game: 'Sport', team: 'Sport', hobby: 'Sport',
    health: 'Health', doctor: 'Health', ill: 'Health', medicine: 'Health',
    weather: 'Weather', rain: 'Weather', season: 'Weather',
    environment: 'Environment', pollution: 'Environment', plant: 'Environment', nature: 'Environment', tree: 'Environment',
    science: 'Science', scientific: 'Science', discovery: 'Science', research: 'Science',
    child: 'Children', childhood: 'Memory', memory: 'Memory', skill: 'Memory', remember: 'Memory',
    advertisement: 'Media', news: 'Media', newspaper: 'Media', advertising: 'Media',
    language: 'Language', english: 'Language', communicate: 'Language',
    money: 'Economy', price: 'Economy', expensive: 'Economy', business: 'Business', company: 'Business'
  };

  // Stable shuffle key: the same question always gets the same suggestions,
  // different questions on one topic get different ones.
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  function lem(w) {
    const r = typeof cefrLemma === 'function' ? cefrLemma(w) : null;
    return r || w;
  }
  // "learned", "interested", "working": the list has some of these as their
  // own adjective/noun at a higher level ("learned" = scholarly, B2). Spoken
  // learners almost always mean the verb, so the verb wins when it exists.
  function info(w) {
    if (typeof cefrOf !== 'function') return null;
    const h = cefrOf(w);
    const m = /^(.{2,}?)(ed|ing)$/.exec(w);
    if (h && m && h.lemma === w) {
      const bases = m[2] === 'ed' ? [m[1], m[1] + 'e', m[1].replace(/i$/, 'y')] : [m[1], m[1] + 'e'];
      for (const b of bases) {
        const v = typeof CEFR_MAP !== 'undefined' && CEFR_MAP[b];
        if (v && /^\dv/.test(String(v).split('|').find(c => c[1] === 'v') || '')) {
          const code = String(v).split('|').find(c => c[1] === 'v');
          return { level: ['', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'][+code[0]], pos: 'verb', lemma: b, allPos: ['verb'] };
        }
      }
    }
    return h;
  }
  function isContent(w) { const h = info(w); return !!(h && CONTENT[h.pos]); }
  // Hyphens split words, so "work-life balance" shares "work" with a question.
  function toks(s) { return String(s || '').toLowerCase().replace(/-/g, ' ').match(/[a-z][a-z']*/g) || []; }
  // Split on sentence ends so a phrase never matches across two sentences.
  function sentences(text) {
    return String(text || '').split(/[.!?;:\n]+/).map(toks).filter(t => t.length);
  }

  // A phrase as a list of matchers; tokens "one's", "sb", "sth" stand for any word.
  function compile(phrase) {
    // Articles are optional: "make a decision" also matches "make the decision".
    const words = toks(phrase).filter(w => !/^(a|an|the)$/.test(w));
    if (words.length < 2) return null;
    let contentN = 0;
    const parts = words.map(w => {
      if (POSS.test(w) || /^(one's|someone's|sb's)$/.test(w)) return { poss: 1 };
      if (ANY.test(w)) return { any: 1 };
      if (!WEAK.test(w) && isContent(w)) contentN++;
      return { w, l: lem(w) };
    });
    if (contentN < 2) return null;              // "able to", "very convenient": not collocations
    return parts;
  }

  // Match a compiled phrase in one sentence; up to two extra words may sit
  // between two parts ("play an important role" for "play a role").
  function matchIn(sent, lems, parts) {
    const first = parts[0];
    for (let i = 0; i < sent.length; i++) {
      if (!same(sent[i], lems[i], first)) continue;
      let j = i + 1, ok = true;
      for (let k = 1; k < parts.length; k++) {
        if (j < sent.length && same(sent[j], lems[j], parts[k])) { j++; continue; }
        if (j + 1 < sent.length && same(sent[j + 1], lems[j + 1], parts[k])) { j += 2; continue; }
        if (j + 2 < sent.length && same(sent[j + 2], lems[j + 2], parts[k])) { j += 3; continue; }
        ok = false; break;
      }
      if (ok) return sent.slice(i, j).join(' ');
    }
    return '';
  }
  function same(tok, l, p) {
    if (p.any) return true;
    if (p.poss) return POSS.test(tok);
    return tok === p.w || l === p.l;
  }

  function buildIndex() {
    INDEX = { byLemma: {}, heads: {} };
    const add = (phrase, entry) => {
      const parts = compile(phrase);
      if (!parts) return;
      const item = Object.assign({ phrase, parts }, entry);
      parts.forEach(p => {
        if (!p.l || WEAK.test(p.w)) return;
        (INDEX.byLemma[p.l] = INDEX.byLemma[p.l] || []).push(item);
      });
    };
    Object.keys(COL || {}).forEach(head => {
      const e = COL[head];
      INDEX.heads[head] = e;
      (e.c || []).forEach(c => add(c.e, { vi: c.v || '', head, src: 'col' }));
    });
    Object.keys(IEL || {}).forEach(key => {
      const e = IEL[key];
      add(key, { vi: e.vi || '', head: key, src: 'ielts', band: e.band || '', cefr: e.cefr || '' });
      (e.collocations || []).forEach(c => add(c, { vi: '', head: key, src: 'ielts', band: e.band || '', cefr: e.cefr || '' }));
    });
  }

  function load() {
    if (_loading) return _loading;
    const get = f => fetch(f, { cache: 'force-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);
    _loading = Promise.all([get('collocations.json'), get('ielts-vocab.json')]).then(([c, v]) => {
      COL = c || {}; IEL = v || {};
      try { buildIndex(); } catch (e) { INDEX = null; console.warn('LexCoach index failed', e); }
      return !!INDEX;
    });
    return _loading;
  }
  function ready(ms) {
    if (INDEX) return Promise.resolve(true);
    return Promise.race([load(), new Promise(r => setTimeout(() => r(false), ms || 3000))]);
  }
  function isReady() { return !!INDEX; }

  // ── one answer ────────────────────────────
  function analyze(text, question) {
    const out = { level: null, top: [], used: [], ielts: [], suggest: [], overused: [], topic: [] };
    const sents = sentences(text);
    const all = [].concat(...sents);
    if (!all.length || typeof cefrOf !== 'function') return out;

    // Level profile over content-word types (same rule as cefrProfile).
    const seen = new Set(), byLv = { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0, C2: 0 }, top = [];
    const freq = {};
    all.forEach(w => {
      const h = info(w);
      if (!h || !CONTENT[h.pos]) return;
      freq[h.lemma] = (freq[h.lemma] || 0) + 1;
      if (seen.has(h.lemma)) return;
      seen.add(h.lemma);
      if (byLv[h.level] !== undefined) byLv[h.level]++;
      if (LV[h.level] >= 4) top.push({ w: h.lemma, level: h.level });
    });
    const n = seen.size;
    const pct = L => n ? Math.round(byLv[L] / n * 100) : 0;
    const b1 = pct('B1'), b2p = pct('B2') + pct('C1') + pct('C2');
    let label, advice;
    if (n < 8) { label = 'too short to judge'; advice = 'Say more — at least 3–4 sentences — so your vocabulary can show.'; }
    else if (b2p >= 12) { label = 'B2+ range (supports Band 7 for Lexical Resource if used accurately)'; advice = 'Keep it natural: precise collocations matter more now than rarer words.'; }
    else if (b2p >= 5 || b1 >= 15) { label = 'B1–B2 range (around Band 6)'; advice = 'Add 2–3 topic-specific B2 words or collocations per answer to move towards Band 7.'; }
    else if (b1 >= 5) { label = 'mostly A2–B1 (around Band 5–5.5)'; advice = 'Too many everyday words. Replace a few with more precise B1–B2 words.'; }
    else { label = 'mostly A1–A2 (Band 5 or below)'; advice = 'Almost every word is basic. Learn the collocations below and reuse them next attempt.'; }
    out.level = { label, advice, n, pct: { A: pct('A1') + pct('A2'), B1: b1, B2plus: b2p } };
    out.top = top.sort((a, b) => LV[b.level] - LV[a.level]).slice(0, 8);

    if (!INDEX) return out;

    // Lemmas per sentence, then every phrase that shares a content word.
    const lemSents = sents.map(s => s.map(lem));
    const lemSet = new Set([].concat(...lemSents));
    const cands = new Map();
    lemSet.forEach(l => (INDEX.byLemma[l] || []).forEach(it => cands.set(it.phrase + '|' + it.head, it)));
    const usedHeads = new Set(), usedKeys = new Set();
    cands.forEach(it => {
      for (let s = 0; s < sents.length; s++) {
        const hit = matchIn(sents[s], lemSents[s], it.parts);
        if (!hit) continue;
        // Every headword inside the phrase counts as used ("golden opportunity"
        // covers both golden and opportunity), so none of them is re-suggested.
        usedHeads.add(it.head);
        it.parts.forEach(p => { if (p.l && INDEX.heads[p.l]) usedHeads.add(p.l); });
        const key = it.phrase.toLowerCase();
        if (usedKeys.has(key)) break;
        usedKeys.add(key);
        (it.src === 'ielts' ? out.ielts : out.used).push({ phrase: it.phrase, said: hit, vi: it.vi, band: it.band || '' });
        break;
      }
    });
    out.used = out.used.slice(0, 8);
    out.ielts = out.ielts.slice(0, 6);

    // Words the student used on their own: offer one collocation each.
    // Most-used first; A2–B1 words first, since those are the ones to upgrade.
    const heads = Object.keys(freq).filter(l => INDEX.heads[l] && !usedHeads.has(l));
    heads.sort((a, b) => (freq[b] - freq[a]) || ((LV[(info(a) || {}).level] || 9) - (LV[(info(b) || {}).level] || 9)));
    // Options that share a word with the answer or the question come first,
    // so "broken laptop" is not answered with "broken heart" when a better fit exists.
    const ctx = new Set(lemSet);
    toks(question).forEach(w => ctx.add(lem(w)));
    heads.slice(0, 4).forEach(h => {
      // The option must contain the word itself ("convenient location", not
      // "convenience store" listed under convenient).
      const list = (INDEX.heads[h].c || []).filter(c => compile(c.e) && toks(c.e).map(lem).indexOf(h) >= 0).map((c, i) => {
        const others = toks(c.e).map(lem).filter(l => l !== h && !WEAK.test(l));
        return { c, i, fit: others.some(l => ctx.has(l)) ? 1 : 0 };
      });
      if (!list.length) return;
      list.sort((a, b) => b.fit - a.fit || a.i - b.i);
      const pick = list.slice(0, 2).map(x => x.c);
      out.suggest.push({ word: h, level: (info(h) || {}).level || '', options: pick.map(c => ({ phrase: c.e, vi: c.v || '' })),
                         example: INDEX.heads[h].e || '', exampleVi: INDEX.heads[h].v || '' });
    });

    // Basic words repeated.
    const lemFreq = {};
    all.forEach(w => { const l = BASIC[w] ? w : lem(w); lemFreq[l] = (lemFreq[l] || 0) + 1; });
    Object.keys(BASIC).forEach(w => {
      const c = lemFreq[w] || 0;
      if (c >= (BASIC_MIN[w] || 2)) out.overused.push({ word: w, n: c, alts: BASIC[w] });
    });
    out.overused.sort((a, b) => b.n - a.n);
    out.overused = out.overused.slice(0, 4);

    // IELTS vocabulary for the question's topic, not already used.
    const qL = new Set(toks(question).filter(w => !GENERIC.test(w) && isContent(w)).map(lem).filter(l => !GENERIC.test(l)));
    if (qL.size && IEL) {
      // Vote for one of the IELTS topics (ielts-vocab.json "topics"): every
      // item that contains a question word votes for its topics, 2 if the word
      // is in the item itself, 1 if only in one of its collocations, +1 for a
      // B1+ question word ("discovery" says more than "store"). Suggestions then
      // come only from the winning topic, so they always fit the question.
      const votes = {}, hitOf = {};
      // The topic names themselves, and the hint words, vote strongest.
      const topicNames = {};
      Object.keys(IEL).forEach(k => (IEL[k].topics || []).forEach(t => { topicNames[t] = 1; }));
      const qAll = new Set(toks(question).map(lem));
      Object.keys(topicNames).forEach(t => {
        const nameWords = toks(t).map(lem);
        qAll.forEach(l => {
          if (GENERIC.test(l) && !TOPIC_HINTS[l]) return;
          if (nameWords.indexOf(l) >= 0) votes[t] = (votes[t] || 0) + 4;
          if (TOPIC_HINTS[l] && t.indexOf(TOPIC_HINTS[l]) === 0) votes[t] = (votes[t] || 0) + 4;
        });
      });
      Object.keys(IEL).forEach(k => {
        const e = IEL[k];
        const own = toks(k).map(lem), col = toks((e.collocations || []).join(' ')).map(lem);
        let s = 0;
        qL.forEach(l => {
          const rare = LV[(info(l) || {}).level] >= 3 ? 1 : 0;
          if (own.indexOf(l) >= 0) s += 2 + rare; else if (col.indexOf(l) >= 0) s += 1 + rare;
        });
        if (!s) return;
        hitOf[k] = s;
        (e.topics || []).forEach(t => { votes[t] = (votes[t] || 0) + s; });
      });
      const best = Object.keys(votes).sort((x, y) => votes[y] - votes[x])[0];
      const scored = !best || votes[best] < 2 ? [] : Object.keys(IEL)
        .filter(k => !usedHeads.has(k) && (IEL[k].topics || []).indexOf(best) >= 0 && IEL[k].use !== 'writing')
        .map(k => ({ k, e: IEL[k], s: hitOf[k] || 0 }))
        .sort((x, y) => y.s - x.s || (y.e.use === 'speaking') - (x.e.use === 'speaking') || hash(question + x.k) - hash(question + y.k));
      out.topicName = best && scored.length ? best : '';
      out.topic = scored.slice(0, 3).map(x => ({ phrase: x.k, vi: x.e.vi || '', band: x.e.band || '',
        example: x.e.speaking_example || '', exampleVi: x.e.speaking_vi || '' }));
    }
    return out;
  }

  // ── lines for the AI grading prompt ───────
  function evidence(text) {
    if (!INDEX) return '';
    const a = analyze(text, '');
    const lines = [];
    const used = a.used.concat(a.ielts).map(u => '"' + u.said + '"');
    lines.push('COLLOC dictionary collocations found in the transcript: ' + (used.length ? used.join(', ') : 'NONE'));
    if (a.suggest.length)
      lines.push('  words used without a typical collocation: ' + a.suggest.map(s => s.word + ' (e.g. ' + s.options[0].phrase + ')').join('; '));
    if (a.overused.length)
      lines.push('  basic words repeated: ' + a.overused.map(o => o.word + ' x' + o.n).join(', '));
    return lines.join('\n');
  }

  global.LexCoach = { load, ready, isReady, analyze, evidence, cefr: info };
})(window);
