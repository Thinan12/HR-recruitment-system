// Builds the Postman collection (v2.1) and environments for the LALCO HR API.
// The requests below were written from the routes in src/app.js,
// src/routes/admin.js and src/routes/exam.js (the source is the source of truth).
// Run from the repository root:  node postman/tools/build-collection.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAME = 'LALCO HR Recruitment System';

// ---- script helpers ------------------------------------------------------------
// Scripts are written as functions so Node checks their syntax; only the body is
// copied into the collection. P = the parameters given for that request.
function body(fn) {
  const s = fn.toString();
  const lines = s.slice(s.indexOf('{') + 1, s.lastIndexOf('}')).split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent));
}
const PREFACE = [
  "const env = (k) => pm.environment.get(k);",
  "const set = (k, v) => pm.environment.set(k, typeof v === 'string' ? v : JSON.stringify(v));",
  "const getJSON = (k) => { try { return JSON.parse(pm.environment.get(k)); } catch (e) { return null; } };",
];
const JSON_BODY = ["let body = null;", "try { body = pm.response.json(); } catch (e) { body = null; }"];

const MIME = {
  json: 'application/json', pdf: 'application/pdf', png: 'image/png',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const MAGIC = { pdf: '%PDF-', docx: 'PK', xlsx: 'PK', png: '\u0089PNG' };

const inventory = []; // method + path of every request, for the report

// One request. o:
//   q        query parameters {key: value}
//   json     JSON body (object or raw string)
//   form     multipart fields [{key, value} | {key, src}]
//   headers  extra headers {name: value}
//   cand     'A' | 'B' | ... : a candidate session (own cookie, no cookie jar)
//   noAuth   true: no cookies at all (tests without a session); cookie: an explicit Cookie header
//   status   expected status (number or array)
//   type     'json' (default) | 'pdf' | 'docx' | 'xlsx' | 'png'
//   error    text the JSON error / message must contain
//   pre/test functions (bodies copied), P parameters, only 'LOCAL' (skipped elsewhere)
//   maxMs    response time limit (default 3000 ms)
function req(name, method, apiPath, o = {}) {
  const type = o.type || 'json';
  const status = o.status ?? 200;
  const headers = [];
  const url = { raw: '{{baseUrl}}' + apiPath, host: ['{{baseUrl}}'], path: apiPath.replace(/^\//, '').split('/') };
  if (o.q) {
    url.query = Object.entries(o.q).map(([key, value]) => ({ key, value: String(value) }));
    url.raw += '?' + url.query.map((x) => `${x.key}=${x.value}`).join('&');
  }
  let bodySpec;
  if (o.json !== undefined) {
    headers.push({ key: 'Content-Type', value: 'application/json' });
    bodySpec = { mode: 'raw', raw: typeof o.json === 'string' ? o.json : JSON.stringify(o.json, null, 2), options: { raw: { language: 'json' } } };
  } else if (o.form) {
    bodySpec = { mode: 'formdata', formdata: o.form.map((f) => (f.src !== undefined ? { key: f.key, type: 'file', src: f.src } : { key: f.key, value: f.value, type: 'text' })) };
  }
  for (const [key, value] of Object.entries(o.headers || {})) headers.push({ key, value });
  const cookieOff = !!(o.cand || o.staff || o.noAuth || o.cookie);
  // Internal staff session: own cookie name; staff A uses internalStaffSession, others internalStaffSession<X>.
  const staffVar = o.staff ? 'internalStaffSession' + (o.staff === 'A' ? '' : o.staff) : null;
  if (o.staff) headers.push({ key: 'Cookie', value: `lalco_staff_session={{${staffVar}}}` });
  if (o.cand) headers.push({ key: 'Cookie', value: `lalco_candidate_session={{candidateSession${o.cand}}}` });
  if (o.cookie) headers.push({ key: 'Cookie', value: o.cookie });

  const P = o.P ? [`const P = ${JSON.stringify(o.P)};`] : [];
  const pre = [...PREFACE, ...P];
  if (o.only) pre.push(`if ((env('mode') || 'PRODUCTION') !== '${o.only}') { console.log('Skipped: this request only runs when mode = ${o.only}.'); pm.execution.skipRequest(); }`);
  if (o.maxMs) pre.push(`pm.variables.set('maxMs', ${o.maxMs});`);
  for (const f of [].concat(o.pre || [])) pre.push(...body(f));

  const t = [...PREFACE, ...P, ...(type === 'json' || type === 'any' ? JSON_BODY : [])];
  const codes = [].concat(status);
  t.push(codes.length === 1
    ? `pm.test('Status is ${codes[0]}', () => pm.response.to.have.status(${codes[0]}));`
    : `pm.test('Status is one of ${codes.join(' / ')}', () => pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(codes)}));`);
  if (type === 'any') {
    // this request checks its own content type (it depends on the data)
  } else if (type === 'json') {
    t.push("pm.test('Content-Type is application/json', () => pm.expect(pm.response.headers.get('Content-Type') || '').to.include('application/json'));");
    t.push("pm.test('Body is valid JSON', () => pm.expect(body, 'response body is not JSON').to.not.equal(null));");
  } else {
    t.push(`pm.test('Content-Type is ${MIME[type]}', () => pm.expect(pm.response.headers.get('Content-Type') || '').to.include('${MIME[type]}'));`);
    t.push("pm.test('File is not empty', () => pm.expect(pm.response.stream ? pm.response.stream.length : pm.response.responseSize).to.be.above(0));");
    t.push(`pm.test('File starts like a real ${type.toUpperCase()}', () => pm.expect(pm.response.stream.slice(0, ${MAGIC[type].length}).toString('latin1')).to.equal(${JSON.stringify(MAGIC[type])}));`);
    if (type !== 'png') t.push(`pm.test('Sent as a download with a .${type} file name', () => pm.expect(pm.response.headers.get('Content-Disposition') || '').to.match(/attachment; filename=".+\\.${type}"/));`);
  }
  if (o.error) t.push(`pm.test('Error message says: ${o.error.replace(/'/g, '')}', () => pm.expect(String((body && (body.error || body.message)) || '')).to.include(${JSON.stringify(o.error)}));`);
  if (o.staff) {
    t.push(...body(() => {
      // Keep this employee's own session cookie (the cookie jar is off for staff requests).
      for (const h of pm.response.headers.all()) {
        const m = h.key.toLowerCase() === 'set-cookie' && /lalco_staff_session=([^;]+)/.exec(h.value);
        if (m) pm.environment.set(STAFFVAR, m[1]);
      }
    }).map((l) => l.replace('STAFFVAR', JSON.stringify(staffVar))));
  }
  if (o.cand) {
    t.push(...body(() => {
      // Keep this candidate's own session cookie (the cookie jar is off for candidate requests).
      for (const h of pm.response.headers.all()) {
        const m = h.key.toLowerCase() === 'set-cookie' && /lalco_candidate_session=([^;]+)/.exec(h.value);
        if (m) pm.environment.set('candidateSession' + CAND, m[1]);
      }
    }).map((l) => l.replace('CAND', JSON.stringify(o.cand))));
  }
  for (const f of [].concat(o.test || [])) t.push(...body(f));

  inventory.push(`${method} ${apiPath}`);
  const auth = o.staff ? `Internal staff session cookie \`lalco_staff_session\` of staff member ${o.staff} (cookie jar off)` : o.cand ? `Candidate session cookie \`lalco_candidate_session\` of candidate ${o.cand} (cookie jar off)`
    : o.noAuth ? 'None — sent without any cookie on purpose' : o.cookie ? `Explicit cookie: \`${o.cookie}\` (cookie jar off)`
      : apiPath.startsWith('/api/admin') && !/auth\/login$/.test(apiPath) ? 'Admin session cookie `hr_session` (set by POST Admin Login, kept by the cookie jar)' : 'None';
  const input = [o.q && `query: ${Object.keys(o.q).join(', ')}`, o.json !== undefined && 'JSON body', o.form && `multipart form: ${o.form.map((f) => f.key + (f.src ? ` (file ${f.src})` : '')).join(', ')}`].filter(Boolean).join('; ') || 'none';
  const description = [`**Purpose:** ${o.desc || name}`, `**Authentication:** ${auth}`, `**Input:** ${input}`,
    `**Expected:** HTTP ${codes.join(' or ')}, ${type === 'json' ? 'JSON' : type === 'any' ? 'image/png or JSON (see the tests)' : MIME[type]}${o.error ? ` — error contains “${o.error}”` : ''}`,
    o.notes ? `**Notes:** ${o.notes}` : null, o.only ? `**Runs only when mode = ${o.only}** (skipped on production).` : null].filter(Boolean).join('\n\n');

  const request = { method, header: headers, url, description };
  if (bodySpec) request.body = bodySpec;
  const it = { name, event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } }, { listen: 'test', script: { type: 'text/javascript', exec: t } }], request };
  if (cookieOff) it.protocolProfileBehavior = { disableCookies: true };
  return it;
}
const folder = (name, description, item) => ({ name, description, item });
const file = (name) => ({ key: 'file', src: 'fixtures/' + name });
const preview = (name, fixture, section, o = {}) => req(name, 'POST', '/api/admin/questions/import/preview', { form: [{ key: 'section', value: section }, file(fixture)], maxMs: 10000, ...o });

// A 1 x 1 PNG (the same picture every run, so the image store deduplicates it).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ================================================================================
// 01 Health
// ================================================================================
const health = folder('01 Health', 'The health endpoint Railway uses. No login.', [
  req('GET Health Check', 'GET', '/api/health', {
    desc: 'Server and database are up. Also starts the run: a unique tag for this run\'s temporary data.',
    pre: () => {
      if (!pm.environment.get('baseUrl')) throw new Error('Select the "LALCO HR Recruitment System" environment first (baseUrl is not set).');
    },
    test: () => {
      pm.test('status = ok', () => pm.expect(body.status).to.equal('ok'));
      pm.test('database = connected', () => pm.expect(body.database).to.equal('connected'));
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      set('runTag', 'POSTMAN TEST ' + stamp);
      set('runStamp', 'PM' + stamp);
      console.log('Run tag:', env('runTag'), '| mode:', env('mode') || 'PRODUCTION (default)');
    },
  }),
]);

// ================================================================================
// 02 Authentication
// ================================================================================
const authFolder = folder('02 Authentication', 'Admin login uses an httpOnly JWT cookie `hr_session` (12 h). Postman\'s cookie jar keeps it for every later admin request. Failed logins are rate limited (10 per IP per 15 minutes; a successful login resets it).', [
  req('POST Admin Login — missing username', 'POST', '/api/admin/auth/login', { noAuth: true, json: { password: '{{adminPassword}}' }, status: 401, error: 'Incorrect username or password.' }),
  req('POST Admin Login — wrong password', 'POST', '/api/admin/auth/login', { noAuth: true, json: { username: '{{adminUsername}}', password: '{{adminPassword}}-wrong' }, status: 401, error: 'Incorrect username or password.' }),
  req('GET Current Admin — no session', 'GET', '/api/admin/auth/me', { noAuth: true, status: 401, error: 'Please log in.' }),
  req('GET Current Admin — invalid session token', 'GET', '/api/admin/auth/me', { cookie: 'hr_session=not.a.valid-token', status: 401, error: 'Your session has ended' }),
  req('POST Admin Login', 'POST', '/api/admin/auth/login', {
    json: { username: '{{adminUsername}}', password: '{{adminPassword}}' },
    desc: 'Logs in. The server sets the `hr_session` cookie; the cookie jar sends it with every admin request after this.',
    test: () => {
      pm.test('Logged in as the configured admin', () => pm.expect(body.username).to.equal(env('adminUsername')));
      const cookie = pm.response.headers.all().find((h) => h.key.toLowerCase() === 'set-cookie' && h.value.startsWith('hr_session='));
      pm.test('Session cookie hr_session is set, HttpOnly and SameSite=Strict', () => {
        pm.expect(cookie, 'no hr_session cookie').to.exist;
        pm.expect(cookie.value).to.match(/HttpOnly/i);
        pm.expect(cookie.value).to.match(/SameSite=Strict/i);
      });
    },
  }),
  req('GET Current Admin', 'GET', '/api/admin/auth/me', { test: () => { pm.test('Session belongs to the admin', () => pm.expect(body.username).to.equal(env('adminUsername'))); } }),
  req('POST Admin Login — second session (to be logged out)', 'POST', '/api/admin/auth/login', {
    noAuth: true, json: { username: '{{adminUsername}}', password: '{{adminPassword}}' },
    desc: 'A second, separate admin session (cookie jar off). Its token is kept only for the next three requests, then cleared.',
    test: () => {
      const c = pm.response.headers.all().find((h) => h.key.toLowerCase() === 'set-cookie' && h.value.startsWith('hr_session='));
      pm.test('A second session token was issued', () => pm.expect(c, 'no hr_session cookie').to.exist);
      pm.environment.set('secondAdminToken', c ? c.value.split(';')[0].slice('hr_session='.length) : '');
    },
  }),
  req('GET Current Admin — second session works', 'GET', '/api/admin/auth/me', { cookie: 'hr_session={{secondAdminToken}}', test: () => { pm.test('Signed in', () => pm.expect(body.username).to.equal(env('adminUsername'))); } }),
  req('POST Logout — second session', 'POST', '/api/admin/auth/logout', { cookie: 'hr_session={{secondAdminToken}}', test: () => { pm.test('ok = true', () => pm.expect(body.ok).to.equal(true)); } }),
  req('GET Current Admin — logged-out token replayed', 'GET', '/api/admin/auth/me', {
    cookie: 'hr_session={{secondAdminToken}}', status: 401, error: 'Your session has ended',
    desc: 'Logout revokes the token itself (not only the cookie): the same token sent again is refused at once.',
    test: () => { pm.environment.set('secondAdminToken', ''); },
  }),
  req('GET Current Admin — the main session is not affected', 'GET', '/api/admin/auth/me', { test: () => { pm.test('Still signed in', () => pm.expect(body.username).to.equal(env('adminUsername'))); } }),
  req('POST Logout', 'POST', '/api/admin/auth/logout', { test: () => { pm.test('ok = true', () => pm.expect(body.ok).to.equal(true)); } }),
  req('GET Current Admin — after logout', 'GET', '/api/admin/auth/me', { status: 401, error: 'Please log in.', desc: 'Logout clears the cookie, so the admin API refuses the next request.' }),
  req('POST Admin Login — again', 'POST', '/api/admin/auth/login', { json: { username: '{{adminUsername}}', password: '{{adminPassword}}' }, test: () => { pm.test('Logged in again', () => pm.expect(body.username).to.equal(env('adminUsername'))); } }),
  req('POST Change Password — wrong current password', 'POST', '/api/admin/auth/password', { json: { current_password: '{{adminPassword}}-wrong', new_password: 'whatever-123' }, status: 400, error: 'Current password is incorrect.', notes: 'Nothing is changed.' }),
  req('POST Change Password — new password too short', 'POST', '/api/admin/auth/password', { json: { current_password: '{{adminPassword}}', new_password: 'short' }, status: 400, error: 'at least 8 characters', notes: 'Nothing is changed.' }),
  req('POST Change Password — to the same password', 'POST', '/api/admin/auth/password', {
    only: 'LOCAL', json: { current_password: '{{adminPassword}}', new_password: '{{adminPassword}}' },
    desc: 'A real password change (to the same value, so the environment stays valid).',
    test: () => { pm.test('ok = true', () => pm.expect(body.ok).to.equal(true)); },
  }),
  req('GET Questions — record baseline (for the cleanup check)', 'GET', '/api/admin/questions', {
    desc: 'Records how many questions, test types and categories exist before this run creates anything, so the cleanup at the end can prove it removed only its own data.',
    test: () => {
      pm.test('questions is an array, total_counts an object', () => { pm.expect(body.questions).to.be.an('array'); pm.expect(body.total_counts).to.be.an('object'); });
      set('baselineCounts', body.total_counts);
      set('baselineTypes', body.test_types.map((t) => t.key));
      set('baselineCategories', body.categories.length);
    },
  }),
]);

// ================================================================================
// 03 Dashboard
// ================================================================================
const dashboard = folder('03 Dashboard', 'Summary numbers and the LALCO IQ Score classification table.', [
  req('GET Dashboard', 'GET', '/api/admin/dashboard', {
    test: () => {
      pm.test('Numbers are numbers', () => ['total_candidates', 'passed', 'not_passed', 'completed_assessments', 'pending_assessments'].forEach((k) => pm.expect(body[k], k).to.be.a('number')));
      pm.test('Lists are arrays', () => { pm.expect(body.recent).to.be.an('array'); pm.expect(body.candidates).to.be.an('array'); pm.expect(body.iq_classification).to.be.an('array'); });
      pm.test('summary is an object with number counts', () => {
        pm.expect(body.summary).to.be.an('object');
        ['total', 'iq_passed', 'iq_not_passed', 'general_passed', 'calculation_passed', 'essay_pending', 'eligible', 'not_eligible', 'pending'].forEach((k) => pm.expect(body.summary[k], k).to.be.a('number'));
      });
      pm.test('IQ level counts use the 7 LALCO classifications', () => pm.expect(Object.keys(body.summary.iq_levels)).to.eql(['Very superior', 'Superior', 'High average', 'Average', 'Low average', 'Borderline', 'Extremely low']));
      pm.test('Highest IQ (if any) has a LALCO IQ Score 0-150', () => {
        if (body.highest_iq) pm.expect(body.highest_iq.lalco_iq_score).to.be.within(0, 150);
      });
      set('baselineCompleted', body.completed_assessments);
    },
  }),
  req('GET IQ Classification', 'GET', '/api/admin/iq-classification', {
    test: () => {
      pm.test('Exactly the 7 reference bands, 0-150 without gaps', () => {
        pm.expect(body.map((b) => [b.range, b.description, b.populationReference])).to.eql([
          ['130–150', 'Very superior', '2.2%'], ['120–129', 'Superior', '6.7%'], ['110–119', 'High average', '16.1%'], ['90–109', 'Average', '50%'],
          ['80–89', 'Low average', '16.1%'], ['70–79', 'Borderline', '6.7%'], ['0–69', 'Extremely low', '2.2%']]);
        pm.expect(body.reduce((n, b) => n + b.max - b.min + 1, 0)).to.equal(151);
      });
      set('iqBands', body);
    },
  }),
]);

// ================================================================================
// 04 Candidates
// ================================================================================
const CAND = { phone: '020 0000 0101', graduate_from: 'University', high_school: 'Postman High School', university: 'Postman University', school_name: 'PU', subject: 'Accounting', gpa: '3.2', interview_score: 55, final_result: 'Pending' };
const candidates = folder('04 Candidates', 'Create → read → update → export → delete ONE temporary candidate named "POSTMAN TEST … CANDIDATE". Real candidates are never touched.', [
  req('POST Create Candidate — missing name', 'POST', '/api/admin/candidates', { json: { phone: '020 0000 0000' }, status: 400, error: 'Candidate name is required.' }),
  req('POST Create Candidate — invalid interview score', 'POST', '/api/admin/candidates', { json: { name: '{{runTag}} BAD', interview_score: 150 }, status: 400, error: 'Interview score must be between 0 and 100.' }),
  req('POST Create Candidate', 'POST', '/api/admin/candidates', {
    json: { name: '{{runTag}} CANDIDATE', ...CAND }, status: 201,
    test: () => {
      pm.test('Candidate created with an id', () => pm.expect(body.id).to.be.a('number'));
      pm.test('Fields saved', () => { pm.expect(body.name).to.equal(env('runTag') + ' CANDIDATE'); pm.expect(body.phone).to.equal('020 0000 0101'); pm.expect(body.interview_score).to.equal(55); pm.expect(body.final_result).to.equal('Pending'); });
      set('candidateId', String(body.id));
    },
  }),
  req('GET Candidates — search', 'GET', '/api/admin/candidates', { q: { q: '{{runTag}}' }, test: () => { pm.test('The new candidate is found', () => pm.expect(body.map((c) => c.id)).to.include(Number(env('candidateId')))); } }),
  req('GET Candidate', 'GET', '/api/admin/candidates/{{candidateId}}', {
    test: () => {
      pm.test('candidate + assessments', () => { pm.expect(body.candidate.id).to.equal(Number(env('candidateId'))); pm.expect(body.assessments).to.be.an('array').that.is.empty; });
    },
  }),
  req('PUT Update Candidate', 'PUT', '/api/admin/candidates/{{candidateId}}', {
    json: { name: '{{runTag}} CANDIDATE', ...CAND, subject: 'Accounting (updated)', interview_score: 80, final_result: 'Pass' },
    test: () => { pm.test('Updated values returned', () => { pm.expect(body.subject).to.equal('Accounting (updated)'); pm.expect(body.interview_score).to.equal(80); pm.expect(body.final_result).to.equal('Pass'); }); },
  }),
  req('GET Candidate — verify update', 'GET', '/api/admin/candidates/{{candidateId}}', {
    test: () => { pm.test('Update was saved', () => { pm.expect(body.candidate.subject).to.equal('Accounting (updated)'); pm.expect(body.candidate.final_result).to.equal('Pass'); }); },
  }),
  req('PUT Update Candidate — nonexistent id', 'PUT', '/api/admin/candidates/999999999', { json: { name: 'x' }, status: 404, error: 'Not found.' }),
  req('GET Candidate — nonexistent id', 'GET', '/api/admin/candidates/999999999', { status: 404, error: 'Not found.' }),
  req('GET Candidate — malformed id', 'GET', '/api/admin/candidates/abc', { status: 404, error: 'Not found.' }),
  req('GET Export Candidate PDF', 'GET', '/api/admin/candidates/{{candidateId}}/export.pdf', { type: 'pdf', maxMs: 5000, desc: 'Standard 15-field candidate report as PDF.' }),
  req('GET Export Candidate Word', 'GET', '/api/admin/candidates/{{candidateId}}/export.docx', { type: 'docx', maxMs: 5000 }),
  req('GET Export Candidate Excel', 'GET', '/api/admin/candidates/{{candidateId}}/export.xlsx', { type: 'xlsx', maxMs: 5000 }),
  req('GET Export Candidate PDF — detailed', 'GET', '/api/admin/candidates/{{candidateId}}/export.pdf', { q: { detail: 'full' }, type: 'pdf', maxMs: 5000 }),
  req('GET Export Candidate — unknown format', 'GET', '/api/admin/candidates/{{candidateId}}/export.txt', { status: 404, error: 'Not found.' }),
  req('DELETE Candidate', 'DELETE', '/api/admin/candidates/{{candidateId}}', { desc: 'Deletes only the temporary candidate created above.', test: () => { pm.test('ok = true', () => pm.expect(body.ok).to.equal(true)); } }),
  req('DELETE Candidate — already deleted', 'DELETE', '/api/admin/candidates/{{candidateId}}', { status: 404, error: 'Not found.' }),
  req('GET Candidate — deleted', 'GET', '/api/admin/candidates/{{candidateId}}', { status: 404 }),
]);

// ================================================================================
// 05 Test Types (runs before Questions: every test question goes into a temporary type)
// ================================================================================
const typeCreate = (label, behavior, keyVar) => req(`POST Create Test Type — temporary ${label}`, 'POST', '/api/admin/test-types', {
  json: { name: `{{runTag}} ${label}`, behavior, in_assessments: true, description: 'Temporary Postman test type' }, status: 201, P: { behavior, keyVar },
  desc: `A temporary ${label} test type. This run's questions, links and candidates use only temporary types, so a real candidate can never be given a test question.`,
  test: () => {
    pm.test('Created with a new key and the requested format', () => { pm.expect(body.key).to.be.a('string'); pm.expect(body.behavior).to.equal(P.behavior); pm.expect(!!body.core).to.equal(false); pm.expect(!!body.active).to.equal(true); });
    set(P.keyVar, body.key);
  },
});
const testTypes = folder('05 Test Types', 'IQ, General, Calculation, Essay are core types (cannot be deleted). This folder creates three temporary types used by the rest of the run, and tests every test-type endpoint on them.', [
  req('GET Test Types', 'GET', '/api/admin/test-types', {
    test: () => {
      pm.test('Array of test types with usage counts', () => { pm.expect(body).to.be.an('array'); body.forEach((t) => { pm.expect(t.key).to.be.a('string'); pm.expect(t.questions).to.be.a('number'); }); });
      pm.test('The four core types exist and are marked core', () => ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY'].forEach((k) => { const t = body.find((x) => x.key === k); pm.expect(t, k).to.exist; pm.expect(!!t.core, k).to.equal(true); }));
    },
  }),
  typeCreate('MCQ', 'mcq', 'testTypeKey'),
  typeCreate('INTERVIEW', 'interview', 'interviewTypeKey'),
  typeCreate('CALC', 'calculation', 'calcTypeKey'),
  req('POST Create Test Type — duplicate name', 'POST', '/api/admin/test-types', { json: { name: '{{runTag}} MCQ', behavior: 'mcq' }, status: 400 }),
  req('POST Create Test Type — reserved name "All"', 'POST', '/api/admin/test-types', { json: { name: 'All', behavior: 'mcq' }, status: 400 }),
  req('POST Create Test Type — IQ format not allowed', 'POST', '/api/admin/test-types', { json: { name: '{{runTag}} FAKE IQ', behavior: 'iq' }, status: 400 }),
  req('POST Create Test Type — invalid format', 'POST', '/api/admin/test-types', { json: { name: '{{runTag}} BOGUS', behavior: 'bogus' }, status: 400, error: 'Please choose the question format' }),
  req('PUT Update Test Type', 'PUT', '/api/admin/test-types/{{testTypeKey}}', {
    json: { name: '{{runTag}} MCQ (renamed)', description: 'Renamed by Postman' },
    test: () => { pm.test('Renamed, key unchanged', () => { pm.expect(body.name).to.equal(env('runTag') + ' MCQ (renamed)'); pm.expect(body.key).to.equal(env('testTypeKey')); }); },
  }),
  req('PATCH Update Test Type — Lao title', 'PATCH', '/api/admin/test-types/{{testTypeKey}}', { json: { name_lo: 'ທົດສອບ' }, test: () => { pm.test('Lao title saved', () => pm.expect(body.name_lo).to.equal('ທົດສອບ')); } }),
  req('PUT Update Test Type — nonexistent', 'PUT', '/api/admin/test-types/POSTMAN_NO_SUCH_TYPE', { json: { name: 'x' }, status: 404 }),
  req('POST Deactivate Test Type', 'POST', '/api/admin/test-types/{{testTypeKey}}/deactivate', { test: () => { pm.test('Inactive', () => pm.expect(!!body.active).to.equal(false)); } }),
  req('POST Create Category — in an inactive test type', 'POST', '/api/admin/categories', { json: { section: '{{testTypeKey}}', name: '{{runTag}} Not allowed' }, status: 400, error: 'inactive' }),
  req('POST Reactivate Test Type', 'POST', '/api/admin/test-types/{{testTypeKey}}/reactivate', { test: () => { pm.test('Active again', () => pm.expect(!!body.active).to.equal(true)); } }),
  req('POST Activate Test Type', 'POST', '/api/admin/test-types/{{testTypeKey}}/activate', { desc: '`activate` and `reactivate` are the same action.', test: () => { pm.test('Active', () => pm.expect(!!body.active).to.equal(true)); } }),
  req('POST Activate Test Type — nonexistent', 'POST', '/api/admin/test-types/POSTMAN_NO_SUCH_TYPE/activate', { status: 404 }),
  req('DELETE Test Type — core IQ is protected', 'DELETE', '/api/admin/test-types/IQ', { status: 400, error: 'Core Test Type', desc: 'Must be refused: the four core test types can never be deleted.' }),
  typeCreate('THROWAWAY', 'mcq', 'throwawayTypeKey'),
  req('DELETE Test Type — unused temporary type', 'DELETE', '/api/admin/test-types/{{throwawayTypeKey}}', { test: () => { pm.test('deleted = true', () => pm.expect(body.deleted).to.equal(true)); } }),
  req('DELETE Test Type — nonexistent', 'DELETE', '/api/admin/test-types/{{throwawayTypeKey}}', { status: 404 }),
]);

// ================================================================================
// 06 Categories
// ================================================================================
const cats = folder('06 Categories', 'Categories belong to one test type. Created only in the temporary MCQ type.', [
  req('GET Categories', 'GET', '/api/admin/categories', { test: () => { pm.test('Array', () => pm.expect(body).to.be.an('array')); } }),
  req('POST Create Category', 'POST', '/api/admin/categories', {
    json: { section: '{{testTypeKey}}', name: '{{runTag}} Category', name_lo: 'ໝວດ' }, status: 201,
    test: () => {
      pm.test('Created in the temporary type, active, empty', () => { pm.expect(body.id).to.be.a('number'); pm.expect(body.section).to.equal(env('testTypeKey')); pm.expect(!!body.active).to.equal(true); pm.expect(body.questions).to.equal(0); });
      set('categoryId', String(body.id));
    },
  }),
  req('POST Create Category — duplicate (other case and spacing)', 'POST', '/api/admin/categories', { json: { section: '{{testTypeKey}}', name: '  {{runTag}}   CATEGORY ' }, status: 400, error: 'already has the category' }),
  req('POST Create Category — unknown test type', 'POST', '/api/admin/categories', { json: { section: 'POSTMAN_NO_SUCH_TYPE', name: 'x' }, status: 400, error: 'Please choose the test type.' }),
  req('POST Create Category — empty name', 'POST', '/api/admin/categories', { json: { section: '{{testTypeKey}}', name: '   ' }, status: 400, error: 'Please enter a category name.' }),
  req('GET Categories — by test type', 'GET', '/api/admin/categories', { q: { section: '{{testTypeKey}}' }, test: () => { pm.test('Only this test type, includes the new one', () => { pm.expect(body.every((c) => c.section === env('testTypeKey'))).to.equal(true); pm.expect(body.map((c) => c.id)).to.include(Number(env('categoryId'))); }); } }),
  req('GET Category', 'GET', '/api/admin/categories/{{categoryId}}', { test: () => { pm.test('category + questions', () => { pm.expect(body.category.id).to.equal(Number(env('categoryId'))); pm.expect(body.questions).to.be.an('array'); }); } }),
  req('GET Category — nonexistent', 'GET', '/api/admin/categories/999999999', { status: 404 }),
  req('PUT Update Category — rename', 'PUT', '/api/admin/categories/{{categoryId}}', { json: { name: '{{runTag}} Category Renamed' }, test: () => { pm.test('Renamed', () => pm.expect(body.name).to.equal(env('runTag') + ' Category Renamed')); } }),
  req('POST Deactivate Category', 'POST', '/api/admin/categories/{{categoryId}}/deactivate', { test: () => { pm.test('Inactive', () => pm.expect(!!body.active).to.equal(false)); } }),
  req('GET Categories — inactive filter', 'GET', '/api/admin/categories', { q: { section: '{{testTypeKey}}', status: 'inactive' }, test: () => { pm.test('Listed as inactive', () => pm.expect(body.map((c) => c.id)).to.include(Number(env('categoryId')))); } }),
  req('POST Activate Category', 'POST', '/api/admin/categories/{{categoryId}}/activate', { test: () => { pm.test('Active again', () => pm.expect(!!body.active).to.equal(true)); } }),
  req('POST Activate Category — invalid id', 'POST', '/api/admin/categories/abc/activate', { status: 404 }),
  req('POST Create Category — unused (to delete)', 'POST', '/api/admin/categories', { json: { section: '{{testTypeKey}}', name: '{{runTag}} Delete me' }, status: 201, test: () => { set('category2Id', String(body.id)); } }),
  req('DELETE Category — unused', 'DELETE', '/api/admin/categories/{{category2Id}}', { test: () => { pm.test('deleted = true (nothing used it)', () => pm.expect(body.deleted).to.equal(true)); } }),
  req('DELETE Category — nonexistent', 'DELETE', '/api/admin/categories/{{category2Id}}', { status: 404 }),
]);

// ================================================================================
// 07 Questions
// ================================================================================
const Q = { section: '{{testTypeKey}}', question_text: '{{runTag}} Q What is 2 + 3?', option_a: '4', option_b: '5', option_c: '6', option_d: '7', correct_answer: 'B', marks: 2 };
const questions = folder('07 Questions', 'Question bank CRUD on the temporary MCQ type. There is no GET /questions/:id endpoint: a question is read back with the list filters. Delete All Questions is only ever called with an invalid test area (a safety check that deletes nothing).', [
  req('GET Questions', 'GET', '/api/admin/questions', {
    test: () => {
      pm.test('questions, counts, test types and categories', () => {
        pm.expect(body.questions).to.be.an('array'); pm.expect(body.counts).to.be.an('object'); pm.expect(body.total_counts).to.be.an('object');
        pm.expect(body.test_types).to.be.an('array'); pm.expect(body.categories).to.be.an('array'); pm.expect(body.iq_levels).to.be.an('object');
      });
    },
  }),
  req('GET Question Counts', 'GET', '/api/admin/questions/counts', { test: () => { pm.test('Active questions per test type (numbers)', () => ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY'].forEach((k) => pm.expect(body[k], k).to.be.a('number'))); pm.test('New temporary type starts empty', () => pm.expect(body[env('testTypeKey')]).to.equal(0)); } }),
  req('GET Question Counts — Lao ready', 'GET', '/api/admin/questions/counts', { q: { language: 'lo' }, test: () => { pm.test('Numbers', () => pm.expect(body.IQ).to.be.a('number')); } }),
  req('POST Create Question — missing options', 'POST', '/api/admin/questions', { json: { section: '{{testTypeKey}}', question_text: '{{runTag}} no options', correct_answer: 'A' }, status: 400, error: 'Options are missing' }),
  req('POST Create Question — answer is not an option', 'POST', '/api/admin/questions', { json: { ...Q, question_text: '{{runTag}} bad answer', correct_answer: 'E' }, status: 400, error: 'has no option text' }),
  req('POST Create Question — unknown test type', 'POST', '/api/admin/questions', { json: { ...Q, section: 'POSTMAN NO SUCH TYPE' }, status: 400, error: 'does not exist' }),
  req('POST Create Question — unknown category', 'POST', '/api/admin/questions', { json: { ...Q, category: '{{runTag}} no such category' }, status: 400, error: 'does not exist' }),
  req('POST Create Question', 'POST', '/api/admin/questions', {
    json: { ...Q, category_id: '{{categoryId}}' }, status: 201,
    test: () => {
      pm.test('Saved in the temporary type with its category, options, answer, marks', () => {
        pm.expect(body.section).to.equal(env('testTypeKey')); pm.expect(body.category_id).to.equal(Number(env('categoryId')));
        pm.expect([body.option_a, body.option_b, body.option_c, body.option_d]).to.eql(['4', '5', '6', '7']);
        pm.expect(body.correct_answer).to.equal('B'); pm.expect(body.marks).to.equal(2); pm.expect(body.status).to.equal('Active');
      });
      set('questionId', String(body.id));
    },
  }),
  req('GET Questions — read the new question (filter)', 'GET', '/api/admin/questions', {
    q: { section: '{{testTypeKey}}', q: '{{runTag}} Q What' },
    test: () => { pm.test('Exactly the new question', () => { pm.expect(body.questions.map((q) => q.id)).to.eql([Number(env('questionId'))]); }); },
  }),
  req('PUT Update Question', 'PUT', '/api/admin/questions/{{questionId}}', {
    json: { ...Q, question_text: '{{runTag}} Q What is 3 + 3?', correct_answer: 'C', category_id: '{{categoryId}}', status: 'Inactive' },
    test: () => { pm.test('Text, answer and status updated', () => { pm.expect(body.question_text).to.equal(env('runTag') + ' Q What is 3 + 3?'); pm.expect(body.correct_answer).to.equal('C'); pm.expect(body.status).to.equal('Inactive'); }); },
  }),
  req('GET Questions — inactive filter', 'GET', '/api/admin/questions', { q: { section: '{{testTypeKey}}', status: 'Inactive' }, test: () => { pm.test('Listed as inactive', () => pm.expect(body.questions.map((q) => q.id)).to.include(Number(env('questionId')))); } }),
  req('PUT Update Question — nonexistent', 'PUT', '/api/admin/questions/999999999', { json: Q, status: 404 }),
  req('POST Bulk Category — clear', 'POST', '/api/admin/questions/bulk-category', { json: '{ "ids": [{{questionId}}], "category_id": null }', test: () => { pm.test('1 updated', () => pm.expect(body.updated).to.equal(1)); } }),
  req('POST Bulk Category — assign', 'POST', '/api/admin/questions/bulk-category', { json: '{ "ids": [{{questionId}}], "category_id": {{categoryId}} }', test: () => { pm.test('1 updated, 0 skipped', () => { pm.expect(body.updated).to.equal(1); pm.expect(body.skipped).to.equal(0); }); } }),
  req('POST Bulk Category — no questions', 'POST', '/api/admin/questions/bulk-category', { json: { ids: [], category_id: null }, status: 400, error: 'Please select at least one question.' }),
  req('PUT Question Lao text', 'PUT', '/api/admin/questions/{{questionId}}/lao', {
    json: { question_text_lo: '{{runTag}} ຄຳຖາມ 3 + 3 ເທົ່າກັບເທົ່າໃດ?', option_a_lo: '4', option_b_lo: '5', option_c_lo: '6', option_d_lo: '7', lo_status: 'needs_review' },
    test: () => { pm.test('Lao saved, English untouched', () => { pm.expect(body.lo_status).to.equal('needs_review'); pm.expect(body.question_text).to.equal(env('runTag') + ' Q What is 3 + 3?'); }); },
  }),
  req('POST Check Lao text', 'POST', '/api/admin/questions/{{questionId}}/lao/check', { json: { question_text_lo: 'ຄຳຖາມ', option_a_lo: '4', option_b_lo: '5', option_c_lo: '6', option_d_lo: '7' }, test: () => { pm.test('problems is an array', () => pm.expect(body.problems).to.be.an('array')); } }),
  req('PUT Question Lao text — nonexistent', 'PUT', '/api/admin/questions/999999999/lao', { json: { question_text_lo: 'x' }, status: 404 }),
  req('GET Translate Status', 'GET', '/api/admin/questions/translate-status', { test: () => { pm.test('job, counts, translator flag', () => { pm.expect(body).to.have.property('job'); pm.expect(body.lao_counts).to.be.an('object'); pm.expect(body.translator).to.be.a('boolean'); }); set('translator', String(body.translator)); } }),
  req('POST Translate Missing Lao — without a translation service', 'POST', '/api/admin/questions/translate-missing', {
    status: 400, pre: () => { if (env('translator') === 'true') { console.log('Skipped: a translation service is configured; this would translate the real bank.'); pm.execution.skipRequest(); } },
    notes: 'Skipped automatically when a translation service is configured (it would start translating the whole bank).',
  }),
  req('GET Question Template (Excel)', 'GET', '/api/admin/questions/template.xlsx', { type: 'xlsx', maxMs: 8000 }),
  req('GET Export Questions — the temporary MCQ type (Excel)', 'GET', '/api/admin/questions/export.xlsx', {
    q: { section: '{{testTypeKey}}' }, type: 'xlsx', maxMs: 8000,
    desc: 'The question bank of one test as Excel (template columns, so it can be uploaded again). Only this run\'s temporary type is exported: the file contains correct answers.',
    test: () => { pm.test('File named after the test type', () => pm.expect(pm.response.headers.get('Content-Disposition') || '').to.match(/LALCO_Questions_POSTMAN_TEST_.+\.xlsx/)); },
  }),
  req('GET Export Questions — Active only', 'GET', '/api/admin/questions/export.xlsx', { q: { section: '{{testTypeKey}}', status: 'Active' }, type: 'xlsx', maxMs: 8000 }),
  req('GET Export Questions — all tests (one sheet each)', 'GET', '/api/admin/questions/export.xlsx', {
    q: { section: 'all' }, type: 'xlsx', maxMs: 10000, only: 'LOCAL',
    notes: 'LOCAL only: on production this file would hold the real question bank with its answers, and run reports can keep response bodies.',
  }),
  req('GET Export Questions — unknown test type', 'GET', '/api/admin/questions/export.xlsx', { q: { section: 'POSTMAN_NO_SUCH_TYPE' }, status: 400, error: 'Please choose a test type to export.' }),
  req('POST Delete All Questions — invalid test area (safety check)', 'POST', '/api/admin/questions/delete-all', {
    json: { section: 'POSTMAN_NOT_A_TEST_AREA' }, status: 400, error: 'Please choose a test area.',
    desc: 'Checks the endpoint refuses an unknown test area. It is NEVER called with a real test area by this collection.',
    test: () => { pm.test('success = false, nothing deleted', () => pm.expect(body.success).to.equal(false)); },
  }),
  req('DELETE Test Type — in use (refused)', 'DELETE', '/api/admin/test-types/{{testTypeKey}}', { status: 400, error: 'in use', desc: 'A test type with questions cannot be permanently deleted.' }),
  req('GET Question Counts — IQ questions for the scoring tests', 'GET', '/api/admin/questions/counts', {
    desc: 'Decides how many IQ questions the IQ scoring test uses (10, or fewer if the bank is smaller). With mode = LOCAL and fewer than 10 IQ questions, first creates 10 temporary IQ questions (2 per level).',
    pre: () => {
      if ((env('mode') || 'PRODUCTION') !== 'LOCAL') return;
      const base = env('baseUrl');
      pm.sendRequest({ url: base + '/api/admin/questions/counts', method: 'GET' }, (err, res) => {
        if (err || res.json().IQ >= 10) return;
        const levels = ['Easy', 'Easy', 'Basic', 'Basic', 'Moderate', 'Moderate', 'Difficult', 'Difficult', 'Very Difficult', 'Very Difficult'];
        levels.forEach((level, i) => pm.sendRequest({ url: base + '/api/admin/questions', method: 'POST', header: { 'Content-Type': 'application/json' },
          body: { mode: 'raw', raw: JSON.stringify({ section: 'IQ', difficulty: level, question_text: `${env('runTag')} IQ ${i + 1}: 2, 4, 6, ?`, option_a: String(7 + i), option_b: String(8 + i * 10), option_c: String(9 + i * 100), correct_answer: 'B' }) } },
        (e, r) => { if (e || r.code !== 201) console.log('Seeding IQ question failed', e || r.text()); }));
      });
    },
    test: () => {
      const n = Math.min(10, body.IQ);
      pm.test('At least one active IQ question', () => pm.expect(body.IQ).to.be.above(0));
      set('iqCount', String(n));
      set('iqBankSize', String(body.IQ));
      console.log('IQ scoring tests will use', n, 'questions from a bank of', body.IQ);
    },
  }),
]);

// ================================================================================
// 08 Question Import
// ================================================================================
const importReq = (name, rowsVar, typeVar, expect, o = {}) => req(name, 'POST', '/api/admin/questions/import', {
  json: { questions: [], create_missing_categories: true }, P: { rowsVar, typeVar, expect }, maxMs: 5000,
  desc: 'Imports the rows the preview accepted, all into a TEMPORARY test type (never into IQ / General / Calculation / Essay). Unknown categories are created in that type.',
  pre: () => {
    const rows = getJSON(P.rowsVar) || [];
    const questions = rows.map((q) => { const x = Object.assign({}, q, { section: env(P.typeVar) }); delete x.type_name; delete x.type_behavior; return x; });
    pm.request.body.update(JSON.stringify({ questions, create_missing_categories: true }));
  },
  test: () => {
    pm.test(`Imported ${P.expect.imported}, skipped 0`, () => { pm.expect(body.imported).to.equal(P.expect.imported); pm.expect(body.skipped).to.equal(0); });
    if (P.expect.answer_required) pm.test(`${P.expect.answer_required} waiting for an answer`, () => pm.expect(body.answer_required).to.equal(P.expect.answer_required));
  },
  ...o,
});
const verifyBank = (name, typeVar, rowsVar, check) => req(name, 'GET', '/api/admin/questions', {
  q: { section: `{{${typeVar}}}` }, P: { rowsVar },
  test: [() => {
    const want = (getJSON(P.rowsVar) || []).map((q) => q.question_text);
    const got = body.questions.filter((q) => want.includes(q.question_text));
    pm.test(`All ${want.length} imported questions are in the bank`, () => pm.expect(got.length).to.equal(want.length));
  }, check],
});

const imports = folder('08 Question Import', 'Real multipart uploads of the files in postman/fixtures (each has a known expected result). Preview never saves anything; Import saves only into the temporary test types. Set the Postman working directory to the `postman` folder so the files are found.', [
  preview('POST Import Preview — MCQ with inline answers (TXT)', 'mcq-inline-answers.txt', '{{testTypeKey}}', {
    test: [() => { eval(pm.environment.get('libUsable')); }, () => {
      pm.test('4 found, 4 valid, 0 invalid', () => { pm.expect(body.found).to.equal(4); pm.expect(body.valid).to.equal(4); pm.expect(body.invalid).to.equal(0); });
      pm.test('Detected format: numbered questions', () => pm.expect(body.format).to.equal('numbered questions'));
      pm.test('Answers from "Answer:", "Ans:", "Correct Answer:" lines', () => pm.expect(body.rows.map((r) => r.question.correct_answer)).to.eql(['B', 'C', 'C', 'D']));
      pm.test('4 options each', () => body.rows.forEach((r) => pm.expect([r.question.option_a, r.question.option_b, r.question.option_c, r.question.option_d].every(Boolean)).to.equal(true)));
      set('importRowsTxt', usable.map((r) => r.question));
    }],
  }),
  importReq('POST Import Questions — MCQ (TXT) into the temporary MCQ type', 'importRowsTxt', 'testTypeKey', { imported: 4 }),
  preview('POST Import Preview — MCQ with the answer key at the end (PDF)', 'mcq-answer-key.pdf', '{{testTypeKey}}', {
    test: [() => { eval(pm.environment.get('libUsable')); }, () => {
      pm.test('5 found, 5 valid', () => { pm.expect(body.found).to.equal(5); pm.expect(body.valid).to.equal(5); });
      pm.test('Answer key detected (5 entries) and applied', () => { pm.expect(body.answer_key).to.equal(5); pm.expect(body.rows.map((r) => r.question.correct_answer)).to.eql(['B', 'A', 'B', 'C', 'C']); });
      pm.test('Options on separate lines were read', () => pm.expect(body.rows[0].question.option_b).to.equal('56'));
      pm.test('Nothing is put into IQ', () => pm.expect(body.by_section.IQ).to.equal(0));
    }],
  }),
  preview('POST Import Preview — Excel with other column names (XLSX)', 'mcq-bank.xlsx', '{{testTypeKey}}', {
    test: [() => { eval(pm.environment.get('libUsable')); }, () => {
      pm.test('4 found, 4 valid (Question Text / Choice A-D / Ans / Topic)', () => { pm.expect(body.found).to.equal(4); pm.expect(body.valid).to.equal(4); pm.expect(body.format).to.equal('table (header row)'); });
      pm.test('Answers and categories read', () => { pm.expect(body.rows.map((r) => r.question.correct_answer)).to.eql(['A', 'B', 'B', 'C']); pm.expect(body.rows.map((r) => r.question.category)).to.eql(['Computers', 'Computers', 'Numbers', 'Computers']); });
      set('importRowsXlsx', usable.map((r) => r.question));
    }],
  }),
  importReq('POST Import Questions — Excel into the temporary MCQ type', 'importRowsXlsx', 'testTypeKey', { imported: 4 }),
  verifyBank('GET Questions — verify the Excel import', 'testTypeKey', 'importRowsXlsx', () => {
    const q = body.questions.find((x) => x.question_text === 'What does CPU stand for?');
    pm.test('Text, options, answer, category, Active', () => { pm.expect(q.option_a).to.equal('Central Processing Unit'); pm.expect(q.correct_answer).to.equal('A'); pm.expect(q.category).to.equal('Computers'); pm.expect(q.status).to.equal('Active'); pm.expect(q.category_id).to.be.a('number'); });
  }),
  preview('POST Import Preview — same Excel again (duplicates)', 'mcq-bank.xlsx', '{{testTypeKey}}', {
    test: () => {
      pm.test('All 4 are duplicates of the bank, 0 valid', () => { pm.expect(body.duplicates).to.equal(4); pm.expect(body.valid).to.equal(0); });
      pm.test('Reason says Duplicate', () => body.rows.forEach((r) => pm.expect(r.errors.join(' ')).to.include('Duplicate')));
    },
  }),
  preview('POST Import Preview — Excel 97-2003 (.xls)', 'mcq-bank-97.xls', '{{testTypeKey}}', {
    desc: 'A real .xls file (BIFF8 / OLE, not a renamed .xlsx). Preview only: nothing is saved.',
    test: () => {
      pm.test('3 found, 3 valid, read as a table', () => { pm.expect(body.found).to.equal(3); pm.expect(body.valid).to.equal(3); pm.expect(body.format).to.equal('table (header row)'); });
      pm.test('Questions, answers and categories read', () => {
        pm.expect(body.rows.map((r) => r.question.question_text)).to.eql(['Which device prints on paper?', 'How many hours are in two days?', 'Which file type is a spreadsheet?']);
        pm.expect(body.rows.map((r) => r.question.correct_answer)).to.eql(['B', 'C', 'B']);
        pm.expect(body.rows.map((r) => r.question.category)).to.eql(['Office', 'Numbers', 'Office']);
      });
    },
  }),
  preview('POST Import Preview — CSV with semicolons and quotes', 'mcq-semicolon.csv', '{{testTypeKey}}', {
    test: () => {
      pm.test('3 found, 3 valid', () => { pm.expect(body.found).to.equal(3); pm.expect(body.valid).to.equal(3); });
      pm.test('A quoted value keeps its semicolon', () => pm.expect(body.rows[0].question.question_text).to.equal('Which one is a fruit; not a vegetable?'));
    },
  }),
  preview('POST Import Preview — TSV', 'questions.tsv', '{{testTypeKey}}', { test: () => { pm.test('3 found, 3 valid', () => { pm.expect(body.found).to.equal(3); pm.expect(body.valid).to.equal(3); }); pm.test('Answer C = 7 continents', () => pm.expect(body.rows[1].question.correct_answer).to.equal('C')); } }),
  preview('POST Import Preview — Behavioural questions + sample answers (DOCX)', 'behavioral-numbered.docx', '{{testTypeKey}}', {
    test: [() => { eval(pm.environment.get('libUsable')); }, () => {
      pm.test('4 found, all 4 importable (no options or answers needed)', () => { pm.expect(body.found).to.equal(4); pm.expect(usable.length).to.equal(4); });
      pm.test('Categories from "1. ADAPTABILITY" / "2. COLLABORATION"', () => pm.expect(body.rows.map((r) => r.question.category)).to.eql(['Adaptability', 'Adaptability', 'Collaboration', 'Collaboration']));
      pm.test('Sample answers kept as HR-only guidance, not in the question', () => body.rows.forEach((r) => { pm.expect(r.question.question_text).to.not.include('Sample Answer'); pm.expect(r.question.correct_answer.length).to.be.above(20); }));
      pm.test('Open questions are not put into the default multiple-choice type', () => pm.expect(body.by_section[env('testTypeKey')]).to.equal(0));
      set('importRowsBehavioral', usable.map((r) => r.question));
    }],
  }),
  importReq('POST Import Questions — Behavioural into the temporary Interview type', 'importRowsBehavioral', 'interviewTypeKey', { imported: 4 }),
  verifyBank('GET Questions — verify the Behavioural import', 'interviewTypeKey', 'importRowsBehavioral', () => {
    pm.test('Active, no options, guidance stored, 2 categories', () => {
      pm.expect(body.questions.every((q) => q.status === 'Active' && !q.option_a && q.correct_answer)).to.equal(true);
      pm.expect([...new Set(body.questions.map((q) => q.category))].sort()).to.eql(['Adaptability', 'Collaboration']);
    });
  }),
  preview('POST Import Preview — Behavioural bullets under headings (TXT)', 'behavioral-bullets.txt', '{{testTypeKey}}', {
    test: [() => { eval(pm.environment.get('libUsable')); }, () => {
      pm.test('5 found, 5 importable', () => { pm.expect(body.found).to.equal(5); pm.expect(usable.length).to.equal(5); });
      pm.test('Categories from headings', () => pm.expect(body.rows.map((r) => r.question.category)).to.eql(['Leadership', 'Leadership', 'Leadership', 'Customer Service', 'Customer Service']));
      pm.test('A wrapped bullet stays one question; no question mark needed', () => { pm.expect(body.rows[0].question.question_text).to.equal('Tell me about a time when you led a team through a difficult deadline and what you learned from it.'); pm.expect(body.rows[2].question.question_text).to.not.include('?'); });
    }],
  }),
  preview('REGRESSION — TABLE QUESTION IMPORT', 'behavioral-competency-table.docx', '{{testTypeKey}}', {
    desc: 'Permanent regression test for the reported bug ("Detected format: table (header row) · Questions found: 4 · Options found: 0 · Answers found: 0 · Valid questions: 0"). A competency table with several bullet questions per cell must give one question per bullet, with the competency as category.',
    test: [() => { eval(pm.environment.get('libUsable')); }, () => {
      pm.test('Not the reported failure (4 found, 0 valid)', () => pm.expect(!(body.found === 4 && body.valid + (body.pending_type || 0) === 0)).to.equal(true));
      pm.test('5 questions found, all 5 importable', () => { pm.expect(body.found).to.equal(5); pm.expect(usable.length).to.equal(5); });
      pm.test('Bullets in one cell split into separate questions', () => pm.expect(body.rows.map((r) => r.question.question_text)).to.eql([
        'Describe a time you led a major change at work.', 'How did you handle people who resisted that change?', 'Tell me about a complex problem you solved with data.',
        'Describe how you checked that your analysis was correct.', 'Give me an example of a mistake you found before it became serious.']));
      pm.test('Competency kept as the category', () => pm.expect(body.rows.map((r) => r.question.category)).to.eql(['Change Leadership', 'Change Leadership', 'Analytical Thinking', 'Analytical Thinking', 'Analytical Thinking']));
      pm.test('Headings are not questions', () => body.rows.forEach((r) => pm.expect(r.question.question_text).to.not.match(/Competency|SAMPLE INTERVIEW|Postman fixture|•/)));
      pm.test('No options or answers required', () => body.rows.forEach((r) => pm.expect(r.errors.filter((e) => !/^Test Type "/.test(e))).to.eql([])));
    }],
  }),
  preview('REGRESSION — PDF FOOTER READ AS A TABLE', 'behavioral-footer-regression.pdf', '{{testTypeKey}}', {
    desc: 'The exact reported file layout: "Question N:" + "Sample Answer:" with a footer "Title <tab> Page n of 2" on every page. It used to be read as a 4-row table with 0 valid questions.',
    test: [() => { eval(pm.environment.get('libUsable')); }, () => {
      pm.test('Not read as a table', () => pm.expect(body.format).to.not.equal('table (header row)'));
      pm.test('6 found, 6 importable', () => { pm.expect(body.found).to.equal(6); pm.expect(usable.length).to.equal(6); });
      pm.test('No footer / sample answer text in the questions', () => body.rows.forEach((r) => pm.expect(r.question.question_text).to.not.match(/Page \d|Sample Answer/)));
      pm.test('Sample answer kept as guidance', () => pm.expect(body.rows[0].question.correct_answer).to.match(/^I planned carefully/));
    }],
  }),
  preview('POST Import Preview — Essay questions (PDF)', 'essay-questions.pdf', 'ESSAY', {
    test: () => {
      pm.test('3 found, 3 valid Essay questions without options or answers', () => { pm.expect(body.found).to.equal(3); pm.expect(body.valid).to.equal(3); body.rows.forEach((r) => { pm.expect(r.question.section).to.equal('ESSAY'); pm.expect(r.question.option_a).to.equal(''); }); });
      pm.test('No question mark needed', () => pm.expect(body.rows[0].question.question_text).to.match(/^Explain why accurate record keeping/));
    },
  }),
  preview('POST Import Preview — Short-answer Calculation, one answer missing (TXT)', 'calculation-short-answer.txt', 'CALCULATION', {
    test: [() => { eval(pm.environment.get('libUsable')); }, () => {
      pm.test('3 found, 3 valid, 1 answer required', () => { pm.expect(body.found).to.equal(3); pm.expect(body.valid).to.equal(3); pm.expect(body.answer_required).to.equal(1); });
      pm.test('Answers read ("Answer:" and "Expected Answer:"), the missing one not guessed', () => pm.expect(body.rows.map((r) => r.question.correct_answer)).to.eql(['105', '1000', '']));
      pm.test('Missing answer -> Inactive', () => { pm.expect(body.rows[2].answer_required).to.equal(true); pm.expect(body.rows[2].question.status).to.equal('Inactive'); });
      set('importRowsCalc', usable.map((r) => r.question));
    }],
  }),
  importReq('POST Import Questions — Calculation into the temporary Calculation type', 'importRowsCalc', 'calcTypeKey', { imported: 3, answer_required: 1 }),
  verifyBank('GET Questions — verify the Calculation import', 'calcTypeKey', 'importRowsCalc', () => {
    pm.test('2 Active with answers, 1 Inactive without', () => {
      pm.expect(body.questions.filter((q) => q.status === 'Active' && q.correct_answer).length).to.equal(2);
      pm.expect(body.questions.filter((q) => q.status === 'Inactive' && q.correct_answer === '').length).to.equal(1);
    });
  }),
  preview('POST Import Preview — Mixed sections, numbering restarts (DOCX)', 'mixed-sections.docx', '{{testTypeKey}}', {
    test: () => {
      pm.test('2 Calculation + 1 Essay', () => pm.expect(body.rows.map((r) => [r.number, r.question.section])).to.eql([[1, 'CALCULATION'], [2, 'CALCULATION'], [1, 'ESSAY']]));
      pm.test('All 3 valid', () => pm.expect(body.valid).to.equal(3));
      pm.test('Interview notes are not imported', () => body.rows.forEach((r) => pm.expect(r.question.question_text).to.not.include('references')));
      pm.test('Sections reported', () => pm.expect(body.sections.filter((s) => s.kind === 'questions').length).to.be.at.least(2));
    },
  }),
  preview('POST Import Preview — Duplicate inside the same file (TXT)', 'duplicate-in-file.txt', '{{testTypeKey}}', { test: () => { pm.test('3 found, 2 valid, 1 duplicate', () => { pm.expect(body.found).to.equal(3); pm.expect(body.valid).to.equal(2); pm.expect(body.duplicates).to.equal(1); }); } }),
  preview('POST Import Preview — One invalid question does not block the rest (TXT)', 'one-invalid.txt', '{{testTypeKey}}', {
    test: () => {
      pm.test('3 found, 2 valid, 1 invalid (whole file not rejected)', () => { pm.expect(body.found).to.equal(3); pm.expect(body.valid).to.equal(2); pm.expect(body.invalid).to.equal(1); });
      pm.test('The reason is explained', () => pm.expect(body.rows[1].errors.join(' ')).to.include('Correct answer E'));
    },
  }),
  preview('POST Import Preview — Unknown columns: table shown for mapping (XLSX)', 'unknown-columns.xlsx', '{{testTypeKey}}', { test: () => { pm.test('Not rejected; the table comes back for HR to map', () => { pm.expect(body.found).to.equal(0); pm.expect(body.unmapped[0]).to.eql(['Name', 'Phone']); }); } }),
  req('POST Import Preview — Unknown columns with HR column mapping', 'POST', '/api/admin/questions/import/preview', {
    form: [{ key: 'section', value: '{{interviewTypeKey}}' }, { key: 'mapping', value: '{"header_row":0,"columns":{"0":"question_text"}}' }, file('unknown-columns.xlsx')], maxMs: 10000,
    test: () => { pm.test('Mapped column read as the question', () => { pm.expect(body.found).to.equal(1); pm.expect(body.rows[0].question.question_text).to.equal('A person'); pm.expect(body.mapped).to.equal(true); }); },
  }),
  req('POST Import Preview — no file', 'POST', '/api/admin/questions/import/preview', { form: [{ key: 'section', value: 'GENERAL' }], status: 400, error: 'Please choose a file.' }),
  preview('POST Import Preview — empty file', 'empty.txt', '{{testTypeKey}}', { status: 400, error: 'The file is empty.' }),
  preview('POST Import Preview — unsupported file type (.exe)', 'unsupported.exe', '{{testTypeKey}}', { status: 400, error: 'This file type is not supported.' }),
  preview('POST Import Preview — fake XLSX (text file)', 'fake.xlsx', '{{testTypeKey}}', { status: 400, error: 'does not look like a real .xlsx file' }),
  preview('POST Import Preview — corrupt DOCX', 'corrupt.docx', '{{testTypeKey}}', { status: 400, error: 'Unable to read this file.' }),
  preview('POST Import Preview — corrupt PDF', 'corrupt.pdf', '{{testTypeKey}}', { status: 400, error: 'Unable to read this file.' }),
  preview('POST Import Preview — malformed CSV', 'malformed.csv', '{{testTypeKey}}', { status: [200, 400], desc: 'An unclosed quote: the server must answer in a controlled way (a preview with the problem, or a 400), never a 500.', test: () => { pm.test('Controlled answer (preview rows or an error message)', () => pm.expect(Array.isArray(body.rows) || typeof body.error === 'string').to.equal(true)); } }),
  preview('POST Import Preview — file with no questions', 'no-questions.txt', '{{testTypeKey}}', { status: 400, error: 'Could not detect a valid question structure' }),
  req('POST Import Questions — nothing to import', 'POST', '/api/admin/questions/import', { json: { questions: [] }, status: 400, error: 'There are no valid questions to import.' }),
  req('POST Import Questions — unknown test type without a decision', 'POST', '/api/admin/questions/import', { json: { questions: [{ question_text: '{{runTag}} open question', type_name: '{{runTag}} UNDECIDED' }] }, status: 400, error: 'does not exist. Create it, or choose an existing test type.' }),
]);

// ================================================================================
// 09 Images
// ================================================================================
const imagesFolder = folder('09 Images', 'Question / option pictures. Upload returns an id; the same picture always gets the same id (no duplicates are stored).', [
  req('POST Upload Image', 'POST', '/api/admin/images', { json: { data_url: PNG }, status: 201, test: () => { pm.test('id returned', () => pm.expect(body.id).to.be.a('number')); set('imageId', String(body.id)); } }),
  req('POST Upload Image — not a picture', 'POST', '/api/admin/images', { json: { data_url: 'hello' }, status: 400, error: 'Please use a PNG, JPG, GIF or WebP picture.' }),
  req('GET Image', 'GET', '/api/admin/images/{{imageId}}', { type: 'png' }),
  req('GET Image — nonexistent', 'GET', '/api/admin/images/999999999', { status: 404 }),
  req('POST Create Question with a picture', 'POST', '/api/admin/questions', {
    json: { section: '{{testTypeKey}}', question_text: '{{runTag}} Picture question: which picture is shown?', image_id: '{{imageId}}', option_a: 'A dot', option_a_image: '{{imageId}}', option_b: 'A line', correct_answer: 'A' }, status: 201,
    test: () => { pm.test('Picture ids saved', () => { pm.expect(body.image_id).to.equal(Number(env('imageId'))); pm.expect(body.option_a_image).to.equal(Number(env('imageId'))); }); set('pictureQuestionId', String(body.id)); },
  }),
  req('POST Create Question — picture that does not exist', 'POST', '/api/admin/questions', { json: { section: '{{testTypeKey}}', question_text: '{{runTag}} missing picture', image_id: 999999999, option_a: 'x', option_b: 'y', correct_answer: 'A' }, status: 400, error: 'A picture could not be found.' }),
]);

// ================================================================================
// 10 Assessments (shared links)
// ================================================================================
const LINK = (extra) => ({ title: '{{runTag}} LINK', link_expiry_minutes: 60, eligibility_mark: 0, language: 'en', ...extra });
const assessments = folder('10 Assessments', 'POST /assessments creates ONE shared link (many candidates, each with their own attempt). All links here use temporary test types, except the IQ link, which draws from the real IQ bank but is only opened by this run\'s candidates.', [
  req('GET Question Counts — temporary types ready', 'GET', '/api/admin/questions/counts', {
    test: () => {
      pm.test('Temporary MCQ type: 9 active (4 TXT + 4 Excel + 1 picture)', () => pm.expect(body[env('testTypeKey')]).to.equal(9));
      pm.test('Temporary Interview type: 4 active', () => pm.expect(body[env('interviewTypeKey')]).to.equal(4));
      set('mcqActiveCount', String(body[env('testTypeKey')]));
    },
  }),
  req('POST Create Assessment — no tests', 'POST', '/api/admin/assessments', { json: LINK({ tests: [] }), status: 400 }),
  req('POST Create Assessment — unknown test', 'POST', '/api/admin/assessments', { json: LINK({ tests: ['POSTMAN_NO_SUCH_TYPE'], counts: { POSTMAN_NO_SUCH_TYPE: 1 } }), status: 400, error: 'Please choose tests from the list.' }),
  req('POST Create Assessment — more questions than the bank', 'POST', '/api/admin/assessments', { json: '{ "title": "{{runTag}} TOO MANY", "tests": ["{{testTypeKey}}"], "counts": { "{{testTypeKey}}": 500 }, "link_expiry_minutes": 60 }', status: 400, error: 'active' }),
  req('POST Create Assessment — invalid expiry', 'POST', '/api/admin/assessments', { json: '{ "title": "{{runTag}} BAD EXPIRY", "tests": ["{{testTypeKey}}"], "counts": { "{{testTypeKey}}": 1 }, "link_expiry_minutes": 999999999 }', status: 400, error: 'Link expiry must be between' }),
  req('POST Create Assessment — invalid pass mark', 'POST', '/api/admin/assessments', { json: '{ "title": "{{runTag}} BAD PASS", "tests": ["{{testTypeKey}}"], "counts": { "{{testTypeKey}}": 1 }, "pass_marks": { "{{testTypeKey}}": 150 }, "link_expiry_minutes": 60 }', status: 400, error: 'between 0 and 100' }),
  req('POST Create Assessment — MCQ + Interview link', 'POST', '/api/admin/assessments', {
    status: 201,
    json: '{\n  "title": "{{runTag}} LINK",\n  "tests": ["{{testTypeKey}}", "{{interviewTypeKey}}"],\n  "counts": { "{{testTypeKey}}": 3, "{{interviewTypeKey}}": 1 },\n  "minutes": { "{{testTypeKey}}": 10, "{{interviewTypeKey}}": 10 },\n  "pass_marks": { "{{testTypeKey}}": 0, "{{interviewTypeKey}}": 0 },\n  "eligibility_mark": 0,\n  "link_expiry_minutes": 60\n}',
    test: () => {
      pm.test('A shared link with a token, open', () => { pm.expect(body.kind).to.equal('link'); pm.expect(body.token).to.be.a('string').with.length.above(20); pm.expect(body.share_state).to.equal('open'); pm.expect(!!body.enabled).to.equal(true); });
      pm.test('Tests in order with counts, timers, pass marks', () => pm.expect(body.stages.map((s) => [s.section, s.question_count, s.time_limit_minutes, s.pass_mark])).to.eql([[env('testTypeKey'), 3, 10, 0], [env('interviewTypeKey'), 1, 10, 0]]));
      set('linkId', String(body.id)); set('linkToken', body.token); set('candidateToken', body.token);
    },
  }),
  req('POST Create Assessment — IQ link', 'POST', '/api/admin/assessments', {
    status: 201,
    json: '{ "title": "{{runTag}} IQ LINK", "tests": ["IQ"], "counts": { "IQ": {{iqCount}} }, "minutes": { "IQ": 15 }, "pass_marks": { "IQ": 50 }, "link_expiry_minutes": 60 }',
    test: () => {
      pm.test('IQ question count = the number chosen', () => pm.expect(body.stages[0].question_count).to.equal(Number(env('iqCount'))));
      pm.test('Pass mark 50', () => pm.expect(body.stages[0].pass_mark).to.equal(50));
      set('iqLinkId', String(body.id)); set('iqLinkToken', body.token);
    },
  }),
  req('POST Create Assessment — spare link (never used)', 'POST', '/api/admin/assessments', {
    status: 201, json: '{ "title": "{{runTag}} SPARE LINK", "tests": ["{{testTypeKey}}"], "counts": { "{{testTypeKey}}": 1 }, "link_expiry_minutes": 60 }',
    test: () => { set('spareLinkId', String(body.id)); set('spareLinkToken', body.token); },
  }),
  req('GET Assessments', 'GET', '/api/admin/assessments', {
    test: () => {
      pm.test('Array, newest first, includes the new links with 0 candidates', () => {
        pm.expect(body).to.be.an('array');
        const mine = body.filter((x) => x.kind === 'link' && [env('linkId'), env('iqLinkId'), env('spareLinkId')].map(Number).includes(x.id));
        pm.expect(mine.length).to.equal(3);
        mine.forEach((l) => pm.expect(l.candidates).to.equal(0));
      });
    },
  }),
]);

// ================================================================================
// 11 Assessment Links
// ================================================================================
const links = folder('11 Assessment Links', 'Enable / disable / regenerate / delete — only on this run\'s links. A disabled link lets no NEW candidate start.', [
  req('GET Link', 'GET', '/api/admin/links/{{linkId}}', { test: () => { pm.test('link + attempts (none yet)', () => { pm.expect(body.link.id).to.equal(Number(env('linkId'))); pm.expect(body.attempts).to.eql([]); }); } }),
  req('GET Link — nonexistent', 'GET', '/api/admin/links/999999999', { status: 404 }),
  req('POST Disable Link', 'POST', '/api/admin/links/{{spareLinkId}}/disable', { test: () => { pm.test('Disabled', () => { pm.expect(!!body.enabled).to.equal(false); pm.expect(body.share_state).to.equal('disabled'); }); } }),
  req('GET Exam — disabled link', 'GET', '/api/exam/{{spareLinkToken}}', { cand: 'X', test: () => { pm.test('state = disabled', () => pm.expect(body.state).to.equal('disabled')); } }),
  req('POST Start — disabled link', 'POST', '/api/exam/{{spareLinkToken}}/start', { cand: 'X', json: { name: '{{runTag}} BLOCKED', phone: '020 0000 0199' }, status: 409, test: () => { pm.test('Refused: state = disabled', () => pm.expect(body.state).to.equal('disabled')); } }),
  req('POST Enable Link', 'POST', '/api/admin/links/{{spareLinkId}}/enable', { test: () => { pm.test('Open again', () => { pm.expect(!!body.enabled).to.equal(true); pm.expect(body.share_state).to.equal('open'); }); } }),
  req('POST Regenerate Link — unused', 'POST', '/api/admin/links/{{spareLinkId}}/regenerate', {
    test: () => { pm.test('New token', () => pm.expect(body.token).to.not.equal(env('spareLinkToken'))); set('oldSpareToken', env('spareLinkToken')); set('spareLinkToken', body.token); },
  }),
  req('GET Exam — old token after regenerate', 'GET', '/api/exam/{{oldSpareToken}}', { noAuth: true, status: 404, test: () => { pm.test('state = not_found', () => pm.expect(body.state).to.equal('not_found')); } }),
  req('GET Exam — new token after regenerate', 'GET', '/api/exam/{{spareLinkToken}}', { cand: 'X', test: () => { pm.test('state = ready', () => pm.expect(body.state).to.equal('ready')); } }),
  req('POST Regenerate Link — nonexistent', 'POST', '/api/admin/links/999999999/regenerate', { status: 404 }),
  req('DELETE Link — unused', 'DELETE', '/api/admin/links/{{spareLinkId}}', { test: () => { pm.test('ok = true', () => pm.expect(body.ok).to.equal(true)); } }),
  req('DELETE Link — already deleted', 'DELETE', '/api/admin/links/{{spareLinkId}}', { status: 404 }),
  // An open link must never be left with an empty (or too small) later test.
  req('GET Question Counts — the temporary MCQ type', 'GET', '/api/admin/questions/counts', {
    test: () => { pm.test('Has active questions', () => pm.expect(body[env('testTypeKey')]).to.be.above(0)); set('guardNeed', String(body[env('testTypeKey')])); },
  }),
  req('POST Create Assessment — a link that needs every question of the temporary MCQ type', 'POST', '/api/admin/assessments', {
    status: 201, json: '{ "title": "{{runTag}} GUARD LINK", "tests": ["{{testTypeKey}}"], "counts": { "{{testTypeKey}}": {{guardNeed}} }, "link_expiry_minutes": 60, "eligibility_mark": 0, "language": "en" }',
    test: () => { set('guardLinkId', String(body.id)); },
  }),
  req('GET Questions — one active question of the temporary MCQ type', 'GET', '/api/admin/questions', {
    q: { section: '{{testTypeKey}}', status: 'Active' },
    test: () => { const q = body.questions[0]; pm.test('Found', () => pm.expect(q).to.exist); set('guardQuestionId', String(q.id)); set('guardQuestionJson', { ...q, status: 'Inactive' }); },
  }),
  req('PUT Question — make it Inactive while an open link needs it', 'PUT', '/api/admin/questions/{{guardQuestionId}}', {
    json: '{{guardQuestionJson}}', status: 400, error: 'without enough active questions',
    desc: 'Removal guard: HR cannot make a question Inactive when an open link (or a candidate between tests) would then not have enough questions. Only a temporary question of this run is used.',
  }),
  req('DELETE Question — while an open link needs it', 'DELETE', '/api/admin/questions/{{guardQuestionId}}', { status: 400, error: 'Disable those links, or add questions first.' }),
  req('GET Questions — the question is still active', 'GET', '/api/admin/questions', {
    q: { section: '{{testTypeKey}}', status: 'Active' },
    test: () => { pm.test('Not removed, not deactivated', () => pm.expect(body.questions.map((q) => q.id)).to.include(Number(env('guardQuestionId')))); },
  }),
  req('DELETE Link — the guard link (unused)', 'DELETE', '/api/admin/links/{{guardLinkId}}', { test: () => { pm.test('ok = true', () => pm.expect(body.ok).to.equal(true)); } }),
]);

// ================================================================================
// 12 Public Exam (candidates A and B on the same shared link)
// ================================================================================
const START = (who) => ({ name: `{{runTag}} ${who}`, phone: '020 0000 0' + String(100 + who.length), graduate_from: 'University', university: 'Postman University', subject: 'Testing', gpa: '3.0' });
const exam = folder('12 Public Exam', 'The candidate API. Each candidate has their own session cookie (captured from Set-Cookie; the cookie jar is off). Candidates A and B use the SAME link: independent sessions, questions, answers and results. The server decides the questions, the timer and the next test.', [
  req('GET Exam — invalid token', 'GET', '/api/exam/postman-invalid-token', { noAuth: true, status: 404, test: () => { pm.test('state = not_found', () => pm.expect(body.state).to.equal('not_found')); } }),
  req('POST Start — invalid token', 'POST', '/api/exam/postman-invalid-token/start', { noAuth: true, json: START('NOBODY'), status: 404 }),
  req('GET Exam — Candidate A opens the link', 'GET', '/api/exam/{{linkToken}}', {
    cand: 'A', pre: () => { pm.environment.set('candidateSessionA', ''); },
    test: () => {
      pm.test('state = ready, shared link, 2 tests', () => { pm.expect(body.state).to.equal('ready'); pm.expect(body.shared).to.equal(true); pm.expect(body.tests.length).to.equal(2); pm.expect(body.question_count).to.equal(3); });
      pm.test('Nobody\'s details are pre-filled', () => pm.expect(body).to.not.have.property('candidate'));
      pm.test('A session cookie was issued', () => pm.expect(env('candidateSessionA')).to.have.length.above(31));
    },
  }),
  req('GET Link — opening the link created no record', 'GET', '/api/admin/links/{{linkId}}', { test: () => { pm.test('Still 0 attempts', () => pm.expect(body.attempts.length).to.equal(0)); } }),
  req('POST Start — missing name', 'POST', '/api/exam/{{linkToken}}/start', { cand: 'A', json: { phone: '020 0000 0000' }, status: 400, error: 'name_required' }),
  req('POST Start — missing phone', 'POST', '/api/exam/{{linkToken}}/start', { cand: 'A', json: { name: '{{runTag}} A' }, status: 400, error: 'phone_required' }),
  req('POST Start — Candidate A', 'POST', '/api/exam/{{linkToken}}/start', {
    cand: 'A', json: START('A'),
    test: () => {
      pm.test('in_progress, first test, 3 questions', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.section).to.equal(env('testTypeKey')); pm.expect(body.questions.length).to.equal(3); });
      pm.test('Server timer running (1-600 s)', () => pm.expect(body.remaining_seconds).to.be.within(1, 600));
      pm.test('No correct answers or marks are sent to the candidate', () => body.questions.forEach((q) => { pm.expect(q).to.not.have.any.keys('correct_answer', 'max_marks', 'marks'); pm.expect(q.kind).to.equal('choice'); }));
      set('questionsA', body.questions.map((q) => ({ id: q.id, options: q.options.map((o) => o.key), image: q.image })));
      set('remainingA', String(body.remaining_seconds));
    },
  }),
  req('GET Exam — Candidate A refreshes', 'GET', '/api/exam/{{linkToken}}', {
    cand: 'A',
    test: () => {
      const before = getJSON('questionsA');
      pm.test('Same questions, same order, same option order (no reshuffle)', () => pm.expect(body.questions.map((q) => ({ id: q.id, options: q.options.map((o) => o.key), image: q.image }))).to.eql(before));
      pm.test('Deadline kept (timer did not restart)', () => pm.expect(body.remaining_seconds).to.be.at.most(Number(env('remainingA'))));
    },
  }),
  req('GET Exam — Candidate B opens the same link', 'GET', '/api/exam/{{linkToken}}', {
    cand: 'B', pre: () => { pm.environment.set('candidateSessionB', ''); },
    test: () => {
      pm.test('B starts fresh (does not see A)', () => { pm.expect(body.state).to.equal('ready'); pm.expect(body).to.not.have.property('candidate'); });
      pm.test('B has a different session', () => pm.expect(env('candidateSessionB')).to.not.equal(env('candidateSessionA')));
    },
  }),
  req('POST Start — Candidate B', 'POST', '/api/exam/{{linkToken}}/start', {
    cand: 'B', json: START('BB'),
    test: () => {
      pm.test('B has own 3-question snapshot', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.questions.length).to.equal(3); });
      const a = getJSON('questionsA').map((q) => q.id);
      const b = body.questions.map((q) => q.id);
      pm.test('A and B are separate attempts (different snapshot rows)', () => pm.expect(b.filter((id) => a.includes(id))).to.eql([]));
      set('questionsB', body.questions.map((q) => ({ id: q.id, options: q.options.map((o) => o.key) })));
    },
  }),
  req('PUT Answer — Candidate A', 'PUT', '/api/exam/{{linkToken}}/answer', {
    cand: 'A', json: '{ "question_id": {{firstQuestionA}}, "answer": "{{firstOptionA}}" }',
    pre: () => { const q = getJSON('questionsA')[0]; pm.variables.set('firstQuestionA', q.id); pm.variables.set('firstOptionA', q.options[0]); },
    test: () => { pm.test('Saved', () => { pm.expect(body.ok).to.equal(true); pm.expect(body.remaining_seconds).to.be.a('number'); }); },
  }),
  req('PUT Answer — Candidate A tries to answer B\'s question', 'PUT', '/api/exam/{{linkToken}}/answer', {
    cand: 'A', json: '{ "question_id": {{questionOfB}}, "answer": "A" }', status: 400, error: 'unknown_question',
    pre: () => { pm.variables.set('questionOfB', getJSON('questionsB')[0].id); },
    desc: 'Isolation: a candidate can only answer questions of their own running test.',
  }),
  req('PUT Answer — unknown question', 'PUT', '/api/exam/{{linkToken}}/answer', { cand: 'A', json: { question_id: 999999999, answer: 'A' }, status: 400, error: 'unknown_question' }),
  req('GET Exam — Candidate B\'s answers untouched', 'GET', '/api/exam/{{linkToken}}', { cand: 'B', test: () => { pm.test('B has no answers', () => body.questions.forEach((q) => pm.expect(q.answer).to.equal(null))); } }),
  req('POST Focus Lost — Candidate A', 'POST', '/api/exam/{{linkToken}}/focus-lost', { cand: 'A', test: () => { pm.test('ok', () => pm.expect(body.ok).to.equal(true)); } }),
  req('GET Exam Image — picture not in A\'s running test', 'GET', '/api/exam/{{linkToken}}/images/{{imageId}}', {
    cand: 'A', status: [200, 404], type: 'any',
    desc: 'A picture is served only if it belongs to a question of this candidate\'s running test: 200 if A drew the picture question, otherwise 404.',
    test: () => {
      const hasPicture = getJSON('questionsA').some((q) => q.image);
      pm.test(hasPicture ? 'A has the picture question -> 200' : 'A does not have the picture question -> 404', () => pm.expect(pm.response.code).to.equal(hasPicture ? 200 : 404));
      pm.test(hasPicture ? 'The picture is a PNG' : 'A JSON "Not found." answer', () => pm.expect(pm.response.headers.get('Content-Type') || '').to.include(hasPicture ? 'image/png' : 'application/json'));
    },
  }),
  req('POST Submit — Candidate A, first test', 'POST', '/api/exam/{{linkToken}}/submit', {
    cand: 'A', json: '{ "answers": {{answersA}} }',
    pre: () => { const a = {}; getJSON('questionsA').forEach((q) => { a[q.id] = q.options[0]; }); pm.variables.set('answersA', JSON.stringify(a)); },
    test: () => {
      pm.test('Passed (pass mark 0): next test is waiting', () => { pm.expect(body.state).to.equal('next_test'); pm.expect(body.passed_section).to.equal(env('testTypeKey')); pm.expect(body.next_section).to.equal(env('interviewTypeKey')); });
      pm.test('Result: points / max / percent / Pass', () => { pm.expect(body.last_result.points).to.be.a('number'); pm.expect(body.last_result.max).to.be.above(0); pm.expect(body.last_result.percent).to.be.a('number'); pm.expect(body.last_result.result).to.equal('Pass'); });
    },
  }),
  req('POST Continue — Candidate A opens the next test', 'POST', '/api/exam/{{linkToken}}/continue', {
    cand: 'A',
    test: () => {
      pm.test('Interview test running with 1 written question', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.section).to.equal(env('interviewTypeKey')); pm.expect(body.questions.length).to.equal(1); pm.expect(body.questions[0].kind).to.equal('essay'); pm.expect(body.questions[0].options).to.eql([]); });
      set('essayQuestionA', String(body.questions[0].id));
    },
  }),
  req('POST Continue — again while running (no change)', 'POST', '/api/exam/{{linkToken}}/continue', { cand: 'A', test: () => { pm.test('Still the same running test', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.questions[0].id).to.equal(Number(env('essayQuestionA'))); }); } }),
  req('POST Submit — Candidate A, interview answer', 'POST', '/api/exam/{{linkToken}}/submit', {
    cand: 'A', json: '{ "answers": { "{{essayQuestionA}}": "I planned the work, asked for help and finished on time." } }',
    pre: () => { pm.environment.set('sessionUsedByA', pm.environment.get('candidateSessionA')); },
    test: () => {
      pm.test('Submitted; waiting for HR marking', () => { pm.expect(body.state).to.equal('submitted'); pm.expect(body.last_result.result).to.equal('Pending'); });
      pm.test('The finished attempt released this browser: a new session cookie', () => pm.expect(env('candidateSessionA')).to.not.equal(env('sessionUsedByA')));
    },
  }),
  req('POST Submit — Candidate A again', 'POST', '/api/exam/{{linkToken}}/submit', {
    cand: 'A', json: { answers: {} }, status: 409,
    desc: 'The browser now has a new session, so there is nothing to submit; A\'s finished attempt is not changed (checked in folder 15).',
    test: () => { pm.test('Refused, and nothing of A is shown', () => { pm.expect(body.state).to.not.equal('in_progress'); pm.expect(body).to.not.have.property('candidate'); pm.expect(body).to.not.have.property('questions'); }); },
  }),
  req('PUT Answer — after submitting', 'PUT', '/api/exam/{{linkToken}}/answer', { cand: 'A', json: '{ "question_id": {{essayQuestionA}}, "answer": "changed" }', status: 409 }),
  // The SAME browser (A's cookie variable, one cookie jar) is used by the next two people in turn.
  ...['SB2', 'SB3'].flatMap((who, i) => [
    req(`GET Exam — the same browser, next person (${who}) opens the link`, 'GET', '/api/exam/{{linkToken}}', {
      cand: 'A', test: () => { pm.test('Start form, nothing of the previous person', () => { pm.expect(body.state).to.equal('ready'); pm.expect(body).to.not.have.property('candidate'); pm.expect(body).to.not.have.property('questions'); }); },
    }),
    req(`POST Start — ${who} on the same browser`, 'POST', '/api/exam/{{linkToken}}/start', {
      cand: 'A', json: { ...START(who), phone: '020 0000 02' + String(i + 1).padStart(2, '0') }, P: { who },
      pre: () => { pm.environment.set('sameBrowserSession' + P.who, pm.environment.get('candidateSessionA')); },
      test: () => {
        pm.test('A NEW attempt for this person', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.candidate.name).to.equal(env('runTag') + ' ' + P.who); pm.expect(body.questions.length).to.equal(3); });
        set('questions' + P.who, body.questions.map((q) => ({ id: q.id, options: q.options.map((o) => o.key) })));
      },
    }),
    ...(i === 0 ? [
      req('POST Start — someone else tries to take over SB2 (active)', 'POST', '/api/exam/{{linkToken}}/start', {
        cand: 'A', json: { ...START('INTRUDER'), phone: '020 0000 0299' }, status: 409, error: 'assessment_in_progress',
        desc: 'While an attempt is active in this browser, a Start with other details is refused; nothing of the owner is sent back and no record is created.',
        test: () => { pm.test('Only the error: no candidate, questions, answers or result', () => pm.expect(Object.keys(body)).to.eql(['error'])); },
      }),
      req('GET Exam — SB2 refreshes and resumes', 'GET', '/api/exam/{{linkToken}}', {
        cand: 'A', test: () => { pm.test('SB2\'s own attempt, same questions', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.candidate.name).to.equal(env('runTag') + ' SB2'); pm.expect(body.questions.map((q) => q.id)).to.eql(getJSON('questionsSB2').map((q) => q.id)); }); },
      }),
    ] : []),
    req(`POST Submit — ${who}, first test`, 'POST', '/api/exam/{{linkToken}}/submit', {
      cand: 'A', json: `{ "answers": {{answers${who}}} }`, P: { who },
      pre: () => { const a = {}; getJSON('questions' + P.who).forEach((q) => { a[q.id] = q.options[0]; }); pm.variables.set('answers' + P.who, JSON.stringify(a)); },
      test: () => { pm.test('Next test waiting', () => pm.expect(body.state).to.equal('next_test')); },
    }),
    req(`POST Continue — ${who}`, 'POST', '/api/exam/{{linkToken}}/continue', {
      cand: 'A', P: { who }, test: () => { pm.test('Interview test running', () => pm.expect(body.state).to.equal('in_progress')); set('essayQuestion' + P.who, String(body.questions[0].id)); },
    }),
    req(`POST Submit — ${who}, interview answer`, 'POST', '/api/exam/{{linkToken}}/submit', {
      cand: 'A', json: `{ "answers": { "{{essayQuestion${who}}}": "My own answer." } }`, P: { who },
      test: () => { pm.test('Submitted; result shown at once; session released', () => { pm.expect(body.state).to.equal('submitted'); pm.expect(env('candidateSessionA')).to.not.equal(env('sameBrowserSession' + P.who)); }); },
    }),
  ]),
  req('GET Link — A, SB2 and SB3: three attempts from one browser', 'GET', '/api/admin/links/{{linkId}}', {
    test: () => {
      const find = (who) => body.attempts.find((x) => x.candidate_name === env('runTag') + ' ' + who);
      const list = ['A', 'SB2', 'SB3'].map(find);
      pm.test('Three submitted attempts', () => list.forEach((a) => { pm.expect(a).to.exist; pm.expect(a.status).to.equal('SUBMITTED'); }));
      pm.test('Different attempts and candidates', () => { pm.expect(new Set(list.map((a) => a.id)).size).to.equal(3); pm.expect(new Set(list.map((a) => a.candidate_id)).size).to.equal(3); });
      pm.test('Three different browser sessions were used', () => pm.expect(new Set([env('sessionUsedByA'), env('sameBrowserSessionSB2'), env('sameBrowserSessionSB3')]).size).to.equal(3));
      pm.test('The intruder was never recorded', () => pm.expect(body.attempts.some((x) => x.candidate_name === env('runTag') + ' INTRUDER')).to.equal(false));
    },
  }),
  req('GET Link — two independent attempts', 'GET', '/api/admin/links/{{linkId}}', {
    test: () => {
      const a = body.attempts.find((x) => x.candidate_name === env('runTag') + ' A');
      const b = body.attempts.find((x) => x.candidate_name === env('runTag') + ' BB');
      pm.test('A submitted, B in progress, separate candidates', () => { pm.expect(a.status).to.equal('SUBMITTED'); pm.expect(b.status).to.equal('IN_PROGRESS'); pm.expect(a.candidate_id).to.not.equal(b.candidate_id); });
      set('assessmentId', String(a.id)); set('attemptB', String(b.id)); set('candidateIdA', String(a.candidate_id));
    },
  }),
  req('GET Exam — A\'s session on another link', 'GET', '/api/exam/{{iqLinkToken}}', {
    cand: 'A', desc: 'Cross-record isolation: A\'s cookie belongs to one link; on another link it gives a fresh start, never A\'s data.',
    test: () => { pm.test('A new visitor there: ready, nothing of A', () => { pm.expect(body.state).to.equal('ready'); pm.expect(body).to.not.have.property('candidate'); pm.expect(body).to.not.have.property('questions'); }); },
  }),
]);

// ================================================================================
// 13 IQ Scoring (three candidates on the IQ link: all correct, all wrong, mixed)
// ================================================================================
const IQ_LEVEL = { Easy: 1, Basic: 2, Moderate: 3, Difficult: 4, 'Very Difficult': 5 };
const iqFolder = [];
for (const [who, strategy] of [['S1', 'all_correct'], ['S2', 'all_wrong'], ['S3', 'mixed']]) {
  iqFolder.push(
    req(`GET Exam — ${who} opens the IQ link`, 'GET', '/api/exam/{{iqLinkToken}}', { cand: who, pre: () => { pm.environment.set('candidateSession' + P.who, ''); }, P: { who }, test: () => { pm.test('ready', () => pm.expect(body.state).to.equal('ready')); } }),
    req(`POST Start — ${who} (${strategy.replace('_', ' ')})`, 'POST', '/api/exam/{{iqLinkToken}}/start', {
      cand: who, json: START(who), P: { who },
      test: () => {
        pm.test('IQ running with exactly the chosen number of questions', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.section).to.equal('IQ'); pm.expect(body.questions.length).to.equal(Number(env('iqCount'))); });
        set('iqIds' + P.who, body.questions.map((q) => q.id));
      },
    }),
    req(`GET Link — find ${who}'s attempt`, 'GET', '/api/admin/links/{{iqLinkId}}', {
      P: { who },
      test: () => {
        const a = body.attempts.find((x) => x.candidate_name === env('runTag') + ' ' + P.who);
        pm.test('Attempt found', () => pm.expect(a).to.exist);
        set('iqAttempt' + P.who, String(a.id)); set('iqCandidate' + P.who, String(a.candidate_id));
      },
    }),
    req(`GET Assessment — ${who}'s IQ snapshot`, 'GET', '/api/admin/assessments/{{iqAttempt' + who + '}}', {
      P: { who, strategy, levels: IQ_LEVEL },
      desc: 'Reads this candidate\'s saved questions (the snapshot) and decides the answers: all correct, all wrong, or every other one correct. The expected score is worked out from the snapshot marks — no maximum is hard-coded.',
      test: () => {
        const qs = body.questions.filter((q) => q.section === 'IQ');
        pm.test('Snapshot has exactly the chosen number of IQ questions', () => pm.expect(qs.length).to.equal(Number(env('iqCount'))));
        pm.test('Each question\'s marks = its level (Level 1 = 1 … Level 5 = 5)', () => qs.forEach((q) => pm.expect(q.max_marks, q.difficulty).to.equal(P.levels[q.difficulty])));
        pm.test('Snapshot = the questions the candidate sees', () => pm.expect(qs.map((q) => q.id)).to.eql(getJSON('iqIds' + P.who)));
        const answers = {};
        let points = 0; let max = 0; let correct = 0;
        qs.forEach((q, i) => {
          const order = JSON.parse(q.option_order);
          const right = P.strategy === 'all_correct' || (P.strategy === 'mixed' && i % 2 === 0);
          answers[q.id] = right ? q.correct_answer : order.find((L) => L !== q.correct_answer);
          max += q.max_marks;
          if (right) { points += q.max_marks; correct++; }
        });
        set('iqAnswers' + P.who, answers);
        set('iqExpected' + P.who, { points, max, correct, lalco: Math.round((points / max) * 150) });
      },
    }),
    req(`POST Submit — ${who}`, 'POST', '/api/exam/{{iqLinkToken}}/submit', {
      cand: who, json: `{ "answers": {{iqAnswers${who}}} }`, P: { who },
      test: () => {
        const e = getJSON('iqExpected' + P.who);
        pm.test('Submitted', () => pm.expect(body.state).to.equal('submitted'));
        pm.test(`Weighted score ${e.points} / ${e.max} (from the snapshot)`, () => { pm.expect(body.last_result.points).to.equal(e.points); pm.expect(body.last_result.max).to.equal(e.max); });
        pm.test(`LALCO IQ Score = round(${e.points} / ${e.max} x 150) = ${e.lalco}`, () => pm.expect(body.last_result.lalco_iq_score).to.equal(e.lalco));
        pm.test('LALCO IQ Score within 0-150', () => pm.expect(body.last_result.lalco_iq_score).to.be.within(0, 150));
        pm.test('IQ percentage is not sent to the candidate', () => pm.expect(body.last_result).to.not.have.property('percent'));
        pm.test('PASS / NOT PASS by the 50% pass mark', () => pm.expect(body.last_result.result).to.equal(Math.round(((e.points / e.max) * 100) * 10) / 10 >= 50 ? 'Pass' : 'Not Pass'));
      },
    }),
    req(`GET Assessment — verify ${who}'s result on the server`, 'GET', '/api/admin/assessments/{{iqAttempt' + who + '}}', {
      P: { who, strategy },
      test: () => {
        const e = getJSON('iqExpected' + P.who);
        const t = body.tests[0];
        const bands = getJSON('iqBands');
        pm.test('Question count = saved questions = chosen count; no mismatch flag', () => { pm.expect(t.question_count).to.equal(Number(env('iqCount'))); pm.expect(t.questions_assigned).to.equal(Number(env('iqCount'))); pm.expect(t.review_required).to.equal(null); });
        pm.test('Server score = expected', () => { pm.expect(t.points).to.equal(e.points); pm.expect(t.max).to.equal(e.max); pm.expect(t.lalco_iq_score).to.equal(e.lalco); });
        pm.test('HR sees the percentage', () => pm.expect(t.percent).to.equal(Math.round(((e.points / e.max) * 100) * 10) / 10));
        const band = bands.find((b) => e.lalco >= b.min && e.lalco <= b.max);
        pm.test(`Classification from the LALCO IQ Score: ${band.description}`, () => pm.expect(t.level).to.equal(band.description));
        pm.test('Level breakdown adds up to the questions and marks', () => {
          pm.expect(body.iq.iq_levels.reduce((n, l) => n + l.total, 0)).to.equal(Number(env('iqCount')));
          pm.expect(body.iq.iq_levels.reduce((n, l) => n + l.marks, 0)).to.equal(e.points);
          pm.expect(body.iq.iq_levels.reduce((n, l) => n + l.max, 0)).to.equal(e.max);
          pm.expect(body.iq.iq_correct).to.equal(e.correct);
        });
        if (P.strategy === 'all_correct') pm.test('All correct -> 150', () => pm.expect(t.lalco_iq_score).to.equal(150));
        if (P.strategy === 'all_wrong') pm.test('All wrong -> 0', () => pm.expect(t.lalco_iq_score).to.equal(0));
      },
    }),
  );
}
iqFolder.push(req('GET Link — randomization across the three IQ candidates', 'GET', '/api/admin/links/{{iqLinkId}}', {
  desc: 'Each candidate got their own snapshot. When the bank is larger than the test, the server re-draws a set identical to another candidate\'s, so the three sets are not all the same.',
  test: () => {
    const sets = body.attempts.map((a) => (a.question_ids.IQ || []).join(','));
    pm.test('3 attempts, each with the chosen number of questions', () => { pm.expect(body.attempts.length).to.equal(3); body.attempts.forEach((a) => pm.expect(a.question_ids.IQ.length).to.equal(Number(env('iqCount')))); });
    if (Number(env('iqBankSize')) > Number(env('iqCount'))) pm.test('Not all three question sets are identical', () => pm.expect(new Set(sets).size).to.be.above(1));
    console.log('Distinct IQ question sets:', new Set(sets).size, 'of 3');
  },
}));
const iq = folder('13 IQ Scoring', 'Three temporary candidates on the IQ link: all correct, all wrong, every other one correct. Scores are checked against the candidate\'s own saved questions: LALCO IQ Score = weighted marks / maximum of those questions x 150 (0-150), rounded.', iqFolder);

// ================================================================================
// 14 Timer & Expiry
// ================================================================================
const timer = folder('14 Timer & Expiry', 'A 1-minute test on a link that expires after 1 minute. The collection waits 65 seconds, then checks the SERVER enforces the deadline (auto-submit) and the link expiry. Set skipTimerTests = true to skip the wait.', [
  req('POST Create Assessment — 1-minute link', 'POST', '/api/admin/assessments', {
    status: 201, json: '{ "title": "{{runTag}} TIMER LINK", "tests": ["{{testTypeKey}}"], "counts": { "{{testTypeKey}}": {{mcqActiveCount}} }, "minutes": { "{{testTypeKey}}": 1 }, "link_expiry_minutes": 1 }',
    desc: 'Uses every active question of the temporary MCQ type, so the picture question is always included.',
    test: () => { pm.test('1 minute timer, 1 minute expiry', () => { pm.expect(body.stages[0].time_limit_minutes).to.equal(1); pm.expect(body.link_expiry_minutes).to.equal(1); }); set('timerLinkId', String(body.id)); set('timerLinkToken', body.token); },
  }),
  req('GET Exam — Candidate C opens the link', 'GET', '/api/exam/{{timerLinkToken}}', { cand: 'C', pre: () => { pm.environment.set('candidateSessionC', ''); }, test: () => { pm.test('ready', () => pm.expect(body.state).to.equal('ready')); } }),
  req('POST Start — Candidate C', 'POST', '/api/exam/{{timerLinkToken}}/start', {
    cand: 'C', json: START('C'),
    test: () => {
      pm.test('Running, at most 60 s left', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.remaining_seconds).to.be.within(1, 60); });
      const pic = body.questions.find((q) => q.image);
      pm.test('The picture question is in this test, with a picture URL on this link', () => { pm.expect(pic).to.exist; pm.expect(pic.image).to.equal(`/api/exam/${env('timerLinkToken')}/images/${env('imageId')}`); });
      set('questionsC', body.questions.map((q) => ({ id: q.id, options: q.options.map((o) => o.key) })));
    },
  }),
  req('GET Exam Image — picture in C\'s running test', 'GET', '/api/exam/{{timerLinkToken}}/images/{{imageId}}', { cand: 'C', type: 'png' }),
  req('GET Exam Image — without a candidate session', 'GET', '/api/exam/{{timerLinkToken}}/images/{{imageId}}', { noAuth: true, status: 404, desc: 'Pictures are only served to the candidate whose running test contains them.' }),
  req('PUT Answer — Candidate C before the deadline', 'PUT', '/api/exam/{{timerLinkToken}}/answer', {
    cand: 'C', json: '{ "question_id": {{firstQuestionC}}, "answer": "{{firstOptionC}}" }',
    pre: () => { const q = getJSON('questionsC')[0]; pm.variables.set('firstQuestionC', q.id); pm.variables.set('firstOptionC', q.options[0]); },
    test: () => { pm.test('Saved', () => pm.expect(body.ok).to.equal(true)); },
  }),
  req('GET Exam — Candidate C after the deadline (waits 65 s)', 'GET', '/api/exam/{{timerLinkToken}}', {
    cand: 'C', maxMs: 5000,
    pre: () => {
      if (env('skipTimerTests') === 'true') { console.log('Skipped: skipTimerTests = true'); pm.execution.skipRequest(); }
      console.log('Waiting 65 seconds for the 1-minute deadline and link expiry…');
      setTimeout(() => {}, 65000);
    },
    test: () => { pm.test('The server submitted the test itself (auto_submitted)', () => { pm.expect(body.state).to.equal('submitted'); pm.expect(body.auto_submitted).to.equal(true); }); },
  }),
  req('PUT Answer — after the deadline', 'PUT', '/api/exam/{{timerLinkToken}}/answer', { cand: 'C', json: '{ "question_id": {{firstQuestionC}}, "answer": "B" }', pre: () => { if (env('skipTimerTests') === 'true') pm.execution.skipRequest(); pm.variables.set('firstQuestionC', getJSON('questionsC')[0].id); }, status: 409 }),
  req('POST Submit — after the deadline', 'POST', '/api/exam/{{timerLinkToken}}/submit', { cand: 'C', json: { answers: {} }, pre: () => { if (env('skipTimerTests') === 'true') pm.execution.skipRequest(); }, status: 409 }),
  req('GET Exam — new visitor after the link expired', 'GET', '/api/exam/{{timerLinkToken}}', { cand: 'D', pre: () => { if (env('skipTimerTests') === 'true') pm.execution.skipRequest(); pm.environment.set('candidateSessionD', ''); }, test: () => { pm.test('state = expired', () => pm.expect(body.state).to.equal('expired')); } }),
  req('POST Start — new visitor after the link expired', 'POST', '/api/exam/{{timerLinkToken}}/start', { cand: 'D', json: START('D'), pre: () => { if (env('skipTimerTests') === 'true') pm.execution.skipRequest(); }, status: 409, test: () => { pm.test('Refused: expired', () => pm.expect(body.state).to.equal('expired')); } }),
]);

// ================================================================================
// 15 Results & Reports
// ================================================================================
const FIELDS = ['Candidate Name', 'Phone Number', 'Graduate From', 'High School', 'College', 'University', 'School Name', 'Subject', 'GPA / Mark', 'Date and Time', 'IQ Test Score', 'Behavioral Interview Test Score', 'Calculation Score', 'Essay Score', 'Pass / Not Pass Status'];
const results = folder('15 Results & Reports', 'Results, the 15-field standard report, exports, the assessment review, essay marking and per-attempt actions. Only this run\'s candidates and attempts are changed.', [
  req('GET IQ Results', 'GET', '/api/admin/results/iq', {
    test: () => {
      const r = body.find((x) => x.id === Number(env('iqAttemptS1')));
      const e = getJSON('iqExpectedS1');
      pm.test('Array; S1 listed with weighted score, LALCO IQ Score and classification', () => {
        pm.expect(body).to.be.an('array');
        pm.expect(r.iq_text).to.equal(`${e.points} / ${e.max}`); pm.expect(r.lalco_iq_score).to.equal(e.lalco); pm.expect(r.iq_classification).to.be.an('object'); pm.expect(r.iq_levels).to.be.an('array');
      });
    },
  }),
  req('GET Standard Report', 'GET', '/api/admin/report/standard', {
    P: { fields: FIELDS },
    test: () => {
      pm.test('Exactly the 15 standard fields, in order', () => pm.expect(body.fields).to.eql(P.fields));
      const row = (id) => body.rows.find((r) => r.candidate_id === Number(env(id)));
      pm.test('One row per candidate, 15 values each', () => body.rows.forEach((r) => pm.expect(r.values.length).to.equal(15)));
      pm.test('S1: IQ Test Score = LALCO IQ Score / 150, PASS', () => { pm.expect(row('iqCandidateS1').values[10]).to.equal(getJSON('iqExpectedS1').lalco + ' / 150'); pm.expect(row('iqCandidateS1').values[14]).to.equal('PASS'); });
      pm.test('S2: NOT PASS', () => pm.expect(row('iqCandidateS2').values[14]).to.equal('NOT PASS'));
      pm.test('Duplicate phone flags are booleans', () => body.rows.forEach((r) => pm.expect(r.duplicate_phone).to.be.a('boolean')));
      set('reportStatuses', Object.fromEntries(body.rows.map((r) => [r.candidate_id, r.values[14]])));
    },
  }),
  req('GET Candidates — report status = Company Eligibility for every candidate', 'GET', '/api/admin/candidates', {
    desc: 'One source of truth: the report\'s Pass / Not Pass Status is the Company Eligibility (every test passed AND the final score reaches the link\'s saved eligibility mark). Read only; checks every candidate, real ones included.',
    test: () => {
      const report = getJSON('reportStatuses');
      const expected = { Eligible: 'PASS', 'Not Eligible': 'NOT PASS', Pending: 'PENDING' };
      const wrong = body.filter((c) => (c.tests || []).length && report[c.id] !== (expected[c.eligibility] || 'PENDING')).map((c) => `${c.id}: report ${report[c.id]} / eligibility ${c.eligibility}`);
      pm.test('Every candidate: PASS = Eligible, NOT PASS = Not Eligible, PENDING = Pending', () => pm.expect(wrong).to.eql([]));
    },
  }),
  req('GET Export All Candidates (standard Excel)', 'GET', '/api/admin/export/candidates.xlsx', { type: 'xlsx', maxMs: 8000 }),
  req('GET Export All Candidates (detailed Excel)', 'GET', '/api/admin/export/candidates.xlsx', { q: { detail: 'full' }, type: 'xlsx', maxMs: 8000 }),
  req('GET Export Candidate PDF — S1', 'GET', '/api/admin/candidates/{{iqCandidateS1}}/export.pdf', { type: 'pdf', maxMs: 5000 }),
  req('GET Export Candidate Word — S1', 'GET', '/api/admin/candidates/{{iqCandidateS1}}/export.docx', { type: 'docx', maxMs: 5000 }),
  req('GET Export Candidate Excel — S1', 'GET', '/api/admin/candidates/{{iqCandidateS1}}/export.xlsx', { type: 'xlsx', maxMs: 5000 }),
  req('GET Export Candidate PDF — S1 detailed', 'GET', '/api/admin/candidates/{{iqCandidateS1}}/export.pdf', { q: { detail: 'full' }, type: 'pdf', maxMs: 5000 }),
  req('GET Export Candidate Word — S1 detailed', 'GET', '/api/admin/candidates/{{iqCandidateS1}}/export.docx', { q: { detail: 'full' }, type: 'docx', maxMs: 5000 }),
  req('GET Export Candidate Excel — S1 detailed', 'GET', '/api/admin/candidates/{{iqCandidateS1}}/export.xlsx', { q: { detail: 'full' }, type: 'xlsx', maxMs: 5000 }),
  req('GET Assessment — review Candidate A', 'GET', '/api/admin/assessments/{{assessmentId}}', {
    test: () => {
      pm.test('Submitted attempt with 2 tests, snapshot of 4 questions', () => { pm.expect(body.assessment.status).to.equal('SUBMITTED'); pm.expect(body.stages.length).to.equal(2); pm.expect(body.questions.length).to.equal(4); });
      pm.test('HR sees correct answers in the snapshot; interview is pending marking', () => { pm.expect(body.questions[0]).to.have.property('correct_answer'); pm.expect(body.tests[1].result).to.equal('Pending'); });
      pm.test('Link and candidate attached', () => { pm.expect(body.link.token).to.equal(env('linkToken')); pm.expect(body.candidate.name).to.equal(env('runTag') + ' A'); });
      const essay = body.questions.find((q) => q.section === env('interviewTypeKey'));
      set('essayMax', String(essay.max_marks));
    },
  }),
  req('PUT Essay Marks — above the maximum', 'PUT', '/api/admin/assessments/{{assessmentId}}/essay-marks', { json: '{ "marks": { "{{essayQuestionA}}": 1000 } }', status: 400, error: 'Essay marks must be between 0 and' }),
  req('PUT Essay Marks — Candidate A', 'PUT', '/api/admin/assessments/{{assessmentId}}/essay-marks', { json: '{ "marks": { "{{essayQuestionA}}": {{essayMax}} } }', test: () => { pm.test('Saved; attempt still submitted', () => pm.expect(body.status).to.equal('SUBMITTED')); } }),
  req('GET Assessment — interview now marked', 'GET', '/api/admin/assessments/{{assessmentId}}', { test: () => { pm.test('Interview test: full marks, Pass', () => { pm.expect(body.tests[1].points).to.equal(Number(env('essayMax'))); pm.expect(body.tests[1].result).to.equal('Pass'); }); } }),
  req('GET Standard Report — Behavioral Interview Test column after HR marking', 'GET', '/api/admin/report/standard', {
    desc: 'Field 12 is the Behavioral Interview Test: the attempt\'s interview-format test (here the temporary interview type, marked full marks by HR). A candidate without such a test shows "—", never another test\'s score.',
    test: () => {
      const row = (name) => body.rows.find((r) => r.values[0] === env('runTag') + ' ' + name);
      pm.test('Field 12 is named "Behavioral Interview Test Score"', () => pm.expect(body.fields[11]).to.equal('Behavioral Interview Test Score'));
      pm.test('Candidate A: 100.0% (the marked interview answer)', () => pm.expect(row('A').values[11]).to.equal('100.0%'));
      pm.test('SB2 (not marked yet): Pending HR marking, never 0', () => pm.expect(row('SB2').values[11]).to.equal('Pending HR marking'));
      pm.test('S1 (IQ only): no behavioural score', () => pm.expect(row('S1').values[11]).to.equal('—'));
    },
  }),
  req('GET Dashboard — Behavioral Interview Test counters', 'GET', '/api/admin/dashboard', {
    test: () => {
      pm.test('Behavioral Interview Test passed / not passed / pending are counted', () => { ['behavioral_passed', 'behavioral_not_passed', 'behavioral_pending'].forEach((k) => pm.expect(body.summary[k], k).to.be.a('number')); });
      pm.test('At least A passed, SB2 and SB3 pending', () => { pm.expect(body.summary.behavioral_passed).to.be.at.least(1); pm.expect(body.summary.behavioral_pending).to.be.at.least(2); });
    },
  }),
  req('GET Export Candidate PDF — A (Behavioral Interview Test)', 'GET', '/api/admin/candidates/{{candidateIdA}}/export.pdf', { type: 'pdf', maxMs: 5000 }),
  req('GET Export Candidate Word — A (Behavioral Interview Test)', 'GET', '/api/admin/candidates/{{candidateIdA}}/export.docx', { type: 'docx', maxMs: 5000 }),
  req('GET Export Candidate Excel — A (Behavioral Interview Test)', 'GET', '/api/admin/candidates/{{candidateIdA}}/export.xlsx', { type: 'xlsx', maxMs: 5000 }),
  req('PUT Essay Marks — attempt not submitted', 'PUT', '/api/admin/assessments/{{attemptB}}/essay-marks', { json: { marks: {} }, status: 400, error: 'after the assessment is submitted' }),
  req('POST Disable Attempt — Candidate B', 'POST', '/api/admin/assessments/{{attemptB}}/disable', { test: () => { pm.test('Disabled', () => { pm.expect(!!body.enabled).to.equal(false); pm.expect(body.state).to.equal('disabled'); }); } }),
  req('GET Exam — Candidate B while disabled', 'GET', '/api/exam/{{linkToken}}', { cand: 'B', test: () => { pm.test('state = disabled', () => pm.expect(body.state).to.equal('disabled')); } }),
  req('PUT Answer — Candidate B while disabled', 'PUT', '/api/exam/{{linkToken}}/answer', { cand: 'B', json: '{ "question_id": {{questionOfB}}, "answer": "A" }', pre: () => { pm.variables.set('questionOfB', getJSON('questionsB')[0].id); }, status: 409 }),
  req('POST Enable Attempt — Candidate B', 'POST', '/api/admin/assessments/{{attemptB}}/enable', { test: () => { pm.test('Enabled, running again', () => { pm.expect(!!body.enabled).to.equal(true); pm.expect(body.state).to.equal('in_progress'); }); } }),
  req('POST Regenerate Attempt — already started', 'POST', '/api/admin/assessments/{{attemptB}}/regenerate', { status: 400, error: 'Only links that have not been started can be regenerated.' }),
  req('POST Regenerate Attempt — nonexistent', 'POST', '/api/admin/assessments/999999999/regenerate', { status: 400, error: 'Assessment not found.' }),
  req('GET Assessment — nonexistent', 'GET', '/api/admin/assessments/999999999', { status: 404 }),
  req('DELETE Attempt — Candidate B', 'DELETE', '/api/admin/assessments/{{attemptB}}', { test: () => { pm.test('ok', () => pm.expect(body.ok).to.equal(true)); } }),
  req('GET Exam — Candidate B after the attempt was deleted', 'GET', '/api/exam/{{linkToken}}', { cand: 'B', test: () => { pm.test('B\'s session has no attempt any more: a fresh start', () => pm.expect(body.state).to.equal('ready')); } }),
  req('DELETE Attempt — already deleted', 'DELETE', '/api/admin/assessments/{{attemptB}}', { status: 404 }),
  req('GET Dashboard — after the exams', 'GET', '/api/admin/dashboard', { test: () => { pm.test('At least 5 more completed assessments (A, S1, S2, S3, C)', () => pm.expect(body.completed_assessments - Number(env('baselineCompleted'))).to.be.at.least(env('skipTimerTests') === 'true' ? 4 : 5)); } }),
]);

// ================================================================================
// 16 Settings
// ================================================================================
const settings = folder('16 Settings', 'Settings are read, then saved with EXACTLY the same values (no change). Invalid values are refused before anything is saved.', [
  req('GET Settings', 'GET', '/api/admin/settings', {
    test: () => {
      pm.test('Defaults are numbers / a language', () => { ['default_time_minutes', 'default_link_expiry_minutes', 'pass_iq', 'pass_general', 'pass_calculation', 'pass_essay', 'final_eligibility'].forEach((k) => pm.expect(body[k], k).to.be.a('number')); pm.expect(['en', 'lo']).to.include(body.default_language); });
      set('settingsBefore', body);
    },
  }),
  req('PUT Settings — same values (no change)', 'PUT', '/api/admin/settings', {
    json: '{{settingsBefore}}',
    test: () => { const before = getJSON('settingsBefore'); pm.test('Saved values are identical', () => Object.keys(before).forEach((k) => pm.expect(body[k], k).to.eql(before[k]))); },
  }),
  req('PUT Settings — invalid exam time', 'PUT', '/api/admin/settings', { json: { default_time_minutes: 0, default_link_expiry_minutes: 60, default_language: 'en' }, status: 400, error: 'Default exam time must be between 1 and 600 minutes.' }),
  req('PUT Settings — invalid language', 'PUT', '/api/admin/settings', { json: { default_time_minutes: 30, default_link_expiry_minutes: 60, default_language: 'xx' }, status: 400, error: 'Please choose a language.' }),
  req('PUT Settings — invalid pass mark', 'PUT', '/api/admin/settings', { json: { default_time_minutes: 30, default_link_expiry_minutes: 60, default_language: 'en', pass_iq: 150 }, status: 400, error: 'IQ pass mark must be between 0 and 100%.' }),
  req('GET Settings — unchanged', 'GET', '/api/admin/settings', { test: () => { const before = getJSON('settingsBefore'); pm.test('Nothing changed', () => Object.keys(before).forEach((k) => pm.expect(body[k], k).to.eql(before[k]))); } }),
]);

// ================================================================================
// 17 Internal Office Staff — not implemented
// ================================================================================
const STAFF_A = { name: '{{runTag}} STAFF A', employee_id: '{{runStamp}}-A', department: 'Postman Department', position: 'Tester', phone: '020 0000 0301', email: 'postman.a@example.com' };
const staffStart = (who, extra = {}) => ({ name: `{{runTag}} STAFF ${who}`, employee_id: `{{runStamp}}-${who}`, department: 'Postman Department', position: 'Tester', ...extra });
const internalStaff = folder('17 Internal Office Staff', 'Internal Office Staff records (existing employees): their own table, never recruitment candidates. The dashboard counts only the internal area.', [
  req('GET Internal Dashboard — before', 'GET', '/api/admin/internal/dashboard', {
    test: () => {
      pm.test('All counters are numbers', () => ['totalStaff', 'totalAssessments', 'activeLinks', 'completed', 'inProgress', 'pending', 'passed', 'notPassed'].forEach((k) => pm.expect(body[k], k).to.be.a('number')));
      pm.test('Recent data and link lists are arrays', () => ['recentAssessments', 'recentResults', 'activeLinksList', 'expiringLinks'].forEach((k) => pm.expect(body[k], k).to.be.an('array')));
      set('internalBaseline', body);
    },
  }),
  req('GET Recruitment Dashboard — before the internal tests', 'GET', '/api/admin/dashboard', { desc: 'Records the recruitment counts; the internal tests must not change them.', test: () => { set('recruitmentCompletedBefore', String(body.completed_assessments)); set('recruitmentTotalBefore', String(body.total_candidates)); } }),
  req('POST Create Staff — missing name', 'POST', '/api/admin/internal/staff', { json: { employee_id: '{{runStamp}}-X' }, status: 400, error: 'Staff name is required.' }),
  req('POST Create Staff — missing employee ID', 'POST', '/api/admin/internal/staff', { json: { name: '{{runTag}} STAFF X' }, status: 400, error: 'Employee ID is required.' }),
  req('POST Create Staff — invalid email', 'POST', '/api/admin/internal/staff', { json: { name: '{{runTag}} STAFF X', employee_id: '{{runStamp}}-X', email: 'not-an-email' }, status: 400, error: 'valid email' }),
  req('POST Create Staff', 'POST', '/api/admin/internal/staff', {
    json: STAFF_A, status: 201,
    test: () => {
      pm.test('Created: id, fields, Active, no assessments', () => { pm.expect(body.id).to.be.a('number'); pm.expect(body.employee_id).to.equal(env('runStamp') + '-A'); pm.expect(body.department).to.equal('Postman Department'); pm.expect(body.status).to.equal('Active'); pm.expect(body.assessments).to.equal(0); });
      set('internalStaffId', String(body.id));
    },
  }),
  req('POST Create Staff — duplicate employee ID (other case)', 'POST', '/api/admin/internal/staff', { json: '{ "name": "{{runTag}} STAFF DUP", "employee_id": " {{runStamp}}-a " }', status: 400, error: 'already used by another staff member' }),
  req('GET Staff — search', 'GET', '/api/admin/internal/staff', {
    q: { q: '{{runStamp}}-A' },
    test: () => { pm.test('Found; departments and positions listed', () => { pm.expect(body.staff.map((s) => s.id)).to.eql([Number(env('internalStaffId'))]); pm.expect(body.departments).to.include('Postman Department'); pm.expect(body.positions).to.be.an('array'); }); },
  }),
  req('GET Staff — filter by department and status', 'GET', '/api/admin/internal/staff', { q: { department: 'Postman Department', status: 'Active' }, test: () => { pm.test('Only that department', () => { pm.expect(body.staff.length).to.be.at.least(1); body.staff.forEach((s) => { pm.expect(s.department).to.equal('Postman Department'); pm.expect(s.status).to.equal('Active'); }); }); } }),
  req('GET Staff Member', 'GET', '/api/admin/internal/staff/{{internalStaffId}}', { test: () => { pm.test('staff + results (none yet)', () => { pm.expect(body.staff.email).to.equal('postman.a@example.com'); pm.expect(body.results).to.eql([]); }); } }),
  req('PUT Update Staff', 'PUT', '/api/admin/internal/staff/{{internalStaffId}}', { json: { ...STAFF_A, position: 'Senior Tester' }, test: () => { pm.test('Position updated', () => pm.expect(body.position).to.equal('Senior Tester')); } }),
  req('GET Staff Member — nonexistent', 'GET', '/api/admin/internal/staff/999999999', { status: 404 }),
  req('PUT Update Staff — nonexistent', 'PUT', '/api/admin/internal/staff/999999999', { json: STAFF_A, status: 404 }),
  req('POST Create Staff — to delete', 'POST', '/api/admin/internal/staff', { json: { name: '{{runTag}} STAFF DELETE ME', employee_id: '{{runStamp}}-DEL' }, status: 201, test: () => { set('internalStaffDeleteId', String(body.id)); } }),
  req('DELETE Staff', 'DELETE', '/api/admin/internal/staff/{{internalStaffDeleteId}}', { desc: 'Deletes a staff record (and, like a recruitment candidate, their attempts). Only this run\'s temporary record.', test: () => { pm.test('ok', () => pm.expect(body.ok).to.equal(true)); } }),
  req('DELETE Staff — already deleted', 'DELETE', '/api/admin/internal/staff/{{internalStaffDeleteId}}', { status: 404 }),
  req('GET Candidates — staff are not candidates', 'GET', '/api/admin/candidates', { q: { q: '{{runStamp}}' }, test: () => { pm.test('No recruitment candidate for the staff member', () => pm.expect(body.length).to.equal(0)); } }),
]);

const INTERNAL_LINK = '{\n  "title": "{{runTag}} STAFF LINK",\n  "description": "Temporary Postman internal assessment",\n  "tests": ["IQ", "{{testTypeKey}}"],\n  "counts": { "IQ": {{internalIqCount}}, "{{testTypeKey}}": 3 },\n  "minutes": { "IQ": 10, "{{testTypeKey}}": 10 },\n  "pass_marks": { "IQ": 0, "{{testTypeKey}}": 0 },\n  "language": "en",\n  "reusable": REUSABLE,\n  "expires_at": "{{internalExpiresAt}}"\n}';
const internalLinks = folder('18 Internal Staff Assessments', 'Internal Staff assessment links: own area (business_area = INTERNAL_STAFF), own URL (/internal-assessment/<token>), description, reusable or single-use, expiry as a date and time. Uses the real IQ bank (read only) and the temporary MCQ type.', [
  req('POST Create Internal Link — missing name', 'POST', '/api/admin/internal/links', { json: '{ "tests": ["{{testTypeKey}}"], "counts": { "{{testTypeKey}}": 1 }, "link_expiry_minutes": 60 }', status: 400, error: 'Please enter the assessment name.' }),
  req('POST Create Internal Link — expiry in the past', 'POST', '/api/admin/internal/links', { json: '{ "title": "{{runTag}} PAST", "tests": ["{{testTypeKey}}"], "counts": { "{{testTypeKey}}": 1 }, "expires_at": "2020-01-01T00:00:00Z" }', status: 400, error: 'must be in the future' }),
  req('POST Create Internal Link', 'POST', '/api/admin/internal/links', {
    status: 201, json: INTERNAL_LINK.replace('REUSABLE', 'true'),
    pre: () => { pm.environment.set('internalExpiresAt', new Date(Date.now() + 2 * 86400000).toISOString()); pm.environment.set('internalIqCount', String(Math.min(3, Number(env('iqCount')) || 1))); },
    test: () => {
      pm.test('Internal area, internal URL, reusable, open', () => { pm.expect(body.business_area).to.equal('INTERNAL_STAFF'); pm.expect(body.url_path).to.equal('/internal-assessment/' + body.token); pm.expect(body.reusable).to.equal(1); pm.expect(body.share_state).to.equal('open'); });
      pm.test('Name, description, expiry date/time', () => { pm.expect(body.title).to.equal(env('runTag') + ' STAFF LINK'); pm.expect(body.description).to.equal('Temporary Postman internal assessment'); pm.expect(body.link_expires_at).to.equal(env('internalExpiresAt')); });
      pm.test('Tests in order: IQ, then the MCQ test', () => pm.expect(body.stages.map((s) => [s.section, s.question_count])).to.eql([['IQ', Number(env('internalIqCount'))], [env('testTypeKey'), 3]]));
      set('internalLinkId', String(body.id)); set('internalLinkToken', body.token);
    },
  }),
  req('POST Create Internal Link — single use', 'POST', '/api/admin/internal/links', {
    status: 201, json: INTERNAL_LINK.replace('REUSABLE', 'false').replace('STAFF LINK', 'STAFF SINGLE LINK'),
    test: () => { pm.test('reusable = 0', () => pm.expect(body.reusable).to.equal(0)); set('internalSingleLinkId', String(body.id)); set('internalSingleLinkToken', body.token); },
  }),
  req('GET Internal Links', 'GET', '/api/admin/internal/links', {
    test: () => {
      pm.test('Only internal links; ours included with 0 started', () => {
        body.forEach((l) => pm.expect(l.business_area).to.equal('INTERNAL_STAFF'));
        const mine = body.find((l) => l.id === Number(env('internalLinkId')));
        pm.expect(mine.candidates).to.equal(0); pm.expect(mine.url_path).to.match(/^\/internal-assessment\//);
      });
      pm.test('No recruitment link in the list', () => pm.expect(body.map((l) => l.id)).to.not.include(Number(env('linkId'))));
    },
  }),
  req('GET Internal Link', 'GET', '/api/admin/internal/links/{{internalLinkId}}', { test: () => { pm.test('link + results (none yet)', () => { pm.expect(body.link.id).to.equal(Number(env('internalLinkId'))); pm.expect(body.results).to.eql([]); }); } }),
  req('GET Internal Link — nonexistent', 'GET', '/api/admin/internal/links/999999999', { status: 404 }),
  req('GET Internal Link — a recruitment link id', 'GET', '/api/admin/internal/links/{{linkId}}', { status: 404, desc: 'Isolation: the internal API never shows a recruitment link.' }),
  req('GET Recruitment Link — an internal link id', 'GET', '/api/admin/links/{{internalLinkId}}', { status: 404, desc: 'Isolation: the recruitment API never shows an internal link.' }),
  req('POST Disable Recruitment Link — an internal link id', 'POST', '/api/admin/links/{{internalLinkId}}/disable', { status: 404 }),
  req('POST Disable Internal Link', 'POST', '/api/admin/internal/links/{{internalSingleLinkId}}/disable', { test: () => { pm.test('Disabled', () => { pm.expect(!!body.enabled).to.equal(false); pm.expect(body.share_state).to.equal('disabled'); }); } }),
  req('GET Internal Exam — disabled link', 'GET', '/api/internal-exam/{{internalSingleLinkToken}}', { staff: 'X', test: () => { pm.test('state = disabled', () => pm.expect(body.state).to.equal('disabled')); } }),
  req('POST Enable Internal Link', 'POST', '/api/admin/internal/links/{{internalSingleLinkId}}/enable', { test: () => { pm.test('Open', () => pm.expect(body.share_state).to.equal('open')); } }),
  req('POST Regenerate Internal Link — unused', 'POST', '/api/admin/internal/links/{{internalSingleLinkId}}/regenerate', {
    test: () => {
      pm.test('New token', () => pm.expect(body.token).to.not.equal(env('internalSingleLinkToken')));
      pm.test('The expiry date HR chose is kept (not recalculated)', () => pm.expect(Date.parse(body.link_expires_at)).to.equal(Date.parse(env('internalExpiresAt'))));
      set('oldInternalToken', env('internalSingleLinkToken')); set('internalSingleLinkToken', body.token);
    },
  }),
  req('GET Internal Exam — old token after regenerate', 'GET', '/api/internal-exam/{{oldInternalToken}}', { noAuth: true, status: 404 }),
  req('POST Regenerate Internal Link — nonexistent', 'POST', '/api/admin/internal/links/999999999/regenerate', { status: 404 }),
  req('POST Create Internal Link — spare (to delete)', 'POST', '/api/admin/internal/links', { status: 201, json: '{ "title": "{{runTag}} STAFF SPARE", "tests": ["{{testTypeKey}}"], "counts": { "{{testTypeKey}}": 1 }, "link_expiry_minutes": 60 }', test: () => { set('internalSpareLinkId', String(body.id)); } }),
  req('POST Regenerate Internal Link — a relative expiry starts again', 'POST', '/api/admin/internal/links/{{internalSpareLinkId}}/regenerate', {
    test: () => { pm.test('Expires 60 minutes from now', () => pm.expect(Date.parse(body.link_expires_at) - Date.now()).to.be.within(55 * 60000, 61 * 60000)); },
  }),
  req('DELETE Internal Link — unused', 'DELETE', '/api/admin/internal/links/{{internalSpareLinkId}}', { test: () => { pm.test('ok', () => pm.expect(body.ok).to.equal(true)); } }),
  req('DELETE Internal Link — already deleted', 'DELETE', '/api/admin/internal/links/{{internalSpareLinkId}}', { status: 404 }),
]);

const snapshotAnswers = () => {
  // The running test's questions of this attempt (its own snapshot): answer every one correctly.
  const running = body.stages.find((s) => s.status === 'IN_PROGRESS');
  const answers = {};
  body.questions.filter((q) => q.section === running.section).forEach((q) => { answers[q.id] = q.correct_answer; });
  pm.test('Snapshot of the running test found', () => pm.expect(Object.keys(answers).length).to.be.above(0));
  set(P.var, answers);
};
const internalExam = folder('19 Internal Staff Exam', 'The public internal staff API (/api/internal-exam/<token>): the same engine as recruitment with its own links, cookie (lalco_staff_session) and records. Staff A and B share one reusable link; C uses the single-use link.', [
  req('GET Internal Exam — invalid token', 'GET', '/api/internal-exam/postman-invalid-token', { noAuth: true, status: 404 }),
  req('GET Internal Exam — a recruitment token', 'GET', '/api/internal-exam/{{linkToken}}', { noAuth: true, status: 404, desc: 'A recruitment link never opens through the internal API.' }),
  req('GET Recruitment Exam — an internal token', 'GET', '/api/exam/{{internalLinkToken}}', { noAuth: true, status: 404, desc: 'An internal link never opens through the recruitment API.' }),
  req('GET Internal Exam — Staff A opens the link', 'GET', '/api/internal-exam/{{internalLinkToken}}', {
    staff: 'A', pre: () => { pm.environment.set('internalStaffSession', ''); },
    test: () => {
      pm.test('ready, internal area, 2 tests', () => { pm.expect(body.state).to.equal('ready'); pm.expect(body.business_area).to.equal('INTERNAL_STAFF'); pm.expect(body.tests.length).to.equal(2); });
      const c = pm.response.headers.all().find((h) => h.key.toLowerCase() === 'set-cookie');
      pm.test('Own staff session cookie, scoped to /api/internal-exam/<token>', () => { pm.expect(c.value).to.match(/^lalco_staff_session=/); pm.expect(c.value).to.match(/HttpOnly/i); pm.expect(c.value).to.include('Path=/api/internal-exam/' + env('internalLinkToken')); });
    },
  }),
  req('POST Start — missing employee ID', 'POST', '/api/internal-exam/{{internalLinkToken}}/start', { staff: 'A', json: { name: 'x' }, status: 400, error: 'employee_id_required' }),
  req('POST Start — missing name', 'POST', '/api/internal-exam/{{internalLinkToken}}/start', { staff: 'A', json: { employee_id: 'x' }, status: 400, error: 'name_required' }),
  req('POST Start — Staff A', 'POST', '/api/internal-exam/{{internalLinkToken}}/start', {
    staff: 'A', json: '{ "name": "{{runTag}} STAFF A (typed)", "employee_id": "{{runStamp}}-a", "department": "typed", "phone": "020 0000 0302" }',
    desc: 'Staff A enters the Employee ID HR created (other case): the attempt joins that staff record and HR\'s details are kept.',
    test: () => {
      pm.test('IQ running, own questions, no answers sent', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.section).to.equal('IQ'); pm.expect(body.questions.length).to.equal(Number(env('internalIqCount'))); body.questions.forEach((q) => pm.expect(q).to.not.have.any.keys('correct_answer', 'max_marks')); });
      set('internalQuestionsA', body.questions.map((q) => q.id));
    },
  }),
  req('GET Internal Exam — Staff A refreshes', 'GET', '/api/internal-exam/{{internalLinkToken}}', { staff: 'A', test: () => { pm.test('Same questions, same order', () => pm.expect(body.questions.map((q) => q.id)).to.eql(getJSON('internalQuestionsA'))); } }),
  req('GET Internal Exam — Staff B opens the same link', 'GET', '/api/internal-exam/{{internalLinkToken}}', { staff: 'B', pre: () => { pm.environment.set('internalStaffSessionB', ''); }, test: () => { pm.test('B starts fresh', () => { pm.expect(body.state).to.equal('ready'); pm.expect(env('internalStaffSessionB')).to.not.equal(env('internalStaffSession')); }); } }),
  req('POST Start — Staff B (new employee)', 'POST', '/api/internal-exam/{{internalLinkToken}}/start', {
    staff: 'B', json: staffStart('B'),
    test: () => { pm.test('B has own snapshot', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.questions.map((q) => q.id).filter((id) => getJSON('internalQuestionsA').includes(id))).to.eql([]); }); set('internalQuestionsB', body.questions.map((q) => q.id)); },
  }),
  req('PUT Answer — Staff A tries to answer B\'s question', 'PUT', '/api/internal-exam/{{internalLinkToken}}/answer', { staff: 'A', json: '{ "question_id": {{questionOfStaffB}}, "answer": "A" }', pre: () => { pm.variables.set('questionOfStaffB', getJSON('internalQuestionsB')[0]); }, status: 400, error: 'unknown_question' }),
  req('POST Focus Lost — Staff A', 'POST', '/api/internal-exam/{{internalLinkToken}}/focus-lost', { staff: 'A', test: () => { pm.test('ok', () => pm.expect(body.ok).to.equal(true)); } }),
  req('GET Internal Link — find the attempts', 'GET', '/api/admin/internal/links/{{internalLinkId}}', {
    test: () => {
      const a = body.results.find((r) => r.staff && r.staff.employee_id === env('runStamp') + '-A');
      const b = body.results.find((r) => r.staff && r.staff.employee_id === env('runStamp') + '-B');
      pm.test('A joined HR\'s record (HR name kept), B got a new staff record', () => { pm.expect(a.staff.id).to.equal(Number(env('internalStaffId'))); pm.expect(a.staff.name).to.equal(env('runTag') + ' STAFF A'); pm.expect(b.staff.id).to.not.equal(a.staff.id); });
      set('internalAssessmentId', String(a.id)); set('internalResultB', String(b.id));
    },
  }),
  req('GET Internal Result — Staff A snapshot (IQ answers)', 'GET', '/api/admin/internal/results/{{internalAssessmentId}}', { P: { var: 'internalAnswersA1' }, test: [snapshotAnswers] }),
  req('POST Submit — Staff A, IQ', 'POST', '/api/internal-exam/{{internalLinkToken}}/submit', {
    staff: 'A', json: '{ "answers": {{internalAnswersA1}} }',
    test: () => { pm.test('All correct -> LALCO IQ 150; next test waiting; no IQ % for the employee', () => { pm.expect(body.state).to.equal('next_test'); pm.expect(body.last_result.lalco_iq_score).to.equal(150); pm.expect(body.last_result).to.not.have.property('percent'); }); },
  }),
  req('POST Continue — Staff A', 'POST', '/api/internal-exam/{{internalLinkToken}}/continue', { staff: 'A', test: () => { pm.test('Second test running', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.section).to.equal(env('testTypeKey')); pm.expect(body.questions.length).to.equal(3); }); } }),
  req('GET Internal Result — Staff A snapshot (second test)', 'GET', '/api/admin/internal/results/{{internalAssessmentId}}', { P: { var: 'internalAnswersA2' }, test: [snapshotAnswers] }),
  req('POST Submit — Staff A, second test', 'POST', '/api/internal-exam/{{internalLinkToken}}/submit', { staff: 'A', json: '{ "answers": {{internalAnswersA2}} }', pre: () => { pm.environment.set('staffSessionUsedByA', pm.environment.get('internalStaffSession')); }, test: () => { pm.test('Submitted, Pass', () => { pm.expect(body.state).to.equal('submitted'); pm.expect(body.last_result.result).to.equal('Pass'); }); } }),
  req('POST Submit — Staff A again', 'POST', '/api/internal-exam/{{internalLinkToken}}/submit', { staff: 'A', json: { answers: {} }, status: 409 }),
  req('GET Internal Exam Image — after submitting (not served)', 'GET', '/api/internal-exam/{{internalLinkToken}}/images/{{imageId}}', { staff: 'A', status: 404, desc: 'Pictures are only served to an employee while the test that contains them is running.' }),
  // The SAME browser (Staff A's cookie variable) is then used by Staff E, then Staff G.
  req('GET Internal Exam — the same browser after Staff A finished', 'GET', '/api/internal-exam/{{internalLinkToken}}', {
    staff: 'A',
    test: () => { pm.test('Start form, nothing of Staff A', () => { pm.expect(body.state).to.equal('ready'); pm.expect(body).to.not.have.property('staff'); pm.expect(body).to.not.have.property('questions'); }); },
  }),
  req('POST Start — Staff E on the same browser', 'POST', '/api/internal-exam/{{internalLinkToken}}/start', {
    staff: 'A', json: staffStart('E'), pre: () => { pm.environment.set('staffSessionUsedByE', pm.environment.get('internalStaffSession')); },
    test: () => { pm.test('A new attempt for Staff E', () => { pm.expect(body.state).to.equal('in_progress'); pm.expect(body.section).to.equal('IQ'); }); },
  }),
  req('POST Start — Staff F tries to take over E (active)', 'POST', '/api/internal-exam/{{internalLinkToken}}/start', {
    staff: 'A', json: staffStart('F'), status: 409, error: 'assessment_in_progress',
    test: () => { pm.test('Only the error, nothing of Staff E', () => pm.expect(Object.keys(body)).to.eql(['error'])); },
  }),
  req('GET Internal Link — find Staff E', 'GET', '/api/admin/internal/links/{{internalLinkId}}', {
    test: () => {
      const e = body.results.find((r) => r.staff && r.staff.employee_id === env('runStamp') + '-E');
      pm.test('E has an own attempt and staff record; F was never recorded', () => {
        pm.expect(e).to.exist; pm.expect(e.id).to.not.equal(Number(env('internalAssessmentId'))); pm.expect(e.staff.id).to.not.equal(Number(env('internalStaffId')));
        pm.expect(body.results.some((r) => r.staff && r.staff.employee_id === env('runStamp') + '-F')).to.equal(false);
      });
      set('internalResultE', String(e.id));
    },
  }),
  req('GET Internal Result — Staff E snapshot (IQ answers)', 'GET', '/api/admin/internal/results/{{internalResultE}}', { P: { var: 'internalAnswersE1' }, test: [snapshotAnswers] }),
  req('POST Submit — Staff E, IQ', 'POST', '/api/internal-exam/{{internalLinkToken}}/submit', { staff: 'A', json: '{ "answers": {{internalAnswersE1}} }', test: () => { pm.test('Next test waiting', () => pm.expect(body.state).to.equal('next_test')); } }),
  req('POST Continue — Staff E', 'POST', '/api/internal-exam/{{internalLinkToken}}/continue', { staff: 'A', test: () => { pm.test('Second test running', () => pm.expect(body.state).to.equal('in_progress')); } }),
  req('GET Internal Result — Staff E snapshot (second test)', 'GET', '/api/admin/internal/results/{{internalResultE}}', { P: { var: 'internalAnswersE2' }, test: [snapshotAnswers] }),
  req('POST Submit — Staff E, second test', 'POST', '/api/internal-exam/{{internalLinkToken}}/submit', {
    staff: 'A', json: '{ "answers": {{internalAnswersE2}} }',
    test: () => { pm.test('Submitted, Pass; session released', () => { pm.expect(body.state).to.equal('submitted'); pm.expect(body.last_result.result).to.equal('Pass'); pm.expect(env('internalStaffSession')).to.not.equal(env('staffSessionUsedByE')); }); },
  }),
  req('POST Start — Staff G on the same browser', 'POST', '/api/internal-exam/{{internalLinkToken}}/start', {
    staff: 'A', json: staffStart('G'), pre: () => { pm.environment.set('staffSessionUsedByG', pm.environment.get('internalStaffSession')); },
    test: () => {
      pm.test('A third attempt starts', () => pm.expect(body.state).to.equal('in_progress'));
      pm.test('Three different sessions on one browser', () => pm.expect(new Set([env('staffSessionUsedByA'), env('staffSessionUsedByE'), env('staffSessionUsedByG')]).size).to.equal(3));
    },
  }),
  req('GET Internal Exam — Staff C opens the single-use link', 'GET', '/api/internal-exam/{{internalSingleLinkToken}}', { staff: 'C', pre: () => { pm.environment.set('internalStaffSessionC', ''); }, test: () => { pm.test('ready', () => pm.expect(body.state).to.equal('ready')); } }),
  req('POST Start — Staff C', 'POST', '/api/internal-exam/{{internalSingleLinkToken}}/start', { staff: 'C', json: staffStart('C'), test: () => { pm.test('in_progress', () => pm.expect(body.state).to.equal('in_progress')); } }),
  req('GET Internal Exam — Staff D on the used single-use link', 'GET', '/api/internal-exam/{{internalSingleLinkToken}}', { staff: 'D', pre: () => { pm.environment.set('internalStaffSessionD', ''); }, test: () => { pm.test('state = used', () => pm.expect(body.state).to.equal('used')); } }),
  req('POST Start — Staff D refused', 'POST', '/api/internal-exam/{{internalSingleLinkToken}}/start', { staff: 'D', json: staffStart('D'), status: 409, test: () => { pm.test('Refused: used', () => pm.expect(body.state).to.equal('used')); } }),
  req('GET Internal Exam — a candidate session is a stranger here', 'GET', '/api/internal-exam/{{internalLinkToken}}', {
    cookie: 'lalco_staff_session={{candidateSessionA}}; lalco_candidate_session={{candidateSessionA}}',
    desc: 'Candidate A\'s secret (recruitment) sent to the internal link: it opens nothing.',
    test: () => { pm.test('New visitor, no data', () => { pm.expect(body.state).to.equal('ready'); pm.expect(body).to.not.have.property('questions'); }); },
  }),
  req('GET Recruitment Exam — a staff session is a stranger there', 'GET', '/api/exam/{{iqLinkToken}}', {
    cookie: 'lalco_candidate_session={{internalStaffSession}}; lalco_staff_session={{internalStaffSession}}',
    desc: 'Staff A\'s secret sent to a recruitment link: it opens nothing.',
    test: () => { pm.test('New visitor, no data', () => { pm.expect(body.state).to.equal('ready'); pm.expect(body).to.not.have.property('questions'); }); },
  }),
  req('GET Internal Staff Page — public HTML', 'GET', '/internal-assessment/{{internalLinkToken}}', {
    noAuth: true, type: 'any', desc: 'The internal staff page (/internal-assessment/<token>) is served.',
    test: () => { pm.test('HTML page', () => { pm.expect(pm.response.code).to.equal(200); pm.expect(pm.response.headers.get('Content-Type')).to.include('text/html'); pm.expect(pm.response.text()).to.include('/static/exam.js'); }); },
  }),
]);

const internalResults = folder('20 Internal Staff Results', 'Results, detail, reports, exports and dashboard of the internal area only. Checks that recruitment data and screens are not affected.', [
  req('GET Internal Results', 'GET', '/api/admin/internal/results', {
    P: { fields: ['Staff Name', 'Employee ID', 'Department', 'Position', 'Assessment', 'IQ Test Score', 'Behavioral Interview Test Score', 'Calculation Score', 'Essay Score', 'Pass / Not Pass Status', 'Date and Time'] },
    test: () => {
      pm.test('The 11 result fields', () => pm.expect(body.fields).to.eql(P.fields));
      const a = body.results.find((r) => r.id === Number(env('internalAssessmentId')));
      pm.test('Staff A: HR record, assessment, IQ 150 / 150, PASS', () => pm.expect([a.values[0], a.values[1], a.values[2], a.values[3], a.values[4], a.values[5], a.values[9]]).to.eql(
        [env('runTag') + ' STAFF A', env('runStamp') + '-A', 'Postman Department', 'Senior Tester', env('runTag') + ' STAFF LINK', '150 / 150', 'PASS']));
      pm.test('Staff B: IN PROGRESS', () => pm.expect(body.results.find((r) => r.id === Number(env('internalResultB'))).values[9]).to.equal('IN PROGRESS'));
    },
  }),
  req('GET Internal Results — filter PASS in the department', 'GET', '/api/admin/internal/results', { q: { status: 'Pass', department: 'Postman Department' }, test: () => { pm.test('Only passed results of that department', () => { pm.expect(body.results.map((r) => r.id)).to.include(Number(env('internalAssessmentId'))); body.results.forEach((r) => { pm.expect(r.values[9]).to.equal('PASS'); pm.expect(r.values[2]).to.equal('Postman Department'); }); }); } }),
  req('GET Internal Result — detail', 'GET', '/api/admin/internal/results/{{internalAssessmentId}}', {
    test: () => {
      pm.test('Staff, entered details, 2 tests, snapshot', () => { pm.expect(body.staff.id).to.equal(Number(env('internalStaffId'))); pm.expect(body.entered_details.name).to.equal(env('runTag') + ' STAFF A (typed)'); pm.expect(body.tests.length).to.equal(2); pm.expect(body.questions.length).to.equal(Number(env('internalIqCount')) + 3); });
      pm.test('Same scoring engine: LALCO 150, question count = snapshot, no mismatch', () => { pm.expect(body.tests[0].lalco_iq_score).to.equal(150); pm.expect(body.tests[0].questions_assigned).to.equal(body.tests[0].question_count); pm.expect(body.tests[0].review_required).to.equal(null); });
    },
  }),
  req('GET Internal Result — a recruitment attempt', 'GET', '/api/admin/internal/results/{{assessmentId}}', { status: 404, desc: 'Isolation: a recruitment candidate\'s attempt is not an internal result.' }),
  req('GET Recruitment Assessment — an internal result', 'GET', '/api/admin/assessments/{{internalAssessmentId}}', { status: 404, desc: 'Isolation: the recruitment review cannot open an internal staff result.' }),
  req('PUT Essay Marks (recruitment route) — an internal result', 'PUT', '/api/admin/assessments/{{internalAssessmentId}}/essay-marks', { json: { marks: {} }, status: 404 }),
  req('PUT Essay Marks (internal) — attempt not submitted', 'PUT', '/api/admin/internal/results/{{internalResultB}}/essay-marks', { json: { marks: {} }, status: 400, error: 'after the assessment is submitted' }),
  req('GET Export Internal Result PDF', 'GET', '/api/admin/internal/results/{{internalAssessmentId}}/export.pdf', { type: 'pdf', maxMs: 5000 }),
  req('GET Export Internal Result Word', 'GET', '/api/admin/internal/results/{{internalAssessmentId}}/export.docx', { type: 'docx', maxMs: 5000 }),
  req('GET Export Internal Result Excel', 'GET', '/api/admin/internal/results/{{internalAssessmentId}}/export.xlsx', { type: 'xlsx', maxMs: 5000 }),
  req('GET Export Internal Result — unknown format', 'GET', '/api/admin/internal/results/{{internalAssessmentId}}/export.txt', { status: 404 }),
  req('GET Export Internal Staff Report (Excel)', 'GET', '/api/admin/internal/export/results.xlsx', { type: 'xlsx', maxMs: 8000, test: () => { set('internalExportSize', String(pm.response.stream.length)); } }),
  req('GET Internal Results — search q (Employee ID)', 'GET', '/api/admin/internal/results', {
    q: { q: '{{runStamp}}-E' },
    test: () => { pm.test('Only Staff E', () => { pm.expect(body.results.length).to.equal(1); pm.expect(body.results[0].staff.employee_id).to.equal(env('runStamp') + '-E'); }); },
  }),
  req('GET Export Internal Staff Report — search q (Employee ID)', 'GET', '/api/admin/internal/export/results.xlsx', {
    q: { q: '{{runStamp}}-E' }, type: 'xlsx', maxMs: 8000,
    desc: 'The Excel export uses the same search as the results table. The workbook is compressed, so its content is checked by size: one row is smaller than all rows (content is checked cell by cell in the unit tests).',
    test: () => { pm.test('Smaller than the unfiltered export (filtered rows only)', () => pm.expect(pm.response.stream.length).to.be.below(Number(env('internalExportSize')))); set('internalExportOneSize', String(pm.response.stream.length)); },
  }),
  req('GET Export Internal Staff Report — search q (no match)', 'GET', '/api/admin/internal/export/results.xlsx', {
    q: { q: '{{runTag}} NO SUCH STAFF' }, type: 'xlsx', maxMs: 8000,
    test: () => { pm.test('Header only: smaller than the one-row export', () => pm.expect(pm.response.stream.length).to.be.below(Number(env('internalExportOneSize')))); },
  }),
  req('GET Staff Member — with the result', 'GET', '/api/admin/internal/staff/{{internalStaffId}}', { test: () => { pm.test('1 result, completed, PASS', () => { pm.expect(body.results.length).to.equal(1); pm.expect(body.staff.completed).to.equal(1); pm.expect(body.staff.last_result).to.equal('Pass'); }); } }),
  req('GET Internal Dashboard — after', 'GET', '/api/admin/internal/dashboard', {
    desc: 'After this run: 5 more staff (A was created by HR; B, C, E and G by starting — D and F were refused), 5 more assessments (A and E completed, B, C and G in progress), 2 more PASS, 1 more active link.',
    test: () => {
      const b = getJSON('internalBaseline');
      pm.test('Counters moved as expected', () => {
        pm.expect(body.totalStaff - b.totalStaff).to.equal(5);
        pm.expect(body.totalAssessments - b.totalAssessments).to.equal(5);
        pm.expect(body.completed - b.completed).to.equal(2);
        pm.expect(body.inProgress - b.inProgress).to.equal(3);
        pm.expect(body.passed - b.passed).to.equal(2);
        pm.expect(body.activeLinks - b.activeLinks).to.equal(1);
      });
      pm.test('Recent results include Staff A', () => pm.expect(body.recentResults.map((r) => r.id)).to.include(Number(env('internalAssessmentId'))));
      pm.test('The new link is in the expiring-within-7-days list', () => pm.expect(body.expiringLinks.map((l) => l.id)).to.include(Number(env('internalLinkId'))));
    },
  }),
  req('GET Recruitment Dashboard — unchanged by the internal tests', 'GET', '/api/admin/dashboard', { test: () => { pm.test('Recruitment completed assessments and candidates unchanged', () => { pm.expect(body.completed_assessments).to.equal(Number(env('recruitmentCompletedBefore'))); pm.expect(body.total_candidates).to.equal(Number(env('recruitmentTotalBefore'))); }); } }),
  req('GET Standard Report — no staff in the recruitment report', 'GET', '/api/admin/report/standard', { test: () => { pm.test('No internal staff row', () => pm.expect(body.rows.filter((r) => r.values[0].includes(' STAFF ')).length).to.equal(0)); } }),
  req('GET IQ Results — recruitment only', 'GET', '/api/admin/results/iq', { test: () => { pm.test('The internal IQ result is not listed', () => pm.expect(body.map((r) => r.id)).to.not.include(Number(env('internalAssessmentId')))); } }),
]);

// ================================================================================
// 21 Security / Negative Tests
// ================================================================================
const unauth = (name, method, p, extra = {}) => req(`${name} — no session`, method, p, { noAuth: true, status: 401, error: 'Please log in.', ...extra });
const security = folder('21 Security / Negative Tests', 'Admin endpoints without a session, with a bad session and with a candidate cookie; malformed input; invalid ids; unknown routes. Every response is checked for stack traces (collection-level test).', [
  unauth('GET Dashboard', 'GET', '/api/admin/dashboard'),
  unauth('GET Candidates', 'GET', '/api/admin/candidates'),
  unauth('GET Export Candidate PDF', 'GET', '/api/admin/candidates/{{iqCandidateS1}}/export.pdf'),
  unauth('GET Export All Candidates', 'GET', '/api/admin/export/candidates.xlsx'),
  unauth('GET Standard Report', 'GET', '/api/admin/report/standard'),
  unauth('GET Export Questions', 'GET', '/api/admin/questions/export.xlsx?section=IQ'),
  unauth('PUT Settings', 'PUT', '/api/admin/settings', { json: { default_time_minutes: 1, default_link_expiry_minutes: 1, default_language: 'en' } }),
  unauth('POST Create Question', 'POST', '/api/admin/questions', { json: { section: 'GENERAL', question_text: 'x', option_a: 'a', option_b: 'b', correct_answer: 'A' } }),
  unauth('POST Import Preview', 'POST', '/api/admin/questions/import/preview', { form: [{ key: 'section', value: 'GENERAL' }, file('mcq-inline-answers.txt')] }),
  unauth('POST Create Test Type', 'POST', '/api/admin/test-types', { json: { name: 'x', behavior: 'mcq' } }),
  unauth('POST Delete All Questions', 'POST', '/api/admin/questions/delete-all', { json: { section: 'POSTMAN_NOT_A_TEST_AREA' } }),
  unauth('DELETE Candidate', 'DELETE', '/api/admin/candidates/999999999'),
  unauth('GET Link', 'GET', '/api/admin/links/{{iqLinkId}}'),
  unauth('PUT Essay Marks', 'PUT', '/api/admin/assessments/{{assessmentId}}/essay-marks', { json: { marks: {} } }),
  unauth('GET Internal Dashboard', 'GET', '/api/admin/internal/dashboard'),
  unauth('GET Internal Staff', 'GET', '/api/admin/internal/staff'),
  unauth('POST Create Staff', 'POST', '/api/admin/internal/staff', { json: { name: 'x', employee_id: 'y' } }),
  unauth('GET Internal Links', 'GET', '/api/admin/internal/links'),
  unauth('POST Create Internal Link', 'POST', '/api/admin/internal/links', { json: { title: 'x' } }),
  unauth('GET Internal Results', 'GET', '/api/admin/internal/results'),
  unauth('GET Export Internal Staff Report', 'GET', '/api/admin/internal/export/results.xlsx'),
  req('GET Internal Staff — a staff session cannot use the admin API', 'GET', '/api/admin/internal/staff', { staff: 'A', status: 401, error: 'Please log in.' }),
  req('GET Internal Staff — a candidate session cannot use the admin API', 'GET', '/api/admin/internal/staff', { cand: 'S1', status: 401, error: 'Please log in.' }),
  req('GET Candidates — forged session token', 'GET', '/api/admin/candidates', { cookie: 'hr_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.forged', status: 401, error: 'Your session has ended' }),
  req('GET Candidates — candidate cookie cannot use the admin API', 'GET', '/api/admin/candidates', { cand: 'S1', status: 401, error: 'Please log in.' }),
  req('POST Create Candidate — malformed JSON', 'POST', '/api/admin/candidates', { json: '{ "name": "broken", ', status: 400, error: 'Invalid request.' }),
  req('GET Unknown API route', 'GET', '/api/admin/no-such-endpoint', { status: 404, error: 'Not found.' }),
  req('GET Unknown public API route', 'GET', '/api/no-such-endpoint', { noAuth: true, status: 404, error: 'Not found.' }),
  req('DELETE Question — malformed id', 'DELETE', '/api/admin/questions/abc', { status: 404 }),
  req('GET Link — malformed id', 'GET', '/api/admin/links/abc', { status: 404 }),
  req('PUT Test Type — unknown key', 'PUT', '/api/admin/test-types/POSTMAN_NO_SUCH_TYPE', { json: { name: 'x' }, status: 404 }),
  req('GET Exam — invalid candidate cookie is ignored', 'GET', '/api/exam/{{iqLinkToken}}', { cookie: 'lalco_candidate_session=../../etc/passwd', test: () => { pm.test('Treated as a new visitor', () => pm.expect(body.state).to.equal('ready')); } }),
]);

// ================================================================================
// 99 Cleanup
// ================================================================================
// Each sweep: pick the temporary records (`mine` = [{ url, label }]), delete them, and
// report once every delete has answered.
const deleteAll = () => {
  let left = mine.length;
  let ok = 0;
  const finish = () => pm.test(`Deleted ${ok} of ${mine.length} temporary ${P.what}`, () => pm.expect(ok).to.equal(mine.length));
  if (!left) finish();
  mine.forEach((m) => pm.sendRequest({ url: env('baseUrl') + m.url, method: 'DELETE' }, (e, r) => {
    if (!e && r.code === 200 && (P.what !== 'categories' || r.json().deleted)) ok++; else console.log('Not deleted:', m.label, e || r.text());
    if (--left === 0) finish();
  }));
};
const sweep = (name, listPath, what, pick, desc) => req(name, 'GET', listPath, { desc, maxMs: 30000, P: { what }, test: [pick, deleteAll] });

// ================================================================================
// 23 HR Users (view-only HR logins)
// ================================================================================
const keepHrViewerCookie = () => {
  const c = pm.response.headers.all().find((h) => h.key.toLowerCase() === 'set-cookie' && h.value.startsWith('hr_session='));
  if (c) pm.environment.set('hrViewerSession', c.value.split(';')[0].slice('hr_session='.length));
};
const HRV = 'hr_session={{hrViewerSession}}';
const hrUsersFolder = folder('23 HR Users (view only)', 'A View only HR user logs in on the normal HR login, can read every candidate, exam, result, report and export, and every change is refused by the server (403). This folder creates a temporary "postman-test-…" view-only user, checks reads and refused writes with its own session (cookie jar off), then deletes it.', [
  req('POST Add HR User — password too short', 'POST', '/api/admin/users', { json: '{ "username": "postman-test-hr-{{runStamp}}", "password": "short", "role": "viewer" }', status: 400, error: 'at least 8 characters' }),
  req('POST Add HR User — view only', 'POST', '/api/admin/users', {
    json: '{ "username": "postman-test-hr-{{runStamp}}", "password": "postman-hr-viewer-1", "role": "viewer" }', status: 201,
    test: () => { pm.test('View only, active, no password returned', () => { pm.expect(body.role).to.equal('viewer'); pm.expect(body.active).to.equal(true); pm.expect(JSON.stringify(body)).to.not.include('postman-hr-viewer-1'); }); set('hrViewerId', String(body.id)); },
  }),
  req('GET HR Users', 'GET', '/api/admin/users', { test: () => { pm.test('Ours listed, no hashes', () => { pm.expect(body.map((u) => u.id)).to.include(Number(env('hrViewerId'))); pm.expect(JSON.stringify(body)).to.not.match(/\$2[aby]\$/); }); } }),
  req('POST Admin Login — the view-only user', 'POST', '/api/admin/auth/login', {
    noAuth: true, json: '{ "username": "postman-test-hr-{{runStamp}}", "password": "postman-hr-viewer-1" }',
    test: [keepHrViewerCookie, () => { pm.test('Role viewer', () => pm.expect(body.role).to.equal('viewer')); }],
  }),
  req('GET Candidates — as the view-only user', 'GET', '/api/admin/candidates', { cookie: HRV, test: () => { pm.test('Can read every candidate', () => pm.expect(body).to.be.an('array')); } }),
  req('GET Assessment Review — as the view-only user', 'GET', '/api/admin/assessments/{{assessmentId}}', { cookie: HRV, test: () => { pm.test('Exam details: questions with the candidate\'s answers', () => pm.expect(body.questions.length).to.be.above(0)); } }),
  req('GET Export All Candidates — as the view-only user', 'GET', '/api/admin/export/candidates.xlsx', { cookie: HRV, type: 'xlsx', maxMs: 8000 }),
  req('POST Create Candidate — refused for the view-only user', 'POST', '/api/admin/candidates', { cookie: HRV, json: { name: '{{runTag}} SHOULD NOT EXIST', phone: '020 0000 0000' }, status: 403, error: 'view-only' }),
  req('PUT Essay Marks — refused for the view-only user', 'PUT', '/api/admin/assessments/{{assessmentId}}/essay-marks', { cookie: HRV, json: { marks: {} }, status: 403, error: 'view-only' }),
  req('DELETE Candidate — refused for the view-only user', 'DELETE', '/api/admin/candidates/{{candidateIdA}}', { cookie: HRV, status: 403, error: 'view-only' }),
  req('GET HR Users — refused for the view-only user', 'GET', '/api/admin/users', { cookie: HRV, status: 403, error: 'view-only' }),
  req('POST Disable HR User', 'POST', '/api/admin/users/{{hrViewerId}}/disable', { test: () => { pm.test('Disabled', () => pm.expect(body.active).to.equal(false)); } }),
  req('GET Candidates — the disabled user\'s session has ended', 'GET', '/api/admin/candidates', { cookie: HRV, status: 401 }),
  req('POST Enable HR User', 'POST', '/api/admin/users/{{hrViewerId}}/enable', { test: () => { pm.test('Active', () => pm.expect(body.active).to.equal(true)); } }),
  req('POST Reset HR User Password', 'POST', '/api/admin/users/{{hrViewerId}}/password', { json: { password: 'postman-hr-viewer-2' }, test: () => { pm.environment.set('hrViewerSession', ''); } }),
  req('DELETE HR User', 'DELETE', '/api/admin/users/{{hrViewerId}}', { test: () => { pm.test('ok', () => pm.expect(body.ok).to.equal(true)); } }),
  req('DELETE HR User — already deleted', 'DELETE', '/api/admin/users/{{hrViewerId}}', { status: 404 }),
]);

// ================================================================================
// 22 Result Viewer (a separate read-only login for one person's own results)
// ================================================================================
const keepViewerCookie = () => {
  // The Result Viewer session cookie (the cookie jar is off for these requests).
  for (const h of pm.response.headers.all()) {
    const m = h.key.toLowerCase() === 'set-cookie' && /lalco_result_session=([^;]+)/.exec(h.value);
    if (m) pm.environment.set('viewerSession', m[1]);
  }
};
const VIEWER = 'lalco_result_session={{viewerSession}}';
const viewerFolder = folder('22 Result Viewer', 'A Result Viewer account is a separate, read-only login (/results) for ONE person. This folder creates a temporary account "postman-test-…" for this run\'s Candidate A, logs in (own cookie lalco_result_session, sent explicitly), reads and exports A\'s own results, and checks that the account can never reach the admin API or another person. The account is deleted at the end (and swept in 99 Cleanup).', [
  req('POST Create Result Viewer — missing person', 'POST', '/api/admin/result-viewers', { json: '{ "username": "postman-test-{{runStamp}}", "password": "postman-viewer-1" }', status: 400, error: 'Choose the candidate or the staff member' }),
  req('POST Create Result Viewer — password too short', 'POST', '/api/admin/result-viewers', { json: '{ "username": "postman-test-{{runStamp}}", "password": "short", "candidate_id": {{candidateIdA}} }', status: 400, error: 'at least 8 characters' }),
  req('POST Create Result Viewer — for Candidate A', 'POST', '/api/admin/result-viewers', {
    json: '{ "username": "postman-test-{{runStamp}}", "password": "postman-viewer-1", "candidate_id": {{candidateIdA}} }', status: 201,
    test: () => {
      pm.test('Linked to Candidate A, active; no password or hash returned', () => {
        pm.expect(body.person_type).to.equal('candidate'); pm.expect(body.person_id).to.equal(Number(env('candidateIdA'))); pm.expect(body.active).to.equal(true);
        pm.expect(JSON.stringify(body)).to.not.include('postman-viewer-1'); pm.expect(body).to.not.have.property('password_hash');
      });
      set('viewerId', String(body.id));
    },
  }),
  req('POST Create Result Viewer — same username again', 'POST', '/api/admin/result-viewers', { json: '{ "username": "POSTMAN-TEST-{{runStamp}}", "password": "postman-viewer-1", "candidate_id": {{candidateIdA}} }', status: 400, error: 'already used' }),
  req('GET Result Viewers', 'GET', '/api/admin/result-viewers', { test: () => { pm.test('Ours listed; no hashes', () => { pm.expect(body.map((a) => a.id)).to.include(Number(env('viewerId'))); pm.expect(JSON.stringify(body)).to.not.match(/\$2[aby]\$/); }); } }),
  req('POST Result Viewer Login — wrong password', 'POST', '/api/results/auth/login', { noAuth: true, json: '{ "username": "postman-test-{{runStamp}}", "password": "wrong-password" }', status: 401, error: 'Incorrect username or password.' }),
  req('POST Result Viewer Login', 'POST', '/api/results/auth/login', {
    noAuth: true, json: '{ "username": "postman-test-{{runStamp}}", "password": "postman-viewer-1" }',
    test: [keepViewerCookie, () => {
      pm.test('Only the username comes back (no results, no person data)', () => pm.expect(body).to.eql({ username: 'postman-test-' + env('runStamp') }));
      const c = pm.response.headers.all().find((h) => h.key.toLowerCase() === 'set-cookie');
      pm.test('Own cookie: HttpOnly, SameSite=Strict, only for /api/results', () => { pm.expect(c.value).to.match(/^lalco_result_session=/); pm.expect(c.value).to.match(/HttpOnly/i); pm.expect(c.value).to.match(/SameSite=Strict/i); pm.expect(c.value).to.include('Path=/api/results'); });
    }],
  }),
  req('GET Standard Report — Candidate A\'s status now', 'GET', '/api/admin/report/standard', {
    test: () => { const row = body.rows.find((r) => r.candidate_id === Number(env('candidateIdA'))); pm.test('A is in the report', () => pm.expect(row).to.exist); set('viewerExpectedStatus', row.values[14]); },
  }),
  req('GET My Results', 'GET', '/api/results/me', {
    cookie: VIEWER,
    test: () => {
      pm.test('Candidate A only', () => { pm.expect(body.candidateName).to.equal(env('runTag') + ' A'); pm.expect(body.assessments.length).to.equal(1); });
      pm.test('Overall result = the status HR\'s report shows', () => pm.expect(body.overallStatus).to.equal(env('viewerExpectedStatus')));
      pm.test('The tests of A\'s assessment with the existing scores (interview marked full marks by HR)', () => {
        const interview = body.tests.find((t) => t.testType === env('interviewTypeKey'));
        pm.expect(interview.status).to.equal('PASS'); pm.expect(interview.percentage).to.equal(100);
        body.tests.forEach((t) => pm.expect(['PASS', 'NOT PASS', 'PENDING', 'NOT TAKEN']).to.include(t.status));
      });
      pm.test('No questions, answers or HR-only fields', () => { const s = JSON.stringify(body); ['question', 'answer', 'correct', 'pass_mark', 'review_required', 'eligibility_note'].forEach((k) => pm.expect(s).to.not.include(k)); });
    },
  }),
  req('GET My Results — another candidate\'s id in the URL is ignored', 'GET', '/api/results/me', {
    cookie: VIEWER, q: { candidateId: '{{iqCandidateS1}}', assessmentId: '{{iqAttemptS1}}' },
    test: () => { pm.test('Still Candidate A, never S1', () => { pm.expect(body.candidateName).to.equal(env('runTag') + ' A'); pm.expect(JSON.stringify(body)).to.not.include(env('runTag') + ' S1'); }); },
  }),
  req('GET Another Person\'s Result by path', 'GET', '/api/results/candidates/{{iqCandidateS1}}', { cookie: VIEWER, status: 404 }),
  req('GET Export My Results (Excel)', 'GET', '/api/results/me/export.xlsx', { cookie: VIEWER, type: 'xlsx', maxMs: 8000 }),
  req('PUT My Results — refused (read only)', 'PUT', '/api/results/me', { cookie: VIEWER, json: { overallStatus: 'PASS' }, status: 404 }),
  req('GET Admin API with the Result Viewer token as the admin cookie', 'GET', '/api/admin/candidates', { cookie: 'hr_session={{viewerSession}}', status: 401, desc: 'A Result Viewer token is signed with its own key: it never opens the admin API.' }),
  req('DELETE Admin API with the Result Viewer session', 'DELETE', '/api/admin/candidates/{{iqCandidateS1}}', { cookie: VIEWER, status: 401 }),
  req('POST Disable Result Viewer', 'POST', '/api/admin/result-viewers/{{viewerId}}/disable', { test: () => { pm.test('Disabled', () => pm.expect(body.active).to.equal(false)); } }),
  req('GET My Results — after the account is disabled', 'GET', '/api/results/me', { cookie: VIEWER, status: 401, desc: 'Disabling ends the open session at once.' }),
  req('POST Result Viewer Login — disabled account', 'POST', '/api/results/auth/login', { noAuth: true, json: '{ "username": "postman-test-{{runStamp}}", "password": "postman-viewer-1" }', status: 403, error: 'disabled' }),
  req('POST Enable Result Viewer', 'POST', '/api/admin/result-viewers/{{viewerId}}/enable', { test: () => { pm.test('Active', () => pm.expect(body.active).to.equal(true)); } }),
  req('POST Reset Result Viewer Password — too short', 'POST', '/api/admin/result-viewers/{{viewerId}}/password', { json: { password: 'short' }, status: 400, error: 'at least 8 characters' }),
  req('POST Reset Result Viewer Password', 'POST', '/api/admin/result-viewers/{{viewerId}}/password', { json: { password: 'postman-viewer-2' }, test: () => { pm.test('Account returned, no password', () => pm.expect(JSON.stringify(body)).to.not.include('postman-viewer-2')); } }),
  req('POST Result Viewer Login — new password', 'POST', '/api/results/auth/login', { noAuth: true, json: '{ "username": "postman-test-{{runStamp}}", "password": "postman-viewer-2" }', test: [keepViewerCookie] }),
  req('POST Result Viewer Logout', 'POST', '/api/results/auth/logout', { cookie: VIEWER, test: () => { pm.test('ok', () => pm.expect(body.ok).to.equal(true)); } }),
  req('GET My Results — logged-out token replayed', 'GET', '/api/results/me', { cookie: VIEWER, status: 401, test: () => { pm.environment.set('viewerSession', ''); } }),
  req('DELETE Result Viewer (the login only)', 'DELETE', '/api/admin/result-viewers/{{viewerId}}', { test: () => { pm.test('ok', () => pm.expect(body.ok).to.equal(true)); } }),
  req('DELETE Result Viewer — already deleted', 'DELETE', '/api/admin/result-viewers/{{viewerId}}', { status: 404 }),
  req('GET Candidate A — results kept after deleting the login', 'GET', '/api/admin/candidates/{{candidateIdA}}', { test: () => { pm.test('A\'s assessment is still there', () => pm.expect(body.candidate.tests.length).to.be.above(0)); } }),
]);
const cleanup = folder('99 Cleanup', 'Removes ONLY temporary data: candidates, links, questions, categories and test types whose names start with "POSTMAN TEST" (the prefix of every name this collection creates, including leftovers of an interrupted earlier run). Order matters: candidates (and their attempts) → links → questions → categories → test types. Real data is never deleted.', [
  sweep('DELETE Temporary HR Users', '/api/admin/users', 'HR users', () => {
    const mine = body.filter((u) => /^postman-test-/i.test(u.username)).map((u) => ({ url: '/api/admin/users/' + u.id, label: u.username }));
  }, 'View-only HR users named "postman-test-…" (left by an interrupted run).'),
  sweep('DELETE Temporary Result Viewer accounts', '/api/admin/result-viewers', 'result viewer accounts', () => {
    const mine = body.filter((a) => /^postman-test-/i.test(a.username)).map((a) => ({ url: '/api/admin/result-viewers/' + a.id, label: a.username }));
  }, 'Result Viewer logins named "postman-test-…" (left by an interrupted run). Only the login is deleted.'),
  sweep('DELETE Temporary Candidates', '/api/admin/candidates', 'candidates', () => {
    const mine = body.filter((c) => String(c.name).startsWith('POSTMAN TEST ')).map((c) => ({ url: '/api/admin/candidates/' + c.id, label: c.name }));
  }, 'Candidates named "POSTMAN TEST …" and (by cascade) their attempts.'),
  sweep('DELETE Temporary Links', '/api/admin/assessments', 'links', () => {
    const mine = body.filter((x) => x.kind === 'link' && String(x.title).startsWith('POSTMAN TEST ')).map((l) => ({ url: '/api/admin/links/' + l.id, label: l.title }));
  }),
  sweep('DELETE Temporary Internal Staff', '/api/admin/internal/staff', 'staff', () => {
    const mine = body.staff.filter((x) => String(x.name).startsWith('POSTMAN TEST ')).map((x) => ({ url: '/api/admin/internal/staff/' + x.id, label: x.name }));
  }, 'Internal staff named "POSTMAN TEST …" and (by cascade) their attempts.'),
  sweep('DELETE Temporary Internal Links', '/api/admin/internal/links', 'internal links', () => {
    const mine = body.filter((l) => String(l.title).startsWith('POSTMAN TEST ')).map((l) => ({ url: '/api/admin/internal/links/' + l.id, label: l.title }));
  }),
  sweep('DELETE Temporary Questions', '/api/admin/questions', 'questions', () => {
    const temp = body.test_types.filter((t) => String(t.name).startsWith('POSTMAN TEST ')).map((t) => t.key);
    const mine = body.questions.filter((q) => temp.includes(q.section) || String(q.question_text).startsWith('POSTMAN TEST ')).map((q) => ({ url: '/api/admin/questions/' + q.id, label: q.question_text }));
  }, 'Questions in the temporary test types, and seeded IQ questions ("POSTMAN TEST …" text, LOCAL mode only).'),
  sweep('DELETE Temporary Categories', '/api/admin/questions', 'categories', () => {
    const temp = body.test_types.filter((t) => String(t.name).startsWith('POSTMAN TEST ')).map((t) => t.key);
    const mine = body.categories.filter((c) => temp.includes(c.section) || String(c.name).startsWith('POSTMAN TEST ')).map((c) => ({ url: '/api/admin/categories/' + c.id, label: c.name }));
  }),
  sweep('DELETE Temporary Test Types', '/api/admin/test-types', 'test types', () => {
    const mine = body.filter((t) => String(t.name).startsWith('POSTMAN TEST ') && !t.core).map((t) => ({ url: '/api/admin/test-types/' + t.key, label: t.name }));
  }),
  req('GET Questions — back to the baseline', 'GET', '/api/admin/questions', {
    desc: 'Proves the run left no data behind: question counts per core test type, the test types and the number of categories match the baseline recorded after login.',
    test: () => {
      const counts = getJSON('baselineCounts');
      pm.test('Question counts per test type = baseline', () => Object.keys(counts).forEach((k) => pm.expect(body.total_counts[k], k).to.equal(counts[k])));
      pm.test('Test types = baseline', () => pm.expect(body.test_types.map((t) => t.key)).to.eql(getJSON('baselineTypes')));
      pm.test('Categories = baseline', () => pm.expect(body.categories.length).to.equal(Number(env('baselineCategories'))));
    },
  }),
  req('GET Internal Dashboard — back to the baseline', 'GET', '/api/admin/internal/dashboard', {
    test: () => {
      const b = getJSON('internalBaseline');
      pm.test('Internal staff, assessments and links = baseline', () => { pm.expect(body.totalStaff).to.equal(b.totalStaff); pm.expect(body.totalAssessments).to.equal(b.totalAssessments); pm.expect(body.activeLinks).to.equal(b.activeLinks); });
    },
  }),
  req('POST Logout — end of run', 'POST', '/api/admin/auth/logout', { test: () => { pm.test('ok', () => pm.expect(body.ok).to.equal(true)); } }),
]);

// ---- the "usable rows" helper used by several import tests ------------------------
const LIB_USABLE = 'var usable = (body && body.rows || []).filter((r) => r.errors.length === 0 || (r.errors.length === 1 && /^Test Type "/.test(r.errors[0])));';

// ================================================================================
// Collection
// ================================================================================
const collection = {
  info: {
    name: NAME,
    description: [
      'Executable API test suite for the LALCO HR Recruitment System, written from the routes in the source code.',
      '',
      '**Run order:** run the whole collection (Run Collection) with the "LALCO HR Recruitment System — Local" or "— Production" environment. Folders depend on each other in order: IDs, tokens and sessions are captured automatically.',
      '**Production-safe:** every record this run creates is named "POSTMAN TEST <timestamp> …" and goes into temporary test types; the Cleanup folder removes exactly those. Requests marked "mode = LOCAL" are skipped on production. Nothing real is deleted or changed (settings are saved back unchanged; Delete All Questions is only called with an invalid area).',
      '**Files:** set Settings → General → Working directory to this repository\'s `postman` folder (the upload requests attach files from `postman/fixtures`).',
      '**Timer test:** folder 14 waits 65 seconds; set skipTimerTests = true in the environment to skip it.',
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  event: [
    { listen: 'prerequest', script: { type: 'text/javascript', exec: [
      "pm.variables.set('maxMs', 3000);",
    ] } },
    { listen: 'test', script: { type: 'text/javascript', exec: body(() => {
      // Checks for EVERY request (on top of each request's own tests).
      const maxMs = Number(pm.variables.get('maxMs') || 3000);
      pm.test(`Response time under ${maxMs} ms`, () => pm.expect(pm.response.responseTime).to.be.below(maxMs));
      pm.test('No server error (5xx)', () => pm.expect(pm.response.code, pm.response.text().slice(0, 200)).to.be.below(500));
      const ct = pm.response.headers.get('Content-Type') || '';
      if (pm.request.url.getPath().startsWith('/api/')) pm.test('API did not answer with an HTML page', () => pm.expect(ct).to.not.include('text/html'));
      if (ct.includes('json')) {
        pm.test('No stack trace or internal error details in the response', () => pm.expect(pm.response.text()).to.not.match(/\bat [\w.<>]+ \(.*:\d+:\d+\)|SqliteError|TypeError:|ReferenceError:|node_modules/));
      }
    }) } },
  ],
  item: [health, authFolder, dashboard, candidates, testTypes, cats, questions, imports, imagesFolder, assessments, links, exam, iq, timer, results, settings, internalStaff, internalLinks, internalExam, internalResults, security, viewerFolder, hrUsersFolder, cleanup],
};

// Import tests use the collection-provided helper (eval of libUsable); replace the placeholder.
const walk = (items) => items.forEach((it) => { if (it.item) walk(it.item); else for (const ev of it.event) ev.script.exec = ev.script.exec.map((l) => l.replace("eval(pm.environment.get('libUsable'));", LIB_USABLE)); });
walk(collection.item);

const VARS = ['runTag', 'hrViewerId', 'hrViewerSession', 'viewerExpectedStatus', 'viewerId', 'viewerSession', 'reportStatuses', 'secondAdminToken', 'guardNeed', 'guardLinkId', 'guardQuestionId', 'guardQuestionJson', 'candidateIdA', 'sessionUsedByA', 'sameBrowserSessionSB2', 'sameBrowserSessionSB3',
  'questionsSB2', 'questionsSB3', 'answersSB2', 'answersSB3', 'essayQuestionSB2', 'essayQuestionSB3', 'staffSessionUsedByA', 'staffSessionUsedByE', 'staffSessionUsedByG', 'internalResultE',
  'internalAnswersE1', 'internalAnswersE2', 'internalExportSize', 'internalExportOneSize', 'candidateId', 'questionId', 'pictureQuestionId', 'imageId', 'categoryId', 'category2Id', 'testTypeKey', 'interviewTypeKey', 'calcTypeKey', 'throwawayTypeKey',
  'assessmentId', 'attemptB', 'linkId', 'linkToken', 'candidateToken', 'iqLinkId', 'iqLinkToken', 'spareLinkId', 'spareLinkToken', 'oldSpareToken', 'timerLinkId', 'timerLinkToken',
  'candidateSessionA', 'candidateSessionB', 'candidateSessionC', 'candidateSessionD', 'candidateSessionX', 'candidateSessionS1', 'candidateSessionS2', 'candidateSessionS3',
  'questionsA', 'questionsB', 'questionsC', 'remainingA', 'essayQuestionA', 'essayMax', 'iqCount', 'iqBankSize', 'mcqActiveCount', 'translator',
  'iqIdsS1', 'iqIdsS2', 'iqIdsS3', 'iqAttemptS1', 'iqAttemptS2', 'iqAttemptS3', 'iqCandidateS1', 'iqCandidateS2', 'iqCandidateS3',
  'runStamp', 'internalStaffId', 'internalAssessmentId', 'internalLinkId', 'internalLinkToken', 'internalStaffSession', 'internalStaffSessionB', 'internalStaffSessionC',
  'internalStaffSessionD', 'internalStaffSessionX', 'internalStaffDeleteId', 'internalSingleLinkId', 'internalSingleLinkToken', 'oldInternalToken', 'internalSpareLinkId', 'internalResultB', 'internalQuestionsA',
  'internalQuestionsB', 'internalAnswersA1', 'internalAnswersA2', 'internalBaseline', 'internalExpiresAt', 'internalIqCount', 'recruitmentCompletedBefore', 'recruitmentTotalBefore',
  'iqAnswersS1', 'iqAnswersS2', 'iqAnswersS3', 'iqExpectedS1', 'iqExpectedS2', 'iqExpectedS3', 'iqBands',
  'importRowsTxt', 'importRowsXlsx', 'importRowsBehavioral', 'importRowsCalc', 'baselineCounts', 'baselineTypes', 'baselineCategories', 'baselineCompleted', 'settingsBefore'];
const environment = (label, baseUrl, mode) => ({
  name: `${NAME} — ${label}`,
  values: [
    { key: 'baseUrl', value: baseUrl, type: 'default', enabled: true },
    { key: 'mode', value: mode, type: 'default', enabled: true },
    { key: 'adminUsername', value: 'admin', type: 'default', enabled: true },
    { key: 'adminPassword', value: '', type: 'secret', enabled: true },
    { key: 'skipTimerTests', value: 'false', type: 'default', enabled: true },
    ...VARS.map((key) => ({ key, value: '', type: 'default', enabled: true })),
  ],
  _postman_variable_scope: 'environment',
});

fs.mkdirSync(path.join(ROOT, 'env'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'LALCO-HR-Recruitment-System.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n');
fs.writeFileSync(path.join(ROOT, 'env', 'LALCO-HR-Local.postman_environment.json'), JSON.stringify(environment('Local', 'http://localhost:3000', 'LOCAL'), null, 2) + '\n');
fs.writeFileSync(path.join(ROOT, 'env', 'LALCO-HR-Production.postman_environment.json'), JSON.stringify(environment('Production', 'https://hr-recruitment-system-production.up.railway.app', 'PRODUCTION'), null, 2) + '\n');
fs.writeFileSync(path.join(ROOT, 'tools', 'inventory.json'), JSON.stringify([...new Set(inventory)].sort(), null, 2) + '\n');
let requests = 0; let tests = 0;
const count = (items) => items.forEach((it) => { if (it.item) count(it.item); else { requests++; tests += it.event.find((e) => e.listen === 'test').script.exec.filter((l) => l.includes('pm.test(')).length; } });
count(collection.item);
console.log(`Collection: ${collection.item.length} folders, ${requests} requests, ${tests} request-level pm.test() calls (+4-5 collection-level checks per request); ${new Set(inventory).size} distinct method + path combinations.`);
