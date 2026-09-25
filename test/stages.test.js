// One link for all tests: IQ -> General -> Calculation -> Essay, one by one,
// each opened only after the one before it was passed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, client, seedQuestions, db, CANDIDATE } = require('./helpers');
const { finalizeExpired } = require('../src/assessments');

let admin;
const candidate = client();
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 30);
  seedQuestions('GENERAL', 15);
  seedQuestions('CALCULATION', 15);
  db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES ('ESSAY', 'Why LALCO?', 10, ?)").run(new Date().toISOString());
});
test.after(stop);

const url = (token, path = '') => `/api/exam/${token}${path}`;
async function link(tests, extra = {}) {
  const r = await admin.post('/api/admin/assessments', {
    tests, counts: { IQ: 6, GENERAL: 4, CALCULATION: 3, ESSAY: 1 }, minutes: { IQ: 20, GENERAL: 15, CALCULATION: 10, ESSAY: 25 }, link_expiry_minutes: 60, ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
// Answers every question of the running test, right or wrong.
async function answerAndSubmit(token, state, right) {
  const ids = state.questions.map((q) => q.id);
  const rows = db.prepare(`SELECT id, correct_answer FROM assessment_questions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const answers = Object.fromEntries(rows.map((q) => [q.id, right ? q.correct_answer : 'Z']));
  return (await candidate.post(url(token, '/submit'), { answers })).data;
}
const statuses = (s) => s.tests.map((t) => `${t.section}:${t.status}`).join(' ');

test('one link runs IQ -> General -> Calculation -> Essay in order, details entered once', async () => {
  const a = await link(['ESSAY', 'CALCULATION', 'IQ', 'GENERAL']); // order given by HR does not matter
  assert.deepEqual(a.stages.map((st) => st.section), ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY']);
  assert.equal(a.assessment_type, 'COMBINED');

  const ready = (await candidate.get(url(a.token))).data;
  assert.equal(ready.state, 'ready');
  assert.equal(ready.tests.length, 4);

  let s = (await candidate.post(url(a.token, '/start'), CANDIDATE)).data;
  assert.equal(s.state, 'in_progress');
  assert.equal(s.section, 'IQ');
  assert.equal(s.questions.length, 6);
  assert.ok(s.questions.every((q) => q.section === 'IQ'));
  assert.equal(statuses(s), 'IQ:current GENERAL:upcoming CALCULATION:upcoming ESSAY:upcoming');
  assert.ok(s.remaining_seconds > 19 * 60 && s.remaining_seconds <= 20 * 60, 'IQ has its own 20-minute timer');

  s = await answerAndSubmit(a.token, s, true);
  assert.equal(s.state, 'next_test');
  assert.equal(s.passed_section, 'IQ');
  assert.equal(s.next_section, 'GENERAL');
  assert.equal(statuses(s), 'IQ:done GENERAL:next CALCULATION:upcoming ESSAY:upcoming');
  assert.ok(!JSON.stringify(s).includes('percent') && !('points' in s), 'no scores are sent to the candidate');

  s = (await candidate.post(url(a.token, '/continue'))).data;
  assert.equal(s.section, 'GENERAL');
  assert.equal(s.questions.length, 4);
  assert.ok(s.remaining_seconds > 14 * 60 && s.remaining_seconds <= 15 * 60);
  s = await answerAndSubmit(a.token, s, true);
  s = (await candidate.post(url(a.token, '/continue'))).data;
  assert.equal(s.section, 'CALCULATION');
  s = await answerAndSubmit(a.token, s, true);
  s = (await candidate.post(url(a.token, '/continue'))).data;
  assert.equal(s.section, 'ESSAY');
  const essay = s.questions[0];
  s = (await candidate.post(url(a.token, '/submit'), { answers: { [essay.id]: 'Because I like numbers.' } })).data;
  assert.equal(s.state, 'submitted');
  assert.equal(s.outcome, 'completed');

  // The candidate was saved once; the essay waits for HR.
  const row = db.prepare('SELECT candidate_id, result, status FROM assessments WHERE id = ?').get(a.id);
  assert.equal(row.status, 'SUBMITTED');
  assert.equal(row.result, 'Pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE name = ?').get(CANDIDATE.name).n >= 1, true);
  const review = (await admin.get('/api/admin/assessments/' + a.id)).data;
  assert.deepEqual(review.stages.map((st) => [st.section, st.status, st.result]),
    [['IQ', 'SUBMITTED', 'Pass'], ['GENERAL', 'SUBMITTED', 'Pass'], ['CALCULATION', 'SUBMITTED', 'Pass'], ['ESSAY', 'SUBMITTED', 'Pending']]);
  const marked = await admin.put(`/api/admin/assessments/${a.id}/essay-marks`, { marks: { [essay.id]: 7 } });
  assert.equal(marked.data.result, 'Pass');
});

test('failing IQ stops the assessment: no later test can be opened', async () => {
  const a = await link(['IQ', 'GENERAL', 'CALCULATION']);
  let s = (await candidate.post(url(a.token, '/start'), { ...CANDIDATE, name: 'Fails IQ' })).data;
  s = await answerAndSubmit(a.token, s, false);
  assert.equal(s.state, 'submitted');
  assert.equal(s.outcome, 'stopped');
  assert.equal(statuses(s), 'IQ:failed GENERAL:upcoming CALCULATION:upcoming');

  assert.equal((await candidate.post(url(a.token, '/continue'))).status, 409);
  assert.equal((await candidate.post(url(a.token, '/start'), CANDIDATE)).data.state, 'submitted');
  assert.equal((await candidate.get(url(a.token))).data.outcome, 'stopped', 'refreshing shows the same end');
  const sections = db.prepare('SELECT DISTINCT section FROM assessment_questions WHERE assessment_id = ?').all(a.id).map((r) => r.section);
  assert.deepEqual(sections, ['IQ'], 'no General or Calculation questions were ever drawn');
  assert.equal(db.prepare('SELECT result FROM assessments WHERE id = ?').get(a.id).result, 'Not Pass');
});

test('the server enforces the order: no answering, opening or skipping out of turn', async () => {
  const a = await link(['IQ', 'GENERAL']);
  const other = await link(['IQ']);
  let s = (await candidate.post(url(a.token, '/start'), { ...CANDIDATE, name: 'Skipper' })).data;
  const iqQuestion = s.questions[0];

  // Continue while IQ is running just returns the IQ test.
  const early = (await candidate.post(url(a.token, '/continue'))).data;
  assert.equal(early.section, 'IQ');
  // Another assessment's question cannot be answered through this link.
  const o = (await candidate.post(url(other.token, '/start'), { ...CANDIDATE, name: 'Other' })).data;
  assert.equal((await candidate.put(url(a.token, '/answer'), { question_id: o.questions[0].id, answer: 'A' })).status, 400);

  s = await answerAndSubmit(a.token, s, true);
  assert.equal(s.state, 'next_test');
  // A finished test cannot be changed, and its pictures/questions are closed.
  assert.equal((await candidate.put(url(a.token, '/answer'), { question_id: iqQuestion.id, answer: 'B' })).status, 409);
  assert.equal((await candidate.post(url(a.token, '/submit'), { answers: { [iqQuestion.id]: 'B' } })).status, 409);

  // Two tabs pressing Continue open the next test only once.
  const [c1, c2] = await Promise.all([candidate.post(url(a.token, '/continue')), candidate.post(url(a.token, '/continue'))]);
  assert.equal(c1.data.section, 'GENERAL');
  assert.equal(c2.data.section, 'GENERAL');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assessment_questions WHERE assessment_id = ? AND section = 'GENERAL'").get(a.id).n, 4);
  // Only the running test's questions are sent.
  assert.ok(c1.data.questions.every((q) => q.section === 'GENERAL'));
});

test('each test has its own timer; when it runs out the test is submitted and passed answers still count', async () => {
  const a = await link(['IQ', 'GENERAL']);
  let s = (await candidate.post(url(a.token, '/start'), { ...CANDIDATE, name: 'Timer' })).data;
  // Answer everything correctly, then let the IQ time run out.
  const rows = db.prepare('SELECT id, correct_answer FROM assessment_questions WHERE assessment_id = ?').all(a.id);
  for (const q of rows) await candidate.put(url(a.token, '/answer'), { question_id: q.id, answer: q.correct_answer });
  db.prepare("UPDATE assessments SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(a.id);
  db.prepare("UPDATE assessment_stages SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE assessment_id = ? AND status = 'IN_PROGRESS'").run(a.id);
  assert.ok(finalizeExpired() >= 1);
  s = (await candidate.get(url(a.token))).data;
  assert.equal(s.state, 'next_test');
  assert.equal(s.auto_submitted, true);
  assert.equal(finalizeExpired(), 0, 'waiting between tests has no timer');
  s = (await candidate.post(url(a.token, '/continue'))).data;
  assert.equal(s.section, 'GENERAL');
});

test('only the chosen tests are included, in the fixed order', async () => {
  const a = await link(['GENERAL', 'IQ', 'ESSAY']);
  assert.deepEqual(a.stages.map((st) => st.section), ['IQ', 'GENERAL', 'ESSAY']);
  const b = await link(['CALCULATION']);
  assert.deepEqual(b.stages.map((st) => st.section), ['CALCULATION']);
  assert.equal(b.assessment_type, 'CALCULATION');
  const none = await admin.post('/api/admin/assessments', { tests: [], counts: {} });
  assert.equal(none.status, 400);
});

test('links made before tests were split into steps still work', async () => {
  // An old-style submitted IQ assessment without step rows.
  const cid = db.prepare("INSERT INTO candidates (name, created_at, updated_at) VALUES ('Legacy', ?, ?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
  const aid = db.prepare(`INSERT INTO assessments (token, candidate_id, assessment_type, sections, time_limit_minutes, link_expiry_minutes, link_expires_at,
    status, started_at, deadline_at, submitted_at, iq_points, iq_max, test_score, result, created_at)
    VALUES ('legacy-token-1', ?, 'IQ', '{"IQ":2}', 30, 60, '2030-01-01T00:00:00.000Z', 'SUBMITTED', '2026-01-01T09:00:00.000Z', '2026-01-01T09:30:00.000Z',
      '2026-01-01T09:10:00.000Z', 2, 2, 100, 'Pass', '2026-01-01T08:00:00.000Z')`).run(cid).lastInsertRowid;
  const review = await admin.get('/api/admin/assessments/' + aid);
  assert.equal(review.status, 200);
  assert.deepEqual(review.data.stages.map((st) => [st.section, st.status, st.result, st.submitted_at]), [['IQ', 'SUBMITTED', 'Pass', '2026-01-01T09:10:00.000Z']]);
  assert.equal((await candidate.get(url('legacy-token-1'))).data.state, 'submitted');
  assert.equal(db.prepare('SELECT result, submitted_at FROM assessments WHERE id = ?').get(aid).submitted_at, '2026-01-01T09:10:00.000Z');
});
