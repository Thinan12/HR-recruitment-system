// Lao questions: English stays the source, Lao is stored next to it, Lao
// links show only ready Lao questions, and scoring / randomisation / sessions
// are exactly as in English.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { start, stop, client, db, CANDIDATE, upload } = require('./helpers');
const lao = require('../src/lao');

let base;
let admin;
const now = () => new Date().toISOString();
const add = db.prepare(`INSERT INTO questions (section, difficulty, question_text, option_a, option_b, option_c, option_d, correct_answer, marks,
  question_text_lo, option_a_lo, option_b_lo, option_c_lo, option_d_lo, lo_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const q = (id) => db.prepare('SELECT * FROM questions WHERE id = ?').get(id);

let capital;
test.before(async () => {
  base = await start();
  admin = client();
  await admin.login();
  // 12 IQ questions with Lao (4 per level 1-3), 3 IQ without Lao, 1 needing review.
  for (let i = 1; i <= 12; i++) {
    const level = ['Easy', 'Basic', 'Moderate'][i % 3];
    add.run('IQ', level, `What number comes next? ${i}, ${i + 2}, ?`, String(i + 4), String(i + 3), String(i + 5), String(i + 6), 'A', 1,
      `ຈຳນວນໃດມາຕໍ່ໄປ? ${i}, ${i + 2}, ?`, String(i + 4), String(i + 3), String(i + 5), String(i + 6), 'translated', now());
  }
  for (let i = 1; i <= 3; i++) add.run('IQ', 'Easy', `English only question ${i}`, 'x', 'y', 'z', 'w', 'B', 1, '', '', '', '', '', '', now());
  add.run('IQ', 'Easy', 'Flagged question', 'x', 'y', 'z', 'w', 'B', 1, 'ຄຳຖາມ', 'x', 'y', 'z', 'w', 'needs_review', now());
  capital = add.run('GENERAL', '', 'What is the capital of Australia?', 'Sydney', 'Melbourne', 'Canberra', 'Perth', 'C', 1,
    'ນະຄອນຫຼວງຂອງອົດສະຕຣາລີແມ່ນເມືອງໃດ?', 'ຊິດນີ', 'ເມວເບີນ', 'ແຄນເບີຣາ', 'ເພີດ', 'reviewed', now()).lastInsertRowid;
});
test.after(stop);

function browser(jar = {}) {
  const call = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: b === undefined ? undefined : JSON.stringify(b) });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { jar, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
}
const link = async (language, counts = { IQ: 6 }) => (await admin.post('/api/admin/assessments', { tests: Object.keys(counts), counts, language, link_expiry_minutes: 60, pass_marks: { IQ: 0, GENERAL: 0 } }));
const u = (l, p = '') => `/api/exam/${l.token}${p}`;

test('saving Lao keeps the English source; the checks protect numbers, symbols, options and script', async () => {
  const id = add.run('CALCULATION', '', 'Calculate 25% of 200.', '50', '25', '75', '100', 'A', 1, '', '', '', '', '', '', now()).lastInsertRowid;
  const before = q(id);
  const save = (body) => admin.put(`/api/admin/questions/${id}/lao`, body);
  const good = { question_text_lo: 'ຄິດໄລ່ 25% ຂອງ 200.', option_a_lo: '50', option_b_lo: '25', option_c_lo: '75', option_d_lo: '100', lo_status: 'translated' };
  const bad = [
    [{ ...good, question_text_lo: 'ຄິດໄລ່ 20% ຂອງ 200.' }, /numbers in the Lao question differ/],
    [{ ...good, question_text_lo: 'ຄິດໄລ່ 25 ຂອງ 200.' }, /symbol or operator/],
    [{ ...good, option_d_lo: '' }, /Option D has no Lao text/],
    [{ ...good, option_b_lo: '52' }, /Option B: the numbers differ/],
    [{ ...good, question_text_lo: 'Calculate 25% of 200.' }, /contains no Lao text/],
    [{ ...good, question_text_lo: 'ຄິດໄລ່ 25% ຂອງ 200 <script>x</script>' }, /HTML/],
    [{ ...good, question_text_lo: '' }, /empty/],
  ];
  for (const [body, why] of bad) {
    const r = await save(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, why);
  }
  assert.equal(q(id).lo_status, '', 'nothing saved by a failed check');
  // A problem translation can still be kept as "needs review" (not used in Lao tests).
  assert.equal((await save({ ...good, option_d_lo: '', lo_status: 'needs_review' })).status, 200);
  assert.equal(q(id).lo_status, 'needs_review');
  const ok = await save(good);
  assert.equal(ok.status, 200);
  const after = q(id);
  assert.equal(after.question_text_lo, 'ຄິດໄລ່ 25% ຂອງ 200.');
  assert.equal(after.lo_status, 'translated');
  for (const k of ['question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_answer', 'marks', 'difficulty', 'section']) assert.equal(after[k], before[k], k + ' unchanged');
  assert.equal((await save({ ...good, lo_status: 'reviewed' })).data.lo_reviewed_at != null, true);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'LAO_TRANSLATION_REVIEWED'").get().n >= 1);

  // Changing the English afterwards sends the Lao back for review.
  await admin.put('/api/admin/questions/' + id, { ...after, question_text: 'Calculate 30% of 200.', status: 'Active' });
  assert.equal(q(id).lo_status, 'needs_review');
  assert.match(q(id).lo_note, /English was changed/);
});

test('counts, filters and the Lao-ready rule for Lao links', async () => {
  const bank = (await admin.get('/api/admin/questions?section=IQ')).data;
  assert.equal(bank.lao_counts.IQ.total, 16);
  assert.equal(bank.lao_counts.IQ.ready, 12);
  assert.equal(bank.lao_counts.IQ.missing, 3);
  assert.equal(bank.lao_counts.IQ.needs_review, 1);
  assert.equal(bank.lao_ready_counts.IQ, 12);
  assert.equal((await admin.get('/api/admin/questions?section=IQ&lao=none')).data.questions.length, 3);
  assert.equal((await admin.get('/api/admin/questions?section=IQ&lao=needs_review')).data.questions.length, 1);
  assert.equal((await admin.get('/api/admin/questions/counts?language=lo')).data.IQ, 12);

  const tooMany = await link('lo', { IQ: 14 });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /Only 12 IQ questions have a Lao translation ready \(4 more need Lao translation/);
  assert.equal((await link('en', { IQ: 14 })).status, 201, 'English links use the whole bank');
});

test('ONE Lao link, candidates A / B / C: own random questions, all in Lao, stable on refresh, marked the same as English', async () => {
  const l = (await link('lo')).data;
  const people = ['A', 'B', 'C'].map((k) => Object.assign(browser(), { k }));
  for (const p of people) {
    p.s = (await p.post(u(l, '/start'), { ...CANDIDATE, name: 'Lao ' + p.k })).data;
    p.ids = p.s.questions.map((x) => db.prepare('SELECT question_id FROM assessment_questions WHERE id = ?').get(x.id).question_id);
    assert.equal(p.s.questions.length, 6);
    for (const x of p.s.questions) {
      assert.match(x.text, /^ຈຳນວນໃດມາຕໍ່ໄປ\?/, 'question shown in Lao');
      assert.ok(!/What number/.test(JSON.stringify(x)), 'no English source sent');
    }
    assert.ok(p.ids.every((id) => q(id).lo_status === 'translated'), 'only Lao-ready questions');
    assert.ok(!JSON.stringify(p.s).match(/lo_status|correct_answer|question_text/), 'no translation metadata or answers sent');
  }
  assert.ok(new Set(people.map((p) => p.ids.join())).size > 1, 'different random sets');
  for (const p of people) {
    const again = (await p.get(u(l))).data;
    assert.deepEqual(again.questions.map((x) => [x.id, x.text, x.options.map((o) => o.key + o.text).join()]), p.s.questions.map((x) => [x.id, x.text, x.options.map((o) => o.key + o.text).join()]),
      'refresh: same Lao questions, order and option order');
  }
  // HR edits a Lao text now: the candidate who already started keeps what they were given.
  const first = people[0].ids[0];
  db.prepare("UPDATE questions SET question_text_lo = 'ປ່ຽນແລ້ວ 1' WHERE id = ?").run(first);
  assert.equal((await people[0].get(u(l))).data.questions[0].text, people[0].s.questions[0].text);
  // Answer by option key (A is correct for every one of these): full marks, IQ marks by level.
  const done = (await people[0].post(u(l, '/submit'), { answers: Object.fromEntries(people[0].s.questions.map((x) => [x.id, 'A'])) })).data;
  assert.equal(done.last_result.percent, 100);
  const aid = db.prepare("SELECT id FROM assessments WHERE link_id = ? AND candidate_id = (SELECT id FROM candidates WHERE name = 'Lao A')").get(l.id).id;
  const copies = db.prepare('SELECT max_marks, difficulty, display_language FROM assessment_questions WHERE assessment_id = ?').all(aid);
  assert.ok(copies.every((c) => c.display_language === 'lo'));
  assert.deepEqual(copies.map((c) => c.max_marks), copies.map((c) => ({ Easy: 1, Basic: 2, Moderate: 3 })[c.difficulty]), 'marks follow the level, as in English');
  // B cannot touch A's answers.
  assert.equal((await people[1].put(u(l, '/answer'), { question_id: people[0].s.questions[1].id, answer: 'B' })).status, 400);
  // Export shows the language used.
  const cid = db.prepare("SELECT id FROM candidates WHERE name = 'Lao A'").get().id;
  const x = XLSX.utils.sheet_to_json(XLSX.read((await admin.get(`/api/admin/candidates/${cid}/export.xlsx`, { raw: true })).buffer).Sheets.Candidates)[0];
  assert.equal(x['Assessment Language'], 'Lao');
  const review = (await admin.get('/api/admin/assessments/' + aid)).data.questions;
  assert.ok(review.every((r) => r.question_text && r.question_text_lo), 'HR sees English and Lao side by side');
});

test('the same questions on an English link are shown in English, with Lao options mapped to the same letters', async () => {
  const en = (await link('en', { GENERAL: 1 })).data;
  const s = (await browser().post(u(en, '/start'), { ...CANDIDATE, name: 'English One' })).data;
  assert.equal(s.questions[0].text, 'What is the capital of Australia?');
  assert.deepEqual(s.questions[0].options.map((o) => o.key).sort(), ['A', 'B', 'C', 'D']);
  const lo = (await link('lo', { GENERAL: 1 })).data;
  const t = (await browser().post(u(lo, '/start'), { ...CANDIDATE, name: 'Lao One' })).data;
  assert.equal(t.questions[0].text, 'ນະຄອນຫຼວງຂອງອົດສະຕຣາລີແມ່ນເມືອງໃດ?');
  const c = t.questions[0].options.find((o) => o.key === 'C');
  assert.equal(c.text, 'ແຄນເບີຣາ', 'C is still Canberra');
  // Answer C in the Lao test: correct.
  const lao2 = browser();
  const s2 = (await lao2.post(u(lo, '/start'), { ...CANDIDATE, name: 'Lao Three' })).data;
  const r = (await lao2.post(u(lo, '/submit'), { answers: { [s2.questions[0].id]: 'C' } })).data;
  assert.equal(r.last_result.percent, 100);
  assert.equal(q(capital).correct_answer, 'C');
});

test('an import file may carry Lao columns; they are checked and stored next to the English', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Question', 'Option A', 'Option B', 'Correct Answer', 'Type', 'Question (Lao)', 'Option A (Lao)', 'Option B (Lao)'],
    ['Which is bigger, 7 or 9?', '7', '9', 'B', 'General', 'ຕົວເລກໃດໃຫຍ່ກວ່າ, 7 ຫຼື 9?', '7', '9'],
    ['Which is smaller, 3 or 5?', '3', '5', 'A', 'General', 'ຕົວເລກໃດນ້ອຍກວ່າ, 3 ຫຼື 6?', '3', '5'],
    ['Pick the colour of the sky.', 'Blue', 'Green', 'A', 'General', '', '', ''],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Questions');
  const preview = (await admin.post('/api/admin/questions/import/preview', null, { form: upload(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'lao.xlsx', 'GENERAL') })).data;
  assert.equal(preview.valid, 3);
  const rows = preview.rows.map((r) => r.question);
  assert.equal(rows[0].lo_status, 'translated');
  assert.equal(rows[1].lo_status, 'needs_review', 'a changed number is caught');
  assert.match(rows[1].lo_note, /numbers/);
  assert.equal(rows[2].lo_status, undefined, 'no Lao in the file: English only');
  const imp = (await admin.post('/api/admin/questions/import', { questions: rows })).data;
  assert.equal(imp.imported, 3);
  const saved = db.prepare("SELECT question_text, question_text_lo, lo_status FROM questions WHERE question_text LIKE 'Which is %' OR question_text LIKE 'Pick the colour%' ORDER BY id").all();
  assert.deepEqual(saved.map((r) => r.lo_status), ['translated', 'needs_review', '']);
  assert.equal(saved[0].question_text, 'Which is bigger, 7 or 9?');
});

test('Translate Missing Lao: only questions without Lao, in batches, each result checked; nothing during an exam', async () => {
  lao.setProvider(null);
  const none = await admin.post('/api/admin/questions/translate-missing');
  assert.equal(none.status, 400);
  assert.match(none.data.error, /No automatic translation service/);

  const seen = [];
  lao.setProvider(async (items) => {
    seen.push(items.length);
    return items.map((it) => ({
      id: it.id,
      // One answer breaks a number on purpose -> Translation failed, never "ready".
      question: /English only question 2/.test(it.question) ? 'ຄຳຖາມ 99' : 'ຄຳແປ: ' + it.question.replace(/[A-Za-z]+/g, 'ລາວ'),
      options: it.options, flag: /English only question 3/.test(it.question) ? 'Source looks unclear' : '',
    }));
  });
  const missingBefore = db.prepare("SELECT COUNT(*) AS n FROM questions WHERE lo_status IN ('', 'failed')").get().n;
  const readyBefore = db.prepare("SELECT id, question_text_lo FROM questions WHERE lo_status IN ('translated', 'reviewed')").all();
  const r = await admin.post('/api/admin/questions/translate-missing');
  assert.equal(r.status, 200);
  for (let i = 0; i < 50 && lao.job.running; i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(lao.job.running, false);
  assert.equal(lao.job.total, missingBefore);
  assert.ok(seen.every((n) => n <= 10), 'batches of at most 10');
  assert.equal(q(db.prepare("SELECT id FROM questions WHERE question_text = 'English only question 1'").get().id).lo_status, 'translated');
  const failed = q(db.prepare("SELECT id FROM questions WHERE question_text = 'English only question 2'").get().id);
  assert.equal(failed.lo_status, 'failed');
  assert.match(failed.lo_note, /numbers/);
  const flagged = q(db.prepare("SELECT id FROM questions WHERE question_text = 'English only question 3'").get().id);
  assert.equal(flagged.lo_status, 'needs_review');
  assert.match(flagged.lo_note, /Source Question Review Required/);
  // Existing translations were not touched.
  for (const row of readyBefore) assert.equal(q(row.id).question_text_lo, row.question_text_lo);
  // A candidate on a Lao link never waits for the service.
  lao.setProvider(async () => { throw new Error('must not be called during an exam'); });
  const l = (await link('lo', { IQ: 3 })).data;
  const s = (await browser().post(u(l, '/start'), { ...CANDIDATE, name: 'No Service Needed' })).data;
  assert.equal(s.state, 'in_progress');
  lao.setProvider(null);
});
