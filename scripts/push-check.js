#!/usr/bin/env node
/**
 * Push notification health check. Run ON THE SERVER from the api/ folder:
 *
 *   node scripts/push-check.js                      # check config, Firebase key, database, recent pushes
 *   node scripts/push-check.js --send you@mail.com  # also send a test push to that member's phones
 *
 * Read-only except --send (which only calls Firebase; it writes nothing to the database).
 */
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const { q, pool } = require('../src/db');

const args = process.argv.slice(2);
const sendTo = args[args.indexOf('--send') + 1] && args.includes('--send') ? args[args.indexOf('--send') + 1] : null;

let problems = 0;
const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m) => { problems++; console.log(`  \x1b[31m✖ ${m}\x1b[0m`); };
const warn = (m) => console.log(`  \x1b[33m⚠\x1b[0m ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function accessToken(a) {
  const now = Math.floor(Date.now() / 1000);
  const aud = a.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = jwt.sign({ iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud, iat: now, exp: now + 3600 },
    a.private_key, { algorithm: 'RS256' });
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`${res.status} ${body.error || ''} ${body.error_description || ''}`);
  return body.access_token;
}

async function main() {
  // ------------------------------------------------------------ 1. config
  head('1. Server config');
  ok(`NODE_ENV=${config.env}, port ${config.port}`);
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18 || typeof fetch !== 'function') {
    bad(`Node ${process.version}: no built-in fetch, so the server can never call Firebase. Install Node 20 (nvm install 20) and restart PM2 with it.`);
    return;
  }
  ok(`Node ${process.version}`);
  console.log(`      (PM2 may use a different Node than this shell – check with: pm2 describe untaxpoint-api | grep -i "node"`);
  try {
    const r = await fetch('https://www.googleapis.com', { method: 'HEAD' });
    const skew = Math.round((Date.now() - new Date(r.headers.get('date')).getTime()) / 1000);
    if (Math.abs(skew) > 120) bad(`Server clock is off by ${skew}s – Google rejects the login. Fix with: timedatectl set-ntp true`);
    else ok(`Server clock OK (off by ${skew}s) and outbound HTTPS to Google works`);
  } catch (e) {
    bad(`Server cannot reach Google over HTTPS (${e.message}) – check outbound firewall/DNS.`);
  }
  if (!config.jobsEnabled) bad('JOBS_ENABLED=false – the push worker never starts (server.js only starts it with jobs on).');
  else ok(`Push worker runs every ${config.push.intervalSeconds}s (JOBS_ENABLED is on)`);
  const file = config.push.serviceAccountFile;
  let account = null;
  if (!file) bad('FIREBASE_SERVICE_ACCOUNT is not set in api/.env – push is OFF.');
  else if (!fs.existsSync(file)) bad(`Service-account file not found: ${file}`);
  else {
    try {
      account = JSON.parse(fs.readFileSync(file, 'utf8'));
      ok(`Service account: ${account.client_email} (project ${account.project_id})`);
      if (file.startsWith('/var/www/html')) bad('The key is inside /var/www/html – Apache can serve it publicly. Move it out!');
    } catch (e) { bad(`Cannot read service-account JSON: ${e.message}`); }
  }
  const gs = path.join(__dirname, '..', '..', 'fe-app', 'android', 'app', 'google-services.json');
  if (account && fs.existsSync(gs)) {
    const appProject = JSON.parse(fs.readFileSync(gs, 'utf8')).project_info?.project_id;
    if (appProject === account.project_id) ok(`App google-services.json uses the same project (${appProject})`);
    else bad(`Project mismatch: app uses "${appProject}", server key is for "${account.project_id}" – FCM will reject every token.`);
  }

  // ------------------------------------------------------------ 2. deployed code
  head('2. Deployed API code');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'app.js'), 'utf8');
  if (routes.includes("'/me/devices'")) ok('Route POST /api/v1/me/devices is present');
  else bad('Route /me/devices is missing – the app cannot save its FCM token. Deploy src/routes/app.js.');
  const pushSrc = path.join(__dirname, '..', 'src', 'services', 'push.js');
  if (fs.existsSync(pushSrc)) ok('src/services/push.js is present'); else bad('src/services/push.js is missing – deploy it.');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  if (serverSrc.includes('push.start')) ok('server.js starts the push worker'); else bad('server.js does not start the push worker – deploy server.js.');
  warn('Remember: after copying files, run "pm2 restart untaxpoint-api" – PM2 keeps running the old code until restarted.');

  // ------------------------------------------------------------ 3. database
  head('3. Database');
  const [tbl] = await q(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='device_tokens'`);
  if (!tbl.n) { bad('Table device_tokens does not exist – run "npm run migrate".'); return; }
  ok('Table device_tokens exists');
  const cols = (await q(`SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='notifications'`)).map((r) => r.c);
  for (const c of ['pushed_at', 'push_attempts']) (cols.includes(c) ? ok : bad)(`notifications.${c} ${cols.includes(c) ? 'exists' : 'is missing – run "npm run migrate"'}`);
  const [mig] = await q(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='schema_migrations'`);
  if (mig.n) {
    const applied = (await q('SELECT * FROM schema_migrations')).map((r) => r.name || r.filename || r.version || Object.values(r)[0]);
    ok(`Applied migrations: ${applied.join(', ') || '(none)'}`);
  }

  const [clock] = await q('SELECT NOW(3) now_local, UTC_TIMESTAMP(3) now_utc, @@session.time_zone tz');
  ok(`MySQL time zone ${clock.tz}; NOW()=${new Date(clock.now_local).toISOString()} UTC_TIMESTAMP()=${new Date(clock.now_utc).toISOString()}`);

  const tokens = await q(`SELECT d.platform, d.created_at, d.last_seen_at, LEFT(d.token, 18) t, u.email, u.status
    FROM device_tokens d JOIN users u ON u.id=d.user_id ORDER BY d.last_seen_at DESC LIMIT 15`);
  const [{ total }] = await q('SELECT COUNT(*) total FROM device_tokens');
  if (!total) bad('No FCM tokens saved. The app never registered: check notification permission on the phone, and that the app talks to THIS server.');
  else {
    ok(`${total} device token(s) saved. Latest:`);
    for (const t of tokens) console.log(`      ${t.email.padEnd(32)} ${t.platform.padEnd(8)} seen ${new Date(t.last_seen_at).toISOString()}  ${t.t}…${t.status !== 'active' ? '  (member not active → skipped)' : ''}`);
  }

  const recent = await q(`SELECT n.id, n.type, n.created_at, n.pushed_at, n.push_attempts, u.email,
      (SELECT COUNT(*) FROM device_tokens d WHERE d.user_id=n.user_id) devices
    FROM notifications n JOIN users u ON u.id=n.user_id ORDER BY n.id DESC LIMIT 10`);
  const [{ pending }] = await q('SELECT COUNT(*) pending FROM notifications WHERE pushed_at IS NULL');
  ok(`Notifications waiting to be pushed: ${pending}${pending > 0 ? ' (if this stays above 0, the worker is not running or FCM is failing)' : ''}`);
  console.log('      Last 10 notifications:');
  for (const n of recent) {
    console.log(`      #${String(n.id).padEnd(6)} ${n.type.padEnd(18)} ${n.email.padEnd(30)} devices=${n.devices} pushed=${n.pushed_at ? 'yes' : 'NO '} attempts=${n.push_attempts}`);
  }
  if (recent.length && recent.every((n) => !n.devices)) warn('None of the recent notifications belong to a member with a saved token – nothing could be pushed.');

  // ------------------------------------------------------------ 4. Firebase
  head('4. Firebase Cloud Messaging');
  if (!account) { bad('Skipped – no service account.'); return; }
  let token;
  try {
    token = await accessToken(account);
    ok('Got an OAuth token from Google (the key is valid)');
  } catch (e) {
    bad(`Google refused the service-account key: ${e.message}. Create a new key in Firebase → Project settings → Service accounts.`);
    return;
  }

  const targets = sendTo
    ? await q(`SELECT d.token, d.platform FROM device_tokens d JOIN users u ON u.id=d.user_id WHERE u.email=?`, [sendTo])
    : await q('SELECT token, platform FROM device_tokens ORDER BY last_seen_at DESC LIMIT 3');
  if (sendTo && !targets.length) { bad(`No device token saved for ${sendTo}.`); return; }
  if (!targets.length) return;
  console.log(sendTo ? `  Sending a test push to ${targets.length} device(s) of ${sendTo}…` : '  Checking the latest tokens with Firebase (validate only, nothing is shown on the phone)…');
  for (const t of targets) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        validate_only: !sendTo,
        message: {
          token: t.token,
          notification: { title: 'UNTAXPOINT test', body: 'If you can read this, push notifications work 🎉' },
          data: { type: 'test' },
          android: { priority: 'HIGH', notification: { sound: 'default' } },
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) ok(`${t.platform} …${t.token.slice(-8)}: accepted by Firebase${sendTo ? ' – check the phone (put the app in the background)' : ''}`);
    else {
      const msg = `${res.status} ${body.error?.status || ''}: ${body.error?.message || ''}`;
      if (res.status === 403) bad(`${msg} → enable "Firebase Cloud Messaging API (V1)" in Google Cloud console for project ${account.project_id}, or give the service account the "Firebase Cloud Messaging API Admin" role.`);
      else if (res.status === 404 || JSON.stringify(body).includes('UNREGISTERED')) bad(`${msg} → this token is dead (app reinstalled/data cleared). Open the app and sign in again.`);
      else if (/SenderId mismatch|MismatchSenderId/i.test(JSON.stringify(body))) bad(`${msg} → the app and the server use different Firebase projects.`);
      else bad(msg);
    }
  }
}

main()
  .catch((e) => { bad(`Check crashed: ${e.code || ''} ${e.message}`); })
  .finally(async () => {
    console.log(problems ? `\n\x1b[31m${problems} problem(s) found.\x1b[0m` : '\n\x1b[32mNo problems found.\x1b[0m');
    await pool.end().catch(() => {});
  });
