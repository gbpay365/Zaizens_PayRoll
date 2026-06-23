'use strict';

const { PRODUCT_MODE_LABELS } = require('./appProductMode');

/** DB / catalog profile names → superAdmin.deployment.profiles.* keys */
const PROFILE_NAME_TO_KEY = Object.freeze({
  'Full Suite': 'full_suite',
  HMS: 'hms',
  Accounting: 'accounting',
  'Leave & Attendance': 'leave_attendance',
  Payroll: 'payroll',
  Inventory: 'inventory',
  Procurement: 'procurement',
  'Asset Management': 'assets',
  'Clinical HMS': 'hms',
  'Accounting Only': 'accounting',
  'Inventory / Catalog': 'inventory',
});

function resolveT(tOrLang, langMaybe) {
  if (typeof tOrLang === 'function') return tOrLang;
  const { t } = require('./hmsI18n');
  return (key, opts) => t(key, langMaybe || 'en', { ns: 'superAdmin', ...opts });
}

function deploymentProfileLabel(name, tOrLang, lang) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const tFn = resolveT(tOrLang, lang);
  const slug = PROFILE_NAME_TO_KEY[raw] || raw.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return tFn(`deployment.profiles.${slug}`, {
    ns: 'superAdmin',
    defaultValue: raw,
  });
}

function deploymentModeLabel(modeKey, tOrLang, lang) {
  const key = String(modeKey || '').trim();
  const tFn = resolveT(tOrLang, lang);
  return tFn(`deployment.modes.${key}`, {
    ns: 'superAdmin',
    defaultValue: PRODUCT_MODE_LABELS[key] || key || 'Full Suite',
  });
}

function joinDeploymentProfileLabels(names, tOrLang, lang, sep) {
  const glue = sep != null ? sep : ' + ';
  return (names || [])
    .map((n) => deploymentProfileLabel(n, tOrLang, lang))
    .filter(Boolean)
    .join(glue);
}

function localizeDeploymentModes(modes, tOrLang, lang) {
  return (modes || []).map((m) => ({
    ...m,
    label: deploymentModeLabel(m.key, tOrLang, lang),
  }));
}

function localizeDeploymentProfiles(profiles, tOrLang, lang) {
  return (profiles || []).map((p) => ({
    ...p,
    name: deploymentProfileLabel(p.name, tOrLang, lang),
  }));
}

module.exports = {
  PROFILE_NAME_TO_KEY,
  deploymentProfileLabel,
  deploymentModeLabel,
  joinDeploymentProfileLabels,
  localizeDeploymentModes,
  localizeDeploymentProfiles,
};
