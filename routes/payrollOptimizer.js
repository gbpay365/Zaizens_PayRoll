'use strict';

const optimizer = require('../lib/payrollOptimizer');

const DEFAULT_FORM = {
  employee_id: '',
  baseSalary: 450000,
  sector: 'general',
  regime: '1',
  risk: 'medium',
  transport: 30000,
  representation: 0,
  housing: 0,
  electricity: 0,
  water: 0,
  meal: 1000,
  dirtiness: 0,
  clothing: 0,
  tools: 0,
  other: 0,
};

function clean(value, max = 120) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function number(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function parseForm(body) {
  const raw = body || {};
  return {
    employee_id: clean(raw.employee_id, 20),
    baseSalary: number(raw.baseSalary),
    sector: clean(raw.sector, 40).toLowerCase() || DEFAULT_FORM.sector,
    regime: clean(raw.regime, 4) || DEFAULT_FORM.regime,
    risk: clean(raw.risk, 12).toLowerCase() || DEFAULT_FORM.risk,
    transport: number(raw.transport),
    representation: number(raw.representation),
    housing: number(raw.housing),
    electricity: number(raw.electricity),
    water: number(raw.water),
    meal: number(raw.meal),
    dirtiness: number(raw.dirtiness),
    clothing: number(raw.clothing),
    tools: number(raw.tools),
    other: number(raw.other),
  };
}

function allowancesOf(form) {
  const out = {};
  for (const key of optimizer.ALLOWANCE_KEYS) out[key] = Number(form[key]) || 0;
  return out;
}

function withSettings(form, settings) {
  return {
    baseSalary: form.baseSalary,
    sector: form.sector,
    regime: form.regime,
    risk: form.risk,
    allowances: allowancesOf(form),
    settings: settings || {},
  };
}

module.exports = function registerPayrollOptimizerRoutes(app, pool, requireAuth, deps) {
  const requirePayrollAccess = deps.requirePayrollAccess;

  function facilityId(req) {
    return Math.max(1, parseInt(req.session.facilityId, 10) || 1);
  }

  function sessionEmpId(req) {
    return parseInt(req.session.user && req.session.user.id, 10) || 0;
  }

  function isPayrollAdmin(req) {
    const role = String((req.session.user && req.session.user.role) || '');
    return role === '1' || role === '99';
  }

  async function loadSettings(fid) {
    const [[row]] = await pool
      .query(
        `SELECT * FROM tbl_hms_payroll_settings
          WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1`,
        [fid]
      )
      .catch(() => [[null]]);
    return row || {};
  }

  async function loadEmployees(req) {
    const uid = sessionEmpId(req);
    const admin = isPayrollAdmin(req);
    const fid = facilityId(req);
    const perms = Array.isArray(req.res && req.res.locals && req.res.locals.userPerms)
      ? req.res.locals.userPerms
      : [];
    const canSeeAll =
      admin ||
      perms.includes('*') ||
      perms.includes('payroll.read') ||
      perms.includes('payroll.write');
    const [rows] = await pool
      .query(
        `SELECT id, first_name, last_name, employee_id
           FROM tbl_employee
          WHERE status = 1
            AND (default_facility_id IS NULL OR default_facility_id = ?)
            ${canSeeAll ? '' : 'AND id = ?'}
          ORDER BY last_name, first_name
          LIMIT 500`,
        canSeeAll ? [fid] : [fid, uid]
      )
      .catch(() => [[]]);
    return rows || [];
  }

  async function loadEmployeeForm(req, employeeId) {
    const id = parseInt(employeeId, 10) || 0;
    if (id < 1) return null;
    const fid = facilityId(req);
    const [[row]] = await pool
      .query(
        `SELECT e.id AS employee_pk, e.first_name, e.last_name,
                e.employee_id AS matricule, e.role,
                pp.*
           FROM tbl_employee e
           LEFT JOIN tbl_hms_pay_profile pp
             ON pp.employee_id = e.id AND pp.facility_id = ?
          WHERE e.id = ?
            AND (e.default_facility_id IS NULL OR e.default_facility_id = ?)
          LIMIT 1`,
        [fid, id, fid]
      )
      .catch(() => [[null]]);
    if (!row) return null;
    return {
      id: row.employee_pk,
      name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      matricule: row.matricule || row.employee_pk,
      sector: row.sector || 'medical',
      basic_salary: row.basic_salary,
      housing_allowance: row.housing_allowance,
      transport_allowance: row.transport_allowance,
      other_allowances: row.other_allowances,
    };
  }

  function employeeFormDefaults(employee, settings) {
    if (!employee) {
      return {
        ...DEFAULT_FORM,
        sector: String(settings.default_sector || DEFAULT_FORM.sector).toLowerCase(),
        regime: String(settings.cnps_regime || DEFAULT_FORM.regime),
      };
    }
    return {
      ...DEFAULT_FORM,
      employee_id: String(employee.id),
      baseSalary: number(employee.basic_salary),
      sector: String(employee.sector || settings.default_sector || 'medical').toLowerCase(),
      regime: String(settings.cnps_regime || DEFAULT_FORM.regime),
      transport: number(employee.transport_allowance),
      housing: number(employee.housing_allowance),
      other: number(employee.other_allowances),
      meal: 0,
    };
  }

  function render(req, res, options = {}) {
    const form = options.form || DEFAULT_FORM;
    const settings = options.settings || {};
    const employee = options.employee || null;
    const result = options.result || null;
    const proposal = options.proposal || null;
    const alerts = result ? optimizer.alertsFor(result, { baseSalary: form.baseSalary }) : [];
    const proposalAlerts = proposal
      ? optimizer.alertsFor(proposal.after, { baseSalary: proposal.allocBase })
      : [];
    res.render('payroll-optimizer', {
      title: 'Payroll Optimizer — ZAIZENS PAY',
      payNavActive: 'optimizer',
      form,
      settings,
      employee,
      employees: options.employees || [],
      result,
      proposal,
      alerts,
      proposalAlerts,
      sectors: optimizer.SECTOR_PROFILES,
      regimes: optimizer.REGIME_PROFILES,
      risks: optimizer.RISK_PROFILES,
      allowanceKeys: optimizer.ALLOWANCE_KEYS,
      error: options.error || null,
      flash: req.query.msg || null,
    });
  }

  app.get('/payroll/optimizer', requireAuth, requirePayrollAccess, async (req, res) => {
    try {
      const settings = await loadSettings(facilityId(req));
      const employee = await loadEmployeeForm(req, req.query.employee_id);
      const form = employeeFormDefaults(employee, settings);
      const employees = await loadEmployees(req);
      render(req, res, { form, settings, employee, employees });
    } catch (err) {
      console.error('PAYROLL OPTIMIZER GET:', err.message);
      res.status(500).render('error', {
        title: 'Error',
        message: err.message,
        status: 500,
      });
    }
  });

  app.post('/payroll/optimizer/run', requireAuth, requirePayrollAccess, async (req, res) => {
    try {
      const settings = await loadSettings(facilityId(req));
      const form = parseForm(req.body);
      const employee = await loadEmployeeForm(req, form.employee_id);
      const employees = await loadEmployees(req);
      const action = clean((req.body || {}).action, 20) || 'calculate';
      const input = withSettings(form, settings);
      const result = optimizer.computePayroll(input);
      const proposal = action === 'optimize' ? optimizer.optimizePayroll(input) : null;
      render(req, res, { form, settings, employee, employees, result, proposal });
    } catch (err) {
      console.error('PAYROLL OPTIMIZER POST:', err.message);
      res.status(500).render('error', {
        title: 'Error',
        message: err.message,
        status: 500,
      });
    }
  });
};
