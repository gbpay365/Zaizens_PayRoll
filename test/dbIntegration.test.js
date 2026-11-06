'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

const { loadEnv } = require('../lib/loadEnv');
const { resolveDbConfig } = require('../lib/resolveDbConfig');
const ensurePayrollBootstrapSchema = require('../lib/ensurePayrollBootstrapSchema');
const ensureEmployeeHrSchema = require('../lib/ensureEmployeeHrSchema');
const ensureHrPayrollSchema = require('../lib/ensureHrPayrollSchema');
const ensureFacilityIntegrationSchema = require('../lib/ensureFacilityIntegrationSchema');
const ensureAdminSchema = require('../lib/ensureAdminSchema');
const { backfillEmployeeAuditFacilities } = require('../lib/ensureAdminSchema');
const { loadPayrollDashboard } = require('../lib/hmsPayrollDashboard');
const { rebuildDeptSummaries } = require('../lib/payrollDeptSummary');
const { generateMonthlyTaxDeclarationCsv } = require('../lib/hmsDgiExport');
const { generateMonthlyDipeContent } = require('../lib/hmsDipeExport');
const { loadMonthlySummary } = require('../lib/hmsStatutoryReports');
const { syncPayrollPeriodToCoreAccount } = require('../lib/coreAccountPayrollSync');
const registerStaffDirectoryRoutes = require('../routes/staffDirectory');
const registerHrPayrollRoutes = require('../routes/hrPayroll');
const registerAdminRoutes = require('../routes/admin');
const { makeApp, withApp, request } = require('./helpers/app');

const DB_NAME = `zaizens_payroll_it_${process.pid}_${Date.now()}`;
const FACILITY_ID = 1;
const ROLLBACK_YEAR = 2031;
const ROLLBACK_MONTH = 2;
const EXCLUSION_YEAR = 2033;
const EXCLUSION_MONTH = 4;
const DASHBOARD_YEAR = new Date().getFullYear();
const DASHBOARD_MONTH = new Date().getMonth() + 1;

let admin = null;
let pool = null;
let setupError = null;
let paidEmployeeId = 0;
let rollbackFirstEmployeeId = 0;
let rollbackSecondEmployeeId = 0;
let includedEmployeeId = 0;
let reversedEmployeeId = 0;

function isUnavailable(error) {
  return (
    !error ||
    [
      'ECONNREFUSED',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ETIMEDOUT',
      'ER_ACCESS_DENIED_ERROR',
      'ER_DBACCESS_DENIED_ERROR',
      'DB_CONFIG_INVALID',
    ].includes(error.code)
  );
}

async function insertEmployee(firstName, lastName, status, facilityId = FACILITY_ID) {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [result] = await pool.query(
    `INSERT INTO tbl_employee
      (first_name, last_name, username, emailid, password, dob, gender, address, bio,
       employee_id, joining_date, phone, role, status, default_facility_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      firstName,
      lastName,
      `it_${lastName.toLowerCase()}_${suffix}`,
      '',
      'integration-test',
      '',
      '',
      '',
      '',
      `IT-${suffix}`,
      '2020-01-01',
      '',
      '101',
      status,
      facilityId,
    ]
  );
  return result.insertId;
}

async function insertProfile(employeeId) {
  await pool.query(
    `INSERT INTO tbl_hms_pay_profile
      (facility_id, employee_id, basic_salary, housing_allowance, transport_allowance, other_allowances, sector)
     VALUES (?,?,?,?,?,?,?)`,
    [FACILITY_ID, employeeId, 100000, 10000, 5000, 0, 'medical']
  );
}

before(async () => {
  let config = null;
  try {
    loadEnv();
    config = resolveDbConfig(process.env);
    if (!config.valid) {
      const error = new Error(config.error || 'MySQL is not configured');
      error.code = 'DB_CONFIG_INVALID';
      throw error;
    }

    admin = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
    });
    await admin.query(`CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: DB_NAME,
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 5,
      ssl: config.ssl,
    });

    await ensurePayrollBootstrapSchema(pool);
    await ensureEmployeeHrSchema(pool);
    await ensureHrPayrollSchema(pool);
    await ensureFacilityIntegrationSchema(pool);
    await ensureAdminSchema(pool);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tbl_hms_payroll_dept_summary (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        facility_id INT NOT NULL DEFAULT 1,
        year SMALLINT NOT NULL,
        month TINYINT NOT NULL,
        department_name VARCHAR(120) NOT NULL DEFAULT '',
        headcount INT NOT NULL DEFAULT 0,
        gross_payroll DECIMAL(18,2) NOT NULL DEFAULT 0,
        net_payroll DECIMAL(18,2) NOT NULL DEFAULT 0,
        employer_charges DECIMAL(18,2) NOT NULL DEFAULT 0,
        cnps_employee DECIMAL(18,2) NOT NULL DEFAULT 0,
        cnps_employer DECIMAL(18,2) NOT NULL DEFAULT 0,
        income_tax DECIMAL(18,2) NOT NULL DEFAULT 0,
        other_deductions DECIMAL(18,2) NOT NULL DEFAULT 0,
        core_period_id VARCHAR(64) NULL,
        synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_period_dept (facility_id, year, month, department_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Keep the real process-month route from attempting a network sync.
    await pool.query(
      `INSERT INTO tbl_facility_integration
        (facility_id, enabled, api_enabled, core_account_sync_enabled)
       VALUES (?, 1, 0, 0)
       ON DUPLICATE KEY UPDATE enabled = 1, api_enabled = 0, core_account_sync_enabled = 0`,
      [FACILITY_ID]
    );

    // Inactive so the payroll run below only sees the two rollback employees.
    paidEmployeeId = await insertEmployee('Paid', 'Deleteblocked', 0);
    await pool.query(
      `INSERT INTO tbl_hms_payroll_record
        (facility_id, employee_id, year, month, gross_salary, net_salary, payout_status)
       VALUES (?,?,?,?,?,?,?)`,
      [FACILITY_ID, paidEmployeeId, 2030, 1, 100000, 80000, 'paid']
    );

    rollbackFirstEmployeeId = await insertEmployee('Alpha', 'Aardvark', 1);
    rollbackSecondEmployeeId = await insertEmployee('Beta', 'Zulu', 1);
    await insertProfile(rollbackFirstEmployeeId);
    await insertProfile(rollbackSecondEmployeeId);

    includedEmployeeId = await insertEmployee('Included', 'ReportingIncluded', 1);
    reversedEmployeeId = await insertEmployee('Reversed', 'ReportingReversed', 1);
    await pool.query(
      "UPDATE tbl_employee SET primary_department = 'Integration' WHERE id IN (?, ?)",
      [includedEmployeeId, reversedEmployeeId]
    );

    const insertPeriodLine = async (employeeId, year, month, gross, net, status) => {
      await pool.query(
        `INSERT INTO tbl_hms_payroll_record
          (facility_id, employee_id, year, month, gross_salary, net_salary, payout_status)
         VALUES (?,?,?,?,?,?,?)`,
        [FACILITY_ID, employeeId, year, month, gross, net, status]
      );
    };

    // Current-period dashboard totals: only the pending line should count.
    await insertPeriodLine(includedEmployeeId, DASHBOARD_YEAR, DASHBOARD_MONTH, 100000, 70000, 'pending');
    await insertPeriodLine(reversedEmployeeId, DASHBOARD_YEAR, DASHBOARD_MONTH, 900000, 800000, 'reversed');

    // Reporting/sync period: one real line and one reversed line in the same department.
    await insertPeriodLine(includedEmployeeId, EXCLUSION_YEAR, EXCLUSION_MONTH, 100000, 70000, 'pending');
    await insertPeriodLine(reversedEmployeeId, EXCLUSION_YEAR, EXCLUSION_MONTH, 900000, 800000, 'reversed');
    await pool.query(
      "UPDATE tbl_hms_payroll_settings SET employer_niu = 'NIU-INTEGRATION' WHERE facility_id = ?",
      [FACILITY_ID]
    );
  } catch (error) {
    setupError = error;
    if (!isUnavailable(error)) throw error;
  }
});

after(async () => {
  if (pool) await pool.end().catch(() => {});
  if (admin) {
    if (DB_NAME) await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``).catch(() => {});
    await admin.end().catch(() => {});
  }
});

function requireDatabase(t) {
  if (!setupError) return true;
  if (isUnavailable(setupError)) {
    t.skip(`MySQL integration database unavailable: ${setupError.message}`);
    return false;
  }
  throw setupError;
}

test('legacy employee-linked payroll audit rows inherit the employee facility', async (t) => {
  if (!requireDatabase(t)) return;

  const marker = `legacy audit facility ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [inserted] = await pool.query(
    `INSERT INTO tbl_admin_audit
      (actor_id, actor_name, facility_id, action, target_type, target_id, detail)
     VALUES
      (NULL, 'Legacy payroll', NULL, 'payroll.salary_delete', 'employee', ?, ?),
      (NULL, 'Legacy payroll', NULL, 'employee.delete_blocked', 'employee', ?, ?)`,
    [
      String(paidEmployeeId),
      `${marker} payroll`,
      String(paidEmployeeId),
      `${marker} non-payroll`,
    ]
  );

  const updated = await backfillEmployeeAuditFacilities(pool);
  assert.ok(updated >= 1, 'at least the legacy payroll row must be backfilled');

  const [[payrollRow]] = await pool.query(
    'SELECT facility_id FROM tbl_admin_audit WHERE id = ?',
    [inserted.insertId]
  );
  assert.equal(payrollRow.facility_id, FACILITY_ID);

  const [[nonPayrollRow]] = await pool.query(
    'SELECT facility_id FROM tbl_admin_audit WHERE detail = ?',
    [`${marker} non-payroll`]
  );
  assert.equal(nonPayrollRow.facility_id, null);

  await pool.query('DELETE FROM tbl_admin_audit WHERE detail LIKE ?', [`${marker}%`]);
});

test('paid employee deletion is refused and leaves the employee and payroll row intact', async (t) => {
  if (!requireDatabase(t)) return;

  await withApp(makeApp(registerStaffDirectoryRoutes, pool), async (base) => {
    const res = await request(base, `/staff/${paidEmployeeId}/delete`, { method: 'POST' });
    assert.equal(res.status, 302);
    assert.match(
      decodeURIComponent(res.headers.get('location')),
      /paid payroll records.*cannot be deleted/i
    );
  });

  const [[employee]] = await pool.query('SELECT id FROM tbl_employee WHERE id = ?', [paidEmployeeId]);
  assert.ok(employee, 'the paid employee must not be deleted');

  const [[record]] = await pool.query(
    'SELECT payout_status FROM tbl_hms_payroll_record WHERE employee_id = ? AND year = 2030 AND month = 1',
    [paidEmployeeId]
  );
  assert.equal(record && record.payout_status, 'paid');

  const [[audit]] = await pool.query(
    `SELECT action, target_type, target_id, facility_id, detail
       FROM tbl_admin_audit
      WHERE action = 'employee.delete_blocked' AND target_id = ?
      ORDER BY id DESC LIMIT 1`,
    [String(paidEmployeeId)]
  );
  assert.ok(audit, 'the blocked deletion must be audited');
  assert.equal(audit.target_type, 'employee');
  assert.equal(audit.facility_id, FACILITY_ID);
  assert.match(audit.detail, /paid payroll record/i);
});

test('bulk deletion cannot delete or audit an employee from another facility', async (t) => {
  if (!requireDatabase(t)) return;

  const inScopeId = await insertEmployee('Bulk', 'InScope', 1, FACILITY_ID);
  const outOfScopeId = await insertEmployee('Bulk', 'OutOfScope', 1, 2);

  await withApp(makeApp(registerStaffDirectoryRoutes, pool, { actorId: 999999 }), async (base) => {
    const res = await request(base, '/staff/bulk-delete', {
      method: 'POST',
      body: new URLSearchParams([
        ['ids', String(inScopeId)],
        ['ids', String(outOfScopeId)],
      ]),
    });

    assert.equal(res.status, 302);
    const location = decodeURIComponent(res.headers.get('location'));
    assert.match(location, /1 employee\(s\) and their accounts deleted/i);
    assert.doesNotMatch(location, /skipped/i);
  });

  const [[inScope]] = await pool.query(
    'SELECT id FROM tbl_employee WHERE id = ?',
    [inScopeId]
  );
  assert.equal(inScope, undefined, 'the in-facility employee must be deleted');

  const [[outOfScope]] = await pool.query(
    'SELECT id, default_facility_id FROM tbl_employee WHERE id = ?',
    [outOfScopeId]
  );
  assert.ok(outOfScope, 'the employee from the other facility must remain');
  assert.equal(outOfScope.default_facility_id, 2);

  const [audits] = await pool.query(
    `SELECT action, target_id, facility_id
       FROM tbl_admin_audit
      WHERE target_id IN (?, ?)
        AND action IN ('employee.delete', 'employee.delete_blocked')
      ORDER BY id`,
    [String(inScopeId), String(outOfScopeId)]
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'employee.delete');
  assert.equal(audits[0].target_id, String(inScopeId));
  assert.equal(audits[0].facility_id, FACILITY_ID);
});

test('payroll run rolls back every inserted line when a later insert fails', async (t) => {
  if (!requireDatabase(t)) return;

  await pool.query(`
    CREATE TRIGGER trg_it_payroll_rollback
    BEFORE INSERT ON tbl_hms_payroll_record
    FOR EACH ROW
    BEGIN
      IF NEW.employee_id = ${rollbackSecondEmployeeId} THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced integration rollback';
      END IF;
    END
  `);

  try {
    await withApp(makeApp(registerHrPayrollRoutes, pool), async (base) => {
      const res = await request(base, '/payroll/process-month', {
        method: 'POST',
        body: new URLSearchParams({ month: String(ROLLBACK_MONTH), year: String(ROLLBACK_YEAR) }),
      });
      assert.equal(res.status, 302);
      assert.match(
        decodeURIComponent(res.headers.get('location')),
        /forced integration rollback/
      );
    });

    const [[periodCount]] = await pool.query(
      `SELECT COUNT(*) AS n FROM tbl_hms_payroll_record
       WHERE facility_id = ? AND year = ? AND month = ?`,
      [FACILITY_ID, ROLLBACK_YEAR, ROLLBACK_MONTH]
    );
    assert.equal(Number(periodCount.n), 0, 'no payroll lines may survive a failed run');

    const [[employeeCount]] = await pool.query(
      `SELECT COUNT(*) AS n FROM tbl_hms_payroll_record
       WHERE employee_id IN (?, ?) AND year = ? AND month = ?`,
      [rollbackFirstEmployeeId, rollbackSecondEmployeeId, ROLLBACK_YEAR, ROLLBACK_MONTH]
    );
    assert.equal(Number(employeeCount.n), 0, 'the successful first insert must roll back too');
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS trg_it_payroll_rollback').catch(() => {});
  }
});

test('reversed payroll lines are excluded from totals, statutory exports and core sync payloads', async (t) => {
  if (!requireDatabase(t)) return;

  const dashboard = await loadPayrollDashboard(pool, FACILITY_ID);
  assert.equal(dashboard.periodGross, 100000);
  assert.equal(dashboard.periodNet, 70000);
  assert.equal(dashboard.pendingCount, 1);
  assert.equal(dashboard.reversedCount, 1);

  const departments = await rebuildDeptSummaries(pool, FACILITY_ID, EXCLUSION_YEAR, EXCLUSION_MONTH);
  const department = departments.find((row) => row.department === 'Integration');
  assert.ok(department, 'the reporting department summary must exist');
  assert.equal(department.headcount, 1);
  assert.equal(department.gross_payroll, 100000);
  assert.equal(department.net_payroll, 70000);

  const dgi = await generateMonthlyTaxDeclarationCsv(
    pool,
    FACILITY_ID,
    EXCLUSION_MONTH,
    EXCLUSION_YEAR
  );
  const dgiSummary = dgi.body
    .split('\r\n')
    .find((line) => line.startsWith('SOMMAIRE;'))
    .split(';');
  assert.equal(dgiSummary[5], '1');
  assert.equal(Number(dgiSummary[6]), 100000);
  assert.ok(dgi.body.includes('ReportingIncluded'));
  assert.ok(!dgi.body.includes('ReportingReversed'));

  const dipe = await generateMonthlyDipeContent(pool, FACILITY_ID, EXCLUSION_MONTH, EXCLUSION_YEAR);
  assert.equal(dipe.split('\r\n').length, 1);
  assert.ok(dipe.includes('0000100000'));
  assert.ok(!dipe.includes('0000900000'));

  const statutory = await loadMonthlySummary(pool, FACILITY_ID, EXCLUSION_MONTH, EXCLUSION_YEAR);
  assert.equal(Number(statutory.emp_cnt), 1);
  assert.equal(Number(statutory.gross), 100000);
  assert.equal(Number(statutory.net), 70000);

  await pool.query(
    `UPDATE tbl_facility_integration
        SET enabled = 1, core_account_sync_enabled = 1,
            core_account_url = 'http://core.integration.test', core_account_api_key = 'test-key'
      WHERE facility_id = ?`,
    [FACILITY_ID]
  );

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    const result = await syncPayrollPeriodToCoreAccount(
      pool,
      FACILITY_ID,
      EXCLUSION_YEAR,
      EXCLUSION_MONTH
    );
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal(result.departmentCount, 1);
  } finally {
    global.fetch = originalFetch;
  }

  const periodCall = calls.find((call) => call.url.endsWith('/api/v1/integrations/payroll-periods'));
  assert.ok(periodCall, 'the payroll period payload must be posted');
  assert.equal(periodCall.body.lines.length, 1);
  assert.equal(periodCall.body.lines[0].hms_employee_id, includedEmployeeId);
  assert.equal(periodCall.body.lines[0].gross_salary, 100000);
  assert.ok(
    !periodCall.body.lines.some((line) => line.hms_employee_id === reversedEmployeeId),
    'the reversed payroll line must not be sent to Account_Core'
  );

  const deptCall = calls.find((call) => call.url.endsWith('/api/v1/integrations/payroll-department-summaries'));
  assert.ok(deptCall, 'the department summary payload must be posted');
  assert.equal(deptCall.body.departments.length, 1);
  assert.equal(deptCall.body.departments[0].headcount, 1);
  assert.equal(deptCall.body.departments[0].gross_payroll, 100000);
});

test('audit integrity report lists only null-facility rows with no employee source', async (t) => {
  if (!requireDatabase(t)) return;

  const marker = `audit integrity ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const noFacilityEmployeeId = await insertEmployee('Audit', 'NoFacility', 1, null);
  const rows = [
    {
      key: 'noFacility',
      action: 'payroll.salary_delete',
      targetType: 'employee',
      targetId: String(noFacilityEmployeeId),
      detail: `${marker} employee without facility`,
    },
    {
      key: 'missingEmployee',
      action: 'payroll.salary_delete',
      targetType: 'employee',
      targetId: '99999999',
      detail: `${marker} missing employee`,
    },
    {
      key: 'nonEmployee',
      action: 'security.policy',
      targetType: 'security',
      targetId: 'policy',
      detail: `${marker} non-employee target`,
    },
    {
      key: 'resolvable',
      action: 'employee.delete',
      targetType: 'employee',
      targetId: String(includedEmployeeId),
      detail: `${marker} resolvable employee`,
    },
  ];
  const ids = {};
  for (const row of rows) {
    const [result] = await pool.query(
      `INSERT INTO tbl_admin_audit
        (actor_id, actor_name, facility_id, action, target_type, target_id, detail)
       VALUES (NULL, 'Integrity test', NULL, ?, ?, ?, ?)`,
      [row.action, row.targetType, row.targetId, row.detail]
    );
    ids[row.key] = result.insertId;
  }

  await withApp(makeApp(registerAdminRoutes, pool), async (base) => {
    const res = await request(base, '/admin/audit-integrity');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.view, 'admin-audit-integrity');
    assert.equal(body.locals.payNavActive, 'admin-audit-integrity');
    assert.equal(body.locals.stats.totalNull, 4);
    assert.equal(body.locals.stats.unresolved, 3);
    assert.equal(body.locals.stats.resolvable, 1);
    assert.ok(body.locals.facilities.some((facility) => Number(facility.id) === FACILITY_ID));

    const byId = new Map(body.locals.rows.map((row) => [Number(row.id), row]));
    assert.ok(byId.has(ids.noFacility));
    assert.equal(byId.get(ids.noFacility).resolution_reason, 'Employee has no default facility');
    assert.ok(byId.has(ids.missingEmployee));
    assert.equal(byId.get(ids.missingEmployee).resolution_reason, 'Target employee no longer exists');
    assert.ok(byId.has(ids.nonEmployee));
    assert.equal(byId.get(ids.nonEmployee).resolution_reason, 'Not linked to an employee record');
    assert.ok(!byId.has(ids.resolvable), 'rows recoverable from an employee must not be listed');
  });

  await withApp(
    makeApp(registerAdminRoutes, pool, { role: '101', userPerms: ['payroll.read'] }),
    async (base) => {
      const res = await request(base, `/admin/audit-integrity/${ids.noFacility}/assign`, {
        method: 'POST',
        body: new URLSearchParams({ facility_id: String(FACILITY_ID) }),
      });
      assert.equal(res.status, 403);
    }
  );

  await withApp(makeApp(registerAdminRoutes, pool), async (base) => {
    const assignRes = await request(base, `/admin/audit-integrity/${ids.noFacility}/assign`, {
      method: 'POST',
      body: new URLSearchParams({ facility_id: String(FACILITY_ID) }),
    });
    assert.equal(assignRes.status, 302);
    assert.match(decodeURIComponent(assignRes.headers.get('location')), /assigned to audit row/i);

    const guardRes = await request(base, `/admin/audit-integrity/${ids.resolvable}/assign`, {
      method: 'POST',
      body: new URLSearchParams({ facility_id: String(FACILITY_ID) }),
    });
    assert.equal(guardRes.status, 302);
    assert.match(
      decodeURIComponent(guardRes.headers.get('location')),
      /resolved from employee data/i
    );

    const refreshed = await request(base, '/admin/audit-integrity');
    const refreshedBody = JSON.parse(refreshed.text);
    assert.equal(refreshedBody.locals.stats.totalNull, 3);
    assert.equal(refreshedBody.locals.stats.unresolved, 2);
  });

  const [[assigned]] = await pool.query(
    'SELECT facility_id FROM tbl_admin_audit WHERE id = ?',
    [ids.noFacility]
  );
  assert.equal(assigned.facility_id, FACILITY_ID);

  const [[stillResolvable]] = await pool.query(
    'SELECT facility_id FROM tbl_admin_audit WHERE id = ?',
    [ids.resolvable]
  );
  assert.equal(stillResolvable.facility_id, null);

  const [[assignmentAudit]] = await pool.query(
    `SELECT action, target_type, target_id, facility_id, detail
       FROM tbl_admin_audit
      WHERE action = 'audit.facility_assign' AND target_id = ?
      ORDER BY id DESC LIMIT 1`,
    [String(ids.noFacility)]
  );
  assert.ok(assignmentAudit, 'the manual assignment must be audited');
  assert.equal(assignmentAudit.target_type, 'audit');
  assert.equal(assignmentAudit.facility_id, FACILITY_ID);
  assert.match(assignmentAudit.detail, /audit row #/i);
});

test('bulk audit facility assignment keeps the authorization and unresolved-row guards', async (t) => {
  if (!requireDatabase(t)) return;

  const marker = `audit bulk ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const firstEmployeeId = await insertEmployee('Bulk', 'UnresolvedOne', 1, null);
  const secondEmployeeId = await insertEmployee('Bulk', 'UnresolvedTwo', 1, null);
  const resolvableEmployeeId = await insertEmployee('Bulk', 'Resolvable', 1, FACILITY_ID);

  const insertAudit = async (action, targetType, targetId, facilityId, detail) => {
    const [result] = await pool.query(
      `INSERT INTO tbl_admin_audit
        (actor_id, actor_name, facility_id, action, target_type, target_id, detail)
       VALUES (NULL, 'Bulk integrity test', ?, ?, ?, ?, ?)`,
      [facilityId, action, targetType, targetId, detail]
    );
    return result.insertId;
  };

  const firstId = await insertAudit(
    'payroll.salary_delete', 'employee', String(firstEmployeeId), null, `${marker} first unresolved`
  );
  const secondId = await insertAudit(
    'security.policy', 'security', 'policy', null, `${marker} second unresolved`
  );
  const resolvableId = await insertAudit(
    'employee.delete', 'employee', String(resolvableEmployeeId), null, `${marker} resolvable`
  );
  const assignedId = await insertAudit(
    'account.update', 'account', 'existing', FACILITY_ID, `${marker} already assigned`
  );
  const postBulk = (base, auditIds, facilityId = FACILITY_ID) => request(base, '/admin/audit-integrity/assign', {
    method: 'POST',
    body: new URLSearchParams([
      ['facility_id', String(facilityId)],
      ...auditIds.map((id) => ['audit_ids[]', String(id)]),
    ]),
  });

  await withApp(
    makeApp(registerAdminRoutes, pool, { role: '101', userPerms: ['payroll.read'] }),
    async (base) => {
      const res = await postBulk(base, [firstId]);
      assert.equal(res.status, 403);
    }
  );

  await withApp(makeApp(registerAdminRoutes, pool), async (base) => {
    const resolvableGuard = await postBulk(base, [firstId, resolvableId]);
    assert.equal(resolvableGuard.status, 302);
    assert.match(
      decodeURIComponent(resolvableGuard.headers.get('location')),
      /can still be resolved from employee data/i
    );

    const assignedGuard = await postBulk(base, [firstId, assignedId]);
    assert.equal(assignedGuard.status, 302);
    assert.match(
      decodeURIComponent(assignedGuard.headers.get('location')),
      /already (?:has|have) a facility/i
    );

    const [[afterGuards]] = await pool.query(
      'SELECT facility_id FROM tbl_admin_audit WHERE id = ?',
      [firstId]
    );
    assert.equal(afterGuards.facility_id, null, 'a rejected bulk selection must not partially assign rows');

    const success = await postBulk(base, [firstId, secondId]);
    assert.equal(success.status, 302);
    assert.match(decodeURIComponent(success.headers.get('location')), /assigned to 2 audit rows/i);

    const refreshed = await request(base, '/admin/audit-integrity');
    const refreshedBody = JSON.parse(refreshed.text);
    const reportIds = new Set(refreshedBody.locals.rows.map((row) => Number(row.id)));
    assert.ok(!reportIds.has(firstId), 'assigned rows must leave the unresolved report');
    assert.ok(!reportIds.has(secondId), 'assigned rows must leave the unresolved report');
    assert.ok(!reportIds.has(resolvableId), 'employee-resolvable rows are not shown for manual assignment');
  });

  const [assignedRows] = await pool.query(
    'SELECT id, facility_id FROM tbl_admin_audit WHERE id IN (?, ?) ORDER BY id',
    [firstId, secondId]
  );
  assert.deepEqual(
    assignedRows.map((row) => Number(row.id)),
    [firstId, secondId].sort((a, b) => a - b)
  );
  assert.ok(assignedRows.every((row) => Number(row.facility_id) === FACILITY_ID));

  const [[resolvableRow]] = await pool.query(
    'SELECT facility_id FROM tbl_admin_audit WHERE id = ?',
    [resolvableId]
  );
  assert.equal(resolvableRow.facility_id, null);

  const [bulkAudits] = await pool.query(
    `SELECT target_type, target_id, facility_id, detail
       FROM tbl_admin_audit
      WHERE action = 'audit.facility_assign' AND target_id IN (?, ?)
      ORDER BY id`,
    [String(firstId), String(secondId)]
  );
  assert.equal(bulkAudits.length, 2, 'bulk assignment must write one audit entry per selected row');
  assert.deepEqual(
    bulkAudits.map((row) => Number(row.target_id)).sort((a, b) => a - b),
    [firstId, secondId].sort((a, b) => a - b)
  );
  for (const row of bulkAudits) {
    assert.equal(row.target_type, 'audit');
    assert.equal(Number(row.facility_id), FACILITY_ID);
    assert.match(row.detail, /Bulk-assigned facility/i);
  }
});
