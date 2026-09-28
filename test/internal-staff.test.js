// Internal Office Staff: separate staff records, links, public flow, results,
// dashboard and reports on the shared assessment engine — and strict
// server-side separation from Recruitment.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { start, stop, client, db, seedQuestions, CANDIDATE } = require('./helpers');

let admin;
let base;
test.before(async () => {
  base = await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 12, 1, 'Easy');
  seedQuestions('GENERAL', 6);
});
test.after(stop);

const count = (sql, ...a) => db.prepare(sql).get(...a).n;
const STAFF_LINK = { title: 'Q4 Staff Check', description: 'Quarterly check', tests: ['IQ', 'GENERAL'], counts: { IQ: 5, GENERAL: 3 }, minutes: { IQ: 10, GENERAL: 10 },
  pass_marks: { IQ: 0, GENERAL: 0 }, link_expiry_minutes: 60 };
const cookieOf = (res, name) => { const m = new RegExp(name + '=([^;]+)').exec(res.headers.get('set-cookie') || ''); return m && m[1]; };
const raw = (method, url, cookie, body) => fetch(base + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });

test('staff records: create, validate, search, filter, view, edit — separate from candidates', async () => {
  const candidatesBefore = count('SELECT COUNT(*) AS n FROM candidates');
  const made = await admin.post('/api/admin/internal/staff', { name: 'Noy Staff', employee_id: 'EMP-001', department: 'Finance', position: 'Accountant', phone: '020 1111 2222', email: 'noy@lalco.la' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.deepEqual([made.data.name, made.data.employee_id, made.data.status, made.data.assessments], ['Noy Staff', 'EMP-001', 'Active', 0]);
  assert.equal((await admin.post('/api/admin/internal/staff', { name: 'Other', employee_id: ' emp-001 ' })).status, 400, 'employee ID unique ignoring case / spaces');
  assert.match((await admin.post('/api/admin/internal/staff', { employee_id: 'X1' })).data.error, /Staff name is required/);
  assert.match((await admin.post('/api/admin/internal/staff', { name: 'X' })).data.error, /Employee ID is required/);
  assert.match((await admin.post('/api/admin/internal/staff', { name: 'X', employee_id: 'X2', email: 'nope' })).data.error, /valid email/);
  await admin.post('/api/admin/internal/staff', { name: 'Kham Staff', employee_id: 'EMP-002', department: 'IT', position: 'Developer' });
  const list = (await admin.get('/api/admin/internal/staff?q=Noy')).data;
  assert.deepEqual(list.staff.map((s) => s.name), ['Noy Staff']);
  assert.deepEqual((await admin.get('/api/admin/internal/staff?department=IT')).data.staff.map((s) => s.name), ['Kham Staff']);
  assert.deepEqual(list.departments, ['Finance', 'IT']);
  const one = (await admin.get('/api/admin/internal/staff/' + made.data.id)).data;
  assert.deepEqual([one.staff.email, one.results], ['noy@lalco.la', []]);
  const upd = await admin.put('/api/admin/internal/staff/' + made.data.id, { name: 'Noy Staff', employee_id: 'EMP-001', department: 'Finance', position: 'Senior Accountant', status: 'Active' });
  assert.equal(upd.data.position, 'Senior Accountant');
  assert.equal((await admin.get('/api/admin/internal/staff/999999')).status, 404);
  assert.equal(count('SELECT COUNT(*) AS n FROM candidates'), candidatesBefore, 'no candidate records');
  // Staff never appear in recruitment.
  assert.ok(!(await admin.get('/api/admin/candidates')).data.some((c) => c.name === 'Noy Staff'));
});

test('internal link: its own area, URL, description, reusable flag and date/time expiry; invisible to recruitment', async () => {
  const bad = await admin.post('/api/admin/internal/links', { ...STAFF_LINK, title: '' });
  assert.match(bad.data.error, /assessment name/);
  const expires = new Date(Date.now() + 2 * 86400 * 1000).toISOString();
  const r = await admin.post('/api/admin/internal/links', { ...STAFF_LINK, expires_at: expires });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const l = r.data;
  assert.deepEqual([l.business_area, l.description, l.reusable, l.share_state, l.url_path], ['INTERNAL_STAFF', 'Quarterly check', 1, 'open', '/internal-assessment/' + l.token]);
  assert.equal(l.link_expires_at, expires);
  assert.equal((await admin.post('/api/admin/internal/links', { ...STAFF_LINK, expires_at: '2020-01-01T00:00:00Z' })).status, 400, 'expiry in the past');
  // Recruitment cannot see or act on it.
  assert.equal((await admin.get('/api/admin/links/' + l.id)).status, 404);
  assert.equal((await admin.post(`/api/admin/links/${l.id}/disable`)).status, 404);
  assert.equal((await admin.del('/api/admin/links/' + l.id)).status, 404);
  assert.ok(!(await admin.get('/api/admin/assessments')).data.some((x) => x.id === l.id));
  assert.equal((await client().get('/api/exam/' + l.token)).status, 404, 'a recruitment URL cannot open an internal link');
  // And internal cannot see a recruitment link.
  const rec = (await admin.post('/api/admin/assessments', { tests: ['GENERAL'], counts: { GENERAL: 2 }, link_expiry_minutes: 60 })).data;
  assert.equal((await admin.get('/api/admin/internal/links/' + rec.id)).status, 404);
  assert.equal((await client().get('/api/internal-exam/' + rec.token)).status, 404, 'an internal URL cannot open a recruitment link');
  assert.ok((await admin.get('/api/admin/internal/links')).data.every((x) => x.business_area === 'INTERNAL_STAFF'));
});

test('two employees on one reusable link: own sessions, snapshots, answers and results; staff records, never candidates', async () => {
  const link = (await admin.post('/api/admin/internal/links', STAFF_LINK)).data;
  const candidatesBefore = count('SELECT COUNT(*) AS n FROM candidates');
  const A = client();
  const B = client();
  const openA = await A.get('/api/internal-exam/' + link.token);
  assert.deepEqual([openA.data.state, openA.data.business_area], ['ready', 'INTERNAL_STAFF']);
  assert.match(openA.headers.get('set-cookie'), /lalco_staff_session=.*Path=\/api\/internal-exam\//i);
  assert.equal((await A.post(`/api/internal-exam/${link.token}/start`, { name: 'Noy' })).data.error, 'employee_id_required');
  assert.equal((await A.post(`/api/internal-exam/${link.token}/start`, { employee_id: 'E' })).data.error, 'name_required');
  // A uses the Employee ID HR created: the attempt joins that record (HR's details kept).
  const sA = (await A.post(`/api/internal-exam/${link.token}/start`, { name: 'Noy typed', employee_id: 'emp-001', department: 'Typed dept', phone: '020 9', email: 'x@y.la' })).data;
  assert.deepEqual([sA.state, sA.section, sA.questions.length], ['in_progress', 'IQ', 5]);
  await B.get('/api/internal-exam/' + link.token);
  const sB = (await B.post(`/api/internal-exam/${link.token}/start`, { name: 'New Person', employee_id: 'EMP-777', department: 'HR', position: 'Officer' })).data;
  assert.equal(sB.state, 'in_progress');
  assert.equal(count('SELECT COUNT(*) AS n FROM candidates'), candidatesBefore, 'an internal link never creates a candidate');
  const noy = db.prepare("SELECT * FROM internal_staff WHERE employee_key = 'EMP-001'").get();
  assert.deepEqual([noy.name, noy.department], ['Noy Staff', 'Finance'], 'HR\'s record is not overwritten');
  const newcomer = db.prepare("SELECT * FROM internal_staff WHERE employee_key = 'EMP-777'").get();
  assert.deepEqual([newcomer.name, newcomer.department, newcomer.position], ['New Person', 'HR', 'Officer']);
  // Isolation between the two.
  assert.equal((await A.put(`/api/internal-exam/${link.token}/answer`, { question_id: sB.questions[0].id, answer: 'A' })).data.error, 'unknown_question');
  const refresh = (await A.get('/api/internal-exam/' + link.token)).data;
  assert.deepEqual(refresh.questions.map((q) => q.id), sA.questions.map((q) => q.id), 'refresh keeps the same questions');
  assert.ok(!sA.questions.some((q) => sB.questions.map((x) => x.id).includes(q.id)), 'own snapshot rows');
  // A finishes both tests (continue works), B stays in progress.
  const correct = (qs) => Object.fromEntries(qs.map((q) => [q.id, db.prepare('SELECT correct_answer FROM assessment_questions WHERE id = ?').get(q.id).correct_answer]));
  const next = (await A.post(`/api/internal-exam/${link.token}/submit`, { answers: correct(sA.questions) })).data;
  assert.deepEqual([next.state, next.last_result.lalco_iq_score, next.last_result.percent], ['next_test', 150, undefined], 'same IQ scoring, no IQ % for the taker');
  const gen = (await A.post(`/api/internal-exam/${link.token}/continue`)).data;
  assert.equal(gen.section, 'GENERAL');
  const done = (await A.post(`/api/internal-exam/${link.token}/submit`, { answers: correct(gen.questions) })).data;
  assert.equal(done.state, 'submitted');

  // Results / detail / dashboard / exports: internal only.
  const results = (await admin.get('/api/admin/internal/results')).data;
  const rowA = results.results.find((r) => r.staff && r.staff.employee_id === 'EMP-001');
  assert.deepEqual(results.fields.slice(0, 5), ['Staff Name', 'Employee ID', 'Department', 'Position', 'Assessment']);
  assert.deepEqual([rowA.values[0], rowA.values[4], rowA.values[5], rowA.values[6], rowA.values[9]], ['Noy Staff', 'Q4 Staff Check', '150 / 150', '100.0%', 'PASS']);
  assert.ok(results.results.some((r) => r.staff.employee_id === 'EMP-777' && r.values[9] === 'IN PROGRESS'));
  const detail = (await admin.get('/api/admin/internal/results/' + rowA.id)).data;
  assert.deepEqual([detail.staff.employee_id, detail.entered_details.name, detail.tests.length, detail.questions.length], ['EMP-001', 'Noy typed', 2, 8]);
  assert.equal((await admin.get('/api/admin/assessments/' + rowA.id)).status, 404, 'recruitment review cannot open an internal result');
  assert.equal((await admin.get('/api/admin/internal/results/' + db.prepare("SELECT id FROM assessments WHERE business_area = 'RECRUITMENT' LIMIT 1").get()?.id)).status, 404);
  const dash = (await admin.get('/api/admin/internal/dashboard')).data;
  for (const k of ['totalStaff', 'totalAssessments', 'activeLinks', 'completed', 'inProgress', 'pending', 'passed', 'notPassed']) assert.equal(typeof dash[k], 'number', k);
  assert.ok(dash.completed >= 1 && dash.inProgress >= 1 && dash.passed >= 1 && dash.totalStaff >= 3);
  assert.ok(Array.isArray(dash.recentAssessments) && Array.isArray(dash.recentResults) && Array.isArray(dash.expiringLinks));
  for (const [fmt, type] of [['pdf', 'application/pdf'], ['docx', 'wordprocessingml'], ['xlsx', 'spreadsheetml']]) {
    const f = await admin.get(`/api/admin/internal/results/${rowA.id}/export.${fmt}`, { raw: true });
    assert.equal(f.status, 200, fmt);
    assert.match(f.headers.get('content-type'), new RegExp(type));
  }
  const all = XLSX.utils.sheet_to_json(XLSX.read((await admin.get('/api/admin/internal/export/results.xlsx', { raw: true })).buffer).Sheets['Internal Staff Results']);
  assert.ok(all.every((r) => r['Staff Name'] !== 'Test Candidate'), 'report holds internal staff only');
  assert.ok(all.some((r) => r['Employee ID'] === 'EMP-001' && r['Pass / Not Pass Status'] === 'PASS'));
  // Recruitment reports do not include staff.
  const std = (await admin.get('/api/admin/report/standard')).data;
  assert.ok(!std.rows.some((r) => ['Noy Staff', 'New Person'].includes(r.values[0])));
  const recDash = (await admin.get('/api/admin/dashboard')).data;
  assert.ok(!recDash.candidates.some((c) => c.name === 'Noy Staff'));
  // The staff page shows their results.
  assert.equal((await admin.get('/api/admin/internal/staff/' + noy.id)).data.results.length, 1);
});

test('sessions and cookies do not cross areas', async () => {
  const staffLink = (await admin.post('/api/admin/internal/links', STAFF_LINK)).data;
  const recLink = (await admin.post('/api/admin/assessments', { tests: ['GENERAL'], counts: { GENERAL: 2 }, link_expiry_minutes: 60 })).data;
  // A recruitment candidate starts; their secret, sent as a staff cookie to the internal link, is a stranger there.
  const cand = await raw('GET', '/api/exam/' + recLink.token);
  const candSecret = cookieOf(cand, 'lalco_candidate_session');
  await raw('POST', `/api/exam/${recLink.token}/start`, `lalco_candidate_session=${candSecret}`, { ...CANDIDATE, name: 'Cross Candidate' });
  const asStaff = await (await raw('GET', '/api/internal-exam/' + staffLink.token, `lalco_staff_session=${candSecret}; lalco_candidate_session=${candSecret}`)).json();
  assert.equal(asStaff.state, 'ready', 'no access to anything');
  assert.equal(asStaff.questions, undefined);
  // An employee's secret on the recruitment link is a stranger there too.
  const emp = await raw('GET', '/api/internal-exam/' + staffLink.token);
  const empSecret = cookieOf(emp, 'lalco_staff_session');
  await raw('POST', `/api/internal-exam/${staffLink.token}/start`, `lalco_staff_session=${empSecret}`, { name: 'Cross Staff', employee_id: 'EMP-X' });
  const asCand = await (await raw('GET', '/api/exam/' + recLink.token, `lalco_candidate_session=${empSecret}; lalco_staff_session=${empSecret}`)).json();
  assert.equal(asCand.state, 'ready');
  assert.equal((await raw('PUT', `/api/exam/${recLink.token}/answer`, `lalco_candidate_session=${empSecret}`, { question_id: 1, answer: 'A' })).status, 409);
  // A candidate cookie cannot use the admin API (internal or recruitment).
  assert.equal((await raw('GET', '/api/admin/internal/staff', `lalco_candidate_session=${candSecret}`)).status, 401);
  assert.equal((await raw('GET', '/api/admin/internal/dashboard', `lalco_staff_session=${empSecret}`)).status, 401);
  assert.equal(count("SELECT COUNT(*) AS n FROM candidates WHERE name = 'Cross Staff'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM internal_staff WHERE name = 'Cross Candidate'"), 0);
});

test('single-use link, disable / enable / regenerate / delete, timer and auto-submit', async () => {
  const once = (await admin.post('/api/admin/internal/links', { ...STAFF_LINK, reusable: false })).data;
  assert.equal(once.reusable, 0);
  const first = client();
  await first.get('/api/internal-exam/' + once.token);
  const s = (await first.post(`/api/internal-exam/${once.token}/start`, { name: 'Only One', employee_id: 'EMP-ONCE' })).data;
  assert.equal(s.state, 'in_progress');
  const second = client();
  assert.equal((await second.get('/api/internal-exam/' + once.token)).data.state, 'used');
  assert.equal((await second.post(`/api/internal-exam/${once.token}/start`, { name: 'Second', employee_id: 'EMP-TWO' })).status, 409);
  assert.equal((await first.get('/api/internal-exam/' + once.token)).data.state, 'in_progress', 'the first employee carries on');
  // Timer: the server ends the test when its deadline passes.
  const aid = db.prepare("SELECT a.id FROM assessments a JOIN internal_staff s ON s.id = a.staff_id WHERE s.employee_key = 'EMP-ONCE'").get().id;
  db.prepare("UPDATE assessments SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(aid);
  db.prepare("UPDATE assessment_stages SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE assessment_id = ?").run(aid);
  const after = (await first.get('/api/internal-exam/' + once.token)).data;
  // The IQ test is submitted and scored by the server (pass mark 0: the next test waits, as in recruitment).
  assert.deepEqual([after.state, after.auto_submitted, after.passed_section], ['next_test', true, 'IQ']);
  assert.equal((await first.put(`/api/internal-exam/${once.token}/answer`, { question_id: s.questions[0].id, answer: 'A' })).status, 409);

  const l = (await admin.post('/api/admin/internal/links', STAFF_LINK)).data;
  assert.equal((await admin.post(`/api/admin/internal/links/${l.id}/disable`)).data.share_state, 'disabled');
  assert.equal((await client().get('/api/internal-exam/' + l.token)).data.state, 'disabled');
  assert.equal((await admin.post(`/api/admin/internal/links/${l.id}/enable`)).data.share_state, 'open');
  const re = (await admin.post(`/api/admin/internal/links/${l.id}/regenerate`)).data;
  assert.notEqual(re.token, l.token);
  assert.equal((await client().get('/api/internal-exam/' + l.token)).status, 404);
  assert.deepEqual((await admin.del('/api/admin/internal/links/' + l.id)).data, { ok: true });
  assert.equal((await admin.post(`/api/admin/internal/links/${once.id}/regenerate`)).status, 400, 'a used link keeps its address');
  assert.equal((await admin.del('/api/admin/internal/links/' + once.id)).status, 400, 'a used link is kept with its results');
  // Essay marking goes through the internal route only.
  assert.equal((await admin.put(`/api/admin/assessments/${aid}/essay-marks`, { marks: {} })).status, 404);
  assert.match((await admin.put(`/api/admin/internal/results/${aid}/essay-marks`, { marks: {} })).data.error, /after the assessment is submitted/, 'the internal route reaches it (same engine rule)');
  // Deleting a staff record removes their attempts (like a candidate) and nothing else.
  const staffId = db.prepare("SELECT id FROM internal_staff WHERE employee_key = 'EMP-ONCE'").get().id;
  assert.deepEqual((await admin.del('/api/admin/internal/staff/' + staffId)).data, { ok: true });
  assert.equal(count('SELECT COUNT(*) AS n FROM assessments WHERE id = ?', aid), 0);
});

test('admin login is required for every internal route', async () => {
  const anon = client();
  for (const u of ['/api/admin/internal/dashboard', '/api/admin/internal/staff', '/api/admin/internal/links', '/api/admin/internal/results', '/api/admin/internal/export/results.xlsx']) {
    assert.equal((await anon.get(u)).status, 401, u);
  }
  assert.equal((await anon.post('/api/admin/internal/staff', { name: 'x', employee_id: 'y' })).status, 401);
});

test('answer required: counted for every Calculation-format test type, not only the core one', async () => {
  const t = (await admin.post('/api/admin/test-types', { name: 'Finance Maths', behavior: 'calculation' })).data;
  const r = await admin.post('/api/admin/questions/import', { questions: [
    { section: t.key, question_text: 'What is 12% of 500?' },
    { section: t.key, question_text: 'What is 3 x 7?', correct_answer: '21' },
  ] });
  assert.deepEqual(r.data, { imported: 2, skipped: 0, answer_required: 1 });
  const waiting = (await admin.get('/api/admin/questions?status=needs_answer')).data;
  assert.ok(waiting.questions.some((q) => q.section === t.key && q.question_text === 'What is 12% of 500?'));
  assert.ok(waiting.needs_answer >= 1);
});
