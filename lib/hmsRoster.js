'use strict';

const { formatDayMonth, formatMonthYear } = require('./hmsFormatDate');

/**
 * Shared roster date/grid helpers (nurse + doctor duty rosters).
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseIsoDate(ymd) {
  const s = String(ymd || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map((x) => parseInt(x, 10));
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function toYmd(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/**
 * Normalize DATE/DATETIME from mysql2 for roster keys and comparisons.
 * mysql2 encodes SQL DATE as local-midnight Date (not UTC midnight).
 */
function ymdFromDb(val) {
  if (val == null || val === '') return '';
  if (val instanceof Date) {
    if (!Number.isNaN(val.getTime())) return toYmd(val);
  }
  const s = String(val).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s.slice(0, 10);
}

function addDaysYmd(ymd, days) {
  const dt = parseIsoDate(ymd);
  if (!dt) return ymd;
  dt.setDate(dt.getDate() + days);
  return toYmd(dt);
}

function firstDayOfMonth(ymd) {
  const dt = parseIsoDate(ymd) || new Date();
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-01`;
}

function lastDayOfMonth(ymd) {
  const dt = parseIsoDate(ymd) || new Date();
  const end = new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
  return toYmd(end);
}

function monthKey(ymd) {
  return firstDayOfMonth(ymd).slice(0, 7);
}

function parseView(raw) {
  const v = String(raw || 'day').toLowerCase();
  return v === 'week' || v === 'month' ? v : 'day';
}

function weekStartMonday(ymd) {
  const dt = parseIsoDate(ymd) || new Date();
  const dow = dt.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  dt.setDate(dt.getDate() + diff);
  return toYmd(dt);
}

function buildWeekDays(startYmd) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const ymd = addDaysYmd(startYmd, i);
    const dt = parseIsoDate(ymd);
    out.push({
      ymd,
      dayNum: dt.getDate(),
      weekday: dt.toLocaleDateString('en-GB', { weekday: 'short' }),
      label: formatDayMonth(ymd),
      isWeekend: dt.getDay() === 0 || dt.getDay() === 6,
      isToday: ymd === isoToday(),
    });
  }
  return out;
}

function buildMonthMeta(ymd) {
  const start = firstDayOfMonth(ymd);
  const end = lastDayOfMonth(ymd);
  const startDt = parseIsoDate(start);
  const endDt = parseIsoDate(end);
  const label = formatMonthYear(startDt);
  const prev = new Date(startDt.getFullYear(), startDt.getMonth() - 1, 1);
  const next = new Date(startDt.getFullYear(), startDt.getMonth() + 1, 1);
  return {
    monthKey: start.slice(0, 7),
    start,
    end,
    label,
    prevMonth: `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}`,
    nextMonth: `${next.getFullYear()}-${pad2(next.getMonth() + 1)}`,
    daysInMonth: endDt.getDate(),
  };
}

/** @returns {Array<Array<{ ymd: string, dayNum: number, inMonth: boolean, isToday: boolean, isWeekend: boolean }>>} */
function buildMonthCalendarWeeks(ymd) {
  const meta = buildMonthMeta(ymd);
  const first = parseIsoDate(meta.start);
  const startPad = first.getDay() === 0 ? -6 : 1 - first.getDay();
  const cursor = new Date(first);
  cursor.setDate(cursor.getDate() + startPad);

  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const y = cursor.getFullYear();
      const m = cursor.getMonth();
      const day = cursor.getDate();
      const cellYmd = toYmd(cursor);
      const inMonth = m === first.getMonth() && y === first.getFullYear();
      week.push({
        ymd: cellYmd,
        dayNum: day,
        inMonth,
        isToday: cellYmd === isoToday(),
        isWeekend: cursor.getDay() === 0 || cursor.getDay() === 6,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
    if (w >= 4 && weeks[weeks.length - 1].every((c) => !c.inMonth)) break;
  }
  return weeks;
}

/**
 * @param {Array<object>} rows
 * @param {string} dateField
 * @param {string} typeField
 */
function indexRoster(rows, dateField, typeField) {
  const map = new Map();
  for (const r of rows || []) {
    const empId = parseInt(r.employee_id, 10);
    const d = ymdFromDb(r[dateField]);
    if (!empId || !d) continue;
    map.set(`${empId}|${d}`, String(r[typeField] || 'off'));
  }
  return map;
}

function normalizeRosterRows(rows, dateField) {
  return (rows || []).map((r) => {
    const out = { ...r };
    out[dateField] = ymdFromDb(out[dateField]);
    return out;
  });
}

function shiftCountsByDate(rows, dateField, typeField) {
  const counts = {};
  for (const r of rows || []) {
    const d = r[dateField];
    const t = String(r[typeField] || 'off');
    if (!counts[d]) counts[d] = { day: 0, relay: 0, night: 0, on_duty: 0, off: 0, total: 0 };
    counts[d][t] = (counts[d][t] || 0) + 1;
    counts[d].total += 1;
  }
  return counts;
}

function enrichMonthWeeksDoctor(weeks, doctors, map) {
  return (weeks || []).map((week) =>
    week.map((cell) => {
      const assignments = [];
      for (const d of doctors || []) {
        const duty = map.get(`${parseInt(d.id, 10)}|${cell.ymd}`) || 'off';
        if (duty === 'off') continue;
        assignments.push({
          name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
          duty,
          short: duty === 'on_duty' ? 'OD' : duty === 'night' ? 'OC' : duty,
        });
      }
      return { ...cell, assignments };
    })
  );
}

function enrichMonthWeeksNurse(weeks, nurses, map) {
  return (weeks || []).map((week) =>
    week.map((cell) => {
      const day = [];
      const relay = [];
      const night = [];
      for (const n of nurses || []) {
        const sh = map.get(`${parseInt(n.id, 10)}|${cell.ymd}`) || 'off';
        const name = `${n.first_name || ''} ${n.last_name || ''}`.trim();
        if (sh === 'day') day.push(name);
        else if (sh === 'relay') relay.push(name);
        else if (sh === 'night') night.push(name);
      }
      return { ...cell, shifts: { day, relay, night } };
    })
  );
}

function summarizePeriod(roster, dateField, typeField, view, anchorDate) {
  const v = parseView(view);
  let start = anchorDate;
  let end = anchorDate;
  if (v === 'week') {
    start = weekStartMonday(anchorDate);
    end = addDaysYmd(start, 6);
  } else if (v === 'month') {
    start = firstDayOfMonth(anchorDate);
    end = lastDayOfMonth(anchorDate);
  }
  let day = 0;
  let relay = 0;
  let onDuty = 0;
  let night = 0;
  let off = 0;
  for (const r of roster || []) {
    const d = r[dateField];
    if (d < start || d > end) continue;
    const t = String(r[typeField] || 'off');
    if (t === 'night') night += 1;
    else if (t === 'off') off += 1;
    else if (t === 'day') day += 1;
    else if (t === 'relay') relay += 1;
    else if (t === 'on_duty') onDuty += 1;
  }
  return { day, relay, onDuty, on: onDuty, night, off, start, end };
}

/** Default ward shift windows (editable per assignment on save). */
const NURSE_SHIFT_DEFAULTS = {
  day: { start: '08:00', end: '14:00', icon: 'fa-sun' },
  relay: { start: '14:00', end: '20:00', icon: 'fa-exchange-alt' },
  night: { start: '20:00', end: '08:00', icon: 'fa-moon' },
  off: { start: null, end: null, icon: 'fa-bed' },
};

const NURSE_SHIFT_TYPES = ['day', 'relay', 'night', 'off'];

const DOCTOR_DUTY_TYPES = ['on_duty', 'night', 'off'];

const DOCTOR_SHIFT_DEFAULTS = {
  on_duty: { start: '08:00', end: '17:00' },
  night: { start: '20:00', end: '08:00' },
  off: { start: null, end: null },
};

function normalizeDoctorDutyType(raw) {
  const t = String(raw || 'off').toLowerCase();
  return DOCTOR_DUTY_TYPES.includes(t) ? t : 'off';
}

function doctorDutyTimes(type, startRaw, endRaw) {
  const duty = normalizeDoctorDutyType(type);
  const defs = DOCTOR_SHIFT_DEFAULTS[duty] || DOCTOR_SHIFT_DEFAULTS.off;
  if (duty === 'off') return { start_time: null, end_time: null };
  return {
    start_time: normalizeTimeInput(startRaw, defs.start),
    end_time: normalizeTimeInput(endRaw, defs.end),
  };
}

function indexDoctorRosterDetails(rows, dateField, typeField) {
  const map = new Map();
  for (const r of rows || []) {
    const empId = parseInt(r.employee_id, 10);
    const d = ymdFromDb(r[dateField]);
    if (!empId || !d) continue;
    const type = normalizeDoctorDutyType(r[typeField]);
    const times = doctorDutyTimes(type, r.start_time, r.end_time);
    map.set(`${empId}|${d}`, {
      type,
      ...times,
      consultation_room_id: parseInt(r.consultation_room_id, 10) || null,
      department: String(r.department || '').trim() || null,
    });
  }
  return map;
}

function normalizeNurseShiftType(raw) {
  const t = String(raw || 'off').toLowerCase();
  return NURSE_SHIFT_TYPES.includes(t) ? t : 'off';
}

function timeFromDb(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return `${pad2(parseInt(m[1], 10))}:${m[2]}`;
  return null;
}

function normalizeTimeInput(raw, fallback) {
  const t = timeFromDb(raw);
  if (t) return t;
  return fallback || null;
}

function nurseShiftTimes(type, startRaw, endRaw) {
  const shift = normalizeNurseShiftType(type);
  const defs = NURSE_SHIFT_DEFAULTS[shift] || NURSE_SHIFT_DEFAULTS.off;
  if (shift === 'off') return { start_time: null, end_time: null };
  return {
    start_time: normalizeTimeInput(startRaw, defs.start),
    end_time: normalizeTimeInput(endRaw, defs.end),
  };
}

function indexNurseRosterDetails(rows, dateField, typeField) {
  const map = new Map();
  for (const r of rows || []) {
    const empId = parseInt(r.employee_id, 10);
    const d = ymdFromDb(r[dateField]);
    if (!empId || !d) continue;
    const type = normalizeNurseShiftType(r[typeField]);
    const times = nurseShiftTimes(type, r.start_time, r.end_time);
    map.set(`${empId}|${d}`, { type, ...times });
  }
  return map;
}

let nurseRosterSchemaReady = false;

async function ensureNurseRosterSchema(pool) {
  if (nurseRosterSchemaReady) return;
  try {
    await pool.query(
      `ALTER TABLE tbl_nurse_shift_schedule
       MODIFY shift_type ENUM('off','day','relay','night') NOT NULL DEFAULT 'off'`
    );
  } catch (_) { /* enum may already include relay */ }
  try {
    await pool.query(
      'ALTER TABLE tbl_nurse_shift_schedule ADD COLUMN start_time TIME NULL DEFAULT NULL'
    );
  } catch (_) { /* column exists */ }
  try {
    await pool.query(
      'ALTER TABLE tbl_nurse_shift_schedule ADD COLUMN end_time TIME NULL DEFAULT NULL'
    );
  } catch (_) { /* column exists */ }
  nurseRosterSchemaReady = true;
}

/**
 * Production HMS tables (PHP parity) — not tbl_*_roster stubs.
 *
 * `staffRole` is the LEGACY numeric role ID kept for backwards-compat.
 * `staffTitleRegexp` lets us also match facilities that use modern custom
 * role IDs (e.g. 100=Doctor, 101=Nurse, 103=Midwife) — the staff fetcher ORs
 * the title regex against tbl_role.title so the roster is populated either way.
 * Midwives are intentionally rostered with nurses (shared night/day rotation).
 */
const ROSTER_KIND = {
  nurse: {
    table: 'tbl_nurse_shift_schedule',
    dateField: 'work_date',
    typeField: 'shift_type',
    staffRole: 7,
    staffTitleRegexp: 'Nurse|Infirm|Midwife|Sage[- ]?[Ff]emme',
  },
  doctor: {
    table: 'tbl_doctor_duty_schedule',
    dateField: 'duty_date',
    typeField: 'duty_type',
    staffRole: 2,
    staffTitleRegexp: 'Doctor|Physician|M[eé]decin|Specialist|Sp[eé]cialiste',
  },
};

function rosterKindConfig(kind) {
  return ROSTER_KIND[kind === 'nurse' ? 'nurse' : 'doctor'];
}

function resolveFacilityId(req) {
  const u = (req && req.session && req.session.user) || {};
  const fid = u.facility_id ?? u.facilityId ?? (req.session && req.session.facilityId);
  const n = parseInt(fid, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

async function fetchRosterRows(pool, kind, facilityId, view, date) {
  const cfg = rosterKindConfig(kind);
  const df = cfg.dateField;
  const v = parseView(view);
  const anchor = String(date || isoToday()).slice(0, 10);

  if (v === 'day') {
    const [rows] = await pool.query(
      `SELECT * FROM ${cfg.table} WHERE facility_id = ? AND ${df} = ?`,
      [facilityId, anchor]
    );
    return rows;
  }
  if (v === 'week') {
    const weekStart = weekStartMonday(anchor);
    const [rows] = await pool.query(
      `SELECT * FROM ${cfg.table} WHERE facility_id = ? AND ${df} BETWEEN ? AND DATE_ADD(?, INTERVAL 6 DAY)`,
      [facilityId, weekStart, weekStart]
    );
    return rows;
  }
  const start = firstDayOfMonth(anchor);
  const end = lastDayOfMonth(anchor);
  const [rows] = await pool.query(
    `SELECT * FROM ${cfg.table} WHERE facility_id = ? AND ${df} BETWEEN ? AND ?`,
    [facilityId, start, end]
  );
  return rows;
}

async function saveRosterShifts(pool, kind, facilityId, date, shifts) {
  const cfg = rosterKindConfig(kind);
  const df = cfg.dateField;
  const tf = cfg.typeField;
  const ymd = String(date || '').slice(0, 10);
  for (const empId of Object.keys(shifts || {})) {
    const payload = shifts[empId];
    const shiftType =
      kind === 'nurse' && payload && typeof payload === 'object'
        ? normalizeNurseShiftType(payload.type ?? payload.shift_type ?? payload)
        : kind === 'doctor' && payload && typeof payload === 'object'
          ? normalizeDoctorDutyType(payload.type ?? payload.duty_type ?? payload)
          : String(payload || 'off');
    if (kind === 'nurse') {
      const times = nurseShiftTimes(
        shiftType,
        payload && typeof payload === 'object' ? payload.start_time : null,
        payload && typeof payload === 'object' ? payload.end_time : null
      );
      await pool.query(
        `INSERT INTO ${cfg.table} (facility_id, employee_id, ${df}, ${tf}, start_time, end_time)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ${tf} = VALUES(${tf}),
           start_time = VALUES(start_time),
           end_time = VALUES(end_time)`,
        [facilityId, empId, ymd, shiftType, times.start_time, times.end_time]
      );
    } else {
      const { ensureDoctorDutySchema } = require('./ensureDoctorDutySchema');
      await ensureDoctorDutySchema(pool);
      const duty = normalizeDoctorDutyType(shiftType);
      const payloadObj = payload && typeof payload === 'object' ? payload : {};
      const times = doctorDutyTimes(duty, payloadObj.start_time, payloadObj.end_time);
      const roomId = parseInt(payloadObj.consultation_room_id, 10) || null;
      const dept = String(payloadObj.department || '').trim().slice(0, 120) || null;
      await pool.query(
        `INSERT INTO ${cfg.table} (facility_id, employee_id, ${df}, ${tf}, start_time, end_time, consultation_room_id, department)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ${tf} = VALUES(${tf}),
           start_time = VALUES(start_time),
           end_time = VALUES(end_time),
           consultation_room_id = VALUES(consultation_room_id),
           department = VALUES(department)`,
        [facilityId, empId, ymd, duty, times.start_time, times.end_time, roomId, dept]
      );
    }
  }
}

async function copyRosterDay(pool, kind, facilityId, fromDate, toDate) {
  const cfg = rosterKindConfig(kind);
  const df = cfg.dateField;
  const tf = cfg.typeField;
  if (kind === 'nurse') {
    await pool.query(
      `INSERT INTO ${cfg.table} (facility_id, employee_id, ${df}, ${tf}, start_time, end_time)
       SELECT facility_id, employee_id, ?, ${tf}, start_time, end_time
       FROM ${cfg.table}
       WHERE facility_id = ? AND ${df} = ?
       ON DUPLICATE KEY UPDATE ${tf} = VALUES(${tf}),
         start_time = VALUES(start_time),
         end_time = VALUES(end_time)`,
      [toDate, facilityId, fromDate]
    );
    return;
  }
  const { ensureDoctorDutySchema } = require('./ensureDoctorDutySchema');
  await ensureDoctorDutySchema(pool);
  await pool.query(
    `INSERT INTO ${cfg.table} (facility_id, employee_id, ${df}, ${tf}, start_time, end_time, consultation_room_id, department)
     SELECT facility_id, employee_id, ?, ${tf}, start_time, end_time, consultation_room_id, department
     FROM ${cfg.table}
     WHERE facility_id = ? AND ${df} = ?
     ON DUPLICATE KEY UPDATE ${tf} = VALUES(${tf}),
       start_time = VALUES(start_time),
       end_time = VALUES(end_time),
       consultation_room_id = VALUES(consultation_room_id),
       department = VALUES(department)`,
    [toDate, facilityId, fromDate]
  );
}

/**
 * Count roster-based shifts for one employee inside a calendar month.
 *
 * Nurse night shifts = rows in tbl_nurse_shift_schedule with shift_type='night'.
 * Doctor on-call sessions = rows in tbl_doctor_duty_schedule with duty_type='night'
 * (the doctor roster UI labels this "OC" / On-Call — duty_type='on_duty' is the day shift).
 *
 * Returns counts regardless of which role the employee holds; the allowance engine
 * decides which figure (if any) applies based on each allowance's role filter.
 *
 * @param {*} pool         mysql2/promise pool
 * @param {number} facilityId
 * @param {number} employeeId
 * @param {number} year
 * @param {number} month   1..12
 * @returns {Promise<{nightShifts:number,onCall:number}>}
 */
async function countRosterShiftsForMonth(pool, facilityId, employeeId, year, month) {
  const m = Math.max(1, Math.min(12, parseInt(month, 10) || 1));
  const y = parseInt(year, 10);
  const start = `${y}-${pad2(m)}-01`;
  const end = lastDayOfMonth(start);

  let nightShifts = 0;
  let onCall = 0;

  try {
    const [[nr]] = await pool.query(
      `SELECT COUNT(*) AS c FROM tbl_nurse_shift_schedule
       WHERE facility_id = ? AND employee_id = ? AND shift_type = 'night'
         AND work_date BETWEEN ? AND ?`,
      [facilityId, employeeId, start, end]
    );
    nightShifts = parseInt((nr && nr.c) || 0, 10) || 0;
  } catch (_) { /* table may not exist on fresh installs */ }

  try {
    const [[dr]] = await pool.query(
      `SELECT COUNT(*) AS c FROM tbl_doctor_duty_schedule
       WHERE facility_id = ? AND employee_id = ? AND duty_type = 'night'
         AND duty_date BETWEEN ? AND ?`,
      [facilityId, employeeId, start, end]
    );
    onCall = parseInt((dr && dr.c) || 0, 10) || 0;
  } catch (_) { /* table may not exist on fresh installs */ }

  return { nightShifts, onCall };
}

async function fetchRosterStaff(pool, kind) {
  const cfg = rosterKindConfig(kind);
  const hmsDoctorStaff = kind === 'doctor' ? require('./hmsDoctorStaff') : null;
  try {
    if (hmsDoctorStaff) {
      return hmsDoctorStaff.fetchActiveDoctors(
        pool,
        'e.id, e.first_name, e.last_name, e.primary_department'
      );
    }
    const [rows] = await pool.query(
      `SELECT e.id, e.first_name, e.last_name, e.primary_department
       FROM tbl_employee e
       LEFT JOIN tbl_role r ON CAST(r.role AS UNSIGNED) = CAST(e.role AS UNSIGNED)
       WHERE e.status = 1
         AND CAST(e.role AS UNSIGNED) NOT IN (1, 99)
         AND (CAST(e.role AS UNSIGNED) = ? OR r.title REGEXP ?)
       ORDER BY e.first_name, e.last_name`,
      [cfg.staffRole, cfg.staffTitleRegexp]
    );
    return rows;
  } catch (_) {
    // Fallback to the legacy numeric-only query if tbl_role is missing or REGEXP unsupported.
    const [rows] = await pool.query(
      `SELECT id, first_name, last_name, primary_department
       FROM tbl_employee WHERE role = ? AND status = 1 ORDER BY first_name, last_name`,
      [cfg.staffRole]
    );
    return rows;
  }
}

/**
 * @param {object} opts
 * @param {'doctor'|'nurse'} opts.kind
 */
function buildRosterRenderData(opts) {
  const kind = opts.kind === 'nurse' ? 'nurse' : 'doctor';
  const dateField = opts.dateField;
  const typeField = opts.typeField;
  const view = parseView(opts.view);
  const anchorDate = String(opts.date || isoToday()).slice(0, 10);
  const staff = opts.staff || [];
  const roster = normalizeRosterRows(opts.rosterRows || [], dateField);
  const map = indexRoster(roster, dateField, typeField);

  const weekStart = weekStartMonday(anchorDate);
  const weekDays = buildWeekDays(weekStart);
  const monthMeta = buildMonthMeta(anchorDate);
  let monthWeeks = buildMonthCalendarWeeks(anchorDate);
  if (view === 'month') {
    monthWeeks =
      kind === 'nurse'
        ? enrichMonthWeeksNurse(monthWeeks, staff, map)
        : enrichMonthWeeksDoctor(monthWeeks, staff, map);
  }

  const staffWithWeek = staff.map((person) => {
    const empId = parseInt(person.id, 10);
    const days = weekDays.map((wd) => ({
      ...wd,
      shift: map.get(`${empId}|${wd.ymd}`) || 'off',
    }));
    return { ...person, weekDays: days };
  });

  const staffDayShift = {};
  const staffDayDetails = {};
  if (view === 'day') {
    const nurseDetailMap = kind === 'nurse' ? indexNurseRosterDetails(roster, dateField, typeField) : null;
    const doctorDetailMap = kind === 'doctor' ? indexDoctorRosterDetails(roster, dateField, typeField) : null;
    for (const person of staff) {
      const empId = parseInt(person.id, 10);
      const key = `${empId}|${anchorDate}`;
      if (kind === 'nurse' && nurseDetailMap) {
        const detail = nurseDetailMap.get(key) || { type: 'off', start_time: null, end_time: null };
        staffDayShift[String(person.id)] = detail.type;
        staffDayDetails[String(person.id)] = detail;
      } else if (kind === 'doctor' && doctorDetailMap) {
        const detail = doctorDetailMap.get(key) || {
          type: 'off',
          start_time: null,
          end_time: null,
          consultation_room_id: null,
          department: null,
        };
        staffDayShift[String(person.id)] = detail.type;
        staffDayDetails[String(person.id)] = detail;
      } else {
        const shift = map.get(key) || 'off';
        staffDayShift[String(person.id)] = shift;
      }
    }
  }

  const period = summarizePeriod(roster, dateField, typeField, view, anchorDate);
  const displayDate =
    view === 'month' ? monthMeta.start : view === 'week' ? weekStart : anchorDate;

  let prevNavDate = addDaysYmd(anchorDate, -1);
  let nextNavDate = addDaysYmd(anchorDate, 1);
  if (view === 'week') {
    prevNavDate = addDaysYmd(weekStart, -7);
    nextNavDate = addDaysYmd(weekStart, 7);
  } else if (view === 'month') {
    prevNavDate = `${monthMeta.prevMonth}-01`;
    nextNavDate = `${monthMeta.nextMonth}-01`;
  }

  return {
    view,
    date: anchorDate,
    displayDate,
    weekStart,
    weekDays,
    monthMeta,
    monthWeeks,
    roster,
    map,
    staffWithWeek,
    staffDayShift,
    staffDayDetails,
    period,
    prevNavDate,
    nextNavDate,
    countsByDate: shiftCountsByDate(roster, dateField, typeField),
  };
}

/**
 * express.urlencoded({ extended: false }) leaves shifts as flat keys "shifts[12]".
 * Nurse times: shift_start[12], shift_end[12].
 */
function parseShiftsFromBody(body) {
  if (!body || typeof body !== 'object') return {};
  if (body.shifts && typeof body.shifts === 'object' && !Array.isArray(body.shifts)) {
    return body.shifts;
  }
  const out = {};
  for (const [key, val] of Object.entries(body)) {
    const m = /^shifts\[(\d+)\]$/.exec(key);
    if (m) out[m[1]] = val;
  }
  return out;
}

function parseNurseShiftsFromBody(body) {
  const types = parseShiftsFromBody(body);
  const out = {};
  for (const [empId, type] of Object.entries(types)) {
    const shiftType = normalizeNurseShiftType(type);
    const startKey = `shift_start[${empId}]`;
    const endKey = `shift_end[${empId}]`;
    const times = nurseShiftTimes(shiftType, body[startKey], body[endKey]);
    out[empId] = { type: shiftType, ...times };
  }
  return out;
}

function parseDoctorShiftsFromBody(body) {
  const types = parseShiftsFromBody(body);
  const out = {};
  for (const [empId, type] of Object.entries(types)) {
    const dutyType = normalizeDoctorDutyType(type);
    const startKey = `shift_start[${empId}]`;
    const endKey = `shift_end[${empId}]`;
    const roomKey = `shift_room[${empId}]`;
    const deptKey = `shift_dept[${empId}]`;
    const times = doctorDutyTimes(dutyType, body[startKey], body[endKey]);
    out[empId] = {
      type: dutyType,
      ...times,
      consultation_room_id: parseInt(body[roomKey], 10) || null,
      department: String(body[deptKey] || '').trim().slice(0, 120) || null,
    };
  }
  return out;
}

/** Admin/super (roles 1, 99) may edit all roster rows; others with write may edit self only. */
function filterRosterShiftsForEditor(shifts, editorEmpId, isRosterAdmin) {
  if (isRosterAdmin) return shifts || {};
  const me = parseInt(editorEmpId, 10) || 0;
  if (!me) return {};
  const out = {};
  if (shifts && shifts[String(me)] != null) out[String(me)] = shifts[String(me)];
  return out;
}

function rosterRedirectUrl(basePath, view, date, extra) {
  const q = new URLSearchParams();
  q.set('view', parseView(view));
  if (parseView(view) === 'month') q.set('date', firstDayOfMonth(date));
  else q.set('date', String(date || isoToday()).slice(0, 10));
  if (extra && extra.msg) q.set('msg', extra.msg);
  if (extra && extra.err) q.set('err', extra.err);
  return `${basePath}?${q.toString()}`;
}

module.exports = {
  ROSTER_KIND,
  NURSE_SHIFT_DEFAULTS,
  NURSE_SHIFT_TYPES,
  rosterKindConfig,
  resolveFacilityId,
  fetchRosterRows,
  saveRosterShifts,
  copyRosterDay,
  fetchRosterStaff,
  countRosterShiftsForMonth,
  ensureNurseRosterSchema,
  normalizeNurseShiftType,
  nurseShiftTimes,
  parseNurseShiftsFromBody,
  parseDoctorShiftsFromBody,
  DOCTOR_SHIFT_DEFAULTS,
  DOCTOR_DUTY_TYPES,
  normalizeDoctorDutyType,
  doctorDutyTimes,
  filterRosterShiftsForEditor,
  isoToday,
  parseIsoDate,
  toYmd,
  addDaysYmd,
  firstDayOfMonth,
  lastDayOfMonth,
  monthKey,
  parseView,
  weekStartMonday,
  buildWeekDays,
  buildMonthMeta,
  buildMonthCalendarWeeks,
  indexRoster,
  normalizeRosterRows,
  shiftCountsByDate,
  enrichMonthWeeksDoctor,
  enrichMonthWeeksNurse,
  summarizePeriod,
  buildRosterRenderData,
  rosterRedirectUrl,
  parseShiftsFromBody,
  ymdFromDb,
};
