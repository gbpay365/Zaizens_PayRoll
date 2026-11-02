'use strict';

const envCfg = require('./integrationConfig');

const CACHE_MS = 8000;
const cache = new Map();

function pick(row, key, fallback) {
  if (!row) return fallback;
  const v = row[key];
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string' && !v.trim()) return fallback;
  return v;
}

function envDefaults() {
  return {
    public_base_url: envCfg.publicBaseUrl(),
    core_account_url: envCfg.coreAccountUrl(),
    core_account_api_key: envCfg.coreAccountApiKey(),
    enabled: 1,
    core_account_sync_enabled: envCfg.isIntegrationEnabled() ? 1 : 0,
    hms_sync_enabled: 1,
    hms_url: envCfg.hmsUrl(),
    hms_api_key_inbound: envCfg.hmsInboundApiKey(),
    zaizens_url: '',
    zaizens_api_key_inbound: '',
  };
}

function mergeRow(facilityId, row) {
  const d = envDefaults();
  return {
    facility_id: facilityId,
    public_base_url: pick(row, 'public_base_url', d.public_base_url),
    core_account_url: pick(row, 'core_account_url', d.core_account_url),
    core_account_api_key: pick(row, 'core_account_api_key', d.core_account_api_key),
    enabled: row && row.enabled != null ? (parseInt(String(row.enabled), 10) ? 1 : 0) : d.enabled,
    core_account_sync_enabled:
      row && row.core_account_sync_enabled != null
        ? parseInt(String(row.core_account_sync_enabled), 10) || 0
        : d.core_account_sync_enabled,
    hms_sync_enabled:
      row && row.hms_sync_enabled != null
        ? parseInt(String(row.hms_sync_enabled), 10) || 0
        : d.hms_sync_enabled,
    hms_url: pick(row, 'hms_url', d.hms_url),
    hms_api_key_inbound: pick(row, 'hms_api_key_inbound', d.hms_api_key_inbound),
    zaizens_url: pick(row, 'zaizens_url', d.zaizens_url),
    zaizens_api_key_inbound: pick(row, 'zaizens_api_key_inbound', d.zaizens_api_key_inbound),
  };
}

function bustCache(facilityId) {
  if (facilityId != null) cache.delete(Math.max(1, parseInt(String(facilityId), 10) || 1));
  else cache.clear();
}

async function listFacilities(pool) {
  const [rows] = await pool
    .query('SELECT id, code, name, status, public_base_url FROM tbl_facility ORDER BY id ASC')
    .catch(() => [[]]);
  return rows || [];
}

async function getSettings(pool, facilityId) {
  const fid = Math.max(1, parseInt(String(facilityId), 10) || 1);
  const hit = cache.get(fid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const [[row]] = await pool
    .query('SELECT * FROM tbl_facility_integration WHERE facility_id = ? LIMIT 1', [fid])
    .catch(() => [[null]]);

  const data = mergeRow(fid, row);
  cache.set(fid, { at: Date.now(), data });
  return data;
}

async function saveSettings(pool, facilityId, input) {
  const fid = Math.max(1, parseInt(String(facilityId), 10) || 1);
  const body = input || {};
  await pool.query(
    `INSERT INTO tbl_facility_integration (
      facility_id, public_base_url, core_account_url, core_account_api_key,
      enabled, core_account_sync_enabled, hms_url, hms_api_key_inbound,
      hms_sync_enabled, zaizens_url, zaizens_api_key_inbound
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      public_base_url = VALUES(public_base_url),
      core_account_url = VALUES(core_account_url),
      core_account_api_key = VALUES(core_account_api_key),
      enabled = VALUES(enabled),
      core_account_sync_enabled = VALUES(core_account_sync_enabled),
      hms_url = VALUES(hms_url),
      hms_api_key_inbound = VALUES(hms_api_key_inbound),
      hms_sync_enabled = VALUES(hms_sync_enabled),
      zaizens_url = VALUES(zaizens_url),
      zaizens_api_key_inbound = VALUES(zaizens_api_key_inbound)`,
    [
      fid,
      String(body.public_base_url || '').trim().slice(0, 512),
      String(body.core_account_url || '').trim().replace(/\/+$/, '').slice(0, 512),
      String(body.core_account_api_key || '').trim().slice(0, 256),
      body.enabled ? 1 : 0,
      body.core_account_sync_enabled ? 1 : 0,
      String(body.hms_url || '').trim().replace(/\/+$/, '').slice(0, 512),
      String(body.hms_api_key_inbound || '').trim().slice(0, 256),
      body.hms_sync_enabled ? 1 : 0,
      String(body.zaizens_url || '').trim().replace(/\/+$/, '').slice(0, 512),
      String(body.zaizens_api_key_inbound || '').trim().slice(0, 256),
    ]
  );
  bustCache(fid);
  return getSettings(pool, fid);
}

async function resolveUserFacilityId(pool, userId, sessionFacilityId) {
  const fromSession = parseInt(String(sessionFacilityId || ''), 10);
  if (fromSession > 0) return fromSession;
  if (!userId) return 1;
  const [[row]] = await pool
    .query('SELECT default_facility_id FROM tbl_employee WHERE id = ? LIMIT 1', [userId])
    .catch(() => [[null]]);
  const fid = parseInt(String(row?.default_facility_id || ''), 10);
  return fid > 0 ? fid : 1;
}

module.exports = {
  getSettings,
  saveSettings,
  listFacilities,
  bustCache,
  resolveUserFacilityId,
  envDefaults,
};
