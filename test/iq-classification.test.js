// LALCO IQ SCORE CLASSIFICATION: the 50-150 score -> one description, from one table.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { start, stop, client, db, CANDIDATE, seedQuestions } = require('./helpers');
const { IQ_CLASSIFICATION, getIQClassification, iqCategory, lalcoIqScore, percentLevel } = require('../src/reports');

let admin;
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 20, 1, 'Easy');
  db.prepare("UPDATE questions SET question_text_lo = 'ຄຳຖາມ', option_a_lo = 'opt A', option_b_lo = 'opt B', option_c_lo = 'opt C', option_d_lo = 'opt D', lo_status = 'translated' WHERE section = 'IQ'").run();
});
test.after(stop);

test('the table is exactly the reference: ranges, descriptions, population percentages', () => {
  assert.deepEqual(IQ_CLASSIFICATION.map((c) => [c.range, c.description, c.populationReference]), [
    ['130–150', 'Very superior', '2.2%'], ['120–129', 'Superior', '6.7%'], ['110–119', 'High average', '16.1%'], ['90–109', 'Average', '50%'],
    ['80–89', 'Low average', '16.1%'], ['70–79', 'Borderline', '6.7%'], ['50–69', 'Extremely low', '2.2%']]);
});

test('every boundary and the scores next to it', () => {
  const cases = {
    50: 'Extremely low', 51: 'Extremely low', 68: 'Extremely low', 69: 'Extremely low',
    70: 'Borderline', 71: 'Borderline', 78: 'Borderline', 79: 'Borderline',
    80: 'Low average', 81: 'Low average', 88: 'Low average', 89: 'Low average',
    90: 'Average', 91: 'Average', 108: 'Average', 109: 'Average',
    110: 'High average', 111: 'High average', 118: 'High average', 119: 'High average',
    120: 'Superior', 121: 'Superior', 128: 'Superior', 129: 'Superior',
    130: 'Very superior', 131: 'Very superior', 149: 'Very superior', 150: 'Very superior',
  };
  for (const [score, want] of Object.entries(cases)) assert.equal(getIQClassification(Number(score)).description, want, score);
  assert.deepEqual(getIQClassification(125), { range: '120–129', description: 'Superior', description_lo: 'ສູງເດັ່ນ', populationReference: '6.7%' });
});

test('outside the LALCO scale there is no classification', () => {
  for (const bad of [49, 151, 0, -1, 200, 100.5, null, undefined, '', 'abc']) assert.equal(getIQClassification(bad), null, String(bad));
  assert.equal(iqCategory(null), null);
});

test('every score 50-150 is in exactly one row: no gaps, no overlaps', () => {
  for (let s = 50; s <= 150; s++) {
    const rows = IQ_CLASSIFICATION.filter((c) => s >= c.min && s <= c.max);
    assert.equal(rows.length, 1, `score ${s} is in ${rows.length} rows`);
    assert.equal(getIQClassification(s).description, rows[0].description);
  }
  const covered = IQ_CLASSIFICATION.reduce((n, c) => n + (c.max - c.min + 1), 0);
  assert.equal(covered, 101, 'the rows cover exactly 50..150');
});

test('the chain: raw weighted marks -> 50-150 score (formula unchanged) -> classification, never from the raw %', () => {
  assert.equal(lalcoIqScore(27, 36), 125);
  assert.equal(iqCategory(lalcoIqScore(27, 36)), 'Superior');
  assert.equal(percentLevel((27 / 36) * 100), 'High', 'the % level would say High; the IQ uses its LALCO score');
  const examples = [[55, 'Extremely low'], [73, 'Borderline'], [85, 'Low average'], [100, 'Average'], [115, 'High average'], [125, 'Superior'], [140, 'Very superior']];
  for (const [score, want] of examples) assert.equal(iqCategory(score), want, String(score));
  assert.equal(lalcoIqScore(0, 55), 50);
  assert.equal(lalcoIqScore(55, 55), 150);
  assert.equal(lalcoIqScore(1, 2), 100);
});

test('one IQ test: the same classification on results, review, candidate, dashboard, Excel, PDF and Word; Lao name for Lao candidates', async () => {
  const link = (await admin.post('/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 20 }, link_expiry_minutes: 60, language: 'lo', pass_marks: { IQ: 0 } })).data;
  const c = client();
  const s = (await c.post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name: 'Classified Person' })).data;
  // 15 of 20 right (all Level 1 = 1 mark each) -> 15 / 20 = 75% -> LALCO 125 -> Superior.
  const answers = Object.fromEntries(s.questions.map((q, i) => [q.id, i < 15 ? db.prepare('SELECT correct_answer FROM assessment_questions WHERE id = ?').get(q.id).correct_answer : 'Z']));
  const done = (await c.post(`/api/exam/${link.token}/submit`, { answers })).data;
  assert.deepEqual([done.last_result.points, done.last_result.max, done.last_result.lalco_iq_score, done.last_result.level, done.last_result.level_lo], [15, 20, 125, 'Superior', 'ສູງເດັ່ນ']);

  const aid = db.prepare('SELECT id FROM assessments WHERE link_id = ?').get(link.id).id;
  const results = (await admin.get('/api/admin/results/iq')).data.find((x) => x.id === aid);
  const review = (await admin.get('/api/admin/assessments/' + aid)).data;
  const cand = (await admin.get('/api/admin/candidates')).data.find((x) => x.name === 'Classified Person');
  const dash = (await admin.get('/api/admin/dashboard')).data;
  assert.deepEqual([results.lalco_iq_score, results.iq_category, results.iq_classification.range], [125, 'Superior', '120–129']);
  assert.deepEqual([review.iq.iq_category, review.tests[0].level], ['Superior', 'Superior']);
  assert.deepEqual([cand.iq_category, cand.tests[0].level, cand.iq_text, cand.iq_score], ['Superior', 'Superior', '15 / 20', 75]);
  assert.deepEqual(Object.keys(dash.summary.iq_levels), IQ_CLASSIFICATION.map((x) => x.description), 'dashboard counts use the 7 classifications');
  assert.ok(dash.summary.iq_levels.Superior >= 1);
  assert.equal(dash.iq_classification.length, 7);
  assert.ok(!Object.keys(dash.summary.iq_levels).some((k) => ['Exceptional', 'Very High', 'Very Low'].includes(k)), 'old IQ names gone');

  const x = XLSX.utils.sheet_to_json(XLSX.read((await admin.get(`/api/admin/candidates/${cand.id}/export.xlsx`, { raw: true })).buffer).Sheets.Candidates)[0];
  assert.deepEqual([x['IQ Weighted Score'], x['IQ Max Marks'], x['IQ %'], x['LALCO IQ Score'], x['IQ Classification'], x['IQ Classification Range'], x['IQ Category'], x['IQ Level']],
    [15, 20, 75, 125, 'Superior', '120–129', 'Superior', 'Superior']);
  const word = (await mammoth.extractRawText({ buffer: (await admin.get(`/api/admin/candidates/${cand.id}/export.docx`, { raw: true })).buffer })).value;
  const { PDFParse } = require('pdf-parse');
  const pp = new PDFParse({ data: new Uint8Array((await admin.get(`/api/admin/candidates/${cand.id}/export.pdf`, { raw: true })).buffer) });
  const pdf = (await pp.getText()).text.replace(/\s+/g, ' ');
  await pp.destroy();
  for (const text of [word.replace(/\s+/g, ' '), pdf]) {
    for (const want of ['IQ Weighted Score', '15 / 20', 'LALCO IQ Score', '125 / 150', 'IQ Classification', 'Superior (120–129)', 'IQ Percentage', '75.0%']) assert.ok(text.includes(want), want);
  }
  const table = (await admin.get('/api/admin/iq-classification')).data;
  assert.deepEqual(table, IQ_CLASSIFICATION);
  assert.equal((await client().get('/api/admin/iq-classification')).status, 401);
});
