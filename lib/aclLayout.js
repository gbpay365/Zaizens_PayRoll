'use strict';

const { parseSlicesJson, elementAllowedBySlices } = require('./aclNavSlices');
const { groupSidebarItems } = require('./aclNavGroups');
const {
  ACCOUNTING_TOPNAV_PARENT_ORDER,
  ACCOUNTING_PRIMARY_CODES,
} = require('./aclAccountingNav');
const deploymentConfig = require('./deploymentConfig');
const portalRegistry = require('./portalRegistry');
const navAccessRuntime = require('./navAccessRuntime');
const staffHomePortal = require('./staffHomePortal');

/**
 * In-memory layout cache for sidebar, top nav, portal tiles, and action menus.
 */

let _pool = null;
let _byPortal = new Map();
let _byCode = new Map();
let _rolePortals = new Map();
let _roleHidden = new Map();
let _productSlices = ['full'];
let _moduleOverrides = {};
let _lastUiRows = [];
/** Role ids treated as doctors for Pattern B home portal (refreshed from DB). */
let _doctorRoleIds = Object.freeze(['2', '100']);

const PORTAL_PATH = Object.freeze({
  front_desk: '/portal/front-desk',
  doctors: '/portal/doctor',
  nursing: '/portal/nurse',
  laboratory: '/portal/lab',
  cashier: '/portal/cashier',
  pharmacy: '/portal/pharmacy',
  radiology: '/portal/radiology',
  accountant: '/payroll',
  patient_support: '/portal/login',
});

const TOPNAV_PARENT_ORDER = Object.freeze([
  'topnav.clinical',
  'topnav.operations',
  'topnav.hr',
  'topnav.configuration',
]);

const TOPBAR_PRIMARY_CODES = Object.freeze(['sb.hms_hub', 'sb.patients', 'sb.appointments']);

function portalUrl(portalCode) {
  return portalRegistry.portalUrl(portalCode);
}

function homePortalOptsFromSession(session) {
  const u = session && session.user;
  if (!u) return {};
  if (u.specialisation === undefined || u.specialisation === null) {
    return { specialisation: null };
  }
  return { specialisation: u.specialisation };
}

function staffHomeUrl(role, opts) {
  const r = String(role != null ? role : '');
  if (r === '99') return '/super-admin';
  if (r === '1') return '/hms';
  const list = portalsForRole(r);
  if (!list.length) return null;
  const code = homePortal(r, opts);
  if (code === 'accountant') return '/payroll';
  return code ? portalUrl(code) : '/portal/front-desk';
}

function staffHomeUrlFromSession(session) {
  const role = String(session?.user?.role || '');
  return staffHomeUrl(role, homePortalOptsFromSession(session));
}

function hasDashboardAccess(perms) {
  const p = Array.isArray(perms) ? perms : [];
  return p.includes('*') || p.includes('dashboard.read');
}

function isDoctorRole(role) {
  return _doctorRoleIds.includes(String(role ?? ''));
}

/** Preferred clinical landing: admin → HMS hub, doctors with dashboard → /dashboard, else portal home. */
function staffLandingUrl(role, opts, perms) {
  const r = String(role != null ? role : '');
  if (r === '99') return '/super-admin';
  if (r === '1') return '/hms';
  if (hasDashboardAccess(perms) && isDoctorRole(r)) return '/dashboard';
  return staffHomeUrl(role, opts);
}

function staffLandingUrlFromSession(session, perms) {
  const role = String(session?.user?.role || '');
  return staffLandingUrl(role, homePortalOptsFromSession(session), perms);
}

function normalizePathOnly(url) {
  const s = String(url || '').trim().split('?')[0];
  return s || '/';
}

/**
 * After permission denial, redirect somewhere safe — never back to the same path
 * (e.g. /financials → /financials?err=… loops until chrome-error://chromewebdata/).
 */
function denialRedirectUrl(req, preferredHome, message) {
  const msg = String(message || 'Access denied.');
  const enc = encodeURIComponent(msg);
  const current = normalizePathOnly(req.path);
  let home = normalizePathOnly(preferredHome);
  if (!home || home === '/') home = '/profile';

  if (current !== home && !(home !== '/' && current.startsWith(home + '/'))) {
    return home + '?err=' + enc;
  }

  const r = String(req.session?.user?.role || '');
  if (r === '99') return '/super-admin?err=' + enc;
  if (r === '1') return '/hms?err=' + enc;

  const alt = normalizePathOnly(staffHomeUrlFromSession(req.session));
  if (alt && alt !== current && alt !== home) {
    return alt + '?err=' + enc;
  }
  return '/profile?err=' + enc;
}

function init(pool) {
  _pool = pool;
  return refresh();
}

function isPortalCacheReady() {
  return _rolePortals.size > 0;
}

/** Load role↔portal cache if boot migrations have not finished yet (login race). */
async function ensurePortalCacheReady() {
  if (_rolePortals.size > 0) return true;
  if (!_pool) return false;
  await refresh();
  return _rolePortals.size > 0;
}

async function refresh() {
  if (!_pool) return;
  try {
    const [rows] = await _pool.query(
      `SELECT id, code, portal_code, kind, parent_code, label, url, icon, color,
              sort_order, required_perm, enabled
         FROM tbl_acl_ui_element
        WHERE enabled = 1
        ORDER BY portal_code, kind, sort_order, label`
    );
    const map = new Map();
    const cmap = new Map();
    for (const r of rows) {
      const list = map.get(r.portal_code) || [];
      list.push(r);
      map.set(r.portal_code, list);
      cmap.set(String(r.code), r);
    }
    _byPortal = map;
    _byCode = cmap;
    _lastUiRows = rows;

    try {
      const aclRouteRegistry = require('./aclRouteRegistry');
      aclRouteRegistry.refresh(rows);
    } catch (_) { /* optional */ }

    try {
      await deploymentConfig.loadDeployment(_pool);
      _productSlices = deploymentConfig.getSlices();
      _moduleOverrides = deploymentConfig.getModuleOverrides();
    } catch (_) {
      _productSlices = ['full'];
      _moduleOverrides = {};
    }

    const [rp] = await _pool.query(`SELECT role, portal_code, is_home FROM tbl_acl_role_portal`);
    const rmap = new Map();
    for (const r of rp) {
      const list = rmap.get(String(r.role)) || [];
      list.push({ portal_code: r.portal_code, is_home: !!r.is_home });
      rmap.set(String(r.role), list);
    }
    _rolePortals = rmap;

    const hmap = new Map();
    try {
      const [hid] = await _pool.query(`SELECT role, element_code FROM tbl_acl_role_ui_hidden`);
      for (const h of hid) {
        const rr = String(h.role);
        if (!hmap.has(rr)) hmap.set(rr, new Set());
        hmap.get(rr).add(String(h.element_code));
      }
    } catch (_) { /* legacy */ }
    _roleHidden = hmap;

    try {
      const { resolveDoctorRoleIds } = require('./hmsDoctorSpecialisations');
      const ids = await resolveDoctorRoleIds(_pool);
      _doctorRoleIds = Object.freeze((ids && ids.length ? ids : ['2', '100']).map(String));
    } catch (_) {
      _doctorRoleIds = Object.freeze(['2', '100']);
    }

    try {
      await portalRegistry.refresh(_pool);
    } catch (_) { /* optional */ }

    try {
      const { ensureNavAccessSchema } = require('./ensureNavAccessSchema');
      await ensureNavAccessSchema(_pool);
      const [ng] = await _pool.query(
        'SELECT role, nav_code, granted FROM tbl_acl_role_nav_grant'
      );
      navAccessRuntime.clearNavGrants();
      const byRoleGrant = new Map();
      const byRoleDeny = new Map();
      for (const row of ng || []) {
        const rr = String(row.role);
        const code = String(row.nav_code);
        const bucket = row.granted === 1 ? byRoleGrant : byRoleDeny;
        if (!bucket.has(rr)) bucket.set(rr, []);
        bucket.get(rr).push(code);
      }
      for (const [rr, codes] of byRoleGrant) navAccessRuntime.setRoleNavGrants(rr, codes);
      for (const [rr, codes] of byRoleDeny) navAccessRuntime.setRoleNavDenials(rr, codes);
    } catch (_) { /* optional */ }

  } catch (_) {
    /* schema may not exist yet */
  }
}

function visible(item, userPerms) {
  if (!item || item.enabled === 0) return false;
  const req = String(item.required_perm || '').trim();
  if (!req || req === '*') return true;
  if (!Array.isArray(userPerms) || userPerms.length === 0) return false;
  if (userPerms.includes('*')) return true;
  const keys = req.split('|').map((s) => s.trim()).filter(Boolean);
  for (const k of keys) {
    if (k === '*') return true;
    if (userPerms.includes(k)) return true;
  }
  return false;
}

function isRoleHidden(roleOpt, code) {
  if (roleOpt == null || roleOpt === '') return false;
  const set = _roleHidden.get(String(roleOpt));
  if (!set) return false;
  const c = String(code);
  if (set.has(c)) return true;
  const item = _byCode.get(c);
  if (!item) return false;
  const url = String(item.url || '').trim();
  if (!url || url === '__home__') return false;
  for (const r of _lastUiRows) {
    if (String(r.url || '').trim() === url && set.has(String(r.code))) return true;
  }
  return false;
}

/** Extra visibility rules not expressible in required_perm alone. */
function passesNavRules(item, roleOpt, opts) {
  const code = String(item.code || '');
  const role = String(roleOpt != null ? roleOpt : '');
  const viewerRole = String(opts.viewerRole != null ? opts.viewerRole : role);

  if (code === 'topnav.cfg.super_admin' || code === 'sb.super_admin') {
    return viewerRole === '99';
  }
  if (code === 'sb.subscriptions' || code === 'topnav.cfg.subscriptions') {
    const { canManageLicenses } = require('./hmsLicense');
    return canManageLicenses(viewerRole);
  }
  if (
    code === 'topnav.cfg.consultation_rooms'
    || code === 'sb.consultation_rooms'
    || code === 'topnav.cfg.hms_config'
  ) {
    const { canManageConsultationRooms } = require('./consultationRoomsAccess');
    return canManageConsultationRooms(viewerRole, opts.userPerms);
  }
  return true;
}

/** Permission gate with role-based bypasses for items not expressible in required_perm alone. */
function permVisible(item, userPerms, roleOpt, opts) {
  const code = String(item.code || '');
  if (
    (code === 'topnav.cfg.consultation_rooms'
      || code === 'sb.consultation_rooms'
      || code === 'topnav.cfg.hms_config')
    && passesNavRules(item, roleOpt, { ...opts, userPerms })
  ) {
    return true;
  }
  return visible(item, userPerms);
}

function navItemVisible(item, userPerms, roleOpt, opts) {
  opts = opts || {};
  if (!item || item.enabled === 0) return false;
  const viewerRole = String(opts.viewerRole != null ? opts.viewerRole : roleOpt != null ? roleOpt : '');
  const role = String(roleOpt != null ? roleOpt : '');
  const code = String(item.code || '');
  const navGrantMode = navAccessRuntime.roleUsesNavGrants(role);

  // Hospital deployment profile (HMS vs Full suite) always limits which
  // catalogue items can appear — navigation grants only refine within that set.
  const licenseNavCodes = new Set(['sb.subscriptions', 'topnav.cfg.subscriptions']);
  if (viewerRole !== '99' && !licenseNavCodes.has(code)) {
    const slices = opts.productSlices || _productSlices;
    const overrides = opts.moduleOverrides || _moduleOverrides;
    if (!elementAllowedBySlices(item.code, slices, overrides)) return false;
  }

  let grantedByNav = false;
  const kind = String(item.kind || '');
  const navGrantKinds = new Set(['sidebar', 'topnav', 'topnav_item', 'fin_topnav', 'fin_topnav_item']);
  // Portal tiles + HMS hub widgets use permissions (+ Navigation Studio hide) only — not nav grants.
  if (navGrantMode && navGrantKinds.has(kind)) {
    if (code === 'sb.home' || String(item.url || '') === '__home__') {
      grantedByNav = true;
    } else {
      let ok = navAccessRuntime.hasNavGrant(role, code);
      if (!ok && item.kind === 'topnav') {
        const kids = _lastUiRows.filter((r) => String(r.parent_code || '') === code);
        ok = kids.some((k) => navAccessRuntime.hasNavGrant(role, String(k.code)));
      }
      if (!ok) return false;
      grantedByNav = true;
    }
  }

  if (!permVisible(item, userPerms, roleOpt, opts)) return false;

  if (!grantedByNav && opts.applyRoleHide !== false && isRoleHidden(roleOpt, item.code)) {
    return false;
  }
  if (!passesNavRules(item, roleOpt, { ...opts, userPerms })) return false;
  return true;
}

function actionMenuVisible(code, userPerms, roleOpt) {
  const item = _byCode.get(String(code));
  if (!item || item.kind !== 'action_menu' || item.enabled === 0) return false;
  if (!visible(item, userPerms)) return false;
  if (isRoleHidden(roleOpt, item.code)) return false;
  return true;
}

/** Single catalogue element: slices, permissions, and role UI hide (Navigation Studio). */
function uiElementVisible(code, userPerms, roleOpt, opts) {
  const item = _byCode.get(String(code));
  if (!item) return false;
  return navItemVisible(item, userPerms, roleOpt, opts);
}

/** All UI codes that share the same target URL (e.g. sidebar + topnav + portal hero). */
function urlAliasedCodes(code) {
  const item = _byCode.get(String(code));
  if (!item) return [String(code)];
  const url = String(item.url || '').trim();
  if (!url || url === '__home__') return [String(code)];
  const codes = new Set([String(code)]);
  for (const r of _lastUiRows) {
    if (String(r.url || '').trim() === url) codes.add(String(r.code));
  }
  return [...codes];
}

function forPortal(portalCode, userPerms, roleOpt, opts) {
  opts = opts || {};
  const list = _byPortal.get(portalCode) || [];
  const out = {
    sidebar: [],
    tile: [],
    stat: [],
    card: [],
    button: [],
    section: [],
    action_menu: [],
    topnav: [],
    topnav_item: [],
    fin_topnav: [],
    fin_topnav_item: [],
  };
  for (const it of list) {
    if (!navItemVisible(it, userPerms, roleOpt, opts)) continue;
    if (out[it.kind]) out[it.kind].push(it);
  }
  return {
    sidebar: out.sidebar,
    tiles: out.tile,
    stats: out.stat,
    cards: out.card,
    buttons: out.button,
    sections: out.section,
    actionMenus: out.action_menu,
    topnav: out.topnav,
    topnavItems: out.topnav_item,
    finTopnav: out.fin_topnav,
    finTopnavItems: out.fin_topnav_item,
  };
}

function forSidebar(userPerms, roleOpt, opts) {
  return forPortal('global', userPerms, roleOpt, opts).sidebar;
}

/** Top-level dropdown: show when children exist and section nav grant passes (grant mode) or parent ACL passes (legacy). */
function topnavSectionVisible(parent, children, userPerms, roleOpt, opts) {
  if (!parent || !Array.isArray(children) || !children.length) return false;
  const role = String(roleOpt != null ? roleOpt : '');
  const navGrantMode = navAccessRuntime.roleUsesNavGrants(role);
  if (navGrantMode) {
    let ok = navAccessRuntime.hasNavGrant(role, String(parent.code || ''));
    if (!ok) {
      ok = children.some((ch) => navAccessRuntime.hasNavGrant(role, String(ch.code || '')));
    }
    if (!ok) return false;
    if (opts.applyRoleHide !== false && isRoleHidden(roleOpt, parent.code)) {
      const parentGranted = navAccessRuntime.hasNavGrant(role, String(parent.code || ''));
      if (!parentGranted) return false;
    }
    return true;
  }
  return navItemVisible(parent, userPerms, roleOpt, opts);
}

/**
 * Top navigation: primary links + dropdown menus from catalogue.
 */
function buildTopNav(userPerms, roleOpt, opts) {
  opts = opts || {};
  const global = _byPortal.get('global') || [];
  const primaryLinks = [];
  for (const code of TOPBAR_PRIMARY_CODES) {
    const it = _byCode.get(code);
    if (it && navItemVisible(it, userPerms, roleOpt, opts)) primaryLinks.push(it);
  }

  const menus = [];
  for (const pcode of TOPNAV_PARENT_ORDER) {
    const parent = _byCode.get(pcode);
    if (!parent || parent.kind !== 'topnav') continue;
    const children = global
      .filter((it) => it.kind === 'topnav_item' && it.parent_code === pcode)
      .filter((it) => navItemVisible(it, userPerms, roleOpt, opts));
    if (!children.length) continue;
    if (!topnavSectionVisible(parent, children, userPerms, roleOpt, opts)) continue;
    menus.push({ parent, children });
  }

  return { primaryLinks, menus };
}

/**
 * Accounting module shell top bar (portal accountant · fin_topnav catalogue).
 */
function buildAccountingModuleNav(userPerms, roleOpt, opts) {
  opts = opts || {};
  const accountant = _byPortal.get('accountant') || [];
  let shellBrand = null;
  const brandItem = _byCode.get('fin.nav.shell_brand');
  if (brandItem && navItemVisible(brandItem, userPerms, roleOpt, opts)) {
    shellBrand = brandItem;
  }

  const primaryLinks = [];
  for (const code of ACCOUNTING_PRIMARY_CODES) {
    const it = _byCode.get(code);
    if (it && it.kind === 'fin_topnav' && navItemVisible(it, userPerms, roleOpt, opts)) {
      primaryLinks.push(it);
    }
  }

  const menus = [];
  for (const pcode of ACCOUNTING_TOPNAV_PARENT_ORDER) {
    const parent = _byCode.get(pcode);
    if (!parent || parent.kind !== 'fin_topnav') continue;
    if (!navItemVisible(parent, userPerms, roleOpt, opts)) continue;
    const children = accountant
      .filter((it) => it.kind === 'fin_topnav_item' && it.parent_code === pcode)
      .filter((it) => navItemVisible(it, userPerms, roleOpt, opts));
    if (!children.length) continue;
    menus.push({ parent, children });
  }

  return { primaryLinks, menus, shellBrand };
}

/**
 * Sidebar sections with filtered items (excludes home — rendered separately).
 */
function buildSidebarNav(userPerms, roleOpt, opts) {
  opts = opts || {};
  const items = forSidebar(userPerms, roleOpt, opts).filter((it) => it.code !== 'sb.home');
  return groupSidebarItems(items);
}

/** Catalogue rows for Navigation Studio (unfiltered). */
function catalogueForStudio(shell) {
  const global = _byPortal.get('global') || [];
  if (shell === 'topnav') {
    const menus = [];
    for (const pcode of TOPNAV_PARENT_ORDER) {
      const parent = global.find((it) => it.code === pcode && it.kind === 'topnav');
      if (!parent) continue;
      const children = global.filter((it) => it.kind === 'topnav_item' && it.parent_code === pcode);
      menus.push({ parent, children });
    }
    return { shell: 'topnav', menus, flat: global.filter((it) => TOPBAR_PRIMARY_CODES.includes(it.code)) };
  }
  if (shell === 'accounting') {
    const accountant = _byPortal.get('accountant') || [];
    const menus = [];
    for (const pcode of ACCOUNTING_TOPNAV_PARENT_ORDER) {
      const parent = accountant.find((it) => it.code === pcode && it.kind === 'fin_topnav');
      if (!parent) continue;
      const children = accountant.filter(
        (it) => it.kind === 'fin_topnav_item' && it.parent_code === pcode
      );
      menus.push({ parent, children });
    }
    return {
      shell: 'accounting',
      menus,
      flat: accountant.filter(
        (it) =>
          it.kind === 'fin_topnav' &&
          (ACCOUNTING_PRIMARY_CODES.includes(it.code) || it.code === 'fin.nav.shell_brand')
      ),
    };
  }
  if (shell === 'sidebar') {
    const items = global.filter((it) => it.kind === 'sidebar' && it.code !== 'sb.home');
    return { shell: 'sidebar', sections: groupSidebarItems(items), flat: items };
  }
  if (shell === 'dashboard') {
    const dash = _byPortal.get('dashboard') || [];
    const cards = dash.filter((it) => it.kind === 'card');
    const buttons = dash.filter((it) => it.kind === 'button');
    const sections = dash.filter((it) => it.kind === 'section');
    return { shell: 'dashboard', cards, buttons, sections, flat: dash };
  }
  if (shell === 'hms_hub') {
    const hub = _byPortal.get('hms') || [];
    return {
      shell: 'hms_hub',
      stats: hub.filter((it) => it.kind === 'stat'),
      cards: hub.filter((it) => it.kind === 'card'),
      sections: hub.filter((it) => it.kind === 'section'),
      flat: hub,
    };
  }
  return { shell, sections: [], menus: [], flat: [] };
}

function applyStudioVisibility(rows, role, hiddenSet) {
  const hidden = hiddenSet || _roleHidden.get(String(role)) || new Set();
  return (rows || []).map((r) => ({
    ...r,
    isHidden: hidden.has(String(r.code)),
  }));
}

/** Navigation Studio: full catalogue + per-role hide flags. */
function studioPackForRole(shell, role) {
  const cat = catalogueForStudio(shell);
  const hidden = _roleHidden.get(String(role)) || new Set();
  const mark = (r) => ({ ...r, isHidden: hidden.has(String(r.code)) });
  if (shell === 'topnav') {
    return {
      shell: 'topnav',
      primaryLinks: applyStudioVisibility(
        (cat.flat || []).filter((it) => TOPBAR_PRIMARY_CODES.includes(it.code)),
        role,
        hidden
      ),
      menus: (cat.menus || []).map((m) => ({
        parent: mark(m.parent),
        children: applyStudioVisibility(m.children || [], role, hidden),
      })),
    };
  }
  if (shell === 'accounting') {
    return {
      shell: 'accounting',
      primaryLinks: applyStudioVisibility(
        (cat.flat || []).filter(
          (it) =>
            ACCOUNTING_PRIMARY_CODES.includes(it.code) || it.code === 'fin.nav.shell_brand'
        ),
        role,
        hidden
      ),
      menus: (cat.menus || []).map((m) => ({
        parent: mark(m.parent),
        children: applyStudioVisibility(m.children || [], role, hidden),
      })),
    };
  }
  if (shell === 'dashboard') {
    return {
      shell: 'dashboard',
      cards: applyStudioVisibility(cat.cards || [], role, hidden),
      buttons: applyStudioVisibility(cat.buttons || [], role, hidden),
      sections: applyStudioVisibility(cat.sections || [], role, hidden),
      flat: applyStudioVisibility(cat.flat || [], role, hidden),
    };
  }
  if (shell === 'hms_hub') {
    return {
      shell: 'hms_hub',
      stats: applyStudioVisibility(cat.stats || [], role, hidden),
      cards: applyStudioVisibility(cat.cards || [], role, hidden),
      sections: applyStudioVisibility(cat.sections || [], role, hidden),
      flat: applyStudioVisibility(cat.flat || [], role, hidden),
    };
  }
  return {
    shell: 'sidebar',
    sections: (cat.sections || []).map((sec) => ({
      ...sec,
      items: applyStudioVisibility(sec.items || [], role, hidden),
    })),
    flat: applyStudioVisibility(cat.flat || [], role, hidden),
  };
}

/** Child UI element codes for a parent menu (Navigation Studio cascade hide). */
function descendantCodes(parentCode) {
  const p = String(parentCode || '');
  const codes = [p];
  for (const r of _lastUiRows) {
    if (String(r.parent_code || '') === p) codes.push(String(r.code));
  }
  return codes;
}

/** All element codes for a navigation shell (bulk show/hide). */
function allCodesForShell(shell) {
  const global = _byPortal.get('global') || [];
  if (shell === 'sidebar') {
    return global.filter((it) => it.kind === 'sidebar').map((it) => it.code);
  }
  if (shell === 'topnav') {
    const codes = global.filter((it) => it.kind === 'topnav' || it.kind === 'topnav_item').map((it) => it.code);
    return codes;
  }
  if (shell === 'accounting') {
    const accountant = _byPortal.get('accountant') || [];
    return accountant
      .filter((it) => it.kind === 'fin_topnav' || it.kind === 'fin_topnav_item')
      .map((it) => it.code);
  }
  if (shell === 'dashboard') {
    return (_byPortal.get('dashboard') || []).map((it) => it.code);
  }
  if (shell === 'hms_hub') {
    return (_byPortal.get('hms') || []).map((it) => it.code);
  }
  return [];
}

function portalsForRole(role) {
  return _rolePortals.get(String(role)) || [];
}

function homePortal(role, opts) {
  const r = String(role != null ? role : '');
  const rolePortals = portalsForRole(r);
  return staffHomePortal.resolveEffectiveHomePortalCode(r, {
    specialisation: opts && opts.specialisation !== undefined ? opts.specialisation : undefined,
    rolePortals,
    doctorRoleIds: _doctorRoleIds,
  });
}

/** Sidebar links for every portal assigned to a role (when more than one). */
function buildStaffPortalMenu(role) {
  const r = String(role != null ? role : '');
  if (!r || r === '1' || r === '99') return [];
  const list = portalsForRole(r);
  if (list.length <= 1) return [];
  return list
    .map((p) => {
      const meta = portalRegistry.getPortal(p.portal_code);
      return {
        code: p.portal_code,
        label: (meta && meta.label) || String(p.portal_code).replace(/_/g, ' '),
        url: portalRegistry.portalUrl(p.portal_code),
        is_home: !!p.is_home,
        icon: (meta && meta.icon) || 'fa-th-large',
        color: (meta && meta.color) || '#714b67',
      };
    })
    .sort((a, b) => (b.is_home - a.is_home) || a.label.localeCompare(b.label));
}

function getProductSlices() {
  return _productSlices.slice();
}

function getModuleOverrides() {
  return { ..._moduleOverrides };
}

function getDeploymentSummary() {
  return deploymentConfig.getDeployment();
}

module.exports = {
  init,
  refresh,
  forPortal,
  forSidebar,
  buildTopNav,
  buildAccountingModuleNav,
  buildSidebarNav,
  catalogueForStudio,
  applyStudioVisibility,
  studioPackForRole,
  allCodesForShell,
  descendantCodes,
  urlAliasedCodes,
  uiElementVisible,
  visible,
  navItemVisible,
  isRoleHidden,
  actionMenuVisible,
  portalsForRole,
  buildStaffPortalMenu,
  homePortal,
  homePortalOptsFromSession,
  isPortalCacheReady,
  ensurePortalCacheReady,
  portalUrl,
  staffHomeUrl,
  staffHomeUrlFromSession,
  staffLandingUrl,
  staffLandingUrlFromSession,
  hasDashboardAccess,
  denialRedirectUrl,
  getDoctorRoleIds: () => _doctorRoleIds.slice(),
  getProductSlices,
  getModuleOverrides,
  getDeploymentSummary,
  TOPNAV_PARENT_ORDER,
  TOPBAR_PRIMARY_CODES,
};
