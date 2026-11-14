#!/usr/bin/env node
/**
 * Create (or reset the password of) an admin.
 *   npm run create-admin -- --email you@example.com --name "Your Name" --role super_admin
 * The password is asked for interactively (or pass --password for scripts).
 */
const readline = require('node:readline');
const { pool, one, q } = require('../src/db');
const { hashPassword, ADMIN_ROLES } = require('../src/lib/auth');
const { newId } = require('../src/lib/util');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

function ask(question, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : '*');
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); }));
}

(async () => {
  const email = String(args.email || await ask('Admin email: ')).toLowerCase();
  const name = String(args.name || await ask('Admin name: ') || 'Administrator');
  const role = String(args.role || 'super_admin');
  if (!ADMIN_ROLES.includes(role)) throw new Error(`role must be one of ${ADMIN_ROLES.join(', ')}`);
  const password = String(args.password || await ask('Password (min 10 characters): ', true));
  if (password.length < 10) throw new Error('Password must be at least 10 characters');

  const existing = await one('SELECT id FROM admins WHERE email=?', [email]);
  if (existing) {
    await q('UPDATE admins SET password_hash=?, role=?, status=\'active\' WHERE id=?', [await hashPassword(password), role, existing.id]);
    console.log(`Updated admin ${email} (${role}).`);
  } else {
    await q('INSERT INTO admins (id, name, email, password_hash, role) VALUES (?,?,?,?,?)', [newId('adm'), name, email, await hashPassword(password), role]);
    console.log(`Created admin ${email} (${role}).`);
  }
  await pool.end();
})().catch(async (err) => {
  console.error(`Could not create admin: ${err.message}`);
  if (err.code === 'ER_NO_SUCH_TABLE') console.error('Run "npm run migrate" first.');
  await pool.end().catch(() => {});
  process.exit(1);
});
