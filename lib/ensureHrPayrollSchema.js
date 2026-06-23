/**
 * Creates HR / payroll tables aligned with PHP migrations 039 + 040.
 */
const { defaultBracketsJson } = require('./hmsPayrollCameroon');

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
  console.warn('[ensureHrPayrollSchema]', msg);
 }
}

module.exports = async function ensureHrPayrollSchema(pool) {
 await pool.query(`
  CREATE TABLE IF NOT EXISTS tbl_facility (
   id INT PRIMARY KEY,
   name VARCHAR(255) NULL,
   status TINYINT DEFAULT 1,
   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
 `).catch(() => {});
 await pool.query(
  'INSERT IGNORE INTO tbl_facility (id, name, status) VALUES (1, ?, 1)',
  ['Default Facility']
 ).catch(() => {});

 await pool.query(`
  CREATE TABLE IF NOT EXISTS tbl_hms_payroll_settings (
   id INT NOT NULL AUTO_INCREMENT,
   facility_id INT NOT NULL,
   tax_year SMALLINT NOT NULL,
   employer_cnps_number VARCHAR(32) NOT NULL DEFAULT '',
   employer_niu VARCHAR(32) NOT NULL DEFAULT '',
   cnps_regime TINYINT NOT NULL DEFAULT 1,
   employer_address VARCHAR(500) NOT NULL DEFAULT '',
   employer_phone VARCHAR(64) NOT NULL DEFAULT '',
   employer_email VARCHAR(128) NOT NULL DEFAULT '',
   cnps_employee_rate DECIMAL(8,3) NOT NULL DEFAULT 2.800,
   cimr_employee_rate DECIMAL(8,3) NOT NULL DEFAULT 2.400,
   crtv_rate DECIMAL(8,3) NOT NULL DEFAULT 0.200,
   council_tax_rate DECIMAL(8,3) NOT NULL DEFAULT 0.800,
   development_tax_rate DECIMAL(8,3) NOT NULL DEFAULT 0.500,
   cnhc_rate DECIMAL(8,3) NOT NULL DEFAULT 0.500,
   tax_brackets TEXT NULL,
   default_sector VARCHAR(40) NOT NULL DEFAULT 'medical',
   updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
   PRIMARY KEY (id),
   UNIQUE KEY uq_hms_payroll_settings_fac_year (facility_id, tax_year),
   KEY fk_hms_payroll_settings_fac (facility_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
 `).catch(() => {});
 await safeAlter(pool, "ALTER TABLE tbl_hms_payroll_settings ADD COLUMN default_sector VARCHAR(40) NOT NULL DEFAULT 'medical'");

 await pool.query(`
  CREATE TABLE IF NOT EXISTS tbl_hms_payroll_record (
   id INT NOT NULL AUTO_INCREMENT,
   facility_id INT NOT NULL,
   employee_id INT NOT NULL,
   year SMALLINT NOT NULL,
   month TINYINT NOT NULL,
   gross_salary DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   cnps_employee DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   cimr_employee DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   crtv_deduction DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   council_tax_deduction DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   development_tax_deduction DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   cnhc_deduction DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   taxable_income DECIMAL(14,2) NULL DEFAULT NULL,
   income_tax DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   net_salary DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   basic_salary_snap DECIMAL(14,2) NULL DEFAULT NULL,
   housing_allowance_snap DECIMAL(14,2) NULL DEFAULT NULL,
   transport_allowance_snap DECIMAL(14,2) NULL DEFAULT NULL,
   other_allowances_snap DECIMAL(14,2) NULL DEFAULT NULL,
   payment_date DATE NULL DEFAULT NULL,
   payout_status VARCHAR(16) NOT NULL DEFAULT 'pending',
   updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
   PRIMARY KEY (id),
   UNIQUE KEY uq_hms_payroll_rec_fac_emp_ym (facility_id, employee_id, year, month),
   KEY idx_hms_payroll_rec_fac_ym (facility_id, year, month),
   KEY idx_payroll_emp (employee_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
 `).catch(() => {});

 await safeAlter(
  pool,
  'ALTER TABLE tbl_hms_payroll_record ADD COLUMN taxable_income DECIMAL(14,2) NULL AFTER cnhc_deduction'
 );
 await safeAlter(
  pool,
  'ALTER TABLE tbl_hms_payroll_record ADD COLUMN payout_status VARCHAR(16) NOT NULL DEFAULT \'pending\' AFTER other_allowances_snap'
 );
 // Allowances breakdown snapshot (JSON) — added for allowance/bonus engine
 await safeAlter(
  pool,
  'ALTER TABLE tbl_hms_payroll_record ADD COLUMN allowances_snap TEXT NULL AFTER payout_status'
 );
 // Tax-free allowances (roster-based Night Duty + On-Call) — excluded from taxable gross,
 // added back on top of net. Stored alongside the headline gross_salary column.
 await safeAlter(
  pool,
  'ALTER TABLE tbl_hms_payroll_record ADD COLUMN non_taxable_allowance DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER allowances_snap'
 );

 await pool.query(`
  CREATE TABLE IF NOT EXISTS tbl_hms_pay_profile (
   id INT NOT NULL AUTO_INCREMENT,
   facility_id INT NOT NULL,
   employee_id INT NOT NULL,
   basic_salary DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   housing_allowance DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   transport_allowance DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   other_allowances DECIMAL(14,2) NOT NULL DEFAULT 0.00,
   hire_date DATE NULL DEFAULT NULL,
   sector VARCHAR(40) NOT NULL DEFAULT 'medical',
   night_shifts_per_month SMALLINT NOT NULL DEFAULT 0,
   on_call_per_month SMALLINT NOT NULL DEFAULT 0,
   updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
   PRIMARY KEY (id),
   UNIQUE KEY uq_hms_pay_prof (facility_id, employee_id),
   KEY idx_pay_prof_fac (facility_id),
   KEY idx_pay_prof_emp (employee_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
 `).catch(() => {});

 // Add new columns to existing pay_profile tables (safe migration)
 await safeAlter(pool, 'ALTER TABLE tbl_hms_pay_profile ADD COLUMN hire_date DATE NULL DEFAULT NULL');
 await safeAlter(pool, "ALTER TABLE tbl_hms_pay_profile ADD COLUMN sector VARCHAR(40) NOT NULL DEFAULT 'medical'");
 await safeAlter(pool, 'ALTER TABLE tbl_hms_pay_profile ADD COLUMN night_shifts_per_month SMALLINT NOT NULL DEFAULT 0');
 await safeAlter(pool, 'ALTER TABLE tbl_hms_pay_profile ADD COLUMN on_call_per_month SMALLINT NOT NULL DEFAULT 0');
 // Medical-specific allowance columns (replace generic other_allowances split)
 await safeAlter(pool, 'ALTER TABLE tbl_hms_pay_profile ADD COLUMN medical_risk_allowance INT NOT NULL DEFAULT 0 COMMENT "Flat monthly medical risk / hardship premium (XAF)"');
 await safeAlter(pool, 'ALTER TABLE tbl_hms_pay_profile ADD COLUMN responsibility_allowance INT NOT NULL DEFAULT 0 COMMENT "Flat monthly responsibility / specialist supplement (XAF)"');
 // Specialist flag — enables Specialist Research Allowance (15%) for doctors
 await safeAlter(pool, 'ALTER TABLE tbl_hms_pay_profile ADD COLUMN is_specialist TINYINT(1) NOT NULL DEFAULT 0 COMMENT "1 = specialist-grade doctor (Surgeon, Cardiologist, etc.) — unlocks Specialist Research Allowance"');

 await pool.query(`
  CREATE TABLE IF NOT EXISTS tbl_hr_attendance (
   id INT AUTO_INCREMENT PRIMARY KEY,
   employee_id INT NOT NULL,
   attendance_date DATE NOT NULL,
   status VARCHAR(24) DEFAULT 'present',
   check_in_time TIME NULL,
   check_out_time TIME NULL,
   UNIQUE KEY uq_emp_day (employee_id, attendance_date),
   KEY idx_day (attendance_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
 `).catch(() => {});

 await pool.query(`
  CREATE TABLE IF NOT EXISTS tbl_hms_attendance (
   id INT NOT NULL AUTO_INCREMENT,
   facility_id INT NOT NULL,
   employee_id INT NOT NULL,
   att_date DATE NOT NULL,
   check_in_time TIME NULL,
   check_out_time TIME NULL,
   status VARCHAR(24) NOT NULL DEFAULT 'present',
   notes VARCHAR(500) NULL DEFAULT NULL,
   PRIMARY KEY (id),
   UNIQUE KEY uq_hms_att (facility_id, employee_id, att_date),
   KEY idx_hms_att_fac_date (facility_id, att_date),
   KEY idx_hms_att_emp (employee_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
 `).catch(() => {});

 try {
  await pool.query(`
   INSERT IGNORE INTO tbl_hms_attendance (facility_id, employee_id, att_date, check_in_time, check_out_time, status)
   SELECT 1, employee_id, attendance_date, check_in_time, check_out_time, status FROM tbl_hr_attendance
  `);
 } catch (e) {
  /* ignore if legacy table missing */
 }

 await pool.query(`
  CREATE TABLE IF NOT EXISTS tbl_hms_leave_balance (
   id INT NOT NULL AUTO_INCREMENT,
   facility_id INT NOT NULL,
   employee_id INT NOT NULL,
   leave_type VARCHAR(24) NOT NULL,
   year SMALLINT NOT NULL,
   balance DECIMAL(6,2) NOT NULL DEFAULT 0.00,
   PRIMARY KEY (id),
   UNIQUE KEY uq_hms_leave_bal (facility_id, employee_id, leave_type, year),
   KEY idx_leave_bal_fac (facility_id),
   KEY idx_leave_bal_emp (employee_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
 `).catch(() => {});

 await pool.query(`
  CREATE TABLE IF NOT EXISTS tbl_hms_leave_request (
   id INT NOT NULL AUTO_INCREMENT,
   facility_id INT NOT NULL,
   employee_id INT NOT NULL,
   leave_type VARCHAR(24) NOT NULL DEFAULT 'annual',
   start_date DATE NOT NULL,
   end_date DATE NOT NULL,
   days_requested DECIMAL(6,2) NOT NULL,
   status VARCHAR(16) NOT NULL DEFAULT 'pending',
   reason TEXT NULL,
   approved_by INT NULL,
   created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
   PRIMARY KEY (id),
   KEY idx_hms_leave_fac_st (facility_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
 `).catch(() => {});

 await pool.query(`
  CREATE TABLE IF NOT EXISTS tbl_hms_holiday (
   id INT NOT NULL AUTO_INCREMENT,
   facility_id INT NOT NULL,
   holiday_name VARCHAR(120) NOT NULL,
   holiday_date DATE NOT NULL,
   is_recurring TINYINT(1) NOT NULL DEFAULT 1,
   PRIMARY KEY (id),
   KEY idx_hms_hol_fac_date (facility_id, holiday_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
 `).catch(() => {});

 const y = new Date().getFullYear();
 const [[cnt]] = await pool
  .query(
   'SELECT COUNT(*) AS c FROM tbl_hms_payroll_settings WHERE facility_id = 1'
  )
  .catch(() => [[{ c: 1 }]]);
 if (!cnt || Number(cnt.c) === 0) {
  await pool
   .query(
    `INSERT INTO tbl_hms_payroll_settings (
    facility_id, tax_year, cnps_employee_rate, cimr_employee_rate, crtv_rate,
    council_tax_rate, development_tax_rate, cnhc_rate, tax_brackets
   ) VALUES (?,?,2.8,2.4,0.2,0.8,0.5,0.5,?)`,
    [1, y, defaultBracketsJson()]
   )
   .catch(() => {});
 }

 // Allowances & Bonuses settings — per facility, per sector
 await pool.query(`
  CREATE TABLE IF NOT EXISTS tbl_hms_allowance_settings (
   id INT NOT NULL AUTO_INCREMENT,
   facility_id INT NOT NULL,
   sector VARCHAR(40) NOT NULL DEFAULT 'medical',
   code VARCHAR(40) NOT NULL,
   label VARCHAR(120) NOT NULL DEFAULT '',
   label_fr VARCHAR(120) NOT NULL DEFAULT '',
   calc_type VARCHAR(20) NOT NULL DEFAULT 'none',
   enabled TINYINT(1) NOT NULL DEFAULT 1,
   pct_value DECIMAL(8,3) NULL,
   fixed_amount DECIMAL(14,2) NULL,
   per_unit_amount DECIMAL(14,2) NULL,
   cap_pct DECIMAL(8,3) NULL,
   cap_amount DECIMAL(14,2) NULL,
   applies_to_roles TEXT NULL,
   legal_basis VARCHAR(255) NOT NULL DEFAULT '',
   description TEXT NULL,
   sort_order SMALLINT NOT NULL DEFAULT 99,
   updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
   PRIMARY KEY (id),
   UNIQUE KEY uq_hms_allow_fac_sec_code (facility_id, sector, code),
   KEY idx_hms_allow_fac_sec (facility_id, sector)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
 `).catch(() => {});

 await pool.query(`
  CREATE TABLE IF NOT EXISTS tbl_hms_dipe_history (
   id INT NOT NULL AUTO_INCREMENT,
   facility_id INT NOT NULL,
   month TINYINT NOT NULL,
   year SMALLINT NOT NULL,
   filename VARCHAR(255) NOT NULL,
   file_path VARCHAR(512) NOT NULL DEFAULT '',
   generated_by INT NOT NULL DEFAULT 0,
   created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
   PRIMARY KEY (id),
   KEY idx_hms_dipe_fac_ym (facility_id, year, month)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
 `).catch(() => {});
};
