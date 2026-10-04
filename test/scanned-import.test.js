// Scanned PDFs (pages that are pictures, no text layer): every page is read with
// OCR and three readings are tried - one question per page, numbered questions
// with answer cards (several per page), and the OCR text through the text readers.
// Samples: test/fixtures/make-scanned-samples.js (no private data).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { start, stop, client, upload, db } = require('./helpers');

let admin;
test.before(async () => { await start(); admin = client(); await admin.login(); });
test.after(stop);

const sample = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const preview = async (buf, name) => admin.post('/api/admin/questions/import/preview', undefined, { form: upload(buf, name, 'IQ') });
const questions = (r) => r.data.rows.map((x) => x.question);
const pictures = (q) => ['a', 'b', 'c', 'd', 'e'].filter((l) => q[`option_${l}_image`]).length;

// Share of strongly green pixels in an option picture (the "correct" frame must never be in it).
async function greenShare(id) {
  const img = await loadImage(db.prepare('SELECT data FROM images WHERE id = ?').get(id).data);
  const c = createCanvas(img.width, img.height); c.getContext('2d').drawImage(img, 0, 0);
  const d = c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
  let green = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 110 && d[i + 1] - d[i] > 45 && d[i + 1] - d[i + 2] > 20) green++;
  return green / (d.length / 4);
}

test('numbered questions with answer cards on cream paper: text and picture options, answers from the key and the green card', { timeout: 180000 }, async () => {
  const r = await preview(sample('scanned-numbered-cream.pdf'), 'cream.pdf');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.format, /scanned pages \(OCR\): numbered questions with answer cards/);
  assert.equal(r.data.found, 3);
  const [q1, q2, q3] = questions(r);
  assert.deepEqual([q1.question_text, q1.category, q1.correct_answer], ['What number comes next?', 'Number Series', 'C']);
  assert.deepEqual([q1.option_a, q1.option_b, q1.option_c, q1.option_d], ['14', '16', '18', '20'], 'clean text cards become text options');
  assert.ok(q1.image_id, 'the figure panel is kept as a picture, exactly as printed');
  assert.deepEqual([q2.question_text, q2.category, q2.correct_answer, pictures(q2)], ['Which shape comes next?', 'Sequences', 'B', 4]);
  // A bold answer filling its card is still one card; tight text is kept as pictures (never a misread text).
  assert.deepEqual([q3.question_text, q3.category, q3.correct_answer, pictures(q3)], ['Who owns the fish?', 'Logic', 'D', 4]);
  for (const q of [q2, q3]) {
    for (const l of 'abcd') assert.ok(await greenShare(q[`option_${l}_image`]) < 0.002, `no green "correct" frame in option ${l.toUpperCase()} of "${q.question_text}"`);
  }
  assert.ok(r.data.rows.every((x) => x.errors.length === 0), 'all three importable');
});

test('the same layout on plain white paper; the answer from the green card alone (no key)', { timeout: 180000 }, async () => {
  const r = await preview(sample('scanned-numbered-white.pdf'), 'white.pdf');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [q1, q2] = questions(r);
  assert.equal(r.data.found, 2);
  assert.deepEqual([q1.question_text, q1.correct_answer, q1.option_b], ['Which number is the largest?', 'B', '84']);
  assert.deepEqual([q2.question_text, q2.correct_answer, pictures(q2)], ['Which shape has no corners?', 'D', 4]);
  for (const l of 'abcd') assert.ok(await greenShare(q2[`option_${l}_image`]) < 0.002, 'no green frame in option ' + l);
});

test('a plain scanned text page goes through the text readers; HR is asked to check it', { timeout: 180000 }, async () => {
  const r = await preview(sample('scanned-plain-text.pdf'), 'text.pdf');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.found, 3);
  assert.deepEqual(questions(r).map((q) => [q.question_text, q.option_b, q.correct_answer]),
    [['What is the capital of Laos?', 'Vientiane', 'B'], ['How many days are in a week?', 'Six', 'C'], ['Which number is even?', '7', 'D']]);
  assert.ok(r.data.rows.every((x) => /Read from a scanned page \(OCR\)/.test(x.review || '')));
});

test('the one-question-per-page booklet is still read by its own reader', { timeout: 180000 }, async () => {
  const r = await preview(sample('scanned-iq-sample.pdf'), 'booklet.pdf');
  assert.equal(r.status, 200);
  assert.match(r.data.format, /one question per page/);
  assert.equal(r.data.found, 2);
});

test('a scanned PDF with no questions at all says that OCR was tried', { timeout: 180000 }, async () => {
  // A picture-only page with a sentence and no question layout.
  const c = createCanvas(1240, 1754); const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111'; g.font = '40px Arial, sans-serif'; g.fillText('Company picnic on Saturday', 120, 300);
  const buf = await new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 }); const parts = [];
    doc.on('data', (b) => parts.push(b)); doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.image(c.toBuffer('image/png'), 0, 0, { width: doc.page.width }); doc.end();
  });
  const r = await preview(buf, 'notice.pdf');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /every page was read with OCR/);
});

// The user's real scanned answer paper (75 IQ questions, several per page), if available locally.
const REAL = process.env.LALCO_SCANNED_PDF;
test('a real scanned answer paper', { timeout: 600000, skip: !REAL || !fs.existsSync(REAL) ? 'set LALCO_SCANNED_PDF to the file to run this' : false }, async () => {
  const r = await preview(fs.readFileSync(REAL), path.basename(REAL));
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  assert.ok(r.data.found >= 10);
  assert.equal(r.data.rows.filter((x) => x.errors.length).length, 0, 'every question importable');
  assert.ok(r.data.rows.every((x) => x.question.correct_answer), 'every question has its answer');
});
