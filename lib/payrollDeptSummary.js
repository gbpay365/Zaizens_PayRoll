'use strict';

async function rebuildDeptSummaries(pool, facilityId, year, month) {
  const fid = parseInt(String(facilityId), 10) || 1;
  const y = parseInt(String(year), 10) || 0;
  const m = parseInt(String(month), 10) || 0;
  if (y < 2000 || m < 1 || m > 12) return [];

  const [rows] = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(e.primary_department), ''), 'Unassigned') AS department_name,
            COUNT(*) AS headcount,
            SUM(COALESCE(p.gross_salary, 0)) AS gross_payroll,
            SUM(COALESCE(p.net_salary, 0)) AS net_payroll,
            SUM(
              GREATEST(0, LEAST(COALESCE(p.gross_salary, 0), 750000) * 0.112)
              + COALESCE(p.gross_salary, 0) * 0.015
              + COALESCE(p.gross_salary, 0) * 0.01
            ) AS employer_charges
       FROM tbl_hms_payroll_record p
       INNER JOIN tbl_employee e ON e.id = p.employee_id
      WHERE p.facility_id = ? AND p.year = ? AND p.month = ?
      GROUP BY department_name
      ORDER BY department_name ASC`,
    [fid, y, m]
  );

  const summaries = (rows || []).map((r) => ({
    department: r.department_name || 'Unassigned',
    headcount: parseInt(String(r.headcount), 10) || 0,
    gross_payroll: parseFloat(r.gross_payroll) || 0,
    net_payroll: parseFloat(r.net_payroll) || 0,
    employer_charges: parseFloat(r.employer_charges) || 0,
  }));

  for (const row of summaries) {
    await pool.query(
      `INSERT INTO tbl_hms_payroll_dept_summary (
        facility_id, year, month, department_name, headcount, gross_payroll, net_payroll, employer_charges, synced_at
      ) VALUES (?,?,?,?,?,?,?,?,NOW())
      ON DUPLICATE KEY UPDATE
        headcount=VALUES(headcount),
        gross_payroll=VALUES(gross_payroll),
        net_payroll=VALUES(net_payroll),
        employer_charges=VALUES(employer_charges),
        synced_at=NOW()`,
      [fid, y, m, row.department, row.headcount, row.gross_payroll, row.net_payroll, row.employer_charges]
    );
  }

  return summaries;
}

module.exports = { rebuildDeptSummaries };
