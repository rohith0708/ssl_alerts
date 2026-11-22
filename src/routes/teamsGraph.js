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
 * Returns connection status, user profile, configured destinations and available groups
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const primary = await db.getOne(`
      SELECT id, ms_user_id, ms_user_name, ms_user_email,
             access_token, is_active, created_at
      FROM teams_graph_connections
      WHERE user_id = ? AND access_token IS NOT NULL AND access_token != 'webhook'
      ORDER BY id DESC LIMIT 1
    `, [req.userId]);

    if (!primary) {
      return res.json({
        connected: false,
        user: null,
        recipients: [],
        groups: []
      });
    }

    // Configured destinations for this user
    const recipients = await db.getAll(`
      SELECT t.id, t.destination_type, t.destination_id, t.destination_name, t.team_id,
             t.group_id, t.is_active, t.last_sent_at, t.last_status, t.last_error, t.created_at,
             g.name AS group_name
      FROM teams_graph_connections t
      LEFT JOIN \`groups\` g ON g.id = t.group_id AND g.user_id = t.user_id
      WHERE t.user_id = ?
      ORDER BY t.id DESC
    `, [req.userId]);

    // User's domain groups for dropdown
    const groups = await db.getAll('SELECT id, name FROM `groups` WHERE user_id = ? ORDER BY name ASC', [req.userId]);

    res.json({
      connected: true,
      user: {
        id: primary.ms_user_id,
        name: primary.ms_user_name,
        email: primary.ms_user_email
      },
      recipients: recipients || [],
      groups: groups || []
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
    const existing = await db.getOne('SELECT id FROM teams_graph_connections WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
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
 * GET /api/integrations/teams/destinations
 * Returns available chats, groups, and channels from Microsoft Graph for user to select
 */
router.get('/destinations', requireAuth, async (req, res) => {
  try {
    const connection = await db.getOne(`
      SELECT * FROM teams_graph_connections WHERE user_id = ? AND access_token IS NOT NULL AND access_token != 'webhook'
      ORDER BY id DESC LIMIT 1
    `, [req.userId]);

    if (!connection) {
      return res.status(404).json({ error: 'Microsoft Teams is not connected.' });
    }

    const { ensureValidAccessToken } = require('../microsoftGraph');
    const token = await ensureValidAccessToken(connection);
    const destinations = await getDestinations(token);

    res.json({ destinations });
  } catch (err) {
    console.error('[teamsGraph] Error loading destinations:', err);
    res.status(500).json({ error: 'Failed to retrieve Teams chats and channels: ' + err.message });
  }
});

/**
 * POST /api/integrations/teams/add-destination
 * Adds a new alert destination with optional domain group routing
 */
router.post('/add-destination', requireAuth, async (req, res) => {
  try {
    const { destinationType, destinationId, destinationName, teamId, groupId } = req.body;

    if (!destinationId) {
      return res.status(400).json({ error: 'Please select a destination from the list.' });
    }

    const primary = await db.getOne(`
      SELECT * FROM teams_graph_connections
      WHERE user_id = ? AND access_token IS NOT NULL AND access_token != 'webhook'
      ORDER BY id DESC LIMIT 1
    `, [req.userId]);

    if (!primary) {
      return res.status(400).json({ error: 'Microsoft Teams is not connected. Please connect with Microsoft first.' });
    }

    const assignedGroupId = groupId ? Number(groupId) : null;

    // Check if this destination already exists for the same group
    const existing = await db.getOne(`
      SELECT id FROM teams_graph_connections
      WHERE user_id = ? AND destination_id = ? AND (group_id <=> ?)
    `, [req.userId, destinationId, assignedGroupId]);

    if (existing) {
      return res.status(409).json({ error: 'This destination is already configured for the selected domain group.' });
    }

    const countRow = await db.getOne('SELECT COUNT(*) as n FROM teams_graph_connections WHERE user_id = ?', [req.userId]);
    const totalCount = countRow ? countRow.n : 0;

    // If there is only 1 row and it is unconfigured/placeholder (e.g. destination_id = 'me' without last_sent_at)
    if (totalCount === 1 && (primary.destination_id === 'me' && !primary.last_sent_at)) {
      await db.execute(`
        UPDATE teams_graph_connections SET
          destination_type = ?,
          destination_id = ?,
          destination_name = ?,
          team_id = ?,
          group_id = ?,
          is_active = 1,
          last_status = NULL,
          last_error = NULL
        WHERE id = ?
      `, [
        destinationType || 'chat',
        destinationId,
        destinationName || 'Teams Destination',
        teamId || null,
        assignedGroupId,
        primary.id
      ]);
    } else {
      await db.execute(`
        INSERT INTO teams_graph_connections
          (user_id, group_id, ms_user_id, ms_user_name, ms_user_email, access_token, refresh_token, token_expires_at, destination_type, destination_id, destination_name, team_id, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `, [
        req.userId,
        assignedGroupId,
        primary.ms_user_id,
        primary.ms_user_name,
        primary.ms_user_email,
        primary.access_token,
        primary.refresh_token,
        primary.token_expires_at,
        destinationType || 'chat',
        destinationId,
        destinationName || 'Teams Destination',
        teamId || null
      ]);
    }

    res.json({ ok: true, message: `Added "${destinationName || 'Teams Destination'}" to alert destinations.` });
  } catch (err) {
    console.error('[teamsGraph] Add destination error:', err);
    res.status(500).json({ error: 'Failed to add destination: ' + err.message });
  }
});

/**
 * Legacy alias for save-destination
 */
router.post('/save-destination', requireAuth, async (req, res) => {
  return router.handle({ ...req, url: '/add-destination', method: 'POST' }, res);
});

/**
 * DELETE /api/integrations/teams/destination/:id
 * Deletes a configured destination
 */
router.delete('/destination/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const dest = await db.getOne('SELECT id FROM teams_graph_connections WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!dest) {
      return res.status(404).json({ error: 'Destination not found.' });
    }

    const countRow = await db.getOne('SELECT COUNT(*) as n FROM teams_graph_connections WHERE user_id = ?', [req.userId]);
    const totalCount = countRow ? countRow.n : 0;

    if (totalCount <= 1) {
      // If it's the last destination, keep the connection tokens but reset to placeholder
      await db.execute(`
        UPDATE teams_graph_connections SET
          destination_id = 'me',
          destination_name = 'Direct Message (Me)',
          destination_type = 'dm',
          group_id = NULL,
          last_sent_at = NULL,
          last_status = NULL,
          last_error = NULL
        WHERE id = ?
      `, [id]);
    } else {
      await db.execute('DELETE FROM teams_graph_connections WHERE id = ? AND user_id = ?', [id, req.userId]);
    }

    res.json({ ok: true, message: 'Destination removed successfully.' });
  } catch (err) {
    console.error('[teamsGraph] Delete destination error:', err);
    res.status(500).json({ error: 'Failed to delete destination.' });
  }
});

/**
 * PATCH /api/integrations/teams/destination/:id/toggle
 * Enables or pauses a specific Teams destination
 */
router.patch('/destination/:id/toggle', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const dest = await db.getOne('SELECT id, is_active FROM teams_graph_connections WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!dest) {
      return res.status(404).json({ error: 'Destination not found.' });
    }

    const newActive = dest.is_active ? 0 : 1;
    await db.execute('UPDATE teams_graph_connections SET is_active = ? WHERE id = ?', [newActive, id]);

    res.json({ ok: true, isActive: newActive === 1 });
  } catch (err) {
    console.error('[teamsGraph] Toggle destination error:', err);
    res.status(500).json({ error: 'Failed to toggle destination.' });
  }
});

/**
 * POST /api/integrations/teams/test
 * Sends a live test alert to a specific Teams destination (or first active one)
 */
router.post('/test', requireAuth, async (req, res) => {
  try {
    const { id } = req.body;
    let connection;

    if (id) {
      connection = await db.getOne('SELECT * FROM teams_graph_connections WHERE id = ? AND user_id = ?', [id, req.userId]);
    } else {
      connection = await db.getOne(`
        SELECT * FROM teams_graph_connections
        WHERE user_id = ? AND destination_id != 'me' AND access_token IS NOT NULL
        ORDER BY id DESC LIMIT 1
      `, [req.userId]);
    }

    if (!connection) {
      return res.status(404).json({ error: 'No configured Teams destination found. Please add a destination first.' });
    }

    await sendTeamsAlert({
      connection,
      hostname: 'sslalerts.info',
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
      [req.userId, connection.destination_name || 'Teams Destination']
    ).catch(() => {});

    res.json({
      ok: true,
      message: `Test alert delivered successfully to ${connection.destination_name}! Check your Microsoft Teams.`
    });
  } catch (err) {
    console.error('[teamsGraph] Test alert failed:', err);
    if (req.body.id) {
      await db.execute(`
        UPDATE teams_graph_connections SET
          last_status = 'error',
          last_error = ?
        WHERE id = ? AND user_id = ?
      `, [err.message, req.body.id, req.userId]).catch(() => {});
    }

    const friendlyError = err.message.includes('valid license')
      ? 'Your Microsoft account is a personal/free account which lacks a Microsoft 365 Business license for direct Graph API messages. Please create a shared Group Chat (e.g. "tst") with an organization account and add that group here.'
      : `Failed to send test alert: ${err.message}`;

    res.status(500).json({ error: friendlyError });
  }
});

/**
 * DELETE /api/integrations/teams/disconnect
 * Disconnects Microsoft Teams integration completely (removes all destinations)
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
 * Pauses or enables all Teams alerts
 */
router.patch('/toggle', requireAuth, async (req, res) => {
  try {
    const row = await db.getOne('SELECT is_active FROM teams_graph_connections WHERE user_id = ? ORDER BY id DESC LIMIT 1', [req.userId]);
    if (!row) {
      return res.status(404).json({ error: 'Microsoft Teams is not connected.' });
    }

    const newActive = row.is_active ? 0 : 1;
    await db.execute('UPDATE teams_graph_connections SET is_active = ? WHERE user_id = ?', [newActive, req.userId]);

    res.json({ ok: true, isActive: newActive === 1 });
  } catch (err) {
    console.error('[teamsGraph] Toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle Teams alerts.' });
  }
});

module.exports = router;
