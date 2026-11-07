'use strict';

/**
 * Leave policy, balance, calendar and clock helpers.
 *
 * The legacy leave module stored one annual number per employee and counted
 * inclusive calendar days.  This module centralises the richer rules so the
 * request, approval, attendance and reporting routes cannot drift apart.
 */

const DEFAULT_TYPES = [
  { code: 'annual', label: 'Annual leave', paid: 1, balance_tracked: 1, unit: 'day', requires_document: 0, days: 18, sort: 10 },
  { code: 'sick', label: 'Sick leave', paid: 1, balance_tracked: 1, unit: 'day', requires_document: 1, days: 10, sort: 20 },
  { code: 'unpaid', label: 'Unpaid leave', paid: 0, balance_tracked: 0, unit: 'day', requires_document: 0, days: 0, sort: 30 },
  { code: 'permission', label: 'Permission', paid: 1, balance_tracked: 1, unit: 'hour', requires_document: 0, days: 5, sort: 40 },
  { code: 'maternity', label: 'Maternity leave', paid: 1, balance_tracked: 0, unit: 'day', requires_document: 1, days: 90, sort: 50 },
  { code: 'paternity', label: 'Paternity leave', paid: 1, balance_tracked: 0, unit: 'day', requires_document: 1, days: 14, sort: 60 },
  { code: 'compassionate', label: 'Compassionate leave', paid: 1, balance_tracked: 1, unit: 'day', requires_document: 1, days: 5, sort: 70 },
  { code: 'study', label: 'Study leave', paid: 1, balance_tracked: 1, unit: 'day', requires_document: 1, days: 10, sort: 80 },
  { code: 'other', label: 'Other leave', paid: 0, balance_tracked: 0, unit: 'day', requires_document: 0, days: 0, sort: 90 },
];

const DEFAULT_POLICIES = {
  annual: { accrual: 'annual', max_run: 30, notice: 0, carry: 10, negative: 0, levels: 1 },
  sick: { accrual: 'annual', max_run: 30, notice: 0, carry: 0, negative: 0, levels: 1 },
  unpaid: { accrual: 'none', max_run: 90, notice: 0, carry: 0, negative: 0, levels: 1 },
  permission: { accrual: 'annual', max_run: 2, notice: 0, carry: 0, negative: 0, levels: 1 },
  maternity: { accrual: 'none', max_run: 120, notice: 0, carry: 0, negative: 0, levels: 1 },
  paternity: { accrual: 'none', max_run: 30, notice: 0, carry: 0, negative: 0, levels: 1 },
  compassionate: { accrual: 'annual', max_run: 15, notice: 0, carry: 0, negative: 0, levels: 1 },
  study: { accrual: 'annual', max_run: 60, notice: 7, carry: 0, negative: 0, levels: 1 },
  other: { accrual: 'none', max_run: 30, notice: 0, carry: 0, negative: 0, levels: 1 },
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

function todayIso() {
  return isoDate(new Date());
}

function parseDate(value) {
  const iso = isoDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(value, days) {
  const d = parseDate(value);
  if (!d) return null;
  d.setDate(d.getDate() + Number(days || 0));
  return isoDate(d);
}

function parseTimeMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function minutesToTime(minutes) {
  const n = Math.max(0, Math.min(1439, Math.round(Number(minutes) || 0)));
  return `${pad2(Math.floor(n / 60))}:${pad2(n % 60)}:00`;
}

function dateRange(start, end) {
  const a = parseDate(start);
  const b = parseDate(end);
  if (!a || !b || b < a) return [];
  const out = [];
  const d = new Date(a.getTime());
  while (d <= b) {
    out.push(isoDate(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function workdaySet(value) {
  const days = String(value || '1,2,3,4,5')
    .split(',')
    .map((n) => parseInt(n, 10))
    .filter((n) => n >= 0 && n <= 6);
  return new Set(days.length ? days : [1, 2, 3, 4, 5]);
}

async function safeAlter(pool, sql) {
  try {
    await pool.query(sql);
  } catch (e) {
    const msg = String(e.message || '');
    if (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060 || /Duplicate column/i.test(msg)) return;
    if (e.code === 'ER_DUP_KEYNAME' || e.errno === 1061 || /Duplicate key name/i.test(msg)) return;
    console.warn('[leaveSystem]', msg);
  }
}

async function ensureLeaveSystemSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_leave_type (
      id INT NOT NULL AUTO_INCREMENT,
      facility_id INT NOT NULL,
      code VARCHAR(32) NOT NULL,
      label VARCHAR(120) NOT NULL,
      paid TINYINT(1) NOT NULL DEFAULT 1,
      balance_tracked TINYINT(1) NOT NULL DEFAULT 1,
      unit VARCHAR(16) NOT NULL DEFAULT 'day',
      requires_document TINYINT(1) NOT NULL DEFAULT 0,
      active TINYINT(1) NOT NULL DEFAULT 1,
      sort_order SMALLINT NOT NULL DEFAULT 99,
      PRIMARY KEY (id),
      UNIQUE KEY uq_hms_leave_type (facility_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_leave_policy (
      id INT NOT NULL AUTO_INCREMENT,
      facility_id INT NOT NULL,
      leave_type VARCHAR(32) NOT NULL,
      annual_days DECIMAL(6,2) NOT NULL DEFAULT 0,
      accrual_method VARCHAR(16) NOT NULL DEFAULT 'annual',
      prorate TINYINT(1) NOT NULL DEFAULT 1,
      carryover_max DECIMAL(6,2) NOT NULL DEFAULT 0,
      expiry_months SMALLINT NOT NULL DEFAULT 0,
      max_consecutive_days DECIMAL(6,2) NOT NULL DEFAULT 0,
      notice_days SMALLINT NOT NULL DEFAULT 0,
      negative_balance_allowed TINYINT(1) NOT NULL DEFAULT 0,
      approval_levels TINYINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_hms_leave_policy (facility_id, leave_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_leave_ledger (
      id INT NOT NULL AUTO_INCREMENT,
      facility_id INT NOT NULL,
      employee_id INT NOT NULL,
      leave_type VARCHAR(32) NOT NULL,
      leave_year SMALLINT NOT NULL,
      entry_date DATE NOT NULL,
      entry_type VARCHAR(24) NOT NULL,
      days DECIMAL(6,2) NOT NULL DEFAULT 0,
      request_id INT NULL,
      note VARCHAR(500) NULL,
      created_by INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_hms_leave_ledger_emp (facility_id, employee_id, leave_type, leave_year)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_leave_request_day (
      id INT NOT NULL AUTO_INCREMENT,
      request_id INT NOT NULL,
      leave_date DATE NOT NULL,
      leave_year SMALLINT NOT NULL,
      days DECIMAL(6,2) NOT NULL DEFAULT 0,
      minutes INT NOT NULL DEFAULT 0,
      is_working_day TINYINT(1) NOT NULL DEFAULT 1,
      holiday_name VARCHAR(120) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_hms_leave_req_day (request_id, leave_date),
      KEY idx_hms_leave_day_year (leave_year, leave_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_leave_approval (
      id INT NOT NULL AUTO_INCREMENT,
      request_id INT NOT NULL,
      step TINYINT NOT NULL DEFAULT 1,
      approver_id INT NULL,
      action VARCHAR(24) NOT NULL,
      comment VARCHAR(1000) NULL,
      acted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_hms_leave_approval_req (request_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_leave_attachment (
      id INT NOT NULL AUTO_INCREMENT,
      request_id INT NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_path VARCHAR(500) NOT NULL,
      mime_type VARCHAR(120) NULL,
      uploaded_by INT NULL,
      uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_hms_leave_attachment_req (request_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_leave_notification (
      id INT NOT NULL AUTO_INCREMENT,
      facility_id INT NOT NULL,
      employee_id INT NOT NULL,
      title VARCHAR(160) NOT NULL,
      body VARCHAR(1000) NOT NULL DEFAULT '',
      link VARCHAR(255) NOT NULL DEFAULT '',
      read_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_hms_leave_notice_emp (facility_id, employee_id, read_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_attendance_punch (
      id INT NOT NULL AUTO_INCREMENT,
      facility_id INT NOT NULL,
      employee_id INT NOT NULL,
      punch_date DATE NOT NULL,
      punched_at DATETIME NOT NULL,
      direction VARCHAR(8) NOT NULL,
      source VARCHAR(24) NOT NULL DEFAULT 'web',
      ip VARCHAR(64) NULL,
      device VARCHAR(120) NULL,
      note VARCHAR(500) NULL,
      created_by INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_hms_punch_emp_day (facility_id, employee_id, punch_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_attendance_audit (
      id INT NOT NULL AUTO_INCREMENT,
      facility_id INT NOT NULL,
      employee_id INT NOT NULL,
      att_date DATE NOT NULL,
      actor_id INT NULL,
      action VARCHAR(24) NOT NULL,
      old_status VARCHAR(24) NULL,
      new_status VARCHAR(24) NULL,
      old_in TIME NULL,
      old_out TIME NULL,
      new_in TIME NULL,
      new_out TIME NULL,
      reason VARCHAR(500) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_hms_att_audit (facility_id, employee_id, att_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tbl_hms_work_schedule (
      id INT NOT NULL AUTO_INCREMENT,
      facility_id INT NOT NULL,
      name VARCHAR(120) NOT NULL DEFAULT 'Default schedule',
      start_time TIME NOT NULL DEFAULT '08:00:00',
      end_time TIME NOT NULL DEFAULT '17:00:00',
      break_minutes SMALLINT NOT NULL DEFAULT 0,
      grace_minutes SMALLINT NOT NULL DEFAULT 10,
      work_days VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5',
      active TINYINT(1) NOT NULL DEFAULT 1,
      PRIMARY KEY (id),
      UNIQUE KEY uq_hms_work_schedule_fac (facility_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  for (const [column, definition] of [
    ['manager_id', 'INT NULL DEFAULT NULL'],
    ['employment_type', "VARCHAR(40) NOT NULL DEFAULT 'permanent'"],
    ['grade', 'VARCHAR(40) NULL DEFAULT NULL'],
    ['probation_end', 'DATE NULL DEFAULT NULL'],
    ['termination_date', 'DATE NULL DEFAULT NULL'],
    ['work_schedule_id', 'INT NULL DEFAULT NULL'],
  ]) {
    await safeAlter(pool, `ALTER TABLE tbl_employee ADD COLUMN ${column} ${definition}`);
  }

  for (const [column, definition] of [
    ['request_no', 'VARCHAR(32) NULL DEFAULT NULL'],
    ['duration_unit', "VARCHAR(16) NOT NULL DEFAULT 'day'"],
    ['start_time', 'TIME NULL DEFAULT NULL'],
    ['end_time', 'TIME NULL DEFAULT NULL'],
    ['half_day_period', 'VARCHAR(16) NULL DEFAULT NULL'],
    ['total_hours', 'DECIMAL(6,2) NULL DEFAULT NULL'],
    ['manager_id', 'INT NULL DEFAULT NULL'],
    ['current_step', 'TINYINT NOT NULL DEFAULT 1'],
    ['submitted_at', 'DATETIME NULL DEFAULT NULL'],
    ['approved_at', 'DATETIME NULL DEFAULT NULL'],
    ['rejected_at', 'DATETIME NULL DEFAULT NULL'],
    ['rejection_reason', 'VARCHAR(1000) NULL DEFAULT NULL'],
    ['cancelled_at', 'DATETIME NULL DEFAULT NULL'],
    ['cancelled_by', 'INT NULL DEFAULT NULL'],
    ['attachment_name', 'VARCHAR(255) NULL DEFAULT NULL'],
    ['attachment_path', 'VARCHAR(500) NULL DEFAULT NULL'],
    ['policy_snapshot', 'TEXT NULL DEFAULT NULL'],
    ['updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
  ]) {
    await safeAlter(pool, `ALTER TABLE tbl_hms_leave_request ADD COLUMN ${column} ${definition}`);
  }

  for (const [column, definition] of [
    ['carried_days', 'DECIMAL(6,2) NOT NULL DEFAULT 0'],
    ['adjusted_days', 'DECIMAL(6,2) NOT NULL DEFAULT 0'],
    ['encashed_days', 'DECIMAL(6,2) NOT NULL DEFAULT 0'],
  ]) {
    await safeAlter(pool, `ALTER TABLE tbl_hms_leave_balance ADD COLUMN ${column} ${definition}`);
  }

  for (const [column, definition] of [
    ['leave_request_id', 'INT NULL DEFAULT NULL'],
    ['source', "VARCHAR(24) NOT NULL DEFAULT 'manual'"],
    ['scheduled_in', 'TIME NULL DEFAULT NULL'],
    ['scheduled_out', 'TIME NULL DEFAULT NULL'],
    ['worked_minutes', 'INT NOT NULL DEFAULT 0'],
    ['late_minutes', 'INT NOT NULL DEFAULT 0'],
    ['early_minutes', 'INT NOT NULL DEFAULT 0'],
    ['overtime_minutes', 'INT NOT NULL DEFAULT 0'],
    ['override_reason', 'VARCHAR(500) NULL DEFAULT NULL'],
    ['updated_by', 'INT NULL DEFAULT NULL'],
    ['updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
    ['locked', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ]) {
    await safeAlter(pool, `ALTER TABLE tbl_hms_attendance ADD COLUMN ${column} ${definition}`);
  }

  for (const [column, definition] of [
    ['unpaid_leave_days', 'DECIMAL(6,2) NOT NULL DEFAULT 0'],
    ['unpaid_leave_deduction', 'DECIMAL(14,2) NOT NULL DEFAULT 0'],
    ['attendance_deduction', 'DECIMAL(14,2) NOT NULL DEFAULT 0'],
    ['absence_days', 'DECIMAL(6,2) NOT NULL DEFAULT 0'],
    ['absence_deduction', 'DECIMAL(14,2) NOT NULL DEFAULT 0'],
    ['late_minutes', 'INT NOT NULL DEFAULT 0'],
    ['late_deduction', 'DECIMAL(14,2) NOT NULL DEFAULT 0'],
    ['overtime_minutes', 'INT NOT NULL DEFAULT 0'],
    ['overtime_amount', 'DECIMAL(14,2) NOT NULL DEFAULT 0'],
  ]) {
    await safeAlter(pool, `ALTER TABLE tbl_hms_payroll_record ADD COLUMN ${column} ${definition}`);
  }

  await require('./attendancePolicy').ensureAttendancePolicySchema(pool);

  const fid = 1;
  for (const type of DEFAULT_TYPES) {
    await pool.query(
      `INSERT IGNORE INTO tbl_hms_leave_type
        (facility_id, code, label, paid, balance_tracked, unit, requires_document, active, sort_order)
       VALUES (?,?,?,?,?,?,?,1,?)`,
      [fid, type.code, type.label, type.paid, type.balance_tracked, type.unit, type.requires_document, type.sort]
    );
    const p = DEFAULT_POLICIES[type.code] || DEFAULT_POLICIES.other;
    await pool.query(
      `INSERT IGNORE INTO tbl_hms_leave_policy
        (facility_id, leave_type, annual_days, accrual_method, prorate, carryover_max,
         expiry_months, max_consecutive_days, notice_days, negative_balance_allowed, approval_levels)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [fid, type.code, type.days, p.accrual, 1, p.carry, 0, p.max_run, p.notice, p.negative, p.levels]
    );
  }
  await pool.query(
    `INSERT IGNORE INTO tbl_hms_work_schedule
      (facility_id, name, start_time, end_time, break_minutes, grace_minutes, work_days)
     VALUES (1, 'Default schedule', '08:00:00', '17:00:00', 0, 10, '1,2,3,4,5')`
  ).catch(() => {});
}

async function loadLeaveTypes(pool, facilityId, activeOnly = true) {
  const [rows] = await pool.query(
    `SELECT * FROM tbl_hms_leave_type
      WHERE facility_id = ? ${activeOnly ? 'AND active = 1' : ''}
      ORDER BY sort_order, label`,
    [Math.max(1, parseInt(facilityId, 10) || 1)]
  ).catch(() => [[]]);
  return rows || [];
}

async function loadPolicies(pool, facilityId) {
  const [rows] = await pool.query(
    'SELECT * FROM tbl_hms_leave_policy WHERE facility_id = ?',
    [Math.max(1, parseInt(facilityId, 10) || 1)]
  ).catch(() => [[]]);
  const map = {};
  for (const row of rows || []) map[String(row.leave_type)] = row;
  return map;
}

function leaveTypeMap(types) {
  const map = {};
  for (const type of types || []) map[String(type.code)] = type;
  return map;
}

async function loadHolidaySet(pool, facilityId, from, to) {
  const startYear = (parseDate(from) || new Date()).getFullYear();
  const endYear = (parseDate(to) || new Date()).getFullYear();
  const [rows] = await pool.query(
    'SELECT holiday_name, holiday_date, is_recurring FROM tbl_hms_holiday WHERE facility_id = ?',
    [Math.max(1, parseInt(facilityId, 10) || 1)]
  ).catch(() => [[]]);
  const set = new Map();
  for (const row of rows || []) {
    const base = parseDate(row.holiday_date);
    if (!base) continue;
    if (Number(row.is_recurring) === 1) {
      for (let year = startYear - 1; year <= endYear + 1; year += 1) {
        const d = new Date(year, base.getMonth(), base.getDate(), 12, 0, 0);
        if (d.getMonth() !== base.getMonth()) continue;
        const iso = isoDate(d);
        if (iso >= from && iso <= to) set.set(iso, row.holiday_name || 'Public holiday');
      }
    } else {
      const iso = isoDate(base);
      if (iso >= from && iso <= to) set.set(iso, row.holiday_name || 'Public holiday');
    }
  }
  return set;
}

function workingDates(start, end, holidays, workDays) {
  const holidaySet = holidays instanceof Map ? holidays : new Map();
  const allowed = workDays instanceof Set ? workDays : new Set([1, 2, 3, 4, 5]);
  return dateRange(start, end).filter((iso) => {
    const d = parseDate(iso);
    return d && allowed.has(d.getDay()) && !holidaySet.has(iso);
  });
}

function calculateDuration({ start, end, unit, startTime, endTime, halfDayPeriod, holidays, workDays }) {
  const dates = workingDates(start, end, holidays, workDays);
  if (!dates.length) return { ok: false, error: 'The selected dates contain no working days.', days: 0, dates: [] };
  if (String(unit) === 'hour') {
    if (dates.length !== 1 || isoDate(start) !== isoDate(end)) {
      return { ok: false, error: 'Hourly leave and permission must be within one day.', days: 0, dates: [] };
    }
    const from = parseTimeMinutes(startTime);
    const to = parseTimeMinutes(endTime);
    if (from == null || to == null || to <= from) {
      return { ok: false, error: 'Enter a valid start and end time.', days: 0, dates: [] };
    }
    const minutes = to - from;
    return { ok: true, days: Math.round((minutes / 480) * 100) / 100, minutes, dates, rows: [{ date: dates[0], days: Math.round((minutes / 480) * 100) / 100, minutes }] };
  }
  const half = String(halfDayPeriod || '') === 'am' || String(halfDayPeriod || '') === 'pm';
  const days = half ? dates.length * 0.5 : dates.length;
  return {
    ok: true,
    days,
    minutes: half ? 240 * dates.length : 480 * dates.length,
    dates,
    rows: dates.map((date) => ({ date, days: half ? 0.5 : 1, minutes: half ? 240 : 480 })),
  };
}

async function ensureEmployeeBalances(pool, facilityId, employeeId, year) {
  const fid = Math.max(1, parseInt(facilityId, 10) || 1);
  const y = Math.max(2000, Math.min(2100, parseInt(year, 10) || new Date().getFullYear()));
  const [[employee]] = await pool.query(
    'SELECT id, joining_date, manager_id, work_schedule_id, employment_type, probation_end FROM tbl_employee WHERE id = ? LIMIT 1',
    [employeeId]
  ).catch(() => [[null]]);
  const types = await loadLeaveTypes(pool, fid, true);
  const policies = await loadPolicies(pool, fid);
  const [[schedule]] = await pool.query(
    'SELECT * FROM tbl_hms_work_schedule WHERE facility_id = ? AND active = 1 ORDER BY id LIMIT 1',
    [fid]
  ).catch(() => [[null]]);
  for (const type of types) {
    if (!Number(type.balance_tracked)) continue;
    const [[existing]] = await pool.query(
      'SELECT id, balance FROM tbl_hms_leave_balance WHERE facility_id = ? AND employee_id = ? AND leave_type = ? AND year = ? LIMIT 1',
      [fid, employeeId, type.code, y]
    ).catch(() => [[null]]);
    if (existing) continue;
    const policy = policies[String(type.code)] || {};
    let entitlement = Number(policy.annual_days) || 0;
    const join = employee && parseDate(employee.joining_date);
    if (policy.prorate && join && join.getFullYear() === y) {
      entitlement = Math.round(entitlement * ((12 - join.getMonth()) / 12) * 100) / 100;
    }
    if (join && join.getFullYear() > y) entitlement = 0;
    await pool.query(
      `INSERT INTO tbl_hms_leave_balance
        (facility_id, employee_id, leave_type, year, balance, carried_days, adjusted_days, encashed_days)
       VALUES (?,?,?,?,?,0,0,0)`,
      [fid, employeeId, type.code, y, entitlement]
    ).catch(() => {});
    await pool.query(
      `INSERT INTO tbl_hms_leave_ledger
        (facility_id, employee_id, leave_type, leave_year, entry_date, entry_type, days, note, created_by)
       VALUES (?,?,?,?,?,?,?,? ,?)`,
      [fid, employeeId, type.code, y, todayIso(), 'accrual', entitlement, `Opening entitlement for ${y}`, null]
    ).catch(() => {});
  }
  return { employee, schedule, types, policies };
}

async function getBalancesForEmployee(pool, facilityId, employeeId, year) {
  const fid = Math.max(1, parseInt(facilityId, 10) || 1);
  const y = Math.max(2000, Math.min(2100, parseInt(year, 10) || new Date().getFullYear()));
  const setup = await ensureEmployeeBalances(pool, fid, employeeId, y);
  const [balances] = await pool.query(
    'SELECT * FROM tbl_hms_leave_balance WHERE facility_id = ? AND employee_id = ? AND year = ?',
    [fid, employeeId, y]
  ).catch(() => [[]]);
  const [requests] = await pool.query(
    `SELECT r.id, r.leave_type, r.status, r.start_date, r.end_date, r.days_requested,
            COALESCE(SUM(d.days), 0) AS day_sum
       FROM tbl_hms_leave_request r
       LEFT JOIN tbl_hms_leave_request_day d ON d.request_id = r.id AND d.leave_year = ?
      WHERE r.facility_id = ? AND r.employee_id = ? AND r.status IN ('approved','pending')
      GROUP BY r.id, r.leave_type, r.status, r.start_date, r.end_date, r.days_requested`,
    [y, fid, employeeId]
  ).catch(() => [[]]);
  const usage = {};
  for (const row of requests || []) {
    let days = Number(row.day_sum) || 0;
    if (!days && (parseDate(row.start_date) || {}).getFullYear?.() === y) days = Number(row.days_requested) || 0;
    if (!days) continue;
    if (!usage[row.leave_type]) usage[row.leave_type] = { used: 0, pending: 0 };
    if (String(row.status) === 'approved') usage[row.leave_type].used += days;
    else usage[row.leave_type].pending += days;
  }
  const rows = (setup.types || []).map((type) => {
    const b = (balances || []).find((row) => String(row.leave_type) === String(type.code)) || {};
    const entitled = (Number(b.balance) || 0) + (Number(b.carried_days) || 0) + (Number(b.adjusted_days) || 0) - (Number(b.encashed_days) || 0);
    const agg = usage[String(type.code)] || { used: 0, pending: 0 };
    return {
      leave_type: type.code,
      label: type.label,
      paid: Number(type.paid),
      balance_tracked: Number(type.balance_tracked),
      unit: type.unit,
      entitled,
      used: agg.used,
      pending: agg.pending,
      remaining: Math.round((entitled - agg.used - agg.pending) * 100) / 100,
      balance: Number(b.balance) || 0,
      carried: Number(b.carried_days) || 0,
      adjusted: Number(b.adjusted_days) || 0,
      encashed: Number(b.encashed_days) || 0,
    };
  });
  return { employee: setup.employee, schedule: setup.schedule, types: setup.types, policies: setup.policies, rows };
}

async function getBalancesForAll(pool, facilityId, year) {
  const fid = Math.max(1, parseInt(facilityId, 10) || 1);
  const [staff] = await pool.query(
    'SELECT id, first_name, last_name, employee_id, job_title, primary_department FROM tbl_employee WHERE status = 1 AND (default_facility_id IS NULL OR default_facility_id = ?) ORDER BY last_name, first_name',
    [fid]
  ).catch(() => [[]]);
  const result = [];
  for (const employee of staff || []) {
    const balances = await getBalancesForEmployee(pool, fid, employee.id, year);
    result.push({ ...employee, balances: balances.rows, annual: balances.rows.find((r) => r.leave_type === 'annual') || balances.rows[0] || null });
  }
  return result;
}

async function getLeaveRequest(pool, facilityId, requestId) {
  const [[row]] = await pool.query(
    `SELECT r.*, e.first_name, e.last_name, e.manager_id AS employee_manager_id
       FROM tbl_hms_leave_request r JOIN tbl_employee e ON e.id = r.employee_id
      WHERE r.id = ? AND r.facility_id = ? LIMIT 1`,
    [requestId, facilityId]
  ).catch(() => [[null]]);
  return row || null;
}

function statusLabel(status) {
  const s = String(status || '').toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
}

module.exports = {
  DEFAULT_TYPES,
  ensureLeaveSystemSchema,
  loadLeaveTypes,
  loadPolicies,
  leaveTypeMap,
  loadHolidaySet,
  workingDates,
  calculateDuration,
  ensureEmployeeBalances,
  getBalancesForEmployee,
  getBalancesForAll,
  getLeaveRequest,
  isoDate,
  todayIso,
  addDays,
  parseDate,
  parseTimeMinutes,
  minutesToTime,
  dateRange,
  workdaySet,
  statusLabel,
};