'use strict';

function envFlag(name, defaultValue = '0') {
  return String(process.env[name] ?? defaultValue).trim() === '1';
}

function envStr(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

function envInt(name, fallback = 1) {
  const n = parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = {
  isIntegrationEnabled() {
    return envFlag('CORE_ACCOUNT_SYNC_ENABLED', '0');
  },
  coreAccountUrl() {
    return envStr('CORE_ACCOUNT_URL', 'http://127.0.0.1:5072').replace(/\/+$/, '');
  },
  coreAccountApiKey() {
    return envStr('CORE_ACCOUNT_WEBHOOK_KEY', envStr('CORE_ACCOUNT_API_KEY', 'dev-integration-key-change-in-production'));
  },
  facilityId() {
    return envInt('CORE_ACCOUNT_FACILITY_ID', 1);
  },
  hmsInboundApiKey() {
    return envStr('HMS_INTEGRATION_API_KEY', 'dev-hms-inbound-key-change-in-production');
  },
  publicBaseUrl() {
    return envStr('PUBLIC_BASE_URL', envStr('ZAIZENS_PUBLIC_URL', '')).replace(/\/+$/, '');
  },
  hmsUrl() {
    const explicit = envStr('HMS_URL', '');
    if (explicit) return explicit.replace(/\/+$/, '');
    const port = envInt('HMS_PORT', 3003);
    return `http://127.0.0.1:${port}`;
  },
};
