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
    rgb: (x, y) => { const i = at(x, y); return [data[i], data[i + 1], data[i + 2]]; },
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
    const lineWords = line.words.map((w) => ({ text: w.text.trim(), bbox: w.bbox, confidence: w.confidence, symbols: (w.symbols || []).map((c) => ({ text: c.text, bbox: c.bbox })) }));
    lines.push({ text: line.text.trim(), bbox: line.bbox, confidence: line.confidence, words: lineWords });
    words.push(...lineWords);
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
    cardOptions(page, ocr, cards, q);
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

// The answer cards of one question (left to right = A, B, C ...): the text of
// each card when OCR is sure every card is plain text, otherwise a picture of
// each card. The printed letter badge at the bottom of a card is left out.
function cardOptions(page, ocr, cards, q) {
  {
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
    // The cards of one question are alike: if most are numbers and one is not
    // ("87 H", or "a" for a 4), OCR misread it - pictures are exact, wrong text is not.
    const numeric = (t) => /^[\d\s.,/%°$:+\-–×]+$/.test(t.text);
    const alike = texts.every(numeric) || texts.every((t) => !numeric(t) && !/^\p{L}$/u.test(t.text));
    // Text that touches the card edge may be cut off, and stray marks (: ; | _ ~)
    // mean a misread: then pictures again.
    const clean = (t, p) => !/[:;|_~`]$|[|_~`]/.test(t.text) && t.words.every((w) => w.bbox.x0 > p.x0 + 2 && w.bbox.x1 < p.x1 - 2);
    const pureText = alike && texts.every((t, i) => t.text && t.conf >= 80 && /[\p{L}\p{N}$°%]/u.test(t.text) && clean(t, pieces[i]) && inkOutside(page, pieces[i], t.words) < 0.004);
    pieces.forEach((p, i) => {
      const l = LETTERS[i].toLowerCase();
      if (pureText) q['option_' + l] = texts[i].text;
      else q.images[`option_${l}_image`] = crop(page, p);
    });
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


// ---- numbered questions with answer cards, several per page -------------------
//
//   1.  What is the shortest total time?                    LOGIC   <- number, question, category
//   [ figure: text or a picture ]  [19 min][18 min][17 min][16 min] <- answer cards (A B C D)
//   Answer: 17 min. ...                                              <- explanation (not imported)
//
// plus, optionally, an answer key grid ("1. C  2. C  3. D ...") and the correct
// card drawn with a green border. Used for any scanned paper laid out this way.

const HEADER_RE = /^(\d{1,3})\s*[.)]\s+(.*[\p{L}].*)$/u;
// A line of an answer key grid: several "n. X" pairs.
const isKeyLine = (text) => (String(text).match(/\b\d{1,3}\s*[.)]/g) || []).length >= 4;

// "n. X" pairs from answer key lines (OCR may read C as €).
function keyFromLines(lines) {
  const key = new Map();
  for (const l of lines) {
    if (!isKeyLine(l.text)) continue;
    const text = l.text.replace(/€/g, 'C');
    for (const m of text.matchAll(/\b(\d{1,3})\s*[.)]\s*([A-E])\b/g)) if (!key.has(Number(m[1]))) key.set(Number(m[1]), m[2]);
  }
  return key;
}

// Share of green pixels on the edge band of a card (the "correct" frame).
function greenRing(page, card) {
  let green = 0; let total = 0;
  const isGreen = (x, y) => {
    if (x < 0 || y < 0 || x >= page.width || y >= page.height) return false;
    const [r, g, b] = page.rgb(x, y);
    return g > 110 && g - r > 45 && g - b > 20;
  };
  for (let d = -6; d <= 6; d += 2) {
    for (let x = card.x0 - d; x <= card.x1 + d; x += 3) { total += 2; if (isGreen(x, card.y0 - d)) green++; if (isGreen(x, card.y1 + d)) green++; }
    for (let y = card.y0 - d; y <= card.y1 + d; y += 3) { total += 2; if (isGreen(card.x0 - d, y)) green++; if (isGreen(card.x1 + d, y)) green++; }
  }
  return total ? green / total : 0;
}

// A long "word" OCR glued together ("AistoBasCisto?") is split again where
// the gap between two letters is clearly a space (much wider than the others).
function spacedWord(w) {
  const sym = w.symbols || [];
  if (w.text.length < 3 || sym.length !== w.text.length) return w.text;
  const gaps = sym.slice(1).map((c, i) => c.bbox.x0 - sym[i].bbox.x1);
  const widths = sym.map((c) => c.bbox.x1 - c.bbox.x0).sort((a, b) => a - b);
  const unit = widths[widths.length >> 1] || 1;
  // Normal letter spacing: the smaller gaps (in "A is to B" most gaps are spaces).
  const typical = [...gaps].sort((a, b) => a - b)[gaps.length >> 2];
  let out = sym[0].text;
  gaps.forEach((g, i) => { out += (g > Math.max(typical + unit * 0.45, unit * 0.45) ? ' ' : '') + sym[i + 1].text; });
  return out;
}

// The question header lines of a page: "12. Which figure comes next?   SEQUENCES".
function headersOf(page, ocr) {
  const out = [];
  for (const l of ocr.lines) {
    if (l.bbox.x0 > page.width * 0.12 || isKeyLine(l.text)) continue;
    const m = l.text.match(HEADER_RE);
    if (!m) continue;
    // A category printed far right in capitals, after a wide gap.
    const ws = [...(l.words || [])].filter((w) => w.text).sort((a, b) => a.bbox.x0 - b.bbox.x0);
    let category = '';
    let textWords = ws.slice(1);
    let gapAt = -1; let gap = 0;
    for (let i = 1; i < ws.length; i++) { const g = ws[i].bbox.x0 - ws[i - 1].bbox.x1; if (g > gap) { gap = g; gapAt = i; } }
    // (a short label, up to 3 words, far right after a wide gap; OCR may not keep its capitals)
    if (gapAt > 1 && gap > page.width * 0.06 && ws.length - gapAt <= 3 && ws[gapAt].bbox.x0 > page.width * 0.6 && ws.slice(gapAt).every((w) => /^[\p{L}&/-]+$/u.test(w.text))) {
      category = ws.slice(gapAt).map((w) => w.text).join(' ');
      textWords = ws.slice(1, gapAt);
    }
    const text = textWords.length ? textWords.map(spacedWord).join(' ') : m[2];
    out.push({ number: Number(m[1]), text: text.trim(), category, bbox: l.bbox, confidence: l.confidence,
      textX0: textWords.length ? textWords[0].bbox.x0 : l.bbox.x0, textX1: textWords.length ? textWords[textWords.length - 1].bbox.x1 : l.bbox.x1 });
  }
  return out.sort((a, b) => a.bbox.y0 - b.bbox.y0);
}

// The page background: the most common colour (paper white, cream, light grey ...).
function backgroundOf(page) {
  const count = new Map();
  for (let y = 4; y < page.height; y += 9) for (let x = 4; x < page.width; x += 9) {
    const [r, g, b] = page.rgb(x, y);
    const k = `${r >> 2},${g >> 2},${b >> 2}`;
    count.set(k, (count.get(k) || 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map((v) => Number(v) * 4 + 2);
  return { r: top[0], g: top[1], b: top[2] };
}

// Boxes (figure panels, answer cards): areas that stand out from the page
// background - border and contents together - so a bold answer that fills
// its card, a white or a cream page, all give one box per card.
function boxesOf(page) {
  const bg = backgroundOf(page);
  let test;
  if (bg.r >= 248 && bg.g >= 248 && bg.b >= 248) {
    // White paper: a box is its outline and what is drawn in it (any pixel of the
    // 3 x 3 cell, so thin borders are never missed).
    const off = (x, y) => { const [r, g, b] = page.rgb(x, y); return 765 - r - g - b > 45; };
    test = (x, y) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx; const py = y + dy;
        if (px >= 0 && py >= 0 && px < page.width && py < page.height && off(px, py)) return true;
      }
      return false;
    };
  } else {
    // Tinted paper (cream, grey ...): a box is white paper plus the ink on it, so
    // a bold answer filling its card does not split it, and soft shadows between
    // cards (neither white nor ink) keep neighbouring cards apart.
    test = (x, y) => { const [r, g, b] = page.rgb(x, y); return (r >= 250 && g >= 250 && b >= 250) || r + g + b < 450; };
  }
  const all = regions(page, test, 3, 40, 40);
  return all.filter((b) => !all.some((o) => o !== b && inside(b, o)) && (b.x1 - b.x0) * (b.y1 - b.y0) < page.width * page.height * 0.5);
}
const shrink = (b, d) => ({ x0: b.x0 + d, y0: b.y0 + d, x1: b.x1 - d, y1: b.y1 - d });

async function readNumberedPage(worker, page, ocr) {
  const headers = headersOf(page, ocr);
  if (!headers.length) return [];
  const boxes = boxesOf(page);
  const out = [];
  for (const [i, h] of headers.entries()) {
    // Big bold headings sometimes lose their spaces ("AistoBasCisto?"): read the strip again, enlarged.
    if (h.confidence < 88 || h.text.split(' ').some((w) => w.length > 14)) {
      const strip = crop(page, { x0: h.textX0 - 4, y0: h.bbox.y0 - 6, x1: h.textX1 + 4, y1: h.bbox.y1 + 6 });
      const big = createCanvas(strip.width * 2, strip.height * 2);
      big.getContext('2d').drawImage(strip, 0, 0, big.width, big.height);
      const again = (await worker.recognize(big.toBuffer('image/png'))).data;
      const text = String(again.text || '').replace(/\s+/g, ' ').trim();
      if (again.confidence > h.confidence && text.split(' ').length > h.text.split(' ').length) h.text = text;
    }
    const q = await numberedQuestion(page, ocr, boxes, h, i + 1 < headers.length ? headers[i + 1].bbox.y0 : page.height);
    if (q) out.push(q);
  }
  return out;
}

// One numbered question: the boxes between its header and the next one.
async function numberedQuestion(page, ocr, boxes, h, bottom) {
  const top = h.bbox.y1;
  const inBlock = boxes.filter((b) => b.y0 >= top - 4 && b.y1 <= bottom + 4);
  if (inBlock.length < 2) return null;
  const area = (b) => (b.x1 - b.x0) * (b.y1 - b.y0);
  const figure = inBlock.filter((b) => b.x1 - b.x0 > page.width * 0.25).sort((x, y) => area(y) - area(x))[0] || null;
  // Answer cards: 2-5 boxes of about the same size on one row.
  const rest = inBlock.filter((b) => b !== figure && b.x1 - b.x0 < page.width * 0.3);
  let cards = [];
  for (const b of rest) {
    const row = rest.filter((o) => Math.abs((o.y0 + o.y1) / 2 - (b.y0 + b.y1) / 2) < 16 && Math.abs((o.y1 - o.y0) - (b.y1 - b.y0)) < (b.y1 - b.y0) * 0.25);
    if (row.length > cards.length) cards = row;
  }
  if (cards.length < 2 || cards.length > 5) return null;
  cards.sort((x, y) => x.x0 - y.x0);
  const q = { number: h.number, question_text: h.text, category: h.category, images: {} };
  // Read the cards well inside their border, so a coloured "correct" frame is never in an option picture.
  // (a card with a coloured frame is trimmed by the frame's width; the others keep their full width).
  const framed = cards.map((c) => greenRing(page, c) >= 0.08);
  cardOptions(page, ocr, cards.map((c, i) => shrink(c, framed[i] ? 6 : 0)), q);
  // The figure panel is always kept as a picture, exactly as printed (a puzzle's
  // numbers, dates or wording must never carry an OCR slip such as "1776?" -> "17767").
  if (figure) q.images.image_id = crop(page, shrink(figure, 3));
  // The correct card drawn in green, if any.
  const greens = cards.map((c) => greenRing(page, c));
  const best = greens.indexOf(Math.max(...greens));
  if (greens[best] >= 0.2 && greens.filter((g) => g >= 0.08).length === 1) q.green = LETTERS[best];
  return q;
}

// ---- entry point -----------------------------------------------------------

const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s/&-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

// Reads a PDF whose pages are pictures. Every page is rendered and read with
// OCR once; the result is given in three readings, and the importer keeps the
// one that finds the most usable questions:
//   booklet   one question per page ("QUESTION 01") + an "ANSWER KEY" page of circles
//   numbered  numbered questions with answer cards, several per page (+ answer key grid / green card)
//   text      the OCR text of every page, for the importer's text readers
//             (numbered questions, A) B) options, "Answer: B", answer key sections ...)
async function readScannedPdf(buffer, defaultSection) {
  if (busy) throw new Error('busy');
  busy = true;
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let worker;
  let letterWorker;
  try {
    const { total } = await parser.getInfo();
    if (total > MAX_PAGES) return { booklet: [], numbered: [], text: '' };
    const shots = await parser.getScreenshot({ desiredWidth: 1080, imageDataUrl: false, imageBuffer: true });
    // Close the PDF reader before OCR starts; nothing more is needed from it.
    await parser.destroy().catch(() => {});
    const options = { langPath: LANG_PATH, gzip: true, cacheMethod: 'none' };
    worker = await createWorker('eng', 1, options);
    const textPages = [];
    const bookletPages = [];
    const numbered = [];
    const keyLines = [];
    for (const shot of shots.pages) {
      const png = Buffer.from(shot.data);
      const page = pageImage(await loadImage(png));
      const ocr = await ocrPage(worker, png);
      textPages.push(ocr.text);
      keyLines.push(...ocr.lines);
      bookletPages.push({ page, ocr });
      numbered.push(...(await readNumberedPage(worker, page, ocr)));
    }

    // Booklet reading (unchanged): one question per page and the circle answer key.
    const questions = new Map();
    const circleKey = new Map();
    for (const { page, ocr } of bookletPages) {
      // The heading, in capitals - not a sentence like "the answer key is at the end".
      if (/\bANSWER\s*KEY\b/.test(ocr.text)) {
        if (!letterWorker) {
          // A second worker only reads single letters (answer key circles), so the
          // page worker's settings never change during an import.
          letterWorker = await createWorker('eng', 1, options);
          await letterWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_CHAR, tessedit_char_whitelist: 'ABCDE' });
        }
        await readAnswerKey(letterWorker, page, ocr, circleKey);
        continue;
      }
      const m = ocr.text.match(/QUESTION\s*[O0]?(\d{1,3})/i);
      if (m && !questions.has(Number(m[1]))) questions.set(Number(m[1]), await readQuestionPage(worker, page, ocr, Number(m[1])));
    }
    fillUnreadLetters(circleKey);
    const booklet = [];
    for (const n of [...questions.keys()].sort((a, b) => a - b)) {
      const q = questions.get(n);
      const row = { section: defaultSection, category: circleKey.get(n)?.category || '', difficulty: '', marks: '', correct_answer: circleKey.get(n)?.letter || '', question_text: q.question_text };
      for (const l of 'abcde') row['option_' + l] = q['option_' + l] || '';
      for (const [field, canvas] of Object.entries(q.images)) row[field] = saveImage(canvas.toBuffer('image/png'));
      booklet.push(row);
    }

    // Numbered reading: the answer from the card drawn in green, else from the key grid.
    const gridKey = keyFromLines(keyLines);
    const seen = new Set();
    const numberedRows = [];
    for (const q of numbered.sort((a, b) => a.number - b.number)) {
      if (seen.has(q.number)) continue;
      seen.add(q.number);
      const keyLetter = gridKey.get(q.number) || '';
      const answer = q.green || keyLetter;
      const row = { section: defaultSection, number: q.number, category: titleCase(q.category), difficulty: '', marks: '', correct_answer: answer, question_text: q.question_text };
      if (q.green && keyLetter && keyLetter !== q.green) row.review = `The answer key says ${keyLetter} but the card marked green is ${q.green}: check the correct answer.`;
      for (const l of 'abcde') row['option_' + l] = q['option_' + l] || '';
      for (const [field, canvas] of Object.entries(q.images)) row[field] = saveImage(canvas.toBuffer('image/png'));
      numberedRows.push(row);
    }
    return { booklet, numbered: numberedRows, text: textPages.join('\n') };
  } finally {
    busy = false;
    if (worker) await worker.terminate().catch(() => {});
    if (letterWorker) await letterWorker.terminate().catch(() => {});
    await parser.destroy().catch(() => {});
  }
}

module.exports = { readScannedPdf };
