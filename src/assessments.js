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

function activeCounts() {
  const counts = Object.fromEntries(SECTIONS.map((s) => [s, 0]));
  for (const r of db.prepare("SELECT section, COUNT(*) AS n FROM questions WHERE status = 'Active' GROUP BY section").all()) counts[r.section] = r.n;
  return counts;
}

class InputError extends Error {}

function createAssessment(input) {
  const settings = getSettings();
  const type = String(input.assessment_type || '').toUpperCase();
  if (!TYPES[type]) throw new InputError('Please choose an assessment type.');

  const available = activeCounts();
  const sections = {};
  for (const s of TYPES[type]) {
    const n = Number(input.counts?.[s] ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > 500) throw new InputError('Number of questions must be a whole number.');
    if (n === 0) continue;
    if (n > available[s]) throw new InputError(`Only ${available[s]} active ${label(s)} questions are in the question bank.`);
    sections[s] = n;
  }
  if (Object.keys(sections).length === 0) throw new InputError('Please choose at least 1 question.');

  const time = Number(input.time_limit_minutes || settings.default_time_minutes);
  const expiry = Number(input.link_expiry_minutes || settings.default_link_expiry_minutes);
  if (!Number.isInteger(time) || time < 1 || time > 600) throw new InputError('Assessment time must be between 1 and 600 minutes.');
  if (!Number.isInteger(expiry) || expiry < 1 || expiry > 60 * 24 * 90) throw new InputError('Link expiry must be between 1 minute and 90 days.');
  const language = LANGUAGES.includes(input.language) ? input.language : settings.default_language;

  let candidateId = null;
  if (input.candidate_id) {
    candidateId = Number(input.candidate_id);
    if (!db.prepare('SELECT id FROM candidates WHERE id = ?').get(candidateId)) throw new InputError('Candidate not found.');
  }

  const created = now();
  const info = db.prepare(`INSERT INTO assessments
    (token, candidate_id, assessment_type, sections, time_limit_minutes, link_expiry_minutes, link_expires_at, language, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newToken(), candidateId, type, JSON.stringify(sections), time, expiry, addMinutes(created, expiry), language, created);
  return getAssessment(info.lastInsertRowid);
}

function getAssessment(id) {
  return db.prepare('SELECT * FROM assessments WHERE id = ?').get(id);
}

function label(section) {
  return { IQ: 'IQ', GENERAL: 'General', CALCULATION: 'Calculation', ESSAY: 'Essay' }[section];
}

// What the candidate link can do right now.
// NOT_STARTED links expire at link_expires_at; once started the exam deadline applies.
function linkState(a) {
  if (!a) return 'not_found';
  if (a.status === 'SUBMITTED') return 'submitted';
  if (!a.enabled) return 'disabled';
  if (a.status === 'NOT_STARTED' && Date.now() > Date.parse(a.link_expires_at)) return 'expired';
  if (a.status === 'IN_PROGRESS') return 'in_progress';
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

  // Random, non-repeating selection per section, then shuffled answer order.
  const sections = JSON.parse(a.sections);
  const insert = db.prepare(`INSERT INTO assessment_questions
    (assessment_id, question_id, position, section, question_text, ${SNAPSHOT_COLS.join(', ')}, correct_answer, option_order, max_marks, difficulty)
    VALUES (@assessment_id, @question_id, @position, @section, @question_text, ${SNAPSHOT_COLS.map((c) => '@' + c).join(', ')},
      @correct_answer, @option_order, @max_marks, @difficulty)`);
  let position = 0;
  const used = new Set(); // never show the same question twice, even if the bank has copies
  for (const section of SECTIONS) {
    if (!sections[section]) continue;
    const pool = [];
    for (const q of shuffle(db.prepare("SELECT * FROM questions WHERE section = ? AND status = 'Active'").all(section))) {
      const key = questionKey(q);
      if (used.has(key)) continue;
      used.add(key);
      pool.push(q);
    }
    const picked = section === 'IQ' ? pickProgressive(pool, sections[section]) : pool.slice(0, sections[section]);
    for (const q of picked) {
      const letters = LETTERS.filter((L) => q['option_' + L.toLowerCase()] || q['option_' + L.toLowerCase() + '_image']);
      insert.run({
        ...Object.fromEntries(SNAPSHOT_COLS.map((c) => [c, q[c]])),
        assessment_id: a.id, question_id: q.id, position: ++position, section, question_text: q.question_text,
        correct_answer: q.correct_answer, option_order: JSON.stringify(shuffle(letters)), max_marks: section === 'IQ' ? levelMarks(q) : q.marks, difficulty: q.difficulty,
      });
    }
  }
  if (position === 0) throw new InputError('no_questions');

  // Only one start can win, even if the candidate double-clicks.
  const res = db.prepare(`UPDATE assessments SET status = 'IN_PROGRESS', candidate_id = ?, started_at = ?, deadline_at = ?
    WHERE id = ? AND status = 'NOT_STARTED'`)
    .run(candidateId, stamp, addMinutes(stamp, a.time_limit_minutes), a.id);
  if (res.changes !== 1) throw new InputError('already_started');
});

function startAssessment(a, body) {
  const info = cleanCandidateInfo(body);
  startTx(a, info);
}

// ---- answering -------------------------------------------------------------

function isPastDeadline(a, graceMs = 0) {
  return a.deadline_at && Date.now() > Date.parse(a.deadline_at) + graceMs;
}

function saveAnswer(a, aqId, answer) {
  const value = answer == null ? null : String(answer).slice(0, 20000);
  return db.prepare('UPDATE assessment_questions SET answer = ? WHERE id = ? AND assessment_id = ?').run(value, Number(aqId), a.id).changes === 1;
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
  const result = essayPending > 0 ? 'Pending' : testScore >= passMark ? 'Pass' : 'Not Pass';
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

// Marks the assessment submitted exactly once and scores it.
// Returns false if it was already submitted (or never started).
const finalize = db.transaction((assessmentId, auto) => {
  const res = db.prepare(`UPDATE assessments SET status = 'SUBMITTED', submitted_at = ?, auto_submitted = ?
    WHERE id = ? AND status = 'IN_PROGRESS'`).run(now(), auto ? 1 : 0, assessmentId);
  if (res.changes !== 1) return false;
  scoreAssessment(assessmentId);
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
  SECTIONS, TYPES, LANGUAGES, LETTERS, DIFFICULTIES, LEVEL_MARKS, InputError, label, questionKey, difficultyLevel, levelSplit, pickProgressive, syncIqLevels,
  activeCounts, createAssessment, getAssessment, linkState, startAssessment, saveAnswer,
  isPastDeadline, submitAssessment, finalize, finalizeExpired, scoreAssessment, setEssayMarks, rescoreAll, regenerateLink,
};
