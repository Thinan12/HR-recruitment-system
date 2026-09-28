// Admin API. Every route below requireAdmin needs a logged-in administrator.
const express = require('express');
const multer = require('multer');
const { db, getSettings, saveSettings, now } = require('../db');
const auth = require('../auth');
const A = require('../assessments');
const reports = require('../reports');
const { parseFile, validateQuestion, ImportError, IMAGE_KEYS } = require('../importer');
const images = require('../images');
const lao = require('../lao');
const categories = require('../categories');
const T = require('../testTypes');
const { LAO_COLUMNS } = require('../db');

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

// The LALCO IQ SCORE CLASSIFICATION table (reference; the same rows every screen uses).
router.get('/iq-classification', (req, res) => res.json(reports.IQ_CLASSIFICATION));

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
  const assessments = db.prepare(`SELECT a.*, l.token AS link_token, l.title AS link_title FROM assessments a
    LEFT JOIN assessment_links l ON l.id = a.link_id WHERE a.candidate_id = ? ORDER BY a.created_at DESC, a.id DESC`).all(c.id)
    .map((a) => ({ ...a, kind: 'assessment', state: A.linkState(a), stages: A.stagesOf(a), current_stage: A.currentStage(a) }));
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
  res.json(rows.map((r) => ({ id: r.id, candidate_id: r.candidate_id, candidate_name: r.candidate_name, ...reports.iqResult(r) })));
});

router.get('/export/candidates.xlsx', (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  sendFile(res, reports.candidatesXlsx(reports.allCandidateSummaries()), `LALCO_All_Candidates_${stamp}.xlsx`, XLSX_TYPE);
});

// ---- questions ---------------------------------------------------------

const NEEDS_ANSWER_SQL = "section = 'CALCULATION' AND TRIM(correct_answer) = '' AND option_a = '' AND option_b = '' AND option_a_image IS NULL AND option_b_image IS NULL";

router.get('/questions', (req, res) => {
  const where = [];
  const args = [];
  // ?section=iq / IQ: the stable key, any case.
  if (T.get(req.query.section)) { where.push('section = ?'); args.push(String(req.query.section).toUpperCase()); }
  if (req.query.status === 'Active' || req.query.status === 'Inactive') { where.push('status = ?'); args.push(req.query.status); }
  // Short-answer questions still waiting for their correct answer.
  if (req.query.status === 'needs_answer') where.push(NEEDS_ANSWER_SQL);
  if (req.query.q) {
    where.push('(question_text LIKE ? OR category LIKE ? OR question_text_lo LIKE ?)');
    args.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`);
  }
  // Lao filter: none (English only) / ready / reviewed / needs_review / failed.
  const LO_FILTER = { none: "lo_status = ''", ready: lao.LAO_READY_SQL, reviewed: "lo_status = 'reviewed'", needs_review: "lo_status = 'needs_review'", failed: "lo_status = 'failed'" };
  if (LO_FILTER[req.query.lao]) where.push(LO_FILTER[req.query.lao]);
  // Category filter: a category id, or 'none' = questions without a category.
  if (req.query.category === 'none') where.push('category_id IS NULL');
  else if (/^\d+$/.test(String(req.query.category || ''))) { where.push('category_id = ?'); args.push(Number(req.query.category)); }
  const sql = 'SELECT * FROM questions' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC';
  // Every row of each area (active + inactive), and the IQ bank per level.
  const totals = Object.fromEntries(T.keys().map((s) => [s, 0]));
  for (const r of db.prepare('SELECT section, COUNT(*) AS n FROM questions GROUP BY section').all()) totals[r.section] = r.n;
  const iqLevels = Object.fromEntries(A.DIFFICULTIES.map((d) => [d, 0]));
  for (const r of db.prepare("SELECT difficulty, COUNT(*) AS n FROM questions WHERE section = 'IQ' GROUP BY difficulty").all()) {
    const level = A.levelOf(r);
    if (level in iqLevels) iqLevels[level] += r.n;
  }
  res.json({ questions: db.prepare(sql).all(...args), counts: A.activeCounts(), inactive_counts: A.inactiveCounts(), total_counts: totals, iq_levels: iqLevels,
    lao_counts: lao.laoCounts(), lao_ready_counts: A.activeCounts('lo'), translator: lao.hasProvider(), translate_job: lao.job,
    needs_answer: db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE ${NEEDS_ANSWER_SQL}`).get().n,
    test_types: T.list(), categories: categories.list(), no_category: Object.fromEntries(T.keys().map((sec) => [sec, db.prepare('SELECT COUNT(*) AS n FROM questions WHERE section = ? AND category_id IS NULL').get(sec).n])) });
});

const QUESTION_COLS = ['section', 'category', 'category_id', 'difficulty', 'question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'option_e',
  'correct_answer', 'marks', ...IMAGE_KEYS];
// New questions may already carry a Lao translation (Lao columns in an import file).
const INSERT_COLS = [...QUESTION_COLS, ...LAO_COLUMNS, 'lo_status', 'lo_note', 'lo_translated_at'];
const insertRow = db.prepare(`INSERT INTO questions (${INSERT_COLS.join(', ')}, status, created_at)
  VALUES (${INSERT_COLS.map((c) => '@' + c).join(', ')}, @status, @created_at)`);
const insertQuestion = { run: (q) => insertRow.run({ ...Object.fromEntries([...LAO_COLUMNS, 'lo_status', 'lo_note'].map((c) => [c, ''])), ...q,
  category_id: q.category_id ?? null, status: q.status === 'Inactive' ? 'Inactive' : 'Active', lo_translated_at: q.lo_status ? q.created_at : null }) };

function checkedQuestion(body, current) {
  const { question, errors } = validateQuestion(body, { allowMissingAnswer: body?.status === 'Inactive' });
  for (const key of IMAGE_KEYS) if (question[key] && !images.imageExists(question[key])) errors.push('A picture could not be found. Please upload it again.');
  if (errors.length) throw new A.InputError(errors.join(' '));
  // The category is chosen from the managed list of that test type (by id,
  // or by name for API clients); an unknown name is never created silently.
  const cat = categories.resolveForQuestion(question.section, { category_id: body?.category_id, category: question.category, create_category: body?.create_category === true },
    current && current.section === question.section ? current.category_id : null);
  question.category_id = cat.id;
  question.category = cat.name;
  return question;
}

router.post('/questions', (req, res) => {
  const q = checkedQuestion(req.body);
  if (!T.get(q.section).active) return bad(res, `The ${T.name(q.section)} test type is inactive; reactivate it to add questions.`);
  const id = insertQuestion.run({ ...q, created_at: now() }).lastInsertRowid;
  if (q.section === 'IQ') A.syncIqLevels();
  res.status(201).json(db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
});

router.put('/questions/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!before) return notFound(res);
  const q = checkedQuestion(req.body, before);
  const status = req.body?.status === 'Inactive' ? 'Inactive' : 'Active';
  // English only: the Lao translation is edited separately (Edit Lao).
  db.prepare(`UPDATE questions SET ${QUESTION_COLS.map((c) => `${c} = @${c}`).join(', ')}, status = @status WHERE id = @id`).run({ ...q, status, id });
  lao.markStale(before, { ...q, id });
  // A level given to a question that had none also updates past tests that used it.
  if (q.section === 'IQ') A.syncIqLevels();
  res.json(db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
});

// Past assessments keep their own copy of each question, so deleting is safe.
router.delete('/questions/:id', (req, res) => {
  const info = db.prepare('DELETE FROM questions WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return notFound(res);
  res.json({ ok: true });
});

// Clears the question bank of ONE test area: active, inactive and duplicate
// rows alike. Candidates' assessments keep their own copies of every question
// (text, options, answer, marks, pictures), so no past result changes.
router.post('/questions/delete-all', (req, res) => {
  const section = String(req.body?.section || '').toUpperCase();
  if (!T.get(section)) return res.status(400).json({ success: false, message: 'Please choose a test area.' });
  try {
    const deletedCount = db.transaction(() => {
      const n = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE section = ?').get(section).n;
      const info = db.prepare('DELETE FROM questions WHERE section = ?').run(section);
      if (info.changes !== n) throw new Error(`expected to delete ${n}, deleted ${info.changes}`);
      db.prepare("INSERT INTO audit_log (action, admin, details, created_at) VALUES ('DELETE_ALL_QUESTIONS', ?, ?, ?)")
        .run(req.admin.username, JSON.stringify({ test_type: section, deleted: n }), now());
      return n;
    })();
    console.log(`[audit] DELETE_ALL_QUESTIONS area=${section} deleted=${deletedCount} admin=${req.admin.username}`);
    res.json({ success: true, testType: section, deletedCount });
  } catch (e) {
    console.error('Delete all questions failed:', e);
    res.status(500).json({ success: false, message: 'Questions were not deleted. Please try again or check the server logs.' });
  }
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

router.get('/questions/counts', (req, res) => res.json(A.activeCounts(req.query.language === 'lo' ? 'lo' : 'en')));

// ---- test types -----------------------------------------------------------------
// IQ, General, Calculation, Essay and any HR adds. The key never changes; the
// four core types can be renamed / reordered / deactivated but not deleted.

const typeError = (res, e) => (e instanceof T.TypeError ? bad(res, e.message) : null);
router.get('/test-types', (req, res) => res.json(T.list()));
router.post('/test-types', (req, res) => {
  try { res.status(201).json(T.create(req.body || {}, req.admin.username)); } catch (e) { if (!typeError(res, e)) throw e; }
});
const updateType = (req, res) => {
  try { const t = T.update(req.params.key, req.body || {}, req.admin.username); if (!t) return notFound(res); res.json(t); } catch (e) { if (!typeError(res, e)) throw e; }
};
router.put('/test-types/:key', updateType);
router.patch('/test-types/:key', updateType);
router.post('/test-types/:key/:action(activate|reactivate|deactivate)', (req, res) => {
  try { const t = T.setActive(req.params.key, req.params.action !== 'deactivate', req.admin.username); if (!t) return notFound(res); res.json(t); } catch (e) { if (!typeError(res, e)) throw e; }
});
router.delete('/test-types/:key', (req, res) => {
  try { const r = T.remove(req.params.key, req.admin.username); if (!r) return notFound(res); res.json(r); } catch (e) { if (!typeError(res, e)) throw e; }
});

// ---- question categories -----------------------------------------------------

const catError = (res, e) => (e instanceof categories.CategoryError ? bad(res, e.message) : null);

router.get('/categories', (req, res) => res.json(categories.list({ section: req.query.section, status: req.query.status, q: String(req.query.q || '').trim() })));

router.post('/categories', (req, res) => {
  try { res.status(201).json(categories.create(req.body || {}, req.admin.username)); } catch (e) { if (!catError(res, e)) throw e; }
});

// One category with the questions in it.
router.get('/categories/:id', (req, res) => {
  const c = categories.list().find((x) => x.id === Number(req.params.id));
  if (!c) return notFound(res);
  res.json({ category: c, questions: db.prepare('SELECT id, section, difficulty, question_text, status FROM questions WHERE category_id = ? ORDER BY id').all(c.id) });
});

router.put('/categories/:id', (req, res) => {
  try {
    const c = categories.update(Number(req.params.id), { name: req.body?.name, name_lo: req.body?.name_lo }, req.admin.username);
    if (!c) return notFound(res);
    res.json(c);
  } catch (e) { if (!catError(res, e)) throw e; }
});

router.post('/categories/:id/:action(activate|deactivate)', (req, res) => {
  const c = categories.setActive(Number(req.params.id), req.params.action === 'activate', req.admin.username);
  if (!c) return notFound(res);
  res.json(c);
});

// Remove: deactivated if questions use it (they keep it), deleted if unused.
router.delete('/categories/:id', (req, res) => {
  const r = categories.remove(Number(req.params.id), req.admin.username);
  if (!r) return notFound(res);
  res.json(r);
});

// Set (or clear) the category of many questions at once; nothing else changes.
router.post('/questions/bulk-category', (req, res) => {
  try { res.json(categories.bulkAssign(req.body?.ids, req.body?.category_id ?? null, req.admin.username)); } catch (e) { if (!catError(res, e)) throw e; }
});

// ---- Lao translations -------------------------------------------------------

// Saves only the Lao text (never the English) of one question.
router.put('/questions/:id/lao', (req, res) => {
  const r = lao.saveLao(Number(req.params.id), req.body || {}, req.admin.username);
  if (r.error === 'not_found') return notFound(res);
  if (r.error) return bad(res, r.error);
  res.json(r.question);
});

// Checks a Lao text without saving it (the editor shows the problems).
router.post('/questions/:id/lao/check', (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(req.params.id));
  if (!q) return notFound(res);
  res.json({ problems: lao.laoProblems(q, req.body || {}) });
});

// "Translate Missing Lao": every question without Lao (or whose translation
// failed), in the background, when a translation service is configured.
router.post('/questions/translate-missing', (req, res) => {
  const r = lao.translateMissing(null, req.admin.username);
  if (r.error) return bad(res, r.error);
  res.json({ job: r.job, lao_counts: lao.laoCounts() });
});
router.get('/questions/translate-status', (req, res) => res.json({ job: lao.job, lao_counts: lao.laoCounts(), translator: lao.hasProvider() }));

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
      const chosen = T.get(req.body.section);
      const defaultSection = chosen && chosen.active ? chosen.key : (T.get('GENERAL') && T.get('GENERAL').active ? 'GENERAL' : T.activeKeys()[0]);
      const rows = await parseFile(req.file.buffer, req.file.originalname, defaultSection);
      const seen = existingQuestionKeys();
      for (const r of rows) {
        if (r.errors.length) continue;
        const key = A.questionKey(r.question);
        if (seen.has(key)) r.errors.push('Duplicate — not imported: this question is already in the question bank (or repeated in this file).');
        seen.add(key);
      }
      const valid = rows.filter((r) => r.errors.length === 0);
      // Category of each row: ok / missing / unknown (not in the list) / inactive.
      // Unknown and inactive names need HR's decision before importing.
      const decisions = new Map();
      for (const r of valid) {
        const name = String(r.question.category || '').trim();
        if (!name) { r.category_state = 'missing'; continue; }
        const c = categories.byName(r.question.section, name);
        r.category_state = !c ? 'unknown' : c.active ? 'ok' : 'inactive';
        if (c && c.active) { r.question.category = c.name; continue; }
        const key = r.question.section + '|' + categories.normalize(name);
        const d = decisions.get(key) || { key, section: r.question.section, name, count: 0, inactive: !!c };
        d.count++;
        decisions.set(key, d);
      }
      const bySection = Object.fromEntries(T.keys().map((s) => [s, valid.filter((r) => r.question.section === s).length]));
      // Test types named in the file that do not exist: HR creates them or picks an existing one.
      const typeDecisions = new Map();
      for (const r of rows) if (r.question.type_name && r.errors.length === 1) {
        const k = r.question.type_name.trim().toLowerCase().replace(/\s+/g, ' ');
        const d = typeDecisions.get(k) || { key: k, name: r.question.type_name.trim(), count: 0 };
        d.count++; typeDecisions.set(k, d);
      }
      // What the document contains, per section, and whether it matches the chosen type.
      const sections = (rows.sections || []).map((sec) => ({ ...sec, valid: rows.filter((r) => r.section_key === sec.key && !r.errors.length).length,
        answer_required: rows.filter((r) => r.section_key === sec.key && r.answer_required && !r.errors.length).length }));
      const detected = [...new Set(valid.map((r) => r.question.section))];
      const mismatch = detected.length && !detected.includes(defaultSection)
        ? `This document appears to contain ${detected.map((d) => T.name(d)).join(' and ')} questions, but ${T.name(defaultSection)} questions is selected. Nothing is put into the ${T.name(defaultSection)} bank unless you choose it below.`
        : null;
      const duplicates = rows.filter((r) => r.errors.some((e) => /already in the question bank/.test(e))).length;
      const conflicts = rows.filter((r) => r.errors.some((e) => /conflict/i.test(e))).length;
      res.json({ found: rows.length, valid: valid.length, invalid: rows.length - valid.length, duplicates, conflicts,
        format: rows.format, answer_key: rows.keyCount, test_type: defaultSection, file: req.file.originalname, by_section: bySection,
        category_decisions: [...decisions.values()], missing_category: valid.filter((r) => r.category_state === 'missing').length,
        type_decisions: [...typeDecisions.values()], test_types: T.list().filter((t) => t.active), sections, type_mismatch: mismatch, answer_required: valid.filter((r) => r.answer_required).length,
        categories: categories.list({ status: 'active' }), rows });
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
  const newIds = [];
  let skipped = 0;
  // Category names not in the list (or inactive) need a decision per name:
  // { "IQ|verbal reasoning": { "create": true } } or { ...: { "category_id": 5 } }.
  // create_missing_categories: true = create every unknown name.
  // Test types named in the file that do not exist: { "technical": { "create": true, "behavior": "mcq" } } or { ...: { "key": "GENERAL" } }.
  const typeDecided = req.body?.type_decisions && typeof req.body.type_decisions === 'object' ? req.body.type_decisions : {};
  const typeKeys = new Map();
  for (const row of rows) {
    const tn = String(row.type_name || '').trim();
    if (!tn || T.get(row.section)) continue;
    const k = tn.toLowerCase().replace(/\s+/g, ' ');
    const d = typeDecided[k];
    if (!d) return bad(res, `Test Type "${tn}" does not exist. Create it, or choose an existing test type.`);
    if (!typeKeys.has(k)) {
      if (d.key && T.get(d.key)) typeKeys.set(k, T.get(d.key).key);
      else if (d.create) { try { typeKeys.set(k, T.resolve(tn) || T.create({ name: tn, behavior: d.behavior || 'mcq' }, req.admin.username).key); } catch (e) { if (e instanceof T.TypeError) return bad(res, e.message); throw e; } }
      else return bad(res, `Please choose what to do with the test type "${tn}".`);
    }
    row.section = typeKeys.get(k);
  }
  const inactiveType = rows.map((r) => T.get(r.section)).find((t) => t && !t.active);
  if (inactiveType) return bad(res, `The ${inactiveType.name} test type is inactive; reactivate it to import questions into it.`);
  const decided = req.body?.category_decisions && typeof req.body.category_decisions === 'object' ? req.body.category_decisions : {};
  const undecided = new Map();
  for (const row of rows) {
    const { question, errors } = validateQuestion(row, { allowMissingAnswer: true });
    const name = String(question.category || '').trim();
    if (errors.length || !name) continue;
    const c = categories.byName(question.section, name);
    const key = question.section + '|' + categories.normalize(name);
    if ((!c || !c.active) && !decided[key] && !(req.body?.create_missing_categories === true && !c) && !undecided.has(key)) undecided.set(key, `${name} (${question.section})`);
  }
  if (undecided.size) return bad(res, `Please decide what to do with these categories before importing: ${[...undecided.values()].join(', ')}. Create them, or choose an existing category.`);
  db.transaction(() => {
    const seen = existingQuestionKeys();
    for (const row of rows) {
      const { question, errors } = validateQuestion(row, { allowMissingAnswer: true });
      const key = A.questionKey(question);
      if (errors.length || seen.has(key)) { skipped++; continue; }
      const name = String(question.category || '').trim();
      if (name) {
        const d = decided[question.section + '|' + categories.normalize(name)];
        const choice = d && d.category_id ? { category_id: d.category_id } : { category: name, create_category: !!(d && d.create) || req.body?.create_missing_categories === true };
        const cat = categories.resolveForQuestion(question.section, choice, null);
        question.category_id = cat.id;
        question.category = cat.name;
      }
      seen.add(key);
      newIds.push(Number(insertQuestion.run({ ...question, created_at: created }).lastInsertRowid));
      imported++;
    }
  })();
  // New questions without Lao are translated in the background when a service is set up.
  if (lao.hasProvider() && newIds.length) lao.translateMissing(newIds, req.admin.username);
  const waiting = newIds.length ? db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE id IN (${newIds.join(',')}) AND ${NEEDS_ANSWER_SQL}`).get().n : 0;
  res.json({ imported, skipped, ...(waiting ? { answer_required: waiting } : {}), ...(lao.hasProvider() && newIds.length ? { translating: true } : {}) });
});

// ---- assessments -------------------------------------------------------

// Shared links (kind "link", with their candidate count) and the older
// one-person links (kind "assessment"), newest first. Candidates' attempts on
// shared links are listed on the link's own page, not here.
router.get('/assessments', (req, res) => {
  const links = db.prepare('SELECT * FROM assessment_links').all().map((l) => ({
    ...A.linkView(l),
    candidate_names: db.prepare(`SELECT c.name FROM assessments a JOIN candidates c ON c.id = a.candidate_id WHERE a.link_id = ? ORDER BY a.id DESC LIMIT 5`)
      .all(l.id).map((r) => r.name),
  }));
  const single = db.prepare(`SELECT a.*, c.name AS candidate_name FROM assessments a
    LEFT JOIN candidates c ON c.id = a.candidate_id WHERE a.link_id IS NULL`).all()
    .map((a) => ({ ...a, kind: 'assessment', state: A.linkState(a), stages: A.stagesOf(a), current_stage: A.currentStage(a) }));
  res.json([...links, ...single].sort((x, y) => y.created_at.localeCompare(x.created_at) || y.id - x.id));
});

router.post('/assessments', (req, res) => {
  res.status(201).json(A.linkView(A.createAssessment(req.body || {})));
});

// One shared link and every candidate who used it (one row per attempt).
router.get('/links/:id', (req, res) => {
  const link = A.getLink(Number(req.params.id));
  if (!link) return notFound(res);
  const attempts = db.prepare(`SELECT a.*, c.name AS candidate_name, c.phone AS candidate_phone, c.final_result FROM assessments a
    LEFT JOIN candidates c ON c.id = a.candidate_id WHERE a.link_id = ? ORDER BY a.started_at DESC, a.id DESC`).all(link.id)
    .map((a) => {
      const r = reports.testResults(a);
      return { id: a.id, candidate_id: a.candidate_id, candidate_name: a.candidate_name, candidate_phone: a.candidate_phone, final_result: a.final_result,
        status: a.status, state: A.linkState(a), enabled: a.enabled, started_at: a.started_at, submitted_at: a.submitted_at, auto_submitted: a.auto_submitted,
        current_stage: r.current_stage, tests: r.tests, final_percent: r.final_percent, final_percent_text: r.final_percent_text, final_level: r.final_level,
        eligibility: r.eligibility, eligibility_note: r.eligibility_note, assessment_result: a.result,
        // For checking randomisation: the bank question ids this candidate got, in the order shown.
        question_ids: Object.fromEntries(T.keys().map((sec) => [sec, db.prepare('SELECT question_id FROM assessment_questions WHERE assessment_id = ? AND section = ? ORDER BY position')
          .all(a.id, sec).map((q) => q.question_id)]).filter(([, ids]) => ids.length)) };
    });
  res.json({ link: A.linkView(link), attempts });
});

// Disable = no NEW candidate can start. Candidates already in a test carry on
// with their own timer (HR can stop one candidate from their own row).
router.post('/links/:id/:action(enable|disable)', (req, res) => {
  const info = db.prepare('UPDATE assessment_links SET enabled = ? WHERE id = ?').run(req.params.action === 'enable' ? 1 : 0, Number(req.params.id));
  if (!info.changes) return notFound(res);
  res.json(A.linkView(A.getLink(Number(req.params.id))));
});

// A new URL, only while nobody has used the link (candidates resume through it).
router.post('/links/:id/regenerate', (req, res) => {
  const link = A.getLink(Number(req.params.id));
  if (!link) return notFound(res);
  if (A.linkView(link).candidates > 0) return bad(res, 'Candidates have already used this link, so its address cannot change. Disable it and create a new link instead.');
  db.prepare('UPDATE assessment_links SET token = ?, link_expires_at = ?, enabled = 1 WHERE id = ?')
    .run(require('crypto').randomBytes(24).toString('base64url'), new Date(Date.now() + link.link_expiry_minutes * 60000).toISOString(), link.id);
  res.json(A.linkView(A.getLink(link.id)));
});

// Only an unused link can be deleted; one with candidates keeps their history.
router.delete('/links/:id', (req, res) => {
  const link = A.getLink(Number(req.params.id));
  if (!link) return notFound(res);
  if (A.linkView(link).candidates > 0) return bad(res, 'Candidates have used this link, so it is kept with their results. Disable it instead.');
  db.prepare('DELETE FROM assessment_links WHERE id = ?').run(link.id);
  res.json({ ok: true });
});

router.get('/assessments/:id', (req, res) => {
  const a = A.getAssessment(Number(req.params.id));
  if (!a) return notFound(res);
  const candidate = a.candidate_id ? db.prepare('SELECT id, name, phone FROM candidates WHERE id = ?').get(a.candidate_id) : null;
  const questions = db.prepare('SELECT * FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(a.id);
  const stages = A.stagesOf(a);
  const link = a.link_id ? A.getLink(a.link_id) : null;
  res.json({ assessment: { ...a, state: A.linkState(a), current_stage: A.currentStage(a, stages) }, stages,
    link: link ? { id: link.id, title: link.title, token: link.token } : null,
    tests: stages.map((st) => reports.stageView(a, st, stages)), final: reports.finalAssessment(a, stages), iq: reports.iqResult(a), candidate, questions });
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

// Pass marks and the final eligibility mark are defaults for NEW assessment
// links. Each link keeps the marks it was created with, so saving here never
// changes a result that already exists.
const PERCENT_SETTINGS = [['pass_iq', 'IQ pass mark'], ['pass_general', 'General pass mark'], ['pass_calculation', 'Calculation pass mark'],
  ['pass_essay', 'Essay pass mark'], ['final_eligibility', 'Final eligibility mark']];

router.put('/settings', (req, res) => {
  const b = req.body || {};
  const current = getSettings();
  const time = Number(b.default_time_minutes);
  const expiry = Number(b.default_link_expiry_minutes);
  if (!Number.isInteger(time) || time < 1 || time > 600) return bad(res, 'Default exam time must be between 1 and 600 minutes.');
  if (!Number.isInteger(expiry) || expiry < 1 || expiry > 60 * 24 * 90) return bad(res, 'Default link expiry must be between 1 minute and 90 days.');
  if (!A.LANGUAGES.includes(b.default_language)) return bad(res, 'Please choose a language.');
  const values = { default_time_minutes: time, default_link_expiry_minutes: expiry, default_language: b.default_language };
  for (const [key, name] of PERCENT_SETTINGS) {
    const v = b[key] === undefined || b[key] === '' ? current[key] : Number(b[key]);
    if (!Number.isFinite(v) || v < 0 || v > 100) return bad(res, `${name} must be between 0 and 100%.`);
    values[key] = v;
  }
  saveSettings(values);
  res.json(getSettings());
});

module.exports = router;
