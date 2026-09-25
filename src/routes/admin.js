// Admin API. Every route below requireAdmin needs a logged-in administrator.
const express = require('express');
const multer = require('multer');
const { db, getSettings, saveSettings, now } = require('../db');
const auth = require('../auth');
const A = require('../assessments');
const reports = require('../reports');
const { parseFile, validateQuestion, ImportError, IMAGE_KEYS } = require('../importer');
const images = require('../images');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

router.post('/auth/login', auth.login);
router.post('/auth/logout', auth.logout);
router.use(auth.requireAdmin);
router.get('/auth/me', (req, res) => res.json({ username: req.admin.username }));
router.post('/auth/password', auth.changePassword);

const bad = (res, message) => res.status(400).json({ error: message });
const notFound = (res) => res.status(404).json({ error: 'Not found.' });
const fileName = (name) => String(name || 'candidate').replace(/[^\p{L}\p{N}\- ]+/gu, '').trim().replace(/\s+/g, '_') || 'candidate';
const sendFile = (res, buffer, name, type) => {
  res.set('Content-Type', type);
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(buffer);
};
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ---- dashboard ---------------------------------------------------------

router.get('/dashboard', (req, res) => res.json(reports.dashboard()));

// ---- candidates --------------------------------------------------------

const CANDIDATE_TEXT_FIELDS = ['name', 'phone', 'graduate_from', 'high_school', 'college', 'university', 'school_name', 'subject', 'gpa',
  'reference_results', 'character_note', 'interview', 'interviewer', 'remark', 'chairman_interview', 'date_come_to_work'];
const FINAL_RESULTS = ['Pending', 'Pass', 'Not Pass'];

function cleanCandidate(body) {
  const c = {};
  for (const f of CANDIDATE_TEXT_FIELDS) c[f] = String(body?.[f] ?? '').trim().slice(0, 2000);
  if (!c.name) throw new A.InputError('Candidate name is required.');
  const score = body?.interview_score;
  c.interview_score = score === '' || score == null ? null : Number(score);
  if (c.interview_score != null && (!Number.isFinite(c.interview_score) || c.interview_score < 0 || c.interview_score > 100)) {
    throw new A.InputError('Interview score must be between 0 and 100.');
  }
  c.final_result = FINAL_RESULTS.includes(body?.final_result) ? body.final_result : 'Pending';
  return c;
}

router.get('/candidates', (req, res) => res.json(reports.allCandidateSummaries(req.query.q)));

router.post('/candidates', (req, res) => {
  const c = cleanCandidate(req.body);
  const stamp = now();
  const cols = Object.keys(c);
  const id = db.prepare(`INSERT INTO candidates (${cols.join(', ')}, created_at, updated_at) VALUES (${cols.map((k) => '@' + k).join(', ')}, @stamp, @stamp)`)
    .run({ ...c, stamp }).lastInsertRowid;
  res.status(201).json(reports.candidateSummary(id));
});

router.get('/candidates/:id', (req, res) => {
  const c = reports.candidateSummary(Number(req.params.id));
  if (!c) return notFound(res);
  const assessments = db.prepare('SELECT * FROM assessments WHERE candidate_id = ? ORDER BY created_at DESC, id DESC').all(c.id)
    .map((a) => ({ ...a, state: A.linkState(a) }));
  res.json({ candidate: c, assessments });
});

router.put('/candidates/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM candidates WHERE id = ?').get(id)) return notFound(res);
  const c = cleanCandidate(req.body);
  const sets = Object.keys(c).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE candidates SET ${sets}, updated_at = @stamp WHERE id = @id`).run({ ...c, stamp: now(), id });
  res.json(reports.candidateSummary(id));
});

router.delete('/candidates/:id', (req, res) => {
  const info = db.prepare('DELETE FROM candidates WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return notFound(res);
  res.json({ ok: true });
});

router.get('/candidates/:id/export.:format', (req, res, next) => {
  const c = reports.candidateSummary(Number(req.params.id));
  if (!c) return notFound(res);
  const base = 'LALCO_' + fileName(c.name);
  const build = {
    pdf: async () => sendFile(res, await reports.candidatePdf(c), base + '.pdf', 'application/pdf'),
    docx: async () => sendFile(res, await reports.candidateDocx(c), base + '.docx', DOCX_TYPE),
    xlsx: async () => sendFile(res, reports.candidatesXlsx([c]), base + '.xlsx', XLSX_TYPE),
  }[req.params.format];
  if (!build) return notFound(res);
  build().catch(next);
});

// Every submitted test that had IQ questions, newest first.
router.get('/results/iq', (req, res) => {
  const rows = db.prepare(`SELECT a.id, a.candidate_id, c.name AS candidate_name, a.iq_correct, a.iq_total, a.iq_points, a.iq_max,
      a.iq_breakdown, a.submitted_at, a.assessment_type
    FROM assessments a LEFT JOIN candidates c ON c.id = a.candidate_id
    WHERE a.status = 'SUBMITTED' AND a.iq_max IS NOT NULL ORDER BY a.submitted_at DESC`).all();
  res.json(rows.map((r) => ({
    ...r,
    iq_percent: r.iq_max ? Math.round((r.iq_points / r.iq_max) * 1000) / 10 : null,
    iq_breakdown: r.iq_breakdown ? JSON.parse(r.iq_breakdown) : null,
  })));
});

router.get('/export/candidates.xlsx', (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  sendFile(res, reports.candidatesXlsx(reports.allCandidateSummaries()), `LALCO_All_Candidates_${stamp}.xlsx`, XLSX_TYPE);
});

// ---- questions ---------------------------------------------------------

router.get('/questions', (req, res) => {
  const where = [];
  const args = [];
  if (A.SECTIONS.includes(req.query.section)) { where.push('section = ?'); args.push(req.query.section); }
  if (req.query.q) {
    where.push('(question_text LIKE ? OR category LIKE ?)');
    args.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }
  const sql = 'SELECT * FROM questions' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC';
  res.json({ questions: db.prepare(sql).all(...args), counts: A.activeCounts() });
});

const QUESTION_COLS = ['section', 'category', 'difficulty', 'question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'option_e',
  'correct_answer', 'marks', ...IMAGE_KEYS];
const insertQuestion = db.prepare(`INSERT INTO questions (${QUESTION_COLS.join(', ')}, status, created_at)
  VALUES (${QUESTION_COLS.map((c) => '@' + c).join(', ')}, 'Active', @created_at)`);

function checkedQuestion(body) {
  const { question, errors } = validateQuestion(body);
  for (const key of IMAGE_KEYS) if (question[key] && !images.imageExists(question[key])) errors.push('A picture could not be found. Please upload it again.');
  if (errors.length) throw new A.InputError(errors.join(' '));
  return question;
}

router.post('/questions', (req, res) => {
  const q = checkedQuestion(req.body);
  const id = insertQuestion.run({ ...q, created_at: now() }).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
});

router.put('/questions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM questions WHERE id = ?').get(id)) return notFound(res);
  const q = checkedQuestion(req.body);
  const status = req.body?.status === 'Inactive' ? 'Inactive' : 'Active';
  db.prepare(`UPDATE questions SET ${QUESTION_COLS.map((c) => `${c} = @${c}`).join(', ')}, status = @status WHERE id = @id`).run({ ...q, status, id });
  res.json(db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
});

// Past assessments keep their own copy of each question, so deleting is safe.
router.delete('/questions/:id', (req, res) => {
  const info = db.prepare('DELETE FROM questions WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return notFound(res);
  res.json({ ok: true });
});

// Pictures for questions and options. Upload returns an id to put on the question.
router.post('/images', (req, res) => {
  try {
    res.status(201).json({ id: images.saveDataUrl(req.body?.data_url) });
  } catch (e) {
    if (e instanceof images.ImageError) return bad(res, e.message);
    throw e;
  }
});
router.get('/images/:id', (req, res) => images.sendImage(res, Number(req.params.id)));

router.get('/questions/counts', (req, res) => res.json(A.activeCounts()));

router.get('/questions/template.xlsx', (req, res) => {
  sendFile(res, reports.questionTemplateXlsx(), 'LALCO_Question_Template.xlsx', XLSX_TYPE);
});

// The same question uploaded twice would let one candidate see it twice.
function existingQuestionKeys() {
  return new Set(db.prepare('SELECT * FROM questions').all().map(A.questionKey));
}

// Step 1: read the file and show what was found. Nothing is saved yet.
router.post('/questions/import/preview', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return bad(res, err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB.' : 'Unable to read the uploaded file.');
    if (!req.file) return bad(res, 'Please choose a file.');
    try {
      const defaultSection = A.SECTIONS.includes(req.body.section) ? req.body.section : 'GENERAL';
      const rows = await parseFile(req.file.buffer, req.file.originalname, defaultSection);
      const seen = existingQuestionKeys();
      for (const r of rows) {
        if (r.errors.length) continue;
        const key = A.questionKey(r.question);
        if (seen.has(key)) r.errors.push('This question is already in the question bank (or repeated in this file).');
        seen.add(key);
      }
      const valid = rows.filter((r) => r.errors.length === 0);
      const bySection = Object.fromEntries(A.SECTIONS.map((s) => [s, valid.filter((r) => r.question.section === s).length]));
      res.json({ found: rows.length, valid: valid.length, invalid: rows.length - valid.length, by_section: bySection, rows });
    } catch (e) {
      if (e instanceof ImportError) return bad(res, e.message);
      next(e);
    }
  });
});

// Step 2: save the rows the admin confirmed. Each row is validated again.
router.post('/questions/import', (req, res) => {
  const rows = Array.isArray(req.body?.questions) ? req.body.questions : [];
  if (rows.length === 0) return bad(res, 'There are no valid questions to import.');
  if (rows.length > 2000) return bad(res, 'Please import at most 2000 questions at a time.');
  const created = now();
  let imported = 0;
  let skipped = 0;
  db.transaction(() => {
    const seen = existingQuestionKeys();
    for (const row of rows) {
      const { question, errors } = validateQuestion(row);
      const key = A.questionKey(question);
      if (errors.length || seen.has(key)) { skipped++; continue; }
      seen.add(key);
      insertQuestion.run({ ...question, created_at: created });
      imported++;
    }
  })();
  res.json({ imported, skipped });
});

// ---- assessments -------------------------------------------------------

router.get('/assessments', (req, res) => {
  const rows = db.prepare(`SELECT a.*, c.name AS candidate_name FROM assessments a
    LEFT JOIN candidates c ON c.id = a.candidate_id ORDER BY a.created_at DESC, a.id DESC`).all();
  res.json(rows.map((a) => ({ ...a, state: A.linkState(a) })));
});

router.post('/assessments', (req, res) => {
  const a = A.createAssessment(req.body || {});
  res.status(201).json({ ...a, state: A.linkState(a) });
});

router.get('/assessments/:id', (req, res) => {
  const a = A.getAssessment(Number(req.params.id));
  if (!a) return notFound(res);
  const candidate = a.candidate_id ? db.prepare('SELECT id, name, phone FROM candidates WHERE id = ?').get(a.candidate_id) : null;
  const questions = db.prepare('SELECT * FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(a.id);
  res.json({ assessment: { ...a, state: A.linkState(a) }, candidate, questions });
});

router.post('/assessments/:id/:action(enable|disable)', (req, res) => {
  const info = db.prepare('UPDATE assessments SET enabled = ? WHERE id = ?').run(req.params.action === 'enable' ? 1 : 0, Number(req.params.id));
  if (!info.changes) return notFound(res);
  const a = A.getAssessment(Number(req.params.id));
  res.json({ ...a, state: A.linkState(a) });
});

router.post('/assessments/:id/regenerate', (req, res) => {
  const a = A.regenerateLink(Number(req.params.id));
  res.json({ ...a, state: A.linkState(a) });
});

router.put('/assessments/:id/essay-marks', (req, res) => {
  const a = A.setEssayMarks(Number(req.params.id), req.body?.marks);
  res.json({ ...a, state: A.linkState(a) });
});

router.delete('/assessments/:id', (req, res) => {
  const info = db.prepare('DELETE FROM assessments WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return notFound(res);
  res.json({ ok: true });
});

// ---- settings ----------------------------------------------------------

router.get('/settings', (req, res) => res.json(getSettings()));

router.put('/settings', (req, res) => {
  const b = req.body || {};
  const time = Number(b.default_time_minutes);
  const expiry = Number(b.default_link_expiry_minutes);
  const pass = Number(b.pass_mark);
  if (!Number.isInteger(time) || time < 1 || time > 600) return bad(res, 'Default exam time must be between 1 and 600 minutes.');
  if (!Number.isInteger(expiry) || expiry < 1 || expiry > 60 * 24 * 90) return bad(res, 'Default link expiry must be between 1 minute and 90 days.');
  if (!Number.isFinite(pass) || pass < 0 || pass > 100) return bad(res, 'Pass mark must be between 0 and 100.');
  if (!A.LANGUAGES.includes(b.default_language)) return bad(res, 'Please choose a language.');
  const before = getSettings().pass_mark;
  saveSettings({ default_time_minutes: time, default_link_expiry_minutes: expiry, pass_mark: pass, default_language: b.default_language });
  if (before !== pass) A.rescoreAll();
  res.json(getSettings());
});

module.exports = router;
