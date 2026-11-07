'use strict';

/**
 * Minimal SMTP notifier.
 *
 * Scheduled HR maintenance must be able to tell someone it ran, but the app has
 * no mail transport of its own.  This module wraps nodemailer behind a tiny
 * interface so every caller gets the same behaviour: when SMTP is not
 * configured the message is logged and skipped instead of throwing.
 */

const nodemailer = require('nodemailer');

let cached = { key: null, transport: null };

function smtpConfig() {
  const port = parseInt(String(process.env.SMTP_PORT || '587'), 10) || 587;
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASSWORD || '').trim();
  const secure = String(process.env.SMTP_SECURE || '').trim() === '1' || port === 465;
  const from = String(process.env.SMTP_FROM || '').trim() || (user ? `Zaizens PayRoll <${user}>` : '');
  return { host, port, user, pass, secure, from };
}

function isConfigured() {
  const c = smtpConfig();
  return Boolean(c.host && c.from);
}

function transporter() {
  const c = smtpConfig();
  const key = `${c.host}:${c.port}:${c.user}:${c.secure}`;
  if (cached.transport && cached.key === key) return cached.transport;
  const transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    connectionTimeout: Math.max(2000, parseInt(process.env.SMTP_TIMEOUT_MS || '10000', 10) || 10000),
    greetingTimeout: Math.max(2000, parseInt(process.env.SMTP_TIMEOUT_MS || '10000', 10) || 10000),
  });
  cached = { key, transport };
  return transport;
}

function parseRecipients(list) {
  const raw = Array.isArray(list) ? list.join(',') : String(list || '');
  return raw
    .split(/[,;\s]+/)
    .map((value) => value.trim())
    .filter((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value));
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Send a message.  Never throws: callers get { ok, skipped, error } so a mail
 * outage cannot roll back the maintenance work that already committed.
 */
async function sendMail({ to, subject, text, html, replyTo }) {
  const recipients = parseRecipients(to);
  if (!recipients.length) return { ok: false, skipped: true, error: 'No valid recipient address.' };
  if (!isConfigured()) {
    console.log(`[mailer] SMTP not configured — skipped "${subject}" for ${recipients.join(', ')}`);
    return { ok: false, skipped: true, error: 'SMTP is not configured.' };
  }
  try {
    const c = smtpConfig();
    const info = await transporter().sendMail({
      from: c.from,
      to: recipients.join(', '),
      subject: String(subject || 'Zaizens PayRoll').slice(0, 200),
      text: String(text || ''),
      html: html || undefined,
      replyTo: replyTo || undefined,
    });
    return { ok: true, messageId: info.messageId, recipients };
  } catch (e) {
    console.warn('[mailer]', e.message);
    return { ok: false, error: e.message };
  }
}

function rowsToTable(rows, headers) {
  if (!rows.length) return '<p style="margin:0;color:#555;">No balances needed updating.</p>';
  const head = headers.map((h) => `<th align="left" style="padding:6px 10px;border-bottom:1px solid #d5ddd8;font-size:12px;text-transform:uppercase;letter-spacing:.4px;">${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td style="padding:6px 10px;border-bottom:1px solid #eef2ef;font-size:13px;">${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;">${`<thead><tr>${head}</tr></thead>`}<tbody>${body}</tbody></table>`;
}

/**
 * Daily leave maintenance digest: what was carried over and what accrued.
 */
async function sendLeaveMaintenanceSummary({ to, facilityName, year, ranAt, carryOver, accrual, errors }) {
  const carryRows = (carryOver.rows || []).slice(0, 60).map((row) => [row.employee_name, row.leave_type, row.days]);
  const accrualRows = (accrual.rows || []).slice(0, 60).map((row) => [row.employee_name, row.leave_type, row.days]);
  const subject = `Leave maintenance ${year} — ${facilityName || 'Facility'} (${carryOver.applied || 0} carried, ${accrual.updated || 0} accrued)`;
  const problemList = (errors || []).length
    ? `<p style="margin:16px 0 0;color:#a12a1f;font-size:13px;"><strong>Problems:</strong><br>${errors.map(escapeHtml).join('<br>')}</p>`
    : '';
  const text = [
    `Leave maintenance run for ${facilityName || 'facility'} — ${year}`,
    `Completed: ${ranAt || new Date().toISOString()}`,
    '',
    `Carry-over: ${carryOver.applied || 0} balance(s) carried from ${year - 1}.`,
    ...(carryOver.rows || []).slice(0, 60).map((row) => `  - ${row.employee_name}: ${row.leave_type} +${row.days}`),
    '',
    `Accrual: ${accrual.updated || 0} balance(s) updated.`,
    ...(accrual.rows || []).slice(0, 60).map((row) => `  - ${row.employee_name}: ${row.leave_type} +${row.days}`),
    ...((errors || []).length ? ['', 'Problems:', ...errors] : []),
  ].join('\n');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#1f2d26;max-width:720px;">
      <h2 style="margin:0 0 4px;font-size:18px;">Leave maintenance — ${escapeHtml(year)}</h2>
      <p style="margin:0 0 16px;color:#556;font-size:13px;">${escapeHtml(facilityName || 'Facility')} &middot; ${escapeHtml(ranAt || new Date().toISOString())}</p>
      <h3 style="margin:18px 0 6px;font-size:14px;">Carry-over from ${escapeHtml(year - 1)} — ${carryOver.applied || 0} balance(s)</h3>
      ${rowsToTable(carryRows, ['Employee', 'Leave type', 'Days'])}
      <h3 style="margin:22px 0 6px;font-size:14px;">Entitlement accrual — ${accrual.updated || 0} balance(s)</h3>
      ${rowsToTable(accrualRows, ['Employee', 'Leave type', 'Days'])}
      ${problemList}
    </div>`;
  return sendMail({ to, subject, text, html });
}

/**
 * Failure alert for a scheduled maintenance run.  Short on purpose: the HR
 * mailbox needs to know which task broke without opening the app.
 */
async function sendMaintenanceFailureAlert({ to, facilityName, year, ranAt, errors, actorName }) {
  const problems = (errors || []).map((value) => String(value || 'Unknown error'));
  const subject = `Leave maintenance failed — ${facilityName || 'Facility'} (${problems.length} problem(s))`;
  const text = [
    `Leave maintenance did not finish for ${facilityName || 'facility'} — ${year}`,
    `When: ${ranAt || new Date().toISOString()}`,
    ...(actorName ? [`Triggered by: ${actorName}`] : []),
    '',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'The maintenance log shows the last successful run for each task; the retry waits for the next scheduled attempt.',
  ].join('\n');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#1f2d26;max-width:680px;">
      <h2 style="margin:0 0 4px;font-size:18px;color:#a12a1f;">Leave maintenance failed</h2>
      <p style="margin:0 0 16px;color:#556;font-size:13px;">${escapeHtml(facilityName || 'Facility')} &middot; ${escapeHtml(year)} &middot; ${escapeHtml(ranAt || new Date().toISOString())}</p>
      <ul style="margin:0 0 16px 18px;padding:0;color:#7a1f16;font-size:13px;line-height:1.6;">
        ${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}
      </ul>
      <p style="margin:0;color:#556;font-size:12px;">Carry-over and accrual stay idempotent: the next scheduled attempt retries only what has not completed.</p>
    </div>`;
  return sendMail({ to, subject, text, html });
}

module.exports = {
  isConfigured,
  smtpConfig,
  transporter,
  sendMail,
  sendLeaveMaintenanceSummary,
  sendMaintenanceFailureAlert,
  parseRecipients,
};
