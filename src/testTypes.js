// Test types (IQ, General, Calculation, Essay, and any HR adds). The key is
// stable and is what questions, stages and results store; the name, Lao
// title, order and status are HR's to change. What a test DOES depends on its
// format (behavior), never on its name:
//   iq          - IQ only: levels 1-5, weighted marks, LALCO IQ Score
//   mcq         - multiple choice (like General)
//   calculation - multiple choice or short answer
//   essay       - written answer, marked by HR
//   interview   - behavioural / interview question: written answer, marked by HR
//                 (no options, no correct answer; like essay, but its own format)
const { db, now, audit, getSettings, PASS_KEYS } = require('./db');

const CORE = [
  { key: 'IQ', name: 'IQ', name_lo: 'ແບບທົດສອບ IQ', behavior: 'iq', display_order: 1, description: 'LALCO IQ test (levels 1–5, weighted marks, LALCO IQ Score)' },
  { key: 'GENERAL', name: 'General', name_lo: 'ແບບທົດສອບທົ່ວໄປ', behavior: 'mcq', display_order: 2, description: 'General knowledge, multiple choice' },
  { key: 'CALCULATION', name: 'Calculation', name_lo: 'ແບບທົດສອບການຄິດໄລ່', behavior: 'calculation', display_order: 3, description: 'Calculation, multiple choice or short answer' },
  { key: 'ESSAY', name: 'Essay', name_lo: 'ແບບທົດສອບການຂຽນ', behavior: 'essay', display_order: 4, description: 'Written answer, marked by HR' },
];
const BEHAVIORS = ['mcq', 'calculation', 'essay', 'interview']; // formats HR can give a new test type (IQ is IQ only)

db.exec(`CREATE TABLE IF NOT EXISTS test_types (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_lo TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  behavior TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  in_assessments INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 100,
  pass_mark REAL NOT NULL DEFAULT 60,
  core INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
{
  const stamp = now();
  const add = db.prepare(`INSERT OR IGNORE INTO test_types (key, name, name_lo, description, behavior, display_order, core, created_at, updated_at)
    VALUES (@key, @name, @name_lo, @description, @behavior, @display_order, 1, @stamp, @stamp)`);
  for (const t of CORE) add.run({ ...t, stamp });
}

const all = () => db.prepare('SELECT * FROM test_types ORDER BY display_order, created_at, key').all();
const get = (key) => db.prepare('SELECT * FROM test_types WHERE key = ?').get(String(key || '').toUpperCase());
const keys = () => all().map((t) => t.key);
const activeKeys = () => all().filter((t) => t.active).map((t) => t.key);
const assessmentKeys = () => all().filter((t) => t.active && t.in_assessments).map((t) => t.key);
const behavior = (key) => (get(key) || {}).behavior || null;
// HR-marked written answers: essays and interview questions.
const HR_MARKED = ['essay', 'interview'];
const isEssay = (key) => HR_MARKED.includes(behavior(key));
const essayKeys = () => all().filter((t) => HR_MARKED.includes(t.behavior)).map((t) => t.key);
// The active type for behavioural / interview questions: the interview format first, then by name.
const interviewType = () => {
  const active = all().filter((t) => t.active);
  return (active.find((t) => t.behavior === 'interview') || active.find((t) => /behaviou?r|interview|ສໍາພາດ|ສຳພາດ/i.test(t.name)) || {}).key || null;
};
// "General" (short name) and "General Test" (title) for screens and exports.
const name = (key) => (get(key) || {}).name || String(key || '');
const title = (key) => { const n = name(key); return /\btest$/i.test(n) ? n : `${n} Test`; };
// Default pass mark for a new link: Settings for the four core tests, the type's own for the rest.
function defaultPassMark(key, settings = getSettings()) {
  if (PASS_KEYS[key] && settings[PASS_KEYS[key]] != null) return settings[PASS_KEYS[key]];
  return (get(key) || {}).pass_mark ?? 60;
}

const normalize = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
// Words people write for the core types, in English and Lao.
const ALIASES = {
  IQ: ['iq', 'iq test', 'intelligence', 'ໄອຄິວ', 'ແບບທົດສອບ iq'],
  GENERAL: ['general', 'general test', 'general knowledge', 'knowledge', 'ທົ່ວໄປ', 'ແບບທົດສອບທົ່ວໄປ'],
  CALCULATION: ['calculation', 'calculation test', 'calc', 'math', 'maths', 'mathematics', 'numerical', 'ຄິດໄລ່', 'ການຄິດໄລ່', 'ແບບທົດສອບການຄິດໄລ່'],
  ESSAY: ['essay', 'essay test', 'writing', 'written', 'ຂຽນ', 'ການຂຽນ', 'ບົດຄວາມ', 'ແບບທົດສອບການຂຽນ'],
};
// The type a file / form value means: its key, its name, its title, or a known alias.
function resolve(value) {
  const v = normalize(value);
  if (!v) return null;
  for (const t of all()) {
    if ([t.key, t.name, title(t.key), t.name_lo].some((x) => normalize(x) === v)) return t.key;
  }
  for (const [key, words] of Object.entries(ALIASES)) if (words.includes(v) && get(key)) return key;
  return null;
}

class TypeError_ extends Error {}

// A new key from the name: letters and digits, upper case ("Technical Test" -> TECHNICAL_TEST).
function newKey(nameValue) {
  let base = String(nameValue).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 30) || 'TYPE';
  if (['ALL', 'COMBINED', 'STOPPED', 'COMPLETE', 'NOT_STARTED'].includes(base)) base += '_TEST';
  let key = base;
  for (let i = 2; get(key); i++) key = `${base}_${i}`;
  return key;
}

function usage(key) {
  const k = String(key).toUpperCase();
  const n = (sql) => db.prepare(sql).get(k).n;
  return {
    questions: n('SELECT COUNT(*) AS n FROM questions WHERE section = ?'),
    active_questions: n("SELECT COUNT(*) AS n FROM questions WHERE section = ? AND status = 'Active'"),
    inactive_questions: n("SELECT COUNT(*) AS n FROM questions WHERE section = ? AND status != 'Active'"),
    categories: n('SELECT COUNT(*) AS n FROM question_categories WHERE section = ?'),
    assessments: n('SELECT COUNT(DISTINCT assessment_id) AS n FROM assessment_stages WHERE section = ?')
      + n('SELECT COUNT(DISTINCT assessment_id) AS n FROM assessment_questions WHERE section = ? AND assessment_id NOT IN (SELECT assessment_id FROM assessment_stages)'),
    links: db.prepare('SELECT COUNT(*) AS n FROM assessment_links WHERE stages LIKE ?').get(`%"section":"${k}"%`).n,
  };
}
const view = (t) => ({ ...t, title: title(t.key), ...usage(t.key) });
const list = () => all().map(view);

const cleanText = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
function checkName(nameValue, exceptKey) {
  const n = cleanText(nameValue, 60);
  if (!n) throw new TypeError_('Please enter the test type name.');
  if (/^all$/i.test(n)) throw new TypeError_('"All" is the Question Bank filter, not a test type.');
  const same = all().find((t) => t.key !== exceptKey && [t.name, title(t.key)].some((x) => normalize(x) === normalize(n)));
  if (same) throw new TypeError_(`The test type "${same.name}" already exists${same.active ? '' : ' (inactive — reactivate it instead)'}.`);
  return n;
}
function checkOrder(v, fallback) {
  if (v === undefined || v === '' || v === null) return fallback;
  const o = Number(v);
  if (!Number.isInteger(o) || o < 1 || o > 999) throw new TypeError_('Display order must be a whole number from 1 to 999.');
  return o;
}
function checkPass(v, fallback) {
  if (v === undefined || v === '' || v === null) return fallback;
  const p = Number(v);
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new TypeError_('Pass mark must be between 0 and 100%.');
  return p;
}

function create(input, actor) {
  const n = checkName(input.name);
  const b = String(input.behavior || 'mcq');
  if (!BEHAVIORS.includes(b)) throw new TypeError_('Please choose the question format: multiple choice, calculation, essay or behavioural / interview.');
  const key = newKey(n);
  const stamp = now();
  const order = checkOrder(input.display_order, Math.max(0, ...all().map((t) => t.display_order)) + 1);
  db.prepare(`INSERT INTO test_types (key, name, name_lo, description, behavior, active, in_assessments, display_order, pass_mark, core, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(key, n, cleanText(input.name_lo, 80), cleanText(input.description, 300), b, input.active === false || input.active === 0 ? 0 : 1,
      input.in_assessments === false || input.in_assessments === 0 ? 0 : 1, order, checkPass(input.pass_mark, 60), stamp, stamp);
  audit('TEST_TYPE_CREATED', actor, { key, name: n, behavior: b });
  return view(get(key));
}

// Name, Lao title, description, order, pass mark and "in assessments" can change;
// the key and the question format never do.
function update(key, input, actor) {
  const t = get(key);
  if (!t) return null;
  const n = input.name === undefined ? t.name : checkName(input.name, t.key);
  db.prepare('UPDATE test_types SET name = ?, name_lo = ?, description = ?, display_order = ?, pass_mark = ?, in_assessments = ?, updated_at = ? WHERE key = ?')
    .run(n, input.name_lo === undefined ? t.name_lo : cleanText(input.name_lo, 80), input.description === undefined ? t.description : cleanText(input.description, 300),
      checkOrder(input.display_order, t.display_order), checkPass(input.pass_mark, t.pass_mark),
      input.in_assessments === undefined ? t.in_assessments : input.in_assessments ? 1 : 0, now(), t.key);
  if (n !== t.name) audit('TEST_TYPE_RENAMED', actor, { key: t.key, from: t.name, to: n });
  return view(get(t.key));
}

function setActive(key, active, actor) {
  const t = get(key);
  if (!t) return null;
  if (!active && activeKeys().length === 1 && t.active) throw new TypeError_('At least one test type must stay active.');
  db.prepare('UPDATE test_types SET active = ?, updated_at = ? WHERE key = ?').run(active ? 1 : 0, now(), t.key);
  audit(active ? 'TEST_TYPE_REACTIVATED' : 'TEST_TYPE_DEACTIVATED', actor, { key: t.key });
  return view(get(t.key));
}

// Permanent removal only for a non-core type that nothing uses.
function remove(key, actor) {
  const t = get(key);
  if (!t) return null;
  if (t.core) throw new TypeError_('Core Test Type — Delete unavailable. You can deactivate it instead.');
  const u = usage(t.key);
  if (u.questions || u.categories || u.assessments || u.links) {
    throw new TypeError_('This Test Type is in use and cannot be permanently deleted. You can deactivate it instead.');
  }
  db.prepare('DELETE FROM test_types WHERE key = ?').run(t.key);
  audit('TEST_TYPE_DELETED', actor, { key: t.key, name: t.name });
  return { deleted: true };
}

module.exports = { CORE, BEHAVIORS, all, get, keys, activeKeys, assessmentKeys, behavior, isEssay, essayKeys, interviewType, HR_MARKED, name, title, defaultPassMark, resolve, usage, list, create, update, setActive, remove, TypeError: TypeError_ };
