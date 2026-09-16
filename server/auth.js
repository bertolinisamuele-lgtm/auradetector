/* ============================================================================
 * AuraDetector — server/auth.js
 * Real authentication: email + password, Google OAuth 2.0, Apple Sign in.
 *
 *  - Passwords hashed with scrypt (salted) — never stored in clear.
 *  - Sessions are opaque random tokens; only their SHA-256 hash is stored.
 *  - Session cookie is HttpOnly (+ Secure in production, SameSite=Lax).
 *  - OAuth uses the authorization-code flow with a signed `state` cookie.
 *  - Apple client secret is an ES256 JWT built from the .p8 private key.
 * ==========================================================================*/
import express from "express";
import crypto from "node:crypto";
import {
  db, createUser, getUserByEmail, publicUser, findIdentity, linkIdentity,
  createSession, sessionUser, revokeSession, revokeAllSessions, touchUser, deleteUser, track,
} from "./db.js";

import { publicOrigin, cookieSecure as COOKIE_SECURE } from "./config.js";

const COOKIE = "ad_session";
const STATE_COOKIE = "ad_oauth_state";
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;

const cookieOpts = (maxAge) => ({ httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax", signed: true, maxAge, path: "/" });
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "";

/* ---------------------------- Password hashing ---------------------------- */
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}
export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split("$");
    if (scheme !== "scrypt") return false;
    const expected = Buffer.from(hash, "hex");
    const actual = crypto.scryptSync(password, Buffer.from(salt, "hex"), expected.length, { N: +N, r: +r, p: +p });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}
export function passwordProblem(password) {
  const p = String(password || "");
  if (p.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return "Password must contain at least one letter and one number.";
  if (p.length > 200) return "Password is too long.";
  return null;
}
function emailProblem(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 254) return "Enter a valid email address.";
  if (ALLOWED_EMAIL_DOMAIN && !e.endsWith("@" + ALLOWED_EMAIL_DOMAIN)) return "That email domain is not allowed.";
  return null;
}

/* ------------------------------- Middleware ------------------------------- */
export function attachUser(req, _res, next) {
  const token = req.signedCookies?.[COOKIE];
  const found = sessionUser(token);
  req.user = found ? found.user : null;
  req.sessionToken = token || null;
  next();
}
export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "UNAUTHORIZED" });
  next();
}
export function setSessionCookie(res, token) { res.cookie(COOKIE, token, cookieOpts(SESSION_TTL)); }
export function clearSessionCookie(res) { res.clearCookie(COOKIE, { ...cookieOpts(0), maxAge: undefined }); }

/* --------------------------------- Router --------------------------------- */
export const authRouter = express.Router();
const origin = publicOrigin;
const redirectUri = (provider) => `${origin()}/api/auth/${provider}/callback`;

authRouter.get("/me", (req, res) => {
  res.json({
    ok: true,
    user: publicUser(req.user),
    providers: req.user ? linkedProviders(req.user.id) : [],
    oauth: {
      google: { configured: googleConfigured(), redirectUri: redirectUri("google") },
      apple: { configured: appleConfigured(), redirectUri: redirectUri("apple") },
    },
  });
});

function linkedProviders(userId) {
  try { return db.prepare("SELECT provider FROM identities WHERE user_id = ?").all(userId).map((r) => r.provider); }
  catch { return []; }
}

/* ----------------------------- Email + password --------------------------- */
authRouter.post("/register", (req, res) => {
  const { email, password, name } = req.body || {};
  const ep = emailProblem(email); if (ep) return res.status(400).json({ error: "INVALID_EMAIL", message: ep });
  const pp = passwordProblem(password); if (pp) return res.status(400).json({ error: "WEAK_PASSWORD", message: pp });
  if (getUserByEmail(email)) return res.status(409).json({ error: "EMAIL_TAKEN", message: "An account with this email already exists." });
  const user = createUser({ email, name: String(name || "").slice(0, 80) || null, passwordHash: hashPassword(password) });
  const { token } = createSession(user.id, { userAgent: req.headers["user-agent"], ip: req.ip });
  setSessionCookie(res, token);
  track({ userId: user.id, event: "auth_register", props: { method: "email" } });
  res.json({ ok: true, user: publicUser(user) });
});

authRouter.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = getUserByEmail(email);
  // Always run a hash comparison to avoid user-enumeration through timing.
  const ok = user && user.password_hash ? verifyPassword(password, user.password_hash) : verifyPassword(password || "", "scrypt$1$1$1$00$00");
  if (!user || !ok || !user.password_hash) return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Email or password is incorrect." });
  touchUser(user.id);
  const { token } = createSession(user.id, { userAgent: req.headers["user-agent"], ip: req.ip });
  setSessionCookie(res, token);
  track({ userId: user.id, event: "auth_login", props: { method: "email" } });
  res.json({ ok: true, user: publicUser(user) });
});

authRouter.post("/logout", (req, res) => {
  if (req.sessionToken) revokeSession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.post("/logout-all", requireUser, (req, res) => {
  revokeAllSessions(req.user.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.delete("/account", requireUser, (req, res) => {
  deleteUser(req.user.id);
  clearSessionCookie(res);
  track({ userId: req.user.id, event: "account_deleted" });
  res.json({ ok: true });
});

/* ------------------------------ Shared OAuth ------------------------------ */
const googleCfg = () => ({
  // The URLs are overridable only to allow offline testing; production uses Google.
  authUrl: process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
  jwksUrl: process.env.GOOGLE_JWKS_URL || "https://www.googleapis.com/oauth2/v3/certs",
  clientId: String(process.env.GOOGLE_CLIENT_ID || "").trim(),
  clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || "").trim(),
});
const googleConfigured = () => Boolean(googleCfg().clientId && googleCfg().clientSecret);
const appleConfigured = () => Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);

async function fetchTimeout(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

/* CSRF state cookie. SameSite=None is REQUIRED for cross-site form_post callbacks
 * (Apple posts the code back), otherwise the cookie is not sent and login fails
 * with invalid_state. SameSite=None requires Secure, so we fall back to Lax on http. */
function stateCookieOpts() {
  return { httpOnly: true, secure: COOKIE_SECURE, sameSite: COOKIE_SECURE ? "none" : "lax", signed: true, maxAge: 1000 * 60 * 10, path: "/" };
}
function randomState(res) {
  const state = crypto.randomBytes(16).toString("base64url");
  res.cookie(STATE_COOKIE, state, stateCookieOpts());
  return state;
}
function checkState(req, res) {
  const expected = req.signedCookies?.[STATE_COOKIE];
  const got = req.query.state || req.body?.state;
  res.clearCookie(STATE_COOKIE, { path: "/" });
  return Boolean(expected && got && expected === got);
}
const fail = (res, code) => res.redirect(`${origin()}/?auth_error=${encodeURIComponent(code)}`);
const done = (res) => res.redirect(`${origin()}/?auth=ok`);

/* --------------------------------- Google --------------------------------- */
authRouter.get("/google", (req, res) => {
  const g = googleCfg();
  if (!googleConfigured()) return fail(res, "google_not_configured");
  const state = randomState(res);
  const url = new URL(g.authUrl);
  url.searchParams.set("client_id", g.clientId);
  url.searchParams.set("redirect_uri", redirectUri("google"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  res.redirect(url.toString());
});

/* Verify the Google id_token locally: signature via Google's JWKS + claims.
 * This replaces the legacy tokeninfo endpoint (which is rate-limited and can
 * fail intermittently), which was a real source of intermittent login failures. */
let googleJwks = null, googleJwksAt = 0;
async function googleKeys() {
  if (googleJwks && Date.now() - googleJwksAt < 3600_000) return googleJwks;
  const r = await fetchTimeout(googleCfg().jwksUrl, {}, 8000);
  if (!r.ok) throw new Error("jwks_" + r.status);
  googleJwks = (await r.json()).keys || [];
  googleJwksAt = Date.now();
  return googleJwks;
}
async function verifyGoogleIdToken(idToken) {
  const [h, p, s] = String(idToken).split(".");
  if (!h || !p || !s) throw new Error("bad_jwt");
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  let jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) { googleJwks = null; jwk = (await googleKeys()).find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error("no_key");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  if (!crypto.verify("RSA-SHA256", Buffer.from(h + "." + p), key, Buffer.from(s, "base64url"))) throw new Error("bad_signature");
  const iss = String(payload.iss || "");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(iss)) throw new Error("bad_iss");
  if (payload.aud !== googleCfg().clientId) throw new Error("bad_aud");
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error("expired");
  if (!payload.sub) throw new Error("no_sub");
  return payload;
}

authRouter.get("/google/callback", async (req, res) => {
  try {
    if (!googleConfigured()) return fail(res, "google_not_configured");
    // Google sends ?error=access_denied when the account is not an allowed test user, etc.
    if (req.query.error) {
      console.error(JSON.stringify({ level: "warn", route: "/api/auth/google/callback", step: "authorize", error: String(req.query.error).slice(0, 60) }));
      return fail(res, "google_" + String(req.query.error));
    }
    if (!checkState(req, res)) return fail(res, "invalid_state");
    const code = String(req.query.code || "");
    if (!code) return fail(res, "no_code");
    const g = googleCfg();
    const tr = await fetchTimeout(g.tokenUrl, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: g.clientId, client_secret: g.clientSecret,
        redirect_uri: redirectUri("google"), grant_type: "authorization_code",
      }),
    }, 10000);
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.id_token) {
      console.error(JSON.stringify({ level: "warn", route: "/api/auth/google/callback", step: "token", status: tr.status, error: tok.error || null }));
      return fail(res, "google_" + (tok.error || "token_failed"));
    }
    let info;
    try { info = await verifyGoogleIdToken(tok.id_token); }
    catch (e) {
      console.error(JSON.stringify({ level: "warn", route: "/api/auth/google/callback", step: "verify", reason: e.message }));
      return fail(res, "google_verify_failed");
    }
    const userId = upsertOAuthUser("google", info.sub, info.email, info.name);
    const { token } = createSession(userId, { userAgent: req.headers["user-agent"], ip: req.ip });
    setSessionCookie(res, token);
    track({ userId, event: "auth_login", props: { method: "google" } });
    done(res);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", route: "/api/auth/google/callback", reason: String(e && e.message).slice(0, 120) }));
    fail(res, "google_error");
  }
});

/* ---------------------------------- Apple --------------------------------- */
function appleClientSecret() {
  const pk = String(process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const header = { alg: "ES256", kid: process.env.APPLE_KEY_ID, typ: "JWT" };
  const payload = {
    iss: process.env.APPLE_TEAM_ID, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180, aud: "https://appleid.apple.com",
    sub: process.env.APPLE_CLIENT_ID,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = b64(header) + "." + b64(payload);
  const sig = crypto.createSign("SHA256").sign({ key: pk, dsaEncoding: "ieee-p1363" }, data);
  return data + "." + sig.toString("base64url");
}

let appleJwks = null;
async function verifyAppleIdToken(idToken) {
  const [h, p, s] = String(idToken).split(".");
  if (!h || !p || !s) throw new Error("bad_jwt");
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  if (!appleJwks) {
    const r = await fetch("https://appleid.apple.com/auth/keys");
    appleJwks = (await r.json()).keys;
  }
  const jwk = appleJwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("no_key");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const valid = crypto.verify("RSA-SHA256", Buffer.from(h + "." + p), key, Buffer.from(s, "base64url"));
  if (!valid) throw new Error("bad_signature");
  if (payload.iss !== "https://appleid.apple.com") throw new Error("bad_iss");
  if (payload.aud !== process.env.APPLE_CLIENT_ID) throw new Error("bad_aud");
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error("expired");
  return payload;
}

authRouter.get("/apple", (req, res) => {
  if (!appleConfigured()) return fail(res, "apple_not_configured");
  const state = randomState(res);
  const url = new URL("https://appleid.apple.com/auth/authorize");
  url.searchParams.set("client_id", process.env.APPLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri("apple"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "form_post");
  url.searchParams.set("scope", "name email");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

async function appleCallback(req, res) {
  try {
    if (!appleConfigured()) return fail(res, "apple_not_configured");
    if (!checkState(req, res)) return fail(res, "invalid_state");
    const code = String(req.body?.code || req.query.code || "");
    if (!code) return fail(res, "no_code");
    const tr = await fetchTimeout("https://appleid.apple.com/auth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: process.env.APPLE_CLIENT_ID, client_secret: appleClientSecret(),
        redirect_uri: redirectUri("apple"), grant_type: "authorization_code",
      }),
    }, 10000);
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.id_token) {
      console.error(JSON.stringify({ level: "warn", route: "/api/auth/apple/callback", step: "token", status: tr.status, error: tok.error || null }));
      return fail(res, "apple_token_failed");
    }
    const info = await verifyAppleIdToken(tok.id_token);
    let name = null;
    if (req.body?.user) { try { const u = JSON.parse(req.body.user); name = [u?.name?.firstName, u?.name?.lastName].filter(Boolean).join(" ") || null; } catch {} }
    const userId = upsertOAuthUser("apple", info.sub, info.email, name);
    const { token } = createSession(userId, { userAgent: req.headers["user-agent"], ip: req.ip });
    setSessionCookie(res, token);
    track({ userId, event: "auth_login", props: { method: "apple" } });
    done(res);
  } catch { fail(res, "apple_error"); }
}
authRouter.post("/apple/callback", appleCallback);
authRouter.get("/apple/callback", appleCallback);

/* ------------------------------- User upsert ------------------------------ */
function upsertOAuthUser(provider, sub, email, name) {
  const id = findIdentity(provider, sub);
  if (id) return id.user_id;
  let user = email ? getUserByEmail(email) : null;
  if (!user) user = createUser({ email: email || null, name: name || null, passwordHash: null });
  linkIdentity(user.id, provider, sub, email);
  touchUser(user.id);
  return user.id;
}
