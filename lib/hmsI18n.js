'use strict';

/** i18n: session.lang drives locale; DB nav labels use navLabel() with nav.codes.* keys. */

const path = require('path');
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const SUPPORTED = ['en', 'fr'];
const DEFAULT_LANG = 'en';
const NAMESPACES = ['common', 'errors', 'login', 'dashboard', 'nav', 'clinical', 'financials', 'print', 'payroll', 'ops', 'ipd', 'superAdmin', 'access', 'legacy', 'portal', 'death'];

let initPromise = null;

function parseAcceptLanguage(header) {
  if (!header) return null;
  const parts = String(header).split(',');
  for (const part of parts) {
    const code = part.split(';')[0].trim().toLowerCase().slice(0, 2);
    if (SUPPORTED.includes(code)) return code;
  }
  return null;
}

function normalizeLang(value) {
  const l = String(value || DEFAULT_LANG).toLowerCase().slice(0, 2);
  return SUPPORTED.includes(l) ? l : DEFAULT_LANG;
}

function resolveLocale(req) {
  const sessionLang = req?.session?.lang;
  if (sessionLang) return normalizeLang(sessionLang);
  const cookieLang = req?.cookies?.hms_lang;
  if (cookieLang) return normalizeLang(cookieLang);
  const accept = parseAcceptLanguage(req?.headers?.['accept-language']);
  if (accept) return accept;
  return DEFAULT_LANG;
}

function ensureInit() {
  if (initPromise) return initPromise;
  initPromise = i18next
    .use(Backend)
    .init({
      lng: DEFAULT_LANG,
      fallbackLng: DEFAULT_LANG,
      supportedLngs: SUPPORTED,
      preload: SUPPORTED,
      ns: NAMESPACES,
      defaultNS: 'common',
      backend: {
        loadPath: path.join(LOCALES_DIR, '{{lng}}', '{{ns}}.json'),
      },
      interpolation: { escapeValue: false },
      initImmediate: false,
    })
    .then(() => i18next.loadLanguages(SUPPORTED));
  return initPromise;
}

function resolveTOptions(defaultValue, opts) {
  if (typeof defaultValue === 'object' && defaultValue !== null) {
    return { ...(opts && typeof opts === 'object' ? opts : {}), ...defaultValue };
  }
  const options = opts && typeof opts === 'object' ? { ...opts } : {};
  if (typeof defaultValue === 'string') options.defaultValue = defaultValue;
  return options;
}

function getFixedT(lang) {
  const lng = normalizeLang(lang);
  return (key, defaultValue, opts) => {
    const merged = resolveTOptions(defaultValue, opts);
    if (!i18next.isInitialized) {
      if (merged.defaultValue != null) return String(merged.defaultValue);
      return String(key);
    }
    const options = { lng, ...merged };
    return i18next.t(key, options);
  };
}

function t(key, lang, opts) {
  return getFixedT(lang)(key, undefined, opts);
}

function enrichPageData(pageData, lang) {
  const pd = pageData && typeof pageData === 'object' ? { ...pageData } : {};
  pd.locale = normalizeLang(lang);
  pd.lang = pd.locale;
  return pd;
}

function dateLocale(lang) {
  return normalizeLang(lang) === 'fr' ? 'fr-FR' : 'en-GB';
}

function getResourceBundle(lang, ns) {
  const lng = normalizeLang(lang);
  if (!i18next.isInitialized) return {};
  return i18next.getResourceBundle(lng, ns) || {};
}

function sanitizeBackPath(value, fallback = '') {
  const s = String(value || '').trim();
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  return fallback;
}

function resolveBackUrl(req) {
  const fromQuery = sanitizeBackPath(req.query?.back, '');
  if (fromQuery) return fromQuery;
  const raw = String(req.get('Referer') || '').trim();
  if (!raw) return '/';
  try {
    const u = new URL(raw);
    const host = String(req.get('host') || '');
    if (host && u.host !== host) return '/';
    const path = `${u.pathname || '/'}${u.search || ''}`;
    return path || '/';
  } catch {
    return sanitizeBackPath(raw, '/');
  }
}

async function handleSetLang(req, res) {
  await ensureInit();
  const lang = normalizeLang(req.body?.lang ?? req.query?.lang);
  res.cookie('hms_lang', lang, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: false,
    sameSite: 'lax',
  });
  if (req.session) {
    req.session.lang = lang;
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
  }
  const back = resolveBackUrl(req);
  const sep = back.includes('?') ? '&' : '?';
  return res.redirect(`${back}${sep}msgKey=${encodeURIComponent('language.updated')}`);
}

function isLocaleKey(value) {
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(String(value || '').trim());
}

const FLASH_ERR_TEXT_TO_KEY = {
  'Access denied. You do not have permission to open this section.': 'access.section',
  'Access denied. HR self-service is not enabled for your role.': 'access.hr_self',
  'Access denied.': 'access.denied',
  'Access denied': 'flash.access_denied',
  'Your session has expired. Please sign in again.': 'session.expired',
  'Invalid portal.': 'portal.invalid',
  'Portal not found.': 'portal.not_found',
  'This portal is disabled.': 'portal.disabled',
  'You do not have access to this portal.': 'portal.no_access',
};

function translateWithKey(tFn, key, query = {}, raw = '') {
  if (!key || typeof tFn !== 'function') return null;
  const k = String(key).trim();
  if (k === 'flash.signed_out_after_inactivity' || k.endsWith('.signed_out_after_inactivity')) {
    const minutes = parseInt(query.idleMinutes, 10) || parseInt(query.minutes, 10) || 10;
    const suffix = minutes === 1 ? '' : 's';
    return tFn('flash.signed_out_after_inactivity', {
      ns: 'errors',
      minutes,
      suffix,
      defaultValue: raw || k,
    });
  }
  const tr = tFn(k, { ns: 'errors', defaultValue: '' });
  if (tr) return tr;
  const trCommon = tFn(k, { ns: 'common', defaultValue: '' });
  if (trCommon) return trCommon;
  return null;
}

/** Decode ?msgKey= / ?msg= that may still be a locale key from older redirects. */
function translateQueryMsg(res, raw, rawKey, query = {}) {
  const tFn = res?.locals?.t;
  const key = rawKey ? String(rawKey).trim() : isLocaleKey(raw) ? String(raw).trim() : '';
  const fromKey = translateWithKey(tFn, key, query, raw);
  if (fromKey) return fromKey;
  if (!raw) return null;
  const s = String(raw).trim();
  return s || null;
}

/** Decode ?errKey= / ?err= flash and access-denied strings for the active locale. */
function translateFlashErr(res, raw, rawKey, query = {}) {
  const tFn = res?.locals?.t;
  const key = rawKey
    ? String(rawKey).trim()
    : isLocaleKey(raw)
      ? String(raw).trim()
      : FLASH_ERR_TEXT_TO_KEY[String(raw || '').trim()] || '';
  const fromKey = translateWithKey(tFn, key, query, raw);
  if (fromKey) return fromKey;
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const mapped = FLASH_ERR_TEXT_TO_KEY[s];
  if (mapped && typeof tFn === 'function') {
    return tFn(mapped, { ns: 'errors', defaultValue: s });
  }
  return s;
}

/** Legacy-namespace helper for EJS templates (`_tl('key', 'Fallback')`). */
function makeLegacyTranslator(tFn) {
  return function legacyTranslate(key, fallback, opts) {
    const o = { ns: 'legacy', defaultValue: fallback };
    if (opts && typeof opts === 'object') {
      for (const pk of Object.keys(opts)) o[pk] = opts[pk];
    }
    return typeof tFn === 'function' ? tFn(key, o) : fallback;
  };
}

function middleware() {
  return async (req, res, next) => {
    try {
      await ensureInit();
      const lang = resolveLocale(req);
      if (req.session && !req.session.lang && req.cookies?.hms_lang) {
        req.session.lang = normalizeLang(req.cookies.hms_lang);
      }
      res.locals.lang = lang;
      res.locals.locale = lang;
      res.locals.dir = 'ltr';
      res.locals.t = getFixedT(lang);
      res.locals._tl = makeLegacyTranslator(res.locals.t);
      res.locals.navLabel = (code, label) => navLabel(code, label, lang);
      const { hubLabel: hubLabelFn } = require('./hubI18n');
      res.locals.hubLabel = (code, label) => hubLabelFn(code, label, lang);
      const { roleLabel: roleLabelFn } = require('./roleI18n');
      res.locals.roleLabel = (code, title) => roleLabelFn(code, title, lang);
      const {
        deploymentProfileLabel: depProfileLabel,
        deploymentModeLabel: depModeLabel,
      } = require('./deploymentI18n');
      res.locals.deploymentProfileLabel = (name) => depProfileLabel(name, res.locals.t);
      res.locals.deploymentModeLabel = (key) => depModeLabel(key, res.locals.t);

      const _render = res.render.bind(res);
      res.render = function hmsRender(view, options, callback) {
        let opts = options;
        let cb = callback;
        if (typeof opts === 'function') {
          cb = opts;
          opts = {};
        }
        opts = opts || {};
        opts.lang = opts.lang || lang;
        opts.dir = opts.dir || 'ltr';
        opts.t = opts.t || res.locals.t;
        opts._tl = opts._tl || res.locals._tl;
        opts.pageData = enrichPageData(
          opts.pageData && typeof opts.pageData === 'object' ? opts.pageData : {},
          lang
        );
        if (cb) return _render(view, opts, cb);
        return _render(view, opts);
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

function navLabel(code, defaultLabel, lang) {
  const slug = String(code || '').replace(/\./g, '_');
  if (!slug) return defaultLabel || '';
  return t(`codes.${slug}`, lang, { ns: 'nav', defaultValue: defaultLabel || code });
}

module.exports = {
  SUPPORTED,
  DEFAULT_LANG,
  NAMESPACES,
  LOCALES_DIR,
  ensureInit,
  resolveLocale,
  normalizeLang,
  getFixedT,
  makeLegacyTranslator,
  t,
  navLabel,
  enrichPageData,
  dateLocale,
  handleSetLang,
  translateQueryMsg,
  translateFlashErr,
  getResourceBundle,
  resolveBackUrl,
  middleware,
};
