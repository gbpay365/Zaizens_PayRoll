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
const { hmsPayrollCameroonCalculate, defaultBracketsJson } = require('../lib/hmsPayrollCameroon');
const { loadPayrollDashboard } = require('../lib/hmsPayrollDashboard');
const pagination = require('../lib/pagination');
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

/**
 * Roster-based shift/on-call allowance codes. These are paid in addition to the
 * taxable gross and are themselves NOT subject to CNPS / CFC / CRTV / IRPP / CAC.
 *  - night_duty  → nurses on night roster (tbl_nurse_shift_schedule.shift_type='night')
 *  - on_call     → doctors on on-call roster (tbl_doctor_duty_schedule.duty_type='night')
 */
const TAX_FREE_ALLOWANCE_CODES = new Set(['night_duty', 'on_call']);

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

 /** Active staff list (same scope as PHP simplified: all active employees). */
 async function activeStaff() {
  let rows = [];
  try {
   const [r] = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.role, e.employee_id, e.joining_date,
            COALESCE((SELECT MIN(title) FROM tbl_role WHERE CAST(role AS UNSIGNED) = CAST(e.role AS UNSIGNED)), '') AS role_title
     FROM tbl_employee e WHERE e.status = 1 ORDER BY e.last_name, e.first_name`
   );
   rows = r || [];
  } catch (e) {
   const [r] = await pool.query(
    'SELECT id, first_name, last_name, role FROM tbl_employee WHERE status = 1 ORDER BY last_name, first_name'
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
     .query(`SELECT p.id ${fromJoin} ORDER BY p.year DESC, p.month DESC, p.id`, listParams)
     .catch(() => [[]]);
    allDeletableIds = (idRows || [])
     .map((r) => parseInt(r.id, 10))
     .filter((id) => id > 0);
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
    flash: req.query.msg || null,
    error: req.query.err || null
   });
  } catch (err) {
   console.error('PAYROLL MONTHLY GET:', err.message);
   res.status(500).render('error', { title: 'Error', message: err.message, status: 500 });
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
    'SELECT employer_cnps_number, employer_niu, employer_address, employer_phone, employer_email FROM tbl_hms_payroll_settings WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1',
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
   const ded =
    (parseFloat(row.cnps_employee) || 0) +
    (parseFloat(row.cimr_employee) || 0) +
    (parseFloat(row.crtv_deduction) || 0) +
    (parseFloat(row.council_tax_deduction) || 0) +
    (parseFloat(row.development_tax_deduction) || 0) +
    (parseFloat(row.cnhc_deduction) || 0) +
    (parseFloat(row.income_tax) || 0);
   // CNPS employer: 4.2% pension + 7% family benefits = 11.2% (baseline, capped at 750K)
   const cnpsBase = Math.min(gross, 750000);
   const cnpsEmployer = Math.round(cnpsBase * 11.2) / 100;
   // CFC employer: 1.5% of gross (Crédit Foncier du Cameroun)
   const cimrEmployer = Math.round(gross * 1.5) / 100; // column kept as cimrEmployer for compat
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
    cnpsEmployer, cimrEmployer,
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
   const staff = await activeStaff();
   let processed = 0;
   let skipped = 0;
   let errMsg = '';
   for (const em of staff) {
    const eid = parseInt(em.id, 10) || 0;
    if (eid < 1) continue;
    const [[pr]] = await pool
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

    const [[ex]] = await pool.query(
     'SELECT id FROM tbl_hms_payroll_record WHERE facility_id = ? AND employee_id = ? AND year = ? AND month = ? LIMIT 1',
     [fid, eid, year, month]
    );
    if (ex) {
     skipped++;
     continue;
    }

    // Roster-based shift counts (Night Shifts / On-Call sessions) for this month.
    // These drive the night_duty + on_call allowances directly from the duty roster,
    // not from manual pay-profile figures, and they are paid TAX-FREE.
    const rosterCounts = await countRosterShiftsForMonth(pool, fid, eid, year, month);

    const empSector = String(pr?.sector || 'medical').toLowerCase();
    const isSpec = parseInt(pr?.is_specialist, 10) === 1;
    const allowSettings = await loadAllowanceSettings(pool, fid, empSector);
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
    const tax = await hmsPayrollCameroonCalculate(pool, fid, year, taxableGross);
    if (!tax) {
     errMsg = 'Configure payroll tax: add a row in tbl_hms_payroll_settings for this facility (or run app once to seed).';
     break;
    }

    // Headline gross on the payslip = taxable gross + tax-free shift/on-call.
    // Net to pay = statutory net + tax-free shift/on-call (added back on top of tax).
    const displayGross = taxableGross + taxFreeTotal;
    const displayNet   = (parseFloat(tax.net_salary) || 0) + taxFreeTotal;

    await pool.query(
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
   const q = errMsg
    ? 'err=' + encodeURIComponent(errMsg)
    : 'msg=' + encodeURIComponent(`Payroll run: ${processed} new record(s). Skipped (already exists): ${skipped}.${syncNote}`);
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
    'UPDATE tbl_hms_payroll_record SET payout_status = ? WHERE id = ? AND facility_id = ? AND payout_status = ? LIMIT 1',
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
    'UPDATE tbl_hms_payroll_record SET payout_status = ? WHERE facility_id = ? AND year = ? AND month = ? AND payout_status = ?',
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
    'SELECT year, month FROM tbl_hms_payroll_record WHERE id = ? AND facility_id = ? LIMIT 1',
    [rid, fid]
   );
   const [r] = await pool.query(
    'DELETE FROM tbl_hms_payroll_record WHERE id = ? AND facility_id = ? LIMIT 1',
    [rid, fid]
   );
   const ok = r.affectedRows > 0;
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
   const [periodRows] = await pool.query(
    `SELECT DISTINCT year, month FROM tbl_hms_payroll_record WHERE facility_id = ? AND id IN (${placeholders})`,
    [fid, ...ids]
   );
   const [r] = await pool.query(
    `DELETE FROM tbl_hms_payroll_record WHERE facility_id = ? AND id IN (${placeholders})`,
    [fid, ...ids]
   );
   const n = r.affectedRows || 0;
   let syncNote = '';
   if (n > 0 && periodRows && periodRows.length) {
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
          : `${n} payroll records deleted. You can now re-process the affected period(s).`) + syncNote
        )
      : 'err=' + encodeURIComponent('No records were deleted (not found or already removed).'))
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
    'UPDATE tbl_hms_payroll_record SET payout_status = ? WHERE facility_id = ? AND year = ? AND month = ? AND payout_status = ?',
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
   let where = 'e.status = 1';
   const listParams = [fid];
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
   const profiles = (pageResult.rows || []).map((row) => {
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
   });
   const pager = pageResult.pager;
   // Load facility-wide default sector from settings
   const [[settingsRow]] = await pool.query(
    'SELECT default_sector FROM tbl_hms_payroll_settings WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1',
    [fid]
   ).catch(() => [[null]]);
   const facilitySector = String((settingsRow && settingsRow.default_sector) || 'medical').toLowerCase();

   res.render('payroll-profiles', {
    title: 'Pay profiles - ZAIZENS',
    profiles,
    pager,
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
  * For mode='net', we solve Gross via bisection on the deduction function,
  * then split using the formula above.
  */
 app.post('/payroll/profiles/auto-compute', requireAuth, requirePayrollAccess, requireAdminOrSuper, async (req, res) => {
  const HOUSING_PCT   = 0.15;
  const TRANSPORT_PCT = 0.10;
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
            COALESCE((SELECT MIN(title) FROM tbl_role WHERE CAST(role AS UNSIGNED) = CAST(e.role AS UNSIGNED)), '') AS role_title
     FROM tbl_employee e WHERE e.id=? LIMIT 1`,
    [eid]
   );
   if (!emp) return res.status(404).json({ error: 'Employee not found' });
   const roleTitle = String(emp.role_title || '').trim();

   const [[pp]] = await pool.query(
    `SELECT hire_date, sector, night_shifts_per_month, on_call_per_month, is_specialist
     FROM tbl_hms_pay_profile WHERE facility_id=? AND employee_id=? LIMIT 1`,
    [fid, eid]
   ).catch(() => [[null]]);

   const hireDate    = resolveHireDate(emp.joining_date, pp && pp.hire_date);
   const sector      = String((pp && pp.sector) || 'medical').toLowerCase();
   const nightShifts = parseInt((pp && pp.night_shifts_per_month) || 0, 10);
   const onCall      = parseInt((pp && pp.on_call_per_month) || 0, 10);
   const isSpec      = parseInt((pp && pp.is_specialist) || 0, 10) === 1;

   const settings = await loadAllowanceSettings(pool, fid, sector);
   const year = new Date().getFullYear();

   /** For a candidate basic, return the full breakdown. */
   function breakdownFromBasic(basic) {
    const b = Math.max(0, Math.round(basic));
    const housing   = Math.round(b * HOUSING_PCT);
    const transport = Math.round(b * TRANSPORT_PCT);
    const allow = computeAllowances({
     basicSalary:  b,
     role:         emp.role,
     roleTitle,
     hireDate,
     settings,
     nightShifts,
     onCallShifts: onCall,
     isSpecialist: isSpec,
    });
    const lines = allow.lines || [];
    const taxFreeTotal = lines
      .filter((l) => l.code === 'night_duty' || l.code === 'on_call')
      .reduce((sum, l) => sum + (parseInt(l.amount, 10) || 0), 0);
    const taxableAllowances = Math.max(0, (allow.total || 0) - taxFreeTotal);
    const taxableGross = b + housing + transport + taxableAllowances;
    const gross = taxableGross + taxFreeTotal;
    return { basic: b, housing, transport, allow, taxableGross, taxFreeTotal, gross };
   }

   /** Solve basic so that gross ≈ targetGross. Newton's method. */
   function solveBasicForGross(targetGross) {
    if (targetGross <= 0) return 0;
    let basic = targetGross / 1.5; // initial guess
    for (let i = 0; i < 30; i++) {
     const cur = breakdownFromBasic(basic);
     const diff = targetGross - cur.gross;
     if (Math.abs(diff) < 1) break;
     const slope = (breakdownFromBasic(basic + 1000).gross - cur.gross) / 1000;
     if (!isFinite(slope) || slope <= 0) break;
     basic = Math.max(0, basic + diff / slope);
    }
    return Math.max(0, Math.round(basic));
   }

   /** Solve gross from a target net via bisection over hmsPayrollCameroonCalculate. */
   async function solveGrossForNet(targetNet) {
    let lo = targetNet, hi = targetNet * 3;
    let g  = targetNet * 1.3;
    for (let i = 0; i < 40; i++) {
     const calc = await hmsPayrollCameroonCalculate(pool, fid, year, g);
     if (!calc) return targetNet;
     const net = calc.net_salary;
     if (Math.abs(net - targetNet) < 1) return Math.round(g);
     if (net < targetNet) lo = g; else hi = g;
     g = (lo + hi) / 2;
    }
    return Math.round(g);
   }

   const targetGross = mode === 'gross' ? amount : await solveGrossForNet(amount);
   const basic       = solveBasicForGross(targetGross);
   const final       = breakdownFromBasic(basic);
   const taxCalc     = await hmsPayrollCameroonCalculate(pool, fid, year, final.taxableGross);

   return res.json({
    ok:                       true,
    mode,
    input:                    amount,
    basic_salary:             final.basic,
    housing_allowance:        final.housing,
    transport_allowance:      final.transport,
    medical_risk_allowance:   0,
    responsibility_allowance: 0,
    allowance_lines:          final.allow.lines || [],
    allowance_total:          final.allow.total || 0,
    gross:                    final.gross,
    net:                      taxCalc ? taxCalc.net_salary + final.taxFreeTotal : null,
    deductions:               taxCalc ? {
     cnps:    taxCalc.cnps_employee,
     cfc:     taxCalc.cimr_employee,
     crtv:    taxCalc.crtv_deduction,
     council: taxCalc.council_tax_deduction,
     fne:     taxCalc.development_tax_deduction,
     irpp:    taxCalc.income_tax,
     cac:     taxCalc.cnhc_deduction,
     total:   (taxCalc.cnps_employee || 0)
            + (taxCalc.cimr_employee || 0)
            + (taxCalc.crtv_deduction || 0)
            + (taxCalc.council_tax_deduction || 0)
            + (taxCalc.development_tax_deduction || 0)
            + (taxCalc.income_tax || 0)
            + (taxCalc.cnhc_deduction || 0),
    } : null,
   });
  } catch (e) {
   console.error('AUTO-COMPUTE:', e);
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
   if (pageEids.length) {
    const [empRows] = await pool.query(
     `SELECT id, joining_date FROM tbl_employee WHERE id IN (${pageEids.map(() => '?').join(',')})`,
     pageEids
    );
    for (const er of empRows || []) {
     hireByEmp.set(parseInt(er.id, 10), resolveHireDate(er.joining_date, null));
    }
   }
   for (const eid of pageEids) {
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
    tax_brackets: '',
    default_sector: 'medical'
   };
   if (row && typeof row === 'object') Object.assign(current, row);
   let b = [];
   try {
    b = JSON.parse(String(current.tax_brackets || '')) || [];
   } catch (e) {
    b = [];
   }
   if (!Array.isArray(b) || b.length < 5) {
    try {
     b = JSON.parse(defaultBracketsJson());
    } catch (e2) {
     b = [];
    }
   }
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
  const requestedSector = String(req.body.default_sector || 'medical').trim().toLowerCase().slice(0, 40);
  const defaultSector = ALLOWANCE_SECTORS[requestedSector] ? requestedSector : 'medical';
  let brackets = JSON.stringify([
   { min: 0,      max: 166666, rate: parseFloat(req.body.tax_rate_1) || 10 },
   { min: 166667, max: 250000, rate: parseFloat(req.body.tax_rate_2) || 15 },
   { min: 250001, max: 416666, rate: parseFloat(req.body.tax_rate_3) || 25 },
   { min: 416667, max: 833333, rate: parseFloat(req.body.tax_rate_4) || 35 },
   { min: 833334, max: null,   rate: parseFloat(req.body.tax_rate_5) || 35 }
  ]);
  if (!brackets || brackets === 'null') brackets = defaultBracketsJson();
  try {
   await ensureHrPayrollSchema(pool);
   await pool.query(
    `INSERT INTO tbl_hms_payroll_settings (
      facility_id, tax_year, employer_cnps_number, employer_niu, cnps_regime,
      employer_address, employer_phone, employer_email,
      cnps_employee_rate, cimr_employee_rate, crtv_rate, council_tax_rate, development_tax_rate, cnhc_rate,
      tax_brackets, default_sector
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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

 async function loadLeaveApproverNames() {
  const [rows] = await pool
   .query(
    `SELECT DISTINCT e.first_name, e.last_name
     FROM tbl_employee e
     WHERE e.status = 1
       AND (
        e.role IN ('1', '99')
        OR e.role IN (
         SELECT rp.role FROM tbl_acl_role_permission rp
         INNER JOIN tbl_acl_permission p ON p.id = rp.permission_id
         WHERE p.code = 'hr.leave.approve'
        )
       )
     ORDER BY e.last_name, e.first_name
     LIMIT 12`
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
   const staff = await activeStaff();
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
   const staff = await activeStaff();
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
   const staff = await activeStaff();
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
   const defaultSubmittedTo = await loadLeaveApproverNames();
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
