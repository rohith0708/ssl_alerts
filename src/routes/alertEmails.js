const express = require('express');
const { db, PLANS } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function listUserEmails(userId) {
  return await db.getAll(`
    SELECT ne.id, ne.email, ne.created_at, g.name AS group_name,
           CASE WHEN gne.group_id IS NULL THEN 1 ELSE 0 END AS is_global
    FROM notification_emails ne
    LEFT JOIN group_notification_emails gne ON gne.notification_email_id = ne.id
    LEFT JOIN \`groups\` g ON g.id = gne.group_id AND g.user_id = ne.user_id
    WHERE ne.user_id = ?
    ORDER BY ne.created_at ASC
  `, [userId]);
}

router.get('/', async (req, res) => {
  try {
    const emails = await listUserEmails(req.userId);
    res.json(emails);
  } catch (err) {
    console.error('Error fetching alert emails:', err);
    res.status(500).json({ error: 'Failed to load alert emails.' });
  }
});

router.post('/', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const isGlobal = req.body?.isGlobal !== false;
  const groupId = req.body?.groupId ? Number(req.body.groupId) : null;

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const user = await db.getOne('SELECT email, plan FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(401).json({ error: 'Session no longer valid, please sign in again.' });

  if (email === user.email.toLowerCase()) {
    return res.status(400).json({ error: 'This email is already your primary default alert email.' });
  }

  const planConfig = PLANS[user.plan] || PLANS.trial;
  const maxRecipients = planConfig.recipientLimit || 1;
  const countRow = await db.getOne('SELECT COUNT(*) AS n FROM notification_emails WHERE user_id = ?', [req.userId]);
  const currentCount = countRow ? countRow.n : 0;
  if (currentCount >= maxRecipients) {
    return res.status(403).json({
      error: `Your ${planConfig.label} plan allows up to ${maxRecipients} alert recipient${maxRecipients === 1 ? '' : 's'}. Upgrade your plan to add more team members.`
    });
  }

  const existingEmail = await db.getOne('SELECT id FROM notification_emails WHERE user_id = ? AND email = ?', [req.userId, email]);
  if (existingEmail) {
    return res.status(409).json({ error: 'That email address is already on your alert list.' });
  }

  if (!isGlobal && groupId) {
    const group = await db.getOne('SELECT id FROM `groups` WHERE id = ? AND user_id = ?', [groupId, req.userId]);
    if (!group) {
      return res.status(400).json({ error: 'Selected group was not found.' });
    }
  }

  try {
    const emailId = await db.transaction(async (tx) => {
      const info = await tx.execute('INSERT INTO notification_emails (user_id, email) VALUES (?, ?)', [req.userId, email]);
      const newId = info.insertId;
      if (!isGlobal && groupId) {
        await tx.execute('INSERT IGNORE INTO group_notification_emails (group_id, notification_email_id) VALUES (?, ?)', [groupId, newId]);
      }
      return newId;
    });

    const list = await listUserEmails(req.userId);
    const created = list.find(e => e.id === emailId);
    res.status(201).json(created || { id: emailId, email, is_global: isGlobal ? 1 : 0 });
  } catch (err) {
    if (String(err.message).includes('Duplicate') || String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That email address is already on your alert list.' });
    }
    console.error('Error adding alert email:', err);
    res.status(500).json({ error: 'Failed to add alert email.' });
  }
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const info = await db.execute('DELETE FROM notification_emails WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (info.affectedRows === 0) {
      return res.status(404).json({ error: 'Alert email not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting alert email:', err);
    res.status(500).json({ error: 'Failed to delete alert email.' });
  }
});

module.exports = router;
