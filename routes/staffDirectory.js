'use strict';

const ensureHrPayrollSchema = require('../lib/ensureHrPayrollSchema');
const hmsStaffAccountGuard = require('../lib/hmsStaffAccountGuard');
const { loadRoleTitleMap, resolveRoleTitle } = require('../lib/hmsEmployeeHr');
const { logAdminAction } = require('../lib/adminAudit');

const EMPLOYEE_CHILD_TABLES = [
  'tbl_hms_payroll_record',
  'tbl_hms_pay_profile',
  'tbl_hms_leave_request',
  'tbl_hms_leave_balance',
  'tbl_hms_attendance',
  'tbl_hr_attendance',
];

module.exports = function registerStaffDirectoryRoutes(app, pool, requireAuth) {
  function canDeleteEmployees(req, res) {
    const role = String(req.session.user?.role ?? '');
    if (role === '1' || role === '99') return true;
    const perms = res.locals.userPerms || [];
    return perms.includes('*') || perms.includes('employee.delete');
  }

  function parseIdList(raw) {
    const list = Array.isArray(raw) ? raw : [raw];
    return [...new Set(list.map((v) => parseInt(String(v), 10)).filter((n) => n > 0))];
  }

  /**
   * Remove employees and their login accounts (tbl_employee) together with the
   * payroll, leave and attendance rows that belong to them.
   */
  async function removeEmployees(pool, ids, actorId) {
    if (!ids.length) return { deleted: [], skipped: [] };
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT id, first_name, last_name, username, role FROM tbl_employee WHERE id IN (${placeholders})`,
      ids
    );
    const deleted = [];
    const skipped = [];
    for (const row of rows || []) {
      if (Number(row.id) === Number(actorId)) {
        skipped.push({ id: row.id, reason: 'You cannot delete your own account.' });
        continue;
      }
      if (String(row.role) === '99') {
        skipped.push({ id: row.id, reason: 'Super Admin accounts cannot be deleted.' });
        continue;
      }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const table of EMPLOYEE_CHILD_TABLES) {
          await conn.query(`DELETE FROM ${table} WHERE employee_id = ?`, [row.id]).catch(() => {});
        }
        await conn.query('DELETE FROM tbl_employee WHERE id = ?', [row.id]);
        await conn.commit();
        deleted.push(row);
      } catch (e) {
        await conn.rollback().catch(() => {});
        skipped.push({ id: row.id, reason: e.message || 'Delete failed.' });
      } finally {
        conn.release();
      }
    }
    return { deleted, skipped };
  }

  function requireAdminOrPayrollWrite(req, res, next) {
    const role = String(req.session.user?.role ?? '');
    if (role === '1' || role === '99') return next();
    const perms = res.locals.userPerms || [];
    if (perms.includes('*') || perms.includes('payroll.write')) return next();
    const msg = 'Access denied. Admin or payroll.write required.';
    if (req.method === 'POST' || (req.headers.accept || '').includes('application/json')) {
      return res.status(403).json({ ok: false, error: msg });
    }
    return res.redirect('/payroll?err=' + encodeURIComponent(msg));
  }

  app.get('/staff', requireAuth, async (req, res) => {
    try {
      const fid = Math.max(1, parseInt(req.session.facilityId, 10) || 1);
      const role = String(req.session.user?.role ?? '');
      const perms = res.locals.userPerms || [];
      const canManagePayroll =
        role === '1' || role === '99' || perms.includes('*') || perms.includes('payroll.write');
      const [staff] = await pool.query(
        `SELECT e.id, e.first_name, e.last_name, e.username, e.role, e.primary_department,
                e.job_title, e.status, e.emailid, e.phone, e.employee_id, e.joining_date,
                COALESCE(pp.basic_salary, 0) + COALESCE(pp.housing_allowance, 0)
                  + COALESCE(pp.transport_allowance, 0) AS profile_pay,
                pp.id AS profile_id
         FROM tbl_employee e
         LEFT JOIN tbl_hms_pay_profile pp ON pp.employee_id = e.id AND pp.facility_id = ?
         WHERE ${hmsStaffAccountGuard.STAFF_HEADCOUNT_SQL}
         ORDER BY e.last_name ASC, e.first_name ASC`
        , [fid]
      );
      const roleMap = await loadRoleTitleMap(pool).catch(() => ({}));
      const rows = (Array.isArray(staff) ? staff : []).map((row) => ({
        ...row,
        roleLabel: resolveRoleTitle(row.role, roleMap),
        hasProfile: Boolean(row.profile_id),
        gross: Number(row.profile_pay || 0),
      }));
      res.render('staff', {
        title: 'Staff — ZAIZENS Payroll',
        staff: rows,
        canManagePayroll,
        canDeleteEmployees: canDeleteEmployees(req, res),
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (err) {
      console.error('[staff]', err.message);
      res.status(500).render('error', { title: 'Error', message: err.message || 'Staff load failed.', status: 500 });
    }
  });

  app.post('/staff/bulk-delete', requireAuth, async (req, res) => {
    if (!canDeleteEmployees(req, res)) {
      return res.redirect('/staff?err=' + encodeURIComponent('You do not have permission to delete employees.'));
    }
    const ids = parseIdList(req.body.ids);
    if (!ids.length) return res.redirect('/staff?err=' + encodeURIComponent('Select at least one employee to delete.'));
    try {
      const actorId = Number(req.session.user?.id) || 0;
      const { deleted, skipped } = await removeEmployees(pool, ids, actorId);
      for (const row of deleted) {
        await logAdminAction(pool, req, 'employee.delete', {
          targetType: 'employee',
          targetId: row.id,
          detail: `Deleted employee ${row.first_name} ${row.last_name} (@${row.username || '—'}) and their login account`,
        });
      }
      const msg = `${deleted.length} employee(s) and their accounts deleted.` +
        (skipped.length ? ` ${skipped.length} skipped: ${skipped.map((s) => s.reason).join(' ')}` : '');
      return res.redirect('/staff?msg=' + encodeURIComponent(msg));
    } catch (e) {
      console.error('[staff/bulk-delete]', e.message);
      return res.redirect('/staff?err=' + encodeURIComponent(e.message));
    }
  });

  app.post('/staff/:id/delete', requireAuth, async (req, res) => {
    if (!canDeleteEmployees(req, res)) {
      return res.redirect('/staff?err=' + encodeURIComponent('You do not have permission to delete employees.'));
    }
    const id = parseInt(req.params.id, 10) || 0;
    if (id < 1) return res.redirect('/staff?err=' + encodeURIComponent('Employee not found.'));
    try {
      const actorId = Number(req.session.user?.id) || 0;
      const { deleted, skipped } = await removeEmployees(pool, [id], actorId);
      if (!deleted.length) {
        return res.redirect('/staff?err=' + encodeURIComponent(skipped[0]?.reason || 'Employee not found.'));
      }
      const row = deleted[0];
      await logAdminAction(pool, req, 'employee.delete', {
        targetType: 'employee',
        targetId: row.id,
        detail: `Deleted employee ${row.first_name} ${row.last_name} (@${row.username || '—'}) and their login account`,
      });
      return res.redirect('/staff?msg=' + encodeURIComponent('Employee and their login account deleted.'));
    } catch (e) {
      console.error('[staff/:id/delete]', e.message);
      return res.redirect('/staff?err=' + encodeURIComponent(e.message));
    }
  });

  app.get('/hr/attendance', requireAuth, requireAdminOrPayrollWrite, async (req, res) => {
    try {
      await ensureHrPayrollSchema(pool);
      const fid = Math.max(1, parseInt(req.session.facilityId, 10) || 1);
      const date = String(req.query.date || '').trim() || new Date().toISOString().split('T')[0];

      const [staffRows] = await pool.query(
        'SELECT id, first_name, last_name FROM tbl_employee WHERE status = 1 ORDER BY last_name ASC, first_name ASC'
      ).catch(() => [[]]);
      const rows = Array.isArray(staffRows) ? staffRows : [];
      const existing = {};
      if (rows.length) {
        const [attRows] = await pool.query(
          'SELECT employee_id, status, check_in_time, check_out_time FROM tbl_hms_attendance WHERE facility_id = ? AND att_date = ?',
          [fid, date]
        ).catch(() => [[]]);
        for (const r of attRows || []) existing[r.employee_id] = r;
      }

      const summary = { present: 0, late: 0, absent: 0, 'half-day': 0, 'on-leave': 0, saved: 0 };
      for (const row of rows) {
        const saved = existing[row.id];
        if (saved) summary.saved += 1;
        const st = String((saved && saved.status) || 'present').toLowerCase();
        if (summary[st] == null) summary[st] = 0;
        summary[st] += 1;
      }

      res.render('hr-attendance', {
        title: 'Staff Attendance — ZAIZENS',
        date,
        staff: rows,
        existing,
        summary,
        hrTablesOk: true,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (err) {
      console.error('[hr/attendance]', err.message);
      res.status(500).render('error', { title: 'Error', message: err.message || 'Attendance load failed.', status: 500 });
    }
  });

  app.post('/hr/attendance/save', requireAuth, requireAdminOrPayrollWrite, async (req, res) => {
    const fid = Math.max(1, parseInt(req.session.facilityId, 10) || 1);
    const date = String(req.body.date || '').trim() || new Date().toISOString().split('T')[0];
    const attendance = req.body.attendance && typeof req.body.attendance === 'object' ? req.body.attendance : {};
    try {
      await ensureHrPayrollSchema(pool);

      for (const [eidStr, row] of Object.entries(attendance)) {
        const employee_id = parseInt(eidStr, 10) || 0;
        if (employee_id < 1 || !row || typeof row !== 'object') continue;
        const status = String(row.status || 'present').trim().slice(0, 24) || 'present';
        let cin = row.in != null && String(row.in).trim() !== '' ? String(row.in).trim() : null;
        let cout = row.out != null && String(row.out).trim() !== '' ? String(row.out).trim() : null;
        if (cin && cin.length === 5) cin = cin + ':00';
        if (cout && cout.length === 5) cout = cout + ':00';
        await pool.query(
          `INSERT INTO tbl_hms_attendance (facility_id, employee_id, att_date, check_in_time, check_out_time, status)
           VALUES (?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE status=VALUES(status), check_in_time=VALUES(check_in_time), check_out_time=VALUES(check_out_time)`,
          [fid, employee_id, date, cin, cout, status]
        );
      }
      res.redirect('/hr/attendance?date=' + encodeURIComponent(date) + '&msg=' + encodeURIComponent('Attendance saved.'));
    } catch (err) {
      console.error('[hr/attendance/save]', err.message);
      res.redirect('/hr/attendance?date=' + encodeURIComponent(date) + '&err=' + encodeURIComponent(err.message));
    }
  });
};
