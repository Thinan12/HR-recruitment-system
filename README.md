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

1. On **Assessments**, choose the candidate (or "New candidate"), the test type, language (English / Lao), the time limit and how long the link stays valid. Then press **Generate Link**.
2. Send the link to the candidate. They enter their details and press Start.
3. Each candidate gets a **different random set** of questions, with the answer options shuffled. The same question never appears twice in one test.
4. The timer is enforced by the server. When time runs out the test is **submitted automatically**, even if the candidate closed the browser. Late answers are refused.
5. On **Assessments → View**, HR sees every question with the answer the candidate chose (and the letter they saw on screen), the correct answer, and **Correct / Wrong / Not answered**, with totals at the top.
6. A link can be used only once. An unused link stops working at its expiry time, or whenever you press **Disable**.

### The LALCO IQ test

- The IQ bank and the General (recruitment) bank are separate. **IQ Test**, **General Test** and **Combined Assessment** links draw from them.
- An IQ link has **18 questions by default** (quick choices 10 / 15 / 18 / 20 / 30, or any number).
- Every IQ question has a **level**, and the level alone sets its marks: **Level 1 — Easy = 1 mark**, **Level 2 — Medium = 2 marks**, **Level 3 — Hard = 3 marks** (a Marks value in an imported file is ignored for IQ; no level given = Level 2).
- Questions are split evenly across the levels and shown Level 1 first, then 2, then 3, random within each level: 18 → 6 / 6 / 6 (maximum 36 marks), 10 → 3 / 3 / 4, 15 → 5 / 5 / 5, 20 → 7 / 6 / 7, 30 → 10 / 10 / 10. Candidates never see the level or the marks.
- The **IQ Test Score** is the weighted marks, e.g. **21 / 36 (58.3%)**. Correct answers (e.g. 11 / 18) and each level's correct answers and marks are shown next to it on Results, the candidate page, the review page, the dashboard and the PDF / Word / Excel exports. It is a test score, not a clinical IQ; no IQ-number conversion is applied.
- **Original LALCO IQ bank:** 45 original questions (15 Easy, 15 Medium, 15 Hard) covering number patterns, sequences, visual patterns and matrices, odd one out, logical relationships, spatial reasoning (rotation, reflection), mathematical reasoning and abstract patterns. The pictures are drawn by `scripts/lalco-iq-bank.js`, which also loads the bank: `node scripts/lalco-iq-bank.js https://your-site <admin-password>` (running it twice adds nothing). `node scripts/lalco-iq-bank.js --preview <folder>` writes the pictures to a folder for checking.

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
npm test                                       # 65 tests, uses temporary databases
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

**Database tables:** `admins`, `settings`, `candidates` (incl. interview and final decision), `questions`, `assessments` (link, timer and scores), `assessment_questions` (each candidate's questions, copied from the bank so later edits never change a past result), `images` (question and option pictures).

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
