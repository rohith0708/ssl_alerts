const express = require('express');
const { db, PLANS } = require('../db');
const { requireAuth } = require('../auth');
const {
  getConnectionStatus,
  getQrCode,
  sendWhatsAppAlert,
  logoutInstance
} = require('../whatsappEvolution');

const router = express.Router();

/**
 * Normalizes phone number to international E.164 without symbols
 */
function normalizePhone(raw) {
  let clean = String(raw || '').replace(/[^\d+]/g, '');
  if (!clean.startsWith('+')) clean = '+' + clean;
  return clean;
}

/**
 * GET /api/integrations/whatsapp/gateway-status
 * Checks if the Evolution API instance is paired or needs QR scan
 */
router.get('/gateway-status', requireAuth, async (req, res) => {
  try {
    const status = await getConnectionStatus();
    res.json(status);
  } catch (err) {
    console.error('[WhatsApp Route] Status error:', err);
    res.status(500).json({ connected: false, state: 'disconnected', error: err.message });
  }
});

/**
 * GET /api/integrations/whatsapp/qr
 * Returns live base64 QR code image for scanning in WhatsApp
 */
router.get('/qr', requireAuth, async (req, res) => {
  try {
    const qrData = await getQrCode();
    res.json(qrData);
  } catch (err) {
    console.error('[WhatsApp Route] QR error:', err);
    res.status(500).json({ qrcode: null, error: err.message });
  }
});

/**
 * GET /api/integrations/whatsapp/recipients
 * Returns configured WhatsApp recipients for logged-in user
 */
router.get('/recipients', requireAuth, async (req, res) => {
  try {
    const recipients = await db.getAll(`
      SELECT wr.id, wr.label, wr.phone_number, wr.is_global, wr.is_active,
             wr.last_sent_at, wr.last_status, wr.last_error, wr.created_at,
             g.name AS group_name
      FROM whatsapp_recipients wr
      LEFT JOIN \`groups\` g ON g.id = wr.group_id AND g.user_id = wr.user_id
      WHERE wr.user_id = ?
      ORDER BY wr.id DESC
    `, [req.userId]);

    res.json({ recipients });
  } catch (err) {
    console.error('[WhatsApp Route] Error fetching recipients:', err);
    res.status(500).json({ error: 'Failed to load WhatsApp recipients.' });
  }
});

/**
 * POST /api/integrations/whatsapp/recipients
 * Adds a new phone recipient
 */
router.post('/recipients', requireAuth, async (req, res) => {
  try {
    const { label, phoneNumber, phone, groupId } = req.body;
    const cleanLabel = String(label || '').trim();
    const cleanPhone = normalizePhone(phoneNumber || phone);

    if (!cleanLabel) {
      return res.status(400).json({ error: 'Please enter a label (e.g. "DevOps Phone" or "My WhatsApp").' });
    }

    const digitsOnly = cleanPhone.replace(/[^\d]/g, '');
    if (digitsOnly.length < 8 || digitsOnly.length > 15) {
      return res.status(400).json({ error: 'Please enter a valid international phone number with country code (e.g. +91 98765 43210).' });
    }

    // Check user plan recipient limits
    const user = await db.getOne('SELECT plan, is_admin FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.status(401).json({ error: 'Session expired, please sign in again.' });

    const planConfig = PLANS[user.plan] || PLANS.trial;
    const maxRecipients = user.is_admin ? 1000 : (planConfig.recipientLimit || 1);

    const countRow = await db.getOne('SELECT COUNT(*) AS n FROM whatsapp_recipients WHERE user_id = ?', [req.userId]);
    const currentCount = countRow ? countRow.n : 0;

    if (currentCount >= maxRecipients) {
      return res.status(403).json({
        error: `Your ${planConfig.label} plan allows up to ${maxRecipients} alert recipient${maxRecipients === 1 ? '' : 's'}. Upgrade your plan to add more phone numbers.`
      });
    }

    // Check for duplicate phone number for this user
    const existing = await db.getOne('SELECT id FROM whatsapp_recipients WHERE user_id = ? AND phone_number = ?', [req.userId, cleanPhone]);
    if (existing) {
      return res.status(409).json({ error: 'That phone number is already configured on your alert list.' });
    }

    const isGlobal = !groupId;
    const assignedGroupId = groupId ? Number(groupId) : null;

    const result = await db.execute(`
      INSERT INTO whatsapp_recipients (user_id, group_id, label, phone_number, is_global, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `, [req.userId, assignedGroupId, cleanLabel, cleanPhone, isGlobal ? 1 : 0]);

    res.json({
      ok: true,
      id: result.insertId,
      message: `WhatsApp recipient "${cleanLabel}" added successfully.`
    });
  } catch (err) {
    console.error('[WhatsApp Route] Add recipient error:', err);
    res.status(500).json({ error: 'Failed to add WhatsApp recipient.' });
  }
});

/**
 * POST /api/integrations/whatsapp/test
 * Sends a live test alert to verify delivery
 */
router.post('/test', requireAuth, async (req, res) => {
  try {
    const { recipientId, id, phoneNumber, phone } = req.body;
    const targetRecipientId = recipientId || id;
    let targetPhone = phoneNumber || phone;
    let targetLabel = 'Your Phone';

    if (targetRecipientId) {
      const recipient = await db.getOne('SELECT * FROM whatsapp_recipients WHERE id = ? AND user_id = ?', [targetRecipientId, req.userId]);
      if (!recipient) {
        return res.status(404).json({ error: 'WhatsApp recipient not found.' });
      }
      targetPhone = recipient.phone_number;
      targetLabel = recipient.label;
    } else if (targetPhone) {
      targetPhone = normalizePhone(targetPhone);
    } else {
      return res.status(400).json({ error: 'Recipient ID or phone number is required.' });
    }

    await sendWhatsAppAlert({
      toPhoneNumber: targetPhone,
      hostname: 'example.com',
      daysLeft: 14,
      status: 'warning',
      validTo: new Date(Date.now() + 14 * 86400000).toUTCString(),
      intervalText: 'This is a test notification verifying your WhatsApp alert integration.',
      isTest: true
    });

    if (recipientId) {
      await db.execute('UPDATE whatsapp_recipients SET last_sent_at = NOW(), last_status = "ok", last_error = NULL WHERE id = ?', [recipientId]);
    }

    await db.execute(
      'INSERT INTO alert_log (domain_id, user_id, status, channel, recipient) VALUES (NULL, ?, "test", "whatsapp", ?)',
      [req.userId, targetPhone]
    ).catch(() => {});

    res.json({
      ok: true,
      message: `Test alert sent successfully to ${targetLabel} (${targetPhone})! Check your WhatsApp.`
    });
  } catch (err) {
    console.error('[WhatsApp Route] Test alert failed:', err);
    if (req.body?.recipientId) {
      await db.execute('UPDATE whatsapp_recipients SET last_status = "error", last_error = ? WHERE id = ? AND user_id = ?', [err.message, req.body.recipientId, req.userId]).catch(() => {});
    }
    res.status(500).json({ error: `Failed to send test alert: ${err.message}` });
  }
});

/**
 * DELETE /api/integrations/whatsapp/recipients/:id
 * Removes a recipient
 */
router.delete('/recipients/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.execute('DELETE FROM whatsapp_recipients WHERE id = ? AND user_id = ?', [id, req.userId]);
    res.json({ ok: true, message: 'WhatsApp recipient removed successfully.' });
  } catch (err) {
    console.error('[WhatsApp Route] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete recipient.' });
  }
});

/**
 * PATCH /api/integrations/whatsapp/recipients/:id/toggle
 * Pauses or resumes alerts for a recipient
 */
router.patch('/recipients/:id/toggle', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const recipient = await db.getOne('SELECT id, is_active FROM whatsapp_recipients WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found.' });
    }

    const newActive = recipient.is_active ? 0 : 1;
    await db.execute('UPDATE whatsapp_recipients SET is_active = ? WHERE id = ?', [newActive, id]);
    res.json({ ok: true, isActive: newActive === 1 });
  } catch (err) {
    console.error('[WhatsApp Route] Toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle recipient status.' });
  }
});

/**
 * POST /api/integrations/whatsapp/logout
 * Logs out / resets the WhatsApp gateway session to pair a new number
 */
router.post('/logout', requireAuth, async (req, res) => {
  try {
    await logoutInstance();
    res.json({ ok: true, message: 'WhatsApp gateway disconnected. Scan QR to pair a new number.' });
  } catch (err) {
    console.error('[WhatsApp Route] Logout error:', err);
    res.status(500).json({ error: 'Failed to logout WhatsApp gateway.' });
  }
});

module.exports = router;
