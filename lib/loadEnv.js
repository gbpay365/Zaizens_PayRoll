'use strict';
/**
 * Load environment variables for local development.
 * On Railway, platform variables are used — never load committed .env (often has 127.0.0.1).
 */
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const prodPath = path.join(root, '.env.production');

function isRailwayRuntime(env = process.env) {
  return Boolean(
    String(env.RAILWAY_ENVIRONMENT || '').trim() ||
      String(env.RAILWAY || '').trim() === 'true' ||
      String(env.RAILWAY_PROJECT_ID || '').trim()
  );
}

function loadEnv() {
  if (isRailwayRuntime()) {
    return {
      loadedFrom: '(skipped — Railway runtime)',
      envExists: fs.existsSync(envPath),
      prodExists: fs.existsSync(prodPath),
      dotenvError: null,
    };
  }

  const r1 = dotenv.config({ path: envPath });
  let loadedFrom = fs.existsSync(envPath) ? '.env' : null;

  if (!process.env.DB_NAME && fs.existsSync(prodPath)) {
    dotenv.config({ path: prodPath });
    loadedFrom = loadedFrom || '.env.production';
  }

  return {
    loadedFrom,
    envExists: fs.existsSync(envPath),
    prodExists: fs.existsSync(prodPath),
    dotenvError: r1.error && r1.error.code !== 'ENOENT' ? r1.error.message : null,
  };
}

module.exports = { loadEnv, envPath, prodPath, isRailwayRuntime };
