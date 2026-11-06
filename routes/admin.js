'use strict';

/**
 * Administration module — accounts, roles & permissions, security policy,
 * admin audit trail and the self-service password change screen.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ensureAdminSchema = require('../lib/ensureAdminSchema');
const ensureEmployeeHrSchema = require('../lib/ensureEmployeeHrSchema');
const { loadRoleTitleMap, resolveRoleTitle } = require('../lib/hmsEmployeeHr');
const { loadSecurityPolicy, validatePassword, saveSecurityPolicy, DEFAULTS } = require('../lib/securityPolicy');
const { logAdminAction, recentAdminActions } = require('../lib/adminAudit');

const MODULE_LABELS = {
  payroll: 'Payroll',
  hr: 'Human resources',
  accounting: 'Accounting & tax',
  access_control: 'Access control',
  employee: 'Employee accounts',
  admin: 'Administration',
};

const BUILT_IN_ROLES = { '1': 'System Admin', '99': 'Super Admin' };

function clean(value, max = 250) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

function verifyPassword(password, hash) {
  const stored = String(hash || '');
  if (stored.startsWith('$2')) {
    const cmp = stored.startsWith('$2y$') ? '$2a$' + stored.slice(4) : stored;
    return bcrypt.compare(String(password || ''), cmp);
  }
  return Promise.resolve(String(password || '') === stored);
}

function canAdminister(req, res) {
  const role = String((req.session.user && req.session.user.role) || '');
  if (role === '1' || role === '99') return true;
  const perms = res.locals.userPerms || req.session.userPerms || [];
  return perms.includes('*') || perms.includes('access_control.manage');
}

function clientSlug(first, last) {
  return `${first || ''}.${last || ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.]+/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '') || 'account';
}

async function loadRoles(pool) {
  try {
    const [rows] = await pool.query(
      `SELECT role AS id, COALESCE(NULLIF(TRIM(MIN(NULLIF(TRIM(title), ''))), ''), CONCAT('Role ', role)) AS title
       FROM tbl_role
       WHERE CAST(role AS UNSIGNED) > 0
       GROUP BY role
       ORDER BY CAST(role AS UNSIGNED)`
    );
    return (rows || []).map((r) => ({ id: String(r.id), title: r.title }));
  } catch (_) {
    return [
      { id: '1', title: 'System Admin' },
      { id: '99', title: 'Super Admin' },
    ];
  }
}

async function roleUserCounts(pool) {
  try {
    const [rows] = await pool.query(
      'SELECT CAST(role AS CHAR) AS role, COUNT(*) AS c FROM tbl_employee GROUP BY CAST(role AS CHAR)'
    );
    const out = {};
    for (const r of rows || []) out[String(r.role)] = Number(r.c) || 0;
    return out;
  } catch (_) {
    return {};
  }
}

async function permissionCounts(pool) {
  try {
    const [rows] = await pool.query(
      'SELECT role, COUNT(*) AS c FROM tbl_acl_role_permission GROUP BY role'
    );
    const out = {};
    for (const r of rows || []) out[String(r.role)] = Number(r.c) || 0;
    return out;
  } catch (_) {
    return {};
  }
}

async function nextFreeRoleId(pool) {
  try {
    const [[row]] = await pool.query(
      'SELECT COALESCE(MAX(CAST(role AS UNSIGNED)), 0) AS maxRole FROM tbl_role'
    );
    const max = Number(row && row.maxRole) || 0;
    return String(Math.max(max + 1, 120));
  } catch (_) {
    return '120';
  }
}

module.exports = function registerAdminRoutes(app, pool, requireAuth) {
  function requireAdminModule(req, res, next) {
    if (canAdminister(req, res)) return next();
    if (req.method === 'POST') {
      return res.status(403).render('error', {
        title: 'Forbidden',
        message: 'Administration access required.',
        status: 403,
      });
    }
    return res.status(403).render('error', {
      title: 'Forbidden',
      message: 'Administration access required.',
      status: 403,
    });
  }

  async function schema() {
    await ensureAdminSchema(pool);
    await ensureEmployeeHrSchema(pool).catch(() => {});
  }

  async function accountRoles() {
    const [roles, roleMap] = await Promise.all([loadRoles(pool), loadRoleTitleMap(pool).catch(() => ({}))]);
    return { roles, roleMap };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Admin overview
  // ═══════════════════════════════════════════════════════════════════════
  app.get('/admin', requireAuth, requireAdminModule, async (req, res) => {
    try {
      await schema();
      const [[accountStats]] = await pool
        .query(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(status = 1), 0) AS active,
                  COALESCE(SUM(status <> 1), 0) AS inactive,
                  COALESCE(SUM(password_must_change = 1), 0) AS must_change,
                  COALESCE(SUM(role IS NULL OR TRIM(role) = ''), 0) AS unassigned
           FROM tbl_employee`
        )
        .catch(() => [[{ total: 0, active: 0, inactive: 0, must_change: 0, unassigned: 0 }]]);
      const [[roleStats]] = await pool
        .query('SELECT COUNT(DISTINCT role) AS c FROM tbl_role')
        .catch(() => [[{ c: 0 }]]);
      const [[permStats]] = await pool
        .query('SELECT COUNT(*) AS c FROM tbl_acl_permission')
        .catch(() => [[{ c: 0 }]]);
      const [[grantStats]] = await pool
        .query('SELECT COUNT(*) AS c FROM tbl_acl_role_permission')
        .catch(() => [[{ c: 0 }]]);

      const policy = await loadSecurityPolicy(pool);
      const activity = await recentAdminActions(pool, 10);

      res.render('admin-home', {
        title: 'Administration — Zaizens Payroll',
        payNavActive: 'admin',
        stats: {
          accounts: Number(accountStats.total) || 0,
          active: Number(accountStats.active) || 0,
          inactive: Number(accountStats.inactive) || 0,
          mustChange: Number(accountStats.must_change) || 0,
          unassigned: Number(accountStats.unassigned) || 0,
          roles: Number(roleStats && roleStats.c) || 0,
          permissions: Number(permStats && permStats.c) || 0,
          grants: Number(grantStats && grantStats.c) || 0,
        },
        policy,
        activity,
        isSuperAdmin: String((req.session.user && req.session.user.role) || '') === '99',
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      console.error('[admin]', e.message);
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Accounts
  // ═══════════════════════════════════════════════════════════════════════
  app.get('/admin/accounts', requireAuth, requireAdminModule, async (req, res) => {
    try {
      await schema();
      const q = clean(req.query.q, 120);
      const status = ['active', 'inactive', 'must-change'].includes(String(req.query.status)) ? String(req.query.status) : '';
      const like = `%${q}%`;
      const where = [];
      const params = [];
      if (q) {
        where.push('(e.first_name LIKE ? OR e.last_name LIKE ? OR e.username LIKE ? OR e.emailid LIKE ? OR e.employee_id LIKE ?)');
        params.push(like, like, like, like, like);
      }
      if (status === 'active') where.push('e.status = 1');
      else if (status === 'inactive') where.push('e.status <> 1');
      else if (status === 'must-change') where.push('e.password_must_change = 1');
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const [rows] = await pool
        .query(
          `SELECT e.id, e.first_name, e.last_name, e.username, e.emailid, e.phone, e.role,
                  e.status, e.password_must_change, e.last_reset_at, e.created_at, e.employee_id
           FROM tbl_employee e ${whereSql}
           ORDER BY e.status DESC, e.last_name, e.first_name LIMIT 300`,
          params
        )
        .catch(() => [[]]);

      const [[counts]] = await pool
        .query(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(status = 1), 0) AS active,
                  COALESCE(SUM(status <> 1), 0) AS inactive,
                  COALESCE(SUM(password_must_change = 1), 0) AS must_change
           FROM tbl_employee`
        )
        .catch(() => [[{ total: 0, active: 0, inactive: 0, must_change: 0 }]]);

      const { roles, roleMap } = await accountRoles();
      const accounts = (rows || []).map((r) => ({
        ...r,
        roleLabel: r.role ? resolveRoleTitle(r.role, roleMap) : 'Unassigned',
      }));

      res.render('admin-accounts', {
        title: 'Accounts — Zaizens Payroll',
        payNavActive: 'admin-accounts',
        accounts,
        roles,
        q,
        status,
        counts: {
          total: Number(counts.total) || 0,
          active: Number(counts.active) || 0,
          inactive: Number(counts.inactive) || 0,
          mustChange: Number(counts.must_change) || 0,
        },
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      console.error('[admin/accounts]', e.message);
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.get('/admin/accounts/new', requireAuth, requireAdminModule, async (req, res) => {
    try {
      await schema();
      const { roles } = await accountRoles();
      const policy = await loadSecurityPolicy(pool);
      res.render('admin-account-new', {
        title: 'New account — Zaizens Payroll',
        payNavActive: 'admin-accounts',
        roles,
        policy,
        form: {},
        flash: null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/admin/accounts/new', requireAuth, requireAdminModule, async (req, res) => {
    const b = req.body || {};
    try {
      await schema();
      const { roles } = await accountRoles();
      const policy = await loadSecurityPolicy(pool);
      const first = clean(b.first_name, 120);
      const last = clean(b.last_name, 120);
      let username = clean(b.username, 120).toLowerCase();
      const email = clean(b.emailid, 250);
      const phone = clean(b.phone, 32);
      const role = clean(b.role, 20);
      const password = String(b.password || '');
      const mustChange = b.force_change ? 1 : 0;

      const renderError = (msg) =>
        res.status(400).render('admin-account-new', {
          title: 'New account — Zaizens Payroll',
          payNavActive: 'admin-accounts',
          roles,
          policy,
          form: b,
          flash: null,
          error: msg,
        });

      if (!first || !last) return renderError('First name and last name are required.');
      if (!role) return renderError('Select a role for the account.');
      if (String(role) === '99' && String(req.session.user.role) !== '99') {
        return renderError('Only a Super Admin can create another Super Admin.');
      }
      if (!username) username = clientSlug(first, last);
      const [[taken]] = await pool.query('SELECT id FROM tbl_employee WHERE username = ? LIMIT 1', [username]);
      if (taken) return renderError(`Username "${username}" is already taken.`);

      const pwdError = validatePassword(password, policy);
      if (pwdError) return renderError(pwdError);

      const hash = await hashPassword(password);
      const [result] = await pool.query(
        `INSERT INTO tbl_employee
          (first_name, last_name, username, emailid, password, dob, gender, address, bio,
           employee_id, joining_date, phone, role, status, default_facility_id, password_must_change)
         VALUES (?,?,?,?,?,'','','','','',?,?,?,1,?,?)`,
        [
          first,
          last,
          username,
          email,
          hash,
          new Date().toISOString().slice(0, 10),
          phone,
          role,
          Math.max(1, parseInt(req.session.facilityId, 10) || 1),
          mustChange,
        ]
      );
      const id = Number(result.insertId);
      if (id) {
        await pool.query('UPDATE tbl_employee SET employee_id = ? WHERE id = ?', [`ACC-${String(id).padStart(4, '0')}`, id]).catch(() => {});
      }

      await logAdminAction(pool, req, 'account.create', {
        targetType: 'account',
        targetId: id,
        detail: `Created account ${username} with role ${role}${mustChange ? ' (must change password)' : ''}`,
      });
      return res.redirect('/admin/accounts/' + id + '?msg=' + encodeURIComponent('Account created.'));
    } catch (e) {
      console.error('[admin/accounts/new]', e.message);
      return res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.get('/admin/accounts/:id', requireAuth, requireAdminModule, async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    if (id < 1) return res.status(404).render('error', { title: 'Not found', message: 'Account not found.', status: 404 });
    try {
      await schema();
      const [[account]] = await pool.query(
        `SELECT id, first_name, last_name, username, emailid, phone, role, status,
                password_must_change, last_reset_at, created_at, employee_id, primary_department, job_title
         FROM tbl_employee WHERE id = ? LIMIT 1`,
        [id]
      );
      if (!account) return res.status(404).render('error', { title: 'Not found', message: 'Account not found.', status: 404 });

      const { roles, roleMap } = await accountRoles();
      const policy = await loadSecurityPolicy(pool);
      const [[grantedRow]] = await pool
        .query('SELECT COUNT(*) AS c FROM tbl_acl_role_permission WHERE role = ?', [String(account.role)])
        .catch(() => [[{ c: 0 }]]);

      res.render('admin-account-edit', {
        title: `${account.first_name} ${account.last_name} — Administration`,
        payNavActive: 'admin-accounts',
        account: { ...account, roleLabel: resolveRoleTitle(account.role, roleMap) },
        roles,
        policy,
        permissionCount: Number(grantedRow && grantedRow.c) || 0,
        isSelf: Number(account.id) === Number(req.session.user.id),
        actorIsSuper: String(req.session.user.role) === '99',
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      console.error('[admin/accounts/:id]', e.message);
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/admin/accounts/:id', requireAuth, requireAdminModule, async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    const b = req.body || {};
    const actorId = Number(req.session.user.id) || 0;
    const actorRole = String(req.session.user.role || '');
    const back = `/admin/accounts/${id}`;
    try {
      await schema();
      const [[account]] = await pool.query(
        'SELECT id, username, role, status FROM tbl_employee WHERE id = ? LIMIT 1',
        [id]
      );
      if (!account) return res.redirect(back + '?err=' + encodeURIComponent('Account not found.'));
      if (String(account.role) === '99' && actorRole !== '99') {
        return res.redirect(back + '?err=' + encodeURIComponent('Only a Super Admin can modify a Super Admin account.'));
      }

      const policy = await loadSecurityPolicy(pool);
      const first = clean(b.first_name, 120);
      const last = clean(b.last_name, 120);
      const email = clean(b.emailid, 250);
      const phone = clean(b.phone, 32);
      const username = clean(b.username, 120).toLowerCase() || account.username;
      const role = clean(b.role, 20) || String(account.role);
      const status = b.status ? 1 : 0;

      if (!first || !last) return res.redirect(back + '?err=' + encodeURIComponent('First and last name are required.'));
      if (id === actorId && status === 0) {
        return res.redirect(back + '?err=' + encodeURIComponent('You cannot deactivate your own account.'));
      }
      if (id === actorId && String(role) !== String(account.role)) {
        return res.redirect(back + '?err=' + encodeURIComponent('You cannot change your own role.'));
      }
      if (String(role) === '99' && actorRole !== '99') {
        return res.redirect(back + '?err=' + encodeURIComponent('Only a Super Admin can assign the Super Admin role.'));
      }

      const [[taken]] = await pool.query(
        'SELECT id FROM tbl_employee WHERE username = ? AND id <> ? LIMIT 1',
        [username, id]
      );
      if (taken) return res.redirect(back + '?err=' + encodeURIComponent('That username is already in use.'));

      await pool.query(
        `UPDATE tbl_employee SET first_name=?, last_name=?, username=?, emailid=?, phone=?, role=?, status=?
         WHERE id = ?`,
        [first, last, username, email, phone, role, status, id]
      );

      let auditDetail = `Updated account @${username} (${status ? 'active' : 'inactive'}, role ${role})`;
      let redirectMsg = 'Account updated.';

      const newPassword = String(b.new_password || '');
      if (newPassword) {
        if (newPassword !== String(b.confirm_password || '')) {
          return res.redirect(back + '?err=' + encodeURIComponent('The new passwords do not match.'));
        }
        const pwdError = validatePassword(newPassword, policy);
        if (pwdError) return res.redirect(back + '?err=' + encodeURIComponent(pwdError));
        const hash = await hashPassword(newPassword);
        const mustChange = b.force_change_reset ? 1 : 0;
        await pool.query(
          'UPDATE tbl_employee SET password = ?, password_must_change = ?, last_reset_at = NOW() WHERE id = ?',
          [hash, mustChange, id]
        );
        auditDetail += `; password reset${mustChange ? ' with forced change' : ''}`;
        redirectMsg = mustChange ? 'Account updated and password reset — user must change it at next sign-in.' : 'Account updated and password reset.';
      } else if (typeof b.must_change !== 'undefined') {
        const mustChange = b.must_change ? 1 : 0;
        await pool.query('UPDATE tbl_employee SET password_must_change = ? WHERE id = ?', [mustChange, id]);
        auditDetail += `; must-change ${mustChange ? 'on' : 'off'}`;
      }

      await logAdminAction(pool, req, 'account.update', {
        targetType: 'account',
        targetId: id,
        detail: auditDetail,
      });
      return res.redirect(back + '?msg=' + encodeURIComponent(redirectMsg));
    } catch (e) {
      console.error('[admin/accounts/:id POST]', e.message);
      return res.redirect(back + '?err=' + encodeURIComponent(e.message));
    }
  });

  app.post('/admin/accounts/:id/toggle', requireAuth, requireAdminModule, async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    const actorId = Number(req.session.user.id) || 0;
    const back = '/admin/accounts';
    try {
      await schema();
      if (id === actorId) return res.redirect(back + '?err=' + encodeURIComponent('You cannot deactivate your own account.'));
      const [[account]] = await pool.query('SELECT id, username, role, status FROM tbl_employee WHERE id = ? LIMIT 1', [id]);
      if (!account) return res.redirect(back + '?err=' + encodeURIComponent('Account not found.'));
      if (String(account.role) === '99' && String(req.session.user.role) !== '99') {
        return res.redirect(back + '?err=' + encodeURIComponent('Only a Super Admin can change a Super Admin account.'));
      }
      const next = Number(account.status) === 1 ? 0 : 1;
      await pool.query('UPDATE tbl_employee SET status = ? WHERE id = ?', [next, id]);
      await logAdminAction(pool, req, next ? 'account.activate' : 'account.deactivate', {
        targetType: 'account',
        targetId: id,
        detail: `${next ? 'Activated' : 'Deactivated'} @${account.username}`,
      });
      return res.redirect(back + '?msg=' + encodeURIComponent(next ? 'Account activated.' : 'Account deactivated.'));
    } catch (e) {
      return res.redirect(back + '?err=' + encodeURIComponent(e.message));
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Roles & permissions
  // ═══════════════════════════════════════════════════════════════════════
  app.get('/admin/roles', requireAuth, requireAdminModule, async (req, res) => {
    try {
      await schema();
      const roles = await loadRoles(pool);
      const [users, grants] = await Promise.all([roleUserCounts(pool), permissionCounts(pool)]);
      const known = new Set(roles.map((r) => String(r.id)));
      for (const extra of Object.keys(grants)) {
        if (!known.has(extra)) roles.push({ id: extra, title: `Role ${extra}` });
      }
      const rows = roles
        .map((r) => ({
          ...r,
          users: users[String(r.id)] || 0,
          permissions: grants[String(r.id)] || 0,
          builtIn: Boolean(BUILT_IN_ROLES[String(r.id)]),
        }))
        .sort((a, b) => Number(a.id) - Number(b.id));

      const [[permTotal]] = await pool
        .query('SELECT COUNT(*) AS c FROM tbl_acl_permission')
        .catch(() => [[{ c: 0 }]]);

      res.render('admin-roles', {
        title: 'Roles & permissions — Administration',
        payNavActive: 'admin-roles',
        roles: rows,
        permissionTotal: Number(permTotal && permTotal.c) || 0,
        nextRoleId: await nextFreeRoleId(pool),
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      console.error('[admin/roles]', e.message);
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/admin/roles', requireAuth, requireAdminModule, async (req, res) => {
    const b = req.body || {};
    try {
      await schema();
      const title = clean(b.title, 120);
      if (!title) return res.redirect('/admin/roles?err=' + encodeURIComponent('Role name is required.'));
      let roleId = clean(b.role_id, 20);
      if (!/^\d+$/.test(roleId)) roleId = await nextFreeRoleId(pool);
      if (String(roleId) === '1' || String(roleId) === '99') {
        return res.redirect('/admin/roles?err=' + encodeURIComponent('Role 1 and 99 are reserved.'));
      }
      const [[existing]] = await pool.query('SELECT role FROM tbl_role WHERE role = ? LIMIT 1', [roleId]);
      if (existing) return res.redirect('/admin/roles?err=' + encodeURIComponent(`Role ${roleId} already exists.`));

      await pool.query('INSERT INTO tbl_role (role, title) VALUES (?,?)', [roleId, title]);
      const template = clean(b.template_role, 20);
      if (template && template !== roleId) {
        try {
          await pool.query(
            `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id)
             SELECT ?, permission_id FROM tbl_acl_role_permission WHERE role = ?`,
            [roleId, template]
          );
        } catch (_) { /* optional */ }
      }
      await logAdminAction(pool, req, 'role.create', {
        targetType: 'role',
        targetId: roleId,
        detail: `Created role "${title}"${template ? ` from template ${template}` : ''}`,
      });
      return res.redirect('/admin/roles/' + roleId + '?msg=' + encodeURIComponent('Role created. Assign its permissions below.'));
    } catch (e) {
      return res.redirect('/admin/roles?err=' + encodeURIComponent(e.message));
    }
  });

  app.get('/admin/roles/:role', requireAuth, requireAdminModule, async (req, res) => {
    const role = clean(req.params.role, 20);
    if (!/^\d+$/.test(role)) return res.status(404).render('error', { title: 'Not found', message: 'Role not found.', status: 404 });
    try {
      await schema();
      const [[roleRow]] = await pool
        .query(
          `SELECT role, COALESCE(NULLIF(TRIM(MIN(NULLIF(TRIM(title), ''))), ''), CONCAT('Role ', role)) AS title
           FROM tbl_role WHERE role = ? GROUP BY role LIMIT 1`,
          [role]
        )
        .catch(() => [[null]]);
      const title = (roleRow && roleRow.title) || BUILT_IN_ROLES[role] || `Role ${role}`;
      const [permissions] = await pool
        .query(
          `SELECT id, code, label, module_code, action
           FROM tbl_acl_permission
           ORDER BY COALESCE(NULLIF(module_code, ''), SUBSTRING_INDEX(code, '.', 1)), code`
        )
        .catch(() => [[]]);
      const [grantedRows] = await pool
        .query('SELECT permission_id FROM tbl_acl_role_permission WHERE role = ?', [role])
        .catch(() => [[]]);
      const granted = new Set((grantedRows || []).map((r) => Number(r.permission_id)));

      const groups = [];
      const byModule = new Map();
      for (const p of permissions || []) {
        const mod = String(p.module_code || String(p.code || '').split('.')[0] || 'other');
        if (!byModule.has(mod)) {
          byModule.set(mod, {
            code: mod,
            label: MODULE_LABELS[mod] || mod.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            permissions: [],
            granted: 0,
          });
          groups.push(byModule.get(mod));
        }
        const g = byModule.get(mod);
        g.permissions.push({ ...p, granted: granted.has(Number(p.id)) });
        if (granted.has(Number(p.id))) g.granted += 1;
      }

      const users = await roleUserCounts(pool);
      const builtIn = Boolean(BUILT_IN_ROLES[role]);

      res.render('admin-role-edit', {
        title: `${title} — Roles`,
        payNavActive: 'admin-roles',
        role,
        titleText: title,
        groups,
        grantedCount: granted.size,
        permissionTotal: (permissions || []).length,
        userCount: users[role] || 0,
        builtIn,
        isSuperRole: role === '99',
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      console.error('[admin/roles/:role]', e.message);
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/admin/roles/:role', requireAuth, requireAdminModule, async (req, res) => {
    const role = clean(req.params.role, 20);
    const back = `/admin/roles/${role}`;
    try {
      await schema();
      if (role === '1' || role === '99') {
        return res.redirect(back + '?err=' + encodeURIComponent('Built-in roles always have full access and cannot be edited.'));
      }
      const b = req.body || {};
      const title = clean(b.title, 120);

      let ids = b.permission_ids;
      if (ids == null) ids = [];
      if (!Array.isArray(ids)) ids = [ids];
      ids = ids.map((v) => parseInt(v, 10)).filter((v) => Number.isFinite(v) && v > 0);

      if (title) {
        await pool.query('UPDATE tbl_role SET title = ? WHERE role = ?', [title, role]);
        const [existingTitleRows] = await pool.query('SELECT id FROM tbl_role WHERE role = ? LIMIT 1', [role]);
        if (!existingTitleRows.length) {
          await pool.query('INSERT INTO tbl_role (role, title) VALUES (?,?)', [role, title]);
        }
      }

      // Do not let a non-super admin remove the permission that grants them
      // access to this screen from their own role.
      const actorRole = String(req.session.user.role || '');
      if (actorRole !== '1' && actorRole !== '99' && actorRole === role) {
        const [[managePerm]] = await pool
          .query("SELECT id FROM tbl_acl_permission WHERE code = 'access_control.manage' LIMIT 1")
          .catch(() => [[null]]);
        if (managePerm && !ids.includes(Number(managePerm.id))) {
          return res.redirect(
            back + '?err=' + encodeURIComponent('Keep "access control: manage" on your own role, or you will lose access to Administration.')
          );
        }
      }

      await pool.query('DELETE FROM tbl_acl_role_permission WHERE role = ?', [role]);
      if (ids.length) {
        const placeholders = ids.map(() => '(?,?)').join(',');
        const values = [];
        for (const pid of ids) values.push(role, pid);
        await pool.query(
          `INSERT IGNORE INTO tbl_acl_role_permission (role, permission_id) VALUES ${placeholders}`,
          values
        );
      }

      await logAdminAction(pool, req, 'role.permissions', {
        targetType: 'role',
        targetId: role,
        detail: `Saved role "${title || role}": ${ids.length} permission(s)`,
      });
      return res.redirect(back + '?msg=' + encodeURIComponent('Role and permissions saved.'));
    } catch (e) {
      console.error('[admin/roles/:role POST]', e.message);
      return res.redirect(back + '?err=' + encodeURIComponent(e.message));
    }
  });

  app.post('/admin/roles/:role/delete', requireAuth, requireAdminModule, async (req, res) => {
    const role = clean(req.params.role, 20);
    try {
      await schema();
      if (role === '1' || role === '99') {
        return res.redirect('/admin/roles?err=' + encodeURIComponent('Built-in roles cannot be deleted.'));
      }
      const users = await roleUserCounts(pool);
      if ((users[role] || 0) > 0) {
        return res.redirect('/admin/roles?err=' + encodeURIComponent('Reassign the role\'s users before deleting it.'));
      }
      await pool.query('DELETE FROM tbl_acl_role_permission WHERE role = ?', [role]);
      await pool.query('DELETE FROM tbl_role WHERE role = ?', [role]);
      await logAdminAction(pool, req, 'role.delete', {
        targetType: 'role',
        targetId: role,
        detail: `Deleted role ${role}`,
      });
      return res.redirect('/admin/roles?msg=' + encodeURIComponent('Role deleted.'));
    } catch (e) {
      return res.redirect('/admin/roles?err=' + encodeURIComponent(e.message));
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Security
  // ═══════════════════════════════════════════════════════════════════════
  app.get('/admin/security', requireAuth, requireAdminModule, async (req, res) => {
    try {
      await schema();
      const policy = await loadSecurityPolicy(pool);
      const [[counts]] = await pool
        .query(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(status = 1), 0) AS active,
                  COALESCE(SUM(status <> 1), 0) AS inactive,
                  COALESCE(SUM(password_must_change = 1), 0) AS must_change
           FROM tbl_employee`
        )
        .catch(() => [[{ total: 0, active: 0, inactive: 0, must_change: 0 }]]);
      const activity = await recentAdminActions(pool, 8);
      res.render('admin-security', {
        title: 'Security — Administration',
        payNavActive: 'admin-security',
        policy,
        defaults: DEFAULTS,
        counts: {
          total: Number(counts.total) || 0,
          active: Number(counts.active) || 0,
          inactive: Number(counts.inactive) || 0,
          mustChange: Number(counts.must_change) || 0,
        },
        activity,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/admin/security', requireAuth, requireAdminModule, async (req, res) => {
    try {
      await schema();
      await saveSecurityPolicy(pool, req.body || {}, req.session.user.name || req.session.user.username);
      await logAdminAction(pool, req, 'security.policy', {
        targetType: 'security',
        targetId: 'policy',
        detail: `Password min length ${req.body.password_min_length}, lockout ${req.body.lockout_threshold}/${req.body.lockout_minutes} min`,
      });
      res.redirect('/admin/security?msg=' + encodeURIComponent('Security policy saved.'));
    } catch (e) {
      res.redirect('/admin/security?err=' + encodeURIComponent(e.message));
    }
  });

  app.post('/admin/security/force-change', requireAuth, requireAdminModule, async (req, res) => {
    try {
      await schema();
      const actorId = Number(req.session.user.id) || 0;
      const actorRole = String(req.session.user.role || '');
      const [result] = await pool.query(
        `UPDATE tbl_employee SET password_must_change = 1
         WHERE status = 1 AND id <> ? AND CAST(role AS CHAR) <> '99'`,
        [actorId]
      );
      await logAdminAction(pool, req, 'security.force_change_all', {
        targetType: 'security',
        targetId: 'accounts',
        detail: `Forced password change for ${result.affectedRows} active account(s)${actorRole !== '99' ? ' (Super Admin accounts excluded)' : ''}`,
      });
      res.redirect('/admin/security?msg=' + encodeURIComponent(`Password change forced for ${result.affectedRows} account(s).`));
    } catch (e) {
      res.redirect('/admin/security?err=' + encodeURIComponent(e.message));
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Activity trail
  // ═══════════════════════════════════════════════════════════════════════
  app.get('/admin/activity', requireAuth, requireAdminModule, async (req, res) => {
    try {
      await schema();
      const rows = await recentAdminActions(pool, 200);
      res.render('admin-activity', {
        title: 'Admin activity — Zaizens Payroll',
        payNavActive: 'admin-activity',
        activityRows: rows,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Audit integrity
  // ═══════════════════════════════════════════════════════════════════════
  app.get('/admin/audit-integrity', requireAuth, requireAdminModule, async (req, res) => {
    try {
      await schema();
      const [rawRows] = await pool.query(
        `SELECT a.id, a.created_at, a.actor_name, a.action, a.target_type, a.target_id,
                a.detail, a.ip, a.facility_id,
                e.id AS matched_employee_id, e.first_name, e.last_name,
                e.employee_id AS matricule, e.default_facility_id AS employee_facility_id
           FROM tbl_admin_audit a
           LEFT JOIN tbl_employee e
             ON a.target_type = 'employee' AND CAST(e.id AS CHAR) = a.target_id
          WHERE a.facility_id IS NULL
            AND (e.id IS NULL OR e.default_facility_id IS NULL)
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 500`
      );
      const [[counts]] = await pool.query(
        `SELECT COUNT(*) AS total_null,
                COALESCE(SUM(CASE WHEN e.id IS NULL OR e.default_facility_id IS NULL THEN 1 ELSE 0 END), 0) AS unresolved
           FROM tbl_admin_audit a
           LEFT JOIN tbl_employee e
             ON a.target_type = 'employee' AND CAST(e.id AS CHAR) = a.target_id
          WHERE a.facility_id IS NULL`
      );
      const [facilityRows] = await pool.query(
        'SELECT id, code, name, status FROM tbl_facility ORDER BY id ASC'
      );

      const rows = (rawRows || []).map((row) => {
        let reason = 'Not linked to an employee record';
        if (String(row.target_type || '').toLowerCase() === 'employee') {
          reason = row.matched_employee_id == null
            ? 'Target employee no longer exists'
            : 'Employee has no default facility';
        }
        return { ...row, resolution_reason: reason };
      });

      const totalNull = Number(counts && counts.total_null) || 0;
      const unresolved = Number(counts && counts.unresolved) || 0;
      res.render('admin-audit-integrity', {
        title: 'Audit integrity — Administration',
        payNavActive: 'admin-audit-integrity',
        rows,
        facilities: facilityRows || [],
        stats: {
          totalNull,
          unresolved,
          resolvable: Math.max(0, totalNull - unresolved),
        },
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      console.error('[admin/audit-integrity]', e.message);
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/admin/audit-integrity/:id/assign', requireAuth, requireAdminModule, async (req, res) => {
    const auditId = parseInt(req.params.id, 10) || 0;
    const facilityId = parseInt(req.body.facility_id, 10) || 0;
    const back = '/admin/audit-integrity';
    const fail = (message) => res.redirect(back + '?err=' + encodeURIComponent(message));
    if (auditId < 1) return fail('Invalid audit row.');
    if (facilityId < 1) return fail('Select a facility.');

    try {
      await schema();
      const [[facility]] = await pool.query(
        'SELECT id, name FROM tbl_facility WHERE id = ? LIMIT 1',
        [facilityId]
      );
      if (!facility) return fail('Facility not found.');

      const [[audit]] = await pool.query(
        `SELECT a.id, a.action, a.target_type, a.target_id, a.facility_id,
                e.id AS matched_employee_id, e.default_facility_id AS employee_facility_id
           FROM tbl_admin_audit a
           LEFT JOIN tbl_employee e
             ON a.target_type = 'employee' AND CAST(e.id AS CHAR) = a.target_id
          WHERE a.id = ? LIMIT 1`,
        [auditId]
      );
      if (!audit) return fail('Audit row not found.');
      if (audit.facility_id != null) return fail('This audit row already has a facility.');

      const resolvable = String(audit.target_type || '').toLowerCase() === 'employee'
        && audit.matched_employee_id != null
        && audit.employee_facility_id != null;
      if (resolvable) {
        return fail('This audit row can still be resolved from employee data and is not listed for manual assignment.');
      }

      const [result] = await pool.query(
        `UPDATE tbl_admin_audit a
           LEFT JOIN tbl_employee e
             ON a.target_type = 'employee' AND CAST(e.id AS CHAR) = a.target_id
            SET a.facility_id = ?
          WHERE a.id = ? AND a.facility_id IS NULL
            AND (e.id IS NULL OR e.default_facility_id IS NULL)`,
        [facilityId, auditId]
      );
      if (!result.affectedRows) {
        return fail('This audit row could not be assigned. Refresh the report and try again.');
      }

      const facilityLabel = facility.name || `#${facilityId}`;
      await logAdminAction(pool, req, 'audit.facility_assign', {
        targetType: 'audit',
        targetId: auditId,
        facilityId,
        detail: `Assigned facility ${facilityLabel} (#${facilityId}) to audit row #${auditId} ` +
          `(${audit.action || 'unknown action'}, target ${audit.target_type || '—'} ${audit.target_id || ''}).`,
      });
      return res.redirect(
        back + '?msg=' + encodeURIComponent(`Facility ${facilityLabel} assigned to audit row #${auditId}.`)
      );
    } catch (e) {
      console.error('[admin/audit-integrity/assign]', e.message);
      return fail(e.message);
    }
  });

  app.post('/admin/audit-integrity/assign', requireAuth, requireAdminModule, async (req, res) => {
    const facilityId = parseInt(req.body.facility_id, 10) || 0;
    const back = '/admin/audit-integrity';
    const fail = (message) => res.redirect(back + '?err=' + encodeURIComponent(message));
    const rawIds = [].concat(req.body['audit_ids[]'] || req.body.audit_ids || []);
    const ids = [...new Set(rawIds.map((value) => parseInt(value, 10)).filter((id) => id > 0))];

    if (!ids.length) return fail('Select at least one audit row.');
    if (ids.length > 500) return fail('Select no more than 500 audit rows at a time.');
    if (facilityId < 1) return fail('Select a facility.');

    let conn = null;
    try {
      await schema();
      const [[facility]] = await pool.query(
        'SELECT id, name FROM tbl_facility WHERE id = ? LIMIT 1',
        [facilityId]
      );
      if (!facility) return fail('Facility not found.');

      conn = await pool.getConnection();
      await conn.beginTransaction();
      const placeholders = ids.map(() => '?').join(',');
      const [auditRows] = await conn.query(
        `SELECT a.id, a.action, a.target_type, a.target_id, a.facility_id,
                e.id AS matched_employee_id, e.default_facility_id AS employee_facility_id
           FROM tbl_admin_audit a
           LEFT JOIN tbl_employee e
             ON a.target_type = 'employee' AND CAST(e.id AS CHAR) = a.target_id
          WHERE a.id IN (${placeholders})
          ORDER BY a.id ASC
            FOR UPDATE`,
        ids
      );
      const rowsById = new Map((auditRows || []).map((row) => [Number(row.id), row]));
      if (ids.some((id) => !rowsById.has(id))) {
        await conn.rollback();
        return fail('Some selected audit rows no longer exist. Refresh the report and try again.');
      }

      const assigned = (auditRows || []).filter((row) => row.facility_id != null);
      if (assigned.length) {
        await conn.rollback();
        return fail(
          `${assigned.length} selected audit row${assigned.length === 1 ? '' : 's'} already ` +
          `${assigned.length === 1 ? 'has' : 'have'} a facility. Refresh the report and try again.`
        );
      }

      const resolvable = (auditRows || []).filter((row) =>
        String(row.target_type || '').toLowerCase() === 'employee' &&
        row.matched_employee_id != null &&
        row.employee_facility_id != null
      );
      if (resolvable.length) {
        await conn.rollback();
        return fail(
          `${resolvable.length} selected audit row${resolvable.length === 1 ? '' : 's'} can still be ` +
          'resolved from employee data and cannot be manually assigned. Refresh the report and try again.'
        );
      }

      const [result] = await conn.query(
        `UPDATE tbl_admin_audit a
           LEFT JOIN tbl_employee e
             ON a.target_type = 'employee' AND CAST(e.id AS CHAR) = a.target_id
            SET a.facility_id = ?
          WHERE a.id IN (${placeholders}) AND a.facility_id IS NULL
            AND (e.id IS NULL OR e.default_facility_id IS NULL)`,
        [facilityId, ...ids]
      );
      if (Number(result.affectedRows) !== ids.length) {
        await conn.rollback();
        return fail('The selected audit rows could not all be assigned. Refresh the report and try again.');
      }

      await conn.commit();
      conn.release();
      conn = null;

      const facilityLabel = facility.name || `#${facilityId}`;
      for (const audit of auditRows) {
        await logAdminAction(pool, req, 'audit.facility_assign', {
          targetType: 'audit',
          targetId: audit.id,
          facilityId,
          detail: `Bulk-assigned facility ${facilityLabel} (#${facilityId}) to audit row #${audit.id} ` +
            `(${audit.action || 'unknown action'}, target ${audit.target_type || '—'} ${audit.target_id || ''}) ` +
            `as part of a ${ids.length}-row selection.`,
        });
      }
      return res.redirect(
        back + '?msg=' + encodeURIComponent(
          `Facility ${facilityLabel} assigned to ${ids.length} audit row${ids.length === 1 ? '' : 's'}.`
        )
      );
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      console.error('[admin/audit-integrity/assign-bulk]', e.message);
      return fail(e.message);
    } finally {
      if (conn) conn.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Own password
  // ═══════════════════════════════════════════════════════════════════════
  app.get('/account/password', requireAuth, async (req, res) => {
    try {
      await schema();
      const policy = await loadSecurityPolicy(pool);
      res.render('account-password', {
        title: 'Change password — Zaizens Payroll',
        payNavActive: 'password',
        policy,
        currentUser: req.session.user,
        forced: Boolean(req.session.user && req.session.user.mustChange),
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/account/password', requireAuth, async (req, res) => {
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    const confirm = String(req.body.confirm_password || '');
    try {
      await schema();
      const policy = await loadSecurityPolicy(pool);
      const [[account]] = await pool.query(
        'SELECT id, username, password FROM tbl_employee WHERE id = ? LIMIT 1',
        [req.session.user.id]
      );
      if (!account) return res.redirect('/logout');
      const ok = await verifyPassword(current, account.password);
      if (!ok) {
        return res.redirect('/account/password?err=' + encodeURIComponent('Your current password is incorrect.'));
      }
      if (next !== confirm) {
        return res.redirect('/account/password?err=' + encodeURIComponent('The new passwords do not match.'));
      }
      const pwdError = validatePassword(next, policy);
      if (pwdError) return res.redirect('/account/password?err=' + encodeURIComponent(pwdError));
      if (next === current) {
        return res.redirect('/account/password?err=' + encodeURIComponent('Choose a different password.'));
      }
      const hash = await hashPassword(next);
      await pool.query(
        'UPDATE tbl_employee SET password = ?, password_must_change = 0, last_reset_at = NOW() WHERE id = ?',
        [hash, account.id]
      );
      if (req.session.user) req.session.user.mustChange = false;
      await logAdminAction(pool, req, 'account.password_change', {
        targetType: 'account',
        targetId: account.id,
        detail: `Changed own password (@${account.username})`,
      });
      const actorRole = String(req.session.user.role || '');
      const perms = res.locals.userPerms || req.session.userPerms || [];
      const canSeeHr =
        actorRole === '1' || actorRole === '99' || perms.includes('*') || perms.some((p) => String(p).indexOf('hr.') === 0);
      return res.redirect((canSeeHr ? '/hr' : '/') + '?msg=' + encodeURIComponent('Password updated.'));
    } catch (e) {
      console.error('[account/password]', e.message);
      return res.redirect('/account/password?err=' + encodeURIComponent(e.message));
    }
  });
};
