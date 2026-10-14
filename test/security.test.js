const assert = require('assert');
const {
  isPrivateIp,
  validatePublicHost,
  createRateLimiter,
  securityHeadersMiddleware,
  recordFailedOtpAttempt,
  clearFailedOtpAttempts,
  isOtpLocked,
  MAX_OTP_ATTEMPTS
} = require('../src/security');
const { verifyStandardWebhook } = require('../src/routes/billing');

async function runTests() {
  console.log('--- STARTING SECURITY SUITE TESTS ---');

  // Test 1: Private IP Detection (IPv4 & IPv6)
  console.log('Test 1: Testing Private IP Detection...');
  assert.strictEqual(isPrivateIp('127.0.0.1'), true, '127.0.0.1 must be private');
  assert.strictEqual(isPrivateIp('127.255.255.255'), true, '127.x must be private');
  assert.strictEqual(isPrivateIp('10.0.0.1'), true, '10.0.0.1 must be private');
  assert.strictEqual(isPrivateIp('172.16.0.1'), true, '172.16.0.1 must be private');
  assert.strictEqual(isPrivateIp('172.18.0.5'), true, '172.18.0.5 must be private');
  assert.strictEqual(isPrivateIp('172.31.255.255'), true, '172.31.x must be private');
  assert.strictEqual(isPrivateIp('192.168.1.1'), true, '192.168.1.1 must be private');
  assert.strictEqual(isPrivateIp('169.254.169.254'), true, '169.254.x cloud metadata must be private');
  assert.strictEqual(isPrivateIp('0.0.0.0'), true, '0.0.0.0 must be private');
  assert.strictEqual(isPrivateIp('100.64.0.1'), true, '100.64.x CGNAT must be private');
  assert.strictEqual(isPrivateIp('224.0.0.1'), true, 'Multicast must be private');
  assert.strictEqual(isPrivateIp('::1'), true, 'IPv6 loopback must be private');
  assert.strictEqual(isPrivateIp('fe80::1'), true, 'IPv6 link-local must be private');
  assert.strictEqual(isPrivateIp('fc00::1'), true, 'IPv6 unique local must be private');
  assert.strictEqual(isPrivateIp('fd12:3456:789a::1'), true, 'IPv6 unique local must be private');
  assert.strictEqual(isPrivateIp('::ffff:127.0.0.1'), true, 'IPv4-mapped loopback must be private');

  // Public IPs
  assert.strictEqual(isPrivateIp('1.1.1.1'), false, '1.1.1.1 must be public');
  assert.strictEqual(isPrivateIp('8.8.8.8'), false, '8.8.8.8 must be public');
  assert.strictEqual(isPrivateIp('104.154.89.105'), false, '104.x must be public');
  console.log('✓ Test 1 Passed: Private IP detection is completely accurate.');

  // Test 2: SSRF Hostname & DNS Resolution Validation
  console.log('Test 2: Testing SSRF Validation (validatePublicHost)...');
  const resLocalhost = await validatePublicHost('localhost');
  assert.strictEqual(resLocalhost.valid, false, 'localhost must be rejected');

  const resLoopbackIp = await validatePublicHost('127.0.0.1');
  assert.strictEqual(resLoopbackIp.valid, false, '127.0.0.1 must be rejected');

  const resMeta = await validatePublicHost('169.254.169.254');
  assert.strictEqual(resMeta.valid, false, '169.254.169.254 must be rejected');

  const resLocalDomain = await validatePublicHost('myserver.local');
  assert.strictEqual(resLocalDomain.valid, false, '*.local must be rejected');

  const resPublic = await validatePublicHost('one.one.one.one');
  assert.strictEqual(resPublic.valid, true, 'Public domain must be valid');
  assert.ok(resPublic.ips.length > 0, 'Public domain must have resolved IPs');
  console.log('✓ Test 2 Passed: SSRF protection strictly blocks internal and restricted targets.');

  // Test 3: Security Headers Middleware
  console.log('Test 3: Testing Security Headers Middleware...');
  const headers = {};
  const mockReq = { secure: true, headers: { 'x-forwarded-proto': 'https' } };
  const mockRes = {
    setHeader(k, v) { headers[k] = v; }
  };
  securityHeadersMiddleware(mockReq, mockRes, () => {});
  assert.strictEqual(headers['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.strictEqual(headers['X-XSS-Protection'], '1; mode=block');
  assert.strictEqual(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.ok(headers['Strict-Transport-Security'].includes('max-age=31536000'));
  console.log('✓ Test 3 Passed: Standard defensive security headers are correctly applied.');

  // Test 4: Rate Limiter Middleware
  console.log('Test 4: Testing Sliding Window Rate Limiter...');
  const limiter = createRateLimiter({
    windowMs: 10000,
    max: 3,
    message: 'Rate limit reached',
    keyGenerator: () => 'test_client_1'
  });

  let nextCalled = 0;
  let statusSet = null;
  let jsonOutput = null;

  const runLimiterReq = () => {
    statusSet = null;
    jsonOutput = null;
    const req = {};
    const res = {
      setHeader() {},
      status(s) {
        statusSet = s;
        return { json(j) { jsonOutput = j; } };
      }
    };
    limiter(req, res, () => { nextCalled += 1; });
  };

  runLimiterReq(); // 1st
  assert.strictEqual(nextCalled, 1);
  runLimiterReq(); // 2nd
  assert.strictEqual(nextCalled, 2);
  runLimiterReq(); // 3rd
  assert.strictEqual(nextCalled, 3);
  runLimiterReq(); // 4th -> should be blocked!
  assert.strictEqual(nextCalled, 3);
  assert.strictEqual(statusSet, 429);
  assert.strictEqual(jsonOutput.error, 'Rate limit reached');
  console.log('✓ Test 4 Passed: Rate limiter properly enforces threshold and returns HTTP 429.');

  // Test 5: OTP Attempt Lockout
  console.log('Test 5: Testing OTP Attempt Lockout...');
  const testEmail = 'victim_test_' + Date.now() + '@example.com';
  clearFailedOtpAttempts(testEmail);
  assert.strictEqual(isOtpLocked(testEmail), false);

  for (let i = 1; i <= 4; i++) {
    const attempts = recordFailedOtpAttempt(testEmail);
    assert.strictEqual(attempts, i);
    assert.strictEqual(isOtpLocked(testEmail), false);
  }

  // 5th attempt locks it
  const finalAttempts = recordFailedOtpAttempt(testEmail);
  assert.strictEqual(finalAttempts, 5);
  assert.strictEqual(isOtpLocked(testEmail), true, 'Account must be locked on 5th failure');

  clearFailedOtpAttempts(testEmail);
  assert.strictEqual(isOtpLocked(testEmail), false, 'Account must be unlocked after clearing');
  console.log('✓ Test 5 Passed: OTP attempt counting and lockout working as intended.');

  // Test 6: Dodo Standard Webhook Verification
  console.log('Test 6: Testing Webhook Signature Verification...');
  const crypto = require('crypto');
  const secretKey = 'whsec_testsecret1234567890';
  const timestamp = Math.floor(Date.now() / 1000);
  const webhookId = 'msg_test123';
  const payload = JSON.stringify({ type: 'payment.succeeded', data: { id: 'pay_123' } });

  const toSign = `${webhookId}.${timestamp}.${payload}`;
  const rawKey = secretKey.startsWith('whsec_') ? Buffer.from(secretKey.slice(6), 'base64') : Buffer.from(secretKey);
  const signature = 'v1,' + crypto.createHmac('sha256', rawKey).update(toSign).digest('base64');

  const webhookReq = {
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signature
    },
    body: Buffer.from(payload)
  };

  const isValid = verifyStandardWebhook(payload, webhookReq.headers, secretKey);
  assert.strictEqual(isValid, true, 'Valid signature must return true');

  const isBadValid = verifyStandardWebhook(payload, {
    ...webhookReq.headers,
    'webhook-signature': 'v1,invalidBase64Sig'
  }, secretKey);
  assert.strictEqual(isBadValid, false, 'Invalid signature must return false');
  console.log('✓ Test 6 Passed: Dodo standard webhook HMAC verification passes.');

  console.log('\n=======================================');
  console.log('ALL SECURITY SUITE TESTS PASSED 100%!');
  console.log('=======================================');
  process.exit(0);
}

runTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
