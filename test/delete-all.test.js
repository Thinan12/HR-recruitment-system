// "Delete All Questions": clears one test area of the question bank, never
// another area and never a candidate's past assessment.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, client, seedQuestions, db, CANDIDATE, attemptOf } = require('./helpers');

let admin;
const candidate = client();
const url = (token, path = '') => `/api/exam/${token}${path}`;
const count = (sec) => db.prepare('SELECT COUNT(*) AS n FROM questions WHERE section = ?').get(sec).n;
const deleteAll = (section, c = admin) => c.post('/api/admin/questions/delete-all', { section });
// Everything a past assessment shows, except the link back to the bank row.
const history = (aid) => JSON.stringify({
  a: db.prepare('SELECT * FROM assessments WHERE id = ?').get(aid),
  stages: db.prepare('SELECT * FROM assessment_stages WHERE assessment_id = ? ORDER BY position').all(aid),
  qs: db.prepare('SELECT * FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(aid).map(({ question_id, ...rest }) => rest),
});

let pastId;
let pastCandidate;
let pastBefore;

test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 6, 1, 'Easy');
  seedQuestions('IQ', 4, 1, 'Very Difficult');
  const inactive = seedQuestions('IQ', 3, 1, 'Moderate');
  db.prepare(`UPDATE questions SET status = 'Inactive' WHERE id IN (${inactive.join(',')})`).run();
  // A duplicate kept as an inactive row.
  db.prepare("INSERT INTO questions (section, difficulty, question_text, option_a, option_b, correct_answer, marks, status, created_at) VALUES ('IQ', 'Easy', 'IQ question 1', 'opt A', 'opt B', 'A', 1, 'Inactive', ?)").run(new Date().toISOString());
  seedQuestions('GENERAL', 8);
  seedQuestions('CALCULATION', 5);
  db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES ('ESSAY', 'Why LALCO?', 10, ?)").run(new Date().toISOString());

  // A finished assessment that used bank questions.
  const a = (await admin.post('/api/admin/assessments', { tests: ['IQ', 'GENERAL'], counts: { IQ: 5, GENERAL: 4 }, link_expiry_minutes: 60, pass_marks: { IQ: 0, GENERAL: 0 } })).data;
  let s = (await candidate.post(url(a.token, '/start'), { ...CANDIDATE, name: 'History Person' })).data;
  const right = (st) => Object.fromEntries(st.questions.map((q) => [q.id, db.prepare('SELECT correct_answer FROM assessment_questions WHERE id = ?').get(q.id).correct_answer]));
  s = (await candidate.post(url(a.token, '/submit'), { answers: right(s) })).data;
  s = (await candidate.post(url(a.token, '/continue'))).data;
  s = (await candidate.post(url(a.token, '/submit'), { answers: right(s) })).data;
  assert.equal(s.outcome, 'completed');
  pastId = attemptOf(a);
  pastCandidate = db.prepare('SELECT candidate_id FROM assessments WHERE id = ?').get(attemptOf(a)).candidate_id;
  pastBefore = history(pastId);
});
test.after(stop);

test('candidates and logged-out users cannot call it; an unknown area is refused', async () => {
  const anon = client();
  assert.equal((await deleteAll('IQ', anon)).status, 401);
  assert.equal((await deleteAll('IQ', candidate)).status, 401, 'an exam session is not an admin');
  const bad = await deleteAll('EVERYTHING');
  assert.equal(bad.status, 400);
  assert.equal(bad.data.success, false);
  assert.equal((await deleteAll('')).status, 400);
  assert.equal(count('IQ'), 14);
});

test('the question bank lists every area with its total, active / inactive and IQ level counts', async () => {
  const r = (await admin.get('/api/admin/questions')).data;
  assert.deepEqual(r.total_counts, { IQ: 14, GENERAL: 8, CALCULATION: 5, ESSAY: 1 });
  assert.equal(r.inactive_counts.IQ, 4);
  assert.equal(r.iq_levels.Easy, 7);
  assert.equal(r.iq_levels['Very Difficult'], 4);
});

test('a failure part-way rolls back: nothing is half deleted', async () => {
  const last = db.prepare("SELECT MAX(id) AS id FROM questions WHERE section = 'IQ'").get().id;
  db.exec(`CREATE TRIGGER block_one BEFORE DELETE ON questions WHEN old.id = ${last} BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
  try {
    const r = await deleteAll('IQ');
    assert.equal(r.status, 500);
    assert.deepEqual(r.data, { success: false, message: 'Questions were not deleted. Please try again or check the server logs.' });
    assert.ok(!JSON.stringify(r.data).includes('blocked'), 'no raw database error is shown');
    assert.equal(count('IQ'), 14, 'every IQ question is still there');
  } finally {
    db.exec('DROP TRIGGER block_one');
  }
});

test('Delete All IQ removes active, inactive and duplicate IQ rows only; history is untouched', async () => {
  const r = await deleteAll('IQ');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { success: true, testType: 'IQ', deletedCount: 14 });
  assert.equal(count('IQ'), 0);
  assert.deepEqual([count('GENERAL'), count('CALCULATION'), count('ESSAY')], [8, 5, 1], 'other areas unaffected');

  const bank = (await admin.get('/api/admin/questions')).data;
  assert.equal(bank.total_counts.IQ, 0);
  assert.equal(bank.inactive_counts.IQ, 0);
  assert.ok(Object.values(bank.iq_levels).every((n) => n === 0), 'IQ level counts are zero');
  assert.equal((await admin.get('/api/admin/questions/counts')).data.IQ, 0, 'Create Assessment sees 0 IQ questions');
  const noIq = await admin.post('/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 1 }, link_expiry_minutes: 60 });
  assert.equal(noIq.status, 400);

  // The past assessment: same snapshots, answers, marks, scores, results.
  assert.equal(history(pastId), pastBefore);
  const review = (await admin.get('/api/admin/assessments/' + pastId)).data;
  assert.equal(review.questions.filter((q) => q.section === 'IQ').length, 5);
  assert.ok(review.questions.every((q) => q.question_text && q.answer));
  const c = (await admin.get('/api/admin/candidates/' + pastCandidate)).data.candidate;
  const stored = db.prepare('SELECT iq_points, iq_max FROM assessments WHERE id = ?').get(pastId);
  assert.equal(c.iq_text, `${stored.iq_points} / ${stored.iq_max}`);
  assert.equal(c.iq_points, c.iq_max, 'all IQ answers still marked correct');
  assert.deepEqual(c.tests.map((t) => t.state), ['PASS', 'PASS']);
  for (const fmt of ['pdf', 'docx', 'xlsx']) assert.equal((await admin.get(`/api/admin/candidates/${pastCandidate}/export.${fmt}`, { raw: true })).status, 200, fmt);

  const log = db.prepare("SELECT * FROM audit_log WHERE action = 'DELETE_ALL_QUESTIONS' ORDER BY id DESC").get();
  assert.equal(log.admin, 'admin');
  assert.deepEqual(JSON.parse(log.details), { test_type: 'IQ', deleted: 14 });
  assert.ok(log.created_at);
});

test('deleting an empty area is safe and returns 0', async () => {
  const r = await deleteAll('IQ');
  assert.deepEqual(r.data, { success: true, testType: 'IQ', deletedCount: 0 });
});

test('Delete All General does not touch other areas; Calculation and Essay work the same', async () => {
  assert.deepEqual((await deleteAll('GENERAL')).data, { success: true, testType: 'GENERAL', deletedCount: 8 });
  assert.deepEqual([count('GENERAL'), count('CALCULATION'), count('ESSAY')], [0, 5, 1]);
  assert.deepEqual((await deleteAll('CALCULATION')).data.deletedCount, 5);
  assert.equal(count('ESSAY'), 1);
  assert.deepEqual((await deleteAll('essay')).data, { success: true, testType: 'ESSAY', deletedCount: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions').get().n, 0);
  assert.equal(history(pastId), pastBefore, 'history still unchanged');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'DELETE_ALL_QUESTIONS'").get().n, 5);
});

test('after clearing, a new upload works and the one-link flow runs as normal', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ section: 'IQ', difficulty: 'Easy', question_text: `New IQ ${i + 1}`, option_a: '1', option_b: '2', option_c: '3', option_d: '4', correct_answer: 'B' }));
  const imp = await admin.post('/api/admin/questions/import', { questions: rows });
  assert.deepEqual(imp.data, { imported: 6, skipped: 0 });
  assert.equal(count('IQ'), 6);
  const a = (await admin.post('/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 6 }, link_expiry_minutes: 60 })).data;
  let s = (await candidate.post(url(a.token, '/start'), { ...CANDIDATE, name: 'After Upload' })).data;
  assert.equal(s.state, 'in_progress');
  assert.equal(s.questions.length, 6);
  s = (await candidate.post(url(a.token, '/submit'), { answers: Object.fromEntries(s.questions.map((q) => [q.id, 'B'])) })).data;
  assert.equal(s.last_result.points, s.last_result.max, 'full marks');
  assert.equal(s.last_result.result, 'Pass');
});
