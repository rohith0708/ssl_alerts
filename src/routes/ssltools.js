const express = require('express');
const {
  decodeCertificate,
  decodeCsr,
  matchKeyAndCert,
  checkLiveInstallation
} = require('../sslTools');
const { createRateLimiter } = require('../security');

const router = express.Router();

// Rate limit public SSL diagnostic tools (60 requests per minute per IP)
router.use(createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many diagnostic requests. Please wait a minute before trying again.'
}));

// POST /api/ssltools/decode-cert
router.post('/decode-cert', (req, res) => {
  const pem = String(req.body?.pem || req.body?.certText || req.body?.cert || '').trim();
  if (!pem) return res.status(400).json({ error: 'Please paste a certificate PEM block.' });

  const result = decodeCertificate(pem);
  if (result.error) return res.status(400).json(result);

  const formatted = [
    `Common Name (CN):      ${result.commonName || 'N/A'}`,
    `Organization (O):      ${result.organization || 'N/A'}`,
    `Issuer:                ${result.issuerCN || result.issuer || 'N/A'}`,
    `Valid From:            ${result.validFrom}`,
    `Valid To:              ${result.validTo} (${result.daysLeft >= 0 ? `${result.daysLeft} days remaining` : 'EXPIRED'})`,
    `Serial Number:         ${result.serialNumber || 'N/A'}`,
    `Key Algorithm & Size:  ${result.keyType || 'RSA'} ${result.keySize ? `${result.keySize}-bit` : ''}`,
    `SANs (Alt Names):      ${result.subjectAltNames && result.subjectAltNames.length > 0 ? result.subjectAltNames.join(', ') : 'None'}`,
    `SHA-256 Fingerprint:   ${result.fingerprint256 || 'N/A'}`,
    `SHA-1 Fingerprint:     ${result.fingerprint || 'N/A'}`
  ].join('\n');

  res.json({
    ...result,
    decoded: formatted
  });
});

// POST /api/ssltools/decode-csr
router.post('/decode-csr', async (req, res) => {
  const pem = String(req.body?.pem || req.body?.csrText || req.body?.csr || '').trim();
  if (!pem) return res.status(400).json({ error: 'Please paste a CSR PEM block.' });

  const result = await decodeCsr(pem);
  if (result.error) return res.status(400).json(result);

  const formatted = [
    `Common Name (CN):        ${result.commonName || 'N/A'}`,
    `Organization (O):        ${result.organization || 'N/A'}`,
    `Organizational Unit (OU):${result.organizationalUnit || 'N/A'}`,
    `Locality / City:         ${result.locality || 'N/A'}`,
    `State / Province:        ${result.state || 'N/A'}`,
    `Country (C):             ${result.country || 'N/A'}`,
    `Key Algorithm & Size:    ${result.keyType || 'RSA'} ${result.keySize ? `${result.keySize}` : ''}`,
    `Signature Algorithm:     ${result.signatureAlgorithm || 'N/A'}`,
    `SANs (Alt Names):        ${result.subjectAltNames && result.subjectAltNames.length > 0 ? result.subjectAltNames.join(', ') : 'None'}`,
    `SPKI SHA-256 Hash:       ${result.spkiHash || 'N/A'}`
  ].join('\n');

  res.json({
    ...result,
    decoded: formatted
  });
});

// POST /api/ssltools/match-key
router.post('/match-key', async (req, res) => {
  const inputA = req.body?.inputA || req.body?.cert || req.body?.certText || req.body?.first;
  const inputB = req.body?.inputB || req.body?.key || req.body?.keyText || req.body?.csr || req.body?.second;

  if (!inputA || !inputB) {
    return res.status(400).json({ error: 'Please enter both items to compare.' });
  }

  const result = await matchKeyAndCert(inputA, inputB);
  if (result.error) return res.status(400).json(result);

  const matchMessage = result.match
    ? 'Public key and private key match perfectly!'
    : 'Public key hashes do not match. The private key does not correspond to this certificate/CSR.';

  res.json({
    ...result,
    message: matchMessage
  });
});

// GET & POST /api/ssltools/check-installation
router.all(['/check-installation', '/check'], async (req, res) => {
  const domain = String(req.body?.hostname || req.body?.domain || req.query?.domain || req.query?.hostname || '').trim();
  const port = Number(req.body?.port || req.query?.port) || 443;

  if (!domain) {
    return res.status(400).json({ error: 'Please enter a domain to check.' });
  }

  const result = await checkLiveInstallation(domain, port);
  if (result.error) return res.status(400).json(result);

  const leaf = result.leaf || {};
  const connection = {
    protocol: result.protocol || 'TLS',
    cipher: result.cipher || 'Unknown',
    bits: '256'
  };

  const certificate = {
    subject: {
      CN: leaf.subject || domain,
      ...(leaf.subjectFull || {})
    },
    issuer: {
      CN: leaf.issuer || 'Unknown',
      O: leaf.issuerFull?.O || leaf.issuer || 'Unknown',
      ...(leaf.issuerFull || {})
    },
    validFrom: leaf.validFrom,
    validTo: leaf.validTo,
    serialNumber: leaf.serialNumber || 'N/A',
    fingerprint: leaf.fingerprint || 'N/A',
    fingerprint256: leaf.fingerprint || 'N/A'
  };

  res.json({
    installed: true,
    certificate,
    connection,
    chainValid: result.authorized || (!leaf.expired && (result.chainLength > 0)),
    chainError: result.authError,
    ...result
  });
});

// POST /api/ssltools/validate-chain
router.post('/validate-chain', (req, res) => {
  const chainPem = String(req.body?.chain || req.body?.chainText || req.body?.pem || '').trim();
  if (!chainPem) return res.status(400).json({ error: 'Please paste a certificate chain in PEM format.' });

  const certMatches = chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (certMatches.length === 0) {
    return res.status(400).json({ error: 'No certificates found in chain.' });
  }

  const issues = [];
  const parsedCerts = certMatches.map((c, i) => {
    const d = decodeCertificate(c);
    if (d.expired) {
      issues.push(`Certificate #${i + 1} (${d.commonName || 'Unknown'}) is expired since ${d.validTo}`);
    }
    return {
      index: i,
      subject: d.subject || 'Unknown',
      commonName: d.commonName || 'Unknown',
      issuer: d.issuer || 'Unknown',
      validFrom: d.validFrom,
      validTo: d.validTo,
      daysLeft: d.daysLeft,
      expired: d.expired,
      isCa: d.isCa,
      fingerprint: d.fingerprint256 || d.fingerprint,
      fingerprint256: d.fingerprint256,
      subjectAltNames: d.subjectAltNames || []
    };
  });

  if (parsedCerts.length === 1 && !parsedCerts[0].isCa) {
    issues.push('Chain contains only the leaf certificate. Intermediate CA certificates appear to be missing.');
  }

  res.json({
    count: parsedCerts.length,
    certificates: parsedCerts,
    certs: parsedCerts,
    valid: issues.length === 0,
    issues
  });
});

// ALL /api/ssltools/ssllabs
router.all('/ssllabs', (req, res) => {
  const host = String(req.body?.hostname || req.body?.host || req.query?.host || req.query?.hostname || '').trim();
  if (!host) return res.status(400).json({ error: 'Hostname is required' });
  const cleanHost = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  res.json({
    host: cleanHost,
    url: `https://www.ssllabs.com/ssltest/analyze.html?d=${encodeURIComponent(cleanHost)}`
  });
});

module.exports = router;
