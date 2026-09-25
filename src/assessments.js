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
    (assessment_id, question_id, position, section, question_text, option_a, option_b, option_c, option_d, correct_answer, option_order, max_marks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let position = 0;
  const usedTexts = new Set(); // never show the same wording twice, even if the bank has copies
  for (const section of SECTIONS) {
    if (!sections[section]) continue;
    const pool = db.prepare("SELECT * FROM questions WHERE section = ? AND status = 'Active'").all(section);
    const picked = [];
    for (const q of shuffle(pool)) {
      if (picked.length === sections[section]) break;
      const text = q.question_text.trim().toLowerCase().replace(/\s+/g, ' ');
      if (usedTexts.has(text)) continue;
      usedTexts.add(text);
      picked.push(q);
    }
    for (const q of picked) {
      const letters = ['A', 'B', 'C', 'D'].filter((L) => q['option_' + L.toLowerCase()]);
      insert.run(a.id, q.id, ++position, section, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
        q.correct_answer, JSON.stringify(shuffle(letters)), q.marks);
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
  db.prepare(`UPDATE assessments SET iq_points = ?, iq_max = ?, general_points = ?, general_max = ?, calc_points = ?, calc_max = ?,
    essay_points = ?, essay_max = ?, essay_pending = ?, total_points = ?, total_max = ?, test_score = ?, result = ? WHERE id = ?`)
    .run(...sec('IQ'), ...sec('GENERAL'), ...sec('CALCULATION'), ...sec('ESSAY'), essayPending, totalPoints, totalMax, testScore, result, assessmentId);
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
  SECTIONS, TYPES, LANGUAGES, InputError, label,
  activeCounts, createAssessment, getAssessment, linkState, startAssessment, saveAnswer,
  isPastDeadline, submitAssessment, finalize, finalizeExpired, scoreAssessment, setEssayMarks, rescoreAll, regenerateLink,
};
