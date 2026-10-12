const nodemailer = require('nodemailer');
const { SUPPORT_EMAIL } = require('./db');

// Parses MAIL_FROM in either "Name <email@x.com>" or bare "email@x.com" form.
function parseFrom() {
  const raw = process.env.MAIL_FROM || '"SSL Alerts" <alerts@example.com>';
  const match = raw.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim() || 'SSL Alerts', email: match[2].trim() };
  return { name: 'SSL Alerts', email: raw.trim() };
}

// ---- Mailjet HTTP API — the preferred path ----
// Sends over HTTPS (port 443), which is essentially never blocked by a
// host, unlike SMTP ports (25/465/587), which providers like DigitalOcean
// block outbound by default on every new droplet to stop spam abuse. If
// SMTP keeps timing out from your server, this is why — use this instead.
function mailjetConfigured() {
  return !!(process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET);
}

async function sendViaMailjet({ to, subject, html }) {
  const from = parseFrom();
  const auth = Buffer.from(`${process.env.MAILJET_API_KEY}:${process.env.MAILJET_API_SECRET}`).toString('base64');
  const recipients = (Array.isArray(to) ? to : String(to).split(',')).map(s => s.trim()).filter(Boolean);
  if (recipients.length === 0) return;

  const messages = recipients.map(email => ({
    From: { Email: from.email, Name: from.name },
    To: [{ Email: email }],
    Subject: subject,
    HTMLPart: html
  }));

  const res = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`
    },
    body: JSON.stringify({ Messages: messages })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Mailjet API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const resData = await res.json().catch(() => null);
  if (resData && Array.isArray(resData.Messages)) {
    for (const msg of resData.Messages) {
      if (msg.Status === 'error') {
        const errDetail = (msg.Errors || []).map(e => e.ErrorMessage).join('; ');
        console.error(`[mailer:mailjet] Send error: ${errDetail}`);
      }
    }
  }
}

// ---- SMTP fallback (nodemailer) — used only if Mailjet API keys aren't set ----
function getSmtpTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined
  });
}

async function sendViaSmtp({ to, subject, html }) {
  const transport = getSmtpTransport();
  if (!transport) return;
  const from = parseFrom();
  const recipients = (Array.isArray(to) ? to : String(to).split(',')).map(s => s.trim()).filter(Boolean);
  if (recipients.length === 0) return;
  for (const email of recipients) {
    try {
      await transport.sendMail({ from: `"${from.name}" <${from.email}>`, to: email, subject, html });
    } catch (err) {
      console.error(`[mailer:smtp] Send error for ${email}:`, err.message);
    }
  }
}

const STATUS_COPY = {
  warning:  { label: 'Warning',  color: '#A8760A' },
  critical: { label: 'Critical', color: '#C6472F' },
  expired:  { label: 'Expired',  color: '#B0281F' }
};

async function sendExpiryAlert({ to, hostname, daysLeft, status, validTo, isInternal, ackUrl, intervalText, isThrottled }) {
  const canSend = mailjetConfigured() || !!process.env.SMTP_HOST;
  if (!canSend) {
    console.warn(`[mailer] No email provider configured (set MAILJET_API_KEY/SECRET or SMTP_HOST) — skipped alert for ${hostname} (${to})`);
    return;
  }

  const copy = STATUS_COPY[status] || { label: status, color: '#0A2740' };
  const isExpired = status === 'expired';
  const subject = isExpired
    ? `⚠ SSL certificate EXPIRED — ${hostname}`
    : `⚠ [${copy.label}] SSL certificate for ${hostname} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;

  const throttledBanner = isThrottled
    ? `<div style="background:#FFFBEB;border:1px solid #F59E0B;border-radius:8px;padding:12px 16px;margin:0 0 16px;color:#92400E;font-size:13px;line-height:1.5;">
        ⏱ <strong>Auto-Snoozed:</strong> This alert has triggered 5+ times without acknowledgment. Repeat notifications are now throttled to every 4 hours to protect your inbox.
       </div>`
    : '';

  const ackButton = ackUrl
    ? `<div style="margin:24px 0 16px;text-align:center;">
        <a href="${ackUrl}" style="display:inline-block;background:#1BC7B5;color:#0A2740;font-weight:700;font-size:14px;padding:12px 24px;text-decoration:none;border-radius:8px;box-shadow:0 2px 6px rgba(27,199,181,0.25);">
          ✓ Acknowledge &amp; Snooze Alert
        </a>
        <div style="font-size:12px;color:#8996A0;margin-top:6px;">1-click snooze pauses repeat alerts for this domain. No login required.</div>
       </div>`
    : '';

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#F4F7F8;padding:32px;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #E3E9EA;">
      <div style="background:#0A2740;padding:20px 24px;">
        <span style="color:#1BC7B5;font-weight:700;letter-spacing:1px;font-size:14px;">SSL ALERTS</span>
      </div>
      <div style="padding:28px 24px;">
        ${throttledBanner}
        <div style="display:inline-block;padding:4px 12px;border-radius:999px;background:${copy.color}22;color:${copy.color};font-weight:700;font-size:12px;letter-spacing:0.5px;">
          ${copy.label.toUpperCase()}
        </div>
        <h2 style="color:#0A2740;margin:16px 0 8px;font-size:20px;">${hostname}</h2>
        <p style="color:#4A5B66;font-size:14px;line-height:1.6;margin:0 0 16px;">
          ${isExpired
            ? (isInternal
                ? `This certificate has already expired. Anything relying on it is likely failing to connect right now.`
                : `This certificate has already expired. Visitors are likely seeing browser security warnings right now.`)
            : `This certificate will expire in <strong>${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong>, on ${new Date(validTo).toDateString()}.`}
        </p>
        <p style="color:#4A5B66;font-size:14px;line-height:1.6;margin:0;">
          ${intervalText || 'This is a repeat reminder — it will keep arriving until you renew the certificate or acknowledge this alert.'}
        </p>
        ${ackButton}
      </div>
      <div style="padding:16px 24px;background:#F4F7F8;color:#8996A0;font-size:12px;">
        You're receiving this because ${hostname} is being monitored in your SSL Alerts account.
        Questions? ${SUPPORT_EMAIL}
      </div>
    </div>
  </div>`;

  if (mailjetConfigured()) {
    await sendViaMailjet({ to, subject, html });
  } else {
    await sendViaSmtp({ to, subject, html });
  }
}

async function sendOtpEmail({ to, name, otp }) {
  const subject = `Your SSL Alerts verification code: ${otp}`;
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F4F7F8;padding:36px 16px;">
    <div style="max-width:500px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E3E9EA;box-shadow:0 4px 14px rgba(0,0,0,0.04);">
      <div style="background:#0A2740;padding:24px 28px;">
        <span style="color:#1BC7B5;font-weight:700;letter-spacing:1px;font-size:16px;">SSL ALERTS</span>
      </div>
      <div style="padding:32px 28px;">
        <h2 style="color:#0A2740;margin:0 0 12px;font-size:22px;font-weight:700;">Verify your email address</h2>
        <p style="color:#4A5B66;font-size:14px;line-height:1.6;margin:0 0 24px;">
          Hi ${name ? name.split(' ')[0] : 'there'},<br>
          Thank you for signing up for SSL Alerts. Use the verification code below to confirm your email and activate your account:
        </p>
        <div style="background:#F0FDF4;border:2px dashed #1BC7B5;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px;">
          <div style="font-size:12px;font-weight:700;color:#007A6C;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Your One-Time Code</div>
          <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#0A2740;font-family:monospace;">${otp}</div>
        </div>
        <p style="color:#64748B;font-size:13px;line-height:1.5;margin:0 0 8px;">
          ⏱ This code expires in <strong>15 minutes</strong>.
        </p>
        <p style="color:#94A3B8;font-size:12px;line-height:1.5;margin:0;">
          If you didn't create an account with SSL Alerts, you can safely ignore this email.
        </p>
      </div>
      <div style="padding:18px 28px;background:#F8FAFC;border-top:1px solid #E2E8F0;color:#94A3B8;font-size:12px;">
        SSL Alerts · Automated SSL Certificate Expiry Monitoring<br>
        Questions? Contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color:#1BC7B5;text-decoration:none;">${SUPPORT_EMAIL}</a>
      </div>
    </div>
  </div>`;

  console.log(`[mailer] *** VERIFICATION OTP for ${to} is: ${otp} ***`);

  const canSend = mailjetConfigured() || !!process.env.SMTP_HOST;
  if (!canSend) {
    console.warn(`[mailer] No email provider configured — OTP logged to console.`);
    return;
  }

  try {
    if (mailjetConfigured()) {
      await sendViaMailjet({ to, subject, html });
    } else {
      await sendViaSmtp({ to, subject, html });
    }
    console.log(`[mailer] Verification email successfully sent to ${to}`);
  } catch (err) {
    console.error(`[mailer] Failed to send verification email to ${to}:`, err.message);
  }
}

async function sendEmailChangeOtpEmail({ to, name, otp, oldEmail }) {
  const subject = `Verify your new SSL Alerts primary email: ${otp}`;
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F4F7F8;padding:36px 16px;">
    <div style="max-width:500px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E3E9EA;box-shadow:0 4px 14px rgba(0,0,0,0.04);">
      <div style="background:#0A2740;padding:24px 28px;">
        <span style="color:#1BC7B5;font-weight:700;letter-spacing:1px;font-size:16px;">SSL ALERTS</span>
      </div>
      <div style="padding:32px 28px;">
        <h2 style="color:#0A2740;margin:0 0 12px;font-size:22px;font-weight:700;">Confirm your new primary email</h2>
        <p style="color:#4A5B66;font-size:14px;line-height:1.6;margin:0 0 20px;">
          Hi ${name ? name.split(' ')[0] : 'there'},<br>
          An administrator has initiated a primary email change for your SSL Alerts account${oldEmail ? ` (previously <strong>${oldEmail}</strong>)` : ''} to this email address (<strong>${to}</strong>).
        </p>
        <p style="color:#4A5B66;font-size:14px;line-height:1.6;margin:0 0 24px;">
          To verify ownership of this email address and finalize the update, please provide the 6-digit verification code below:
        </p>
        <div style="background:#F0FDF4;border:2px dashed #1BC7B5;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px;">
          <div style="font-size:12px;font-weight:700;color:#007A6C;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Verification Code</div>
          <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#0A2740;font-family:monospace;">${otp}</div>
        </div>
        <p style="color:#64748B;font-size:13px;line-height:1.5;margin:0 0 8px;">
          ⏱ This code expires in <strong>15 minutes</strong>.
        </p>
        <p style="color:#94A3B8;font-size:12px;line-height:1.5;margin:0;">
          If you did not request this email change, please contact support immediately.
        </p>
      </div>
      <div style="padding:18px 28px;background:#F8FAFC;border-top:1px solid #E2E8F0;color:#94A3B8;font-size:12px;">
        SSL Alerts · Automated SSL Certificate Expiry Monitoring<br>
        Questions? Contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color:#1BC7B5;text-decoration:none;">${SUPPORT_EMAIL}</a>
      </div>
    </div>
  </div>`;

  console.log(`[mailer] *** EMAIL CHANGE OTP for ${to} is: ${otp} ***`);

  const canSend = mailjetConfigured() || !!process.env.SMTP_HOST;
  if (!canSend) {
    console.warn(`[mailer] No email provider configured — email change OTP logged to console.`);
    return;
  }

  try {
    if (mailjetConfigured()) {
      await sendViaMailjet({ to, subject, html });
    } else {
      await sendViaSmtp({ to, subject, html });
    }
    console.log(`[mailer] Email change verification sent to ${to}`);
  } catch (err) {
    console.error(`[mailer] Failed to send email change OTP to ${to}:`, err.message);
  }
}

async function sendPasswordResetOtpEmail({ to, name, otp }) {
  const subject = `Reset your SSL Alerts password: ${otp}`;
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F4F7F8;padding:36px 16px;">
    <div style="max-width:500px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E3E9EA;box-shadow:0 4px 14px rgba(0,0,0,0.04);">
      <div style="background:#0A2740;padding:24px 28px;">
        <span style="color:#1BC7B5;font-weight:700;letter-spacing:1px;font-size:16px;">SSL ALERTS</span>
      </div>
      <div style="padding:32px 28px;">
        <h2 style="color:#0A2740;margin:0 0 12px;font-size:22px;font-weight:700;">Password Reset Request</h2>
        <p style="color:#4A5B66;font-size:14px;line-height:1.6;margin:0 0 20px;">
          Hi ${name ? name.split(' ')[0] : 'there'},<br>
          We received a request to reset the password for your SSL Alerts account associated with <strong>${to}</strong>.
        </p>
        <p style="color:#4A5B66;font-size:14px;line-height:1.6;margin:0 0 24px;">
          Use the 6-digit recovery code below to proceed:
        </p>
        <div style="background:#F0FDF4;border:2px dashed #1BC7B5;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px;">
          <div style="font-size:12px;font-weight:700;color:#007A6C;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Password Reset Code</div>
          <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#0A2740;font-family:monospace;">${otp}</div>
        </div>
        <p style="color:#64748B;font-size:13px;line-height:1.5;margin:0 0 8px;">
          ⏱ This code expires in <strong>15 minutes</strong>.
        </p>
        <p style="color:#94A3B8;font-size:12px;line-height:1.5;margin:0;">
          If you did not request a password reset, you can safely ignore this email. Your current password remains secure.
        </p>
      </div>
      <div style="padding:18px 28px;background:#F8FAFC;border-top:1px solid #E2E8F0;color:#94A3B8;font-size:12px;">
        SSL Alerts · Automated SSL Certificate Expiry Monitoring<br>
        Questions? Contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color:#1BC7B5;text-decoration:none;">${SUPPORT_EMAIL}</a>
      </div>
    </div>
  </div>`;

  console.log(`[mailer] *** PASSWORD RESET OTP for ${to} is: ${otp} ***`);

  const canSend = mailjetConfigured() || !!process.env.SMTP_HOST;
  if (!canSend) {
    console.warn(`[mailer] No email provider configured — reset OTP logged to console.`);
    return;
  }

  try {
    if (mailjetConfigured()) {
      await sendViaMailjet({ to, subject, html });
    } else {
      await sendViaSmtp({ to, subject, html });
    }
    console.log(`[mailer] Password reset verification sent to ${to}`);
  } catch (err) {
    console.error(`[mailer] Failed to send password reset OTP to ${to}:`, err.message);
  }
}

module.exports = { sendExpiryAlert, sendOtpEmail, sendEmailChangeOtpEmail, sendPasswordResetOtpEmail };
