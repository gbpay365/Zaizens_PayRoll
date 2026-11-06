'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerStaffDirectoryRoutes = require('../routes/staffDirectory');
const { makeApp, withApp, request } = require('./helpers/app');

function employeePool({ paid, employees = null, paidByEmployee = null }) {
  const state = {
    begin: 0,
    commit: 0,
    rollback: 0,
    release: 0,
    employeeDeleted: false,
    deletedIds: [],
    childDeletes: [],
    audits: [],
  };
  const employeeRows = employees || [{
    id: 42,
    first_name: 'Test',
    last_name: 'Employee',
    username: 'test_employee',
    role: '101',
  }];

  const conn = {
    query: async (sql, params) => {
      const text = String(sql);
      if (text.includes('FROM tbl_hms_payroll_record') && text.includes('FOR UPDATE')) {
        const employeeId = Number(params && params[0]);
        const hasPaid = paidByEmployee
          ? Boolean(paidByEmployee[employeeId])
          : Boolean(paid);
        return [hasPaid ? [{ id: 700 + employeeId, payout_status: 'paid' }] : []];
      }
      if (text.startsWith('DELETE FROM tbl_employee')) {
        state.employeeDeleted = true;
        state.deletedIds.push(Number(params && params[0]));
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith('DELETE FROM ')) {
        state.childDeletes.push(text);
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
    beginTransaction: async () => { state.begin += 1; },
    commit: async () => { state.commit += 1; },
    rollback: async () => { state.rollback += 1; },
    release: () => { state.release += 1; },
  };

  const pool = {
    query: async (sql, params) => {
      const text = String(sql);
      if (text.includes('SELECT id, first_name, last_name, username, role') && text.includes('FROM tbl_employee')) {
        return [employeeRows];
      }
      if (text.includes('INSERT INTO tbl_admin_audit')) {
        state.audits.push({
          action: params[2],
          targetType: params[3],
          targetId: params[4],
          detail: params[5],
          facilityId: params[7],
        });
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
    getConnection: async () => conn,
  };

  return { pool, state };
}

test('employee deletion is blocked when paid payroll records exist', async () => {
  const { pool, state } = employeePool({ paid: true });

  await withApp(makeApp(registerStaffDirectoryRoutes, pool), async (base) => {
    const res = await request(base, '/staff/42/delete', { method: 'POST' });

    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get('location')), /paid payroll records/i);
    assert.equal(state.begin, 1);
    assert.equal(state.rollback, 1);
    assert.equal(state.commit, 0);
    assert.equal(state.employeeDeleted, false);
    assert.equal(state.childDeletes.length, 0);
    assert.equal(state.release, 1);
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].action, 'employee.delete_blocked');
    assert.equal(state.audits[0].targetType, 'employee');
    assert.equal(state.audits[0].targetId, '42');
    assert.match(state.audits[0].detail, /1 paid payroll record/i);
  });
});

test('employee deletion still removes pending payroll records', async () => {
  const { pool, state } = employeePool({ paid: false });

  await withApp(makeApp(registerStaffDirectoryRoutes, pool), async (base) => {
    const res = await request(base, '/staff/42/delete', { method: 'POST' });

    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get('location')), /Employee and their login account deleted/);
    assert.equal(state.begin, 1);
    assert.equal(state.commit, 1);
    assert.equal(state.rollback, 0);
    assert.equal(state.employeeDeleted, true);
    assert.ok(state.childDeletes.some((sql) => sql.includes('tbl_hms_payroll_record')));
    assert.equal(state.release, 1);
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].action, 'employee.delete');
  });
});

test('bulk employee deletion audits paid-payroll blocks', async () => {
  const { pool, state } = employeePool({ paid: true });

  await withApp(makeApp(registerStaffDirectoryRoutes, pool), async (base) => {
    const res = await request(base, '/staff/bulk-delete', {
      method: 'POST',
      body: new URLSearchParams({ ids: '42' }),
    });

    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get('location')), /paid payroll records/i);
    assert.equal(state.commit, 0);
    assert.equal(state.rollback, 1);
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].action, 'employee.delete_blocked');
    assert.equal(state.audits[0].targetId, '42');
  });
});

test('mixed bulk deletion deletes the clean employee and audits both outcomes', async () => {
  const { pool, state } = employeePool({
    employees: [
      {
        id: 42,
        first_name: 'Paid',
        last_name: 'Employee',
        username: 'paid.employee',
        role: '101',
      },
      {
        id: 43,
        first_name: 'Clean',
        last_name: 'Employee',
        username: 'clean.employee',
        role: '101',
      },
    ],
    paidByEmployee: { 42: true, 43: false },
  });

  await withApp(makeApp(registerStaffDirectoryRoutes, pool), async (base) => {
    const res = await request(base, '/staff/bulk-delete', {
      method: 'POST',
      body: new URLSearchParams([
        ['ids', '42'],
        ['ids', '43'],
      ]),
    });

    assert.equal(res.status, 302);
    const location = decodeURIComponent(res.headers.get('location'));
    assert.match(location, /1 employee\(s\) and their accounts deleted/i);
    assert.match(location, /1 skipped/i);
    assert.match(location, /paid payroll records/i);

    assert.equal(state.begin, 2);
    assert.equal(state.commit, 1);
    assert.equal(state.rollback, 1);
    assert.equal(state.release, 2);
    assert.deepEqual(state.deletedIds, [43]);
    assert.equal(state.audits.length, 2);

    const deletedAudit = state.audits.find((audit) => audit.action === 'employee.delete');
    assert.ok(deletedAudit, 'the successful deletion must be audited');
    assert.equal(deletedAudit.targetType, 'employee');
    assert.equal(deletedAudit.targetId, '43');
    assert.equal(deletedAudit.facilityId, 1);
    assert.match(deletedAudit.detail, /Deleted employee Clean Employee/i);

    const blockedAudit = state.audits.find((audit) => audit.action === 'employee.delete_blocked');
    assert.ok(blockedAudit, 'the paid-payroll block must be audited');
    assert.equal(blockedAudit.targetType, 'employee');
    assert.equal(blockedAudit.targetId, '42');
    assert.equal(blockedAudit.facilityId, 1);
    assert.match(blockedAudit.detail, /1 paid payroll record/i);
  });
});
