'use strict';

/**
 * Apply attendance-driven pay adjustments to a payroll period.
 *
 * Beyond approved unpaid leave and unapproved absence, payroll now also pays
 * recorded overtime and penalises lateness, using the facility's attendance
 * policy.  The original statutory net is preserved by adding any previously
 * stored adjustment back before recalculating, so re-running this helper for an
 * unchanged period is idempotent.
 */

const Policy = require('./attendancePolicy');

async function applyLeaveDeductions(conn, facilityId, year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(year, month, 0);
  const end = `${year}-${String(month).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
  let rows = [];
  try {
    [rows] = await conn.query(
      `SELECT p.id, p.employee_id, p.gross_salary, p.net_salary,
              COALESCE(p.unpaid_leave_deduction, 0) AS old_unpaid_deduction,
              COALESCE(p.attendance_deduction, 0) AS old_attendance_deduction,
              COALESCE(p.overtime_amount, 0) AS old_overtime_amount,
              COALESCE(u.unpaid_days, 0) AS unpaid_days,
              COALESCE(a.absent_days, 0) AS absent_days,
              COALESCE(a.late_minutes, 0) AS late_minutes,
              COALESCE(a.overtime_minutes, 0) AS overtime_minutes
         FROM tbl_hms_payroll_record p
         LEFT JOIN (
           SELECT r.employee_id, SUM(d.days) AS unpaid_days
             FROM tbl_hms_leave_request r
             JOIN tbl_hms_leave_request_day d ON d.request_id = r.id
             JOIN tbl_hms_leave_type t ON t.facility_id = r.facility_id AND t.code = r.leave_type
            WHERE r.facility_id = ? AND r.status = 'approved' AND t.paid = 0
              AND d.leave_date BETWEEN ? AND ?
            GROUP BY r.employee_id
         ) u ON u.employee_id = p.employee_id
         LEFT JOIN (
           SELECT employee_id,
                  COUNT(CASE WHEN status = 'absent' THEN 1 END) AS absent_days,
                  SUM(COALESCE(late_minutes, 0)) AS late_minutes,
                  SUM(COALESCE(overtime_minutes, 0)) AS overtime_minutes
             FROM tbl_hms_attendance
            WHERE facility_id = ? AND att_date BETWEEN ? AND ?
            GROUP BY employee_id
         ) a ON a.employee_id = p.employee_id
        WHERE p.facility_id = ? AND p.year = ? AND p.month = ?`,
      [facilityId, start, end, facilityId, start, end, facilityId, year, month]
    );
  } catch (e) {
    if (/doesn't exist|Unknown table|Unknown column/i.test(String(e.message || ''))) return { updated: 0, skipped: true };
    throw e;
  }
  const policy = await Policy.loadPolicy(conn, facilityId);
  let updated = 0;
  for (const row of rows || []) {
    const gross = Number(row.gross_salary) || 0;
    const unpaidDays = Number(row.unpaid_days) || 0;
    const absentDays = Number(row.absent_days) || 0;
    const lateMinutes = Number(row.late_minutes) || 0;
    const overtimeMinutes = Number(row.overtime_minutes) || 0;
    const amounts = Policy.computeAdjustments({
      gross,
      unpaidDays,
      absentDays,
      lateMinutes,
      overtimeMinutes,
      policy,
    });
    const baseNet = (Number(row.net_salary) || 0)
      + Number(row.old_unpaid_deduction || 0)
      + Number(row.old_attendance_deduction || 0)
      - Number(row.old_overtime_amount || 0);
    const net = Math.max(
      0,
      baseNet
        - amounts.unpaidLeaveDeduction
        - amounts.absenceDeduction
        - amounts.lateDeduction
        + amounts.overtimeAmount
    );
    await conn.query(
      `UPDATE tbl_hms_payroll_record
          SET unpaid_leave_days = ?, unpaid_leave_deduction = ?,
              absence_days = ?, absence_deduction = ?,
              late_minutes = ?, late_deduction = ?,
              overtime_minutes = ?, overtime_amount = ?,
              attendance_deduction = ?, net_salary = ?
        WHERE id = ? AND facility_id = ?`,
      [
        unpaidDays,
        amounts.unpaidLeaveDeduction,
        absentDays,
        amounts.absenceDeduction,
        lateMinutes,
        amounts.lateDeduction,
        overtimeMinutes,
        amounts.overtimeAmount,
        amounts.attendanceDeduction,
        net,
        row.id,
        facilityId,
      ]
    );
    updated += 1;
  }
  return { updated, policy };
}

module.exports = { applyLeaveDeductions };
