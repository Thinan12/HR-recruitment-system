// Shared test setup: a fresh temporary database per test file and a small
// HTTP client that keeps the admin session cookie.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `lalco-hr-test-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = dbFile;
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-password-1';
process.env.NODE_ENV = 'test';

const app = require('../src/app');
const { ensureFirstAdmin } = require('../src/auth');
const { db } = require('../src/db');

ensureFirstAdmin();

process.on('exit', () => {
  try { db.close(); } catch { /* ignore */ }
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
});

let server;
let base;

async function start() {
  if (server) return base;
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

function stop() {
  if (server) server.close();
  server = null;
}

function client() {
  let cookie = '';
  async function request(method, url, body, { form, raw } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (u, o) => request('GET', u, undefined, o),
    post: (u, b, o) => request('POST', u, b, o),
    put: (u, b) => request('PUT', u, b),
    del: (u) => request('DELETE', u),
    async login() {
      const r = await request('POST', '/api/admin/auth/login', { username: 'admin', password: 'test-password-1' });
      if (r.status !== 200) throw new Error('login failed');
      return r;
    },
  };
}

function upload(fileBuffer, name, section) {
  const form = new FormData();
  form.append('section', section || 'IQ');
  form.append('file', new Blob([fileBuffer]), name);
  return form;
}

// Adds n simple multiple-choice questions straight into the bank.
function seedQuestions(section, n, marks = 1) {
  const insert = db.prepare(`INSERT INTO questions (section, question_text, option_a, option_b, option_c, option_d, correct_answer, marks, created_at)
    VALUES (?, ?, 'opt A', 'opt B', 'opt C', 'opt D', ?, ?, ?)`);
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(insert.run(section, `${section} question ${i + 1}`, 'ABCD'[i % 4], marks, new Date().toISOString()).lastInsertRowid);
  return ids;
}

const CANDIDATE = {
  name: 'Test Candidate', phone: '020 5555 1234', graduate_from: 'University', high_school: 'Vientiane High School',
  college: '', university: 'National University of Laos', school_name: 'NUOL', subject: 'Accounting', gpa: '3.4',
};

module.exports = { start, stop, client, upload, seedQuestions, db, CANDIDATE };
