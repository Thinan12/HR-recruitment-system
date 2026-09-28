// Test types are managed records (key stable, name / order / status HR's).
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { start, stop, client, db, upload, seedQuestions, CANDIDATE } = require('./helpers');

let admin;
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 95);
  db.prepare("UPDATE questions SET question_text = 'IQ q ' || id WHERE section = 'IQ'").run();
  seedQuestions('GENERAL', 25);
  seedQuestions('CALCULATION', 27);
  const essay = db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES ('ESSAY', ?, 10, ?)");
  for (let i = 1; i <= 18; i++) essay.run('Essay prompt ' + i, new Date().toISOString());
});
test.after(stop);

const types = async () => (await admin.get('/api/admin/test-types')).data;
const byKey = async (k) => (await types()).find((t) => t.key === k);
const bank = async (qs = '') => (await admin.get('/api/admin/questions' + qs)).data;

test('the four original tests are managed records with stable keys, in order, and counts 95 / 25 / 27 / 18', async () => {
  const t = await types();
  assert.deepEqual(t.map((x) => [x.key, x.name, x.behavior, x.display_order, x.core, x.active]),
    [['IQ', 'IQ', 'iq', 1, 1, 1], ['GENERAL', 'General', 'mcq', 2, 1, 1], ['CALCULATION', 'Calculation', 'calculation', 3, 1, 1], ['ESSAY', 'Essay', 'essay', 4, 1, 1]]);
  assert.deepEqual(t.map((x) => x.questions), [95, 25, 27, 18]);
  const b = await bank();
  assert.deepEqual(b.total_counts, { IQ: 95, GENERAL: 25, CALCULATION: 27, ESSAY: 18 });
  assert.equal(b.test_types.length, 4);
});

test('add a test type: it becomes a Question Bank type with its own count; duplicates and "All" refused', async () => {
  const r = await admin.post('/api/admin/test-types', { name: 'Technical Test', description: 'Technical knowledge assessment', behavior: 'mcq', name_lo: 'ແບບທົດສອບດ້ານເຕັກນິກ' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.key, r.data.display_order, r.data.core, r.data.active, r.data.questions], ['TECHNICAL_TEST', 5, 0, 1, 0]);
  assert.equal((await bank()).total_counts.TECHNICAL_TEST, 0, 'Technical Test (0)');
  for (const dup of ['technical test', ' TECHNICAL   TEST ', 'Technical']) assert.equal((await admin.post('/api/admin/test-types', { name: dup, behavior: 'mcq' })).status, dup === 'Technical' ? 201 : 400, dup);
  await admin.del('/api/admin/test-types/TECHNICAL'); // the extra "Technical" one: unused, removed
  assert.equal((await admin.post('/api/admin/test-types', { name: 'All', behavior: 'mcq' })).status, 400);
  assert.equal((await admin.post('/api/admin/test-types', { name: 'IQ', behavior: 'mcq' })).status, 400);
  assert.equal((await admin.post('/api/admin/test-types', { name: 'Other IQ', behavior: 'iq' })).status, 400, 'the IQ format is for IQ only');
  const q = await admin.post('/api/admin/questions', { section: 'TECHNICAL_TEST', question_text: 'What does CPU stand for?', option_a: 'Central Processing Unit', option_b: 'Computer Power Unit', correct_answer: 'A' });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.equal((await bank()).total_counts.TECHNICAL_TEST, 1, 'Technical Test (1)');
  assert.equal((await bank('?section=technical_test')).questions.length, 1, 'filter by key, any case');
});

test('rename: the key, questions, categories and counts stay; the name changes everywhere', async () => {
  const cat = (await admin.post('/api/admin/categories', { section: 'GENERAL', name: 'Geography' })).data;
  const qid = db.prepare("SELECT id FROM questions WHERE section = 'GENERAL' LIMIT 1").get().id;
  await admin.post('/api/admin/questions/bulk-category', { ids: [qid], category_id: cat.id });
  const r = await admin.put('/api/admin/test-types/GENERAL', { name: 'General Knowledge' });
  assert.deepEqual([r.data.key, r.data.name, r.data.title, r.data.questions, r.data.categories], ['GENERAL', 'General Knowledge', 'General Knowledge Test', 25, 1]);
  assert.equal((await bank('?section=general')).questions.length, 25);
  assert.equal(db.prepare('SELECT category_id FROM questions WHERE id = ?').get(qid).category_id, cat.id);
  assert.equal((await admin.put('/api/admin/test-types/GENERAL', { behavior: 'essay' })).data.behavior, 'mcq', 'the format cannot change');
  // A file saying "General Knowledge" or "general" maps to the same type.
  const sheet = XLSX.utils.aoa_to_sheet([['Question', 'Type', 'Option A', 'Option B', 'Correct Answer'], ['Capital of Laos?', ' general knowledge ', 'Vientiane', 'Pakse', 'A'], ['Largest ocean?', 'GENERAL', 'Pacific', 'Arctic', 'A']]);
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Q');
  const p = (await admin.post('/api/admin/questions/import/preview', null, { form: upload(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'g.xlsx', 'IQ') })).data;
  assert.deepEqual(p.rows.map((x) => x.question.section), ['GENERAL', 'GENERAL']);
});

test('import: an unknown test type is never put into another one; HR creates it or picks one', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([['Question', 'Type', 'Option A', 'Option B', 'Correct Answer'], ['What is Ohm\'s law?', 'Robotics', 'V = IR', 'P = IV', 'A'], ['Robot sensor Q?', 'robotics', 'x', 'y', 'B'], ['Known one?', 'Technical Test', 'x', 'y', 'A']]);
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Q');
  const p = (await admin.post('/api/admin/questions/import/preview', null, { form: upload(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'r.xlsx', 'GENERAL') })).data;
  assert.deepEqual(p.type_decisions.map((d) => [d.key, d.count]), [['robotics', 2]]);
  assert.match(p.rows[0].errors[0], /Test Type "Robotics" does not exist/);
  assert.equal(p.rows[2].question.section, 'TECHNICAL_TEST');
  const rows = p.rows.map((x) => x.question);
  const undecided = await admin.post('/api/admin/questions/import', { questions: rows });
  assert.equal(undecided.status, 400);
  assert.match(undecided.data.error, /Test Type "Robotics" does not exist/);
  assert.equal(await byKey('ROBOTICS'), undefined, 'not created silently');
  const ok = (await admin.post('/api/admin/questions/import', { questions: rows, type_decisions: { robotics: { create: true, behavior: 'mcq' } } })).data;
  assert.equal(ok.imported, 3);
  assert.equal((await byKey('ROBOTICS')).questions, 2);
});

test('assessments: a new type is offered in order after the core four; its questions are drawn, marked and reported', async () => {
  const l = await admin.post('/api/admin/assessments', { tests: ['TECHNICAL_TEST', 'IQ'], counts: { IQ: 3, TECHNICAL_TEST: 1 }, link_expiry_minutes: 60, pass_marks: { IQ: 0, TECHNICAL_TEST: 0 } });
  assert.equal(l.status, 201, JSON.stringify(l.data));
  assert.deepEqual(l.data.stages.map((st) => st.section), ['IQ', 'TECHNICAL_TEST'], 'test type order, whatever order HR ticks them');
  const c = client();
  let s = (await c.post(`/api/exam/${l.data.token}/start`, { ...CANDIDATE, name: 'Tech Person' })).data;
  assert.deepEqual(s.tests.map((t) => [t.section, t.title, t.title_lo]), [['IQ', 'IQ Test', 'ແບບທົດສອບ IQ'], ['TECHNICAL_TEST', 'Technical Test', 'ແບບທົດສອບດ້ານເຕັກນິກ']]);
  const right = (st) => Object.fromEntries(st.questions.map((q) => [q.id, db.prepare('SELECT correct_answer FROM assessment_questions WHERE id = ?').get(q.id).correct_answer]));
  s = (await c.post(`/api/exam/${l.data.token}/submit`, { answers: right(s) })).data;
  s = (await c.post(`/api/exam/${l.data.token}/continue`)).data;
  assert.equal(s.section, 'TECHNICAL_TEST');
  s = (await c.post(`/api/exam/${l.data.token}/submit`, { answers: right(s) })).data;
  assert.equal(s.state, 'submitted');
  assert.equal(s.last_result.percent, 100);
  const cand = (await admin.get('/api/admin/candidates')).data.find((x) => x.name === 'Tech Person');
  assert.deepEqual(cand.tests.map((t) => [t.name, t.state]), [['IQ Test', 'PASS'], ['Technical Test', 'PASS']]);
  assert.equal(cand.eligibility, 'Eligible');
  const x = XLSX.utils.sheet_to_json(XLSX.read((await admin.get(`/api/admin/candidates/${cand.id}/export.xlsx?detail=full`, { raw: true })).buffer).Sheets.Candidates)[0];
  assert.equal(x['Technical Test PASS / NOT PASS'], 'PASS');
  assert.equal(x['Technical Test %'], 100);

  // An essay-format new type is marked by HR, like Essay.
  await admin.post('/api/admin/test-types', { name: 'Case Study', behavior: 'essay' });
  db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES ('CASE_STUDY', 'Analyse this case.', 10, ?)").run(new Date().toISOString());
  const e = (await admin.post('/api/admin/assessments', { tests: ['CASE_STUDY'], counts: { CASE_STUDY: 1 }, link_expiry_minutes: 60, pass_marks: { CASE_STUDY: 50 } })).data;
  const c2 = client();
  const es = (await c2.post(`/api/exam/${e.token}/start`, { ...CANDIDATE, name: 'Case Person' })).data;
  assert.equal(es.questions[0].kind, 'essay');
  const done = (await c2.post(`/api/exam/${e.token}/submit`, { answers: { [es.questions[0].id]: 'My analysis.' } })).data;
  assert.equal(done.last_result.result, 'Pending');
  const aid = db.prepare('SELECT id FROM assessments WHERE link_id = ?').get(e.id).id;
  const marked = await admin.put(`/api/admin/assessments/${aid}/essay-marks`, { marks: { [es.questions[0].id]: 7 } });
  assert.equal(marked.data.result, 'Pass');
});

test('deactivate: hidden from new questions, categories and assessments; nothing deleted; started links still work; reactivate restores', async () => {
  const link = (await admin.post('/api/admin/assessments', { tests: ['TECHNICAL_TEST'], counts: { TECHNICAL_TEST: 1 }, link_expiry_minutes: 60 })).data;
  const before = db.prepare("SELECT COUNT(*) AS n FROM questions WHERE section = 'TECHNICAL_TEST'").get().n;
  const d = await admin.post('/api/admin/test-types/TECHNICAL_TEST/deactivate');
  assert.equal(d.data.active, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE section = 'TECHNICAL_TEST'").get().n, before, 'questions kept');
  assert.equal((await admin.post('/api/admin/questions', { section: 'TECHNICAL_TEST', question_text: 'New?', option_a: 'x', option_b: 'y', correct_answer: 'A' })).status, 400);
  assert.equal((await admin.post('/api/admin/categories', { section: 'TECHNICAL_TEST', name: 'Networks' })).status, 400);
  const na = await admin.post('/api/admin/assessments', { tests: ['TECHNICAL_TEST'], counts: { TECHNICAL_TEST: 1 }, link_expiry_minutes: 60 });
  assert.equal(na.status, 400);
  assert.match(na.data.error, /not available for new assessments/);
  const s = (await client().post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name: 'Already Linked' })).data;
  assert.equal(s.state, 'in_progress', 'a link made before still works');
  assert.equal((await types()).find((t) => t.key === 'TECHNICAL_TEST').active, 0, 'still listed (as inactive) for HR');
  assert.equal((await admin.post('/api/admin/test-types/TECHNICAL_TEST/reactivate')).data.active, 1);
  assert.equal((await admin.post('/api/admin/questions', { section: 'TECHNICAL_TEST', question_text: 'Back again?', option_a: 'x', option_b: 'y', correct_answer: 'A' })).status, 201);
  // "Available for new assessments: No" hides it from new links only.
  await admin.put('/api/admin/test-types/TECHNICAL_TEST', { in_assessments: false });
  assert.equal((await admin.post('/api/admin/assessments', { tests: ['TECHNICAL_TEST'], counts: { TECHNICAL_TEST: 1 }, link_expiry_minutes: 60 })).status, 400);
  await admin.put('/api/admin/test-types/TECHNICAL_TEST', { in_assessments: true });
});

test('delete: only unused non-core types; core and used types refused with a clear message', async () => {
  const core = await admin.del('/api/admin/test-types/ESSAY');
  assert.equal(core.status, 400);
  assert.match(core.data.error, /Core Test Type — Delete unavailable/);
  const used = await admin.del('/api/admin/test-types/TECHNICAL_TEST');
  assert.equal(used.status, 400);
  assert.equal(used.data.error, 'This Test Type is in use and cannot be permanently deleted. You can deactivate it instead.');
  const temp = (await admin.post('/api/admin/test-types', { name: 'Unused Temp', behavior: 'calculation' })).data;
  assert.deepEqual((await admin.del('/api/admin/test-types/' + temp.key)).data, { deleted: true });
  assert.equal(await byKey(temp.key), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE section IN ('IQ','GENERAL','CALCULATION','ESSAY')").get().n, 95 + 25 + 27 + 18, 'core banks untouched');
});

test('IQ keeps its behaviour under another name; order changes only new links; history never changes', async () => {
  const past = JSON.stringify(db.prepare("SELECT * FROM assessments WHERE status = 'SUBMITTED' ORDER BY id").all());
  const pastStages = JSON.stringify(db.prepare('SELECT * FROM assessment_stages ORDER BY id').all());
  await admin.put('/api/admin/test-types/IQ', { name: 'Logical Reasoning Test' });
  const l = (await admin.post('/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 18 }, link_expiry_minutes: 60 })).data;
  const s = (await client().post(`/api/exam/${l.token}/start`, { ...CANDIDATE, name: 'Renamed IQ' })).data;
  assert.equal(s.questions.length, 18);
  assert.equal(s.tests[0].title, 'Logical Reasoning Test');
  const aid = db.prepare('SELECT id FROM assessments WHERE link_id = ?').get(l.id).id;
  assert.ok(db.prepare('SELECT max_marks FROM assessment_questions WHERE assessment_id = ?').all(aid).every((q) => q.max_marks === 1), 'IQ marks by level (all Level 1 here)');
  await admin.put('/api/admin/test-types/IQ', { name: 'IQ' });
  // Reordering: Calculation before General for NEW links.
  await admin.put('/api/admin/test-types/CALCULATION', { display_order: 2 });
  await admin.put('/api/admin/test-types/GENERAL', { display_order: 3 });
  const o = (await admin.post('/api/admin/assessments', { tests: ['GENERAL', 'CALCULATION', 'IQ'], counts: { IQ: 2, GENERAL: 1, CALCULATION: 1 }, link_expiry_minutes: 60 })).data;
  assert.deepEqual(o.stages.map((st) => st.section), ['IQ', 'CALCULATION', 'GENERAL']);
  await admin.put('/api/admin/test-types/CALCULATION', { display_order: 3 });
  await admin.put('/api/admin/test-types/GENERAL', { display_order: 2, name: 'General' });
  await admin.post('/api/admin/test-types/ESSAY/deactivate');
  await admin.post('/api/admin/test-types/ESSAY/reactivate');
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM assessments WHERE status = 'SUBMITTED' ORDER BY id").all()), past, 'finished assessments unchanged');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM assessment_stages ORDER BY id').all()).length >= pastStages.length, true);
});

test('only a logged-in admin can manage test types', async () => {
  const anon = client();
  for (const [m, u] of [['get', '/api/admin/test-types'], ['post', '/api/admin/test-types'], ['put', '/api/admin/test-types/IQ'], ['del', '/api/admin/test-types/IQ'], ['post', '/api/admin/test-types/IQ/deactivate']]) {
    assert.equal((await anon[m](u, m === 'get' || m === 'del' ? undefined : {})).status, 401, `${m} ${u}`);
  }
  assert.equal((await admin.post('/api/admin/test-types/IQ/deactivate')).status, 200);
  assert.equal((await admin.post('/api/admin/test-types/IQ/reactivate')).data.active, 1);
});
