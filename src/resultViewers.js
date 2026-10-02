// Result Viewer accounts: a separate, read-only login for ONE person (a
// recruitment candidate or an internal staff member) to see their OWN results.
//
// - Not an admin: its own cookie (lalco_result_session, sent only to
//   /api/results), its own signing key (auth.scopedSecret), so a viewer token
//   is never accepted by the admin API and an admin token never here.
// - The person is taken from the account on the server; no candidate, staff
//   or assessment id from the browser is ever used.
// - Results are READ from the existing scoring (reports.stageView /
//   finalAssessment, the same report status HR sees); nothing is recalculated,
//   and no question, answer or HR guidance is ever sent.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const { db, now } = require('./db');
const auth = require('./auth');
const A = require('./assessments');
const T = require('./testTypes');
const reports = require('./reports');
const SR = require('./standardReport');
const IR = require('./internalReports');

const COOKIE = 'lalco_result_session';
const COOKIE_PATH = '/api/results';
const SECRET = auth.scopedSecret('result-viewer');
const AUDIENCE = 'result-viewer';

class ViewerError extends Error {}

// ---- accounts (managed by HR in the admin API) -----------------------------------

const USERNAME_RE = /^[A-Za-z0-9._@-]{3,50}$/;
function checkUsername(u) {
  const username = String(u || '').trim();
  if (!USERNAME_RE.test(username)) throw new ViewerError('Username: 3-50 characters, letters, numbers and . _ @ - only.');
  return username;
}
function checkPassword(p) {
  const password = String(p || '');
  if (password.length < 8) throw new ViewerError('Password must be at least 8 characters.');
  if (password.length > 200) throw new ViewerError('Password is too long.');
  return password;
}
const audit = (action, adminName, details) => db.prepare('INSERT INTO audit_log (action, admin, details, created_at) VALUES (?, ?, ?, ?)')
  .run(action, adminName, JSON.stringify(details), now());

// One account as HR sees it (never the password hash).
function view(r) {
  if (!r) return null;
  const person = r.candidate_id ? db.prepare('SELECT id, name, phone FROM candidates WHERE id = ?').get(r.candidate_id)
    : db.prepare('SELECT id, name, employee_id, phone FROM internal_staff WHERE id = ?').get(r.staff_id);
  return { id: r.id, username: r.username, active: !!r.active, person_type: r.candidate_id ? 'candidate' : 'staff',
    person_id: r.candidate_id || r.staff_id, person_name: person ? person.name : null, person_ref: person ? (r.candidate_id ? person.phone : person.employee_id) : null,
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, last_login_at: r.last_login_at };
}
const byId = (id) => db.prepare('SELECT * FROM result_viewers WHERE id = ?').get(Number(id));
const list = () => db.prepare('SELECT * FROM result_viewers ORDER BY created_at DESC, id DESC').all().map(view);

function create(input, adminName) {
  const username = checkUsername(input.username);
  const password = checkPassword(input.password);
  const candidateId = input.candidate_id != null && input.candidate_id !== '' ? Number(input.candidate_id) : null;
  const staffId = input.staff_id != null && input.staff_id !== '' ? Number(input.staff_id) : null;
  if ((candidateId == null) === (staffId == null)) throw new ViewerError('Choose the candidate or the staff member this account belongs to.');
  if (candidateId != null && !db.prepare('SELECT 1 FROM candidates WHERE id = ?').get(candidateId)) throw new ViewerError('That candidate was not found.');
  if (staffId != null && !db.prepare('SELECT 1 FROM internal_staff WHERE id = ?').get(staffId)) throw new ViewerError('That staff member was not found.');
  if (db.prepare('SELECT 1 FROM result_viewers WHERE username = ?').get(username)) throw new ViewerError('That username is already used.');
  const stamp = now();
  const id = db.prepare(`INSERT INTO result_viewers (username, password_hash, candidate_id, staff_id, active, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(username, bcrypt.hashSync(password, 12), candidateId, staffId, adminName, stamp, stamp).lastInsertRowid;
  audit('RESULT_VIEWER_CREATED', adminName, { id, username, candidate_id: candidateId, staff_id: staffId });
  return view(byId(id));
}

// Disable / enable: a disabled account cannot log in, and its open sessions stop at once.
function setActive(id, active, adminName) {
  const r = byId(id);
  if (!r) return null;
  db.prepare('UPDATE result_viewers SET active = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?').run(active ? 1 : 0, now(), r.id);
  audit(active ? 'RESULT_VIEWER_ENABLED' : 'RESULT_VIEWER_DISABLED', adminName, { id: r.id, username: r.username });
  return view(byId(r.id));
}

// A new password (HR never sees the old one); open sessions end.
function resetPassword(id, password, adminName) {
  const r = byId(id);
  if (!r) return null;
  db.prepare('UPDATE result_viewers SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?').run(bcrypt.hashSync(checkPassword(password), 12), now(), r.id);
  audit('RESULT_VIEWER_PASSWORD_RESET', adminName, { id: r.id, username: r.username });
  return view(byId(r.id));
}

// Deletes the LOGIN only; the person and their results are untouched.
function remove(id, adminName) {
  const r = byId(id);
  if (!r) return null;
  db.prepare('DELETE FROM result_viewers WHERE id = ?').run(r.id);
  audit('RESULT_VIEWER_DELETED', adminName, { id: r.id, username: r.username });
  return { ok: true };
}

// ---- login / session -------------------------------------------------------------

function setCookie(res, token) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: auth.IS_PRODUCTION, maxAge: auth.SESSION_HOURS * 3600 * 1000, path: COOKIE_PATH });
}

function login(req, res) {
  const ip = req.ip;
  if (auth.tooManyFailures(ip)) return res.status(429).json({ error: 'Too many failed attempts. Please wait 15 minutes.' });
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const r = username ? db.prepare('SELECT * FROM result_viewers WHERE username = ?').get(username) : null;
  if (!r || !bcrypt.compareSync(password, r.password_hash)) {
    auth.recordFailure(ip);
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  if (!r.active) return res.status(403).json({ error: 'This account has been disabled. Please contact HR.' });
  auth.clearFailures(ip);
  db.prepare('UPDATE result_viewers SET last_login_at = ? WHERE id = ?').run(now(), r.id);
  const token = jwt.sign({ sub: r.id, tv: r.token_version, jti: crypto.randomBytes(16).toString('hex') }, SECRET, { expiresIn: `${auth.SESSION_HOURS}h`, audience: AUDIENCE });
  setCookie(res, token);
  res.json({ username: r.username }); // nothing about the person or their results
}

function logout(req, res) {
  const token = auth.readCookie(req, COOKIE);
  if (token) {
    try { const p = jwt.verify(token, SECRET, { audience: AUDIENCE }); if (p.jti) auth.revokeToken(p.jti, p.exp); } catch { /* already invalid */ }
  }
  res.clearCookie(COOKIE, { path: COOKIE_PATH });
  res.json({ ok: true });
}

// Only a valid, active Result Viewer session passes; req.viewer is the account row.
function requireViewer(req, res, next) {
  const token = auth.readCookie(req, COOKIE);
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  try {
    const p = jwt.verify(token, SECRET, { audience: AUDIENCE });
    const r = byId(p.sub);
    if (!r || !r.active || r.token_version !== p.tv || auth.isRevoked(p.jti)) return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
    req.viewer = r;
    next();
  } catch {
    return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
  }
}

// ---- the person's own results (read only) --------------------------------------

const LEVEL_LO = { Exceptional: 'ດີເລີດ', 'Very High': 'ສູງຫຼາຍ', High: 'ສູງ', Average: 'ປານກາງ', Low: 'ຕ່ຳ', 'Very Low': 'ຕ່ຳຫຼາຍ' };
const testTitleLo = (key) => { const t = T.get(key); return (t && t.name_lo) || null; };

// One test of a finished assessment, from the existing stage result (stageView).
function testRow(v) {
  const status = v.state === 'PASS' ? 'PASS' : v.state === 'NOT PASS' ? 'NOT PASS' : v.state === 'PENDING HR MARKING' ? 'PENDING' : 'NOT TAKEN';
  const scored = status === 'PASS' || status === 'NOT PASS';
  const iq = v.section === 'IQ';
  const level = scored ? v.level : null;
  return {
    testType: v.section, test: v.name, test_lo: testTitleLo(v.section), status,
    // IQ: the LALCO IQ Score (out of 150) and the raw weighted marks; other tests: marks.
    score: scored ? (iq ? v.lalco_iq_score : v.points) : null,
    maximum: scored ? (iq ? 150 : v.max) : null,
    score_text: scored ? (iq ? `${v.lalco_iq_score} / 150` : `${v.points} / ${v.max}`) : null,
    raw_score_text: scored && iq ? `${v.points} / ${v.max}` : null,
    percentage: scored ? v.percent : null,
    level,
    level_lo: !level ? null : iq ? (reports.getIQClassification(v.lalco_iq_score) || {}).description_lo || null : LEVEL_LO[level] || null,
  };
}

function personOf(r) {
  if (r.candidate_id) {
    const c = db.prepare('SELECT name, phone FROM candidates WHERE id = ?').get(r.candidate_id);
    return c ? { candidateName: c.name, phone: c.phone || null, employeeId: null } : null;
  }
  const s = db.prepare('SELECT name, phone, employee_id FROM internal_staff WHERE id = ?').get(r.staff_id);
  return s ? { candidateName: s.name, phone: s.phone || null, employeeId: s.employee_id } : null;
}

// Every FINISHED assessment of the account's own person, newest first.
function resultsFor(r) {
  const person = personOf(r);
  if (!person) return null;
  A.finalizeExpired(); // a test whose time ran out is scored before it is shown (as on HR's pages)
  const rows = r.candidate_id
    ? db.prepare("SELECT * FROM assessments WHERE candidate_id = ? AND business_area = 'RECRUITMENT' AND status = 'SUBMITTED' ORDER BY COALESCE(submitted_at, started_at) DESC, id DESC").all(r.candidate_id)
    : db.prepare("SELECT * FROM assessments WHERE staff_id = ? AND business_area = 'INTERNAL_STAFF' AND status = 'SUBMITTED' ORDER BY COALESCE(submitted_at, started_at) DESC, id DESC").all(r.staff_id);
  const assessments = rows.map((a) => {
    const stages = A.stagesOf(a);
    // Overall result: the same status HR sees (recruitment: Company Eligibility, as in the standard report; internal: the internal results status).
    const overallStatus = r.candidate_id ? SR.eligibilityStatus(reports.finalAssessment(a, stages).eligibility) : IR.statusOf(a);
    return { assessmentDate: SR.stamp(a.submitted_at || a.started_at), overallStatus, tests: stages.map((st) => testRow(reports.stageView(a, st, stages))) };
  });
  const latest = assessments[0] || null;
  return { ...person, assessmentDate: latest && latest.assessmentDate, overallStatus: latest && latest.overallStatus, tests: latest ? latest.tests : [], assessments };
}

// The person's own results as Excel: one row per test (and the overall result), nothing else.
async function resultsXlsx(data) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('My Results', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    { header: 'Candidate Name', key: 'name', width: 28 }, { header: 'Phone Number', key: 'phone', width: 16 }, { header: 'Assessment Date', key: 'date', width: 18 },
    { header: 'Test', key: 'test', width: 30 }, { header: 'Status', key: 'status', width: 12 }, { header: 'Score', key: 'score', width: 14 },
    { header: 'Percentage', key: 'pct', width: 12 }, { header: 'Level', key: 'level', width: 18 },
  ];
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  for (const a of data.assessments) {
    for (const t of a.tests) {
      const row = sheet.addRow({ name: data.candidateName, phone: data.phone || data.employeeId || '', date: a.assessmentDate, test: t.test, status: t.status,
        score: t.score_text || (t.status === 'PENDING' ? 'Pending' : '—'), pct: t.percentage != null ? t.percentage / 100 : (t.status === 'PENDING' ? 'Pending' : '—'), level: t.level || '—' });
      if (t.percentage != null) row.getCell('pct').numFmt = '0.0%';
    }
    const overall = sheet.addRow({ name: data.candidateName, phone: data.phone || data.employeeId || '', date: a.assessmentDate, test: 'OVERALL RESULT', status: a.overallStatus, score: '', pct: '', level: '' });
    overall.font = { bold: true };
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: 8 } };
  return Buffer.from(await book.xlsx.writeBuffer());
}

module.exports = { COOKIE, ViewerError, list, byId, view, create, setActive, resetPassword, remove, login, logout, requireViewer, resultsFor, resultsXlsx };
