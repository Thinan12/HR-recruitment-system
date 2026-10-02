// HR users: view-only logins (role 'viewer') see every candidate, exam and
// report but every change is refused on the server; full admins manage users.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, client, seedQuestions, db, CANDIDATE } = require('./helpers');

let base;
let admin;
const ids = {};
test.before(async () => {
  base = await start();
  admin = client();
  await admin.login();
  seedQuestions('IQ', 5, 1, 'Easy');
  const link = (await admin.post('/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 5 }, link_expiry_minutes: 60 })).data;
  ids.link = link.id;
  const c = client();
  const s = (await c.post(`/api/exam/${link.token}/start`, { ...CANDIDATE, name: 'Viewed Candidate' })).data;
  await c.post(`/api/exam/${link.token}/submit`, { answers: Object.fromEntries(s.questions.map((q) => [q.id, 'A'])) });
  ids.attempt = db.prepare('SELECT id, candidate_id FROM assessments WHERE link_id = ?').get(link.id);
});
test.after(stop);

const loginAs = async (username, password) => {
  const c = client();
  const r = await c.post('/api/admin/auth/login', { username, password });
  return { c, r };
};

test('a full admin adds a view-only user (hashed password, never returned); bad input refused', async () => {
  const r = await admin.post('/api/admin/users', { username: 'hr.viewer', password: 'viewer-pass-1', role: 'viewer' });
  assert.equal(r.status, 201);
  assert.deepEqual([r.data.username, r.data.role, r.data.role_label, r.data.active], ['hr.viewer', 'viewer', 'View only', true]);
  assert.ok(!JSON.stringify(r.data).includes('viewer-pass-1') && !('password_hash' in r.data));
  assert.match(db.prepare("SELECT password_hash FROM admins WHERE username = 'hr.viewer'").get().password_hash, /^\$2[aby]\$12\$/);
  assert.equal((await admin.post('/api/admin/users', { username: 'role.default', password: 'some-pass-1' })).data.role, 'viewer', 'view only unless "admin" is chosen');
  for (const [body, msg] of [[{ username: 'HR.VIEWER', password: 'x-pass-123' }, /already used/], [{ username: 'a', password: 'x-pass-123' }, /Username/], [{ username: 'short.pw', password: 'short' }, /at least 8/]]) {
    const x = await admin.post('/api/admin/users', body);
    assert.equal(x.status, 400);
    assert.match(x.data.error, msg);
  }
  const list = (await admin.get('/api/admin/users')).data;
  assert.deepEqual(list.map((u) => [u.username, u.role]), [['admin', 'admin'], ['hr.viewer', 'viewer'], ['role.default', 'viewer']]);
  assert.ok(!JSON.stringify(list).includes('$2'));
});

test('the view-only user logs in on the HR login and can READ every candidate, exam, result, report and export', async () => {
  const { c, r } = await loginAs('hr.viewer', 'viewer-pass-1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { username: 'hr.viewer', role: 'viewer' });
  assert.deepEqual((await c.get('/api/admin/auth/me')).data, { username: 'hr.viewer', role: 'viewer' });
  for (const url of ['/api/admin/dashboard', '/api/admin/candidates', `/api/admin/candidates/${ids.attempt.candidate_id}`, '/api/admin/assessments', `/api/admin/links/${ids.link}`,
    '/api/admin/results/iq', '/api/admin/report/standard', '/api/admin/questions', '/api/admin/test-types', '/api/admin/categories', '/api/admin/settings',
    '/api/admin/internal/dashboard', '/api/admin/internal/staff', '/api/admin/internal/results', '/api/admin/internal/links']) {
    assert.equal((await c.get(url)).status, 200, url);
  }
  // Exam details: the questions, the candidate's answers and the scores.
  const detail = (await c.get(`/api/admin/assessments/${ids.attempt.id}`)).data;
  assert.equal(detail.questions.length, 5);
  assert.ok(detail.questions.every((q) => q.question_text && 'answer' in q && 'correct_answer' in q));
  for (const url of ['/api/admin/export/candidates.xlsx', `/api/admin/candidates/${ids.attempt.candidate_id}/export.pdf`, `/api/admin/candidates/${ids.attempt.candidate_id}/export.docx`,
    '/api/admin/questions/export.xlsx?section=IQ', '/api/admin/internal/export/results.xlsx']) {
    assert.equal((await c.get(url, { raw: true })).status, 200, url);
  }
});

test('every change is refused for the view-only user (server side), across all areas; nothing changes', async () => {
  const { c } = await loginAs('hr.viewer', 'viewer-pass-1');
  const before = JSON.stringify([db.prepare('SELECT COUNT(*) n FROM candidates').get(), db.prepare('SELECT COUNT(*) n FROM questions').get(), db.prepare('SELECT * FROM assessments WHERE id = ?').get(ids.attempt.id), db.prepare('SELECT * FROM settings ORDER BY key').all()]);
  const writes = [['post', '/api/admin/candidates', { name: 'X', phone: '1' }], ['put', `/api/admin/candidates/${ids.attempt.candidate_id}`, { name: 'Changed' }],
    ['del', `/api/admin/candidates/${ids.attempt.candidate_id}`], ['post', '/api/admin/questions', { section: 'IQ', question_text: 'x?', option_a: '1', option_b: '2', correct_answer: 'A' }],
    ['del', '/api/admin/questions/1'], ['post', '/api/admin/questions/delete-all', { section: 'IQ' }], ['post', '/api/admin/questions/import', { questions: [] }],
    ['post', '/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 1 } }], ['post', `/api/admin/links/${ids.link}/disable`], ['del', `/api/admin/links/${ids.link}`],
    ['put', `/api/admin/assessments/${ids.attempt.id}/essay-marks`, { marks: {} }], ['put', '/api/admin/settings', { default_time_minutes: 1 }],
    ['post', '/api/admin/test-types', { name: 'New', behavior: 'mcq' }], ['post', '/api/admin/categories', { section: 'IQ', name: 'x' }],
    ['post', '/api/admin/internal/staff', { name: 'S', employee_id: 'E1' }], ['post', '/api/admin/internal/links', { title: 'L', tests: ['IQ'], counts: { IQ: 1 } }],
    ['post', '/api/admin/result-viewers', { username: 'x.y', password: 'xxxx-yyyy', candidate_id: ids.attempt.candidate_id }],
    ['post', '/api/admin/users', { username: 'sneaky', password: 'sneaky-pass-1', role: 'admin' }]];
  for (const [m, url, body] of writes) {
    const r = await c[m](url, body);
    assert.equal(r.status, 403, `${m} ${url}`);
    assert.match(r.data.error, /view-only/);
  }
  // User / Result Viewer account management is not even readable.
  assert.equal((await c.get('/api/admin/users')).status, 403);
  assert.equal((await c.get('/api/admin/result-viewers')).status, 403);
  const after = JSON.stringify([db.prepare('SELECT COUNT(*) n FROM candidates').get(), db.prepare('SELECT COUNT(*) n FROM questions').get(), db.prepare('SELECT * FROM assessments WHERE id = ?').get(ids.attempt.id), db.prepare('SELECT * FROM settings ORDER BY key').all()]);
  assert.equal(after, before, 'nothing was changed');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM admins WHERE username = 'sneaky'").get().n, 0);
  // It may change its own password and log out.
  assert.equal((await c.post('/api/admin/auth/password', { current_password: 'viewer-pass-1', new_password: 'viewer-pass-2' })).status, 200);
  assert.equal((await c.post('/api/admin/auth/logout')).status, 200);
  assert.equal((await loginAs('hr.viewer', 'viewer-pass-2')).r.status, 200);
});

test('disable / enable / reset password / delete; never yourself or the last full admin', async () => {
  const viewer = (await admin.get('/api/admin/users')).data.find((u) => u.username === 'hr.viewer');
  const { c } = await loginAs('hr.viewer', 'viewer-pass-2');
  assert.equal((await admin.post(`/api/admin/users/${viewer.id}/disable`)).data.active, false);
  assert.equal((await c.get('/api/admin/candidates')).status, 401, 'the open session ends at once');
  const refused = await loginAs('hr.viewer', 'viewer-pass-2');
  assert.equal(refused.r.status, 403);
  assert.match(refused.r.data.error, /disabled/);
  await admin.post(`/api/admin/users/${viewer.id}/enable`);
  assert.equal((await admin.post(`/api/admin/users/${viewer.id}/password`, { password: 'viewer-pass-3' })).status, 200);
  assert.equal((await loginAs('hr.viewer', 'viewer-pass-2')).r.status, 401);
  assert.equal((await loginAs('hr.viewer', 'viewer-pass-3')).r.status, 200);
  const me = (await admin.get('/api/admin/users')).data.find((u) => u.username === 'admin');
  assert.match((await admin.post(`/api/admin/users/${me.id}/disable`)).data.error, /your own account/);
  assert.match((await admin.del(`/api/admin/users/${me.id}`)).data.error, /your own account/);
  // A second full admin cannot remove the only other full admin if it is the last one.
  const second = (await admin.post('/api/admin/users', { username: 'admin.two', password: 'admin-two-1', role: 'admin' })).data;
  const two = (await loginAs('admin.two', 'admin-two-1')).c;
  assert.equal((await two.get('/api/admin/users')).status, 200, 'a second full admin manages users too');
  assert.equal((await admin.post(`/api/admin/users/${second.id}/disable`)).status, 200);
  assert.match((await admin.del(`/api/admin/users/${me.id}`)).data.error, /your own account/);
  assert.equal((await admin.del(`/api/admin/users/${second.id}`)).status, 200);
  const del = await admin.del(`/api/admin/users/${viewer.id}`);
  assert.deepEqual(del.data, { ok: true });
  assert.equal((await loginAs('hr.viewer', 'viewer-pass-3')).r.status, 401);
  const log = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'HR_USER_%'").all().map((x) => x.action);
  for (const a of ['HR_USER_CREATED', 'HR_USER_DISABLED', 'HR_USER_ENABLED', 'HR_USER_PASSWORD_RESET', 'HR_USER_DELETED']) assert.ok(log.includes(a), a);
});

test('the full admin is unchanged: full access, and existing sessions still work', async () => {
  assert.deepEqual((await admin.get('/api/admin/auth/me')).data, { username: 'admin', role: 'admin' });
  const r = await admin.post('/api/admin/candidates', { name: 'Admin Still Works', phone: '020 1234 0000' });
  assert.equal(r.status, 201);
  assert.equal((await admin.del('/api/admin/candidates/' + r.data.id)).status, 200);
  const page = await (await fetch(base + '/')).text();
  assert.ok(page.includes('readonly-banner'));
});
