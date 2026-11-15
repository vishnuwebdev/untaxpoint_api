#!/usr/bin/env node
/**
 * Applies pending SQL files from api/migrations (in name order) and records them in schema_migrations.
 * Creates the database if it does not exist. Uses the DB_* settings from api/.env.
 * The DB user needs CREATE/ALTER/DROP rights (root is fine for local development).
 */
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

(async () => {
  const { database, ...conn } = config.db;
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error('DB_NAME may only contain letters, numbers and _');
  const db = await mysql.createConnection({ ...conn, multipleStatements: true });
  await db.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await db.query(`USE \`${database}\``);
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(190) PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`);
  const [rows] = await db.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  // A database restored from a SQL dump already has the tables of earlier migrations, but no rows in
  // schema_migrations. Re-running those files would fail ("table already exists"), so if a migration's
  // objects are already there it is only recorded as applied.
  const tableExists = async (t) => (await db.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [database, t]))[0][0].n > 0;
  const alreadyInDb = {
    '001_schema_v2.sql': () => tableExists('audit_logs'),
    '002_mobile_app.sql': () => tableExists('notifications'),
  };
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    if (alreadyInDb[file] && (await alreadyInDb[file]())) {
      await db.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
      console.log(`${file} is already in the database - marked as applied`);
      continue;
    }
    process.stdout.write(`Applying ${file} ... `);
    try {
      await db.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await db.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
      console.log('done');
      count++;
    } catch (err) {
      console.log('FAILED');
      console.error(`  ${err.code}: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(count ? `${count} migration(s) applied to "${database}".` : `"${database}" is already up to date.`);
  await db.end();
})().catch((err) => {
  console.error(`Migration failed: ${err.code || ''} ${err.message}`);
  if (err.code === 'ER_ACCESS_DENIED_ERROR') console.error('Check DB_USER / DB_PASSWORD in api/.env');
  process.exit(1);
});
