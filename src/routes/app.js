/** Mobile app API: /api/v1/* (members). */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ah, ok, parse, pagination, pageMeta, z } = require('../lib/util');
const { unauthorized } = require('../lib/errors');
const { requireUser, issueTokens, rotateRefresh, revokeRefresh } = require('../lib/auth');
const { one } = require('../db');
const users = require('../services/users');
const events = require('../services/events');
const participation = require('../services/participation');
const finance = require('../services/finance');
const accounts = require('../services/accounts');
const notifications = require('../services/notifications');
const multer = require('multer');
const { badRequest } = require('../lib/errors');

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
    ? cb(null, true) : cb(badRequest('invalid_image', 'Profile pictures must be JPEG, PNG or WebP'))),
});

const r = express.Router();
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
// Per-user limit on participation attempts (anti-abuse). Keyed by user after auth.
const participateLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });
const moneyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });

// ------------------------------------------------------------------ auth
r.post('/auth/register', authLimiter, ah(async (req, res) => ok(res, await users.register(req, req.body), null, 201)));
r.post('/auth/login', authLimiter, ah(async (req, res) => ok(res, await users.login(req, req.body))));
r.post('/auth/refresh', ah(async (req, res) => {
  const id = await rotateRefresh('user', req.body?.refreshToken);
  const user = await one('SELECT * FROM users WHERE id=?', [id]);
  if (!user || user.status !== 'active') throw unauthorized('account_unavailable', 'This account is not available');
  ok(res, { user: users.serializeUser(user), tokens: await issueTokens('user', user) });
}));
r.post('/auth/logout', ah(async (req, res) => { await revokeRefresh(req.body?.refreshToken); ok(res, { ok: true }); }));
r.post('/auth/social', authLimiter, ah(async (req, res) => {
  const result = await accounts.socialLogin(req, req.body);
  ok(res, result, null, result.created ? 201 : 200);
}));
r.post('/auth/forgot-password', authLimiter, ah(async (req, res) => ok(res, await accounts.forgotPassword(req, req.body))));
r.post('/auth/reset-password', authLimiter, ah(async (req, res) => ok(res, await accounts.resetPassword(req, req.body))));
r.post('/auth/verify-email', requireUser, ah(async (req, res) => ok(res, await accounts.verifyEmail(req, req.body))));
r.post('/auth/resend-verification', requireUser, authLimiter, ah(async (req, res) => ok(res, await accounts.resendVerification(req))));

// ------------------------------------------------------------------ app config (public)
r.get('/app/config', ah(async (req, res) => ok(res, await accounts.appConfig())));

// ------------------------------------------------------------------ profile
r.get('/me', requireUser, ah(async (req, res) => ok(res, await users.getMe(req.user.id))));
r.patch('/me', requireUser, ah(async (req, res) => ok(res, await users.updateMe(req.user.id, req.body))));
r.post('/me/password', requireUser, ah(async (req, res) => ok(res, await users.changePassword(req, req.body))));
r.post('/me/location', requireUser, ah(async (req, res) => ok(res, await users.updateLocation(req.user.id, req.body))));
r.get('/me/referrals', requireUser, ah(async (req, res) => ok(res, await users.myReferrals(req.user.id))));
r.post('/me/avatar', requireUser, avatarUpload.single('avatar'), ah(async (req, res) => ok(res, await accounts.setAvatar(req, req.file))));
r.delete('/me', requireUser, ah(async (req, res) => ok(res, await accounts.deleteAccount(req, req.body))));

// ------------------------------------------------------------------ notifications
r.get('/me/notifications', requireUser, ah(async (req, res) => {
  const p = pagination(req.query);
  const { items, total, unread } = await notifications.list(req.user.id, p);
  ok(res, items, { ...pageMeta(p, total), unread });
}));
r.get('/me/notifications/unread-count', requireUser, ah(async (req, res) => ok(res, { unread: await notifications.unreadCount(req.user.id) })));
r.post('/me/notifications/read-all', requireUser, ah(async (req, res) => ok(res, await notifications.markRead(req.user.id, 'all'))));
r.post('/me/notifications/:id/read', requireUser, ah(async (req, res) => ok(res, await notifications.markRead(req.user.id, Number(req.params.id) || 0))));

// ------------------------------------------------------------------ events
const listSchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(0.1).max(20000).optional(),
  filter: z.enum(['all', 'active', 'upcoming']).default('all'),
  q: z.string().trim().max(100).optional(),
});
r.get('/events', requireUser, ah(async (req, res) => ok(res, await events.listEventsForMember(parse(listSchema, req.query)))));
r.get('/events/:id', requireUser, ah(async (req, res) => ok(res, await events.getEventForMember(req.params.id, req.user.id))));
r.post('/events/:id/participate', requireUser, participateLimiter, ah(async (req, res) => ok(res, await participation.participate(req, req.params.id, req.body), null, 201)));
r.get('/me/participations', requireUser, ah(async (req, res) => {
  const p = pagination(req.query);
  const { items, total } = await participation.myParticipations(req.user.id, p);
  ok(res, items, pageMeta(p, total));
}));

// ------------------------------------------------------------------ wallet
r.get('/me/wallet', requireUser, ah(async (req, res) => ok(res, await finance.walletSummary(req.user.id))));
r.get('/me/transactions', requireUser, ah(async (req, res) => {
  const p = pagination(req.query);
  const { items, total } = await finance.userTransactions(req.user.id, p, req.query.kind);
  ok(res, items, pageMeta(p, total));
}));
r.get('/me/payout-account', requireUser, ah(async (req, res) => ok(res, await finance.getPayoutAccount(req.user.id))));
r.put('/me/payout-account', requireUser, ah(async (req, res) => ok(res, await finance.setPayoutAccount(req, req.body))));
r.post('/me/withdrawals', requireUser, moneyLimiter, ah(async (req, res) => ok(res, await finance.requestWithdrawal(req, req.body, req.get('Idempotency-Key')), null, 201)));
r.get('/me/withdrawals', requireUser, ah(async (req, res) => {
  const p = pagination(req.query);
  const { q } = require('../db');
  const [{ total }] = await q('SELECT COUNT(*) total FROM withdrawals WHERE user_id=?', [req.user.id]);
  const rows = await q('SELECT * FROM withdrawals WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?', [req.user.id, p.limit, p.offset]);
  ok(res, rows.map(finance.serializeWithdrawal), pageMeta(p, total));
}));
r.post('/me/donations', requireUser, moneyLimiter, ah(async (req, res) => ok(res, await finance.donate(req, req.body, req.get('Idempotency-Key')), null, 201)));
r.get('/me/donations', requireUser, ah(async (req, res) => {
  const p = pagination(req.query);
  const { items, total } = await finance.userTransactions(req.user.id, p, 'donation');
  ok(res, items, pageMeta(p, total));
}));

module.exports = r;
