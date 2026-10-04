const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NOTIF_EMAILS = 5;

// List notification emails for the logged-in user
router.get('/emails', async (req, res) => {
  const emails = await db.getAll('SELECT id, email, created_at FROM notification_emails WHERE user_id = ? ORDER BY created_at ASC', [req.userId]);
  res.json({ emails, count: emails.length, limit: MAX_NOTIF_EMAILS });
});

// Add a notification email (up to 5)
router.post('/emails', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const countRow = await db.getOne('SELECT COUNT(*) AS count FROM notification_emails WHERE user_id = ?', [req.userId]);
  const count = countRow ? countRow.count : 0;
  if (count >= MAX_NOTIF_EMAILS) {
    return res.status(400).json({ error: `You can add up to ${MAX_NOTIF_EMAILS} alert email addresses.` });
  }

  try {
    const info = await db.execute('INSERT INTO notification_emails (user_id, email) VALUES (?, ?)', [req.userId, email]);
    const created = await db.getOne('SELECT id, email, created_at FROM notification_emails WHERE id = ? AND user_id = ?', [info.insertId, req.userId]);
    res.status(201).json({ email: created });
  } catch (err) {
    if (String(err.message).includes('Duplicate') || String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That email address is already on your alert list.' });
    }
    console.error('Error adding notification email:', err);
    res.status(500).json({ error: 'Failed to add alert email.' });
  }
});

// Delete a notification email
router.delete('/emails/:id', async (req, res) => {
  const id = Number(req.params.id);
  const info = await db.execute('DELETE FROM notification_emails WHERE id = ? AND user_id = ?', [id, req.userId]);
  if (info.affectedRows === 0) return res.status(404).json({ error: 'Email not found.' });
  res.json({ ok: true });
});

// Get all groups with their notification email routing
router.get('/groups', async (req, res) => {
  const groups = await db.getAll('SELECT id, name, created_at FROM `groups` WHERE user_id = ? ORDER BY created_at ASC', [req.userId]);
  const emails = await db.getAll('SELECT id, email, created_at FROM notification_emails WHERE user_id = ? ORDER BY created_at ASC', [req.userId]);
  const assignments = await db.getAll(`
    SELECT gne.group_id, gne.notification_email_id, ne.email
    FROM group_notification_emails gne
    JOIN notification_emails ne ON ne.id = gne.notification_email_id
    JOIN \`groups\` g ON g.id = gne.group_id
    WHERE g.user_id = ?
  `, [req.userId]);

  const groupMap = {};
  for (const g of groups) {
    groupMap[g.id] = [];
  }
  for (const a of assignments) {
    if (groupMap[a.group_id]) {
      groupMap[a.group_id].push({
        id: a.notification_email_id,
        email: a.email
      });
    }
  }

  const result = groups.map(g => ({
    id: g.id,
    name: g.name,
    assignedEmails: groupMap[g.id] || []
  }));

  res.json({ groups: result, emails, limit: MAX_NOTIF_EMAILS });
});

// Update email routing for a specific group
router.put('/groups/:groupId', async (req, res) => {
  const groupId = Number(req.params.groupId);
  const group = await db.getOne('SELECT id, name FROM `groups` WHERE id = ? AND user_id = ?', [groupId, req.userId]);
  if (!group) return res.status(404).json({ error: 'Group not found.' });

  const rawIds = req.body?.emailIds;
  if (!Array.isArray(rawIds)) {
    return res.status(400).json({ error: 'emailIds must be an array of IDs.' });
  }

  const userEmails = await db.getAll('SELECT id FROM notification_emails WHERE user_id = ?', [req.userId]);
  const userEmailIds = new Set(userEmails.map(e => e.id));
  const validIds = rawIds.map(Number).filter(id => userEmailIds.has(id));

  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM group_notification_emails WHERE group_id = ?', [groupId]);
    for (const emailId of validIds) {
      await tx.execute('INSERT IGNORE INTO group_notification_emails (group_id, notification_email_id) VALUES (?, ?)', [groupId, emailId]);
    }
  });

  res.json({ ok: true, groupId, assignedEmailIds: validIds });
});

module.exports = router;
