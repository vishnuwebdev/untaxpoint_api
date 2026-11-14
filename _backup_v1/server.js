require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });
const http = require('node:http');
const path = require('node:path');

const config = require('./config.json');
const { createJsonRepo } = require('./src/repo-json');
const { createMysqlRepo } = require('./src/repo-mysql');

const storage = (process.env.STORAGE || config.storage || 'json').toLowerCase();
const repo = storage === 'mysql'
  ? createMysqlRepo({
      host: process.env.DB_HOST || config.mysql.host,
      port: process.env.DB_PORT || config.mysql.port,
      database: process.env.DB_NAME || config.mysql.database,
      user: process.env.DB_USER || config.mysql.user,
      password: process.env.DB_PASSWORD ?? config.mysql.password,
    })
  : createJsonRepo(path.resolve(__dirname, config.storageFile));

const cents = (amount) => { const n = Number(amount); if (!Number.isFinite(n) || n < 0) throw new Error('amount_invalid'); return Math.round(n * 100); };
function send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-admin-key', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); res.end(JSON.stringify(body)); }
async function body(req) { let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; }
function distanceMeters(aLat, aLng, bLat, bLng) { const rad = (x) => x * Math.PI / 180; const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng); const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2; return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); }
const isAdmin = (req) => req.headers['x-admin-key'] === config.adminDemoKey;

async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://localhost'); const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/health') { await repo.ping(); return send(res, 200, { ok: true, mode: repo.mode, paymentMode: config.paymentMode }); }
    if (req.method === 'GET' && url.pathname === '/api/events') { await repo.settleDue(); return send(res, 200, await repo.listEvents()); }
    if (req.method === 'GET' && url.pathname === '/api/users') return send(res, 200, await repo.listUsers());
    if (req.method === 'GET' && url.pathname === '/api/transactions') return send(res, 200, await repo.listTransactions());
    if (req.method === 'GET' && url.pathname === '/api/admin/summary') return send(res, 200, await repo.summary());
    if (req.method === 'POST' && url.pathname === '/api/admin/fund') {
      if (!isAdmin(req)) return send(res, 401, { error: 'admin_unauthorized' });
      const b = await body(req);
      return send(res, 201, await repo.fund(cents(b.amount), String(b.note || '')));
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/events') {
      if (!isAdmin(req)) return send(res, 401, { error: 'admin_unauthorized' });
      const b = await body(req), pool = cents(b.poolAmount), maxWinners = Math.floor(Number(b.maxWinners));
      if (!b.title || !Number.isFinite(maxWinners) || maxWinners < 1 || !Number.isFinite(Date.parse(b.startsAt)) || !Number.isFinite(Date.parse(b.endsAt)) || Date.parse(b.endsAt) <= Date.parse(b.startsAt)) return send(res, 400, { error: 'event_fields_invalid' });
      return send(res, 201, await repo.createEvent({
        title: String(b.title), description: String(b.description || ''), address: String(b.address || ''),
        latitude: Number(b.latitude || 0), longitude: Number(b.longitude || 0), radiusMeters: Number(b.radiusMeters || 250),
        poolCents: pool, maxWinners, startsAt: new Date(b.startsAt).toISOString(), endsAt: new Date(b.endsAt).toISOString(),
        status: Date.parse(b.startsAt) <= Date.now() ? 'active' : 'scheduled',
      }));
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'events' && parts[3] === 'participate') {
      const eventId = parts[2], b = await body(req), userId = String(b.userId || 'user_demo');
      const result = await repo.participate(eventId, userId, (ev, user, already) => {
        if (!user || user.status !== 'active') throw new Error('user_ineligible');
        if (!['active', 'capacity_reached'].includes(ev.status)) throw new Error('event_not_active');
        if (Date.now() < Date.parse(ev.startsAt) || Date.now() >= Date.parse(ev.endsAt)) throw new Error('event_outside_window');
        if (already) throw new Error('already_participated');
        if (b.latitude == null || b.longitude == null || distanceMeters(ev.latitude, ev.longitude, Number(b.latitude), Number(b.longitude)) > ev.radiusMeters) throw new Error('outside_event_radius');
      });
      return send(res, 201, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/settle-due') { if (!isAdmin(req)) return send(res, 401, { error: 'admin_unauthorized' }); return send(res, 200, { settled: await repo.settleDue() }); }
    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e.code && /^(ER_|ECONN|PROTOCOL_)/.test(e.code)) { console.error('database error:', e.code, e.message); return send(res, 503, { error: 'database_unavailable' }); }
    const status = e.message === 'event_not_found' ? 404 : e.message === 'insufficient_platform_funds' ? 409 : e.message === 'admin_unauthorized' ? 401 : 400;
    return send(res, status, { error: e.message || 'request_failed' });
  }
}

setInterval(() => repo.settleDue().catch((err) => console.error('settlement error', err.message)), 15000).unref();
repo.ping()
  .then(() => console.log(`Storage: ${repo.mode}${storage === 'mysql' ? ` (connected to ${process.env.DB_NAME || config.mysql.database})` : ''}`))
  .catch((err) => console.error(`Storage: ${repo.mode} — could not connect yet: ${err.code || ''} ${err.message}`));
http.createServer(handler).listen(config.port, () => console.log(`UNTAXPOINT API listening on http://localhost:${config.port}`));
