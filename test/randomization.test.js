// Every candidate on the SAME shared link gets their own random questions,
// drawn once on the server when their test opens, saved, and never redrawn.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, seedQuestions, db, client, CANDIDATE } = require('./helpers');

let base;
let admin;
const LEVELS = { Easy: 34, Basic: 21, Moderate: 16, Difficult: 15, 'Very Difficult': 9 }; // like the production IQ pool (95)
let inactiveIds;
test.before(async () => {
  base = await start();
  admin = client();
  await admin.login();
  for (const [level, n] of Object.entries(LEVELS)) seedQuestions('IQ', n, 1, level);
  // Distinct wording per question (identical questions are treated as one on purpose).
  db.prepare("UPDATE questions SET question_text = 'IQ bank question ' || id WHERE section = 'IQ'").run();
  inactiveIds = seedQuestions('IQ', 10, 1, 'Easy');
  db.prepare(`UPDATE questions SET status = 'Inactive', question_text = 'inactive ' || id WHERE id IN (${inactiveIds.join(',')})`).run();
  seedQuestions('GENERAL', 25);
});
test.after(stop);

function browser(jar = {}) {
  const call = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: b === undefined ? undefined : JSON.stringify(b) });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { jar, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
}
async function shared(counts, tests = Object.keys(counts)) {
  const r = await admin.post('/api/admin/assessments', { tests, counts, link_expiry_minutes: 600, pass_marks: { IQ: 0, GENERAL: 0 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
const u = (link, p = '') => `/api/exam/${link.token}${p}`;
const bankIds = (s) => s.questions.map((q) => db.prepare('SELECT question_id FROM assessment_questions WHERE id = ?').get(q.id).question_id);
const levelsOf = (ids) => ids.map((id) => db.prepare('SELECT difficulty FROM questions WHERE id = ?').get(id).difficulty);
const optionOrder = (s) => s.questions.map((q) => q.options.map((o) => o.key).join(''));

test('IQ 18 on ONE link: A, B and C each get 18 of their own, 4/3/3/4/4 by level, active only, Level 1 first', async () => {
  const link = await shared({ IQ: 18, GENERAL: 10 });
  const people = ['A', 'B', 'C'].map((k) => Object.assign(browser(), { k }));
  for (const p of people) {
    p.s = (await p.post(u(link, '/start'), { ...CANDIDATE, name: 'Random ' + p.k })).data;
    p.ids = bankIds(p.s);
  }
  for (const p of people) {
    assert.equal(p.s.questions.length, 18, `${p.k}: exactly 18 questions`);
    assert.equal(new Set(p.ids).size, 18, `${p.k}: no repeats`);
    assert.ok(p.ids.every((id) => !inactiveIds.includes(id)), `${p.k}: active questions only`);
    const lv = levelsOf(p.ids);
    const count = (l) => lv.filter((x) => x === l).length;
    assert.deepEqual([count('Easy'), count('Basic'), count('Moderate'), count('Difficult'), count('Very Difficult')], [4, 3, 3, 4, 4], `${p.k}: level split`);
    const rank = lv.map((l) => Object.keys(LEVELS).indexOf(l));
    assert.deepEqual(rank, [...rank].sort((x, y) => x - y), `${p.k}: shown Level 1 first up to Level 5`);
    assert.ok(!JSON.stringify(p.s).match(/difficulty|marks|correct_answer|Very Difficult/), `${p.k}: no level, marks or answer sent`);
  }
  const [A, B, C] = people;
  assert.notEqual(A.ids.join(), B.ids.join(), 'A and B sets differ');
  assert.notEqual(B.ids.join(), C.ids.join(), 'B and C sets differ');
  assert.notEqual(A.ids.join(), C.ids.join(), 'A and C sets differ');
  assert.ok(new Set([A, B, C].map((p) => [...p.ids].sort().join())).size === 3, 'different question SETS, not only a different order');

  // HR can inspect each candidate's drawn question ids (admin only).
  const hr = (await admin.get(`/api/admin/links/${link.id}`)).data.attempts;
  for (const p of people) assert.deepEqual(hr.find((x) => x.candidate_name === 'Random ' + p.k).question_ids.IQ, p.ids);

  // Refresh and reconnect: same questions, order, option order and deadline; no redraw.
  const copies = db.prepare('SELECT COUNT(*) AS n FROM assessment_questions').get().n;
  for (const p of people) {
    const deadline = db.prepare("SELECT deadline_at FROM assessments WHERE id = (SELECT id FROM assessments WHERE link_id = ? AND candidate_id = (SELECT id FROM candidates WHERE name = ?))").get(link.id, 'Random ' + p.k).deadline_at;
    for (const again of [(await p.get(u(link))).data, (await browser({ ...p.jar }).get(u(link))).data]) {
      assert.deepEqual(bankIds(again), p.ids, `${p.k}: same questions in the same order`);
      assert.deepEqual(optionOrder(again), optionOrder(p.s), `${p.k}: same option order`);
    }
    assert.equal(db.prepare("SELECT deadline_at FROM assessments WHERE link_id = ? AND candidate_id = (SELECT id FROM candidates WHERE name = ?)").get(link.id, 'Random ' + p.k).deadline_at, deadline);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assessment_questions').get().n, copies, 'nothing redrawn on refresh');

  // Each stage is drawn for that candidate when it opens: General differs too.
  for (const p of [A, B]) {
    const answers = Object.fromEntries(p.s.questions.map((q) => [q.id, 'Z']));
    await p.post(u(link, '/submit'), { answers });
    p.g = (await p.post(u(link, '/continue'))).data;
    assert.equal(p.g.section, 'GENERAL');
    assert.equal(p.g.questions.length, 10);
  }
  assert.notEqual(bankIds(A.g).join(), bankIds(B.g).join(), 'General sets differ per candidate');
  assert.equal((await C.get(u(link))).data.section, 'IQ', 'C is still on IQ, unaffected');
});

test('five candidates starting at once each get their own random set; answers stay on their own copies', async () => {
  const link = await shared({ GENERAL: 10 });
  const people = [1, 2, 3, 4, 5].map((k) => Object.assign(browser(), { k }));
  const started = await Promise.all(people.map((p) => p.post(u(link, '/start'), { ...CANDIDATE, name: 'Burst ' + p.k })));
  const sets = started.map((r) => bankIds(r.data).join());
  assert.equal(new Set(sets).size, 5, 'five different question sets / orders');
  // Each answers with the correct letter of their own copies; each scores 100%.
  await Promise.all(people.map(async (p, i) => {
    const s = started[i].data;
    const answers = Object.fromEntries(s.questions.map((q) => [q.id, db.prepare('SELECT correct_answer FROM assessment_questions WHERE id = ?').get(q.id).correct_answer]));
    p.done = (await p.post(u(link, '/submit'), { answers })).data;
  }));
  for (const p of people) assert.equal(p.done.last_result.percent, 100, 'option shuffling does not affect marking');
  // A cannot answer B's copies.
  const bQuestion = started[1].data.questions[0].id;
  const fresh = browser({ ...people[0].jar });
  assert.equal((await fresh.put(u(link, '/answer'), { question_id: bQuestion, answer: 'A' })).status, 409, 'A is finished and cannot write anywhere');
});

test('a small bank: identical set+order is redrawn when another order exists; no endless loop when it cannot', async () => {
  const insert = db.prepare("INSERT INTO questions (section, question_text, option_a, option_b, correct_answer, marks, created_at) VALUES ('CALCULATION', ?, '1', '2', 'A', 1, ?)");
  for (let i = 1; i <= 4; i++) insert.run('Small bank ' + i, new Date().toISOString());
  const link = await shared({ CALCULATION: 4 });
  const orders = [];
  for (let k = 0; k < 2; k++) orders.push(bankIds((await browser().post(u(link, '/start'), { ...CANDIDATE, name: 'Small ' + k })).data).join());
  assert.notEqual(orders[0], orders[1], 'same 4 questions but a different order');

  db.prepare("INSERT INTO questions (section, question_text, marks, created_at) VALUES ('ESSAY', 'The only essay', 10, ?)").run(new Date().toISOString());
  const one = await shared({ ESSAY: 1 });
  for (let k = 0; k < 3; k++) {
    const s = (await browser().post(u(one, '/start'), { ...CANDIDATE, name: 'Essay ' + k })).data;
    assert.equal(s.questions.length, 1, 'the single essay is still given to everyone');
  }
});
