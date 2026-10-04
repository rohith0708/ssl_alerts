const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const mysql = require('mysql2/promise');

const SQLITE_PATH = process.env.DB_PATH || path.join(__dirname, '../data/harisree.db');
const DB_HOST = process.env.MYSQL_HOST || process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.MYSQL_PORT || process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.MYSQL_USER || process.env.DB_USER || 'harisree_user';
const DB_PASSWORD = process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || 'harisree_password';
const DB_NAME = process.env.MYSQL_DATABASE || process.env.DB_NAME || 'harisree_ssl';

async function runMigration() {
  console.log('=== STARTING SQLITE TO MYSQL MIGRATION ===\n');

  if (!fs.existsSync(SQLITE_PATH)) {
    console.log(`SQLite database file not found at ${SQLITE_PATH}. Nothing to migrate.`);
    return;
  }

  console.log(`Opening SQLite database: ${SQLITE_PATH}`);
  const sqlite = new Database(SQLITE_PATH, { readonly: true });

  console.log(`Connecting to MySQL at ${DB_HOST}:${DB_PORT}, database: ${DB_NAME}...`);
  const mysqlConn = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME
  });

  console.log('Connected to MySQL successfully.');

  const { initSchema } = require('../src/db');
  console.log('Ensuring MySQL schema exists...');
  await initSchema();

  // Disable FK checks during migration to allow inserting exact IDs
  await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 0');

  try {
    // 1. Users
    const users = sqlite.prepare('SELECT * FROM users').all();
    console.log(`Migrating ${users.length} users...`);
    for (const u of users) {
      await mysqlConn.execute(`
        INSERT INTO users (id, name, email, password_hash, plan, domain_limit, stripe_customer_id, razorpay_customer_id, razorpay_subscription_id, current_period_end, billing_status, is_admin, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          password_hash = VALUES(password_hash),
          plan = VALUES(plan),
          domain_limit = VALUES(domain_limit),
          is_admin = VALUES(is_admin)
      `, [
        u.id,
        u.name,
        u.email,
        u.password_hash,
        u.plan || 'trial',
        u.domain_limit || 3,
        u.stripe_customer_id || null,
        u.razorpay_customer_id || null,
        u.razorpay_subscription_id || null,
        u.current_period_end || null,
        u.billing_status || 'active',
        u.is_admin ? 1 : 0,
        u.created_at || new Date().toISOString()
      ]);
    }

    // 2. Groups
    const groups = sqlite.prepare('SELECT * FROM groups').all();
    console.log(`Migrating ${groups.length} groups...`);
    for (const g of groups) {
      await mysqlConn.execute(`
        INSERT IGNORE INTO \`groups\` (id, user_id, name, created_at)
        VALUES (?, ?, ?, ?)
      `, [g.id, g.user_id, g.name, g.created_at || new Date().toISOString()]);
    }

    // 3. Domains
    const domains = sqlite.prepare('SELECT * FROM domains').all();
    console.log(`Migrating ${domains.length} domains...`);
    for (const d of domains) {
      await mysqlConn.execute(`
        INSERT IGNORE INTO domains (id, user_id, group_id, hostname, port, label, source, pem, status, issuer, valid_from, valid_to, days_left, last_error, last_checked_at, alert_acknowledged, last_alert_sent_at, status_since, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        d.id,
        d.user_id,
        d.group_id || null,
        d.hostname,
        d.port || 443,
        d.label || null,
        d.source || 'remote',
        d.pem || null,
        d.status || 'pending',
        d.issuer || null,
        d.valid_from || null,
        d.valid_to || null,
        d.days_left !== undefined ? d.days_left : null,
        d.last_error || null,
        d.last_checked_at || null,
        d.alert_acknowledged ? 1 : 0,
        d.last_alert_sent_at || null,
        d.status_since || null,
        d.created_at || new Date().toISOString()
      ]);
    }

    // 4. Alerts Sent
    let alertsSent = [];
    try { alertsSent = sqlite.prepare('SELECT * FROM alerts_sent').all(); } catch (_) {}
    console.log(`Migrating ${alertsSent.length} alerts_sent records...`);
    for (const a of alertsSent) {
      await mysqlConn.execute(`
        INSERT IGNORE INTO alerts_sent (id, domain_id, threshold, sent_at)
        VALUES (?, ?, ?, ?)
      `, [a.id, a.domain_id, a.threshold, a.sent_at || new Date().toISOString()]);
    }

    // 5. Alert Log
    let alertLogs = [];
    try { alertLogs = sqlite.prepare('SELECT * FROM alert_log').all(); } catch (_) {}
    console.log(`Migrating ${alertLogs.length} alert_log records...`);
    for (const l of alertLogs) {
      await mysqlConn.execute(`
        INSERT IGNORE INTO alert_log (id, domain_id, user_id, status, sent_at)
        VALUES (?, ?, ?, ?, ?)
      `, [l.id, l.domain_id, l.user_id, l.status, l.sent_at || new Date().toISOString()]);
    }

    // 6. Notification Emails
    let notifEmails = [];
    try { notifEmails = sqlite.prepare('SELECT * FROM notification_emails').all(); } catch (_) {}
    console.log(`Migrating ${notifEmails.length} notification_emails...`);
    for (const ne of notifEmails) {
      await mysqlConn.execute(`
        INSERT IGNORE INTO notification_emails (id, user_id, email, created_at)
        VALUES (?, ?, ?, ?)
      `, [ne.id, ne.user_id, ne.email, ne.created_at || new Date().toISOString()]);
    }

    // 7. Group Notification Emails
    let groupNotifEmails = [];
    try { groupNotifEmails = sqlite.prepare('SELECT * FROM group_notification_emails').all(); } catch (_) {}
    console.log(`Migrating ${groupNotifEmails.length} group_notification_emails...`);
    for (const gne of groupNotifEmails) {
      await mysqlConn.execute(`
        INSERT IGNORE INTO group_notification_emails (id, group_id, notification_email_id)
        VALUES (?, ?, ?)
      `, [gne.id, gne.group_id, gne.notification_email_id]);
    }

    // 8. Generated Certificates
    let genCerts = [];
    try { genCerts = sqlite.prepare('SELECT * FROM generated_certificates').all(); } catch (_) {}
    console.log(`Migrating ${genCerts.length} generated_certificates...`);
    for (const c of genCerts) {
      await mysqlConn.execute(`
        INSERT IGNORE INTO generated_certificates (id, user_id, type, domain, status, files_json, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        c.id,
        c.user_id,
        c.type,
        c.domain,
        c.status || 'completed',
        c.files_json,
        c.expires_at || null,
        c.created_at || new Date().toISOString()
      ]);
    }

    console.log('\n✅ All data migrated successfully from SQLite to MySQL!');
  } finally {
    await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1');
    await mysqlConn.end();
    sqlite.close();
  }
}

runMigration().catch(err => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
