/** Admin dashboard API: /api/v1/admin/* */
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { q, one, tx } = require('../db');
const { ah, ok, parse, pagination, pageMeta, newId, z } = require('../lib/util');
const { badRequest, unauthorized, notFound, conflict } = require('../lib/errors');
const { requireAdmin, issueTokens, rotateRefresh, revokeRefresh, hashPassword, verifyPassword, ADMIN_ROLES, ROLE_PERMISSIONS } = require('../lib/auth');
const events = require('../services/events');
const users = require('../services/users');
const finance = require('../services/finance');
const reports = require('../services/reports');
const ledger = require('../services/ledger');
const settingsSvc = require('../services/settings');
const { adminAudit } = require('../services/audit');

const r = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
    ? cb(null, true) : cb(badRequest('invalid_image', 'Images must be JPEG, PNG or WebP'))),
});

const adminView = (a) => ({ id: a.id, name: a.name, email: a.email, role: a.role, status: a.status, permissions: ROLE_PERMISSIONS[a.role], lastLoginAt: a.last_login_at, createdAt: a.created_at });

// ------------------------------------------------------------------ auth
r.post('/auth/login', loginLimiter, ah(async (req, res) => {
  const input = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }), req.body);
  const admin = await one('SELECT * FROM admins WHERE email=?', [input.email]);
  if (!admin || !(await verifyPassword(input.password, admin.password_hash))) throw unauthorized('invalid_credentials', 'Email or password is incorrect');
  if (admin.status !== 'active') throw unauthorized('admin_disabled', 'This admin account is disabled');
  await q('UPDATE admins SET last_login_at=UTC_TIMESTAMP(3) WHERE id=?', [admin.id]);
  req.admin = admin;
  await adminAudit(null, req, 'admin_login', 'admin', admin.id);
  ok(res, { admin: adminView(admin), tokens: await issueTokens('admin', admin) });
}));

r.post('/auth/refresh', ah(async (req, res) => {
  const adminId = await rotateRefresh('admin', req.body?.refreshToken);
  const admin = await one('SELECT * FROM admins WHERE id=?', [adminId]);
  if (!admin || admin.status !== 'active') throw unauthorized('admin_disabled', 'This admin account is disabled');
  ok(res, { admin: adminView(admin), tokens: await issueTokens('admin', admin) });
}));

r.post('/auth/logout', ah(async (req, res) => { await revokeRefresh(req.body?.refreshToken); ok(res, { ok: true }); }));

r.get('/auth/me', requireAdmin(), ah(async (req, res) => ok(res, adminView(await one('SELECT * FROM admins WHERE id=?', [req.admin.id])))));

r.post('/auth/change-password', requireAdmin(), ah(async (req, res) => {
  const input = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10, 'must be at least 10 characters').max(200) }), req.body);
  const a = await one('SELECT password_hash FROM admins WHERE id=?', [req.admin.id]);
  if (!(await verifyPassword(input.currentPassword, a.password_hash))) throw badRequest('wrong_password', 'Current password is incorrect');
  await q('UPDATE admins SET password_hash=? WHERE id=?', [await hashPassword(input.newPassword), req.admin.id]);
  await q("UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE subject_type='admin' AND subject_id=? AND revoked_at IS NULL", [req.admin.id]);
  await adminAudit(null, req, 'admin_password_changed', 'admin', req.admin.id);
  ok(res, { ok: true });
}));

// ------------------------------------------------------------------ dashboard
r.get('/dashboard', requireAdmin('dashboard:read'), ah(async (req, res) => ok(res, await reports.dashboard())));

// ------------------------------------------------------------------ events
r.get('/events', requireAdmin('events:read'), ah(async (req, res) => {
  const p = pagination(req.query);
  const { items, total } = await events.listEventsAdmin({ status: req.query.status, q: req.query.q }, p);
  ok(res, items, pageMeta(p, total));
}));
r.post('/events', requireAdmin('events:write'), ah(async (req, res) => ok(res, await events.createEvent(req, req.body), null, 201)));
r.get('/events/:id', requireAdmin('events:read'), ah(async (req, res) => ok(res, await events.getEventAdmin(req.params.id))));
r.patch('/events/:id', requireAdmin('events:write'), ah(async (req, res) => ok(res, await events.updateEvent(req, req.params.id, req.body))));
for (const action of ['publish', 'pause', 'resume', 'cancel']) {
  r.post(`/events/:id/${action}`, requireAdmin('events:write'), ah(async (req, res) => ok(res, await events.changeStatus(req, req.params.id, action, req.body))));
}
r.post('/events/:id/images', requireAdmin('events:write'), upload.array('images', 10), ah(async (req, res) => {
  if (!req.files?.length) throw badRequest('no_images', 'Attach at least one image in the "images" field');
  ok(res, await events.addImages(req, req.params.id, req.files), null, 201);
}));
r.delete('/events/:id/images/:imageId', requireAdmin('events:write'), ah(async (req, res) => {
  await events.deleteImage(req, req.params.id, req.params.imageId);
  ok(res, { ok: true });
}));

// ------------------------------------------------------------------ users
r.get('/users', requireAdmin('users:read'), ah(async (req, res) => {
  const p = pagination(req.query);
  const { items, total } = await users.listUsersAdmin(req.query, p);
  ok(res, items, pageMeta(p, total));
}));
r.get('/users/:id', requireAdmin('users:read'), ah(async (req, res) => ok(res, await users.getUserAdmin(req.params.id))));
for (const action of ['suspend', 'reactivate', 'flag', 'unflag']) {
  r.post(`/users/:id/${action}`, requireAdmin('users:write'), ah(async (req, res) => ok(res, await users.setUserStatus(req, req.params.id, action, req.body))));
}

// ------------------------------------------------------------------ finance
r.get('/finance/summary', requireAdmin('finance:read'), ah(async (req, res) => ok(res, await reports.financeSummary())));
r.post('/finance/fund', requireAdmin('funds:write'), ah(async (req, res) => {
  const result = await finance.fundPlatform(req, req.body, req.get('Idempotency-Key'));
  ok(res, result, null, result.duplicate ? 200 : 201);
}));
r.get('/finance/reconciliation', requireAdmin('finance:read'), ah(async (req, res) => ok(res, await ledger.reconcile())));
r.get('/transactions', requireAdmin('finance:read'), ah(async (req, res) => {
  const p = pagination(req.query);
  const { items, total, sumCents } = await reports.listTransactions(req.query, p);
  ok(res, items, { ...pageMeta(p, total), sumCents });
}));

// ------------------------------------------------------------------ withdrawals
r.get('/withdrawals', requireAdmin('withdrawals:read'), ah(async (req, res) => {
  const p = pagination(req.query);
  const { items, total, summary } = await reports.listWithdrawals(req.query, p);
  ok(res, items, { ...pageMeta(p, total), summary });
}));
r.get('/withdrawals/:id', requireAdmin('withdrawals:read'), ah(async (req, res) => ok(res, await reports.getWithdrawal(req.params.id))));
r.post('/withdrawals/:id/approve', requireAdmin('withdrawals:review'), ah(async (req, res) => ok(res, await finance.reviewWithdrawal(req, req.params.id, 'approve', req.body?.note))));
r.post('/withdrawals/:id/reject', requireAdmin('withdrawals:review'), ah(async (req, res) => {
  if (!String(req.body?.note || '').trim()) throw badRequest('reason_required', 'Please give a reason for rejecting this withdrawal');
  ok(res, await finance.reviewWithdrawal(req, req.params.id, 'reject', req.body.note));
}));

// ------------------------------------------------------------------ donations
r.get('/donations', requireAdmin('donations:read'), ah(async (req, res) => {
  const p = pagination(req.query);
  const { items, total, summary, topDonors } = await reports.donationsReport(req.query, p);
  ok(res, { summary, topDonors, donations: items }, pageMeta(p, total));
}));

// ------------------------------------------------------------------ settings
r.get('/settings', requireAdmin('settings:read'), ah(async (req, res) => ok(res, { values: await settingsSvc.getSettings(), definitions: settingsSvc.DEFINITIONS })));
r.put('/settings', requireAdmin('settings:write'), ah(async (req, res) => {
  await tx(async (conn) => {
    const applied = await settingsSvc.updateSettings(conn, req.body, req.admin.id);
    await adminAudit(conn, req, 'settings_updated', 'settings', null, applied);
  });
  ok(res, { values: await settingsSvc.getSettings(), definitions: settingsSvc.DEFINITIONS });
}));

// ------------------------------------------------------------------ audit log
r.get('/audit-logs', requireAdmin('audit:read'), ah(async (req, res) => {
  const p = pagination(req.query);
  const { items, total } = await reports.auditLogs(req.query, p);
  ok(res, items, pageMeta(p, total));
}));

// ------------------------------------------------------------------ admin accounts (super admin)
r.get('/admins', requireAdmin('admins:manage'), ah(async (req, res) => ok(res, (await q('SELECT * FROM admins ORDER BY created_at')).map(adminView))));
r.post('/admins', requireAdmin('admins:manage'), ah(async (req, res) => {
  const input = parse(z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email(), password: z.string().min(10).max(200), role: z.enum(ADMIN_ROLES) }), req.body);
  if (await one('SELECT id FROM admins WHERE email=?', [input.email])) throw conflict('email_taken', 'An admin with this email already exists');
  const id = newId('adm');
  await q('INSERT INTO admins (id, name, email, password_hash, role) VALUES (?,?,?,?,?)', [id, input.name, input.email, await hashPassword(input.password), input.role]);
  await adminAudit(null, req, 'admin_created', 'admin', id, { email: input.email, role: input.role });
  ok(res, adminView(await one('SELECT * FROM admins WHERE id=?', [id])), null, 201);
}));
r.patch('/admins/:id', requireAdmin('admins:manage'), ah(async (req, res) => {
  const input = parse(z.object({ role: z.enum(ADMIN_ROLES).optional(), status: z.enum(['active', 'disabled']).optional(), name: z.string().trim().min(1).max(120).optional() }), req.body);
  const a = await one('SELECT * FROM admins WHERE id=?', [req.params.id]);
  if (!a) throw notFound('admin');
  if (a.id === req.admin.id && (input.status === 'disabled' || (input.role && input.role !== 'super_admin'))) throw conflict('self_lockout', 'You cannot disable or demote your own account');
  await q('UPDATE admins SET role=COALESCE(?,role), status=COALESCE(?,status), name=COALESCE(?,name) WHERE id=?', [input.role || null, input.status || null, input.name || null, a.id]);
  if (input.status === 'disabled') await q("UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE subject_type='admin' AND subject_id=? AND revoked_at IS NULL", [a.id]);
  await adminAudit(null, req, 'admin_updated', 'admin', a.id, input);
  ok(res, adminView(await one('SELECT * FROM admins WHERE id=?', [a.id])));
}));

module.exports = r;
