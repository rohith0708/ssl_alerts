const express = require('express');
const crypto = require('crypto');
const zlib = require('zlib');
const tar = require('tar-stream');
const acme = require('acme-client');
const { db } = require('../db');
const {
  decodeCertificate,
  decodeCsr,
  matchKeyAndCert,
  checkLiveInstallation,
  generateSelfSignedBundle,
  generateCsrBundle
} = require('../sslTools');

const router = express.Router();

const { requireAuth } = require('../auth');
router.use(requireAuth);

// In-memory store for pending Let's Encrypt ACME orders
const pendingOrders = new Map();

// Periodic cleanup of abandoned orders older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, data] of pendingOrders) {
    if (data.createdAt < cutoff) pendingOrders.delete(id);
  }
}, 10 * 60 * 1000).unref();

// ---------------- List & Download Certificates ----------------

router.get('/', async (req, res) => {
  try {
    const certs = await db.getAll(`
      SELECT id, type, domain, status, expires_at, created_at
      FROM generated_certificates
      WHERE user_id = ?
      ORDER BY id DESC
    `, [req.userId]);
    res.json(certs);
  } catch (err) {
    console.error('Error listing certificates:', err);
    res.status(500).json({ error: 'Failed to load certificates.' });
  }
});

router.get('/download/:id', async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.getOne(`
    SELECT id, user_id, type, domain, status, files_json, expires_at, created_at
    FROM generated_certificates
    WHERE id = ? AND user_id = ?
  `, [id, req.userId]);

  if (!row) {
    return res.status(404).json({ error: 'Certificate not found.' });
  }

  let files = {};
  try {
    files = JSON.parse(row.files_json || '{}');
  } catch (_) {
    return res.status(500).json({ error: 'Corrupt certificate files data.' });
  }

  const cleanDomain = (row.domain || 'cert').replace(/[^a-zA-Z0-9.-]/g, '_');
  const filename = `${row.type}-${cleanDomain}.tar.gz`;

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const pack = tar.pack();
  const gzip = zlib.createGzip();

  pack.pipe(gzip).pipe(res);

  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.from(content, 'utf8');
    pack.entry({ name, size: buf.length, mode: 0o644 }, buf);
  }

  pack.finalize();
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const info = await db.execute(`
      DELETE FROM generated_certificates
      WHERE id = ? AND user_id = ?
    `, [id, req.userId]);

    if (info.affectedRows === 0) return res.status(404).json({ error: 'Certificate not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting certificate:', err);
    res.status(500).json({ error: 'Failed to delete certificate.' });
  }
});

// ---------------- 1. Self-Signed Certificate & Root CA ----------------

async function handleSelfSigned(req, res) {
  const { domain, commonName, sans, organization, organizationalUnit, locality, state, country, validityDays, keySize } = req.body || {};
  const targetDomain = String(domain || commonName || '').trim().toLowerCase();

  if (!targetDomain) {
    return res.status(400).json({ error: 'Domain / Common Name is required.' });
  }

  try {
    const bundle = await generateSelfSignedBundle({
      domain: targetDomain,
      sans: Array.isArray(sans) ? sans : [],
      organization: organization || 'My Company Inc',
      orgUnit: organizationalUnit || '',
      country: country || 'IN',
      state: state || '',
      city: locality || '',
      days: Number(validityDays) || 365,
      keySize: Number(keySize) || 2048
    });

    const files = {
      'ca.crt': bundle.caCrt,
      'ca.key': bundle.caKey,
      [`${targetDomain}.crt`]: bundle.serverCrt,
      [`${targetDomain}.key`]: bundle.serverKey,
      [`${targetDomain}.csr`]: bundle.serverCsr,
      'nginx.conf': bundle.nginxConfig,
      'apache.conf': bundle.apacheConfig,
      'README.txt': [
        `Self-Signed Certificate & Internal Root CA for ${targetDomain}`,
        `Generated: ${new Date().toISOString()}`,
        `-------------------------------------------------------`,
        `1. Install ca.crt in your operating system or browser trusted roots.`,
        `2. Deploy ${targetDomain}.crt and ${targetDomain}.key to your web server.`,
        `3. See nginx.conf or apache.conf for server configuration snippets.`
      ].join('\n')
    };

    let expiresAt = null;
    try {
      const x = new crypto.X509Certificate(bundle.serverCrt);
      expiresAt = new Date(x.validTo).toISOString().slice(0, 19).replace('T', ' ');
    } catch (_) {
      expiresAt = new Date(Date.now() + (Number(validityDays) || 365) * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    }

    const info = await db.execute(`
      INSERT INTO generated_certificates (user_id, type, domain, status, files_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      req.userId,
      'selfsigned',
      targetDomain,
      'completed',
      JSON.stringify(files),
      expiresAt
    ]);

    res.json({
      id: info.insertId,
      domain: targetDomain,
      caCert: bundle.caCrt,
      domainCert: bundle.serverCrt,
      files: Object.keys(files)
    });
  } catch (err) {
    console.error('Error generating self-signed certificate:', err);
    res.status(500).json({ error: `Failed to generate self-signed certificate: ${err.message}` });
  }
}

router.post('/selfsigned', handleSelfSigned);
router.post('/self-signed', handleSelfSigned);

// ---------------- 2. CSR Generator ----------------

router.post('/csr', async (req, res) => {
  const { domain, commonName, sans, organization, organizationalUnit, locality, state, country, email, keySize } = req.body || {};
  const targetDomain = String(domain || commonName || '').trim().toLowerCase();

  if (!targetDomain) {
    return res.status(400).json({ error: 'Domain / Common Name is required.' });
  }

  try {
    const bundle = await generateCsrBundle({
      domain: targetDomain,
      sans: Array.isArray(sans) ? sans : [],
      organization: organization || '',
      orgUnit: organizationalUnit || '',
      country: country || 'IN',
      state: state || '',
      city: locality || '',
      email: email || '',
      keySize: Number(keySize) || 2048
    });

    const files = {
      [`${targetDomain}.csr`]: bundle.csr,
      [`${targetDomain}.key`]: bundle.privateKey,
      'README.txt': [
        `CSR & Private Key for ${targetDomain}`,
        `Generated: ${new Date().toISOString()}`,
        `-------------------------------------------------------`,
        `Submit ${targetDomain}.csr to your Certificate Authority (DigiCert, Sectigo, Let's Encrypt, etc.).`,
        `Keep ${targetDomain}.key confidential on your server.`
      ].join('\n')
    };

    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    const info = await db.execute(`
      INSERT INTO generated_certificates (user_id, type, domain, status, files_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      req.userId,
      'csr',
      targetDomain,
      'completed',
      JSON.stringify(files),
      expiresAt
    ]);

    res.json({
      id: info.insertId,
      domain: targetDomain,
      csrText: bundle.csr,
      keyText: bundle.privateKey,
      files: Object.keys(files)
    });
  } catch (err) {
    console.error('Error generating CSR:', err);
    res.status(500).json({ error: `Failed to generate CSR: ${err.message}` });
  }
});

// ---------------- 3. Let's Encrypt ACME Flow ----------------

router.post('/letsencrypt/start', async (req, res) => {
  const rawDomain = String(req.body?.domain || '').trim().toLowerCase()
    .replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const email = String(req.body?.email || '').trim().toLowerCase();
  const staging = req.body?.staging === true || req.body?.staging === 'true';

  if (!rawDomain || !rawDomain.includes('.')) {
    return res.status(400).json({ error: 'Please enter a valid domain name, e.g. example.com' });
  }

  try {
    const accountKey = await acme.crypto.createPrivateKey();
    const client = new acme.Client({
      directoryUrl: staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
      accountKey
    });

    await client.createAccount({
      termsOfServiceAgreed: true,
      contact: email ? [`mailto:${email}`] : []
    });

    const [domainKey, domainCsr] = await acme.crypto.createCsr({
      commonName: rawDomain
    });

    const order = await client.createOrder({
      identifiers: [{ type: 'dns', value: rawDomain }]
    });

    const authorizations = await client.getAuthorizations(order);
    const challenges = [];

    for (const authz of authorizations) {
      const dnsChallenge = authz.challenges.find(c => c.type === 'dns-01');
      if (dnsChallenge) {
        const keyAuth = await client.getChallengeKeyAuthorization(dnsChallenge);
        challenges.push({
          identifier: authz.identifier.value,
          recordType: 'TXT',
          recordName: `_acme-challenge.${authz.identifier.value}`,
          recordValue: keyAuth,
          challenge: dnsChallenge
        });
      }
    }

    if (challenges.length === 0) {
      return res.status(500).json({ error: "Let's Encrypt did not return any DNS challenges for this domain." });
    }

    const orderId = crypto.randomUUID();
    pendingOrders.set(orderId, {
      orderId,
      userId: req.userId,
      domain: rawDomain,
      staging,
      client,
      order,
      domainKey: domainKey.toString(),
      domainCsr,
      challenges,
      createdAt: Date.now()
    });

    res.json({
      id: orderId,
      orderId,
      domain: rawDomain,
      staging,
      challenges: challenges.map(c => ({
        identifier: c.identifier,
        recordType: c.recordType,
        recordName: c.recordName,
        recordValue: c.recordValue
      }))
    });
  } catch (err) {
    console.error("Error starting Let's Encrypt challenge:", err);
    res.status(500).json({ error: `Failed to initiate Let's Encrypt challenge: ${err.message}` });
  }
});

async function handleCompleteLetsEncrypt(req, res) {
  const orderId = String(req.params?.id || req.body?.orderId || '').trim();
  if (!orderId || !pendingOrders.has(orderId)) {
    return res.status(400).json({ error: 'Session expired or invalid order ID. Please start over.' });
  }

  const orderData = pendingOrders.get(orderId);
  const { client, order, domainCsr, domainKey, domain, challenges } = orderData;

  try {
    for (const item of challenges) {
      await client.completeChallenge(item.challenge);
      await client.waitForValidStatus(item.challenge);
    }

    await client.finalizeOrder(order, domainCsr);
    const certBundle = await client.getCertificate(order);

    const certs = certBundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    const cert = certs[0] || certBundle;
    const chain = certs.slice(1).join('\n') || '';
    const fullchain = certBundle;
    const privkey = domainKey;

    const files = {
      'cert.pem': cert,
      'privkey.pem': privkey,
      'chain.pem': chain,
      'fullchain.pem': fullchain,
      'README.txt': [
        `Let's Encrypt Certificate Bundle for: ${domain}`,
        `Generated on: ${new Date().toISOString()}`,
        `-------------------------------------------------------`,
        `FILES:`,
        `  - cert.pem:      Domain certificate`,
        `  - privkey.pem:   Private key`,
        `  - chain.pem:     Intermediate CA chain`,
        `  - fullchain.pem: Full certificate chain`
      ].join('\n')
    };

    let expiresAt = null;
    try {
      const x = new crypto.X509Certificate(cert);
      expiresAt = new Date(x.validTo).toISOString().slice(0, 19).replace('T', ' ');
    } catch (_) {
      expiresAt = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    }

    const info = await db.execute(`
      INSERT INTO generated_certificates (user_id, type, domain, status, files_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      req.userId,
      'letsencrypt',
      domain,
      'completed',
      JSON.stringify(files),
      expiresAt
    ]);

    pendingOrders.delete(orderId);

    res.json({
      id: info.insertId,
      domain,
      cert,
      chain,
      fullchain,
      privkey,
      files: Object.keys(files)
    });
  } catch (err) {
    console.error("Error completing Let's Encrypt verification:", err);
    res.status(500).json({ error: `Verification failed: ${err.message}` });
  }
}

router.post('/letsencrypt/complete/:id', handleCompleteLetsEncrypt);
router.post('/letsencrypt/verify', handleCompleteLetsEncrypt);

// Backwards compatibility endpoints for SSL tools
router.post('/match', async (req, res) => {
  const { inputA, inputB } = req.body || {};
  if (!inputA || !inputB) return res.status(400).json({ error: 'Please enter both items to compare.' });
  const result = await matchKeyAndCert(inputA, inputB);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.post('/decode-cert', (req, res) => {
  const pem = String(req.body?.pem || '').trim();
  if (!pem) return res.status(400).json({ error: 'Paste a certificate PEM block first.' });
  const result = decodeCertificate(pem);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.post('/decode-csr', async (req, res) => {
  const pem = String(req.body?.pem || '').trim();
  if (!pem) return res.status(400).json({ error: 'Paste a CSR PEM block first.' });
  const result = await decodeCsr(pem);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.get('/check-install', async (req, res) => {
  const domain = String(req.query?.domain || '').trim();
  const port = Number(req.query?.port) || 443;
  if (!domain) return res.status(400).json({ error: 'Please enter a domain to check.' });
  const result = await checkLiveInstallation(domain, port);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

module.exports = router;
