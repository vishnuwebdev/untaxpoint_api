#!/usr/bin/env node
/**
 * Fills a fresh local database with demo data so the admin panel has something to show:
 * platform funding, members, events in different states, entries, a settled event,
 * withdrawals and donations. Uses the real services (same rules as the API).
 *   npm run seed:demo
 * Demo member logins: demo1@example.com ... demo6@example.com / password DemoPass123
 */
const { pool, one, q } = require('../src/db');
const { hashPassword } = require('../src/lib/auth');
const { newId } = require('../src/lib/util');
const events = require('../src/services/events');
const finance = require('../src/services/finance');
const participation = require('../src/services/participation');
const settlement = require('../src/services/settlement');

const NYC = { lat: 40.758, lng: -73.9855 }; // Times Square
const iso = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60000).toISOString();

(async () => {
  const admin = await one("SELECT * FROM admins WHERE role='super_admin' AND status='active' ORDER BY created_at LIMIT 1");
  if (!admin) throw new Error('Create an admin first: npm run create-admin');
  const [{ n }] = await q('SELECT COUNT(*) n FROM users');
  if (n > 0 && !process.argv.includes('--force')) throw new Error('Database already has members. Use --force to add demo data anyway.');
  const areq = { admin, ip: '127.0.0.1' };

  await finance.fundPlatform(areq, { amount: '5000.00', note: 'Demo opening balance' }, `seed-${Date.now()}`);

  const hash = await hashPassword('DemoPass123');
  const names = ['Ava Johnson', 'Liam Smith', 'Mia Brown', 'Noah Davis', 'Emma Wilson', 'Lucas Miller'];
  const members = [];
  for (const [i, name] of names.entries()) {
    const id = newId('usr');
    await q('INSERT INTO users (id, full_name, email, password_hash, referral_code, referred_by) VALUES (?,?,?,?,?,?)',
      [id, name, `demo${i + 1}@example.com`, hash, `DEMO${i + 1}${Math.random().toString(36).slice(2, 6).toUpperCase()}`, i > 0 ? members[0].id : null]);
    members.push({ id, full_name: name });
  }
  const ureq = (u) => ({ user: u, ip: '127.0.0.1' });

  // An event that ended a moment ago with 3 entries (settles immediately below).
  const past = await events.createEvent(areq, {
    title: 'Central Park Morning Dash', description: 'Reach the Bethesda Fountain area and check in.', address: 'Central Park, New York, NY',
    latitude: 40.7736, longitude: -73.9712, radiusMeters: 150, poolAmount: '100', maxWinners: 2, startsAt: iso(-60), endsAt: iso(0.05), publish: true,
  });
  for (const m of members.slice(0, 3)) {
    await participation.participate(ureq(m), past.id, { latitude: 40.7737, longitude: -73.9713, accuracyMeters: 8 });
  }
  await participation.participate(ureq(members[3]), past.id, { latitude: 40.78, longitude: -73.96, accuracyMeters: 8 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3500));
  await settlement.settleDueEvents();

  // A live event with a couple of entries.
  const live = await events.createEvent(areq, {
    title: 'Times Square Challenge', description: 'Be inside the Times Square plaza and tap Enter while the event is live.',
    address: 'Times Square, New York, NY', latitude: NYC.lat, longitude: NYC.lng, radiusMeters: 200, poolAmount: '300', maxWinners: 10,
    startsAt: iso(-30), endsAt: iso(24 * 60), publish: true,
  });
  for (const m of members.slice(1, 3)) await participation.participate(ureq(m), live.id, { latitude: 40.7581, longitude: -73.9856, accuracyMeters: 10 });

  await events.createEvent(areq, {
    title: 'Brooklyn Bridge Sunset Run', description: 'Upcoming event on the Brooklyn Bridge promenade.', address: 'Brooklyn Bridge, New York, NY',
    latitude: 40.7061, longitude: -73.9969, radiusMeters: 100, poolAmount: '500', maxWinners: 20, startsAt: iso(2 * 24 * 60), endsAt: iso(2 * 24 * 60 + 120), publish: true,
  });
  await events.createEvent(areq, {
    title: 'Draft: Hudson Yards Hunt', description: 'Not published yet.', address: 'Hudson Yards, New York, NY',
    latitude: 40.7539, longitude: -74.0021, poolAmount: '200', maxWinners: 5, startsAt: iso(5 * 24 * 60), endsAt: iso(5 * 24 * 60 + 60),
  });

  // Wallet activity for the two winners.
  for (const [i, m] of members.slice(0, 2).entries()) {
    await finance.setPayoutAccount(ureq(m), { method: 'paypal', paypalEmail: `demo${i + 1}@example.com` });
  }
  await finance.donate(ureq(members[0]), { amount: '5.00', note: 'Keep it going!' });
  await finance.requestWithdrawal(ureq(members[0]), { amount: '20.00' });
  await finance.donate(ureq(members[1]), { amount: '2.50' });

  console.log('Demo data created: 6 members (demo1..6@example.com / DemoPass123), 4 events, funding, a settled event, a withdrawal and donations.');
  await pool.end();
})().catch(async (err) => {
  console.error(`Seeding failed: ${err.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
