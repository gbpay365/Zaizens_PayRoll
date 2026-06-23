'use strict';

/**
 * Push payroll lines + department summaries to Account_Core.
 * Usage:
 *   node scripts/resync-payroll-to-core.js [year] [month] [facilityId]
 *   node scripts/resync-payroll-to-core.js --all [facilityId]
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const { syncPayrollPeriodToCoreAccount } = require('../lib/coreAccountPayrollSync');
const cfg = require('../lib/integrationConfig');

async function syncOne(pool, facilityId, year, month) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS c FROM tbl_hms_payroll_record WHERE facility_id = ? AND year = ? AND month = ?',
    [facilityId, year, month]
  );
  if (!(parseInt(row?.c, 10) > 0)) {
    console.warn(`Skip ${year}-${String(month).padStart(2, '0')}: no payroll records`);
    return { ok: false, skipped: true };
  }
  console.log(`Syncing facility ${facilityId}, ${year}-${String(month).padStart(2, '0')} → ${cfg.coreAccountUrl()}`);
  const result = await syncPayrollPeriodToCoreAccount(pool, facilityId, year, month);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const allFlag = process.argv[2] === '--all';
  const facilityId = allFlag
    ? parseInt(process.argv[3], 10) || cfg.facilityId()
    : parseInt(process.argv[4], 10) || cfg.facilityId();

  if (!cfg.isIntegrationEnabled()) {
    console.error('CORE_ACCOUNT_SYNC_ENABLED is not set to 1 in .env');
    process.exit(1);
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'zaizens_payroll',
  });

  try {
    if (allFlag) {
      const [periods] = await pool.query(
        'SELECT DISTINCT year, month FROM tbl_hms_payroll_record WHERE facility_id = ? ORDER BY year, month',
        [facilityId]
      );
      if (!periods.length) {
        console.error('No payroll periods found.');
        process.exit(1);
      }
      let failed = 0;
      for (const p of periods) {
        const result = await syncOne(pool, facilityId, p.year, p.month);
        if (result.skipped || !result.ok) failed++;
      }
      if (failed) process.exit(1);
      return;
    }

    const year = parseInt(process.argv[2], 10) || new Date().getFullYear();
    const month = parseInt(process.argv[3], 10) || new Date().getMonth() + 1;
    const result = await syncOne(pool, facilityId, year, month);
    if (result.skipped || !result.ok) process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
