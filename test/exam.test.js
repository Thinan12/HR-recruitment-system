const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, client, seedQuestions, db, CANDIDATE, attemptOf } = require('./helpers');
const { finalizeExpired } = require('../src/assessments');

let admin;
const candidate = client();
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 30);
  seedQuestions('GENERAL', 10);
});
test.after(stop);

async function newLink(extra = {}) {
  const r = await admin.post('/api/admin/assessments', { assessment_type: 'IQ', counts: { IQ: 10 }, time_limit_minutes: 30, link_expiry_minutes: 60, language: 'en', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
const exam = (token, path = '') => `/api/exam/${token}${path}`;
const startExam = (token, info = CANDIDATE) => candidate.post(exam(token, '/start'), info);
const expireDeadline = (id) => db.prepare("UPDATE assessments SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);

test('link tokens are long and unpredictable', async () => {
  const a = await newLink();
  const b = await newLink();
  assert.ok(a.token.length >= 32);
  assert.notEqual(a.token, b.token);
  assert.equal((await candidate.get(exam('guess123'))).status, 404);
});

test('cannot create an assessment needing more questions than the bank has', async () => {
  const r = await admin.post('/api/admin/assessments', { assessment_type: 'IQ', counts: { IQ: 200 }, time_limit_minutes: 30, link_expiry_minutes: 60 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Only 30 active IQ questions/);
});

test('candidate information is required and saved when the assessment starts', async () => {
  const a = await newLink();
  const ready = await candidate.get(exam(a.token));
  assert.equal(ready.data.state, 'ready');
  assert.equal(ready.data.question_count, 10);

  const missing = await startExam(a.token, { ...CANDIDATE, phone: '' });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error, 'phone_required');

  const r = await startExam(a.token);
  assert.equal(r.data.state, 'in_progress');
  assert.equal(r.data.questions.length, 10);
  assert.ok(r.data.remaining_seconds > 29 * 60 && r.data.remaining_seconds <= 30 * 60);
  assert.equal(r.data.candidate.name, CANDIDATE.name);

  const saved = db.prepare('SELECT c.* FROM assessments a JOIN candidates c ON c.id = a.candidate_id WHERE a.id = ?').get(attemptOf(a));
  for (const [k, v] of Object.entries(CANDIDATE)) assert.equal(saved[k], v, k);
});

test('questions never reveal the correct answer to the browser', async () => {
  const a = await newLink();
  const r = await startExam(a.token);
  const json = JSON.stringify(r.data);
  assert.ok(!json.includes('correct_answer'));
  assert.ok(!json.includes('marks'));
});

test('each candidate gets a random set with no duplicates, and shuffled options that still grade correctly', async () => {
  const sets = [];
  let orderChanged = false;
  for (let i = 0; i < 6; i++) {
    const a = await newLink();
    const r = await startExam(a.token, { ...CANDIDATE, name: 'Random ' + i });
    const ids = r.data.questions.map((q) => q.text);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate question in one assessment');
    sets.push(ids.sort().join('|'));
    if (r.data.questions.some((q) => q.options.map((o) => o.key).join('') !== 'ABCD')) orderChanged = true;

    // Answer every question correctly by the original letter; shuffling must not matter.
    const rows = db.prepare('SELECT id, correct_answer FROM assessment_questions WHERE assessment_id = ?').all(attemptOf(a));
    const answers = Object.fromEntries(rows.map((q) => [q.id, q.correct_answer]));
    const done = await candidate.post(exam(a.token, '/submit'), { answers });
    assert.equal(done.data.state, 'submitted');
    const scored = db.prepare('SELECT test_score, iq_points, iq_max FROM assessments WHERE id = ?').get(attemptOf(a));
    assert.equal(scored.test_score, 100);
    assert.equal(scored.iq_points, 10);
  }
  assert.ok(new Set(sets).size > 1, 'different candidates receive different questions');
  assert.ok(orderChanged, 'answer options are shuffled');
});

test('answers autosave and are counted on submit', async () => {
  const a = await newLink();
  const r = await startExam(a.token);
  const q = r.data.questions[0];
  const correct = db.prepare('SELECT correct_answer FROM assessment_questions WHERE id = ?').get(q.id).correct_answer;
  assert.equal((await candidate.put(exam(a.token, '/answer'), { question_id: q.id, answer: correct })).status, 200);
  const again = await candidate.get(exam(a.token));
  assert.equal(again.data.questions[0].answer, correct, 'resuming shows saved answers');
  await candidate.post(exam(a.token, '/submit'), {});
  const s = db.prepare('SELECT iq_points FROM assessments WHERE id = ?').get(attemptOf(a));
  assert.equal(s.iq_points, 1);
});

test('candidate cannot submit twice or reuse a completed link', async () => {
  const a = await newLink();
  await startExam(a.token);
  const first = await candidate.post(exam(a.token, '/submit'), { answers: {} });
  assert.equal(first.status, 200);
  const done = attemptOf(a);
  const before = JSON.stringify(db.prepare('SELECT * FROM assessments WHERE id = ?').get(done));
  // Submitting again: the finished attempt released the browser, so there is nothing to submit.
  const second = await candidate.post(exam(a.token, '/submit'), { answers: {} });
  assert.equal(second.status, 409);
  assert.notEqual(second.data.state, 'in_progress');
  assert.equal((await candidate.get(exam(a.token))).data.state, 'ready', 'reopening shows the start form');
  // Starting again is a NEW attempt on the same link; the finished one is untouched.
  assert.equal((await startExam(a.token)).data.state, 'in_progress');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessments WHERE link_id = ?').get(a.id).n, 2);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM assessments WHERE id = ?').get(done)), before);
});

test('double-clicking Start only starts once', async () => {
  const a = await newLink();
  const [r1, r2] = await Promise.all([startExam(a.token), startExam(a.token)]);
  assert.equal(r1.data.state, 'in_progress');
  assert.equal(r2.data.state, 'in_progress');
  const n = db.prepare('SELECT COUNT(*) AS n FROM assessment_questions WHERE assessment_id = ?').get(attemptOf(a)).n;
  assert.equal(n, 10);
});

test('an expired link lets no new candidate start', async () => {
  const a = await newLink({ link_expiry_minutes: 10 });
  db.prepare("UPDATE assessment_links SET link_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(a.id);
  const fresh = client();
  assert.equal((await fresh.get(exam(a.token))).data.state, 'expired');
  const r = await fresh.post(exam(a.token, '/start'), CANDIDATE);
  assert.equal(r.status, 409);
  assert.equal(r.data.state, 'expired');
  assert.equal(attemptOf(a), undefined, 'no attempt was created');
  // The expired link is still on record for HR.
  const list = await admin.get('/api/admin/assessments');
  assert.equal(list.data.find((x) => x.kind === 'link' && x.id === a.id).share_state, 'expired');
});

test('disabled link cannot be started; enabling restores it; an unused link can get a new address', async () => {
  const a = await newLink();
  await admin.post(`/api/admin/links/${a.id}/disable`);
  const fresh = client();
  assert.equal((await fresh.get(exam(a.token))).data.state, 'disabled');
  assert.equal((await fresh.post(exam(a.token, '/start'), CANDIDATE)).status, 409);

  await admin.post(`/api/admin/links/${a.id}/enable`);
  assert.equal((await fresh.get(exam(a.token))).data.state, 'ready');

  const regen = await admin.post(`/api/admin/links/${a.id}/regenerate`);
  assert.notEqual(regen.data.token, a.token);
  assert.equal((await fresh.get(exam(a.token))).status, 404, 'old link stops working');
  assert.equal((await fresh.get(exam(regen.data.token))).data.state, 'ready');

  // Once a candidate has used the link its address stays, and it cannot be deleted.
  await fresh.post(exam(regen.data.token, '/start'), CANDIDATE);
  assert.equal((await admin.post(`/api/admin/links/${a.id}/regenerate`)).status, 400);
  assert.equal((await admin.del(`/api/admin/links/${a.id}`)).status, 400);
  const unused = await newLink();
  assert.equal((await admin.del(`/api/admin/links/${unused.id}`)).status, 200);
});

test('server rejects answers after the deadline and auto-submits', async () => {
  const a = await newLink();
  const r = await startExam(a.token);
  expireDeadline(attemptOf(a));
  const late = await candidate.put(exam(a.token, '/answer'), { question_id: r.data.questions[0].id, answer: 'A' });
  assert.equal(late.status, 409);
  assert.equal(late.data.state, 'submitted');
  assert.equal(late.data.auto_submitted, true);
  const row = db.prepare('SELECT status, auto_submitted, submitted_at FROM assessments WHERE id = ?').get(attemptOf(a));
  assert.equal(row.status, 'SUBMITTED');
  assert.equal(row.auto_submitted, 1);
  assert.ok(row.submitted_at);
});

test('a submit arriving long after the deadline does not count its answers', async () => {
  const a = await newLink();
  const r = await startExam(a.token);
  expireDeadline(attemptOf(a));
  const rows = db.prepare('SELECT id, correct_answer FROM assessment_questions WHERE assessment_id = ?').all(attemptOf(a));
  const res = await candidate.post(exam(a.token, '/submit'), { answers: Object.fromEntries(rows.map((q) => [q.id, q.correct_answer])) });
  assert.equal(res.data.state, 'submitted');
  assert.equal(db.prepare('SELECT iq_points FROM assessments WHERE id = ?').get(attemptOf(a)).iq_points, 0);
  assert.ok(r.data.questions.length > 0);
});

test('the background sweep submits assessments abandoned after the deadline', async () => {
  const a = await newLink();
  await startExam(a.token);
  expireDeadline(attemptOf(a));
  assert.ok(finalizeExpired() >= 1);
  const row = db.prepare('SELECT status, auto_submitted, result FROM assessments WHERE id = ?').get(attemptOf(a));
  assert.equal(row.status, 'SUBMITTED');
  assert.equal(row.auto_submitted, 1);
  assert.equal(row.result, 'Not Pass');
  assert.equal(finalizeExpired(), 0, 'running again changes nothing');
});

test('a shared link never pre-fills anyone\'s details', async () => {
  const c = await admin.post('/api/admin/candidates', { name: 'Pre-registered Person', phone: '111' });
  const a = await newLink({ candidate_id: c.data.id });
  const ready = (await client().get(exam(a.token))).data;
  assert.equal(ready.state, 'ready');
  assert.equal(ready.candidate, undefined);
  assert.ok(!JSON.stringify(ready).includes('Pre-registered'));
});

test('an older one-person link (made before shared links) still works and pre-fills its candidate', async () => {
  const c = await admin.post('/api/admin/candidates', { name: 'Legacy Invitee', phone: '111' });
  db.prepare(`INSERT INTO assessments (token, candidate_id, assessment_type, sections, time_limit_minutes, link_expiry_minutes, link_expires_at, created_at)
    VALUES ('legacy-one-person-link-000000000000', ?, 'IQ', '{"IQ":3}', 10, 60, '2099-01-01T00:00:00.000Z', ?)`).run(c.data.id, new Date().toISOString());
  const aid = db.prepare("SELECT id FROM assessments WHERE token = 'legacy-one-person-link-000000000000'").get().id;
  db.prepare("INSERT INTO assessment_stages (assessment_id, position, section, question_count, time_limit_minutes, pass_mark) VALUES (?, 1, 'IQ', 3, 10, 60)").run(aid);
  const legacy = client();
  const ready = (await legacy.get(exam('legacy-one-person-link-000000000000'))).data;
  assert.equal(ready.candidate.name, 'Legacy Invitee', 'form is pre-filled');
  const s = (await legacy.post(exam('legacy-one-person-link-000000000000', '/start'), { ...CANDIDATE, name: 'Legacy Invitee', phone: '222' })).data;
  assert.equal(s.state, 'in_progress');
  assert.equal(db.prepare('SELECT phone FROM candidates WHERE id = ?').get(c.data.id).phone, '222');
  // Anyone else opening it sees the same single attempt, as before.
  assert.equal((await client().get(exam('legacy-one-person-link-000000000000'))).data.state, 'in_progress');
});

test('a Lao link needs Lao-ready questions; its language is returned to the exam page', async () => {
  const none = await admin.post('/api/admin/assessments', { assessment_type: 'IQ', counts: { IQ: 10 }, link_expiry_minutes: 60, language: 'lo' });
  assert.equal(none.status, 400);
  assert.match(none.data.error, /Only 0 IQ questions have a Lao translation ready \(30 more need Lao translation/);
  db.prepare("UPDATE questions SET question_text_lo = 'ຄຳຖາມ ' || id, option_a_lo = 'opt A', option_b_lo = 'opt B', option_c_lo = 'opt C', option_d_lo = 'opt D', lo_status = 'translated' WHERE section = 'IQ'").run();
  const a = await newLink({ language: 'lo' });
  assert.equal((await candidate.get(exam(a.token))).data.language, 'lo');
});

test('focus changes are counted', async () => {
  const a = await newLink();
  await startExam(a.token);
  await candidate.post(exam(a.token, '/focus-lost'));
  await candidate.post(exam(a.token, '/focus-lost'));
  assert.equal(db.prepare('SELECT focus_losses FROM assessments WHERE id = ?').get(attemptOf(a)).focus_losses, 2);
});

test('combined assessment: one link, IQ first, General only after IQ is passed', async () => {
  const a = await newLink({ assessment_type: 'COMBINED', counts: { IQ: 3, GENERAL: 2, CALCULATION: 0, ESSAY: 0 } });
  const r = await startExam(a.token);
  assert.deepEqual([...new Set(r.data.questions.map((q) => q.section))], ['IQ']);
  const rows = db.prepare('SELECT id, correct_answer FROM assessment_questions WHERE assessment_id = ?').all(attemptOf(a));
  const passed = await candidate.post(exam(a.token, '/submit'), { answers: Object.fromEntries(rows.map((q) => [q.id, q.correct_answer])) });
  assert.equal(passed.data.state, 'next_test');
  const next = await candidate.post(exam(a.token, '/continue'));
  assert.equal(next.data.state, 'in_progress');
  assert.deepEqual([...new Set(next.data.questions.map((q) => q.section))], ['GENERAL']);
  assert.equal(next.data.questions.length, 2);
});

test('identical wording is never shown twice, even if the bank has copies', async () => {
  const insert = db.prepare(`INSERT INTO questions (section, question_text, option_a, option_b, correct_answer, marks, created_at)
    VALUES ('CALCULATION', ?, '1', '2', 'A', 1, ?)`);
  for (let i = 0; i < 5; i++) insert.run('Same question  text?', new Date().toISOString());
  insert.run('Different question?', new Date().toISOString());
  // 6 rows but only 2 different questions: a 6-question link is refused (a candidate never gets fewer than HR set).
  const six = await admin.post('/api/admin/assessments', { assessment_type: 'CALCULATION', counts: { CALCULATION: 6 }, link_expiry_minutes: 60 });
  assert.equal(six.status, 400);
  assert.match(six.data.error, /Only 2 different Calculation questions are in the question bank \(4 are copies/);
  const a = await newLink({ assessment_type: 'CALCULATION', counts: { CALCULATION: 2 } });
  const r = await startExam(a.token);
  assert.deepEqual(r.data.questions.map((q) => q.text).sort(), ['Different question?', 'Same question  text?']);
});
