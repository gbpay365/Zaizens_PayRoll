'use strict';

const { ensurePortalSchema } = require('./ensurePortalSchema');
const { ensureNavAccessSchema } = require('./ensureNavAccessSchema');
const navAccessCatalog = require('./navAccessCatalog');

async function loadAccessControlContext(pool, query = {}) {
    await ensurePortalSchema(pool).catch((e) => {
        console.warn('[loadAccessControlContext] ensurePortalSchema:', e.message);
    });
    await ensureNavAccessSchema(pool).catch((e) => {
        console.warn('[loadAccessControlContext] ensureNavAccessSchema:', e.message);
    });

    async function sq(sql, params = []) {
        const [rows] = await pool.query(sql, params);
        return rows;
    }

        const [roles, portals, allPerms, allRoles, wfRows, modules] = await Promise.all([
            sq(`SELECT t.role, t.title
                  FROM tbl_role t
                  INNER JOIN (SELECT role, MIN(id) AS id FROM tbl_role GROUP BY role) m
                          ON m.id = t.id
                 WHERE t.role NOT IN ('1','99')
                 ORDER BY CAST(t.role AS UNSIGNED)`),
            sq(`SELECT code, label, sort_order, home_url, icon, color, description, enabled, is_builtin
                  FROM tbl_acl_portal ORDER BY sort_order, label`).catch(() =>
              sq('SELECT code, label, sort_order FROM tbl_acl_portal ORDER BY sort_order')
            ),
            sq('SELECT * FROM tbl_acl_permission ORDER BY module_code, action, label'),
            sq(`SELECT t.role, t.title
                  FROM tbl_role t
                  INNER JOIN (SELECT role, MIN(id) AS id FROM tbl_role GROUP BY role) m
                          ON m.id = t.id
                 ORDER BY t.title`),
            sq('SELECT * FROM tbl_workflow_step_roles ORDER BY workflow, step_order'),
            sq('SELECT code, label, icon, color, sort_order FROM tbl_acl_module ORDER BY sort_order, label')
                .catch(() => []),
        ]);

        // Resolve display info for any module_code referenced by a permission
        // but missing from tbl_acl_module (covers freshly-added perms before
        // the module catalogue has caught up).
        const modByCode = new Map();
        for (const m of (modules || [])) modByCode.set(m.code, m);
        function moduleMeta(code) {
            if (modByCode.has(code)) return modByCode.get(code);
            const fallback = { code: code || 'misc', label: (code || 'Other').replace(/_/g, ' '),
                               icon: 'fa-cube', color: '#475569', sort_order: 999 };
            modByCode.set(code, fallback);
            return fallback;
        }

        // Group ALL permissions by module so the Permission Manager and the
        // Role Permission board can render them in tidy sections instead of
        // one long flat list.
        function groupByModule(perms) {
            const buckets = new Map();
            for (const p of perms) {
                const code = p.module_code || (String(p.code || '').split('.')[0]) || 'misc';
                if (!buckets.has(code)) buckets.set(code, { meta: moduleMeta(code), items: [] });
                buckets.get(code).items.push(p);
            }
            return Array.from(buckets.values())
                .sort((a, b) => (a.meta.sort_order || 999) - (b.meta.sort_order || 999)
                              || String(a.meta.label).localeCompare(b.meta.label));
        }
        const allPermsGrouped = groupByModule(allPerms);

        const opdSteps = [], ipdSteps = [], emgSteps = [];
        for (const r of wfRows) {
            r.portals = (r.portal_codes || '').split(',').map(s=>s.trim()).filter(Boolean);
            if (r.workflow === 'opd') opdSteps.push(r);
            else if (r.workflow === 'ipd') ipdSteps.push(r);
            else if (r.workflow === 'emg') emgSteps.push(r);
        }

        const plMap = {};
        for (const p of portals) plMap[p.code] = p.label;

        // Role permissions (for selected role)
        const selRole = String(query.role || (roles[0]?.role ?? ''));
        let assignedPerms = [], availablePerms = [], selRoleTitle = '';
        let assignedPermsGrouped = [], availablePermsGrouped = [];
        if (selRole) {
            const r = roles.find(r => String(r.role) === selRole);
            selRoleTitle = r ? r.title : '';
            assignedPerms = await sq(
                'SELECT p.* FROM tbl_acl_permission p INNER JOIN tbl_acl_role_permission rp ON p.id=rp.permission_id WHERE rp.role=? ORDER BY p.module_code, p.action, p.label',
                [selRole]);
            const assignedIds = new Set(assignedPerms.map(p => p.id));
            availablePerms = allPerms.filter(p => !assignedIds.has(p.id));
            assignedPermsGrouped  = groupByModule(assignedPerms);
            availablePermsGrouped = groupByModule(availablePerms);
        }

        // ── Per-role UI element catalogue.
        //    Lets the admin toggle individual cards/sidebar links on/off per
        //    role without revoking the underlying permission. Backed by
        //    tbl_acl_role_ui_hidden + tbl_acl_ui_element.
        //
        //    Groups produced:
        //      • One entry per non-global portal (kind='tile') — dashboard tiles
        //      • One entry for portal_code='global' (kind='sidebar') — header sidebar
        let uiPortalTilesGrouped = [];
        let uiGlobalSidebar = [];
        let uiTopNavMenus = [];
        let uiActionMenusGrouped = [];
        if (selRole && !['1', '99'].includes(String(selRole))) {
            try {
                const hiddenRows = await sq(
                    'SELECT element_code FROM tbl_acl_role_ui_hidden WHERE role=?',
                    [selRole]
                );
                const hidden = new Set(hiddenRows.map(h => h.element_code));

                const sidebarTiles = await sq(
                    `SELECT code, label, icon, color, url, required_perm, sort_order
                       FROM tbl_acl_ui_element
                      WHERE portal_code='global' AND kind='sidebar' AND enabled=1
                      ORDER BY sort_order, label`
                );
                uiGlobalSidebar = sidebarTiles.map(t => Object.assign({}, t, { isHidden: hidden.has(t.code) }));

                const topnavTiles = await sq(
                    `SELECT code, label, icon, color, url, required_perm, sort_order, parent_code, kind
                       FROM tbl_acl_ui_element
                      WHERE portal_code='global' AND kind IN ('topnav','topnav_item') AND enabled=1
                      ORDER BY sort_order, label`
                );
                const topnavByCode = new Map();
                for (const t of topnavTiles) {
                    topnavByCode.set(t.code, Object.assign({}, t, { isHidden: hidden.has(t.code) }));
                }
                const topnavParentOrder = [
                    'topnav.clinical',
                    'topnav.operations',
                    'topnav.hr',
                    'topnav.configuration',
                ];
                for (const pcode of topnavParentOrder) {
                    const parent = topnavByCode.get(pcode);
                    if (!parent) continue;
                    const children = topnavTiles
                        .filter(t => t.parent_code === pcode)
                        .map(t => topnavByCode.get(t.code))
                        .filter(Boolean);
                    uiTopNavMenus.push({ parent, children });
                }

                // Portal-specific dashboard tiles (staff portals only).
                const portRows = await sq(
                    `SELECT DISTINCT portal_code FROM tbl_acl_ui_element
                      WHERE kind IN ('tile','button') AND portal_code <> 'global'
                      ORDER BY portal_code`
                );
                const portalTabOrder = [
                    'front_desk', 'patient_support', 'doctors', 'nursing',
                    'cashier', 'laboratory', 'pharmacy', 'radiology', 'accountant',
                    'inventory', 'procurement', 'hr', 'emergency',
                ];
                portRows.sort((a, b) => {
                    const pa = a.portal_code;
                    const pb = b.portal_code;
                    const ia = portalTabOrder.indexOf(pa);
                    const ib = portalTabOrder.indexOf(pb);
                    const ra = ia === -1 ? 1000 : ia;
                    const rb = ib === -1 ? 1000 : ib;
                    if (ra !== rb) return ra - rb;
                    return String(pa).localeCompare(String(pb));
                });
                for (const pr of portRows) {
                    const pc = pr.portal_code;
                    const tiles = await sq(
                        `SELECT code, label, icon, color, url, required_perm, sort_order, kind
                           FROM tbl_acl_ui_element
                          WHERE portal_code=? AND kind IN ('tile','button') AND enabled=1
                          ORDER BY sort_order, label`,
                        [pc]
                    );
                    uiPortalTilesGrouped.push({
                        portal_code: pc,
                        portal_label: plMap[pc] || String(pc).replace(/_/g, ' '),
                        tiles: tiles.map(t => Object.assign({}, t, { isHidden: hidden.has(t.code) })),
                    });
                }

                const actionMenuScreenLabels = {
                    patients: 'Patient Directory',
                    opd_queue: 'OPD Queue',
                    laboratory: 'Laboratory',
                    radiology: 'Radiology',
                    employees: 'Employees',
                    prescriptions: 'Prescriptions',
                    staff: 'Staff',
                    inventory: 'Inventory',
                    appointments: 'Appointments',
                };
                const amOrder = [
                    'patients', 'opd_queue', 'laboratory', 'radiology', 'employees',
                    'prescriptions', 'staff', 'inventory', 'appointments',
                ];
                const amRows = await sq(
                    `SELECT code, label, icon, color, parent_code, required_perm, sort_order
                       FROM tbl_acl_ui_element
                      WHERE portal_code='action_menus' AND kind='action_menu' AND enabled=1
                      ORDER BY parent_code, sort_order, label`
                );
                const byParent = new Map();
                for (const r of amRows) {
                    const key = String(r.parent_code || 'other');
                    if (!byParent.has(key)) byParent.set(key, []);
                    byParent.get(key).push(Object.assign({}, r, {
                        isHidden: hidden.has(r.code),
                        screen_label: actionMenuScreenLabels[key] || key.replace(/_/g, ' '),
                    }));
                }
                uiActionMenusGrouped = Array.from(byParent.entries())
                    .sort((a, b) => {
                        const ia = amOrder.indexOf(a[0]);
                        const ib = amOrder.indexOf(b[0]);
                        const ra = ia === -1 ? 1000 : ia;
                        const rb = ib === -1 ? 1000 : ib;
                        if (ra !== rb) return ra - rb;
                        return String(a[0]).localeCompare(String(b[0]));
                    })
                    .map(([parent_code, items]) => ({
                        parent_code,
                        screen_label: (items[0] && items[0].screen_label) || parent_code,
                        items,
                    }));
            } catch (_) { /* tables may not exist on legacy DBs */ }
        }

        // ── Role↔Portal assignment matrix (tbl_acl_role_portal).
        //    Drives `aclLayout.staffHomeUrl(role)`, so flipping rows here
        //    re-targets login redirects, permission-denied redirects and the
        //    sidebar "My Home" link without any code change.
        let rolePortalRows = [];
        if (selRole && !['1', '99'].includes(String(selRole))) {
            try {
                const assigned = await sq(
                    'SELECT portal_code, is_home FROM tbl_acl_role_portal WHERE role=?',
                    [selRole]
                );
                const aMap = new Map(assigned.map(r => [r.portal_code, !!r.is_home]));
                rolePortalRows = portals.map(p => ({
                    code: p.code,
                    label: p.label,
                    assigned: aMap.has(p.code),
                    is_home: aMap.get(p.code) === true,
                }));
            } catch (_) { /* tbl_acl_role_portal may not exist on legacy DBs */ }
        }

        // ── Audit Log (latest N entries, with optional filters via query string).
        //   Schema lives in lib/ensureAclSchema (section 3b). The table is
        //   keyed on created_at + (role) + (action) for cheap filtering.
        let auditRows = [], auditActionOptions = [];
        let auditFilter = {
            role: String(query.audit_role || '').trim(),
            action: String(query.audit_action || '').trim(),
            actor: String(query.audit_actor || '').trim(),
            limit: Math.max(1, Math.min(2000, parseInt(query.audit_limit, 10) || 100)),
        };
        try {
            const where = [];
            const params = [];
            if (auditFilter.role)   { where.push('role = ?');   params.push(auditFilter.role); }
            if (auditFilter.action) { where.push('action = ?'); params.push(auditFilter.action); }
            if (auditFilter.actor)  { where.push('(actor_name LIKE ? OR CAST(actor_id AS CHAR) = ?)');
                                      params.push('%' + auditFilter.actor + '%', auditFilter.actor); }
            const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
            auditRows = await sq(
                `SELECT id, created_at, actor_id, actor_name, action, role, target, detail
                   FROM tbl_acl_audit ${whereSql}
                  ORDER BY id DESC
                  LIMIT ${auditFilter.limit}`,
                params
            ).catch(() => []);
            const actBuckets = await sq(
                'SELECT action, COUNT(*) AS n FROM tbl_acl_audit GROUP BY action ORDER BY action'
            ).catch(() => []);
            auditActionOptions = actBuckets;
        } catch (_) { /* table may not exist on first deploy before migration */ }

        // ── One-glance footprint for the selected role (non-core only).
        let aclRoleSummary = null;
        if (selRole && !['1', '99'].includes(String(selRole))) {
            let uiHiddenTiles = 0;
            let uiTotalTiles = 0;
            for (const t of uiGlobalSidebar) {
                uiTotalTiles++;
                if (t.isHidden) uiHiddenTiles++;
            }
            for (const m of uiTopNavMenus) {
                uiTotalTiles++;
                if (m.parent.isHidden) uiHiddenTiles++;
                for (const ch of (m.children || [])) {
                    uiTotalTiles++;
                    if (ch.isHidden) uiHiddenTiles++;
                }
            }
            for (const g of uiPortalTilesGrouped) {
                for (const t of (g.tiles || [])) {
                    uiTotalTiles++;
                    if (t.isHidden) uiHiddenTiles++;
                }
            }
            let actionMenuTotal = 0;
            let actionMenuHidden = 0;
            for (const g of uiActionMenusGrouped || []) {
                for (const it of (g.items || [])) {
                    actionMenuTotal++;
                    if (it.isHidden) actionMenuHidden++;
                }
            }
            const portalsAllowed = rolePortalRows.filter(r => r.assigned).length;
            const homeRow = rolePortalRows.find(r => r.is_home);
            let uiHideRowCount = 0;
            try {
                const [hc] = await pool.query(
                    'SELECT COUNT(*) AS n FROM tbl_acl_role_ui_hidden WHERE role=?',
                    [selRole]
                );
                uiHideRowCount = hc[0]?.n || 0;
            } catch (_) {}
            aclRoleSummary = {
                permissionsGranted: assignedPerms.length,
                permissionsTotal: allPerms.length,
                portalsAllowed,
                portalsTotal: rolePortalRows.length,
                homePortalCode: homeRow ? homeRow.code : null,
                homePortalLabel: homeRow ? homeRow.label : null,
                uiHiddenTiles,
                uiTotalTiles,
                uiHideRowCount,
                actionMenuTotal,
                actionMenuHidden,
            };
        }

        let navStudioSidebar = null;
        let navStudioTopnav = null;
        let navStudioAccounting = null;
        let navStudioDashboard = null;
        let navStudioHmsHub = null;
        if (selRole && !['1', '99'].includes(String(selRole))) {
            try {
                const aclLayout = require('../lib/aclLayout');
                navStudioSidebar = aclLayout.studioPackForRole('sidebar', selRole);
                navStudioTopnav = aclLayout.studioPackForRole('topnav', selRole);
                navStudioAccounting = aclLayout.studioPackForRole('accounting', selRole);
                navStudioDashboard = aclLayout.studioPackForRole('dashboard', selRole);
                navStudioHmsHub = aclLayout.studioPackForRole('hms_hub', selRole);
            } catch (_) { /* optional */ }
        }


        let navAccessTree = [];
        let navGrantMode = false;
        let navGrantCount = 0;
        let permModuleRw = [];
        if (selRole && !['1', '99'].includes(String(selRole))) {
            try {
                const grantRows = await sq(
                    'SELECT nav_code FROM tbl_acl_role_nav_grant WHERE role=? AND granted=1',
                    [selRole]
                );
                const navGrantSet = new Set(grantRows.map((g) => String(g.nav_code)));
                navGrantCount = navGrantSet.size;
                navGrantMode = navGrantCount > 0;
                navAccessTree = JSON.parse(JSON.stringify(navAccessCatalog.tree()));
                function markNav(nodes) {
                    for (const n of nodes) {
                        n.granted = navGrantSet.has(n.code);
                        if (n.children) markNav(n.children);
                    }
                }
                markNav(navAccessTree);
            } catch (_) {
                navAccessTree = navAccessCatalog.tree();
            }

            const assignedIds = new Set((assignedPerms || []).map((p) => p.id));
            permModuleRw = (allPermsGrouped || []).map((g) => {
                const items = g.items || [];
                const readItems = items.filter((p) => String(p.action) === 'read');
                const writeItems = items.filter((p) => String(p.action) === 'write');
                const otherItems = items.filter(
                    (p) => String(p.action) !== 'read' && String(p.action) !== 'write'
                );
                return {
                    meta: g.meta,
                    readAll: readItems.length > 0 && readItems.every((p) => assignedIds.has(p.id)),
                    writeAll: writeItems.length > 0 && writeItems.every((p) => assignedIds.has(p.id)),
                    readSome: readItems.some((p) => assignedIds.has(p.id)),
                    writeSome: writeItems.some((p) => assignedIds.has(p.id)),
                    readCount: readItems.filter((p) => assignedIds.has(p.id)).length,
                    writeCount: writeItems.filter((p) => assignedIds.has(p.id)).length,
                    readTotal: readItems.length,
                    writeTotal: writeItems.length,
                    readItems,
                    writeItems,
                    otherItems,
                };
            });
        }

    const portalCatalog = portals || [];

    return {
        roles, portals, portalCatalog, plMap,
        allPerms, allRoles,
        modules: modules || [],
        allPermsGrouped,
        assignedPermsGrouped, availablePermsGrouped,
        opdSteps, ipdSteps, emgSteps,
        selRole, selRoleTitle, assignedPerms, availablePerms,
        uiPortalTilesGrouped,
        uiGlobalSidebar,
        uiTopNavMenus,
        uiActionMenusGrouped,
        rolePortalRows,
        aclRoleSummary,
        navStudioSidebar,
        navStudioTopnav,
        navStudioAccounting,
        navStudioDashboard,
        navStudioHmsHub,
        auditRows, auditActionOptions, auditFilter,
        navAccessTree,
        navGrantMode,
        navGrantCount,
        permModuleRw,
    };
}

module.exports = { loadAccessControlContext };
