const crypto = require('node:crypto');
const config = require('../config');
const { q, one, tx } = require('../db');
const { newId, parse, z } = require('../lib/util');
const { badRequest, conflict, notFound, unauthorized, forbidden } = require('../lib/errors');
const { hashPassword, verifyPassword, issueTokens } = require('../lib/auth');
const { audit, adminAudit } = require('./audit');
const finance = require('./finance');

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const referralCode = () => Array.from(crypto.randomBytes(8), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');

function serializeUser(u) {
  return {
    id: u.id, fullName: u.full_name, email: u.email, phone: u.phone,
    avatarUrl: u.avatar_url ? (u.avatar_url.startsWith('http') ? u.avatar_url : `${config.publicBaseUrl}${u.avatar_url}`) : null,
    authProvider: u.auth_provider || 'password', hasPassword: !!u.password_hash, status: u.status,
    statusReason: u.status_reason, isFlagged: !!u.is_flagged, flagReason: u.flag_reason, emailVerified: !!u.email_verified_at,
    referralCode: u.referral_code, referredBy: u.referred_by, walletCents: u.wallet_cents,
    lastLocation: u.last_latitude != null ? { latitude: Number(u.last_latitude), longitude: Number(u.last_longitude), at: u.last_location_at } : null,
    createdAt: u.created_at, updatedAt: u.updated_at,
  };
}

// ------------------------------------------------------------------ member auth
const registerSchema = z.object({
  fullName: z.string().trim().min(1).max(160),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(8, 'must be at least 8 characters').max(200),
  phone: z.string().trim().max(32).optional(),
  referralCode: z.string().trim().toUpperCase().max(16).optional(),
});

async function register(req, body) {
  const input = parse(registerSchema, body);
  if (await one('SELECT id FROM users WHERE email=?', [input.email])) throw conflict('email_taken', 'An account with this email already exists');
  let referredBy = null;
  if (input.referralCode) {
    const ref = await one('SELECT id FROM users WHERE referral_code=?', [input.referralCode]);
    if (!ref) throw badRequest('invalid_referral_code', 'This referral code is not valid');
    referredBy = ref.id;
  }
  const id = newId('usr');
  const hash = await hashPassword(input.password);
  for (let attempt = 0; ; attempt++) {
    try {
      await q('INSERT INTO users (id, full_name, email, password_hash, phone, referral_code, referred_by) VALUES (?,?,?,?,?,?,?)',
        [id, input.fullName, input.email, hash, input.phone || null, referralCode(), referredBy]);
      break;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY' && /referral_code/.test(e.message) && attempt < 5) continue;
      if (e.code === 'ER_DUP_ENTRY') throw conflict('email_taken', 'An account with this email already exists');
      throw e;
    }
  }
  await audit(null, { actorType: 'user', actorId: id, action: 'user_registered', targetType: 'user', targetId: id, details: { referredBy }, ip: req.ip });
  const user = await one('SELECT * FROM users WHERE id=?', [id]);
  const code = await require('./accounts').issueCode(id, 'verify_email');
  await require('./notifications').notify(null, id, { type: 'welcome', title: 'Welcome to UNTAXPOINT',
    body: 'Find live events near you, be among the first to enter, and win cash rewards.' });
  return { user: serializeUser(user), tokens: await issueTokens('user', user), ...(config.exposeDevCodes ? { devVerificationCode: code } : {}) };
}

async function login(req, body) {
  const input = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }), body);
  const user = await one('SELECT * FROM users WHERE email=?', [input.email]);
  if (user && !user.password_hash && user.auth_provider !== 'password') {
    throw unauthorized('use_social_login', `This account uses ${user.auth_provider === 'apple' ? 'Apple' : 'Google'} sign-in`);
  }
  if (!user || user.status === 'deleted' || !(await verifyPassword(input.password, user.password_hash))) {
    throw unauthorized('invalid_credentials', 'Email or password is incorrect');
  }
  if (user.status === 'suspended') throw forbidden('account_suspended', 'Your account is suspended');
  return { user: serializeUser(user), tokens: await issueTokens('user', user) };
}

async function getMe(userId) {
  const u = await one('SELECT * FROM users WHERE id=?', [userId]);
  return serializeUser(u);
}

async function updateMe(userId, body) {
  const input = parse(z.object({ fullName: z.string().trim().min(1).max(160).optional(), phone: z.string().trim().max(32).nullable().optional() }), body);
  if (input.fullName !== undefined) await q('UPDATE users SET full_name=? WHERE id=?', [input.fullName, userId]);
  if (input.phone !== undefined) await q('UPDATE users SET phone=? WHERE id=?', [input.phone, userId]);
  return getMe(userId);
}

async function updateLocation(userId, body) {
  const input = parse(z.object({ latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180) }), body);
  await q('UPDATE users SET last_latitude=?, last_longitude=?, last_location_at=UTC_TIMESTAMP(3) WHERE id=?', [input.latitude, input.longitude, userId]);
  return { ok: true };
}

async function changePassword(req, body) {
  const input = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) }), body);
  const u = await one('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
  if (!(await verifyPassword(input.currentPassword, u.password_hash))) throw badRequest('wrong_password', 'Current password is incorrect');
  await q('UPDATE users SET password_hash=? WHERE id=?', [await hashPassword(input.newPassword), req.user.id]);
  await q("UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE subject_type='user' AND subject_id=? AND revoked_at IS NULL", [req.user.id]);
  await audit(null, { actorType: 'user', actorId: req.user.id, action: 'password_changed', targetType: 'user', targetId: req.user.id, ip: req.ip });
  return { ok: true };
}

async function myReferrals(userId) {
  const me = await one('SELECT referral_code FROM users WHERE id=?', [userId]);
  const rows = await q('SELECT full_name, created_at, status FROM users WHERE referred_by=? ORDER BY created_at DESC LIMIT 200', [userId]);
  return {
    referralCode: me.referral_code,
    inviteLink: `${config.inviteBaseUrl}/${me.referral_code}`,
    totalReferrals: rows.length,
    referrals: rows.map((r) => ({ name: r.full_name.split(' ')[0], joinedAt: r.created_at, active: r.status === 'active' })),
  };
}

// ------------------------------------------------------------------ admin user management
const AGG = `
  (SELECT COUNT(*) FROM participations p WHERE p.user_id=u.id) events_entered,
  (SELECT COUNT(*) FROM participations p WHERE p.user_id=u.id AND p.payout_cents IS NOT NULL) events_won,
  (SELECT COALESCE(SUM(amount_cents),0) FROM transactions t WHERE t.user_id=u.id AND t.kind='reward_credit') total_earned,
  (SELECT COALESCE(SUM(amount_cents),0) FROM withdrawals w WHERE w.user_id=u.id AND w.status='completed') total_withdrawn,
  (SELECT COALESCE(SUM(amount_cents),0) FROM transactions t WHERE t.user_id=u.id AND t.kind='donation') total_donated`;

const withAgg = (u) => ({
  ...serializeUser(u),
  stats: { eventsEntered: u.events_entered, eventsWon: u.events_won, totalEarnedCents: u.total_earned, totalWithdrawnCents: u.total_withdrawn, totalDonatedCents: u.total_donated },
});

async function listUsersAdmin(filters, page) {
  const where = [];
  const params = [];
  if (filters.q) { where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.id=? OR u.phone LIKE ?)'); params.push(`%${filters.q}%`, `%${filters.q}%`, filters.q, `%${filters.q}%`); }
  if (filters.status) { where.push('u.status=?'); params.push(filters.status); }
  if (filters.flagged === 'true') where.push('u.is_flagged');
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sorts = { newest: 'u.created_at DESC', wallet: 'u.wallet_cents DESC', name: 'u.full_name ASC' };
  const order = sorts[filters.sort] || sorts.newest;
  const [{ total }] = await q(`SELECT COUNT(*) total FROM users u ${w}`, params);
  const rows = await q(`SELECT u.*, ${AGG} FROM users u ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, page.limit, page.offset]);
  return { total, items: rows.map(withAgg) };
}

async function getUserAdmin(id) {
  const u = await one(`SELECT u.*, ${AGG} FROM users u WHERE u.id=?`, [id]);
  if (!u) throw notFound('user');
  const participations = await q(`SELECT p.*, e.title, e.status event_status, e.ends_at, e.pool_cents FROM participations p
    JOIN events e ON e.id=p.event_id WHERE p.user_id=? ORDER BY p.accepted_at DESC LIMIT 200`, [id]);
  const rejected = await q(`SELECT r.created_at, r.reject_reason, r.distance_meters, e.title, e.id event_id FROM participation_requests r
    JOIN events e ON e.id=r.event_id WHERE r.user_id=? AND r.outcome='rejected' ORDER BY r.created_at DESC LIMIT 50`, [id]);
  const txns = await q(`SELECT t.*, e.title event_title FROM transactions t LEFT JOIN events e ON e.id=t.event_id
    WHERE t.user_id=? ORDER BY t.created_at DESC LIMIT 200`, [id]);
  const withdrawals = await q('SELECT * FROM withdrawals WHERE user_id=? ORDER BY created_at DESC LIMIT 200', [id]);
  const referrer = u.referred_by ? await one('SELECT id, full_name, email FROM users WHERE id=?', [u.referred_by]) : null;
  const referrals = await q('SELECT id, full_name, email, created_at FROM users WHERE referred_by=? ORDER BY created_at DESC LIMIT 100', [id]);
  return {
    ...withAgg(u),
    wallet: await finance.walletSummary(id),
    payoutAccount: await finance.getPayoutAccount(id),
    participations: participations.map((p) => ({
      eventId: p.event_id, eventTitle: p.title, eventStatus: p.event_status, eventEndsAt: p.ends_at, sequence: p.sequence_no,
      isWinner: !!p.is_winner, payoutCents: p.payout_cents, acceptedAt: p.accepted_at,
      result: ['completed', 'expired'].includes(p.event_status) ? (p.payout_cents ? 'won' : 'not_won') : 'pending',
    })),
    rejectedRequests: rejected.map((r) => ({ eventId: r.event_id, eventTitle: r.title, reason: r.reject_reason, distanceMeters: r.distance_meters, at: r.created_at })),
    transactions: txns.map(finance.serializeTxn),
    withdrawals: withdrawals.map(finance.serializeWithdrawal),
    donations: txns.filter((t) => t.kind === 'donation').map(finance.serializeTxn),
    referredBy: referrer && { id: referrer.id, fullName: referrer.full_name, email: referrer.email },
    referrals: referrals.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email, joinedAt: r.created_at })),
  };
}

async function setUserStatus(req, id, action, body) {
  const reason = String(body?.reason || '').trim().slice(0, 255) || null;
  return tx(async (conn) => {
    const u = await one('SELECT * FROM users WHERE id=? FOR UPDATE', [id], conn);
    if (!u) throw notFound('user');
    if (u.status === 'deleted') throw conflict('user_deleted', 'This account has been deleted');
    if (action === 'suspend') {
      if (!reason) throw badRequest('reason_required', 'Please give a reason for suspending this account');
      await q("UPDATE users SET status='suspended', status_reason=? WHERE id=?", [reason, id], conn);
      await q("UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE subject_type='user' AND subject_id=? AND revoked_at IS NULL", [id], conn);
    } else if (action === 'reactivate') {
      await q("UPDATE users SET status='active', status_reason=NULL WHERE id=?", [id], conn);
    } else if (action === 'flag') {
      await q('UPDATE users SET is_flagged=TRUE, flag_reason=? WHERE id=?', [reason, id], conn);
    } else if (action === 'unflag') {
      await q('UPDATE users SET is_flagged=FALSE, flag_reason=NULL WHERE id=?', [id], conn);
    }
    await adminAudit(conn, req, `user_${action === 'flag' ? 'flagged' : action === 'unflag' ? 'unflagged' : action === 'suspend' ? 'suspended' : 'reactivated'}`, 'user', id, reason ? { reason } : null);
    return serializeUser(await one('SELECT * FROM users WHERE id=?', [id], conn));
  });
}

module.exports = { referralCode, register, login, getMe, updateMe, updateLocation, changePassword, myReferrals, listUsersAdmin, getUserAdmin, setUserStatus, serializeUser };
