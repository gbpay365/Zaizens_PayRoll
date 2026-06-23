'use strict';

/** Odoo-style full-module UI for back-office apps (not the hospital-wide shell). */
const TAX_MODULE_PREFIXES = ['/tax'];
const PAYROLL_PREFIXES = ['/payroll'];
const HR_SELF_PREFIXES = [
  '/hr/my-payslips',
  '/hr/request-leave',
  '/hr/my-attendance',
  '/hr/my-leave-balance',
];

function startsWithAny(path, list) {
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (path === p || path.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * @param {string} path
 * @returns {'accounting'|'payroll'|'hr'|''}
 */
function moduleFromPath(path) {
  const p = String(path || '').split('?')[0];
  if (startsWithAny(p, TAX_MODULE_PREFIXES)) return 'accounting';
  if (startsWithAny(p, PAYROLL_PREFIXES)) return 'payroll';
  if (startsWithAny(p, HR_SELF_PREFIXES)) return 'hr';
  if (p === '/hr' || p.startsWith('/hr/')) return 'payroll';
  return '';
}

function bodyClass(module) {
  const m = String(module || '');
  if (!m) return '';
  return 'hms-body--module-odoo hms-body--odoo-' + m;
}

module.exports = {
  moduleFromPath,
  bodyClass,
};
