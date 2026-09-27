// Question import without column headers: numbered questions, options in many
// styles, and answer keys - in PDF, Word, TXT, CSV, TSV and Excel files, for
// General, IQ, Calculation and Essay.
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

const preview = (buf, name, section) => admin.post('/api/admin/questions/import/preview', undefined, { form: upload(buf, name, section) });
const qs = (r) => r.data.rows.map((x) => x.question);

// A quiz PDF like a typical printed handout: title, name line, page headers,
// options "A Sydney B Melbourne" (sometimes over two lines), answer key on the last page.
function quizPdf(questions, keyLines, { keyHeading = 'Answer Key', perPage = 4, optionStyle = 'bare' } = {}) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const mark = (L) => (optionStyle === 'bare' ? `${L} ` : optionStyle === 'dot' ? `${L}. ` : `(${L}) `);
    questions.forEach((q, i) => {
      if (i % perPage === 0) {
        doc.addPage();
        doc.fontSize(9).text(`SAMPLE QUIZ Page ${i / perPage + 1}`);
        if (i === 0) { doc.fontSize(16).text('Sample Quiz'); doc.fontSize(10).text('Circle one answer · Answer key on the last page'); doc.text('Name: ______________ Score: ____ / 25'); }
      }
      doc.fontSize(11).text(`${i + 1}. ${q[0]}`);
      const opts = q.slice(1).map((o, k) => mark('ABCD'[k]) + o);
      if (i % 3 === 2) { doc.text(opts.slice(0, 2).join(' ')); doc.text(opts.slice(2).join(' ')); } else doc.text(opts.join(' '));
    });
    doc.addPage();
    doc.fontSize(9).text(`${keyHeading.toUpperCase()} Page ${Math.ceil(questions.length / perPage) + 1}`);
    doc.fontSize(12).text(keyHeading);
    for (const l of keyLines) doc.fontSize(11).text(l);
    doc.end();
  });
}

const QUIZ = [
  ['What is the capital of Australia?', 'Sydney', 'Melbourne', 'Canberra', 'Perth'],
  ['Which is the largest planet in our solar system?', 'Saturn', 'Jupiter', 'Neptune', 'Earth'],
  ['Who painted the Mona Lisa?', 'Michelangelo', 'Van Gogh', 'Picasso', 'Leonardo da Vinci'],
  ['What is the chemical symbol for gold?', 'Go', 'Gd', 'Au', 'Ag'],
  ['How many continents are there?', '5', '6', '7', '8'],
  ['At what temperature does water boil at sea level?', '90°C', '100°C', '110°C', '120°C'],
  ['Which gas do plants absorb from the air?', 'Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'],
];
const KEY = ['1. C Canberra', '2. B Jupiter', '3. D Leonardo da Vinci', '4. C Au', '5. C 7', '6. B 100°C', '7. C Carbon dioxide'];
const ANSWERS = ['C', 'B', 'D', 'C', 'C', 'B', 'C'];

test('PDF quiz without headers: bare options, page breaks, answer key on its own page', async () => {
  const r = await preview(await quizPdf(QUIZ, KEY), 'quiz.pdf', 'GENERAL');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.found, 7);
  assert.equal(r.data.valid, 7);
  assert.equal(r.data.conflicts, 0);
  assert.equal(r.data.answer_key, 7);
  assert.match(r.data.format, /answer key/);
  assert.deepEqual(qs(r).map((q) => q.correct_answer), ANSWERS);
  assert.deepEqual([qs(r)[2].option_a, qs(r)[2].option_d], ['Michelangelo', 'Leonardo da Vinci'], 'options split over two lines');
  assert.equal(qs(r)[6].option_c, 'Carbon dioxide');
  assert.ok(qs(r).every((q) => q.section === 'GENERAL'));
  assert.ok(!qs(r).some((q) => /Page|Name:|Sample Quiz/.test(q.question_text)), 'title, name line and page headers are not questions');
  assert.deepEqual(r.data.rows.map((x) => x.number), [1, 2, 3, 4, 5, 6, 7]);
});

test('PDF with "A." options and a "Solutions" heading; answer key given as text only', async () => {
  const key = ['1. Canberra', '2. Jupiter', '3. Leonardo da Vinci', '4. Au', '5. 7', '6. 100°C', '7. Carbon dioxide'];
  const r = await preview(await quizPdf(QUIZ, key, { keyHeading: 'Solutions', optionStyle: 'dot' }), 'quiz2.pdf', 'GENERAL');
  assert.equal(r.data.valid, 7, JSON.stringify(r.data.rows.map((x) => x.errors)));
  assert.deepEqual(qs(r).map((q) => q.correct_answer), ANSWERS);
});

test('answer conflicts and unclear answers are marked for review, never guessed', async () => {
  const key = ['1. C Melbourne', '2. Pluto', '3. D', '4. C Au', '5. C 7', '6. B 100°C', '7. C Carbon dioxide'];
  const r = await preview(await quizPdf(QUIZ, key, { optionStyle: 'paren' }), 'conflicts.pdf', 'GENERAL');
  assert.equal(r.data.found, 7);
  assert.equal(r.data.valid, 5);
  assert.equal(r.data.conflicts, 1);
  assert.match(r.data.rows[0].errors.join(' '), /Answer conflict — review required/);
  assert.match(r.data.rows[1].errors.join(' '), /Correct answer — review required/);
  assert.equal(qs(r)[2].correct_answer, 'D', 'a letter-only key is accepted');
});

test('TXT: inline "Answer: B", answer key styles "1 - C", "2: B", compact "1. C 2. B", and Q1 / Question 2 numbering', async () => {
  const inline = await preview(Buffer.from('1. What is 2 + 2?\nA. 3\nB. 4\nC. 5\nD. 6\nAnswer: B\n\n2) Which is a fruit?\na) Carrot\nb) Apple\nc) Potato\nd) Onion\nAnswer: Apple\n'), 'inline.txt', 'GENERAL');
  assert.deepEqual(qs(inline).map((q) => q.correct_answer), ['B', 'B']);

  const keyed = await preview(Buffer.from('Q1 What is 2 + 2?\nA 3 B 4 C 5 D 6\nQuestion 2: Which colour is the sky?\nA Green B Blue C Red D Yellow\nQ.3 Which is even?\n(A) 3 (B) 5 (C) 8 (D) 9\n\nANSWERS\n1 - B\n2: B\n3. C\n'), 'keyed.txt', 'GENERAL');
  assert.equal(keyed.data.valid, 3, JSON.stringify(keyed.data.rows));
  assert.deepEqual(qs(keyed).map((q) => q.correct_answer), ['B', 'B', 'C']);
  assert.equal(qs(keyed)[1].question_text, 'Which colour is the sky?');

  const compact = await preview(Buffer.from('1. One?\nA. x\nB. y\n2. Two?\nA. x\nB. y\n3. Three?\nA. x\nB. y\nCorrect Answers\n1. B 2. A 3. B\n'), 'compact.txt', 'GENERAL');
  assert.deepEqual(qs(compact).map((q) => q.correct_answer), ['B', 'A', 'B']);
});

test('multi-line questions and wrapped options are joined', async () => {
  const r = await preview(Buffer.from('1. Which of the following is the largest\nplanet in our solar system?\nA. Saturn\nB. Jupiter, the gas\ngiant\nC. Mars\nD. Earth\nAnswer Key\n1. B\n'), 'wrap.txt', 'GENERAL');
  assert.equal(qs(r)[0].question_text, 'Which of the following is the largest\nplanet in our solar system?');
  assert.equal(qs(r)[0].option_b, 'Jupiter, the gas giant');
  assert.equal(qs(r)[0].correct_answer, 'B');
});

test('Word (.docx) with inline options and an answer key at the end', async () => {
  const { Document, Packer, Paragraph } = docx;
  const lines = ['General quiz', '1. What is the capital of Australia?', 'A Sydney B Melbourne C Canberra D Perth', '2. Who wrote Romeo and Juliet?', 'A. Dickens', 'B. Shakespeare', 'C. Twain', 'D. Austen', 'Answer Key', '1. C Canberra', '2. B Shakespeare'];
  const buf = await Packer.toBuffer(new Document({ sections: [{ children: lines.map((l) => new Paragraph(l)) }] }));
  const r = await preview(buf, 'quiz.docx', 'GENERAL');
  assert.equal(r.data.valid, 2, JSON.stringify(r.data.rows));
  assert.deepEqual(qs(r).map((q) => q.correct_answer), ['C', 'B']);
});

test('CSV / TSV / Excel with header variations, including one "Options" column', async () => {
  const csv = await preview(Buffer.from('Q,Choice A,Choice B,Choice C,Choice D,Correct Option\nWhat is 1+1?,1,2,3,4,B\n'), 'v.csv', 'GENERAL');
  assert.equal(qs(csv)[0].correct_answer, 'B');
  const optionsCol = await preview(Buffer.from('Question Text,Options,Correct\nPick blue,Red; Blue; Green; Pink,Blue\n'), 'o.csv', 'GENERAL');
  assert.deepEqual([qs(optionsCol)[0].option_b, qs(optionsCol)[0].correct_answer], ['Blue', 'B']);
  const tsv = await preview(Buffer.from('Question\tOption A\tOption B\tAnswer\nWhich is bigger?\t2\t9\tB\n'), 'q.tsv', 'GENERAL');
  assert.equal(tsv.status, 200, JSON.stringify(tsv.data));
  assert.equal(qs(tsv)[0].correct_answer, 'B');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['QUESTION', 'option a', 'Option-B', 'correct answer'], ['Up or down?', 'Up', 'Down', 'A']]), 'S');
  const xlsx = await preview(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'h.xlsx', 'GENERAL');
  assert.equal(qs(xlsx)[0].correct_answer, 'A');
});

test('Calculation: short answers from an answer key, and multiple choice', async () => {
  const r = await preview(Buffer.from('1. What is 12 x 12?\n2. What is 15% of 200?\n3. What is 7 x 8?\nA 54 B 56 C 58 D 64\nAnswer Key\n1. 144\n2. 30\n3. B 56\n'), 'calc.txt', 'CALCULATION');
  assert.equal(r.data.valid, 3, JSON.stringify(r.data.rows));
  assert.deepEqual(qs(r).map((q) => [q.section, q.correct_answer]), [['CALCULATION', '144'], ['CALCULATION', '30'], ['CALCULATION', 'B']]);
});

test('Essay: prompts need no options or answer', async () => {
  const r = await preview(Buffer.from('1. Describe a time you solved a hard problem at work.\nMarks: 10\n2. Why do you want to join LALCO?\nExplain in 150 words.\n'), 'essay.txt', 'ESSAY');
  assert.equal(r.data.valid, 2, JSON.stringify(r.data.rows));
  assert.deepEqual(qs(r).map((q) => [q.section, q.marks]), [['ESSAY', 10], ['ESSAY', 1]]);
  assert.equal(qs(r)[1].question_text, 'Why do you want to join LALCO?\nExplain in 150 words.');
});

test('IQ uploads stay IQ (with the IQ level rule); General uploads never become IQ', async () => {
  const text = '1. Next number: 2, 4, 6, ?\nA 7 B 8 C 9 D 10\nLevel: 2\nAnswer Key\n1. B\n';
  const iq = await preview(Buffer.from(text), 'iq.txt', 'IQ');
  assert.deepEqual([qs(iq)[0].section, qs(iq)[0].difficulty, qs(iq)[0].marks], ['IQ', 'Basic', 2]);
  const general = await preview(Buffer.from(text.replace('Level: 2\n', '')), 'g.txt', 'GENERAL');
  assert.equal(qs(general)[0].section, 'GENERAL');
});

test('duplicates are reported, within the file and against the bank', async () => {
  const text = '1. Unique duplicate check?\nA. yes\nB. no\n2. Unique duplicate check?\nA. yes\nB. no\nAnswer Key\n1. A\n2. A\n';
  const first = await preview(Buffer.from(text), 'dup.txt', 'GENERAL');
  assert.equal(first.data.valid, 1);
  assert.equal(first.data.duplicates, 1);
  assert.match(first.data.rows[1].errors[0], /Duplicate — not imported/);
  await admin.post('/api/admin/questions/import', { questions: [qs(first)[0]] });
  const again = await preview(Buffer.from(text), 'dup.txt', 'GENERAL');
  assert.equal(again.data.duplicates, 2);
});

test('a file with no usable questions explains what was found', async () => {
  const r = await preview(Buffer.from('Welcome to the quiz\nPlease read carefully.\n1. A question with no options or answer\n'), 'bad.txt', 'GENERAL');
  assert.equal(r.status, 400);
  for (const want of ['Could not detect a valid question structure', 'Detected format:', 'Questions found: 1', 'Options found: 0', 'Answers found: 0', 'Valid questions: 0', 'Invalid questions: 1', 'Answer conflicts: 0']) {
    assert.ok(r.data.error.includes(want), want);
  }
});
