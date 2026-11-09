const express = require('express');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { requireAuth, JWT_SECRET } = require('../auth');
const {
  getAuthUrl,
  exchangeCodeForTokens,
  getUserProfile,
  getDestinations,
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
    res.status(500).redirect('/dashboard#teamsAlerts?error=Failed+to+start+Microsoft+authentication');
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
    return res.redirect(`/dashboard#teamsAlerts?error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code || !state) {
    return res.redirect('/dashboard#teamsAlerts?error=Missing+code+or+state+parameter');
  }

  let decoded;
  try {
    decoded = jwt.verify(state, JWT_SECRET);
  } catch (err) {
    console.error('[teamsGraph] Invalid state token:', err.message);
    return res.redirect('/dashboard#teamsAlerts?error=Session+expired.+Please+try+connecting+again.');
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

    // 3. Discover available destinations (1-on-1 DM, group chats like 'tst', channels)
    const destinations = await getDestinations(tokenData.accessToken);
    const defaultDest = destinations[0] || {
      type: 'dm',
      id: 'me',
      teamId: null,
      rawName: 'Direct Message (Me)'
    };

    // 4. Save connection to database
    const existing = await db.getOne('SELECT id FROM teams_graph_connections WHERE user_id = ?', [userId]);
    if (existing) {
      await db.execute(`
        UPDATE teams_graph_connections SET
          ms_user_id = ?,
          ms_user_name = ?,
          ms_user_email = ?,
          access_token = ?,
          refresh_token = ?,
          token_expires_at = ?,
          destination_type = ?,
          destination_id = ?,
          destination_name = ?,
          team_id = ?,
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
        defaultDest.type,
        defaultDest.id,
        defaultDest.rawName || defaultDest.name,
        defaultDest.teamId || null,
        existing.id
      ]);
    } else {
      await db.execute(`
        INSERT INTO teams_graph_connections
          (user_id, ms_user_id, ms_user_name, ms_user_email, access_token, refresh_token, token_expires_at, destination_type, destination_id, destination_name, team_id, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `, [
        userId,
        msUserId,
        msUserName,
        msUserEmail,
        tokenData.accessToken,
        tokenData.refreshToken,
        expiresAt,
        defaultDest.type,
        defaultDest.id,
        defaultDest.rawName || defaultDest.name,
        defaultDest.teamId || null
      ]);
    }

    res.redirect('/dashboard#teamsAlerts?success=connected');
  } catch (err) {
    console.error('[teamsGraph] Callback processing failed:', err);
    res.redirect(`/dashboard#teamsAlerts?error=${encodeURIComponent(err.message || 'Failed to complete connection')}`);
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

    const result = await sendTeamsAlert({
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

    res.json({
      ok: true,
      message: `Test alert sent successfully to ${connection.destination_name}! Check your Microsoft Teams.`
    });
  } catch (err) {
    console.error('[teamsGraph] Test alert failed:', err);
    await db.execute(`
      UPDATE teams_graph_connections SET
        last_status = 'error',
        last_error = ?
      WHERE user_id = ?
    `, [err.message, req.userId]);

    res.status(500).json({ error: `Failed to send test alert: ${err.message}` });
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
