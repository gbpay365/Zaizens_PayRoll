/**
 * Phase E — Tax & compliance hub (CNPS DIPE, payroll tax lines, DGI-style CSV export).
 * Requires accounting.read / accounting.write.
 */
const path = require('path');
const fs = require('fs');
const ensureHrPayrollSchema = require('../lib/ensureHrPayrollSchema');
const { saveDipeFile } = require('../lib/hmsDipeExport');
const {
 generateMonthlyTaxDeclarationCsv,
 generateAnnualTaxSummaryCsv
} = require('../lib/hmsDgiExport');

module.exports = function registerTaxHub(app, pool, requireAuth, { requirePerm }) {
 const acct = requirePerm('accounting.read', 'accounting.write');
 const acctWrite = requirePerm('accounting.write');

 function facilityId(req) {
  return Math.max(1, parseInt(req.session.facilityId, 10) || 1);
 }

 function sessionUid(req) {
  return parseInt(req.session.user?.id, 10) || 0;
 }

 function csvEscape(val) {
  const x = String(val ?? '');
  if (/[",\r\n]/.test(x)) return `"${x.replace(/"/g, '""')}"`;
  return x;
 }

 const months = {
  1: 'January',
  2: 'February',
  3: 'March',
  4: 'April',
  5: 'May',
  6: 'June',
  7: 'July',
  8: 'August',
  9: 'September',
  10: 'October',
  11: 'November',
  12: 'December'
 };

 app.get('/tax', requireAuth, acct, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const cy = new Date().getFullYear();
   let lastDipe = null;
   const [[ld]] = await pool
    .query(
     'SELECT id, month, year, filename, created_at FROM tbl_hms_dipe_history WHERE facility_id = ? ORDER BY created_at DESC LIMIT 1',
     [fid]
    )
    .catch(() => [[null]]);
   lastDipe = ld || null;

   res.render('tax-hub', {
    title: 'Tax & compliance hub - ZAIZENS',
    months,
    cy,
    lastDipe,
    flash: req.query.msg || null,
    error: req.query.err || null
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 app.get('/tax/cnps', requireAuth, acct, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const cy = new Date().getFullYear();
   const cm = new Date().getMonth() + 1;
   const [hist] = await pool
    .query(
     'SELECT * FROM tbl_hms_dipe_history WHERE facility_id = ? ORDER BY created_at DESC LIMIT 50',
     [fid]
    )
    .catch(() => [[]]);

   res.render('tax-cnps', {
    title: 'CNPS / DIPE export - ZAIZENS',
    months,
    cy,
    cm,
    history: hist || [],
    flash: req.query.msg || null,
    error: req.query.err || null
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 app.post('/tax/cnps/generate', requireAuth, acctWrite, async (req, res) => {
  const fid = facilityId(req);
  const uid = sessionUid(req);
  const month = Math.max(1, Math.min(12, parseInt(req.body.month, 10) || 1));
  const year = Math.max(2000, Math.min(2100, parseInt(req.body.year, 10) || new Date().getFullYear()));
  try {
   await ensureHrPayrollSchema(pool);
   const out = await saveDipeFile(pool, fid, month, year, uid);
   if (!out) {
    return res.redirect('/tax/cnps?err=' + encodeURIComponent('No payroll data for that month (gross must be > 0).'));
   }
   res.redirect('/tax/cnps?msg=' + encodeURIComponent(`DIPE file generated: ${out.filename}`));
  } catch (e) {
   res.redirect('/tax/cnps?err=' + encodeURIComponent(e.message));
  }
 });

 app.get('/tax/dipe/:id/download', requireAuth, acct, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const fid = facilityId(req);
  if (id < 1) return res.status(400).send('Invalid id');
  try {
   await ensureHrPayrollSchema(pool);
   const { ensureDipeFileForDownload } = require('../lib/hmsDipeExport');
   const [[h]] = await pool.query(
    'SELECT * FROM tbl_hms_dipe_history WHERE id = ? AND facility_id = ? LIMIT 1',
    [id, fid]
   );
   if (!h) return res.status(404).send('Not found');
   const file = await ensureDipeFileForDownload(pool, h);
   res.download(file.fullPath, file.filename || 'dipe.txt');
  } catch (e) {
   if (e.code === 'DIPE_NO_DATA') {
    return res.status(404).send(e.message);
   }
   res.status(500).send(e.message);
  }
 });

 app.get('/tax/payroll-lines', requireAuth, acct, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const [rows] = await pool
    .query(
     `SELECT p.*, e.first_name, e.last_name
      FROM tbl_hms_payroll_record p
      JOIN tbl_employee e ON e.id = p.employee_id
      WHERE p.facility_id = ?
        AND LOWER(COALESCE(p.payout_status, 'pending')) <> 'reversed'
      ORDER BY p.year DESC, p.month DESC, e.last_name, e.first_name
      LIMIT 500`,
     [fid]
    )
    .catch(() => [[]]);

   res.render('tax-payroll-lines', {
    title: 'Payroll tax lines - ZAIZENS',
    months,
    rows: rows || []
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 app.get('/tax/compliance', requireAuth, acct, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const fid = facilityId(req);
   const [rows] = await pool
    .query(
     `SELECT year, month,
        COUNT(*) AS headcount,
        SUM(CASE WHEN LOWER(TRIM(payout_status)) = 'paid' THEN 1 ELSE 0 END) AS paid_count
      FROM tbl_hms_payroll_record
      WHERE facility_id = ?
        AND LOWER(COALESCE(payout_status, 'pending')) <> 'reversed'
      GROUP BY year, month
      ORDER BY year DESC, month DESC
      LIMIT 48`,
     [fid]
    )
    .catch(() => [[]]);

   res.render('tax-compliance', {
    title: 'Payroll compliance calendar - ZAIZENS',
    months,
    rows: rows || []
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 /** Phase D — DGI-style declaration CSV (PHP HmsDgiGenerator parity; semicolon-separated). */
 app.get('/tax/dgi', requireAuth, acct, async (req, res) => {
  try {
   await ensureHrPayrollSchema(pool);
   const cy = new Date().getFullYear();
   const cm = new Date().getMonth() + 1;
   res.render('tax-dgi', {
    title: 'DGI payroll exports - ZAIZENS',
    months,
    cy,
    cm,
    flash: req.query.msg || null,
    error: req.query.err || null
   });
  } catch (e) {
   res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
  }
 });

 app.get('/tax/dgi/declaration.csv', requireAuth, acct, async (req, res) => {
  const fid = facilityId(req);
  const month = Math.max(1, Math.min(12, parseInt(req.query.month, 10) || new Date().getMonth() + 1));
  const year = Math.max(2000, Math.min(2100, parseInt(req.query.year, 10) || new Date().getFullYear()));
  try {
   await ensureHrPayrollSchema(pool);
   const { body, filename } = await generateMonthlyTaxDeclarationCsv(pool, fid, month, year);
   res.setHeader('Content-Type', 'text/csv; charset=utf-8');
   res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
   res.send(body);
  } catch (e) {
   res.status(500).send(e.message);
  }
 });

 app.get('/tax/dgi/annual.csv', requireAuth, acct, async (req, res) => {
  const fid = facilityId(req);
  const year = Math.max(2000, Math.min(2100, parseInt(req.query.year, 10) || new Date().getFullYear()));
  try {
   await ensureHrPayrollSchema(pool);
   const { body, filename } = await generateAnnualTaxSummaryCsv(pool, fid, year);
   res.setHeader('Content-Type', 'text/csv; charset=utf-8');
   res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
   res.send(body);
  } catch (e) {
   res.status(500).send(e.message);
  }
 });

 app.get('/tax/dgi-export', requireAuth, acct, async (req, res) => {
  const fid = facilityId(req);
  const month = Math.max(1, Math.min(12, parseInt(req.query.month, 10) || new Date().getMonth() + 1));
  const year = Math.max(2000, Math.min(2100, parseInt(req.query.year, 10) || new Date().getFullYear()));
  try {
   await ensureHrPayrollSchema(pool);
   const [rows] = await pool
    .query(
     `SELECT e.first_name, e.last_name, e.employee_id,
        p.gross_salary, p.income_tax, p.cnps_employee, p.council_tax_deduction, p.net_salary, p.payout_status
      FROM tbl_hms_payroll_record p
      JOIN tbl_employee e ON e.id = p.employee_id
      WHERE p.facility_id = ? AND p.month = ? AND p.year = ?
        AND LOWER(COALESCE(p.payout_status, 'pending')) <> 'reversed'
      ORDER BY e.last_name, e.first_name`,
     [fid, month, year]
    )
    .catch(() => [[]]);

   const header = [
    'employee_matricule',
    'last_name',
    'first_name',
    'gross_salary',
    'cnps_employee',
    'income_tax_irpp',
    'council_tax',
    'net_salary',
    'payout_status'
   ];
   const lines = [header.join(',')];
   for (const r of rows || []) {
    lines.push(
     [
      csvEscape(r.employee_id),
      csvEscape(r.last_name),
      csvEscape(r.first_name),
      csvEscape(Number(r.gross_salary || 0).toFixed(2)),
      csvEscape(Number(r.cnps_employee || 0).toFixed(2)),
      csvEscape(Number(r.income_tax || 0).toFixed(2)),
      csvEscape(Number(r.council_tax_deduction || 0).toFixed(2)),
      csvEscape(Number(r.net_salary || 0).toFixed(2)),
      csvEscape(r.payout_status)
     ].join(',')
    );
   }
   const fn = `payroll_tax_${fid}_${year}${String(month).padStart(2, '0')}.csv`;
   res.setHeader('Content-Type', 'text/csv; charset=utf-8');
   res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
   res.send('\uFEFF' + lines.join('\r\n'));
  } catch (e) {
   res.status(500).send(e.message);
  }
 });
};
