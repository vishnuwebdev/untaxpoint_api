// MySQL-backed repository. All money moves run inside transactions with row locks.
const mysql = require('mysql2/promise');
const crypto = require('node:crypto');

const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const iso = (d) => (d ? new Date(d).toISOString() : null);

function createMysqlRepo(cfg) {
  const pool = mysql.createPool({
    host: cfg.host, port: Number(cfg.port || 3306), database: cfg.database,
    user: cfg.user, password: cfg.password,
    waitForConnections: true, connectionLimit: 10,
    timezone: 'Z',            // store and read DATETIME as UTC
    supportBigNumbers: true, bigNumberStrings: false, decimalNumbers: true,
  });

  async function tx(fn) {
    const conn = await pool.getConnection();
    try { await conn.beginTransaction(); const r = await fn(conn); await conn.commit(); return r; }
    catch (e) { await conn.rollback().catch(() => {}); throw e; }
    finally { conn.release(); }
  }
  const ledger = (conn, e) => conn.query(
    'INSERT INTO ledger_entries (id,user_id,event_id,entry_type,amount_cents,status,note,idempotency_key) VALUES (?,?,?,?,?,?,?,?)',
    [e.id, e.userId || null, e.eventId || null, e.type, e.amountCents, 'completed', e.note ?? null, e.key || e.id]);
  const audit = (conn, actor, action, targetId) => conn.query(
    'INSERT INTO audit_events (id,actor,action,target_id) VALUES (?,?,?,?)', [id('audit'), actor, action, targetId]);

  function eventRow(r, parts) {
    const mine = parts.filter((p) => p.event_id === r.id);
    return {
      id: r.id, title: r.title, description: r.description, address: r.address,
      latitude: Number(r.latitude), longitude: Number(r.longitude), radiusMeters: r.radius_meters,
      poolCents: Number(r.pool_cents), remainingCents: Number(r.remaining_cents), maxWinners: r.max_winners,
      startsAt: iso(r.starts_at), endsAt: iso(r.ends_at), status: r.status,
      participantIds: mine.map((p) => p.user_id), winners: mine.filter((p) => p.is_winner).map((p) => p.user_id),
      ...(r.settled_at ? { settledAt: iso(r.settled_at) } : {}), createdAt: iso(r.created_at),
    };
  }

  return {
    mode: 'mysql',
    async ping() { await pool.query('SELECT 1'); },

    async listEvents() {
      const [events] = await pool.query('SELECT * FROM events ORDER BY created_at');
      const [parts] = await pool.query('SELECT event_id,user_id,is_winner FROM participations ORDER BY sequence_no');
      return events.map((e) => eventRow(e, parts));
    },

    async listUsers() {
      const [rows] = await pool.query('SELECT id,name,email,wallet_cents,status FROM users ORDER BY created_at');
      return rows.map((u) => ({ id: u.id, name: u.name, email: u.email, walletCents: Number(u.wallet_cents), status: u.status }));
    },

    async listTransactions() {
      const [rows] = await pool.query('SELECT * FROM ledger_entries ORDER BY created_at DESC, id DESC');
      return rows.map((t) => ({
        id: t.id, type: t.entry_type, ...(t.event_id ? { eventId: t.event_id } : {}), ...(t.user_id ? { userId: t.user_id } : {}),
        amountCents: Number(t.amount_cents), status: t.status, ...(t.note != null ? { note: t.note } : {}), createdAt: iso(t.created_at),
      }));
    },

    async summary() {
      const [[p]] = await pool.query('SELECT balance_cents FROM platform_account WHERE id=1');
      const [[e]] = await pool.query("SELECT COALESCE(SUM(remaining_cents),0) reserved, SUM(status='active') active FROM events");
      const [[u]] = await pool.query('SELECT COUNT(*) n FROM users');
      const [[t]] = await pool.query('SELECT COUNT(*) n FROM ledger_entries');
      return { platformCents: Number(p?.balance_cents || 0), reservedCents: Number(e.reserved), activeEvents: Number(e.active || 0), totalUsers: Number(u.n), totalTransactions: Number(t.n) };
    },

    async fund(amount, note) {
      return tx(async (c) => {
        await c.query('UPDATE platform_account SET balance_cents = balance_cents + ? WHERE id=1', [amount]);
        const t = { id: id('txn'), type: 'platform_funding', amountCents: amount, status: 'completed', note, createdAt: new Date().toISOString() };
        await ledger(c, t); await audit(c, 'admin', 'platform_funded', t.id);
        const [[p]] = await c.query('SELECT balance_cents FROM platform_account WHERE id=1');
        return { platformCents: Number(p.balance_cents), transaction: t };
      });
    },

    async createEvent(ev) {
      return tx(async (c) => {
        const [[p]] = await c.query('SELECT balance_cents FROM platform_account WHERE id=1 FOR UPDATE');
        if (!p || Number(p.balance_cents) < ev.poolCents) throw new Error('insufficient_platform_funds');
        await c.query('UPDATE platform_account SET balance_cents = balance_cents - ? WHERE id=1', [ev.poolCents]);
        const e = { id: id('evt'), ...ev, remainingCents: ev.poolCents, participantIds: [], winners: [], createdAt: new Date().toISOString() };
        await c.query(
          'INSERT INTO events (id,title,description,address,latitude,longitude,radius_meters,pool_cents,remaining_cents,max_winners,starts_at,ends_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [e.id, e.title, e.description, e.address, e.latitude, e.longitude, e.radiusMeters, e.poolCents, e.remainingCents, e.maxWinners, new Date(e.startsAt), new Date(e.endsAt), e.status, new Date(e.createdAt)]);
        await ledger(c, { id: id('txn'), type: 'event_reservation', eventId: e.id, amountCents: e.poolCents });
        await audit(c, 'admin', 'event_created', e.id);
        return e;
      });
    },

    // check(ev, user) runs the business-rule validation from server.js against locked rows.
    async participate(eventId, userId, check) {
      return tx(async (c) => {
        const [[ev]] = await c.query('SELECT * FROM events WHERE id=? FOR UPDATE', [eventId]);
        if (!ev) throw new Error('event_not_found');
        const [[user]] = await c.query('SELECT id,status FROM users WHERE id=?', [userId]);
        const [[dup]] = await c.query('SELECT 1 x FROM participations WHERE event_id=? AND user_id=?', [eventId, userId]);
        check({ status: ev.status, startsAt: iso(ev.starts_at), endsAt: iso(ev.ends_at), latitude: Number(ev.latitude), longitude: Number(ev.longitude), radiusMeters: ev.radius_meters }, user, !!dup);
        const [[n]] = await c.query('SELECT COUNT(*) total, COALESCE(SUM(is_winner),0) won FROM participations WHERE event_id=?', [eventId]);
        const won = Number(n.won) < ev.max_winners;
        const p = { id: id('part'), eventId, userId, sequence: Number(n.total) + 1, acceptedAt: new Date().toISOString(), winner: won };
        await c.query('INSERT INTO participations (id,event_id,user_id,sequence_no,accepted_at,is_winner) VALUES (?,?,?,?,?,?)',
          [p.id, eventId, userId, p.sequence, new Date(p.acceptedAt), won]);
        if (won && Number(n.won) + 1 >= ev.max_winners) await c.query("UPDATE events SET status='capacity_reached' WHERE id=?", [eventId]);
        return p;
      });
    },

    async settleDue() {
      return tx(async (c) => {
        const [due] = await c.query("SELECT * FROM events WHERE status IN ('active','capacity_reached') AND ends_at <= UTC_TIMESTAMP(3) FOR UPDATE");
        const settled = [];
        for (const ev of due) {
          const [winners] = await c.query('SELECT user_id FROM participations WHERE event_id=? AND is_winner ORDER BY sequence_no LIMIT ?', [ev.id, ev.max_winners]);
          if (!winners.length) {
            await c.query('UPDATE platform_account SET balance_cents = balance_cents + ? WHERE id=1', [ev.remaining_cents]);
            await ledger(c, { id: id('txn'), type: 'event_release', eventId: ev.id, amountCents: Number(ev.remaining_cents), key: `release:${ev.id}` });
          } else {
            const total = Number(ev.pool_cents), base = Math.floor(total / winners.length), rem = total % winners.length;
            for (const [i, w] of winners.entries()) {
              const payout = base + (i < rem ? 1 : 0);
              await c.query('UPDATE users SET wallet_cents = wallet_cents + ? WHERE id=?', [payout, w.user_id]);
              await ledger(c, { id: id('txn'), type: 'reward_credit', eventId: ev.id, userId: w.user_id, amountCents: payout, key: `reward:${ev.id}:${w.user_id}` });
            }
          }
          await c.query("UPDATE events SET status='completed', remaining_cents=0, settled_at=UTC_TIMESTAMP(3) WHERE id=?", [ev.id]);
          await audit(c, 'system', 'event_settled', ev.id);
          settled.push(ev.id);
        }
        return settled;
      });
    },
  };
}
module.exports = { createMysqlRepo };
