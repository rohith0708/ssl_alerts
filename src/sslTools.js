const crypto = require('crypto');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function execOpenSSL(args, input = null) {
  return new Promise((resolve, reject) => {
    const proc = execFile('openssl', args, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }
      resolve(stdout);
    });
    if (input && proc.stdin) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

function parseDnField(dn, field) {
  if (!dn) return null;
  const match = String(dn).split('\n').find(line => line.trim().startsWith(`${field}=`));
  return match ? match.trim().slice(field.length + 1) : null;
}

/**
 * Decodes an X.509 PEM certificate and extracts all relevant human-readable fields.
 */
function decodeCertificate(pem) {
  try {
    const cleanPem = String(pem || '').trim();
    if (!cleanPem.includes('-----BEGIN CERTIFICATE-----')) {
      return { error: 'Invalid certificate. Must include -----BEGIN CERTIFICATE----- header.' };
    }

    const cert = new crypto.X509Certificate(cleanPem);
    const validFrom = new Date(cert.validFrom);
    const validTo = new Date(cert.validTo);
    const now = Date.now();
    const daysLeft = Math.floor((validTo.getTime() - now) / (1000 * 60 * 60 * 24));

    let sans = [];
    if (cert.subjectAltName) {
      sans = cert.subjectAltName.split(',').map(s => s.trim().replace(/^DNS:/, ''));
    }

    const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
    const spkiHash = crypto.createHash('sha256').update(spkiDer).digest('hex');

    return {
      subject: cert.subject,
      commonName: parseDnField(cert.subject, 'CN') || cert.subject,
      organization: parseDnField(cert.subject, 'O'),
      issuer: cert.issuer,
      issuerCN: parseDnField(cert.issuer, 'CN') || parseDnField(cert.issuer, 'O') || cert.issuer,
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
      daysLeft,
      expired: daysLeft < 0,
      serialNumber: cert.serialNumber,
      fingerprint256: cert.fingerprint256,
      fingerprint: cert.fingerprint,
      subjectAltNames: sans,
      isCa: cert.ca === true,
      keyType: cert.publicKey.asymmetricKeyType,
      keySize: cert.publicKey.asymmetricKeyDetails?.modulusLength || null,
      spkiHash
    };
  } catch (err) {
    return { error: `Failed to decode certificate: ${err.message}` };
  }
}

/**
 * Decodes a PEM Certificate Signing Request (CSR) using OpenSSL.
 */
async function decodeCsr(pem) {
  try {
    const cleanPem = String(pem || '').trim();
    if (!cleanPem.includes('-----BEGIN CERTIFICATE REQUEST-----') && !cleanPem.includes('-----BEGIN NEW CERTIFICATE REQUEST-----')) {
      return { error: 'Invalid CSR. Must include -----BEGIN CERTIFICATE REQUEST----- header.' };
    }

    const text = await execOpenSSL(['req', '-noout', '-text'], cleanPem);
    const pubkeyPem = await execOpenSSL(['req', '-noout', '-pubkey'], cleanPem);

    const pubkey = crypto.createPublicKey(pubkeyPem);
    const spkiDer = pubkey.export({ type: 'spki', format: 'der' });
    const spkiHash = crypto.createHash('sha256').update(spkiDer).digest('hex');

    // Parse Subject from OpenSSL output
    const subjectMatch = text.match(/Subject:\s*(.+)/);
    const subject = subjectMatch ? subjectMatch[1].trim() : '';

    // Extract SANs from text if present
    const sanMatch = text.match(/X509v3 Subject Alternative Name:[^\n]*\n\s*([^\n]+)/);
    let sans = [];
    if (sanMatch) {
      sans = sanMatch[1].split(',').map(s => s.trim().replace(/^DNS:/, ''));
    }

    // Extract key details
    const keyMatch = text.match(/Subject Public Key Info:[\s\S]*?Public Key Algorithm:\s*([^\n]+)[\s\S]*?Public-Key:\s*\(([^\)]+)\)/);
    const keyType = keyMatch ? keyMatch[1].trim() : pubkey.asymmetricKeyType;
    const keySize = keyMatch ? keyMatch[2].trim() : (pubkey.asymmetricKeyDetails?.modulusLength ? `${pubkey.asymmetricKeyDetails.modulusLength} bit` : '');

    // Extract signature algorithm
    const sigMatch = text.match(/Signature Algorithm:\s*([^\n]+)/);
    const signatureAlgorithm = sigMatch ? sigMatch[1].trim() : null;

    // Helper parser for CN, O, C, etc.
    const getSubField = (f) => {
      const m = subject.match(new RegExp(`(?:^|,\\s*)${f}\\s*=\\s*([^,]+)`));
      return m ? m[1].trim() : null;
    };

    return {
      subject,
      commonName: getSubField('CN') || subject,
      organization: getSubField('O'),
      organizationalUnit: getSubField('OU'),
      locality: getSubField('L'),
      state: getSubField('ST'),
      country: getSubField('C'),
      subjectAltNames: sans,
      keyType,
      keySize,
      signatureAlgorithm,
      spkiHash
    };
  } catch (err) {
    return { error: `Failed to decode CSR: ${err.message}` };
  }
}

/**
 * Compares two cryptographic items:
 * - Certificate vs Private Key
 * - Certificate vs CSR
 * - CSR vs Private Key
 * Verifies if their public keys / moduli match via SPKI SHA-256 fingerprint comparison.
 */
async function matchKeyAndCert(inputA, inputB) {
  try {
    const aStr = String(inputA || '').trim();
    const bStr = String(inputB || '').trim();

    if (!aStr || !bStr) {
      return { error: 'Both input fields are required.' };
    }

    let parsedA, parsedB;

    // Detect type of A
    if (aStr.includes('CERTIFICATE REQUEST')) {
      parsedA = await decodeCsr(aStr);
      parsedA.type = 'CSR';
    } else if (aStr.includes('CERTIFICATE')) {
      parsedA = decodeCertificate(aStr);
      parsedA.type = 'Certificate';
    } else if (aStr.includes('PRIVATE KEY')) {
      try {
        const priv = crypto.createPrivateKey(aStr);
        const pub = crypto.createPublicKey(priv);
        const spki = pub.export({ type: 'spki', format: 'der' });
        parsedA = {
          type: 'Private Key',
          keyType: pub.asymmetricKeyType,
          keySize: pub.asymmetricKeyDetails?.modulusLength ? `${pub.asymmetricKeyDetails.modulusLength} bit` : null,
          spkiHash: crypto.createHash('sha256').update(spki).digest('hex')
        };
      } catch (e) {
        return { error: `First input is an unreadable private key: ${e.message}` };
      }
    } else {
      return { error: 'First input is neither a valid Certificate, CSR, nor Private Key.' };
    }

    if (parsedA.error) return { error: `Input 1 error: ${parsedA.error}` };

    // Detect type of B
    if (bStr.includes('PRIVATE KEY')) {
      try {
        const priv = crypto.createPrivateKey(bStr);
        const pub = crypto.createPublicKey(priv);
        const spki = pub.export({ type: 'spki', format: 'der' });
        parsedB = {
          type: 'Private Key',
          keyType: pub.asymmetricKeyType,
          keySize: pub.asymmetricKeyDetails?.modulusLength ? `${pub.asymmetricKeyDetails.modulusLength} bit` : null,
          spkiHash: crypto.createHash('sha256').update(spki).digest('hex')
        };
      } catch (e) {
        return { error: `Second input is an unreadable private key: ${e.message}` };
      }
    } else if (bStr.includes('CERTIFICATE REQUEST')) {
      parsedB = await decodeCsr(bStr);
      parsedB.type = 'CSR';
    } else if (bStr.includes('CERTIFICATE')) {
      parsedB = decodeCertificate(bStr);
      parsedB.type = 'Certificate';
    } else {
      return { error: 'Second input is neither a valid Private Key, CSR, nor Certificate.' };
    }

    if (parsedB.error) return { error: `Input 2 error: ${parsedB.error}` };

    const matches = parsedA.spkiHash.toLowerCase() === parsedB.spkiHash.toLowerCase();

    return {
      match: matches,
      itemA: {
        type: parsedA.type,
        commonName: parsedA.commonName || null,
        keyType: parsedA.keyType || null,
        keySize: parsedA.keySize || null,
        hash: parsedA.spkiHash
      },
      itemB: {
        type: parsedB.type,
        commonName: parsedB.commonName || null,
        keyType: parsedB.keyType || null,
        keySize: parsedB.keySize || null,
        hash: parsedB.spkiHash
      }
    };
  } catch (err) {
    return { error: `Comparison failed: ${err.message}` };
  }
}

/**
 * Performs a live TLS handshake against hostname:port and extracts the full certificate chain,
 * TLS protocol version, cipher suite, and trust status.
 * Protected against SSRF and internal port scanning via validatePublicHost.
 */
function checkLiveInstallation(hostname, port = 443) {
  return new Promise(async (resolve) => {
    let settled = false;
    let socket = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (socket) {
        try { socket.destroy(); } catch (_) {}
      }
      resolve(res);
    };

    const host = String(hostname || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const targetPort = Number(port) || 443;

    if (!host) {
      return finish({ error: 'Please enter a domain to check.' });
    }

    if (targetPort < 1 || targetPort > 65535) {
      return finish({ error: 'Invalid port number.' });
    }

    // SSRF Guard: reject private IP ranges, loopback, and cloud metadata
    try {
      const { validatePublicHost } = require('./security');
      const hostCheck = await validatePublicHost(host);
      if (!hostCheck.valid) {
        return finish({ error: hostCheck.error });
      }
    } catch (e) {
      return finish({ error: `Host validation failed: ${e.message}` });
    }

    socket = tls.connect(
      {
        host,
        port: targetPort,
        servername: host,
        timeout: 9000,
        rejectUnauthorized: false
      },
      () => {
        try {
          const rawLeaf = socket.getPeerCertificate(true);
          if (!rawLeaf || Object.keys(rawLeaf).length === 0) {
            return finish({ error: 'No certificate presented by server.' });
          }

          const protocol = socket.getProtocol();
          const cipher = socket.getCipher();
          const authorized = socket.authorized || false;
          const authError = socket.authorizationError || null;

          // Walk the certificate chain
          const chain = [];
          let current = rawLeaf;
          const seen = new Set();

          while (current && !seen.has(current.fingerprint)) {
            seen.add(current.fingerprint);
            const validFrom = new Date(current.valid_from);
            const validTo = new Date(current.valid_to);
            const daysLeft = Math.floor((validTo.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

            let sans = [];
            if (current.subjectaltname) {
              sans = current.subjectaltname.split(',').map(s => s.trim().replace(/^DNS:/, ''));
            }

            chain.push({
              subject: current.subject?.CN || current.subject?.O || 'Unknown',
              subjectFull: current.subject,
              issuer: current.issuer?.O || current.issuer?.CN || 'Unknown',
              issuerFull: current.issuer,
              validFrom: validFrom.toISOString(),
              validTo: validTo.toISOString(),
              daysLeft,
              expired: daysLeft < 0,
              serialNumber: current.serialNumber,
              fingerprint: current.fingerprint256 || current.fingerprint,
              subjectAltNames: sans
            });

            if (current.issuerCertificate && current.issuerCertificate !== current) {
              current = current.issuerCertificate;
            } else {
              break;
            }
          }

          finish({
            hostname: host,
            port: targetPort,
            authorized,
            authError,
            protocol,
            cipher: cipher ? `${cipher.name} (${cipher.version})` : 'Unknown',
            leaf: chain[0] || null,
            chain,
            chainLength: chain.length
          });
        } catch (err) {
          finish({ error: `Failed to inspect certificate chain: ${err.message}` });
        }
      }
    );

    socket.on('timeout', () => finish({ error: 'Connection timed out after 9 seconds.' }));
    socket.on('error', (err) => finish({ error: err.message || 'Connection failed.' }));
  });
}

/**
 * Generates an Internal Root CA and a domain certificate signed by it,
 * complete with SAN extensions and web server configuration.
 */
async function generateSelfSignedBundle({ domain, sans = [], caName, organization, orgUnit, country, state, city, days = 365, keySize = 2048 }) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hsa-selfsigned-'));
  try {
    const cleanDomain = String(domain || '').trim().toLowerCase();
    if (!cleanDomain) throw new Error('Domain / Common Name is required.');

    const kSize = [2048, 3072, 4096].includes(Number(keySize)) ? Number(keySize) : 2048;
    const certDays = Math.max(1, Math.min(3650, Number(days) || 365));
    const caOrg = organization || 'Internal Infrastructure';
    const caCn = caName || `${cleanDomain} Internal Root CA`;
    const cCode = (country || 'IN').slice(0, 2).toUpperCase();

    const caKeyPath = path.join(tmpDir, 'ca.key');
    const caCrtPath = path.join(tmpDir, 'ca.crt');
    const srvKeyPath = path.join(tmpDir, 'server.key');
    const srvCsrPath = path.join(tmpDir, 'server.csr');
    const srvCrtPath = path.join(tmpDir, 'server.crt');
    const extPath = path.join(tmpDir, 'server.ext');

    // 1. Generate Root CA Key
    await execOpenSSL(['genrsa', '-out', caKeyPath, String(kSize)]);

    // 2. Generate Root CA Certificate (10 years)
    const caSubj = `/CN=${caCn}/O=${caOrg}/C=${cCode}`;
    await execOpenSSL(['req', '-x509', '-new', '-nodes', '-key', caKeyPath, '-sha256', '-days', '3650', '-out', caCrtPath, '-subj', caSubj]);

    // 3. Generate Server Key
    await execOpenSSL(['genrsa', '-out', srvKeyPath, String(kSize)]);

    // 4. Generate Server CSR
    let srvSubj = `/CN=${cleanDomain}/O=${caOrg}/C=${cCode}`;
    if (orgUnit) srvSubj += `/OU=${orgUnit}`;
    if (state) srvSubj += `/ST=${state}`;
    if (city) srvSubj += `/L=${city}`;
    await execOpenSSL(['req', '-new', '-key', srvKeyPath, '-out', srvCsrPath, '-subj', srvSubj]);

    // 5. Build SAN extension config
    const sanList = new Set();
    if (cleanDomain) sanList.add(cleanDomain);
    if (Array.isArray(sans)) {
      sans.forEach(s => {
        const item = String(s || '').trim();
        if (item) sanList.add(item);
      });
    }
    const sanLine = Array.from(sanList).map(s => {
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s) || s.includes(':')) {
        return `IP:${s}`;
      }
      return `DNS:${s}`;
    }).join(',');

    const extContent = [
      'basicConstraints = CA:FALSE',
      'keyUsage = digitalSignature, keyEncipherment',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = ${sanLine}`
    ].join('\n');

    await fs.promises.writeFile(extPath, extContent, 'utf8');

    // 6. Sign Server Certificate with Root CA
    await execOpenSSL([
      'x509', '-req', '-in', srvCsrPath,
      '-CA', caCrtPath, '-CAkey', caKeyPath, '-CAcreateserial',
      '-out', srvCrtPath, '-days', String(certDays), '-sha256',
      '-extfile', extPath
    ]);

    // Read generated files
    const caKey = await fs.promises.readFile(caKeyPath, 'utf8');
    const caCrt = await fs.promises.readFile(caCrtPath, 'utf8');
    const serverKey = await fs.promises.readFile(srvKeyPath, 'utf8');
    const serverCsr = await fs.promises.readFile(srvCsrPath, 'utf8');
    const serverCrt = await fs.promises.readFile(srvCrtPath, 'utf8');

    // Generate Nginx & Apache configurations
    const nginxConfig = [
      `# Nginx SSL Configuration for ${cleanDomain}`,
      `server {`,
      `    listen 443 ssl http2;`,
      `    server_name ${Array.from(sanList).join(' ')};`,
      ``,
      `    ssl_certificate     /etc/ssl/certs/${cleanDomain}.crt;`,
      `    ssl_certificate_key /etc/ssl/private/${cleanDomain}.key;`,
      ``,
      `    ssl_protocols TLSv1.2 TLSv1.3;`,
      `    ssl_ciphers HIGH:!aNULL:!MD5;`,
      `}`
    ].join('\n');

    const apacheConfig = [
      `# Apache SSL Configuration for ${cleanDomain}`,
      `<VirtualHost *:443>`,
      `    ServerName ${cleanDomain}`,
      Array.from(sanList).filter(s => s !== cleanDomain).map(s => `    ServerAlias ${s}`).join('\n'),
      `    SSLEngine on`,
      `    SSLCertificateFile    /etc/ssl/certs/${cleanDomain}.crt`,
      `    SSLCertificateKeyFile /etc/ssl/private/${cleanDomain}.key`,
      `</VirtualHost>`
    ].filter(Boolean).join('\n');

    return {
      domain: cleanDomain,
      sans: Array.from(sanList),
      caName: caCn,
      days: certDays,
      caKey,
      caCrt,
      serverKey,
      serverCsr,
      serverCrt,
      nginxConfig,
      apacheConfig
    };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Generates an RSA private key and Certificate Signing Request (CSR).
 */
async function generateCsrBundle({ domain, sans = [], organization, orgUnit, country, state, city, email, keySize = 2048 }) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hsa-csr-'));
  try {
    const cleanDomain = String(domain || '').trim().toLowerCase();
    if (!cleanDomain) throw new Error('Domain / Common Name is required.');

    const kSize = [2048, 3072, 4096].includes(Number(keySize)) ? Number(keySize) : 2048;
    const keyPath = path.join(tmpDir, 'private.key');
    const csrPath = path.join(tmpDir, 'request.csr');
    const cnfPath = path.join(tmpDir, 'csr.cnf');

    // 1. Generate Private Key
    await execOpenSSL(['genrsa', '-out', keyPath, String(kSize)]);

    // 2. Build OpenSSL config with SANs
    const sanList = new Set();
    if (cleanDomain) sanList.add(cleanDomain);
    if (Array.isArray(sans)) {
      sans.forEach(s => {
        const item = String(s || '').trim();
        if (item) sanList.add(item);
      });
    }
    const sanLine = Array.from(sanList).map(s => {
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s) || s.includes(':')) {
        return `IP:${s}`;
      }
      return `DNS:${s}`;
    }).join(',');

    const cCode = (country || 'IN').slice(0, 2).toUpperCase();

    const cnfContent = [
      '[req]',
      'default_bits = ' + kSize,
      'prompt = no',
      'default_md = sha256',
      'req_extensions = req_ext',
      'distinguished_name = dn',
      '',
      '[dn]',
      `CN = ${cleanDomain}`,
      organization ? `O = ${organization}` : '',
      orgUnit ? `OU = ${orgUnit}` : '',
      city ? `L = ${city}` : '',
      state ? `ST = ${state}` : '',
      `C = ${cCode}`,
      email ? `emailAddress = ${email}` : '',
      '',
      '[req_ext]',
      `subjectAltName = ${sanLine}`
    ].filter(line => line !== '').join('\n');

    await fs.promises.writeFile(cnfPath, cnfContent, 'utf8');

    // 3. Generate CSR
    await execOpenSSL(['req', '-new', '-key', keyPath, '-out', csrPath, '-config', cnfPath]);

    const privateKey = await fs.promises.readFile(keyPath, 'utf8');
    const csr = await fs.promises.readFile(csrPath, 'utf8');

    return {
      domain: cleanDomain,
      sans: Array.from(sanList),
      keySize: kSize,
      privateKey,
      csr
    };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  decodeCertificate,
  decodeCsr,
  matchKeyAndCert,
  checkLiveInstallation,
  generateSelfSignedBundle,
  generateCsrBundle
};
