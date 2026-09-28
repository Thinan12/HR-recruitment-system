// The import pipeline on real-world layouts: every way of reading a file is
// tried and the best one wins; nothing is rejected as a whole; validation
// depends on the test type; HR can map unknown tables. Parsing AND database import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const XLSX = require('xlsx');
const docx = require('docx');
const PDFDocument = require('pdfkit');
const { start, stop, client, db, upload } = require('./helpers');

let admin;
test.before(async () => { await start(); admin = client(); await admin.login(); });
test.after(stop);

const preview = async (buf, name, section = 'GENERAL', mapping) => {
  const form = upload(buf, name, section);
  if (mapping) form.append('mapping', JSON.stringify(mapping));
  return admin.post('/api/admin/questions/import/preview', null, { form });
};
const ok = (r) => r.errors.length === 0 || (r.errors.length === 1 && /^Test Type "/.test(r.errors[0]));
const texts = (p) => p.rows.map((r) => r.question.question_text);
const importRows = async (p, extra = {}) => (await admin.post('/api/admin/questions/import', { questions: p.rows.filter(ok).map((r) => r.question), ...extra })).data;
const wordFile = (paras) => docx.Packer.toBuffer(new docx.Document({ sections: [{ children: paras.map((t) => (typeof t === 'string' ? new docx.Paragraph(t) : t)) }] }));
const sheet = (rows, type = 'xlsx') => { const b = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(b, XLSX.utils.aoa_to_sheet(rows), 'Sheet1'); return XLSX.write(b, { type: 'buffer', bookType: type }); };
const pdf = (draw) => new Promise((resolve) => {
  const d = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  d.on('data', (c) => chunks.push(c)); d.on('end', () => resolve(Buffer.concat(chunks)));
  d.fontSize(11); draw(d); d.end();
});

// The questions + options + answer key of the prompt, and the answer key forms.
const MCQ = ['1. Capital of France?', 'A. London', 'B. Paris', 'C. Rome', 'D. Madrid', '', '2. 2 + 2 = ?', 'A. 3', 'B. 4', 'C. 5', 'D. 6', '', 'Answer Key', ''];

test('MCQ with the answer key at the end, in every key style', async () => {
  for (const key of [['1. B', '2. B'], ['1 B', '2 B'], ['Q1 B', 'Q2 B'], ['Q1 - B', 'Q2 - B'], ['Question 1: B', 'Question 2: B'], ['1-B', '2-B'], ['1 B 2 B'], ['1. B 2. B']]) {
    const p = (await preview(Buffer.from([...MCQ, ...key].join('\n')), 'mcq.txt')).data;
    assert.deepEqual(p.rows.map((r) => [r.question.question_text, r.question.correct_answer, r.errors.length]), [['Capital of France?', 'B', 0], ['2 + 2 = ?', 'B', 0]], key.join(' / '));
  }
  // Inline answers ("Answer = B", "Ans: B", "Correct Answer: B").
  const inline = (await preview(Buffer.from('1. Capital of France?\nA. London\nB. Paris\nAns: B\n2. 2 + 2 = ?\nA) 3\nB) 4\nAnswer = B\n3. Sky colour?\nA. Blue\nB. Green\nCorrect Answer: A'), 'inline.txt')).data;
  assert.deepEqual(inline.rows.map((r) => r.question.correct_answer), ['B', 'B', 'A']);
});

test('a PDF footer with a tab ("Title <tab> Page 1 of 4") is never read as a table (the reported bug)', async () => {
  const buf = await pdf((d) => {
    for (let page = 1; page <= 2; page++) {
      if (page > 1) d.addPage();
      d.text('Behavioral Interview Questions & Sample Answers', 40, 40);
      for (let i = 1; i <= 3; i++) {
        const n = (page - 1) * 3 + i;
        d.text(`Question ${n}: Tell me about a time when you had to adapt to change number ${n}. What did you learn?`, 40, 60 + i * 60, { width: 500 });
        d.text('Sample Answer: I planned carefully, asked for help and finished on time.', 40, 90 + i * 60, { width: 500 });
      }
      d.text('Behavioral Interview Questions & Sample Answers', 40, 780, { lineBreak: false }); d.text(`Page ${page} of 2`, 480, 780, { lineBreak: false });
    }
  });
  const p = (await preview(buf, 'behavioral.pdf', 'GENERAL')).data;
  assert.notEqual(p.format, 'table (header row)');
  assert.equal(p.found, 6);
  assert.ok(p.rows.every(ok) && p.rows.every((r) => !/Sample Answer|Page \d/.test(r.question.question_text)), 'no sample answers or footers in the questions');
  assert.match(p.rows[0].question.correct_answer, /^I planned carefully/, 'the sample answer is HR-only guidance');
  assert.deepEqual(p.type_decisions.map((d) => [d.name, d.behavior]), [['Behavioural Interview', 'interview']], 'open interview questions are not put into General');
});

test('behavioural bank: "1. ADAPTABILITY" + "Question 1:" on its own line + "Sample Answer:" (the real TXT layout) -> questions with categories', async () => {
  const txt = ['1. ADAPTABILITY', '', 'Question 1:', 'Tell me about a time when you were asked to do something you had never done before.', '', 'Sample Answer:', 'When I was given a task I had never handled before, I researched it.', '',
    'Question 2:', 'Describe a situation in which you embraced a new system.', '', 'Sample Answer:', 'Our team introduced a new system.', '', '=====', '2. CULTURE FIT', '',
    'Question 3:', 'What are the three things that are most important to you in a job?', '', 'Sample Answer:', 'Learning, respect and clear expectations.'].join('\n');
  const p = (await preview(Buffer.from(txt), 'bank.txt', 'GENERAL')).data;
  assert.deepEqual(p.rows.map((r) => [r.number, r.question.category, r.question.question_text]), [
    [1, 'Adaptability', 'Tell me about a time when you were asked to do something you had never done before.'],
    [2, 'Adaptability', 'Describe a situation in which you embraced a new system.'],
    [3, 'Culture Fit', 'What are the three things that are most important to you in a job?']]);
  assert.ok(p.rows.every((r) => r.question.type_name === 'Behavioural Interview'), 'not Calculation, not General');
  assert.equal(p.document.categories.length, 2);
  // Import: create the interview type; categories come with it; guidance kept HR-only.
  const imp = await importRows(p, { type_decisions: { 'behavioural interview': { create: true, behavior: 'interview' } } });
  assert.deepEqual(imp, { imported: 3, skipped: 0 });
  const key = (await admin.get('/api/admin/test-types')).data.find((t) => t.name === 'Behavioural Interview').key;
  const bank = db.prepare('SELECT q.question_text, q.correct_answer, q.status, c.name AS category FROM questions q LEFT JOIN question_categories c ON c.id = q.category_id WHERE q.section = ? ORDER BY q.id').all(key);
  assert.deepEqual(bank.map((q) => [q.category, q.status]), [['Adaptability', 'Active'], ['Adaptability', 'Active'], ['Culture Fit', 'Active']]);
  assert.match(bank[0].correct_answer, /^When I was given a task/);
});

test('"CATEGORY 1: ADAPTABILITY (QUESTIONS 1 – 5)" and "Q01" questions under an "Interview" title are imported (interview headings no longer hide questions)', async () => {
  const txt = ['Behavioral Interview Question Bank', 'Evaluation Methodology: S.T.A.R. Framework', 'S - Situation', 'CATEGORY 1: ADAPTABILITY (QUESTIONS 1 – 2)',
    'Q01 Tell me about a time when you were asked to do something new. How did you react?', 'SAMPLE STRONG ANSWER', '“I prepared and asked questions.”',
    'Q02 Describe a situation in which you embraced a new process.', 'SAMPLE STRONG ANSWER', '“I learned it quickly.”',
    'CATEGORY 2: LEADERSHIP (CONTINUED, QUESTIONS 3 – 3)', 'Q03 Give me an example of a time when you led by example.'].join('\n');
  const p = (await preview(Buffer.from(txt), 'guide.txt', 'GENERAL')).data;
  assert.deepEqual(p.rows.map((r) => [r.question.category, r.question.question_text.slice(0, 20)]), [['Adaptability', 'Tell me about a time'], ['Adaptability', 'Describe a situation'], ['Leadership', 'Give me an example o']]);
  assert.ok(p.rows.every(ok), JSON.stringify(p.rows.map((r) => r.errors)));
  assert.match(p.rows[0].question.correct_answer, /I prepared/);
  // Interview NOTES (no numbered questions) are still not imported.
  const notes = (await preview(Buffer.from('1. What is 2 + 2?\nA. 3\nB. 4\nAnswer: B\nInterview:\nAsk about previous jobs\nReject if late'), 'n.txt', 'GENERAL')).data;
  assert.deepEqual(texts(notes), ['What is 2 + 2?']);
});

test('calculation: sub-headings are categories, not glued to option D; short answers; missing answer = Answer required', async () => {
  const txt = ['Calculation Quiz', 'BASIC ARITHMETIC', '1. 245 + 378 = ?', 'A 613 B 623 C 633 D 723', 'ORDER OF OPERATIONS', '2. 25 × 4 × 3 = ?', 'A 250 B 280 C 320 D 300',
    '3. Calculate 15 × 7.', 'Answer: 105', '4. Calculate the total amount of 100 and 150.', 'Expected Answer: 250', '5. A loan of $1,200 over 12 months: how much per month?', 'Answer Key', '1. B 623', '2. D 300'].join('\n');
  const p = (await preview(Buffer.from(txt), 'calc.txt', 'CALCULATION')).data;
  assert.deepEqual(p.rows.map((r) => [r.number, r.question.category, r.question.option_d || '', r.question.correct_answer, r.answer_required]), [
    [1, 'Basic Arithmetic', '723', 'B', false], [2, 'Order of Operations', '300', 'D', false], [3, 'Order of Operations', '', '105', false], [4, 'Order of Operations', '', '250', false], [5, 'Order of Operations', '', '', true]]);
  assert.equal(p.conflicts, 0);
  const imp = await importRows(p, { create_missing_categories: true });
  assert.deepEqual(imp, { imported: 5, skipped: 0, answer_required: 1 });
  assert.equal(db.prepare("SELECT status FROM questions WHERE question_text LIKE 'A loan of $1,200%'").get().status, 'Inactive');
});

test('Excel with other column names, CSV with semicolons, TSV, pipe table in TXT', async () => {
  const rows = [['Question Text', 'Choice A', 'Choice B', 'Choice C', 'Choice D', 'Correct Option', 'Question Type', 'Competency', 'IQ Level'],
    ['2, 4, 8, ?', '10', '16', '12', '14', 'B', 'IQ', 'Number Patterns', 'Level 2'], ['Odd one out: cat, dog, car', 'cat', 'dog', 'car', 'cow', 'C', 'IQ', 'Odd One Out', '1']];
  const x = (await preview(sheet(rows), 'bank.xlsx', 'GENERAL')).data;
  assert.deepEqual(x.rows.map((r) => [r.question.section, r.question.category, r.question.difficulty, r.question.marks, r.question.correct_answer, r.errors.length]),
    [['IQ', 'Number Patterns', 'Basic', 2, 'B', 0], ['IQ', 'Odd One Out', 'Easy', 1, 'C', 0]]);
  const csv = 'Question;Option A;Option B;Answer\n"What is 1; 2?";yes;no;A\nCapital of Laos?;Vientiane;Pakse;A\n';
  assert.deepEqual((await preview(Buffer.from(csv), 'bank.csv', 'GENERAL')).data.rows.map((r) => [r.question.question_text, r.question.option_a, r.errors.length]), [['What is 1; 2?', 'yes', 0], ['Capital of Laos?', 'Vientiane', 0]]);
  const tsv = 'Question\tOption A\tOption B\tAnswer\nTSV question?\tone\ttwo\tB\n';
  assert.equal((await preview(Buffer.from(tsv), 'bank.tsv', 'GENERAL')).data.rows[0].question.correct_answer, 'B');
  const pipes = '| Question | Option A | Option B | Answer |\n|---|---|---|---|\n| Pipe question? | x | y | A |\n| Second? | p | q | B |\n';
  assert.deepEqual((await preview(Buffer.from(pipes), 'bank.txt', 'GENERAL')).data.rows.map((r) => r.question.correct_answer), ['A', 'B']);
});

test('several questions in one table cell become separate questions with the row category (Excel and Word)', async () => {
  const x = (await preview(sheet([['Competency', 'Questions'], ['Change Leadership', '• Describe a time you led a major change.\n• How did you handle resistance?'], ['Analytical Thinking', '• Tell me about a complex problem you solved.']]), 'comp.xlsx', 'ESSAY')).data;
  assert.deepEqual(x.rows.map((r) => [r.question.category, r.question.question_text]), [['Change Leadership', 'Describe a time you led a major change.'], ['Change Leadership', 'How did you handle resistance?'], ['Analytical Thinking', 'Tell me about a complex problem you solved.']]);
  const { Table, TableRow, TableCell, Paragraph } = docx;
  const cell = (...t) => new TableCell({ children: t.map((s) => new Paragraph(s)) });
  const w = await wordFile([new Table({ rows: [new TableRow({ children: [cell('Competency'), cell('Questions')] }),
    new TableRow({ children: [cell('Leadership'), cell('• Tell me about a time you led a team.', '• Describe how you motivated others.', '• Give me an example of a hard decision.')] })] })]);
  const wp = (await preview(w, 'comp.docx', 'ESSAY')).data;
  assert.deepEqual(wp.rows.map((r) => [r.question.category, r.question.question_text.slice(0, 18)]), [['Leadership', 'Tell me about a ti'], ['Leadership', 'Describe how you m'], ['Leadership', 'Give me an example']]);
});

test('Word: paragraph MCQs with an answer key, and a question table with options in cells', async () => {
  const w = await wordFile(['Test instructions: answer every question.', ...MCQ.filter(Boolean), '1. B', '2. B']);
  const p = (await preview(w, 'mcq.docx', 'GENERAL')).data;
  assert.deepEqual(p.rows.map((r) => [r.question.question_text, r.question.correct_answer, r.errors.length]), [['Capital of France?', 'B', 0], ['2 + 2 = ?', 'B', 0]]);
  const { Table, TableRow, TableCell, Paragraph } = docx;
  const row = (cells) => new TableRow({ children: cells.map((c) => new TableCell({ children: [new Paragraph(c)] })) });
  const t = await wordFile([new Table({ rows: [row(['No', 'Question', 'A', 'B', 'C', 'Answer']), row(['1', 'Largest planet?', 'Mars', 'Jupiter', 'Venus', 'B']), row(['2', 'Gold symbol?', 'Au', 'Ag', 'Gd', 'A'])] })]);
  assert.deepEqual((await preview(t, 'table.docx', 'GENERAL')).data.rows.map((r) => [r.question.question_text, r.question.option_b, r.question.correct_answer]), [['Largest planet?', 'Jupiter', 'B'], ['Gold symbol?', 'Ag', 'A']]);
});

test('PDF: numbered MCQ with an answer key; a two-column page read column by column', async () => {
  const one = await pdf((d) => { let y = 60; for (const l of [...MCQ.filter(Boolean), '1. B', '2. B']) { d.text(l, 40, y); y += 18; } });
  assert.deepEqual((await preview(one, 'mcq.pdf', 'GENERAL')).data.rows.map((r) => [r.question.question_text, r.question.correct_answer]), [['Capital of France?', 'B'], ['2 + 2 = ?', 'B']]);
  const two = await pdf((d) => {
    const col = (x, qs) => { let y = 60; for (const l of qs) { d.text(l, x, y, { width: 240, lineBreak: false }); y += 18; } };
    col(40, ['1. Left one?', 'A. a1', 'B. b1', 'Answer: A', '2. Left two?', 'A. a2', 'B. b2', 'Answer: B']);
    col(310, ['3. Right three?', 'A. a3', 'B. b3', 'Answer: A', '4. Right four?', 'A. a4', 'B. b4', 'Answer: B']);
  });
  const p = (await preview(two, 'cols.pdf', 'GENERAL')).data;
  assert.deepEqual(p.rows.map((r) => [r.number, r.question.question_text, r.question.option_b, r.question.correct_answer]),
    [[1, 'Left one?', 'b1', 'A'], [2, 'Left two?', 'b2', 'B'], [3, 'Right three?', 'b3', 'A'], [4, 'Right four?', 'b4', 'B']]);
});

test('essay and unnumbered open questions without question marks; titles and greetings are not questions', async () => {
  const p = (await preview(Buffer.from('Essay test\n\nDescribe a difficult situation you experienced at work and explain how you handled it.\nExplain why teamwork matters.\nGood luck!'), 'essay.txt', 'ESSAY')).data;
  assert.deepEqual(texts(p), ['Describe a difficult situation you experienced at work and explain how you handled it.', 'Explain why teamwork matters.']);
  assert.ok(p.rows.every((r) => r.errors.length === 0 && !r.question.option_a));
});

test('duplicates in the file and against the bank; one bad question never blocks the rest', async () => {
  const txt = '1. Duplicate check question?\nA. x\nB. y\nAnswer: A\n2. Duplicate check question?\nA. x\nB. y\nAnswer: A\n3. Broken question with one option\nA. only\nAnswer: A\n4. Fine question?\nA. p\nB. q\nAnswer: B';
  const p = (await preview(Buffer.from(txt), 'dups.txt', 'GENERAL')).data;
  assert.deepEqual(p.rows.map((r) => (r.errors.length ? (/Duplicate/.test(r.errors[0]) ? 'duplicate' : 'invalid') : 'valid')), ['valid', 'duplicate', 'invalid', 'valid']);
  assert.deepEqual(await importRows(p), { imported: 2, skipped: 0 });
  const again = (await preview(Buffer.from(txt), 'dups.txt', 'GENERAL')).data;
  assert.equal(again.duplicates, 3, 'already in the bank');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE question_text = 'Duplicate check question?'").get().n, 1, 'nothing deleted, nothing duplicated');
});

test('an IQ question without a level is flagged for HR (not silently given one); HR can map an unknown table', async () => {
  const p = (await preview(sheet([['Question', 'A', 'B', 'Answer', 'Type'], ['Next: 1, 2, 3, ?', '4', '5', 'A', 'IQ']]), 'iq.xlsx', 'IQ')).data;
  assert.match(p.rows[0].review, /No IQ level/);
  // A table with headings the importer does not know: HR maps the columns and it imports.
  const odd = sheet([['Item text', 'First', 'Second', 'Right one'], ['Mapped question?', 'yes', 'no', 'A'], ['Second mapped?', 'up', 'down', 'B']]);
  const first = (await preview(odd, 'odd.xlsx', 'GENERAL')).data;
  assert.ok(first.unmapped && first.unmapped[0][0] === 'Item text');
  const mapped = (await preview(odd, 'odd.xlsx', 'GENERAL', { header_row: 0, columns: { 0: 'question_text', 1: 'option_a', 2: 'option_b', 3: 'correct_answer' } })).data;
  assert.deepEqual(mapped.rows.map((r) => [r.question.question_text, r.question.correct_answer, r.errors.length]), [['Mapped question?', 'A', 0], ['Second mapped?', 'B', 0]]);
  assert.deepEqual(await importRows(mapped), { imported: 2, skipped: 0 });
});

test('empty, tiny, unsupported and large files', async () => {
  assert.match((await preview(Buffer.alloc(0), 'empty.txt')).data.error, /empty/);
  assert.match((await preview(Buffer.from('x'), 'a.pages')).data.error, /not supported/);
  const tiny = (await preview(Buffer.from('1. 2+2?\nA. 3\nB. 4\nAnswer: B'), 'tiny.txt', 'GENERAL')).data;
  assert.equal(tiny.valid, 1);
  // 1500-question bank in one Excel file: previewed and imported.
  const big = [['Question', 'Option A', 'Option B', 'Answer', 'Type']];
  for (let i = 1; i <= 1500; i++) big.push([`Bulk question number ${i}?`, 'yes', 'no', i % 2 ? 'A' : 'B', 'General']);
  const bp = (await preview(sheet(big), 'big.xlsx', 'GENERAL')).data;
  assert.equal(bp.valid, 1500);
  assert.deepEqual(await importRows(bp), { imported: 1500, skipped: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE question_text LIKE 'Bulk question number %'").get().n, 1500);
});

// The user's real documents, when available on this machine (not committed).
const REAL = (process.env.LALCO_REAL_IMPORT_FILES || '').split(';').filter((f) => f && fs.existsSync(f));
test('real recruitment documents', { skip: REAL.length ? false : 'set LALCO_REAL_IMPORT_FILES=file1;file2 to run this' }, async () => {
  for (const f of REAL) {
    const p = (await preview(fs.readFileSync(f), require('path').basename(f), 'GENERAL')).data;
    assert.ok(p.rows && p.rows.filter(ok).length >= 5, `${f}: ${p.error || p.rows.filter(ok).length}`);
  }
});
