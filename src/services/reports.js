const { q, one } = require('../db');
const ledger = require('./ledger');
const finance = require('./finance');

/** Admin dashboard: key metrics in one call. */
async function dashboard() {
  const balances = await ledger.platformBalances();
  const users = await one(`SELECT COUNT(*) total, SUM(status='active') active, SUM(status='suspended') suspended, SUM(is_flagged) flagged,
    SUM(created_at >= UTC_TIMESTAMP(3) - INTERVAL 30 DAY) new30 FROM users WHERE status <> 'deleted'`);
  const activeUsers = await one(`SELECT COUNT(DISTINCT user_id) n FROM participation_requests WHERE created_at >= UTC_TIMESTAMP(3) - INTERVAL 30 DAY`);
  const ev = await one(`SELECT COUNT(*) total,
      SUM(status IN ('active','capacity_reached') OR (status='scheduled' AND starts_at <= UTC_TIMESTAMP(3))) active,
      SUM(status='scheduled' AND starts_at > UTC_TIMESTAMP(3)) scheduled,
      SUM(status='draft') draft, SUM(status='paused') paused, SUM(status='completed') completed,
      SUM(status='expired') expired, SUM(status='cancelled') cancelled FROM events`);
  const totals = await one(`SELECT
      COALESCE(SUM(CASE WHEN kind='platform_funding' THEN amount_cents END),0) funded,
      COALESCE(SUM(CASE WHEN kind='reward_credit' THEN amount_cents END),0) rewards,
      COALESCE(SUM(CASE WHEN kind='event_release' THEN amount_cents END),0) released,
      COALESCE(SUM(CASE WHEN kind='donation' THEN amount_cents END),0) donated
    FROM transactions WHERE status='completed'`);
  const wd = await one(`SELECT COALESCE(SUM(CASE WHEN status='completed' THEN amount_cents END),0) completed,
      SUM(status='on_hold') on_hold, SUM(status IN ('requested','processing','pending')) in_progress, SUM(status='failed') failed FROM withdrawals`);
  const wallets = await one('SELECT COALESCE(SUM(wallet_cents),0) total FROM users');
  const recent = await q(`SELECT t.*, u.full_name user_name, u.email user_email, e.title event_title FROM transactions t
    LEFT JOIN users u ON u.id=t.user_id LEFT JOIN events e ON e.id=t.event_id ORDER BY t.created_at DESC LIMIT 10`);
  const live = await q(`SELECT id, title, ends_at, pool_cents, max_winners, participants_count, winners_count FROM events
    WHERE (status IN ('active','capacity_reached') OR (status='scheduled' AND starts_at <= UTC_TIMESTAMP(3))) AND ends_at > UTC_TIMESTAMP(3)
    ORDER BY ends_at LIMIT 10`);
  const n = (x) => Number(x || 0);
  return {
    users: { total: n(users.total), active: n(users.active), activeLast30Days: n(activeUsers.n), suspended: n(users.suspended), flagged: n(users.flagged), newLast30Days: n(users.new30) },
    events: { total: n(ev.total), active: n(ev.active), scheduled: n(ev.scheduled), draft: n(ev.draft), paused: n(ev.paused), completed: n(ev.completed), expired: n(ev.expired), cancelled: n(ev.cancelled) },
    funds: {
      mainCents: balances.main, reservedCents: balances.reserved, donationsCents: balances.donations,
      withdrawalsInProgressCents: balances.payouts_pending, memberWalletsCents: wallets.total,
      totalFundedCents: totals.funded, totalRewardsCents: totals.rewards, totalReleasedCents: totals.released,
      totalDonatedCents: totals.donated, totalWithdrawnCents: wd.completed,
    },
    withdrawals: { onHold: n(wd.on_hold), inProgress: n(wd.in_progress), failed: n(wd.failed) },
    liveEvents: live.map((e) => ({ id: e.id, title: e.title, endsAt: e.ends_at, poolCents: e.pool_cents, maxWinners: e.max_winners, participants: e.participants_count, winners: e.winners_count })),
    recentTransactions: recent.map(finance.serializeTxn),
  };
}

const KINDS = ['platform_funding', 'event_reservation', 'event_reservation_adjustment', 'event_release', 'reward_credit', 'withdrawal', 'withdrawal_reversal', 'donation', 'admin_adjustment'];

async function listTransactions(f, page) {
  const where = [];
  const params = [];
  if (f.kind) { where.push(`t.kind IN (?)`); params.push(String(f.kind).split(',').filter((k) => KINDS.includes(k))); }
  if (f.status) { where.push('t.status=?'); params.push(f.status); }
  if (f.userId) { where.push('t.user_id=?'); params.push(f.userId); }
  if (f.eventId) { where.push('t.event_id=?'); params.push(f.eventId); }
  if (f.from) { where.push('t.created_at >= ?'); params.push(new Date(f.from)); }
  if (f.to) { where.push('t.created_at < ?'); params.push(new Date(f.to)); }
  if (f.q) { where.push('(t.id=? OR u.email LIKE ? OR u.full_name LIKE ? OR e.title LIKE ? OR t.description LIKE ?)'); params.push(f.q, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = 'FROM transactions t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN events e ON e.id=t.event_id';
  const [{ total, sum }] = await q(`SELECT COUNT(*) total, COALESCE(SUM(t.amount_cents),0) sum ${from} ${w}`, params);
  const rows = await q(`SELECT t.*, u.full_name user_name, u.email user_email, e.title event_title ${from} ${w}
    ORDER BY t.created_at DESC LIMIT ? OFFSET ?`, [...params, page.limit, page.offset]);
  return { total, sumCents: sum, items: rows.map(finance.serializeTxn) };
}

async function listWithdrawals(f, page) {
  const where = [];
  const params = [];
  if (f.status) { where.push('w.status IN (?)'); params.push(String(f.status).split(',')); }
  if (f.userId) { where.push('w.user_id=?'); params.push(f.userId); }
  if (f.q) { where.push('(w.id=? OR u.email LIKE ? OR u.full_name LIKE ?)'); params.push(f.q, `%${f.q}%`, `%${f.q}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ total }] = await q(`SELECT COUNT(*) total FROM withdrawals w JOIN users u ON u.id=w.user_id ${w}`, params);
  const rows = await q(`SELECT w.*, u.full_name user_name, u.email user_email FROM withdrawals w JOIN users u ON u.id=w.user_id ${w}
    ORDER BY (w.status='on_hold') DESC, w.created_at DESC LIMIT ? OFFSET ?`, [...params, page.limit, page.offset]);
  const summary = await q('SELECT status, COUNT(*) n, COALESCE(SUM(amount_cents),0) sum FROM withdrawals GROUP BY status');
  return { total, items: rows.map(finance.serializeWithdrawal), summary: Object.fromEntries(summary.map((s) => [s.status, { count: s.n, amountCents: s.sum }])) };
}

async function getWithdrawal(id) {
  const w = await one('SELECT w.*, u.full_name user_name, u.email user_email FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.id=?', [id]);
  if (!w) throw require('../lib/errors').notFound('withdrawal');
  const txns = await q('SELECT * FROM transactions WHERE withdrawal_id=? ORDER BY created_at', [id]);
  const wallet = await finance.walletSummary(w.user_id);
  return { ...finance.serializeWithdrawal(w), transactions: txns.map(finance.serializeTxn), userWallet: wallet };
}

async function donationsReport(f, page) {
  const params = [];
  let w = "t.kind='donation'";
  if (f.from) { w += ' AND t.created_at >= ?'; params.push(new Date(f.from)); }
  if (f.to) { w += ' AND t.created_at < ?'; params.push(new Date(f.to)); }
  if (f.q) { w += ' AND (u.email LIKE ? OR u.full_name LIKE ?)'; params.push(`%${f.q}%`, `%${f.q}%`); }
  const balances = await ledger.platformBalances();
  const [tot] = await q(`SELECT COUNT(*) n, COUNT(DISTINCT t.user_id) donors, COALESCE(SUM(t.amount_cents),0) sum
    FROM transactions t JOIN users u ON u.id=t.user_id WHERE ${w}`, params);
  const donors = await q(`SELECT u.id, u.full_name, u.email, COUNT(*) donations, SUM(t.amount_cents) total, MAX(t.created_at) last_at
    FROM transactions t JOIN users u ON u.id=t.user_id WHERE ${w} GROUP BY u.id, u.full_name, u.email ORDER BY total DESC LIMIT 100`, params);
  const rows = await q(`SELECT t.*, u.full_name user_name, u.email user_email FROM transactions t JOIN users u ON u.id=t.user_id
    WHERE ${w} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`, [...params, page.limit, page.offset]);
  return {
    total: tot.n,
    summary: { donatedFundCents: balances.donations, totalDonatedCents: tot.sum, donationCount: tot.n, donorCount: tot.donors },
    topDonors: donors.map((d) => ({ userId: d.id, fullName: d.full_name, email: d.email, donations: d.donations, totalCents: d.total, lastDonationAt: d.last_at })),
    items: rows.map(finance.serializeTxn),
  };
}

async function financeSummary() {
  const d = await dashboard();
  const failed = await one("SELECT COUNT(*) n FROM transactions WHERE status='failed'");
  const pending = await one("SELECT COUNT(*) n FROM transactions WHERE status='pending'");
  return { ...d.funds, pendingTransactions: pending.n, failedTransactions: failed.n, withdrawals: d.withdrawals };
}

async function auditLogs(f, page) {
  const where = [];
  const params = [];
  if (f.actorType) { where.push('a.actor_type=?'); params.push(f.actorType); }
  if (f.action) { where.push('a.action LIKE ?'); params.push(`${f.action}%`); }
  if (f.targetId) { where.push('a.target_id=?'); params.push(f.targetId); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ total }] = await q(`SELECT COUNT(*) total FROM audit_logs a ${w}`, params);
  const rows = await q(`SELECT a.*, ad.name admin_name, us.full_name user_name FROM audit_logs a
    LEFT JOIN admins ad ON a.actor_type='admin' AND ad.id=a.actor_id
    LEFT JOIN users us ON a.actor_type='user' AND us.id=a.actor_id ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...params, page.limit, page.offset]);
  return {
    total,
    items: rows.map((r) => ({
      id: r.id, actorType: r.actor_type, actorId: r.actor_id, actorName: r.admin_name || r.user_name || (r.actor_type === 'system' ? 'System' : null),
      action: r.action, targetType: r.target_type, targetId: r.target_id,
      details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details, ip: r.ip_address, createdAt: r.created_at,
    })),
  };
}

module.exports = { dashboard, listTransactions, listWithdrawals, getWithdrawal, donationsReport, financeSummary, auditLogs, KINDS };
