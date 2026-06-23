/**
 * Indicative DGI-style CSV summaries (PHP parity: HmsDgiGenerator.php).
 * Uses semicolon delimiter like PHP saveCSV.
 */
async function hasEmployeeColumn(pool, col) {
 try {
  const [[r]] = await pool.query(
   `SELECT 1 AS ok FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_employee' AND COLUMN_NAME = ? LIMIT 1`,
   [col]
  );
  return !!(r && r.ok);
 } catch (e) {
  return false;
 }
}

function escCell(v) {
 const s = v == null ? '' : String(v);
 if (/[;\r\n"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
 return s;
}

function lineToCsv(row) {
 return row.map(escCell).join(';');
}

/**
 * @returns {Promise<{ body: string, filename: string }>}
 */
async function generateMonthlyTaxDeclarationCsv(pool, facilityId, month, year) {
 const [[emp]] = await pool
  .query(
   'SELECT employer_niu FROM tbl_hms_payroll_settings WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1',
   [facilityId]
  )
  .catch(() => [[{ employer_niu: '' }]]);
 const niu = String(emp?.employer_niu || '').trim();

 const [[sum]] = await pool
  .query(
   `SELECT SUM(gross_salary) AS tg, SUM(cnps_employee) AS cnps, SUM(cimr_employee) AS cimr, SUM(crtv_deduction) AS crtv,
    SUM(council_tax_deduction) AS council, SUM(development_tax_deduction) AS dev, SUM(cnhc_deduction) AS cnhc,
    SUM(income_tax) AS irpp, SUM(net_salary) AS net, COUNT(*) AS emp_cnt
    FROM tbl_hms_payroll_record WHERE month = ? AND year = ? AND facility_id = ?`,
   [month, year, facilityId]
  )
  .catch(() => [[{}]]);

 const s = sum || {};
 const rows = [];
 rows.push(
  lineToCsv([
   'Type',
   'NIU Employeur',
   'Mois',
   'Année',
   'Date',
   'Nb Salariés',
   'Masse Brute',
   'CNPS',
   'CIMR',
   'CRTV',
   'Taxe Communale',
   'Taxe Développement',
   'CNHC',
   'IRPP',
   'Masse Nette'
  ])
 );
 rows.push(
  lineToCsv([
   'SOMMAIRE',
   niu,
   String(month),
   String(year),
   new Date().toISOString().slice(0, 10),
   String(s.emp_cnt ?? 0),
   s.tg,
   s.cnps,
   s.cimr,
   s.crtv,
   s.council,
   s.dev,
   s.cnhc,
   s.irpp,
   s.net
  ])
 );
 rows.push('');
 rows.push(lineToCsv(['DETAIL PAR SALARIÉ', '', '', '', '', 'Salaire Brut', 'IRPP', 'Salaire Net']));

 const [detail] = await pool
  .query(
   `SELECT e.first_name, e.last_name, e.employee_id, p.gross_salary, p.income_tax, p.net_salary
    FROM tbl_hms_payroll_record p JOIN tbl_employee e ON p.employee_id = e.id
    WHERE p.month = ? AND p.year = ? AND p.facility_id = ?
    ORDER BY e.last_name, e.first_name`,
   [month, year, facilityId]
  )
  .catch(() => [[]]);

 for (const d of detail || []) {
  rows.push(
   lineToCsv([
    String(d.employee_id ?? ''),
    '',
    String(d.last_name ?? ''),
    String(d.first_name ?? ''),
    '',
    d.gross_salary,
    d.income_tax,
    d.net_salary
   ])
  );
 }

 const filename = `DGI_DECL_${facilityId}_${String(year)}${String(month).padStart(2, '0')}.csv`;
 return { body: '\uFEFF' + rows.join('\r\n'), filename };
}

/**
 * @returns {Promise<{ body: string, filename: string }>}
 */
async function generateAnnualTaxSummaryCsv(pool, facilityId, year) {
 const hasNiu = await hasEmployeeColumn(pool, 'tax_niu');
 const niuExpr = hasNiu ? 'e.tax_niu AS niu' : "'' AS niu";
 const [detail] = await pool
  .query(
   `SELECT e.employee_id, e.first_name, e.last_name, ${niuExpr},
    SUM(p.gross_salary) AS annual_gross, SUM(p.cnps_employee) AS annual_cnps, SUM(p.cimr_employee) AS annual_cimr,
    SUM(p.income_tax) AS annual_irpp, SUM(p.net_salary) AS annual_net
    FROM tbl_hms_payroll_record p JOIN tbl_employee e ON p.employee_id = e.id
    WHERE p.year = ? AND p.facility_id = ?
    GROUP BY e.id, e.employee_id, e.first_name, e.last_name${hasNiu ? ', e.tax_niu' : ''}
    ORDER BY e.last_name, e.first_name`,
   [year, facilityId]
  )
  .catch(() => [[]]);

 const rows = [];
 rows.push(
  lineToCsv([
   'Matricule',
   'NIU',
   'Nom',
   'Prénom',
   'Salaire Brut Annuel',
   'CNPS Annuel',
   'CIMR Annuel',
   'IRPP Annuel',
   'Salaire Net Annuel'
  ])
 );
 for (const e of detail || []) {
  rows.push(
   lineToCsv([
    String(e.employee_id ?? ''),
    String(e.niu ?? ''),
    String(e.last_name ?? ''),
    String(e.first_name ?? ''),
    e.annual_gross,
    e.annual_cnps,
    e.annual_cimr,
    e.annual_irpp,
    e.annual_net
   ])
  );
 }
 const filename = `DGI_ANNUEL_${facilityId}_${year}.csv`;
 return { body: '\uFEFF' + rows.join('\r\n'), filename };
}

module.exports = { generateMonthlyTaxDeclarationCsv, generateAnnualTaxSummaryCsv };
