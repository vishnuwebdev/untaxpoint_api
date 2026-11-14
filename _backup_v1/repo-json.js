// Original single-process JSON-file storage, kept as a fallback (STORAGE=json).
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const seed = () => ({
  platformCents: 250000,
  users: [{ id: 'user_demo', name: 'Demo Member', email: 'member@example.com', walletCents: 0, status: 'active' }],
  events: [{ id: 'evt_demo', title: 'City Center Challenge', description: 'Visit the event area and submit a participation request while it is active.', address: 'City Center', latitude: 40.7128, longitude: -74.006, radiusMeters: 500, poolCents: 50000, remainingCents: 50000, maxWinners: 10, startsAt: new Date(Date.now() - 3600000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(), status: 'active', participantIds: [], winners: [], createdAt: now() }],
  transactions: [], participations: [], audit: [],
});

function createJsonRepo(storeFile) {
  let queue = Promise.resolve();
  async function readStore() {
    try { return JSON.parse(await fs.readFile(storeFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; const initial = seed(); await writeStore(initial); return initial; }
  }
  async function writeStore(data) {
    await fs.mkdir(path.dirname(storeFile), { recursive: true });
    const temp = `${storeFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data, null, 2));
    await fs.rename(temp, storeFile);
  }
  function mutate(fn) {
    const work = queue.then(async () => { const db = await readStore(); const result = await fn(db); await writeStore(db); return result; });
    queue = work.catch(() => {});
    return work;
  }
  return {
    mode: 'local-json',
    async ping() {},
    async listEvents() { return (await readStore()).events; },
    async listUsers() { return (await readStore()).users.map(({ id, name, email, walletCents, status }) => ({ id, name, email, walletCents, status })); },
    async listTransactions() { return (await readStore()).transactions.slice().reverse(); },
    async summary() { const db = await readStore(); return { platformCents: db.platformCents, reservedCents: db.events.reduce((s, e) => s + e.remainingCents, 0), activeEvents: db.events.filter((e) => e.status === 'active').length, totalUsers: db.users.length, totalTransactions: db.transactions.length }; },
    fund(amount, note) {
      return mutate((db) => { db.platformCents += amount; const tx = { id: id('txn'), type: 'platform_funding', amountCents: amount, status: 'completed', note, createdAt: now() }; db.transactions.push(tx); db.audit.push({ id: id('audit'), actor: 'admin', action: 'platform_funded', targetId: tx.id, createdAt: now() }); return { platformCents: db.platformCents, transaction: tx }; });
    },
    createEvent(ev) {
      return mutate((db) => { if (db.platformCents < ev.poolCents) throw new Error('insufficient_platform_funds'); db.platformCents -= ev.poolCents; const e = { id: id('evt'), ...ev, remainingCents: ev.poolCents, participantIds: [], winners: [], createdAt: now() }; db.events.push(e); db.transactions.push({ id: id('txn'), type: 'event_reservation', eventId: e.id, amountCents: ev.poolCents, status: 'completed', createdAt: now() }); db.audit.push({ id: id('audit'), actor: 'admin', action: 'event_created', targetId: e.id, createdAt: now() }); return e; });
    },
    participate(eventId, userId, check) {
      return mutate((db) => {
        const ev = db.events.find((e) => e.id === eventId); if (!ev) throw new Error('event_not_found');
        const user = db.users.find((u) => u.id === userId);
        check(ev, user, ev.participantIds.includes(userId));
        const won = ev.winners.length < ev.maxWinners;
        const p = { id: id('part'), eventId, userId, sequence: ev.participantIds.length + 1, acceptedAt: now(), winner: won };
        db.participations.push(p); ev.participantIds.push(userId); if (won) ev.winners.push(userId);
        if (ev.winners.length >= ev.maxWinners) ev.status = 'capacity_reached';
        return p;
      });
    },
    settleDue() {
      return mutate((db) => {
        const settled = []; const time = Date.now();
        for (const ev of db.events) {
          if (!['active', 'capacity_reached'].includes(ev.status) || Date.parse(ev.endsAt) > time) continue;
          ev.status = 'completed'; const winners = ev.winners.slice(0, ev.maxWinners); const total = ev.poolCents;
          if (!winners.length) { db.platformCents += ev.remainingCents; db.transactions.push({ id: id('txn'), type: 'event_release', eventId: ev.id, amountCents: ev.remainingCents, status: 'completed', createdAt: now() }); }
          else {
            const base = Math.floor(total / winners.length), remainder = total % winners.length;
            winners.forEach((userId, index) => { const payout = base + (index < remainder ? 1 : 0); const user = db.users.find((u) => u.id === userId); if (!user) return; user.walletCents += payout; db.transactions.push({ id: id('txn'), type: 'reward_credit', eventId: ev.id, userId, amountCents: payout, status: 'completed', createdAt: now() }); });
          }
          ev.remainingCents = 0; ev.settledAt = now(); settled.push(ev.id);
          db.audit.push({ id: id('audit'), actor: 'system', action: 'event_settled', targetId: ev.id, createdAt: now() });
        }
        return settled;
      });
    },
  };
}
module.exports = { createJsonRepo };
