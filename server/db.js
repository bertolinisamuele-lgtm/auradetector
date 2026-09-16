/* ============================================================================
 * AuraDetector — server/db.js
 * Real persistence using the built-in node:sqlite (no native dependency).
 * Swap for PostgreSQL in production — the query surface is intentionally small.
 * ==========================================================================*/
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DATABASE_FILE || path.join(DATA_DIR, "auradetector.sqlite"));
// WAL is fastest on a normal disk; some network/overlay filesystems reject it,
// so fall back to the default rollback journal instead of crashing.
try { db.exec("PRAGMA journal_mode = WAL;"); } catch { try { db.exec("PRAGMA journal_mode = DELETE;"); } catch {} }
try { db.exec("PRAGMA foreign_keys = ON;"); } catch {}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  name          TEXT,
  password_hash TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  deleted_at    INTEGER
);
CREATE TABLE IF NOT EXISTS identities (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,           -- 'google' | 'apple'
  provider_sub TEXT NOT NULL,
  email        TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE(provider, provider_sub)
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL DEFAULT 'stripe',
  customer_id        TEXT,
  subscription_id    TEXT UNIQUE,
  price_id           TEXT,
  plan               TEXT,             -- 'monthly' | 'yearly'
  status             TEXT NOT NULL,     -- active | trialing | past_due | canceled | incomplete
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE TABLE IF NOT EXISTS scans (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  anon_id    TEXT,
  mode       TEXT NOT NULL,
  score      INTEGER,
  tier       TEXT,
  archetype  TEXT,
  categories TEXT,
  engine     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scans_user ON scans(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS usage_limits (
  subject    TEXT NOT NULL,             -- 'user:<id>' | 'ip:<addr>'
  day        TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  bonus      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, day)
);
CREATE TABLE IF NOT EXISTS analytics_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  anon_id    TEXT,
  event      TEXT NOT NULL,
  props      TEXT,
  created_at INTEGER NOT NULL
);
`);

export const now = () => Date.now();
export const uid = () => crypto.randomUUID();
export const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/* --------------------------------- Users ---------------------------------- */
export function getUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL").get(String(email || "").toLowerCase()) || null;
}
export function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) || null;
}
export function createUser({ email, name, passwordHash }) {
  const id = uid();
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)")
    .run(id, email ? String(email).toLowerCase() : null, name || null, passwordHash || null, now());
  return getUserById(id);
}
export function touchUser(id) { db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now(), id); }
export function deleteUser(id) {
  db.prepare("UPDATE users SET deleted_at = ?, email = NULL, password_hash = NULL, name = NULL WHERE id = ?").run(now(), id);
  db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(id);
}
export function publicUser(u) { return u ? { id: u.id, email: u.email, name: u.name, createdAt: u.created_at } : null; }

/* ------------------------------- Identities ------------------------------- */
export function findIdentity(provider, sub) {
  return db.prepare("SELECT * FROM identities WHERE provider = ? AND provider_sub = ?").get(provider, sub) || null;
}
export function linkIdentity(userId, provider, sub, email) {
  const existing = findIdentity(provider, sub);
  if (existing) return existing;
  const id = uid();
  db.prepare("INSERT INTO identities (id, user_id, provider, provider_sub, email, created_at) VALUES (?,?,?,?,?,?)")
    .run(id, userId, provider, sub, email || null, now());
  return db.prepare("SELECT * FROM identities WHERE id = ?").get(id);
}

/* -------------------------------- Sessions -------------------------------- */
export function createSession(userId, { userAgent, ip } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const id = uid();
  const ttl = 1000 * 60 * 60 * 24 * 30; // 30 days
  db.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent, ip) VALUES (?,?,?,?,?,?,?)")
    .run(id, userId, sha256(token), now(), now() + ttl, String(userAgent || "").slice(0, 200), String(ip || "").slice(0, 60));
  return { token, expiresAt: now() + ttl };
}
export function sessionUser(token) {
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND revoked = 0").get(sha256(token));
  if (!s) return null;
  if (s.expires_at < now()) { db.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?").run(s.id); return null; }
  const u = getUserById(s.user_id);
  if (!u) return null;
  // sliding expiry (max once per hour to avoid a write on every request)
  if (s.expires_at - now() < 1000 * 60 * 60 * 24 * 29) {
    db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(now() + 1000 * 60 * 60 * 24 * 30, s.id);
  }
  return { user: u, session: s };
}
export function revokeSession(token) {
  if (!token) return;
  db.prepare("UPDATE sessions SET revoked = 1 WHERE token_hash = ?").run(sha256(token));
}
export function revokeAllSessions(userId) { db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(userId); }

/* ------------------------------ Subscriptions ----------------------------- */
export function upsertSubscription(s) {
  const existing = s.subscription_id
    ? db.prepare("SELECT id FROM subscriptions WHERE subscription_id = ?").get(s.subscription_id)
    : null;
  const id = existing ? existing.id : uid();
  if (existing) {
    db.prepare(`UPDATE subscriptions SET user_id=?, customer_id=?, price_id=?, plan=?, status=?,
      current_period_end=?, cancel_at_period_end=?, updated_at=? WHERE id=?`)
      .run(s.user_id, s.customer_id || null, s.price_id || null, s.plan || null, s.status,
        s.current_period_end || null, s.cancel_at_period_end ? 1 : 0, now(), id);
  } else {
    db.prepare(`INSERT INTO subscriptions (id, user_id, provider, customer_id, subscription_id, price_id, plan, status,
      current_period_end, cancel_at_period_end, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, s.user_id, s.provider || "stripe", s.customer_id || null, s.subscription_id || null,
        s.price_id || null, s.plan || null, s.status, s.current_period_end || null,
        s.cancel_at_period_end ? 1 : 0, now());
  }
  return id;
}
export function subscriptionForUser(userId) {
  return db.prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1").get(userId) || null;
}
export function customerIdForUser(userId) {
  const r = db.prepare("SELECT customer_id FROM subscriptions WHERE user_id = ? AND customer_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(userId);
  return r ? r.customer_id : null;
}
export function setCustomerId(userId, customerId) {
  const existing = db.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND customer_id = ?").get(userId, customerId);
  if (existing) return;
  db.prepare(`INSERT INTO subscriptions (id, user_id, provider, customer_id, status, updated_at)
              VALUES (?,?, 'stripe', ?, 'customer_created', ?)`).run(uid(), userId, customerId, now());
}

/* ---------------------------------- Scans --------------------------------- */
export function saveScan({ id, userId, anonId, mode, score, tier, archetype, categories, engine }) {
  db.prepare(`INSERT OR REPLACE INTO scans (id, user_id, anon_id, mode, score, tier, archetype, categories, engine, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id || uid(), userId || null, anonId || null, mode, score ?? null, tier || null, archetype || null,
      categories ? JSON.stringify(categories) : null, engine || null, now());
}
export function scansForUser(userId, limit = 50) {
  return db.prepare("SELECT * FROM scans WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit)
    .map((s) => ({ ...s, categories: s.categories ? safeParse(s.categories) : null }));
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/* ------------------------------ Usage limits ------------------------------ */
export function usageToday(subject, day) {
  return db.prepare("SELECT * FROM usage_limits WHERE subject = ? AND day = ?").get(subject, day) || { subject, day, used: 0, bonus: 0 };
}
export function incrementUsage(subject, day) {
  db.prepare(`INSERT INTO usage_limits (subject, day, used) VALUES (?,?,1)
              ON CONFLICT(subject, day) DO UPDATE SET used = used + 1`).run(subject, day);
}

/* ------------------------------- Analytics -------------------------------- */
export function track({ userId, anonId, event, props }) {
  db.prepare("INSERT INTO analytics_events (user_id, anon_id, event, props, created_at) VALUES (?,?,?,?,?)")
    .run(userId || null, anonId || null, event, props ? JSON.stringify(props) : null, now());
}
export function countRows(sql, ...args) {
  const r = db.prepare(sql).get(...args);
  return r ? Object.values(r)[0] : 0;
}
