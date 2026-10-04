const tls = require('tls');
const { X509Certificate } = require('crypto');

const CONNECT_TIMEOUT_MS = 8000;

/**
 * Connects to hostname:port over TLS, reads the leaf certificate,
 * and returns its expiry status. Never throws — errors are returned
 * as { error } so batch jobs can keep going.
 */
function checkDomain(hostname, port = 443) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve(result);
    };

    const socket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname, // SNI — required for most modern hosts
        timeout: CONNECT_TIMEOUT_MS,
        rejectUnauthorized: false // we want to *inspect* the cert even if invalid
      },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || Object.keys(cert).length === 0) {
          return finish({ error: 'No certificate presented by host.' });
        }

        const validTo = new Date(cert.valid_to);
        const validFrom = new Date(cert.valid_from);
        const now = new Date();
        const msLeft = validTo.getTime() - now.getTime();
        const daysLeft = Math.floor(msLeft / (1000 * 60 * 60 * 24));

        const authorized = socket.authorized || false;
        let status;
        if (daysLeft < 0) status = 'expired';
        else if (!authorized) status = 'error';
        else if (daysLeft <= 7) status = 'critical';
        else if (daysLeft <= 30) status = 'warning';
        else status = 'valid';

        finish({
          status,
          issuer: cert.issuer && (cert.issuer.O || cert.issuer.CN) || 'Unknown',
          subject: cert.subject && cert.subject.CN || hostname,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
          daysLeft,
          authorized,
          authError: socket.authorizationError || null
        });
      }
    );

    socket.on('timeout', () => finish({ error: 'Connection timed out.' }));
    socket.on('error', (err) => finish({ error: err.message || 'Connection failed.' }));
  });
}

/**
 * Parses a pasted PEM certificate and returns its expiry status in the same
 * shape as checkDomain(), so everything downstream (status colours, alert
 * emails, the 30-minute repeat loop) works identically for internal certs.
 *
 * This is the "internal certificate monitoring" path: certs for hosts we
 * can't reach over the public internet (internal CAs, air-gapped services,
 * client certs), where the user supplies the certificate directly instead
 * of us fetching it over TLS.
 *
 * Never throws — malformed input comes back as { error }.
 */
function checkPastedCertificate(pem) {
  try {
    const cert = new X509Certificate(pem);

    const validFrom = new Date(cert.validFrom);
    const validTo = new Date(cert.validTo);
    if (isNaN(validTo.getTime())) {
      return { error: 'Certificate has an unreadable expiry date.' };
    }

    const daysLeft = Math.floor((validTo.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const notYetValid = validFrom.getTime() > Date.now();

    let status;
    if (daysLeft < 0) status = 'expired';
    else if (daysLeft <= 7) status = 'critical';
    else if (daysLeft <= 30) status = 'warning';
    else status = 'valid';

    // A pasted cert can't be "authorized" the way a live TLS handshake can —
    // there's no chain or hostname to verify against. We report on validity
    // dates only, which is exactly what expiry monitoring needs.
    return {
      status,
      issuer: parseDn(cert.issuer, 'O') || parseDn(cert.issuer, 'CN') || 'Unknown',
      subject: parseDn(cert.subject, 'CN') || 'Unknown',
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
      daysLeft,
      authorized: true,
      authError: notYetValid ? 'Certificate is not valid yet (start date is in the future).' : null,
      serialNumber: cert.serialNumber,
      isCa: cert.ca === true
    };
  } catch (err) {
    return { error: 'Could not read that certificate. Paste the full PEM block, including the BEGIN and END lines.' };
  }
}

/**
 * Node's X509Certificate exposes subject/issuer as a multi-line DN string
 * ("CN=Example CA\nO=Example Ltd"), so pull out a single field by name.
 */
function parseDn(dn, field) {
  if (!dn) return null;
  const match = String(dn).split('\n').find(line => line.trim().startsWith(`${field}=`));
  return match ? match.trim().slice(field.length + 1) : null;
}

/**
 * Checks a single stored row, dispatching on how the certificate is
 * sourced: 'internal' rows re-read the stored PEM, everything else does a
 * live TLS handshake against the hostname.
 */
function checkCertRow(row) {
  if (row.source === 'internal') {
    return Promise.resolve(
      row.pem
        ? checkPastedCertificate(row.pem)
        : { error: 'No certificate stored for this entry.' }
    );
  }
  return checkDomain(row.hostname, row.port);
}

/**
 * Runs checks across many rows with a concurrency cap so a
 * 2GB box never opens hundreds of sockets at once.
 */
async function checkMany(domainRows, concurrency = 10, onResult) {
  let idx = 0;
  async function worker() {
    while (idx < domainRows.length) {
      const i = idx++;
      const row = domainRows[i];
      const result = await checkCertRow(row);
      await onResult(row, result);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, domainRows.length) }, worker);
  await Promise.all(workers);
}

module.exports = { checkDomain, checkPastedCertificate, checkCertRow, checkMany };
