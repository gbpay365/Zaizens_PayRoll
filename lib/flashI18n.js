'use strict';

const { t, getFixedT, translateFlashErr } = require('./hmsI18n');

/** Translate a flash/redirect message key in the errors namespace. */
function flashT(res, key, opts = {}) {
  const tl = res?.locals?.t;
  if (typeof tl === 'function') {
    return tl(key, { ns: 'errors', ...opts });
  }
  const lang = res?.locals?.lang || 'en';
  return t(key, lang, { ns: 'errors', defaultValue: opts.defaultValue || key, ...opts });
}

/** Build ?err= or ?msg= redirect URL with translated text. */
function redirectFlash(res, url, field, key, opts = {}) {
  const msg = flashT(res, key, opts);
  const sep = url.includes('?') ? '&' : '?';
  const q = field === 'msg' ? 'msg' : 'err';
  return res.redirect(`${url}${sep}${q}=${encodeURIComponent(msg)}`);
}

/** Translate dynamic err.message when no mapping exists. */
function flashErr(res, url, key, err, fallbackKey) {
  const msg =
    err && err.message && !String(err.message).startsWith('errors.')
      ? err.message
      : flashT(res, fallbackKey || key, { defaultValue: err?.message || key });
  const sep = url.includes('?') ? '&' : '?';
  return res.redirect(`${url}${sep}err=${encodeURIComponent(msg)}`);
}

module.exports = {
  flashT,
  redirectFlash,
  flashErr,
  translateFlashErr,
  getFixedT,
};
