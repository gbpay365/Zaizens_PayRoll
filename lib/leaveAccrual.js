'use strict';

/**
 * Leave carry-over and entitlement accrual.
 *
 * These rules previously lived inline in the balance routes, which made them
 * unreachable from a scheduler.  They are extracted here so the manual admin
 * buttons and the scheduled maintenance run share one implementation.
 *
 * Both helpers are idempotent:
 *  - carry-over only writes when the year's carry-over ledger row is absent;
 *  - accrual moves the balance to the computed target instead of adding a delta.
 */

const L = require('./leaveSystem');

function n(value) {
  const v = Number(value);
  return Number.isFinite(v) ? v : 0;
}

function round2(value) {
  return Math.round(n(value) * 100) / 100;
}

function employeeLabel(row) {
  return `${(row && row.first_name) || ''} ${(row && row.last_name) || ''}`.trim() || `Employee #${(row && row.employee_id) || (row && row.id) || '—'}`;
}

async function activeStaff(pool, facilityId) {
  const [rows] = await pool.query(
    `SELECT id, first_name, last_name, employee_id, joining_date
       FROM tbl_employee
      WHERE status = 1 AND (default_facility_id IS NULL OR default_facility_id = ?)
      ORDER BY last_name, first_name`,
    [facilityId]
  ).catch(() => [[]]);
  return rows || [];
}

/**
 * Move a capped share of last year's unused balance into the new year.
 */
async function runCarryOver(pool, facilityId, year, actorId) {
  const fid = Math.max(1, parseInt(String(facilityId), 10) || 1);
  const targetYear = Math.max(2000, Math.min(2100, parseInt(String(year), 10) || new Date().getFullYear()));
  const policies = await L.loadPolicies(pool, fid);
  const staff = await activeStaff(pool, fid);
  const rows = [];
  let applied = 0;

  for (const employee of staff) {
    const prior = await L.getBalancesForEmployee(pool, fid, employee.id, targetYear - 1);
    for (const row of prior.rows || []) {
      const policy = policies[row.leave_type] || {};
      const cap = n(policy.carryover_max);
      if (cap <= 0 || n(row.remaining) <= 0) continue;
      const [[already]] = await pool.query(
        `SELECT id FROM tbl_hms_leave_ledger
          WHERE facility_id = ? AND employee_id = ? AND leave_type = ? AND leave_year = ?
            AND entry_type = 'carryover' LIMIT 1`,
        [fid, employee.id, row.leave_type, targetYear]
      );
      if (already) continue;
      const carry = round2(Math.min(cap, n(row.remaining)));
      if (carry <= 0) continue;
      await L.ensureEmployeeBalances(pool, fid, employee.id, targetYear);
      await pool.query(
        `UPDATE tbl_hms_leave_balance SET carried_days = carried_days + ?
          WHERE facility_id = ? AND employee_id = ? AND leave_type = ? AND year = ?`,
        [carry, fid, employee.id, row.leave_type, targetYear]
      );
      await pool.query(
        `INSERT INTO tbl_hms_leave_ledger
          (facility_id, employee_id, leave_type, leave_year, entry_date, entry_type, days, note, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [fid, employee.id, row.leave_type, targetYear, L.todayIso(), 'carryover', carry, `Carry-over from ${targetYear - 1}`, actorId || null]
      );
      rows.push({ employee_id: employee.id, employee_name: employeeLabel(employee), leave_type: row.leave_type, days: carry });
      applied += 1;
    }
  }
  return { applied, rows, employees: new Set(rows.map((row) => row.employee_id)).size };
}

/**
 * Bring every tracked balance to the entitlement earned so far.
 *
 * `annual` policies set the full year's days immediately; `monthly` policies
 * release one twelfth per elapsed month so a mid-year run does not over-grant.
 */
async function runAccrual(pool, facilityId, year, actorId, options) {
  const fid = Math.max(1, parseInt(String(facilityId), 10) || 1);
  const targetYear = Math.max(2000, Math.min(2100, parseInt(String(year), 10) || new Date().getFullYear()));
  const asOf = (options && options.asOf instanceof Date && !Number.isNaN(options.asOf.getTime()))
    ? options.asOf
    : new Date();
  const types = await L.loadLeaveTypes(pool, fid, true);
  const policies = await L.loadPolicies(pool, fid);
  const staff = await activeStaff(pool, fid);
  const rows = [];
  let updated = 0;

  for (const employee of staff) {
    const setup = await L.ensureEmployeeBalances(pool, fid, employee.id, targetYear);
    const joinDate = setup.employee && setup.employee.joining_date ? L.parseDate(setup.employee.joining_date) : null;
    for (const type of types) {
      if (!Number(type.balance_tracked)) continue;
      const policy = policies[type.code] || {};
      let target = n(policy.annual_days);
      if (target <= 0) continue;
      if (String(policy.accrual_method) === 'monthly') {
        const elapsedMonths = targetYear < asOf.getFullYear() ? 12 : (targetYear > asOf.getFullYear() ? 0 : asOf.getMonth() + 1);
        target = round2(target * (elapsedMonths / 12));
      }
      if (Number(policy.prorate) && joinDate && joinDate.getFullYear() === targetYear) {
        target = round2(target * ((12 - joinDate.getMonth()) / 12));
      }
      const [[existing]] = await pool.query(
        'SELECT balance FROM tbl_hms_leave_balance WHERE facility_id = ? AND employee_id = ? AND leave_type = ? AND year = ? LIMIT 1 FOR UPDATE',
        [fid, employee.id, type.code, targetYear]
      );
      const before = n(existing && existing.balance);
      const delta = round2(target - before);
      if (Math.abs(delta) < 0.005) continue;
      await pool.query(
        'UPDATE tbl_hms_leave_balance SET balance = ? WHERE facility_id = ? AND employee_id = ? AND leave_type = ? AND year = ?',
        [target, fid, employee.id, type.code, targetYear]
      );
      await pool.query(
        `INSERT INTO tbl_hms_leave_ledger
          (facility_id, employee_id, leave_type, leave_year, entry_date, entry_type, days, note, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [fid, employee.id, type.code, targetYear, L.todayIso(), 'accrual', delta, `Entitlement accrual to ${target}`, actorId || null]
      );
      rows.push({ employee_id: employee.id, employee_name: employeeLabel(employee), leave_type: type.code, days: delta });
      updated += 1;
    }
  }
  return { updated, rows, employees: new Set(rows.map((row) => row.employee_id)).size };
}

module.exports = { runCarryOver, runAccrual };
