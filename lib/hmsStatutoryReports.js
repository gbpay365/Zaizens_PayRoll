'use strict';

/**
 * Payroll statutory declaration payloads (CNPS / DGI monthly & annual summaries).
 */
async function loadEmployerSettings(pool, facilityId) {
  const [[settings]] = await pool
    .query(
      `SELECT employer_niu, employer_cnps_number, cnps_regime, tax_year
       FROM tbl_hms_payroll_settings
       WHERE facility_id = ?
       ORDER BY tax_year DESC
       LIMIT 1`,
      [facilityId]
    )
    .catch(() => [[{}]]);
  const [[facility]] = await pool
    .query('SELECT name FROM tbl_facility WHERE id = ? LIMIT 1', [facilityId])
    .catch(() => [[null]]);
  return {
    employerNiu: String(settings?.employer_niu || '').trim(),
    employerCnps: String(settings?.employer_cnps_number || '').trim(),
    cnpsRegime: String(settings?.cnps_regime != null ? settings.cnps_regime : '1'),
    facilityName: String(facility?.name || '').trim(),
  };
}

async function loadMonthlySummary(pool, facilityId, month, year) {
  const [[sum]] = await pool
    .query(
      `SELECT COUNT(*) AS emp_cnt,
        SUM(gross_salary) AS gross,
        SUM(cnps_employee) AS cnps_employee,
        SUM(cnps_employer) AS cnps_employer,
        SUM(cimr_employee) AS cimr,
        SUM(crtv_deduction) AS crtv,
        SUM(council_tax_deduction) AS council,
        SUM(development_tax_deduction) AS dev,
        SUM(cnhc_deduction) AS cnhc,
        SUM(income_tax) AS irpp,
        SUM(net_salary) AS net
       FROM tbl_hms_payroll_record
       WHERE facility_id = ? AND month = ? AND year = ?`,
      [facilityId, month, year]
    )
    .catch(() => [[{}]]);
  return sum || {};
}

async function loadMonthlyLines(pool, facilityId, month, year) {
  const [rows] = await pool
    .query(
      `SELECT e.employee_id, e.first_name, e.last_name, e.cnps_ref,
        p.gross_salary, p.cnps_employee, p.cnps_employer, p.cimr_employee,
        p.income_tax, p.net_salary, p.payout_status
       FROM tbl_hms_payroll_record p
       JOIN tbl_employee e ON e.id = p.employee_id
       WHERE p.facility_id = ? AND p.month = ? AND p.year = ?
       ORDER BY e.last_name, e.first_name`,
      [facilityId, month, year]
    )
    .catch(() => [[]]);
  return rows || [];
}

async function loadAnnualSummary(pool, facilityId, year) {
  const [[sum]] = await pool
    .query(
      `SELECT COUNT(DISTINCT employee_id) AS emp_cnt,
        SUM(gross_salary) AS gross,
        SUM(cnps_employee) AS cnps_employee,
        SUM(cnps_employer) AS cnps_employer,
        SUM(cimr_employee) AS cimr,
        SUM(income_tax) AS irpp,
        SUM(net_salary) AS net
       FROM tbl_hms_payroll_record
       WHERE facility_id = ? AND year = ?`,
      [facilityId, year]
    )
    .catch(() => [[{}]]);
  return sum || {};
}

async function loadAnnualLines(pool, facilityId, year) {
  const [rows] = await pool
    .query(
      `SELECT e.employee_id, e.first_name, e.last_name, e.cnps_ref,
        SUM(p.gross_salary) AS gross_salary,
        SUM(p.cnps_employee) AS cnps_employee,
        SUM(p.cnps_employer) AS cnps_employer,
        SUM(p.cimr_employee) AS cimr_employee,
        SUM(p.income_tax) AS income_tax,
        SUM(p.net_salary) AS net_salary
       FROM tbl_hms_payroll_record p
       JOIN tbl_employee e ON e.id = p.employee_id
       WHERE p.facility_id = ? AND p.year = ?
       GROUP BY e.id, e.employee_id, e.first_name, e.last_name, e.cnps_ref
       ORDER BY e.last_name, e.first_name`,
      [facilityId, year]
    )
    .catch(() => [[]]);
  return rows || [];
}

const REPORT_KINDS = Object.freeze({
  'cnps-monthly': {
    title: 'CNPS — Monthly declaration',
    subtitle: 'Monthly CNPS cotisations summary from processed payroll.',
    period: 'monthly',
    accent: '#1d4ed8',
  },
  'dgi-monthly': {
    title: 'DGI — Monthly declaration',
    subtitle: 'Monthly IRPP and payroll tax summary for DGI filing.',
    period: 'monthly',
    accent: '#b91c1c',
  },
  'cnps-annual': {
    title: 'CNPS — Annual summary',
    subtitle: 'Calendar-year CNPS totals by employee.',
    period: 'annual',
    accent: '#1e40af',
  },
  'dgi-annual': {
    title: 'DGI — Annual summary',
    subtitle: 'Calendar-year gross, IRPP, and net by employee.',
    period: 'annual',
    accent: '#991b1b',
  },
});

function fmtMoney(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
}

module.exports = {
  REPORT_KINDS,
  fmtMoney,
  loadEmployerSettings,
  loadMonthlySummary,
  loadMonthlyLines,
  loadAnnualSummary,
  loadAnnualLines,
};
