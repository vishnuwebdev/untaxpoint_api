const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

const config = {
  env: env.NODE_ENV || 'development',
  port: int(env.PORT, 3000),
  publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/$/, ''),
  corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: int(env.DB_PORT, 3306),
    database: env.DB_NAME || 'untaxpoint',
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
  },
  jwt: {
    secret: env.JWT_SECRET || 'dev-only-change-me-untaxpoint-secret',
    accessTtl: env.ACCESS_TOKEN_TTL || '15m',
    refreshDays: int(env.REFRESH_TOKEN_DAYS, 30),
  },
  uploadDir: path.resolve(__dirname, '..', env.UPLOAD_DIR || 'uploads'),
  paymentProvider: env.PAYMENT_PROVIDER || 'mock',
  jobIntervalSeconds: int(env.JOB_INTERVAL_SECONDS, 60),
  jobsEnabled: env.JOBS_ENABLED !== 'false',
  // 'mock' trusts the email sent by the app for Google/Apple sign-in (local testing only).
  socialAuthMode: env.SOCIAL_AUTH_MODE || 'mock',
  // In development, verification/reset codes are returned in the API response (no email service yet).
  exposeDevCodes: env.EXPOSE_DEV_CODES ? env.EXPOSE_DEV_CODES === 'true' : (env.NODE_ENV || 'development') !== 'production',
  inviteBaseUrl: (env.INVITE_BASE_URL || 'https://untaxpoint.app/invite').replace(/\/$/, ''),
  appVersion: env.APP_VERSION || '1.0.0',
};

if (config.env === 'production' && config.socialAuthMode === 'mock') {
  throw new Error('SOCIAL_AUTH_MODE=mock is not allowed in production');
}
if (config.env === 'production' && !env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = config;
