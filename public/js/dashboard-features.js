// Dashboard Navigation and SSL Tools Functionality
let currentSection = 'domains';

// Navigation Functions
function showSection(sectionName, updateHash = true) {
  // Hide all sections
  document.querySelectorAll('.dashboard-section').forEach(section => {
    section.style.display = 'none';
  });

  // Show selected section
  const target = document.getElementById(sectionName + 'Section');
  if (target) target.style.display = 'block';

  // Update navigation
  document.querySelectorAll('.sidebar nav a').forEach(link => {
    link.classList.remove('active');
  });

  // Update title and active nav
  const titles = {
    domains: 'Monitor domains',
    sslTools: 'SSL Tools',
    certificates: 'Certificate Generator',
    alertEmails: 'Alert Email Recipients',
    dnsLookup: 'DNS Lookup',
    docs: 'Documentation'
  };

  const titleEl = document.getElementById('mainTitle');
  if (titleEl) titleEl.textContent = titles[sectionName] || 'Monitor domains';
  currentSection = sectionName;

  // Highlight active link in sidebar
  const activeLink = document.querySelector(`.sidebar nav [data-section="${sectionName}"]`);
  if (activeLink) activeLink.classList.add('active');

  if (updateHash) {
    const hashes = {
      domains: '#domains',
      sslTools: '#ssl-tools',
      certificates: '#certificates',
      alertEmails: '#alert-emails',
      dnsLookup: '#dns-lookup',
      docs: '#docs'
    };
    if (window.location.hash !== hashes[sectionName]) {
      history.replaceState(null, null, hashes[sectionName] || '#domains');
    }
  }
}

function showDomains(e) {
  if (e && e.preventDefault) e.preventDefault();
  showSection('domains');
  if (typeof loadDomainAlertEmails === 'function') loadDomainAlertEmails();
}

function showSSLTools(e) {
  if (e && e.preventDefault) e.preventDefault();
  showSection('sslTools');
}

function showCertificates(e, tab = 'cert-generator-letsencrypt') {
  if (e && e.preventDefault) e.preventDefault();
  if (tab === 'cert-generated-certificates' && window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'certificates';
      showAuthModal('login', 'Sign in or register to access and download your generated certificates');
    }
    return;
  }
  showSection('certificates');

  // Activate only the selected generator tab (default: Let's Encrypt)
  document.querySelectorAll('.cert-mode-link').forEach(item => {
    item.classList.toggle('active', item.dataset.target === tab);
  });
  document.querySelectorAll('.certificate-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === tab);
  });

  if (tab === 'cert-generated-certificates') {
    loadCertificates();
  }
}

function showAlertEmails(e) {
  if (e && e.preventDefault) e.preventDefault();
  showSection('alertEmails');
  loadAlertEmails();
}

function showDNSLookup(e) {
  if (e && e.preventDefault) e.preventDefault();
  showSection('dnsLookup');
}

function showDocs(e) {
  if (e && e.preventDefault) e.preventDefault();
  showSection('docs');
}

function handleBrandClick(e) {
  if (e && e.preventDefault) e.preventDefault();
  showDomains(e);
}

function handleDomainsNav(e) {
  if (e && e.preventDefault) e.preventDefault();
  showDomains(e);
}

function handleAlertEmailsNav(e) {
  if (e && e.preventDefault) e.preventDefault();
  showAlertEmails(e);
}

function handlePlansNav(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (typeof openUpgradeModal === 'function') {
    openUpgradeModal();
  }
}

function scrollDocSection(e, targetId) {
  if (e && e.preventDefault) e.preventDefault();
  const el = document.getElementById(targetId);
  const container = document.querySelector('.dashboard-docs-wrap .docs-content');
  if (el && container) {
    const elTop = el.offsetTop - container.offsetTop;
    container.scrollTo({ top: Math.max(0, elTop - 12), behavior: 'smooth' });
    history.replaceState(null, null, `#docs-${targetId}`);
  } else if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, null, `#docs-${targetId}`);
  }
}

function initializeSSLToolTabs() {
  document.querySelectorAll('.ssl-tool-link').forEach(link => {
    link.addEventListener('click', () => {
      const target = link.dataset.target;
      document.querySelectorAll('.ssl-tool-link').forEach(item => item.classList.toggle('active', item === link));
      document.querySelectorAll('.tool-panel').forEach(panel => panel.classList.toggle('active', panel.id === target));
    });
  });
}

function initializeCertificateTabs() {
  initCsrSans();
  initSelfSignedSans();
  initCertTypeFilters();
  document.querySelectorAll('.cert-mode-link').forEach(link => {
    link.addEventListener('click', (e) => {
      const target = link.dataset.target;
      if (target === 'cert-generated-certificates' && window.isGuest) {
        if (typeof showAuthModal === 'function') {
          window.pendingAuthDestination = 'certificates';
          showAuthModal('login', 'Sign in or register to access and download your generated certificates');
        }
        return;
      }

      document.querySelectorAll('.cert-mode-link').forEach(item => item.classList.toggle('active', item === link));
      document.querySelectorAll('.certificate-panel').forEach(panel => panel.classList.toggle('active', panel.id === target));

      if (target === 'cert-generator-csr') {
        initCsrSans();
      }

      if (target === 'cert-generated-certificates') {
        loadCertificates();
      }
    });
  });
}

function handleHashRoute() {
  const hash = (window.location.hash || '').toLowerCase();
  if (hash === '#certificates') {
    showCertificates(null, 'cert-generator-letsencrypt');
  } else if (hash === '#ssl-tools' || hash === '#ssltools') {
    showSSLTools();
  } else if (hash === '#alert-emails' || hash === '#alertemails') {
    showAlertEmails();
  } else if (hash === '#dns-lookup' || hash === '#dnslookup' || hash === '#tools') {
    showDNSLookup();
  } else if (hash.startsWith('#docs')) {
    showDocs();
    const docTarget = hash.replace(/^#docs-?/, '');
    if (docTarget) {
      setTimeout(() => {
        const el = document.getElementById(docTarget);
        const container = document.querySelector('.dashboard-docs-wrap .docs-content');
        if (el && container) {
          const elTop = el.offsetTop - container.offsetTop;
          container.scrollTo({ top: Math.max(0, elTop - 12), behavior: 'smooth' });
        } else if (el) {
          el.scrollIntoView({ behavior: 'smooth' });
        }
      }, 100);
    }
  } else {
    if (hash === '#domains' || hash === '#monitor-domains') {
      showDomains();
    } else if (window.isGuest === true) {
      showDNSLookup();
    } else {
      showDomains();
    }
  }
}

async function startLetsEncryptQuick() {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'certificates';
      showAuthModal('login', 'Sign in or register to generate SSL certificates');
    }
    return;
  }

  const domain = document.getElementById('leDomainQuick')?.value?.trim();
  if (!domain) {
    toast('Please enter a domain name first.', true);
    return;
  }

  const modal = document.getElementById('certModal');
  const title = document.getElementById('certModalTitle');
  const body = document.getElementById('certModalBody');

  // Open the modal in LE mode first so the step elements exist in the DOM
  title.textContent = "🔐 Generate Let's Encrypt Certificate";
  body.innerHTML = getCertModalContent('letsencrypt');
  modal.style.display = 'flex';

  // Pre-fill the domain field (visible for a moment before step2 replaces it)
  const input = document.getElementById('leDomain');
  if (input) input.value = domain;

  // Call the API directly — DO NOT submit the form again (that causes a second domain prompt)
  try {
    const res = await fetch('/api/certificates/letsencrypt/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentCertificateId = data.id;
    sessionStorage.setItem('leCertId', data.id);

    const step1 = document.getElementById('letsencryptStep1');
    const step2 = document.getElementById('letsencryptStep2');
    const dnsInstructions = document.getElementById('dnsInstructions');

    if (step1 && step2) {
      step1.style.display = 'none';
      step2.style.display = 'block';
      if (dnsInstructions) {
        dnsInstructions.innerHTML = `
          <div class="field full">
            <label>Record Type</label>
            <input type="text" value="TXT" readonly>
          </div>
          <div class="field full">
            <label>Name</label>
            <input type="text" value="${data.challenges[0].recordName}" readonly>
          </div>
          <div class="field full">
            <label>Value</label>
            <input type="text" value="${data.challenges[0].recordValue}" readonly>
          </div>
        `;
      }
    }
  } catch (err) {
    toast("Failed to start Let's Encrypt generation: " + err.message, true);
  }
}

// SSL Tools Functions
async function decodeCertificate() {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'sslTools';
      showAuthModal('login', 'Sign in or register to decode SSL certificates');
    }
    return;
  }

  const certText = document.getElementById('certDecoderInput').value.trim();
  const resultEl = document.getElementById('certDecoderResult');

  if (!certText) {
    showResult(resultEl, 'Please enter a certificate in PEM format.', 'error');
    return;
  }

  showResult(resultEl, '<h4>Decoding...</h4><p>Analyzing certificate fields and cryptography...</p>', 'info');

  try {
    const res = await fetch('/api/ssltools/decode-cert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ certText, pem: certText })
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to decode certificate');
    }

    const sansHtml = (data.subjectAltNames && data.subjectAltNames.length > 0)
      ? data.subjectAltNames.map(s => `<span class="san-tag-badge">${escapeHtml(s)}</span>`).join('')
      : '<span style="color:#94a3b8">None</span>';

    const statusBadge = data.expired
      ? '<span style="background:#fee2e2;color:#dc2626;padding:3px 10px;border-radius:12px;font-weight:700;font-size:12px;">Expired</span>'
      : `<span style="background:#dcfce7;color:#16a34a;padding:3px 10px;border-radius:12px;font-weight:700;font-size:12px;">Valid (${data.daysLeft} days remaining)</span>`;

    const html = `
      <div class="ssl-tool-detail-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #f1f5f9;">
          <h4 style="margin:0;color:#0A2740;font-size:15px;font-weight:700;">📜 Certificate Details</h4>
          ${statusBadge}
        </div>
        <table class="ssl-detail-table">
          <tr><th>Common Name (CN)</th><td><strong>${escapeHtml(data.commonName || 'N/A')}</strong></td></tr>
          <tr><th>Organization (O)</th><td>${escapeHtml(data.organization || 'N/A')}</td></tr>
          <tr><th>Issuer</th><td>${escapeHtml(data.issuerCN || data.issuer || 'N/A')}</td></tr>
          <tr><th>Valid From</th><td>${escapeHtml(data.validFrom || 'N/A')}</td></tr>
          <tr><th>Valid To</th><td>${escapeHtml(data.validTo || 'N/A')}</td></tr>
          <tr><th>SANs (Alt Names)</th><td>${sansHtml}</td></tr>
          <tr><th>Key Details</th><td>${escapeHtml(data.keyType || 'RSA')} ${data.keySize ? `${escapeHtml(String(data.keySize))}-bit` : ''}</td></tr>
          <tr><th>Serial Number</th><td><code style="font-size:11px;">${escapeHtml(data.serialNumber || 'N/A')}</code></td></tr>
          <tr><th>SHA-256 Fingerprint</th><td><code style="font-size:11px;">${escapeHtml(data.fingerprint256 || 'N/A')}</code></td></tr>
          <tr><th>SHA-1 Fingerprint</th><td><code style="font-size:11px;">${escapeHtml(data.fingerprint || 'N/A')}</code></td></tr>
        </table>
      </div>
    `;

    showResult(resultEl, html, data.expired ? 'error' : 'success');
  } catch (err) {
    showResult(resultEl, `<h4>Error</h4><p>${escapeHtml(err.message)}</p>`, 'error');
  }
}

async function decodeCSR() {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'sslTools';
      showAuthModal('login', 'Sign in or register to decode Certificate Signing Requests (CSR)');
    }
    return;
  }

  const csrText = document.getElementById('csrDecoderInput').value.trim();
  const resultEl = document.getElementById('csrDecoderResult');

  if (!csrText) {
    showResult(resultEl, 'Please enter a CSR in PEM format.', 'error');
    return;
  }

  showResult(resultEl, '<h4>Decoding...</h4><p>Parsing Certificate Signing Request...</p>', 'info');

  try {
    const res = await fetch('/api/ssltools/decode-csr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrText, pem: csrText })
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to decode CSR');
    }

    const sansHtml = (data.subjectAltNames && data.subjectAltNames.length > 0)
      ? data.subjectAltNames.map(s => `<span class="san-tag-badge">${escapeHtml(s)}</span>`).join('')
      : '<span style="color:#94a3b8">None</span>';

    const html = `
      <div class="ssl-tool-detail-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #f1f5f9;">
          <h4 style="margin:0;color:#0A2740;font-size:15px;font-weight:700;">📝 Certificate Signing Request (CSR)</h4>
          <span style="background:#e0f2fe;color:#0369a1;padding:3px 10px;border-radius:12px;font-weight:700;font-size:12px;">Valid Request</span>
        </div>
        <table class="ssl-detail-table">
          <tr><th>Common Name (CN)</th><td><strong>${escapeHtml(data.commonName || 'N/A')}</strong></td></tr>
          <tr><th>Organization (O)</th><td>${escapeHtml(data.organization || 'N/A')}</td></tr>
          <tr><th>Organizational Unit (OU)</th><td>${escapeHtml(data.organizationalUnit || 'N/A')}</td></tr>
          <tr><th>Locality / City</th><td>${escapeHtml(data.locality || 'N/A')}</td></tr>
          <tr><th>State / Province</th><td>${escapeHtml(data.state || 'N/A')}</td></tr>
          <tr><th>Country (C)</th><td>${escapeHtml(data.country || 'N/A')}</td></tr>
          <tr><th>SANs (Alt Names)</th><td>${sansHtml}</td></tr>
          <tr><th>Key Info</th><td>${escapeHtml(data.keyType || 'RSA')} ${escapeHtml(data.keySize || '')}</td></tr>
          <tr><th>Signature Algorithm</th><td>${escapeHtml(data.signatureAlgorithm || 'N/A')}</td></tr>
          <tr><th>SPKI SHA-256 Hash</th><td><code style="font-size:11px;">${escapeHtml(data.spkiHash || 'N/A')}</code></td></tr>
        </table>
      </div>
    `;

    showResult(resultEl, html, 'success');
  } catch (err) {
    showResult(resultEl, `<h4>Error</h4><p>${escapeHtml(err.message)}</p>`, 'error');
  }
}

async function matchCertKey() {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'sslTools';
      showAuthModal('login', 'Sign in or register to test certificate and key matching');
    }
    return;
  }

  const certText = document.getElementById('matchCertInput').value.trim();
  const keyText = document.getElementById('matchKeyInput').value.trim();
  const resultEl = document.getElementById('matchResult');

  if (!certText || !keyText) {
    showResult(resultEl, 'Please enter both certificate and private key.', 'error');
    return;
  }

  showResult(resultEl, '<h4>Comparing...</h4><p>Calculating cryptographic modulus and SPKI fingerprints...</p>', 'info');

  try {
    const res = await fetch('/api/ssltools/match-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ certText, keyText, inputA: certText, inputB: keyText })
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to match certificate and key');
    }

    const isMatch = !!data.match;
    const icon = isMatch ? '✅' : '❌';
    const badge = isMatch
      ? '<span style="background:#dcfce7;color:#16a34a;padding:4px 10px;border-radius:14px;font-weight:700;font-size:13px;">Exact Match</span>'
      : '<span style="background:#fee2e2;color:#dc2626;padding:4px 10px;border-radius:14px;font-weight:700;font-size:13px;">Mismatch</span>';

    const html = `
      <div class="ssl-tool-detail-card" style="border-left: 4px solid ${isMatch ? '#16a34a' : '#dc2626'};">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <h4 style="margin:0;color:#0A2740;font-size:15px;font-weight:700;">${icon} Key Pair Verification</h4>
          ${badge}
        </div>
        <p style="margin:0 0 12px 0;font-size:13px;color:#334155;">${escapeHtml(data.message || '')}</p>
        ${data.itemA && data.itemB ? `
        <table class="ssl-detail-table">
          <tr>
            <th>Item 1 (${escapeHtml(data.itemA.type || 'Input A')})</th>
            <td>${escapeHtml(data.itemA.commonName || data.itemA.keyType || 'Detected')} <br><code style="font-size:11px;color:#64748b;">${escapeHtml(data.itemA.hash || '')}</code></td>
          </tr>
          <tr>
            <th>Item 2 (${escapeHtml(data.itemB.type || 'Input B')})</th>
            <td>${escapeHtml(data.itemB.commonName || data.itemB.keyType || 'Detected')} <br><code style="font-size:11px;color:#64748b;">${escapeHtml(data.itemB.hash || '')}</code></td>
          </tr>
        </table>
        ` : ''}
      </div>
    `;

    showResult(resultEl, html, isMatch ? 'success' : 'error');
  } catch (err) {
    showResult(resultEl, `<h4>Error</h4><p>${escapeHtml(err.message)}</p>`, 'error');
  }
}

async function checkSSLInstallation() {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'sslTools';
      showAuthModal('login', 'Sign in or register to check SSL installation');
    }
    return;
  }

  const hostname = document.getElementById('checkHostname').value.trim();
  const port = document.getElementById('checkPort').value || 443;
  const resultEl = document.getElementById('checkResult');

  if (!hostname) {
    showResult(resultEl, 'Please enter a hostname to test.', 'error');
    return;
  }

  showResult(resultEl, '<h4>Checking...</h4><p>Performing live TLS handshake and verifying SSL certificate chain...</p>', 'info');

  try {
    const res = await fetch('/api/ssltools/check-installation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname, domain: hostname, port: parseInt(port) })
    });
    const data = await res.json();

    if (!res.ok || (!data.installed && !data.leaf)) {
      throw new Error(data.error || 'SSL check failed to retrieve certificate');
    }

    const cert = data.certificate || data.leaf || {};
    const conn = data.connection || {};
    const chainStatus = data.chainValid ? '✅ Valid' : (data.chainError ? `❌ ${data.chainError}` : '⚠️ Untrusted / Incomplete');

    const subCn = typeof cert.subject === 'object' ? (cert.subject?.CN || 'N/A') : (cert.subject || 'N/A');
    const issName = typeof cert.issuer === 'object' ? (cert.issuer?.CN || cert.issuer?.O || 'N/A') : (cert.issuer || 'N/A');

    const html = `
      <div class="ssl-tool-detail-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #f1f5f9;">
          <h4 style="margin:0;color:#0A2740;font-size:15px;font-weight:700;">✅ SSL Installation Results for ${escapeHtml(hostname)}</h4>
          <span style="background:${data.chainValid ? '#dcfce7' : '#fef3c7'};color:${data.chainValid ? '#16a34a' : '#b45309'};padding:3px 10px;border-radius:12px;font-weight:700;font-size:12px;">${data.chainValid ? 'Chain Trusted' : 'Self-Signed / Untrusted Chain'}</span>
        </div>
        <table class="ssl-detail-table">
          <tr><th>Common Name</th><td><strong>${escapeHtml(subCn)}</strong></td></tr>
          <tr><th>Issuer</th><td>${escapeHtml(issName)}</td></tr>
          <tr><th>Valid From</th><td>${escapeHtml(cert.validFrom || 'N/A')}</td></tr>
          <tr><th>Valid To</th><td>${escapeHtml(cert.validTo || 'N/A')}</td></tr>
          <tr><th>Protocol & Cipher</th><td>${escapeHtml(conn.protocol || data.protocol || 'TLS')} — ${escapeHtml(conn.cipher || data.cipher || 'N/A')}</td></tr>
          <tr><th>Chain Status</th><td>${escapeHtml(chainStatus)}</td></tr>
          <tr><th>Fingerprint (SHA-256)</th><td><code style="font-size:11px;">${escapeHtml(cert.fingerprint256 || cert.fingerprint || 'N/A')}</code></td></tr>
        </table>
      </div>
    `;

    showResult(resultEl, html, data.chainValid ? 'success' : 'info');
  } catch (err) {
    showResult(resultEl, `<h4>Error</h4><p>${escapeHtml(err.message)}</p>`, 'error');
  }
}

function testSSLLabs() {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'sslTools';
      showAuthModal('login', 'Sign in or register to run SSL Labs diagnostic tests');
    }
    return;
  }

  const hostname = document.getElementById('labsHostname').value.trim();
  const resultEl = document.getElementById('labsResult');

  if (!hostname) {
    showResult(resultEl, 'Please enter a hostname to test.', 'error');
    return;
  }

  const cleanHost = hostname.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const url = `https://www.ssllabs.com/ssltest/analyze.html?d=${encodeURIComponent(cleanHost)}`;
  showResult(resultEl, `
    <div class="ssl-tool-detail-card">
      <h4 style="margin:0 0 8px 0;color:#0A2740;font-size:15px;font-weight:700;">🚀 Qualys SSL Labs Analysis</h4>
      <p style="margin:0 0 12px 0;font-size:13px;color:#334155;">Opening Qualys SSL Labs for comprehensive server testing (protocols, cipher suites, forward secrecy, and grading).</p>
      <a href="${url}" target="_blank" class="btn btn-primary" style="display:inline-block;text-decoration:none;">Open SSL Labs Test for ${escapeHtml(cleanHost)} →</a>
    </div>
  `, 'info');

  window.open(url, '_blank');
}

async function validateChain() {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'sslTools';
      showAuthModal('login', 'Sign in or register to validate certificate chains');
    }
    return;
  }

  const chainText = document.getElementById('chainValidatorInput')?.value?.trim();
  const resultEl = document.getElementById('chainResult');
  if (!resultEl) return;

  if (!chainText) {
    showResult(resultEl, 'Please paste a certificate chain in PEM format first.', 'error');
    return;
  }

  showResult(resultEl, '<h4>Validating...</h4><p>Analyzing certificate chain hierarchy and cryptographic signatures...</p>', 'info');

  try {
    const res = await fetch('/api/ssltools/validate-chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainText, chain: chainText, pem: chainText })
    });
    const data = await res.json();
    if (!res.ok) {
      showResult(resultEl, `<h4>Error</h4><p>${escapeHtml(data.error || 'Failed to validate chain')}</p>`, 'error');
      return;
    }

    let issuesHtml = '';
    if (data.issues && data.issues.length) {
      issuesHtml = `<div style="margin:12px 0; color:#dc2626; background:#fef2f2; border:1px solid #fecaca; padding:10px 14px; border-radius:6px;"><strong>⚠ Issues Detected:</strong><ul style="margin:6px 0 0 18px; line-height:1.6;">${data.issues.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`;
    }

    const certList = data.certs || data.certificates || [];
    let certsHtml = '';
    if (certList.length) {
      certsHtml = certList.map((c, idx) => {
        const level = idx === 0 ? 'Leaf (Server Certificate)' : (idx === certList.length - 1 && c.isCa ? 'Root CA' : 'Intermediate CA');
        return `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:12px;margin-top:10px;font-size:12px;line-height:1.7;">
          <div style="font-weight:700;font-size:13px;color:#0A2740;margin-bottom:4px;">
            Level ${idx + 1}: ${level}
          </div>
          <span style="color:#64748b">Subject (CN):</span> <strong style="color:#1e293b">${escapeHtml(c.commonName || c.subject || 'Unknown')}</strong><br>
          <span style="color:#64748b">Issuer:</span> ${escapeHtml(c.issuer || 'Unknown')}<br>
          <span style="color:#64748b">Validity:</span> ${escapeHtml(c.validFrom || '')} → ${escapeHtml(c.validTo || '')} ${c.expired ? '<span style="color:#dc2626;font-weight:700;">(EXPIRED)</span>' : ''}<br>
          <span style="color:#64748b">Fingerprint:</span> <code style="font-family:monospace;font-size:11px;background:#f1f5f9;padding:2px 6px;border-radius:4px;">${escapeHtml(c.fingerprint256 || c.fingerprint || '')}</code>
        </div>`;
      }).join('');
    }

    const html = `
      <div class="ssl-tool-detail-card">
        <h4 style="margin:0 0 8px 0;color:#0A2740;font-size:15px;font-weight:700;">${data.valid ? '✅ Valid Certificate Chain' : '⚠️ Chain Warning'}</h4>
        ${issuesHtml}
        <div style="margin-top:12px;">
          <strong>Certificate Chain (${data.count} certificate${data.count > 1 ? 's' : ''}):</strong>
          ${certsHtml}
        </div>
      </div>
    `;

    showResult(resultEl, html, data.valid ? 'success' : 'error');
  } catch (err) {
    showResult(resultEl, `<h4>Error</h4><p>${escapeHtml(err.message)}</p>`, 'error');
  }
}

function showResult(element, content, type = 'info') {
  element.innerHTML = content;
  element.className = 'result-box visible ' + type;
}

// Certificate Management Functions
let certificateModalType = '';

function showCertModal(type) {
  certificateModalType = type;
  const modal = document.getElementById('certModal');
  const title = document.getElementById('certModalTitle');
  const body = document.getElementById('certModalBody');

  const titles = {
    letsencrypt: '🔐 Generate Let\'s Encrypt Certificate',
    selfsigned: '📜 Generate Self-Signed Certificate',
    csr: '📝 Generate Certificate Signing Request'
  };

  title.textContent = titles[type];
  body.innerHTML = getCertModalContent(type);
  modal.style.display = 'flex';
}

function getCertModalContent(type) {
  if (type === 'letsencrypt') {
    return `
      <div class="generator-shell">
        <div class="generator-hero">
          <h4>📝 Let's Encrypt Certificate Generation</h4>
          <p>Use a public DNS record and an internet-reachable host for the ACME challenge. This is required for real issuance and is not possible from a standard private/local Docker container.</p>
        </div>

        <div id="letsencryptStep1">
          <form id="letsencryptForm" class="generator-form-grid">
            <div class="field full">
              <label for="leDomain">Domain Name</label>
              <input type="text" id="leDomain" required placeholder="example.com">
            </div>
            <div class="field full">
              <div class="modal-actions">
                <button type="button" class="btn btn-ghost" onclick="closeCertModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Start Certificate Generation</button>
              </div>
            </div>
          </form>
        </div>

        <div id="letsencryptStep2" style="display:none">
          <div class="generator-hero">
            <h4>📋 DNS Verification Required</h4>
            <p>Add the following DNS TXT record to verify domain ownership.</p>
          </div>
          <div id="dnsInstructions" class="generator-form-grid" style="margin-top:16px"></div>
          <div class="modal-actions" style="margin-top:16px">
            <button type="button" class="btn btn-ghost" onclick="closeCertModal()">Cancel</button>
            <button type="button" class="btn btn-primary" onclick="completeLetsEncrypt()">I've Added the DNS Record</button>
          </div>
        </div>

        <div id="letsencryptStep3" style="display:none">
          <div class="generator-hero">
            <h4>✅ Certificate Ready</h4>
            <p>Your request has been prepared and is ready to download.</p>
          </div>
          <div id="certificateFiles" style="margin-top:16px"></div>
        </div>
      </div>
    `;
  } else if (type === 'selfsigned') {
    return `
      <div class="generator-shell">
        <div class="generator-hero">
          <h4>🏭 Self-Signed Certificate</h4>
          <p>Generate a certificate for internal use, staging, or test systems. It includes a CA file for easy trust setup.</p>
        </div>
        <form id="selfsignedForm" class="generator-form-grid">
          <div class="field">
            <label for="ssDomain">Domain Name *</label>
            <input type="text" id="ssDomain" required placeholder="internal.example.com">
          </div>
          <div class="field">
            <label for="ssCommonName">Common Name *</label>
            <input type="text" id="ssCommonName" required placeholder="internal.example.com">
          </div>
          <div class="field">
            <label for="ssOrganization">Organization</label>
            <input type="text" id="ssOrganization" placeholder="My Company Inc">
          </div>
          <div class="field">
            <label for="ssOU">Organizational Unit</label>
            <input type="text" id="ssOU" placeholder="IT Department">
          </div>
          <div class="field">
            <label for="ssLocality">City / Locality</label>
            <input type="text" id="ssLocality" placeholder="San Francisco">
          </div>
          <div class="field">
            <label for="ssState">State / Province</label>
            <input type="text" id="ssState" placeholder="California">
          </div>
          <div class="field">
            <label for="ssCountry">Country Code</label>
            <input type="text" id="ssCountry" maxlength="2" placeholder="US">
          </div>
          <div class="field">
            <label for="ssValidityDays">Validity (Days)</label>
            <input type="number" id="ssValidityDays" value="825" min="1" max="3650">
          </div>
          <div class="field full">
            <div class="modal-actions">
              <button type="button" class="btn btn-ghost" onclick="closeCertModal()">Cancel</button>
              <button type="submit" class="btn btn-primary">Generate Self-Signed Certificate</button>
            </div>
          </div>
        </form>
      </div>
    `;
  } else if (type === 'csr') {
    return `
      <div class="generator-shell">
        <div class="generator-hero">
          <h4>📋 Certificate Signing Request</h4>
          <p>Generate a CSR for a certificate authority such as DigiCert, Sectigo, or GlobalSign.</p>
        </div>
        <form id="csrForm" class="generator-form-grid">
          <div class="field">
            <label for="csrDomain">Domain Name *</label>
            <input type="text" id="csrDomain" required placeholder="www.example.com">
          </div>
          <div class="field">
            <label for="csrCommonName">Common Name *</label>
            <input type="text" id="csrCommonName" required placeholder="www.example.com">
          </div>
          <div class="field">
            <label for="csrOrganization">Organization *</label>
            <input type="text" id="csrOrganization" required placeholder="Example Inc">
          </div>
          <div class="field">
            <label for="csrOU">Organizational Unit</label>
            <input type="text" id="csrOU" placeholder="IT Department">
          </div>
          <div class="field">
            <label for="csrLocality">City / Locality *</label>
            <input type="text" id="csrLocality" required placeholder="San Francisco">
          </div>
          <div class="field">
            <label for="csrState">State / Province *</label>
            <input type="text" id="csrState" required placeholder="California">
          </div>
          <div class="field">
            <label for="csrCountry">Country Code *</label>
            <input type="text" id="csrCountry" required maxlength="2" placeholder="US">
          </div>
          <div class="field">
            <label for="csrEmail">Email</label>
            <input type="email" id="csrEmail" placeholder="admin@example.com">
          </div>
          <div class="field full">
            <div class="modal-actions">
              <button type="button" class="btn btn-ghost" onclick="closeCertModal()">Cancel</button>
              <button type="submit" class="btn btn-primary">Generate CSR</button>
            </div>
          </div>
        </form>
      </div>
    `;
  }
}

function closeCertModal() {
  document.getElementById('certModal').style.display = 'none';
}

// Alert Email Management Functions
async function loadDomainAlertEmails() {
  const container = document.getElementById('domainAlertEmailsList');
  if (!container) return;
  try {
    const res = await fetch('/api/alert-emails');
    if (!res.ok) {
      container.innerHTML = '<span style="color:#64748b;">Alerts are sent to your account email.</span>';
      return;
    }
    const emails = await res.json();
    if (!emails || emails.length === 0) {
      container.innerHTML = '<span>No additional alert emails configured (alerts are sent to your account email). <a href="#alert-emails" onclick="showAlertEmails(event)" style="color:#0284c7;text-decoration:underline;margin-left:4px;">Add recipient →</a></span>';
    } else {
      const safeEscape = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const emailBadges = emails.map(e => `
        <span style="display:inline-flex;align-items:center;background:#F1F5F9;border:1px solid #CBD5E1;border-radius:6px;padding:3px 8px;margin:2px 4px 2px 0;font-size:12px;font-weight:500;color:#1E293B;">
          ${safeEscape(e.email)}
          <span style="font-size:10px;color:#64748B;margin-left:6px;background:#E2E8F0;padding:1px 5px;border-radius:4px;">
            ${e.is_global ? 'All domains' : safeEscape(e.group_name || 'Group')}
          </span>
        </span>
      `).join('');
      container.innerHTML = `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;">${emailBadges}</div>`;
    }
  } catch (err) {
    container.innerHTML = '<span style="color:#64748b;">Alerts are sent to your account email.</span>';
  }
}
window.loadDomainAlertEmails = loadDomainAlertEmails;

async function loadAlertEmails() {
  if (window.isGuest) {
    const container = document.getElementById('alertEmailsList');
    if (container) {
      container.innerHTML = `
        <div class="empty-state" style="margin-top:12px; padding:24px; text-align:center; background:#FAFAFA; border:1px dashed #CBD5E1; border-radius:8px;">
          <h4 style="margin:0 0 6px; font-size:14px; color:#334155;">Alert Email Recipients</h4>
          <p style="margin:0; font-size:13px; color:#64748B;">Configure team members or extra email addresses to receive certificate expiration alerts. Click <strong>➕ Add Email</strong> to get started.</p>
        </div>
      `;
    }
    renderAlertEmailsPagination(0, 0);
    return;
  }
  try {
    if (typeof currentUser === 'undefined' || !currentUser?.email) {
      try {
        const meRes = await fetch('/api/auth/me');
        if (meRes.ok) {
          const meData = await meRes.json();
          currentUser = meData.user;
        }
      } catch (_) {}
    }
    const res = await fetch('/api/alert-emails');
    const emails = await res.json();
    window.currentAlertEmails = emails;
    renderAlertEmails(emails);
  } catch (err) {
    document.getElementById('alertEmailsList').innerHTML = '<div class="error">Failed to load alert emails</div>';
  }
}

let alertEmailsCurrentPage = 1;
const alertEmailsPageSize = 5;

function renderAlertEmails(emails) {
  const container = document.getElementById('alertEmailsList');
  if (!container) return;

  if (emails) window.currentAlertEmails = emails;
  const list = window.currentAlertEmails || [];

  const safeEscape = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const primaryEmail = (typeof currentUser !== 'undefined' && currentUser?.email) ? currentUser.email : '';

  // 1. Primary / Default Email Card (always present, editable, cannot be deleted)
  const primaryCardHtml = primaryEmail ? `
    <div class="email-item primary-email-item" style="border-left: 4px solid var(--accent); background: #F8FAFC; margin-bottom: 12px;">
      <div class="email-info">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <h4 style="margin:0; font-size:15px; color:#0F172A;">${safeEscape(primaryEmail)}</h4>
          <span style="font-size:11px; font-weight:600; background:#E0F2FE; color:#0369A1; padding:2px 8px; border-radius:12px;">Primary / Default</span>
        </div>
        <p style="margin:4px 0 0; font-size:12px; color:#64748B;">Default notification address for all domains and system alerts.</p>
      </div>
      <div class="email-actions">
        <button class="btn btn-ghost btn-sm" onclick="showEditPrimaryEmailModal('${safeEscape(primaryEmail)}')">✏️ Edit</button>
      </div>
    </div>
  ` : '';

  // 2. Filter out primary email if it was previously added to notification_emails
  const additionalEmails = list.filter(e => e.email.toLowerCase() !== primaryEmail.toLowerCase());

  let additionalHtml = '';
  if (additionalEmails.length === 0) {
    additionalHtml = `
      <div class="empty-state" style="margin-top:12px; padding:24px; text-align:center; background:#FAFAFA; border:1px dashed #CBD5E1; border-radius:8px;">
        <h4 style="margin:0 0 6px; font-size:14px; color:#334155;">No Additional Alert Recipients</h4>
        <p style="margin:0; font-size:13px; color:#64748B;">All domain expiration alerts are currently delivered to your primary email above. Click <strong>➕ Add Email</strong> to add team members.</p>
      </div>
    `;
    renderAlertEmailsPagination(0, 0);
  } else {
    const totalPages = Math.ceil(additionalEmails.length / alertEmailsPageSize);
    if (alertEmailsCurrentPage > totalPages) alertEmailsCurrentPage = totalPages;
    if (alertEmailsCurrentPage < 1) alertEmailsCurrentPage = 1;

    const startIndex = (alertEmailsCurrentPage - 1) * alertEmailsPageSize;
    const pageItems = additionalEmails.slice(startIndex, startIndex + alertEmailsPageSize);

    additionalHtml = pageItems.map(email => `
      <div class="email-item">
        <div class="email-info">
          <h4>${safeEscape(email.email)}</h4>
          <p style="margin:4px 0 0; font-size:13px; color:var(--text-muted, #64748B);">Group: <strong>${email.group_name ? safeEscape(email.group_name) : 'All domains'}</strong></p>
        </div>
        <div class="email-actions">
          <button class="btn btn-danger btn-sm" onclick="deleteAlertEmail(${email.id})">Remove</button>
        </div>
      </div>
    `).join('');

    renderAlertEmailsPagination(totalPages, additionalEmails.length);
  }

  container.innerHTML = primaryCardHtml + additionalHtml;
}

function renderAlertEmailsPagination(totalPages, totalItems) {
  let container = document.getElementById('alertEmailsPagination');
  if (!container) {
    container = document.createElement('div');
    container.id = 'alertEmailsPagination';
    container.className = 'pagination-bar';
    const listEl = document.getElementById('alertEmailsList');
    if (listEl && listEl.parentNode) {
      listEl.parentNode.insertBefore(container, listEl.nextSibling);
    }
  }
  if (!container) return;

  if (totalPages <= 1) {
    container.innerHTML = totalItems > 0 ? `<span>Showing all ${totalItems} additional recipient${totalItems === 1 ? '' : 's'}</span>` : '';
    return;
  }

  const startItem = (alertEmailsCurrentPage - 1) * alertEmailsPageSize + 1;
  const endItem = Math.min(alertEmailsCurrentPage * alertEmailsPageSize, totalItems);

  let pageButtonsHtml = '';
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= alertEmailsCurrentPage - 2 && p <= alertEmailsCurrentPage + 2)) {
      pageButtonsHtml += `<button class="page-btn ${p === alertEmailsCurrentPage ? 'active' : ''}" onclick="goToAlertEmailsPage(${p})">${p}</button>`;
    } else if (p === alertEmailsCurrentPage - 3 || p === alertEmailsCurrentPage + 3) {
      pageButtonsHtml += `<span style="padding:0 4px; color:var(--muted);">…</span>`;
    }
  }

  container.innerHTML = `
    <div>Showing <strong>${startItem}–${endItem}</strong> of <strong>${totalItems}</strong> additional recipients</div>
    <div class="pagination-controls">
      <button class="page-btn" ${alertEmailsCurrentPage === 1 ? 'disabled' : ''} onclick="goToAlertEmailsPage(${alertEmailsCurrentPage - 1})">« Prev</button>
      ${pageButtonsHtml}
      <button class="page-btn" ${alertEmailsCurrentPage === totalPages ? 'disabled' : ''} onclick="goToAlertEmailsPage(${alertEmailsCurrentPage + 1})">Next »</button>
    </div>
  `;
}

function goToAlertEmailsPage(p) {
  alertEmailsCurrentPage = p;
  renderAlertEmails(window.currentAlertEmails);
}
window.goToAlertEmailsPage = goToAlertEmailsPage;

function showEditPrimaryEmailModal(email) {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'alert-emails';
      showAuthModal('login', 'Sign in or register to manage your primary alert email');
    }
    return;
  }
  const modal = document.getElementById('editPrimaryEmailModal');
  const input = document.getElementById('primaryEmailInput');
  if (modal) modal.style.display = 'flex';
  if (input) {
    input.value = email || (typeof currentUser !== 'undefined' ? currentUser?.email : '') || '';
    input.focus();
  }
}

function closeEditPrimaryEmailModal() {
  const modal = document.getElementById('editPrimaryEmailModal');
  if (modal) modal.style.display = 'none';
  const form = document.getElementById('editPrimaryEmailForm');
  if (form) form.reset();
}

function showAddEmailModal() {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'alert-emails';
      showAuthModal('login', 'Sign in or register to add alert email recipients');
    }
    return;
  }
  document.getElementById('emailModal').style.display = 'flex';
  loadGroupsForEmailModal();
}

function closeEmailModal() {
  document.getElementById('emailModal').style.display = 'none';
  document.getElementById('addEmailForm').reset();
}

async function loadGroupsForEmailModal() {
  try {
    const res = await fetch('/api/groups');
    const data = await res.json();
    const groups = Array.isArray(data) ? data : (data.groups || []);
    const select = document.getElementById('emailGroupSelect');
    if (!select) return;

    let options = '<option value="global">All domains (Global)</option>';
    if (groups.length > 0) {
      options += groups.map(g =>
        `<option value="${g.id}">${escapeHtml(g.name)}</option>`
      ).join('');
    }
    select.innerHTML = options;
  } catch (err) {
    console.error('Failed to load groups:', err);
  }
}

async function deleteAlertEmail(id) {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'alert-emails';
      showAuthModal('login', 'Sign in or register to manage alert email recipients');
    }
    return;
  }
  if (!confirm('Remove this alert email?')) return;

  try {
    await fetch(`/api/alert-emails/${id}`, { method: 'DELETE' });
    toast('Alert email removed');
    loadAlertEmails();
  } catch (err) {
    toast('Failed to remove alert email', true);
  }
}

// Certificate Management Functions
let currentCertificateId = null;

async function loadCertificates() {
  if (window.isGuest) return;
  try {
    const res = await fetch('/api/certificates');
    const certificates = await res.json();
    renderCertificates(certificates);
  } catch (err) {
    document.getElementById('certificatesList').innerHTML = '<div class="error">Failed to load certificates</div>';
  }
}

let certCurrentPage = 1;
const certPageSize = 5;
let activeCertTypeFilter = 'all';

function initCertTypeFilters() {
  const filterBar = document.getElementById('certTypeFilterBar');
  if (!filterBar) return;
  filterBar.querySelectorAll('.cert-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.dataset.filter || 'all';
      activeCertTypeFilter = filter;
      filterBar.querySelectorAll('.cert-type-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.classList.toggle('btn-ghost', b !== btn);
      });
      certCurrentPage = 1;
      renderCertificates(window.currentCertificates);
    });
  });
}
window.initCertTypeFilters = initCertTypeFilters;

function renderCertificates(certificates) {
  const container = document.getElementById('certificatesList');
  if (!container) return;

  if (certificates) window.currentCertificates = certificates;
  const allList = window.currentCertificates || [];

  // Update category count badges
  const countAll = allList.length;
  const countLe = allList.filter(c => c.type === 'letsencrypt').length;
  const countCsr = allList.filter(c => c.type === 'csr').length;
  const countSs = allList.filter(c => c.type === 'selfsigned').length;

  const elAll = document.getElementById('countAllCerts');
  if (elAll) elAll.textContent = countAll;
  const elLe = document.getElementById('countLeCerts');
  if (elLe) elLe.textContent = countLe;
  const elCsr = document.getElementById('countCsrCerts');
  if (elCsr) elCsr.textContent = countCsr;
  const elSs = document.getElementById('countSelfSignedCerts');
  if (elSs) elSs.textContent = countSs;

  // Filter items by active type filter
  let list = allList;
  if (activeCertTypeFilter && activeCertTypeFilter !== 'all') {
    list = allList.filter(c => c.type === activeCertTypeFilter);
  }

  if (list.length === 0) {
    const filterName = activeCertTypeFilter === 'letsencrypt' ? "Let's Encrypt" :
                       activeCertTypeFilter === 'csr' ? "CSR" :
                       activeCertTypeFilter === 'selfsigned' ? "Self-Signed" : "";
    container.innerHTML = `
      <div class="empty-state">
        <h4>No ${filterName ? filterName + ' ' : ''}Certificates Found</h4>
        <p>Generate ${filterName ? filterName + ' certificates' : 'Let\'s Encrypt, self-signed certificates, or CSRs'} using the tabs above.</p>
      </div>
    `;
    renderCertificatesPagination(0, 0);
    return;
  }

  const totalPages = Math.ceil(list.length / certPageSize);
  if (certCurrentPage > totalPages) certCurrentPage = totalPages;
  if (certCurrentPage < 1) certCurrentPage = 1;

  const startIndex = (certCurrentPage - 1) * certPageSize;
  const pageItems = list.slice(startIndex, startIndex + certPageSize);

  const safeEscape = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const typeLabels = {
    letsencrypt: "🔐 Let's Encrypt",
    selfsigned: '📜 Self-Signed',
    csr: '📝 CSR'
  };

  const html = pageItems.map(cert => {
    let retentionText = '';
    if (cert.expires_at) {
      const expDate = new Date(cert.expires_at);
      const now = new Date();
      const diffMs = expDate - now;
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays > 0) {
        if (cert.type === 'csr') {
          retentionText = `<span style="display:inline-block;margin-top:4px;font-size:12px;color:#0284c7;background:#E0F2FE;padding:2px 8px;border-radius:4px;">⏳ 1-year retention (auto-purges in ${diffDays}d on ${expDate.toLocaleDateString()})</span>`;
        } else {
          retentionText = `<span style="display:inline-block;margin-top:4px;font-size:12px;color:#15803d;background:#DCFCE7;padding:2px 8px;border-radius:4px;">⏳ Stored until expiry (auto-purges in ${diffDays}d on ${expDate.toLocaleDateString()})</span>`;
        }
      } else {
        retentionText = `<span style="display:inline-block;margin-top:4px;font-size:12px;color:#b91c1c;background:#FEE2E2;padding:2px 8px;border-radius:4px;">⚠️ Expired — pending auto-purge</span>`;
      }
    }

    return `
      <div class="cert-item">
        <div class="cert-info">
          <h4>${typeLabels[cert.type] || cert.type} - ${safeEscape(cert.domain)}</h4>
          <p style="margin:2px 0;">Created: ${new Date(cert.created_at).toLocaleDateString()}</p>
          ${retentionText}
        </div>
        <div class="cert-actions">
          <span class="cert-status ${cert.status}">${cert.status}</span>
          ${cert.status === 'completed' ?
            `<button class="btn btn-primary btn-sm" onclick="downloadCertificate(${cert.id})">Download</button>` :
            ''
          }
          <button class="btn btn-danger btn-sm" onclick="deleteCertificate(${cert.id})">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
  renderCertificatesPagination(totalPages, list.length);
}

function renderCertificatesPagination(totalPages, totalItems) {
  let container = document.getElementById('certificatesPagination');
  if (!container) {
    container = document.createElement('div');
    container.id = 'certificatesPagination';
    container.className = 'pagination-bar';
    const listEl = document.getElementById('certificatesList');
    if (listEl && listEl.parentNode) {
      listEl.parentNode.insertBefore(container, listEl.nextSibling);
    }
  }
  if (!container) return;

  if (totalPages <= 1) {
    container.innerHTML = totalItems > 0 ? `<span>Showing all ${totalItems} generated item${totalItems === 1 ? '' : 's'}</span>` : '';
    return;
  }

  const startItem = (certCurrentPage - 1) * certPageSize + 1;
  const endItem = Math.min(certCurrentPage * certPageSize, totalItems);

  let pageButtonsHtml = '';
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= certCurrentPage - 2 && p <= certCurrentPage + 2)) {
      pageButtonsHtml += `<button class="page-btn ${p === certCurrentPage ? 'active' : ''}" onclick="goToCertPage(${p})">${p}</button>`;
    } else if (p === certCurrentPage - 3 || p === certCurrentPage + 3) {
      pageButtonsHtml += `<span style="padding:0 4px; color:var(--muted);">…</span>`;
    }
  }

  container.innerHTML = `
    <div>Showing <strong>${startItem}–${endItem}</strong> of <strong>${totalItems}</strong> generated items</div>
    <div class="pagination-controls">
      <button class="page-btn" ${certCurrentPage === 1 ? 'disabled' : ''} onclick="goToCertPage(${certCurrentPage - 1})">« Prev</button>
      ${pageButtonsHtml}
      <button class="page-btn" ${certCurrentPage === totalPages ? 'disabled' : ''} onclick="goToCertPage(${certCurrentPage + 1})">Next »</button>
    </div>
  `;
}

function goToCertPage(p) {
  certCurrentPage = p;
  renderCertificates(window.currentCertificates);
}
window.goToCertPage = goToCertPage;

async function downloadCertificate(id) {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'certificates';
      showAuthModal('login', 'Sign in or register to download generated certificates');
    }
    return;
  }
  try {
    const res = await fetch(`/api/certificates/download/${id}`);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Unable to download certificate files');
    }

    const disposition = res.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
    const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : `certificate-${id}.tar.gz`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('Certificate file downloaded');
  } catch (err) {
    toast('Failed to download certificate: ' + err.message, true);
  }
}

async function deleteCertificate(id) {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'certificates';
      showAuthModal('login', 'Sign in or register to manage certificates');
    }
    return;
  }
  if (!confirm('Delete this certificate and all associated files?')) return;

  try {
    await fetch(`/api/certificates/${id}`, { method: 'DELETE' });
    toast('Certificate deleted');
    loadCertificates();
  } catch (err) {
    toast('Failed to delete certificate', true);
  }
}

// Form Handlers & Initialization
function initDashboardFeatures() {
  initializeSSLToolTabs();
  initializeCertificateTabs();
  initDashDnsLookup();
  handleHashRoute();
  loadDomainAlertEmails();

  // Forward scroll wheel on docs TOC to docs content
  const tocEl = document.querySelector('.dashboard-docs-wrap .docs-toc');
  const contentEl = document.querySelector('.dashboard-docs-wrap .docs-content');
  if (tocEl && contentEl) {
    tocEl.addEventListener('wheel', function(e) {
      contentEl.scrollTop += e.deltaY;
    }, { passive: true });
  }

  // Email scope change handler
  // Add Email Form Handler
  const addEmailForm = document.getElementById('addEmailForm');
  if (addEmailForm) {
    addEmailForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      if (window.isGuest) {
        if (typeof showAuthModal === 'function') {
          window.pendingAuthDestination = 'alertEmails';
          showAuthModal('login', 'Sign in or register to configure alert email recipients');
        }
        return;
      }

      const email = (document.getElementById('newAlertEmail')?.value || '').trim();
      const groupVal = document.getElementById('emailGroupSelect')?.value || 'global';
      const isGlobal = groupVal === 'global' || groupVal === '';
      const groupId = isGlobal ? null : parseInt(groupVal, 10);

      const primaryEmail = (typeof currentUser !== 'undefined' && currentUser?.email) ? currentUser.email.toLowerCase() : '';
      if (primaryEmail && email.toLowerCase() === primaryEmail) {
        toast('This email is already your primary default alert email.', true);
        return;
      }

      if (window.currentAlertEmails && window.currentAlertEmails.some(e => e.email.toLowerCase() === email.toLowerCase())) {
        toast('That email address is already on your alert list.', true);
        return;
      }

      try {
        const res = await fetch('/api/alert-emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            groupId,
            isGlobal
          })
        });

        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.error);
        }

        toast('Alert email added successfully');
        closeEmailModal();
        loadAlertEmails();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // Edit Primary / Default Email Form Handler
  const editPrimaryEmailForm = document.getElementById('editPrimaryEmailForm');
  if (editPrimaryEmailForm) {
    editPrimaryEmailForm.addEventListener('submit', async function(e) {
      e.preventDefault();

      const newEmail = (document.getElementById('primaryEmailInput')?.value || '').trim().toLowerCase();
      if (!newEmail) return;

      const saveBtn = document.getElementById('savePrimaryEmailBtn');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

      try {
        const res = await fetch('/api/auth/email', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: newEmail })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update email');

        if (typeof currentUser !== 'undefined' && data.user) {
          currentUser = data.user;
        }
        toast('Primary email updated successfully');
        closeEditPrimaryEmailModal();
        await loadAlertEmails();
        if (typeof loadMe === 'function') loadMe();
      } catch (err) {
        toast(err.message, true);
      } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
      }
    });
  }

  // Let's Encrypt / Self-Signed / CSR Form Handler
  document.addEventListener('submit', async function(e) {
    if (e.target.id === 'letsencryptForm') {
      e.preventDefault();
      await startLetsEncrypt();
    } else if (e.target.id === 'selfsignedForm') {
      e.preventDefault();
      await generateSelfSigned();
    } else if (e.target.id === 'csrForm') {
      e.preventDefault();
      await generateCSR();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDashboardFeatures);
} else {
  initDashboardFeatures();
}
window.addEventListener('hashchange', handleHashRoute);

async function startLetsEncrypt() {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'certificates';
      showAuthModal('login', 'Sign in or register to generate Let\'s Encrypt certificates');
    }
    return;
  }

  const domainInput = document.getElementById('leDomain');
  const domain = domainInput ? domainInput.value.trim() : '';

  if (!domain) {
    toast('Please enter a domain name first.', true);
    return;
  }

  // Disable the submit button to prevent double-clicks
  const submitBtn = document.querySelector('#letsencryptForm button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Starting…';
  }

  try {
    const res = await fetch('/api/certificates/letsencrypt/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error);
    }

    currentCertificateId = data.id;
    sessionStorage.setItem('leCertId', data.id);

    // Transition to step 2 — always in-page now
    document.getElementById('letsencryptStep1').style.display = 'none';
    document.getElementById('letsencryptStep2').style.display = 'block';

    const dnsInstructions = document.getElementById('dnsInstructions');
    if (dnsInstructions) {
      const ch = data.challenges[0];
      dnsInstructions.innerHTML = `
        <div class="field full">
          <label>Record Type</label>
          <input type="text" value="TXT" readonly>
        </div>
        <div class="field full">
          <label>Name</label>
          <input type="text" value="${ch.recordName}" readonly style="cursor:pointer" onclick="this.select()" title="Click to select">
        </div>
        <div class="field full">
          <label>Value</label>
          <input type="text" value="${ch.recordValue}" readonly style="cursor:pointer" onclick="this.select()" title="Click to select">
        </div>
      `;
    }

  } catch (err) {
    toast("Failed to start Let's Encrypt generation: " + err.message, true);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start Certificate Generation';
    }
  }
}

async function completeLetsEncrypt() {
  // Fall back to sessionStorage if the in-memory variable was lost
  if (!currentCertificateId) {
    const stored = sessionStorage.getItem('leCertId');
    if (stored) {
      currentCertificateId = Number(stored);
    }
  }

  if (!currentCertificateId) {
    toast('Session lost — please start over.', true);
    resetLetsEncrypt();
    return;
  }

  const completeBtn = document.querySelector('#letsencryptStep2 .btn-primary');
  if (completeBtn) {
    completeBtn.disabled = true;
    completeBtn.textContent = 'Verifying…';
  }

  try {
    const res = await fetch(`/api/certificates/letsencrypt/complete/${currentCertificateId}`, {
      method: 'POST'
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error);
    }

    // Show success in-page
    document.getElementById('letsencryptStep2').style.display = 'none';
    document.getElementById('letsencryptStep3').style.display = 'block';
    document.getElementById('certificateFiles').innerHTML = `
      <div class="generator-hero">
        <h4>✅ Certificate Generated</h4>
        <p>Your certificate files were created successfully.</p>
      </div>
      <div class="generator-form-grid" style="margin-top:16px">
        <div class="field full">
          <label>Files Included</label>
          <ul style="margin:8px 0 0 18px; color:#334155; line-height:1.8;">
            ${data.files.map(file => `<li>${file}</li>`).join('')}
          </ul>
        </div>
        <div class="field full">
          <div class="modal-actions">
            <button type="button" class="btn btn-primary" onclick="downloadCertificate(${currentCertificateId})">Download Files</button>
          </div>
        </div>
      </div>
    `;

    loadCertificates();

  } catch (err) {
    toast('Failed to complete certificate generation: ' + err.message, true);
    if (completeBtn) {
      completeBtn.disabled = false;
      completeBtn.textContent = "I've Added the DNS Record";
    }
  }
}

function resetLetsEncrypt() {
  currentCertificateId = null;
  sessionStorage.removeItem('leCertId');
  const step1 = document.getElementById('letsencryptStep1');
  const step2 = document.getElementById('letsencryptStep2');
  const step3 = document.getElementById('letsencryptStep3');
  if (step1) step1.style.display = 'block';
  if (step2) step2.style.display = 'none';
  if (step3) step3.style.display = 'none';
  const domainInput = document.getElementById('leDomain');
  if (domainInput) domainInput.value = '';
  const submitBtn = document.querySelector('#letsencryptForm button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Start Certificate Generation';
  }
}

function copyText(elementId, successMsg) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.select();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(el.value).then(() => {
      toast(successMsg || 'Copied to clipboard!');
    }).catch(() => {
      document.execCommand('copy');
      toast(successMsg || 'Copied to clipboard!');
    });
  } else {
    document.execCommand('copy');
    toast(successMsg || 'Copied to clipboard!');
  }
}

function addCsrSanRow(val = '') {
  const container = document.getElementById('csrSansContainer');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'san-input-row';
  div.innerHTML = `
    <input type="text" class="csr-san-input" placeholder="sub.example.com" value="${escapeHtml(val)}">
    <button type="button" class="san-remove-btn" title="Remove Domain" onclick="this.closest('.san-input-row').remove()">✕</button>
  `;
  container.appendChild(div);
}

function initCsrSans() {
  const container = document.getElementById('csrSansContainer');
  if (container && container.children.length === 0) {
    // Keep empty by default as requested: user clicks "+ Add Domain" to add SANs
  }
}

function addSelfSignedSanRow(val = '') {
  const container = document.getElementById('ssSansContainer');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'san-input-row';
  div.innerHTML = `
    <input type="text" class="ss-san-input" placeholder="internal.test or 192.168.1.10" value="${escapeHtml(val)}">
    <button type="button" class="san-remove-btn" title="Remove SAN" onclick="this.closest('.san-input-row').remove()">✕</button>
  `;
  container.appendChild(div);
}

function initSelfSignedSans() {
  const container = document.getElementById('ssSansContainer');
  if (container && container.children.length === 0) {
    // Start clean or ready for inputs
  }
}

function resetSelfSigned() {
  const formWrap = document.getElementById('selfsignedFormWrap');
  const resultWrap = document.getElementById('selfsignedResultWrap');
  if (formWrap) formWrap.style.display = 'block';
  if (resultWrap) resultWrap.style.display = 'none';
  const form = document.getElementById('selfsignedForm');
  if (form) form.reset();
  const sanContainer = document.getElementById('ssSansContainer');
  if (sanContainer) sanContainer.innerHTML = '';
  const submitBtn = document.querySelector('#selfsignedForm button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Generate Self-Signed Certificate';
  }
}

async function generateSelfSigned() {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'certificates';
      showAuthModal('login', 'Sign in or register to generate Self-Signed certificates');
    }
    return;
  }

  const domainEl = document.getElementById('ssDomain');
  if (!domainEl || !domainEl.value.trim()) {
    toast('Please enter a Domain / Hostname', true);
    return;
  }

  const sanInputs = document.querySelectorAll('#ssSansContainer .ss-san-input');
  const sans = Array.from(sanInputs).map(inp => inp.value.trim()).filter(Boolean);

  const formData = {
    domain: domainEl.value.trim(),
    sans,
    organization: document.getElementById('ssOrganization')?.value.trim() || 'My Company Inc',
    organizationalUnit: document.getElementById('ssOU')?.value.trim() || 'IT Department',
    locality: document.getElementById('ssLocality')?.value.trim() || '',
    state: document.getElementById('ssState')?.value.trim() || '',
    country: document.getElementById('ssCountry')?.value.trim() || 'IN',
    validityDays: parseInt(document.getElementById('ssValidityDays')?.value) || 365,
    keySize: parseInt(document.getElementById('ssKeySize')?.value) || 2048
  };

  const submitBtn = document.querySelector('#selfsignedForm button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Generating…'; }

  try {
    const res = await fetch('/api/certificates/selfsigned', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    document.getElementById('selfsignedDomainSummary').textContent =
      `Certificate for ${formData.domain} and Root CA bundle generated successfully.`;
    document.getElementById('selfsignedCaCertDisplay').value = data.caCert || '';
    document.getElementById('selfsignedDomainCertDisplay').value = data.domainCert || '';

    const dlBtn = document.getElementById('downloadSelfSignedBtn');
    if (dlBtn) dlBtn.onclick = () => downloadCertificate(data.id);

    document.getElementById('selfsignedFormWrap').style.display = 'none';
    document.getElementById('selfsignedResultWrap').style.display = 'block';

    loadCertificates();
  } catch (err) {
    toast('Failed to generate certificate: ' + err.message, true);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Generate Self-Signed Certificate';
    }
  }
}

function resetCSR() {
  const formWrap = document.getElementById('csrFormWrap');
  const resultWrap = document.getElementById('csrResultWrap');
  if (formWrap) formWrap.style.display = 'block';
  if (resultWrap) resultWrap.style.display = 'none';
  const form = document.getElementById('csrForm');
  if (form) form.reset();
  const sanContainer = document.getElementById('csrSansContainer');
  if (sanContainer) {
    sanContainer.innerHTML = '';
  }
  const submitBtn = document.querySelector('#csrForm button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Generate CSR';
  }
}

async function generateCSR() {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'certificates';
      showAuthModal('login', 'Sign in or register to generate Certificate Signing Requests (CSR)');
    }
    return;
  }

  const domainEl = document.getElementById('csrDomain');
  if (!domainEl || !domainEl.value.trim()) {
    toast('Please enter a Domain Name', true);
    return;
  }

  const sanInputs = document.querySelectorAll('#csrSansContainer .csr-san-input');
  const sans = Array.from(sanInputs).map(inp => inp.value.trim()).filter(Boolean);

  const formData = {
    domain: domainEl.value.trim(),
    sans,
    organization: document.getElementById('csrOrganization')?.value.trim() || '',
    organizationalUnit: document.getElementById('csrOU')?.value.trim() || '',
    locality: document.getElementById('csrLocality')?.value.trim() || '',
    state: document.getElementById('csrState')?.value.trim() || '',
    country: document.getElementById('csrCountry')?.value.trim() || 'IN',
    email: document.getElementById('csrEmail')?.value.trim() || '',
    keySize: parseInt(document.getElementById('csrKeySize')?.value) || 2048
  };

  const submitBtn = document.querySelector('#csrForm button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Generating…'; }

  try {
    const res = await fetch('/api/certificates/csr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    document.getElementById('csrDomainSummary').textContent =
      `CSR and Private Key for ${formData.domain} generated successfully.`;
    document.getElementById('csrTextDisplay').value = data.csrText || '';
    document.getElementById('csrKeyDisplay').value = data.keyText || '';

    const dlBtn = document.getElementById('downloadCsrBtn');
    if (dlBtn) dlBtn.onclick = () => downloadCertificate(data.id);

    document.getElementById('csrFormWrap').style.display = 'none';
    document.getElementById('csrResultWrap').style.display = 'block';

    loadCertificates();
  } catch (err) {
    toast('Failed to generate CSR: ' + err.message, true);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Generate CSR';
    }
  }
}

// DNS Lookup in Dashboard
let dashLookupActiveType = 'ALL';

function initDashDnsLookup() {
  const typesEl = document.getElementById('dashLookupTypes');
  const formEl = document.getElementById('dashLookupForm');
  const inputEl = document.getElementById('dashDomainInput');

  if (typesEl) {
    typesEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.type-pill');
      if (!btn) return;
      typesEl.querySelectorAll('.type-pill').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      dashLookupActiveType = btn.dataset.type;
      const domain = inputEl?.value.trim();
      if (domain) runDashDnsLookup(domain, dashLookupActiveType);
    });
  }

  if (formEl) {
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const domain = inputEl?.value.trim();
      if (domain) runDashDnsLookup(domain, dashLookupActiveType);
    });
  }
}

async function runDashDnsLookup(domain, type) {
  if (window.isGuest) {
    if (typeof showAuthModal === 'function') {
      window.pendingAuthDestination = 'dnsLookup';
      showAuthModal('login', 'Sign in or register to use the DNS Lookup tool');
    }
    return;
  }

  const results = document.getElementById('dashLookupResults');
  if (!results) return;
  const safeEsc = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const cleanDomain = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  results.innerHTML = `<div class="lookup-status">Looking up ${safeEsc(cleanDomain)}…</div>`;

  try {
    const res = await fetch(`/api/tools/dns-lookup?domain=${encodeURIComponent(cleanDomain)}&type=${encodeURIComponent(type)}`);
    const data = await res.json();

    if (!res.ok) {
      results.innerHTML = `<div class="lookup-status lookup-error">${safeEsc(data.error || 'Lookup failed.')}</div>`;
      return;
    }

    let groups = data.results || [];
    if (type === 'ALL' || type === 'ANY') {
      const withRecords = groups.filter(r => r.records && r.records.length > 0);
      if (withRecords.length > 0) {
        groups = withRecords;
      } else {
        results.innerHTML = `<div class="lookup-status">No DNS records found for ${safeEsc(cleanDomain)}.</div>`;
        return;
      }
    } else {
      const target = groups[0];
      if (!target || (!target.records?.length && target.error)) {
        results.innerHTML = `
          <div class="lookup-group">
            <div class="lookup-group-type">${safeEsc(type)}</div>
            <div class="lookup-empty">${safeEsc(target?.error || `No ${type} records found.`)}</div>
          </div>`;
        return;
      }
    }

    results.innerHTML = groups.map(group => `
      <div class="lookup-group">
        <div class="lookup-group-type">${safeEsc(group.type)}</div>
        ${group.records && group.records.length > 0
          ? `<table class="lookup-table">
              <tbody>
                ${group.records.map(r => `
                  <tr>
                    <td class="lookup-value" style="word-break: break-all; font-family: var(--mono);">${safeEsc(r.value)}</td>
                    ${r.priority !== undefined ? `<td class="lookup-meta">priority ${safeEsc(r.priority)}${r.weight !== undefined ? `, weight ${safeEsc(r.weight)}` : ''}</td>` : '<td></td>'}
                  </tr>`).join('')}
              </tbody>
            </table>`
          : `<div class="lookup-empty">${safeEsc(group.error || 'No records found.')}</div>`}
      </div>`).join('');
  } catch (err) {
    results.innerHTML = `<div class="lookup-status lookup-error">Something went wrong — try again.</div>`;
  }
}

// Window exposures
window.showSection = showSection;
window.showDomains = showDomains;
window.showSSLTools = showSSLTools;
window.showCertificates = showCertificates;
window.showAlertEmails = showAlertEmails;
window.showDNSLookup = showDNSLookup;
window.showDocs = showDocs;
window.handleDomainsNav = handleDomainsNav;
window.handleAlertEmailsNav = handleAlertEmailsNav;
window.handlePlansNav = handlePlansNav;
window.scrollDocSection = scrollDocSection;
window.initDashDnsLookup = initDashDnsLookup;
window.runDashDnsLookup = runDashDnsLookup;
window.handleBrandClick = handleBrandClick;
window.handleHashRoute = handleHashRoute;