'use strict';

/** Core hospital account roles (numeric ids in tbl_employee.role). */
const SUPER_ADMIN_ROLE = '99';
const SYSTEM_ADMIN_ROLE = '1';
const PROTECTED_ACCOUNT_ROLES = Object.freeze([SYSTEM_ADMIN_ROLE, SUPER_ADMIN_ROLE]);

function normalizeRole(role) {
  return String(role ?? '').trim();
}

function isSuperAdminRole(role) {
  return normalizeRole(role) === SUPER_ADMIN_ROLE;
}

function isSystemAdminRole(role) {
  return normalizeRole(role) === SYSTEM_ADMIN_ROLE;
}

function isPrivilegedAccountRole(role) {
  return PROTECTED_ACCOUNT_ROLES.includes(normalizeRole(role));
}

/** Admin (1) and Super Admin (99) — managed under System Users, not Employees. */
function isSystemUserRole(role) {
  return isPrivilegedAccountRole(role);
}

const EMPLOYEE_DIRECTORY_ROLE_SQL = "CAST(e.role AS CHAR) NOT IN ('1','99')";
const SYSTEM_USER_ROLE_SQL = "CAST(e.role AS CHAR) IN ('1','99')";

/**
 * Reusable visiting-doctor slots (VD1, VD2, …) in idle state are not hospital headcount.
 * Active visiting doctors on assignment are included.
 */
const VISITING_DOCTOR_POOL_EXCLUDE_SQL = `NOT (
  UPPER(e.username) REGEXP '^VD[0-9]+$'
  AND COALESCE(e.visiting_account_status, 'idle') != 'active'
)`;

const STAFF_HEADCOUNT_SQL = `${EMPLOYEE_DIRECTORY_ROLE_SQL} AND ${VISITING_DOCTOR_POOL_EXCLUDE_SQL}`;

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ activeOnly?: boolean }} [opts]
 */
async function countStaffHeadcount(pool, opts = {}) {
  const activeOnly = opts.activeOnly !== false;
  const where = activeOnly ? `e.status = 1 AND ${STAFF_HEADCOUNT_SQL}` : STAFF_HEADCOUNT_SQL;
  const [[row]] = await pool
    .query(`SELECT COUNT(*) AS total FROM tbl_employee e WHERE ${where}`)
    .catch(() => [[{ total: 0 }]]);
  return parseInt(row?.total, 10) || 0;
}

/**
 * Super Admin (99) may manage every account.
 * System Admin (1) may manage all except Super Admin (99).
 * Other roles must not manage System Admin or Super Admin accounts.
 */
function canManageEmployeeAccount(actorRole, targetRole) {
  const actor = normalizeRole(actorRole);
  const target = normalizeRole(targetRole);
  if (actor === SUPER_ADMIN_ROLE) return true;
  if (actor === SYSTEM_ADMIN_ROLE) return target !== SUPER_ADMIN_ROLE;
  return !isPrivilegedAccountRole(target);
}

/** Whether actor may assign `newRole` when creating or editing an employee. */
function canAssignEmployeeRole(actorRole, newRole) {
  const actor = normalizeRole(actorRole);
  const next = normalizeRole(newRole);
  if (!next) return true;
  if (actor === SUPER_ADMIN_ROLE) return true;
  if (actor === SYSTEM_ADMIN_ROLE) return next !== SUPER_ADMIN_ROLE;
  return !isPrivilegedAccountRole(next);
}

function manageDeniedMessage(actorRole, targetRole) {
  const actor = normalizeRole(actorRole);
  const target = normalizeRole(targetRole);
  if (actor === SYSTEM_ADMIN_ROLE && target === SUPER_ADMIN_ROLE) {
    return 'System Admin cannot manage Super Admin accounts.';
  }
  if (isPrivilegedAccountRole(target)) {
    return 'You cannot manage System Admin or Super Admin accounts.';
  }
  return 'You cannot manage this account.';
}

function assignDeniedMessage(actorRole, newRole) {
  const actor = normalizeRole(actorRole);
  const next = normalizeRole(newRole);
  if (actor === SYSTEM_ADMIN_ROLE && next === SUPER_ADMIN_ROLE) {
    return 'Only Super Admin can assign the Super Admin role.';
  }
  if (isPrivilegedAccountRole(next)) {
    return 'You cannot assign System Admin or Super Admin roles.';
  }
  return 'You cannot assign this role.';
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status || 403;
  return err;
}

function assertCanManageEmployeeAccount(actorRole, targetRole) {
  if (!canManageEmployeeAccount(actorRole, targetRole)) {
    throw httpError(manageDeniedMessage(actorRole, targetRole));
  }
}

function assertCanAssignEmployeeRole(actorRole, newRole) {
  if (!canAssignEmployeeRole(actorRole, newRole)) {
    throw httpError(assignDeniedMessage(actorRole, newRole));
  }
}

/** Filter role dropdown rows for create/edit forms. */
function filterAssignableRoles(actorRole, roles) {
  const actor = normalizeRole(actorRole);
  return (roles || []).filter((r) => {
    const code = normalizeRole(r.role != null ? r.role : r);
    if (actor === SUPER_ADMIN_ROLE) return true;
    if (actor === SYSTEM_ADMIN_ROLE) return code !== SUPER_ADMIN_ROLE;
    return !isPrivilegedAccountRole(code);
  });
}

/** Staff directory forms — exclude Admin / Super Admin roles. */
function filterStaffDirectoryRoles(actorRole, roles) {
  return filterAssignableRoles(actorRole, roles).filter(
    (r) => !isSystemUserRole(r.role != null ? r.role : r)
  );
}

/** System Users forms — Admin and Super Admin only. */
function filterSystemUserRoles(actorRole, roles) {
  const actor = normalizeRole(actorRole);
  return (roles || []).filter((r) => {
    const code = normalizeRole(r.role != null ? r.role : r);
    if (code !== SYSTEM_ADMIN_ROLE && code !== SUPER_ADMIN_ROLE) return false;
    if (actor === SUPER_ADMIN_ROLE) return true;
    if (actor === SYSTEM_ADMIN_ROLE) return code === SYSTEM_ADMIN_ROLE;
    return false;
  });
}

let cachedDirectorRoleId = undefined;

/** Hospital Director role id from tbl_role (cached per process). */
async function resolveDirectorRoleId(pool) {
  if (cachedDirectorRoleId !== undefined) return cachedDirectorRoleId || null;
  try {
    const [[dirRow]] = await pool.query(
      `SELECT CAST(role AS CHAR) AS role FROM tbl_role
        WHERE LOWER(title) LIKE '%director%'
          AND LOWER(title) NOT LIKE '%deputy%'
        ORDER BY role LIMIT 1`
    );
    cachedDirectorRoleId = dirRow && dirRow.role != null ? String(dirRow.role) : '';
  } catch (_) {
    cachedDirectorRoleId = '';
  }
  return cachedDirectorRoleId || null;
}

function invalidateDirectorRoleCache() {
  cachedDirectorRoleId = undefined;
}

/** Super Admin, System Admin, or Hospital Director may delete employee accounts. */
function canDeleteEmployeeAccount(actorRole, directorRoleId) {
  const actor = normalizeRole(actorRole);
  if (actor === SUPER_ADMIN_ROLE || actor === SYSTEM_ADMIN_ROLE) return true;
  const director = normalizeRole(directorRoleId);
  return !!director && actor === director;
}

/** Only System Admin (1) and Super Admin (99) may permanently delete patient records. */
function canDeletePatientAccount(actorRole) {
  return isPrivilegedAccountRole(actorRole);
}

/** Whether actor may set or reset login password for target (ACL `employee.password.manage`). */
function canManageEmployeePassword(actorRole, targetRole, perms) {
  if (!canManageEmployeeAccount(actorRole, targetRole)) return false;
  const p = perms || [];
  if (p.includes('*')) {
    if (isSuperAdminRole(targetRole) && normalizeRole(actorRole) !== SUPER_ADMIN_ROLE) return false;
    return true;
  }
  if (!p.includes('employee.password.manage')) return false;
  if (isSuperAdminRole(targetRole) && normalizeRole(actorRole) !== SUPER_ADMIN_ROLE) return false;
  return true;
}

module.exports = {
  SUPER_ADMIN_ROLE,
  SYSTEM_ADMIN_ROLE,
  PROTECTED_ACCOUNT_ROLES,
  normalizeRole,
  isSuperAdminRole,
  isSystemAdminRole,
  isPrivilegedAccountRole,
  isSystemUserRole,
  EMPLOYEE_DIRECTORY_ROLE_SQL,
  SYSTEM_USER_ROLE_SQL,
  VISITING_DOCTOR_POOL_EXCLUDE_SQL,
  STAFF_HEADCOUNT_SQL,
  countStaffHeadcount,
  canManageEmployeeAccount,
  canAssignEmployeeRole,
  manageDeniedMessage,
  assignDeniedMessage,
  assertCanManageEmployeeAccount,
  assertCanAssignEmployeeRole,
  filterAssignableRoles,
  filterStaffDirectoryRoles,
  filterSystemUserRoles,
  resolveDirectorRoleId,
  invalidateDirectorRoleCache,
  canDeleteEmployeeAccount,
  canDeletePatientAccount,
  canManageEmployeePassword,
};
