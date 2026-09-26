// The original LALCO IQ question bank: 45 questions (15 Easy, 15 Medium,
// 15 Hard bands, tagged on the 5-level scale below) covering number patterns, sequences, visual patterns and matrices,
// odd one out, logical relationships, spatial reasoning (rotation and
// reflection), mathematical reasoning and abstract patterns.
// All questions and pictures are original; pictures are drawn here in code.
//
// Loads the bank through the admin API (safe to run twice: it stops if the
// bank is already there):
//   node scripts/lalco-iq-bank.js <base-url> <admin-password>
//   node scripts/lalco-iq-bank.js --preview <folder>   (writes the pictures as PNG files)
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

// ---- drawing ------------------------------------------------------------------

const INK = '#1f2933';
const NAVY = '#1f4e79';
const ORANGE = '#e07b39';

function canvas(w, h, draw) {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  draw(g);
  return c.toBuffer('image/png');
}

function poly(g, points, fill) {
  g.beginPath();
  points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.stroke();
}

function shape(g, type, x, y, size, fill = NAVY) {
  const r = size / 2;
  if (type === 'circle') {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { g.fillStyle = fill; g.fill(); }
    g.lineWidth = 3; g.strokeStyle = INK; g.stroke();
  } else if (type === 'square') {
    poly(g, [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]], fill);
  } else if (type === 'triangle') {
    poly(g, [[x, y - r], [x + r, y + r * 0.8], [x - r, y + r * 0.8]], fill);
  } else if (type === 'star') {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.45 : r;
      pts.push([x + rr * Math.cos(a), y + rr * Math.sin(a)]);
    }
    poly(g, pts, fill);
  }
}

// An arrow pointing at `deg` degrees (0 = up, 90 = right, clockwise).
function arrow(g, x, y, deg, fill = NAVY, scale = 1) {
  const pts = [[-8, 34], [8, 34], [8, -4], [22, -4], [0, -34], [-22, -4], [-8, -4]];
  const a = (deg * Math.PI) / 180;
  poly(g, pts.map(([px, py]) => [x + scale * (px * Math.cos(a) - py * Math.sin(a)), y + scale * (px * Math.sin(a) + py * Math.cos(a))]), fill);
}

function dots(g, n, x, y, spacing = 18, radius = 6) {
  const cols = Math.min(n, 3);
  const rows = Math.ceil(n / 3);
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / 3);
    const inRow = row === rows - 1 ? n - row * 3 : cols;
    const col = i % 3;
    g.beginPath();
    g.arc(x + (col - (inRow - 1) / 2) * spacing, y + (row - (rows - 1) / 2) * spacing, radius, 0, Math.PI * 2);
    g.fillStyle = NAVY;
    g.fill();
  }
}

// A square split into four; `shaded` is 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left.
function quadrants(g, x, y, size, shaded) {
  const h = size / 2;
  const corners = [[x - h, y - h], [x, y - h], [x, y], [x - h, y]];
  const [sx, sy] = corners[shaded];
  g.fillStyle = NAVY;
  g.fillRect(sx, sy, h, h);
  g.lineWidth = 3; g.strokeStyle = INK;
  g.strokeRect(x - h, y - h, size, size);
  g.beginPath(); g.moveTo(x, y - h); g.lineTo(x, y + h); g.moveTo(x - h, y); g.lineTo(x + h, y); g.stroke();
}

// Draws points after mirroring (mx/my = -1) and rotating by deg.
function transformed(g, x, y, points, { deg = 0, mx = 1, my = 1, fill = NAVY, scale = 1 }) {
  const a = (deg * Math.PI) / 180;
  poly(g, points.map(([px, py]) => {
    const qx = px * mx * scale; const qy = py * my * scale;
    return [x + qx * Math.cos(a) - qy * Math.sin(a), y + qx * Math.sin(a) + qy * Math.cos(a)];
  }), fill);
}
const F_SHAPE = [[-20, -40], [20, -40], [20, -28], [-8, -28], [-8, -6], [10, -6], [10, 6], [-8, 6], [-8, 40], [-20, 40]];
// A flag on a pole with a foot: no rotation of it equals its mirror image.
const FLAG_PARTS = [
  [[-4, -40], [4, -40], [4, 40], [-4, 40]],
  [[4, -40], [34, -26], [4, -12]],
  [[4, 30], [24, 30], [24, 40], [4, 40]],
];

function questionMark(g, x, y, size) {
  const h = size / 2;
  g.setLineDash([8, 6]);
  g.lineWidth = 3; g.strokeStyle = ORANGE;
  g.strokeRect(x - h, y - h, size, size);
  g.setLineDash([]);
  g.fillStyle = ORANGE;
  g.font = `bold ${Math.round(size * 0.55)}px sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('?', x, y + 2);
}

// A row of items followed by "?".
const sequence = (items) => canvas(items.length * 110 + 130, 150, (g) => {
  items.forEach((draw, i) => draw(g, 70 + i * 110, 75));
  questionMark(g, 70 + items.length * 110, 75, 80);
});
// A 3 x 3 grid; the last cell is "?".
const matrix = (cells) => canvas(350, 350, (g) => {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const x = 65 + c * 110; const y = 65 + r * 110;
    g.lineWidth = 1.5; g.strokeStyle = '#c8d0d9'; g.strokeRect(x - 50, y - 50, 100, 100);
    if (r === 2 && c === 2) questionMark(g, x, y, 70); else cells[r * 3 + c](g, x, y);
  }
});
const option = (draw) => canvas(160, 140, (g) => draw(g, 80, 70));

// Small building blocks used in the grids.
const vline = (g, x, y) => { g.lineWidth = 5; g.strokeStyle = NAVY; g.beginPath(); g.moveTo(x, y - 32); g.lineTo(x, y + 32); g.stroke(); };
const hline = (g, x, y) => { g.lineWidth = 5; g.strokeStyle = NAVY; g.beginPath(); g.moveTo(x - 32, y); g.lineTo(x + 32, y); g.stroke(); };
const back = (g, x, y) => { g.lineWidth = 5; g.strokeStyle = NAVY; g.beginPath(); g.moveTo(x - 28, y - 28); g.lineTo(x + 28, y + 28); g.stroke(); };
const fwd = (g, x, y) => { g.lineWidth = 5; g.strokeStyle = NAVY; g.beginPath(); g.moveTo(x - 28, y + 28); g.lineTo(x + 28, y - 28); g.stroke(); };
const ring = (g, x, y) => shape(g, 'circle', x, y, 64, null);
const box = (g, x, y) => shape(g, 'square', x, y, 60, null);
const dot = (g, x, y) => dots(g, 1, x, y, 0, 8);
const inShape = (type, n) => (g, x, y) => { shape(g, type, x, y, 78, null); dots(g, n, x, y + (type === 'triangle' ? 10 : 0), 16, 5); };

// ---- the bank -------------------------------------------------------------------

const NUM = 'Number Pattern'; const SEQ = 'Sequence Reasoning'; const VIS = 'Visual Pattern'; const ODD = 'Odd One Out';
const REL = 'Logical Relationship'; const SPA = 'Spatial Reasoning'; const MATH = 'Mathematical Reasoning'; const ABS = 'Abstract Pattern';

// t: question text, o: text options, a: correct letter, c: category, fig/opts: pictures.
const BANK = {
  Easy: [
    { t: 'What number comes next?\n3, 6, 9, 12, ?', o: ['14', '15', '16', '18'], a: 'B', c: NUM },
    { t: 'What number comes next?\n1, 2, 4, 8, ?', o: ['12', '14', '16', '18'], a: 'C', c: NUM },
    { t: 'What number comes next?\n20, 17, 14, 11, ?', o: ['7', '8', '9', '10'], a: 'B', c: NUM },
    { t: 'What number comes next?\n5, 10, 15, 20, ?', o: ['22', '24', '25', '30'], a: 'C', c: NUM },
    { t: 'Which letter comes next?\nA, C, E, G, ?', o: ['H', 'I', 'J', 'K'], a: 'B', c: SEQ },
    { t: 'Which one is the odd one out?\nDog · Cat · Eagle · Horse', o: ['Dog', 'Cat', 'Eagle', 'Horse'], a: 'C', c: ODD },
    { t: 'Which number is the odd one out?\n2 · 4 · 7 · 8 · 10', o: ['2', '7', '8', '10'], a: 'B', c: ODD },
    { t: 'Complete the pair.\nDay : Night :: Up : ?', o: ['Sky', 'Down', 'High', 'Over'], a: 'B', c: REL },
    { t: 'All roses are flowers. This plant is a rose.\nIs this plant a flower?', o: ['Yes', 'No', 'Cannot tell', 'Only in summer'], a: 'A', c: REL },
    { t: 'Anna has 5 apples. She gives away 2, then buys 4 more.\nHow many apples does she have now?', o: ['6', '7', '8', '9'], a: 'B', c: MATH },
    { t: 'Which symbol comes next?\n▲ ● ▲ ● ▲ ?', o: ['▲', '●', '■', '★'], a: 'B', c: ABS },
    {
      t: 'Which shape comes next?', c: VIS, a: 'A',
      fig: () => sequence([(g, x, y) => shape(g, 'circle', x, y, 70), (g, x, y) => shape(g, 'square', x, y, 64), (g, x, y) => shape(g, 'circle', x, y, 70), (g, x, y) => shape(g, 'square', x, y, 64)]),
      opts: ['circle', 'square', 'triangle', 'star'].map((s) => () => option((g, x, y) => shape(g, s, x, y, s === 'square' ? 64 : 72))),
    },
    {
      t: 'Which square comes next?', c: VIS, a: 'B',
      fig: () => sequence([20, 35, 50, 65].map((s) => (g, x, y) => shape(g, 'square', x, y, s))),
      opts: [50, 80, 20, 65].map((s) => () => option((g, x, y) => shape(g, 'square', x, y, s))),
    },
    {
      t: 'Which arrow comes next?', c: SPA, a: 'C',
      fig: () => sequence([0, 90, 180].map((d) => (g, x, y) => arrow(g, x, y, d))),
      opts: [0, 90, 270, 180].map((d) => () => option((g, x, y) => arrow(g, x, y, d))),
    },
    {
      t: 'How many dots come next?', c: VIS, a: 'D',
      fig: () => sequence([1, 2, 3, 4].map((n) => (g, x, y) => { shape(g, 'square', x, y, 84, null); dots(g, n, x, y, 22, 7); })),
      opts: [3, 4, 6, 5].map((n) => () => option((g, x, y) => { shape(g, 'square', x, y, 84, null); dots(g, n, x, y, 22, 7); })),
    },
  ],
  Medium: [
    { t: 'What number comes next?\n2, 6, 18, 54, ?', o: ['108', '162', '216', '72'], a: 'B', c: NUM },
    { t: 'What number comes next?\n1, 8, 27, 64, ?', o: ['100', '121', '125', '216'], a: 'C', c: NUM },
    { t: 'What number comes next?\n3, 5, 9, 17, 33, ?', o: ['49', '63', '65', '66'], a: 'C', c: NUM },
    { t: 'Which letter comes next?\nB, E, H, K, ?', o: ['M', 'N', 'O', 'P'], a: 'B', c: SEQ },
    { t: 'Which letter comes next?\nZ, X, V, T, ?', o: ['S', 'R', 'Q', 'P'], a: 'B', c: SEQ },
    { t: 'In a code, PEN is written as QFO.\nHow is INK written in the same code?', o: ['JOL', 'HMJ', 'JNL', 'KOL'], a: 'A', c: ABS },
    { t: 'Complete the pair.\nBird : Nest :: Bee : ?', o: ['Honey', 'Hive', 'Flower', 'Wing'], a: 'B', c: REL },
    { t: 'Tom is older than Ben. Ben is older than Sara. Sara is older than Kim.\nWho is the second youngest?', o: ['Tom', 'Ben', 'Sara', 'Kim'], a: 'C', c: REL },
    { t: 'Which number is the odd one out?\n21 · 35 · 49 · 54 · 63', o: ['35', '49', '54', '63'], a: 'C', c: ODD },
    { t: 'A car travels 60 km every hour.\nHow far does it travel in 2½ hours?', o: ['120 km', '140 km', '150 km', '160 km'], a: 'C', c: MATH },
    { t: '3 pens cost 12,000 kip.\nHow much do 5 pens cost?', o: ['15,000 kip', '18,000 kip', '20,000 kip', '24,000 kip'], a: 'C', c: MATH },
    {
      t: 'Which shape completes the grid?', c: VIS, a: 'C',
      fig: () => matrix(['circle', 'square', 'triangle', 'square', 'triangle', 'circle', 'triangle', 'circle'].map((s) => (g, x, y) => shape(g, s, x, y, s === 'square' ? 56 : 62))),
      opts: ['circle', 'triangle', 'square', 'star'].map((s) => () => option((g, x, y) => shape(g, s, x, y, s === 'square' ? 64 : 72))),
    },
    {
      t: 'Which arrow comes next?', c: SPA, a: 'B',
      fig: () => sequence([90, 45, 0, 315].map((d) => (g, x, y) => arrow(g, x, y, d))),
      opts: [225, 270, 0, 135].map((d) => () => option((g, x, y) => arrow(g, x, y, d))),
    },
    {
      t: 'Which square comes next?', c: SPA, a: 'C',
      fig: () => sequence([0, 1, 2].map((q) => (g, x, y) => quadrants(g, x, y, 80, q))),
      opts: [0, 1, 3, 2].map((q) => () => option((g, x, y) => quadrants(g, x, y, 90, q))),
    },
    {
      t: 'The dashed line is a mirror.\nWhich option is the mirror image of the shape?', c: SPA, a: 'C',
      fig: () => canvas(300, 150, (g) => {
        transformed(g, 90, 75, F_SHAPE, {});
        g.setLineDash([8, 6]); g.lineWidth = 3; g.strokeStyle = ORANGE;
        g.beginPath(); g.moveTo(170, 15); g.lineTo(170, 135); g.stroke(); g.setLineDash([]);
        questionMark(g, 240, 75, 80);
      }),
      opts: [{}, { my: -1 }, { mx: -1 }, { deg: 90 }].map((t) => () => option((g, x, y) => transformed(g, x, y, F_SHAPE, t))),
    },
  ],
  Hard: [
    { t: 'What number comes next?\n2, 3, 5, 9, 17, ?', o: ['31', '32', '33', '34'], a: 'C', c: NUM },
    { t: 'What number comes next?\n1, 2, 6, 24, 120, ?', o: ['240', '600', '720', '840'], a: 'C', c: NUM },
    { t: 'What number comes next?\n4, 9, 25, 49, 121, ?', o: ['144', '169', '196', '225'], a: 'B', c: NUM },
    { t: 'What number comes next?\n1, 10, 3, 20, 5, 30, ?', o: ['6', '7', '35', '40'], a: 'B', c: NUM },
    { t: 'Which letter comes next?\nA, B, D, G, K, ?', o: ['O', 'P', 'Q', 'R'], a: 'B', c: SEQ },
    { t: 'If 2 → 6, 3 → 12 and 4 → 20,\nthen 5 → ?', o: ['25', '28', '30', '36'], a: 'C', c: ABS },
    { t: 'Some As are Bs. All Bs are Cs.\nWhich statement must be true?', o: ['All As are Cs', 'Some As are Cs', 'No As are Cs', 'All Cs are As'], a: 'B', c: REL },
    { t: 'Five people meet. Each person shakes hands with every other person once.\nHow many handshakes are there?', o: ['5', '10', '20', '25'], a: 'B', c: MATH },
    { t: 'What is the smaller angle between the hands of a clock at 9:30?', o: ['90°', '100°', '105°', '120°'], a: 'C', c: MATH },
    { t: 'A father is 4 times as old as his son. In 20 years he will be twice as old as his son.\nHow old is the son now?', o: ['8', '10', '12', '15'], a: 'B', c: MATH },
    { t: '3 workers build a wall in 6 days.\nWorking at the same speed, how many days would 9 workers need?', o: ['2', '3', '12', '18'], a: 'A', c: MATH },
    {
      t: 'Which figure completes the grid?', c: VIS, a: 'C',
      fig: () => matrix(['circle', 'square', 'triangle'].flatMap((s, r) => [1, 2, 3].map((n) => inShape(s, n))).slice(0, 8)),
      opts: [['triangle', 2], ['square', 3], ['triangle', 3], ['circle', 3]].map(([s, n]) => () => option((g, x, y) => inShape(s, n)(g, x, y))),
    },
    {
      t: 'Which arrow comes next?', c: SPA, a: 'B',
      fig: () => sequence([[0, NAVY], [270, '#ffffff'], [180, NAVY], [90, '#ffffff']].map(([d, f]) => (g, x, y) => arrow(g, x, y, d, f))),
      opts: [[0, '#ffffff'], [0, NAVY], [270, NAVY], [90, NAVY]].map(([d, f]) => () => option((g, x, y) => arrow(g, x, y, d, f))),
    },
    {
      t: 'Which figure completes the grid?', c: VIS, a: 'D',
      fig: () => matrix([vline, hline, (g, x, y) => { vline(g, x, y); hline(g, x, y); }, ring, dot, (g, x, y) => { ring(g, x, y); dot(g, x, y); }, box, back]),
      opts: [[box], [box, fwd], [ring, back], [box, back]].map((parts) => () => option((g, x, y) => parts.forEach((p) => p(g, x, y)))),
    },
    {
      t: 'Three of these are the same shape turned around.\nWhich one is different?', c: SPA, a: 'C',
      opts: [{}, { deg: 90 }, { mx: -1 }, { deg: 180 }].map((t) => () => option((g, x, y) => FLAG_PARTS.forEach((p) => transformed(g, x, y, p, t)))),
    },
  ],
};

// The 5-level scale (1 Easy ... 5 Very Difficult). The bank above is grouped in
// three bands; each Medium question is Level 2 (Basic) or 3 (Moderate), each
// Hard question Level 4 (Difficult) or 5 (Very Difficult), in list order.
const FIVE_LEVELS = {
  Easy: Array(15).fill('Easy'),
  Medium: ['Basic', 'Moderate', 'Moderate', 'Basic', 'Basic', 'Moderate', 'Basic', 'Moderate', 'Moderate', 'Basic', 'Basic', 'Basic', 'Moderate', 'Basic', 'Moderate'],
  Hard: ['Difficult', 'Difficult', 'Very Difficult', 'Difficult', 'Difficult', 'Difficult', 'Very Difficult', 'Difficult', 'Very Difficult', 'Very Difficult',
    'Difficult', 'Difficult', 'Difficult', 'Very Difficult', 'Very Difficult'],
};

// ---- loading --------------------------------------------------------------------

async function main() {
  const [first, second] = process.argv.slice(2);
  if (first === '--preview') {
    const dir = second || 'iq-preview';
    fs.mkdirSync(dir, { recursive: true });
    for (const [level, list] of Object.entries(BANK)) list.forEach((q, i) => {
      if (q.fig) fs.writeFileSync(path.join(dir, `${level}-${i + 1}-question.png`), q.fig());
      (q.opts || []).forEach((o, k) => fs.writeFileSync(path.join(dir, `${level}-${i + 1}-${'ABCD'[k]}${'ABCD'[k] === q.a ? '-correct' : ''}.png`), o()));
    });
    console.log('pictures written to', dir);
    return;
  }
  const BASE = first; const PASSWORD = second;
  if (!BASE || !PASSWORD) throw new Error('Usage: node scripts/lalco-iq-bank.js <base-url> <admin-password>');
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = await r.json();
    if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(data)}`);
    return data;
  };
  const upload = async (png) => (await call('POST', '/api/admin/images', { data_url: 'data:image/png;base64,' + png.toString('base64') })).id;

  await call('POST', '/api/admin/auth/login', { username: 'admin', password: PASSWORD });
  const existing = (await call('GET', '/api/admin/questions?section=IQ')).questions;
  if (existing.some((q) => q.question_text === BANK.Hard[5].t)) { console.log('The LALCO IQ bank is already loaded - nothing added.'); return; }
  let added = 0;
  for (const [band, list] of Object.entries(BANK)) for (const [i, q] of list.entries()) {
    const body = { section: 'IQ', difficulty: FIVE_LEVELS[band][i], category: q.c, question_text: q.t, correct_answer: q.a }; // marks follow the level
    (q.o || []).forEach((text, i) => { body['option_' + 'abcd'[i]] = text; });
    if (q.fig) body.image_id = await upload(q.fig());
    for (const [i, o] of (q.opts || []).entries()) body[`option_${'abcd'[i]}_image`] = await upload(o());
    await call('POST', '/api/admin/questions', body);
    added++;
  }
  const counts = await call('GET', '/api/admin/questions/counts');
  console.log(`Added ${added} LALCO IQ questions. The IQ bank now has ${counts.IQ} active questions.`);
}

if (require.main === module) main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
module.exports = { BANK, FIVE_LEVELS };
