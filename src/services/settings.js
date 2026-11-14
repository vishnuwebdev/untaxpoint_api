const { q } = require('../db');
const { badRequest } = require('../lib/errors');

/** Allowed settings and their validation. */
const DEFINITIONS = {
  default_radius_meters:             { type: 'int', min: 1, max: 100000, label: 'Default participation radius (m)' },
  max_location_accuracy_meters:      { type: 'int', min: 1, max: 5000, label: 'Max GPS accuracy accepted (m)' },
  nearby_notification_radius_meters: { type: 'int', min: 100, max: 500000, label: 'Nearby notification radius (m)' },
  min_withdrawal_cents:              { type: 'int', min: 1, max: 100000000, label: 'Minimum withdrawal (cents)' },
  max_withdrawal_cents:              { type: 'int', min: 1, max: 100000000, label: 'Maximum withdrawal (cents)' },
  withdrawal_hold_threshold_cents:   { type: 'int', min: 1, max: 100000000, label: 'Hold withdrawals at or above (cents)' },
  min_donation_cents:                { type: 'int', min: 1, max: 100000000, label: 'Minimum donation (cents)' },
  currency:                          { type: 'string', enum: ['USD'], label: 'Currency' },
};

async function getSettings(conn) {
  const rows = await q('SELECT setting_key, setting_value FROM settings', [], conn || undefined);
  const out = {};
  // mysql2 already parses JSON columns.
  for (const r of rows) out[r.setting_key] = r.setting_value;
  return out;
}

async function updateSettings(conn, changes, adminId) {
  const applied = {};
  for (const [key, value] of Object.entries(changes || {})) {
    const def = DEFINITIONS[key];
    if (!def) throw badRequest('unknown_setting', `Unknown setting: ${key}`);
    if (def.type === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < def.min || n > def.max) throw badRequest('invalid_setting', `${def.label} must be a whole number between ${def.min} and ${def.max}`);
      applied[key] = n;
    } else {
      if (def.enum && !def.enum.includes(value)) throw badRequest('invalid_setting', `${def.label} must be one of ${def.enum.join(', ')}`);
      applied[key] = value;
    }
  }
  const merged = { ...(await getSettings(conn)), ...applied };
  if (merged.min_withdrawal_cents > merged.max_withdrawal_cents) throw badRequest('invalid_setting', 'Minimum withdrawal cannot exceed maximum withdrawal');
  for (const [key, value] of Object.entries(applied)) {
    await q('INSERT INTO settings (setting_key, setting_value, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), updated_by=VALUES(updated_by)',
      [key, JSON.stringify(value), adminId], conn);
  }
  return applied;
}

module.exports = { getSettings, updateSettings, DEFINITIONS };
