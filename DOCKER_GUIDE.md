# 🐳 Docker Deployment Guide

## Quick Start

```bash
# Navigate to project
cd ~/Documents/sslproject/harisree-ssl-alerts19/harisree-ssl-alerts

# Build and start
docker compose up -d --build

# View logs
docker compose logs -f

# Check status
docker compose ps
```

**Access the application:**
- Main app: http://localhost:3000
- Dashboard: http://localhost:3000/dashboard.html
- SSL Tools: http://localhost:3000/ssltools.html

---

## What's Included in the Docker Image

### Installed Packages
- ✅ Node.js 20 (Alpine Linux)
- ✅ OpenSSL (for certificate operations)
- ✅ Certbot (for Let's Encrypt)
- ✅ Python3 (certbot dependency)
- ✅ Build tools (for better-sqlite3)

### Volumes
- `./data:/app/data` - Persists database and certificates

### Ports
- `3000:3000` - Main application port

---

## Step-by-Step Deployment

### 1. Verify Configuration

Check your `.env` file:
```bash
cat .env | grep -E "NODE_ENV|APP_URL|COOKIE_SECURE"
```

Should show:
```
NODE_ENV=development
APP_URL=http://localhost:3000
COOKIE_SECURE=false
```

### 2. Build the Image

```bash
docker compose build
```

**Expected output:**
```
[+] Building 45.3s (12/12) FINISHED
 => [internal] load build definition from Dockerfile
 => => transferring dockerfile: 456B
 => [internal] load .dockerignore
 => [1/7] FROM docker.io/library/node:20-alpine
 => [2/7] RUN apk add --no-cache python3 make g++ openssl certbot bash
 => [3/7] WORKDIR /app
 => [4/7] COPY package.json ./
 => [5/7] RUN npm install --omit=dev
 => [6/7] COPY . .
 => [7/7] RUN mkdir -p /app/data /app/data/certs
 => exporting to image
 => => naming to docker.io/library/harisree-ssl-alerts-app
```

### 3. Start the Container

```bash
docker compose up -d
```

**Expected output:**
```
[+] Running 1/1
 ✔ Container harisree-ssl-alerts  Started
```

### 4. Verify It's Running

```bash
# Check container status
docker compose ps

# Should show:
# NAME                   IMAGE                        STATUS         PORTS
# harisree-ssl-alerts    harisree-ssl-alerts-app      Up 10 seconds  0.0.0.0:3000->3000/tcp
```

### 5. Check Logs

```bash
docker compose logs -f
```

**Expected output:**
```
harisree-ssl-alerts  | SSL Alerts listening on port 3000
harisree-ssl-alerts  | [scheduler] daily cert sweep scheduled: "0 3 * * *"
harisree-ssl-alerts  | [scheduler] repeat-alert sweep scheduled: "*/30 * * * *"
```

Press `Ctrl+C` to exit logs.

### 6. Test the Application

```bash
# Health check
curl http://localhost:3000/api/health

# Should return:
# {"ok":true,"time":"2026-09-20T14:57:00.000Z"}

# Test SSL Tools page
curl -I http://localhost:3000/ssltools.html

# Should return:
# HTTP/1.1 200 OK
```

---

## Verify All Features Work

### Test 1: Database Tables Created

```bash
# Enter the container
docker compose exec app sh

# Check database tables
sqlite3 /app/data/harisree.db "SELECT name FROM sqlite_master WHERE type='table';"

# Should show:
# users
# groups
# domains
# alerts_sent
# alert_log
# alert_emails     <-- NEW
# certificates     <-- NEW

# Exit container
exit
```

### Test 2: Certbot Installed

```bash
docker compose exec app certbot --version

# Should show:
# certbot 2.x.x
```

### Test 3: OpenSSL Available

```bash
docker compose exec app openssl version

# Should show:
# OpenSSL 3.x.x
```

### Test 4: Certificate Directory

```bash
docker compose exec app ls -la /app/data/

# Should show:
# drwxr-xr-x    2 node     node          4096 Sep 20 14:57 certs
# -rw-r--r--    1 node     node         12288 Sep 20 14:57 harisree.db
```

---

## Accessing the Application

### From Your Browser

1. **Home Page**: http://localhost:3000
2. **Sign Up**: http://localhost:3000/signup.html
3. **Login**: http://localhost:3000/login.html
4. **Dashboard**: http://localhost:3000/dashboard.html
5. **SSL Tools**: http://localhost:3000/ssltools.html

### Create Your First Account

```bash
# Option 1: Use the browser
# Visit http://localhost:3000/signup.html

# Option 2: Use curl
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Admin User",
    "email": "admin@example.com",
    "password": "password123"
  }'
```

---

## Docker Management Commands

### View Logs
```bash
# All logs
docker compose logs -f

# Last 100 lines
docker compose logs --tail=100

# Only errors
docker compose logs -f | grep -i error
```

### Restart Application
```bash
# Restart container
docker compose restart

# Or stop and start
docker compose stop
docker compose start
```

### Rebuild After Code Changes
```bash
# Stop, rebuild, and start
docker compose down
docker compose up -d --build
```

### Access Container Shell
```bash
# Interactive shell
docker compose exec app sh

# Run a single command
docker compose exec app ls -la /app
```

### Check Resource Usage
```bash
# Container stats
docker stats harisree-ssl-alerts

# Shows:
# - CPU usage
# - Memory usage
# - Network I/O
# - Disk I/O
```

---

## File Locations (Inside Container)

```
/app/                          # Application root
├── server.js                  # Main entry point
├── src/                       # Source code
│   ├── routes/
│   │   ├── alertEmails.js    # Alert email management
│   │   ├── certificates.js   # Certificate generation
│   │   └── ssltools.js       # SSL tools
│   ├── db.js                  # Database
│   ├── mailer.js              # Email sending
│   └── scheduler.js           # Cron jobs
├── public/                    # Static files
│   ├── ssltools.html         # SSL Tools page
│   └── signup.html           # Updated with password confirmation
└── data/                      # Persistent data (mounted volume)
    ├── harisree.db           # SQLite database
    ├── harisree.db-wal       # Write-ahead log
    ├── harisree.db-shm       # Shared memory
    └── certs/                # Generated certificates
        └── {user_id}/        # Per-user certificate storage
```

---

## Volume Management

### Backup Database

```bash
# Copy database from container
docker compose cp app:/app/data/harisree.db ./backup-$(date +%Y%m%d).db

# Or since it's mounted:
cp data/harisree.db backup-$(date +%Y%m%d).db
```

### Backup Certificates

```bash
# Backup all certificates
tar -czf certs-backup-$(date +%Y%m%d).tar.gz data/certs/

# Restore certificates
tar -xzf certs-backup-20260920.tar.gz
```

### Reset Everything

```bash
# Stop and remove container
docker compose down

# Remove all data (WARNING: This deletes everything!)
rm -rf data/

# Start fresh
docker compose up -d --build
```

---

## Testing New Features

### Test Multi-Email Alerts

```bash
# 1. Create account and login (get token from browser dev tools)
# 2. Add alert email

curl -X POST http://localhost:3000/api/alert-emails \
  -H "Content-Type: application/json" \
  -H "Cookie: token=YOUR_TOKEN_HERE" \
  -d '{
    "email": "alerts@example.com",
    "isGlobal": true
  }'
```

### Test Self-Signed Certificate Generation

```bash
curl -X POST http://localhost:3000/api/certificates/selfsigned \
  -H "Content-Type: application/json" \
  -H "Cookie: token=YOUR_TOKEN_HERE" \
  -d '{
    "domain": "test.local",
    "commonName": "test.local",
    "organization": "Test Company",
    "locality": "TestCity",
    "state": "TestState",
    "country": "US",
    "validityDays": 365
  }'

# Check generated files
docker compose exec app ls -la /app/data/certs/
```

### Test SSL Tools (No auth needed!)

```bash
# Certificate decoder
curl -X POST http://localhost:3000/api/ssltools/decode-cert \
  -H "Content-Type: application/json" \
  -d '{
    "certText": "-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----"
  }'

# SSL installation checker
curl -X POST http://localhost:3000/api/ssltools/check-installation \
  -H "Content-Type: application/json" \
  -d '{
    "hostname": "google.com",
    "port": 443
  }'
```

---

## Troubleshooting

### Port 3000 Already in Use

```bash
# Find what's using port 3000
lsof -i :3000

# Kill the process
kill -9 <PID>

# Or change port in .env
echo "PORT=3001" >> .env

# And update docker-compose.yml:
# ports:
#   - "3001:3001"
```

### Container Won't Start

```bash
# Check logs
docker compose logs

# Check if image built correctly
docker images | grep harisree

# Rebuild from scratch
docker compose down
docker compose build --no-cache
docker compose up -d
```

### Database Errors

```bash
# Check database file permissions
ls -la data/harisree.db

# Fix permissions
sudo chown -R $USER:$USER data/

# Check database integrity
docker compose exec app sqlite3 /app/data/harisree.db "PRAGMA integrity_check;"
```

### Certbot Errors

```bash
# Verify certbot is installed
docker compose exec app which certbot

# Check version
docker compose exec app certbot --version

# If missing, rebuild:
docker compose down
docker compose build --no-cache
docker compose up -d
```

### Out of Disk Space

```bash
# Check disk usage
df -h

# Clean up Docker
docker system prune -a

# Remove old images
docker images | grep harisree
docker rmi <IMAGE_ID>
```

---

## Production Deployment

### 1. Update Environment Variables

```bash
nano .env
```

Change:
```bash
NODE_ENV=production
APP_URL=https://yourdomain.com
COOKIE_SECURE=true
JWT_SECRET=<generate-strong-random-string>
```

### 2. Set Up Nginx Reverse Proxy

Create `/etc/nginx/sites-available/harisree`:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 3. Enable and Get SSL Certificate

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/harisree /etc/nginx/sites-enabled/

# Test config
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx

# Get SSL certificate
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

### 4. Configure Auto-Start

Docker compose already has `restart: unless-stopped` configured, so the container will automatically start on boot.

To ensure Docker starts on boot:
```bash
sudo systemctl enable docker
```

---

## Monitoring

### Application Logs

```bash
# Follow logs in real-time
docker compose logs -f app

# Search logs
docker compose logs app | grep "error"
docker compose logs app | grep "alert"
docker compose logs app | grep "certificate"
```

### Resource Monitoring

```bash
# Real-time stats
docker stats harisree-ssl-alerts

# Check disk usage
du -sh data/
du -sh data/certs/
```

### Health Checks

```bash
# Application health
curl http://localhost:3000/api/health

# Database health
docker compose exec app sqlite3 /app/data/harisree.db "SELECT COUNT(*) FROM users;"

# Certificate directory
docker compose exec app ls -la /app/data/certs/
```

---

## Updating the Application

```bash
# 1. Pull latest code
git pull origin main

# 2. Rebuild and restart
docker compose down
docker compose up -d --build

# 3. Verify new features
curl http://localhost:3000/api/health
```

---

## Complete Example Session

```bash
# 1. Navigate to project
cd ~/Documents/sslproject/harisree-ssl-alerts19/harisree-ssl-alerts

# 2. Build and start
docker compose up -d --build

# 3. Wait for startup (check logs)
docker compose logs -f
# Wait for: "SSL Alerts listening on port 3000"
# Press Ctrl+C to exit

# 4. Test health endpoint
curl http://localhost:3000/api/health
# Should return: {"ok":true,"time":"..."}

# 5. Open in browser
xdg-open http://localhost:3000/signup.html  # Linux
# or
open http://localhost:3000/signup.html      # macOS

# 6. Create account with password confirmation
# 7. Visit SSL Tools
xdg-open http://localhost:3000/ssltools.html

# 8. Check logs for any errors
docker compose logs --tail=50

# 9. All good! 🎉
```

---

## Quick Reference

### Essential Commands

```bash
# Start
docker compose up -d

# Stop
docker compose stop

# Restart
docker compose restart

# Logs
docker compose logs -f

# Rebuild
docker compose up -d --build

# Shell access
docker compose exec app sh

# Remove everything
docker compose down
```

### Important URLs

- Application: http://localhost:3000
- Dashboard: http://localhost:3000/dashboard.html
- SSL Tools: http://localhost:3000/ssltools.html
- Health: http://localhost:3000/api/health

### File Locations

- Database: `./data/harisree.db`
- Certificates: `./data/certs/`
- Config: `.env`
- Logs: `docker compose logs`

---

**Ready to run!** 🚀

Execute: `docker compose up -d --build`
