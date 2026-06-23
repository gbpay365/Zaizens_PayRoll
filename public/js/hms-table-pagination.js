/**
 * HMS: client-side search + pagination for staff portal tables (default 25 rows).
 * Search scans all rows; lands on the first page (in list order) that contains a match.
 * Opt-in: add data-hms-table-paginate (and optional data-hms-page-size="5")
 * on a wrapper that contains a single .table-responsive > table structure.
 */
(function () {
  'use strict';

  var DEFAULT_PAGE = 25;
  var SEARCH_DEBOUNCE_MS = 100;
  var LS = window.HmsListSearch;
  var I18N = window.HMS_TABLE_PAGINATION_I18N || {
    searchAria: 'Search this table',
    quickSearchPh: 'Quick search…',
    noRowsSearch: 'No rows to search',
    noMatchRows: 'No rows match your search.',
    noRowsDisplay: 'No rows to display.',
    noMatches: 'No matches.',
    zeroRows: '0 rows.',
    prev: 'Prev',
    next: 'Next',
  };

  function debounce(fn, ms) {
    if (LS && LS.debounce) return LS.debounce(fn, ms);
    var t;
    return function () {
      var ctx = this;
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function getColspan(table) {
    var ths = table.querySelectorAll('thead th');
    if (ths.length) return ths.length;
    var r = table.tBodies[0] && table.tBodies[0].rows[0];
    return r ? r.cells.length : 1;
  }

  function isPlaceholderRow(tr) {
    return tr.cells.length === 1 && tr.cells[0].colSpan > 1;
  }

  function rowMatches(tr, qq) {
    if (LS && LS.rowTextMatches) return LS.rowTextMatches(tr, qq);
    return tr.textContent.toLowerCase().indexOf(qq) !== -1;
  }

  function findFirstPage(dataRows, qq, pageSize) {
    if (!qq) return 0;
    if (LS && LS.findFirstPageSequential) {
      return LS.findFirstPageSequential(dataRows, qq, pageSize, rowMatches);
    }
    var pages = Math.max(1, Math.ceil(dataRows.length / pageSize));
    for (var p = 0; p < pages; p++) {
      var start = p * pageSize;
      var end = Math.min(start + pageSize, dataRows.length);
      for (var i = start; i < end; i++) {
        if (rowMatches(dataRows[i], qq)) return p;
      }
    }
    return 0;
  }

  function enhance(wrap) {
    if (!wrap || wrap.getAttribute('data-hms-tp-init') === '1') return;
    var responsive = wrap.querySelector(':scope > .table-responsive');
    if (!responsive) responsive = wrap.querySelector('.table-responsive');
    var table = responsive && responsive.querySelector('table');
    if (!table || !table.tBodies || !table.tBodies[0]) return;

    wrap.setAttribute('data-hms-tp-init', '1');
    var pageSize =
      parseInt(wrap.getAttribute('data-hms-page-size'), 10) ||
      DEFAULT_PAGE;
    pageSize = Math.max(1, pageSize);

    var tbody = table.tBodies[0];
    var colspan = Math.max(1, getColspan(table));

    function collectDataRows() {
      return Array.from(tbody.querySelectorAll('tr')).filter(function (tr) {
        return (
          !tr.classList.contains('hms-tp-no-match-row') && !isPlaceholderRow(tr)
        );
      });
    }

    var dataRows = collectDataRows();
    var isEmptyPlaceholder = dataRows.length === 0;

    var searchId =
      'hmsTp-' + (wrap.id || 't') + '-' + Math.random().toString(36).slice(2, 8);

    var toolbar = document.createElement('div');
    toolbar.className =
      'hms-table-paginate-toolbar px-3 py-2 border-bottom align-items-center d-flex flex-wrap';
    toolbar.style.background = 'var(--main-bg,#f8fafc)';
    toolbar.innerHTML =
      '<label class="sr-only" for="' +
      searchId +
      '">' + I18N.searchAria + '</label>' +
      '<span class="text-muted mr-2 d-none d-sm-inline"><i class="fa fa-search"></i></span>' +
      '<input id="' +
      searchId +
      '" type="search" class="form-control form-control-sm hms-tp-q flex-grow-1" ' +
      'placeholder="' + I18N.quickSearchPh.replace(/"/g, '&quot;') + '" autocomplete="off" ' +
      (isEmptyPlaceholder ? 'disabled title="' + I18N.noRowsSearch.replace(/"/g, '&quot;') + '"' : '') +
      ' style="max-width:min(100%,360px);min-width:140px;border-radius:8px;">';

    var pager = document.createElement('div');
    pager.className =
      'hms-table-paginate-pager px-3 py-2 border-top bg-white small d-flex flex-wrap align-items-center justify-content-between';

    wrap.insertBefore(toolbar, responsive);
    if (responsive.nextSibling) {
      wrap.insertBefore(pager, responsive.nextSibling);
    } else {
      wrap.appendChild(pager);
    }

    var qInput = toolbar.querySelector('.hms-tp-q');
    var nomatch = null;
    if (!isEmptyPlaceholder) {
      nomatch = document.createElement('tr');
      nomatch.className = 'hms-tp-no-match-row';
      nomatch.style.display = 'none';
      var tdNom = document.createElement('td');
      tdNom.colSpan = colspan;
      tdNom.className = 'text-center text-muted py-3 small';
      tdNom.textContent = I18N.noMatchRows;
      nomatch.appendChild(tdNom);
      tbody.appendChild(nomatch);
    }

    var state = {
      q: '',
      page: 0,
    };

    function getQuery() {
      return (state.q || '').trim().toLowerCase();
    }

    function refreshRows() {
      dataRows = collectDataRows();
    }

    function renderPagerDisplay(from, to, total, page, pages, matchTotal) {
      pager.innerHTML = '';
      if (isEmptyPlaceholder) {
        pager.textContent = I18N.noRowsDisplay;
        return;
      }
      var row = document.createElement('div');
      row.className =
        'd-flex flex-wrap w-100 align-items-center justify-content-between';
      row.style.gap = '8px';

      var info = document.createElement('span');
      info.className = 'text-muted';
      var qq = getQuery();
      if (qq && matchTotal === 0) {
        info.textContent = I18N.noMatches;
      } else if (total === 0) {
        info.textContent = I18N.zeroRows;
      } else {
        info.textContent =
          'Showing ' +
          (from + 1) +
          '–' +
          to +
          ' of ' +
          total +
          (qq ? ' matching' : '');
      }

      row.appendChild(info);

      if (pages > 1 || (qq && matchTotal > 0)) {
        var nav = document.createElement('div');
        nav.className = 'btn-group btn-group-sm';
        function mkBtn(label, dis, cb) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn btn-outline-secondary';
          b.textContent = label;
          b.disabled = !!dis;
          b.addEventListener('click', cb);
          return b;
        }
        nav.appendChild(
          mkBtn(I18N.prev, page <= 0, function () {
            var qq2 = getQuery();
            if (qq2 && LS && LS.findAdjacentPageWithMatch) {
              state.page = LS.findAdjacentPageWithMatch(
                dataRows,
                state.page,
                qq2,
                pageSize,
                -1,
                rowMatches
              );
            } else {
              state.page--;
            }
            layout();
          })
        );
        nav.appendChild(
          mkBtn(I18N.next, page >= pages - 1, function () {
            var qq2 = getQuery();
            if (qq2 && LS && LS.findAdjacentPageWithMatch) {
              state.page = LS.findAdjacentPageWithMatch(
                dataRows,
                state.page,
                qq2,
                pageSize,
                1,
                rowMatches
              );
            } else {
              state.page++;
            }
            layout();
          })
        );
        var pg = document.createElement('span');
        pg.className = 'text-muted ml-2';
        pg.style.fontSize = '0.82rem';
        pg.textContent = 'Page ' + (page + 1) + ' / ' + pages;
        var right = document.createElement('div');
        right.className = 'd-flex align-items-center';
        right.appendChild(nav);
        right.appendChild(pg);
        row.appendChild(right);
      }

      pager.appendChild(row);
    }

    function layout() {
      refreshRows();
      if (isEmptyPlaceholder && dataRows.length === 0) {
        renderPagerDisplay(0, 0, 0, 0, 1, 0);
        return;
      }
      if (dataRows.length > 0) isEmptyPlaceholder = false;

      var qq = getQuery();
      if (nomatch) nomatch.style.display = 'none';

      var matchTotal = qq
        ? LS && LS.countMatchesSequential
          ? LS.countMatchesSequential(dataRows, qq, rowMatches)
          : dataRows.filter(function (tr) { return rowMatches(tr, qq); }).length
        : dataRows.length;

      if (qq && matchTotal === 0) {
        dataRows.forEach(function (tr) {
          tr.style.display = 'none';
        });
        if (nomatch) nomatch.style.display = '';
        renderPagerDisplay(0, 0, 0, 0, 1, 0);
        return;
      }

      var pages = Math.max(1, Math.ceil(dataRows.length / pageSize));
      if (state.page > pages - 1) state.page = Math.max(0, pages - 1);

      if (!qq) {
        var startAll = state.page * pageSize;
        var sliceAll = dataRows.slice(startAll, startAll + pageSize);
        dataRows.forEach(function (tr) {
          tr.style.display = 'none';
        });
        sliceAll.forEach(function (tr) {
          tr.style.display = '';
        });
        var fromAll = matchTotal === 0 ? 0 : startAll;
        var toAll = Math.min(startAll + sliceAll.length, dataRows.length);
        renderPagerDisplay(fromAll, toAll, dataRows.length, state.page, pages, matchTotal);
        return;
      }

      var start = state.page * pageSize;
      var end = Math.min(start + pageSize, dataRows.length);
      var shown = 0;
      dataRows.forEach(function (tr) {
        tr.style.display = 'none';
      });
      for (var i = start; i < end; i++) {
        if (rowMatches(dataRows[i], qq)) {
          dataRows[i].style.display = '';
          shown++;
        }
      }

      if (shown === 0 && matchTotal > 0) {
        state.page = findFirstPage(dataRows, qq, pageSize);
        layout();
        return;
      }

      renderPagerDisplay(
        shown ? start : 0,
        shown ? start + shown : 0,
        dataRows.length,
        state.page,
        pages,
        matchTotal
      );
    }

    var onSearch = debounce(function () {
      refreshRows();
      state.q = qInput.value || '';
      var qq = getQuery();
      state.page = findFirstPage(dataRows, qq, pageSize);
      layout();
    }, SEARCH_DEBOUNCE_MS);

    if (!isEmptyPlaceholder) {
      qInput.addEventListener('input', onSearch);
      qInput.addEventListener('search', function () {
        refreshRows();
        state.q = qInput.value || '';
        state.page = findFirstPage(dataRows, getQuery(), pageSize);
        layout();
      });
    }

    layout();
  }

  function init(root) {
    var scope = root || document;
    scope.querySelectorAll('[data-hms-table-paginate]').forEach(enhance);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      init();
    });
  } else {
    init();
  }

  window.HmsTablePagination = { init: init };
})();
