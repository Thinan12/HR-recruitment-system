// ONE shared link, MANY candidates: every browser that starts gets its own
// attempt (details, questions, answers, timers, stages, results) while the
// URL stays exactly the same for everybody.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { start, stop, client, seedQuestions, db, CANDIDATE } = require('./helpers');
const { finalizeExpired } = require('../src/assessments');

let base;
let admin;
test.before(async () => {
  base = await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 40);
  seedQuestions('GENERAL', 30);
  seedQuestions('CALCULATION', 30);
  db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES ('ESSAY', 'Tell us about yourself.', 10, ?)").run(new Date().toISOString());
});
test.after(stop);

// A browser: keeps its own cookies, like a real one; can be "closed and reopened" with them.
function browser(cookies = {}) {
  const jar = { ...cookies };
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: res.status, data: await res.json().catch(() => null), setCookie: res.headers.getSetCookie() };
  }
  return { jar, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
}

const ALL = ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY'];
async function shared(tests = ALL, extra = {}) {
  const r = await admin.post('/api/admin/assessments', { tests, counts: { IQ: 10, GENERAL: 10, CALCULATION: 10, ESSAY: 1 },
    minutes: { IQ: 20, GENERAL: 20, CALCULATION: 20, ESSAY: 20 }, link_expiry_minutes: 600, title: 'September Recruitment', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
const u = (link, path = '') => `/api/exam/${link.token}${path}`;
const person = (name, phone) => ({ ...CANDIDATE, name, phone });
const attemptsOf = (link) => db.prepare('SELECT * FROM assessments WHERE link_id = ? ORDER BY id').all(link.id);
const correct = (qid) => db.prepare('SELECT correct_answer FROM assessment_questions WHERE id = ?').get(qid).correct_answer;
async function answer(b, link, state, right) {
  const answers = Object.fromEntries(state.questions.map((q, i) => [q.id, i < right ? correct(q.id) : 'Z']));
  return (await b.post(u(link, '/submit'), { answers })).data;
}

test('one link -> Candidate A, B and C each get their own session and attempt on the SAME URL', async () => {
  const link = await shared();
  const A = browser();
  const B = browser();
  const C = browser();

  let a = (await A.get(u(link))).data;
  assert.equal(a.state, 'ready');
  assert.equal(attemptsOf(link).length, 0, 'opening the link creates no record');
  a = (await A.post(u(link, '/start'), person('Candidate A', '111111'))).data;
  assert.equal(a.state, 'in_progress');
  assert.equal(a.candidate.name, 'Candidate A');
  await A.put(u(link, '/answer'), { question_id: a.questions[0].id, answer: correct(a.questions[0].id) });

  // B opens the exact same URL: a fresh, empty form; nothing of A.
  const bReady = await B.get(u(link));
  assert.equal(bReady.data.state, 'ready');
  const bText = JSON.stringify(bReady.data);
  for (const leak of ['Candidate A', '111111']) assert.ok(!bText.includes(leak), 'B sees nothing of A: ' + leak);
  assert.equal(bReady.data.candidate, undefined);
  assert.equal(bReady.data.questions, undefined, "no questions (A's or anyone's) before B starts");
  assert.equal(bReady.data.remaining_seconds, undefined, "no timer (A's) before B starts");
  let b = (await B.post(u(link, '/start'), person('Candidate B', '222222'))).data;
  assert.equal(b.candidate.name, 'Candidate B');
  await B.put(u(link, '/answer'), { question_id: b.questions[0].id, answer: 'Z' });

  const c = (await C.post(u(link, '/start'), person('Candidate C', '333333'))).data;
  assert.equal(c.candidate.name, 'Candidate C');

  const rows = attemptsOf(link);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
  assert.equal(new Set(rows.map((r) => r.candidate_id)).size, 3, 'three separate candidate records');
  assert.equal(new Set(rows.map((r) => r.session_hash)).size, 3);
  const names = rows.map((r) => db.prepare('SELECT name, phone FROM candidates WHERE id = ?').get(r.candidate_id));
  assert.deepEqual(names, [{ name: 'Candidate A', phone: '111111' }, { name: 'Candidate B', phone: '222222' }, { name: 'Candidate C', phone: '333333' }]);

  // Each browser still sees only its own attempt and answers.
  a = (await A.get(u(link))).data;
  b = (await B.get(u(link))).data;
  assert.equal(a.candidate.name, 'Candidate A');
  assert.equal(b.candidate.name, 'Candidate B');
  assert.equal(a.questions[0].answer, correct(a.questions[0].id));
  assert.equal(b.questions[0].answer, 'Z');
  assert.ok(a.questions.every((q) => !b.questions.some((x) => x.id === q.id)), 'separate question copies');
  // The session secret is never shown to page scripts and never stored in clear.
  assert.ok(Object.keys(A.jar).includes('lalco_candidate_session'));
  assert.ok(!rows.some((r) => r.session_hash === A.jar.lalco_candidate_session), 'only a hash is stored');
});

test('the session cookie is HttpOnly, SameSite=Lax, scoped to this link, and holds no personal data', async () => {
  const link = await shared(['IQ']);
  const r = await browser().get(u(link));
  const c = r.setCookie.find((x) => x.startsWith('lalco_candidate_session='));
  assert.ok(c);
  assert.match(c, /HttpOnly/i);
  assert.match(c, /SameSite=Lax/i);
  assert.match(c, new RegExp(`Path=/api/exam/${link.token}`));
  assert.ok(!/Test Candidate|020/.test(c));
});

test('refresh and close / reopen resume the same attempt: same questions, option order, answers and deadline', async () => {
  const link = await shared(['IQ', 'GENERAL']);
  const A = browser();
  const first = (await A.post(u(link, '/start'), person('Resumer', '444'))).data;
  await A.put(u(link, '/answer'), { question_id: first.questions[3].id, answer: 'C' });
  const deadline = attemptsOf(link)[0].deadline_at;

  const again = (await A.get(u(link))).data; // refresh
  const reopened = (await browser({ ...A.jar }).get(u(link))).data; // browser closed, reopened with its cookie
  for (const s of [again, reopened]) {
    assert.equal(s.state, 'in_progress');
    assert.equal(s.candidate.name, 'Resumer');
    assert.deepEqual(s.questions.map((q) => q.id), first.questions.map((q) => q.id));
    assert.deepEqual(s.questions.map((q) => q.options.map((o) => o.key).join('')), first.questions.map((q) => q.options.map((o) => o.key).join('')));
    assert.equal(s.questions[3].answer, 'C');
  }
  assert.equal(attemptsOf(link).length, 1, 'no second attempt');
  assert.equal(attemptsOf(link)[0].deadline_at, deadline, 'the timer was not reset');
});

test('double-clicking Start in one browser creates exactly one attempt', async () => {
  const link = await shared(['IQ']);
  const A = browser();
  await A.get(u(link));
  const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => A.post(u(link, '/start'), person('Double Click', '555'))));
  for (const r of [r1, r2, r3]) assert.equal(r.data.state, 'in_progress');
  assert.equal(attemptsOf(link).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE name = ?').get('Double Click').n, 1);
});

test('just opening the link (many times) creates no candidate or attempt', async () => {
  const link = await shared(['IQ']);
  const before = db.prepare('SELECT (SELECT COUNT(*) FROM candidates) c, (SELECT COUNT(*) FROM assessments) a').get();
  for (let i = 0; i < 20; i++) assert.equal((await browser().get(u(link))).data.state, 'ready');
  assert.deepEqual(db.prepare('SELECT (SELECT COUNT(*) FROM candidates) c, (SELECT COUNT(*) FROM assessments) a').get(), before);
});

test('isolation: A cannot read, answer, submit, time out or move B, and the reverse', async () => {
  const link = await shared(['IQ', 'GENERAL']);
  const A = browser();
  const B = browser();
  const a = (await A.post(u(link, '/start'), person('Iso A', '601'))).data;
  const b = (await B.post(u(link, '/start'), person('Iso B', '602'))).data;
  const [ra, rb] = attemptsOf(link);

  // Answering or submitting the other's question ids is refused / ignored.
  assert.equal((await A.put(u(link, '/answer'), { question_id: b.questions[0].id, answer: 'A' })).status, 400);
  assert.equal((await B.put(u(link, '/answer'), { question_id: a.questions[0].id, answer: 'A' })).status, 400);
  // Ownership fields sent by the browser are ignored.
  await A.put(u(link, '/answer'), { question_id: b.questions[1].id, answer: 'A', assessment_id: rb.id, candidate_id: rb.candidate_id, session_id: rb.session_hash });
  const bAnswers = () => db.prepare('SELECT answer FROM assessment_questions WHERE assessment_id = ?').all(rb.id).map((r) => r.answer);
  assert.ok(bAnswers().every((x) => x == null), "B's answers untouched");

  // A finishes IQ (with B's question ids mixed in): only A's test is submitted.
  const answersA = Object.fromEntries([...a.questions, ...b.questions].map((q) => [q.id, correct(q.id)]));
  const aDone = (await A.post(u(link, '/submit'), { answers: answersA })).data;
  assert.equal(aDone.state, 'next_test');
  assert.ok(bAnswers().every((x) => x == null), "B's answers still untouched");
  const bNow = (await B.get(u(link))).data;
  assert.equal(bNow.state, 'in_progress');
  assert.equal(bNow.section, 'IQ', "B's stage did not move");
  assert.equal(db.prepare('SELECT deadline_at FROM assessments WHERE id = ?').get(rb.id).deadline_at, rb.deadline_at, "B's timer unchanged");

  // B's time running out submits only B.
  db.prepare("UPDATE assessments SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(rb.id);
  assert.equal(finalizeExpired(), 1);
  assert.equal((await B.get(u(link))).data.state, 'submitted');
  const aNow = (await A.get(u(link))).data;
  assert.equal(aNow.state, 'next_test', 'A is unaffected');
  assert.equal(aNow.last_result.points, aNow.last_result.max, 'full marks');
  assert.equal((await A.post(u(link, '/continue'))).data.section, 'GENERAL');

  // A forged or foreign cookie is just a new visitor: it sees nobody's data.
  const forged = browser({ lalco_candidate_session: 'x'.repeat(43) });
  assert.equal((await forged.get(u(link))).data.state, 'ready');
  assert.equal((await forged.post(u(link, '/submit'), { answers: answersA })).status, 409);
  const other = await shared(['IQ']);
  assert.equal((await browser({ ...A.jar }).get(u(other))).data.state, 'ready', 'a session on one link means nothing on another');
});

test('no "Start New Candidate": the candidate page has no control to switch or create a candidate', async () => {
  // The candidate page is one script for every screen (start form, IQ, General,
  // Calculation, Essay, between tests, completion, stopped): none of it offers it.
  const page = await (await fetch(base + '/exam/some-token')).text();
  const script = await (await fetch(base + '/static/exam.js')).text();
  for (const text of [page, script]) {
    for (const bad of ['Start New Candidate', 'new-candidate', 'new_candidate', 'ເລີ່ມຜູ້ສະໝັກຄົນໃໝ່']) assert.ok(!text.includes(bad), bad);
  }
  // The server endpoint that reset a browser's session is gone.
  const link = await shared(['IQ', 'GENERAL']);
  const A = browser();
  const first = (await A.post(u(link, '/start'), person('Only Once', '901'))).data;
  const r = await A.post(u(link, '/new-candidate'));
  assert.equal(r.status, 404);
  // The same browser cannot start a second attempt: Start again resumes the first one.
  const again = (await A.post(u(link, '/start'), person('Someone Else', '902'))).data;
  assert.equal(again.state, 'in_progress');
  assert.equal(again.candidate.name, 'Only Once');
  assert.deepEqual(again.questions.map((q) => q.id), first.questions.map((q) => q.id));
  assert.equal(attemptsOf(link).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE name = 'Someone Else'").get().n, 0);
  // A new browser (no session cookie) is a new candidate, naturally.
  const B = browser();
  const ready = (await B.get(u(link))).data;
  assert.equal(ready.state, 'ready');
  assert.equal(ready.candidate, undefined);
  const b = (await B.post(u(link, '/start'), person('Second Person', '903'))).data;
  assert.equal(b.candidate.name, 'Second Person');
  assert.equal(attemptsOf(link).length, 2);
  assert.ok(b.questions.every((q) => !first.questions.some((x) => x.id === q.id)), 'own question copies');
  assert.equal((await A.get(u(link))).data.candidate.name, 'Only Once', 'A still resumes their own attempt');
});

test('five candidates at the same time on one URL: no collisions, and each can be at a different stage', async () => {
  const link = await shared();
  const plans = { A: [null], B: [8, 7], C: [9, 9, 9], D: [3], E: [10, 10, 10, 'essay'] };
  const run = async (name, plan) => {
    const b = browser();
    let s = (await b.post(u(link, '/start'), person('Concurrent ' + name, '80' + name))).data;
    for (const right of plan) {
      if (right == null) break; // stays in this test
      if (right === 'essay') { s = (await b.post(u(link, '/submit'), { answers: { [s.questions[0].id]: `Essay by ${name}` } })).data; break; }
      s = await answer(b, link, s, right);
      if (s.state !== 'next_test') break;
      s = (await b.post(u(link, '/continue'))).data;
    }
    return { name, b, s };
  };
  const results = await Promise.all(Object.entries(plans).map(([n, p]) => run(n, p)));
  const by = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(by.A.s.section, 'IQ');
  assert.equal(by.B.s.section, 'CALCULATION');
  assert.equal(by.C.s.section, 'ESSAY');
  assert.equal(by.D.s.outcome, 'stopped');
  assert.equal(by.E.s.state, 'submitted');

  const rows = attemptsOf(link);
  assert.equal(rows.length, 5);
  const detail = (await admin.get(`/api/admin/links/${link.id}`)).data;
  const row = (n) => detail.attempts.find((x) => x.candidate_name === 'Concurrent ' + n);
  assert.deepEqual(row('A').tests.map((t) => t.state), ['IN PROGRESS', 'LOCKED', 'LOCKED', 'LOCKED']);
  assert.deepEqual(row('B').tests.map((t) => [t.state, t.percent]), [['PASS', 80], ['PASS', 70], ['IN PROGRESS', null], ['LOCKED', null]]);
  assert.deepEqual(row('C').tests.map((t) => t.percent), [90, 90, 90, null]);
  assert.deepEqual(row('D').tests.map((t) => t.state), ['NOT PASS', 'LOCKED', 'LOCKED', 'LOCKED']);
  assert.equal(row('D').eligibility, 'Not Eligible');
  assert.equal(row('E').tests[3].state, 'PENDING HR MARKING');
  // Each candidate's answers are their own.
  for (const r of rows) {
    const essays = db.prepare("SELECT answer FROM assessment_questions WHERE assessment_id = ? AND section = 'ESSAY'").all(r.id);
    const cand = db.prepare('SELECT name FROM candidates WHERE id = ?').get(r.candidate_id).name;
    if (cand === 'Concurrent E') assert.equal(essays[0].answer, 'Essay by E');
    else assert.ok(essays.every((e) => e.answer == null));
  }
  // Independent randomisation: different question sets.
  const sets = rows.map((r) => db.prepare("SELECT question_id FROM assessment_questions WHERE assessment_id = ? AND section = 'IQ' ORDER BY question_id").all(r.id).map((x) => x.question_id).join());
  assert.ok(new Set(sets).size > 1, 'candidates receive different question sets');
  // Each browser still shows its own candidate.
  for (const r of results) {
    const s = (await r.b.get(u(link))).data;
    if (s.candidate) assert.equal(s.candidate.name, 'Concurrent ' + r.name);
  }
});

test('HR sees ONE link with its candidates; results and exports are one row per candidate', async () => {
  const link = await shared(['IQ', 'GENERAL']);
  for (const [n, right] of [['John HR', 10], ['Mary HR', 9], ['David HR', 2]]) {
    const b = browser();
    let s = (await b.post(u(link, '/start'), person(n, '9' + right))).data;
    s = await answer(b, link, s, right);
    if (s.state === 'next_test') { s = (await b.post(u(link, '/continue'))).data; await answer(b, link, s, right); }
  }
  const list = (await admin.get('/api/admin/assessments')).data;
  const item = list.find((x) => x.kind === 'link' && x.id === link.id);
  assert.equal(item.candidates, 3);
  assert.equal(item.title, 'September Recruitment');
  assert.equal(list.filter((x) => x.token === link.token).length, 1, 'shown once, not once per candidate');

  const detail = (await admin.get(`/api/admin/links/${link.id}`)).data;
  assert.deepEqual(detail.attempts.map((x) => [x.candidate_name, x.eligibility]).sort(),
    [['David HR', 'Not Eligible'], ['John HR', 'Eligible'], ['Mary HR', 'Eligible']]);
  assert.ok(detail.attempts.every((x) => x.started_at && x.current_stage));

  // Export all: one row per candidate, each with its own IQ result and the link name.
  const rows = XLSX.utils.sheet_to_json(XLSX.read((await admin.get('/api/admin/export/candidates.xlsx', { raw: true })).buffer).Sheets.Candidates);
  const mine = rows.filter((r) => /HR$/.test(r['Candidate Name']));
  assert.equal(mine.length, 3);
  assert.deepEqual(mine.map((r) => [r['Candidate Name'], r['IQ Test Score'], r['Assessment Link']]).sort(),
    [['David HR', '2 / 10', 'September Recruitment'], ['John HR', '10 / 10', 'September Recruitment'], ['Mary HR', '9 / 10', 'September Recruitment']]);
  // One candidate's export holds only that candidate.
  const john = detail.attempts.find((x) => x.candidate_name === 'John HR');
  const one = XLSX.utils.sheet_to_json(XLSX.read((await admin.get(`/api/admin/candidates/${john.candidate_id}/export.xlsx`, { raw: true })).buffer).Sheets.Candidates);
  assert.equal(one.length, 1);
  assert.equal(one[0]['Candidate Name'], 'John HR');

  // Session steps are recorded without personal data.
  const logs = db.prepare("SELECT * FROM audit_log WHERE action IN ('SESSION_STARTED', 'STAGE_STARTED', 'STAGE_SUBMITTED', 'ASSESSMENT_COMPLETED', 'ASSESSMENT_STOPPED')").all();
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => !/HR|Candidate|020/.test(l.details)));
});
