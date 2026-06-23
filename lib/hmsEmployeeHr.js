'use strict';

const { toIsoDatePart, formatDisplayDate } = require('./hmsFormatDate');

/** Mask bank account for payslip display (e.g. **** **** 7821). */
function maskBankAccount(accountNo) {
  const digits = String(accountNo || '').replace(/\D/g, '');
  if (!digits) return '—';
  const last4 = digits.slice(-4);
  return '**** **** ' + last4;
}

function parseEmployeeHrFields(body) {
  const b = body || {};
  return {
    job_title: String(b.job_title || '').trim().slice(0, 120),
    cnps_number: String(b.cnps_number || '').trim().slice(0, 32),
    tax_niu: String(b.tax_niu || '').trim().slice(0, 32),
    nic_number: String(b.nic_number || '').trim().slice(0, 32),
    bank_name: String(b.bank_name || '').trim().slice(0, 120),
    bank_account_no: String(b.bank_account_no || '').trim().slice(0, 40),
  };
}

function displayPosition(emp, roleTitle) {
  const jt = String((emp && emp.job_title) || '').trim();
  if (jt) return jt;
  return String(roleTitle || '').trim() || '—';
}

/** ISO date (YYYY-MM-DD) or null — accepts DD/MM/YYYY, YYYY-MM-DD, and Date objects. */
function normalizeDateOnly(val) {
  const iso = toIsoDatePart(val);
  return iso || null;
}

/** Prefer employee joining_date; fall back to legacy pay-profile hire_date. */
function resolveHireDate(joiningDate, profileHireDate) {
  return normalizeDateOnly(joiningDate) || normalizeDateOnly(profileHireDate) || null;
}

/** DD/MM/YYYY for UI, or em dash when missing. */
function formatHireDateDisplay(joiningDate, profileHireDate) {
  const iso = resolveHireDate(joiningDate, profileHireDate);
  return iso ? formatDisplayDate(iso) : '—';
}

/**
 * Build role id → title map from tbl_role (string keys).
 * @param {import('mysql2/promise').Pool} pool
 */
async function loadRoleTitleMap(pool) {
  const map = {
    1: 'Admin',
    2: 'Doctor',
    3: 'Front Desk',
    4: 'Lab',
    5: 'Pharmacy',
    6: 'Radiology',
    7: 'Nurse',
    8: 'Nursing Aid',
    9: 'Accountant',
    11: 'Cashier',
    99: 'Super Admin',
  };
  try {
    const [rows] = await pool.query(
      `SELECT CAST(role AS CHAR) AS role_key, MIN(title) AS title
       FROM tbl_role GROUP BY role`
    );
    for (const r of rows || []) {
      const k = String(r.role_key ?? r.role ?? '').trim();
      const t = String(r.title || '').trim();
      if (k && t) map[k] = t;
    }
  } catch (_) { /* optional */ }
  return map;
}

function resolveRoleTitle(roleId, roleTitleMap) {
  const rk = String(roleId ?? '').trim();
  if (!rk) return '—';
  const map = roleTitleMap || {};
  return map[rk] || map[parseInt(rk, 10)] || rk;
}

module.exports = {
  maskBankAccount,
  parseEmployeeHrFields,
  displayPosition,
  normalizeDateOnly,
  resolveHireDate,
  formatHireDateDisplay,
  loadRoleTitleMap,
  resolveRoleTitle,
};
