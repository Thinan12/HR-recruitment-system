// Candidate summaries, dashboard numbers and PDF / Word / Excel exports.
const path = require('path');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const docx = require('docx');
const { db } = require('./db');

const FONT = path.join(__dirname, 'assets', 'NotoSansLao-Regular.ttf');
const pct = (points, max) => (max ? Math.round((points / max) * 1000) / 10 : null);

// A candidate's current results. Each section comes from the most recent
// submitted assessment that contained it; Test Score and Result come from the
// most recent submitted assessment overall.
function summarize(candidate, submitted) {
  const latestWith = (maxKey) => submitted.find((a) => a[maxKey] != null);
  const iq = latestWith('iq_max');
  const general = latestWith('general_max');
  const calc = latestWith('calc_max');
  const essay = latestWith('essay_max');
  const latest = submitted[0];
  const testResult = latest ? latest.result : 'Pending';
  return {
    ...candidate,
    iq_score: iq ? pct(iq.iq_points, iq.iq_max) : null,
    ...iqResult(iq),
    general_score: general ? pct(general.general_points, general.general_max) : null,
    calc_score: calc ? pct(calc.calc_points, calc.calc_max) : null,
    essay_score: essay && !essay.essay_pending ? pct(essay.essay_points, essay.essay_max) : null,
    essay_pending: essay ? essay.essay_pending > 0 : false,
    test_score: latest ? latest.test_score : null,
    test_result: testResult,
    // HR's Final Result wins; until it is decided, the test result is used.
    overall_result: candidate.final_result && candidate.final_result !== 'Pending' ? candidate.final_result : testResult,
    last_test_date: latest ? latest.submitted_at : null,
  };
}

// The IQ result of one assessment. The official IQ Test Score is the weighted
// marks (Level 1 = 1, Level 2 = 2, Level 3 = 3 per correct answer), e.g. "21 / 36".
const LEVELS = [['Easy', 'Level 1 — Easy'], ['Medium', 'Level 2 — Medium'], ['Hard', 'Level 3 — Hard']];
function iqResult(a) {
  if (!a || a.iq_max == null) return { iq_score: null, iq_text: null, iq_correct_text: null, iq_levels: [], iq_date: null };
  let breakdown = {};
  try { breakdown = JSON.parse(a.iq_breakdown || '{}') || {}; } catch { breakdown = {}; }
  const levels = LEVELS.map(([key, label], i) => {
    const b = breakdown[key];
    return b && b.total ? { level: i + 1, key, label, correct: b.correct, total: b.total, marks: b.marks, max: b.max,
      correct_text: `${b.correct} / ${b.total}`, marks_text: `${b.marks} / ${b.max}` } : null;
  }).filter(Boolean);
  return {
    iq_score: pct(a.iq_points, a.iq_max), // percentage of the weighted marks
    iq_points: a.iq_points,
    iq_max: a.iq_max,
    iq_text: `${a.iq_points} / ${a.iq_max}`,
    iq_correct: a.iq_correct,
    iq_total: a.iq_total,
    iq_correct_text: a.iq_total != null ? `${a.iq_correct} / ${a.iq_total}` : null,
    iq_levels: levels,
    iq_date: a.submitted_at,
  };
}
const levelText = (c, n) => { const l = (c.iq_levels || []).find((x) => x.level === n); return l ? l : null; };

function submittedByCandidate() {
  const map = new Map();
  for (const a of db.prepare("SELECT * FROM assessments WHERE status = 'SUBMITTED' ORDER BY submitted_at DESC, id DESC").all()) {
    if (!map.has(a.candidate_id)) map.set(a.candidate_id, []);
    map.get(a.candidate_id).push(a);
  }
  return map;
}

function allCandidateSummaries(search) {
  const q = String(search || '').trim();
  const rows = q
    ? db.prepare('SELECT * FROM candidates WHERE name LIKE ? OR phone LIKE ? ORDER BY created_at DESC, id DESC').all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM candidates ORDER BY created_at DESC, id DESC').all();
  const byCandidate = submittedByCandidate();
  return rows.map((c) => summarize(c, byCandidate.get(c.id) || []));
}

function candidateSummary(id) {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  if (!c) return null;
  const submitted = db.prepare("SELECT * FROM assessments WHERE candidate_id = ? AND status = 'SUBMITTED' ORDER BY submitted_at DESC, id DESC").all(id);
  return summarize(c, submitted);
}

function dashboard() {
  const people = allCandidateSummaries();
  const scored = people.filter((p) => p.test_score != null);
  const withIq = people.filter((p) => p.iq_score != null).sort((a, b) => b.iq_score - a.iq_score);
  const nowIso = new Date().toISOString();
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  return {
    total_candidates: people.length,
    passed: people.filter((p) => p.overall_result === 'Pass').length,
    not_passed: people.filter((p) => p.overall_result === 'Not Pass').length,
    average_test_score: scored.length ? Math.round((scored.reduce((s, p) => s + p.test_score, 0) / scored.length) * 10) / 10 : null,
    highest_iq: withIq[0] ? { id: withIq[0].id, name: withIq[0].name, iq_score: withIq[0].iq_score, iq_text: withIq[0].iq_text, iq_correct_text: withIq[0].iq_correct_text } : null,
    completed_assessments: count("SELECT COUNT(*) AS n FROM assessments WHERE status = 'SUBMITTED'"),
    pending_assessments: count(`SELECT COUNT(*) AS n FROM assessments WHERE status = 'IN_PROGRESS'
      OR (status = 'NOT_STARTED' AND enabled = 1 AND link_expires_at > ?)`, nowIso),
    recent: people.filter((p) => p.last_test_date).sort((a, b) => b.last_test_date.localeCompare(a.last_test_date)).slice(0, 8),
  };
}

// ---- export fields -------------------------------------------------------

const show = (v) => (v == null || v === '' ? '-' : String(v));
const showPct = (v) => (v == null ? '-' : v + '%');
// Dates in exports use Laos time (UTC+7), not the server's UTC clock.
const TIME_ZONE = process.env.DISPLAY_TIME_ZONE || 'Asia/Vientiane';
const localDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: TIME_ZONE }) : '');
const localDateTime = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' });
const showDate = (iso) => localDate(iso) || '-';

const COLUMNS = [
  ['Candidate Name', (c) => c.name],
  ['Phone Number', (c) => c.phone],
  ['Graduate From', (c) => c.graduate_from],
  ['High School', (c) => c.high_school],
  ['College', (c) => c.college],
  ['University', (c) => c.university],
  ['School Name', (c) => c.school_name],
  ['Subject', (c) => c.subject],
  ['GPA / Mark', (c) => c.gpa],
  ['Reference Results', (c) => c.reference_results],
  ['IQ Test Score', (c) => c.iq_text],
  ['IQ %', (c) => c.iq_score],
  ['IQ Correct Answers', (c) => c.iq_correct_text],
  ['Level 1 Correct', (c) => levelText(c, 1)?.correct_text],
  ['Level 1 Marks', (c) => levelText(c, 1)?.marks_text],
  ['Level 2 Correct', (c) => levelText(c, 2)?.correct_text],
  ['Level 2 Marks', (c) => levelText(c, 2)?.marks_text],
  ['Level 3 Correct', (c) => levelText(c, 3)?.correct_text],
  ['Level 3 Marks', (c) => levelText(c, 3)?.marks_text],
  ['Character', (c) => c.character_note],
  ['Test Score', (c) => c.test_score],
  ['General Test', (c) => c.general_score],
  ['Calculation Test', (c) => c.calc_score],
  ['Essay Test', (c) => (c.essay_pending ? 'Pending' : c.essay_score)],
  ['Interview', (c) => c.interview],
  ['Interviewer', (c) => c.interviewer],
  ['Interview Score', (c) => c.interview_score],
  ['Result', (c) => c.test_result],
  ['Remark', (c) => c.remark],
  ['Chairman Interview', (c) => c.chairman_interview],
  ['Final Result', (c) => c.final_result],
  ['Date Come to Work', (c) => c.date_come_to_work],
  ['Test Date', (c) => localDate(c.last_test_date)],
];

function reportSections(c) {
  return [
    ['Candidate Information', [
      ['Name', show(c.name)], ['Phone', show(c.phone)], ['Graduate From', show(c.graduate_from)],
      ['High School', show(c.high_school)], ['College', show(c.college)], ['University', show(c.university)],
      ['School Name', show(c.school_name)], ['Subject', show(c.subject)], ['GPA / Mark', show(c.gpa)],
    ]],
    ['Assessment Results', [
      ['Reference Results', show(c.reference_results)],
      ['IQ Test Score', c.iq_text ? `${c.iq_text} marks (${c.iq_score}%)` : '-'],
      ['IQ Correct Answers', show(c.iq_correct_text)],
      ...(c.iq_levels || []).map((l) => [l.label, `${l.correct_text} correct, ${l.marks_text} marks`]),
      ['Character', show(c.character_note)],
      ['Test Score', showPct(c.test_score)], ['General Test', showPct(c.general_score)], ['Calculation Test', showPct(c.calc_score)],
      ['Essay Test', c.essay_pending ? 'Pending' : showPct(c.essay_score)], ['Result', show(c.test_result)], ['Test Date', showDate(c.last_test_date)],
    ]],
    ['Interview', [
      ['Interview', show(c.interview)], ['Interviewer', show(c.interviewer)], ['Interview Score', show(c.interview_score)],
      ['Remark', show(c.remark)], ['Chairman Interview', show(c.chairman_interview)],
    ]],
    ['Decision', [
      ['Final Result', show(c.final_result)], ['Date Come to Work', show(c.date_come_to_work)],
    ]],
  ];
}

const NOTE = 'Scores are percentages of available marks. IQ Test Score = marks earned (Level 1 = 1, Level 2 = 2, Level 3 = 3 per correct answer) out of the maximum; it is not a clinical IQ measurement.';

function candidatePdf(c) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Candidate report - ${c.name}` } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('main', FONT);
    doc.font('main');

    doc.fontSize(20).text('LALCO', { align: 'center' });
    doc.fontSize(13).fillColor('#555').text('HR Recruitment Assessment', { align: 'center' });
    doc.moveDown(1).fillColor('#000');

    const labelX = 50;
    const valueX = 200;
    for (const [title, rows] of reportSections(c)) {
      if (doc.y > 720) doc.addPage();
      doc.fontSize(12.5).fillColor('#1f4e79').text(title, labelX);
      doc.moveTo(labelX, doc.y + 1).lineTo(545, doc.y + 1).strokeColor('#cccccc').stroke();
      doc.moveDown(0.35).fontSize(10).fillColor('#000');
      for (const [k, v] of rows) {
        const y = doc.y;
        doc.fillColor('#555').text(k + ':', labelX, y, { width: 140 });
        const labelBottom = doc.y;
        doc.fillColor('#000').text(v, valueX, y, { width: 345 });
        doc.y = Math.max(doc.y, labelBottom) + 1;
      }
      doc.moveDown(0.6);
    }
    doc.fontSize(8.5).fillColor('#777').text(NOTE, labelX);
    doc.text(`Generated ${localDateTime(new Date().toISOString())}`, labelX);
    doc.end();
  });
}

async function candidateDocx(c) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, AlignmentType, BorderStyle } = docx;
  const font = 'Leelawadee UI'; // ships with Windows; covers Lao and Latin
  const para = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, font, ...opts })] });
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const children = [
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'LALCO', bold: true, size: 40, font })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: 'HR Recruitment Assessment', size: 26, color: '555555', font })] }),
  ];
  for (const [title, rows] of reportSections(c)) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: title, font, color: '1F4E79' })] }));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map(([k, v]) => new TableRow({
        children: [
          new TableCell({ borders, width: { size: 32, type: WidthType.PERCENTAGE }, children: [para(k, { color: '555555' })] }),
          new TableCell({ borders, width: { size: 68, type: WidthType.PERCENTAGE }, children: [para(v)] }),
        ],
      })),
    }));
  }
  children.push(new Paragraph({ spacing: { before: 300 }, children: [new TextRun({ text: NOTE, size: 16, color: '777777', font })] }));
  return Packer.toBuffer(new Document({ creator: 'LALCO HR', title: `Candidate report - ${c.name}`, sections: [{ children }] }));
}

function candidatesXlsx(candidates) {
  const header = COLUMNS.map(([h]) => h);
  const rows = candidates.map((c) => COLUMNS.map(([, get]) => {
    const v = get(c);
    return v == null ? '' : v;
  }));
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  sheet['!cols'] = header.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Candidates');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function questionTemplateXlsx() {
  const rows = [
    ['Question', 'Type', 'Category', 'Difficulty', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer', 'Marks'],
    ['What number comes next: 2, 4, 8, 16, ?', 'IQ', 'Number pattern', 'Easy', '24', '32', '30', '20', 'B', 1],
    ['Which one is the odd one out?', 'IQ', 'Odd one out', 'Easy', 'Apple', 'Banana', 'Carrot', 'Mango', 'C', 1],
    ['What is 15% of 200?', 'Calculation', 'Percentage', 'Easy', '', '', '', '', '30', 1],
    ['Why do you want to work at LALCO?', 'Essay', 'Motivation', '', '', '', '', '', '', 10],
    ['What does HR stand for?', 'General', 'General knowledge', 'Easy', 'Human Resources', 'High Revenue', 'Home Rules', 'Hard Rate', 'A', 1],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 45 }, { wch: 12 }, { wch: 18 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 15 }, { wch: 7 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Questions');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { iqResult, allCandidateSummaries, candidateSummary, dashboard, candidatePdf, candidateDocx, candidatesXlsx, questionTemplateXlsx };
