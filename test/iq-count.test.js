// IQ question count: HR's number = the candidate's questions = the level
// counts; the maximum is the sum of the marks of THOSE questions (never the
// bank size, a default, or 6 per level). The candidate is not shown the IQ %.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { start, stop, client, db, CANDIDATE } = require('./helpers');
const { levelSplit, LEVEL_MARKS, DIFFICULTIES } = require('../src/assessments');

const LEVELS = ['Easy', 'Basic', 'Moderate', 'Difficult', 'Very Difficult'];
let admin;
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  // A bank bigger than any test: 20 per level = 100 IQ questions, all Lao-ready.
  const insert = db.prepare(`INSERT INTO questions (section, difficulty, question_text, option_a, option_b, option_c, option_d, correct_answer, marks, created_at,
    question_text_lo, option_a_lo, option_b_lo, option_c_lo, option_d_lo, lo_status) VALUES ('IQ', ?, ?, 'w', 'x', 'y', 'z', 'A', ?, ?, ?, 'w', 'x', 'y', 'z', 'translated')`);
  for (const level of LEVELS) for (let i = 1; i <= 20; i++) insert.run(level, `IQ ${level} ${i}?`, LEVEL_MARKS[level], new Date().toISOString(), `ຄຳຖາມ IQ ${level} ${i}?`);
});
test.after(stop);

const maxFor = (n) => { const s = levelSplit(n); return DIFFICULTIES.reduce((sum, d) => sum + s[d] * LEVEL_MARKS[d], 0); };
const newLink = async (n, extra = {}) => {
  const r = await admin.post('/api/admin/assessments', { tests: ['IQ'], counts: { IQ: n }, minutes: { IQ: 30 }, link_expiry_minutes: 60, pass_marks: { IQ: 0 }, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const saved = (aid) => db.prepare("SELECT * FROM assessment_questions WHERE assessment_id = ? AND section = 'IQ' ORDER BY position").all(aid);
const attempt = (link, name) => db.prepare('SELECT a.id FROM assessments a JOIN candidates c ON c.id = a.candidate_id WHERE a.link_id = ? AND c.name = ?').get(link.id, name).id;
const splitOf = (rows) => LEVELS.map((l) => rows.filter((q) => q.difficulty === l).length);

test('every count 10-30: level counts add up to the count, maximum = sum of the level weights', () => {
  for (let n = 10; n <= 30; n++) {
    const s = levelSplit(n);
    assert.equal(DIFFICULTIES.reduce((sum, d) => sum + s[d], 0), n, `n=${n}`);
  }
  assert.deepEqual(DIFFICULTIES.map((d) => levelSplit(18)[d]), [4, 3, 3, 4, 4]);
  assert.deepEqual(DIFFICULTIES.map((d) => levelSplit(30)[d]), [6, 6, 6, 6, 6]);
  assert.deepEqual([10, 15, 18, 20, 30].map(maxFor), [30, 45, 55, 60, 90]);
});

test('18 questions: exactly 18 saved (4/3/3/4/4, max 55); 27 marks -> 27 / 55, 10 / 18 correct, LALCO 74 Borderline; everywhere the same', async () => {
  const link = await newLink(18);
  const c = client();
  const s = (await c.post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name: 'Eighteen' })).data;
  assert.equal(s.questions.length, 18, 'Question 1 of 18 … 18 of 18');
  const aid = attempt(link, 'Eighteen');
  const rows = saved(aid);
  assert.equal(rows.length, 18);
  assert.deepEqual(splitOf(rows), [4, 3, 3, 4, 4]);
  assert.equal(rows.reduce((m, q) => m + q.max_marks, 0), 55);

  // Refresh: same 18 questions, order, options and deadline.
  const again = (await c.get(`/api/exam/${link.token}`)).data;
  assert.deepEqual(again.questions.map((q) => [q.id, JSON.stringify(q.options)]), s.questions.map((q) => [q.id, JSON.stringify(q.options)]));
  assert.equal(again.deadline_at ?? again.remaining_seconds != null, s.deadline_at ?? s.remaining_seconds != null);
  assert.deepEqual(saved(aid).map((q) => q.id), rows.map((q) => q.id));

  // Right: 3 of 4 Level 1, 1 of 3 Level 2, 3 of 3 Level 3, 2 of 4 Level 4, 1 of 4 Level 5 = 10 correct, 3+2+9+8+5 = 27 marks.
  const right = { Easy: 3, Basic: 1, Moderate: 3, Difficult: 2, 'Very Difficult': 1 };
  const answers = {};
  for (const l of LEVELS) rows.filter((q) => q.difficulty === l).forEach((q, i) => { answers[q.id] = i < right[l] ? 'A' : 'B'; });
  const done = (await c.post(`/api/exam/${link.token}/submit`, { answers })).data;
  assert.deepEqual([done.last_result.points, done.last_result.max, done.last_result.lalco_iq_score, done.last_result.level], [27, 55, 74, 'Borderline']);
  assert.equal('percent' in done.last_result, false, 'the candidate is not sent the IQ percentage');
  assert.equal(JSON.stringify(done).includes('49.1'), false);

  const st = db.prepare("SELECT * FROM assessment_stages WHERE assessment_id = ? AND section = 'IQ'").get(aid);
  assert.deepEqual([st.question_count, st.points, st.max, st.percent], [18, 27, 55, 49.1]);
  const r = (await admin.get('/api/admin/results/iq')).data.find((x) => x.id === aid);
  assert.deepEqual([r.iq_correct_text, r.iq_text, r.iq_score, r.lalco_iq_score, r.iq_category], ['10 / 18', '27 / 55', 49.1, 74, 'Borderline']);
  assert.deepEqual(r.iq_levels.map((l) => [l.level, l.correct_text, l.marks_text]),
    [[1, '3 / 4', '3 / 4'], [2, '1 / 3', '2 / 6'], [3, '3 / 3', '9 / 9'], [4, '2 / 4', '8 / 16'], [5, '1 / 4', '5 / 20']]);
  const review = (await admin.get('/api/admin/assessments/' + aid)).data;
  assert.deepEqual([review.tests[0].score_text, review.tests[0].percent, review.tests[0].lalco_iq_score, review.tests[0].questions_assigned, review.tests[0].review_required],
    ['27 / 55', 49.1, 74, 18, null], 'HR still sees the percentage');
  const cand = (await admin.get('/api/admin/candidates')).data.find((x) => x.name === 'Eighteen');
  assert.deepEqual([cand.iq_text, cand.iq_correct_text, cand.iq_score, cand.lalco_iq_score], ['27 / 55', '10 / 18', 49.1, 74]);

  const x = XLSX.utils.sheet_to_json(XLSX.read((await admin.get(`/api/admin/candidates/${cand.id}/export.xlsx`, { raw: true })).buffer).Sheets.Candidates)[0];
  assert.deepEqual([x['IQ Correct Answers'], x['IQ Weighted Score'], x['IQ Max Marks'], x['IQ %'], x['LALCO IQ Score'], x['IQ Classification'], x['Level 1 Max Marks'], x['Level 5 Max Marks']],
    ['10 / 18', 27, 55, 49.1, 74, 'Borderline', 4, 20]);
  const word = (await mammoth.extractRawText({ buffer: (await admin.get(`/api/admin/candidates/${cand.id}/export.docx`, { raw: true })).buffer })).value.replace(/\s+/g, ' ');
  const { PDFParse } = require('pdf-parse');
  const pp = new PDFParse({ data: new Uint8Array((await admin.get(`/api/admin/candidates/${cand.id}/export.pdf`, { raw: true })).buffer) });
  const pdf = (await pp.getText()).text.replace(/\s+/g, ' ');
  await pp.destroy();
  for (const text of [word, pdf]) {
    for (const want of ['10 / 18', '27 / 55', '74 / 150', 'Borderline', '49.1%']) assert.ok(text.includes(want), want);
    for (const bad of ['/ 30', '/ 90']) assert.ok(!text.includes(bad), 'no 30-question numbers: ' + bad);
  }
});

test('30 questions: 6/6/6/6/6, max 90; 27 marks -> 27 / 90 = 30%, LALCO 45 Extremely low', async () => {
  const link = await newLink(30);
  const c = client();
  const s = (await c.post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name: 'Thirty' })).data;
  assert.equal(s.questions.length, 30);
  const aid = attempt(link, 'Thirty');
  const rows = saved(aid);
  assert.deepEqual(splitOf(rows), [6, 6, 6, 6, 6]);
  // 27 marks: all 6 Level 1 (6) + 3 Level 2 (6) + 5 Level 3 (15) = 27.
  const right = { Easy: 6, Basic: 3, Moderate: 5, Difficult: 0, 'Very Difficult': 0 };
  const answers = {};
  for (const l of LEVELS) rows.filter((q) => q.difficulty === l).forEach((q, i) => { answers[q.id] = i < right[l] ? 'A' : 'B'; });
  const done = (await c.post(`/api/exam/${link.token}/submit`, { answers })).data;
  assert.deepEqual([done.last_result.points, done.last_result.max, done.last_result.lalco_iq_score, done.last_result.level], [27, 90, 45, 'Extremely low']);
  const r = (await admin.get('/api/admin/results/iq')).data.find((x) => x.id === aid);
  assert.deepEqual([r.iq_correct_text, r.iq_text, r.iq_score], ['14 / 30', '27 / 90', 30]);
});

test('10, 15, 20 and 50 questions from a 100-question bank: saved = configured, max = sum of their marks', async () => {
  for (const n of [10, 15, 20, 50]) {
    const link = await newLink(n);
    const c = client();
    const s = (await c.post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name: 'Count ' + n })).data;
    assert.equal(s.questions.length, n, `n=${n}`);
    const rows = saved(attempt(link, 'Count ' + n));
    assert.equal(rows.length, n);
    assert.equal(splitOf(rows).reduce((a, b) => a + b, 0), n);
    const done = (await c.post(`/api/exam/${link.token}/submit`, { answers: Object.fromEntries(rows.map((q) => [q.id, 'A'])) })).data;
    assert.deepEqual([done.last_result.points, done.last_result.max, done.last_result.lalco_iq_score], [rows.reduce((m, q) => m + q.max_marks, 0), rows.reduce((m, q) => m + q.max_marks, 0), 150]);
    if (n <= 30) assert.equal(done.last_result.max, maxFor(n));
    else assert.equal(done.last_result.max, 150, '50 = 10 per level = 150 marks');
  }
});

test('one shared link (18), candidates A / B / C: 18 each, own random set, own maximum; English and Lao the same', async () => {
  for (const language of ['en', 'lo']) {
    const link = await newLink(18, { language });
    const sets = [];
    for (const name of ['A', 'B', 'C']) {
      const c = client();
      const s = (await c.post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name: `${language} ${name}` })).data;
      assert.equal(s.questions.length, 18, `${language} ${name}`);
      const rows = saved(attempt(link, `${language} ${name}`));
      assert.deepEqual(splitOf(rows), [4, 3, 3, 4, 4]);
      if (language === 'lo') assert.ok(rows.every((q) => q.display_language === 'lo'));
      sets.push(rows.map((q) => q.question_id).join(','));
      const done = (await c.post(`/api/exam/${link.token}/submit`, { answers: Object.fromEntries(rows.map((q) => [q.id, 'A'])) })).data;
      assert.deepEqual([done.last_result.points, done.last_result.max, done.last_result.lalco_iq_score], [55, 55, 150]);
    }
    assert.ok(new Set(sets).size > 1, 'independent random sets');
  }
});

test('the bank shrinks after the link was made: the candidate is not given fewer questions (nothing saved)', async () => {
  const link = await newLink(18);
  // HR deactivates most of the bank: only 10 IQ questions stay active.
  const keep = db.prepare("SELECT id FROM questions WHERE section = 'IQ' AND status = 'Active' ORDER BY id LIMIT 10").all().map((q) => q.id);
  db.prepare(`UPDATE questions SET status = 'Inactive' WHERE section = 'IQ' AND id NOT IN (${keep.join(',')})`).run();
  try {
    const r = await client().post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name: 'Short Bank' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'not_enough_questions');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE name = 'Short Bank'").get().n, 0, 'nothing saved');
    // HR is told at creation, too.
    const refused = await admin.post('/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 18 }, link_expiry_minutes: 60 });
    assert.equal(refused.status, 400);
  } finally {
    db.prepare("UPDATE questions SET status = 'Active' WHERE section = 'IQ'").run();
  }
  const ok = await client().post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name: 'Bank Back' });
  assert.equal(ok.data.questions.length, 18);
});

test('an attempt whose saved questions do not match its count is flagged for HR, never silently scored as right', async () => {
  const link = await newLink(18);
  const c = client();
  const s = (await c.post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name: 'Mismatch' })).data;
  await c.post(`/api/exam/${link.token}/submit`, { answers: Object.fromEntries(s.questions.map((q) => [q.id, 'A'])) });
  const aid = attempt(link, 'Mismatch');
  const before = saved(aid);
  // Simulate an old attempt recorded as 30 while 18 questions were saved.
  db.prepare("UPDATE assessment_stages SET question_count = 30 WHERE assessment_id = ? AND section = 'IQ'").run(aid);
  const t = (await admin.get('/api/admin/assessments/' + aid)).data.tests[0];
  assert.equal(t.review_required, 'Attempt question count mismatch — review required.');
  assert.deepEqual([t.questions_assigned, t.question_count, t.score_text], [18, 30, '55 / 55'], 'the score is from the saved questions');
  assert.deepEqual(saved(aid), before, 'saved questions and answers untouched');
  const lr = (await c.get(`/api/exam/${link.token}`)).data.last_result;
  assert.equal('review_required' in lr, false, 'HR-only flag not sent to the candidate');
});
