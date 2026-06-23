'use strict';

/** Document title for res.render() — uses session locale via res.locals.t. */
function pageTitle(res, key, fallback, opts = {}) {
  const tFn = res?.locals?.t;
  if (typeof tFn === 'function') {
    return tFn(key, { ns: 'common', defaultValue: fallback, ...opts });
  }
  return fallback;
}

module.exports = { pageTitle };
