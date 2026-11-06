'use strict';

/** Append-only trail for account, role and security changes. */

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (forwarded || req.ip || req.socket?.remoteAddress || '').slice(0, 64);
}

async function logAdminAction(pool, req, action, opts = {}) {
  try {
    const user = (req.session && req.session.user) || {};
    const rawFacility = opts.facilityId != null ? opts.facilityId : req.session && req.session.facilityId;
    const facilityId = parseInt(String(rawFacility == null ? '' : rawFacility), 10) || null;
    await pool.query(
      `INSERT INTO tbl_admin_audit
        (actor_id, actor_name, action, target_type, target_id, detail, ip, facility_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        parseInt(user.id, 10) || null,
        user.name || user.username || null,
        String(action || '').slice(0, 60),
        opts.targetType ? String(opts.targetType).slice(0, 40) : null,
        opts.targetId != null ? String(opts.targetId).slice(0, 64) : null,
        opts.detail ? String(opts.detail).slice(0, 2000) : null,
        clientIp(req),
        facilityId,
      ]
    );
  } catch (e) {
    console.warn('[adminAudit]', e.message);
  }
}

async function recentAdminActions(pool, limit = 12) {
  const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 12));
  try {
    const [rows] = await pool.query(
      `SELECT id, created_at, actor_name, action, target_type, target_id, detail, ip, facility_id
       FROM tbl_admin_audit ORDER BY id DESC LIMIT ${n}`
    );
    return rows || [];
  } catch (_) {
    return [];
  }
}

module.exports = { logAdminAction, recentAdminActions, clientIp };
