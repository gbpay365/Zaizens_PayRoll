'use strict';
/**
 * Cameroon Allowances & Bonuses Engine
 * ------------------------------------
 * Legal basis:
 *   - Labour Code: Law No. 92/007 of 14 August 1992
 *   - Convention Collective de la Santé Privée du Cameroun (latest revision)
 *   - Decree No. 95/040 (healthcare professional remuneration)
 *   - Law No. 96/03 of 4 January 1996 (framework on health protection)
 *   - CNPS/MINTSS circulars (periodically updated)
 *
 * Architecture:
 *   - Allowance definitions are stored in tbl_hms_allowance_settings (per facility, per sector).
 *   - If no DB rows exist, defaultAllowancesForSector() provides factory defaults.
 *   - computeAllowances() applies definitions to an employee's profile for one payroll period.
 *   - The resulting breakdown is JSON-snapshotted in tbl_hms_payroll_record.allowances_snap
 *     so payslips always reflect the rules that were in effect at processing time.
 *
 * To adapt to law changes:
 *   - Edit the relevant row(s) in tbl_hms_allowance_settings via the Settings → Allowances tab.
 *   - Future payroll runs will use the new values; historical payslips are unaffected.
 */

// ─── Sector registry ───────────────────────────────────────────────────────

const SECTORS = {
  medical:   'Medical / Health (Conv. Coll. Santé Privée)',
  education: 'Education (Conv. Coll. Enseignement Privé)',
  banking:   'Banking & Finance (Conv. Coll. Banques & Établissements Financiers)',
  commerce:  'Commerce & Industry (Conv. Coll. Commerce & Industrie)',
  building:  'Building & Civil Works (Conv. Coll. BTP)',
  hotels:    'Hotels & Tourism (Conv. Coll. Hôtellerie & Restauration)',
  transport: 'Transport & Logistics (Conv. Coll. Transports Routiers)',
};

// ─── Seniority scale ───────────────────────────────────────────────────────
/**
 * Prime d'Ancienneté — Labour Code Art. 68 + Convention Collective Santé Privée.
 *
 * Simplified employer scale (most widely applied):
 *   < 2 years  → 0%
 *   2 years    → 2%
 *   3 years    → 3%
 *   …
 *   30+ years  → 30% (ceiling, per most collective agreements)
 *
 * @param {number} yearsCompleted  Completed years of continuous service (floor).
 * @returns {number}               Rate as decimal (e.g. 0.07 = 7%).
 */
function seniorityRate(yearsCompleted) {
  const y = Math.max(0, Math.floor(yearsCompleted));
  if (y < 2) return 0;
  return Math.min(y, 30) / 100;
}

/**
 * Compute seniority bonus XAF amount given basic salary and hire date.
 * Uses exact calendar anniversary to avoid floating-point drift (e.g. exactly
 * 10 years of service should return 10%, not 9% due to leap-year rounding).
 *
 * @param {number} basicSalary
 * @param {string|Date} hireDate  ISO date string or Date object.
 * @returns {number}  Integer XAF amount.
 */
function computeSeniority(basicSalary, hireDate) {
  if (!hireDate) return 0;
  const hire = hireDate instanceof Date ? hireDate : new Date(String(hireDate).trim());
  if (isNaN(hire.getTime())) return 0;
  const now = new Date();
  let completedYears = now.getFullYear() - hire.getFullYear();
  // Subtract 1 if the anniversary hasn't yet occurred in the current year
  const anniversaryThisYear = new Date(now.getFullYear(), hire.getMonth(), hire.getDate());
  if (now < anniversaryThisYear) completedYears--;
  const rate = seniorityRate(Math.max(0, completedYears));
  return Math.round((parseFloat(basicSalary) || 0) * rate);
}

// ─── Default allowance definitions per sector ──────────────────────────────
/**
 * Factory defaults for each sector.  These are used when no custom settings
 * have been saved in tbl_hms_allowance_settings.  Each object mirrors the DB
 * column layout so it can be used directly by computeAllowances().
 *
 * calc_type values:
 *   'seniority_scale' — automatic rate × basic (Labour Code Art.68)
 *   'pct_basic'       — pct_value % of basic salary
 *   'fixed'           — fixed_amount XAF per month
 *   'per_shift'       — per_unit_amount × units (night shifts / on-call)
 *   'none'            — placeholder / informational, always zero
 *
 * applies_to_roles: JSON string array of numeric role codes, or null = all roles.
 *   Role codes: 1=Admin, 2=Doctor, 3=Front Desk, 4=Lab, 5=Pharmacy,
 *               6=Radiology, 7=Nurse, 8=Nursing Aid, 9=Accountant,
 *               11=Cashier, 99=Super Admin
 */
function defaultAllowancesForSector(sector) {
  const s = String(sector || 'medical').toLowerCase();

  if (s === 'medical') {
    return [
      {
        code: 'seniority',
        label: 'Seniority Bonus',
        label_fr: "Prime d'Ancienneté",
        calc_type: 'seniority_scale',
        applies_to_roles: null,
        pct_value: null,
        fixed_amount: null,
        per_unit_amount: null,
        cap_pct: 30,
        cap_amount: null,
        enabled: 1,
        sort_order: 1,
        legal_basis: 'Labour Code Art.68 | Conv. Coll. Santé Privée Cameroun',
        description:
          'Rate = completed years of service % (2% at 2yrs, 3% at 3yrs … 30% ceiling). ' +
          'Formula: rate × Basic Salary. Requires hire date on employee pay profile.',
      },
      {
        code: 'medical_responsibility',
        label: 'Medical Responsibility Allowance',
        label_fr: 'Prime de Responsabilité Médicale',
        calc_type: 'pct_basic',
        applies_to_roles: JSON.stringify([2]),
        pct_value: 25,
        fixed_amount: null,
        per_unit_amount: null,
        cap_pct: null,
        cap_amount: null,
        enabled: 1,
        sort_order: 2,
        legal_basis: 'Conv. Coll. Santé Privée Cameroun, Art.32 — Médecins & Chirurgiens',
        description:
          '25% of basic salary for licensed medical doctors. ' +
          'Adjust the percentage to match your establishment\'s collective agreement annex.',
      },
      {
        code: 'specialist_research',
        label: 'Specialist Research Allowance',
        label_fr: 'Prime de Recherche Spécialisée',
        calc_type: 'pct_basic',
        applies_to_roles: JSON.stringify([2]),
        pct_value: 15,
        fixed_amount: null,
        per_unit_amount: null,
        cap_pct: null,
        cap_amount: null,
        enabled: 1,
        sort_order: 3,
        legal_basis: 'Decree No.95/040 on healthcare professional remuneration',
        description: '15% of basic salary for specialist-grade doctors (e.g. Surgeon, Cardiologist).',
      },
      {
        code: 'medical_risk',
        label: 'Medical Risk Allowance',
        label_fr: "Indemnité d'Exposition au Risque Médical",
        calc_type: 'pct_basic',
        applies_to_roles: JSON.stringify([2, 4, 5, 6, 7, 8]),
        pct_value: 10,
        fixed_amount: null,
        per_unit_amount: null,
        cap_pct: null,
        cap_amount: null,
        enabled: 1,
        sort_order: 4,
        legal_basis:
          'Conv. Coll. Santé Privée Cameroun | Law No.96/03 of 4 Jan 1996 (health protection)',
        description:
          '10% of basic salary for clinical staff with direct patient or biological-sample exposure ' +
          '(Doctors, Lab, Pharmacy, Radiology, Nurses, Nursing Aids).',
      },
      {
        code: 'technical',
        label: 'Technical Allowance',
        label_fr: 'Prime Technique',
        calc_type: 'pct_basic',
        applies_to_roles: JSON.stringify([4, 5, 6]),
        pct_value: 15,
        fixed_amount: null,
        per_unit_amount: null,
        cap_pct: null,
        cap_amount: null,
        enabled: 1,
        sort_order: 5,
        legal_basis:
          'Conv. Coll. Santé Privée Cameroun — Annexe Personnel Paramédical Technique | Labour Code Art.71',
        description:
          '15% of basic salary for technical paramedical staff (Lab Technicians, Pharmacists/Dispensers, Radiographers). ' +
          'Distinct from the public-sector flat prime de technicité (civil-service grades). ' +
          'May stack with Medical Risk Allowance (10%) where both apply.',
      },
      {
        code: 'night_duty',
        label: 'Night Duty Allowance',
        label_fr: 'Indemnité de Garde de Nuit',
        calc_type: 'per_shift',
        applies_to_roles: null,
        pct_value: null,
        fixed_amount: null,
        per_unit_amount: 3000,
        cap_pct: null,
        cap_amount: null,
        enabled: 1,
        sort_order: 6,
        legal_basis:
          'Labour Code Art.80 (night work supplements) | Conv. Coll. Santé Privée',
        description:
          'Paid for each night shift (22:00–06:00). The XAF amount in the rate box × the ' +
          'number of nights on the Nurse Roster for the month. Counts are read directly ' +
          'from the duty roster — no manual entry needed. Paid TAX-FREE on top of net ' +
          '(not subject to CNPS, CFC, CRTV, IRPP or CAC).',
      },
      {
        code: 'on_call',
        label: 'On-Call Allowance',
        label_fr: "Prime d'Astreinte",
        calc_type: 'per_shift',
        applies_to_roles: null,
        pct_value: null,
        fixed_amount: null,
        per_unit_amount: 2000,
        cap_pct: null,
        cap_amount: null,
        enabled: 1,
        sort_order: 7,
        legal_basis: 'Labour Code Art.80 | Conv. Coll. Santé Privée Cameroun',
        description:
          'Paid for each on-call session. The XAF amount in the rate box × the number ' +
          'of on-call sessions on the Doctor Roster for the month (marked "OC" / On-Call). ' +
          'Counts are read directly from the duty roster — no manual entry needed. ' +
          'Paid TAX-FREE on top of net (not subject to CNPS, CFC, CRTV, IRPP or CAC).',
      },
      {
        code: 'diligence',
        label: 'Diligence / Punctuality Bonus',
        label_fr: "Prime d'Assiduité",
        calc_type: 'pct_basic',
        applies_to_roles: null,
        pct_value: 5,
        fixed_amount: null,
        per_unit_amount: null,
        cap_pct: null,
        cap_amount: null,
        enabled: 0,
        sort_order: 8,
        legal_basis: 'Conv. Coll. Santé Privée Cameroun',
        description:
          '5% of basic salary for full attendance in the month. Enable per employee as needed; ' +
          'disable for staff with absences in the period.',
      },
      {
        code: 'head_of_dept',
        label: 'Head of Department Allowance',
        label_fr: 'Prime de Chef de Service / Responsable d\'Unité',
        calc_type: 'fixed',
        applies_to_roles: JSON.stringify([2, 7]),
        pct_value: null,
        fixed_amount: 30000,
        per_unit_amount: null,
        cap_pct: null,
        cap_amount: null,
        enabled: 0,
        sort_order: 9,
        legal_basis: 'Conv. Coll. Santé Privée Cameroun — Annexe Encadrement',
        description:
          '30,000 XAF fixed monthly for heads of department (Ward Sisters, Chief Doctors, Unit Heads). ' +
          'Enable this allowance only for qualifying staff.',
      },
      {
        code: 'maternity_obstetric',
        label: 'Maternity / Obstetric Allowance',
        label_fr: "Prime d'Obstétrique et Maternité",
        calc_type: 'pct_basic',
        applies_to_roles: JSON.stringify([7, 8]),
        pct_value: 10,
        fixed_amount: null,
        per_unit_amount: null,
        cap_pct: null,
        cap_amount: null,
        enabled: 0,
        sort_order: 10,
        legal_basis: 'Conv. Coll. Santé Privée — Personnels de Maternité & Obstétrique',
        description:
          '10% of basic salary for midwives and obstetric nursing staff. ' +
          'Enable for staff assigned to the maternity/labour ward.',
      },
    ];
  }

  if (s === 'education') {
    return [
      {
        code: 'seniority', label: 'Seniority Bonus', label_fr: "Prime d'Ancienneté",
        calc_type: 'seniority_scale', applies_to_roles: null,
        pct_value: null, fixed_amount: null, per_unit_amount: null, cap_pct: 30, cap_amount: null,
        enabled: 1, sort_order: 1,
        legal_basis: 'Labour Code Art.68 | Conv. Coll. Enseignement Privé Cameroun',
        description: 'Rate = completed years %, min 2yrs, ceiling 30%.',
      },
      {
        code: 'teaching_load', label: 'Teaching Load Supplement', label_fr: 'Indemnité de Charge Pédagogique',
        calc_type: 'pct_basic', applies_to_roles: null,
        pct_value: 20, fixed_amount: null, per_unit_amount: null, cap_pct: null, cap_amount: null,
        enabled: 1, sort_order: 2,
        legal_basis: 'Conv. Coll. Enseignement Privé Cameroun, Art.28',
        description: '20% of basic salary for teaching staff with full teaching load.',
      },
      {
        code: 'qualification', label: 'Qualification / Subject Mastery Allowance', label_fr: 'Prime de Qualification',
        calc_type: 'pct_basic', applies_to_roles: null,
        pct_value: 10, fixed_amount: null, per_unit_amount: null, cap_pct: null, cap_amount: null,
        enabled: 1, sort_order: 3,
        legal_basis: 'Conv. Coll. Enseignement Privé Cameroun',
        description: '10% of basic for certified subject expertise and academic qualification.',
      },
      {
        code: 'diligence', label: 'Diligence Bonus', label_fr: "Prime d'Assiduité",
        calc_type: 'pct_basic', applies_to_roles: null,
        pct_value: 5, fixed_amount: null, per_unit_amount: null, cap_pct: null, cap_amount: null,
        enabled: 0, sort_order: 4,
        legal_basis: 'Labour Code | Conv. Coll. Enseignement Privé',
        description: '5% attendance/punctuality bonus.',
      },
    ];
  }

  if (s === 'banking') {
    return [
      {
        code: 'seniority', label: 'Seniority Bonus', label_fr: "Prime d'Ancienneté",
        calc_type: 'seniority_scale', applies_to_roles: null,
        pct_value: null, fixed_amount: null, per_unit_amount: null, cap_pct: 30, cap_amount: null,
        enabled: 1, sort_order: 1,
        legal_basis: 'Labour Code Art.68 | Conv. Coll. Banques & Établissements Financiers',
        description: 'Rate = completed years %, ceiling 30%.',
      },
      {
        code: 'performance', label: 'Performance Bonus', label_fr: 'Prime de Rendement',
        calc_type: 'pct_basic', applies_to_roles: null,
        pct_value: 15, fixed_amount: null, per_unit_amount: null, cap_pct: null, cap_amount: null,
        enabled: 1, sort_order: 2,
        legal_basis: 'Conv. Coll. Banques Cameroun, Art.24',
        description: '15% of basic for staff meeting performance targets.',
      },
      {
        code: 'responsibility', label: 'Managerial Responsibility Allowance', label_fr: 'Prime de Responsabilité',
        calc_type: 'pct_basic', applies_to_roles: null,
        pct_value: 20, fixed_amount: null, per_unit_amount: null, cap_pct: null, cap_amount: null,
        enabled: 0, sort_order: 3,
        legal_basis: 'Conv. Coll. Banques Cameroun',
        description: '20% of basic for supervisory/managerial roles.',
      },
      {
        code: 'diligence', label: 'Diligence Bonus', label_fr: "Prime d'Assiduité",
        calc_type: 'pct_basic', applies_to_roles: null,
        pct_value: 5, fixed_amount: null, per_unit_amount: null, cap_pct: null, cap_amount: null,
        enabled: 0, sort_order: 4,
        legal_basis: 'Labour Code | Conv. Coll. Banques',
        description: '5% attendance bonus.',
      },
    ];
  }

  if (s === 'commerce') {
    return [
      {
        code: 'seniority', label: 'Seniority Bonus', label_fr: "Prime d'Ancienneté",
        calc_type: 'seniority_scale', applies_to_roles: null,
        pct_value: null, fixed_amount: null, per_unit_amount: null, cap_pct: 30, cap_amount: null,
        enabled: 1, sort_order: 1,
        legal_basis: 'Labour Code Art.68 | Conv. Coll. Commerce & Industrie Cameroun',
        description: 'Rate = completed years %, ceiling 30%.',
      },
      {
        code: 'sales_bonus', label: 'Sales / Commercial Bonus', label_fr: 'Prime de Vente / Commerce',
        calc_type: 'pct_basic', applies_to_roles: null,
        pct_value: 10, fixed_amount: null, per_unit_amount: null, cap_pct: null, cap_amount: null,
        enabled: 0, sort_order: 2,
        legal_basis: 'Conv. Coll. Commerce & Industrie Cameroun',
        description: '10% of basic. Enable and adjust for commercial/sales staff.',
      },
    ];
  }

  if (s === 'building') {
    return [
      {
        code: 'seniority', label: 'Seniority Bonus', label_fr: "Prime d'Ancienneté",
        calc_type: 'seniority_scale', applies_to_roles: null,
        pct_value: null, fixed_amount: null, per_unit_amount: null, cap_pct: 30, cap_amount: null,
        enabled: 1, sort_order: 1,
        legal_basis: 'Labour Code Art.68 | Conv. Coll. BTP Cameroun',
        description: 'Rate = completed years %, ceiling 30%.',
      },
      {
        code: 'site_risk', label: 'Site Risk Allowance', label_fr: 'Prime de Risque Chantier',
        calc_type: 'pct_basic', applies_to_roles: null,
        pct_value: 15, fixed_amount: null, per_unit_amount: null, cap_pct: null, cap_amount: null,
        enabled: 1, sort_order: 2,
        legal_basis: 'Conv. Coll. BTP Cameroun — Annexe Sécurité',
        description: '15% of basic for staff working on hazardous construction sites.',
      },
      {
        code: 'diligence', label: 'Diligence Bonus', label_fr: "Prime d'Assiduité",
        calc_type: 'pct_basic', applies_to_roles: null,
        pct_value: 5, fixed_amount: null, per_unit_amount: null, cap_pct: null, cap_amount: null,
        enabled: 0, sort_order: 3,
        legal_basis: 'Labour Code | Conv. Coll. BTP',
        description: '5% attendance bonus.',
      },
    ];
  }

  if (s === 'hotels') {
    return [
      {
        code: 'seniority', label: 'Seniority Bonus', label_fr: "Prime d'Ancienneté",
        calc_type: 'seniority_scale', applies_to_roles: null,
        pct_value: null, fixed_amount: null, per_unit_amount: null, cap_pct: 30, cap_amount: null,
        enabled: 1, sort_order: 1,
        legal_basis: 'Labour Code Art.68 | Conv. Coll. Hôtellerie & Restauration Cameroun',
        description: 'Rate = completed years %, ceiling 30%.',
      },
      {
        code: 'service_charge', label: 'Service Charge / Tips Supplement', label_fr: 'Part de Service',
        calc_type: 'pct_basic', applies_to_roles: null,
        pct_value: 10, fixed_amount: null, per_unit_amount: null, cap_pct: null, cap_amount: null,
        enabled: 1, sort_order: 2,
        legal_basis: 'Conv. Coll. Hôtellerie & Restauration Cameroun',
        description: '10% of basic representing a share of service charges.',
      },
      {
        code: 'night_duty', label: 'Night Duty Allowance', label_fr: 'Indemnité de Nuit',
        calc_type: 'per_shift', applies_to_roles: null,
        pct_value: null, fixed_amount: null, per_unit_amount: 2500, cap_pct: null, cap_amount: null,
        enabled: 1, sort_order: 3,
        legal_basis: 'Labour Code Art.80 | Conv. Coll. Hôtellerie',
        description: '2,500 XAF per night shift.',
      },
    ];
  }

  if (s === 'transport') {
    return [
      {
        code: 'seniority', label: 'Seniority Bonus', label_fr: "Prime d'Ancienneté",
        calc_type: 'seniority_scale', applies_to_roles: null,
        pct_value: null, fixed_amount: null, per_unit_amount: null, cap_pct: 30, cap_amount: null,
        enabled: 1, sort_order: 1,
        legal_basis: 'Labour Code Art.68 | Conv. Coll. Transports Routiers Cameroun',
        description: 'Rate = completed years %, ceiling 30%.',
      },
      {
        code: 'safety_bonus', label: 'Safety / Accident-Free Bonus', label_fr: 'Prime de Sécurité Routière',
        calc_type: 'pct_basic', applies_to_roles: null,
        pct_value: 10, fixed_amount: null, per_unit_amount: null, cap_pct: null, cap_amount: null,
        enabled: 1, sort_order: 2,
        legal_basis: 'Conv. Coll. Transports Routiers Cameroun',
        description: '10% of basic for accident-free driving record in the period.',
      },
    ];
  }

  // Generic fallback: seniority only
  return [
    {
      code: 'seniority', label: 'Seniority Bonus', label_fr: "Prime d'Ancienneté",
      calc_type: 'seniority_scale', applies_to_roles: null,
      pct_value: null, fixed_amount: null, per_unit_amount: null, cap_pct: 30, cap_amount: null,
      enabled: 1, sort_order: 1,
      legal_basis: 'Labour Code Art.68',
      description: 'Rate = completed years %, min 2yrs, ceiling 30%.',
    },
  ];
}

// ─── DB helpers ────────────────────────────────────────────────────────────

/**
 * Load allowance settings from DB for a given facility + sector.
 * Falls back to factory defaults when no custom rows exist.
 */
function isEmptyNum(v) {
  if (v === '' || v == null) return true;
  const n = parseFloat(v);
  return !Number.isFinite(n);
}

/**
 * Fill missing/zero rates and clear erroneous caps using factory defaults.
 */
function reconcileAllowanceRow(dbRow, defaultRow) {
  if (!defaultRow) return dbRow;
  const out = {
    ...defaultRow,
    ...dbRow,
    code: dbRow.code || defaultRow.code,
    facility_id: dbRow.facility_id ?? defaultRow.facility_id,
    sector: dbRow.sector ?? defaultRow.sector,
  };
  const ct = String(out.calc_type || defaultRow.calc_type || 'none');

  if (ct === 'pct_basic') {
    const pct = parseFloat(out.pct_value);
    const defPct = parseFloat(defaultRow.pct_value);
    if (isEmptyNum(out.pct_value) || pct <= 0) {
      if (Number.isFinite(defPct) && defPct > 0) out.pct_value = defaultRow.pct_value;
    } else if (Number.isFinite(defPct) && defPct > 0 && Math.abs(pct - defPct) < 0.5) {
      out.pct_value = defaultRow.pct_value;
    }
  } else if (ct === 'fixed') {
    const amt = parseFloat(out.fixed_amount);
    const defAmt = parseFloat(defaultRow.fixed_amount);
    if (isEmptyNum(out.fixed_amount) || amt <= 0) {
      if (Number.isFinite(defAmt) && defAmt > 0) out.fixed_amount = defaultRow.fixed_amount;
    }
  } else if (ct === 'per_shift') {
    const unit = parseFloat(out.per_unit_amount);
    const defUnit = parseFloat(defaultRow.per_unit_amount);
    if (isEmptyNum(out.per_unit_amount) || unit <= 0) {
      if (Number.isFinite(defUnit) && defUnit > 0) out.per_unit_amount = defaultRow.per_unit_amount;
    }
  }

  const defCap = defaultRow.cap_pct;
  if (defCap == null || defCap === '') {
    if (!isEmptyNum(out.cap_pct)) out.cap_pct = null;
  } else if (isEmptyNum(out.cap_pct)) {
    out.cap_pct = defCap;
  }

  if (!String(out.legal_basis || '').trim() && defaultRow.legal_basis) {
    out.legal_basis = defaultRow.legal_basis;
  }
  if (!String(out.description || '').trim() && defaultRow.description) {
    out.description = defaultRow.description;
  }
  // Roster-driven, tax-free allowances: the description used to quote a hardcoded XAF amount
  // and instructed users to enter shift counts on the pay profile. Both are now wrong (the
  // amount is editable and counts come from the duty roster), so always pull the latest
  // factory description for these two codes. The user's saved rate (per_unit_amount) is kept.
  if ((out.code === 'night_duty' || out.code === 'on_call') && defaultRow.description) {
    out.description = defaultRow.description;
  }
  if (out.code === 'technical' && ct === 'pct_basic') {
    const defPct = parseFloat(defaultRow.pct_value) || 15;
    if ((parseFloat(out.pct_value) || 0) < defPct) out.pct_value = defPct;
  }
  if (out.code === 'medical_responsibility' && (defCap == null || defCap === '')) {
    out.cap_pct = null;
  }
  if (!out.label_fr && defaultRow.label_fr) out.label_fr = defaultRow.label_fr;
  if (!out.applies_to_roles && defaultRow.applies_to_roles) {
    out.applies_to_roles = defaultRow.applies_to_roles;
  }
  if (!out.sort_order && defaultRow.sort_order) out.sort_order = defaultRow.sort_order;

  return out;
}

function allowanceRowNeedsRepair(before, after) {
  const keys = [
    'pct_value', 'fixed_amount', 'per_unit_amount', 'cap_pct', 'calc_type', 'sort_order',
    'legal_basis', 'description', 'label_fr',
  ];
  return keys.some((k) => String(before[k] ?? '').trim() !== String(after[k] ?? '').trim());
}

function rowToSavePayload(row) {
  return {
    code: row.code,
    label: row.label || '',
    label_fr: row.label_fr || '',
    calc_type: row.calc_type || 'none',
    enabled: row.enabled === 1 || row.enabled === '1' || row.enabled === true ? 1 : 0,
    pct_value: row.pct_value,
    fixed_amount: row.fixed_amount,
    per_unit_amount: row.per_unit_amount,
    cap_pct: row.cap_pct,
    cap_amount: row.cap_amount,
    applies_to_roles: row.applies_to_roles,
    legal_basis: row.legal_basis || '',
    description: row.description || '',
    sort_order: row.sort_order,
  };
}

function allowanceSettingsNeedFullRepair(dbRows, mergedRows, sector) {
  const sec = String(sector || 'medical').toLowerCase();
  for (const after of mergedRows || []) {
    const code = String(after.code || '').trim();
    const before = (dbRows || []).find((r) => String(r.code || '').trim() === code);
    if (!before || allowanceRowNeedsRepair(before, after)) return true;
    if (!String(after.legal_basis || '').trim()) return true;
    if (code === 'technical' && (parseFloat(after.pct_value) || 0) < 1) return true;
    if (code === 'medical_responsibility' && !isEmptyNum(after.cap_pct)) return true;
    if (sec === 'medical' && code === 'medical_responsibility') {
      const pct = parseFloat(after.pct_value) || 0;
      if (pct > 0 && Math.abs(pct - 25) >= 0.5) return true;
    }
  }
  return false;
}

/** Apply factory defaults to POSTed allowance rows (prevents empty legal basis / 0% rates on save). */
function applyDefaultsToAllowancePostItems(items, sector) {
  const defMap = new Map(
    defaultAllowancesForSector(sector).map((d) => [String(d.code || '').trim(), d])
  );
  return (items || []).map((it) => {
    const code = String(it.code || '').trim();
    const def = defMap.get(code);
    if (!def) return it;
    const merged = reconcileAllowanceRow(
      {
        ...it,
        code,
        calc_type: it.calc_type || def.calc_type,
        enabled: it.enabled,
      },
      def
    );
    return {
      ...it,
      label: merged.label || it.label,
      label_fr: merged.label_fr || it.label_fr,
      calc_type: merged.calc_type || it.calc_type,
      pct_value: merged.pct_value != null ? merged.pct_value : it.pct_value,
      fixed_amount: merged.fixed_amount != null ? merged.fixed_amount : it.fixed_amount,
      per_unit_amount: merged.per_unit_amount != null ? merged.per_unit_amount : it.per_unit_amount,
      cap_pct: merged.cap_pct,
      legal_basis: merged.legal_basis || it.legal_basis,
      description: merged.description || it.description,
      applies_to_roles: merged.applies_to_roles || it.applies_to_roles,
      sort_order: merged.sort_order || it.sort_order,
    };
  });
}

/** Force-reset medical-sector statutory % allowances to factory defaults. */
async function repairMedicalAllowanceSettings(pool, facilityId) {
  const sec = 'medical';
  const [rows] = await pool.query(
    `SELECT * FROM tbl_hms_allowance_settings WHERE facility_id = ? AND sector = ?`,
    [facilityId, sec]
  ).catch(() => [[]]);
  const merged = mergeAllowanceDefaults(rows || [], facilityId, sec);
  await saveAllowanceSettings(pool, facilityId, sec, merged.map(rowToSavePayload));
  return merged;
}

function mergeAllowanceDefaults(dbRows, facilityId, sector) {
  const sec = String(sector || 'medical').toLowerCase();
  const defaults = defaultAllowancesForSector(sec).map((d, i) => ({
    id: null,
    facility_id: facilityId,
    sector: sec,
    sort_order: d.sort_order || (i + 1),
    ...d,
  }));
  const defaultsByCode = new Map(defaults.map((d) => [d.code, d]));

  if (!Array.isArray(dbRows) || dbRows.length === 0) return defaults;

  const byCode = new Map();
  for (const row of dbRows) byCode.set(String(row.code || '').trim(), row);

  for (const d of defaults) {
    if (!byCode.has(d.code)) byCode.set(d.code, { ...d });
  }

  const merged = [];
  for (const row of byCode.values()) {
    const code = String(row.code || '').trim();
    const def = defaultsByCode.get(code);
    merged.push(def ? reconcileAllowanceRow(row, def) : row);
  }

  return merged.sort(
    (a, b) => (parseInt(a.sort_order, 10) || 99) - (parseInt(b.sort_order, 10) || 99)
  );
}

async function loadAllowanceSettings(pool, facilityId, sector) {
  const sec = String(sector || 'medical').toLowerCase();
  let dbRows = [];
  try {
    const [rows] = await pool.query(
      `SELECT * FROM tbl_hms_allowance_settings
       WHERE facility_id = ? AND sector = ?
       ORDER BY sort_order, id`,
      [facilityId, sec]
    );
    if (Array.isArray(rows)) dbRows = rows;
  } catch (err) {
    console.error('loadAllowanceSettings:', err.message);
  }

  const merged = mergeAllowanceDefaults(dbRows, facilityId, sec);

  if (dbRows.length > 0 && allowanceSettingsNeedFullRepair(dbRows, merged, sec)) {
    try {
      await saveAllowanceSettings(pool, facilityId, sec, merged.map(rowToSavePayload));
    } catch (err) {
      console.error('allowance settings repair save failed:', err.message);
    }
  }

  return merged;
}

/**
 * Upsert allowance settings for one sector.
 * `items` is the parsed POST body array.
 */
async function saveAllowanceSettings(pool, facilityId, sector, items) {
  const sec = String(sector || 'medical').toLowerCase();
  for (const it of items) {
    const code = String(it.code || '').trim().slice(0, 40);
    if (!code) continue;
    const label = String(it.label || '').trim().slice(0, 120);
    const label_fr = String(it.label_fr || '').trim().slice(0, 120);
    const calc_type = String(it.calc_type || 'none').trim().slice(0, 20);
    const enabled = it.enabled ? 1 : 0;
    const pct_value = !isEmptyNum(it.pct_value) ? parseFloat(it.pct_value) : null;
    const fixed_amount = it.fixed_amount !== '' && it.fixed_amount != null ? parseFloat(it.fixed_amount) || null : null;
    const per_unit_amount = it.per_unit_amount !== '' && it.per_unit_amount != null ? parseFloat(it.per_unit_amount) || null : null;
    const cap_pct = !isEmptyNum(it.cap_pct) ? parseFloat(it.cap_pct) : null;
    const cap_amount = it.cap_amount !== '' && it.cap_amount != null ? parseFloat(it.cap_amount) || null : null;
    const applies_to_roles = it.applies_to_roles ? String(it.applies_to_roles).trim() : null;
    const legal_basis = String(it.legal_basis || '').trim().slice(0, 255);
    const description = String(it.description || '').trim().slice(0, 1000);
    const sort_order = parseInt(it.sort_order, 10) || 99;

    await pool.query(
      `INSERT INTO tbl_hms_allowance_settings
        (facility_id, sector, code, label, label_fr, calc_type, enabled,
         pct_value, fixed_amount, per_unit_amount, cap_pct, cap_amount,
         applies_to_roles, legal_basis, description, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
        label=VALUES(label), label_fr=VALUES(label_fr), calc_type=VALUES(calc_type),
        enabled=VALUES(enabled), pct_value=VALUES(pct_value),
        fixed_amount=VALUES(fixed_amount), per_unit_amount=VALUES(per_unit_amount),
        cap_pct=VALUES(cap_pct), cap_amount=VALUES(cap_amount),
        applies_to_roles=VALUES(applies_to_roles),
        legal_basis=VALUES(legal_basis), description=VALUES(description),
        sort_order=VALUES(sort_order)`,
      [facilityId, sec, code, label, label_fr, calc_type, enabled,
       pct_value, fixed_amount, per_unit_amount, cap_pct, cap_amount,
       applies_to_roles, legal_basis, description, sort_order]
    );
  }
}

// ─── Computation ───────────────────────────────────────────────────────────

/**
 * Compute allowances for one employee for a monthly payroll run.
 *
 * @param {object} opts
 * @param {number}  opts.basicSalary      Gross basic salary (XAF).
 * @param {string}  opts.role             Employee's numeric role code (from tbl_employee.role).
 * @param {string}  [opts.hireDate]       ISO date for seniority calculation.
 * @param {Array}   opts.settings         Array from loadAllowanceSettings().
 * @param {number}  [opts.nightShifts]    Count of night shifts this month.
 * @param {number}  [opts.onCallShifts]   Count of on-call sessions this month.
 * @param {boolean} [opts.isSpecialist]   True for specialist-grade doctors (enables specialist_research).
 *
 * @returns {{ total: number, lines: {code:string, label:string, label_fr:string, amount:number}[] }}
 */
/**
 * Title-based aliases for each allowance code — applied when the numeric
 * `applies_to_roles` list doesn't match the employee's role ID (e.g. because
 * the facility uses custom role IDs like 100=Doctor / 101=Nurse instead of
 * the legacy 2 / 7). Lets the engine fire correctly without re-seeding.
 */
const ROLE_TITLE_ALIASES = {
  medical_responsibility: /(doctor|physician|m[ée]decin|specialist|sp[ée]cialiste)/i,
  specialist_research:    /(doctor|physician|m[ée]decin|specialist|sp[ée]cialiste)/i,
  medical_risk:           /(doctor|physician|m[ée]decin|nurse|infirm|midwife|sage|lab|pharm|radio|aide|nursing aid)/i,
  technical:              /(lab|pharm|radio|technicien)/i,
  night_duty:             /(doctor|physician|nurse|infirm|midwife|sage|aide)/i,
  on_call:                /(doctor|physician|m[ée]decin|specialist)/i,
  head_of_dept:           /(doctor|physician|nurse|chief|head|director|chef)/i,
  maternity_obstetric:    /(midwife|sage|nurse|infirm|obstet|maternit[ée])/i,
};

function computeAllowances(opts) {
  const {
    basicSalary = 0,
    role,
    roleTitle = '',
    hireDate,
    settings = [],
    nightShifts = 0,
    onCallShifts = 0,
    isSpecialist = false,
  } = opts;

  const basic     = Math.max(0, parseFloat(basicSalary) || 0);
  const roleNum   = parseInt(role, 10) || 0;
  const titleLc   = String(roleTitle || '').toLowerCase();
  const lines     = [];

  for (const s of settings) {
    if (!s.enabled && s.enabled !== '1' && s.enabled !== 1) continue;

    // Role filter — numeric IDs first, then fall back to title alias
    if (s.applies_to_roles) {
      let roles;
      try { roles = typeof s.applies_to_roles === 'string' ? JSON.parse(s.applies_to_roles) : s.applies_to_roles; } catch { roles = null; }
      if (Array.isArray(roles) && !roles.includes(roleNum)) {
        const alias = ROLE_TITLE_ALIASES[s.code];
        const titleMatch = alias && titleLc && alias.test(titleLc);
        if (!titleMatch) continue;
      }
    }

    // Specialist Research requires the employee to be flagged as a specialist-grade doctor
    if (s.code === 'specialist_research' && !isSpecialist) continue;

    let amount = 0;
    const ct = String(s.calc_type || 'none');

    if (ct === 'seniority_scale') {
      amount = computeSeniority(basic, hireDate);
    } else if (ct === 'pct_basic') {
      const pct = parseFloat(s.pct_value) || 0;
      amount = Math.round(basic * pct / 100);
    } else if (ct === 'fixed') {
      amount = Math.round(parseFloat(s.fixed_amount) || 0);
    } else if (ct === 'per_shift') {
      const unitAmt = parseFloat(s.per_unit_amount) || 0;
      const units = s.code === 'night_duty' ? (nightShifts || 0)
                  : s.code === 'on_call'    ? (onCallShifts || 0)
                  : 0;
      amount = Math.round(unitAmt * units);
    }

    // Caps
    if (s.cap_pct && amount > 0) {
      amount = Math.min(amount, Math.round(basic * parseFloat(s.cap_pct) / 100));
    }
    if (s.cap_amount && amount > 0) {
      amount = Math.min(amount, Math.round(parseFloat(s.cap_amount)));
    }

    if (amount > 0) {
      // Build display qty / rate for payslip table
      let qty_label = '—', rate_label = '—';
      if (ct === 'seniority_scale' && hireDate) {
        const hire2 = hireDate instanceof Date ? hireDate : new Date(String(hireDate).trim());
        let completedYrs = new Date().getFullYear() - hire2.getFullYear();
        const anniv = new Date(new Date().getFullYear(), hire2.getMonth(), hire2.getDate());
        if (new Date() < anniv) completedYrs--;
        completedYrs = Math.max(0, completedYrs);
        qty_label  = completedYrs + ' yrs';
        rate_label = Math.min(completedYrs, 30) + '%';
      } else if (ct === 'pct_basic') {
        qty_label  = (parseFloat(s.pct_value) || 0) + '%';
        rate_label = basic.toLocaleString('fr-FR');
      } else if (ct === 'fixed') {
        qty_label  = '1 Month';
        rate_label = Math.round(parseFloat(s.fixed_amount) || 0).toLocaleString('fr-FR');
      } else if (ct === 'per_shift') {
        const units2 = s.code === 'night_duty' ? (nightShifts || 0) : (onCallShifts || 0);
        qty_label  = units2 + (s.code === 'night_duty' ? ' nights' : ' calls');
        rate_label = Math.round(parseFloat(s.per_unit_amount) || 0).toLocaleString('fr-FR');
      }
      lines.push({
        code:       s.code,
        label:      s.label,
        label_fr:   s.label_fr || s.label,
        amount,
        qty_label,
        rate_label,
      });
    }
  }

  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  return { total, lines };
}

module.exports = {
  SECTORS,
  seniorityRate,
  computeSeniority,
  defaultAllowancesForSector,
  reconcileAllowanceRow,
  mergeAllowanceDefaults,
  rowToSavePayload,
  applyDefaultsToAllowancePostItems,
  repairMedicalAllowanceSettings,
  loadAllowanceSettings,
  saveAllowanceSettings,
  computeAllowances,
};
