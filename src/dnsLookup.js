const net = require('net');
const dns = require('dns').promises;
const { Resolver } = require('dns').promises;

const LOOKUP_TIMEOUT_MS = 6000;

// High-speed authoritative resolvers
const publicResolver = new Resolver();
try {
  publicResolver.setServers([
    '1.1.1.1',
    '8.8.8.8',
    '1.0.0.1',
    '8.8.4.4'
  ]);
} catch (_) {}

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => {
      const err = new Error('TIMEOUT');
      err.code = 'ETIMEOUT';
      reject(err);
    }, LOOKUP_TIMEOUT_MS))
  ]);
}

function cleanHostname(str) {
  return String(str || '').trim().toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.+$/, '');
}

// Allows standard domains, subdomains, and record prefixes with underscores
// like _acme-challenge, _dmarc, _domainkey, _sip, etc.
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?\.)+[a-zA-Z0-9_-]{2,63}$/;

function isValidHostname(raw) {
  const host = cleanHostname(raw);
  if (!host) return false;
  if (net.isIP(host)) return true;
  return HOSTNAME_RE.test(host);
}

async function resolveWithFallback(methodName, host) {
  try {
    return await withTimeout(publicResolver[methodName](host));
  } catch (publicErr) {
    if (publicErr.code === 'ENOTFOUND' || publicErr.code === 'ENODATA') {
      throw publicErr;
    }
    // Fall back to system resolver if public resolver had network/timeout issue
    return await withTimeout(dns[methodName](host));
  }
}

const RECORD_HANDLERS = {
  A:     (host) => resolveWithFallback('resolve4', host).then(rows => rows.map(address => ({ value: address }))),
  AAAA:  (host) => resolveWithFallback('resolve6', host).then(rows => rows.map(address => ({ value: address }))),
  CNAME: (host) => resolveWithFallback('resolveCname', host).then(rows => rows.map(value => ({ value }))),
  MX:    (host) => resolveWithFallback('resolveMx', host).then(rows => rows.map(r => ({ value: r.exchange, priority: r.priority }))),
  NS:    (host) => resolveWithFallback('resolveNs', host).then(rows => rows.map(value => ({ value }))),
  TXT:   (host) => resolveWithFallback('resolveTxt', host).then(rows => {
    if (!Array.isArray(rows)) return [];
    return rows.map(chunks => ({
      value: Array.isArray(chunks) ? chunks.join('') : String(chunks)
    }));
  }),
  SOA:   (host) => resolveWithFallback('resolveSoa', host).then(r => [{
    value: `${r.nsname} ${r.hostmaster} (serial ${r.serial}, refresh ${r.refresh}, retry ${r.retry}, expire ${r.expire}, minttl ${r.minttl})`
  }]),
  SRV:   (host) => resolveWithFallback('resolveSrv', host).then(rows => rows.map(r => ({
    value: `${r.name}:${r.port}`, priority: r.priority, weight: r.weight
  }))),
  CAA:   (host) => resolveWithFallback('resolveCaa', host).then(rows => rows.map(r => {
    const tag = r.issue !== undefined ? 'issue' : (r.issuewild !== undefined ? 'issuewild' : (r.iodef !== undefined ? 'iodef' : (r.contactemail !== undefined ? 'contactemail' : (r.contactphone !== undefined ? 'contactphone' : 'tag'))));
    const val = r[tag] || '';
    const flag = r.critical ? '128 (critical)' : '0 (non-critical)';
    return { value: `${flag} ${tag} "${val}"` };
  })),
  PTR:   async (host) => {
    if (net.isIP(host)) {
      const rows = await resolveWithFallback('reverse', host);
      return rows.map(value => ({ value }));
    }
    const rows = await resolveWithFallback('resolvePtr', host);
    return rows.map(value => ({ value }));
  }
};

const ALL_TYPES = Object.keys(RECORD_HANDLERS);

/**
 * Looks up one record type for a hostname. Never throws — a missing
 * record or resolver error comes back as { records: [], error } so the
 * caller can render "no records found" instead of a failed request.
 */
async function lookupType(hostname, type) {
  const handler = RECORD_HANDLERS[type];
  if (!handler) return { type, records: [], error: 'Unsupported record type.' };
  try {
    const records = await handler(hostname);
    if (!records || records.length === 0) {
      return { type, records: [], error: `No ${type} records found.` };
    }
    return { type, records };
  } catch (err) {
    const code = err.code || err.message;
    if (code === 'ENODATA' || code === 'ENOTFOUND') {
      return { type, records: [], error: `No ${type} records found.` };
    }
    if (code === 'ETIMEOUT' || code === 'TIMEOUT') {
      return { type, records: [], error: 'Lookup timed out.' };
    }
    if (code === 'ESERVFAIL' || code === 'SERVFAIL') {
      return { type, records: [], error: 'DNS server failure (SERVFAIL).' };
    }
    if (code === 'ECONNREFUSED' || code === 'EREFUSED') {
      return { type, records: [], error: 'DNS query refused or unreachable.' };
    }
    return { type, records: [], error: `No ${type} records found.` };
  }
}

/**
 * Looks up either one record type, or all of them.
 */
async function lookupDomain(rawHostname, type) {
  const hostname = cleanHostname(rawHostname);
  if (!isValidHostname(hostname)) {
    return { hostname: rawHostname, error: 'Enter a valid domain, e.g. example.com or _acme-challenge.domain.com' };
  }
  const types = (type === 'ALL' || type === 'ANY') ? ALL_TYPES : [type];
  const results = await Promise.all(types.map(t => lookupType(hostname, t)));
  return { hostname, results };
}

module.exports = { lookupDomain, isValidHostname, cleanHostname, ALL_TYPES };
