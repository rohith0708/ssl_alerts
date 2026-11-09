const { db } = require('./db');

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '2ebae323-7d11-433c-a355-a42118999a07';
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || '';
const DEFAULT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || 'https://sslalerts.info/api/integrations/teams/callback';

const SCOPES = [
  'offline_access',
  'User.Read',
  'ChatMessage.Send',
  'ChannelMessage.Send',
  'Chat.ReadBasic'
].join(' ');

/**
 * Generates Microsoft OAuth 2.0 Authorization URL
 */
function getAuthUrl(state, redirectUri) {
  const uri = redirectUri || DEFAULT_REDIRECT_URI;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: uri,
    response_mode: 'query',
    scope: SCOPES,
    state: state || '',
    prompt: 'select_account'
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Exchanges authorization code for access and refresh tokens
 */
async function exchangeCodeForTokens(code, redirectUri) {
  if (!CLIENT_ID) {
    throw new Error('MICROSOFT_CLIENT_ID is not configured on the server.');
  }
  if (!CLIENT_SECRET) {
    throw new Error('MICROSOFT_CLIENT_SECRET is missing from server .env file. Please add your Azure Secret Value to /opt/harisree-ssl-alerts/.env and restart.');
  }

  const uri = redirectUri || DEFAULT_REDIRECT_URI;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: uri,
    grant_type: 'authorization_code'
  });

  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Failed to exchange authorization code for tokens');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in // seconds
  };
}

/**
 * Refreshes an expired access token using the refresh token
 */
async function refreshAccessToken(refreshToken) {
  if (!CLIENT_SECRET) {
    throw new Error('MICROSOFT_CLIENT_SECRET is missing from server .env file.');
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Failed to refresh Microsoft Graph access token');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in
  };
}

/**
 * Ensures connection has an active, valid access token.
 * Refreshes automatically if within 5 minutes of expiration.
 */
async function ensureValidAccessToken(connection) {
  // Webhook-based connections do not need Graph tokens
  if (connection.destination_type === 'webhook' || connection.access_token === 'webhook') {
    return 'webhook';
  }

  const expiresAt = new Date(connection.token_expires_at).getTime();
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;

  if (now < expiresAt - fiveMinutes && connection.access_token) {
    return connection.access_token;
  }

  // Need refresh
  const refreshed = await refreshAccessToken(connection.refresh_token);
  const newExpiresAt = new Date(Date.now() + (refreshed.expiresIn * 1000));

  await db.execute(`
    UPDATE teams_graph_connections SET
      access_token = ?,
      refresh_token = ?,
      token_expires_at = ?
    WHERE id = ?
  `, [
    refreshed.accessToken,
    refreshed.refreshToken,
    newExpiresAt,
    connection.id
  ]);

  connection.access_token = refreshed.accessToken;
  connection.refresh_token = refreshed.refreshToken;
  connection.token_expires_at = newExpiresAt;

  return refreshed.accessToken;
}

/**
 * Retrieves the current Microsoft user profile
 */
async function getUserProfile(accessToken) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to fetch user profile (${res.status}): ${errText || res.statusText}`);
  }
  return await res.json();
}

/**
 * Lists available destinations: 1-on-1 DMs, group chats (e.g. "tst"), and team channels
 */
async function getDestinations(accessToken) {
  const destinations = [];

  // 1. Fetch user's chats (1-on-1 and Group chats)
  // Note: Omit $expand=members because Chat.ReadBasic does not have permission to expand members
  try {
    const resChats = await fetch('https://graph.microsoft.com/v1.0/me/chats?$top=50', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (resChats.ok) {
      const dataChats = await resChats.json();
      const chats = dataChats.value || [];

      for (const chat of chats) {
        if (chat.chatType === 'group') {
          const name = chat.topic || 'Group Chat';
          destinations.push({
            type: 'chat',
            id: chat.id,
            teamId: null,
            name: `👥 Group Chat: ${name}`,
            rawName: name
          });
        } else if (chat.chatType === 'oneOnOne') {
          destinations.push({
            type: 'dm',
            id: chat.id,
            teamId: null,
            name: `👤 Direct Message`,
            rawName: 'Direct Message'
          });
        }
      }
    } else {
      const chatErr = await resChats.text().catch(() => '');
      console.warn('[microsoftGraph] Chats query returned non-200:', resChats.status, chatErr);
    }
  } catch (err) {
    console.warn('[microsoftGraph] Error fetching chats:', err.message);
  }

  // 2. Fetch joined teams and their channels
  try {
    const resTeams = await fetch('https://graph.microsoft.com/v1.0/me/joinedTeams', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (resTeams.ok) {
      const dataTeams = await resTeams.json();
      const teams = dataTeams.value || [];

      for (const team of teams) {
        try {
          const resChannels = await fetch(`https://graph.microsoft.com/v1.0/teams/${team.id}/channels`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (resChannels.ok) {
            const dataChannels = await resChannels.json();
            const channels = dataChannels.value || [];
            for (const ch of channels) {
              destinations.push({
                type: 'channel',
                id: ch.id,
                teamId: team.id,
                name: `📢 Channel: ${team.displayName} > #${ch.displayName}`,
                rawName: `${team.displayName} > #${ch.displayName}`
              });
            }
          }
        } catch (_) {}
      }
    } else {
      const teamErr = await resTeams.text().catch(() => '');
      console.warn('[microsoftGraph] JoinedTeams query returned non-200:', resTeams.status, teamErr);
    }
  } catch (err) {
    console.warn('[microsoftGraph] Error fetching teams:', err.message);
  }

  // Ensure default Direct Message exists in destination list
  if (!destinations.some(d => d.type === 'dm')) {
    destinations.unshift({
      type: 'dm',
      id: 'me',
      teamId: null,
      name: `👤 Direct Message (Private to Me)`,
      rawName: 'Direct Message (Me)'
    });
  }

  return destinations;
}

/**
 * Sends notification card to Microsoft Teams Incoming Webhook or Power Automate workflow
 */
async function sendWebhookAlert({
  webhookUrl,
  hostname,
  daysLeft,
  status = 'critical',
  validTo,
  ackUrl,
  intervalText,
  isTest = false
}) {
  const isWarning = status === 'warning';
  const isExpired = status === 'expired' || daysLeft === 0;
  const themeColor = isTest ? '0D9488' : (isWarning ? 'D97706' : 'DC2626');
  const badgeText = isTest
    ? '🧪 TEST NOTIFICATION'
    : (isExpired ? '🛑 CERTIFICATE EXPIRED' : (isWarning ? '⚠️ WARNING: EXPIRING SOON' : '🚨 CRITICAL ALERT'));

  const daysLabel = daysLeft === 0
    ? 'EXPIRED'
    : (daysLeft === 1 ? '1 day left' : `${daysLeft} days left`);

  const dashboardUrl = (process.env.APP_URL || 'https://sslalerts.info').replace(/\/+$/, '') + '/dashboard#domains';

  // Strategy 1: Standard Office 365 Connector MessageCard
  const messageCard = {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    'themeColor': themeColor,
    'summary': isTest ? 'SSL Alerts Test Notification' : `SSL Alert: ${hostname} (${daysLabel})`,
    'sections': [{
      'activityTitle': isTest ? '🧪 SSL Alerts Integration Active' : `${badgeText}: ${hostname}`,
      'activitySubtitle': isTest
        ? 'Your Microsoft Teams channel has been connected successfully via Webhook.'
        : `The SSL certificate for <strong>${hostname}</strong> expires in <strong>${daysLabel}</strong>.`,
      'facts': !isTest ? [
        { 'name': 'Domain:', 'value': hostname },
        { 'name': 'Days Left:', 'value': daysLabel },
        ...(validTo ? [{ 'name': 'Valid Until:', 'value': validTo }] : [])
      ] : [
        { 'name': 'Status:', 'value': 'Active & Verified' },
        { 'name': 'Alert System:', 'value': 'Proactive Expiry Notifications' }
      ],
      'markdown': true
    }],
    'potentialAction': [
      ...(ackUrl ? [{
        '@type': 'OpenUri',
        'name': '🔕 1-Click Snooze (14 Days)',
        'targets': [{ 'os': 'default', 'uri': ackUrl }]
      }] : []),
      {
        '@type': 'OpenUri',
        'name': '🔍 View in Dashboard',
        'targets': [{ 'os': 'default', 'uri': dashboardUrl }]
      }
    ]
  };

  // Strategy 2: Power Automate Workflows Adaptive Card
  const adaptiveCard = {
    'type': 'message',
    'attachments': [
      {
        'contentType': 'application/vnd.microsoft.card.adaptive',
        'contentUrl': null,
        'content': {
          '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
          'type': 'AdaptiveCard',
          'version': '1.4',
          'body': [
            {
              'type': 'TextBlock',
              'size': 'Medium',
              'weight': 'Bolder',
              'color': isTest ? 'Good' : (isWarning ? 'Warning' : 'Attention'),
              'text': isTest ? '🧪 SSL Alerts Test Notification' : `${badgeText}: ${hostname}`
            },
            {
              'type': 'TextBlock',
              'wrap': true,
              'text': isTest
                ? 'Your Microsoft Teams channel has been connected successfully via Webhook.'
                : `The SSL certificate for **${hostname}** expires in **${daysLabel}**.`
            },
            ...(!isTest ? [{
              'type': 'FactSet',
              'facts': [
                { 'title': 'Domain', 'value': hostname },
                { 'title': 'Days Left', 'value': daysLabel },
                ...(validTo ? [{ 'title': 'Valid Until', 'value': validTo }] : [])
              ]
            }] : [])
          ],
          'actions': [
            ...(ackUrl ? [{
              'type': 'Action.OpenUrl',
              'title': '🔕 1-Click Snooze (14 Days)',
              'url': ackUrl
            }] : []),
            {
              'type': 'Action.OpenUrl',
              'title': '🔍 View in Dashboard',
              'url': dashboardUrl
            }
          ]
        }
      }
    ]
  };

  // Choose appropriate payload based on webhook endpoint
  const isLogicApp = webhookUrl.includes('logic.azure.com');
  const firstPayload = isLogicApp ? adaptiveCard : messageCard;
  const secondPayload = isLogicApp ? messageCard : adaptiveCard;

  let res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(firstPayload)
  });

  if (!res.ok) {
    // Attempt fallback format if primary format was not accepted
    const resFallback = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(secondPayload)
    });

    if (!resFallback.ok) {
      const errText = await resFallback.text().catch(() => '');
      throw new Error(`Teams Webhook rejected notification (${resFallback.status}): ${errText || resFallback.statusText}`);
    }
  }

  return { ok: true };
}

/**
 * Dispatches an SSL expiry alert or test alert card to Microsoft Teams
 */
async function sendTeamsAlert({
  connection,
  hostname,
  daysLeft,
  status = 'critical',
  validTo,
  ackUrl,
  intervalText,
  isTest = false
}) {
  // If destination is a Webhook URL, route to sendWebhookAlert
  if (connection.destination_type === 'webhook' || (connection.destination_id && connection.destination_id.startsWith('http'))) {
    return await sendWebhookAlert({
      webhookUrl: connection.destination_id,
      hostname,
      daysLeft,
      status,
      validTo,
      ackUrl,
      intervalText,
      isTest
    });
  }

  // Otherwise, dispatch via Microsoft Graph API
  const token = await ensureValidAccessToken(connection);

  const isWarning = status === 'warning';
  const isExpired = status === 'expired' || daysLeft === 0;
  const badgeColor = isTest ? '#0d9488' : (isWarning ? '#d97706' : '#dc2626');
  const badgeText = isTest
    ? '🧪 TEST NOTIFICATION'
    : (isExpired ? '🛑 CERTIFICATE EXPIRED' : (isWarning ? '⚠️ WARNING: EXPIRING SOON' : '🚨 CRITICAL ALERT'));

  const daysLabel = daysLeft === 0
    ? 'EXPIRED'
    : (daysLeft === 1 ? '1 day left' : `${daysLeft} days left`);

  const dashboardUrl = (process.env.APP_URL || 'https://sslalerts.info').replace(/\/+$/, '') + '/dashboard#domains';

  const htmlContent = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;border:1px solid #e2e8f0;border-left:6px solid ${badgeColor};border-radius:8px;padding:16px 20px;background:#ffffff;color:#1e293b;max-width:580px;">
      <div style="display:inline-block;background:${badgeColor};color:#ffffff;font-size:12px;font-weight:700;padding:4px 10px;border-radius:9999px;letter-spacing:0.5px;margin-bottom:12px;">
        ${badgeText}
      </div>
      <div style="font-size:18px;font-weight:700;color:#0f172a;margin-bottom:8px;">
        ${isTest ? 'SSL Alerts Integration Active' : `SSL Certificate Alert for <strong>${hostname}</strong>`}
      </div>
      <p style="font-size:14px;color:#475569;margin:0 0 14px 0;line-height:1.5;">
        ${isTest
          ? `Your Microsoft Teams integration with SSL Alerts has been connected successfully to <strong>${connection.destination_name}</strong>.`
          : `The SSL certificate for <strong>${hostname}</strong> expires in <span style="color:${badgeColor};font-weight:700;">${daysLabel}</span>.`
        }
      </p>

      ${!isTest ? `
      <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:16px;background:#f8fafc;border-radius:6px;overflow:hidden;">
        <tr>
          <td style="padding:8px 12px;color:#64748b;border-bottom:1px solid #e2e8f0;width:35%;"><strong>Domain:</strong></td>
          <td style="padding:8px 12px;color:#0f172a;border-bottom:1px solid #e2e8f0;">${hostname}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;color:#64748b;border-bottom:1px solid #e2e8f0;"><strong>Days Left:</strong></td>
          <td style="padding:8px 12px;color:${badgeColor};font-weight:700;border-bottom:1px solid #e2e8f0;">${daysLabel}</td>
        </tr>
        ${validTo ? `
        <tr>
          <td style="padding:8px 12px;color:#64748b;border-bottom:1px solid #e2e8f0;"><strong>Valid Until:</strong></td>
          <td style="padding:8px 12px;color:#0f172a;border-bottom:1px solid #e2e8f0;">${validTo}</td>
        </tr>` : ''}
      </table>
      ` : ''}

      <div style="display:flex;gap:10px;margin-top:14px;">
        ${ackUrl ? `
        <a href="${ackUrl}" target="_blank" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:8px 16px;border-radius:6px;">
          🔕 1-Click Snooze (14 Days)
        </a>
        ` : ''}
        <a href="${dashboardUrl}" target="_blank" style="display:inline-block;background:#0d9488;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:8px 16px;border-radius:6px;">
          🔍 View in Dashboard
        </a>
      </div>

      ${intervalText ? `
      <div style="margin-top:14px;padding-top:10px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;">
        ${intervalText}
      </div>` : ''}
    </div>
  `;

  let postUrl;
  let destinationId = connection.destination_id;

  // If user selected "dm" and destination_id is 'me', attempt to resolve to an existing chat thread
  if (connection.destination_type === 'dm' && destinationId === 'me') {
    try {
      const resRecent = await fetch('https://graph.microsoft.com/v1.0/me/chats?$top=1', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (resRecent.ok) {
        const recentData = await resRecent.json();
        if (recentData.value && recentData.value.length > 0) {
          destinationId = recentData.value[0].id;
          await db.execute('UPDATE teams_graph_connections SET destination_id = ? WHERE id = ?', [destinationId, connection.id]);
        }
      }
    } catch (_) {}
  }

  if (connection.destination_type === 'channel' && connection.team_id) {
    postUrl = `https://graph.microsoft.com/v1.0/teams/${connection.team_id}/channels/${destinationId}/messages`;
  } else {
    postUrl = `https://graph.microsoft.com/v1.0/chats/${destinationId}/messages`;
  }

  const res = await fetch(postUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      body: {
        contentType: 'html',
        content: htmlContent
      }
    })
  });

  const resData = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(resData?.error?.message || `Microsoft Graph returned status ${res.status}: ${res.statusText}`);
  }

  return { ok: true, id: resData.id };
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  ensureValidAccessToken,
  getUserProfile,
  getDestinations,
  sendWebhookAlert,
  sendTeamsAlert
};
