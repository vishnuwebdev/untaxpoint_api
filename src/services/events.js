const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const { q, one, tx } = require('../db');
const { newId, toCents, parse, z } = require('../lib/util');
const { badRequest, conflict, notFound } = require('../lib/errors');
const ledger = require('./ledger');
const { getSettings } = require('./settings');
const { adminAudit } = require('./audit');
const notifications = require('./notifications');

const FINAL = ['completed', 'expired', 'cancelled'];
const MEMBER_VISIBLE = ['scheduled', 'active', 'capacity_reached'];
const MAX_IMAGES = 10;

/** Status as the outside world should see it right now (the job may lag a few seconds). */
function displayStatus(r, now = new Date()) {
  if (FINAL.includes(r.status)) return r.status;
  if (r.status === 'draft') return 'draft';
  if (now >= r.ends_at) return 'settling';
  if (r.status === 'scheduled' && now >= r.starts_at) return r.winners_count >= r.max_winners ? 'capacity_reached' : 'active';
  return r.status;
}

const imageUrl = (p) => (p.startsWith('http') ? p : `${config.publicBaseUrl}${p}`);

function serialize(r, images = []) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    address: r.address,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    radiusMeters: r.radius_meters,
    poolCents: r.pool_cents,
    maxWinners: r.max_winners,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    timezone: r.timezone,
    status: displayStatus(r),
    storedStatus: r.status,
    participantsCount: r.participants_count,
    winnersCount: r.winners_count,
    images: images.map((i) => ({ id: i.id, url: imageUrl(i.url), path: i.url })),
    publishedAt: r.published_at,
    pausedAt: r.paused_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    settledAt: r.settled_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function imagesFor(eventIds, conn) {
  if (!eventIds.length) return {};
  const rows = await q('SELECT * FROM event_images WHERE event_id IN (?) ORDER BY sort_order, created_at', [eventIds], conn || undefined);
  const map = {};
  for (const r of rows) (map[r.event_id] ||= []).push(r);
  return map;
}

async function serializeMany(rows, conn) {
  const imgs = await imagesFor(rows.map((r) => r.id), conn);
  return rows.map((r) => serialize(r, imgs[r.id] || []));
}

// ------------------------------------------------------------------ validation
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a valid date-time');
const money = z.union([z.string(), z.number()]);
const baseFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).default(''),
  address: z.string().trim().max(400).optional().nullable(),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  radiusMeters: z.coerce.number().int().min(1).max(100000).optional(),
  poolAmount: money,
  maxWinners: z.coerce.number().int().min(1).max(100000),
  startsAt: iso,
  endsAt: iso,
  timezone: z.string().trim().min(1).max(64).default('America/New_York'),
};
const createSchema = z.object({ ...baseFields, publish: z.boolean().default(false) });
const updateSchema = z.object(Object.fromEntries(Object.entries(baseFields).map(([k, v]) => [k, v.optional()])));
// Locked once the event has started or has participants.
const COMMITTED_FIELDS = ['poolAmount', 'maxWinners', 'startsAt', 'endsAt', 'timezone'];
// Location can still be changed while the event is live (admin decision, 15 Nov 2026).
// Entries already accepted stay valid; new entries are checked against the new location.
const LOCATION_FIELDS = ['latitude', 'longitude', 'radiusMeters'];

function statusOnPublish(startsAt, now = new Date()) {
  return startsAt <= now ? 'active' : 'scheduled';
}

// ------------------------------------------------------------------ admin operations
async function createEvent(req, body) {
  const input = parse(createSchema, body);
  const poolCents = toCents(input.poolAmount, 'poolAmount');
  if (poolCents < 1) throw badRequest('invalid_amount', 'Prize pool must be greater than zero');
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (endsAt <= startsAt) throw badRequest('invalid_window', 'End time must be after start time');
  if (endsAt <= new Date()) throw badRequest('invalid_window', 'End time must be in the future');
  if (poolCents < input.maxWinners) throw badRequest('pool_too_small', 'Prize pool must give each winner at least 1 cent');

  return tx(async (conn) => {
    const settings = await getSettings(conn);
    const id = newId('evt');
    const status = input.publish ? statusOnPublish(startsAt) : 'draft';
    await q(`INSERT INTO events (id, title, description, address, latitude, longitude, radius_meters, pool_cents, max_winners,
        starts_at, ends_at, timezone, status, created_by, published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, input.title, input.description, input.address || null, input.latitude, input.longitude,
      input.radiusMeters ?? settings.default_radius_meters, poolCents, input.maxWinners, startsAt, endsAt, input.timezone,
      status, req.admin.id, input.publish ? new Date() : null], conn);
    // Reserve the prize pool from the main fund (fails if the main fund is too small).
    await ledger.post(conn, {
      kind: 'event_reservation', amountCents: poolCents, eventId: id, actorType: 'admin', actorId: req.admin.id,
      description: `Prize pool reserved for "${input.title}"`, idempotencyKey: `reserve:${id}`,
    }, [{ account: 'main', amount: -poolCents }, { account: 'reserved', amount: poolCents }]);
    await adminAudit(conn, req, 'event_created', 'event', id, { title: input.title, poolCents, maxWinners: input.maxWinners, status });
    const row = await one('SELECT * FROM events WHERE id=?', [id], conn);
    if (input.publish) await notifications.notifyNewEvent(conn, row);
    return serialize(row);
  });
}

async function lockEvent(conn, id) {
  const ev = await one('SELECT * FROM events WHERE id=? FOR UPDATE', [id], conn);
  if (!ev) throw notFound('event');
  return ev;
}

async function updateEvent(req, id, body) {
  const input = parse(updateSchema, body);
  return tx(async (conn) => {
    const ev = await lockEvent(conn, id);
    if (FINAL.includes(ev.status)) throw conflict('event_closed', `A ${ev.status} event cannot be edited`);
    const touchesCommitted = COMMITTED_FIELDS.some((f) => input[f] !== undefined);
    const started = new Date() >= ev.starts_at && ev.status !== 'draft';
    if (touchesCommitted && (ev.participants_count > 0 || started)) {
      throw conflict('event_committed', 'Prize, winners and timing cannot change after the event has started or has participants. You can still edit the location, title, description and address.');
    }
    const touchesLocation = LOCATION_FIELDS.some((f) => input[f] !== undefined);
    if (touchesLocation && started && new Date() >= ev.ends_at) {
      throw conflict('event_ended', 'This event has already ended, so its location can no longer change');
    }
    const next = {
      title: input.title ?? ev.title,
      description: input.description ?? ev.description,
      address: input.address !== undefined ? input.address : ev.address,
      latitude: input.latitude ?? Number(ev.latitude),
      longitude: input.longitude ?? Number(ev.longitude),
      radius_meters: input.radiusMeters ?? ev.radius_meters,
      pool_cents: input.poolAmount !== undefined ? toCents(input.poolAmount, 'poolAmount') : ev.pool_cents,
      max_winners: input.maxWinners ?? ev.max_winners,
      starts_at: input.startsAt ? new Date(input.startsAt) : ev.starts_at,
      ends_at: input.endsAt ? new Date(input.endsAt) : ev.ends_at,
      timezone: input.timezone ?? ev.timezone,
    };
    if (next.ends_at <= next.starts_at) throw badRequest('invalid_window', 'End time must be after start time');
    if (touchesCommitted && next.ends_at <= new Date()) throw badRequest('invalid_window', 'End time must be in the future');
    if (next.pool_cents < 1 || next.pool_cents < next.max_winners) throw badRequest('pool_too_small', 'Prize pool must give each winner at least 1 cent');

    const delta = next.pool_cents - ev.pool_cents;
    if (delta !== 0) {
      await ledger.post(conn, {
        kind: 'event_reservation_adjustment', amountCents: Math.abs(delta), eventId: id, actorType: 'admin', actorId: req.admin.id,
        description: delta > 0 ? `Prize pool increased by ${delta} cents` : `Prize pool decreased by ${-delta} cents`,
        idempotencyKey: `adjust:${id}:${newId('k')}`,
      }, [{ account: 'main', amount: -delta }, { account: 'reserved', amount: delta }]);
    }
    let status = ev.status;
    if (status === 'scheduled' || status === 'active') status = statusOnPublish(next.starts_at);
    await q(`UPDATE events SET title=?, description=?, address=?, latitude=?, longitude=?, radius_meters=?, pool_cents=?, max_winners=?,
      starts_at=?, ends_at=?, timezone=?, status=? WHERE id=?`,
    [next.title, next.description, next.address, next.latitude, next.longitude, next.radius_meters, next.pool_cents, next.max_winners,
      next.starts_at, next.ends_at, next.timezone, status, id], conn);
    const locationChanged = next.latitude !== Number(ev.latitude) || next.longitude !== Number(ev.longitude)
      || next.radius_meters !== ev.radius_meters;
    await adminAudit(conn, req, 'event_updated', 'event', id, {
      fields: Object.keys(input),
      poolDeltaCents: delta || undefined,
      location: locationChanged ? {
        from: { latitude: Number(ev.latitude), longitude: Number(ev.longitude), radiusMeters: ev.radius_meters },
        to: { latitude: next.latitude, longitude: next.longitude, radiusMeters: next.radius_meters },
        whileLive: started || ev.participants_count > 0,
      } : undefined,
    });
    const row = await one('SELECT * FROM events WHERE id=?', [id], conn);
    return serialize(row, (await imagesFor([id], conn))[id] || []);
  });
}

async function changeStatus(req, id, action, body = {}) {
  return tx(async (conn) => {
    const ev = await lockEvent(conn, id);
    const now = new Date();
    if (FINAL.includes(ev.status)) throw conflict('event_closed', `This event is already ${ev.status}`);
    if (now >= ev.ends_at && action !== 'cancel') throw conflict('event_ended', 'This event has ended and is being settled');
    let status;
    const extra = {};
    if (action === 'publish') {
      if (ev.status !== 'draft') throw conflict('invalid_transition', 'Only draft events can be published');
      status = statusOnPublish(ev.starts_at, now);
      extra.published_at = now;
    } else if (action === 'pause') {
      if (!['scheduled', 'active', 'capacity_reached'].includes(ev.status)) throw conflict('invalid_transition', 'Only published events can be paused');
      status = 'paused';
      extra.paused_at = now;
    } else if (action === 'resume') {
      if (ev.status !== 'paused') throw conflict('invalid_transition', 'Only paused events can be resumed');
      status = ev.winners_count >= ev.max_winners ? 'capacity_reached' : statusOnPublish(ev.starts_at, now);
      extra.paused_at = null;
    } else if (action === 'cancel') {
      if (ev.participants_count > 0) {
        throw conflict('event_has_participants', 'This event already has participants, so it cannot be cancelled. Pause it instead; it will settle at its end time.');
      }
      status = 'cancelled';
      extra.cancelled_at = now;
      extra.cancel_reason = String(body.reason || '').slice(0, 500) || null;
      await ledger.post(conn, {
        kind: 'event_release', amountCents: ev.pool_cents, eventId: id, actorType: 'admin', actorId: req.admin.id,
        description: `Event cancelled; prize pool returned to main fund`, idempotencyKey: `release:${id}`,
      }, [{ account: 'reserved', amount: -ev.pool_cents }, { account: 'main', amount: ev.pool_cents }]);
    } else {
      throw badRequest('invalid_action', 'Unknown action');
    }
    const sets = ['status=?', ...Object.keys(extra).map((k) => `${k}=?`)];
    await q(`UPDATE events SET ${sets.join(', ')} WHERE id=?`, [status, ...Object.values(extra), id], conn);
    await adminAudit(conn, req, `event_${action === 'cancel' ? 'cancelled' : action === 'publish' ? 'published' : action === 'pause' ? 'paused' : 'resumed'}`, 'event', id, extra.cancel_reason ? { reason: extra.cancel_reason } : null);
    const row = await one('SELECT * FROM events WHERE id=?', [id], conn);
    if (action === 'publish') await notifications.notifyNewEvent(conn, row);
    return serialize(row, (await imagesFor([id], conn))[id] || []);
  });
}

async function listEventsAdmin(filters, page) {
  const where = [];
  const params = [];
  if (filters.status) {
    const now = new Date();
    // Translate display statuses into stored-status conditions.
    if (filters.status === 'settling') { where.push("status NOT IN ('draft','completed','expired','cancelled') AND ends_at <= ?"); params.push(now); }
    else if (filters.status === 'active') { where.push("((status='active') OR (status='scheduled' AND starts_at <= ?)) AND ends_at > ?"); params.push(now, now); }
    else if (filters.status === 'scheduled') { where.push("status='scheduled' AND starts_at > ?"); params.push(now); }
    else { where.push('status=?'); params.push(filters.status); }
  }
  if (filters.q) { where.push('(title LIKE ? OR address LIKE ? OR id = ?)'); params.push(`%${filters.q}%`, `%${filters.q}%`, filters.q); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ total }] = await q(`SELECT COUNT(*) total FROM events ${w}`, params);
  const rows = await q(`SELECT * FROM events ${w} ORDER BY starts_at DESC LIMIT ? OFFSET ?`, [...params, page.limit, page.offset]);
  return { items: await serializeMany(rows), total };
}

async function getEventAdmin(id) {
  const ev = await one('SELECT * FROM events WHERE id=?', [id]);
  if (!ev) throw notFound('event');
  const images = (await imagesFor([id]))[id] || [];
  const reqStats = await q(`SELECT outcome, reject_reason, COUNT(*) n, COUNT(DISTINCT user_id) users
    FROM participation_requests WHERE event_id=? GROUP BY outcome, reject_reason`, [id]);
  const [uniq] = await q('SELECT COUNT(*) total, COUNT(DISTINCT user_id) users FROM participation_requests WHERE event_id=?', [id]);
  const participants = await q(`SELECT p.sequence_no, p.is_winner, p.payout_cents, p.accepted_at, u.id user_id, u.full_name, u.email,
      r.distance_meters FROM participations p JOIN users u ON u.id=p.user_id JOIN participation_requests r ON r.id=p.request_id
      WHERE p.event_id=? ORDER BY p.sequence_no`, [id]);
  const settlement = await one('SELECT * FROM event_settlements WHERE event_id=?', [id]);
  const txns = await q('SELECT id, kind, status, amount_cents, user_id, description, created_at FROM transactions WHERE event_id=? ORDER BY created_at', [id]);
  const rejections = {};
  for (const s of reqStats) if (s.outcome === 'rejected') rejections[s.reject_reason] = s.n;
  return {
    ...serialize(ev, images),
    stats: {
      totalRequests: uniq.total,
      uniqueUsers: uniq.users,
      acceptedParticipants: ev.participants_count,
      winners: ev.winners_count,
      rejectedRequests: Object.values(rejections).reduce((a, b) => a + b, 0),
      rejectionsByReason: rejections,
    },
    participants: participants.map((p) => ({
      sequence: p.sequence_no, isWinner: !!p.is_winner, payoutCents: p.payout_cents, acceptedAt: p.accepted_at,
      distanceMeters: p.distance_meters, user: { id: p.user_id, fullName: p.full_name, email: p.email },
    })),
    settlement: settlement && {
      settledAt: settlement.settled_at, poolCents: settlement.pool_cents, maxWinners: settlement.max_winners,
      totalRequests: settlement.total_requests, uniqueUsers: settlement.unique_users, acceptedParticipants: settlement.accepted_participants,
      rejectedRequests: settlement.rejected_requests, duplicateRequests: settlement.duplicate_requests, outOfRadius: settlement.out_of_radius,
      outsideWindow: settlement.outside_window, winnerCount: settlement.winner_count, payoutBaseCents: settlement.payout_base_cents,
      remainderCents: settlement.remainder_cents, distributedCents: settlement.distributed_cents, releasedCents: settlement.released_cents,
      report: typeof settlement.report === 'string' ? JSON.parse(settlement.report) : settlement.report,
    },
    transactions: txns.map((t) => ({ id: t.id, kind: t.kind, status: t.status, amountCents: t.amount_cents, userId: t.user_id, description: t.description, createdAt: t.created_at })),
  };
}

async function addImages(req, id, files) {
  const ev = await one('SELECT id, status FROM events WHERE id=?', [id]);
  if (!ev) throw notFound('event');
  const [{ n }] = await q('SELECT COUNT(*) n FROM event_images WHERE event_id=?', [id]);
  if (n + files.length > MAX_IMAGES) throw badRequest('too_many_images', `An event can have at most ${MAX_IMAGES} images`);
  const dir = path.join(config.uploadDir, 'events', id);
  await fs.mkdir(dir, { recursive: true });
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  let order = n;
  for (const f of files) {
    const imgId = newId('img');
    const fileName = `${imgId}${ext[f.mimetype]}`;
    await fs.writeFile(path.join(dir, fileName), f.buffer);
    await q('INSERT INTO event_images (id, event_id, file_name, url, sort_order) VALUES (?,?,?,?,?)',
      [imgId, id, f.originalname.slice(0, 255), `/uploads/events/${id}/${fileName}`, order++]);
  }
  await adminAudit(null, req, 'event_images_added', 'event', id, { count: files.length });
  return ((await imagesFor([id]))[id] || []).map((i) => ({ id: i.id, url: imageUrl(i.url), path: i.url }));
}

async function deleteImage(req, id, imageId) {
  const img = await one('SELECT * FROM event_images WHERE id=? AND event_id=?', [imageId, id]);
  if (!img) throw notFound('image');
  await q('DELETE FROM event_images WHERE id=?', [imageId]);
  await fs.rm(path.join(config.uploadDir, 'events', id, path.basename(img.url)), { force: true });
  await adminAudit(null, req, 'event_image_deleted', 'event', id, { imageId });
}

// ------------------------------------------------------------------ member queries
async function listEventsForMember({ lat, lng, radiusKm, filter, q: search }) {
  const now = new Date();
  let where = `status IN ('scheduled','active','capacity_reached') AND ends_at > ?`;
  const params = [now];
  if (filter === 'active') { where += ' AND starts_at <= ?'; params.push(now); }
  if (filter === 'upcoming') { where += ' AND starts_at > ?'; params.push(now); }
  if (search) { where += ' AND (title LIKE ? OR address LIKE ? OR description LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (lat != null && lng != null && radiusKm) {
    // Bounding-box prefilter on the (latitude, longitude) index; exact distance below.
    const dLat = radiusKm / 111.32;
    const dLng = radiusKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    where += ' AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?';
    params.push(lat - dLat, lat + dLat, lng - dLng, lng + dLng);
  }
  const rows = await q(`SELECT * FROM events WHERE ${where} ORDER BY starts_at LIMIT 500`, params);
  const { distanceMeters } = require('../lib/util');
  let items = (await serializeMany(rows)).map((e) => ({
    ...e,
    distanceMeters: lat != null && lng != null ? Math.round(distanceMeters(lat, lng, e.latitude, e.longitude)) : null,
  }));
  if (lat != null && lng != null) {
    if (radiusKm) items = items.filter((e) => e.distanceMeters <= radiusKm * 1000);
    items.sort((a, b) => a.distanceMeters - b.distanceMeters);
  }
  return items.map(memberView);
}

/** Strip admin-only fields. */
function memberView(e) {
  const { storedStatus, createdAt, updatedAt, publishedAt, pausedAt, cancelledAt, cancelReason, ...rest } = e;
  return { ...rest, images: rest.images.map(({ id, url }) => ({ id, url })), spotsLeft: Math.max(e.maxWinners - e.winnersCount, 0) };
}

async function getEventForMember(id, userId) {
  const ev = await one('SELECT * FROM events WHERE id=?', [id]);
  if (!ev || ev.status === 'draft' || ev.status === 'cancelled') throw notFound('event');
  const images = (await imagesFor([id]))[id] || [];
  const mine = await one('SELECT sequence_no, is_winner, payout_cents, accepted_at FROM participations WHERE event_id=? AND user_id=?', [id, userId]);
  return {
    ...memberView(serialize(ev, images)),
    myParticipation: mine && { sequence: mine.sequence_no, isWinner: !!mine.is_winner, payoutCents: mine.payout_cents, acceptedAt: mine.accepted_at },
  };
}

module.exports = {
  createEvent, updateEvent, changeStatus, listEventsAdmin, getEventAdmin, addImages, deleteImage,
  listEventsForMember, getEventForMember, serialize, displayStatus, FINAL, MEMBER_VISIBLE,
};
