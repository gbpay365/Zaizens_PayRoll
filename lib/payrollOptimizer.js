'use strict';

/**
 * Cameroon payroll optimizer — statutory modelling engine.
 *
 * This is the calculation model used by the Payroll Optimizer screen. It keeps
 * the legal rules in one place so a proposal can be checked against the same
 * sector and CNPS regime that will be used to explain it:
 *
 *   • CNPS pension: 4.2% employee / 4.2% employer, capped at XAF 750,000/month
 *   • Family allowances: sector/regime rate on the CNPS base
 *   • Occupational risk: low 1.75%, medium 2.5%, high 5%
 *   • CFC: 1% employee / 1.5% employer of gross cash
 *   • FNE: 1% employer of gross cash
 *   • BIK ceilings: housing 15%, electricity 4%, water 2% of base salary
 *   • SMIG ceilings: meal 3×, dirtiness 13×, work clothing 7×, tools 10× hourly SMIG
 *   • Professional expenses: 30% of salary after CNPS, capped at XAF 400,000/month
 *   • Annual abatement: XAF 500,000; IRPP scale 11% / 16.5% / 27.5% / 38.5%
 *
 * The optimizer only proposes a composition. It never writes payroll records.
 */

const HOURS_PER_MONTH = 173.33;
const CNPS_CEILING = 750000;
const PROFESSIONAL_RATE = 0.3;
const PROFESSIONAL_CAP = 400000;
const ANNUAL_ABATEMENT = 500000;
const IRPP_THRESHOLD_MONTHLY = 62000;

const EMPLOYEE_PENSION_RATE = 0.042;
const EMPLOYER_PENSION_RATE = 0.042;
const EMPLOYEE_CFC_RATE = 0.01;
const EMPLOYER_CFC_RATE = 0.015;
const EMPLOYER_FNE_RATE = 0.01;

const SECTOR_PROFILES = {
  general: { label: 'General (private)', smig: 60000, familyRate: 0.07, defaultRisk: 'medium' },
  medical: { label: 'Medical / Health', smig: 60000, familyRate: 0.07, defaultRisk: 'medium' },
  education: { label: 'Private education', smig: 60000, familyRate: 0.037, defaultRisk: 'low' },
  agriculture: { label: 'Agriculture', smig: 45000, familyRate: 0.0565, defaultRisk: 'low' },
  domestic: { label: 'Domestic service', smig: 43969, familyRate: 0.07, defaultRisk: 'low' },
  banking: { label: 'Banking & Finance', smig: 60000, familyRate: 0.07, defaultRisk: 'low' },
  commerce: { label: 'Commerce & Industry', smig: 60000, familyRate: 0.07, defaultRisk: 'medium' },
  building: { label: 'Building & Civil Works', smig: 60000, familyRate: 0.07, defaultRisk: 'high' },
  hotels: { label: 'Hotels & Tourism', smig: 60000, familyRate: 0.07, defaultRisk: 'medium' },
  transport: { label: 'Transport & Logistics', smig: 60000, familyRate: 0.07, defaultRisk: 'medium' },
  mining: { label: 'Mining & Quarrying', smig: 45000, familyRate: 0.07, defaultRisk: 'high' },
};

const REGIME_PROFILES = {
  1: { label: 'General', familyRate: 0.07 },
  2: { label: 'Agriculture', familyRate: 0.0565 },
  3: { label: 'Public', familyRate: 0.07 },
  4: { label: 'Mining', familyRate: 0.07 },
};

const RISK_PROFILES = {
  low: { label: 'Low — 1.75%', rate: 0.0175 },
  medium: { label: 'Medium — 2.5%', rate: 0.025 },
  high: { label: 'High — 5%', rate: 0.05 },
};

const BIK_PROFILES = {
  housing: { pct: 0.15, label: 'Housing' },
  electricity: { pct: 0.04, label: 'Electricity' },
  water: { pct: 0.02, label: 'Water' },
};

const SMIG_PROFILES = {
  meal: { mult: 3, label: 'Meal' },
  dirtiness: { mult: 13, label: 'Dirtiness' },
  clothing: { mult: 7, label: 'Work clothing' },
  tools: { mult: 10, label: 'Tools' },
};

const ALLOWANCE_KEYS = [
  'transport',
  'representation',
  'housing',
  'electricity',
  'water',
  'meal',
  'dirtiness',
  'clothing',
  'tools',
  'other',
];

const IRPP_BRACKETS = [
  { min: 0, max: 2000000, rate: 0.11 },
  { min: 2000000, max: 3000000, rate: 0.165 },
  { min: 3000000, max: 5000000, rate: 0.275 },
  { min: 5000000, max: Infinity, rate: 0.385 },
];

const COUNCIL_TAX = [
  { min: 0, max: 62000, amount: 0 },
  { min: 62000, max: 100000, amount: 500 },
  { min: 100000, max: 200000, amount: 1000 },
  { min: 200000, max: 300000, amount: 1500 },
  { min: 300000, max: 500000, amount: 2000 },
  { min: 500000, max: Infinity, amount: 2520 },
];

const RAV = [
  { min: 0, max: 50000, amount: 0 },
  { min: 50000, max: 100000, amount: 750 },
  { min: 100000, max: 200000, amount: 1950 },
  { min: 200000, max: 300000, amount: 3250 },
  { min: 300000, max: 400000, amount: 4550 },
  { min: 400000, max: 500000, amount: 5850 },
  { min: 500000, max: 600000, amount: 7150 },
  { min: 600000, max: 700000, amount: 8450 },
  { min: 700000, max: 800000, amount: 9750 },
  { min: 800000, max: 1000000, amount: 11050 },
  { min: 1000000, max: Infinity, amount: 13000 },
];

function roundXaf(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

function sectorKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return SECTOR_PROFILES[key] ? key : 'general';
}

function regimeKey(value) {
  const key = String(value || '').trim();
  return REGIME_PROFILES[key] ? key : '1';
}

function riskKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return RISK_PROFILES[key] ? key : 'medium';
}

function resolveProfile(sector, regime, risk) {
  const sec = sectorKey(sector);
  const reg = regimeKey(regime);
  const sectorProfile = SECTOR_PROFILES[sec];
  const regimeProfile = REGIME_PROFILES[reg];
  // Education carries its own branch rate; otherwise the agricultural regime
  // moves the family rate to 5.65%, and every other combination uses the sector.
  const familyRate =
    sec === 'education'
      ? sectorProfile.familyRate
      : reg === '2'
        ? regimeProfile.familyRate
        : sectorProfile.familyRate;
  const riskValue = riskKey(risk || sectorProfile.defaultRisk);
  return {
    sector: sec,
    sectorLabel: sectorProfile.label,
    sectorProfile,
    regime: reg,
    regimeLabel: regimeProfile.label,
    regimeProfile,
    smig: sectorProfile.smig,
    familyRate,
    risk: riskValue,
    riskLabel: RISK_PROFILES[riskValue].label,
    riskRate: RISK_PROFILES[riskValue].rate,
  };
}

function normalizeAllowances(raw) {
  const out = {};
  for (const key of ALLOWANCE_KEYS) {
    out[key] = Math.max(0, roundXaf(raw && raw[key]));
  }
  return out;
}

function bandAmount(value, bands) {
  const v = Math.max(0, Number(value) || 0);
  for (const band of bands) {
    if (v > band.min && v <= band.max) return band.amount;
  }
  return 0;
}

function progressiveTax(income, brackets) {
  let tax = 0;
  const amount = Math.max(0, Number(income) || 0);
  for (const bracket of brackets) {
    if (amount <= bracket.min) break;
    tax += (Math.min(amount, bracket.max) - bracket.min) * bracket.rate;
  }
  return tax;
}

function statutoryCaps(baseSalary, smig) {
  const hourlySmig = smig / HOURS_PER_MONTH;
  return {
    hourlySmig,
    transport: Math.min(baseSalary * PROFESSIONAL_RATE, PROFESSIONAL_CAP),
    representation: Math.min(baseSalary * PROFESSIONAL_RATE, PROFESSIONAL_CAP),
    housing: baseSalary * BIK_PROFILES.housing.pct,
    electricity: baseSalary * BIK_PROFILES.electricity.pct,
    water: baseSalary * BIK_PROFILES.water.pct,
    meal: SMIG_PROFILES.meal.mult * hourlySmig,
    dirtiness: SMIG_PROFILES.dirtiness.mult * hourlySmig,
    clothing: SMIG_PROFILES.clothing.mult * hourlySmig,
    tools: SMIG_PROFILES.tools.mult * hourlySmig,
  };
}

function settingNumber(settings, key, fallback) {
  const value = parseFloat(settings && settings[key]);
  return Number.isFinite(value) ? value : fallback;
}

function computePayroll(input) {
  const baseSalary = Math.max(0, roundXaf(input && input.baseSalary));
  const allowances = normalizeAllowances(input && input.allowances);
  const profile = resolveProfile(input && input.sector, input && input.regime, input && input.risk);
  const caps = statutoryCaps(baseSalary, profile.smig);

  const grossCash =
    baseSalary + ALLOWANCE_KEYS.reduce((sum, key) => sum + (allowances[key] || 0), 0);

  const analysis = {};
  for (const key of Object.keys(SMIG_PROFILES)) {
    const limit = caps[key] || 0;
    analysis[key] = { limit, taxable: Math.max(0, allowances[key] - limit) };
    analysis[key].excess = analysis[key].taxable;
  }
  for (const key of Object.keys(BIK_PROFILES)) {
    const limit = caps[key] || 0;
    analysis[key] = { limit, taxable: Math.max(0, allowances[key] - limit) };
    analysis[key].excess = analysis[key].taxable;
  }

  // Transport, representation and residual "other" pay are fully taxable.
  // Only the portion of a capped allowance above its legal limit is taxable.
  let grossTaxable = baseSalary + allowances.transport + allowances.representation + allowances.other;
  for (const key of Object.keys(analysis)) grossTaxable += analysis[key].taxable;

  // CNPS includes BIK amounts and the taxable excess of SMIG allowances, but
  // excludes the exempt SMIG portions used for meal, dirtiness, clothing, tools.
  const cnpsBaseRaw =
    baseSalary +
    allowances.transport +
    allowances.representation +
    allowances.other +
    allowances.housing +
    allowances.electricity +
    allowances.water +
    analysis.meal.taxable +
    analysis.dirtiness.taxable +
    analysis.clothing.taxable +
    analysis.tools.taxable;
  const cnpsBase = Math.min(cnpsBaseRaw, CNPS_CEILING);
  const cnpsCapped = cnpsBaseRaw > CNPS_CEILING;

  const pensionEmployeeRate =
    settingNumber(input && input.settings, 'cnps_employee_rate', EMPLOYEE_PENSION_RATE * 100) / 100;
  const cfcEmployeeRate =
    settingNumber(input && input.settings, 'cimr_employee_rate', EMPLOYEE_CFC_RATE * 100) / 100;
  const cfcEmployerRate =
    settingNumber(input && input.settings, 'employer_cfc_rate', EMPLOYER_CFC_RATE * 100) / 100;
  const fneEmployerRate =
    settingNumber(input && input.settings, 'employer_fne_rate', EMPLOYER_FNE_RATE * 100) / 100;

  const pensionEmployee = cnpsBase * pensionEmployeeRate;
  const pensionEmployer = cnpsBase * EMPLOYER_PENSION_RATE;
  const familyEmployer = cnpsBase * profile.familyRate;
  const riskEmployer = cnpsBase * profile.riskRate;
  const cfcEmployee = grossCash * cfcEmployeeRate;
  const cfcEmployer = grossCash * cfcEmployerRate;
  const fneEmployer = grossCash * fneEmployerRate;

  const afterCnps = grossTaxable - pensionEmployee;
  const profDeductionRaw = afterCnps * PROFESSIONAL_RATE;
  const profDeduction = Math.min(profDeductionRaw, PROFESSIONAL_CAP);
  const profDeductionCapped = profDeductionRaw > PROFESSIONAL_CAP;
  const netMonthly = Math.max(0, afterCnps - profDeduction);
  const annualNet = Math.max(0, netMonthly * 12 - ANNUAL_ABATEMENT);
  const annualRounded = Math.floor(annualNet / 1000) * 1000;
  const annualTax =
    grossTaxable > 0 && grossTaxable < IRPP_THRESHOLD_MONTHLY
      ? 0
      : progressiveTax(annualRounded, IRPP_BRACKETS);
  const irpp = annualTax / 12;
  const councilTax = bandAmount(baseSalary, COUNCIL_TAX);
  const rav = bandAmount(baseSalary, RAV);

  const employeeDeductions =
    roundXaf(pensionEmployee) + roundXaf(cfcEmployee) + roundXaf(irpp) + councilTax + rav;
  const netPay = roundXaf(grossCash) - employeeDeductions;
  const employerContributions =
    roundXaf(pensionEmployer) +
    roundXaf(familyEmployer) +
    roundXaf(riskEmployer) +
    roundXaf(cfcEmployer) +
    roundXaf(fneEmployer);
  const totalEmployerCost = roundXaf(grossCash) + employerContributions;

  return {
    profile,
    caps,
    allowances,
    grossCash: roundXaf(grossCash),
    grossTaxable: roundXaf(grossTaxable),
    cnpsBaseRaw: roundXaf(cnpsBaseRaw),
    cnpsBase: roundXaf(cnpsBase),
    cnpsCapped,
    pensionEmployee: roundXaf(pensionEmployee),
    pensionEmployer: roundXaf(pensionEmployer),
    familyEmployer: roundXaf(familyEmployer),
    riskEmployer: roundXaf(riskEmployer),
    cfcEmployee: roundXaf(cfcEmployee),
    cfcEmployer: roundXaf(cfcEmployer),
    fneEmployer: roundXaf(fneEmployer),
    afterCnps: roundXaf(afterCnps),
    profDeduction: roundXaf(profDeduction),
    profDeductionCapped,
    netMonthly: roundXaf(netMonthly),
    annualNet: roundXaf(annualNet),
    annualRounded,
    annualTax: roundXaf(annualTax),
    irpp: roundXaf(irpp),
    councilTax,
    rav,
    employeeDeductions,
    netPay,
    employerContributions,
    totalEmployerCost,
    analysis,
    rates: {
      pensionEmployeeRate,
      pensionEmployerRate: EMPLOYER_PENSION_RATE,
      cfcEmployeeRate,
      cfcEmployerRate,
      fneEmployerRate,
      familyRate: profile.familyRate,
      riskRate: profile.riskRate,
    },
  };
}

function optimizationCaps(baseSalary, smig) {
  const caps = statutoryCaps(baseSalary, smig);
  return {
    smigCaps: {
      meal: caps.meal,
      dirtiness: caps.dirtiness,
      clothing: caps.clothing,
      tools: caps.tools,
    },
    bikCaps: {
      housing: caps.housing,
      electricity: caps.electricity,
      water: caps.water,
    },
    profCap: Math.min(baseSalary * PROFESSIONAL_RATE, PROFESSIONAL_CAP),
  };
}

function optimizePayroll(input) {
  const baseSalary = Math.max(0, roundXaf(input && input.baseSalary));
  const initialAllowances = normalizeAllowances(input && input.allowances);
  const profile = resolveProfile(input && input.sector, input && input.regime, input && input.risk);
  const before = computePayroll({ ...input, allowances: initialAllowances, profile });
  const totalGross = before.grossCash;

  let allocBase = baseSalary;
  let allocation = { ...initialAllowances };
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const { smigCaps, bikCaps, profCap } = optimizationCaps(allocBase, profile.smig);
    let remaining = totalGross;
    const next = {
      transport: 0,
      representation: 0,
      housing: 0,
      electricity: 0,
      water: 0,
      meal: 0,
      dirtiness: 0,
      clothing: 0,
      tools: 0,
      other: 0,
    };

    for (const [key, cap] of Object.entries(smigCaps)) {
      next[key] = Math.min(remaining, cap);
      remaining -= next[key];
    }
    for (const [key, cap] of Object.entries(bikCaps)) {
      next[key] = Math.min(remaining, cap);
      remaining -= next[key];
    }
    const halfProf = profCap / 2;
    next.transport = Math.min(remaining / 2, halfProf);
    next.representation = Math.min(remaining / 2, halfProf);
    remaining -= next.transport + next.representation;
    const newBase = remaining;

    if (Math.abs(newBase - allocBase) < 1) {
      allocBase = newBase;
      allocation = next;
      break;
    }
    allocBase = newBase;
    allocation = next;
  }

  for (const key of ALLOWANCE_KEYS) allocation[key] = roundXaf(allocation[key]);
  // Keep the composition exactly equal to the original gross after rounding.
  allocBase = totalGross - ALLOWANCE_KEYS.reduce((sum, key) => sum + allocation[key], 0);
  if (allocBase < 0) allocBase = 0;

  const after = computePayroll({
    ...input,
    baseSalary: allocBase,
    allowances: allocation,
    profile,
  });
  const savings = {
    employeeDeductions: before.employeeDeductions - after.employeeDeductions,
    netPay: after.netPay - before.netPay,
    employerCost: before.totalEmployerCost - after.totalEmployerCost,
    totalBurden:
      before.totalEmployerCost +
      before.employeeDeductions -
      (after.totalEmployerCost + after.employeeDeductions),
  };

  return { before, after, allocation, allocBase, totalGross, savings, profile };
}

function alertsFor(payroll, options = {}) {
  const alerts = [];
  if (options.baseSalary > 0 && options.baseSalary < payroll.profile.smig) {
    alerts.push({
      severity: 'critical',
      title: 'Below sectoral SMIG',
      message: `Base salary is below the ${payroll.profile.sectorLabel} minimum of ${payroll.profile.smig.toLocaleString('fr-FR')} XAF/month.`,
    });
  }
  if (payroll.cnpsCapped) {
    alerts.push({
      severity: 'info',
      title: 'CNPS base capped',
      message: `Contributory base exceeds the statutory ceiling; contributions use ${CNPS_CEILING.toLocaleString('fr-FR')} XAF.`,
    });
  }
  if (payroll.profDeductionCapped) {
    alerts.push({
      severity: 'info',
      title: '30% professional deduction capped',
      message: `The professional deduction was limited to ${PROFESSIONAL_CAP.toLocaleString('fr-FR')} XAF/month.`,
    });
  }
  for (const [key, info] of Object.entries(payroll.analysis || {})) {
    if (info.excess <= 0) continue;
    const label = (SMIG_PROFILES[key] || BIK_PROFILES[key] || {}).label || key;
    alerts.push({
      severity: 'high',
      title: `${label} above exempt limit`,
      message: `${label} exceeds the legal limit by ${info.excess.toLocaleString('fr-FR')} XAF; the excess is taxable.`,
    });
  }
  return alerts;
}

module.exports = {
  HOURS_PER_MONTH,
  CNPS_CEILING,
  PROFESSIONAL_RATE,
  PROFESSIONAL_CAP,
  ANNUAL_ABATEMENT,
  IRPP_THRESHOLD_MONTHLY,
  IRPP_BRACKETS,
  COUNCIL_TAX,
  RAV,
  SECTOR_PROFILES,
  REGIME_PROFILES,
  RISK_PROFILES,
  BIK_PROFILES,
  SMIG_PROFILES,
  ALLOWANCE_KEYS,
  resolveProfile,
  normalizeAllowances,
  statutoryCaps,
  computePayroll,
  optimizePayroll,
  alertsFor,
  roundXaf,
};
