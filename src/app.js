const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const { pool } = require('./db');
const { AppError } = require('./lib/errors');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins, allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'] }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d', fallthrough: false }));

  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, database: 'connected', paymentProvider: config.paymentProvider, time: new Date() });
    } catch (e) {
      res.status(503).json({ ok: false, database: 'unavailable', error: e.code });
    }
  });

  app.use('/api/v1/admin', require('./routes/admin'));
  app.use('/api/v1', require('./routes/app'));

  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } }));

  // Centralized error handler: consistent { error: { code, message, details } } bodies.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    if (err.name === 'MulterError') return res.status(400).json({ error: { code: 'upload_failed', message: err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 5 MB or smaller' : err.message } });
    if (err.code && /^(ECONNREFUSED|PROTOCOL_|ER_ACCESS_DENIED|ER_BAD_DB)/.test(err.code)) {
      console.error('database unavailable:', err.code, err.message);
      return res.status(503).json({ error: { code: 'database_unavailable', message: 'Database is not reachable' } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });
  return app;
}

module.exports = { createApp };
