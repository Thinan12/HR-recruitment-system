// Admin login. Passwords are bcrypt hashes; a signed JWT is kept in an
// httpOnly, SameSite=Strict cookie so page scripts can never read it.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, now } = require('./db');

const COOKIE = 'hr_session';
const SESSION_HOURS = 12;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (IS_PRODUCTION) throw new Error('JWT_SECRET must be set (at least 32 characters) in production.');
  // Development only: sessions reset on every restart.
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
}

// Creates the first admin from ADMIN_USERNAME / ADMIN_PASSWORD when the
// admins table is empty. Later changes are made from the Settings page.
function ensureFirstAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (count > 0) return;
  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (password.length < 8) {
    console.warn('No admin account exists. Set ADMIN_PASSWORD (8+ characters) and restart to create one.');
    return;
  }
  db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, bcrypt.hashSync(password, 12), now());
  console.log(`Created admin account "${username}".`);
}

// Simple in-memory limit: 10 failed logins per IP per 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function tooManyFailures(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) return false;
  return entry.count >= 10;
}
function recordFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PRODUCTION,
    maxAge: SESSION_HOURS * 3600 * 1000,
    path: '/',
  });
}

function login(req, res) {
  const ip = req.ip;
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many failed attempts. Please wait 15 minutes.' });
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const admin = username ? db.prepare('SELECT * FROM admins WHERE username = ?').get(username) : null;
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  failures.delete(ip);
  const token = jwt.sign({ sub: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
  setSessionCookie(res, token);
  res.json({ username: admin.username });
}

function logout(req, res) {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}

function requireAdmin(req, res, next) {
  const token = readCookie(req, COOKIE);
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const admin = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(payload.sub);
    if (!admin) return res.status(401).json({ error: 'Please log in.' });
    req.admin = admin;
    next();
  } catch {
    return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
  }
}

function changePassword(req, res) {
  const current = String(req.body?.current_password || '');
  const next = String(req.body?.new_password || '');
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
  if (!bcrypt.compareSync(current, admin.password_hash)) return res.status(400).json({ error: 'Current password is incorrect.' });
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 12), admin.id);
  res.json({ ok: true });
}

module.exports = { ensureFirstAdmin, login, logout, requireAdmin, changePassword };
