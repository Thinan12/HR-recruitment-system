const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const docx = require('docx');
const { start, stop, client, upload } = require('./helpers');

let admin;
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
});
test.after(stop);

const HEADER = ['Question', 'Type', 'Category', 'Difficulty', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer', 'Marks'];
const TABLE = [
  HEADER,
  ['2, 4, 8, 16, ?', 'IQ', 'Number pattern', 'Easy', '24', '32', '30', '20', 'B', 1],
  ['Odd one out?', 'IQ', 'Odd one out', 'Easy', 'Apple', 'Banana', 'Carrot', 'Mango', 'Carrot', 2],
  ['What is 15% of 300?', 'Calculation', '', '', '', '', '', '', '45', 1],
  ['Why LALCO?', 'Essay', '', '', '', '', '', '', '', 10],
  ['Broken row with no answer', 'General', '', '', 'x', 'y', '', '', '', 1],
];

const BLOCK_TEXT = `1. What number comes next: 3, 6, 9, ?
A. 10
B. 12
C. 15
D. 11
Answer: B

2. Which word does not belong?
A. Red   B. Blue   C. Green   D. Chair
Answer: D
Type: IQ
Marks: 2

3) Question without an answer
A. yes
B. no
`;

function workbook(rows, bookType) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(book, { type: 'buffer', bookType });
}

function pdfOf(text) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    for (const line of text.split('\n')) doc.text(line || ' ');
    doc.end();
  });
}

function docxTable(rows) {
  const { Document, Packer, Table, TableRow, TableCell, Paragraph } = docx;
  const table = new Table({ rows: rows.map((r) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph(String(c))] })) })) });
  return Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('LALCO questions'), table] }] }));
}

function docxText(text) {
  const { Document, Packer, Paragraph } = docx;
  return Packer.toBuffer(new Document({ sections: [{ children: text.split('\n').map((l) => new Paragraph(l)) }] }));
}

async function preview(buffer, name, section) {
  return admin.post('/api/admin/questions/import/preview', undefined, { form: upload(buffer, name, section) });
}

function checkTablePreview(r) {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.found, 5);
  assert.equal(r.data.valid, 4);
  assert.equal(r.data.invalid, 1);
  assert.deepEqual(r.data.by_section, { IQ: 2, GENERAL: 0, CALCULATION: 1, ESSAY: 1 });
  const [q1, q2, calc, essay] = r.data.rows.map((x) => x.question);
  assert.equal(q1.correct_answer, 'B');
  assert.equal(q2.correct_answer, 'C', 'answer given as option text is converted to its letter');
  assert.equal(q2.marks, 1, 'IQ marks follow the level (Easy = 1), not the Marks column');
  assert.equal(q1.difficulty, 'Easy');
  assert.equal(calc.correct_answer, '45');
  assert.equal(essay.section, 'ESSAY');
  assert.match(r.data.rows[4].errors.join(' '), /Correct answer/);
}

function checkBlockPreview(r) {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.found, 3);
  assert.equal(r.data.valid, 2);
  const [q1, q2] = r.data.rows.map((x) => x.question);
  assert.equal(q1.question_text, 'What number comes next: 3, 6, 9, ?');
  assert.equal(q1.option_c, '15');
  assert.equal(q1.correct_answer, 'B');
  assert.equal(q1.section, 'GENERAL', 'uses the section chosen in the upload form');
  assert.equal(q2.option_d, 'Chair', 'options written on one line are split');
  assert.equal(q2.section, 'IQ', 'a Type: line overrides the default');
  assert.equal(q2.marks, 3, 'IQ without a level = Level 3 (3 marks); the Marks line does not override it');
}

test('Excel .xlsx import preview', async () => checkTablePreview(await preview(workbook(TABLE, 'xlsx'), 'questions.xlsx')));
test('Excel .xls import preview', async () => checkTablePreview(await preview(workbook(TABLE, 'biff8'), 'questions.xls')));
test('CSV import preview (UTF-8, Lao text)', async () => {
  const rows = TABLE.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const r = await preview(Buffer.from('﻿' + rows.replace('Why LALCO?', 'ເປັນຫຍັງຢາກເຮັດວຽກກັບ LALCO?')), 'q.csv');
  checkTablePreview(r);
  assert.equal(r.data.rows[3].question.question_text, 'ເປັນຫຍັງຢາກເຮັດວຽກກັບ LALCO?');
});
test('Word .docx table import preview', async () => checkTablePreview(await preview(await docxTable(TABLE), 'questions.docx')));
test('Word .docx numbered text import preview', async () => checkBlockPreview(await preview(await docxText(BLOCK_TEXT), 'questions.docx', 'GENERAL')));
test('PDF import preview', async () => checkBlockPreview(await preview(await pdfOf(BLOCK_TEXT), 'questions.pdf', 'GENERAL')));
test('TXT import preview', async () => checkBlockPreview(await preview(Buffer.from(BLOCK_TEXT), 'questions.txt', 'GENERAL')));

test('sheet named "IQ" puts questions in the IQ bank when there is no Type column', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Question', 'A', 'B', 'Answer'], ['1 + 1 = ?', '2', '3', 'A']]), 'IQ');
  const r = await preview(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'q.xlsx', 'GENERAL');
  assert.equal(r.data.rows[0].question.section, 'IQ');
});

test('invalid files are handled safely', async () => {
  const exe = await preview(Buffer.from('MZ fake'), 'virus.exe');
  assert.equal(exe.status, 400);
  assert.match(exe.data.error, /not supported/);

  const fakeXlsx = await preview(Buffer.from('this is not a spreadsheet'), 'fake.xlsx');
  assert.equal(fakeXlsx.status, 400);
  assert.match(fakeXlsx.data.error, /does not look like/);

  const corruptZip = await preview(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]), 'broken.docx');
  assert.equal(corruptZip.status, 400);
  assert.match(corruptZip.data.error, /Unable to import this file/);

  const noQuestions = await preview(Buffer.from('hello\nworld'), 'notes.txt');
  assert.equal(noQuestions.status, 400);

  const wrongColumns = await preview(workbook([['Name', 'Phone'], ['A', 'B']], 'xlsx'), 'people.xlsx');
  assert.equal(wrongColumns.status, 400);
  assert.match(wrongColumns.data.error, /Question\nOptions\nCorrect Answer/);

  const tooBig = await preview(Buffer.alloc(11 * 1024 * 1024, 65), 'big.txt');
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.data.error, /10 MB/);

  // The server is still fine afterwards.
  assert.equal((await admin.get('/api/health')).status, 200);
});

test('confirmed import saves only valid rows', async () => {
  const p = await preview(workbook(TABLE, 'xlsx'), 'questions.xlsx');
  const valid = p.data.rows.filter((r) => r.errors.length === 0).map((r) => r.question);
  const r = await admin.post('/api/admin/questions/import', { questions: [...valid, { section: 'IQ', question_text: '' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { imported: 4, skipped: 1 });
  const counts = await admin.get('/api/admin/questions/counts');
  assert.ok(counts.data.IQ >= 2 && counts.data.ESSAY >= 1 && counts.data.CALCULATION >= 1);
});

test('questions can be added, edited, searched and deleted', async () => {
  const add = await admin.post('/api/admin/questions', {
    section: 'IQ', category: 'Sequence', difficulty: 'Medium', question_text: 'Unique zebra question?',
    option_a: '1', option_b: '2', option_c: '3', option_d: '4', correct_answer: 'd', marks: 2,
  });
  assert.equal(add.status, 201);
  assert.equal(add.data.correct_answer, 'D');

  const bad = await admin.post('/api/admin/questions', { section: 'IQ', question_text: 'No options' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Options are missing/);

  const edit = await admin.put('/api/admin/questions/' + add.data.id, { ...add.data, question_text: 'Unique zebra question, edited?', status: 'Inactive' });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.status, 'Inactive');

  const found = await admin.get('/api/admin/questions?q=zebra');
  assert.equal(found.data.questions.length, 1);
  assert.equal(found.data.questions[0].question_text, 'Unique zebra question, edited?');

  const onlyIq = await admin.get('/api/admin/questions?section=ESSAY');
  assert.ok(onlyIq.data.questions.every((q) => q.section === 'ESSAY'));

  assert.equal((await admin.del('/api/admin/questions/' + add.data.id)).status, 200);
  assert.equal((await admin.get('/api/admin/questions?q=zebra')).data.questions.length, 0);
});

test('question template downloads as Excel and re-imports cleanly', async () => {
  const r = await admin.get('/api/admin/questions/template.xlsx', { raw: true });
  assert.equal(r.status, 200);
  const p = await preview(r.buffer, 'template.xlsx');
  assert.equal(p.data.invalid, 0);
  assert.equal(p.data.valid, 5);
});

test('re-uploading the same questions does not create duplicates', async () => {
  const file = workbook(TABLE, 'xlsx');
  const p = await preview(file, 'again.xlsx');
  assert.equal(p.status, 200);
  assert.equal(p.data.valid, 0, 'every row is already in the bank');
  assert.ok(p.data.rows.filter((r) => r.errors.some((e) => /already in the question bank/.test(e))).length >= 4);

  const twice = workbook([HEADER, ['Brand new question?', 'IQ', '', '', '1', '2', '', '', 'A', 1], ['brand  NEW question?', 'IQ', '', '', '1', '2', '', '', 'A', 1]], 'xlsx');
  const p2 = await preview(twice, 'twice.xlsx');
  assert.equal(p2.data.valid, 1);
  assert.match(p2.data.rows[1].errors[0], /already in the question bank/);

  // The import step checks again, even if a client skips the preview.
  const r = await admin.post('/api/admin/questions/import', { questions: [p2.data.rows[0].question, p2.data.rows[0].question] });
  assert.deepEqual(r.data, { imported: 1, skipped: 1 });
});

// Files saved by Microsoft Word itself (legacy .doc, a Word table, Word's PDF export).
test('real Word-generated .doc and PDF files import', async () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
  for (const f of ['questions.doc', 'questions-word.pdf']) {
    const r = await preview(read(f), f, 'GENERAL');
    assert.equal(r.status, 200, f + ' ' + JSON.stringify(r.data));
    assert.equal(r.data.valid, 2, f);
    const [q1, q2] = r.data.rows.map((x) => x.question);
    assert.equal(q1.option_b, '40', f);
    assert.equal(q1.correct_answer, 'B', f);
    assert.equal(q2.option_c, 'Car', f);
    assert.equal(q2.section, 'IQ', f);
  }
  const t = await preview(read('table.doc'), 'table.doc', 'GENERAL');
  assert.equal(t.data.valid, 2);
  assert.equal(t.data.rows[0].question.section, 'CALCULATION');
  assert.equal(t.data.rows[1].question.correct_answer, 'B', 'answer "Cold" matched to option B');
});

// Three real pages of "IQ Test - 50 Mixed Questions" embedded as pictures:
// Question 01 (text answers), Question 08 (five picture answers) and the
// answer key for 1-25. There is no text layer, so the OCR fallback must run.
test('scanned (picture-only) PDF imports through OCR', { timeout: 180000 }, async () => {
  const fs = require('fs');
  const path = require('path');
  const r = await preview(fs.readFileSync(path.join(__dirname, 'fixtures', 'scanned-iq-sample.pdf')), 'scanned.pdf', 'IQ');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.found, 2);
  assert.equal(r.data.valid, 2);
  assert.equal(r.data.by_section.IQ, 2);
  const [q1, q8] = r.data.rows.map((x) => x.question);
  assert.equal(q1.question_text, 'What number comes next?');
  assert.deepEqual([q1.option_a, q1.option_b, q1.option_c, q1.option_d], ['19', '16', '15', '17']);
  assert.equal(q1.correct_answer, 'D', 'answer from the answer key page');
  assert.ok(q1.image_id, 'the question picture is kept');
  assert.equal(q8.question_text, 'Which figure is the odd one out?');
  assert.ok(['a', 'b', 'c', 'd', 'e'].every((l) => q8[`option_${l}_image`]), 'five picture options');
  assert.equal(q8.correct_answer, 'A');

  const imported = await admin.post('/api/admin/questions/import', { questions: [q1, q8] });
  assert.deepEqual(imported.data, { imported: 2, skipped: 0 });
  const again = await preview(fs.readFileSync(path.join(__dirname, 'fixtures', 'scanned-iq-sample.pdf')), 'scanned.pdf', 'IQ');
  assert.equal(again.data.valid, 0, 'uploading it again finds only duplicates');
});
