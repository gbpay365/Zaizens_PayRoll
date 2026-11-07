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
const ensureFacilityIntegrationSchema = require('../../lib/ensureFacilityIntegrationSchema');
const ensureAdminSchema = require('../../lib/ensureAdminSchema');

const ROOT = path.resolve(__dirname, '../..');
const DB_NAME = `zaizens_payroll_browser_${process.pid}_${Date.now()}`;
const ADMIN_USER = 'payadmin';
const ADMIN_PASSWORD = 'admin123';

let admin = null;
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

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) {
      throw new Error(`Test app exited during startup.\n${serverOutput.slice(-4000)}`);
    }
    try {
      const response = await fetch(`${baseURL}/__health`);
      if (response.ok) return;
    } catch (_) {
      // Keep polling until the app has finished its schema boot.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Test app did not become healthy.\n${serverOutput.slice(-4000)}`);
}

function allowanceRow(page, code) {
  return page.locator(`tr.allowance-row:has(input[name="allowance_code[]"][value="${code}"])`);
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
  await ensureFacilityIntegrationSchema(pool);
  await ensureAdminSchema(pool);

  const hash = await bcrypt.hash(ADMIN_PASSWORD, 4);
  await pool.query(
    `INSERT INTO tbl_employee
      (first_name, last_name, username, password, role, status, joining_date,
       address, bio, emailid, dob, gender, phone, employee_id, default_facility_id)
     VALUES ('Payroll', 'Admin', ?, ?, '1', 1, CURDATE(), '', '', '', '', '', '', 'PAY-ADMIN', 1)`,
    [ADMIN_USER, hash]
  );

  const port = await getFreePort();
  baseURL = `http://127.0.0.1:${port}`;
  const childEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
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
  };
  delete childEnv.DATABASE_URL;
  delete childEnv.MYSQL_URL;
  delete childEnv.RAILWAY_ENVIRONMENT;
  delete childEnv.RAILWAY;
  delete childEnv.RAILWAY_PROJECT_ID;

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
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Username').fill(ADMIN_USER);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL(/\/(payroll|hr)(\?|$)/, { timeout: 15_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ]);

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
