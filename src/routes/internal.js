// Internal Office Staff admin API (mounted at /api/admin/internal, admin login
// required). Its own staff records, links, results and reports; the assessment
// engine, scoring and exports are the shared ones. Nothing here reads or
// changes recruitment candidates, links or attempts.
const express = require('express');
const { db } = require('../db');
const A = require('../assessments');
const reports = require('../reports');
const staff = require('../internalStaff');
const IR = require('../internalReports');

const router = express.Router();
const AREA = staff.AREA;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const bad = (res, message) => res.status(400).json({ error: message });
const notFound = (res) => res.status(404).json({ error: 'Not found.' });
const staffError = (res, e) => (e instanceof staff.StaffError ? bad(res, e.message) : null);
const fileName = (name) => String(name || 'staff').replace(/[^\p{L}\p{N}\- ]+/gu, '').trim().replace(/\s+/g, '_') || 'staff';
const sendFile = (res, buffer, name, type) => {
  res.set('Content-Type', type);
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(buffer);
};
const internalLink = (id) => { const l = A.getLink(Number(id)); return l && l.business_area === AREA ? l : null; };
// The public address of an internal link (distinct from recruitment's /exam/<token>).
const linkOut = (l) => ({ ...A.linkView(l), business_area: AREA, url_path: '/internal-assessment/' + l.token });

// ---- dashboard -------------------------------------------------------------------

router.get('/dashboard', (req, res) => res.json(IR.dashboard()));

// ---- staff -----------------------------------------------------------------------

router.get('/staff', (req, res) => res.json({
  staff: staff.list({ q: String(req.query.q || '').trim(), department: req.query.department, position: req.query.position, status: req.query.status }),
  departments: staff.departments(), positions: staff.positions(),
}));
router.post('/staff', (req, res) => {
  try { res.status(201).json(staff.create(req.body || {}, req.admin.username)); } catch (e) { if (!staffError(res, e)) throw e; }
});
router.get('/staff/:id', (req, res) => {
  const s = staff.withStats(staff.byId(req.params.id));
  if (!s) return notFound(res);
  const attempts = db.prepare('SELECT * FROM assessments WHERE staff_id = ? AND business_area = ? ORDER BY COALESCE(submitted_at, started_at) DESC, id DESC').all(s.id, AREA);
  res.json({ staff: s, results: attempts.map(IR.resultRow) });
});
router.put('/staff/:id', (req, res) => {
  try { const s = staff.update(req.params.id, req.body || {}, req.admin.username); if (!s) return notFound(res); res.json(s); } catch (e) { if (!staffError(res, e)) throw e; }
});
// Deletes the staff record and their attempts (like deleting a recruitment candidate).
router.delete('/staff/:id', (req, res) => {
  const r = staff.remove(req.params.id, req.admin.username);
  if (!r) return notFound(res);
  res.json(r);
});

// ---- assessment links --------------------------------------------------------------

router.get('/links', (req, res) => res.json(IR.links().map((l) => ({ ...l, url_path: '/internal-assessment/' + l.token }))));
router.post('/links', (req, res) => {
  res.status(201).json(linkOut(A.createAssessment(req.body || {}, { area: AREA })));
});
router.get('/links/:id', (req, res) => {
  const l = internalLink(req.params.id);
  if (!l) return notFound(res);
  res.json({ link: linkOut(l), results: IR.results({ link_id: l.id }) });
});
// Disable = no NEW employee can start; employees already in a test carry on.
router.post('/links/:id/:action(enable|disable)', (req, res) => {
  const info = db.prepare('UPDATE assessment_links SET enabled = ? WHERE id = ? AND business_area = ?').run(req.params.action === 'enable' ? 1 : 0, Number(req.params.id), AREA);
  if (!info.changes) return notFound(res);
  res.json(linkOut(A.getLink(Number(req.params.id))));
});
// A new URL, only while nobody has used the link (employees resume through it).
router.post('/links/:id/regenerate', (req, res) => {
  const l = internalLink(req.params.id);
  if (!l) return notFound(res);
  if (A.linkView(l).candidates > 0) return bad(res, 'Staff have already used this link, so its address cannot change. Disable it and create a new link instead.');
  db.prepare('UPDATE assessment_links SET token = ?, link_expires_at = ?, enabled = 1 WHERE id = ?')
    .run(require('crypto').randomBytes(24).toString('base64url'), new Date(Date.now() + l.link_expiry_minutes * 60000).toISOString(), l.id);
  res.json(linkOut(A.getLink(l.id)));
});
// Only an unused link can be deleted; one with results is kept (disable it instead).
router.delete('/links/:id', (req, res) => {
  const l = internalLink(req.params.id);
  if (!l) return notFound(res);
  if (A.linkView(l).candidates > 0) return bad(res, 'Staff have used this link, so it is kept with their results. Disable it instead.');
  db.prepare('DELETE FROM assessment_links WHERE id = ?').run(l.id);
  res.json({ ok: true });
});

// ---- results -------------------------------------------------------------------

router.get('/results', (req, res) => res.json({ fields: IR.FIELDS,
  results: IR.results({ q: String(req.query.q || '').trim(), department: req.query.department, link_id: req.query.link_id, status: req.query.status }) }));

// One result in detail: the same review data as a recruitment attempt, with the staff record.
router.get('/results/:id', (req, res) => {
  const a = IR.attempt(req.params.id);
  if (!a) return notFound(res);
  const stages = A.stagesOf(a);
  const link = a.link_id ? A.getLink(a.link_id) : null;
  let entered = null;
  try { entered = a.staff_details ? JSON.parse(a.staff_details) : null; } catch { entered = null; }
  res.json({ assessment: { ...a, state: A.linkState(a), current_stage: A.currentStage(a, stages) }, stages,
    link: link ? { id: link.id, title: link.title, token: link.token } : null,
    tests: stages.map((st) => reports.stageView(a, st, stages)), final: reports.finalAssessment(a, stages), iq: reports.iqResult(a),
    staff: a.staff_id ? staff.byId(a.staff_id) : null, entered_details: entered, row: IR.resultRow(a),
    questions: db.prepare('SELECT * FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(a.id) });
});
router.put('/results/:id/essay-marks', (req, res) => {
  if (!IR.attempt(req.params.id)) return notFound(res);
  const a = A.setEssayMarks(Number(req.params.id), req.body?.marks);
  res.json({ ...a, state: A.linkState(a) });
});
router.get('/results/:id/export.:format', (req, res, next) => {
  const a = IR.attempt(req.params.id);
  if (!a) return notFound(res);
  const row = IR.resultRow(a);
  const base = 'LALCO_Staff_' + fileName(row.values[0]);
  const build = {
    pdf: async () => sendFile(res, await IR.resultPdf(row), base + '.pdf', 'application/pdf'),
    docx: async () => sendFile(res, await IR.resultWord(row), base + '.docx', DOCX_TYPE),
    xlsx: async () => sendFile(res, await IR.resultsXlsx([row]), base + '.xlsx', XLSX_TYPE),
  }[req.params.format];
  if (!build) return notFound(res);
  build().catch(next);
});

// The Internal Staff report: every internal result, one row each (never recruitment).
router.get('/export/results.xlsx', async (req, res, next) => {
  try {
    const rows = IR.results({ department: req.query.department, link_id: req.query.link_id, status: req.query.status });
    sendFile(res, await IR.resultsXlsx(rows), `LALCO_Internal_Staff_Results_${new Date().toISOString().slice(0, 10)}.xlsx`, XLSX_TYPE);
  } catch (e) { next(e); }
});

module.exports = router;
