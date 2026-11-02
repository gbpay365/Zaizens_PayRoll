'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { loadEnv } = require('./lib/loadEnv');
const { createDbPool, resolveDbConfig } = require('./lib/dbPool');
const { flashT } = require('./lib/flashI18n');
const { pageTitle } = require('./lib/pageTitle');
const hmsI18n = require('./lib/payrollI18n');
const pagination = require('./lib/pagination');
const company = require('./lib/companyBrand');

loadEnv();

const DB_BOOT_CONFIG = resolveDbConfig();
let pool;
try {
  pool = createDbPool();
} catch (e) {
  console.error('[Zaizens_PayRoll] DB config error:', e.message);
  pool = null;
}

const app = express();
const parsedPort = parseInt(process.env.PORT || '', 10);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3010;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
app.use('/img', express.static(path.join(__dirname, 'public', 'img')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'zaizens-payroll-dev',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 },
  })
);

/* Lightweight in-memory login throttling (per IP + username). */
const loginFailures = new Map();

function loginFailureKey(req, username) {
  const ip = String(req.ip || req.socket?.remoteAddress || '').slice(0, 64);
  return `${ip}|${String(username || '').toLowerCase()}`;
}

function pruneLoginFailures(windowMs) {
  if (loginFailures.size < 500) return;
  const cutoff = Date.now() - windowMs;
  for (const [key, rec] of loginFailures) {
    if (!rec || rec.first < cutoff) loginFailures.delete(key);
  }
}

if (!pool) {
  app.get('/__health', (req, res) => {
    res.status(503).json({ ok: false, error: DB_BOOT_CONFIG.error || 'Database not configured' });
  });
} else {
  app.locals.db = pool;
  app.get('/__health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({
        ok: true,
        db: `${DB_BOOT_CONFIG.host}/${DB_BOOT_CONFIG.database}`,
        source: DB_BOOT_CONFIG.source,
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });
}

app.use(hmsI18n.middleware());
app.use((req, res, next) => {
  if (!pool && req.path !== '/__health') {
    const msg = DB_BOOT_CONFIG.error || 'Database not configured for Railway. Set MySQL variables from the MySQL plugin.';
    if (req.method === 'GET' && (req.path === '/' || req.path === '/login')) {
      return res.render('login', {
        title: 'Sign in — ZAIZENS PAY',
        error: msg,
        pageData: {
          error: msg,
          msg: null,
          brand: {
            name: 'ZAIZENS PAY',
            logoPath: '/img/zaizens-pay-mark.svg',
            faviconPath: '/img/zaizens-favicon.svg',
            orgName: company.legalName,
            slipHeader: company.legalName,
            facilityName: company.legalName,
          },
          company,
        },
      });
    }
    return res.status(503).send(msg);
  }
  next();
});

app.use((req, res, next) => {
  res.locals.brand = {
    name: 'ZAIZENS PAY',
    logoPath: '/img/zaizens-pay-mark.svg',
    faviconPath: '/img/zaizens-favicon.svg',
    orgName: company.legalName,
    slipHeader: company.legalName,
    facilityName: company.legalName,
  };
  res.locals.company = company;
  res.locals.user = req.session.user || null;
  res.locals.HMS_PAGE_SIZE = pagination.DEFAULT_PAGE_SIZE;
  res.locals.buildPageUrl = pagination.buildPageUrl;
  res.locals.aclLayout = {
    staffHomeUrlFromSession: () => '/payroll',
    denialRedirectUrl: (_req, home, msg) => `${home}?err=${encodeURIComponent(msg || 'Access denied')}`,
  };
  res.locals.hmsOdooModule = 'payroll';
  res.locals.hmsPath = req.path;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    const back = encodeURIComponent(req.originalUrl || '/payroll');
    return res.redirect('/?err=' + encodeURIComponent('Please sign in.') + '&back=' + back);
  }
  next();
}

function requireAdminOrSuper(req, res, next) {
  const role = String(req.session.user?.role || '');
  if (role === '1' || role === '99') return next();
  return res.status(403).send('Admin access required.');
}

function requirePayrollAccess(req, res, next) {
  const perms = res.locals.userPerms || [];
  if (perms.includes('*') || perms.includes('payroll.read') || perms.includes('payroll.write')) return next();
  return res.redirect('/hr?err=' + encodeURIComponent('Payroll access required.'));
}

function requireHrSelfService(req, res, next) {
  const perms = res.locals.userPerms || [];
  if (perms.includes('*') || perms.includes('hr.self.read') || perms.includes('payroll.read')) return next();
  return res.redirect('/hr?err=' + encodeURIComponent('Access denied.'));
}

function requirePerm(...keys) {
  return (req, res, next) => {
    const perms = res.locals.userPerms || [];
    if (perms.includes('*')) return next();
    for (const k of keys) if (perms.includes(k)) return next();
    return res.status(403).send('Permission denied.');
  };
}

app.use(async (req, res, next) => {
  if (!req.session.user) return next();
  const role = String(req.session.user.role || '');
  if (role === '1' || role === '99') {
    res.locals.userPerms = ['*'];
    return next();
  }
  if (Array.isArray(req.session.userPerms)) {
    res.locals.userPerms = req.session.userPerms;
    return next();
  }
  try {
    const [rows] = await pool.query(
      `SELECT p.code FROM tbl_acl_role_permission rp
       JOIN tbl_acl_permission p ON p.id = rp.permission_id
       WHERE rp.role = ?`,
      [role]
    );
    res.locals.userPerms = rows.length ? rows.map((r) => r.code) : ['payroll.read', 'payroll.write', 'hr.self.read', 'accounting.read'];
    req.session.userPerms = res.locals.userPerms;
  } catch (_) {
    res.locals.userPerms = ['payroll.read', 'payroll.write', 'hr.self.read', 'accounting.read', 'accounting.write'];
  }
  next();
});

/* Users flagged by an administrator must change their password first. */
app.use((req, res, next) => {
  if (!req.session.user || !req.session.user.mustChange) return next();
  const allowed =
    req.path === '/account/password' ||
    req.path === '/logout' ||
    req.path === '/login' ||
    req.path === '/__health' ||
    req.path.startsWith('/css/') ||
    req.path.startsWith('/js/') ||
    req.path.startsWith('/img/') ||
    req.path.startsWith('/public/');
  if (allowed) return next();
  return res.redirect('/account/password?err=' + encodeURIComponent('Set a new password before continuing.'));
});

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/payroll');
  res.render('login', {
    title: 'Sign in — ZAIZENS PAY',
    error: req.query.err || null,
    pageData: {
      error: req.query.err || null,
      msg: req.query.msg || null,
      brand: res.locals.brand,
    },
  });
});

app.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  try {
    await require('./lib/ensureEmployeeHrSchema')(pool);
    const policy = await require('./lib/securityPolicy').loadSecurityPolicy(pool);
    const windowMs = (policy.lockout_minutes || 15) * 60 * 1000;
    const key = loginFailureKey(req, username);
    const attempt = loginFailures.get(key);
    if (attempt && Date.now() - attempt.first < windowMs && attempt.count >= (policy.lockout_threshold || 8)) {
      const waitMin = Math.max(1, Math.ceil((windowMs - (Date.now() - attempt.first)) / 60000));
      return res.redirect('/?err=' + encodeURIComponent(`Too many failed attempts. Try again in ${waitMin} minute(s).`));
    }
    const [rows] = await pool.query(
      'SELECT id, first_name, last_name, username, password, role, password_must_change FROM tbl_employee WHERE username = ? AND status = 1 LIMIT 1',
      [username]
    );
    if (!rows.length) {
      const rec = loginFailures.get(key);
      if (!rec || Date.now() - rec.first >= windowMs) loginFailures.set(key, { count: 1, first: Date.now() });
      else rec.count += 1;
      pruneLoginFailures(windowMs);
      return res.redirect('/?err=' + encodeURIComponent('Invalid username or password.'));
    }
    const user = rows[0];
    const hash = String(user.password || '');
    let ok = false;
    if (hash.startsWith('$2')) {
      const cmp = hash.startsWith('$2y$') ? '$2a$' + hash.slice(4) : hash;
      ok = await bcrypt.compare(password, cmp);
    } else {
      ok = password === hash;
    }
    if (!ok) {
      const rec = loginFailures.get(key);
      if (!rec || Date.now() - rec.first >= windowMs) loginFailures.set(key, { count: 1, first: Date.now() });
      else rec.count += 1;
      pruneLoginFailures(windowMs);
      return res.redirect('/?err=' + encodeURIComponent('Invalid username or password.'));
    }
    loginFailures.delete(key);
    const [[facRow]] = await pool
      .query('SELECT default_facility_id FROM tbl_employee WHERE id = ? LIMIT 1', [user.id])
      .catch(() => [[null]]);
    const defaultFac = parseInt(String(facRow?.default_facility_id || '1'), 10) || 1;
    req.session.user = {
      id: user.id,
      name: `${user.first_name} ${user.last_name}`.trim(),
      username: user.username,
      role: user.role,
      mustChange: Number(user.password_must_change) === 1,
    };
    req.session.facilityId = defaultFac;
    req.session.userPerms = null;
    if (req.session.user.mustChange) {
      return res.redirect('/account/password?err=' + encodeURIComponent('Your administrator requires a new password.'));
    }
    const isAdminRole = String(user.role) === '1' || String(user.role) === '99';
    res.redirect(isAdminRole ? '/payroll' : '/hr');
  } catch (e) {
    res.redirect('/?err=' + encodeURIComponent(e.message));
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/payroll', requireAuth, requirePayrollAccess, async (req, res) => {
  try {
    const { loadPayrollDashboard } = require('./lib/hmsPayrollDashboard');
    const ensureHrPayrollSchema = require('./lib/ensureHrPayrollSchema');
    await ensureHrPayrollSchema(pool);
    const fid = Math.max(1, parseInt(req.session.facilityId, 10) || 1);
    let headcount = 0;
    try {
      const [[r]] = await pool.query('SELECT COUNT(*) AS c FROM tbl_employee WHERE status = 1');
      headcount = Number(r?.c || 0);
    } catch (_) {}
    const metrics = await loadPayrollDashboard(pool, fid).catch(() => ({}));
    const role = String(req.session.user?.role || '');
    const isPayrollAdmin = role === '1' || role === '99';
    const perms = res.locals.userPerms || [];
    res.render('payroll', {
      title: pageTitle(res, 'document_titles.payroll_hr', 'Payroll & HR — ZAIZENS PAY'),
      headcount,
      metrics,
      isPayrollAdmin,
      showHrLeaveAdmin: isPayrollAdmin || perms.includes('hr.leave.approve'),
      canTaxHub: perms.includes('*') || perms.includes('accounting.read'),
      canPayrollSettings: isPayrollAdmin || perms.includes('payroll.write'),
      paySelfServiceEnabled: String(process.env.PAYROLL_SELF_SERVICE_ENABLED || '1') === '1',
      flash: req.query.msg || null,
      error: req.query.err || null,
    });
  } catch (e) {
    res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
});

require('./routes/hrPayroll')(app, pool, requireAuth, {
  requirePayrollAccess,
  requireAdminOrSuper,
  requireHrSelfService,
});
require('./routes/staffDirectory')(app, pool, requireAuth);
require('./routes/taxHub')(app, pool, requireAuth, { requirePerm });
require('./routes/statutoryReports')(app, pool, requireAuth, { requirePerm });
require('./routes/integrationSettings')(app, pool, requireAuth, { requireAdminOrSuper });
require('./routes/employees')(app, pool, requireAuth, { requireAdminOrSuper });
require('./routes/hrHome')(app, pool, requireAuth);
require('./routes/admin')(app, pool, requireAuth);

async function boot() {
  if (pool) {
    try {
      await require('./lib/ensurePayrollBootstrapSchema')(pool);
      await require('./lib/ensureEmployeeHrSchema')(pool);
      await require('./lib/ensureHrPayrollSchema')(pool);
      await require('./lib/ensureFacilityIntegrationSchema')(pool);
      await require('./lib/ensureAdminSchema')(pool).catch((e) => console.warn('[admin schema]', e.message));
      console.log('[Zaizens_PayRoll] schema ready');
    } catch (e) {
      console.warn('[Zaizens_PayRoll] schema:', e.message);
    }
  }
  const server = app.listen(PORT, '0.0.0.0', () => {
    const addr = server.address();
    const boundPort = addr && typeof addr === 'object' ? addr.port : PORT;
    console.log(`ZAIZENS PAY listening on port ${boundPort}`);
  });
}

boot();
