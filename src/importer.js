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
const { difficultyLevel, LEVEL_MARKS } = require('./assessments');
const { bulletQuestions, pdfLines, docxLines, isBehavioural, looksLikeQuestion } = require('./bulletImport');

const MAX_ROWS = 2000;
const SECTIONS = ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY']; // the core test types (see testTypes.js for all)
const T = require('./testTypes');
const LETTERS = ['A', 'B', 'C', 'D', 'E'];

const ALLOWED = {
  '.xlsx': 'zip', '.docx': 'zip',
  '.xls': 'ole', '.doc': 'ole',
  '.pdf': 'pdf',
  '.csv': 'text', '.tsv': 'text', '.txt': 'text',
};

class ImportError extends Error {}

const NO_STRUCTURE = 'Could not detect a valid question structure in this file.';

// What was found in a file, shown when nothing could be imported.
function diagnostics(rows, checked) {
  const optionsFound = rows.reduce((n, r) => n + ['a', 'b', 'c', 'd', 'e'].filter((l) => r['option_' + l] || r['option_' + l + '_image']).length, 0);
  const answersFound = rows.filter((r) => String(r.correct_answer || '').trim()).length;
  const conflicts = checked.filter((r) => r.errors.some((e) => /conflict/i.test(e))).length;
  return `${NO_STRUCTURE}

Detected format: ${rows.format || 'table (header row)'}
Questions found: ${rows.length}
Options found: ${optionsFound}
Answers found: ${answersFound}${rows.keyCount ? ` (answer key: ${rows.keyCount})` : ''}
Valid questions: 0
Invalid questions: ${checked.length}
Answer conflicts: ${conflicts}

A question needs its text, options A, B, C ... (not for Essay or short-answer Calculation) and a correct answer (inline "Answer: B" or an Answer Key section).`;
}

// ---- helpers ---------------------------------------------------------------

// The managed test type a file value means (key, name or title first, then the usual words).
function sectionFrom(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  const managed = T.resolve(v);
  if (managed) return managed;
  if (/^iq|intelligence|ໄອຄິວ/.test(v)) return 'IQ';
  if (/^calc|math|arithmetic|numer|ຄິດໄລ່|ຄະນິດ/.test(v)) return 'CALCULATION';
  if (/^essay|writing|ຂຽນ/.test(v)) return 'ESSAY';
  if (/^general|recruit|knowledge|ທົ່ວໄປ/.test(v)) return 'GENERAL';
  return null;
}

// Header text -> field name. Headers are compared without spaces/punctuation.
const HEADER_ALIASES = {
  question_text: ['question', 'questiontext', 'questions', 'text', 'q', 'prompt', 'item', 'questiondescription', 'questionstatement', 'essayquestion',
    'interviewquestion', 'interviewquestions', 'sampleinterviewquestion', 'sampleinterviewquestions', 'behavioralquestion', 'behaviouralquestion', 'ຄຳຖາມ'],
  section: ['type', 'section', 'test', 'testtype', 'questiontype', 'ປະເພດ'],
  category: ['category', 'topic', 'subject', 'competency', 'competencies', 'area', 'skill', 'ໝວດ'],
  difficulty: ['difficulty', 'level', 'iqlevel', 'difficultylevel', 'ລະດັບ'],
  // HR-only guidance for open questions (never shown to candidates).
  guide: ['sampleanswer', 'samplestronganswer', 'suggestedanswer', 'modelanswer', 'expectedanswer', 'expectedresponse', 'markingguide', 'scoringguide', 'guidance'],
  option_a: ['optiona', 'a', 'choicea', 'answera'],
  option_b: ['optionb', 'b', 'choiceb', 'answerb'],
  option_c: ['optionc', 'c', 'choicec', 'answerc'],
  option_d: ['optiond', 'd', 'choiced', 'answerd'],
  option_e: ['optione', 'e', 'choicee', 'answere'],
  correct_answer: ['correctanswer', 'answer', 'correct', 'correctoption', 'rightanswer', 'solution', 'key', 'answerkey', 'ans', 'correctans', 'ຄຳຕອບ', 'ຄຳຕອບທີ່ຖືກ'],
  options: ['options', 'choices', 'answeroptions'],
  marks: ['marks', 'mark', 'points', 'point', 'score', 'ຄະແນນ'],
  // Optional Lao translation columns, e.g. "Question (Lao)", "Option A (Lao)".
  question_text_lo: ['questionlao', 'laoquestion', 'questionlo', 'questioninlao', 'ຄຳຖາມພາສາລາວ'],
  ...Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((l) => [`option_${l}_lo`, [`option${l}lao`, `laooption${l}`, `option${l}lo`, `${l}lao`, `choice${l}lao`]])),
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

// A table cell holding several questions ("• Describe …\n• How did …" or
// "1. … 2. …") gives one question per item; wrapped lines stay with their item.
const RE_CELL_ITEM = /^(?:[•●○◦▪▫■□◆◇►▶➢➤✓✔·‣⁃]|[-]|[-–—*](?=\s)|\(?\d{1,3}[.)])\s*/;
function cellItems(value) {
  const lines = String(value ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // One item: only its bullet is removed (a leading "3." may be part of "3.5 × 2 = ?").
  if (lines.filter((l) => RE_CELL_ITEM.test(l)).length < 2) return [String(value ?? '').trim().replace(/^(?:[•●○◦▪▫■□◆◇►▶➢➤✓✔·‣⁃]|[-])\s*/, '')];
  const items = [];
  for (const l of lines) {
    if (RE_CELL_ITEM.test(l) || !items.length) items.push(l.replace(RE_CELL_ITEM, '').trim());
    else items[items.length - 1] += ' ' + l;
  }
  return items.filter(Boolean);
}

// The columns HR chose for a table without a recognisable header:
// { header_row: 0 | null, columns: { "0": "question_text", "3": "correct_answer", ... } }.
function mappingOf(mapping) {
  const map = {};
  for (const [i, field] of Object.entries(mapping.columns || {})) if (field && HEADER_ALIASES[field] && !(field in map)) map[field] = Number(i);
  return 'question_text' in map ? map : null;
}

// Finds a header row in a 2D array and converts the rows below it (or uses HR's column mapping).
function rowsFromTable(table, defaultSection, mapping) {
  const fixed = mapping && mappingOf(mapping);
  for (let h = 0; h < Math.min(table.length, 10); h++) {
    const map = fixed || mapHeader(table[h] || []);
    if (!map) continue;
    if (fixed) h = mapping.header_row == null || mapping.header_row === '' ? -1 : Number(mapping.header_row);
    const rows = [];
    for (const cells of table.slice(h + 1)) {
      if (!cells || cells.every((c) => String(c ?? '').trim() === '')) continue;
      const raw = {};
      for (const [field, i] of Object.entries(map)) raw[field] = cells[i] == null ? '' : String(cells[i]).trim();
      // Several questions in one cell (no options of their own): one row each, same category.
      const items = raw.question_text && !['a', 'b', 'c', 'd'].some((l) => raw['option_' + l]) && !raw.options ? cellItems(cells[map.question_text]) : [raw.question_text];
      if (items.length > 1) {
        for (const text of items) rows.push({ ...rawRow({ ...raw, question_text: text }, defaultSection), section_key: 'table' });
        continue;
      }
      if (items[0] != null) raw.question_text = items[0];
      rows.push(rawRow(raw, defaultSection));
    }
    rows.fromMapping = !!fixed;
    return rows;
  }
  return null;
}

// Completes one table row: its test type and its options.
function rawRow(raw, defaultSection) {
  raw.typed = !!raw.section; // the file says which test (otherwise the chosen default is used)
  if (raw.section && !sectionFrom(raw.section)) raw.type_name = String(raw.section).trim(); // unknown test type: HR decides
  raw.section = sectionFrom(raw.section) || (raw.type_name ? null : defaultSection);
  if (raw.options && !['a', 'b', 'c', 'd', 'e'].some((l) => raw['option_' + l])) {
    const marked = splitOptionLine(raw.options, 'A');
    const parts = marked && marked.options.length > 1 ? marked.options.map(([, t]) => t) : raw.options.split(/\s*[;|\n]\s*/).filter(Boolean);
    parts.slice(0, 5).forEach((t, k) => { raw['option_' + 'abcde'[k]] = t; });
  }
  delete raw.options;
  return raw;
}

// Reads questions out of plain text (PDF, Word, TXT, legacy .doc). Nothing
// here needs column headers; the layout is recognised from the text itself:
//
//   1. What is the capital of Australia?      <- "1." "1)" "Q1" "Q.1" "Question 1"
//   A Sydney B Melbourne C Canberra D Perth    <- "A" "A." "A)" "(A)" "a)", one or many per line
//   Answer: C                                  <- optional, per question
//   ...
//   ANSWER KEY                                 <- or Answers / Correct Answers / Solutions
//   1. C Canberra                              <- "1. C", "1 - C", "1: C", "1. Canberra"
//
// An answer is only accepted when it clearly points at one option; anything
// unclear is marked for review instead of guessed.
const LETTER_LIST = ['A', 'B', 'C', 'D', 'E'];

const RE_QUESTION = /^(?:(?:q|question)\s*\.?\s*(\d{1,4})\s*[.):\-–]?\s+|(\d{1,4})\s*[.):]\s*)(.+)$/i;
const RE_QUESTION_LABEL = /^question\s*[:.]\s*(.+)$/i;
const RE_ANSWER = /^(?:correct\s*answer|expected\s*answer|final\s*answer|answer|ans|correct|key|ຄຳຕອບ)\s*[:=：-]\s*(.+)$/i;
const RE_META = /^(type|section|category|difficulty|level|marks?|points?)\s*[:=：]\s*(.+)$/i;
const RE_KEY_HEADING = /^(?:answer\s*key|answers|correct\s*answers|answer\s*sheet|solutions?(?:\s*\/\s*answer\s*key)?)\s*[:\-–]?\s*(?:page\s*\d+(?:\s*(?:of|\/)\s*\d+)?)?\s*$/i;
const RE_PAGE_LINE = /(^|\s)page\s*\d+(\s*(of|\/)\s*\d+)?\s*$/i;
const RE_BLANK_FIELD = /_{3,}/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Text used to compare an answer with an option: letters and digits only.
const norm = (v) => String(v ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');

// If the line starts with option letter L, returns { style, text } where
// style is 'mark' ("A." "A)" "(A)" "a)") or 'bare' ("A Sydney").
function optionStart(line, L) {
  let m = line.match(new RegExp(`^\\(?[${L}${L.toLowerCase()}]\\)?\\s*[.):]\\s*(.*)$`));
  if (m) return { style: 'mark', text: m[1] };
  m = line.match(new RegExp(`^${L}\\s+(\\S.*)$`));
  if (m) return { style: 'bare', text: m[1] };
  return null;
}

// Splits one line into options, cutting only at the next letter in order.
function splitOptionLine(line, first) {
  const start = optionStart(line, first);
  if (!start) return null;
  const out = [];
  let letter = first;
  let rest = start.text;
  for (let i = LETTER_LIST.indexOf(first) + 1; i < LETTER_LIST.length; i++) {
    const next = LETTER_LIST[i];
    const re = start.style === 'mark'
      ? new RegExp(`\\s+\\(?[${next}${next.toLowerCase()}]\\)?\\s*[.):]\\s*`)
      : new RegExp(`\\s+${next}\\s+(?=\\S)`);
    const m = rest.match(re);
    if (!m) break;
    out.push([letter, rest.slice(0, m.index).trim()]);
    rest = rest.slice(m.index + m[0].length);
    letter = next;
  }
  out.push([letter, rest.trim()]);
  return { style: start.style, options: out };
}

// "C Canberra" -> { letter: 'C', text: 'Canberra' }; "Canberra" -> { letter: null, text: 'Canberra' }.
// A capital letter may be followed by a space; a small letter needs "." ")" or ":".
function parseKeyValue(v) {
  const s = String(v).trim();
  const m = s.match(/^\(?([A-E])\)?(?:\s*[.):\-–]\s*|\s+|$)(.*)$/) || s.match(/^\(?([a-e])\)?(?:\s*[.):\-–]\s*|$)(.*)$/);
  return m ? { letter: m[1].toUpperCase(), text: m[2].trim() } : { letter: null, text: s };
}

// Reads answer-key lines: "1. C", "1 - C", "1: C Canberra", "1. Canberra",
// or several on one line ("1. C  2. B  3. D").
function readAnswerKey(lines) {
  const key = new Map();
  for (const line of lines) {
    if (RE_KEY_HEADING.test(line) || (RE_PAGE_LINE.test(line) && !/^\d/.test(line))) continue;
    // Several on one line: "1. C 2. B 3. D", "1 B 2 C 3 A", "Q1 B Q2 C".
    if (/^(\s*(?:q\s*)?\d{1,4}\s*[.):\-–]?\s*[A-Ea-e]\b\s*[,;]?)+\s*$/i.test(line) && (line.match(/(?:^|\s)(?:q\s*)?\d{1,4}\s*[.):\-–]?\s*[A-Ea-e]\b/gi) || []).length > 1) {
      for (const x of line.matchAll(/(?:q\s*)?(\d{1,4})\s*[.):\-–]?\s*([A-Ea-e])\b/gi)) key.set(Number(x[1]), { letter: x[2].toUpperCase(), text: '' });
      continue;
    }
    const m = line.match(/^(?:q(?:uestion)?\s*\.?\s*)?(\d{1,4})\s*[.):\-–]?\s*(.+)$/i);
    if (m) key.set(Number(m[1]), parseKeyValue(m[2]));
  }
  return key;
}

// Applies the answer key to parsed questions (by question number).
function applyAnswerKey(rows, key) {
  for (const row of rows) {
    if (row.number == null || !key.has(row.number)) continue;
    const { letter, text } = key.get(row.number);
    const options = LETTER_LIST.filter((L) => row['option_' + L.toLowerCase()]);
    let answer = null;
    if (!options.length) {
      answer = text || letter; // short-answer question: the key is the answer itself
    } else if (letter) {
      const optText = row['option_' + letter.toLowerCase()];
      if (!optText) row.answer_error = `Correct answer — review required: the answer key says ${letter}, but there is no option ${letter}.`;
      else if (text && norm(text) !== norm(optText)) row.answer_error = `Answer conflict — review required: the answer key says "${letter} ${text}", but option ${letter} is "${optText}".`;
      else answer = letter;
    } else {
      const matches = options.filter((L) => norm(row['option_' + L.toLowerCase()]) === norm(text));
      if (matches.length === 1) answer = matches[0];
      else row.answer_error = `Correct answer — review required: "${text}" does not match exactly one option.`;
    }
    if (answer == null) continue;
    if (row.correct_answer && norm(row.correct_answer) !== norm(answer) && norm(row.correct_answer) !== norm(row['option_' + String(answer).toLowerCase()])) {
      row.answer_error = `Answer conflict — review required: the question says "${row.correct_answer}", the answer key says "${answer}".`;
    } else {
      row.correct_answer = answer;
    }
  }
}

// ---- sections ------------------------------------------------------------------
// A real recruitment document often mixes parts: a memo, a Calculation test
// (numbered 1-10, then again 1-10 for harder ones), an essay prompt with its
// marking guide, interview notes, scoring bands, policy tables. Headings split
// the text into sections first; only sections that hold test questions are
// read as questions, and numbering restarts in every section.
//
//   [1] ...            bracket heading (the preamble may say "[1] Calculation test")
//   2/ ...             part heading
//   Calculation Test / ຄຳຖາມງ່າຍໆ: / Interview:   short keyword heading
const SECTION_WORDS = [
  ['interview', /interview|ສໍາພາດ|ສຳພາດ/i],
  ['essay', /essay|writing|motivation|ບົດຄວາມ|ຂຽນ/i],
  ['calculation', /calculat|arithmetic|numerical|mathematic|ຄິດໄລ່|ຄຳນວນ|ຄໍານວນ/i],
  ['iq', /\biq\b|intelligence|ໄອຄິວ/i],
  ['general', /general\s*(knowledge|test|questions?)|ທົ່ວໄປ/i],
  ['scoring', /scor|marking|ໃຫ້ຄະແນນ/i],
];
const LEVEL_WORDS = [['Easy', /\beasy\b|\bbasic\b|ງ່າຍ/i], ['Hard', /\bhard(er)?\b|difficult|advanced|ຍາກ/i]];
// Hints / notes that belong to a question (or, in an essay, the marking guide) - never headings.
const RE_HINT = /^(?:ຄຳແນະນຳ|ຄໍາແນະນໍາ|instructions?|hints?|note|guidance|marking\s*guide|key\s*points)\s*[:.]?/i;
const QUESTION_TYPES = { calculation: 'CALCULATION', essay: 'ESSAY', iq: 'IQ', general: 'GENERAL' };
const wordType = (s) => (SECTION_WORDS.find(([, re]) => re.test(s)) || [null])[0];
const wordLevel = (s) => (LEVEL_WORDS.find(([, re]) => re.test(s)) || [null])[0];
// "each question has 5 marks" / "ແຕ່ລະຄຳຖາມຈະມີ 5 ຄະແນນ" -> 5
const sectionMarks = (s) => { const m = String(s).match(/(?:each\s+question|per\s+question|ແຕ່ລະຄຳຖາມ)\D{0,25}(\d+(?:\.\d+)?)\s*(?:marks?|points?|ຄະແນນ)/i); return m ? m[1] : ''; };

// Is this line a heading? Returns { number, title, type, level, prompt } or null.
function headingOf(line, bracketTypes) {
  // Question lines, hints, "Type: IQ" / "Answer: B" lines, options, form fields and page lines are never headings.
  if (RE_QUESTION.test(line) || RE_HINT.test(line) || RE_META.test(line) || RE_ANSWER.test(line) || RE_BLANK_FIELD.test(line) || RE_PAGE_LINE.test(line)
    || /^\(?[A-Ea-e]\s*[.):]/.test(line)) return null;
  let m = line.match(/^\[(\d{1,2})\]\s*(.*)$/);
  if (m) {
    const rest = m[2].trim();
    // "[2] <a long question?>" is the heading AND the prompt of that section.
    const prompt = rest.length > 80 || /[?？]\s*$/.test(rest) ? rest : '';
    return { number: m[1], title: prompt ? '' : rest, type: wordType(prompt ? '' : rest) || bracketTypes.get(m[1]) || null, level: wordLevel(rest), prompt, marks: sectionMarks(rest) };
  }
  m = line.match(/^(\d{1,2})\s*\/\s*(\S.*)$/);
  if (m) return { number: null, part: true, title: m[2].trim(), type: wordType(m[2]) || 'other', level: null, prompt: '' };
  if (line.length <= 60 && (/[:：]\s*$/.test(line) || (line.split(/\s+/).length <= 4 && !/[.?!,;？]/.test(line)))) {
    const type = wordType(line);
    const level = wordLevel(line);
    if (type || (level && /[:：]\s*$/.test(line))) return { number: null, title: line.replace(/[:：]\s*$/, ''), type, level, prompt: '' };
  }
  return null;
}

// Splits lines into sections. Without any heading there is one section and
// the file is read exactly as before (every line may be a question).
function splitSections(lines) {
  const bracketTypes = new Map();
  for (const l of lines) {
    const m = l.match(/^\[(\d{1,2})\]\s*(.*)$/);
    if (m && !bracketTypes.has(m[1]) && wordType(m[2])) bracketTypes.set(m[1], wordType(m[2]));
  }
  const sections = [];
  let cur = { key: 's0', type: 'intro', title: '', level: null, marks: '', lines: [] };
  sections.push(cur);
  for (const line of lines) {
    const h = line && headingOf(line, bracketTypes);
    if (!h) { cur.lines.push(line); continue; }
    // A level heading with no type ("Harder questions:") continues the current test.
    const inherit = !h.type && !h.number && !h.part && QUESTION_TYPES[cur.type];
    cur = { key: 's' + sections.length, number: h.number ?? (inherit ? cur.number : null), type: h.type || (inherit ? cur.type : 'other'),
      title: h.title, level: h.level || null, marks: h.marks || (inherit ? cur.marks : '') || '', prompt: h.prompt, lines: [] };
    sections.push(cur);
  }
  // No heading at all: the file is read exactly as before. With headings, the part
  // before the first heading still gives its numbered questions (not every line).
  if (sections.length === 1) sections[0].type = 'questions';
  else if (sections[0].lines.some((l) => RE_QUESTION.test(l))) sections[0].type = 'numbered';
  return sections;
}

// Reads the questions of one section (the question / option / answer layout
// is the same everywhere; only the test type differs).
function questionsIn(section, defaultSection) {
  // An interview section that holds numbered questions is a question section of the interview type.
  const interview = section.type === 'interview';
  const typeCode = interview ? T.interviewType() : QUESTION_TYPES[section.type] || defaultSection;
  const lines = section.lines;
  const nextText = (i) => { for (let j = i + 1; j < lines.length; j++) if (lines[j] && !RE_PAGE_LINE.test(lines[j])) return lines[j]; return ''; };
  // A category heading inside the questions: "CATEGORY 1: ADAPTABILITY (QUESTIONS 1 – 5)",
  // "1. ADAPTABILITY" followed by "Question 1:", or an all-caps line ("ORDER OF OPERATIONS")
  // right before a question. It names the category of the questions below; it is never a question.
  const categoryOf = (line, i) => {
    if (RE_ANSWER.test(line) || RE_META.test(line) || RE_KEY_HEADING.test(line) || RE_GUIDE_START.test(line) || RE_PAGE_LINE.test(line)) return null;
    let m = line.match(RE_CATEGORY_LINE);
    if (m) return cleanCategory(m[1]);
    const next = nextText(i);
    m = line.match(RE_QUESTION);
    if (m && m[2] && headingText(m[3]) && RE_LABELLED_START.test(next)) return cleanCategory(m[3]);
    if (!m && !isStart(line) && upperWords(line) && headingText(line) && isStart(next) && !/^\(?[A-Ea-e]\s*[.):]/.test(line)) return cleanCategory(line);
    return null;
  };
  const firstQuestion = lines.findIndex((l, i) => isStart(l) && !categoryOf(l, i));
  const numbered = firstQuestion >= 0;
  const rows = [];
  let cur = null;
  let lastOption = null;
  let optionStyle = null;
  let guide = null; // where the lines after a guide heading go: 'correct_answer' (essay marking guide) or 'guide' (sample answer)
  // An all-caps topic heading ("BASIC ARITHMETIC") names the category of its first questions; a test title ("Essay Questions") does not.
  let category = section.title && upperWords(section.title) && headingText(section.title) && !/\b(test|quiz|exam|questions?|section|part)\b/i.test(section.title) ? cleanCategory(section.title) : '';
  const start = (textValue, number) => {
    cur = { question_text: textValue, section: typeCode, option_a: '', option_b: '', option_c: '', option_d: '', option_e: '', correct_answer: '', category,
      difficulty: section.type === 'questions' ? '' : section.level || '', marks: section.marks || '', number, section_key: section.key,
      typed: !!QUESTION_TYPES[section.type] || interview, ...(interview && !typeCode ? { type_name: INTERVIEW_TYPE_NAME, type_behavior: 'interview' } : {}) };
    rows.push(cur);
    lastOption = null;
    guide = null;
  };
  const nextLetter = () => (lastOption ? LETTER_LIST[LETTER_LIST.indexOf(lastOption.slice(-1).toUpperCase()) + 1] : 'A');
  if (section.prompt) start(section.prompt, 1);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Page headers/footers and form fields ("Name: ____") are not questions.
    if (RE_PAGE_LINE.test(line) && !RE_QUESTION.test(line)) continue;
    if (RE_BLANK_FIELD.test(line) && !RE_QUESTION.test(line)) continue;
    if (numbered && i < firstQuestion && !cur) { const cat = categoryOf(line, i); if (cat) category = cat; continue; } // title / instructions before question 1

    let m;
    // Sample / suggested answers and marking guides: HR-only guidance, never part of the question.
    if (cur && (m = line.match(RE_GUIDE_START))) { guide = 'guide'; cur.guide = (cur.guide ? cur.guide + '\n' : '') + (m[1] || '').trim(); continue; }
    if (guide && cur && !isStart(line) && !categoryOf(line, i)) { cur[guide] = (cur[guide] ? cur[guide] + '\n' : '') + line; continue; }
    if (guide) guide = null;
    if (cur && typeCode === 'ESSAY' && RE_HINT.test(line)) { guide = 'correct_answer'; cur.correct_answer = line; continue; }
    if ((m = line.match(RE_ANSWER)) && cur) { cur.correct_answer = m[1].trim(); continue; }
    if ((m = line.match(RE_META)) && cur) {
      const k = m[1].toLowerCase();
      const value = m[2].trim();
      if (k === 'type' || k === 'section') { if (sectionFrom(value)) cur.section = sectionFrom(value); else { cur.type_name = value; cur.section = null; } }
      else if (k === 'category') cur.category = value;
      else if (k === 'difficulty' || k === 'level') cur.difficulty = value;
      else cur.marks = value;
      continue;
    }
    // Options: the next letter in order ("A" first). Bare letters ("A Sydney")
    // count only when the options clearly continue (B on the same or next line).
    if (cur && !cur.correct_answer) {
      const want = nextLetter();
      const parsed = want && splitOptionLine(line, want);
      const bareOk = parsed && (parsed.style === 'mark' || parsed.options.length > 1 || lastOption
        || (lines[i + 1] && optionStart(lines[i + 1], LETTER_LIST[LETTER_LIST.indexOf(want) + 1] || 'Z')));
      if (parsed && bareOk && (!optionStyle || optionStyle === parsed.style || parsed.style === 'mark')) {
        optionStyle = optionStyle || parsed.style;
        for (const [L, t] of parsed.options) { lastOption = 'option_' + L.toLowerCase(); cur[lastOption] = t; }
        continue;
      }
      // Marked options may also come out of order (e.g. "C. x" alone).
      const any = line.match(/^\(?([A-Ea-e])\s*[.):]\s*(.*)$/);
      if (any) { lastOption = 'option_' + any[1].toLowerCase(); cur[lastOption] = any[2].trim(); continue; }
    }
    const cat = categoryOf(line, i);
    if (cat) { category = cat; lastOption = null; continue; }
    if ((m = line.match(RE_QUESTION))) { start(m[3].trim(), Number(m[1] || m[2])); continue; }
    // "Question 1:" alone on its line: the question text follows on the next lines.
    if ((m = line.match(RE_QUESTION_ONLY))) { start('', Number(m[1])); continue; }
    if ((m = line.match(RE_QUESTION_LABEL))) { start(m[1].trim(), null); continue; }
    // Continuation line: part of the question (incl. its hint), or of the last option.
    // Without numbering, every line is a question only in a plain file (no headings);
    // inside a document section only a clear essay question line is (tables, notes are not).
    // (A line that asks nothing - a title, a greeting - is never a question.)
    const blockLine = (section.type === 'questions' || typeCode === 'ESSAY') && looksLikeQuestion(line);
    // An unnumbered list of open prompts (essay / interview): each finished prompt is one question,
    // a new prompt starts on a new line, and a closing line ("Good luck!") is not part of either.
    if (!numbered && cur && !cur.option_a && !guide && T.isEssay(typeCode) && /[.?!？:]\s*$/.test(cur.question_text)) {
      if (looksLikeQuestion(line) && /^\p{Lu}/u.test(line)) { start(line, null); continue; }
      continue;
    }
    if (!cur || (!numbered && cur.correct_answer)) { if (!numbered && blockLine) start(line, null); continue; }
    if (lastOption) cur[lastOption] += ' ' + line;
    else cur.question_text += (cur.question_text ? '\n' : '') + line;
  }
  return rows.filter((r) => r.question_text.trim() || r.option_a);
}

const RE_QUESTION_ONLY = /^(?:question|q)\s*\.?\s*(\d{1,4})\s*[.):\-–]?\s*$/i;
// A question numbered "Question N" / "QN" (on its own line or with its text).
const RE_LABELLED_START = /^(?:question|q)\s*\.?\s*\d{1,4}\b/i;
const isStart = (l) => RE_QUESTION.test(l) || RE_QUESTION_ONLY.test(l) || RE_QUESTION_LABEL.test(l);
// "Sample Answer:", "SAMPLE STRONG ANSWER", "Suggested answer", "Marking guide" … start HR-only guidance.
// ("Expected Answer: 250" is an answer, not guidance.)
const RE_GUIDE_START = /^(?:sample(?:\s+strong)?\s+answers?|suggested\s+answers?|model\s+answers?|example\s+answers?|ideal\s+answers?|expected\s+responses?|scoring\s+guide|evaluation\s+criteria|what\s+to\s+look\s+for)\b\s*[:.\-–]?\s*(.*)$/i;
// "CATEGORY 1: ADAPTABILITY (QUESTIONS 1 – 5)", "Section 2 - Leadership".
const RE_CATEGORY_LINE = /^(?:category|competency|section|part|topic)\s+\d{1,2}\s*[:.\-–]\s*(.+)$/i;
const upperWords = (s) => { const letters = String(s).replace(/[^A-Za-z]/g, ''); return letters.length >= 3 && letters === letters.toUpperCase(); };
// A short heading-like text: few words, no sentence punctuation at the end.
const headingText = (t) => t.length <= 60 && !/[.?!？;,]$/.test(t) && t.split(/\s+/).length <= 6 && (upperWords(t) || t.split(/\s+/).length <= 3);
const SMALL_WORDS = new Set(['of', 'and', 'or', 'the', 'an', 'to', 'in', 'on', 'for', 'with', 'by', 'at']);
const titleCase = (s) => (upperWords(s) ? s.toLowerCase().split(/(\s+)/).map((w, i) => (i && SMALL_WORDS.has(w) ? w : w.replace(/(^|[/&(-])(\p{L})/gu, (x, a, b) => a + b.toUpperCase()))).join('') : s);
// "ADAPTABILITY (QUESTIONS 1 – 5)" and "Collaboration (Continued, Questions 13 – 15)" are both the category "Adaptability" / "Collaboration".
// ("SECTION A — LEASING" is the category "Leasing".)
const cleanCategory = (s) => titleCase(String(s).replace(/\s*\([^()]*\b(?:questions?|q\d|continued)\b[^()]*\)\s*$/i, '').replace(/^(?:section|part)\s+[A-Z0-9]{1,2}\s*[—–:.-]\s*/i, '').replace(/[:：]\s*$/, '').trim());

// A question without options that clearly asks for a calculation (amounts,
// percentages, several numbers) is a short-answer Calculation question.
// (A question mark alone is not enough: "Tell me about the 2 or 3 …?" is not a calculation.)
const looksCalculation = (text) => (String(text).match(/\d+(?:[.,]\d+)*/g) || []).length >= 2 && /[%$€£¥₭]|\d\s*(?:kip|ກີບ|ໂດລາ|usd|dollars?|km|kg|months?|years?|ເດືອນ|ປີ)|\d\s*[+\-×x*÷/=]\s*\d|how\s+(much|many)|calculate|ເທົ່າໃດ|ຈັກ/i.test(text);

// A delimited table in text (tab, pipe or semicolon): most lines split into cells.
// A few tabbed lines (e.g. a PDF footer "Title <tab> Page 1 of 4") are not a table.
function delimitedTable(lines) {
  const content = lines.filter(Boolean).filter((l) => !/^[\s|:+-]+$/.test(l)); // markdown |---| rows
  for (const d of ['\t', '|', ';']) {
    const split = content.filter((l) => l.includes(d)).map((l) => (d === '|' ? l.replace(/^\||\|$/g, '') : l).split(d).map((c) => c.trim()));
    if (split.length > 1 && split.length >= content.length * 0.6) return split;
  }
  return null;
}

// How many rows of a candidate reading would import (valid, answer required, or waiting for HR's test type).
function usableCount(rows) {
  return rows.filter((r) => {
    const { errors } = validateQuestion(r, { allowMissingAnswer: true });
    return errors.length === 0 || (r.type_name && errors.length === 1 && errors[0].startsWith('Test Type'));
  }).length;
}
// The reading of the file that finds the most usable questions (earlier ones win a tie).
function pickBest(candidates) {
  let best = null;
  let score = -1;
  for (const rows of candidates.filter(Boolean)) {
    const s = usableCount(rows);
    if (s > score || (s === score && best && !best.length && rows.length)) { best = rows; score = s; }
  }
  return best || Object.assign([], { format: 'no question structure found' });
}

// Plain text (PDF, Word, TXT, legacy .doc): every way of reading it is tried —
// a delimited table, numbered / labelled questions in sections, bullet
// questions under headings — and the one that finds the most questions wins.
function rowsFromText(text, defaultSection, opts = {}) {
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/ /g, ' ').trim());
  const candidates = [];
  const table = delimitedTable(lines);
  if (table) {
    const rows = rowsFromTable(table, defaultSection, opts.mapping);
    if (rows && rows.length) { rows.format = 'table (header row)'; candidates.push(rows); }
  }
  candidates.push(numberedRows(lines, defaultSection));
  // Unnumbered bullet questions (e.g. interview questions grouped by competency).
  const bullets = bulletQuestions(lines.map((t, i) => ({ text: t, blankBefore: i > 0 && !lines[i - 1] })));
  if (bullets) candidates.push(bulletRows(bullets, defaultSection));
  const best = pickBest(candidates);
  // A table whose columns could not be recognised: HR maps them in the preview.
  if (table && !usableCount(best)) best.unmapped = table.slice(0, 50);
  return best;
}

// Numbered / labelled questions, in sections, with an optional answer key.
function numberedRows(lines, defaultSection) {
  // Split off the answer key: everything after an "Answer Key" style heading
  // that comes after at least one numbered question.
  const firstQuestion = lines.findIndex((l) => isStart(l));
  const keyAt = lines.findIndex((l, i) => i > firstQuestion && firstQuestion >= 0 && RE_KEY_HEADING.test(l));
  const body = keyAt >= 0 ? lines.slice(0, keyAt) : lines;
  const key = keyAt >= 0 ? readAnswerKey(lines.slice(keyAt + 1).filter(Boolean)) : new Map();

  const sections = splitSections(body);
  const rows = [];
  for (const s of sections) {
    // Interview material is imported only when it holds numbered questions (notes and scoring text never are).
    const interviewQuestions = s.type === 'interview' && s.lines.some((l) => RE_QUESTION.test(l) || RE_QUESTION_ONLY.test(l));
    if (s.type === 'questions' || s.type === 'numbered' || QUESTION_TYPES[s.type] || interviewQuestions) rows.push(...questionsIn(s, defaultSection));
  }
  applyAnswerKey(rows, key);

  // Option-less questions not in a typed section, when IQ or General is selected:
  // ones that clearly ask for a calculation are Calculation; a document of
  // behavioural / interview prompts goes to the interview test type. Never into IQ.
  if (['iq', 'mcq'].includes(T.behavior(defaultSection))) {
    const open = rows.filter((r) => !r.typed && !LETTER_LIST.some((L) => r['option_' + L.toLowerCase()]));
    const behavioural = open.length >= 2 && open.filter((r) => isBehavioural(r.question_text)).length >= open.length * 0.5;
    for (const r of open) {
      if (looksCalculation(r.question_text) && T.get('CALCULATION')) { r.section = 'CALCULATION'; r.section_key = 'detected-calculation'; }
      else if (behavioural) {
        r.section = T.interviewType();
        if (!r.section) { r.type_name = INTERVIEW_TYPE_NAME; r.type_behavior = 'interview'; }
        r.section_key = 'detected-interview';
      }
    }
  }

  // What was found, for the preview: question sections, and content that is not imported.
  const summary = [];
  if (sections.length > 1) {
    for (const s of sections) {
      const count = rows.filter((r) => r.section_key === s.key).length;
      const content = s.lines.filter(Boolean).length + (s.prompt ? 1 : 0);
      if (!count && !content) continue;
      const kind = (QUESTION_TYPES[s.type] || s.type === 'numbered' || s.type === 'interview') && count ? 'questions' : s.type === 'interview' ? 'interview' : s.type === 'scoring' ? 'scoring' : 'other';
      const first = rows.find((r) => r.section_key === s.key);
      summary.push({ key: s.key, title: s.title || (s.number ? `[${s.number}]` : ''), kind, section: kind === 'questions' ? first.section : null, level: s.level, questions: count, lines: content });
    }
    // Questions moved to another test type get their own line.
    for (const k of ['detected-calculation', 'detected-interview']) {
      const these = rows.filter((r) => r.section_key === k);
      if (these.length) summary.push({ key: k, title: DETECTED_TITLE[k], kind: 'questions', section: these[0].section, questions: these.length, lines: these.length });
    }
  } else {
    for (const k of [...new Set(rows.map((r) => r.section_key || 's0'))]) {
      const these = rows.filter((r) => (r.section_key || 's0') === k);
      summary.push({ key: k, title: DETECTED_TITLE[k] || '', kind: 'questions', section: these[0].section, questions: these.length, lines: these.length });
    }
    for (const r of rows) r.section_key = r.section_key || 's0';
  }
  const numbered = firstQuestion >= 0;
  rows.format = (sections.length > 1 ? 'document with sections — ' : '') + (numbered ? (key.size ? 'numbered questions with an answer key' : 'numbered questions') : rows.length ? 'question blocks' : 'no question structure found');
  rows.keyCount = key.size;
  rows.sections = summary;
  // Categories from the document (headings such as "CATEGORY 1: ADAPTABILITY"), for the preview.
  const cats = new Map();
  for (const r of rows) if (r.category) cats.set(r.category, (cats.get(r.category) || 0) + 1);
  const interviewRows = rows.filter((r) => r.type_behavior === 'interview' || T.behavior(r.section) === 'interview').length;
  if (cats.size || interviewRows) {
    rows.document = {
      type: interviewRows >= rows.length * 0.5 ? 'Behavioural Interview Question Bank' : 'Question document',
      structure: (numbered ? 'Numbered questions' : 'Questions') + (cats.size ? ' grouped by category' : '') + (key.size ? ' with an answer key' : ''),
      behavioural: interviewRows >= rows.length * 0.5,
      categories: [...cats].map(([name, questions]) => ({ name, questions })),
      detected_type: interviewRows ? (T.interviewType() ? T.name(T.interviewType()) : INTERVIEW_TYPE_NAME) : null,
      not_imported: { headings: sections.filter((s) => s.title).length, page_text: 0, other: summary.filter((s) => s.kind !== 'questions').reduce((n, s) => n + s.lines, 0), low_confidence: 0 },
    };
  }
  return rows;
}
const DETECTED_TITLE = { 'detected-calculation': 'Questions that look like short-answer Calculation', 'detected-interview': 'Behavioural / interview questions (no options)' };

// Rows from bullet questions. Behavioural / interview questions go to the
// managed interview test type; when there is none, HR is asked to create one
// (or choose an existing type) - they are never put into IQ, General,
// Calculation or Essay without HR choosing it.
const INTERVIEW_TYPE_NAME = 'Behavioural Interview';
function bulletRows({ rows: found, document }, defaultSection) {
  const interview = document.behavioural ? T.interviewType() : null;
  const section = document.behavioural ? interview : defaultSection;
  const rows = found.map((r) => ({
    question_text: r.question_text, section, ...(section ? {} : { type_name: INTERVIEW_TYPE_NAME, type_behavior: 'interview' }),
    option_a: '', option_b: '', option_c: '', option_d: '', option_e: '', correct_answer: r.correct_answer || '',
    category: r.category, difficulty: '', marks: '', number: r.number, section_key: 'bullets', confidence: r.confidence, review: r.review,
  }));
  document.detected_type = document.behavioural ? (interview ? T.name(interview) : INTERVIEW_TYPE_NAME) : null;
  const other = document.behavioural && !interview ? T.interviewNamedOther() : [];
  if (other.length) document.note = `${other.map((t) => `"${t.name}"`).join(', ')} ${other.length === 1 ? 'is a' : 'are'} ${other.map((t) => t.behavior === 'calculation' ? 'calculation' : t.behavior === 'iq' ? 'IQ' : 'multiple-choice').join(' / ')} test type${other.length === 1 ? '' : 's'}: `
    + 'its questions need options A, B, C … and a correct answer, so it cannot hold these interview questions. Create a test type with the Behavioural / Interview format below (or choose an Essay-format type).';
  rows.format = document.structure.toLowerCase() + (document.behavioural ? ' (behavioural interview)' : '');
  rows.sections = [{ key: 'bullets', title: document.structure, kind: 'questions', section, questions: rows.length, lines: rows.length }];
  rows.document = document;
  return rows;
}

// ---- validation ------------------------------------------------------------

// More Lao letters than Latin ones: the text is written in Lao.
function mostlyLao(text) {
  const t = String(text || '');
  const lao = (t.match(/[\u0E80-\u0EFF]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  return lao > 20 && lao > latin;
}

const IMAGE_KEYS = ['image_id', ...LETTERS.map((L) => `option_${L.toLowerCase()}_image`)];

function resolveAnswerLetter(answer, row) {
  const a = String(answer || '').trim();
  const letter = a.match(/^(?:option\s*)?\(?([A-Ea-e])\)?\.?$/i);
  if (letter) return letter[1].toUpperCase();
  const byText = LETTERS.find((L) => row['option_' + L.toLowerCase()] && row['option_' + L.toLowerCase()].trim().toLowerCase() === a.toLowerCase());
  return byText || null;
}

// Returns { question, errors }. question is ready to insert when errors is empty.
// allowMissingAnswer (imports): a short-answer Calculation question without its
// answer is still a valid question; it is imported Inactive and marked
// answer_required, so it never reaches an automatically marked test until HR
// enters the answer. The answer is never guessed.
function validateQuestion(input, { allowMissingAnswer = false } = {}) {
  const errors = [];
  const clean = (v, max) => String(v ?? '').trim().slice(0, max);
  const q = {
    section: T.get(input.section) ? String(input.section).toUpperCase() : sectionFrom(input.section),
    category: clean(input.category, 200),
    difficulty: clean(input.difficulty, 50),
    question_text: clean(input.question_text, 5000),
    option_a: clean(input.option_a, 1000),
    option_b: clean(input.option_b, 1000),
    option_c: clean(input.option_c, 1000),
    option_d: clean(input.option_d, 1000),
    option_e: clean(input.option_e, 1000),
    // Essays may carry a marking guide here (HR only, never shown to candidates).
    correct_answer: clean(input.correct_answer, T.isEssay(sectionFrom(input.section) || input.section) || input.type_behavior === 'interview' ? 5000 : 1000),
    marks: input.marks === '' || input.marks == null ? 1 : Number(input.marks),
  };
  // Pictures are referenced by id (uploaded separately); the route checks they exist.
  for (const key of IMAGE_KEYS) {
    const id = Number(input[key]);
    q[key] = Number.isInteger(id) && id > 0 ? id : null;
  }
  const typeName = String(input.type_name || (typeof input.section === 'string' ? input.section : '') || '').trim();
  if (!q.section && typeName) { q.type_name = typeName; if (input.type_behavior) q.type_behavior = String(input.type_behavior); errors.push(`Test Type "${typeName}" does not exist.`); }
  else if (!q.section) errors.push(`Type must be one of: ${T.all().filter((t) => t.active).map((t) => t.name).join(', ')}.`);
  if (q.section === 'IQ') {
    // IQ: the level decides the marks (1-5). No level given -> Level 3 (Moderate).
    if (q.difficulty && !difficultyLevel(q.difficulty)) errors.push('Level must be 1-5 (Easy, Basic, Moderate, Difficult or Very Difficult).');
    // No level in the file: Level 3 is shown, and the question is marked for HR to check.
    if (!q.difficulty) q.level_missing = true;
    q.difficulty = difficultyLevel(q.difficulty) || 'Moderate';
    q.marks = LEVEL_MARKS[q.difficulty];
  } else {
    // Other tests: difficulty is free text, kept as typed.
  }
  if (!q.question_text) errors.push('Question text is missing.');
  // A Lao translation given in the file is kept; it is ready only if it passes
  // the Lao checks, otherwise it waits for HR review (the question still imports).
  const loFields = ['question_text_lo', ...LETTERS.map((L) => `option_${L.toLowerCase()}_lo`)];
  if (loFields.some((k) => clean(input[k], 5000))) {
    for (const k of loFields) q[k] = clean(input[k], 5000);
    const problems = require('./lao').laoProblems(q, q);
    q.lo_status = problems.length ? 'needs_review' : 'translated';
    q.lo_note = problems.join(' ');
  } else if (mostlyLao(q.question_text)) {
    // The source itself is in Lao: it is also the Lao text (nothing is translated or changed).
    q.question_text_lo = q.question_text;
    for (const L of LETTERS) q[`option_${L.toLowerCase()}_lo`] = q['option_' + L.toLowerCase()];
    q.lo_status = 'translated';
    q.lo_note = 'The source question is in Lao.';
  }
  if (!Number.isFinite(q.marks) || q.marks <= 0 || q.marks > 100) errors.push('Marks must be a number between 0 and 100.');

  const filled = LETTERS.filter((L) => q['option_' + L.toLowerCase()] || q['option_' + L.toLowerCase() + '_image']);
  const format = T.behavior(q.section);
  // A sample answer / marking guide found in the file is kept as the HR-only guidance of an open question.
  const hrMarked = format === 'essay' || format === 'interview' || (!q.section && input.type_behavior === 'interview');
  if (hrMarked && !q.correct_answer && input.guide) q.correct_answer = clean(input.guide, 5000);
  if (hrMarked) {
    // Essays and interview questions are answered in writing and marked by HR:
    // no options and no correct answer (a guide, if any, is HR only).
    LETTERS.forEach((L) => { q['option_' + L.toLowerCase()] = ''; q['option_' + L.toLowerCase() + '_image'] = null; if (q.lo_status) q[`option_${L.toLowerCase()}_lo`] = ''; });
  } else if (input.answer_error) {
    errors.push(input.answer_error);
  } else if (filled.length >= 2) {
    const letter = resolveAnswerLetter(q.correct_answer, q);
    if (!q.correct_answer) errors.push('Correct answer is missing (no "Answer:" line and not in an answer key).');
    else if (!letter) errors.push('Correct answer must be one of the options (A, B, C, D or E).');
    else if (!filled.includes(letter)) errors.push(`Correct answer ${letter} has no option text or picture.`);
    else q.correct_answer = letter;
  } else if (filled.length === 1) {
    errors.push('A multiple-choice question needs at least 2 options.');
  } else if (format === 'calculation' && input.answer_error == null) {
    if (!q.correct_answer && allowMissingAnswer) { q.answer_required = true; q.status = 'Inactive'; }
    else if (!q.correct_answer) errors.push('Correct answer is missing.');
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

// Every sheet with a question header row (merged cells are read as their first
// cell). A sheet without a recognisable header is offered to HR for column
// mapping; with a mapping, the first sheet is read with it.
function rowsFromWorkbook(workbook, defaultSection, mapping) {
  const rows = [];
  let found = false;
  let unmapped = null;
  for (const name of workbook.SheetNames) {
    const table = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
    if (!table.length) continue;
    const sheetRows = rowsFromTable(table, sectionFrom(name) || defaultSection, mapping && !found ? mapping : null);
    if (sheetRows) { found = true; for (const r of sheetRows) r.sheet = name; rows.push(...sheetRows); if (sheetRows.fromMapping) rows.fromMapping = true; } else if (!unmapped) unmapped = table.slice(0, 50);
  }
  rows.format = rows.length ? 'table (header row)' + (workbook.SheetNames.length > 1 ? ` — ${workbook.SheetNames.length} sheets` : '') : 'table without a recognised header row';
  if (!found && unmapped) rows.unmapped = unmapped;
  return rows;
}

// The most likely field separator of a CSV / text table (comma, semicolon, tab or pipe).
function csvSeparator(text) {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((l) => l.replace(/"[^"]*"/g, '').split(d).length - 1);
    const lines = counts.filter((n) => n > 0);
    // Most lines split, and in the same number of cells.
    const same = lines.length ? Math.max(...Object.values(lines.reduce((m, n) => ({ ...m, [n]: (m[n] || 0) + 1 }), {}))) : 0;
    if (same > bestScore) { best = d; bestScore = same; }
  }
  return best;
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

// A CSV / TSV text as rows of cells: quoted values ("a, b" and "" for a quote) and line breaks inside quotes.
function parseDelimited(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { quoted = true; cell = ''; }
    else if (ch === sep) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

// Reads a file into rows. Every format keeps its structure until the questions
// are found: sheets / rows / columns, Word paragraphs, lists and table cells,
// PDF text lines with their position on the page. Each way of reading the file
// is tried and the one that finds the most usable questions is kept.
// opts.mapping: HR's column mapping for a table without a recognisable header.
async function parseFile(buffer, originalName, defaultSection, opts = {}) {
  const ext = (String(originalName).match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!ALLOWED[ext]) throw new ImportError('This file type is not supported. Please upload Excel, Word, PDF, CSV or TXT.');
  if (!buffer || !buffer.length) throw new ImportError('The file is empty.');
  if (detectKind(buffer) !== ALLOWED[ext]) throw new ImportError('This file does not look like a real ' + ext + ' file. Please save it again and retry.');
  const mapping = opts.mapping || null;
  const info = { file_type: ext.slice(1), readings: [] };

  let rows;
  try {
    if (ext === '.xlsx' || ext === '.xls') {
      rows = rowsFromWorkbook(XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false }), defaultSection, mapping);
    } else if (ext === '.csv' || ext === '.tsv') {
      const text = decodeText(buffer);
      const table = parseDelimited(text, ext === '.tsv' ? '\t' : csvSeparator(text));
      rows = rowsFromTable(table, defaultSection, mapping) || [];
      rows.format = rows.length ? 'table (header row)' : 'table without a recognised header row';
      if (!rows.length) rows = pickBest([rows, rowsFromText(text, defaultSection)]);
      if (!usableCount(rows)) rows.unmapped = table.slice(0, 50);
    } else if (ext === '.docx') {
      const { value: html } = await mammoth.convertToHtml({ buffer });
      const tables = htmlTables(html);
      info.tables = tables.length;
      const candidates = [];
      // Tables with a header row (Question, Option A …), then the paragraphs and list items.
      for (const t of tables) { const r = rowsFromTable(t, defaultSection, mapping); if (r && r.length) { r.format = 'table (header row)'; candidates.push(r); } }
      candidates.push(rowsFromText((await mammoth.extractRawText({ buffer })).value, defaultSection));
      // List items and table cells keep their meaning (bullet questions under a category).
      const bullets = bulletQuestions(docxLines(html));
      if (bullets) candidates.push(bulletRows(bullets, defaultSection));
      rows = pickBest(candidates);
      if (!usableCount(rows) && tables.length) rows.unmapped = tables[0].slice(0, 50);
    } else if (ext === '.doc') {
      const doc = await new WordExtractor().extract(buffer);
      rows = rowsFromText(doc.getBody(), defaultSection, { mapping });
    } else if (ext === '.pdf') {
      // The page layout (columns, bullets, table cells) and the plain text are both read.
      const candidates = [];
      try { const bullets = bulletQuestions(await pdfLines(buffer)); if (bullets) candidates.push(bulletRows(bullets, defaultSection)); } catch { /* layout not readable: text only */ }
      const text = await pdfText(buffer);
      info.text_chars = text.replace(/\s/g, '').length;
      candidates.push(rowsFromText(text, defaultSection, { mapping }));
      rows = pickBest(candidates);
      // Pages that are pictures have no text to read: OCR only then.
      if (!usableCount(rows) && info.text_chars < 200) {
        try {
          const scanned = await readScannedPdf(buffer, defaultSection);
          if (scanned.length) { rows = scanned; info.ocr = true; }
        } catch (e) {
          if (e.message === 'busy') throw new ImportError('Another scanned PDF is being read right now. Please try again in a minute.');
          throw e;
        }
      }
    } else {
      rows = rowsFromText(decodeText(buffer), defaultSection, { mapping });
    }
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError('Unable to read this file. It may be damaged or password-protected; please save it again and retry.');
  }

  rows = rows || [];
  // Nothing that looks like a question at all, and no table to map: say what was found.
  if (rows.length === 0 && !rows.unmapped) {
    logImport(originalName, info, rows, []);
    throw new ImportError(`${NO_STRUCTURE}\n\nDetected format: ${rows.format || 'no question structure found'}\nQuestions found: 0\n\nThe file was read, but no numbered, labelled, bulleted or table questions were found in it.`);
  }
  if (rows.length > MAX_ROWS) throw new ImportError(`This file has more than ${MAX_ROWS} questions. Please split it into smaller files.`);
  const checked = rows.map((raw, i) => {
    const { question, errors } = validateQuestion(raw, { allowMissingAnswer: true });
    const review = [raw.review, question.level_missing ? 'No IQ level in the file — Level 3 (Moderate) is shown; choose the level.' : ''].filter(Boolean).join(' ');
    return { row: i + 1, number: raw.number ?? null, question, errors, section_key: raw.section_key || 's0', answer_required: !!question.answer_required,
      ...(raw.confidence ? { confidence: raw.confidence } : {}), ...(review ? { review } : {}), ...(raw.sheet ? { sheet: raw.sheet } : {}) };
  });
  // Every row is shown in the preview, valid or not: one bad question never blocks the others.
  checked.format = rows.format || 'table (header row)';
  checked.keyCount = rows.keyCount || 0;
  checked.document = rows.document || null;
  checked.unmapped = rows.unmapped || null;
  checked.mapped = !!rows.fromMapping;
  checked.sections = rows.sections || [{ key: 's0', title: '', kind: 'questions', section: defaultSection, questions: checked.length, lines: checked.length }];
  logImport(originalName, info, rows, checked);
  return checked;
}

// One line per import in the server log, to diagnose files that do not import well
// (counts only: no question text, no candidate data, no credentials).
function logImport(name, info, rows, checked) {
  const ok = (r) => r.errors.length === 0 || (r.question.type_name && r.errors.length === 1 && r.errors[0].startsWith('Test Type'));
  const count = (f) => checked.filter(f).length;
  const line = {
    type: info.file_type, bytes: undefined, format: rows.format || '-', ocr: !!info.ocr, tables: info.tables, text_chars: info.text_chars,
    sections: (rows.sections || []).length, found: checked.length, valid: count((r) => ok(r) && !r.review), review: count((r) => ok(r) && r.review),
    invalid: count((r) => !ok(r)), mcq: count((r) => r.question.option_a), open: count((r) => !r.question.option_a),
    answer_key: rows.keyCount || 0, categories: new Set(checked.map((r) => r.question.category).filter(Boolean)).size, unmapped_table: !!rows.unmapped,
  };
  if (process.env.NODE_ENV !== 'test') console.log('[IMPORT] ' + String(name).replace(/[^\w.\- ]/g, '_').slice(0, 80) + ' ' + JSON.stringify(line));
}

module.exports = { parseFile, validateQuestion, ImportError, SECTIONS, LETTERS, IMAGE_KEYS, rowsFromText, parseDelimited, csvSeparator };
