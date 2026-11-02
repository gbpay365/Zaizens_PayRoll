'use strict';

async function safeAlter(pool, sql) {
  try {
    await pool.query(sql);
  } catch (e) {
    const msg = String(e.message || '');
    if (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060 || /Duplicate column/i.test(msg)) return;
    console.warn('[ensureFacilityIntegrationSchema]', msg);
  }
}

/**
 * Multi-tenant facility registry + per-facility integration partner URLs/keys.
 */
module.exports = async function ensureFacilityIntegrationSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_facility (
      id INT PRIMARY KEY,
      code VARCHAR(32) NULL,
      name VARCHAR(255) NULL,
      status TINYINT DEFAULT 1,
      public_base_url VARCHAR(512) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await safeAlter(pool, 'ALTER TABLE tbl_facility ADD COLUMN code VARCHAR(32) NULL');
  await safeAlter(pool, 'ALTER TABLE tbl_facility ADD COLUMN public_base_url VARCHAR(512) NULL');

  await pool.query(
    "INSERT IGNORE INTO tbl_facility (id, code, name, status) VALUES (1, 'MAIN', 'Default Facility', 1)"
  ).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_facility_integration (
      facility_id INT NOT NULL PRIMARY KEY,
      public_base_url VARCHAR(512) NULL,
      core_account_url VARCHAR(512) NULL,
      core_account_api_key VARCHAR(256) NULL,
      core_account_sync_enabled TINYINT NOT NULL DEFAULT 0,
      hms_url VARCHAR(512) NULL,
      hms_api_key_inbound VARCHAR(256) NULL,
      zaizens_url VARCHAR(512) NULL,
      zaizens_api_key_inbound VARCHAR(256) NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_fac_int_fac FOREIGN KEY (facility_id) REFERENCES tbl_facility(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await safeAlter(pool, 'ALTER TABLE tbl_facility_integration ADD COLUMN enabled TINYINT NOT NULL DEFAULT 1');
  await safeAlter(pool, 'ALTER TABLE tbl_facility_integration ADD COLUMN api_enabled TINYINT NOT NULL DEFAULT 1');
  await safeAlter(pool, 'ALTER TABLE tbl_facility_integration ADD COLUMN hms_sync_enabled TINYINT NOT NULL DEFAULT 1');

  await safeAlter(pool, 'ALTER TABLE tbl_employee ADD COLUMN default_facility_id INT NULL DEFAULT 1');
};
