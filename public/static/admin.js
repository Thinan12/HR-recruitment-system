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
  ready: ['Waiting', 'neutral'], in_progress: ['In progress', 'pending'], submitted: ['Submitted', 'pass'],
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
  assessments: (id) => (id ? renderAssessment(id) : renderAssessments()),
  results: () => renderResults(),
  settings: () => renderSettings(),
};

async function route() {
  const [, page = 'dashboard', id] = location.hash.split('/');
  const render = ROUTES[page] || ROUTES.dashboard;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === (ROUTES[page] ? page : 'dashboard')));
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

const LEVEL_NAMES = { Easy: 'Level 1 — Easy', Medium: 'Level 2 — Medium', Hard: 'Level 3 — Hard' };
const LEVEL_MARK = { Easy: 1, Medium: 2, Hard: 3 };
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
    h('div', { class: 'iq-row' }, h('span', { class: 'muted' }, 'IQ Test Score'), h('strong', { class: 'iq-main' }, r.iq_text)),
    h('div', { class: 'iq-row' }, h('span', { class: 'muted' }, 'IQ Percentage'), h('strong', {}, r.iq_score + '%')),
    h('div', { class: 'iq-levels' }, (r.iq_levels || []).map((l) => h('div', { class: 'iq-level' },
      h('div', { class: 'small' }, h('strong', {}, l.label)),
      h('div', {}, l.correct_text + ' correct'),
      h('div', {}, l.marks_text + ' marks')))));
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function renderDashboard() {
  const d = await api('GET', '/dashboard');
  const stat = (label, value, sub, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
  const recent = d.recent.length
    ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Candidate', 'IQ Test Score', 'IQ %', 'Level 1', 'Level 2', 'Level 3', 'Result', 'Date'].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.recent.map((c) => h('tr', { class: 'clickable', onclick: () => { location.hash = '#/candidates/' + c.id; } },
        h('td', {}, c.name), h('td', {}, c.iq_text ? h('strong', {}, c.iq_text) : '-'), h('td', {}, c.iq_text ? c.iq_score + '%' : '-'),
        h('td', {}, levelMarksCell(c, 1)), h('td', {}, levelMarksCell(c, 2)), h('td', {}, levelMarksCell(c, 3)),
        h('td', {}, resultBadge(c.overall_result)), h('td', {}, fmtDate(c.last_test_date)))))))
    : h('p', { class: 'muted' }, 'No completed assessments yet. Start by uploading questions, then create an assessment link.');

  view().replaceChildren(
    h('h1', {}, 'Dashboard'),
    h('div', { class: 'stats' },
      stat('Total Candidates', d.total_candidates),
      stat('Passed', d.passed),
      stat('Not Passed', d.not_passed),
      stat('Average Test Score', d.average_test_score == null ? '-' : d.average_test_score + '%'),
      stat('Highest IQ Test Score', d.highest_iq ? d.highest_iq.iq_text : '-', d.highest_iq ? `IQ Percentage ${d.highest_iq.iq_score}% · ${d.highest_iq.name}` : 'No IQ results yet', 'highlight'),
      stat('Completed Assessments', d.completed_assessments),
      stat('Pending Assessments', d.pending_assessments)),
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, 'Recent results'),
        h('div', { class: 'row' }, h('a', { class: 'button small', href: '#/assessments' }, 'Create assessment link'), downloadLink('/export/candidates.xlsx', 'Export all (Excel)'))),
      recent));
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
      h('thead', {}, h('tr', {}, ['Name', 'Phone', 'Graduate From', 'IQ Test Score', 'Test Score', 'Interview', 'Final Result', 'Added'].map((t) => h('th', {}, t)))),
      h('tbody', {}, list.map((c) => h('tr', { class: 'clickable', onclick: () => { location.hash = '#/candidates/' + c.id; } },
        h('td', {}, c.name), h('td', {}, fmt(c.phone)), h('td', {}, fmt(c.graduate_from)), h('td', {}, c.iq_text ? `${c.iq_text} (${c.iq_score}%)` : '-'),
        h('td', {}, fmt(c.test_score)), h('td', {}, fmt(c.interview_score)), h('td', {}, resultBadge(c.overall_result)), h('td', {}, fmtDate(c.created_at)))))))
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
    h('div', { class: 'table-wrap' }, h('table', { class: 'kv' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'IQ Test Result'), h('td', {}, iqResultBlock(c))),
      h('tr', {}, h('th', {}, 'Test Score'), h('td', {}, c.test_score == null ? '-' : c.test_score + '%')),
      h('tr', {}, h('th', {}, 'General Test'), h('td', {}, c.general_score == null ? '-' : c.general_score + '%')),
      h('tr', {}, h('th', {}, 'Calculation Test'), h('td', {}, c.calc_score == null ? '-' : c.calc_score + '%')),
      h('tr', {}, h('th', {}, 'Essay Test'), h('td', {}, c.essay_pending ? 'Waiting for HR marking' : c.essay_score == null ? '-' : c.essay_score + '%')),
      h('tr', {}, h('th', {}, 'Result (test)'), h('td', {}, resultBadge(c.test_result)))))),
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
      field('Final Result', select('final_result', [['Pending', 'Pending'], ['Pass', 'Pass'], ['Not Pass', 'Not Pass']], c.final_result)),
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
    h('div', { class: 'row between' }, h('h1', {}, c.name, ' ', resultBadge(c.overall_result)),
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
  const statusFilter = select('status_filter', [['', 'Active and inactive'], ['Active', 'Active only'], ['Inactive', 'Inactive only']], questionStatus);
  statusFilter.classList.add('inline-input');
  const tabs = h('div', { class: 'tabs' });
  const summary = h('p', { class: 'small' });
  const body = h('div');
  const card = h('div', { class: 'card' }, h('div', { class: 'row between' }, tabs, h('div', { class: 'row' }, statusFilter, search)), summary, body);
  statusFilter.addEventListener('change', () => { questionStatus = statusFilter.value; load(); });

  const load = async () => {
    const { questions, counts, inactive_counts: inactive } = await api('GET', `/questions?section=${questionSection}&status=${questionStatus}&q=${encodeURIComponent(search.value)}`);
    const shown = questionSection ? [questionSection] : Object.keys(SECTION_LABEL);
    summary.replaceChildren(...shown.flatMap((s, i) => [i ? ' · ' : '', h('strong', {}, `Active ${SECTION_LABEL[s]} Questions: ${counts[s]}`), `  Inactive ${SECTION_LABEL[s]} Questions: ${inactive[s]}`]));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    tabs.replaceChildren(...[['', `All (${total})`], ...Object.keys(SECTION_LABEL).map((s) => [s, `${SECTION_LABEL[s]} (${counts[s]})`])]
      .map(([s, label]) => h('button', { type: 'button', class: s === questionSection ? 'active' : '', onclick: () => { questionSection = s; load(); } }, label)));
    body.replaceChildren(questions.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Question', 'Type', 'Area', 'Level', 'Correct Answer', 'Marks', 'Status', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, questions.map((q) => h('tr', {},
        h('td', { class: 'question-cell' }, h('div', { class: 'pre' }, q.question_text), q.image_id ? h('div', { class: 'thumb-row' }, thumb(q.image_id)) : null),
        h('td', {}, SECTION_LABEL[q.section]), h('td', {}, fmt(q.category)), h('td', { class: 'nowrap' }, LEVEL_NAMES[q.difficulty] || fmt(q.difficulty)),
        h('td', {}, q.section === 'ESSAY' ? 'HR marks' : /^[A-E]$/.test(q.correct_answer) ? optionContent(q, q.correct_answer) : q.correct_answer),
        h('td', { class: 'nowrap' }, q.marks + (q.marks === 1 ? ' mark' : ' marks')),
        h('td', {}, h('span', { class: 'badge ' + (q.status === 'Active' ? 'pass' : 'neutral') }, q.status)),
        h('td', { class: 'nowrap' },
          h('button', { class: 'secondary small', type: 'button', onclick: () => editQuestion(q, load) }, 'Edit'), ' ',
          h('button', { class: 'danger small', type: 'button', onclick: async () => {
            if (!confirm('Delete this question? Past results are not affected.')) return;
            try { await api('DELETE', '/questions/' + q.id); load(); } catch (ex) { alert(ex.message); }
          } }, 'Delete')))))))
      : h('p', { class: 'muted' }, 'No questions yet. Upload a file or add a question.'));
  };
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });

  view().replaceChildren(
    h('div', { class: 'row between' }, h('h1', {}, 'Questions'),
      h('button', { type: 'button', onclick: () => editQuestion(null, load) }, 'Add question')),
    uploadCard(load),
    card);
  await load();
}

function uploadCard(onImported) {
  const fileInput = h('input', { type: 'file', class: 'inline-input', accept: '.xlsx,.xls,.docx,.doc,.pdf,.csv,.txt' });
  const section = select('section', Object.entries(SECTION_LABEL).map(([k, v]) => [k, v + ' questions']), questionSection || 'IQ');
  section.classList.add('inline-input');
  const result = h('div');
  const button = h('button', { type: 'button' }, 'Read file');
  const card = h('div', { class: 'card' },
    h('h2', {}, 'Upload questions'),
    h('p', { class: 'muted small' },
      'Excel, Word, PDF, CSV or TXT. Use columns Question, Option A-D, Correct Answer (optional: Type, Category, Difficulty, Marks), or numbered questions with "Answer: B" lines. ',
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
  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true;
    try {
      const r = await api('POST', '/questions/import', { questions: valid });
      container.replaceChildren(message(`Imported ${r.imported} questions.` + (r.skipped ? ` Skipped ${r.skipped}.` : ''), 'ok'));
      onDone();
    } catch (ex) { flash(container, ex.message); importBtn.disabled = false; }
  });
  container.replaceChildren(h('div', {}, // h() skips the null sections; replaceChildren would print "null"
    h('div', { class: 'stats' },
      ...[['Questions found', p.found], ['Valid', p.valid], ['Invalid', p.invalid]].map(([l, v]) => h('div', { class: 'stat' }, h('div', { class: 'label' }, l), h('div', { class: 'value' }, v))),
      ...Object.entries(p.by_section).filter(([, n]) => n > 0).map(([s, n]) => h('div', { class: 'stat' }, h('div', { class: 'label' }, SECTION_LABEL[s] + ' questions'), h('div', { class: 'value' }, n)))),
    invalid.length ? h('div', {}, h('h2', {}, 'Rows that will be skipped'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Row'), h('th', {}, 'Question'), h('th', {}, 'Problem'))),
      h('tbody', {}, invalid.slice(0, 50).map((r) => h('tr', {}, h('td', {}, r.row), h('td', { class: 'question-cell' }, fmt(r.question.question_text).slice(0, 160)), h('td', {}, r.errors.join(' ')))))))) : null,
    valid.length ? h('div', {}, h('h2', { class: 'section-gap' }, 'First questions'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Question', 'Type', 'Level', 'Options', 'Answer', 'Marks'].map((t) => h('th', {}, t)))),
      h('tbody', {}, valid.slice(0, 5).map((q) => h('tr', {},
        h('td', { class: 'question-cell' }, h('div', { class: 'pre' }, q.question_text), q.image_id ? h('div', { class: 'thumb-row' }, thumb(q.image_id)) : null),
        h('td', {}, SECTION_LABEL[q.section]), h('td', { class: 'nowrap' }, LEVEL_NAMES[q.difficulty] || fmt(q.difficulty)),
        h('td', { class: 'small' }, h('div', { class: 'thumb-row' }, LETTERS.filter((l) => q['option_' + l] || q['option_' + l + '_image'])
          .map((l) => optionContent(q, l.toUpperCase())))),
        h('td', {}, q.correct_answer), h('td', {}, q.marks))))))) : null,
    h('div', { class: 'row section-gap' }, importBtn, h('button', { class: 'secondary', type: 'button', onclick: () => container.replaceChildren() }, 'Cancel'))));
}

function editQuestion(q, onSaved) {
  q = q || { section: questionSection || 'IQ', marks: 1, status: 'Active', difficulty: 'Medium' };
  let showError = () => {};
  const known = ['Easy', 'Medium', 'Hard'];
  const levelSelect = select('difficulty', [['', '-'], ...known.map((k) => [k, LEVEL_NAMES[k]]), ...(q.difficulty && !known.includes(q.difficulty) ? [[q.difficulty, q.difficulty]] : [])], q.difficulty || '');
  const marksInput = h('input', { name: 'marks', type: 'number', min: 0.5, max: 100, step: 0.5, value: q.marks });
  // IQ questions: marks come from the level (1 / 2 / 3) and cannot be typed.
  const syncMarks = () => {
    const isIq = form.elements.section.value === 'IQ';
    marksInput.disabled = isIq;
    if (isIq) { if (!levelSelect.value) levelSelect.value = 'Medium'; marksInput.value = LEVEL_MARK[levelSelect.value] || 2; }
  };
  const form = h('form', { class: 'grid' },
    field('Type', select('section', Object.entries(SECTION_LABEL), q.section)),
    field('Area', h('input', { name: 'category', value: q.category || '', placeholder: 'e.g. Number Patterns' })),
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
  form.elements.section.addEventListener('change', syncMarks);
  levelSelect.addEventListener('change', syncMarks);
  syncMarks();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
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

const EXPIRY_CHOICES = [[10, '10 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [1440, '1 day'], [4320, '3 days'], [10080, '7 days'], ['custom', 'Custom (minutes)']];

async function renderAssessments() {
  const [settings, candidates, questionData, list] = await Promise.all([
    api('GET', '/settings'), api('GET', '/candidates'), api('GET', '/questions/counts'), api('GET', '/assessments')]);
  const counts = questionData;

  const typeSelect = select('assessment_type', Object.entries(TYPE_LABEL), 'IQ');
  const countsBox = h('div', { class: 'grid wide' });
  const drawCounts = () => {
    countsBox.replaceChildren(...TYPE_SECTIONS[typeSelect.value].map((s) => {
      const def = s === 'IQ' ? IQ_DEFAULT : typeSelect.value === 'COMBINED' ? (s === 'ESSAY' ? 1 : 10) : 20;
      const input = h('input', { name: 'count_' + s, type: 'number', min: 0, max: counts[s], value: Math.min(counts[s], def) });
      const quick = s === 'IQ' ? h('div', { class: 'row small section-gap-sm' }, 'Quick:', [10, 15, 18, 20, 30].map((n) =>
        h('button', { type: 'button', class: 'secondary small', disabled: n > counts[s], onclick: () => { input.value = n; } }, String(n)))) : null;
      return h('div', { class: 'field' }, field(`${SECTION_LABEL[s]} questions (bank has ${counts[s]})`, input), quick);
    }));
  };
  typeSelect.addEventListener('change', drawCounts);
  drawCounts();

  const expirySelect = select('expiry_choice', EXPIRY_CHOICES, EXPIRY_CHOICES.some(([v]) => v === settings.default_link_expiry_minutes) ? settings.default_link_expiry_minutes : 'custom');
  const customExpiry = h('input', { name: 'expiry_custom', type: 'number', min: 1, value: settings.default_link_expiry_minutes });
  const customField = field('Custom expiry (minutes)', customExpiry);
  const syncExpiry = () => customField.classList.toggle('hidden', expirySelect.value !== 'custom');
  expirySelect.addEventListener('change', syncExpiry);
  syncExpiry();

  const output = h('div');
  const form = h('form', { class: 'grid' },
    field('Candidate', select('candidate_id', [['', 'New candidate (fills in their own details)'], ...candidates.map((c) => [c.id, `${c.name}${c.phone ? ' - ' + c.phone : ''}`])], '')),
    field('Assessment Type', typeSelect),
    field('Language', select('language', Object.entries(LANG_LABEL), settings.default_language)),
    field('Assessment Time (minutes)', h('input', { name: 'time_limit_minutes', type: 'number', min: 1, max: 600, value: settings.default_time_minutes })),
    field('Link expires in', expirySelect),
    customField,
    countsBox,
    h('p', { class: 'muted small wide' }, 'Each candidate gets a different random set of questions from the bank, and answer options are shuffled. IQ questions go from Easy to Hard (for 18: questions 1-7 Easy, 8-12 Medium, 13-18 Hard).'),
    h('div', { class: 'wide' }, h('button', { type: 'submit' }, 'Generate Link')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    const body = {
      candidate_id: v.candidate_id || null,
      assessment_type: v.assessment_type,
      language: v.language,
      time_limit_minutes: Number(v.time_limit_minutes),
      link_expiry_minutes: Number(v.expiry_choice === 'custom' ? v.expiry_custom : v.expiry_choice),
      counts: Object.fromEntries(TYPE_SECTIONS[v.assessment_type].map((s) => [s, Number(v['count_' + s] || 0)])),
    };
    try {
      const a = await api('POST', '/assessments', body);
      const url = examUrl(a.token);
      const input = h('input', { value: url, readonly: true });
      const copy = h('button', { type: 'button', onclick: () => copyText(url, copy) }, 'Copy link');
      output.replaceChildren(h('div', { class: 'message ok' }, `Link created. It must be opened before ${fmtDateTime(a.link_expires_at)}.`),
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
    h('thead', {}, h('tr', {}, [showCandidate ? 'Candidate' : null, 'Type', 'Language', 'Time', 'Status', 'Link expires', 'Score', 'Result', 'Actions'].filter(Boolean).map((t) => h('th', {}, t)))),
    h('tbody', {}, list.map((a) => {
      const copy = h('button', { class: 'secondary small', type: 'button', onclick: () => copyText(examUrl(a.token), copy) }, 'Copy link');
      const canUse = a.state === 'ready' || a.state === 'disabled' || a.state === 'expired';
      return h('tr', {},
        showCandidate ? h('td', {}, a.candidate_id ? h('a', { href: '#/candidates/' + a.candidate_id }, a.candidate_name || 'Candidate') : h('span', { class: 'muted' }, 'Not started')) : null,
        h('td', {}, TYPE_LABEL[a.assessment_type]), h('td', {}, LANG_LABEL[a.language]), h('td', {}, a.time_limit_minutes + ' min'),
        h('td', {}, stateBadge(a.state), a.auto_submitted ? h('div', { class: 'muted small' }, 'Auto-submitted') : null),
        h('td', { class: 'small' }, a.status === 'NOT_STARTED' ? fmtDateTime(a.link_expires_at) : '-'),
        h('td', {}, a.test_score == null ? '-' : a.test_score + '%'),
        h('td', {}, a.status === 'SUBMITTED' ? resultBadge(a.result) : '-'),
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

async function renderAssessment(id) {
  const { assessment: a, iq, candidate, questions } = await api('GET', '/assessments/' + id);
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
      h('td', { class: 'question-cell' }, h('div', { class: 'pre' }, q.question_text), q.image_id ? h('div', { class: 'thumb-row' }, thumb(q.image_id)) : null),
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
      h('tr', {}, h('th', {}, 'Type'), h('td', {}, TYPE_LABEL[a.assessment_type], ' - ', LANG_LABEL[a.language])),
      h('tr', {}, h('th', {}, 'Status'), h('td', {}, stateBadge(a.state), a.auto_submitted ? ' (auto-submitted when time ran out)' : '')),
      h('tr', {}, h('th', {}, 'Started'), h('td', {}, fmtDateTime(a.started_at))),
      h('tr', {}, h('th', {}, 'Submitted'), h('td', {}, fmtDateTime(a.submitted_at))),
      h('tr', {}, h('th', {}, 'Left the page'), h('td', {}, `${a.focus_losses} time(s)`)),
      h('tr', {}, h('th', {}, 'IQ Test Result'), h('td', {}, iqResultBlock(iq))),
      h('tr', {}, h('th', {}, 'General'), h('td', {}, pct(a.general_points, a.general_max))),
      h('tr', {}, h('th', {}, 'Calculation'), h('td', {}, pct(a.calc_points, a.calc_max))),
      h('tr', {}, h('th', {}, 'Essay'), h('td', {}, a.essay_pending ? 'Waiting for marking' : pct(a.essay_points, a.essay_max))),
      h('tr', {}, h('th', {}, 'Test Score'), h('td', {}, a.test_score == null ? '-' : a.test_score + '%')),
      h('tr', {}, h('th', {}, 'Result'), h('td', {}, a.status === 'SUBMITTED' ? resultBadge(a.result) : '-'))))));

  view().replaceChildren(
    h('p', {}, h('a', { href: '#/assessments' }, '< All assessments')),
    h('h1', {}, 'Assessment review'),
    card,
    h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', {}, 'Answers'), submitted ? summary : null, saveEssays),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['#', 'Type', 'Question', 'Candidate answer', 'Correct answer', 'Status'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows)))));
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------


async function renderResults() {
  const [list, iq] = await Promise.all([api('GET', '/candidates'), api('GET', '/results/iq')]);
  const iqCard = h('div', { class: 'card' }, h('h2', {}, 'IQ Test Results'),
    iq.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Candidate', 'IQ Test Score', 'IQ %', 'Correct Answers', 'Level 1 — Easy', 'Level 2 — Medium', 'Level 3 — Hard', 'Assessment Date', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, iq.map((r) => h('tr', {},
        h('td', {}, r.candidate_id ? h('a', { href: '#/candidates/' + r.candidate_id }, r.candidate_name) : '-'),
        h('td', {}, h('strong', {}, r.iq_text)), h('td', {}, r.iq_score + '%'), h('td', {}, r.iq_correct_text || '-'),
        h('td', {}, levelCell(r, 1)), h('td', {}, levelCell(r, 2)), h('td', {}, levelCell(r, 3)),
        h('td', {}, fmtDate(r.iq_date)),
        h('td', {}, h('a', { class: 'button secondary small', href: '#/assessments/' + r.id }, 'Answers')))))))
      : h('p', { class: 'muted' }, 'No IQ tests submitted yet.'),
    h('p', { class: 'muted small' }, 'IQ Test Score = marks earned out of the maximum. Each correct answer is worth 1 mark at Level 1, 2 at Level 2 and 3 at Level 3 (18 questions: maximum 36). It is a test score, not a clinical IQ measurement.'));
  view().replaceChildren(
    h('div', { class: 'row between' }, h('h1', {}, 'Results'), downloadLink('/export/candidates.xlsx', 'Export all candidates (Excel)', '')),
    iqCard,
    h('div', { class: 'card' }, h('h2', {}, 'All candidates'), list.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Candidate', 'IQ Test Score', 'Test Score', 'Calculation Test', 'Essay Test', 'Interview Score', 'Final Result', 'Date', 'Export'].map((t) => h('th', {}, t)))),
      h('tbody', {}, list.map((c) => h('tr', {},
        h('td', {}, h('a', { href: '#/candidates/' + c.id }, c.name)),
        h('td', {}, c.iq_text ? `${c.iq_text} (${c.iq_score}%)` : '-'), h('td', {}, fmt(c.test_score)), h('td', {}, fmt(c.calc_score)),
        h('td', {}, c.essay_pending ? 'Pending' : fmt(c.essay_score)), h('td', {}, fmt(c.interview_score)),
        h('td', {}, resultBadge(c.overall_result)), h('td', {}, fmtDate(c.last_test_date || c.created_at)),
        h('td', { class: 'nowrap' }, downloadLink(`/candidates/${c.id}/export.pdf`, 'PDF'), ' ', downloadLink(`/candidates/${c.id}/export.docx`, 'Word'), ' ', downloadLink(`/candidates/${c.id}/export.xlsx`, 'Excel')))))))
      : h('p', { class: 'muted' }, 'No candidates yet.')),
    h('p', { class: 'muted small' }, 'Scores are percentages. Final Result shows HR\'s decision; until HR decides, it shows the test result (Pass when Test Score reaches the pass mark).'));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function renderSettings() {
  const s = await api('GET', '/settings');
  const form = h('form', { class: 'grid' },
    field('Default Exam Time (minutes)', h('input', { name: 'default_time_minutes', type: 'number', min: 1, max: 600, value: s.default_time_minutes })),
    field('Default Link Expiry (minutes)', h('input', { name: 'default_link_expiry_minutes', type: 'number', min: 1, value: s.default_link_expiry_minutes })),
    field('Pass Mark (%)', h('input', { name: 'pass_mark', type: 'number', min: 0, max: 100, step: 'any', value: s.pass_mark })),
    field('Default Language', select('default_language', Object.entries(LANG_LABEL), s.default_language)),
    h('div', { class: 'wide' }, h('button', { type: 'submit' }, 'Save settings')));
  const card = h('div', { class: 'card' }, h('h2', {}, 'Assessment defaults'), form,
    h('p', { class: 'muted small' }, `Current link expiry default: ${fmtMinutes(s.default_link_expiry_minutes)}. Changing the pass mark updates the result of every submitted assessment.`));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    try {
      await api('PUT', '/settings', { ...v, default_time_minutes: Number(v.default_time_minutes), default_link_expiry_minutes: Number(v.default_link_expiry_minutes), pass_mark: Number(v.pass_mark) });
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
