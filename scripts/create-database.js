'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { loadEnv } = require('../lib/loadEnv');

loadEnv();

async function main() {
  const sqlPath = path.join(__dirname, 'create-database.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });
  await conn.query(sql);
  await conn.end();
  console.log('Database zaizens_payroll created (or already exists).');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
