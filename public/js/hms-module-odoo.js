/**
 * Odoo module shells — Accounting, Payroll, HR (nav dropdowns + apps launcher)
 */
(function () {
  'use strict';

  var appsBtn = document.getElementById('hmsOdooAppsBtn');
  var appsOverlay = document.getElementById('hmsOdooAppsOverlay');

  function closeApps() {
    if (!appsOverlay) return;
    appsOverlay.classList.remove('is-open');
    appsOverlay.setAttribute('aria-hidden', 'true');
  }

  function openApps() {
    if (!appsOverlay) return;
    appsOverlay.classList.add('is-open');
    appsOverlay.setAttribute('aria-hidden', 'false');
  }

  if (appsBtn && appsOverlay) {
    appsBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (appsOverlay.classList.contains('is-open')) closeApps();
      else openApps();
    });
    appsOverlay.addEventListener('click', function (e) {
      if (e.target === appsOverlay) closeApps();
    });
  }

  function navDropdownRoots() {
    return document.querySelectorAll(
      '.hms-module-odoo-app .o_nav_dropdown, .hms-odoo-app .o_nav_dropdown, .pharmacy-odoo-app .o_nav_dropdown'
    );
  }

  function closeAllNavDropdowns(except) {
    navDropdownRoots().forEach(function (d) {
      if (except && d === except) return;
      d.classList.remove('is-open');
    });
  }

  document
    .querySelectorAll(
      '.hms-module-odoo-app .o_nav_drop_btn, .hms-odoo-app .o_nav_drop_btn, .pharmacy-odoo-app .o_nav_drop_btn'
    )
    .forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var wrap = btn.closest('.o_nav_dropdown');
        if (!wrap) return;
        var open = wrap.classList.contains('is-open');
        closeAllNavDropdowns();
        if (!open) wrap.classList.add('is-open');
      });
    });

  document.addEventListener('click', function (e) {
    if (e.target.closest('.o_nav_dropdown')) return;
    closeAllNavDropdowns();
    if (appsOverlay && appsOverlay.classList.contains('is-open') && !e.target.closest('#hmsOdooAppsBtn')) {
      closeApps();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeAllNavDropdowns();
      closeApps();
    }
  });
})();
