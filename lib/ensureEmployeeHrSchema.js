'use strict';

/**
 * Payroll / statutory identity fields on tbl_employee (payslip & HR records).
 * Column ensures are cheap and safe on hot paths (login, /cashier).
 * Backfill / catalog sync runs once per process via syncEmployeeHrSchemaData().
 */
let _columnsReady = false;
let _columnsPromise = null;
let _dataSynced = false;
let _dataPromise = null;

async function safeAlter(pool, sql) {
  try {
    await pool.query(sql);
  } catch (e) {
    const msg = String(e.message || '');
    if (
      e.code === 'ER_DUP_FIELDNAME' ||
      e.errno === 1060 ||
      /Duplicate column/i.test(msg) ||
      /already exists/i.test(msg)
    ) {
      return;
    }
    console.warn('[ensureEmployeeHrSchema]', msg);
  }
}

async function loadEmployeeColumns(pool) {
  try {
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME AS col FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_employee'`
    );
    return new Set((rows || []).map((r) => String(r.col || '')));
  } catch (_) {
    return new Set();
  }
}

async function runEnsureEmployeeHrColumns(pool) {
  const existing = await loadEmployeeColumns(pool);
  const columns = [
    ['job_title', "VARCHAR(120) NULL DEFAULT NULL COMMENT 'Position / poste on payslip'"],
    ['cnps_number', "VARCHAR(32) NOT NULL DEFAULT '' COMMENT 'Employee CNPS registration'"],
    ['tax_niu', "VARCHAR(32) NOT NULL DEFAULT '' COMMENT 'Employee tax ID (NIU)'"],
    ['nic_number', "VARCHAR(32) NOT NULL DEFAULT '' COMMENT 'National ID card number'"],
    ['bank_name', "VARCHAR(120) NOT NULL DEFAULT '' COMMENT 'Salary bank name'"],
    ['bank_account_no', "VARCHAR(40) NOT NULL DEFAULT '' COMMENT 'Salary bank account'"],
    [
      'specialisation',
      "VARCHAR(120) NULL DEFAULT NULL COMMENT 'Clinical specialty for doctors (Cardiology, General Medicine, etc.)'",
    ],
    ['profile_emoji', "VARCHAR(32) NULL DEFAULT NULL COMMENT 'Emoji profile avatar for staff directory'"],
    ['photo_path', "VARCHAR(255) NULL DEFAULT NULL COMMENT 'Uploaded staff profile photo path under /uploads'"],
  ];

  for (const [col, def] of columns) {
    if (!existing.has(col)) {
      await safeAlter(pool, `ALTER TABLE tbl_employee ADD COLUMN ${col} ${def}`);
    }
  }
  _columnsReady = true;
}

async function runSyncEmployeeHrSchemaData(pool) {
  if (!_columnsReady) {
    await module.exports(pool);
  }
  try {
    await pool.query(
      `UPDATE tbl_employee e
       LEFT JOIN tbl_role r ON CAST(r.role AS UNSIGNED) = CAST(e.role AS UNSIGNED)
       SET e.specialisation = TRIM(e.primary_department)
       WHERE (e.specialisation IS NULL OR TRIM(e.specialisation) = '')
         AND e.primary_department IS NOT NULL AND TRIM(e.primary_department) <> ''
         AND (r.title REGEXP 'Doctor|Physician|M[eé]decin|Specialist|Sp[eé]cialiste' OR CAST(e.role AS UNSIGNED) = 2)`
    );
  } catch (e) {
    console.warn('[ensureEmployeeHrSchema] specialisation backfill:', e.message);
  }

  try {
    const { registerDoctorSpecialisation } = require('./hmsDoctorSpecialisations');
    const [rows] = await pool.query(
      `SELECT DISTINCT TRIM(specialisation) AS name FROM tbl_employee
       WHERE specialisation IS NOT NULL AND TRIM(specialisation) <> ''`
    );
    for (const r of rows || []) {
      await registerDoctorSpecialisation(pool, r.name);
    }
  } catch (e) {
    console.warn('[ensureEmployeeHrSchema] specialisation catalog sync:', e.message);
  }
  _dataSynced = true;
}

/** Fast path: ensure tbl_employee HR columns exist (safe on login / cashier). */
module.exports = async function ensureEmployeeHrSchema(pool) {
  if (_columnsReady) return;
  if (_columnsPromise) return _columnsPromise;
  _columnsPromise = runEnsureEmployeeHrColumns(pool)
    .catch((e) => {
      console.warn('[ensureEmployeeHrSchema]', e && e.message ? e.message : e);
    })
    .finally(() => {
      _columnsPromise = null;
    });
  return _columnsPromise;
};

/** Slow path: backfill + speciality catalog — boot / admin only. */
module.exports.syncEmployeeHrSchemaData = async function syncEmployeeHrSchemaData(pool) {
  if (_dataSynced) return;
  if (_dataPromise) return _dataPromise;
  _dataPromise = runSyncEmployeeHrSchemaData(pool)
    .catch((e) => {
      console.warn('[ensureEmployeeHrSchema] data sync:', e && e.message ? e.message : e);
    })
    .finally(() => {
      _dataPromise = null;
    });
  return _dataPromise;
};

module.exports.ensureEmployeeHrSchema = module.exports;
