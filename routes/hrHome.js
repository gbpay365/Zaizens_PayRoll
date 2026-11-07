'use strict';

/**
 * HR hub — the Sage HR-style landing page.
 * Brings leave, attendance, holidays and payroll/tax entry points together.
 */

const ensureHrPayrollSchema = require('../lib/ensureHrPayrollSchema');
const hmsFormatDate = require('../lib/hmsFormatDate');

const MONTHS = {
  1: 'January', 2: 'February', 3: 'March', 4: 'April', 5: 'May', 6: 'June',
  7: 'July', 8: 'August', 9: 'September', 10: 'October', 11: 'November', 12: 'December',
};

const LEAVE_TYPES = {
  annual: 'Annual leave',
  sick: 'Sick leave',
  unpaid: 'Unpaid leave',
  permission: 'Permission',
  maternity: 'Maternity leave',
  paternity: 'Paternity leave',
  compassionate: 'Compassionate leave',
  study: 'Study leave',
  other: 'Other leave',
};

function todayIso() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function isoDate(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function displayDate(value) {
  const iso = isoDate(value);
  if (!iso) return '—';
  try {
    return hmsFormatDate.formatDisplayDate(new Date(`${iso}T12:00:00`));
  } catch (_) {
    return iso;
  }
}

function daysBetweenInclusive(start, end) {
  const a = new Date(`${isoDate(start)}T12:00:00`);
  const b = new Date(`${isoDate(end)}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.max(0, Math.round((b - a) / 86400000) + 1);
}

module.exports = function registerHrHomeRoutes(app, pool, requireAuth) {
  function facilityId(req) {
    return Math.max(1, parseInt(req.session.facilityId, 10) || 1);
  }

  app.get('/hr', requireAuth, async (req, res) => {
    const fid = facilityId(req);
    const uid = parseInt((req.session.user && req.session.user.id), 10) || 0;
    const perms = res.locals.userPerms || [];
    const role = String((req.session.user && req.session.user.role) || '');
    const isApprover = role === '1' || role === '99' || perms.includes('*') || perms.includes('hr.leave.approve');
    const canPayroll = role === '1' || role === '99' || perms.includes('*') || perms.includes('payroll.write') || perms.includes('payroll.read');
    const canTax = role === '1' || role === '99' || perms.includes('*') || perms.includes('accounting.read') || perms.includes('accounting.write');
    const year = Math.max(2000, Math.min(2100, parseInt(req.query.year, 10) || new Date().getFullYear()));
    const today = todayIso();

    try {
      await ensureHrPayrollSchema(pool);

      // ── My leave balances ─────────────────────────────────────
      const [balanceRows] = await pool
        .query(
          `SELECT leave_type, balance FROM tbl_hms_leave_balance
           WHERE facility_id = ? AND employee_id = ? AND year = ?
           ORDER BY FIELD(leave_type, 'annual', 'sick', 'unpaid', 'other'), leave_type`,
          [fid, uid, year]
        )
        .catch(() => [[]]);

      const [myRequests] = await pool
        .query(
          `SELECT id, leave_type, start_date, end_date, days_requested, status, reason
           FROM tbl_hms_leave_request
           WHERE facility_id = ? AND employee_id = ?
           ORDER BY created_at DESC LIMIT 6`,
          [fid, uid]
        )
        .catch(() => [[]]);

      const [[pendingMine]] = await pool
        .query(
          `SELECT COUNT(*) AS c FROM tbl_hms_leave_request
           WHERE facility_id = ? AND employee_id = ? AND status = 'pending'`,
          [fid, uid]
        )
        .catch(() => [[{ c: 0 }]]);

      // ── People ────────────────────────────────────────────────
      const [[headcount]] = await pool
        .query(
          `SELECT COUNT(*) AS c FROM tbl_employee
           WHERE status = 1 AND (default_facility_id IS NULL OR default_facility_id = ?)`,
          [fid]
        )
        .catch(() => [[{ c: 0 }]]);

      const [offToday] = await pool
        .query(
          `SELECT r.id, r.leave_type, r.start_date, r.end_date, r.days_requested,
                  e.id AS employee_id, e.first_name, e.last_name, e.job_title, e.primary_department
           FROM tbl_hms_leave_request r
           JOIN tbl_employee e ON e.id = r.employee_id
           WHERE r.facility_id = ? AND r.status = 'approved'
             AND r.start_date <= ? AND r.end_date >= ?
           ORDER BY e.first_name, e.last_name`,
          [fid, today, today]
        )
        .catch(() => [[]]);

      const [upcomingLeave] = await pool
        .query(
          `SELECT r.id, r.leave_type, r.start_date, r.end_date, r.days_requested,
                  e.id AS employee_id, e.first_name, e.last_name, e.job_title
           FROM tbl_hms_leave_request r
           JOIN tbl_employee e ON e.id = r.employee_id
           WHERE r.facility_id = ? AND r.status = 'approved' AND r.start_date > ?
           ORDER BY r.start_date ASC LIMIT 8`,
          [fid, today]
        )
        .catch(() => [[]]);

      const [approvalQueue] = isApprover
        ? await pool
            .query(
              `SELECT r.id, r.leave_type, r.start_date, r.end_date, r.days_requested, r.created_at,
                      e.first_name, e.last_name, e.job_title
               FROM tbl_hms_leave_request r
               JOIN tbl_employee e ON e.id = r.employee_id
               WHERE r.facility_id = ? AND r.status = 'pending'
               ORDER BY r.created_at ASC LIMIT 6`,
              [fid]
            )
            .catch(() => [[]])
        : [[]];

      const [[pendingAll]] = await pool
        .query(
          `SELECT COUNT(*) AS c FROM tbl_hms_leave_request WHERE facility_id = ? AND status = 'pending'`,
          [fid]
        )
        .catch(() => [[{ c: 0 }]]);

      // ── Attendance today + mine ───────────────────────────────
      const [attendanceToday] = await pool
        .query(
          `SELECT status, COUNT(*) AS c FROM tbl_hms_attendance
           WHERE facility_id = ? AND att_date = ?
           GROUP BY status`,
          [fid, today]
        )
        .catch(() => [[]]);
      const attendanceByStatus = {};
      let attendanceMarked = 0;
      for (const row of attendanceToday || []) {
        attendanceByStatus[String(row.status || 'present')] = Number(row.c || 0);
        attendanceMarked += Number(row.c || 0);
      }

      const [[myAttendanceToday]] = await pool
        .query(
          `SELECT status, check_in_time, check_out_time FROM tbl_hms_attendance
           WHERE facility_id = ? AND employee_id = ? AND att_date = ? LIMIT 1`,
          [fid, uid, today]
        )
        .catch(() => [[null]]);

      // ── Holidays ──────────────────────────────────────────────
      const [holidays] = await pool
        .query(
          `SELECT id, holiday_name, holiday_date, is_recurring FROM tbl_hms_holiday
           WHERE facility_id = ? AND holiday_date >= ?
           ORDER BY holiday_date ASC LIMIT 5`,
          [fid, today]
        )
        .catch(() => [[]]);

      // ── My latest payslip (payroll integration) ───────────────
      const [[latestPay]] = await pool
        .query(
          `SELECT id, month, year, gross_salary, net_salary, income_tax, payout_status
           FROM tbl_hms_payroll_record
           WHERE facility_id = ? AND employee_id = ?
           ORDER BY year DESC, month DESC LIMIT 1`,
          [fid, uid]
        )
        .catch(() => [[null]]);

      const [[profile]] = await pool
        .query(
          `SELECT basic_salary, housing_allowance, transport_allowance
           FROM tbl_hms_pay_profile WHERE facility_id = ? AND employee_id = ? LIMIT 1`,
          [fid, uid]
        )
        .catch(() => [[null]]);

      const myBalances = (balanceRows || []).map((r) => ({
        leave_type: r.leave_type,
        label: LEAVE_TYPES[r.leave_type] || String(r.leave_type || '').replace(/_/g, ' '),
        balance: Number(r.balance) || 0,
      }));

      const now = new Date();
      res.render('hr-home', {
        title: 'HR — Caminco S.A.',
        payNavActive: 'hrhome',
        today,
        todayLabel: now.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }),
        year,
        firstName: String((req.session.user && req.session.user.name) || '').split(/\s+/)[0] || 'there',
        isApprover,
        canPayroll,
        canTax,
        myBalances,
        myRequests: myRequests || [],
        myPending: Number(pendingMine && pendingMine.c) || 0,
        offToday: offToday || [],
        upcomingLeave: upcomingLeave || [],
        approvalQueue: approvalQueue || [],
        pendingAll: Number(pendingAll && pendingAll.c) || 0,
        headcount: Number(headcount && headcount.c) || 0,
        attendanceByStatus,
        attendanceMarked,
        myAttendanceToday: myAttendanceToday || null,
        holidays: holidays || [],
        latestPay: latestPay || null,
        profile: profile || null,
        displayDate,
        daysBetweenInclusive,
        MONTHS,
        LEAVE_TYPES,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      console.error('[hr-home]', e.message);
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });
};
