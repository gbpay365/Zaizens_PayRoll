'use strict';

/**
 * Administration schema: base ACL tables (self-healing), security policy and
 * the admin audit trail.
 */

async function safeAlter(pool, sql) {
  try {
    await pool.query(sql);
  } catch (e) {
    const msg = String(e.message || '');
    if (
      e.code === 'ER_DUP_FIELDNAME' ||
      e.code === 'ER_DUP_KEYNAME' ||
      e.errno === 1060 ||
      e.errno === 1061 ||
      /Duplicate column/i.test(msg) ||
      /Duplicate key name/i.test(msg)
    ) {
      return;
    }
    console.warn('[ensureAdminSchema]', msg);
  }
}

async function ensureBaseAclTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_acl_permission (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      code        VARCHAR(120) NOT NULL,
      label       VARCHAR(160) NOT NULL DEFAULT '',
      gap_area    VARCHAR(60)  NULL,
      module_code VARCHAR(40)  NULL,
      action      VARCHAR(20)  NOT NULL DEFAULT 'read',
      description TEXT         NULL,
      UNIQUE KEY uq_acl_perm_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_acl_role_permission (
      role          VARCHAR(20) NOT NULL,
      permission_id INT         NOT NULL,
      PRIMARY KEY (role, permission_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);
}

/**
 * Legacy payroll audit rows predate the facility_id column. Recover their
 * scope from the employee they target, without overwriting known facilities.
 */
async function backfillEmployeeAuditFacilities(pool) {
  const [result] = await pool.query(
    `UPDATE tbl_admin_audit a
      JOIN tbl_employee e
        ON a.target_type = 'employee'
       AND CAST(e.id AS CHAR) = a.target_id
       SET a.facility_id = e.default_facility_id
     WHERE a.facility_id IS NULL
       AND a.action LIKE 'payroll.%'
       AND e.default_facility_id IS NOT NULL`
  );
  return Number(result && result.affectedRows) || 0;
}

module.exports = async function ensureAdminSchema(pool) {
  await ensureBaseAclTables(pool);

  // Seed the permission catalogue used by the payroll/HR modules. The table is
  // created empty, so the Role & permissions screen would otherwise have
  // nothing to assign on a fresh database.
  const PERMISSIONS = [
    ['dashboard.read', 'Dashboard: view the payroll & HR dashboard', 'dashboard', 'read'],
    ['payroll.read', 'Payroll: view payroll runs, profiles & reports', 'payroll', 'read'],
    ['payroll.write', 'Payroll: edit payroll & post salaries', 'payroll', 'write'],
    ['hr.self.read', 'HR self-service: my leave, payslips & attendance', 'payroll', 'read'],
    ['hr.leave.approve', 'HR admin: leave approvals, balances & holidays', 'payroll', 'approve'],
    ['employee.read', 'Employees: view the staff directory & profiles', 'employee', 'read'],
    ['employee.write', 'Employees: create, edit & deactivate staff', 'employee', 'write'],
    ['employee.delete', 'Employees: delete staff records', 'employee', 'delete'],
    ['employee.password.manage', 'Employees: set & reset staff login passwords', 'employee', 'manage'],
    ['accounting.read', 'Accounting: view reports, CNPS & DGI declarations', 'accounting', 'read'],
    ['accounting.write', 'Accounting: post journals & manage accounts', 'accounting', 'write'],
    ['profile.self.write', 'My profile: edit own account & password', 'profile', 'write'],
    ['access_control.manage', 'Access control: manage roles & permissions', 'access_control', 'manage'],
  ];
  for (const [code, label, moduleCode, action] of PERMISSIONS) {
    await pool.query(
      `INSERT IGNORE INTO tbl_acl_permission (code, label, gap_area, module_code, action)
       VALUES (?, ?, 0, ?, ?)`,
      [code, label, moduleCode, action]
    );
  }

  // System Admin and Super Admin always hold every permission.
  await pool
    .query(
      `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
       SELECT r.role, p.id FROM (SELECT '1' AS role UNION SELECT '99') r
       CROSS JOIN tbl_acl_permission p`
    )
    .catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_admin_audit (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor_id    INT NULL,
      actor_name  VARCHAR(120) NULL,
      facility_id INT NULL,
      action      VARCHAR(60) NOT NULL,
      target_type VARCHAR(40) NULL,
      target_id   VARCHAR(64) NULL,
      detail      TEXT NULL,
      ip          VARCHAR(64) NULL,
      KEY idx_admin_audit_created (created_at),
      KEY idx_admin_audit_action (action, created_at),
      KEY idx_admin_audit_facility (facility_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  // Existing installations need the facility scope added in place.
  await safeAlter(pool, 'ALTER TABLE tbl_admin_audit ADD COLUMN facility_id INT NULL AFTER actor_name');
  await safeAlter(
    pool,
    'ALTER TABLE tbl_admin_audit ADD INDEX idx_admin_audit_facility (facility_id, created_at)'
  );

  // Older rows were written before audit entries carried a facility. Restore
  // their scope from the employee target where that facility is known.
  try {
    const backfilled = await backfillEmployeeAuditFacilities(pool);
    if (backfilled > 0) {
      console.log(`[ensureAdminSchema] backfilled ${backfilled} payroll audit facility row(s)`);
    }
  } catch (e) {
    console.warn('[ensureAdminSchema] audit facility backfill:', e.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_admin_security (
      id                     TINYINT NOT NULL DEFAULT 1,
      password_min_length    TINYINT NOT NULL DEFAULT 8,
      password_require_digit TINYINT NOT NULL DEFAULT 1,
      password_require_upper TINYINT NOT NULL DEFAULT 0,
      force_change_on_reset  TINYINT NOT NULL DEFAULT 1,
      lockout_threshold      TINYINT NOT NULL DEFAULT 8,
      lockout_minutes        TINYINT NOT NULL DEFAULT 15,
      updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      updated_by             VARCHAR(120) NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await pool.query(
    'INSERT IGNORE INTO tbl_admin_security (id) VALUES (1)'
  ).catch(() => {});

  // Password lifecycle flag used by the login flow.
  try {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME AS col FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_employee'
         AND COLUMN_NAME IN ('password_must_change', 'last_reset_at')`
    );
    const have = new Set((cols || []).map((r) => r.COLUMN_NAME));
    if (!have.has('password_must_change')) {
      await pool.query(
        'ALTER TABLE tbl_employee ADD COLUMN password_must_change TINYINT(1) NOT NULL DEFAULT 0'
      ).catch(() => {});
    }
    if (!have.has('last_reset_at')) {
      await pool.query(
        'ALTER TABLE tbl_employee ADD COLUMN last_reset_at DATETIME NULL DEFAULT NULL'
      ).catch(() => {});
    }
  } catch (e) {
    console.warn('[ensureAdminSchema] password columns:', e.message);
  }
};

module.exports.ensureBaseAclTables = ensureBaseAclTables;
module.exports.backfillEmployeeAuditFacilities = backfillEmployeeAuditFacilities;
