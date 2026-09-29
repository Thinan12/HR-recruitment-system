// Unnumbered bullet questions: behavioural interview questions grouped by
// competency (a two-column table in PDF / Word, or plain text). No numbers,
// no options, no answers, question marks optional.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const docx = require('docx');
const PDFDocument = require('pdfkit');
const { start, stop, client, db, upload, CANDIDATE } = require('./helpers');

let admin;
test.before(async () => { await start(); admin = client(); await admin.login(); });
test.after(stop);

const preview = async (buf, name, section = 'GENERAL') => admin.post('/api/admin/questions/import/preview', null, { form: upload(buf, name, section) });
const texts = (p) => p.rows.map((r) => r.question.question_text);
const count = (sql) => db.prepare(sql).get().n;

// A two-page competency table like "Sample Behavioural Questions by Competency":
// running title + table header + footer + page number on every page, the
// competency in the left column (wrapped over two lines), bullets on the
// right (wrapped), a sub-heading inside the questions column, and the last
// bullet of page 1 continued on page 2.
function competencyPdf() {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(10);
    const t = (s, x, y) => doc.text(s, x, y, { lineBreak: false });
    const b = (s, y) => { t('•', 160, y); t(s, 178, y); };
    const frame = (n) => {
      t('Sample Behavioural Questions by Competency', 250, 40);
      t('Competency', 72, 70); t('SAMPLE INTERVIEW QUESTION(S)', 250, 70);
      t('Brought to you by the Test Service Agency', 70, 780); t(String(n), 534, 790);
    };
    frame(1);
    t('Competencies that support LEADING PEOPLE', 72, 95);
    t('Change', 80, 140); t('Leadership', 80, 152);
    b('Please tell us about a time when you led a significant change in your organization and', 120);
    t('how you helped others to deal with the change.', 178, 132);
    b('Tell me about a time when you had to help others deal with change.', 146);
    b('Describe a situation when you had to adjust quickly to changes over which you had', 160);
    t('no control. What was the impact of the change on you?', 178, 172);
    t('Problem', 80, 222); t('Solving /', 80, 234); t('Judgement', 80, 246);
    b('Give me an example of a time you had to make an important decision. How did you', 200);
    t('make the decision?', 178, 212);
    t('Catching problems early', 160, 232);
    b('Tell me about a time you identified a potential problem and resolved it before the', 250);
    doc.addPage({ size: 'A4', margin: 0 });
    frame(2);
    t('situation became serious.', 178, 100);
    t('Self Control', 72, 150);
    b('Describe a time when you were faced with problems or stresses that tested your coping skills.', 120);
    b('Tell me about a difficult situation when it was desirable for you to keep a positive attitude.', 134);
    b('Tell me about a time when you had to help others deal with change.', 148);
    b('a difficult situation you anticipated, the action you took and the outcome.', 162);
    doc.end();
  });
}

test('a multiple-choice type renamed "Behavioral Assessment" is not used for option-less interview questions', async () => {
  const general = (await admin.get('/api/admin/test-types')).data.find((t) => t.key === 'GENERAL');
  assert.equal((await admin.put('/api/admin/test-types/GENERAL', { ...general, name: 'Behavioral Assessment' })).status, 200);
  try {
    const txt = ['Leadership', '• Tell me about a time when you led a team.', '• Describe a time when you motivated others.', '• Give me an example of a hard decision you made.'].join('\n');
    const r = await preview(Buffer.from(txt), 'i.txt', 'GENERAL');
    assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
    assert.deepEqual(r.data.type_decisions.map((d) => [d.name, d.behavior, d.count]), [['Behavioral Interview Test', 'interview', 3]]);
    assert.match(r.data.document.note, /"Behavioral Assessment" is a multiple-choice test type/);
    assert.ok(r.data.rows.every((x) => !x.question.section));
  } finally {
    await admin.put('/api/admin/test-types/GENERAL', { ...general });
  }
});

test('two-column competency PDF: bullet questions under their competency; titles, headers, footers, page numbers not imported', async () => {
  const iqBefore = count("SELECT COUNT(*) AS n FROM questions WHERE section = 'IQ'");
  const r = await preview(await competencyPdf(), 'competencies.pdf', 'IQ');
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 500));
  const p = r.data;
  assert.equal(p.document.type, 'Behavioral Interview Question Bank');
  assert.equal(p.document.structure, 'Bullet questions grouped by competency');
  assert.equal(p.document.detected_type, 'Behavioral Interview Test');
  assert.deepEqual(p.document.categories, [{ name: 'Change Leadership', questions: 3 }, { name: 'Problem Solving / Judgement', questions: 2 }, { name: 'Self Control', questions: 4 }]);
  assert.deepEqual(p.rows.map((x) => [x.question.category, x.question.question_text]), [
    ['Change Leadership', 'Please tell us about a time when you led a significant change in your organization and how you helped others to deal with the change.'],
    ['Change Leadership', 'Tell me about a time when you had to help others deal with change.'],
    ['Change Leadership', 'Describe a situation when you had to adjust quickly to changes over which you had no control. What was the impact of the change on you?'],
    ['Problem Solving / Judgement', 'Give me an example of a time you had to make an important decision. How did you make the decision?'],
    // continued across the page break, sub-heading not glued on
    ['Problem Solving / Judgement', 'Tell me about a time you identified a potential problem and resolved it before the situation became serious.'],
    ['Self Control', 'Describe a time when you were faced with problems or stresses that tested your coping skills.'],
    ['Self Control', 'Tell me about a difficult situation when it was desirable for you to keep a positive attitude.'],
    ['Self Control', 'Tell me about a time when you had to help others deal with change.'],
    ['Self Control', 'a difficult situation you anticipated, the action you took and the outcome.'],
  ]);
  const all = texts(p).join('\n');
  for (const bad of ['Sample Behavioural', 'SAMPLE INTERVIEW', 'Competencies that support', 'Brought to you', 'Catching problems early', 'Competency']) assert.ok(!all.includes(bad), 'not imported: ' + bad);
  // No options, no answers needed; no test type yet -> HR decides (detected: Behavioral Interview Test).
  assert.ok(p.rows.every((x) => !x.question.option_a && !x.question.correct_answer));
  assert.deepEqual(p.type_decisions.map((d) => [d.name, d.behavior, d.count]), [['Behavioral Interview Test', 'interview', 8]]);
  assert.equal(p.duplicates, 1, 'the repeated question is a duplicate');
  assert.equal(p.needs_review, 1);
  const review = p.rows.find((x) => x.review);
  assert.equal(review.confidence, 'Medium');
  assert.match(review.review, /lower case/);
  assert.ok(p.rows.filter((x) => !x.review).every((x) => x.confidence === 'High'));
  assert.equal(p.by_section.IQ, 0, 'nothing goes to IQ even with IQ selected');

  // Import: create the Behavioral Interview Test type; its categories come from the document.
  const pending = p.rows.filter((x) => x.errors.length === 1 && /^Test Type "/.test(x.errors[0]));
  assert.equal(pending.length, 8, 'waiting for the type decision (the duplicate is not)');
  assert.deepEqual(p.rows.find((x) => /Duplicate/.test(x.errors.join(' '))).errors.length, 1, 'a duplicate shows only the duplicate message');
  const chosen = pending.filter((x) => !x.review).map((x) => x.question);
  const imp = await admin.post('/api/admin/questions/import', { questions: chosen, type_decisions: { 'behavioral interview test': { create: true, behavior: 'interview' } } });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.deepEqual(imp.data, { imported: 7, skipped: 0 });
  const type = (await admin.get('/api/admin/test-types')).data.find((x) => x.name === 'Behavioral Interview Test');
  assert.equal(type.behavior, 'interview');
  const bank = (await admin.get('/api/admin/questions?section=' + type.key)).data.questions;
  assert.equal(bank.length, 7);
  assert.ok(bank.every((q) => q.status === 'Active' && q.category_id), 'Active (HR marks the answers) and in a category');
  assert.deepEqual([...new Set(bank.map((q) => q.category))].sort(), ['Change Leadership', 'Problem Solving / Judgement', 'Self Control']);
  assert.equal(count(`SELECT COUNT(*) AS n FROM question_categories WHERE section = '${type.key}'`), 3, 'one category per competency');
  assert.equal(count("SELECT COUNT(*) AS n FROM questions WHERE section = 'IQ'"), iqBefore, 'IQ bank untouched');

  // Same file again: the managed type is used automatically, everything is a duplicate.
  const again = (await preview(await competencyPdf(), 'competencies.pdf', 'GENERAL')).data;
  assert.deepEqual(again.type_decisions, []);
  assert.ok(again.rows.every((x) => x.question.section === type.key));
  assert.equal(again.valid, 1, 'only the needs-review question is new');
  assert.equal(again.duplicates, 8);

  // Candidates answer in writing; HR marks.
  const l = (await admin.post('/api/admin/assessments', { tests: [type.key], counts: { [type.key]: 2 }, link_expiry_minutes: 60 })).data;
  const s = (await client().post(`/api/exam/${l.token}/start`, { ...CANDIDATE })).data;
  assert.equal(s.questions.length, 2);
  assert.ok(s.questions.every((q) => q.kind === 'essay' && !('correct_answer' in q)));
});

test('plain text: bullets under headings, no question marks, multi-sentence, wrapped lines; a question without a bullet', async () => {
  const txt = [
    'Interview Questions', '',
    'Leadership',
    '• Tell me about a time when you led a team through a difficult period',
    '  and what you learned from it.',
    '• Describe a time when you motivated others. What was the result? How did the team react?',
    '- Give me an example of how you handled conflict',
    'Teamwork:',
    '* Recount a time you helped a colleague who was struggling.',
    '• Discuss a project where the team disagreed with your ideas.',
    'Explain how you would build trust in a new team.',
    'Page 2',
  ].join('\n');
  const p = (await preview(Buffer.from(txt), 'interview.txt', 'ESSAY')).data;
  assert.deepEqual(p.rows.map((x) => [x.question.category, x.question.question_text]), [
    ['Leadership', 'Tell me about a time when you led a team through a difficult period and what you learned from it.'],
    ['Leadership', 'Describe a time when you motivated others. What was the result? How did the team react?'],
    ['Leadership', 'Give me an example of how you handled conflict'],
    ['Teamwork', 'Recount a time you helped a colleague who was struggling.'],
    ['Teamwork', 'Discuss a project where the team disagreed with your ideas. Explain how you would build trust in a new team.'],
  ]);
  const bi = (await admin.get('/api/admin/test-types')).data.find((x) => x.name === 'Behavioral Interview Test').key;
  assert.ok(p.rows.every((x) => x.question.section === bi && x.errors.length === 0), 'the interview type, not Essay');
});

test('Word competency table with bullet lists; an existing Interview type is used automatically', async () => {
  const bi = (await admin.get('/api/admin/test-types')).data.find((x) => x.name === 'Behavioral Interview Test').key;
  await admin.post(`/api/admin/test-types/${bi}/deactivate`);
  const made = await admin.post('/api/admin/test-types', { name: 'Interview', behavior: 'interview' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const key = made.data.key;
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, LevelFormat, AlignmentType } = docx;
  const li = (text) => new Paragraph({ text, numbering: { reference: 'dots', level: 0 } });
  const row = (name, qs) => new TableRow({ children: [new TableCell({ children: [new Paragraph(name)] }), new TableCell({ children: qs.map(li) })] });
  const buf = await Packer.toBuffer(new Document({
    numbering: { config: [{ reference: 'dots', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT }] }] },
    sections: [{ children: [
      new Paragraph('Company interview guide 2026'),
      new Table({ rows: [
        new TableRow({ children: [new TableCell({ children: [new Paragraph('Competency')] }), new TableCell({ children: [new Paragraph('Sample interview questions')] })] }),
        row('Customer Focus', ['Tell me about a time you went out of your way for a customer.', 'Describe a time you exceeded the expectations of a client.']),
        row('Integrity', ['Tell me about a time when you were honest and it was difficult to do so.', 'Discuss a time when your integrity was challenged. How did you handle it?']),
      ] }),
    ] }],
  }));
  const p = (await preview(buf, 'guide.docx', 'GENERAL')).data;
  assert.deepEqual(p.rows.map((x) => [x.question.section, x.question.category, x.question.question_text.slice(0, 30)]), [
    [key, 'Customer Focus', 'Tell me about a time you went '],
    [key, 'Customer Focus', 'Describe a time you exceeded t'],
    [key, 'Integrity', 'Tell me about a time when you '],
    [key, 'Integrity', 'Discuss a time when your integ'],
  ]);
  assert.equal(p.valid, 4);
  assert.deepEqual(p.category_decisions.map((d) => d.name).sort(), ['Customer Focus', 'Integrity'], 'new categories are offered to create');
});

test('Lao bullet questions', async () => {
  const txt = ['ພາວະຜູ້ນຳ', '• ເລົ່າໃຫ້ຟັງກ່ຽວກັບຄັ້ງໜຶ່ງທີ່ທ່ານໄດ້ນຳພາທີມງານໃນສະຖານະການທີ່ຫຍຸ້ງຍາກ.',
    '• ອະທິບາຍສະຖານະການທີ່ທ່ານຕ້ອງແກ້ໄຂບັນຫາກັບລູກຄ້າ. ທ່ານໄດ້ເຮັດແນວໃດ?', '• ຍົກຕົວຢ່າງຄັ້ງໜຶ່ງທີ່ທ່ານໄດ້ຊ່ວຍເພື່ອນຮ່ວມງານ.'].join('\n');
  const p = (await preview(Buffer.from(txt), 'lao.txt', 'GENERAL')).data;
  assert.equal(p.rows.length, 3);
  assert.ok(p.rows.every((x) => x.question.category === 'ພາວະຜູ້ນຳ' && x.question.section && x.errors.length === 0));
  assert.ok(p.rows.every((x) => x.question.lo_status === 'translated'), 'Lao source is its Lao text');
});

test('numbered and multiple-choice files are not read as bullets', async () => {
  const mcq = ['Instructions:', '• Answer all questions.', '• You have 30 minutes.', '• Choose one answer only.',
    '1. Capital of Laos?', 'A. Vientiane', 'B. Pakse', 'Answer: A', '2. 2 + 2 = ?', 'A. 3', 'B. 4', 'Answer: B'].join('\n');
  const p = (await preview(Buffer.from(mcq), 'mcq.txt', 'GENERAL')).data;
  assert.equal(p.document, null);
  assert.deepEqual(p.rows.map((x) => x.number), [1, 2]);
  const short = (await preview(Buffer.from('1. What is 15% of 3,000?\n2. A loan of $1,200 over 12 months: how much per month?'), 's.txt', 'CALCULATION')).data;
  assert.deepEqual([short.document, short.valid, short.answer_required], [null, 2, 2]);
});

// The real behavioural PDF, when available on this machine (not committed).
const REAL = process.env.LALCO_BEHAVIOURAL_PDF;
test('the real sample behavioural interview PDF', { skip: !REAL || !fs.existsSync(REAL) ? 'set LALCO_BEHAVIOURAL_PDF to the file to run this' : false }, async () => {
  const p = (await preview(fs.readFileSync(REAL), 'sample.pdf', 'GENERAL')).data;
  assert.equal(p.found, 224);
  assert.equal(p.document.categories.length, 43);
  assert.equal(p.document.categories[0].name, 'Change Leadership');
  assert.ok(p.document.categories.some((c) => c.name === 'Strategic Orientation'));
  const all = texts(p).join('\n');
  assert.ok(!/Brought to you|Sample Behavioural|SAMPLE INTERVIEW|Competencies that support/.test(all));
  assert.ok(texts(p).includes('Tell me about a time you recognized a problem before your boss or others in the organization did.'), 'joined across the page break');
});
