const express = require('express');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const { checkDomain, checkPastedCertificate, checkCertRow } = require('../certChecker');
const { applyCheckResult } = require('../scheduler');

const router = express.Router();

// ---------------- Public 1-Click Acknowledge from Email ----------------
router.get('/ack-email', async (req, res) => {
  const token = req.query?.token;
  if (!token) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><title>Invalid Request — SSL Alerts</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F4F7F8;padding:40px 16px;text-align:center;color:#0A2740;} .card{max-width:440px;margin:40px auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #E3E9EA;box-shadow:0 4px 12px rgba(0,0,0,0.05);}</style>
      </head><body><div class="card">
        <h2 style="color:#C6472F;">Missing Token</h2>
        <p>No acknowledgment token was provided in this link.</p>
        <a href="/dashboard.html" style="display:inline-block;margin-top:16px;background:#0A2740;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Go to Dashboard</a>
      </div></body></html>
    `);
  }

  try {
    const secret = process.env.JWT_SECRET || 'harisree-ssl-jwt-secret';
    const decoded = jwt.verify(token, secret);
    if (!decoded || decoded.action !== 'ack' || !decoded.domainId) {
      throw new Error('Invalid token structure');
    }

    const domain = await db.getOne('SELECT * FROM domains WHERE id = ?', [decoded.domainId]);
    if (!domain) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><title>Not Found — SSL Alerts</title>
        <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F4F7F8;padding:40px 16px;text-align:center;color:#0A2740;} .card{max-width:440px;margin:40px auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #E3E9EA;}</style>
        </head><body><div class="card">
          <h2>Domain Not Found</h2>
          <p>This domain may have already been removed from monitoring.</p>
          <a href="/dashboard.html" style="display:inline-block;margin-top:16px;background:#0A2740;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Go to Dashboard</a>
        </div></body></html>
      `);
    }

    await db.execute('UPDATE domains SET alert_acknowledged = 1, consecutive_alerts = 0 WHERE id = ?', [domain.id]);
    await db.execute('INSERT INTO alert_log (domain_id, user_id, status) VALUES (?, ?, ?)', [domain.id, domain.user_id, 'acknowledged']);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Alert Acknowledged — SSL Alerts</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F4F7F8; margin: 0; padding: 40px 16px; color: #0A2740; text-align: center; }
          .card { max-width: 480px; margin: 40px auto; background: #ffffff; border-radius: 14px; padding: 36px 28px; border: 1px solid #E3E9EA; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
          .icon { width: 56px; height: 56px; line-height: 56px; border-radius: 50%; background: #E6FBF8; color: #0D9488; font-size: 28px; margin: 0 auto 16px; font-weight: bold; }
          h2 { margin: 0 0 12px; font-size: 22px; color: #0A2740; }
          p { color: #4A5B66; font-size: 15px; line-height: 1.6; margin: 0 0 24px; }
          .domain-badge { display: inline-block; background: #F1F5F9; border: 1px solid #CBD5E1; padding: 4px 12px; border-radius: 6px; font-family: monospace; font-size: 14px; margin-bottom: 8px; color: #1E293B; font-weight: 600; }
          .btn { display: inline-block; background: #1BC7B5; color: #0A2740; font-weight: 700; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; }
          .btn:hover { background: #16A89A; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <div class="domain-badge">${domain.hostname}</div>
          <h2>Alert Acknowledged &amp; Snoozed</h2>
          <p>Repeat notifications for <strong>${domain.hostname}</strong> have been paused. You will not receive further alerts until the certificate status changes or renews.</p>
          <a href="/dashboard.html" class="btn">Open SSL Alerts Dashboard →</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(400).send(`
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><title>Expired Link — SSL Alerts</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F4F7F8;padding:40px 16px;text-align:center;color:#0A2740;} .card{max-width:440px;margin:40px auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #E3E9EA;}</style>
      </head><body><div class="card">
        <h2 style="color:#C6472F;">Link Expired or Invalid</h2>
        <p>This 1-click acknowledgment link has expired or is invalid. Please log in to manage your domains directly.</p>
        <a href="/login.html" style="display:inline-block;margin-top:16px;background:#0A2740;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Log in to SSL Alerts</a>
      </div></body></html>
    `);
  }
});

router.use(requireAuth);

function cleanHostname(input) {
  return String(input || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

router.get('/', async (req, res) => {
  const domains = await db.getAll('SELECT * FROM domains WHERE user_id = ? ORDER BY created_at DESC', [req.userId]);
  const user = await db.getOne('SELECT domain_limit FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(401).json({ error: 'Session no longer valid, please sign in again.' });
  res.json({ domains, limit: user.domain_limit });
});

router.post('/', async (req, res) => {
  const hostname = cleanHostname(req.body?.hostname);
  const port = Number(req.body?.port) || 443;
  const label = req.body?.label || null;
  let groupId = req.body?.group_id ? Number(req.body.group_id) : null;

  if (!hostname || !hostname.includes('.')) {
    return res.status(400).json({ error: 'Enter a valid domain, e.g. example.com' });
  }

  if (!groupId) {
    return res.status(400).json({ error: 'Please choose a group for this domain.' });
  }

  const group = await db.getOne('SELECT id FROM `groups` WHERE id = ? AND user_id = ?', [groupId, req.userId]);
  if (!group) {
    return res.status(400).json({ error: 'That group does not exist.' });
  }

  const user = await db.getOne('SELECT domain_limit FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(401).json({ error: 'Session no longer valid, please sign in again.' });

  const countRow = await db.getOne('SELECT COUNT(*) AS n FROM domains WHERE user_id = ?', [req.userId]);
  const n = countRow ? countRow.n : 0;
  if (n >= user.domain_limit) {
    return res.status(403).json({
      error: `You've reached your plan limit of ${user.domain_limit} domain${user.domain_limit === 1 ? '' : 's'}. Upgrade to add more.`
    });
  }

  try {
    const info = await db.execute(`
      INSERT INTO domains (user_id, hostname, port, label, group_id) VALUES (?, ?, ?, ?, ?)
    `, [req.userId, hostname, port, label, groupId]);

    const domain = await db.getOne('SELECT * FROM domains WHERE id = ? AND user_id = ?', [info.insertId, req.userId]);
    res.status(201).json({ domain });

    // Background immediate check
    checkDomain(hostname, port)
      .then(result => applyCheckResult(domain, result))
      .catch(() => {});
  } catch (e) {
    if (String(e.message).includes('Duplicate') || String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That domain is already on your list.' });
    }
    console.error('Error adding domain:', e);
    res.status(500).json({ error: 'Could not add domain.' });
  }
});

router.post('/internal', async (req, res) => {
  const pem = String(req.body?.pem || '').trim();
  const label = String(req.body?.label || '').trim() || null;
  const groupId = req.body?.group_id ? Number(req.body.group_id) : null;

  if (!pem) return res.status(400).json({ error: 'Paste a certificate first.' });

  const parsed = checkPastedCertificate(pem);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  if (!groupId) {
    return res.status(400).json({ error: 'Please choose a group for this certificate.' });
  }

  const group = await db.getOne('SELECT id FROM `groups` WHERE id = ? AND user_id = ?', [groupId, req.userId]);
  if (!group) {
    return res.status(400).json({ error: 'That group does not exist.' });
  }

  const user = await db.getOne('SELECT domain_limit FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(401).json({ error: 'Session no longer valid, please sign in again.' });

  const countRow = await db.getOne('SELECT COUNT(*) AS n FROM domains WHERE user_id = ?', [req.userId]);
  const n = countRow ? countRow.n : 0;
  if (n >= user.domain_limit) {
    return res.status(403).json({
      error: `You've reached your plan limit of ${user.domain_limit} certificate${user.domain_limit === 1 ? '' : 's'}. Upgrade to add more.`
    });
  }

  const displayName = label || parsed.subject || 'Internal certificate';

  try {
    const info = await db.execute(`
      INSERT INTO domains (user_id, hostname, port, label, group_id, source, pem)
      VALUES (?, ?, 0, ?, ?, 'internal', ?)
    `, [req.userId, displayName, label, groupId, pem]);

    const created = await db.getOne('SELECT * FROM domains WHERE id = ? AND user_id = ?', [info.insertId, req.userId]);
    applyCheckResult(created, parsed).catch(() => {});
    res.status(201).json({ domain: created });
  } catch (e) {
    if (String(e.message).includes('Duplicate') || String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A certificate with that name is already on your list — give this one a different label.' });
    }
    console.error('Error saving internal certificate:', e);
    res.status(500).json({ error: 'Could not save that certificate.' });
  }
});

router.post('/:id/check-now', async (req, res) => {
  const domain = await db.getOne('SELECT * FROM domains WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!domain) return res.status(404).json({ error: 'Domain not found.' });

  const result = await checkCertRow(domain);
  await applyCheckResult(domain, result);
  const updated = await db.getOne('SELECT * FROM domains WHERE id = ? AND user_id = ?', [domain.id, req.userId]);
  res.json({ domain: updated });
});

router.post('/:id/acknowledge', async (req, res) => {
  const info = await db.execute('UPDATE domains SET alert_acknowledged = 1, consecutive_alerts = 0 WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (info.affectedRows === 0) return res.status(404).json({ error: 'Domain not found.' });
  const domain = await db.getOne('SELECT * FROM domains WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  res.json({ domain });
});

router.put('/:id/internal', async (req, res) => {
  const id = Number(req.params.id);
  const pem = String(req.body?.pem || '').trim();
  const label = req.body?.label !== undefined ? String(req.body.label).trim() : undefined;

  if (!pem) return res.status(400).json({ error: 'Please paste the renewed certificate (PEM).' });

  const domain = await db.getOne('SELECT * FROM domains WHERE id = ? AND user_id = ?', [id, req.userId]);
  if (!domain) return res.status(404).json({ error: 'Certificate not found.' });

  if (domain.source !== 'internal') {
    return res.status(400).json({ error: 'Only internal/pasted certificates can be manually updated. Remote TLS domains are checked automatically.' });
  }

  const parsed = checkPastedCertificate(pem);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const updatedLabel = label !== undefined ? (label || null) : domain.label;
  const newHostname = updatedLabel || parsed.subject || domain.hostname;

  try {
    await db.execute(`
      UPDATE domains SET
        pem = ?,
        label = ?,
        hostname = ?,
        alert_acknowledged = 0,
        consecutive_alerts = 0
      WHERE id = ? AND user_id = ?
    `, [pem, updatedLabel, newHostname, id, req.userId]);

    const updated = await db.getOne('SELECT * FROM domains WHERE id = ? AND user_id = ?', [id, req.userId]);
    await applyCheckResult(updated, parsed);
    const refreshed = await db.getOne('SELECT * FROM domains WHERE id = ? AND user_id = ?', [id, req.userId]);

    res.json({ ok: true, domain: refreshed });
  } catch (err) {
    console.error('Error updating internal certificate:', err);
    res.status(500).json({ error: 'Failed to update certificate.' });
  }
});

router.delete('/:id', async (req, res) => {
  const info = await db.execute('DELETE FROM domains WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (info.affectedRows === 0) return res.status(404).json({ error: 'Domain not found.' });
  res.json({ ok: true });
});

module.exports = router;
