'use strict';
// LALCO HR admin. Plain JavaScript, no build step.
// All text goes through textContent (via h()), never innerHTML, so uploaded
// question text or candidate input can never inject HTML.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (id) => document.getElementById(id);
const view = () => $('view');

async function api(method, url, body, isForm) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  let res;
  try { res = await fetch('/api/admin' + url, opts); } catch {
    throw new Error('Cannot reach the server. Please check your connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && url !== '/auth/login') { showLogin(); throw new Error((data && data.error) || 'Please log in.'); }
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong.\nPlease try again.');
  return data;
}

const SECTION_LABEL = { IQ: 'IQ', GENERAL: 'General', CALCULATION: 'Calculation', ESSAY: 'Essay' };
const TYPE_LABEL = { IQ: 'IQ Test', GENERAL: 'General Test', CALCULATION: 'Calculation Test', ESSAY: 'Essay Test', COMBINED: 'Combined Assessment' };
const TYPE_SECTIONS = { IQ: ['IQ'], GENERAL: ['GENERAL'], CALCULATION: ['CALCULATION'], ESSAY: ['ESSAY'], COMBINED: ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY'] };
const LANG_LABEL = { en: 'English', lo: 'Lao' };
const STATE_LABEL = {
  ready: ['Waiting', 'neutral'], in_progress: ['In progress', 'pending'], next_test: ['Between tests', 'pending'], submitted: ['Submitted', 'pass'],
  expired: ['Link expired', 'fail'], disabled: ['Disabled', 'fail'],
};

const fmt = (v) => (v == null || v === '' ? '-' : String(v));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : '-');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '-');
const fmtMinutes = (m) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} min`);

function resultBadge(result) {
  const cls = result === 'Pass' ? 'pass' : result === 'Not Pass' ? 'fail' : 'pending';
  return h('span', { class: 'badge ' + cls }, result === 'Pass' ? 'PASS' : result === 'Not Pass' ? 'NOT PASS' : 'Pending');
}
const fmtPct = (v) => (v == null ? '-' : Number(v).toFixed(1) + '%');
// System assessment eligibility (never HR's own Final Result).
function eligibilityBadge(e) {
  if (!e) return '-';
  return h('span', { class: 'badge ' + (e === 'Eligible' ? 'pass' : e === 'Not Eligible' ? 'fail' : 'pending') }, e.toUpperCase());
}
// PASS / NOT PASS / PENDING HR MARKING / IN PROGRESS / NOT STARTED / LOCKED of one test.
function testStateBadge(state) {
  if (!state) return '-';
  const cls = { PASS: 'pass', 'NOT PASS': 'fail', 'PENDING HR MARKING': 'pending', 'IN PROGRESS': 'pending' }[state] || 'neutral';
  return h('span', { class: 'badge ' + cls }, (state === 'LOCKED' ? '🔒 ' : '') + state);
}
const testOf = (c, sec) => (c.tests || []).find((t) => t.section === sec);
function stateBadge(state) {
  const [text, cls] = STATE_LABEL[state] || [state, 'neutral'];
  return h('span', { class: 'badge ' + cls }, text);
}

function message(text, kind) {
  return h('div', { class: 'message ' + (kind || 'error') }, text);
}

// Shows an error/success message at the top of a container.
function flash(container, text, kind) {
  const old = container.querySelector(':scope > .message');
  if (old) old.remove();
  if (text) container.prepend(message(text, kind));
}

function field(labelText, input, cls) {
  const id = input.id || 'f_' + Math.random().toString(36).slice(2);
  input.id = id;
  return h('div', { class: 'field ' + (cls || '') }, h('label', { for: id }, labelText), input);
}

function select(name, options, value) {
  return h('select', { name }, options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) }, text)));
}

function formValues(form) {
  const out = {};
  for (const el of form.elements) if (el.name) out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  return out;
}

function modal(title, content) {
  const close = () => backdrop.remove();
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal' }, h('div', { class: 'row between' }, h('h2', {}, title), h('button', { class: 'secondary small', type: 'button', onclick: close }, 'Close')), content));
  document.body.append(backdrop);
  return close;
}

function downloadLink(url, text, cls) {
  return h('a', { class: 'button ' + (cls || 'secondary small'), href: '/api/admin' + url }, text);
}

function examUrl(token) {
  return location.origin + '/exam/' + token;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = old; }, 1500);
  } catch {
    window.prompt('Copy this link:', text);
  }
}

function loading() {
  view().replaceChildren(h('p', { class: 'muted' }, 'Loading...'));
}

// ---------------------------------------------------------------------------
// Login / routing
// ---------------------------------------------------------------------------

function showLogin() {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('username').focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-error');
  err.classList.add('hidden');
  try {
    const me = await api('POST', '/auth/login', { username: $('username').value, password: $('password').value });
    $('password').value = '';
    startApp(me);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('logout').addEventListener('click', async () => {
  try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
  showLogin();
});

function startApp(me) {
  $('whoami').textContent = me.username;
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  route();
}

const ROUTES = {
  dashboard: () => renderDashboard(),
  candidates: (id) => (id ? renderCandidate(id) : renderCandidates()),
  questions: () => renderQuestions(),
  categories: (id) => renderCategories(id),
  assessments: (id) => (id ? renderAssessment(id) : renderAssessments()),
  links: (id) => renderLink(id),
  results: () => renderResults(),
  settings: () => renderSettings(),
};

async function route() {
  const [, page = 'dashboard', id] = location.hash.split('/');
  const render = ROUTES[page] || ROUTES.dashboard;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === (page === 'links' ? 'assessments' : page === 'categories' ? 'questions' : ROUTES[page] ? page : 'dashboard')));
  loading();
  try { await render(id); } catch (e) { view().replaceChildren(message(e.message)); }
}
window.addEventListener('hashchange', () => { if (!$('app').classList.contains('hidden')) route(); });

(async function init() {
  try { startApp(await api('GET', '/auth/me')); } catch { showLogin(); }
})();

// ---------------------------------------------------------------------------
// IQ result (weighted: Level 1 = 1 mark, Level 2 = 2, Level 3 = 3)
// ---------------------------------------------------------------------------

const LEVEL_NAMES = { Easy: 'Level 1 — Easy', Basic: 'Level 2 — Basic', Moderate: 'Level 3 — Moderate', Difficult: 'Level 4 — Difficult', 'Very Difficult': 'Level 5 — Very Difficult',
  Medium: 'Medium (earlier 3-level scale)', Hard: 'Hard (earlier 3-level scale)' };
const LEVEL_MARK = { Easy: 1, Basic: 2, Moderate: 3, Difficult: 4, 'Very Difficult': 5 };
const IQ_LEVELS = [1, 2, 3, 4, 5];
const levelOf = (r, n) => (r.iq_levels || []).find((l) => l.level === n);
const levelMarksCell = (r, n) => { const l = levelOf(r, n); return l ? l.marks_text : '-'; };
const levelCell = (r, n) => {
  const l = levelOf(r, n);
  return l ? h('div', {}, h('div', {}, l.correct_text + ' correct'), h('div', { class: 'muted small' }, l.marks_text + ' marks')) : '-';
};

// The full IQ TEST RESULT block used on the candidate and review pages.
function iqResultBlock(r) {
  if (!r || !r.iq_text) return h('span', {}, '-');
  return h('div', { class: 'iq-result' },
    h('div', { class: 'iq-row' }, h('span', { class: 'muted' }, 'Correct Answers'), h('strong', {}, r.iq_correct_text || '-')),
    h('div', { class: 'iq-row' }, h('span', { class: 'muted' }, 'IQ Weighted Score'), h('strong', {}, r.iq_text)),
    h('div', { class: 'iq-row' }, h('span', { class: 'muted' }, 'IQ Percentage'), h('strong', {}, r.iq_score + '%')),
    h('div', { class: 'iq-row' }, h('span', { class: 'muted' }, 'LALCO IQ Score'), h('strong', { class: 'iq-main' }, r.lalco_iq_score != null ? r.lalco_iq_score + ' / 150' : 'Not available')),
    h('div', { class: 'iq-row' }, h('span', { class: 'muted' }, 'IQ Classification'), r.iq_category ? h('span', { class: 'badge neutral' }, r.iq_category + (r.iq_classification ? ` (${r.iq_classification.range})` : '')) : '-'),
    h('div', { class: 'iq-levels' }, (r.iq_levels || []).map((l) => h('div', { class: 'iq-level' },
      h('div', { class: 'small' }, h('strong', {}, l.label)),
      h('div', {}, l.correct_text + ' correct'),
      h('div', {}, l.marks_text + ' marks')))),
    h('div', { class: 'muted small' }, 'LALCO IQ Score: calculated from the LALCO weighted IQ assessment score on a 50–150 scale (a recruitment score, not a clinical IQ).'));
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const LEVELS = ['Exceptional', 'Very High', 'High', 'Average', 'Low', 'Very Low']; // % levels: General, Calculation, Essay, final score
let IQ_CLASSES = []; // LALCO IQ SCORE CLASSIFICATION rows, from the server
// Dashboard filters. Each looks at the candidate's latest assessment link.
const DASHBOARD_FILTERS = [
  ['all', 'All candidates', () => true],
  ['eligible', 'Eligible', (c) => c.eligibility === 'Eligible'],
  ['not_eligible', 'Not Eligible', (c) => c.eligibility === 'Not Eligible'],
  ['pending', 'Eligibility pending', (c) => c.eligibility === 'Pending'],
  ...['IQ', 'GENERAL', 'CALCULATION'].flatMap((sec) => [
    [sec + '_pass', `${SECTION_LABEL[sec]} Passed`, (c) => testOf(c, sec)?.result === 'Pass'],
    [sec + '_fail', `${SECTION_LABEL[sec]} Not Passed`, (c) => testOf(c, sec)?.result === 'Not Pass']]),
  ['essay_pending', 'Essay Pending HR marking', (c) => testOf(c, 'ESSAY')?.state === 'PENDING HR MARKING'],

  ...LEVELS.map((l) => ['final_' + l, `Final Level: ${l}`, (c) => c.final_level === l]),
];
let dashboardFilter = 'all';
// The filter list with one entry per IQ classification (known once the dashboard data has arrived).
const dashboardFilters = () => {
  const i = DASHBOARD_FILTERS.findIndex(([k]) => k.startsWith('final_'));
  return [...DASHBOARD_FILTERS.slice(0, i), ...IQ_CLASSES.map((c) => ['iq_' + c.description, `IQ Classification: ${c.description} (${c.range})`, (x) => testOf(x, 'IQ')?.level === c.description]), ...DASHBOARD_FILTERS.slice(i)];
};

// One row per candidate: every test's score, %, level and result, then the final result.
function candidateResultsTable(list) {
  if (!list.length) return h('p', { class: 'muted' }, 'No candidates match this filter.');
  const TESTS = ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY'];
  const cols = (sec) => (sec === 'IQ' ? ['Score', 'LALCO IQ', '%', 'IQ Classification', 'Result'] : ['Score', '%', 'Level', 'Result']);
  const cells = (c, sec) => {
    const t = testOf(c, sec);
    const n = cols(sec).length;
    if (!t) return Array.from({ length: n }, (_, i) => h('td', { class: i === 0 ? 'group-start muted' : 'muted' }, '-'));
    return [
      h('td', { class: 'group-start' }, t.score_text || '-'),
      sec === 'IQ' ? h('td', {}, t.lalco_iq_score != null ? h('strong', {}, t.lalco_iq_score + ' / 150') : '-') : null,
      h('td', {}, fmtPct(t.percent)), h('td', {}, fmt(t.level)), h('td', {}, testStateBadge(t.state)),
    ].filter(Boolean);
  };
  return h('div', { class: 'table-wrap' }, h('table', { class: 'results-table' },
    h('thead', {},
      h('tr', {}, h('th', { rowspan: 2 }, 'Candidate'), TESTS.map((sec) => h('th', { class: 'group', colspan: cols(sec).length }, TYPE_LABEL[sec])),
        h('th', { class: 'group', colspan: 3 }, 'Final Assessment'), h('th', { rowspan: 2, class: 'group-start' }, 'HR Final Result')),
      h('tr', {}, TESTS.flatMap((sec) => cols(sec).map((t, i) => h('th', { class: i === 0 ? 'group-start' : null }, t))),
        h('th', { class: 'group-start' }, 'Final %'), h('th', {}, 'Final Level'), h('th', {}, 'Company Eligibility'))),
    h('tbody', {}, list.map((c) => h('tr', { class: 'clickable', onclick: () => { location.hash = '#/candidates/' + c.id; } },
      h('td', {}, h('strong', {}, c.name)),
      TESTS.flatMap((sec) => cells(c, sec)),
      h('td', { class: 'group-start' }, c.final_percent_text || '-'), h('td', {}, fmt(c.final_level)),
      h('td', { title: c.eligibility_note || '' }, eligibilityBadge(c.eligibility)),
      h('td', { class: 'group-start' }, resultBadge(c.final_result || 'Pending')))))));
}

async function renderDashboard() {
  const d = await api('GET', '/dashboard');
  const s = d.summary;
  IQ_CLASSES = d.iq_classification || [];
  const stat = (label, value, sub, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
  const filter = select('dashboard_filter', dashboardFilters().map(([k, label]) => [k, label]), dashboardFilter);
  filter.classList.add('inline-input');
  const tableBox = h('div');
  const count = h('span', { class: 'muted small' });
  const filters = dashboardFilters();
  const draw = () => {
    const f = (filters.find(([k]) => k === dashboardFilter) || filters[0])[2];
    const list = d.candidates.filter(f);
    count.textContent = `${list.length} of ${d.candidates.length} candidates`;
    tableBox.replaceChildren(candidateResultsTable(list));
  };
  filter.addEventListener('change', () => { dashboardFilter = filter.value; draw(); });
  // Clicking a summary card shows those candidates.
  const pick = (key) => () => { dashboardFilter = key; filter.value = key; draw(); };
  const card = (label, value, key, cls) => { const el = stat(label, value, null, cls); el.classList.add('clickable'); el.addEventListener('click', pick(key)); return el; };

  view().replaceChildren(
    h('h1', {}, 'Dashboard'),
    h('div', { class: 'stats' },
      card('Total Candidates', s.total, 'all'),
      card('Eligible', s.eligible, 'eligible', 'highlight'),
      card('Not Eligible', s.not_eligible, 'not_eligible'),
      card('Pending', s.pending, 'pending'),
      stat('Highest LALCO IQ Score', d.highest_iq && d.highest_iq.lalco_iq_score != null ? d.highest_iq.lalco_iq_score + ' / 150' : '-',
        d.highest_iq ? `${d.highest_iq.iq_category} · ${d.highest_iq.iq_text} (${d.highest_iq.iq_score}%) · ${d.highest_iq.name}` : 'No IQ results yet'),
      stat('Completed Assessments', d.completed_assessments),
      stat('Pending Assessments', d.pending_assessments)),
    h('div', { class: 'stat-group-title' }, 'Test results'),
    h('div', { class: 'stats' },
      card('IQ Passed', s.iq_passed, 'IQ_pass'), card('IQ Not Passed', s.iq_not_passed, 'IQ_fail'),
      card('General Passed', s.general_passed, 'GENERAL_pass'), card('General Not Passed', s.general_not_passed, 'GENERAL_fail'),
      card('Calculation Passed', s.calculation_passed, 'CALCULATION_pass'), card('Calculation Not Passed', s.calculation_not_passed, 'CALCULATION_fail'),
      card('Essay Pending', s.essay_pending, 'essay_pending')),
    h('div', { class: 'stat-group-title' }, 'IQ Classification (LALCO IQ Score)'),
    h('div', { class: 'stats' }, IQ_CLASSES.map((c) => card(`${c.description} (${c.range})`, s.iq_levels[c.description] ?? 0, 'iq_' + c.description))),
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, 'Candidates'),
        h('div', { class: 'row' }, filter, count, h('a', { class: 'button small', href: '#/assessments' }, 'Create assessment link'), downloadLink('/export/candidates.xlsx', 'Export all (Excel)'))),
      tableBox,
      h('p', { class: 'muted small' }, 'Each column group is one test of the candidate\'s latest assessment link. General / Calculation / Essay level: 90%+ Exceptional, 80%+ Very High, 70%+ High, 60%+ Average, 50%+ Low, below 50% Very Low. IQ Classification comes from the LALCO IQ Score (see Results). Result uses each test\'s pass mark. Final % = the average of the included tests; Company Eligibility = every test passed and Final % reaches the eligibility mark. HR Final Result is HR\'s own decision.')));
  draw();
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

const PERSONAL_FIELDS = [
  ['name', 'Candidate Name'], ['phone', 'Phone Number'], ['graduate_from', 'Graduate From'], ['high_school', 'High School'],
  ['college', 'College'], ['university', 'University'], ['school_name', 'School Name'], ['subject', 'Subject'], ['gpa', 'GPA / Mark'],
];
const GRADUATE_OPTIONS = ['', 'High School', 'College', 'University', 'Other'];

async function renderCandidates() {
  const search = h('input', { placeholder: 'Search name or phone', class: 'inline-input' });
  const body = h('div');
  const load = async () => {
    const list = await api('GET', '/candidates?q=' + encodeURIComponent(search.value));
    body.replaceChildren(list.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Name', 'Phone', 'Graduate From', 'IQ Test Score', 'Final %', 'Final Level', 'Company Eligibility', 'Interview', 'HR Final Result', 'Added'].map((t) => h('th', {}, t)))),
      h('tbody', {}, list.map((c) => h('tr', { class: 'clickable', onclick: () => { location.hash = '#/candidates/' + c.id; } },
        h('td', {}, c.name), h('td', {}, fmt(c.phone)), h('td', {}, fmt(c.graduate_from)), h('td', {}, c.iq_text ? `${c.iq_text} (${fmtPct(c.iq_score)})` : '-'),
        h('td', {}, c.final_percent_text || '-'), h('td', {}, fmt(c.final_level)), h('td', { title: c.eligibility_note || '' }, eligibilityBadge(c.eligibility)),
        h('td', {}, fmt(c.interview_score)), h('td', {}, resultBadge(c.final_result || 'Pending')), h('td', {}, fmtDate(c.created_at)))))))
      : h('p', { class: 'muted' }, 'No candidates found. Candidates are added automatically when they start an assessment, or you can add one here.'));
  };
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });

  view().replaceChildren(
    h('div', { class: 'row between' }, h('h1', {}, 'Candidates'),
      h('div', { class: 'row' }, search, h('button', { type: 'button', onclick: addCandidate }, 'Add candidate'), downloadLink('/export/candidates.xlsx', 'Export all (Excel)', 'secondary'))),
    h('div', { class: 'card' }, body));
  await load();
}

function addCandidate() {
  const form = h('form', { class: 'grid' },
    PERSONAL_FIELDS.map(([name, label]) => field(label, name === 'graduate_from'
      ? select(name, GRADUATE_OPTIONS.map((o) => [o, o || '-']), '')
      : h('input', { name, required: name === 'name' }))),
    h('div', { class: 'wide' }, h('button', { type: 'submit' }, 'Save candidate')));
  const close = modal('Add candidate', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const c = await api('POST', '/candidates', formValues(form));
      close();
      location.hash = '#/candidates/' + c.id;
    } catch (ex) { flash(form.parentElement, ex.message); }
  });
}

async function renderCandidate(id) {
  const { candidate: c, assessments } = await api('GET', '/candidates/' + id);
  const text = (name, value) => h('input', { name, value: value ?? '' });
  const area = (name, value) => h('textarea', { name }, value ?? '');

  const form = h('form', {},
    h('h2', {}, 'Personal Information'),
    h('div', { class: 'grid' }, PERSONAL_FIELDS.map(([name, label]) => field(label, name === 'graduate_from'
      ? select(name, [...new Set([...GRADUATE_OPTIONS, c.graduate_from])].map((o) => [o, o || '-']), c.graduate_from)
      : text(name, c[name])))),
    h('h2', { class: 'section-gap' }, 'Assessment Results'),
    testsTable(c.tests),
    finalBox(c, c.final_result),
    h('h2', { class: 'section-gap' }, 'IQ Test Details'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'kv' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'IQ Test Result'), h('td', {}, iqResultBlock(c))),
      h('tr', {}, h('th', {}, 'Current Stage'), h('td', {}, fmt(c.current_stage))),
      h('tr', {}, h('th', {}, 'Test Score (all marks)'), h('td', {}, fmtPct(c.test_score)))))),
    h('p', { class: 'muted small' }, 'Scores are percentages of available marks. The IQ Test Score is a test score, not a clinical IQ measurement.'),
    h('div', { class: 'grid' },
      field('Reference Results', area('reference_results', c.reference_results)),
      field('Character', area('character_note', c.character_note))),
    h('h2', { class: 'section-gap' }, 'Interview & Final Decision'),
    h('div', { class: 'grid' },
      field('Interview', text('interview', c.interview)),
      field('Interviewer', text('interviewer', c.interviewer)),
      field('Interview Score (0-100)', h('input', { name: 'interview_score', type: 'number', min: 0, max: 100, step: 'any', value: c.interview_score ?? '' })),
      field('Chairman Interview', text('chairman_interview', c.chairman_interview)),
      field('HR Final Result (HR decision, separate from Company Eligibility)', select('final_result', [['Pending', 'Pending'], ['Pass', 'Pass'], ['Not Pass', 'Not Pass']], c.final_result)),
      field('Date Come to Work', h('input', { name: 'date_come_to_work', type: 'date', value: c.date_come_to_work })),
      field('Remark', area('remark', c.remark), 'wide')),
    h('div', { class: 'row section-gap' }, h('button', { type: 'submit' }, 'Save changes')));

  const card = h('div', { class: 'card' }, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/candidates/' + c.id, formValues(form));
      await renderCandidate(c.id); // redraw so the result badge and scores are current
      flash(view().querySelector('.card'), 'Saved.', 'ok');
    } catch (ex) { flash(card, ex.message); card.scrollIntoView({ behavior: 'smooth' }); }
  });

  const del = async () => {
    if (!confirm(`Delete ${c.name} and all of their assessments? This cannot be undone.`)) return;
    try { await api('DELETE', '/candidates/' + c.id); location.hash = '#/candidates'; } catch (ex) { alert(ex.message); }
  };

  view().replaceChildren(
    h('p', {}, h('a', { href: '#/candidates' }, '< All candidates')),
    h('div', { class: 'row between' }, h('h1', {}, c.name, ' ', eligibilityBadge(c.eligibility)),
      h('div', { class: 'row' },
        downloadLink(`/candidates/${c.id}/export.pdf`, 'PDF'),
        downloadLink(`/candidates/${c.id}/export.docx`, 'Word'),
        downloadLink(`/candidates/${c.id}/export.xlsx`, 'Excel'),
        h('button', { class: 'danger small', type: 'button', onclick: del }, 'Delete'))),
    card,
    h('div', { class: 'card' }, h('h2', {}, 'Assessments'), assessmentTable(assessments, false)));
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

let questionSection = '';
let questionStatus = ''; // '' = all, 'Active', 'Inactive'
let questionLao = ''; // Lao filter
let questionCategory = ''; // category filter: '' = all, 'none', or a category id

// Lao translation state of a question.
const LAO_STATUS = { '': ['English only', 'neutral'], translated: ['Lao ready', 'pass'], reviewed: ['Lao reviewed', 'pass'], needs_review: ['Needs review', 'pending'], failed: ['Failed', 'fail'] };
function laoBadge(status) {
  const [text, cls] = LAO_STATUS[status || ''] || [status, 'neutral'];
  return h('span', { class: 'badge ' + cls }, text);
}

// Edit Lao: the English is shown read-only next to the Lao fields, so the
// source cannot be changed here. The server checks the Lao before it is ready.
function editLao(q, onSaved) {
  const letters = LETTERS.filter((l) => q['option_' + l] || q['option_' + l + '_image']);
  const problemsBox = h('div');
  const status = select('lo_status', [['translated', 'Lao ready (not yet reviewed)'], ['reviewed', 'Lao ready — reviewed by HR'], ['needs_review', 'Needs review (not used in Lao tests)']],
    q.lo_status === 'reviewed' || q.lo_status === 'needs_review' ? q.lo_status : 'translated');
  const pair = (label, en, name, value, big) => h('div', { class: 'lao-pair' },
    h('div', {}, h('div', { class: 'muted small' }, label + ' — English (source)'), h('div', { class: 'pre lao-source' }, en || '-')),
    h('div', {}, h('label', { class: 'muted small', for: 'lo_' + name }, label + ' — Lao'),
      big ? h('textarea', { id: 'lo_' + name, name, lang: 'lo', rows: 4 }, value || '') : h('input', { id: 'lo_' + name, name, lang: 'lo', value: value || '' })));
  const form = h('form', {},
    q.image_id || letters.some((l) => q['option_' + l + '_image']) ? h('p', { class: 'muted small' }, 'The pictures stay the same in both languages. If a picture contains words needed to answer, set "Needs review".') : null,
    pair('Question', q.question_text, 'question_text_lo', q.question_text_lo, true),
    q.section === 'ESSAY' ? null : letters.filter((l) => q['option_' + l]).map((l) => pair('Option ' + l.toUpperCase() + (q.correct_answer === l.toUpperCase() ? ' (correct)' : ''),
      q['option_' + l], 'option_' + l + '_lo', q['option_' + l + '_lo'], false)),
    h('div', { class: 'grid section-gap' }, field('Status', status), field('Note (optional)', h('input', { name: 'lo_note', value: q.lo_note || '' }))),
    h('p', { class: 'muted small' }, 'Numbers, symbols, codes and letter sequences must stay exactly as in English. The correct answer stays the same option. Options that are only pictures need no Lao.'),
    problemsBox,
    h('div', { class: 'row section-gap' }, h('button', { type: 'submit' }, 'Save Lao'), h('button', { type: 'button', class: 'secondary', onclick: () => check() }, 'Check')));
  const close = modal('Lao translation — ' + SECTION_LABEL[q.section] + ' question #' + q.id, form);
  const check = async () => {
    const { problems } = await api('POST', '/questions/' + q.id + '/lao/check', formValues(form));
    problemsBox.replaceChildren(problems.length ? message(problems.join('\n')) : message('No problems found.', 'ok'));
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('PUT', '/questions/' + q.id + '/lao', formValues(form)); close(); onSaved(); } catch (ex) { problemsBox.replaceChildren(message(ex.message)); }
  });
}

// "Translate Missing Lao": starts the background translation and shows progress.
function translateBox(data, reload) {
  const status = h('span', { class: 'muted small' });
  const button = h('button', { type: 'button', class: 'secondary small' }, 'Translate Missing Lao');
  const show = (job) => {
    status.textContent = job && (job.running || job.finished_at)
      ? (job.running ? 'Translating… ' : 'Last run: ') + 'translated ' + job.translated + ', failed ' + job.failed + ', pending ' + Math.max(0, job.total - job.done) + (job.message ? ' — ' + job.message : '')
      : data.translator ? '' : 'No automatic translation service is set up; use "Edit Lao" or Lao columns in an import file.';
  };
  const poll = async () => {
    const r = await api('GET', '/questions/translate-status');
    show(r.job);
    if (r.job.running) setTimeout(poll, 3000); else reload();
  };
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { const r = await api('POST', '/questions/translate-missing'); show(r.job); setTimeout(poll, 2000); } catch (ex) { status.textContent = ex.message; } finally { button.disabled = false; }
  });
  show(data.translate_job);
  if (data.translate_job && data.translate_job.running) setTimeout(poll, 3000);
  return h('div', { class: 'row' }, status, button);
}

const LETTERS = ['a', 'b', 'c', 'd', 'e'];
// Small picture; click to open it full size.
const thumb = (id) => (id ? h('a', { href: '/api/admin/images/' + id, target: '_blank', rel: 'noopener' }, h('img', { src: '/api/admin/images/' + id, alt: '', class: 'thumb' })) : null);

// The text and/or picture of option L ("A".."E") of a question row.
function optionContent(q, L) {
  const l = String(L || '').toLowerCase();
  if (!LETTERS.includes(l)) return fmt(L);
  return h('span', { class: 'answer-choice' }, h('strong', {}, L + '.'), thumb(q['option_' + l + '_image']), q['option_' + l] || null);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Unable to read the picture.'));
    r.readAsDataURL(file);
  });
}

// A picture chooser that uploads immediately and keeps the id in a hidden input.
function imageInput(name, currentId, onError) {
  const hidden = h('input', { type: 'hidden', name, value: currentId || '' });
  const preview = h('span');
  const remove = h('button', { type: 'button', class: 'secondary small' }, 'Remove');
  const show = () => {
    preview.replaceChildren(hidden.value ? thumb(hidden.value) : h('span', { class: 'muted small' }, 'No picture'));
    remove.classList.toggle('hidden', !hidden.value);
  };
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try {
      const { id } = await api('POST', '/images', { data_url: await readAsDataUrl(file.files[0]) });
      hidden.value = id;
      show();
    } catch (ex) { onError(ex.message); }
    file.value = '';
  });
  remove.addEventListener('click', () => { hidden.value = ''; show(); });
  show();
  return h('div', { class: 'image-field' }, hidden, preview, file, remove);
}

async function renderQuestions() {
  const search = h('input', { placeholder: 'Search questions', class: 'inline-input' });
  const statusFilter = select('status_filter', [['', 'Active and inactive'], ['Active', 'Active only'], ['Inactive', 'Inactive only'], ['needs_answer', 'Needs answer (short answer, no correct answer yet)']], questionStatus);
  statusFilter.classList.add('inline-input');
  const laoFilter = select('lao_filter', [['', 'Lao: all'], ['ready', 'Lao ready'], ['reviewed', 'Lao reviewed by HR'], ['none', 'English only (no Lao)'],
    ['needs_review', 'Lao needs review'], ['failed', 'Lao translation failed']], questionLao);
  laoFilter.classList.add('inline-input');
  laoFilter.addEventListener('change', () => { questionLao = laoFilter.value; load(); });
  const categoryFilter = h('select', { class: 'inline-input', name: 'category_filter' });
  categoryFilter.addEventListener('change', () => { questionCategory = categoryFilter.value; load(); });
  const tabs = h('div', { class: 'tabs' });
  const summary = h('p', { class: 'small' });
  const bulkBar = h('div', { class: 'row bulk-bar hidden' });
  const body = h('div');
  const card = h('div', { class: 'card' }, h('div', { class: 'row between' }, tabs, h('div', { class: 'row' }, categoryFilter, statusFilter, laoFilter, search)), summary, bulkBar, body);
  const bankCard = h('div', { class: 'card' });
  statusFilter.addEventListener('change', () => { questionStatus = statusFilter.value; load(); });
  const selected = new Set();

  const load = async () => {
    const data = await api('GET', `/questions?section=${questionSection}&status=${questionStatus}&lao=${questionLao}&category=${questionCategory}&q=${encodeURIComponent(search.value)}`);
    const { questions, counts, inactive_counts: inactive, total_counts: totals, iq_levels: iqLevels } = data;
    const cats = data.categories || [];
    bankCard.replaceChildren(questionBankCard(totals, counts, inactive, iqLevels, load, data));
    // Category filter: the categories of the chosen test (or all, labelled by test).
    const shownCats = cats.filter((c) => !questionSection || c.section === questionSection);
    if (questionCategory && questionCategory !== 'none' && !shownCats.some((c) => String(c.id) === questionCategory)) questionCategory = '';
    categoryFilter.replaceChildren(...[['', 'All categories'], ['none', 'No category (needs category)'],
      ...shownCats.map((c) => [c.id, (questionSection ? '' : SECTION_LABEL[c.section] + ' · ') + c.name + (c.active ? '' : ' (inactive)')])]
      .map(([v, t]) => h('option', { value: v, selected: String(v) === questionCategory }, t)));
    const chosen = cats.find((c) => String(c.id) === questionCategory);
    const shown = questionSection ? [questionSection] : Object.keys(SECTION_LABEL);
    summary.replaceChildren(...(chosen
      ? [h('strong', {}, `Active ${chosen.name} Questions: ${chosen.active_questions}`), `  Inactive ${chosen.name} Questions: ${chosen.inactive_questions}`, chosen.active ? '' : ' · this category is inactive']
      : questionCategory === 'none'
        ? [h('strong', {}, 'Questions without a category: '), shown.map((s) => `${SECTION_LABEL[s]} ${data.no_category?.[s] ?? 0}`).join(' · ')]
        : shown.flatMap((s, i) => [i ? ' · ' : '', h('strong', {}, `Active ${SECTION_LABEL[s]} Questions: ${counts[s]}`), `  Inactive ${SECTION_LABEL[s]} Questions: ${inactive[s]}`,
          data.no_category?.[s] && s === 'IQ' ? h('span', { class: 'badge pending' }, `${data.no_category[s]} need a category`) : null])));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    tabs.replaceChildren(...[['', `All (${total})`], ...Object.keys(SECTION_LABEL).map((s) => [s, `${SECTION_LABEL[s]} (${counts[s]})`])]
      .map(([s, label]) => h('button', { type: 'button', class: s === questionSection ? 'active' : '', onclick: () => { questionSection = s; questionCategory = ''; selected.clear(); load(); } }, label)));

    // Bulk: set / clear the category of the ticked questions (nothing else changes).
    for (const id of [...selected]) if (!questions.some((q) => q.id === id)) selected.delete(id);
    const drawBulk = () => {
      bulkBar.classList.toggle('hidden', selected.size === 0);
      if (!selected.size) return bulkBar.replaceChildren();
      const sections = [...new Set(questions.filter((q) => selected.has(q.id)).map((q) => q.section))];
      const pick = h('select', { class: 'inline-input' }, h('option', { value: '' }, 'Choose a category…'),
        cats.filter((c) => c.active && sections.includes(c.section)).map((c) => h('option', { value: c.id }, (sections.length > 1 ? SECTION_LABEL[c.section] + ' · ' : '') + c.name)));
      const run = async (categoryId) => {
        try {
          const r = await api('POST', '/questions/bulk-category', { ids: [...selected], category_id: categoryId });
          selected.clear();
          await load();
          flash(card, `Category changed for ${r.updated} question${r.updated === 1 ? '' : 's'}.` + (r.skipped ? ` ${r.skipped} skipped (another test type).` : ''), 'ok');
        } catch (ex) { flash(card, ex.message); }
      };
      bulkBar.replaceChildren(h('strong', {}, `${selected.size} selected`), h('span', { class: 'small' }, 'Set category'), pick,
        h('button', { type: 'button', class: 'small', onclick: () => { if (!pick.value) return flash(card, 'Please choose a category.'); run(Number(pick.value)); } }, 'Apply'),
        h('button', { type: 'button', class: 'secondary small', onclick: () => { if (confirm(`Remove the category from ${selected.size} question(s)? The questions themselves are kept.`)) run(null); } }, 'Remove category'),
        h('button', { type: 'button', class: 'secondary small', onclick: () => { selected.clear(); load(); } }, 'Clear selection'));
    };
    const all = h('input', { type: 'checkbox', title: 'Select all shown', checked: questions.length > 0 && questions.every((q) => selected.has(q.id)),
      onchange: (e) => { questions.forEach((q) => (e.target.checked ? selected.add(q.id) : selected.delete(q.id))); load(); } });
    drawBulk();
    body.replaceChildren(questions.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, all), ...['Question (English / Lao)', 'Type', 'Category', 'Level', 'Correct Answer', 'Marks', 'Status', 'Lao', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, questions.map((q) => h('tr', {},
        h('td', {}, h('input', { type: 'checkbox', checked: selected.has(q.id), onchange: (e) => { if (e.target.checked) selected.add(q.id); else selected.delete(q.id); drawBulk(); } })),
        h('td', { class: 'question-cell' }, h('div', { class: 'pre' }, q.question_text), q.question_text_lo ? h('div', { class: 'pre lao-text', lang: 'lo' }, q.question_text_lo) : null,
          q.image_id ? h('div', { class: 'thumb-row' }, thumb(q.image_id)) : null),
        h('td', {}, SECTION_LABEL[q.section]),
        h('td', {}, q.category ? q.category : q.section === 'IQ' ? h('span', { class: 'badge pending' }, 'Needs category') : '-',
          q.category_id && cats.some((c) => c.id === q.category_id && !c.active) ? h('div', { class: 'muted small' }, '(inactive category)') : null),
        h('td', { class: 'nowrap' }, (q.section === 'IQ' && LEVEL_NAMES[q.difficulty]) || fmt(q.difficulty)),
        h('td', {}, q.section === 'ESSAY' ? h('span', { title: q.correct_answer || '' }, q.correct_answer ? 'HR marks (marking guide saved)' : 'HR marks')
          : /^[A-E]$/.test(q.correct_answer) ? optionContent(q, q.correct_answer) : q.correct_answer || h('span', { class: 'badge pending' }, 'Answer required')),
        h('td', { class: 'nowrap' }, q.marks + (q.marks === 1 ? ' mark' : ' marks')),
        h('td', {}, h('span', { class: 'badge ' + (q.status === 'Active' ? 'pass' : 'neutral') }, q.status)),
        h('td', { title: q.lo_note || '' }, laoBadge(q.lo_status), q.lo_note ? h('div', { class: 'muted small lao-note' }, q.lo_note) : null),
        h('td', { class: 'nowrap' },
          h('button', { class: 'secondary small', type: 'button', onclick: () => editQuestion(q, load) }, 'Edit'), ' ',
          h('button', { class: 'secondary small', type: 'button', onclick: () => editLao(q, load) }, 'Edit Lao'), ' ',
          h('button', { class: 'danger small', type: 'button', onclick: async () => {
            if (!confirm('Delete this question? Past results are not affected.')) return;
            try { await api('DELETE', '/questions/' + q.id); load(); } catch (ex) { alert(ex.message); }
          } }, 'Delete')))))))
      : h('p', { class: 'muted' }, 'No questions match. Upload a file or add a question.'));
  };
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });

  view().replaceChildren(
    h('div', { class: 'row between' }, h('h1', {}, 'Questions'),
      h('div', { class: 'row' }, h('a', { class: 'button secondary', href: '#/categories' }, 'Question Categories'),
        h('button', { type: 'button', onclick: () => editQuestion(null, load) }, 'Add question'))),
    bankCard,
    uploadCard(load),
    card);
  await load();
}

// ---------------------------------------------------------------------------
// Question categories: a topic inside one test type. HR adds, renames,
// deactivates / reactivates them; a category in use is never deleted.
// ---------------------------------------------------------------------------

let categorySection = '';

async function renderCategories(id) {
  if (id) return renderCategory(id);
  const search = h('input', { placeholder: 'Search categories', class: 'inline-input' });
  const tabs = h('div', { class: 'tabs' });
  const body = h('div');
  const card = h('div', { class: 'card' }, h('div', { class: 'row between' }, tabs, search), body);
  const load = async () => {
    const list = await api('GET', `/categories?section=${categorySection}&q=${encodeURIComponent(search.value)}`);
    tabs.replaceChildren(...[['', 'All'], ...Object.keys(SECTION_LABEL).map((s) => [s, SECTION_LABEL[s]])]
      .map(([s, label]) => h('button', { type: 'button', class: s === categorySection ? 'active' : '', onclick: () => { categorySection = s; load(); } }, label)));
    const table = (rows) => h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Category', 'Lao name', 'Test Type', 'Active Questions', 'Inactive Questions', 'Status', 'Actions'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((c) => h('tr', {},
        h('td', {}, h('a', { href: '#/categories/' + c.id }, h('strong', {}, c.name))),
        h('td', { lang: 'lo', class: 'lao-text' }, c.name_lo || '-'),
        h('td', {}, SECTION_LABEL[c.section]), h('td', {}, c.active_questions), h('td', {}, c.inactive_questions),
        h('td', {}, h('span', { class: 'badge ' + (c.active ? 'pass' : 'neutral') }, c.active ? 'Active' : 'Inactive')),
        h('td', { class: 'nowrap' },
          h('button', { type: 'button', class: 'secondary small', onclick: () => editCategory(c, load) }, 'Edit'), ' ',
          c.active
            ? h('button', { type: 'button', class: 'danger small', onclick: () => removeCategory(c, load) }, c.questions ? 'Deactivate' : 'Remove')
            : h('button', { type: 'button', class: 'secondary small', onclick: async () => { await api('POST', `/categories/${c.id}/activate`); load(); } }, 'Reactivate')))))));
    const active = list.filter((c) => c.active);
    const inactive = list.filter((c) => !c.active);
    body.replaceChildren(
      active.length ? table(active) : h('p', { class: 'muted' }, 'No active categories.'),
      inactive.length ? h('div', {}, h('h2', { class: 'section-gap' }, 'Inactive Categories'), table(inactive)) : null);
  };
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  view().replaceChildren(
    h('p', {}, h('a', { href: '#/questions' }, '< Questions')),
    h('div', { class: 'row between' }, h('h1', {}, 'Question Categories'), h('button', { type: 'button', onclick: () => editCategory(null, load) }, '+ Add Category')),
    h('p', { class: 'muted small' }, 'A category is a topic inside one test (e.g. IQ → Number Patterns). It is separate from the IQ level (1–5), is not shown to candidates, and does not change marks, scoring or the random draw.'),
    card);
  await load();
}

function editCategory(c, onSaved) {
  const form = h('form', { class: 'grid' },
    field('Test Type', c ? h('input', { value: SECTION_LABEL[c.section], disabled: true }) : select('section', Object.entries(SECTION_LABEL), categorySection || 'IQ')),
    field('Category Name', h('input', { name: 'name', value: c ? c.name : '', required: true, maxlength: 100 })),
    field('Lao name (optional)', h('input', { name: 'name_lo', lang: 'lo', value: c ? c.name_lo : '', maxlength: 100 })),
    c && c.questions ? h('p', { class: 'muted small wide' }, `Renaming changes the category name of its ${c.questions} question(s). Past candidate results are not affected.`) : null,
    h('div', { class: 'wide' }, h('button', { type: 'submit' }, 'Save Category')));
  const close = modal(c ? 'Edit category' : 'Add category', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (c) await api('PUT', '/categories/' + c.id, formValues(form));
      else await api('POST', '/categories', formValues(form));
      close();
      onSaved();
    } catch (ex) { flash(form.parentElement, ex.message); }
  });
}

function removeCategory(c, onDone) {
  const text = c.questions
    ? `This category is currently used by ${c.questions} question${c.questions === 1 ? '' : 's'}. It will be deactivated, not permanently deleted. The questions keep it, but it can no longer be chosen for new questions.`
    : 'This category has no questions. It will be removed.';
  const box = h('div', {}, h('p', {}, text),
    h('div', { class: 'row section-gap' }, h('button', { type: 'button', class: 'secondary', onclick: () => close() }, 'Cancel'),
      h('button', { type: 'button', class: 'danger', onclick: async () => { try { await api('DELETE', '/categories/' + c.id); close(); onDone(); } catch (ex) { flash(box, ex.message); } } },
        c.questions ? 'Deactivate' : 'Remove')));
  const close = modal(`${c.questions ? 'Deactivate' : 'Remove'} "${c.name}"?`, box);
}

async function renderCategory(id) {
  const { category: c, questions } = await api('GET', '/categories/' + id);
  view().replaceChildren(
    h('p', {}, h('a', { href: '#/categories' }, '< Question Categories')),
    h('div', { class: 'row between' }, h('h1', {}, `${SECTION_LABEL[c.section]} → ${c.name}`, ' ', h('span', { class: 'badge ' + (c.active ? 'pass' : 'neutral') }, c.active ? 'Active' : 'Inactive')),
      h('button', { type: 'button', class: 'secondary', onclick: () => editCategory(c, () => renderCategory(id)) }, 'Edit')),
    h('div', { class: 'card' },
      h('p', {}, h('strong', {}, 'Lao name: '), h('span', { lang: 'lo', class: 'lao-text' }, c.name_lo || '-'), ' · ', h('strong', {}, 'Active: '), c.active_questions, ' · ', h('strong', {}, 'Inactive: '), c.inactive_questions),
      questions.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['#', 'Question', 'Level', 'Status'].map((t) => h('th', {}, t)))),
        h('tbody', {}, questions.map((q) => h('tr', {}, h('td', {}, 'Q' + q.id), h('td', { class: 'question-cell' }, h('div', { class: 'pre' }, q.question_text)),
          h('td', { class: 'nowrap' }, (q.section === 'IQ' && LEVEL_NAMES[q.difficulty]) || fmt(q.difficulty)), h('td', {}, h('span', { class: 'badge ' + (q.status === 'Active' ? 'pass' : 'neutral') }, q.status)))))))
        : h('p', { class: 'muted' }, 'No questions in this category yet.')));
}

// QUESTION BANK: one row per test area with its count, Upload and Delete All Questions.
function questionBankCard(totals, active, inactive, iqLevels, reload, data = {}) {
  const laoCounts = data.lao_counts || {};
  const rows = Object.keys(SECTION_LABEL).map((sec) => {
    const total = totals[sec] || 0;
    const upload = () => {
      const pick = $('upload-section');
      if (pick) pick.value = sec;
      $('upload-card')?.scrollIntoView({ behavior: 'smooth' });
    };
    return h('div', { class: 'bank-row' },
      h('div', { class: 'bank-name' }, h('strong', {}, TYPE_LABEL[sec]), ' — ', h('span', { class: 'bank-count' }, `${total} question${total === 1 ? '' : 's'}`),
        h('div', { class: 'muted small' }, `Active ${active[sec] || 0} · Inactive ${inactive[sec] || 0} · Lao ready ${laoCounts[sec]?.ready || 0} of ${laoCounts[sec]?.total || 0}` +
          (laoCounts[sec]?.needs_review ? ` · Lao needs review ${laoCounts[sec].needs_review}` : '') + (laoCounts[sec]?.failed ? ` · Lao failed ${laoCounts[sec].failed}` : ''),
          sec === 'IQ' ? ' · ' + IQ_LEVELS.map((n) => `L${n}: ${iqLevels?.[Object.keys(LEVEL_MARK)[n - 1]] ?? 0}`).join(' / ') : '')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'secondary small', onclick: upload }, 'Upload'),
        h('button', { type: 'button', class: 'danger small', disabled: total === 0, onclick: () => confirmDeleteAll(sec, total, reload) }, 'Delete All Questions')));
  });
  return h('div', {}, h('div', { class: 'row between' }, h('h2', {}, 'Question Bank'), translateBox(data, reload)), rows,
    h('p', { class: 'muted small' }, 'Delete All Questions clears only that test area (active and inactive). Candidates\' past assessments keep their own copy of every question, so their answers, scores and reports do not change.'));
}

// Two clear confirmations, then the server deletes that one test area.
function confirmDeleteAll(sec, total, reload) {
  const name = SECTION_LABEL[sec];
  const step1 = h('div', {},
    h('p', {}, `This will permanently remove all ${name} questions from the question bank.`),
    h('p', {}, 'Historical candidate assessment results will not be affected.'),
    h('div', { class: 'row section-gap' },
      h('button', { type: 'button', class: 'secondary', onclick: () => close1() }, 'Cancel'),
      h('button', { type: 'button', class: 'danger', onclick: () => { close1(); step2(); } }, 'Delete All Questions')));
  const close1 = modal(`Delete All ${name} Questions?`, step1);
  function step2() {
    const yes = h('button', { type: 'button', class: 'danger' }, 'Yes, Delete All');
    const box = h('div', {},
      h('p', {}, h('strong', {}, `Are you sure you want to delete ALL ${total} ${name} question${total === 1 ? '' : 's'}?`)),
      h('p', {}, 'This action cannot be undone.'),
      h('div', { class: 'row section-gap' }, h('button', { type: 'button', class: 'secondary', onclick: () => close2() }, 'Cancel'), yes));
    const close2 = modal('Please confirm', box);
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      try {
        const r = await api('POST', '/questions/delete-all', { section: sec });
        close2();
        await reload();
        const view = document.querySelector('#view .card');
        if (view) flash(view, `All ${name} questions deleted successfully.\n${r.deletedCount} question${r.deletedCount === 1 ? '' : 's'} removed.\nHistorical assessment results were preserved.`, 'ok');
      } catch {
        yes.disabled = false;
        flash(box, 'Questions were not deleted.\nPlease try again or check the server logs.');
      }
    });
  }
}

function uploadCard(onImported) {
  const fileInput = h('input', { type: 'file', class: 'inline-input', accept: '.xlsx,.xls,.docx,.doc,.pdf,.csv,.tsv,.txt' });
  const section = select('section', Object.entries(SECTION_LABEL).map(([k, v]) => [k, v + ' questions']), questionSection || 'IQ');
  section.id = 'upload-section';
  section.classList.add('inline-input');
  const result = h('div');
  const button = h('button', { type: 'button' }, 'Read file');
  const card = h('div', { class: 'card', id: 'upload-card' },
    h('h2', {}, 'Upload questions'),
    h('p', { class: 'muted small' },
      'Excel, Word, PDF, CSV, TSV or TXT. Either a table with columns such as Question, Option A-D, Correct Answer (optional: Type, Category, Level, Marks), or numbered questions (1. / Q1) with options A-D and the answer as an "Answer: B" line or in an Answer Key section at the end. Essay questions need no options. ',
      h('a', { href: '/api/admin/questions/template.xlsx' }, 'Download Excel template')),
    h('div', { class: 'row' }, fileInput, h('span', { class: 'muted small' }, 'If the file has no Type column, questions are added as:'), section, button),
    result);

  button.addEventListener('click', async () => {
    if (!fileInput.files[0]) return flash(result, 'Please choose a file.');
    const data = new FormData();
    data.append('section', section.value);
    data.append('file', fileInput.files[0]);
    button.disabled = true;
    result.replaceChildren(h('p', { class: 'muted' }, 'Reading file... A PDF made of pictures (scanned pages) is read with OCR and can take 1-2 minutes.'));
    try {
      const preview = await api('POST', '/questions/import/preview', data, true);
      showPreview(result, preview, () => { fileInput.value = ''; onImported(); });
    } catch (ex) {
      result.replaceChildren(message(ex.message));
    } finally { button.disabled = false; }
  });
  return card;
}

function showPreview(container, p, onDone) {
  const valid = p.rows.filter((r) => r.errors.length === 0).map((r) => r.question);
  const invalid = p.rows.filter((r) => r.errors.length > 0);
  const importBtn = h('button', { type: 'button', disabled: valid.length === 0 }, `Import ${valid.length} questions`);
  // Document analysis: one line per section that holds questions (tick = import, and as which test);
  // interview notes, scoring guides and other text are shown but never imported.
  const questionSections = (p.sections || []).filter((x) => x.kind === 'questions' && x.valid > 0);
  const picks = Object.fromEntries(questionSections.map((x) => [x.key, {
    on: h('input', { type: 'checkbox', checked: true, onchange: () => updateCount() }),
    as: select('import_as_' + x.key, Object.entries(SECTION_LABEL), x.section) }]));
  const chosen = () => p.rows.filter((r) => r.errors.length === 0 && (!picks[r.section_key] || picks[r.section_key].on.checked))
    .map((r) => ({ ...r.question, section: picks[r.section_key] ? picks[r.section_key].as.value : r.question.section }));
  const updateCount = () => { const n = chosen().length; importBtn.textContent = `Import ${n} questions`; importBtn.disabled = n === 0; };
  const notImported = (p.sections || []).filter((x) => x.kind !== 'questions');
  const sum = (kind) => notImported.filter((x) => x.kind === kind).reduce((a, x) => a + x.lines, 0);
  const sectionsBox = questionSections.length && ((p.sections || []).length > 1 || p.type_mismatch) ? h('div', { class: 'card inner' }, h('h2', {}, 'Document analysis'),
    p.type_mismatch ? message(p.type_mismatch) : null,
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Import', 'Section', 'Detected', 'Questions', 'Answer required', 'Import as'].map((t) => h('th', {}, t)))),
      h('tbody', {}, questionSections.map((x) => h('tr', {}, h('td', {}, picks[x.key].on), h('td', {}, x.title || '-', x.level ? h('div', { class: 'muted small' }, x.level) : null),
        h('td', {}, SECTION_LABEL[x.section] + (x.section === 'CALCULATION' && x.answer_required ? ' (short answer)' : ''), x.section !== p.test_type ? h('div', {}, h('span', { class: 'badge pending' }, 'differs from the selected type')) : null),
        h('td', {}, x.valid), h('td', {}, x.answer_required || '-'), h('td', {}, picks[x.key].as)))))),
    notImported.length ? h('p', { class: 'muted small' }, 'Not imported: ' + [sum('interview') ? `interview material (${sum('interview')} lines)` : null, sum('scoring') ? `scoring guides (${sum('scoring')} lines)` : null,
      sum('other') ? `other text — memo, instructions, policy, tables (${sum('other')} lines)` : null].filter(Boolean).join(' · ') + '.') : null) : null;
  Object.values(picks).forEach((x) => x.as.addEventListener('change', updateCount));
  // One choice per category name that is not in the list: create it, or use an existing one.
  const decisionSelects = (p.category_decisions || []).map((d) => ({ d, el: h('select', { class: 'inline-input' },
    h('option', { value: '' }, 'Choose…'), d.inactive ? null : h('option', { value: 'create' }, `Create category "${d.name}"`),
    (p.categories || []).filter((c) => c.section === d.section).map((c) => h('option', { value: 'use:' + c.id }, `Use existing: ${c.name}`))) }));
  const decisionBox = decisionSelects.length ? h('div', { class: 'message error' }, h('strong', {}, 'Categories to decide before importing'), h('br'),
    decisionSelects.map(({ d, el }) => h('div', { class: 'row small section-gap-sm' }, `Category "${d.name}" ${d.inactive ? 'is inactive' : 'does not exist'} for ${SECTION_LABEL[d.section]} (${d.count} question${d.count === 1 ? '' : 's'}):`, el))) : null;
  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true;
    try {
      const category_decisions = {};
      for (const { d, el } of decisionSelects) {
        if (!el.value) { importBtn.disabled = false; return flash(container, `Please choose what to do with the category "${d.name}" (or press Cancel).`); }
        category_decisions[d.key] = el.value === 'create' ? { create: true } : { category_id: Number(el.value.slice(4)) };
      }
      const r = await api('POST', '/questions/import', { questions: chosen(), category_decisions });
      container.replaceChildren(message(`Imported ${r.imported} questions.` + (r.skipped ? ` Skipped ${r.skipped}.` : '')
        + (r.answer_required ? ` ${r.answer_required} short-answer question(s) are Inactive until you enter the correct answer (Questions → status "Needs answer" → Edit).` : ''), 'ok'));
      onDone();
    } catch (ex) { flash(container, ex.message); importBtn.disabled = false; }
  });
  const validRows = p.rows.filter((r) => r.errors.length === 0);
  container.replaceChildren(h('div', {}, // h() skips the null sections; replaceChildren would print "null"
    h('h2', {}, 'Import Preview'),
    h('p', { class: 'small' }, h('strong', {}, 'Test Type: '), SECTION_LABEL[p.test_type] || '-', ' · ', h('strong', {}, 'File: '), p.file || '-',
      p.format ? [' · ', h('strong', {}, 'Detected format: '), p.format] : null, p.answer_key ? [' · ', h('strong', {}, 'Answer key entries: '), p.answer_key] : null),
    h('div', { class: 'stats' },
      ...[['Found', p.found], ['Valid', p.valid], ['Invalid', p.invalid], ['Duplicates', p.duplicates ?? 0], ['Answer Conflicts', p.conflicts ?? 0]].map(([l, v]) => h('div', { class: 'stat' }, h('div', { class: 'label' }, l), h('div', { class: 'value' }, v))),
      ...Object.entries(p.by_section).filter(([, n]) => n > 0).map(([s, n]) => h('div', { class: 'stat' }, h('div', { class: 'label' }, SECTION_LABEL[s] + ' questions'), h('div', { class: 'value' }, n)))),
    sectionsBox,
    decisionBox,
    p.answer_required ? h('p', { class: 'message pending-note' }, `${p.answer_required} short-answer question(s) have no correct answer in the file. They will be imported as "Answer required" (Inactive) and cannot be used in a test until HR enters the answer. Answers are never guessed.`) : null,
    p.missing_category ? h('p', { class: 'muted small' }, `${p.missing_category} question(s) have no category (IQ ones are listed under "Needs category" after importing; set it with Set category).`) : null,
    invalid.length ? h('div', {}, h('h2', {}, 'Rows that will be skipped'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Question'), h('th', {}, 'Text'), h('th', {}, 'Problem'))),
      h('tbody', {}, invalid.slice(0, 100).map((r) => h('tr', {}, h('td', {}, r.number != null ? r.number : 'Row ' + r.row), h('td', { class: 'question-cell' }, fmt(r.question.question_text).slice(0, 160)), h('td', {}, r.errors.join(' ')))))))) : null,
    valid.length ? h('div', {}, h('h2', { class: 'section-gap' }, validRows.length > 100 ? 'First 100 questions to import' : 'Questions to import'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['#', 'Status', 'Question', 'Type', 'Category', 'Level', 'Options', 'Correct Answer', 'Marks'].map((t) => h('th', {}, t)))),
      h('tbody', {}, validRows.slice(0, 100).map((r) => [r, r.question]).map(([r, q]) => h('tr', {},
        h('td', {}, r.number != null ? r.number : r.row),
        h('td', {}, r.answer_required ? h('span', { class: 'badge pending' }, 'VALID — ANSWER REQUIRED') : h('span', { class: 'badge pass' }, 'VALID')),
        h('td', { class: 'question-cell' }, h('div', { class: 'pre' }, q.question_text), q.image_id ? h('div', { class: 'thumb-row' }, thumb(q.image_id)) : null),
        h('td', {}, SECTION_LABEL[q.section]),
        h('td', {}, q.category || null, r.category_state === 'missing' ? h('span', { class: 'badge pending' }, q.section === 'IQ' ? 'Missing — Review Required' : 'None')
          : r.category_state === 'unknown' ? h('div', {}, h('span', { class: 'badge pending' }, 'Not in the list')) : r.category_state === 'inactive' ? h('div', {}, h('span', { class: 'badge pending' }, 'Inactive')) : null),
        h('td', { class: 'nowrap' }, (q.section === 'IQ' && LEVEL_NAMES[q.difficulty]) || fmt(q.difficulty)),
        h('td', { class: 'small' }, h('div', { class: 'thumb-row' }, LETTERS.filter((l) => q['option_' + l] || q['option_' + l + '_image'])
          .map((l) => optionContent(q, l.toUpperCase())))),
        h('td', { class: 'small' }, q.section === 'ESSAY' ? (q.correct_answer ? h('div', {}, h('div', { class: 'muted' }, 'Marking guide (HR only):'), h('div', { class: 'pre' }, q.correct_answer)) : 'HR marks') : q.correct_answer || (r.answer_required ? 'Missing — Review Required' : '-')), h('td', {}, q.marks))))))) : null,
    h('div', { class: 'row section-gap' }, importBtn, h('button', { class: 'secondary', type: 'button', onclick: () => container.replaceChildren() }, 'Cancel'))));
}

function editQuestion(q, onSaved) {
  q = q || { section: questionSection || 'IQ', marks: 1, status: 'Active', difficulty: 'Medium' };
  let showError = () => {};
  const known = ['Easy', 'Basic', 'Moderate', 'Difficult', 'Very Difficult'];
  const levelSelect = select('difficulty', [['', '-'], ...known.map((k) => [k, LEVEL_NAMES[k]]), ...(q.difficulty && !known.includes(q.difficulty) ? [[q.difficulty, q.difficulty]] : [])], q.difficulty || '');
  const marksInput = h('input', { name: 'marks', type: 'number', min: 0.5, max: 100, step: 0.5, value: q.marks });
  // Only ACTIVE categories of the chosen test type (plus this question's own, even if now inactive).
  const categorySelect = h('select', { name: 'category_id' });
  let allCategories = [];
  const fillCategories = () => {
    const sec = form.elements.section.value;
    const keep = categorySelect.value || (q.section === sec && q.category_id ? String(q.category_id) : '');
    const opts = allCategories.filter((c) => c.section === sec && (c.active || c.id === q.category_id));
    categorySelect.replaceChildren(h('option', { value: '' }, sec === 'IQ' ? 'Choose a category…' : 'No category'), ...opts.map((c) => h('option', { value: c.id, selected: String(c.id) === keep }, c.name + (c.active ? '' : ' (inactive)'))));
  };
  // IQ questions: marks come from the level (1-5) and cannot be typed.
  const syncMarks = () => {
    const isIq = form.elements.section.value === 'IQ';
    marksInput.disabled = isIq;
    if (isIq) { if (!LEVEL_MARK[levelSelect.value]) levelSelect.value = 'Moderate'; marksInput.value = LEVEL_MARK[levelSelect.value]; }
  };
  const form = h('form', { class: 'grid' },
    field('Type', select('section', Object.entries(SECTION_LABEL), q.section)),
    field('Category', categorySelect),
    field('Level', levelSelect),
    field('Marks', marksInput),
    field('Question', h('textarea', { name: 'question_text', required: true }, q.question_text || ''), 'wide'),
    h('div', { class: 'field wide' }, h('label', {}, 'Question picture (optional)'), imageInput('image_id', q.image_id, (m) => showError(m))),
    LETTERS.map((l) => h('div', { class: 'field' },
      h('label', { for: 'opt_' + l }, 'Option ' + l.toUpperCase() + (l === 'e' ? ' (optional)' : '')),
      h('input', { id: 'opt_' + l, name: 'option_' + l, value: q['option_' + l] || '', placeholder: 'Text, a picture, or both' }),
      imageInput('option_' + l + '_image', q['option_' + l + '_image'], (m) => showError(m)))),
    field('Correct Answer', h('input', { name: 'correct_answer', value: q.correct_answer || '', placeholder: 'A, B, C, D or E (or the exact answer for calculation)' }), 'wide'),
    q.id ? field('Status', select('status', [['Active', 'Active'], ['Inactive', 'Inactive (not used in new tests)']], q.status)) : null,
    h('p', { class: 'muted small wide' }, 'Each option can be text, a picture, or both. Essay questions need no options; HR marks the answer after submission. Calculation questions may have options or a single exact answer.'),
    h('div', { class: 'wide' }, h('button', { type: 'submit' }, 'Save question')));
  const close = modal(q.id ? 'Edit question' : 'Add question', form);
  showError = (m) => flash(form.parentElement, m);
  form.elements.section.addEventListener('change', () => { syncMarks(); fillCategories(); });
  api('GET', '/categories').then((list) => { allCategories = list; fillCategories(); }).catch(() => {});
  levelSelect.addEventListener('change', syncMarks);
  syncMarks();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.elements.section.value === 'IQ' && !categorySelect.value) return flash(form.parentElement, 'Please choose a category (every IQ question needs one). Add new categories on the Question Categories page.');
    try {
      if (q.id) await api('PUT', '/questions/' + q.id, formValues(form));
      else await api('POST', '/questions', formValues(form));
      close();
      onSaved();
    } catch (ex) { flash(form.parentElement, ex.message); }
  });
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

// The LALCO IQ test has 18 questions unless HR chooses otherwise.
const IQ_DEFAULT = 18;
// Settings holding each test's default pass mark.
const PASS_SETTING = { IQ: 'pass_iq', GENERAL: 'pass_general', CALCULATION: 'pass_calculation', ESSAY: 'pass_essay' };

const EXPIRY_CHOICES = [[10, '10 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [1440, '1 day'], [4320, '3 days'], [10080, '7 days'], ['custom', 'Custom (minutes)']];

async function renderAssessments() {
  const [settings, questionData, laoData, list] = await Promise.all([
    api('GET', '/settings'), api('GET', '/questions/counts'), api('GET', '/questions/counts?language=lo'), api('GET', '/assessments')]);
  const counts = questionData;

  // One link holds all chosen tests, always in this order: IQ -> General -> Calculation -> Essay.
  const TESTS = ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY'];
  const DEFAULT_COUNT = { IQ: IQ_DEFAULT, GENERAL: 10, CALCULATION: 10, ESSAY: 1 };
  const testsBox = h('div', { class: 'wide tests-box' },
    h('label', {}, 'Tests Included (taken one by one in this order; the candidate must pass each test to continue)'),
    TESTS.map((sec, i) => {
      const has = counts[sec] > 0;
      const check = h('input', { type: 'checkbox', name: 'test_' + sec, checked: has, disabled: !has });
      const count = h('input', { name: 'count_' + sec, type: 'number', min: 1, max: counts[sec], value: Math.min(counts[sec], DEFAULT_COUNT[sec]) || '', class: 'inline-input small-num', disabled: !has });
      const minutes = h('input', { name: 'minutes_' + sec, type: 'number', min: 1, max: 600, value: settings.default_time_minutes, class: 'inline-input small-num', disabled: !has });
      const pass = h('input', { name: 'pass_' + sec, type: 'number', min: 0, max: 100, step: 'any', value: settings[PASS_SETTING[sec]], class: 'inline-input small-num', disabled: !has });
      const quick = sec === 'IQ' && has ? h('span', { class: 'small' }, ' Quick: ', [10, 15, 18, 20, 30].map((n) =>
        h('button', { type: 'button', class: 'secondary small', disabled: n > counts[sec], onclick: () => { count.value = n; } }, String(n)))) : null;
      return h('div', { class: 'test-row' },
        h('label', { class: 'test-name' }, check, ` ${i + 1}. ${TYPE_LABEL[sec]}`),
        has ? h('span', { class: 'row small' }, count, h('span', {}, 'questions'), minutes, h('span', {}, 'minutes ·'), h('span', {}, 'pass at'), pass, h('span', {}, '%'), quick,
          h('span', { class: 'muted' }, `(bank has ${counts[sec]}; Lao ready ${laoData[sec]})`))
          : h('span', { class: 'muted small' }, 'No active questions in the bank yet'));
    }));

  const expirySelect = select('expiry_choice', EXPIRY_CHOICES, EXPIRY_CHOICES.some(([v]) => v === settings.default_link_expiry_minutes) ? settings.default_link_expiry_minutes : 'custom');
  const customExpiry = h('input', { name: 'expiry_custom', type: 'number', min: 1, value: settings.default_link_expiry_minutes });
  const customField = field('Custom expiry (minutes)', customExpiry);
  const syncExpiry = () => customField.classList.toggle('hidden', expirySelect.value !== 'custom');
  expirySelect.addEventListener('change', syncExpiry);
  syncExpiry();

  const output = h('div');
  const form = h('form', { class: 'grid' },
    field('Link name (optional, e.g. September Recruitment)', h('input', { name: 'title', maxlength: 200 })),
    field('Language (Lao: questions are shown in Lao; only Lao-ready questions are used)', select('language', Object.entries(LANG_LABEL), settings.default_language)),
    field('Link expires in', expirySelect),
    customField,
    testsBox,
    field('Final eligibility mark (%): every test passed AND final score at least', h('input', { name: 'eligibility_mark', type: 'number', min: 0, max: 100, step: 'any', value: settings.final_eligibility })),
    h('p', { class: 'muted small wide' }, 'ONE link for MANY candidates: share the same link with everyone. Each person who opens it gets their own session (their own details, questions, timers, answers and results); a refresh or reopening the link in the same browser continues their own attempt. The candidate enters their details once, then takes the tests in order. Each test has its own timer and its own pass mark (defaults in Settings); if a test is not passed the assessment stops and the later tests stay locked. Final score = the average of the included tests. Questions are random for each candidate and answers are shuffled. IQ: Level 1 → 5, split evenly (18 questions = 4 / 3 / 3 / 4 / 4, maximum 55 marks; 20 = 4 each, maximum 60).'),
    h('div', { class: 'wide' }, h('button', { type: 'submit' }, 'Generate ONE Assessment Link')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    const tests = TESTS.filter((sec) => v['test_' + sec]);
    const body = {
      title: v.title,
      tests,
      language: v.language,
      link_expiry_minutes: Number(v.expiry_choice === 'custom' ? v.expiry_custom : v.expiry_choice),
      counts: Object.fromEntries(tests.map((sec) => [sec, Number(v['count_' + sec] || 0)])),
      minutes: Object.fromEntries(tests.map((sec) => [sec, Number(v['minutes_' + sec] || 0)])),
      pass_marks: Object.fromEntries(tests.map((sec) => [sec, v['pass_' + sec]])),
      eligibility_mark: v.eligibility_mark,
    };
    if (!tests.length) return output.replaceChildren(message('Please tick at least one test.'));
    try {
      const a = await api('POST', '/assessments', body);
      const url = examUrl(a.token);
      const input = h('input', { value: url, readonly: true });
      const copy = h('button', { type: 'button', onclick: () => copyText(url, copy) }, 'Copy Link');
      output.replaceChildren(h('div', { class: 'message ok' },
        h('strong', {}, 'Shared Assessment Link Created' + (a.title ? ` — ${a.title}` : '')), h('br'),
        'Send this ONE link to every candidate. Each person gets their own session and result.', h('br'),
        `Tests: ${a.stages.map((st) => `${TYPE_LABEL[st.section]} (pass ${st.pass_mark}%)`).join(' → ')}`, h('br'),
        `Company eligibility: every test passed and final score at least ${a.eligibility_mark}%`, h('br'),
        `New candidates can start until ${fmtDateTime(a.link_expires_at)}.`),
        h('div', { class: 'link-box' }, input, copy));
      input.select();
      refreshList();
    } catch (ex) { output.replaceChildren(message(ex.message)); }
  });

  const listBox = h('div', {}, assessmentTable(list, true));
  const refreshList = async () => listBox.replaceChildren(assessmentTable(await api('GET', '/assessments'), true));

  view().replaceChildren(
    h('h1', {}, 'Assessments'),
    h('div', { class: 'card' }, h('h2', {}, 'Create Assessment'), form, output),
    h('div', { class: 'card' }, h('h2', {}, 'Assessment Links'), listBox));
}

// "✓ IQ → ✗ General → ○ Calculation" for the admin tables.
// "69.4% PASS" / "Pending HR marking" / "-" for one test of a candidate.
function testCell(c, sec) {
  const t = (c.tests || []).find((x) => x.section === sec);
  if (!t) return '-';
  const cls = t.result === 'Pass' ? 'pass' : t.result === 'Not Pass' ? 'fail' : t.result === 'Pending' ? 'pending' : 'neutral';
  return h('span', { class: 'badge ' + cls }, t.text);
}

// Test | Score | % | Level | Result | Status | Pass mark, one row per test of the link.
function testsTable(tests) {
  if (!tests || !tests.length) return h('p', { class: 'muted' }, 'No assessment started yet.');
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Test', 'Score', '%', 'Level', 'Result', 'Status', 'Pass Mark'].map((t) => h('th', {}, t)))),
    h('tbody', {}, tests.map((t) => h('tr', {},
      h('td', {}, h('strong', {}, t.name)),
      h('td', {}, t.score_text || '-', t.lalco_iq_score != null ? h('div', { class: 'small' }, 'LALCO IQ Score ', h('strong', {}, t.lalco_iq_score + ' / 150')) : null),
      h('td', {}, fmtPct(t.percent)),
      h('td', {}, t.level ? h('span', { class: 'badge neutral' }, (t.section === 'IQ' ? 'IQ Classification: ' : '') + t.level) : '-'),
      h('td', {}, t.result === 'Pass' || t.result === 'Not Pass' ? resultBadge(t.result) : testStateBadge(t.state)),
      h('td', {}, t.completion || '-'),
      h('td', {}, t.pass_mark != null ? t.pass_mark + '%' : '-'))))));
}

// FINAL OVERALL SCORE, FINAL LEVEL and COMPANY ELIGIBILITY, with HR's own decision shown apart.
function finalBox(f, hrResult) {
  return h('div', { class: 'final-box section-gap' },
    h('div', { class: 'final-row' }, h('span', { class: 'muted' }, 'Final Overall Score'), h('strong', {}, f.final_percent_text || '-')),
    h('div', { class: 'final-row' }, h('span', { class: 'muted' }, 'Final Level'), h('strong', {}, fmt(f.final_level))),
    h('div', { class: 'final-row' }, h('span', { class: 'muted' }, 'Company Eligibility'), eligibilityBadge(f.eligibility)),
    f.eligibility_note ? h('div', { class: 'muted small' }, f.eligibility_note + (f.eligibility_mark != null ? ` (eligibility mark ${f.eligibility_mark}%)` : '')) : null,
    hrResult !== undefined ? h('div', { class: 'final-row' }, h('span', { class: 'muted' }, 'HR Final Result'), resultBadge(hrResult || 'Pending')) : null,
    h('div', { class: 'muted small' }, 'Final % = the average of the included tests. Eligible = every test passed and Final % reaches the eligibility mark. HR Final Result is HR\'s own decision.'));
}

function testsChain(stages) {
  return (stages || []).map((st) => {
    const mark = st.status === 'IN_PROGRESS' ? '▶ ' : st.status !== 'SUBMITTED' ? '○ ' : st.result === 'Pass' ? '✓ ' : st.result === 'Not Pass' ? '✗ ' : '… ';
    return mark + SECTION_LABEL[st.section];
  }).join(' → ');
}

function assessmentTable(list, showCandidate) {
  if (!list.length) return h('p', { class: 'muted' }, 'No assessments yet.');
  const act = (a, action) => async () => {
    try {
      if (action === 'delete') {
        if (!confirm('Delete this assessment and its answers? This cannot be undone.')) return;
        await api('DELETE', '/assessments/' + a.id);
      } else {
        if (action === 'regenerate' && !confirm('Create a new link? The old link will stop working.')) return;
        await api('POST', `/assessments/${a.id}/${action}`);
      }
      route();
    } catch (ex) { alert(ex.message); }
  };
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, [showCandidate ? 'Candidates' : null, 'Tests', 'Status / Current Stage', 'Overall Result', 'Created', 'Link expires', 'Actions'].filter(Boolean).map((t) => h('th', {}, t)))),
    h('tbody', {}, list.map((a) => {
      if (a.kind === 'link') return sharedLinkRow(a, showCandidate);
      // A candidate's attempt on a shared link is reached through the shared URL.
      const url = examUrl(a.link_token || a.token);
      const copy = h('button', { class: 'secondary small', type: 'button', onclick: () => copyText(url, copy) }, 'Copy link');
      const canUse = a.state === 'ready' || a.state === 'disabled' || a.state === 'expired';
      return h('tr', {},
        showCandidate ? h('td', {}, a.candidate_id ? h('a', { href: '#/candidates/' + a.candidate_id }, a.candidate_name || 'Candidate') : h('span', { class: 'muted' }, 'Not started')) : null,
        h('td', { class: 'small' }, testsChain(a.stages), h('div', { class: 'muted small' }, `${LANG_LABEL[a.language]} · ${a.time_limit_minutes} min in total`)),
        h('td', {}, a.current_stage ? a.current_stage.label : '-', h('div', {}, stateBadge(a.state)), a.auto_submitted ? h('div', { class: 'muted small' }, 'Time ran out on a test') : null),
        h('td', {}, a.status === 'NOT_STARTED' ? '-' : resultBadge(a.result)),
        h('td', { class: 'small' }, fmtDate(a.created_at)),
        h('td', { class: 'small' }, a.status === 'NOT_STARTED' ? fmtDateTime(a.link_expires_at) : '-'),
        h('td', { class: 'nowrap' },
          a.status !== 'SUBMITTED' && a.state !== 'expired' ? copy : null, ' ',
          a.status !== 'NOT_STARTED' ? h('a', { class: 'button secondary small', href: '#/assessments/' + a.id }, 'View') : null, ' ',
          a.status !== 'SUBMITTED' ? (a.enabled
            ? h('button', { class: 'secondary small', type: 'button', onclick: act(a, 'disable') }, 'Disable')
            : h('button', { class: 'secondary small', type: 'button', onclick: act(a, 'enable') }, 'Enable')) : null, ' ',
          canUse && a.status === 'NOT_STARTED' ? h('button', { class: 'secondary small', type: 'button', onclick: act(a, 'regenerate') }, 'Regenerate') : null, ' ',
          h('button', { class: 'danger small', type: 'button', onclick: act(a, 'delete') }, 'Delete')));
    }))));
}

const SHARE_STATE = { open: ['Active', 'pass'], disabled: ['Disabled', 'fail'], expired: ['Expired', 'fail'] };

// One shared link in the Assessment Links table: its tests, how many
// candidates used it, and its actions. Its candidates are on its own page.
function sharedLinkRow(l, showCandidate) {
  const act = (action) => async () => {
    try {
      if (action === 'delete') {
        if (!confirm('Delete this unused link?')) return;
        await api('DELETE', '/links/' + l.id);
      } else {
        if (action === 'regenerate' && !confirm('Create a new address for this link? The old address will stop working.')) return;
        await api('POST', `/links/${l.id}/${action}`);
      }
      route();
    } catch (ex) { alert(ex.message); }
  };
  const copy = h('button', { class: 'secondary small', type: 'button', onclick: () => copyText(examUrl(l.token), copy) }, 'Copy link');
  const [stateText, stateCls] = SHARE_STATE[l.share_state] || [l.share_state, 'neutral'];
  const who = l.candidates ? `${l.candidates} candidate${l.candidates === 1 ? '' : 's'}` : 'No candidates yet';
  return h('tr', {},
    showCandidate ? h('td', {}, h('a', { href: '#/links/' + l.id }, h('strong', {}, who)),
      l.candidate_names && l.candidate_names.length ? h('div', { class: 'muted small' }, l.candidate_names.join(', ') + (l.candidates > l.candidate_names.length ? ', …' : '')) : null) : null,
    h('td', { class: 'small' }, h('strong', {}, l.title || 'Shared link'), h('div', {}, l.stages.map((st) => SECTION_LABEL[st.section]).join(' → ')),
      h('div', { class: 'muted small' }, `${LANG_LABEL[l.language]} · ${l.time_limit_minutes} min in total`)),
    h('td', {}, h('span', { class: 'badge ' + stateCls }, stateText),
      l.candidates ? h('div', { class: 'muted small' }, `${l.in_progress} in progress · ${l.finished} finished`) : null),
    h('td', {}, '-'),
    h('td', { class: 'small' }, fmtDate(l.created_at)),
    h('td', { class: 'small' }, fmtDateTime(l.link_expires_at)),
    h('td', { class: 'nowrap' },
      l.share_state !== 'expired' ? copy : null, ' ',
      h('a', { class: 'button secondary small', href: '#/links/' + l.id }, 'Candidates'), ' ',
      l.enabled ? h('button', { class: 'secondary small', type: 'button', onclick: act('disable') }, 'Disable')
        : h('button', { class: 'secondary small', type: 'button', onclick: act('enable') }, 'Enable'), ' ',
      !l.candidates ? h('button', { class: 'secondary small', type: 'button', onclick: act('regenerate') }, 'Regenerate') : null, ' ',
      !l.candidates ? h('button', { class: 'danger small', type: 'button', onclick: act('delete') }, 'Delete') : null));
}

// One shared link and every candidate who used it: one row per candidate session.
async function renderLink(id) {
  const { link: l, attempts } = await api('GET', '/links/' + id);
  const url = examUrl(l.token);
  const input = h('input', { value: url, readonly: true });
  const copy = h('button', { type: 'button', onclick: () => copyText(url, copy) }, 'Copy Link');
  const [stateText, stateCls] = SHARE_STATE[l.share_state] || [l.share_state, 'neutral'];
  const toggle = h('button', { type: 'button', class: 'secondary', onclick: async () => {
    try { await api('POST', `/links/${l.id}/${l.enabled ? 'disable' : 'enable'}`); route(); } catch (ex) { alert(ex.message); }
  } }, l.enabled ? 'Disable link (no new candidates)' : 'Enable link');
  const rows = attempts.map((a) => h('tr', {},
    h('td', {}, a.candidate_id ? h('a', { href: '#/candidates/' + a.candidate_id }, h('strong', {}, a.candidate_name)) : '-', h('div', { class: 'muted small' }, fmt(a.candidate_phone))),
    ...['IQ', 'GENERAL', 'CALCULATION', 'ESSAY'].filter((sec) => l.stages.some((st) => st.section === sec)).map((sec) => {
      const t = (a.tests || []).find((x) => x.section === sec);
      return h('td', {}, testCell(a, sec), t && t.section === 'IQ' && t.lalco_iq_score != null ? h('div', { class: 'muted small' }, `LALCO ${t.lalco_iq_score} / 150 · ${t.level}`) : null);
    }),
    h('td', { class: 'small' }, fmt(a.current_stage), a.enabled ? null : h('div', {}, h('span', { class: 'badge fail' }, 'Stopped by HR'))),
    h('td', {}, a.final_percent_text || '-', a.final_level ? h('div', { class: 'muted small' }, a.final_level) : null),
    h('td', { title: a.eligibility_note || '' }, eligibilityBadge(a.eligibility)),
    h('td', {}, resultBadge(a.final_result || 'Pending')),
    h('td', { class: 'small' }, fmtDateTime(a.started_at)),
    h('td', { class: 'small' }, fmtDateTime(a.submitted_at)),
    h('td', { class: 'nowrap' }, h('a', { class: 'button secondary small', href: '#/assessments/' + a.id }, 'View'))));
  view().replaceChildren(
    h('p', {}, h('a', { href: '#/assessments' }, '< All assessment links')),
    h('div', { class: 'row between' }, h('h1', {}, l.title || 'Shared assessment link', ' ', h('span', { class: 'badge ' + stateCls }, stateText)), toggle),
    h('div', { class: 'card' },
      h('div', { class: 'link-box' }, input, copy),
      h('p', { class: 'small' }, `Tests: ${l.stages.map((st) => `${TYPE_LABEL[st.section]} (${st.question_count} questions, ${st.time_limit_minutes} min, pass ${st.pass_mark}%)`).join(' → ')}`),
      h('p', { class: 'muted small' }, `${LANG_LABEL[l.language]} · created ${fmtDateTime(l.created_at)} · new candidates can start until ${fmtDateTime(l.link_expires_at)} · company eligibility: every test passed and final score at least ${l.eligibility_mark}%. Disabling or expiry stops NEW candidates only; candidates already in a test can finish.`)),
    h('div', { class: 'card' }, h('h2', {}, `Candidates (${attempts.length})`),
      attempts.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Candidate', ...l.stages.map((st) => SECTION_LABEL[st.section]), 'Current Stage', 'Final %', 'Company Eligibility', 'HR Final Result', 'Started', 'Finished', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows)))
        : h('p', { class: 'muted' }, 'Nobody has started yet. Share the link above; every person who opens it gets their own session.')));
}

async function renderAssessment(id) {
  const { assessment: a, stages, tests, final, iq, candidate, questions, link } = await api('GET', '/assessments/' + id);
  const essayInputs = [];
  const count = { correct: 0, wrong: 0, missed: 0 };
  const submitted = a.status === 'SUBMITTED';
  const rows = questions.map((q) => {
    const options = JSON.parse(q.option_order);
    const answered = q.answer != null && String(q.answer).trim() !== '';
    let answerCell;
    let status;
    if (q.section === 'ESSAY') {
      const input = h('input', { type: 'number', min: 0, max: q.max_marks, step: 'any', value: q.marks_awarded ?? '', class: 'inline-input', 'data-id': q.id });
      essayInputs.push(input);
      answerCell = h('td', {}, answered ? h('div', { class: 'pre' }, q.answer) : h('span', { class: 'muted' }, 'No answer'),
        h('div', { class: 'row small' }, 'Marks:', input, '/ ' + q.max_marks));
      if (submitted && !answered) count.missed++;
      status = !answered ? h('span', { class: 'badge pending' }, 'Not answered')
        : q.marks_awarded == null ? h('span', { class: 'badge pending' }, 'Not marked') : h('span', { class: 'badge pass' }, 'Marked');
    } else {
      // The candidate saw the options shuffled, so also show the letter they saw.
      const seenAs = options.indexOf(q.answer);
      answerCell = h('td', {}, !answered ? h('span', { class: 'muted' }, '-')
        : options.length ? [optionContent(q, q.answer), seenAs >= 0 ? h('div', { class: 'muted small' }, 'shown to candidate as ' + 'ABCDE'[seenAs]) : null]
          : q.answer);
      if (!submitted) status = h('span', { class: 'badge neutral' }, answered ? 'Answered' : 'Not answered yet');
      else if (!answered) { count.missed++; status = h('span', { class: 'badge pending' }, 'Not answered'); }
      else if (q.marks_awarded > 0) { count.correct++; status = h('span', { class: 'badge pass' }, 'Correct'); }
      else { count.wrong++; status = h('span', { class: 'badge fail' }, 'Wrong'); }
    }
    const correct = q.section === 'ESSAY' ? '-' : options.length ? optionContent(q, q.correct_answer) : q.correct_answer;
    return h('tr', {}, h('td', {}, q.position), h('td', {}, SECTION_LABEL[q.section]),
      h('td', { class: 'question-cell' }, h('div', { class: 'pre' }, q.question_text),
        q.display_language === 'lo' && q.question_text_lo ? h('div', { class: 'pre lao-text', lang: 'lo' }, q.question_text_lo, h('div', { class: 'muted small' }, 'Shown to the candidate in Lao')) : null,
        q.image_id ? h('div', { class: 'thumb-row' }, thumb(q.image_id)) : null),
      answerCell, h('td', {}, correct), h('td', {}, status));
  });
  const summary = h('div', { class: 'summary-badges' },
    h('span', { class: 'badge pass' }, 'Correct: ' + count.correct),
    h('span', { class: 'badge fail' }, 'Wrong: ' + count.wrong),
    h('span', { class: 'badge pending' }, 'Not answered: ' + count.missed),
    h('span', { class: 'badge neutral' }, 'Total: ' + questions.length));

  const card = h('div', { class: 'card' });
  const saveEssays = essayInputs.length && a.status === 'SUBMITTED'
    ? h('button', { type: 'button', onclick: async () => {
      const marks = Object.fromEntries(essayInputs.map((i) => [i.dataset.id, i.value]));
      try { await api('PUT', `/assessments/${a.id}/essay-marks`, { marks }); route(); } catch (ex) { flash(card, ex.message); }
    } }, 'Save essay marks') : null;

  const pct = (p, m) => (m ? `${Math.round((p / m) * 1000) / 10}% (${p}/${m})` : '-');
  card.append(
    h('div', { class: 'table-wrap' }, h('table', { class: 'kv' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'Candidate'), h('td', {}, candidate ? h('a', { href: '#/candidates/' + candidate.id }, candidate.name) : '-')),
      link ? h('tr', {}, h('th', {}, 'Shared link'), h('td', {}, h('a', { href: '#/links/' + link.id }, link.title || 'Shared link'), h('div', { class: 'muted small' }, 'This candidate’s own session on the shared link'))) : null,
      h('tr', {}, h('th', {}, 'Type'), h('td', {}, TYPE_LABEL[a.assessment_type], ' - ', LANG_LABEL[a.language])),
      h('tr', {}, h('th', {}, 'Status'), h('td', {}, stateBadge(a.state), a.auto_submitted ? ' (time ran out on a test)' : '')),
      h('tr', {}, h('th', {}, 'Current Stage'), h('td', {}, a.current_stage ? a.current_stage.label : '-')),
      h('tr', {}, h('th', {}, 'Assessment Result'), h('td', {}, a.status === 'NOT_STARTED' ? '-' : resultBadge(a.result))),
      h('tr', {}, h('th', {}, 'Started'), h('td', {}, fmtDateTime(a.started_at))),
      h('tr', {}, h('th', {}, 'Submitted'), h('td', {}, fmtDateTime(a.submitted_at))),
      h('tr', {}, h('th', {}, 'Left the page'), h('td', {}, `${a.focus_losses} time(s)`)),
      h('tr', {}, h('th', {}, 'IQ Test Result'), h('td', {}, iqResultBlock(iq))),
      h('tr', {}, h('th', {}, 'General'), h('td', {}, pct(a.general_points, a.general_max))),
      h('tr', {}, h('th', {}, 'Calculation'), h('td', {}, pct(a.calc_points, a.calc_max))),
      h('tr', {}, h('th', {}, 'Essay'), h('td', {}, a.essay_pending ? 'Waiting for marking' : pct(a.essay_points, a.essay_max))),
      h('tr', {}, h('th', {}, 'Test Score'), h('td', {}, a.test_score == null ? '-' : a.test_score + '%')),
      h('tr', {}, h('th', {}, 'Result'), h('td', {}, a.status === 'SUBMITTED' ? resultBadge(a.result) : '-'))))));

  const stagesCard = h('div', { class: 'card' }, h('h2', {}, 'Tests in this link'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['#', 'Test', 'Questions', 'Time', 'Status', 'Started', 'Finished', 'Score', '%', 'Level', 'Pass Mark', 'Result'].map((t) => h('th', {}, t)))),
      h('tbody', {}, stages.map((st, i) => {
        const t = tests[i];
        return h('tr', {},
          h('td', {}, st.position), h('td', {}, TYPE_LABEL[st.section]), h('td', {}, st.question_count), h('td', {}, st.time_limit_minutes + ' min'),
          h('td', {}, t.completion, st.auto_submitted ? h('div', { class: 'muted small' }, 'time ran out') : null),
          h('td', { class: 'small' }, fmtDateTime(st.started_at)), h('td', { class: 'small' }, fmtDateTime(st.submitted_at)),
          h('td', {}, st.status === 'SUBMITTED' ? `${st.points} / ${st.max}` : '-', t.lalco_iq_score != null ? h('div', { class: 'small' }, `LALCO IQ ${t.lalco_iq_score} / 150`) : null),
          h('td', {}, fmtPct(t.percent)), h('td', {}, fmt(t.level)), h('td', {}, t.pass_mark != null ? t.pass_mark + '%' : '-'),
          h('td', {}, testStateBadge(t.state)));
      })))),
    finalBox(final));

  view().replaceChildren(
    h('p', {}, h('a', { href: '#/assessments' }, '< All assessments')),
    h('h1', {}, 'Assessment review'),
    card,
    stagesCard,
    h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', {}, 'Answers'), submitted ? summary : null, saveEssays),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['#', 'Type', 'Question', 'Candidate answer', 'Correct answer', 'Status'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows)))));
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------


// LALCO IQ SCORE CLASSIFICATION reference table (rows come from the server).
function iqClassificationTable(classes) {
  return h('div', { class: 'card' }, h('h2', {}, 'LALCO IQ Score Classification'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'iq-class-table' },
      h('thead', {}, h('tr', {}, ['IQ Score', 'Description', '% of Population'].map((t) => h('th', {}, t)))),
      h('tbody', {}, classes.map((c) => h('tr', {}, h('td', {}, h('strong', {}, c.range)), h('td', {}, c.description, h('span', { class: 'muted small lao-text', lang: 'lo' }, ' · ' + c.description_lo)), h('td', {}, c.populationReference)))))),
    h('p', { class: 'muted small' }, 'The LALCO IQ Score is 50 + (IQ weighted marks ÷ maximum marks × 100), from 50 to 150; the classification is looked up from that score. The population percentages are reference values from the classification table only — they are not calculated from LALCO candidates and are not used for scoring or ranking. A recruitment score, not a clinical IQ.'));
}

async function renderResults() {
  const [list, iq, classes] = await Promise.all([api('GET', '/candidates'), api('GET', '/results/iq'), api('GET', '/iq-classification')]);
  const iqCard = h('div', { class: 'card' }, h('h2', {}, 'IQ Test Results'),
    iq.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Candidate', 'IQ Weighted Score', 'IQ %', 'LALCO IQ Score', 'IQ Classification', 'Correct Answers', ...IQ_LEVELS.map((n) => 'Level ' + n), 'Assessment Date', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, iq.map((r) => h('tr', {},
        h('td', {}, r.candidate_id ? h('a', { href: '#/candidates/' + r.candidate_id }, r.candidate_name) : '-'),
        h('td', {}, r.iq_text), h('td', {}, r.iq_score + '%'),
        h('td', {}, r.lalco_iq_score != null ? h('strong', {}, r.lalco_iq_score + ' / 150') : '-'), h('td', {}, r.iq_category || '-'),
        h('td', {}, r.iq_correct_text || '-'),
        ...IQ_LEVELS.map((n) => h('td', {}, levelCell(r, n))),
        h('td', {}, fmtDate(r.iq_date)),
        h('td', {}, h('a', { class: 'button secondary small', href: '#/assessments/' + r.id }, 'Answers')))))))
      : h('p', { class: 'muted' }, 'No IQ tests submitted yet.'),
    h('p', { class: 'muted small' }, 'IQ Test Score = marks earned out of the maximum. Each correct answer is worth its level: Level 1 = 1 mark up to Level 5 = 5 marks. The maximum comes from the questions the candidate actually got (e.g. 20 questions = 4 per level = 60). Tests taken before the 5-level scale keep their earlier Easy / Medium / Hard marks. It is a test score, not a clinical IQ measurement.'));
  view().replaceChildren(
    h('div', { class: 'row between' }, h('h1', {}, 'Results'), downloadLink('/export/candidates.xlsx', 'Export all candidates (Excel)', '')),
    iqClassificationTable(classes),
    iqCard,
    h('div', { class: 'card' }, h('h2', {}, 'All candidates'), list.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Candidate', 'IQ', 'General', 'Calculation', 'Essay', 'Current Stage', 'Final %', 'Final Level', 'Company Eligibility', 'HR Final Result', 'Date', 'Export'].map((t) => h('th', {}, t)))),
      h('tbody', {}, list.map((c) => h('tr', {},
        h('td', {}, h('a', { href: '#/candidates/' + c.id }, c.name)),
        h('td', {}, testCell(c, 'IQ'), c.iq_text ? h('div', { class: 'muted small' }, `${c.iq_text} · LALCO ${c.lalco_iq_score ?? '-'} / 150 · ${c.iq_category || '-'}`) : null),
        h('td', {}, testCell(c, 'GENERAL')), h('td', {}, testCell(c, 'CALCULATION')), h('td', {}, testCell(c, 'ESSAY')),
        h('td', { class: 'small' }, fmt(c.current_stage)),
        h('td', {}, c.final_percent_text || '-'), h('td', {}, fmt(c.final_level)), h('td', { title: c.eligibility_note || '' }, eligibilityBadge(c.eligibility)),
        h('td', {}, resultBadge(c.final_result || 'Pending')), h('td', {}, fmtDate(c.assessment_date || c.created_at)),
        h('td', { class: 'nowrap' }, downloadLink(`/candidates/${c.id}/export.pdf`, 'PDF'), ' ', downloadLink(`/candidates/${c.id}/export.docx`, 'Word'), ' ', downloadLink(`/candidates/${c.id}/export.xlsx`, 'Excel')))))))
      : h('p', { class: 'muted' }, 'No candidates yet.')),
    h('p', { class: 'muted small' }, 'Each test shows its percentage and PASS / NOT PASS against its own pass mark. Final % = the average of the included tests, once all are finished and marked. Company Eligibility: every test passed and Final % at least the eligibility mark; a test not passed = NOT ELIGIBLE. HR Final Result is HR\'s own decision on the candidate page.'));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function renderSettings() {
  const s = await api('GET', '/settings');
  const form = h('form', { class: 'grid' },
    field('Default Exam Time (minutes)', h('input', { name: 'default_time_minutes', type: 'number', min: 1, max: 600, value: s.default_time_minutes })),
    field('Default Link Expiry (minutes)', h('input', { name: 'default_link_expiry_minutes', type: 'number', min: 1, value: s.default_link_expiry_minutes })),
    field('Default Language', select('default_language', Object.entries(LANG_LABEL), s.default_language)),
    h('h2', { class: 'wide section-gap' }, 'Pass marks'),
    ...[['pass_iq', 'IQ Test pass (%)'], ['pass_general', 'General Test pass (%)'], ['pass_calculation', 'Calculation Test pass (%)'], ['pass_essay', 'Essay Test pass (%)'],
      ['final_eligibility', 'Final company eligibility (%)']].map(([name, label]) => field(label, h('input', { name, type: 'number', min: 0, max: 100, step: 'any', value: s[name] }))),
    h('div', { class: 'wide' }, h('button', { type: 'submit' }, 'Save settings')));
  const card = h('div', { class: 'card' }, h('h2', {}, 'Assessment defaults'), form,
    h('p', { class: 'muted small' }, `Current link expiry default: ${fmtMinutes(s.default_link_expiry_minutes)}. A test is passed when its percentage reaches its pass mark. A candidate is ELIGIBLE when every test in the link is passed and the final score (the average of the tests) reaches the final eligibility mark. These are the defaults for new assessment links (they can be changed on each new link); links already created keep their own marks, so saving never changes an existing result.`));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    try {
      await api('PUT', '/settings', { ...v, default_time_minutes: Number(v.default_time_minutes), default_link_expiry_minutes: Number(v.default_link_expiry_minutes) });
      flash(card, 'Settings saved.', 'ok');
    } catch (ex) { flash(card, ex.message); }
  });

  const pw = h('form', { class: 'grid' },
    field('Current password', h('input', { name: 'current_password', type: 'password', autocomplete: 'current-password', required: true })),
    field('New password (8+ characters)', h('input', { name: 'new_password', type: 'password', autocomplete: 'new-password', minlength: 8, required: true })),
    h('div', { class: 'wide' }, h('button', { type: 'submit' }, 'Change password')));
  const pwCard = h('div', { class: 'card' }, h('h2', {}, 'Change password'), pw);
  pw.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/auth/password', formValues(pw)); pw.reset(); flash(pwCard, 'Password changed.', 'ok'); } catch (ex) { flash(pwCard, ex.message); }
  });

  view().replaceChildren(h('h1', {}, 'Settings'), card, pwCard);
}
