const app = require('./app');
const { ensureFirstAdmin } = require('./auth');
const { finalizeExpired } = require('./assessments');
const { DB_PATH } = require('./db');

ensureFirstAdmin();

// Submit assessments whose time ran out while the candidate was away.
finalizeExpired();
setInterval(() => {
  try { finalizeExpired(); } catch (e) { console.error('Auto-submit sweep failed:', e.message); }
}, 30 * 1000).unref();

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`LALCO HR system listening on port ${PORT} (database: ${DB_PATH})`);
});
