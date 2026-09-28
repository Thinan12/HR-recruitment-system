// LALCO IQ Score: weighted IQ marks / maximum x 150 (0-150), and its category.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { start, stop, client, db, CANDIDATE } = require('./helpers');
const { lalcoIqScore, iqCategory } = require('../src/reports');

let admin;
const candidate = client();
const LEVELS = ['Easy', 'Basic', 'Moderate', 'Difficult', 'Very Difficult'];
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  for (const level of LEVELS) for (let i = 1; i <= 6; i++) {
    await admin.post('/api/admin/questions', { section: 'IQ', difficulty: level, question_text: `Q ${level} ${i}`, option_a: '1', option_b: '2', correct_answer: 'A' });
  }
});
test.after(stop);

test('formula: marks / maximum x 150, rounded (examples on a 36-mark test)', () => {
  const expected = { 0: 0, 9: 38, 12: 50, 18: 75, 21: 88, 24: 100, 27: 113, 30: 125, 33: 138, 36: 150 };
  for (const [raw, score] of Object.entries(expected)) assert.equal(lalcoIqScore(Number(raw), 36), score, `${raw}/36`);
});

test('the scale is the same for any test length (maximum 21, 40, 60)', () => {
  assert.equal(lalcoIqScore(0, 21), 0);
  assert.equal(lalcoIqScore(10.5, 21), 75);
  assert.equal(lalcoIqScore(21, 21), 150);
  assert.equal(lalcoIqScore(20, 40), 75);
  assert.equal(lalcoIqScore(30, 60), 75);
  // The prompt's cases: 18 questions (max 55) and 30 questions (max 90), 27 marks each.
  assert.equal(lalcoIqScore(27, 55), 74);
  assert.equal(iqCategory(lalcoIqScore(27, 55)), 'Borderline');
  assert.equal(lalcoIqScore(27, 90), 45);
  assert.equal(iqCategory(lalcoIqScore(27, 90)), 'Extremely low');
  assert.equal(lalcoIqScore(60, 60), 150);
});

test('never below 0 or above 150; no score without a maximum', () => {
  assert.equal(lalcoIqScore(-3, 36), 0);
  assert.equal(lalcoIqScore(40, 36), 150);
  assert.equal(lalcoIqScore(5, 0), null);
  assert.equal(lalcoIqScore(null, 36), null);
  assert.equal(lalcoIqScore(5, null), null);
  for (let raw = 0; raw <= 36; raw++) {
    const s = lalcoIqScore(raw, 36);
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 150);
  }
});

test('categories and their boundaries', () => {
  const expected = { 0: 'Extremely low', 50: 'Extremely low', 69: 'Extremely low', 70: 'Borderline', 79: 'Borderline', 80: 'Low average', 89: 'Low average', 90: 'Average',
    109: 'Average', 110: 'High average', 119: 'High average', 120: 'Superior', 129: 'Superior', 130: 'Very superior', 150: 'Very superior' };
  for (const [score, cat] of Object.entries(expected)) assert.equal(iqCategory(Number(score)), cat, String(score));
  assert.equal(iqCategory(null), null);
  const examples = [[0, 'Extremely low'], [18, 'Borderline'], [21, 'Low average'], [24, 'Average'], [27, 'High average'], [30, 'Superior'], [36, 'Very superior']];
  for (const [raw, cat] of examples) assert.equal(iqCategory(lalcoIqScore(raw, 36)), cat, `${raw}/36`);
});

test('a finished test shows weighted score, %, LALCO IQ Score and category everywhere', async () => {
  const link = await admin.post('/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 20 }, minutes: { IQ: 20 }, link_expiry_minutes: 60 });
  await candidate.post(`/api/exam/${link.data.token}/start`, { ...CANDIDATE, name: 'Score Display' });
  // Right: all Level 1-3 questions (4 + 8 + 12 = 24 marks of 60) -> 40% -> 60 Extremely low.
  const rows = db.prepare('SELECT id, difficulty FROM assessment_questions WHERE assessment_id = ?').all(link.data.id);
  const answers = Object.fromEntries(rows.map((q) => [q.id, ['Easy', 'Basic', 'Moderate'].includes(q.difficulty) ? 'A' : 'B']));
  await candidate.post(`/api/exam/${link.data.token}/submit`, { answers });

  const r = (await admin.get('/api/admin/results/iq')).data.find((x) => x.id === link.data.id);
  assert.deepEqual([r.iq_text, r.iq_score, r.lalco_iq_score, r.iq_category], ['24 / 60', 40, 60, 'Extremely low']);
  const review = (await admin.get('/api/admin/assessments/' + link.data.id)).data.iq;
  assert.equal(review.lalco_iq_score, 60);
  const c = (await admin.get('/api/admin/candidates')).data.find((x) => x.name === 'Score Display');
  assert.deepEqual([c.lalco_iq_score, c.iq_category], [60, 'Extremely low']);
  const dash = (await admin.get('/api/admin/dashboard')).data;
  assert.equal(dash.highest_iq.lalco_iq_score, 60);
  assert.equal(dash.highest_iq.iq_category, 'Extremely low');

  const x = XLSX.utils.sheet_to_json(XLSX.read((await admin.get('/api/admin/export/candidates.xlsx', { raw: true })).buffer).Sheets.Candidates)
    .find((row) => row['Candidate Name'] === 'Score Display');
  assert.equal(x['IQ Weighted Score'], 24);
  assert.equal(x['IQ Max Marks'], 60);
  assert.equal(x['IQ %'], 40);
  assert.equal(x['LALCO IQ Score'], 60);
  assert.equal(x['IQ Category'], 'Extremely low');
  assert.equal(x['Level 1 Max Marks'], 4);
  assert.equal(x['Level 5 Max Marks'], 20);
  assert.ok(x['IQ Test Score'] && x['Assessment Result'] && x['Final Result'], 'existing columns kept');

  const word = (await mammoth.extractRawText({ buffer: (await admin.get(`/api/admin/candidates/${c.id}/export.docx`, { raw: true })).buffer })).value;
  for (const want of ['IQ Weighted Score', '24 / 60 marks (40%)', 'LALCO IQ Score', '60 / 150', 'IQ Classification', 'Extremely low (0–69)', '0–150 scale']) assert.ok(word.includes(want), want);
});

test('earlier tests show a LALCO IQ Score from their stored marks, without changing them', async () => {
  // A 3-level test from before: 27 / 36 -> 113 High average.
  const cid = db.prepare("INSERT INTO candidates (name, created_at, updated_at) VALUES ('Old 27 of 36', ?, ?)").run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').lastInsertRowid;
  const aid = db.prepare(`INSERT INTO assessments (token, candidate_id, assessment_type, sections, time_limit_minutes, link_expiry_minutes, link_expires_at, status, started_at, deadline_at, submitted_at, created_at, iq_points, iq_max, iq_correct, iq_total, test_score, result)
    VALUES ('old-27', ?, 'IQ', '{"IQ":18}', 30, 60, '2026-01-02T00:00:00.000Z', 'SUBMITTED', '2026-01-01T09:00:00.000Z', '2026-01-01T09:30:00.000Z', '2026-01-01T09:20:00.000Z', '2026-01-01T08:00:00.000Z', 27, 36, 14, 18, 75, 'Pass')`).run(cid).lastInsertRowid;
  const before = db.prepare('SELECT * FROM assessments WHERE id = ?').get(aid);
  const r = (await admin.get('/api/admin/results/iq')).data.find((x) => x.id === aid);
  assert.deepEqual([r.iq_text, r.iq_score, r.lalco_iq_score, r.iq_category], ['27 / 36', 75, 113, 'High average']);
  assert.deepEqual(db.prepare('SELECT * FROM assessments WHERE id = ?').get(aid), before, 'stored result unchanged');
  // No maximum stored -> not available rather than invented.
  db.prepare("INSERT INTO assessments (token, candidate_id, assessment_type, sections, time_limit_minutes, link_expiry_minutes, link_expires_at, status, submitted_at, created_at, iq_points, iq_max) VALUES ('old-none', ?, 'IQ', '{\"IQ\":1}', 30, 60, '2026-01-02T00:00:00.000Z', 'SUBMITTED', '2026-01-01T10:00:00.000Z', '2026-01-01T08:00:00.000Z', 0, 0)").run(cid);
  const none = (await admin.get('/api/admin/results/iq')).data.find((x) => x.iq_max === 0);
  assert.equal(none.lalco_iq_score, null);
  assert.equal(none.iq_category, null);
});
