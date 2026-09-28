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

const MAX_ROWS = 2000;
const SECTIONS = ['IQ', 'GENERAL', 'CALCULATION', 'ESSAY'];
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
  question_text: ['question', 'questiontext', 'questions', 'text', 'q', 'prompt', 'essayquestion', 'ຄຳຖາມ'],
  section: ['type', 'section', 'test', 'testtype', 'questiontype', 'ປະເພດ'],
  category: ['category', 'topic', 'subject', 'ໝວດ'],
  difficulty: ['difficulty', 'level', 'ລະດັບ'],
  option_a: ['optiona', 'a', 'choicea', 'answera'],
  option_b: ['optionb', 'b', 'choiceb', 'answerb'],
  option_c: ['optionc', 'c', 'choicec', 'answerc'],
  option_d: ['optiond', 'd', 'choiced', 'answerd'],
  option_e: ['optione', 'e', 'choicee', 'answere'],
  correct_answer: ['correctanswer', 'answer', 'correct', 'correctoption', 'rightanswer', 'solution', 'key', 'answerkey', 'ຄຳຕອບ', 'ຄຳຕອບທີ່ຖືກ'],
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
      if (raw.options && !['a', 'b', 'c', 'd', 'e'].some((l) => raw['option_' + l])) {
        const marked = splitOptionLine(raw.options, 'A');
        const parts = marked && marked.options.length > 1 ? marked.options.map(([, t]) => t) : raw.options.split(/\s*[;|\n]\s*/).filter(Boolean);
        parts.slice(0, 5).forEach((t, k) => { raw['option_' + 'abcde'[k]] = t; });
      }
      delete raw.options;
      rows.push(raw);
    }
    return rows;
  }
  return null;
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
const RE_ANSWER = /^(?:correct\s*answer|answer|ans|correct|key|ຄຳຕອບ)\s*[:=：-]\s*(.+)$/i;
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
    if (/^(\s*\d{1,4}\s*[.):\-–]\s*[A-Ea-e]\s*[,;]?)+\s*$/.test(line) && (line.match(/\d{1,4}\s*[.):\-–]/g) || []).length > 1) {
      for (const x of line.matchAll(/(\d{1,4})\s*[.):\-–]\s*([A-Ea-e])/g)) key.set(Number(x[1]), { letter: x[2].toUpperCase(), text: '' });
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
  const typeCode = QUESTION_TYPES[section.type] || defaultSection;
  const lines = section.lines;
  const firstQuestion = lines.findIndex((l) => RE_QUESTION.test(l));
  const numbered = firstQuestion >= 0;
  const rows = [];
  let cur = null;
  let lastOption = null;
  let optionStyle = null;
  let guide = false; // essay: the marking guide after the prompt (HR only)
  const start = (textValue, number) => {
    cur = { question_text: textValue, section: typeCode, option_a: '', option_b: '', option_c: '', option_d: '', option_e: '', correct_answer: '', category: '',
      difficulty: section.type === 'questions' ? '' : section.level || '', marks: section.marks || '', number, section_key: section.key };
    rows.push(cur);
    lastOption = null;
    guide = false;
  };
  const nextLetter = () => (lastOption ? LETTER_LIST[LETTER_LIST.indexOf(lastOption.slice(-1).toUpperCase()) + 1] : 'A');
  if (section.prompt) start(section.prompt, 1);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Page headers/footers and form fields ("Name: ____") are not questions.
    if (RE_PAGE_LINE.test(line) && !RE_QUESTION.test(line)) continue;
    if (RE_BLANK_FIELD.test(line) && !RE_QUESTION.test(line)) continue;
    if (numbered && i < firstQuestion && !cur) continue; // title / instructions before question 1

    let m;
    if (guide && !RE_QUESTION.test(line)) { cur.correct_answer += (cur.correct_answer ? '\n' : '') + line; continue; }
    if (cur && typeCode === 'ESSAY' && RE_HINT.test(line)) { guide = true; cur.correct_answer = line; continue; }
    if ((m = line.match(RE_ANSWER)) && cur) { cur.correct_answer = m[1].trim(); continue; }
    if ((m = line.match(RE_META)) && cur) {
      const k = m[1].toLowerCase();
      const value = m[2].trim();
      if (k === 'type' || k === 'section') cur.section = sectionFrom(value) || cur.section;
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
    if ((m = line.match(RE_QUESTION))) { start(m[3].trim(), Number(m[1] || m[2])); continue; }
    if ((m = line.match(RE_QUESTION_LABEL))) { start(m[1].trim(), null); continue; }
    // Continuation line: part of the question (incl. its hint), or of the last option.
    // Without numbering, every line is a question only in a plain file (no headings);
    // inside a document section only a clear essay question line is (tables, notes are not).
    const blockLine = section.type === 'questions' || (typeCode === 'ESSAY' && /[?？]\s*$/.test(line));
    if (!cur || (!numbered && cur.correct_answer)) { if (!numbered && blockLine) start(line, null); continue; }
    if (lastOption) cur[lastOption] += ' ' + line;
    else cur.question_text += '\n' + line;
  }
  return rows;
}

// A question without options that clearly asks for a calculation (amounts,
// percentages, several numbers) is a short-answer Calculation question.
const looksCalculation = (text) => (String(text).match(/\d+(?:[.,]\d+)*/g) || []).length >= 2 && /[%$€£¥₭]|\d\s*(?:kip|ກີບ|ໂດລາ|usd|dollars?|km|kg|months?|years?|ເດືອນ|ປີ)|[+\-×x*÷/=]\s*\d|\?|？|how\s+(much|many)|what\s+is|calculate|ເທົ່າໃດ|ຈັກ/i.test(text);

function rowsFromText(text, defaultSection) {
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/ /g, ' ').trim());

  // Tab-separated tables (from .doc files, .tsv and .txt exports) are handled as tables.
  const tabbed = lines.filter((l) => l.includes('\t')).map((l) => l.split('\t').map((c) => c.trim()));
  if (tabbed.length > 1) {
    const rows = rowsFromTable(tabbed, defaultSection);
    if (rows && rows.length) { rows.format = 'table (header row)'; return rows; }
  }

  // Split off the answer key: everything after an "Answer Key" style heading
  // that comes after at least one numbered question.
  const firstQuestion = lines.findIndex((l) => RE_QUESTION.test(l));
  const keyAt = lines.findIndex((l, i) => i > firstQuestion && firstQuestion >= 0 && RE_KEY_HEADING.test(l));
  const body = keyAt >= 0 ? lines.slice(0, keyAt) : lines;
  const key = keyAt >= 0 ? readAnswerKey(lines.slice(keyAt + 1).filter(Boolean)) : new Map();

  const sections = splitSections(body);
  const rows = [];
  for (const s of sections) {
    if (s.type === 'questions' || s.type === 'numbered' || QUESTION_TYPES[s.type]) rows.push(...questionsIn(s, defaultSection));
  }
  applyAnswerKey(rows, key);

  // Without headings: option-less questions that clearly ask for a calculation,
  // when IQ or General is selected, are shown as Calculation (never put into IQ).
  if (sections.length === 1 && ['IQ', 'GENERAL'].includes(defaultSection)) {
    for (const r of rows) {
      const hasOptions = LETTER_LIST.some((L) => r['option_' + L.toLowerCase()]);
      if (!hasOptions && looksCalculation(r.question_text)) { r.section = 'CALCULATION'; r.section_key = 'detected-calculation'; }
    }
  }

  // What was found, for the preview: question sections, and content that is not imported.
  const summary = [];
  if (sections.length > 1) {
    for (const s of sections) {
      const count = rows.filter((r) => r.section_key === s.key).length;
      const content = s.lines.filter(Boolean).length + (s.prompt ? 1 : 0);
      if (!count && !content) continue;
      const kind = (QUESTION_TYPES[s.type] || s.type === 'numbered') && count ? 'questions' : s.type === 'interview' ? 'interview' : s.type === 'scoring' ? 'scoring' : 'other';
      summary.push({ key: s.key, title: s.title || (s.number ? `[${s.number}]` : ''), kind, section: kind === 'questions' ? QUESTION_TYPES[s.type] || defaultSection : null, level: s.level, questions: count, lines: content });
    }
  } else {
    for (const k of [...new Set(rows.map((r) => r.section_key || 's0'))]) {
      const these = rows.filter((r) => (r.section_key || 's0') === k);
      summary.push({ key: k, title: k === 'detected-calculation' ? 'Questions that look like short-answer Calculation' : '', kind: 'questions', section: these[0].section, questions: these.length, lines: these.length });
    }
    for (const r of rows) r.section_key = r.section_key || 's0';
  }
  const numbered = firstQuestion >= 0;
  rows.format = (sections.length > 1 ? 'document with sections — ' : '') + (numbered ? (key.size ? 'numbered questions with an answer key' : 'numbered questions') : rows.length ? 'question blocks' : 'no question structure found');
  rows.keyCount = key.size;
  rows.sections = summary;
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
    section: SECTIONS.includes(input.section) ? input.section : sectionFrom(input.section),
    category: clean(input.category, 200),
    difficulty: clean(input.difficulty, 50),
    question_text: clean(input.question_text, 5000),
    option_a: clean(input.option_a, 1000),
    option_b: clean(input.option_b, 1000),
    option_c: clean(input.option_c, 1000),
    option_d: clean(input.option_d, 1000),
    option_e: clean(input.option_e, 1000),
    // Essays may carry a marking guide here (HR only, never shown to candidates).
    correct_answer: clean(input.correct_answer, sectionFrom(input.section) === 'ESSAY' || input.section === 'ESSAY' ? 5000 : 1000),
    marks: input.marks === '' || input.marks == null ? 1 : Number(input.marks),
  };
  // Pictures are referenced by id (uploaded separately); the route checks they exist.
  for (const key of IMAGE_KEYS) {
    const id = Number(input[key]);
    q[key] = Number.isInteger(id) && id > 0 ? id : null;
  }
  if (!q.section) errors.push('Type must be IQ, General, Calculation or Essay.');
  if (q.section === 'IQ') {
    // IQ: the level decides the marks (1-5). No level given -> Level 3 (Moderate).
    if (q.difficulty && !difficultyLevel(q.difficulty)) errors.push('Level must be 1-5 (Easy, Basic, Moderate, Difficult or Very Difficult).');
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
  if (q.section === 'ESSAY') {
    // Essays are marked by HR; options are ignored.
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
  } else if (q.section === 'CALCULATION' && input.answer_error == null) {
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
    throw new ImportError('Unable to read this file. It may be damaged or password-protected; please save it again and retry.');
  }

  if (!rows || rows.length === 0) throw new ImportError(`${NO_STRUCTURE}\n\nDetected format: ${(rows && rows.format) || 'no question structure found'}\nQuestions found: 0\n\nA question needs its text, options A, B, C ... (not for Essay or short-answer Calculation) and a correct answer.`);
  if (rows.length > MAX_ROWS) throw new ImportError(`This file has more than ${MAX_ROWS} questions. Please split it into smaller files.`);
  const checked = rows.map((raw, i) => {
    const { question, errors } = validateQuestion(raw, { allowMissingAnswer: true });
    return { row: i + 1, number: raw.number ?? null, question, errors, section_key: raw.section_key || 's0', answer_required: !!question.answer_required };
  });
  if (!checked.some((r) => r.errors.length === 0)) throw new ImportError(diagnostics(rows, checked));
  checked.format = rows.format || 'table (header row)';
  checked.keyCount = rows.keyCount || 0;
  checked.sections = rows.sections || [{ key: 's0', title: '', kind: 'questions', section: defaultSection, questions: checked.length, lines: checked.length }];
  return checked;
}

module.exports = { parseFile, validateQuestion, ImportError, SECTIONS, LETTERS, IMAGE_KEYS, rowsFromText };
