'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerHrPayrollRoutes = require('../routes/hrPayroll');
const { DEFAULT_IRPP_BRACKETS, parseBrackets } = require('../lib/hmsPayrollCameroon');
const { logAdminAction } = require('../lib/adminAudit');
const { makeApp, withApp, request, fakePool } = require('./helpers/app');

function profileRow(overrides = {}) {
  return {
    basic_salary: 0,
    housing_allowance: 0,
    transport_allowance: 0,
    other_allowances: 0,
    medical_risk_allowance: 0,
    responsibility_allowance: 0,
    is_specialist: 0,
    night_shifts_per_month: 0,
    on_call_per_month: 0,
    ...overrides,
  };
}

function saveBody(overrides = {}) {
  return new URLSearchParams({
    basic_1228: '100000',
    housing_1228: '10000',
    transport_1228: '5000',
    other_1228: '2000',
    med_risk_1228: '1',
    responsibility_1228: '2',
    is_specialist_1228: '1',
    night_shifts_1228: '3',
    on_call_1228: '4',
    facility_sector: 'medical',
    ...overrides,
  });
}

test('payroll audit page applies facility, employee, action and date filters', async () => {
  const filteredParams = [];
  const queries = [];
  const pool = fakePool((sql, params) => {
    queries.push(String(sql));
    if (sql.includes('SELECT DISTINCT e.id')) {
      return [[{ id: 1228, first_name: 'Amina', last_name: 'Njoya', employee_id: 'EMP-1228' }]];
    }
    if (sql.includes('GROUP BY a.action')) {
      return [[
        { action: 'payroll.profile_save', entry_count: 1 },
        { action: 'payroll.salary_delete', entry_count: 1 },
      ]];
    }
    if (sql.includes('SELECT COUNT(*) AS total')) {
      filteredParams.push(params);
      return [[{ total: 2 }]];
    }
    if (sql.includes('SELECT a.id, a.created_at')) {
      filteredParams.push(params);
      return [[
        {
          id: 2,
          created_at: '2026-11-06T10:00:00.000Z',
          actor_name: 'Test Admin',
          action: 'payroll.salary_delete',
          target_type: 'employee',
          target_id: '1228',
          detail: 'Deleted payroll record for Amina Njoya — November 2026.',
          first_name: 'Amina',
          last_name: 'Njoya',
          matricule: 'EMP-1228',
        },
        {
          id: 1,
          created_at: '2026-11-06T09:00:00.000Z',
          actor_name: 'Test Admin',
          action: 'payroll.profile_save',
          target_type: 'employee',
          target_id: '1228',
          detail: 'Manual pay-profile save.',
          first_name: 'Amina',
          last_name: 'Njoya',
          matricule: 'EMP-1228',
        },
      ]];
    }
    return [[]];
  });

  await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
    const res = await request(
      base,
      '/payroll/audit?employee=1228&action=payroll.profile_save&from=2026-11-01&to=2026-11-30'
    );

    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.view, 'payroll-audit');
    assert.equal(body.locals.total, 2);
    assert.deepEqual(body.locals.filters, {
      employee: 1228,
      action: 'payroll.profile_save',
      from: '2026-11-01',
      to: '2026-11-30',
    });
    assert.equal(body.locals.filterError, '');
    assert.equal(body.locals.auditRows.length, 2);
    assert.equal(body.locals.actionOptions.length, 2);
    assert.equal(body.locals.employeeOptions[0].matricule || body.locals.employeeOptions[0].employee_id, 'EMP-1228');
    assert.deepEqual(filteredParams, [
      [1, 1, '1228', 'payroll.profile_save', '2026-11-01', '2026-11-30'],
      [1, 1, '1228', 'payroll.profile_save', '2026-11-01', '2026-11-30'],
    ]);
    const employeeQuery = queries.find((sql) => sql.includes('SELECT DISTINCT e.id'));
    const actionQuery = queries.find((sql) => sql.includes('GROUP BY a.action'));
    const trailQuery = queries.find((sql) => sql.includes('SELECT a.id, a.created_at'));
    assert.match(employeeQuery, /a\.facility_id = \?/);
    assert.match(employeeQuery, /default_facility_id IS NULL OR e\.default_facility_id = \?/);
    assert.match(actionQuery, /LEFT JOIN tbl_employee e/);
    assert.match(actionQuery, /a\.facility_id = \?/);
    assert.match(trailQuery, /LEFT JOIN tbl_employee e/);
    assert.match(trailQuery, /a\.facility_id = \?/);
  });
});

test('payroll audit includes non-employee actions scoped by facility_id', async () => {
  const filteredParams = [];
  const queries = [];
  const pool = fakePool((sql, params) => {
    queries.push(String(sql));
    if (sql.includes('SELECT DISTINCT e.id')) return [[]];
    if (sql.includes('GROUP BY a.action')) {
      return [[{ action: 'payroll.settings_save', entry_count: 1 }]];
    }
    if (sql.includes('SELECT COUNT(*) AS total')) {
      filteredParams.push(params);
      return [[{ total: 1 }]];
    }
    if (sql.includes('SELECT a.id, a.created_at')) {
      filteredParams.push(params);
      return [[{
        id: 3,
        created_at: '2026-11-06T11:00:00.000Z',
        actor_name: 'Test Admin',
        action: 'payroll.settings_save',
        target_type: 'facility',
        target_id: '1',
        detail: 'Saved payroll settings for Facility 1.',
        facility_id: 1,
        first_name: null,
        last_name: null,
        matricule: null,
      }]];
    }
    return [[]];
  });

  await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
    const res = await request(base, '/payroll/audit');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.locals.total, 1);
    assert.equal(body.locals.auditRows.length, 1);
    assert.equal(body.locals.auditRows[0].facility_id, 1);
    assert.equal(body.locals.auditRows[0].target_type, 'facility');
    assert.deepEqual(filteredParams, [[1, 1], [1, 1]]);
    const trailQuery = queries.find((sql) => sql.includes('SELECT a.id, a.created_at'));
    assert.match(trailQuery, /LEFT JOIN tbl_employee e/);
    assert.match(trailQuery, /a\.facility_id = \?/);
  });
});

test('admin audit writes the session facility', async () => {
  let captured = null;
  const pool = {
    query: async (sql, params) => {
      captured = { sql: String(sql), params };
      return [{}];
    },
  };
  const req = {
    session: { user: { id: 7, name: 'Test Admin' }, facilityId: 42 },
    headers: {},
    ip: '127.0.0.1',
    socket: {},
  };

  await logAdminAction(pool, req, 'payroll.settings_save', {
    targetType: 'facility',
    targetId: 42,
    detail: 'Saved payroll settings.',
  });

  assert.match(captured.sql, /facility_id/);
  assert.equal(captured.params[7], 42);
});

test('manual pay-profile saves audit only changed profiles', async () => {
  const profile = profileRow();
  const audits = [];
  const pool = fakePool((sql, params) => {
    if (sql.includes('SELECT id, joining_date FROM tbl_employee')) {
      return [[{ id: 1228, joining_date: '2024-01-01' }]];
    }
    if (sql.includes('SELECT employee_id, basic_salary') && sql.includes('employee_id IN')) {
      return [[{ employee_id: 1228, ...profile }]];
    }
    if (sql.includes('INSERT INTO tbl_hms_pay_profile')) {
      const [facilityId, employeeId, basic, housing, transport, other, medRisk, responsibility, specialist, hireDate, sector, nightShifts, onCall] = params;
      Object.assign(profile, {
        basic_salary: basic,
        housing_allowance: housing,
        transport_allowance: transport,
        other_allowances: other,
        medical_risk_allowance: medRisk ?? 0,
        responsibility_allowance: responsibility ?? 0,
        is_specialist: specialist ?? 0,
        night_shifts_per_month: nightShifts ?? 0,
        on_call_per_month: onCall ?? 0,
      });
      assert.equal(facilityId, 1);
      assert.equal(employeeId, 1228);
      assert.ok(hireDate);
      assert.ok(sector);
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('SELECT basic_salary, housing_allowance') && sql.includes('employee_id = ? LIMIT 1')) {
      return [[profile]];
    }
    if (sql.includes('INSERT INTO tbl_admin_audit')) {
      audits.push({ action: params[2], targetType: params[3], targetId: params[4], detail: params[5] });
      return [{ affectedRows: 1 }];
    }
    return [[]];
  });

  await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
    const first = await request(base, '/payroll/profiles/save', {
      method: 'POST',
      body: saveBody(),
    });
    assert.equal(first.status, 302);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'payroll.profile_save');
    assert.equal(audits[0].targetType, 'employee');
    assert.equal(audits[0].targetId, '1228');
    assert.match(audits[0].detail, /Manual pay-profile save/);
    assert.match(audits[0].detail, /Basic 100,000/);
    assert.match(audits[0].detail, /Other 2,000/);
    assert.match(audits[0].detail, /Specialist yes, Night shifts 3, On-call 4/);
    assert.match(audits[0].detail, /Previous: Basic 0/);

    const noChange = await request(base, '/payroll/profiles/save', {
      method: 'POST',
      body: saveBody(),
    });
    assert.equal(noChange.status, 302);
    assert.equal(audits.length, 1, 'unchanged save must not create another audit entry');

    const changed = await request(base, '/payroll/profiles/save', {
      method: 'POST',
      body: saveBody({ basic_1228: '120000' }),
    });
    assert.equal(changed.status, 302);
    assert.equal(audits.length, 2);
    assert.match(audits[1].detail, /Basic 120,000/);
    assert.match(audits[1].detail, /Previous: Basic 100,000/);
  });
});

test('single payroll deletion audits the deleted record', async () => {
  let deleted = false;
  const audits = [];
  const record = {
    year: 2026,
    month: 11,
    employee_id: 1228,
    gross_salary: '111111.00',
    net_salary: '88888.00',
    payout_status: 'pending',
    first_name: 'Super',
    last_name: 'Admin',
  };
  const pool = fakePool((sql, params) => {
    if (sql.includes('FROM tbl_hms_payroll_record r') && sql.includes('WHERE r.id = ?')) {
      return [[record]];
    }
    if (sql.startsWith('DELETE FROM tbl_hms_payroll_record')) {
      const affectedRows = deleted ? 0 : 1;
      deleted = true;
      return [{ affectedRows }];
    }
    if (sql.includes('INSERT INTO tbl_admin_audit')) {
      audits.push({ action: params[2], targetId: params[4], detail: params[5] });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('FROM tbl_facility_integration')) {
      return [[{ enabled: 0 }]];
    }
    return [[]];
  });

  await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
    const res = await request(base, '/payroll/delete-record', {
      method: 'POST',
      body: new URLSearchParams({ payroll_record_id: '501' }),
    });
    assert.equal(res.status, 302);
    const location = decodeURIComponent(res.headers.get('location'));
    assert.match(location, /Payroll record deleted/);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'payroll.salary_delete');
    assert.equal(audits[0].targetId, '1228');
    assert.match(audits[0].detail, /Super Admin/);
    assert.match(audits[0].detail, /November 2026/);
    assert.match(audits[0].detail, /Gross 111,111 XAF, Net 88,888 XAF/);
    assert.match(audits[0].detail, /payout status pending/);
  });
});

test('bulk payroll deletion creates one audit entry per record', async () => {
  const audits = [];
  const records = [
    {
      id: 601,
      year: 2026,
      month: 11,
      employee_id: 1228,
      gross_salary: '100000.00',
      net_salary: '80000.00',
      payout_status: 'pending',
      first_name: 'Amina',
      last_name: 'Njoya',
    },
    {
      id: 602,
      year: 2026,
      month: 12,
      employee_id: 1228,
      gross_salary: '120000.00',
      net_salary: '95000.00',
      payout_status: 'pending',
      first_name: 'Amina',
      last_name: 'Njoya',
    },
  ];
  const pool = fakePool((sql, params) => {
    if (sql.includes('FROM tbl_hms_payroll_record r') && sql.includes('id IN')) {
      return [records];
    }
    if (sql.startsWith('DELETE FROM tbl_hms_payroll_record')) {
      return [{ affectedRows: 2 }];
    }
    if (sql.includes('INSERT INTO tbl_admin_audit')) {
      audits.push({ action: params[2], targetId: params[4], detail: params[5] });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('FROM tbl_facility_integration')) {
      return [[{ enabled: 0 }]];
    }
    return [[]];
  });

  await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
    const res = await request(base, '/payroll/delete-records', {
      method: 'POST',
      body: new URLSearchParams([
        ['payroll_record_ids', '601'],
        ['payroll_record_ids', '602'],
      ]),
    });
    assert.equal(res.status, 302);
    assert.equal(audits.length, 2);
    assert.deepEqual(audits.map((a) => a.action), [
      'payroll.salary_delete',
      'payroll.salary_delete',
    ]);
    assert.deepEqual(audits.map((a) => a.targetId), ['1228', '1228']);
    assert.match(audits[0].detail, /November 2026/);
    assert.match(audits[1].detail, /December 2026/);
  });
});

test('paid payroll deletion is blocked', async () => {
  const audits = [];
  let deleteAttempts = 0;
  const record = {
    year: 2026,
    month: 11,
    employee_id: 1228,
    gross_salary: '100000.00',
    net_salary: '80000.00',
    payout_status: 'paid',
    first_name: 'Amina',
    last_name: 'Njoya',
  };
  const pool = fakePool((sql, params) => {
    if (sql.includes('FROM tbl_hms_payroll_record r') && sql.includes('WHERE r.id = ?')) {
      return [[record]];
    }
    if (sql.startsWith('DELETE FROM tbl_hms_payroll_record')) {
      deleteAttempts += 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('INSERT INTO tbl_admin_audit')) {
      audits.push({ action: params[2], targetId: params[4] });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('FROM tbl_facility_integration')) {
      return [[{ enabled: 0 }]];
    }
    return [[]];
  });

  await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
    const res = await request(base, '/payroll/delete-record', {
      method: 'POST',
      body: new URLSearchParams({ payroll_record_id: '702' }),
    });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get('location')), /Paid payroll records cannot be deleted/);
    assert.equal(deleteAttempts, 0);
    assert.equal(audits.length, 0);
  });
});

test('bulk payroll deletion leaves paid records untouched', async () => {
  const audits = [];
  let deleteSql = '';
  const records = [
    {
      id: 601,
      year: 2026,
      month: 11,
      employee_id: 1228,
      gross_salary: '100000.00',
      net_salary: '80000.00',
      payout_status: 'pending',
      first_name: 'Amina',
      last_name: 'Njoya',
    },
    {
      id: 602,
      year: 2026,
      month: 12,
      employee_id: 1228,
      gross_salary: '120000.00',
      net_salary: '95000.00',
      payout_status: 'paid',
      first_name: 'Amina',
      last_name: 'Njoya',
    },
  ];
  const pool = fakePool((sql, params) => {
    if (sql.includes('FROM tbl_hms_payroll_record r') && sql.includes('id IN')) {
      return [records];
    }
    if (sql.startsWith('DELETE FROM tbl_hms_payroll_record')) {
      deleteSql = sql;
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('INSERT INTO tbl_admin_audit')) {
      audits.push({ action: params[2], targetId: params[4] });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('FROM tbl_facility_integration')) {
      return [[{ enabled: 0 }]];
    }
    return [[]];
  });

  await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
    const res = await request(base, '/payroll/delete-records', {
      method: 'POST',
      body: new URLSearchParams([
        ['payroll_record_ids', '601'],
        ['payroll_record_ids', '602'],
      ]),
    });
    assert.equal(res.status, 302);
    assert.match(deleteSql, /payout_status/);
    assert.equal(audits.length, 1);
    assert.match(decodeURIComponent(res.headers.get('location')), /1 payroll record deleted/);
  });
});

function payrollRunConnection(settingsRow, counters, existingRow = null) {
  return {
    query: async (sql) => {
      if (sql.includes('FROM tbl_hms_pay_profile')) {
        return [[{
          basic_salary: '100000',
          housing_allowance: '0',
          transport_allowance: '0',
          other_allowances: '0',
          medical_risk_allowance: '0',
          responsibility_allowance: '0',
          is_specialist: 0,
          hire_date: null,
          sector: 'medical',
          night_shifts_per_month: 0,
          on_call_per_month: 0,
        }]];
      }
      if (sql.includes('FROM tbl_hms_payroll_record WHERE facility_id = ? AND employee_id = ?')) {
        return [existingRow ? [existingRow] : []];
      }
      if (sql.includes('SELECT * FROM tbl_hms_payroll_settings')) {
        return settingsRow ? [[settingsRow]] : [[]];
      }
      if (sql.startsWith('INSERT INTO tbl_hms_payroll_record')) {
        counters.inserts += 1;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE tbl_hms_payroll_record')) {
        counters.updates = (counters.updates || 0) + 1;
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
    beginTransaction: async () => { counters.begins += 1; },
    commit: async () => { counters.commits += 1; },
    rollback: async () => { counters.rollbacks += 1; },
    release: () => { counters.releases += 1; },
  };
}

function payrollRunPool(conn) {
  return {
    query: async (sql) => {
      if (sql.includes('FROM tbl_employee e') && sql.includes('ORDER BY e.last_name')) {
        return [[{ id: 1228, first_name: 'Amina', last_name: 'Njoya', role: '101', joining_date: '2020-01-01' }]];
      }
      if (sql.includes('FROM tbl_facility_integration')) {
        return [[{ enabled: 0 }]];
      }
      return [[]];
    },
    getConnection: async () => conn,
  };
}

test('payroll run commits generated lines in one transaction', async () => {
  const counters = { begins: 0, commits: 0, rollbacks: 0, releases: 0, inserts: 0 };
  const conn = payrollRunConnection({
    tax_brackets: JSON.stringify([
      { min: 0, max: 166667, rate: 0 },
      { min: 166667, max: 333333, rate: 15 },
      { min: 333333, max: 833333, rate: 25 },
      { min: 833333, max: null, rate: 35 },
    ]),
    cnps_employee_rate: 4.2,
    cimr_employee_rate: 1,
    development_tax_rate: 1,
  }, counters);

  await withApp(makeApp(registerHrPayrollRoutes, payrollRunPool(conn)), async (base) => {
    const res = await request(base, '/payroll/process-month', {
      method: 'POST',
      body: new URLSearchParams({ month: '11', year: '2099' }),
    });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get('location')), /Payroll run: 1 new record/);
    assert.equal(counters.begins, 1);
    assert.equal(counters.commits, 1);
    assert.equal(counters.rollbacks, 0);
    assert.equal(counters.inserts, 1);
    assert.equal(counters.releases, 1);
  });
});

test('payroll run corrects a reversed record in place', async () => {
  const counters = { begins: 0, commits: 0, rollbacks: 0, releases: 0, inserts: 0, updates: 0 };
  const settings = {
    tax_brackets: JSON.stringify([
      { min: 0, max: 166667, rate: 0 },
      { min: 166667, max: 333333, rate: 15 },
      { min: 333333, max: 833333, rate: 25 },
      { min: 833333, max: null, rate: 35 },
    ]),
    cnps_employee_rate: 4.2,
    cimr_employee_rate: 1,
    development_tax_rate: 1,
  };
  const conn = payrollRunConnection(settings, counters, { id: 55, payout_status: 'reversed' });

  await withApp(makeApp(registerHrPayrollRoutes, payrollRunPool(conn)), async (base) => {
    const res = await request(base, '/payroll/process-month', {
      method: 'POST',
      body: new URLSearchParams({ month: '11', year: '2099' }),
    });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get('location')), /1 corrected reversed record/);
    assert.equal(counters.begins, 1);
    assert.equal(counters.commits, 1);
    assert.equal(counters.rollbacks, 0);
    assert.equal(counters.inserts, 0);
    assert.equal(counters.updates, 1);
    assert.equal(counters.releases, 1);
  });
});

test('payroll run rolls back when tax settings are missing', async () => {
  const counters = { begins: 0, commits: 0, rollbacks: 0, releases: 0, inserts: 0 };
  const conn = payrollRunConnection(null, counters);

  await withApp(makeApp(registerHrPayrollRoutes, payrollRunPool(conn)), async (base) => {
    const res = await request(base, '/payroll/process-month', {
      method: 'POST',
      body: new URLSearchParams({ month: '11', year: '2099' }),
    });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get('location')), /Configure payroll tax/);
    assert.equal(counters.begins, 1);
    assert.equal(counters.commits, 0);
    assert.equal(counters.rollbacks, 1);
    assert.equal(counters.inserts, 0);
    assert.equal(counters.releases, 1);
  });
});

test('paid payroll reversal snapshots and marks the record reversed', async () => {
  const state = { snapshot: null, update: null, commits: 0, rollbacks: 0, releases: 0, audits: [] };
  const record = {
    id: 702,
    facility_id: 1,
    employee_id: 1228,
    year: 2026,
    month: 11,
    gross_salary: '100000.00',
    net_salary: '80000.00',
    payout_status: 'paid',
    first_name: 'Amina',
    last_name: 'Njoya',
  };
  const conn = {
    query: async (sql, params) => {
      if (sql.includes('FROM tbl_hms_payroll_record') && sql.includes('FOR UPDATE')) return [[record]];
      if (sql.includes('INSERT INTO tbl_hms_payroll_reversal')) {
        state.snapshot = params;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE tbl_hms_payroll_record')) {
        state.update = params;
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
    beginTransaction: async () => {},
    commit: async () => { state.commits += 1; },
    rollback: async () => { state.rollbacks += 1; },
    release: () => { state.releases += 1; },
  };
  const pool = {
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO tbl_admin_audit')) {
        state.audits.push({ action: params[2], targetId: params[4], detail: params[5] });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('FROM tbl_employee e') && sql.includes('WHERE e.id = ?')) {
        return [[{ first_name: 'Amina', last_name: 'Njoya' }]];
      }
      if (sql.includes('FROM tbl_facility_integration')) return [[{ enabled: 0 }]];
      return [[]];
    },
    getConnection: async () => conn,
  };

  await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
    const res = await request(base, '/payroll/reverse-record', {
      method: 'POST',
      body: new URLSearchParams({
        payroll_record_id: '702',
        reason: 'Incorrect allowance applied',
      }),
    });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get('location')), /Paid record reversed/);
    assert.equal(state.commits, 1);
    assert.equal(state.rollbacks, 0);
    assert.equal(state.releases, 1);
    assert.equal(state.snapshot[0], 702);
    assert.equal(state.snapshot[8], 'Incorrect allowance applied');
    assert.deepEqual(state.update.slice(0, 4), ['Incorrect allowance applied', 7, 702, 1]);
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].action, 'payroll.salary_reverse');
    assert.match(state.audits[0].detail, /Incorrect allowance applied/);
  });
});

test('payroll reversal rejects records that are not paid', async () => {
  const state = { snapshot: false, update: false, commits: 0, rollbacks: 0, releases: 0 };
  const record = {
    id: 703,
    facility_id: 1,
    employee_id: 1228,
    year: 2026,
    month: 11,
    payout_status: 'pending',
  };
  const conn = {
    query: async (sql) => {
      if (sql.includes('FROM tbl_hms_payroll_record') && sql.includes('FOR UPDATE')) return [[record]];
      if (sql.includes('INSERT INTO tbl_hms_payroll_reversal')) state.snapshot = true;
      if (sql.startsWith('UPDATE tbl_hms_payroll_record')) state.update = true;
      return [[]];
    },
    beginTransaction: async () => {},
    commit: async () => { state.commits += 1; },
    rollback: async () => { state.rollbacks += 1; },
    release: () => { state.releases += 1; },
  };
  const pool = {
    query: async () => [[]],
    getConnection: async () => conn,
  };

  await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
    const res = await request(base, '/payroll/reverse-record', {
      method: 'POST',
      body: new URLSearchParams({ payroll_record_id: '703', reason: 'Wrong status' }),
    });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get('location')), /Only paid payroll records can be reversed/);
    assert.equal(state.snapshot, false);
    assert.equal(state.update, false);
    assert.equal(state.commits, 0);
    assert.equal(state.rollbacks, 1);
    assert.equal(state.releases, 1);
  });
});

test('payroll settings accepts saved four-band brackets', async () => {
  const brackets = [
    { min: 0, max: 166667, rate: 0 },
    { min: 166667, max: 333333, rate: 15 },
    { min: 333333, max: 833333, rate: 25 },
    { min: 833333, max: null, rate: 35 },
  ];
  const pool = fakePool((sql) => {
    if (sql.includes('SELECT * FROM tbl_hms_payroll_settings')) {
      return [[{ tax_brackets: JSON.stringify(brackets), default_sector: 'medical' }]];
    }
    if (sql.includes('FROM tbl_facility_integration')) {
      return [[{ enabled: 0 }]];
    }
    return [[]];
  });

  await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
    const res = await request(base, '/payroll/settings');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.view, 'payroll-settings');
    assert.equal(body.locals.brackets.length, 4);
    assert.deepEqual(body.locals.brackets, brackets);
  });
});

test('legacy bracket counts fall back to the statutory four-band scale everywhere', async () => {
  const legacyFiveBand = [
    { min: 0, max: 100000, rate: 5 },
    { min: 100001, max: 200000, rate: 10 },
    { min: 200001, max: 300000, rate: 15 },
    { min: 300001, max: 400000, rate: 25 },
    { min: 400001, max: null, rate: 35 },
  ];
  assert.deepEqual(
    parseBrackets(JSON.stringify(legacyFiveBand)),
    DEFAULT_IRPP_BRACKETS.map((bracket) => ({ ...bracket }))
  );
  assert.deepEqual(
    parseBrackets(JSON.stringify(legacyFiveBand.slice(0, 3))),
    DEFAULT_IRPP_BRACKETS.map((bracket) => ({ ...bracket }))
  );

  const pool = fakePool((sql) => {
    if (sql.includes('SELECT * FROM tbl_hms_payroll_settings')) {
      return [[{ tax_brackets: JSON.stringify(legacyFiveBand), default_sector: 'medical' }]];
    }
    if (sql.includes('FROM tbl_facility_integration')) {
      return [[{ enabled: 0 }]];
    }
    return [[]];
  });

  await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
    const res = await request(base, '/payroll/settings');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.deepEqual(
      body.locals.brackets,
      DEFAULT_IRPP_BRACKETS.map((bracket) => ({ ...bracket }))
    );
  });
});
