'use strict';

const ensureHrPayrollSchema = require('../lib/ensureHrPayrollSchema');
const {
  REPORT_KINDS,
  fmtMoney,
  loadEmployerSettings,
  loadMonthlySummary,
  loadMonthlyLines,
  loadAnnualSummary,
  loadAnnualLines,
} = require('../lib/hmsStatutoryReports');

const MONTHS = {
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
  12: 'December',
};

module.exports = function registerStatutoryReports(app, pool, requireAuth, { requirePerm }) {
  const acct = requirePerm('accounting.read', 'accounting.write');

  function facilityId(req) {
    return Math.max(1, parseInt(req.session.facilityId, 10) || 1);
  }

  function currentPeriod() {
    const now = new Date();
    return { cy: now.getFullYear(), cm: now.getMonth() + 1 };
  }

  app.get('/tax/statutory-reports', requireAuth, acct, async (req, res) => {
    try {
      await ensureHrPayrollSchema(pool);
      const { cy, cm } = currentPeriod();
      res.render('tax-statutory-reports', {
        title: 'Statutory payroll declarations — ZAIZENS',
        months: MONTHS,
        cy,
        cm,
        kinds: REPORT_KINDS,
        flash: req.query.msg || null,
        error: req.query.err || null,
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });

  app.get('/tax/statutory-reports/:kind/print', requireAuth, acct, async (req, res) => {
    const kind = String(req.params.kind || '').trim();
    const meta = REPORT_KINDS[kind];
    if (!meta) {
      return res.redirect('/tax/statutory-reports?err=' + encodeURIComponent('Unknown report type.'));
    }

    const fid = facilityId(req);
    const month = Math.max(1, Math.min(12, parseInt(req.query.month, 10) || currentPeriod().cm));
    const year = Math.max(2000, Math.min(2100, parseInt(req.query.year, 10) || currentPeriod().cy));

    try {
      await ensureHrPayrollSchema(pool);
      const employer = await loadEmployerSettings(pool, fid);
      let summary = {};
      let lines = [];
      let periodLabel = '';

      if (meta.period === 'monthly') {
        summary = await loadMonthlySummary(pool, fid, month, year);
        lines = await loadMonthlyLines(pool, fid, month, year);
        periodLabel = `${MONTHS[month] || month} ${year}`;
      } else {
        summary = await loadAnnualSummary(pool, fid, year);
        lines = await loadAnnualLines(pool, fid, year);
        periodLabel = String(year);
      }

      const empCnt = parseInt(summary.emp_cnt, 10) || 0;
      if (empCnt < 1) {
        const back = meta.period === 'monthly'
          ? `/tax/statutory-reports?err=${encodeURIComponent(`No payroll data for ${periodLabel}.`)}`
          : `/tax/statutory-reports?err=${encodeURIComponent(`No payroll data for year ${year}.`)}`;
        return res.redirect(back);
      }

      res.render('tax-statutory-print', {
        title: `${meta.title} — ${periodLabel}`,
        kind,
        meta,
        employer,
        summary,
        lines,
        fmtMoney,
        month,
        year,
        months: MONTHS,
        periodLabel,
        printDate: new Date().toLocaleDateString('fr-FR'),
        orgName: employer.facilityName || res.locals.brand?.orgName || 'Hospital',
      });
    } catch (e) {
      res.status(500).render('error', { title: 'Error', message: e.message, status: 500 });
    }
  });
};
