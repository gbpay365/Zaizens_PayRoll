'use strict';

const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

const PAYROLL_TABLES = [
  'tbl_facility',
  'tbl_role',
  'tbl_employee',
  'tbl_hms_payroll_settings',
  'tbl_hms_pay_profile',
  'tbl_hms_allowance_settings',
  'tbl_hms_payroll_record',
  'tbl_hms_attendance',
  'tbl_hr_attendance',
  'tbl_hms_leave_balance',
  'tbl_hms_leave_request',
  'tbl_hms_holiday',
  'tbl_hms_dipe_history',
  'tbl_hms_payroll_dept_summary',
];

function loadHmsEnv() {
  const hmsEnv = path.join('C:', 'HMS_JS', '.env');
  if (fs.existsSync(hmsEnv)) dotenv.config({ path: hmsEnv });
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    facilityId: 1,
    employees: 'payroll',
    truncate: false,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    if (arg === '--truncate') opts.truncate = true;
    if (arg.startsWith('--facility-id=')) {
      opts.facilityId = parseInt(arg.split('=')[1], 10) || 1;
    }
    if (arg.startsWith('--employees=')) {
      const v = String(arg.split('=')[1] || '').toLowerCase();
      if (['active', 'all', 'payroll'].includes(v)) opts.employees = v;
    }
  }
  return opts;
}

function quoteId(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function sqlDefault(def) {
  if (def == null) return '';
  const s = String(def);
  if (s.toUpperCase() === 'NULL') return ' DEFAULT NULL';
  if (/CURRENT_TIMESTAMP/i.test(s)) return ` DEFAULT ${s}`;
  if (/^-?\d+(\.\d+)?$/.test(s)) return ` DEFAULT ${s}`;
  return ` DEFAULT '${s.replace(/'/g, "''")}'`;
}

function dbConfig(prefix, fallbackDb) {
  return {
    host: process.env[`${prefix}DB_HOST`] || process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env[`${prefix}DB_PORT`] || process.env.DB_PORT || '3306', 10),
    user: process.env[`${prefix}DB_USER`] || process.env.DB_USER || 'root',
    password: process.env[`${prefix}DB_PASSWORD`] ?? process.env.DB_PASSWORD ?? '',
    database: process.env[`${prefix}DB_NAME`] || fallbackDb,
  };
}

async function tableExists(conn, dbName, tableName) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
    [dbName, tableName]
  );
  return rows.length > 0;
}

async function listColumns(conn, dbName, tableName) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS defaultValue, EXTRA AS extra
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [dbName, tableName]
  );
  return rows || [];
}

async function alignTableSchema(source, target, sourceDb, targetDb, tableName, dryRun) {
  const srcCols = await listColumns(source, sourceDb, tableName);
  const tgtCols = await listColumns(target, targetDb, tableName);
  const tgtNames = new Set(tgtCols.map((c) => c.name));

  for (const col of srcCols) {
    if (tgtNames.has(col.name)) continue;
    const nullable = col.nullable === 'YES' ? 'NULL' : 'NOT NULL';
    const def = col.defaultValue == null ? '' : sqlDefault(col.defaultValue);
    const extra = col.extra ? ` ${col.extra}` : '';
    const sql = `ALTER TABLE ${quoteId(tableName)} ADD COLUMN ${quoteId(col.name)} ${col.type} ${nullable}${def}${extra}`;
    if (dryRun) {
      console.log(`[dry-run] ${tableName}: would add column ${col.name}`);
    } else {
      await target.query(sql).catch((e) => {
        console.warn(`[align] ${tableName}.${col.name}: ${e.message}`);
      });
    }
  }
}

async function commonColumns(source, target, sourceDb, targetDb, tableName) {
  const srcCols = await listColumns(source, sourceDb, tableName);
  const tgtSet = new Set((await listColumns(target, targetDb, tableName)).map((c) => c.name));
  return srcCols.map((c) => c.name).filter((n) => tgtSet.has(n));
}

async function copyTable(source, target, sourceDb, targetDb, tableName, opts) {
  const { dryRun, whereSql = '1=1', whereParams = [], facilityId } = opts;

  if (!(await tableExists(source, sourceDb, tableName))) {
    return { table: tableName, skipped: true, reason: 'missing on source' };
  }
  if (!(await tableExists(target, targetDb, tableName))) {
    return { table: tableName, skipped: true, reason: 'missing on target (run app once to create schema)' };
  }

  await alignTableSchema(source, target, sourceDb, targetDb, tableName, dryRun);
  const cols = await commonColumns(source, target, sourceDb, targetDb, tableName);
  if (!cols.length) {
    return { table: tableName, skipped: true, reason: 'no common columns' };
  }

  let where = whereSql;
  const params = [...whereParams];
  if (facilityId != null && cols.includes('facility_id')) {
    where = `(${whereSql}) AND facility_id = ?`;
    params.push(facilityId);
  }

  const colList = cols.map(quoteId).join(', ');
  const [rows] = await source.query(
    `SELECT ${colList} FROM ${quoteId(tableName)} WHERE ${where}`,
    params
  );
  if (!rows.length) {
    return { table: tableName, copied: 0, skipped: false };
  }

  if (dryRun) {
    return { table: tableName, copied: rows.length, dryRun: true, skipped: false };
  }

  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.map((c) => `${quoteId(c)}=VALUES(${quoteId(c)})`).join(', ');
  let copied = 0;

  for (const row of rows) {
    const values = cols.map((c) => (row[c] === undefined ? null : row[c]));
    await target.query(
      `INSERT INTO ${quoteId(tableName)} (${colList}) VALUES (${placeholders})
       ON DUPLICATE KEY UPDATE ${updates}`,
      values
    );
    copied++;
  }

  return { table: tableName, copied, skipped: false };
}

async function employeeWhereClause(source, sourceDb, mode, facilityId) {
  if (mode === 'all') return { sql: '1=1', params: [] };
  if (mode === 'active') return { sql: 'status = 1', params: [] };

  const ids = new Set();
  const tables = ['tbl_hms_pay_profile', 'tbl_hms_payroll_record', 'tbl_hms_leave_request', 'tbl_hms_attendance'];
  for (const table of tables) {
    if (!(await tableExists(source, sourceDb, table))) continue;
    const hasFac = (await listColumns(source, sourceDb, table)).some((c) => c.name === 'facility_id');
    const sql = hasFac
      ? `SELECT DISTINCT employee_id FROM ${quoteId(table)} WHERE facility_id = ?`
      : `SELECT DISTINCT employee_id FROM ${quoteId(table)}`;
    const params = hasFac ? [facilityId] : [];
    const [rows] = await source.query(sql, params).catch(() => [[]]);
    for (const r of rows || []) {
      const id = parseInt(r.employee_id, 10);
      if (id > 0) ids.add(id);
    }
  }

  const [activeRows] = await source.query('SELECT id FROM tbl_employee WHERE status = 1').catch(() => [[]]);
  for (const r of activeRows || []) ids.add(parseInt(r.id, 10));

  const list = [...ids].filter((id) => id > 0);
  if (!list.length) return { sql: 'status = 1', params: [] };
  return {
    sql: `id IN (${list.map(() => '?').join(',')})`,
    params: list,
  };
}

async function ensureTargetSchema(target) {
  await require('./ensurePayrollBootstrapSchema')(target);
  await require('./ensureEmployeeHrSchema')(target);
  await require('./ensureHrPayrollSchema')(target);
  await target.query(`
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
  `).catch(() => {});
}

async function migrateFromHms(options = {}) {
  const opts = { ...parseArgs([]), ...options };
  loadHmsEnv();

  const sourceConfig = dbConfig('HMS_', 'hms');
  const targetConfig = dbConfig('', 'zaizens_payroll');

  const source = await mysql.createConnection(sourceConfig);
  const target = await mysql.createConnection(targetConfig);
  const summary = [];

  try {
    console.log(`Source: ${sourceConfig.database} @ ${sourceConfig.host}`);
    console.log(`Target: ${targetConfig.database} @ ${targetConfig.host}`);
    console.log(`Facility: ${opts.facilityId} | Employees: ${opts.employees} | Dry-run: ${opts.dryRun}`);

    if (!opts.dryRun) {
      await ensureTargetSchema(target);
    }

    if (opts.truncate && !opts.dryRun) {
      await target.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const table of [...PAYROLL_TABLES].reverse()) {
        if (await tableExists(target, targetConfig.database, table)) {
          await target.query(`TRUNCATE TABLE ${quoteId(table)}`);
        }
      }
      await target.query('SET FOREIGN_KEY_CHECKS = 1');
      console.log('Target payroll tables truncated.');
    }

    const empWhere = await employeeWhereClause(source, sourceConfig.database, opts.employees, opts.facilityId);

    for (const table of PAYROLL_TABLES) {
      const copyOpts = {
        dryRun: opts.dryRun,
        facilityId: opts.facilityId,
      };
      if (table === 'tbl_employee') {
        copyOpts.whereSql = empWhere.sql;
        copyOpts.whereParams = empWhere.params;
        copyOpts.facilityId = null;
      } else if (table === 'tbl_role' || table === 'tbl_facility') {
        copyOpts.facilityId = null;
      }

      const result = await copyTable(
        source,
        target,
        sourceConfig.database,
        targetConfig.database,
        table,
        copyOpts
      );
      summary.push(result);
      if (result.skipped) {
        console.log(`  skip ${table}: ${result.reason}`);
      } else {
        console.log(`  ${table}: ${result.copied} row(s)${result.dryRun ? ' (dry-run)' : ''}`);
      }
    }

    return { ok: true, summary };
  } finally {
    await source.end();
    await target.end();
  }
}

module.exports = {
  PAYROLL_TABLES,
  migrateFromHms,
  parseArgs,
};
