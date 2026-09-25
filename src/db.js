// SQLite database: one file, opened once. On Railway the file lives on the
// mounted volume (DATABASE_PATH=/data/hr.db) so data survives redeploys.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'hr.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per person. Education comes from the candidate form; the interview
-- and final-decision fields are entered by HR.
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  graduate_from TEXT NOT NULL DEFAULT '',
  high_school TEXT NOT NULL DEFAULT '',
  college TEXT NOT NULL DEFAULT '',
  university TEXT NOT NULL DEFAULT '',
  school_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  gpa TEXT NOT NULL DEFAULT '',
  reference_results TEXT NOT NULL DEFAULT '',
  character_note TEXT NOT NULL DEFAULT '',
  interview TEXT NOT NULL DEFAULT '',
  interviewer TEXT NOT NULL DEFAULT '',
  interview_score REAL,
  remark TEXT NOT NULL DEFAULT '',
  chairman_interview TEXT NOT NULL DEFAULT '',
  final_result TEXT NOT NULL DEFAULT 'Pending',
  date_come_to_work TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- section: IQ | GENERAL | CALCULATION | ESSAY
-- correct_answer: a letter A-D for multiple choice, the expected text for a
-- short-answer calculation question, optional guidance for essays.
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  section TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT '',
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL DEFAULT '',
  option_b TEXT NOT NULL DEFAULT '',
  option_c TEXT NOT NULL DEFAULT '',
  option_d TEXT NOT NULL DEFAULT '',
  correct_answer TEXT NOT NULL DEFAULT '',
  marks REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_section ON questions(section, status);

-- One generated link. sections holds how many questions to draw per section,
-- e.g. {"IQ":20,"CALCULATION":5}. Scores are written when it is submitted.
CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
  assessment_type TEXT NOT NULL,
  sections TEXT NOT NULL,
  time_limit_minutes INTEGER NOT NULL,
  link_expiry_minutes INTEGER NOT NULL,
  link_expires_at TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  started_at TEXT,
  deadline_at TEXT,
  submitted_at TEXT,
  auto_submitted INTEGER NOT NULL DEFAULT 0,
  focus_losses INTEGER NOT NULL DEFAULT 0,
  iq_points REAL, iq_max REAL,
  general_points REAL, general_max REAL,
  calc_points REAL, calc_max REAL,
  essay_points REAL, essay_max REAL,
  essay_pending INTEGER NOT NULL DEFAULT 0,
  total_points REAL, total_max REAL,
  test_score REAL,
  result TEXT NOT NULL DEFAULT 'Pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assessments_candidate ON assessments(candidate_id);
CREATE INDEX IF NOT EXISTS idx_assessments_status ON assessments(status);

-- The questions one candidate received, copied from the bank at start time so
-- later edits or deletions in the bank never change a past result.
-- option_order is the shuffled order of the original letters, e.g. ["C","A","D","B"].
CREATE TABLE IF NOT EXISTS assessment_questions (
  id INTEGER PRIMARY KEY,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  position INTEGER NOT NULL,
  section TEXT NOT NULL,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL DEFAULT '',
  option_b TEXT NOT NULL DEFAULT '',
  option_c TEXT NOT NULL DEFAULT '',
  option_d TEXT NOT NULL DEFAULT '',
  correct_answer TEXT NOT NULL DEFAULT '',
  option_order TEXT NOT NULL DEFAULT '[]',
  max_marks REAL NOT NULL,
  answer TEXT,
  marks_awarded REAL,
  UNIQUE (assessment_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_aq_assessment ON assessment_questions(assessment_id, position);
`);

const DEFAULT_SETTINGS = {
  default_time_minutes: '30',
  default_link_expiry_minutes: '1440',
  pass_mark: '60',
  default_language: 'en',
};

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return {
    default_time_minutes: Number(out.default_time_minutes),
    default_link_expiry_minutes: Number(out.default_link_expiry_minutes),
    pass_mark: Number(out.pass_mark),
    default_language: out.default_language,
  };
}

function saveSettings(values) {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) upsert.run(key, String(value));
  })();
}

const now = () => new Date().toISOString();

module.exports = { db, getSettings, saveSettings, now, DB_PATH };
