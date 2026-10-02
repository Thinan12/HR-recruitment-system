// Internal Office Staff dashboard, results and reports. Only INTERNAL_STAFF
// links and attempts are read here; scores come from the shared engine
// (reports.testResults), exports from the shared writers (standardReport).
const { db } = require('./db');
const A = require('./assessments');
const reports = require('./reports');
const SR = require('./standardReport');
const staff = require('./internalStaff');

const AREA = staff.AREA;
const FIELDS = ['Staff Name', 'Employee ID', 'Department', 'Position', 'Assessment', 'IQ Test Score', 'Behavioral Interview Test Score',
  'Calculation Score', 'Essay Score', 'Pass / Not Pass Status', 'Date and Time'];
const STATUS_COL = 9;

// The Behavioral Interview Test score: the attempt's behavioural / interview-format test.
function behaviouralTest(tests) {
  return tests.find((t) => A.T.behavior(t.section) === 'interview') || null;
}

// Pass / Not Pass Status of one internal attempt (the Status column HR sees).
const statusOf = (a) => (a.status === 'SUBMITTED' ? SR.STATUS[a.result] || 'PENDING' : a.status === 'IN_PROGRESS' ? 'IN PROGRESS' : 'NOT STARTED');

// One attempt as a results row (values in FIELDS order) with its details.
function resultRow(a) {
  const s = a.staff_id ? staff.byId(a.staff_id) : null;
  const link = a.link_id ? A.getLink(a.link_id) : null;
  const r = reports.testResults(a);
  const byKey = (k) => r.tests.find((t) => t.section === k) || null;
  const text = (v) => (v == null || String(v).trim() === '' ? SR.NONE : String(v));
  const iq = byKey('IQ');
  const beh = behaviouralTest(r.tests);
  const status = statusOf(a);
  const values = [
    text(s && s.name), text(s && s.employee_id), text(s && s.department), text(s && s.position), text(link && link.title),
    SR.score(iq, (t) => (t.lalco_iq_score != null ? `${t.lalco_iq_score} / 150` : t.score_text || SR.NONE)),
    SR.score(beh, (t) => t.percent_text || SR.NONE),
    SR.score(byKey('CALCULATION'), (t) => t.percent_text || SR.NONE),
    SR.score(byKey('ESSAY'), (t) => t.score_text || SR.NONE),
    status,
    SR.stamp(a.submitted_at || a.started_at),
  ];
  const pct = (t) => (t && t.status === 'SUBMITTED' && t.result !== 'Pending' && t.percent != null ? t.percent / 100 : null);
  return {
    id: a.id, staff_id: a.staff_id, link_id: a.link_id, status: a.status, state: A.linkState(a), result: a.result,
    started_at: a.started_at, submitted_at: a.submitted_at,
    staff: s ? { id: s.id, name: s.name, employee_id: s.employee_id, department: s.department, position: s.position } : null,
    assessment: link ? { id: link.id, title: link.title } : null,
    tests: r.tests, current_stage: r.current_stage, final_percent: r.final_percent, final_level: r.final_level,
    values, numbers: { 6: pct(beh), 7: pct(byKey('CALCULATION')) },
  };
}

// Every internal attempt (newest first), with optional filters.
function results({ q, department, link_id: linkId, status } = {}) {
  A.finalizeExpired(); // a test whose time ran out is scored before it is listed
  const where = ['a.business_area = ?'];
  const args = [AREA];
  if (q) { where.push('(s.name LIKE ? OR s.employee_id LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (department) { where.push('s.department = ?'); args.push(department); }
  if (/^\d+$/.test(String(linkId || ''))) { where.push('a.link_id = ?'); args.push(Number(linkId)); }
  if (['SUBMITTED', 'IN_PROGRESS'].includes(status)) { where.push('a.status = ?'); args.push(status); }
  if (['Pass', 'Not Pass', 'Pending'].includes(status)) { where.push("a.status = 'SUBMITTED' AND a.result = ?"); args.push(status); }
  return db.prepare(`SELECT a.* FROM assessments a LEFT JOIN internal_staff s ON s.id = a.staff_id
    WHERE ${where.join(' AND ')} ORDER BY COALESCE(a.submitted_at, a.started_at, a.created_at) DESC, a.id DESC`).all(...args).map(resultRow);
}

// Internal links with their started / completed counts.
const links = () => db.prepare('SELECT * FROM assessment_links WHERE business_area = ? ORDER BY created_at DESC, id DESC').all(AREA).map(A.linkView);

function dashboard() {
  A.finalizeExpired();
  const n = (sql, ...args) => db.prepare(sql).get(...args).n;
  const all = links();
  const open = all.filter((l) => l.share_state === 'open');
  const week = Date.now() + 7 * 86400 * 1000;
  const brief = (r) => ({ id: r.id, staff: r.staff, assessment: r.assessment, status: r.status, result: r.result, started_at: r.started_at, submitted_at: r.submitted_at, values: r.values });
  const recent = results().slice(0, 8);
  return {
    totalStaff: n('SELECT COUNT(*) AS n FROM internal_staff'),
    totalAssessments: n('SELECT COUNT(*) AS n FROM assessments WHERE business_area = ?', AREA),
    activeLinks: open.length,
    completed: n("SELECT COUNT(*) AS n FROM assessments WHERE business_area = ? AND status = 'SUBMITTED'", AREA),
    inProgress: n("SELECT COUNT(*) AS n FROM assessments WHERE business_area = ? AND status = 'IN_PROGRESS'", AREA),
    // Submitted, waiting for HR to mark an essay / interview answer.
    pending: n("SELECT COUNT(*) AS n FROM assessments WHERE business_area = ? AND status = 'SUBMITTED' AND result = 'Pending'", AREA),
    passed: n("SELECT COUNT(*) AS n FROM assessments WHERE business_area = ? AND status = 'SUBMITTED' AND result = 'Pass'", AREA),
    notPassed: n("SELECT COUNT(*) AS n FROM assessments WHERE business_area = ? AND status = 'SUBMITTED' AND result = 'Not Pass'", AREA),
    recentAssessments: recent.map(brief),
    recentResults: results({ status: 'SUBMITTED' }).slice(0, 8).map(brief),
    activeLinksList: open.slice(0, 10).map((l) => ({ id: l.id, title: l.title, link_expires_at: l.link_expires_at, started: l.candidates, completed: l.finished })),
    expiringLinks: open.filter((l) => Date.parse(l.link_expires_at) < week).sort((a, b) => a.link_expires_at.localeCompare(b.link_expires_at))
      .map((l) => ({ id: l.id, title: l.title, link_expires_at: l.link_expires_at })),
  };
}

// An internal attempt (null for a recruitment one: the areas never mix).
const attempt = (id) => { const a = A.getAssessment(Number(id)); return a && a.business_area === AREA ? a : null; };

const resultsXlsx = (rows) => SR.tableXlsx({ sheet: 'Internal Staff Results', fields: FIELDS, rows, statusCol: STATUS_COL, pctCols: [6, 7], wide: [0, 4, 10] });
const resultPdf = (row) => SR.recordPdf({ title: `Internal staff result - ${row.values[0]}`, subtitle: 'Internal Staff Assessment Result', fields: FIELDS, values: row.values, statusCol: STATUS_COL });
const resultWord = (row) => SR.recordWord({ title: `Internal staff result - ${row.values[0]}`, subtitle: 'Internal Staff Assessment Result', fields: FIELDS, values: row.values, statusCol: STATUS_COL });

module.exports = { FIELDS, resultRow, results, links, dashboard, attempt, resultsXlsx, resultPdf, resultWord, statusOf };
