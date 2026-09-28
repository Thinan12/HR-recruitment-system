# LALCO HR Recruitment System

A simple recruitment and assessment system for LALCO HR.

**Admin login → Dashboard → Upload questions → Create assessment link → Candidate takes the test → Results saved → HR reviews → Export**

## For HR staff

| Page | What it is for |
|---|---|
| **Dashboard** | Totals, pass / not pass, average score, highest IQ test score, completed and pending assessments |
| **Candidates** | Every candidate. Open one to see their details, scores, interview notes and final result, and to export PDF / Word / Excel |
| **Questions** | The question bank (IQ, General, Calculation, Essay). Upload a file, or add / edit / delete questions |
| **Assessments** | Create a link for a candidate, copy it, disable / enable / regenerate it, and review answers |
| **Results** | One row per candidate, with export buttons and "Export all candidates (Excel)" |
| **Report** | The **standard report**: one row per candidate with exactly 15 fields — Candidate Name, Phone Number, Graduate From, High School, College, University, School Name, Subject, GPA / Mark, Date and Time, IQ Test Score, Behavioral Assessment Score, Calculation Score, Essay Score, Pass / Not Pass Status |
| **Settings** | Default exam time, default link expiry, pass mark of each test, final eligibility mark, default language, change password |

### Uploading questions

Accepted files: Excel (`.xlsx`, `.xls`), Word (`.docx`, `.doc`), PDF, CSV and TXT (max 10 MB).
A PDF whose pages are pictures (scanned, or exported as images) is read automatically with OCR: question number, question text, answer cards and the answer key at the end are recognised, and the diagrams are kept as pictures. This takes about 15–60 seconds for a 50-question booklet.

Every upload shows a preview first (questions found, valid, invalid, and the reason for each skipped row). Nothing is saved until you press **Import**.
Questions already in the bank are skipped, so uploading the same file twice is safe.

**Table layout** (Excel, CSV, or a table in Word). Use **Download Excel template** on the Questions page to get a ready-made file:

| Question | Type | Category | Difficulty | Option A | Option B | Option C | Option D | Correct Answer | Marks |
|---|---|---|---|---|---|---|---|---|---|
| 2, 4, 8, 16, ? | IQ | Number pattern | Easy | 24 | 32 | 30 | 20 | B | 1 |

Only **Question**, the **options** and **Correct Answer** are required. The Correct Answer can be the letter (`B`) or the option text (`32`).
The **Type** is IQ, General, Calculation or Essay. If there is no Type column, the type chosen on the upload form is used. An Excel sheet named "IQ" is treated as IQ questions.

**Numbered text** (Word, PDF, TXT) — no column headers needed. Questions numbered `1.` `1)` `Q1` `Q.1` or `Question 1`; options `A.` `A)` `(A)` `a)` or just `A Sydney`, one per line or several on one line; questions and options may wrap onto more lines and across pages. The answer can be an `Answer: B` line or an **Answer Key** section at the end (heading "Answer Key", "Answers", "Correct Answers" or "Solutions"; entries like `1. C`, `1 - C`, `1: C Canberra`, `1. Canberra` or `1. C 2. B 3. D`). If a key gives a letter and text that disagree, or text that matches no single option, the question is marked for review instead of guessed. Page headers, titles and "Name: ____" lines are ignored. Example:

```
1. What number comes next: 3, 6, 9, ?
A. 10
B. 12
C. 15
D. 11
Answer: B
Type: IQ
```

Options may also be on one line (`A. Red  B. Blue  C. Green  D. Chair`).

- **Delete All Questions:** the **Question Bank** box on the Questions page lists each test area (IQ, General, Calculation, Essay) with its number of questions, an **Upload** button and a **Delete All Questions** button. It clears only that area — active, inactive and duplicate rows — after two confirmations ("Delete All IQ Questions?", then "Are you sure you want to delete ALL 95 IQ questions?"). Candidates' past assessments keep their own copy of every question, so their answers, scores, results and reports do not change. The deletion runs in one transaction (all or nothing), needs an admin login, and is recorded in the `audit_log` table (action `DELETE_ALL_QUESTIONS`, area, number deleted, admin, time). A new file can be uploaded straight away.
- **Mixed documents and short-answer Calculation:** a Word / PDF / TXT file may hold several parts (memo, Calculation test, essay, interview notes, scoring bands, policy tables). Headings split it into sections — bracket headings like "[1]", part headings like "2/ …", and short headings such as "Calculation", "Essay", "Interview", "Scoring", "Easy / Harder questions" (also in Lao: ຄິດໄລ່, ບົດຄວາມ, ສຳພາດ, ໃຫ້ຄະແນນ, ງ່າຍ, ຍາກ). Numbering may restart in each section. Only question sections are imported; interview material, scoring guides and other text are listed in the preview but never imported. "Each question has 5 marks" in a section sets its marks; a hint line ("ຄຳແນະນຳ:" / "Hint:") stays with its question; an essay's marking guide is kept as the essay's HR-only guidance, never shown to candidates. The preview's **Document analysis** shows each section with its detected test type; tick which to import and choose **Import as**. If the file does not match the selected type (e.g. Calculation questions while IQ is selected) a warning is shown and nothing goes into the selected bank unless you choose it. A Calculation question without options is a valid **short-answer** question; if the file gives no answer it is imported as **Answer required** (Inactive) — the answer is never guessed — and cannot be used in a test until HR enters it (Questions → status **Needs answer** → Edit → Correct Answer, Status Active). A question written in Lao is also stored as its own Lao text.
- **Bullet questions / behavioural interview banks:** questions do not need a number, a question mark, options or an answer. A file of bullet points (`•` `●` `▪` `-` `*` …) grouped under headings — such as a competency table (left column the competency, right column "• Tell me about a time …" questions) in PDF or Word, or a plain list in TXT — is read by its structure and wording ("Tell me about…", "Describe…", "Give me an example…", "What / How…"), without AI. In a PDF the page layout is used: the left column becomes the **category**, a bullet starts a question, wrapped lines and lines continued on the next page stay in the same question, and a heading inside the questions column is not a new category. Running titles, table headers ("Competency / Sample interview questions"), group headers ("Competencies that support …"), footers, copyright lines and page numbers are not imported. Each question gets a confidence (High / Medium); Medium ones are shown as **Needs review** with the reason and are imported only if you tick them in. Behavioural questions go to the managed test type with the **Behavioural / Interview** format; if there is none, the preview offers **Create test type "Behavioural Interview"** (or choose an existing type) — they are never put into IQ, General, Calculation or Essay unless you choose it. Categories from the document are created for the new type, one per competency (names matched ignoring case and spaces). A "Scoring guide: / Expected behaviour: / Evaluation criteria:" line under a question is kept as HR-only guidance.
- **Pictures:** in **Add question** / **Edit**, any question and any option (A–E) can have a picture (PNG, JPG, GIF or WebP, up to 2 MB). An option can be text, a picture, or both. A fifth option (E) is optional.
- **Essay** questions need no options. HR enters the marks on the assessment review page.
- **Calculation** questions can have options, or just one exact answer (e.g. `Answer: 1250`). Spaces and commas are ignored when marking.

### Test types

- The Question Bank tabs (All + one per test type), the question and import forms, Create Assessment, the dashboard, Results and the exports all use the managed **test types**. **Questions → Manage Test Types** (or **+ Add Test Type**) lists them with their key, question format, Lao title, question counts, order and status.
- **Add** a test type: name, Lao title (shown to Lao candidates), question format — *Multiple choice*, *Calculation* (multiple choice or short answer), *Essay* (marked by HR) or *Behavioural / Interview* (written answer marked by HR, no options or correct answer); the IQ format belongs to IQ only — display order, default pass mark, and whether it is available for new assessments. It appears at once as a Question Bank tab, in Add question, in the import "Import as" list and in Create Assessment.
- **Edit** changes the name, Lao title, description, order, pass mark and availability; the **key** (e.g. `iq`, `general`) and the format never change, so questions, categories, links, past results and exports stay attached. Links run their tests in the test type order (IQ → General → Calculation → Essay → …); reordering affects new links only.
- **Deactivate** hides a test type from new questions, categories and assessments and hides its tab; nothing is deleted and links already created keep working. **Reactivate** brings it back. **Remove** is possible only for an added test type that nothing uses; the four core types (IQ, General, Calculation, Essay) can never be deleted ("Core Test Type — Delete unavailable"). "All" is only a filter.
- Imports match a Type column by key, name, title or the usual words ("IQ test", "general knowledge", "math", Lao names), ignoring case and spaces. A test type that does not exist is never put into another one: the preview asks to **create it** (with a format) or **use an existing** test type. `#/questions/iq` opens a tab directly; the API filter `?section=iq` works in any case.

### Question categories

- A **category** is a topic inside one test type (e.g. IQ → Number Pattern, General → Geography). It is separate from the IQ **level** (1–5): a question can be Level 1 or Level 5 in the same category. Categories are for HR only — they are never shown to candidates and do not change marks, scoring, the random draw or any result.
- **Questions → Question Categories** lists the categories per test (tabs All / IQ / General / Calculation / Essay, search), with their active and inactive question counts. **+ Add Category** (test type, name, optional Lao name), **Edit** (renaming also renames it on its questions), **Deactivate** / **Remove**, **Reactivate**. A category that questions use is only deactivated — the questions keep it, but it can no longer be chosen for new questions; an unused one is removed. Click a category to see its questions.
- The same name cannot exist twice in one test type (spaces and capitals are ignored: "Sequences", " sequences ", "SEQUENCES" are the same); the same name in two test types is fine.
- **Add / Edit question:** the Category list shows only the active categories of the chosen test type (IQ questions must have one). **Questions list:** Category filter (with counts, and "No category"), and tick questions to **Set category** / **Remove category** for all of them at once — nothing else about the questions changes.
- **Import:** a Category / Topic column is matched to the managed categories (spaces and capitals ignored). A name that does not exist is never created silently: the preview asks, per name, to **create it** or **use an existing category** (or Cancel). Rows without a category are marked "Missing — Review Required" (IQ) and can be given one afterwards with Set category.
- When this feature was first started, every category name already used by questions became a managed category, keeping its name; names that differed only in capitals or spaces were merged into one.

### Lao questions

- Every question keeps its **English** text as the source; its **Lao** text is stored next to it on the same question (same id, options, correct letter, level and marks). There is one question bank, not two.
- **Lao status** of each question: *English only* (no Lao yet), *Lao ready* (translated, not yet reviewed by HR), *Lao reviewed* (checked by HR), *Needs review* (e.g. a problem in the English source, or the English was changed after translating), *Failed*. Only *Lao ready* / *Lao reviewed* questions are used in a Lao assessment.
- Before a Lao text can be ready it is checked: every option has Lao, the numbers and maths symbols are exactly the same as in English, the question contains Lao script, no HTML, no broken characters. Numbers, codes and letter sequences (e.g. 2, 4, 8, ?  /  A, C, E, ?  /  PEN = QFO) stay as they are; pictures are not changed.
- **Questions page:** the Lao text is shown under the English, with the Lao status and a filter (Lao ready / English only / Needs review / Failed). **Edit Lao** shows the English read-only next to the Lao fields, with a Check button. The Question Bank box shows *Lao ready n of N* per test.
- **New questions:** an import file may include Lao columns (e.g. "Question (Lao)", "Option A (Lao)" …); they are checked and stored with the question. **Translate Missing Lao** translates every question without Lao in batches of 10 in the background — only when an automatic translation service is configured (`ANTHROPIC_API_KEY`, optionally `TRANSLATE_MODEL`, set as Railway variables; the key never reaches the browser). Imports are then translated automatically. Nothing is translated during an exam.
- **Lao assessment:** choose Language = Lao when creating the link. Each candidate still gets their own random questions; their copy saves the Lao text they were shown, so later edits never change a started test. If fewer Lao-ready questions exist than requested, the link cannot be created and HR is told how many need translation. The Excel / PDF / Word exports show the assessment language; the review page shows English and Lao side by side.

### How an assessment works

1. On **Assessments → Create Assessment**, optionally give the link a name (e.g. "September Recruitment"), choose the language and how long new candidates may start, then tick the **Tests Included** — IQ, General, Calculation, Essay — with the number of questions, minutes and pass mark for each. Press **Generate ONE Assessment Link**.
2. **One link for many candidates.** Send the same link to everyone. Each person who opens it and presses Start gets their **own session**: their own details, their own random questions and option order, their own timers, answers, stages and results. They enter their details once, then take the tests **one by one, always in the order IQ → General → Calculation → Essay** (only the ticked ones). A progress list shows ✓ done, → current, ○ still to come, ✕ not passed, 🔒 locked. A refresh, or closing and reopening the link in the same browser, continues that person's own attempt (same questions, answers and deadline). There is no button on the candidate page to switch candidates: a new person uses their own browser, or a new private / incognito window on a shared computer, and gets an empty form automatically.
3. Each test has **its own timer**, enforced by the server; when it runs out the test is submitted automatically and scored. A test is **passed** when its percentage reaches its pass mark. After every test the candidate sees the result — score, percentage, level (IQ: LALCO IQ Score and IQ Level), PASS / NOT PASS and the pass mark. After a pass: "Next Test — Continue". If a test is **not passed the assessment stops**, the later tests are locked (🔒) and the candidate is asked to contact HR. The Essay is last and waits for HR marking.
4. The server decides which test comes next: refreshing, a second tab or a changed address cannot skip or reopen a test. **Random questions per candidate:** when a candidate's test opens, the server draws that candidate's own random set from the active bank (the number HR set; IQ random within each level, Level 1 first) and shuffles the answer options, and saves it on that candidate's attempt. A refresh or reconnect shows the same saved set; the next candidate on the same link gets a new draw (if it would be exactly the same questions in the same order as someone else on the link, it is drawn again, up to 5 times). The link page API lists each candidate's drawn question ids for checking.
5. On **Assessments → View**, HR sees each test (status, times, score, %, PASS / NOT PASS) and every answer: chosen option (and the letter the candidate saw), the correct answer, Correct / Wrong / Not answered.
6. The link stays the same for everyone. **Disable** (or the expiry time) stops NEW candidates from starting; candidates already in a test can finish. To stop one candidate, press Disable on their own row. A link that nobody has used can be deleted or given a new address; a used link is kept with its candidates' results. On **Assessments**, each shared link is one row with its number of candidates; **Candidates** opens the list of everyone who used it (one row per candidate: details, current stage, each test, final score, eligibility, HR Final Result, start and finish times). Links created before shared links were introduced keep working for their one candidate, exactly as before.

### The LALCO IQ test

- The IQ bank and the General (recruitment) bank are separate question pools.
- **Question pool vs. test length.** The IQ bank is the *pool* (e.g. 95 active questions). HR sets how many questions a candidate gets (default **18**, quick choices 10 / 15 / 18 / 20 / 30, or any whole number from 1 up to the pool size); each candidate gets exactly that many, drawn at random from the pool, never the same question twice, with shuffled answers. The rest of the pool stays in the bank.
- Every IQ question has one of **5 levels**, and the level alone sets its marks: **Level 1 Easy = 1**, **Level 2 Basic = 2**, **Level 3 Moderate = 3**, **Level 4 Difficult = 4**, **Level 5 Very Difficult = 5** marks. A Marks value in an imported file is ignored for IQ; no level given = Level 3. Levels can be typed as 1–5, "Level 4" or the name.
- Questions are split evenly across the levels and shown Level 1 first up to Level 5, random within each level: 20 → 4 each (maximum 60 marks), 18 → 4 / 3 / 3 / 4 / 4 (maximum 55), 10 → 2 each, 30 → 6 each. The maximum is worked out from the questions the candidate actually got. Candidates never see the level or the marks.
- The **IQ Test Score** is the weighted marks, e.g. **24 / 60 (40%)**, with correct answers (e.g. 11 / 20) and each level's correct answers and marks, on Results, the candidate page, the review page, the dashboard and the PDF / Word / Excel exports. Tests taken before the 5-level scale keep their own Easy / Medium / Hard marks and show them as the earlier 3-level scale. It is a test score, not a clinical IQ; no IQ-number conversion is applied.
- **Question count.** A candidate gets exactly the number of IQ questions HR set for the link (18 → 18 questions, split 4 / 3 / 3 / 4 / 4 over Levels 1–5; 30 → 6 each), saved with the attempt. Every score, maximum, level breakdown, percentage and export is worked out from those saved questions only — never from the bank size, the Lao-ready count or a default (18 questions: maximum 55 marks; 30: 90). A link cannot be made for more different questions than the bank holds (copies count once); if the bank shrinks after the link was made, the test does not start ("not enough questions — contact HR") instead of giving fewer questions. A finished test whose saved questions do not match its count (or its maximum) is shown to HR as **"Attempt question count mismatch — review required."**; nothing is changed.
- **LALCO IQ Score (0–150).** Every IQ result also gets a LALCO IQ Score = weighted marks ÷ maximum marks of that candidate's questions × 150, rounded, so tests of any length are comparable (0 marks = 0, half = 75, full marks = 150; e.g. 27 / 55 = 74 Borderline, 27 / 90 = 45 Extremely low). **IQ Classification** (LALCO IQ Score Classification table, on the Results page): **130–150 Very superior** (2.2%), **120–129 Superior** (6.7%), **110–119 High average** (16.1%), **90–109 Average** (50%), **80–89 Low average** (16.1%), **70–79 Borderline** (6.7%), **0–69 Extremely low** (2.2%). Every whole score 0–150 is in exactly one row; the classification is always looked up from the LALCO IQ Score (never from the raw %). The population percentages are reference values from the table only — not calculated from LALCO candidates and not used for scoring or ranking. Lao names are shown to Lao candidates. This is separate from the question levels 1–5, and from the % levels of the other tests. It is worked out from the stored weighted marks (nothing extra is saved), so earlier tests show it too; with no maximum it shows as not available. It is calculated from the LALCO weighted IQ assessment score on a 0–150 scale — a recruitment score, not a clinical IQ. Shown next to the weighted score and percentage on the dashboard, candidate page, review page, Results and the PDF / Word / Excel exports. The candidate's own result screen shows the IQ score, LALCO IQ Score, classification and PASS / NOT PASS but **not the IQ percentage** (it is not sent to the candidate's browser); HR sees the percentage everywhere.
- **Original LALCO IQ bank:** 45 original questions across number patterns, sequences, visual patterns and matrices, odd one out, logical relationships, spatial reasoning, mathematical reasoning and abstract patterns, with pictures drawn by `scripts/lalco-iq-bank.js`, which also loads the bank on the 5-level scale: `node scripts/lalco-iq-bank.js https://your-site <admin-password>` (running it twice adds nothing).

### Scores, levels, pass marks and eligibility

- Multiple choice: correct = full marks, wrong = 0, no negative marking.
- Every test has a **score** (marks earned / maximum marks of the questions that candidate got), a **percentage** (shown with one decimal), a **level**, **PASS / NOT PASS** and a **status**.
- **Level** of General, Calculation, Essay and the final score: **90%+ Exceptional**, **80%+ Very High**, **70%+ High**, **60%+ Average**, **50%+ Low**, below 50% **Very Low**. The **IQ Level** comes from the LALCO IQ Score (see above). A level is information only; it is not the pass / fail.
- **Pass marks** (Settings): IQ **70%**, General **60%**, Calculation **60%**, Essay **60%**. They are defaults for new links and can be changed on each new link. Each link keeps the marks it was created with, so changing Settings never changes an existing result. (Links made before per-test pass marks keep the single 60% they were taken with.)
- **Status** of each test: NOT STARTED (the next one the candidate may open), IN PROGRESS, PENDING HR MARKING, PASS, NOT PASS, LOCKED (an earlier test is not finished or not passed).
- **Final Overall Score** = the average of the percentages of the tests included in the link (two tests → divided by 2). It is worked out only when every test is finished and the essay is marked.
- **Company Eligibility** (system result): **ELIGIBLE** when every test in the link is passed **and** the Final Overall Score reaches the final eligibility mark (Settings, default **70%**). A test not passed = NOT ELIGIBLE, with no final score from tests that were never taken. While a test or the essay marking is outstanding it is PENDING. A high score in one test never makes up for a failed one.
- **HR Final Result** is HR's own decision, entered on the candidate page with the interview details. The system never changes it, and it never changes the Company Eligibility.
- **Standard report / exports.** "Export all (Excel)" and each candidate's **PDF / Word / Excel** buttons give the standard report: the 15 fields above, nothing else. Scores are the ones already calculated: IQ Test Score = LALCO IQ Score (e.g. 74 / 150), Behavioral Assessment (the General test) and Calculation = percentage, Essay = HR's marks (e.g. 8 / 10), or "Pending HR marking" until marked — never 0 unless 0 was given; a test not reached shows Locked / Not started, and "—" means not part of the assessment. Date and Time = when the assessment was submitted (or started), Lao time. Pass / Not Pass Status is **PASS** / **NOT PASS** (PENDING while an essay waits), in bold on the Report page, PDF, Word and Excel. The Excel has an AutoFilter on every column (the two % columns are numbers, so they filter by value) and a frozen header; a phone number used by more than one candidate (compared by its digits, +856 20 … = 020 …) is highlighted with a note — nothing is merged or deleted. The Report page can show only duplicate phone numbers. The full detailed files are still there as **Detailed Excel / PDF / Word** (`?detail=full`).
- The **Dashboard** shows summary counts (eligible / not eligible / pending, passed / not passed per test, essays pending marking, IQ levels; click a card to filter) and one row per candidate with every test's score, %, level and result, the final %, final level, eligibility and HR Final Result, with filters. The candidate page, the review page and the PDF / Word / Excel exports show the same.
- **Test Score** (still shown and exported) is the percentage over all marks of the latest assessment.

## For developers

Node.js 24 LTS, Express, SQLite (`better-sqlite3`), plain HTML/JS frontend (no build step).

```
npm install
ADMIN_PASSWORD=choose-a-password npm start    # http://localhost:3000
npm test                                       # 186 tests, uses temporary databases (set LALCO_SAMPLE_DOCX / LALCO_BEHAVIOURAL_PDF to also test real documents)
```

```
src/
  server.js        start-up, first admin, auto-submit sweep
  app.js           express app, security headers, health check, error handling
  db.js            schema and settings
  auth.js          admin login (bcrypt + JWT in an httpOnly cookie)
  assessments.js   links, random selection, timer rules, scoring
  importer.js      question file parsing and validation
  reports.js       dashboard, candidate summaries, detailed PDF / Word / Excel exports
  standardReport.js the standard 15-field report (web, Excel, PDF, Word)
  routes/admin.js  admin API
  routes/exam.js   candidate API
public/
  admin.html, exam.html, static/   the two pages, their scripts and CSS
test/              node:test suites and Word-generated fixtures
```

**Database tables:** `admins`, `settings`, `candidates` (incl. interview and final decision), `test_types` (key, name, Lao title, format, active, in assessments, order, pass mark, core), `questions` (with `category_id`), `question_categories` (test type, name, Lao name, active), `assessment_links` (a shared link: token, tests, counts, timers, pass marks, expiry, enabled), `assessments` (one candidate's attempt and scores; `link_id` + `session_hash` tie it to the shared link and the SHA-256 of that browser's session cookie; older one-person links have no `link_id` and use their own token), `assessment_stages` (the tests inside one attempt: order, timer, score, result), `assessment_questions` (each candidate's questions, copied from the bank so later edits never change a past result), `images` (question and option pictures), `audit_log` (Delete All Questions and candidate session steps, without personal data).

**Candidate sessions:** opening a shared link gives the browser a random 256-bit secret in an HttpOnly, SameSite=Lax cookie (Secure in production) scoped to that link's API path; no record is created until the candidate presses Start. Every candidate request is resolved from link + cookie on the server — ids sent by the browser never decide whose attempt is used — and starting is one transaction with a unique (link, session) index, so a double-click or second tab never creates a second attempt.

### Railway

The service needs:

| Setting | Value |
|---|---|
| Volume | mounted at `/data` |
| `DATABASE_PATH` | `/data/hr.db` |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | 48+ random characters |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | the first admin (used only while no admin exists) |

`railway.json` sets the start command and the health check (`GET /api/health` → `{"status":"ok","database":"connected"}`). Keep one replica, because SQLite lives on the volume.
