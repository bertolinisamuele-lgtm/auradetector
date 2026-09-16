# AuraDetector — AI Aura Scanner

Mobile-first PWA that scores an “Aura” (0–1000) from a **photo** or a **described scenario**, using **real Google Gemini Vision on the server** — on the **Gemini API Free Tier**, with no credit card and no paid provider. Entertainment product: the Aura Score is AI-generated, not a scientific measurement.

---

## 1. Architecture (fixed flow)

```
PHOTO SELECTED
   ↓  client-side validation (type / size)
SECURE UPLOAD                (multipart, memory only)
   ↓
BACKEND VALIDATION           (magic bytes, 10 MB cap, moderation)
   ↓
AI VISION ANALYSIS           (Google Gemini Vision, Free Tier — key server-side)
   ↓
STRUCTURED AI RESPONSE       (JSON)
   ↓
SERVER-SIDE VALIDATION       (schema clamp, tier/archetype recomputed)
   ↓
AURA SCORE
   ↓
RESULT PAGE
```

The image is held in memory only for the duration of the request and is **never written to disk or object storage**. The API key never reaches the browser.

```
auradetector/
├── index.html              # App shell + SEO landing (dark premium design)
├── styles.css
├── engine.js               # backend API client + offline-preview engine + schema
├── app.js                  # router, result, share card, battle, history, admin UI
├── auradetector.html       # pre-bundled single-file build of the app
├── manifest.webmanifest
├── sw.js
├── .env.example            # every variable you must configure
├── package.json
└── server/
    ├── index.js            # secure API, uploads, rate limiting, admin auth, static host
    ├── ai.js               # AI vision + strict schema validation
    ├── test.mjs            # end-to-end + security test suite (34 checks)
    ├── schema.sql          # reference PostgreSQL schema
    └── aura-proxy.js       # deprecated (see header)
```

---

## 2. Quick start

```bash
npm install
cp .env.example .env      # then edit .env
npm start                 # serves the app + API on http://localhost:8787
```

The browser only ever talks to this server (`connect-src 'self'` in the CSP), so a browser-copied API key can never leak to a provider.

### Tests

```bash
npm test
```

Runs 34 end-to-end + security checks. By default it uses `AI_PROVIDER=mock` (deterministic, image-byte derived) so the whole pipeline can be verified **without** a provider key. To test real vision, set `AI_PROVIDER` and the matching key before running.

---

## 3. Gemini Free Tier (zero cost)

AuraDetector uses **Google Gemini** via the **AI Studio free tier**: genuinely free, **no credit card, no billing account, no expiration**.

### How to get the free key

1. Open **https://aistudio.google.com/apikey** and sign in with a Google account.
2. Click **Create API key** → choose/create a project. No payment method is requested on the free tier.
3. Copy the key and keep it secret.

Model IDs churn: AuraDetector probes the key at runtime and picks a working free Flash model (currently the `flash-lite` family). `gemini-2.5-flash` is already retired for new accounts, so it is not preferred.

You can see the exact free limits for your project at **https://aistudio.google.com/rate-limit**.

### Where to insert it

- **In CREAO**: save it as the secret **`AURADETECTOR_GEMINI`** (the platform exposes it to the server as `process.env.AURADETECTOR_GEMINI`).
- **On your own host** (`npm start`): put `AURADETECTOR_GEMINI=AIza…` in `.env` (loaded automatically) or export it. `GEMINI_API_KEY` also works as a fallback name.
- The key is used **only server-side**. It is never in the frontend, the JS bundle, `localStorage`, a URL, or any API response (verified by the test suite).

### Free-tier protection (no accidental bill)

- `GEMINI_FREE_DAILY_LIMIT` (default **900**) and `GEMINI_FREE_PER_MINUTE` (default **8**) are enforced **before** any provider call.
- When the cap is hit, the server returns `429 FREE_QUOTA_EXCEEDED` and the UI shows a temporary “free AI capacity is full, try again in a few minutes” message.
- If Google itself returns `429 RESOURCE_EXHAUSTED`, the server cools down for 60s and returns the same code.
- There is **no paid fallback anywhere in the code path**: a failed free call is never retried on a billable provider.
- Only free-tier **Flash** models are ever selected; Pro/paid models are explicitly excluded.

### Model selection

Google retires model IDs over time, so AuraDetector resolves the model at runtime: it asks the API which models your key can use, keeps the free-tier Flash ones, and pins the first that works. Set `GEMINI_MODEL=<id>` only if you want to force one. `gemini-2.0-flash` is deliberately last in the fallback list because Google retired it.

---

## 3b. Environment variables

| Variable | Purpose |
|---|---|
| `AI_PROVIDER` | Default **`gemini`**. `mock` = offline test provider only |
| `AURADETECTOR_GEMINI` | Google Gemini key — **server-side only** (`GEMINI_API_KEY` also accepted) |
| `GEMINI_MODEL` | `auto` (default) or a pinned free Flash model id |
| `GEMINI_FREE_DAILY_LIMIT` | Hard daily cap (default 900) |
| `GEMINI_FREE_PER_MINUTE` | Hard per-minute cap (default 8) |
| `ADMIN_PASSCODE` | Admin passphrase (min 8 chars) |
| `ADMIN_SESSION_SECRET` | Signs the admin session (min 16 chars) |
| `SESSION_SECRET` | Cookie signing secret |
| `FREE_SCANS_PER_DAY` | Per-visitor free scan quota |
| `ANALYZE_PER_HOUR` | Per-IP abuse cap |
| `APP_ORIGIN` | Public origin for OAuth redirects / Stripe return URLs |
| `DATA_DIR` | SQLite location (use PostgreSQL in production) |
| `SESSION_SECRET` | Signs session + OAuth-state cookies |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | Apple sign-in |
| `STRIPE_SECRET_KEY` | Stripe API (server-side only) |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe webhooks |
| `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_YEARLY` | Recurring price IDs |
| `PORT`, `NODE_ENV`, `COOKIE_SECURE`, `ALLOWED_ORIGINS` | Runtime / CORS |

Optional, **off by default**: `AI_PROVIDER=openai|openrouter` with the matching key. AuraDetector never uses a paid provider unless you explicitly configure one. `ALLOW_MOCK_AI=true` enables the deterministic test provider — never use it in production.

---

## 4. Admin access

1. **How to reach it** — open the app and tap the **▤** icon (or go to `/admin` in-app via the bottom nav → Admin).  
2. **Where the credential is configured** — on the **server**, in the process environment (`.env`). It is never in the frontend, the JS bundle, or `localStorage`.  
3. **Environment variables** — `ADMIN_PASSCODE` and `ADMIN_SESSION_SECRET`. If either is missing/too short, the admin area is disabled (returns `503 ADMIN_DISABLED`).  
4. **How to change it** — edit `ADMIN_PASSCODE` in `.env` and restart the server. Rotating `ADMIN_SESSION_SECRET` invalidates all existing admin sessions.  
5. **Logout** — the **LOGOUT** button calls `POST /api/admin/logout`, which revokes the token server-side and clears the cookie.  
6. **How endpoints are protected** — login is rate-limited (8 / 15 min per IP), the passphrase is compared with a constant-time hash comparison, and a successful login issues an **HttpOnly, Secure (in production), SameSite=Strict** cookie containing an HMAC-signed, expiring token. Every `/api/admin/*` request re-verifies the signature, expiry and revocation list — hiding the page is not the security boundary.

---

## 5. Accounts (email + Google + Apple)

- **Use without an account**: one free scan per day (server-enforced by IP when anonymous).
- **Email + password**: registration and login. Passwords are hashed with **scrypt** (salted) and never stored in clear; minimum 8 characters with a letter and a number. The response never reveals whether an email exists (constant-time comparison).
- **Google**: OAuth 2.0 authorization-code flow; the `id_token` is verified server-side against Google, and a signed `state` cookie prevents CSRF.
- **Apple**: Sign in with Apple with `response_mode=form_post`; the client secret is an **ES256 JWT built from your `.p8` key**, and the `id_token` is verified against Apple's JWKS (signature, issuer, audience, expiry).
- **Sessions**: opaque 32-byte tokens; only their SHA-256 hash is stored. Cookie is `HttpOnly`, `Secure` in production, `SameSite=Lax`, 30-day sliding expiry. Logout revokes the session server-side; `logout-all` revokes every session.
- **Account linking**: signing in with Google/Apple using an email that already exists links the provider to that account instead of creating a duplicate.
- **Delete account**: `DELETE /api/auth/account` anonymises the user, revokes all sessions and cascades identities/subscriptions.

Set-up (Google): create a Web OAuth client in Google Cloud Console, add redirect URI `<APP_ORIGIN>/api/auth/google/callback`, then set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

Set-up (Apple): create a Services ID and a `.p8` key in Apple Developer, set the return URL to `<APP_ORIGIN>/api/auth/apple/callback`, then set `APPLE_CLIENT_ID` (Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`.

---

## 6. Subscriptions (Stripe, server-side verified)

Flow: `UNLOCK AURA PRO` → `POST /api/billing/checkout` (server creates the Checkout Session) → Stripe Checkout → return to the app → **the webhook is the only thing that grants Premium**.

- Endpoint: `POST /api/stripe/webhook`, mounted with `express.raw` so the **raw body** is available for `stripe.webhooks.constructEvent`. Invalid signatures are rejected with `400` and never processed.
- Handled events: `checkout.session.completed`, `customer.subscription.created` / `.updated` / `.deleted`, `invoice.paid`, `invoice.payment_failed`.
- State is written to the `subscriptions` table (`status`, `current_period_end`, `cancel_at_period_end`, plan).
- **Entitlement is derived from that table on every request** (`/api/me`, `/api/billing/status`, and premium endpoints such as `GET /api/premium/history` which returns `402 PREMIUM_REQUIRED` for free users). The browser can never grant Premium, and editing `localStorage` changes nothing.
- **Cancel / manage**: `POST /api/billing/portal` opens the Stripe Billing Portal (`cancel at period end`, payment method, invoices).
- Prices come from `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_YEARLY`; the display prices on the landing page are editable from the admin dashboard.

Stripe set-up: create two recurring Prices, then add a webhook endpoint pointing at `<APP_ORIGIN>/api/stripe/webhook` with the events listed above, and copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Test locally with `stripe listen --forward-to localhost:8787/api/stripe/webhook`.

---

## 7. Security posture (implemented)

- API key exclusively server-side; CSP `connect-src 'self'` also prevents browser-side provider calls.
- Upload validation: allowlist MIME + **magic-byte sniffing** (`JPEG/PNG/WEBP`), 10 MB cap, no SVG, no executables, safe generated names (the client filename is never used).
- Images processed in memory and zeroed after analysis; no public URLs, nothing persisted.
- Prompt-injection defence: system prompt has priority, image text is treated as data, injection phrases rejected.
- Rate limiting: per-IP API limiter, per-IP analyse limiter, login limiter, plus per-identity free daily quota enforced **server-side** (IP-keyed when cookies are absent).
- Admin: server-side session (HttpOnly/Secure/SameSite=Strict), constant-time comparison, brute-force limit, revocation on logout.
- Strict serve allowlist: `/server`, `.env`, `package.json` and directory listings are never served (verified by tests).
- Security headers via Helmet: CSP, `X-Content-Type-Options: nosniff`, `frame-ancestors`, referrer policy.
- Structured server logs without image/text content, secrets or personal data; clients receive only a stable error code + request id.

**Not claimed:** the app is not “unhackable”. Remaining hardening work is listed in the handover report.

---

## 8. Database (production)

Reference schema in `server/schema.sql`: `users`, `subscriptions`, `scans`, `scan_results`, `usage_limits`, `referrals`, `analytics_events`. The reference server keeps usage/metrics in memory — swap in PostgreSQL for production (parameterised queries, row-level access rules).

## 9. Disclaimer

AuraDetector is entertainment. Aura Scores are AI-generated and are not a scientific or objective measurement of a person. The analysis never infers ethnicity, religion, orientation, health, mental condition, politics, income, disability or any other sensitive trait.
