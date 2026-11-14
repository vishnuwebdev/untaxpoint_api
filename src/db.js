const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 15,
  timezone: 'Z', // DATETIME values are stored and read as UTC
  supportBigNumbers: true,
  bigNumberStrings: false,
  decimalNumbers: true,
  dateStrings: false,
});

/** Run fn(conn) inside a transaction. Retries once on deadlock. */
async function tx(fn, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (err && err.code === 'ER_LOCK_DEADLOCK' && attempt < retries) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}

/** Query helper: returns rows. */
async function q(sql, params, conn = pool) {
  const [rows] = await conn.query(sql, params);
  return rows;
}

/** Query helper: returns first row or null. */
async function one(sql, params, conn = pool) {
  const rows = await q(sql, params, conn);
  return rows[0] || null;
}

module.exports = { pool, tx, q, one };
