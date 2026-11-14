const { db } = require('./db');
const jwt = require('jsonwebtoken');
const { COOKIE_NAME, JWT_SECRET } = require('./auth');

// In-memory buffer to batch page view & activity inserts (high performance, non-blocking)
let eventQueue = [];
const BATCH_INTERVAL_MS = 2500;

async function flushEvents() {
  if (eventQueue.length === 0) return;
  const batch = eventQueue.splice(0, 100);
  try {
    const values = [];
    const placeholders = batch.map(e => {
      values.push(
        e.user_id,
        e.session_id,
        e.ip_address,
        e.country,
        e.user_agent,
        e.device_type,
        e.browser,
        e.os,
        e.path,
        e.referrer,
        e.action_type,
        e.metadata ? JSON.stringify(e.metadata) : null
      );
      return '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    }).join(', ');

    await db.execute(`
      INSERT INTO visitor_activity_log 
        (user_id, session_id, ip_address, country, user_agent, device_type, browser, os, path, referrer, action_type, metadata)
      VALUES ${placeholders}
    `, values);
  } catch (err) {
    console.error('[analyticsTracker] Batch flush failed:', err.message);
  }
}

setInterval(flushEvents, BATCH_INTERVAL_MS).unref();

function parseUserAgent(ua = '') {
  let device_type = 'desktop';
  if (/mobile|android|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua)) {
    device_type = 'mobile';
  } else if (/ipad|tablet/i.test(ua)) {
    device_type = 'tablet';
  }

  let browser = 'Other';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua)) browser = 'Safari';
  else if (/opera|opr\//i.test(ua)) browser = 'Opera';

  let os = 'Other';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/macintosh|mac os x/i.test(ua)) os = 'macOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  return { device_type, browser, os };
}

function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

function getClientCountry(req) {
  return (
    req.headers['cf-ipcountry'] ||
    req.headers['x-country'] ||
    'Unknown'
  );
}

// Track individual page views automatically
function trackPageViewMiddleware(req, res, next) {
  const path = req.path;

  // Ignore static assets, icons, fonts, API endpoints, internal probes
  if (
    path.startsWith('/assets') ||
    path.startsWith('/css') ||
    path.startsWith('/js') ||
    path.startsWith('/api') ||
    path.startsWith('/.well-known') ||
    path.includes('.ico') ||
    path.includes('.png') ||
    path.includes('.svg') ||
    path.includes('.jpg') ||
    path.includes('.mp4') ||
    path.includes('.xml') ||
    path.includes('.txt')
  ) {
    return next();
  }

  try {
    let userId = null;
    const token = req.cookies?.[COOKIE_NAME];
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded?.uid || null;
      } catch (_) {}
    }

    const ip = getClientIp(req);
    const country = getClientCountry(req);
    const ua = req.headers['user-agent'] || '';
    const referrer = req.headers['referer'] || req.headers['referrer'] || null;
    const { device_type, browser, os } = parseUserAgent(ua);

    // Create anonymous daily session id: hash of IP + user-agent + today
    const today = new Date().toISOString().slice(0, 10);
    const sessionId = Buffer.from(`${ip}_${ua}_${today}`).toString('base64').slice(0, 32);

    eventQueue.push({
      user_id: userId,
      session_id: sessionId,
      ip_address: ip,
      country,
      user_agent: ua.slice(0, 255),
      device_type,
      browser,
      os,
      path: path.slice(0, 255),
      referrer: referrer ? String(referrer).slice(0, 255) : null,
      action_type: 'page_view',
      metadata: null
    });
  } catch (err) {
    console.warn('[analyticsTracker] middleware error:', err.message);
  }

  next();
}

// Helper to manually record distinct actions (e.g. "checked_ssl", "added_domain", "upgraded_plan")
function trackAction({ req, userId = null, actionType, path = null, metadata = null }) {
  try {
    const ip = req ? getClientIp(req) : '127.0.0.1';
    const country = req ? getClientCountry(req) : 'Unknown';
    const ua = req ? (req.headers['user-agent'] || '') : '';
    const { device_type, browser, os } = parseUserAgent(ua);
    const targetPath = path || (req ? req.path : '/');

    const today = new Date().toISOString().slice(0, 10);
    const sessionId = Buffer.from(`${ip}_${ua}_${today}`).toString('base64').slice(0, 32);

    eventQueue.push({
      user_id: userId,
      session_id: sessionId,
      ip_address: ip,
      country,
      user_agent: ua.slice(0, 255),
      device_type,
      browser,
      os,
      path: targetPath.slice(0, 255),
      referrer: req?.headers['referer'] ? String(req.headers['referer']).slice(0, 255) : null,
      action_type: actionType.slice(0, 50),
      metadata
    });
  } catch (err) {
    console.warn('[analyticsTracker] trackAction error:', err.message);
  }
}

module.exports = {
  trackPageViewMiddleware,
  trackAction,
  getClientIp,
  getClientCountry
};
