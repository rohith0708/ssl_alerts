const express = require('express');
const { db, PLANS } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { runFullSweep } = require('../scheduler');
const { sendEmailChangeOtpEmail, sendAdminCustomEmail } = require('../mailer');
const {
  getConnectionStatus,
  getQrCode,
  sendWhatsAppAlert,
  logoutInstance
} = require('../whatsappEvolution');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/stats', async (req, res) => {
  try {
    const users = await db.getAll(`
      SELECT u.id, u.name, u.email, u.plan, u.domain_limit, u.billing_status, u.is_verified, u.current_period_end, u.payment_reference, u.admin_notes, u.created_at,
             COUNT(DISTINCT d.id) AS domain_count,
             COUNT(DISTINCT g.id) AS group_count,
             COUNT(DISTINCT ne.id) AS email_recipient_count,
             COUNT(DISTINCT wr.id) AS wa_recipient_count,
             COUNT(DISTINCT tc.id) AS teams_recipient_count
      FROM users u
      LEFT JOIN domains d ON d.user_id = u.id
      LEFT JOIN \`groups\` g ON g.user_id = u.id
      LEFT JOIN notification_emails ne ON ne.user_id = u.id
      LEFT JOIN whatsapp_recipients wr ON wr.user_id = u.id
      LEFT JOIN teams_graph_connections tc ON tc.user_id = u.id
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
    const planRevenue = { trial: 0, micro: 0, starter: 0, growth: 0, pro: 0, agency: 0, enterprise: 0 };
    let totalDomains = 0;
    let totalGroups = 0;
    let haltedUsers = 0;
    let activePaidUsers = 0;
    let mrr = 0;
    let atRiskRevenue = 0;
    let totalCapacity = 0;
    let usersWithWa = 0;
    let usersWithEmail = 0;
    let usersWithTeams = 0;
    let totalWaRecipients = 0;
    let totalEmailRecipients = 0;
    let totalTeamsRecipients = 0;

    for (const u of users) {
      const planKey = (u.plan === 'unlimited') ? 'enterprise' : u.plan;
      if (byPlan[planKey] === undefined) {
        byPlan[planKey] = 0;
        planRevenue[planKey] = 0;
      }
      byPlan[planKey]++;
      totalDomains += Number(u.domain_count || 0);
      totalGroups += Number(u.group_count || 0);
      if (u.domain_limit && Number(u.domain_limit) < 100000) {
        totalCapacity += Number(u.domain_limit);
      }

      const price = PLANS[u.plan]?.price || 0;
      if (u.plan !== 'trial') {
        if (u.billing_status === 'halted') {
          haltedUsers++;
          atRiskRevenue += price;
        } else if (u.billing_status === 'active') {
          activePaidUsers++;
          mrr += price;
          planRevenue[planKey] += price;
        }
      }

      const waCount = Number(u.wa_recipient_count || 0);
      const emailCount = Number(u.email_recipient_count || 0);
      const teamsCount = Number(u.teams_recipient_count || 0);

      if (waCount > 0) {
        usersWithWa++;
        totalWaRecipients += waCount;
      }
      if (emailCount > 0) {
        usersWithEmail++;
        totalEmailRecipients += emailCount;
      }
      if (teamsCount > 0) {
        usersWithTeams++;
        totalTeamsRecipients += teamsCount;
      }
    }

    const totalUsers = users.length;
    const paidUsers = totalUsers - (byPlan.trial || 0);
    const arr = mrr * 12;
    const arpu = activePaidUsers > 0 ? Number((mrr / activePaidUsers).toFixed(2)) : 0;
    const conversionRate = totalUsers > 0 ? Number(((paidUsers / totalUsers) * 100).toFixed(1)) : 0;

    res.json({
      totalUsers,
      paidUsers,
      activePaidUsers,
      trialUsers: byPlan.trial || 0,
      haltedUsers,
      byPlan,
      planRevenue,
      totalDomains,
      totalGroups,
      totalCapacity,
      estimatedMrr: mrr,
      estimatedArr: arr,
      arpu,
      conversionRate,
      atRiskRevenue,
      channelAdoption: {
        usersWithWa,
        usersWithEmail,
        usersWithTeams,
        totalWaRecipients,
        totalEmailRecipients,
        totalTeamsRecipients
      },
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

    let whatsappRecipients = [];
    try {
      whatsappRecipients = await db.getAll(`
        SELECT id, label, phone_number, is_active, last_sent_at, last_status, created_at
        FROM whatsapp_recipients WHERE user_id = ?
        ORDER BY created_at DESC
      `, [userId]);
    } catch (_) {}

    let teamsConnections = [];
    try {
      teamsConnections = await db.getAll(`
        SELECT id, destination_name, destination_type, is_active, last_sent_at, last_status, created_at
        FROM teams_graph_connections WHERE user_id = ?
        ORDER BY created_at DESC
      `, [userId]);
    } catch (_) {}

    res.json({
      user,
      domains,
      groups,
      notificationEmails,
      whatsappRecipients,
      teamsConnections,
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

// Global Alert Log across all users with multi-channel and date filtering
router.get('/alerts', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;
    const query = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();
    const channel = (req.query.channel || '').trim();
    const startDate = (req.query.startDate || '').trim();
    const endDate = (req.query.endDate || '').trim();

    let whereClause = '1=1';
    const params = [];

    if (query) {
      whereClause += ' AND (d.hostname LIKE ? OR u.email LIKE ? OR u.name LIKE ? OR a.recipient LIKE ?)';
      const term = `%${query}%`;
      params.push(term, term, term, term);
    }

    if (status && status !== 'all') {
      whereClause += ' AND a.status = ?';
      params.push(status);
    }

    if (channel && channel !== 'all') {
      if (channel === 'email') {
        whereClause += ' AND (a.channel = "email" OR a.channel IS NULL)';
      } else {
        whereClause += ' AND a.channel = ?';
        params.push(channel);
      }
    }

    if (startDate) {
      whereClause += ' AND a.sent_at >= ?';
      params.push(startDate + ' 00:00:00');
    }

    if (endDate) {
      whereClause += ' AND a.sent_at <= ?';
      params.push(endDate + ' 23:59:59');
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
      SELECT a.id, a.status, COALESCE(a.channel, 'email') AS channel, a.recipient, a.sent_at,
             d.hostname, u.id AS user_id, u.name AS user_name, u.email AS user_email
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

// Multi-Channel Analytics (WhatsApp, Email, Teams) with Date Filtering
router.get('/channel-analytics', async (req, res) => {
  try {
    let { preset, startDate, endDate } = req.query;
    preset = preset || '7d';

    const now = new Date();
    let startStr = '';
    let endStr = '';

    if (preset === 'today') {
      const today = now.toISOString().slice(0, 10);
      startStr = `${today} 00:00:00`;
      endStr = `${today} 23:59:59`;
    } else if (preset === 'yesterday') {
      const y = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
      startStr = `${y} 00:00:00`;
      endStr = `${y} 23:59:59`;
    } else if (preset === '7d') {
      const s = new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10);
      const e = now.toISOString().slice(0, 10);
      startStr = `${s} 00:00:00`;
      endStr = `${e} 23:59:59`;
    } else if (preset === '30d') {
      const s = new Date(now.getTime() - 29 * 86400000).toISOString().slice(0, 10);
      const e = now.toISOString().slice(0, 10);
      startStr = `${s} 00:00:00`;
      endStr = `${e} 23:59:59`;
    } else if (preset === 'month') {
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      startStr = `${yyyy}-${mm}-01 00:00:00`;
      endStr = now.toISOString().slice(0, 10) + ' 23:59:59';
    } else if (preset === 'custom' && startDate && endDate) {
      startStr = `${startDate} 00:00:00`;
      endStr = `${endDate} 23:59:59`;
    } else {
      const s = new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10);
      const e = now.toISOString().slice(0, 10);
      startStr = `${s} 00:00:00`;
      endStr = `${e} 23:59:59`;
    }

    // 1. WhatsApp metrics
    const waAddedRow = await db.getOne(
      'SELECT COUNT(*) AS n FROM whatsapp_recipients WHERE created_at BETWEEN ? AND ?',
      [startStr, endStr]
    );
    const waTotalRow = await db.getOne('SELECT COUNT(*) AS n FROM whatsapp_recipients');
    const waSentRow = await db.getOne(
      'SELECT COUNT(*) AS n FROM alert_log WHERE channel = "whatsapp" AND sent_at BETWEEN ? AND ?',
      [startStr, endStr]
    );
    const waSentTotalRow = await db.getOne('SELECT COUNT(*) AS n FROM alert_log WHERE channel = "whatsapp"');

    // 2. Email metrics
    const emailAddedRow = await db.getOne(
      'SELECT COUNT(*) AS n FROM notification_emails WHERE created_at BETWEEN ? AND ?',
      [startStr, endStr]
    );
    const emailTotalRow = await db.getOne('SELECT COUNT(*) AS n FROM notification_emails');
    const emailSentRow = await db.getOne(
      'SELECT COUNT(*) AS n FROM alert_log WHERE (channel = "email" OR channel IS NULL) AND sent_at BETWEEN ? AND ?',
      [startStr, endStr]
    );
    const emailSentTotalRow = await db.getOne('SELECT COUNT(*) AS n FROM alert_log WHERE (channel = "email" OR channel IS NULL)');

    // 3. Teams metrics
    const teamsAddedRow = await db.getOne(
      'SELECT COUNT(*) AS n FROM teams_graph_connections WHERE created_at BETWEEN ? AND ?',
      [startStr, endStr]
    );
    const teamsTotalRow = await db.getOne('SELECT COUNT(*) AS n FROM teams_graph_connections');
    const teamsSentRow = await db.getOne(
      'SELECT COUNT(*) AS n FROM alert_log WHERE channel = "teams" AND sent_at BETWEEN ? AND ?',
      [startStr, endStr]
    );
    const teamsSentTotalRow = await db.getOne('SELECT COUNT(*) AS n FROM alert_log WHERE channel = "teams"');

    // 4. Daily Breakdown by Channel
    const alertsByDay = await db.getAll(`
      SELECT
        DATE_FORMAT(sent_at, '%Y-%m-%d') AS day,
        COALESCE(channel, 'email') AS channel,
        COUNT(*) AS count
      FROM alert_log
      WHERE sent_at BETWEEN ? AND ?
      GROUP BY day, channel
      ORDER BY day DESC
    `, [startStr, endStr]);

    const waAddsByDay = await db.getAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS count
      FROM whatsapp_recipients
      WHERE created_at BETWEEN ? AND ?
      GROUP BY day
    `, [startStr, endStr]);

    const emailAddsByDay = await db.getAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS count
      FROM notification_emails
      WHERE created_at BETWEEN ? AND ?
      GROUP BY day
    `, [startStr, endStr]);

    const teamsAddsByDay = await db.getAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS count
      FROM teams_graph_connections
      WHERE created_at BETWEEN ? AND ?
      GROUP BY day
    `, [startStr, endStr]);

    const dayMap = {};
    const ensureDay = (d) => {
      if (!dayMap[d]) {
        dayMap[d] = {
          date: d,
          whatsappAdded: 0,
          whatsappAlerts: 0,
          emailAdded: 0,
          emailAlerts: 0,
          teamsAdded: 0,
          teamsAlerts: 0,
          totalAlerts: 0,
          totalAdded: 0
        };
      }
    };

    alertsByDay.forEach(r => {
      ensureDay(r.day);
      if (r.channel === 'whatsapp') dayMap[r.day].whatsappAlerts += r.count;
      else if (r.channel === 'teams') dayMap[r.day].teamsAlerts += r.count;
      else dayMap[r.day].emailAlerts += r.count;
      dayMap[r.day].totalAlerts += r.count;
    });

    waAddsByDay.forEach(r => {
      ensureDay(r.day);
      dayMap[r.day].whatsappAdded += r.count;
      dayMap[r.day].totalAdded += r.count;
    });

    emailAddsByDay.forEach(r => {
      ensureDay(r.day);
      dayMap[r.day].emailAdded += r.count;
      dayMap[r.day].totalAdded += r.count;
    });

    teamsAddsByDay.forEach(r => {
      ensureDay(r.day);
      dayMap[r.day].teamsAdded += r.count;
      dayMap[r.day].totalAdded += r.count;
    });

    const dailyBreakdown = Object.values(dayMap).sort((a, b) => b.date.localeCompare(a.date));

    // 5. Recent Recipients Added in Range
    const recentRecipients = await db.getAll(`
      SELECT
        'whatsapp' AS channel,
        wr.id,
        wr.phone_number AS target,
        wr.label AS label,
        wr.is_active,
        wr.created_at,
        u.id AS user_id,
        u.name AS user_name,
        u.email AS user_email
      FROM whatsapp_recipients wr
      JOIN users u ON u.id = wr.user_id
      WHERE wr.created_at BETWEEN ? AND ?

      UNION ALL

      SELECT
        'email' AS channel,
        ne.id,
        ne.email AS target,
        'Alert Email' AS label,
        1 AS is_active,
        ne.created_at,
        u.id AS user_id,
        u.name AS user_name,
        u.email AS user_email
      FROM notification_emails ne
      JOIN users u ON u.id = ne.user_id
      WHERE ne.created_at BETWEEN ? AND ?

      UNION ALL

      SELECT
        'teams' AS channel,
        tg.id,
        tg.destination_name AS target,
        tg.destination_type AS label,
        tg.is_active,
        tg.created_at,
        u.id AS user_id,
        u.name AS user_name,
        u.email AS user_email
      FROM teams_graph_connections tg
      JOIN users u ON u.id = tg.user_id
      WHERE tg.created_at BETWEEN ? AND ?

      ORDER BY created_at DESC
      LIMIT 100
    `, [startStr, endStr, startStr, endStr, startStr, endStr]);

    res.json({
      range: {
        preset,
        startDate: startStr.slice(0, 10),
        endDate: endStr.slice(0, 10)
      },
      summary: {
        whatsapp: {
          recipientsAdded: waAddedRow ? waAddedRow.n : 0,
          totalRecipients: waTotalRow ? waTotalRow.n : 0,
          alertsSent: waSentRow ? waSentRow.n : 0,
          totalAlertsSent: waSentTotalRow ? waSentTotalRow.n : 0
        },
        email: {
          recipientsAdded: emailAddedRow ? emailAddedRow.n : 0,
          totalRecipients: emailTotalRow ? emailTotalRow.n : 0,
          alertsSent: emailSentRow ? emailSentRow.n : 0,
          totalAlertsSent: emailSentTotalRow ? emailSentTotalRow.n : 0
        },
        teams: {
          recipientsAdded: teamsAddedRow ? teamsAddedRow.n : 0,
          totalRecipients: teamsTotalRow ? teamsTotalRow.n : 0,
          alertsSent: teamsSentRow ? teamsSentRow.n : 0,
          totalAlertsSent: teamsSentTotalRow ? teamsSentTotalRow.n : 0
        },
        combined: {
          totalRecipientsAdded: (waAddedRow?.n || 0) + (emailAddedRow?.n || 0) + (teamsAddedRow?.n || 0),
          totalAlertsSent: (waSentRow?.n || 0) + (emailSentRow?.n || 0) + (teamsSentRow?.n || 0)
        }
      },
      dailyBreakdown,
      recentRecipients
    });
  } catch (err) {
    console.error('[Admin] Channel analytics error:', err);
    res.status(500).json({ error: 'Failed to calculate channel analytics: ' + err.message });
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

// ==========================================
// WhatsApp Gateway Admin Controls
// ==========================================

router.get('/whatsapp/gateway-status', async (req, res) => {
  try {
    const status = await getConnectionStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ connected: false, state: 'disconnected', error: err.message });
  }
});

router.get('/whatsapp/qr', async (req, res) => {
  try {
    const qrData = await getQrCode();
    res.json(qrData);
  } catch (err) {
    res.status(500).json({ qrcode: null, error: err.message });
  }
});

router.post('/whatsapp/logout', async (req, res) => {
  try {
    await logoutInstance();
    res.json({ ok: true, message: 'WhatsApp gateway disconnected. Scan QR to link a new number.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to logout WhatsApp gateway: ' + err.message });
  }
});

router.post('/whatsapp/test', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required.' });
    }

    await sendWhatsAppAlert({
      toPhoneNumber: phoneNumber,
      hostname: 'sslalerts.info',
      daysLeft: 7,
      status: 'warning',
      validTo: new Date(Date.now() + 7 * 86400000).toUTCString(),
      intervalText: 'This is an administrative test notification verifying WhatsApp Gateway delivery.',
      isTest: true
    });

    res.json({ ok: true, message: `Test alert dispatched to ${phoneNumber}!` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send test alert: ' + err.message });
  }
});

// ==========================================
// VISITOR & REAL-TIME ANALYTICS (TAB 6)
// ==========================================
router.get('/analytics/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 7;

    // Active in last 15 mins
    const activeVisitors = await db.getOne(`
      SELECT COUNT(DISTINCT session_id) AS n, COUNT(DISTINCT user_id) AS active_users
      FROM visitor_activity_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)
    `);

    // Today vs Period totals
    const todayStats = await db.getOne(`
      SELECT COUNT(*) AS page_views, COUNT(DISTINCT session_id) AS unique_visitors
      FROM visitor_activity_log
      WHERE created_at >= CURDATE()
    `);

    const periodStats = await db.getOne(`
      SELECT COUNT(*) AS total_views, COUNT(DISTINCT session_id) AS total_visitors
      FROM visitor_activity_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    `, [days]);

    // Top pages
    const topPages = await db.getAll(`
      SELECT path, COUNT(*) AS views, COUNT(DISTINCT session_id) AS unique_visitors
      FROM visitor_activity_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY path
      ORDER BY views DESC
      LIMIT 10
    `, [days]);

    // Traffic by day
    const trafficByDay = await db.getAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day,
             COUNT(*) AS views,
             COUNT(DISTINCT session_id) AS visitors
      FROM visitor_activity_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
      ORDER BY day ASC
    `, [days]);

    // Top Countries
    const topCountries = await db.getAll(`
      SELECT COALESCE(NULLIF(country, ''), 'Unknown') AS country, COUNT(*) AS visits
      FROM visitor_activity_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY country
      ORDER BY visits DESC
      LIMIT 8
    `, [days]);

    // Device breakdown
    const devices = await db.getAll(`
      SELECT device_type, COUNT(*) AS count
      FROM visitor_activity_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY device_type
    `, [days]);

    // Top Referrers
    const referrers = await db.getAll(`
      SELECT COALESCE(NULLIF(referrer, ''), 'Direct / Bookmark') AS ref, COUNT(*) AS count
      FROM visitor_activity_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY ref
      ORDER BY count DESC
      LIMIT 8
    `, [days]);

    // Currently Active Pages (Real-time in last 15 min)
    const activePagesNow = await db.getAll(`
      SELECT path, COUNT(DISTINCT session_id) AS active_visitors, COUNT(*) AS hits
      FROM visitor_activity_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)
      GROUP BY path
      ORDER BY active_visitors DESC
      LIMIT 6
    `);

    // Conversion Funnel & Business Intent Signals
    const funnelStats = await db.getOne(`
      SELECT 
        COUNT(DISTINCT CASE WHEN path = '/' THEN session_id END) AS landing_visitors,
        COUNT(DISTINCT CASE WHEN path LIKE '%/tools%' OR path LIKE '%/ssltools%' OR path LIKE '%/dns%' THEN session_id END) AS tools_visitors,
        COUNT(DISTINCT CASE WHEN path LIKE '%/signup%' OR path LIKE '%/register%' THEN session_id END) AS signup_intent,
        COUNT(DISTINCT CASE WHEN action_type = 'add_domain' THEN session_id END) AS domain_added_actions,
        COUNT(DISTINCT CASE WHEN path LIKE '%/account%' OR path LIKE '%/billing%' THEN session_id END) AS account_billing_visitors
      FROM visitor_activity_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    `, [days]);

    res.json({
      activeNow: activeVisitors?.n || 0,
      activeUsersNow: activeVisitors?.active_users || 0,
      todayViews: todayStats?.page_views || 0,
      todayVisitors: todayStats?.unique_visitors || 0,
      periodViews: periodStats?.total_views || 0,
      periodVisitors: periodStats?.total_visitors || 0,
      topPages,
      activePagesNow,
      funnelStats,
      trafficByDay,
      topCountries,
      devices,
      referrers
    });
  } catch (err) {
    console.error('[Admin Analytics] Overview error:', err);
    res.status(500).json({ error: 'Failed to load visitor analytics: ' + err.message });
  }
});

router.get('/analytics/feed', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

    const feed = await db.getAll(`
      SELECT val.id, val.action_type, val.path, val.country, val.device_type, val.browser,
             val.os, val.ip_address, val.metadata, val.created_at,
             u.id AS user_id, u.name AS user_name, u.email AS user_email, u.plan AS user_plan
      FROM visitor_activity_log val
      LEFT JOIN users u ON u.id = val.user_id
      ORDER BY val.id DESC
      LIMIT ?
    `, [limit]);

    res.json({ feed });
  } catch (err) {
    console.error('[Admin Analytics] Feed error:', err);
    res.status(500).json({ error: 'Failed to load live activity feed: ' + err.message });
  }
});

module.exports = router;

