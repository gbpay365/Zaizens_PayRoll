'use strict';

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const { loadEnv } = require('../../lib/loadEnv');
const { resolveDbConfig } = require('../../lib/resolveDbConfig');
const ensurePayrollBootstrapSchema = require('../../lib/ensurePayrollBootstrapSchema');
const ensureEmployeeHrSchema = require('../../lib/ensureEmployeeHrSchema');
const ensureHrPayrollSchema = require('../../lib/ensureHrPayrollSchema');
const { ensureLeaveSystemSchema } = require('../../lib/leaveSystem');
const ensureFacilityIntegrationSchema = require('../../lib/ensureFacilityIntegrationSchema');
const ensureAdminSchema = require('../../lib/ensureAdminSchema');

const ROOT = path.resolve(__dirname, '../..');
const DB_NAME = `zaizens_payroll_browser_${process.pid}_${Date.now()}`;
const ADMIN_USER = 'payadmin';
const ADMIN_PASSWORD = 'admin123';
const EMPLOYEE_USER = 'leavetester';
const EMPLOYEE_PASSWORD = 'employee123';
const HR2_USER = 'payadmin2';
const HR2_PASSWORD = 'admin123';

let admin = null;
let adminId = 0;
let hrAdmin2Id = 0;
let employeeId = 0;
let pool = null;
let server = null;
let baseURL = '';
let serverOutput = '';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.unref();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

async function waitForApp(url, childRef, outputRef) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const child = childRef();
    if (child && child.exitCode !== null) {
      throw new Error(`Test app exited during startup.\n${outputRef().slice(-4000)}`);
    }
    try {
      const response = await fetch(`${url}/__health`);
      if (response.ok) return;
    } catch (_) {
      // Keep polling until the app has finished its schema boot.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Test app did not become healthy.\n${outputRef().slice(-4000)}`);
}

async function waitForServer() {
  return waitForApp(baseURL, () => server, () => serverOutput);
}

function allowanceRow(page, code) {
  return page.locator(`tr.allowance-row:has(input[name="allowance_code[]"][value="${code}"])`);
}

function futureWorkingDate(offsetDays = 3) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

async function login(page, username, password, urlPattern, base = baseURL) {
  await page.goto(`${base}/`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await Promise.all([
    page.waitForURL(urlPattern, { timeout: 15_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ]);
}

function buildChildEnv(config, overrides = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SESSION_SECRET: 'browser-regression-test-secret',
    DB_HOST: config.host,
    DB_PORT: String(config.port),
    DB_USER: config.user,
    DB_PASSWORD: config.password,
    DB_NAME,
    MYSQLHOST: config.host,
    MYSQL_HOST: config.host,
    MYSQLPORT: String(config.port),
    MYSQL_PORT: String(config.port),
    MYSQLUSER: config.user,
    MYSQL_USER: config.user,
    MYSQLPASSWORD: config.password,
    MYSQL_PASSWORD: config.password,
    MYSQLDATABASE: DB_NAME,
    MYSQL_DATABASE: DB_NAME,
    ...overrides,
  };
  delete env.DATABASE_URL;
  delete env.MYSQL_URL;
  delete env.RAILWAY_ENVIRONMENT;
  delete env.RAILWAY;
  delete env.RAILWAY_PROJECT_ID;
  return env;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  loadEnv();
  const config = resolveDbConfig(process.env);
  if (!config.valid) throw new Error(config.error || 'MySQL is not configured');

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
  await ensureLeaveSystemSchema(pool);
  await ensureFacilityIntegrationSchema(pool);
  await ensureAdminSchema(pool);

  const hash = await bcrypt.hash(ADMIN_PASSWORD, 4);
  const [adminResult] = await pool.query(
    `INSERT INTO tbl_employee
      (first_name, last_name, username, password, role, status, joining_date,
       address, bio, emailid, dob, gender, phone, employee_id, default_facility_id)
     VALUES ('Payroll', 'Admin', ?, ?, '1', 1, CURDATE(), '', '', '', '', '', '', 'PAY-ADMIN', 1)`,
    [ADMIN_USER, hash]
  );
  adminId = adminResult.insertId;

  const employeeHash = await bcrypt.hash(EMPLOYEE_PASSWORD, 4);
  const [employeeResult] = await pool.query(
    `INSERT INTO tbl_employee
      (first_name, last_name, username, password, role, status, joining_date,
       address, bio, emailid, dob, gender, phone, employee_id, default_facility_id)
     VALUES ('Leave', 'Tester', ?, ?, '101', 1, CURDATE(), '', '', '', '', '', '', 'LEAVE-TEST', 1)`,
    [EMPLOYEE_USER, employeeHash]
  );
  employeeId = employeeResult.insertId;

  const hr2Hash = await bcrypt.hash(HR2_PASSWORD, 4);
  const [hr2Result] = await pool.query(
    `INSERT INTO tbl_employee
      (first_name, last_name, username, password, role, status, joining_date,
       address, bio, emailid, dob, gender, phone, employee_id, default_facility_id)
     VALUES ('Second', 'HR Admin', ?, ?, '1', 1, CURDATE(), '', '', '', '', '', '', 'PAY-ADMIN-2', 1)`,
    [HR2_USER, hr2Hash]
  );
  hrAdmin2Id = hr2Result.insertId;

  const port = await getFreePort();
  baseURL = `http://127.0.0.1:${port}`;
  const childEnv = buildChildEnv(config, { PORT: String(port) });

  server = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  await waitForServer();
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (pool) await pool.end().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test('allowance settings form saves edits and reloads persisted values', async ({ page }) => {
  await login(page, ADMIN_USER, ADMIN_PASSWORD, /\/(payroll|hr)(\?|$)/);

  await page.goto(`${baseURL}/payroll/settings?sector=medical&tab=allowances`);
  await expect(page.getByRole('heading', { name: 'Allowances & Bonuses' })).toBeVisible();

  const seniority = allowanceRow(page, 'seniority');
  const medicalRisk = allowanceRow(page, 'medical_risk');
  await expect(seniority).toHaveCount(1);
  await expect(medicalRisk).toHaveCount(1);

  await seniority.locator('input[name="allowance_cap_pct[]"]').fill('35');
  await seniority
    .locator('input[name="allowance_legal_basis[]"]')
    .fill('Browser regression legal basis');
  await medicalRisk.locator('input[name="allowance_pct_value[]"]').fill('12.5');
  await medicalRisk.locator('input[name="allowance_enabled[]"]').uncheck();

  await page.getByRole('button', { name: 'Save allowance settings' }).click();
  await page.waitForURL(/Allowance%20settings%20saved/i, { timeout: 15_000 });

  const [[savedSeniority]] = await pool.query(
    `SELECT cap_pct, legal_basis
       FROM tbl_hms_allowance_settings
      WHERE facility_id = 1 AND sector = 'medical' AND code = 'seniority'`
  );
  const [[savedMedicalRisk]] = await pool.query(
    `SELECT enabled, pct_value
       FROM tbl_hms_allowance_settings
      WHERE facility_id = 1 AND sector = 'medical' AND code = 'medical_risk'`
  );
  expect(Number(savedSeniority.cap_pct)).toBe(35);
  expect(savedSeniority.legal_basis).toBe('Browser regression legal basis');
  expect(Number(savedMedicalRisk.pct_value)).toBe(12.5);
  expect(Number(savedMedicalRisk.enabled)).toBe(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Allowances & Bonuses' })).toBeVisible();
  const reloadedSeniority = allowanceRow(page, 'seniority');
  const reloadedMedicalRisk = allowanceRow(page, 'medical_risk');
  await expect(reloadedSeniority.locator('input[name="allowance_cap_pct[]"]')).toHaveValue(/^35(?:\.0+)?$/);
  await expect(reloadedSeniority.locator('input[name="allowance_legal_basis[]"]')).toHaveValue(
    'Browser regression legal basis'
  );
  await expect(reloadedMedicalRisk.locator('input[name="allowance_pct_value[]"]')).toHaveValue(
    /^12\.5(?:0+)?$/
  );
  await expect(reloadedMedicalRisk.locator('input[name="allowance_enabled[]"]')).not.toBeChecked();
});

test('leave approval makes the employee on-leave in the attendance register', async ({ page }) => {
  const leaveDate = futureWorkingDate();
  await login(page, EMPLOYEE_USER, EMPLOYEE_PASSWORD, /\/hr(\?|$)/);

  await page.goto(`${baseURL}/hr/request-leave`);
  await page.locator('select[name="leave_type"]').selectOption('annual');
  await page.locator('input[name="start_date"]').fill(leaveDate);
  await page.locator('input[name="end_date"]').fill(leaveDate);
  await page.locator('textarea[name="reason"]').fill('Browser leave approval regression');
  await Promise.all([
    page.waitForURL(/request-leave\?msg=/, { timeout: 15_000 }),
    page.getByRole('button', { name: /submit request/i }).click(),
  ]);

  const [[request]] = await pool.query(
    `SELECT id, status, days_requested
       FROM tbl_hms_leave_request
      WHERE employee_id = ? AND start_date = ?`,
    [employeeId, leaveDate]
  );
  expect(request).toBeTruthy();
  expect(request.status).toBe('pending');
  expect(Number(request.days_requested)).toBe(1);

  await page.goto(`${baseURL}/logout`);
  await expect(page).toHaveURL(`${baseURL}/`);
  await login(page, ADMIN_USER, ADMIN_PASSWORD, /\/(payroll|hr)(\?|$)/);

  await page.goto(`${baseURL}/hr/leave-requests`);
  const requestRow = page
    .locator('tr[data-search*="leave tester"]')
    .filter({ hasText: 'Browser leave approval regression' });
  await expect(requestRow).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await Promise.all([
    page.waitForURL(/leave-requests\?msg=/, { timeout: 15_000 }),
    requestRow.getByRole('button', { name: 'Approve' }).click(),
  ]);

  const [[approved]] = await pool.query(
    'SELECT status, approved_by FROM tbl_hms_leave_request WHERE id = ?',
    [request.id]
  );
  expect(approved.status).toBe('approved');
  expect(Number(approved.approved_by)).toBe(adminId);

  await page.goto(`${baseURL}/hr/attendance?date=${leaveDate}`);
  const attendanceRow = page.locator('tr[data-search*="leave tester"]');
  await expect(attendanceRow).toHaveCount(1);
  await expect(attendanceRow.locator('select.att-status')).toHaveValue('on-leave');
  await expect(attendanceRow.locator('input[name$="[in]"]')).toHaveValue('');
  await expect(attendanceRow.locator('input[name$="[out]"]')).toHaveValue('');
  await expect(attendanceRow).toContainText('Approved annual leave');
  await expect(
    page.locator('.sage-stat').filter({ hasText: 'On leave' }).locator('.sage-stat-value')
  ).toHaveText('1');

  await page.getByRole('button', { name: /save attendance/i }).click();
  await page.waitForURL(/Attendance%20saved/i, { timeout: 15_000 });
  const [[savedAttendance]] = await pool.query(
    `SELECT status, check_in_time, check_out_time
       FROM tbl_hms_attendance
      WHERE facility_id = 1 AND employee_id = ? AND att_date = ?`,
    [employeeId, leaveDate]
  );
  expect(savedAttendance.status).toBe('on-leave');
  expect(savedAttendance.check_in_time).toBeNull();
  expect(savedAttendance.check_out_time).toBeNull();
});

test('HR leave policy, balances, calendar, reports and employee settings render', async ({ page }) => {
  await login(page, ADMIN_USER, ADMIN_PASSWORD, /\/(payroll|hr)(\?|$)/);
  const screens = [
    ['/hr/leave-balances', 'Leave balances'],
    ['/hr/leave-types', 'Leave types & policy'],
    ['/hr/leave-calendar', 'Leave calendar'],
    ['/hr/leave-reports', 'Leave reports'],
    ['/hr/leave-employees', 'Employee leave settings'],
    ['/hr/leave-maintenance', 'Leave maintenance'],
    ['/hr/notifications', 'Notifications'],
  ];
  for (const [path, heading] of screens) {
    const response = await page.goto(`${baseURL}${path}`);
    expect(response.status(), `${path} status`).toBe(200);
    await expect(page.locator('h1').first(), `${path} heading`).toContainText(heading);
  }

  await page.goto(`${baseURL}/hr/leave-maintenance`);
  page.once('dialog', (dialog) => dialog.accept());
  await Promise.all([
    page.waitForURL(/leave-maintenance\?all=1&msg=/, { timeout: 20_000 }),
    page.getByRole('button', { name: /run now/i }).click(),
  ]);
  await expect(page.locator('.pay-flash-msg')).toContainText('Maintenance run finished');
  await expect(page.locator('#maintenanceMailNotice')).toContainText('Email alerts are off');
  const carryRow = page.locator('#maintenanceRuns tbody tr').filter({ hasText: 'Carry-over' }).first();
  await expect(carryRow).toContainText('Payroll Admin');

  await page.goto(`${baseURL}/hr/leave-maintenance?status=failed`);
  await expect(page.locator('#maintenanceRuns tbody tr').filter({ hasText: 'Carry-over' })).toHaveCount(0);
  await expect(page.locator('.sage-empty')).toContainText('No maintenance runs match these filters');

  await page.goto(`${baseURL}/hr/leave-maintenance?clear=1`);
  await page.locator('select[name="task"]').selectOption('leave_accrual');
  await Promise.all([
    page.waitForURL(/task=leave_accrual/, { timeout: 15_000 }),
    page.getByRole('button', { name: /apply filters/i }).click(),
  ]);
  await expect(page.locator('#maintenanceRuns tbody tr').filter({ hasText: 'Carry-over' })).toHaveCount(0);
  await expect(page.locator('#maintenanceRuns tbody tr').filter({ hasText: 'Accrual' })).toHaveCount(1);

  // Leaving for another page and returning through the policy page keeps the filter.
  await page.goto(`${baseURL}/hr/leave-types`);
  await Promise.all([
    page.waitForURL(/\/hr\/leave-maintenance/, { timeout: 15_000 }),
    page.locator('.sage-head-actions').getByRole('link', { name: /maintenance log/i }).click(),
  ]);
  await expect(page.locator('select[name="task"]')).toHaveValue('leave_accrual');
  await expect(page.locator('#maintenanceRuns tbody tr').filter({ hasText: 'Carry-over' })).toHaveCount(0);

  await page.goto(`${baseURL}/hr/leave-maintenance`);
  await expect(page.locator('select[name="task"]')).toHaveValue('leave_accrual');
  await expect(page.locator('#maintenanceRuns tbody tr').filter({ hasText: 'Carry-over' })).toHaveCount(0);
  await page.getByRole('link', { name: /^clear$/i }).click();
  await expect(page.locator('select[name="task"]')).toHaveValue('');
  await expect(page.locator('#maintenanceRuns tbody tr').filter({ hasText: 'Carry-over' }).first()).toBeVisible();

  await page.goto(`${baseURL}/hr/leave-maintenance?from=2000-01-01&to=2000-01-02`);
  await expect(page.locator('.sage-empty')).toContainText('No maintenance runs match these filters');
  await page.goto(`${baseURL}/hr/leave-maintenance?from=2000-01-01&to=2999-12-31`);
  await expect(page.locator('#maintenanceRuns tbody tr').filter({ hasText: 'Carry-over' }).first()).toBeVisible();
  await page.goto(`${baseURL}/hr/leave-maintenance`);
  await expect(page.locator('input[name="from"]')).toHaveValue('2000-01-01');
  await expect(page.locator('input[name="to"]')).toHaveValue('2999-12-31');
  await expect(page.locator('#maintenanceRuns tbody tr').filter({ hasText: 'Carry-over' }).first()).toBeVisible();
  await page.goto(`${baseURL}/hr/leave-maintenance?from=not-a-date`);
  await expect(page.locator('#maintenanceRuns tbody tr').filter({ hasText: 'Carry-over' }).first()).toBeVisible();

  await pool.query(
    `INSERT INTO tbl_hms_maintenance_run (facility_id, task, run_key, status, detail, started_at, finished_at)
     VALUES (1, 'leave_digest', 'health-fail-1', 'failed', 'SMTP refused', DATE_SUB(NOW(), INTERVAL 4 MINUTE), DATE_SUB(NOW(), INTERVAL 3 MINUTE)),
            (1, 'leave_digest', 'health-fail-2', 'failed', 'SMTP refused', DATE_SUB(NOW(), INTERVAL 2 MINUTE), DATE_SUB(NOW(), INTERVAL 1 MINUTE))`
  );
  await page.goto(`${baseURL}/hr/leave-maintenance`);
  await expect(page.locator('#maintenanceHealth tbody tr').filter({ hasText: 'Carry-over' })).toContainText('Last run succeeded');
  await expect(page.locator('#maintenanceHealth tbody tr').filter({ hasText: 'Email digest' })).toContainText('Failed 2 runs in a row');
});

test('each HR account keeps its own maintenance filters', async ({ browser }) => {
  test.setTimeout(60_000);
  const contextOne = await browser.newContext();
  const contextTwo = await browser.newContext();
  try {
    const pageOne = await contextOne.newPage();
    await login(pageOne, ADMIN_USER, ADMIN_PASSWORD, /\/(payroll|hr)(\?|$)/);
    await pageOne.goto(`${baseURL}/hr/leave-maintenance?clear=1`);
    await pageOne.locator('select[name="task"]').selectOption('leave_accrual');
    await Promise.all([
      pageOne.waitForURL(/task=leave_accrual/, { timeout: 15_000 }),
      pageOne.getByRole('button', { name: /apply filters/i }).click(),
    ]);

    const pageTwo = await contextTwo.newPage();
    await login(pageTwo, HR2_USER, HR2_PASSWORD, /\/(payroll|hr)(\?|$)/);
    await pageTwo.goto(`${baseURL}/hr/leave-maintenance?clear=1`);
    await pageTwo.locator('select[name="status"]').selectOption('failed');
    await Promise.all([
      pageTwo.waitForURL(/status=failed/, { timeout: 15_000 }),
      pageTwo.getByRole('button', { name: /apply filters/i }).click(),
    ]);

    await pageOne.goto(`${baseURL}/hr/leave-maintenance`);
    await expect(pageOne.locator('select[name="task"]')).toHaveValue('leave_accrual');
    await expect(pageOne.locator('select[name="status"]')).toHaveValue('');

    await pageTwo.goto(`${baseURL}/hr/leave-maintenance`);
    await expect(pageTwo.locator('select[name="task"]')).toHaveValue('');
    await expect(pageTwo.locator('select[name="status"]')).toHaveValue('failed');

    const [filterRows] = await pool.query(
      'SELECT employee_id, task, status FROM tbl_hms_maintenance_filter WHERE employee_id IN (?,?) ORDER BY employee_id',
      [adminId, hrAdmin2Id]
    );
    expect(filterRows).toHaveLength(2);
    const firstFilter = filterRows.find((row) => Number(row.employee_id) === adminId);
    const secondFilter = filterRows.find((row) => Number(row.employee_id) === hrAdmin2Id);
    expect(firstFilter && firstFilter.task).toBe('leave_accrual');
    expect(firstFilter && firstFilter.status).toBeNull();
    expect(secondFilter && secondFilter.task).toBeNull();
    expect(secondFilter && secondFilter.status).toBe('failed');
  } finally {
    await contextOne.close().catch(() => {});
    await contextTwo.close().catch(() => {});
  }
});

test('no email-off banner once SMTP and a recipient are configured', async ({ page }) => {
  test.setTimeout(90_000);
  const config = resolveDbConfig(process.env);
  const port = await getFreePort();
  const childEnv = buildChildEnv(config, {
    PORT: String(port),
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: '0',
    SMTP_FROM: 'Zaizens PayRoll <payroll@example.com>',
    HR_MAINTENANCE_NOTIFY_EMAILS: 'hr@example.com',
    // The banner is read per request; keep this instance from firing a run or
    // attempting real SMTP delivery while the assertion runs.
    HR_MAINTENANCE_SCHEDULER_ENABLED: '0',
  });
  const child = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForApp(url, () => child, () => output);
    await login(page, ADMIN_USER, ADMIN_PASSWORD, /\/(payroll|hr)(\?|$)/, url);
    const response = await page.goto(`${url}/hr/leave-maintenance`);
    expect(response.status()).toBe(200);
    await expect(page.locator('h1').first()).toContainText('Leave maintenance');
    await expect(page.locator('#maintenanceHealth')).toBeVisible();
    await expect(page.locator('#maintenanceMailNotice')).toHaveCount(0);
    await expect(page.getByText('Email alerts are off')).toHaveCount(0);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
});

test('hourly permission records a partial-day request and partial attendance note', async ({ page }) => {
  const leaveDate = futureWorkingDate(10);
  await login(page, EMPLOYEE_USER, EMPLOYEE_PASSWORD, /\/hr(\?|$)/);
  await page.goto(`${baseURL}/hr/request-leave`);
  await page.locator('select[name="leave_type"]').selectOption('permission');
  await page.locator('select[name="duration_unit"]').selectOption('hour');
  await page.locator('input[name="start_date"]').fill(leaveDate);
  await page.locator('input[name="end_date"]').fill(leaveDate);
  await page.locator('input[name="start_time"]').fill('09:00');
  await page.locator('input[name="end_time"]').fill('11:00');
  await page.locator('textarea[name="reason"]').fill('Browser permission regression');
  await Promise.all([
    page.waitForURL(/request-leave\?msg=/, { timeout: 15_000 }),
    page.getByRole('button', { name: /submit request/i }).click(),
  ]);

  const [[request]] = await pool.query(
    `SELECT id, status, days_requested, total_hours, duration_unit
       FROM tbl_hms_leave_request
      WHERE employee_id = ? AND start_date = ?`,
    [employeeId, leaveDate]
  );
  expect(request).toBeTruthy();
  expect(request.status).toBe('pending');
  expect(request.duration_unit).toBe('hour');
  expect(Number(request.days_requested)).toBe(0.25);
  expect(Number(request.total_hours)).toBe(2);
  const [[day]] = await pool.query(
    'SELECT days, minutes FROM tbl_hms_leave_request_day WHERE request_id = ?',
    [request.id]
  );
  expect(Number(day.days)).toBe(0.25);
  expect(Number(day.minutes)).toBe(120);

  await page.goto(`${baseURL}/logout`);
  await expect(page).toHaveURL(`${baseURL}/`);
  await login(page, ADMIN_USER, ADMIN_PASSWORD, /\/(payroll|hr)(\?|$)/);
  await page.goto(`${baseURL}/hr/leave-requests`);
  const requestRow = page
    .locator('tr[data-search*="leave tester"]')
    .filter({ hasText: 'Browser permission regression' });
  await expect(requestRow).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await Promise.all([
    page.waitForURL(/leave-requests\?msg=/, { timeout: 15_000 }),
    requestRow.getByRole('button', { name: 'Approve' }).click(),
  ]);
  const [[approved]] = await pool.query(
    'SELECT status, approved_by FROM tbl_hms_leave_request WHERE id = ?',
    [request.id]
  );
  expect(approved.status).toBe('approved');
  expect(Number(approved.approved_by)).toBe(adminId);

  await page.goto(`${baseURL}/hr/attendance?date=${leaveDate}`);
  const attendanceRow = page.locator('tr[data-search*="leave tester"]');
  await expect(attendanceRow).toContainText('Approved permission leave');
  const [[attendance]] = await pool.query(
    'SELECT status, leave_request_id FROM tbl_hms_attendance WHERE employee_id = ? AND att_date = ?',
    [employeeId, leaveDate]
  );
  expect(attendance.status).toBe('present');
  expect(Number(attendance.leave_request_id)).toBe(Number(request.id));
});
