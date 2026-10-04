const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_secret_change_me';
const COOKIE_NAME = 'hsa_token';

// Only mark the cookie "Secure" (HTTPS-only) once you actually have HTTPS.
// Basing this on NODE_ENV alone breaks logins on a plain http:// deployment,
// because browsers silently drop Secure cookies on non-HTTPS pages.
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : (process.env.APP_URL || '').toLowerCase().startsWith('https://');

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

const SESSION_MS = 24 * 60 * 60 * 1000; // 1 day — matches issueToken's expiresIn below

function issueToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1d' });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: SESSION_MS
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Middleware: requires a valid session, attaches req.userId
async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);

    const { db } = require('./db');
    const exists = await db.getOne('SELECT id FROM users WHERE id = ?', [payload.uid]);
    if (!exists) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Session no longer valid, please sign in again.' });
    }

    req.userId = payload.uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired, please sign in again.' });
  }
}

// Middleware: requires the signed-in user to be an admin (see ADMIN_EMAIL in .env)
async function requireAdmin(req, res, next) {
  const { db } = require('./db');
  const user = await db.getOne('SELECT is_admin FROM users WHERE id = ?', [req.userId]);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

module.exports = {
  hashPassword, verifyPassword, issueToken,
  setAuthCookie, clearAuthCookie, requireAuth, requireAdmin, COOKIE_NAME, JWT_SECRET
};
