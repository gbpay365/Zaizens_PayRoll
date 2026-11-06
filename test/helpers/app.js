'use strict';

const express = require('express');
const { once } = require('node:events');

function makeApp(register, pool, options = {}) {
  const app = express();
  const actorId = Number(options.actorId) || 7;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = {
      user: { id: actorId, name: 'Test Admin', username: 'testadmin', role: '1' },
      facilityId: 1,
    };
    res.locals.userPerms = ['*'];
    next();
  });
  app.use((req, res, next) => {
    // Route tests assert the locals passed to a view without loading EJS.
    res.render = (view, locals = {}) => res.json({ view, locals });
    next();
  });

  const allow = (req, res, next) => next();
  register(app, pool, allow, {
    requirePayrollAccess: allow,
    requireAdminOrSuper: allow,
    requireHrSelfService: allow,
  });
  return app;
}

async function withApp(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }
}

async function request(base, path, options = {}) {
  const res = await fetch(base + path, {
    method: options.method || 'GET',
    body: options.body,
    redirect: 'manual',
    headers: options.headers,
  });
  return {
    status: res.status,
    headers: res.headers,
    text: await res.text(),
  };
}

function fakePool(handler) {
  return {
    query: async (sql, params = []) => handler(String(sql), params),
  };
}

module.exports = { makeApp, withApp, request, fakePool };
