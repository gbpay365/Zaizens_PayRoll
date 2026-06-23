'use strict';

const { flashT } = require('./flashI18n');

function appErrorTitle(res) {
  const t = res?.locals?.t;
  if (typeof t === 'function') {
    return t('page.error_title', { ns: 'errors', defaultValue: 'Error' });
  }
  return 'Error';
}

function appErrorMessage(res, key, fallback, opts = {}) {
  if (key && String(key).startsWith('errors.')) {
    return flashT(res, key.replace(/^errors\./, ''), opts);
  }
  if (key) return flashT(res, key, { defaultValue: fallback, ...opts });
  return fallback || 'An error occurred.';
}

function renderAppError(res, status, messageKey, fallback, opts = {}) {
  const code = parseInt(status, 10) || 500;
  res.status(code).render('error', {
    title: appErrorTitle(res),
    message: appErrorMessage(res, messageKey, fallback, opts),
    status: code,
  });
}

module.exports = {
  appErrorTitle,
  appErrorMessage,
  renderAppError,
};
