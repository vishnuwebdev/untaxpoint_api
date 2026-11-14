/**
 * Background jobs (run inside the API process):
 *  - move scheduled events to active when they start
 *  - settle events whose end time has passed (idempotent)
 *  - send withdrawals stuck in 'requested' (crash recovery)
 * Interval: JOB_INTERVAL_SECONDS (default 60). Safe with several API processes,
 * because every step locks rows and is idempotent.
 */
const settlement = require('../services/settlement');
const finance = require('../services/finance');

let running = false;

async function runOnce() {
  if (running) return null;
  running = true;
  try {
    const activated = await settlement.activateStartedEvents();
    const settled = await settlement.settleDueEvents();
    const withdrawals = await finance.processQueuedWithdrawals();
    if (activated || settled.length || withdrawals) {
      console.log(`[jobs] activated=${activated} settled=${settled.length} withdrawals=${withdrawals}`);
    }
    return { activated, settled, withdrawals };
  } catch (err) {
    console.error('[jobs] run failed:', err.code || '', err.message);
    return null;
  } finally {
    running = false;
  }
}

function start(intervalSeconds) {
  runOnce();
  return setInterval(runOnce, intervalSeconds * 1000).unref();
}

module.exports = { runOnce, start };
