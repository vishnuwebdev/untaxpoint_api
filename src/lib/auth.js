const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { q, one } = require('../db');
const { unauthorized, forbidden } = require('./errors');
const { newId, sha256 } = require('./util');

const hashPassword = (pw) => bcrypt.hash(pw, 12);
const verifyPassword = (pw, hash) => (hash ? bcrypt.compare(pw, hash) : Promise.resolve(false));

/** Role -> permissions. super_admin has everything. */
const ROLE_PERMISSIONS = {
  super_admin: ['*'],
  finance_admin: ['dashboard:read', 'events:read', 'users:read', 'finance:read', 'funds:write', 'withdrawals:read', 'withdrawals:review', 'donations:read', 'audit:read'],
  event_admin: ['dashboard:read', 'events:read', 'events:write', 'users:read', 'settings:read'],
  support: ['dashboard:read', 'events:read', 'users:read', 'users:write', 'withdrawals:read', 'donations:read'],
};
const ADMIN_ROLES = Object.keys(ROLE_PERMISSIONS);
const can = (role, perm) => {
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes('*') || perms.includes(perm);
};

async function issueTokens(subjectType, subject) {
  const accessToken = jwt.sign(
    { sub: subject.id, typ: subjectType, ...(subject.role ? { role: subject.role } : {}) },
    config.jwt.secret,
    { expiresIn: config.jwt.accessTtl },
  );
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const expires = new Date(Date.now() + config.jwt.refreshDays * 86400000);
  await q('INSERT INTO refresh_tokens (id, subject_type, subject_id, token_hash, expires_at) VALUES (?,?,?,?,?)',
    [newId('rt'), subjectType, subject.id, sha256(refreshToken), expires]);
  return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: config.jwt.accessTtl };
}

/** Rotate a refresh token: the old one is revoked, a new pair is returned. */
async function rotateRefresh(subjectType, token) {
  const row = await one('SELECT * FROM refresh_tokens WHERE token_hash=? AND subject_type=?', [sha256(String(token || '')), subjectType]);
  if (!row || row.revoked_at || row.expires_at < new Date()) throw unauthorized('refresh_invalid', 'Session expired, please log in again');
  await q('UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?', [row.id]);
  return row.subject_id;
}

async function revokeRefresh(token) {
  await q('UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE token_hash=? AND revoked_at IS NULL', [sha256(String(token || ''))]);
}

function readToken(req, expectedType) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw unauthorized();
  let payload;
  try { payload = jwt.verify(token, config.jwt.secret); } catch { throw unauthorized('token_invalid', 'Session expired, please log in again'); }
  if (payload.typ !== expectedType) throw unauthorized('token_invalid', 'Wrong token type');
  return payload;
}

/** Middleware: authenticated admin with the given permission. Loads req.admin. */
const requireAdmin = (perm) => async (req, res, next) => {
  try {
    const p = readToken(req, 'admin');
    const admin = await one('SELECT id, name, email, role, status FROM admins WHERE id=?', [p.sub]);
    if (!admin || admin.status !== 'active') throw unauthorized('admin_disabled', 'Admin account is disabled');
    if (perm && !can(admin.role, perm)) throw forbidden();
    req.admin = admin;
    next();
  } catch (e) { next(e); }
};

/** Middleware: authenticated member. Loads req.user. */
const requireUser = async (req, res, next) => {
  try {
    const p = readToken(req, 'user');
    const user = await one('SELECT id, full_name, email, status, is_flagged FROM users WHERE id=?', [p.sub]);
    if (!user || user.status === 'deleted') throw unauthorized('user_not_found', 'Account not found');
    if (user.status === 'suspended') throw forbidden('account_suspended', 'Your account is suspended');
    req.user = user;
    next();
  } catch (e) { next(e); }
};

module.exports = { hashPassword, verifyPassword, issueTokens, rotateRefresh, revokeRefresh, requireAdmin, requireUser, can, ROLE_PERMISSIONS, ADMIN_ROLES };
