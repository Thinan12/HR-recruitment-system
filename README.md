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
| **Settings** | Default exam time, default link expiry, pass mark, default language, change password |

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

**Numbered text** (Word, PDF, TXT):

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

- **Pictures:** in **Add question** / **Edit**, any question and any option (A–E) can have a picture (PNG, JPG, GIF or WebP, up to 2 MB). An option can be text, a picture, or both. A fifth option (E) is optional.
- **Essay** questions need no options. HR enters the marks on the assessment review page.
- **Calculation** questions can have options, or just one exact answer (e.g. `Answer: 1250`). Spaces and commas are ignored when marking.

### How an assessment works

1. On **Assessments → Create Assessment**, choose the candidate (or "New candidate"), the language and how long the link stays valid, then tick the **Tests Included** — IQ, General, Calculation, Essay — with the number of questions and minutes for each. Press **Generate Assessment Link**.
2. The candidate gets **one link** for all the chosen tests. They enter their details once, then take the tests **one by one, always in the order IQ → General → Calculation → Essay** (only the ticked ones). A progress list shows ✓ done, → current, ○ still to come.
3. Each test has **its own timer**, enforced by the server; when it runs out the test is submitted automatically. A test is **passed** when its score reaches the pass mark (Settings, default 60%). After a pass the candidate sees "Passed — Next Test — Continue"; if a test is **not passed the assessment stops** and the candidate sees "You did not meet the required score… Please contact HR." The Essay is last and waits for HR marking.
4. The server decides which test comes next: refreshing, a second tab or a changed address cannot skip or reopen a test. Each candidate gets a different random set of questions, with shuffled answers.
5. On **Assessments → View**, HR sees each test (status, times, score, %, PASS / NOT PASS) and every answer: chosen option (and the letter the candidate saw), the correct answer, Correct / Wrong / Not answered.
6. A link can be used only once. An unused link stops working at its expiry time, or whenever you press **Disable**.

### Scores

- Multiple choice: correct = full marks, wrong = 0.
- Each score is the **percentage of available marks**. The **IQ Test Score** is a test score, not a clinical IQ measurement.
- **Test Score** is the percentage over the whole assessment. **Result** is PASS when the Test Score reaches the pass mark (Settings, default 60%). The Result is Pending while essay answers are still unmarked.
- **Final Result** is HR's own decision, entered on the candidate page together with the interview details.

## For developers

Node.js 24 LTS, Express, SQLite (`better-sqlite3`), plain HTML/JS frontend (no build step).

```
npm install
ADMIN_PASSWORD=choose-a-password npm start    # http://localhost:3000
npm test                                       # 77 tests, uses temporary databases
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

**Database tables:** `admins`, `settings`, `candidates` (incl. interview and final decision), `questions`, `assessments` (link and scores), `assessment_stages` (the tests inside one link: order, timer, score, result), `assessment_questions` (each candidate's questions, copied from the bank so later edits never change a past result), `images` (question and option pictures).

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
