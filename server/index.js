/* ============================================================================
 * AuraDetector — server/index.js
 * Secure API + static host for the AuraDetector PWA.
 *
 *   npm install && npm start
 *
 * Required env for real AI (server-side only):
 *   AI_PROVIDER=openai OPENAI_API_KEY=sk-...        (or)
 *   AI_PROVIDER=gemini GEMINI_API_KEY=AIza...
 * Required env for the admin area:
 *   ADMIN_PASSCODE=<strong passphrase>
 *   ADMIN_SESSION_SECRET=<long random string>
 * ==========================================================================*/
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyze, aiStatus, AiError, geminiModelInfo } from "./ai.js";
import { authRouter, attachUser, requireUser } from "./auth.js";
import { billingRouter, handleStripeWebhook, premiumInfo, stripeConfigured } from "./billing.js";
import { publicUser, scansForUser, saveScan, usageToday, incrementUsage, countRows, track } from "./db.js";
import { publicOrigin, behindProxy } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "..");

/* Minimal .env loader (no dependency). Real environment variables win. */
function loadDotEnv() {
  try {
    const p = path.join(APP_DIR, ".env");
    if (!existsSync(p)) return;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {}
}
loadDotEnv();
const PORT = Number(process.env.PORT || 8787);
const IS_PROD = process.env.NODE_ENV === "production";
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : IS_PROD;
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "";
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "";
const ADMIN_ENABLED = ADMIN_PASSCODE.length >= 8 && ADMIN_SESSION_SECRET.length >= 16;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

/* ------------------------------- Config store ----------------------------- */
const config = {
  productName: "AuraDetector",
  freeScansPerDay: Number(process.env.FREE_SCANS_PER_DAY || 1),
  imageRetentionMinutes: 0, // images are never persisted
  priceMonthly: Number(process.env.PRICE_MONTHLY || 6.99),
  priceYearly: Number(process.env.PRICE_YEARLY || 39.99),
  currency: "€",
  paywallHeadline: "YOUR AURA IS {score}…",
  paywallQuestion: "Want to know how to reach 900+?",
  premiumFeatures: { fullAnalysis: true, increasePlan: true, outfit: true, optimizer: true, battle: true, history: true },
};

/* ------------------------------- Metrics ---------------------------------- */
const metrics = {
  startedAt: Date.now(),
  totalScans: 0, aiScans: 0, textScans: 0, imageScans: 0,
  errors: 0, errorCodes: {}, latencyMsSum: 0, latencyCount: 0,
  archetypes: {}, scansByDay: {}, blocked: 0,
};
function bumpError(code) { metrics.errors++; metrics.errorCodes[code] = (metrics.errorCodes[code] || 0) + 1; }

/* --------------------------- Anonymous identity --------------------------- */
/* Server-issued, signed, HttpOnly anonymous id — the client cannot forge it. */
function ensureAnonId(req, res, next) {
  const signed = req.signedCookies?.ad_uid;
  const valid = typeof signed === "string" && /^[a-f0-9-]{36}$/.test(signed);
  if (valid) {
    req.anonId = signed;
    req.usageKey = signed;
  } else {
    // Untrusted/absent cookie: never trust it. Key the free quota by IP and
    // issue a fresh signed anonymous id for the next request.
    req.anonId = crypto.randomUUID();
    req.usageKey = "ip:" + (req.ip || "unknown");
    res.cookie("ad_uid", req.anonId, { httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax", signed: true, maxAge: 1000 * 60 * 60 * 24 * 365 });
  }
  next();
}

/* ------------------------------ Usage limits ------------------------------ */
/* In-memory store for the reference build. Production: PostgreSQL. */
const usage = new Map(); // key -> { day, used, bonus }
const dayKey = () => new Date().toISOString().slice(0, 10);
function getUsage(id) {
  const d = dayKey();
  let u = usage.get(id);
  if (!u || u.day !== d) { u = { day: d, used: 0, bonus: 0 }; usage.set(id, u); }
  return u;
}
function remaining(id) { const u = getUsage(id); return Math.max(0, config.freeScansPerDay + u.bonus - u.used); }
setInterval(() => { const d = dayKey(); for (const [k, u] of usage) if (u.day !== d) usage.delete(k); }, 1000 * 60 * 30).unref?.();

/* ----------------------- Gemini free-tier quota guard --------------------- */
/* Hard stop BEFORE the provider call. Protects the free tier and guarantees the
 * app never silently turns a free request into a billable one. When the quota
 * (or Google's own 429) is hit we cool down and return FREE_QUOTA_EXCEEDED —
 * there is deliberately NO paid fallback anywhere in the code path. */
const pacificDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
const minuteKey = () => new Date().toISOString().slice(0, 16);
const quota = {
  dailyLimit: Number(process.env.GEMINI_FREE_DAILY_LIMIT || 900),
  perMinute: Number(process.env.GEMINI_FREE_PER_MINUTE || 8),
  day: "", usedDay: 0, minute: "", usedMinute: 0, cooldownUntil: 0, blocked: 0,
};
function quotaStatus() {
  const d = pacificDay(), m = minuteKey();
  if (quota.day !== d) { quota.day = d; quota.usedDay = 0; }
  if (quota.minute !== m) { quota.minute = m; quota.usedMinute = 0; }
  const cooling = quota.cooldownUntil > Date.now();
  return {
    dailyLimit: quota.dailyLimit, usedToday: quota.usedDay, remainingToday: Math.max(0, quota.dailyLimit - quota.usedDay),
    perMinute: quota.perMinute, usedThisMinute: quota.usedMinute, remainingThisMinute: Math.max(0, quota.perMinute - quota.usedMinute),
    cooldownSeconds: cooling ? Math.ceil((quota.cooldownUntil - Date.now()) / 1000) : 0,
    exhausted: cooling || quota.usedDay >= quota.dailyLimit || quota.usedMinute >= quota.perMinute,
  };
}
function reserveQuota() {
  if (quotaStatus().exhausted) { quota.blocked++; throw new AiError("FREE_QUOTA_EXCEEDED", 429); }
  quota.usedDay++; quota.usedMinute++;
}
function releaseQuota() { quota.usedDay = Math.max(0, quota.usedDay - 1); quota.usedMinute = Math.max(0, quota.usedMinute - 1); }
function noteProviderQuota() { quota.cooldownUntil = Date.now() + 60_000; }

/* Billing snapshot used by the admin dashboard (server-side truth). */
function billingSnapshot() {
  const am = countRows("SELECT COUNT(*) AS c FROM subscriptions WHERE status IN ('active','trialing') AND (plan IS NULL OR plan='monthly')");
  const ay = countRows("SELECT COUNT(*) AS c FROM subscriptions WHERE status IN ('active','trialing') AND plan='yearly'");
  const mrr = am * Number(config.priceMonthly) + ay * (Number(config.priceYearly) / 12);
  return {
    users: countRows("SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL"),
    activeSubscriptions: am + ay, monthly: am, yearly: ay,
    mrr: Math.round(mrr * 100) / 100, arr: Math.round(mrr * 12 * 100) / 100,
  };
}

/* ------------------------------- Admin auth ------------------------------- */
/* Stateless HMAC-signed session token + server-side revocation list. Secret
 * lives only in the server env; never shipped to the browser. */
const revoked = new Map(); // signature -> exp
function b64url(buf) { return Buffer.from(buf).toString("base64url"); }
function signAdmin(expMs) {
  const payload = b64url(JSON.stringify({ role: "admin", exp: expMs, jti: crypto.randomUUID() }));
  const sig = crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(payload).digest("hex");
  return payload + "." + sig;
}
function verifyAdmin(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(payload).digest("hex");
  const a = Buffer.from(sig || "", "utf8"), b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (revoked.has(sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.role !== "admin" || !data.exp || data.exp < Date.now()) return null;
    return { signature: sig, exp: data.exp };
  } catch { return null; }
}
function requireAdmin(req, res, next) {
  if (!ADMIN_ENABLED) return res.status(503).json({ error: "ADMIN_DISABLED" });
  const session = verifyAdmin(req.cookies?.ad_admin);
  if (!session) return res.status(401).json({ error: "UNAUTHORIZED" });
  req.adminSession = session;
  next();
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* --------------------------------- Upload --------------------------------- */
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 4 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.includes((file.mimetype || "").toLowerCase())) return cb(new AiError("UNSUPPORTED_FORMAT", 415));
    cb(null, true);
  },
});
/* Real content sniffing — never trust the filename or the claimed MIME alone. */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null; // SVG, PDF, executables, spoofed types all land here
}

/* ------------------------------- Moderation ------------------------------- */
const BLOCKED = ["nude", "naked", "nsfw", "explicit", "gore", "corpse", "underage", "cp "];
const INJECTION = ["ignore previous", "ignore all previous", "system prompt", "reveal your", "disregard", "jailbreak", "developer mode", "forget your instructions"];
function moderateText(text) {
  const t = String(text || "").toLowerCase();
  if (BLOCKED.some((w) => t.includes(w))) return false;
  if (INJECTION.some((w) => t.includes(w))) return false;
  return true;
}

/* ---------------------------------- App ----------------------------------- */
const app = express();
app.disable("x-powered-by");
// One TLS-terminating proxy on PaaS hosts; avoids trusting spoofed XFF locally.
app.set("trust proxy", behindProxy ? 1 : false);

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "img-src": ["'self'", "data:", "blob:"],
      "connect-src": ["'self'"],
      "media-src": ["'self'", "blob:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'self'"],
      "upgrade-insecure-requests": IS_PROD ? [] : null,
    },
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));
/* Stripe webhooks must receive the RAW body for signature verification. */
app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "256kb" }), handleStripeWebhook);

app.use(express.json({ limit: "64kb" }));
app.use(cookieParser(process.env.SESSION_SECRET || ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString("hex")));
app.use(attachUser);

app.use((req, res, next) => {
  if (ALLOWED_ORIGINS.length) {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
      if (req.method === "OPTIONS") return res.sendStatus(204);
    }
  }
  next();
});

app.use((req, res, next) => { req.id = crypto.randomUUID(); res.setHeader("X-Request-Id", req.id); next(); });

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const analyzeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: Number(process.env.ANALYZE_PER_HOUR || 20), standardHeaders: true, legacyHeaders: false, message: { error: "RATE_LIMITED" } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: "RATE_LIMITED" } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.AUTH_PER_15MIN || 40), standardHeaders: true, legacyHeaders: false, message: { error: "RATE_LIMITED" } });
app.use("/api/", apiLimiter);

/* Auth + billing */
app.use("/api/auth", authLimiter, authRouter);
app.use("/api/billing", billingRouter);
app.get("/api/me", (req, res) => {
  const p = premiumInfo(req.user && req.user.id);
  res.json({
    ok: true,
    user: publicUser(req.user),
    premium: p.premium,
    plan: p.plan,
    subscription: p,
    scans: req.user ? scansForUser(req.user.id, 30) : [],
  });
});

/* Premium-only endpoint — entitlement is enforced server-side (402 for free). */
app.get("/api/premium/history", requireUser, (req, res) => {
  const p = premiumInfo(req.user.id);
  if (!p.premium) return res.status(402).json({ error: "PREMIUM_REQUIRED" });
  res.json({ ok: true, premium: true, plan: p.plan, scans: scansForUser(req.user.id, 100) });
});

/* --------------------------------- Health --------------------------------- */
app.get("/api/health", (req, res) => {
  const st = aiStatus();
  res.json({ ok: true, service: "auradetector", ai: { provider: st.provider, configured: st.configured, model: st.model, freeTier: st.freeTier }, adminEnabled: ADMIN_ENABLED });
});

/* Public, non-sensitive config used to render prices and paywall copy. */
app.get("/api/config", (req, res) => {
  res.json({ ok: true, config: {
    productName: config.productName, currency: config.currency,
    priceMonthly: config.priceMonthly, priceYearly: config.priceYearly,
    freeScansPerDay: config.freeScansPerDay,
    paywallHeadline: config.paywallHeadline, paywallQuestion: config.paywallQuestion,
    premiumFeatures: config.premiumFeatures,
  } });
});

/* --------------------------------- Analyze -------------------------------- */
app.post("/api/analyze", analyzeLimiter, ensureAnonId, upload.single("image"), async (req, res, next) => {
  const started = Date.now();
  try {
    const isImage = Boolean(req.file);
    const user = req.user || null;
    const id = req.usageKey;
    const isPremiumUser = user ? premiumInfo(user.id).premium : false;
    if (!isPremiumUser) {
      if (user) {
        const u = usageToday("user:" + user.id, dayKey());
        if (u.used >= config.freeScansPerDay + (u.bonus || 0)) { metrics.blocked++; throw new AiError("RATE_LIMITED", 429, "free_limit"); }
      } else if (remaining(id) <= 0) { metrics.blocked++; throw new AiError("RATE_LIMITED", 429, "free_limit"); }
    }

    let payload;
    if (isImage) {
      const detected = sniffImage(req.file.buffer);
      if (!detected) throw new AiError("UNSUPPORTED_FORMAT", 415, "magic_bytes");
      if (!ALLOWED_MIME.includes(detected)) throw new AiError("UNSUPPORTED_FORMAT", 415, "detected");
      payload = { isImage: true, imageBase64: req.file.buffer.toString("base64"), imageMime: detected };
    } else {
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (text.length < 3 || text.length > 600) throw new AiError("INVALID_IMAGE", 400, "text_length");
      if (!moderateText(text)) { metrics.blocked++; throw new AiError("CONTENT_REJECTED", 422); }
      payload = { isImage: false, text };
    }

    // Free-tier guard: only Gemini consumes the free quota.
    const freeTier = aiStatus().provider === "gemini";
    if (freeTier) reserveQuota();
    let payloadResult;
    try {
      payloadResult = await analyze(payload);
    } catch (e) {
      if (e && e.code === "FREE_QUOTA_EXCEEDED") noteProviderQuota();
      else if (freeTier) releaseQuota(); // provider/config error: give the quota back
      throw e;
    }
    const { result, engine, model } = payloadResult;
    if (isImage) req.file.buffer.fill(0); // data minimisation: drop the bytes immediately

    if (!isPremiumUser) {
      if (user) incrementUsage("user:" + user.id, dayKey());
      else { const u = getUsage(id); u.used++; } // in-memory Map holds the reference
    }
    saveScan({ userId: user ? user.id : null, anonId: user ? null : req.anonId, mode: isImage ? "image" : "text", score: result.score, tier: result.tier, archetype: result.archetype, categories: result.categories, engine });
    if (user) track({ userId: user.id, event: "scan", props: { mode: isImage ? "image" : "text" } });
    metrics.totalScans++;
    metrics[isImage ? "imageScans" : "textScans"]++;
    if (engine === "ai") metrics.aiScans++;
    metrics.archetypes[result.archetype] = (metrics.archetypes[result.archetype] || 0) + 1;
    const d = dayKey(); metrics.scansByDay[d] = (metrics.scansByDay[d] || 0) + 1;
    metrics.latencyMsSum += Date.now() - started; metrics.latencyCount++;

    let remainingAfter = null;
    if (!isPremiumUser) {
      if (user) {
        const u = usageToday("user:" + user.id, dayKey());
        remainingAfter = Math.max(0, config.freeScansPerDay + (u.bonus || 0) - u.used);
      } else remainingAfter = remaining(id);
    }
    res.json({ ok: true, result, engine, model, remaining: remainingAfter });
  } catch (e) {
    if (req.file?.buffer) req.file.buffer.fill(0);
    next(e);
  }
});

/* ---------------------------------- Admin --------------------------------- */
app.post("/api/admin/login", loginLimiter, (req, res) => {
  if (!ADMIN_ENABLED) return res.status(503).json({ error: "ADMIN_DISABLED" });
  const passcode = String(req.body?.passcode || "");
  if (!passcode || !safeEqual(passcode, ADMIN_PASSCODE)) {
    bumpError("ADMIN_LOGIN_FAILED");
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  const exp = Date.now() + 1000 * 60 * 60 * 8;
  const token = signAdmin(exp);
  res.cookie("ad_admin", token, { httpOnly: true, secure: COOKIE_SECURE, sameSite: "strict", maxAge: 1000 * 60 * 60 * 8 });
  res.json({ ok: true, expiresAt: exp });
});
app.post("/api/admin/logout", requireAdmin, (req, res) => {
  revoked.set(req.adminSession.signature, req.adminSession.exp);
  res.clearCookie("ad_admin", { httpOnly: true, secure: COOKIE_SECURE, sameSite: "strict" });
  res.json({ ok: true });
});
app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ ok: true, role: "admin", expiresAt: req.adminSession.exp }));
app.get("/api/admin/metrics", requireAdmin, (req, res) => {
  const avgLatency = metrics.latencyCount ? Math.round(metrics.latencyMsSum / metrics.latencyCount) : 0;
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1000),
    totalScans: metrics.totalScans, aiScans: metrics.aiScans, imageScans: metrics.imageScans, textScans: metrics.textScans,
    errors: metrics.errors, errorCodes: metrics.errorCodes, blocked: metrics.blocked,
    avgLatencyMs: avgLatency,
    topArchetypes: Object.entries(metrics.archetypes).sort((a, b) => b[1] - a[1]).slice(0, 6),
    scansByDay: metrics.scansByDay,
    ai: aiStatus(),
    freeQuota: quotaStatus(),
    geminiModels: geminiModelInfo(),
    billing: billingSnapshot(),
    stripe: stripeConfigured(),
  });
});
app.get("/api/admin/config", requireAdmin, (req, res) => res.json({ ok: true, config }));
app.put("/api/admin/config", requireAdmin, (req, res) => {
  const b = req.body || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  if (b.freeScansPerDay !== undefined) config.freeScansPerDay = Math.max(0, Math.min(50, num(b.freeScansPerDay, config.freeScansPerDay)));
  if (b.priceMonthly !== undefined) config.priceMonthly = Math.max(0, num(b.priceMonthly, config.priceMonthly));
  if (b.priceYearly !== undefined) config.priceYearly = Math.max(0, num(b.priceYearly, config.priceYearly));
  if (typeof b.paywallHeadline === "string") config.paywallHeadline = b.paywallHeadline.slice(0, 120);
  if (typeof b.paywallQuestion === "string") config.paywallQuestion = b.paywallQuestion.slice(0, 200);
  if (typeof b.productName === "string") config.productName = b.productName.slice(0, 60);
  if (b.premiumFeatures && typeof b.premiumFeatures === "object") Object.assign(config.premiumFeatures, b.premiumFeatures);
  res.json({ ok: true, config });
});

/* ------------------------------ Static app -------------------------------- */
/* Strict allowlist: only the frontend is served. Server source, .env files and
 * directory listings are never exposed. */
const PUBLIC_FILES = new Set([
  "index.html", "styles.css", "engine.js", "app.js", "manifest.webmanifest", "sw.js", "auradetector.html",
]);
app.get("/", (req, res) => res.sendFile(path.join(APP_DIR, "index.html")));
app.get(/^\/([A-Za-z0-9._-]+)$/, (req, res, next) => {
  if (PUBLIC_FILES.has(req.params[0])) return res.sendFile(path.join(APP_DIR, req.params[0]));
  next();
});
app.use((req, res) => res.status(404).json({ error: "NOT_FOUND" }));

/* ---------------------------- Error handling ------------------------------ */
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") err = new AiError("FILE_TOO_LARGE", 413);
  const code = (err && err.code) || "SERVER_ERROR";
  const status = (err && err.http) || 500;
  if (!["RATE_LIMITED", "FREE_QUOTA_EXCEEDED", "CONTENT_REJECTED", "UNAUTHORIZED", "INVALID_CREDENTIALS", "INVALID_IMAGE", "UNSUPPORTED_FORMAT", "FILE_TOO_LARGE"].includes(code)) bumpError(code);
  // Structured server-side log WITHOUT image/text content or secrets.
  console.error(JSON.stringify({ level: "error", reqId: req.id, route: req.path, code, detail: err?.detail || undefined, msg: String(err?.message || err).slice(0, 120) }));
  res.status(status).json({ error: code, requestId: req.id });
});

app.listen(PORT, () => {
  const st = aiStatus();
  console.log(JSON.stringify({
    level: "info", msg: "AuraDetector server listening", port: PORT, env: IS_PROD ? "production" : "development",
    aiProvider: st.provider, aiConfigured: st.configured, aiModel: st.model, adminEnabled: ADMIN_ENABLED,
    publicOrigin: publicOrigin(), cookieSecure: COOKIE_SECURE,
  }));
});
