'use strict';

const path = require('path');
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');

const ready = i18next.use(Backend).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['payroll', 'common', 'login', 'access', 'errors'],
  defaultNS: 'payroll',
  backend: {
    loadPath: path.join(__dirname, '..', 'locales', '{{lng}}', '{{ns}}.json'),
  },
  interpolation: { escapeValue: false },
});

function middleware() {
  return async (req, res, next) => {
    try {
      await ready;
    } catch (_) {
      /* non-fatal */
    }
    const lang = String(req.cookies?.lang || 'en').slice(0, 2);
    res.locals.lang = lang;
    res.locals.t = (key, opts = {}) => {
      const o = typeof opts === 'object' && opts ? opts : {};
      return i18next.t(key, { lng: lang, ...o });
    };
    res.locals._t = res.locals.t;
    res.locals._tl = (key, fallback, opts) => {
      const o = { ns: 'legacy', defaultValue: fallback };
      if (opts && typeof opts === 'object') Object.assign(o, opts);
      return res.locals.t(key, o);
    };
    next();
  };
}

function getResourceBundle(lng, ns) {
  return i18next.getResourceBundle(lng, ns) || {};
}

module.exports = { middleware, getResourceBundle };
