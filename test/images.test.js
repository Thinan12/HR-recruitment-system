const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const { start, stop, client, db, CANDIDATE } = require('./helpers');

let admin;
const candidate = client();
test.before(async () => {
  await start();
  admin = client();
  await admin.login();
});
test.after(stop);

// A small, distinct PNG for each call.
let colour = 0;
function png() {
  const c = createCanvas(40, 30);
  const g = c.getContext('2d');
  g.fillStyle = `rgb(${(colour += 37) % 255}, ${(colour * 3) % 255}, 90)`;
  g.fillRect(0, 0, 40, 30);
  return c.toBuffer('image/png');
}
const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;
async function upload(buf) {
  const r = await admin.post('/api/admin/images', { data_url: dataUrl(buf) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}

test('pictures upload, the same picture is stored once, and only real images are accepted', async () => {
  const buf = png();
  const id = await upload(buf);
  assert.equal(await upload(buf), id, 'same picture reuses the stored copy');

  const back = await admin.get('/api/admin/images/' + id, { raw: true });
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('content-type'), 'image/png');
  assert.ok(back.buffer.equals(buf));

  const svg = await admin.post('/api/admin/images', { data_url: dataUrl(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml') });
  assert.equal(svg.status, 400);
  const fake = await admin.post('/api/admin/images', { data_url: dataUrl(Buffer.from('not an image'), 'image/png') });
  assert.equal(fake.status, 400);
  assert.equal((await client().get('/api/admin/images/' + id)).status, 401, 'admin pictures need login');
});

test('a question can use pictures for the question and for five options', async () => {
  const ids = { image_id: await upload(png()) };
  for (const l of 'abcde') ids[`option_${l}_image`] = await upload(png());
  const r = await admin.post('/api/admin/questions', { section: 'IQ', question_text: 'Which figure is the odd one out?', correct_answer: 'E', ...ids });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.correct_answer, 'E');
  assert.equal(r.data.option_e_image, ids.option_e_image);

  const missing = await admin.post('/api/admin/questions', { section: 'IQ', question_text: 'Broken?', option_a: '1', option_b_image: 999999, correct_answer: 'A' });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /picture could not be found/);

  const noText = await admin.post('/api/admin/questions', { section: 'IQ', question_text: 'Only pictures?', option_a_image: ids.option_a_image, option_b_image: ids.option_b_image, correct_answer: 'B' });
  assert.equal(noText.status, 201, 'options may be pictures without text');
});

test('candidates see pictures, can answer, and admin sees chosen / correct / missed answers', async () => {
  db.prepare("UPDATE questions SET status = 'Inactive'").run();
  const qImg = await upload(png());
  const opts = {};
  for (const l of 'abcd') opts[`option_${l}_image`] = await upload(png());
  // Same wording, different pictures: both must be allowed in one test.
  await admin.post('/api/admin/questions', { section: 'IQ', question_text: 'Which figure comes next?', image_id: qImg, ...opts, correct_answer: 'C' });
  await admin.post('/api/admin/questions', { section: 'IQ', question_text: 'Which figure comes next?', image_id: await upload(png()), option_a: 'x', option_b: 'y', correct_answer: 'A' });
  await admin.post('/api/admin/questions', { section: 'IQ', question_text: 'What is 2 + 2?', option_a: '3', option_b: '4', correct_answer: 'B' });

  const link = await admin.post('/api/admin/assessments', { assessment_type: 'IQ', counts: { IQ: 3 }, time_limit_minutes: 10, link_expiry_minutes: 60 });
  assert.equal(link.status, 201, JSON.stringify(link.data));
  const started = await candidate.post(`/api/exam/${link.data.token}/start`, CANDIDATE);
  assert.equal(started.data.questions.length, 3, 'both "Which figure comes next?" questions are used');

  const pic = started.data.questions.find((q) => q.options.some((o) => o.image));
  assert.ok(pic.image.startsWith(`/api/exam/${link.data.token}/images/`));
  const img = await candidate.get(pic.image, { raw: true });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const optImg = await candidate.get(pic.options[0].image, { raw: true });
  assert.equal(optImg.status, 200);

  // A picture that is not part of this test is not served.
  const other = await upload(png());
  assert.equal((await candidate.get(`/api/exam/${link.data.token}/images/${other}`)).status, 404);

  // Answer the picture question correctly, the maths one wrongly, skip the third.
  const maths = started.data.questions.find((q) => q.text === 'What is 2 + 2?');
  await candidate.put(`/api/exam/${link.data.token}/answer`, { question_id: pic.id, answer: 'C' });
  await candidate.post(`/api/exam/${link.data.token}/submit`, { answers: { [maths.id]: 'A' } });
  assert.equal((await candidate.get(pic.image)).status, 404, 'pictures stop being served after submission');

  const review = await admin.get('/api/admin/assessments/' + link.data.id);
  const rows = review.data.questions;
  const byId = Object.fromEntries(rows.map((q) => [q.id, q]));
  assert.equal(byId[pic.id].answer, 'C');
  assert.equal(byId[pic.id].marks_awarded, 1);
  assert.equal(byId[pic.id].option_c_image, opts.option_c_image, 'review has the pictures of the chosen option');
  assert.equal(byId[maths.id].answer, 'A');
  assert.equal(byId[maths.id].marks_awarded, 0);
  const skipped = rows.find((q) => q.id !== pic.id && q.id !== maths.id);
  assert.equal(skipped.answer, null, 'missed question is recorded as not answered');
  assert.equal(review.data.assessment.iq_points, 1);
});

test('text import understands a fifth option', async () => {
  const form = new FormData();
  form.append('section', 'IQ');
  form.append('file', new Blob([Buffer.from('1. Odd one out?\nA. 2  B. 4  C. 6  D. 8  E. 9\nAnswer: E\n')]), 'five.txt');
  const r = await admin.post('/api/admin/questions/import/preview', undefined, { form });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rows[0].question.option_e, '9');
  assert.equal(r.data.rows[0].question.correct_answer, 'E');
});
