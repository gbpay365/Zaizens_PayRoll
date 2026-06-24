'use strict';

const mysql = require('mysql2/promise');
const { resolveDbConfig } = require('./resolveDbConfig');

function createDbPool(env = process.env) {
  const cfg = resolveDbConfig(env);
  if (!cfg.valid) {
    const err = new Error(cfg.error);
    err.code = 'DB_CONFIG_INVALID';
    throw err;
  }

  const poolConfig = {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
  };
  if (cfg.ssl) poolConfig.ssl = cfg.ssl;

  console.log(
    `[db] mysql → ${cfg.host}:${cfg.port}/${cfg.database} (${cfg.source}) ssl=${cfg.ssl ? 'on' : 'off'}`
  );
  return mysql.createPool(poolConfig);
}

module.exports = { createDbPool, resolveDbConfig };
