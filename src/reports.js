// Candidate summaries, dashboard numbers and PDF / Word / Excel exports.
const path = require('path');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const docx = require('docx');
const { db, getSettings } = require('./db');
const T = require('./testTypes');
const A = require('./assessments');

// "General Test" etc.: the current name of each managed test type.
const TEST_NAMES = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? T.title(key) : undefined) });
const RESULT_TEXT = { Pass: 'PASS', 'Not Pass': 'NOT PASS', Pending: 'Pending' };
const round1 = (n) => Math.round(n * 10) / 10;
const pct1 = (v) => (v == null ? null : Number(v).toFixed(1) + '%');

// Level of a General / Calculation / Essay percentage, and of the final score.
// (The IQ level comes from the LALCO IQ Score, see iqCategory.) A level is
// not a pass or fail: that is decided by each test's own pass mark.
const PERCENT_LEVELS = [[90, 'Exceptional'], [80, 'Very High'], [70, 'High'], [60, 'Average'], [50, 'Low'], [0, 'Very Low']];
function percentLevel(percent) {
  if (percent == null || !Number.isFinite(Number(percent))) return null;
  return (PERCENT_LEVELS.find(([from]) => Number(percent) >= from) || PERCENT_LEVELS[PERCENT_LEVELS.length - 1])[1];
}

// Status of one test in a link:
// PASS / NOT PASS / PENDING HR MARKING once finished, IN PROGRESS while running,
// NOT STARTED if it is the next one the candidate may open, otherwise LOCKED
// (an earlier test is not finished yet, or was not passed).
function stageStatus(a, st, stages) {
  if (st.status === 'IN_PROGRESS') return 'IN PROGRESS';
  if (st.status === 'SUBMITTED') return st.result === 'Pass' ? 'PASS' : st.result === 'Not Pass' ? 'NOT PASS' : 'PENDING HR MARKING';
  if (a.status === 'SUBMITTED' || stages.some((x) => x.status === 'IN_PROGRESS')) return 'LOCKED';
  const before = stages.filter((x) => x.position < st.position);
  return before.every((x) => x.status === 'SUBMITTED' && x.result === 'Pass') ? 'NOT STARTED' : 'LOCKED';
}
const COMPLETION = { PASS: 'Completed', 'NOT PASS': 'Completed', 'PENDING HR MARKING': 'Submitted', 'IN PROGRESS': 'In Progress', 'NOT STARTED': 'Not Started', LOCKED: 'Locked' };
const STATUS_TEXT = { 'PENDING HR MARKING': 'Pending HR marking', 'IN PROGRESS': 'In progress', 'NOT STARTED': 'Not started', LOCKED: 'Locked' };

// One test of a link with its score, percentage, level, pass mark and result.
function stageView(a, st, stages) {
  const state = stageStatus(a, st, stages);
  const done = st.status === 'SUBMITTED';
  const scored = done && st.result !== 'Pending';
  const percent = scored ? st.percent : null;
  const lalco = scored && st.section === 'IQ' ? lalcoIqScore(st.points, st.max) : null;
  // Consistency of a finished test: the questions saved for this candidate must
  // be exactly the number HR set, and the maximum their marks. A mismatch is
  // never hidden; the result is flagged for HR (nothing is changed or deleted).
  const saved = done ? db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(max_marks), 0) AS max FROM assessment_questions WHERE assessment_id = ? AND section = ?').get(a.id, st.section) : null;
  const mismatch = saved && (saved.n !== st.question_count || (scored && Number(st.max) !== Number(saved.max)) || (scored && st.points > st.max));
  return {
    question_count: st.question_count, questions_assigned: saved ? saved.n : null,
    review_required: mismatch ? 'Attempt question count mismatch — review required.' : null,
    section: st.section, name: TEST_NAMES[st.section], status: st.status, state, completion: COMPLETION[state],
    result: done ? st.result : null, points: done ? st.points : null, max: done ? st.max : null,
    percent, percent_text: pct1(percent),
    level: !scored ? null : st.section === 'IQ' ? iqCategory(lalco) : percentLevel(percent),
    lalco_iq_score: lalco,
    pass_mark: st.pass_mark ?? T.defaultPassMark(st.section, getSettings()),
    score_text: scored ? `${st.points} / ${st.max}` : null,
    text: scored ? `${pct1(percent)} ${RESULT_TEXT[st.result]}` : STATUS_TEXT[state],
  };
}

// FINAL OVERALL SCORE and COMPANY ELIGIBILITY of one link.
// Final % = the average of the percentages of the tests in the link (only the
// tests HR included), worked out once every test is finished and marked.
// Eligible = every test passed AND final % >= the link's eligibility mark.
// A test not passed means Not Eligible, with no final score made from tests
// that were never taken. HR's own Final Result is separate and never changed.
function finalAssessment(a, stages = a ? A.stagesOf(a) : []) {
  const mark = a && a.eligibility_mark != null ? a.eligibility_mark : getSettings().final_eligibility;
  const out = (eligibility, note, percent = null) => ({ final_percent: percent, final_percent_text: pct1(percent), final_level: percentLevel(percent),
    eligibility, eligibility_note: note, eligibility_mark: mark });
  if (!a || !stages.length || a.status === 'NOT_STARTED') return out('Pending', 'Assessment not started');
  const failed = stages.find((st) => st.status === 'SUBMITTED' && st.result === 'Not Pass');
  if (failed) return out('Not Eligible', `${TEST_NAMES[failed.section]} not passed`);
  if (!stages.every((st) => st.status === 'SUBMITTED' && st.result === 'Pass')) {
    const pending = stages.find((st) => st.status === 'SUBMITTED' && st.result === 'Pending');
    return out('Pending', pending ? `${TEST_NAMES[pending.section]} pending HR marking` : 'Assessment not finished');
  }
  const percent = round1(stages.reduce((sum, st) => sum + (st.max > 0 ? (st.points / st.max) * 100 : 0), 0) / stages.length);
  return percent >= mark ? out('Eligible', `All tests passed and the final score reaches ${mark}%`, percent)
    : out('Not Eligible', `All tests passed but the final score is below ${mark}%`, percent);
}

// The shared link an attempt came from: its name, or the start of its URL.
function linkName(a) {
  if (!a || !a.link_id) return a ? 'Single-candidate link' : null;
  const l = A.getLink(a.link_id);
  return l ? l.title || `Shared link ${l.token.slice(0, 6)}…` : null;
}

// Every test of one assessment link with its own score and result, and the final result.
function testResults(a) {
  if (!a) return { tests: [], current_stage: null, assessment_result: null, assessment_date: null, ...finalAssessment(null) };
  const stages = A.stagesOf(a);
  return { tests: stages.map((st) => stageView(a, st, stages)), current_stage: A.currentStage(a, stages).label,
    assessment_result: a.result, assessment_date: a.submitted_at || a.started_at, assessment_link: linkName(a), assessment_language: a.language === 'lo' ? 'Lao' : 'English', ...finalAssessment(a, stages) };
}

const FONT = path.join(__dirname, 'assets', 'NotoSansLao-Regular.ttf');
const pct = (points, max) => (max ? Math.round((points / max) * 1000) / 10 : null);

// A candidate's current results. Each section comes from the most recent
// submitted assessment that contained it; Test Score and Result come from the
// most recent submitted assessment overall.
function summarize(candidate, submitted, latestStarted) {
  const latestWith = (maxKey) => submitted.find((a) => a[maxKey] != null);
  const iq = latestWith('iq_max');
  const general = latestWith('general_max');
  const calc = latestWith('calc_max');
  const essay = latestWith('essay_max');
  const latest = submitted[0];
  const testResult = latest ? latest.result : 'Pending';
  return {
    ...candidate,
    iq_score: iq ? pct(iq.iq_points, iq.iq_max) : null,
    ...iqResult(iq),
    // The most recent link the candidate started: every test in it, the stage they are at, and its result.
    ...testResults(latestStarted),
    general_score: general ? pct(general.general_points, general.general_max) : null,
    calc_score: calc ? pct(calc.calc_points, calc.calc_max) : null,
    essay_score: essay && !essay.essay_pending ? pct(essay.essay_points, essay.essay_max) : null,
    essay_pending: essay ? essay.essay_pending > 0 : false,
    test_score: latest ? latest.test_score : null,
    test_result: testResult,
    // HR's Final Result wins; until it is decided, the test result is used.
    overall_result: candidate.final_result && candidate.final_result !== 'Pending' ? candidate.final_result : testResult,
    last_test_date: latest ? latest.submitted_at : null,
  };
}

// The IQ result of one assessment. The official IQ Test Score is the weighted
// marks (Level 1 = 1, Level 2 = 2, Level 3 = 3 per correct answer), e.g. "21 / 36".
// Level key, level number and label. "Medium" and "Hard" only appear in tests
// taken on the earlier 3-level scale (then Level 2 and Level 3).
const LEVELS = [['Easy', 1, 'Level 1 — Easy'], ['Basic', 2, 'Level 2 — Basic'], ['Moderate', 3, 'Level 3 — Moderate'],
  ['Difficult', 4, 'Level 4 — Difficult'], ['Very Difficult', 5, 'Level 5 — Very Difficult'],
  ['Medium', 2, 'Level 2 — Medium (earlier 3-level scale)'], ['Hard', 3, 'Level 3 — Hard (earlier 3-level scale)']];
// LALCO IQ Score: the weighted IQ marks turned into a 0-150 scale,
// marks / maximum marks x 150, rounded, always against the maximum of that
// candidate's own questions (18 questions 4/3/3/4/4 = 55; 30 = 90), so every
// test length gives a comparable score (27 / 55 -> 74; 27 / 90 -> 45).
// It is a recruitment score, not a clinical IQ. Returns null when there is no
// maximum to compare with (nothing is guessed).
function lalcoIqScore(points, max) {
  const p = Number(points);
  const m = Number(max);
  if (points == null || max == null || !Number.isFinite(p) || !Number.isFinite(m) || m <= 0) return null;
  return Math.min(150, Math.max(0, Math.round((p / m) * 150)));
}

// LALCO IQ SCORE CLASSIFICATION — the ONE place the bands are defined.
// Every whole score 0-150 falls in exactly one row. The population
// percentages are reference values from the classification table only:
// they are never used to calculate, change or rank a candidate's score.
const IQ_CLASSIFICATION = [
  { min: 130, max: 150, range: '130–150', description: 'Very superior', description_lo: 'ສູງເດັ່ນຫຼາຍ', populationReference: '2.2%' },
  { min: 120, max: 129, range: '120–129', description: 'Superior', description_lo: 'ສູງເດັ່ນ', populationReference: '6.7%' },
  { min: 110, max: 119, range: '110–119', description: 'High average', description_lo: 'ປານກາງຄ່ອນຂ້າງສູງ', populationReference: '16.1%' },
  { min: 90, max: 109, range: '90–109', description: 'Average', description_lo: 'ປານກາງ', populationReference: '50%' },
  { min: 80, max: 89, range: '80–89', description: 'Low average', description_lo: 'ປານກາງຄ່ອນຂ້າງຕ່ຳ', populationReference: '16.1%' },
  { min: 70, max: 79, range: '70–79', description: 'Borderline', description_lo: 'ກ້ຳເກິ່ງ', populationReference: '6.7%' },
  { min: 0, max: 69, range: '0–69', description: 'Extremely low', description_lo: 'ຕ່ຳຫຼາຍ', populationReference: '2.2%' },
];
// The classification of a LALCO IQ Score (a whole number 0-150), or null
// for no score / a value outside the scale.
function getIQClassification(score) {
  if (score == null || score === '') return null;
  const s = Number(score);
  if (!Number.isInteger(s) || s < 0 || s > 150) return null;
  const row = IQ_CLASSIFICATION.find((c) => s >= c.min && s <= c.max);
  return { range: row.range, description: row.description, description_lo: row.description_lo, populationReference: row.populationReference };
}
// The classification name only (used by every screen and export).
const iqCategory = (score) => getIQClassification(score)?.description ?? null;
const LALCO_NOTE = 'Calculated from the LALCO weighted IQ assessment score on a 0–150 scale (weighted marks ÷ maximum marks × 150).';

function iqResult(a) {
  if (!a || a.iq_max == null) return { iq_score: null, iq_text: null, iq_correct_text: null, iq_levels: [], iq_date: null, lalco_iq_score: null, iq_category: null, iq_classification: null };
  let breakdown = {};
  try { breakdown = JSON.parse(a.iq_breakdown || '{}') || {}; } catch { breakdown = {}; }
  const levels = LEVELS.map(([key, number, label]) => {
    const b = breakdown[key];
    return b && b.total ? { level: number, key, label, correct: b.correct, total: b.total, marks: b.marks, max: b.max,
      correct_text: `${b.correct} / ${b.total}`, marks_text: `${b.marks} / ${b.max}` } : null;
  }).filter(Boolean);
  return {
    iq_score: pct(a.iq_points, a.iq_max), // percentage of the weighted marks
    iq_points: a.iq_points,
    iq_max: a.iq_max,
    iq_text: `${a.iq_points} / ${a.iq_max}`,
    iq_correct: a.iq_correct,
    iq_total: a.iq_total,
    iq_correct_text: a.iq_total != null ? `${a.iq_correct} / ${a.iq_total}` : null,
    iq_levels: levels,
    iq_date: a.submitted_at,
    lalco_iq_score: lalcoIqScore(a.iq_points, a.iq_max),
    iq_category: iqCategory(lalcoIqScore(a.iq_points, a.iq_max)),
    iq_classification: getIQClassification(lalcoIqScore(a.iq_points, a.iq_max)),
  };
}
const levelText = (c, n) => { const l = (c.iq_levels || []).find((x) => x.level === n); return l ? l : null; };

function submittedByCandidate() {
  const map = new Map();
  for (const a of db.prepare("SELECT * FROM assessments WHERE status = 'SUBMITTED' ORDER BY submitted_at DESC, id DESC").all()) {
    if (!map.has(a.candidate_id)) map.set(a.candidate_id, []);
    map.get(a.candidate_id).push(a);
  }
  return map;
}

// The latest assessment each candidate has started (in progress or finished).
function latestStartedByCandidate() {
  const map = new Map();
  for (const a of db.prepare("SELECT * FROM assessments WHERE status != 'NOT_STARTED' ORDER BY started_at DESC, id DESC").all()) {
    if (!map.has(a.candidate_id)) map.set(a.candidate_id, a);
  }
  return map;
}

function allCandidateSummaries(search) {
  const q = String(search || '').trim();
  const rows = q
    ? db.prepare('SELECT * FROM candidates WHERE name LIKE ? OR phone LIKE ? ORDER BY created_at DESC, id DESC').all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM candidates ORDER BY created_at DESC, id DESC').all();
  const byCandidate = submittedByCandidate();
  const latest = latestStartedByCandidate();
  return rows.map((c) => summarize(c, byCandidate.get(c.id) || [], latest.get(c.id)));
}

function candidateSummary(id) {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  if (!c) return null;
  const submitted = db.prepare("SELECT * FROM assessments WHERE candidate_id = ? AND status = 'SUBMITTED' ORDER BY submitted_at DESC, id DESC").all(id);
  const latest = db.prepare("SELECT * FROM assessments WHERE candidate_id = ? AND status != 'NOT_STARTED' ORDER BY started_at DESC, id DESC LIMIT 1").get(id);
  return summarize(c, submitted, latest);
}

// Summary counts and dashboard filters use each candidate's latest link.
const testOf = (c, sec) => (c.tests || []).find((t) => t.section === sec);
const IQ_CLASS_NAMES = IQ_CLASSIFICATION.map((c) => c.description);

function dashboard() {
  const people = allCandidateSummaries();
  const withResult = (sec, result) => people.filter((p) => testOf(p, sec)?.result === result).length;
  const scored = people.filter((p) => p.test_score != null);
  const withIq = people.filter((p) => p.iq_score != null).sort((a, b) => b.iq_score - a.iq_score);
  const nowIso = new Date().toISOString();
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  return {
    total_candidates: people.length,
    passed: people.filter((p) => p.overall_result === 'Pass').length,
    not_passed: people.filter((p) => p.overall_result === 'Not Pass').length,
    average_test_score: scored.length ? Math.round((scored.reduce((s, p) => s + p.test_score, 0) / scored.length) * 10) / 10 : null,
    highest_iq: withIq[0] ? { id: withIq[0].id, name: withIq[0].name, iq_score: withIq[0].iq_score, iq_text: withIq[0].iq_text, iq_correct_text: withIq[0].iq_correct_text,
      lalco_iq_score: withIq[0].lalco_iq_score, iq_category: withIq[0].iq_category } : null,
    completed_assessments: count("SELECT COUNT(*) AS n FROM assessments WHERE status = 'SUBMITTED' AND business_area = 'RECRUITMENT'"),
    pending_assessments: count(`SELECT COUNT(*) AS n FROM assessments WHERE business_area = 'RECRUITMENT' AND (status = 'IN_PROGRESS'
      OR (status = 'NOT_STARTED' AND enabled = 1 AND link_expires_at > ?))`, nowIso),
    recent: people.filter((p) => p.last_test_date).sort((a, b) => b.last_test_date.localeCompare(a.last_test_date)).slice(0, 8),
    summary: {
      total: people.length,
      iq_passed: withResult('IQ', 'Pass'), iq_not_passed: withResult('IQ', 'Not Pass'),
      general_passed: withResult('GENERAL', 'Pass'), general_not_passed: withResult('GENERAL', 'Not Pass'),
      // The Behavioral Interview Test: every behavioural / interview-format test.
      behavioral_passed: people.filter((p) => (p.tests || []).some((t) => T.behavior(t.section) === 'interview' && t.result === 'Pass')).length,
      behavioral_not_passed: people.filter((p) => (p.tests || []).some((t) => T.behavior(t.section) === 'interview' && t.result === 'Not Pass')).length,
      behavioral_pending: people.filter((p) => (p.tests || []).some((t) => T.behavior(t.section) === 'interview' && t.state === 'PENDING HR MARKING')).length,
      calculation_passed: withResult('CALCULATION', 'Pass'), calculation_not_passed: withResult('CALCULATION', 'Not Pass'),
      essay_pending: people.filter((p) => testOf(p, 'ESSAY')?.state === 'PENDING HR MARKING').length,
      // Candidates per IQ classification (from their latest IQ test).
      iq_levels: Object.fromEntries(IQ_CLASS_NAMES.map((l) => [l, people.filter((p) => testOf(p, 'IQ')?.level === l).length])),
      eligible: people.filter((p) => p.eligibility === 'Eligible').length,
      not_eligible: people.filter((p) => p.eligibility === 'Not Eligible').length,
      pending: people.filter((p) => p.eligibility === 'Pending').length,
    },
    candidates: people,
    iq_classification: IQ_CLASSIFICATION,
  };
}

// ---- export fields -------------------------------------------------------

const show = (v) => (v == null || v === '' ? '-' : String(v));
const eligibilityText = (c) => (c.eligibility ? c.eligibility.toUpperCase() : null);
// "27 / 36 · 75.0% · LALCO IQ 125 / 150 · Very High · PASS · Completed (pass mark 70%)"
const testLine = (t) => [t.score_text, t.percent_text, t.lalco_iq_score != null ? `LALCO IQ ${t.lalco_iq_score} / 150` : null, t.level,
  t.result && t.result !== 'Pending' ? RESULT_TEXT[t.result] : null, t.completion].filter(Boolean).join(' · ') + (t.pass_mark != null ? ` (pass mark ${t.pass_mark}%)` : '');
const showPct = (v) => (v == null ? '-' : v + '%');
// Dates in exports use Laos time (UTC+7), not the server's UTC clock.
const TIME_ZONE = process.env.DISPLAY_TIME_ZONE || 'Asia/Vientiane';
const localDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: TIME_ZONE }) : '');
const localDateTime = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' });
const showDate = (iso) => localDate(iso) || '-';

const columns = () => [
  ['Candidate Name', (c) => c.name],
  ['Phone Number', (c) => c.phone],
  ['Graduate From', (c) => c.graduate_from],
  ['High School', (c) => c.high_school],
  ['College', (c) => c.college],
  ['University', (c) => c.university],
  ['School Name', (c) => c.school_name],
  ['Subject', (c) => c.subject],
  ['GPA / Mark', (c) => c.gpa],
  ['Reference Results', (c) => c.reference_results],
  ['IQ Test Score', (c) => c.iq_text],
  ['IQ Weighted Score', (c) => c.iq_points],
  ['IQ Max Marks', (c) => c.iq_max],
  ['IQ %', (c) => c.iq_score],
  ['LALCO IQ Score', (c) => c.lalco_iq_score],
  ['IQ Category', (c) => c.iq_category],
  ['IQ Classification', (c) => c.iq_category],
  ['IQ Classification Range', (c) => c.iq_classification?.range],
  ['IQ Correct Answers', (c) => c.iq_correct_text],
  ...[1, 2, 3, 4, 5].flatMap((n) => [[`Level ${n} Correct`, (c) => levelText(c, n)?.correct_text], [`Level ${n} Marks`, (c) => levelText(c, n)?.marks_text],
    [`Level ${n} Max Marks`, (c) => levelText(c, n)?.max]]),
  ['Character', (c) => c.character_note],
  ['Test Score', (c) => c.test_score],
  ['General Test', (c) => c.general_score],
  ['Calculation Test', (c) => c.calc_score],
  ['Essay Test', (c) => (c.essay_pending ? 'Pending' : c.essay_score)],
  ...T.keys().filter((k) => k !== 'IQ').flatMap((sec) => {
    const t = (c) => (c.tests || []).find((x) => x.section === sec);
    const name = T.name(sec);
    return [[`${name} Score`, (c) => t(c)?.score_text], [`${name} Result`, (c) => t(c)?.text]];
  }),
  ['IQ Result', (c) => (c.tests || []).find((x) => x.section === 'IQ')?.text],
  ['IQ Level', (c) => testOf(c, 'IQ')?.level ?? c.iq_category],
  ...T.keys().flatMap((sec) => {
    const name = T.name(sec);
    return [
      ...(sec === 'IQ' ? [] : [[`${name} %`, (c) => testOf(c, sec)?.percent], [`${name} Level`, (c) => testOf(c, sec)?.level]]),
      [`${name} PASS / NOT PASS`, (c) => RESULT_TEXT[testOf(c, sec)?.result]],
      [`${name} Status`, (c) => testOf(c, sec)?.state],
      [`${name} Pass Mark %`, (c) => testOf(c, sec)?.pass_mark],
    ];
  }),
  ['Final %', (c) => c.final_percent],
  ['Final Level', (c) => c.final_level],
  ['Company Eligibility', (c) => eligibilityText(c)],
  ['Eligibility Note', (c) => c.eligibility_note],
  ['Assessment Link', (c) => c.assessment_link],
  ['Assessment Language', (c) => c.assessment_language],
  ['Current Stage', (c) => c.current_stage],
  ['Assessment Result', (c) => c.assessment_result],
  ['Interview', (c) => c.interview],
  ['Interviewer', (c) => c.interviewer],
  ['Interview Score', (c) => c.interview_score],
  ['Result', (c) => c.test_result],
  ['Remark', (c) => c.remark],
  ['Chairman Interview', (c) => c.chairman_interview],
  ['Final Result', (c) => c.final_result],
  ['Date Come to Work', (c) => c.date_come_to_work],
  ['Test Date', (c) => localDate(c.last_test_date)],
];

function reportSections(c) {
  return [
    ['Candidate Information', [
      ['Name', show(c.name)], ['Phone', show(c.phone)], ['Graduate From', show(c.graduate_from)],
      ['High School', show(c.high_school)], ['College', show(c.college)], ['University', show(c.university)],
      ['School Name', show(c.school_name)], ['Subject', show(c.subject)], ['GPA / Mark', show(c.gpa)],
    ]],
    ['Assessment Results', [
      ['Reference Results', show(c.reference_results)],
      ['IQ Weighted Score', c.iq_text ? `${c.iq_text} marks (${c.iq_score}%)` : '-'],
      ['LALCO IQ Score', c.lalco_iq_score != null ? `${c.lalco_iq_score} / 150` : '-'],
      ['IQ Classification', c.iq_classification ? `${c.iq_classification.description} (${c.iq_classification.range})` : '-'],
      ['IQ Percentage', c.iq_score != null ? Number(c.iq_score).toFixed(1) + '%' : '-'],
      ['IQ Correct Answers', show(c.iq_correct_text)],
      ...(c.iq_levels || []).map((l) => [l.label, `${l.correct_text} correct, ${l.marks_text} marks`]),
      ...(c.tests || []).map((t) => [t.name, `${testLine(t)} — ${t.text}`]),
      ['Assessment Language', show(c.assessment_language)],
      ['Current Stage', show(c.current_stage)],
      ['Assessment Result', show(c.assessment_result)],
      ['Character', show(c.character_note)],
      ['Test Score', showPct(c.test_score)], ['General Test', showPct(c.general_score)], ['Calculation Test', showPct(c.calc_score)],
      ['Essay Test', c.essay_pending ? 'Pending' : showPct(c.essay_score)], ['Result', show(c.test_result)], ['Test Date', showDate(c.last_test_date)],
    ]],
    ['Interview', [
      ['Interview', show(c.interview)], ['Interviewer', show(c.interviewer)], ['Interview Score', show(c.interview_score)],
      ['Remark', show(c.remark)], ['Chairman Interview', show(c.chairman_interview)],
    ]],
    ['Final Assessment', [
      ['Final Overall Score', c.final_percent_text || '-'],
      ['Final Level', show(c.final_level)],
      ['Company Eligibility', show(eligibilityText(c)) + (c.eligibility_note ? ` — ${c.eligibility_note}` : '')],
    ]],
    ['Decision', [
      ['HR Final Result', show(c.final_result)], ['Date Come to Work', show(c.date_come_to_work)],
    ]],
  ];
}

const NOTE = 'Scores are percentages of available marks. IQ Test Score = marks earned (Level 1 = 1 up to Level 5 = 5 per correct answer) out of the maximum; it is not a clinical IQ measurement. LALCO IQ Score: ' + LALCO_NOTE
  + ' Level: 90%+ Exceptional, 80%+ Very High, 70%+ High, 60%+ Average, 50%+ Low, below 50% Very Low for General, Calculation, Essay and the final score. IQ Classification (from the LALCO IQ Score): 130–150 Very superior, 120–129 Superior, 110–119 High average, 90–109 Average, 80–89 Low average, 70–79 Borderline, 0–69 Extremely low. PASS / NOT PASS uses each test\'s own pass mark. Final Overall Score = the average of the included tests\' percentages. Company Eligibility = every test passed and the final score reaches the eligibility mark. HR Final Result is HR\'s own decision.';

function candidatePdf(c) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Candidate report - ${c.name}` } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('main', FONT);
    doc.font('main');

    doc.fontSize(20).text('LALCO', { align: 'center' });
    doc.fontSize(13).fillColor('#555').text('HR Recruitment Assessment', { align: 'center' });
    doc.moveDown(1).fillColor('#000');

    const labelX = 50;
    const valueX = 200;
    for (const [title, rows] of reportSections(c)) {
      if (doc.y > 720) doc.addPage();
      doc.fontSize(12.5).fillColor('#1f4e79').text(title, labelX);
      doc.moveTo(labelX, doc.y + 1).lineTo(545, doc.y + 1).strokeColor('#cccccc').stroke();
      doc.moveDown(0.35).fontSize(10).fillColor('#000');
      for (const [k, v] of rows) {
        const y = doc.y;
        doc.fillColor('#555').text(k + ':', labelX, y, { width: 140 });
        const labelBottom = doc.y;
        doc.fillColor('#000').text(v, valueX, y, { width: 345 });
        doc.y = Math.max(doc.y, labelBottom) + 1;
      }
      doc.moveDown(0.6);
    }
    doc.fontSize(8.5).fillColor('#777').text(NOTE, labelX);
    doc.text(`Generated ${localDateTime(new Date().toISOString())}`, labelX);
    doc.end();
  });
}

async function candidateDocx(c) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, AlignmentType, BorderStyle } = docx;
  const font = 'Leelawadee UI'; // ships with Windows; covers Lao and Latin
  const para = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, font, ...opts })] });
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const children = [
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'LALCO', bold: true, size: 40, font })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: 'HR Recruitment Assessment', size: 26, color: '555555', font })] }),
  ];
  for (const [title, rows] of reportSections(c)) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: title, font, color: '1F4E79' })] }));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map(([k, v]) => new TableRow({
        children: [
          new TableCell({ borders, width: { size: 32, type: WidthType.PERCENTAGE }, children: [para(k, { color: '555555' })] }),
          new TableCell({ borders, width: { size: 68, type: WidthType.PERCENTAGE }, children: [para(v)] }),
        ],
      })),
    }));
  }
  children.push(new Paragraph({ spacing: { before: 300 }, children: [new TextRun({ text: NOTE, size: 16, color: '777777', font })] }));
  return Packer.toBuffer(new Document({ creator: 'LALCO HR', title: `Candidate report - ${c.name}`, sections: [{ children }] }));
}

function candidatesXlsx(candidates) {
  const COLUMNS = columns();
  const header = COLUMNS.map(([h]) => h);
  const rows = candidates.map((c) => COLUMNS.map(([, get]) => {
    const v = get(c);
    return v == null ? '' : v;
  }));
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  sheet['!cols'] = header.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Candidates');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function questionTemplateXlsx() {
  const rows = [
    ['Question', 'Type', 'Category', 'Difficulty', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer', 'Marks'],
    ['What number comes next: 2, 4, 8, 16, ?', 'IQ', 'Number pattern', 'Easy', '24', '32', '30', '20', 'B', 1],
    ['Which one is the odd one out?', 'IQ', 'Odd one out', 'Easy', 'Apple', 'Banana', 'Carrot', 'Mango', 'C', 1],
    ['What is 15% of 200?', 'Calculation', 'Percentage', 'Easy', '', '', '', '', '30', 1],
    ['Why do you want to work at LALCO?', 'Essay', 'Motivation', '', '', '', '', '', '', 10],
    ['What does HR stand for?', 'General', 'General knowledge', 'Easy', 'Human Resources', 'High Revenue', 'Home Rules', 'Hard Rate', 'A', 1],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 45 }, { wch: 12 }, { wch: 18 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 15 }, { wch: 7 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Questions');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { IQ_CLASSIFICATION, getIQClassification, testResults, percentLevel, finalAssessment, stageView, iqResult, lalcoIqScore, iqCategory, allCandidateSummaries, candidateSummary, dashboard, candidatePdf, candidateDocx, candidatesXlsx, questionTemplateXlsx };
