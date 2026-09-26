// IQ: 5 levels (marks 1-5), question count chosen by HR, drawn at random from
// the active pool (here 95 questions), and the one-link flow around it.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { start, stop, client, seedQuestions, db, CANDIDATE } = require('./helpers');
const { levelSplit, syncIqLevels, rescoreAll } = require('../src/assessments');

let admin;
const candidate = client();
const LEVELS = ['Easy', 'Basic', 'Moderate', 'Difficult', 'Very Difficult'];
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  // 19 questions per level = 95 active IQ questions, correct answer always A.
  // Added through the API so the level -> marks rule applies as for HR (marks: 9 is ignored).
  for (const level of LEVELS) for (let i = 1; i <= 19; i++) {
    const r = await admin.post('/api/admin/questions', { section: 'IQ', difficulty: level, category: 'Number Patterns', question_text: `Puzzle ${level} ${i}`, option_a: '1', option_b: '2', option_c: '3', option_d: '4', correct_answer: 'A', marks: 9 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  seedQuestions('GENERAL', 10);
  seedQuestions('CALCULATION', 10);
  db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES ('ESSAY', 'Why LALCO?', 10, ?)").run(new Date().toISOString());
});
test.after(stop);

const url = (token, path = '') => `/api/exam/${token}${path}`;
async function create(count, tests = ['IQ']) {
  return admin.post('/api/admin/assessments', { tests, counts: { IQ: count, GENERAL: 3, CALCULATION: 3, ESSAY: 1 }, minutes: { IQ: 20, GENERAL: 10, CALCULATION: 10, ESSAY: 20 }, link_expiry_minutes: 60 });
}
async function sit(name, count = 20, tests = ['IQ']) {
  const link = await create(count, tests);
  assert.equal(link.status, 201, JSON.stringify(link.data));
  const started = await candidate.post(url(link.data.token, '/start'), { ...CANDIDATE, name });
  return { id: link.data.id, token: link.data.token, state: started.data };
}
const copies = (id) => db.prepare('SELECT * FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(id);

test('the pool has 95 active IQ questions; marks follow the level (1-5), an entered mark is ignored', async () => {
  assert.equal((await admin.get('/api/admin/questions/counts')).data.IQ, 95);
  const marks = Object.fromEntries(db.prepare("SELECT difficulty, MIN(marks) AS lo, MAX(marks) AS hi FROM questions WHERE section = 'IQ' GROUP BY difficulty").all().map((r) => [r.difficulty, [r.lo, r.hi]]));
  assert.deepEqual(marks, { Easy: [1, 1], Basic: [2, 2], Moderate: [3, 3], Difficult: [4, 4], 'Very Difficult': [5, 5] });
});

test('TEST 1: pool of 95, IQ count 20 -> exactly 20 questions, 4 per level, maximum 60', async () => {
  const a = await sit('Twenty');
  assert.equal(a.state.questions.length, 20);
  const rows = copies(a.id);
  assert.equal(rows.length, 20, '20 copies saved, not 95');
  assert.deepEqual(rows.map((r) => r.difficulty), LEVELS.flatMap((l) => Array(4).fill(l)), 'Level 1 first, up to Level 5');
  assert.equal(rows.reduce((s, r) => s + r.max_marks, 0), 60);
  const json = JSON.stringify(a.state.questions);
  assert.ok(a.state.questions.every((q) => !('difficulty' in q) && !('max_marks' in q)), 'the candidate sees no level or marks');
  assert.ok(!/Basic|Moderate|Difficult/.test(json.replace(/Puzzle [A-Za-z ]+\d+/g, '')));
});

test('TEST 2 and 3: count 10 -> 10 questions; count 95 -> all 95', async () => {
  const ten = await sit('Ten', 10);
  assert.equal(copies(ten.id).length, 10);
  assert.deepEqual(copies(ten.id).map((r) => r.difficulty), LEVELS.flatMap((l) => [l, l]));
  const all = await sit('All', 95);
  assert.equal(copies(all.id).length, 95);
  assert.equal(new Set(copies(all.id).map((r) => r.question_id)).size, 95);
});

test('TEST 4 and 5: invalid counts are rejected (96, 0, -1, 20.5, text, empty)', async () => {
  for (const bad of [96, 0, -1, 20.5, 'abc', '']) {
    const r = await create(bad);
    assert.equal(r.status, 400, `count ${JSON.stringify(bad)} must be rejected`);
    assert.ok(r.data.error, 'with a clear message');
  }
  assert.match((await create(96)).data.error, /Only 95 active IQ questions/);
  assert.match((await create(0)).data.error, /at least 1 IQ question/);
  assert.equal((await create(1)).status, 201);
  assert.equal((await create(95)).status, 201);
});

test('the default 18 questions = 4 / 3 / 3 / 4 / 4, maximum 55; other lengths split evenly', async () => {
  assert.deepEqual(levelSplit(18), { Easy: 4, Basic: 3, Moderate: 3, Difficult: 4, 'Very Difficult': 4 });
  assert.deepEqual(levelSplit(20), { Easy: 4, Basic: 4, Moderate: 4, Difficult: 4, 'Very Difficult': 4 });
  assert.deepEqual(levelSplit(10), { Easy: 2, Basic: 2, Moderate: 2, Difficult: 2, 'Very Difficult': 2 });
  assert.deepEqual(levelSplit(30), { Easy: 6, Basic: 6, Moderate: 6, Difficult: 6, 'Very Difficult': 6 });
  const a = await sit('Eighteen', 18);
  assert.equal(copies(a.id).length, 18);
  assert.equal(copies(a.id).reduce((s, r) => s + r.max_marks, 0), 55);
});

test('TEST 6 and 7: random sets, no duplicates, shuffled answer order', async () => {
  const sets = new Set();
  let shuffled = false;
  for (let i = 0; i < 4; i++) {
    const a = await sit('Random ' + i);
    const rows = copies(a.id);
    assert.equal(new Set(rows.map((r) => r.question_id)).size, 20, 'no question twice');
    sets.add(rows.map((r) => r.question_id).sort().join(','));
    if (rows.some((r) => r.option_order !== '["A","B","C","D"]')) shuffled = true;
  }
  assert.ok(sets.size > 1, 'different candidates get different questions');
  assert.ok(shuffled, 'answer options are shuffled');
});

test('TEST 12: scoring uses only the selected questions (20 questions, maximum 60)', async () => {
  const a = await sit('Scorer');
  // Correct: all 4 of Level 1, 2 of Level 2, all of Level 3, 1 of Level 4, none of Level 5.
  const want = { Easy: 4, Basic: 2, Moderate: 4, Difficult: 1, 'Very Difficult': 0 };
  const seen = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  const answers = {};
  for (const q of copies(a.id)) answers[q.id] = seen[q.difficulty]++ < want[q.difficulty] ? 'A' : 'B';
  await candidate.post(url(a.token, '/submit'), { answers });
  const row = db.prepare('SELECT iq_points, iq_max, iq_correct, iq_total FROM assessments WHERE id = ?').get(a.id);
  assert.deepEqual(row, { iq_points: 4 + 4 + 12 + 4, iq_max: 60, iq_correct: 11, iq_total: 20 });
  const r = (await admin.get('/api/admin/results/iq')).data.find((x) => x.id === a.id);
  assert.equal(r.iq_text, '24 / 60');
  assert.equal(r.iq_score, 40);
  assert.deepEqual(r.iq_levels.map((l) => [l.level, l.correct_text, l.marks_text]),
    [[1, '4 / 4', '4 / 4'], [2, '2 / 4', '4 / 8'], [3, '4 / 4', '12 / 12'], [4, '1 / 4', '4 / 16'], [5, '0 / 4', '0 / 20']]);
  const cand = (await admin.get('/api/admin/candidates')).data.find((c) => c.name === 'Scorer');
  const x = XLSX.utils.sheet_to_json(XLSX.read((await admin.get(`/api/admin/candidates/${cand.id}/export.xlsx`, { raw: true })).buffer).Sheets.Candidates)[0];
  assert.equal(x['IQ Test Score'], '24 / 60');
  assert.equal(x['Level 5 Marks'], '0 / 20');
});

test('TEST 8: tests taken before the 5-level scale never change', async () => {
  // A finished test on the earlier 3-level scale: Medium (2 marks) and Hard (3 marks) copies.
  const cid = db.prepare("INSERT INTO candidates (name, created_at, updated_at) VALUES ('Old Scale', ?, ?)").run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').lastInsertRowid;
  const aid = db.prepare(`INSERT INTO assessments (token, candidate_id, assessment_type, sections, time_limit_minutes, link_expiry_minutes, link_expires_at, status, started_at, deadline_at, submitted_at, created_at)
    VALUES ('old-scale-token', ?, 'IQ', '{"IQ":3}', 10, 60, '2026-01-02T00:00:00.000Z', 'SUBMITTED', '2026-01-01T09:00:00.000Z', '2026-01-01T09:10:00.000Z', '2026-01-01T09:05:00.000Z', '2026-01-01T08:00:00.000Z')`).run(cid).lastInsertRowid;
  const add = db.prepare(`INSERT INTO assessment_questions (assessment_id, position, section, question_text, option_a, option_b, correct_answer, option_order, max_marks, difficulty, answer)
    VALUES (?, ?, 'IQ', ?, '1', '2', 'A', '["A","B"]', ?, ?, ?)`);
  add.run(aid, 1, 'Old easy', 1, 'Easy', 'A');
  add.run(aid, 2, 'Old medium', 2, 'Medium', 'A');
  add.run(aid, 3, 'Old hard', 3, 'Hard', 'B');
  require('../src/assessments').scoreAssessment(aid);
  const before = db.prepare('SELECT iq_points, iq_max, iq_breakdown, submitted_at, result FROM assessments WHERE id = ?').get(aid);
  const copiesBefore = JSON.stringify(copies(aid));
  assert.equal(before.iq_points, 3);
  assert.equal(before.iq_max, 6);

  syncIqLevels();
  rescoreAll();
  await admin.put('/api/admin/settings', { default_time_minutes: 30, default_link_expiry_minutes: 1440, pass_mark: 60, default_language: 'en' });
  assert.deepEqual(db.prepare('SELECT iq_points, iq_max, iq_breakdown, submitted_at, result FROM assessments WHERE id = ?').get(aid), before);
  assert.equal(JSON.stringify(copies(aid)), copiesBefore, 'copies (questions, answers, marks, levels) unchanged');
  const r = (await admin.get('/api/admin/results/iq')).data.find((x) => x.id === aid);
  assert.equal(r.iq_text, '3 / 6');
  assert.deepEqual(r.iq_levels.map((l) => l.label), ['Level 1 — Easy', 'Level 2 — Medium (earlier 3-level scale)', 'Level 3 — Hard (earlier 3-level scale)']);
});

test('TEST 9: one link with the 95 pool: 20 IQ -> General -> Calculation -> Essay -> COMPLETE', async () => {
  const a = await sit('Full Flow', 20, ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY']);
  let s = a.state;
  const keys = [];
  while (s.state === 'in_progress') {
    keys.push(s.section);
    if (s.section === 'IQ') assert.equal(s.questions.length, 20, 'exactly 20 IQ questions from the 95');
    const rows = copies(a.id).filter((q) => s.questions.some((x) => x.id === q.id));
    const answers = Object.fromEntries(rows.map((q) => [q.id, q.section === 'ESSAY' ? 'My essay.' : q.correct_answer]));
    s = (await candidate.post(url(a.token, '/submit'), { answers })).data;
    if (s.state === 'next_test') s = (await candidate.post(url(a.token, '/continue'))).data;
  }
  assert.deepEqual(keys, ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY']);
  assert.equal(s.outcome, 'completed');
  const essay = copies(a.id).find((q) => q.section === 'ESSAY');
  await admin.put(`/api/admin/assessments/${a.id}/essay-marks`, { marks: { [essay.id]: 8 } });
  assert.equal((await candidate.get(url(a.token))).data.current_stage, 'COMPLETE');
});

test('TEST 10 and 11: IQ failure stops the link; refresh resumes the same 20 questions', async () => {
  const a = await sit('Fails', 20, ['IQ', 'GENERAL']);
  const again = (await client().get(url(a.token))).data;
  assert.deepEqual(again.questions.map((q) => q.id), a.state.questions.map((q) => q.id), 'same 20 questions after a refresh');
  assert.equal(copies(a.id).length, 20, 'no new questions drawn on refresh');
  const answers = Object.fromEntries(copies(a.id).map((q) => [q.id, 'B']));
  const s = (await candidate.post(url(a.token, '/submit'), { answers })).data;
  assert.equal(s.outcome, 'stopped');
  assert.equal((await candidate.post(url(a.token, '/continue'))).status, 409);
});

test('import: levels 1-5 by number or name; missing = Level 3; unknown rejected', async () => {
  const form = new FormData();
  form.append('section', 'IQ');
  const csv = 'Question,Difficulty,Option A,Option B,Correct Answer,Marks\nQ1?,1,1,2,A,9\nQ2?,Basic,1,2,A,9\nQ3?,,1,2,A,\nQ4?,Level 4,1,2,A,\nQ5?,very difficult,1,2,A,\nQ6?,Tricky,1,2,A,\n';
  form.append('file', new Blob([Buffer.from(csv)]), 'levels.csv');
  const r = await admin.post('/api/admin/questions/import/preview', undefined, { form });
  assert.deepEqual(r.data.rows.map((x) => [x.question.difficulty, x.question.marks]),
    [['Easy', 1], ['Basic', 2], ['Moderate', 3], ['Difficult', 4], ['Very Difficult', 5], ['Moderate', 3]]);
  assert.match(r.data.rows[5].errors.join(' '), /Level must be 1-5/);
});

test('inactive questions are never selected and stay visible in the bank', async () => {
  const easy = db.prepare("SELECT * FROM questions WHERE section = 'IQ' AND difficulty = 'Easy' ORDER BY id").all();
  for (const q of easy.slice(4)) await admin.put('/api/admin/questions/' + q.id, { ...q, status: 'Inactive' });
  const inactive = new Set(easy.slice(4).map((q) => q.id));
  for (let i = 0; i < 3; i++) {
    const a = await sit('After Cleanup ' + i);
    assert.ok(copies(a.id).every((u) => !inactive.has(u.question_id)));
    assert.equal(copies(a.id).length, 20);
  }
  assert.equal((await admin.get('/api/admin/questions?section=IQ&status=Inactive')).data.questions.length, inactive.size);
  assert.equal((await admin.get('/api/admin/questions/counts')).data.IQ, 95 - inactive.size);
});
