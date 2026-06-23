/**
 * Normalizes legacy GMT / ISO date strings in the DOM to DD/MM/YYYY.
 * Server templates should prefer fmtDate / hmsFormatDate; this catches leftovers.
 */
(function () {
  function formatValue(raw) {
    if (window.HMS_FORMAT_DATE && typeof window.HMS_FORMAT_DATE.formatDate === 'function') {
      return window.HMS_FORMAT_DATE.formatDate(raw);
    }
    if (raw == null || raw === '') return null;
    var s = String(raw).trim();
    if (!s) return null;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      return (
        String(parseInt(iso[3], 10)).padStart(2, '0') +
        '/' +
        iso[2] +
        '/' +
        iso[1]
      );
    }
    var GMT_RX =
      /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT/i;
    if (GMT_RX.test(s) || /GMT[+-]/.test(s)) {
      var d = new Date(s);
      if (!Number.isNaN(d.getTime())) {
        return (
          String(d.getDate()).padStart(2, '0') +
          '/' +
          String(d.getMonth() + 1).padStart(2, '0') +
          '/' +
          d.getFullYear()
        );
      }
    }
    return null;
  }

  function applyToElement(el) {
    if (!el || el.dataset.hmsDateDone === '1') return;
    var attr = el.getAttribute('data-hms-date');
    var next = formatValue(attr != null ? attr : el.textContent);
    if (next && next !== '—') {
      el.textContent = next;
      el.dataset.hmsDateDone = '1';
    }
  }

  function scan(root) {
    var base = root || document;
    base.querySelectorAll('[data-hms-date]').forEach(applyToElement);
    base.querySelectorAll('.page-wrapper td, .page-wrapper th, .page-wrapper p, .page-wrapper span, .page-wrapper li').forEach(function (el) {
      if (el.childElementCount > 0) return;
      var t = (el.textContent || '').trim();
      var GMT_RX =
        /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT/i;
      if (!GMT_RX.test(t)) return;
      applyToElement(el);
    });
  }

  function run() {
    scan(document);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
