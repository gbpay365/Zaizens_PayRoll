-- Zaizens Payroll — XAMPP MySQL database
CREATE DATABASE IF NOT EXISTS zaizens_payroll
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE zaizens_payroll;

-- Minimal bootstrap; full tables are created by ensureHrPayrollSchema / ensureEmployeeHrSchema on first run.
