'use strict';

const optimizer = require('../lib/payrollOptimizer');

const DEFAULT_FORM = {
  employee_id: '',
  baseSalary: 450000,
  sector: 'general',
  regime: '1',
  risk: 'medium',
  mode: 'both',
  entryMode: 'base',
  salaryTarget: 0,
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

function parseMode(value) {
  const mode = clean(value, 20).toLowerCase();
  return ['employee', 'employer', 'both'].indexOf(mode) !== -1 ? mode : DEFAULT_FORM.mode;
}

function parseEntryMode(value) {
  const mode = clean(value, 12).toLowerCase();
  return ['base', 'gross', 'net'].indexOf(mode) !== -1 ? mode : DEFAULT_FORM.entryMode;
}

function parseForm(body) {
  const raw = body || {};
  return {
    employee_id: clean(raw.employee_id, 20),
    baseSalary: number(raw.baseSalary),
    sector: clean(raw.sector, 40).toLowerCase() || DEFAULT_FORM.sector,
    regime: clean(raw.regime, 4) || DEFAULT_FORM.regime,
    risk: clean(raw.risk, 12).toLowerCase() || DEFAULT_FORM.risk,
    mode: parseMode(raw.mode),
    entryMode: parseEntryMode(raw.entryMode),
    salaryTarget: number(raw.salaryTarget),
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

function normalizeSalaryBasis(form, settings) {
  if (form.entryMode !== 'gross' && form.entryMode !== 'net') return form;
  const input = withSettings(form, settings);
  form.baseSalary =
    form.entryMode === 'gross'
      ? optimizer.solveBaseForGross(form.salaryTarget, input)
      : optimizer.solveBaseForNet(form.salaryTarget, input);
  return form;
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values) {
  return (values || []).map(csvCell).join(';');
}

function csvAmount(value) {
  return Math.round(Number(value) || 0);
}

function csvDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

module.exports = function registerPayrollOptimizerRoutes(app, pool, requireAuth, deps) {
  const requirePayrollAccess = deps.requirePayrollAccess;

  function facilityId(req) {
    return Math.max(1, parseInt(req.session.facilityId, 10) || 1);
  }

  function sessionEmpId(req) {
    return parseInt(req.session.user && req.session.user.id, 10) || 0;
  }

  function sessionEmpName(req) {
    const user = (req.session && req.session.user) || {};
    return clean(user.name || user.username || user.email || 'Payroll user', 120);
  }

  function isPayrollAdmin(req) {
    const role = String((req.session.user && req.session.user.role) || '');
    return role === '1' || role === '99';
  }

  function waiverEmployeeId(form) {
    return parseInt(form && form.employee_id, 10) || 0;
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

  async function loadWaivers(fid, employeeId) {
    const empty = { rows: [], map: {} };
    try {
      const [rows] = await pool.query(
        `SELECT id, facility_id, employee_id, violation_key, violation_code,
                amount, max_amount, reason, note, rule_text, created_by,
                created_by_name, created_at, revoked_at
           FROM tbl_hms_payroll_optimizer_waiver
          WHERE facility_id = ? AND employee_id = ? AND revoked_at IS NULL
          ORDER BY id DESC
          LIMIT 60`,
        [fid, employeeId]
      );
      const activeRows = rows || [];
      const map = {};
      for (const row of activeRows) {
        if (!map[row.violation_key]) map[row.violation_key] = row;
      }
      return { rows: activeRows, map };
    } catch (err) {
      // The optimizer remains usable while the waiver table is being created.
      return empty;
    }
  }

  async function loadWaiverHistory(fid, employeeId, limit = 12) {
    const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 200);
    try {
      const [rows] = await pool.query(
        `SELECT id, violation_key, violation_code, amount, max_amount, reason,
                note, created_by_name, created_at, revoked_at, revoked_reason
           FROM tbl_hms_payroll_optimizer_waiver
          WHERE facility_id = ? AND employee_id = ?
          ORDER BY id DESC
          LIMIT ${cappedLimit}`,
        [fid, employeeId]
      );
      return rows || [];
    } catch (err) {
      return [];
    }
  }

  async function revokeStaleWaivers(rows, evaluation) {
    const applied = new Set(
      (evaluation && evaluation.appliedWaiverIds ? evaluation.appliedWaiverIds : []).map((id) =>
        Number(id)
      )
    );
    const staleIds = (rows || [])
      .filter((row) => !applied.has(Number(row.id)))
      .map((row) => Number(row.id))
      .filter((id) => id > 0);
    if (!staleIds.length) return;
    await pool
      .query(
        `UPDATE tbl_hms_payroll_optimizer_waiver
            SET revoked_at = NOW(),
                revoked_reason = 'Auto-revoked: amount or ceiling changed'
          WHERE id IN (?) AND revoked_at IS NULL`,
        [staleIds]
      )
      .catch(() => {});
  }

  async function buildModel(req, form, settings, options = {}) {
    const fid = facilityId(req);
    const employeeId = waiverEmployeeId(form);
    normalizeSalaryBasis(form, settings);
    const input = withSettings(form, settings);
    const result = optimizer.computePayroll(input);
    const waivers = await loadWaivers(fid, employeeId);
    const evaluation = optimizer.validatePayroll(input, result, waivers.map);
    if (options.revokeStale !== false) {
      await revokeStaleWaivers(waivers.rows, evaluation);
    }

    let proposal = null;
    let proposalEvaluation = null;
    if (options.optimize && !evaluation.hasBlocking) {
      proposal = optimizer.optimizePayroll(input);
      proposalEvaluation = optimizer.validatePayroll(
        {
          ...input,
          baseSalary: proposal.allocBase,
          allowances: proposal.allocation,
          profile: proposal.profile,
        },
        proposal.after,
        {}
      );
    }

    return {
      input,
      result,
      evaluation,
      proposal,
      proposalEvaluation,
      waiverRows: waivers.rows,
      waiverHistory: await loadWaiverHistory(fid, employeeId),
    };
  }

  function resultLocals(model, options = {}) {
    return {
      result: model.result,
      evaluation: model.evaluation,
      proposal: model.proposal,
      proposalEvaluation: model.proposalEvaluation,
      waiverRows: model.waiverRows || [],
      waiverHistory: model.waiverHistory || [],
      waiverReasons: optimizer.WAIVER_REASONS,
      mode: options.mode || DEFAULT_FORM.mode,
      notice: options.notice || null,
    };
  }

  function renderResults(res, model, options = {}) {
    return new Promise((resolve, reject) => {
      res.render('partials/payroll-optimizer-results', resultLocals(model, options), (err, html) => {
        if (err) return reject(err);
        resolve(html);
      });
    });
  }

  function render(req, res, options = {}) {
    const form = options.form || DEFAULT_FORM;
    const settings = options.settings || {};
    const employee = options.employee || null;
    const model = options.model || null;
    const preview = model
      ? model.result
      : optimizer.computePayroll(withSettings(form, settings));
    res.render('payroll-optimizer', {
      title: 'Payroll Optimizer — ZAIZENS PAY',
      payNavActive: 'optimizer',
      form,
      settings,
      employee,
      employees: options.employees || [],
      result: model ? model.result : null,
      evaluation: model ? model.evaluation : null,
      proposal: model ? model.proposal : null,
      proposalEvaluation: model ? model.proposalEvaluation : null,
      waiverRows: model ? model.waiverRows : [],
      waiverHistory: model ? model.waiverHistory : [],
      waiverReasons: optimizer.WAIVER_REASONS,
      caps: preview.caps,
      profile: preview.profile,
      preview,
      mode: form.mode || DEFAULT_FORM.mode,
      notice: options.notice || null,
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

  app.get('/payroll/optimizer/report', requireAuth, requirePayrollAccess, async (req, res) => {
    try {
      const settings = await loadSettings(facilityId(req));
      const form = parseForm(req.query);
      const employee = await loadEmployeeForm(req, form.employee_id);
      if (!employee) {
        return res.status(400).render('error', {
          title: 'Select an employee',
          message: 'Choose an employee before printing an optimizer compliance report.',
          status: 400,
        });
      }
      const fid = facilityId(req);
      const model = await buildModel(req, form, settings, { optimize: true, revokeStale: false });
      const waiverHistory = await loadWaiverHistory(fid, waiverEmployeeId(form), 200);
      res.render('payroll-optimizer-report', {
        title: `Optimizer Compliance Report — ${employee.name}`,
        employee,
        form,
        settings,
        result: model.result,
        evaluation: model.evaluation,
        proposal: model.proposal,
        proposalEvaluation: model.proposalEvaluation,
        waiverHistory,
        waiverReasons: optimizer.WAIVER_REASONS,
        exportHref: req.originalUrl.replace(
          '/payroll/optimizer/report',
          '/payroll/optimizer/report.csv'
        ),
        reportDate: new Date().toLocaleString('fr-FR', {
          day: '2-digit',
          month: 'long',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
      });
    } catch (err) {
      console.error('PAYROLL OPTIMIZER REPORT:', err.message);
      res.status(500).render('error', {
        title: 'Error',
        message: err.message,
        status: 500,
      });
    }
  });

  app.get('/payroll/optimizer/report.csv', requireAuth, requirePayrollAccess, async (req, res) => {
    try {
      const settings = await loadSettings(facilityId(req));
      const form = parseForm(req.query);
      const employee = await loadEmployeeForm(req, form.employee_id);
      if (!employee) {
        return res
          .status(400)
          .type('text/plain')
          .send('Choose an employee before exporting an optimizer compliance report.');
      }

      const fid = facilityId(req);
      const model = await buildModel(req, form, settings, { optimize: true, revokeStale: false });
      const waiverHistory = await loadWaiverHistory(fid, waiverEmployeeId(form), 200);
      const result = model.result;
      const evaluation = model.evaluation;
      const proposal = model.proposal;
      const proposalEvaluation = model.proposalEvaluation;
      const labelFor = {
        transport: 'Transport',
        representation: 'Representation',
        housing: 'Housing',
        electricity: 'Electricity',
        water: 'Water',
        meal: 'Meal',
        dirtiness: 'Dirtiness',
        clothing: 'Work clothing',
        tools: 'Tools',
        other: 'Other allowances',
      };
      const entryLabels = {
        base: 'Base salary entered',
        gross: 'Gross salary entered',
        net: 'Net salary entered',
      };
      const modeLabels = {
        employee: 'Employee net pay',
        employer: 'Employer cost',
        both: 'Employee + employer',
      };
      const status = evaluation.hasBlocking
        ? 'Blocked'
        : evaluation.waivedCount
          ? 'Compliant with waivers'
          : 'Compliant';
      const reportDate = new Date().toLocaleString('fr-FR', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const lines = [];

      lines.push(csvRow(['Payroll Optimizer - Compliance & Waiver Audit']));
      lines.push(csvRow(['Employee', employee.name]));
      lines.push(csvRow(['Matricule', employee.matricule || employee.id]));
      lines.push(csvRow(['Sector', result.profile.sectorLabel]));
      lines.push(csvRow(['CNPS regime', result.profile.regimeLabel]));
      lines.push(csvRow(['Occupational risk', result.profile.riskLabel]));
      lines.push(csvRow(['Salary entry', entryLabels[form.entryMode] || entryLabels.base]));
      if (form.entryMode !== 'base') {
        lines.push(csvRow(['Entered target (XAF)', csvAmount(form.salaryTarget)]));
      }
      lines.push(csvRow(['Base salary (XAF)', csvAmount(form.baseSalary)]));
      lines.push(csvRow(['Gross cash (XAF)', csvAmount(result.grossCash)]));
      lines.push(csvRow(['Net pay (XAF)', csvAmount(result.netPay)]));
      lines.push(csvRow(['Compliance status', status]));
      lines.push(csvRow(['Report generated', reportDate]));

      lines.push('');
      lines.push(csvRow(['Payroll summary']));
      lines.push(csvRow(['Metric', 'Amount (XAF)']));
      lines.push(csvRow(['Gross cash', csvAmount(result.grossCash)]));
      lines.push(csvRow(['Gross taxable', csvAmount(result.grossTaxable)]));
      lines.push(csvRow(['CNPS contributory base', csvAmount(result.cnpsBase)]));
      lines.push(csvRow(['Net pay', csvAmount(result.netPay)]));
      lines.push(csvRow(['Employee deductions', csvAmount(result.employeeDeductions)]));
      lines.push(csvRow(['Employer contributions', csvAmount(result.employerContributions)]));
      lines.push(csvRow(['Total employer cost', csvAmount(result.totalEmployerCost)]));
      lines.push(csvRow(['Unresolved exceptions', evaluation.blocking.length]));

      lines.push('');
      lines.push(csvRow(['Compliance checks']));
      lines.push(
        csvRow([
          'Code',
          'Severity',
          'Exception',
          'Message',
          'Rule',
          'Amount (XAF)',
          'Ceiling (XAF)',
          'Excess (XAF)',
          'Status',
          'Waiver reason',
          'Waiver note',
        ])
      );
      const violations = evaluation.violations || [];
      if (!violations.length) {
        lines.push(csvRow(['No statutory exception was detected for this scenario.']));
      } else {
        violations.forEach((violation) => {
          const waiver = violation.waiver || {};
          const violationStatus = violation.waived
            ? 'Waived'
            : violation.blocking
              ? 'Unresolved'
              : 'Informational';
          lines.push(
            csvRow([
              violation.code,
              violation.severity,
              violation.title,
              violation.message,
              violation.rule,
              csvAmount(violation.amount),
              violation.max != null ? csvAmount(violation.max) : '',
              violation.excess > 0 ? csvAmount(violation.excess) : '',
              violationStatus,
              violation.waived
                ? optimizer.WAIVER_REASONS[waiver.reason] || waiver.reason || 'Approved'
                : '',
              violation.waived ? waiver.note || '' : '',
            ])
          );
        });
      }

      lines.push('');
      lines.push(csvRow(['Pay structure']));
      lines.push(csvRow(['Component', 'Amount (XAF)', 'Statutory ceiling']));
      lines.push(
        csvRow([
          'Base salary',
          csvAmount(form.baseSalary),
          `${csvAmount(result.profile.smig)} minimum`,
        ])
      );
      optimizer.ALLOWANCE_KEYS.forEach((key) => {
        const amount = csvAmount(result.allowances[key]);
        if (!amount) return;
        const ceiling =
          key === 'transport' || key === 'representation'
            ? '400000 combined'
            : key === 'other'
              ? 'Fully taxable'
              : csvAmount(result.caps[key]);
        lines.push(csvRow([labelFor[key], amount, ceiling]));
      });
      lines.push(csvRow(['Total gross cash', csvAmount(result.grossCash), '']));

      lines.push('');
      lines.push(csvRow(['Optimization comparison']));
      if (!proposal) {
        lines.push(
          csvRow([
            'Optimization is unavailable while this scenario has unresolved statutory exceptions.',
          ])
        );
      } else {
        lines.push(
          csvRow([
            'Proposed composition',
            'Current (XAF)',
            'Optimized (XAF)',
            'Change (XAF)',
            'Legal ceiling',
          ])
        );
        lines.push(
          csvRow([
            'Base salary',
            csvAmount(form.baseSalary),
            csvAmount(proposal.allocBase),
            csvAmount(proposal.allocBase - form.baseSalary),
            `${csvAmount(proposal.profile.smig)} minimum`,
          ])
        );
        optimizer.ALLOWANCE_KEYS.forEach((key) => {
          const currentAmount = csvAmount(result.allowances[key]);
          const optimizedAmount = csvAmount(proposal.allocation[key]);
          if (!currentAmount && !optimizedAmount) return;
          const ceiling =
            key === 'transport' || key === 'representation'
              ? '400000 combined'
              : key === 'other'
                ? 'Fully taxable'
                : csvAmount(proposal.after.caps[key]);
          lines.push(
            csvRow([
              labelFor[key],
              currentAmount,
              optimizedAmount,
              csvAmount(optimizedAmount - currentAmount),
              ceiling,
            ])
          );
        });
        lines.push(
          csvRow([
            'Total gross cash',
            csvAmount(result.grossCash),
            csvAmount(proposal.after.grossCash),
            csvAmount(proposal.after.grossCash - result.grossCash),
            '',
          ])
        );

        lines.push('');
        lines.push(csvRow(['Payroll impact', 'Current (XAF)', 'Optimized (XAF)', 'Change (XAF)']));
        [
          ['Gross taxable', result.grossTaxable, proposal.after.grossTaxable],
          ['CNPS contributory base', result.cnpsBase, proposal.after.cnpsBase],
          ['Employee deductions', result.employeeDeductions, proposal.after.employeeDeductions],
          ['Net pay', result.netPay, proposal.after.netPay],
          ['Employer contributions', result.employerContributions, proposal.after.employerContributions],
          ['Total employer cost', result.totalEmployerCost, proposal.after.totalEmployerCost],
        ].forEach(([label, currentValue, optimizedValue]) => {
          lines.push(
            csvRow([
              label,
              csvAmount(currentValue),
              csvAmount(optimizedValue),
              csvAmount(optimizedValue - currentValue),
            ])
          );
        });

        lines.push('');
        lines.push(csvRow(['Optimization summary', 'Amount (XAF)']));
        lines.push(csvRow(['Net pay change', csvAmount(proposal.savings.netPay)]));
        lines.push(
          csvRow(['Employee deduction change', csvAmount(proposal.savings.employeeDeductions)])
        );
        lines.push(csvRow(['Employer cost change', csvAmount(-proposal.savings.employerCost)]));
        lines.push(csvRow(['Total burden saving', csvAmount(proposal.savings.totalBurden)]));
        lines.push(csvRow(['Optimization focus', modeLabels[form.mode] || modeLabels.both]));
        lines.push(
          csvRow([
            'Proposal status',
            proposalEvaluation && proposalEvaluation.hasBlocking
              ? 'Review only - proposal still has a blocking exception'
              : 'Advisory proposal',
          ])
        );
        lines.push(
          csvRow([
            'Note',
            'The proposal is advisory and has not been applied to the employee pay profile.',
          ])
        );
      }

      lines.push('');
      lines.push(csvRow(['Waiver audit trail']));
      lines.push(
        csvRow([
          'Recorded',
          'Exception',
          'Code',
          'Amount (XAF)',
          'Ceiling (XAF)',
          'Reason',
          'Note',
          'Recorded by',
          'Status',
          'Revoked at',
          'Revocation reason',
        ])
      );
      if (!waiverHistory.length) {
        lines.push(csvRow(['No waiver has been recorded for this employee.']));
      } else {
        waiverHistory.forEach((waiver) => {
          lines.push(
            csvRow([
              csvDate(waiver.created_at),
              String(waiver.violation_key || '').replace(/_/g, ' '),
              waiver.violation_code || '',
              csvAmount(waiver.amount),
              csvAmount(waiver.max_amount),
              optimizer.WAIVER_REASONS[waiver.reason] || waiver.reason || '',
              waiver.note || '',
              waiver.created_by_name || 'Payroll user',
              waiver.revoked_at ? 'Revoked' : 'Active',
              waiver.revoked_at ? csvDate(waiver.revoked_at) : '',
              waiver.revoked_reason || '',
            ])
          );
        });
      }

      lines.push('');
      lines.push(
        csvRow([
          'This report is an advisory compliance snapshot. It does not create or modify payroll records, pay profiles or posted payroll runs.',
        ])
      );
      if (evaluation.hasBlocking) {
        lines.push(
          csvRow(['This scenario remains blocked by unresolved statutory exceptions.'])
        );
      }

      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const safeMatricule = String(employee.matricule || employee.id).replace(
        /[^a-z0-9_-]+/gi,
        '_'
      );
      const filename = `optimizer_compliance_${safeMatricule}_${stamp}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send('\uFEFF' + lines.join('\r\n'));
    } catch (err) {
      console.error('PAYROLL OPTIMIZER CSV:', err.message);
      res.status(500).type('text/plain').send(err.message);
    }
  });

  app.post('/payroll/optimizer/run', requireAuth, requirePayrollAccess, async (req, res) => {
    try {
      const settings = await loadSettings(facilityId(req));
      let form = parseForm(req.body);
      const employee = await loadEmployeeForm(req, form.employee_id);
      const employees = await loadEmployees(req);
      const action = clean((req.body || {}).action, 20) || 'calculate';

      let model = await buildModel(req, form, settings, {
        optimize: action === 'optimize' || action === 'apply',
      });
      let notice = null;

      if (action === 'apply' && model.proposal && !model.evaluation.hasBlocking) {
        const proposal = model.proposal;
        form = {
          ...form,
          baseSalary: proposal.allocBase,
          ...proposal.allocation,
          entryMode: 'base',
          salaryTarget: 0,
        };
        notice = `The proposed structure was loaded into the form. Nothing was saved to payroll records.`;
        model = await buildModel(req, form, settings, { optimize: false });
      }

      render(req, res, { form, settings, employee, employees, model, notice });
    } catch (err) {
      console.error('PAYROLL OPTIMIZER POST:', err.message);
      res.status(500).render('error', {
        title: 'Error',
        message: err.message,
        status: 500,
      });
    }
  });

  app.post('/payroll/optimizer/live', requireAuth, requirePayrollAccess, async (req, res) => {
    try {
      const settings = await loadSettings(facilityId(req));
      const form = parseForm(req.body);
      const action = clean((req.body || {}).action, 20) || 'calculate';
      const model = await buildModel(req, form, settings, {
        optimize: action === 'optimize',
      });
      const html = await renderResults(res, model, { mode: form.mode });
      res.json({
        ok: true,
        html,
        blocked: model.evaluation.hasBlocking,
        fieldErrors: model.evaluation.fieldErrors,
        caps: model.result.caps,
        profile: model.result.profile,
        hasProposal: Boolean(model.proposal),
        baseSalary: form.baseSalary,
        entryMode: form.entryMode,
        salaryTarget: form.salaryTarget,
        grossCash: model.result.grossCash,
        netPay: model.result.netPay,
      });
    } catch (err) {
      console.error('PAYROLL OPTIMIZER LIVE:', err.message);
      res.status(500).json({ ok: false, error: 'Could not recalculate the payroll scenario.' });
    }
  });

  app.post('/payroll/optimizer/waive', requireAuth, requirePayrollAccess, async (req, res) => {
    try {
      const settings = await loadSettings(facilityId(req));
      let form = parseForm(req.body);
      const key = clean((req.body || {}).violation_key, 40);
      const reason = clean((req.body || {}).waiver_reason, 24).toLowerCase();
      const note = clean((req.body || {}).waiver_note, 500);
      if (!key || !optimizer.WAIVER_REASONS[reason]) {
        return res.status(400).json({ ok: false, error: 'Choose a valid waiver reason.' });
      }
      if (reason === 'other' && !note) {
        return res.status(400).json({ ok: false, error: 'A note is required for an “Other” waiver.' });
      }

      const fid = facilityId(req);
      const employeeId = waiverEmployeeId(form);
      if (employeeId > 0 && !(await loadEmployeeForm(req, employeeId))) {
        return res.status(400).json({ ok: false, error: 'The selected employee is not available in this facility.' });
      }
      normalizeSalaryBasis(form, settings);
      const input = withSettings(form, settings);
      const result = optimizer.computePayroll(input);
      const active = await loadWaivers(fid, employeeId);
      const evaluation = optimizer.validatePayroll(input, result, active.map);
      const violation = evaluation.violations.find(
        (v) => v.key === key && v.blocking && !v.waived
      );
      if (!violation) {
        return res.status(400).json({
          ok: false,
          error: 'This exception is no longer active. Recalculate and try again.',
        });
      }
      if (!violation.waivable) {
        return res.status(400).json({
          ok: false,
          error: 'Critical statutory breaches cannot be waived. Correct the amount to continue.',
        });
      }

      const uid = sessionEmpId(req);
      const actor = sessionEmpName(req);
      await pool.query(
        `UPDATE tbl_hms_payroll_optimizer_waiver
            SET revoked_at = NOW(), revoked_by = ?,
                revoked_reason = 'Superseded by a new waiver'
          WHERE facility_id = ? AND employee_id = ? AND violation_key = ?
            AND revoked_at IS NULL`,
        [uid, fid, employeeId, key]
      );
      await pool.query(
        `INSERT INTO tbl_hms_payroll_optimizer_waiver
           (facility_id, employee_id, violation_key, violation_code, amount,
            max_amount, reason, note, rule_text, created_by, created_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fid,
          employeeId,
          key,
          violation.code,
          violation.amount,
          violation.max,
          reason,
          note,
          clean(violation.rule, 500),
          uid,
          actor,
        ]
      );

      const model = await buildModel(req, form, settings, { optimize: false });
      const html = await renderResults(res, model, { mode: form.mode });
      res.json({
        ok: true,
        html,
        blocked: model.evaluation.hasBlocking,
        fieldErrors: model.evaluation.fieldErrors,
        caps: model.result.caps,
        profile: model.result.profile,
        baseSalary: form.baseSalary,
        entryMode: form.entryMode,
        salaryTarget: form.salaryTarget,
        grossCash: model.result.grossCash,
        netPay: model.result.netPay,
      });
    } catch (err) {
      console.error('PAYROLL OPTIMIZER WAIVE:', err.message);
      res.status(500).json({ ok: false, error: 'Could not record the waiver.' });
    }
  });

  app.post('/payroll/optimizer/revoke', requireAuth, requirePayrollAccess, async (req, res) => {
    try {
      const settings = await loadSettings(facilityId(req));
      const form = parseForm(req.body);
      const waiverId = parseInt((req.body || {}).waiver_id, 10) || 0;
      const fid = facilityId(req);
      if (!waiverId) {
        return res.status(400).json({ ok: false, error: 'Missing waiver to revoke.' });
      }
      await pool.query(
        `UPDATE tbl_hms_payroll_optimizer_waiver
            SET revoked_at = NOW(), revoked_by = ?,
                revoked_reason = 'Revoked by payroll user'
          WHERE id = ? AND facility_id = ? AND revoked_at IS NULL`,
        [sessionEmpId(req), waiverId, fid]
      );
      const model = await buildModel(req, form, settings, { optimize: false });
      const html = await renderResults(res, model, { mode: form.mode });
      res.json({
        ok: true,
        html,
        blocked: model.evaluation.hasBlocking,
        fieldErrors: model.evaluation.fieldErrors,
        caps: model.result.caps,
        profile: model.result.profile,
        baseSalary: form.baseSalary,
        entryMode: form.entryMode,
        salaryTarget: form.salaryTarget,
        grossCash: model.result.grossCash,
        netPay: model.result.netPay,
      });
    } catch (err) {
      console.error('PAYROLL OPTIMIZER REVOKE:', err.message);
      res.status(500).json({ ok: false, error: 'Could not revoke the waiver.' });
    }
  });
};
