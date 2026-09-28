// Builds the import test files used by the Postman collection (postman/fixtures).
// Every file has a known expected result, asserted by the collection.
// Run from the repository root:  node postman/tools/make-fixtures.js
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const docx = require('docx');
const XLSX = require('xlsx');

const OUT = path.join(__dirname, '..', 'fixtures');
fs.mkdirSync(OUT, { recursive: true });
const write = (name, data) => { fs.writeFileSync(path.join(OUT, name), data); console.log('wrote', name, data.length, 'bytes'); };

const pdf = (draw) => new Promise((resolve) => {
  const d = new PDFDocument({ size: 'A4', margin: 40, info: { CreationDate: new Date('2026-01-01T00:00:00Z') } });
  const chunks = [];
  d.on('data', (c) => chunks.push(c));
  d.on('end', () => resolve(Buffer.concat(chunks)));
  d.fontSize(11);
  draw(d);
  d.end();
});
const word = (children) => docx.Packer.toBuffer(new docx.Document({ creator: 'LALCO HR tests', sections: [{ children }] }));
const P = (t) => new docx.Paragraph(t);

(async () => {
  // A. MCQ, inline answers (TXT): 4 questions, all valid.
  write('mcq-inline-answers.txt', [
    'General knowledge — Postman fixture', '',
    '1. Which planet is known as the Red Planet?', 'A. Venus', 'B. Mars', 'C. Jupiter', 'D. Mercury', 'Answer: B', '',
    '2. How many days are in a leap year?', 'A. 365', 'B. 364', 'C. 366', 'D. 360', 'Answer: C', '',
    '3. Which gas do plants absorb from the air', 'A. Oxygen', 'B. Nitrogen', 'C. Carbon dioxide', 'D. Helium', 'Ans: C', '',
    '4. Which ocean is the largest?', 'A) Atlantic', 'B) Indian', 'C) Arctic', 'D) Pacific', 'Correct Answer: D', '',
  ].join('\n'));

  // B. MCQ with the answer key at the end (PDF): 5 questions, options on separate lines.
  write('mcq-answer-key.pdf', await pdf((d) => {
    d.fontSize(14).text('Postman Fixture Quiz', 40, 40).fontSize(11);
    let y = 80;
    const qs = [['What is 7 x 8?', ['54', '56', '58', '64']], ['Which colour do you get by mixing blue and yellow?', ['Green', 'Purple', 'Orange', 'Brown']],
      ['How many sides does a hexagon have?', ['5', '6', '7', '8']], ['What is the boiling point of water at sea level (Celsius)?', ['90', '95', '100', '110']],
      ['Which is the smallest prime number?', ['0', '1', '2', '3']]];
    qs.forEach(([q, o], i) => {
      d.text(`${i + 1}. ${q}`, 40, y); y += 16;
      o.forEach((t, k) => { d.text(`${'ABCD'[k]}. ${t}`, 60, y); y += 14; });
      y += 8;
    });
    d.addPage();
    d.text('Answer Key', 40, 40);
    ['1. B', '2. A', '3. B', '4. C', '5. C'].forEach((l, i) => d.text(l, 40, 64 + i * 16));
  }));

  // C. Question bank table (XLSX) with alternative column names: 4 questions, categories from "Topic".
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Question Text', 'Choice A', 'Choice B', 'Choice C', 'Choice D', 'Ans', 'Topic'],
    ['What does CPU stand for?', 'Central Processing Unit', 'Computer Power Unit', 'Core Program Utility', 'Central Print Unit', 'A', 'Computers'],
    ['Which key copies text in most programs?', 'Ctrl+V', 'Ctrl+C', 'Ctrl+X', 'Ctrl+Z', 'B', 'Computers'],
    ['What is 25% of 80?', '15', '20', '25', '40', 'B', 'Numbers'],
    ['Which is a spreadsheet program?', 'Word', 'Paint', 'Excel', 'Notepad', 'C', 'Computers'],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Questions');
  write('mcq-bank.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));

  // D. CSV with semicolons and a quoted value containing a semicolon: 3 questions.
  write('mcq-semicolon.csv', [
    'Question;Option A;Option B;Option C;Correct Answer',
    '"Which one is a fruit; not a vegetable?";Carrot;Apple;Potato;B',
    'How many minutes are in an hour?;30;60;100;B',
    'What is the capital of Japan?;Tokyo;Osaka;Kyoto;A',
  ].join('\r\n'));

  // E. TSV: 3 questions.
  write('questions.tsv', [
    'Question\tOption A\tOption B\tOption C\tAnswer',
    'Which animal is the largest mammal?\tElephant\tBlue whale\tGiraffe\tB',
    'How many continents are there?\t5\t6\t7\tC',
    'Which metal is liquid at room temperature?\tMercury\tIron\tGold\tA',
  ].join('\n'));

  // F. Behavioural questions: "1. CATEGORY" + "Question N:" + "Sample Answer:" (DOCX): 4 questions, 2 categories.
  write('behavioral-numbered.docx', await word([
    P('Behavioral Interview Questions & Sample Answers (Postman fixture)'),
    P('1. ADAPTABILITY'),
    P('Question 1:'), P('Tell me about a time when you had to learn a new tool quickly at work. How did you approach it?'),
    P('Sample Answer:'), P('I set aside time each day, followed the official guide and asked a colleague to review my first tasks.'),
    P('Question 2:'), P('Describe a situation in which your priorities changed suddenly and what you did next.'),
    P('Sample Answer:'), P('I listed the open tasks, agreed the new order with my manager and informed the people affected.'),
    P('2. COLLABORATION'),
    P('Question 3:'), P('Give an example of a disagreement with a teammate and how you resolved it.'),
    P('Sample Answer:'), P('We compared the facts, chose the option that met the deadline and I thanked him for raising it.'),
    P('Question 4:'), P('Tell me about a project where you helped a colleague who was struggling.'),
    P('Sample Answer:'), P('I paired with her for two afternoons and shared my checklist; she finished her part on time.'),
  ]));

  // G. Behavioural bullet questions under headings (TXT): 5 questions, 2 categories.
  write('behavioral-bullets.txt', [
    'Interview Questions (Postman fixture)', '',
    'Leadership',
    '• Tell me about a time when you led a team through a difficult deadline',
    '  and what you learned from it.',
    '• Describe a decision you made that was unpopular with your team. What happened?',
    '• Give me an example of how you motivated a colleague who had lost interest',
    '',
    'Customer Service:',
    '• Recount a time you handled an angry customer.',
    '• Describe a situation where you went beyond what a customer expected.',
  ].join('\n'));

  // H. REGRESSION — competency TABLE with several bullet questions per cell (DOCX): 5 questions, 2 categories.
  const { Table, TableRow, TableCell } = docx;
  const cell = (...t) => new TableCell({ children: t.map((s) => P(s)) });
  write('behavioral-competency-table.docx', await word([
    P('Sample Behavioural Questions by Competency (Postman fixture)'),
    new Table({ rows: [
      new TableRow({ children: [cell('Competency'), cell('SAMPLE INTERVIEW QUESTION(S)')] }),
      new TableRow({ children: [cell('Change Leadership'), cell('• Describe a time you led a major change at work.', '• How did you handle people who resisted that change?')] }),
      new TableRow({ children: [cell('Analytical Thinking'), cell('• Tell me about a complex problem you solved with data.', '• Describe how you checked that your analysis was correct.', '• Give me an example of a mistake you found before it became serious.')] }),
    ] }),
  ]));

  // I. REGRESSION — the reported PDF: "Question N:" + "Sample Answer:" with a footer "Title <tab> Page n of 2"
  // on every page (this used to be read as a 4-row table: "Questions found: 4, Options found: 0, Valid: 0").
  write('behavioral-footer-regression.pdf', await pdf((d) => {
    for (let page = 1; page <= 2; page++) {
      if (page > 1) d.addPage();
      d.text('Behavioral Interview Questions & Sample Answers', 40, 40);
      for (let i = 1; i <= 3; i++) {
        const n = (page - 1) * 3 + i;
        d.text(`Question ${n}: Tell me about a time when you had to adapt to change at work, situation ${n}. What did you learn?`, 40, 60 + i * 70, { width: 500 });
        d.text('Sample Answer: I planned carefully, asked for help early and finished on time.', 40, 92 + i * 70, { width: 500 });
      }
      d.text('Behavioral Interview Questions & Sample Answers', 40, 780, { lineBreak: false });
      d.text(`Page ${page} of 2`, 480, 780, { lineBreak: false });
    }
  }));

  // J. Essay questions (PDF), no question marks: 3 questions.
  write('essay-questions.pdf', await pdf((d) => {
    d.fontSize(14).text('Essay Questions', 40, 40).fontSize(11);
    ['1. Explain why accurate record keeping matters in a finance company.', '[10 marks]',
      '2. Describe the steps you would take to check a customer loan application', '[10 marks]',
      '3. Discuss the advantages and disadvantages of working in a team', '[10 marks]'].forEach((l, i) => d.text(l, 40, 80 + i * 22));
  }));

  // K. Short-answer Calculation (TXT): 3 questions, one without an answer (-> Answer required, Inactive).
  write('calculation-short-answer.txt', [
    'Calculation', '',
    '1. Calculate 15 x 7.', 'Answer: 105', '',
    '2. A loan of 12,000 is repaid in 12 equal monthly payments. How much is each payment?', 'Expected Answer: 1000', '',
    '3. What is 18% of 2,500?', '',
  ].join('\n'));

  // L. Mixed sections, numbering restarts (DOCX): Calculation 2 MCQ + Essay 1; interview notes not imported.
  write('mixed-sections.docx', await word([
    P('Recruitment test (Postman fixture)'),
    P('Calculation Test'),
    P('1. What is 144 divided by 12?'), P('A. 10'), P('B. 11'), P('C. 12'), P('D. 13'), P('Answer: C'),
    P('2. What is 9 squared?'), P('A. 18'), P('B. 81'), P('C. 72'), P('D. 99'), P('Answer: B'),
    P('Essay'),
    P('1. Explain why you want to work in financial services.'),
    P('Interview notes:'),
    P('Ask about previous jobs and check the references.'),
  ]));

  // M. Duplicate inside the file (TXT): 3 questions, the third repeats the first -> 2 valid, 1 duplicate.
  write('duplicate-in-file.txt', [
    '1. What colour is a clear daytime sky?', 'A. Blue', 'B. Green', 'Answer: A', '',
    '2. How many legs does a spider have?', 'A. 6', 'B. 8', 'Answer: B', '',
    '3. What colour is a clear daytime sky?', 'A. Blue', 'B. Green', 'Answer: A', '',
  ].join('\n'));

  // N. One invalid question among valid ones (TXT): 3 found, 2 valid, 1 invalid (answer E does not exist).
  write('one-invalid.txt', [
    '1. Which month has 28 or 29 days?', 'A. January', 'B. February', 'C. March', 'Answer: B', '',
    '2. Which shape has three sides?', 'A. Square', 'B. Circle', 'C. Triangle', 'Answer: E', '',
    '3. How many hours are in a day?', 'A. 12', 'B. 24', 'C. 48', 'Answer: B', '',
  ].join('\n'));

  // O. Negative files.
  write('no-questions.txt', 'Hello team\nThis file has no questions in it.\n');
  write('empty.txt', Buffer.alloc(0));
  write('unsupported.exe', Buffer.from('MZ this is not a question file'));
  write('fake.xlsx', Buffer.from('this is plain text pretending to be a spreadsheet'));
  write('corrupt.docx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(300, 7)]));
  write('corrupt.pdf', Buffer.from('%PDF-1.4\nthis is not really a pdf\n%%EOF\n'));
  write('malformed.csv', 'Question,Option A,Option B,Answer\n"Unclosed quote question,Yes,No,A\nSecond line,1,2\n');
  const odd = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(odd, XLSX.utils.aoa_to_sheet([['Name', 'Phone'], ['A person', '020 0000 0000']]), 'People');
  write('unknown-columns.xlsx', XLSX.write(odd, { type: 'buffer', bookType: 'xlsx' }));
})();
