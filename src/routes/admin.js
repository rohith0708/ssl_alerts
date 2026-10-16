const express = require('express');
const { db, PLANS } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { runFullSweep } = require('../scheduler');
const { sendEmailChangeOtpEmail, sendAdminCustomEmail } = require('../mailer');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/stats', async (req, res) => {
  try {
    const users = await db.getAll(`
      SELECT u.id, u.name, u.email, u.plan, u.domain_limit, u.billing_status, u.is_verified, u.current_period_end, u.payment_reference, u.admin_notes, u.created_at,
             COUNT(DISTINCT d.id) AS domain_count,
             COUNT(DISTINCT g.id) AS group_count
      FROM users u
      LEFT JOIN domains d ON d.user_id = u.id
      LEFT JOIN \`groups\` g ON g.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    const emailsToday = await db.getOne(`
      SELECT COUNT(*) AS n FROM alert_log WHERE DATE(sent_at) = CURDATE()
    `);

    const emailsByDay = await db.getAll(`
      SELECT DATE_FORMAT(sent_at, '%Y-%m-%d') AS day, COUNT(*) AS n
      FROM alert_log
      WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
      GROUP BY DATE_FORMAT(sent_at, '%Y-%m-%d')
      ORDER BY day DESC
    `);

    const staleUnacknowledged = await db.getAll(`
      SELECT d.hostname, d.status, d.status_since, d.days_left, u.email AS user_email, u.name AS user_name
      FROM domains d
      JOIN users u ON u.id = d.user_id
      WHERE d.status IN ('warning','critical','expired')
        AND d.alert_acknowledged = 0
        AND d.status_since IS NOT NULL
        AND d.status_since <= DATE_SUB(NOW(), INTERVAL 1 DAY)
      ORDER BY d.status_since ASC
    `);

    const byPlan = { trial: 0, micro: 0, starter: 0, growth: 0, pro: 0, agency: 0, enterprise: 0 };
    let totalDomains = 0;
    let totalGroups = 0;
    let haltedUsers = 0;
    let mrr = 0;

    for (const u of users) {
      const planKey = (u.plan === 'unlimited') ? 'enterprise' : u.plan;
      if (byPlan[planKey] === undefined) byPlan[planKey] = 0;
      byPlan[planKey]++;
      totalDomains += Number(u.domain_count || 0);
      totalGroups += Number(u.group_count || 0);
      if (u.plan !== 'trial' && u.billing_status === 'halted') haltedUsers++;
      if (u.billing_status === 'active') mrr += (PLANS[u.plan]?.price || 0);
    }

    res.json({
      totalUsers: users.length,
      paidUsers: users.length - (byPlan.trial || 0),
      haltedUsers,
      byPlan,
      totalDomains,
      totalGroups,
      estimatedMrr: mrr,
      emailsSentToday: emailsToday ? emailsToday.n : 0,
      emailsByDay,
      staleUnacknowledged,
      users
    });
  } catch (err) {
    console.error('Error fetching admin stats:', err);
    res.status(500).json({ error: 'Failed to load admin stats.' });
  }
});

router.get('/users/:id/details', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  try {
    const user = await db.getOne(`
      SELECT id, name, email, plan, domain_limit, billing_status, is_admin, is_verified,
             pending_email, payment_reference, admin_notes, current_period_end, created_at
      FROM users WHERE id = ?
    `, [userId]);

    if (!user) return res.status(404).json({ error: 'User not found' });

    const domains = await db.getAll(`
      SELECT id, hostname, port, label, source, status, issuer, valid_to, days_left, last_checked_at, created_at
      FROM domains WHERE user_id = ?
      ORDER BY created_at DESC
    `, [userId]);

    const groups = await db.getAll(`
      SELECT g.id, g.name, g.created_at, COUNT(d.id) AS domain_count
      FROM \`groups\` g
      LEFT JOIN domains d ON d.group_id = g.id
      WHERE g.user_id = ?
      GROUP BY g.id
    `, [userId]);

    const notificationEmails = await db.getAll(`
      SELECT id, email, created_at FROM notification_emails WHERE user_id = ?
    `, [userId]);

    const alertCountRow = await db.getOne(`
      SELECT COUNT(*) AS n FROM alert_log WHERE user_id = ?
    `, [userId]);
    const totalAlertsSent = alertCountRow ? alertCountRow.n : 0;

    const recentAlerts = await db.getAll(`
      SELECT a.id, a.status, a.sent_at, d.hostname
      FROM alert_log a
      LEFT JOIN domains d ON d.id = a.domain_id
      WHERE a.user_id = ?
      ORDER BY a.sent_at DESC
      LIMIT 25
    `, [userId]);

    const certCountRow = await db.getOne(`
      SELECT COUNT(*) AS n FROM generated_certificates WHERE user_id = ?
    `, [userId]);
    const totalGeneratedCerts = certCountRow ? certCountRow.n : 0;

    const generatedCertificates = await db.getAll(`
      SELECT id, type, domain, status, expires_at, created_at
      FROM generated_certificates
      WHERE user_id = ?
      ORDER BY created_at DESC
    `, [userId]);

    let adminEmails = [];
    try {
      adminEmails = await db.getAll(`
        SELECT l.id, l.recipient_email, l.subject, l.message_body, l.status, l.sent_at,
               a.name AS admin_name, a.email AS admin_email
        FROM admin_email_log l
        LEFT JOIN users a ON a.id = l.admin_id
        WHERE l.user_id = ?
        ORDER BY l.sent_at DESC
        LIMIT 25
      `, [userId]);
    } catch (_) {}

    res.json({
      user,
      domains,
      groups,
      notificationEmails,
      totalAlertsSent,
      recentAlerts,
      totalGeneratedCerts,
      generatedCertificates,
      adminEmails
    });
  } catch (err) {
    console.error('Error fetching user drilldown details:', err);
    res.status(500).json({ error: 'Failed to load user details.' });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const user = await db.getOne('SELECT id, plan FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { plan, billing_status, domain_limit, payment_reference, admin_notes } = req.body;
    const updates = [];
    const params = [];

    if (plan && PLANS[plan]) {
      updates.push('plan = ?');
      params.push(plan);
      if (domain_limit === undefined) {
        updates.push('domain_limit = ?');
        params.push(PLANS[plan].domainLimit || 100000);
      }
    }

    if (domain_limit !== undefined) {
      const limit = parseInt(domain_limit, 10);
      if (!isNaN(limit) && limit >= 0) {
        updates.push('domain_limit = ?');
        params.push(Math.min(limit, 2147483647));
      }
    }

    if (billing_status && ['active', 'halted'].includes(billing_status)) {
      updates.push('billing_status = ?');
      params.push(billing_status);
    }

    if (payment_reference !== undefined) {
      updates.push('payment_reference = ?');
      params.push(payment_reference ? String(payment_reference).trim() : null);
    }

    if (admin_notes !== undefined) {
      updates.push('admin_notes = ?');
      params.push(admin_notes ? String(admin_notes).trim() : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    params.push(userId);
    await db.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    const updated = await db.getOne('SELECT id, name, email, plan, domain_limit, billing_status, payment_reference, admin_notes FROM users WHERE id = ?', [userId]);
    res.json({ success: true, user: updated });
  } catch (err) {
    console.error('Error updating user plan/status in admin:', err);
    res.status(500).json({ error: err.message || 'Failed to update user' });
  }
});

// Admin initiated email change - Request with OTP
router.post('/users/:id/request-email-change', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const user = await db.getOne('SELECT id, name, email FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { new_email } = req.body || {};
    if (!new_email || typeof new_email !== 'string') {
      return res.status(400).json({ error: 'New email address is required.' });
    }

    const normalizedEmail = new_email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (normalizedEmail === user.email.toLowerCase()) {
      return res.status(400).json({ error: 'New email is identical to the current primary email.' });
    }

    const existing = await db.getOne('SELECT id FROM users WHERE email = ? AND id != ?', [normalizedEmail, userId]);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    await db.execute(`
      UPDATE users SET
        pending_email = ?,
        pending_email_otp = ?,
        pending_email_expires_at = ?
      WHERE id = ?
    `, [normalizedEmail, otp, expiresAt, userId]);

    await sendEmailChangeOtpEmail({
      to: normalizedEmail,
      name: user.name,
      otp,
      oldEmail: user.email
    });

    const responseData = {
      success: true,
      pending_email: normalizedEmail,
      message: `A 6-digit verification code has been dispatched to ${normalizedEmail}.`
    };
    if (process.env.ALLOW_DEV_OTP === 'true' && process.env.NODE_ENV === 'test') {
      responseData.devOtp = otp;
    }
    res.json(responseData);
  } catch (err) {
    console.error('Error requesting email change:', err);
    res.status(500).json({ error: err.message || 'Failed to initiate email change.' });
  }
});

// Admin confirms email change with OTP
router.post('/users/:id/confirm-email-change', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const user = await db.getOne('SELECT id, name, email, pending_email, pending_email_otp, pending_email_expires_at FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { otp } = req.body || {};
    if (!otp) {
      return res.status(400).json({ error: 'Verification code is required.' });
    }

    if (!user.pending_email || !user.pending_email_otp) {
      return res.status(400).json({ error: 'No pending email change request found for this user.' });
    }

    const now = new Date();
    const expiresAt = new Date(user.pending_email_expires_at);
    if (now > expiresAt) {
      return res.status(400).json({ error: 'Verification code has expired. Please send a new code.' });
    }

    if (String(user.pending_email_otp).trim() !== String(otp).trim()) {
      return res.status(400).json({ error: 'Invalid verification code. Please check the code and try again.' });
    }

    const collision = await db.getOne('SELECT id FROM users WHERE email = ? AND id != ?', [user.pending_email, userId]);
    if (collision) {
      return res.status(409).json({ error: 'This email is already in use by another user.' });
    }

    const newEmail = user.pending_email;
    const oldEmail = user.email;

    await db.execute(`
      UPDATE users SET
        email = ?,
        pending_email = NULL,
        pending_email_otp = NULL,
        pending_email_expires_at = NULL
      WHERE id = ?
    `, [newEmail, userId]);

    // Update notification_emails if old email was present
    await db.execute(`
      UPDATE notification_emails SET email = ? WHERE user_id = ? AND email = ?
    `, [newEmail, userId, oldEmail]);

    res.json({
      success: true,
      new_email: newEmail,
      message: `Primary email successfully updated to ${newEmail}.`
    });
  } catch (err) {
    console.error('Error confirming email change:', err);
    res.status(500).json({ error: err.message || 'Failed to update email.' });
  }
});

// Admin resends email change OTP
router.post('/users/:id/resend-email-otp', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const user = await db.getOne('SELECT id, name, email, pending_email FROM users WHERE id = ?', [userId]);
    if (!user || !user.pending_email) {
      return res.status(400).json({ error: 'No pending email change to resend code for.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    await db.execute(`
      UPDATE users SET pending_email_otp = ?, pending_email_expires_at = ? WHERE id = ?
    `, [otp, expiresAt, userId]);

    await sendEmailChangeOtpEmail({
      to: user.pending_email,
      name: user.name,
      otp,
      oldEmail: user.email
    });

    const responseData = {
      success: true,
      pending_email: user.pending_email,
      message: `A fresh 6-digit verification code has been dispatched to ${user.pending_email}.`
    };
    if (process.env.ALLOW_DEV_OTP === 'true' && process.env.NODE_ENV === 'test') {
      responseData.devOtp = otp;
    }
    res.json(responseData);
  } catch (err) {
    console.error('Error resending email OTP:', err);
    res.status(500).json({ error: err.message || 'Failed to resend verification code.' });
  }
});

// 1-Click Cancel Subscription
router.post('/users/:id/cancel-subscription', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const user = await db.getOne('SELECT id, plan FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await db.execute(`
      UPDATE users SET
        plan = 'trial',
        domain_limit = ?,
        billing_status = 'active',
        stripe_customer_id = NULL,
        razorpay_subscription_id = NULL,
        current_period_end = NULL
      WHERE id = ?
    `, [PLANS.trial.domainLimit, userId]);

    const updated = await db.getOne('SELECT id, name, email, plan, domain_limit, billing_status FROM users WHERE id = ?', [userId]);
    res.json({ success: true, message: `Subscription cancelled. User reverted to Free Trial (30 Days) (${PLANS.trial.domainLimit} domains).`, user: updated });
  } catch (err) {
    console.error('Error cancelling subscription:', err);
    res.status(500).json({ error: err.message || 'Failed to cancel subscription.' });
  }
});

// Delete user account & cascade all data
router.delete('/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const user = await db.getOne('SELECT id, email, is_admin FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const rootAdminEmail = (process.env.ADMIN_EMAIL || 'admin@sslalerts.info').toLowerCase();
    if (user.email.toLowerCase() === rootAdminEmail || user.is_admin === 1) {
      return res.status(403).json({ error: 'Cannot delete an administrator account.' });
    }
    if (user.id === req.userId) {
      return res.status(403).json({ error: 'Cannot delete your own administrator session.' });
    }

    // Atomic cascade delete
    await db.execute('DELETE FROM users WHERE id = ?', [userId]);

    res.json({
      success: true,
      message: `Account for ${user.email} and all associated data permanently deleted.`
    });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: err.message || 'Failed to delete user.' });
  }
});

// Global Certificates Explorer across all users
router.get('/certificates', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;
    const query = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();

    let whereClause = '1=1';
    const params = [];

    if (query) {
      whereClause += ' AND (d.hostname LIKE ? OR u.email LIKE ? OR u.name LIKE ? OR d.issuer LIKE ?)';
      const term = `%${query}%`;
      params.push(term, term, term, term);
    }

    if (status && status !== 'all') {
      whereClause += ' AND d.status = ?';
      params.push(status);
    }

    const countRow = await db.getOne(`
      SELECT COUNT(*) AS total
      FROM domains d
      JOIN users u ON u.id = d.user_id
      WHERE ${whereClause}
    `, params);
    const total = countRow ? countRow.total : 0;

    const certs = await db.getAll(`
      SELECT d.id, d.hostname, d.port, d.label, d.status, d.issuer, d.valid_to, d.days_left, d.last_checked_at, d.created_at,
             u.id AS user_id, u.name AS user_name, u.email AS user_email, u.plan AS user_plan
      FROM domains d
      JOIN users u ON u.id = d.user_id
      WHERE ${whereClause}
      ORDER BY 
        CASE 
          WHEN d.status = 'expired' THEN 1
          WHEN d.status = 'critical' THEN 2
          WHEN d.status = 'warning' THEN 3
          WHEN d.status = 'error' THEN 4
          ELSE 5
        END,
        d.days_left ASC,
        d.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({
      certs,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Error in /certificates:', err);
    res.status(500).json({ error: 'Failed to fetch global certificates' });
  }
});

// Global Alert Log across all users
router.get('/alerts', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;
    const query = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();

    let whereClause = '1=1';
    const params = [];

    if (query) {
      whereClause += ' AND (d.hostname LIKE ? OR u.email LIKE ? OR u.name LIKE ?)';
      const term = `%${query}%`;
      params.push(term, term, term);
    }

    if (status && status !== 'all') {
      whereClause += ' AND a.status = ?';
      params.push(status);
    }

    const countRow = await db.getOne(`
      SELECT COUNT(*) AS total
      FROM alert_log a
      LEFT JOIN domains d ON d.id = a.domain_id
      JOIN users u ON u.id = a.user_id
      WHERE ${whereClause}
    `, params);
    const total = countRow ? countRow.total : 0;

    const alerts = await db.getAll(`
      SELECT a.id, a.status, a.sent_at, d.hostname, u.id AS user_id, u.name AS user_name, u.email AS user_email
      FROM alert_log a
      LEFT JOIN domains d ON d.id = a.domain_id
      JOIN users u ON u.id = a.user_id
      WHERE ${whereClause}
      ORDER BY a.sent_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({
      alerts,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Error in /alerts:', err);
    res.status(500).json({ error: 'Failed to fetch alert log' });
  }
});

// System and Database Health
router.get('/system-health', async (req, res) => {
  try {
    const uptimeSeconds = Math.floor(process.uptime());
    const mem = process.memoryUsage();

    const t0 = Date.now();
    await db.getOne('SELECT 1 AS alive');
    const dbLatencyMs = Date.now() - t0;

    const tableCounts = await db.getOne(`
      SELECT 
        (SELECT COUNT(*) FROM users) AS users_count,
        (SELECT COUNT(*) FROM domains) AS domains_count,
        (SELECT COUNT(*) FROM alert_log) AS alerts_count,
        (SELECT COUNT(*) FROM generated_certificates) AS certs_count
    `);

    res.json({
      status: 'operational',
      uptimeSeconds,
      nodeVersion: process.version,
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024)
      },
      db: {
        status: 'connected',
        latencyMs: dbLatencyMs,
        counts: tableCounts
      },
      scheduler: {
        interval: 'Every 5 minutes',
        realertWindowMinutes: 30
      }
    });
  } catch (err) {
    console.error('Error in /system-health:', err);
    res.status(500).json({ error: 'Failed to fetch system health' });
  }
});

router.post('/run-sweep', async (req, res) => {
  const result = await runFullSweep();
  res.json(result);
});

router.post('/run-alert-sweep', async (req, res) => {
  const { runAlertSweep } = require('../scheduler');
  const result = await runAlertSweep();
  res.json(result);
});

// Admin Custom Email to User
router.post('/users/:id/send-email', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  const { subject, messageBody, senderName } = req.body;

  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ error: 'Subject is required.' });
  }
  if (!messageBody || typeof messageBody !== 'string' || !messageBody.trim()) {
    return res.status(400).json({ error: 'Email message content is required.' });
  }

  const cleanSubject = subject.trim();
  const cleanBody = messageBody.trim();

  if (cleanSubject.length > 200) {
    return res.status(400).json({ error: 'Subject cannot exceed 200 characters.' });
  }
  if (cleanBody.length > 10000) {
    return res.status(400).json({ error: 'Message content cannot exceed 10,000 characters.' });
  }

  try {
    const user = await db.getOne('SELECT id, name, email FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Send the custom email via Mailjet or SMTP
    await sendAdminCustomEmail({
      to: user.email,
      recipientName: user.name,
      subject: cleanSubject,
      messageBody: cleanBody,
      senderName: senderName ? String(senderName).trim().slice(0, 50) : 'SSL Alerts Support'
    });

    // Record in admin_email_log
    const result = await db.execute(`
      INSERT INTO admin_email_log (admin_id, user_id, recipient_email, subject, message_body, status)
      VALUES (?, ?, ?, ?, ?, 'sent')
    `, [req.userId, user.id, user.email, cleanSubject, cleanBody]);

    res.json({
      success: true,
      message: `Email successfully sent to ${user.email}`,
      logId: result ? result.insertId : null
    });
  } catch (err) {
    console.error('Error sending admin custom email:', err);
    res.status(500).json({ error: 'Failed to send email: ' + (err.message || 'Internal server error') });
  }
});

router.get('/users/:id/emails', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  try {
    const emails = await db.getAll(`
      SELECT l.id, l.recipient_email, l.subject, l.message_body, l.status, l.sent_at,
             a.name AS admin_name, a.email AS admin_email
      FROM admin_email_log l
      LEFT JOIN users a ON a.id = l.admin_id
      WHERE l.user_id = ?
      ORDER BY l.sent_at DESC
      LIMIT 50
    `, [userId]);

    res.json({ emails });
  } catch (err) {
    console.error('Error fetching user email history:', err);
    res.status(500).json({ error: 'Failed to load user email history.' });
  }
});

module.exports = router;

