'use strict';

/**
 * Biometric / time-clock ingestion.
 *
 * Physical devices cannot hold a user session, so they authenticate with a
 * shared device token and post punches to this JSON endpoint.  The punch goes
 * through the same `recordPunch` path as the web clock, so attendance, late and
 * overtime minutes are derived identically.
 */

const crypto = require('crypto');
const W = require('../lib/leaveWorkflow');
const L = require('../lib/leaveSystem');

function tokensMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function deviceToken() {
  return String(process.env.ATTENDANCE_DEVICE_TOKEN || '').trim();
}

function providedToken(req) {
  const header = String(req.headers['x-device-token'] || req.headers['x-api-key'] || '').trim();
  if (header) return header;
  const auth = String(req.headers.authorization || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1].trim() : '';
}

function parseTimestamp(value) {
  if (value == null || value === '') return new Date();
  const raw = String(value).trim();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const skewMs = parsed.getTime() - Date.now();
  if (skewMs > 60 * 60 * 1000) return null;
  if (skewMs < -45 * 24 * 60 * 60 * 1000) return null;
  return parsed;
}

async function resolveEmployee(pool, body) {
  const code = String(body.employee_code || body.badge || body.code || '').trim();
  const id = parseInt(String(body.employee_id || ''), 10) || 0;
  if (!code && !id) return null;
  const [[row]] = await pool
    .query(
      `SELECT id, first_name, last_name, employee_id, status, default_facility_id
         FROM tbl_employee
        WHERE (employee_id = ? OR id = ?)
        ORDER BY (employee_id = ?) DESC
        LIMIT 1`,
      [code, id, code]
    )
    .catch(() => [[null]]);
  return row || null;
}

module.exports = function registerAttendanceDevice(app, pool) {
  app.post('/api/attendance/punch', async (req, res) => {
    const expected = deviceToken();
    if (!expected) {
      return res.status(503).json({ ok: false, error: 'Device clock integration is not configured.' });
    }
    if (!tokensMatch(providedToken(req), expected)) {
      return res.status(401).json({ ok: false, error: 'Invalid device token.' });
    }

    const body = req.body || {};
    const direction = String(body.direction || 'in').toLowerCase();
    if (!['in', 'out'].includes(direction)) {
      return res.status(400).json({ ok: false, error: 'direction must be "in" or "out".' });
    }
    const when = parseTimestamp(body.timestamp || body.punched_at || body.time);
    if (!when) {
      return res.status(400).json({ ok: false, error: 'timestamp is invalid or too far in the future.' });
    }
    const facilityId = Math.max(
      1,
      parseInt(String(body.facility_id || process.env.ATTENDANCE_DEVICE_FACILITY_ID || 1), 10) || 1
    );

    try {
      const employee = await resolveEmployee(pool, body);
      if (!employee) return res.status(404).json({ ok: false, error: 'Unknown employee code or id.' });
      if (Number(employee.status) !== 1) {
        return res.status(409).json({ ok: false, error: 'Employee is not active.' });
      }
      if (employee.default_facility_id && Number(employee.default_facility_id) !== facilityId) {
        return res.status(409).json({ ok: false, error: 'Employee does not belong to that facility.' });
      }

      const date = L.isoDate(when);
      const stamp = `${date} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}:${String(when.getSeconds()).padStart(2, '0')}`;
      const [[duplicate]] = await pool
        .query(
          `SELECT id FROM tbl_hms_attendance_punch
            WHERE facility_id = ? AND employee_id = ? AND direction = ?
              AND punched_at BETWEEN DATE_SUB(?, INTERVAL 60 SECOND) AND DATE_ADD(?, INTERVAL 60 SECOND)
            LIMIT 1`,
          [facilityId, employee.id, direction, stamp, stamp]
        )
        .catch(() => [[null]]);
      if (duplicate) {
        return res.status(200).json({ ok: true, duplicate: true, employee_id: employee.id, date, direction });
      }

      const result = await W.recordPunch(pool, {
        facilityId,
        employeeId: employee.id,
        direction,
        source: 'device',
        ip: req.ip,
        device: String(body.device || body.device_id || 'biometric').slice(0, 120),
        note: String(body.note || '').slice(0, 500),
        actorId: null,
        punchedAt: when,
      });
      if (!result.ok) return res.status(422).json({ ok: false, error: result.error });
      return res.json({
        ok: true,
        employee_id: employee.id,
        employee_code: employee.employee_id,
        date: result.date || date,
        direction,
        status: result.status,
        worked_minutes: result.workedMinutes,
        late_minutes: result.lateMinutes,
        early_minutes: result.earlyMinutes,
        overtime_minutes: result.overtimeMinutes,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/attendance/punch', (_req, res) => {
    res.status(405).json({ ok: false, error: 'Use POST to submit a punch.' });
  });
};
