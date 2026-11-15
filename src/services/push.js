/**
 * Push notifications through Firebase Cloud Messaging (HTTP v1 API).
 *
 * Every row in `notifications` is pushed once to the member's devices by a small worker
 * (outbox pattern): rows are written inside the business transaction, so a push is only sent
 * for something that was committed, and nothing is lost if the API restarts.
 *
 * Setup: download a service-account key (Firebase console → Project settings → Service accounts
 * → Generate new private key), store it on the server OUTSIDE the web root, and set
 * FIREBASE_SERVICE_ACCOUNT=/absolute/path/to/key.json in api/.env. Without it, push is off and
 * in-app notifications keep working.
 */
const fs = require('node:fs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { q } = require('../db');

const BATCH = 500; // notifications per worker run
const CONCURRENCY = 20; // parallel FCM requests
const MAX_ATTEMPTS = 3; // retries for temporary FCM errors

let account; // parsed service-account JSON, or null when push is off
let cachedToken = null; // { value, expiresAt }
let tokenRequest = null; // in-flight token request, shared by parallel sends

function loadAccount() {
  if (account !== undefined) return account;
  account = null;
  const file = config.push.serviceAccountFile;
  if (!file) return account;
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!json.project_id || !json.client_email || !json.private_key) throw new Error('missing project_id/client_email/private_key');
    account = json;
  } catch (err) {
    console.error(`Push: cannot read FIREBASE_SERVICE_ACCOUNT (${err.message}). Push notifications are off.`);
  }
  return account;
}

const enabled = () => !!loadAccount();

/** OAuth access token for FCM, signed with the service account (cached ~55 min). */
async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  if (!tokenRequest) tokenRequest = fetchAccessToken().finally(() => { tokenRequest = null; });
  return tokenRequest;
}

async function fetchAccessToken() {
  const a = loadAccount();
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = a.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = jwt.sign(
    { iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat: now, exp: now + 3600 },
    a.private_key,
    { algorithm: 'RS256' },
  );
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`token request failed (${res.status} ${body.error || ''})`);
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

/**
 * Send one message to one device.
 * Returns 'ok', 'invalid_token' (remove the token) or 'retry' (temporary problem).
 */
async function sendToDevice(deviceToken, n, unread) {
  const message = {
    token: deviceToken,
    notification: { title: n.title, body: n.body },
    // Data values must be strings. The app uses these to open the right screen.
    data: {
      notificationId: String(n.id),
      type: n.type,
      eventId: n.event_id || '',
    },
    android: { priority: 'HIGH', notification: { sound: 'default' } },
    apns: { payload: { aps: { sound: 'default', badge: unread } } },
  };
  let res;
  try {
    res = await fetch(`https://fcm.googleapis.com/v1/projects/${loadAccount().project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  } catch {
    return 'retry'; // network problem
  }
  if (res.ok) return 'ok';
  const err = await res.json().catch(() => ({}));
  const details = JSON.stringify(err.error?.details || []);
  if (res.status === 404 || details.includes('UNREGISTERED')) return 'invalid_token';
  if (res.status === 400 && details.includes('INVALID_ARGUMENT') && /registration token/i.test(err.error?.message || '')) return 'invalid_token';
  if (res.status === 401) cachedToken = null; // token expired early: fetch a new one next time
  if (res.status === 429 || res.status >= 500 || res.status === 401) return 'retry';
  console.error(`Push: FCM rejected notification ${n.id} (${res.status} ${err.error?.status || ''}: ${err.error?.message || ''})`);
  return 'ok'; // permanent problem with this message: don't retry
}

/** Run promise-returning jobs with limited parallelism. */
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

let running = false;

/** One worker run: claim pending notifications, push them, release the ones that should be retried. */
async function processPending() {
  if (running) return 0;
  running = true;
  try {
    if (!enabled()) {
      // Push is off: mark old rows as done so turning push on later doesn't send history.
      await q('UPDATE notifications SET pushed_at=UTC_TIMESTAMP(3) WHERE pushed_at IS NULL AND created_at < NOW(3) - INTERVAL 1 HOUR');
      return 0;
    }
    const rows = await q(`SELECT id, user_id, type, title, body, event_id, push_attempts,
        (created_at < NOW(3) - INTERVAL 1 HOUR) AS stale
      FROM notifications WHERE pushed_at IS NULL ORDER BY id LIMIT ?`, [BATCH]);
    if (!rows.length) return 0;

    // Claim each row before sending (safe with several API processes): a row is sent only by
    // the process whose UPDATE changed it.
    const claimed = [];
    for (const r of rows) {
      const res = await q('UPDATE notifications SET pushed_at=UTC_TIMESTAMP(3) WHERE id=? AND pushed_at IS NULL', [r.id]);
      if (res.affectedRows === 1) claimed.push(r);
    }
    const toSend = claimed.filter((r) => !Number(r.stale)); // old rows are only marked as done
    if (!toSend.length) return 0;

    const userIds = [...new Set(toSend.map((r) => r.user_id))];
    const ph = userIds.map(() => '?').join(',');
    const devices = await q(`SELECT d.user_id, d.token FROM device_tokens d JOIN users u ON u.id=d.user_id
      WHERE u.status='active' AND d.user_id IN (${ph})`, userIds);
    const byUser = new Map();
    for (const d of devices) byUser.set(d.user_id, [...(byUser.get(d.user_id) || []), d.token]);
    const unread = new Map((await q(`SELECT user_id, COUNT(*) n FROM notifications WHERE read_at IS NULL AND user_id IN (${ph}) GROUP BY user_id`, userIds))
      .map((r) => [r.user_id, Number(r.n)]));

    const jobs = [];
    for (const n of toSend) for (const t of byUser.get(n.user_id) || []) jobs.push({ n, t });
    const retry = new Set();
    const invalid = new Set();
    let sent = 0;
    await pool(jobs, CONCURRENCY, async ({ n, t }) => {
      const r = await sendToDevice(t, n, unread.get(n.user_id) || 0);
      if (r === 'ok') sent++;
      else if (r === 'invalid_token') invalid.add(t);
      else retry.add(n.id);
    });

    if (invalid.size) {
      const list = [...invalid];
      await q(`DELETE FROM device_tokens WHERE token IN (${list.map(() => '?').join(',')})`, list);
    }
    const again = toSend.filter((n) => retry.has(n.id) && n.push_attempts + 1 < MAX_ATTEMPTS).map((n) => n.id);
    if (again.length) {
      await q(`UPDATE notifications SET pushed_at=NULL, push_attempts=push_attempts+1 WHERE id IN (${again.map(() => '?').join(',')})`, again);
    }
    if (sent || invalid.size || again.length) {
      console.log(`[push] sent=${sent} invalidTokens=${invalid.size} retry=${again.length}`);
    }
    return sent;
  } catch (err) {
    console.error('[push] run failed:', err.code || '', err.message);
    return 0;
  } finally {
    running = false;
  }
}

/** Save (or move) a device token for the signed-in member. */
async function registerDevice(userId, { token, platform, appVersion }) {
  await q(`INSERT INTO device_tokens (user_id, token, platform, app_version) VALUES (?,?,?,?)
    ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), platform=VALUES(platform), app_version=VALUES(app_version), last_seen_at=UTC_TIMESTAMP(3)`,
  [userId, token, platform, appVersion || null]);
  return { registered: true, pushEnabled: enabled() };
}

async function unregisterDevice(userId, token) {
  await q('DELETE FROM device_tokens WHERE user_id=? AND token=?', [userId, token]);
  return { removed: true };
}

function start(intervalSeconds) {
  if (enabled()) console.log(`Push: on (Firebase project ${loadAccount().project_id}), checking every ${intervalSeconds}s`);
  else console.log('Push: off (set FIREBASE_SERVICE_ACCOUNT in .env to turn it on)');
  processPending();
  return setInterval(processPending, intervalSeconds * 1000).unref();
}

module.exports = { start, processPending, registerDevice, unregisterDevice, enabled };
