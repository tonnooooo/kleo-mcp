/**
 * KLEO STUDIO — RESPONSE HARDENING (14 October 2026). Every response of the Worker passes through `secureResponse`:
 * HTTPS only (HSTS), no MIME sniffing, no framing, a strict referrer policy, no powerful browser features, and a
 * Content-Security-Policy that fits what is served:
 *   - the app (index.html + app.js): scripts only from this origin (and Cloudflare Turnstile on sign-up); pictures, video and sound from this origin, data:
 *     and blob: (previews of a file before it is uploaded); fetches only to this origin;
 *   - the Kleo site pages proxied from the kleo-site repository: their one inline script by hash, Google Fonts, the
 *     media bucket, and the analytics beacon on the MCP host;
 *   - media and JSON: nothing may run at all (`default-src 'none'`), so an uploaded file can never act as a page.
 * Plain-HTTP requests are sent to HTTPS before anything else happens.
 */

/** The inline `<script>` every site page carries (removes the no-js class), and the fallback on site.js. */
const SITE_INLINE_SCRIPT = "'sha256-0A3SoNnOj/VD5rKtWDb4PSvN8Br+QRibbwlM+84okfY='";
const SITE_ONERROR = "'sha256-/KwTAEKE9+mYpISAG1liGBx1tOlvzPR5mU24VIyc49U='";
const MEDIA_HOST = "https://media.kleooai.com";
/** The site's own samples (kleooai.com/samples/…), shown by the app while it still lives on app.kleooai.com. */
const SITE_HOST = "https://kleooai.com";
const MCP_HOST = "https://mcp.kleooai.com";

const COMMON = [
  "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'", "upgrade-insecure-requests",
];

const TURNSTILE = "https://challenges.cloudflare.com";
/** Cloudflare Web Analytics, which the zone injects into every HTML page (the script, then its beacon). */
const CF_INSIGHTS = "https://static.cloudflareinsights.com";
const CF_BEACON = "https://cloudflareinsights.com";

export const APP_CSP = [
  "default-src 'self'",
  `script-src 'self' ${TURNSTILE} ${CF_INSIGHTS}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${SITE_HOST} ${MEDIA_HOST}`,
  `media-src 'self' blob: ${SITE_HOST} ${MEDIA_HOST}`,
  "font-src 'self'",
  `connect-src 'self' ${CF_BEACON}`,
  `frame-src ${TURNSTILE}`,
  "worker-src 'none'",
  "manifest-src 'self'",
  ...COMMON,
].join("; ");

export const SITE_CSP = [
  "default-src 'self'",
  `script-src 'self' ${SITE_INLINE_SCRIPT} 'unsafe-hashes' ${SITE_ONERROR} ${CF_INSIGHTS}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data: ${MEDIA_HOST}`,
  `media-src 'self' ${MEDIA_HOST}`,
  `connect-src 'self' ${MCP_HOST} ${CF_BEACON}`,
  "frame-src 'none'",
  "worker-src 'none'",
  ...COMMON,
].join("; ");

/** Media files, JSON and plain-text answers: a browser that opens one directly must not run anything in it. */
export const LOCKED_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const PERMISSIONS = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=()";

/** The plain-HTTP twin of a request, sent to HTTPS (local development hosts stay as they are). */
export function httpsRedirect(url: URL): Response | null {
  if (url.protocol !== "http:") return null;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".test")) return null;
  return new Response(null, { status: 301, headers: { location: `https://${url.host}${url.pathname}${url.search}`, "cache-control": "max-age=3600" } });
}

/** Adds the security headers; `site` says the body is a proxied Kleo site page rather than the app. */
export function secureResponse(res: Response, opts: { site?: boolean } = {}): Response {
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  const h = out.headers;
  const type = (h.get("content-type") ?? "").toLowerCase();
  h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("permissions-policy", PERMISSIONS);
  h.set("cross-origin-opener-policy", "same-origin");
  h.set("cross-origin-resource-policy", opts.site ? "cross-origin" : "same-origin");
  if (type.includes("text/html")) h.set("content-security-policy", opts.site ? SITE_CSP : APP_CSP);
  else if (!type.includes("javascript") && !type.includes("text/css") && !type.includes("manifest")) h.set("content-security-policy", LOCKED_CSP);
  h.delete("x-powered-by");
  return out;
}
