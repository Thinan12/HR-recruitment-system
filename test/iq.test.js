const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, client, db, CANDIDATE } = require('./helpers');

let admin;
const candidate = client();
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  const insert = db.prepare(`INSERT INTO questions (section, difficulty, question_text, option_a, option_b, option_c, option_d, correct_answer, marks, created_at)
    VALUES ('IQ', ?, ?, '1', '2', '3', '4', 'A', 1, ?)`);
  for (const level of ['Easy', 'Medium', 'Hard']) for (let i = 1; i <= 10; i++) insert.run(level, `${level} question ${i}`, new Date().toISOString());
});
test.after(stop);

async function sitIq(name, count = 18) {
  const link = await admin.post('/api/admin/assessments', { assessment_type: 'IQ', counts: { IQ: count }, time_limit_minutes: 20, link_expiry_minutes: 60 });
  assert.equal(link.status, 201, JSON.stringify(link.data));
  const started = await candidate.post(`/api/exam/${link.data.token}/start`, { ...CANDIDATE, name });
  return { id: link.data.id, token: link.data.token, questions: started.data.questions };
}

test('an 18-question IQ test goes from Easy to Hard (1-7 Easy, 8-12 Medium, 13-18 Hard)', async () => {
  const a = await sitIq('Order Check');
  assert.equal(a.questions.length, 18);
  const levels = db.prepare('SELECT difficulty FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(a.id).map((r) => r.difficulty);
  assert.deepEqual(levels, [...Array(7).fill('Easy'), ...Array(5).fill('Medium'), ...Array(6).fill('Hard')]);
  assert.ok(a.questions.every((q) => !('difficulty' in q)), 'difficulty is not sent to the candidate');

  const b = await sitIq('Order Check 2');
  assert.notDeepEqual(a.questions.map((q) => q.text).sort(), b.questions.map((q) => q.text).sort(), 'candidates get different random sets');
});

test('other lengths keep the same shape, and a short level is filled from the others', async () => {
  const ten = await sitIq('Ten', 10);
  const levels = db.prepare('SELECT difficulty FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(ten.id).map((r) => r.difficulty);
  assert.deepEqual(levels, ['Easy', 'Easy', 'Easy', 'Easy', 'Medium', 'Medium', 'Medium', 'Hard', 'Hard', 'Hard']);

  const thirty = await sitIq('Thirty', 30); // wants 12 Easy but only 10 exist
  const l30 = db.prepare('SELECT difficulty FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(thirty.id).map((r) => r.difficulty);
  assert.equal(l30.length, 30);
  assert.deepEqual(l30, [...l30].sort((x, y) => ['Easy', 'Medium', 'Hard'].indexOf(x) - ['Easy', 'Medium', 'Hard'].indexOf(y)), 'still ordered Easy -> Hard');
});

test('IQ Test Score is stored as correct / total with a breakdown by difficulty', async () => {
  const a = await sitIq('Keo Easy-Only');
  // Answer only the Easy questions correctly (correct letter is A).
  const rows = db.prepare('SELECT id, difficulty FROM assessment_questions WHERE assessment_id = ?').all(a.id);
  const answers = Object.fromEntries(rows.map((q) => [q.id, q.difficulty === 'Easy' ? 'A' : 'B']));
  await candidate.post(`/api/exam/${a.token}/submit`, { answers });

  const row = db.prepare('SELECT iq_correct, iq_total, iq_breakdown FROM assessments WHERE id = ?').get(a.id);
  assert.equal(row.iq_correct, 7);
  assert.equal(row.iq_total, 18);
  assert.deepEqual(JSON.parse(row.iq_breakdown), { Easy: [7, 7], Medium: [0, 5], Hard: [0, 6] });

  const iq = (await admin.get('/api/admin/results/iq')).data.find((r) => r.id === a.id);
  assert.equal(iq.candidate_name, 'Keo Easy-Only');
  assert.equal(iq.iq_correct, 7);
  assert.equal(iq.iq_percent, 38.9);

  const cand = (await admin.get('/api/admin/candidates')).data.find((c) => c.name === 'Keo Easy-Only');
  assert.equal(cand.iq_text, '7 / 18');
  const dash = (await admin.get('/api/admin/dashboard')).data;
  assert.equal(dash.highest_iq.iq_text, '7 / 18');
});

test('imported difficulty is standardised (easy / HARD / Lao)', async () => {
  const form = new FormData();
  form.append('section', 'IQ');
  const csv = 'Question,Difficulty,Option A,Option B,Correct Answer\nQ one?,easy,1,2,A\nQ two?,HARD,1,2,B\nQ three?,ປານກາງ,1,2,A\nQ four?,Level 3,1,2,A\n';
  form.append('file', new Blob([Buffer.from(csv)]), 'levels.csv');
  const r = await admin.post('/api/admin/questions/import/preview', undefined, { form });
  assert.deepEqual(r.data.rows.map((x) => x.question.difficulty), ['Easy', 'Hard', 'Medium', 'Level 3']);
});
