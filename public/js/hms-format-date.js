/**
 * Client-side HMS date formatting — DD/MM/YYYY (matches lib/hmsFormatDate.js).
 */
(function (global) {
  var LOCALE = 'en-GB';
  var DATE_OPTS = { day: '2-digit', month: '2-digit', year: 'numeric' };
  var DATETIME_OPTS = {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  };

  function toIsoDatePart(value) {
    if (value == null || value === '') return '';
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return '';
      return (
        value.getFullYear() +
        '-' +
        String(value.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(value.getDate()).padStart(2, '0')
      );
    }
    var s = String(value).trim();
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
    var dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dmy) {
      return dmy[3] + '-' + String(dmy[2]).padStart(2, '0') + '-' + String(dmy[1]).padStart(2, '0');
    }
    var d = new Date(s);
    if (!Number.isNaN(d.getTime())) return toIsoDatePart(d);
    return '';
  }

  function formatFromYmd(y, m, d) {
    var mi = parseInt(m, 10);
    var di = parseInt(d, 10);
    var yi = parseInt(y, 10);
    if (!yi || mi < 1 || mi > 12 || di < 1 || di > 31) return '';
    return String(di).padStart(2, '0') + '/' + String(mi).padStart(2, '0') + '/' + yi;
  }

  function parseToDate(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    var iso = toIsoDatePart(value);
    if (iso) return new Date(iso + 'T12:00:00');
    var s = String(value).trim();
    if (!s) return null;
    var d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatDate(value) {
    if (value == null || value === '') return '—';
    var s = String(value).trim();
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;
    var iso = toIsoDatePart(value);
    if (iso) {
      var p = iso.split('-');
      var out = formatFromYmd(p[0], p[1], p[2]);
      return out || '—';
    }
    var d = parseToDate(value);
    if (!d) return '—';
    try {
      return d.toLocaleDateString(LOCALE, DATE_OPTS);
    } catch (e) {
      return formatFromYmd(d.getFullYear(), d.getMonth() + 1, d.getDate()) || '—';
    }
  }

  function formatDateTime(value) {
    if (value == null || value === '') return '—';
    var d = parseToDate(value);
    if (!d) return formatDate(value);
    try {
      return d.toLocaleString(LOCALE, DATETIME_OPTS);
    } catch (e) {
      var dp = formatDate(d);
      return dp + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
  }

  global.HMS_FORMAT_DATE = {
    locale: LOCALE,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    toIsoDatePart: toIsoDatePart,
  };
})(typeof window !== 'undefined' ? window : global);
