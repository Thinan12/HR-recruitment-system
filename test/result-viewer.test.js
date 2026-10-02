// Result Viewer accounts: a separate read-only login that shows ONE person
// their own results (read from the existing scoring), with print and Excel.
// It can never reach the admin API, other people, questions or answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { start, stop, client, seedQuestions, db, CANDIDATE } = require('./helpers');
const reports = require('../src/reports');
const SR = require('../src/standardReport');
const A = require('../src/assessments');

let base;
let admin;
let BEH;
const ids = {};
test.before(async () => {
  base = await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 10, 1, 'Easy');
  seedQuestions('CALCULATION', 10);
  BEH = (await admin.post('/api/admin/test-types', { name: 'Behavioral Interview Test', behavior: 'interview' })).data.key;
  for (const t of ['Tell me about a hard problem.', 'Describe your best team.']) db.prepare('INSERT INTO questions (section, question_text, marks, created_at) VALUES (?, ?, 10, ?)').run(BEH, t, new Date().toISOString());
  db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES ('ESSAY', 'SECRET ESSAY QUESTION Why LALCO?', 10, ?)").run(new Date().toISOString());

  const take = async (link, person, right, api = 'exam') => {
    const c = client();
    let s = (await c.post(`/api/${api}/${link.token}/start`, person)).data;
    while (s.state === 'in_progress') {
      const answers = Object.fromEntries(s.questions.map((q, i) => {
        const row = db.prepare('SELECT section, correct_answer FROM assessment_questions WHERE id = ?').get(q.id);
        if (!['IQ', 'CALCULATION'].includes(row.section)) return [q.id, 'SECRET ANSWER TEXT'];
        return [q.id, i < (right[row.section] ?? 99) ? row.correct_answer : row.correct_answer === 'A' ? 'B' : 'A'];
      }));
      s = (await c.post(`/api/${api}/${link.token}/submit`, { answers })).data;
      if (s.state === 'next_test') s = (await c.post(`/api/${api}/${link.token}/continue`)).data;
    }
    return s;
  };
  // Candidate A: IQ 8 / 10, the Behavioral Interview Test (HR marks 15 / 20), Calculation 6 / 10, the essay not marked yet.
  const all = (await admin.post('/api/admin/assessments', { tests: ['IQ', BEH, 'CALCULATION', 'ESSAY'], counts: { IQ: 10, [BEH]: 2, CALCULATION: 10, ESSAY: 1 },
    link_expiry_minutes: 60, pass_marks: { IQ: 50, [BEH]: 50, CALCULATION: 50, ESSAY: 50 }, eligibility_mark: 60 })).data;
  await take(all, { ...CANDIDATE, name: 'Viewer Alice', phone: '020 7000 0001' }, { IQ: 8, CALCULATION: 6 });
  ids.aliceAttempt = db.prepare("SELECT a.id, a.candidate_id FROM assessments a JOIN candidates c ON c.id = a.candidate_id WHERE c.name = 'Viewer Alice'").get();
  ids.alice = ids.aliceAttempt.candidate_id;
  const beh = db.prepare('SELECT id FROM assessment_questions WHERE assessment_id = ? AND section = ? ORDER BY position').all(ids.aliceAttempt.id, BEH);
  await admin.put(`/api/admin/assessments/${ids.aliceAttempt.id}/essay-marks`, { marks: { [beh[0].id]: 10, [beh[1].id]: 5 } });
  // Candidate B: another person (IQ fails).
  const iqOnly = (await admin.post('/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 10 }, link_expiry_minutes: 60, pass_marks: { IQ: 50 } })).data;
  await take(iqOnly, { ...CANDIDATE, name: 'Viewer Bob Other', phone: '020 7000 0002' }, { IQ: 2 });
  ids.bob = db.prepare("SELECT id FROM candidates WHERE name = 'Viewer Bob Other'").get().id;
  ids.bobAttempt = db.prepare('SELECT id FROM assessments WHERE candidate_id = ?').get(ids.bob).id;
  // Staff member S on an internal link.
  const staffLink = (await admin.post('/api/admin/internal/links', { title: 'Staff check', tests: ['IQ'], counts: { IQ: 10 }, pass_marks: { IQ: 50 }, link_expiry_minutes: 60 })).data;
  await take(staffLink, { name: 'Viewer Staff Sam', employee_id: 'EMP-RV-1', department: 'Finance' }, { IQ: 9 }, 'internal-exam');
  ids.staff = db.prepare("SELECT id FROM internal_staff WHERE employee_key = 'EMP-RV-1'").get().id;
});
test.after(stop);

const viewerLogin = async (username, password) => {
  const c = client();
  const r = await c.post('/api/results/auth/login', { username, password });
  return { c, r };
};
const cookieOf = (r, name) => { const m = new RegExp(name + '=([^;]+)').exec(r.headers.get('set-cookie') || ''); return m && m[1]; };

test('HR creates accounts (hashed password, never shown again); bad input is refused', async () => {
  const made = await admin.post('/api/admin/result-viewers', { username: 'alice.v', password: 'alice-pass-1', candidate_id: ids.alice });
  assert.equal(made.status, 201);
  assert.deepEqual([made.data.username, made.data.person_type, made.data.person_name, made.data.active], ['alice.v', 'candidate', 'Viewer Alice', true]);
  assert.ok(!JSON.stringify(made.data).includes('alice-pass-1') && !('password_hash' in made.data));
  assert.match(db.prepare("SELECT password_hash FROM result_viewers WHERE username = 'alice.v'").get().password_hash, /^\$2[aby]\$12\$/, 'bcrypt hash, never the password');
  assert.equal((await admin.post('/api/admin/result-viewers', { username: 'bob.v', password: 'bob-pass-12', candidate_id: ids.bob })).status, 201);
  assert.equal((await admin.post('/api/admin/result-viewers', { username: 'sam.v', password: 'sam-pass-12', staff_id: ids.staff })).status, 201);
  for (const [body, msg] of [
    [{ username: 'ALICE.V', password: 'whatever-1', candidate_id: ids.alice }, /already used/],
    [{ username: 'x', password: 'whatever-1', candidate_id: ids.alice }, /Username/],
    [{ username: 'short.pw', password: 'short', candidate_id: ids.alice }, /at least 8/],
    [{ username: 'nobody.v', password: 'whatever-1' }, /Choose the candidate or the staff member/],
    [{ username: 'both.v', password: 'whatever-1', candidate_id: ids.alice, staff_id: ids.staff }, /Choose the candidate or the staff member/],
    [{ username: 'ghost.v', password: 'whatever-1', candidate_id: 999999 }, /not found/],
  ]) {
    const r = await admin.post('/api/admin/result-viewers', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, msg);
  }
  const listed = (await admin.get('/api/admin/result-viewers')).data;
  assert.equal(listed.length, 3);
  assert.ok(!JSON.stringify(listed).includes('$2'), 'no hashes in the list');
});

test('1-2. login succeeds with a separate cookie (no data in the response); a wrong password fails', async () => {
  const { r } = await viewerLogin('alice.v', 'alice-pass-1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { username: 'alice.v' }, 'no candidate data in the login response');
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /^lalco_result_session=/);
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Strict/i);
  assert.match(sc, /Path=\/api\/results/);
  assert.ok(!/hr_session/.test(sc), 'not an admin session');
  assert.equal((await viewerLogin('alice.v', 'wrong-password')).r.status, 401);
  assert.equal((await viewerLogin('nobody-here', 'alice-pass-1')).r.status, 401);
  assert.equal((await viewerLogin('Alice.V', 'alice-pass-1')).r.status, 200, 'username is not case sensitive');
});

test('4-5, 10-15. /me: only the own person, the existing scores, levels and statuses; never questions or answers', async () => {
  const { c } = await viewerLogin('alice.v', 'alice-pass-1');
  const r = await c.get('/api/results/me');
  assert.equal(r.status, 200);
  const d = r.data;
  assert.deepEqual([d.candidateName, d.phone, d.assessments.length], ['Viewer Alice', '020 7000 0001', 1]);
  assert.match(d.assessmentDate, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const text = JSON.stringify(d);
  for (const bad of ['Viewer Bob', 'Viewer Staff', 'SECRET', 'question', 'answer', 'correct', 'pass_mark', 'eligibility_note', 'final_result', 'review_required']) assert.ok(!text.includes(bad), 'not sent: ' + bad);

  // The same values HR sees, read from the existing scoring (no second formula).
  const a = A.getAssessment(ids.aliceAttempt.id);
  const stages = A.stagesOf(a);
  const hr = Object.fromEntries(stages.map((st) => [st.section, reports.stageView(a, st, stages)]));
  const t = Object.fromEntries(d.tests.map((x) => [x.testType, x]));
  assert.deepEqual(d.tests.map((x) => x.testType), stages.map((st) => st.section), 'only the tests of this assessment, in its own order');
  assert.deepEqual([...d.tests.map((x) => x.testType)].sort(), ['CALCULATION', 'ESSAY', 'IQ', BEH].sort());
  // 10-11. IQ: LALCO IQ Score / 150, raw weighted marks, percentage and the existing classification.
  assert.deepEqual([t.IQ.status, t.IQ.score_text, t.IQ.raw_score_text, t.IQ.percentage, t.IQ.level], ['PASS', `${hr.IQ.lalco_iq_score} / 150`, '8 / 10', 80, hr.IQ.level]);
  assert.equal(t.IQ.score_text, '120 / 150');
  assert.equal(t.IQ.level, 'Superior');
  assert.equal(t.IQ.level_lo, reports.getIQClassification(120).description_lo);
  // 12. Behavioral Interview Test: HR's marks 15 / 20 = 75%.
  assert.deepEqual([t[BEH].test, t[BEH].status, t[BEH].score_text, t[BEH].percentage, t[BEH].level], ['Behavioral Interview Test', 'PASS', '15 / 20', 75, hr[BEH].level]);
  // 13. Calculation 6 / 10.
  assert.deepEqual([t.CALCULATION.status, t.CALCULATION.score_text, t.CALCULATION.percentage, t.CALCULATION.level], ['PASS', '6 / 10', 60, 'Average']);
  // 14. Essay not marked: PENDING, never a false 0.
  assert.deepEqual([t.ESSAY.status, t.ESSAY.score, t.ESSAY.score_text, t.ESSAY.percentage, t.ESSAY.level], ['PENDING', null, null, null, null]);
  // 15. Overall = the status HR's report shows (Company Eligibility).
  assert.equal(d.overallStatus, 'PENDING');
  assert.equal(d.overallStatus, SR.eligibilityStatus(reports.finalAssessment(a, stages).eligibility));
  const row = (await admin.get('/api/admin/report/standard')).data.rows.find((x) => x.values[0] === 'Viewer Alice');
  assert.equal(row.values[14], d.overallStatus, 'same as the HR report');

  // HR marks the essay: the viewer sees the new result at once (read from the same source).
  const essay = db.prepare("SELECT id FROM assessment_questions WHERE assessment_id = ? AND section = 'ESSAY'").get(ids.aliceAttempt.id);
  await admin.put(`/api/admin/assessments/${ids.aliceAttempt.id}/essay-marks`, { marks: { [essay.id]: 8 } });
  const after = (await c.get('/api/results/me')).data;
  const e = after.tests.find((x) => x.testType === 'ESSAY');
  assert.deepEqual([e.status, e.score_text, e.percentage], ['PASS', '8 / 10', 80]);
  // Final (80 + 75 + 60 + 80) / 4 = 73.75 >= 60, every test passed -> PASS, as in HR's report.
  assert.equal(after.overallStatus, 'PASS');
  assert.equal((await admin.get('/api/admin/report/standard')).data.rows.find((x) => x.values[0] === 'Viewer Alice').values[14], 'PASS');
});

test('a NOT PASS result, and a test that was never reached', async () => {
  const { c } = await viewerLogin('bob.v', 'bob-pass-12');
  const d = (await c.get('/api/results/me')).data;
  assert.equal(d.candidateName, 'Viewer Bob Other');
  assert.deepEqual([d.tests[0].status, d.tests[0].score_text, d.overallStatus], ['NOT PASS', '30 / 150', 'NOT PASS']);
  assert.ok(!JSON.stringify(d).includes('Viewer Alice'));
});

test('a staff member sees their internal result only (internal status, as HR sees it)', async () => {
  const { c } = await viewerLogin('sam.v', 'sam-pass-12');
  const d = (await c.get('/api/results/me')).data;
  assert.deepEqual([d.candidateName, d.employeeId, d.tests.length, d.tests[0].score_text, d.overallStatus], ['Viewer Staff Sam', 'EMP-RV-1', 1, '135 / 150', 'PASS']);
  const hrRow = (await admin.get('/api/admin/internal/results')).data.results.find((x) => x.staff && x.staff.employee_id === 'EMP-RV-1');
  assert.equal(hrRow.values[9], d.overallStatus);
});

test('6. changing ids in the URL never shows another person', async () => {
  const { c } = await viewerLogin('alice.v', 'alice-pass-1');
  for (const q of [`?candidateId=${ids.bob}`, `?candidate_id=${ids.bob}`, `?staffId=${ids.staff}`, `?assessmentId=${ids.bobAttempt}`, `?id=${ids.bob}`]) {
    const r = await c.get('/api/results/me' + q);
    assert.equal(r.status, 200);
    assert.equal(r.data.candidateName, 'Viewer Alice', q);
    assert.ok(!JSON.stringify(r.data).includes('Bob'), q);
    const x = await c.get('/api/results/me/export.xlsx' + q, { raw: true });
    assert.ok(!x.buffer.toString('latin1').includes('Bob'), 'export ' + q);
  }
  for (const p of [`/api/results/${ids.bob}`, `/api/results/candidates/${ids.bob}`, `/api/results/me/${ids.bobAttempt}`, `/api/results/assessments/${ids.bobAttempt}`]) {
    const r = await c.get(p);
    assert.equal(r.status, 404, p);
    assert.ok(!JSON.stringify(r.data).includes('Bob'));
  }
});

test('7. a Result Viewer cannot use any admin API (GET / POST / PUT / DELETE), even with the token in the admin cookie', async () => {
  const { r } = await viewerLogin('alice.v', 'alice-pass-1');
  const token = cookieOf(r, 'lalco_result_session');
  const calls = [['GET', '/api/admin/auth/me'], ['GET', '/api/admin/candidates'], ['GET', `/api/admin/candidates/${ids.bob}`], ['GET', '/api/admin/questions'],
    ['GET', '/api/admin/dashboard'], ['GET', '/api/admin/report/standard'], ['GET', '/api/admin/export/candidates.xlsx'], ['GET', '/api/admin/result-viewers'],
    ['GET', '/api/admin/internal/staff'], ['GET', '/api/admin/settings'], ['POST', '/api/admin/assessments'], ['POST', '/api/admin/questions'],
    ['POST', '/api/admin/result-viewers'], ['PUT', `/api/admin/candidates/${ids.alice}`], ['PUT', `/api/admin/assessments/${ids.aliceAttempt.id}/essay-marks`],
    ['DELETE', `/api/admin/candidates/${ids.bob}`], ['DELETE', '/api/admin/questions/1'], ['POST', '/api/admin/questions/delete-all']];
  for (const cookie of [`lalco_result_session=${token}`, `hr_session=${token}`]) {
    for (const [method, url] of calls) {
      const res = await fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(res.status, 401, `${cookie.split('=')[0]} ${method} ${url}`);
    }
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE id = ?').get(ids.bob).n, 1, 'nothing was deleted');
  // And an admin token is not a Result Viewer session.
  const adminLogin = await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password-1' }) });
  const adminToken = cookieOf(adminLogin, 'hr_session');
  assert.equal((await fetch(base + '/api/results/me', { headers: { Cookie: `lalco_result_session=${adminToken}` } })).status, 401);
});

test('8-9. read only: no way to edit, mark, delete or restart anything', async () => {
  const { c } = await viewerLogin('alice.v', 'alice-pass-1');
  const before = JSON.stringify(db.prepare('SELECT * FROM assessments WHERE id = ?').get(ids.aliceAttempt.id)) + JSON.stringify(db.prepare('SELECT * FROM assessment_stages WHERE assessment_id = ?').all(ids.aliceAttempt.id));
  for (const [m, u] of [['put', '/api/results/me'], ['post', '/api/results/me'], ['del', '/api/results/me'], ['put', '/api/results/me/essay-marks'], ['post', '/api/results/me/restart'], ['del', `/api/results/assessments/${ids.aliceAttempt.id}`]]) {
    assert.equal((await c[m](u, m === 'del' ? undefined : { result: 'Pass', marks: { 1: 10 } })).status, 404, `${m} ${u}`);
  }
  const after = JSON.stringify(db.prepare('SELECT * FROM assessments WHERE id = ?').get(ids.aliceAttempt.id)) + JSON.stringify(db.prepare('SELECT * FROM assessment_stages WHERE assessment_id = ?').all(ids.aliceAttempt.id));
  assert.equal(after, before);
});

test('17-18. Excel: only the own result, clear header, frozen, numeric %; no questions, answers or HR data', async () => {
  const { c } = await viewerLogin('alice.v', 'alice-pass-1');
  const x = await c.get('/api/results/me/export.xlsx', { raw: true });
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-disposition'), /LALCO_My_Results_Viewer_Alice\.xlsx/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(x.buffer);
  const sheet = book.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Candidate Name', 'Phone Number', 'Assessment Date', 'Test', 'Status', 'Score', 'Percentage', 'Level']);
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.getRow(1).font.bold, true);
  const rows = [];
  sheet.eachRow((r, i) => { if (i > 1) rows.push(r.values.slice(1)); });
  assert.equal(rows.length, 5, '4 tests + the overall result');
  assert.ok(rows.every((r) => r[0] === 'Viewer Alice'));
  const iq = rows.find((r) => r[3] === 'IQ Test');
  assert.deepEqual([iq[4], iq[5], iq[6], iq[7]], ['PASS', '120 / 150', 0.8, 'Superior']);
  assert.equal(sheet.getRow(rows.indexOf(iq) + 2).getCell(7).numFmt, '0.0%');
  assert.deepEqual(rows[rows.length - 1].slice(3, 5), ['OVERALL RESULT', 'PASS']);
  const all = JSON.stringify(rows);
  for (const bad of ['SECRET', 'Viewer Bob', 'Tell me about', 'correct', 'audit']) assert.ok(!all.includes(bad), bad);
});

test('3. a disabled account cannot log in and its open session stops; enable, password reset, delete login', async () => {
  const { c } = await viewerLogin('bob.v', 'bob-pass-12');
  assert.equal((await c.get('/api/results/me')).status, 200);
  const bob = (await admin.get('/api/admin/result-viewers')).data.find((x) => x.username === 'bob.v');
  assert.equal((await admin.post(`/api/admin/result-viewers/${bob.id}/disable`)).data.active, false);
  assert.equal((await c.get('/api/results/me')).status, 401, 'the open session ends at once');
  const refused = await viewerLogin('bob.v', 'bob-pass-12');
  assert.equal(refused.r.status, 403);
  assert.match(refused.r.data.error, /disabled/);
  assert.equal((await admin.post(`/api/admin/result-viewers/${bob.id}/enable`)).data.active, true);
  const again = await viewerLogin('bob.v', 'bob-pass-12');
  assert.equal(again.r.status, 200);
  // Password reset: the old password and the old session stop working.
  assert.equal((await admin.post(`/api/admin/result-viewers/${bob.id}/password`, { password: 'short' })).status, 400);
  assert.equal((await admin.post(`/api/admin/result-viewers/${bob.id}/password`, { password: 'bob-new-pass-1' })).status, 200);
  assert.equal((await again.c.get('/api/results/me')).status, 401);
  assert.equal((await viewerLogin('bob.v', 'bob-pass-12')).r.status, 401);
  assert.equal((await viewerLogin('bob.v', 'bob-new-pass-1')).r.status, 200);
  // Delete login: the account goes, Bob's results stay.
  assert.deepEqual((await admin.del(`/api/admin/result-viewers/${bob.id}`)).data, { ok: true });
  assert.equal((await viewerLogin('bob.v', 'bob-new-pass-1')).r.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessments WHERE candidate_id = ?').get(ids.bob).n, 1, 'results kept');
  assert.equal((await admin.post('/api/admin/result-viewers/999999/disable')).status, 404);
  const log = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'RESULT_VIEWER_%' ORDER BY id").all().map((x) => x.action);
  for (const a of ['RESULT_VIEWER_CREATED', 'RESULT_VIEWER_DISABLED', 'RESULT_VIEWER_ENABLED', 'RESULT_VIEWER_PASSWORD_RESET', 'RESULT_VIEWER_DELETED']) assert.ok(log.includes(a), a);
});

test('logout ends the session; the account of a deleted person is removed with the person', async () => {
  const { c, r } = await viewerLogin('alice.v', 'alice-pass-1');
  const token = cookieOf(r, 'lalco_result_session');
  assert.equal((await c.post('/api/results/auth/logout')).status, 200);
  assert.equal((await fetch(base + '/api/results/me', { headers: { Cookie: `lalco_result_session=${token}` } })).status, 401, 'the old token is revoked');
  assert.equal((await client().get('/api/results/me')).status, 401, 'no session');
  // A person HR deletes takes their login with them.
  const temp = (await admin.post('/api/admin/candidates', { name: 'Viewer Temp', phone: '020 7000 0099' })).data;
  await admin.post('/api/admin/result-viewers', { username: 'temp.v', password: 'temp-pass-1', candidate_id: temp.id });
  const t = await viewerLogin('temp.v', 'temp-pass-1');
  assert.deepEqual([(await t.c.get('/api/results/me')).data.assessments.length], [0], 'no finished assessment yet: nothing to show');
  await admin.del('/api/admin/candidates/' + temp.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM result_viewers WHERE username = 'temp.v'").get().n, 0);
  assert.equal((await t.c.get('/api/results/me')).status, 401);
});

test('16, 19. the page: own script only, print shows only the result, phone layout', async () => {
  const page = await (await fetch(base + '/results')).text();
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.ok(page.includes('/static/results.js') && !page.includes('admin.js') && !page.includes('exam.js'), 'no admin or exam code on the page');
  const css = await (await fetch(base + '/static/style.css')).text();
  assert.match(css, /@media print \{[^}]*\.results-page \.results-actions, \.results-page #lang-switch \{ display: none !important; \}/);
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.results-main/);
  const js = await (await fetch(base + '/static/results.js')).text();
  assert.ok(js.includes("fetch('/api/results' + url") && !js.includes('/api/admin'), 'the page only calls /api/results');
  assert.ok(js.includes('window.print()') && js.includes('/api/results/me/export.xlsx'));
});

test('20. the HR / admin login and pages still work', async () => {
  const a = client();
  await a.login();
  assert.equal((await a.get('/api/admin/auth/me')).data.username, 'admin');
  assert.equal((await a.get('/api/admin/dashboard')).status, 200);
  assert.equal((await a.get('/api/admin/report/standard')).status, 200);
  assert.equal((await fetch(base + '/')).status, 200);
});
