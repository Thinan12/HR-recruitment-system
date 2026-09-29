'use strict';
// Internal Office Staff pages (#/internal/...). Separate records, links,
// results and reports from Recruitment; the helpers (h, api, field, …) and the
// assessment review page come from admin.js.

const staffUrl = (l) => location.origin + (l.url_path || '/internal-assessment/' + l.token);
const LINK_STATE = { open: ['Active', 'pass'], disabled: ['Disabled', 'neutral'], expired: ['Expired', 'fail'], used: ['Used (single-use)', 'neutral'] };
const linkBadge = (s) => { const [t, c] = LINK_STATE[s] || [s, 'neutral']; return h('span', { class: 'badge ' + c }, t); };
const STATUS_CLASS = { PASS: 'pass', 'NOT PASS': 'fail', PENDING: 'pending', 'IN PROGRESS': 'pending' };
const statusBadge = (v) => h('span', { class: 'badge ' + (STATUS_CLASS[v] || 'neutral') }, v);
const testsOf = (l) => (l.stages || []).map((st) => `${SECTION_LABEL[st.section] || st.section} (${st.question_count} q · ${st.time_limit_minutes} min)`).join(' → ');
const internalHeader = (title, ...right) => h('div', { class: 'row between' }, h('div', {}, h('span', { class: 'internal-banner' }, 'INTERNAL OFFICE STAFF'), h('h1', {}, title)), h('div', { class: 'row' }, ...right));
const tableOf = (heads, rows, empty) => (rows.length
  ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map((x) => h('th', {}, x)))), h('tbody', {}, rows)))
  : h('p', { class: 'muted' }, empty));

ROUTES.internal = (section = 'dashboard', id) => {
  const page = { dashboard: renderStaffDashboard, staff: renderStaffPage, links: renderStaffLinks, results: renderStaffResults, reports: renderStaffReports }[section || 'dashboard'];
  return (page || renderStaffDashboard)(id);
};

// ---- dashboard -------------------------------------------------------------------

async function renderStaffDashboard() {
  const d = await api('GET', '/internal/dashboard');
  const stat = (label, value, href) => h('a', { class: 'stat', href }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
  const resultLine = (r) => h('tr', {},
    h('td', {}, h('a', { href: '#/internal/results/' + r.id }, r.values[0])), h('td', {}, r.values[1]), h('td', {}, r.values[4]),
    h('td', {}, statusBadge(r.values[9])), h('td', { class: 'small nowrap' }, r.values[10]));
  view().replaceChildren(
    internalHeader('Staff Dashboard', h('a', { class: 'button small', href: '#/internal/links' }, 'Create assessment link')),
    h('div', { class: 'stats' },
      stat('Total Staff', d.totalStaff, '#/internal/staff'), stat('Total Assessments', d.totalAssessments, '#/internal/results'),
      stat('Active Links', d.activeLinks, '#/internal/links'), stat('Completed', d.completed, '#/internal/results'),
      stat('In Progress', d.inProgress, '#/internal/results'), stat('Pending HR marking', d.pending, '#/internal/results'),
      stat('Passed', d.passed, '#/internal/results'), stat('Not Passed', d.notPassed, '#/internal/results')),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h2', {}, 'Recent staff assessments'), tableOf(['Staff', 'Employee ID', 'Assessment', 'Status', 'Date and Time'], d.recentAssessments.map(resultLine), 'No staff assessments yet.')),
      h('div', { class: 'card' }, h('h2', {}, 'Recent results'), tableOf(['Staff', 'Employee ID', 'Assessment', 'Result', 'Date and Time'], d.recentResults.map(resultLine), 'No completed assessments yet.'))),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h2', {}, 'Active links'), tableOf(['Assessment', 'Expires', 'Started', 'Completed'],
        d.activeLinksList.map((l) => h('tr', {}, h('td', {}, h('a', { href: '#/internal/links/' + l.id }, l.title)), h('td', { class: 'small' }, fmtDateTime(l.link_expires_at)), h('td', {}, l.started), h('td', {}, l.completed))), 'No active links.')),
      h('div', { class: 'card' }, h('h2', {}, 'Links expiring within 7 days'), tableOf(['Assessment', 'Expires'],
        d.expiringLinks.map((l) => h('tr', {}, h('td', {}, h('a', { href: '#/internal/links/' + l.id }, l.title)), h('td', { class: 'small' }, fmtDateTime(l.link_expires_at)))), 'None.'))));
}

// ---- staff -----------------------------------------------------------------------

async function renderStaffPage(id) {
  if (id) return renderStaffMember(id);
  const search = h('input', { type: 'search', placeholder: 'Search name, employee ID, phone, email', class: 'inline-input' });
  const dept = h('select', { class: 'inline-input' });
  const status = select('status', [['', 'All statuses'], ['Active', 'Active'], ['Inactive', 'Inactive']], '');
  status.classList.add('inline-input');
  const box = h('div');
  let first = true;
  const load = async () => {
    const d = await api('GET', `/internal/staff?q=${encodeURIComponent(search.value)}&department=${encodeURIComponent(dept.value)}&status=${status.value}`);
    if (first) { dept.replaceChildren(h('option', { value: '' }, 'All departments'), ...d.departments.map((x) => h('option', { value: x }, x))); first = false; }
    box.replaceChildren(tableOf(['Staff Name', 'Employee ID', 'Department', 'Position', 'Phone', 'Email', 'Status', 'Assessments', 'Last result', 'Created'],
      d.staff.map((s) => h('tr', {},
        h('td', {}, h('a', { href: '#/internal/staff/' + s.id }, h('strong', {}, s.name))), h('td', {}, s.employee_id), h('td', {}, fmt(s.department)), h('td', {}, fmt(s.position)),
        h('td', {}, fmt(s.phone)), h('td', {}, fmt(s.email)), h('td', {}, h('span', { class: 'badge ' + (s.status === 'Active' ? 'pass' : 'neutral') }, s.status)),
        h('td', {}, s.assessments), h('td', {}, s.last_result ? resultBadge(s.last_result) : '-'), h('td', { class: 'small' }, fmtDate(s.created_at)))), 'No staff found.'));
  };
  search.addEventListener('input', () => load());
  dept.addEventListener('change', load);
  status.addEventListener('change', load);
  view().replaceChildren(
    internalHeader('Staff', h('button', { type: 'button', onclick: () => editStaff(null, load) }, 'Add staff')),
    h('div', { class: 'card' }, h('div', { class: 'row' }, search, dept, status),
      h('p', { class: 'muted small' }, 'Existing employees. They are never recruitment candidates. An employee who starts an internal assessment link with an Employee ID listed here is linked to this record; a new Employee ID creates a new staff record.'),
      box));
  await load();
}

function editStaff(s, onSaved) {
  const form = h('form', { class: 'grid' },
    field('Staff Name', h('input', { name: 'name', value: s ? s.name : '', required: true, maxlength: 200 })),
    field('Employee ID', h('input', { name: 'employee_id', value: s ? s.employee_id : '', required: true, maxlength: 200 })),
    field('Department', h('input', { name: 'department', value: s ? s.department : '' })),
    field('Position / Job Title', h('input', { name: 'position', value: s ? s.position : '' })),
    field('Phone Number', h('input', { name: 'phone', value: s ? s.phone : '', type: 'tel' })),
    field('Email', h('input', { name: 'email', value: s ? s.email : '', type: 'email' })),
    field('Status', select('status', [['Active', 'Active'], ['Inactive', 'Inactive']], s ? s.status : 'Active')),
    h('div', { class: 'wide' }, h('button', { type: 'submit' }, 'Save')));
  const close = modal(s ? 'Edit staff — ' + s.name : 'Add staff', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (s) await api('PUT', '/internal/staff/' + s.id, formValues(form));
      else await api('POST', '/internal/staff', formValues(form));
      close();
      onSaved();
    } catch (ex) { flash(form.parentElement, ex.message); }
  });
}

async function renderStaffMember(id) {
  const { staff: s, results } = await api('GET', '/internal/staff/' + id);
  const del = h('button', { type: 'button', class: 'danger small', onclick: async () => {
    if (!confirm(`Delete ${s.name}? Their ${s.assessments} assessment result(s) are deleted too.`)) return;
    try { await api('DELETE', '/internal/staff/' + s.id); location.hash = '#/internal/staff'; } catch (ex) { alert(ex.message); }
  } }, 'Delete');
  view().replaceChildren(
    h('p', {}, h('a', { href: '#/internal/staff' }, '< All staff')),
    internalHeader(s.name, h('button', { type: 'button', class: 'secondary small', onclick: () => editStaff(s, route) }, 'Edit'), del),
    h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'kv' }, h('tbody', {},
      ...[['Employee ID', s.employee_id], ['Department', s.department], ['Position / Job Title', s.position], ['Phone Number', s.phone], ['Email', s.email],
        ['Status', s.status], ['Created', fmtDateTime(s.created_at)], ['Assessments', `${s.assessments} (${s.completed} completed)`]]
        .map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, fmt(v)))))))),
    h('div', { class: 'card' }, h('h2', {}, 'Assessment results'), resultsTable(results, 'No assessments yet.')));
}

// ---- assessment links -----------------------------------------------------------

async function renderStaffLinks(id) {
  if (id) return renderStaffLink(id);
  const [settings, counts, laoCounts, list] = await Promise.all([api('GET', '/settings'), api('GET', '/questions/counts'), api('GET', '/questions/counts?language=lo'), api('GET', '/internal/links')]);
  const TESTS = TEST_TYPES.filter((t) => t.active && t.in_assessments).map((t) => t.key);
  const defaultPass = (sec) => (PASS_SETTING[sec] ? settings[PASS_SETTING[sec]] : (typeOf(sec) || {}).pass_mark ?? 60);
  const testsBox = h('div', { class: 'wide tests-box' },
    h('label', {}, 'Tests Included (taken one by one in this order)'),
    TESTS.map((sec) => {
      const has = counts[sec] > 0;
      return h('div', { class: 'test-row' },
        h('label', { class: 'test-name' }, h('input', { type: 'checkbox', name: 'test_' + sec, disabled: !has }), ' ' + TYPE_LABEL[sec]),
        has ? h('span', { class: 'row small' },
          h('input', { name: 'count_' + sec, type: 'number', min: 1, max: counts[sec], value: Math.min(counts[sec], sec === 'IQ' ? 18 : isEssayType(sec) ? 1 : 10), class: 'inline-input small-num' }), 'questions',
          h('input', { name: 'minutes_' + sec, type: 'number', min: 1, max: 600, value: settings.default_time_minutes, class: 'inline-input small-num' }), 'minutes · pass at',
          h('input', { name: 'pass_' + sec, type: 'number', min: 0, max: 100, step: 'any', value: defaultPass(sec), class: 'inline-input small-num' }), '%',
          h('span', { class: 'muted' }, `(bank has ${counts[sec]}; Lao ready ${laoCounts[sec]})`))
          : h('span', { class: 'muted small' }, 'No active questions in the bank yet'));
    }));
  const week = new Date(Date.now() + 7 * 86400 * 1000);
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const output = h('div');
  const form = h('form', { class: 'grid' },
    field('Assessment Name', h('input', { name: 'title', required: true, maxlength: 200, placeholder: 'e.g. Finance team — October 2026' })),
    field('Description (optional)', h('input', { name: 'description', maxlength: 1000 })),
    field('Language', select('language', Object.entries(LANG_LABEL), settings.default_language)),
    field('Link expires (date and time)', h('input', { name: 'expires_at', type: 'datetime-local', value: local(week), required: true })),
    field('Reusable link', select('reusable', [['1', 'Yes — one link for many employees, each with their own session'], ['0', 'No — single use (one employee)']], '1')),
    testsBox,
    h('div', { class: 'wide' }, h('button', { type: 'submit' }, 'GENERATE INTERNAL STAFF LINK')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    const tests = TESTS.filter((sec) => v['test_' + sec]);
    if (!tests.length) return output.replaceChildren(message('Please tick at least one test.'));
    try {
      const l = await api('POST', '/internal/links', {
        title: v.title, description: v.description, language: v.language, reusable: v.reusable === '1', expires_at: new Date(v.expires_at).toISOString(), tests,
        counts: Object.fromEntries(tests.map((sec) => [sec, Number(v['count_' + sec])])), minutes: Object.fromEntries(tests.map((sec) => [sec, Number(v['minutes_' + sec])])),
        pass_marks: Object.fromEntries(tests.map((sec) => [sec, v['pass_' + sec]])),
      });
      const url = staffUrl(l);
      const copy = h('button', { type: 'button', onclick: () => copyText(url, copy) }, 'Copy Link');
      output.replaceChildren(h('div', { class: 'message ok' },
        h('strong', {}, 'INTERNAL STAFF ASSESSMENT CREATED'), h('br'),
        `Assessment Name: ${l.title}`, h('br'),
        `Tests Included: ${testsOf(l)}`, h('br'),
        `Expiry: ${fmtDateTime(l.link_expires_at)}`, h('br'),
        'Status: ', linkBadge(l.share_state), ` · ${l.reusable ? 'Reusable' : 'Single use'}`),
      h('div', { class: 'link-box' }, h('span', { class: 'internal-banner' }, 'INTERNAL STAFF LINK'), h('input', { value: url, readonly: true }), copy,
        h('a', { class: 'button secondary', href: '#/internal/links/' + l.id }, 'View'),
        h('button', { type: 'button', class: 'secondary', onclick: async (ev) => { await api('POST', `/internal/links/${l.id}/disable`); ev.target.disabled = true; ev.target.textContent = 'Disabled'; refresh(); } }, 'Disable')));
      refresh();
    } catch (ex) { output.replaceChildren(message(ex.message)); }
  });
  const listBox = h('div');
  const refresh = async () => listBox.replaceChildren(linksTable(await api('GET', '/internal/links'), refresh));
  listBox.replaceChildren(linksTable(list, refresh));
  view().replaceChildren(
    internalHeader('Assessment Links'),
    h('div', { class: 'card' }, h('h2', {}, 'Create Assessment Link'),
      h('p', { class: 'muted small' }, 'For existing employees only — separate from Recruitment links. Each employee who opens a reusable link gets their own session, own random questions, answers, timer and result. Disabling a link stops new sessions; results are kept.'),
      form, output),
    h('div', { class: 'card' }, h('h2', {}, 'Internal Staff Links'), listBox));
}

function linksTable(list, refresh) {
  const act = (fn) => async (e) => { e.target.disabled = true; try { await fn(); } catch (ex) { alert(ex.message); } refresh(); };
  return tableOf(['Assessment Name', 'Tests', 'Created', 'Expires', 'Status', 'Started', 'Completed', 'Actions'], list.map((l) => {
    const copy = h('button', { type: 'button', class: 'secondary small', onclick: () => copyText(staffUrl(l), copy) }, 'Copy');
    return h('tr', {},
      h('td', {}, h('a', { href: '#/internal/links/' + l.id }, h('strong', {}, l.title)), l.description ? h('div', { class: 'muted small' }, l.description) : null),
      h('td', { class: 'small' }, testsOf(l)), h('td', { class: 'small' }, fmtDateTime(l.created_at)), h('td', { class: 'small' }, fmtDateTime(l.link_expires_at)),
      h('td', {}, linkBadge(l.share_state), h('div', { class: 'muted small' }, l.reusable ? 'Reusable' : 'Single use')), h('td', {}, l.candidates), h('td', {}, l.finished),
      h('td', { class: 'nowrap' }, h('a', { class: 'button secondary small', href: '#/internal/links/' + l.id }, 'View'), ' ', copy, ' ',
        l.enabled ? h('button', { type: 'button', class: 'secondary small', onclick: act(() => api('POST', `/internal/links/${l.id}/disable`)) }, 'Disable')
          : h('button', { type: 'button', class: 'secondary small', onclick: act(() => api('POST', `/internal/links/${l.id}/enable`)) }, 'Enable'), ' ',
        l.candidates === 0 ? h('button', { type: 'button', class: 'secondary small', onclick: act(() => api('POST', `/internal/links/${l.id}/regenerate`)) }, 'Regenerate') : null));
  }), 'No internal staff links yet.');
}

async function renderStaffLink(id) {
  const { link: l, results } = await api('GET', '/internal/links/' + id);
  const url = staffUrl(l);
  const copy = h('button', { type: 'button', onclick: () => copyText(url, copy) }, 'Copy Link');
  view().replaceChildren(
    h('p', {}, h('a', { href: '#/internal/links' }, '< All internal staff links')),
    internalHeader(l.title,
      l.enabled ? h('button', { type: 'button', class: 'secondary small', onclick: async () => { await api('POST', `/internal/links/${l.id}/disable`); route(); } }, 'Disable')
        : h('button', { type: 'button', class: 'secondary small', onclick: async () => { await api('POST', `/internal/links/${l.id}/enable`); route(); } }, 'Enable')),
    h('div', { class: 'card' },
      h('div', { class: 'link-box' }, h('span', { class: 'internal-banner' }, 'INTERNAL STAFF LINK'), h('input', { value: url, readonly: true }), copy),
      h('p', { class: 'small' }, `Tests: ${testsOf(l)}`), l.description ? h('p', { class: 'small' }, l.description) : null,
      h('p', { class: 'small' }, 'Status: ', linkBadge(l.share_state), ` · ${l.reusable ? 'Reusable' : 'Single use'} · ${LANG_LABEL[l.language]} · expires ${fmtDateTime(l.link_expires_at)} · started ${l.candidates}, completed ${l.finished}`)),
    h('div', { class: 'card' }, h('h2', {}, 'Staff who used this link'), resultsTable(results, 'Nobody has started this link yet.')));
}

// ---- results & reports ---------------------------------------------------------------

function resultsTable(list, empty) {
  return tableOf(['Staff Name', 'Employee ID', 'Department', 'Position', 'Assessment', 'IQ Test Score', 'Behavioral Interview Test Score', 'Calculation Score', 'Essay Score', 'Pass / Not Pass', 'Date and Time', ''],
    list.map((r) => h('tr', {}, r.values.map((v, i) => (i === 0 ? h('td', {}, h('a', { href: '#/internal/results/' + r.id }, h('strong', {}, v)))
      : i === 9 ? h('td', {}, statusBadge(v)) : h('td', { class: i >= 5 ? 'nowrap' : null }, v))),
    h('td', { class: 'nowrap' }, downloadLink(`/internal/results/${r.id}/export.pdf`, 'PDF'), ' ', downloadLink(`/internal/results/${r.id}/export.docx`, 'Word'), ' ', downloadLink(`/internal/results/${r.id}/export.xlsx`, 'Excel')))), empty);
}

function resultFilters(onChange, withLinks) {
  const search = h('input', { type: 'search', placeholder: 'Search name or employee ID', class: 'inline-input' });
  const dept = h('select', { class: 'inline-input' }, h('option', { value: '' }, 'All departments'));
  const link = h('select', { class: 'inline-input' }, h('option', { value: '' }, 'All assessments'));
  const status = select('status', [['', 'All results'], ['Pass', 'PASS'], ['Not Pass', 'NOT PASS'], ['Pending', 'Pending HR marking'], ['IN_PROGRESS', 'In progress']], '');
  status.classList.add('inline-input');
  Promise.all([api('GET', '/internal/staff'), withLinks ? api('GET', '/internal/links') : []]).then(([s, links]) => {
    dept.append(...s.departments.map((d) => h('option', { value: d }, d)));
    link.append(...links.map((l) => h('option', { value: l.id }, l.title)));
  }).catch(() => {});
  const query = () => `department=${encodeURIComponent(dept.value)}&link_id=${link.value}&status=${encodeURIComponent(status.value)}&q=${encodeURIComponent(search.value)}`;
  for (const el of [dept, link, status]) el.addEventListener('change', () => onChange(query()));
  search.addEventListener('input', () => onChange(query()));
  return { row: h('div', { class: 'row' }, search, dept, withLinks ? link : null, status), query };
}

async function renderStaffResults(id) {
  if (id) return renderStaffResult(id);
  const box = h('div');
  const load = async (q = '') => box.replaceChildren(resultsTable((await api('GET', '/internal/results?' + q)).results, 'No internal staff results yet.'));
  const f = resultFilters(load, true);
  view().replaceChildren(
    internalHeader('Staff Results', downloadLink('/internal/export/results.xlsx', 'Export all (Excel)', '')),
    h('div', { class: 'card' }, f.row, h('p', { class: 'muted small' }, 'Internal Office Staff only (never recruitment candidates). Click a name for the detailed result, answers and essay marking.'), box));
  await load();
}

async function renderStaffResult(id) {
  const actions = h('div', { class: 'row' }, downloadLink(`/internal/results/${id}/export.pdf`, 'PDF'), downloadLink(`/internal/results/${id}/export.docx`, 'Word'), downloadLink(`/internal/results/${id}/export.xlsx`, 'Excel'));
  await renderAssessment(id, {
    apiBase: '/internal/results/', back: ['#/internal/results', '< All staff results'], title: 'Staff assessment result', linkHref: '#/internal/links/', actions,
    person: (d) => ['Staff', d.staff ? h('span', {}, h('a', { href: '#/internal/staff/' + d.staff.id }, d.staff.name), ` · ${d.staff.employee_id}` + (d.staff.department ? ` · ${d.staff.department}` : '') + (d.staff.position ? ` · ${d.staff.position}` : '')) : '-'],
  });
}

async function renderStaffReports() {
  const summary = h('div');
  const table = h('div');
  const exportLink = downloadLink('/internal/export/results.xlsx', 'Download Excel report', '');
  const load = async (q = '') => {
    const { results } = await api('GET', '/internal/results?' + q);
    exportLink.href = '/api/admin/internal/export/results.xlsx?' + q;
    const byDept = new Map();
    for (const r of results) {
      const k = r.values[2] === '—' ? 'No department' : r.values[2];
      const d = byDept.get(k) || { total: 0, completed: 0, pass: 0, fail: 0, pending: 0 };
      d.total++;
      if (r.status === 'SUBMITTED') d.completed++;
      if (r.values[9] === 'PASS') d.pass++; else if (r.values[9] === 'NOT PASS') d.fail++; else if (r.values[9] === 'PENDING') d.pending++;
      byDept.set(k, d);
    }
    summary.replaceChildren(tableOf(['Department', 'Assessments', 'Completed', 'PASS', 'NOT PASS', 'Pending HR marking'],
      [...byDept].map(([k, d]) => h('tr', {}, h('td', {}, h('strong', {}, k)), h('td', {}, d.total), h('td', {}, d.completed), h('td', {}, d.pass), h('td', {}, d.fail), h('td', {}, d.pending))), 'No results.'));
    table.replaceChildren(resultsTable(results, 'No results.'));
  };
  const f = resultFilters(load, true);
  view().replaceChildren(
    internalHeader('Staff Reports', exportLink),
    h('div', { class: 'card' }, f.row, h('p', { class: 'muted small' }, 'Reports contain Internal Office Staff records only. The Excel report follows the filters; each result also has its own PDF / Word / Excel.')),
    h('div', { class: 'card' }, h('h2', {}, 'By department'), summary),
    h('div', { class: 'card' }, h('h2', {}, 'Results'), table));
  await load();
}
