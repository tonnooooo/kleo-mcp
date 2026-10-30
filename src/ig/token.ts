/**
 * KLEO INSTAGRAM PUBLISHER — THE TOKEN.
 *
 * The owner pastes a long-lived Instagram User token (60 days, from the Meta app's "Generate token") into the Worker
 * secret IG_ACCESS_TOKEN once. Instagram renews such a token on request when it is at least 24 hours old and not
 * expired (GET graph.instagram.com/refresh_access_token, grant_type=ig_refresh_token); a token never renewed dies after
 * 60 days, and only a new login brings it back. A Worker cannot rewrite its own secrets, so the renewed token lives in
 * D1 (ig_token), sealed with AES-GCM under IG_TOKEN_KEY (sealKey, src/key-overrides.ts): a session that dumps the
 * table sees no token. The row keeps a fingerprint of the secret it grew from, so a token the owner pastes again wins
 * over the renewed one. Without IG_TOKEN_KEY nothing is renewed, and the owner hears about it ten days before the end.
 *
 * A Facebook Login token (loginOf, src/ig/graph.ts) is a system user's token from the business portfolio "Kleo": it
 * never expires and has nothing to renew. Its row only remembers the secret's fingerprint, and warned_at then paces the
 * e-mail sent when Meta refuses the token (refusedAlarm): once a day, and again at once for a newly pasted token.
 */
import { openKey, sealKey } from "../key-overrides.ts";
import { loginOf, redact, refreshToken, type Fetcher } from "./graph.ts";

export const TOKEN_SCHEMA = `CREATE TABLE IF NOT EXISTS ig_token (
    id INTEGER PRIMARY KEY CHECK (id = 1), sealed TEXT, seed TEXT NOT NULL, refreshed_at TEXT NOT NULL, expires_at TEXT,
    tried_at TEXT, note TEXT, warned_at TEXT)`;

/** Renewed once a week: the token always has more than 50 days left. */
export const RENEW_AFTER_DAYS = 7;
const RETRY_HOURS = 24;
const LIFE_DAYS = 60;
const WARN_DAYS = 10;
const HOUR = 3_600_000, DAY = 24 * HOUR;
const NAME = "IG_ACCESS_TOKEN";

export interface TokenEnv { DB: D1Database; IG_ACCESS_TOKEN?: string; IG_TOKEN_KEY?: string }
interface Row { sealed: string | null; seed: string; refreshed_at: string; expires_at: string | null; tried_at: string | null; note: string | null; warned_at: string | null }
export interface TokenNow { token: string; renewed: boolean; refreshedAt: string; expiresAt: string }

async function fingerprint(secret: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`kleo-ig-seed:${secret}`));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const readRow = (env: TokenEnv) =>
  env.DB.prepare("SELECT sealed, seed, refreshed_at, expires_at, tried_at, note, warned_at FROM ig_token WHERE id = 1").first<Row>();
/** When the token dies: Meta's own expires_in after a renewal, else 60 days from when the secret was first seen. */
const lifeEnd = (r: { refreshed_at: string; expires_at: string | null }): string =>
  r.expires_at ?? new Date(Date.parse(r.refreshed_at) + LIFE_DAYS * DAY).toISOString();

async function opened(env: TokenEnv, r: Row): Promise<string | null> {
  if (!r.sealed || !env.IG_TOKEN_KEY) return null;
  try { return await openKey(env.IG_TOKEN_KEY, NAME, r.sealed); } catch { return null; }
}

/** The token to use now: the renewed one while it grew from the secret that is set, else the secret itself. */
export async function tokenNow(env: TokenEnv, nowMs: number): Promise<TokenNow | null> {
  const secret = (env.IG_ACCESS_TOKEN ?? "").trim();
  const r = await readRow(env);
  if (secret) {
    const seed = await fingerprint(secret);
    if (r && r.seed === seed) {
      const renewed = await opened(env, r);
      return { token: renewed ?? secret, renewed: renewed !== null, refreshedAt: r.refreshed_at, expiresAt: lifeEnd(r) };
    }
    // The first token, or one the owner pasted again: a new line of renewals starts from it.
    const at = new Date(nowMs).toISOString();
    await env.DB.prepare(`INSERT INTO ig_token (id, sealed, seed, refreshed_at) VALUES (1, NULL, ?, ?)
        ON CONFLICT (id) DO UPDATE SET sealed = NULL, seed = excluded.seed, refreshed_at = excluded.refreshed_at,
        expires_at = NULL, tried_at = NULL, note = NULL, warned_at = NULL`).bind(seed, at).run();
    return { token: secret, renewed: false, refreshedAt: at, expiresAt: lifeEnd({ refreshed_at: at, expires_at: null }) };
  }
  const renewed = r ? await opened(env, r) : null;
  return r && renewed ? { token: renewed, renewed: true, refreshedAt: r.refreshed_at, expiresAt: lifeEnd(r) } : null;
}

/** Renews the token once it is RENEW_AFTER_DAYS old, at most once a day while Meta refuses: a line for the log, or null. */
export async function renewIfDue(env: TokenEnv, nowMs: number, fetcher: Fetcher): Promise<string | null> {
  // Asked every minute even with nothing to renew: it records a newly pasted secret, whose 60 days start counting.
  const now = await tokenNow(env, nowMs);
  if (!now || loginOf(now.token) === "facebook") return null;
  const r = await readRow(env);
  if (!r || !env.IG_TOKEN_KEY) return null;
  if (nowMs - Date.parse(r.refreshed_at) < RENEW_AFTER_DAYS * DAY) return null;
  if (r.tried_at && nowMs - Date.parse(r.tried_at) < RETRY_HOURS * HOUR) return null;
  const at = new Date(nowMs).toISOString();
  // One isolate renews: two at once would each get a token and keep only one.
  const claim = await env.DB.prepare("UPDATE ig_token SET tried_at = ? WHERE id = 1 AND seed = ? AND tried_at IS ?").bind(at, r.seed, r.tried_at).run();
  if (claim.meta.changes !== 1) return null;
  try {
    const fresh = await refreshToken(now.token, fetcher);
    const sealed = await sealKey(env.IG_TOKEN_KEY, NAME, fresh.token);
    const until = new Date(nowMs + fresh.expiresIn * 1000).toISOString();
    await env.DB.prepare("UPDATE ig_token SET sealed = ?, refreshed_at = ?, expires_at = ?, tried_at = NULL, note = NULL, warned_at = NULL WHERE id = 1 AND seed = ?")
      .bind(sealed, at, until, r.seed).run();
    return `token renewed, valid until ${until}`;
  } catch (e) {
    const why = redact(e instanceof Error ? e.message : String(e), [now.token, env.IG_ACCESS_TOKEN]);
    await env.DB.prepare("UPDATE ig_token SET note = ? WHERE id = 1").bind(why).run();
    return `token renewal failed: ${why}`;
  }
}

/** Ten days before the token dies, once a day: what to tell the owner, or null. A Facebook Login token never dies. */
export async function expiryWarning(env: TokenEnv, nowMs: number): Promise<string | null> {
  if (loginOf(env.IG_ACCESS_TOKEN ?? "") === "facebook") return null;
  const r = await readRow(env);
  if (!r) return null;
  const end = Date.parse(lifeEnd(r));
  if (end - nowMs > WARN_DAYS * DAY) return null;
  if (r.warned_at && nowMs - Date.parse(r.warned_at) < RETRY_HOURS * HOUR) return null;
  const claim = await env.DB.prepare("UPDATE ig_token SET warned_at = ? WHERE id = 1 AND warned_at IS ?").bind(new Date(nowMs).toISOString(), r.warned_at).run();
  if (claim.meta.changes !== 1) return null;
  const why = !env.IG_TOKEN_KEY ? "IG_TOKEN_KEY is not set, so it is never renewed" : r.note ? `renewing it fails: ${r.note}` : "it has not been renewed";
  return end <= nowMs ? `The Instagram token has expired (${why}).` : `The Instagram token expires on ${new Date(end).toISOString().slice(0, 10)} (${why}).`;
}

/** Meta refused the Facebook Login token: true when the owner should hear about it now (once a day per pasted token). */
export async function refusedAlarm(env: TokenEnv, nowMs: number): Promise<boolean> {
  const r = await readRow(env);
  if (!r) return false;
  if (r.warned_at && nowMs - Date.parse(r.warned_at) < RETRY_HOURS * HOUR) return false;
  const claim = await env.DB.prepare("UPDATE ig_token SET warned_at = ? WHERE id = 1 AND warned_at IS ?").bind(new Date(nowMs).toISOString(), r.warned_at).run();
  return claim.meta.changes === 1;
}
