/**
 * Evolution API v2 WhatsApp Gateway Client
 * Handles instance initialization, QR code pairing, connection monitoring, and message dispatch.
 */

const EVOLUTION_URL = (process.env.EVOLUTION_URL || 'http://evolution-api:8080').replace(/\/+$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'harisree_wa_key_8f93e2b1049c81a2';
const INSTANCE_NAME = process.env.EVOLUTION_INSTANCE || 'sslalerts';

/**
 * Ensures the instance exists in Evolution API
 */
async function ensureInstance() {
  try {
    const res = await fetch(`${EVOLUTION_URL}/instance/fetchInstances`, {
      headers: { apikey: EVOLUTION_API_KEY }
    });

    if (res.ok) {
      const instances = await res.json();
      if (Array.isArray(instances)) {
        const found = instances.some(i => i.name === INSTANCE_NAME || i.instanceName === INSTANCE_NAME);
        if (found) return true;
      }
    }

    // Instance does not exist; create it
    const createRes = await fetch(`${EVOLUTION_URL}/instance/create`, {
      method: 'POST',
      headers: {
        apikey: EVOLUTION_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        instanceName: INSTANCE_NAME,
        token: EVOLUTION_API_KEY,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS'
      })
    });

    return createRes.ok;
  } catch (err) {
    console.warn('[EvolutionAPI] Error ensuring instance:', err.message);
    return false;
  }
}

/**
 * Checks WhatsApp gateway connection status ('connected' | 'qr_ready' | 'disconnected')
 */
async function getConnectionStatus() {
  try {
    await ensureInstance();

    const res = await fetch(`${EVOLUTION_URL}/instance/connectionState/${INSTANCE_NAME}`, {
      headers: { apikey: EVOLUTION_API_KEY }
    });

    if (!res.ok) {
      return { connected: false, state: 'disconnected', user: null };
    }

    const data = await res.json();
    const rawState = data.instance?.state || data.state || 'close';

    if (rawState === 'open') {
      const owner = data.instance?.ownerJid || data.instance?.profileName || '';
      const cleanOwner = owner.split('@')[0] || 'Connected Phone';
      return { connected: true, state: 'connected', user: cleanOwner };
    } else if (rawState === 'connecting') {
      return { connected: false, state: 'qr_ready', user: null };
    } else {
      return { connected: false, state: 'disconnected', user: null };
    }
  } catch (err) {
    return { connected: false, state: 'disconnected', user: null, error: err.message };
  }
}

/**
 * Fetches the base64 pairing QR Code image for the instance
 */
async function getQrCode() {
  try {
    await ensureInstance();

    const res = await fetch(`${EVOLUTION_URL}/instance/connect/${INSTANCE_NAME}`, {
      headers: { apikey: EVOLUTION_API_KEY }
    });

    if (!res.ok) {
      return { qrcode: null, error: `Evolution returned status ${res.status}` };
    }

    const data = await res.json();
    let qr = data.base64 || data.code || null;

    if (qr && !qr.startsWith('data:image')) {
      qr = `data:image/png;base64,${qr}`;
    }

    return { qrcode: qr };
  } catch (err) {
    return { qrcode: null, error: err.message };
  }
}

/**
 * Dispatches an SSL certificate expiry alert or test notification
 */
async function sendWhatsAppAlert({
  toPhoneNumber,
  hostname,
  daysLeft,
  status = 'critical',
  validTo,
  ackUrl,
  intervalText,
  isTest = false
}) {
  if (!toPhoneNumber) {
    throw new Error('Missing recipient phone number');
  }

  // Normalize phone number to digits only (e.g. 916282954335)
  const cleanNumber = toPhoneNumber.replace(/[^\d]/g, '');
  if (cleanNumber.length < 8) {
    throw new Error(`Invalid phone number: ${toPhoneNumber}`);
  }

  const isWarning = status === 'warning';
  const isExpired = status === 'expired' || daysLeft === 0;
  const badge = isTest
    ? '🧪 *TEST NOTIFICATION*'
    : (isExpired ? '🛑 *SSL CERTIFICATE EXPIRED*' : (isWarning ? '⚠️ *SSL EXPIRY WARNING*' : '🚨 *CRITICAL SSL ALERT*'));

  const daysLabel = daysLeft === 0 ? '*EXPIRED*' : (daysLeft === 1 ? '*1 day left*' : `*${daysLeft} days left*`);
  const dashboardUrl = `${(process.env.APP_URL || 'https://sslalerts.info').replace(/\/+$/, '')}/dashboard#domains`;

  const text = isTest
    ? [
        `${badge}`,
        ``,
        `Your WhatsApp alert integration with *SSL Alerts* is verified and active!`,
        ``,
        `📱 *Recipient:* +${cleanNumber}`,
        `🌐 *Platform:* https://sslalerts.info`,
        ``,
        `You will receive real-time notifications here when any of your monitored certificates approach expiration.`
      ].join('\n')
    : [
        `${badge}`,
        ``,
        `*Domain:* ${hostname}`,
        `*Status:* Expires in ${daysLabel}`,
        validTo ? `*Valid Until:* ${validTo}` : '',
        ``,
        ackUrl ? `🔕 *1-Click Snooze (14 Days):*\n${ackUrl}\n` : '',
        `🔍 *View in Dashboard:*\n${dashboardUrl}`,
        intervalText ? `\n_${intervalText}_` : ''
      ].filter(Boolean).join('\n');

  const res = await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE_NAME}`, {
    method: 'POST',
    headers: {
      apikey: EVOLUTION_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      number: cleanNumber,
      text: text,
      options: {
        delay: 1200,
        presence: 'composing',
        linkPreview: true
      }
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.response?.message || data.error || `Evolution API error (${res.status}): ${res.statusText}`);
  }

  return { ok: true, messageId: data.key?.id || data.messageId };
}

/**
 * Disconnects / logs out the current WhatsApp instance to allow pairing a new number
 */
async function logoutInstance() {
  try {
    const res = await fetch(`${EVOLUTION_URL}/instance/logout/${INSTANCE_NAME}`, {
      method: 'DELETE',
      headers: { apikey: EVOLUTION_API_KEY }
    });
    return res.ok;
  } catch (err) {
    console.warn('[EvolutionAPI] Error logging out:', err.message);
    return false;
  }
}

module.exports = {
  getConnectionStatus,
  getQrCode,
  sendWhatsAppAlert,
  logoutInstance
};
