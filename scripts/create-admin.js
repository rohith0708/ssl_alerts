require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');

async function main() {
  const args = process.argv.slice(2);
  const email = (args[0] || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = args[1] || 'Admin@123456';
  const name = args[2] || 'Super Administrator';

  if (!email) {
    console.error('❌ Error: Email is required.');
    console.log('\nUsage:');
    console.log('  node scripts/create-admin.js <email> [password] [name]');
    console.log('\nExample:');
    console.log('  node scripts/create-admin.js admin@sslalerts.info SecurePass123! "Super Admin"\n');
    process.exit(1);
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    const existing = await db.getOne('SELECT id, email, is_admin FROM users WHERE email = ?', [email]);

    if (existing) {
      await db.execute(`
        UPDATE users 
        SET is_admin = 1, is_verified = 1, plan = 'unlimited', domain_limit = 999999, password_hash = ?
        WHERE id = ?
      `, [hash, existing.id]);
      console.log(`\n✅ Success: Existing user updated to Superadmin!`);
      console.log(`   User ID:  ${existing.id}`);
      console.log(`   Email:    ${email}`);
    } else {
      const res = await db.execute(`
        INSERT INTO users (name, email, password_hash, plan, domain_limit, is_admin, is_verified)
        VALUES (?, ?, ?, 'unlimited', 999999, 1, 1)
      `, [name, email, hash]);
      await db.execute('INSERT INTO `groups` (user_id, name) VALUES (?, ?)', [res.insertId, 'General']);
      console.log(`\n✅ Success: Brand new Superadmin account created!`);
      console.log(`   User ID:  ${res.insertId}`);
      console.log(`   Email:    ${email}`);
      console.log(`   Name:     ${name}`);
    }

    console.log(`   Password: ${password}`);
    console.log(`   Plan:     Unlimited (999,999 domains)`);
    console.log(`   Status:   Verified (no OTP required)`);
    console.log(`   Admin:    Yes\n`);
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Database error creating admin user:', err.message || err);
    process.exit(1);
  }
}

main();
