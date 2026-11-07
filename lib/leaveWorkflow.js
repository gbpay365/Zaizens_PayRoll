'use strict';

const L = require('./leaveSystem');

function n(value) {
  const v = Number(value);
  return Number.isFinite(v) ? v : 0;
}

function round2(value) {
  return Math.round(n(value) * 100) / 100;
}

async function notify(pool, facilityId, employeeId, title, body, link) {
  if (!employeeId) return;
  await pool.query(
    'INSERT INTO tbl_hms_leave_notification (facility_id, employee_id, title, body, link) VALUES (?,?,?,?,?)',
    [facilityId, employeeId, String(title).slice(0, 160), String(body || '').slice(0, 1000), String(link || '').slice(0, 255)]
  ).catch(() => {});
}

async function notifyApprovers(pool, facilityId, managerId, excludeId, title, body, link) {
  const ids = new Set();
  if (managerId) ids.add(Number(managerId));
  const [rows] = await pool.query(
    `SELECT DISTINCT e.id
       FROM tbl_employee e
      WHERE e.status = 1
        AND (e.default_facility_id IS NULL OR e.default_facility_id = ?)
        AND (
          e.role IN ('1','99')
          OR e.role IN (
            SELECT rp.role FROM tbl_acl_role_permission rp
            JOIN tbl_acl_permission p ON p.id = rp.permission_id
            WHERE p.code = 'hr.leave.approve'
          )
        )`,
    [facilityId]
  ).catch(() => [[]]);
  for (const row of rows || []) ids.add(Number(row.id));
  for (const id of ids) {
    if (id && id !== Number(excludeId)) await notify(pool, facilityId, id, title, body, link);
  }
}

async function history(conn, requestId, step, approverId, action, comment) {
  await conn.query(
    'INSERT INTO tbl_hms_leave_approval (request_id, step, approver_id, action, comment) VALUES (?,?,?,?,?)',
    [requestId, step || 1, approverId || null, action, String(comment || '').slice(0, 1000) || null]
  );
}

async function insertDayRows(conn, requestId, rows) {
  for (const row of rows || []) {
    await conn.query(
      `INSERT INTO tbl_hms_leave_request_day (request_id, leave_date, leave_year, days, minutes, is_working_day)
       VALUES (?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE days = VALUES(days), minutes = VALUES(minutes), leave_year = VALUES(leave_year)`,
      [requestId, row.date, Number(String(row.date).slice(0, 4)) || new Date().getFullYear(), n(row.days), parseInt(row.minutes, 10) || 0]
    );
  }
}

async function ledger(conn, facilityId, employeeId, leaveType, year, entryType, days, requestId, note, actorId) {
  await conn.query(
    `INSERT INTO tbl_hms_leave_ledger
      (facility_id, employee_id, leave_type, leave_year, entry_date, entry_type, days, request_id, note, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [facilityId, employeeId, leaveType, year, L.todayIso(), entryType, round2(days), requestId || null, String(note || '').slice(0, 500), actorId || null]
  );
}

async function approvedLeaveForDate(conn, facilityId, employeeId, date) {
  const [[row]] = await conn.query(
    `SELECT r.id, r.leave_type, r.duration_unit, r.half_day_period, r.start_time, r.end_time,
            d.days, d.minutes
       FROM tbl_hms_leave_request r
       JOIN tbl_hms_leave_request_day d ON d.request_id = r.id
      WHERE r.facility_id = ? AND r.employee_id = ? AND r.status = 'approved' AND d.leave_date = ?
      ORDER BY d.days DESC LIMIT 1`,
    [facilityId, employeeId, date]
  ).catch(() => [[null]]);
  return row || null;
}

async function upsertLeaveAttendance(conn, facilityId, employeeId, request, date, actorId) {
  const [[existing]] = await conn.query(
    'SELECT * FROM tbl_hms_attendance WHERE facility_id = ? AND employee_id = ? AND att_date = ? LIMIT 1 FOR UPDATE',
    [facilityId, employeeId, date]
  );
  const fullDay = request && n(request.days) >= 1 ? 1 : 0;
  const status = fullDay ? 'on-leave' : (existing && existing.status ? existing.status : 'present');
  const cin = fullDay ? null : (existing && existing.check_in_time) || null;
  const cout = fullDay ? null : (existing && existing.check_out_time) || null;
  const note = `Approved ${String(request.leave_type).replace(/_/g, ' ')} leave` + (fullDay ? '' : ' (partial day)');
  await conn.query(
    `INSERT INTO tbl_hms_attendance
      (facility_id, employee_id, att_date, check_in_time, check_out_time, status, notes,
       leave_request_id, source, scheduled_in, scheduled_out, worked_minutes, late_minutes, early_minutes, overtime_minutes, locked)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,1)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status), check_in_time = VALUES(check_in_time), check_out_time = VALUES(check_out_time),
       notes = VALUES(notes), leave_request_id = VALUES(leave_request_id), source = 'approved_leave', locked = 1`,
    [facilityId, employeeId, date, cin, cout, status, note, request.id, 'approved_leave', null, null]
  );
  if (existing && (existing.status !== status || existing.source !== 'approved_leave')) {
    await conn.query(
      `INSERT INTO tbl_hms_attendance_audit
        (facility_id, employee_id, att_date, actor_id, action, old_status, new_status, old_in, old_out, new_in, new_out, reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [facilityId, employeeId, date, actorId || null, 'leave_sync', existing.status, status, existing.check_in_time, existing.check_out_time, cin, cout, note]
    );
  }
}

async function submitLeave(pool, payload) {
  const { facilityId, employeeId, leaveType, start, end, unit, startTime, endTime, halfDayPeriod, reason, attachment, actorId } = payload;
  const types = await L.loadLeaveTypes(pool, facilityId, true);
  const type = types.find((row) => String(row.code) === String(leaveType));
  if (!type) return { ok: false, error: 'Select an active leave type.' };
  const policies = await L.loadPolicies(pool, facilityId);
  const policy = policies[String(type.code)] || {};
  const [[employee]] = await pool.query(
    'SELECT id, first_name, last_name, joining_date, manager_id, work_schedule_id, probation_end, termination_date FROM tbl_employee WHERE id = ? LIMIT 1',
    [employeeId]
  ).catch(() => [[null]]);
  if (!employee) return { ok: false, error: 'Employee record not found.' };
  if (employee.termination_date && L.isoDate(employee.termination_date) <= L.todayIso()) {
    return { ok: false, error: 'Leave cannot be requested for a terminated employee.' };
  }
  if (!start || !end || !L.parseDate(start) || !L.parseDate(end) || end < start) {
    return { ok: false, error: 'Enter a valid start and end date.' };
  }
  if (policy.notice_days && start < L.addDays(L.todayIso(), policy.notice_days)) {
    return { ok: false, error: `This leave type needs ${policy.notice_days} day(s) notice.` };
  }
  const holidays = await L.loadHolidaySet(pool, facilityId, start, end);
  const [[schedule]] = await pool.query(
    'SELECT * FROM tbl_hms_work_schedule WHERE facility_id = ? AND active = 1 AND (id = ? OR ? IS NULL) ORDER BY (id = ?) DESC, id LIMIT 1',
    [facilityId, employee.work_schedule_id, employee.work_schedule_id, employee.work_schedule_id]
  ).catch(() => [[null]]);
  const workDays = L.workdaySet(schedule && schedule.work_days);
  const duration = L.calculateDuration({ start, end, unit, startTime, endTime, halfDayPeriod, holidays, workDays });
  if (!duration.ok) return { ok: false, error: duration.error };
  if (policy.max_consecutive_days && duration.days > n(policy.max_consecutive_days)) {
    return { ok: false, error: `This leave type is limited to ${policy.max_consecutive_days} day(s) per request.` };
  }
  const [[overlap]] = await pool.query(
    `SELECT id FROM tbl_hms_leave_request
      WHERE facility_id = ? AND employee_id = ? AND status IN ('pending','approved')
        AND NOT (end_date < ? OR start_date > ?) LIMIT 1`,
    [facilityId, employeeId, start, end]
  ).catch(() => [[null]]);
  if (overlap) return { ok: false, error: 'Those dates overlap an existing leave request.' };
  if (type.requires_document && !payload.attachmentName) {
    return { ok: false, error: `${type.label} requires a supporting document.` };
  }
  const balances = await L.getBalancesForEmployee(pool, facilityId, employeeId, (L.parseDate(start) || new Date()).getFullYear());
  const balance = (balances.rows || []).find((row) => row.leave_type === type.code);
  if (type.balance_tracked && balance && balance.remaining < duration.days && !Number(policy.negative_balance_allowed)) {
    return { ok: false, error: `Insufficient ${type.label.toLowerCase()} balance (${round2(balance.remaining)} day(s) available).` };
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO tbl_hms_leave_request
        (facility_id, employee_id, leave_type, start_date, end_date, days_requested, status, reason,
         duration_unit, start_time, end_time, half_day_period, total_hours, manager_id, current_step,
         submitted_at, attachment_name, attachment_path, policy_snapshot)
       VALUES (?,?,?,?,?,?, 'pending', ?,?,?,?,?,?,?,1,NOW(),?,?,?)`,
      [facilityId, employeeId, type.code, start, end, duration.days, reason || null, String(unit || 'day'),
       startTime || null, endTime || null, halfDayPeriod || null, duration.minutes ? round2(duration.minutes / 60) : null,
       employee.manager_id || null, payload.attachmentName || null, payload.attachmentPath || null, JSON.stringify(policy)]
    );
    const requestId = result.insertId;
    await conn.query('UPDATE tbl_hms_leave_request SET request_no = ? WHERE id = ?', [`LV-${(L.parseDate(start) || new Date()).getFullYear()}-${String(requestId).padStart(5, '0')}`, requestId]);
    await insertDayRows(conn, requestId, duration.rows);
    await history(conn, requestId, 1, actorId, 'submitted', reason || null);
    await conn.commit();
    await notifyApprovers(pool, facilityId, employee.manager_id, employeeId, 'Leave request waiting', `${employee.first_name} ${employee.last_name} requested ${type.label.toLowerCase()} (${duration.days} day(s)).`, '/hr/leave-requests');
    return { ok: true, requestId, days: duration.days, type, employee };
  } catch (e) {
    await conn.rollback().catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    conn.release();
  }
}

async function approveLeave(pool, { facilityId, requestId, actorId, comment, canFinal }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[request]] = await conn.query(
      'SELECT * FROM tbl_hms_leave_request WHERE id = ? AND facility_id = ? LIMIT 1 FOR UPDATE',
      [requestId, facilityId]
    );
    if (!request) throw new Error('Leave request not found.');
    if (String(request.status) !== 'pending') throw new Error('This request is no longer pending.');
    if (Number(request.employee_id) === Number(actorId)) throw new Error('You cannot approve your own leave request.');
    const [[employee]] = await conn.query('SELECT first_name, last_name, manager_id FROM tbl_employee WHERE id = ? LIMIT 1', [request.employee_id]);
    const policies = await L.loadPolicies(conn, facilityId);
    const policy = policies[String(request.leave_type)] || {};
    const levels = Math.max(1, parseInt(policy.approval_levels, 10) || 1);
    const isManager = request.manager_id && Number(request.manager_id) === Number(actorId);
    const currentStep = parseInt(request.current_step, 10) || 1;
    if (!canFinal && isManager && levels > 1 && currentStep < levels) {
      await conn.query('UPDATE tbl_hms_leave_request SET current_step = ?, updated_at = NOW() WHERE id = ?', [currentStep + 1, requestId]);
      await history(conn, requestId, currentStep, actorId, 'forwarded', comment || 'Manager approved; forwarded to HR.');
      await conn.commit();
      await notify(pool, facilityId, request.employee_id, 'Leave request progressed', 'Your manager approved the request and forwarded it to HR.', '/hr/request-leave');
      await notifyApprovers(pool, facilityId, null, actorId, 'Leave request needs HR approval', `${employee?.first_name || 'An employee'} ${employee?.last_name || ''} has a leave request awaiting final approval.`, '/hr/leave-requests');
      return { ok: true, status: 'forwarded' };
    }
    if (!canFinal && !isManager) throw new Error('You are not an approver for this request.');
    const [[dayCheck]] = await conn.query('SELECT COUNT(*) AS c FROM tbl_hms_leave_request_day WHERE request_id = ?', [requestId]);
    let daysRows = [];
    if (!Number(dayCheck?.c)) {
      daysRows = L.dateRange(request.start_date, request.end_date).map((date) => ({ date, days: 1, minutes: 480 }));
      await insertDayRows(conn, requestId, daysRows);
    }
    const [dayRows] = await conn.query('SELECT * FROM tbl_hms_leave_request_day WHERE request_id = ? ORDER BY leave_date', [requestId]);
    await conn.query(
      `UPDATE tbl_hms_leave_request SET status = 'approved', approved_by = ?, approved_at = NOW(),
        current_step = ?, rejection_reason = NULL, updated_at = NOW() WHERE id = ?`,
      [actorId, levels, requestId]
    );
    await history(conn, requestId, currentStep, actorId, 'approved', comment || null);
    for (const day of dayRows || []) {
      await ledger(conn, facilityId, request.employee_id, request.leave_type, day.leave_year, 'usage', -n(day.days), requestId, `Approved ${request.leave_type} leave`, actorId);
      await upsertLeaveAttendance(conn, facilityId, request.employee_id, { ...request, days: day.days }, day.leave_date, actorId);
    }
    await conn.commit();
    await notify(pool, facilityId, request.employee_id, 'Leave approved', `Your ${String(request.leave_type).replace(/_/g, ' ')} request for ${request.start_date} to ${request.end_date} was approved.`, '/hr/request-leave');
    return { ok: true, status: 'approved' };
  } catch (e) {
    await conn.rollback().catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    conn.release();
  }
}

async function rejectLeave(pool, { facilityId, requestId, actorId, comment, canFinal }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[request]] = await conn.query(
      'SELECT * FROM tbl_hms_leave_request WHERE id = ? AND facility_id = ? LIMIT 1 FOR UPDATE',
      [requestId, facilityId]
    );
    if (!request) throw new Error('Leave request not found.');
    if (String(request.status) !== 'pending') throw new Error('This request is no longer pending.');
    if (Number(request.employee_id) === Number(actorId)) throw new Error('You cannot reject your own leave request.');
    const isManager = request.manager_id && Number(request.manager_id) === Number(actorId);
    if (!canFinal && !isManager) throw new Error('You are not an approver for this request.');
    await conn.query(
      `UPDATE tbl_hms_leave_request SET status = 'rejected', approved_by = ?, rejected_at = NOW(),
        rejection_reason = ?, updated_at = NOW() WHERE id = ?`,
      [actorId, String(comment || '').slice(0, 1000) || null, requestId]
    );
    await history(conn, requestId, parseInt(request.current_step, 10) || 1, actorId, 'rejected', comment || null);
    await conn.commit();
    await notify(pool, facilityId, request.employee_id, 'Leave request rejected', String(comment || 'Your leave request was rejected.').slice(0, 500), '/hr/request-leave');
    return { ok: true, status: 'rejected' };
  } catch (e) {
    await conn.rollback().catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    conn.release();
  }
}

async function cancelLeave(pool, { facilityId, requestId, actorId, isHr }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[request]] = await conn.query(
      'SELECT * FROM tbl_hms_leave_request WHERE id = ? AND facility_id = ? LIMIT 1 FOR UPDATE',
      [requestId, facilityId]
    );
    if (!request) throw new Error('Leave request not found.');
    if (!isHr && Number(request.employee_id) !== Number(actorId)) throw new Error('You can only cancel your own leave.');
    if (!['pending', 'approved'].includes(String(request.status))) throw new Error('This request cannot be cancelled.');
    if (String(request.status) === 'approved') {
      const [dayRows] = await conn.query('SELECT * FROM tbl_hms_leave_request_day WHERE request_id = ?', [requestId]);
      for (const day of dayRows || []) {
        await ledger(conn, facilityId, request.employee_id, request.leave_type, day.leave_year, 'cancellation', n(day.days), requestId, 'Approved leave cancelled', actorId);
      }
      await conn.query(
        "DELETE FROM tbl_hms_attendance WHERE facility_id = ? AND employee_id = ? AND leave_request_id = ? AND att_date >= CURDATE()",
        [facilityId, request.employee_id, requestId]
      );
    }
    await conn.query(
      "UPDATE tbl_hms_leave_request SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = ?, updated_at = NOW() WHERE id = ?",
      [actorId, requestId]
    );
    await history(conn, requestId, parseInt(request.current_step, 10) || 1, actorId, 'cancelled', isHr ? 'Cancelled by HR' : 'Cancelled by employee');
    await conn.commit();
    await notify(pool, facilityId, request.employee_id, 'Leave cancelled', `Your ${String(request.leave_type).replace(/_/g, ' ')} request was cancelled.`, '/hr/request-leave');
    return { ok: true };
  } catch (e) {
    await conn.rollback().catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    conn.release();
  }
}

async function scheduleForEmployee(conn, facilityId, employeeId) {
  const [[employee]] = await conn.query('SELECT work_schedule_id FROM tbl_employee WHERE id = ? LIMIT 1', [employeeId]);
  const [[schedule]] = await conn.query(
    'SELECT * FROM tbl_hms_work_schedule WHERE facility_id = ? AND active = 1 AND (id = ? OR ? IS NULL) ORDER BY (id = ?) DESC, id LIMIT 1',
    [facilityId, employee && employee.work_schedule_id, employee && employee.work_schedule_id, employee && employee.work_schedule_id]
  );
  return schedule || { start_time: '08:00:00', end_time: '17:00:00', break_minutes: 0, grace_minutes: 10 };
}

function clockMinutes(value) {
  return L.parseTimeMinutes(value);
}

async function rebuildAttendanceFromPunches(conn, facilityId, employeeId, date, actorId) {
  const [[existing]] = await conn.query(
    'SELECT * FROM tbl_hms_attendance WHERE facility_id = ? AND employee_id = ? AND att_date = ? LIMIT 1 FOR UPDATE',
    [facilityId, employeeId, date]
  );
  if (existing && Number(existing.locked) === 1) return { ok: true, skipped: true, attendance: existing };
  const [punches] = await conn.query(
    "SELECT *, DATE_FORMAT(punched_at, '%H:%i:%s') AS punch_time FROM tbl_hms_attendance_punch WHERE facility_id = ? AND employee_id = ? AND punch_date = ? ORDER BY punched_at, id",
    [facilityId, employeeId, date]
  );
  const ins = (punches || []).filter((p) => String(p.direction) === 'in');
  const outs = (punches || []).filter((p) => String(p.direction) === 'out');
  const firstIn = ins[0] || null;
  const lastOut = outs.length ? outs[outs.length - 1] : null;
  if (!firstIn && !lastOut) return { ok: false, error: 'No punches found for that date.' };
  const schedule = await scheduleForEmployee(conn, facilityId, employeeId);
  const schedIn = clockMinutes(schedule.start_time);
  const schedOut = clockMinutes(schedule.end_time);
  const inTime = firstIn ? (firstIn.punch_time || String(firstIn.punched_at).slice(11, 19)) : null;
  const outTime = lastOut ? (lastOut.punch_time || String(lastOut.punched_at).slice(11, 19)) : null;
  const inMin = inTime ? clockMinutes(inTime) : null;
  let outMin = outTime ? clockMinutes(outTime) : null;
  if (outMin != null && inMin != null && outMin < inMin) outMin += 1440;
  let worked = inMin != null && outMin != null ? outMin - inMin - (parseInt(schedule.break_minutes, 10) || 0) : 0;
  worked = Math.max(0, worked);
  const late = inMin != null && schedIn != null ? Math.max(0, inMin - (schedIn + (parseInt(schedule.grace_minutes, 10) || 0))) : 0;
  const early = outMin != null && schedOut != null ? Math.max(0, schedOut - outMin) : 0;
  const overtime = outMin != null && schedOut != null ? Math.max(0, outMin - schedOut) : 0;
  const leave = await approvedLeaveForDate(conn, facilityId, employeeId, date);
  let status = late > 0 ? 'late' : 'present';
  let note = null;
  if (leave && n(leave.days) >= 1) {
    status = 'on-leave';
    note = `Punch recorded during approved ${String(leave.leave_type).replace(/_/g, ' ')} leave`;
  } else if (leave) {
    note = `Partial ${String(leave.leave_type).replace(/_/g, ' ')} leave (${leave.minutes || 0} minutes)`;
  }
  await conn.query(
    `INSERT INTO tbl_hms_attendance
      (facility_id, employee_id, att_date, check_in_time, check_out_time, status, notes, leave_request_id,
       source, scheduled_in, scheduled_out, worked_minutes, late_minutes, early_minutes, overtime_minutes, locked, updated_by)
     VALUES (?,?,?,?,?,?,?,?, 'clock', ?,?,?,?,?,?,0,?)
     ON DUPLICATE KEY UPDATE check_in_time = VALUES(check_in_time), check_out_time = VALUES(check_out_time),
       status = VALUES(status), notes = VALUES(notes), leave_request_id = VALUES(leave_request_id), source = 'clock',
       scheduled_in = VALUES(scheduled_in), scheduled_out = VALUES(scheduled_out), worked_minutes = VALUES(worked_minutes),
       late_minutes = VALUES(late_minutes), early_minutes = VALUES(early_minutes), overtime_minutes = VALUES(overtime_minutes),
       updated_by = VALUES(updated_by)`,
    [facilityId, employeeId, date, inTime,
     outTime, status, note, leave ? leave.id : null,
     schedule.start_time, schedule.end_time, worked, late, early, overtime, actorId || null]
  );
  if (existing) {
    await conn.query(
      `INSERT INTO tbl_hms_attendance_audit
        (facility_id, employee_id, att_date, actor_id, action, old_status, new_status, old_in, old_out, new_in, new_out, reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [facilityId, employeeId, date, actorId || null, 'clock_rebuild', existing.status, status,
       existing.check_in_time, existing.check_out_time, inTime, outTime, 'Derived from clock punches']
    );
  }
  return { ok: true, status, workedMinutes: worked, lateMinutes: late, earlyMinutes: early, overtimeMinutes: overtime };
}

async function recordPunch(pool, { facilityId, employeeId, direction, source, ip, device, note, actorId, punchedAt }) {
  if (!['in', 'out'].includes(String(direction))) return { ok: false, error: 'Choose clock in or clock out.' };
  const now = punchedAt ? new Date(punchedAt) : new Date();
  if (Number.isNaN(now.getTime())) return { ok: false, error: 'Invalid punch timestamp.' };
  const date = L.isoDate(now);
  const stamp = `${date} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO tbl_hms_attendance_punch
        (facility_id, employee_id, punch_date, punched_at, direction, source, ip, device, note, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [facilityId, employeeId, date, stamp, String(direction), source || 'web', String(ip || '').slice(0, 64), String(device || '').slice(0, 120), String(note || '').slice(0, 500) || null, actorId || null]
    );
    const result = await rebuildAttendanceFromPunches(conn, facilityId, employeeId, date, actorId);
    if (!result.ok) throw new Error(result.error || 'Could not derive attendance.');
    await conn.commit();
    return { ok: true, date, ...result };
  } catch (e) {
    await conn.rollback().catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    conn.release();
  }
}

async function loadDailyRegister(pool, facilityId, date) {
  const [staff] = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.employee_id, e.work_schedule_id,
            s.start_time, s.end_time, s.break_minutes, s.grace_minutes, s.work_days
       FROM tbl_employee e
       LEFT JOIN tbl_hms_work_schedule s ON s.id = e.work_schedule_id AND s.facility_id = ?
      WHERE e.status = 1 AND (e.default_facility_id IS NULL OR e.default_facility_id = ?)
      ORDER BY e.last_name, e.first_name`,
    [facilityId, facilityId]
  );
  const [attRows] = await pool.query(
    'SELECT * FROM tbl_hms_attendance WHERE facility_id = ? AND att_date = ?',
    [facilityId, date]
  );
  const existing = {};
  for (const row of attRows || []) existing[row.employee_id] = row;
  const [leaveRows] = await pool.query(
    `SELECT r.id, r.employee_id, r.leave_type, r.duration_unit, r.half_day_period,
            d.days, d.minutes
       FROM tbl_hms_leave_request r
       JOIN tbl_hms_leave_request_day d ON d.request_id = r.id
      WHERE r.facility_id = ? AND r.status = 'approved' AND d.leave_date = ?
      ORDER BY d.days DESC, r.id`,
    [facilityId, date]
  ).catch(() => [[]]);
  const leaveByEmp = {};
  for (const row of leaveRows || []) {
    if (!leaveByEmp[row.employee_id] || n(row.days) > n(leaveByEmp[row.employee_id].days)) leaveByEmp[row.employee_id] = row;
  }
  for (const employeeId of Object.keys(leaveByEmp)) {
    if (existing[employeeId]) {
      existing[employeeId].leave_type = existing[employeeId].leave_type || leaveByEmp[employeeId].leave_type;
      existing[employeeId].leave_days = n(leaveByEmp[employeeId].days);
      existing[employeeId].leave_minutes = parseInt(leaveByEmp[employeeId].minutes, 10) || 0;
    }
  }
  const holidays = await L.loadHolidaySet(pool, facilityId, date, date);
  const holidayName = holidays.get(date) || null;
  for (const emp of staff || []) {
    if (existing[emp.id]) continue;
    if (leaveByEmp[emp.id]) {
      const leave = leaveByEmp[emp.id];
      existing[emp.id] = {
        status: n(leave.days) >= 1 ? 'on-leave' : 'present',
        check_in_time: null,
        check_out_time: null,
        leave_type: leave.leave_type,
        leave_request_id: leave.id,
        source: 'approved_leave',
        leave_days: n(leave.days),
        leave_minutes: parseInt(leave.minutes, 10) || 0,
      };
    } else if (holidayName) {
      existing[emp.id] = { status: 'holiday', check_in_time: null, check_out_time: null, source: 'holiday', notes: holidayName };
    }
  }
  const summary = { present: 0, late: 0, absent: 0, 'half-day': 0, 'on-leave': 0, holiday: 0, saved: 0 };
  for (const emp of staff || []) {
    const row = existing[emp.id];
    if (row && row.source !== 'approved_leave' && row.source !== 'holiday') summary.saved += 1;
    const st = String((row && row.status) || 'present').toLowerCase();
    if (summary[st] == null) summary[st] = 0;
    summary[st] += 1;
  }
  return { staff: staff || [], existing, summary, holidayName, leaveByEmp };
}

async function saveManualAttendance(pool, { facilityId, date, rows, actorId }) {
  const [allowedRows] = await pool.query(
    'SELECT id FROM tbl_employee WHERE status = 1 AND (default_facility_id IS NULL OR default_facility_id = ?)',
    [facilityId]
  );
  const allowed = new Set((allowedRows || []).map((r) => Number(r.id)));
  const conn = await pool.getConnection();
  const saved = [];
  const errors = [];
  try {
    await conn.beginTransaction();
    for (const row of rows || []) {
      const employeeId = Number(row.employee_id);
      if (!employeeId || !allowed.has(employeeId)) continue;
      const status = String(row.status || 'present').toLowerCase();
      if (!['present', 'late', 'absent', 'half-day', 'on-leave', 'holiday'].includes(status)) {
        errors.push(`Employee #${employeeId}: invalid status.`);
        continue;
      }
      const blankTimes = ['absent', 'on-leave', 'holiday'].includes(status);
      let cin = blankTimes ? null : (row.in ? String(row.in).slice(0, 8) : null);
      let cout = blankTimes ? null : (row.out ? String(row.out).slice(0, 8) : null);
      if (cin && cin.length === 5) cin += ':00';
      if (cout && cout.length === 5) cout += ':00';
      const [[existing]] = await conn.query(
        'SELECT * FROM tbl_hms_attendance WHERE facility_id = ? AND employee_id = ? AND att_date = ? LIMIT 1 FOR UPDATE',
        [facilityId, employeeId, date]
      );
      const changed = !existing || existing.status !== status || String(existing.check_in_time || '') !== String(cin || '') || String(existing.check_out_time || '') !== String(cout || '');
      const reason = String(row.reason || '').trim().slice(0, 500);
      const needsReason = existing && (existing.source === 'clock' || (existing.source === 'approved_leave' && status !== 'on-leave'));
      if (needsReason && !reason) {
        errors.push(`Employee #${employeeId}: a reason is required to override ${existing.source} attendance.`);
        continue;
      }
      const schedule = await scheduleForEmployee(conn, facilityId, employeeId);
      const inMin = clockMinutes(cin);
      const outMin = clockMinutes(cout);
      const schedIn = clockMinutes(schedule.start_time);
      const schedOut = clockMinutes(schedule.end_time);
      const worked = inMin != null && outMin != null ? Math.max(0, (outMin < inMin ? outMin + 1440 : outMin) - inMin - (parseInt(schedule.break_minutes, 10) || 0)) : 0;
      const late = inMin != null && schedIn != null ? Math.max(0, inMin - (schedIn + (parseInt(schedule.grace_minutes, 10) || 0))) : 0;
      const early = outMin != null && schedOut != null ? Math.max(0, schedOut - outMin) : 0;
      const overtime = outMin != null && schedOut != null ? Math.max(0, outMin - schedOut) : 0;
      await conn.query(
        `INSERT INTO tbl_hms_attendance
          (facility_id, employee_id, att_date, check_in_time, check_out_time, status, notes, source,
           scheduled_in, scheduled_out, worked_minutes, late_minutes, early_minutes, overtime_minutes,
           override_reason, updated_by, locked)
         VALUES (?,?,?,?,?,?,?, 'manual', ?,?,?,?,?,?,?,?,1)
         ON DUPLICATE KEY UPDATE check_in_time = VALUES(check_in_time), check_out_time = VALUES(check_out_time),
           status = VALUES(status), notes = VALUES(notes), source = 'manual', scheduled_in = VALUES(scheduled_in),
           scheduled_out = VALUES(scheduled_out), worked_minutes = VALUES(worked_minutes), late_minutes = VALUES(late_minutes),
           early_minutes = VALUES(early_minutes), overtime_minutes = VALUES(overtime_minutes),
           override_reason = VALUES(override_reason), updated_by = VALUES(updated_by), locked = 1`,
        [facilityId, employeeId, date, cin, cout, status, row.notes ? String(row.notes).slice(0, 500) : null,
         schedule.start_time, schedule.end_time, worked, late, early, overtime, reason || null, actorId || null]
      );
      if (changed) {
        await conn.query(
          `INSERT INTO tbl_hms_attendance_audit
            (facility_id, employee_id, att_date, actor_id, action, old_status, new_status, old_in, old_out, new_in, new_out, reason)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [facilityId, employeeId, date, actorId || null, existing ? 'manual_override' : 'manual_create',
           existing ? existing.status : null, status, existing ? existing.check_in_time : null,
           existing ? existing.check_out_time : null, cin, cout, reason || null]
        );
      }
      saved.push(employeeId);
    }
    await conn.commit();
    return { ok: errors.length === 0, saved, errors };
  } catch (e) {
    await conn.rollback().catch(() => {});
    return { ok: false, saved, errors: [...errors, e.message] };
  } finally {
    conn.release();
  }
}

async function loadCalendar(pool, facilityId, year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 0);
  const end = `${year}-${String(month).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
  const holidays = await L.loadHolidaySet(pool, facilityId, start, end);
  const [requests] = await pool.query(
    `SELECT r.id, r.employee_id, r.leave_type, r.status, r.start_date, r.end_date, r.duration_unit,
            r.half_day_period, d.leave_date, d.leave_year, d.days, d.minutes,
            e.first_name, e.last_name
       FROM tbl_hms_leave_request r
       JOIN tbl_hms_leave_request_day d ON d.request_id = r.id
       JOIN tbl_employee e ON e.id = r.employee_id
      WHERE r.facility_id = ? AND d.leave_date BETWEEN ? AND ? AND r.status IN ('pending','approved')
      ORDER BY d.leave_date, e.last_name, e.first_name`,
    [facilityId, start, end]
  ).catch(() => [[]]);
  const byDate = {};
  for (const row of requests || []) {
    const key = L.isoDate(row.leave_date);
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(row);
  }
  const days = [];
  for (const date of L.dateRange(start, end)) {
    const d = L.parseDate(date);
    days.push({ date, day: d.getDate(), weekday: d.getDay(), holiday: holidays.get(date) || null, leave: byDate[date] || [] });
  }
  return { start, end, days, holidays, byDate };
}

module.exports = {
  notify,
  notifyApprovers,
  submitLeave,
  approveLeave,
  rejectLeave,
  cancelLeave,
  recordPunch,
  rebuildAttendanceFromPunches,
  loadDailyRegister,
  saveManualAttendance,
  loadCalendar,
};