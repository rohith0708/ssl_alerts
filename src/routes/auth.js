const express = require('express');
const crypto = require('crypto');
const { db, PLANS } = require('../db');
const {
  hashPassword, verifyPassword, issueToken,
  setAuthCookie, clearAuthCookie, requireAuth
} = require('../auth');
const { sendOtpEmail, sendEmailChangeOtpEmail, sendPasswordResetOtpEmail } = require('../mailer');

const router = express.Router();

function isAdminEmail(email) {
  return process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase();
}

function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    return 'Password is required.';
  }
  if (password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must contain at least one lowercase letter (a-z).';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter (A-Z).';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number (0-9).';
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)) {
    return 'Password must contain at least one special character (!@#$%^&* etc.).';
  }
  return null;
}

function generateOtp() {
  return crypto.randomInt(100000, 999999).toString();
}

function attachTrialInfo(user) {
  if (!user) return user;
  if (user.plan === 'trial') {
    let trialEndMs = null;
    const trialDays = (PLANS && PLANS.trial && PLANS.trial.trialDays) || 30;
    const maxTrialDurationMs = trialDays * 24 * 60 * 60 * 1000;

    if (user.created_at) {
      const createdMs = new Date(user.created_at).getTime();
      const calculatedEndMs = createdMs + maxTrialDurationMs;
      if (user.current_period_end) {
        const periodEndMs = new Date(user.current_period_end).getTime();
        trialEndMs = Math.min(periodEndMs, calculatedEndMs);
      } else {
        trialEndMs = calculatedEndMs;
      }
    } else if (user.current_period_end) {
      trialEndMs = new Date(user.current_period_end).getTime();
    } else {
      trialEndMs = Date.now() + maxTrialDurationMs;
    }

    const nowMs = Date.now();
    const diffMs = trialEndMs - nowMs;
    const daysLeft = Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));

    user.trial_days_left = daysLeft;
    user.trial_end_date = new Date(trialEndMs).toISOString();

    if (diffMs <= 0 || daysLeft <= 0) {
      user.trial_expires_text = 'Free trial expired';
      user.is_trial_expired = true;
    } else if (daysLeft === 1) {
      user.trial_expires_text = 'Free trial expires in 1 day';
      user.is_trial_expired = false;
    } else {
      user.trial_expires_text = `Free trial expires in ${daysLeft} days`;
      user.is_trial_expired = false;
    }
  } else {
    user.trial_days_left = null;
    user.trial_expires_text = null;
    user.is_trial_expired = false;
  }
  return user;
}

const resendRateLimits = new Map();

const {
  createRateLimiter,
  recordFailedOtpAttempt,
  clearFailedOtpAttempts,
  isOtpLocked,
  MAX_OTP_ATTEMPTS
} = require('../security');

// Defensive rate limiters against brute force and automated scraping
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 15,
  message: 'Too many login attempts. Please wait 15 minutes before trying again.'
});

const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: 'Too many registration attempts. Please try again later.'
});

const otpRequestLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: 'Too many verification code requests. Please wait before requesting another code.'
});

function isDevOtpAllowed() {
  return process.env.ALLOW_DEV_OTP === 'true' && process.env.NODE_ENV === 'test';
}

router.post('/register', registerLimiter, async (req, res) => {
  const { name, email, password, confirmPassword } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are all required.' });
  }

  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match. Please re-enter your password.' });
  }

  const passwordError = validatePasswordStrength(password);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await db.getOne('SELECT id, is_verified FROM users WHERE email = ?', [normalizedEmail]);

  if (existing && existing.is_verified) {
    return res.status(409).json({ error: 'An account with that email already exists. Please log in.' });
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  let userId;
  if (existing && !existing.is_verified) {
    await db.execute(`
      UPDATE users SET name = ?, password_hash = ?, otp_code = ?, otp_expires_at = ?
      WHERE id = ?
    `, [name.trim(), hashPassword(password), otp, expiresAt, existing.id]);
    userId = existing.id;
  } else {
    const trialDays = (PLANS && PLANS.trial && PLANS.trial.trialDays) || 30;
    const trialEnd = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const info = await db.execute(`
      INSERT INTO users (name, email, password_hash, plan, domain_limit, is_verified, otp_code, otp_expires_at, current_period_end)
      VALUES (?, ?, ?, 'trial', ?, 0, ?, ?, ?)
    `, [
      name.trim(),
      normalizedEmail,
      hashPassword(password),
      PLANS.trial.domainLimit,
      otp,
      expiresAt,
      trialEnd
    ]);
    userId = info.insertId;

    if (isAdminEmail(normalizedEmail)) {
      await db.execute('UPDATE users SET is_admin = 1 WHERE id = ?', [userId]);
    }
    await db.execute('INSERT INTO `groups` (user_id, name) VALUES (?, ?)', [userId, 'General']);
  }

  await sendOtpEmail({ to: normalizedEmail, name: name.trim(), otp });

  const responsePayload = {
    requireOtp: true,
    email: normalizedEmail,
    message: `A 6-digit verification code has been sent to ${normalizedEmail}.`
  };
  if (isDevOtpAllowed()) {
    responsePayload.devOtp = otp;
  }

  res.status(200).json(responsePayload);
});

router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and verification code are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Check brute force lockout
  if (isOtpLocked(normalizedEmail)) {
    return res.status(429).json({
      error: 'Too many incorrect attempts. For security, this verification code has been cancelled. Please request a new code.'
    });
  }

  const user = await db.getOne('SELECT * FROM users WHERE email = ?', [normalizedEmail]);

  if (!user) {
    return res.status(404).json({ error: 'Account not found. Please sign up first.' });
  }

  if (user.is_verified) {
    clearFailedOtpAttempts(normalizedEmail);
    const token = issueToken(user);
    setAuthCookie(res, token);
    const safeUser = await db.getOne('SELECT id, name, email, plan, domain_limit, is_admin, billing_status, current_period_end, created_at FROM users WHERE id = ?', [user.id]);
    return res.json({ success: true, user: attachTrialInfo(safeUser), message: 'Email is already verified.' });
  }

  if (!user.otp_code || !user.otp_expires_at) {
    return res.status(400).json({ error: 'No verification code found. Please request a new one.' });
  }

  const now = new Date();
  const expiresAt = new Date(user.otp_expires_at);
  if (now > expiresAt) {
    return res.status(400).json({ error: 'Verification code has expired. Please click "Resend code" to request a new one.' });
  }

  if (String(user.otp_code).trim() !== String(otp).trim()) {
    const attempts = recordFailedOtpAttempt(normalizedEmail);
    if (attempts >= MAX_OTP_ATTEMPTS) {
      await db.execute('UPDATE users SET otp_code = NULL, otp_expires_at = NULL WHERE id = ?', [user.id]);
      return res.status(429).json({
        error: 'Too many incorrect attempts. For security, this verification code has been cancelled. Please request a new code.'
      });
    }
    const remaining = MAX_OTP_ATTEMPTS - attempts;
    return res.status(400).json({
      error: `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
    });
  }

  clearFailedOtpAttempts(normalizedEmail);
  await db.execute('UPDATE users SET is_verified = 1, otp_code = NULL, otp_expires_at = NULL WHERE id = ?', [user.id]);

  const verifiedUser = await db.getOne('SELECT * FROM users WHERE id = ?', [user.id]);
  const token = issueToken(verifiedUser);
  setAuthCookie(res, token);

  const safeUser = await db.getOne('SELECT id, name, email, plan, domain_limit, is_admin, billing_status, current_period_end, created_at FROM users WHERE id = ?', [user.id]);
  res.json({ success: true, user: attachTrialInfo(safeUser) });
});

router.post('/resend-otp', otpRequestLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.getOne('SELECT id, name, is_verified FROM users WHERE email = ?', [normalizedEmail]);

  if (!user) {
    return res.status(404).json({ error: 'Account not found with that email.' });
  }
  if (user.is_verified) {
    return res.status(400).json({ error: 'This email is already verified. You can log in.' });
  }

  const lastSent = resendRateLimits.get(normalizedEmail) || 0;
  const elapsed = (Date.now() - lastSent) / 1000;
  if (elapsed < 60) {
    const waitSeconds = Math.ceil(60 - elapsed);
    return res.status(429).json({ error: `Please wait ${waitSeconds} seconds before requesting a new code.` });
  }

  resendRateLimits.set(normalizedEmail, Date.now());
  clearFailedOtpAttempts(normalizedEmail);

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  await db.execute('UPDATE users SET otp_code = ?, otp_expires_at = ? WHERE id = ?', [otp, expiresAt, user.id]);
  await sendOtpEmail({ to: normalizedEmail, name: user.name, otp });

  const payload = {
    success: true,
    message: `A new verification code has been sent to ${normalizedEmail}.`
  };
  if (isDevOtpAllowed()) {
    payload.devOtp = otp;
  }

  res.json(payload);
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = (email || '').trim().toLowerCase();
  const user = await db.getOne('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  if (user.is_verified === 0) {
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await db.execute('UPDATE users SET otp_code = ?, otp_expires_at = ? WHERE id = ?', [otp, expiresAt, user.id]);
    await sendOtpEmail({ to: normalizedEmail, name: user.name, otp });

    const payload = {
      error: 'Please verify your email address to continue. A new 6-digit code has been sent to your email.',
      requireOtp: true,
      email: normalizedEmail
    };
    if (isDevOtpAllowed()) {
      payload.devOtp = otp;
    }
    return res.status(403).json(payload);
  }

  if (isAdminEmail(user.email) && !user.is_admin) {
    await db.execute('UPDATE users SET is_admin = 1 WHERE id = ?', [user.id]);
  }
  const token = issueToken(user);
  setAuthCookie(res, token);
  const safeUser = await db.getOne('SELECT id, name, email, plan, domain_limit, is_admin, billing_status, current_period_end, created_at FROM users WHERE id = ?', [user.id]);
  res.json({ user: attachTrialInfo(safeUser) });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await db.getOne('SELECT id, name, email, plan, domain_limit, is_admin, billing_status, current_period_end, created_at FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: attachTrialInfo(user), plans: PLANS });
});

router.patch('/profile', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  if (name.length > 80) return res.status(400).json({ error: 'Keep the name under 80 characters.' });

  await db.execute('UPDATE users SET name = ? WHERE id = ?', [name, req.userId]);
  const user = await db.getOne('SELECT id, name, email, plan, domain_limit, is_admin, billing_status, current_period_end, created_at FROM users WHERE id = ?', [req.userId]);
  res.json({ user: attachTrialInfo(user) });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Enter your current password and a new one.' });
  }
  const passErr = validatePasswordStrength(newPassword);
  if (passErr) {
    return res.status(400).json({ error: passErr });
  }

  const user = await db.getOne('SELECT * FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(401).json({ error: 'Session no longer valid, please sign in again.' });
  if (!verifyPassword(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), req.userId]);
  res.json({ ok: true });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
router.patch('/email', requireAuth, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const existing = await db.getOne('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.userId]);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  await db.execute('UPDATE users SET email = ? WHERE id = ?', [email, req.userId]);
  await db.execute('DELETE FROM notification_emails WHERE user_id = ? AND email = ?', [req.userId, email]);

  if (isAdminEmail(email)) {
    await db.execute('UPDATE users SET is_admin = 1 WHERE id = ?', [req.userId]);
  }

  const updatedUser = await db.getOne('SELECT id, name, email, plan, domain_limit, is_admin, billing_status, current_period_end, created_at FROM users WHERE id = ?', [req.userId]);
  const token = issueToken(updatedUser);
  setAuthCookie(res, token);
  res.json({ user: attachTrialInfo(updatedUser) });
});

// User self-service: request primary email change with OTP
router.post('/request-email-change', requireAuth, async (req, res) => {
  try {
    const { new_email, current_password } = req.body || {};
    if (!new_email || typeof new_email !== 'string') {
      return res.status(400).json({ error: 'New email address is required.' });
    }

    const normalizedEmail = new_email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const user = await db.getOne('SELECT id, name, email, password_hash FROM users WHERE id = ?', [req.userId]);
    if (!user) {
      return res.status(401).json({ error: 'Session no longer valid. Please sign in again.' });
    }

    if (normalizedEmail === user.email.toLowerCase()) {
      return res.status(400).json({ error: 'New email is identical to your current email.' });
    }

    // If current_password is provided, verify it
    if (current_password !== undefined && current_password !== '') {
      if (!verifyPassword(current_password, user.password_hash)) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }
    }

    const collision = await db.getOne('SELECT id FROM users WHERE email = ? AND id != ?', [normalizedEmail, req.userId]);
    if (collision) {
      return res.status(409).json({ error: 'An account with that email address already exists.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    await db.execute(`
      UPDATE users SET
        pending_email = ?,
        pending_email_otp = ?,
        pending_email_expires_at = ?
      WHERE id = ?
    `, [normalizedEmail, otp, expiresAt, req.userId]);

    await sendEmailChangeOtpEmail({
      to: normalizedEmail,
      name: user.name,
      otp,
      oldEmail: user.email
    });

    const responseData = {
      requireOtp: true,
      pending_email: normalizedEmail,
      message: `A 6-digit verification code has been dispatched to ${normalizedEmail}.`
    };
    if (isDevOtpAllowed()) {
      responseData.devOtp = otp;
    }
    res.json(responseData);
  } catch (err) {
    console.error('Error requesting user email change:', err);
    res.status(500).json({ error: err.message || 'Failed to initiate email change.' });
  }
});

// User self-service: confirm primary email change with OTP
router.post('/confirm-email-change', requireAuth, async (req, res) => {
  try {
    const { otp } = req.body || {};
    if (!otp) {
      return res.status(400).json({ error: 'Verification code is required.' });
    }

    const lockKey = `change_${req.userId}`;
    if (isOtpLocked(lockKey)) {
      return res.status(429).json({
        error: 'Too many incorrect attempts. For security, this verification code has been cancelled. Please request a new code.'
      });
    }

    const user = await db.getOne('SELECT id, name, email, password_hash, pending_email, pending_email_otp, pending_email_expires_at FROM users WHERE id = ?', [req.userId]);
    if (!user) {
      return res.status(401).json({ error: 'Session no longer valid. Please sign in again.' });
    }

    if (!user.pending_email || !user.pending_email_otp) {
      return res.status(400).json({ error: 'No email change in progress. Please request a new verification code.' });
    }

    const now = new Date();
    const expiresAt = new Date(user.pending_email_expires_at);
    if (now > expiresAt) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    if (String(user.pending_email_otp).trim() !== String(otp).trim()) {
      const attempts = recordFailedOtpAttempt(lockKey);
      if (attempts >= MAX_OTP_ATTEMPTS) {
        await db.execute('UPDATE users SET pending_email_otp = NULL, pending_email_expires_at = NULL WHERE id = ?', [req.userId]);
        return res.status(429).json({
          error: 'Too many incorrect attempts. For security, this verification code has been cancelled. Please request a new code.'
        });
      }
      const remaining = MAX_OTP_ATTEMPTS - attempts;
      return res.status(400).json({
        error: `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
      });
    }

    clearFailedOtpAttempts(lockKey);

    const collision = await db.getOne('SELECT id FROM users WHERE email = ? AND id != ?', [user.pending_email, req.userId]);
    if (collision) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const newEmail = user.pending_email;
    const oldEmail = user.email;

    // Update primary email while preserving password_hash as old
    await db.execute(`
      UPDATE users SET
        email = ?,
        pending_email = NULL,
        pending_email_otp = NULL,
        pending_email_expires_at = NULL
      WHERE id = ?
    `, [newEmail, req.userId]);

    // Update primary email in notification_emails if old email was present
    await db.execute(`
      UPDATE notification_emails SET email = ? WHERE user_id = ? AND email = ?
    `, [newEmail, req.userId, oldEmail]);

    if (isAdminEmail(newEmail)) {
      await db.execute('UPDATE users SET is_admin = 1 WHERE id = ?', [req.userId]);
    }

    const updatedUser = await db.getOne('SELECT id, name, email, plan, domain_limit, is_admin, billing_status, current_period_end, created_at FROM users WHERE id = ?', [req.userId]);
    const token = issueToken(updatedUser);
    setAuthCookie(res, token);

    res.json({
      success: true,
      user: attachTrialInfo(updatedUser),
      message: `Primary email updated to ${newEmail}. Your password remains unchanged.`
    });
  } catch (err) {
    console.error('Error confirming user email change:', err);
    res.status(500).json({ error: err.message || 'Failed to update email.' });
  }
});

// User self-service: resend email change OTP
router.post('/resend-email-otp', requireAuth, otpRequestLimiter, async (req, res) => {
  try {
    const user = await db.getOne('SELECT id, name, email, pending_email FROM users WHERE id = ?', [req.userId]);
    if (!user || !user.pending_email) {
      return res.status(400).json({ error: 'No pending email change to resend code for.' });
    }

    clearFailedOtpAttempts(`change_${req.userId}`);

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    await db.execute(`
      UPDATE users SET pending_email_otp = ?, pending_email_expires_at = ? WHERE id = ?
    `, [otp, expiresAt, req.userId]);

    await sendEmailChangeOtpEmail({
      to: user.pending_email,
      name: user.name,
      otp,
      oldEmail: user.email
    });

    const responseData = {
      requireOtp: true,
      pending_email: user.pending_email,
      message: `A fresh 6-digit verification code has been dispatched to ${user.pending_email}.`
    };
    if (isDevOtpAllowed()) {
      responseData.devOtp = otp;
    }
    res.json(responseData);
  } catch (err) {
    console.error('Error resending email OTP:', err);
    res.status(500).json({ error: err.message || 'Failed to resend verification code.' });
  }
});

// ---------------- Forgot & Reset Password ----------------
router.post('/forgot-password', otpRequestLimiter, async (req, res) => {
  try {
    const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
    if (!normalizedEmail || !EMAIL_RE.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const user = await db.getOne('SELECT id, name, email FROM users WHERE LOWER(email) = ?', [normalizedEmail]);
    if (!user) {
      console.warn(`[auth:forgot-password] Requested for non-existent email: "${normalizedEmail}"`);
      return res.status(404).json({ error: 'No account found with this email address. Please check your spelling or sign up.' });
    }

    const lastSent = resendRateLimits.get('fp_' + normalizedEmail) || 0;
    const elapsed = (Date.now() - lastSent) / 1000;
    if (elapsed < 60) {
      const waitSeconds = Math.ceil(60 - elapsed);
      return res.status(429).json({ error: `Please wait ${waitSeconds} seconds before requesting another code.` });
    }

    resendRateLimits.set('fp_' + normalizedEmail, Date.now());
    clearFailedOtpAttempts('reset_' + normalizedEmail);

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    await db.execute(`
      UPDATE users SET reset_otp_code = ?, reset_otp_expires_at = ? WHERE id = ?
    `, [otp, expiresAt, user.id]);

    await sendPasswordResetOtpEmail({ to: user.email, name: user.name, otp });

    const payload = {
      ok: true,
      message: `A 6-digit password reset code has been sent to ${user.email}. Please check your inbox and Spam folder.`
    };
    res.json(payload);
  } catch (err) {
    console.error('Error in forgot-password:', err);
    res.status(500).json({ error: 'Failed to process password reset request.' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    const confirmPassword = req.body?.confirmPassword !== undefined ? String(req.body.confirmPassword) : undefined;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: 'Email, verification code, and new password are all required.' });
    }

    const lockKey = `reset_${email}`;
    if (isOtpLocked(lockKey)) {
      return res.status(429).json({
        error: 'Too many incorrect attempts. For security, this reset code has been cancelled. Please request a new code.'
      });
    }

    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    const passErr = validatePasswordStrength(newPassword);
    if (passErr) {
      return res.status(400).json({ error: passErr });
    }

    const user = await db.getOne('SELECT id, reset_otp_code, reset_otp_expires_at FROM users WHERE email = ?', [email]);
    if (!user || !user.reset_otp_code || !user.reset_otp_expires_at) {
      return res.status(400).json({ error: 'Invalid or expired password reset request. Please request a new code.' });
    }

    if (new Date() > new Date(user.reset_otp_expires_at)) {
      return res.status(400).json({ error: 'Password reset code has expired. Please request a new one.' });
    }

    if (String(user.reset_otp_code).trim() !== otp) {
      const attempts = recordFailedOtpAttempt(lockKey);
      if (attempts >= MAX_OTP_ATTEMPTS) {
        await db.execute('UPDATE users SET reset_otp_code = NULL, reset_otp_expires_at = NULL WHERE id = ?', [user.id]);
        return res.status(429).json({
          error: 'Too many incorrect attempts. For security, this reset code has been cancelled. Please request a new code.'
        });
      }
      const remaining = MAX_OTP_ATTEMPTS - attempts;
      return res.status(400).json({
        error: `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
      });
    }

    clearFailedOtpAttempts(lockKey);

    await db.execute(`
      UPDATE users SET password_hash = ?, reset_otp_code = NULL, reset_otp_expires_at = NULL WHERE id = ?
    `, [hashPassword(newPassword), user.id]);

    res.json({ ok: true, message: 'Your password has been successfully reset. You can now log in.' });
  } catch (err) {
    console.error('Error in reset-password:', err);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

module.exports = router;
