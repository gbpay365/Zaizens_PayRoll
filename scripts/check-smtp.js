'use strict';

/**
 * Safe SMTP delivery check.
 *
 * Reports configuration presence, the SMTP handshake, authentication and the
 * mail server's acceptance response without printing credentials, hosts or
 * mailbox addresses. Sends one plain verification message.
 *
 * Exit codes: 0 accepted by the relay, 1 configured but failed, 2 not configured.
 */

const { loadEnv } = require('../lib/loadEnv');

loadEnv();

const mailer = require('../lib/mailer');

const SECRET_KEYS = ['SMTP_PASSWORD', 'SMTP_USER', 'SMTP_HOST', 'SMTP_FROM'];

function scrub(value) {
  let text = String(value == null ? '' : value);
  for (const key of SECRET_KEYS) {
    const secret = String(process.env[key] || '').trim();
    if (secret) text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/g, (address) => {
    const [local, domain] = address.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  });
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function line(label, value) {
  console.log(`  ${label}: ${value}`);
}

async function main() {
  const presence = {
    SMTP_HOST: Boolean(String(process.env.SMTP_HOST || '').trim()),
    SMTP_PORT: Boolean(String(process.env.SMTP_PORT || '').trim()),
    SMTP_SECURE: Boolean(String(process.env.SMTP_SECURE || '').trim()),
    SMTP_USER: Boolean(String(process.env.SMTP_USER || '').trim()),
    SMTP_PASSWORD: Boolean(String(process.env.SMTP_PASSWORD || '').trim()),
    SMTP_FROM: Boolean(String(process.env.SMTP_FROM || '').trim()),
    HR_MAINTENANCE_NOTIFY_EMAILS: Boolean(String(process.env.HR_MAINTENANCE_NOTIFY_EMAILS || '').trim()),
  };

  console.log('SMTP delivery check');
  for (const [key, set] of Object.entries(presence)) {
    line(key, set ? 'set' : 'missing');
  }

  if (!mailer.isConfigured()) {
    line('result', 'not configured — nothing sent');
    console.log('  Set SMTP_HOST and SMTP_FROM in .env (see .env.example) before running this check.');
    return 2;
  }

  const recipients = mailer.parseRecipients(
    process.env.HR_MAINTENANCE_NOTIFY_EMAILS || process.env.SMTP_FROM || ''
  );
  line('recipients', recipients.length);
  if (!recipients.length) {
    line('result', 'no valid recipient address — nothing sent');
    return 2;
  }

  const config = mailer.smtpConfig();
  const transport = mailer.transporter();

  try {
    await transport.verify();
    line('handshake + auth', 'ok');
  } catch (error) {
    line('handshake + auth', 'failed');
    line('error', scrub(error && error.message));
    return 1;
  }

  try {
    const info = await transport.sendMail({
      from: config.from,
      to: recipients.join(', '),
      subject: 'Zaizens PayRoll SMTP delivery check',
      text: 'Verification message from scripts/check-smtp.js. No action is needed.',
    });
    line('send', 'accepted by the mail server');
    if (info.messageId) line('messageId', scrub(info.messageId));
    line('accepted', (info.accepted || []).length);
    line('rejected', (info.rejected || []).length);
    if (info.response) line('response', scrub(info.response));
    return 0;
  } catch (error) {
    line('send', 'failed');
    line('error', scrub(error && error.message));
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    line('error', scrub(error && error.message));
    process.exit(1);
  });
