// Export the question bank of one test (or all tests) as Excel; the file uses
// the import template's columns, so it can be uploaded again.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { start, stop, client, upload, seedQuestions, db } = require('./helpers');

let admin;
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 3, 1, 'Easy');
  seedQuestions('GENERAL', 4);
  db.prepare("UPDATE questions SET status = 'Inactive' WHERE section = 'GENERAL' AND question_text = 'GENERAL question 4'").run();
  db.prepare("UPDATE questions SET question_text_lo = 'ຄຳຖາມ 1', option_a_lo = 'ກ', category = 'Office' WHERE section = 'GENERAL' AND question_text = 'GENERAL question 1'").run();
  db.prepare("INSERT INTO questions (section, question_text, correct_answer, marks, created_at) VALUES ('ESSAY', 'Why LALCO?', 'Mentions growth and teamwork.', 10, ?)").run(new Date().toISOString());
});
test.after(stop);

const read = (buf) => XLSX.read(buf);
const rowsOf = (book, sheet) => XLSX.utils.sheet_to_json(book.Sheets[sheet], { defval: '' });
const exportFile = (q) => admin.get('/api/admin/questions/export.xlsx?' + q, { raw: true });

test('one test: every question of that test only, with answers, status and Lao', async () => {
  const r = await exportFile('section=GENERAL');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  assert.match(r.headers.get('content-disposition'), /LALCO_Questions_General_\d{4}-\d{2}-\d{2}\.xlsx/);
  const book = read(r.buffer);
  assert.deepEqual(book.SheetNames, ['General']);
  const rows = rowsOf(book, 'General');
  assert.equal(rows.length, 4, 'active and inactive');
  assert.deepEqual(Object.keys(rows[0]).slice(0, 11), ['Question', 'Type', 'Category', 'Difficulty', 'Option A', 'Option B', 'Option C', 'Option D', 'Option E', 'Correct Answer', 'Marks']);
  const q1 = rows.find((x) => x.Question === 'GENERAL question 1');
  assert.deepEqual([q1.Type, q1.Category, q1['Option A'], q1['Correct Answer'], q1.Status, q1['Question (Lao)'], q1['Option A (Lao)']], ['General', 'Office', 'opt A', 'A', 'Active', 'ຄຳຖາມ 1', 'ກ']);
  assert.equal(rows.find((x) => x.Question === 'GENERAL question 4').Status, 'Inactive');
  assert.ok(rows.every((x) => x.Type === 'General'), 'no other test in the file');
});

test('status filter, essay guidance, and all tests (one sheet per test)', async () => {
  assert.equal(rowsOf(read((await exportFile('section=GENERAL&status=Active')).buffer), 'General').length, 3);
  assert.equal(rowsOf(read((await exportFile('section=general&status=Inactive')).buffer), 'General').length, 1, 'key in any case');
  const essay = rowsOf(read((await exportFile('section=ESSAY')).buffer), 'Essay');
  assert.deepEqual([essay[0].Question, essay[0]['Correct Answer'], essay[0].Marks], ['Why LALCO?', 'Mentions growth and teamwork.', 10]);
  const all = read((await exportFile('section=all')).buffer);
  assert.deepEqual(all.SheetNames, ['IQ', 'General', 'Calculation', 'Essay']);
  assert.equal(rowsOf(all, 'IQ').length, 3);
  assert.equal(XLSX.utils.sheet_to_json(all.Sheets.Calculation, { header: 1 }).length, 1, 'an empty test: header row only');
});

test('refused without a test type or a login; the export is recorded', async () => {
  assert.equal((await exportFile('section=NOPE')).status, 400);
  assert.equal((await exportFile('')).status, 400);
  assert.equal((await client().get('/api/admin/questions/export.xlsx?section=IQ', { raw: true })).status, 401);
  const log = db.prepare("SELECT * FROM audit_log WHERE action = 'QUESTIONS_EXPORTED' ORDER BY id DESC").get();
  assert.equal(log.admin, 'admin');
  assert.ok(log.details.includes('test_type'));
});

test('round trip: the exported file can be uploaded again (same questions, answers and categories)', async () => {
  const buf = (await exportFile('section=GENERAL')).buffer;
  const again = (await admin.post('/api/admin/questions/import/preview', undefined, { form: upload(buf, 'export.xlsx', 'GENERAL') })).data;
  assert.equal(again.found, 4);
  assert.equal(again.duplicates, 4, 'recognised as the questions already in the bank');
  // Into an empty bank: the questions come back as they were.
  const before = db.prepare("SELECT question_text, option_a, option_b, correct_answer, category, question_text_lo FROM questions WHERE section = 'GENERAL' ORDER BY id").all();
  db.prepare("DELETE FROM questions WHERE section = 'GENERAL'").run();
  const p = (await admin.post('/api/admin/questions/import/preview', undefined, { form: upload(buf, 'export.xlsx', 'GENERAL') })).data;
  assert.equal(p.valid, 4);
  // HR confirms the new category, as on the upload page.
  const imp = await admin.post('/api/admin/questions/import', { questions: p.rows.map((r) => r.question), category_decisions: Object.fromEntries((p.category_decisions || []).map((d) => [d.key, { create: true }])) });
  assert.equal(imp.data.imported, 4, JSON.stringify(imp.data).slice(0, 400));
  const after = db.prepare("SELECT question_text, option_a, option_b, correct_answer, category, question_text_lo FROM questions WHERE section = 'GENERAL' ORDER BY id").all();
  assert.deepEqual(after, before);
});

test('a custom test type (e.g. Behavioral Interview Test) exports under its own name and is read back as that type', async () => {
  const key = (await admin.post('/api/admin/test-types', { name: 'Behavioral Interview Test', behavior: 'interview' })).data.key;
  db.prepare("INSERT INTO questions (section, question_text, correct_answer, marks, created_at) VALUES (?, 'Tell me about a time you solved a problem.', 'Clear situation, action and result.', 10, ?)").run(key, new Date().toISOString());
  const r = await exportFile('section=' + key);
  assert.match(r.headers.get('content-disposition'), /LALCO_Questions_Behavioral_Interview_Test_/);
  const book = read(r.buffer);
  assert.deepEqual(book.SheetNames, ['Behavioral Interview Test']);
  const rows = rowsOf(book, 'Behavioral Interview Test');
  assert.deepEqual([rows[0].Type, rows[0]['Correct Answer']], ['Behavioral Interview Test', 'Clear situation, action and result.']);
  const p = (await admin.post('/api/admin/questions/import/preview', undefined, { form: upload(r.buffer, 'export.xlsx', 'GENERAL') })).data;
  assert.equal(p.rows[0].question.section, key, 'the Type column puts it back in the same test, not the upload default');
  assert.equal(p.duplicates, 1);
});
