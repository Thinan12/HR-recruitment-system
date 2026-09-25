// Public candidate API. The unguessable link token is the only credential.
// Error codes (not sentences) are returned so the page can show them in the
// assessment's language.
const express = require('express');
const { db } = require('../db');
const A = require('../assessments');
const images = require('../images');

const router = express.Router();

const PREFILL = ['name', 'phone', 'graduate_from', 'high_school', 'college', 'university', 'school_name', 'subject', 'gpa'];

function load(req) {
  return db.prepare('SELECT * FROM assessments WHERE token = ?').get(String(req.params.token || ''));
}

// If time has run out, submit it now so the candidate sees the final state.
function loadFresh(req) {
  let a = load(req);
  if (a && a.status === 'IN_PROGRESS' && A.isPastDeadline(a)) {
    A.finalize(a.id, true);
    a = load(req);
  }
  return a;
}

// The tests of this link and where the candidate is. Scores are not sent.
function progress(stages, state) {
  const firstWaiting = stages.find((st) => st.status === 'NOT_STARTED');
  return stages.map((st) => ({
    section: st.section,
    question_count: st.question_count,
    minutes: st.time_limit_minutes,
    status: st.status === 'IN_PROGRESS' ? 'current'
      : st.status === 'SUBMITTED' ? (st.result === 'Not Pass' ? 'failed' : 'done')
        : st === firstWaiting && (state === 'next_test' || state === 'ready') ? 'next' : 'upcoming',
  }));
}

function stateResponse(a) {
  const state = A.linkState(a);
  const base = { state, language: a.language, assessment_type: a.assessment_type, time_limit_minutes: a.time_limit_minutes };
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
    const imageUrl = (id) => (id ? `/api/exam/${encodeURIComponent(a.token)}/images/${id}` : null);
    // Only the questions of the test that is running now.
    base.questions = db.prepare('SELECT * FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(a.id)
      .filter((q) => current.includes(q.section)).map((q) => {
        const order = JSON.parse(q.option_order);
        return {
          id: q.id,
          section: q.section,
          text: q.question_text,
          image: imageUrl(q.image_id),
          kind: q.section === 'ESSAY' ? 'essay' : order.length ? 'choice' : 'short',
          // Options in this candidate's shuffled order; the key is the original
          // letter, which tells the browser nothing about which one is correct.
          options: order.map((L) => ({ key: L, text: q['option_' + L.toLowerCase()], image: imageUrl(q[`option_${L.toLowerCase()}_image`]) })),
          answer: q.answer,
        };
      });
  }
  if (state === 'submitted') {
    base.auto_submitted = !!a.auto_submitted;
    // Stopped = a test was not passed, so the later tests were never opened.
    base.outcome = stages.some((st) => st.status === 'SUBMITTED' && st.result === 'Not Pass') ? 'stopped' : 'completed';
  }
  return base;
}

router.get('/:token', (req, res) => {
  const a = loadFresh(req);
  if (!a) return res.status(404).json({ state: 'not_found' });
  res.json(stateResponse(a));
});

router.post('/:token/start', (req, res) => {
  const a = loadFresh(req);
  if (!a) return res.status(404).json({ state: 'not_found' });
  const state = A.linkState(a);
  if (state === 'in_progress') return res.json(stateResponse(a));
  if (state !== 'ready') return res.status(409).json(stateResponse(a));
  try {
    A.startAssessment(a, req.body);
  } catch (e) {
    if (e instanceof A.InputError) {
      if (e.message === 'already_started') return res.json(stateResponse(load(req)));
      return res.status(400).json({ error: e.message });
    }
    throw e;
  }
  res.json(stateResponse(load(req)));
});

router.post('/:token/continue', (req, res) => {
  const a = loadFresh(req);
  if (!a) return res.status(404).json({ state: 'not_found' });
  const state = A.linkState(a);
  if (state === 'in_progress') return res.json(stateResponse(a));
  if (state !== 'next_test') return res.status(409).json(stateResponse(a));
  try {
    A.continueAssessment(a);
  } catch (e) {
    if (e instanceof A.InputError) return res.status(400).json({ error: e.message });
    throw e;
  }
  res.json(stateResponse(load(req)));
});

router.put('/:token/answer', (req, res) => {
  const a = loadFresh(req);
  if (!a) return res.status(404).json({ state: 'not_found' });
  const state = A.linkState(a);
  if (state !== 'in_progress') return res.status(409).json(stateResponse(a));
  if (!A.saveAnswer(a, req.body?.question_id, req.body?.answer)) return res.status(400).json({ error: 'unknown_question' });
  res.json({ ok: true, remaining_seconds: Math.max(0, Math.floor((Date.parse(a.deadline_at) - Date.now()) / 1000)) });
});

// A picture is only served to the candidate whose running test contains it.
const IMAGE_COLS = ['image_id', 'option_a_image', 'option_b_image', 'option_c_image', 'option_d_image', 'option_e_image'];
router.get('/:token/images/:id', (req, res) => {
  const a = loadFresh(req);
  const id = Number(req.params.id);
  if (!a || A.linkState(a) !== 'in_progress' || !Number.isInteger(id)) return res.status(404).json({ error: 'Not found.' });
  const used = db.prepare(`SELECT 1 FROM assessment_questions WHERE assessment_id = ? AND ? IN (${IMAGE_COLS.join(', ')})
    AND section IN (SELECT section FROM assessment_stages WHERE assessment_id = ? AND status = 'IN_PROGRESS') LIMIT 1`).get(a.id, id, a.id);
  if (!used) return res.status(404).json({ error: 'Not found.' });
  images.sendImage(res, id);
});

router.post('/:token/focus-lost', (req, res) => {
  const a = load(req);
  if (a && a.status === 'IN_PROGRESS') db.prepare('UPDATE assessments SET focus_losses = focus_losses + 1 WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

router.post('/:token/submit', (req, res) => {
  // Not loadFresh: a submit arriving a few seconds late must still get its answers saved.
  const a = load(req);
  if (!a) return res.status(404).json({ state: 'not_found' });
  if (a.status === 'SUBMITTED') return res.status(409).json(stateResponse(a));
  if (A.linkState(a) !== 'in_progress') return res.status(409).json(stateResponse(a));
  A.submitAssessment(a, req.body?.answers);
  res.json(stateResponse(load(req)));
});

module.exports = router;
