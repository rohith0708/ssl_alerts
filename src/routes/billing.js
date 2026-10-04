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

module.exports = { router, handleWebhook, handleRazorpayWebhook };
