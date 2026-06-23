'use strict';

/** Clear a payroll month in Account_Core when Zaizens has no lines left. */
require('dotenv').config();
const cfg = require('../lib/integrationConfig');

async function postJson(url, body, headers) {
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

async function main() {
  const year = parseInt(process.argv[2], 10) || new Date().getFullYear();
  const month = parseInt(process.argv[3], 10) || 1;
  const fid = parseInt(process.argv[4], 10) || cfg.facilityId();
  const url = cfg.coreAccountUrl();
  const headers = {
    'X-API-Key': cfg.coreAccountApiKey(),
    'X-Facility-Id': String(fid),
  };

  console.log(`Clearing ${year}-${String(month).padStart(2, '0')} in Account_Core...`);
  const period = await postJson(
    `${url}/api/v1/integrations/payroll-periods`,
    { facility_id: fid, year, month, status: 'processed', lines: [] },
    headers
  );
  const dept = await postJson(
    `${url}/api/v1/integrations/payroll-department-summaries`,
    { facility_id: fid, year, month, departments: [] },
    headers
  );
  console.log(JSON.stringify({ period, dept }, null, 2));
  if (!period.ok || !dept.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
