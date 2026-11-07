'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const ensureHrPayrollSchema = require('../lib/ensureHrPayrollSchema');
const L = require('../lib/leaveSystem');
const W = require('../lib/leaveWorkflow');
const Accrual = require('../lib/leaveAccrual');
const AttendancePolicy = require('../lib/attendancePolicy');
const Maintenance = require('../lib/maintenanceScheduler');
const { logAdminAction } = require('../lib/adminAudit');

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'leave');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/png', 'image/jpeg'];
    if (!allowed.includes(String(file.mimetype))) return cb(new Error('Only PDF, PNG or JPEG documents are accepted.'));
    cb(null, true);
  },
});

function uploadSingle(req, res, next) {
  upload.single('attachment')(req, res, (err) => {
    if (err) return res.redirect('/hr/request-leave?err=' + encodeURIComponent(err.message));
    next();
  });
}

function arr(value) {
  return Array.isArray(value) ? value : (value == null ? [] : [value]);
}

function bool(value) {
  return value === '1' || value === 'on' || value === true || value === 1 ? 1 : 0;
}

function num(value, fallback) {
  const parsed = Number(String(value == null ? '' : value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function int(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateDisplay(value, long) {
  if (!value) return '—';
  const d = new Date(L.isoDate(value) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-GB', long
    ? { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }
    : { day: '2-digit', month: 'short', year: 'numeric' });
}

function employeeName(row) {
  return `${(row && row.first_name) || ''} ${(row && row.last_name) || ''}`.trim() || `Employee #${(row && row.employee_id) || '—'}`;
}

function csv(value) {
  const s = String(value == null ? '' : value);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function maintenanceTaskLabel(task) {
  const labels = { leave_carryover: 'Carry-over', leave_accrual: 'Accrual', leave_digest: 'Email digest' };
  const key = String(task || '');
  return labels[key] || key.replace(/_/g, ' ') || '—';
}

function formatMaintenanceTime(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatMaintenanceDuration(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A run's detail is either JSON from a completed task or plain error/digest text.
 */
function parseMaintenanceDetail(task, detail) {
  const raw = String(detail == null ? '' : detail).trim();
  if (!raw) return { note: 'No detail was recorded for this run.', changes: [], changeCount: 0 };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { note: raw.slice(0, 500), changes: [], changeCount: 0 };
  }
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  const changes = rows.slice(0, 25).map((row) => ({
    employee: String(row.employee_name || `Employee #${row.employee_id || '—'}`),
    leaveType: String(row.leave_type || '—').replace(/_/g, ' '),
    days: n(row.days),
  }));
  const count = task === 'leave_carryover' ? n(parsed.applied) : n(parsed.updated);
  const employees = n(parsed.employees) || new Set(rows.map((row) => row.employee_id)).size;
  let note;
  if (!count || !rows.length) {
    note = task === 'leave_carryover'
      ? 'No balances needed carrying over.'
      : 'All balances already matched the entitlement.';
  } else if (task === 'leave_carryover') {
    note = `${count} balance(s) carried over for ${employees} employee(s).`;
  } else {
    note = `${count} balance(s) accrued for ${employees} employee(s).`;
  }
  return { note, changes, changeCount: rows.length };
}

module.exports = function registerHrLeaveSystem(app, pool, requireAuth, deps) {
  const requireHrSelfService = deps.requireHrSelfService || ((req, res, next) => next());

  function facilityId(req) {
    return Math.max(1, parseInt(req.session.facilityId, 10) || 1);
  }

  function sessionEmpId(req) {
    return parseInt(req.session.user && req.session.user.id, 10) || 0;
  }

  function isAdmin(req) {
    const role = String(req.session.user && req.session.user.role || '');
    return role === '1' || role === '99';
  }

  function isHr(req) {
    if (isAdmin(req)) return true;
    const perms = (req.res && req.res.locals && req.res.locals.userPerms) || [];
    return perms.includes('*') || perms.includes('hr.leave.approve');
  }

  function requireLeaveAdmin(req, res, next) {
    if (isHr(req)) return next();
    return res.status(403).render('error', {
      title: 'Access denied',
      message: 'HR leave administrator permission is required.',
      status: 403,
    });
  }

  function requireAttendanceAdmin(req, res, next) {
    const perms = res.locals.userPerms || [];
    if (isAdmin(req) || perms.includes('*') || perms.includes('payroll.write') || perms.includes('hr.leave.approve')) return next();
    return res.status(403).render('error', {
      title: 'Access denied',
      message: 'Payroll or HR attendance permission is required.',
      status: 403,
    });
  }

  async function ensureSchema() {
    await ensureHrPayrollSchema(pool);
    await L.ensureLeaveSystemSchema(pool);
  }

  async function audit(req, action, targetId, detail) {
    await logAdminAction(pool, req, action, {
      targetType: 'employee',
      targetId: targetId || null,
      detail: String(detail || '').slice(0, 1000),
    }).catch(() => {});
  }

  async function attachHistory(rows) {
    const list = rows || [];
    if (!list.length) return list;
    const ids = list.map((r) => parseInt(r.id, 10)).filter(Boolean);
    if (!ids.length) return list;
    const [history] = await pool.query(
      'SELECT * FROM tbl_hms_leave_approval WHERE request_id IN (?) ORDER BY request_id, id',
      [ids]
    ).catch(() => [[]]);
    const byId = {};
    for (const row of history || []) {
      if (!byId[row.request_id]) byId[row.request_id] = [];
      byId[row.request_id].push(row);
    }
    for (const row of list) row.history = byId[row.id] || [];
    return list;
  }

  async function notificationsFor(req) {
    const uid = sessionEmpId(req);
    if (!uid) return { rows: [], unread: 0 };
    const [rows] = await pool.query(
      'SELECT * FROM tbl_hms_leave_notification WHERE facility_id = ? AND employee_id = ? ORDER BY created_at DESC LIMIT 30',
      [facilityId(req), uid]
    ).catch(() => [[]]);
    const unread = (rows || []).filter((r) => !r.read_at).length;
    return { rows: rows || [], unread };
  }

  function typeLabelMap(types) {
    const map = {};
    for (const type of types || []) map[String(type.code)] = type.label;
    return map;
  }

  function parseAttendanceBody(body) {
    const raw = body && body.attendance;
    if (!raw || typeof raw !== 'object') return [];
    const entries = Array.isArray(raw) ? raw.map((row, index) => [row && row.employee_id, row, index]) : Object.entries(raw);
    return entries.map(([key, row]) => ({
      employee_id: int((row && row.employee_id) || key, 0),
      status: String((row && row.status) || 'present').trim().toLowerCase(),
      in: row && row.in != null ? String(row.in).trim() : '',
      out: row && row.out != null ? String(row.out).trim() : '',
      reason: row && row.reason != null ? String(row.reason).trim() : '',
      notes: row && row.notes != null ? String(row.notes).trim() : '',
    })).filter((row) => row.employee_id > 0);
  }

  async function saveAttachment(file, actorId) {
    if (!file) return { name: null, path: null };
    const original = String(file.originalname || 'document').slice(0, 240);
    const safe = original.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'document';
    const ext = path.extname(safe).slice(0, 12).toLowerCase();
    const stored = `${Date.now()}-${crypto.randomUUID()}${ext}`;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, stored), file.buffer);
    return { name: original, path: stored, actorId };
  }

  // ── Employee self service ────────────────────────────────────────────────

  app.get('/hr/request-leave', requireAuth, requireHrSelfService, async (req, res) => {
    try {
      await ensureSchema();
      const fid = facilityId(req);
      const uid = sessionEmpId(req);
      if (uid < 1) return res.redirect('/payroll?err=' + encodeURIComponent('Session employee id missing.'));
      const year = Math.max(2000, Math.min(2100, int(req.query.year, new Date().getFullYear())));
      const data = await L.getBalancesForEmployee(pool, fid, uid, year);
      const [mineRaw] = await pool.query(
        `SELECT r.*, ab.first_name AS approver_first, ab.last_name AS approver_last
           FROM tbl_hms_leave_request r
           LEFT JOIN tbl_employee ab ON ab.id = r.approved_by
          WHERE r.facility_id = ? AND r.employee_id = ?
          ORDER BY r.created_at DESC LIMIT 60`,
        [fid, uid]
      ).catch(() => [[]]);
      const mine = await attachHistory((mineRaw || []).map((r) => ({
        ...r,
        start_date_fmt: dateDisplay(r.start_date),
        end_date_fmt: dateDisplay(r.end_date),
        can_cancel: ['pending', 'approved'].includes(String(r.status)),
      })));
      const notes = await notificationsFor(req);
      res.render('hr-request-leave', {
        title: 'Request time off — ZAIZENS',
        paySelfServiceOnly: 'leave',
        leaveTypes: data.types,
        policies: data.policies,
        balances: data.rows,
        mine,
        year,
        today: L.todayIso(),
        notifications: notes.rows,
        unreadNotifications: notes.unread,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/hr/request-leave', requireAuth, requireHrSelfService, uploadSingle, async (req, res) => {
    const fid = facilityId(req);
    const uid = sessionEmpId(req);
    let saved = null;
    try {
      await ensureSchema();
      if (uid < 1) return res.redirect('/hr/request-leave?err=' + encodeURIComponent('Session employee id missing.'));
      const leaveType = String(req.body.leave_type || '').trim().slice(0, 32);
      const start = String(req.body.start_date || '').trim();
      const end = String(req.body.end_date || '').trim();
      const unit = String(req.body.duration_unit || 'day').trim().toLowerCase();
      const halfDay = String(req.body.half_day_period || '').trim().toLowerCase();
      const startTime = String(req.body.start_time || '').trim();
      const endTime = String(req.body.end_time || '').trim();
      const reason = String(req.body.reason || '').trim().slice(0, 2000);
      if (req.file) saved = await saveAttachment(req.file, uid);
      const result = await W.submitLeave(pool, {
        facilityId: fid,
        employeeId: uid,
        leaveType,
        start,
        end,
        unit: unit === 'hour' ? 'hour' : 'day',
        startTime: unit === 'hour' ? startTime : null,
        endTime: unit === 'hour' ? endTime : null,
        halfDayPeriod: unit === 'day' && ['am', 'pm'].includes(halfDay) ? halfDay : null,
        reason,
        attachmentName: saved && saved.name,
        attachmentPath: saved && saved.path,
        actorId: uid,
      });
      if (!result.ok) {
        if (saved) await fs.promises.unlink(path.join(UPLOAD_DIR, saved.path)).catch(() => {});
        return res.redirect('/hr/request-leave?err=' + encodeURIComponent(result.error));
      }
      if (saved) {
        await pool.query(
          'INSERT INTO tbl_hms_leave_attachment (request_id, file_name, file_path, mime_type, uploaded_by) VALUES (?,?,?,?,?)',
          [result.requestId, saved.name, saved.path, req.file.mimetype, uid]
        ).catch(() => {});
      }
      await audit(req, 'hr.leave.request', uid, `${leaveType} leave ${start} to ${end} (${result.days} day(s)) submitted.`);
      res.redirect('/hr/request-leave?msg=' + encodeURIComponent(`Leave request submitted for approval (${result.days} day(s)).`));
    } catch (e) {
      if (saved) await fs.promises.unlink(path.join(UPLOAD_DIR, saved.path)).catch(() => {});
      res.redirect('/hr/request-leave?err=' + encodeURIComponent(e.message));
    }
  });

  app.post('/hr/request-leave/:id/cancel', requireAuth, requireHrSelfService, async (req, res) => {
    const fid = facilityId(req);
    const uid = sessionEmpId(req);
    const id = int(req.params.id, 0);
    try {
      await ensureSchema();
      const result = await W.cancelLeave(pool, { facilityId: fid, requestId: id, actorId: uid, isHr: isHr(req) });
      if (!result.ok) return res.redirect('/hr/request-leave?err=' + encodeURIComponent(result.error));
      await audit(req, 'hr.leave.cancel', uid, `Leave request #${id} cancelled.`);
      res.redirect('/hr/request-leave?msg=' + encodeURIComponent('Leave request cancelled.'));
    } catch (e) {
      res.redirect('/hr/request-leave?err=' + encodeURIComponent(e.message));
    }
  });

  app.get('/hr/my-leave-balance', requireAuth, requireHrSelfService, async (req, res) => {
    try {
      await ensureSchema();
      const fid = facilityId(req);
      const uid = sessionEmpId(req);
      if (uid < 1) return res.redirect('/payroll?err=' + encodeURIComponent('Session employee id missing.'));
      const year = Math.max(2000, Math.min(2100, int(req.query.year, new Date().getFullYear())));
      const data = await L.getBalancesForEmployee(pool, fid, uid, year);
      const rows = data.rows || [];
      const notes = await notificationsFor(req);
      res.render('hr-my-leave-balance', {
        title: 'My leave balance — ZAIZENS',
        year,
        rows,
        notifications: notes.rows,
        unreadNotifications: notes.unread,
        totals: {
          entitled: rows.reduce((sum, row) => sum + Number(row.entitled || 0), 0),
          used: rows.reduce((sum, row) => sum + Number(row.used || 0), 0),
          pending: rows.reduce((sum, row) => sum + Number(row.pending || 0), 0),
          remaining: rows.reduce((sum, row) => sum + Number(row.remaining || 0), 0),
        },
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.get('/hr/my-attendance', requireAuth, requireHrSelfService, async (req, res) => {
    try {
      await ensureSchema();
      const fid = facilityId(req);
      const uid = sessionEmpId(req);
      if (uid < 1) return res.redirect('/payroll?err=' + encodeURIComponent('Session employee id missing.'));
      const [rows] = await pool.query(
        'SELECT * FROM tbl_hms_attendance WHERE facility_id = ? AND employee_id = ? ORDER BY att_date DESC LIMIT 120',
        [fid, uid]
      ).catch(() => [[]]);
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const summary = { present: 0, late: 0, absent: 0, 'half-day': 0, 'on-leave': 0, holiday: 0 };
      let totalMonth = 0;
      let hoursMonth = 0;
      for (const row of rows || []) {
        if (String(row.att_date).slice(0, 10) < monthStart) continue;
        totalMonth += 1;
        const st = String(row.status || 'present').toLowerCase();
        summary[st] = (summary[st] || 0) + 1;
        hoursMonth += Number(row.worked_minutes || 0) / 60 || 0;
      }
      const [[lastPunch]] = await pool.query(
        "SELECT *, DATE_FORMAT(punched_at, '%H:%i') AS punch_time FROM tbl_hms_attendance_punch WHERE facility_id = ? AND employee_id = ? ORDER BY punched_at DESC, id DESC LIMIT 1",
        [fid, uid]
      ).catch(() => [[null]]);
      const notes = await notificationsFor(req);
      res.render('hr-my-attendance', {
        title: 'My attendance — ZAIZENS',
        rows: rows || [],
        summary,
        totalMonth,
        hoursMonth: Math.round(hoursMonth * 10) / 10,
        today: L.todayIso(),
        lastPunch,
        notifications: notes.rows,
        unreadNotifications: notes.unread,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/hr/clock/:direction', requireAuth, requireHrSelfService, async (req, res) => {
    const fid = facilityId(req);
    const uid = sessionEmpId(req);
    const direction = String(req.params.direction || '').toLowerCase();
    try {
      await ensureSchema();
      const result = await W.recordPunch(pool, {
        facilityId: fid,
        employeeId: uid,
        direction,
        source: 'web',
        ip: req.ip,
        device: String(req.headers['user-agent'] || '').slice(0, 120),
        actorId: uid,
      });
      if (!result.ok) return res.redirect('/hr/my-attendance?err=' + encodeURIComponent(result.error));
      res.redirect('/hr/my-attendance?msg=' + encodeURIComponent(`Clocked ${direction} at ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`));
    } catch (e) {
      res.redirect('/hr/my-attendance?err=' + encodeURIComponent(e.message));
    }
  });

  app.get('/hr/notifications', requireAuth, requireHrSelfService, async (req, res) => {
    try {
      await ensureSchema();
      const notes = await notificationsFor(req);
      res.render('hr-notifications', {
        title: 'Notifications — ZAIZENS',
        paySelfServiceOnly: 'leave',
        notifications: notes.rows,
        unreadNotifications: notes.unread,
        flash: req.query.msg || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/hr/notifications/read', requireAuth, requireHrSelfService, async (req, res) => {
    try {
      await ensureSchema();
      await pool.query(
        'UPDATE tbl_hms_leave_notification SET read_at = NOW() WHERE facility_id = ? AND employee_id = ? AND read_at IS NULL',
        [facilityId(req), sessionEmpId(req)]
      );
      res.redirect('/hr/notifications?msg=' + encodeURIComponent('Notifications marked as read.'));
    } catch (e) {
      res.redirect('/hr/notifications?err=' + encodeURIComponent(e.message));
    }
  });

  // ── Approvals ─────────────────────────────────────────────────────────────

  app.get('/hr/leave-requests', requireAuth, async (req, res) => {
    try {
      await ensureSchema();
      const fid = facilityId(req);
      const uid = sessionEmpId(req);
      const canFinal = isHr(req);
      const where = ['r.facility_id = ?'];
      const params = [fid];
      if (!canFinal) {
        where.push('(r.employee_id = ? OR r.manager_id = ?)');
        params.push(uid, uid);
      }
      const [rows] = await pool.query(
        `SELECT r.*, e.first_name, e.last_name, e.employee_id AS employee_ref,
                m.first_name AS manager_first, m.last_name AS manager_last,
                (SELECT COUNT(*) FROM tbl_hms_leave_attachment a WHERE a.request_id = r.id) AS attachment_count
           FROM tbl_hms_leave_request r
           JOIN tbl_employee e ON e.id = r.employee_id
           LEFT JOIN tbl_employee m ON m.id = r.manager_id
          WHERE ${where.join(' AND ')}
          ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'cancelled' THEN 2 ELSE 3 END,
                   r.created_at DESC
          LIMIT 300`,
        params
      ).catch(() => [[]]);
      const types = await L.loadLeaveTypes(pool, fid, false);
      const labels = typeLabelMap(types);
      const enriched = (rows || []).map((row) => {
        const canAct = String(row.status) === 'pending'
          && Number(row.employee_id) !== Number(uid)
          && (canFinal || Number(row.manager_id) === Number(uid));
        return {
          ...row,
          start_date_fmt: dateDisplay(row.start_date),
          end_date_fmt: dateDisplay(row.end_date),
          type_label: labels[row.leave_type] || String(row.leave_type || '').replace(/_/g, ' '),
          manager_name: employeeName({ first_name: row.manager_first, last_name: row.manager_last }),
          can_act: canAct,
        };
      });
      await attachHistory(enriched);
      const counts = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
      for (const row of enriched) counts[String(row.status)] = (counts[String(row.status)] || 0) + 1;
      const notes = await notificationsFor(req);
      res.render('hr-leave-requests', {
        title: 'Leave approvals — ZAIZENS',
        rows: enriched,
        counts,
        canFinal,
        leaveTypes: types,
        notifications: notes.rows,
        unreadNotifications: notes.unread,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/hr/leave-requests/action', requireAuth, async (req, res) => {
    const fid = facilityId(req);
    const uid = sessionEmpId(req);
    const requestId = int(req.body.request_id, 0);
    const action = String(req.body.action || '').toLowerCase();
    const comment = String(req.body.comment || '').trim().slice(0, 1000);
    const back = '/hr/leave-requests';
    try {
      await ensureSchema();
      if (requestId < 1 || !['approve', 'reject'].includes(action)) {
        return res.redirect(back + '?err=' + encodeURIComponent('Invalid leave action.'));
      }
      if (action === 'reject' && !comment) {
        return res.redirect(back + '?err=' + encodeURIComponent('A rejection comment is required.'));
      }
      const [[request]] = await pool.query(
        'SELECT * FROM tbl_hms_leave_request WHERE id = ? AND facility_id = ? LIMIT 1',
        [requestId, fid]
      );
      if (!request) return res.redirect(back + '?err=' + encodeURIComponent('Leave request not found.'));
      const canFinal = isHr(req);
      const isManager = Number(request.manager_id) === Number(uid);
      if (!canFinal && !isManager) return res.redirect(back + '?err=' + encodeURIComponent('You are not an approver for this request.'));
      if (Number(request.employee_id) === Number(uid)) return res.redirect(back + '?err=' + encodeURIComponent('You cannot approve your own leave request.'));
      const result = action === 'approve'
        ? await W.approveLeave(pool, { facilityId: fid, requestId, actorId: uid, comment, canFinal })
        : await W.rejectLeave(pool, { facilityId: fid, requestId, actorId: uid, comment, canFinal });
      if (!result.ok) return res.redirect(back + '?err=' + encodeURIComponent(result.error));
      await audit(req, `hr.leave.${action}`, uid, `Leave request #${requestId} ${result.status}. ${comment}`.trim());
      const message = result.status === 'forwarded' ? 'Manager approval recorded; the request was forwarded to HR.' : `Leave request ${result.status}.`;
      res.redirect(back + '?msg=' + encodeURIComponent(message));
    } catch (e) {
      res.redirect(back + '?err=' + encodeURIComponent(e.message));
    }
  });

  app.get('/hr/leave-attachments/:id', requireAuth, async (req, res) => {
    try {
      await ensureSchema();
      const id = int(req.params.id, 0);
      const [[row]] = await pool.query(
        `SELECT a.*, r.employee_id, r.manager_id, r.facility_id
           FROM tbl_hms_leave_attachment a JOIN tbl_hms_leave_request r ON r.id = a.request_id
          WHERE a.id = ? AND r.facility_id = ? LIMIT 1`,
        [id, facilityId(req)]
      ).catch(() => [[null]]);
      if (!row) return res.status(404).send('Document not found.');
      const uid = sessionEmpId(req);
      if (!isHr(req) && Number(row.employee_id) !== uid && Number(row.manager_id) !== uid) {
        return res.status(403).send('Access denied.');
      }
      const file = path.join(UPLOAD_DIR, path.basename(String(row.file_path || '')));
      if (!fs.existsSync(file)) return res.status(404).send('Document file not found.');
      res.setHeader('Content-Disposition', `inline; filename="${String(row.file_name || 'document').replace(/"/g, '')}"`);
      res.sendFile(file);
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  app.get('/hr/leave-requests/:id/attachment', requireAuth, async (req, res) => {
    try {
      await ensureSchema();
      const requestId = int(req.params.id, 0);
      const [[row]] = await pool.query(
        `SELECT a.*, r.employee_id, r.manager_id, r.facility_id
           FROM tbl_hms_leave_attachment a JOIN tbl_hms_leave_request r ON r.id = a.request_id
          WHERE a.request_id = ? AND r.facility_id = ? ORDER BY a.id DESC LIMIT 1`,
        [requestId, facilityId(req)]
      ).catch(() => [[null]]);
      if (!row) return res.status(404).send('Document not found.');
      const uid = sessionEmpId(req);
      if (!isHr(req) && Number(row.employee_id) !== uid && Number(row.manager_id) !== uid) {
        return res.status(403).send('Access denied.');
      }
      const file = path.join(UPLOAD_DIR, path.basename(String(row.file_path || '')));
      if (!fs.existsSync(file)) return res.status(404).send('Document file not found.');
      res.setHeader('Content-Disposition', `inline; filename="${String(row.file_name || 'document').replace(/"/g, '')}"`);
      res.sendFile(file);
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // ── Admin balances, policy, calendar, reports ─────────────────────────────

  app.get('/hr/leave-balances', requireAuth, requireLeaveAdmin, async (req, res) => {
    try {
      await ensureSchema();
      const fid = facilityId(req);
      const year = Math.max(2000, Math.min(2100, int(req.query.year, new Date().getFullYear())));
      const rows = await L.getBalancesForAll(pool, fid, year);
      const mapped = rows.map((row) => {
        const annual = row.annual || { entitled: 0, used: 0, pending: 0, remaining: 0 };
        return {
          ...row,
          balance: Number(annual.entitled || 0),
          used: Number(annual.used || 0),
          pending: Number(annual.pending || 0),
          remaining: Number(annual.remaining || 0),
        };
      });
      const types = await L.loadLeaveTypes(pool, fid, false);
      const policies = await L.loadPolicies(pool, fid);
      const notes = await notificationsFor(req);
      res.render('hr-leave-balances', {
        title: 'Leave balances — ZAIZENS',
        year,
        rows: mapped,
        types,
        policies,
        notifications: notes.rows,
        unreadNotifications: notes.unread,
        totals: {
          entitled: mapped.reduce((sum, row) => sum + row.balance, 0),
          used: mapped.reduce((sum, row) => sum + row.used, 0),
          pending: mapped.reduce((sum, row) => sum + row.pending, 0),
          remaining: mapped.reduce((sum, row) => sum + row.remaining, 0),
        },
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/hr/leave-balances/save', requireAuth, requireLeaveAdmin, async (req, res) => {
    const fid = facilityId(req);
    const year = Math.max(2000, Math.min(2100, int(req.body.year, new Date().getFullYear())));
    const back = `/hr/leave-balances?year=${year}`;
    const conn = await pool.getConnection();
    try {
      await ensureSchema();
      const [staff] = await conn.query(
        'SELECT id FROM tbl_employee WHERE status = 1 AND (default_facility_id IS NULL OR default_facility_id = ?)',
        [fid]
      );
      await conn.beginTransaction();
      for (const employee of staff || []) {
        const raw = req.body[`bal_${employee.id}`];
        if (raw == null || String(raw).trim() === '') continue;
        const next = num(raw, 0);
        if (next < 0 || next > 365) continue;
        const [[existing]] = await conn.query(
          'SELECT balance FROM tbl_hms_leave_balance WHERE facility_id = ? AND employee_id = ? AND leave_type = ? AND year = ? LIMIT 1 FOR UPDATE',
          [fid, employee.id, 'annual', year]
        );
        const before = n(existing && existing.balance);
        await conn.query(
          `INSERT INTO tbl_hms_leave_balance (facility_id, employee_id, leave_type, year, balance)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE balance = VALUES(balance)`,
          [fid, employee.id, 'annual', year, next]
        );
        if (before !== next) {
          await conn.query(
            `INSERT INTO tbl_hms_leave_ledger (facility_id, employee_id, leave_type, leave_year, entry_date, entry_type, days, note, created_by)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [fid, employee.id, 'annual', year, L.todayIso(), 'adjustment', next - before, 'Annual entitlement changed from leave balances', sessionEmpId(req)]
          );
        }
      }
      await conn.commit();
      await audit(req, 'hr.leave.balance_save', null, `Annual leave balances saved for ${year}.`);
      res.redirect(back + '&msg=' + encodeURIComponent('Annual leave balances saved.'));
    } catch (e) {
      await conn.rollback().catch(() => {});
      res.redirect(back + '&err=' + encodeURIComponent(e.message));
    } finally {
      conn.release();
    }
  });

  app.post('/hr/leave-balances/apply-default', requireAuth, requireLeaveAdmin, async (req, res) => {
    const fid = facilityId(req);
    const year = Math.max(2000, Math.min(2100, int(req.body.year, new Date().getFullYear())));
    const days = num(req.body.default_days, NaN);
    const back = `/hr/leave-balances?year=${year}`;
    if (!Number.isFinite(days) || days < 0 || days > 365) {
      return res.redirect(back + '&err=' + encodeURIComponent('Enter a default entitlement between 0 and 365 days.'));
    }
    const conn = await pool.getConnection();
    try {
      await ensureSchema();
      const [staff] = await conn.query(
        'SELECT id FROM tbl_employee WHERE status = 1 AND (default_facility_id IS NULL OR default_facility_id = ?)',
        [fid]
      );
      await conn.beginTransaction();
      for (const employee of staff || []) {
        const [[existing]] = await conn.query(
          'SELECT balance FROM tbl_hms_leave_balance WHERE facility_id = ? AND employee_id = ? AND leave_type = ? AND year = ? LIMIT 1 FOR UPDATE',
          [fid, employee.id, 'annual', year]
        );
        const before = n(existing && existing.balance);
        await conn.query(
          `INSERT INTO tbl_hms_leave_balance (facility_id, employee_id, leave_type, year, balance)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE balance = VALUES(balance)`,
          [fid, employee.id, 'annual', year, days]
        );
        if (before !== days) {
          await conn.query(
            `INSERT INTO tbl_hms_leave_ledger (facility_id, employee_id, leave_type, leave_year, entry_date, entry_type, days, note, created_by)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [fid, employee.id, 'annual', year, L.todayIso(), 'adjustment', days - before, 'Default annual entitlement applied', sessionEmpId(req)]
          );
        }
      }
      await conn.commit();
      await audit(req, 'hr.leave.balance_default', null, `Default annual entitlement ${days} applied for ${year}.`);
      res.redirect(back + '&msg=' + encodeURIComponent(`Default entitlement of ${days} day(s) applied to ${(staff || []).length} employee(s).`));
    } catch (e) {
      await conn.rollback().catch(() => {});
      res.redirect(back + '&err=' + encodeURIComponent(e.message));
    } finally {
      conn.release();
    }
  });

  app.post('/hr/leave-balances/adjust', requireAuth, requireLeaveAdmin, async (req, res) => {
    const fid = facilityId(req);
    const year = Math.max(2000, Math.min(2100, int(req.body.year, new Date().getFullYear())));
    const employeeId = int(req.body.employee_id, 0);
    const leaveType = String(req.body.leave_type || '').trim().slice(0, 32);
    const entryType = String(req.body.entry_type || 'adjustment').trim().toLowerCase();
    const days = num(req.body.days, NaN);
    const note = String(req.body.note || '').trim().slice(0, 500);
    const back = `/hr/leave-balances?year=${year}`;
    if (!employeeId || !leaveType || !Number.isFinite(days) || days === 0) {
      return res.redirect(back + '&err=' + encodeURIComponent('Choose an employee, leave type and non-zero days.'));
    }
    if (!['adjustment', 'carryover', 'encashment', 'accrual'].includes(entryType)) {
      return res.redirect(back + '&err=' + encodeURIComponent('Invalid ledger entry type.'));
    }
    try {
      await ensureSchema();
      await L.ensureEmployeeBalances(pool, fid, employeeId, year);
      const column = entryType === 'carryover' ? 'carried_days'
        : entryType === 'encashment' ? 'encashed_days'
          : entryType === 'accrual' ? 'balance' : 'adjusted_days';
      await pool.query(
        `UPDATE tbl_hms_leave_balance SET ${column} = ${column} + ? WHERE facility_id = ? AND employee_id = ? AND leave_type = ? AND year = ?`,
        [days, fid, employeeId, leaveType, year]
      );
      await pool.query(
        `INSERT INTO tbl_hms_leave_ledger (facility_id, employee_id, leave_type, leave_year, entry_date, entry_type, days, note, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [fid, employeeId, leaveType, year, L.todayIso(), entryType, days, note || `${entryType} adjustment`, sessionEmpId(req)]
      );
      await audit(req, `hr.leave.ledger_${entryType}`, employeeId, `${entryType} ${days} day(s) for ${leaveType} in ${year}. ${note}`.trim());
      res.redirect(back + '&msg=' + encodeURIComponent('Leave ledger adjusted.'));
    } catch (e) {
      res.redirect(back + '&err=' + encodeURIComponent(e.message));
    }
  });

  app.post('/hr/leave-balances/carryover', requireAuth, requireLeaveAdmin, async (req, res) => {
    const fid = facilityId(req);
    const year = Math.max(2000, Math.min(2100, int(req.body.year, new Date().getFullYear())));
    const back = `/hr/leave-balances?year=${year}`;
    try {
      await ensureSchema();
      const result = await Accrual.runCarryOver(pool, fid, year, sessionEmpId(req));
      const applied = result.applied;
      await audit(req, 'hr.leave.carryover', null, `Carry-over run for ${year}: ${applied} balance(s) updated.`);
      res.redirect(back + '&msg=' + encodeURIComponent(`Carry-over complete: ${applied} balance(s) updated.`));
    } catch (e) {
      res.redirect(back + '&err=' + encodeURIComponent(e.message));
    }
  });

  app.post('/hr/leave-balances/accrue', requireAuth, requireLeaveAdmin, async (req, res) => {
    const fid = facilityId(req);
    const year = Math.max(2000, Math.min(2100, int(req.body.year, new Date().getFullYear())));
    const back = `/hr/leave-balances?year=${year}`;
    try {
      await ensureSchema();
      const result = await Accrual.runAccrual(pool, fid, year, sessionEmpId(req));
      const updated = result.updated;
      await audit(req, 'hr.leave.accrual', null, `Entitlement accrual run for ${year}: ${updated} balance(s) updated.`);
      res.redirect(back + '&msg=' + encodeURIComponent(`Entitlement accrual complete: ${updated} balance(s) updated.`));
    } catch (e) {
      res.redirect(back + '&err=' + encodeURIComponent(e.message));
    }
  });

  app.get('/hr/leave-maintenance', requireAuth, requireLeaveAdmin, async (req, res) => {
    try {
      await ensureSchema();
      await Maintenance.ensureMaintenanceSchema(pool);
      const fid = facilityId(req);
      const requestedTask = String(req.query.task || '').trim();
      const requestedStatus = String(req.query.status || '').trim().toLowerCase();
      const taskFilter = ['leave_carryover', 'leave_accrual', 'leave_digest'].includes(requestedTask) ? requestedTask : '';
      const statusFilter = ['running', 'success', 'failed'].includes(requestedStatus) ? requestedStatus : '';
      const where = ['facility_id = ?'];
      const whereParams = [fid];
      if (taskFilter) {
        where.push('task = ?');
        whereParams.push(taskFilter);
      }
      if (statusFilter) {
        where.push('status = ?');
        whereParams.push(statusFilter);
      }
      const whereSql = where.join(' AND ');
      const [rows] = await pool.query(
        `SELECT id, task, run_key, status, detail, actor_id, actor_name, started_at, finished_at
           FROM tbl_hms_maintenance_run
          WHERE ${whereSql}
          ORDER BY started_at DESC, id DESC
          LIMIT 100`,
        whereParams
      ).catch(() => [[]]);
      const [stats] = await pool.query(
        `SELECT task, status, COUNT(*) AS total, MAX(finished_at) AS last_at
           FROM tbl_hms_maintenance_run
          WHERE ${whereSql}
          GROUP BY task, status`,
        whereParams
      ).catch(() => [[]]);

      const runs = (rows || []).map((row) => {
        const parsed = parseMaintenanceDetail(row.task, row.detail);
        const started = row.started_at ? new Date(row.started_at) : null;
        const finished = row.finished_at ? new Date(row.finished_at) : null;
        const elapsed = started && finished && !Number.isNaN(finished - started)
          ? Math.max(0, Math.round((finished - started) / 1000))
          : null;
        return {
          ...row,
          taskLabel: maintenanceTaskLabel(row.task),
          statusKey: String(row.status || '').toLowerCase(),
          triggerLabel: String(row.actor_name || '').trim()
            || (n(row.actor_id) ? `Employee #${n(row.actor_id)}` : 'Scheduler'),
          startedDisplay: formatMaintenanceTime(row.started_at),
          finishedDisplay: formatMaintenanceTime(row.finished_at),
          durationLabel: formatMaintenanceDuration(elapsed),
          note: parsed.note,
          changes: parsed.changes,
          changeCount: parsed.changeCount,
        };
      });

      const summary = { total: 0, success: 0, failed: 0, running: 0, lastSuccess: '—', lastFailure: '—' };
      let lastSuccessAt = null;
      let lastFailureAt = null;
      for (const stat of stats || []) {
        const count = n(stat.total);
        summary.total += count;
        const status = String(stat.status || '').toLowerCase();
        const at = stat.last_at ? new Date(stat.last_at) : null;
        if (status === 'success') {
          summary.success += count;
          if (at && !Number.isNaN(at.getTime()) && (!lastSuccessAt || at > lastSuccessAt)) lastSuccessAt = at;
        } else if (status === 'failed') {
          summary.failed += count;
          if (at && !Number.isNaN(at.getTime()) && (!lastFailureAt || at > lastFailureAt)) lastFailureAt = at;
        } else if (status === 'running') {
          summary.running += count;
        }
      }
      if (lastSuccessAt) summary.lastSuccess = formatMaintenanceTime(lastSuccessAt);
      if (lastFailureAt) summary.lastFailure = formatMaintenanceTime(lastFailureAt);

      const notes = await notificationsFor(req);
      res.render('hr-leave-maintenance', {
        title: 'Leave maintenance — ZAIZENS',
        runs,
        summary,
        filters: { task: taskFilter, status: statusFilter, hasFilters: Boolean(taskFilter || statusFilter) },
        notifications: notes.rows,
        unreadNotifications: notes.unread,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/hr/leave-maintenance/run', requireAuth, requireLeaveAdmin, async (req, res) => {
    const fid = facilityId(req);
    const back = '/hr/leave-maintenance';
    try {
      await ensureSchema();
      await Maintenance.ensureMaintenanceSchema(pool);
      const user = req.session.user || {};
      const out = await Maintenance.runDailyLeaveMaintenance(pool, {
        facilityId: fid,
        actorId: sessionEmpId(req),
        actorName: String(user.name || user.username || '').trim().slice(0, 120),
        notify: false,
      });
      const result = (out.results || []).find((row) => Number(row.facilityId) === fid) || (out.results || [])[0] || {};
      const carry = result.carryOver || {};
      const accrual = result.accrual || {};
      const parts = [
        carry.skipped
          ? `Carry-over for ${result.year} was already completed.`
          : `Carry-over: ${n(carry.applied)} balance(s) moved.`,
        accrual.skipped
          ? 'Accrual was already completed today.'
          : `Accrual: ${n(accrual.updated)} balance(s) updated.`,
      ];
      const errors = result.errors || [];
      await audit(
        req,
        'hr.leave.maintenance.run',
        null,
        `Manual maintenance run for ${result.year}: ${parts.join(' ')}${errors.length ? ' Errors: ' + errors.join(' | ') : ''}`
      );
      if (errors.length) {
        return res.redirect(back + '?err=' + encodeURIComponent(`Maintenance run had problems: ${errors.join(' | ')}`));
      }
      res.redirect(back + '?msg=' + encodeURIComponent(`Maintenance run finished. ${parts.join(' ')}`));
    } catch (e) {
      res.redirect(back + '?err=' + encodeURIComponent(e.message));
    }
  });

  app.get('/hr/leave-types', requireAuth, requireLeaveAdmin, async (req, res) => {
    try {
      await ensureSchema();
      const fid = facilityId(req);
      const types = await L.loadLeaveTypes(pool, fid, false);
      const policies = await L.loadPolicies(pool, fid);
      const rows = types.map((type) => ({ ...type, policy: policies[type.code] || {} }));
      const [[schedule]] = await pool.query(
        'SELECT * FROM tbl_hms_work_schedule WHERE facility_id = ? ORDER BY active DESC, id LIMIT 1',
        [fid]
      ).catch(() => [[null]]);
      const attendancePolicy = await AttendancePolicy.loadPolicy(pool, fid);
      const notes = await notificationsFor(req);
      res.render('hr-leave-types', {
        title: 'Leave policy — ZAIZENS',
        rows,
        schedule,
        attendancePolicy,
        notifications: notes.rows,
        unreadNotifications: notes.unread,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/hr/leave-types', requireAuth, requireLeaveAdmin, async (req, res) => {
    const fid = facilityId(req);
    const codes = arr(req.body.code);
    try {
      await ensureSchema();
      if (!codes.length) return res.redirect('/hr/leave-types?err=' + encodeURIComponent('No leave types submitted.'));
      for (let i = 0; i < codes.length; i += 1) {
        const code = String(codes[i] || '').trim().toLowerCase().slice(0, 32);
        if (!code) continue;
        const label = String(req.body[`label_${code}`] || code).trim().slice(0, 120);
        const unit = String(req.body[`unit_${code}`] || 'day') === 'hour' ? 'hour' : 'day';
        await pool.query(
          `INSERT INTO tbl_hms_leave_type (facility_id, code, label, paid, balance_tracked, unit, requires_document, active, sort_order)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE label = VALUES(label), paid = VALUES(paid), balance_tracked = VALUES(balance_tracked),
             unit = VALUES(unit), requires_document = VALUES(requires_document), active = VALUES(active), sort_order = VALUES(sort_order)`,
          [fid, code, label, bool(req.body[`paid_${code}`]), bool(req.body[`balance_tracked_${code}`]), unit,
           bool(req.body[`requires_document_${code}`]), bool(req.body[`active_${code}`]), (i + 1) * 10]
        );
        await pool.query(
          `INSERT INTO tbl_hms_leave_policy
            (facility_id, leave_type, annual_days, accrual_method, prorate, carryover_max, max_consecutive_days,
             notice_days, negative_balance_allowed, approval_levels)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE annual_days = VALUES(annual_days), accrual_method = VALUES(accrual_method),
             prorate = VALUES(prorate), carryover_max = VALUES(carryover_max), max_consecutive_days = VALUES(max_consecutive_days),
             notice_days = VALUES(notice_days), negative_balance_allowed = VALUES(negative_balance_allowed), approval_levels = VALUES(approval_levels)`,
          [fid, code, Math.max(0, num(req.body[`annual_days_${code}`], 0)),
           String(req.body[`accrual_method_${code}`] || 'annual').slice(0, 16), bool(req.body[`prorate_${code}`]),
           Math.max(0, num(req.body[`carryover_max_${code}`], 0)), Math.max(0, num(req.body[`max_consecutive_days_${code}`], 0)),
           Math.max(0, int(req.body[`notice_days_${code}`], 0)), bool(req.body[`negative_balance_allowed_${code}`]),
           Math.max(1, Math.min(3, int(req.body[`approval_levels_${code}`], 1)))]
        );
      }
      await audit(req, 'hr.leave.policy_save', null, `Leave policy saved for ${codes.length} type(s).`);
      res.redirect('/hr/leave-types?msg=' + encodeURIComponent('Leave types and policies saved.'));
    } catch (e) {
      res.redirect('/hr/leave-types?err=' + encodeURIComponent(e.message));
    }
  });

  app.post('/hr/leave-settings/schedule', requireAuth, requireLeaveAdmin, async (req, res) => {
    const fid = facilityId(req);
    const name = String(req.body.name || 'Default schedule').trim().slice(0, 120) || 'Default schedule';
    const start = String(req.body.start_time || '08:00').slice(0, 8);
    const end = String(req.body.end_time || '17:00').slice(0, 8);
    const breakMinutes = Math.max(0, Math.min(240, int(req.body.break_minutes, 0)));
    const grace = Math.max(0, Math.min(120, int(req.body.grace_minutes, 10)));
    const workDays = String(req.body.work_days || '1,2,3,4,5').replace(/[^0-6,]/g, '').slice(0, 20) || '1,2,3,4,5';
    try {
      await ensureSchema();
      await pool.query(
        `INSERT INTO tbl_hms_work_schedule (facility_id, name, start_time, end_time, break_minutes, grace_minutes, work_days, active)
         VALUES (?,?,?,?,?,?,?,1)
         ON DUPLICATE KEY UPDATE start_time = VALUES(start_time), end_time = VALUES(end_time),
           break_minutes = VALUES(break_minutes), grace_minutes = VALUES(grace_minutes), work_days = VALUES(work_days), active = 1`,
        [fid, name, start, end, breakMinutes, grace, workDays]
      );
      await audit(req, 'hr.leave.schedule_save', null, `Work schedule ${name} saved: ${start}-${end}.`);
      res.redirect('/hr/leave-types?msg=' + encodeURIComponent('Work schedule saved.'));
    } catch (e) {
      res.redirect('/hr/leave-types?err=' + encodeURIComponent(e.message));
    }
  });

  app.get('/hr/leave-employees', requireAuth, requireLeaveAdmin, async (req, res) => {
    try {
      await ensureSchema();
      const fid = facilityId(req);
      const [staff] = await pool.query(
        `SELECT e.id, e.first_name, e.last_name, e.employee_id AS employee_ref, e.manager_id,
                e.employment_type, e.grade, e.probation_end, e.termination_date, e.work_schedule_id,
                m.first_name AS manager_first, m.last_name AS manager_last
           FROM tbl_employee e
           LEFT JOIN tbl_employee m ON m.id = e.manager_id
          WHERE e.status = 1 AND (e.default_facility_id IS NULL OR e.default_facility_id = ?)
          ORDER BY e.last_name, e.first_name`,
        [fid]
      );
      const [managers] = await pool.query(
        'SELECT id, first_name, last_name FROM tbl_employee WHERE status = 1 AND (default_facility_id IS NULL OR default_facility_id = ?) ORDER BY last_name, first_name',
        [fid]
      );
      const [schedules] = await pool.query('SELECT * FROM tbl_hms_work_schedule WHERE facility_id = ? AND active = 1 ORDER BY name', [fid]);
      const notes = await notificationsFor(req);
      res.render('hr-leave-employees', {
        title: 'Leave employee settings — ZAIZENS',
        staff: staff || [],
        managers: managers || [],
        schedules: schedules || [],
        notifications: notes.rows,
        unreadNotifications: notes.unread,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/hr/leave-employees', requireAuth, requireLeaveAdmin, async (req, res) => {
    const fid = facilityId(req);
    try {
      await ensureSchema();
      const [staff] = await pool.query(
        'SELECT id FROM tbl_employee WHERE status = 1 AND (default_facility_id IS NULL OR default_facility_id = ?)',
        [fid]
      );
      for (const employee of staff || []) {
        const id = employee.id;
        const manager = int(req.body[`manager_${id}`], 0) || null;
        const employment = String(req.body[`employment_type_${id}`] || 'permanent').trim().slice(0, 40);
        const grade = String(req.body[`grade_${id}`] || '').trim().slice(0, 40) || null;
        const probation = String(req.body[`probation_end_${id}`] || '').trim().slice(0, 10) || null;
        const termination = String(req.body[`termination_date_${id}`] || '').trim().slice(0, 10) || null;
        const schedule = int(req.body[`work_schedule_id_${id}`], 0) || null;
        await pool.query(
          `UPDATE tbl_employee SET manager_id = ?, employment_type = ?, grade = ?, probation_end = ?,
             termination_date = ?, work_schedule_id = ? WHERE id = ?`,
          [manager === id ? null : manager, employment, grade, probation || null, termination || null, schedule, id]
        );
      }
      await audit(req, 'hr.leave.employee_settings', null, 'Reporting lines, employment types and schedules updated.');
      res.redirect('/hr/leave-employees?msg=' + encodeURIComponent('Employee leave settings saved.'));
    } catch (e) {
      res.redirect('/hr/leave-employees?err=' + encodeURIComponent(e.message));
    }
  });

  app.get('/hr/leave-calendar', requireAuth, requireHrSelfService, async (req, res) => {
    try {
      await ensureSchema();
      const fid = facilityId(req);
      const now = new Date();
      const year = Math.max(2000, Math.min(2100, int(req.query.year, now.getFullYear())));
      const month = Math.max(1, Math.min(12, int(req.query.month, now.getMonth() + 1)));
      const calendar = await W.loadCalendar(pool, fid, year, month);
      const types = await L.loadLeaveTypes(pool, fid, false);
      const notes = await notificationsFor(req);
      res.render('hr-leave-calendar', {
        title: 'Leave calendar — ZAIZENS',
        year,
        month,
        calendar,
        labels: typeLabelMap(types),
        notifications: notes.rows,
        unreadNotifications: notes.unread,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  async function leaveReportData(req) {
    const fid = facilityId(req);
    const from = String(req.query.from || `${new Date().getFullYear()}-01-01`).slice(0, 10);
    const to = String(req.query.to || L.todayIso()).slice(0, 10);
    const status = String(req.query.status || '').trim().toLowerCase();
    const leaveType = String(req.query.leave_type || '').trim();
    const where = ['r.facility_id = ?', 'd.leave_date BETWEEN ? AND ?'];
    const params = [fid, from, to];
    if (status) { where.push('r.status = ?'); params.push(status); }
    if (leaveType) { where.push('r.leave_type = ?'); params.push(leaveType); }
    const [rows] = await pool.query(
      `SELECT r.id, r.employee_id, r.leave_type, r.status, r.start_date, r.end_date, r.duration_unit,
              r.half_day_period, d.leave_date, d.leave_year, d.days, d.minutes,
              e.first_name, e.last_name, e.employee_id AS employee_ref
         FROM tbl_hms_leave_request r
         JOIN tbl_hms_leave_request_day d ON d.request_id = r.id
         JOIN tbl_employee e ON e.id = r.employee_id
        WHERE ${where.join(' AND ')}
        ORDER BY d.leave_date DESC, e.last_name, e.first_name`,
      params
    ).catch(() => [[]]);
    const byEmployee = {};
    for (const row of rows || []) {
      const key = `${row.employee_id}|${row.leave_type}|${row.status}`;
      if (!byEmployee[key]) {
        byEmployee[key] = {
          employee_id: row.employee_id,
          employee_ref: row.employee_ref,
          employee_name: employeeName(row),
          leave_type: row.leave_type,
          status: row.status,
          days: 0,
          requests: new Set(),
        };
      }
      byEmployee[key].days += n(row.days);
      byEmployee[key].requests.add(row.id);
    }
    const summary = Object.values(byEmployee).map((row) => ({ ...row, requests: row.requests.size }));
    const types = await L.loadLeaveTypes(pool, fid, false);
    return { from, to, status, leaveType, rows: rows || [], summary, types, labels: typeLabelMap(types) };
  }

  app.get('/hr/leave-reports', requireAuth, requireLeaveAdmin, async (req, res) => {
    try {
      await ensureSchema();
      const data = await leaveReportData(req);
      const notes = await notificationsFor(req);
      res.render('hr-leave-reports', {
        title: 'Leave reports — ZAIZENS',
        ...data,
        notifications: notes.rows,
        unreadNotifications: notes.unread,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.get('/hr/leave-reports.csv', requireAuth, requireLeaveAdmin, async (req, res) => {
    try {
      await ensureSchema();
      const data = await leaveReportData(req);
      const lines = [
        ['employee', 'ref', 'leave_type', 'status', 'days', 'requests'].map(csv).join(';'),
        ...data.summary.map((row) => [
          row.employee_name, row.employee_ref || row.employee_id, data.labels[row.leave_type] || row.leave_type,
          row.status, row.days.toFixed(2), row.requests,
        ].map(csv).join(';')),
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="leave_report_${data.from}_${data.to}.csv"`);
      res.send('\uFEFF' + lines.join('\r\n'));
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // ── Attendance register ──────────────────────────────────────────────────

  app.get('/hr/attendance', requireAuth, requireAttendanceAdmin, async (req, res) => {
    try {
      await ensureSchema();
      const fid = facilityId(req);
      const date = String(req.query.date || '').trim().slice(0, 10) || L.todayIso();
      const data = await W.loadDailyRegister(pool, fid, date);
      const [[schedule]] = await pool.query(
        'SELECT * FROM tbl_hms_work_schedule WHERE facility_id = ? AND active = 1 ORDER BY id LIMIT 1',
        [fid]
      ).catch(() => [[null]]);
      const notes = await notificationsFor(req);
      res.render('hr-attendance', {
        title: 'Staff attendance — ZAIZENS',
        date,
        staff: data.staff,
        existing: data.existing,
        summary: data.summary,
        holidayName: data.holidayName,
        schedule,
        notifications: notes.rows,
        unreadNotifications: notes.unread,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/hr/attendance/save', requireAuth, requireAttendanceAdmin, async (req, res) => {
    const fid = facilityId(req);
    const date = String(req.body.date || '').trim().slice(0, 10) || L.todayIso();
    const back = `/hr/attendance?date=${encodeURIComponent(date)}`;
    try {
      await ensureSchema();
      const rows = parseAttendanceBody(req.body);
      const result = await W.saveManualAttendance(pool, { facilityId: fid, date, rows, actorId: sessionEmpId(req) });
      if (!result.ok) {
        const message = result.errors.length ? result.errors.slice(0, 3).join(' ') : 'Attendance could not be saved.';
        return res.redirect(back + '&err=' + encodeURIComponent(message));
      }
      await audit(req, 'hr.attendance.save', null, `Attendance register saved for ${date}: ${result.saved.length} row(s).`);
      res.redirect(back + '&msg=' + encodeURIComponent('Attendance saved.'));
    } catch (e) {
      res.redirect(back + '&err=' + encodeURIComponent(e.message));
    }
  });

  app.post('/hr/attendance/policy', requireAuth, requireLeaveAdmin, async (req, res) => {
    const fid = facilityId(req);
    try {
      await ensureSchema();
      const policy = await AttendancePolicy.savePolicy(pool, fid, req.body);
      await audit(
        req,
        'hr.attendance.policy',
        null,
        `Attendance policy saved: ${policy.monthly_work_days} work days, ${policy.standard_daily_hours}h day, overtime x${policy.overtime_multiplier}.`
      );
      res.redirect('/hr/leave-types?msg=' + encodeURIComponent('Attendance and payroll policy saved.'));
    } catch (e) {
      res.redirect('/hr/leave-types?err=' + encodeURIComponent(e.message));
    }
  });

  app.get('/hr/attendance/export.csv', requireAuth, requireAttendanceAdmin, async (req, res) => {
    const fid = facilityId(req);
    const today = L.todayIso();
    let from = String(req.query.from || '').slice(0, 10);
    let to = String(req.query.to || '').slice(0, 10);
    if (!L.parseDate(from)) from = `${today.slice(0, 8)}01`;
    if (!L.parseDate(to)) to = from;
    if (to < from) [from, to] = [to, from];
    if (L.dateRange(from, to).length > 366) to = L.addDays(from, 365) || to;
    try {
      await ensureSchema();
      const employeeId = int(req.query.employee_id, 0);
      const [rows] = await pool.query(
        `SELECT a.att_date, a.status, a.check_in_time, a.check_out_time, a.worked_minutes,
                a.late_minutes, a.early_minutes, a.overtime_minutes, a.source, a.notes,
                e.id AS employee_pk, e.employee_id AS employee_code, e.first_name, e.last_name
           FROM tbl_hms_attendance a
           JOIN tbl_employee e ON e.id = a.employee_id
          WHERE a.facility_id = ? AND a.att_date BETWEEN ? AND ?
            AND (? = 0 OR e.id = ?)
          ORDER BY a.att_date, e.last_name, e.first_name`,
        [fid, from, to, employeeId, employeeId]
      );
      const header = ['Employee code', 'Employee ID', 'Employee', 'Date', 'Status', 'Check in', 'Check out',
        'Worked minutes', 'Late minutes', 'Early minutes', 'Overtime minutes', 'Source', 'Notes'];
      const lines = [header.map(csv).join(',')];
      for (const row of rows || []) {
        lines.push([
          row.employee_code || '', row.employee_pk, `${row.first_name || ''} ${row.last_name || ''}`.trim(),
          L.isoDate(row.att_date), row.status, String(row.check_in_time || '').slice(0, 8),
          String(row.check_out_time || '').slice(0, 8), Number(row.worked_minutes) || 0,
          Number(row.late_minutes) || 0, Number(row.early_minutes) || 0, Number(row.overtime_minutes) || 0,
          row.source || '', row.notes || '',
        ].map(csv).join(','));
      }
      await audit(req, 'hr.attendance.export', employeeId || null, `Attendance CSV exported ${from} to ${to} (${(rows || []).length} row(s)).`);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_${to}.csv"`);
      res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });
};