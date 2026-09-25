// Public candidate API. The unguessable link token is the only credential.
// Error codes (not sentences) are returned so the page can show them in the
// assessment's language.
const express = require('express');
const { db } = require('../db');
const A = require('../assessments');

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

function stateResponse(a) {
  const state = A.linkState(a);
  const base = { state, language: a.language, assessment_type: a.assessment_type, time_limit_minutes: a.time_limit_minutes };
  if (state === 'ready') {
    const sections = JSON.parse(a.sections);
    base.question_count = Object.values(sections).reduce((s, n) => s + n, 0);
    if (a.candidate_id) {
      const c = db.prepare(`SELECT ${PREFILL.join(', ')} FROM candidates WHERE id = ?`).get(a.candidate_id);
      if (c) base.candidate = c;
    }
  }
  if (state === 'in_progress') {
    const c = db.prepare('SELECT name FROM candidates WHERE id = ?').get(a.candidate_id);
    base.candidate = { name: c ? c.name : '' };
    base.remaining_seconds = Math.max(0, Math.floor((Date.parse(a.deadline_at) - Date.now()) / 1000));
    base.questions = db.prepare('SELECT * FROM assessment_questions WHERE assessment_id = ? ORDER BY position').all(a.id).map((q) => {
      const order = JSON.parse(q.option_order);
      return {
        id: q.id,
        section: q.section,
        text: q.question_text,
        kind: q.section === 'ESSAY' ? 'essay' : order.length ? 'choice' : 'short',
        // Options in this candidate's shuffled order; the key is the original
        // letter, which tells the browser nothing about which one is correct.
        options: order.map((L) => ({ key: L, text: q['option_' + L.toLowerCase()] })),
        answer: q.answer,
      };
    });
  }
  if (state === 'submitted') base.auto_submitted = !!a.auto_submitted;
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

router.put('/:token/answer', (req, res) => {
  const a = loadFresh(req);
  if (!a) return res.status(404).json({ state: 'not_found' });
  const state = A.linkState(a);
  if (state !== 'in_progress') return res.status(409).json(stateResponse(a));
  if (!A.saveAnswer(a, req.body?.question_id, req.body?.answer)) return res.status(400).json({ error: 'unknown_question' });
  res.json({ ok: true, remaining_seconds: Math.max(0, Math.floor((Date.parse(a.deadline_at) - Date.now()) / 1000)) });
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
