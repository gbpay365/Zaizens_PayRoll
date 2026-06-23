'use strict';

const path = require('path');
const { loadEnv } = require('../lib/loadEnv');
const { migrateFromHms, parseArgs } = require('../lib/migrateFromHms');

loadEnv();

migrateFromHms(parseArgs(process.argv.slice(2)))
  .then((r) => {
    console.log('Migration complete.');
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => {
    console.error('Migration failed:', e.message || e);
    process.exit(1);
  });
