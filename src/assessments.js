// Assessment links: create, start, answer, submit, score.
// All time rules are enforced here on the server; the browser timer is only a display.
const crypto = require('crypto');
const { db, getSettings, now } = require('./db');

const SECTIONS = ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY'];
const TYPES = {
  IQ: ['IQ'],
  GENERAL: ['GENERAL'],
  CALCULATION: ['CALCULATION'],
  ESSAY: ['ESSAY'],
  COMBINED: SECTIONS,
};
const LANGUAGES = ['en', 'lo'];
// A submit that arrives just after the deadline (slow network) is still
// accepted with its answers; after this it is ignored and saved answers count.
const SUBMIT_GRACE_MS = 30 * 1000;

const LETTERS = ['A', 'B', 'C', 'D', 'E'];
// Option and picture columns copied from the bank into each candidate's questions.
const SNAPSHOT_COLS = [...LETTERS.map((L) => 'option_' + L.toLowerCase()), 'image_id', ...LETTERS.map((L) => `option_${L.toLowerCase()}_image`)];

// Two questions are "the same" only if wording, options and pictures all match,
// so several "Which figure comes next?" questions with different pictures can
// all appear in one test.
function questionKey(q) {
  const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return [q.section, norm(q.question_text), ...SNAPSHOT_COLS.map((c) => norm(q[c]))].join('|');
}

// ---- IQ difficulty ------------------------------------------------------
// An IQ test starts easy and gets harder. Questions without a difficulty
// count as Medium.
// Three IQ levels. The level alone decides a question's marks:
// Level 1 Easy = 1 mark, Level 2 Medium = 2 marks, Level 3 Hard = 3 marks.
const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
const LEVEL_MARKS = { Easy: 1, Medium: 2, Hard: 3 };
function difficultyLevel(value) {
  const v = String(value || '').trim().toLowerCase();
  if (/^(easy|ງ່າຍ|(level\s*)?1$)/.test(v)) return 'Easy';
  if (/^(medium|normal|ປານກາງ|(level\s*)?2$)/.test(v)) return 'Medium';
  if (/^(hard|difficult|ຍາກ|(level\s*)?3$)/.test(v)) return 'Hard';
  return '';
}
// A question without a level is treated as Level 2 (Medium).
const levelOf = (q) => difficultyLevel(q.difficulty) || 'Medium';
const levelMarks = (q) => LEVEL_MARKS[levelOf(q)];

// How many questions of each level an IQ test of n questions gets: as even as
// possible, extra questions going to Level 3 first, then Level 1
// (10 -> 3/3/4, 18 -> 6/6/6, 20 -> 7/6/7).
function levelSplit(n) {
  const base = Math.floor(n / 3);
  const extra = n % 3;
  return { Easy: base + (extra === 2 ? 1 : 0), Medium: base, Hard: base + (extra >= 1 ? 1 : 0) };
}

// Picks n questions from an already shuffled pool: random within each level,
// shown Level 1 first, then Level 2, then Level 3. If a level has too few
// questions, the gap is filled from the other levels.
function pickProgressive(pool, n) {
  const byLevel = { Easy: [], Medium: [], Hard: [] };
  for (const q of pool) byLevel[levelOf(q)].push(q);
  const want = levelSplit(n);
  const picked = [];
  for (const level of DIFFICULTIES) picked.push(...byLevel[level].splice(0, want[level]));
  const rest = [...byLevel.Easy, ...byLevel.Medium, ...byLevel.Hard];
  picked.push(...shuffle(rest).slice(0, n - picked.length));
  const rank = (q) => DIFFICULTIES.indexOf(levelOf(q));
  return picked.map((q, i) => [q, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([q]) => q);
}

const newToken = () => crypto.randomBytes(24).toString('base64url');
const addMinutes = (iso, minutes) => new Date(new Date(iso).getTime() + minutes * 60000).toISOString();

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Questions a new assessment may use: Active, and for IQ also given a level
// (Easy / Medium / Hard). Inactive questions are never selected.
const USABLE = "status = 'Active' AND (section != 'IQ' OR difficulty IN ('Easy', 'Medium', 'Hard'))";

function activeCounts() {
  const counts = Object.fromEntries(SECTIONS.map((s) => [s, 0]));
  for (const r of db.prepare(`SELECT section, COUNT(*) AS n FROM questions WHERE ${USABLE} GROUP BY section`).all()) counts[r.section] = r.n;
  return counts;
}

function inactiveCounts() {
  const counts = Object.fromEntries(SECTIONS.map((s) => [s, 0]));
  for (const r of db.prepare("SELECT section, COUNT(*) AS n FROM questions WHERE status != 'Active' GROUP BY section").all()) counts[r.section] = r.n;
  return counts;
}

class InputError extends Error {}

// One link can hold several tests. They always run in the order
// IQ -> General -> Calculation -> Essay; only the ones chosen are included.
function createAssessment(input) {
  const settings = getSettings();
  let tests;
  if (Array.isArray(input.tests)) {
    tests = SECTIONS.filter((sec) => input.tests.map((t) => String(t).toUpperCase()).includes(sec));
  } else {
    const type = String(input.assessment_type || '').toUpperCase();
    if (!TYPES[type]) throw new InputError('Please choose at least one test.');
    tests = TYPES[type];
  }

  const available = activeCounts();
  const sections = {};
  const minutes = {};
  for (const sec of tests) {
    const n = Number(input.counts?.[sec] ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > 500) throw new InputError('Number of questions must be a whole number.');
    if (n === 0) continue;
    if (n > available[sec]) throw new InputError(`Only ${available[sec]} active ${label(sec)} questions are in the question bank.`);
    const m = Number(input.minutes?.[sec] || input.time_limit_minutes || settings.default_time_minutes);
    if (!Number.isInteger(m) || m < 1 || m > 600) throw new InputError(`Time for the ${label(sec)} test must be between 1 and 600 minutes.`);
    sections[sec] = n;
    minutes[sec] = m;
  }
  const included = Object.keys(sections);
  if (included.length === 0) throw new InputError('Please choose at least one test with at least 1 question.');

  const expiry = Number(input.link_expiry_minutes || settings.default_link_expiry_minutes);
  if (!Number.isInteger(expiry) || expiry < 1 || expiry > 60 * 24 * 90) throw new InputError('Link expiry must be between 1 minute and 90 days.');
  const language = LANGUAGES.includes(input.language) ? input.language : settings.default_language;

  let candidateId = null;
  if (input.candidate_id) {
    candidateId = Number(input.candidate_id);
    if (!db.prepare('SELECT id FROM candidates WHERE id = ?').get(candidateId)) throw new InputError('Candidate not found.');
  }

  const created = now();
  const type = included.length === 1 ? included[0] : 'COMBINED';
  const total = included.reduce((sum, sec) => sum + minutes[sec], 0);
  const id = db.transaction(() => {
    const aid = db.prepare(`INSERT INTO assessments
      (token, candidate_id, assessment_type, sections, time_limit_minutes, link_expiry_minutes, link_expires_at, language, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newToken(), candidateId, type, JSON.stringify(sections), total, expiry, addMinutes(created, expiry), language, created).lastInsertRowid;
    const addStage = db.prepare('INSERT INTO assessment_stages (assessment_id, position, section, question_count, time_limit_minutes) VALUES (?, ?, ?, ?, ?)');
    included.forEach((sec, i) => addStage.run(aid, i + 1, sec, sections[sec], minutes[sec]));
    return aid;
  })();
  return getAssessment(id);
}

// The tests of an assessment, in order. Links made before tests were split
// into steps get their steps here, matching what already happened.
function stagesOf(a) {
  const rows = db.prepare('SELECT * FROM assessment_stages WHERE assessment_id = ? ORDER BY position').all(a.id);
  if (rows.length) return rows;
  const sections = JSON.parse(a.sections || '{}');
  const cols = { IQ: 'iq', GENERAL: 'general', CALCULATION: 'calc', ESSAY: 'essay' };
  const passMark = getSettings().pass_mark;
  const add = db.prepare(`INSERT OR IGNORE INTO assessment_stages
    (assessment_id, position, section, question_count, time_limit_minutes, status, started_at, deadline_at, submitted_at, auto_submitted, points, max, percent, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const list = SECTIONS.filter((sec) => sections[sec]);
  list.forEach((sec, i) => {
    const points = a[cols[sec] + '_points'];
    const max = a[cols[sec] + '_max'];
    const percent = max ? round1((points / max) * 100) : null;
    const result = a.status !== 'SUBMITTED' ? 'Pending' : list.length === 1 ? a.result
      : sec === 'ESSAY' && a.essay_pending ? 'Pending' : percent != null && percent >= passMark ? 'Pass' : 'Not Pass';
    add.run(a.id, i + 1, sec, sections[sec], a.time_limit_minutes, a.status, a.started_at, a.deadline_at, a.submitted_at, a.auto_submitted,
      a.status === 'SUBMITTED' ? points : null, a.status === 'SUBMITTED' ? max : null, a.status === 'SUBMITTED' ? percent : null, result);
  });
  return db.prepare('SELECT * FROM assessment_stages WHERE assessment_id = ? ORDER BY position').all(a.id);
}

function getAssessment(id) {
  return db.prepare('SELECT * FROM assessments WHERE id = ?').get(id);
}

function label(section) {
  return { IQ: 'IQ', GENERAL: 'General', CALCULATION: 'Calculation', ESSAY: 'Essay' }[section];
}

// What the candidate link can do right now.
// NOT_STARTED links expire at link_expires_at; once started the test deadline applies.
// 'next_test' = a test was passed and the next one has not been opened yet.
function linkState(a) {
  if (!a) return 'not_found';
  if (a.status === 'SUBMITTED') return 'submitted';
  if (!a.enabled) return 'disabled';
  if (a.status === 'NOT_STARTED' && Date.now() > Date.parse(a.link_expires_at)) return 'expired';
  if (a.status === 'IN_PROGRESS') return stagesOf(a).some((st) => st.status === 'IN_PROGRESS') ? 'in_progress' : 'next_test';
  return 'ready';
}

// ---- start --------------------------------------------------------------

const CANDIDATE_FIELDS = ['name', 'phone', 'graduate_from', 'high_school', 'college', 'university', 'school_name', 'subject', 'gpa'];

function cleanCandidateInfo(body) {
  const info = {};
  for (const f of CANDIDATE_FIELDS) info[f] = String(body?.[f] ?? '').trim().slice(0, 300);
  if (!info.name) throw new InputError('name_required');
  if (!info.phone) throw new InputError('phone_required');
  return info;
}

const insertQuestion = db.prepare(`INSERT INTO assessment_questions
  (assessment_id, question_id, position, section, question_text, ${SNAPSHOT_COLS.join(', ')}, correct_answer, option_order, max_marks, difficulty)
  VALUES (@assessment_id, @question_id, @position, @section, @question_text, ${SNAPSHOT_COLS.map((c) => '@' + c).join(', ')},
    @correct_answer, @option_order, @max_marks, @difficulty)`);

// Opens one test: draws its random questions (never repeating one already used
// in this assessment), shuffles the answers and starts its timer.
function openStage(a, stage) {
  const stamp = now();
  const used = new Set(db.prepare('SELECT * FROM assessment_questions WHERE assessment_id = ?').all(a.id).map(questionKey));
  let position = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM assessment_questions WHERE assessment_id = ?').get(a.id).p;
  const pool = [];
  for (const q of shuffle(db.prepare(`SELECT * FROM questions WHERE section = ? AND ${USABLE}`).all(stage.section))) {
    const key = questionKey(q);
    if (used.has(key)) continue;
    used.add(key);
    pool.push(q);
  }
  const picked = stage.section === 'IQ' ? pickProgressive(pool, stage.question_count) : pool.slice(0, stage.question_count);
  if (picked.length === 0) throw new InputError('no_questions');
  for (const q of picked) {
    const letters = LETTERS.filter((L) => q['option_' + L.toLowerCase()] || q['option_' + L.toLowerCase() + '_image']);
    insertQuestion.run({
      ...Object.fromEntries(SNAPSHOT_COLS.map((c) => [c, q[c]])),
      assessment_id: a.id, question_id: q.id, position: ++position, section: stage.section, question_text: q.question_text,
      correct_answer: q.correct_answer, option_order: JSON.stringify(shuffle(letters)),
      max_marks: stage.section === 'IQ' ? levelMarks(q) : q.marks, difficulty: q.difficulty,
    });
  }
  const deadline = addMinutes(stamp, stage.time_limit_minutes);
  const res = db.prepare("UPDATE assessment_stages SET status = 'IN_PROGRESS', started_at = ?, deadline_at = ? WHERE id = ? AND status = 'NOT_STARTED'")
    .run(stamp, deadline, stage.id);
  if (res.changes !== 1) throw new InputError('already_started');
  db.prepare('UPDATE assessments SET deadline_at = ? WHERE id = ?').run(deadline, a.id);
}

const startTx = db.transaction((a, info) => {
  const stamp = now();
  let candidateId = a.candidate_id;
  if (candidateId) {
    const sets = CANDIDATE_FIELDS.map((f) => `${f} = @${f}`).join(', ');
    db.prepare(`UPDATE candidates SET ${sets}, updated_at = @stamp WHERE id = @id`).run({ ...info, stamp, id: candidateId });
  } else {
    const cols = CANDIDATE_FIELDS.join(', ');
    const vals = CANDIDATE_FIELDS.map((f) => '@' + f).join(', ');
    candidateId = db.prepare(`INSERT INTO candidates (${cols}, created_at, updated_at) VALUES (${vals}, @stamp, @stamp)`)
      .run({ ...info, stamp }).lastInsertRowid;
  }
  // Only one start can win, even if the candidate double-clicks.
  const res = db.prepare(`UPDATE assessments SET status = 'IN_PROGRESS', candidate_id = ?, started_at = ?
    WHERE id = ? AND status = 'NOT_STARTED'`).run(candidateId, stamp, a.id);
  if (res.changes !== 1) throw new InputError('already_started');
  openStage(a, stagesOf(a)[0]); // the candidate's details are entered once; the first test starts now
});

function startAssessment(a, body) {
  const info = cleanCandidateInfo(body);
  startTx(a, info);
}

// Opens the next test, only after every earlier test was passed. The server
// decides which test is next; the candidate cannot choose or skip one.
const continueTx = db.transaction((a) => {
  const fresh = getAssessment(a.id);
  if (!fresh || fresh.status !== 'IN_PROGRESS') return false;
  const stages = stagesOf(fresh);
  if (stages.some((st) => st.status === 'IN_PROGRESS')) return false;
  const next = stages.find((st) => st.status === 'NOT_STARTED');
  if (!next || stages.some((st) => st.status === 'SUBMITTED' && st.result === 'Not Pass')) return false;
  openStage(fresh, next);
  return true;
});

function continueAssessment(a) {
  return continueTx(a);
}

// ---- answering -------------------------------------------------------------

function isPastDeadline(a, graceMs = 0) {
  return a.deadline_at && Date.now() > Date.parse(a.deadline_at) + graceMs;
}

function saveAnswer(a, aqId, answer) {
  const value = answer == null ? null : String(answer).slice(0, 20000);
  return db.prepare(`UPDATE assessment_questions SET answer = ? WHERE id = ? AND assessment_id = ?
    AND section IN (SELECT section FROM assessment_stages WHERE assessment_id = ? AND status = 'IN_PROGRESS')`)
    .run(value, Number(aqId), a.id, a.id).changes === 1;
}

// ---- scoring -------------------------------------------------------------

function normalizeShort(v) {
  return String(v ?? '').trim().toLowerCase().replace(/[\s,]/g, '');
}

function gradeQuestion(q) {
  if (q.section === 'ESSAY') return q.marks_awarded; // HR marks essays; null = not marked yet
  if (q.answer == null || q.answer === '') return 0;
  const hasOptions = JSON.parse(q.option_order).length > 0;
  if (hasOptions) return q.answer === q.correct_answer ? q.max_marks : 0;
  const a = normalizeShort(q.answer);
  const c = normalizeShort(q.correct_answer);
  if (a !== '' && c !== '' && !Number.isNaN(Number(a)) && !Number.isNaN(Number(c))) return Number(a) === Number(c) ? q.max_marks : 0;
  return a === c ? q.max_marks : 0;
}

const round1 = (n) => Math.round(n * 10) / 10;

// Recalculates and stores all scores of a submitted assessment.
function scoreAssessment(assessmentId) {
  const questions = db.prepare('SELECT * FROM assessment_questions WHERE assessment_id = ?').all(assessmentId);
  const totals = Object.fromEntries(SECTIONS.map((s) => [s, { points: 0, max: 0 }]));
  let essayPending = 0;
  const setMarks = db.prepare('UPDATE assessment_questions SET marks_awarded = ? WHERE id = ?');
  for (const q of questions) {
    const marks = gradeQuestion(q);
    if (q.section !== 'ESSAY') setMarks.run(marks, q.id);
    if (marks == null) essayPending++;
    totals[q.section].points += marks || 0;
    totals[q.section].max += q.max_marks;
  }
  const totalPoints = SECTIONS.reduce((s, k) => s + totals[k].points, 0);
  const totalMax = SECTIONS.reduce((s, k) => s + totals[k].max, 0);
  const testScore = totalMax > 0 ? round1((totalPoints / totalMax) * 100) : 0;
  const passMark = getSettings().pass_mark;
  // Each finished test: score, percentage and PASS / NOT PASS (an essay stays
  // Pending until HR marks it). The assessment passes only if every test passed.
  const a = getAssessment(assessmentId);
  const stages = stagesOf(a);
  const setStage = db.prepare('UPDATE assessment_stages SET points = ?, max = ?, percent = ?, result = ? WHERE id = ?');
  for (const st of stages) {
    if (st.status !== 'SUBMITTED') continue;
    const qs = questions.filter((q) => q.section === st.section);
    const marks = qs.map((q) => gradeQuestion(q));
    const points = marks.reduce((sum, m) => sum + (m || 0), 0);
    const max = qs.reduce((sum, q) => sum + q.max_marks, 0);
    const percent = max > 0 ? round1((points / max) * 100) : 0;
    st.result = marks.some((m) => m == null) ? 'Pending' : percent >= passMark ? 'Pass' : 'Not Pass';
    setStage.run(points, max, percent, st.result, st.id);
  }
  const result = stages.some((st) => st.status === 'SUBMITTED' && st.result === 'Not Pass') ? 'Not Pass'
    : stages.every((st) => st.status === 'SUBMITTED' && st.result === 'Pass') ? 'Pass' : 'Pending';
  const sec = (s) => (totals[s].max > 0 ? [totals[s].points, totals[s].max] : [null, null]);

  // IQ result per level: questions asked, answered correctly, marks earned and possible.
  // The IQ Test Score is the weighted marks (iq_points / iq_max).
  const iq = questions.filter((q) => q.section === 'IQ');
  const breakdown = {};
  for (const q of iq) {
    const level = levelOf(q);
    const b = (breakdown[level] = breakdown[level] || { correct: 0, total: 0, marks: 0, max: 0 });
    const got = gradeQuestion(q) || 0;
    b.total++;
    b.max += q.max_marks;
    b.marks += got;
    if (got > 0) b.correct++;
  }
  const iqCorrect = iq.length ? Object.values(breakdown).reduce((sum, b) => sum + b.correct, 0) : null;

  db.prepare(`UPDATE assessments SET iq_points = ?, iq_max = ?, general_points = ?, general_max = ?, calc_points = ?, calc_max = ?,
    essay_points = ?, essay_max = ?, essay_pending = ?, total_points = ?, total_max = ?, test_score = ?, result = ?,
    iq_correct = ?, iq_total = ?, iq_breakdown = ? WHERE id = ?`)
    .run(...sec('IQ'), ...sec('GENERAL'), ...sec('CALCULATION'), ...sec('ESSAY'), essayPending, totalPoints, totalMax, testScore, result,
      iqCorrect, iq.length || null, iq.length ? JSON.stringify(breakdown) : null, assessmentId);
}

// Finishes the running test exactly once and scores it. If it was not passed
// the assessment stops; if it was the last test the assessment is complete;
// otherwise the candidate may continue to the next test.
// Returns false if no test was running (already finished, or never started).
const finalize = db.transaction((assessmentId, auto) => {
  const a = getAssessment(assessmentId);
  if (!a || a.status !== 'IN_PROGRESS') return false;
  stagesOf(a);
  const stamp = now();
  const res = db.prepare(`UPDATE assessment_stages SET status = 'SUBMITTED', submitted_at = ?, auto_submitted = ?
    WHERE assessment_id = ? AND status = 'IN_PROGRESS'`).run(stamp, auto ? 1 : 0, assessmentId);
  if (res.changes === 0) return false;
  if (auto) db.prepare('UPDATE assessments SET auto_submitted = 1 WHERE id = ?').run(assessmentId);
  scoreAssessment(assessmentId);
  const stages = stagesOf(a);
  const stopped = stages.some((st) => st.status === 'SUBMITTED' && st.result === 'Not Pass');
  const more = stages.some((st) => st.status === 'NOT_STARTED');
  if (stopped || !more) {
    db.prepare("UPDATE assessments SET status = 'SUBMITTED', submitted_at = ? WHERE id = ?").run(stamp, assessmentId);
    scoreAssessment(assessmentId);
  } else {
    db.prepare('UPDATE assessments SET deadline_at = NULL WHERE id = ?').run(assessmentId);
  }
  return true;
});

const submitTx = db.transaction((a, answers) => {
  if (!isPastDeadline(a, SUBMIT_GRACE_MS) && answers && typeof answers === 'object') {
    for (const [aqId, value] of Object.entries(answers)) saveAnswer(a, aqId, value);
  }
  return finalize(a.id, isPastDeadline(a));
});

function submitAssessment(a, answers) {
  return submitTx(a, answers);
}

// Finalizes every started assessment whose time ran out (candidate closed the
// browser, lost connection, ...). Safe to run any number of times.
function finalizeExpired() {
  const expired = db.prepare("SELECT id FROM assessments WHERE status = 'IN_PROGRESS' AND deadline_at < ?").all(now());
  for (const { id } of expired) finalize(id, true);
  return expired.length;
}

// 1. Bank IQ questions: marks follow the level.
// 2. Candidates' IQ questions that were copied without a level take the level
//    their bank question has now (answers and dates are never touched).
// 3. Their marks follow the level, and changed tests are scored again.
function syncIqLevels() {
  const fixMarks = db.prepare("UPDATE questions SET marks = ? WHERE id = ? AND section = 'IQ' AND marks != ?");
  for (const q of db.prepare("SELECT id, difficulty FROM questions WHERE section = 'IQ'").all()) {
    if (difficultyLevel(q.difficulty)) fixMarks.run(levelMarks(q), q.id, levelMarks(q));
  }
  db.prepare(`UPDATE assessment_questions SET difficulty = (SELECT q.difficulty FROM questions q WHERE q.id = assessment_questions.question_id)
    WHERE section = 'IQ' AND difficulty = '' AND question_id IS NOT NULL
      AND COALESCE((SELECT q.difficulty FROM questions q WHERE q.id = assessment_questions.question_id), '') != ''`).run();
  const changed = new Set();
  const setMax = db.prepare('UPDATE assessment_questions SET max_marks = ? WHERE id = ?');
  for (const q of db.prepare("SELECT id, assessment_id, difficulty, max_marks FROM assessment_questions WHERE section = 'IQ'").all()) {
    if (q.max_marks !== levelMarks(q)) { setMax.run(levelMarks(q), q.id); changed.add(q.assessment_id); }
  }
  // Results saved in the older format (lists instead of per-level marks) are recalculated too.
  for (const a of db.prepare("SELECT id FROM assessments WHERE status = 'SUBMITTED' AND iq_max IS NOT NULL AND (iq_breakdown IS NULL OR iq_breakdown NOT LIKE '%\"marks\"%')").all()) changed.add(a.id);
  const submitted = db.prepare("SELECT status FROM assessments WHERE id = ?");
  for (const id of changed) if (submitted.get(id)?.status === 'SUBMITTED') scoreAssessment(id);
  return changed.size;
}

function setEssayMarks(assessmentId, marks) {
  const a = getAssessment(assessmentId);
  if (!a || a.status !== 'SUBMITTED') throw new InputError('Essay marks can be entered after the assessment is submitted.');
  const update = db.prepare("UPDATE assessment_questions SET marks_awarded = ? WHERE id = ? AND assessment_id = ? AND section = 'ESSAY'");
  const max = db.prepare('SELECT max_marks FROM assessment_questions WHERE id = ? AND assessment_id = ?');
  db.transaction(() => {
    for (const [aqId, value] of Object.entries(marks || {})) {
      const row = max.get(Number(aqId), a.id);
      if (!row) continue;
      const n = value === '' || value == null ? null : Number(value);
      if (n != null && (!Number.isFinite(n) || n < 0 || n > row.max_marks)) throw new InputError(`Essay marks must be between 0 and ${row.max_marks}.`);
      update.run(n, Number(aqId), a.id);
    }
    scoreAssessment(a.id);
  })();
  return getAssessment(a.id);
}

// Re-scores submitted assessments after the pass mark changes.
function rescoreAll() {
  const ids = db.prepare("SELECT id FROM assessments WHERE status = 'SUBMITTED'").all();
  db.transaction(() => ids.forEach(({ id }) => scoreAssessment(id)))();
}

function regenerateLink(id) {
  const a = getAssessment(id);
  if (!a) throw new InputError('Assessment not found.');
  if (a.status !== 'NOT_STARTED') throw new InputError('Only links that have not been started can be regenerated.');
  db.prepare('UPDATE assessments SET token = ?, link_expires_at = ?, enabled = 1 WHERE id = ?')
    .run(newToken(), addMinutes(now(), a.link_expiry_minutes), id);
  return getAssessment(id);
}

module.exports = {
  stagesOf, continueAssessment,
  SECTIONS, TYPES, LANGUAGES, LETTERS, DIFFICULTIES, LEVEL_MARKS, InputError, label, questionKey, difficultyLevel, levelSplit, pickProgressive, syncIqLevels,
  activeCounts, inactiveCounts, createAssessment, getAssessment, linkState, startAssessment, saveAnswer,
  isPastDeadline, submitAssessment, finalize, finalizeExpired, scoreAssessment, setEssayMarks, rescoreAll, regenerateLink,
};
