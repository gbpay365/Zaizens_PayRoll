'use strict';

/**
 * Gross ⇄ net compensation builder (single source of truth).
 *
 * Used by:
 *   • POST /payroll/profiles/auto-compute  (pay-profile calculator)
 *   • POST /payroll/employees/preview      (live preview on the new-employee form)
 *   • POST /payroll/employees/new          (employee + pay profile + first payslip)
 *   • GET  /payroll/employees/:id          (employee compensation breakdown)
 *
 * Rules (Cameroon, see lib/hmsPayrollCameroon.js):
 *   Basic + Housing (15 % of basic) + Transport (10 % of basic) + allowances = gross.
 *   Roster allowances night_duty / on_call are paid on top and are NOT taxable,
 *   matching how /payroll/process-month creates payroll records.
 */

const { hmsPayrollCameroonCalculate } = require('./hmsPayrollCameroon');
const { computeAllowances } = require('./hmsAllowanceCameroon');

const HOUSING_PCT = 0.15;
const TRANSPORT_PCT = 0.10;
const TAX_FREE_ALLOWANCE_CODES = new Set(['night_duty', 'on_call']);

function roundXaf(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

function splitAllowanceLines(lines) {
  const all = Array.isArray(lines) ? lines : [];
  const taxable = all.filter((l) => !TAX_FREE_ALLOWANCE_CODES.has(l.code));
  const taxFree = all.filter((l) => TAX_FREE_ALLOWANCE_CODES.has(l.code));
  const sum = (rows) => rows.reduce((s, l) => s + (roundXaf(l.amount) || 0), 0);
  return { all, taxable, taxFree, taxableTotal: sum(taxable), taxFreeTotal: sum(taxFree) };
}

/** Build the full compensation picture for a given basic salary. */
function breakdownFromBasic(basic, ctx = {}) {
  const b = Math.max(0, roundXaf(basic));
  const housing = roundXaf(b * HOUSING_PCT);
  const transport = roundXaf(b * TRANSPORT_PCT);
  const allow = computeAllowances({
    basicSalary: b,
    role: ctx.role,
    roleTitle: ctx.roleTitle || '',
    hireDate: ctx.hireDate || null,
    settings: ctx.settings || [],
    nightShifts: ctx.nightShifts || 0,
    onCallShifts: ctx.onCallShifts || 0,
    isSpecialist: Boolean(ctx.isSpecialist),
  });
  const split = splitAllowanceLines(allow.lines);
  const taxableGross = b + housing + transport + split.taxableTotal;
  const gross = taxableGross + split.taxFreeTotal;
  return {
    basic_salary: b,
    housing_allowance: housing,
    transport_allowance: transport,
    allowance_lines: split.all,
    allowance_total: split.taxableTotal + split.taxFreeTotal,
    allowance_taxable_total: split.taxableTotal,
    allowance_tax_free_total: split.taxFreeTotal,
    taxable_gross: taxableGross,
    gross,
  };
}

/** Solve Basic so the resulting total gross matches the target (Newton on the flat slope). */
function solveBasicForGross(targetGross, ctx = {}) {
  const target = Math.max(0, roundXaf(targetGross));
  if (target <= 0) return 0;
  let basic = target / 1.5;
  for (let i = 0; i < 40; i += 1) {
    const cur = breakdownFromBasic(basic, ctx);
    const diff = target - cur.gross;
    if (Math.abs(diff) < 1) break;
    const step = breakdownFromBasic(basic + 1000, ctx);
    const slope = (step.gross - cur.gross) / 1000;
    if (!Number.isFinite(slope) || slope <= 0) break;
    basic = Math.max(0, basic + diff / slope);
  }
  return Math.max(0, roundXaf(basic));
}

function deductionLinesFromTax(tax) {
  if (!tax) return [];
  return [
    { code: 'cnps', label: 'CNPS pension (4.2%)', amount: roundXaf(tax.cnps_employee) },
    { code: 'cfc', label: 'CFC — Crédit Foncier (1%)', amount: roundXaf(tax.cimr_employee) },
    { code: 'crtv', label: 'CRTV royalty', amount: roundXaf(tax.crtv_deduction) },
    { code: 'council', label: 'Council tax (Taxe Communale)', amount: roundXaf(tax.council_tax_deduction) },
    { code: 'fne', label: "FNE — Fonds National de l'Emploi (1%)", amount: roundXaf(tax.development_tax_deduction) },
    { code: 'irpp', label: 'IRPP — income tax', amount: roundXaf(tax.income_tax) },
    { code: 'cac', label: 'CAC — 10% surcharge on IRPP', amount: roundXaf(tax.cnhc_deduction) },
  ];
}

async function computeStatutory(pool, facilityId, taxYear, taxableGross) {
  const tax = await hmsPayrollCameroonCalculate(pool, facilityId, taxYear, taxableGross);
  if (!tax) return null;
  const lines = deductionLinesFromTax(tax).filter((l) => l.amount > 0);
  return {
    tax,
    net_taxable: roundXaf(tax.net_salary),
    taxable_income: roundXaf(tax.taxable_income),
    deduction_lines: lines,
    deductions: {
      cnps: roundXaf(tax.cnps_employee),
      cfc: roundXaf(tax.cimr_employee),
      crtv: roundXaf(tax.crtv_deduction),
      council: roundXaf(tax.council_tax_deduction),
      fne: roundXaf(tax.development_tax_deduction),
      irpp: roundXaf(tax.income_tax),
      cac: roundXaf(tax.cnhc_deduction),
      total: lines.reduce((s, l) => s + l.amount, 0),
    },
  };
}

function present(breakdown, statutory) {
  const net = statutory
    ? roundXaf(statutory.net_taxable + breakdown.allowance_tax_free_total)
    : null;
  return {
    ...breakdown,
    net,
    taxable_income: statutory ? statutory.taxable_income : null,
    deduction_lines: statutory ? statutory.deduction_lines : [],
    deductions: statutory ? statutory.deductions : null,
    statutory_ready: Boolean(statutory),
  };
}

/**
 * Compute a full compensation package from a target gross salary.
 * ctx: { role, roleTitle, hireDate, settings, isSpecialist, nightShifts, onCallShifts }
 */
async function computeFromGross(pool, facilityId, taxYear, gross, ctx = {}) {
  const basic = solveBasicForGross(gross, ctx);
  const breakdown = breakdownFromBasic(basic, ctx);
  const statutory = await computeStatutory(pool, facilityId, taxYear, breakdown.taxable_gross);
  return present(breakdown, statutory);
}

/**
 * Compute from a target NET (take-home). Bisection on the statutory engine, then
 * the same breakdown, so gross/basic stay consistent with computeFromGross.
 */
async function computeFromNet(pool, facilityId, taxYear, targetNet, ctx = {}) {
  const target = Math.max(0, roundXaf(targetNet));
  if (target <= 0) return computeFromGross(pool, facilityId, taxYear, 0, ctx);
  let lo = target;
  let hi = target * 3;
  let guess = target * 1.3;
  for (let i = 0; i < 40; i += 1) {
    const bd = breakdownFromBasic(solveBasicForGross(guess, ctx), ctx);
    const tax = await computeStatutory(pool, facilityId, taxYear, bd.taxable_gross);
    if (!tax) return computeFromGross(pool, facilityId, taxYear, guess, ctx);
    const net = tax.net_taxable + bd.allowance_tax_free_total;
    if (Math.abs(net - target) < 1) break;
    if (net < target) lo = guess;
    else hi = guess;
    guess = (lo + hi) / 2;
  }
  return computeFromGross(pool, facilityId, taxYear, guess, ctx);
}

/**
 * Recompute the statutory part of an existing stored pay profile
 * (basic/housing/transport are authoritative in the profile).
 */
async function computeFromProfile(pool, facilityId, taxYear, profile, ctx = {}) {
  const b = Math.max(0, roundXaf(profile.basic_salary));
  const h = Math.max(0, roundXaf(profile.housing_allowance));
  const t = Math.max(0, roundXaf(profile.transport_allowance));
  const allow = computeAllowances({
    basicSalary: b,
    role: ctx.role,
    roleTitle: ctx.roleTitle || '',
    hireDate: ctx.hireDate || null,
    settings: ctx.settings || [],
    nightShifts: ctx.nightShifts || 0,
    onCallShifts: ctx.onCallShifts || 0,
    isSpecialist: Boolean(ctx.isSpecialist),
  });
  const split = splitAllowanceLines(allow.lines);
  const taxableGross = b + h + t + split.taxableTotal;
  const statutory = await computeStatutory(pool, facilityId, taxYear, taxableGross);
  return present(
    {
      basic_salary: b,
      housing_allowance: h,
      transport_allowance: t,
      allowance_lines: split.all,
      allowance_total: split.taxableTotal + split.taxFreeTotal,
      allowance_taxable_total: split.taxableTotal,
      allowance_tax_free_total: split.taxFreeTotal,
      taxable_gross: taxableGross,
      gross: taxableGross + split.taxFreeTotal,
    },
    statutory
  );
}

module.exports = {
  HOUSING_PCT,
  TRANSPORT_PCT,
  TAX_FREE_ALLOWANCE_CODES,
  breakdownFromBasic,
  solveBasicForGross,
  computeStatutory,
  computeFromGross,
  computeFromNet,
  computeFromProfile,
};
