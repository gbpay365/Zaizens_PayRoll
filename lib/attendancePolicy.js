'use strict';

/**
 * Attendance policy: the configurable numbers payroll uses to turn recorded
 * attendance into money (overtime earnings, late penalties, absence and unpaid
 * leave deductions).
 */

const DEFAULT_POLICY = {
  monthly_work_days: 22,
  standard_daily_hours: 8,
  overtime_enabled: 1,
  overtime_multiplier: 1.25,
  late_penalty_multiplier: 1,
  absence_multiplier: 1,
  unpaid_leave_multiplier: 1,
};

function n(value, fallback = 0) {
  const v = Number(value);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(value, min, max, fallback) {
  const v = n(value, fallback);
  return Math.min(max, Math.max(min, v));
}

async function ensureAttendancePolicySchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_attendance_policy (
      facility_id INT NOT NULL PRIMARY KEY,
      monthly_work_days DECIMAL(5,2) NOT NULL DEFAULT 22,
      standard_daily_hours DECIMAL(5,2) NOT NULL DEFAULT 8,
      overtime_enabled TINYINT(1) NOT NULL DEFAULT 1,
      overtime_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.25,
      late_penalty_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1,
      absence_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1,
      unpaid_leave_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});
  await pool
    .query(
      `INSERT IGNORE INTO tbl_hms_attendance_policy
        (facility_id, monthly_work_days, standard_daily_hours, overtime_enabled,
         overtime_multiplier, late_penalty_multiplier, absence_multiplier, unpaid_leave_multiplier)
       VALUES (1, 22, 8, 1, 1.25, 1, 1, 1)`
    )
    .catch(() => {});
}

function normalise(row) {
  const source = row || {};
  return {
    monthly_work_days: clamp(source.monthly_work_days, 1, 31, DEFAULT_POLICY.monthly_work_days),
    standard_daily_hours: clamp(source.standard_daily_hours, 1, 24, DEFAULT_POLICY.standard_daily_hours),
    overtime_enabled: Number(source.overtime_enabled) === 0 ? 0 : 1,
    overtime_multiplier: clamp(source.overtime_multiplier, 0, 5, DEFAULT_POLICY.overtime_multiplier),
    late_penalty_multiplier: clamp(source.late_penalty_multiplier, 0, 5, DEFAULT_POLICY.late_penalty_multiplier),
    absence_multiplier: clamp(source.absence_multiplier, 0, 5, DEFAULT_POLICY.absence_multiplier),
    unpaid_leave_multiplier: clamp(source.unpaid_leave_multiplier, 0, 5, DEFAULT_POLICY.unpaid_leave_multiplier),
  };
}

async function loadPolicy(pool, facilityId) {
  const fid = Math.max(1, parseInt(String(facilityId), 10) || 1);
  const [[row]] = await pool
    .query('SELECT * FROM tbl_hms_attendance_policy WHERE facility_id = ? LIMIT 1', [fid])
    .catch(() => [[null]]);
  return normalise(row);
}

async function savePolicy(pool, facilityId, input) {
  const fid = Math.max(1, parseInt(String(facilityId), 10) || 1);
  const body = input || {};
  const policy = normalise({
    monthly_work_days: body.monthly_work_days,
    standard_daily_hours: body.standard_daily_hours,
    overtime_enabled: body.overtime_enabled ? 1 : 0,
    overtime_multiplier: body.overtime_multiplier,
    late_penalty_multiplier: body.late_penalty_multiplier,
    absence_multiplier: body.absence_multiplier,
    unpaid_leave_multiplier: body.unpaid_leave_multiplier,
  });
  await pool.query(
    `INSERT INTO tbl_hms_attendance_policy
      (facility_id, monthly_work_days, standard_daily_hours, overtime_enabled,
       overtime_multiplier, late_penalty_multiplier, absence_multiplier, unpaid_leave_multiplier)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       monthly_work_days = VALUES(monthly_work_days),
       standard_daily_hours = VALUES(standard_daily_hours),
       overtime_enabled = VALUES(overtime_enabled),
       overtime_multiplier = VALUES(overtime_multiplier),
       late_penalty_multiplier = VALUES(late_penalty_multiplier),
       absence_multiplier = VALUES(absence_multiplier),
       unpaid_leave_multiplier = VALUES(unpaid_leave_multiplier)`,
    [
      fid,
      policy.monthly_work_days,
      policy.standard_daily_hours,
      policy.overtime_enabled,
      policy.overtime_multiplier,
      policy.late_penalty_multiplier,
      policy.absence_multiplier,
      policy.unpaid_leave_multiplier,
    ]
  );
  return policy;
}

/**
 * Convert the period's counted days/minutes into payroll amounts.
 *
 * Rounding is to whole XAF, the smallest unit the statutory engine already uses.
 */
function computeAdjustments({ gross, unpaidDays, absentDays, lateMinutes, overtimeMinutes, policy }) {
  const p = normalise(policy);
  const monthlyDays = p.monthly_work_days;
  const dailyRate = gross > 0 ? gross / monthlyDays : 0;
  const hourlyRate = dailyRate / p.standard_daily_hours;
  const minuteRate = hourlyRate / 60;

  const unpaidLeaveDeduction = Math.round(n(unpaidDays) * dailyRate * p.unpaid_leave_multiplier);
  const absenceDeduction = Math.round(n(absentDays) * dailyRate * p.absence_multiplier);
  const lateDeduction = Math.round(n(lateMinutes) * minuteRate * p.late_penalty_multiplier);
  const overtimeAmount = p.overtime_enabled
    ? Math.round((n(overtimeMinutes) / 60) * hourlyRate * p.overtime_multiplier)
    : 0;

  return {
    policy: p,
    dailyRate,
    hourlyRate,
    unpaidLeaveDeduction,
    absenceDeduction,
    lateDeduction,
    attendanceDeduction: absenceDeduction + lateDeduction,
    overtimeAmount,
  };
}

module.exports = {
  DEFAULT_POLICY,
  ensureAttendancePolicySchema,
  loadPolicy,
  savePolicy,
  computeAdjustments,
  normalise,
};
