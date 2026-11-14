/**
 * Double-entry ledger.
 *
 * Accounts: platform accounts ('main', 'reserved', 'donations', 'payouts_pending', 'external')
 * and member wallets ('user' + userId). Every posting's entries sum to zero, and every
 * balance change is written to ledger_entries with the balance after the change.
 * Only 'external' (money entering/leaving the platform) may go negative.
 */
const { q, one } = require('../db');
const { newId } = require('../lib/util');
const { conflict, AppError } = require('../lib/errors');

const PLATFORM_ACCOUNTS = ['main', 'reserved', 'donations', 'payouts_pending', 'external'];
const INSUFFICIENT = {
  main: () => conflict('insufficient_platform_funds', 'Not enough money in the main fund'),
  reserved: () => conflict('insufficient_reserved_funds', 'Reserved funds are insufficient'),
  donations: () => conflict('insufficient_donation_funds', 'Not enough money in the donated fund'),
  payouts_pending: () => conflict('ledger_inconsistent', 'Pending payouts balance is insufficient'),
  user: () => conflict('insufficient_wallet_balance', 'Not enough money in the wallet'),
};

/** Apply balanced entries [{account, userId?, amount}] to a transaction. Must run inside tx(). */
async function applyEntries(conn, transactionId, entries) {
  const sum = entries.reduce((s, e) => s + e.amount, 0);
  if (sum !== 0) throw new AppError(500, 'ledger_unbalanced', 'Ledger entries do not balance');
  // Lock in a stable order (platform accounts by code, then users by id) to avoid deadlocks.
  const sorted = [...entries].sort((a, b) => {
    const ka = a.account === 'user' ? `z:${a.userId}` : `a:${a.account}`;
    const kb = b.account === 'user' ? `z:${b.userId}` : `a:${b.account}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const e of sorted) {
    if (!Number.isSafeInteger(e.amount) || e.amount === 0) continue;
    let after;
    if (e.account === 'user') {
      const row = await one('SELECT wallet_cents FROM users WHERE id=? FOR UPDATE', [e.userId], conn);
      if (!row) throw new AppError(404, 'user_not_found', 'User not found');
      after = row.wallet_cents + e.amount;
      if (after < 0) throw INSUFFICIENT.user();
      await q('UPDATE users SET wallet_cents=? WHERE id=?', [after, e.userId], conn);
    } else {
      if (!PLATFORM_ACCOUNTS.includes(e.account)) throw new AppError(500, 'ledger_bad_account', `Unknown account ${e.account}`);
      const row = await one('SELECT balance_cents FROM platform_accounts WHERE code=? FOR UPDATE', [e.account], conn);
      after = row.balance_cents + e.amount;
      if (after < 0 && e.account !== 'external') throw INSUFFICIENT[e.account]();
      await q('UPDATE platform_accounts SET balance_cents=? WHERE code=?', [after, e.account], conn);
    }
    await q('INSERT INTO ledger_entries (transaction_id, account, user_id, amount_cents, balance_after_cents) VALUES (?,?,?,?,?)',
      [transactionId, e.account, e.account === 'user' ? e.userId : null, e.amount, after], conn);
  }
}

/**
 * Create a business transaction and post its entries atomically.
 * Idempotent: if idempotencyKey already exists, returns the existing transaction with duplicate=true
 * and posts nothing.
 */
async function post(conn, t, entries) {
  const existing = await one('SELECT * FROM transactions WHERE idempotency_key=? FOR UPDATE', [t.idempotencyKey], conn);
  if (existing) return { transaction: existing, duplicate: true };
  const id = newId('txn');
  await q(
    `INSERT INTO transactions (id, kind, status, amount_cents, currency, user_id, event_id, withdrawal_id, actor_type, actor_id,
       description, provider, provider_ref, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, t.kind, t.status || 'completed', t.amountCents, t.currency || 'USD', t.userId || null, t.eventId || null, t.withdrawalId || null,
      t.actorType, t.actorId || null, t.description || null, t.provider || null, t.providerRef || null, t.idempotencyKey],
    conn,
  );
  await applyEntries(conn, id, entries);
  return { transaction: await one('SELECT * FROM transactions WHERE id=?', [id], conn), duplicate: false };
}

/** Platform balances from the cached table. */
async function platformBalances(conn) {
  const rows = await q('SELECT code, balance_cents FROM platform_accounts', [], conn || undefined);
  return Object.fromEntries(rows.map((r) => [r.code, r.balance_cents]));
}

/** Compare cached balances against the ledger. */
async function reconcile() {
  const issues = [];
  const accounts = await q(`SELECT p.code, p.balance_cents, COALESCE(SUM(l.amount_cents),0) AS ledger_cents
    FROM platform_accounts p LEFT JOIN ledger_entries l ON l.account = p.code GROUP BY p.code, p.balance_cents`);
  for (const a of accounts) if (a.balance_cents !== a.ledger_cents) issues.push({ type: 'platform_account_mismatch', account: a.code, cached: a.balance_cents, ledger: a.ledger_cents });

  const users = await q(`SELECT u.id, u.wallet_cents, COALESCE(SUM(l.amount_cents),0) AS ledger_cents
    FROM users u LEFT JOIN ledger_entries l ON l.account='user' AND l.user_id=u.id GROUP BY u.id, u.wallet_cents HAVING u.wallet_cents <> ledger_cents`);
  for (const u of users) issues.push({ type: 'wallet_mismatch', userId: u.id, cached: u.wallet_cents, ledger: u.ledger_cents });

  const unbalanced = await q('SELECT transaction_id, SUM(amount_cents) s FROM ledger_entries GROUP BY transaction_id HAVING s <> 0');
  for (const t of unbalanced) issues.push({ type: 'transaction_unbalanced', transactionId: t.transaction_id, sum: t.s });

  const [res] = await q(`SELECT COALESCE(SUM(pool_cents),0) open_pools FROM events WHERE status NOT IN ('completed','expired','cancelled')`);
  const reserved = accounts.find((a) => a.code === 'reserved');
  if (reserved && reserved.balance_cents !== res.open_pools) issues.push({ type: 'reserved_mismatch', reserved: reserved.balance_cents, openEventPools: res.open_pools });

  const settlements = await q('SELECT event_id, pool_cents, distributed_cents, released_cents FROM event_settlements WHERE pool_cents <> distributed_cents + released_cents');
  for (const s of settlements) issues.push({ type: 'settlement_unbalanced', eventId: s.event_id });

  const walletTotal = await one('SELECT COALESCE(SUM(wallet_cents),0) total FROM users');
  return {
    ok: issues.length === 0,
    checkedAt: new Date(),
    accounts: accounts.map((a) => ({ account: a.code, balanceCents: a.balance_cents, ledgerCents: a.ledger_cents })),
    memberWalletsTotalCents: walletTotal.total,
    openEventPoolsCents: res.open_pools,
    issues,
  };
}

module.exports = { post, applyEntries, platformBalances, reconcile, PLATFORM_ACCOUNTS };
