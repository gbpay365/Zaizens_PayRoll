'use strict';

/** System-wide display locale (numeric dates → DD/MM/YYYY). */
const DISPLAY_LOCALE = 'en-GB';

const NUMERIC_DATE_OPTS = { day: '2-digit', month: '2-digit', year: 'numeric' };
const NUMERIC_DATETIME_OPTS = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};
const NUMERIC_TIME_OPTS = { hour: '2-digit', minute: '2-digit' };
const MONTH_YEAR_OPTS = { month: 'long', year: 'numeric' };

const DD_MM_YYYY_RX = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

/**
 * Normalize MySQL DATE/DATETIME, ISO string, or JS Date → YYYY-MM-DD (local calendar).
 * @param {*} value
 * @returns {string}
 */
function toIsoDatePart(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    // mysql2 DATE/DATETIME: use local calendar parts (DATE is midnight local).
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return toIsoDatePart(parsed);
  return '';
}

/**
 * @param {string} y
 * @param {string} m
 * @param {string} d
 * @returns {string} DD/MM/YYYY
 */
function formatFromYmd(y, m, d) {
  const mi = parseInt(m, 10);
  const di = parseInt(d, 10);
  const yi = parseInt(y, 10);
  if (!yi || mi < 1 || mi > 12 || di < 1 || di > 31) return '';
  return `${String(di).padStart(2, '0')}/${String(mi).padStart(2, '0')}/${yi}`;
}

function parseToDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const iso = toIsoDatePart(value);
  if (iso) return new Date(iso + 'T12:00:00');
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Display date: DD/MM/YYYY
 * @param {*} value
 * @returns {string}
 */
function formatDisplayDateValue(value) {
  if (value == null || value === '') return '—';
  const s = String(value).trim();
  if (DD_MM_YYYY_RX.test(s)) return s;
  const iso = toIsoDatePart(value);
  if (iso) {
    const [y, m, d] = iso.split('-');
    const out = formatFromYmd(y, m, d);
    return out || '—';
  }
  const d = parseToDate(value);
  if (d) {
    try {
      return d.toLocaleDateString(DISPLAY_LOCALE, NUMERIC_DATE_OPTS);
    } catch (_) {
      return formatFromYmd(
        d.getFullYear(),
        d.getMonth() + 1,
        d.getDate()
      ) || '—';
    }
  }
  return '—';
}

/** @param {*} value @returns {string} DD/MM/YYYY */
function formatDisplayDate(value) {
  return formatDisplayDateValue(value);
}

/** Short display date (same as full: DD/MM/YYYY). */
function formatDisplayDateShort(value) {
  return formatDisplayDateValue(value);
}

/** Compact day/month: DD/MM */
function formatDayMonth(value) {
  const iso = toIsoDatePart(value);
  if (!iso) return '—';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

/**
 * Display date and time: DD/MM/YYYY, HH:mm
 * @param {*} value
 * @returns {string}
 */
function formatDisplayDateTime(value) {
  if (value == null || value === '') return '—';
  const d = parseToDate(value);
  if (!d) return formatDisplayDate(value);
  try {
    return d.toLocaleString(DISPLAY_LOCALE, NUMERIC_DATETIME_OPTS);
  } catch (_) {
    const datePart = formatDisplayDate(d);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${datePart}, ${hh}:${mm}`;
  }
}

/**
 * Time only: HH:mm
 * @param {*} value
 * @returns {string}
 */
function formatDisplayTime(value) {
  if (value == null || value === '') return '—';
  const d = parseToDate(value);
  if (!d) return '—';
  try {
    return d.toLocaleTimeString(DISPLAY_LOCALE, NUMERIC_TIME_OPTS);
  } catch (_) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

/**
 * Month + year label (e.g. May 2026) for period headers.
 * @param {*} value
 * @returns {string}
 */
function formatMonthYear(value) {
  const d = parseToDate(value);
  if (!d) return '—';
  try {
    return d.toLocaleDateString(DISPLAY_LOCALE, MONTH_YEAR_OPTS);
  } catch (_) {
    return String(d.getFullYear());
  }
}

/**
 * Period range: DD/MM/YYYY — DD/MM/YYYY
 */
function formatPeriodRange(from, to) {
  const a = formatDisplayDate(from);
  const b = formatDisplayDate(to);
  if (a === '—' && b === '—') return '—';
  if (a === '—') return b;
  if (b === '—') return a;
  if (a === b) return a;
  return `${a} — ${b}`;
}

/**
 * Format strings like "2026-05-01 — 2026-05-31" or legacy "01/05/2026 — 31/05/2026".
 */
function formatPeriodDisplayString(raw) {
  const s = String(raw || '').trim();
  if (!s) return '—';
  const parts = s.split(/\s*[—–→]\s*/);
  if (parts.length < 2) return formatDisplayDate(s);
  const sep = s.includes('→') ? ' → ' : ' — ';
  return parts.map((p) => formatDisplayDate(p.trim())).filter((x) => x !== '—').join(sep) || '—';
}

function mapFinRowDates(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  if ('entry_date' in out) {
    out.entry_date_iso = toIsoDatePart(out.entry_date);
    out.entry_date_display = formatDisplayDate(out.entry_date);
    out.entry_date = out.entry_date_display;
  }
  if ('journal_date' in out) {
    out.journal_date_iso = toIsoDatePart(out.journal_date);
    out.journal_date_display = formatDisplayDate(out.journal_date);
    out.journal_date = out.journal_date_display;
  }
  if ('expense_date' in out && !out.expense_date_display) {
    out.expense_date_display = formatDisplayDate(out.expense_date);
  }
  if ('created_at' in out) {
    out.created_at_display = formatDisplayDate(out.created_at);
  }
  return out;
}

function mapFinRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(mapFinRowDates);
}

function formatObjectDates(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) continue;
    if (out[k] == null || String(out[k]).trim() === '') continue;
    const isoKey = `${k}_iso`;
    if (!Object.prototype.hasOwnProperty.call(out, isoKey)) {
      out[isoKey] = toIsoDatePart(out[k]);
    }
    out[k] = formatDisplayDate(out[k]);
  }
  return out;
}

function formatRowsDates(rows, keys) {
  return (Array.isArray(rows) ? rows : []).map((row) => formatObjectDates(row, keys));
}

module.exports = {
  DISPLAY_LOCALE,
  NUMERIC_DATE_OPTS,
  toIsoDatePart,
  formatDisplayDate,
  formatDisplayDateShort,
  formatDayMonth,
  formatDisplayDateTime,
  formatDisplayTime,
  formatMonthYear,
  formatPeriodRange,
  formatPeriodDisplayString,
  mapFinRowDates,
  mapFinRows,
  formatObjectDates,
  formatRowsDates,
};
