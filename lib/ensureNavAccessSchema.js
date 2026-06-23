'use strict';

async function ensureNavAccessSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_acl_role_nav_grant (
      role      VARCHAR(20) NOT NULL,
      nav_code  VARCHAR(80) NOT NULL,
      granted   TINYINT(1)  NOT NULL DEFAULT 1,
      PRIMARY KEY (role, nav_code),
      KEY idx_nav_grant_role (role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);
  return true;
}

module.exports = { ensureNavAccessSchema };
