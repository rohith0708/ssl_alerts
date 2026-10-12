const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const DB_HOST = process.env.MYSQL_HOST || process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.MYSQL_PORT || process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.MYSQL_USER || process.env.DB_USER || 'harisree_user';
const DB_PASSWORD = process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || 'harisree_password';
const DB_NAME = process.env.MYSQL_DATABASE || process.env.DB_NAME || 'harisree_ssl';

const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  dateStrings: true
});

async function query(sql, params = []) {
  const [results] = await pool.query(sql, params);
  return results;
}

async function getOne(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows && rows.length > 0 ? rows[0] : null;
}

async function getAll(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows || [];
}

async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return {
    insertId: result.insertId,
    affectedRows: result.affectedRows,
    changedRows: result.changedRows
  };
}

async function transaction(fn) {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  const tx = {
    query: async (sql, params = []) => {
      const [results] = await conn.query(sql, params);
      return results;
    },
    getOne: async (sql, params = []) => {
      const [rows] = await conn.query(sql, params);
      return rows && rows.length > 0 ? rows[0] : null;
    },
    getAll: async (sql, params = []) => {
      const [rows] = await conn.query(sql, params);
      return rows || [];
    },
    execute: async (sql, params = []) => {
      const [res] = await conn.execute(sql, params);
      return {
        insertId: res.insertId,
        affectedRows: res.affectedRows
      };
    }
  };
  try {
    const result = await fn(tx);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      plan VARCHAR(50) NOT NULL DEFAULT 'trial',
      domain_limit BIGINT NOT NULL DEFAULT 3,
      stripe_customer_id VARCHAR(255) NULL,
      razorpay_customer_id VARCHAR(255) NULL,
      razorpay_subscription_id VARCHAR(255) NULL,
      current_period_end DATETIME NULL,
      billing_status VARCHAR(50) NOT NULL DEFAULT 'active',
      is_admin TINYINT(1) NOT NULL DEFAULT 0,
      is_verified TINYINT(1) NOT NULL DEFAULT 0,
      otp_code VARCHAR(255) NULL,
      otp_expires_at DATETIME NULL,
      pending_email VARCHAR(255) NULL,
      pending_email_otp VARCHAR(255) NULL,
      pending_email_expires_at DATETIME NULL,
      payment_reference VARCHAR(255) NULL,
      admin_notes TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  try {
    await pool.query('ALTER TABLE users MODIFY domain_limit BIGINT NOT NULL DEFAULT 5');
    await pool.query("UPDATE users SET domain_limit = 5 WHERE plan = 'trial' AND domain_limit < 5");
  } catch (_) {}
  try {
    await pool.query('ALTER TABLE users ADD COLUMN is_verified TINYINT(1) NOT NULL DEFAULT 0');
  } catch (_) {}
  try {
    await pool.query('ALTER TABLE users ADD COLUMN otp_code VARCHAR(255) NULL');
  } catch (_) {}
  try {
    await pool.query('ALTER TABLE users ADD COLUMN otp_expires_at DATETIME NULL');
  } catch (_) {}
  try {
    await pool.query('ALTER TABLE users ADD COLUMN reset_otp_code VARCHAR(255) NULL');
  } catch (_) {}
  try {
    await pool.query('ALTER TABLE users ADD COLUMN reset_otp_expires_at DATETIME NULL');
  } catch (_) {}
  try {
    await pool.query('ALTER TABLE users ADD COLUMN pending_email VARCHAR(255) NULL');
  } catch (_) {}
  try {
    await pool.query('ALTER TABLE users ADD COLUMN pending_email_otp VARCHAR(255) NULL');
  } catch (_) {}
  try {
    await pool.query('ALTER TABLE users ADD COLUMN pending_email_expires_at DATETIME NULL');
  } catch (_) {}
  try {
    await pool.query('ALTER TABLE users ADD COLUMN payment_reference VARCHAR(255) NULL');
  } catch (_) {}
  try {
    await pool.query('ALTER TABLE users ADD COLUMN admin_notes TEXT NULL');
  } catch (_) {}
  try {
    // Preserve existing accounts as verified
    await pool.query('UPDATE users SET is_verified = 1 WHERE is_verified = 0 AND created_at < NOW()');
  } catch (_) {}
  try {
    // Ensure all trial users have current_period_end capped at 30 days from creation
    await pool.query("UPDATE users SET current_period_end = DATE_ADD(created_at, INTERVAL 30 DAY) WHERE plan = 'trial' AND (current_period_end IS NULL OR current_period_end > DATE_ADD(created_at, INTERVAL 30 DAY))");
  } catch (_) {}
  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`groups\` (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_group (user_id, name),
      CONSTRAINT fk_groups_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS domains (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      group_id INT NULL,
      hostname VARCHAR(255) NOT NULL,
      port INT NOT NULL DEFAULT 443,
      label VARCHAR(255) NULL,
      source VARCHAR(50) NOT NULL DEFAULT 'remote',
      pem LONGTEXT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      issuer VARCHAR(255) NULL,
      valid_from VARCHAR(255) NULL,
      valid_to VARCHAR(255) NULL,
      days_left INT NULL,
      last_error TEXT NULL,
      last_checked_at DATETIME NULL,
      alert_acknowledged TINYINT(1) NOT NULL DEFAULT 0,
      last_alert_sent_at DATETIME NULL,
      status_since DATETIME NULL,
      consecutive_alerts INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_domain_port (user_id, hostname, port),
      CONSTRAINT fk_domains_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_domains_group FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  try {
    await pool.query('ALTER TABLE domains ADD COLUMN consecutive_alerts INT NOT NULL DEFAULT 0');
  } catch (_) {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts_sent (
      id INT AUTO_INCREMENT PRIMARY KEY,
      domain_id INT NOT NULL,
      threshold INT NOT NULL,
      sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_domain_threshold (domain_id, threshold),
      CONSTRAINT fk_alerts_domain FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      domain_id INT NOT NULL,
      user_id INT NOT NULL,
      status VARCHAR(50) NOT NULL,
      sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_alert_log_domain FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
      CONSTRAINT fk_alert_log_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_emails (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      email VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_email (user_id, email),
      CONSTRAINT fk_notif_emails_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_notification_emails (
      id INT AUTO_INCREMENT PRIMARY KEY,
      group_id INT NOT NULL,
      notification_email_id INT NOT NULL,
      UNIQUE KEY uq_group_notif (group_id, notification_email_id),
      CONSTRAINT fk_gne_group FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE CASCADE,
      CONSTRAINT fk_gne_email FOREIGN KEY (notification_email_id) REFERENCES notification_emails(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS generated_certificates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      type VARCHAR(50) NOT NULL,
      domain VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'completed',
      files_json LONGTEXT NOT NULL,
      expires_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_gen_certs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Seed default admin user: admin@sslalerts.info / admin@sslalerts
  try {
    const adminEmail = 'admin@sslalerts.info';
    const hash = bcrypt.hashSync('admin@sslalerts', 10);
    const existingAdmin = await getOne('SELECT id, password_hash, is_admin FROM users WHERE email = ?', [adminEmail]);
    if (!existingAdmin) {
      await execute(`
        INSERT INTO users (name, email, password_hash, plan, domain_limit, is_admin)
        VALUES (?, ?, ?, 'unlimited', 100000, 1)
      `, ['Administrator', adminEmail, hash]);
      console.log('[MySQL] Seeded admin user: ' + adminEmail);
    } else {
      await execute('UPDATE users SET is_admin = 1, password_hash = ? WHERE id = ?', [hash, existingAdmin.id]);
    }
  } catch (err) {
    console.error('[MySQL] Failed to seed admin user:', err.message);
  }

  if (process.env.ADMIN_EMAIL) {
    try {
      await execute('UPDATE users SET is_admin = 1 WHERE email = ?', [process.env.ADMIN_EMAIL.toLowerCase()]);
    } catch (_) {}
  }
}

initSchema().catch(err => {
  console.error('[MySQL] Schema initialization error:', err.message);
});

const PLANS = {
  trial: {
    label: 'Free Trial (30 Days)',
    subtitle: 'Good for basic testing & evaluation',
    price: 0,
    originalPrice: 0,
    domainLimit: 5,
    recipientLimit: 1,
    criticalIntervalMinutes: 180,
    warningIntervalMinutes: 1440,
    support: 'Standard',
    trialDays: 30,
    features: [
      '<strong>5</strong> domains monitored',
      'Daily SSL expiry checks',
      '<strong>1</strong> email alert recipient',
      '3-hour expiry alert intervals',
      'Let\'s Encrypt & self-signed cert generation with storage',
      'Status filters (warning/critical/healthy)',
      'Standard support'
    ]
  },
  micro: {
    label: 'Micro',
    subtitle: 'Good for personal projects & portfolios',
    price: 1,
    originalPrice: 2,
    badge: 'LIMITED TIME OFFER',
    domainLimit: 5,
    recipientLimit: 1,
    criticalIntervalMinutes: 180,
    warningIntervalMinutes: 1440,
    support: 'Standard',
    features: [
      '<strong>5</strong> domains monitored',
      'Daily SSL expiry checks',
      '<strong>1</strong> email alert recipient',
      '3-hour expiry alert intervals',
      'Cert generator with storage',
      'Status filters & SSL tools',
      'Standard support'
    ]
  },
  starter: {
    label: 'Starter',
    subtitle: 'Good for early-stage startups & individual developers',
    price: 5,
    originalPrice: 10,
    domainLimit: 20,
    recipientLimit: 3,
    criticalIntervalMinutes: 120,
    warningIntervalMinutes: 1440,
    support: 'Enhanced',
    features: [
      '<strong>20</strong> domains monitored',
      'Daily SSL expiry checks',
      'Up to <strong>3</strong> email recipients',
      '2-hour expiry alert intervals',
      'Cert generator with storage',
      'Status filters & SSL tools',
      'Enhanced support'
    ]
  },
  growth: {
    label: 'Growth',
    subtitle: 'Good for growing companies with multiple subdomains',
    price: 10,
    originalPrice: 20,
    domainLimit: 50,
    recipientLimit: 5,
    criticalIntervalMinutes: 60,
    warningIntervalMinutes: 1440,
    support: 'Enhanced',
    features: [
      '<strong>50</strong> domains monitored',
      'Daily SSL expiry checks',
      'Up to <strong>5</strong> email recipients',
      '1-hour expiry alert intervals',
      'Cert generator with storage',
      'Status filters & SSL tools',
      'Enhanced support'
    ]
  },
  pro: {
    label: 'Pro',
    subtitle: 'Good for businesses with large web infrastructure',
    price: 20,
    originalPrice: 40,
    domainLimit: 100,
    recipientLimit: 10,
    criticalIntervalMinutes: 30,
    warningIntervalMinutes: 1440,
    support: 'Premium',
    features: [
      '<strong>100</strong> domains monitored',
      'Daily SSL expiry checks',
      'Up to <strong>10</strong> email recipients',
      '30-min expiry alert intervals',
      'Cert generator with storage',
      'Status filters & SSL tools',
      'Premium support'
    ]
  },
  agency: {
    label: 'Agency',
    subtitle: 'Good for digital agencies & IT consultancies',
    price: 50,
    originalPrice: 99,
    domainLimit: 500,
    recipientLimit: 25,
    criticalIntervalMinutes: 10,
    warningIntervalMinutes: 1440,
    support: 'Dedicated',
    features: [
      '<strong>500</strong> domains monitored',
      'Daily SSL expiry checks',
      'Up to <strong>25</strong> email recipients',
      '10-min expiry alert intervals',
      'Cert generator with storage',
      'Status filters & SSL tools',
      'Dedicated support'
    ]
  },
  enterprise: {
    label: 'Enterprise',
    subtitle: 'Good for large enterprise portfolios & custom SLAs',
    price: 0,
    originalPrice: 0,
    domainLimit: 500,
    recipientLimit: 50,
    criticalIntervalMinutes: 10,
    warningIntervalMinutes: 1440,
    support: 'Dedicated SLA',
    enterprise: true,
    custom: true,
    features: [
      '<strong>500+</strong> domains monitored',
      'Daily SSL expiry checks',
      'Up to <strong>50+</strong> email recipients',
      'Custom expiry alert intervals',
      'Cert generator with storage',
      'Status filters & SSL tools',
      'Dedicated account manager & SLA'
    ]
  },
  unlimited: {
    label: 'Enterprise',
    subtitle: 'Good for large enterprise portfolios & custom SLAs',
    price: 0,
    originalPrice: 0,
    domainLimit: 100000,
    recipientLimit: 100,
    criticalIntervalMinutes: 10,
    warningIntervalMinutes: 1440,
    support: 'Dedicated SLA',
    enterprise: true,
    custom: true,
    features: [
      '<strong>500+</strong> domains monitored & custom expiry checks',
      'Up to <strong>100+</strong> email alert recipients',
      'Dedicated SLA & custom check intervals',
      'Cert generator with storage (storage until expiry)',
      'Status filters & SSL diagnostic tools',
      'Dedicated account manager & invoice billing'
    ]
  }
};

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@sslalerts.info';

module.exports = {
  db: {
    pool,
    query,
    getOne,
    getAll,
    execute,
    transaction
  },
  PLANS,
  SUPPORT_EMAIL,
  initSchema
};
