# HariSree SSL Alerts

SSL certificate expiry monitoring, built to run comfortably on a $12/mo
2GB VPS. Users add domains, a daily background job checks each
certificate over a real TLS handshake, and email alerts fire at
30 / 14 / 7 / 1 days before expiry (and again if it actually expires).

- **Backend:** Node.js + Express
- **Database:** SQLite (via `better-sqlite3`) — zero-config, no separate DB server to run
- **Cert checks:** Node's built-in `tls` module, no external dependency
- **Scheduling:** `node-cron` — a full daily sweep of every domain, plus a
  lightweight sweep every 30 minutes that re-checks and re-alerts on any
  domain still sitting in warning/critical/expired and not yet acknowledged
- **Email:** Mailjet HTTP API (preferred — sidesteps SMTP port blocking on most cloud hosts), with `nodemailer` SMTP as a fallback
- **Billing:** Stripe Checkout (optional — app works without it in "manual plan" mode)
- **Groups & Admin panel:** organize domains into groups; a built-in admin
  panel at `/admin.html` shows signups, plan breakdown, and per-user domain counts

## Repeat alerts until acknowledged

The moment a domain's certificate enters `warning`, `critical`, or `expired`,
an alert email goes out immediately. If it's still in that state and hasn't
been acknowledged in the dashboard, another email goes out every 30 minutes.
Clicking **Acknowledge** on that domain's row pauses the repeats — the pause
lifts automatically the moment the status changes again (renewed, or gotten
worse), so a genuinely new problem always gets a fresh alert cycle.

## Admin panel

Set `ADMIN_EMAIL` in `.env` to the email address you sign up with (or an
existing account's email) — that account gets admin access automatically on
next login, and can see `/admin.html`: total signups, paid vs. trial
breakdown, estimated MRR, and a table of every user with their plan and
domain count. There's also a "Run sweep now" button to trigger an immediate
check of every domain.

---

## 1. Local setup

```bash
npm install
cp .env.example .env
# edit .env — at minimum set JWT_SECRET
npm start
```

Visit `http://localhost:3000`.

Without an email provider configured, the app still works fully — alert emails are
just logged to the console instead of sent, so you can develop without
a mail server.

---

## 2. Deploying to your 2GB VPS (Docker — recommended)

```bash
# On your machine: upload the project
scp -r harisree-ssl-alerts your_user@your_server_ip:/opt/

# On the server:
cd /opt/harisree-ssl-alerts
bash deploy/deploy.sh        # installs Docker if missing, then asks you to fill .env
nano .env                    # set JWT_SECRET, MAILJET_API_KEY/SECRET (or SMTP_*), APP_URL
bash deploy/deploy.sh        # run again to build & start
```

The app now listens on port 3000. Put nginx in front of it for TLS:

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
sudo cp deploy/nginx.conf /etc/nginx/sites-available/harisree
sudo ln -s /etc/nginx/sites-available/harisree /etc/nginx/sites-enabled/
sudo nano /etc/nginx/sites-available/harisree   # replace yourdomain.com
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Your site is now live at `https://yourdomain.com` with auto-renewing SSL
(yes — the SSL monitoring app needs its own SSL cert too).

**Useful commands:**
```bash
docker compose logs -f          # view app logs
docker compose restart          # restart after editing .env
docker compose down && docker compose up -d --build   # redeploy after code changes
```

---

## 3. Deploying without Docker (systemd)

```bash
# Install Node 20 (nvm or NodeSource), then:
npm install --omit=dev
cp .env.example .env && nano .env

sudo useradd -r -s /bin/false harisree
sudo mkdir -p /opt/harisree-ssl-alerts
sudo cp -r . /opt/harisree-ssl-alerts
sudo chown -R harisree:harisree /opt/harisree-ssl-alerts

sudo cp deploy/harisree.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now harisree
journalctl -u harisree -f       # view logs
```

Then set up nginx + certbot exactly as in the Docker section above.

---

## 4. Enabling subscription billing (Dodo Payments)

Subscriptions, automated upgrades, plan downgrades, and customer billing are powered by **Dodo Payments** (Merchant of Record):

1. Get your API Key, Webhook Secret, and Product IDs from your [Dodo Payments Dashboard](https://test.dodopayments.com).
2. Set the following environment variables in `.env`:
   ```ini
   DODO_PAYMENTS_API_KEY=your_api_key
   DODO_PAYMENTS_WEBHOOK_KEY=whsec_your_webhook_secret
   DODO_PAYMENTS_ENVIRONMENT=test_mode # or live_mode

   DODO_PRODUCT_MICRO=pdt_xxxxxx
   DODO_PRODUCT_STARTER=pdt_xxxxxx
   DODO_PRODUCT_GROWTH=pdt_xxxxxx
   DODO_PRODUCT_PRO=pdt_xxxxxx
   DODO_PRODUCT_AGENCY=pdt_xxxxxx
   ```
3. Register your webhook URL in the Dodo Payments dashboard:
   `https://yourdomain.com/api/billing/dodo/webhook`
   Subscribed events: `subscription.active`, `subscription.renewed`, `subscription.cancelled`, `subscription.failed`, `payment.succeeded`.
4. **Features Included**:
   - **Instant Upgrades**: Higher quotas apply immediately; previous lower plans are automatically cancelled in Dodo to prevent double billing.
   - **Self-Service Downgrades**: Customers can downgrade to lower paid tiers right from the modal with built-in domain quota validation.
   - **Cancellation**: Subscriptions can be cancelled via support email or the self-service Customer Portal link on receipt emails. Monitoring automatically pauses when a subscription ends.

---

## 5. How the numbers work on a 2GB box

- Checking a certificate is a single TLS handshake — a fraction of a
  second and a few KB of RAM. Even thousands of domains checked daily
  is light work for this server; compute is not the bottleneck.
- The real ceiling is RAM for the app + SQLite database, which comfortably
  supports **well over a thousand users** worth of domains before you'd
  need to size up.
- `CHECK_CONCURRENCY` in `.env` controls how many certificates are
  checked in parallel during the nightly sweep — raise it if you have
  thousands of domains and want the sweep to finish faster; lower it if
  you ever see memory pressure.

## 6. Project structure

```
server.js              Express app entry point
src/
  db.js                 SQLite schema + plan definitions
  auth.js                JWT + password hashing helpers
  certChecker.js         TLS handshake → certificate status
  scheduler.js            Daily sweep + alert thresholds
  mailer.js                Branded alert emails
  routes/
    auth.js                 register / login / logout / me
    domains.js               add / list / delete / re-check domains
    billing.js               Stripe checkout + webhook
public/                Static frontend (no build step required)
  index.html               Marketing/landing page
  login.html, signup.html   Auth pages
  dashboard.html            The app itself
  css/style.css             Design system
  js/app.js                 Dashboard logic
  assets/                   Logo + favicon
deploy/                Nginx config, systemd unit, deploy script
```

## 7. Backups

The entire database is one file: `data/harisree.db` (plus `-wal`/`-shm`
companions while running). A simple cron backup is enough:

```bash
0 4 * * * cp /opt/harisree-ssl-alerts/data/harisree.db /backups/harisree-$(date +\%F).db
```
