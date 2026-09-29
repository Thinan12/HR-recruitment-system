// Regression tests for the audit's confirmed bugs: one browser used by several
// people in turn, an active attempt that cannot be taken over, the Behavioral
// Interview Test report column, empty later tests, the internal Excel search,
// fixed link expiry, admin logout / password change, .xls import and secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');
const { start, stop, client, upload, seedQuestions, db, CANDIDATE } = require('./helpers');

let admin;
let base;
let BEH;
test.before(async () => {
  base = await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 30, 1, 'Easy');
  seedQuestions('GENERAL', 30);
  BEH = (await admin.post('/api/admin/test-types', { name: 'Behavioral Interview Test', behavior: 'interview' })).data.key;
  for (let i = 1; i <= 6; i++) db.prepare('INSERT INTO questions (section, question_text, marks, created_at) VALUES (?, ?, 10, ?)').run(BEH, `Tell me about a time ${i}.`, new Date().toISOString());
});
test.after(stop);

const person = (name, phone) => ({ ...CANDIDATE, name, phone });
const exam = (api, token, path = '') => `/api/${api}/${token}${path}`;
const attempts = (link) => db.prepare('SELECT * FROM assessments WHERE link_id = ? ORDER BY id').all(link.id);
const answersFor = (s) => Object.fromEntries(s.questions.map((q) => {
  const row = db.prepare('SELECT section, correct_answer FROM assessment_questions WHERE id = ?').get(q.id);
  return [q.id, row.section === BEH ? 'My own answer.' : row.correct_answer];
}));
// Takes every test of the attempt this browser holds, to the end.
async function finish(c, api, token, s) {
  while (s.state === 'in_progress') {
    s = (await c.post(exam(api, token, '/submit'), { answers: answersFor(s) })).data;
    if (s.state === 'next_test') s = (await c.post(exam(api, token, '/continue'))).data;
  }
  return s;
}
const sessionCookie = (res, name) => { const m = new RegExp(name + '=([^;]+)').exec(res.headers.get('set-cookie') || ''); return m && m[1]; };

// ---- BUG-1: one browser, candidates A, B and C in turn --------------------------

test('BUG-1 recruitment: A, B and C on the same browser and URL each get their own session, attempt, snapshot and result', async () => {
  const link = (await admin.post('/api/admin/assessments', { tests: ['IQ', 'GENERAL'], counts: { IQ: 5, GENERAL: 3 }, link_expiry_minutes: 60, pass_marks: { IQ: 0, GENERAL: 0 } })).data;
  const browser = client(); // ONE cookie jar for all three people
  const seen = [];
  for (const [name, phone] of [['POSTMAN TEST A', '020 1000 0001'], ['POSTMAN TEST B', '020 1000 0002'], ['POSTMAN TEST C', '020 1000 0003']]) {
    const open = (await browser.get(exam('exam', link.token))).data;
    assert.equal(open.state, 'ready', name + ' sees the start form, not the previous result');
    assert.equal(open.candidate, undefined, 'nothing of the previous person is shown');
    const s = (await browser.post(exam('exam', link.token, '/start'), person(name, phone))).data;
    assert.deepEqual([s.state, s.candidate.name], ['in_progress', name]);
    const done = await finish(browser, 'exam', link.token, s);
    assert.equal(done.state, 'submitted', 'the result is shown at once');
    assert.equal(done.outcome, 'completed');
    seen.push(done);
  }
  const rows = attempts(link);
  assert.equal(rows.length, 3, 'three attempts on one link');
  assert.equal(new Set(rows.map((r) => r.session_hash)).size, 3, 'three different sessions');
  assert.equal(new Set(rows.map((r) => r.candidate_id)).size, 3, 'three candidates');
  assert.ok(rows.every((r) => r.status === 'SUBMITTED' && r.result === 'Pass'));
  const snap = rows.map((r) => db.prepare('SELECT id FROM assessment_questions WHERE assessment_id = ?').all(r.id).map((x) => x.id));
  assert.ok(snap.every((ids) => ids.length === 8), 'each has its own 8 question copies');
  assert.equal(new Set(snap.flat()).size, 24, 'no shared snapshot rows');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessment_links WHERE id = ?').get(link.id).n, 1, 'still one link');
});

test('BUG-1 internal staff: A, B and C on the same browser, own attempts and staff records', async () => {
  const link = (await admin.post('/api/admin/internal/links', { title: 'POSTMAN TEST ABC', tests: ['IQ'], counts: { IQ: 4 }, pass_marks: { IQ: 0 }, link_expiry_minutes: 60 })).data;
  const browser = client();
  for (const id of ['PT-A', 'PT-B', 'PT-C']) {
    assert.equal((await browser.get(exam('internal-exam', link.token))).data.state, 'ready');
    const s = (await browser.post(exam('internal-exam', link.token, '/start'), { name: 'POSTMAN TEST ' + id, employee_id: id, department: 'QA' })).data;
    assert.equal(s.state, 'in_progress', id);
    assert.equal((await finish(browser, 'internal-exam', link.token, s)).state, 'submitted');
  }
  const rows = attempts(link);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.session_hash)).size, 3);
  assert.equal(new Set(rows.map((r) => r.staff_id)).size, 3);
  assert.ok(rows.every((r) => r.business_area === 'INTERNAL_STAFF' && r.candidate_id == null));
});

test('BUG-1 the session only rotates when the attempt has finished', async () => {
  const link = (await admin.post('/api/admin/assessments', { tests: ['IQ', 'GENERAL'], counts: { IQ: 3, GENERAL: 2 }, link_expiry_minutes: 60, pass_marks: { IQ: 0, GENERAL: 0 } })).data;
  const opened = await fetch(base + exam('exam', link.token));
  const cookie = 'lalco_candidate_session=' + sessionCookie(opened, 'lalco_candidate_session');
  const call = (method, path, body) => fetch(base + exam('exam', link.token, path), { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  let r = await call('POST', '/start', person('POSTMAN TEST Rotate', '020 1000 0009'));
  assert.equal(sessionCookie(r, 'lalco_candidate_session'), null, 'start keeps the session');
  let s = await r.json();
  r = await call('POST', '/submit', { answers: answersFor(s) });
  s = await r.json();
  assert.equal(s.state, 'next_test');
  assert.equal(sessionCookie(r, 'lalco_candidate_session'), null, 'between tests: same session');
  r = await call('GET', '');
  assert.equal(sessionCookie(r, 'lalco_candidate_session'), null, 'refresh between tests: same session');
  s = await (await call('POST', '/continue')).json();
  r = await call('POST', '/submit', { answers: answersFor(s) });
  assert.equal((await r.json()).state, 'submitted');
  const fresh = sessionCookie(r, 'lalco_candidate_session');
  assert.ok(fresh && `lalco_candidate_session=${fresh}` !== cookie, 'the finished attempt gives the browser a new session');
});

// ---- BUG-2: no takeover of an active attempt -------------------------------------

test('BUG-2 recruitment: while A is active, B is refused on that browser without seeing anything of A; A resumes', async () => {
  const link = (await admin.post('/api/admin/assessments', { tests: ['IQ', 'GENERAL'], counts: { IQ: 3, GENERAL: 2 }, link_expiry_minutes: 60, pass_marks: { IQ: 0, GENERAL: 0 } })).data;
  const browser = client();
  const a = (await browser.post(exam('exam', link.token, '/start'), person('POSTMAN TEST Active A', '020 2000 0001'))).data;
  await browser.put(exam('exam', link.token, '/answer'), { question_id: a.questions[0].id, answer: 'A' });
  const b = await browser.post(exam('exam', link.token, '/start'), person('POSTMAN TEST Intruder B', '020 2000 0002'));
  assert.equal(b.status, 409);
  assert.deepEqual(b.data, { error: 'assessment_in_progress' });
  for (const leak of ['Active A', '2000 0001', 'questions', 'answers']) assert.ok(!JSON.stringify(b.data).includes(leak), 'no ' + leak);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE name = 'POSTMAN TEST Intruder B'").get().n, 0, 'no candidate created for B');
  assert.equal(attempts(link).length, 1);
  // A: refresh and Start (own details, name case / phone format ignored) resume the same questions and answer.
  const again = (await browser.get(exam('exam', link.token))).data;
  assert.deepEqual([again.state, again.candidate.name], ['in_progress', 'POSTMAN TEST Active A']);
  assert.deepEqual(again.questions.map((q) => q.id), a.questions.map((q) => q.id));
  assert.equal(again.questions[0].answer, 'A', 'the saved answer is kept');
  const resumed = (await browser.post(exam('exam', link.token, '/start'), person('postman test  active a', '+856 20 2000 0001'))).data;
  assert.deepEqual(resumed.questions.map((q) => q.id), a.questions.map((q) => q.id));
  // Between tests the attempt is still active: still refused.
  const next = (await browser.post(exam('exam', link.token, '/submit'), { answers: answersFor(a) })).data;
  assert.equal(next.state, 'next_test');
  assert.equal((await browser.post(exam('exam', link.token, '/start'), person('POSTMAN TEST Intruder B', '020 2000 0002'))).status, 409);
});

test('BUG-2 internal staff: another Employee ID cannot take over an active attempt', async () => {
  const link = (await admin.post('/api/admin/internal/links', { title: 'POSTMAN TEST Active', tests: ['IQ'], counts: { IQ: 3 }, pass_marks: { IQ: 0 }, link_expiry_minutes: 60 })).data;
  const browser = client();
  const a = (await browser.post(exam('internal-exam', link.token, '/start'), { name: 'POSTMAN TEST Staff A', employee_id: 'PT-ACT-A' })).data;
  assert.equal(a.state, 'in_progress');
  const b = await browser.post(exam('internal-exam', link.token, '/start'), { name: 'POSTMAN TEST Staff B', employee_id: 'PT-ACT-B' });
  assert.deepEqual([b.status, b.data], [409, { error: 'assessment_in_progress' }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM internal_staff WHERE employee_key = 'PT-ACT-B'").get().n, 0);
  assert.equal((await browser.post(exam('internal-exam', link.token, '/start'), { name: 'x', employee_id: ' pt-act-a ' })).data.state, 'in_progress', 'A resumes');
});

// ---- BUG-3 / BUG-4: the Behavioral Interview Test in reports ---------------------

test('BUG-3 the report and dashboard use the Behavioral Interview Test (interview format), not General', async () => {
  const link = (await admin.post('/api/admin/assessments', { tests: ['GENERAL', BEH], counts: { GENERAL: 2, [BEH]: 2 }, link_expiry_minutes: 60, pass_marks: { GENERAL: 0, [BEH]: 50 } })).data;
  const before = (await admin.get('/api/admin/dashboard')).data.summary;
  const browser = client();
  let s = (await browser.post(exam('exam', link.token, '/start'), person('POSTMAN TEST Behavioral', '020 3000 0001'))).data;
  s = await finish(browser, 'exam', link.token, s);
  assert.equal(s.state, 'submitted');
  const aid = attempts(link)[0].id;
  const pending = (await admin.get('/api/admin/report/standard')).data;
  const row = pending.rows.find((x) => x.values[0] === 'POSTMAN TEST Behavioral');
  assert.equal(pending.fields[11], 'Behavioral Interview Test Score');
  assert.equal(row.values[11], 'Pending HR marking', 'General (100%) is not shown as the behavioural score');
  assert.equal((await admin.get('/api/admin/dashboard')).data.summary.behavioral_pending, before.behavioral_pending + 1);
  const qs = db.prepare('SELECT id FROM assessment_questions WHERE assessment_id = ? AND section = ?').all(aid, BEH);
  await admin.put(`/api/admin/assessments/${aid}/essay-marks`, { marks: { [qs[0].id]: 9, [qs[1].id]: 7 } });
  const marked = (await admin.get('/api/admin/report/standard')).data.rows.find((x) => x.values[0] === 'POSTMAN TEST Behavioral');
  assert.equal(marked.values[11], '80.0%');
  const after = (await admin.get('/api/admin/dashboard')).data.summary;
  assert.equal(after.behavioral_passed, before.behavioral_passed + 1);
  const sheet = XLSX.read((await admin.get('/api/admin/export/candidates.xlsx', { raw: true })).buffer).Sheets.Candidates;
  const table = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.equal(table[0][11], 'Behavioral Interview Test Score');
  assert.equal(table.find((r) => r[0] === 'POSTMAN TEST Behavioral')[11], 0.8);
});

test('BUG-4 the user-facing name is "Behavioral Interview Test" in the pages and import defaults', async () => {
  const pages = await Promise.all(['/static/admin.js', '/static/internal.js'].map(async (p) => (await fetch(base + p)).text()));
  assert.ok(pages.every((t) => t.includes('Behavioral Interview Test')));
  assert.ok(pages.every((t) => !t.includes('Behavioral Assessment Score')));
  assert.equal(require('../src/standardReport').FIELDS[11], 'Behavioral Interview Test Score');
  assert.equal(require('../src/internalReports').FIELDS[6], 'Behavioral Interview Test Score');
});

test('BUG-8 a Lao page falls back to the English name, never the key', async () => {
  const script = await (await fetch(base + '/static/exam.js')).text();
  assert.ok(script.includes('(T === TEXT.lo && t.lo) || t.en || T.sections[key] || key'));
});

// ---- BUG-5: an empty later test ---------------------------------------------------

test('BUG-5 removing questions an open link needs is refused; an empty next test is a clear "unavailable" state', async () => {
  const link = (await admin.post('/api/admin/assessments', { tests: ['IQ', BEH], counts: { IQ: 3, [BEH]: 6 }, link_expiry_minutes: 60, pass_marks: { IQ: 0, [BEH]: 0 } })).data;
  const beh = db.prepare("SELECT * FROM questions WHERE section = ? AND status = 'Active'").all(BEH);
  const inactive = await admin.put('/api/admin/questions/' + beh[0].id, { ...beh[0], status: 'Inactive' });
  assert.equal(inactive.status, 400);
  assert.match(inactive.data.error, /without enough active questions for \d+ open assessment link/);
  assert.equal((await admin.del('/api/admin/questions/' + beh[0].id)).status, 400);
  const all = await admin.post('/api/admin/questions/delete-all', { section: BEH });
  assert.deepEqual([all.status, all.data.success], [400, false]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE section = ? AND status = 'Active'").get(BEH).n, 6, 'nothing removed');

  // A legacy link whose later test was emptied anyway (as on production): no hang.
  const browser = client();
  const s = (await browser.post(exam('exam', link.token, '/start'), person('POSTMAN TEST Empty Stage', '020 4000 0001'))).data;
  const next = (await browser.post(exam('exam', link.token, '/submit'), { answers: answersFor(s) })).data;
  assert.equal(next.state, 'next_test');
  db.prepare("UPDATE questions SET status = 'Inactive' WHERE id = ?").run(beh[0].id);
  try {
    const shown = (await browser.get(exam('exam', link.token))).data;
    assert.deepEqual([shown.state, shown.error], ['unavailable', 'assessment_unavailable']);
    const cont = await browser.post(exam('exam', link.token, '/continue'));
    assert.deepEqual([cont.status, cont.data.state, cont.data.error], [409, 'unavailable', 'assessment_unavailable']);
    const aid = attempts(link)[0].id;
    assert.equal(db.prepare('SELECT status FROM assessments WHERE id = ?').get(aid).status, 'IN_PROGRESS', 'the attempt is kept, not failed');
  } finally {
    db.prepare("UPDATE questions SET status = 'Active' WHERE id = ?").run(beh[0].id);
  }
  // HR adds / restores questions: the candidate carries on.
  const resumed = (await browser.post(exam('exam', link.token, '/continue'))).data;
  assert.deepEqual([resumed.state, resumed.questions.length], ['in_progress', 6]);
  const script = await (await fetch(base + '/static/exam.js')).text();
  assert.ok(script.includes('The next test is currently unavailable.'));
});

// ---- BUG-6 / BUG-7: internal Excel search, fixed expiry --------------------------

test('BUG-6 the internal Excel export honours the search (q) as the results table does', async () => {
  const rowsOf = async (qs) => XLSX.utils.sheet_to_json(XLSX.read((await admin.get('/api/admin/internal/export/results.xlsx' + qs, { raw: true })).buffer).Sheets['Internal Staff Results']);
  const all = await rowsOf('');
  const only = await rowsOf('?q=' + encodeURIComponent('PT-B'));
  assert.ok(all.length > 1);
  assert.equal(only.length, 1);
  assert.equal(only[0]['Employee ID'], 'PT-B');
  const table = (await admin.get('/api/admin/internal/results?q=PT-B')).data.results;
  assert.equal(table.length, only.length, 'Excel matches the filtered table');
});

test('BUG-7 regenerating keeps a fixed expiry date; a relative expiry starts again', async () => {
  const fixed = new Date(Date.now() + 3 * 86400000).toISOString();
  const a = (await admin.post('/api/admin/internal/links', { title: 'POSTMAN TEST Fixed', tests: ['IQ'], counts: { IQ: 2 }, expires_at: fixed })).data;
  const ra = (await admin.post(`/api/admin/internal/links/${a.id}/regenerate`)).data;
  assert.notEqual(ra.token, a.token);
  assert.equal(Date.parse(ra.link_expires_at), Date.parse(a.link_expires_at), 'the chosen date is kept');
  const b = (await admin.post('/api/admin/internal/links', { title: 'POSTMAN TEST Relative', tests: ['IQ'], counts: { IQ: 2 }, link_expiry_minutes: 120 })).data;
  db.prepare('UPDATE assessment_links SET link_expires_at = ? WHERE id = ?').run(new Date(Date.now() + 60000).toISOString(), b.id);
  const rb = (await admin.post(`/api/admin/internal/links/${b.id}/regenerate`)).data;
  assert.ok(Date.parse(rb.link_expires_at) > Date.now() + 110 * 60000, '120 minutes from now');
});

// ---- BUG-9: logout / password change end the session ----------------------------

test('BUG-9 logout invalidates that token at once; other sessions continue', async () => {
  const other = client();
  await other.login();
  const c = client();
  const login = await c.login();
  const token = sessionCookie(login, 'hr_session');
  const me = (cookie) => fetch(base + '/api/admin/auth/me', { headers: { Cookie: 'hr_session=' + cookie } });
  assert.equal((await me(token)).status, 200);
  assert.equal((await c.post('/api/admin/auth/logout')).status, 200);
  const replay = await me(token);
  assert.equal(replay.status, 401, 'the old cookie value no longer works');
  assert.equal((await other.get('/api/admin/auth/me')).status, 200, 'another session is not signed out');
});

test('BUG-9 a password change ends every other session; the current one continues', async () => {
  const other = client();
  await other.login();
  const c = client();
  await c.login();
  assert.equal((await c.post('/api/admin/auth/password', { current_password: 'test-password-1', new_password: 'test-password-2' })).status, 200);
  assert.equal((await other.get('/api/admin/auth/me')).status, 401);
  assert.equal((await c.get('/api/admin/auth/me')).status, 200);
  assert.equal((await c.post('/api/admin/auth/password', { current_password: 'test-password-2', new_password: 'test-password-1' })).status, 200);
  assert.equal((await admin.get('/api/admin/auth/me')).status, 401, 'the suite admin session also ended');
  await admin.login();
});

// ---- .xls import, secrets --------------------------------------------------------

test('a real .xls (Excel 97-2003) file previews and imports', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([['Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer'],
    ['POSTMAN TEST xls question 1?', 'One', 'Two', 'Three', 'Four', 'B'], ['POSTMAN TEST xls question 2?', 'Red', 'Blue', 'Green', 'Black', 'C']]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Questions');
  const buf = XLSX.write(book, { type: 'buffer', bookType: 'biff8' });
  assert.equal(buf.subarray(0, 4).toString('hex'), 'd0cf11e0', 'an OLE (.xls) file');
  const p = (await admin.post('/api/admin/questions/import/preview', undefined, { form: upload(buf, 'questions.xls', 'GENERAL') })).data;
  assert.equal(p.found, 2);
  assert.ok(p.rows.every((r) => r.errors.length === 0));
  assert.deepEqual(p.rows.map((r) => [r.question.question_text, r.question.correct_answer]), [['POSTMAN TEST xls question 1?', 'B'], ['POSTMAN TEST xls question 2?', 'C']]);
  const imp = await admin.post('/api/admin/questions/import', { questions: p.rows.map((r) => r.question) });
  assert.deepEqual(imp.data, { imported: 2, skipped: 0 });
});

test('BUG-10 no Postman API key in any tracked file', () => {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-I', '-l', '-E', 'PMAK[-][0-9a-f]{8}'], { cwd: require('path').join(__dirname, '..'), encoding: 'utf8' });
  } catch (e) {
    if (e.status === 1) out = ''; // no match
    else return; // no git here (e.g. a deploy image): nothing to scan
  }
  assert.equal(out.trim(), '', 'files with a key: ' + out);
});
