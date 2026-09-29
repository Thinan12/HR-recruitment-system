// Scores, levels, pass marks, stage gates, final score and company eligibility.
// Every IQ / General / Calculation question here is worth 1 mark and the essay
// 10, so answering n of 10 questions right gives exactly n x 10%.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { PDFParse } = require('pdf-parse');
const { start, stop, client, seedQuestions, db, CANDIDATE, attemptOf } = require('./helpers');
const { finalizeExpired } = require('../src/assessments');
const { percentLevel, lalcoIqScore, iqCategory } = require('../src/reports');

let admin;
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 12);
  seedQuestions('GENERAL', 12);
  seedQuestions('CALCULATION', 12);
  db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES ('ESSAY', 'Describe a problem you solved.', 10, ?)").run(new Date().toISOString());
});
test.after(stop);

const ALL = ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY'];
const url = (token, path = '') => `/api/exam/${token}${path}`;

async function link(tests, extra = {}) {
  const r = await admin.post('/api/admin/assessments', {
    tests, counts: { IQ: 10, GENERAL: 10, CALCULATION: 10, ESSAY: 1 }, minutes: { IQ: 20, GENERAL: 20, CALCULATION: 20, ESSAY: 20 }, link_expiry_minutes: 60, ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
// Answers the running test with `right` correct answers (the rest wrong) and submits it.
async function sit(c, token, state, right) {
  const rows = state.questions.map((q) => db.prepare('SELECT id, correct_answer FROM assessment_questions WHERE id = ?').get(q.id));
  const answers = Object.fromEntries(rows.map((q, i) => [q.id, i < right ? q.correct_answer : 'Z']));
  return (await c.post(url(token, '/submit'), { answers })).data;
}
// Runs a whole link. plan = right answers per test, e.g. { IQ: 8, GENERAL: 7 }; the essay is just written.
async function run(name, tests, plan, extra) {
  const c = client();
  const a = await link(tests, extra);
  let s = (await c.post(url(a.token, '/start'), { ...CANDIDATE, name })).data;
  const seen = [];
  while (s.state === 'in_progress') {
    if (s.section === 'ESSAY') s = (await c.post(url(a.token, '/submit'), { answers: { [s.questions[0].id]: 'My essay answer.' } })).data;
    else s = await sit(c, a.token, s, plan[s.section]);
    seen.push(s);
    if (s.state === 'next_test') s = (await c.post(url(a.token, '/continue'))).data;
  }
  const candidateId = db.prepare('SELECT candidate_id FROM assessments WHERE id = ?').get(attemptOf(a)).candidate_id;
  return { a, s, c, seen, candidateId };
}
const profile = async (id) => (await admin.get('/api/admin/candidates/' + id)).data.candidate;
const markEssay = async (aid, marks) => {
  const q = db.prepare("SELECT id FROM assessment_questions WHERE assessment_id = ? AND section = 'ESSAY'").get(aid);
  const r = await admin.put(`/api/admin/assessments/${aid}/essay-marks`, { marks: { [q.id]: marks } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
};
const brief = (t) => [t.section, t.score_text, t.percent, t.level, t.result, t.state];

// ---- levels and the LALCO IQ Score --------------------------------------

test('levels: 90 Exceptional, 80 Very High, 70 High, 60 Average, 50 Low, below 50 Very Low', () => {
  const cases = [[100, 'Exceptional'], [90, 'Exceptional'], [89.9, 'Very High'], [80, 'Very High'], [79.9, 'High'], [70, 'High'],
    [69.9, 'Average'], [60, 'Average'], [59.9, 'Low'], [50, 'Low'], [49.9, 'Very Low'], [0, 'Very Low']];
  for (const [p, level] of cases) assert.equal(percentLevel(p), level, String(p));
  assert.equal(percentLevel(null), null);
});

test('IQ: weighted score, percentage, LALCO IQ Score and IQ Classification are separate from PASS / NOT PASS', () => {
  // 27 / 36 = 75.0% -> LALCO 113 -> High average; passes a 70% IQ pass mark.
  assert.equal(lalcoIqScore(27, 36), 113);
  assert.equal(iqCategory(113), 'High average');
  assert.ok((27 / 36) * 100 >= 70);
  // 21 / 36 = 58.3% -> LALCO 88 -> Low average, and still NOT PASS at 70%.
  assert.equal(lalcoIqScore(21, 36), 88);
  assert.equal(iqCategory(88), 'Low average');
  assert.ok((21 / 36) * 100 < 70);
});

// ---- defaults ---------------------------------------------------------------

test('default pass marks: IQ 70%, General / Calculation / Essay 60%, final eligibility 70%', async () => {
  const s = (await admin.get('/api/admin/settings')).data;
  assert.deepEqual([s.pass_iq, s.pass_general, s.pass_calculation, s.pass_essay, s.final_eligibility], [70, 60, 60, 60, 70]);
  const a = await link(ALL);
  assert.deepEqual(a.stages.map((st) => [st.section, st.pass_mark]), [['IQ', 70], ['GENERAL', 60], ['CALCULATION', 60], ['ESSAY', 60]]);
  assert.equal(a.eligibility_mark, 70);
  // HR can set other marks on one link.
  const b = await link(['IQ', 'GENERAL'], { pass_marks: { IQ: 55, GENERAL: 65 }, eligibility_mark: 80 });
  assert.deepEqual(b.stages.map((st) => st.pass_mark), [55, 65]);
  assert.equal(b.eligibility_mark, 80);
  assert.equal((await admin.post('/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 1 }, pass_marks: { IQ: 120 } })).status, 400);
});

// ---- the full path -------------------------------------------------------------

test('all four PASS and final >= 70% -> ELIGIBLE; the same URL is used from start to end', async () => {
  const { a, c: browser, seen, candidateId } = await run('Full Pass', ALL, { IQ: 8, GENERAL: 7, CALCULATION: 9 });
  // After each passed test the candidate sees the result and the next test.
  assert.deepEqual(seen.map((s) => [s.state, s.last_result.section, s.last_result.result, s.last_result.percent, s.last_result.level]), [
    ['next_test', 'IQ', 'Pass', undefined, 'Superior'], // the candidate is not sent the IQ percentage
    ['next_test', 'GENERAL', 'Pass', 70, 'High'],
    ['next_test', 'CALCULATION', 'Pass', 90, 'Exceptional'],
    ['submitted', 'ESSAY', 'Pending', null, null],
  ]);
  assert.equal(seen[0].last_result.lalco_iq_score, 120);
  assert.equal(seen[0].next_section, 'GENERAL');
  assert.equal(db.prepare('SELECT token FROM assessment_links WHERE id = ?').get(a.id).token, a.token, 'one link, never replaced');
  assert.equal(db.prepare('SELECT link_id FROM assessments WHERE id = ?').get(attemptOf(a)).link_id, a.id);

  // Essay pending -> final eligibility pending, no final score yet.
  let c = await profile(candidateId);
  assert.equal(c.eligibility, 'Pending');
  assert.equal(c.final_percent, null);
  assert.deepEqual(brief(c.tests[3]), ['ESSAY', null, null, null, 'Pending', 'PENDING HR MARKING']);

  // HR marks the essay 6 / 10 = 60% (pass mark 60%) -> final (80 + 70 + 90 + 60) / 4 = 75.0%.
  await markEssay(attemptOf(a), 6);
  c = await profile(candidateId);
  assert.deepEqual(c.tests.map(brief), [
    ['IQ', '8 / 10', 80, 'Superior', 'Pass', 'PASS'],
    ['GENERAL', '7 / 10', 70, 'High', 'Pass', 'PASS'],
    ['CALCULATION', '9 / 10', 90, 'Exceptional', 'Pass', 'PASS'],
    ['ESSAY', '6 / 10', 60, 'Average', 'Pass', 'PASS'],
  ]);
  assert.equal(c.final_percent, 75);
  assert.equal(c.final_percent_text, '75.0%');
  assert.equal(c.final_level, 'High');
  assert.equal(c.eligibility, 'Eligible');
  assert.equal(c.final_result, 'Pending', 'HR Final Result is never set by the system');

  // HR's own decision does not change the system eligibility, and the reverse.
  await admin.put('/api/admin/candidates/' + candidateId, { ...c, final_result: 'Not Pass' });
  c = await profile(candidateId);
  assert.equal(c.final_result, 'Not Pass');
  assert.equal(c.eligibility, 'Eligible');

  // The result was shown when the last test was submitted; the finished attempt then
  // released this browser, so reopening the same URL shows the start form for the next person.
  assert.equal(seen[3].state, 'submitted');
  const again = (await browser.get(url(a.token))).data;
  assert.equal(again.state, 'ready');
  assert.equal(again.candidate, undefined, 'nothing of the finished candidate is shown');
});

test('Essay NOT PASS -> NOT ELIGIBLE, no final score', async () => {
  const { a, candidateId } = await run('Essay Fail', ALL, { IQ: 10, GENERAL: 10, CALCULATION: 10 });
  await markEssay(attemptOf(a), 5); // 50% < 60%
  const c = await profile(candidateId);
  assert.deepEqual(brief(c.tests[3]), ['ESSAY', '5 / 10', 50, 'Low', 'Not Pass', 'NOT PASS']);
  assert.equal(c.eligibility, 'Not Eligible');
  assert.equal(c.final_percent, null);
  assert.match(c.eligibility_note, /Essay Test not passed/);
});

test('all four PASS but final < 70% -> NOT ELIGIBLE', async () => {
  const { a, candidateId } = await run('Low Final', ALL, { IQ: 7, GENERAL: 6, CALCULATION: 6 });
  await markEssay(attemptOf(a), 6);
  const c = await profile(candidateId);
  assert.ok(c.tests.every((t) => t.result === 'Pass'));
  assert.equal(c.final_percent, 62.5); // (70 + 60 + 60 + 60) / 4
  assert.equal(c.final_level, 'Average');
  assert.equal(c.eligibility, 'Not Eligible');
  assert.match(c.eligibility_note, /below 70%/);
});

test('final score uses only the selected tests (IQ + General = average of 2, not 4)', async () => {
  const { candidateId } = await run('Two Tests', ['IQ', 'GENERAL'], { IQ: 8, GENERAL: 7 });
  const c = await profile(candidateId);
  assert.equal(c.tests.length, 2);
  assert.equal(c.final_percent, 75); // (80 + 70) / 2
  assert.equal(c.eligibility, 'Eligible');
});

test('a mark exactly at the pass mark passes; the IQ Level does not decide PASS', async () => {
  // 7 / 10 = 70% = IQ pass mark -> PASS. LALCO 120 = Superior.
  const pass = await run('At Mark', ['IQ'], { IQ: 7 });
  assert.equal(pass.s.last_result.result, 'Pass');
  assert.equal(pass.s.last_result.level, 'Average');
  // 6 / 10 = 60% -> NOT PASS at 70%, although LALCO 110 is "High average".
  const fail = await run('Below Mark', ['IQ'], { IQ: 6 });
  assert.equal(fail.s.last_result.result, 'Not Pass');
  assert.equal(fail.s.last_result.level, 'Average');
  // With the IQ pass mark set to 60% on the link, the same score passes.
  const custom = await run('Custom Mark', ['IQ'], { IQ: 6 }, { pass_marks: { IQ: 60 } });
  assert.equal(custom.s.last_result.result, 'Pass');
});

// ---- gates --------------------------------------------------------------------

test('IQ FAIL -> General, Calculation and Essay stay locked; refresh or changing the URL cannot bypass it', async () => {
  const { a, s, c, candidateId } = await run('IQ Fail', ALL, { IQ: 5 });
  assert.equal(s.state, 'submitted');
  assert.equal(s.outcome, 'stopped');
  assert.deepEqual(s.last_result, { section: 'IQ', result: 'Not Pass', points: 5, max: 10, level: 'Borderline', lalco_iq_score: 75, pass_mark: 70, level_lo: 'ກ້ຳເກິ່ງ' });
  assert.deepEqual(s.tests.map((t) => t.status), ['failed', 'locked', 'locked', 'locked']);

  const stoppedId = attemptOf(a);
  const before = JSON.stringify(db.prepare('SELECT * FROM assessment_stages WHERE assessment_id = ? ORDER BY position').all(stoppedId));
  // No later test can be opened or answered from this browser (the stopped attempt released it).
  for (const [method, path, body] of [['post', '/continue'], ['post', '/submit', { answers: {} }], ['put', '/answer', { question_id: 1, answer: 'A' }]]) {
    const r = await c[method](url(a.token, path), body);
    assert.equal(r.status, 409, `${method} ${path}`);
  }
  assert.equal((await c.get(url(a.token))).data.state, 'ready', 'refreshing shows the start form, never General');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM assessment_stages WHERE assessment_id = ? ORDER BY position').all(stoppedId)), before, 'the stopped attempt is unchanged');
  assert.deepEqual(db.prepare('SELECT DISTINCT section FROM assessment_questions WHERE assessment_id = ?').all(stoppedId).map((r) => r.section), ['IQ']);

  const p = await profile(candidateId);
  assert.deepEqual(p.tests.map((t) => t.state), ['NOT PASS', 'LOCKED', 'LOCKED', 'LOCKED']);
  assert.equal(p.eligibility, 'Not Eligible');
  assert.equal(p.final_percent, null, 'no final score from tests never taken');
});

test('General FAIL -> Calculation locked; Calculation FAIL -> Essay locked', async () => {
  const g = await run('General Fail', ALL, { IQ: 10, GENERAL: 5 });
  assert.deepEqual(g.s.tests.map((t) => t.status), ['done', 'failed', 'locked', 'locked']);
  assert.equal(g.s.last_result.section, 'GENERAL');
  assert.equal((await g.c.post(url(g.a.token, '/continue'))).status, 409);

  const k = await run('Calculation Fail', ALL, { IQ: 10, GENERAL: 10, CALCULATION: 5 });
  assert.deepEqual(k.s.tests.map((t) => t.status), ['done', 'done', 'failed', 'locked']);
  assert.equal((await k.c.post(url(k.a.token, '/continue'))).status, 409);
  const p = await profile(k.candidateId);
  assert.deepEqual(p.tests.map((t) => t.state), ['PASS', 'PASS', 'NOT PASS', 'LOCKED']);
  assert.equal(p.eligibility, 'Not Eligible');
});

test('IQ PASS -> General unlocks; General PASS -> Calculation unlocks; Calculation PASS -> Essay unlocks; refresh keeps it', async () => {
  const c = client();
  const a = await link(ALL);
  let s = (await c.post(url(a.token, '/start'), { ...CANDIDATE, name: 'Unlocker' })).data;
  for (const [sec, next] of [['IQ', 'GENERAL'], ['GENERAL', 'CALCULATION'], ['CALCULATION', 'ESSAY']]) {
    assert.equal(s.section, sec);
    s = await sit(c, a.token, s, 10);
    assert.equal(s.state, 'next_test');
    assert.equal(s.next_section, next);
    // A refresh (or another browser) still offers the same next test.
    const again = (await c.get(url(a.token))).data;
    assert.equal(again.state, 'next_test');
    assert.equal(again.next_section, next);
    assert.equal(again.last_result.section, sec);
    const p = await profile(db.prepare('SELECT candidate_id FROM assessments WHERE id = ?').get(attemptOf(a)).candidate_id);
    assert.equal(p.tests.find((t) => t.section === next).state, 'NOT STARTED');
    s = (await c.post(url(a.token, '/continue'))).data;
  }
  assert.equal(s.section, 'ESSAY');
});

test('a candidate cannot skip a test or change a finished one', async () => {
  const c = client();
  const a = await link(['IQ', 'GENERAL']);
  let s = (await c.post(url(a.token, '/start'), { ...CANDIDATE, name: 'No Skipping' })).data;
  const iqIds = s.questions.map((q) => q.id);
  // Continue during IQ just returns the IQ test; nothing from General is sent.
  const early = (await c.post(url(a.token, '/continue'))).data;
  assert.equal(early.section, 'IQ');
  assert.ok(early.questions.every((q) => q.section === 'IQ'));
  const cid = db.prepare('SELECT candidate_id FROM assessments WHERE id = ?').get(attemptOf(a)).candidate_id;
  assert.deepEqual((await profile(cid)).tests.map((t) => t.state), ['IN PROGRESS', 'LOCKED']);

  s = await sit(c, a.token, s, 8);
  const pointsAfter = db.prepare("SELECT points FROM assessment_stages WHERE assessment_id = ? AND section = 'IQ'").get(attemptOf(a)).points;
  s = (await c.post(url(a.token, '/continue'))).data;
  assert.equal(s.section, 'GENERAL');
  // Answers to the finished IQ test are refused, and resubmitting does not rescore it.
  assert.equal((await c.put(url(a.token, '/answer'), { question_id: iqIds[9], answer: 'A' })).status, 400);
  const right = Object.fromEntries(iqIds.map((id) => [id, db.prepare('SELECT correct_answer FROM assessment_questions WHERE id = ?').get(id).correct_answer]));
  await c.post(url(a.token, '/submit'), { answers: right });
  assert.equal(db.prepare("SELECT points FROM assessment_stages WHERE assessment_id = ? AND section = 'IQ'").get(attemptOf(a)).points, pointsAfter);
});

test('when the time runs out the test is scored: a pass unlocks the next test, a fail stops the assessment', async () => {
  const expire = (aid) => db.prepare("UPDATE assessments SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(aid);
  const answerSome = async (c, token, s, right) => {
    for (const q of s.questions.slice(0, right)) {
      const correct = db.prepare('SELECT correct_answer FROM assessment_questions WHERE id = ?').get(q.id).correct_answer;
      await c.put(url(token, '/answer'), { question_id: q.id, answer: correct });
    }
  };
  const c = client();
  const a = await link(['IQ', 'GENERAL']);
  let s = (await c.post(url(a.token, '/start'), { ...CANDIDATE, name: 'Timed Pass' })).data;
  await answerSome(c, a.token, s, 8);
  expire(attemptOf(a));
  assert.ok(finalizeExpired() >= 1);
  s = (await c.get(url(a.token))).data;
  assert.equal(s.state, 'next_test');
  assert.equal(s.auto_submitted, true);
  assert.deepEqual([s.last_result.points, s.last_result.max, s.last_result.percent, s.last_result.result], [8, 10, undefined, 'Pass']);

  const b = await link(['IQ', 'GENERAL']);
  s = (await c.post(url(b.token, '/start'), { ...CANDIDATE, name: 'Timed Fail' })).data;
  await answerSome(c, b.token, s, 3);
  expire(attemptOf(b));
  s = (await c.get(url(b.token))).data; // opening the link also finishes an expired test
  assert.equal(s.state, 'submitted');
  assert.equal(s.outcome, 'stopped');
  assert.deepEqual([s.last_result.percent, s.last_result.lalco_iq_score, s.last_result.result], [undefined, 45, 'Not Pass']);
  assert.deepEqual(s.tests.map((t) => t.status), ['failed', 'locked']);
});

// ---- dashboard, profile and exports ------------------------------------------

test('dashboard: summary counts and one row per candidate with every test and the final result', async () => {
  const d = (await admin.get('/api/admin/dashboard')).data;
  const s = d.summary;
  assert.equal(s.total, d.candidates.length);
  assert.equal(s.eligible + s.not_eligible + s.pending, s.total);
  assert.equal(s.eligible, d.candidates.filter((c) => c.eligibility === 'Eligible').length);
  assert.ok(s.eligible >= 3 && s.not_eligible >= 4);
  assert.equal(s.iq_not_passed, d.candidates.filter((c) => c.tests.find((t) => t.section === 'IQ')?.result === 'Not Pass').length);
  assert.ok(s.iq_passed >= 5 && s.iq_not_passed >= 2);
  assert.ok(s.general_not_passed >= 1 && s.calculation_not_passed >= 1);
  assert.equal(Object.values(s.iq_levels).reduce((x, y) => x + y, 0), d.candidates.filter((c) => c.tests.find((t) => t.section === 'IQ')?.level).length);
  const full = d.candidates.find((c) => c.name === 'Full Pass');
  assert.deepEqual([full.final_percent, full.final_level, full.eligibility], [75, 'High', 'Eligible']);
  assert.deepEqual(full.tests.map((t) => t.level), ['Superior', 'High', 'Exceptional', 'Average']);
});

test('exports: Excel, PDF and Word show each test, the final score, level and company eligibility', async () => {
  const c = (await admin.get('/api/admin/candidates')).data.find((x) => x.name === 'Full Pass');
  const sheet = XLSX.read((await admin.get(`/api/admin/candidates/${c.id}/export.xlsx?detail=full`, { raw: true })).buffer).Sheets.Candidates;
  const x = XLSX.utils.sheet_to_json(sheet)[0];
  const header = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0];
  assert.equal(x['IQ Level'], 'Superior');
  assert.equal(x['IQ Classification'], 'Superior');
  assert.equal(x['IQ Classification Range'], '120–129');
  assert.equal(x['LALCO IQ Score'], 120);
  assert.equal(x['IQ PASS / NOT PASS'], 'PASS');
  assert.equal(x['General %'], 70);
  assert.equal(x['General Level'], 'High');
  assert.equal(x['Calculation Status'], 'PASS');
  assert.equal(x['Essay Level'], 'Average');
  assert.equal(x['IQ Pass Mark %'], 70);
  assert.equal(x['Final %'], 75);
  assert.equal(x['Final Level'], 'High');
  assert.equal(x['Company Eligibility'], 'ELIGIBLE');
  assert.equal(x['Final Result'], 'Not Pass', 'HR Final Result kept as its own column');
  for (const col of ['Interviewer', 'Interview Score', 'Chairman Interview', 'Date Come to Work', 'Remark', 'IQ Weighted Score', 'Eligibility Note']) assert.ok(header.includes(col), col);

  const pdfBuf = (await admin.get(`/api/admin/candidates/${c.id}/export.pdf?detail=full`, { raw: true })).buffer;
  const p = new PDFParse({ data: new Uint8Array(pdfBuf) });
  const pdf = (await p.getText()).text;
  await p.destroy();
  const word = (await require('mammoth').extractRawText({ buffer: (await admin.get(`/api/admin/candidates/${c.id}/export.docx?detail=full`, { raw: true })).buffer })).value;
  for (const text of [pdf, word].map((t) => t.replace(/\s+/g, ' '))) {
    for (const want of ['Final Overall Score', '75.0%', 'Final Level', 'Company Eligibility', 'ELIGIBLE', 'HR Final Result', 'LALCO IQ 120 / 150', 'Exceptional', 'pass mark 70%']) {
      assert.ok(text.includes(want), want);
    }
  }
});

test('the review page shows each test with level and pass mark, and the final result', async () => {
  const aid = db.prepare("SELECT a.id FROM assessments a JOIN candidates c ON c.id = a.candidate_id WHERE c.name = 'Low Final'").get().id;
  const r = (await admin.get('/api/admin/assessments/' + aid)).data;
  assert.deepEqual(r.tests.map((t) => [t.section, t.percent, t.level, t.pass_mark, t.state]),
    [['IQ', 70, 'Average', 70, 'PASS'], ['GENERAL', 60, 'Average', 60, 'PASS'], ['CALCULATION', 60, 'Average', 60, 'PASS'], ['ESSAY', 60, 'Average', 60, 'PASS']]);
  assert.deepEqual([r.final.final_percent, r.final.final_level, r.final.eligibility], [62.5, 'Average', 'Not Eligible']);
});
