/**
 * Payroll & HR module UI helpers (Cameroon logic stays server-side).
 */
(function () {
  'use strict';

  function fmtXaf(n) {
    return (Number(n) || 0).toLocaleString('fr-FR', { maximumFractionDigits: 0 });
  }

  function confirmPayAction(msg) {
    return window.confirm(msg || 'Continue?');
  }

  /** Wire [data-pay-confirm] forms */
  function initConfirmForms() {
    document.querySelectorAll('form[data-pay-confirm]').forEach(function (form) {
      if (form.dataset.payConfirmBound) return;
      form.dataset.payConfirmBound = '1';
      form.addEventListener('submit', function (e) {
        var msg = form.getAttribute('data-pay-confirm');
        if (!confirmPayAction(msg)) e.preventDefault();
      });
    });
  }

  /** Monthly payroll table filter */
  function initPayrollTableSearch() {
    var input = document.getElementById('payrollLinesSearch');
    var table = document.getElementById('payrollLinesTable');
    if (!input || !table) return;
    if (input.getAttribute('data-hms-server-search')) return;
    var rows = table.querySelectorAll('tbody tr[data-pay-row]');
    input.addEventListener('input', function () {
      var q = (input.value || '').trim().toLowerCase();
      rows.forEach(function (tr) {
        var text = (tr.getAttribute('data-pay-search') || tr.textContent || '').toLowerCase();
        tr.style.display = !q || text.indexOf(q) >= 0 ? '' : 'none';
      });
    });
  }

  /** XAF hint on profile inputs */
  function initProfileInputs() {
    document.querySelectorAll('.pay-input-xaf').forEach(function (el) {
      el.addEventListener('blur', function () {
        var v = String(el.value || '').replace(/\s/g, '').replace(/,/g, '.');
        var n = parseFloat(v);
        if (!isNaN(n) && n >= 0) el.value = String(Math.round(n));
      });
    });
  }

  /** Monthly payroll bulk select + delete */
  function initPayrollBulkSelect() {
    var table = document.getElementById('payrollLinesTable');
    var selectAllPage = document.getElementById('paySelectAllPage');
    var selectAllResultsBtn = document.getElementById('payBulkSelectAllResults');
    var deleteBtn = document.getElementById('payBulkDeleteBtn');
    var deleteForm = document.getElementById('payBulkDeleteForm');
    var deleteIdsBox = document.getElementById('payBulkDeleteIds');
    var countEl = document.getElementById('payBulkDeleteCount');
    if (!table || !deleteBtn || !deleteForm || !deleteIdsBox) return;

    var allIds = [];
    try {
      var raw = table.getAttribute('data-all-deletable-ids');
      if (raw) {
        allIds = JSON.parse(raw)
          .map(function (id) { return parseInt(id, 10); })
          .filter(function (id) { return id > 0; });
      }
    } catch (e) {
      allIds = [];
    }

    var selected = new Set();
    var allResultsMode = false;

    function pageCheckboxes() {
      return Array.prototype.slice.call(table.querySelectorAll('tbody .pay-line-select'));
    }

    function visiblePageCheckboxes() {
      return pageCheckboxes().filter(function (cb) {
        var tr = cb.closest('tr');
        return tr && tr.style.display !== 'none';
      });
    }

    function updateCount() {
      var n = selected.size;
      if (countEl) countEl.textContent = '(' + n + ')';
      deleteBtn.disabled = n < 1;
    }

    function syncHeaderCheckbox() {
      if (!selectAllPage) return;
      var visible = visiblePageCheckboxes();
      if (!visible.length) {
        selectAllPage.checked = false;
        selectAllPage.indeterminate = false;
        return;
      }
      var checkedCount = visible.filter(function (cb) { return cb.checked; }).length;
      selectAllPage.checked = checkedCount === visible.length;
      selectAllPage.indeterminate = checkedCount > 0 && checkedCount < visible.length;
    }

    function syncPageCheckboxesFromSelection() {
      pageCheckboxes().forEach(function (cb) {
        var id = parseInt(cb.value, 10);
        cb.checked = selected.has(id);
      });
      syncHeaderCheckbox();
    }

    function exitAllResultsMode() {
      allResultsMode = false;
      if (!selectAllResultsBtn) return;
      selectAllResultsBtn.classList.remove('active');
      var selectLabel = selectAllResultsBtn.getAttribute('data-label-select');
      if (selectLabel) selectAllResultsBtn.textContent = selectLabel;
    }

    function setAllResultsMode(on) {
      if (on) {
        allResultsMode = true;
        selected = new Set(allIds);
        if (selectAllResultsBtn) {
          selectAllResultsBtn.classList.add('active');
          var clearLabel = selectAllResultsBtn.getAttribute('data-label-clear');
          if (clearLabel) selectAllResultsBtn.textContent = clearLabel;
        }
      } else {
        exitAllResultsMode();
      }
      syncPageCheckboxesFromSelection();
      updateCount();
    }

    pageCheckboxes().forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = parseInt(cb.value, 10);
        if (allResultsMode) {
          exitAllResultsMode();
          selected = new Set(allIds);
        }
        if (cb.checked) selected.add(id);
        else selected.delete(id);
        syncHeaderCheckbox();
        updateCount();
      });
    });

    if (selectAllPage) {
      selectAllPage.addEventListener('change', function () {
        var check = selectAllPage.checked;
        if (allResultsMode) {
          exitAllResultsMode();
          if (!check) {
            selected.clear();
            syncPageCheckboxesFromSelection();
            updateCount();
            return;
          }
          selected.clear();
        }
        visiblePageCheckboxes().forEach(function (cb) {
          var id = parseInt(cb.value, 10);
          cb.checked = check;
          if (check) selected.add(id);
          else selected.delete(id);
        });
        syncHeaderCheckbox();
        updateCount();
      });
    }

    if (selectAllResultsBtn && allIds.length) {
      selectAllResultsBtn.addEventListener('click', function () {
        if (allResultsMode) {
          selected.clear();
          setAllResultsMode(false);
        } else {
          setAllResultsMode(true);
        }
      });
    }

    deleteBtn.addEventListener('click', function () {
      if (selected.size < 1) return;
      var tpl = deleteBtn.getAttribute('data-pay-bulk-delete-confirm') ||
        'Delete {{count}} selected payroll line(s)? They can be re-processed after deletion.';
      var msg = tpl.replace(/\{\{count\}\}/g, String(selected.size));
      if (!confirmPayAction(msg)) return;
      deleteIdsBox.innerHTML = '';
      selected.forEach(function (id) {
        var inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = 'payroll_record_ids';
        inp.value = String(id);
        deleteIdsBox.appendChild(inp);
      });
      deleteForm.submit();
    });

    updateCount();
  }

  window.HmsPayroll = {
    fmtXaf: fmtXaf,
    confirmPayAction: confirmPayAction
  };

  /** Process month / mark period paid modals */
  function initPayrollModals() {
    var map = {
      process: '#hmsPayrollProcessModal',
      'mark-paid': '#hmsPayrollMarkPaidModal',
      resync: '#hmsPayrollResyncModal'
    };
    document.querySelectorAll('[data-hms-payroll-modal]').forEach(function (btn) {
      if (btn.dataset.payModalBound) return;
      btn.dataset.payModalBound = '1';
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-hms-payroll-modal');
        var sel = map[key];
        if (!sel) return;
        var el = document.querySelector(sel);
        if (!el) return;
        if (typeof window.jQuery !== 'undefined' && window.jQuery.fn && window.jQuery.fn.modal) {
          window.jQuery(el).modal('show');
        } else {
          el.classList.add('show');
          el.style.display = 'block';
          el.removeAttribute('aria-hidden');
        }
      });
    });
  }

  /** Settings page tab switching */
  function initSettingsTabs() {
    var root = document.getElementById('paySettingsTabs');
    if (!root) return;
    var panes = document.querySelectorAll('[data-pay-settings-pane]');
    var sections = document.querySelectorAll('[data-pay-settings-section]');
    var links = root.querySelectorAll('[data-pay-settings-tab]');
    function showTab(name) {
      links.forEach(function (a) {
        var on = a.getAttribute('data-pay-settings-tab') === name;
        a.classList.toggle('active', on);
        a.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      var isMain = name === 'employer' || name === 'deductions' || name === 'irpp';
      panes.forEach(function (pane) {
        var paneName = pane.getAttribute('data-pay-settings-pane');
        var on = isMain ? paneName === 'employer' : paneName === name;
        pane.hidden = !on;
        pane.classList.toggle('d-none', !on);
      });
      sections.forEach(function (section) {
        var on = section.getAttribute('data-pay-settings-section') === name;
        section.hidden = !on;
        section.classList.toggle('d-none', !on);
      });
    }
    links.forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        showTab(a.getAttribute('data-pay-settings-tab'));
      });
    });
    var initial = root.getAttribute('data-initial-tab') || 'employer';
    showTab(initial);
  }

  document.addEventListener('DOMContentLoaded', function () {
    initConfirmForms();
    initPayrollTableSearch();
    initProfileInputs();
    initPayrollBulkSelect();
    initPayrollModals();
    initSettingsTabs();
  });
})();
