'use strict';
/** @deprecated Use routes/integrationSettings.js */
module.exports = function integrationsRoutes(app, pool, requireAuth, opts) {
  require('./integrationSettings')(app, pool, requireAuth, opts || { requireAdminOrSuper: () => {} });
};
