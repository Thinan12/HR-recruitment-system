// Builds the scanned-PDF test samples: every page is ONE picture (no text layer),
// like a scan or a PDF made of page images. Run: node test/fixtures/make-scanned-samples.js
//
//   scanned-numbered-cream.pdf  numbered questions with answer cards on cream paper:
//                               text cards, picture cards, a bold answer filling its card,
//                               the correct card framed in green, an answer key grid
//   scanned-numbered-white.pdf  the same kind of layout on plain white paper (outlined cards)
//   scanned-plain-text.pdf      plain numbered questions with A) B) C) D) and "Answer: X"
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { createCanvas } = require('@napi-rs/canvas');

const W = 1240; const H = 1754; // A4 at 150 dpi
const FONT = 'Arial, "DejaVu Sans", sans-serif';

function page(bg) {
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  return { c, g };
}
const text = (g, s, x, y, size, color = '#1f2933', weight = '') => { g.fillStyle = color; g.font = `${weight} ${size}px ${FONT}`; g.fillText(s, x, y); };
function roundRect(g, x, y, w, h, r, fill, stroke, lineWidth = 2) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lineWidth; g.stroke(); }
}
function badge(g, cx, cy, letter) {
  g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.fillStyle = '#1f2933'; g.fill();
  g.fillStyle = '#fff'; g.font = `bold 15px ${FONT}`; g.textAlign = 'center'; g.fillText(letter, cx, cy + 5); g.textAlign = 'left';
}
const SHAPES = {
  triangle: (g, cx, cy) => { g.beginPath(); g.moveTo(cx, cy - 28); g.lineTo(cx + 30, cy + 24); g.lineTo(cx - 30, cy + 24); g.closePath(); g.fillStyle = '#7c3aed'; g.fill(); },
  square: (g, cx, cy) => { g.fillStyle = '#f59e0b'; g.fillRect(cx - 26, cy - 26, 52, 52); },
  circle: (g, cx, cy) => { g.beginPath(); g.arc(cx, cy, 28, 0, Math.PI * 2); g.fillStyle = '#2563eb'; g.fill(); },
  cross: (g, cx, cy) => { g.strokeStyle = '#111'; g.lineWidth = 9; g.beginPath(); g.moveTo(cx - 24, cy - 24); g.lineTo(cx + 24, cy + 24); g.moveTo(cx + 24, cy - 24); g.lineTo(cx - 24, cy + 24); g.stroke(); },
};

// One numbered question: header, figure panel, answer cards (one framed in green).
function question(g, y, { n, title, category, figure, options, correct, cardFill = '#fff', cardStroke = '#d9d9d9', bold }) {
  text(g, `${n}.`, 70, y, 34, '#e0562f', 'bold');
  text(g, title, 140, y, 32, '#1f2933', 'bold');
  if (category) { g.font = `bold 20px ${FONT}`; const w = g.measureText(category).width; text(g, category, W - 70 - w, y - 4, 20, '#9aa0a6', 'bold'); }
  const top = y + 30;
  roundRect(g, 140, top, 470, 230, 12, cardFill, cardStroke);
  figure(g, 140, top, 470, 230);
  const cw = 120; const gap = 14; const x0 = 640; const cy = top + 50;
  options.forEach((o, i) => {
    const x = x0 + i * (cw + gap);
    roundRect(g, x, cy, cw, 135, 10, cardFill, i === correct ? '#16a34a' : cardStroke, i === correct ? 6 : 2);
    if (typeof o === 'string') { g.textAlign = 'center'; text(g, o, x + cw / 2, cy + 64, bold && i === 3 ? 26 : 30, '#1f2933', 'bold'); g.textAlign = 'left'; } else SHAPES[o](g, x + cw / 2, cy + 58);
    badge(g, x + cw / 2, cy + 108, 'ABCDE'[i]);
  });
  text(g, 'Answer: explained here in one sentence for the HR reader.', 140, top + 280, 24, '#3c4043');
}

function toPdf(pages, file) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
    const out = fs.createWriteStream(file);
    doc.pipe(out);
    for (const c of pages) { doc.addPage({ size: 'A4', margin: 0 }); doc.image(c.toBuffer('image/png'), 0, 0, { width: doc.page.width, height: doc.page.height }); }
    doc.end();
    out.on('finish', resolve);
  });
}

(async () => {
  const dir = __dirname;
  // 1. Cream paper, answer key grid, text and picture cards.
  {
    const p1 = page('#f5f4ef');
    text(p1.g, 'SAMPLE IQ TEST - ANSWERS', 70, 80, 30, '#e0562f', 'bold');
    text(p1.g, 'Quick answer key', 70, 160, 28, '#e0562f', 'bold');
    text(p1.g, '1.  C     2.  B     3.  D', 70, 215, 26, '#1f2933', 'bold');
    question(p1.g, 330, { n: 1, title: 'What number comes next?', category: 'NUMBER SERIES', options: ['14', '16', '18', '20'], correct: 2,
      figure: (g, x, y, w, h) => { g.textAlign = 'center'; text(g, '2, 6, 10, 14, ?', x + w / 2, y + h / 2 + 12, 40, '#1f2933', 'bold'); g.textAlign = 'left'; } });
    question(p1.g, 800, { n: 2, title: 'Which shape comes next?', category: 'SEQUENCES', options: ['circle', 'triangle', 'square', 'cross'], correct: 1,
      figure: (g, x, y, w, h) => { ['square', 'circle', 'square', 'circle'].forEach((s, i) => SHAPES[s](g, x + 70 + i * 100, y + h / 2)); } });
    question(p1.g, 1270, { n: 3, title: 'Who owns the fish?', category: 'LOGIC', options: ['Green', 'Blue', 'Nobody', 'Red house'], correct: 3, bold: true,
      figure: (g, x, y, w, h) => { g.textAlign = 'center'; text(g, 'Three houses: red, green, blue.', x + w / 2, y + 100, 22); text(g, 'The fish is not in the blue house.', x + w / 2, y + 135, 22); g.textAlign = 'left'; } });
    await toPdf([p1.c], path.join(dir, 'scanned-numbered-cream.pdf'));
  }
  // 2. White paper, outlined cards, the answer only from the green frame (no key).
  {
    const p = page('#ffffff');
    question(p.g, 120, { n: 1, title: 'Which number is the largest?', category: 'NUMBERS', options: ['48', '84', '64', '46'], correct: 1, cardStroke: '#9aa0a6',
      figure: (g, x, y, w, h) => { g.textAlign = 'center'; text(g, 'Pick the largest number.', x + w / 2, y + h / 2, 24); g.textAlign = 'left'; } });
    question(p.g, 600, { n: 2, title: 'Which shape has no corners?', category: 'SHAPES', options: ['square', 'triangle', 'cross', 'circle'], correct: 3, cardStroke: '#9aa0a6',
      figure: (g, x, y, w, h) => { SHAPES.triangle(g, x + 150, y + h / 2); SHAPES.square(g, x + 320, y + h / 2); } });
    await toPdf([p.c], path.join(dir, 'scanned-numbered-white.pdf'));
  }
  // 3. A plain scanned text page.
  {
    const p = page('#ffffff');
    const lines = ['General Knowledge Test', '', '1. What is the capital of Laos?', 'A) Bangkok', 'B) Vientiane', 'C) Hanoi', 'D) Phnom Penh', 'Answer: B', '',
      '2. How many days are in a week?', 'A) Five', 'B) Six', 'C) Seven', 'D) Eight', 'Answer: C', '',
      '3. Which number is even?', 'A) 3', 'B) 7', 'C) 9', 'D) 12', 'Answer: D'];
    lines.forEach((l, i) => text(p.g, l, 90, 110 + i * 52, i === 0 ? 38 : 30, '#111', i === 0 ? 'bold' : ''));
    await toPdf([p.c], path.join(dir, 'scanned-plain-text.pdf'));
  }
  console.log('written');
})();
