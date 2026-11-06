'use strict';

/**
 * Statutory payroll defaults per CNPS regime and activity sector.
 *
 * The employee-side deductions below are the rates set by Cameroonian payroll
 * law and do not change between CNPS regimes; regimes differ on the employer
 * branch rates, which are not deducted from the payslip. Sector rules mostly
 * change the allowances a company must pay (see hmsAllowanceCameroon), so the
 * sector is carried in the preset for clarity and used to describe what was
 * applied. Every value is only a starting point — the settings screen keeps
 * all rates and brackets editable, and whatever the user saves is what payroll
 * uses.
 */

const { DEFAULT_IRPP_BRACKETS, DEFAULT_IRPP_RATES } = require('./hmsPayrollCameroon');

const REGIME_LABELS = Object.freeze({
  1: 'General',
  2: 'Agriculture',
  3: 'Public',
  4: 'Mining',
});

const SECTOR_LABELS = Object.freeze({
  medical: 'Medical / Health',
  education: 'Education',
  banking: 'Banking & Finance',
  commerce: 'Commerce & Industry',
  building: 'Building & Civil Works',
  hotels: 'Hotels & Tourism',
  transport: 'Transport & Logistics',
  mining: 'Mining & Quarrying',
});

const STATUTORY_RATES = Object.freeze({
  cnps_employee_rate: 4.2, // CNPS pension, employee share
  cimr_employee_rate: 1.0, // CFC — Crédit Foncier
  crtv_rate: 0,            // CRTV royalty, fixed scale
  council_tax_rate: 0,     // Council tax, fixed scale
  development_tax_rate: 1.0, // FNE
  cnhc_rate: 0,            // CAC — 10% of IRPP, computed
});

const STATUTORY_IRPP = Object.freeze([...DEFAULT_IRPP_RATES]);

const REGIME_NOTES = Object.freeze({
  1: 'General regime: CNPS pension 4.2%, CFC 1%, FNE 1%, IRPP progressive 10/15/25/35%.',
  2: 'Agricultural regime: employee deductions match the General regime; employer branch rates differ and are not deducted from the payslip.',
  3: 'Public regime: employee deductions match the General regime; confirm any special scheme with the employer before filing.',
  4: 'Mining: CNPS has no separate mining regime, so employee deductions follow the General regime. Mining premiums (site risk, remote site) are configured under Allowances for the Mining sector.',
});

const SECTOR_NOTES = Object.freeze({
  mining: 'Mining sector: site risk, remote-site and roster transport allowances are available under Allowances & Bonuses.',
});

function presetFor(regime, sector) {
  const reg = String(regime || '1');
  const sec = String(sector || 'medical').toLowerCase();
  return {
    regime: reg,
    regimeLabel: REGIME_LABELS[reg] || `Regime ${reg}`,
    sector: sec,
    sectorLabel: SECTOR_LABELS[sec] || sec,
    rates: { ...STATUTORY_RATES },
    irppBrackets: DEFAULT_IRPP_BRACKETS.map((bracket) => ({ ...bracket })),
    irppRates: [...STATUTORY_IRPP],
    note: REGIME_NOTES[reg] || REGIME_NOTES[1],
    sectorNote: SECTOR_NOTES[sec] || '',
  };
}

/** Every regime × sector combination, for the settings screen. */
function allPresets() {
  const out = {};
  for (const reg of Object.keys(REGIME_LABELS)) {
    for (const sec of Object.keys(SECTOR_LABELS)) {
      out[`${reg}|${sec}`] = presetFor(reg, sec);
    }
  }
  return out;
}

module.exports = {
  REGIME_LABELS,
  SECTOR_LABELS,
  STATUTORY_RATES,
  STATUTORY_IRPP,
  presetFor,
  allPresets,
};
