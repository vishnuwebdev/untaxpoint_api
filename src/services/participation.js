const { q, one, tx } = require('../db');
const { newId, distanceMeters, parse, z } = require('../lib/util');
const { AppError, notFound } = require('../lib/errors');
const { getSettings } = require('./settings');
const { notify } = require('./notifications');

const schema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  accuracyMeters: z.coerce.number().min(0).max(100000).optional(),
  isMockLocation: z.boolean().default(false),
});

const REJECTIONS = {
  event_ended:          [409, 'This event has ended'],
  event_paused:         [409, 'This event is paused right now'],
  event_not_started:    [409, 'This event has not started yet'],
  already_participated: [409, 'You have already entered this event'],
  mock_location:        [422, 'Mock or simulated locations are not allowed'],
  low_accuracy:         [422, 'Your GPS signal is not accurate enough. Move to an open area and try again'],
  outside_radius:       [422, 'You are outside the event area'],
};

/**
 * Validate and record a participation request.
 * Ordering is decided only by the server: the event row is locked (SELECT ... FOR UPDATE),
 * so concurrent requests get strictly increasing sequence numbers and winner slots
 * can never be handed out twice. Rejected attempts are recorded too.
 */
async function participate(req, eventId, body) {
  const input = parse(schema, body);
  const settings = await getSettings();
  const userId = req.user.id;

  const result = await tx(async (conn) => {
    const ev = await one('SELECT * FROM events WHERE id=? FOR UPDATE', [eventId], conn);
    if (!ev || ev.status === 'draft' || ev.status === 'cancelled') return { notFound: true };
    const now = new Date();
    const distance = distanceMeters(Number(ev.latitude), Number(ev.longitude), input.latitude, input.longitude);

    const record = async (outcome, reason) => {
      const id = newId('req');
      await q(`INSERT INTO participation_requests (id, event_id, user_id, latitude, longitude, accuracy_meters, distance_meters,
          is_mock_location, outcome, reject_reason, ip_address, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, eventId, userId, input.latitude, input.longitude, input.accuracyMeters ?? null, Math.round(distance * 100) / 100,
        input.isMockLocation, outcome, reason || null, req.ip, now], conn);
      return id;
    };
    const reject = async (reason, extra) => { await record('rejected', reason); return { reason, extra }; };

    if (['completed', 'expired'].includes(ev.status) || now >= ev.ends_at) return reject('event_ended');
    if (ev.status === 'paused') return reject('event_paused');
    if (now < ev.starts_at) return reject('event_not_started');
    const dup = await one('SELECT id FROM participations WHERE event_id=? AND user_id=?', [eventId, userId], conn);
    if (dup) return reject('already_participated');
    if (input.isMockLocation) return reject('mock_location');
    if (input.accuracyMeters != null && input.accuracyMeters > settings.max_location_accuracy_meters) return reject('low_accuracy');
    if (distance > ev.radius_meters) return reject('outside_radius', { distanceMeters: Math.round(distance), radiusMeters: ev.radius_meters });

    const requestId = await record('accepted');
    const sequence = ev.participants_count + 1;
    const isWinner = ev.winners_count < ev.max_winners;
    const participationId = newId('part');
    await q('INSERT INTO participations (id, event_id, user_id, request_id, sequence_no, is_winner, accepted_at) VALUES (?,?,?,?,?,?,?)',
      [participationId, eventId, userId, requestId, sequence, isWinner, now], conn);
    const winners = ev.winners_count + (isWinner ? 1 : 0);
    // The event stays open until its end time even when all winner slots are taken.
    const status = winners >= ev.max_winners ? 'capacity_reached' : 'active';
    await q('UPDATE events SET participants_count=?, winners_count=?, status=? WHERE id=?', [sequence, winners, status, eventId], conn);
    await q('UPDATE users SET last_latitude=?, last_longitude=?, last_location_at=? WHERE id=?', [input.latitude, input.longitude, now, userId], conn);
    await notify(conn, userId, {
      type: 'entry_accepted', eventId,
      title: isWinner ? `You're in! Entry #${sequence}` : `Entry #${sequence} recorded`,
      body: isWinner ? `You are within the winner slots for "${ev.title}". Your reward is credited when the event ends.`
        : `All winner slots for "${ev.title}" were already taken, but your entry is recorded.`,
    });
    return { accepted: { participationId, eventId, sequence, isWinner, acceptedAt: now, distanceMeters: Math.round(distance) } };
  });

  if (result.notFound) throw notFound('event');
  if (result.reason) {
    const [status, message] = REJECTIONS[result.reason];
    throw new AppError(status, result.reason, message, result.extra);
  }
  const a = result.accepted;
  return {
    ...a,
    message: a.isWinner
      ? 'Entry accepted. You are within the winner slots; your reward is credited to your wallet when the event ends.'
      : 'Entry accepted, but all winner slots were already taken.',
  };
}

async function myParticipations(userId, page) {
  const [{ total }] = await q('SELECT COUNT(*) total FROM participations WHERE user_id=?', [userId]);
  const rows = await q(`SELECT p.*, e.title, e.status event_status, e.ends_at, e.pool_cents, e.max_winners
    FROM participations p JOIN events e ON e.id=p.event_id WHERE p.user_id=? ORDER BY p.accepted_at DESC LIMIT ? OFFSET ?`,
  [userId, page.limit, page.offset]);
  return {
    total,
    items: rows.map((r) => ({
      eventId: r.event_id, eventTitle: r.title, eventStatus: r.event_status, eventEndsAt: r.ends_at,
      sequence: r.sequence_no, isWinner: !!r.is_winner, payoutCents: r.payout_cents, acceptedAt: r.accepted_at,
      result: ['completed', 'expired'].includes(r.event_status) ? (r.payout_cents ? 'won' : 'not_won') : 'pending',
    })),
  };
}

module.exports = { participate, myParticipations };
