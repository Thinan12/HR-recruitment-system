// The standard report: exactly 15 fields on the web page, in Excel (one row
// per candidate, AutoFilter, bold PASS / NOT PASS, duplicate phones marked),
// PDF and Word. Scores are read from the existing results, never recalculated.
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const { start, stop, client, db, CANDIDATE, seedQuestions } = require('./helpers');

const FIELDS = ['Candidate Name', 'Phone Number', 'Graduate From', 'High School', 'College', 'University', 'School Name', 'Subject', 'GPA / Mark',
  'Date and Time', 'IQ Test Score', 'Behavioral Interview Test Score', 'Calculation Score', 'Essay Score', 'Pass / Not Pass Status'];

let admin;
let BEH;
const ids = {};
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 10, 1, 'Easy');
  seedQuestions('GENERAL', 10);
  seedQuestions('CALCULATION', 10);
  db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES ('ESSAY', 'Why LALCO?', 10, ?)").run(new Date().toISOString());
  // HR has renamed General (as in production). Its result is NOT the behavioural
  // column: that column is the Behavioral Interview Test (an interview-format type).
  const g = (await admin.get('/api/admin/test-types')).data.find((t) => t.key === 'GENERAL');
  await admin.put('/api/admin/test-types/GENERAL', { ...g, name: 'Behavioral Assessment' });
  BEH = (await admin.post('/api/admin/test-types', { name: 'Behavioral Interview Test', behavior: 'interview' })).data.key;
  for (const q of ['Tell me about a time you solved a problem.', 'Describe a team you worked in.']) {
    db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES (?, ?, 10, ?)").run(BEH, q, new Date().toISOString());
  }

  const link = async (pass = {}) => (await admin.post('/api/admin/assessments', { tests: ['IQ', 'GENERAL', BEH, 'CALCULATION', 'ESSAY'], counts: { IQ: 5, GENERAL: 5, [BEH]: 2, CALCULATION: 4, ESSAY: 1 },
    link_expiry_minutes: 60, pass_marks: { IQ: 0, GENERAL: 0, [BEH]: 0, CALCULATION: 0, ESSAY: 0, ...pass }, eligibility_mark: 0 })).data;
  const right = (q) => db.prepare('SELECT correct_answer FROM assessment_questions WHERE id = ?').get(q.id).correct_answer;
  const take = async (l, info, answer) => {
    const c = client();
    let s = (await c.post(`/api/exam/${l.token}/start`, { ...CANDIDATE, ...info })).data;
    while (s.state === 'in_progress') {
      s = (await c.post(`/api/exam/${l.token}/submit`, { answers: Object.fromEntries(s.questions.map((q) => [q.id, answer(q, s)])) })).data;
      if (s.state === 'next_test') s = (await c.post(`/api/exam/${l.token}/continue`)).data;
    }
    return db.prepare('SELECT a.id, a.candidate_id FROM assessments a JOIN candidates c ON c.id = a.candidate_id WHERE c.name = ?').get(info.name);
  };
  const all = await link();
  const allRight = (q) => (q.kind === 'essay' ? 'Because LALCO grows.' : right(q));
  // A: everything right; HR marks the essay 8 / 10 and the interview answers 10 + 5 of 20 -> PASS.
  ids.A = await take(all, { name: 'Anna Pass', phone: '020 5555 1234', subject: 'Accounting', gpa: '3.4' }, allRight);
  const essay = db.prepare("SELECT id FROM assessment_questions WHERE assessment_id = ? AND section = 'ESSAY'").get(ids.A.id);
  const beh = db.prepare('SELECT id FROM assessment_questions WHERE assessment_id = ? AND section = ? ORDER BY position').all(ids.A.id, BEH);
  await admin.put(`/api/admin/assessments/${ids.A.id}/essay-marks`, { marks: { [essay.id]: 8, [beh[0].id]: 10, [beh[1].id]: 5 } });
  // B: finished, essay not marked yet -> Pending (never 0).
  ids.B = await take(all, { name: 'Ben Pending', phone: '020 7777 0000' }, allRight);
  // C: the General test (renamed "Behavioral Assessment") below its pass mark -> NOT PASS; the later tests stay locked.
  ids.C = await take(await link({ GENERAL: 100 }), { name: 'Cara Fail', phone: '020 8888 0000' }, (q, s) => (s.questions[0] && q.kind !== 'essay' && db.prepare('SELECT section FROM assessment_questions WHERE id = ?').get(q.id).section === 'GENERAL' ? 'Z' : right(q)));
  // D: same phone as A, written another way -> both marked as duplicates.
  ids.D = await take(all, { name: 'Dan Same Phone', phone: '+856 20 5555 1234' }, allRight);
  // E: added by HR, no assessment.
  ids.E = { candidate_id: (await admin.post('/api/admin/candidates', { name: 'Eve No Test', phone: '020 9999 0000' })).data.id };
});
test.after(stop);

const readXlsx = async (buf) => { const b = new ExcelJS.Workbook(); await b.xlsx.load(buf); return b.getWorksheet('Candidates'); };
const rowOf = (sheet, name) => { let r = null; sheet.eachRow((x) => { if (x.getCell(1).value === name) r = x; }); return r; };
const pdfText = async (buf) => { const p = new PDFParse({ data: new Uint8Array(buf) }); const t = (await p.getText()).text.replace(/\s+/g, ' '); await p.destroy(); return t; };

test('web report: the 15 fields, one row per candidate, scores as already calculated, missing essay never 0', async () => {
  const r = (await admin.get('/api/admin/report/standard')).data;
  assert.deepEqual(r.fields, FIELDS);
  const by = Object.fromEntries(r.rows.map((x) => [x.values[0], x]));
  assert.equal(r.rows.length, 5);
  const a = by['Anna Pass'].values;
  assert.deepEqual(a.slice(0, 9), ['Anna Pass', '020 5555 1234', 'University', 'Vientiane High School', '—', 'National University of Laos', 'NUOL', 'Accounting', '3.4']);
  assert.match(a[9], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'Date and Time');
  // The behavioural column is the Behavioral Interview Test (15 / 20), never General (100%).
  assert.deepEqual(a.slice(10), ['150 / 150', '75.0%', '100.0%', '8 / 10', 'PASS']);
  assert.deepEqual(by['Ben Pending'].values.slice(10), ['150 / 150', 'Pending HR marking', '100.0%', 'Pending HR marking', 'PENDING']);
  // Cara failed General: the Behavioral Interview Test was never reached, and General's 0% is not shown as it.
  assert.deepEqual(by['Cara Fail'].values.slice(10), ['150 / 150', 'Locked', 'Locked', 'Locked', 'NOT PASS']);
  assert.deepEqual(by['Eve No Test'].values.slice(9), ['—', '—', '—', '—', '—', '—']);
  assert.deepEqual(r.rows.filter((x) => x.duplicate_phone).map((x) => x.values[0]).sort(), ['Anna Pass', 'Dan Same Phone']);
  // Existing Essay scoring unchanged: the stage holds HR's 8 of 10.
  const st = db.prepare("SELECT points, max, result FROM assessment_stages WHERE assessment_id = ? AND section = 'ESSAY'").get(ids.A.id);
  assert.deepEqual([st.points, st.max, st.result], [8, 10, 'Pass']);
});

test('Excel: exactly 15 columns, AutoFilter on the header row, bold PASS / NOT PASS, duplicate phones highlighted, % columns numeric', async () => {
  const buf = (await admin.get('/api/admin/export/candidates.xlsx', { raw: true })).buffer;
  const sheet = await readXlsx(buf);
  assert.deepEqual(sheet.getRow(1).values.slice(1), FIELDS);
  assert.equal(sheet.actualColumnCount, 15);
  assert.equal(sheet.rowCount, 6, 'one row per candidate');
  assert.ok(sheet.autoFilter, 'AutoFilter set');
  // Excel reads the filter range from the file itself.
  const raw = XLSX.read(buf);
  assert.equal(raw.Sheets.Candidates['!autofilter'].ref, 'A1:O6');
  const a = rowOf(sheet, 'Anna Pass');
  assert.equal(a.getCell(15).value, 'PASS');
  assert.equal(a.getCell(15).font.bold, true);
  const c = rowOf(sheet, 'Cara Fail');
  assert.deepEqual([c.getCell(15).value, c.getCell(15).font.bold], ['NOT PASS', true]);
  assert.equal(a.getCell(14).value, '8 / 10');
  assert.equal(rowOf(sheet, 'Ben Pending').getCell(14).value, 'Pending HR marking');
  assert.deepEqual([a.getCell(12).value, a.getCell(12).numFmt], [0.75, '0.0%'], 'Behavioral Interview Test % as a number (filterable)');
  assert.equal(a.getCell(11).value, '150 / 150');
  for (const name of ['Anna Pass', 'Dan Same Phone']) {
    const p = rowOf(sheet, name).getCell(2);
    assert.equal(p.fill && p.fill.fgColor.argb, 'FFFFE699', name + ' phone highlighted');
    assert.match(String(p.note && (p.note.texts ? p.note.texts.map((t) => t.text).join('') : p.note)), /Duplicate phone number: used by 2 candidates/);
  }
  assert.equal(rowOf(sheet, 'Ben Pending').getCell(2).fill, undefined, 'unique phone not highlighted');
  // One candidate's Excel: the same 15 columns.
  const one = await readXlsx((await admin.get(`/api/admin/candidates/${ids.A.candidate_id}/export.xlsx`, { raw: true })).buffer);
  assert.deepEqual([one.actualColumnCount, one.rowCount], [15, 2]);
});

test('PDF and Word: the same 15 fields, Essay Score, PASS / NOT PASS in bold', async () => {
  const pdfBuf = (await admin.get(`/api/admin/candidates/${ids.A.candidate_id}/export.pdf`, { raw: true })).buffer;
  const pdf = await pdfText(pdfBuf);
  for (const f of FIELDS) assert.ok(pdf.includes(f), 'PDF ' + f);
  for (const v of ['Anna Pass', '020 5555 1234', '150 / 150', '75.0%', '100.0%', '8 / 10', 'PASS']) assert.ok(pdf.includes(v), 'PDF ' + v);
  assert.ok(pdfBuf.toString('latin1').includes('/BaseFont /Helvetica-Bold'), 'PDF status in a bold font');
  for (const bad of ['LALCO IQ Score', 'Level 1', 'Company Eligibility', 'Behavioral Assessment Score']) assert.ok(!pdf.includes(bad), 'no detailed field: ' + bad);

  const docBuf = (await admin.get(`/api/admin/candidates/${ids.A.candidate_id}/export.docx`, { raw: true })).buffer;
  const text = (await mammoth.extractRawText({ buffer: docBuf })).value;
  for (const f of FIELDS) assert.ok(text.includes(f), 'Word ' + f);
  assert.ok(text.includes('8 / 10'));
  assert.match((await mammoth.convertToHtml({ buffer: docBuf })).value, /<strong>PASS<\/strong>/, 'Word status bold');
  const failDoc = (await admin.get(`/api/admin/candidates/${ids.C.candidate_id}/export.docx`, { raw: true })).buffer;
  assert.match((await mammoth.convertToHtml({ buffer: failDoc })).value, /<strong>NOT PASS<\/strong>/);
  const pending = await pdfText((await admin.get(`/api/admin/candidates/${ids.B.candidate_id}/export.pdf`, { raw: true })).buffer);
  assert.ok(pending.includes('Pending HR marking') && pending.includes('PENDING'));
});

test('the detailed exports and the candidate profile keep everything', async () => {
  const detailed = XLSX.utils.sheet_to_json(XLSX.read((await admin.get('/api/admin/export/candidates.xlsx?detail=full', { raw: true })).buffer).Sheets.Candidates);
  const a = detailed.find((x) => x['Candidate Name'] === 'Anna Pass');
  assert.ok(Object.keys(a).length > 40, 'detailed columns kept');
  assert.equal(a['LALCO IQ Score'], 150);
  const word = (await mammoth.extractRawText({ buffer: (await admin.get(`/api/admin/candidates/${ids.A.candidate_id}/export.docx?detail=full`, { raw: true })).buffer })).value;
  for (const want of ['LALCO IQ Score', 'Company Eligibility', 'Interview']) assert.ok(word.includes(want), want);
  const profile = (await admin.get('/api/admin/candidates/' + ids.A.candidate_id)).data;
  assert.equal(profile.candidate.lalco_iq_score, 150);
  assert.ok(profile.candidate.tests.find((t) => t.section === 'ESSAY').score_text === '8 / 10');
  assert.equal((await client().get('/api/admin/report/standard')).status, 401, 'admin only');
});
