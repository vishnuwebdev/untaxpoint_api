const config = require('./src/config');
const { createApp } = require('./src/app');
const { pool } = require('./src/db');
const scheduler = require('./src/jobs/scheduler');

const app = createApp();

app.listen(config.port, async () => {
  console.log(`UNTAXPOINT API listening on http://localhost:${config.port}`);
  try {
    await pool.query('SELECT 1 FROM events LIMIT 1');
    console.log(`Database: connected to ${config.db.database} as ${config.db.user}`);
  } catch (err) {
    console.error(`Database: NOT ready (${err.code}). Check api/.env and run "npm run migrate".`);
  }
  if (config.jobsEnabled) {
    scheduler.start(config.jobIntervalSeconds);
    console.log(`Jobs: settlement check every ${config.jobIntervalSeconds}s`);
  }
});
