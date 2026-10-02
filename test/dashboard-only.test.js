// HR_DASHBOARD_ONLY (role 'dashboard'): logs in on the HR page, sees ONLY the
// candidate results table (the Dashboard's own table) and its two Excel
// exports. Everything else is a plain 404 on the server; nothing can change.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { start, stop, client, seedQuestions, db, CANDIDATE } = require('./helpers');

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
  db.prepare('INSERT INTO questions (section, question_text, marks, created_at) VALUES (?, ?, 10, ?)').run(BEH, 'Tell me about a team.', new Date().toISOString());
  db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES ('ESSAY', 'Why LALCO?', 10, ?)").run(new Date().toISOString());
  const link = (await admin.post('/api/admin/assessments', { tests: ['IQ', 'CALCULATION', 'ESSAY', BEH], counts: { IQ: 10, CALCULATION: 10, ESSAY: 1, [BEH]: 1 },
    link_expiry_minutes: 60, pass_marks: { IQ: 50, CALCULATION: 50, ESSAY: 50, [BEH]: 50 }, eligibility_mark: 60 })).data;
  const take = async (name, phone, right) => {
    const c = client();
    let s = (await c.post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name, phone })).data;
    while (s.state === 'in_progress') {
      const answers = Object.fromEntries(s.questions.map((q, i) => {
        const row = db.prepare('SELECT section, correct_answer FROM assessment_questions WHERE id = ?').get(q.id);
        if (!['IQ', 'CALCULATION'].includes(row.section)) return [q.id, 'My answer.'];
        return [q.id, i < right ? row.correct_answer : row.correct_answer === 'A' ? 'B' : 'A'];
      }));
      s = (await c.post(`/api/exam/${link.token}/submit`, { answers })).data;
      if (s.state === 'next_test') s = (await c.post(`/api/exam/${link.token}/continue`)).data;
    }
    return db.prepare('SELECT a.id, a.candidate_id FROM assessments a JOIN candidates c ON c.id = a.candidate_id WHERE c.name = ?').get(name);
  };
  ids.anna = await take('Dash Anna', '020 3333 0001', 8);
  ids.ben = await take('Dash Ben', '020 3333 0002', 9);
  // HR marks Anna's essay and interview answer; Ben's stay pending.
  const qs = db.prepare('SELECT id, section FROM assessment_questions WHERE assessment_id = ? AND section IN (?, ?)').all(ids.anna.id, 'ESSAY', BEH);
  await admin.put(`/api/admin/assessments/${ids.anna.id}/essay-marks`, { marks: Object.fromEntries(qs.map((q) => [q.id, 7])) });
  db.prepare("UPDATE candidates SET remark = 'PRIVATE HR REMARK', interview = 'PRIVATE INTERVIEW NOTE' WHERE id = ?").run(ids.anna.candidate_id);
});
test.after(stop);

const loginAs = async (username, password) => { const c = client(); const r = await c.post('/api/admin/auth/login', { username, password }); return { c, r }; };

test('a full admin creates the account (role HR_DASHBOARD_ONLY = "dashboard"), password hashed', async () => {
  const r = await admin.post('/api/admin/users', { username: 'hr.dash', password: 'dash-pass-1', role: 'HR_DASHBOARD_ONLY' });
  assert.equal(r.status, 201);
  assert.deepEqual([r.data.role, r.data.role_label, r.data.active], ['dashboard', 'Candidates dashboard only', true]);
  assert.match(db.prepare("SELECT password_hash FROM admins WHERE username = 'hr.dash'").get().password_hash, /^\$2[aby]\$12\$/);
  assert.equal((await admin.post('/api/admin/users', { username: 'hr.dash2', password: 'dash-pass-1', role: 'dashboard' })).data.role, 'dashboard');
});

test('1-4. login: correct password works (role "dashboard"), wrong fails, disabled cannot log in', async () => {
  const ok = await loginAs('hr.dash', 'dash-pass-1');
  assert.equal(ok.r.status, 200);
  assert.deepEqual(ok.r.data, { username: 'hr.dash', role: 'dashboard' });
  assert.equal((await loginAs('hr.dash', 'wrong-pass-1')).r.status, 401);
  const dash2 = (await admin.get('/api/admin/users')).data.find((u) => u.username === 'hr.dash2');
  await admin.post(`/api/admin/users/${dash2.id}/disable`);
  assert.equal((await loginAs('hr.dash2', 'dash-pass-1')).r.status, 403);
});

test('5-13. the candidates dashboard data: every result column of the existing table, the same values HR sees; no HR notes', async () => {
  const { c } = await loginAs('hr.dash', 'dash-pass-1');
  assert.deepEqual((await c.get('/api/admin/auth/me')).data, { username: 'hr.dash', role: 'dashboard' });
  assert.equal((await c.get('/api/admin/test-types')).status, 200, 'column headings');
  const r = await c.get('/api/admin/candidates-dashboard');
  assert.equal(r.status, 200);
  const anna = r.data.candidates.find((x) => x.name === 'Dash Anna');
  const ben = r.data.candidates.find((x) => x.name === 'Dash Ben');
  assert.ok(r.data.iq_classification.length > 0, 'IQ classification bands for the filter');
  // The same values as the full admin's Dashboard (same source, no recalculation).
  const full = (await admin.get('/api/admin/dashboard')).data.candidates.find((x) => x.name === 'Dash Anna');
  const t = (x, sec) => x.tests.find((y) => y.section === sec);
  for (const sec of ['IQ', 'CALCULATION', 'ESSAY', BEH]) {
    const a = t(anna, sec);
    const f = t(full, sec);
    assert.deepEqual([a.score_text, a.lalco_iq_score, a.percent, a.level, a.state, a.result], [f.score_text, f.lalco_iq_score, f.percent, f.level, f.state, f.result], sec);
  }
  assert.deepEqual([t(anna, 'IQ').score_text, t(anna, 'IQ').lalco_iq_score, t(anna, 'IQ').percent, t(anna, 'IQ').level, t(anna, 'IQ').result], ['8 / 10', 120, 80, 'Superior', 'Pass']);
  assert.deepEqual([t(anna, BEH).score_text, t(anna, BEH).percent, t(anna, BEH).result], ['7 / 10', 70, 'Pass']);
  assert.deepEqual([t(anna, 'CALCULATION').score_text, t(anna, 'CALCULATION').result], ['8 / 10', 'Pass']);
  assert.deepEqual([t(anna, 'ESSAY').score_text, t(anna, 'ESSAY').result], ['7 / 10', 'Pass']);
  assert.deepEqual([anna.eligibility, full.eligibility, anna.final_percent_text, anna.final_level, anna.final_result], ['Eligible', 'Eligible', full.final_percent_text, full.final_level, full.final_result]);
  assert.deepEqual([t(ben, 'ESSAY').state, t(ben, 'ESSAY').result, ben.eligibility], ['PENDING HR MARKING', 'Pending', 'Pending'], 'PENDING shown, never 0');
  const text = JSON.stringify(r.data);
  for (const bad of ['PRIVATE HR REMARK', 'PRIVATE INTERVIEW NOTE', 'question', 'answer', 'review_required', 'pass_mark', 'reference_results', 'chairman']) assert.ok(!text.includes(bad), 'not sent: ' + bad);
});

test('15-16. Excel export and Detailed Excel work', async () => {
  const { c } = await loginAs('hr.dash', 'dash-pass-1');
  for (const q of ['', '?detail=full']) {
    const x = await c.get('/api/admin/export/candidates.xlsx' + q, { raw: true });
    assert.equal(x.status, 200, q);
    assert.match(x.headers.get('content-type'), /spreadsheetml/);
    const rows = XLSX.utils.sheet_to_json(XLSX.read(x.buffer).Sheets.Candidates);
    assert.ok(rows.some((r) => r['Candidate Name'] === 'Dash Anna'), q);
  }
});

test('17-23. everything else is a plain 404 and nothing can change (server side)', async () => {
  const { c } = await loginAs('hr.dash', 'dash-pass-1');
  const before = JSON.stringify([db.prepare('SELECT * FROM candidates ORDER BY id').all(), db.prepare('SELECT * FROM assessments ORDER BY id').all(), db.prepare('SELECT * FROM assessment_stages ORDER BY id').all(), db.prepare('SELECT COUNT(*) n FROM questions').get(), db.prepare('SELECT * FROM settings ORDER BY key').all()]);
  const blocked = [
    // 17-18. candidates: no profile, edit, create, delete; no marking
    ['get', '/api/admin/candidates'], ['get', `/api/admin/candidates/${ids.anna.candidate_id}`], ['put', `/api/admin/candidates/${ids.anna.candidate_id}`, { name: 'X' }],
    ['post', '/api/admin/candidates', { name: 'X', phone: '1' }], ['del', `/api/admin/candidates/${ids.anna.candidate_id}`],
    ['get', `/api/admin/candidates/${ids.anna.candidate_id}/export.pdf`], ['get', `/api/admin/assessments/${ids.anna.id}`], ['put', `/api/admin/assessments/${ids.ben.id}/essay-marks`, { marks: {} }],
    // 19. questions
    ['get', '/api/admin/questions'], ['get', '/api/admin/questions/export.xlsx?section=IQ'], ['post', '/api/admin/questions', { section: 'IQ', question_text: 'x' }], ['post', '/api/admin/questions/delete-all', { section: 'IQ' }],
    ['get', '/api/admin/questions/template.xlsx'], ['post', '/api/admin/questions/import', { questions: [] }], ['get', '/api/admin/categories'],
    // 20. assessments and links
    ['get', '/api/admin/assessments'], ['post', '/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 1 } }], ['get', '/api/admin/links/1'], ['post', '/api/admin/links/1/disable'],
    // 21. settings, users, other management
    ['get', '/api/admin/settings'], ['put', '/api/admin/settings', {}], ['get', '/api/admin/users'], ['post', '/api/admin/users', { username: 'x.y', password: 'xxxxxxxx', role: 'admin' }],
    ['get', '/api/admin/result-viewers'], ['post', '/api/admin/auth/password', { current_password: 'dash-pass-1', new_password: 'whatever-12' }],
    // 22. internal staff
    ['get', '/api/admin/internal/dashboard'], ['get', '/api/admin/internal/staff'], ['get', '/api/admin/internal/results'], ['get', '/api/admin/internal/links'], ['get', '/api/admin/internal/export/results.xlsx'],
    // 23. the main dashboard, other reports and admin APIs
    ['get', '/api/admin/dashboard'], ['get', '/api/admin/report/standard'], ['get', '/api/admin/results/iq'], ['get', '/api/admin/test-types/IQ'], ['post', '/api/admin/test-types', { name: 'x', behavior: 'mcq' }],
    ['get', '/api/admin/no-such-endpoint'],
  ];
  for (const [m, url, body] of blocked) {
    const r = await c[m](url, body);
    assert.equal(r.status, 404, `${m} ${url}`);
    assert.deepEqual(r.data, { error: 'Not found.' }, `no details: ${m} ${url}`);
  }
  // The same through a raw request with other methods.
  for (const method of ['PATCH', 'PUT', 'DELETE', 'POST']) {
    assert.equal((await c[{ PATCH: 'put', PUT: 'put', DELETE: 'del', POST: 'post' }[method]]('/api/admin/candidates-dashboard', {})).status, 404, method + ' on the dashboard data');
  }
  const after = JSON.stringify([db.prepare('SELECT * FROM candidates ORDER BY id').all(), db.prepare('SELECT * FROM assessments ORDER BY id').all(), db.prepare('SELECT * FROM assessment_stages ORDER BY id').all(), db.prepare('SELECT COUNT(*) n FROM questions').get(), db.prepare('SELECT * FROM settings ORDER BY key').all()]);
  assert.equal(after, before, 'no candidate, result, question or setting changed');
  // Logout works; the session ends.
  assert.equal((await c.post('/api/admin/auth/logout')).status, 200);
  assert.equal((await c.get('/api/admin/candidates-dashboard')).status, 401);
});

test('disabling ends an open session at once', async () => {
  const { c } = await loginAs('hr.dash', 'dash-pass-1');
  const u = (await admin.get('/api/admin/users')).data.find((x) => x.username === 'hr.dash');
  await admin.post(`/api/admin/users/${u.id}/disable`);
  assert.equal((await c.get('/api/admin/candidates-dashboard')).status, 401);
  await admin.post(`/api/admin/users/${u.id}/enable`);
});

test('24. full admins and view-only users are unchanged', async () => {
  assert.deepEqual((await admin.get('/api/admin/auth/me')).data, { username: 'admin', role: 'admin' });
  for (const url of ['/api/admin/dashboard', '/api/admin/candidates', '/api/admin/questions', '/api/admin/settings', '/api/admin/users', '/api/admin/candidates-dashboard']) assert.equal((await admin.get(url)).status, 200, url);
  const r = await admin.post('/api/admin/candidates', { name: 'Admin Can Still Add', phone: '020 9999 0001' });
  assert.equal(r.status, 201);
  assert.equal((await admin.del('/api/admin/candidates/' + r.data.id)).status, 200);
  await admin.post('/api/admin/users', { username: 'hr.view', password: 'view-pass-1', role: 'viewer' });
  const v = (await loginAs('hr.view', 'view-pass-1')).c;
  assert.equal((await v.get('/api/admin/candidates')).status, 200, 'a view-only user still reads everything');
  assert.equal((await v.post('/api/admin/candidates', { name: 'x', phone: '1' })).status, 403);
  const page = await (await fetch(base + '/static/admin.js')).text();
  assert.ok(page.includes('renderCandidatesDashboard') && page.includes("location.hash = '#/candidates'"));
});
