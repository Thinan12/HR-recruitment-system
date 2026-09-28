// Real-world documents: sections, short-answer Calculation without answers,
// essays with marking guides, interview / scoring / policy text never imported.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const docx = require('docx');
const { start, stop, client, db, upload, CANDIDATE } = require('./helpers');

let admin;
test.before(async () => { await start(); admin = client(); await admin.login(); });
test.after(stop);

// A Word file built like the LALCO recruitment exam (memo, [1] Calculation
// easy 1-10 + harder 1-10 with hints, [2] essay + marking guide, [3]
// interview + scoring, a policy table) - in Lao, like the real one.
async function recruitmentDocx({ easy = 10, hard = 10 } = {}) {
  const { Document, Packer, Paragraph, Table, TableRow, TableCell } = docx;
  const p = (t) => new Paragraph(t);
  const cell = (t) => new TableCell({ children: [p(t)] });
  const children = [
    p('ຮຽນ ທ່ານປະທານ'), p('ລາຍງານໂດຍ: HR'), p('1/ ແບບຟອມໃໝ່ສຳລັບການສອບເສັງຮັບສະໝັກພະນັກງານ'),
    p('ເງື່ອນໄຂທີ່ຈຳເປັນ, ບໍ່ໃຫ້ຄະແນນ:'),
    new Table({ rows: [new TableRow({ children: [cell('ເງື່ອນໄຂ'), cell('ພະນັກງານທຳມະດາ')] }), new TableRow({ children: [cell('ໄອຄິວ'), cell('ຫຼາຍກວ່າ 80')] })] }),
    p('ການສອບເສັງ ແລະ ການສຳພາດເພື່ອໃຫ້ຄະແນນ:'),
    p('[1] ການທົດສອບການຄິດໄລ່ (30/100 ຄະແນນ)'), p('[2] ການທົດສອບການຂຽນບົດຄວາມ (30/100 ຄະແນນ)'), p('[3] ການສໍາພາດ (40/100 ຄະແນນ)'),
    p('ຄະແນນຜ່ານແມ່ນ 70 ຄະແນນ'),
    p('[1] ມີ 6 ຄຳຖາມ, ແຕ່ລະຄຳຖາມຈະມີ 5 ຄະແນນ'),
    p('ຄຳຖາມງ່າຍໆ:'),
  ];
  for (let i = 1; i <= easy; i++) children.push(p(`${i}. ລູກຄ້າກູ້ຢືມເງິນ ${i * 10},000 ໂດລາ ເປັນເວລາ ${i + 5} ເດືອນ ໃນອັດຕາ 2.5% ຕໍ່ເດືອນ. ດອກເບ້ຍທັງໝົດແມ່ນເທົ່າໃດ?`));
  children.push(p('ຄຳຖາມທີ່ຍາກກວ່າ:'));
  for (let i = 1; i <= hard; i++) {
    children.push(p(`${i}. LALCO ໃຫ້ລູກຄ້າກູ້ຢືມເງິນ ${i},500 ໂດລາ ເປັນເວລາ 36 ເດືອນ ໃນອັດຕາ 3.5% ຕໍ່ເດືອນ.`));
    children.push(p('ຄຳຖາມ: ຈຳນວນເງິນທີ່ຈ່າຍຕໍ່ເດືອນແມ່ນເທົ່າໃດ?'));
    children.push(p('ຄຳແນະນຳ: (i) ຄິດໄລ່ເງິນຕົ້ນ (ii) ຄິດໄລ່ດອກເບ້ຍ (iii) ຜົນໄດ້ຮັບ = ເງິນຕົ້ນ + ດອກເບ້ຍ.'));
  }
  children.push(p('[2] ບໍລິສັດ LALCO ໄດ້ສ້າງຕັ້ງຂຶ້ນໃນ ປີ 2015. ເປັນຫຍັງທ່ານຈຶ່ງຢາກເຂົ້າຮ່ວມບໍລິສັດຂອງພວກເຮົາ?'),
    p('ຄຳແນະນຳ. ຄຳຕອບທີ່ຖືກຕ້ອງ 1 ຄຳຕອບຈະມີ 5 ຄະແນນ.'), p('ເງິນເດືອນ'), p('ເສັ້ນທາງອາຊີບທີ່ຊັດເຈນ'),
    p('[3] ການສໍາພາດ:'), p('ຄຳຖາມ:'), p('ອະທິບາຍໜ້າວຽກຂອງພະນັກງານການຕະຫຼາດ. ຖ້າພວກເຂົາ ບໍ່ສາມາດ ເຮັດໄດ້ => ປະຕິເສດ'), p('ສອບຖາມຂໍ້ມູນກ່ຽວກັບວຽກທີ່ຜ່ານມາຂອງເຂົາເຈົ້າ'),
    p('ການໃຫ້ຄະແນນ:'), p('ຕັ້ງແຕ່ 20-30 ຄະແນນ: ຜູ້ສະໝັກຕອບໄດ້ໄວ'), p('ຕັ້ງແຕ່ 0-10 ຄະແນນ: ຜູ້ສະໝັກເວົ້າຊ້າ'),
    p('2/ ໂຄງການທຶນການສຶກສາສຳລັບປີໃໝ່'),
    new Table({ rows: [new TableRow({ children: [cell('ປີຮຽນ'), cell('3')] }), new TableRow({ children: [cell('ທຶນຮອນ'), cell('1 MLAK/ເດືອນ')] })] }));
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}
async function wordFile(paragraphs) {
  return docx.Packer.toBuffer(new docx.Document({ sections: [{ children: paragraphs.map((t) => new docx.Paragraph(t)) }] }));
}
const preview = async (buf, name, section) => admin.post('/api/admin/questions/import/preview', null, { form: upload(buf, name, section) });

test('mixed recruitment DOCX, IQ selected: 20 short-answer Calculation + 1 Essay found, nothing as IQ, the rest not imported', async () => {
  const r = await preview(await recruitmentDocx(), 'recruitment.docx', 'IQ');
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 400));
  const p = r.data;
  const q = p.sections.filter((s) => s.kind === 'questions');
  assert.deepEqual(q.map((s) => [s.section, s.valid, s.answer_required, s.level]), [['CALCULATION', 10, 10, 'Easy'], ['CALCULATION', 10, 10, 'Hard'], ['ESSAY', 1, 0, null]]);
  assert.ok(p.sections.some((s) => s.kind === 'interview') && p.sections.some((s) => s.kind === 'scoring') && p.sections.some((s) => s.kind === 'other'));
  assert.match(p.type_mismatch, /appears to contain Calculation and Essay questions, but IQ questions is selected/);
  assert.equal(p.by_section.IQ, 0, 'nothing goes to IQ');
  assert.deepEqual([p.found, p.valid, p.invalid, p.answer_required], [21, 21, 0, 20]);

  const calc = p.rows.filter((x) => x.question.section === 'CALCULATION');
  assert.deepEqual(calc.map((x) => x.number), [...Array(10).keys(), ...Array(10).keys()].map((i) => i + 1), 'numbering restarts for the harder questions');
  assert.ok(calc.every((x) => x.answer_required && x.question.status === 'Inactive' && x.question.correct_answer === '' && x.question.marks === 5));
  assert.ok(calc.every((x) => !x.question.option_a), 'no options invented');
  assert.match(calc[0].question.question_text, /^ລູກຄ້າກູ້ຢືມເງິນ 10,000 ໂດລາ ເປັນເວລາ 6 ເດືອນ ໃນອັດຕາ 2\.5% ຕໍ່ເດືອນ/, 'Lao text and numbers kept exactly');
  assert.match(calc[10].question.question_text, /36 ເດືອນ ໃນອັດຕາ 3\.5%[\s\S]*ຄຳຖາມ: [\s\S]*ຄຳແນະນຳ: \(i\)/, 'the question line and hint stay with their question');
  assert.equal(calc[10].question.question_text.includes('ຄຳຖາມທີ່ຍາກກວ່າ'), false, 'headings are not glued to questions');
  assert.ok(calc.every((x) => x.question.lo_status === 'translated' && x.question.question_text_lo === x.question.question_text), 'a Lao source is also its Lao text');
  const essay = p.rows.find((x) => x.question.section === 'ESSAY').question;
  assert.match(essay.question_text, /ເປັນຫຍັງທ່ານຈຶ່ງຢາກເຂົ້າຮ່ວມບໍລິສັດຂອງພວກເຮົາ\?$/);
  assert.match(essay.correct_answer, /^ຄຳແນະນຳ\. ຄຳຕອບທີ່ຖືກຕ້ອງ[\s\S]*ເສັ້ນທາງອາຊີບທີ່ຊັດເຈນ$/, 'the marking guide is kept apart from the prompt (HR only)');
  const all = JSON.stringify(p.rows.map((x) => x.question.question_text));
  for (const bad of ['ການສໍາພາດ', 'ປະຕິເສດ', 'ຕັ້ງແຕ່ 20-30', 'ທຶນຮອນ', 'ຮຽນ ທ່ານປະທານ', 'ຫຼາຍກວ່າ 80', 'ແຕ່ລະຄຳຖາມຈະມີ']) assert.ok(!all.includes(bad), 'not imported: ' + bad);

  // Import as detected: 20 Inactive "answer required" + 1 Essay; the IQ bank stays empty.
  const imp = (await admin.post('/api/admin/questions/import', { questions: p.rows.map((x) => x.question) })).data;
  assert.deepEqual(imp, { imported: 21, skipped: 0, answer_required: 20 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE section = 'IQ'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE section = 'CALCULATION' AND status = 'Inactive' AND correct_answer = ''").get().n, 20);
  assert.equal((await admin.get('/api/admin/questions?status=needs_answer')).data.questions.length, 20);
  assert.equal((await admin.get('/api/admin/questions')).data.needs_answer, 20);

  // Uploading the same file again: every question is a duplicate.
  const again = (await preview(await recruitmentDocx(), 'recruitment.docx', 'CALCULATION')).data;
  assert.deepEqual([again.found, again.valid, again.duplicates], [21, 0, 21], 'nothing new to import');
});

test('a question waiting for its answer never reaches a test; entering the answer makes it usable', async () => {
  const waiting = db.prepare("SELECT * FROM questions WHERE section = 'CALCULATION' AND correct_answer = '' ORDER BY id").all();
  assert.equal((await admin.get('/api/admin/questions/counts')).data.CALCULATION, 0, 'Inactive: not counted for tests');
  assert.equal((await admin.post('/api/admin/assessments', { tests: ['CALCULATION'], counts: { CALCULATION: 1 }, link_expiry_minutes: 60 })).status, 400);
  const q = waiting[0];
  const noAnswer = await admin.put('/api/admin/questions/' + q.id, { ...q, status: 'Active' });
  assert.equal(noAnswer.status, 400);
  assert.match(noAnswer.data.error, /Correct answer is missing/);
  assert.equal((await admin.put('/api/admin/questions/' + q.id, { ...q, marks: 4, status: 'Inactive' })).status, 200, 'other edits are fine while it waits');
  const ok = await admin.put('/api/admin/questions/' + q.id, { ...q, correct_answer: '15000', status: 'Active' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.status, ok.data.correct_answer], ['Active', '15000']);
  const l = (await admin.post('/api/admin/assessments', { tests: ['CALCULATION'], counts: { CALCULATION: 1 }, link_expiry_minutes: 60, pass_marks: { CALCULATION: 0 } })).data;
  const c = client();
  const s = (await c.post(`/api/exam/${l.token}/start`, { ...CANDIDATE })).data;
  assert.equal(s.questions[0].kind, 'short');
  const done = (await c.post(`/api/exam/${l.token}/submit`, { answers: { [s.questions[0].id]: '15,000' } })).data;
  assert.equal(done.last_result.percent, 100, 'typed answer marked against the entered answer');
});

test('plain numbered file (no headings) with IQ selected: calculation-like questions are shown as Calculation, others stay IQ-strict', async () => {
  const buf = await wordFile(['1. A loan of $24,000 is repaid in 12 equal monthly amounts. How much is left after 5 months?', '2. What is 15% of 3,000?', '3. Which shape comes next?']);
  const p = (await preview(buf, 'plain.docx', 'IQ')).data;
  assert.deepEqual(p.rows.map((x) => [x.number, x.question.section, x.errors.length ? 'invalid' : x.answer_required ? 'answer required' : 'valid']),
    [[1, 'CALCULATION', 'answer required'], [2, 'CALCULATION', 'answer required'], [3, 'IQ', 'invalid']]);
  assert.match(p.rows[2].errors.join(' '), /Options are missing/, 'IQ validation is not weakened');
  assert.match(p.type_mismatch, /Calculation/);
});

test('MCQ files (Calculation, General, IQ) and essay prompts still import as before', async () => {
  const mcq = await wordFile(['1. What is 12 × 12?', 'A. 124', 'B. 144', 'C. 142', 'D. 148', 'Answer: B']);
  const calc = (await preview(mcq, 'mcq.docx', 'CALCULATION')).data;
  assert.deepEqual([calc.valid, calc.rows[0].question.correct_answer, calc.rows[0].answer_required, calc.type_mismatch], [1, 'B', false, null]);
  const gen = (await preview(await wordFile(['1. Capital of Laos?', 'A Vientiane B Luang Prabang C Pakse D Savannakhet', 'Answer: A']), 'g.docx', 'GENERAL')).data;
  assert.deepEqual([gen.valid, gen.rows[0].question.section, gen.rows[0].question.status], [1, 'GENERAL', undefined]);
  const iq = (await preview(await wordFile(['1. 2, 4, 8, ?', 'A. 10', 'B. 16', 'Answer: B', 'Level: 2']), 'iq.docx', 'IQ')).data;
  assert.deepEqual([iq.valid, iq.rows[0].question.section, iq.rows[0].question.marks], [1, 'IQ', 2]);
  const essay = (await preview(await wordFile(['Essay:', 'Why do you want to join LALCO?', 'Marking guide: 5 marks per good reason.', 'Salary', 'Career path']), 'e.docx', 'ESSAY')).data;
  assert.equal(essay.valid, 1);
  assert.equal(essay.rows[0].question.question_text, 'Why do you want to join LALCO?');
  assert.match(essay.rows[0].question.correct_answer, /^Marking guide: 5 marks per good reason\.\nSalary\nCareer path$/);
  // One bad question does not block the others.
  const mixed = (await preview(await wordFile(['1. 3 + 4 = ?', 'A. 7', 'B. 8', 'Answer: A', '2. 5 + 5 = ?', 'A. 10', 'B. 11', 'Answer: C']), 'm.docx', 'CALCULATION')).data;
  assert.deepEqual([mixed.valid, mixed.invalid], [1, 1]);
});

// The real LALCO document, when available on this machine (not committed: it holds internal HR policy).
const REAL = process.env.LALCO_SAMPLE_DOCX;
test('the real LALCO recruitment DOCX', { skip: !REAL || !fs.existsSync(REAL) ? 'set LALCO_SAMPLE_DOCX to the file to run this' : false }, async () => {
  const p = (await preview(fs.readFileSync(REAL), 'Recruitment_exam.docx', 'IQ')).data;
  const q = p.sections.filter((s) => s.kind === 'questions').map((s) => [s.section, s.valid, s.answer_required]);
  assert.deepEqual(q, [['CALCULATION', 10, 10], ['CALCULATION', 10, 10], ['ESSAY', 1, 0]]);
  assert.equal(p.by_section.IQ, 0);
  assert.match(p.type_mismatch, /Calculation and Essay/);
  assert.ok(p.rows.filter((x) => x.question.section === 'CALCULATION').every((x) => x.question.marks === 5 && x.answer_required));
  assert.match(p.rows.find((x) => x.question.section === 'ESSAY').question.correct_answer, /^ຄຳແນະນຳ\. /);
});
