'use strict';

const ensureHrPayrollSchema = require('../lib/ensureHrPayrollSchema');
const hmsStaffAccountGuard = require('../lib/hmsStaffAccountGuard');
const { loadRoleTitleMap, resolveRoleTitle } = require('../lib/hmsEmployeeHr');

module.exports = function registerStaffDirectoryRoutes(app, pool, requireAuth) {
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
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (err) {
      console.error('[staff]', err.message);
      res.status(500).render('error', { title: 'Error', message: err.message || 'Staff load failed.', status: 500 });
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

      res.render('hr-attendance', {
        title: 'Staff Attendance — ZAIZENS',
        date,
        staff: rows,
        existing,
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
