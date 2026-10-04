const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const groups = await db.getAll(`
    SELECT g.*, COUNT(d.id) AS domain_count
    FROM \`groups\` g
    LEFT JOIN domains d ON d.group_id = g.id
    WHERE g.user_id = ?
    GROUP BY g.id
    ORDER BY g.created_at ASC
  `, [req.userId]);
  res.json({ groups });
});

router.post('/', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Group name is required.' });
  if (name.length > 40) return res.status(400).json({ error: 'Keep group names under 40 characters.' });

  try {
    const info = await db.execute('INSERT INTO `groups` (user_id, name) VALUES (?, ?)', [req.userId, name]);
    res.status(201).json({ group: { id: info.insertId, name, domain_count: 0 } });
  } catch (e) {
    if (String(e.message).includes('Duplicate') || String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'You already have a group with that name.' });
    }
    console.error('Error creating group:', e);
    res.status(500).json({ error: 'Could not create group.' });
  }
});

router.delete('/:id', async (req, res) => {
  const info = await db.execute('DELETE FROM `groups` WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (info.affectedRows === 0) return res.status(404).json({ error: 'Group not found.' });
  res.json({ ok: true });
});

module.exports = router;
