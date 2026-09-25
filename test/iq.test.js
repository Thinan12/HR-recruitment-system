const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { start, stop, client, db, CANDIDATE } = require('./helpers');
const { levelSplit, syncIqLevels } = require('../src/assessments');

let admin;
const candidate = client();
const LEVELS = ['Easy', 'Medium', 'Hard'];
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  // 10 questions per level, all with correct answer A. Added through the API so
  // the level -> marks rule is applied exactly as for HR.
  for (const level of LEVELS) for (let i = 1; i <= 10; i++) {
    const r = await admin.post('/api/admin/questions', { section: 'IQ', difficulty: level, category: 'Number Patterns', question_text: `Puzzle ${level[0]}${i}`, option_a: '1', option_b: '2', option_c: '3', option_d: '4', correct_answer: 'A', marks: 9 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
});
test.after(stop);

async function sitIq(name, count = 18) {
  const link = await admin.post('/api/admin/assessments', { assessment_type: 'IQ', counts: { IQ: count }, time_limit_minutes: 20, link_expiry_minutes: 60 });
  assert.equal(link.status, 201, JSON.stringify(link.data));
  const started = await candidate.post(`/api/exam/${link.data.token}/start`, { ...CANDIDATE, name });
  return { id: link.data.id, token: link.data.token, questions: started.data.questions };
}
const levelsOf = (id) => db.prepare('SELECT difficulty FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(id).map((r) => r.difficulty);

test('marks follow the level: Level 1 = 1, Level 2 = 2, Level 3 = 3 (an entered mark is ignored)', () => {
  const marks = Object.fromEntries(db.prepare("SELECT difficulty, MIN(marks) AS lo, MAX(marks) AS hi FROM questions WHERE section = 'IQ' GROUP BY difficulty").all().map((r) => [r.difficulty, [r.lo, r.hi]]));
  assert.deepEqual(marks, { Easy: [1, 1], Medium: [2, 2], Hard: [3, 3] });
});

test('18 questions: 6 Level 1, then 6 Level 2, then 6 Level 3; maximum 36 marks', async () => {
  const a = await sitIq('Order Check');
  assert.equal(a.questions.length, 18);
  assert.deepEqual(levelsOf(a.id), [...Array(6).fill('Easy'), ...Array(6).fill('Medium'), ...Array(6).fill('Hard')]);
  const max = db.prepare('SELECT SUM(max_marks) AS m FROM assessment_questions WHERE assessment_id = ?').get(a.id).m;
  assert.equal(max, 36);
  // The candidate sees neither the level nor the marks.
  const json = JSON.stringify(a.questions);
  assert.ok(a.questions.every((q) => !('difficulty' in q) && !('marks' in q) && !('max_marks' in q)));
  assert.ok(!/Easy|Medium|Hard|mark/i.test(json.replace(/Puzzle [EMH]\d+/g, '')));
});

test('balanced split for other lengths (10, 15, 20, 30)', async () => {
  assert.deepEqual(levelSplit(10), { Easy: 3, Medium: 3, Hard: 4 });
  assert.deepEqual(levelSplit(15), { Easy: 5, Medium: 5, Hard: 5 });
  assert.deepEqual(levelSplit(18), { Easy: 6, Medium: 6, Hard: 6 });
  assert.deepEqual(levelSplit(20), { Easy: 7, Medium: 6, Hard: 7 });
  assert.deepEqual(levelSplit(30), { Easy: 10, Medium: 10, Hard: 10 });
  const ten = await sitIq('Ten', 10);
  assert.deepEqual(levelsOf(ten.id), ['Easy', 'Easy', 'Easy', 'Medium', 'Medium', 'Medium', 'Hard', 'Hard', 'Hard', 'Hard']);
});

test('different candidates get different random questions, always 6 / 6 / 6', async () => {
  const sets = new Set();
  for (let i = 0; i < 4; i++) {
    const a = await sitIq('Random ' + i);
    assert.deepEqual(levelsOf(a.id), [...Array(6).fill('Easy'), ...Array(6).fill('Medium'), ...Array(6).fill('Hard')]);
    sets.add(a.questions.map((q) => q.text).sort().join('|'));
  }
  assert.ok(sets.size > 1);
});

test('weighted score: 6 L1 + 4 L2 + 3 L3 correct = 6 + 8 + 9 = 23 / 36 = 63.89%', async () => {
  const a = await sitIq('John Smith');
  const rows = db.prepare('SELECT id, difficulty FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(a.id);
  const want = { Easy: 6, Medium: 4, Hard: 3 };
  const seen = { Easy: 0, Medium: 0, Hard: 0 };
  const answers = {};
  for (const q of rows) answers[q.id] = seen[q.difficulty]++ < want[q.difficulty] ? 'A' : 'B';
  await candidate.post(`/api/exam/${a.token}/submit`, { answers });

  const row = db.prepare('SELECT iq_points, iq_max, iq_correct, iq_total FROM assessments WHERE id = ?').get(a.id);
  assert.deepEqual(row, { iq_points: 23, iq_max: 36, iq_correct: 13, iq_total: 18 });
  assert.equal(Math.round((23 / 36) * 10000) / 100, 63.89);

  const r = (await admin.get('/api/admin/results/iq')).data.find((x) => x.id === a.id);
  assert.equal(r.iq_text, '23 / 36');
  assert.equal(r.iq_score, 63.9);
  assert.equal(r.iq_correct_text, '13 / 18');
  assert.deepEqual(r.iq_levels.map((l) => [l.label, l.correct_text, l.marks_text]), [
    ['Level 1 — Easy', '6 / 6', '6 / 6'], ['Level 2 — Medium', '4 / 6', '8 / 12'], ['Level 3 — Hard', '3 / 6', '9 / 18']]);

  const review = (await admin.get('/api/admin/assessments/' + a.id)).data.iq;
  assert.equal(review.iq_text, '23 / 36');
  const cand = (await admin.get('/api/admin/candidates')).data.find((c) => c.name === 'John Smith');
  assert.equal(cand.iq_text, '23 / 36');
  assert.equal(cand.iq_correct_text, '13 / 18');
  const dash = (await admin.get('/api/admin/dashboard')).data;
  assert.equal(dash.highest_iq.iq_text, '23 / 36');
  assert.equal(dash.highest_iq.iq_score, 63.9);

  // Exports carry the same numbers.
  const xls = await admin.get(`/api/admin/candidates/${cand.id}/export.xlsx`, { raw: true });
  const x = XLSX.utils.sheet_to_json(XLSX.read(xls.buffer).Sheets.Candidates)[0];
  assert.equal(x['IQ Test Score'], '23 / 36');
  assert.equal(x['IQ %'], 63.9);
  assert.equal(x['IQ Correct Answers'], '13 / 18');
  assert.deepEqual([x['Level 1 Correct'], x['Level 1 Marks'], x['Level 2 Correct'], x['Level 2 Marks'], x['Level 3 Correct'], x['Level 3 Marks']],
    ['6 / 6', '6 / 6', '4 / 6', '8 / 12', '3 / 6', '9 / 18']);
  const word = await admin.get(`/api/admin/candidates/${cand.id}/export.docx`, { raw: true });
  const text = (await mammoth.extractRawText({ buffer: word.buffer })).value;
  for (const s of ['23 / 36 marks (63.9%)', '13 / 18', 'Level 2 — Medium', '4 / 6 correct, 8 / 12 marks']) assert.ok(text.includes(s), s);
});

test('past tests are recalculated from levels without touching answers or dates', async () => {
  // A test sat on questions that had no level and 1 mark each (the old rule).
  const qid = db.prepare("INSERT INTO questions (section, difficulty, question_text, option_a, option_b, correct_answer, marks, created_at) VALUES ('IQ', '', 'Old unlevelled?', '1', '2', 'A', 1, ?)").run(new Date().toISOString()).lastInsertRowid;
  const cid = db.prepare("INSERT INTO candidates (name, created_at, updated_at) VALUES ('Old Candidate', ?, ?)").run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').lastInsertRowid;
  const aid = db.prepare(`INSERT INTO assessments (token, candidate_id, assessment_type, sections, time_limit_minutes, link_expiry_minutes, link_expires_at, status, started_at, deadline_at, submitted_at, created_at, iq_points, iq_max, iq_breakdown)
    VALUES ('old-token-xyz', ?, 'IQ', '{"IQ":1}', 10, 60, '2026-01-02T00:00:00.000Z', 'SUBMITTED', '2026-01-01T09:00:00.000Z', '2026-01-01T09:10:00.000Z', '2026-01-01T09:05:00.000Z', '2026-01-01T08:00:00.000Z', 1, 1, '{"Not set":[1,1]}')`).run(cid).lastInsertRowid;
  db.prepare(`INSERT INTO assessment_questions (assessment_id, question_id, position, section, question_text, option_a, option_b, correct_answer, option_order, max_marks, answer, marks_awarded)
    VALUES (?, ?, 1, 'IQ', 'Old unlevelled?', '1', '2', 'A', '["A","B"]', 1, 'A', 1)`).run(aid, qid);

  // HR gives the question its level (Level 3); the old test follows.
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(qid);
  const put = await admin.put('/api/admin/questions/' + qid, { ...q, difficulty: 'Hard' });
  assert.equal(put.data.marks, 3);
  const a = db.prepare('SELECT iq_points, iq_max, iq_correct, iq_total, submitted_at FROM assessments WHERE id = ?').get(aid);
  assert.deepEqual(a, { iq_points: 3, iq_max: 3, iq_correct: 1, iq_total: 1, submitted_at: '2026-01-01T09:05:00.000Z' });
  const aq = db.prepare('SELECT answer, difficulty FROM assessment_questions WHERE assessment_id = ?').get(aid);
  assert.deepEqual(aq, { answer: 'A', difficulty: 'Hard' });
  assert.equal(syncIqLevels(), 0, 'running again changes nothing');
});

test('import: level decides marks, missing level -> Level 2, unknown level is rejected', async () => {
  const form = new FormData();
  form.append('section', 'IQ');
  const csv = 'Question,Difficulty,Option A,Option B,Correct Answer,Marks\nQ one?,easy,1,2,A,5\nQ two?,Level 3,1,2,B,1\nQ three?,ປານກາງ,1,2,A,\nQ four?,,1,2,A,\nQ five?,Tricky,1,2,A,\n';
  form.append('file', new Blob([Buffer.from(csv)]), 'levels.csv');
  const r = await admin.post('/api/admin/questions/import/preview', undefined, { form });
  assert.deepEqual(r.data.rows.map((x) => [x.question.difficulty, x.question.marks]), [['Easy', 1], ['Hard', 3], ['Medium', 2], ['Medium', 2], ['Medium', 2]]);
  assert.match(r.data.rows[4].errors.join(' '), /Level must be 1, 2 or 3/);
});

test('inactive questions are never selected, stay visible in the bank, and past reviews still work', async () => {
  // A finished test that used Level 1 questions.
  const past = await sitIq('Before Cleanup');
  await candidate.post(`/api/exam/${past.token}/submit`, { answers: {} });
  const before = db.prepare('SELECT iq_points, iq_max, submitted_at FROM assessments WHERE id = ?').get(past.id);

  // Make every Level 1 question except three Inactive (status only).
  const easy = db.prepare("SELECT * FROM questions WHERE section = 'IQ' AND difficulty = 'Easy' ORDER BY id").all();
  for (const q of easy.slice(3)) {
    const r = await admin.put('/api/admin/questions/' + q.id, { ...q, status: 'Inactive' });
    assert.equal(r.data.status, 'Inactive');
    assert.equal(r.data.question_text, q.question_text);
    assert.equal(r.data.correct_answer, q.correct_answer);
    assert.equal(r.data.difficulty, q.difficulty);
    assert.equal(r.data.marks, q.marks);
  }
  // An active IQ question without a level is not usable either.
  db.prepare("INSERT INTO questions (section, difficulty, question_text, option_a, option_b, correct_answer, marks, created_at) VALUES ('IQ', '', 'No level yet?', '1', '2', 'A', 1, ?)").run(new Date().toISOString());
  const inactiveIds = new Set(easy.slice(3).map((q) => q.id));

  for (let i = 0; i < 5; i++) {
    const a = await sitIq('After Cleanup ' + i);
    const used = db.prepare('SELECT question_id, difficulty, question_text FROM assessment_questions WHERE assessment_id = ?').all(a.id);
    assert.ok(used.every((u) => !inactiveIds.has(u.question_id)), 'no inactive question is used');
    assert.ok(used.every((u) => u.question_text !== 'No level yet?'), 'an unlevelled question is not used');
    assert.equal(used.length, 18);
  }

  // The bank shows active and inactive counts, and can list inactive questions.
  const bank = (await admin.get('/api/admin/questions?section=IQ&status=Inactive')).data;
  assert.ok(bank.questions.length >= inactiveIds.size && bank.questions.every((q) => q.status === 'Inactive'));
  assert.ok(bank.inactive_counts.IQ >= inactiveIds.size);
  const usable = db.prepare("SELECT COUNT(*) AS n FROM questions WHERE section = 'IQ' AND status = 'Active' AND difficulty IN ('Easy', 'Medium', 'Hard')").get().n;
  assert.equal((await admin.get('/api/admin/questions/counts')).data.IQ, usable, 'counts cover active, levelled questions only');

  // The earlier test is unchanged and still opens and exports.
  assert.deepEqual(db.prepare('SELECT iq_points, iq_max, submitted_at FROM assessments WHERE id = ?').get(past.id), before);
  const review = await admin.get('/api/admin/assessments/' + past.id);
  assert.equal(review.status, 200);
  assert.equal(review.data.questions.length, 18);
  const cid = db.prepare('SELECT candidate_id FROM assessments WHERE id = ?').get(past.id).candidate_id;
  assert.equal((await admin.get(`/api/admin/candidates/${cid}/export.pdf`, { raw: true })).status, 200);

  // Uploading a copy of an inactive question again is skipped, not inserted.
  const q = easy[5];
  const form = new FormData();
  form.append('section', 'IQ');
  form.append('file', new Blob([Buffer.from(`Question,Difficulty,Option A,Option B,Option C,Option D,Correct Answer\n"${q.question_text}",Easy,1,2,3,4,A\n`)]), 'again.csv');
  const p = await admin.post('/api/admin/questions/import/preview', undefined, { form });
  assert.equal(p.data.valid, 0);
  assert.match(p.data.rows[0].errors.join(' '), /already in the question bank/);
});
