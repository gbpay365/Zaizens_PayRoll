'use strict';

const { getSettings, saveSettings, listFacilities } = require('../lib/facilityIntegrationSettings');
const cfg = require('../lib/integrationConfig');

async function postJson(url, body, headers) {
  if (typeof fetch !== 'function') return { ok: false, status: 0, data: { error: 'fetch unavailable' } };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function getJson(url, headers) {
  if (typeof fetch !== 'function') return { ok: false, status: 0, data: { error: 'fetch unavailable' } };
  try {
    const res = await fetch(url, { headers });
    const text = await res.text().catch(() => '');
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    const msg = e && e.cause && e.cause.code === 'ECONNREFUSED'
      ? `Cannot connect to ${url} — is HMS running? (this install uses port 3003, not 3000)`
      : (e.message || String(e));
    return { ok: false, status: 0, data: { error: msg } };
  }
}

module.exports = function integrationSettingsRoutes(app, pool, requireAuth, { requireAdminOrSuper }) {
  const inbound = require('../lib/hmsEmployeeInbound');
  const integrationApiKeyMiddleware = inbound.createIntegrationApiKeyMiddleware(pool);

  app.get('/payroll/integrations', requireAuth, requireAdminOrSuper, async (req, res) => {
    try {
      await require('../lib/ensureFacilityIntegrationSchema')(pool);
      const facilities = await listFacilities(pool);
      const selectedId = Math.max(
        1,
        parseInt(String(req.query.facility_id || req.session.facilityId || '1'), 10) || 1
      );
      const settings = await getSettings(pool, selectedId);
      res.render('integration-settings', {
        title: 'Integration settings — Zaizens Payroll',
        facilities,
        selectedId,
        settings,
        payNavActive: 'integrations',
        flash: req.query.msg || null,
        error: req.query.err || null,
        inboundEndpoints: {
          health: `${settings.public_base_url || cfg.publicBaseUrl() || `http://127.0.0.1:${process.env.PORT || 3010}`}/api/v1/integrations/health`,
          employees: `${settings.public_base_url || cfg.publicBaseUrl() || `http://127.0.0.1:${process.env.PORT || 3010}`}/api/v1/integrations/employees`,
          employeesBulk: `${settings.public_base_url || cfg.publicBaseUrl() || `http://127.0.0.1:${process.env.PORT || 3010}`}/api/v1/integrations/employees/bulk`,
        },
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.post('/payroll/integrations', requireAuth, requireAdminOrSuper, async (req, res) => {
    const facilityId = Math.max(1, parseInt(String(req.body.facility_id || '1'), 10) || 1);
    try {
      await saveSettings(pool, facilityId, {
        public_base_url: req.body.public_base_url,
        core_account_url: req.body.core_account_url,
        core_account_api_key: req.body.core_account_api_key,
        enabled: req.body.enabled === '1',
        core_account_sync_enabled: req.body.core_account_sync_enabled === '1',
        hms_sync_enabled: req.body.hms_sync_enabled === '1',
        hms_url: req.body.hms_url,
        hms_api_key_inbound: req.body.hms_api_key_inbound,
        zaizens_url: req.body.zaizens_url,
        zaizens_api_key_inbound: req.body.zaizens_api_key_inbound,
      });
      res.redirect(`/payroll/integrations?facility_id=${facilityId}&msg=${encodeURIComponent('Integration settings saved.')}`);
    } catch (e) {
      res.redirect(`/payroll/integrations?facility_id=${facilityId}&err=${encodeURIComponent(e.message)}`);
    }
  });

  app.post('/payroll/integrations/test-core', requireAuth, requireAdminOrSuper, async (req, res) => {
    const facilityId = Math.max(1, parseInt(String(req.body.facility_id || '1'), 10) || 1);
    try {
      const s = await getSettings(pool, facilityId);
      const base = s.core_account_url || cfg.coreAccountUrl();
      const r = await getJson(`${base}/api/v1/integrations/health`, {
        'X-API-Key': s.core_account_api_key || cfg.coreAccountApiKey(),
        'X-Facility-Id': String(facilityId),
      });
      const msg = r.ok ? 'Account_Core connection OK.' : `Account_Core test failed (HTTP ${r.status}).`;
      res.redirect(`/payroll/integrations?facility_id=${facilityId}&msg=${encodeURIComponent(msg)}`);
    } catch (e) {
      res.redirect(`/payroll/integrations?facility_id=${facilityId}&err=${encodeURIComponent(e.message)}`);
    }
  });

  app.post('/payroll/integrations/test-hms', requireAuth, requireAdminOrSuper, async (req, res) => {
    const facilityId = Math.max(1, parseInt(String(req.body.facility_id || '1'), 10) || 1);
    try {
      const s = await getSettings(pool, facilityId);
      const base = s.hms_url || cfg.hmsUrl();
      const r = await getJson(`${base}/api/v1/integrations/health`, {
        'X-API-Key': s.hms_api_key_inbound || cfg.hmsInboundApiKey(),
        'X-Facility-Id': String(facilityId),
      });
      if (r.ok) {
        return res.redirect(`/payroll/integrations?facility_id=${facilityId}&msg=${encodeURIComponent('HMS connection OK.')}`);
      }
      const detail = r.data?.error || `HTTP ${r.status || 'unknown'}`;
      return res.redirect(`/payroll/integrations?facility_id=${facilityId}&err=${encodeURIComponent(`HMS test failed: ${detail}`)}`);
    } catch (e) {
      res.redirect(`/payroll/integrations?facility_id=${facilityId}&err=${encodeURIComponent(e.message)}`);
    }
  });

  // Enhanced health for operators
  app.get('/api/v1/integrations/health', async (req, res) => {
    const facilityId = inbound.parseFacilityId(req, req.query?.facility_id);
    const settings = await getSettings(pool, facilityId).catch(() => null);
    res.json({
      status: 'ok',
      service: 'Zaizens_PayRoll',
      facility_id: facilityId,
      syncEnabled: settings ? settings.core_account_sync_enabled === 1 : cfg.isIntegrationEnabled(),
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/api/v1/integrations/employees', integrationApiKeyMiddleware, async (req, res) => {
    try {
      const facilityId = req.integrationFacilityId || inbound.parseFacilityId(req, req.body?.facility_id);
      const result = await inbound.upsertEmployee(pool, facilityId, req.body || {});
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post('/api/v1/integrations/employees/bulk', integrationApiKeyMiddleware, async (req, res) => {
    try {
      const facilityId = req.integrationFacilityId || inbound.parseFacilityId(req, req.body?.facility_id);
      const result = await inbound.syncEmployeesBulk(pool, facilityId, req.body || {});
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post('/employees/add', integrationApiKeyMiddleware, (req, res) => {
    res.status(403).json({ error: 'Employees are created in HMS and replicated one-way via the integration API.' });
  });
};
