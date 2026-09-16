/* ============================================================================
 * AuraDetector — server/billing.js
 * Real Stripe subscriptions (monthly + annual) with SERVER-SIDE webhook
 * verification. Entitlement is always derived from the database that the
 * webhook writes to — never from anything the browser sends.
 * ==========================================================================*/
import express from "express";
import Stripe from "stripe";
import {
  db, upsertSubscription, subscriptionForUser, customerIdForUser, setCustomerId, track,
} from "./db.js";
import { requireUser } from "./auth.js";
import { publicOrigin } from "./config.js";

const IS_STRIPE = () => Boolean(process.env.STRIPE_SECRET_KEY);
const stripe = () => {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20000 });
};
export const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY && (process.env.STRIPE_PRICE_MONTHLY || process.env.STRIPE_PRICE_YEARLY));
const webhookConfigured = () => Boolean(process.env.STRIPE_WEBHOOK_SECRET);

function planForPrice(priceId) {
  if (priceId && priceId === process.env.STRIPE_PRICE_MONTHLY) return "monthly";
  if (priceId && priceId === process.env.STRIPE_PRICE_YEARLY) return "yearly";
  return null;
}
function priceForPlan(plan) {
  return plan === "yearly" ? process.env.STRIPE_PRICE_YEARLY : plan === "monthly" ? process.env.STRIPE_PRICE_MONTHLY : null;
}

/* ------------------------------ Entitlement ------------------------------- */
const ACTIVE = new Set(["active", "trialing"]);
export function premiumInfo(userId) {
  if (!userId) return { premium: false, plan: null, status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false };
  const s = subscriptionForUser(userId);
  if (!s) return { premium: false, plan: null, status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false };
  const notExpired = !s.current_period_end || s.current_period_end > Date.now();
  const premium = ACTIVE.has(s.status) && notExpired;
  return {
    premium, plan: s.plan || null, status: s.status,
    currentPeriodEnd: s.current_period_end || null,
    cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
    manageable: Boolean(s.customer_id),
  };
}
export function requirePremium(req, res, next) {
  const info = premiumInfo(req.user && req.user.id);
  if (!info.premium) return res.status(402).json({ error: "PREMIUM_REQUIRED" });
  req.premium = info;
  next();
}

/* --------------------------------- Router --------------------------------- */
export const billingRouter = express.Router();

billingRouter.get("/status", (req, res) => {
  res.json({ ok: true, stripe: stripeConfigured(), webhook: webhookConfigured(), ...premiumInfo(req.user && req.user.id) });
});

billingRouter.post("/checkout", requireUser, async (req, res) => {
  if (!stripeConfigured()) return res.status(503).json({ error: "STRIPE_NOT_CONFIGURED" });
  const plan = req.body?.plan === "yearly" ? "yearly" : "monthly";
  const price = priceForPlan(plan);
  if (!price) return res.status(503).json({ error: "STRIPE_PRICE_MISSING" });
  try {
    const s = stripe();
    let customer = customerIdForUser(req.user.id);
    if (!customer) {
      const c = await s.customers.create({ email: req.user.email || undefined, metadata: { userId: req.user.id } });
      customer = c.id;
      setCustomerId(req.user.id, customer);
    }
    const origin = publicOrigin();
    const session = await s.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price, quantity: 1 }],
      client_reference_id: req.user.id,
      allow_promotion_codes: true,
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel`,
      subscription_data: { metadata: { userId: req.user.id, plan } },
      metadata: { userId: req.user.id, plan },
    });
    track({ userId: req.user.id, event: "checkout_created", props: { plan } });
    res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", route: "/api/billing/checkout", msg: String(e.message).slice(0, 140) }));
    res.status(502).json({ error: "CHECKOUT_FAILED" });
  }
});

billingRouter.post("/portal", requireUser, async (req, res) => {
  if (!IS_STRIPE()) return res.status(503).json({ error: "STRIPE_NOT_CONFIGURED" });
  const customer = customerIdForUser(req.user.id);
  if (!customer) return res.status(400).json({ error: "NO_CUSTOMER" });
  try {
    const origin = publicOrigin();
    const session = await stripe().billingPortal.sessions.create({ customer, return_url: `${origin}/?portal=return` });
    res.json({ ok: true, url: session.url });
  } catch { res.status(502).json({ error: "PORTAL_FAILED" }); }
});

/* --------------------------- Webhook (raw body) --------------------------- */
function userForCustomer(customerId) {
  const r = db.prepare("SELECT user_id FROM subscriptions WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1").get(customerId);
  return r ? r.user_id : null;
}
function userIdFrom(obj) {
  return obj?.metadata?.userId || obj?.client_reference_id || (obj?.customer ? userForCustomer(obj.customer) : null);
}
function periodEnd(sub) {
  // Stripe moved current_period_end onto the items in newer API versions.
  if (sub.current_period_end) return sub.current_period_end * 1000;
  const item = sub.items?.data?.[0];
  return item?.current_period_end ? item.current_period_end * 1000 : null;
}
function syncFromSubscription(sub) {
  const userId = userIdFrom(sub);
  if (!userId) return;
  const priceId = sub.items?.data?.[0]?.price?.id || null;
  upsertSubscription({
    user_id: userId,
    customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    subscription_id: sub.id,
    price_id: priceId,
    plan: sub.metadata?.plan || planForPrice(priceId),
    status: sub.status,
    current_period_end: periodEnd(sub),
    cancel_at_period_end: sub.cancel_at_period_end,
  });
  track({ userId, event: "subscription_synced", props: { status: sub.status } });
}

export function handleStripeWebhook(req, res) {
  if (!webhookConfigured()) return res.status(503).json({ error: "WEBHOOK_NOT_CONFIGURED" });
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    // Signature invalid / tampered payload — never process it.
    console.error(JSON.stringify({ level: "warn", route: "/api/stripe/webhook", msg: "signature_verification_failed" }));
    return res.status(400).json({ error: "INVALID_SIGNATURE" });
  }
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const userId = userIdFrom(s);
        if (userId && s.customer) setCustomerId(userId, typeof s.customer === "string" ? s.customer : s.customer.id);
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        syncFromSubscription(event.data.object);
        break;
      case "invoice.paid":
      case "invoice.payment_failed": {
        const inv = event.data.object;
        const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id;
        if (subId) {
          stripe().subscriptions.retrieve(subId).then(syncFromSubscription).catch(() => {});
        }
        break;
      }
      default: break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", route: "/api/stripe/webhook", msg: String(e.message).slice(0, 140) }));
    res.status(500).json({ error: "WEBHOOK_HANDLER_ERROR" });
  }
}
