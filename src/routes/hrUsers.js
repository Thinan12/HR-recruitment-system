// HR users (mounted at /api/admin/users; full admins only). Adds view-only HR
// logins (role 'viewer': see every candidate, exam and report, change nothing),
// Candidates-dashboard-only logins (role 'dashboard', HR_DASHBOARD_ONLY: only
// the candidate results table and its two Excel exports), or more full admins. Passwords are bcrypt hashes and are never shown again.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, now } = require('../db');
const auth = require('../auth');

const router = express.Router();
router.use(auth.requireFullAdmin);

const bad = (res, message) => res.status(400).json({ error: message });
const notFound = (res) => res.status(404).json({ error: 'Not found.' });
const ROLES = { viewer: 'View only', dashboard: 'Candidates dashboard only', admin: 'Full admin' };
// Role names accepted from the page or the API (HR_DASHBOARD_ONLY = 'dashboard').
const roleOf = (r) => ({ admin: 'admin', viewer: 'viewer', dashboard: 'dashboard', HR_DASHBOARD_ONLY: 'dashboard' }[String(r || '')] || 'viewer');
const audit = (action, admin, details) => db.prepare('INSERT INTO audit_log (action, admin, details, created_at) VALUES (?, ?, ?, ?)').run(action, admin, JSON.stringify(details), now());
const view = (a) => ({ id: a.id, username: a.username, role: a.role || 'admin', role_label: ROLES[a.role || 'admin'], active: a.active !== 0,
  created_at: a.created_at, created_by: a.created_by || '', last_login_at: a.last_login_at || null });
const byId = (id) => db.prepare('SELECT * FROM admins WHERE id = ?').get(Number(id));
const activeFullAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM admins WHERE COALESCE(role, 'admin') = 'admin' AND active = 1").get().n;
const checkPassword = (p) => (String(p || '').length < 8 ? 'Password must be at least 8 characters.' : String(p).length > 200 ? 'Password is too long.' : null);

router.get('/', (req, res) => res.json(db.prepare('SELECT * FROM admins ORDER BY id').all().map(view)));

router.post('/', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const role = roleOf(req.body?.role);
  if (!/^[A-Za-z0-9._@-]{3,50}$/.test(username)) return bad(res, 'Username: 3-50 characters, letters, numbers and . _ @ - only.');
  const pwError = checkPassword(req.body?.password);
  if (pwError) return bad(res, pwError);
  if (db.prepare('SELECT 1 FROM admins WHERE username = ?').get(username)) return bad(res, 'That username is already used.');
  const id = db.prepare('INSERT INTO admins (username, password_hash, role, active, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run(username, bcrypt.hashSync(String(req.body.password), 12), role, req.admin.username, now()).lastInsertRowid;
  audit('HR_USER_CREATED', req.admin.username, { id, username, role });
  res.status(201).json(view(byId(id)));
});

// Disable / enable. A disabled user cannot log in and open sessions end at once.
// You cannot disable yourself, or the last active full admin.
router.post('/:id/:action(enable|disable)', (req, res) => {
  const u = byId(req.params.id);
  if (!u) return notFound(res);
  const enable = req.params.action === 'enable';
  if (!enable && u.id === req.admin.id) return bad(res, 'You cannot disable your own account.');
  if (!enable && (u.role || 'admin') === 'admin' && u.active !== 0 && activeFullAdmins() <= 1) return bad(res, 'The last active full admin cannot be disabled.');
  db.prepare('UPDATE admins SET active = ?, token_version = token_version + 1 WHERE id = ?').run(enable ? 1 : 0, u.id);
  audit(enable ? 'HR_USER_ENABLED' : 'HR_USER_DISABLED', req.admin.username, { id: u.id, username: u.username });
  res.json(view(byId(u.id)));
});

// A new password set by a full admin; the user's open sessions end.
router.post('/:id/password', (req, res) => {
  const u = byId(req.params.id);
  if (!u) return notFound(res);
  const pwError = checkPassword(req.body?.password);
  if (pwError) return bad(res, pwError);
  db.prepare('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(bcrypt.hashSync(String(req.body.password), 12), u.id);
  audit('HR_USER_PASSWORD_RESET', req.admin.username, { id: u.id, username: u.username });
  res.json(view(byId(u.id)));
});

// Removes the login only (nothing else belongs to an HR user).
router.delete('/:id', (req, res) => {
  const u = byId(req.params.id);
  if (!u) return notFound(res);
  if (u.id === req.admin.id) return bad(res, 'You cannot delete your own account.');
  if ((u.role || 'admin') === 'admin' && u.active !== 0 && activeFullAdmins() <= 1) return bad(res, 'The last active full admin cannot be deleted.');
  db.prepare('DELETE FROM admins WHERE id = ?').run(u.id);
  audit('HR_USER_DELETED', req.admin.username, { id: u.id, username: u.username });
  res.json({ ok: true });
});

module.exports = router;
