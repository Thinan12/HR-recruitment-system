// Reads an uploaded question file and turns it into validated question rows.
// Nothing is executed: we only read cell values or plain text.
//
// Two layouts are understood in every format:
//   1. A table with a header row (Question, Option A..D, Correct Answer, ...)
//   2. Numbered text blocks:
//        1. What comes next: 2, 4, 8, ?
//        A. 10   B. 12   C. 16   D. 18
//        Answer: C
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');
const { PDFParse } = require('pdf-parse');
const { readScannedPdf } = require('./pdfOcr');

const MAX_ROWS = 2000;
const SECTIONS = ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY'];
const LETTERS = ['A', 'B', 'C', 'D', 'E'];

const ALLOWED = {
  '.xlsx': 'zip', '.docx': 'zip',
  '.xls': 'ole', '.doc': 'ole',
  '.pdf': 'pdf',
  '.csv': 'text', '.txt': 'text',
};

class ImportError extends Error {}

const GENERIC_ERROR =
  'Unable to import this file.\n\nPlease check that the file contains:\nQuestion\nOptions\nCorrect Answer';

// ---- helpers ---------------------------------------------------------------

function sectionFrom(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  if (/^iq|intelligence|ໄອຄິວ/.test(v)) return 'IQ';
  if (/^calc|math|arithmetic|numer|ຄິດໄລ່|ຄະນິດ/.test(v)) return 'CALCULATION';
  if (/^essay|writing|ຂຽນ/.test(v)) return 'ESSAY';
  if (/^general|recruit|knowledge|ທົ່ວໄປ/.test(v)) return 'GENERAL';
  return null;
}

// Header text -> field name. Headers are compared without spaces/punctuation.
const HEADER_ALIASES = {
  question_text: ['question', 'questiontext', 'questions', 'text', 'ຄຳຖາມ'],
  section: ['type', 'section', 'test', 'testtype', 'questiontype', 'ປະເພດ'],
  category: ['category', 'topic', 'subject', 'ໝວດ'],
  difficulty: ['difficulty', 'level', 'ລະດັບ'],
  option_a: ['optiona', 'a', 'choicea', 'answera'],
  option_b: ['optionb', 'b', 'choiceb', 'answerb'],
  option_c: ['optionc', 'c', 'choicec', 'answerc'],
  option_d: ['optiond', 'd', 'choiced', 'answerd'],
  option_e: ['optione', 'e', 'choicee', 'answere'],
  correct_answer: ['correctanswer', 'answer', 'correct', 'key', 'answerkey', 'ຄຳຕອບ', 'ຄຳຕອບທີ່ຖືກ'],
  marks: ['marks', 'mark', 'points', 'point', 'score', 'ຄະແນນ'],
};

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[\s_\-./()*:]+/g, '');
}

function mapHeader(cells) {
  const map = {};
  cells.forEach((cell, i) => {
    const key = normalizeHeader(cell);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(key) && !(field in map)) map[field] = i;
    }
  });
  return 'question_text' in map ? map : null;
}

// Finds a header row in a 2D array and converts the rows below it.
function rowsFromTable(table, defaultSection) {
  for (let h = 0; h < Math.min(table.length, 10); h++) {
    const map = mapHeader(table[h] || []);
    if (!map) continue;
    const rows = [];
    for (const cells of table.slice(h + 1)) {
      if (!cells || cells.every((c) => String(c ?? '').trim() === '')) continue;
      const raw = {};
      for (const [field, i] of Object.entries(map)) raw[field] = cells[i] == null ? '' : String(cells[i]).trim();
      raw.section = sectionFrom(raw.section) || defaultSection;
      rows.push(raw);
    }
    return rows;
  }
  return null;
}

function splitInlineOptions(line) {
  // "A. 10  B. 20  C. 30  D. 40" -> ["A. 10", "B. 20", ...]
  return line.split(/\s+(?=\(?[B-E]\s*[.)]\s)/);
}

const RE_QUESTION = /^(?:q(?:uestion)?\s*)?(\d{1,4})\s*[.):]\s*(.+)$/i;
const RE_QUESTION_LABEL = /^question\s*[:.]\s*(.+)$/i;
const RE_OPTION = /^\(?([A-Ea-e])\s*[.):]\s*(.*)$/;
const RE_ANSWER = /^(?:correct\s*answer|answer|ans|correct|key|ຄຳຕອບ)\s*[:=：-]\s*(.+)$/i;
const RE_META = /^(type|section|category|difficulty|level|marks?|points?)\s*[:=：]\s*(.+)$/i;

// Parses numbered question blocks out of plain text.
function rowsFromText(text, defaultSection) {
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/ /g, ' ').trim());

  // Tab-separated tables (from .doc files and .txt exports) are handled as tables.
  const tabbed = lines.filter((l) => l.includes('\t')).map((l) => l.split('\t').map((c) => c.trim()));
  if (tabbed.length > 1) {
    const rows = rowsFromTable(tabbed, defaultSection);
    if (rows && rows.length) return rows;
  }

  const rows = [];
  let cur = null;
  let lastOption = null;
  const start = (textValue) => {
    cur = { question_text: textValue, section: defaultSection, option_a: '', option_b: '', option_c: '', option_d: '', option_e: '', correct_answer: '', category: '', difficulty: '', marks: '' };
    rows.push(cur);
    lastOption = null;
  };

  for (const line of lines) {
    if (!line) continue;
    let m;
    if ((m = line.match(RE_ANSWER)) && cur) { cur.correct_answer = m[1].trim(); continue; }
    if ((m = line.match(RE_META)) && cur) {
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === 'type' || key === 'section') cur.section = sectionFrom(value) || cur.section;
      else if (key === 'category') cur.category = value;
      else if (key === 'difficulty' || key === 'level') cur.difficulty = value;
      else cur.marks = value;
      continue;
    }
    if (RE_OPTION.test(line) && cur) {
      for (const part of splitInlineOptions(line)) {
        const om = part.match(RE_OPTION);
        if (!om) continue;
        lastOption = 'option_' + om[1].toLowerCase();
        cur[lastOption] = om[2].trim();
      }
      continue;
    }
    if ((m = line.match(RE_QUESTION)) || (m = line.match(RE_QUESTION_LABEL))) {
      start((m[2] ?? m[1]).trim());
      continue;
    }
    // Continuation line: part of the question, or of the last option.
    if (!cur || cur.correct_answer) start(line);
    else if (lastOption) cur[lastOption] += ' ' + line;
    else cur.question_text += '\n' + line;
  }
  return rows;
}

// ---- validation ------------------------------------------------------------

const IMAGE_KEYS = ['image_id', ...LETTERS.map((L) => `option_${L.toLowerCase()}_image`)];

// "easy", "EASY", "ງ່າຍ" -> "Easy" (the IQ test orders questions by it). Other text is kept as typed.
function standardDifficulty(v) {
  const s = v.toLowerCase();
  if (/^(easy|ງ່າຍ)/.test(s)) return 'Easy';
  if (/^(medium|normal|ປານກາງ)/.test(s)) return 'Medium';
  if (/^(hard|difficult|ຍາກ)/.test(s)) return 'Hard';
  return v;
}

function resolveAnswerLetter(answer, row) {
  const a = String(answer || '').trim();
  const letter = a.match(/^(?:option\s*)?\(?([A-Ea-e])\)?\.?$/i);
  if (letter) return letter[1].toUpperCase();
  const byText = LETTERS.find((L) => row['option_' + L.toLowerCase()] && row['option_' + L.toLowerCase()].trim().toLowerCase() === a.toLowerCase());
  return byText || null;
}

// Returns { question, errors }. question is ready to insert when errors is empty.
function validateQuestion(input) {
  const errors = [];
  const clean = (v, max) => String(v ?? '').trim().slice(0, max);
  const q = {
    section: SECTIONS.includes(input.section) ? input.section : sectionFrom(input.section),
    category: clean(input.category, 200),
    difficulty: standardDifficulty(clean(input.difficulty, 50)),
    question_text: clean(input.question_text, 5000),
    option_a: clean(input.option_a, 1000),
    option_b: clean(input.option_b, 1000),
    option_c: clean(input.option_c, 1000),
    option_d: clean(input.option_d, 1000),
    option_e: clean(input.option_e, 1000),
    correct_answer: clean(input.correct_answer, 1000),
    marks: input.marks === '' || input.marks == null ? 1 : Number(input.marks),
  };
  // Pictures are referenced by id (uploaded separately); the route checks they exist.
  for (const key of IMAGE_KEYS) {
    const id = Number(input[key]);
    q[key] = Number.isInteger(id) && id > 0 ? id : null;
  }
  if (!q.section) errors.push('Type must be IQ, General, Calculation or Essay.');
  if (!q.question_text) errors.push('Question text is missing.');
  if (!Number.isFinite(q.marks) || q.marks <= 0 || q.marks > 100) errors.push('Marks must be a number between 0 and 100.');

  const filled = LETTERS.filter((L) => q['option_' + L.toLowerCase()] || q['option_' + L.toLowerCase() + '_image']);
  if (q.section === 'ESSAY') {
    // Essays are marked by HR; options are ignored.
    LETTERS.forEach((L) => { q['option_' + L.toLowerCase()] = ''; q['option_' + L.toLowerCase() + '_image'] = null; });
  } else if (filled.length >= 2) {
    const letter = resolveAnswerLetter(q.correct_answer, q);
    if (!letter) errors.push('Correct answer must be one of the options (A, B, C, D or E).');
    else if (!filled.includes(letter)) errors.push(`Correct answer ${letter} has no option text or picture.`);
    else q.correct_answer = letter;
  } else if (filled.length === 1) {
    errors.push('A multiple-choice question needs at least 2 options.');
  } else if (q.section === 'CALCULATION') {
    if (!q.correct_answer) errors.push('Correct answer is missing.');
  } else {
    errors.push('Options are missing (need Option A, Option B, ...).');
  }
  return { question: q, errors };
}

// ---- file entry point ------------------------------------------------------

function detectKind(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return 'zip';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole';
  if (buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) return 'pdf';
  if (!buffer.subarray(0, 8192).includes(0)) return 'text';
  return 'unknown';
}

function decodeText(buffer) {
  return buffer.toString('utf8').replace(/^﻿/, '');
}

function rowsFromWorkbook(workbook, defaultSection) {
  const rows = [];
  let found = false;
  for (const name of workbook.SheetNames) {
    const table = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
    const sheetRows = rowsFromTable(table, sectionFrom(name) || defaultSection);
    if (sheetRows) { found = true; rows.push(...sheetRows); }
  }
  return found ? rows : [];
}

function htmlTables(html) {
  const decode = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((t) =>
    [...t[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) => [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => decode(c[1]))));
}

async function pdfText(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    return (await parser.getText({ pageJoiner: '' })).text;
  } finally {
    await parser.destroy();
  }
}

async function parseFile(buffer, originalName, defaultSection) {
  const ext = (String(originalName).match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!ALLOWED[ext]) throw new ImportError('This file type is not supported. Please upload Excel, Word, PDF, CSV or TXT.');
  if (detectKind(buffer) !== ALLOWED[ext]) throw new ImportError('This file does not look like a real ' + ext + ' file. Please save it again and retry.');

  let rows;
  try {
    if (ext === '.xlsx' || ext === '.xls') {
      rows = rowsFromWorkbook(XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false }), defaultSection);
    } else if (ext === '.csv') {
      rows = rowsFromWorkbook(XLSX.read(decodeText(buffer), { type: 'string', raw: true }), defaultSection);
    } else if (ext === '.docx') {
      const { value: html } = await mammoth.convertToHtml({ buffer });
      rows = htmlTables(html).map((t) => rowsFromTable(t, defaultSection)).find((r) => r && r.length);
      if (!rows) rows = rowsFromText((await mammoth.extractRawText({ buffer })).value, defaultSection);
    } else if (ext === '.doc') {
      const doc = await new WordExtractor().extract(buffer);
      rows = rowsFromText(doc.getBody(), defaultSection);
    } else if (ext === '.pdf') {
      rows = rowsFromText(await pdfText(buffer), defaultSection);
      // Pages that are pictures have no text to read: fall back to OCR.
      if (!rows.some((r) => validateQuestion(r).errors.length === 0)) {
        try {
          const scanned = await readScannedPdf(buffer, defaultSection);
          if (scanned.length) rows = scanned;
        } catch (e) {
          if (e.message === 'busy') throw new ImportError('Another scanned PDF is being read right now. Please try again in a minute.');
          throw e;
        }
      }
    } else {
      rows = rowsFromText(decodeText(buffer), defaultSection);
    }
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(GENERIC_ERROR);
  }

  if (!rows || rows.length === 0) throw new ImportError(GENERIC_ERROR);
  if (rows.length > MAX_ROWS) throw new ImportError(`This file has more than ${MAX_ROWS} questions. Please split it into smaller files.`);
  const checked = rows.map((raw, i) => {
    const { question, errors } = validateQuestion(raw);
    return { row: i + 1, question, errors };
  });
  if (!checked.some((r) => r.errors.length === 0)) throw new ImportError(GENERIC_ERROR);
  return checked;
}

module.exports = { parseFile, validateQuestion, ImportError, SECTIONS, LETTERS, IMAGE_KEYS, rowsFromText };
