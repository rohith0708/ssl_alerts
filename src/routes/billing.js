const crypto = require('crypto');
const express = require('express');
const { db, PLANS } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

router.get('/plans', (req, res) => res.json({ plans: PLANS }));

// ============================================================
// Stripe (optional — leave STRIPE_SECRET_KEY unset to skip entirely)
// ============================================================
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

const STRIPE_PRICE_IDS = {
  micro: () => process.env.STRIPE_PRICE_MICRO,
  starter: () => process.env.STRIPE_PRICE_STARTER,
  growth: () => process.env.STRIPE_PRICE_GROWTH,
  pro: () => process.env.STRIPE_PRICE_PRO,
  agency: () => process.env.STRIPE_PRICE_AGENCY,
  unlimited: () => process.env.STRIPE_PRICE_UNLIMITED
};

router.post('/checkout', requireAuth, async (req, res) => {
  const { plan } = req.body || {};
  if (!PLANS[plan] || plan === 'trial') {
    return res.status(400).json({ error: 'Unknown plan.' });
  }
  if (plan === 'enterprise' || plan === 'unlimited') {
    return res.status(400).json({ error: 'For Enterprise plans with more than 500 domains, please contact support@sslalerts.info.' });
  }

  const stripe = getStripe();
  if (!stripe) {
    return res.status(501).json({
      error: 'Stripe is not configured. Use the Razorpay checkout instead, or add Stripe keys in .env.'
    });
  }

  const priceId = STRIPE_PRICE_IDS[plan]();
  if (!priceId) {
    return res.status(501).json({ error: `No Stripe price configured for the "${plan}" plan.` });
  }

  const user = await db.getOne('SELECT * FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(401).json({ error: 'Session no longer valid, please sign in again.' });
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, name: user.name });
    customerId = customer.id;
    await db.execute('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, user.id]);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/dashboard?upgraded=1`,
    cancel_url: `${process.env.APP_URL}/dashboard?upgrade_cancelled=1`,
    metadata: { userId: String(user.id), plan }
  });

  res.json({ url: session.url });
});

// Stripe webhook
async function handleWebhook(req, res) {
  const stripe = getStripe();
  if (!stripe) return res.status(501).send('Stripe not configured.');

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const plan = session.metadata?.plan;
    const userId = session.metadata?.userId;
    if (plan && userId && PLANS[plan]) {
      await db.execute("UPDATE users SET plan = ?, domain_limit = ?, billing_status = 'active' WHERE id = ?", [plan, PLANS[plan].domainLimit, userId]);
      console.log(`[billing:stripe] user ${userId} upgraded to ${plan}`);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const user = await db.getOne('SELECT * FROM users WHERE stripe_customer_id = ?', [sub.customer]);
    if (user) {
      await db.execute("UPDATE users SET plan = 'trial', domain_limit = ?, billing_status = 'active' WHERE id = ?", [PLANS.trial.domainLimit, user.id]);
      console.log(`[billing:stripe] user ${user.id} downgraded to trial (subscription ended)`);
    }
  }

  res.json({ received: true });
}

// ============================================================
// Razorpay
// ============================================================
function getRazorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  const Razorpay = require('razorpay');
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

const RAZORPAY_PLAN_IDS = {
  micro: () => process.env.RAZORPAY_PLAN_MICRO,
  starter: () => process.env.RAZORPAY_PLAN_STARTER,
  growth: () => process.env.RAZORPAY_PLAN_GROWTH,
  pro: () => process.env.RAZORPAY_PLAN_PRO,
  agency: () => process.env.RAZORPAY_PLAN_AGENCY,
  unlimited: () => process.env.RAZORPAY_PLAN_UNLIMITED
};

router.get('/razorpay/key', requireAuth, (req, res) => {
  if (!process.env.RAZORPAY_KEY_ID) return res.status(501).json({ error: 'Razorpay is not configured.' });
  res.json({ key: process.env.RAZORPAY_KEY_ID });
});

router.post('/razorpay/subscribe', requireAuth, async (req, res) => {
  const { plan } = req.body || {};
  if (!PLANS[plan] || plan === 'trial') {
    return res.status(400).json({ error: 'Unknown plan.' });
  }
  if (plan === 'enterprise' || plan === 'unlimited') {
    return res.status(400).json({ error: 'For Enterprise plans with more than 500 domains, please contact support@sslalerts.info.' });
  }

  const razorpay = getRazorpay();
  if (!razorpay) {
    return res.status(501).json({
      error: 'Razorpay is not configured yet. Add RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env.'
    });
  }

  const planId = RAZORPAY_PLAN_IDS[plan]();
  if (!planId) {
    return res.status(501).json({ error: `No Razorpay plan configured for "${plan}". Create it in the Razorpay dashboard and set RAZORPAY_PLAN_${plan.toUpperCase()}.` });
  }

  const user = await db.getOne('SELECT * FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(401).json({ error: 'Session no longer valid, please sign in again.' });

  try {
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count: 120,
      notes: { userId: String(user.id), plan, email: user.email }
    });

    res.json({ subscription_id: subscription.id, key: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    const detail = err?.error?.description || err.message || 'Unknown error';
    console.error('[billing:razorpay] subscription creation failed:', detail);
    res.status(502).json({ error: `Razorpay rejected this: ${detail}` });
  }
});

router.post('/razorpay/verify', requireAuth, async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, plan } = req.body || {};
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment verification fields.' });
  }
  if (!PLANS[plan]) return res.status(400).json({ error: 'Unknown plan.' });

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment verification failed (signature mismatch).' });
  }

  let periodEnd = null;
  try {
    const razorpay = getRazorpay();
    const sub = await razorpay.subscriptions.fetch(razorpay_subscription_id);
    if (sub.current_end) {
      periodEnd = new Date(sub.current_end * 1000).toISOString().slice(0, 19).replace('T', ' ');
    }
  } catch (err) {
    console.warn('[billing:razorpay] could not fetch subscription period end:', err.message);
  }

  await db.execute("UPDATE users SET plan = ?, domain_limit = ?, billing_status = 'active' WHERE id = ?", [plan, PLANS[plan].domainLimit, req.userId]);
  await db.execute("UPDATE users SET razorpay_subscription_id = ?, razorpay_customer_id = ?, current_period_end = ? WHERE id = ?", [razorpay_subscription_id, null, periodEnd, req.userId]);
  console.log(`[billing:razorpay] user ${req.userId} upgraded to ${plan}`);

  res.json({ ok: true });
});

async function handleRazorpayWebhook(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(501).send('Razorpay webhook secret not configured.');

  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (signature !== expected) return res.status(400).send('Invalid webhook signature.');

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Invalid JSON.');
  }

  const subEntity = event.payload?.subscription?.entity;
  const subscriptionId = subEntity?.id;
  const user = subscriptionId ? await db.getOne('SELECT * FROM users WHERE razorpay_subscription_id = ?', [subscriptionId]) : null;

  switch (event.event) {
    case 'subscription.charged': {
      if (user) {
        const periodEnd = subEntity.current_end ? new Date(subEntity.current_end * 1000).toISOString().slice(0, 19).replace('T', ' ') : null;
        await db.execute('UPDATE users SET current_period_end = ? WHERE id = ?', [periodEnd, user.id]);
        await db.execute("UPDATE users SET billing_status = 'active' WHERE id = ?", [user.id]);
        console.log(`[billing:razorpay] user ${user.id} renewed — monitoring stays active`);
      }
      break;
    }
    case 'subscription.halted':
    case 'subscription.cancelled': {
      if (user) {
        await db.execute("UPDATE users SET billing_status = 'halted' WHERE id = ?", [user.id]);
        console.log(`[billing:razorpay] user ${user.id} subscription ${event.event} — monitoring paused`);
      }
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
}

// ============================================================
// Dodo Payments (Merchant of Record)
// ============================================================
function isDodoConfigured() {
  return !!process.env.DODO_PAYMENTS_API_KEY;
}

const DODO_PRODUCT_IDS = {
  micro: () => process.env.DODO_PRODUCT_MICRO,
  starter: () => process.env.DODO_PRODUCT_STARTER,
  growth: () => process.env.DODO_PRODUCT_GROWTH,
  pro: () => process.env.DODO_PRODUCT_PRO,
  agency: () => process.env.DODO_PRODUCT_AGENCY
};

router.get('/dodo/status', (req, res) => {
  res.json({ configured: isDodoConfigured() });
});

router.post('/dodo/checkout', requireAuth, async (req, res) => {
  const { plan } = req.body || {};
  if (!PLANS[plan] || plan === 'trial') {
    return res.status(400).json({ error: 'Unknown plan.' });
  }
  if (plan === 'enterprise' || plan === 'unlimited') {
    return res.status(400).json({ error: 'For Enterprise plans with more than 500 domains, please contact support@sslalerts.info.' });
  }

  if (!isDodoConfigured()) {
    return res.status(501).json({ error: 'Dodo Payments is not configured. Add DODO_PAYMENTS_API_KEY in .env.' });
  }

  const productId = DODO_PRODUCT_IDS[plan]?.();
  if (!productId) {
    return res.status(501).json({ error: `No Dodo product ID configured for the "${plan}" plan.` });
  }

  const user = await db.getOne('SELECT * FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(401).json({ error: 'Session no longer valid, please sign in again.' });

  const env = (process.env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode').toLowerCase();
  const dodoBase = (env === 'live_mode' || env === 'live' || env === 'production')
    ? 'https://live.dodopayments.com'
    : 'https://test.dodopayments.com';

  const appUrl = (process.env.APP_URL || 'https://sslalerts.info').replace(/\/+$/, '');
  const returnTarget = (req.body && req.body.return_path && req.body.return_path.startsWith('/')) ? req.body.return_path : '/dashboard';
  const returnUrl = `${appUrl}${returnTarget}?payment=success&plan=${plan}`;

  try {
    const resp = await fetch(`${dodoBase}/checkouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DODO_PAYMENTS_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: {
          email: user.email,
          name: user.name || user.email.split('@')[0]
        },
        metadata: {
          userId: String(user.id),
          plan
        },
        return_url: returnUrl
      })
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[billing:dodo] checkout error:', resp.status, data);
      return res.status(502).json({ error: data.message || `Dodo checkout failed with status ${resp.status}` });
    }

    const checkoutUrl = data.checkout_url || data.payment_link || data.url;
    if (!checkoutUrl) {
      return res.status(502).json({ error: 'Did not receive checkout URL from Dodo Payments.' });
    }

    res.json({ url: checkoutUrl, session_id: data.session_id });
  } catch (err) {
    console.error('[billing:dodo] checkout request failed:', err.message);
    res.status(502).json({ error: `Failed to initiate Dodo checkout: ${err.message}` });
  }
});

router.post('/dodo/sync-subscription', requireAuth, async (req, res) => {
  const { subscription_id, plan } = req.body || {};
  if (!subscription_id) {
    return res.status(400).json({ error: 'subscription_id required.' });
  }
  if (!isDodoConfigured()) {
    return res.status(501).json({ error: 'Dodo Payments not configured.' });
  }

  const env = (process.env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode').toLowerCase();
  const dodoBase = (env === 'live_mode' || env === 'live' || env === 'production')
    ? 'https://live.dodopayments.com'
    : 'https://test.dodopayments.com';

  try {
    const resp = await fetch(`${dodoBase}/subscriptions/${encodeURIComponent(subscription_id)}`, {
      headers: {
        'Authorization': `Bearer ${process.env.DODO_PAYMENTS_API_KEY}`
      }
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[billing:dodo] sync subscription error:', resp.status, data);
      return res.status(resp.status).json({ error: data.message || 'Subscription not found' });
    }

    if (data.status === 'active' || data.status === 'pending') {
      const user = await db.getOne('SELECT * FROM users WHERE id = ?', [req.userId]);
      if (!user) return res.status(401).json({ error: 'User not found' });

      let targetPlan = (data.metadata && data.metadata.plan) || plan;
      if (!targetPlan && data.product_id) {
        for (const [pName, getter] of Object.entries(DODO_PRODUCT_IDS)) {
          if (getter() === data.product_id) {
            targetPlan = pName;
            break;
          }
        }
      }
      if (!targetPlan || !PLANS[targetPlan]) {
        targetPlan = user.plan !== 'trial' ? user.plan : 'starter';
      }

      const planLimit = PLANS[targetPlan] ? PLANS[targetPlan].domainLimit : user.domain_limit;
      let periodEnd = null;
      if (data.next_billing_date) {
        periodEnd = new Date(data.next_billing_date).toISOString().slice(0, 19).replace('T', ' ');
      } else if (data.expires_at) {
        periodEnd = new Date(data.expires_at).toISOString().slice(0, 19).replace('T', ' ');
      }

      const custId = data.customer?.customer_id || data.customer_id;
      await db.execute(`
        UPDATE users SET
          plan = ?,
          domain_limit = ?,
          billing_status = 'active',
          dodo_subscription_id = COALESCE(?, dodo_subscription_id),
          dodo_customer_id = COALESCE(?, dodo_customer_id),
          current_period_end = COALESCE(?, current_period_end)
        WHERE id = ?
      `, [targetPlan, planLimit, subscription_id, custId || null, periodEnd, user.id]);

      console.log(`[billing:dodo] synced subscription ${subscription_id} for user #${user.id} -> ${targetPlan}`);
      return res.json({ success: true, plan: targetPlan });
    }

    res.json({ success: false, status: data.status });
  } catch (err) {
    console.error('[billing:dodo] sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function verifyStandardWebhook(rawBody, headers, secretWithPrefix) {
  const msgId = headers['webhook-id'];
  const msgTimestamp = headers['webhook-timestamp'];
  const msgSignature = headers['webhook-signature'];

  if (!msgId || !msgTimestamp || !msgSignature || !secretWithPrefix) {
    return false;
  }

  // 5-minute tolerance check
  const toleranceInSeconds = 300;
  const currentTime = Math.floor(Date.now() / 1000);
  const timestampNumber = Number(msgTimestamp);
  if (isNaN(timestampNumber) || Math.abs(currentTime - timestampNumber) > toleranceInSeconds) {
    console.warn('[billing:dodo:webhook] Timestamp outside tolerance window');
    return false;
  }

  const secretBytes = Buffer.from(secretWithPrefix.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${msgId}.${msgTimestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  const signatures = msgSignature.split(' ');
  for (const versionedSignature of signatures) {
    const [version, signature] = versionedSignature.split(',');
    if (version === 'v1' && signature) {
      const signatureBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSignature);
      if (
        signatureBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
      ) {
        return true;
      }
    }
  }
  return false;
}

async function handleDodoWebhook(req, res) {
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY;
  if (!secret) return res.status(501).send('Dodo webhook secret not configured.');

  const rawBody = req.body ? req.body.toString('utf8') : '';
  const isValid = verifyStandardWebhook(rawBody, req.headers, secret);
  if (!isValid) {
    console.error('[billing:dodo:webhook] Invalid signature');
    return res.status(400).send('Invalid signature.');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).send('Invalid JSON.');
  }

  const data = event.data || {};
  const metadata = data.metadata || {};
  const userId = metadata.userId || metadata.user_id;
  let plan = metadata.plan;
  if (!plan && data.product_id) {
    for (const [pName, getter] of Object.entries(DODO_PRODUCT_IDS)) {
      if (getter() === data.product_id) {
        plan = pName;
        break;
      }
    }
  }
  const subId = data.subscription_id || data.subscriptionId;
  const custId = data.customer?.customer_id || data.customer_id || data.customerId;
  const payId = data.payment_id || data.paymentId;

  console.log(`[billing:dodo:webhook] Received event: ${event.type}`);

  try {
    switch (event.type) {
      case 'subscription.active':
      case 'payment.succeeded': {
        let targetUser = null;
        if (userId) {
          targetUser = await db.getOne('SELECT * FROM users WHERE id = ?', [userId]);
        } else if (subId) {
          targetUser = await db.getOne('SELECT * FROM users WHERE dodo_subscription_id = ?', [subId]);
        } else if (data.customer?.email) {
          targetUser = await db.getOne('SELECT * FROM users WHERE email = ?', [data.customer.email]);
        }

        if (targetUser) {
          const targetPlan = (plan && PLANS[plan]) ? plan : (targetUser.plan !== 'trial' ? targetUser.plan : 'starter');
          const planLimit = PLANS[targetPlan] ? PLANS[targetPlan].domainLimit : targetUser.domain_limit;

          let periodEnd = null;
          if (data.next_billing_date) {
            periodEnd = new Date(data.next_billing_date).toISOString().slice(0, 19).replace('T', ' ');
          } else if (data.expires_at) {
            periodEnd = new Date(data.expires_at).toISOString().slice(0, 19).replace('T', ' ');
          }

          await db.execute(`
            UPDATE users SET
              plan = ?,
              domain_limit = ?,
              billing_status = 'active',
              dodo_subscription_id = COALESCE(?, dodo_subscription_id),
              dodo_customer_id = COALESCE(?, dodo_customer_id),
              dodo_payment_id = COALESCE(?, dodo_payment_id),
              current_period_end = COALESCE(?, current_period_end)
            WHERE id = ?
          `, [targetPlan, planLimit, subId || null, custId || null, payId || null, periodEnd, targetUser.id]);
          console.log(`[billing:dodo] user #${targetUser.id} (${targetUser.email}) upgraded to ${targetPlan} (domains: ${planLimit})`);
        }
        break;
      }

      case 'subscription.renewed': {
        if (subId) {
          let periodEnd = null;
          if (data.next_billing_date) {
            periodEnd = new Date(data.next_billing_date).toISOString().slice(0, 19).replace('T', ' ');
          }
          await db.execute("UPDATE users SET billing_status = 'active', current_period_end = COALESCE(?, current_period_end) WHERE dodo_subscription_id = ?", [periodEnd, subId]);
          console.log(`[billing:dodo] subscription ${subId} renewed — monitoring active`);
        }
        break;
      }

      case 'subscription.cancelled':
      case 'subscription.on_hold':
      case 'subscription.failed': {
        if (subId) {
          await db.execute("UPDATE users SET billing_status = 'halted' WHERE dodo_subscription_id = ?", [subId]);
          console.log(`[billing:dodo] subscription ${subId} ${event.type} — monitoring halted`);
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error('[billing:dodo] DB error processing event:', err);
  }

  res.json({ received: true });
}

module.exports = { router, handleWebhook, handleRazorpayWebhook, handleDodoWebhook };

