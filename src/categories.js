// Question categories: a topic inside ONE test type (IQ, General,
// Calculation, Essay), e.g. IQ -> "Number Pattern". A category is metadata for
// HR (organising, filtering, bulk changes); it never changes a question's
// level, marks, answer, the random draw or any candidate's result.
//
// Each question keeps its category name in questions.category (as before)
// and the managed category in questions.category_id; both always match.
const { db, now, audit } = require('./db');

const T = require('./testTypes');
// Same name within one test type = same category: spaces trimmed / collapsed, case ignored.
const normalize = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const cleanName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);

class CategoryError extends Error {}

const byId = (id) => db.prepare('SELECT * FROM question_categories WHERE id = ?').get(Number(id));
const byName = (section, name) => db.prepare('SELECT * FROM question_categories WHERE section = ? AND normalized = ?').get(section, normalize(name));

// First start with this feature: every category name already used by a
// question becomes a managed category of that test type. Names are kept as
// they are; names that differ only in capitals or spaces are one category,
// spelled the way most questions spell it. Later starts only link questions
// that still have a name but no category (e.g. rows written by old code).
function migrate() {
  const rows = db.prepare("SELECT section, TRIM(category) AS name, COUNT(*) AS n FROM questions WHERE category_id IS NULL AND TRIM(category) != '' GROUP BY section, TRIM(category) ORDER BY n DESC").all();
  if (!rows.length) return;
  const stamp = now();
  const add = db.prepare('INSERT OR IGNORE INTO question_categories (section, name, normalized, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)');
  const link = db.prepare('UPDATE questions SET category_id = ?, category = ? WHERE section = ? AND category_id IS NULL AND TRIM(category) = ?');
  db.transaction(() => {
    for (const r of rows) add.run(r.section, cleanName(r.name), normalize(r.name), stamp, stamp); // most used spelling first wins
    for (const r of rows) {
      const c = byName(r.section, r.name);
      link.run(c.id, c.name, r.section, r.name);
    }
  })();
}

// Categories with their question counts. Filters: section, status (active /
// inactive / ''), q (search in English or Lao name).
function list({ section, status, q } = {}) {
  const where = [];
  const args = [];
  if (T.get(section)) { where.push('c.section = ?'); args.push(String(section).toUpperCase()); }
  if (status === 'active') where.push('c.active = 1');
  if (status === 'inactive') where.push('c.active = 0');
  if (q) { where.push('(c.name LIKE ? OR c.name_lo LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  return db.prepare(`SELECT c.*, COALESCE(SUM(qs.status = 'Active'), 0) AS active_questions, COALESCE(SUM(qs.status != 'Active'), 0) AS inactive_questions, COUNT(qs.id) AS questions
    FROM question_categories c LEFT JOIN questions qs ON qs.category_id = c.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY c.id ORDER BY c.section, c.active DESC, c.name COLLATE NOCASE`).all(...args);
}
const withCounts = (id) => list().find((c) => c.id === Number(id));

function create({ section, name, name_lo }, actor) {
  const sec = String(section || '').toUpperCase();
  if (!T.get(sec)) throw new CategoryError('Please choose the test type.');
  if (!T.get(sec).active) throw new CategoryError(`The ${T.name(sec)} test type is inactive; reactivate it to add categories.`);
  const clean = cleanName(name);
  if (!clean) throw new CategoryError('Please enter a category name.');
  const existing = byName(sec, clean);
  if (existing) throw new CategoryError(`${label(sec)} already has the category "${existing.name}"${existing.active ? '' : ' (inactive — reactivate it instead)'}.`);
  const stamp = now();
  const id = db.prepare('INSERT INTO question_categories (section, name, name_lo, normalized, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(sec, clean, String(name_lo ?? '').trim().slice(0, 100), normalize(clean), stamp, stamp).lastInsertRowid;
  audit('CATEGORY_CREATED', actor, { category_id: id, section: sec, name: clean });
  return withCounts(id);
}

// Rename (every question in it follows) and / or change the Lao name.
function update(id, { name, name_lo }, actor) {
  const c = byId(id);
  if (!c) return null;
  const clean = name === undefined ? c.name : cleanName(name);
  if (!clean) throw new CategoryError('Please enter a category name.');
  const other = byName(c.section, clean);
  if (other && other.id !== c.id) throw new CategoryError(`${label(c.section)} already has the category "${other.name}".`);
  db.transaction(() => {
    db.prepare('UPDATE question_categories SET name = ?, normalized = ?, name_lo = ?, updated_at = ? WHERE id = ?')
      .run(clean, normalize(clean), name_lo === undefined ? c.name_lo : String(name_lo).trim().slice(0, 100), now(), c.id);
    db.prepare('UPDATE questions SET category = ? WHERE category_id = ?').run(clean, c.id);
  })();
  if (clean !== c.name) audit('CATEGORY_RENAMED', actor, { category_id: c.id, from: c.name, to: clean });
  return withCounts(c.id);
}

// Remove: a category that questions use is only deactivated (they keep it);
// an unused one is deleted. Questions are never touched.
function remove(id, actor) {
  const c = withCounts(id);
  if (!c) return null;
  if (c.questions > 0) {
    db.prepare('UPDATE question_categories SET active = 0, updated_at = ? WHERE id = ?').run(now(), c.id);
    audit('CATEGORY_DEACTIVATED', actor, { category_id: c.id, questions: c.questions });
    return { deactivated: true, category: withCounts(c.id) };
  }
  db.prepare('DELETE FROM question_categories WHERE id = ?').run(c.id);
  audit('CATEGORY_DELETED', actor, { category_id: c.id, name: c.name });
  return { deleted: true };
}

function setActive(id, active, actor) {
  const c = byId(id);
  if (!c) return null;
  db.prepare('UPDATE question_categories SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, now(), c.id);
  audit(active ? 'CATEGORY_REACTIVATED' : 'CATEGORY_DEACTIVATED', actor, { category_id: c.id });
  return withCounts(c.id);
}

// The category a question may be given. `current` = the question's category
// today (keeping an inactive one on an existing question is allowed; choosing
// an inactive one is not). Returns { id, name } or { id: null, name: '' }.
function resolveForQuestion(section, { category_id, category, create_category }, current) {
  if (category_id !== undefined && category_id !== null && category_id !== '') {
    const c = byId(category_id);
    if (!c || c.section !== section) throw new CategoryError('That category does not belong to the ' + label(section) + ' test.');
    if (!c.active && c.id !== current) throw new CategoryError(`The category "${c.name}" is inactive and cannot be given to questions.`);
    return { id: c.id, name: c.name };
  }
  const name = cleanName(category);
  if (!name) return { id: null, name: '' };
  const c = byName(section, name);
  if (c) {
    if (!c.active && c.id !== current) throw new CategoryError(`The category "${c.name}" is inactive and cannot be given to questions.`);
    return { id: c.id, name: c.name };
  }
  if (create_category) { const made = create({ section, name }, 'admin'); return { id: made.id, name: made.name }; }
  throw new CategoryError(`Category "${name}" does not exist for ${label(section)}. Create it on the Categories page first, or choose an existing category.`);
}

// Changes only the category of the selected questions (never text, options,
// answer, level or marks). Questions of another test type are skipped.
function bulkAssign(ids, categoryId, actor) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger).slice(0, 5000);
  if (!list.length) throw new CategoryError('Please select at least one question.');
  let c = null;
  if (categoryId !== null && categoryId !== '' && categoryId !== undefined) {
    c = byId(categoryId);
    if (!c) throw new CategoryError('Category not found.');
    if (!c.active) throw new CategoryError(`The category "${c.name}" is inactive and cannot be given to questions.`);
  }
  let updated = 0;
  let skipped = 0;
  db.transaction(() => {
    const get = db.prepare('SELECT id, section FROM questions WHERE id = ?');
    const set = db.prepare('UPDATE questions SET category_id = ?, category = ? WHERE id = ?');
    for (const id of list) {
      const q = get.get(id);
      if (!q || (c && q.section !== c.section)) { skipped++; continue; }
      set.run(c ? c.id : null, c ? c.name : '', id);
      updated++;
    }
  })();
  audit('CATEGORY_BULK_SET', actor, { category_id: c ? c.id : null, updated, skipped });
  return { updated, skipped };
}

const label = (s) => T.name(s);

module.exports = { normalize, migrate, list, byId, byName, create, update, remove, setActive, resolveForQuestion, bulkAssign, CategoryError };
