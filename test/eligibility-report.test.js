// The standard report's Pass / Not Pass Status is the Company Eligibility:
// every test passed AND the final score (average of the tests' percentages)
// reaches the eligibility mark saved on the candidate's own link. Web report,
// Excel, PDF and Word all show the same status as the candidate profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const { start, stop, client, seedQuestions, db, CANDIDATE } = require('./helpers');

let admin;
const people = {};
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  seedQuestions('GENERAL', 20);
  seedQuestions('CALCULATION', 20);
});
test.after(stop);

// One candidate on a GENERAL + CALCULATION link (20 questions each, pass mark 50%),
// answering `right` questions of each test correctly.
async function take(name, phone, right, mark) {
  const link = (await admin.post('/api/admin/assessments', { tests: ['GENERAL', 'CALCULATION'], counts: { GENERAL: 20, CALCULATION: 20 },
    link_expiry_minutes: 60, pass_marks: { GENERAL: 50, CALCULATION: 50 }, ...(mark == null ? {} : { eligibility_mark: mark }) })).data;
  const c = client();
  let s = (await c.post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name, phone })).data;
  while (s.state === 'in_progress') {
    const n = right[s.section];
    const answers = Object.fromEntries(s.questions.map((q, i) => {
      const correct = db.prepare('SELECT correct_answer FROM assessment_questions WHERE id = ?').get(q.id).correct_answer;
      return [q.id, i < n ? correct : correct === 'A' ? 'B' : 'A'];
    }));
    s = (await c.post(`/api/exam/${link.token}/submit`, { answers })).data;
    if (s.state === 'next_test') s = (await c.post(`/api/exam/${link.token}/continue`)).data;
  }
  const id = db.prepare('SELECT id FROM candidates WHERE name = ?').get(name).id;
  return { id, link };
}
const profile = async (id) => (await admin.get('/api/admin/candidates/' + id)).data.candidate;
const reportRow = async (name) => (await admin.get('/api/admin/report/standard')).data.rows.find((r) => r.values[0] === name);
const pdfText = async (buf) => { const p = new PDFParse({ data: new Uint8Array(buf) }); const t = (await p.getText()).text.replace(/\s+/g, ' '); await p.destroy(); return t; };

// Status in every output for one candidate: web report, all-candidates Excel, candidate Excel, PDF, Word.
async function statusEverywhere(name, id) {
  const web = (await reportRow(name)).values[14];
  const all = XLSX.utils.sheet_to_json(XLSX.read((await admin.get('/api/admin/export/candidates.xlsx', { raw: true })).buffer).Sheets.Candidates, { header: 1 });
  const one = XLSX.utils.sheet_to_json(XLSX.read((await admin.get(`/api/admin/candidates/${id}/export.xlsx`, { raw: true })).buffer).Sheets.Candidates, { header: 1 });
  const pdf = await pdfText((await admin.get(`/api/admin/candidates/${id}/export.pdf`, { raw: true })).buffer);
  const word = (await mammoth.extractRawText({ buffer: (await admin.get(`/api/admin/candidates/${id}/export.docx`, { raw: true })).buffer })).value;
  const inText = (t) => (/NOT PASS/.test(t) ? 'NOT PASS' : /\bPASS\b/.test(t) ? 'PASS' : /PENDING/.test(t) ? 'PENDING' : null);
  return { web, excelAll: all.find((r) => r[0] === name)[14], excel: one[1][14], pdf: inText(pdf), word: inText(word) };
}
const everywhere = (status) => ({ web: status, excelAll: status, excel: status, pdf: status, word: status });

test('A: all tests passed, final 75% >= 70% -> Eligible and PASS everywhere', async () => {
  people.A = await take('Elig A', '020 1111 0001', { GENERAL: 16, CALCULATION: 14 }, 70); // 80% + 70%
  const c = await profile(people.A.id);
  assert.deepEqual([c.final_percent, c.eligibility, c.eligibility_mark], [75, 'Eligible', 70]);
  assert.deepEqual(await statusEverywhere('Elig A', people.A.id), everywhere('PASS'));
});

test('B (the bug): all tests passed but final 65% < 70% -> Not Eligible and NOT PASS everywhere', async () => {
  people.B = await take('Elig B', '020 1111 0002', { GENERAL: 13, CALCULATION: 13 }, 70); // 65% + 65%
  const c = await profile(people.B.id);
  assert.ok(c.tests.every((t) => t.result === 'Pass'), 'every individual test is still a Pass');
  assert.deepEqual([c.final_percent, c.eligibility], [65, 'Not Eligible']);
  assert.equal(db.prepare('SELECT result FROM assessments WHERE candidate_id = ?').get(people.B.id).result, 'Pass', 'the stored test result is not changed');
  assert.deepEqual(await statusEverywhere('Elig B', people.B.id), everywhere('NOT PASS'));
});

test('C: a failed test -> NOT PASS, whatever the score', async () => {
  people.C = await take('Elig C', '020 1111 0003', { GENERAL: 20, CALCULATION: 9 }, 0); // 100% + 45% (< 50% pass mark); mark 0
  const c = await profile(people.C.id);
  assert.equal(c.eligibility, 'Not Eligible');
  assert.deepEqual(await statusEverywhere('Elig C', people.C.id), everywhere('NOT PASS'));
});

test('D: final exactly at the mark (70% = 70%) -> PASS', async () => {
  people.D = await take('Elig D', '020 1111 0004', { GENERAL: 14, CALCULATION: 14 }, 70);
  const c = await profile(people.D.id);
  assert.deepEqual([c.final_percent, c.eligibility], [70, 'Eligible']);
  assert.deepEqual(await statusEverywhere('Elig D', people.D.id), everywhere('PASS'));
});

test('each link keeps its own mark: the same 75% is NOT PASS on an 80% link', async () => {
  people.E = await take('Elig E', '020 1111 0005', { GENERAL: 16, CALCULATION: 14 }, 80);
  assert.equal((await profile(people.E.id)).eligibility, 'Not Eligible');
  assert.equal((await reportRow('Elig E')).values[14], 'NOT PASS');
  assert.equal((await reportRow('Elig A')).values[14], 'PASS', 'A (same scores, 70% link) is still PASS');
});

test('changing the Settings default later does not change a finished result', async () => {
  const before = (await admin.get('/api/admin/settings')).data;
  const statuses = async () => Promise.all(['Elig A', 'Elig B', 'Elig D', 'Elig E'].map(async (n) => (await reportRow(n)).values[14]));
  const was = await statuses();
  assert.equal((await admin.put('/api/admin/settings', { ...before, final_eligibility: 99 })).status, 200);
  assert.deepEqual(await statuses(), was, 'high default: unchanged');
  assert.equal((await admin.put('/api/admin/settings', { ...before, final_eligibility: 0 })).status, 200);
  assert.deepEqual(await statuses(), was, 'low default: unchanged');
  await admin.put('/api/admin/settings', before);
});

test('pending: an assessment in progress or not finished stays PENDING (never PASS / NOT PASS)', async () => {
  const link = (await admin.post('/api/admin/assessments', { tests: ['GENERAL', 'CALCULATION'], counts: { GENERAL: 2, CALCULATION: 2 }, link_expiry_minutes: 60, eligibility_mark: 70 })).data;
  await client().post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name: 'Elig Pending', phone: '020 1111 0006' });
  assert.equal((await reportRow('Elig Pending')).values[14], 'PENDING');
  const c = (await admin.get('/api/admin/candidates')).data.find((x) => x.name === 'Elig Pending');
  assert.equal(c.eligibility, 'Pending');
});

test('the dashboard and profile show the same eligibility the report uses', async () => {
  const s = (await admin.get('/api/admin/dashboard')).data.summary;
  const rows = (await admin.get('/api/admin/report/standard')).data.rows;
  const report = { PASS: 0, 'NOT PASS': 0 };
  for (const r of rows) if (r.values[14] in report) report[r.values[14]]++;
  assert.deepEqual([s.eligible, s.not_eligible], [report.PASS, report['NOT PASS']]);
});
