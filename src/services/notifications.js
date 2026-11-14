/**
 * In-app notifications. Rows are written inside the same transaction as the business action
 * (pass conn), so a notification never exists for something that was rolled back.
 * Push delivery (FCM) will read these rows later.
 */
const { q, one } = require('../db');

const money = (c) => `$${(c / 100).toFixed(2)}`;

async function notify(conn, userId, { type, title, body, eventId = null, data = null }) {
  await q('INSERT INTO notifications (user_id, type, title, body, event_id, data) VALUES (?,?,?,?,?,?)',
    [userId, type, title.slice(0, 160), body.slice(0, 500), eventId, data ? JSON.stringify(data) : null], conn || undefined);
}

/** A newly published event: tell every active member. */
async function notifyNewEvent(conn, ev) {
  const body = `${money(ev.pool_cents ?? ev.poolCents)} prize for up to ${ev.max_winners ?? ev.maxWinners} winners${ev.address ? ` · ${ev.address}` : ''}`;
  await q(`INSERT INTO notifications (user_id, type, title, body, event_id)
    SELECT id, 'new_event', ?, ?, ? FROM users WHERE status='active'`,
  [`New event: ${String(ev.title).slice(0, 140)}`, body.slice(0, 500), ev.id], conn || undefined);
}

function serialize(n) {
  return {
    id: n.id, type: n.type, title: n.title, body: n.body, eventId: n.event_id,
    data: typeof n.data === 'string' ? JSON.parse(n.data) : n.data, read: !!n.read_at, readAt: n.read_at, createdAt: n.created_at,
  };
}

async function list(userId, page) {
  const [{ total }] = await q('SELECT COUNT(*) total FROM notifications WHERE user_id=?', [userId]);
  const rows = await q('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?', [userId, page.limit, page.offset]);
  const unread = await unreadCount(userId);
  return { total, unread, items: rows.map(serialize) };
}

async function unreadCount(userId) {
  const r = await one('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL', [userId]);
  return r.n;
}

async function markRead(userId, id) {
  if (id === 'all') await q('UPDATE notifications SET read_at=UTC_TIMESTAMP(3) WHERE user_id=? AND read_at IS NULL', [userId]);
  else await q('UPDATE notifications SET read_at=COALESCE(read_at, UTC_TIMESTAMP(3)) WHERE user_id=? AND id=?', [userId, id]);
  return { unread: await unreadCount(userId) };
}

module.exports = { notify, notifyNewEvent, list, unreadCount, markRead, money };
