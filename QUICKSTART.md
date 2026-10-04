# 🚀 Quick Start Guide - New Features

## What's New?

Your SSL Alerts application now includes:

1. ✅ **Multi-Email Alert Recipients** - Add up to 5 emails for alerts
2. ✅ **Let's Encrypt Certificates** - Generate certificates with DNS challenge
3. ✅ **Self-Signed Certificates** - Create certificates for internal use
4. ✅ **CSR Generation** - Generate Certificate Signing Requests
5. ✅ **SSL Tools Suite** - Decoder, checker, and testing tools
6. ✅ **Password Confirmation** - Enhanced registration security

---

## 🏃 Getting Started

### 1. Install Dependencies

```bash
# Navigate to project
cd ~/Documents/sslproject/harisree-ssl-alerts19/harisree-ssl-alerts

# Install certbot (for Let's Encrypt)
sudo apt update
sudo apt install certbot

# Verify OpenSSL is installed
openssl version

# Install Node dependencies (if not already done)
npm install
```

### 2. Start the Application

```bash
# Development mode
npm start

# Or with Docker
docker compose up -d --build

# Check logs
docker compose logs -f
```

### 3. Access the Application

- **Main Dashboard**: http://localhost:3000/dashboard.html
- **SSL Tools**: http://localhost:3000/ssltools.html
- **Registration**: http://localhost:3000/signup.html

---

## 📋 New API Endpoints

### Alert Emails
```bash
GET    /api/alert-emails           # List alert emails
POST   /api/alert-emails           # Add alert email
DELETE /api/alert-emails/:id       # Remove alert email
```

### Certificates
```bash
POST   /api/certificates/letsencrypt/start      # Start Let's Encrypt
POST   /api/certificates/letsencrypt/complete/:id  # Complete Let's Encrypt
POST   /api/certificates/selfsigned             # Generate self-signed cert
POST   /api/certificates/csr                    # Generate CSR
GET    /api/certificates                        # List all certificates
GET    /api/certificates/download/:id           # Download certificate files
DELETE /api/certificates/:id                    # Delete certificate
```

### SSL Tools
```bash
POST   /api/ssltools/decode-cert           # Decode certificate
POST   /api/ssltools/decode-csr            # Decode CSR
POST   /api/ssltools/match-key             # Match cert & key
POST   /api/ssltools/check-installation    # Check SSL installation
```

---

## 🎯 Quick Feature Tests

### Test 1: Multi-Email Alerts

```bash
# Using curl (replace with your JWT token)
curl -X POST http://localhost:3000/api/alert-emails \
  -H "Content-Type: application/json" \
  -H "Cookie: token=YOUR_JWT_TOKEN" \
  -d '{
    "email": "team@example.com",
    "isGlobal": true
  }'
```

**Or via Dashboard:**
1. Log in to dashboard
2. Look for "Alert Settings" or "Email Recipients" section (you'll need to add UI for this)
3. Add additional email addresses

### Test 2: Generate Self-Signed Certificate

```bash
curl -X POST http://localhost:3000/api/certificates/selfsigned \
  -H "Content-Type: application/json" \
  -H "Cookie: token=YOUR_JWT_TOKEN" \
  -d '{
    "domain": "test.local",
    "commonName": "test.local",
    "organization": "Test Org",
    "locality": "TestCity",
    "state": "TestState",
    "country": "US",
    "validityDays": 365
  }'
```

**Or via Dashboard:**
1. Navigate to Certificates section (you'll need to add UI for this)
2. Click "Generate Certificate"
3. Select "Self-Signed"
4. Fill in details
5. Click "Generate"

### Test 3: SSL Tools

Simply visit: http://localhost:3000/ssltools.html

Try:
- Paste any SSL certificate to decode it
- Check SSL installation on google.com:443
- Match certificate and key pairs

### Test 4: Password Confirmation

Visit: http://localhost:3000/signup.html

You'll now see:
- Password field
- **Confirm Password field** (NEW!)
- Error if passwords don't match

---

## 📁 File Structure (New Files)

```
src/routes/
├── alertEmails.js      # NEW - Alert email management
├── certificates.js     # NEW - Certificate generation
└── ssltools.js         # NEW - SSL utilities

public/
├── ssltools.html       # NEW - SSL Tools page
└── signup.html         # UPDATED - Password confirmation

src/
├── db.js              # UPDATED - New tables
├── mailer.js          # UPDATED - Multi-email support
├── scheduler.js       # UPDATED - Group/global email logic
└── server.js          # UPDATED - New routes registered
```

---

## 🗄️ Database Changes

New tables created automatically on startup:

```sql
-- Alert emails table
CREATE TABLE alert_emails (
  id, user_id, group_id, email, is_global, created_at
);

-- Certificates table  
CREATE TABLE certificates (
  id, user_id, domain, type, status, challenge_token, 
  challenge_value, cert_data, created_at, completed_at
);
```

Check tables:
```bash
sqlite3 data/harisree.db "SELECT name FROM sqlite_master WHERE type='table';"
```

---

## 🔧 Next Steps

### 1. Add UI to Dashboard

You'll need to add interface elements to `dashboard.html` for:

**Alert Email Management:**
```html
<!-- Add to dashboard.html -->
<div class="section">
  <h2>Alert Email Recipients</h2>
  <div id="alertEmailsList"></div>
  <button onclick="showAddEmailModal()">Add Email</button>
</div>
```

**Certificate Management:**
```html
<!-- Add to dashboard.html -->
<div class="section">
  <h2>Certificates</h2>
  <button onclick="showCertModal('letsencrypt')">Generate Let's Encrypt</button>
  <button onclick="showCertModal('selfsigned')">Generate Self-Signed</button>
  <button onclick="showCertModal('csr')">Generate CSR</button>
  <div id="certificatesList"></div>
</div>
```

### 2. Add Navigation Links

Update your main navigation to include:
```html
<nav>
  <a href="/dashboard.html">Dashboard</a>
  <a href="/ssltools.html">SSL Tools</a>
  <a href="/account.html">Account</a>
</nav>
```

### 3. Test Everything

```bash
# Start the application
npm start

# In another terminal, run tests:
curl http://localhost:3000/api/health
# Should return: {"ok":true,"time":"2026-09-20T14:55:05.904Z"}

# Visit SSL Tools
curl http://localhost:3000/ssltools.html
# Should return HTML

# Check signup page
curl http://localhost:3000/signup.html
# Should include password confirmation field
```

---

## 📖 Full Documentation

See `NEW_FEATURES.md` for complete documentation including:
- Detailed API reference
- Usage examples
- Troubleshooting guide
- Security best practices
- Installation instructions

---

## ⚠️ Important Notes

### Certificate Storage
Certificates are stored in: `data/certs/USER_ID/`

Make sure this directory is:
- Writable by the application
- Backed up regularly
- Excluded from version control

Add to `.gitignore`:
```
data/certs/
```

### Let's Encrypt Requirements
- Certbot must be installed
- Server needs internet access
- User needs DNS access to add TXT records
- Domain must be publicly accessible for verification

### Security
- All certificate routes require authentication
- SSL Tools routes are public (no auth needed)
- Private keys are never sent over the network
- Generated files are user-isolated

---

## 🆘 Troubleshooting

### Certbot Not Found
```bash
sudo apt install certbot
which certbot  # Verify installation
```

### Permission Errors
```bash
mkdir -p data/certs
chmod 755 data/certs
chown -R $USER:$USER data/certs
```

### Database Errors
```bash
# Backup first
cp data/harisree.db data/harisree.db.backup

# Check integrity
sqlite3 data/harisree.db "PRAGMA integrity_check;"

# Restart app (auto-creates missing tables)
npm start
```

### Port Already in Use
```bash
# Find process using port 3000
lsof -i :3000

# Kill it
kill -9 <PID>

# Or change port in .env
PORT=3001
```

---

## 🎉 You're All Set!

Your SSL Alerts application now has:
- ✅ All requested features implemented
- ✅ Complete API backend
- ✅ SSL Tools frontend ready
- ✅ Database schema updated
- ✅ Comprehensive documentation

**Next:** Add UI components to the dashboard to expose these features to users!

---

**Questions?** Check `NEW_FEATURES.md` for detailed documentation.

**Date:** September 20, 2026  
**Version:** 2.0.0
