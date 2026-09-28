// Public candidate API. Error codes (not sentences) are returned so the page
// can show them in the assessment's language.
//
// A shared link (assessment_links) is opened by many candidates at the same
// URL. Each browser gets a random secret in an HttpOnly cookie scoped to that
// link; the server stores only its SHA-256 on the candidate's own attempt.
// Every request works on the attempt found from link + cookie, never on an id
// sent by the browser. Older one-person links (an assessments.token without a
// link) work exactly as before: the token is the only credential.
const express = require('express');
const { db } = require('../db');
const A = require('../assessments');
const reports = require('../reports');
const images = require('../images');

const router = express.Router();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const COOKIE = 'lalco_candidate_session';
const SESSION_DAYS = 30;
const PREFILL = ['name', 'phone', 'graduate_from', 'high_school', 'college', 'university', 'school_name', 'subject', 'gpa'];

function readSecret(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      const v = decodeURIComponent(part.slice(i + 1).trim());
      return /^[A-Za-z0-9_-]{32,100}$/.test(v) ? v : null;
    }
  }
  return null;
}
// The cookie is only sent back to this link's API, so two links open in one
// browser never share a session.
function setSecret(res, token, secret) {
  res.cookie(COOKIE, secret, { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, maxAge: SESSION_DAYS * 86400 * 1000, path: '/api/exam/' + token });
}

// { link, a, secret }: the shared link (if the token is one) and the attempt
// of this browser's session; or { a } for an older one-person link.
function resolve(req) {
  const token = String(req.params.token || '');
  const link = A.linkByToken(token);
  if (!link) return { a: db.prepare('SELECT * FROM assessments WHERE token = ? AND link_id IS NULL').get(token) };
  const secret = readSecret(req);
  return { link, secret, a: A.attemptFor(link, secret) };
}

// If time has run out, submit it now so the candidate sees the final state.
function loadFresh(req) {
  const r = resolve(req);
  if (r.a && r.a.status === 'IN_PROGRESS' && A.isPastDeadline(r.a)) {
    A.finalize(r.a.id, true);
    r.a = A.getAssessment(r.a.id);
  }
  return r;
}

// The tests of this link and where the candidate is:
// done (passed) / failed / pending (essay waiting for HR) / current / next /
// upcoming (not started yet) / locked (an earlier test was not passed).
function progress(stages, state) {
  const firstWaiting = stages.find((st) => st.status === 'NOT_STARTED');
  const stopped = stages.some((st) => st.status === 'SUBMITTED' && st.result === 'Not Pass');
  return stages.map((st) => ({
    section: st.section,
    // The test's current name (HR can rename it) in English and Lao.
    title: A.T.title(st.section),
    title_lo: (A.T.get(st.section) || {}).name_lo || '',
    question_count: st.question_count,
    minutes: st.time_limit_minutes,
    status: st.status === 'IN_PROGRESS' ? 'current'
      : st.status === 'SUBMITTED' ? (st.result === 'Not Pass' ? 'failed' : st.result === 'Pending' ? 'pending' : 'done')
        : stopped ? 'locked' : st === firstWaiting && (state === 'next_test' || state === 'ready') ? 'next' : 'upcoming',
  }));
}

// The result of the test the candidate finished last: score, percentage,
// level, pass mark and PASS / NOT PASS (an essay waits for HR marking).
// Only finished tests are reported, never the answers.
function lastResult(a, stages) {
  const done = stages.filter((st) => st.status === 'SUBMITTED');
  const st = done[done.length - 1];
  if (!st) return null;
  const v = reports.stageView(a, st, stages);
  // The IQ percentage is for HR only and is not sent to the candidate.
  return { section: v.section, result: v.result, points: v.points, max: v.max, ...(v.section === 'IQ' ? {} : { percent: v.percent }), level: v.level,
    lalco_iq_score: v.lalco_iq_score, pass_mark: v.pass_mark,
    // The Lao name of the IQ classification (same bands, same source).
    ...(v.section === 'IQ' && v.lalco_iq_score != null ? { level_lo: reports.getIQClassification(v.lalco_iq_score)?.description_lo } : {}) };
}

// A shared link before this browser has started: the start form, fresh and
// empty for every new candidate (nobody's details are ever pre-filled).
function linkResponse(link) {
  const share = A.linkShareState(link);
  const view = A.linkView(link);
  const base = { state: share === 'open' ? 'ready' : share, shared: true, language: link.language, assessment_type: link.assessment_type,
    time_limit_minutes: link.time_limit_minutes };
  if (share !== 'open') return base;
  base.tests = progress(view.stages.map((st) => ({ ...st, status: 'NOT_STARTED' })), 'ready');
  base.question_count = view.stages[0].question_count;
  base.time_limit_minutes = view.stages[0].time_limit_minutes;
  base.current_stage = 'NOT_STARTED';
  return base;
}

function stateResponse(a) {
  const state = A.linkState(a);
  const base = { state, shared: !!a?.link_id, language: a?.language, assessment_type: a?.assessment_type, time_limit_minutes: a?.time_limit_minutes };
  if (state === 'not_found') return base;
  const stages = A.stagesOf(a);
  base.tests = progress(stages, state);
  // The server's view of where the candidate is: IQ / GENERAL / CALCULATION / ESSAY / COMPLETE / STOPPED.
  base.current_stage = A.currentStage(a, stages).key;
  if (state === 'ready') {
    base.question_count = stages[0].question_count;
    base.time_limit_minutes = stages[0].time_limit_minutes;
    if (a.candidate_id) {
      const c = db.prepare(`SELECT ${PREFILL.join(', ')} FROM candidates WHERE id = ?`).get(a.candidate_id);
      if (c) base.candidate = c;
    }
  }
  if (state === 'next_test') {
    const done = stages.filter((st) => st.status === 'SUBMITTED');
    const last = done[done.length - 1];
    base.passed_section = last.section;
    base.auto_submitted = !!last.auto_submitted;
    base.last_result = lastResult(a, stages);
    const next = stages.find((st) => st.status === 'NOT_STARTED');
    base.next_section = next.section;
    base.question_count = next.question_count;
    base.time_limit_minutes = next.time_limit_minutes;
  }
  if (state === 'in_progress') {
    const current = stages.filter((st) => st.status === 'IN_PROGRESS').map((st) => st.section);
    const c = db.prepare('SELECT name FROM candidates WHERE id = ?').get(a.candidate_id);
    base.candidate = { name: c ? c.name : '' };
    base.section = current[0];
    base.remaining_seconds = Math.max(0, Math.floor((Date.parse(a.deadline_at) - Date.now()) / 1000));
    // Pictures are fetched through the URL the candidate is using.
    const token = a.link_id ? A.getLink(a.link_id).token : a.token;
    const img = (id) => (id ? `/api/exam/${encodeURIComponent(token)}/images/${id}` : null);
    // Only the questions of the test that is running now.
    base.questions = db.prepare('SELECT * FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(a.id)
      .filter((q) => current.includes(q.section)).map((q) => {
        const order = JSON.parse(q.option_order);
        return {
          id: q.id,
          section: q.section,
          // Shown in the language saved with this candidate's copy (Lao or English).
          text: q.display_language === 'lo' && q.question_text_lo ? q.question_text_lo : q.question_text,
          image: img(q.image_id),
          kind: A.T.isEssay(q.section) ? 'essay' : order.length ? 'choice' : 'short',
          // Options in this candidate's shuffled order; the key is the original
          // letter, which tells the browser nothing about which one is correct.
          options: order.map((L) => ({ key: L, text: (q.display_language === 'lo' && q[`option_${L.toLowerCase()}_lo`]) || q['option_' + L.toLowerCase()], image: img(q[`option_${L.toLowerCase()}_image`]) })),
          answer: q.answer,
        };
      });
  }
  if (state === 'submitted') {
    base.auto_submitted = !!a.auto_submitted;
    // Stopped = a test was not passed, so the later tests were never opened.
    base.outcome = stages.some((st) => st.status === 'SUBMITTED' && st.result === 'Not Pass') ? 'stopped' : 'completed';
    base.last_result = lastResult(a, stages);
  }
  return base;
}

// What to send when a request needs an attempt this browser does not have.
function noAttempt(res, r) {
  if (r.link) return res.status(409).json(linkResponse(r.link));
  return res.status(404).json({ state: 'not_found' });
}

router.get('/:token', (req, res) => {
  const r = loadFresh(req);
  if (r.link && !r.a) {
    // Opening the link creates no record; the browser only receives its
    // session secret, used once the candidate presses Start.
    if (!r.secret) setSecret(res, r.link.token, A.newSessionSecret());
    return res.json(linkResponse(r.link));
  }
  if (!r.a) return res.status(404).json({ state: 'not_found' });
  res.json(stateResponse(r.a));
});

router.post('/:token/start', (req, res) => {
  const r = loadFresh(req);
  if (r.link && !r.a) {
    let secret = r.secret;
    if (!secret) { secret = A.newSessionSecret(); setSecret(res, r.link.token, secret); }
    try {
      return res.json(stateResponse(A.startFromLink(r.link, req.body, secret)));
    } catch (e) {
      if (e instanceof A.InputError) {
        if (e.message === 'link_closed') return res.status(409).json(linkResponse(A.getLink(r.link.id)));
        return res.status(400).json({ error: e.message });
      }
      throw e;
    }
  }
  const a = r.a;
  if (!a) return res.status(404).json({ state: 'not_found' });
  const state = A.linkState(a);
  if (state === 'in_progress') return res.json(stateResponse(a));
  if (state !== 'ready') return res.status(409).json(stateResponse(a));
  try {
    A.startAssessment(a, req.body);
  } catch (e) {
    if (e instanceof A.InputError) {
      if (e.message === 'already_started') return res.json(stateResponse(A.getAssessment(a.id)));
      return res.status(400).json({ error: e.message });
    }
    throw e;
  }
  res.json(stateResponse(A.getAssessment(a.id)));
});

router.post('/:token/continue', (req, res) => {
  const r = loadFresh(req);
  const a = r.a;
  if (!a) return noAttempt(res, r);
  const state = A.linkState(a);
  if (state === 'in_progress') return res.json(stateResponse(a));
  if (state !== 'next_test') return res.status(409).json(stateResponse(a));
  try {
    A.continueAssessment(a);
  } catch (e) {
    if (e instanceof A.InputError) return res.status(400).json({ error: e.message });
    throw e;
  }
  res.json(stateResponse(A.getAssessment(a.id)));
});

router.put('/:token/answer', (req, res) => {
  const r = loadFresh(req);
  const a = r.a;
  if (!a) return noAttempt(res, r);
  if (A.linkState(a) !== 'in_progress') return res.status(409).json(stateResponse(a));
  // saveAnswer only touches a question of THIS attempt's running test.
  if (!A.saveAnswer(a, req.body?.question_id, req.body?.answer)) return res.status(400).json({ error: 'unknown_question' });
  res.json({ ok: true, remaining_seconds: Math.max(0, Math.floor((Date.parse(a.deadline_at) - Date.now()) / 1000)) });
});

// A picture is only served to the candidate whose running test contains it.
const IMAGE_COLS = ['image_id', 'option_a_image', 'option_b_image', 'option_c_image', 'option_d_image', 'option_e_image'];
router.get('/:token/images/:id', (req, res) => {
  const { a } = loadFresh(req);
  const id = Number(req.params.id);
  if (!a || A.linkState(a) !== 'in_progress' || !Number.isInteger(id)) return res.status(404).json({ error: 'Not found.' });
  const used = db.prepare(`SELECT 1 FROM assessment_questions WHERE assessment_id = ? AND ? IN (${IMAGE_COLS.join(', ')})
    AND section IN (SELECT section FROM assessment_stages WHERE assessment_id = ? AND status = 'IN_PROGRESS') LIMIT 1`).get(a.id, id, a.id);
  if (!used) return res.status(404).json({ error: 'Not found.' });
  images.sendImage(res, id);
});

router.post('/:token/focus-lost', (req, res) => {
  const { a } = resolve(req);
  if (a && a.status === 'IN_PROGRESS') db.prepare('UPDATE assessments SET focus_losses = focus_losses + 1 WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

router.post('/:token/submit', (req, res) => {
  // Not loadFresh: a submit arriving a few seconds late must still get its answers saved.
  const r = resolve(req);
  const a = r.a;
  if (!a) return noAttempt(res, r);
  if (a.status === 'SUBMITTED') return res.status(409).json(stateResponse(a));
  if (A.linkState(a) !== 'in_progress') return res.status(409).json(stateResponse(a));
  A.submitAssessment(a, req.body?.answers);
  res.json(stateResponse(A.getAssessment(a.id)));
});

module.exports = router;
