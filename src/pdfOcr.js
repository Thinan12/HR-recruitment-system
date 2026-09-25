// Fallback for PDFs whose pages are pictures (no text layer), such as the
// "IQ Test - 50 Mixed Questions" booklet. Each page is rendered, read with OCR,
// and split into pieces by looking at the page itself:
//
//   QUESTION 01                     <- question number (OCR)
//   What number comes next?         <- question text (OCR)
//   [ white box ]                   <- question picture (kept as an image)
//   [A] [B] [C] [D]                 <- white answer cards: text if OCR is sure, else pictures
//
//   ANSWER KEY  (D) Q01 ...         <- letters in dark circles, read one by one
//
// Pictures are stored with the existing images table (deduplicated), so the
// preview can show them and the confirmed import just refers to their ids.
const path = require('path');
const { PDFParse } = require('pdf-parse');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { createWorker, PSM } = require('tesseract.js');
const { saveImage } = require('./images');

const MAX_PAGES = 150;
const LETTERS = ['A', 'B', 'C', 'D', 'E'];
const LANG_PATH = path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'));

let busy = false; // one scanned PDF at a time keeps memory use predictable

// ---- pixels -----------------------------------------------------------------

function pageImage(img) {
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  const at = (x, y) => (y * img.width + x) * 4;
  return {
    canvas, width: img.width, height: img.height,
    isWhite: (x, y) => { const i = at(x, y); return data[i] >= 250 && data[i + 1] >= 250 && data[i + 2] >= 250; },
    isDark: (x, y) => { const i = at(x, y); return data[i] + data[i + 1] + data[i + 2] < 240; },
    isInk: (x, y) => { const i = at(x, y); return data[i] + data[i + 1] + data[i + 2] < 600; },
  };
}

// Bounding boxes of connected regions (on a coarse grid) where test() is true.
function regions(page, test, step, minW, minH) {
  const cols = Math.floor(page.width / step);
  const rows = Math.floor(page.height / step);
  const on = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) on[r * cols + c] = test(c * step + (step >> 1), r * step + (step >> 1)) ? 1 : 0;
  const seen = new Uint8Array(cols * rows);
  const out = [];
  for (let start = 0; start < on.length; start++) {
    if (!on[start] || seen[start]) continue;
    let x0 = cols; let y0 = rows; let x1 = 0; let y1 = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const k = stack.pop();
      const c = k % cols; const r = (k - c) / cols;
      if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r;
      for (const n of [k - 1, k + 1, k - cols, k + cols]) {
        if (n < 0 || n >= on.length || seen[n] || !on[n]) continue;
        if ((n === k - 1 && c === 0) || (n === k + 1 && c === cols - 1)) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    const box = { x0: x0 * step, y0: y0 * step, x1: (x1 + 1) * step, y1: (y1 + 1) * step };
    if (box.x1 - box.x0 >= minW && box.y1 - box.y0 >= minH) out.push(box);
  }
  return out;
}

const inside = (a, b) => a.x0 >= b.x0 && a.y0 >= b.y0 && a.x1 <= b.x1 && a.y1 <= b.y1;
const center = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
const within = (point, b) => point.x >= b.x0 && point.x <= b.x1 && point.y >= b.y0 && point.y <= b.y1;

function crop(page, b, pad = 0) {
  const x = Math.max(0, Math.floor(b.x0 - pad));
  const y = Math.max(0, Math.floor(b.y0 - pad));
  const w = Math.min(page.width, Math.ceil(b.x1 + pad)) - x;
  const h = Math.min(page.height, Math.ceil(b.y1 + pad)) - y;
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(page.canvas, x, y, w, h, 0, 0, w, h);
  return c;
}

// ---- OCR --------------------------------------------------------------------

async function ocrPage(worker, png) {
  const { data } = await worker.recognize(png, {}, { blocks: true });
  const lines = [];
  const words = [];
  for (const block of data.blocks || []) for (const para of block.paragraphs) for (const line of para.lines) {
    lines.push({ text: line.text.trim(), bbox: line.bbox, confidence: line.confidence });
    for (const w of line.words) words.push({ text: w.text.trim(), bbox: w.bbox, confidence: w.confidence });
  }
  return { text: data.text || '', lines, words };
}

// Letters printed white on a dark circle: invert the circle and read one character.
async function readCircleLetter(worker, page, box) {
  const c = crop(page, box, 2);
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i] + img.data[i + 1] + img.data[i + 2] < 300 ? 255 : 0; // dark -> white, light -> black
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  const big = createCanvas(c.width * 3, c.height * 3);
  big.getContext('2d').drawImage(c, 0, 0, big.width, big.height);
  const { data } = await worker.recognize(big.toBuffer('image/png'));
  const m = String(data.text || '').toUpperCase().match(/[A-E]/);
  return m ? m[0] : null;
}

// ---- page types -------------------------------------------------------------

async function readAnswerKey(worker, page, ocr, key) {
  // "Q01", "QO7", "Q12" ... gives each row's question number and height.
  const numbered = ocr.words
    .map((w) => ({ n: Number((w.text.match(/^Q[O0o]?(\d{1,3})$/i) || [])[1]), y: (w.bbox.y0 + w.bbox.y1) / 2, x0: w.bbox.x0 }))
    .filter((w) => w.n > 0);
  if (numbered.length < 2) return;
  // Rows are evenly spaced, so a straight line through the rows OCR did read
  // gives the height of the ones it missed.
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mn = mean(numbered.map((w) => w.n));
  const my = mean(numbered.map((w) => w.y));
  const slope = numbered.reduce((s, w) => s + (w.n - mn) * (w.y - my), 0) / (numbered.reduce((s, w) => s + (w.n - mn) ** 2, 0) || 1);
  const range = ocr.text.match(/Questions?\s+(\d{1,3})\s*[-–]\s*(\d{1,3})/i);
  const first = range ? Number(range[1]) : Math.min(...numbered.map((w) => w.n));
  const last = range ? Number(range[2]) : Math.max(...numbered.map((w) => w.n));
  const qx = Math.min(...numbered.map((w) => w.x0));

  for (let n = first; n <= last; n++) {
    const y = Math.round(numbered.find((w) => w.n === n)?.y ?? my + slope * (n - mn));
    if (y < 0 || y >= page.height) continue;
    // The dark circle left of "Qnn": find its width on this row, then crop a square.
    let x0 = -1; let x1 = -1;
    for (let x = 0; x < qx; x++) if (page.isDark(x, y)) { if (x0 < 0) x0 = x; x1 = x; }
    if (x0 < 0) continue;
    const r = (x1 - x0) / 2;
    const circle = { x0, y0: y - r, x1, y1: y + r };
    const letter = await readCircleLetter(worker, page, circle);
    const mask = circleMask(page, circle);
    // The grey category on the same line as "Qnn", e.g. "Number series".
    const category = ocr.words
      .filter((w) => w.bbox.x0 > qx + 40 && Math.abs((w.bbox.y0 + w.bbox.y1) / 2 - y) < 9)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text).join(' ');
    key.set(n, { letter, category, mask });
  }
}

// A small black/white fingerprint of a circle, used to compare letters.
const MASK = 16;
function circleMask(page, box) {
  const bits = new Uint8Array(MASK * MASK);
  for (let j = 0; j < MASK; j++) for (let i = 0; i < MASK; i++) {
    const x = Math.round(box.x0 + ((i + 0.5) * (box.x1 - box.x0)) / MASK);
    const y = Math.round(box.y0 + ((j + 0.5) * (box.y1 - box.y0)) / MASK);
    bits[j * MASK + i] = page.isDark(x, y) ? 1 : 0;
  }
  return bits;
}

// Every circle is printed in the same font, so a letter OCR could not read is
// given the letter of the most similar circle it did read.
function fillUnreadLetters(key) {
  const known = [...key.values()].filter((k) => k.letter);
  for (const k of key.values()) {
    if (k.letter || !known.length) continue;
    let best = null; let bestDiff = Infinity;
    for (const other of known) {
      let diff = 0;
      for (let i = 0; i < k.mask.length; i++) diff += k.mask[i] !== other.mask[i] ? 1 : 0;
      if (diff < bestDiff) { bestDiff = diff; best = other; }
    }
    if (best && bestDiff <= k.mask.length * 0.08) k.letter = best.letter;
  }
}

async function readQuestionPage(worker, page, ocr, number) {
  const header = ocr.lines.find((l) => /QUESTION\s*\d/i.test(l.text));
  // Top-level white boxes: the question picture and the answer cards.
  const boxes = regions(page, page.isWhite, 3, 60, 60);
  const top = boxes.filter((b) => !boxes.some((o) => o !== b && inside(b, o)));
  top.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  const figure = top[0] && (top[0].x1 - top[0].x0) > page.width * 0.5 ? top[0] : null;

  // Question text: the lines between the header and the picture (or the cards).
  const textBottom = figure ? figure.y0 : page.height * 0.6;
  const titleLines = ocr.lines.filter((l) => l !== header && l.bbox.y0 > (header ? header.bbox.y1 - 2 : 0) && l.bbox.y1 < textBottom);
  let text = titleLines.map((l) => l.text).join('\n').trim();
  // Large bold headings sometimes come out garbled; read that strip again, enlarged.
  if (titleLines.length && titleLines.some((l) => l.confidence < 85)) {
    const box = { x0: 0, y0: Math.min(...titleLines.map((l) => l.bbox.y0)) - 10, x1: page.width, y1: Math.max(...titleLines.map((l) => l.bbox.y1)) + 10 };
    const strip = crop(page, box);
    const big = createCanvas(strip.width * 2, strip.height * 2);
    big.getContext('2d').drawImage(strip, 0, 0, big.width, big.height);
    const again = (await worker.recognize(big.toBuffer('image/png'))).data;
    if (again.confidence > Math.min(...titleLines.map((l) => l.confidence))) text = again.text.trim();
  }

  const q = { number, question_text: text, images: {} };
  const cards = top.filter((b) => b !== figure && (!figure || b.y0 >= figure.y1 - 5)).sort((a, b) => a.x0 - b.x0);

  if (cards.length >= 2 && cards.length <= 5) {
    if (figure) q.images.image_id = crop(page, figure, 4);
    const pieces = cards.map((card) => {
      // Stop above the printed letter badge at the bottom of the card. A row
      // counts as badge if anything near the middle is dark (the white letter
      // inside the badge must not end the search early).
      const cx = Math.round((card.x0 + card.x1) / 2);
      const darkRow = (y) => { for (let x = cx - 20; x <= cx + 20; x += 2) if (page.isDark(x, y)) return true; return false; };
      let y = card.y1 - 6;
      while (y > card.y0 && !darkRow(y)) y--;
      const badgeBottom = y;
      while (y > card.y0 && darkRow(y)) y--;
      const badgeHeight = badgeBottom - y;
      const isBadge = badgeBottom > card.y0 + (card.y1 - card.y0) * 0.6 && badgeHeight < (card.y1 - card.y0) * 0.35;
      return { x0: card.x0 + 4, y0: card.y0 + 4, x1: card.x1 - 4, y1: isBadge ? y - 6 : card.y1 - 4 };
    });
    const texts = pieces.map((p) => {
      const ws = ocr.words.filter((w) => within(center(w.bbox), p) && w.text);
      return { text: ws.map((w) => w.text).join(' ').trim(), conf: ws.length ? Math.min(...ws.map((w) => w.confidence)) : 0, words: ws };
    });
    // Use text only when every card is plainly text: confident OCR and no other
    // ink (shapes, dots) outside the recognised words. Otherwise keep pictures.
    const pureText = texts.every((t, i) => t.text && t.conf >= 80 && /[\p{L}\p{N}$°%]/u.test(t.text) && inkOutside(page, pieces[i], t.words) < 0.004);
    pieces.forEach((p, i) => {
      const l = LETTERS[i].toLowerCase();
      if (pureText) q['option_' + l] = texts[i].text;
      else q.images[`option_${l}_image`] = crop(page, p);
    });
    return q;
  }

  // No cards: options drawn inside the picture, labelled A B C ... underneath.
  if (figure) {
    const labels = ocr.words
      .filter((w) => /^[A-E]$/.test(w.text) && within(center(w.bbox), figure))
      .sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const row = labels.filter((w) => Math.abs(w.bbox.y0 - labels[0].bbox.y0) < 20);
    if (row.length >= 2 && row.every((w, i) => w.text === LETTERS[i])) {
      row.forEach((w, i) => {
        const cx = center(w.bbox).x;
        const left = i === 0 ? figure.x0 + 4 : (center(row[i - 1].bbox).x + cx) / 2;
        const right = i === row.length - 1 ? figure.x1 - 4 : (center(row[i + 1].bbox).x + cx) / 2;
        q.images[`option_${LETTERS[i].toLowerCase()}_image`] = crop(page, { x0: left, y0: figure.y0 + 8, x1: right, y1: w.bbox.y0 - 8 });
      });
      return q;
    }
    q.images.image_id = crop(page, figure, 4); // keep the picture even without usable options
  }
  return q;
}

function inkOutside(page, box, words) {
  let ink = 0; let total = 0;
  for (let y = Math.floor(box.y0); y < box.y1; y += 2) {
    for (let x = Math.floor(box.x0); x < box.x1; x += 2) {
      total++;
      if (!page.isInk(x, y)) continue;
      if (words.some((w) => x >= w.bbox.x0 - 4 && x <= w.bbox.x1 + 4 && y >= w.bbox.y0 - 4 && y <= w.bbox.y1 + 4)) continue;
      ink++;
    }
  }
  return total ? ink / total : 0;
}

// ---- entry point -----------------------------------------------------------

// Returns raw question rows (same shape as the text importer), or [] if the
// pages do not look like a question booklet.
async function readScannedPdf(buffer, defaultSection) {
  if (busy) throw new Error('busy');
  busy = true;
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let worker;
  let letterWorker;
  try {
    const { total } = await parser.getInfo();
    if (total > MAX_PAGES) return [];
    const shots = await parser.getScreenshot({ desiredWidth: 1080, imageDataUrl: false, imageBuffer: true });
    // Close the PDF reader before OCR starts; nothing more is needed from it.
    await parser.destroy().catch(() => {});
    const options = { langPath: LANG_PATH, gzip: true, cacheMethod: 'none' };
    worker = await createWorker('eng', 1, options);
    // A second worker only reads single letters (answer key circles), so the
    // page worker's settings never change during an import.
    letterWorker = await createWorker('eng', 1, options);
    await letterWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_CHAR, tessedit_char_whitelist: 'ABCDE' });

    const questions = new Map();
    const key = new Map();
    for (const shot of shots.pages) {
      const png = Buffer.from(shot.data);
      const page = pageImage(await loadImage(png));
      const ocr = await ocrPage(worker, png);
      // The heading, in capitals - not a sentence like "the answer key is at the end".
      if (/\bANSWER\s*KEY\b/.test(ocr.text)) {
        await readAnswerKey(letterWorker, page, ocr, key);
        continue;
      }
      const m = ocr.text.match(/QUESTION\s*[O0]?(\d{1,3})/i);
      if (m && !questions.has(Number(m[1]))) questions.set(Number(m[1]), await readQuestionPage(worker, page, ocr, Number(m[1])));
    }

    fillUnreadLetters(key);
    const rows = [];
    for (const n of [...questions.keys()].sort((a, b) => a - b)) {
      const q = questions.get(n);
      const row = { section: defaultSection, category: key.get(n)?.category || '', difficulty: '', marks: '', correct_answer: key.get(n)?.letter || '', question_text: q.question_text };
      for (const l of 'abcde') row['option_' + l] = q['option_' + l] || '';
      for (const [field, canvas] of Object.entries(q.images)) row[field] = saveImage(canvas.toBuffer('image/png'));
      rows.push(row);
    }
    return rows;
  } finally {
    busy = false;
    if (worker) await worker.terminate().catch(() => {});
    if (letterWorker) await letterWorker.terminate().catch(() => {});
    await parser.destroy().catch(() => {});
  }
}

module.exports = { readScannedPdf };
