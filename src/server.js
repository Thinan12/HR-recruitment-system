const app = require('./app');
const { ensureFirstAdmin } = require('./auth');
const { finalizeExpired, scoreAssessment } = require('./assessments');
const { db, DB_PATH } = require('./db');

ensureFirstAdmin();

// Results submitted before the IQ "correct / total" score existed get it now (once).
for (const { id } of db.prepare("SELECT id FROM assessments WHERE status = 'SUBMITTED' AND iq_max IS NOT NULL AND iq_total IS NULL").all()) scoreAssessment(id);

// Submit assessments whose time ran out while the candidate was away.
finalizeExpired();
setInterval(() => {
  try { finalizeExpired(); } catch (e) { console.error('Auto-submit sweep failed:', e.message); }
}, 30 * 1000).unref();

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`LALCO HR system listening on port ${PORT} (database: ${DB_PATH})`);
});
