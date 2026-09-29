// The STANDARD candidate report: exactly 15 fields, the same on the web page,
// in Excel (one row per candidate), PDF and Word. It only reads the results
// the assessment already calculated (nothing is scored here). The detailed
// exports (reports.js) stay available as "Detailed".
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const docx = require('docx');

const FIELDS = [
  'Candidate Name', 'Phone Number', 'Graduate From', 'High School', 'College', 'University', 'School Name', 'Subject', 'GPA / Mark',
  'Date and Time', 'IQ Test Score', 'Behavioral Interview Test Score', 'Calculation Score', 'Essay Score', 'Pass / Not Pass Status',
];
const NONE = '—'; // not part of this candidate's assessment / not entered
const TIME_ZONE = process.env.DISPLAY_TIME_ZONE || 'Asia/Vientiane';
const FONT = path.join(__dirname, 'assets', 'NotoSansLao-Regular.ttf');

// "2026-09-28 13:22" in Lao time: sorts and filters as text.
function stamp(iso) {
  if (!iso) return NONE;
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
  const time = d.toLocaleTimeString('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} ${time}`;
}

const testOf = (c, sec) => (c.tests || []).find((t) => t.section === sec);
// The Behavioral Interview Test of an assessment: its behavioural / interview-format test.
// (Older results of the legacy General test are not relabelled as behavioural.)
const behavioralOf = (c) => (c.tests || []).find((t) => require('./testTypes').behavior(t.section) === 'interview') || null;
// A test's score as the application already shows it; a test that is not
// finished / not marked shows its state (never a made-up 0).
function score(t, finished) {
  if (!t) return NONE;
  if (t.status === 'SUBMITTED' && t.result === 'Pending') return 'Pending HR marking';
  if (t.status !== 'SUBMITTED' || t.result == null) return t.text || NONE; // Not started / Locked / In progress
  return finished(t);
}
const STATUS = { Pass: 'PASS', 'Not Pass': 'NOT PASS', Pending: 'PENDING' };

// Phone numbers compared by their digits (+856 20 ... = 020 ...).
const phoneKey = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.startsWith('856') ? '0' + d.slice(3) : d;
};

// One candidate -> the 15 values (plus the numbers Excel uses for % columns).
function row(c) {
  const iq = testOf(c, 'IQ');
  const general = behavioralOf(c);
  const calc = testOf(c, 'CALCULATION');
  const essay = testOf(c, 'ESSAY');
  const text = (v) => (v == null || String(v).trim() === '' ? NONE : String(v));
  const values = [
    text(c.name), text(c.phone), text(c.graduate_from), text(c.high_school), text(c.college), text(c.university), text(c.school_name), text(c.subject), text(c.gpa),
    stamp(c.assessment_date),
    score(iq, (t) => (t.lalco_iq_score != null ? `${t.lalco_iq_score} / 150` : t.score_text || NONE)),
    score(general, (t) => t.percent_text || NONE),
    score(calc, (t) => t.percent_text || NONE),
    score(essay, (t) => t.score_text || NONE),
    (c.tests || []).length ? STATUS[c.assessment_result] || 'PENDING' : NONE,
  ];
  const pct = (t) => (t && t.status === 'SUBMITTED' && t.result !== 'Pending' && t.percent != null ? t.percent / 100 : null);
  return { candidate_id: c.id, values, numbers: { 11: pct(general), 12: pct(calc) } };
}

// Rows for many candidates, each marked when its phone number is used by another candidate.
function rows(candidates) {
  const out = candidates.map(row);
  const count = new Map();
  for (const [i, c] of candidates.entries()) { const k = phoneKey(c.phone); if (k) count.set(k, (count.get(k) || 0) + 1); out[i].phone_key = k; }
  for (const r of out) r.duplicate_phone = r.phone_key ? count.get(r.phone_key) > 1 : false;
  for (const r of out) r.phone_count = r.phone_key ? count.get(r.phone_key) : 0;
  return out;
}

// ---- writers (shared with the Internal Office Staff reports) --------------------

// One row per record. opts: sheet, fields, rows [{ values, numbers, duplicate_phone, phone_count }],
// statusCol / pctCols / phoneCol (0-based column indexes), who (for the duplicate-phone note).
async function tableXlsx({ sheet: sheetName, fields, rows: list, statusCol, pctCols = [], phoneCol = null, who = 'candidates', wide = [] }) {
  const book = new ExcelJS.Workbook();
  book.creator = 'LALCO HR';
  const sheet = book.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = fields.map((f, i) => ({ header: f, key: 'c' + i, width: Math.max(14, f.length + 3, wide.includes(i) ? 22 : 0) }));
  const head = sheet.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
  for (const r of list) {
    const cells = r.values.map((v, i) => (r.numbers && r.numbers[i] != null ? r.numbers[i] : v));
    const x = sheet.addRow(cells);
    for (const i of pctCols) if (r.numbers && r.numbers[i] != null) x.getCell(i + 1).numFmt = '0.0%';
    const status = x.getCell(statusCol + 1);
    const v = r.values[statusCol];
    status.font = { bold: true, color: { argb: v === 'PASS' ? 'FF1E7B34' : v === 'NOT PASS' ? 'FFC00000' : 'FF7F6000' } };
    if (phoneCol != null && r.duplicate_phone) {
      const phone = x.getCell(phoneCol + 1);
      phone.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };
      phone.note = `Duplicate phone number: used by ${r.phone_count} ${who}.`;
    }
  }
  // Filter on every column of the header row (phone, date, scores, status …).
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: fields.length } };
  return Buffer.from(await book.xlsx.writeBuffer());
}

// One record as "field: value" lines; the status value in bold.
function recordPdf({ title, subtitle, fields, values, statusCol }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: title } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('main', FONT);
    doc.font('main').fontSize(20).text('LALCO', { align: 'center' });
    doc.fontSize(13).fillColor('#555').text(subtitle, { align: 'center' });
    doc.moveDown(1).fillColor('#000').fontSize(10.5);
    fields.forEach((f, i) => {
      const y = doc.y;
      doc.font('main').fillColor('#555').text(f, 50, y, { width: 190 });
      const bottom = doc.y;
      // PASS / NOT PASS in bold (a standard bold font: the words are Latin).
      if (i === statusCol) doc.font('Helvetica-Bold').fillColor(values[i] === 'NOT PASS' ? '#c00000' : values[i] === 'PASS' ? '#1e7b34' : '#000');
      else doc.font('main').fillColor('#000');
      doc.text(values[i], 250, y, { width: 295 });
      doc.y = Math.max(doc.y, bottom) + 4;
      doc.moveTo(50, doc.y - 2).lineTo(545, doc.y - 2).strokeColor('#e5e5e5').stroke();
    });
    doc.moveDown(1).font('main').fontSize(8.5).fillColor('#777').text(`Generated ${stamp(new Date().toISOString())}`, 50);
    doc.end();
  });
}

async function recordWord({ title, subtitle, fields, values, statusCol }) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } = docx;
  const font = 'Leelawadee UI';
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (text, opts = {}, width = 40) => new TableCell({ borders, width: { size: width, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text, font, ...opts })] })] });
  const children = [
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'LALCO', bold: true, size: 40, font })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: subtitle, size: 26, color: '555555', font })] }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE },
      rows: fields.map((f, i) => new TableRow({ children: [cell(f, { color: '555555' }), cell(values[i], i === statusCol ? { bold: true, color: values[i] === 'NOT PASS' ? 'C00000' : values[i] === 'PASS' ? '1E7B34' : undefined } : {}, 60)] })) }),
  ];
  return Packer.toBuffer(new Document({ creator: 'LALCO HR', title, sections: [{ children }] }));
}

// ---- the recruitment standard report ----------------------------------------------

const xlsx = (candidates) => tableXlsx({ sheet: 'Candidates', fields: FIELDS, rows: rows(candidates), statusCol: 14, pctCols: [11, 12], phoneCol: 1, who: 'candidates', wide: [0, 9, 10] });
const pdf = (c) => recordPdf({ title: `Candidate report - ${c.name}`, subtitle: 'Candidate Report', fields: FIELDS, values: rows([c])[0].values, statusCol: 14 });
const word = (c) => recordWord({ title: `Candidate report - ${c.name}`, subtitle: 'Candidate Report', fields: FIELDS, values: rows([c])[0].values, statusCol: 14 });

module.exports = { FIELDS, rows, xlsx, pdf, word, phoneKey, tableXlsx, recordPdf, recordWord, score, stamp, testOf, behavioralOf, STATUS, NONE };
