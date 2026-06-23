/**
 * Cameroon payroll — statutory deductions + progressive IRPP (2025 rules).
 *
 * Key statutory sources
 * ─────────────────────
 * • CNPS employee pension:  4.2 % of gross (capped at XAF 750,000/month)
 *   – Source: CNPS decree / PwC Cameroon individual tax summary 2025
 * • CFC (Crédit Foncier du Cameroun): 1.0 % of gross (employee)
 *   – Source: Finance Law / MINFI "Other deductions from wages"
 * • CRTV royalty: fixed scale by gross (max XAF 13,000)
 *   – Source: MINFI scale (last revised Finance Law 2018)
 * • Council Tax (Taxe Communale): fixed XAF 2,520/month when gross > 500,000
 *   – Source: PwC Cameroon individual tax summary 2025
 * • FNE (Fonds National de l'Emploi): 1.0 % of gross
 *   – Source: MINFI / Labour Code obligations
 * • IRPP (Impôt sur le Revenu des Personnes Physiques):
 *   Progressive annual brackets after CNPS & professional allowance.
 *   Annual XAF 500,000 professional allowance (abattement forfaitaire).
 *   Brackets (annual / converted to monthly):
 *     0–166,666/m  (0–2 M/yr)   → 10 %
 *     166,667–250,000/m          → 15 %
 *     250,001–416,666/m          → 25 %
 *     > 416,666/m                → 35 %
 * • CAC (Centimes Additionnels Communaux): 10 % surcharge on IRPP
 *   – Source: DGI / AfroTools verified April 2026
 */

/* ── Default IRPP brackets (monthly, XAF) ─────────────────────────── */
function defaultBracketsJson() {
  return JSON.stringify([
    { min: 0,       max: 166666,  rate: 10   },
    { min: 166667,  max: 250000,  rate: 15   },
    { min: 250001,  max: 416666,  rate: 25   },
    { min: 416667,  max: null,    rate: 35   },
  ]);
}

/* ── Monthly professional allowance (abattement forfaitaire) ─────── */
const PROFESSIONAL_ALLOWANCE_MONTHLY = Math.round(500000 / 12); // 41 667 XAF

/* ── CNPS pension cap ─────────────────────────────────────────────── */
const CNPS_MONTHLY_CAP = 750000;

/* ── CRTV fixed scale (gross → XAF deduction) ───────────────────── */
function crtvFixed(gross) {
  if (gross <= 62000)     return 0;
  if (gross <= 100000)    return 1500;
  if (gross <= 200000)    return 3000;
  if (gross <= 300000)    return 5000;
  if (gross <= 500000)    return 7500;
  if (gross <= 1000000)   return 10000;
  return 13000;
}

/* ── Council tax fixed scale (gross → XAF deduction) ─────────────── */
function councilTaxFixed(gross) {
  if (gross <= 62000)   return 0;
  if (gross <= 150000)  return 700;
  if (gross <= 250000)  return 1000;
  if (gross <= 400000)  return 1500;
  if (gross <= 500000)  return 2100;
  return 2520;
}

/* ── Bracket parser ──────────────────────────────────────────────── */
function parseBrackets(json) {
  let decoded;
  try {
    decoded = JSON.parse(json || '');
  } catch (_) {
    decoded = null;
  }
  if (!Array.isArray(decoded) || decoded.length === 0) {
    decoded = JSON.parse(defaultBracketsJson());
  }
  return decoded
    .map(b => ({
      min:  parseFloat(b.min) || 0,
      max:  (b.max !== null && b.max !== '' && b.max !== undefined) ? parseFloat(b.max) : null,
      rate: parseFloat(b.rate) || 0,
    }))
    .sort((a, b) => a.min - b.min);
}

/* ── IRPP on monthly taxable income ─────────────────────────────── */
function irppFromTaxable(taxableIncome, brackets) {
  const ti = Math.max(0, taxableIncome);
  if (ti <= 0 || !brackets.length) return 0;
  let tax = 0;
  for (const br of brackets) {
    const lo = Math.max(0, br.min || 0);
    const hi = br.max !== null ? br.max : 1e15;
    const from = Math.max(0, lo);
    const to   = Math.min(ti, hi);
    if (to > from) tax += (to - from) * (br.rate / 100);
  }
  return Math.round(tax * 100) / 100;
}

/* ── Fetch settings for a given year ────────────────────────────── */
async function payrollSettingsForYear(pool, facilityId, taxYear) {
  const [[row]] = await pool
    .query(
      'SELECT * FROM tbl_hms_payroll_settings WHERE facility_id = ? AND tax_year <= ? ORDER BY tax_year DESC LIMIT 1',
      [facilityId, taxYear]
    )
    .catch(() => [[null]]);
  if (row) return row;
  const [[row2]] = await pool
    .query(
      'SELECT * FROM tbl_hms_payroll_settings WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1',
      [facilityId]
    )
    .catch(() => [[null]]);
  return row2 || null;
}

/**
 * Calculate all statutory payroll deductions for one employee for one month.
 *
 * Returns an object whose keys map to tbl_hms_payroll_record columns:
 *   gross, cnps_employee, cimr_employee (= CFC), crtv_deduction,
 *   council_tax_deduction, development_tax_deduction, cnhc_deduction (= CAC),
 *   taxable_income, income_tax, net_salary
 *
 * NOTE: cimr_employee column is reused for CFC (Crédit Foncier).
 *       cnhc_deduction column is reused for CAC (Centimes Additionnels Communaux).
 *       development_tax_deduction column is used for FNE.
 */
async function hmsPayrollCameroonCalculate(pool, facilityId, taxYear, grossSalary) {
  const set = await payrollSettingsForYear(pool, facilityId, taxYear);
  if (!set) return null;

  const gross = Math.max(0, parseFloat(grossSalary) || 0);

  /* ── 1. CNPS employee pension: 4.2 % capped at 750 000/month ─── */
  const cnpsPct  = parseFloat(set.cnps_employee_rate) || 4.2;
  const cnpsBase = Math.min(gross, CNPS_MONTHLY_CAP);
  const cnps     = Math.round(cnpsBase * (cnpsPct / 100));

  /* ── 2. CFC (Crédit Foncier) employee: 1.0 % of gross ────────── */
  const cfcPct = parseFloat(set.cimr_employee_rate) || 1.0;  // column reused
  const cfc    = Math.round(gross * (cfcPct / 100));

  /* ── 3. CRTV royalty: fixed scale ────────────────────────────── */
  const crtv = crtvFixed(gross);

  /* ── 4. Council Tax (Taxe Communale): fixed scale ─────────────── */
  const council = councilTaxFixed(gross);

  /* ── 5. FNE (Fonds National de l'Emploi): 1.0 % of gross ──────── */
  const fnePct = parseFloat(set.development_tax_rate) || 1.0;  // column reused
  const fne    = Math.round(gross * (fnePct / 100));

  /* ── 6. Taxable income for IRPP ──────────────────────────────── */
  //   Gross − CNPS − professional allowance (41 667/month)
  const profAllowance = PROFESSIONAL_ALLOWANCE_MONTHLY;
  const taxable = Math.max(0, gross - cnps - profAllowance);

  /* ── 7. IRPP and CAC (stored separately to avoid double-counting) ── */
  const brackets = parseBrackets(String(set.tax_brackets || ''));
  const irppOnly = Math.round(irppFromTaxable(taxable, brackets));
  const cac      = Math.round(irppOnly * 0.10);   // 10 % surcharge on IRPP

  /* ── 8. Totals ────────────────────────────────────────────────── */
  // net = gross − (all pre-tax deductions) − IRPP − CAC
  const preTax   = cnps + cfc + crtv + council + fne;
  const totalDed = preTax + irppOnly + cac;
  const net      = Math.round(gross - totalDed);

  return {
    gross,
    cnps_employee:             cnps,
    cimr_employee:             cfc,      // CFC (Crédit Foncier) — column reused
    crtv_deduction:            crtv,
    council_tax_deduction:     council,
    development_tax_deduction: fne,      // FNE — column reused
    cnhc_deduction:            cac,      // CAC (10 % of IRPP) — stored separately
    taxable_income:            taxable,
    income_tax:                irppOnly, // pure IRPP only — CAC is in cnhc_deduction
    net_salary:                net,
  };
}

module.exports = {
  defaultBracketsJson,
  hmsPayrollCameroonCalculate,
  parseBrackets,
  irppFromTaxable,
  crtvFixed,
  councilTaxFixed,
  PROFESSIONAL_ALLOWANCE_MONTHLY,
  CNPS_MONTHLY_CAP,
};
