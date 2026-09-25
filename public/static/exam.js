'use strict';
// Candidate assessment page. The countdown here is only a display: the server
// holds the real deadline and refuses answers after it.

const TEXT = {
  en: {
    title: 'Assessment',
    intro: 'Please enter your information, then press Start.',
    rules: 'You have {m} minutes for {n} questions. The timer starts when you press Start and cannot be paused. Your answers are saved automatically. When the time runs out, the assessment is submitted automatically.',
    name: 'Candidate Name', phone: 'Phone Number', graduate_from: 'Graduate From', high_school: 'High School', college: 'College',
    university: 'University', school_name: 'School Name', subject: 'Subject', gpa: 'GPA / Mark',
    grad_options: ['', 'High School', 'College', 'University', 'Other'],
    start: 'Start Assessment',
    time_remaining: 'Time Remaining',
    question: 'Question', of: 'of', iq_title: 'LALCO IQ TEST',
    previous: 'Previous', next: 'Next', submit: 'Submit Assessment', submitting: 'Submitting...',
    type_answer: 'Type your answer here',
    confirm_submit: 'Submit your answers now? You cannot change them after submitting.',
    unanswered: 'You have {n} unanswered question(s).',
    submitted: 'Assessment Completed\n\nThank you.\nYour assessment has been submitted successfully.\nHR will review your results.',
    auto_submitted: 'Time is up.\nYour answers were submitted automatically.',
    already_submitted: 'This assessment has already been submitted.',
    expired: 'This assessment link has expired.\nPlease contact HR.',
    disabled: 'This assessment is currently unavailable.\nPlease contact HR.',
    not_found: 'This assessment link is not valid.\nPlease contact HR.',
    error: 'Something went wrong.\nPlease try again.',
    offline: 'Connection problem. Your answers will be saved when the connection returns.',
    name_required: 'Please enter your name.',
    phone_required: 'Please enter your phone number.',
    no_questions: 'This assessment has no questions yet.\nPlease contact HR.',
    sections: { IQ: 'IQ Test', GENERAL: 'General Test', CALCULATION: 'Calculation Test', ESSAY: 'Essay Test' },
    progress_title: 'Assessment Progress',
    tests_intro: 'This assessment has {n} tests, taken one by one. Each test has its own time limit, and you must pass each test to continue to the next one.',
    test_line: '{name}: {q} questions, {m} minutes',
    passed: '{name} Passed',
    next_test: 'Next Test',
    continue: 'Continue',
    next_rules: 'You have {m} minutes for {n} questions. The timer starts when you press Continue.',
    time_up_test: 'Time is up for this test. Your answers were submitted automatically.',
    submit_test: 'Submit Test',
    stopped: 'Thank you.\nYou did not meet the required score for this assessment.\nPlease contact HR.',
  },
  lo: {
    title: 'ການທົດສອບ',
    intro: 'ກະລຸນາປ້ອນຂໍ້ມູນຂອງທ່ານ, ຈາກນັ້ນກົດປຸ່ມເລີ່ມ.',
    rules: 'ທ່ານມີເວລາ {m} ນາທີ ສຳລັບ {n} ຄຳຖາມ. ເວລາຈະເລີ່ມນັບເມື່ອທ່ານກົດເລີ່ມ ແລະ ບໍ່ສາມາດຢຸດໄດ້. ຄຳຕອບຂອງທ່ານຈະຖືກບັນທຶກອັດຕະໂນມັດ. ເມື່ອໝົດເວລາ, ການທົດສອບຈະຖືກສົ່ງອັດຕະໂນມັດ.',
    name: 'ຊື່ ແລະ ນາມສະກຸນ', phone: 'ເບີໂທລະສັບ', graduate_from: 'ຈົບການສຶກສາຈາກ', high_school: 'ມັດທະຍົມຕອນປາຍ', college: 'ວິທະຍາໄລ',
    university: 'ມະຫາວິທະຍາໄລ', school_name: 'ຊື່ສະຖານການສຶກສາ', subject: 'ສາຂາວິຊາ', gpa: 'ຄະແນນສະເລ່ຍ (GPA)',
    grad_options: ['', 'ມັດທະຍົມຕອນປາຍ', 'ວິທະຍາໄລ', 'ມະຫາວິທະຍາໄລ', 'ອື່ນໆ'],
    start: 'ເລີ່ມການທົດສອບ',
    time_remaining: 'ເວລາທີ່ເຫຼືອ',
    question: 'ຄຳຖາມ', of: 'ຈາກ', iq_title: 'ແບບທົດສອບ IQ ຂອງ LALCO',
    previous: 'ກ່ອນໜ້າ', next: 'ຕໍ່ໄປ', submit: 'ສົ່ງຄຳຕອບ', submitting: 'ກຳລັງສົ່ງ...',
    type_answer: 'ພິມຄຳຕອບຂອງທ່ານບ່ອນນີ້',
    confirm_submit: 'ສົ່ງຄຳຕອບດຽວນີ້ບໍ່? ຫຼັງຈາກສົ່ງແລ້ວຈະບໍ່ສາມາດແກ້ໄຂໄດ້.',
    unanswered: 'ທ່ານຍັງບໍ່ໄດ້ຕອບ {n} ຄຳຖາມ.',
    submitted: 'ການປະເມີນສຳເລັດແລ້ວ\n\nຂອບໃຈ.\nການປະເມີນຂອງທ່ານໄດ້ຖືກສົ່ງສຳເລັດແລ້ວ.\nຝ່າຍບຸກຄະລາກອນ (HR) ຈະກວດຜົນຂອງທ່ານ.',
    auto_submitted: 'ໝົດເວລາແລ້ວ.\nຄຳຕອບຂອງທ່ານໄດ້ຖືກສົ່ງອັດຕະໂນມັດ.',
    already_submitted: 'ການທົດສອບນີ້ໄດ້ຖືກສົ່ງແລ້ວ.',
    expired: 'ລິ້ງການທົດສອບນີ້ໝົດອາຍຸແລ້ວ.\nກະລຸນາຕິດຕໍ່ຝ່າຍບຸກຄະລາກອນ (HR).',
    disabled: 'ການທົດສອບນີ້ບໍ່ສາມາດໃຊ້ໄດ້ໃນຂະນະນີ້.\nກະລຸນາຕິດຕໍ່ຝ່າຍບຸກຄະລາກອນ (HR).',
    not_found: 'ລິ້ງການທົດສອບນີ້ບໍ່ຖືກຕ້ອງ.\nກະລຸນາຕິດຕໍ່ຝ່າຍບຸກຄະລາກອນ (HR).',
    error: 'ເກີດຂໍ້ຜິດພາດ.\nກະລຸນາລອງໃໝ່ອີກຄັ້ງ.',
    offline: 'ການເຊື່ອມຕໍ່ມີບັນຫາ. ຄຳຕອບຈະຖືກບັນທຶກເມື່ອເຊື່ອມຕໍ່ໄດ້ອີກຄັ້ງ.',
    name_required: 'ກະລຸນາປ້ອນຊື່ຂອງທ່ານ.',
    phone_required: 'ກະລຸນາປ້ອນເບີໂທລະສັບ.',
    no_questions: 'ການທົດສອບນີ້ຍັງບໍ່ມີຄຳຖາມ.\nກະລຸນາຕິດຕໍ່ຝ່າຍບຸກຄະລາກອນ (HR).',
    sections: { IQ: 'ແບບທົດສອບ IQ', GENERAL: 'ແບບທົດສອບທົ່ວໄປ', CALCULATION: 'ແບບທົດສອບການຄິດໄລ່', ESSAY: 'ແບບທົດສອບການຂຽນ' },
    progress_title: 'ຄວາມຄືບໜ້າຂອງການປະເມີນ',
    tests_intro: 'ການປະເມີນນີ້ມີ {n} ແບບທົດສອບ, ເຮັດເທື່ອລະອັນ. ແຕ່ລະແບບທົດສອບມີເວລາຂອງຕົນເອງ ແລະ ທ່ານຕ້ອງຜ່ານແຕ່ລະແບບທົດສອບຈຶ່ງຈະໄປແບບທົດສອບຕໍ່ໄປໄດ້.',
    test_line: '{name}: {q} ຄຳຖາມ, {m} ນາທີ',
    passed: 'ທ່ານຜ່ານ{name}ແລ້ວ',
    next_test: 'ແບບທົດສອບຕໍ່ໄປ',
    continue: 'ສືບຕໍ່',
    next_rules: 'ທ່ານມີເວລາ {m} ນາທີ ສຳລັບ {n} ຄຳຖາມ. ເວລາຈະເລີ່ມນັບເມື່ອທ່ານກົດສືບຕໍ່.',
    time_up_test: 'ໝົດເວລາສຳລັບແບບທົດສອບນີ້. ຄຳຕອບຂອງທ່ານໄດ້ຖືກສົ່ງອັດຕະໂນມັດ.',
    submit_test: 'ສົ່ງແບບທົດສອບ',
    stopped: 'ຂອບໃຈ.\nທ່ານບໍ່ໄດ້ຄະແນນຕາມທີ່ກຳນົດສຳລັບການປະເມີນນີ້.\nກະລຸນາຕິດຕໍ່ຝ່າຍບຸກຄະລາກອນ (HR).',
  },
};

const token = decodeURIComponent(location.pathname.split('/').pop());
const root = document.getElementById('exam');
let T = TEXT.en;
let exam = null; // { questions, answers, deadline, current, candidateName }
let timerHandle = null;
let submitting = false;

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
// English only: "1 questions" -> "1 question".
const fillCount = (str, vars) => fill(str, vars).replace(/\b1 questions\b/g, '1 question');

async function call(method, path, body) {
  const res = await fetch('/api/exam/' + encodeURIComponent(token) + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, data };
}

function setLanguage(lang) {
  T = TEXT[lang] || TEXT.en;
  document.documentElement.lang = lang === 'lo' ? 'lo' : 'en';
  document.title = 'LALCO - ' + T.title;
}

function bigMessage(text, tests) {
  stopTimer();
  root.replaceChildren(h('div', { class: 'card big-message' }, text), tests && tests.length > 1 ? progressBox(tests) : null);
}

// ✓ done · → now / next · ○ later · ✗ not passed
function progressBox(tests) {
  const mark = { done: '✓', current: '→', next: '→', upcoming: '○', failed: '✗' };
  return h('div', { class: 'card progress-box' }, h('div', { class: 'progress' }, T.progress_title),
    tests.map((t) => h('div', { class: 'progress-item ' + t.status }, h('span', { class: 'mark' }, mark[t.status] || '○'), T.sections[t.section])));
}

// Between tests: the last one was passed; the next opens when the candidate is ready.
function renderNext(data) {
  stopTimer();
  submitting = false;
  exam = null;
  const button = h('button', { type: 'button' }, T.continue);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const r = await call('POST', '/continue');
      if (r.status === 400) { button.disabled = false; return bigMessage(T[r.data.error] || T.error); }
      show(r.data);
    } catch { button.disabled = false; bigMessage(T.error); }
  });
  root.replaceChildren(
    h('div', { class: 'card center' },
      data.auto_submitted ? h('p', { class: 'message error' }, T.time_up_test) : null,
      h('h1', { class: 'passed' }, '✓ ' + fill(T.passed, { name: T.sections[data.passed_section] })),
      h('p', {}, h('span', { class: 'muted' }, T.next_test + ': '), h('strong', {}, T.sections[data.next_section])),
      h('p', { class: 'message ok' }, fillCount(T.next_rules, { m: data.time_limit_minutes, n: data.question_count })),
      button),
    progressBox(data.tests));
}

// Handles any server reply that carries a state.
function show(data) {
  if (data.language) setLanguage(data.language);
  switch (data.state) {
    case 'ready': return renderStart(data);
    case 'in_progress': return renderExam(data);
    case 'next_test': return renderNext(data);
    // A test was not passed, so the assessment stopped there.
    case 'submitted': if (data.outcome === 'stopped') return bigMessage(T.stopped, data.tests);
      // "exam" is set when the candidate sat the test in this page.
      return bigMessage(!exam ? T.already_submitted : data.auto_submitted ? T.auto_submitted : T.submitted, data.tests);
    case 'expired': return bigMessage(T.expired);
    case 'disabled': return bigMessage(T.disabled);
    case 'not_found': return bigMessage(T.not_found);
    default: return bigMessage(T.error);
  }
}

// ---- start form -----------------------------------------------------------

function renderStart(data) {
  const c = data.candidate || {};
  const err = h('div', { class: 'message error hidden' });
  const input = (name, attrs) => h('div', { class: 'field' }, h('label', { for: name }, T[name]), h('input', { id: name, name, value: c[name] || '', ...attrs }));
  const grad = h('select', { id: 'graduate_from', name: 'graduate_from' },
    [...new Set([...T.grad_options, c.graduate_from || ''])].map((o) => h('option', { value: o, selected: o === (c.graduate_from || '') }, o || '-')));
  const button = h('button', { type: 'submit' }, T.start);
  const form = h('form', {},
    h('h1', {}, T.title),
    h('p', {}, T.intro),
    err,
    h('div', { class: 'grid' },
      input('name', { required: true, autocomplete: 'name' }),
      input('phone', { required: true, type: 'tel', autocomplete: 'tel' }),
      h('div', { class: 'field' }, h('label', { for: 'graduate_from' }, T.graduate_from), grad),
      input('high_school'), input('college'), input('university'), input('school_name'), input('subject'), input('gpa')),
    (data.tests || []).length > 1 ? h('div', { class: 'message ok section-gap' }, fill(T.tests_intro, { n: data.tests.length }),
      h('ol', {}, data.tests.map((t) => h('li', {}, fillCount(T.test_line, { name: T.sections[t.section], q: t.question_count, m: t.minutes }))))) : null,
    h('p', { class: 'message ok section-gap' }, fillCount(T.rules, { m: data.time_limit_minutes, n: data.question_count })),
    button);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries([...form.elements].filter((el) => el.name).map((el) => [el.name, el.value.trim()]));
    if (!body.name) return showErr(T.name_required);
    if (!body.phone) return showErr(T.phone_required);
    button.disabled = true;
    try {
      const r = await call('POST', '/start', body);
      if (r.status === 400) { button.disabled = false; return showErr(T[r.data.error] || T.error); }
      show(r.data);
    } catch { button.disabled = false; showErr(T.error); }
  });
  function showErr(text) { err.textContent = text; err.classList.remove('hidden'); }
  root.replaceChildren(h('div', { class: 'card' }, form));
}

// ---- exam -----------------------------------------------------------------

function renderExam(data) {
  exam = {
    questions: data.questions,
    answers: Object.fromEntries(data.questions.map((q) => [q.id, q.answer ?? ''])),
    deadline: Date.now() + data.remaining_seconds * 1000,
    current: exam && exam.section === data.section ? exam.current : 0,
    candidateName: data.candidate ? data.candidate.name : '',
    section: data.section,
    isIq: data.section === 'IQ',
    tests: data.tests || [],
  };
  submitting = false;
  startTimer();
  drawQuestion();
}

function startTimer() {
  stopTimer();
  const tick = () => {
    const left = Math.max(0, Math.round((exam.deadline - Date.now()) / 1000));
    const el = document.getElementById('timer');
    if (el) {
      el.textContent = `${T.time_remaining}: ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
      el.classList.toggle('low', left <= 60);
    }
    if (left <= 0) submit(true);
  };
  tick();
  timerHandle = setInterval(tick, 500);
}
function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }

const pendingSaves = {};
const offline = h('div', { class: 'message error hidden' }, '');

async function saveAnswer(id) {
  try {
    const r = await call('PUT', '/answer', { question_id: id, answer: exam.answers[id] });
    if (r.status === 409) return show(r.data);
    offline.classList.add('hidden');
    if (r.data.remaining_seconds != null) exam.deadline = Date.now() + r.data.remaining_seconds * 1000;
  } catch {
    offline.textContent = T.offline;
    offline.classList.remove('hidden');
  }
}
function queueSave(id, delay) {
  clearTimeout(pendingSaves[id]);
  pendingSaves[id] = setTimeout(() => { delete pendingSaves[id]; saveAnswer(id); }, delay);
}

function drawQuestion() {
  const qs = exam.questions;
  const q = qs[exam.current];
  let answerBox;
  if (q.kind === 'choice') {
    answerBox = h('div', {}, q.options.map((o, i) => {
      const letter = 'ABCDE'[i];
      const selected = exam.answers[q.id] === o.key;
      return h('label', { class: 'option' + (selected ? ' selected' : '') },
        h('input', { type: 'radio', name: 'answer', value: o.key, checked: selected, onchange: () => {
          exam.answers[q.id] = o.key;
          queueSave(q.id, 0);
          drawQuestion();
        } }),
        h('span', { class: 'letter' }, letter + '.'),
        h('span', { class: 'option-body' }, o.image ? h('img', { src: o.image, alt: letter, class: 'option-image' }) : null, o.text || null));
    }));
  } else {
    const box = h(q.kind === 'essay' ? 'textarea' : 'input', { placeholder: T.type_answer, value: exam.answers[q.id] || '', rows: q.kind === 'essay' ? 10 : null });
    if (q.kind === 'essay') box.value = exam.answers[q.id] || '';
    box.addEventListener('input', () => { exam.answers[q.id] = box.value; queueSave(q.id, 800); });
    answerBox = box;
  }

  const go = (i) => { exam.current = i; drawQuestion(); window.scrollTo(0, 0); };
  const last = exam.current === qs.length - 1;
  root.replaceChildren(
    h('div', { class: 'exam-head' },
      h('div', {}, h('div', { class: 'exam-title' }, exam.isIq ? T.iq_title : T.sections[exam.section]), h('strong', {}, exam.candidateName)),
      h('div', { id: 'timer', class: 'timer' })),
    offline,
    h('div', { class: 'card' },
      h('div', { class: 'progress' }, `${T.question} ${exam.current + 1} ${T.of} ${qs.length}`),
      h('div', { class: 'question-text' }, q.text),
      q.image ? h('img', { src: q.image, alt: '', class: 'question-image' }) : null,
      answerBox,
      h('div', { class: 'exam-nav' },
        h('button', { type: 'button', class: 'secondary', disabled: exam.current === 0, onclick: () => go(exam.current - 1) }, T.previous),
        last ? null : h('button', { type: 'button', onclick: () => go(exam.current + 1) }, T.next)),
      h('div', { class: 'dots' }, qs.map((item, i) => h('button', {
        type: 'button',
        class: (i === exam.current ? 'current' : '') + (exam.answers[item.id] ? ' answered' : ''),
        onclick: () => go(i),
      }, i + 1)))),
    h('div', { class: 'center' }, h('button', { type: 'button', id: 'submit', onclick: () => submit(false) }, exam.tests.length > 1 ? T.submit_test : T.submit)),
    exam.tests.length > 1 ? progressBox(exam.tests) : null);
  // Refresh the timer text immediately so it never flashes empty.
  const left = Math.max(0, Math.round((exam.deadline - Date.now()) / 1000));
  document.getElementById('timer').textContent = `${T.time_remaining}: ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
}

async function submit(auto) {
  if (submitting) return;
  if (!auto) {
    const missing = exam.questions.filter((q) => !exam.answers[q.id]).length;
    const note = missing ? fill(T.unanswered, { n: missing }) + '\n\n' : '';
    if (!confirm(note + T.confirm_submit)) return;
  }
  submitting = true;
  stopTimer();
  Object.values(pendingSaves).forEach(clearTimeout);
  const btn = document.getElementById('submit');
  if (btn) { btn.disabled = true; btn.textContent = T.submitting; }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await call('POST', '/submit', { answers: exam.answers });
      return show(r.data.state ? r.data : { state: 'error' });
    } catch {
      offline.textContent = T.offline;
      offline.classList.remove('hidden');
      await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
    }
  }
  bigMessage(T.error);
}

// Record when the candidate leaves the page (switches tab or app).
let lastFocusReport = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || !exam || submitting) return;
  if (Date.now() - lastFocusReport < 3000) return;
  lastFocusReport = Date.now();
  call('POST', '/focus-lost').catch(() => {});
});

(async function init() {
  try {
    const r = await call('GET', '');
    show(r.data.state ? r.data : { state: 'error' });
  } catch {
    bigMessage(T.error);
  }
})();
