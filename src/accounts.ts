import type { Env } from "./env";
import { hmacHex, safeEqual } from "./util";

/**
 * Anonymous accounts: no email, no password, nothing to remember. The account IS the string
 * "<userId>.<hmac>" signed with INTERNAL_SECRET. That single string is both the value of the kleo_id
 * cookie and the human-pasteable "Kleo key", so bringing an account to another browser needs no lookup,
 * no extra column and no migration.
 *
 * Rotating INTERNAL_SECRET therefore invalidates every cookie and every Kleo key at once: everybody is
 * logged out and the only way back in is a brand-new account (written down in DEPLOY.md).
 */

export const ACCOUNT_COOKIE = "kleo_id";
/** About 400 days, which is also the longest a browser keeps a cookie: asking for more buys nothing. */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
/** Half of the SHA-256 hex digest: 128 bits of signature, still short enough to be retyped by hand. */
const SIG_LEN = 32;

export const makeHandle = async (env: Env, userId: string): Promise<string> =>
  `${userId}.${(await hmacHex(env.INTERNAL_SECRET, `kleo-id:${userId}`)).slice(0, SIG_LEN)}`;

/** The user id inside a handle, or null if the string was tampered with, truncated or never signed by us. */
export async function verifyHandle(env: Env, value: string | null | undefined): Promise<string | null> {
  const handle = (value ?? "").trim();
  const dot = handle.indexOf(".");
  if (dot <= 0) return null;
  const userId = handle.slice(0, dot);
  // The id only ever reaches an HMAC message from here, but a shape check keeps rubbish out of the hash.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return null;
  return safeEqual(handle, await makeHandle(env, userId)) ? userId : null;
}

/** The raw (still unverified) kleo_id value out of a Cookie header, e.g. "other=1; kleo_id=u_ab.cd12". */
export function cookieHandle(header: string | null | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === ACCOUNT_COOKIE) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** SameSite=Lax is right: the client arrives by a top-level GET navigation and the form POST is same-site. */
export const accountCookie = (handle: string): string =>
  `${ACCOUNT_COOKIE}=${handle}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;

/** Rate-limit key for one visitor: the address is hashed with INTERNAL_SECRET and never stored or logged raw. */
export const signupRateKey = (env: Env, ip: string | null | undefined): Promise<string> =>
  hmacHex(env.INTERNAL_SECRET, `rl:${ip ?? "unknown"}`);

/**
 * Optional bot check, one POST to Cloudflare. Like src/notify.ts with RESEND_API_KEY, an unset TURNSTILE_SECRET
 * means "skip it": the code ships now and starts checking the day the widget exists (Phase 2). Set the secret only
 * once the widget is on the sign-in page, or every sign-in fails a check nobody can pass.
 */
export async function verifyTurnstile(env: Env, token: string, ip: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    return ((await r.json()) as { success?: boolean }).success === true;
  } catch {
    return false; // the checker is the door: if it cannot answer, nobody new gets in
  }
}
