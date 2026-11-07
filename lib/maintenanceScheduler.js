'use strict';

/**
 * In-process daily maintenance for leave balances.
 *
 * There is no external cron in this deployment, so the app checks once an hour
 * (configurable) and, during the configured maintenance hour, runs carry-over
 * and accrual for every facility.  Every task is recorded in
 * `tbl_hms_maintenance_run`, which makes repeated ticks harmless.
 */

const L = require('./leaveSystem');
const Accrual = require('./leaveAccrual');
const mailer = require('./mailer');

function n(value) {
  const v = Number(value);
  return Number.isFinite(v) ? v : 0;
}

function envFlag(name, fallback) {
  return String(process.env[name] ?? fallback).trim() !== '0';
}

async function ensureMaintenanceSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_maintenance_run (
      id INT NOT NULL AUTO_INCREMENT,
      facility_id INT NOT NULL,
      task VARCHAR(64) NOT NULL,
      run_key VARCHAR(96) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'running',
      detail VARCHAR(1000) NULL,
      started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_hms_maintenance_run (facility_id, task, run_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});
}

async function taskState(pool, facilityId, task, runKey) {
  const [[row]] = await pool
    .query(
      'SELECT status, detail, finished_at FROM tbl_hms_maintenance_run WHERE facility_id = ? AND task = ? AND run_key = ? LIMIT 1',
      [facilityId, task, runKey]
    )
    .catch(() => [[null]]);
  return row || null;
}

/**
 * Run one idempotent task, recording its outcome.  A previously successful run
 * for the same key is skipped unless `force` is requested.
 */
async function runTask(pool, { facilityId, task, runKey, force }, work) {
  const prior = await taskState(pool, facilityId, task, runKey);
  if (!force && prior && String(prior.status) === 'success') {
    return { skipped: true, ok: true, result: null, detail: prior.detail || 'Already completed.' };
  }
  await pool
    .query(
      `INSERT INTO tbl_hms_maintenance_run (facility_id, task, run_key, status, detail, started_at, finished_at)
       VALUES (?,?,?, 'running', NULL, NOW(), NULL)
       ON DUPLICATE KEY UPDATE status = 'running', detail = NULL, started_at = NOW(), finished_at = NULL`,
      [facilityId, task, runKey]
    )
    .catch(() => {});
  try {
    const result = await work();
    const detail = JSON.stringify(result).slice(0, 1000);
    await pool
      .query(
        `UPDATE tbl_hms_maintenance_run SET status = 'success', detail = ?, finished_at = NOW()
          WHERE facility_id = ? AND task = ? AND run_key = ?`,
        [detail, facilityId, task, runKey]
      )
      .catch(() => {});
    return { ok: true, result, detail };
  } catch (e) {
    await pool
      .query(
        `UPDATE tbl_hms_maintenance_run SET status = 'failed', detail = ?, finished_at = NOW()
          WHERE facility_id = ? AND task = ? AND run_key = ?`,
        [String(e.message || 'error').slice(0, 1000), facilityId, task, runKey]
      )
      .catch(() => {});
    return { ok: false, error: e.message };
  }
}

async function activeFacilities(pool) {
  const [rows] = await pool
    .query('SELECT id, code, name FROM tbl_facility WHERE status = 1 ORDER BY id')
    .catch(() => [[]]);
  return (rows && rows.length ? rows : [{ id: 1, name: 'Default Facility' }]);
}

function maintenanceRecipients(settings) {
  const configured = String(process.env.HR_MAINTENANCE_NOTIFY_EMAILS || '').trim();
  if (configured) return mailer.parseRecipients(configured);
  const from = String(process.env.SMTP_FROM || '').trim();
  const match = /<([^>]+)>/.exec(from);
  return mailer.parseRecipients(match ? match[1] : from);
}

/**
 * Daily carry-over + accrual for every active facility, plus one digest email.
 */
async function runDailyLeaveMaintenance(pool, options) {
  const opts = options || {};
  const now = new Date();
  const year = Math.max(2000, Math.min(2100, parseInt(String(opts.year || now.getFullYear()), 10) || now.getFullYear()));
  const force = Boolean(opts.force);
  const actorId = parseInt(String(opts.actorId || 0), 10) || null;
  const dayKey = L.todayIso();
  const facilities = opts.facilityId
    ? [{ id: Math.max(1, parseInt(String(opts.facilityId), 10) || 1) }]
    : await activeFacilities(pool);
  const results = [];

  for (const facility of facilities) {
    const fid = Math.max(1, parseInt(String(facility.id), 10) || 1);
    const errors = [];

    const carry = await runTask(pool, { facilityId: fid, task: 'leave_carryover', runKey: String(year), force }, () =>
      Accrual.runCarryOver(pool, fid, year, actorId)
    );
    if (!carry.ok) errors.push(`Carry-over: ${carry.error}`);

    const accrual = await runTask(pool, { facilityId: fid, task: 'leave_accrual', runKey: `${year}-${dayKey}`, force }, () =>
      Accrual.runAccrual(pool, fid, year, actorId, { asOf: now })
    );
    if (!accrual.ok) errors.push(`Accrual: ${accrual.error}`);

    let mail = null;
    const carryResult = carry.result || { applied: 0, rows: [] };
    const accrualResult = accrual.result || { updated: 0, rows: [] };
    const somethingRan = !carry.skipped || !accrual.skipped;
    if (somethingRan && opts.notify !== false) {
      const notifyKey = `${year}-${dayKey}`;
      const [[alreadySent]] = await pool
        .query(
          "SELECT id FROM tbl_hms_maintenance_run WHERE facility_id = ? AND task = 'leave_digest' AND run_key = ? AND status = 'success' LIMIT 1",
          [fid, notifyKey]
        )
        .catch(() => [[null]]);
      if (!alreadySent || force) {
        mail = await mailer.sendLeaveMaintenanceSummary({
          to: maintenanceRecipients(),
          facilityName: facility.name || `Facility ${fid}`,
          year,
          ranAt: now.toISOString(),
          carryOver: carryResult,
          accrual: accrualResult,
          errors,
        });
        if (mail.ok) {
          await pool
            .query(
              `INSERT INTO tbl_hms_maintenance_run (facility_id, task, run_key, status, detail, started_at, finished_at)
               VALUES (?, 'leave_digest', ?, 'success', ?, NOW(), NOW())
               ON DUPLICATE KEY UPDATE status = 'success', detail = VALUES(detail), finished_at = NOW()`,
              [fid, notifyKey, `Sent to ${(mail.recipients || []).join(', ')}`.slice(0, 1000)]
            )
            .catch(() => {});
        }
      }
    }

    results.push({
      facilityId: fid,
      year,
      carryOver: { applied: carryResult.applied || 0, skipped: Boolean(carry.skipped), error: carry.error || null },
      accrual: { updated: accrualResult.updated || 0, skipped: Boolean(accrual.skipped), error: accrual.error || null },
      mail,
      errors,
    });
  }
  return { year, day: dayKey, results };
}

/**
 * Start the guarded scheduler.  Returns a handle the boot code can log; the
 * interval is unref'd so it never keeps the process (or a test run) alive.
 */
function startMaintenanceScheduler(pool) {
  if (!pool) return { started: false, reason: 'No database pool.' };
  if (!envFlag('HR_MAINTENANCE_SCHEDULER_ENABLED', '1')) {
    return { started: false, reason: 'HR_MAINTENANCE_SCHEDULER_ENABLED=0' };
  }
  const hour = Math.min(23, Math.max(0, parseInt(String(process.env.HR_MAINTENANCE_HOUR || '3'), 10) || 0));
  const intervalMinutes = Math.max(5, parseInt(String(process.env.HR_MAINTENANCE_INTERVAL_MINUTES || '60'), 10) || 60);

  let running = false;
  async function tick() {
    if (running) return;
    if (new Date().getHours() !== hour) return;
    running = true;
    try {
      const out = await runDailyLeaveMaintenance(pool);
      const summary = out.results
        .map((r) => `facility ${r.facilityId}: carried ${r.carryOver.applied}, accrued ${r.accrual.updated}`)
        .join('; ');
      if (summary) console.log(`[hr-maintenance] ${out.day}: ${summary}`);
      const failures = out.results.flatMap((r) => r.errors || []);
      if (failures.length) console.warn('[hr-maintenance]', failures.join(' | '));
    } catch (e) {
      console.warn('[hr-maintenance]', e.message);
    } finally {
      running = false;
    }
  }

  const bootTimer = setTimeout(tick, 20000);
  if (bootTimer.unref) bootTimer.unref();
  const interval = setInterval(tick, intervalMinutes * 60000);
  if (interval.unref) interval.unref();
  return { started: true, hour, intervalMinutes };
}

module.exports = {
  ensureMaintenanceSchema,
  runDailyLeaveMaintenance,
  startMaintenanceScheduler,
  runTask,
};
