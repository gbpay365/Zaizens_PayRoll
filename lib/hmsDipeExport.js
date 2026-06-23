/**
 * CNPS DIPE-style fixed-width lines (indicative — validate with CNPS before filing).
 * Ported from PHP includes/HmsDipeGenerator.php
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DIPE_DIR_SEGMENTS = ['data', 'dipe'];

function getDipeStorageDir() {
 const baseDir = path.join(PROJECT_ROOT, ...DIPE_DIR_SEGMENTS);
 fs.mkdirSync(baseDir, { recursive: true });
 return baseDir;
}

function toPosixRel(segments) {
 return segments.join('/');
}

/** Resolve stored path (tmp/dipe or data/dipe) to absolute path if file exists. */
function resolveExistingDipePath(rel, filename) {
 const candidates = [];
 const relNorm = String(rel || '')
  .replace(/^\/+/, '')
  .split(/[/\\]/)
  .filter(Boolean);
 if (relNorm.length) {
  candidates.push(path.join(PROJECT_ROOT, ...relNorm));
 }
 const base = path.basename(String(filename || ''));
 if (base) {
  candidates.push(path.join(PROJECT_ROOT, 'tmp', 'dipe', base));
  candidates.push(path.join(getDipeStorageDir(), base));
 }
 const seen = new Set();
 for (const full of candidates) {
  const key = path.resolve(full);
  if (seen.has(key)) continue;
  seen.add(key);
  if (fs.existsSync(key)) return key;
 }
 return null;
}

function padStr(s, len, padChar = ' ') {
 const t = String(s || '').slice(0, len);
 return t.padEnd(len, padChar);
}

function digitsOnly(s, maxLen) {
 return String(s || '').replace(/\D/g, '').slice(0, maxLen);
}

function formatLine(employer, e, month, year, lineNo) {
 const niu = padStr(digitsOnly(employer.employer_niu, 14), 14, ' ');
 const empNum = padStr(digitsOnly(employer.employer_cnps_number, 10), 10, '0');
 const assure = padStr(digitsOnly(e.cnps_ref, 10), 10, '0');
 const workingDays = 26;
 const gross = Math.round(parseFloat(e.gross) || 0);
 const cnps = parseFloat(e.cnps) || 0;
 const cimr = parseFloat(e.cimr) || 0;
 const taxable = Math.max(0, Math.round(gross - cnps - cimr));
 const cotisable = Math.min(gross, 750000);
 let reg = String(employer.cnps_regime != null ? employer.cnps_regime : '1');
 reg = reg.length === 1 ? reg : '1';
 let code = String(e.employee_id || e.id || '')
  .replace(/\s+/g, '')
  .slice(0, 14);
 code = padStr(code, 14, ' ');

 return (
  'C04' +
  String(lineNo).padStart(5, '0') +
  '0' +
  niu +
  '01' +
  empNum +
  '0' +
  reg +
  String(year) +
  assure +
  '0' +
  String(workingDays).padStart(2, '0') +
  String(gross).padStart(10, '0') +
  '0000000000' +
  String(taxable).padStart(10, '0') +
  String(cotisable).padStart(10, '0') +
  String(cotisable).padStart(10, '0') +
  String(Math.max(0, Math.round(parseFloat(e.irpp) || 0))).padStart(8, '0') +
  String(Math.max(0, Math.round(parseFloat(e.council) || 0))).padStart(6, '0') +
  String(Math.min(99, lineNo)).padStart(2, '0') +
  code +
  ' '
 );
}

async function hasEmployeeColumn(pool, col) {
 try {
  const [r] = await pool.query(
   'SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
   ['tbl_employee', col]
  );
  return r && r[0] && Number(r[0].c) > 0;
 } catch (_) {
  return false;
 }
}

/**
 * @returns {Promise<string>} CRLF-separated body or '' if no rows
 */
async function generateMonthlyDipeContent(pool, facilityId, month, year) {
 const [[emp]] = await pool
  .query(
   'SELECT * FROM tbl_hms_payroll_settings WHERE facility_id = ? ORDER BY tax_year DESC LIMIT 1',
   [facilityId]
  )
  .catch(() => [[null]]);
 const employer = emp || {};

 const hasCnpsCol = await hasEmployeeColumn(pool, 'tax_cnps_number');
 const cnpsExpr = hasCnpsCol
  ? "COALESCE(NULLIF(TRIM(e.tax_cnps_number), ''), CAST(e.employee_id AS CHAR), CAST(e.id AS CHAR))"
  : "COALESCE(CAST(e.employee_id AS CHAR), CAST(e.id AS CHAR))";

 const sql = `
  SELECT e.id, e.first_name, e.last_name, e.employee_id,
         ${cnpsExpr} AS cnps_ref,
         COALESCE(p.gross_salary, 0) AS gross,
         COALESCE(p.cnps_employee, 0) AS cnps,
         COALESCE(p.cimr_employee, 0) AS cimr,
         COALESCE(p.income_tax, 0) AS irpp,
         COALESCE(p.council_tax_deduction, 0) AS council
  FROM tbl_employee e
  LEFT JOIN tbl_hms_payroll_record p
    ON e.id = p.employee_id AND p.month = ? AND p.year = ? AND p.facility_id = ?
  WHERE e.status = 1
  HAVING gross > 0
  ORDER BY e.id`;

 const [rows] = await pool.query(sql, [month, year, facilityId]).catch(() => [[]]);
 if (!rows || !rows.length) return '';

 const lines = [];
 let i = 1;
 for (const e of rows) {
  lines.push(formatLine(employer, e, month, year, i));
  i++;
 }
 return lines.join('\r\n');
}

/**
 * Writes DIPE file under data/dipe (persistent) and inserts tbl_hms_dipe_history.
 * @returns {Promise<{id:number,filename:string}|null>}
 */
async function saveDipeFile(pool, facilityId, month, year, generatedBy) {
 const content = await generateMonthlyDipeContent(pool, facilityId, month, year);
 if (!content) return null;

 const baseDir = getDipeStorageDir();
 const file = `DIPE_${facilityId}_${String(year)}${String(month).padStart(2, '0')}_${Date.now()}.txt`;
 const full = path.join(baseDir, file);
 fs.writeFileSync(full, content, 'utf8');
 const rel = toPosixRel([...DIPE_DIR_SEGMENTS, file]);

 const [ins] = await pool.query(
  'INSERT INTO tbl_hms_dipe_history (facility_id, month, year, filename, file_path, generated_by) VALUES (?,?,?,?,?,?)',
  [facilityId, month, year, file, rel, generatedBy]
 );
 const id = ins.insertId;
 return { id, filename: file, fullPath: full, rel };
}

/**
 * Ensure DIPE file exists on disk for a history row; rebuild from payroll if missing (e.g. tmp/ cleared).
 * @returns {Promise<{ fullPath: string, filename: string, regenerated: boolean }>}
 */
async function ensureDipeFileForDownload(pool, historyRow) {
 if (!historyRow || !historyRow.id) {
  const err = new Error('Invalid DIPE record');
  err.code = 'DIPE_INVALID';
  throw err;
 }

 const filename = path.basename(String(historyRow.filename || 'dipe.txt'));
 let full = resolveExistingDipePath(historyRow.file_path, filename);
 if (full) {
  return { fullPath: full, filename, regenerated: false };
 }

 const fid = parseInt(historyRow.facility_id, 10) || 1;
 const month = parseInt(historyRow.month, 10) || 1;
 const year = parseInt(historyRow.year, 10) || new Date().getFullYear();
 const content = await generateMonthlyDipeContent(pool, fid, month, year);
 if (!content) {
  const err = new Error(
   'DIPE file is missing and cannot be rebuilt: no payroll lines with gross > 0 for that month.'
  );
  err.code = 'DIPE_NO_DATA';
  throw err;
 }

 const baseDir = getDipeStorageDir();
 const outName = filename || `DIPE_${fid}_${String(year)}${String(month).padStart(2, '0')}_${Date.now()}.txt`;
 full = path.join(baseDir, outName);
 fs.writeFileSync(full, content, 'utf8');
 const rel = toPosixRel([...DIPE_DIR_SEGMENTS, outName]);

 await pool
  .query('UPDATE tbl_hms_dipe_history SET filename = ?, file_path = ? WHERE id = ?', [
   outName,
   rel,
   historyRow.id,
  ])
  .catch(() => {});

 return { fullPath: full, filename: outName, regenerated: true };
}

module.exports = {
 generateMonthlyDipeContent,
 saveDipeFile,
 ensureDipeFileForDownload,
 resolveExistingDipePath,
 getDipeStorageDir,
};
