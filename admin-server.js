const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cookieParser = require('cookie-parser');

const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const { COOKIE_NAME, JWT_SECRET } = require('./src/auth');
const { db } = require('./src/db');

const app = express();
app.disable('x-powered-by');

const PORT = parseInt(process.env.PORT, 10) || 3005;

app.use(express.json());
app.use(cookieParser());

// Mount administrative & authentication APIs
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'harisree-admin-panel',
    port: PORT,
    time: new Date().toISOString()
  });
});

// Serve static assets (CSS, JS, logos, marks)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Admin Command Center UI on root and /admin
app.get(['/', '/admin', '/admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Fallback for any unknown route -> redirect to Admin Command Center
app.use((req, res) => {
  res.redirect(302, '/');
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Admin Panel Error]', err);
  res.status(500).json({ error: 'Internal administrator service error.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[harisree-admin-panel] Admin Command Center listening on port ${PORT}`);
});
