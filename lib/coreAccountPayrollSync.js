'use strict';

const cfg = require('./integrationConfig');
const { getSettings } = require('./facilityIntegrationSettings');

async function postJson(url, body, headers) {
  if (typeof fetch !== 'function') {
    return { ok: false, status: 0, data: { error: 'fetch unavailable' } };
  }
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

async function integrationHeaders(pool, facilityId) {
  const fid = parseInt(String(facilityId), 10) || cfg.facilityId();
  const s = await getSettings(pool, fid);
  return {
    'X-API-Key': s.core_account_api_key || cfg.coreAccountApiKey(),
    'X-Facility-Id': String(fid),
  };
}

function linePayloadFromRow(row) {
  return {
    payroll_record_id: parseInt(String(row.id), 10) || 0,
    hms_employee_id: parseInt(String(row.employee_id), 10) || 0,
    gross_salary: parseFloat(row.gross_salary) || 0,
    net_salary: parseFloat(row.net_salary) || 0,
    basic_salary: parseFloat(row.basic_salary_snap) || 0,
    housing_allowance: parseFloat(row.housing_allowance_snap) || 0,
    transport_allowance: parseFloat(row.transport_allowance_snap) || 0,
    other_allowances: parseFloat(row.other_allowances_snap) || 0,
    cnps_employee: parseFloat(row.cnps_employee) || 0,
    cimr_employee: parseFloat(row.cimr_employee) || 0,
    crtv_deduction: parseFloat(row.crtv_deduction) || 0,
    council_tax_deduction: parseFloat(row.council_tax_deduction) || 0,
    development_tax_deduction: parseFloat(row.development_tax_deduction) || 0,
    taxable_income: parseFloat(row.taxable_income) || 0,
    income_tax: parseFloat(row.income_tax) || 0,
    payout_status: row.payout_status || 'pending',
  };
}

/**
 * One-way replication: push a payroll month from Zaizens PayRoll to Account_Core.
 */
async function syncPayrollPeriodToCoreAccount(pool, facilityId, year, month) {
  const fid = parseInt(String(facilityId), 10) || cfg.facilityId();
  const settings = await getSettings(pool, fid);
  const masterOn = settings.enabled !== 0;
  const syncOn = masterOn && (settings.core_account_sync_enabled === 1 || cfg.isIntegrationEnabled());
  if (!syncOn) return { ok: false, skipped: true, reason: 'disabled' };
  const url = settings.core_account_url || cfg.coreAccountUrl();
  const key = settings.core_account_api_key || cfg.coreAccountApiKey();
  if (!url || !key) return { ok: false, skipped: true, reason: 'missing config' };

  const y = parseInt(String(year), 10) || 0;
  const m = parseInt(String(month), 10) || 0;
  if (y < 2000 || m < 1 || m > 12) return { ok: false, error: 'invalid year/month' };

  const { rebuildDeptSummaries } = require('./payrollDeptSummary');
  const deptRows = await rebuildDeptSummaries(pool, fid, y, m);

  const [rows] = await pool
    .query(
      `SELECT p.*
         FROM tbl_hms_payroll_record p
        WHERE p.facility_id = ? AND p.year = ? AND p.month = ?
        ORDER BY p.id ASC`,
      [fid, y, m]
    )
    .catch(() => [[]]);

  const lines = (rows || []).map(linePayloadFromRow).filter((l) => l.payroll_record_id > 0 && l.hms_employee_id > 0);

  let periodResult = { ok: true, skipped: true, reason: 'no records' };
  const periodBody = {
    facility_id: fid,
    year: y,
    month: m,
    status:
      lines.length > 0 && lines.every((l) => String(l.payout_status).toLowerCase() === 'paid')
        ? 'paid'
        : 'processed',
    lines,
  };
  const periodRes = await postJson(`${url}/api/v1/integrations/payroll-periods`, periodBody, await integrationHeaders(pool, fid));
  periodResult = {
    ok: periodRes.ok,
    status: periodRes.status,
    data: periodRes.data,
    count: lines.length,
    cleared: lines.length === 0,
  };

  const deptBody = {
    facility_id: fid,
    year: y,
    month: m,
    departments: deptRows.map((d) => ({
      department: d.department,
      headcount: d.headcount,
      gross_payroll: d.gross_payroll,
      net_payroll: d.net_payroll,
      employer_charges: d.employer_charges,
    })),
  };
  const deptRes = await postJson(
    `${url}/api/v1/integrations/payroll-department-summaries`,
    deptBody,
    await integrationHeaders(pool, fid)
  );
  const deptResult = {
    ok: deptRes.ok,
    status: deptRes.status,
    data: deptRes.data,
    count: deptRows.length,
    cleared: deptRows.length === 0,
  };

  return {
    ok: Boolean(periodResult.ok && deptResult.ok),
    period: periodResult,
    departments: deptResult,
    count: lines.length,
    departmentCount: deptRows.length,
  };
}

/**
 * Re-sync every affected month in Account_Core after payroll lines were deleted locally.
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} facilityId
 * @param {Iterable<{year:number, month:number}>} periods
 */
async function syncPayrollPeriodsAfterDelete(pool, facilityId, periods) {
  const fid = parseInt(String(facilityId), 10) || cfg.facilityId();
  const settings = await getSettings(pool, fid);
  const masterOn = settings.enabled !== 0;
  const syncOn = masterOn && (settings.core_account_sync_enabled === 1 || cfg.isIntegrationEnabled());
  if (!syncOn) return { ok: false, skipped: true, reason: 'disabled' };
  const results = [];
  for (const p of periods) {
    const y = parseInt(String(p.year), 10) || 0;
    const m = parseInt(String(p.month), 10) || 0;
    if (y < 2000 || m < 1 || m > 12) continue;
    try {
      const r = await syncPayrollPeriodToCoreAccount(pool, facilityId, y, m);
      results.push({ year: y, month: m, ...r });
    } catch (e) {
      results.push({ year: y, month: m, ok: false, error: e.message || String(e) });
    }
  }
  const ok = results.length > 0 && results.every((r) => r.ok || r.skipped);
  return { ok, results };
}

function formatCoreSyncNote(syncBundle) {
  if (!syncBundle || syncBundle.skipped) {
    if (syncBundle && syncBundle.reason === 'disabled') {
      return ' Account_Core sync disabled — set CORE_ACCOUNT_SYNC_ENABLED=1 in .env.';
    }
    return '';
  }
  if (!syncBundle.ok) return ' Account_Core sync failed.';
  const parts = (syncBundle.results || [])
    .filter((r) => r.ok)
    .map((r) => `${String(r.month).padStart(2, '0')}/${r.year}`);
  return parts.length ? ` Account_Core updated (${parts.join(', ')}).` : ' Account_Core updated.';
}

module.exports = {
  syncPayrollPeriodToCoreAccount,
  syncPayrollPeriodsAfterDelete,
  formatCoreSyncNote,
  linePayloadFromRow,
};
