// Question and answer pictures, stored in the database next to the questions.
const crypto = require('crypto');
const { db, now } = require('./db');

const MAX_BYTES = 2 * 1024 * 1024;

// Only raster formats, identified by their first bytes (never by file name).
// SVG is refused because it can contain scripts.
function detectMime(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

class ImageError extends Error {}

// Saves a picture and returns its id. The same picture uploaded twice is stored once.
function saveImage(buf) {
  if (!buf || buf.length === 0) throw new ImageError('The picture is empty.');
  if (buf.length > MAX_BYTES) throw new ImageError('The picture is larger than 2 MB.');
  const mime = detectMime(buf);
  if (!mime) throw new ImageError('Please use a PNG, JPG, GIF or WebP picture.');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const existing = db.prepare('SELECT id FROM images WHERE sha256 = ?').get(sha256);
  if (existing) return existing.id;
  return Number(db.prepare('INSERT INTO images (mime, sha256, data, created_at) VALUES (?, ?, ?, ?)').run(mime, sha256, buf, now()).lastInsertRowid);
}

// Accepts "data:image/png;base64,...." as sent by the admin page.
function saveDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:[\w/+.-]+;base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) throw new ImageError('Please use a PNG, JPG, GIF or WebP picture.');
  return saveImage(Buffer.from(m[1], 'base64'));
}

function imageExists(id) {
  return !!db.prepare('SELECT 1 FROM images WHERE id = ?').get(id);
}

function sendImage(res, id) {
  const img = db.prepare('SELECT mime, data FROM images WHERE id = ?').get(id);
  if (!img) return res.status(404).json({ error: 'Not found.' });
  res.set('Content-Type', img.mime);
  res.set('Cache-Control', 'private, max-age=86400, immutable'); // an id always points to the same picture
  res.set('Content-Disposition', 'inline');
  res.send(img.data);
}

module.exports = { saveImage, saveDataUrl, imageExists, sendImage, ImageError, detectMime };
