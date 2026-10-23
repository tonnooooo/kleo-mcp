/**
 * KLEO STUDIO — THE ADMIN CONSOLE'S OWN HOST, OPEN ONLY TO THE OWNER'S COMPUTER (23 October 2026, the owner: "usa chrome
 * per mettere solo il mio computer per admin, sicurezza massima non voglio brecce").
 *
 * The console lives only on ADMIN_HOST (admin.kleooai.com):
 *  - On every other host (app.kleooai.com, kleooai.com) /admin, /api/admin/* and the console's files answer the site's
 *    404, exactly like a page that does not exist.
 *  - On the admin host nothing else answers: the console page and its files, the media previews, and the few API routes
 *    its sign-in needs (config, me, sign-in with a password, sign-out). Customers' routes are 404 there.
 *  - Every request to the admin host must carry the owner's client certificate (mutual TLS, Cloudflare's Client
 *    Certificates): presented, verified by Cloudflare's CA, not revoked, and its SHA-256 fingerprint in
 *    ADMIN_CERT_SHA256. Cloudflare's WAF blocks the rest at the edge already; this is the second wall behind it.
 *    With no fingerprint configured nothing opens at all (fail closed).
 *  - A refusal is a bare 403. It is audited (admin.cert_refused, at most once a minute per address) and mailed to the
 *    owner (at most once an hour).
 * Session cookies are `__Host-` cookies with no Domain, so a session made on the app never reaches the admin host:
 * the owner signs in on the admin host itself, then types the code from his phone (admin-auth.ts).
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { audit } from "../db.ts";
import { mailOwner } from "./providers.ts";

export const DEFAULT_ADMIN_HOST = "admin.kleooai.com";

/** The admin hosts (ADMIN_HOST, comma separated; default admin.kleooai.com). */
export const adminHosts = (env: Pick<StudioEnv, "ADMIN_HOST">): string[] =>
  (env.ADMIN_HOST ?? DEFAULT_ADMIN_HOST).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
export const isAdminHost = (env: Pick<StudioEnv, "ADMIN_HOST">, hostname: string): boolean => adminHosts(env).includes(hostname.toLowerCase());
/** The console's address, for the link an admin sees in the app. */
export const adminUrl = (env: Pick<StudioEnv, "ADMIN_HOST">): string => `https://${adminHosts(env)[0] ?? DEFAULT_ADMIN_HOST}/admin`;

/** Paths that belong to the console: on any other host they do not exist. */
export const CONSOLE_PATH = /^\/(?:api\/)?admin(?:\/|$)|^\/(?:admin\.(?:js|css)|qr\.js)$/;
/** What the admin host answers: the console page and its files, media previews, its API and its sign-in. */
export const ADMIN_SITE_PATH = /^\/(?:admin(?:\/[a-z0-9_-]+){0,2}|api\/admin\/.+|api\/(?:config|me|auth\/signin|auth\/signout)|media\/.+|(?:app|admin)\.(?:js|css)|qr\.js|manifest\.webmanifest|kleo-(?:mark|favicon)\.svg|kleo-icon-dark-(?:192|512)\.png)$/;
/** The API routes the admin host answers. */
export const ADMIN_SITE_API = /^\/api\/(?:config|me|auth\/signin|auth\/signout|admin\/.+)$/;

/** The pinned fingerprints: lowercase hex, colons dropped; anything malformed is ignored. */
export function certPins(env: Pick<StudioEnv, "ADMIN_CERT_SHA256">): string[] {
  return (env.ADMIN_CERT_SHA256 ?? "").split(",").map((s) => s.trim().toLowerCase().replace(/:/g, "")).filter((s) => /^[0-9a-f]{64}$/.test(s));
}

type TlsClientAuth = { certPresented?: string; certVerified?: string; certRevoked?: string; certFingerprintSHA256?: string };
const tlsOf = (request: Request): TlsClientAuth | null =>
  ((request as unknown as { cf?: { tlsClientAuth?: TlsClientAuth } }).cf?.tlsClientAuth) ?? null;

/** Why the request's client certificate does not open the admin host, or null when it does. */
export function certProblem(env: Pick<StudioEnv, "ADMIN_CERT_SHA256">, request: Request): string | null {
  const pins = certPins(env);
  if (!pins.length) return "no_pin";
  const t = tlsOf(request);
  if (!t || t.certPresented !== "1") return "no_cert";
  if (t.certVerified !== "SUCCESS") return "not_verified";
  if (t.certRevoked === "1") return "revoked";
  return pins.includes(String(t.certFingerprintSHA256 ?? "").toLowerCase()) ? null : "wrong_cert";
}

/** The bare answer to a request without the owner's certificate. */
export const refused = (): Response => new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/**
 * Writes the refusal down: an audit row at most once a minute per address, an e-mail to the owner at most once an hour.
 * Never throws (it runs after the answer has gone).
 */
export async function noteRefused(env: StudioEnv, request: Request, why: string, nowMs = Date.now()): Promise<void> {
  try {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const cf = (request as unknown as { cf?: { country?: string; city?: string; asOrganization?: string } }).cf ?? {};
    const recent = (event: string, seconds: number, ipOnly: boolean) => env.DB.prepare(`SELECT 1 AS one FROM audit
        WHERE id > (SELECT COALESCE(MAX(id), 0) - 20000 FROM audit) AND event = ? AND at >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch')
        ${ipOnly ? "AND json_extract(detail, '$.ip') = ?" : ""} LIMIT 1`).bind(event, Math.floor(nowMs / 1000) - seconds, ...(ipOnly ? [ip] : [])).first();
    if (await recent("admin.cert_refused", 60, true)) return;
    const path = new URL(request.url).pathname.slice(0, 120);
    await audit(env as unknown as Env, null, null, "admin.cert_refused", { ip, country: cf.country ?? null, city: cf.city ?? null, network: cf.asOrganization ?? null, why, path });
    if (await recent("admin.cert_alert", 3600, false)) return;
    await audit(env as unknown as Env, null, null, "admin.cert_alert", { ip, why });
    await mailOwner(env, "Kleo admin: a computer without your certificate tried the console",
      `A request reached ${new URL(request.url).hostname}${path} without your client certificate and was refused (${why}).\n\n`
      + `Address: ${ip}\nPlace: ${[cf.city, cf.country].filter(Boolean).join(", ") || "unknown"}\nNetwork: ${cf.asOrganization ?? "unknown"}\n`
      + `Device: ${request.headers.get("user-agent")?.slice(0, 200) ?? "unknown"}\nTime: ${new Date(nowMs).toUTCString()}\n\n`
      + "Nothing was opened. You get at most one of these an hour; every refusal is in the audit (admin.cert_refused).\n", nowMs);
  } catch (e) {
    console.error("admin cert refusal note", e instanceof Error ? e.message : e);
  }
}
