'use strict';
// LALCO Result Viewer: log in, see your OWN assessment results, print, export
// Excel, log out. Read only. All text goes through textContent (via h()).

const TEXT = {
  en: {
    title: 'MY ASSESSMENT RESULTS', login_title: 'Assessment Results', login_intro: 'Log in with the username and password HR gave you.',
    username: 'Username', password: 'Password', login: 'Log in', logout: 'Logout', print: 'Print result', export: 'Export Excel',
    name: 'Candidate Name', phone: 'Phone Number', employee_id: 'Employee ID', date: 'Assessment Date',
    test: 'Test', status: 'Status', score: 'Score', percentage: 'Percentage', level: 'Level', raw: 'Raw weighted score',
    overall: 'OVERALL RESULT', pending: 'Pending', none: 'No finished assessment yet. Your results appear here when your assessment is complete.',
    statuses: { PASS: 'PASS', 'NOT PASS': 'NOT PASS', PENDING: 'PENDING', 'NOT TAKEN': 'Not taken' },
    error: 'Something went wrong. Please try again.', wrong: 'Incorrect username or password.', lang: 'ລາວ',
  },
  lo: {
    title: 'ຜົນການປະເມີນຂອງຂ້ອຍ', login_title: 'ຜົນການປະເມີນ', login_intro: 'ເຂົ້າສູ່ລະບົບດ້ວຍຊື່ຜູ້ໃຊ້ ແລະ ລະຫັດຜ່ານທີ່ຝ່າຍບຸກຄະລາກອນ (HR) ໃຫ້ທ່ານ.',
    username: 'ຊື່ຜູ້ໃຊ້', password: 'ລະຫັດຜ່ານ', login: 'ເຂົ້າສູ່ລະບົບ', logout: 'ອອກຈາກລະບົບ', print: 'ພິມຜົນ', export: 'ສົ່ງອອກ Excel',
    name: 'ຊື່ ແລະ ນາມສະກຸນ', phone: 'ເບີໂທລະສັບ', employee_id: 'ລະຫັດພະນັກງານ', date: 'ວັນທີປະເມີນ',
    test: 'ແບບທົດສອບ', status: 'ສະຖານະ', score: 'ຄະແນນ', percentage: 'ເປີເຊັນ', level: 'ລະດັບ', raw: 'ຄະແນນຖ່ວງນ້ຳໜັກ',
    overall: 'ຜົນລວມ', pending: 'ລໍຖ້າ', none: 'ຍັງບໍ່ມີການປະເມີນທີ່ສຳເລັດ. ຜົນຂອງທ່ານຈະສະແດງຢູ່ນີ້ເມື່ອການປະເມີນສຳເລັດ.',
    statuses: { PASS: 'ຜ່ານ', 'NOT PASS': 'ບໍ່ຜ່ານ', PENDING: 'ລໍຖ້າ', 'NOT TAKEN': 'ບໍ່ໄດ້ເຮັດ' },
    error: 'ມີບາງຢ່າງຜິດພາດ. ກະລຸນາລອງໃໝ່.', wrong: 'ຊື່ຜູ້ໃຊ້ ຫຼື ລະຫັດຜ່ານບໍ່ຖືກຕ້ອງ.', lang: 'English',
  },
};
let lang = 'en';
try { lang = localStorage.getItem('lalco_results_lang') === 'lo' ? 'lo' : 'en'; } catch { /* storage blocked: English */ }
let T = TEXT[lang];
let lastData = null;

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const main = () => document.getElementById('results');
const render = (...nodes) => main().replaceChildren(...nodes);

async function call(method, url, body) {
  const r = await fetch('/api/results' + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, data };
}

function langSwitch() {
  const b = h('button', { type: 'button', class: 'small', id: 'lang-button' }, T.lang);
  b.addEventListener('click', () => {
    lang = lang === 'en' ? 'lo' : 'en';
    T = TEXT[lang];
    document.documentElement.lang = lang;
    try { localStorage.setItem('lalco_results_lang', lang); } catch { /* ignore */ }
    if (lastData) showResults(lastData); else showLogin();
  });
  document.getElementById('lang-switch').replaceChildren(b);
}

function showLogin(errorText) {
  lastData = null;
  langSwitch();
  const err = h('div', { class: 'message error' + (errorText ? '' : ' hidden') }, errorText || '');
  const user = h('input', { id: 'username', name: 'username', autocomplete: 'username', required: true });
  const pass = h('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const button = h('button', { type: 'submit' }, T.login);
  const form = h('form', { class: 'card results-login', id: 'login-form' },
    h('h1', {}, T.login_title), h('p', { class: 'muted' }, T.login_intro), err,
    h('div', { class: 'field' }, h('label', { for: 'username' }, T.username), user),
    h('div', { class: 'field' }, h('label', { for: 'password' }, T.password), pass), button);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    button.disabled = true;
    try {
      const r = await call('POST', '/auth/login', { username: user.value.trim(), password: pass.value });
      if (r.status !== 200) { button.disabled = false; err.textContent = r.status === 401 ? T.wrong : (r.data && r.data.error) || T.error; err.classList.remove('hidden'); return; }
      pass.value = '';
      await load();
    } catch { button.disabled = false; err.textContent = T.error; err.classList.remove('hidden'); }
  });
  render(form);
  user.focus();
}

const badgeClass = (s) => ({ PASS: 'pass', 'NOT PASS': 'fail', PENDING: 'pending' }[s] || 'neutral');
const statusBadge = (s) => h('span', { class: 'badge ' + badgeClass(s) }, T.statuses[s] || s);
const pct = (v) => (v == null ? null : Number(v).toFixed(1) + '%');
const testName = (t) => (lang === 'lo' && t.test_lo) || t.test;
const levelName = (t) => (lang === 'lo' && t.level_lo) || (t.level ? (lang === 'lo' ? TEXT.lo.levels?.[t.level] : null) || t.level : null);

function testsTable(tests) {
  const cell = (label, ...content) => h('td', { 'data-label': label }, ...content);
  return h('table', { class: 'results-table' },
    h('thead', {}, h('tr', {}, [T.test, T.status, T.score, T.percentage, T.level].map((x) => h('th', {}, x)))),
    h('tbody', {}, tests.map((t) => {
      const pending = t.status === 'PENDING';
      return h('tr', {},
        cell(T.test, h('strong', {}, testName(t))),
        cell(T.status, statusBadge(t.status)),
        cell(T.score, t.score_text || (pending ? T.pending : '—'), t.raw_score_text ? h('div', { class: 'muted small' }, `${T.raw}: ${t.raw_score_text}`) : null),
        cell(T.percentage, pct(t.percentage) || (pending ? T.pending : '—')),
        cell(T.level, levelName(t) || '—'));
    })));
}

function assessmentBlock(a, data) {
  return h('section', { class: 'card results-card' },
    h('table', { class: 'kv results-identity' }, h('tbody', {},
      h('tr', {}, h('th', {}, T.name), h('td', {}, data.candidateName)),
      data.employeeId ? h('tr', {}, h('th', {}, T.employee_id), h('td', {}, data.employeeId)) : null,
      data.phone ? h('tr', {}, h('th', {}, T.phone), h('td', {}, data.phone)) : null,
      h('tr', {}, h('th', {}, T.date), h('td', {}, a.assessmentDate)))),
    testsTable(a.tests),
    h('div', { class: 'results-overall' }, h('span', {}, T.overall + ':'), h('span', { class: 'badge big ' + badgeClass(a.overallStatus), id: 'overall' }, T.statuses[a.overallStatus] || a.overallStatus)));
}

function showResults(data) {
  lastData = data;
  langSwitch();
  const actions = h('div', { class: 'row results-actions' },
    h('button', { type: 'button', id: 'print', onclick: () => window.print() }, T.print),
    h('a', { class: 'button secondary', id: 'export', href: '/api/results/me/export.xlsx' }, T.export),
    h('button', { type: 'button', class: 'secondary', id: 'logout', onclick: logout }, T.logout));
  const body = data.assessments.length ? data.assessments.map((a) => assessmentBlock(a, data))
    : [h('section', { class: 'card results-card' }, h('p', {}, data.candidateName), h('p', { class: 'muted' }, T.none))];
  render(h('div', { class: 'results-head' }, h('div', { class: 'print-brand' }, 'LALCO'), h('h1', {}, T.title)), ...body, actions);
}

async function logout() {
  try { await call('POST', '/auth/logout'); } catch { /* the page still forgets the results */ }
  showLogin();
}

async function load() {
  try {
    const r = await call('GET', '/me');
    if (r.status === 200) return showResults(r.data);
    if (r.status === 401) return showLogin();
    return showLogin((r.data && r.data.error) || T.error);
  } catch { return showLogin(T.error); }
}

TEXT.lo.levels = { Exceptional: 'ດີເລີດ', 'Very High': 'ສູງຫຼາຍ', High: 'ສູງ', Average: 'ປານກາງ', Low: 'ຕ່ຳ', 'Very Low': 'ຕ່ຳຫຼາຍ' };
document.documentElement.lang = lang;
load();
