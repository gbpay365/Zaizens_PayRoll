'use strict';

/** Password policy + login throttling settings. */

const DEFAULTS = {
  password_min_length: 8,
  password_require_digit: 1,
  password_require_upper: 0,
  force_change_on_reset: 1,
  lockout_threshold: 8,
  lockout_minutes: 15,
};

async function loadSecurityPolicy(pool) {
  try {
    const [[row]] = await pool.query('SELECT * FROM tbl_admin_security WHERE id = 1 LIMIT 1');
    if (!row) return { ...DEFAULTS };
    return {
      password_min_length: Math.max(6, Math.min(64, parseInt(row.password_min_length, 10) || DEFAULTS.password_min_length)),
      password_require_digit: Number(row.password_require_digit) ? 1 : 0,
      password_require_upper: Number(row.password_require_upper) ? 1 : 0,
      force_change_on_reset: Number(row.force_change_on_reset) ? 1 : 0,
      lockout_threshold: Math.max(3, Math.min(50, parseInt(row.lockout_threshold, 10) || DEFAULTS.lockout_threshold)),
      lockout_minutes: Math.max(1, Math.min(240, parseInt(row.lockout_minutes, 10) || DEFAULTS.lockout_minutes)),
    };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

/** Returns an error message, or null when the password satisfies the policy. */
function validatePassword(password, policy = DEFAULTS) {
  const pwd = String(password || '');
  const min = policy.password_min_length || DEFAULTS.password_min_length;
  if (pwd.length < min) return `Password must be at least ${min} characters.`;
  if (policy.password_require_digit && !/\d/.test(pwd)) return 'Password must contain at least one number.';
  if (policy.password_require_upper && !/[A-Z]/.test(pwd)) return 'Password must contain at least one uppercase letter.';
  if (/\s/.test(pwd)) return 'Password cannot contain spaces.';
  return null;
}

async function saveSecurityPolicy(pool, values, updatedBy) {
  const min = Math.max(6, Math.min(64, parseInt(values.password_min_length, 10) || DEFAULTS.password_min_length));
  const threshold = Math.max(3, Math.min(50, parseInt(values.lockout_threshold, 10) || DEFAULTS.lockout_threshold));
  const minutes = Math.max(1, Math.min(240, parseInt(values.lockout_minutes, 10) || DEFAULTS.lockout_minutes));
  await pool.query(
    `INSERT INTO tbl_admin_security
      (id, password_min_length, password_require_digit, password_require_upper,
       force_change_on_reset, lockout_threshold, lockout_minutes, updated_by)
     VALUES (1,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
      password_min_length=VALUES(password_min_length),
      password_require_digit=VALUES(password_require_digit),
      password_require_upper=VALUES(password_require_upper),
      force_change_on_reset=VALUES(force_change_on_reset),
      lockout_threshold=VALUES(lockout_threshold),
      lockout_minutes=VALUES(lockout_minutes),
      updated_by=VALUES(updated_by)`,
    [
      min,
      values.password_require_digit ? 1 : 0,
      values.password_require_upper ? 1 : 0,
      values.force_change_on_reset ? 1 : 0,
      threshold,
      minutes,
      updatedBy || null,
    ]
  );
}

module.exports = { DEFAULTS, loadSecurityPolicy, validatePassword, saveSecurityPolicy };
