/**
 * HMS list search — sequential page scan (client data) and server-wide search (q param).
 */
(function () {
  'use strict';

  var DEBOUNCE_MS = 280;

  function debounce(fn, ms) {
    var t;
    return function () {
      var ctx = this;
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function normalizeQuery(q) {
    return String(q == null ? '' : q).trim().toLowerCase();
  }

  function rowTextMatches(tr, qq) {
    if (!qq) return true;
    return tr.textContent.toLowerCase().indexOf(qq) !== -1;
  }

  function objectTextMatches(obj, qq) {
    if (!qq) return true;
    try {
      return JSON.stringify(obj).toLowerCase().indexOf(qq) !== -1;
    } catch (e) {
      return false;
    }
  }

  /**
   * Scan pages in order (0-based); stop at the first page that contains a match.
   */
  function findFirstPageSequential(items, query, pageSize, matchFn) {
    var qq = normalizeQuery(query);
    if (!qq || !items || !items.length) return 0;
    var size = Math.max(1, parseInt(pageSize, 10) || 5);
    var pages = Math.max(1, Math.ceil(items.length / size));
    var match = matchFn || rowTextMatches;
    for (var p = 0; p < pages; p++) {
      var start = p * size;
      var end = Math.min(start + size, items.length);
      for (var i = start; i < end; i++) {
        if (match(items[i], qq)) return p;
      }
    }
    return 0;
  }

  function pageHasMatchSequential(items, pageIndex, query, pageSize, matchFn) {
    var qq = normalizeQuery(query);
    if (!qq) return true;
    var size = Math.max(1, parseInt(pageSize, 10) || 5);
    var start = pageIndex * size;
    var end = Math.min(start + size, items.length);
    var match = matchFn || rowTextMatches;
    for (var i = start; i < end; i++) {
      if (match(items[i], qq)) return true;
    }
    return false;
  }

  function findAdjacentPageWithMatch(items, fromPage, query, pageSize, direction, matchFn) {
    var qq = normalizeQuery(query);
    if (!qq) return fromPage;
    var size = Math.max(1, parseInt(pageSize, 10) || 5);
    var pages = Math.max(1, Math.ceil(items.length / size));
    var p = fromPage;
    if (direction > 0) {
      for (p = fromPage + 1; p < pages; p++) {
        if (pageHasMatchSequential(items, p, qq, size, matchFn)) return p;
      }
    } else {
      for (p = fromPage - 1; p >= 0; p--) {
        if (pageHasMatchSequential(items, p, qq, size, matchFn)) return p;
      }
    }
    return fromPage;
  }

  function countMatchesSequential(items, query, matchFn) {
    var qq = normalizeQuery(query);
    if (!qq) return items.length;
    var match = matchFn || rowTextMatches;
    var n = 0;
    for (var i = 0; i < items.length; i++) {
      if (match(items[i], qq)) n++;
    }
    return n;
  }

  function buildPageUrl(basePath, page, query, pageParam) {
    var base = String(basePath || '/').split('?')[0] || '/';
    var pkey = pageParam || 'p';
    var q = Object.assign({}, query || {});
    if (page > 1) q[pkey] = String(page);
    else delete q[pkey];
    var parts = [];
    Object.keys(q).forEach(function (k) {
      var v = q[k];
      if (v == null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return parts.length ? base + '?' + parts.join('&') : base;
  }

  function parsePreserveQuery(input) {
    var raw = input.getAttribute('data-hms-search-preserve');
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch (e) { /* ignore */ }
    }
    var out = {};
    var skip = { p: 1, page: 1, q: 1 };
    var sp = new URLSearchParams(window.location.search);
    sp.forEach(function (val, key) {
      if (skip[key]) return;
      out[key] = val;
    });
    return out;
  }

  function navigateServerSearch(input) {
    var base = input.getAttribute('data-hms-server-search');
    if (!base) return;
    var param = input.getAttribute('data-hms-search-param') || 'q';
    var pageParam = input.getAttribute('data-hms-page-param') || 'p';
    var q = String(input.value || '').trim();
    var preserve = parsePreserveQuery(input);
    var query = Object.assign({}, preserve);
    if (q) query[param] = q;
    else delete query[param];
    var target = buildPageUrl(base, 1, query, pageParam);
    var current =
      window.location.pathname +
      (window.location.search || '');
    if (target !== current && target !== window.location.pathname + window.location.search) {
      window.location.assign(target);
    }
  }

  function bindServerSearchInput(input) {
    if (!input || input.getAttribute('data-hms-list-search-bound') === '1') return;
    input.setAttribute('data-hms-list-search-bound', '1');
    var form = input.closest('form');
    var onInput = debounce(function () {
      navigateServerSearch(input);
    }, DEBOUNCE_MS);
    input.addEventListener('input', onInput);
    input.addEventListener('search', function () {
      navigateServerSearch(input);
    });
    if (form && form.getAttribute('data-hms-server-search-form') !== '0') {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        navigateServerSearch(input);
      });
    }
  }

  function initServerSearch(root) {
    (root || document)
      .querySelectorAll('[data-hms-server-search]')
      .forEach(bindServerSearchInput);
  }

  function initAutoWire(root) {
    var scope = root || document;
    scope.querySelectorAll('.hms-list-pager[data-hms-pager-base]').forEach(function (pagerEl) {
      var base = pagerEl.getAttribute('data-hms-pager-base');
      if (!base) return;
      var card =
        pagerEl.closest('.card') ||
        pagerEl.closest('.hms-table-fill-card') ||
        pagerEl.parentElement;
      if (!card) return;
      var input =
        card.querySelector('[data-hms-server-search]') ||
        card.querySelector('input[name="q"]');
      if (!input || input.getAttribute('data-hms-server-search')) return;
      input.setAttribute('data-hms-server-search', base);
      var pkey = pagerEl.getAttribute('data-hms-page-param');
      if (pkey) input.setAttribute('data-hms-page-param', pkey);
      bindServerSearchInput(input);
    });
  }

  function init(root) {
    initServerSearch(root);
    initAutoWire(root);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }

  window.HmsListSearch = {
    debounce: debounce,
    normalizeQuery: normalizeQuery,
    rowTextMatches: rowTextMatches,
    objectTextMatches: objectTextMatches,
    findFirstPageSequential: findFirstPageSequential,
    pageHasMatchSequential: pageHasMatchSequential,
    findAdjacentPageWithMatch: findAdjacentPageWithMatch,
    countMatchesSequential: countMatchesSequential,
    buildPageUrl: buildPageUrl,
    init: init,
    bindServerSearchInput: bindServerSearchInput,
  };
})();
