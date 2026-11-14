/**
 * End-to-end API tests against a real MySQL database.
 * Uses a separate database (DB_NAME + "_test"), which is dropped and recreated on every run.
 *   npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

process.env.DB_NAME = `${process.env.DB_NAME || require('dotenv').config({ path: path.join(__dirname, '..', '.env') }).parsed?.DB_NAME || 'untaxpoint'}_test`;
process.env.JOBS_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const config = require('../src/config');
const mysql = require('mysql2/promise');

let server;
let base;
let db; // direct DB access for time travel and assertions
let adminToken;
const members = [];

const NYC = { latitude: 40.758, longitude: -73.9855 };
const iso = (min) => new Date(Date.now() + min * 60000).toISOString();

async function api(method, url, { token, body, headers = {}, form } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(form ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: form || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, data: json?.data, error: json?.error };
}

const balances = async () => {
  const [rows] = await db.query('SELECT code, balance_cents FROM platform_accounts');
  return Object.fromEntries(rows.map((r) => [r.code, r.balance_cents]));
};
const wallet = async (id) => (await db.query('SELECT wallet_cents FROM users WHERE id=?', [id]))[0][0].wallet_cents;
const endNow = (eventId) => db.query('UPDATE events SET starts_at = LEAST(starts_at, UTC_TIMESTAMP(3) - INTERVAL 2 SECOND), ends_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id=?', [eventId]);
const settle = () => require('../src/services/settlement').settleDueEvents();

async function createEvent(overrides = {}) {
  const r = await api('POST', '/api/v1/admin/events', {
    token: adminToken,
    body: { title: 'Test event', description: 'd', address: 'NYC', ...NYC, radiusMeters: 100, poolAmount: '100', maxWinners: 3, startsAt: iso(-5), endsAt: iso(60), publish: true, ...overrides },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
const enter = (m, eventId, loc = NYC, extra = {}) => api('POST', `/api/v1/events/${eventId}/participate`, { token: m.token, body: { ...loc, accuracyMeters: 5, ...extra } });

before(async () => {
  const { database, ...conn } = config.db;
  const c = await mysql.createConnection(conn);
  await c.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await c.end();
  const env = { ...process.env };
  execFileSync('node', ['scripts/migrate.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'pipe' });
  execFileSync('node', ['scripts/create-admin.js', '--email', 'root@test.local', '--name', 'Root', '--password', 'SuperSecret1', '--role', 'super_admin'], { cwd: path.join(__dirname, '..'), env, stdio: 'pipe' });
  db = await mysql.createConnection({ ...config.db, timezone: 'Z' });
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await db?.end();
  await require('../src/db').pool.end();
});

test('admin login, wrong password and token required', async () => {
  assert.equal((await api('POST', '/api/v1/admin/auth/login', { body: { email: 'root@test.local', password: 'nope' } })).status, 401);
  const r = await api('POST', '/api/v1/admin/auth/login', { body: { email: 'root@test.local', password: 'SuperSecret1' } });
  assert.equal(r.status, 200);
  adminToken = r.data.tokens.accessToken;
  assert.equal(r.data.admin.role, 'super_admin');
  assert.equal((await api('GET', '/api/v1/admin/dashboard')).status, 401);
  const refreshed = await api('POST', '/api/v1/admin/auth/refresh', { body: { refreshToken: r.data.tokens.refreshToken } });
  assert.equal(refreshed.status, 200);
  assert.equal((await api('POST', '/api/v1/admin/auth/refresh', { body: { refreshToken: r.data.tokens.refreshToken } })).status, 401, 'refresh tokens are single-use');
});

test('role-based access: event admin cannot add funds', async () => {
  const c = await api('POST', '/api/v1/admin/admins', { token: adminToken, body: { name: 'Eve', email: 'eve@test.local', password: 'EventsAdmin1', role: 'event_admin' } });
  assert.equal(c.status, 201);
  const login = await api('POST', '/api/v1/admin/auth/login', { body: { email: 'eve@test.local', password: 'EventsAdmin1' } });
  const t = login.data.tokens.accessToken;
  assert.equal((await api('POST', '/api/v1/admin/finance/fund', { token: t, body: { amount: 10 } })).status, 403);
  assert.equal((await api('GET', '/api/v1/admin/events', { token: t })).status, 200);
});

test('platform funding is idempotent', async () => {
  const body = { amount: '1000.00', note: 'Opening balance' };
  const a = await api('POST', '/api/v1/admin/finance/fund', { token: adminToken, body, headers: { 'Idempotency-Key': 'fund-1' } });
  const b = await api('POST', '/api/v1/admin/finance/fund', { token: adminToken, body, headers: { 'Idempotency-Key': 'fund-1' } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.data.duplicate, true);
  assert.equal((await balances()).main, 100000);
  assert.equal((await api('POST', '/api/v1/admin/finance/fund', { token: adminToken, body: { amount: '1.234' } })).status, 400);
});

test('members register', async () => {
  for (let i = 0; i < 14; i++) {
    const r = await api('POST', '/api/v1/auth/register', { body: { fullName: `Member ${i}`, email: `m${i}@test.local`, password: 'password123', ...(i > 0 ? { referralCode: members[0].referralCode } : {}) } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    members.push({ id: r.data.user.id, token: r.data.tokens.accessToken, referralCode: r.data.user.referralCode });
  }
  assert.equal((await api('POST', '/api/v1/auth/register', { body: { fullName: 'Dup', email: 'm0@test.local', password: 'password123' } })).status, 409);
  const refs = await api('GET', '/api/v1/me/referrals', { token: members[0].token });
  assert.equal(refs.data.totalReferrals, 13);
});

test('event creation reserves the pool; insufficient funds are refused', async () => {
  const before = await balances();
  assert.equal((await api('POST', '/api/v1/admin/events', { token: adminToken, body: { title: 'Too big', ...NYC, poolAmount: '999999', maxWinners: 1, startsAt: iso(1), endsAt: iso(60) } })).status, 409);
  const ev = await createEvent({ poolAmount: '50', publish: false });
  const after = await balances();
  assert.equal(after.main, before.main - 5000);
  assert.equal(after.reserved, before.reserved + 5000);
  assert.equal(ev.status, 'draft');
  assert.equal(ev.radiusMeters, 100);
  // Draft events are invisible to members and cannot be entered.
  assert.equal((await enter(members[0], ev.id)).status, 404);
  const list = await api('GET', '/api/v1/events', { token: members[0].token });
  assert.ok(!list.data.some((e) => e.id === ev.id));
  // Editing the pool before start adjusts the reservation.
  const upd = await api('PATCH', `/api/v1/admin/events/${ev.id}`, { token: adminToken, body: { poolAmount: '80' } });
  assert.equal(upd.status, 200);
  assert.equal((await balances()).reserved, after.reserved + 3000);
  // Cancelling an event without participants releases the pool.
  const c = await api('POST', `/api/v1/admin/events/${ev.id}/cancel`, { token: adminToken, body: { reason: 'test' } });
  assert.equal(c.data.status, 'cancelled');
  assert.deepEqual(await balances(), before);
});

test('global default radius applies when an event has none', async () => {
  await api('PUT', '/api/v1/admin/settings', { token: adminToken, body: { default_radius_meters: 250 } });
  const ev = await createEvent({ radiusMeters: undefined, poolAmount: '1' , maxWinners: 1 });
  assert.equal(ev.radiusMeters, 250);
  await api('PUT', '/api/v1/admin/settings', { token: adminToken, body: { default_radius_meters: 100 } });
  assert.equal((await api('PUT', '/api/v1/admin/settings', { token: adminToken, body: { default_radius_meters: -1 } })).status, 400);
});

test('participation validation records rejections', async () => {
  const ev = await createEvent({ poolAmount: '10', maxWinners: 2 });
  const m = members[0];
  const far = await enter(m, ev.id, { latitude: 40.7, longitude: -73.9 });
  assert.equal(far.status, 422);
  assert.equal(far.error.code, 'outside_radius');
  assert.ok(far.error.details.distanceMeters > 100);
  assert.equal((await enter(m, ev.id, NYC, { isMockLocation: true })).error.code, 'mock_location');
  assert.equal((await enter(m, ev.id, NYC, { accuracyMeters: 500 })).error.code, 'low_accuracy');
  const ok1 = await enter(m, ev.id, { latitude: 40.7583, longitude: -73.9855 }); // ~33 m away
  assert.equal(ok1.status, 201);
  assert.equal(ok1.data.sequence, 1);
  assert.equal(ok1.data.isWinner, true);
  assert.equal((await enter(m, ev.id)).error.code, 'already_participated');

  const upcoming = await createEvent({ startsAt: iso(30), endsAt: iso(90) });
  assert.equal(upcoming.status, 'scheduled');
  assert.equal((await enter(m, upcoming.id)).error.code, 'event_not_started');

  // Committed fields are locked once someone has entered.
  const locked = await api('PATCH', `/api/v1/admin/events/${ev.id}`, { token: adminToken, body: { poolAmount: '20' } });
  assert.equal(locked.error.code, 'event_committed');
  assert.equal((await api('PATCH', `/api/v1/admin/events/${ev.id}`, { token: adminToken, body: { title: 'Renamed' } })).status, 200);
  assert.equal((await api('POST', `/api/v1/admin/events/${ev.id}/cancel`, { token: adminToken })).error.code, 'event_has_participants');

  // Paused events refuse entries; resuming restores them.
  await api('POST', `/api/v1/admin/events/${ev.id}/pause`, { token: adminToken });
  assert.equal((await enter(members[1], ev.id)).error.code, 'event_paused');
  await api('POST', `/api/v1/admin/events/${ev.id}/resume`, { token: adminToken });
  assert.equal((await enter(members[1], ev.id)).status, 201);

  const detail = await api('GET', `/api/v1/admin/events/${ev.id}`, { token: adminToken });
  assert.equal(detail.data.stats.acceptedParticipants, 2);
  assert.equal(detail.data.stats.rejectionsByReason.outside_radius, 1);
  assert.equal(detail.data.stats.rejectionsByReason.event_paused, 1);
});

test('simultaneous entries get unique sequence numbers and exactly max winners', async () => {
  const ev = await createEvent({ poolAmount: '10.01', maxWinners: 3 });
  const results = await Promise.all(members.slice(0, 12).map((m) => enter(m, ev.id)));
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.filter((r) => r.status !== 201).map((r) => r.body)));
  const seqs = results.map((r) => r.data.sequence).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 12 }, (_, i) => i + 1));
  const winners = results.filter((r) => r.data.isWinner);
  assert.equal(winners.length, 3);
  assert.deepEqual(winners.map((w) => w.data.sequence).sort(), [1, 2, 3]);
  // Capacity reached does not end the event: later entries are still recorded.
  const [[row]] = await db.query('SELECT status FROM events WHERE id=?', [ev.id]);
  assert.equal(row.status, 'capacity_reached');

  // Settlement: $10.01 / 3 = 334 + 334 + 333 cents, in entry order.
  const winnerIds = winners.sort((a, b) => a.data.sequence - b.data.sequence).map((w) => members.find((m) => results.indexOf(w) === members.indexOf(m)).id);
  const walletsBefore = await Promise.all(winnerIds.map(wallet));
  const reservedBefore = (await balances()).reserved;
  await endNow(ev.id);
  assert.equal((await enter(members[13], ev.id)).error.code, 'event_ended');
  await settle();
  const walletsAfter = await Promise.all(winnerIds.map(wallet));
  assert.deepEqual(walletsAfter.map((w, i) => w - walletsBefore[i]), [334, 334, 333]);
  assert.equal((await balances()).reserved, reservedBefore - 1001);

  // Idempotent: settling again changes nothing.
  await db.query("UPDATE events SET status='active' WHERE id=?", [ev.id]).catch(() => {});
  await settle().catch(() => {});
  assert.deepEqual(await Promise.all(winnerIds.map(wallet)), walletsAfter);
  await db.query("UPDATE events SET status='completed' WHERE id=?", [ev.id]);

  const detail = await api('GET', `/api/v1/admin/events/${ev.id}`, { token: adminToken });
  assert.equal(detail.data.settlement.winnerCount, 3);
  assert.equal(detail.data.settlement.distributedCents, 1001);
  assert.equal(detail.data.settlement.remainderCents, 2);
  assert.equal(detail.data.settlement.acceptedParticipants, 12);
  assert.equal(detail.data.settlement.outsideWindow, 1);
});

test('fewer participants than the limit share the whole pool; zero participants release it', async () => {
  const one = await createEvent({ poolAmount: '100', maxWinners: 10 });
  await enter(members[5], one.id);
  const w0 = await wallet(members[5].id);
  const empty = await createEvent({ poolAmount: '40', maxWinners: 5 });
  const draft = await createEvent({ poolAmount: '7', maxWinners: 1, publish: false });
  const before = await balances();
  await Promise.all([endNow(one.id), endNow(empty.id), endNow(draft.id)]);
  await settle();
  assert.equal(await wallet(members[5].id), w0 + 10000);
  const after = await balances();
  assert.equal(after.main, before.main + 4000 + 700);
  assert.equal(after.reserved, before.reserved - 10000 - 4000 - 700);
  const [[e1]] = await db.query('SELECT status FROM events WHERE id=?', [empty.id]);
  const [[e2]] = await db.query('SELECT status FROM events WHERE id=?', [draft.id]);
  assert.equal(e1.status, 'expired');
  assert.equal(e2.status, 'expired');
});

test('member wallet, withdrawals (auto, failed, held, rejected) and donations', async () => {
  const m = members[5]; // has $100.00
  const w = await api('GET', '/api/v1/me/wallet', { token: m.token });
  assert.equal(w.data.availableCents, await wallet(m.id));
  assert.equal(w.data.totalEarnedCents, 10000);

  assert.equal((await api('POST', '/api/v1/me/withdrawals', { token: m.token, body: { amount: 20 } })).error.code, 'payout_account_missing');
  assert.equal((await api('PUT', '/api/v1/me/payout-account', { token: m.token, body: { method: 'paypal', paypalEmail: 'm5@test.local' } })).status, 200);
  assert.equal((await api('POST', '/api/v1/me/withdrawals', { token: m.token, body: { amount: 1 } })).error.code, 'below_minimum');

  const start = await wallet(m.id);
  const done = await api('POST', '/api/v1/me/withdrawals', { token: m.token, body: { amount: 20 }, headers: { 'Idempotency-Key': 'w1' } });
  assert.equal(done.data.status, 'completed');
  const again = await api('POST', '/api/v1/me/withdrawals', { token: m.token, body: { amount: 20 }, headers: { 'Idempotency-Key': 'w1' } });
  assert.equal(again.data.id, done.data.id, 'same idempotency key returns the same withdrawal');
  assert.equal(await wallet(m.id), start - 2000);

  // Provider failure returns the money.
  await api('PUT', '/api/v1/me/payout-account', { token: m.token, body: { method: 'paypal', paypalEmail: 'fail@test.local' } });
  const failed = await api('POST', '/api/v1/me/withdrawals', { token: m.token, body: { amount: 10 } });
  assert.equal(failed.data.status, 'failed');
  assert.equal(await wallet(m.id), start - 2000);
  await api('PUT', '/api/v1/me/payout-account', { token: m.token, body: { method: 'paypal', paypalEmail: 'm5@test.local' } });

  // Large withdrawals are held for review.
  await api('PUT', '/api/v1/admin/settings', { token: adminToken, body: { withdrawal_hold_threshold_cents: 3000 } });
  const held = await api('POST', '/api/v1/me/withdrawals', { token: m.token, body: { amount: 30 } });
  assert.equal(held.data.status, 'on_hold');
  assert.equal(await wallet(m.id), start - 5000);
  assert.equal((await api('POST', `/api/v1/admin/withdrawals/${held.data.id}/reject`, { token: adminToken, body: {} })).error.code, 'reason_required');
  const rejected = await api('POST', `/api/v1/admin/withdrawals/${held.data.id}/reject`, { token: adminToken, body: { note: 'Verify identity first' } });
  assert.equal(rejected.data.status, 'rejected');
  assert.equal(await wallet(m.id), start - 2000);
  const held2 = await api('POST', '/api/v1/me/withdrawals', { token: m.token, body: { amount: 30 } });
  const approved = await api('POST', `/api/v1/admin/withdrawals/${held2.data.id}/approve`, { token: adminToken, body: { note: 'ok' } });
  assert.equal(approved.data.status, 'completed');
  assert.equal(await wallet(m.id), start - 5000);

  // Overdraw is refused.
  await api('PUT', '/api/v1/admin/settings', { token: adminToken, body: { withdrawal_hold_threshold_cents: 50000 } });
  assert.equal((await api('POST', '/api/v1/me/withdrawals', { token: m.token, body: { amount: 999 } })).error.code, 'insufficient_wallet_balance');

  // Donations move money into the separate donated fund.
  const donBefore = (await balances()).donations;
  const mainBefore = (await balances()).main;
  const d = await api('POST', '/api/v1/me/donations', { token: m.token, body: { amount: '12.50', note: 'thanks' } });
  assert.equal(d.status, 201);
  assert.equal((await balances()).donations, donBefore + 1250);
  assert.equal((await balances()).main, mainBefore, 'donations do not become event funding');
  assert.equal((await api('POST', '/api/v1/me/donations', { token: m.token, body: { amount: 99999 } })).error.code, 'insufficient_wallet_balance');

  const rep = await api('GET', '/api/v1/admin/donations', { token: adminToken });
  assert.equal(rep.data.summary.donatedFundCents, donBefore + 1250);
  assert.equal(rep.data.topDonors[0].userId, m.id);

  const ud = await api('GET', `/api/v1/admin/users/${m.id}`, { token: adminToken });
  assert.equal(ud.data.withdrawals.length, 4, 'the refused overdraw creates no withdrawal');
  assert.equal(ud.data.donations.length, 1);
  assert.equal(ud.data.participations.length, 2);
  assert.equal(ud.data.stats.totalWithdrawnCents, 5000);
});

test('suspended members cannot use the app', async () => {
  const m = members[13];
  assert.equal((await api('POST', `/api/v1/admin/users/${m.id}/suspend`, { token: adminToken, body: {} })).error.code, 'reason_required');
  await api('POST', `/api/v1/admin/users/${m.id}/suspend`, { token: adminToken, body: { reason: 'GPS spoofing' } });
  assert.equal((await api('GET', '/api/v1/me', { token: m.token })).status, 403);
  await api('POST', `/api/v1/admin/users/${m.id}/reactivate`, { token: adminToken });
  assert.equal((await api('GET', '/api/v1/me', { token: m.token })).status, 200);
});

test('member event discovery sorts by distance and hides paused events', async () => {
  const near = await createEvent({ title: 'Near', poolAmount: '1', maxWinners: 1 });
  const far = await createEvent({ title: 'Far', latitude: 40.85, longitude: -73.9, poolAmount: '1', maxWinners: 1 });
  const paused = await createEvent({ title: 'Paused', poolAmount: '1', maxWinners: 1 });
  await api('POST', `/api/v1/admin/events/${paused.id}/pause`, { token: adminToken });
  const r = await api('GET', `/api/v1/events?lat=${NYC.latitude}&lng=${NYC.longitude}&radiusKm=50`, { token: members[0].token });
  const ids = r.data.map((e) => e.id);
  assert.ok(ids.indexOf(near.id) < ids.indexOf(far.id));
  assert.ok(!ids.includes(paused.id));
  assert.equal(r.data.find((e) => e.id === near.id).distanceMeters, 0);
  assert.equal(r.data[0].storedStatus, undefined, 'admin-only fields are hidden');
});

test('event images upload and delete', async () => {
  const ev = await createEvent({ poolAmount: '1', maxWinners: 1 });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.append('images', new Blob([png], { type: 'image/png' }), 'a.png');
  const up = await api('POST', `/api/v1/admin/events/${ev.id}/images`, { token: adminToken, form });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const img = await fetch(up.data[0].url.replace(config.publicBaseUrl, base));
  assert.equal(img.status, 200);
  assert.equal((await api('DELETE', `/api/v1/admin/events/${ev.id}/images/${up.data[0].id}`, { token: adminToken })).status, 200);
  const bad = new FormData();
  bad.append('images', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
  assert.equal((await api('POST', `/api/v1/admin/events/${ev.id}/images`, { token: adminToken, form: bad })).status, 400);
});

test('dashboard, reports and ledger reconciliation', async () => {
  const d = await api('GET', '/api/v1/admin/dashboard', { token: adminToken });
  assert.equal(d.status, 200);
  assert.equal(d.data.funds.totalFundedCents, 100000);
  const t = await api('GET', '/api/v1/admin/transactions?kind=reward_credit', { token: adminToken });
  assert.ok(t.data.length >= 4);
  assert.equal((await api('GET', '/api/v1/admin/audit-logs', { token: adminToken })).status, 200);
  const rec = await api('GET', '/api/v1/admin/finance/reconciliation', { token: adminToken });
  assert.equal(rec.data.ok, true, JSON.stringify(rec.data.issues));
  // Money is conserved: everything that came in is either still on the platform or paid out.
  const b = await balances();
  const [[w]] = await db.query('SELECT SUM(wallet_cents) s FROM users');
  assert.equal(b.main + b.reserved + b.donations + b.payouts_pending + Number(w.s) + b.external, 0);
});

// ------------------------------------------------------------------ mobile app additions
test('mobile: app config, social sign-in (mock), email verification', async () => {
  const cfg = await api('GET', '/api/v1/app/config');
  assert.equal(cfg.status, 200);
  assert.ok(cfg.data.minWithdrawalCents > 0);

  const g = await api('POST', '/api/v1/auth/social', { body: { provider: 'google', email: 'new.google@test.local', idToken: 'mock' } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal(g.data.user.authProvider, 'google');
  assert.equal(g.data.user.emailVerified, true);
  assert.equal(g.data.user.fullName, 'New Google');
  const again = await api('POST', '/api/v1/auth/social', { body: { provider: 'google', email: 'new.google@test.local' } });
  assert.equal(again.status, 200);
  assert.equal(again.data.user.id, g.data.user.id);
  // A social-only account cannot log in with a password.
  assert.equal((await api('POST', '/api/v1/auth/login', { body: { email: 'new.google@test.local', password: 'whatever1' } })).error.code, 'use_social_login');

  const reg = await api('POST', '/api/v1/auth/register', { body: { fullName: 'Verify Me', email: 'verify@test.local', password: 'password123' } });
  assert.match(reg.data.devVerificationCode, /^\d{6}$/);
  assert.equal(reg.data.user.emailVerified, false);
  const t = reg.data.tokens.accessToken;
  assert.equal((await api('POST', '/api/v1/auth/verify-email', { token: t, body: { code: '000000' === reg.data.devVerificationCode ? '111111' : '000000' } })).error.code, 'code_invalid');
  const v = await api('POST', '/api/v1/auth/verify-email', { token: t, body: { code: reg.data.devVerificationCode } });
  assert.equal(v.data.emailVerified, true);
});

test('mobile: forgot and reset password', async () => {
  const f = await api('POST', '/api/v1/auth/forgot-password', { body: { email: 'm1@test.local' } });
  assert.match(f.data.devCode, /^\d{6}$/);
  const unknown = await api('POST', '/api/v1/auth/forgot-password', { body: { email: 'nobody@test.local' } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.devCode, undefined, 'no account enumeration');
  const r = await api('POST', '/api/v1/auth/reset-password', { body: { email: 'm1@test.local', code: f.data.devCode, newPassword: 'brandnew123' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await api('POST', '/api/v1/auth/reset-password', { body: { email: 'm1@test.local', code: f.data.devCode, newPassword: 'other12345' } })).status, 400, 'codes are single-use');
  assert.equal((await api('POST', '/api/v1/auth/login', { body: { email: 'm1@test.local', password: 'brandnew123' } })).status, 200);
});

test('mobile: notifications for new events, entries and rewards', async () => {
  const m = members[2];
  const before = (await api('GET', '/api/v1/me/notifications/unread-count', { token: m.token })).data.unread;
  const ev = await createEvent({ title: 'Notify me', poolAmount: '3', maxWinners: 1 });
  const list = await api('GET', '/api/v1/me/notifications', { token: m.token });
  assert.equal(list.body.meta.unread, before + 1);
  assert.equal(list.data[0].type, 'new_event');
  assert.equal(list.data[0].eventId, ev.id);
  await enter(m, ev.id);
  await endNow(ev.id);
  await settle();
  const after = await api('GET', '/api/v1/me/notifications', { token: m.token });
  assert.deepEqual(after.data.slice(0, 2).map((n) => n.type), ['reward_credited', 'entry_accepted']);
  const read = await api('POST', '/api/v1/me/notifications/read-all', { token: m.token });
  assert.equal(read.data.unread, 0);
  const search = await api('GET', '/api/v1/events?q=Notify', { token: m.token });
  assert.ok(Array.isArray(search.data));
});

test('mobile: avatar upload and account deletion', async () => {
  const reg = await api('POST', '/api/v1/auth/register', { body: { fullName: 'Leaving Soon', email: 'leave@test.local', password: 'password123' } });
  const t = reg.data.tokens.accessToken;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.append('avatar', new Blob([png], { type: 'image/png' }), 'me.png');
  const up = await api('POST', '/api/v1/me/avatar', { token: t, form });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.match(up.data.avatarUrl, /\/uploads\/avatars\//);
  assert.equal((await api('DELETE', '/api/v1/me', { token: t, body: { confirm: 'nope' } })).status, 400);
  assert.equal((await api('DELETE', '/api/v1/me', { token: t, body: { confirm: 'DELETE' } })).data.deleted, true);
  assert.equal((await api('GET', '/api/v1/me', { token: t })).status, 401);
  // A member with money in the wallet must withdraw or donate first.
  assert.equal((await api('DELETE', '/api/v1/me', { token: members[5].token, body: { confirm: 'DELETE' } })).error.code, 'wallet_not_empty');
});
