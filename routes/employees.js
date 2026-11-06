'use strict';

/**
 * Employee onboarding: create an employee from a net or gross salary target and
 * let the Cameroon statutory engine generate the pay profile + first payroll line.
 */

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ensureHrPayrollSchema = require('../lib/ensureHrPayrollSchema');
const ensureEmployeeHrSchema = require('../lib/ensureEmployeeHrSchema');
const { loadRoleTitleMap, resolveRoleTitle, resolveHireDate } = require('../lib/hmsEmployeeHr');
const { rolesForSector } = require('../lib/rolePresets');
const { SECTORS, loadAllowanceSettings } = require('../lib/hmsAllowanceCameroon');
const {
  computeFromGross,
  computeFromNet,
  computeFromProfile,
} = require('../lib/payrollCompensation');

const MONTHS = {
  1: 'January', 2: 'February', 3: 'March', 4: 'April', 5: 'May', 6: 'June',
  7: 'July', 8: 'August', 9: 'September', 10: 'October', 11: 'November', 12: 'December',
};

const FALLBACK_ROLES = [
  { id: 1, title: 'Admin' },
  { id: 2, title: 'Doctor' },
  { id: 3, title: 'Front Desk' },
  { id: 4, title: 'Lab' },
  { id: 5, title: 'Pharmacy' },
  { id: 6, title: 'Radiology' },
  { id: 7, title: 'Nurse' },
  { id: 8, title: 'Nursing Aid' },
  { id: 9, title: 'Accountant' },
  { id: 11, title: 'Cashier' },
  { id: 99, title: 'Super Admin' },
];

const IMPORT_MAX_ROWS = 100;
const IMPORT_MAX_BYTES = 1024 * 1024;
const IMPORT_TEMPLATE_HEADERS = [
  'first_name', 'last_name', 'matricule', 'cnps_number', 'tax_niu', 'nic_number',
  'email', 'phone', 'date_of_birth', 'gender', 'role', 'job_title', 'department',
  'date_of_joining', 'collective_agreement', 'specialist_grade', 'bank_name',
  'bank_account', 'salary_basis', 'monthly_salary', 'payroll_month', 'payroll_year',
];
const IMPORT_REQUIRED_HEADERS = [
  'first_name', 'last_name', 'role', 'date_of_joining', 'salary_basis', 'monthly_salary',
];
const IMPORT_HEADER_ALIASES = {
  employee_id: 'matricule',
  employeeid: 'matricule',
  employee_no: 'matricule',
  staff_id: 'matricule',
  staffid: 'matricule',
  firstname: 'first_name',
  first_names: 'first_name',
  prenom: 'first_name',
  lastname: 'last_name',
  surname: 'last_name',
  nom: 'last_name',
  cnps: 'cnps_number',
  cnps_no: 'cnps_number',
  niu: 'tax_niu',
  tax_id: 'tax_niu',
  tax_id_niu: 'tax_niu',
  national_id: 'nic_number',
  cni: 'nic_number',
  id_number: 'nic_number',
  email: 'emailid',
  email_address: 'emailid',
  telephone: 'phone',
  phone_number: 'phone',
  date_of_birth: 'dob',
  birth_date: 'dob',
  sex: 'gender',
  role_title: 'role',
  job_role: 'role',
  position: 'job_title',
  position_job_title: 'job_title',
  department: 'primary_department',
  joining_date: 'date_of_joining',
  hire_date: 'date_of_joining',
  collective_agreement: 'sector',
  collective_bargaining_agreement: 'sector',
  is_specialist: 'specialist_grade',
  specialist: 'specialist_grade',
  bank: 'bank_name',
  bank_account: 'bank_account_no',
  account_number: 'bank_account_no',
  basis: 'salary_basis',
  salary: 'monthly_salary',
  salary_amount: 'monthly_salary',
  month: 'payroll_month',
  first_payroll_month: 'payroll_month',
  year: 'payroll_year',
  first_payroll_year: 'payroll_year',
};

function normalizeImportHeader(value) {
  return String(value == null ? '' : value)
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function canonicalImportHeader(value) {
  const key = normalizeImportHeader(value);
  return IMPORT_HEADER_ALIASES[key] || key;
}

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  return '"' + s.replace(/"/g, '""') + '"';
}

function detectCsvDelimiter(text) {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (let i = 0; i < firstLine.length; i += 1) {
    const ch = firstLine[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ',') commas += 1;
    else if (!quoted && ch === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

function parseCsvRows(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  if (!source.trim()) return [];
  const delimiter = detectCsvDelimiter(source);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (quoted) throw new Error('The CSV has an unclosed quoted field.');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
}

function parseImportAmount(value) {
  let s = String(value == null ? '' : value).replace(/\u00a0/g, ' ').trim().replace(/\s/g, '');
  if (!s) return 0;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseImportMonth(value, fallback) {
  const raw = clean(value, 30);
  if (!raw) return fallback;
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    return n >= 1 && n <= 12 ? n : null;
  }
  const key = raw.toLowerCase().slice(0, 3);
  const hit = Object.entries(MONTHS).find(([, label]) => label.toLowerCase().startsWith(key));
  return hit ? Number(hit[0]) : null;
}

function parseImportYear(value, fallback) {
  const raw = clean(value, 10);
  if (!raw) return fallback;
  if (!/^\d{4}$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n >= 2000 && n <= 2100 ? n : null;
}

function parseImportFlag(value) {
  const raw = clean(value, 20).toLowerCase();
  if (!raw) return 0;
  if (['1', 'yes', 'y', 'true', 'oui', 'o'].includes(raw)) return 1;
  if (['0', 'no', 'n', 'false', 'non'].includes(raw)) return 0;
  return null;
}

function parseImportGender(value) {
  const raw = clean(value, 20).toLowerCase();
  if (!raw) return '';
  if (['m', 'male', 'masculin', 'homme'].includes(raw)) return 'M';
  if (['f', 'female', 'feminin', 'féminin', 'femme'].includes(raw)) return 'F';
  return null;
}

function resolveImportSector(value, fallback) {
  const raw = clean(value, 100).toLowerCase();
  if (!raw) return fallback;
  if (SECTORS[raw]) return raw;
  const hit = Object.entries(SECTORS).find(([, label]) => label.toLowerCase() === raw);
  return hit ? hit[0] : null;
}

function resolveImportRole(value, roles) {
  const raw = clean(value, 120);
  if (!raw) return null;
  if (/^\d+$/.test(raw) && roles.some((role) => String(role.id) === raw)) return raw;
  const hit = roles.find((role) => String(role.title || '').toLowerCase() === raw.toLowerCase());
  return hit ? String(hit.id) : null;
}

/**
 * Create the employee, pay profile and first payroll line in one place so the
 * single onboarding form and CSV import cannot drift apart.
 */
async function saveOnboardedEmployee(db, opts) {
  const { fid, first, last, body, role, sector, hireDate, comp, year, month, passwordHash } = opts;
  const b = body || {};
  const base = slugUsername(first, last);
  let username = base;
  for (let i = 1; i < 50; i += 1) {
    const [[taken]] = await db.query('SELECT id FROM tbl_employee WHERE username = ? LIMIT 1', [username]);
    if (!taken) break;
    username = `${base}${i + 1}`;
  }

  const hash = passwordHash || (await bcrypt.hash(crypto.randomBytes(18).toString('hex'), 10));
  const [insertResult] = await db.query(
    `INSERT INTO tbl_employee
      (first_name, last_name, username, emailid, password, dob, gender, address, bio,
       employee_id, joining_date, phone, role, status, primary_department, job_title,
       cnps_number, tax_niu, nic_number, bank_name, bank_account_no, default_facility_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`,
    [
      first,
      last,
      username,
      clean(b.emailid, 250),
      hash,
      clean(b.dob, 50),
      clean(b.gender, 10),
      clean(b.address, 500),
      '',
      clean(b.employee_id, 120),
      hireDate,
      clean(b.phone, 32),
      role,
      clean(b.primary_department, 120) || null,
      clean(b.job_title, 120) || null,
      clean(b.cnps_number, 32),
      clean(b.tax_niu, 32),
      clean(b.nic_number, 32),
      clean(b.bank_name, 120),
      clean(b.bank_account_no, 40),
      fid,
    ]
  );
  const employeeId = Number(insertResult.insertId);
  if (!employeeId) throw new Error('Employee could not be created.');

  let matricule = clean(b.employee_id, 120);
  if (!matricule) {
    matricule = `EMP-${String(employeeId).padStart(4, '0')}`;
    await db.query('UPDATE tbl_employee SET employee_id = ? WHERE id = ?', [matricule, employeeId]);
  }

  const isSpecialist = String(b.is_specialist || '') === '1' ? 1 : 0;
  await db.query(
    `INSERT INTO tbl_hms_pay_profile
      (facility_id, employee_id, basic_salary, housing_allowance, transport_allowance, other_allowances,
       medical_risk_allowance, responsibility_allowance, is_specialist,
       hire_date, sector, night_shifts_per_month, on_call_per_month)
     VALUES (?,?,?,?,?,0,0,0,?,?,?,0,0)
     ON DUPLICATE KEY UPDATE
      basic_salary=VALUES(basic_salary), housing_allowance=VALUES(housing_allowance),
      transport_allowance=VALUES(transport_allowance), other_allowances=0,
      is_specialist=VALUES(is_specialist), hire_date=VALUES(hire_date), sector=VALUES(sector)`,
    [fid, employeeId, comp.basic_salary, comp.housing_allowance, comp.transport_allowance, isSpecialist, hireDate, sector]
  );

  let recordId = 0;
  let warning = '';
  if (comp.statutory_ready) {
    const d = comp.deductions;
    const snap = JSON.stringify({ total: comp.allowance_total, lines: comp.allowance_lines });
    const [rec] = await db.query(
      `INSERT INTO tbl_hms_payroll_record
        (facility_id, employee_id, year, month, gross_salary,
         cnps_employee, cimr_employee, crtv_deduction, council_tax_deduction,
         development_tax_deduction, cnhc_deduction, taxable_income, income_tax, net_salary,
         basic_salary_snap, housing_allowance_snap, transport_allowance_snap, other_allowances_snap,
         payout_status, allowances_snap, non_taxable_allowance)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'pending',?,?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [
        fid,
        employeeId,
        year,
        month,
        comp.gross,
        d.cnps,
        d.cfc,
        d.crtv,
        d.council,
        d.fne,
        d.cac,
        comp.taxable_income,
        d.irpp,
        comp.net,
        comp.basic_salary,
        comp.housing_allowance,
        comp.transport_allowance,
        snap,
        comp.allowance_tax_free_total,
      ]
    );
    recordId = Number(rec.insertId || 0);
  } else {
    warning =
      'Employee saved, but payroll tax settings are missing, so no payroll line could be calculated. Configure Tax settings first, then process the month.';
  }

  return { employeeId, username, matricule, recordId, warning };
}

function clean(value, max = 250) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function toIsoDate(value) {
  const raw = clean(value, 40);
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) return raw;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function slugUsername(first, last, fallbackId) {
  const base = `${first || ''}.${last || ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.]+/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
  return base || `employee${fallbackId || ''}`;
}

async function loadRoles(pool) {
  try {
    const [rows] = await pool.query(
      `SELECT CAST(role AS UNSIGNED) AS id, MIN(title) AS title
       FROM tbl_role
       WHERE CAST(role AS UNSIGNED) > 0
       GROUP BY CAST(role AS UNSIGNED)
       ORDER BY id`
    );
    const list = (rows || [])
      .map((r) => ({ id: Number(r.id), title: clean(r.title, 120) || `Role ${r.id}` }))
      .filter((r) => r.id > 0);
    return list.length ? list : FALLBACK_ROLES;
  } catch (_) {
    return FALLBACK_ROLES;
  }
}

/**
 * Seed the sector's usual roles once, so HR does not have to create each one.
 * Idempotent: titles already present in tbl_role are left untouched.
 */
async function ensurePresetRoles(pool, sector) {
  const wanted = rolesForSector(sector);
  if (!wanted.length) return;
  try {
    const [rows] = await pool.query(
      'SELECT CAST(role AS UNSIGNED) AS id, title FROM tbl_role'
    );
    const seen = new Set((rows || []).map((r) => String(r.title || '').trim().toLowerCase()));
    let nextId = Math.max(111, ...(rows || []).map((r) => Number(r.id) || 0)) + 1;
    for (const title of wanted) {
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      await pool.query('INSERT INTO tbl_role (role, title) VALUES (?, ?)', [String(nextId), title]);
      seen.add(key);
      nextId += 1;
    }
  } catch (e) {
    console.warn('[employees/roles] preset seeding skipped:', e.message);
  }
}

/** Sector roles first (Admin / Super Admin lead), then every other role. */
function orderRolesForSector(roles, sector) {
  const presets = rolesForSector(sector);
  if (!presets.length) return roles;
  const rank = new Map(presets.map((title, i) => [title.toLowerCase(), i]));
  return roles.slice().sort((a, b) => {
    const ra = rank.has(a.title.toLowerCase()) ? rank.get(a.title.toLowerCase()) : 1000;
    const rb = rank.has(b.title.toLowerCase()) ? rank.get(b.title.toLowerCase()) : 1000;
    if (ra !== rb) return ra - rb;
    return a.id - b.id;
  });
}

async function facilitySector(pool, fid) {
  try {
    const [[row]] = await pool.query(
      'SELECT default_sector FROM tbl_hms_payroll_settings WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1',
      [fid]
    );
    const sector = clean(row && row.default_sector, 40).toLowerCase();
    return SECTORS[sector] ? sector : 'medical';
  } catch (_) {
    return 'medical';
  }
}

module.exports = function registerEmployeeRoutes(app, pool, requireAuth, deps) {
  const { requireAdminOrSuper } = deps || {};

  function facilityId(req) {
    return Math.max(1, parseInt(req.session.facilityId, 10) || 1);
  }

  function canManage(req) {
    const role = String((req.session.user && req.session.user.role) || '');
    if (role === '1' || role === '99') return true;
    const up = req.session.userPerms || [];
    return up.includes('*') || up.includes('payroll.write');
  }

  function guard(req, res, next) {
    if (canManage(req)) return next();
    if (requireAdminOrSuper) return requireAdminOrSuper(req, res, next);
    return res.status(403).send('Admin access required.');
  }

  function renderNew(res, opts) {
    return res.status(opts.status || 200).render('employees-new', {
      title: 'New employee — Zaizens Payroll',
      roles: opts.roles || FALLBACK_ROLES,
      sectors: SECTORS,
      defaultSector: opts.defaultSector || 'medical',
      form: opts.form || {},
      flash: opts.flash || null,
      error: opts.error || null,
      today: new Date().toISOString().slice(0, 10),
      currentYear: new Date().getFullYear(),
      currentMonth: new Date().getMonth() + 1,
      months: MONTHS,
    });
  }

  app.get('/payroll/employees/new', requireAuth, guard, async (req, res) => {
    try {
      await ensureHrPayrollSchema(pool);
      const fid = facilityId(req);
      const sector = await facilitySector(pool, fid);
      await ensurePresetRoles(pool, sector);
      const roles = orderRolesForSector(await loadRoles(pool), sector);
      return renderNew(res, { roles, defaultSector: sector });
    } catch (e) {
      return res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  /** Live preview: net/gross target → basic, allowances and statutory deductions. */
  app.post('/payroll/employees/preview', requireAuth, guard, async (req, res) => {
    try {
      await ensureHrPayrollSchema(pool);
      const fid = facilityId(req);
      const basis = String(req.body.salary_basis || 'net').toLowerCase() === 'gross' ? 'gross' : 'net';
      const target = Math.max(0, parseFloat(req.body.net) || 0);
      if (target <= 0) {
        return res.status(400).json({ error: `Enter a ${basis} salary greater than zero.` });
      }

      const sector = SECTORS[clean(req.body.sector, 40).toLowerCase()] ? clean(req.body.sector, 40).toLowerCase() : 'medical';
      const settings = await loadAllowanceSettings(pool, fid, sector);
      const role = clean(req.body.role, 20) || '0';
      const roleMap = await loadRoleTitleMap(pool);
      const compute = basis === 'gross' ? computeFromGross : computeFromNet;
      const comp = await compute(pool, fid, new Date().getFullYear(), target, {
        role,
        roleTitle: resolveRoleTitle(role, roleMap),
        hireDate: toIsoDate(req.body.hire_date),
        settings,
        isSpecialist: String(req.body.is_specialist || '') === '1',
      });
      return res.json({ ok: true, basis, ...comp });
    } catch (e) {
      console.error('[employees/preview]', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  /** Download a CSV template for creating employees and their salary profiles. */
  app.get('/payroll/employees/template.csv', requireAuth, guard, async (req, res) => {
    try {
      const fid = facilityId(req);
      const sector = await facilitySector(pool, fid);
      await ensurePresetRoles(pool, sector);
      const roles = orderRolesForSector(await loadRoles(pool), sector);
      const sampleRole =
        roles.find((role) => /nurse|infirm/i.test(role.title || '')) ||
        roles.find((role) => !/admin/i.test(role.title || '')) ||
        roles[0] ||
        { title: 'Nurse' };
      const today = new Date().toISOString().slice(0, 10);
      const sample = {
        first_name: 'Amina',
        last_name: 'Ngwa',
        matricule: '',
        cnps_number: '',
        tax_niu: '',
        nic_number: '',
        email: '',
        phone: '',
        date_of_birth: '',
        gender: 'F',
        role: sampleRole.title,
        job_title: sampleRole.title,
        department: '',
        date_of_joining: today,
        collective_agreement: '',
        specialist_grade: 'no',
        bank_name: '',
        bank_account: '',
        salary_basis: 'net',
        monthly_salary: '250000',
        payroll_month: '',
        payroll_year: '',
      };
      const lines = [
        IMPORT_TEMPLATE_HEADERS.map(csvEscape).join(','),
        IMPORT_TEMPLATE_HEADERS.map((header) => csvEscape(sample[header])).join(','),
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="zaizens-employee-salary-template.csv"');
      res.setHeader('Cache-Control', 'no-store');
      return res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
    } catch (e) {
      console.error('[employees/template]', e.message);
      return res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  /** Bulk-create employees, pay profiles and first payroll lines from a CSV. */
  app.post(
    '/payroll/employees/import',
    requireAuth,
    guard,
    express.text({ type: 'text/csv', limit: '1mb' }),
    async (req, res) => {
      const fid = facilityId(req);
      const fail = (status, message, errors) =>
        res.status(status).json({ ok: false, error: message, errors: errors || [] });

      try {
        if (typeof req.body !== 'string' || !req.body.trim()) {
          return fail(400, 'Upload a CSV file to import employees.');
        }
        if (Buffer.byteLength(req.body, 'utf8') > IMPORT_MAX_BYTES) {
          return fail(400, 'The CSV file is larger than 1 MB.');
        }

        const rows = parseCsvRows(req.body);
        if (rows.length < 2) {
          return fail(400, 'The CSV must contain a header row and at least one employee row.');
        }
        const headers = rows[0].map(canonicalImportHeader);
        const missing = IMPORT_REQUIRED_HEADERS.filter((header) => !headers.includes(header));
        if (missing.length) {
          return fail(400, `Missing required column(s): ${missing.join(', ')}.`);
        }
        const dataRows = rows.slice(1);
        if (dataRows.length > IMPORT_MAX_ROWS) {
          return fail(400, `Import at most ${IMPORT_MAX_ROWS} employees at a time.`);
        }

        const defaultSector = await facilitySector(pool, fid);
        await ensurePresetRoles(pool, defaultSector);
        const roles = orderRolesForSector(await loadRoles(pool), defaultSector);
        const roleMap = await loadRoleTitleMap(pool);
        const currentMonth = new Date().getMonth() + 1;
        const currentYear = new Date().getFullYear();

        const rawEntries = dataRows.map((cells, index) => {
          const data = {};
          headers.forEach((header, headerIndex) => {
            if (header) data[header] = String(cells[headerIndex] == null ? '' : cells[headerIndex]).trim();
          });
          return { row: index + 2, data };
        });

        const providedMatricules = rawEntries
          .map((entry) => clean(entry.data.matricule, 120))
          .filter(Boolean);
        const existingMatricules = new Set();
        if (providedMatricules.length) {
          const placeholders = providedMatricules.map(() => '?').join(',');
          const [existingRows] = await pool.query(
            `SELECT employee_id FROM tbl_employee WHERE employee_id IN (${placeholders})`,
            providedMatricules
          );
          for (const row of existingRows || []) {
            existingMatricules.add(String(row.employee_id || '').toLowerCase());
          }
        }

        const errors = [];
        const prepared = [];
        const fileMatricules = new Map();

        for (const entry of rawEntries) {
          const d = entry.data;
          const rowErrors = [];
          const first = clean(d.first_name, 120);
          const last = clean(d.last_name, 120);
          const matricule = clean(d.matricule, 120);
          const role = resolveImportRole(d.role, roles);
          const sector = resolveImportSector(d.sector, defaultSector);
          const basisRaw = clean(d.salary_basis, 20).toLowerCase();
          const basis = ['net', 'gross'].includes(basisRaw) ? basisRaw : null;
          const salaryTarget = parseImportAmount(d.monthly_salary);
          const hireDate = toIsoDate(d.date_of_joining);
          const dob = d.dob ? toIsoDate(d.dob) : null;
          const gender = parseImportGender(d.gender);
          const specialist = parseImportFlag(d.specialist_grade);
          const month = parseImportMonth(d.payroll_month, currentMonth);
          const year = parseImportYear(d.payroll_year, currentYear);

          if (!first) rowErrors.push('First name is required.');
          if (!last) rowErrors.push('Last name is required.');
          if (!clean(d.role, 120)) rowErrors.push('Role is required.');
          else if (!role) {
            rowErrors.push(`Role "${clean(d.role, 120)}" was not found. Use an existing role name or create it first.`);
          }
          if (!d.date_of_joining) rowErrors.push('Date of joining is required.');
          else if (!hireDate) rowErrors.push('Date of joining must be a valid date (YYYY-MM-DD).');
          if (!basis) rowErrors.push('Salary basis must be net or gross.');
          if (salaryTarget <= 0) rowErrors.push('Monthly salary must be greater than zero.');
          if (!sector) {
            rowErrors.push(`Collective agreement "${clean(d.sector, 100)}" is not recognised.`);
          }
          if (d.dob && !dob) rowErrors.push('Date of birth must be a valid date (YYYY-MM-DD).');
          if (gender == null) rowErrors.push('Gender must be M or F.');
          if (specialist == null) rowErrors.push('Specialist grade must be yes or no.');
          if (month == null) rowErrors.push('Payroll month must be between 1 and 12.');
          if (year == null) rowErrors.push('Payroll year must be between 2000 and 2100.');
          if (matricule) {
            const key = matricule.toLowerCase();
            if (existingMatricules.has(key)) {
              rowErrors.push(`Matricule ${matricule} already exists.`);
            } else if (fileMatricules.has(key)) {
              rowErrors.push(`Matricule ${matricule} is repeated on row ${fileMatricules.get(key)}.`);
            } else {
              fileMatricules.set(key, entry.row);
            }
          }

          if (rowErrors.length) {
            errors.push({ row: entry.row, message: rowErrors.join(' ') });
            continue;
          }

          prepared.push({
            row: entry.row,
            first,
            last,
            matricule,
            emailid: clean(d.emailid, 250),
            dob: dob || '',
            gender: gender || '',
            phone: clean(d.phone, 32),
            role,
            sector,
            basis,
            salaryTarget,
            hireDate,
            month,
            year,
            specialist,
            job_title: clean(d.job_title, 120),
            department: clean(d.primary_department, 120),
            cnps_number: clean(d.cnps_number, 32),
            tax_niu: clean(d.tax_niu, 32),
            nic_number: clean(d.nic_number, 32),
            bank_name: clean(d.bank_name, 120),
            bank_account_no: clean(d.bank_account_no, 40),
          });
        }

        if (errors.length) {
          return fail(422, 'Fix the highlighted rows, then import again. No employees were created.', errors);
        }

        const settingsBySector = new Map();
        for (const item of prepared) {
          try {
            if (!settingsBySector.has(item.sector)) {
              settingsBySector.set(item.sector, await loadAllowanceSettings(pool, fid, item.sector));
            }
            const compute = item.basis === 'gross' ? computeFromGross : computeFromNet;
            const comp = await compute(pool, fid, item.year, item.salaryTarget, {
              role: item.role,
              roleTitle: resolveRoleTitle(item.role, roleMap),
              hireDate: item.hireDate,
              settings: settingsBySector.get(item.sector),
              isSpecialist: item.specialist === 1,
            });
            if (!comp.statutory_ready) {
              throw new Error('Payroll tax settings are missing. Configure Tax settings before importing.');
            }
            item.comp = comp;
          } catch (e) {
            errors.push({ row: item.row, message: e.message });
          }
        }

        if (errors.length) {
          return fail(422, 'Some rows could not be calculated. No employees were created.', errors);
        }

        // Hash passwords before opening the transaction so the import does not
        // hold a database transaction while bcrypt runs.
        for (const item of prepared) {
          item.passwordHash = await bcrypt.hash(crypto.randomBytes(18).toString('hex'), 10);
        }

        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const created = [];
          for (const item of prepared) {
            try {
              const saved = await saveOnboardedEmployee(conn, {
                fid,
                first: item.first,
                last: item.last,
                body: {
                  employee_id: item.matricule,
                  emailid: item.emailid,
                  dob: item.dob,
                  gender: item.gender,
                  phone: item.phone,
                  primary_department: item.department,
                  job_title: item.job_title,
                  cnps_number: item.cnps_number,
                  tax_niu: item.tax_niu,
                  nic_number: item.nic_number,
                  bank_name: item.bank_name,
                  bank_account_no: item.bank_account_no,
                  is_specialist: item.specialist ? '1' : '0',
                },
                role: item.role,
                sector: item.sector,
                hireDate: item.hireDate,
                comp: item.comp,
                year: item.year,
                month: item.month,
                passwordHash: item.passwordHash,
              });
              created.push({
                id: saved.employeeId,
                name: `${item.first} ${item.last}`.trim(),
                matricule: saved.matricule,
                basis: item.basis,
                gross: item.comp.gross,
                net: item.comp.net,
                year: item.year,
                month: item.month,
              });
            } catch (e) {
              e.importRow = item.row;
              throw e;
            }
          }
          await conn.commit();
          return res.json({
            ok: true,
            created: created.length,
            employees: created,
            message: `Created ${created.length} employee(s) with salary profiles and pending payroll lines.`,
          });
        } catch (e) {
          await conn.rollback().catch(() => {});
          console.error('[employees/import]', e.message);
          return fail(422, `Import failed on row ${e.importRow || '?'}. No employees were created.`, [
            { row: e.importRow || 0, message: e.message },
          ]);
        } finally {
          conn.release();
        }
      } catch (e) {
        console.error('[employees/import]', e.message);
        return fail(500, e.message || 'The CSV could not be imported.');
      }
    }
  );

  app.post('/payroll/employees/new', requireAuth, guard, async (req, res) => {
    const fid = facilityId(req);
    const body = req.body || {};
    try {
      await ensureHrPayrollSchema(pool);
      await ensureEmployeeHrSchema(pool);

      const first = clean(body.first_name, 120);
      const last = clean(body.last_name, 120);
      const basis = String(body.salary_basis || 'net').toLowerCase() === 'gross' ? 'gross' : 'net';
      const salaryTarget = Math.max(0, parseFloat(body.net) || 0);
      const role = clean(body.role, 20);
      const sector = SECTORS[clean(body.sector, 40).toLowerCase()] ? clean(body.sector, 40).toLowerCase() : 'medical';
      const hireDate = toIsoDate(body.joining_date) || new Date().toISOString().slice(0, 10);
      const month = Math.min(12, Math.max(1, parseInt(body.month, 10) || new Date().getMonth() + 1));
      const year = Math.min(2100, Math.max(2000, parseInt(body.year, 10) || new Date().getFullYear()));

      const fail = async (msg) => {
        const sectorDefault = await facilitySector(pool, fid);
        await ensurePresetRoles(pool, sectorDefault);
        const roles = orderRolesForSector(await loadRoles(pool), sectorDefault);
        return renderNew(res, {
          status: 400,
          roles,
          defaultSector: sectorDefault,
          form: body,
          error: msg,
        });
      };

      if (!first || !last) return fail('First name and last name are required.');
      if (!role) return fail('Select the employee role — it drives the statutory allowances.');
      if (salaryTarget <= 0) {
        return fail(`Enter a ${basis} monthly salary greater than zero.`);
      }

      // ── Pay profile + statutory deductions from the chosen salary basis ─────
      const settings = await loadAllowanceSettings(pool, fid, sector);
      const roleMap = await loadRoleTitleMap(pool);
      const compute = basis === 'gross' ? computeFromGross : computeFromNet;
      const comp = await compute(pool, fid, year, salaryTarget, {
        role,
        roleTitle: resolveRoleTitle(role, roleMap),
        hireDate,
        settings,
        isSpecialist: String(body.is_specialist || '') === '1',
      });

      const saved = await saveOnboardedEmployee(pool, {
        fid,
        first,
        last,
        body,
        role,
        sector,
        hireDate,
        comp,
        year,
        month,
      });
      const employeeId = saved.employeeId;
      const recordId = saved.recordId;
      const warning = saved.warning;

      const q = new URLSearchParams();
      q.set(
        'msg',
        `Employee ${first} ${last} created from ${basis} XAF ${salaryTarget.toLocaleString('fr-FR')} ` +
          `(gross XAF ${comp.gross.toLocaleString('fr-FR')}` +
          `${comp.net != null ? `, net XAF ${comp.net.toLocaleString('fr-FR')}` : ''}).`
      );
      if (recordId) q.set('record', String(recordId));
      if (warning) q.set('err', warning);
      return res.redirect(`/payroll/employees/${employeeId}?${q.toString()}`);
    } catch (e) {
      console.error('[employees/new]', e.message);
      const sectorDefault = await facilitySector(pool, fid);
      await ensurePresetRoles(pool, sectorDefault);
      const roles = orderRolesForSector(await loadRoles(pool), sectorDefault);
      return renderNew(res, {
        status: 500,
        roles,
        defaultSector: sectorDefault,
        form: body,
        error: e.message,
      });
    }
  });

  /** Create a role that is not in the list yet, from the onboarding form. */
  app.post('/payroll/roles', requireAuth, guard, async (req, res) => {
    const title = clean((req.body || {}).title || (req.body || {}).name, 120);
    if (title.length < 2) {
      return res.status(400).json({ ok: false, error: 'Enter a role name of at least 2 characters.' });
    }
    try {
      const [[existing]] = await pool.query(
        'SELECT CAST(role AS UNSIGNED) AS id, title FROM tbl_role WHERE LOWER(title) = LOWER(?) ORDER BY id LIMIT 1',
        [title]
      );
      if (existing && Number(existing.id) > 0) {
        return res.json({ ok: true, role: { id: Number(existing.id), title: clean(existing.title, 120) || title } });
      }
      const [[maxRow]] = await pool.query(
        'SELECT COALESCE(MAX(CAST(role AS UNSIGNED)), 0) AS maxId FROM tbl_role'
      );
      const nextId = Math.max(111, Number(maxRow && maxRow.maxId) + 1);
      await pool.query('INSERT INTO tbl_role (role, title) VALUES (?, ?)', [String(nextId), title]);
      return res.json({ ok: true, role: { id: nextId, title } });
    } catch (e) {
      console.error('[payroll/roles]', e.message);
      return res.status(500).json({ ok: false, error: 'The role could not be saved. Try again.' });
    }
  });

  app.get('/payroll/employees/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    if (id < 1) return res.status(404).render('error', { title: 'Not found', message: 'Employee not found.', status: 404 });
    const fid = facilityId(req);
    const viewerId = parseInt((req.session.user && req.session.user.id), 10) || 0;
    if (viewerId !== id && !canManage(req)) {
      return res.status(403).render('error', {
        title: 'Forbidden',
        message: 'You can only view your own payroll record.',
        status: 403,
      });
    }
    try {
      await ensureHrPayrollSchema(pool);
      await ensureEmployeeHrSchema(pool);

      const [[employee]] = await pool.query(
        `SELECT id, first_name, last_name, username, employee_id, emailid, phone, gender, dob,
                joining_date, role, status, primary_department, job_title, cnps_number, tax_niu,
                nic_number, bank_name, bank_account_no, address
         FROM tbl_employee WHERE id = ? LIMIT 1`,
        [id]
      );
      if (!employee) return res.status(404).render('error', { title: 'Not found', message: 'Employee not found.', status: 404 });

      const roleMap = await loadRoleTitleMap(pool);
      const roleTitle = resolveRoleTitle(employee.role, roleMap);

      const [[profile]] = await pool
        .query('SELECT * FROM tbl_hms_pay_profile WHERE facility_id = ? AND employee_id = ? LIMIT 1', [fid, id])
        .catch(() => [[null]]);

      const [records] = await pool
        .query(
          `SELECT * FROM tbl_hms_payroll_record
           WHERE facility_id = ? AND employee_id = ?
           ORDER BY year DESC, month DESC LIMIT 12`,
          [fid, id]
        )
        .catch(() => [[]]);

      const hrYear = new Date().getFullYear();
      const [[leaveBalance]] = await pool
        .query(
          `SELECT balance FROM tbl_hms_leave_balance
           WHERE facility_id = ? AND employee_id = ? AND leave_type = 'annual' AND year = ? LIMIT 1`,
          [fid, id, hrYear]
        )
        .catch(() => [[null]]);
      const [[leavePending]] = await pool
        .query(
          `SELECT COUNT(*) AS c, COALESCE(SUM(days_requested), 0) AS days
           FROM tbl_hms_leave_request
           WHERE facility_id = ? AND employee_id = ? AND status = 'pending'`,
          [fid, id]
        )
        .catch(() => [[{ c: 0, days: 0 }]]);
      const [recentAttendance] = await pool
        .query(
          `SELECT att_date, status, check_in_time, check_out_time FROM tbl_hms_attendance
           WHERE facility_id = ? AND employee_id = ? ORDER BY att_date DESC LIMIT 5`,
          [fid, id]
        )
        .catch(() => [[]]);

      let comp = null;
      let compError = null;
      if (profile && Number(profile.basic_salary) > 0) {
        try {
          const sector = clean(profile.sector, 40).toLowerCase() || 'medical';
          const settings = await loadAllowanceSettings(pool, fid, SECTORS[sector] ? sector : 'medical');
          comp = await computeFromProfile(pool, fid, new Date().getFullYear(), profile, {
            role: employee.role,
            roleTitle,
            hireDate: resolveHireDate(employee.joining_date, profile.hire_date),
            settings,
            nightShifts: Number(profile.night_shifts_per_month) || 0,
            onCallShifts: Number(profile.on_call_per_month) || 0,
            isSpecialist: Number(profile.is_specialist) === 1,
          });
        } catch (e) {
          compError = e.message;
        }
      }

      res.render('employee-detail', {
        title: `${employee.first_name} ${employee.last_name} — Zaizens Payroll`,
        employee,
        profile,
        roleTitle,
        comp,
        compError,
        records: records || [],
        leaveBalance: leaveBalance ? Number(leaveBalance.balance) || 0 : null,
        leavePendingCount: Number(leavePending && leavePending.c) || 0,
        leavePendingDays: Number(leavePending && leavePending.days) || 0,
        recentAttendance: recentAttendance || [],
        hrYear,
        months: MONTHS,
        flash: req.query.msg || null,
        error: req.query.err || null,
        highlightRecordId: parseInt(req.query.record, 10) || 0,
      });
    } catch (e) {
      console.error('[employees/:id]', e.message);
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });
};
