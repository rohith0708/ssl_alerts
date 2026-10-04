const express = require('express');
const { lookupDomain } = require('../dnsLookup');

const router = express.Router();

// This endpoint is intentionally public (it's a free utility, like the
// site it's modeled on) but unauthenticated + does outbound DNS lookups,
// so it gets a simple in-memory rate limit per IP to deter abuse. Good
// enough for a single small VPS; not meant to survive a real attack.
const RATE_LIMIT = 120;       // requests
const RATE_WINDOW_MS = 60_000; // per minute
const hits = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

// Periodic cleanup so this Map can't grow unbounded on a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    const recent = times.filter(t => now - t < RATE_WINDOW_MS);
    if (recent.length === 0) hits.delete(ip); else hits.set(ip, recent);
  }
}, RATE_WINDOW_MS).unref();

router.get('/dns-lookup', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many lookups — wait a minute and try again.' });
  }

  const hostname = String(req.query.domain || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const type = String(req.query.type || 'A').toUpperCase();

  if (!hostname) return res.status(400).json({ error: 'Enter a domain to look up.' });

  const result = await lookupDomain(hostname, type);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

module.exports = router;
