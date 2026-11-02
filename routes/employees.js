'use strict';

/**
 * Employee onboarding: create an employee, set a gross salary and let the
 * Cameroon statutory engine generate the pay profile + first payroll line.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ensureHrPayrollSchema = require('../lib/ensureHrPayrollSchema');
const ensureEmployeeHrSchema = require('../lib/ensureEmployeeHrSchema');
const { loadRoleTitleMap, resolveRoleTitle, resolveHireDate } = require('../lib/hmsEmployeeHr');
const { SECTORS, loadAllowanceSettings } = require('../lib/hmsAllowanceCameroon');
const {
  computeFromGross,
  computeFromProfile,
} = require('../lib/payrollCompensation');

const MONTHS = {
  1: 'January', 2: 'February', 3: 'March', 4: 'April', 5: 'May', 6: 'June',
  7: 'July', 8: 'August', 9: 'September', 10: 'October', 11: 'November', 12: 'December',
};

const FALLBACK_ROLES = [
  { id: 1, title: 'Admin' },
  { id: 2, title: 'Doctor' },
  { id: 3, title: 'Front Desk' },
  { id: 4, title: 'Lab' },
  { id: 5, title: 'Pharmacy' },
  { id: 6, title: 'Radiology' },
  { id: 7, title: 'Nurse' },
  { id: 8, title: 'Nursing Aid' },
  { id: 9, title: 'Accountant' },
  { id: 11, title: 'Cashier' },
  { id: 99, title: 'Super Admin' },
];

function clean(value, max = 250) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function toIsoDate(value) {
  const raw = clean(value, 40);
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) return raw;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function slugUsername(first, last, fallbackId) {
  const base = `${first || ''}.${last || ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.]+/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
  return base || `employee${fallbackId || ''}`;
}

async function loadRoles(pool) {
  try {
    const [rows] = await pool.query(
      `SELECT CAST(role AS UNSIGNED) AS id, MIN(title) AS title
       FROM tbl_role
       WHERE CAST(role AS UNSIGNED) > 0
       GROUP BY CAST(role AS UNSIGNED)
       ORDER BY id`
    );
    const list = (rows || [])
      .map((r) => ({ id: Number(r.id), title: clean(r.title, 120) || `Role ${r.id}` }))
      .filter((r) => r.id > 0);
    return list.length ? list : FALLBACK_ROLES;
  } catch (_) {
    return FALLBACK_ROLES;
  }
}

async function facilitySector(pool, fid) {
  try {
    const [[row]] = await pool.query(
      'SELECT default_sector FROM tbl_hms_payroll_settings WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1',
      [fid]
    );
    const sector = clean(row && row.default_sector, 40).toLowerCase();
    return SECTORS[sector] ? sector : 'medical';
  } catch (_) {
    return 'medical';
  }
}

module.exports = function registerEmployeeRoutes(app, pool, requireAuth, deps) {
  const { requireAdminOrSuper } = deps || {};

  function facilityId(req) {
    return Math.max(1, parseInt(req.session.facilityId, 10) || 1);
  }

  function canManage(req) {
    const role = String((req.session.user && req.session.user.role) || '');
    if (role === '1' || role === '99') return true;
    const up = req.session.userPerms || [];
    return up.includes('*') || up.includes('payroll.write');
  }

  function guard(req, res, next) {
    if (canManage(req)) return next();
    if (requireAdminOrSuper) return requireAdminOrSuper(req, res, next);
    return res.status(403).send('Admin access required.');
  }

  function renderNew(res, opts) {
    return res.status(opts.status || 200).render('employees-new', {
      title: 'New employee — Zaizens Payroll',
      roles: opts.roles || FALLBACK_ROLES,
      sectors: SECTORS,
      defaultSector: opts.defaultSector || 'medical',
      form: opts.form || {},
      flash: opts.flash || null,
      error: opts.error || null,
      today: new Date().toISOString().slice(0, 10),
      currentYear: new Date().getFullYear(),
      currentMonth: new Date().getMonth() + 1,
      months: MONTHS,
    });
  }

  app.get('/payroll/employees/new', requireAuth, guard, async (req, res) => {
    try {
      await ensureHrPayrollSchema(pool);
      const fid = facilityId(req);
      const [roles, sector] = await Promise.all([loadRoles(pool), facilitySector(pool, fid)]);
      return renderNew(res, { roles, defaultSector: sector });
    } catch (e) {
      return res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  /** Live preview: gross → basic, allowances, statutory deductions, net. */
  app.post('/payroll/employees/preview', requireAuth, guard, async (req, res) => {
    try {
      await ensureHrPayrollSchema(pool);
      const fid = facilityId(req);
      const gross = Math.max(0, parseFloat(req.body.gross) || 0);
      if (gross <= 0) return res.status(400).json({ error: 'Enter a gross salary greater than zero.' });

      const sector = SECTORS[clean(req.body.sector, 40).toLowerCase()] ? clean(req.body.sector, 40).toLowerCase() : 'medical';
      const settings = await loadAllowanceSettings(pool, fid, sector);
      const role = clean(req.body.role, 20) || '0';
      const roleMap = await loadRoleTitleMap(pool);
      const comp = await computeFromGross(pool, fid, new Date().getFullYear(), gross, {
        role,
        roleTitle: resolveRoleTitle(role, roleMap),
        hireDate: toIsoDate(req.body.hire_date),
        settings,
        isSpecialist: String(req.body.is_specialist || '') === '1',
      });
      return res.json({ ok: true, ...comp });
    } catch (e) {
      console.error('[employees/preview]', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  app.post('/payroll/employees/new', requireAuth, guard, async (req, res) => {
    const fid = facilityId(req);
    const body = req.body || {};
    try {
      await ensureHrPayrollSchema(pool);
      await ensureEmployeeHrSchema(pool);

      const first = clean(body.first_name, 120);
      const last = clean(body.last_name, 120);
      const gross = Math.max(0, parseFloat(body.gross) || 0);
      const role = clean(body.role, 20);
      const sector = SECTORS[clean(body.sector, 40).toLowerCase()] ? clean(body.sector, 40).toLowerCase() : 'medical';
      const hireDate = toIsoDate(body.joining_date) || new Date().toISOString().slice(0, 10);
      const month = Math.min(12, Math.max(1, parseInt(body.month, 10) || new Date().getMonth() + 1));
      const year = Math.min(2100, Math.max(2000, parseInt(body.year, 10) || new Date().getFullYear()));

      const fail = async (msg) => {
        const [roles, sectorDefault] = await Promise.all([loadRoles(pool), facilitySector(pool, fid)]);
        return renderNew(res, {
          status: 400,
          roles,
          defaultSector: sectorDefault,
          form: body,
          error: msg,
        });
      };

      if (!first || !last) return fail('First name and last name are required.');
      if (!role) return fail('Select the employee role — it drives the statutory allowances.');
      if (gross <= 0) return fail('Enter a gross monthly salary greater than zero.');

      // ── Unique username ───────────────────────────────────────
      const base = slugUsername(first, last);
      let username = base;
      for (let i = 1; i < 50; i += 1) {
        const [[taken]] = await pool.query('SELECT id FROM tbl_employee WHERE username = ? LIMIT 1', [username]);
        if (!taken) break;
        username = `${base}${i + 1}`;
      }

      const randomPassword = await bcrypt.hash(crypto.randomBytes(18).toString('hex'), 10);

      const [insertResult] = await pool.query(
        `INSERT INTO tbl_employee
          (first_name, last_name, username, emailid, password, dob, gender, address, bio,
           employee_id, joining_date, phone, role, status, primary_department, job_title,
           cnps_number, tax_niu, nic_number, bank_name, bank_account_no, default_facility_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`,
        [
          first,
          last,
          username,
          clean(body.emailid, 250),
          randomPassword,
          clean(body.dob, 50),
          clean(body.gender, 10),
          clean(body.address, 500),
          '',
          clean(body.employee_id, 120),
          hireDate,
          clean(body.phone, 32),
          role,
          clean(body.primary_department, 120) || null,
          clean(body.job_title, 120) || null,
          clean(body.cnps_number, 32),
          clean(body.tax_niu, 32),
          clean(body.nic_number, 32),
          clean(body.bank_name, 120),
          clean(body.bank_account_no, 40),
          fid,
        ]
      );
      const employeeId = Number(insertResult.insertId);
      if (!employeeId) return fail('Employee could not be created.');

      // Matricule: keep what was typed, otherwise derive from the new id.
      let matricule = clean(body.employee_id, 120);
      if (!matricule) {
        matricule = `EMP-${String(employeeId).padStart(4, '0')}`;
        await pool.query('UPDATE tbl_employee SET employee_id = ? WHERE id = ?', [matricule, employeeId]);
      }

      // ── Pay profile + statutory deductions from gross ────────
      const settings = await loadAllowanceSettings(pool, fid, sector);
      const roleMap = await loadRoleTitleMap(pool);
      const comp = await computeFromGross(pool, fid, year, gross, {
        role,
        roleTitle: resolveRoleTitle(role, roleMap),
        hireDate,
        settings,
        isSpecialist: String(body.is_specialist || '') === '1',
      });

      await pool.query(
        `INSERT INTO tbl_hms_pay_profile
          (facility_id, employee_id, basic_salary, housing_allowance, transport_allowance, other_allowances,
           medical_risk_allowance, responsibility_allowance, is_specialist,
           hire_date, sector, night_shifts_per_month, on_call_per_month)
         VALUES (?,?,?,?,?,0,0,0,?,?,?,0,0)
         ON DUPLICATE KEY UPDATE
          basic_salary=VALUES(basic_salary), housing_allowance=VALUES(housing_allowance),
          transport_allowance=VALUES(transport_allowance), other_allowances=0,
          is_specialist=VALUES(is_specialist), hire_date=VALUES(hire_date), sector=VALUES(sector)`,
        [
          fid,
          employeeId,
          comp.basic_salary,
          comp.housing_allowance,
          comp.transport_allowance,
          String(body.is_specialist || '') === '1' ? 1 : 0,
          hireDate,
          sector,
        ]
      );

      let recordId = 0;
      let warning = '';
      if (comp.statutory_ready) {
        const d = comp.deductions;
        const snap = JSON.stringify({ total: comp.allowance_total, lines: comp.allowance_lines });
        const [rec] = await pool.query(
          `INSERT INTO tbl_hms_payroll_record
            (facility_id, employee_id, year, month, gross_salary,
             cnps_employee, cimr_employee, crtv_deduction, council_tax_deduction,
             development_tax_deduction, cnhc_deduction, taxable_income, income_tax, net_salary,
             basic_salary_snap, housing_allowance_snap, transport_allowance_snap, other_allowances_snap,
             payout_status, allowances_snap, non_taxable_allowance)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'pending',?,?)
           ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
          [
            fid,
            employeeId,
            year,
            month,
            comp.gross,
            d.cnps,
            d.cfc,
            d.crtv,
            d.council,
            d.fne,
            d.cac,
            comp.taxable_income,
            d.irpp,
            comp.net,
            comp.basic_salary,
            comp.housing_allowance,
            comp.transport_allowance,
            snap,
            comp.allowance_tax_free_total,
          ]
        );
        recordId = Number(rec.insertId || 0);
      } else {
        warning =
          'Employee saved, but payroll tax settings are missing, so no payroll line could be calculated. Configure Tax settings first, then process the month.';
      }

      const q = new URLSearchParams();
      q.set('msg', `Employee ${first} ${last} created with gross XAF ${comp.gross.toLocaleString('fr-FR')}.`);
      if (recordId) q.set('record', String(recordId));
      if (warning) q.set('err', warning);
      return res.redirect(`/payroll/employees/${employeeId}?${q.toString()}`);
    } catch (e) {
      console.error('[employees/new]', e.message);
      const [roles, sectorDefault] = await Promise.all([loadRoles(pool), facilitySector(pool, fid)]);
      return renderNew(res, {
        status: 500,
        roles,
        defaultSector: sectorDefault,
        form: body,
        error: e.message,
      });
    }
  });

  app.get('/payroll/employees/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    if (id < 1) return res.status(404).render('error', { title: 'Not found', message: 'Employee not found.', status: 404 });
    const fid = facilityId(req);
    const viewerId = parseInt((req.session.user && req.session.user.id), 10) || 0;
    if (viewerId !== id && !canManage(req)) {
      return res.status(403).render('error', {
        title: 'Forbidden',
        message: 'You can only view your own payroll record.',
        status: 403,
      });
    }
    try {
      await ensureHrPayrollSchema(pool);
      await ensureEmployeeHrSchema(pool);

      const [[employee]] = await pool.query(
        `SELECT id, first_name, last_name, username, employee_id, emailid, phone, gender, dob,
                joining_date, role, status, primary_department, job_title, cnps_number, tax_niu,
                nic_number, bank_name, bank_account_no, address
         FROM tbl_employee WHERE id = ? LIMIT 1`,
        [id]
      );
      if (!employee) return res.status(404).render('error', { title: 'Not found', message: 'Employee not found.', status: 404 });

      const roleMap = await loadRoleTitleMap(pool);
      const roleTitle = resolveRoleTitle(employee.role, roleMap);

      const [[profile]] = await pool
        .query('SELECT * FROM tbl_hms_pay_profile WHERE facility_id = ? AND employee_id = ? LIMIT 1', [fid, id])
        .catch(() => [[null]]);

      const [records] = await pool
        .query(
          `SELECT * FROM tbl_hms_payroll_record
           WHERE facility_id = ? AND employee_id = ?
           ORDER BY year DESC, month DESC LIMIT 12`,
          [fid, id]
        )
        .catch(() => [[]]);

      let comp = null;
      let compError = null;
      if (profile && Number(profile.basic_salary) > 0) {
        try {
          const sector = clean(profile.sector, 40).toLowerCase() || 'medical';
          const settings = await loadAllowanceSettings(pool, fid, SECTORS[sector] ? sector : 'medical');
          comp = await computeFromProfile(pool, fid, new Date().getFullYear(), profile, {
            role: employee.role,
            roleTitle,
            hireDate: resolveHireDate(employee.joining_date, profile.hire_date),
            settings,
            nightShifts: Number(profile.night_shifts_per_month) || 0,
            onCallShifts: Number(profile.on_call_per_month) || 0,
            isSpecialist: Number(profile.is_specialist) === 1,
          });
        } catch (e) {
          compError = e.message;
        }
      }

      res.render('employee-detail', {
        title: `${employee.first_name} ${employee.last_name} — Zaizens Payroll`,
        employee,
        profile,
        roleTitle,
        comp,
        compError,
        records: records || [],
        months: MONTHS,
        flash: req.query.msg || null,
        error: req.query.err || null,
        highlightRecordId: parseInt(req.query.record, 10) || 0,
      });
    } catch (e) {
      console.error('[employees/:id]', e.message);
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });
};
