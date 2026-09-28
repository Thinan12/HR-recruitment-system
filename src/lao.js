// Lao translations of the question bank.
//
// English stays the source; the Lao text is stored next to it on the same
// question (same id, options, correct letter, level and marks). Candidates
// only ever read stored text: nothing here runs during an exam.
//
// Automatic translation is optional. It is used only when ANTHROPIC_API_KEY
// is set on the server (never sent to the browser); without it, Lao text is
// entered by HR (Edit Lao, or Lao columns in an import file).
const { db, now, audit, LAO_COLUMNS } = require('./db');

const LETTERS = ['a', 'b', 'c', 'd', 'e'];
// Ready = may be shown in a Lao assessment.
const READY = ['translated', 'reviewed'];
const STATUSES = ['', 'translated', 'reviewed', 'needs_review', 'failed'];
const STATUS_LABEL = { '': 'English only (no Lao yet)', translated: 'Lao ready (auto-translated, not yet reviewed)', reviewed: 'Lao ready (reviewed by HR)',
  needs_review: 'Needs review', failed: 'Translation failed' };
const LAO_READY_SQL = `lo_status IN ('translated', 'reviewed') AND question_text_lo != ''`;

// Words used the same way everywhere (from the candidate page's approved Lao).
const TERMS = {
  Question: 'ຄຳຖາມ', Answer: 'ຄຳຕອບ', 'Choose / Select': 'ເລືອກ', Calculate: 'ຄິດໄລ່', Next: 'ຕໍ່ໄປ', Previous: 'ກ່ອນໜ້າ',
  'odd one out': 'ອັນທີ່ແຕກຕ່າງຈາກອັນອື່ນ', 'comes next': 'ມາຕໍ່ໄປ', figure: 'ຮູບ', shape: 'ຮູບຮ່າງ', grid: 'ຕາຕະລາງ', sequence: 'ລຳດັບ', marks: 'ຄະແນນ',
};

// ---- checks -------------------------------------------------------------------

const numbersIn = (s) => (String(s || '').match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,(?=\d{3}\b)/g, '')).sort();
const SYMBOLS = ['×', '÷', '=', '+', '√', '²', '³', '%', '°', '$', '▲', '●', '■', '★', '→', '←', '↑', '↓', '½', '!', '−'];
const symbolsIn = (s) => SYMBOLS.map((c) => String(s || '').split(c).length - 1).join(',');
const hasLao = (s) => /[຀-໿]/.test(String(s || ''));

// Problems that stop a Lao translation from being used. Returns [] when it is fine.
function laoProblems(q, lo) {
  const problems = [];
  const text = String(lo.question_text_lo ?? '').trim();
  if (!text) problems.push('The Lao question is empty.');
  for (const L of LETTERS) {
    const en = String(q['option_' + L] || '').trim();
    const t = String(lo['option_' + L + '_lo'] ?? '').trim();
    if (en && !t) problems.push(`Option ${L.toUpperCase()} has no Lao text.`);
    if (!en && t) problems.push(`Option ${L.toUpperCase()} has Lao text but no English option.`);
    if (en && t && numbersIn(en).join() !== numbersIn(t).join()) problems.push(`Option ${L.toUpperCase()}: the numbers differ from English (${numbersIn(en).join(', ') || 'none'}).`);
  }
  if (text) {
    if (numbersIn(q.question_text).join() !== numbersIn(text).join()) problems.push(`The numbers in the Lao question differ from English (English has ${numbersIn(q.question_text).join(', ') || 'none'}).`);
    if (symbolsIn(q.question_text) !== symbolsIn(text)) problems.push('The Lao question changes a symbol or operator (× ÷ = + % ° $ ² √ ▲ ● → …).');
    if (/[A-Za-z]{3,}/.test(q.question_text) && !hasLao(text)) problems.push('The Lao question contains no Lao text.');
  }
  const all = [text, ...LETTERS.map((L) => lo['option_' + L + '_lo'])].join(' ');
  if (/<\s*\/?\s*[a-z!]/i.test(all)) problems.push('The Lao text contains HTML.');
  if (/�/.test(all)) problems.push('The Lao text contains broken characters.');
  return problems;
}

const clean = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 20000);

// Saves Lao text for one question. status 'translated' / 'reviewed' are only
// accepted when the checks pass; anything can be saved as needs_review.
function saveLao(id, body, actor) {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!q) return { error: 'not_found' };
  const lo = Object.fromEntries(LAO_COLUMNS.map((c) => [c, clean(body[c])]));
  const status = STATUSES.includes(body.lo_status) ? body.lo_status : 'translated';
  const problems = laoProblems(q, lo);
  if (READY.includes(status) && problems.length) return { error: problems.join(' ') };
  const stamp = now();
  db.prepare(`UPDATE questions SET ${LAO_COLUMNS.map((c) => `${c} = @${c}`).join(', ')}, lo_status = @status, lo_note = @note,
    lo_translated_at = @stamp, lo_reviewed_at = CASE WHEN @status = 'reviewed' THEN @stamp ELSE lo_reviewed_at END WHERE id = @id`)
    .run({ ...lo, status, note: clean(body.lo_note).slice(0, 1000), stamp, id });
  audit(status === 'reviewed' ? 'LAO_TRANSLATION_REVIEWED' : 'LAO_TRANSLATION_SAVED', actor, { question_id: id, status });
  return { question: db.prepare('SELECT * FROM questions WHERE id = ?').get(id) };
}

// When HR changes the English of a question, its Lao may no longer match.
function markStale(before, after) {
  if (!READY.includes(before.lo_status)) return;
  const fields = ['question_text', ...LETTERS.map((L) => 'option_' + L)];
  if (fields.some((f) => String(before[f] || '') !== String(after[f] || ''))) {
    db.prepare("UPDATE questions SET lo_status = 'needs_review', lo_note = 'The English was changed after this Lao translation. Please check the Lao.' WHERE id = ?").run(after.id);
  }
}

// Counts per test area: all, Lao ready, needs review, failed, no Lao yet.
function laoCounts() {
  const out = {};
  for (const r of db.prepare(`SELECT section, COUNT(*) AS total, SUM(${LAO_READY_SQL}) AS ready, SUM(lo_status = 'reviewed') AS reviewed,
    SUM(lo_status = 'needs_review') AS needs_review, SUM(lo_status = 'failed') AS failed, SUM(lo_status = '') AS missing
    FROM questions WHERE status = 'Active' GROUP BY section`).all()) out[r.section] = r;
  return out;
}

// ---- automatic translation (optional) ------------------------------------------

const SYSTEM = `You translate recruitment test questions from English into natural, professional Lao for LALCO (a Lao company).
Rules:
- Translate only the natural-language words. Keep EXACTLY unchanged: all numbers (Arabic digits, never Lao digits), decimals, percentages, currency, units (km, kg, cm, °C, kip), equations, operators and symbols (× ÷ = + − √ ² % ° $ ▲ ● ■ ★ → ! : ::), letter sequences and codes (e.g. "A, C, E, G, ?", "PEN = QFO", "3-1-20"), and the question mark placeholders.
- Never change the meaning, the facts, the logic, the difficulty or which option is correct. Do not fix or improve the question.
- Options: translate each option separately, same letter, same order. An option that is only a number, symbol, letter or code stays exactly as it is.
- Names of people, places and brands: normal Lao transliteration; for well-known people add the English in brackets, e.g. ອັນເບີດ ໄອນສະໄຕນ໌ (Albert Einstein).
- Use this terminology consistently: ${Object.entries(TERMS).map(([en, lo]) => `${en} = ${lo}`).join('; ')}.
- If the English itself looks wrong or unclear, still translate it faithfully and set "flag" to a short English note.
Reply with JSON only: an array of {"id": number, "question": string, "options": {"a": string, ...}, "flag": string}.`;

let provider = null;
if (process.env.ANTHROPIC_API_KEY) {
  provider = async (items) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.TRANSLATE_MODEL || 'claude-sonnet-5', max_tokens: 8000, system: SYSTEM,
          messages: [{ role: 'user', content: JSON.stringify(items) }] }),
      });
      if (!res.ok) throw new Error(`translation service answered ${res.status}`);
      const data = await res.json();
      const text = (data.content || []).map((c) => c.text || '').join('');
      return JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    } finally { clearTimeout(timer); }
  };
}
// Tests replace the provider with a fake one.
const setProvider = (fn) => { provider = fn; };
const hasProvider = () => !!provider;

const job = { running: false, total: 0, done: 0, translated: 0, failed: 0, started_at: null, finished_at: null, message: '' };

// Translates the given questions (default: every question with no Lao yet
// or a failed one) in batches of 10, in the background. A question that
// already has a Lao translation is never translated again.
function translateMissing(ids, actor = 'admin') {
  if (!provider) return { error: 'No automatic translation service is set up. Add ANTHROPIC_API_KEY to the Railway variables, or enter the Lao with "Edit Lao".' };
  if (job.running) return { job };
  const rows = ids
    ? db.prepare(`SELECT * FROM questions WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'}) AND lo_status IN ('', 'failed')`).all(...ids)
    : db.prepare("SELECT * FROM questions WHERE lo_status IN ('', 'failed') ORDER BY id").all();
  Object.assign(job, { running: true, total: rows.length, done: 0, translated: 0, failed: 0, started_at: now(), finished_at: null, message: '' });
  (async () => {
    for (let i = 0; i < rows.length; i += 10) {
      const batch = rows.slice(i, i + 10);
      const items = batch.map((q) => ({ id: q.id, type: q.section, question: q.question_text,
        options: Object.fromEntries(LETTERS.filter((L) => q['option_' + L]).map((L) => [L, q['option_' + L]])) }));
      let result = null;
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        try { result = await provider(items); } catch (e) { job.message = 'Last error: ' + e.message; }
      }
      for (const q of batch) {
        const t = Array.isArray(result) ? result.find((r) => Number(r.id) === q.id) : null;
        const fresh = db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id);
        if (!fresh || !['', 'failed'].includes(fresh.lo_status)) { job.done++; continue; } // edited meanwhile: keep HR's text
        const lo = t ? { question_text_lo: t.question, ...Object.fromEntries(LETTERS.map((L) => [`option_${L}_lo`, t.options?.[L] ?? ''])) } : null;
        const problems = lo ? laoProblems(fresh, lo) : ['The translation service gave no answer.'];
        if (lo && !problems.length) {
          saveLao(q.id, { ...lo, lo_status: t.flag ? 'needs_review' : 'translated', lo_note: t.flag ? 'Source Question Review Required: ' + t.flag : '' }, actor);
          job.translated++;
        } else {
          db.prepare("UPDATE questions SET lo_status = 'failed', lo_note = ? WHERE id = ?").run('Translation failed: ' + problems.join(' '), q.id);
          job.failed++;
        }
        job.done++;
      }
    }
    audit('LAO_BULK_TRANSLATED', actor, { total: job.total, translated: job.translated, failed: job.failed });
  })().catch((e) => { job.message = 'Stopped: ' + e.message; }).finally(() => { job.running = false; job.finished_at = now(); });
  return { job };
}

module.exports = { READY, STATUSES, STATUS_LABEL, LAO_READY_SQL, TERMS, laoProblems, saveLao, markStale, laoCounts, translateMissing, setProvider, hasProvider, job };
