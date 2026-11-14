const { q, one, tx } = require('../db');
const { newId, toCents, parse, z } = require('../lib/util');
const { badRequest, conflict, notFound, AppError } = require('../lib/errors');
const ledger = require('./ledger');
const { getSettings } = require('./settings');
const { audit, adminAudit } = require('./audit');
const { provider } = require('./payments');
const { notify } = require('./notifications');

const dollars = (c) => `$${(c / 100).toFixed(2)}`;

// ------------------------------------------------------------------ platform funding (admin)
async function fundPlatform(req, body, idemKey) {
  const input = parse(z.object({ amount: z.union([z.string(), z.number()]), note: z.string().max(500).optional() }), body);
  const amountCents = toCents(input.amount);
  if (amountCents < 1) throw badRequest('invalid_amount', 'Amount must be greater than zero');
  const key = `fund:${req.admin.id}:${idemKey || newId('k')}`;
  const prior = await one('SELECT * FROM transactions WHERE idempotency_key=?', [key]);
  if (prior) return { transaction: serializeTxn(prior), balances: await ledger.platformBalances(), duplicate: true };

  // Confirm with the provider server-side before crediting anything.
  const p = provider();
  const charge = await p.chargePlatformFunding({ amountCents, currency: 'USD', reference: key });
  if (charge.status !== 'completed') throw new AppError(402, 'payment_not_confirmed', charge.failureReason || 'The payment was not confirmed by the provider');

  return tx(async (conn) => {
    const { transaction, duplicate } = await ledger.post(conn, {
      kind: 'platform_funding', amountCents, actorType: 'admin', actorId: req.admin.id, description: input.note || 'Platform funding',
      provider: p.name, providerRef: charge.providerRef, idempotencyKey: key,
    }, [{ account: 'external', amount: -amountCents }, { account: 'main', amount: amountCents }]);
    if (!duplicate) await adminAudit(conn, req, 'platform_funded', 'transaction', transaction.id, { amountCents, providerRef: charge.providerRef });
    return { transaction: serializeTxn(transaction), balances: await ledger.platformBalances(conn), duplicate };
  });
}

function serializeTxn(t) {
  return {
    id: t.id, kind: t.kind, status: t.status, amountCents: t.amount_cents, currency: t.currency,
    userId: t.user_id, eventId: t.event_id, withdrawalId: t.withdrawal_id, actorType: t.actor_type, actorId: t.actor_id,
    description: t.description, provider: t.provider, providerRef: t.provider_ref, createdAt: t.created_at, updatedAt: t.updated_at,
    ...(t.user_name !== undefined ? { userName: t.user_name, userEmail: t.user_email } : {}),
    ...(t.event_title !== undefined ? { eventTitle: t.event_title } : {}),
  };
}

// ------------------------------------------------------------------ wallet
async function walletSummary(userId, conn) {
  const u = await one('SELECT wallet_cents FROM users WHERE id=?', [userId], conn);
  if (!u) throw notFound('user');
  const t = await one(`SELECT
      COALESCE(SUM(CASE WHEN kind='reward_credit' THEN amount_cents END),0) earned,
      COALESCE(SUM(CASE WHEN kind='donation' THEN amount_cents END),0) donated,
      COALESCE(SUM(CASE WHEN kind='reward_credit' THEN 1 END),0) wins
    FROM transactions WHERE user_id=? AND status='completed'`, [userId], conn);
  const w = await one(`SELECT
      COALESCE(SUM(CASE WHEN status='completed' THEN amount_cents END),0) withdrawn,
      COALESCE(SUM(CASE WHEN status IN ('requested','processing','pending','on_hold') THEN amount_cents END),0) pending
    FROM withdrawals WHERE user_id=?`, [userId], conn);
  const p = await one('SELECT COUNT(*) n FROM participations WHERE user_id=?', [userId], conn);
  return {
    availableCents: u.wallet_cents,
    pendingWithdrawalCents: w.pending,
    totalEarnedCents: t.earned,
    totalWithdrawnCents: w.withdrawn,
    totalDonatedCents: t.donated,
    eventsEntered: p.n,
    eventsWon: t.wins,
    currency: 'USD',
  };
}

async function userTransactions(userId, page, kind) {
  const params = [userId];
  let w = 't.user_id=?';
  if (kind) { w += ' AND t.kind=?'; params.push(kind); }
  const [{ total }] = await q(`SELECT COUNT(*) total FROM transactions t WHERE ${w}`, params);
  const rows = await q(`SELECT t.*, e.title event_title FROM transactions t LEFT JOIN events e ON e.id=t.event_id
    WHERE ${w} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`, [...params, page.limit, page.offset]);
  return { total, items: rows.map(serializeTxn) };
}

// ------------------------------------------------------------------ payout account (member)
async function getPayoutAccount(userId) {
  const a = await one('SELECT * FROM user_payout_accounts WHERE user_id=?', [userId]);
  return a && {
    method: a.method, paypalEmail: a.paypal_email, accountHolderName: a.account_holder_name,
    bankName: a.bank_name, bankAccountLast4: a.bank_account_last4, updatedAt: a.updated_at,
  };
}

async function setPayoutAccount(req, body) {
  const input = parse(z.discriminatedUnion('method', [
    z.object({ method: z.literal('paypal'), paypalEmail: z.string().email().max(255) }),
    z.object({ method: z.literal('bank'), accountHolderName: z.string().trim().min(1).max(160), bankName: z.string().trim().min(1).max(160),
      bankAccountLast4: z.string().regex(/^\d{4}$/, 'must be the last 4 digits') }),
  ]), body);
  await q(`INSERT INTO user_payout_accounts (user_id, method, paypal_email, account_holder_name, bank_name, bank_account_last4)
    VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE method=VALUES(method), paypal_email=VALUES(paypal_email),
    account_holder_name=VALUES(account_holder_name), bank_name=VALUES(bank_name), bank_account_last4=VALUES(bank_account_last4)`,
  [req.user.id, input.method, input.paypalEmail || null, input.accountHolderName || null, input.bankName || null, input.bankAccountLast4 || null]);
  await audit(null, { actorType: 'user', actorId: req.user.id, action: 'payout_account_updated', targetType: 'user', targetId: req.user.id, ip: req.ip });
  return getPayoutAccount(req.user.id);
}

// ------------------------------------------------------------------ withdrawals
function serializeWithdrawal(w) {
  return {
    id: w.id, userId: w.user_id, amountCents: w.amount_cents, currency: w.currency, status: w.status, method: w.method,
    destination: w.destination, provider: w.provider, providerRef: w.provider_ref, holdReason: w.hold_reason,
    failureReason: w.failure_reason, reviewedBy: w.reviewed_by, reviewedAt: w.reviewed_at, reviewNote: w.review_note,
    completedAt: w.completed_at, createdAt: w.created_at, updatedAt: w.updated_at,
    ...(w.user_name !== undefined ? { userName: w.user_name, userEmail: w.user_email } : {}),
  };
}

async function requestWithdrawal(req, body, idemKey) {
  const input = parse(z.object({ amount: z.union([z.string(), z.number()]) }), body);
  const amountCents = toCents(input.amount);
  const settings = await getSettings();
  if (amountCents < settings.min_withdrawal_cents) throw badRequest('below_minimum', `The minimum withdrawal is ${dollars(settings.min_withdrawal_cents)}`);
  if (amountCents > settings.max_withdrawal_cents) throw badRequest('above_maximum', `The maximum withdrawal is ${dollars(settings.max_withdrawal_cents)}`);
  const account = await one('SELECT * FROM user_payout_accounts WHERE user_id=?', [req.user.id]);
  if (!account) throw conflict('payout_account_missing', 'Add your payout account details before withdrawing');
  const destination = account.method === 'paypal' ? account.paypal_email : `${account.bank_name} ****${account.bank_account_last4}`;
  const key = `wd:${req.user.id}:${idemKey || newId('k')}`;

  const withdrawal = await tx(async (conn) => {
    const prior = await one('SELECT withdrawal_id FROM transactions WHERE idempotency_key=?', [key], conn);
    if (prior) return one('SELECT * FROM withdrawals WHERE id=?', [prior.withdrawal_id], conn);
    const user = await one('SELECT is_flagged FROM users WHERE id=?', [req.user.id], conn);
    const holdReason = user.is_flagged ? 'Account is flagged for review'
      : amountCents >= settings.withdrawal_hold_threshold_cents ? `Amount is at or above the review threshold (${dollars(settings.withdrawal_hold_threshold_cents)})` : null;
    const id = newId('wd');
    await q(`INSERT INTO withdrawals (id, user_id, amount_cents, status, method, destination, provider, hold_reason)
      VALUES (?,?,?,?,?,?,?,?)`, [id, req.user.id, amountCents, holdReason ? 'on_hold' : 'requested', account.method, destination, provider().name, holdReason], conn);
    // Money leaves the wallet immediately into "withdrawals in progress".
    await ledger.post(conn, {
      kind: 'withdrawal', status: 'pending', amountCents, userId: req.user.id, withdrawalId: id, actorType: 'user', actorId: req.user.id,
      description: `Withdrawal to ${destination}`, idempotencyKey: key,
    }, [{ account: 'user', userId: req.user.id, amount: -amountCents }, { account: 'payouts_pending', amount: amountCents }]);
    await audit(conn, { actorType: 'user', actorId: req.user.id, action: 'withdrawal_requested', targetType: 'withdrawal', targetId: id, details: { amountCents, onHold: !!holdReason }, ip: req.ip });
    if (holdReason) {
      await notify(conn, req.user.id, { type: 'withdrawal_on_hold', title: `Withdrawal of ${dollars(amountCents)} is being reviewed`,
        body: 'Larger withdrawals are checked by our team first. We will let you know as soon as it is sent.', data: { withdrawalId: id } });
    }
    return one('SELECT * FROM withdrawals WHERE id=?', [id], conn);
  });

  if (withdrawal.status === 'requested') return serializeWithdrawal(await processWithdrawal(withdrawal.id));
  return serializeWithdrawal(withdrawal);
}

/** Send a 'requested' withdrawal to the provider and apply the result. Safe to call repeatedly. */
async function processWithdrawal(id) {
  const [claim] = await require('../db').pool.query("UPDATE withdrawals SET status='processing' WHERE id=? AND status='requested'", [id]);
  const w = await one('SELECT * FROM withdrawals WHERE id=?', [id]);
  if (!claim.affectedRows) return w;
  let result;
  try {
    result = await provider().sendPayout({ withdrawalId: w.id, amountCents: w.amount_cents, currency: w.currency, method: w.method, destination: w.destination });
  } catch (err) {
    // Unknown outcome: leave it 'processing' for reconciliation rather than guessing.
    await audit(null, { actorType: 'system', action: 'withdrawal_provider_error', targetType: 'withdrawal', targetId: id, details: { error: err.message } });
    return one('SELECT * FROM withdrawals WHERE id=?', [id]);
  }
  return applyPayoutResult(id, result);
}

/** Apply a provider result (also the entry point for future provider webhooks). */
async function applyPayoutResult(id, result) {
  return tx(async (conn) => {
    const w = await one('SELECT * FROM withdrawals WHERE id=? FOR UPDATE', [id], conn);
    if (!['processing', 'pending'].includes(w.status)) return w;
    const txn = await one("SELECT * FROM transactions WHERE withdrawal_id=? AND kind='withdrawal'", [id], conn);
    if (result.status === 'completed') {
      await ledger.applyEntries(conn, txn.id, [{ account: 'payouts_pending', amount: -w.amount_cents }, { account: 'external', amount: w.amount_cents }]);
      await q("UPDATE transactions SET status='completed', provider=?, provider_ref=? WHERE id=?", [w.provider, result.providerRef, txn.id], conn);
      await q("UPDATE withdrawals SET status='completed', provider_ref=?, completed_at=UTC_TIMESTAMP(3) WHERE id=?", [result.providerRef, id], conn);
      await notify(conn, w.user_id, { type: 'withdrawal_completed', title: `${dollars(w.amount_cents)} sent to ${w.destination}`,
        body: 'Your withdrawal is complete.', data: { withdrawalId: id } });
    } else if (result.status === 'pending') {
      await q("UPDATE withdrawals SET status='pending', provider_ref=? WHERE id=?", [result.providerRef, id], conn);
      await q('UPDATE transactions SET provider=?, provider_ref=? WHERE id=?', [w.provider, result.providerRef, txn.id], conn);
    } else {
      await reverse(conn, w, txn, 'failed', result.failureReason || 'Payout failed');
      await notify(conn, w.user_id, { type: 'withdrawal_failed', title: `Withdrawal of ${dollars(w.amount_cents)} failed`,
        body: 'The money is back in your wallet. Please check your payout account and try again.', data: { withdrawalId: id } });
      await q('UPDATE withdrawals SET provider_ref=? WHERE id=?', [result.providerRef || null, id], conn);
    }
    await audit(conn, { actorType: 'system', action: `withdrawal_${result.status}`, targetType: 'withdrawal', targetId: id, details: { providerRef: result.providerRef } });
    return one('SELECT * FROM withdrawals WHERE id=?', [id], conn);
  });
}

/** Return withdrawal money to the member's wallet. */
async function reverse(conn, w, txn, newStatus, reason) {
  await ledger.post(conn, {
    kind: 'withdrawal_reversal', amountCents: w.amount_cents, userId: w.user_id, withdrawalId: w.id, actorType: 'system',
    description: `Withdrawal ${newStatus}: money returned to wallet`, idempotencyKey: `wdrev:${w.id}`,
  }, [{ account: 'payouts_pending', amount: -w.amount_cents }, { account: 'user', userId: w.user_id, amount: w.amount_cents }]);
  await q("UPDATE transactions SET status=? WHERE id=?", [newStatus === 'failed' ? 'failed' : 'reversed', txn.id], conn);
  await q('UPDATE withdrawals SET status=?, failure_reason=? WHERE id=?', [newStatus, reason, w.id], conn);
}

async function reviewWithdrawal(req, id, action, note) {
  const w = await tx(async (conn) => {
    const w = await one('SELECT * FROM withdrawals WHERE id=? FOR UPDATE', [id], conn);
    if (!w) throw notFound('withdrawal');
    if (w.status !== 'on_hold') throw conflict('invalid_transition', `Only withdrawals on hold can be ${action}d (this one is ${w.status})`);
    const reviewNote = String(note || '').slice(0, 500) || null;
    if (action === 'approve') {
      await q("UPDATE withdrawals SET status='requested', reviewed_by=?, reviewed_at=UTC_TIMESTAMP(3), review_note=? WHERE id=?", [req.admin.id, reviewNote, id], conn);
    } else {
      const txn = await one("SELECT * FROM transactions WHERE withdrawal_id=? AND kind='withdrawal'", [id], conn);
      await q('UPDATE withdrawals SET reviewed_by=?, reviewed_at=UTC_TIMESTAMP(3), review_note=? WHERE id=?', [req.admin.id, reviewNote, id], conn);
      await reverse(conn, w, txn, 'rejected', reviewNote || 'Rejected by administrator');
      await notify(conn, w.user_id, { type: 'withdrawal_rejected', title: `Withdrawal of ${dollars(w.amount_cents)} was not approved`,
        body: `${reviewNote || 'Please contact support.'} The money is back in your wallet.`, data: { withdrawalId: id } });
    }
    await adminAudit(conn, req, `withdrawal_${action}d`, 'withdrawal', id, { note: reviewNote });
    return one('SELECT * FROM withdrawals WHERE id=?', [id], conn);
  });
  if (action === 'approve') return serializeWithdrawal(await processWithdrawal(id));
  return serializeWithdrawal(w);
}

/** Crash recovery: send withdrawals stuck in 'requested'. */
async function processQueuedWithdrawals() {
  const rows = await q("SELECT id FROM withdrawals WHERE status='requested' AND updated_at < UTC_TIMESTAMP(3) - INTERVAL 30 SECOND LIMIT 50");
  for (const r of rows) await processWithdrawal(r.id).catch((e) => console.error('withdrawal processing failed', r.id, e.message));
  return rows.length;
}

// ------------------------------------------------------------------ donations
async function donate(req, body, idemKey) {
  const input = parse(z.object({ amount: z.union([z.string(), z.number()]), note: z.string().max(300).optional() }), body);
  const amountCents = toCents(input.amount);
  const settings = await getSettings();
  if (amountCents < settings.min_donation_cents) throw badRequest('below_minimum', `The minimum donation is ${dollars(settings.min_donation_cents)}`);
  return tx(async (conn) => {
    const { transaction, duplicate } = await ledger.post(conn, {
      kind: 'donation', amountCents, userId: req.user.id, actorType: 'user', actorId: req.user.id,
      description: input.note ? `Donation: ${input.note}` : 'Donation', idempotencyKey: `don:${req.user.id}:${idemKey || newId('k')}`,
    }, [{ account: 'user', userId: req.user.id, amount: -amountCents }, { account: 'donations', amount: amountCents }]);
    if (!duplicate) {
      await audit(conn, { actorType: 'user', actorId: req.user.id, action: 'donation_made', targetType: 'transaction', targetId: transaction.id, details: { amountCents }, ip: req.ip });
      await notify(conn, req.user.id, { type: 'donation_completed', title: `Thank you for donating ${dollars(amountCents)}`,
        body: 'Your donation helps keep UNTAXPOINT events going.' });
    }
    return { donation: serializeTxn(transaction), wallet: await walletSummary(req.user.id, conn) };
  });
}

module.exports = {
  fundPlatform, walletSummary, userTransactions, getPayoutAccount, setPayoutAccount,
  requestWithdrawal, processWithdrawal, applyPayoutResult, reviewWithdrawal, processQueuedWithdrawals,
  donate, serializeTxn, serializeWithdrawal,
};
