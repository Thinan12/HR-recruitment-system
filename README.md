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
- **Pictures:** in **Add question** / **Edit**, any question and any option (A–E) can have a picture (PNG, JPG, GIF or WebP, up to 2 MB). An option can be text, a picture, or both. A fifth option (E) is optional.
- **Essay** questions need no options. HR enters the marks on the assessment review page.
- **Calculation** questions can have options, or just one exact answer (e.g. `Answer: 1250`). Spaces and commas are ignored when marking.

### How an assessment works

1. On **Assessments → Create Assessment**, choose the candidate (or "New candidate"), the language and how long the link stays valid, then tick the **Tests Included** — IQ, General, Calculation, Essay — with the number of questions and minutes for each. Press **Generate Assessment Link**.
2. The candidate gets **one link** for all the chosen tests. They enter their details once, then take the tests **one by one, always in the order IQ → General → Calculation → Essay** (only the ticked ones). A progress list shows ✓ done, → current, ○ still to come.
3. Each test has **its own timer**, enforced by the server; when it runs out the test is submitted automatically and scored. A test is **passed** when its percentage reaches its pass mark. After every test the candidate sees the result — score, percentage, level (IQ: LALCO IQ Score and IQ Level), PASS / NOT PASS and the pass mark. After a pass: "Next Test — Continue". If a test is **not passed the assessment stops**, the later tests are locked (🔒) and the candidate is asked to contact HR. The Essay is last and waits for HR marking.
4. The server decides which test comes next: refreshing, a second tab or a changed address cannot skip or reopen a test. Each candidate gets a different random set of questions, with shuffled answers.
5. On **Assessments → View**, HR sees each test (status, times, score, %, PASS / NOT PASS) and every answer: chosen option (and the letter the candidate saw), the correct answer, Correct / Wrong / Not answered.
6. A link can be used only once. An unused link stops working at its expiry time, or whenever you press **Disable**.

### The LALCO IQ test

- The IQ bank and the General (recruitment) bank are separate question pools.
- **Question pool vs. test length.** The IQ bank is the *pool* (e.g. 95 active questions). HR sets how many questions a candidate gets (default **18**, quick choices 10 / 15 / 18 / 20 / 30, or any whole number from 1 up to the pool size); each candidate gets exactly that many, drawn at random from the pool, never the same question twice, with shuffled answers. The rest of the pool stays in the bank.
- Every IQ question has one of **5 levels**, and the level alone sets its marks: **Level 1 Easy = 1**, **Level 2 Basic = 2**, **Level 3 Moderate = 3**, **Level 4 Difficult = 4**, **Level 5 Very Difficult = 5** marks. A Marks value in an imported file is ignored for IQ; no level given = Level 3. Levels can be typed as 1–5, "Level 4" or the name.
- Questions are split evenly across the levels and shown Level 1 first up to Level 5, random within each level: 20 → 4 each (maximum 60 marks), 18 → 4 / 3 / 3 / 4 / 4 (maximum 55), 10 → 2 each, 30 → 6 each. The maximum is worked out from the questions the candidate actually got. Candidates never see the level or the marks.
- The **IQ Test Score** is the weighted marks, e.g. **24 / 60 (40%)**, with correct answers (e.g. 11 / 20) and each level's correct answers and marks, on Results, the candidate page, the review page, the dashboard and the PDF / Word / Excel exports. Tests taken before the 5-level scale keep their own Easy / Medium / Hard marks and show them as the earlier 3-level scale. It is a test score, not a clinical IQ; no IQ-number conversion is applied.
- **LALCO IQ Score (50–150).** Every IQ result also gets a LALCO IQ Score = 50 + (weighted marks ÷ maximum marks of that test × 100), rounded and kept within 50–150, so tests of any length are comparable (0 marks = 50, half = 100, full marks = 150; e.g. 27 / 36 = 125). Category: **Exceptional** 130–150, **Very High** 115–129, **High** 100–114, **Average** 85–99, **Low** 70–84, **Very Low** 50–69. It is worked out from the stored weighted marks (nothing extra is saved), so earlier tests show it too; with no maximum it shows as not available. It is calculated from the LALCO weighted IQ assessment score on a 50–150 scale — a recruitment score, not a clinical IQ. Shown next to the weighted score and percentage on the dashboard, candidate page, review page, Results and the PDF / Word / Excel exports.
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
- The **Dashboard** shows summary counts (eligible / not eligible / pending, passed / not passed per test, essays pending marking, IQ levels; click a card to filter) and one row per candidate with every test's score, %, level and result, the final %, final level, eligibility and HR Final Result, with filters. The candidate page, the review page and the PDF / Word / Excel exports show the same.
- **Test Score** (still shown and exported) is the percentage over all marks of the latest assessment.

## For developers

Node.js 24 LTS, Express, SQLite (`better-sqlite3`), plain HTML/JS frontend (no build step).

```
npm install
ADMIN_PASSWORD=choose-a-password npm start    # http://localhost:3000
npm test                                       # 121 tests, uses temporary databases
```

```
src/
  server.js        start-up, first admin, auto-submit sweep
  app.js           express app, security headers, health check, error handling
  db.js            schema and settings
  auth.js          admin login (bcrypt + JWT in an httpOnly cookie)
  assessments.js   links, random selection, timer rules, scoring
  importer.js      question file parsing and validation
  reports.js       dashboard, candidate summaries, PDF / Word / Excel exports
  routes/admin.js  admin API
  routes/exam.js   candidate API
public/
  admin.html, exam.html, static/   the two pages, their scripts and CSS
test/              node:test suites and Word-generated fixtures
```

**Database tables:** `admins`, `settings`, `candidates` (incl. interview and final decision), `questions`, `assessments` (link and scores), `assessment_stages` (the tests inside one link: order, timer, score, result), `assessment_questions` (each candidate's questions, copied from the bank so later edits never change a past result), `images` (question and option pictures), `audit_log` (high-risk admin actions such as Delete All Questions).

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
