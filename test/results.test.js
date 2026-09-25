const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');

async function pdfText(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}
const { start, stop, client, seedQuestions, db, CANDIDATE } = require('./helpers');

let admin;
const candidate = client();
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 10);
  seedQuestions('GENERAL', 10);
  seedQuestions('CALCULATION', 4);
  db.prepare(`INSERT INTO questions (section, question_text, marks, created_at) VALUES ('ESSAY', 'Describe yourself.', 10, ?)`).run(new Date().toISOString());
  db.prepare(`INSERT INTO questions (section, question_text, correct_answer, marks, created_at) VALUES ('CALCULATION', 'What is 1,000 + 250?', '1250', 2, ?)`).run(new Date().toISOString());
});
test.after(stop);

// Sits an assessment, answering `correctCount` questions of each section correctly.
async function sit(name, type, counts, correctFraction) {
  const link = await admin.post('/api/admin/assessments', { assessment_type: type, counts, time_limit_minutes: 30, link_expiry_minutes: 60 });
  assert.equal(link.status, 201, JSON.stringify(link.data));
  await candidate.post(`/api/exam/${link.data.token}/start`, { ...CANDIDATE, name });
  const rows = db.prepare('SELECT id, section, correct_answer, option_order FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(link.data.id);
  const answers = {};
  rows.forEach((q, i) => {
    if (q.section === 'ESSAY') { answers[q.id] = 'I am hard-working.'; return; }
    const right = i < Math.round(rows.filter((r) => r.section !== 'ESSAY').length * correctFraction);
    answers[q.id] = right ? q.correct_answer : (JSON.parse(q.option_order).length ? (q.correct_answer === 'A' ? 'B' : 'A') : '0');
  });
  await candidate.post(`/api/exam/${link.data.token}/submit`, { answers });
  return db.prepare('SELECT * FROM assessments WHERE id = ?').get(link.data.id);
}

let passer;
let failer;

test('scores are calculated: correct = full marks, wrong = 0', async () => {
  const a = await sit('High Scorer', 'IQ', { IQ: 10 }, 0.9);
  assert.equal(a.iq_points, 9);
  assert.equal(a.iq_max, 10);
  assert.equal(a.test_score, 90);
  assert.equal(a.result, 'Pass');
  passer = a.candidate_id;

  const b = await sit('Low Scorer', 'IQ', { IQ: 10 }, 0.3);
  assert.equal(b.test_score, 30);
  assert.equal(b.result, 'Not Pass');
  failer = b.candidate_id;
});

test('essay makes the result Pending until HR enters marks', async () => {
  const a = await sit('Essay Writer', 'COMBINED', { CALCULATION: 5, ESSAY: 1 }, 1);
  assert.equal(a.result, 'Pending');
  assert.equal(a.essay_pending, 1);
  const essay = db.prepare("SELECT id FROM assessment_questions WHERE assessment_id = ? AND section = 'ESSAY'").get(a.id);

  const tooHigh = await admin.put(`/api/admin/assessments/${a.id}/essay-marks`, { marks: { [essay.id]: 50 } });
  assert.equal(tooHigh.status, 400);

  const r = await admin.put(`/api/admin/assessments/${a.id}/essay-marks`, { marks: { [essay.id]: 5 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.essay_points, 5);
  assert.equal(r.data.essay_pending, 0);
  // calculation (all right) + essay 5/10
  const expectedMax = r.data.calc_max + 10;
  const expectedPoints = r.data.calc_max + 5;
  assert.equal(r.data.test_score, Math.round((expectedPoints / expectedMax) * 1000) / 10);
  assert.equal(r.data.result, r.data.test_score >= 60 ? 'Pass' : 'Not Pass');
});

test('short-answer calculation is compared ignoring spaces and commas', () => {
  const { scoreAssessment } = require('../src/assessments');
  // The essay test above drew all 5 calculation questions, so this one is present.
  const aq = db.prepare("SELECT * FROM assessment_questions WHERE question_text = 'What is 1,000 + 250?' LIMIT 1").get();
  assert.ok(aq);
  const marks = (answer) => {
    db.prepare('UPDATE assessment_questions SET answer = ? WHERE id = ?').run(answer, aq.id);
    scoreAssessment(aq.assessment_id);
    return db.prepare('SELECT marks_awarded FROM assessment_questions WHERE id = ?').get(aq.id).marks_awarded;
  };
  assert.equal(marks('999'), 0);
  assert.equal(marks('1 250'), 2);
  assert.equal(marks('1,250'), 2);
});

test('interview information and final result are stored', async () => {
  const detail = await admin.get('/api/admin/candidates/' + passer);
  const body = {
    ...detail.data.candidate, reference_results: 'Good references', character_note: 'Calm, polite',
    interview: 'Round 1 done', interviewer: 'Ms. Somchay', interview_score: 85, remark: 'Strong candidate',
    chairman_interview: 'Approved', final_result: 'Pass', date_come_to_work: '2026-10-01',
  };
  const r = await admin.put('/api/admin/candidates/' + passer, body);
  assert.equal(r.status, 200);
  assert.equal(r.data.interview_score, 85);
  assert.equal(r.data.final_result, 'Pass');
  assert.equal(r.data.overall_result, 'Pass');
  assert.equal(r.data.iq_score, 90);

  const bad = await admin.put('/api/admin/candidates/' + passer, { ...body, interview_score: 150 });
  assert.equal(bad.status, 400);
});

test('dashboard shows totals and the highest IQ test score', async () => {
  const d = (await admin.get('/api/admin/dashboard')).data;
  assert.equal(d.total_candidates, 3);
  assert.equal(d.highest_iq.name, 'High Scorer');
  assert.equal(d.highest_iq.iq_score, 90);
  assert.equal(d.completed_assessments, 3);
  assert.ok(d.passed >= 1);
  assert.ok(d.not_passed >= 1);
  assert.ok(d.average_test_score > 0);
});

test('changing the pass mark re-evaluates results', async () => {
  const before = (await admin.get('/api/admin/settings')).data;
  await admin.put('/api/admin/settings', { ...before, pass_mark: 25 });
  const low = db.prepare('SELECT result FROM assessments WHERE candidate_id = ?').get(failer);
  assert.equal(low.result, 'Pass');
  await admin.put('/api/admin/settings', { ...before, pass_mark: 60 });
  assert.equal(db.prepare('SELECT result FROM assessments WHERE candidate_id = ?').get(failer).result, 'Not Pass');
  assert.equal((await admin.put('/api/admin/settings', { ...before, pass_mark: 500 })).status, 400);
});

test('past results survive editing and deleting bank questions', async () => {
  const before = db.prepare('SELECT test_score FROM assessments WHERE candidate_id = ?').get(passer).test_score;
  db.prepare("DELETE FROM questions WHERE section = 'IQ'").run();
  require('../src/assessments').rescoreAll();
  assert.equal(db.prepare('SELECT test_score FROM assessments WHERE candidate_id = ?').get(passer).test_score, before);
  const detail = await admin.get('/api/admin/assessments/' + db.prepare('SELECT id FROM assessments WHERE candidate_id = ?').get(passer).id);
  assert.equal(detail.data.questions.length, 10);
});

test('candidate PDF export contains the report', async () => {
  const r = await admin.get(`/api/admin/candidates/${passer}/export.pdf`, { raw: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const text = await pdfText(r.buffer);
  for (const s of ['LALCO', 'HR Recruitment Assessment', 'High Scorer', 'IQ Test Score', 'Ms. Somchay', 'Final Result', '2026-10-01']) assert.ok(text.includes(s), s);
});

test('candidate Word export contains the report', async () => {
  const r = await admin.get(`/api/admin/candidates/${passer}/export.docx`, { raw: true });
  assert.equal(r.status, 200);
  const text = (await mammoth.extractRawText({ buffer: r.buffer })).value;
  for (const s of ['LALCO', 'High Scorer', 'Interviewer', 'Ms. Somchay', 'Strong candidate', 'Approved']) assert.ok(text.includes(s), s);
});

test('candidate Excel export and all-candidate Excel export', async () => {
  const one = await admin.get(`/api/admin/candidates/${passer}/export.xlsx`, { raw: true });
  assert.equal(one.status, 200);
  const oneRows = XLSX.utils.sheet_to_json(XLSX.read(one.buffer).Sheets.Candidates);
  assert.equal(oneRows.length, 1);
  assert.equal(oneRows[0]['Candidate Name'], 'High Scorer');

  const all = await admin.get('/api/admin/export/candidates.xlsx', { raw: true });
  assert.equal(all.status, 200);
  assert.match(all.headers.get('content-disposition'), /LALCO_All_Candidates/);
  const sheet = XLSX.read(all.buffer).Sheets.Candidates;
  const header = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0];
  for (const col of ['Candidate Name', 'Phone Number', 'Graduate From', 'High School', 'College', 'University', 'School Name', 'Subject',
    'GPA / Mark', 'Reference Results', 'IQ Test Score', 'Character', 'Test Score', 'Calculation Test', 'Essay Test', 'Interview',
    'Interviewer', 'Interview Score', 'Result', 'Remark', 'Chairman Interview', 'Final Result', 'Date Come to Work']) assert.ok(header.includes(col), col);
  const rows = XLSX.utils.sheet_to_json(sheet);
  assert.equal(rows.length, 3);
  const top = rows.find((r) => r['Candidate Name'] === 'High Scorer');
  assert.equal(top['IQ Test Score'], 90);
  assert.equal(top['Interviewer'], 'Ms. Somchay');
  assert.equal(top['Phone Number'], CANDIDATE.phone);
});

test('Lao text renders in exports', async () => {
  const c = await admin.post('/api/admin/candidates', { name: 'ສົມໃຈ ພົມມະວົງ', phone: '020' });
  const pdf = await admin.get(`/api/admin/candidates/${c.data.id}/export.pdf`, { raw: true });
  assert.equal(pdf.status, 200);
  assert.ok((await pdfText(pdf.buffer)).includes('ສົມໃຈ'), 'Lao name is embedded as real text');
  const word = await admin.get(`/api/admin/candidates/${c.data.id}/export.docx`, { raw: true });
  assert.ok((await mammoth.extractRawText({ buffer: word.buffer })).value.includes('ສົມໃຈ'));
});

test('deleting a candidate removes their assessments', async () => {
  const id = failer;
  assert.equal((await admin.del('/api/admin/candidates/' + id)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessments WHERE candidate_id = ?').get(id).n, 0);
  assert.equal((await admin.get('/api/admin/candidates/' + id)).status, 404);
});
