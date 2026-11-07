// HR / Payroll / Cameroon monthly runs — parity with PHP hms payroll.php + payroll-profiles.php
const ensureHrPayrollSchema = require('../lib/ensureHrPayrollSchema');
const ensureEmployeeHrSchema = require('../lib/ensureEmployeeHrSchema');
const {
  displayPosition,
  maskBankAccount,
  resolveHireDate,
  formatHireDateDisplay,
  loadRoleTitleMap,
  resolveRoleTitle,
} = require('../lib/hmsEmployeeHr');
const hmsFormatDate = require('../lib/hmsFormatDate');
const {
 hmsPayrollCameroonCalculate,
 parseBrackets,
 DEFAULT_IRPP_BRACKETS,
} = require('../lib/hmsPayrollCameroon');
const { computeFromGross, computeFromNet } = require('../lib/payrollCompensation');
const { loadPayrollDashboard } = require('../lib/hmsPayrollDashboard');
const pagination = require('../lib/pagination');
const hmsStaffAccountGuard = require('../lib/hmsStaffAccountGuard');
const {
  SECTORS: ALLOWANCE_SECTORS,
  loadAllowanceSettings,
  saveAllowanceSettings,
  applyDefaultsToAllowancePostItems,
  repairMedicalAllowanceSettings,
  defaultAllowancesForSector,
  rowToSavePayload,
  computeAllowances,
} = require('../lib/hmsAllowanceCameroon');
const { allPresets: payrollTaxPresets, presetFor: payrollTaxPresetFor } = require('../lib/payrollTaxPresets');
const { countRosterShiftsForMonth } = require('../lib/hmsRoster');
const { syncPayrollPeriodToCoreAccount, syncPayrollPeriodsAfterDelete, formatCoreSyncNote } = require('../lib/coreAccountPayrollSync');
const { logAdminAction } = require('../lib/adminAudit');
const { applyLeaveDeductions } = require('../lib/payrollLeaveImpact');
const crypto = require('crypto');

/**
 * Roster-based shift/on-call allowance codes. These are paid in addition to the
 * taxable gross and are themselves NOT subject to CNPS / CFC / CRTV / IRPP / CAC.
 *  - night_duty  → nurses on night roster (tbl_nurse_shift_schedule.shift_type='night')
 *  - on_call     → doctors on on-call roster (tbl_doctor_duty_schedule.duty_type='night')
 */
const TAX_FREE_ALLOWANCE_CODES = new Set(['night_duty', 'on_call']);
// Fallbacks for employer-side charges when the settings row predates the rate
// columns. CNPS mirrors the payslip (4.2% pension + 7% family benefits, capped).
const DEFAULT_EMPLOYER_RATES = { cnps: 11.2, cfc: 1.5, fne: 1.0 };
const EMPLOYER_CNPS_CAP = 750000;

function auditAmount(value) {
 return Math.round(Number(value) || 0).toLocaleString('en-US');
}

function payProfileAmounts(row) {
 const p = row || {};
 return {
  basic_salary: Math.max(0, Math.round(Number(p.basic_salary) || 0)),
  housing_allowance: Math.max(0, Math.round(Number(p.housing_allowance) || 0)),
  transport_allowance: Math.max(0, Math.round(Number(p.transport_allowance) || 0)),
  medical_risk_allowance: Math.max(0, Math.round(Number(p.medical_risk_allowance) || 0)),
  responsibility_allowance: Math.max(0, Math.round(Number(p.responsibility_allowance) || 0)),
 };
}

function payProfileAuditLine(amounts) {
 const a = payProfileAmounts(amounts);
 return `Basic ${auditAmount(a.basic_salary)}, Housing ${auditAmount(a.housing_allowance)}, ` +
  `Transport ${auditAmount(a.transport_allowance)}, Medical risk ${auditAmount(a.medical_risk_allowance)}, ` +
  `Responsibility ${auditAmount(a.responsibility_allowance)}`;
}

function payProfileSnapshot(row) {
 const p = row || {};
 return {
  basic_salary: Math.max(0, Math.round(Number(p.basic_salary) || 0)),
  housing_allowance: Math.max(0, Math.round(Number(p.housing_allowance) || 0)),
  transport_allowance: Math.max(0, Math.round(Number(p.transport_allowance) || 0)),
  other_allowances: Math.max(0, Math.round(Number(p.other_allowances) || 0)),
  medical_risk_allowance: Math.max(0, Math.round(Number(p.medical_risk_allowance) || 0)),
  responsibility_allowance: Math.max(0, Math.round(Number(p.responsibility_allowance) || 0)),
  is_specialist: parseInt(p.is_specialist || 0, 10) === 1 ? 1 : 0,
  night_shifts_per_month: Math.max(0, parseInt(p.night_shifts_per_month || 0, 10) || 0),
  on_call_per_month: Math.max(0, parseInt(p.on_call_per_month || 0, 10) || 0),
 };
}

function payProfileSnapshotChanged(before, after) {
 if (!before) return true;
 return Object.keys(after).some((key) => before[key] !== after[key]);
}

function manualPayProfileAuditLine(amounts) {
 const a = payProfileSnapshot(amounts);
 return `Basic ${auditAmount(a.basic_salary)}, Housing ${auditAmount(a.housing_allowance)}, ` +
  `Transport ${auditAmount(a.transport_allowance)}, Other ${auditAmount(a.other_allowances)}, ` +
  `Medical risk ${auditAmount(a.medical_risk_allowance)}, Responsibility ${auditAmount(a.responsibility_allowance)}; ` +
  `Specialist ${a.is_specialist ? 'yes' : 'no'}, Night shifts ${a.night_shifts_per_month}, On-call ${a.on_call_per_month}`;
}

function payrollRecordAuditDetail(row) {
 const r = row || {};
 const name = `${r.first_name || ''} ${r.last_name || ''}`.trim() || `Employee #${r.employee_id || '—'}`;
 const period = hmsFormatDate.formatMonthYear(new Date(Number(r.year) || 2000, (Number(r.month) || 1) - 1, 1));
 return `Deleted payroll record for ${name} — ${period}: ` +
  `Gross ${auditAmount(r.gross_salary)} XAF, Net ${auditAmount(r.net_salary)} XAF, ` +
  `payout status ${r.payout_status || 'pending'}.`;
}

function payrollRecordReversalDetail(row, reason) {
 const r = row || {};
 const name = `${r.first_name || ''} ${r.last_name || ''}`.trim() || `Employee #${r.employee_id || '—'}`;
 const period = hmsFormatDate.formatMonthYear(new Date(Number(r.year) || 2000, (Number(r.month) || 1) - 1, 1));
 return `Reversed paid payroll record for ${name} — ${period}: ` +
  `Gross ${auditAmount(r.gross_salary)} XAF, Net ${auditAmount(r.net_salary)} XAF. ` +
  `Reason: ${reason || '—'}.`;
}

function csvCell(value) {
 const s = String(value == null ? '' : value);
 return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parsePeriodParam(value) {
 const m = /^(\d{4})-(\d{2})$/.exec(String(value || '').trim());
 if (!m) return null;
 const year = parseInt(m[1], 10);
 const month = parseInt(m[2], 10);
 if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
 return { year, month, key: year * 100 + month, value: `${m[1]}-${m[2]}` };
}

function normalizePeriodRange(from, to) {
 if (from && to && from.key > to.key) return { from: to, to: from };
 return { from, to };
}

function parseIsoDateParam(value) {
 const raw = String(value || '').trim();
 if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
 const d = new Date(`${raw}T00:00:00Z`);
 if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return null;
 return raw;
}

function applyPeriodRange(where, params, from, to) {
 let sql = where;
 const values = params.slice();
 if (from) {
  sql += ' AND (p.year * 100 + p.month) >= ?';
  values.push(from.key);
 }
 if (to) {
  sql += ' AND (p.year * 100 + p.month) <= ?';
  values.push(to.key);
 }
 return { where: sql, params: values };
}

/** Employer contributions for every payroll run matching the supplied filter. */
async function loadEmployerRunTotals(pool, fid, fromJoin, listParams) {
 const [[rateRow]] = await pool.query(
  `SELECT employer_cnps_rate, employer_cfc_rate, employer_fne_rate
     FROM tbl_hms_payroll_settings WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1`,
  [fid]
 );
 const rateOr = (value, fallback) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
 };
 const rates = {
  cnps: rateOr(rateRow && rateRow.employer_cnps_rate, DEFAULT_EMPLOYER_RATES.cnps),
  cfc: rateOr(rateRow && rateRow.employer_cfc_rate, DEFAULT_EMPLOYER_RATES.cfc),
  fne: rateOr(rateRow && rateRow.employer_fne_rate, DEFAULT_EMPLOYER_RATES.fne),
 };
 const [groupRows] = await pool.query(
  `SELECT p.year, p.month, COUNT(*) AS line_count,
          COALESCE(SUM(p.gross_salary), 0) AS gross,
          COALESCE(SUM(ROUND(LEAST(COALESCE(p.gross_salary, 0), ?) * ? / 100)), 0) AS employer_cnps,
          COALESCE(SUM(ROUND(COALESCE(p.gross_salary, 0) * ? / 100)), 0) AS employer_cfc,
          COALESCE(SUM(ROUND(COALESCE(p.gross_salary, 0) * ? / 100)), 0) AS employer_fne
     ${fromJoin}
       AND LOWER(COALESCE(p.payout_status, 'pending')) <> 'reversed'
    GROUP BY p.year, p.month
    ORDER BY p.year DESC, p.month DESC`,
  [EMPLOYER_CNPS_CAP, rates.cnps, rates.cfc, rates.fne, ...listParams]
 );
 const runTotals = (groupRows || []).map((r) => {
  const gross = Number(r.gross) || 0;
  const employerCnps = Number(r.employer_cnps) || 0;
  const employerCfc = Number(r.employer_cfc) || 0;
  const employerFne = Number(r.employer_fne) || 0;
  return {
   year: parseInt(r.year, 10) || 0,
   month: parseInt(r.month, 10) || 0,
   count: parseInt(r.line_count, 10) || 0,
   gross,
   employerCnps,
   employerCfc,
   employerFne,
   cost: gross + employerCnps + employerCfc + employerFne,
  };
 });
 const summary = runTotals.length
  ? runTotals.reduce(
     (acc, r) => ({
      count: acc.count + r.count,
      gross: acc.gross + r.gross,
      employerCnps: acc.employerCnps + r.employerCnps,
      employerCfc: acc.employerCfc + r.employerCfc,
      employerFne: acc.employerFne + r.employerFne,
      cost: acc.cost + r.cost,
     }),
     { count: 0, gross: 0, employerCnps: 0, employerCfc: 0, employerFne: 0, cost: 0 }
    )
  : null;
 return { runTotals, summary, rates };
}

module.exports = function registerHrPayrollRoutes(app, pool, requireAuth, deps) {
 const { requirePayrollAccess, requireAdminOrSuper, requireHrSelfService } = deps;

 function facilityId(req) {
  return Math.max(1, parseInt(req.session.facilityId, 10) || 1);
 }

 function sessionEmpId(req) {
  return parseInt(req.session.user?.id, 10) || 0;
 }

 function isPayrollAdmin(req) {
  const r = String(req.session.user?.role || '');
  return r === '1' || r === '99';
 }

 /** Leave balances / approvals / holidays — Admin, Super Admin, or ACL `hr.leave.approve`. */
 function requireHrLeaveAdmin(req, res, next) {
  const r = String((req.session.user || {}).role || '');
  if (r === '1' || r === '99') return next();
  const perms = res.locals.userPerms || [];
  if (perms.includes('*') || perms.includes('hr.leave.approve')) return next();
  const msg = 'Access denied. HR leave admin permission required.';
  if (req.method === 'POST' || (req.headers.accept || '').includes('application/json')) {
   return res.status(403).json({ ok: false, error: msg });
  }
  return res.redirect('/payroll?err=' + encodeURIComponent(msg));
 }

 /** Edit payroll tax settings / profiles — Admin, Super Admin, or `payroll.write`. */
 function requirePayrollMutate(req, res, next) {
  const r = String((req.session.user || {}).role || '');
  if (r === '1' || r === '99') return next();
  const perms = res.locals.userPerms || [];
  if (perms.includes('*') || perms.includes('payroll.write')) return next();
  const msg = 'Access denied. Payroll write permission required.';
  if (req.method === 'POST' || (req.headers.accept || '').includes('application/json')) {
   return res.status(403).json({ ok: false, error: msg });
  }
  return res.redirect('/payroll?err=' + encodeURIComponent(msg));
 }

 /** Active staff list for the current facility (legacy unassigned rows included). */
 async function activeStaff(facilityIdArg) {
  const fid = Math.max(1, parseInt(facilityIdArg, 10) || 1);
  let rows = [];
  try {
   const [r] = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.role, e.employee_id, e.joining_date,
            COALESCE((SELECT MIN(title) FROM tbl_role WHERE CAST(role AS UNSIGNED) = CAST(e.role AS UNSIGNED)), '') AS role_title
     FROM tbl_employee e
     WHERE e.status = 1
       AND (e.default_facility_id IS NULL OR e.default_facility_id = ?)
     ORDER BY e.last_name, e.first_name`,
    [fid]
   );
   rows = r || [];
  } catch (e) {
   const [r] = await pool.query(
    `SELECT id, first_name, last_name, role
     FROM tbl_employee
     WHERE status = 1
       AND (default_facility_id IS NULL OR default_facility_id = ?)
     ORDER BY last_name, first_name`,
    [fid]
   );
   rows = r || [];
  }
  for (const row of rows) {
   const mat = row.employee_id != null && String(row.employee_id).trim() !== '' ? String(row.employee_id).trim() : String(row.id);
   row.employee_ref = mat;
  }
  return rows;
 }

 // ── Monthly payroll (list + admin actions) ─────────────────
 app.get('/payroll/monthly', requireAuth, requirePayrollAccess, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const uid = sessionEmpId(req);
   const admin = isPayrollAdmin(req);
   const perms = Array.isArray(res.locals.userPerms) ? res.locals.userPerms : [];
   const canPayrollSettings =
    isPayrollAdmin(req) || perms.includes('*') || perms.includes('payroll.write');
   const months = {
    1: 'January',
    2: 'February',
    3: 'March',
    4: 'April',
    5: 'May',
    6: 'June',
    7: 'July',
    8: 'August',
    9: 'September',
    10: 'October',
    11: 'November',
    12: 'December'
   };
   const cy = new Date().getFullYear();

   const searchQ = String(req.query.q || '').trim();
   const range = normalizePeriodRange(
    parsePeriodParam(req.query.from),
    parsePeriodParam(req.query.to)
   );
   const runFrom = range.from;
   const runTo = range.to;
   let where = 'p.facility_id = ?';
   const listParams = [fid];
   if (!admin) {
    where += ' AND p.employee_id = ?';
    listParams.push(uid);
   }
   if (searchQ) {
    const like = '%' + searchQ + '%';
    where +=
     ' AND (e.first_name LIKE ? OR e.last_name LIKE ? OR CONCAT(e.first_name, " ", e.last_name) LIKE ?)';
    listParams.push(like, like, like);
   }
   const fromJoin =
    'FROM tbl_hms_payroll_record p INNER JOIN tbl_employee e ON e.id = p.employee_id WHERE ' +
    where;
   const { rows, pager } = await pagination.fetchPage(pool, {
    req,
    pageParam: 'p',
    basePath: '/payroll/monthly',
    query: searchQ ? { q: searchQ } : {},
    countSql: `SELECT COUNT(*) AS total ${fromJoin}`,
    countParams: listParams,
    dataSql: `SELECT p.*, e.first_name, e.last_name ${fromJoin} ORDER BY p.year DESC, p.month DESC, e.last_name`,
    dataParams: listParams,
   }).catch(() => ({
    rows: [],
    pager: Object.assign(pagination.metaFromTotal(0, 1), {
     pageParam: 'p',
     basePath: '/payroll/monthly',
     query: searchQ ? { q: searchQ } : {},
    }),
   }));

   let metrics = {};
   try {
    metrics = await loadPayrollDashboard(pool, fid);
   } catch (e) {
    metrics = {};
   }

   let allDeletableIds = [];
   if (admin) {
    const [idRows] = await pool
     .query(
      `SELECT p.id ${fromJoin} AND LOWER(COALESCE(p.payout_status, 'pending')) NOT IN ('paid', 'reversed') ORDER BY p.year DESC, p.month DESC, p.id`,
      listParams
     )
     .catch(() => [[]]);
    allDeletableIds = (idRows || [])
     .map((r) => parseInt(r.id, 10))
     .filter((id) => id > 0);
   }

   // Employer burden per monthly run. Rates are read from the facility settings
   // and applied to each line exactly as on the payslip (CNPS is capped).
   let runTotals = [];
   let runTotalsSummary = null;
   try {
    const filtered = applyPeriodRange(where, listParams, runFrom, runTo);
    const totalsJoin =
     'FROM tbl_hms_payroll_record p INNER JOIN tbl_employee e ON e.id = p.employee_id WHERE ' +
     filtered.where;
    const totals = await loadEmployerRunTotals(pool, fid, totalsJoin, filtered.params);
    runTotals = totals.runTotals;
    runTotalsSummary = totals.summary;
   } catch (err) {
    console.warn('PAYROLL MONTHLY employer totals:', err.message);
   }

   res.render('payroll-monthly', {
    title: 'Payroll (monthly) - ZAIZENS',
    months,
    cy,
    rows,
    pager,
    searchQ,
    metrics,
    isAdmin: admin,
    canPayrollSettings,
    sessionUid: uid,
    allDeletableIds,
    runTotals,
    runTotalsSummary,
    runFrom: runFrom ? runFrom.value : '',
    runTo: runTo ? runTo.value : '',
    flash: req.query.msg || null,
    error: req.query.err || null
   });
  } catch (err) {
   console.error('PAYROLL MONTHLY GET:', err.message);
   res.status(500).render('error', { title: 'Error', message: err.message, status: 500 });
  }
 });

 // Accounting export of the same employer-cost totals shown on the monthly page.
 app.get('/payroll/monthly/export.csv', requireAuth, requirePayrollAccess, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const uid = sessionEmpId(req);
   const admin = isPayrollAdmin(req);
   const searchQ = String(req.query.q || '').trim();
   const range = normalizePeriodRange(
    parsePeriodParam(req.query.from),
    parsePeriodParam(req.query.to)
   );
   let where = 'p.facility_id = ?';
   const listParams = [fid];
   if (!admin) {
    where += ' AND p.employee_id = ?';
    listParams.push(uid);
   }
   if (searchQ) {
    const like = '%' + searchQ + '%';
    where +=
     ' AND (e.first_name LIKE ? OR e.last_name LIKE ? OR CONCAT(e.first_name, " ", e.last_name) LIKE ?)';
    listParams.push(like, like, like);
   }
   const filtered = applyPeriodRange(where, listParams, range.from, range.to);
   const fromJoin =
    'FROM tbl_hms_payroll_record p INNER JOIN tbl_employee e ON e.id = p.employee_id WHERE ' +
    filtered.where;
   const { runTotals, summary, rates } = await loadEmployerRunTotals(
    pool,
    fid,
    fromJoin,
    filtered.params
   );
   const lines = [
    [
     'period',
     'lines',
     'gross_salary',
     'employer_cnps_rate',
     'employer_cnps',
     'employer_cfc_rate',
     'employer_cfc',
     'employer_fne_rate',
     'employer_fne',
     'total_employer_cost',
    ].join(';'),
   ];
   runTotals.forEach((run) => {
    lines.push(
     [
      `${run.year}-${String(run.month).padStart(2, '0')}`,
      run.count,
      run.gross.toFixed(2),
      rates.cnps,
      run.employerCnps.toFixed(2),
      rates.cfc,
      run.employerCfc.toFixed(2),
      rates.fne,
      run.employerFne.toFixed(2),
      run.cost.toFixed(2),
     ]
      .map(csvCell)
      .join(';')
    );
   });
   if (summary) {
    lines.push(
     [
      'ALL',
      summary.count,
      summary.gross.toFixed(2),
      rates.cnps,
      summary.employerCnps.toFixed(2),
      rates.cfc,
      summary.employerCfc.toFixed(2),
      rates.fne,
      summary.employerFne.toFixed(2),
      summary.cost.toFixed(2),
     ]
      .map(csvCell)
      .join(';')
    );
   }
   const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
   const rangeTag = `${range.from ? range.from.value : 'all'}_to_${range.to ? range.to.value : 'all'}`;
   res.setHeader('Content-Type', 'text/csv; charset=utf-8');
   res.setHeader(
    'Content-Disposition',
    `attachment; filename="payroll_employer_costs_${fid}_${rangeTag}_${stamp}.csv"`
   );
   res.send('\uFEFF' + lines.join('\r\n'));
  } catch (err) {
   console.error('PAYROLL MONTHLY CSV:', err.message);
   res.status(500).send(err.message);
  }
 });

 /** Printable payslip for one payroll row (PHP parity: generate-payslip.php). */
 app.get('/payroll/payslip/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const fid = facilityId(req);
  const uid = sessionEmpId(req);
  if (id < 1) return res.status(404).send('Not found');
  try {
   await ensureHrPayrollSchema(pool);
   await ensureEmployeeHrSchema(pool);
   let row = null;
   try {
    const [[r]] = await pool.query(
     `SELECT p.*,
             e.first_name, e.last_name, e.role AS emp_role,
             e.employee_id AS emp_matricule,
             e.phone AS emp_phone,
             COALESCE(e.joining_date, NULL) AS emp_joining_date,
             COALESCE(NULLIF(TRIM(e.primary_department), ''), '') AS primary_department,
             COALESCE(NULLIF(TRIM(e.job_title), ''), '') AS job_title,
             COALESCE(NULLIF(TRIM(e.cnps_number), ''), '') AS emp_cnps,
             COALESCE(NULLIF(TRIM(e.tax_niu), ''), '') AS emp_tax_niu,
             COALESCE(NULLIF(TRIM(e.nic_number), ''), '') AS emp_nic,
             COALESCE(NULLIF(TRIM(e.bank_name), ''), '') AS emp_bank,
             COALESCE(NULLIF(TRIM(e.bank_account_no), ''), '') AS emp_bank_account
      FROM tbl_hms_payroll_record p
      INNER JOIN tbl_employee e ON e.id = p.employee_id
      WHERE p.id = ? AND p.facility_id = ? LIMIT 1`,
     [id, fid]
    );
    row = r || null;
   } catch (e) {
    const [[r]] = await pool.query(
     `SELECT p.*, e.first_name, e.last_name, e.role AS emp_role,
             e.employee_id AS emp_matricule, '' AS primary_department,
             NULL AS emp_phone, NULL AS emp_joining_date,
             '' AS job_title, '' AS emp_cnps, '' AS emp_tax_niu,
             '' AS emp_nic, '' AS emp_bank, '' AS emp_bank_account
      FROM tbl_hms_payroll_record p
      INNER JOIN tbl_employee e ON e.id = p.employee_id
      WHERE p.id = ? AND p.facility_id = ? LIMIT 1`,
     [id, fid]
    );
    row = r || null;
   }
   if (!row) return res.status(404).send('Not found');
   const eid = parseInt(row.employee_id, 10) || 0;
   if (!isPayrollAdmin(req) && (uid < 1 || uid !== eid)) {
    return res.status(403).send('Forbidden');
   }

   // Fetch employer settings (address, CNPS no, NIU, phone)
   const [[empSettings]] = await pool.query(
    `SELECT employer_cnps_number, employer_niu, employer_address, employer_phone, employer_email,
            employer_cnps_rate, employer_cfc_rate, employer_fne_rate
       FROM tbl_hms_payroll_settings WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1`,
    [fid]
   ).catch(() => [[{}]]);

   // Fetch hire_date from pay profile
   const [[payProf]] = await pool.query(
    'SELECT hire_date FROM tbl_hms_pay_profile WHERE facility_id = ? AND employee_id = ? LIMIT 1',
    [fid, eid]
   ).catch(() => [[{}]]);

   const month = Math.max(1, Math.min(12, parseInt(row.month, 10) || 1));
   const year = Math.max(2000, Math.min(2100, parseInt(row.year, 10) || new Date().getFullYear()));
   const period = hmsFormatDate.formatMonthYear(new Date(year, month - 1, 1));
   const payDate = new Date(year, month, 0); // last day of period month
   const payDateStr = hmsFormatDate.formatDisplayDate(payDate);

   const b = parseFloat(row.basic_salary_snap) || 0;
   const h = parseFloat(row.housing_allowance_snap) || 0;
   const t = parseFloat(row.transport_allowance_snap) || 0;
   const o = parseFloat(row.other_allowances_snap) || 0;
   const gross = parseFloat(row.gross_salary) || 0;
   const net   = parseFloat(row.net_salary) || 0;
   const unpaidDeduction = parseFloat(row.unpaid_leave_deduction) || 0;
   const attendanceDeduction = parseFloat(row.attendance_deduction) || 0;
   const ded =
    (parseFloat(row.cnps_employee) || 0) +
    (parseFloat(row.cimr_employee) || 0) +
    (parseFloat(row.crtv_deduction) || 0) +
    (parseFloat(row.council_tax_deduction) || 0) +
    (parseFloat(row.development_tax_deduction) || 0) +
    (parseFloat(row.cnhc_deduction) || 0) +
    (parseFloat(row.income_tax) || 0) +
    unpaidDeduction +
    attendanceDeduction;
   // Employer rates come from the payroll settings (fall back to statutory defaults).
   const rateOr = (value, fallback) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
   };
   const cnpsEmployerRate = rateOr(empSettings && empSettings.employer_cnps_rate, DEFAULT_EMPLOYER_RATES.cnps);
   const cfcEmployerRate = rateOr(empSettings && empSettings.employer_cfc_rate, DEFAULT_EMPLOYER_RATES.cfc);
   const fneEmployerRate = rateOr(empSettings && empSettings.employer_fne_rate, DEFAULT_EMPLOYER_RATES.fne);
   const cnpsBase = Math.min(gross, EMPLOYER_CNPS_CAP);
   const cnpsEmployer = Math.round((cnpsBase * cnpsEmployerRate) / 100);
   const cimrEmployer = Math.round((gross * cfcEmployerRate) / 100); // column kept as cimrEmployer for compat
   const fneEmployer = Math.round((gross * fneEmployerRate) / 100);
   const employerCost = Math.round(gross) + cnpsEmployer + cimrEmployer + fneEmployer;
   const dept = String(row.primary_department || '').trim();
   const printed = hmsFormatDate.formatDisplayDate(new Date());

   // Hire date: from employee record (joining_date), then legacy pay-profile value
   const hireDateRaw = resolveHireDate(row.emp_joining_date, payProf && payProf.hire_date);
   const hireDate = hireDateRaw ? String(hireDateRaw).slice(0, 10) : null;
   const hireDateDisplay = hireDate ? hmsFormatDate.formatDisplayDate(hireDate) : '—';

   // Payslip number
   const slipNo = `PAY-${year}-${String(month).padStart(2, '0')}-${String(id).padStart(4, '0')}`;

   // Parse allowances snapshot
   let allowanceLines = [];
   let allowancesTotal = 0;
   try {
    const snap = JSON.parse(String(row.allowances_snap || 'null'));
    if (snap && Array.isArray(snap.lines)) {
     allowanceLines = snap.lines;
     allowancesTotal = parseInt(snap.total, 10) || 0;
    }
   } catch (_) { /* no snapshot */ }

   // Split allowances into TAXABLE (above gross) and TAX-FREE (roster-driven, on top of net).
   // For legacy records (no non_taxable_allowance column populated) we treat all
   // allowances as taxable so the previously-saved gross_salary / net_salary stay consistent.
   const persistedNonTaxable = parseFloat(row.non_taxable_allowance) || 0;
   const taxFreeAllowanceLines = persistedNonTaxable > 0
    ? allowanceLines.filter((l) => TAX_FREE_ALLOWANCE_CODES.has(l.code))
    : [];
   const taxableAllowanceLines = persistedNonTaxable > 0
    ? allowanceLines.filter((l) => !TAX_FREE_ALLOWANCE_CODES.has(l.code))
    : allowanceLines;
   const taxFreeAllowancesTotal = persistedNonTaxable > 0 ? Math.round(persistedNonTaxable) : 0;
   const taxableAllowancesTotal = Math.max(0, allowancesTotal - taxFreeAllowancesTotal);
   // "Taxable Gross" subtotal shown on the payslip — what statutory deductions are based on.
   const taxableGross = Math.max(0, Math.round(gross - taxFreeAllowancesTotal));
   // Net-after-tax (before the tax-free roster allowances are added back).
   const netAfterTax = Math.max(0, Math.round(net - taxFreeAllowancesTotal));

   // Role → position label: prefer tbl_role.title (covers Nurse=101, Director=106, etc.)
   // Falls back to hardcoded legacy map (covers Doctor=2, Nurse=7) and finally to raw role number.
   const legacyPositionMap = {
    '1': 'Administrator', '2': 'Medical Doctor', '3': 'Front Desk Officer',
    '4': 'Laboratory Technician', '5': 'Pharmacist', '6': 'Radiographer',
    '7': 'Nurse', '8': 'Nursing Aid', '9': 'Accountant',
    '11': 'Cashier', '99': 'Super Administrator'
   };
   const roleTitleMap = await loadRoleTitleMap(pool);
   const rolePositionTitle =
     resolveRoleTitle(row.emp_role, roleTitleMap) ||
     legacyPositionMap[String(row.emp_role || '')] ||
     String(row.emp_role || '');
   const position = displayPosition({ job_title: row.job_title }, rolePositionTitle);
   const empCnps = String(row.emp_cnps || '').trim();
   const empNic = String(row.emp_nic || '').trim();
   const empTaxNiu = String(row.emp_tax_niu || '').trim();
   const empBank = String(row.emp_bank || '').trim();
   const empAccountMasked = maskBankAccount(row.emp_bank_account);

   res.render('payslip', {
    title: `Payslip — ${String(row.first_name || '').trim()} ${String(row.last_name || '').trim()}`.trim(),
    row,
    period,
    payDateStr,
    slipNo,
    b, h, t, o,
    gross, ded,
    cnpsEmployer, cimrEmployer, fneEmployer, employerCost,
    cnpsEmployerRate, cfcEmployerRate, fneEmployerRate,
    dept, printed,
    allowanceLines, allowancesTotal,
    taxableAllowanceLines, taxFreeAllowanceLines,
    taxableAllowancesTotal, taxFreeAllowancesTotal,
    taxableGross, netAfterTax,
    hireDate, hireDateDisplay,
    position,
    empCnps, empNic, empTaxNiu, empBank, empAccountMasked,
    empSettings: empSettings || {},
   });
  } catch (e) {
   console.error('PAYSLIP GET:', e.message);
   res.status(500).send('Error loading payslip');
  }
 });

 app.post('/payroll/process-month', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  const fid = facilityId(req);
  const month = Math.max(1, Math.min(12, parseInt(req.body.month, 10) || 1));
  const year = Math.max(2000, Math.min(2100, parseInt(req.body.year, 10) || new Date().getFullYear()));
  try {
   await ensureHrPayrollSchema(pool);
   await require('../lib/leaveSystem').ensureLeaveSystemSchema(pool);
   const staff = await activeStaff(fid);
   let processed = 0;
   let corrected = 0;
   let skipped = 0;
   let conn = null;
   try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    for (const em of staff) {
     const eid = parseInt(em.id, 10) || 0;
     if (eid < 1) continue;
     const [[pr]] = await conn
     .query(
      `SELECT basic_salary, housing_allowance, transport_allowance, other_allowances,
              COALESCE(medical_risk_allowance, 0) AS medical_risk_allowance,
              COALESCE(responsibility_allowance, 0) AS responsibility_allowance,
              COALESCE(is_specialist, 0) AS is_specialist,
              hire_date, sector, night_shifts_per_month, on_call_per_month
       FROM tbl_hms_pay_profile WHERE facility_id = ? AND employee_id = ? LIMIT 1`,
      [fid, eid]
     )
     .catch(() => [[null]]);
    const b   = parseFloat(pr?.basic_salary)          || 0;
    const h   = parseFloat(pr?.housing_allowance)      || 0;
    const t   = parseFloat(pr?.transport_allowance)    || 0;
    const o   = parseFloat(pr?.other_allowances)       || 0;
    const mra = parseFloat(pr?.medical_risk_allowance) || 0;
    const ra  = parseFloat(pr?.responsibility_allowance) || 0;
    if (b + h + t + o + mra + ra <= 0) continue;

    const [[ex]] = await conn.query(
     'SELECT id, payout_status FROM tbl_hms_payroll_record WHERE facility_id = ? AND employee_id = ? AND year = ? AND month = ? LIMIT 1 FOR UPDATE',
     [fid, eid, year, month]
    );
    const exStatus = ex ? String(ex.payout_status || 'pending').toLowerCase() : '';
    if (ex && exStatus !== 'reversed') {
     skipped++;
     continue;
    }

    // Roster-based shift counts (Night Shifts / On-Call sessions) for this month.
    // These drive the night_duty + on_call allowances directly from the duty roster,
    // not from manual pay-profile figures, and they are paid TAX-FREE.
    const rosterCounts = await countRosterShiftsForMonth(conn, fid, eid, year, month);

    const empSector = String(pr?.sector || 'medical').toLowerCase();
    const isSpec = parseInt(pr?.is_specialist, 10) === 1;
    const allowSettings = await loadAllowanceSettings(conn, fid, empSector);
    const allowResult = computeAllowances({
     basicSalary: b,
     role: em.role,
     roleTitle: em.role_title || '',
     hireDate: resolveHireDate(em.joining_date, pr?.hire_date),
     settings: allowSettings,
     nightShifts: rosterCounts.nightShifts,
     onCallShifts: rosterCounts.onCall,
     isSpecialist: isSpec,
    });

    // Deduplicate: if the engine already computed a code, suppress the legacy flat value
    // so flat profile fields (mra/ra) don't double-count engine-computed allowances.
    const engineCodes = new Set((allowResult.lines || []).map((l) => l.code));
    const effectiveMra = engineCodes.has('medical_risk')           ? 0 : mra;
    const effectiveRa  = engineCodes.has('medical_responsibility') ? 0 : ra;

    // Append any remaining legacy flat values as explicit payslip lines (taxable)
    const snapLines = [...(allowResult.lines || [])];
    if (effectiveMra > 0) {
     snapLines.push({
      code: 'medical_risk_legacy',
      label: 'Medical Risk Premium',
      label_fr: "Indemnité de Risque Médical",
      amount: effectiveMra,
      qty_label: '1 Month',
      rate_label: effectiveMra.toLocaleString('fr-FR'),
     });
    }
    if (effectiveRa > 0) {
     snapLines.push({
      code: 'responsibility_legacy',
      label: 'Responsibility Allowance',
      label_fr: "Indemnité de Responsabilité",
      amount: effectiveRa,
      qty_label: '1 Month',
      rate_label: effectiveRa.toLocaleString('fr-FR'),
     });
    }

    // Split engine output into TAXABLE and TAX-FREE buckets.
    //   • Tax-free   = night_duty + on_call (roster-driven, Labour Code Art.80 supplements).
    //   • Taxable    = seniority, responsibility, risk, technical, etc.
    const taxFreeLines = snapLines.filter((l) => TAX_FREE_ALLOWANCE_CODES.has(l.code));
    const taxableAllowanceLines = snapLines.filter((l) => !TAX_FREE_ALLOWANCE_CODES.has(l.code));
    const taxFreeTotal = taxFreeLines.reduce((s, l) => s + (parseInt(l.amount, 10) || 0), 0);
    const taxableAllowancesTotal = taxableAllowanceLines.reduce(
     (s, l) => s + (parseInt(l.amount, 10) || 0),
     0
    );

    const allowancesTotal = taxableAllowancesTotal + taxFreeTotal;
    const allowancesSnap = JSON.stringify({ total: allowancesTotal, lines: snapLines });

    // Gross used to compute statutory deductions excludes the tax-free allowances.
    const taxableGross = b + h + t + o + taxableAllowancesTotal;
    const tax = await hmsPayrollCameroonCalculate(conn, fid, year, taxableGross);
    if (!tax) {
     throw new Error('Configure payroll tax: add a row in tbl_hms_payroll_settings for this facility (or run app once to seed).');
    }

    // Headline gross on the payslip = taxable gross + tax-free shift/on-call.
    // Net to pay = statutory net + tax-free shift/on-call (added back on top of tax).
    const displayGross = taxableGross + taxFreeTotal;
    const displayNet   = (parseFloat(tax.net_salary) || 0) + taxFreeTotal;

    if (ex) {
     const [upd] = await conn.query(
      `UPDATE tbl_hms_payroll_record SET
        gross_salary = ?, cnps_employee = ?, cimr_employee = ?, crtv_deduction = ?, council_tax_deduction = ?,
        development_tax_deduction = ?, cnhc_deduction = ?, taxable_income = ?, income_tax = ?, net_salary = ?,
        basic_salary_snap = ?, housing_allowance_snap = ?, transport_allowance_snap = ?, other_allowances_snap = ?,
        payout_status = 'pending', allowances_snap = ?, non_taxable_allowance = ?,
        unpaid_leave_days = 0, unpaid_leave_deduction = 0, attendance_deduction = 0,
        payment_date = NULL, reversed_at = NULL, reversal_reason = NULL, reversed_by = NULL
       WHERE id = ? AND facility_id = ? AND LOWER(COALESCE(payout_status, 'pending')) = 'reversed'`,
      [
       displayGross,
       tax.cnps_employee,
       tax.cimr_employee,
       tax.crtv_deduction,
       tax.council_tax_deduction,
       tax.development_tax_deduction,
       tax.cnhc_deduction,
       tax.taxable_income,
       tax.income_tax,
       displayNet,
       b,
       h,
       t,
       o,
       allowancesSnap,
       taxFreeTotal,
       ex.id,
       fid,
      ]
     );
     if (!upd.affectedRows) throw new Error('Reversed payroll record could not be corrected. Refresh and try again.');
     corrected++;
     continue;
    }

    await conn.query(
     `INSERT INTO tbl_hms_payroll_record (
      facility_id, employee_id, year, month,
      gross_salary, cnps_employee, cimr_employee, crtv_deduction, council_tax_deduction, development_tax_deduction, cnhc_deduction,
      taxable_income, income_tax, net_salary,
      basic_salary_snap, housing_allowance_snap, transport_allowance_snap, other_allowances_snap,
      payout_status, allowances_snap, non_taxable_allowance
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
     [
      fid,
      eid,
      year,
      month,
      displayGross,
      tax.cnps_employee,
      tax.cimr_employee,
      tax.crtv_deduction,
      tax.council_tax_deduction,
      tax.development_tax_deduction,
      tax.cnhc_deduction,
      tax.taxable_income,
      tax.income_tax,
      displayNet,
      b,
      h,
      t,
      o,
      'pending',
      allowancesSnap,
      taxFreeTotal
     ]
    );
     processed++;
    }
    await applyLeaveDeductions(conn, fid, year, month);
    await conn.commit();
   } catch (txErr) {
    if (conn) await conn.rollback().catch(() => {});
    throw txErr;
   } finally {
    if (conn) conn.release();
   }
   let syncNote = '';
   try {
    const syncResult = await syncPayrollPeriodToCoreAccount(pool, fid, year, month);
    if (syncResult.skipped) {
     if (syncResult.reason === 'disabled') {
      syncNote = ' Core sync disabled — set CORE_ACCOUNT_SYNC_ENABLED=1 in .env and restart.';
     } else if (syncResult.reason !== 'no records') {
      syncNote = ` Core sync skipped: ${syncResult.reason}.`;
     }
    } else if (!syncResult.ok) {
     syncNote = ' Core sync failed.';
    } else {
     syncNote = ` Replicated to Account_Core (${syncResult.count || 0} line(s), ${syncResult.departmentCount || 0} dept(s)).`;
    }
   } catch (syncErr) {
    syncNote = ` Core sync error: ${syncErr.message || syncErr}.`;
   }
   const q = 'msg=' + encodeURIComponent(`Payroll run: ${processed} new record(s), ${corrected} corrected reversed record(s). Skipped (already exists): ${skipped}.${syncNote}`);
   res.redirect('/payroll/monthly?' + q);
  } catch (e) {
   res.redirect('/payroll/monthly?err=' + encodeURIComponent(e.message));
  }
 });

 app.post('/payroll/mark-paid', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  const fid = facilityId(req);
  const rid = parseInt(req.body.payroll_record_id, 10) || 0;
  try {
   await ensureHrPayrollSchema(pool);
   const [r] = await pool.query(
    'UPDATE tbl_hms_payroll_record SET payout_status = ?, payment_date = COALESCE(payment_date, CURDATE()) WHERE id = ? AND facility_id = ? AND payout_status = ? LIMIT 1',
    ['paid', rid, fid, 'pending']
   );
   const ok = r.affectedRows > 0;
   res.redirect(
    '/payroll/monthly?' +
     (ok ? 'msg=' + encodeURIComponent('Marked as paid.') : 'err=' + encodeURIComponent('Could not update record.'))
   );
  } catch (e) {
   res.redirect('/payroll/monthly?err=' + encodeURIComponent(e.message));
  }
 });

 app.post('/payroll/mark-period-paid', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  const fid = facilityId(req);
  const month = Math.max(1, Math.min(12, parseInt(req.body.month, 10) || 1));
  const year = Math.max(2000, Math.min(2100, parseInt(req.body.year, 10) || new Date().getFullYear()));
  try {
   await ensureHrPayrollSchema(pool);
   const [r] = await pool.query(
    'UPDATE tbl_hms_payroll_record SET payout_status = ?, payment_date = COALESCE(payment_date, CURDATE()) WHERE facility_id = ? AND year = ? AND month = ? AND payout_status = ?',
    ['paid', fid, year, month, 'pending']
   );
   const count = r.affectedRows || 0;
   const [[exist]] = await pool.query(
    'SELECT COUNT(*) AS c FROM tbl_hms_payroll_record WHERE facility_id = ? AND year = ? AND month = ?',
    [fid, year, month]
   );
   if (parseInt(exist?.c, 10) > 0) {
    await syncPayrollPeriodToCoreAccount(pool, fid, year, month).catch(() => null);
   }
   res.redirect(
    '/payroll/monthly?' +
     (count > 0
      ? 'msg=' + encodeURIComponent(`Marked ${count} line(s) as paid for the period.`)
      : 'err=' + encodeURIComponent('No pending payroll lines found for this period.'))
   );
  } catch (e) {
   res.redirect('/payroll/monthly?err=' + encodeURIComponent(e.message));
  }
 });

 /** Push an already-processed payroll month to Account_Core (no recalculation). */
 app.post('/payroll/resync-period', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  const fid = facilityId(req);
  const month = Math.max(1, Math.min(12, parseInt(req.body.month, 10) || 1));
  const year = Math.max(2000, Math.min(2100, parseInt(req.body.year, 10) || new Date().getFullYear()));
  try {
   await ensureHrPayrollSchema(pool);
   const [[cnt]] = await pool.query(
    'SELECT COUNT(*) AS c FROM tbl_hms_payroll_record WHERE facility_id = ? AND year = ? AND month = ?',
    [fid, year, month]
   );
   if (!(parseInt(cnt?.c, 10) > 0)) {
    return res.redirect('/payroll/monthly?err=' + encodeURIComponent('No payroll records for this period.'));
   }
   const syncResult = await syncPayrollPeriodToCoreAccount(pool, fid, year, month);
   if (syncResult.skipped) {
    const reason = syncResult.reason || 'unknown';
    return res.redirect(
     '/payroll/monthly?err=' +
      encodeURIComponent(`Core sync skipped (${reason}). Set CORE_ACCOUNT_SYNC_ENABLED=1 in .env and restart the app.`)
    );
   }
   if (!syncResult.ok) {
    return res.redirect('/payroll/monthly?err=' + encodeURIComponent('Core sync failed. Check Account_Core is running on port 5072.'));
   }
   res.redirect(
    '/payroll/monthly?msg=' +
     encodeURIComponent(
      `Replicated to Account_Core (${syncResult.count || 0} line(s), ${syncResult.departmentCount || 0} dept(s)).`
     )
   );
  } catch (e) {
   res.redirect('/payroll/monthly?err=' + encodeURIComponent(e.message));
  }
 });

 function monthlyListReturnPath(req) {
  const retQ = String(req.body._return_q || req.query.q || '').trim();
  const retP = Math.max(1, parseInt(req.body._return_p || req.query.p, 10) || 1);
  const q = new URLSearchParams();
  if (retQ) q.set('q', retQ);
  if (retP > 1) q.set('p', String(retP));
  return '/payroll/monthly' + (q.toString() ? '?' + q.toString() : '');
 }

 /** Reverse a paid payroll record, preserving its values for audit. */
 app.post('/payroll/reverse-record', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  const fid = facilityId(req);
  const rid = parseInt(req.body.payroll_record_id, 10) || 0;
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  const back = monthlyListReturnPath(req);
  const sep = back.includes('?') ? '&' : '?';
  if (rid < 1) return res.redirect(back + sep + 'err=' + encodeURIComponent('Invalid record ID.'));
  if (!reason) return res.redirect(back + sep + 'err=' + encodeURIComponent('A reversal reason is required.'));
  let row = null;
  let conn = null;
  try {
   await ensureHrPayrollSchema(pool);
   conn = await pool.getConnection();
   await conn.beginTransaction();
   const [[r]] = await conn.query(
    `SELECT * FROM tbl_hms_payroll_record
      WHERE id = ? AND facility_id = ? LIMIT 1 FOR UPDATE`,
    [rid, fid]
   );
   row = r || null;
   if (!row) throw new Error('Paid payroll record not found.');
   if (String(row.payout_status || '').toLowerCase() !== 'paid') {
    throw new Error('Only paid payroll records can be reversed.');
   }
   await conn.query(
    `INSERT INTO tbl_hms_payroll_reversal
      (payroll_record_id, facility_id, employee_id, year, month, gross_salary, net_salary,
       payout_status, reason, reversed_by, snapshot_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
     row.id,
     row.facility_id,
     row.employee_id,
     row.year,
     row.month,
     row.gross_salary,
     row.net_salary,
     row.payout_status,
     reason,
     parseInt(req.session.user && req.session.user.id, 10) || null,
     JSON.stringify(row),
    ]
   );
   const [upd] = await conn.query(
    `UPDATE tbl_hms_payroll_record
        SET payout_status = 'reversed', reversed_at = NOW(), reversal_reason = ?, reversed_by = ?
      WHERE id = ? AND facility_id = ? AND payout_status = 'paid'`,
    [reason, parseInt(req.session.user && req.session.user.id, 10) || null, rid, fid]
   );
   if (!upd.affectedRows) throw new Error('Paid payroll record not found.');
   await conn.commit();
  } catch (e) {
   if (conn) await conn.rollback().catch(() => {});
   return res.redirect(back + sep + 'err=' + encodeURIComponent(e.message));
  } finally {
   if (conn) conn.release();
  }
  const [[named]] = await pool.query(
   `SELECT e.first_name, e.last_name FROM tbl_employee e WHERE e.id = ? LIMIT 1`,
   [row.employee_id]
  ).catch(() => [[null]]);
  const auditRow = { ...row, ...(named || {}) };
  await logAdminAction(pool, req, 'payroll.salary_reverse', {
   targetType: 'employee',
   targetId: row.employee_id,
   detail: payrollRecordReversalDetail(auditRow, reason),
  });
  const syncResult = await syncPayrollPeriodsAfterDelete(pool, fid, [
   { year: row.year, month: row.month },
  ]).catch(() => null);
  res.redirect(
   back +
    sep +
    'msg=' +
    encodeURIComponent(
     'Paid record reversed. Run Process month to regenerate the corrected line.' +
      formatCoreSyncNote(syncResult)
    )
  );
 });

 /** Delete a single payroll record so it can be re-generated. */
 app.post('/payroll/delete-record', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  const fid = facilityId(req);
  const rid = parseInt(req.body.payroll_record_id, 10) || 0;
  const back = monthlyListReturnPath(req);
  const sep = back.includes('?') ? '&' : '?';
  if (rid < 1) return res.redirect(back + sep + 'err=' + encodeURIComponent('Invalid record ID.'));
  try {
   await ensureHrPayrollSchema(pool);
   const [[row]] = await pool.query(
    `SELECT r.year, r.month, r.employee_id, r.gross_salary, r.net_salary, r.payout_status,
            e.first_name, e.last_name
     FROM tbl_hms_payroll_record r
     LEFT JOIN tbl_employee e ON e.id = r.employee_id
     WHERE r.id = ? AND r.facility_id = ? LIMIT 1`,
    [rid, fid]
   );
   const rowStatus = row ? String(row.payout_status || 'pending').toLowerCase() : '';
   if (rowStatus === 'paid' || rowStatus === 'reversed') {
    return res.redirect(
     back + sep + 'err=' + encodeURIComponent('Paid payroll records cannot be deleted. Paid or reversed records are preserved for audit.')
    );
   }
   const [r] = await pool.query(
    `DELETE FROM tbl_hms_payroll_record
      WHERE id = ? AND facility_id = ?
        AND LOWER(COALESCE(payout_status, 'pending')) NOT IN ('paid', 'reversed')
      LIMIT 1`,
    [rid, fid]
   );
   const ok = r.affectedRows > 0;
   if (ok && row) {
    await logAdminAction(pool, req, 'payroll.salary_delete', {
     targetType: 'employee',
     targetId: row.employee_id,
     detail: payrollRecordAuditDetail(row),
    });
   }
   let syncNote = '';
   if (ok && row) {
    const syncResult = await syncPayrollPeriodsAfterDelete(pool, fid, [{ year: row.year, month: row.month }]).catch(
     () => null
    );
    syncNote = formatCoreSyncNote(syncResult);
   }
   res.redirect(
    back +
     sep +
     (ok
      ? 'msg=' +
        encodeURIComponent('Payroll record deleted. You can now re-process this month.' + syncNote)
      : 'err=' + encodeURIComponent('Record not found or already deleted.'))
   );
  } catch (e) {
   res.redirect(back + sep + 'err=' + encodeURIComponent(e.message));
  }
 });

 /** Delete multiple payroll records (bulk) so they can be re-generated. */
 app.post('/payroll/delete-records', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  const fid = facilityId(req);
  const back = monthlyListReturnPath(req);
  const sep = back.includes('?') ? '&' : '?';
  let ids = req.body.payroll_record_ids;
  if (!Array.isArray(ids)) {
   ids = ids != null && ids !== '' ? [ids] : [];
  }
  ids = [...new Set(ids.map((id) => parseInt(id, 10)).filter((id) => id > 0))];
  if (!ids.length) {
   return res.redirect(back + sep + 'err=' + encodeURIComponent('Select at least one payroll line to delete.'));
  }
  try {
   await ensureHrPayrollSchema(pool);
   const placeholders = ids.map(() => '?').join(',');
   const [recordRows] = await pool.query(
    `SELECT r.id, r.year, r.month, r.employee_id, r.gross_salary, r.net_salary, r.payout_status,
            e.first_name, e.last_name
     FROM tbl_hms_payroll_record r
     LEFT JOIN tbl_employee e ON e.id = r.employee_id
     WHERE r.facility_id = ? AND r.id IN (${placeholders})`,
    [fid, ...ids]
   );
   const deletableRows = (recordRows || []).filter(
    (row) => !['paid', 'reversed'].includes(String(row.payout_status || 'pending').toLowerCase())
   );
   const lockedCount = (recordRows || []).length - deletableRows.length;
   const periodRows = [...new Map(
    deletableRows.map((row) => [`${row.year}-${row.month}`, { year: row.year, month: row.month }])
   ).values()];
   const [r] = await pool.query(
    `DELETE FROM tbl_hms_payroll_record
      WHERE facility_id = ? AND id IN (${placeholders})
        AND LOWER(COALESCE(payout_status, 'pending')) NOT IN ('paid', 'reversed')`,
    [fid, ...ids]
   );
   const n = r.affectedRows || 0;
   const lockedNote = lockedCount > 0 ? ` ${lockedCount} paid/reversed line(s) were left unchanged.` : '';
   if (n > 0) {
    for (const row of deletableRows) {
     await logAdminAction(pool, req, 'payroll.salary_delete', {
      targetType: 'employee',
      targetId: row.employee_id,
      detail: payrollRecordAuditDetail(row),
     });
    }
   }
   let syncNote = '';
   if (n > 0 && periodRows.length) {
    const syncResult = await syncPayrollPeriodsAfterDelete(pool, fid, periodRows).catch(() => null);
    syncNote = formatCoreSyncNote(syncResult);
   }
   res.redirect(
    back +
     sep +
     (n > 0
      ? 'msg=' +
        encodeURIComponent(
         (n === 1
          ? '1 payroll record deleted. You can now re-process the affected period(s).'
          : `${n} payroll records deleted. You can now re-process the affected period(s).`) + syncNote + lockedNote
        )
      : 'err=' + encodeURIComponent(lockedCount > 0
        ? 'Paid payroll records cannot be deleted. Paid or reversed records are preserved for audit.'
        : 'No records were deleted (not found or already removed).'))
   );
  } catch (e) {
   res.redirect(back + sep + 'err=' + encodeURIComponent(e.message));
  }
 });

 app.post('/payroll/mark-month-paid', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  const fid = facilityId(req);
  const mMark = Math.max(1, Math.min(12, parseInt(req.body.mark_month, 10) || 1));
  const yMark = Math.max(2000, Math.min(2100, parseInt(req.body.mark_year, 10) || new Date().getFullYear()));
  try {
   await ensureHrPayrollSchema(pool);
   const [r] = await pool.query(
    'UPDATE tbl_hms_payroll_record SET payout_status = ?, payment_date = COALESCE(payment_date, CURDATE()) WHERE facility_id = ? AND year = ? AND month = ? AND payout_status = ?',
    ['paid', fid, yMark, mMark, 'pending']
   );
   const n = r.affectedRows || 0;
   const lab = hmsFormatDate.formatMonthYear(new Date(yMark, mMark - 1, 1));
   if (n > 0) {
    await syncPayrollPeriodToCoreAccount(pool, fid, yMark, mMark).catch(() => null);
   }
   res.redirect(
    '/payroll/monthly?msg=' +
     encodeURIComponent(n > 0 ? `Marked ${n} line(s) as Paid for ${lab}.` : 'No pending lines for that period.')
   );
  } catch (e) {
   res.redirect('/payroll/monthly?err=' + encodeURIComponent(e.message));
  }
 });

 // ── Pay profiles ───────────────────────────────────────────
 app.get('/payroll/profiles', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const searchQ = String(req.query.q || '').trim();
   // Idle visiting-doctor pool slots are not staff (the employee directory hides
   // them), so their pay profiles must not linger here either. Admin accounts keep
   // their profiles: they are hidden from the directory but still paid.
   let where = `e.status = 1 AND ${hmsStaffAccountGuard.VISITING_DOCTOR_POOL_EXCLUDE_SQL}
     AND (e.default_facility_id IS NULL OR e.default_facility_id = ?)`;
   const listParams = [fid, fid];
   if (searchQ) {
    const like = '%' + searchQ + '%';
    where +=
     ' AND (e.first_name LIKE ? OR e.last_name LIKE ? OR CONCAT(e.first_name, " ", e.last_name) LIKE ? OR CAST(e.id AS CHAR) LIKE ? OR CAST(e.employee_id AS CHAR) LIKE ?)';
    listParams.push(like, like, like, like, like);
   }
   // Build the full query: JOINs first, WHERE after
   const baseJoins =
    `FROM tbl_employee e
     LEFT JOIN tbl_hms_pay_profile pp ON pp.employee_id = e.id AND pp.facility_id = ?
     LEFT JOIN (
       SELECT CAST(role AS UNSIGNED) AS role_id, MIN(title) AS role_title
       FROM tbl_role GROUP BY CAST(role AS UNSIGNED)
     ) rl ON rl.role_id = CAST(e.role AS UNSIGNED)`;
   const fullSql = `${baseJoins} WHERE ${where}`;
   const selectCols =
    `SELECT e.id, e.first_name, e.last_name, e.role, e.employee_id,
     e.joining_date AS joining_date,
     COALESCE(rl.role_title, '') AS role_title,
     COALESCE(pp.basic_salary, 0) AS basic_salary,
     COALESCE(pp.housing_allowance, 0) AS housing_allowance,
     COALESCE(pp.transport_allowance, 0) AS transport_allowance,
     COALESCE(pp.other_allowances, 0) AS other_allowances,
     COALESCE(pp.medical_risk_allowance, 0) AS medical_risk_allowance,
     COALESCE(pp.responsibility_allowance, 0) AS responsibility_allowance,
     COALESCE(pp.is_specialist, 0) AS is_specialist,
     pp.hire_date AS hire_date,
     COALESCE(pp.sector, 'medical') AS sector,
     COALESCE(pp.night_shifts_per_month, 0) AS night_shifts_per_month,
     COALESCE(pp.on_call_per_month, 0) AS on_call_per_month`;
   // Count uses simplified join (no extra columns needed)
   const countJoins =
    `FROM tbl_employee e
     LEFT JOIN tbl_hms_pay_profile pp ON pp.employee_id = e.id AND pp.facility_id = ?
     WHERE ${where}`;
   let pageResult;
   pageResult = await pagination.fetchPage(pool, {
    req,
    pageParam: 'p',
    basePath: '/payroll/profiles',
    query: searchQ ? { q: searchQ } : {},
    countSql: `SELECT COUNT(*) AS total ${countJoins}`,
    countParams: listParams,
    dataSql: `${selectCols} ${fullSql} ORDER BY e.last_name, e.first_name`,
    dataParams: listParams,
   });
   const roleLabels = await loadRoleTitleMap(pool);
   const pager = pageResult.pager;

   // Load facility-wide default sector from settings
   const [[settingsRow]] = await pool.query(
    `SELECT default_sector, employer_cnps_rate, employer_cfc_rate, employer_fne_rate
       FROM tbl_hms_payroll_settings WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1`,
    [fid]
   ).catch(() => [[null]]);
   const facilitySector = String((settingsRow && settingsRow.default_sector) || 'medical').toLowerCase();
   const employerRates = {
    cnps: parseFloat(settingsRow && settingsRow.employer_cnps_rate),
    cfc: parseFloat(settingsRow && settingsRow.employer_cfc_rate),
    fne: parseFloat(settingsRow && settingsRow.employer_fne_rate),
   };
   if (!Number.isFinite(employerRates.cnps)) employerRates.cnps = DEFAULT_EMPLOYER_RATES.cnps;
   if (!Number.isFinite(employerRates.cfc)) employerRates.cfc = DEFAULT_EMPLOYER_RATES.cfc;
   if (!Number.isFinite(employerRates.fne)) employerRates.fne = DEFAULT_EMPLOYER_RATES.fne;

   const mapProfile = (row) => {
    const mat =
     row.employee_id != null && String(row.employee_id).trim() !== ''
      ? String(row.employee_id).trim()
      : String(row.id);
    const hireIso = resolveHireDate(row.joining_date, row.hire_date);
    return {
     id: row.id,
     first_name: row.first_name,
     last_name: row.last_name,
     role: row.role,
     role_title: String(row.role_title || '').trim() || resolveRoleTitle(row.role, roleLabels),
     employee_ref: mat,
     pay: {
      basic_salary: row.basic_salary,
      housing_allowance: row.housing_allowance,
      transport_allowance: row.transport_allowance,
      other_allowances: row.other_allowances,
      medical_risk_allowance: row.medical_risk_allowance || 0,
      responsibility_allowance: row.responsibility_allowance || 0,
      is_specialist: row.is_specialist ? 1 : 0,
      hire_date: hireIso || '',
      hire_date_display: formatHireDateDisplay(row.joining_date, row.hire_date),
      sector: row.sector || 'medical',
      night_shifts_per_month: row.night_shifts_per_month || 0,
      on_call_per_month: row.on_call_per_month || 0,
     },
    };
   };

   // Totals must cover every filtered employee, not only the visible page.
   const [allRows] = await pool.query(
    `${selectCols} ${fullSql} ORDER BY e.last_name, e.first_name`,
    listParams
   );
   const allProfiles = (allRows || []).map(mapProfile);

   // Seniority, technical and specialist-research allowances are derived from the
   // role, hire date and specialist grade. They have no editable column, so show
   // them read-only; the monthly run recomputes the same values from this data.
   const ENGINE_ONLY_CODES = ['seniority', 'technical', 'specialist_research'];
   const settingsBySector = new Map();
   const sectorsToLoad = new Set(allProfiles.map((p) => String((p.pay && p.pay.sector) || facilitySector).toLowerCase()));
   sectorsToLoad.add(facilitySector);
   for (const sector of sectorsToLoad) {
    settingsBySector.set(sector, await loadAllowanceSettings(pool, fid, sector));
   }
   for (const p of allProfiles) {
    const pay = p.pay || {};
    const sector = String(pay.sector || facilitySector).toLowerCase();
    let lines = [];
    try {
     lines = computeAllowances({
      basicSalary: Number(pay.basic_salary) || 0,
      role: p.role,
      roleTitle: p.role_title || '',
      hireDate: pay.hire_date || null,
      settings: settingsBySector.get(sector) || [],
      nightShifts: Number(pay.night_shifts_per_month) || 0,
      onCallShifts: Number(pay.on_call_per_month) || 0,
      isSpecialist: Boolean(pay.is_specialist),
     }).lines || [];
    } catch (e) {
     console.warn('[payroll/profiles] engine allowance preview:', e.message);
    }
    pay.engine_allowance_lines = lines
     .filter((l) => ENGINE_ONLY_CODES.includes(l.code))
     .map((l) => ({ code: l.code, label: l.label, amount: Math.round(Number(l.amount) || 0) }));

    // Mirror the monthly run: engine values replace the legacy flat Risk /
    // Responsibility fields for the same code, and shift allowances stay tax-free.
    const engineCodes = new Set(lines.map((l) => l.code));
    const effectiveMra = engineCodes.has('medical_risk') ? 0 : Number(pay.medical_risk_allowance) || 0;
    const effectiveRa = engineCodes.has('medical_responsibility') ? 0 : Number(pay.responsibility_allowance) || 0;
    const isTaxFree = (l) => TAX_FREE_ALLOWANCE_CODES.has(l.code);
    const taxFreeTotal = lines.filter(isTaxFree).reduce((s, l) => s + (Math.round(Number(l.amount)) || 0), 0);
    const taxableEngine = lines.filter((l) => !isTaxFree(l)).reduce((s, l) => s + (Math.round(Number(l.amount)) || 0), 0);
    const taxableGross =
     (Number(pay.basic_salary) || 0) +
     (Number(pay.housing_allowance) || 0) +
     (Number(pay.transport_allowance) || 0) +
     (Number(pay.other_allowances) || 0) +
     taxableEngine +
     effectiveMra +
     effectiveRa;
    pay.monthly_gross = taxableGross + taxFreeTotal;
    pay._taxable_gross = taxableGross;
    pay._tax_free_total = taxFreeTotal;
   }

   // Expected net for the summary row. Batch the tax-engine calls so a large
   // filtered list cannot flood the connection pool.
   const taxYear = new Date().getFullYear();
   const TAX_BATCH = 10;
   for (let i = 0; i < allProfiles.length; i += TAX_BATCH) {
    await Promise.all(
     allProfiles.slice(i, i + TAX_BATCH).map(async (p) => {
      const pay = p.pay || {};
      if (!(pay._taxable_gross > 0)) {
       pay.monthly_net = 0;
       return;
      }
      try {
       const tax = await hmsPayrollCameroonCalculate(pool, fid, taxYear, pay._taxable_gross);
       pay.monthly_net = tax ? Math.round((Number(tax.net_salary) || 0) + (pay._tax_free_total || 0)) : null;
      } catch (e) {
       console.warn('[payroll/profiles] expected net:', e.message);
       pay.monthly_net = null;
      }
     })
    );
   }
   const totals = {
    count: allProfiles.length,
    gross: 0,
    employerCnps: 0,
    employerCfc: 0,
    employerFne: 0,
    cost: 0,
    net: 0,
    netComplete: true,
   };
   for (const p of allProfiles) {
    const pay = p.pay || {};
    const grossPay = Number(pay.monthly_gross) || 0;
    const employerCnps = Math.round((Math.min(grossPay, EMPLOYER_CNPS_CAP) * employerRates.cnps) / 100);
    const employerCfc = Math.round((grossPay * employerRates.cfc) / 100);
    const employerFne = Math.round((grossPay * employerRates.fne) / 100);
    totals.gross += grossPay;
    totals.employerCnps += employerCnps;
    totals.employerCfc += employerCfc;
    totals.employerFne += employerFne;
    totals.cost += grossPay + employerCnps + employerCfc + employerFne;
    if (pay.monthly_net == null) totals.netComplete = false;
    else totals.net += Number(pay.monthly_net) || 0;
    delete pay._taxable_gross;
    delete pay._tax_free_total;
   }

   // Keep the page's SQL order, but reuse the already-computed package (and its
   // engine allowances) for each visible employee.
   const profileById = new Map(allProfiles.map((p) => [p.id, p]));
   const profiles = (pageResult.rows || []).map((row) => profileById.get(row.id) || mapProfile(row));

   res.render('payroll-profiles', {
    title: 'Pay profiles - ZAIZENS',
    profiles,
    pager,
    totals,
    searchQ,
    roleLabels,
    allSectors: ALLOWANCE_SECTORS,
    facilitySector,
    flash: req.query.msg || null,
    error: req.query.err || null
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 /**
  * Auto-compute compensation breakdown for one employee.
  *
  * Input  (JSON):  { employee_id:int, mode:'gross'|'net', amount:number }
  * Output (JSON):  { basic_salary, housing_allowance, transport_allowance,
  *                   medical_risk_allowance, responsibility_allowance,
  *                   allowance_lines:[...], allowance_total, gross, net,
  *                   deductions:{cnps,cfc,crtv,council,fne,irpp,cac,total} }
  *
  * Formula:
  *   Housing    = 15% of Basic   (Conv. Coll. Santé Privée default)
  *   Transport  = 10% of Basic   (typical statutory allowance)
  *   Engine allowances (medical_responsibility, specialist_research, technical,
  *     medical_risk, seniority, night_duty, on_call) come from
  *     lib/hmsAllowanceCameroon.js based on role + hire date.
  *   Gross = Basic + Housing + Transport + EngineAllowances
  *   Net   = Gross − statutory deductions (CNPS, CFC, CRTV, council, FNE, IRPP, CAC)
  *
  * For mode='net', the shared lib/payrollCompensation engine back-calculates
  * Gross and Basic from the target take-home pay.
  *
  * The recalculated basic, housing, transport and flat allowances are persisted
  * to tbl_hms_pay_profile before returning, so applying a salary target saves it.
  */
 app.post('/payroll/profiles/auto-compute', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid    = facilityId(req);
   const eid    = parseInt(req.body.employee_id, 10) || 0;
   const mode   = String(req.body.mode || '').toLowerCase();
   const amount = Math.max(0, parseFloat(req.body.amount) || 0);
   if (eid < 1)            return res.status(400).json({ error: 'employee_id required' });
   if (!['gross','net'].includes(mode)) return res.status(400).json({ error: "mode must be 'gross' or 'net'" });
   if (amount <= 0)        return res.status(400).json({ error: 'amount must be greater than zero' });

   const [[emp]] = await pool.query(
    `SELECT e.id, e.role, e.joining_date,
            COALESCE((SELECT MIN(title) FROM tbl_role WHERE CAST(role AS UNSIGNED) = CAST(e.role AS UNSIGNED)), '') AS role_title     FROM tbl_employee e
     WHERE e.id = ? AND (e.default_facility_id IS NULL OR e.default_facility_id = ?)
     LIMIT 1`,
     [eid, fid]
    );
   if (!emp) return res.status(404).json({ error: 'Employee not found' });
   const roleTitle = String(emp.role_title || '').trim();

   const [[pp]] = await pool.query(
    `SELECT hire_date, DATE_FORMAT(hire_date, '%Y-%m-%d') AS hire_date_iso,
            sector, night_shifts_per_month, on_call_per_month, is_specialist,
            basic_salary, housing_allowance, transport_allowance,
            medical_risk_allowance, responsibility_allowance
     FROM tbl_hms_pay_profile WHERE facility_id=? AND employee_id=? LIMIT 1`,
    [fid, eid]
   ).catch(() => [[null]]);

   const previousProfile = pp ? {
    basic_salary:             Math.max(0, Math.round(Number(pp.basic_salary) || 0)),
    housing_allowance:        Math.max(0, Math.round(Number(pp.housing_allowance) || 0)),
    transport_allowance:      Math.max(0, Math.round(Number(pp.transport_allowance) || 0)),
    medical_risk_allowance:   Math.max(0, Math.round(Number(pp.medical_risk_allowance) || 0)),
    responsibility_allowance: Math.max(0, Math.round(Number(pp.responsibility_allowance) || 0)),
    is_specialist:            parseInt(pp.is_specialist || 0, 10) === 1 ? 1 : 0,
    hire_date:                pp.hire_date_iso || null,
    sector:                   String(pp.sector || 'medical').toLowerCase(),
    night_shifts_per_month:   Math.max(0, parseInt(pp.night_shifts_per_month || 0, 10)),
    on_call_per_month:        Math.max(0, parseInt(pp.on_call_per_month || 0, 10)),
   } : null;

   const [[facilitySettings]] = await pool.query(
    `SELECT default_sector FROM tbl_hms_payroll_settings WHERE facility_id=? ORDER BY tax_year DESC LIMIT 1`,
    [fid]
   ).catch(() => [[null]]);

   const hireDate    = resolveHireDate(emp.joining_date, pp && pp.hire_date);
   const sector      = String((pp && pp.sector) || (facilitySettings && facilitySettings.default_sector) || 'medical').toLowerCase();
   const nightShifts = parseInt((pp && pp.night_shifts_per_month) || 0, 10);
   const onCall      = parseInt((pp && pp.on_call_per_month) || 0, 10);
   const isSpec      = parseInt((pp && pp.is_specialist) || 0, 10) === 1;

   const settings = await loadAllowanceSettings(pool, fid, sector);
   const year = new Date().getFullYear();
   const ctx = {
    role: emp.role,
    roleTitle,
    hireDate,
    settings,
    nightShifts,
    onCallShifts: onCall,
    isSpecialist: isSpec,
   };

   // Same engine as the new-employee form, so both screens agree. In net mode it
   // bisects on the statutory deductions and accounts for tax-free night-duty /
   // on-call allowances that sit outside the taxable gross.
   const comp = mode === 'net'
    ? await computeFromNet(pool, fid, year, amount, ctx)
    : await computeFromGross(pool, fid, year, amount, ctx);

   // The row has editable Medical Risk / Responsibility columns, so send the
   // engine's amounts for them instead of leaving them at zero. The monthly run
   // already suppresses these flat fields whenever the engine computes the same
   // code, so filling them cannot double-count the allowance.
   const allowanceAmount = (code) => {
    const line = (comp.allowance_lines || []).find((l) => l.code === code);
    return Math.max(0, Math.round(Number(line && line.amount) || 0));
   };

   const basicSalary = Math.max(0, Math.round(Number(comp.basic_salary) || 0));
   const housingAllowance = Math.max(0, Math.round(Number(comp.housing_allowance) || 0));
   const transportAllowance = Math.max(0, Math.round(Number(comp.transport_allowance) || 0));
   const medicalRiskAllowance = allowanceAmount('medical_risk');
   const responsibilityAllowance = allowanceAmount('medical_responsibility');

   // Applying a salary target is an edit action: persist the recalculated
   // profile immediately so the row cannot drift from what the user applied.
   try {
    await pool.query(
     `INSERT INTO tbl_hms_pay_profile
       (facility_id, employee_id, basic_salary, housing_allowance, transport_allowance,
        medical_risk_allowance, responsibility_allowance, is_specialist,
        hire_date, sector, night_shifts_per_month, on_call_per_month)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
       basic_salary=VALUES(basic_salary), housing_allowance=VALUES(housing_allowance),
       transport_allowance=VALUES(transport_allowance),
       medical_risk_allowance=VALUES(medical_risk_allowance),
       responsibility_allowance=VALUES(responsibility_allowance),
       is_specialist=VALUES(is_specialist),
       hire_date=VALUES(hire_date), sector=VALUES(sector),
       night_shifts_per_month=VALUES(night_shifts_per_month),
       on_call_per_month=VALUES(on_call_per_month)`,
     [
      fid, eid, basicSalary, housingAllowance, transportAllowance,
      medicalRiskAllowance, responsibilityAllowance, isSpec ? 1 : 0,
      hireDate, sector, nightShifts, onCall,
     ]
    );
   } catch (eSave) {
    if (!eSave || eSave.code !== 'ER_BAD_FIELD_ERROR') throw eSave;
    await pool.query(
     `INSERT INTO tbl_hms_pay_profile
       (facility_id, employee_id, basic_salary, housing_allowance, transport_allowance)
      VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
       basic_salary=VALUES(basic_salary), housing_allowance=VALUES(housing_allowance),
       transport_allowance=VALUES(transport_allowance)`,
     [fid, eid, basicSalary, housingAllowance, transportAllowance]
    );
   }

   // A short-lived, session-bound snapshot powers the "Undo" action on the
   // success dialog. Keeping it server-side means the client cannot choose the
   // values that get restored.
   const undoToken = crypto.randomUUID();
   req.session.payProfileUndo = {
    token: undoToken,
    employeeId: eid,
    facilityId: fid,
    expiresAt: Date.now() + 10 * 60 * 1000,
    previousProfile,
    calculation: {
     mode,
     target_amount: amount,
     basic_salary: basicSalary,
     housing_allowance: housingAllowance,
     transport_allowance: transportAllowance,
     medical_risk_allowance: medicalRiskAllowance,
     responsibility_allowance: responsibilityAllowance,
     gross: Math.max(0, Math.round(Number(comp.gross) || 0)),
     net: Math.max(0, Math.round(Number(comp.net) || 0)),
    },
   };

   await logAdminAction(pool, req, 'payroll.salary_calculate', {
    targetType: 'employee',
    targetId: eid,
    detail:
     `Calculated and saved salary from ${mode.toUpperCase()} target ${auditAmount(amount)} XAF. ` +
     `Saved: ${payProfileAuditLine({ basic_salary: basicSalary, housing_allowance: housingAllowance, transport_allowance: transportAllowance, medical_risk_allowance: medicalRiskAllowance, responsibility_allowance: responsibilityAllowance })}; ` +
     `Gross ${auditAmount(comp.gross)}, Net ${auditAmount(comp.net)}. ` +
     (previousProfile ? `Previous: ${payProfileAuditLine(previousProfile)}.` : 'No previous pay profile existed.'),
   });

   return res.json({
    ok:                       true,
    saved:                    true,
    undo_token:               undoToken,
    mode,
    input:                    amount,
    basic_salary:             basicSalary,
    housing_allowance:        housingAllowance,
    transport_allowance:      transportAllowance,
    medical_risk_allowance:   medicalRiskAllowance,
    responsibility_allowance: responsibilityAllowance,
    allowance_lines:          comp.allowance_lines || [],
    allowance_total:          comp.allowance_total || 0,
    gross:                    comp.gross,
    net:                      comp.net,
    deductions:               comp.deductions,
   });
  } catch (e) {
   console.error('AUTO-COMPUTE:', e);
   return res.status(500).json({ error: e.message });
  }
 });

 /**
  * Undo the most recent automatic pay-profile save for this session.
  *
  * Input (JSON): { employee_id:int, token:string }
  * Restores the row values captured before auto-compute, or deletes the row if
  * auto-compute created it. Tokens expire after ten minutes.
  */
 app.post('/payroll/profiles/undo-auto-compute', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  const fid = facilityId(req);
  const eid = parseInt(req.body.employee_id, 10) || 0;
  const token = String(req.body.token || '');
  const undo = req.session && req.session.payProfileUndo;

  if (eid < 1 || !token) {
   return res.status(400).json({ error: 'employee_id and token required' });
  }
  if (!undo || undo.token !== token || undo.employeeId !== eid || undo.facilityId !== fid || Date.now() > undo.expiresAt) {
   return res.status(410).json({ code: 'undo_unavailable', error: 'This change can no longer be undone.' });
  }

  try {
   await ensureHrPayrollSchema(pool);
   const snapshot = undo.previousProfile;
   const [[currentRow]] = await pool.query(
    `SELECT basic_salary, housing_allowance, transport_allowance,
            medical_risk_allowance, responsibility_allowance
     FROM tbl_hms_pay_profile WHERE facility_id=? AND employee_id=? LIMIT 1`,
    [fid, eid]
   ).catch(() => [[null]]);

   if (!snapshot) {
    await pool.query(
     `DELETE FROM tbl_hms_pay_profile WHERE facility_id=? AND employee_id=?`,
     [fid, eid]
    );
   } else {
    try {
     await pool.query(
      `INSERT INTO tbl_hms_pay_profile
        (facility_id, employee_id, basic_salary, housing_allowance, transport_allowance,
         medical_risk_allowance, responsibility_allowance, is_specialist,
         hire_date, sector, night_shifts_per_month, on_call_per_month)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
        basic_salary=VALUES(basic_salary), housing_allowance=VALUES(housing_allowance),
        transport_allowance=VALUES(transport_allowance),
        medical_risk_allowance=VALUES(medical_risk_allowance),
        responsibility_allowance=VALUES(responsibility_allowance),
        is_specialist=VALUES(is_specialist),
        hire_date=VALUES(hire_date), sector=VALUES(sector),
        night_shifts_per_month=VALUES(night_shifts_per_month),
        on_call_per_month=VALUES(on_call_per_month)`,
      [
       fid, eid, snapshot.basic_salary, snapshot.housing_allowance, snapshot.transport_allowance,
       snapshot.medical_risk_allowance, snapshot.responsibility_allowance, snapshot.is_specialist,
       snapshot.hire_date, snapshot.sector, snapshot.night_shifts_per_month, snapshot.on_call_per_month,
      ]
     );
    } catch (eRestore) {
     if (!eRestore || eRestore.code !== 'ER_BAD_FIELD_ERROR') throw eRestore;
     await pool.query(
      `INSERT INTO tbl_hms_pay_profile
        (facility_id, employee_id, basic_salary, housing_allowance, transport_allowance)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
        basic_salary=VALUES(basic_salary), housing_allowance=VALUES(housing_allowance),
        transport_allowance=VALUES(transport_allowance)`,
      [fid, eid, snapshot.basic_salary, snapshot.housing_allowance, snapshot.transport_allowance]
     );
    }
   }

   const calc = undo.calculation || null;
   const calcLabel = calc
    ? `${String(calc.mode || '').toUpperCase()} target ${auditAmount(calc.target_amount)} XAF`
    : 'salary calculation';
   const undoDetail = snapshot
    ? `Undid ${calcLabel}; restored ${payProfileAuditLine(snapshot)}. ` +
      (currentRow ? `Previous saved values were: ${payProfileAuditLine(currentRow)}.` : '')
    : `Undid ${calcLabel}; removed the pay profile created by that calculation` +
      (currentRow ? ` (${payProfileAuditLine(currentRow)})` : '') + '.';

   await logAdminAction(pool, req, 'payroll.salary_undo', {
    targetType: 'employee',
    targetId: eid,
    detail: undoDetail,
   });

   delete req.session.payProfileUndo;
   return res.json({ ok: true, undone: true, deleted: !snapshot, profile: snapshot });
  } catch (e) {
   console.error('AUTO-COMPUTE UNDO:', e);
   return res.status(500).json({ error: e.message });
  }
 });

 app.post('/payroll/profiles/save', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  const fid = facilityId(req);
  try {
   await ensureHrPayrollSchema(pool);
   let saved = 0;
   const seen = new Set();
   const pageEids = [];
   for (const key of Object.keys(req.body || {})) {
    const m = /^basic_(\d+)$/.exec(key);
    if (!m) continue;
    const eid = parseInt(m[1], 10) || 0;
    if (eid < 1 || seen.has(eid)) continue;
    seen.add(eid);
    pageEids.push(eid);
   }
   const hireByEmp = new Map();
   const profileBeforeByEmp = new Map();
   const permittedEids = new Set();
   if (pageEids.length) {
    const placeholders = pageEids.map(() => '?').join(',');
    const [empRows] = await pool.query(
     `SELECT id, joining_date FROM tbl_employee
      WHERE id IN (${placeholders})
        AND (default_facility_id IS NULL OR default_facility_id = ?)`,
     [...pageEids, fid]
    );
    for (const er of empRows || []) {
     const empId = parseInt(er.id, 10);
     permittedEids.add(empId);
     hireByEmp.set(empId, resolveHireDate(er.joining_date, null));
    }
    const [profileRows] = await pool.query(
     `SELECT employee_id, basic_salary, housing_allowance, transport_allowance, other_allowances,
             medical_risk_allowance, responsibility_allowance, is_specialist,
             night_shifts_per_month, on_call_per_month
      FROM tbl_hms_pay_profile
      WHERE facility_id = ? AND employee_id IN (${placeholders})`,
     [fid, ...pageEids]
    );
    for (const pr of profileRows || []) {
     profileBeforeByEmp.set(parseInt(pr.employee_id, 10), payProfileSnapshot(pr));
    }
   }
   for (const eid of pageEids.filter((id) => permittedEids.has(id))) {
    const b   = parseFloat(req.body[`basic_${eid}`])          || 0;
    const h   = parseFloat(req.body[`housing_${eid}`])        || 0;
    const t   = parseFloat(req.body[`transport_${eid}`])      || 0;
    const o   = parseFloat(req.body[`other_${eid}`])          || 0;
    const mra = Math.max(0, parseInt(req.body[`med_risk_${eid}`]       || '0', 10));
    const ra  = Math.max(0, parseInt(req.body[`responsibility_${eid}`] || '0', 10));
    const isSpecialist = req.body[`is_specialist_${eid}`] ? 1 : 0;
    const hireDate = hireByEmp.get(eid) || null;
    const facilitySectorField = String(req.body.facility_sector || 'medical').trim().toLowerCase().slice(0, 40);
    const nightShifts = Math.max(0, parseInt(req.body[`night_shifts_${eid}`], 10) || 0);
    const onCall      = Math.max(0, parseInt(req.body[`on_call_${eid}`],      10) || 0);
    // Try full INSERT (with all columns); fall back gracefully if new columns don't exist yet
    try {
     await pool.query(
      `INSERT INTO tbl_hms_pay_profile
        (facility_id, employee_id, basic_salary, housing_allowance, transport_allowance, other_allowances,
         medical_risk_allowance, responsibility_allowance, is_specialist,
         hire_date, sector, night_shifts_per_month, on_call_per_month)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
        basic_salary=VALUES(basic_salary), housing_allowance=VALUES(housing_allowance),
        transport_allowance=VALUES(transport_allowance), other_allowances=VALUES(other_allowances),
        medical_risk_allowance=VALUES(medical_risk_allowance),
        responsibility_allowance=VALUES(responsibility_allowance),
        is_specialist=VALUES(is_specialist),
        hire_date=VALUES(hire_date), sector=VALUES(sector),
        night_shifts_per_month=VALUES(night_shifts_per_month), on_call_per_month=VALUES(on_call_per_month)`,
      [fid, eid, b, h, t, o, mra, ra, isSpecialist, hireDate, facilitySectorField, nightShifts, onCall]
     );
    } catch (eInsert) {
     if (!eInsert || eInsert.code !== 'ER_BAD_FIELD_ERROR') throw eInsert;
     await pool.query(
      `INSERT INTO tbl_hms_pay_profile
        (facility_id, employee_id, basic_salary, housing_allowance, transport_allowance, other_allowances)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
        basic_salary=VALUES(basic_salary), housing_allowance=VALUES(housing_allowance),
        transport_allowance=VALUES(transport_allowance), other_allowances=VALUES(other_allowances)`,
      [fid, eid, b, h, t, o]
     );
    }
    const [[savedRow]] = await pool.query(
     `SELECT basic_salary, housing_allowance, transport_allowance, other_allowances,
             medical_risk_allowance, responsibility_allowance, is_specialist,
             night_shifts_per_month, on_call_per_month
      FROM tbl_hms_pay_profile WHERE facility_id = ? AND employee_id = ? LIMIT 1`,
     [fid, eid]
    ).catch(() => [[null]]);
    const before = profileBeforeByEmp.get(eid) || null;
    const after = payProfileSnapshot(savedRow || {
     basic_salary: b, housing_allowance: h, transport_allowance: t, other_allowances: o,
     medical_risk_allowance: mra, responsibility_allowance: ra, is_specialist: isSpecialist,
     night_shifts_per_month: nightShifts, on_call_per_month: onCall,
    });
    const hasProfileValues = Object.values(after).some((value) => Number(value) > 0);
    if (payProfileSnapshotChanged(before, after) && (before || hasProfileValues)) {
     await logAdminAction(pool, req, 'payroll.profile_save', {
      targetType: 'employee',
      targetId: eid,
      detail: before
       ? `Manual pay-profile save. Now: ${manualPayProfileAuditLine(after)}. Previous: ${manualPayProfileAuditLine(before)}.`
       : `Manual pay-profile save created the pay profile. ${manualPayProfileAuditLine(after)}.`,
     });
    }
    saved++;
   }
   const q = new URLSearchParams();
   q.set('msg', `Saved ${saved} profile row(s) on this page.`);
   const retQ = String(req.body._return_q || '').trim();
   const retP = parseInt(req.body._return_p, 10) || 0;
   if (retQ) q.set('q', retQ);
   if (retP > 1) q.set('p', String(retP));
   res.redirect('/payroll/profiles?' + q.toString());
  } catch (e) {
   const q = new URLSearchParams({ err: e.message });
   const retQ = String(req.body._return_q || '').trim();
   const retP = parseInt(req.body._return_p, 10) || 0;
   if (retQ) q.set('q', retQ);
   if (retP > 1) q.set('p', String(retP));
   res.redirect('/payroll/profiles?' + q.toString());
  }
 });

 // ═══════════════════════════════════════════════════════════════════════════
 // Payroll-specific audit trail
 // ═══════════════════════════════════════════════════════════════════════════
 app.get('/payroll/audit', requireAuth, requirePayrollAccess, async (req, res) => {
  try {
   const fid = facilityId(req);
   const rawEmployee = parseInt(req.query.employee, 10) || 0;
   const employeeId = rawEmployee > 0 ? rawEmployee : 0;
   const rawAction = String(req.query.action || '').trim().slice(0, 60);
   const action = rawAction.startsWith('payroll.') ? rawAction : '';
   const rawFrom = String(req.query.from || '').trim();
   const rawTo = String(req.query.to || '').trim();
   const from = rawFrom ? parseIsoDateParam(rawFrom) : null;
   const to = rawTo ? parseIsoDateParam(rawTo) : null;
   let filterError = '';
   if (rawFrom && !from) filterError = 'From date must be a valid date (YYYY-MM-DD).';
   else if (rawTo && !to) filterError = 'To date must be a valid date (YYYY-MM-DD).';
   else if (from && to && from > to) filterError = 'From date must be on or before the To date.';

   const where = [
    "a.action LIKE 'payroll.%'",
    '(a.facility_id = ? OR (a.facility_id IS NULL AND (e.default_facility_id IS NULL OR e.default_facility_id = ?)))',
   ];
   const params = [fid, fid];
   if (employeeId) {
    where.push("a.target_type = 'employee' AND a.target_id = ?");
    params.push(String(employeeId));
   }
   if (action) {
    where.push('a.action = ?');
    params.push(action);
   }
   if (from) {
    where.push('DATE(a.created_at) >= ?');
    params.push(from);
   }
   if (to) {
    where.push('DATE(a.created_at) <= ?');
    params.push(to);
   }
   const whereSql = where.join(' AND ');

   const [employeeOptions] = await pool.query(
    `SELECT DISTINCT e.id, e.first_name, e.last_name, e.employee_id
     FROM tbl_admin_audit a
     JOIN tbl_employee e ON a.target_type = 'employee' AND CAST(e.id AS CHAR) = a.target_id
     WHERE a.action LIKE 'payroll.%'
       AND (a.facility_id = ? OR (a.facility_id IS NULL AND (e.default_facility_id IS NULL OR e.default_facility_id = ?)))
     ORDER BY e.first_name, e.last_name
     LIMIT 500`,
    [fid, fid]
   ).catch(() => [[]]);
   const [actionOptions] = await pool.query(
    `SELECT a.action, COUNT(*) AS entry_count
     FROM tbl_admin_audit a
     LEFT JOIN tbl_employee e ON a.target_type = 'employee' AND CAST(e.id AS CHAR) = a.target_id
     WHERE a.action LIKE 'payroll.%'
       AND (a.facility_id = ? OR (a.facility_id IS NULL AND (e.default_facility_id IS NULL OR e.default_facility_id = ?)))
     GROUP BY a.action
     ORDER BY a.action`,
    [fid, fid]
   ).catch(() => [[]]);
   const [[countRow]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM tbl_admin_audit a
     LEFT JOIN tbl_employee e ON a.target_type = 'employee' AND CAST(e.id AS CHAR) = a.target_id
     WHERE ${whereSql}`,
    params
   ).catch(() => [[{ total: 0 }]]);
   const [rows] = await pool.query(
    `SELECT a.id, a.created_at, a.actor_name, a.action, a.target_type, a.target_id,
            a.detail, a.ip, a.facility_id,
            e.first_name, e.last_name, e.employee_id AS matricule
     FROM tbl_admin_audit a
     LEFT JOIN tbl_employee e ON a.target_type = 'employee' AND CAST(e.id AS CHAR) = a.target_id
     WHERE ${whereSql}
     ORDER BY a.id DESC
     LIMIT 500`,
    params
   );

   return res.render('payroll-audit', {
    title: 'Payroll audit — Zaizens Payroll',
    payNavActive: 'payroll-audit',
    auditRows: rows || [],
    total: Number(countRow && countRow.total) || 0,
    employeeOptions: employeeOptions || [],
    actionOptions: actionOptions || [],
    filters: { employee: employeeId, action, from, to },
    filterError,
   });
  } catch (e) {
   console.error('[payroll/audit]', e.message);
   return res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 // ═══════════════════════════════════════════════════════════════════════════
 // Phase A — Payroll tax / employer settings (PHP parity: tax/settings.php)
 // ═══════════════════════════════════════════════════════════════════════════

 app.get('/payroll/settings', requireAuth, requirePayrollAccess, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const activeSectorEarly = String(req.query.sector || 'medical').toLowerCase();
   if (req.query.repair_allowances === '1' || req.query.repair_allowances === 'true') {
    const permsEarly = res.locals.userPerms || [];
    const canMutateEarly =
     isPayrollAdmin(req) || permsEarly.includes('*') || permsEarly.includes('payroll.write');
    if (!canMutateEarly) {
     return res.redirect(
      '/payroll/settings?tab=allowances&sector=' + activeSectorEarly + '&err=' +
      encodeURIComponent('Access denied. Payroll write permission required to restore defaults.')
     );
    }
    if (activeSectorEarly === 'medical') {
     await repairMedicalAllowanceSettings(pool, fid);
    } else {
     const mergedEarly = await loadAllowanceSettings(pool, fid, activeSectorEarly);
     await saveAllowanceSettings(pool, fid, activeSectorEarly, mergedEarly.map(rowToSavePayload));
    }
    return res.redirect(
     '/payroll/settings?sector=' + activeSectorEarly + '&tab=allowances&msg=' +
     encodeURIComponent('Allowance settings restored to legal defaults.')
    );
   }
   const cy = new Date().getFullYear();
   const [[row]] = await pool
    .query(
     'SELECT * FROM tbl_hms_payroll_settings WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1',
     [fid]
    )
    .catch(() => [[null]]);
   const current = {
    tax_year: cy,
    employer_cnps_number: '',
    employer_niu: '',
    cnps_regime: 1,
    employer_address: '',
    employer_phone: '',
    employer_email: '',
    cnps_employee_rate: 4.2,   // CNPS Vieillesse employee 2025
    cimr_employee_rate: 1.0,   // CFC (Crédit Foncier) employee 2025
    crtv_rate: 0,              // CRTV: computed from fixed scale (not a %)
    council_tax_rate: 0,       // Council tax: computed from fixed scale
    development_tax_rate: 1.0, // FNE (Fonds National de l'Emploi) 2025
    cnhc_rate: 0,              // CAC: 10 % of IRPP, computed automatically
    employer_cnps_rate: DEFAULT_EMPLOYER_RATES.cnps, // employer: pension 4.2 + family 7
    employer_cfc_rate: DEFAULT_EMPLOYER_RATES.cfc,
    employer_fne_rate: DEFAULT_EMPLOYER_RATES.fne,
    tax_brackets: '',
    default_sector: 'medical'
   };
   if (row && typeof row === 'object') Object.assign(current, row);
   // Use the same four-band normalization as the payroll calculator, so a
   // legacy row cannot show one scale while payroll applies another.
   const b = parseBrackets(String(current.tax_brackets || ''));
   const perms = res.locals.userPerms || [];
   const canEdit =
    isPayrollAdmin(req) || perms.includes('*') || perms.includes('payroll.write');
   // Use default_sector from DB as the active sector unless overridden by ?sector= param
   const facilitySector = String(current.default_sector || 'medical').toLowerCase();
   const activeSector = String(req.query.sector || facilitySector).toLowerCase();
   const allowanceSettings = await loadAllowanceSettings(pool, fid, activeSector);
   const allowanceDefaultsByCode = Object.fromEntries(
    defaultAllowancesForSector(activeSector).map((d) => [d.code, d])
   );
   res.render('payroll-settings', {
    title: 'Payroll tax settings - ZAIZENS',
    current,
    brackets: b,
    bracketDefaults: DEFAULT_IRPP_BRACKETS,
    canEdit,
    flash: req.query.msg || null,
    error: req.query.err || null,
    allowanceSettings,
    allowanceDefaultsByCode,
    activeSector,
    facilitySector,
    allSectors: ALLOWANCE_SECTORS,
    taxPresets: payrollTaxPresets(),
    activePreset: payrollTaxPresetFor(current.cnps_regime, activeSector),
    query: req.query,
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 // ── Repair allowance defaults (rates + legal basis) — GET or POST ───────
 async function runAllowanceSettingsRepair(req, res) {
  const fid = facilityId(req);
  const sector = String(req.body.sector || req.query.sector || 'medical').toLowerCase();
  try {
   await ensureHrPayrollSchema(pool);
   if (sector === 'medical') {
    await repairMedicalAllowanceSettings(pool, fid);
   } else {
    const merged = await loadAllowanceSettings(pool, fid, sector);
    await saveAllowanceSettings(pool, fid, sector, merged.map(rowToSavePayload));
   }
   res.redirect('/payroll/settings?sector=' + sector + '&tab=allowances&msg=' + encodeURIComponent('Allowance settings restored to legal defaults.'));
  } catch (e) {
   res.redirect('/payroll/settings?sector=' + sector + '&tab=allowances&err=' + encodeURIComponent(e.message));
  }
 }
 app.get('/payroll/settings/allowances/repair', requireAuth, requirePayrollAccess, requirePayrollMutate, runAllowanceSettingsRepair);
 app.post('/payroll/settings/allowances/repair', requireAuth, requirePayrollAccess, requirePayrollMutate, runAllowanceSettingsRepair);

 // ── Allowance settings save ─────────────────────────────────────────────
 app.post('/payroll/settings/allowances/save', requireAuth, requirePayrollAccess, requirePayrollMutate, async (req, res) => {
  const fid = facilityId(req);
  const sector = String(req.body.sector || 'medical').toLowerCase();
  try {
   await ensureHrPayrollSchema(pool);
   // Reconstruct items array from flat POST body (allowance_code[], allowance_enabled[], etc.)
   const codes = [].concat(req.body['allowance_code[]'] || req.body.allowance_code || []);
   if (!codes.length) {
    return res.redirect('/payroll/settings?sector=' + sector + '&tab=allowances&msg=' + encodeURIComponent('No data received.'));
   }
   const makeArr = (k) => [].concat(req.body[k] || req.body[k.replace('[]', '')] || []);
   const labels         = makeArr('allowance_label[]');
   const labelsFr       = makeArr('allowance_label_fr[]');
   const calcTypes      = makeArr('allowance_calc_type[]');
   const enabledSet     = new Set([].concat(req.body['allowance_enabled[]'] || req.body.allowance_enabled || []));
   // All three value arrays are always the same length as codes[] (every row emits all three)
   const pctValues      = makeArr('allowance_pct_value[]');
   const fixedAmounts   = makeArr('allowance_fixed_amount[]');
   const perUnitAmts    = makeArr('allowance_per_unit_amount[]');
   const capPcts        = makeArr('allowance_cap_pct[]');
   const sortOrders     = makeArr('allowance_sort_order[]');
   const legalBases     = makeArr('allowance_legal_basis[]');
   const descriptions   = makeArr('allowance_description[]');
   const appliesRoles   = makeArr('allowance_applies_roles[]');

   let items = codes.map((code, i) => ({
    code,
    label:           labels[i]       || '',
    label_fr:        labelsFr[i]     || '',
    calc_type:       calcTypes[i]    || 'none',
    enabled:         enabledSet.has(code) ? 1 : 0,
    pct_value:       pctValues[i]    !== '' ? pctValues[i]    : null,
    fixed_amount:    fixedAmounts[i] !== '' ? fixedAmounts[i] : null,
    per_unit_amount: perUnitAmts[i]  !== '' ? perUnitAmts[i]  : null,
    cap_pct:         capPcts[i]      !== '' ? capPcts[i]      : null,
    sort_order:      sortOrders[i]   || (i + 1),
    applies_to_roles: appliesRoles[i] || null,
    legal_basis:     legalBases[i]   || '',
    description:     descriptions[i] || '',
   }));

   items = applyDefaultsToAllowancePostItems(items, sector);
   await saveAllowanceSettings(pool, fid, sector, items);
   res.redirect('/payroll/settings?sector=' + sector + '&tab=allowances&msg=' + encodeURIComponent('Allowance settings saved.'));
  } catch (e) {
   res.redirect('/payroll/settings?sector=' + sector + '&tab=allowances&err=' + encodeURIComponent(e.message));
  }
 });

 app.post('/payroll/settings/save', requireAuth, requirePayrollAccess, requirePayrollMutate, async (req, res) => {
  const fid = facilityId(req);
  const taxYear = Math.max(2000, Math.min(2100, parseInt(req.body.tax_year, 10) || new Date().getFullYear()));
  const employer_cnps = String(req.body.employer_cnps_number || '').trim().slice(0, 32);
  const employer_niu = String(req.body.employer_niu || '').trim().slice(0, 32);
  const cnps_regime = Math.max(1, Math.min(4, parseInt(req.body.cnps_regime, 10) || 1));
  const employer_address = String(req.body.employer_address || '').trim().slice(0, 500);
  const employer_phone = String(req.body.employer_phone || '').trim().slice(0, 64);
  const employer_email = String(req.body.employer_email || '').trim().slice(0, 128);
  const cnps_emp = parseFloat(req.body.cnps_employee_rate) || 4.2;
  const cimr_emp = parseFloat(req.body.cimr_employee_rate) || 1.0;   // CFC
  const crtv     = parseFloat(req.body.crtv_rate)           || 0;    // fixed scale
  const council  = parseFloat(req.body.council_tax_rate)    || 0;    // fixed scale
  const dev      = parseFloat(req.body.development_tax_rate) || 1.0; // FNE
  const cnhc     = parseFloat(req.body.cnhc_rate)           || 0;    // CAC auto
  const rateOr = (value, fallback) => {
   const n = parseFloat(value);
   return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
  };
  const employer_cnps_rate = rateOr(req.body.employer_cnps_rate, DEFAULT_EMPLOYER_RATES.cnps);
  const employer_cfc_rate = rateOr(req.body.employer_cfc_rate, DEFAULT_EMPLOYER_RATES.cfc);
  const employer_fne_rate = rateOr(req.body.employer_fne_rate, DEFAULT_EMPLOYER_RATES.fne);
  const requestedSector = String(req.body.default_sector || 'medical').trim().toLowerCase().slice(0, 40);
  const defaultSector = ALLOWANCE_SECTORS[requestedSector] ? requestedSector : 'medical';
  const bracketMaxes = [];
  for (let i = 0; i < DEFAULT_IRPP_BRACKETS.length - 1; i += 1) {
   const fallback = DEFAULT_IRPP_BRACKETS[i].max;
   const raw = req.body[`tax_max_${i + 1}`];
   const parsed = raw == null || String(raw).trim() === '' ? fallback : Math.round(Number(raw));
   if (!Number.isFinite(parsed) || parsed < 0) {
    return res.redirect(
     '/payroll/settings?tab=irpp&err=' +
      encodeURIComponent(`IRPP band ${i + 1} upper limit must be a whole number of XAF.`)
    );
   }
   if (bracketMaxes.length && parsed <= bracketMaxes[bracketMaxes.length - 1]) {
    return res.redirect(
     '/payroll/settings?tab=irpp&err=' +
      encodeURIComponent(`IRPP band ${i + 1} must end above band ${i}.`)
    );
   }
   bracketMaxes.push(parsed);
  }
  const brackets = JSON.stringify(
   DEFAULT_IRPP_BRACKETS.map((bracket, index) => ({
    min: index === 0 ? 0 : bracketMaxes[index - 1] + 1,
    max: index === DEFAULT_IRPP_BRACKETS.length - 1 ? null : bracketMaxes[index],
    rate: rateOr(req.body[`tax_rate_${index + 1}`], bracket.rate),
   }))
  );
  try {
   await ensureHrPayrollSchema(pool);
   await pool.query(
    `INSERT INTO tbl_hms_payroll_settings (
      facility_id, tax_year, employer_cnps_number, employer_niu, cnps_regime,
      employer_address, employer_phone, employer_email,
      cnps_employee_rate, cimr_employee_rate, crtv_rate, council_tax_rate, development_tax_rate, cnhc_rate,
      employer_cnps_rate, employer_cfc_rate, employer_fne_rate,
      tax_brackets, default_sector
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      employer_cnps_number = VALUES(employer_cnps_number),
      employer_niu = VALUES(employer_niu),
      cnps_regime = VALUES(cnps_regime),
      employer_address = VALUES(employer_address),
      employer_phone = VALUES(employer_phone),
      employer_email = VALUES(employer_email),
      cnps_employee_rate = VALUES(cnps_employee_rate),
      cimr_employee_rate = VALUES(cimr_employee_rate),
      crtv_rate = VALUES(crtv_rate),
      council_tax_rate = VALUES(council_tax_rate),
      development_tax_rate = VALUES(development_tax_rate),
      cnhc_rate = VALUES(cnhc_rate),
      employer_cnps_rate = VALUES(employer_cnps_rate),
      employer_cfc_rate = VALUES(employer_cfc_rate),
      employer_fne_rate = VALUES(employer_fne_rate),
      tax_brackets = VALUES(tax_brackets),
      default_sector = VALUES(default_sector)`,
    [
     fid,
     taxYear,
     employer_cnps,
     employer_niu,
     cnps_regime,
     employer_address,
     employer_phone,
     employer_email,
     cnps_emp,
     cimr_emp,
     crtv,
     council,
     dev,
     cnhc,
     employer_cnps_rate,
     employer_cfc_rate,
     employer_fne_rate,
     brackets,
     defaultSector
    ]
   );
   res.redirect('/payroll/settings?msg=' + encodeURIComponent('Settings saved.'));
  } catch (e) {
   res.redirect('/payroll/settings?err=' + encodeURIComponent(e.message));
  }
 });

 // ═══════════════════════════════════════════════════════════════════════════
 // Phase B — Leave, holidays, self-service (PHP parity: leave-requests, …)
 // ═══════════════════════════════════════════════════════════════════════════

 function inclusiveLeaveDays(startStr, endStr) {
  const a = new Date(String(startStr).trim() + 'T12:00:00Z');
  const b = new Date(String(endStr).trim() + 'T12:00:00Z');
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
 }

 function formatLeaveDisplayDate(val) {
  return hmsFormatDate.formatDisplayDate(val);
 }

 function employeeDisplayName(row) {
  if (!row) return '';
  const fn = String(row.first_name || row.approver_first || '').trim();
  const ln = String(row.last_name || row.approver_last || '').trim();
  return `${fn} ${ln}`.trim();
 }

 async function loadLeaveApproverNames(facilityIdArg) {
  const fid = Math.max(1, parseInt(facilityIdArg, 10) || 1);
  const [rows] = await pool
   .query(
    `SELECT DISTINCT e.first_name, e.last_name
     FROM tbl_employee e
     WHERE e.status = 1
       AND (e.default_facility_id IS NULL OR e.default_facility_id = ?)
       AND (
        e.role IN ('1', '99')
        OR e.role IN (
         SELECT rp.role FROM tbl_acl_role_permission rp
         INNER JOIN tbl_acl_permission p ON p.id = rp.permission_id
         WHERE p.code = 'hr.leave.approve'
        )
       )
     ORDER BY e.last_name, e.first_name
     LIMIT 12`,
    [fid]
   )
   .catch(() => [[]]);
  const names = (rows || [])
   .map((r) => employeeDisplayName(r))
   .filter(Boolean);
  return names.length ? names.join(', ') : 'HR (Leave approvals)';
 }

 // hrAdmin (leave / holidays): requireAuth + requireHrLeaveAdmin

 /** Admin: pending + recent leave requests */
 app.get('/hr/leave-requests', requireAuth, requireHrLeaveAdmin, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const [rows] = await pool
    .query(
     `SELECT r.*, e.first_name, e.last_name
      FROM tbl_hms_leave_request r
      JOIN tbl_employee e ON e.id = r.employee_id
      WHERE r.facility_id = ?
      ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, r.created_at DESC
      LIMIT 200`,
     [fid]
    )
    .catch(() => [[]]);
   const formattedRows = (rows || []).map((r) =>
    Object.assign({}, r, {
     start_date_fmt: formatLeaveDisplayDate(r.start_date, true),
     end_date_fmt: formatLeaveDisplayDate(r.end_date, false)
    })
   );
   const counts = { pending: 0, approved: 0, rejected: 0, other: 0 };
   for (const r of formattedRows) {
    const st = String(r.status || '').toLowerCase();
    if (counts[st] != null) counts[st] += 1;
    else counts.other += 1;
   }
   res.render('hr-leave-requests', {
    title: 'Leave approvals - ZAIZENS',
    rows: formattedRows,
    counts,
    flash: req.query.msg || null,
    error: req.query.err || null
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 app.post('/hr/leave-requests/action', requireAuth, requireHrLeaveAdmin, async (req, res) => {
  const fid = facilityId(req);
  const rid = parseInt(req.body.request_id, 10) || 0;
  const act = String(req.body.action || '').toLowerCase();
  const uid = sessionEmpId(req);
  try {
   await ensureHrPayrollSchema(pool);
   if (rid < 1 || !['approve', 'reject'].includes(act)) {
    return res.redirect('/hr/leave-requests?err=' + encodeURIComponent('Invalid request.'));
   }
   const st = act === 'approve' ? 'approved' : 'rejected';
   const [r] = await pool.query(
    'UPDATE tbl_hms_leave_request SET status = ?, approved_by = ? WHERE id = ? AND facility_id = ? AND status = ?',
    [st, uid, rid, fid, 'pending']
   );
   if (!r.affectedRows) {
    return res.redirect('/hr/leave-requests?err=' + encodeURIComponent('Request not found or already processed.'));
   }
   res.redirect('/hr/leave-requests?msg=' + encodeURIComponent(`Leave request ${st}.`));
  } catch (e) {
   res.redirect('/hr/leave-requests?err=' + encodeURIComponent(e.message));
  }
 });

 /** Admin: leave balances by employee (annual default) */
 app.get('/hr/leave-balances', requireAuth, requireHrLeaveAdmin, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const year = Math.max(2000, Math.min(2100, parseInt(req.query.year, 10) || new Date().getFullYear()));
   const staff = await activeStaff(fid);
    const usedByEmp = new Map();
    const pendingByEmp = new Map();
    try {
      const [agg] = await pool.query(
        `SELECT employee_id, status, SUM(days_requested) AS days
         FROM tbl_hms_leave_request
         WHERE facility_id = ? AND YEAR(start_date) = ? AND status IN ('approved','pending')
         GROUP BY employee_id, status`,
        [fid, year]
      );
      for (const row of agg || []) {
        const eid = parseInt(row.employee_id, 10) || 0;
        const days = Number(row.days) || 0;
        if (!eid) continue;
        if (String(row.status) === 'approved') usedByEmp.set(eid, days);
        else pendingByEmp.set(eid, days);
      }
    } catch (_) { /* requests table may be empty */ }
   const balances = [];
   for (const em of staff) {
    const eid = em.id;
    const [[b]] = await pool
     .query(
      'SELECT balance FROM tbl_hms_leave_balance WHERE facility_id = ? AND employee_id = ? AND leave_type = ? AND year = ? LIMIT 1',
      [fid, eid, 'annual', year]
     )
     .catch(() => [[{ balance: 0 }]]);
      const entitled = parseFloat(b?.balance) || 0;
      const used = usedByEmp.get(Number(eid)) || 0;
      const pending = pendingByEmp.get(Number(eid)) || 0;
      balances.push({
        ...em,
        balance: entitled,
        used,
        pending,
        remaining: Math.round((entitled - used - pending) * 10) / 10,
      });
   }
   res.render('hr-leave-balances', {
    title: 'Leave balances - ZAIZENS',
    year,
    rows: balances,
      totals: {
        entitled: balances.reduce((s, r) => s + r.balance, 0),
        used: balances.reduce((s, r) => s + r.used, 0),
        pending: balances.reduce((s, r) => s + r.pending, 0),
        remaining: balances.reduce((s, r) => s + r.remaining, 0),
      },
    flash: req.query.msg || null,
    error: req.query.err || null
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 app.post('/hr/leave-balances/apply-default', requireAuth, requireHrLeaveAdmin, async (req, res) => {
  const fid = facilityId(req);
  const year = Math.max(2000, Math.min(2100, parseInt(req.body.year, 10) || new Date().getFullYear()));
  const raw = String(req.body.default_days == null ? '' : req.body.default_days).trim();
  const days = Number(raw.replace(',', '.'));
  const back = '/hr/leave-balances?year=' + year;
  if (!raw || !Number.isFinite(days) || days < 0 || days > 365) {
   return res.redirect(back + '&err=' + encodeURIComponent('Enter a default entitlement between 0 and 365 days.'));
  }
  try {
   await ensureHrPayrollSchema(pool);
   const staff = await activeStaff(fid);
   for (const em of staff) {
    await pool.query(
     `INSERT INTO tbl_hms_leave_balance (facility_id, employee_id, leave_type, year, balance)
      VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE balance = VALUES(balance)`,
     [fid, em.id, 'annual', year, days]
    );
   }
   res.redirect(
    back + '&msg=' + encodeURIComponent(`Default entitlement of ${days} day(s) applied to ${staff.length} employee(s).`)
   );
  } catch (e) {
   res.redirect(back + '&err=' + encodeURIComponent(e.message));
  }
 });

 app.post('/hr/leave-balances/save', requireAuth, requireHrLeaveAdmin, async (req, res) => {
  const fid = facilityId(req);
  const year = Math.max(2000, Math.min(2100, parseInt(req.body.year, 10) || new Date().getFullYear()));
  try {
   await ensureHrPayrollSchema(pool);
   const staff = await activeStaff(fid);
   for (const em of staff) {
    const eid = em.id;
    const bal = parseFloat(req.body[`bal_${eid}`]) || 0;
    await pool.query(
     `INSERT INTO tbl_hms_leave_balance (facility_id, employee_id, leave_type, year, balance)
      VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE balance = VALUES(balance)`,
     [fid, eid, 'annual', year, bal]
    );
   }
   res.redirect('/hr/leave-balances?year=' + year + '&msg=' + encodeURIComponent('Balances saved.'));
  } catch (e) {
   res.redirect('/hr/leave-balances?year=' + year + '&err=' + encodeURIComponent(e.message));
  }
 });

 /** Admin: holidays */
 app.get('/hr/holidays', requireAuth, requireHrLeaveAdmin, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const [rows] = await pool
    .query(
     'SELECT * FROM tbl_hms_holiday WHERE facility_id = ? ORDER BY holiday_date DESC LIMIT 200',
     [fid]
    )
    .catch(() => [[]]);
   const today = new Date().toISOString().slice(0, 10);
   const upcoming = (rows || [])
    .filter((h) => String(h.holiday_date).slice(0, 10) >= today)
    .sort((a, b) => String(a.holiday_date).localeCompare(String(b.holiday_date)));
   const past = (rows || []).filter((h) => String(h.holiday_date).slice(0, 10) < today);
   res.render('hr-holidays', {
    title: 'Holidays - ZAIZENS',
    rows: rows || [],
    upcoming,
    past,
    today,
    flash: req.query.msg || null,
    error: req.query.err || null
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 app.post('/hr/holidays/add', requireAuth, requireHrLeaveAdmin, async (req, res) => {
  const fid = facilityId(req);
  const name = String(req.body.holiday_name || '').trim().slice(0, 120);
  const d = String(req.body.holiday_date || '').trim();
  const rec = req.body.is_recurring === '1' || req.body.is_recurring === 'on' ? 1 : 0;
  try {
   await ensureHrPayrollSchema(pool);
   if (!name || !d) {
    return res.redirect('/hr/holidays?err=' + encodeURIComponent('Name and date are required.'));
   }
   await pool.query(
    'INSERT INTO tbl_hms_holiday (facility_id, holiday_name, holiday_date, is_recurring) VALUES (?,?,?,?)',
    [fid, name, d, rec]
   );
   res.redirect('/hr/holidays?msg=' + encodeURIComponent('Holiday added.'));
  } catch (e) {
   res.redirect('/hr/holidays?err=' + encodeURIComponent(e.message));
  }
 });

 app.post('/hr/holidays/delete', requireAuth, requireHrLeaveAdmin, async (req, res) => {
  const fid = facilityId(req);
  const id = parseInt(req.body.id, 10) || 0;
  try {
   await ensureHrPayrollSchema(pool);
   await pool.query('DELETE FROM tbl_hms_holiday WHERE id = ? AND facility_id = ? LIMIT 1', [id, fid]);
   res.redirect('/hr/holidays?msg=' + encodeURIComponent('Holiday removed.'));
  } catch (e) {
   res.redirect('/hr/holidays?err=' + encodeURIComponent(e.message));
  }
 });

 /** Any authenticated staff: request leave */
 app.get('/hr/request-leave', requireAuth, requireHrSelfService, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const uid = sessionEmpId(req);
   if (uid < 1) {
    return res.redirect('/payroll?err=' + encodeURIComponent('Session employee id missing.'));
   }
   const [mineRaw] = await pool
    .query(
     `SELECT r.*, ab.first_name AS approver_first, ab.last_name AS approver_last
      FROM tbl_hms_leave_request r
      LEFT JOIN tbl_employee ab ON ab.id = r.approved_by
      WHERE r.facility_id = ? AND r.employee_id = ?
      ORDER BY r.created_at DESC LIMIT 30`,
     [fid, uid]
    )
    .catch(() => [[]]);
   const defaultSubmittedTo = await loadLeaveApproverNames(fid);
   const year = new Date().getFullYear();
   const [balanceRows] = await pool
    .query(
     `SELECT leave_type, balance FROM tbl_hms_leave_balance
      WHERE facility_id = ? AND employee_id = ? AND year = ?
      ORDER BY FIELD(leave_type, 'annual', 'sick', 'unpaid', 'other'), leave_type`,
     [fid, uid, year]
    )
    .catch(() => [[]]);
   const mine = (mineRaw || []).map((r) => {
    const st = String(r.status || '').toLowerCase();
    const approverName = employeeDisplayName(r);
    let submittedTo = defaultSubmittedTo;
    if (st === 'approved' || st === 'rejected') {
     submittedTo = approverName || defaultSubmittedTo;
    }
    return Object.assign({}, r, {
     start_date_fmt: formatLeaveDisplayDate(r.start_date, true),
     end_date_fmt: formatLeaveDisplayDate(r.end_date, false),
     submitted_to: submittedTo
    });
   });
   res.render('hr-request-leave', {
    title: 'Request leave - ZAIZENS',
    paySelfServiceOnly: 'leave',
    mine,
    balances: balanceRows || [],
    year,
    today: new Date().toISOString().slice(0, 10),
    flash: req.query.msg || null,
    error: req.query.err || null
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 app.post('/hr/request-leave', requireAuth, requireHrSelfService, async (req, res) => {
  const fid = facilityId(req);
  const uid = sessionEmpId(req);
  const leaveType = String(req.body.leave_type || 'annual').trim().slice(0, 24) || 'annual';
  const sd = String(req.body.start_date || '').trim();
  const ed = String(req.body.end_date || '').trim();
  const reason = String(req.body.reason || '').trim().slice(0, 2000);
  try {
   await ensureHrPayrollSchema(pool);
   if (uid < 1) {
    return res.redirect('/hr/request-leave?err=' + encodeURIComponent('Session employee id missing.'));
   }
   const days = inclusiveLeaveDays(sd, ed);
   if (days < 1) {
    return res.redirect('/hr/request-leave?err=' + encodeURIComponent('Invalid date range.'));
   }
   await pool.query(
    `INSERT INTO tbl_hms_leave_request (facility_id, employee_id, leave_type, start_date, end_date, days_requested, status, reason)
     VALUES (?,?,?,?,?,?, 'pending', ?)`,
    [fid, uid, leaveType, sd, ed, days, reason || null]
   );
   res.redirect('/hr/request-leave?msg=' + encodeURIComponent('Leave request submitted for approval.'));
  } catch (e) {
   res.redirect('/hr/request-leave?err=' + encodeURIComponent(e.message));
  }
 });

 /** Self: attendance history */
 app.get('/hr/my-attendance', requireAuth, requireHrSelfService, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const uid = sessionEmpId(req);
   if (uid < 1) {
    return res.redirect('/payroll?err=' + encodeURIComponent('Session employee id missing.'));
   }
   const [rows] = await pool
    .query(
     'SELECT * FROM tbl_hms_attendance WHERE facility_id = ? AND employee_id = ? ORDER BY att_date DESC LIMIT 120',
     [fid, uid]
    )
    .catch(() => [[]]);
   const now = new Date();
   const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
   const summary = { present: 0, late: 0, absent: 0, 'half-day': 0, 'on-leave': 0 };
   let totalMonth = 0;
   let hoursMonth = 0;
   for (const r of rows || []) {
    const d = String(r.att_date || '').slice(0, 10);
    if (d < monthStart) continue;
    totalMonth += 1;
    const st = String(r.status || 'present').toLowerCase();
    if (summary[st] == null) summary[st] = 0;
    summary[st] += 1;
    if (r.check_in_time && r.check_out_time) {
     const [ih, im] = String(r.check_in_time).split(':').map(Number);
     const [oh, om] = String(r.check_out_time).split(':').map(Number);
     const mins = (oh * 60 + om) - (ih * 60 + im);
     if (mins > 0) hoursMonth += mins / 60;
    }
   }
   res.render('hr-my-attendance', {
    title: 'My attendance - ZAIZENS',
    rows: rows || [],
    summary,
    totalMonth,
    hoursMonth: Math.round(hoursMonth * 10) / 10,
    today: now.toISOString().slice(0, 10),
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 /** Self: leave balance */
 app.get('/hr/my-leave-balance', requireAuth, requireHrSelfService, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const uid = sessionEmpId(req);
   const year = Math.max(2000, Math.min(2100, parseInt(req.query.year, 10) || new Date().getFullYear()));
   if (uid < 1) {
    return res.redirect('/payroll?err=' + encodeURIComponent('Session employee id missing.'));
   }
   const [rows] = await pool
    .query(
     'SELECT * FROM tbl_hms_leave_balance WHERE facility_id = ? AND employee_id = ? AND year = ? ORDER BY leave_type',
     [fid, uid, year]
    )
    .catch(() => [[]]);
   let requestsByType = {};
   try {
    const [agg] = await pool.query(
     `SELECT leave_type, status, SUM(days_requested) AS days
      FROM tbl_hms_leave_request
      WHERE facility_id = ? AND employee_id = ? AND YEAR(start_date) = ? AND status IN ('approved','pending')
      GROUP BY leave_type, status`,
     [fid, uid, year]
    );
    for (const row of agg || []) {
     const key = String(row.leave_type || 'other');
     if (!requestsByType[key]) requestsByType[key] = { used: 0, pending: 0 };
     if (String(row.status) === 'approved') requestsByType[key].used += Number(row.days) || 0;
     else requestsByType[key].pending += Number(row.days) || 0;
    }
   } catch (_) { /* optional */ }
   const enriched = (rows || []).map((r) => {
    const agg = requestsByType[String(r.leave_type)] || { used: 0, pending: 0 };
    const entitled = Number(r.balance) || 0;
    return {
     ...r,
     entitled,
     used: agg.used,
     pending: agg.pending,
     remaining: Math.round((entitled - agg.used - agg.pending) * 10) / 10,
    };
   });
   res.render('hr-my-leave-balance', {
    title: 'My leave balance - ZAIZENS',
    year,
    rows: enriched,
    requestsByType,
    totals: {
     entitled: enriched.reduce((s, r) => s + r.entitled, 0),
     used: enriched.reduce((s, r) => s + r.used, 0),
     pending: enriched.reduce((s, r) => s + r.pending, 0),
     remaining: enriched.reduce((s, r) => s + r.remaining, 0),
    },
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 /** Self: payslips from payroll records */
 app.get('/hr/my-payslips', requireAuth, requireHrSelfService, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const uid = sessionEmpId(req);
   if (uid < 1) {
    return res.redirect('/payroll?err=' + encodeURIComponent('Session employee id missing.'));
   }
   const [rows] = await pool
    .query(
     `SELECT * FROM tbl_hms_payroll_record
      WHERE facility_id = ? AND employee_id = ?
      ORDER BY year DESC, month DESC
      LIMIT 36`,
     [fid, uid]
    )
    .catch(() => [[]]);
   const months = {
    1: 'Jan',
    2: 'Feb',
    3: 'Mar',
    4: 'Apr',
    5: 'May',
    6: 'Jun',
    7: 'Jul',
    8: 'Aug',
    9: 'Sep',
    10: 'Oct',
    11: 'Nov',
    12: 'Dec'
   };
   const ytd = { gross: 0, tax: 0, net: 0, deductions: 0, count: 0 };
   const currentYear = new Date().getFullYear();
   for (const r of rows || []) {
    if (Number(r.year) !== currentYear) continue;
    ytd.count += 1;
    ytd.gross += Number(r.gross_salary) || 0;
    ytd.tax += Number(r.income_tax) || 0;
    ytd.net += Number(r.net_salary) || 0;
    ytd.deductions += (Number(r.cnps_employee) || 0) + (Number(r.cimr_employee) || 0)
      + (Number(r.crtv_deduction) || 0) + (Number(r.council_tax_deduction) || 0)
      + (Number(r.development_tax_deduction) || 0) + (Number(r.income_tax) || 0)
      + (Number(r.cnhc_deduction) || 0);
   }
   res.render('hr-my-payslips', {
    title: 'My payslips - ZAIZENS',
    paySelfServiceOnly: 'payslips',
    rows: rows || [],
    months,
    ytd,
    currentYear,
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });
};
