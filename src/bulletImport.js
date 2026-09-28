// Unnumbered questions: bullet points grouped under headings. The typical
// case is a competency table of behavioural interview questions:
//
//   Competency            | SAMPLE INTERVIEW QUESTION(S)      <- table header (not imported)
//   Competencies that support LEADING PEOPLE                  <- group header (not imported)
//   Change                | • Please tell us about a time ... <- left cell = category,
//   Leadership            |   how you helped others ...          wrapped lines = one question
//                         | • Tell me about a time ...
//   Brought to you by ...                              1      <- footer / page number (not imported)
//
// A question is recognised by its structure (a bullet, under a heading) and
// its wording ("Tell me about ...", "Describe ...", "?"), never by a number,
// options or an answer. Everything here is deterministic; no AI is used.
//
// Input lines are { text, role? }. Roles come from the document layout when it
// is known (PDF columns, Word table cells and list items); otherwise they are
// inferred from the text:
//   bullet      starts a question
//   heading     a category (competency); consecutive heading lines are one name
//   subheading  a heading inside the questions column (not a new category)
//   group       a header above several categories ("Competencies that support ...")
//   boiler      page headers / footers / numbers, table headers
//   text        continues the current question (wrapped line, page break)

const RE_BULLET = /^(?:[•●○◦▪▫■□◆◇►▶➢➤✓✔·‣⁃]|[-]|[-–—*](?=\s))\s*/;
const RE_PAGE_NUMBER = /^(?:page\s*)?\d{1,3}(?:\s*(?:of|\/)\s*\d{1,3})?$/i;
const RE_TABLE_HEADER = /^(?:competenc(?:y|ies)|categor(?:y|ies)|(?:sample\s+)?(?:interview\s+)?questions?(?:\s*\(s\))?|sample\s+interview\s+question\s*\(?s?\)?)(?:\s+(?:sample\s+)?(?:interview\s+)?questions?\s*(?:\(s\))?)?$/i;
const RE_GROUP = /^(?:competenc(?:y|ies)|skills?|behaviou?rs?|abilities)\s+(?:that|which)\s+support\b|^(?:part|section)\s+[\dA-Z]+\s*[:.\-–]/i;
const RE_COPYRIGHT = /^(?:©|\(c\)|copyright\b|all rights reserved|brought to you by\b|confidential\b)/i;
// Openers of a candidate prompt ("Tell me about ...", "Describe ...") and question words.
const RE_OPENER = /^(?:please\s+)?(?:tell|describe|give|discuss|explain|recount|share|outline|walk\s+(?:me|us)|talk\s+(?:me|us)|provide|think\s+(?:of|about)|using\s+a|imagine|can\s+you|could\s+you|would\s+you|have\s+you|do\s+you|did\s+you|are\s+you|were\s+you|in\s+your\s+(?:opinion|experience|view))\b/i;
const RE_QWORD = /^(?:what|how|why|when|where|which|who|whom|whose|is|are|was|were|do|does|did|have|has|can|could|would|should|will)\b/i;
const RE_ASKS = /\b(?:tell\s+(?:me|us)|describe|give\s+(?:me\s+|us\s+)?(?:an?\s+|some\s+)?(?:specific\s+)?(?:example|instances?)|what\s+did\s+you|how\s+did\s+you|what\s+was\s+the|explain)\b|[?？]/i;
const RE_BEHAVIOURAL = /\b(?:a\s+time|situation|example|instance|experience|occasion)\b/i;
// Lao: "ເລົ່າ" (tell), "ອະທິບາຍ" (explain / describe), "ຍົກຕົວຢ່າງ" (give an example), "ກະລຸນາ" (please), question words.
const RE_LAO_OPENER = /^(?:ກະລຸນາ\s*)?(?:ເລົ່າ|ອະທິບາຍ|ຍົກຕົວຢ່າງ|ບອກ|ອະທິບາຍ|ທ່ານເຄີຍ|ທ່ານຈະ|ຈົ່ງ)/;
const RE_LAO_QUESTION = /ແນວໃດ|ຫຍັງ|ເປັນຫຍັງ|ບໍ່\s*[?？]?$|ບໍ\s*[?？]?$|ໃດ\s*[?？]?$|ເທົ່າໃດ|ຈັກ/;
const RE_GUIDE = /^(?:scoring\s+guide|expected\s+(?:behaviou?rs?|answers?)|evaluation\s+criteria|suggested\s+answers?|marking\s+guide|look\s+for|ຄຳແນະນຳ|ຄໍາແນະນໍາ|ເກນການໃຫ້ຄະແນນ)\s*[:.\-–]\s*/i;

const clean = (s) => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const isLao = (s) => /[຀-໿]/.test(s);
const ended = (s) => /[.?!？。)"'”’:]\s*$/.test(s);
const opens = (s) => RE_OPENER.test(s) || RE_LAO_OPENER.test(s);
const asksSomething = (s) => opens(s) || RE_QWORD.test(s) || RE_ASKS.test(s) || RE_LAO_QUESTION.test(s);

// A short, title-like line: "Change Leadership", "Problem Solving / Judgement:".
function titleLike(s) {
  const t = s.replace(/[:：]\s*$/, '');
  if (!t || t.length > 70 || /[.?!？;]$/.test(t) || opens(t) || RE_QWORD.test(t) && /\s/.test(t) && t.split(/\s+/).length > 3) return false;
  if (isLao(t)) return t.length <= 45 && !RE_LAO_QUESTION.test(t);
  if (t.split(/\s+/).length > 8) return false;
  return /^[\p{Lu}\d(]/u.test(t);
}

// Lines that repeat on several pages (running titles, table headers, footers).
function repeatedLines(lines) {
  const pages = new Map();
  const paged = lines.some((l) => l.page != null);
  lines.forEach((l, i) => {
    if (l.role === 'bullet' || RE_BULLET.test(l.text)) return;
    // With a position, a running header / footer is the same text at the same height
    // ("Orientation" in three table cells is not a footer).
    const k = l.text.toLowerCase().replace(/\d+/g, '#') + (l.y != null ? '@' + Math.round(l.y / 4) : '');
    if (!pages.has(k)) pages.set(k, new Set());
    pages.get(k).add(paged ? l.page : i);
  });
  // With pages: on at least 2 pages (3 when there are more). Without: 3 times or more.
  const need = paged ? Math.max(2, Math.min(3, new Set(lines.map((l) => l.page)).size)) : 3;
  return new Set([...pages].filter(([, p]) => p.size >= need).map(([k]) => k));
}

// How sure we are that a bullet / line is a candidate question.
function confidence(q) {
  const t = q.text;
  let score = 0;
  const notes = [];
  if (q.bullet) score += 2;
  if (q.category) score += 1;
  if (opens(t)) score += 2;
  else if (RE_QWORD.test(t) || RE_LAO_QUESTION.test(t)) score += 1;
  if (/[?？]/.test(t)) score += 1;
  if (RE_ASKS.test(t) && !opens(t)) score += 1;
  if (t.length >= 20 && t.length <= 800) score += 1;
  else { score -= 2; notes.push(t.length < 20 ? 'Very short — check that the question is complete.' : 'Very long — check that two questions were not joined.'); }
  if (/^[\p{Ll}]/u.test(t)) { score -= 1; notes.push('Starts in lower case — the beginning of the question may be missing in the file.'); }
  if (!q.bullet) notes.push('Not a bullet point in the file.');
  const level = score >= 5 ? 'High' : score >= 3 ? 'Medium' : 'Low';
  return { level, score, note: level === 'High' ? '' : notes.join(' ') || 'Check the wording.' };
}

// Returns { rows, document } when the lines hold bullet questions, else null.
function bulletQuestions(input) {
  const lines = input.map((l) => ({ ...l, text: clean(l.text) })).filter((l) => l.text);
  const bullets = lines.filter((l) => l.role === 'bullet' || (!l.role && RE_BULLET.test(l.text)));
  const bulletText = (l) => l.text.replace(RE_BULLET, '').trim();
  const questionLike = bullets.filter((l) => asksSomething(bulletText(l)) || RE_BEHAVIOURAL.test(bulletText(l)));
  // Bullets must mostly be questions (not, say, the options of a multiple-choice test).
  if (questionLike.length < 3 || questionLike.length < bullets.length * 0.5) return null;
  const numbered = lines.filter((l) => /^(?:q(?:uestion)?\s*\.?\s*\d{1,4}\s*[.):\-–]?\s+|\d{1,4}\s*[.)]\s+)\S/i.test(l.text)).length;
  if (numbered > questionLike.length) return null;

  const repeated = repeatedLines(lines);
  const questions = [];
  let category = '';
  let group = '';
  let heading = null; // heading lines being collected (a wrapped left cell)
  let cur = null;
  let guide = false;
  const skipped = { headings: 0, boilerplate: 0, other: 0 };
  const categories = new Map();

  const closeHeading = () => {
    if (!heading) return;
    const name = clean(heading.parts.join(' ').replace(/\s*\/\s*/g, ' / ').replace(/[:：]\s*$/, ''));
    heading = null;
    if (!name || RE_TABLE_HEADER.test(name)) { skipped.boilerplate++; return; }
    category = name;
    cur = null;
    skipped.headings++;
  };
  const push = (text, bullet) => {
    closeHeading();
    cur = { text, bullet, category, group, guide: '' };
    guide = false;
    questions.push(cur);
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const text = l.text;
    let role = l.role;
    const key = text.toLowerCase().replace(/\d+/g, '#');
    if (role === 'boiler' || RE_PAGE_NUMBER.test(text) || RE_COPYRIGHT.test(text) || (repeated.has(key) && !role)) { skipped.boilerplate++; continue; }
    if (!role) {
      if (RE_BULLET.test(text)) role = 'bullet';
      else if (RE_GROUP.test(text)) role = 'group';
      else if (RE_TABLE_HEADER.test(text.replace(/[:：]\s*$/, ''))) role = 'boiler';
      // A title-like line is a heading unless it clearly continues an unfinished question.
      else if (titleLike(text) && (/[:：]\s*$/.test(text) || !cur || ended(cur.guide || cur.text) || l.blankBefore)) role = 'heading';
      else role = 'text';
    }
    if (role === 'boiler') { skipped.boilerplate++; continue; }
    if (role === 'group') { closeHeading(); group = text; category = ''; cur = null; skipped.headings++; continue; }
    if (role === 'heading') {
      if (RE_TABLE_HEADER.test(text.replace(/[:：]\s*$/, ''))) { skipped.boilerplate++; continue; }
      // A wrapped heading ("Change" / "Leadership") is one name; a new heading after text starts again.
      if (heading && !l.blankBefore && (l.page == null || l.page === heading.page)) heading.parts.push(text);
      else { closeHeading(); heading = { parts: [text], page: l.page }; }
      continue;
    }
    if (role === 'subheading') { closeHeading(); cur = null; skipped.headings++; continue; }
    if (role === 'bullet') {
      const t = text.replace(RE_BULLET, '').trim();
      if (t) push(t, true); else closeHeading();
      continue;
    }
    // Text: an HR-only guide, the rest of the current question, or a question without a bullet.
    closeHeading();
    const g = text.match(RE_GUIDE);
    if (cur && g) { guide = true; cur.guide = text; continue; }
    if (cur && guide) { cur.guide += '\n' + text; continue; }
    if (cur) { cur.text += ' ' + text; continue; }
    if (opens(text) && text.length >= 20) { push(text, false); continue; }
    skipped.other++;
  }
  closeHeading();

  const rows = [];
  let dropped = 0;
  for (const q of questions) {
    q.text = clean(q.text.replace(/(\w)- (\w)/g, (m, a, b) => (/[a-z]/.test(b) ? `${a}-${b}` : m)));
    const c = confidence(q);
    if (c.level === 'Low') { dropped++; continue; }
    const n = (categories.get(q.category) || 0) + 1;
    categories.set(q.category, n);
    rows.push({ question_text: q.text, category: q.category, group: q.group, correct_answer: q.guide, number: n, confidence: c.level, review: c.level === 'Medium' ? c.note : '' });
  }
  if (rows.length < 3) return null;
  const behavioural = rows.filter((r) => opens(r.question_text) && RE_BEHAVIOURAL.test(r.question_text) || /^(?:please\s+)?(?:tell|describe|give|recount)\b/i.test(r.question_text)
    || (RE_LAO_OPENER.test(r.question_text) && /ຄັ້ງໜຶ່ງ|ສະຖານະການ|ຕົວຢ່າງ|ປະສົບການ|ເຫດການ/.test(r.question_text))).length >= rows.length * 0.5;
  const hasCategories = [...categories.keys()].some(Boolean);
  return {
    rows,
    document: {
      type: behavioural ? 'Behavioural Interview Question Bank' : 'Question list',
      structure: 'Bullet questions' + (hasCategories ? ' grouped by ' + (behavioural ? 'competency' : 'heading') : ''),
      behavioural,
      categories: [...categories].map(([name, questions]) => ({ name, questions })),
      not_imported: { headings: skipped.headings, page_text: skipped.boilerplate, other: skipped.other, low_confidence: dropped },
    },
  };
}

// ---- layouts -------------------------------------------------------------------

// PDF: text lines with their position and font (pdf.js), so a two-column table
// keeps its meaning: left column = category, bullets on the right = questions.
async function pdfLines(buffer, maxPages = 300) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  const raw = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      let cur = null;
      for (const it of items) {
        if (!it.str) continue;
        const [a, , , , x, y] = it.transform;
        const size = Math.abs(a) || 10;
        const gap = cur ? x - cur.end : 0;
        // Same baseline and close by: the same line (items often split words).
        if (cur && Math.abs(y - cur.y) < size * 0.3 && gap > -size && gap < size * 3) {
          if (gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
          cur.text += it.str;
          cur.end = Math.max(cur.end, x + it.width);
        } else {
          if (cur) raw.push(cur);
          cur = { page: p, x, y, end: x + it.width, size, font: it.fontName, text: it.str };
        }
      }
      if (cur) raw.push(cur);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  const lines = raw.map((l) => ({ ...l, text: clean(l.text) })).filter((l) => l.text);
  // The bullet column: where most bullet glyphs sit.
  const xs = new Map();
  for (const l of lines) if (RE_BULLET.test(l.text)) { const k = Math.round(l.x / 4) * 4; xs.set(k, (xs.get(k) || 0) + 1); }
  const top = [...xs].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 3) return lines.map((l) => ({ text: l.text, page: l.page }));
  const bx = top[0];
  const repeated = repeatedLines(lines);
  let prev = null;
  return lines.map((l) => {
    let role;
    if (repeated.has(l.text.toLowerCase().replace(/\d+/g, '#') + '@' + Math.round(l.y / 4)) || RE_PAGE_NUMBER.test(l.text) || RE_COPYRIGHT.test(l.text)) role = 'boiler';
    else if (RE_BULLET.test(l.text) && Math.abs(l.x - bx) <= 8) role = 'bullet';
    else if (l.x < bx - 8) role = l.end > bx + 20 ? (RE_TABLE_HEADER.test(l.text) ? 'boiler' : 'group') : 'heading';
    else if (Math.abs(l.x - bx) <= 8) role = titleLike(l.text) ? 'subheading' : 'text';
    else role = 'text';
    // A left-column cell split by a large gap is two headings, not one.
    const blankBefore = role === 'heading' && prev && prev.role === 'heading' && prev.page === l.page && Math.abs(prev.y - l.y) > l.size * 2.2;
    prev = { role, page: l.page, y: l.y };
    return { text: l.text, role, page: l.page, blankBefore };
  });
}

// Word (via mammoth's HTML): list items are bullets; in a table with two or
// more cells, the first cell is the category and the others hold the questions.
function docxLines(html) {
  const decode = (s) => s.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const out = [];
  const blocks = (frag, role) => {
    let any = false;
    for (const m of frag.matchAll(/<(li|p|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const t = decode(m[2]);
      if (!t) continue;
      any = true;
      out.push({ text: t, role: m[1] === 'li' ? 'bullet' : role, blankBefore: true });
    }
    if (!any && decode(frag)) out.push({ text: decode(frag), role, blankBefore: true });
  };
  let last = 0;
  for (const t of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    blocks(html.slice(last, t.index));
    for (const r of t[0].matchAll(/<tr[\s\S]*?<\/tr>/g)) {
      const cells = [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1]);
      if (cells.length >= 2 && decode(cells[0]) && titleLike(decode(cells[0]))) {
        out.push({ text: decode(cells[0]), role: 'heading', blankBefore: true });
        for (const c of cells.slice(1)) blocks(c);
      } else for (const c of cells) blocks(c);
    }
    last = t.index + t[0].length;
  }
  blocks(html.slice(last));
  return out;
}

module.exports = { bulletQuestions, pdfLines, docxLines, RE_BULLET };
