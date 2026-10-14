const net = require('net');
const dns = require('dns').promises;

/**
 * Checks if an IP address belongs to a private, loopback, link-local,
 * carrier-grade NAT, or multicast/reserved range.
 */
function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const cleanIp = ip.trim().replace(/^\[/, '').replace(/\]$/, '');

  // IPv4 Checks
  if (net.isIPv4(cleanIp)) {
    const parts = cleanIp.split('.').map(n => parseInt(n, 10));
    if (parts.length !== 4 || parts.some(isNaN)) return true;

    // 0.0.0.0/8 (Current network)
    if (parts[0] === 0) return true;
    // 10.0.0.0/8 (Private network)
    if (parts[0] === 10) return true;
    // 100.64.0.0/10 (Carrier-Grade NAT / Shared)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 127.0.0.0/8 (Loopback)
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 (Link-Local, AWS/GCP/Azure Metadata 169.254.169.254)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12 (Private network / Docker bridge)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.0.0.0/24 (IETF assignments)
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    // 192.168.0.0/16 (Private network)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 198.18.0.0/15 (Benchmarking)
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
    // 224.0.0.0/4 (Multicast) or 240.0.0.0/4 (Reserved / Broadcast)
    if (parts[0] >= 224) return true;

    return false;
  }

  // IPv6 Checks
  if (net.isIPv6(cleanIp)) {
    const lower = cleanIp.toLowerCase();
    // ::1 (Loopback) or :: (Unspecified)
    if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1' || lower === '0:0:0:0:0:0:0:0') return true;
    // Link-local: fe80::/10
    if (/^fe[89ab]/i.test(lower)) return true;
    // Unique local / private: fc00::/7 (fc00:: and fd00::)
    if (/^f[cd]/i.test(lower)) return true;
    // IPv4-mapped IPv6: ::ffff:x.x.x.x
    if (lower.startsWith('::ffff:')) {
      const v4part = lower.slice(7);
      if (net.isIPv4(v4part)) return isPrivateIp(v4part);
    }
    return false;
  }

  return true;
}

/**
 * Validates that a target host is safe to connect to and does NOT resolve
 * to any internal, loopback, or private network address (SSRF Guard).
 */
async function validatePublicHost(rawHost) {
  if (!rawHost || typeof rawHost !== 'string') {
    return { valid: false, error: 'Please enter a valid hostname or domain.' };
  }

  const host = rawHost.trim().toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\[/, '').replace(/\]$/, '');

  if (!host) {
    return { valid: false, error: 'Hostname cannot be empty.' };
  }

  // Block obvious local / internal aliases
  const blockedHostnames = ['localhost', 'broadcasthost', 'local', 'internal', 'docker'];
  if (blockedHostnames.includes(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
    return { valid: false, error: 'Access to internal or local hostnames is prohibited.' };
  }

  // If input is an IP literal
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      return { valid: false, error: 'Access to private, loopback, or restricted IP addresses is prohibited.' };
    }
    return { valid: true, host, ips: [host] };
  }

  // Resolve DNS to verify all destination IPs
  try {
    const records = await dns.lookup(host, { all: true });
    if (!records || records.length === 0) {
      return { valid: false, error: `Could not resolve domain "${host}".` };
    }

    const resolvedIps = records.map(r => r.address);
    for (const ip of resolvedIps) {
      if (isPrivateIp(ip)) {
        return {
          valid: false,
          error: `Domain "${host}" resolves to a restricted or private IP address (${ip}).`
        };
      }
    }

    return { valid: true, host, ips: resolvedIps };
  } catch (err) {
    return { valid: false, error: `Domain DNS lookup failed for "${host}": ${err.code || err.message}` };
  }
}

/**
 * In-memory sliding-window rate limiter middleware with zero external dependencies.
 */
function createRateLimiter({
  windowMs = 60000,
  max = 60,
  message = 'Too many requests. Please wait a moment and try again.',
  statusCode = 429,
  keyGenerator = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown_ip';
  }
} = {}) {
  const store = new Map(); // key -> { count: number, resetTime: number }

  // Periodic cleanup so Map cannot leak memory
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, data] of store) {
      if (now > data.resetTime) {
        store.delete(key);
      }
    }
  }, Math.max(windowMs, 30000));
  interval.unref();

  return function rateLimitMiddleware(req, res, next) {
    const key = keyGenerator(req);
    const now = Date.now();
    let record = store.get(key);

    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      store.set(key, record);
      return next();
    }

    record.count += 1;
    if (record.count > max) {
      const retryAfterSec = Math.ceil((record.resetTime - now) / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(statusCode).json({
        error: message,
        retryAfter: retryAfterSec
      });
    }

    next();
  };
}

/**
 * OTP Attempt Tracker & Lockout
 * Limits wrong verification attempts to MAX_OTP_ATTEMPTS (5) per account.
 */
const MAX_OTP_ATTEMPTS = 5;
const failedOtpMap = new Map(); // email -> { count: number, timestamp: number }

// Cleanup stale attempts every 15 minutes
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [email, data] of failedOtpMap) {
    if (data.timestamp < cutoff) failedOtpMap.delete(email);
  }
}, 5 * 60 * 1000).unref();

function recordFailedOtpAttempt(email) {
  const key = String(email || '').trim().toLowerCase();
  const current = failedOtpMap.get(key) || { count: 0, timestamp: Date.now() };
  current.count += 1;
  current.timestamp = Date.now();
  failedOtpMap.set(key, current);
  return current.count;
}

function clearFailedOtpAttempts(email) {
  failedOtpMap.delete(String(email || '').trim().toLowerCase());
}

function isOtpLocked(email) {
  const key = String(email || '').trim().toLowerCase();
  const record = failedOtpMap.get(key);
  return Boolean(record && record.count >= MAX_OTP_ATTEMPTS);
}

/**
 * Standard Security Headers Middleware
 * Protects against MIME sniffing, clickjacking, protocol downgrades, and referrer leaks.
 */
function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // HSTS on HTTPS connections or when behind SSL proxy
  const isHttps = req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    (process.env.APP_URL || '').toLowerCase().startsWith('https://');

  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  next();
}

module.exports = {
  isPrivateIp,
  validatePublicHost,
  createRateLimiter,
  securityHeadersMiddleware,
  recordFailedOtpAttempt,
  clearFailedOtpAttempts,
  isOtpLocked,
  MAX_OTP_ATTEMPTS
};
