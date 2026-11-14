/**
 * Automatic event settlement. Triggered by the scheduler once an event's end time passes.
 *
 * Idempotent: the event row is locked and only non-final events are settled, the settlement
 * row has the event id as primary key, and every payout/release uses a unique idempotency key.
 * Running it twice can never pay twice.
 */
const { q, one, tx } = require('../db');
const { splitEvenly } = require('../lib/util');
const ledger = require('./ledger');
const { audit } = require('./audit');
const { notify, money } = require('./notifications');

async function settleEvent(eventId) {
  return tx(async (conn) => {
    const ev = await one('SELECT * FROM events WHERE id=? FOR UPDATE', [eventId], conn);
    const now = new Date();
    if (!ev || ['completed', 'expired', 'cancelled'].includes(ev.status) || now < ev.ends_at) return null;

    const reqs = await one(`SELECT COUNT(*) total, COUNT(DISTINCT user_id) users,
        SUM(outcome='rejected') rejected,
        SUM(reject_reason='already_participated') duplicates,
        SUM(reject_reason='outside_radius') out_of_radius,
        SUM(reject_reason IN ('event_ended','event_not_started','event_paused')) outside_window
      FROM participation_requests WHERE event_id=?`, [eventId], conn);
    const byReason = await q(`SELECT reject_reason, COUNT(*) n FROM participation_requests
      WHERE event_id=? AND outcome='rejected' GROUP BY reject_reason`, [eventId], conn);

    const winners = ev.status === 'draft' ? [] : await q(
      'SELECT id, user_id, sequence_no FROM participations WHERE event_id=? AND is_winner ORDER BY sequence_no LIMIT ?',
      [eventId, ev.max_winners], conn);

    let distributed = 0;
    let released = 0;
    let split = { base: 0, remainder: 0, payouts: [] };
    const winnerReport = [];

    if (winners.length) {
      split = splitEvenly(ev.pool_cents, winners.length);
      for (const [i, w] of winners.entries()) {
        const amount = split.payouts[i];
        const { transaction } = await ledger.post(conn, {
          kind: 'reward_credit', amountCents: amount, userId: w.user_id, eventId, actorType: 'system',
          description: `Reward for "${ev.title}" (entry #${w.sequence_no})`, idempotencyKey: `reward:${eventId}:${w.user_id}`,
        }, [{ account: 'reserved', amount: -amount }, { account: 'user', userId: w.user_id, amount }]);
        await q('UPDATE participations SET payout_cents=? WHERE id=?', [amount, w.id], conn);
        distributed += amount;
        winnerReport.push({ userId: w.user_id, sequence: w.sequence_no, payoutCents: amount, transactionId: transaction.id });
      }
    } else {
      released = ev.pool_cents;
      await ledger.post(conn, {
        kind: 'event_release', amountCents: released, eventId, actorType: 'system',
        description: ev.status === 'draft' ? `Unpublished event "${ev.title}" expired; pool returned to main fund`
          : `No eligible participants for "${ev.title}"; pool returned to main fund`,
        idempotencyKey: `release:${eventId}`,
      }, [{ account: 'reserved', amount: -released }, { account: 'main', amount: released }]);
    }

    const report = {
      eventTitle: ev.title,
      startsAt: ev.starts_at,
      endsAt: ev.ends_at,
      neverPublished: ev.status === 'draft',
      rejectionsByReason: Object.fromEntries(byReason.map((r) => [r.reject_reason, r.n])),
      winners: winnerReport,
      accounting: { poolCents: ev.pool_cents, distributedCents: distributed, releasedCents: released, balanced: ev.pool_cents === distributed + released },
    };
    await q(`INSERT INTO event_settlements (event_id, pool_cents, max_winners, total_requests, unique_users, accepted_participants,
        rejected_requests, duplicate_requests, out_of_radius, outside_window, winner_count, payout_base_cents, remainder_cents,
        distributed_cents, released_cents, report, settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [eventId, ev.pool_cents, ev.max_winners, reqs.total, reqs.users, ev.participants_count, Number(reqs.rejected || 0),
      Number(reqs.duplicates || 0), Number(reqs.out_of_radius || 0), Number(reqs.outside_window || 0), winners.length,
      split.base, split.remainder, distributed, released, JSON.stringify(report), now], conn);

    // Tell every participant how it went.
    const paid = new Map(winnerReport.map((w) => [w.userId, w.payoutCents]));
    const everyone = await q('SELECT user_id FROM participations WHERE event_id=?', [eventId], conn);
    for (const p of everyone) {
      const amount = paid.get(p.user_id);
      await notify(conn, p.user_id, amount
        ? { type: 'reward_credited', eventId, title: `You won ${money(amount)}!`, body: `Your reward for "${ev.title}" is now in your wallet.` }
        : { type: 'event_result', eventId, title: `"${ev.title}" has ended`, body: 'All winner slots were taken before your entry. Better luck next time!' });
    }

    const status = winners.length ? 'completed' : 'expired';
    await q('UPDATE events SET status=?, settled_at=? WHERE id=?', [status, now, eventId], conn);
    await audit(conn, { actorType: 'system', action: 'event_settled', targetType: 'event', targetId: eventId,
      details: { status, winners: winners.length, distributedCents: distributed, releasedCents: released } });
    return { eventId, status, winners: winners.length, distributedCents: distributed, releasedCents: released };
  });
}

/** Settle every event whose end time has passed. Each event settles in its own transaction. */
async function settleDueEvents() {
  const due = await q(`SELECT id FROM events WHERE status NOT IN ('completed','expired','cancelled') AND ends_at <= UTC_TIMESTAMP(3)
    ORDER BY ends_at LIMIT 200`);
  const results = [];
  for (const { id } of due) {
    try {
      const r = await settleEvent(id);
      if (r) results.push(r);
    } catch (err) {
      console.error(`settlement failed for ${id}:`, err.message);
      await audit(null, { actorType: 'system', action: 'event_settlement_failed', targetType: 'event', targetId: id, details: { error: err.message } }).catch(() => {});
      results.push({ eventId: id, error: err.message });
    }
  }
  return results;
}

/** Move scheduled events whose start time has passed to active. */
async function activateStartedEvents() {
  const [r] = await require('../db').pool.query(
    "UPDATE events SET status='active' WHERE status='scheduled' AND starts_at <= UTC_TIMESTAMP(3) AND ends_at > UTC_TIMESTAMP(3)");
  return r.affectedRows;
}

module.exports = { settleEvent, settleDueEvents, activateStartedEvents };
