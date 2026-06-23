'use strict';

/**
 * Navigation access bundles — independent from capability permissions.
 * Each bundle maps to one or more tbl_acl_ui_element codes (topnav + sidebar).
 */
const NAV_ACCESS_TREE = Object.freeze([
  {
    code: 'nav.clinical',
    label: 'Clinical',
    icon: 'fa-stethoscope',
    color: '#0891b2',
    uiCodes: ['topnav.clinical'],
    children: [
      { code: 'nav.clinical.hms', label: 'HMS hub', uiCodes: ['topnav.clinical.hms', 'sb.hms_hub'] },
      { code: 'nav.clinical.opd', label: 'OPD visits', uiCodes: ['topnav.clinical.opd', 'sb.opd'] },
      { code: 'nav.clinical.er', label: 'Emergency / A&E', uiCodes: ['topnav.clinical.er', 'sb.emergency'] },
      { code: 'nav.clinical.maternity', label: 'Maternity / ANC', uiCodes: ['topnav.clinical.maternity', 'sb.maternity'] },
      { code: 'nav.clinical.vaccination', label: 'Vaccination / Immunization', uiCodes: ['topnav.clinical.vaccination', 'sb.vaccination'] },
      { code: 'nav.clinical.ipd', label: 'Hospitalization', uiCodes: ['topnav.clinical.ipd_hub', 'sb.ipd_hub'] },
      { code: 'nav.clinical.lims', label: 'Laboratory (LIMS)', uiCodes: ['topnav.clinical.lims'] },
      { code: 'nav.clinical.wards', label: 'Ward board / beds', uiCodes: ['topnav.clinical.wards', 'sb.wards'] },
      { code: 'nav.clinical.census', label: 'IPD census', uiCodes: ['topnav.clinical.census'] },
      { code: 'nav.clinical.death_registry', label: 'Death registry', uiCodes: ['topnav.clinical.death_registry', 'sb.death_registry'] },
      { code: 'nav.clinical.ipd_rx', label: 'IPD medication', uiCodes: ['topnav.clinical.ipd_rx'] },
      { code: 'nav.clinical.ipd_inbox', label: 'IPD nurse messages', uiCodes: ['topnav.clinical.ipd_inbox'] },
      { code: 'nav.clinical.nurse_roster', label: 'Nurse roster', uiCodes: ['topnav.clinical.nurse_roster', 'sb.nurse_roster'] },
      { code: 'nav.clinical.doctor_roster', label: 'Doctor roster', uiCodes: ['topnav.clinical.doctor_roster'] },
      { code: 'nav.clinical.patients', label: 'Patient directory', uiCodes: ['sb.patients'] },
      { code: 'nav.clinical.appointments', label: 'Appointments', uiCodes: ['sb.appointments'] },
      { code: 'nav.clinical.prescriptions', label: 'Prescriptions', uiCodes: ['sb.prescriptions', 'topnav.clinical.prescriptions'] },
    ],
  },
  {
    code: 'nav.operations',
    label: 'Operations',
    icon: 'fa-cogs',
    color: '#0c8b8b',
    uiCodes: ['topnav.operations'],
    children: [
      { code: 'nav.ops.hms_hub', label: 'Medical Center', uiCodes: ['topnav.ops.hms_hub', 'topnav.clinical.hms', 'sb.hms_hub'] },
      { code: 'nav.ops.cashier', label: 'Cashier', uiCodes: ['topnav.ops.cashier', 'sb.cashier'] },
      { code: 'nav.ops.wallet', label: 'Patient wallets', uiCodes: ['topnav.ops.wallet', 'sb.wallet_admin', 'topnav.ops.wallet_admin'] },
      { code: 'nav.ops.inventory', label: 'Inventory', uiCodes: ['topnav.ops.inventory', 'sb.inventory'] },
      { code: 'nav.ops.procurement', label: 'Procurement', uiCodes: ['topnav.ops.procurement', 'sb.procurement'] },
      { code: 'nav.ops.catalog', label: 'Service catalog', uiCodes: ['topnav.ops.catalog', 'sb.catalog'] },
      { code: 'nav.ops.lab', label: 'Laboratory', uiCodes: ['topnav.ops.lab', 'sb.laboratory'] },
      { code: 'nav.ops.pharmacy', label: 'Pharmacy', uiCodes: ['topnav.ops.pharmacy', 'sb.pharmacy'] },
      { code: 'nav.ops.radiology', label: 'Radiology', uiCodes: ['topnav.ops.radiology', 'sb.radiology'] },
      { code: 'nav.ops.mgmt_reports', label: 'Management Reports', uiCodes: ['topnav.ops.mgmt_reports', 'sb.mgmt_reports'] },
    ],
  },
  {
    code: 'nav.hr',
    label: 'HR',
    icon: 'fa-id-badge',
    color: '#7c3aed',
    uiCodes: ['topnav.hr'],
    children: [
      { code: 'nav.hr.employees', label: 'Employees', uiCodes: ['topnav.hr.employees', 'sb.employees'] },
      { code: 'nav.hr.payroll', label: 'Payroll & HR', uiCodes: ['topnav.hr.payroll', 'sb.payroll'] },
      { code: 'nav.hr.leave_req', label: 'Leave approvals', uiCodes: ['topnav.hr.leave_req', 'sb.hr_leave_requests'] },
      { code: 'nav.hr.leave_bal', label: 'Leave balances', uiCodes: ['topnav.hr.leave_bal', 'sb.hr_leave_balances'] },
      { code: 'nav.hr.holidays', label: 'HR holidays', uiCodes: ['sb.hr_holidays', 'topnav.hr.holidays'] },
      { code: 'nav.hr.attendance', label: 'Attendance', uiCodes: ['sb.attendance', 'topnav.hr.attendance'] },
    ],
  },
  {
    code: 'nav.configuration',
    label: 'Settings',
    icon: 'fa-sliders',
    color: '#1a6bd8',
    uiCodes: ['topnav.configuration'],
    children: [
      { code: 'nav.cfg.financials', label: 'Financials', uiCodes: ['topnav.cfg.financials', 'sb.financials'] },
      { code: 'nav.cfg.tax', label: 'Tax hub', uiCodes: ['topnav.cfg.tax', 'sb.tax_hub'] },
      { code: 'nav.cfg.departments', label: 'Departments & specialisations', uiCodes: ['topnav.cfg.departments', 'sb.departments_catalog'] },
      { code: 'nav.cfg.consultation_rooms', label: 'Room Configuration', uiCodes: ['topnav.cfg.consultation_rooms', 'sb.consultation_rooms', 'topnav.cfg.hms_config'] },
      { code: 'nav.cfg.prescription_verify', label: 'Verify Rx QR', uiCodes: ['topnav.cfg.prescription_verify'] },
      { code: 'nav.cfg.product_doc', label: 'Product document', uiCodes: ['topnav.cfg.product_doc'] },
      { code: 'nav.cfg.commission', label: 'Commission rules', uiCodes: ['topnav.cfg.commission'] },
      { code: 'nav.cfg.hms_config', label: 'Room Configuration', uiCodes: ['topnav.cfg.hms_config'] },
      { code: 'nav.cfg.comprehensive_guide', label: 'Comprehensive user guide', uiCodes: ['topnav.cfg.comprehensive_guide'] },
      { code: 'nav.cfg.access', label: 'Access control', uiCodes: ['topnav.cfg.access', 'sb.access'] },
      { code: 'nav.cfg.employee_add', label: 'Create new employee', uiCodes: ['topnav.cfg.employee_add'] },
      { code: 'nav.cfg.employee_password', label: 'Reset employee password', uiCodes: ['topnav.cfg.employee_password'] },
      { code: 'nav.cfg.users', label: 'System users', uiCodes: ['topnav.cfg.users'] },
      { code: 'nav.cfg.subscriptions', label: 'Solution subscriptions', uiCodes: ['topnav.cfg.subscriptions', 'sb.subscriptions'] },
      { code: 'nav.cfg.super_admin', label: 'Super admin', uiCodes: ['topnav.cfg.super_admin', 'sb.super_admin'] },
      { code: 'nav.cfg.guides', label: 'Workflow guides', uiCodes: ['topnav.cfg.guides', 'sb.guides'] },
      { code: 'nav.cfg.manual', label: 'User manual', uiCodes: ['topnav.cfg.manual', 'sb.manual'] },
      { code: 'nav.cfg.payment_validity', label: 'Payment Validity', uiCodes: ['sb.payment_validity', 'topnav.cfg.payment_validity'] },
    ],
  },
  {
    code: 'nav.core',
    label: 'Core sidebar',
    icon: 'fa-home',
    color: '#475569',
    uiCodes: [],
    children: [
      { code: 'nav.core.hms_hub', label: 'Medical Center', uiCodes: ['sb.hms_hub', 'topnav.ops.hms_hub', 'topnav.clinical.hms'] },
      { code: 'nav.core.dashboard', label: 'Dashboard', uiCodes: ['sb.dashboard'] },
      { code: 'nav.core.credit', label: 'Credit & receivables', uiCodes: ['sb.credit', 'topnav.ops.credit'] },
      { code: 'nav.core.insurance', label: 'Insurance', uiCodes: ['sb.insurance', 'sb.insurance_claims', 'topnav.ops.insurance', 'topnav.ops.insurance_claims'] },
    ],
  },
]);

const _uiToBundles = new Map();
const _flatBundles = [];

function walk(nodes, parentCode) {
  for (const n of nodes) {
    const entry = { ...n, parentCode: parentCode || null };
    _flatBundles.push(entry);
    for (const ui of n.uiCodes || []) {
      if (!_uiToBundles.has(ui)) _uiToBundles.set(ui, []);
      _uiToBundles.get(ui).push(n.code);
    }
    if (n.children) walk(n.children, n.code);
  }
}
walk(NAV_ACCESS_TREE, null);

function flatBundles() {
  return _flatBundles.slice();
}

function tree() {
  return NAV_ACCESS_TREE;
}

function bundleByCode(code) {
  return _flatBundles.find((b) => b.code === code) || null;
}

function descendantBundleCodes(rootCode) {
  for (const root of NAV_ACCESS_TREE) {
    if (root.code === rootCode) {
      return [root.code, ...(root.children || []).map((c) => c.code)];
    }
    for (const ch of root.children || []) {
      if (ch.code === rootCode) return [ch.code];
    }
  }
  return [];
}

function uiCodesForBundle(navCode) {
  const b = bundleByCode(navCode);
  if (!b) return [];
  const codes = new Set(b.uiCodes || []);
  if (b.children) {
    for (const ch of b.children) {
      for (const u of ch.uiCodes || []) codes.add(u);
    }
  }
  if (navCode.startsWith('nav.') && !navCode.includes('.', 4)) {
    for (const root of NAV_ACCESS_TREE) {
      if (root.code === navCode && root.children) {
        for (const ch of root.children) {
          for (const u of ch.uiCodes || []) codes.add(u);
        }
      }
    }
  }
  return [...codes];
}

function bundlesForUiCode(uiCode) {
  return _uiToBundles.get(String(uiCode)) || [];
}

function parentTopnavCode(uiCode) {
  const c = String(uiCode);
  if (c.startsWith('topnav.clinical')) return 'nav.clinical';
  if (c.startsWith('topnav.ops') || c.startsWith('topnav.operations')) return 'nav.operations';
  if (c.startsWith('topnav.hr')) return 'nav.hr';
  if (c.startsWith('topnav.cfg') || c.startsWith('topnav.configuration')) return 'nav.configuration';
  return null;
}

module.exports = {
  NAV_ACCESS_TREE,
  tree,
  flatBundles,
  bundleByCode,
  descendantBundleCodes,
  uiCodesForBundle,
  bundlesForUiCode,
  parentTopnavCode,
};
