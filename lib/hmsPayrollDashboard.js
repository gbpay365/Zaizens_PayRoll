/**
 * Lightweight KPIs for payroll hub & monthly screens (no calculation changes).
 */
async function loadPayrollDashboard(pool, facilityId) {
  const fid = Math.max(1, parseInt(facilityId, 10) || 1);
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const out = {
    month,
    year,
    monthLabel: now.toLocaleString('en-GB', { month: 'long' }),
    pendingCount: 0,
    paidCount: 0,
    periodNet: 0,
    periodGross: 0,
    profilesConfigured: 0,
    staffActive: 0
  };

  try {
    const [[st]] = await pool.query(
      'SELECT COUNT(*) AS c FROM tbl_employee WHERE status = 1'
    );
    out.staffActive = Number(st?.c || 0);
  } catch (e) {
    out.staffActive = 0;
  }

  try {
    const [[pr]] = await pool.query(
      `SELECT COUNT(DISTINCT employee_id) AS c FROM tbl_hms_pay_profile
       WHERE facility_id = ? AND (basic_salary > 0 OR housing_allowance > 0 OR transport_allowance > 0 OR other_allowances > 0)`,
      [fid]
    );
    out.profilesConfigured = Number(pr?.c || 0);
  } catch (e) {
    out.profilesConfigured = 0;
  }

  try {
    const [rows] = await pool.query(
      `SELECT payout_status, gross_salary, net_salary FROM tbl_hms_payroll_record
       WHERE facility_id = ? AND month = ? AND year = ?`,
      [fid, month, year]
    );
    (rows || []).forEach((r) => {
      const st = String(r.payout_status || 'pending').toLowerCase();
      if (st === 'paid') out.paidCount += 1;
      else out.pendingCount += 1;
      out.periodGross += Number(r.gross_salary || 0);
      out.periodNet += Number(r.net_salary || 0);
    });
  } catch (e) {
    /* schema may not exist yet */
  }

  return out;
}

module.exports = { loadPayrollDashboard };
