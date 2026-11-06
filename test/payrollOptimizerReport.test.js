'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerPayrollOptimizerRoutes = require('../routes/payrollOptimizer');
const { makeApp, withApp, request, fakePool } = require('./helpers/app');

function reportPool() {
  return fakePool((sql) => {
    if (sql.includes('FROM tbl_hms_payroll_settings')) {
      return [[{ default_sector: 'general', cnps_regime: 1 }]];
    }
    if (sql.includes('LEFT JOIN tbl_hms_pay_profile pp')) {
      return [[{
        employee_pk: 42,
        first_name: 'Ada',
        last_name: 'Ngono',
        matricule: 'EMP-42',
        role: 'Doctor',
        sector: 'general',
        basic_salary: 450000,
        housing_allowance: 0,
        transport_allowance: 30000,
        other_allowances: 0,
      }]];
    }
    if (sql.includes('FROM tbl_hms_payroll_optimizer_waiver')) {
      if (sql.includes('revoked_at IS NULL')) return [[]];
      return [[{
        id: 9,
        violation_key: 'prof_cap',
        violation_code: 'PROF_CAP_BREACH',
        amount: 500000,
        max_amount: 400000,
        reason: 'management',
        note: 'Approved by management',
        created_by_name: 'Test Admin',
        created_at: '2026-10-01T09:00:00.000Z',
        revoked_at: null,
        revoked_reason: '',
      }]];
    }
    return [[]];
  });
}

test('optimizer CSV report includes salary, comparison and waiver audit sections', async () => {
  await withApp(makeApp(registerPayrollOptimizerRoutes, reportPool()), async (base) => {
    const res = await request(
      base,
      '/payroll/optimizer/report.csv?employee_id=42&baseSalary=450000&sector=general&regime=1&risk=medium&entryMode=base&transport=30000&meal=1000'
    );

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(
      res.headers.get('content-disposition'),
      /optimizer_compliance_EMP-42_\d{8}\.csv/
    );
    assert.match(res.text, /^\uFEFF?Payroll Optimizer - Compliance & Waiver Audit/);
    assert.match(res.text, /Employee;Ada Ngono/);
    assert.match(res.text, /Matricule;EMP-42/);
    assert.match(res.text, /Compliance status;Compliant/);
    assert.match(res.text, /Payroll summary/);
    assert.match(res.text, /Optimization comparison/);
    assert.match(res.text, /Net pay change/);
    assert.match(res.text, /Waiver audit trail/);
    assert.match(res.text, /Management approval/);
    assert.match(res.text, /Approved by management/);
    assert.match(res.text, /Active/);
    assert.match(res.text, /This report is an advisory compliance snapshot/);
  });
});

test('optimizer CSV report marks blocked scenarios and omits the proposal', async () => {
  await withApp(makeApp(registerPayrollOptimizerRoutes, reportPool()), async (base) => {
    const res = await request(
      base,
      '/payroll/optimizer/report.csv?employee_id=42&baseSalary=50000&sector=general&regime=1&risk=medium&entryMode=base'
    );

    assert.equal(res.status, 200);
    assert.match(res.text, /Compliance status;Blocked/);
    assert.match(res.text, /Optimization is unavailable/);
    assert.match(res.text, /This scenario remains blocked by unresolved statutory exceptions/);
    assert.doesNotMatch(res.text, /Optimization summary;Amount/);
  });
});
