/* ============================================================================
 * AuraDetector — server/config.js
 * Production/host-aware configuration shared by all server modules.
 * The public origin is auto-detected on common PaaS providers so OAuth
 * redirects, Stripe return URLs and cookies always match the HTTPS domain.
 * ==========================================================================*/
export const isProd = process.env.NODE_ENV === "production";

/** Secure cookies by default in production (override with COOKIE_SECURE=false only for local http). */
export const cookieSecure = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === "true"
  : isProd;

/** Highest-priority public URL: explicit APP_ORIGIN, else the host's own URL. */
export function publicOrigin() {
  const explicit = process.env.APP_ORIGIN;
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, "");
  const host = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.FLY_APP_NAME;
  if (host) {
    const v = host.trim().replace(/\/$/, "");
    if (/^https?:\/\//.test(v)) return v;
    if (v.includes(".fly.dev")) return "https://" + v;
    return "https://" + v;
  }
  return `http://localhost:${process.env.PORT || 8787}`;
}

/** True when the app is behind a TLS-terminating proxy (Render, Railway, Fly, most PaaS). */
export const behindProxy = isProd || Boolean(process.env.RENDER_EXTERNAL_URL || process.env.FLY_APP_NAME || process.env.RAILWAY_PUBLIC_DOMAIN);
