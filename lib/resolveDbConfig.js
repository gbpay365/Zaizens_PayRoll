'use strict';

function nonEmpty(value) {
  const s = String(value ?? '').trim();
  return s || null;
}

function parseMysqlUrl(url, source = 'DATABASE_URL') {
  const raw = String(url || '').trim();
  if (!raw || !/^mysql:\/\//i.test(raw)) return null;
  try {
    const u = new URL(raw);
    return {
      host: u.hostname || 'localhost',
      port: parseInt(u.port || '3306', 10),
      user: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      database: (u.pathname || '/').replace(/^\//, '') || 'railway',
      source,
    };
  } catch {
    return null;
  }
}

function mysqlSslOption(host) {
  const h = String(host || '').toLowerCase();
  if (/\.railway\.internal$/i.test(h)) return false;
  if (/\.rlwy\.net$/i.test(h) || /\.proxy\.rlwy\.net$/i.test(h)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function isLocalHost(host) {
  return /localhost|127\.0\.0\.1|^::1$/i.test(String(host || '').trim());
}

function resolveDbConfig(env = process.env) {
  const fromUrl =
    parseMysqlUrl(env.DATABASE_URL, 'DATABASE_URL') ||
    parseMysqlUrl(env.MYSQL_URL, 'MYSQL_URL');

  const host =
    nonEmpty(env.DB_HOST) ||
    nonEmpty(env.MYSQLHOST) ||
    nonEmpty(env.MYSQL_HOST) ||
    (fromUrl && fromUrl.host);
  const port = parseInt(
    nonEmpty(env.DB_PORT) ||
      nonEmpty(env.MYSQLPORT) ||
      nonEmpty(env.MYSQL_PORT) ||
      (fromUrl && String(fromUrl.port)) ||
      '3306',
    10
  );
  const user =
    nonEmpty(env.DB_USER) ||
    nonEmpty(env.MYSQLUSER) ||
    nonEmpty(env.MYSQL_USER) ||
    (fromUrl && fromUrl.user);
  const password =
    env.DB_PASSWORD ??
    env.MYSQLPASSWORD ??
    env.MYSQL_PASSWORD ??
    (fromUrl && fromUrl.password) ??
    '';
  const database =
    nonEmpty(env.DB_NAME) ||
    nonEmpty(env.MYSQLDATABASE) ||
    nonEmpty(env.MYSQL_DATABASE) ||
    (fromUrl && fromUrl.database);

  const onRailway = Boolean(nonEmpty(env.RAILWAY_ENVIRONMENT));
  const resolvedHost = host || (onRailway ? '' : '127.0.0.1');
  const resolvedDb = database || (onRailway ? '' : 'zaizens_payroll');

  if (!resolvedHost || !user || !resolvedDb || isLocalHost(resolvedHost) && onRailway) {
    return {
      valid: false,
      host: resolvedHost,
      port,
      user: user || '',
      password,
      database: resolvedDb || '',
      source: fromUrl ? fromUrl.source : 'DB_* / MYSQL*',
      error:
        'MySQL is not configured for Railway. Link the MySQL plugin and set: ' +
        'DB_HOST=${{MySQL.MYSQLHOST}}, DB_PORT=${{MySQL.MYSQLPORT}}, ' +
        'DB_USER=${{MySQL.MYSQLUSER}}, DB_PASSWORD=${{MySQL.MYSQLPASSWORD}}, ' +
        'DB_NAME=${{MySQL.MYSQLDATABASE}}. Remove DB_HOST=127.0.0.1 if copied from local .env.',
    };
  }

  return {
    valid: true,
    host: resolvedHost,
    port,
    user,
    password,
    database: resolvedDb,
    ssl: mysqlSslOption(resolvedHost),
    source: fromUrl ? fromUrl.source : 'DB_* / MYSQL*',
  };
}

module.exports = { resolveDbConfig, parseMysqlUrl };
