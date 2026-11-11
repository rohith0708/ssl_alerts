const express = require('express');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { requireAuth, JWT_SECRET } = require('../auth');
const {
  getAuthUrl,
  exchangeCodeForTokens,
  getUserProfile,
  getDestinations,
  sendWebhookAlert,
  sendTeamsAlert
} = require('../microsoftGraph');

const router = express.Router();

/**
 * Helper to determine redirect URI dynamically
 */
function getRedirectUri(req) {
  if (process.env.MICROSOFT_REDIRECT_URI) {
    return process.env.MICROSOFT_REDIRECT_URI;
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'sslalerts.info';
  return `${protocol}://${host}/api/integrations/teams/callback`;
}

/**
 * GET /api/integrations/teams/status
 * Returns connection status for logged-in user
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const connection = await db.getOne(`
      SELECT id, ms_user_id, ms_user_name, ms_user_email,
             destination_type, destination_id, destination_name, team_id,
             is_active, last_sent_at, last_status, last_error, created_at
      FROM teams_graph_connections
      WHERE user_id = ?
      ORDER BY id DESC LIMIT 1
    `, [req.userId]);

    res.json({
      connected: !!connection,
      connection: connection || null
    });
  } catch (err) {
    console.error('[teamsGraph] Error checking status:', err);
    res.status(500).json({ error: 'Failed to load Microsoft Teams connection status.' });
  }
});

/**
 * GET /api/integrations/teams/connect
 * Redirects user to Microsoft OAuth 2.0 login
 */
router.get('/connect', requireAuth, (req, res) => {
  try {
    const redirectUri = getRedirectUri(req);
    const stateToken = jwt.sign(
      { userId: req.userId, redirectUri, ts: Date.now() },
      JWT_SECRET,
      { expiresIn: '15m' }
    );
    const authUrl = getAuthUrl(stateToken, redirectUri);
    res.redirect(authUrl);
  } catch (err) {
    console.error('[teamsGraph] Error starting OAuth:', err);
    res.status(500).redirect(`/dashboard?teams_error=${encodeURIComponent(err.message || 'Failed to start Microsoft authentication')}#teams-alerts`);
  }
});

/**
 * GET /api/integrations/teams/callback
 * Handles OAuth callback from Microsoft
 */
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('[teamsGraph] OAuth callback error:', error, error_description);
    return res.redirect(`/dashboard?teams_error=${encodeURIComponent(error_description || error)}#teams-alerts`);
  }

  if (!code || !state) {
    return res.redirect('/dashboard?teams_error=Missing+authorization+code+or+state+parameter#teams-alerts');
  }

  let decoded;
  try {
    decoded = jwt.verify(state, JWT_SECRET);
  } catch (err) {
    console.error('[teamsGraph] Invalid state token:', err.message);
    return res.redirect('/dashboard?teams_error=Session+expired.+Please+try+connecting+again.#teams-alerts');
  }

  const userId = decoded.userId;
  const redirectUri = decoded.redirectUri || getRedirectUri(req);

  try {
    // 1. Exchange code for tokens
    const tokenData = await exchangeCodeForTokens(code, redirectUri);
    const expiresAt = new Date(Date.now() + (tokenData.expiresIn * 1000));

    // 2. Fetch Microsoft user profile
    const profile = await getUserProfile(tokenData.accessToken);
    const msUserId = profile.id;
    const msUserName = profile.displayName || 'Microsoft User';
    const msUserEmail = profile.mail || profile.userPrincipalName || '';

    // 3. Immediately save connection to DB with a safe default destination
    // Saving NOW ensures the connection record exists even if destination queries have warnings
    const existing = await db.getOne('SELECT id FROM teams_graph_connections WHERE user_id = ?', [userId]);
    let connectionId;

    if (existing) {
      connectionId = existing.id;
      await db.execute(`
        UPDATE teams_graph_connections SET
          ms_user_id = ?,
          ms_user_name = ?,
          ms_user_email = ?,
          access_token = ?,
          refresh_token = ?,
          token_expires_at = ?,
          destination_type = COALESCE(destination_type, 'dm'),
          destination_id = COALESCE(destination_id, 'me'),
          destination_name = COALESCE(destination_name, 'Direct Message (Me)'),
          is_active = 1,
          last_error = NULL
        WHERE id = ?
      `, [
        msUserId,
        msUserName,
        msUserEmail,
        tokenData.accessToken,
        tokenData.refreshToken,
        expiresAt,
        existing.id
      ]);
    } else {
      const insertResult = await db.execute(`
        INSERT INTO teams_graph_connections
          (user_id, ms_user_id, ms_user_name, ms_user_email, access_token, refresh_token, token_expires_at, destination_type, destination_id, destination_name, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'dm', 'me', 'Direct Message (Me)', 1)
      `, [
        userId,
        msUserId,
        msUserName,
        msUserEmail,
        tokenData.accessToken,
        tokenData.refreshToken,
        expiresAt
      ]);
      connectionId = insertResult.insertId;
    }

    // 4. Non-fatal destination discovery: if chats or channels are accessible, attach the first valid one
    try {
      const destinations = await getDestinations(tokenData.accessToken);
      if (destinations && destinations.length > 0 && !existing) {
        const firstDest = destinations[0];
        await db.execute(`
          UPDATE teams_graph_connections SET
            destination_type = ?,
            destination_id = ?,
            destination_name = ?,
            team_id = ?
          WHERE id = ?
        `, [
          firstDest.type,
          firstDest.id,
          firstDest.rawName || firstDest.name,
          firstDest.teamId || null,
          connectionId
        ]);
      }
    } catch (destErr) {
      console.warn('[teamsGraph] Non-fatal destination discovery warning:', destErr.message);
    }

    // Redirect with query param for search parsing AND hash route
    res.redirect('/dashboard?teams_success=connected#teams-alerts');
  } catch (err) {
    console.error('[teamsGraph] Callback processing failed:', err);
    res.redirect(`/dashboard?teams_error=${encodeURIComponent(err.message || 'Failed to complete connection')}#teams-alerts`);
  }
});

/**
 * POST /api/integrations/teams/connect-webhook
 * Connects Teams channel via Incoming Webhook URL
 */
router.post('/connect-webhook', requireAuth, async (req, res) => {
  try {
    const { webhookUrl, channelName } = req.body;

    if (!webhookUrl || typeof webhookUrl !== 'string') {
      return res.status(400).json({ error: 'Please enter a valid Microsoft Teams Webhook URL.' });
    }

    const trimmedUrl = webhookUrl.trim();
    if (!trimmedUrl.startsWith('https://')) {
      return res.status(400).json({ error: 'Webhook URL must start with https://' });
    }

    const name = (channelName && channelName.trim()) || 'Teams Channel';

    // Verify webhook by sending a lightweight test card
    await sendWebhookAlert({
      webhookUrl: trimmedUrl,
      hostname: 'sslalerts.info',
      daysLeft: 14,
      status: 'warning',
      validTo: new Date(Date.now() + 14 * 86400000).toUTCString(),
      intervalText: 'This is a test notification verifying your Microsoft Teams channel connection.',
      isTest: true
    });

    // Save webhook connection in DB
    const existing = await db.getOne('SELECT id FROM teams_graph_connections WHERE user_id = ?', [req.userId]);
    const expiresFar = new Date(Date.now() + 10 * 365 * 86400000); // 10 years

    if (existing) {
      await db.execute(`
        UPDATE teams_graph_connections SET
          ms_user_id = 'webhook',
          ms_user_name = ?,
          ms_user_email = 'webhook@teams.local',
          access_token = 'webhook',
          refresh_token = 'webhook',
          token_expires_at = ?,
          destination_type = 'webhook',
          destination_id = ?,
          destination_name = ?,
          team_id = NULL,
          is_active = 1,
          last_sent_at = NOW(),
          last_status = 'ok',
          last_error = NULL
        WHERE id = ?
      `, [name, expiresFar, trimmedUrl, name, existing.id]);
    } else {
      await db.execute(`
        INSERT INTO teams_graph_connections
          (user_id, ms_user_id, ms_user_name, ms_user_email, access_token, refresh_token, token_expires_at, destination_type, destination_id, destination_name, is_active, last_sent_at, last_status)
        VALUES (?, 'webhook', ?, 'webhook@teams.local', 'webhook', 'webhook', ?, 'webhook', ?, ?, 1, NOW(), 'ok')
      `, [req.userId, name, expiresFar, trimmedUrl, name]);
    }

    res.json({ ok: true, message: `Connected successfully! A verification alert was delivered to ${name}.` });
  } catch (err) {
    console.error('[teamsGraph] Webhook connection error:', err);
    res.status(400).json({ error: err.message || 'Failed to verify Teams Webhook URL. Please check the URL and try again.' });
  }
});

/**
 * GET /api/integrations/teams/destinations
 * Returns available chats, groups, and channels for user to select
 */
router.get('/destinations', requireAuth, async (req, res) => {
  try {
    const connection = await db.getOne(`
      SELECT * FROM teams_graph_connections WHERE user_id = ?
    `, [req.userId]);

    if (!connection) {
      return res.status(404).json({ error: 'Microsoft Teams is not connected.' });
    }

    if (connection.destination_type === 'webhook') {
      return res.json({
        destinations: [{
          type: 'webhook',
          id: connection.destination_id,
          name: `📢 Webhook: ${connection.destination_name}`,
          rawName: connection.destination_name
        }],
        currentDestination: {
          type: 'webhook',
          id: connection.destination_id,
          name: connection.destination_name
        }
      });
    }

    const { ensureValidAccessToken } = require('../microsoftGraph');
    const token = await ensureValidAccessToken(connection);
    const destinations = await getDestinations(token);

    res.json({
      destinations,
      currentDestination: {
        type: connection.destination_type,
        id: connection.destination_id,
        name: connection.destination_name,
        teamId: connection.team_id
      }
    });
  } catch (err) {
    console.error('[teamsGraph] Error loading destinations:', err);
    res.status(500).json({ error: 'Failed to retrieve Teams chats and channels.' });
  }
});

/**
 * POST /api/integrations/teams/save-destination
 * Saves user-selected destination
 */
router.post('/save-destination', requireAuth, async (req, res) => {
  try {
    const { destinationType, destinationId, destinationName, teamId } = req.body;

    if (!destinationType || !destinationId) {
      return res.status(400).json({ error: 'Destination type and destination ID are required.' });
    }

    const connection = await db.getOne('SELECT id FROM teams_graph_connections WHERE user_id = ?', [req.userId]);
    if (!connection) {
      return res.status(404).json({ error: 'Microsoft Teams is not connected.' });
    }

    await db.execute(`
      UPDATE teams_graph_connections SET
        destination_type = ?,
        destination_id = ?,
        destination_name = ?,
        team_id = ?
      WHERE id = ?
    `, [
      destinationType,
      destinationId,
      destinationName || destinationId,
      teamId || null,
      connection.id
    ]);

    res.json({ ok: true, message: 'Alert destination updated successfully.' });
  } catch (err) {
    console.error('[teamsGraph] Error saving destination:', err);
    res.status(500).json({ error: 'Failed to update alert destination.' });
  }
});

/**
 * POST /api/integrations/teams/test
 * Sends a live test alert into the user's chosen chat / channel
 */
router.post('/test', requireAuth, async (req, res) => {
  try {
    const connection = await db.getOne('SELECT * FROM teams_graph_connections WHERE user_id = ?', [req.userId]);
    if (!connection) {
      return res.status(404).json({ error: 'Microsoft Teams is not connected.' });
    }

    await sendTeamsAlert({
      connection,
      hostname: 'example.com',
      daysLeft: 14,
      status: 'warning',
      validTo: new Date(Date.now() + 14 * 86400000).toUTCString(),
      intervalText: 'This is a test notification verifying your Microsoft Teams connection.',
      isTest: true
    });

    await db.execute(`
      UPDATE teams_graph_connections SET
        last_sent_at = NOW(),
        last_status = 'ok',
        last_error = NULL
      WHERE id = ?
    `, [connection.id]);

    await db.execute(
      'INSERT INTO alert_log (domain_id, user_id, status, channel, recipient) VALUES (NULL, ?, "test", "teams", ?)',
      [req.userId, connection.destination_name || 'Teams Channel']
    ).catch(() => {});

    res.json({
      ok: true,
      message: `Test alert delivered successfully to ${connection.destination_name}! Check your Microsoft Teams.`
    });
  } catch (err) {
    console.error('[teamsGraph] Test alert failed:', err);
    await db.execute(`
      UPDATE teams_graph_connections SET
        last_status = 'error',
        last_error = ?
      WHERE user_id = ?
    `, [err.message, req.userId]);

    const friendlyError = err.message.includes('valid license')
      ? 'Your Microsoft account is a personal/free account which lacks a Microsoft 365 Business license for Graph API messages. Please click Disconnect and use the Channel Webhook URL option (works completely free with zero license requirements!).'
      : `Failed to send test alert: ${err.message}`;

    res.status(500).json({ error: friendlyError });
  }
});

/**
 * DELETE /api/integrations/teams/disconnect
 * Disconnects Microsoft Teams integration
 */
router.delete('/disconnect', requireAuth, async (req, res) => {
  try {
    await db.execute('DELETE FROM teams_graph_connections WHERE user_id = ?', [req.userId]);
    res.json({ ok: true, message: 'Microsoft Teams disconnected successfully.' });
  } catch (err) {
    console.error('[teamsGraph] Disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect Microsoft Teams.' });
  }
});

/**
 * PATCH /api/integrations/teams/toggle
 * Enables or disables Teams alerts
 */
router.patch('/toggle', requireAuth, async (req, res) => {
  try {
    const connection = await db.getOne('SELECT id, is_active FROM teams_graph_connections WHERE user_id = ?', [req.userId]);
    if (!connection) {
      return res.status(404).json({ error: 'Microsoft Teams is not connected.' });
    }

    const newActive = connection.is_active ? 0 : 1;
    await db.execute('UPDATE teams_graph_connections SET is_active = ? WHERE id = ?', [newActive, connection.id]);

    res.json({ ok: true, isActive: newActive === 1 });
  } catch (err) {
    console.error('[teamsGraph] Toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle Teams alerts.' });
  }
});

module.exports = router;
