# HariSree SSL Alerts - New Features Documentation

## Overview
This document covers all the new features added to HariSree SSL Alerts, including multi-email alert recipients, certificate generation tools, SSL utilities, and enhanced security features.

---

## Table of Contents
1. [Multi-Email Alert Recipients](#1-multi-email-alert-recipients)
2. [Let's Encrypt Certificate Generation](#2-lets-encrypt-certificate-generation)
3. [Self-Signed Certificate Generation](#3-self-signed-certificate-generation)
4. [CSR (Certificate Signing Request) Generation](#4-csr-generation)
5. [SSL Tools Suite](#5-ssl-tools-suite)
6. [Enhanced Registration Security](#6-enhanced-registration-security)
7. [API Reference](#7-api-reference)
8. [Database Schema Changes](#8-database-schema-changes)
9. [Installation & Setup](#9-installation--setup)

---

## 1. Multi-Email Alert Recipients

### Overview
Users can now add up to 5 additional email addresses to receive SSL expiry alerts. Alert emails can be configured globally (for all domains) or per group.

### Features
- Add up to 5 email addresses per user account
- Configure emails globally (all domains) or per group
- Alerts sent to primary account email + all configured additional emails
- Group-specific alerts send to group-assigned emails + global emails
- Easy management interface in dashboard

### How It Works

#### Adding Alert Emails
1. Navigate to your dashboard
2. Go to "Alert Settings" or "Email Recipients"
3. Click "Add Email"
4. Enter email address
5. Choose scope:
   - **Global**: Receives alerts for all your domains
   - **Group-specific**: Receives alerts only for domains in selected group

#### Alert Priority
When a domain triggers an alert:
1. Primary account email always receives alerts
2. If domain belongs to a group: group-specific emails receive alerts
3. Global emails always receive alerts
4. Duplicate emails are automatically filtered

### API Endpoints

```javascript
// Get all alert emails
GET /api/alert-emails

// Add new alert email
POST /api/alert-emails
Body: {
  email: "alerts@example.com",
  groupId: 123,  // Optional: null for global
  isGlobal: true // true for global alerts
}

// Delete alert email
DELETE /api/alert-emails/:id
```

### Usage Example

```javascript
// Add a global alert email
const response = await fetch('/api/alert-emails', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'team@example.com',
    isGlobal: true
  })
});

// Add group-specific email
const response = await fetch('/api/alert-emails', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'devops@example.com',
    groupId: 5,
    isGlobal: false
  })
});
```

---

## 2. Let's Encrypt Certificate Generation

### Overview
Generate Let's Encrypt SSL certificates directly from the dashboard using manual DNS challenge verification.

### Features
- Manual DNS challenge workflow
- Step-by-step guidance
- Automatic certificate file generation
- Includes: cert.pem, chain.pem, fullchain.pem, privkey.pem
- README with nginx configuration examples

### How It Works

#### Step 1: Start Certificate Generation
1. Navigate to "Certificates" → "Generate Certificate"
2. Select "Let's Encrypt"
3. Enter your domain name
4. Click "Start Generation"

#### Step 2: DNS Challenge
The system will provide:
- DNS record name (e.g., `_acme-challenge.yourdomain.com`)
- DNS record value (random string)
- Instructions for adding the TXT record

#### Step 3: Add DNS Record
1. Log in to your DNS provider (Cloudflare, Route53, etc.)
2. Create new TXT record:
   - **Name**: `_acme-challenge` (or full name provided)
   - **Type**: TXT
   - **Value**: The provided challenge value
3. Wait 2-5 minutes for DNS propagation

#### Step 4: Complete Verification
1. Click "Done" button in the dashboard
2. System verifies DNS record
3. If valid, certificate is generated
4. Download certificate files

### Generated Files

```
yourdomain.com-letsencrypt/
├── README.txt           # Setup instructions
├── cert.pem            # Domain certificate
├── chain.pem           # Intermediate chain
├── fullchain.pem       # Full chain (cert + chain)
└── privkey.pem         # Private key
```

### Nginx Configuration Example

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    # Your other configurations...
}
```

### API Endpoints

```javascript
// Start Let's Encrypt generation
POST /api/certificates/letsencrypt/start
Body: { domain: "example.com" }

// Complete after DNS verification
POST /api/certificates/letsencrypt/complete/:id

// List all certificates
GET /api/certificates

// Download certificate files
GET /api/certificates/download/:id
```

### Requirements
- `certbot` must be installed on the server
- DNS access to create TXT records
- Valid email address for Let's Encrypt notifications

### Installation
```bash
# Ubuntu/Debian
sudo apt-get install certbot

# CentOS/RHEL
sudo yum install certbot

# macOS
brew install certbot
```

---

## 3. Self-Signed Certificate Generation

### Overview
Generate self-signed SSL certificates with custom CA for internal use, development, or private networks.

### Features
- Custom Certificate Authority (CA) generation
- Domain certificate signed by your CA
- Configurable validity period
- Custom organization details
- Includes CA certificate for client installation

### How It Works

#### Step 1: Navigate to Certificate Generation
1. Go to "Certificates" → "Generate Certificate"
2. Select "Self-Signed Certificate"

#### Step 2: Enter Certificate Details
- **Domain**: Your domain or hostname
- **Common Name (CN)**: Usually the same as domain
- **Organization**: Your company/organization name
- **Organizational Unit**: Department (optional)
- **Locality**: City
- **State/Province**: State or province
- **Country**: 2-letter country code (e.g., US, IN)
- **Validity Days**: Certificate lifetime (default: 825 days)

#### Step 3: Generate
Click "Generate Certificate" - the system will:
1. Create a Certificate Authority (CA)
2. Generate domain private key
3. Create Certificate Signing Request (CSR)
4. Sign certificate with CA
5. Package all files for download

### Generated Files

```
yourdomain.com-selfsigned-<timestamp>/
├── README.txt              # Setup instructions
├── ca.crt                  # Root CA certificate (install in browsers)
├── ca.key                  # CA private key (keep secure!)
├── yourdomain.com.crt      # Domain certificate
├── yourdomain.com.key      # Domain private key
├── yourdomain.com.csr      # Certificate signing request
└── yourdomain.com.ext      # OpenSSL extension config
```

### Nginx Configuration Example

```nginx
server {
    listen 443 ssl;
    server_name internal.example.com;

    ssl_certificate     /path/to/internal.example.com.crt;
    ssl_certificate_key /path/to/internal.example.com.key;

    # Your other configurations...
}
```

### Installing CA Certificate in Browsers

#### Chrome/Edge (Windows)
1. Open `ca.crt` file
2. Click "Install Certificate"
3. Select "Trusted Root Certification Authorities"
4. Restart browser

#### Firefox
1. Settings → Privacy & Security → Certificates
2. View Certificates → Authorities → Import
3. Select `ca.crt`
4. Trust for websites

#### macOS
1. Double-click `ca.crt`
2. Keychain Access opens
3. Double-click the certificate
4. Expand "Trust" → "When using this certificate" → "Always Trust"

### API Endpoint

```javascript
POST /api/certificates/selfsigned
Body: {
  domain: "internal.example.com",
  commonName: "internal.example.com",
  organization: "My Company",
  organizationalUnit: "IT Department",
  locality: "San Francisco",
  state: "California",
  country: "US",
  validityDays: 825
}
```

### Use Cases
- Internal company websites
- Development and testing environments
- Private API endpoints
- Intranet applications
- IoT device communication
- Testing SSL implementations

⚠️ **Important**: Self-signed certificates are not trusted by browsers by default. Users must install the CA certificate manually.

---

## 4. CSR Generation

### Overview
Generate Certificate Signing Requests (CSR) to submit to commercial Certificate Authorities.

### Features
- Generate CSR with custom details
- 2048-bit RSA key generation
- Compatible with all major CAs
- Includes private key
- Ready to submit to CA

### How It Works

#### Step 1: Navigate to CSR Generation
1. Go to "Certificates" → "Generate CSR"

#### Step 2: Enter Certificate Details
- **Domain**: Your domain name
- **Common Name (CN)**: Your fully qualified domain name
- **Organization**: Your legal company name
- **Organizational Unit**: Department (optional)
- **Locality**: City
- **State/Province**: Full state name (not abbreviated)
- **Country**: 2-letter country code
- **Email**: Admin contact email (optional)

#### Step 3: Generate CSR
System generates:
1. Private key (2048-bit RSA)
2. Certificate Signing Request
3. README with submission instructions

### Generated Files

```
yourdomain.com-csr-<timestamp>/
├── README.txt         # Instructions for CA submission
├── yourdomain.com.csr # Submit this to your CA
└── yourdomain.com.key # Keep this secure!
```

### Submitting to Certificate Authority

1. **Choose a CA**: 
   - DigiCert
   - Sectigo (formerly Comodo)
   - GlobalSign
   - GoDaddy
   - Others

2. **Order Certificate**: Log in to CA dashboard, start new certificate order

3. **Submit CSR**: 
   - Copy contents of `.csr` file
   - Paste into CA's CSR field
   - OR upload the `.csr` file

4. **Complete Validation**:
   - Email validation
   - Domain validation (DNS or HTTP)
   - Organization validation (OV/EV certificates)

5. **Receive Certificate**:
   - CA sends signed certificate
   - Download certificate files
   - Install with the private key you generated

### Viewing CSR Contents

```bash
# View CSR details
openssl req -text -noout -verify -in yourdomain.com.csr

# Verify CSR matches the private key
openssl req -noout -modulus -in yourdomain.com.csr | openssl md5
openssl rsa -noout -modulus -in yourdomain.com.key | openssl md5
# The MD5 hashes should match
```

### API Endpoint

```javascript
POST /api/certificates/csr
Body: {
  domain: "www.example.com",
  commonName: "www.example.com",
  organization: "Example Inc",
  organizationalUnit: "IT",
  locality: "New York",
  state: "New York",
  country: "US",
  email: "admin@example.com"
}
```

### Best Practices

1. **Keep Private Key Secure**: Never share your `.key` file
2. **Backup Private Key**: Store securely - you'll need it when CA sends certificate
3. **Match Details**: Ensure organization details match legal registration
4. **Verify Before Submission**: Check CSR contents before sending to CA
5. **Use Strong Key**: 2048-bit minimum (4096-bit for high-security)

---

## 5. SSL Tools Suite

### Overview
Comprehensive suite of SSL/TLS testing and validation tools accessible from the dashboard.

### Available Tools

#### 5.1 Certificate Decoder
Decode and view the contents of any X.509 certificate in PEM format.

**Features:**
- View certificate details
- Check validity dates
- Verify issuer information
- Examine subject alternative names
- View public key details

**Usage:**
1. Navigate to SSL Tools → Certificate Decoder
2. Paste certificate in PEM format
3. Click "Decode Certificate"
4. View detailed certificate information

**Supported Formats:**
```
-----BEGIN CERTIFICATE-----
MIIDXTCCAkWgAwIBAgIJAKZ...
-----END CERTIFICATE-----
```

#### 5.2 CSR Decoder
Decode Certificate Signing Requests to verify contents before submission.

**Features:**
- View CSR details
- Verify subject information
- Check public key
- Validate CSR signature

**Usage:**
1. Navigate to SSL Tools → CSR Decoder
2. Paste CSR in PEM format
3. Click "Decode CSR"
4. Verify all details are correct

#### 5.3 Certificate Key Matcher
Verify that a certificate and private key are a matching pair.

**Features:**
- Compare certificate and key modulus
- Verify they belong together
- Prevent deployment mismatches

**Usage:**
1. Navigate to SSL Tools → Certificate Key Matcher
2. Paste certificate in first field
3. Paste private key in second field
4. Click "Check Match"
5. System confirms if they match

**Why This Matters:**
Deploying a certificate with the wrong private key will cause SSL errors. Always verify they match before deployment.

#### 5.4 SSL Installation Checker
Test if SSL is properly installed and configured on your server.

**Features:**
- Connect to server over TLS
- Verify certificate chain
- Check protocol version
- View cipher suite
- Detect common issues

**Usage:**
1. Navigate to SSL Tools → SSL Installation Checker
2. Enter hostname
3. Enter port (default: 443)
4. Click "Check SSL"
5. Review installation details

**What It Checks:**
- Certificate validity
- Chain of trust
- Issuer details
- Expiration date
- Protocol version (TLS 1.2, 1.3)
- Cipher strength
- Common misconfigurations

#### 5.5 SSL Labs Server Test
Deep analysis using Qualys SSL Labs comprehensive testing platform.

**Features:**
- Grade rating (A+ to F)
- Protocol support analysis
- Vulnerability scanning
- Configuration recommendations
- Detailed security report

**Usage:**
1. Navigate to SSL Tools → SSL Labs Server Test
2. Enter hostname
3. Click "Test with SSL Labs"
4. Opens SSL Labs in new window
5. Wait for comprehensive analysis

**What It Tests:**
- Certificate chain issues
- Protocol support (TLS versions)
- Key exchange strength
- Cipher suite strength
- Known vulnerabilities (Heartbleed, POODLE, etc.)
- Forward secrecy support
- HSTS implementation
- Certificate transparency

### Accessing SSL Tools

**From Dashboard:**
- Click "SSL Tools" in navigation menu
- Or visit `/ssltools.html` directly

**Available Without Login:**
SSL Tools can be used by anyone - no authentication required for utility functions.

### API Endpoints

```javascript
// Decode certificate
POST /api/ssltools/decode-cert
Body: { certText: "-----BEGIN CERTIFICATE-----..." }

// Decode CSR
POST /api/ssltools/decode-csr
Body: { csrText: "-----BEGIN CERTIFICATE REQUEST-----..." }

// Match certificate and key
POST /api/ssltools/match-key
Body: { 
  certText: "-----BEGIN CERTIFICATE-----...",
  keyText: "-----BEGIN PRIVATE KEY-----..."
}

// Check SSL installation
POST /api/ssltools/check-installation
Body: { hostname: "example.com", port: 443 }

// Get SSL Labs URL
GET /api/ssltools/ssllabs/:hostname
```

---

## 6. Enhanced Registration Security

### Overview
Registration form now includes password confirmation to prevent typos and improve account security.

### Features
- Password confirmation field
- Real-time validation
- Clear error messages
- Prevents password typos

### How It Works

**Registration Flow:**
1. User fills in name and email
2. Enters password (minimum 8 characters)
3. Re-enters password in confirmation field
4. System validates passwords match
5. If mismatch: Shows error "Passwords do not match"
6. If match: Account created successfully

### Implementation Details

**Frontend Validation:**
```javascript
if (password !== confirmPassword) {
  errorBox.textContent = 'Passwords do not match';
  errorBox.classList.add('visible');
  return;
}
```

**Password Requirements:**
- Minimum 8 characters
- No maximum length
- All characters allowed
- Case sensitive

### User Experience

**Error States:**
- "Passwords do not match" - Passwords don't match
- "Password must be at least 8 characters" - Too short
- Other validation errors from server

**Success State:**
- Automatic redirect to dashboard
- JWT token set
- User logged in

---

## 7. API Reference

### Alert Emails API

#### GET /api/alert-emails
Get all alert emails for authenticated user.

**Authentication:** Required  
**Response:**
```json
[
  {
    "id": 1,
    "user_id": 123,
    "email": "alerts@example.com",
    "group_id": null,
    "group_name": null,
    "is_global": 1,
    "created_at": "2026-09-20T10:30:00Z"
  }
]
```

#### POST /api/alert-emails
Add new alert email.

**Authentication:** Required  
**Body:**
```json
{
  "email": "team@example.com",
  "groupId": 5,
  "isGlobal": false
}
```

**Response:**
```json
{
  "id": 2,
  "user_id": 123,
  "email": "team@example.com",
  "group_id": 5,
  "group_name": "Production",
  "is_global": 0,
  "created_at": "2026-09-20T10:35:00Z"
}
```

**Errors:**
- `400` - Invalid email or limit reached (5 max)
- `404` - Group not found

#### DELETE /api/alert-emails/:id
Remove alert email.

**Authentication:** Required  
**Response:**
```json
{ "success": true }
```

### Certificates API

#### POST /api/certificates/letsencrypt/start
Start Let's Encrypt certificate generation.

**Authentication:** Required  
**Body:**
```json
{
  "domain": "example.com"
}
```

**Response:**
```json
{
  "id": 1,
  "domain": "example.com",
  "challengeToken": "_acme-challenge.example.com",
  "challengeValue": "abc123xyz789...",
  "instructions": "Please add a DNS TXT record..."
}
```

#### POST /api/certificates/letsencrypt/complete/:id
Complete Let's Encrypt after DNS verification.

**Authentication:** Required  
**Response:**
```json
{
  "success": true,
  "files": ["README.txt", "cert.pem", "chain.pem", "fullchain.pem", "privkey.pem"],
  "downloadPath": "/api/certificates/download/1"
}
```

#### POST /api/certificates/selfsigned
Generate self-signed certificate.

**Authentication:** Required  
**Body:**
```json
{
  "domain": "internal.example.com",
  "commonName": "internal.example.com",
  "organization": "Example Inc",
  "organizationalUnit": "IT",
  "locality": "San Francisco",
  "state": "California",
  "country": "US",
  "validityDays": 825
}
```

**Response:**
```json
{
  "success": true,
  "id": 2,
  "files": ["README.txt", "ca.crt", "ca.key", "internal.example.com.crt", "internal.example.com.key"],
  "downloadPath": "/api/certificates/download/2"
}
```

#### POST /api/certificates/csr
Generate Certificate Signing Request.

**Authentication:** Required  
**Body:**
```json
{
  "domain": "www.example.com",
  "commonName": "www.example.com",
  "organization": "Example Inc",
  "organizationalUnit": "IT",
  "locality": "New York",
  "state": "New York",
  "country": "US",
  "email": "admin@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "id": 3,
  "files": ["README.txt", "www.example.com.csr", "www.example.com.key"],
  "downloadPath": "/api/certificates/download/3"
}
```

#### GET /api/certificates
List all certificates for authenticated user.

**Authentication:** Required  
**Response:**
```json
[
  {
    "id": 1,
    "domain": "example.com",
    "type": "letsencrypt",
    "status": "completed",
    "created_at": "2026-09-20T10:00:00Z",
    "completed_at": "2026-09-20T10:15:00Z"
  }
]
```

#### GET /api/certificates/download/:id
Get certificate files download information.

**Authentication:** Required  
**Response:**
```json
{
  "path": "/data/certs/123/example.com-letsencrypt",
  "files": ["README.txt", "cert.pem", "chain.pem", "fullchain.pem", "privkey.pem"],
  "message": "Certificate files are ready at: /data/certs/123/example.com-letsencrypt"
}
```

#### DELETE /api/certificates/:id
Delete certificate and associated files.

**Authentication:** Required  
**Response:**
```json
{ "success": true }
```

### SSL Tools API

#### POST /api/ssltools/decode-cert
Decode X.509 certificate.

**Authentication:** Not required  
**Body:**
```json
{
  "certText": "-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----"
}
```

**Response:**
```json
{
  "decoded": "Certificate:\n    Data:\n        Version: 3 (0x2)..."
}
```

#### POST /api/ssltools/decode-csr
Decode Certificate Signing Request.

**Authentication:** Not required  
**Body:**
```json
{
  "csrText": "-----BEGIN CERTIFICATE REQUEST-----\nMIIC...\n-----END CERTIFICATE REQUEST-----"
}
```

**Response:**
```json
{
  "decoded": "Certificate Request:\n    Data:\n        Version: 1 (0x0)..."
}
```

#### POST /api/ssltools/match-key
Verify certificate and key match.

**Authentication:** Not required  
**Body:**
```json
{
  "certText": "-----BEGIN CERTIFICATE-----...",
  "keyText": "-----BEGIN PRIVATE KEY-----..."
}
```

**Response:**
```json
{
  "match": true,
  "message": "Certificate and private key match!"
}
```

#### POST /api/ssltools/check-installation
Check SSL installation on server.

**Authentication:** Not required  
**Body:**
```json
{
  "hostname": "example.com",
  "port": 443
}
```

**Response:**
```json
{
  "installed": true,
  "certificate": {
    "subject": { "CN": "example.com" },
    "issuer": { "CN": "Let's Encrypt Authority" },
    "validFrom": "Sep  1 00:00:00 2026 GMT",
    "validTo": "Dec  1 23:59:59 2026 GMT",
    "serialNumber": "ABC123...",
    "fingerprint": "AA:BB:CC:...",
    "fingerprint256": "11:22:33:..."
  },
  "connection": {
    "protocol": "TLSv1.3",
    "cipher": "TLS_AES_256_GCM_SHA384",
    "bits": 256
  },
  "chainValid": true,
  "chainError": null
}
```

---

## 8. Database Schema Changes

### New Tables

#### alert_emails
Stores additional email addresses for alerts.

```sql
CREATE TABLE alert_emails (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  is_global   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_alert_emails_user ON alert_emails(user_id);
CREATE INDEX idx_alert_emails_group ON alert_emails(group_id);
```

**Columns:**
- `id`: Primary key
- `user_id`: Owner of this alert email
- `group_id`: NULL for global, or specific group ID
- `email`: Email address to receive alerts
- `is_global`: 1 for global alerts, 0 for group-specific
- `created_at`: Timestamp

#### certificates
Stores generated certificates and CSRs.

```sql
CREATE TABLE certificates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,
  type            TEXT NOT NULL,           -- letsencrypt | selfsigned | csr
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | failed
  challenge_token TEXT,                    -- For Let's Encrypt DNS challenge
  challenge_value TEXT,
  cert_data       TEXT,                    -- JSON with cert paths/contents
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

CREATE INDEX idx_certificates_user ON certificates(user_id);
```

**Columns:**
- `id`: Primary key
- `user_id`: Owner of certificate
- `domain`: Domain name
- `type`: Certificate type (letsencrypt, selfsigned, csr)
- `status`: Generation status (pending, completed, failed)
- `challenge_token`: DNS challenge token (Let's Encrypt)
- `challenge_value`: DNS challenge value (Let's Encrypt)
- `cert_data`: JSON with file paths and metadata
- `created_at`: Creation timestamp
- `completed_at`: Completion timestamp

### Migration

The application automatically creates these tables on startup. No manual migration needed.

**Checking Tables:**
```sql
-- Check if alert_emails table exists
SELECT name FROM sqlite_master WHERE type='table' AND name='alert_emails';

-- Check if certificates table exists
SELECT name FROM sqlite_master WHERE type='table' AND name='certificates';

-- View alert_emails
SELECT * FROM alert_emails;

-- View certificates
SELECT * FROM certificates;
```

---

## 9. Installation & Setup

### Prerequisites

**System Requirements:**
- Node.js 18 or higher
- Ubuntu 20.04+ / Debian 11+ / CentOS 8+
- 2GB RAM minimum
- OpenSSL (pre-installed on most systems)
- Certbot (for Let's Encrypt features)

### Installing Dependencies

#### 1. Install Certbot (for Let's Encrypt)

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install certbot
```

**CentOS/RHEL:**
```bash
sudo yum install certbot
```

**macOS:**
```bash
brew install certbot
```

**Verify Installation:**
```bash
certbot --version
```

#### 2. Install OpenSSL (usually pre-installed)

**Ubuntu/Debian:**
```bash
sudo apt install openssl
```

**Verify Installation:**
```bash
openssl version
```

#### 3. Update Application

**Pull Latest Code:**
```bash
cd /path/to/harisree-ssl-alerts
git pull origin main
```

**Install Node Dependencies:**
```bash
npm install
```

**Update Database Schema:**
The application automatically creates new tables on startup. Just restart:

```bash
# If using npm
npm start

# If using Docker
docker compose restart

# If using systemd
sudo systemctl restart harisree
```

### Configuration

#### Environment Variables

Add to your `.env` file:

```bash
# Existing variables remain the same
PORT=3000
NODE_ENV=production
APP_URL=https://sslalerts.info
JWT_SECRET=your_jwt_secret

# Email configuration (already configured)
SMTP_HOST=in-v3.mailjet.com
SMTP_PORT=587
MAIL_FROM=alerts@sslalerts.info

# No new environment variables needed!
```

### File Permissions

Create directory for certificate storage:

```bash
mkdir -p data/certs
chmod 755 data/certs
```

### Verify Installation

#### 1. Check Database Tables

```bash
sqlite3 data/harisree.db "SELECT name FROM sqlite_master WHERE type='table';"
```

Should include: `alert_emails`, `certificates`

#### 2. Test API Endpoints

```bash
# Test SSL Tools (no auth required)
curl -X POST http://localhost:3000/api/ssltools/decode-cert \
  -H "Content-Type: application/json" \
  -d '{"certText":"invalid"}'

# Should return error (expected - proves endpoint works)
```

#### 3. Check Frontend

Visit in browser:
- http://localhost:3000/ssltools.html - SSL Tools page
- http://localhost:3000/signup.html - Should show password confirmation

### Deployment

#### Docker Deployment

```bash
# Rebuild with new code
docker compose down
docker compose up -d --build

# Check logs
docker compose logs -f
```

#### Systemd Deployment

```bash
# Restart service
sudo systemctl restart harisree

# Check status
sudo systemctl status harisree

# View logs
journalctl -u harisree -f
```

### Troubleshooting

#### Common Issues

**1. Certbot Not Found**
```bash
# Install certbot
sudo apt install certbot

# Verify
which certbot
```

**2. Permission Denied on Certificate Files**
```bash
# Fix permissions
sudo chown -R $USER:$USER data/certs
chmod -R 755 data/certs
```

**3. Database Errors**
```bash
# Backup database
cp data/harisree.db data/harisree.db.backup

# Check integrity
sqlite3 data/harisree.db "PRAGMA integrity_check;"

# Restart application (auto-creates missing tables)
npm start
```

**4. OpenSSL Errors**
```bash
# Verify OpenSSL installation
openssl version -a

# Reinstall if needed
sudo apt install --reinstall openssl
```

### Testing New Features

#### Test Multi-Email Alerts

```bash
# 1. Log in to dashboard
# 2. Add domain to monitor
# 3. Navigate to "Alert Settings"
# 4. Add email: test@example.com
# 5. Trigger test alert (set domain to expire soon)
# 6. Check both emails receive alerts
```

#### Test Certificate Generation

**Let's Encrypt:**
1. Go to Certificates → Generate Certificate
2. Select Let's Encrypt
3. Enter domain you control
4. Add DNS TXT record
5. Complete generation
6. Verify files downloaded

**Self-Signed:**
1. Go to Certificates → Generate Certificate
2. Select Self-Signed
3. Fill in details
4. Generate
5. Verify files downloaded
6. Test certificate in nginx

**CSR:**
1. Go to Certificates → Generate CSR
2. Fill in details
3. Generate
4. Verify `.csr` and `.key` files
5. Submit CSR to test CA (optional)

#### Test SSL Tools

1. Visit `/ssltools.html`
2. Test Certificate Decoder with any valid cert
3. Test CSR Decoder with generated CSR
4. Test Certificate Key Matcher
5. Test SSL Installation Checker on live domain
6. Test SSL Labs redirect

---

## Support & Documentation

### Getting Help

**Issues:**
- Check logs: `journalctl -u harisree -f` or `docker compose logs -f`
- Review this documentation
- Check API responses for error messages

**Feature Requests:**
- Submit feature request to development team
- Include use case and expected behavior

**Bug Reports:**
- Include error messages
- Provide steps to reproduce
- Note system information (OS, Node version, etc.)

### Additional Resources

**External Documentation:**
- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [OpenSSL Command Line](https://www.openssl.org/docs/man1.1.1/man1/)
- [SSL Labs Best Practices](https://github.com/ssllabs/research/wiki/SSL-and-TLS-Deployment-Best-Practices)
- [Nginx SSL Configuration](https://nginx.org/en/docs/http/configuring_https_servers.html)

### Security Best Practices

1. **Keep Private Keys Secure**
   - Never commit to version control
   - Restrict file permissions (600 or 400)
   - Store backups encrypted

2. **Regular Updates**
   - Update Node.js regularly
   - Keep OpenSSL current
   - Update certbot for latest features

3. **Monitor Certificates**
   - Use the dashboard to track all certificates
   - Set up alerts for expiring certificates
   - Regular security audits with SSL Labs

4. **Access Control**
   - Use strong JWT secrets
   - Implement rate limiting (optional)
   - Regular password rotations

---

## Changelog

### Version 2.0.0 - September 20, 2026

**New Features:**
- ✅ Multi-email alert recipients (up to 5 per user)
- ✅ Group-specific and global alert emails
- ✅ Let's Encrypt certificate generation with DNS challenge
- ✅ Self-signed certificate generation
- ✅ CSR (Certificate Signing Request) generation
- ✅ SSL Tools suite (decoder, key matcher, installation checker)
- ✅ Password confirmation on registration

**Database Changes:**
- Added `alert_emails` table
- Added `certificates` table
- New indexes for performance

**API Additions:**
- `/api/alert-emails/*` - Alert email management
- `/api/certificates/*` - Certificate generation
- `/api/ssltools/*` - SSL utilities

**UI Updates:**
- New SSL Tools page (`/ssltools.html`)
- Password confirmation on signup
- Certificate management interface (to be added to dashboard)

**Backend Improvements:**
- Enhanced scheduler with multi-email support
- Certificate generation workflows
- SSL testing utilities

---

## Future Enhancements

**Planned Features:**
- Certificate renewal automation
- Bulk certificate generation
- Certificate expiry tracking dashboard
- Email alert templates customization
- Webhook notifications
- API key authentication
- ACME v2 protocol support
- Wildcard certificate support

---

**Document Version:** 2.0.0  
**Last Updated:** September 20, 2026  
**Author:** HariSree SSL Alerts Team
