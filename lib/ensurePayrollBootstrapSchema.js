'use strict';

/**
 * Core employee/role tables for standalone Zaizens Payroll (fresh XAMPP database).
 */
module.exports = async function ensurePayrollBootstrapSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_role (
      id INT AUTO_INCREMENT PRIMARY KEY,
      role VARCHAR(50) NOT NULL,
      title VARCHAR(120) NOT NULL DEFAULT '',
      KEY idx_role (role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_employee (
      id INT AUTO_INCREMENT PRIMARY KEY,
      first_name VARCHAR(250) NOT NULL,
      last_name VARCHAR(250) NOT NULL,
      username VARCHAR(250) NOT NULL,
      emailid VARCHAR(250) NOT NULL DEFAULT '',
      password VARCHAR(250) NOT NULL,
      dob VARCHAR(50) NOT NULL DEFAULT '',
      gender VARCHAR(10) NOT NULL DEFAULT '',
      address TEXT NOT NULL,
      bio TEXT NOT NULL,
      photo_path VARCHAR(255) DEFAULT NULL,
      employee_id VARCHAR(250) NOT NULL DEFAULT '',
      joining_date VARCHAR(250) NOT NULL DEFAULT '',
      phone VARCHAR(32) NOT NULL DEFAULT '',
      role VARCHAR(50) NOT NULL DEFAULT '101',
      status TINYINT NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      primary_department VARCHAR(120) DEFAULT NULL,
      job_title VARCHAR(120) DEFAULT NULL,
      cnps_number VARCHAR(32) NOT NULL DEFAULT '',
      tax_niu VARCHAR(32) NOT NULL DEFAULT '',
      nic_number VARCHAR(32) NOT NULL DEFAULT '',
      bank_name VARCHAR(120) NOT NULL DEFAULT '',
      bank_account_no VARCHAR(40) NOT NULL DEFAULT '',
      specialisation VARCHAR(120) DEFAULT NULL,
      profile_emoji VARCHAR(32) DEFAULT NULL,
      UNIQUE KEY uq_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(
    `INSERT IGNORE INTO tbl_role (role, title) VALUES
      ('1', 'System Admin'),
      ('99', 'Super Admin'),
      ('101', 'Staff')`
  );
};
