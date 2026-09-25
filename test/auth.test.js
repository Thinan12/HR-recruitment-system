const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, client } = require('./helpers');

test.before(start);
test.after(stop);

test('health check responds', async () => {
  const r = await client().get('/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { status: 'ok', database: 'connected' });
});

test('admin login works and sets an httpOnly cookie', async () => {
  const c = client();
  const r = await c.login();
  assert.equal(r.data.username, 'admin');
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  const me = await c.get('/api/admin/auth/me');
  assert.equal(me.status, 200);
});

test('invalid login is rejected', async () => {
  const r = await client().post('/api/admin/auth/login', { username: 'admin', password: 'wrong' });
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'Incorrect username or password.');
});

test('admin pages are blocked without login', async () => {
  const c = client();
  for (const url of ['/api/admin/dashboard', '/api/admin/candidates', '/api/admin/questions', '/api/admin/assessments', '/api/admin/export/candidates.xlsx']) {
    const r = await c.get(url);
    assert.equal(r.status, 401, url);
  }
  const forged = await fetch((await start()) + '/api/admin/dashboard', { headers: { Cookie: 'hr_session=not-a-real-token' } });
  assert.equal(forged.status, 401);
});

test('logout ends the session', async () => {
  const c = client();
  await c.login();
  await c.post('/api/admin/auth/logout');
  assert.equal((await c.get('/api/admin/dashboard')).status, 401);
});

test('password is stored as a bcrypt hash, and can be changed', async () => {
  const { db } = require('./helpers');
  const row = db.prepare("SELECT password_hash FROM admins WHERE username = 'admin'").get();
  assert.match(row.password_hash, /^\$2[aby]\$/);
  assert.ok(!row.password_hash.includes('test-password-1'));

  const c = client();
  await c.login();
  assert.equal((await c.post('/api/admin/auth/password', { current_password: 'nope', new_password: 'another-pass-1' })).status, 400);
  assert.equal((await c.post('/api/admin/auth/password', { current_password: 'test-password-1', new_password: 'another-pass-1' })).status, 200);
  assert.equal((await c.post('/api/admin/auth/login', { username: 'admin', password: 'another-pass-1' })).status, 200);
  await c.post('/api/admin/auth/password', { current_password: 'another-pass-1', new_password: 'test-password-1' });
});

test('security headers are sent', async () => {
  const r = await client().get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('unknown errors never leak details', async () => {
  const r = await fetch((await start()) + '/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'Invalid request.' });
});
