# Deploy AuraDetector to a public HTTPS URL

This is a **full-stack** deploy (frontend + Node/Express backend + `/api/analyze`
+ Gemini). The PWA is served by the same server, so there is no CORS or
mixed-content problem.

**Recommended host: Render — free tier, HTTPS, no credit card required.**

---

## 0. What you need before starting

- A **GitHub account** (free) — Render deploys from a repository.
- The **Gemini API key** (free): <https://aistudio.google.com/apikey>
- These files (already prepared): `Dockerfile`, `render.yaml`, `package.json`, `server/`, frontend files.

---

## 1. Put the code on GitHub (no command line needed)

1. Go to **https://github.com/new**
2. **Repository name**: `auradetector` · **Visibility**: Private (or Public) → **Create repository**.
3. On the empty repo page click **“uploading an existing file”**.
4. Unzip `auradetector.zip` (provided with this project) and **drag the *contents* of the `auradetector` folder** into the upload area
   (do **not** upload `node_modules` or `.env` — they are not needed and `.env` would leak secrets).
5. Commit message: `AuraDetector initial deploy` → **Commit changes**.

> If you prefer the command line:
> ```bash
> cd auradetector
> git init && git add . && git commit -m "initial deploy"
> git branch -M main
> git remote add origin https://github.com/<your-user>/auradetector.git
> git push -u origin main
> ```

---

## 2. Deploy on Render (click-by-click)

1. Go to **https://render.com** → **Get Started** → **Sign in with GitHub** (free account, no card).
2. Authorize Render to read your repositories (you can limit it to `auradetector`).
3. In the Render dashboard: **New +** (top right) → **Blueprint**.
4. **Connect** the `auradetector` repository → **Connect**.
5. Render reads `render.yaml` and shows the service `auradetector` (plan **Free**, runtime Docker).
6. It asks for the secret variables marked `sync: false`. Fill them:

   | Variable | Value |
   |---|---|
   | `AURADETECTOR_GEMINI` | your Gemini key (starts with `AIza…`) |
   | `ADMIN_PASSCODE` | a strong admin passphrase (min 8 chars) |
   | `ADMIN_SESSION_SECRET` | long random string (e.g. `openssl rand -hex 32`) |
   | `SESSION_SECRET` | another long random string |
   | *(optional)* `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | only if you want Google sign-in |
   | *(optional)* `APPLE_*`, `STRIPE_*` | only if you want Apple sign-in / subscriptions |

7. Click **Apply** / **Create Web Service**. Render builds the Docker image and deploys.
8. Wait for the status **Live**. Your URL appears at the top:

   ```
   https://auradetector-xxxx.onrender.com
   ```

That URL is your **public HTTPS** AuraDetector. `APP_ORIGIN` is detected
automatically from Render, so OAuth redirects, Stripe return URLs and Secure
cookies already match the domain.

> Free instance note: Render spins the service down after ~15 minutes of
> inactivity, so the first click after a pause takes ~30–60 s to wake up.
> Free instances also have an **ephemeral disk**: the SQLite database lives at
> `/data` and is reset on each redeploy/restart (accounts/history are cleared).
> Analysis, upload and Admin all keep working — only stored data resets.

---

## 3. Verify from the public URL (copy–paste)

Replace `https://YOUR-APP.onrender.com` with your URL.

```bash
BASE=https://YOUR-APP.onrender.com

# a) homepage loads
curl -s -o /dev/null -w "home: %{http_code} %{content_type}\n" $BASE/

# b) health + AI configured (provider=gemini, freeTier=true)
curl -s $BASE/api/health

# c) real photo upload → real Gemini score
curl -s -X POST -F "image=@/path/to/photo.jpg;type=image/jpeg" $BASE/api/analyze

# d) no API key leaked in the frontend bundle
curl -s $BASE/ | grep -c "AIza" || echo "no key in frontend: OK"

# e) admin endpoints require authentication
curl -s -o /dev/null -w "admin metrics (expect 401): %{http_code}\n" $BASE/api/admin/metrics
curl -s -o /dev/null -w "server source (expect 404): %{http_code}\n" $BASE/server/index.js
```

Expected results:

| Check | Expected |
|---|---|
| `GET /` | `200 text/html` |
| `GET /api/health` | `{"ok":true,...,"ai":{"provider":"gemini","configured":true,...}}` |
| `POST /api/analyze` | JSON with `result.score` 0–1000, `tier`, `archetype`, `categories` |
| `grep AIza` on the homepage | no match (key is server-side only) |
| `GET /api/admin/metrics` | `401` |
| `GET /server/index.js` | `404` |

Then in the browser:
1. Open the URL → **SCAN MY AURA** → choose a photo → you get the real Aura Score.
2. Open **▤ Admin** → it asks for the passphrase (server-verified) → enter `ADMIN_PASSCODE`.

---

## 4. Enabling Google / Apple sign-in and Stripe (optional)

- **Google** (exact values for `https://auradetector.onrender.com`):
  1. Google Cloud Console → *APIs & Services → Credentials → Create credentials → OAuth client ID → Web application*.
  2. **Authorized JavaScript origins**: `https://auradetector.onrender.com` (no trailing slash, no path)
  3. **Authorized redirect URIs**: `https://auradetector.onrender.com/api/auth/google/callback` (exact, provider-first path)
  4. If the OAuth consent screen is in **Testing**, add your Google account under *Test users*, otherwise Google returns `access_denied`.
  5. Copy **Client ID** and **Client secret** → Render → *Environment* → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` → Save (redeploys).

  You can always read the exact values the running server expects at
  `https://auradetector.onrender.com/api/auth/providers`.

### Auth troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Login returns but you stay signed out | `SESSION_SECRET` missing → cookies signed with a per-boot random secret, invalidated by a restart/cold start | set `SESSION_SECRET` (long random). The server also persists a stable fallback next to the DB. |
| `auth_error=google_not_configured` | `GOOGLE_CLIENT_ID`/`SECRET` not set in Render | add both env vars |
| `auth_error=google_redirect_uri_mismatch` | redirect URI in Google Console differs from `/api/auth/google/callback` | copy the exact URI from `/api/auth/providers` |
| `auth_error=google_access_denied` | consent screen in Testing and your account is not a test user | add your account as a test user (or publish the app) |
| `auth_error=invalid_state` | OAuth state cookie lost/expired | retry; make sure `SESSION_SECRET` is set |
| Apple login: `no_code` | (fixed) urlencoded body was not parsed | already handled by `express.urlencoded` |
- **Apple**: Apple Developer → Services ID + `.p8` key. Return URL: `https://YOUR-APP.onrender.com/api/auth/apple/callback`.
  Set `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`.
- **Stripe**: create monthly + annual Prices, add a webhook endpoint
  `https://YOUR-APP.onrender.com/api/stripe/webhook` with events
  `checkout.session.completed`, `customer.subscription.created/updated/deleted`,
  `invoice.paid`, `invoice.payment_failed`, then set `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`.

---

## 5. Alternative free hosts

| Host | How | Notes |
|---|---|---|
| **Render** (recommended) | Blueprint + `render.yaml` | Free, no card, HTTPS, Docker |
| **Koyeb** | New service from GitHub repo, builder **Dockerfile**, port 8787 | Free instance; needs GitHub |
| **Railway** | New project → Deploy from GitHub; `railway.json` already provided | Small free trial credit |
| **Fly.io** | `fly launch` / `fly deploy` with the provided `Dockerfile` | May require a card on file |
| **VPS (Hetzner/OVH…)** | `docker build -t auradetector . && docker run -p 443:8787 …` behind Caddy/Nginx | Not free, most control |

For any host, the only things you must set are:
`AURADETECTOR_GEMINI`, `ADMIN_PASSCODE`, `ADMIN_SESSION_SECRET`, `SESSION_SECRET`,
and (only for a custom domain) `APP_ORIGIN=https://your-domain`.

---

## 6. Security notes for production

- The Gemini key is read from `AURADETECTOR_GEMINI` **server-side only**; it is never served to the browser (verified by the test suite: `TEST 13`).
- `NODE_ENV=production` + `COOKIE_SECURE=true` → session/admin cookies are `Secure`, `HttpOnly`, `SameSite`.
- The server serves an allowlist of frontend files; `/server`, `.env` and `package.json` return `404`.
- Admin authentication is verified on the server with a signed, expiring cookie and a revocation list.
- Free-tier quota guard prevents accidental paid usage; there is **no paid fallback** in the code.
