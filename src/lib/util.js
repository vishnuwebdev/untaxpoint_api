const crypto = require('node:crypto');
const { z } = require('zod');
const { badRequest } = require('./errors');

/** Prefixed random id, e.g. evt_3f2a... (fits VARCHAR(40)). */
const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;

/** Dollars (number or string, max 2 decimals) -> integer cents. */
function toCents(amount, field = 'amount') {
  const s = String(amount ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw badRequest('invalid_amount', `${field} must be a positive amount with at most 2 decimals`);
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw badRequest('invalid_amount', `${field} is too large`);
  return cents;
}

/** Split total cents equally; the first (total % n) winners get one extra cent. */
function splitEvenly(totalCents, n) {
  const base = Math.floor(totalCents / n);
  const remainder = totalCents % n;
  return { base, remainder, payouts: Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0)) };
}

/** Great-circle distance in meters (haversine). */
function distanceMeters(aLat, aLng, bLat, bLng) {
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Validate with a zod schema, throwing a 400 with field details. */
function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw badRequest('validation_failed', 'Some fields are invalid', details);
  }
  return r.data;
}

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
function pagination(query) {
  const { page, pageSize } = parse(pageSchema, query);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
const pageMeta = (p, total) => ({ page: p.page, pageSize: p.pageSize, total, totalPages: Math.ceil(total / p.pageSize) });

/** Wrap async route handlers so errors reach the error middleware. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ok = (res, data, meta, status = 200) => res.status(status).json(meta ? { data, meta } : { data });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { newId, toCents, splitEvenly, distanceMeters, parse, pagination, pageMeta, ah, ok, sha256, z };
