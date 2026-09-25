const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { db } = require('./db');
const { InputError } = require('./assessments');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PUBLIC = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', 1); // Railway sits in front of the app
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
    },
  },
  hsts: IS_PRODUCTION ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

// Redirect plain HTTP to HTTPS in production (the health check is exempt so
// Railway can reach it directly).
if (IS_PRODUCTION) {
  app.use((req, res, next) => {
    if (req.path === '/api/health' || req.secure) return next();
    if (req.method === 'GET') return res.redirect(308, 'https://' + req.get('host') + req.originalUrl);
    return res.status(403).json({ error: 'HTTPS is required.' });
  });
}

app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.use('/api/admin', require('./routes/admin'));
app.use('/api/exam', require('./routes/exam'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Pages
app.use('/static', express.static(path.join(PUBLIC, 'static'), { maxAge: IS_PRODUCTION ? '1h' : 0 }));
app.get('/exam/:token', (req, res) => res.sendFile(path.join(PUBLIC, 'exam.html')));
app.get(['/', '/admin', '/admin/*'], (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));

// Never show raw errors to users.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof InputError) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
