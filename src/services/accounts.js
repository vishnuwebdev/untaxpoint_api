/**
 * Account flows for the mobile app: social sign-in, email verification, password reset,
 * profile picture and account deletion.
 */
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const { q, one, tx } = require('../db');
const { newId, parse, sha256, z } = require('../lib/util');
const { badRequest, conflict, forbidden, unauthorized, notFound } = require('../lib/errors');
const { hashPassword, issueTokens } = require('../lib/auth');
const { audit } = require('./audit');
const { notify } = require('./notifications');

const CODE_TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;

/** Create a 6-digit one-time code (older unused codes for the same purpose are invalidated). */
async function issueCode(userId, purpose) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await q('UPDATE verification_codes SET used_at=UTC_TIMESTAMP(3) WHERE user_id=? AND purpose=? AND used_at IS NULL', [userId, purpose]);
  await q('INSERT INTO verification_codes (id, user_id, purpose, code_hash, expires_at) VALUES (?,?,?,?, UTC_TIMESTAMP(3) + INTERVAL ? MINUTE)',
    [newId('vc'), userId, purpose, sha256(`${userId}:${code}`), CODE_TTL_MINUTES]);
  // TODO: send by email once an email provider is connected.
  return code;
}

async function consumeCode(conn, userId, purpose, code) {
  const row = await one(`SELECT * FROM verification_codes WHERE user_id=? AND purpose=? AND used_at IS NULL
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [userId, purpose], conn);
  if (!row || row.expires_at < new Date()) throw badRequest('code_expired', 'This code has expired. Please request a new one.');
  if (row.attempts >= MAX_ATTEMPTS) throw badRequest('code_locked', 'Too many wrong attempts. Please request a new code.');
  if (row.code_hash !== sha256(`${userId}:${String(code).trim()}`)) {
    await q('UPDATE verification_codes SET attempts=attempts+1 WHERE id=?', [row.id], conn);
    throw badRequest('code_invalid', 'That code is not correct');
  }
  await q('UPDATE verification_codes SET used_at=UTC_TIMESTAMP(3) WHERE id=?', [row.id], conn);
}

const devCode = (code) => (config.exposeDevCodes ? { devCode: code } : {});

// ------------------------------------------------------------------ social sign-in
const socialSchema = z.object({
  provider: z.enum(['google', 'apple']),
  // Real mode: the provider's ID token (verified server-side). Mock mode: ignored.
  idToken: z.string().max(5000).optional(),
  email: z.string().trim().toLowerCase().email().max(255),
  fullName: z.string().trim().max(160).optional(),
  referralCode: z.string().trim().toUpperCase().max(16).optional(),
});

async function socialLogin(req, body) {
  const input = parse(socialSchema, body);
  if (config.socialAuthMode !== 'mock') {
    // Real Google/Apple token verification is added when the provider credentials exist.
    throw badRequest('social_not_configured', `${input.provider === 'apple' ? 'Apple' : 'Google'} sign-in is not configured yet`);
  }
  const subject = `mock:${input.email}`;
  const users = require('./users');
  let user = await one('SELECT * FROM users WHERE email=?', [input.email]);
  let created = false;
  if (user) {
    if (user.status === 'deleted') throw unauthorized('account_deleted', 'This account was deleted');
    if (user.status === 'suspended') throw forbidden('account_suspended', 'Your account is suspended');
    if (!user.provider_subject && user.auth_provider === 'password') {
      // Existing email account: link the social login (a provider-verified email proves ownership).
      await q('UPDATE users SET provider_subject=COALESCE(provider_subject, ?), email_verified_at=COALESCE(email_verified_at, UTC_TIMESTAMP(3)) WHERE id=?', [subject, user.id]);
    }
  } else {
    let referredBy = null;
    if (input.referralCode) {
      const ref = await one('SELECT id FROM users WHERE referral_code=?', [input.referralCode]);
      if (ref) referredBy = ref.id;
    }
    const id = newId('usr');
    const name = input.fullName || input.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    await q(`INSERT INTO users (id, full_name, email, auth_provider, provider_subject, email_verified_at, referral_code, referred_by)
      VALUES (?,?,?,?,?,UTC_TIMESTAMP(3),?,?)`, [id, name, input.email, input.provider, subject, users.referralCode(), referredBy]);
    await audit(null, { actorType: 'user', actorId: id, action: 'user_registered', targetType: 'user', targetId: id, details: { provider: input.provider, referredBy }, ip: req.ip });
    await notify(null, id, { type: 'welcome', title: 'Welcome to UNTAXPOINT', body: 'Find live events near you, be among the first to enter, and win cash rewards.' });
    created = true;
  }
  user = await one('SELECT * FROM users WHERE email=?', [input.email]);
  return { user: users.serializeUser(user), tokens: await issueTokens('user', user), created };
}

// ------------------------------------------------------------------ email verification
async function resendVerification(req) {
  const u = await one('SELECT email_verified_at FROM users WHERE id=?', [req.user.id]);
  if (u.email_verified_at) return { alreadyVerified: true };
  return { sent: true, ...devCode(await issueCode(req.user.id, 'verify_email')) };
}

async function verifyEmail(req, body) {
  const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'must be 6 digits') }), body);
  await tx(async (conn) => {
    await consumeCode(conn, req.user.id, 'verify_email', code);
    await q('UPDATE users SET email_verified_at=UTC_TIMESTAMP(3) WHERE id=?', [req.user.id], conn);
  });
  return require('./users').getMe(req.user.id);
}

// ------------------------------------------------------------------ password reset
async function forgotPassword(req, body) {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), body);
  const user = await one("SELECT id, password_hash, auth_provider FROM users WHERE email=? AND status='active'", [email]);
  // Same answer whether or not the email exists (no account enumeration).
  const response = { sent: true, message: 'If an account exists for this email, a 6-digit code has been sent.' };
  if (!user) return response;
  const code = await issueCode(user.id, 'reset_password');
  await audit(null, { actorType: 'user', actorId: user.id, action: 'password_reset_requested', targetType: 'user', targetId: user.id, ip: req.ip });
  return { ...response, ...devCode(code) };
}

async function resetPassword(req, body) {
  const input = parse(z.object({
    email: z.string().trim().toLowerCase().email(),
    code: z.string().trim().regex(/^\d{6}$/, 'must be 6 digits'),
    newPassword: z.string().min(8, 'must be at least 8 characters').max(200),
  }), body);
  const user = await one("SELECT * FROM users WHERE email=? AND status='active'", [input.email]);
  if (!user) throw badRequest('code_invalid', 'That code is not correct');
  await tx(async (conn) => {
    await consumeCode(conn, user.id, 'reset_password', input.code);
    await q('UPDATE users SET password_hash=?, email_verified_at=COALESCE(email_verified_at, UTC_TIMESTAMP(3)) WHERE id=?', [await hashPassword(input.newPassword), user.id], conn);
    await q("UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE subject_type='user' AND subject_id=? AND revoked_at IS NULL", [user.id], conn);
    await notify(conn, user.id, { type: 'security', title: 'Your password was changed', body: 'If this was not you, contact support right away.' });
  });
  await audit(null, { actorType: 'user', actorId: user.id, action: 'password_reset', targetType: 'user', targetId: user.id, ip: req.ip });
  const fresh = await one('SELECT * FROM users WHERE id=?', [user.id]);
  return { user: require('./users').serializeUser(fresh), tokens: await issueTokens('user', fresh) };
}

// ------------------------------------------------------------------ profile picture
async function setAvatar(req, file) {
  if (!file) throw badRequest('no_image', 'Attach an image in the "avatar" field');
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype];
  const dir = path.join(config.uploadDir, 'avatars');
  await fs.mkdir(dir, { recursive: true });
  const name = `${req.user.id}-${Date.now()}${ext}`;
  await fs.writeFile(path.join(dir, name), file.buffer);
  const old = await one('SELECT avatar_url FROM users WHERE id=?', [req.user.id]);
  await q('UPDATE users SET avatar_url=? WHERE id=?', [`/uploads/avatars/${name}`, req.user.id]);
  if (old?.avatar_url?.startsWith('/uploads/avatars/')) await fs.rm(path.join(dir, path.basename(old.avatar_url)), { force: true });
  return require('./users').getMe(req.user.id);
}

// ------------------------------------------------------------------ account deletion
async function deleteAccount(req, body) {
  const { confirm } = parse(z.object({ confirm: z.literal('DELETE', { errorMap: () => ({ message: 'type DELETE to confirm' }) }) }), body);
  void confirm;
  return tx(async (conn) => {
    const u = await one('SELECT * FROM users WHERE id=? FOR UPDATE', [req.user.id], conn);
    if (!u) throw notFound('user');
    if (u.wallet_cents > 0) throw conflict('wallet_not_empty', 'Please withdraw or donate your wallet balance before deleting your account');
    const pending = await one("SELECT COUNT(*) n FROM withdrawals WHERE user_id=? AND status IN ('requested','processing','pending','on_hold')", [u.id], conn);
    if (pending.n > 0) throw conflict('withdrawal_pending', 'Please wait until your withdrawal is finished before deleting your account');
    // Keep the row (ledger history references it) but remove personal data.
    await q(`UPDATE users SET status='deleted', full_name='Deleted member', email=?, phone=NULL, avatar_url=NULL, password_hash=NULL,
      provider_subject=NULL, last_latitude=NULL, last_longitude=NULL, last_location_at=NULL WHERE id=?`, [`deleted+${u.id}@untaxpoint.invalid`, u.id], conn);
    await q('DELETE FROM user_payout_accounts WHERE user_id=?', [u.id], conn);
    await q('DELETE FROM device_tokens WHERE user_id=?', [u.id], conn); // no more push to this account
    await q("UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE subject_type='user' AND subject_id=? AND revoked_at IS NULL", [u.id], conn);
    await audit(conn, { actorType: 'user', actorId: u.id, action: 'account_deleted', targetType: 'user', targetId: u.id, ip: req.ip });
    return { deleted: true };
  });
}

/** Values the app needs at start-up. */
async function appConfig() {
  const { getSettings } = require('./settings');
  const s = await getSettings();
  return {
    appVersion: config.appVersion,
    currency: s.currency || 'USD',
    minWithdrawalCents: s.min_withdrawal_cents,
    maxWithdrawalCents: s.max_withdrawal_cents,
    minDonationCents: s.min_donation_cents,
    maxLocationAccuracyMeters: s.max_location_accuracy_meters,
    inviteBaseUrl: config.inviteBaseUrl,
    socialAuthMode: config.socialAuthMode,
    paymentProvider: config.paymentProvider,
  };
}

module.exports = { issueCode, socialLogin, resendVerification, verifyEmail, forgotPassword, resetPassword, setAvatar, deleteAccount, appConfig };
