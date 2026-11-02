'use strict';

/**
 * The company that owns this payroll deployment. Payslips, statutory reports
 * and HR documents carry this identity rather than the product name.
 */
const COMPANY = Object.freeze({
  legalName: 'Caminco S.A.',
  shortName: 'Caminco',
  groupName: 'Cameroon Mining Company',
  tagline: 'Cameroon Mining Company',
  payslipDepartment: 'Human Resources Department – Payroll Unit',
  logoPath: '/img/caminco-mark.svg',
});

module.exports = COMPANY;
