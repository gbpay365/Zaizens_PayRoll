'use strict';

/**
 * Self-healing ACL schema + seed.
 *
 * Adds three tables on top of the existing tbl_acl_permission /
 * tbl_acl_role_permission (which we keep untouched for backwards
 * compatibility):
 *
 *   tbl_acl_module        - logical group of permissions (cashier, opd, lab…)
 *                           with icon + colour for the admin UI.
 *   tbl_acl_role_portal   - which portals each role can access; one row per
 *                           role can carry is_home=1 to define the landing
 *                           portal (replaces the hardcoded portalMap).
 *   tbl_acl_ui_element    - master list of every clickable / visible thing
 *                           in the app (sidebar item, dashboard tile, card).
 *                           This is what the admin can toggle / reorder /
 *                           rename per portal — the heart of the redesign.
 *
 * Also adds module_code + action columns to tbl_acl_permission and
 * back-fills them from the existing dotted code (`patient.read` → module
 * `patient`, action `read`).
 *
 * Idempotent: re-running on an already-migrated DB is a no-op except for
 * picking up newly-introduced seed rows.
 */

module.exports = async function ensureAclSchema(pool) {
  // ── 1. tbl_acl_module ───────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_acl_module (
      code        VARCHAR(40)  NOT NULL,
      label       VARCHAR(120) NOT NULL,
      icon        VARCHAR(40)  DEFAULT 'fa-cube',
      color       VARCHAR(20)  DEFAULT '#1a6bd8',
      sort_order  INT          DEFAULT 0,
      PRIMARY KEY (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  // ── 2. tbl_acl_role_portal ──────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_acl_role_portal (
      role         VARCHAR(20) NOT NULL,
      portal_code  VARCHAR(40) NOT NULL,
      is_home      TINYINT(1)  NOT NULL DEFAULT 0,
      PRIMARY KEY (role, portal_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  // ── 3. tbl_acl_role_ui_hidden (per-role hide overrides for tiles/sidebar) ─
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_acl_role_ui_hidden (
      role          VARCHAR(20) NOT NULL,
      element_code  VARCHAR(80) NOT NULL,
      PRIMARY KEY (role, element_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  // ── 3b. tbl_acl_audit (immutable trail of every ACL mutation) ───────
  //   Whoever touched permissions / portals / UI overrides / roles in the
  //   admin UI ends up here. We keep the schema flat & denormalised so a
  //   later DELETE on tbl_employee or tbl_role doesn't blank out history.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_acl_audit (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor_id     INT          NULL,
      actor_name   VARCHAR(120) NULL,
      action       VARCHAR(40)  NOT NULL,
      role         VARCHAR(20)  NULL,
      target       VARCHAR(160) NULL,
      detail       TEXT         NULL,
      KEY idx_acl_audit_created (created_at),
      KEY idx_acl_audit_role    (role, created_at),
      KEY idx_acl_audit_action  (action, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  // ── 4. tbl_acl_ui_element ───────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_acl_ui_element (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      code          VARCHAR(80)  NOT NULL,
      portal_code   VARCHAR(40)  NOT NULL,
      kind          ENUM('sidebar','tile','card','button','section') NOT NULL,
      parent_code   VARCHAR(80)  NULL,
      label         VARCHAR(160) NOT NULL,
      url           VARCHAR(255) NULL,
      icon          VARCHAR(40)  NULL,
      color         VARCHAR(20)  NULL,
      sort_order    INT          NOT NULL DEFAULT 0,
      required_perm VARCHAR(255) NOT NULL DEFAULT '',
      enabled       TINYINT(1)   NOT NULL DEFAULT 1,
      UNIQUE KEY uq_ui_code (code),
      KEY idx_portal_kind (portal_code, kind, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  // Extend UI element kinds: action menus + Odoo top navigation catalogue.
  try {
    await pool.query(`
      ALTER TABLE tbl_acl_ui_element
      MODIFY COLUMN kind ENUM(
        'sidebar','tile','card','button','section','stat','action_menu','topnav','topnav_item','fin_topnav','fin_topnav_item'
      ) NOT NULL
    `);
  } catch (e) {
    const msg = String(e.message || '');
    if (!/Duplicate|Unknown column|doesn't exist/i.test(msg)) {
      // ignore on very old / exotic servers; seeds may fail loudly on INSERT
    }
  }

  // ── 5. tbl_acl_permission: add module_code + action ─────────────────
  const addCol = async (sql) => {
    try { await pool.query(sql); }
    catch (e) {
      const msg = String(e.message || '');
      const dup = e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060 ||
                  /Duplicate column/i.test(msg) || /already exists/i.test(msg);
      if (!dup) throw e;
    }
  };
  await addCol(`ALTER TABLE tbl_acl_permission ADD COLUMN module_code VARCHAR(40) NULL AFTER code`);
  await addCol(`ALTER TABLE tbl_acl_permission ADD COLUMN action      VARCHAR(20) NOT NULL DEFAULT 'read'`);
  await addCol(`ALTER TABLE tbl_acl_permission ADD COLUMN description TEXT NULL`);

  // Back-fill module_code + action from the dotted code.
  await pool.query(`
    UPDATE tbl_acl_permission
       SET module_code = SUBSTRING_INDEX(code, '.', 1),
           action      = COALESCE(NULLIF(SUBSTRING_INDEX(code, '.', -1), code), 'read')
     WHERE module_code IS NULL OR module_code = ''
  `);

  // ── 6. Seed modules ─────────────────────────────────────────────────
  const modules = [
    ['patient',         'Patient Records',     'fa-user',            '#0ea5e9', 10],
    ['patient_directory','Patient directory (⋯ row menu)','fa-ellipsis-v','#64748b', 11],
    ['scheduling',      'Scheduling',          'fa-calendar',        '#f59e0b', 20],
    ['opd',             'OPD',                 'fa-list-alt',        '#1a6bd8', 30],
    ['emergency',       'Emergency / A&E',     'fa-ambulance',       '#dc2626', 35],
    ['vaccination',     'Vaccination / Immunization', 'fa-plus-square', '#059669', 37],
    ['ipd_medication',  'IPD Medication',      'fa-medkit',          '#0f766e', 36],
    ['clinical',        'Clinical',            'fa-stethoscope',     '#0891b2', 40],
    ['consult',         'Consultation',        'fa-comments',        '#0c8b8b', 45],
    ['nursing',         'Nursing',             'fa-heartbeat',       '#ec4899', 50],
    ['adt',             'Admission / Beds',    'fa-bed',             '#0891b2', 55],
    ['lab',             'Laboratory',          'fa-flask',           '#16a34a', 60],
    ['radiology',       'Radiology',           'fa-film',            '#7c3aed', 65],
    ['pharmacy',        'Pharmacy',            'fa-medkit',          '#16a34a', 70],
    ['prescription',    'Prescription',        'fa-medkit',          '#22c55e', 72],
    ['inventory',       'Inventory',           'fa-cubes',           '#1a6bd8', 75],
    ['cashier',         'Cashier',             'fa-money',           '#10b981', 80],
    ['billing',         'Billing',             'fa-file-text-o',     '#1a6bd8', 82],
    ['accounting',      'Accounting',          'fa-calculator',      '#1e40af', 85],
    ['credit',          'Credit / Receivables','fa-file-text',       '#be123c', 86],
    ['expenses',        'Expenses',            'fa-money',           '#be185d', 87],
    ['financials',      'Financial Reports',   'fa-line-chart',      '#1a6bd8', 88],
    ['service_catalog', 'Service Catalog',     'fa-list',            '#475569', 90],
    ['payroll',         'Payroll & HR',        'fa-money',           '#475569', 92],
    ['employee',        'Employees',           'fa-id-badge',        '#475569', 94],
    ['procurement',     'Procurement',         'fa-truck',           '#0ea5e9', 95],
    ['assets',          'Asset Management',    'fa-building',        '#6366f1', 94],
    ['analytics',       'Analytics',           'fa-bar-chart',       '#7c3aed', 96],
    ['audit',           'Audit Log',           'fa-history',         '#475569', 97],
    ['interop',         'Interoperability',    'fa-exchange',        '#475569', 98],
    ['ai',              'AI Manager',          'fa-robot',           '#7c3aed', 99],
    ['mpi',             'Master Patient Index','fa-merge',           '#0ea5e9', 100],
    ['chart',           'Patient Chart',       'fa-file-text-o',     '#0891b2', 25],
    ['insurance',       'Insurance',           'fa-shield',          '#7c3aed', 83],
    ['portal',          'Patient Portal',      'fa-heartbeat',       '#0369a1', 26],
    ['profile',         'My Profile',          'fa-user-circle',    '#475569', 93],
    ['facility',        'Facility Admin',      'fa-hospital-o',      '#1e40af', 101],
    ['access_control',  'Access Control',      'fa-lock',            '#1e40af', 102],
    ['subscriptions',   'Solution Subscriptions', 'fa-key',          '#0891b2', 103],
    ['doctor_duty',     'Doctor Duty Roster',  'fa-calendar-check-o','#1a6bd8', 103],
    ['nurse_duty',      'Nurse Duty Roster',   'fa-calendar-o',      '#0891b2', 104],
    ['dashboard',       'Dashboards',          'fa-dashboard',       '#1a6bd8', 5],
    ['hms_reports',     'Management Reports',  'fa-bar-chart',       '#5b21b6', 97],
  ];
  for (const [code, label, icon, color, ord] of modules) {
    await pool.query(
      `INSERT INTO tbl_acl_module (code,label,icon,color,sort_order)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE label=VALUES(label),
                               icon=VALUES(icon),
                               color=VALUES(color),
                               sort_order=VALUES(sort_order)`,
      [code, label, icon, color, ord]
    );
  }

  // ── 7. Seed all permission codes referenced by routes, sidebar, and tiles ─
  // Using INSERT IGNORE so existing admin grants are never clobbered.
  const newPerms = [
    // Patient
    ['patient.read',     'Patients: view records & directory',           'patient'],
    ['patient.write',    'Patients: register & edit records',            'patient'],
    ['patient.delete',   'Patients: archive / permanently delete',       'patient'],
    ['patient.directory.chart',     'Directory ⋯: View chart',           'patient_directory'],
    ['patient.directory.insurance', 'Directory ⋯: Manage insurance',   'patient_directory'],
    ['patient.directory.credit',    'Directory ⋯: Open credit account', 'patient_directory'],
    ['patient.directory.portal',    'Directory ⋯: Patient portal setup','patient_directory'],
    ['patient.directory.edit',      'Directory ⋯: Edit demographics',   'patient_directory'],
    ['chart.read',       'Patient chart: view medical history & chart',  'chart'],
    ['chart.write',      'Patient chart: edit chart data & clinical notes', 'chart'],
    // Scheduling
    ['scheduling.read',  'Scheduling: view appointments & slots',        'scheduling'],
    ['scheduling.write', 'Scheduling: create & edit appointments',       'scheduling'],
    // OPD
    ['opd.read',         'OPD: view queue & visits',                     'opd'],
    ['opd.write',        'OPD: manage queue, triage & visit actions',    'opd'],
    // Emergency / A&E
    ['emergency.read',   'Emergency: view A&E queue & cases',            'emergency'],
    ['emergency.write',  'Emergency: manage A&E cases & triage',         'emergency'],
    ['maternity.read',   'Maternity: view ANC registry & obstetric charts', 'maternity'],
    ['maternity.write',  'Maternity: record ANC, labor, delivery & postnatal', 'maternity'],
    ['vaccination.read', 'Vaccination: view immunization registry & charts', 'vaccination'],
    ['vaccination.write','Vaccination: administer doses & manage queue', 'vaccination'],
    // IPD Medication (treatments, drug chart, shift reports, discharge)
    ['ipd_medication.read',  'IPD Medication: view hub, treatments, charts & audit', 'ipd_medication'],
    ['ipd_medication.write', 'IPD Medication: prescribe, administer, shift & discharge','ipd_medication'],
    // Clinical
    ['clinical.read',    'Clinical: view consultations & orders',        'clinical'],
    ['clinical.write',   'Clinical: create/edit consultations & orders', 'clinical'],
    // Nursing
    ['nursing.read',     'Nursing: view ward tasks & vitals',            'nursing'],
    ['nursing.write',    'Nursing: record vitals, ward notes & tasks',   'nursing'],
    // ADT (Admissions / Beds)
    ['adt.read',         'ADT: view admissions, beds & IPD census',      'adt'],
    ['adt.write',        'ADT: admit, transfer & discharge patients',    'adt'],
    // Laboratory
    ['lab.read',         'Lab: view test orders & results',              'lab'],
    ['lab.write',        'Lab: enter & validate test results',           'lab'],
    // Radiology
    ['radiology.read',   'Radiology: view exam orders & reports',        'radiology'],
    ['radiology.write',  'Radiology: enter & validate radiology reports','radiology'],
    // Pharmacy
    ['pharmacy.read',    'Pharmacy: view dispensing queue',              'pharmacy'],
    ['pharmacy.write',   'Pharmacy: dispense medications',               'pharmacy'],
    // Prescription
    ['prescription.read', 'Prescriptions: view prescriptions',          'prescription'],
    ['prescription.write','Prescriptions: write & edit prescriptions',  'prescription'],
    // Inventory
    ['inventory.read',   'Inventory: view stock levels & items',         'inventory'],
    ['inventory.write',  'Inventory: adjust stock, receive & issue',     'inventory'],
    ['procurement.read', 'Procurement: view vendors, RFQ, PO & receipts', 'procurement'],
    ['procurement.write','Procurement: create vendors, PO & goods receipt', 'procurement'],
    ['assets.read',      'Assets: view hospital assets, apartments & rentals', 'assets'],
    ['assets.write',     'Assets: register assets, units, contracts & payments', 'assets'],
    // Cashier
    ['cashier.read',     'Cashier: view payment tickets & queue',        'cashier'],
    ['cashier.write',    'Cashier: collect payments & issue receipts',   'cashier'],
    // Billing
    ['billing.read',     'Billing: view invoices & charges',             'billing'],
    ['billing.write',    'Billing: post charges & edit invoices',        'billing'],
    // Payment slip validity (OPD consultation window & max uses)
    ['payment.validity.read',  'Payment validity: view OPD slip rules',  'billing'],
    ['payment.validity.write', 'Payment validity: edit OPD slip rules',  'billing'],
    // Accounting
    ['accounting.read',  'Accounting: view reports & journals',          'accounting'],
    ['accounting.write', 'Accounting: post journals & manage accounts',  'accounting'],
    // Financial Reports
    ['financials.read',  'Financials: view P&L, balance sheet, reports', 'financials'],
    ['financials.write', 'Financials: manage financial settings',        'financials'],
    // Credit / Receivables
    ['credit.read',      'Credit & AR: view receivables & credit notes', 'credit'],
    ['credit.write',     'Credit & AR: manage credit accounts',          'credit'],
    // Insurance (carriers & claims)
    ['insurance.read',   'Insurance: view carriers & claims',            'insurance'],
    ['insurance.write',  'Insurance: manage carriers & claims',          'insurance'],
    // Patient portal (staff — enrollment, invites, disable)
    ['patient_portal.manage', 'Patient portal: staff setup & invitations', 'portal'],
    // Own staff profile / password
    ['profile.self.write', 'My profile: edit own account & password',   'profile'],
    ['hr.self.read',       'HR self-service: my leave, payslips & attendance', 'payroll'],
    // Expenses
    ['expenses.read',    'Expenses: view expense claims & reports',      'expenses'],
    ['expenses.write',   'Expenses: create & approve expense claims',    'expenses'],
    // Payroll & HR
    ['payroll.read',     'Payroll & HR: view payroll & attendance',      'payroll'],
    ['payroll.write',    'Payroll & HR: edit payroll & post salaries',   'payroll'],
    ['hr.leave.approve', 'HR admin: leave approvals, balances & holidays', 'payroll'],
    // Employees
    ['employee.read',    'Employees: view staff directory & profiles',   'employee'],
    ['employee.write',   'Employees: create, edit & deactivate staff',   'employee'],
    ['employee.password.manage', 'Employees: set & reset staff login passwords', 'employee'],
    // Service Catalog
    ['service_catalog.consultation.read',  'Catalog: view consultation catalog',     'service_catalog'],
    ['service_catalog.consultation.write', 'Catalog: manage consultation catalog',   'service_catalog'],
    ['service_catalog.laboratory.read',    'Catalog: view lab test catalog',         'service_catalog'],
    ['service_catalog.laboratory.write',   'Catalog: manage lab test catalog',       'service_catalog'],
    ['service_catalog.pharmacy.read',      'Catalog: view pharmacy/drug catalog',    'service_catalog'],
    ['service_catalog.pharmacy.write',     'Catalog: manage pharmacy catalog',       'service_catalog'],
    ['service_catalog.radiology.read',     'Catalog: view radiology catalog',        'service_catalog'],
    ['service_catalog.radiology.write',    'Catalog: manage radiology catalog',      'service_catalog'],
    ['service_catalog.general.read',       'Catalog: view general service tariffs',  'service_catalog'],
    ['service_catalog.general.write',      'Catalog: manage general service tariffs','service_catalog'],
    // Analytics
    ['analytics.read',   'Analytics: view dashboards & reports',         'analytics'],
    // Doctor Duty Roster
    ['doctor_duty.read',  'Doctor Duty: view roster',                   'doctor_duty'],
    ['doctor_duty.write', 'Doctor Duty: edit duty roster',              'doctor_duty'],
    // Nurse Duty Roster
    ['nurse_duty.read',   'Nurse Duty: view roster',                    'nurse_duty'],
    ['nurse_duty.write',  'Nurse Duty: edit duty roster',               'nurse_duty'],
    // Dashboard
    ['dashboard.read',   'Dashboard: view main HMS dashboard',           'dashboard'],
    // Access Control
    ['access_control.manage', 'Access Control: manage roles & permissions', 'access_control'],
    ['subscriptions.manage', 'Subscriptions: request and activate solution licenses', 'subscriptions'],
    ['visiting_doctor.setup', 'Visiting doctors: complete shared-account setup', 'employee'],
    ['visiting_doctor.manage', 'Visiting doctors: manage pool & release accounts', 'employee'],
  ];

  const { ALL_REPORT_PERMISSIONS } = require('./hmsDirectorReportsCatalog');
  for (const [code, label] of ALL_REPORT_PERMISSIONS) {
    newPerms.push([code, label, 'hms_reports']);
  }

  const {
    ALL_DIRECTOR_REVENUE_PERMISSIONS,
    ALL_DIRECTOR_DASHBOARD_PERMISSIONS,
  } = require('./directorDashboardCatalog');
  const { ALL_DIRECTOR_WEEKLY_PERMISSIONS } = require('./directorWeeklyReportCatalog');
  const { ALL_DIRECTOR_MONTHLY_PERMISSIONS } = require('./directorMonthlyPLCatalog');
  const { ALL_DIRECTOR_ANNUAL_PERMISSIONS } = require('./directorAnnualScorecardCatalog');
  const { ALL_ASSISTANT_DIRECTOR_DASHBOARD_PERMISSIONS } = require('./assistantDirectorDashboardCatalog');
  const { ALL_FRONT_DESK_DASHBOARD_PERMISSIONS } = require('./frontDeskDashboardCatalog');
  const { ALL_SECRETARY_DASHBOARD_PERMISSIONS } = require('./secretaryDashboardCatalog');
  for (const [code, label, mod] of [
    ...ALL_DIRECTOR_DASHBOARD_PERMISSIONS,
    ...ALL_DIRECTOR_REVENUE_PERMISSIONS,
    ...ALL_DIRECTOR_WEEKLY_PERMISSIONS,
    ...ALL_DIRECTOR_MONTHLY_PERMISSIONS,
    ...ALL_DIRECTOR_ANNUAL_PERMISSIONS,
    ...ALL_ASSISTANT_DIRECTOR_DASHBOARD_PERMISSIONS,
    ...ALL_FRONT_DESK_DASHBOARD_PERMISSIONS,
    ...ALL_SECRETARY_DASHBOARD_PERMISSIONS,
  ]) {
    newPerms.push([code, label, mod]);
  }

  for (const [code, label, mod] of newPerms) {
    await pool.query(
      `INSERT IGNORE INTO tbl_acl_permission (code, label, gap_area, module_code, action)
       VALUES (?, ?, 0, ?, SUBSTRING_INDEX(?, '.', -1))`,
      [code, label, mod, code]
    );
  }

  // ── 8. Seed role↔portal mapping (replaces hardcoded portalMap) ──────
  // role_num → [home_portal, ...other_accessible_portals]
  const rolePortals = [
    ['2',  ['doctor',          'patient_support']],
    ['3',  ['front_desk',      'patient_support']],
    ['4',  ['labtech']],
    ['5',  ['pharmacy']],
    ['6',  ['radiology']],
    ['7',  ['nurse',           'patient_support']],
    ['8',  ['nurse']],
    ['9',  ['accountant']],
    ['10', ['front_desk']],
    ['11', ['cashier']],
    ['101',['front_desk']],
    ['103',['nurse']],
    ['105',['pharmacy']],
    ['100',['doctor', 'front_desk', 'nurse', 'labtech', 'pharmacy', 'cashier']],
  ];
  for (const [role, portals] of rolePortals) {
    const [[cntRow]] = await pool
      .query('SELECT COUNT(*) AS n FROM tbl_acl_role_portal WHERE role=?', [role])
      .catch(() => [[{ n: 1 }]]);
    if ((cntRow?.n || 0) > 0) continue;
    for (let i = 0; i < portals.length; i++) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_portal (role, portal_code, is_home)
         VALUES (?, ?, ?)`,
        [role, portals[i], i === 0 ? 1 : 0]
      );
    }
  }

  // ── 9. Seed UI elements ─────────────────────────────────────────────
  // The single source of truth for sidebar items + dashboard tiles + cards.
  // Each entry: [code, portal, kind, label, url, icon, color, perm, sort, parent].
  // perm is a single key OR a `|`-separated OR-list. Use '*' for "always show".
  //
  // We define a generic 'global' portal_code for the main left sidebar that
  // appears on every page; portal-specific items live under their portal.
  const elements = [
    // ── Global sidebar (used by header.ejs for every authenticated page) ──
    ['sb.home',           'global', 'sidebar', 'Home',                '__home__',                 'fa-home',                  null, '*',                                                            5,   null],
    ['sb.hms_hub',        'global', 'sidebar', 'Medical Center',        '/hms',                     'fa-hospital-o',            '#714b67', 'cashier.read|billing.read|clinical.read|clinical.write|opd.read|patient.read|nursing.read', 8,   null],
    ['sb.dashboard',      'global', 'sidebar', 'Dashboard',           '/dashboard',               'fa-dashboard',             null, 'dashboard.read|*',                                              10,  null],
    ['sb.patients',       'global', 'sidebar', 'Patient Directory',   '/patients',                'fa-user',                  null, 'patient.read|patient.write',                                    20,  null],
    ['sb.appointments',   'global', 'sidebar', 'Appointments',        '/appointments',            'fa-calendar',              null, 'scheduling.read|scheduling.write|opd.read',                    30,  null],
    ['sb.opd',            'global', 'sidebar', 'OPD Visits',          '/opd-queue',               'fa-list-alt',              null, 'opd.read|clinical.read|clinical.write|scheduling.read',         40,  null],
    ['sb.emergency',      'global', 'sidebar', 'Emergency / A&E',     '/emergency',               'fa-ambulance',             '#dc2626','emergency.read|clinical.write|adt.read',                     50,  null],
    ['sb.maternity',      'global', 'sidebar', 'Maternity / ANC',     '/maternity',               'fa-female',                '#9d174d','maternity.read|maternity.write|clinical.read|clinical.write|nursing.read|nursing.write', 52,  null],
    ['sb.vaccination',    'global', 'sidebar', 'Vaccination',           '/vaccination',             'fa-plus-square',           '#059669','vaccination.read|vaccination.write|clinical.read|clinical.write|nursing.read|nursing.write', 53,  null],
    ['sb.ipd_hub',        'global', 'sidebar', 'Hospitalization',     '/ipd',                     'fa-hospital-o',            '#1e40af','adt.read|adt.write|nursing.read|clinical.read|clinical.write', 54,  null],
    ['sb.ipd_medication', 'global', 'sidebar', 'IPD Medication',      '/ipd/medication',          'fa-medkit',                '#0f766e','ipd_medication.read|ipd_medication.write|adt.read|nursing.read|clinical.read|clinical.write', 55,  null],
    ['sb.ipd_inbox',      'global', 'sidebar', 'IPD Nurse Messages',  '/ipd/inbox',               'fa-envelope',              '#0369a1','ipd_medication.read|ipd_medication.write|clinical.write', 56,  null],
    ['sb.wards',          'global', 'sidebar', 'Ward Board / IPD',    '/wards',                   'fa-bed',                   null, 'adt.read|adt.write|nursing.read',                              60,  null],
    ['sb.census',         'global', 'sidebar', 'IPD Census',          '/ipd/census',              'fa-users',                 null, 'adt.read|adt.write|nursing.read',                              65,  null],
    ['sb.death_registry', 'global', 'sidebar', 'Death registry',      '/death-registry',          'fa-heartbeat',             '#be123c','adt.read|adt.write|clinical.read|clinical.write|nursing.read|nursing.write|emergency.read|maternity.read', 66,  null],
    ['sb.nurse_roster',   'global', 'sidebar', 'Nurse Roster',        '/nurse-roster',            'fa-calendar-o',            null, 'nurse_duty.read|nurse_duty.write',                              70,  null],
    ['sb.doctor_roster',  'global', 'sidebar', 'Doctor Roster',       '/doctor-roster',           'fa-calendar-check-o',      null, 'doctor_duty.read|doctor_duty.write',                           75,  null],
    ['sb.cashier',        'global', 'sidebar', 'Cashier',             '/cashier',                 'fa-money',                 null, 'cashier.read|cashier.write',                                   80,  null],
    ['sb.wallet',         'global', 'sidebar', 'Patient Wallets',     '/wallet',                  'fa-credit-card',           null, 'cashier.read|cashier.write|billing.read|accounting.read',       85,  null],
    ['sb.inventory',      'global', 'sidebar', 'Inventory',           '/inventory',               'fa-cubes',                 null, 'inventory.read|inventory.write',                                90,  null],
    ['sb.procurement',    'global', 'sidebar', 'Procurement',         '/procurement',             'fa-truck',                 '#0ea5e9', 'procurement.read|procurement.write|inventory.read|inventory.write', 92,  null],
    ['sb.assets',         'global', 'sidebar', 'Asset Management',    '/assets',                  'fa-building',              '#6366f1', 'assets.read|assets.write', 93,  null],
    ['sb.catalog',        'global', 'sidebar', 'Service Catalog',     '/catalog',                 'fa-list',                  null, 'inventory.read|billing.read|service_catalog.consultation.read|service_catalog.laboratory.read|service_catalog.pharmacy.read|service_catalog.radiology.read|service_catalog.general.read', 95,  null],
    ['sb.lims',           'global', 'sidebar', 'Laboratory (LIMS)',   '/lims',                    'fa-flask',                 '#7c3aed', 'lab.read|lab.write|clinical.read|clinical.write|nursing.read', 99,  null],
    ['sb.lab',            'global', 'sidebar', 'Lab registry',        '/laboratory',              'fa-list-alt',              null, 'lab.read|lab.write',                                            100, null],
    ['sb.pharmacy',       'global', 'sidebar', 'Pharmacy',            '/pharmacy',                'fa-medkit',                null, 'pharmacy.read|pharmacy.write|prescription.read',                105, null],
    ['sb.radiology',      'global', 'sidebar', 'Radiology',           '/radiology',               'fa-film',                  null, 'radiology.read|radiology.write',                                110, null],
    ['sb.prescriptions',  'global', 'sidebar', 'Prescriptions',       '/prescriptions',           'fa-medkit',                null, 'prescription.read|prescription.write|pharmacy.read|pharmacy.write|clinical.read|clinical.write|nursing.read', 115, null],
    ['sb.financials',     'global', 'sidebar', 'Financials',          '/financials',              'fa-line-chart',            null, 'accounting.read|accounting.write|billing.write|financials.read',120, null],
    ['sb.mgmt_reports',   'global', 'sidebar', 'Director reports',    '/portal/hub/director',     'fa-bar-chart',             '#5b21b6', 'hms_reports.read|hms_reports.full|hms_reports.daily|hms_reports.weekly|hms_reports.monthly|hms_reports.financial', 118, null],
    ['sb.payroll',        'global', 'sidebar', 'Payroll & HR',        '/payroll',                 'fa-money',                 null, 'payroll.read|payroll.write|employee.read',                      125, null],
    ['sb.attendance',     'global', 'sidebar', 'Attendance',          '/hr/attendance',           'fa-clock-o',               null, 'payroll.read|payroll.write',                                    130, null],
    ['sb.tax_hub',        'global', 'sidebar', 'Tax hub',             '/tax',                     'fa-sliders',               '#1d4ed8', 'accounting.read|accounting.write',                       131, null],
    ['sb.hr_leave_requests', 'global', 'sidebar', 'Leave approvals', '/hr/leave-requests',     'fa-inbox',                 '#be123c', 'hr.leave.approve',                                         132, null],
    ['sb.hr_leave_balances', 'global', 'sidebar', 'Leave balances',   '/hr/leave-balances',       'fa-balance-scale',         '#0e7490', 'hr.leave.approve',                                         133, null],
    ['sb.hr_holidays',    'global', 'sidebar', 'HR holidays',         '/hr/holidays',             'fa-calendar',              '#b45309', 'hr.leave.approve',                                         134, null],
    ['sb.wallet_admin',   'global', 'sidebar', 'Wallet Management',   '/wallet-management',       'fa-credit-card',           null, 'accounting.read|cashier.write',                                 135, null],
    ['sb.credit',         'global', 'sidebar', 'Credit & Receivables','/credit-receivables',      'fa-file-text-o',           null, 'credit.read|credit.write|accounting.read',                      140, null],
    ['sb.insurance',      'global', 'sidebar', 'Insurance Carriers',  '/insurance',               'fa-shield',                null, 'insurance.read|insurance.write|accounting.read|accounting.write',                              145, null],
    ['sb.insurance_claims','global','sidebar', 'Insurance Claims',    '/insurance-claims',        'fa-file-text',             null, 'insurance.read|insurance.write|accounting.read|accounting.write',                              150, null],
    ['sb.users',          'global', 'sidebar', 'System Users',        '/users',                   'fa-shield',                '#312e81', '*',                                                         154, null],
    ['sb.employees',      'global', 'sidebar', 'Employees',           '/employees',               'fa-id-badge',              null, 'employee.read|employee.write',                                  155, null],
    ['sb.visiting_doctors','global','sidebar', 'Visiting doctors',    '/admin/visiting-doctors',  'fa-user-md',               '#0891b2', 'visiting_doctor.manage|employee.write|access_control.manage', 156, null],
    ['sb.access',         'global', 'sidebar', 'Access Control',      '/hms-admin/access',        'fa-sitemap',               null, 'access_control.manage',                                         160, null],
    ['sb.subscriptions',  'global', 'sidebar', 'Solution Subscriptions', '/hms-admin/subscriptions', 'fa-key',               '#0891b2', 'subscriptions.manage',                                      161, null],
    ['sb.guides',         'global', 'sidebar', 'Workflow Guides',     '/workflow-guides',         'fa-sitemap',               '#f59e0b','*',                                                          165, null],
    ['sb.manual',         'global', 'sidebar', 'User Manual',         '/user-manual',             'fa-book',                  '#1a6bd8','*',                                                          170, null],
    ['sb.payment_validity','global','sidebar', 'Payment Validity',    '/payment-validity',        'fa-clock-o',               '#7c3aed','payment.validity.read|payment.validity.write|billing.write', 172, null],
    ['sb.departments_catalog','global','sidebar', 'Departments & specialisations', '/departments', 'fa-sitemap', '#0c8b8b', 'employee.read|employee.write|access_control.manage', 173, null],
    ['sb.consultation_rooms','global','sidebar', 'Room configuration', '/admin/consultation-rooms', 'fa-door-open', '#0ea5e9', 'access_control.manage|opd.write|nursing.write|scheduling.read', 174, null],

    // ── Medical Center (/hms) — KPI stats, module cards, side panels ───────
    ['hub.stat.opd_open',           'hms', 'stat',    'OPD open today',        null, 'fa-list-alt',      '#00a09d', 'opd.read|clinical.read|clinical.write|scheduling.read|nursing.read', 10, null],
    ['hub.stat.in_consult',         'hms', 'stat',    'In consultation',       null, 'fa-stethoscope',   '#16a34a', 'opd.read|clinical.read|clinical.write|nursing.read', 20, null],
    ['hub.stat.appointments_today', 'hms', 'stat',    'Appointments today',    null, 'fa-calendar',      '#875a7b', 'scheduling.read|scheduling.write|opd.read', 30, null],
    ['hub.stat.ipd_active',         'hms', 'stat',    'Active IPD',            null, 'fa-hospital-o',    '#1e40af', 'adt.read|adt.write|nursing.read|clinical.read', 40, null],
    ['hub.stat.lab_open',           'hms', 'stat',    'Lab requests open',     null, 'fa-flask',         '#7c3aed', 'lab.read|lab.write|clinical.read', 50, null],
    ['hub.stat.rad_open',           'hms', 'stat',    'Radiology open',        null, 'fa-film',          '#0369a1', 'radiology.read|radiology.write|clinical.read', 60, null],
    ['hub.stat.pending_orders',     'hms', 'stat',    'Pending orders',        null, 'fa-clock-o',       '#d97706', 'clinical.read|clinical.write|opd.read|cashier.read|billing.read', 70, null],
    ['hub.stat.revenue_today',      'hms', 'stat',    'Revenue today',         null, 'fa-money',         '#334155', 'cashier.read|cashier.write|billing.read|accounting.read|financials.read|hms_reports.financial', 80, null],
    ['hub.stat.patients_total',     'hms', 'stat',    'Patients (registry)',   null, 'fa-users',         '#017e84', 'patient.read|patient.write', 85, null],
    ['hub.stat.doctors_active',     'hms', 'stat',    'Active doctors',        null, 'fa-user-md',       '#1a6bd8', 'employee.read|clinical.read|doctor_duty.read', 90, null],
    ['hub.card.patients',           'hms', 'card',    'Patients',              '/patients', 'fa-user', '#017e84', 'patient.read', 100, null],
    ['hub.card.appointments',       'hms', 'card',    'Appointments',          '/appointments', 'fa-calendar', '#875a7b', 'scheduling.read|scheduling.write|opd.read', 110, null],
    ['hub.card.opd_queue',          'hms', 'card',    'OPD queue',             '/opd-queue', 'fa-list-alt', '#00a09d', 'opd.read|clinical.read|clinical.write|scheduling.read', 120, null],
    ['hub.card.hospitalization',    'hms', 'card',    'Hospitalization',       '/ipd', 'fa-hospital-o', '#1e40af', 'adt.read|adt.write|nursing.read|clinical.read|clinical.write', 130, null],
    ['hub.card.laboratory',         'hms', 'card',    'Laboratory',            '/lims', 'fa-flask', '#7c3aed', 'lab.read|lab.write|clinical.read|clinical.write|nursing.read', 140, null],
    ['hub.card.radiology',          'hms', 'card',    'Radiology',             '/radiology', 'fa-film', '#0369a1', 'radiology.read|radiology.write|clinical.read', 150, null],
    ['hub.card.pharmacy',           'hms', 'card',    'Pharmacy',              '/pharmacy', 'fa-medkit', '#059669', 'pharmacy.read|pharmacy.write|prescription.read', 160, null],
    ['hub.card.cashier',            'hms', 'card',    'Cashier',               '/cashier', 'fa-money', '#d97706', 'cashier.read|cashier.write|billing.read', 170, null],
    ['hub.card.waiting_screen',     'hms', 'card',    'Waiting screen TV',     '/hms/waiting-screen', 'fa-television', '#0ea5e9', 'clinical.read|clinical.write|opd.read|nursing.read|*', 180, null],
    ['hub.card.appointment_slots',  'hms', 'card',    'Appointment slots',     '/hms/appointments/slots-config', 'fa-clock-o', '#875a7b', 'scheduling.write|clinical.write', 190, null],
    ['hub.card.reports',            'hms', 'card',    'Reports & print',       '/hms/reports', 'fa-print', '#64748b', 'clinical.read|analytics.read|financials.read|cashier.read|billing.read|hms_reports.read', 220, null],
    ['hub.panel.opd_today',         'hms', 'section', "Today's OPD list",      null, null, null, 'opd.read|clinical.read|clinical.write|scheduling.read|nursing.read', 300, null],

    // ── HMS statistics dashboard (/dashboard) — stat cards, toolbar links, panels ──
    ['dash.btn.new',            'dashboard', 'button',  'New patient',              '/patients?action=new', 'fa-plus',            '#16a34a', 'patient.write', 10, null],
    ['dash.link.lobby',         'dashboard', 'button',  'Lobby screen',             '/portal/call-queue',   null,                 null,      '*',             20, null],
    ['dash.link.hms_hub',       'dashboard', 'button',  'Medical Center',             '/hms',                 'fa-hospital-o',        '#714b67', 'clinical.read|clinical.write|opd.read|patient.read|nursing.read', 30, null],
    ['dash.link.reports',       'dashboard', 'button',  'Reports',                  '/hms/reports',         'fa-bar-chart',         '#5b21b6', 'hms_reports.read|hms_reports.full|analytics.read|*', 40, null],
    ['dash.link.front_desk',    'dashboard', 'button',  'Front office',             '/front-desk',          null,                 null,      'patient.read|scheduling.read|scheduling.write|opd.read', 50, null],
    ['dash.link.wards',         'dashboard', 'button',  'Wards',                    '/wards',               'fa-bed',               null,      'adt.read|adt.write|nursing.read', 60, null],
    ['dash.card.patients',      'dashboard', 'card',    'Patients',                 '/patients',            null,                 null,      'patient.read|patient.write', 100, null],
    ['dash.card.appointments',  'dashboard', 'card',    'Appointments',             '/appointments',        null,                 null,      'scheduling.read|scheduling.write|opd.read', 110, null],
    ['dash.card.inpatients',    'dashboard', 'card',    'Inpatients',               '/wards',               null,                 null,      'adt.read|adt.write|nursing.read', 120, null],
    ['dash.card.doctors',       'dashboard', 'card',    'Doctors',                  '/doctors',             null,                 null,      'employee.read|doctor_duty.read|clinical.read', 130, null],
    ['dash.card.emergencies',   'dashboard', 'card',    'Active emergencies',       '/emergency',           'fa-ambulance',         '#dc2626', 'emergency.read|clinical.write|adt.read', 140, null],
    ['dash.card.opd_queue',     'dashboard', 'card',    'OPD queue',                '/opd-queue',           'fa-list-alt',          null,      'opd.read|clinical.read|clinical.write|scheduling.read', 150, null],
    ['dash.card.maternity',     'dashboard', 'card',    'Maternity',                '/maternity',           'fa-female',            '#9d174d', 'maternity.read|maternity.write|clinical.read|clinical.write|nursing.read|nursing.write', 160, null],
    ['dash.card.vaccination',   'dashboard', 'card',    'Vaccination',              '/vaccination',         'fa-plus-square',       '#059669', 'vaccination.read|vaccination.write|clinical.read|clinical.write|nursing.read|nursing.write', 165, null],
    ['dash.card.laboratory',    'dashboard', 'card',    'Laboratory',               '/laboratory',          'fa-flask',             '#7c3aed', 'lab.read|lab.write', 170, null],
    ['dash.card.pharmacy',      'dashboard', 'card',    'Pharmacy',                 '/pharmacy',            'fa-medkit',            '#059669', 'pharmacy.read|pharmacy.write|prescription.read', 180, null],
    ['dash.card.cashier',       'dashboard', 'card',    'Cashier',                  '/cashier',             'fa-money',             '#d97706', 'cashier.read|cashier.write', 190, null],
    ['dash.panel.er_list',      'dashboard', 'section', 'Active emergencies list',  null,                   'fa-ambulance',         '#dc2626', 'emergency.read|clinical.write|adt.read', 200, null],
    ['dash.panel.chart',        'dashboard', 'section', 'Patient registrations chart', null,              null,                 null,      'patient.read|analytics.read|dashboard.read', 210, null],
    ['dash.panel.recent_appts', 'dashboard', 'section', 'Recent appointments',      null,                   null,                 null,      'scheduling.read|scheduling.write|opd.read', 220, null],
    ['dash.panel.new_patients', 'dashboard', 'section', 'New patients table',       null,                   null,                 null,      'patient.read|patient.write', 230, null],
    ['dash.panel.doctors_duty', 'dashboard', 'section', 'Doctors on duty',          null,                   null,                 null,      'employee.read|doctor_duty.read|clinical.read', 240, null],

    // ── Top navigation bar (Odoo-style header — hms-odoo-nav.ejs) ───────
    // Parent menus: hide the whole dropdown. Children: hide individual links.
    ['topnav.clinical',       'global', 'topnav',      'Clinical',              null, 'fa-stethoscope',       '#0891b2', 'opd.read|clinical.read|clinical.write|nursing.read|adt.read|emergency.read|maternity.read|maternity.write|vaccination.read|vaccination.write', 200, null],
    ['topnav.clinical.hms',   'global', 'topnav_item', 'Medical Center',          '/hms',                     'fa-hospital-o',        '#714b67', 'cashier.read|billing.read|clinical.read|clinical.write|opd.read|patient.read', 209, 'topnav.clinical'],
    ['topnav.clinical.opd',   'global', 'topnav_item', 'OPD visits',            '/opd-queue',               'fa-list-alt',          null, 'opd.read|clinical.read|clinical.write|scheduling.read', 210, 'topnav.clinical'],
    ['topnav.clinical.er',    'global', 'topnav_item', 'Emergency / A&E',       '/emergency',               'fa-ambulance',         '#dc2626', 'emergency.read|clinical.write|adt.read', 220, 'topnav.clinical'],
    ['topnav.clinical.maternity','global','topnav_item','Maternity / ANC',      '/maternity',               'fa-female',            '#9d174d', 'maternity.read|maternity.write|clinical.read|clinical.write|nursing.read|nursing.write', 225, 'topnav.clinical'],
    ['topnav.clinical.vaccination','global','topnav_item','Vaccination',        '/vaccination',             'fa-plus-square',       '#059669', 'vaccination.read|vaccination.write|clinical.read|clinical.write|nursing.read|nursing.write', 226, 'topnav.clinical'],
    ['topnav.clinical.ipd_hub','global','topnav_item','Hospitalization',       '/ipd',                     'fa-hospital-o',        '#1e40af', 'adt.read|adt.write|nursing.read|clinical.read|clinical.write', 228, 'topnav.clinical'],
    ['topnav.clinical.lims',  'global', 'topnav_item', 'Laboratory (LIMS)',   '/lims',                    'fa-flask',             '#7c3aed', 'lab.read|lab.write|clinical.read|clinical.write|nursing.read', 229, 'topnav.clinical'],
    ['topnav.clinical.wards', 'global', 'topnav_item', 'Ward board / beds',   '/wards',                   'fa-bed',               null, 'adt.read|adt.write|nursing.read', 230, 'topnav.clinical'],
    ['topnav.clinical.census','global', 'topnav_item', 'IPD census',            '/ipd/census',              'fa-users',             null, 'adt.read|adt.write|nursing.read', 235, 'topnav.clinical'],
    ['topnav.clinical.death_registry','global','topnav_item','Death registry', '/death-registry',          'fa-heartbeat',         '#be123c', 'adt.read|adt.write|clinical.read|clinical.write|nursing.read|nursing.write|emergency.read|maternity.read', 237, 'topnav.clinical'],
    ['topnav.clinical.ipd_rx','global', 'topnav_item', 'IPD medication',        '/ipd/medication',          'fa-medkit',            '#0f766e', 'ipd_medication.read|ipd_medication.write|adt.read|clinical.read|clinical.write|nursing.read|nursing.write', 240, 'topnav.clinical'],
    ['topnav.clinical.ipd_inbox','global','topnav_item','IPD nurse messages',   '/ipd/inbox',               'fa-envelope',          '#0369a1', 'ipd_medication.read|ipd_medication.write|clinical.write', 245, 'topnav.clinical'],
    ['topnav.clinical.nurse_roster','global','topnav_item','Nurse roster',     '/nurse-roster',            'fa-calendar-o',        null, 'nurse_duty.read|nurse_duty.write', 250, 'topnav.clinical'],
    ['topnav.clinical.doctor_roster','global','topnav_item','Doctor roster',    '/doctor-roster',           'fa-calendar-check-o',  null, 'doctor_duty.read|doctor_duty.write', 255, 'topnav.clinical'],

    ['topnav.operations',     'global', 'topnav',      'Operations',            null, 'fa-cogs',              '#0c8b8b', 'cashier.read|cashier.write|inventory.read|inventory.write|lab.read|pharmacy.read|radiology.read|procurement.read', 300, null],
    ['topnav.ops.hms_hub',    'global', 'topnav_item', 'Medical Center',          '/hms',                     'fa-hospital-o',        '#714b67', 'cashier.read|billing.read|patient.read|clinical.read|clinical.write|opd.read', 305, 'topnav.operations'],
    ['topnav.ops.cashier',  'global', 'topnav_item', 'Cashier',               '/cashier',                 'fa-money',             null, 'cashier.read|cashier.write', 310, 'topnav.operations'],
    ['topnav.ops.wallet',   'global', 'topnav_item', 'Patient wallets',       '/wallet',                  'fa-credit-card',       null, 'cashier.read|cashier.write|billing.read|accounting.read', 320, 'topnav.operations'],
    ['topnav.ops.inventory','global', 'topnav_item', 'Inventory',             '/inventory',               'fa-cubes',             null, 'inventory.read|inventory.write', 330, 'topnav.operations'],
    ['topnav.ops.procurement','global','topnav_item', 'Procurement',           '/procurement',             'fa-truck',             '#0ea5e9', 'procurement.read|procurement.write|inventory.read|inventory.write', 340, 'topnav.operations'],
    ['topnav.ops.assets',     'global', 'topnav_item', 'Asset Management',      '/assets',                  'fa-building',          '#6366f1', 'assets.read|assets.write', 345, 'topnav.operations'],
    ['topnav.ops.catalog',  'global', 'topnav_item', 'Service catalog',       '/catalog',                 'fa-list',              null, 'inventory.read|billing.read|service_catalog.consultation.read|service_catalog.laboratory.read|service_catalog.pharmacy.read|service_catalog.radiology.read|service_catalog.general.read', 350, 'topnav.operations'],
    ['topnav.ops.lab',      'global', 'topnav_item', 'Laboratory',            '/laboratory',              'fa-flask',             null, 'lab.read|lab.write', 360, 'topnav.operations'],
    ['topnav.ops.pharmacy', 'global', 'topnav_item', 'Pharmacy',              '/pharmacy',                'fa-medkit',            null, 'pharmacy.read|pharmacy.write|prescription.read', 370, 'topnav.operations'],
    ['topnav.ops.radiology','global', 'topnav_item', 'Radiology',             '/radiology',               'fa-film',              null, 'radiology.read|radiology.write', 380, 'topnav.operations'],

    ['topnav.hr',             'global', 'topnav',      'HR',                    null, 'fa-id-badge',          '#7c3aed', 'employee.read|employee.write|payroll.read|payroll.write|hr.leave.approve', 400, null],
    ['topnav.hr.employees',   'global', 'topnav_item', 'Employees',             '/employees',               'fa-id-badge',          null, 'employee.read|employee.write', 410, 'topnav.hr'],
    ['topnav.hr.payroll',     'global', 'topnav_item', 'Payroll & HR',          '/payroll',                 'fa-money',             null, 'payroll.read|payroll.write', 420, 'topnav.hr'],
    ['topnav.hr.leave_req',   'global', 'topnav_item', 'Leave approvals',       '/hr/leave-requests',       'fa-inbox',             '#be123c', 'hr.leave.approve', 430, 'topnav.hr'],
    ['topnav.hr.leave_bal',   'global', 'topnav_item', 'Leave balances',        '/hr/leave-balances',       'fa-balance-scale',       '#0e7490', 'hr.leave.approve', 440, 'topnav.hr'],

    ['topnav.configuration',  'global', 'topnav',      'Settings',                null, 'fa-sliders',           '#1a6bd8', '*', 500, null],
    ['topnav.cfg.financials', 'global', 'topnav_item', 'Financials',          '/financials',              'fa-line-chart',        null, 'accounting.read|accounting.write|billing.read|billing.write|financials.read|financials.write', 510, 'topnav.configuration'],
    ['topnav.cfg.tax',        'global', 'topnav_item', 'Tax hub',               '/tax',                     'fa-sliders',           '#1d4ed8', 'accounting.read|accounting.write', 520, 'topnav.configuration'],
    ['topnav.cfg.departments','global', 'topnav_item', 'Departments & specialisations', '/departments', 'fa-sitemap', '#0c8b8b', 'employee.read|employee.write|access_control.manage', 525, 'topnav.configuration'],
    ['topnav.cfg.consultation_rooms','global', 'topnav_item', 'Room configuration', '/admin/consultation-rooms', 'fa-door-open', '#0ea5e9', 'access_control.manage|opd.write|nursing.write|scheduling.read', 526, 'topnav.configuration'],
    ['topnav.cfg.prescription_verify','global','topnav_item','Verify Rx QR',      '/hms/prescription-verify', 'fa-qrcode', '#16a34a', 'pharmacy.read|pharmacy.write|clinical.read|prescription.read|opd.read|nursing.read|hms_reports.read', 527, 'topnav.configuration'],
    ['topnav.cfg.product_doc','global', 'topnav_item', 'Product document', '/docs/product-document', 'fa-bookmark', '#c9a227', '*', 528, 'topnav.configuration'],
    ['topnav.cfg.comprehensive_guide','global', 'topnav_item', 'Comprehensive user guide', '/docs/comprehensive-user-guide', 'fa-graduation-cap', '#0c8b8b', '*', 529, 'topnav.configuration'],
    ['topnav.cfg.commission', 'global', 'topnav_item', 'Commission rules',      '/hms/commission',          'fa-percent',           '#d97706', 'financials.read|payroll.read|financials.write|payroll.write', 530, 'topnav.configuration'],
    ['topnav.cfg.hms_config', 'global', 'topnav_item', 'Room Configuration',  '/admin/consultation-rooms', 'fa-door-open',         '#0ea5e9', 'service_catalog.write|facility.admin|clinical.write|settings.org_clinical.write|service_catalog.consultation.write|employee.write', 531, 'topnav.configuration'],
    ['topnav.cfg.access',     'global', 'topnav_item', 'Access control',        '/hms-admin/access',        'fa-lock',              null, 'access_control.manage', 534, 'topnav.configuration'],
    ['topnav.cfg.employee_add', 'global', 'topnav_item', 'Create new employee', '/employees/add', 'fa-user-plus', '#16a34a', 'employee.write', 532, 'topnav.configuration'],
    ['topnav.cfg.employee_password', 'global', 'topnav_item', 'Reset employee password', '/settings/employee-password', 'fa-key', '#64748b', 'employee.password.manage', 533, 'topnav.configuration'],
    ['topnav.cfg.users',      'global', 'topnav_item', 'System users',          '/users',                   'fa-shield',            '#312e81', '*',                         538, 'topnav.configuration'],
    ['topnav.cfg.subscriptions','global','topnav_item','Solution subscriptions','/hms-admin/subscriptions','fa-key',            '#0891b2', 'subscriptions.manage', 535, 'topnav.configuration'],
    ['topnav.cfg.super_admin','global', 'topnav_item', 'Super admin',           '/super-admin',             'fa-shield',            null, 'super_admin.product', 540, 'topnav.configuration'],
    ['topnav.cfg.guides',     'global', 'topnav_item', 'Workflow guides',       '/workflow-guides',         'fa-sitemap',           '#f59e0b', '*', 550, 'topnav.configuration'],
    ['topnav.cfg.manual',     'global', 'topnav_item', 'User manual',           '/user-manual',             'fa-book',              '#1a6bd8', '*', 560, 'topnav.configuration'],
    ['topnav.ops.mgmt_reports','global','topnav_item', 'Director reports',      '/portal/hub/director',     'fa-bar-chart',         '#5b21b6', 'hms_reports.read|hms_reports.full|hms_reports.daily|hms_reports.weekly|hms_reports.monthly|hms_reports.financial', 385, 'topnav.operations'],

    // ── Newly added topbar dropdown menu items to match sidebar buttons ──
    ['topnav.clinical.prescriptions', 'global', 'topnav_item', 'Prescriptions', '/prescriptions', 'fa-medkit', null, 'prescription.read|prescription.write|pharmacy.read|pharmacy.write|clinical.read|clinical.write|nursing.read', 248, 'topnav.clinical'],
    ['topnav.hr.attendance',          'global', 'topnav_item', 'Attendance',    '/hr/attendance',  'fa-clock-o', null, 'payroll.read|payroll.write', 445, 'topnav.hr'],
    ['topnav.hr.holidays',            'global', 'topnav_item', 'HR holidays',   '/hr/holidays',    'fa-calendar', '#b45309', 'hr.leave.approve', 446, 'topnav.hr'],
    ['topnav.ops.wallet_admin',       'global', 'topnav_item', 'Wallet Management', '/wallet-management', 'fa-credit-card', null, 'accounting.read|cashier.write', 325, 'topnav.operations'],
    ['topnav.ops.credit',             'global', 'topnav_item', 'Credit & Receivables', '/credit-receivables', 'fa-file-text-o', null, 'credit.read|credit.write|accounting.read', 326, 'topnav.operations'],
    ['topnav.ops.insurance',          'global', 'topnav_item', 'Insurance Carriers', '/insurance', 'fa-shield', null, 'insurance.read|insurance.write|accounting.read|accounting.write', 327, 'topnav.operations'],
    ['topnav.ops.insurance_claims',   'global', 'topnav_item', 'Insurance Claims', '/insurance-claims', 'fa-file-text', null, 'insurance.read|insurance.write|accounting.read|accounting.write', 328, 'topnav.operations'],
    ['topnav.cfg.payment_validity',   'global', 'topnav_item', 'Payment Validity', '/payment-validity', 'fa-clock-o', '#7c3aed', 'payment.validity.read|payment.validity.write|billing.read|billing.write', 515, 'topnav.configuration'],

    // ── Portal hero banner: Workflow Guide (synced with sb.guides via URL alias on hide) ──
    ['cashier.hero.guides',   'cashier',    'button', 'Workflow Guide (banner)', '/workflow-guides', 'fa-sitemap', '#f59e0b', '*', 2, null],
    ['doc.hero.guides',       'doctors',    'button', 'Workflow Guide (banner)', '/workflow-guides', 'fa-sitemap', '#f59e0b', '*', 2, null],
    ['doc.hero.followup',     'doctors',    'button', 'Follow-Up (banner)',      '/clinical/follow-up-opd', 'fa-calendar-check-o', '#7c3aed', 'clinical.write|prescription.write', 3, null],
    ['nur.hero.guides',       'nursing',    'button', 'Workflow Guide (banner)', '/workflow-guides', 'fa-sitemap', '#f59e0b', '*', 2, null],
    ['lab.hero.guides',       'laboratory', 'button', 'Workflow Guide (banner)', '/workflow-guides', 'fa-sitemap', '#f59e0b', '*', 2, null],
    ['acc.hero.guides',       'accountant', 'button', 'Workflow Guide (banner)', '/workflow-guides', 'fa-sitemap', '#f59e0b', '*', 2, null],

    // ── Cashier portal tiles ───────────────────────────────────────────
    ['cashier.tile.issue',    'cashier', 'tile', 'Payment',           '/cashier',     'fa-money',       '#10b981', 'cashier.read|cashier.write', 10, null],
    ['cashier.tile.hms_hub',  'cashier', 'tile', 'Medical Center',      '/hms',         'fa-hospital-o',  '#714b67', 'cashier.read|billing.read|patient.read', 15, null],
    ['cashier.tile.patients', 'cashier', 'tile', 'Patient List',      '/patients',    'fa-users',       '#0ea5e9', 'patient.read', 20, null],
    ['cashier.tile.wallets',  'cashier', 'tile', 'Patient Wallets',   '/wallet',      'fa-credit-card', '#8b5cf6', 'cashier.read|cashier.write|billing.read|billing.write|accounting.read', 30, null],
    ['cashier.tile.insurance','cashier', 'tile', 'Insurance',         '/insurance',   'fa-shield',      '#7c3aed', 'insurance.read|insurance.write|accounting.read|accounting.write', 40, null],
    ['cashier.tile.financial','cashier', 'tile', 'Financial Summary', '/financials',  'fa-line-chart',  '#1a6bd8', 'accounting.read|accounting.write|billing.write', 50, null],
    ['cashier.tile.register', 'cashier', 'tile', 'Register Patient',  '/patients',    'fa-user-plus',   '#16a34a', 'patient.write', 60, null],
    ['cashier.tile.hr_leave', 'cashier', 'tile', 'Request leave',     '/hr/request-leave','fa-paper-plane','#6d28d9', 'hr.self.read', 61, null],
    ['cashier.tile.hr_slips', 'cashier', 'tile', 'My payslips',       '/hr/my-payslips','fa-file-text-o', '#1d4ed8', 'hr.self.read', 62, null],
    ['cashier.tile.hr_attend','cashier', 'tile', 'My attendance',     '/hr/my-attendance','fa-list-alt',  '#475569', 'hr.self.read', 63, null],
    ['cashier.tile.hr_bal',   'cashier', 'tile', 'My leave balance',  '/hr/my-leave-balance','fa-leaf',    '#15803d', 'hr.self.read', 64, null],

    // ── Front Desk portal tiles ────────────────────────────────────────
    ['fd.tile.register',  'front_desk', 'tile', 'Register Patient',  '/patients',           'fa-user-plus',       '#0c8b8b', 'front_desk.patient.register|patient.write', 10, null],
    ['fd.tile.visit',     'front_desk', 'tile', 'Create New Visit',  '/opd-queue',          'fa-plus-circle',     '#1d4ed8', 'front_desk.visit.create|opd.read|scheduling.read', 15, null],
    ['fd.tile.opd',       'front_desk', 'tile', 'OPD Queue',         '/opd-queue',          'fa-list-alt',        '#1a6bd8', 'opd.read|clinical.read|clinical.write|scheduling.read', 20, null],
    ['fd.tile.appt',      'front_desk', 'tile', 'Book Appointment',  '/appointments',       'fa-calendar-plus-o', '#f59e0b', 'front_desk.appointment.book|scheduling.read|scheduling.write|opd.read', 30, null],
    ['fd.tile.payment',   'front_desk', 'tile', 'Validate Payment Code', '/payment-validity', 'fa-check-circle', '#10b981', 'front_desk.payment_code.validate|payment.validity.read', 35, null],
    ['fd.tile.directory', 'front_desk', 'tile', 'Patient Directory', '/patients',           'fa-users',           '#8b5cf6', 'patient.read|patient.write', 40, null],
    ['fd.tile.cashier',   'front_desk', 'tile', 'Go to Cashier',     '/cashier',            'fa-money',           '#10b981', 'cashier.read|cashier.write', 50, null],
    ['fd.tile.vitals',    'front_desk', 'tile', 'Record Vitals',     '/nursing/vitals',     'fa-heartbeat',       '#ec4899', 'front_desk.vitals.record|nursing.read|nursing.write', 60, null],
    ['fd.tile.triage',    'front_desk', 'tile', 'OPD Triage Queue',  '/opd-queue',          'fa-h-square',        '#ef4444', 'opd.read|clinical.read|clinical.write|scheduling.read|nursing.read', 70, null],
    ['fd.tile.wards',     'front_desk', 'tile', 'Ward Board / IPD',  '/wards',              'fa-bed',             '#0891b2', 'adt.read|adt.write|nursing.read', 80, null],
    ['fd.tile.emergency', 'front_desk', 'tile', 'Emergency / A&E',   '/emergency',          'fa-ambulance',       '#dc2626', 'emergency.read|clinical.write|adt.read', 90, null],
    ['fd.tile.ipd_medication', 'front_desk', 'tile', 'IPD Medication', '/ipd/medication', 'fa-medkit',          '#0f766e', 'ipd_medication.read|ipd_medication.write|adt.read|nursing.read|clinical.read', 91, null],
    ['fd.tile.rx',        'front_desk', 'tile', 'Prescriptions',     '/prescriptions',      'fa-medkit',          '#16a34a', 'prescription.read|prescription.write|pharmacy.read|pharmacy.write', 100, null],
    ['fd.tile.insurance', 'front_desk', 'tile', 'Insurance',         '/insurance',          'fa-shield',          '#7c3aed', 'insurance.read|insurance.write|accounting.read|accounting.write', 110, null],
    ['fd.tile.wallets',   'front_desk', 'tile', 'Patient Wallets',   '/wallet',             'fa-credit-card',     '#be123c', 'cashier.read|cashier.write|billing.read|billing.write|accounting.read', 120, null],
    ['fd.tile.hr_leave',  'front_desk', 'tile', 'Request leave',     '/hr/request-leave',   'fa-paper-plane',    '#6d28d9', 'hr.self.read', 121, null],
    ['fd.tile.hr_slips',  'front_desk', 'tile', 'My payslips',       '/hr/my-payslips',     'fa-file-text-o',    '#1d4ed8', 'hr.self.read', 122, null],
    ['fd.tile.hr_attend', 'front_desk', 'tile', 'My attendance',     '/hr/my-attendance',   'fa-list-alt',       '#475569', 'hr.self.read', 123, null],
    ['fd.tile.hr_bal',    'front_desk', 'tile', 'My leave balance',  '/hr/my-leave-balance', 'fa-leaf',           '#15803d', 'hr.self.read', 124, null],

    // ── Doctor portal tiles ────────────────────────────────────────────
    ['doc.tile.consult',  'doctors', 'tile', 'New Consultation', '/consultation-new',  'fa-stethoscope',      '#1a6bd8', 'clinical.write|prescription.write', 10, null],
    ['doc.tile.opd',      'doctors', 'tile', 'OPD Queue',        '/opd-queue',         'fa-list-alt',         '#0c8b8b', 'opd.read|clinical.read|clinical.write|scheduling.read', 20, null],
    ['doc.tile.patients', 'doctors', 'tile', 'Patient Records',  '/patients',          'fa-user',             '#0ea5e9', 'patient.read|patient.write', 30, null],
    ['doc.tile.rx',       'doctors', 'tile', 'Prescriptions',    '/prescriptions',     'fa-medkit',           '#16a34a', 'prescription.read|prescription.write', 40, null],
    ['doc.tile.lab',      'doctors', 'tile', 'Lab Orders',       '/laboratory',        'fa-flask',            '#7c3aed', 'lab.read|lab.write|clinical.read|clinical.write|nursing.read', 50, null],
    ['doc.tile.rad',      'doctors', 'tile', 'Radiology',        '/radiology',         'fa-film',             '#8b5cf6', 'radiology.read|radiology.write|clinical.read|clinical.write|nursing.read', 60, null],
    ['doc.tile.wards',    'doctors', 'tile', 'Ward Round / IPD', '/wards',             'fa-bed',              '#0891b2', 'adt.read|adt.write|nursing.read', 70, null],
    ['doc.tile.appts',    'doctors', 'tile', 'Appointments',     '/appointments',      'fa-calendar',         '#f59e0b', 'scheduling.read|scheduling.write|opd.read', 80, null],
    ['doc.tile.schedule', 'doctors', 'tile', 'My Schedule',      '/doctor/schedule',   'fa-calendar-o',       '#0ea5e9', 'doctor_duty.read|clinical.read|clinical.write|scheduling.read', 85, null],
    ['doc.tile.duty',     'doctors', 'tile', 'Duty & On-Call',   '/doctor-roster',     'fa-calendar-check-o', '#1a6bd8', 'doctor_duty.read|doctor_duty.write', 90, null],
    ['doc.tile.census',   'doctors', 'tile', 'IPD Census',       '/ipd/census',        'fa-hospital-o',       '#be123c', 'adt.read|adt.write|nursing.read', 95, null],
    ['doc.tile.ipd_medication','doctors', 'tile', 'IPD Medication', '/ipd/medication', 'fa-medkit',           '#0f766e', 'ipd_medication.read|ipd_medication.write|adt.read|clinical.read|clinical.write', 94, null],
    ['doc.tile.emergency','doctors', 'tile', 'Emergency / A&E',  '/emergency',         'fa-ambulance',        '#dc2626', 'emergency.read|clinical.write|adt.read', 96, null],
    ['doc.tile.maternity','doctors', 'tile', 'Maternity / ANC',    '/maternity',         'fa-female',           '#9d174d', 'maternity.read|maternity.write|clinical.read|clinical.write', 97, null],
    ['doc.tile.vaccination','doctors', 'tile', 'Vaccination',      '/vaccination',       'fa-plus-square',      '#059669', 'vaccination.read|vaccination.write|clinical.read|clinical.write', 98, null],
    ['doc.tile.register', 'doctors', 'tile', 'Register Patient', '/patients',          'fa-user-plus',        '#16a34a', 'patient.write', 97, null],
    ['doc.tile.hr_leave', 'doctors', 'tile', 'Request leave',    '/hr/request-leave',  'fa-paper-plane',     '#6d28d9', 'hr.self.read', 98, null],
    ['doc.tile.hr_slips', 'doctors', 'tile', 'My payslips',      '/hr/my-payslips',     'fa-file-text-o',     '#1d4ed8', 'hr.self.read', 99, null],
    ['doc.tile.hr_attend','doctors', 'tile', 'My attendance',   '/hr/my-attendance',  'fa-list-alt',        '#475569', 'hr.self.read', 100, null],
    ['doc.tile.hr_bal',   'doctors', 'tile', 'My leave balance','/hr/my-leave-balance','fa-leaf',            '#15803d', 'hr.self.read', 101, null],

    // ── Nurse portal tiles ─────────────────────────────────────────────
    ['nur.tile.opd',      'nursing', 'tile', 'OPD Triage',         '/opd-queue',           'fa-list-alt',  '#1a6bd8', 'opd.read|nursing.read|nursing.write', 10, null],
    ['nur.tile.vitals',   'nursing', 'tile', 'Record Vitals',      '/nursing/vitals',      'fa-heartbeat', '#ec4899', 'nursing.read|nursing.write', 20, null],
    ['nur.tile.wards',    'nursing', 'tile', 'Wards / IPD',        '/wards',               'fa-bed',       '#0891b2', 'adt.read|adt.write|nursing.read|nursing.write', 30, null],
    ['nur.tile.census',   'nursing', 'tile', 'IPD Census',         '/ipd/census',          'fa-users',     '#16a34a', 'adt.read|adt.write|nursing.read', 40, null],
    ['nur.tile.patients', 'nursing', 'tile', 'Patient Directory',  '/patients',            'fa-user',      '#0ea5e9', 'patient.read', 50, null],
    ['nur.tile.ipd_medication','nursing', 'tile', 'IPD Medication', '/ipd/medication', 'fa-medkit',    '#0f766e', 'ipd_medication.read|ipd_medication.write|adt.read|nursing.read|nursing.write', 58, null],
    ['nur.tile.emergency','nursing', 'tile', 'Emergency / A&E',    '/emergency',           'fa-ambulance', '#dc2626', 'emergency.read|clinical.write|adt.read|nursing.read', 60, null],
    ['nur.tile.maternity','nursing', 'tile', 'Maternity / ANC',      '/maternity',           'fa-female',    '#9d174d', 'maternity.read|maternity.write|nursing.read|nursing.write', 61, null],
    ['nur.tile.vaccination','nursing', 'tile', 'Vaccination',        '/vaccination',         'fa-plus-square','#059669', 'vaccination.read|vaccination.write|nursing.read|nursing.write', 62, null],
    ['nur.tile.roster',   'nursing', 'tile', 'Nurse Duty Roster',  '/nurse-roster',        'fa-calendar-o','#0891b2', 'nurse_duty.read|nurse_duty.write', 70, null],
    ['nur.tile.lab',      'nursing', 'tile', 'Lab Results',        '/laboratory',          'fa-flask',     '#8b5cf6', 'lab.read|lab.write', 75, null],
    ['nur.tile.rx',       'nursing', 'tile', 'Prescriptions',      '/prescriptions',       'fa-medkit',    '#10b981', 'prescription.read|prescription.write|pharmacy.read|pharmacy.write', 76, null],
    ['nur.tile.appts',    'nursing', 'tile', 'Appointments',       '/appointments',        'fa-calendar',  '#0891b2', 'scheduling.read|scheduling.write|opd.read', 77, null],
    ['nur.tile.register', 'nursing', 'tile', 'Register Patient',   '/patients?action=new', 'fa-user-plus', '#16a34a', 'patient.write', 78, null],
    ['nur.tile.rounds',   'nursing', 'tile', 'Ward Rounds',        '/ipd/ward-rounds',     'fa-stethoscope','#be123c', 'nursing.read|nursing.write|clinical.write|adt.read', 79, null],
    ['nur.tile.hr_leave', 'nursing', 'tile', 'Request leave',      '/hr/request-leave',   'fa-paper-plane', '#6d28d9', 'hr.self.read', 80, null],
    ['nur.tile.hr_slips', 'nursing', 'tile', 'My payslips',        '/hr/my-payslips',     'fa-file-text-o', '#1d4ed8', 'hr.self.read', 81, null],
    ['nur.tile.hr_attend','nursing', 'tile', 'My attendance',      '/hr/my-attendance',  'fa-list-alt',    '#475569', 'hr.self.read', 82, null],
    ['nur.tile.hr_bal',   'nursing', 'tile', 'My leave balance',   '/hr/my-leave-balance','fa-leaf',         '#15803d', 'hr.self.read', 83, null],

    // ── Lab portal tiles ───────────────────────────────────────────────
    ['lab.tile.lims',     'laboratory', 'tile', 'LIMS hub',         '/lims',           'fa-flask',         '#7c3aed', 'lab.read|lab.write', 5, null],
    ['lab.tile.queue',    'laboratory', 'tile', 'Lab registry',     '/laboratory',     'fa-list-alt',      '#16a34a', 'lab.read|lab.write', 10, null],
    ['lab.tile.validate', 'laboratory', 'tile', 'Validate Code',    '/laboratory/validate', 'fa-qrcode',   '#7c3aed', 'lab.read|lab.write', 20, null],
    ['lab.tile.templates', 'laboratory', 'tile', 'Result templates', '/lab/templates', 'fa-file-text-o', '#7c3aed', 'lab.read|lab.write', 22, null],
    ['lab.tile.patients', 'laboratory', 'tile', 'Patients',         '/patients',       'fa-user',          '#0ea5e9', 'patient.read', 30, null],
    ['lab.tile.catalog',  'laboratory', 'tile', 'Lab Catalog',      '/catalog#lab',    'fa-list',          '#475569', 'service_catalog.laboratory.read|service_catalog.laboratory.write', 40, null],
    ['lab.tile.opd',      'laboratory', 'tile', 'OPD Queue',        '/opd-queue',      'fa-list-alt',      '#1a6bd8', 'opd.read|clinical.read|clinical.write|scheduling.read', 45, null],
    ['lab.tile.hr_leave', 'laboratory', 'tile', 'Request leave',    '/hr/request-leave','fa-paper-plane',   '#6d28d9', 'hr.self.read', 46, null],
    ['lab.tile.hr_slips', 'laboratory', 'tile', 'My payslips',      '/hr/my-payslips', 'fa-file-text-o',   '#1d4ed8', 'hr.self.read', 47, null],
    ['lab.tile.hr_attend','laboratory', 'tile', 'My attendance',   '/hr/my-attendance','fa-list-alt',      '#475569', 'hr.self.read', 48, null],
    ['lab.tile.hr_bal',   'laboratory', 'tile', 'My leave balance', '/hr/my-leave-balance','fa-leaf',       '#15803d', 'hr.self.read', 49, null],

    // ── Pharmacy portal tiles ──────────────────────────────────────────
    ['pha.tile.queue',     'pharmacy', 'tile', 'Pharmacy Queue',     '/pharmacy',         'fa-medkit',  '#16a34a', 'pharmacy.read|pharmacy.write', 10, null],
    ['pha.tile.validate',  'pharmacy', 'tile', 'Validate Code',      '/pharmacy/validate', 'fa-qrcode',  '#7c3aed', 'pharmacy.read|pharmacy.write', 20, null],
    ['pha.tile.rx',        'pharmacy', 'tile', 'Prescriptions',      '/prescriptions',    'fa-medkit',  '#0ea5e9', 'prescription.read|prescription.write', 30, null],
    ['pha.tile.inventory', 'pharmacy', 'tile', 'Inventory',          '/inventory',        'fa-cubes',   '#1a6bd8', 'inventory.read|inventory.write', 40, null],
    ['pha.tile.catalog',   'pharmacy', 'tile', 'Pharmacy Catalog',   '/catalog#pharmacy', 'fa-list',    '#475569', 'service_catalog.pharmacy.read|service_catalog.pharmacy.write', 50, null],
    ['pha.tile.patients',  'pharmacy', 'tile', 'Patient List',      '/patients',          'fa-users',   '#f59e0b', 'patient.read|patient.write', 55, null],
    ['pha.tile.hr_leave',  'pharmacy', 'tile', 'Request leave',     '/hr/request-leave',  'fa-paper-plane','#6d28d9', 'hr.self.read', 56, null],
    ['pha.tile.hr_slips',  'pharmacy', 'tile', 'My payslips',       '/hr/my-payslips',     'fa-file-text-o','#1d4ed8', 'hr.self.read', 57, null],
    ['pha.tile.hr_attend', 'pharmacy', 'tile', 'My attendance',     '/hr/my-attendance',  'fa-list-alt',   '#475569', 'hr.self.read', 58, null],
    ['pha.tile.hr_bal',    'pharmacy', 'tile', 'My leave balance',  '/hr/my-leave-balance','fa-leaf',       '#15803d', 'hr.self.read', 59, null],

    // ── Radiology portal tiles ─────────────────────────────────────────
    ['rad.tile.queue',    'radiology', 'tile', 'Radiology Worklist','/radiology',          'fa-film',     '#8b5cf6', 'radiology.read|radiology.write', 10, null],
    ['rad.tile.validate', 'radiology', 'tile', 'Validate Code',     '/radiology/validate', 'fa-qrcode',   '#7c3aed', 'radiology.read|radiology.write', 20, null],
    ['rad.tile.templates', 'radiology', 'tile', 'Exam templates',   '/radiology/templates', 'fa-list-alt', '#0ea5e9', 'radiology.read|radiology.write', 22, null],
    ['rad.tile.add_exam', 'radiology', 'tile', 'Add Exam',          '/radiology/workflow', 'fa-plus-circle', '#10b981', 'radiology.write', 25, null],
    ['rad.tile.patients', 'radiology', 'tile', 'Patients',          '/patients',           'fa-user',     '#0ea5e9', 'patient.read', 30, null],
    ['rad.tile.opd',      'radiology', 'tile', 'OPD Visits',        '/opd-queue',          'fa-h-square', '#64748b', 'opd.read|clinical.read|clinical.write|scheduling.read', 35, null],
    ['rad.tile.catalog',  'radiology', 'tile', 'Radiology Catalog', '/catalog#radiology',  'fa-list',     '#475569', 'service_catalog.radiology.read|service_catalog.radiology.write', 40, null],
    ['rad.tile.hr_leave', 'radiology', 'tile', 'Request leave',     '/hr/request-leave',   'fa-paper-plane','#6d28d9', 'hr.self.read', 41, null],
    ['rad.tile.hr_slips', 'radiology', 'tile', 'My payslips',       '/hr/my-payslips',      'fa-file-text-o','#1d4ed8', 'hr.self.read', 42, null],
    ['rad.tile.hr_attend','radiology', 'tile', 'My attendance',     '/hr/my-attendance',   'fa-list-alt',   '#475569', 'hr.self.read', 43, null],
    ['rad.tile.hr_bal',   'radiology', 'tile', 'My leave balance',  '/hr/my-leave-balance','fa-leaf',       '#15803d', 'hr.self.read', 44, null],

    // ── Accounting module top bar (Cashier / Financials / Billing shell) ─
    ['fin.nav.shell_brand',   'accountant', 'fin_topnav',      'Accounting',          '/financials',                      'fa-calculator', null, '*', 50, null],
    ['fin.nav.dashboard',     'accountant', 'fin_topnav',      'Dashboard',           '/financials',                      'fa-dashboard', null, 'accounting.read|accounting.write|financials.read|financials.write|cashier.read|cashier.write|billing.read|billing.write', 100, null],
    ['fin.nav.customers',     'accountant', 'fin_topnav',      'Customers',           null,                               'fa-users',     null, 'billing.read|billing.write|accounting.read|accounting.write|cashier.read|cashier.write', 200, null],
    ['fin.nav.customers.billing','accountant','fin_topnav_item','Billing workspace',   '/billing',                         'fa-credit-card', null, 'billing.read|billing.write|accounting.read|accounting.write', 210, 'fin.nav.customers'],
    ['fin.nav.customers.cashier','accountant','fin_topnav_item','Receive payment',     '/cashier',                         'fa-money',     null, 'cashier.read|cashier.write', 220, 'fin.nav.customers'],
    ['fin.nav.customers.ar',  'accountant', 'fin_topnav_item', 'Receivables',         '/financials/accounts-receivable',    'fa-file-text-o', null, 'accounting.read|accounting.write', 230, 'fin.nav.customers'],
    ['fin.nav.transactions',  'accountant', 'fin_topnav',      'Transactions',        null,                               'fa-exchange',  null, 'accounting.read|accounting.write', 300, null],
    ['fin.nav.transactions.journal','accountant','fin_topnav_item','Journal',         '/financials/journal',              'fa-book',      null, 'accounting.read|accounting.write', 310, 'fin.nav.transactions'],
    ['fin.nav.transactions.expenses','accountant','fin_topnav_item','Expenses',       '/financials/expenses',             'fa-money',     null, 'accounting.read|accounting.write|expenses.read|expenses.write', 320, 'fin.nav.transactions'],
    ['fin.nav.transactions.treasury','accountant','fin_topnav_item','Banking',        '/financials/treasury',             'fa-bank',      null, 'accounting.read|accounting.write', 330, 'fin.nav.transactions'],
    ['fin.nav.transactions.reconcile','accountant','fin_topnav_item','Reconcile',    '/financials/bank-reconciliation',    'fa-check-square-o', null, 'accounting.read|accounting.write', 340, 'fin.nav.transactions'],
    ['fin.nav.books',         'accountant', 'fin_topnav',      'Accounting',        null,                               'fa-book',      null, 'accounting.read|accounting.write|financials.read|financials.write', 400, null],
    ['fin.nav.books.coa',     'accountant', 'fin_topnav_item', 'Chart of accounts', '/financials/accounts',             'fa-sitemap',   null, 'accounting.read|accounting.write|financials.read|financials.write', 410, 'fin.nav.books'],
    ['fin.nav.books.gl',      'accountant', 'fin_topnav_item', 'General ledger',    '/financials/general-ledger',       'fa-list-alt',  null, 'accounting.read|accounting.write|financials.read|financials.write', 420, 'fin.nav.books'],
    ['fin.nav.books.tb',      'accountant', 'fin_topnav_item', 'Trial balance',     '/financials/trial-balance',          'fa-balance-scale', null, 'accounting.read|accounting.write|financials.read|financials.write', 430, 'fin.nav.books'],
    ['fin.nav.reporting',     'accountant', 'fin_topnav',      'Reporting',         null,                               'fa-bar-chart', null, 'accounting.read|accounting.write|financials.read|financials.write', 500, null],
    ['fin.nav.reporting.bs',  'accountant', 'fin_topnav_item', 'Balance sheet',     '/financials/balance-sheet',          'fa-file-text', null, 'accounting.read|accounting.write|financials.read|financials.write', 510, 'fin.nav.reporting'],
    ['fin.nav.reporting.cf',  'accountant', 'fin_topnav_item', 'Cash flow',         '/financials/cash-flow',              'fa-exchange',  null, 'accounting.read|accounting.write|financials.read|financials.write', 520, 'fin.nav.reporting'],
    ['fin.nav.reporting.ap',  'accountant', 'fin_topnav_item', 'Payables',          '/financials/accounts-payable',       'fa-credit-card', null, 'accounting.read|accounting.write|financials.read|financials.write', 530, 'fin.nav.reporting'],
    ['fin.nav.reporting.monthly','accountant','fin_topnav_item','Monthly statement','/financials/statement-monthly',       'fa-calendar',  null, 'accounting.read|accounting.write|financials.read|financials.write', 540, 'fin.nav.reporting'],
    ['fin.nav.reporting.yearend','accountant','fin_topnav_item','Year-end',         '/financials/year-end',               'fa-calendar-check-o', null, 'accounting.read|accounting.write|financials.read|financials.write', 550, 'fin.nav.reporting'],
    ['fin.nav.reporting.tax', 'accountant', 'fin_topnav_item', 'Tax worksheets',    '/financials/settings?section=taxes', 'fa-percent',   null, 'accounting.read|accounting.write|financials.read|financials.write', 560, 'fin.nav.reporting'],
    ['fin.nav.configuration', 'accountant', 'fin_topnav',      'Settings',          null,                               'fa-sliders',   null, 'accounting.read|accounting.write|financials.read|financials.write|access_control.manage', 600, null],
    ['fin.nav.configuration.settings','accountant','fin_topnav_item','Accounting settings', '/financials/settings',     'fa-cog',       null, 'accounting.read|accounting.write|financials.read|financials.write', 605, 'fin.nav.configuration'],
    ['fin.nav.configuration.sync','accountant','fin_topnav_item','Sync to GL',      '/financials/sync-gl',               'fa-refresh',   null, 'accounting.read|accounting.write|financials.read|financials.write', 610, 'fin.nav.configuration'],
    ['fin.nav.configuration.loader','accountant','fin_topnav_item','Journal loader','/financials/journal-loader',         'fa-upload',    null, 'accounting.read|accounting.write|financials.read|financials.write', 620, 'fin.nav.configuration'],
    ['fin.nav.configuration.diag','accountant','fin_topnav_item','Diagnostics',   '/financials/journal-diagnostics',    'fa-stethoscope', null, 'accounting.read|accounting.write|financials.read|financials.write', 630, 'fin.nav.configuration'],
    ['fin.nav.configuration.help','accountant','fin_topnav_item','Help & setup',    '/financials/platform-overview',      'fa-question-circle', null, 'accounting.read|accounting.write|financials.read|financials.write', 640, 'fin.nav.configuration'],
    ['fin.nav.configuration.tax_hub','accountant','fin_topnav_item','Tax & compliance','/tax',                           'fa-sliders',   null, 'accounting.read|accounting.write', 650, 'fin.nav.configuration'],
    ['fin.nav.payroll',       'accountant', 'fin_topnav',      'Payroll',           '/payroll',                         'fa-money',     null, 'payroll.read|payroll.write', 700, null],

    // ── Accountant portal tiles ────────────────────────────────────────
    ['acc.tile.billing_ws','accountant', 'tile', 'Billing workspace', '/billing',                  'fa-credit-card', '#1e3a8a', 'accounting.read|accounting.write|billing.read|billing.write', 5, null],
    ['acc.tile.txns',      'accountant', 'tile', 'Transactions',      '/billing/transactions',     'fa-exchange',   '#0f766e', 'accounting.read|accounting.write|billing.read|billing.write', 6, null],
    ['acc.tile.receipts',  'accountant', 'tile', 'Receipts & Invoices','/billing/receipts',      'fa-file-text-o','#8b5cf6', 'accounting.read|accounting.write|billing.read|billing.write', 7, null],
    ['acc.tile.cashier',   'accountant', 'tile', 'Cashier Portal',    '/cashier',                  'fa-money',      '#0c8b8b', 'cashier.read|cashier.write', 8, null],
    ['acc.tile.financials','accountant', 'tile', 'Financials',         '/financials',          'fa-line-chart',  '#1a6bd8', 'accounting.read|accounting.write|financials.read|financials.write', 10, null],
    ['acc.tile.tb',        'accountant', 'tile', 'Trial Balance',      '/financials/trial-balance','fa-balance-scale','#475569', 'accounting.read|accounting.write', 20, null],
    ['acc.tile.bs',        'accountant', 'tile', 'Balance Sheet',      '/financials/balance-sheet', 'fa-file-text','#16a34a', 'accounting.read|accounting.write', 30, null],
    ['acc.tile.tax',       'accountant', 'tile', 'Tax',                '/financials/settings?section=taxes', 'fa-percent',  '#dc2626', 'accounting.read|accounting.write', 40, null],
    ['acc.tile.tax_hub',   'accountant', 'tile', 'Tax & compliance hub', '/tax',                  'fa-sliders',   '#1d4ed8', 'accounting.read|accounting.write', 42, null],
    ['acc.tile.cashflow',  'accountant', 'tile', 'Cash Flow',          '/financials/cash-flow',     'fa-exchange', '#0c8b8b', 'accounting.read|accounting.write', 50, null],
    ['acc.tile.expenses',  'accountant', 'tile', 'Expenses',           '/financials/expenses',      'fa-money',    '#be185d', 'expenses.read|expenses.write|accounting.read', 60, null],
    ['acc.tile.credit',    'accountant', 'tile', 'Credit & AR',        '/credit-receivables',       'fa-file-text-o','#be123c', 'credit.read|credit.write|accounting.read', 70, null],
    ['acc.tile.insurance', 'accountant', 'tile', 'Insurance',          '/insurance',                'fa-shield',   '#7c3aed', 'insurance.read|insurance.write|accounting.read|accounting.write', 80, null],
    ['acc.tile.wallets',   'accountant', 'tile', 'Patient Wallets',    '/wallet-management',        'fa-credit-card','#8b5cf6', 'accounting.read|cashier.write', 90, null],
    ['acc.tile.payroll',   'accountant', 'tile', 'Payroll',            '/payroll',                  'fa-money',    '#475569', 'payroll.read|payroll.write', 100, null],

    // ── Assistant Director portal tiles ────────────────────────────────
    ['adir.tile.dashboard', 'assistant_director', 'tile', 'Operations dashboard', '/portal/hub/assistant_director', 'fa-dashboard', '#4338ca', 'assistant_director.dashboard.read', 10, null],
    ['adir.tile.reports',   'assistant_director', 'tile', 'Director reports', '/portal/hub/director', 'fa-bar-chart', '#1e40af', 'hms_reports.read|analytics.read', 20, null],
    ['adir.tile.patients',  'assistant_director', 'tile', 'Patient directory', '/patients', 'fa-users', '#0ea5e9', 'patient.read|patient.write', 30, null],
    ['adir.tile.opd',       'assistant_director', 'tile', 'OPD queue', '/opd-queue', 'fa-list-alt', '#0c8b8b', 'opd.read|clinical.read', 40, null],
    ['adir.tile.wards',     'assistant_director', 'tile', 'Ward board', '/wards', 'fa-bed', '#0891b2', 'adt.read|nursing.read', 50, null],
    ['adir.tile.financials','assistant_director', 'tile', 'Financials', '/financials', 'fa-line-chart', '#1a6bd8', 'financials.read|billing.read', 60, null],
    ['adir.tile.employees', 'assistant_director', 'tile', 'Staff directory', '/employees', 'fa-id-badge', '#7c3aed', 'employee.read', 70, null],

    // ── Secretary portal tiles (Hospital Director executive support) ───
    ['sec.tile.dashboard',  'secretary', 'tile', 'Secretary dashboard', '/portal/hub/secretary', 'fa-dashboard', '#5b21b6', 'secretary.dashboard.read', 10, null],
    ['sec.tile.calendar',   'secretary', 'tile', 'Director calendar', '/appointments', 'fa-calendar', '#4338ca', 'secretary.calendar.manage|scheduling.read|scheduling.write', 20, null],
    ['sec.tile.reports',    'secretary', 'tile', 'Director reports', '/portal/hub/director', 'fa-bar-chart', '#1e40af', 'secretary.reports.read|hms_reports.read', 30, null],
    ['sec.tile.director',   'secretary', 'tile', 'Director portal', '/portal/hub/director', 'fa-briefcase', '#714b67', 'hms_reports.read|analytics.read', 40, null],
    ['sec.tile.patients',   'secretary', 'tile', 'Patient lookup', '/patients', 'fa-search', '#0ea5e9', 'patient.read', 50, null],
    ['sec.tile.staff',      'secretary', 'tile', 'Staff directory', '/employees', 'fa-id-badge', '#475569', 'employee.read', 60, null],
    ['sec.tile.opd',        'secretary', 'tile', 'OPD queue briefing', '/opd-queue', 'fa-list-alt', '#0891b2', 'opd.read|secretary.director.briefing.read', 70, null],

    // ── Director portal — live cashier revenue dashboard ──
    ...require('./directorDashboardCatalog').aclUiElements(),
    ...require('./directorWeeklyReportCatalog').aclUiElements(),
    ...require('./directorMonthlyPLCatalog').aclUiElements(),
    ...require('./directorAnnualScorecardCatalog').aclUiElements(),
    ...require('./assistantDirectorDashboardCatalog').aclUiElements(),
    ...require('./frontDeskDashboardCatalog').aclUiElements(),
    ...require('./secretaryDashboardCatalog').aclUiElements(),
  ];

  for (const e of elements) {
    const [code, portal, kind, label, url, icon, color, perm, sort, parent] = e;
    await pool.query(
      `INSERT INTO tbl_acl_ui_element
         (code, portal_code, kind, parent_code, label, url, icon, color, sort_order, required_perm, enabled)
       VALUES (?,?,?,?,?,?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE
         portal_code=VALUES(portal_code), kind=VALUES(kind),
         parent_code=VALUES(parent_code), label=VALUES(label),
         url=VALUES(url), icon=VALUES(icon), color=VALUES(color),
         sort_order=VALUES(sort_order), required_perm=VALUES(required_perm)`,
      [code, portal, kind, parent, label, url, icon, color, sort, perm]
    );
  }

  /** Sync Settings → employee tools nav grants for any role that holds the matching permission. */
  try {
    const settingsEmployeeNav = [
      { perm: 'employee.write', nav: 'nav.cfg.employee_add' },
      { perm: 'employee.password.manage', nav: 'nav.cfg.employee_password' },
    ];
    for (const { perm, nav } of settingsEmployeeNav) {
      const [roles] = await pool.query(
        `SELECT DISTINCT CAST(rp.role AS CHAR) AS role
           FROM tbl_acl_role_permission rp
           INNER JOIN tbl_acl_permission p ON p.id = rp.permission_id
          WHERE p.code = ?`,
        [perm]
      );
      for (const row of roles || []) {
        if (!row || row.role == null) continue;
        await pool.query(
          `INSERT INTO tbl_acl_role_nav_grant (role, nav_code, granted) VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE granted = 1`,
          [String(row.role), nav]
        ).catch(() => {});
      }
    }
  } catch (_) { /* optional */ }

  await pool.query(
    `UPDATE tbl_acl_ui_element SET enabled = 0 WHERE code IN ('fd.tile.lobby', 'nur.tile.lobby')`
  ).catch(() => {});
  await pool.query(
    `UPDATE tbl_acl_ui_element SET enabled = 0
      WHERE code IN ('hub.card.prescription_verify', 'hub.card.commission', 'hub.card.config')`
  ).catch(() => {});

  const { TAB_DEFS, KPI_DEFS, PANEL_DEFS } = require('./directorDashboardCatalog');
  for (const tab of TAB_DEFS) {
    await pool.query('UPDATE tbl_acl_ui_element SET label = ?, enabled = 1 WHERE code = ?', [tab.label, tab.code]).catch(() => {});
  }
  for (const kpi of KPI_DEFS) {
    await pool.query('UPDATE tbl_acl_ui_element SET label = ?, icon = ?, color = ?, enabled = 1 WHERE code = ?', [
      kpi.label, kpi.icon, kpi.color, kpi.code,
    ]).catch(() => {});
  }
  for (const panel of PANEL_DEFS) {
    await pool.query('UPDATE tbl_acl_ui_element SET label = ?, enabled = 1 WHERE code = ?', [panel.label, panel.code]).catch(() => {});
  }
  await pool.query(
    `UPDATE tbl_acl_ui_element SET label = 'Director daily dashboard', enabled = 1 WHERE code = 'dir.section.daily_dashboard'`
  ).catch(() => {});

  const { KPI_DEFS: WK_KPI_DEFS, PANEL_DEFS: WK_PANEL_DEFS } = require('./directorWeeklyReportCatalog');
  for (const kpi of WK_KPI_DEFS) {
    await pool.query('UPDATE tbl_acl_ui_element SET label = ?, icon = ?, color = ?, enabled = 1 WHERE code = ?', [
      kpi.label, kpi.icon, kpi.color, kpi.code,
    ]).catch(() => {});
  }
  for (const panel of WK_PANEL_DEFS) {
    await pool.query('UPDATE tbl_acl_ui_element SET label = ?, enabled = 1 WHERE code = ?', [panel.label, panel.code]).catch(() => {});
  }
  await pool.query(
    `UPDATE tbl_acl_ui_element SET label = 'Weekly performance report', enabled = 1 WHERE code = 'dir.section.weekly_report'`
  ).catch(() => {});

  const { KPI_DEFS: MO_KPI_DEFS, PANEL_DEFS: MO_PANEL_DEFS } = require('./directorMonthlyPLCatalog');
  for (const kpi of MO_KPI_DEFS) {
    await pool.query('UPDATE tbl_acl_ui_element SET label = ?, color = ?, enabled = 1 WHERE code = ?', [
      kpi.label, kpi.color, kpi.code,
    ]).catch(() => {});
  }
  for (const panel of MO_PANEL_DEFS) {
    await pool.query('UPDATE tbl_acl_ui_element SET label = ?, enabled = 1 WHERE code = ?', [panel.label, panel.code]).catch(() => {});
  }
  await pool.query(
    `UPDATE tbl_acl_ui_element SET label = 'Monthly P&L report', enabled = 1 WHERE code = 'dir.section.monthly_pl'`
  ).catch(() => {});

  const { PANEL_DEFS: YR_PANEL_DEFS, DOMAIN_DEFS: YR_DOMAIN_DEFS } = require('./directorAnnualScorecardCatalog');
  for (const panel of YR_PANEL_DEFS) {
    await pool.query('UPDATE tbl_acl_ui_element SET label = ?, enabled = 1 WHERE code = ?', [panel.label, panel.code]).catch(() => {});
  }
  for (const domain of YR_DOMAIN_DEFS) {
    await pool.query('UPDATE tbl_acl_ui_element SET label = ?, color = ?, enabled = 1 WHERE code = ?', [
      domain.label, domain.color, domain.code,
    ]).catch(() => {});
  }
  await pool.query(
    `UPDATE tbl_acl_ui_element SET label = 'Annual performance scorecard', enabled = 1 WHERE code = 'dir.section.annual_scorecard'`
  ).catch(() => {});

  await pool.query(
    `UPDATE tbl_acl_ui_element SET label = 'Settings' WHERE code IN ('topnav.configuration', 'fin.nav.configuration')`
  ).catch(() => {});
  await pool.query(
    `UPDATE tbl_acl_ui_element SET required_perm = '*'
      WHERE code = 'topnav.configuration'`
  ).catch(() => {});
  await pool.query(
    `UPDATE tbl_acl_ui_element SET required_perm = 'accounting.read|accounting.write|billing.read|billing.write|financials.read|financials.write'
      WHERE code = 'topnav.cfg.financials'`
  ).catch(() => {});
  await pool.query(
    `UPDATE tbl_acl_ui_element SET required_perm = 'payment.validity.read|payment.validity.write|billing.read|billing.write'
      WHERE code = 'topnav.cfg.payment_validity'`
  ).catch(() => {});
  await pool.query(
    `UPDATE tbl_acl_ui_element SET required_perm = 'pharmacy.read|pharmacy.write|clinical.read|prescription.read|opd.read|nursing.read|hms_reports.read'
      WHERE code = 'topnav.cfg.prescription_verify'`
  ).catch(() => {});
  await pool.query(
    `UPDATE tbl_acl_ui_element SET required_perm = 'service_catalog.write|facility.admin|clinical.write|settings.org_clinical.write|service_catalog.consultation.write|employee.write'
      WHERE code = 'topnav.cfg.hms_config'`
  ).catch(() => {});
  await pool.query(
    `UPDATE tbl_acl_ui_element SET
       label = 'Room Configuration',
       url = '/admin/consultation-rooms',
       icon = 'fa-door-open',
       color = '#0ea5e9'
     WHERE code = 'topnav.cfg.hms_config'`
  ).catch(() => {});
  await pool.query(
    `UPDATE tbl_acl_ui_element SET enabled = 0 WHERE code = 'topnav.cfg.consultation_rooms'`
  ).catch(() => {});
  const hubStatIcons = [
    ['hub.stat.opd_open', 'fa-list-alt', '#00a09d'],
    ['hub.stat.in_consult', 'fa-stethoscope', '#16a34a'],
    ['hub.stat.appointments_today', 'fa-calendar', '#875a7b'],
    ['hub.stat.ipd_active', 'fa-hospital-o', '#1e40af'],
    ['hub.stat.lab_open', 'fa-flask', '#7c3aed'],
    ['hub.stat.rad_open', 'fa-film', '#0369a1'],
    ['hub.stat.pending_orders', 'fa-clock-o', '#d97706'],
    ['hub.stat.revenue_today', 'fa-money', '#334155'],
    ['hub.stat.patients_total', 'fa-users', '#017e84'],
    ['hub.stat.doctors_active', 'fa-user-md', '#1a6bd8'],
  ];
  for (const [code, icon, color] of hubStatIcons) {
    await pool.query(
      'UPDATE tbl_acl_ui_element SET icon=?, color=? WHERE code=?',
      [icon, color, code]
    ).catch(() => {});
  }
  await pool.query(
    `UPDATE tbl_acl_ui_element SET label = 'Accounting settings' WHERE code = 'fin.nav.configuration.settings'`
  ).catch(() => {});

  /** Doctor roles: hide mis-cloned doctor-portal executive tiles by default. */
  const doctorHubHide = [
    'doctor.tile.dashboard',
    'doctor.tile.employees',
    'doctor.tile.payroll',
    'doctor.tile.financials',
  ];
  const doctorRoles = new Set(['2']);
  try {
    const [docRoles] = await pool.query(
      `SELECT DISTINCT CAST(role AS CHAR) AS role FROM tbl_role
        WHERE LOWER(title) LIKE '%doctor%' OR LOWER(title) LIKE '%physician%'`
    );
    for (const r of docRoles || []) {
      if (r.role != null) doctorRoles.add(String(r.role));
    }
    const [portalRoles] = await pool.query(
      `SELECT DISTINCT CAST(role AS CHAR) AS role FROM tbl_acl_role_portal
        WHERE portal_code IN ('doctor', 'doctors')`
    );
    for (const r of portalRoles || []) {
      if (r.role != null) doctorRoles.add(String(r.role));
    }
  } catch (_) { /* optional */ }
  for (const role of doctorRoles) {
    for (const code of doctorHubHide) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_ui_hidden (role, element_code) VALUES (?, ?)`,
        [role, code]
      ).catch(() => {});
    }
  }

  /** Department portals: hide hospital-wide hub widgets except module-relevant tiles (Navigation Studio can override). */
  const ALL_HUB_CODES = [
    'hub.stat.opd_open', 'hub.stat.in_consult', 'hub.stat.appointments_today', 'hub.stat.ipd_active',
    'hub.stat.lab_open', 'hub.stat.rad_open', 'hub.stat.pending_orders', 'hub.stat.revenue_today',
    'hub.stat.patients_total', 'hub.stat.doctors_active',
    'hub.card.patients', 'hub.card.appointments', 'hub.card.opd_queue', 'hub.card.hospitalization',
    'hub.card.laboratory', 'hub.card.radiology', 'hub.card.pharmacy', 'hub.card.cashier',
    'hub.card.waiting_screen', 'hub.card.appointment_slots', 'hub.card.reports',
    'hub.panel.opd_today',
  ];
  const DEPT_HUB_ALLOW = {
    '4': ['hub.stat.lab_open', 'hub.card.laboratory', 'hub.card.patients'],
    '5': ['hub.card.pharmacy', 'hub.card.patients'],
    '6': ['hub.stat.rad_open', 'hub.card.radiology', 'hub.card.patients'],
    '11': ['hub.stat.pending_orders', 'hub.stat.revenue_today', 'hub.card.cashier', 'hub.card.patients'],
    '105': ['hub.card.pharmacy', 'hub.card.patients'],
  };
  for (const [role, allowList] of Object.entries(DEPT_HUB_ALLOW)) {
    const allow = new Set(allowList);
    for (const code of ALL_HUB_CODES) {
      if (allow.has(code)) continue;
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_ui_hidden (role, element_code) VALUES (?, ?)`,
        [role, code]
      ).catch(() => {});
    }
  }

  // ── 9b. Row action menus (portal_code = action_menus, kind = action_menu) ─
  // parent_code groups screens for Access Control UI. required_perm is OR-list like tiles.
  const actionMenuElements = [
    ['am.patients.chart', 'action_menus', 'action_menu', 'View Chart', null, 'fa-folder-open-o', '#2563eb', 'patient.directory.chart|chart.read|patient.read|clinical.read|clinical.write|nursing.read|lab.read|radiology.read|pharmacy.read', 10, 'patients'],
    ['am.patients.insurance', 'action_menus', 'action_menu', 'Manage Insurance', null, 'fa-shield', '#7c3aed', 'patient.directory.insurance|insurance.read|insurance.write', 20, 'patients'],
    ['am.patients.credit', 'action_menus', 'action_menu', 'Open Credit', null, 'fa-credit-card', '#16a34a', 'patient.directory.credit|credit.read|credit.write|billing.read|billing.write|cashier.write', 30, 'patients'],
    ['am.patients.portal', 'action_menus', 'action_menu', 'Patient portal', null, 'fa-globe', '#0ea5e9', 'patient.directory.portal|patient_portal.manage|patient.write', 40, 'patients'],
    ['am.patients.edit', 'action_menus', 'action_menu', 'Edit Profile', null, 'fa-pencil', '#1a6bd8', 'patient.directory.edit|patient.write', 50, 'patients'],
    ['am.patients.delete', 'action_menus', 'action_menu', 'Delete', null, 'fa-trash', '#dc2626', '*', 60, 'patients'],
    ['am.opd_queue.chart', 'action_menus', 'action_menu', 'Open Chart', null, 'fa-folder-open', '#2563eb', 'chart.read|patient.read|clinical.read|opd.read', 10, 'opd_queue'],
    ['am.opd_queue.triage', 'action_menus', 'action_menu', 'Start Triage', null, 'fa-heartbeat', '#f59e0b', 'nursing.write|opd.write|clinical.write', 20, 'opd_queue'],
    ['am.opd_queue.consultation', 'action_menus', 'action_menu', 'New / follow-up consultation', null, 'fa-stethoscope', '#16a34a', 'clinical.write|opd.write', 30, 'opd_queue'],
    ['am.opd_queue.complete', 'action_menus', 'action_menu', 'Mark Completed', null, 'fa-check', '#16a34a', 'opd.write|clinical.write', 40, 'opd_queue'],
    ['am.opd_queue.cancel', 'action_menus', 'action_menu', 'Cancel Visit', null, 'fa-times', '#dc2626', 'opd.write', 50, 'opd_queue'],
    ['am.opd_queue.carry_forward', 'action_menus', 'action_menu', 'Return to today\'s queue', null, 'fa-repeat', '#0369a1', 'opd.write|clinical.write|nursing.write', 35, 'opd_queue'],
    ['am.opd_queue.assign_room', 'action_menus', 'action_menu', 'Assign consultation room', null, 'fa-door-open', '#0ea5e9', 'opd.write|nursing.write|clinical.write|scheduling.read', 36, 'opd_queue'],
    ['am.lab.view_test', 'action_menus', 'action_menu', 'View Test', null, 'fa-file-text-o', '#2563eb', 'lab.read', 10, 'laboratory'],
    ['am.lab.return_correction', 'action_menus', 'action_menu', 'Return for correction', null, 'fa-undo', '#dc2626', 'lab.write', 20, 'laboratory'],
    ['am.lab.update_status', 'action_menus', 'action_menu', 'Update Status', null, 'fa-pencil', '#64748b', 'lab.write', 30, 'laboratory'],
    ['am.rad.view_scans', 'action_menus', 'action_menu', 'View Scans', null, 'fa-image', '#0ea5e9', 'radiology.read', 10, 'radiology'],
    ['am.rad.update_result', 'action_menus', 'action_menu', 'Update Result', null, 'fa-pencil', '#64748b', 'radiology.write', 20, 'radiology'],
    ['am.employees.add', 'action_menus', 'action_menu', 'Add Employee', null, 'fa-user-plus', '#16a34a', 'employee.write', 5, 'employees'],
    ['am.employees.edit', 'action_menus', 'action_menu', 'Edit', null, 'fa-pencil', '#1a6bd8', 'employee.read|employee.write', 10, 'employees'],
    ['am.employees.delete', 'action_menus', 'action_menu', 'Delete', null, 'fa-trash-o', '#dc2626', 'employee.delete|employee.write', 20, 'employees'],
    ['am.prescriptions.view', 'action_menus', 'action_menu', 'View Details', null, 'fa-eye', '#2563eb', 'prescription.read|pharmacy.read|clinical.read', 10, 'prescriptions'],
    ['am.prescriptions.print', 'action_menus', 'action_menu', 'Print Rx', null, 'fa-print', '#64748b', 'prescription.read|pharmacy.read', 20, 'prescriptions'],
    ['am.prescriptions.chart', 'action_menus', 'action_menu', 'Patient Chart', null, 'fa-folder-open-o', '#16a34a', 'chart.read|patient.read|clinical.read', 30, 'prescriptions'],
    ['am.staff.edit_profile', 'action_menus', 'action_menu', 'Edit Profile', null, 'fa-pencil', '#1a6bd8', 'employee.write', 10, 'staff'],
    ['am.staff.reset_password', 'action_menus', 'action_menu', 'Reset Password', null, 'fa-key', '#64748b', 'employee.password.manage|employee.write', 20, 'staff'],
    ['am.staff.disable', 'action_menus', 'action_menu', 'Disable', null, 'fa-trash', '#dc2626', 'employee.write', 30, 'staff'],
    ['am.inventory.movements', 'action_menus', 'action_menu', 'View Movements', null, 'fa-history', '#2563eb', 'inventory.read', 10, 'inventory'],
    ['am.inventory.adjust', 'action_menus', 'action_menu', 'Adjust Stock', null, 'fa-pencil', '#64748b', 'inventory.write', 20, 'inventory'],
    ['am.appointments.edit', 'action_menus', 'action_menu', 'Edit', null, 'fa-pencil', '#1a6bd8', 'scheduling.write|opd.write', 10, 'appointments'],
    ['am.appointments.cancel', 'action_menus', 'action_menu', 'Cancel', null, 'fa-trash-o', '#dc2626', 'scheduling.write|opd.write', 20, 'appointments'],
  ];
  for (const e of actionMenuElements) {
    const [code, portal, kind, label, url, icon, color, perm, sort, parent] = e;
    await pool.query(
      `INSERT INTO tbl_acl_ui_element
         (code, portal_code, kind, parent_code, label, url, icon, color, sort_order, required_perm, enabled)
       VALUES (?,?,?,?,?,?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE
         portal_code=VALUES(portal_code), kind=VALUES(kind),
         parent_code=VALUES(parent_code), label=VALUES(label),
         url=VALUES(url), icon=VALUES(icon), color=VALUES(color),
         sort_order=VALUES(sort_order), required_perm=VALUES(required_perm)`,
      [code, portal, kind, parent, label, url, icon, color, sort, perm]
    );
  }

  // ── 10. Seed default role ↔ permission grants (first boot only) ─────────
  // One-time bootstrap when tbl_acl_role_permission is still empty. After that,
  // all grants are managed in Access Control — we must NOT re-run INSERT IGNORE
  // on every process start or revokes would come back after a server restart.
  const defaultRolePerms = {
    '2':  ['dashboard.read',
           'patient.read','patient.write','patient.delete','patient_portal.manage','chart.read','chart.write','profile.self.write','hr.self.read',
           'clinical.read','clinical.write',
           'scheduling.read','scheduling.write','lab.read','radiology.read',
           'prescription.read','prescription.write','adt.read','opd.read',
           'emergency.read','ipd_medication.read','ipd_medication.write',
           'maternity.read','maternity.write',
           'vaccination.read','vaccination.write'],
    '3':  ['patient.read','patient.write','patient.delete','patient_portal.manage','chart.read','profile.self.write','hr.self.read','scheduling.read','scheduling.write',
           'billing.read','opd.read','cashier.read','adt.read',
           'ipd_medication.read'],
    '4':  ['lab.read','lab.write','patient.read','chart.read','profile.self.write'],
    '5':  ['prescription.read','prescription.write','pharmacy.read','pharmacy.write',
           'patient.read','chart.read','profile.self.write','inventory.read',
           'service_catalog.pharmacy.read','service_catalog.pharmacy.write'],
    '6':  ['radiology.read','radiology.write','patient.read','chart.read','profile.self.write'],
    '7':  ['nursing.read','nursing.write','nurse_duty.read','nurse_duty.write','patient.read','patient.write','patient_portal.manage','chart.read','chart.write','adt.read',
           'clinical.read','opd.read','ipd_medication.read','ipd_medication.write','maternity.read','maternity.write','vaccination.read','vaccination.write','profile.self.write','hr.self.read'],
    '8':  ['nursing.read','nurse_duty.read','patient.read','chart.read','ipd_medication.read','ipd_medication.write','profile.self.write','hr.self.read'],
    '9':  ['billing.read','billing.write','payment.validity.read','payment.validity.write',
           'accounting.read','accounting.write','insurance.read','insurance.write',
           'cashier.read','credit.read','credit.write','expenses.read','financials.read','procurement.read','profile.self.write'],
    '10': ['inventory.read','inventory.write','procurement.read','procurement.write','profile.self.write'],
    '11': ['cashier.write','cashier.read','patient.read','chart.read','billing.read',
           'payment.validity.read','profile.self.write','hr.self.read'],
    '100':[
      'dashboard.read',
      'patient.read','patient.write','patient.delete','patient_portal.manage','chart.read','chart.write','profile.self.write','hr.self.read',
      'clinical.read','clinical.write',
      'scheduling.read','scheduling.write','lab.read','radiology.read',
      'prescription.read','prescription.write','adt.read','opd.read',
      'emergency.read','ipd_medication.read','ipd_medication.write',
      'maternity.read','maternity.write',
      'vaccination.read','vaccination.write',
      'doctor_duty.read','doctor_duty.write',
    ],
    '101':['patient.read','billing.read','scheduling.read','opd.read','chart.read','profile.self.write'],
  };

  // Ensure every referenced permission code exists in tbl_acl_permission
  const allPermCodes = [...new Set(Object.values(defaultRolePerms).flat())];
  for (const code of allPermCodes) {
    const parts = code.split('.');
    const mod   = parts[0] || 'general';
    const act   = parts.slice(1).join('.') || 'read';
    await pool.query(
      `INSERT IGNORE INTO tbl_acl_permission (code, label, gap_area, module_code, action)
       VALUES (?, ?, 0, ?, ?)`,
      [code, code, mod, act]
    );
  }

  // Grant each role its default permissions **only on first ACL population**.
  // If any row already exists in tbl_acl_role_permission, we skip this entirely:
  // otherwise every server restart would re-INSERT IGNORE any defaults you had
  // revoked in Access Control (e.g. nurse permissions moved to "unassigned").
  let rolePermCount = 0;
  try {
    const [[cntRow]] = await pool.query('SELECT COUNT(*) AS c FROM tbl_acl_role_permission');
    rolePermCount = parseInt(cntRow && cntRow.c, 10) || 0;
  } catch (_) {
    rolePermCount = -1;
  }

  const {
    ensureAclMigrationTable,
    runAclBootstrapOnce,
    sealAclBootstrapsForExistingInstall,
  } = require('./aclBootstrapMigration');
  await ensureAclMigrationTable(pool);
  await sealAclBootstrapsForExistingInstall(pool, rolePermCount > 0);

  await runAclBootstrapOnce(pool, 'bootstrap.payment_validity_v1', async () => {
    const paymentValidityBootstrapRoles = {
      '9': ['payment.validity.read', 'payment.validity.write'],
      '11': ['payment.validity.read'],
    };
    for (const [role, codes] of Object.entries(paymentValidityBootstrapRoles)) {
      for (const code of codes) {
        await pool.query(
          `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
           SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
          [role, code]
        );
      }
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.hr_self_service_v1', async () => {
    const hrSelfServiceBootstrapRoles = {
      '2': ['hr.self.read'],
      '3': ['hr.self.read'],
      '7': ['hr.self.read'],
      '8': ['hr.self.read'],
      '11': ['hr.self.read'],
      '100': ['hr.self.read'],
    };
    for (const [role, codes] of Object.entries(hrSelfServiceBootstrapRoles)) {
      for (const code of codes) {
        await pool.query(
          `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
           SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
          [role, code]
        );
      }
    }
  });

  await pool.query(
    `UPDATE tbl_acl_ui_element
        SET required_perm = 'hr.self.read'
      WHERE kind = 'tile'
        AND code REGEXP '\\\\.tile\\\\.hr_'
        AND required_perm = 'profile.self.write'`
  ).catch(() => {});

  /** Cashier roles: default Operations nav bundles only before an admin configures navigation. */
  try {
    const { ensureNavAccessSchema } = require('./ensureNavAccessSchema');
    await ensureNavAccessSchema(pool);
    const [cashierRoles] = await pool.query(
      `SELECT DISTINCT role FROM tbl_acl_role_portal WHERE portal_code IN ('cashier', 'Cashier')`
    ).catch(() => [[]]);
    const roles = new Set(['11', ...(cashierRoles || []).map((r) => String(r.role))]);
    for (const role of roles) {
      const [[cntRow]] = await pool.query(
        'SELECT COUNT(*) AS n FROM tbl_acl_role_nav_grant WHERE role=?',
        [role]
      ).catch(() => [[{ n: 1 }]]);
      if (parseInt(cntRow && cntRow.n, 10) > 0) continue;
      await pool.query(
        `INSERT INTO tbl_acl_role_nav_grant (role, nav_code, granted) VALUES (?, 'nav.ops.hms_hub', 1)`,
        [role]
      );
      await pool.query(
        `INSERT INTO tbl_acl_role_nav_grant (role, nav_code, granted) VALUES (?, 'nav.ops.cashier', 1)`,
        [role]
      );
    }
  } catch (_) { /* nav grants optional on legacy DBs */ }

  await runAclBootstrapOnce(pool, 'bootstrap.dashboard_read_v1', async () => {
    for (const role of ['2', '3', '4', '5', '6', '7', '9', '11']) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = 'dashboard.read' LIMIT 1`,
        [role]
      );
    }
  });

  /** Resolve Hospital Director ACL role from tbl_role (not hard-coded 100 — that may be Doctor). */
  let directorAclRole = null;
  try {
    const [[dirRow]] = await pool.query(
      `SELECT CAST(role AS CHAR) AS role FROM tbl_role
        WHERE LOWER(title) LIKE '%director%'
          AND LOWER(title) NOT LIKE '%deputy%'
        ORDER BY role LIMIT 1`
    );
    if (dirRow && dirRow.role != null) directorAclRole = String(dirRow.role);
  } catch (_) { /* tbl_role optional on legacy DBs */ }

  /** Director role: clinical + management capabilities on existing DBs (INSERT IGNORE only). */
  const directorCapabilitiesBootstrap = [
    'dashboard.read',
    'patient.write', 'chart.read', 'chart.write', 'patient_portal.manage',
    'patient.directory.chart', 'patient.directory.insurance', 'patient.directory.credit',
    'patient.directory.portal', 'patient.directory.edit',
    'clinical.read', 'clinical.write', 'opd.read', 'scheduling.read', 'scheduling.write',
    'adt.read', 'adt.write', 'emergency.read', 'maternity.read', 'maternity.write',
    'vaccination.read', 'vaccination.write',
    'nursing.read', 'lab.read', 'lab.write', 'radiology.read', 'radiology.write',
    'prescription.read', 'prescription.write', 'pharmacy.read', 'pharmacy.write',
    'ipd_medication.read', 'ipd_medication.write',
    'cashier.read', 'billing.write', 'financials.read', 'credit.write',
    'employee.write', 'employee.delete', 'employee.password.manage', 'visiting_doctor.manage', 'payroll.write', 'expenses.read', 'procurement.read', 'inventory.read',
    'service_catalog.consultation.read', 'service_catalog.consultation.write',
    'service_catalog.laboratory.read', 'service_catalog.laboratory.write',
    'service_catalog.pharmacy.read', 'service_catalog.pharmacy.write',
    'service_catalog.radiology.read', 'service_catalog.radiology.write',
    'service_catalog.general.read', 'service_catalog.general.write',
    'assets.read', 'assets.write',
  ];
  await runAclBootstrapOnce(pool, 'bootstrap.director_portal_v1', async () => {
    if (!directorAclRole) return;
    const { assignPortal } = require('./roleProfileResolver');
    await assignPortal(pool, directorAclRole, 'director', { isHome: true });
  });

  await runAclBootstrapOnce(pool, 'bootstrap.director_capabilities_v1', async () => {
    if (!directorAclRole) return;
    for (const code of directorCapabilitiesBootstrap) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
        [directorAclRole, code]
      );
    }
  });

  /** Director: full service catalog + employee password management on existing DBs. */
  await runAclBootstrapOnce(pool, 'bootstrap.director_catalog_employee_acl_v1', async () => {
    if (!directorAclRole) return;
    const codes = [
      'employee.password.manage',
      'service_catalog.consultation.read', 'service_catalog.consultation.write',
      'service_catalog.laboratory.read', 'service_catalog.laboratory.write',
      'service_catalog.pharmacy.read', 'service_catalog.pharmacy.write',
      'service_catalog.radiology.read', 'service_catalog.radiology.write',
      'service_catalog.general.read', 'service_catalog.general.write',
    ];
    for (const code of codes) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
        [directorAclRole, code]
      );
    }
  });

  /** Pharmacist role(s): pharmacy catalog section only (title match + default role 5). */
  await runAclBootstrapOnce(pool, 'bootstrap.pharmacist_catalog_acl_v1', async () => {
    const pharmacistPerms = ['service_catalog.pharmacy.read', 'service_catalog.pharmacy.write'];
    const roleIds = new Set(['5']);
    try {
      const [rows] = await pool.query(
        `SELECT CAST(role AS CHAR) AS role FROM tbl_role WHERE LOWER(title) LIKE '%pharmacist%'`
      );
      for (const row of rows || []) {
        if (row && row.role != null) roleIds.add(String(row.role));
      }
    } catch (_) { /* tbl_role optional */ }
    for (const role of roleIds) {
      for (const code of pharmacistPerms) {
        await pool.query(
          `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
           SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
          [role, code]
        );
      }
    }
  });

  /** Lab technician role(s): laboratory catalog section only (title match + default role 4 / 102). */
  await runAclBootstrapOnce(pool, 'bootstrap.labtech_catalog_acl_v1', async () => {
    const labtechPerms = [
      'lab.read',
      'lab.write',
      'service_catalog.laboratory.read',
      'service_catalog.laboratory.write',
    ];
    const roleIds = new Set(['4', '102']);
    try {
      const [rows] = await pool.query(
        `SELECT CAST(role AS CHAR) AS role FROM tbl_role
          WHERE LOWER(title) LIKE '%lab%tech%'
             OR LOWER(title) LIKE '%laboratory%technician%'`
      );
      for (const row of rows || []) {
        if (row && row.role != null) roleIds.add(String(row.role));
      }
    } catch (_) { /* tbl_role optional */ }
    for (const role of roleIds) {
      for (const code of labtechPerms) {
        await pool.query(
          `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
           SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
          [role, code]
        );
      }
    }
  });

  /** Radiologist role(s): radiology catalog section only (title match + default role 6 / 104). */
  await runAclBootstrapOnce(pool, 'bootstrap.radiologist_catalog_acl_v1', async () => {
    const radiologistPerms = [
      'radiology.read',
      'radiology.write',
      'service_catalog.radiology.read',
      'service_catalog.radiology.write',
    ];
    const roleIds = new Set(['6', '104']);
    try {
      const [rows] = await pool.query(
        `SELECT CAST(role AS CHAR) AS role FROM tbl_role
          WHERE LOWER(title) LIKE '%radiolog%'`
      );
      for (const row of rows || []) {
        if (row && row.role != null) roleIds.add(String(row.role));
      }
    } catch (_) { /* tbl_role optional */ }
    for (const role of roleIds) {
      for (const code of radiologistPerms) {
        await pool.query(
          `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
           SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
          [role, code]
        );
      }
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.assets_v1', async () => {
    const assetsBootstrap = ['assets.read', 'assets.write'];
    const assetsRoles = ['1', '9'].concat(directorAclRole ? [directorAclRole] : []);
    for (const role of assetsRoles) {
      for (const code of assetsBootstrap) {
        await pool.query(
          `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
           SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
          [role, code]
        );
      }
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.mgmt_reports_v1', async () => {
    if (!directorAclRole) return;
    for (const code of ['hms_reports.full', 'hms_reports.read']) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
        [directorAclRole, code]
      );
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.director_revenue_v1', async () => {
    if (!directorAclRole) return;
    const { ALL_DIRECTOR_REVENUE_PERMISSIONS } = require('./directorDashboardCatalog');
    for (const [code] of ALL_DIRECTOR_REVENUE_PERMISSIONS) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
        [directorAclRole, code]
      );
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.director_dashboard_v1', async () => {
    if (!directorAclRole) return;
    const { ALL_DIRECTOR_DASHBOARD_PERMISSIONS } = require('./directorDashboardCatalog');
    for (const [code] of ALL_DIRECTOR_DASHBOARD_PERMISSIONS) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
        [directorAclRole, code]
      );
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.director_weekly_v1', async () => {
    if (!directorAclRole) return;
    const { ALL_DIRECTOR_WEEKLY_PERMISSIONS } = require('./directorWeeklyReportCatalog');
    for (const [code] of ALL_DIRECTOR_WEEKLY_PERMISSIONS) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
        [directorAclRole, code]
      );
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.director_monthly_v1', async () => {
    if (!directorAclRole) return;
    const { ALL_DIRECTOR_MONTHLY_PERMISSIONS } = require('./directorMonthlyPLCatalog');
    for (const [code] of ALL_DIRECTOR_MONTHLY_PERMISSIONS) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
        [directorAclRole, code]
      );
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.director_monthly_costs_v1', async () => {
    if (!directorAclRole) return;
    await pool.query(
      `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
       SELECT ?, id FROM tbl_acl_permission WHERE code = 'director.monthly.costs.write' LIMIT 1`,
      [directorAclRole]
    );
    await pool.query(
      `INSERT IGNORE INTO tbl_acl_permission (code, label, gap_area, module_code, action)
       VALUES ('director.monthly.costs.write', 'Director monthly P&L — enter manual payroll & expenses', 0, 'director', 'write')`
    ).catch(() => {});
  });

  await runAclBootstrapOnce(pool, 'bootstrap.director_annual_v1', async () => {
    if (!directorAclRole) return;
    const { ALL_DIRECTOR_ANNUAL_PERMISSIONS } = require('./directorAnnualScorecardCatalog');
    for (const [code] of ALL_DIRECTOR_ANNUAL_PERMISSIONS) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
        [directorAclRole, code]
      );
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.subscriptions_v1', async () => {
    const subscriptionRoles = ['1', '99'].concat(directorAclRole ? [directorAclRole] : []);
    for (const role of subscriptionRoles) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = 'subscriptions.manage' LIMIT 1`,
        [role]
      );
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.accountant_reports_v1', async () => {
    await pool.query(
      `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
       SELECT '9', id FROM tbl_acl_permission WHERE code IN ('hms_reports.financial','hms_reports.read')`
    ).catch(() => {});
  });

  await runAclBootstrapOnce(pool, 'bootstrap.nurse_duty_v1', async () => {
    for (const [srcCode, dstCode] of [
      ['nursing.read', 'nurse_duty.read'],
      ['nursing.write', 'nurse_duty.write'],
    ]) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT rp.role, dst.id
           FROM tbl_acl_role_permission rp
           JOIN tbl_acl_permission src ON src.id = rp.permission_id AND src.code = ?
           JOIN tbl_acl_permission dst ON dst.code = ?`,
        [srcCode, dstCode]
      ).catch(() => {});
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.director_settings_menu_perms_v1', async () => {
    let directorRole = null;
    try {
      const [[dirRow]] = await pool.query(
        `SELECT CAST(role AS CHAR) AS role FROM tbl_role
          WHERE LOWER(title) LIKE '%director%'
            AND LOWER(title) NOT LIKE '%deputy%'
          ORDER BY role LIMIT 1`
      );
      if (dirRow && dirRow.role != null) directorRole = String(dirRow.role);
    } catch (_) { /* optional */ }
    if (!directorRole) return;
    for (const code of [
      'pharmacy.read', 'pharmacy.write', 'clinical.read', 'clinical.write',
      'prescription.read', 'financials.read', 'payroll.read',
      'service_catalog.write', 'settings.org_clinical.write',
    ]) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
        [directorRole, code]
      ).catch(() => {});
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.settings_hub_tools_v1', async () => {
    const movedNavCodes = [
      'nav.cfg.prescription_verify',
      'nav.cfg.commission',
      'nav.cfg.hms_config',
    ];
    const [rows] = await pool.query(
      `SELECT DISTINCT role FROM tbl_acl_role_nav_grant
        WHERE nav_code IN ('nav.configuration', 'nav.clinical.hms') AND granted = 1`
    ).catch(() => [[]]);
    for (const row of rows || []) {
      for (const navCode of movedNavCodes) {
        await pool.query(
          `INSERT IGNORE INTO tbl_acl_role_nav_grant (role, nav_code, granted) VALUES (?, ?, 1)`,
          [row.role, navCode]
        ).catch(() => {});
      }
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.employee_password_nav_v1', async () => {
    const [roles] = await pool.query(
      `SELECT DISTINCT CAST(rp.role AS CHAR) AS role
         FROM tbl_acl_role_permission rp
         INNER JOIN tbl_acl_permission p ON p.id = rp.permission_id
        WHERE p.code = 'employee.password.manage'`
    ).catch(() => [[]]);
    for (const row of roles || []) {
      if (!row || row.role == null) continue;
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_nav_grant (role, nav_code, granted) VALUES (?, 'nav.cfg.employee_password', 1)`,
        [String(row.role)]
      ).catch(() => {});
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.doctor_schedule_tile_v1', async () => {
    for (const permCode of ['doctor_duty.read', 'clinical.read', 'clinical.write']) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_nav_grant (role, nav_code, granted)
         SELECT DISTINCT CAST(rp.role AS CHAR), 'doc.tile.schedule', 1
           FROM tbl_acl_role_permission rp
           INNER JOIN tbl_acl_permission p ON p.id = rp.permission_id
          WHERE p.code = ?`,
        [permCode]
      ).catch(() => {});
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.employee_add_nav_v1', async () => {
    const [roles] = await pool.query(
      `SELECT DISTINCT CAST(rp.role AS CHAR) AS role
         FROM tbl_acl_role_permission rp
         INNER JOIN tbl_acl_permission p ON p.id = rp.permission_id
        WHERE p.code = 'employee.write'`
    ).catch(() => [[]]);
    for (const row of roles || []) {
      if (!row || row.role == null) continue;
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_nav_grant (role, nav_code, granted) VALUES (?, 'nav.cfg.employee_add', 1)`,
        [String(row.role)]
      ).catch(() => {});
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.nursing_patient_v1', async () => {
    for (const permCode of ['patient.read', 'patient.write']) {
      await pool.query(
        `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
         SELECT rp.role, p.id
           FROM tbl_acl_role_portal rp
           JOIN tbl_acl_permission p ON p.code = ?
          WHERE rp.portal_code IN ('nurse', 'nursing')`,
        [permCode]
      ).catch(() => {});
    }
  });

  const doctorRosterPerm = 'doctor_duty.read|doctor_duty.write';
  const nurseRosterPerm = 'nurse_duty.read|nurse_duty.write';
  try {
    await pool.query(
      `UPDATE tbl_acl_ui_element SET
         code = 'topnav.ops.mgmt_reports',
         parent_code = 'topnav.operations',
         sort_order = 385
       WHERE code = 'topnav.cfg.mgmt_reports'`
    );
    await pool.query(
      `UPDATE tbl_acl_role_nav_grant SET nav_code = 'nav.ops.mgmt_reports'
       WHERE nav_code = 'nav.cfg.mgmt_reports'`
    ).catch(() => {});
    await pool.query(
      `UPDATE tbl_acl_ui_element SET required_perm = ?
       WHERE code IN ('topnav.clinical.doctor_roster', 'sb.doctor_roster', 'doc.tile.duty')`,
      [doctorRosterPerm]
    );
    await pool.query(
      `UPDATE tbl_acl_ui_element SET required_perm = ?
       WHERE code IN ('topnav.clinical.nurse_roster', 'sb.nurse_roster', 'nur.tile.roster')`,
      [nurseRosterPerm]
    );
    await pool.query(
      `UPDATE tbl_acl_ui_element SET required_perm = 'patient.read'
       WHERE code = 'nur.tile.patients'`
    );
    await pool.query(
      `UPDATE tbl_acl_ui_element SET url = '/patients?action=new'
       WHERE code = 'nur.tile.register'`
    );
    await pool.query(
      `UPDATE tbl_acl_ui_element SET url='/hms-admin/access' WHERE url='/access-control' OR url LIKE '/access-control%'`
    );
    await pool.query(
      `UPDATE tbl_acl_ui_element SET
         url = '/departments',
         label = 'Departments & specialisations',
         required_perm = 'employee.read|employee.write|access_control.manage'
       WHERE code IN ('sb.departments_catalog', 'topnav.cfg.departments')
          OR url IN ('/settings/org-clinical', '/settings/departments-specialisations')`
    ).catch(() => {});
    await pool.query(
      `UPDATE tbl_acl_ui_element SET enabled = 0
       WHERE code IN ('sb.org_clinical', 'topnav.cfg.org_clinical')`
    ).catch(() => {});
    await pool.query(
      `UPDATE tbl_acl_ui_element SET required_perm = 'super_admin.product'
       WHERE code IN ('topnav.cfg.super_admin', 'sb.super_admin')`
    );
  } catch (_) { /* UI table may not exist yet */ }

  try {
    await runAclBootstrapOnce(pool, 'bootstrap.system_admin_profile_v1', async () => {
      const { ensureSystemAdminAclProfile } = require('./hmsSystemAdminProfile');
      await ensureSystemAdminAclProfile(pool);
    });
  } catch (e) {
    console.warn('[ensureAclSchema] ensureSystemAdminAclProfile:', e.message);
  }

  if (rolePermCount === 0) {
    const dirMenu = [
      'patient.directory.chart',
      'patient.directory.insurance',
      'patient.directory.credit',
      'patient.directory.portal',
      'patient.directory.edit'
    ];
    for (const [role, codes] of Object.entries(defaultRolePerms)) {
      const merged = [...codes];
      if (codes.includes('patient.write')) {
        for (const d of dirMenu) {
          if (!merged.includes(d)) merged.push(d);
        }
      }
      if (codes.includes('chart.read') && !merged.includes('patient.directory.chart')) {
        merged.push('patient.directory.chart');
      }
      if (codes.includes('patient_portal.manage') && !merged.includes('patient.directory.portal')) {
        merged.push('patient.directory.portal');
      }
      for (const code of merged) {
        await pool.query(
          `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
           SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
          [role, code]
        );
      }
    }
  }

  await runAclBootstrapOnce(pool, 'bootstrap.vaccination_module_v1', async () => {
    const vacPerms = ['vaccination.read', 'vaccination.write'];
    const vacRoles = ['2', '7', '100'];
    for (const role of vacRoles) {
      for (const code of vacPerms) {
        await pool.query(
          `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
           SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
          [role, code]
        ).catch(() => {});
      }
    }
    if (directorAclRole) {
      for (const code of vacPerms) {
        await pool.query(
          `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
           SELECT ?, id FROM tbl_acl_permission WHERE code = ? LIMIT 1`,
          [directorAclRole, code]
        ).catch(() => {});
      }
    }
  });

  await runAclBootstrapOnce(pool, 'bootstrap.role_profiles_v1', async () => {
    const { bootstrapRoleProfiles } = require('./roleProfileBootstrap');
    const result = await bootstrapRoleProfiles(pool);
    console.log('[ensureAclSchema] Role profiles bootstrapped:', result);
  });
};
