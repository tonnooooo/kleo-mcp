/**
 * RESPONSE HARDENING FOR THE MCP WORKER (14 October 2026). Every answer of mcp.kleooai.com gets HSTS, no MIME
 * sniffing, no framing (the sign-in and consent page at /authorize must never sit inside somebody else's page), a strict
 * referrer policy and no powerful browser features. HTML pages get a Content-Security-Policy limited to what cannot
 * break their inline scripts and styles: no framing, no <base>, no plugins. Files and JSON get `default-src 'none'`,
 * so nothing served from here can ever run as a page. Plain HTTP is sent to HTTPS first.
 */
const PERMISSIONS = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=()";
const HTML_CSP = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; upgrade-insecure-requests";
const LOCKED_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

/** The HTTPS address of a plain-HTTP request (local development hosts stay as they are). */
export function httpsRedirect(url: URL): Response | null {
  if (url.protocol !== "http:") return null;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".test")) return null;
  return new Response(null, { status: 301, headers: { location: `https://${url.host}${url.pathname}${url.search}`, "cache-control": "max-age=3600" } });
}

export function hardenResponse(res: Response): Response {
  if (res.status === 101 || (res as Response & { webSocket?: unknown }).webSocket) return res;
  const out = new Response(res.body, res);
  const h = out.headers;
  const type = (h.get("content-type") ?? "").toLowerCase();
  h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("permissions-policy", PERMISSIONS);
  if (!h.has("content-security-policy")) h.set("content-security-policy", type.includes("text/html") ? HTML_CSP : LOCKED_CSP);
  return out;
}
