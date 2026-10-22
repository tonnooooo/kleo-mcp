/**
 * KLEO STUDIO — WHERE PEOPLE SIGN IN FROM (23 October 2026, the owner: "ip utenti, posizione utenti").
 *
 * Until today D1 held only users.ip_hash, an HMAC of the sign-up address: finding the address of a real customer took
 * Cloudflare's request logs. Now every sign-up, sign-in, assistant connection and payment opened in the app writes one
 * studio_ips row: the address, its fingerprint (the same HMAC, so it finds blocked_addresses rows and twin accounts),
 * and what Cloudflare tells the Worker about it (request.cf: country, region, city, network), with the browser's name.
 *
 * The rows are kept IP_RETENTION_DAYS (about three months) and then deleted by the cron (pruneIps); the privacy page
 * says so. Nothing here may ever stop a sign-in: a failed write is logged and forgotten.
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { ipFingerprint } from "../accounts.ts";

export const IP_RETENTION_DAYS = 90;
export type IpEvent = "signup" | "signin" | "connect" | "pay";

export interface WhereFrom {
  ip: string | null; country: string | null; region: string | null; city: string | null;
  asn: number | null; asOrg: string | null; ua: string | null;
}

const text = (v: unknown, max = 80): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** The address and place of a request, as Cloudflare saw it. */
export function whereFrom(request: Request): WhereFrom {
  const cf = ((request as unknown as { cf?: Record<string, unknown> }).cf ?? {}) as Record<string, unknown>;
  return {
    ip: text(request.headers.get("cf-connecting-ip"), 64),
    country: text(cf.country, 4) ?? text(request.headers.get("cf-ipcountry"), 4),
    region: text(cf.region),
    city: text(cf.city),
    asn: Number(cf.asn) || null,
    asOrg: text(cf.asOrganization, 120),
    ua: text(request.headers.get("user-agent"), 200),
  };
}

/** Writes one row; never throws. */
export async function recordIp(env: StudioEnv, userId: string, event: IpEvent, request: Request): Promise<void> {
  try {
    const w = whereFrom(request);
    const hash = await ipFingerprint(env as unknown as Env, w.ip);
    await env.DB.prepare("INSERT INTO studio_ips (user_id, event, ip, ip_hash, country, region, city, asn, as_org, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(userId, event, w.ip, hash, w.country, w.region, w.city, w.asn, w.asOrg, w.ua).run();
  } catch (e) {
    console.error("studio ip record", e instanceof Error ? e.message : e);
  }
}

/** Deletes the rows older than the retention window (the cron, once an hour). */
export async function pruneIps(env: StudioEnv, days = IP_RETENTION_DAYS): Promise<number> {
  const r = await env.DB.prepare("DELETE FROM studio_ips WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)").bind(`-${days} days`).run();
  return r.meta.changes ?? 0;
}
