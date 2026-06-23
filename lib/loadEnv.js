'use strict';
/**
 * Load environment variables for HMS.
 * Tries .env first, then .env.production if DB_NAME is still unset (common cPanel mistake).
 */
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const prodPath = path.join(root, '.env.production');

function loadEnv() {
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
  dotenvError: r1.error && r1.error.code !== 'ENOENT' ? r1.error.message : null
 };
}

module.exports = { loadEnv, envPath, prodPath };
