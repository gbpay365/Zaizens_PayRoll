'use strict';

/**
 * Top bar page title: drop "Portal" and product suffixes (ZAIZENS, legacy ZAIZENS).
 * e.g. "Front Desk Portal — ZAIZENS" → "Front Desk"
 */
function formatTopbarTitle(title) {
  if (title == null || title === '') return '';
  let t = String(title).trim();
  t = t.replace(/\s*[—–-]\s*(ZAIZENS|TSSF\s+HMS)\s*$/i, '');
  t = t.replace(/\s+Portal\s*$/i, '');
  return t.trim() || String(title).trim();
}

/**
 * Short user label: first name only (first token).
 * e.g. "Brigitte FrontDesk" → "Brigitte"
 */
function formatDisplayName(name) {
  if (name == null || String(name).trim() === '') return 'Staff';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return parts[0] || String(name).trim();
}

const NAV_HONORIFIC = /^(sr|sister|dr|mr|mrs|ms|miss|prof|rev)\.?$/i;

/**
 * Navbar / topbar user label: full name, skipping lone honorific-only truncation.
 * e.g. "Sr Theresia Filai" → "Theresia Filai"
 */
function formatNavDisplayName(name) {
  if (name == null || String(name).trim() === '') return 'Staff';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1 && NAV_HONORIFIC.test(parts[0])) {
    return parts.slice(1).join(' ');
  }
  return parts.join(' ');
}

module.exports = {
  formatTopbarTitle,
  formatDisplayName,
  formatNavDisplayName,
};
