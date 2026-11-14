const { q } = require('../db');

/** Write an audit log row. Pass conn to keep it inside the caller's transaction. */
async function audit(conn, { actorType, actorId = null, action, targetType = null, targetId = null, details = null, ip = null }) {
  await q(
    'INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, details, ip_address) VALUES (?,?,?,?,?,?,?)',
    [actorType, actorId, action, targetType, targetId, details ? JSON.stringify(details) : null, ip],
    conn || undefined,
  );
}

/** Shorthand for admin actions coming from a request. */
const adminAudit = (conn, req, action, targetType, targetId, details) =>
  audit(conn, { actorType: 'admin', actorId: req.admin.id, action, targetType, targetId, details, ip: req.ip });

module.exports = { audit, adminAudit };
