const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cookieParser = require('cookie-parser');

const { startScheduler } = require('./src/scheduler');
const authRoutes = require('./src/routes/auth');
const domainRoutes = require('./src/routes/domains');
const groupRoutes = require('./src/routes/groups');
const toolsRoutes = require('./src/routes/tools');
const alertEmailsRoutes = require('./src/routes/alertEmails');
const certificatesRoutes = require('./src/routes/certificates');
const ssltoolsRoutes = require('./src/routes/ssltools');
const { router: billingRoutes, handleWebhook, handleRazorpayWebhook, handleDodoWebhook } = require('./src/routes/billing');
const jwt = require('jsonwebtoken');
const { COOKIE_NAME, JWT_SECRET } = require('./src/auth');
const { db } = require('./src/db');

const app = express();
app.disable('x-powered-by');

// Payment webhooks need the raw body for signature verification — must be
// registered BEFORE express.json().
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleWebhook);
app.post('/api/billing/razorpay/webhook', express.raw({ type: 'application/json' }), handleRazorpayWebhook);
app.post('/api/billing/dodo/webhook', express.raw({ type: 'application/json' }), handleDodoWebhook);

app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/domains', domainRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/alert-emails', alertEmailsRoutes);
app.use('/api/certificates', certificatesRoutes);
app.use('/api/ssltools', ssltoolsRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// If already logged in, redirect away from login/signup straight to dashboard
async function redirectIfLoggedIn(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload && payload.uid) {
      const user = await db.getOne('SELECT id FROM users WHERE id = ?', [payload.uid]);
      if (user) {
        return res.redirect('/dashboard');
      }
    }
  } catch (_) {}
  next();
}

app.get(['/login', '/login.html', '/signup', '/signup.html'], redirectIfLoggedIn);

// Direct tool and doc URLs to unified dashboard sections
app.get(['/tools', '/tools.html', '/dns-lookup'], (req, res) => {
  res.redirect(302, '/dashboard#dns-lookup');
});
app.get(['/docs', '/docs.html'], (req, res) => {
  res.redirect(302, '/dashboard#docs');
});

// Admin panel is isolated in dedicated container (harisree-admin-panel on port 3005)
// Explicitly reject any admin URLs on this customer container with 404 Not Found
app.all(['/admin', '/admin.html', '/admin/*', '/api/admin', '/api/admin/*'], (req, res) => {
  res.status(404).send('Not Found');
});

// Clean URLs: redirect any request ending in .html (e.g. /dashboard.html -> /dashboard, /index.html -> /)
app.use((req, res, next) => {
  if (req.path === '/index.html') {
    const query = req.url.slice(req.path.length);
    return res.redirect(301, '/' + query);
  }
  if (req.path.endsWith('.html')) {
    const cleanPath = req.path.slice(0, -5);
    const query = req.url.slice(req.path.length);
    return res.redirect(301, cleanPath + query);
  }
  next();
});

// Serve static assets with automatic .html extension resolution for clean URLs
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html']
}));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Catch-all error handler — without this, an unexpected throw inside a route
// bubbles up and can take the whole process down, turning one bad request
// into a site-wide 502.
app.use((err, req, res, next) => {
  console.error('[server] unhandled route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

// Last-resort guards so a stray async rejection can't kill the server.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SSL Alerts listening on port ${PORT}`);
  startScheduler();
});
