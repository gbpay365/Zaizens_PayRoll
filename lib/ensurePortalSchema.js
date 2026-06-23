'use strict';

const {
  ensureDepartmentPortals,
  migrateLegacyRolePortalCodes,
} = require('./ensureDepartmentPortals');

const BUILTIN_HOME_URLS = Object.freeze({
  doctor: '/portal/hub/doctor',
  nurse: '/portal/hub/nurse',
  labtech: '/portal/hub/labtech',
  front_desk: '/portal/hub/front_desk',
  doctors: '/portal/doctor',
  nursing: '/portal/hub/nursing',
  laboratory: '/portal/hub/laboratory',
  cashier: '/portal/hub/cashier',
  pharmacy: '/portal/pharmacy',
  radiology: '/portal/hub/radiology',
  accountant: '/payroll',
  patient_support: '/portal/login',
});

async function portalColumnExists(pool, column) {
  const [rows] = await pool.query(
    `SELECT 1 AS ok FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'tbl_acl_portal'
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [column]
  );
  return !!(rows && rows.length);
}

/** Extend tbl_acl_portal and seed Hospital Director portal. */
async function ensurePortalSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_acl_portal (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(40) NOT NULL UNIQUE,
      label VARCHAR(80) NOT NULL,
      sort_order INT DEFAULT 0,
      home_url VARCHAR(255) NULL,
      icon VARCHAR(64) NULL DEFAULT 'fa-th-large',
      color VARCHAR(24) NULL DEFAULT '#714b67',
      description TEXT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      is_builtin TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  const cols = [
    ['home_url', 'VARCHAR(255) NULL'],
    ['icon', "VARCHAR(64) NULL DEFAULT 'fa-th-large'"],
    ['color', "VARCHAR(24) NULL DEFAULT '#714b67'"],
    ['description', 'TEXT NULL'],
    ['enabled', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['is_builtin', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['created_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
  ];
  for (const [name, def] of cols) {
    if (await portalColumnExists(pool, name)) continue;
    try {
      await pool.query(`ALTER TABLE tbl_acl_portal ADD COLUMN ${name} ${def}`);
    } catch (e) {
      console.warn('[ensurePortalSchema] ADD COLUMN', name, e.message);
    }
  }

  if (!(await portalColumnExists(pool, 'home_url'))) {
    console.warn('[ensurePortalSchema] home_url column missing — skipping portal seed');
    return false;
  }

  for (const [code, url] of Object.entries(BUILTIN_HOME_URLS)) {
    await pool.query(
      `UPDATE tbl_acl_portal SET home_url=?, is_builtin=1 WHERE code=? AND (home_url IS NULL OR home_url='' OR home_url LIKE '/portal/hub/%')`,
      [url, code]
    ).catch((e) => console.warn('[ensurePortalSchema] builtin home_url', code, e.message));
  }

  const [exDir] = await pool.query(
    'SELECT id FROM tbl_acl_portal WHERE code=? LIMIT 1',
    ['director']
  );
  if (!exDir || !exDir.length) {
    await pool.query(
      `INSERT INTO tbl_acl_portal (code, label, sort_order, home_url, icon, color, description, enabled, is_builtin)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`,
      [
        'director',
        'Hospital Director',
        15,
        '/portal/hub/director',
        'fa-user-md',
        '#714b67',
        'Executive overview — clinical operations, staff, and hospital performance.',
      ]
    );
  }

  const directorTiles = [
    ['dir.tile.dashboard', 'Executive dashboard', '/dashboard', 'fa-dashboard', '#714b67', 'dashboard.read|analytics.read|hms_reports.full', 10],
    ['dir.tile.patients', 'Patient directory', '/patients', 'fa-users', '#0ea5e9', 'patient.read|patient.write', 20],
    ['dir.tile.opd', 'OPD queue', '/opd-queue', 'fa-list-alt', '#0c8b8b', 'opd.read|clinical.read', 30],
    ['dir.tile.wards', 'Ward board', '/wards', 'fa-bed', '#0891b2', 'adt.read|nursing.read', 40],
    ['dir.tile.emergency', 'Emergency', '/emergency', 'fa-ambulance', '#dc2626', 'emergency.read|clinical.read', 50],
    ['dir.tile.employees', 'Employees', '/employees', 'fa-id-badge', '#7c3aed', 'employee.read|employee.write', 60],
    ['dir.tile.payroll', 'Payroll & HR', '/payroll', 'fa-money', '#475569', 'payroll.read|payroll.write', 70],
    ['dir.tile.financials', 'Financials', '/financials', 'fa-line-chart', '#1a6bd8', 'accounting.read|financials.read', 80],
    ['dir.tile.guides', 'Workflow guides', '/workflow-guides', 'fa-sitemap', '#f59e0b', '*', 90],
    ['dir.tile.access', 'Access & workflow', '/hms-admin/access', 'fa-lock', '#334155', 'access_control.manage', 100],
  ];
  for (const [code, label, url, icon, color, perm, sort] of directorTiles) {
    const [ex] = await pool.query(
      'SELECT id FROM tbl_acl_ui_element WHERE code=? LIMIT 1',
      [code]
    ).catch(() => [[]]);
    if (ex && ex.length) continue;
    await pool.query(
      `INSERT INTO tbl_acl_ui_element
        (code, portal_code, kind, parent_code, label, url, icon, color, sort_order, required_perm, enabled)
       VALUES (?, 'director', 'tile', NULL, ?, ?, ?, ?, ?, ?, 1)`,
      [code, label, url, icon, color, sort, perm]
    ).catch((e) => console.warn('[ensurePortalSchema] tile', code, e.message));
  }

  // Existing DBs: director / doctor hub tiles must not use perm '*' (shows to every role).
  await pool.query(
    `UPDATE tbl_acl_ui_element SET required_perm = 'dashboard.read|analytics.read|hms_reports.full'
     WHERE code IN ('dir.tile.dashboard', 'doctor.tile.dashboard')`
  ).catch(() => {});

  await ensureDepartmentPortals(pool);
  await migrateLegacyRolePortalCodes(pool);

  return true;
}

module.exports = { ensurePortalSchema, BUILTIN_HOME_URLS };
