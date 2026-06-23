'use strict';

const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { loadEnv } = require('../lib/loadEnv');

loadEnv();

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'zaizens_payroll',
  });
  await require('../lib/ensurePayrollBootstrapSchema')(pool);
  const hash = await bcrypt.hash('admin123', 10);
  await pool.query(
    `INSERT INTO tbl_employee (first_name, last_name, username, password, role, status, joining_date, address, bio, emailid, dob, gender, phone, employee_id)
     VALUES ('Payroll', 'Admin', 'payadmin', ?, '1', 1, CURDATE(), '', '', '', '', '', '', 'PAY-ADMIN')
     ON DUPLICATE KEY UPDATE password=VALUES(password), status=1, role='1'`,
    [hash]
  );
  await pool.query(
    `UPDATE tbl_employee SET password=? WHERE username='admin' AND status=1 LIMIT 1`,
    [hash]
  ).catch(() => {});
  console.log('Admin users: payadmin / admin123  (also resets HMS admin password to admin123)');
  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
