const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const { db, PLANS } = require('./db');
const { checkMany } = require('./certChecker');
const { sendExpiryAlert } = require('./mailer');

const ALERTABLE = new Set(['warning', 'critical', 'expired']);

async function resolveRecipients(row) {
  let groupId = row.group_id;
  if (!groupId) {
    const general = await db.getOne("SELECT id FROM `groups` WHERE user_id = ? AND name = 'General' LIMIT 1", [row.user_id]);
    if (general) groupId = general.id;
  }

  if (groupId) {
    const groupEmails = (await db.getAll(`
      SELECT ne.email
      FROM group_notification_emails gne
      JOIN notification_emails ne ON ne.id = gne.notification_email_id
      WHERE gne.group_id = ?
    `, [groupId])).map(r => r.email);
    if (groupEmails.length > 0) return groupEmails;
  }

  const userAlertEmails = (await db.getAll('SELECT email FROM notification_emails WHERE user_id = ?', [row.user_id])).map(r => r.email);
  if (userAlertEmails.length > 0) return userAlertEmails;

  const user = await db.getOne('SELECT email FROM users WHERE id = ?', [row.user_id]);
  return user ? [user.email] : [];
}

/**
 * Applies a fresh TLS check result to a domain row and, when appropriate,
 * fires an alert email.
 */
async function applyCheckResult(row, result) {
  const previousStatus = row.status;

  if (result.error) {
    await db.execute(`
      UPDATE domains SET
        status = 'error', issuer = NULL, valid_from = NULL,
        valid_to = NULL, days_left = NULL, last_error = ?,
        last_checked_at = NOW()
      WHERE id = ?
    `, [result.error, row.id]);
  } else {
    await db.execute(`
      UPDATE domains SET
        status = ?, issuer = ?, valid_from = ?,
        valid_to = ?, days_left = ?, last_error = ?,
        last_checked_at = NOW()
      WHERE id = ?
    `, [
      result.status,
      result.issuer || null,
      result.validFrom || null,
      result.validTo || null,
      result.daysLeft !== undefined ? result.daysLeft : null,
      result.authorized ? null : (result.authError || 'Certificate not trusted'),
      row.id
    ]);
  }

  const newStatus = result.error ? 'error' : result.status;

  if (newStatus === 'valid') {
    await db.execute('UPDATE domains SET alert_acknowledged = 0, last_alert_sent_at = NULL, status_since = NULL, consecutive_alerts = 0 WHERE id = ?', [row.id]);
    return;
  }
  if (!ALERTABLE.has(newStatus)) return;

  const statusChanged = newStatus !== previousStatus;
  if (statusChanged) {
    await db.execute('UPDATE domains SET alert_acknowledged = 0, status_since = NOW(), consecutive_alerts = 0 WHERE id = ?', [row.id]);
  }

  const state = await db.getOne(`
    SELECT d.alert_acknowledged, d.last_alert_sent_at, d.consecutive_alerts, u.plan
    FROM domains d
    JOIN users u ON u.id = d.user_id
    WHERE d.id = ?
  `, [row.id]);
  if (!state || state.alert_acknowledged) return;

  const userPlan = state.plan || 'trial';
  const planConfig = PLANS[userPlan] || PLANS.trial;

  let intervalMinutes;
  let isThrottled = false;
  let intervalText = '';

  if (newStatus === 'warning') {
    // Warnings are sent at most once every 24 hours (1440 mins)
    intervalMinutes = planConfig.warningIntervalMinutes || 1440;
    intervalText = 'This is a daily reminder (sent once every 24 hours) until you renew or acknowledge this alert.';
  } else {
    // Critical / Expired: Check auto-snooze
    const consecutive = Number(state.consecutive_alerts || 0);
    if (consecutive >= 5) {
      // Auto-snooze kicks in: throttle to 4 hours (240 minutes)
      intervalMinutes = 240;
      isThrottled = true;
      intervalText = 'This alert has triggered 5+ times without acknowledgment. Repeat notifications are auto-throttled to every 4 hours until renewed or acknowledged.';
    } else {
      intervalMinutes = planConfig.criticalIntervalMinutes || 180;
      const intervalLabel = intervalMinutes >= 60 ? `${intervalMinutes / 60} hour(s)` : `${intervalMinutes} minutes`;
      intervalText = `This is an urgent reminder — it will arrive every ${intervalLabel} until you renew the certificate or acknowledge this alert.`;
    }
  }

  const lastSentTime = state.last_alert_sent_at
    ? new Date(String(state.last_alert_sent_at).replace(' ', 'T') + 'Z').getTime()
    : null;
  const dueForAlert = statusChanged || !lastSentTime ||
    (Date.now() - lastSentTime) >= intervalMinutes * 60 * 1000;
  if (!dueForAlert) return;

  const recipients = await resolveRecipients(row);
  if (recipients.length === 0) return;

  // 1-Click Acknowledge token
  const ackSecret = process.env.JWT_SECRET || 'harisree-ssl-jwt-secret';
  const ackToken = jwt.sign({ domainId: row.id, action: 'ack' }, ackSecret, { expiresIn: '14d' });
  const appUrl = (process.env.APP_URL || 'https://sslalerts.info').replace(/\/+$/, '');
  const ackUrl = `${appUrl}/api/domains/ack-email?token=${ackToken}`;

  try {
    await sendExpiryAlert({
      to: recipients,
      hostname: row.hostname,
      daysLeft: result.daysLeft,
      status: newStatus,
      validTo: result.validTo,
      isInternal: row.source === 'internal',
      ackUrl,
      intervalText,
      isThrottled
    });
    await db.execute(`
      UPDATE domains SET
        last_alert_sent_at = NOW(),
        consecutive_alerts = consecutive_alerts + 1
      WHERE id = ?
    `, [row.id]);
    await db.execute('INSERT INTO alert_log (domain_id, user_id, status) VALUES (?, ?, ?)', [row.id, row.user_id, newStatus]);
  } catch (err) {
    console.error('[alerts] send failed for', row.hostname, err.message);
  }
}

async function runFullSweep() {
  const domains = await db.getAll(`
    SELECT d.* FROM domains d
    JOIN users u ON u.id = d.user_id
    WHERE u.plan = 'trial' OR u.billing_status = 'active'
  `);
  if (domains.length === 0) return { checked: 0 };
  const concurrency = Number(process.env.CHECK_CONCURRENCY || 10);
  let checked = 0;
  await checkMany(domains, concurrency, async (row, result) => {
    checked++;
    await applyCheckResult(row, result);
  });
  console.log(`[scheduler] daily sweep — checked ${checked} domain(s) at ${new Date().toISOString()}`);
  return { checked };
}

async function runAlertSweep() {
  const rows = await db.getAll(`
    SELECT d.* FROM domains d
    JOIN users u ON u.id = d.user_id
    WHERE d.status IN ('warning','critical','expired') AND d.alert_acknowledged = 0
      AND (u.plan = 'trial' OR u.billing_status = 'active')
  `);
  if (rows.length === 0) return { checked: 0 };
  await checkMany(rows, Number(process.env.CHECK_CONCURRENCY || 10), async (row, result) => {
    await applyCheckResult(row, result);
  });
  return { checked: rows.length };
}

async function cleanupExpiredGeneratedCertificates() {
  try {
    const info = await db.execute(`
      DELETE FROM generated_certificates
      WHERE expires_at IS NOT NULL AND expires_at <= NOW()
    `);
    if (info.affectedRows > 0) {
      console.log(`[scheduler] Cleaned up ${info.affectedRows} expired generated certificate(s)/CSR(s)`);
    }
    return info.affectedRows;
  } catch (err) {
    console.error('[scheduler] Error cleaning up expired generated certificates:', err);
    return 0;
  }
}

function startScheduler() {
  const dailyExpr = process.env.CHECK_CRON || '0 3 * * *';
  cron.schedule(dailyExpr, () => {
    runFullSweep().catch(err => console.error('[scheduler] daily sweep failed:', err));
  });
  console.log(`[scheduler] daily cert sweep scheduled: "${dailyExpr}"`);

  const alertExpr = process.env.ALERT_CHECK_CRON || '*/10 * * * *';
  cron.schedule(alertExpr, () => {
    runAlertSweep().catch(err => console.error('[scheduler] alert sweep failed:', err));
  });
  console.log(`[scheduler] repeat-alert sweep scheduled: "${alertExpr}" (evaluates per-plan interval & auto-snooze)`);

  const cleanupExpr = process.env.CERT_CLEANUP_CRON || '0 * * * *';
  cron.schedule(cleanupExpr, () => {
    cleanupExpiredGeneratedCertificates().catch(err => console.error('[scheduler] cleanup failed:', err));
  });
  console.log(`[scheduler] cert cleanup sweep scheduled: "${cleanupExpr}" (auto-purges expired certs & 1-yr CSRs)`);

  cleanupExpiredGeneratedCertificates().catch(() => {});
}

module.exports = { startScheduler, runFullSweep, runAlertSweep, applyCheckResult, cleanupExpiredGeneratedCertificates };
