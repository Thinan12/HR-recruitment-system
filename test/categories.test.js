// Question categories: a topic inside one test type, managed by HR.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { start, stop, client, db, upload, CANDIDATE, seedQuestions } = require('./helpers');
const categories = require('../src/categories');

let admin;
const now = () => new Date().toISOString();
const q = (id) => db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
const addRaw = db.prepare(`INSERT INTO questions (section, difficulty, category, question_text, option_a, option_b, correct_answer, marks, status, created_at)
  VALUES (?, ?, ?, ?, '1', '2', 'A', ?, ?, ?)`);

test.before(async () => {
  // Old free-text categories, as in production before this feature.
  addRaw.run('IQ', 'Easy', 'Odd One Out', 'Legacy odd 1', 1, 'Active', now());
  addRaw.run('IQ', 'Basic', 'Odd one out', 'Legacy odd 2', 2, 'Active', now());
  addRaw.run('IQ', 'Easy', 'Odd one out', 'Legacy odd 3', 1, 'Inactive', now());
  addRaw.run('IQ', 'Moderate', '  Number series ', 'Legacy series 1', 3, 'Active', now());
  addRaw.run('IQ', 'Moderate', 'Number Pattern', 'Legacy pattern 1', 3, 'Active', now());
  addRaw.run('GENERAL', '', '', 'Legacy general 1', 1, 'Active', now());
  categories.migrate();
  await start();
  admin = client();
  await admin.login();
});
test.after(stop);

const list = async (qs = '') => (await admin.get('/api/admin/categories' + qs)).data;
const find = async (section, name) => (await list()).find((c) => c.section === section && c.name === name);

test('migration: existing names become categories; case / space variants merge; nothing else is renamed', async () => {
  const iq = (await list('?section=IQ')).map((c) => [c.name, c.active_questions, c.inactive_questions]);
  assert.deepEqual(iq.sort(), [['Number Pattern', 1, 0], ['Number series', 1, 0], ['Odd one out', 2, 1]].sort(),
    '"Odd One Out" and "Odd one out" are one category (most-used spelling); "Number series" and "Number Pattern" stay separate');
  const odd = db.prepare("SELECT category, category_id FROM questions WHERE question_text LIKE 'Legacy odd%'").all();
  assert.equal(new Set(odd.map((r) => r.category_id)).size, 1);
  assert.ok(odd.every((r) => r.category === 'Odd one out'));
  assert.equal(db.prepare("SELECT category_id FROM questions WHERE question_text = 'Legacy general 1'").get().category_id, null, 'no category invented for questions without one');
  categories.migrate();
  assert.equal((await list()).length, 3, 'running the migration again adds nothing');
});

test('add, duplicate protection per test type (case / spaces ignored), edit, rename follows questions', async () => {
  const add = await admin.post('/api/admin/categories', { section: 'IQ', name: 'Verbal Reasoning', name_lo: 'ການໃຫ້ເຫດຜົນທາງພາສາ' });
  assert.equal(add.status, 201);
  assert.equal(add.data.name_lo, 'ການໃຫ້ເຫດຜົນທາງພາສາ');
  for (const dup of ['Verbal Reasoning', ' verbal reasoning ', 'VERBAL   REASONING']) {
    const r = await admin.post('/api/admin/categories', { section: 'IQ', name: dup });
    assert.equal(r.status, 400, dup);
    assert.match(r.data.error, /already has the category "Verbal Reasoning"/);
  }
  assert.equal((await admin.post('/api/admin/categories', { section: 'GENERAL', name: 'Verbal Reasoning' })).status, 201, 'the same name is fine in another test type');
  assert.equal((await admin.post('/api/admin/categories', { section: 'NOPE', name: 'X' })).status, 400);
  assert.equal((await admin.post('/api/admin/categories', { section: 'IQ', name: '  ' })).status, 400);

  const series = await find('IQ', 'Number series');
  assert.equal((await admin.put('/api/admin/categories/' + series.id, { name: 'number pattern' })).status, 400, 'renaming onto another category is refused');
  const r = await admin.put('/api/admin/categories/' + series.id, { name: 'Number Sequences' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT category FROM questions WHERE question_text = 'Legacy series 1'").get().category, 'Number Sequences', 'its questions follow the rename');
});

test('questions use managed categories: only active ones of the same test type; IQ level stays separate', async () => {
  const verbal = await find('IQ', 'Verbal Reasoning');
  const generalVerbal = await find('GENERAL', 'Verbal Reasoning');
  const base = { section: 'IQ', difficulty: 'Very Difficult', question_text: 'Category test Q?', option_a: 'x', option_b: 'y', correct_answer: 'B' };
  const made = await admin.post('/api/admin/questions', { ...base, category_id: verbal.id });
  assert.equal(made.status, 201);
  assert.deepEqual([made.data.category, made.data.category_id, made.data.difficulty, made.data.marks], ['Verbal Reasoning', verbal.id, 'Very Difficult', 5], 'Level 5 = 5 marks, whatever the category');
  assert.equal((await admin.post('/api/admin/questions', { ...base, question_text: 'Other', category_id: generalVerbal.id })).status, 400, 'a General category cannot go on an IQ question');
  const unknown = await admin.post('/api/admin/questions', { ...base, question_text: 'Other 2', category: 'Made Up' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error, /Category "Made Up" does not exist for IQ/);
  assert.equal((await admin.post('/api/admin/questions', { ...base, question_text: 'By name', category: ' verbal REASONING ' })).data.category_id, verbal.id, 'names match ignoring case / spaces');

  // Deactivate: questions keep it, it cannot be given to new questions; the question itself stays Active.
  const d = await admin.del('/api/admin/categories/' + verbal.id);
  assert.equal(d.data.deactivated, true);
  assert.equal(q(made.data.id).category_id, verbal.id);
  assert.equal(q(made.data.id).status, 'Active');
  const blocked = await admin.post('/api/admin/questions', { ...base, question_text: 'New after deactivate', category_id: verbal.id });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /inactive/);
  const keep = await admin.put('/api/admin/questions/' + made.data.id, { ...made.data, question_text: 'Category test Q, edited?', status: 'Active' });
  assert.equal(keep.status, 200, 'an existing question may keep its (now inactive) category');
  assert.equal((await admin.post('/api/admin/categories/' + verbal.id + '/activate')).data.active, 1);
  assert.equal((await admin.post('/api/admin/questions', { ...base, question_text: 'New after reactivate', category_id: verbal.id })).status, 201);
  assert.equal((await list('?section=IQ')).filter((c) => c.normalized === 'verbal reasoning').length, 1, 'reactivating creates no second category');

  // An unused category is removed outright.
  const temp = (await admin.post('/api/admin/categories', { section: 'ESSAY', name: 'Temporary' })).data;
  assert.deepEqual((await admin.del('/api/admin/categories/' + temp.id)).data, { deleted: true });
  assert.equal((await list()).some((c) => c.id === temp.id), false);
});

test('filter by category, counts, "no category", search and category detail', async () => {
  const odd = await find('IQ', 'Odd one out');
  const r = (await admin.get('/api/admin/questions?section=IQ&category=' + odd.id)).data;
  assert.equal(r.questions.length, 3);
  assert.ok(r.questions.every((x) => x.category_id === odd.id));
  assert.equal(r.categories.find((c) => c.id === odd.id).active_questions, 2);
  const none = (await admin.get('/api/admin/questions?category=none')).data.questions;
  assert.ok(none.length >= 1 && none.every((x) => x.category_id == null));
  assert.deepEqual((await list('?q=pattern')).map((c) => c.name), ['Number Pattern']);
  const detail = (await admin.get('/api/admin/categories/' + odd.id)).data;
  assert.equal(detail.questions.length, 3);
  assert.deepEqual([detail.category.active_questions, detail.category.inactive_questions], [2, 1]);
});

test('bulk Set Category changes only the category; other test types are skipped; inactive refused', async () => {
  const pattern = await find('IQ', 'Number Pattern');
  const ids = db.prepare("SELECT id FROM questions WHERE question_text LIKE 'Legacy odd%'").all().map((r) => r.id);
  const general = db.prepare("SELECT id FROM questions WHERE question_text = 'Legacy general 1'").get().id;
  const before = ids.map((id) => q(id));
  const r = await admin.post('/api/admin/questions/bulk-category', { ids: [...ids, general], category_id: pattern.id });
  assert.deepEqual(r.data, { updated: 3, skipped: 1 });
  for (const b of before) {
    const a = q(b.id);
    assert.equal(a.category_id, pattern.id);
    for (const k of ['question_text', 'option_a', 'option_b', 'correct_answer', 'difficulty', 'marks', 'status', 'section']) assert.equal(a[k], b[k], k);
  }
  assert.equal(q(general).category_id, null);
  const cleared = await admin.post('/api/admin/questions/bulk-category', { ids: [ids[0]], category_id: null });
  assert.equal(cleared.data.updated, 1);
  assert.equal(q(ids[0]).category_id, null);
  assert.equal(q(ids[0]).category, '');
  await admin.post('/api/admin/questions/bulk-category', { ids: [ids[0]], category_id: pattern.id });
  const off = (await admin.post('/api/admin/categories', { section: 'IQ', name: 'Old Topic' })).data;
  await admin.post(`/api/admin/categories/${off.id}/deactivate`);
  assert.equal((await admin.post('/api/admin/questions/bulk-category', { ids, category_id: off.id })).status, 400);
  assert.equal((await admin.post('/api/admin/questions/bulk-category', { ids: [], category_id: pattern.id })).status, 400);
});

test('import: category names are matched; unknown ones need a decision (create or use existing)', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Question', 'Option A', 'Option B', 'Correct Answer', 'Type', 'Level', 'Category'],
    ['Import cat Q1', '1', '2', 'A', 'IQ', '1', ' number PATTERN '],
    ['Import cat Q2', '1', '2', 'B', 'IQ', '2', 'Brand New Topic'],
    ['Import cat Q3', '1', '2', 'A', 'IQ', '3', 'brand new topic'],
    ['Import cat Q4', '1', '2', 'A', 'IQ', '4', 'Other New'],
    ['Import cat Q5', '1', '2', 'A', 'IQ', '5', ''],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Q');
  const p = (await admin.post('/api/admin/questions/import/preview', null, { form: upload(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'cat.xlsx', 'IQ') })).data;
  assert.equal(p.valid, 5);
  assert.deepEqual(p.rows.map((r) => r.category_state), ['ok', 'unknown', 'unknown', 'unknown', 'missing']);
  assert.equal(p.rows[0].question.category, 'Number Pattern', 'matched to the managed spelling');
  assert.deepEqual(p.category_decisions.map((d) => [d.key, d.count]), [['IQ|brand new topic', 2], ['IQ|other new', 1]]);
  assert.equal(p.missing_category, 1);
  const rows = p.rows.map((r) => r.question);

  const undecided = await admin.post('/api/admin/questions/import', { questions: rows });
  assert.equal(undecided.status, 400);
  assert.match(undecided.data.error, /decide what to do with these categories.*Brand New Topic.*Other New/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE question_text LIKE 'Import cat%'").get().n, 0, 'nothing imported, nothing created');
  assert.equal(await find('IQ', 'Brand New Topic'), undefined);

  const pattern = await find('IQ', 'Number Pattern');
  const ok = await admin.post('/api/admin/questions/import', { questions: rows, category_decisions: { 'IQ|brand new topic': { create: true }, 'IQ|other new': { category_id: pattern.id } } });
  assert.equal(ok.data.imported, 5);
  const saved = db.prepare("SELECT question_text, category, category_id FROM questions WHERE question_text LIKE 'Import cat%' ORDER BY question_text").all();
  const created = await find('IQ', 'Brand New Topic');
  assert.ok(created, 'created only because HR chose "create"');
  assert.deepEqual(saved.map((r) => r.category_id), [pattern.id, created.id, created.id, pattern.id, null]);
});

test('categories never reach candidates, and a test draws questions as before', async () => {
  seedQuestions('GENERAL', 6);
  const l = (await admin.post('/api/admin/assessments', { tests: ['IQ'], counts: { IQ: 5 }, link_expiry_minutes: 60 })).data;
  const candidate = client();
  const s = (await candidate.post(`/api/exam/${l.token}/start`, { ...CANDIDATE })).data;
  assert.equal(s.state, 'in_progress');
  assert.equal(s.questions.length, 5);
  assert.ok(!/category|Odd one out|Number Pattern|Verbal/.test(JSON.stringify(s)), 'no category information sent to the candidate');
});

test('only a logged-in admin can manage categories', async () => {
  const anon = client();
  for (const [m, u] of [['get', '/api/admin/categories'], ['post', '/api/admin/categories'], ['put', '/api/admin/categories/1'], ['del', '/api/admin/categories/1'],
    ['post', '/api/admin/categories/1/activate'], ['post', '/api/admin/questions/bulk-category']]) {
    assert.equal((await anon[m](u, m === 'get' || m === 'del' ? undefined : {})).status, 401, `${m} ${u}`);
  }
  assert.equal((await anon.get('/api/exam/anything/categories')).status, 404, 'no category API on the candidate side');
});
