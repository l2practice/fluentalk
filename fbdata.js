// ════════════════════════════════════════════
// fbdata.js — Firestore data layer for the Speaking App
//
// Every action the page used to send to Apps Script is answered here, in the
// same shape ({ success, data, ... }) the page already expects, so the UI code
// did not have to change. Only account operations (create / password), Google
// Doc export, Google Sheet export and emails still go to Apps Script, because
// those need admin rights or Google services the browser does not have.
//
// Collections (see firestore.rules):
//   users/{uid}            profile: studentId, fullName, email, classId, dob, phone, role, status
//   loginIndex/{sha256}    sha256(lowercased email) → { sid }  (sign in with email)
//   classes/{ClassID}      ClassID, ClassName, AcademicYear, Semester, TeacherName, Status, CreatedAt
//   assignments/{AssignID} Title, Part, Questions(JSON), Deadline(ISO), AssignedClasses, classes[], Status,
//                          ext: { classes: {ClassID: ISO}, students: {uid: ISO} }
//   library/{LibID}        Title, Part, Questions(JSON), Tags, CreatedAt, UsedCount
//   settings/public        ScoreAdjust                      settings/teacher  TeacherEmail, …
//   progress/{uid}         StudentID, StudentName, ClassID, items: { SessionID: light row }
//   sessions/{SessionID}   full attempt (same fields as the old Sessions sheet) + uid
//   classStats/{ClassID}   topics: { key: { topic, part, total, last, students: { uid: {name,count,last} } } }
//   extensionRequests/{id} uid, studentId, name, classId, assignId, title, reason, until, status
// ════════════════════════════════════════════
(function () {
'use strict';

// Firebase console → Project settings → Your apps → Web app → firebaseConfig.
// It is public by design; access is controlled by firestore.rules.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAeB-tcXD9QOkppW4oshpFI4aXe9T33kws',
  authDomain: 'fluentalk-f2ed4.firebaseapp.com',
  projectId: 'fluentalk-f2ed4',
  storageBucket: 'fluentalk-f2ed4.firebasestorage.app',
  messagingSenderId: '298459732541',
  appId: '1:298459732541:web:c9372297de253f7f01e854'
};
// Sign-in names. Students sign in with their Student ID (or email, looked up
// through loginIndex); Firebase Auth needs an email, so each account uses this
// fixed form. Must match STUDENT_DOMAIN / TEACHER_EMAIL in Code.gs.
const STUDENT_DOMAIN = 'students.fluentalk.app';
const TEACHER_EMAIL  = 'teacher@fluentalk.app';

const MILESTONES = [3,5,8,10,13,15,18,20,23,25,28,30];

let fs = null, auth = null, FV = null, _authReady = null;
function init() {
  if (fs) return;
  firebase.initializeApp(window.__FB_CONFIG || FIREBASE_CONFIG);
  fs = firebase.firestore();
  auth = firebase.auth();
  if (window.__FB_EMU) { auth.useEmulator('http://127.0.0.1:9099'); fs.useEmulator('127.0.0.1', 8080); }   // local tests only
  FV = firebase.firestore.FieldValue;
  _authReady = new Promise(res => { const off = auth.onAuthStateChanged(u => { off(); res(u); }); });
}
function authReady() { init(); return _authReady; }

// ── small helpers ───────────────────────────
// Firebase refuses passwords under 6 characters; older accounts may have one.
// Every place that sets or checks a password pads it the same way (Code.gs too).
function authPw(p) { p = String(p == null ? '' : p); return p.length >= 6 ? p : (p + '______').slice(0, 6); }
function loginEmailFor(studentId) {
  return String(studentId).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_') + '@' + STUDENT_DOMAIN;
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function genId(n) {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < (n || 12); i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function ok(extra) { return Object.assign({ success: true }, extra || {}); }
function fail(msg) { return { success: false, error: msg }; }
function up(s) { return String(s == null ? '' : s).trim().toUpperCase(); }
function low(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
const docs = qs => qs.docs.map(d => Object.assign({ _id: d.id }, d.data()));

// Deadline → Date. ISO with time is exact; a bare yyyy-mm-dd (older data)
// means the end of that day, local time.
function parseDeadline(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59) : new Date(s);
  return isNaN(d) ? null : d;
}
// The deadline that applies to one student: the latest of the assignment's own
// deadline, an extension for their class, and an extension for them.
function effectiveDeadline(a, classId, uid) {
  const ext = a.ext || {};
  const cands = [a.Deadline, ext.classes && ext.classes[up(classId)], ext.students && ext.students[uid]]
    .map(parseDeadline).filter(Boolean);
  if (!cands.length) return null;
  return new Date(Math.max.apply(null, cands.map(d => d.getTime())));
}
function iso(d) { return d ? d.toISOString() : ''; }

// ── current user ────────────────────────────
let _me = null;          // { uid, ...users doc }
async function me() {
  await authReady();                 // first auth state restored (page reload)
  const u = auth.currentUser;        // …then whoever is signed in now
  if (!u) throw new Error('SESSION_EXPIRED');
  if (_me && _me.uid === u.uid) return _me;
  if (u.email === TEACHER_EMAIL) return (_me = { uid: u.uid, role: 'Teacher' });
  const d = await fs.doc('users/' + u.uid).get();
  if (!d.exists) throw new Error('SESSION_EXPIRED');
  return (_me = Object.assign({ uid: u.uid }, d.data()));
}
function isTeacherUser(u) { return u && u.email === TEACHER_EMAIL; }

// ── same rules as Code.gs: which rows belong to one task, how many attempts ──
function isJamRow(s) { return String(s.Type) === 'jam' || String(s.Part) === 'jam'; }
function sameTask(s, p) {
  const assignId = String(p.assignId || '').trim();
  if (assignId) return String(s.AssignID || '').trim() === assignId;
  if (String(s.AssignID || '').trim()) return false;
  if (low(s.Topic) !== low(p.topic)) return false;
  const wantJam = String(p.type) === 'jam' || String(p.part) === 'jam';
  return isJamRow(s) === wantJam;
}
function attemptsSoFar(rows) {
  let maxNo = 0;
  rows.forEach(s => { const n = parseInt(s.AttemptNo) || 0; if (n > maxNo) maxNo = n; });
  return Math.max(maxNo, rows.length);
}
const byStart = (a, b) => String(a.StartTime || '').localeCompare(String(b.StartTime || ''));
function itemsOf(progDoc) { return Object.values((progDoc && progDoc.items) || {}).sort(byStart); }

// ── short-lived memo for teacher lists (one page visit re-reads them a lot) ──
const _memo = {};
async function memo(key, ttl, fn) {
  const h = _memo[key];
  if (h && Date.now() - h.t < ttl) return h.v;
  const v = await fn();
  _memo[key] = { t: Date.now(), v };
  return v;
}
function forget(prefix) { Object.keys(_memo).forEach(k => { if (!prefix || k.indexOf(prefix) === 0) delete _memo[k]; }); }
const allUsers       = () => memo('users', 60000, async () => docs(await fs.collection('users').get()));
const allClasses     = () => memo('classes', 60000, async () => docs(await fs.collection('classes').get()));
const allAssignments = () => memo('assignments', 60000, async () => docs(await fs.collection('assignments').get()));
const allLibrary     = () => memo('library', 60000, async () => docs(await fs.collection('library').get()));
async function progressDocs(classId) {
  const q = classId ? fs.collection('progress').where('ClassID', '==', up(classId)) : fs.collection('progress');
  return memo('progress|' + up(classId), 30000, async () => docs(await q.get()));
}
async function classNameOf(classId) {
  const c = (await allClasses()).find(x => up(x.ClassID) === up(classId));
  return c ? String(c.ClassName || c.ClassID) : up(classId);
}
function studentRow(u) {
  return { StudentID: String(u.studentId || ''), FullName: String(u.fullName || ''), ClassID: String(u.classId || ''),
           Email: String(u.email || ''), Phone: String(u.phone || ''), DOB: String(u.dob || ''),
           Status: String(u.status || 'Active'), RegisteredAt: String(u.registeredAt || ''), _uid: u._id || u.uid };
}

// ════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════
async function login(p) {
  init();
  const id = String(p.email || '').trim();
  if (!id) return fail('Please enter your Student ID or email.');
  let sid = id;
  if (id.indexOf('@') >= 0) {
    const idx = await fs.doc('loginIndex/' + await sha256Hex(low(id))).get();
    if (!idx.exists) return fail('Account not found.');
    sid = idx.data().sid;
  }
  try { await auth.signInWithEmailAndPassword(loginEmailFor(sid), authPw(p.password)); }
  catch (e) {
    const c = e.code || '';
    if (/too-many-requests/.test(c)) return fail('Too many attempts. Please wait a few minutes.');
    if (/network/.test(c)) return fail('Network error — check your connection and try again.');
    return fail('Incorrect Student ID / email or password.');
  }
  _me = null;
  const u = await me();
  if (u.role === 'Teacher' || !u.studentId) { await auth.signOut(); return fail('Account not found.'); }
  if (u.status === 'Archived') { await auth.signOut(); return fail('This account has been removed. Please contact your teacher.'); }
  const [cls, pub] = await Promise.all([fs.doc('classes/' + up(u.classId)).get(), fs.doc('settings/public').get()]);
  return ok({
    sessionToken: 'fb',
    scoreAdjust: parseFloat(pub.exists && pub.data().ScoreAdjust) || 0,
    user: { studentId: u.studentId, fullName: u.fullName, classId: u.classId || '',
            className: cls.exists ? (cls.data().ClassName || u.classId) : (u.classId || ''),
            email: u.email || '', phone: u.phone || '', dob: u.dob || '', role: 'Student' }
  });
}
async function teacherLogin(p) {
  init();
  try { await auth.signInWithEmailAndPassword(TEACHER_EMAIL, authPw(p.password)); }
  catch (e) { return fail(/too-many-requests/.test(e.code || '') ? 'Too many attempts. Please wait a few minutes.' : 'Incorrect password.'); }
  _me = null; forget();
  return ok({ teacherToken: 'fb-teacher' });
}
async function signOut() { init(); _me = null; forget(); try { await auth.signOut(); } catch (e) {} }
async function teacherChangePassword(p) {
  const u = auth.currentUser;
  try {
    await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(TEACHER_EMAIL, authPw(p.current)));
  } catch (e) { return fail('Current password is incorrect.'); }
  if (String(p.newPassword || '').length < 6) return fail('The new password must be at least 6 characters.');
  await u.updatePassword(authPw(p.newPassword));
  return ok();
}

// ════════════════════════════════════════════
// STUDENT
// ════════════════════════════════════════════
async function myRows() {
  const u = await me();
  const d = await fs.doc('progress/' + u.uid).get();
  return itemsOf(d.exists ? d.data() : null);
}
async function myAssignments() {
  const u = await me();
  const qs = await fs.collection('assignments').where('classes', 'array-contains-any', [up(u.classId), 'ALL']).get();
  return docs(qs);
}

async function getOverview() {
  const sessions = await myRows();
  const topics = {};
  sessions.forEach(s => {
    const t = s.Topic || 'Unknown';
    if (!topics[t]) topics[t] = { topic: t, part: s.Part, sessions: [], milestones: [] };
    topics[t].sessions.push(s);
    if (String(s.IsMilestone) === 'true' && s.Overall) topics[t].milestones.push(s);
  });
  const topicArr = Object.values(topics).map(t => {
    const scores = t.milestones.map(m => parseFloat(m.Overall) || 0).filter(Boolean);
    return {
      topic: t.topic, part: t.part, count: t.sessions.length,
      lastPractice: (t.sessions.slice(-1)[0] || {}).StartTime || '',
      scores: t.milestones.map(m => ({ attemptNo: m.AttemptNo, overall: m.Overall, fc: m.FC, lr: m.LR, gr: m.GR, p: m.P })),
      bestScore: scores.length ? Math.max.apply(null, scores) : null,
      latestScore: scores.length ? scores[scores.length - 1] : null
    };
  });
  return ok({ data: { topics: topicArr, totalSessions: sessions.length } });
}

async function getHomework() {
  const u = await me();
  const [asn, rows, reqs] = await Promise.all([
    myAssignments(), myRows(),
    fs.collection('extensionRequests').where('uid', '==', u.uid).get().then(docs)
  ]);
  const data = asn.filter(a => String(a.Status || 'Active') === 'Active').map(a => {
    const mine = rows.filter(s => String(s.AssignID) === String(a.AssignID));
    const req = reqs.filter(r => r.assignId === a.AssignID).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))[0];
    return Object.assign({}, a, {
      Deadline: iso(effectiveDeadline(a, u.classId, u.uid)),
      OriginalDeadline: iso(parseDeadline(a.Deadline)),
      myAttempts: mine.length,
      lastPractice: mine.length ? mine[mine.length - 1].StartTime : null,
      extRequest: req ? { status: req.status, until: req.until || '', decidedUntil: req.decidedUntil || '' } : null
    });
  }).sort((x, y) => String(x.Deadline || '9').localeCompare(String(y.Deadline || '9')));
  return ok({ data });
}

async function getMyHistory() {
  const u = await me();
  const [rows, asn] = await Promise.all([myRows(), myAssignments()]);
  const dl = {};
  asn.forEach(a => { dl[a.AssignID] = iso(effectiveDeadline(a, u.classId, u.uid)); });
  const light = rows.map(s => ({
    SessionID: s.SessionID, AssignID: s.AssignID, Topic: s.Topic, Part: s.Part, StartTime: s.StartTime,
    DurationMin: s.DurationMin, AttemptNo: s.AttemptNo, IsMilestone: s.IsMilestone,
    Overall: s.Overall, FC: s.FC, LR: s.LR, GR: s.GR, P: s.P, GradedBy: s.GradedBy,
    Deadline: s.AssignID ? (dl[s.AssignID] || '') : ''
  }));
  light.reverse();
  return ok({ data: light });
}

function statKey(topic) { return low(topic).slice(0, 200) || 'untitled'; }
async function getPeerComparison(p) {
  const u = await me();
  const [statDoc, rows, asn] = await Promise.all([
    fs.doc('classStats/' + up(u.classId)).get(), myRows(), myAssignments()
  ]);
  const topics = (statDoc.exists && statDoc.data().topics) || {};
  if (p && p.topicFilter) {
    const t = topics[statKey(p.topicFilter)];
    if (!t) return ok({ data: [], total: 0 });
    const members = Object.keys(t.students || {}).map(id => ({
      name: t.students[id].name, count: t.students[id].count, last: t.students[id].last, isMe: id === u.uid
    })).sort((a, b) => b.count - a.count);
    const offset = parseInt(p.offset) || 0, limit = parseInt(p.limit) || 10;
    return ok({ data: members.slice(offset, offset + limit), total: members.length });
  }
  const cutoff = (p && Number(p.sinceDays) > 0) ? Date.now() - Number(p.sinceDays) * 86400000 : 0;
  const dlByTopic = {};
  asn.forEach(a => {
    if (String(a.Status || 'Active') !== 'Active') return;
    const d = iso(effectiveDeadline(a, u.classId, u.uid));
    const k = statKey(a.Title);
    if (d && (!dlByTopic[k] || d > dlByTopic[k])) dlByTopic[k] = d;
  });
  const list = Object.keys(topics).map(k => {
    const t = topics[k];
    const mine = rows.filter(s => statKey(s.Topic) === k);
    const bands = mine.map(s => parseFloat(s.Overall)).filter(Boolean);
    return {
      topic: t.topic, part: t.part || 'part1', peerCount: Object.keys(t.students || {}).length,
      totalAttempts: t.total || 0, myAttempts: mine.length, myBest: bands.length ? Math.max.apply(null, bands) : null,
      lastPractice: t.last || '', deadline: dlByTopic[k] || ''
    };
  }).filter(t => !cutoff || new Date(t.lastPractice).getTime() >= cutoff)
    .sort((a, b) => String(b.lastPractice).localeCompare(String(a.lastPractice)));
  return ok({ data: list, className: await classNameOf(u.classId), classId: u.classId });
}

async function getJamTopics(p) {
  const part = (p && p.part) || 'part1';
  const lib = docs(await fs.collection('library').where('Part', '==', part).get());
  return ok({ data: lib.map(x => {
    let qs = []; try { qs = JSON.parse(x.Questions || '[]'); } catch (e) {}
    return { libId: x.LibID || x._id, title: x.Title, part: x.Part || 'part1', questionCount: qs.length };
  }) });
}

async function findExisting(p) {
  const existing = (await myRows()).filter(s => sameTask(s, p));
  if (!existing.length) return ok({ exists: false, pendingMilestone: false });
  const lastAttempt = attemptsSoFar(existing);
  const milestones = existing.filter(s => String(s.IsMilestone) === 'true');
  const latestScore = milestones.length ? milestones[milestones.length - 1].Overall : null;
  const byNo = existing.slice().sort((a, b) => (parseInt(a.AttemptNo) || 0) - (parseInt(b.AttemptNo) || 0));
  let pending = false;
  byNo.forEach((s, i) => {
    const no = parseInt(s.AttemptNo);
    if (MILESTONES.indexOf(no) >= 0 && !s.Overall) pending = !byNo.slice(i + 1).some(x => !!x.Overall);
    else if (s.Overall) pending = false;
  });
  return ok({ exists: true, attemptCount: lastAttempt, latestScore, pendingMilestone: pending });
}

// Save one attempt. One transaction: it numbers the attempt from the
// student's own record, so two saves can never take the same number, and a
// re-sent save (same SessionID) is recognised instead of counted twice.
async function saveResult(p) {
  const u = await me();
  const sid = String(p.clientSessionId || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || ('SESS-' + genId());
  const cid = up(u.classId);
  const progRef = fs.doc('progress/' + u.uid), sessRef = fs.doc('sessions/' + sid), statRef = fs.doc('classStats/' + (cid || '_none'));
  const res = await fs.runTransaction(async tx => {
    const snap = await tx.get(progRef);
    const items = (snap.exists && snap.data().items) || {};
    if (items[sid]) return ok({ sessionId: sid, duplicate: true, attemptNo: parseInt(items[sid].AttemptNo) || 0 });
    const attemptNo = attemptsSoFar(Object.values(items).filter(s => sameTask(s, p))) + 1;
    const isJam = String(p.type) === 'jam' || String(p.part) === 'jam';
    const isMilestone = (!isJam && (MILESTONES.indexOf(attemptNo) >= 0 || !!p.overall)) ? 'true' : 'false';
    const now = new Date().toISOString();
    const light = {
      SessionID: sid, StudentID: u.studentId, StudentName: u.fullName, ClassID: cid,
      AssignID: p.assignId || '', Topic: p.topic || '', Part: p.part || 'part1', Mode: p.mode || 'record',
      Type: p.type || 'homework', StartTime: p.startTime || now, EndTime: p.endTime || now,
      DurationMin: p.durationMin || 0, RetryCount: p.retryCount || 0, AttemptNo: attemptNo,
      IsMilestone: isMilestone, Overall: p.overall || '', FC: p.fc || '', LR: p.lr || '', GR: p.gr || '', P: p.p || '',
      GradedBy: p.gradedBy || ''
    };
    tx.set(sessRef, Object.assign({}, light, {
      uid: u.uid,
      QuestionsJSON: JSON.stringify(p.questionsJSON || []),
      ResultsJSON: JSON.stringify(p.resultsJSON || []),
      ReportText: String(p.reportText || '').substring(0, 4000),
      Analysis: JSON.stringify(p.analysis || null)
    }));
    tx.set(progRef, { StudentID: u.studentId, StudentName: u.fullName, ClassID: cid, items: { [sid]: light } }, { merge: true });
    if (cid) tx.set(statRef, {
      totalAllTime: FV.increment(1),
      topics: { [statKey(light.Topic)]: {
        topic: light.Topic, part: light.Part, total: FV.increment(1), last: light.StartTime,
        students: { [u.uid]: { name: u.fullName, count: FV.increment(1), last: light.StartTime } }
      } }
    }, { merge: true });
    return ok({ sessionId: sid, attemptNo, isMilestone: isMilestone === 'true' });
  });
  forget('progress');
  return res;
}

async function requestExtension(p) {
  const u = await me();
  const a = (await myAssignments()).find(x => x.AssignID === p.assignId);
  if (!a) return fail('Assignment not found.');
  const reason = String(p.reason || '').trim();
  if (reason.length < 5) return fail('Please give a short reason.');
  const until = parseDeadline(p.until);
  if (!until) return fail('Please choose the date and time you need.');
  const mine = docs(await fs.collection('extensionRequests').where('uid', '==', u.uid).get());
  if (mine.some(r => r.assignId === a.AssignID && r.status === 'pending'))
    return fail('Bạn đã có một yêu cầu gia hạn đang chờ duyệt cho bài này.');
  const ref = fs.collection('extensionRequests').doc();
  await ref.set({
    uid: u.uid, studentId: u.studentId, name: u.fullName, classId: up(u.classId),
    assignId: a.AssignID, title: a.Title || '', reason: reason.slice(0, 1000),
    currentDeadline: iso(effectiveDeadline(a, u.classId, u.uid)), until: iso(until),
    status: 'pending', createdAt: new Date().toISOString()
  });
  // Tell the teacher by email. A failed email does not undo the request:
  // it is in the teacher's list either way.
  try { await gas('notify.extensionRequest', { reqId: ref.id }); } catch (e) {}
  return ok({ reqId: ref.id });
}

// ════════════════════════════════════════════
// TEACHER
// ════════════════════════════════════════════
async function getClasses(p) {
  const [classes, users] = await Promise.all([allClasses(), allUsers()]);
  const active = {}, archived = {};
  users.forEach(u => {
    const cid = up(u.classId); if (!cid || u.role === 'Teacher') return;
    if (u.status === 'Archived') archived[cid] = (archived[cid] || 0) + 1; else active[cid] = (active[cid] || 0) + 1;
  });
  let list = classes.map(c => Object.assign({}, c, { StudentCount: active[up(c.ClassID)] || 0, ArchivedCount: archived[up(c.ClassID)] || 0 }));
  if (p && p.status) list = list.filter(c => String(c.Status) === p.status);
  list.sort((a, b) => String(a.CreatedAt || '').localeCompare(String(b.CreatedAt || '')));
  return ok({ data: list });
}
async function createClass(p) {
  const className = String(p.className || '').trim();
  if (!className) return fail('Class name cannot be empty.');
  const L = 'ABCDEFGHJKMNPQRSTUVWXYZ', N = '23456789';
  let code = '';
  for (let t = 0; t < 20; t++) {
    code = ''; for (let i = 0; i < 3; i++) code += L[Math.floor(Math.random() * L.length)];
    for (let j = 0; j < 3; j++) code += N[Math.floor(Math.random() * N.length)];
    if (!(await fs.doc('classes/' + code).get()).exists) break;
  }
  await fs.doc('classes/' + code).set({ ClassID: code, ClassName: className, AcademicYear: p.academicYear || '',
    Semester: p.semester || '', TeacherName: p.teacherName || '', Status: 'Active', CreatedAt: new Date().toISOString() });
  forget('classes');
  return ok({ classId: code, className });
}
async function setClassStatus(p) {
  const ref = fs.doc('classes/' + up(p.classId));
  if (!(await ref.get()).exists) return fail('Class not found.');
  await ref.update({ Status: p.status === 'Active' ? 'Active' : 'Archived' });
  forget('classes');
  return ok();
}
async function getStudents(p) {
  let list = (await allUsers()).filter(u => u.role !== 'Teacher' && u.studentId);
  if (p && p.classId) list = list.filter(u => up(u.classId) === up(p.classId));
  return ok({ data: list.map(studentRow) });
}
async function userByStudentId(studentId) {
  const qs = await fs.collection('users').where('studentId', '==', String(studentId)).limit(1).get();
  return qs.empty ? null : Object.assign({ _id: qs.docs[0].id }, qs.docs[0].data());
}
async function activateUser(p) {
  const u = await userByStudentId(p.studentId);
  if (!u) return fail('Student not found.');
  const patch = { status: p.status || 'Active' };
  if (p.classId) patch.classId = up(p.classId);
  await fs.doc('users/' + u._id).update(patch);
  if (patch.classId) await fs.doc('progress/' + u._id).set({ ClassID: patch.classId }, { merge: true });
  forget('users'); forget('progress');
  return ok();
}

function asnClasses(list) {
  const arr = (list || []).map(up).filter(Boolean);
  return arr.indexOf('ALL') >= 0 ? ['ALL'] : arr;
}
function deadlineIso(v) { return iso(parseDeadline(v)); }
async function getAssignments(p) {
  let rows = await allAssignments();
  if (p && p.status) rows = rows.filter(a => String(a.Status || 'Active') === p.status);
  if (p && p.classId) rows = rows.filter(a => (a.classes || []).indexOf('ALL') >= 0 || (a.classes || []).indexOf(up(p.classId)) >= 0);
  if (p && p.part) rows = rows.filter(a => String(a.Part || 'part1') === String(p.part));
  rows = rows.slice().sort((a, b) => String(b.CreatedAt || '').localeCompare(String(a.CreatedAt || '')));
  return ok({ data: rows });
}
async function writeAssignment(fields) {
  const id = fields.AssignID || ('ASN-' + genId());
  const classes = asnClasses(fields.classes);
  await fs.doc('assignments/' + id).set({
    AssignID: id, Title: fields.Title || '', Part: fields.Part || 'part1',
    Questions: typeof fields.Questions === 'string' ? fields.Questions : JSON.stringify(fields.Questions || []),
    Deadline: deadlineIso(fields.Deadline), AssignedClasses: classes.join(','), classes,
    CreatedAt: new Date().toISOString(), Status: 'Active', ext: { classes: {}, students: {} }
  });
  forget('assignments');
  return id;
}
async function createAssignment(p) {
  const id = await writeAssignment({ Title: p.title, Part: p.part, Questions: p.questions, Deadline: p.deadline, classes: p.assignedClasses });
  if (p.fromLibrary) await bumpLibraryUse(p.fromLibrary);
  if (p.saveToLibrary) await saveToLibrary({ title: p.title, part: p.part, questions: p.questions });
  return ok({ assignId: id });
}
async function deleteAssignment(p) {
  await fs.doc('assignments/' + p.assignId).delete();
  forget('assignments');
  return ok();
}
async function setAssignmentStatus(p) {
  await fs.doc('assignments/' + p.assignId).update({ Status: p.status === 'Archived' ? 'Archived' : 'Active' });
  forget('assignments');
  return ok();
}
async function updateAssignment(p) {
  const classes = asnClasses(p.classes);
  if (!classes.length) return fail('Select at least one class.');
  const ref = fs.doc('assignments/' + p.assignId);
  if (!(await ref.get()).exists) return fail('Assignment not found.');
  await ref.update({ Deadline: deadlineIso(p.deadline), AssignedClasses: classes.join(','), classes });
  forget('assignments');
  return ok();
}
async function relaunchAssignment(p) {
  const src = (await fs.doc('assignments/' + p.assignId).get()).data();
  if (!src) return fail('Assignment not found.');
  const id = await writeAssignment({ Title: src.Title, Part: src.Part, Questions: src.Questions, Deadline: p.deadline,
    classes: (p.classes && p.classes.length) ? p.classes : ['ALL'] });
  return ok({ assignId: id });
}

async function getLibrary(p) {
  let rows = await allLibrary();
  if (p && p.part) rows = rows.filter(l => String(l.Part || 'part1') === String(p.part));
  return ok({ data: rows.slice().sort((a, b) => String(a.CreatedAt || '').localeCompare(String(b.CreatedAt || ''))) });
}
async function saveToLibrary(p) {
  const title = String(p.title || '').trim();
  if (!title) return fail('A title is required.');
  const questions = Array.isArray(p.questions) ? p.questions : [];
  if (!questions.length) return fail('At least one question is required.');
  const same = (await allLibrary()).find(l => low(l.Title) === low(title) && String(l.Part) === String(p.part));
  if (same) {
    await fs.doc('library/' + same._id).update({ Questions: JSON.stringify(questions), Tags: p.tags || '' });
    forget('library');
    return ok({ libId: same.LibID || same._id, updated: true });
  }
  const libId = 'L' + genId();
  await fs.doc('library/' + libId).set({ LibID: libId, Title: title, Part: p.part || 'part1', Questions: JSON.stringify(questions),
    Tags: p.tags || '', CreatedAt: new Date().toISOString(), UsedCount: 0 });
  forget('library');
  return ok({ libId, updated: false });
}
async function deleteLibraryItem(p) {
  await fs.doc('library/' + p.libId).delete();
  forget('library');
  return ok();
}
async function bumpLibraryUse(libId) {
  try { await fs.doc('library/' + libId).update({ UsedCount: FV.increment(1) }); forget('library'); } catch (e) {}
}
async function launchFromLibrary(p) {
  const item = (await fs.doc('library/' + p.libId).get()).data();
  if (!item) return fail('Topic not found in the library.');
  const questions = Array.isArray(p.questions) ? p.questions : [];
  if (!questions.length) return fail('Select at least one question to launch.');
  const id = await writeAssignment({ Title: p.title || item.Title, Part: item.Part || 'part1', Questions: questions,
    Deadline: p.deadline, classes: (p.classes && p.classes.length) ? p.classes : ['ALL'] });
  await bumpLibraryUse(p.libId);
  return ok({ assignId: id });
}

async function getSettings() {
  const [a, b] = await Promise.all([fs.doc('settings/public').get(), fs.doc('settings/teacher').get()]);
  return ok({ data: Object.assign({}, b.exists ? b.data() : {}, a.exists ? a.data() : {}) });
}
async function saveSetting(p) {
  const doc = p.key === 'ScoreAdjust' ? 'settings/public' : 'settings/teacher';
  await fs.doc(doc).set({ [p.key]: p.value }, { merge: true });
  return ok();
}

function typeFilter(taskType) {
  return r => {
    const jam = isJamRow(r);
    if (taskType === 'jam') return jam;
    if (taskType === 'free') return String(r.Type) === 'free' && !jam;
    if (taskType === 'homework') return !jam && String(r.Type) !== 'free';
    return true;
  };
}
async function getAllSessions(p) {
  let rows = [];
  (await progressDocs(p && p.classId)).forEach(d => { rows = rows.concat(itemsOf(d)); });
  if (p && p.topic && p.topic !== '__ALL__') rows = rows.filter(r => low(r.Topic) === low(p.topic));
  if (p && p.taskType) rows = rows.filter(typeFilter(p.taskType));
  if (p && Number(p.sinceDays) > 0) {
    const cutoff = Date.now() - Number(p.sinceDays) * 86400000;
    rows = rows.filter(r => new Date(r.StartTime).getTime() >= cutoff);
  }
  const classes = await allClasses(), nameOf = {};
  classes.forEach(c => { nameOf[up(c.ClassID)] = c.ClassName || c.ClassID; });
  rows.sort(byStart).reverse();
  return ok({ data: rows.map(r => Object.assign({}, r, { ClassName: nameOf[up(r.ClassID)] || r.ClassID || '', QCount: '' })) });
}
async function getClassTopics(p) {
  const taskType = String(p.taskType || 'homework');
  if (taskType === 'homework') {
    const seen = {};
    (await allLibrary()).forEach(x => { const t = String(x.Title || '').trim(); if (t) seen[t] = true; });
    return ok({ data: Object.keys(seen).map(t => ({ topic: t, sessions: null, students: null }))
      .sort((a, b) => a.topic.toLowerCase().localeCompare(b.topic.toLowerCase())) });
  }
  let rows = [];
  (await progressDocs(p.classId)).forEach(d => { rows = rows.concat(itemsOf(d)); });
  const by = {};
  rows.filter(typeFilter(taskType)).forEach(s => {
    const t = String(s.Topic || 'Untitled').trim() || 'Untitled';
    if (!by[t]) by[t] = { topic: t, sessions: 0, students: {} };
    by[t].sessions++; by[t].students[s.StudentID] = true;
  });
  return ok({ data: Object.keys(by).map(k => ({ topic: k, sessions: by[k].sessions, students: Object.keys(by[k].students).length }))
    .sort((a, b) => a.topic.toLowerCase().localeCompare(b.topic.toLowerCase())) });
}
async function getClassStats() {
  const [classes, users, progs] = await Promise.all([allClasses(), allUsers(), progressDocs('')]);
  const stats = classes.filter(c => c.Status === 'Active').map(c => {
    const cid = up(c.ClassID);
    const students = users.filter(u => u.role !== 'Teacher' && u.status !== 'Archived' && up(u.classId) === cid);
    let rows = [];
    progs.filter(d => up(d.ClassID) === cid).forEach(d => { rows = rows.concat(itemsOf(d)); });
    const practiced = {}; rows.forEach(s => { practiced[s.StudentID] = true; });
    const ms = rows.filter(s => String(s.IsMilestone) === 'true' && s.Overall);
    const avg = ms.length ? Math.round(ms.reduce((t, s) => t + (parseFloat(s.Overall) || 0), 0) / ms.length * 10) / 10 : 0;
    return { classId: cid, className: c.ClassName, academicYear: c.AcademicYear, semester: c.Semester,
      totalStudents: students.length, practiced: Object.keys(practiced).length,
      notPracticed: students.length - Object.keys(practiced).length, avgScore: avg, totalSessions: rows.length };
  });
  return ok({ data: stats });
}

async function getExtensionRequests(p) {
  let q = fs.collection('extensionRequests');
  if (!p || p.status !== 'all') q = q.where('status', '==', (p && p.status) || 'pending');
  const list = docs(await q.get()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return ok({ data: list });
}
// Approve (scope 'student' or 'class', until = new deadline) or reject.
async function decideExtension(p) {
  const ref = fs.doc('extensionRequests/' + p.reqId);
  const r = (await ref.get()).data();
  if (!r) return fail('Request not found.');
  const now = new Date().toISOString();
  if (!p.approve) {
    await ref.update({ status: 'rejected', decidedAt: now, note: p.note || '' });
  } else {
    const until = parseDeadline(p.until);
    if (!until) return fail('Choose the new deadline.');
    const path = p.scope === 'class' ? 'ext.classes.' + r.classId : 'ext.students.' + r.uid;
    await fs.doc('assignments/' + r.assignId).update(new firebase.firestore.FieldPath(...path.split('.')), until.toISOString());
    await ref.update({ status: 'approved', scope: p.scope === 'class' ? 'class' : 'student',
      decidedUntil: until.toISOString(), decidedAt: now, note: p.note || '' });
    forget('assignments');
  }
  try { await gas('notify.extensionDecision', { reqId: p.reqId }); } catch (e) {}
  return ok();
}
// Teacher extends a class or one student directly, without a request.
async function grantExtension(p) {
  const until = parseDeadline(p.until);
  if (!until) return fail('Choose the new deadline.');
  let key;
  if (p.scope === 'class') key = ['ext', 'classes', up(p.classId)];
  else {
    const u = await userByStudentId(p.studentId);
    if (!u) return fail('Student not found.');
    key = ['ext', 'students', u._id];
  }
  await fs.doc('assignments/' + p.assignId).update(new firebase.firestore.FieldPath(...key), until.toISOString());
  forget('assignments');
  return ok();
}

// ════════════════════════════════════════════
// Apps Script (accounts, Docs, Sheets export, email)
// ════════════════════════════════════════════
let GAS_URL = '';
async function gas(action, payload) {
  init();
  const u = auth.currentUser;
  const idToken = u ? await u.getIdToken() : '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify({ action, payload, idToken }), signal: ctrl.signal });
    if (!r.ok) throw new Error('Network error ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const GAS_ACTIONS = ['auth.register', 'auth.forgotPassword', 'auth.verifyCode', 'auth.resetPassword',
  'teacher.addStudent', 'teacher.updateStudent', 'teacher.exportSessions', 'teacher.deleteClassData',
  'teacher.clearOldData', 'teacher.exportDoc', 'speak.exportDoc'];

const ACTIONS = {
  'auth.login': login, 'auth.teacherLogin': teacherLogin,
  'student.getOverview': getOverview, 'student.getHomework': getHomework, 'student.getMyHistory': getMyHistory,
  'student.getPeerComparison': getPeerComparison, 'student.getJamTopics': getJamTopics,
  'student.requestExtension': requestExtension,
  'speak.findExisting': findExisting, 'speak.saveResult': saveResult,
  'teacher.getClasses': getClasses, 'teacher.createClass': createClass,
  'teacher.setClassStatus': setClassStatus, 'teacher.archiveClass': p => setClassStatus({ classId: p.classId, status: 'Archived' }),
  'teacher.getStudents': getStudents, 'teacher.activateUser': activateUser,
  'teacher.archiveStudent': p => activateUser({ studentId: p.studentId, status: 'Archived' }),
  'teacher.getAssignments': getAssignments, 'teacher.createAssignment': createAssignment,
  'teacher.deleteAssignment': deleteAssignment, 'teacher.setAssignmentStatus': setAssignmentStatus,
  'teacher.updateAssignment': updateAssignment, 'teacher.relaunchAssignment': relaunchAssignment,
  'teacher.getLibrary': getLibrary, 'teacher.saveToLibrary': saveToLibrary,
  'teacher.deleteLibraryItem': deleteLibraryItem, 'teacher.launchFromLibrary': launchFromLibrary,
  'teacher.getSettings': getSettings, 'teacher.saveSetting': saveSetting,
  'teacher.changePassword': teacherChangePassword,
  'teacher.getAllSessions': getAllSessions, 'teacher.getClassTopics': getClassTopics,
  'teacher.getClassStats': getClassStats,
  'teacher.getExtensionRequests': getExtensionRequests, 'teacher.decideExtension': decideExtension,
  'teacher.grantExtension': grantExtension
};

async function call(action, payload) {
  init();
  try {
    if (ACTIONS[action]) return await ACTIONS[action](payload || {});
    if (GAS_ACTIONS.indexOf(action) >= 0) {
      const res = await gas(action, payload || {});
      if (res && res.success && /^teacher\.(addStudent|updateStudent|deleteClassData)$/.test(action)) { forget('users'); forget('progress'); }
      return res;
    }
    return fail('Unknown action: ' + action);
  } catch (e) {
    const code = (e && e.code) || '';
    if (e && (e.message === 'SESSION_EXPIRED' || /unauthenticated/.test(code))) return fail('SESSION_EXPIRED');
    if (/permission-denied/.test(code)) return fail(auth && auth.currentUser ? 'You do not have access to this.' : 'SESSION_EXPIRED');
    if (/unavailable|deadline-exceeded/.test(code)) return fail('Cannot reach the server — check your connection and try again.');
    console.error('[fbdata] ' + action, e);
    return fail((e && e.message) || String(e));
  }
}

window.FB = {
  call, authReady, signOut, parseDeadline, effectiveDeadline,
  setGasUrl(u) { GAS_URL = u; },
  isSignedIn: async () => { await authReady(); return !!auth.currentUser; },
  _helpers: { authPw, loginEmailFor, sameTask, attemptsSoFar }
};
})();
