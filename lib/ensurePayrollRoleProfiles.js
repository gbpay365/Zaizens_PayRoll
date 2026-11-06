'use strict';

/**
 * Standard payroll/HR access profiles.
 *
 * The application provisions System Admin (1) and Super Admin (99) out of the
 * box. Payroll and HR teams need narrower, ready-made roles instead of being
 * given administrator access:
 *
 *   120  Payroll Officer  — prepare and post payroll, view staff and tax.
 *   121  HR Officer       — manage staff records, leave and HR self-service.
 *
 * Roles are created once and their permission grants are idempotent. No user
 * account is created here; an administrator assigns the role from Admin →
 * Accounts.
 */

const PROFILES = [
  {
    role: '120',
    title: 'Payroll Officer',
    permissions: [
      'dashboard.read',
      'payroll.read',
      'payroll.write',
      'employee.read',
      'accounting.read',
      'hr.self.read',
      'profile.self.write',
    ],
  },
  {
    role: '121',
    title: 'HR Officer',
    permissions: [
      'dashboard.read',
      'payroll.read',
      'employee.read',
      'employee.write',
      'hr.leave.approve',
      'hr.self.read',
      'profile.self.write',
    ],
  },
];

module.exports = async function ensurePayrollRoleProfiles(pool) {
  if (!pool) return PROFILES;

  for (const profile of PROFILES) {
    await pool.query(
      `INSERT INTO tbl_role (role, title)
       SELECT ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM tbl_role WHERE role = ?)`,
      [profile.role, profile.title, profile.role]
    );

    for (const code of profile.permissions) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
        [profile.role, code]
      );
    }
  }

  return PROFILES;
};

module.exports.PROFILES = PROFILES;
