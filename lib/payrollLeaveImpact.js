'use strict';

/**
 * Apply approved unpaid leave and unapproved absence deductions to a payroll
 * period. The original statutory net is preserved by adding any previously
 * stored leave deduction back before recalculating, so re-running this helper
 * is idempotent for an unchanged period.
 */
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
              COALESCE(u.unpaid_days, 0) AS unpaid_days,
              COALESCE(a.absent_days, 0) AS absent_days
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
           SELECT employee_id, COUNT(*) AS absent_days
             FROM tbl_hms_attendance
            WHERE facility_id = ? AND status = 'absent' AND att_date BETWEEN ? AND ?
            GROUP BY employee_id
         ) a ON a.employee_id = p.employee_id
        WHERE p.facility_id = ? AND p.year = ? AND p.month = ?`,
      [facilityId, start, end, facilityId, start, end, facilityId, year, month]
    );
  } catch (e) {
    if (/doesn't exist|Unknown table|Unknown column/i.test(String(e.message || ''))) return { updated: 0, skipped: true };
    throw e;
  }
  let updated = 0;
  for (const row of rows || []) {
    const gross = Number(row.gross_salary) || 0;
    const dailyRate = gross / 22;
    const unpaidDays = Number(row.unpaid_days) || 0;
    const absentDays = Number(row.absent_days) || 0;
    const unpaidDeduction = Math.round(unpaidDays * dailyRate);
    const attendanceDeduction = Math.round(absentDays * dailyRate);
    const baseNet = (Number(row.net_salary) || 0) + Number(row.old_unpaid_deduction || 0) + Number(row.old_attendance_deduction || 0);
    const net = Math.max(0, baseNet - unpaidDeduction - attendanceDeduction);
    await conn.query(
      `UPDATE tbl_hms_payroll_record
          SET unpaid_leave_days = ?, unpaid_leave_deduction = ?, attendance_deduction = ?, net_salary = ?
        WHERE id = ? AND facility_id = ?`,
      [unpaidDays, unpaidDeduction, attendanceDeduction, net, row.id, facilityId]
    );
    updated += 1;
  }
  return { updated };
}

module.exports = { applyLeaveDeductions };