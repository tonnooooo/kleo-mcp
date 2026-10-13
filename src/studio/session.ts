/**
 * KLEO STUDIO — SESSIONS, PASSWORDS AND SIGNED LINKS.
 *
 * The session is a cookie `__Host-kleo_studio=<userId>.<exp>.<epoch>.<sig>` signed with INTERNAL_SECRET (the same
 * secret that signs the MCP account handle, src/accounts.ts, so one rotation logs everybody out of both). Unlike the
 * handle it expires: a stolen Studio cookie is worth 60 days at most. The epoch (users.studio_epoch, checked on every
 * request by the router) makes it revocable: a password reset, "sign out everywhere", or an e-mail taken back from
 * an account that only claimed it bumps the epoch and every older cookie stops working (14 October 2026).
 * The `__Host-` prefix pins the cookie to this exact host over HTTPS with Path=/: no sibling *.kleooai.com host can
 * set or shadow it.
 *
 * Passwords are PBKDF2-SHA256 with a random 16-byte salt and 100 000 iterations — the most Cloudflare Workers allow —
 * stored as "pbkdf2$<iterations>$<salt b64>$<hash b64>".
 *
 * Every state-changing API call must carry the header `X-Kleo: 1`. A cross-site page cannot add a custom header
 * without a CORS preflight, and Studio answers no preflight, so the cookie alone never moves credits.
 *
 * Pure WebCrypto (no Env type at runtime), so the tests import it under Node's type stripping.
 */

export const SESSION_COOKIE = "__Host-kleo_studio";
export const SESSION_DAYS = 60;
const SIG_LEN = 32;
const enc = new TextEncoder();

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const sessionMessage = (userId: string, exp: string | number, epoch: string | number) => `kleo-studio-session:${userId}:${exp}:${epoch}`;

export async function makeSession(secret: string, userId: string, nowMs = Date.now(), epoch = 0): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + SESSION_DAYS * 86_400;
  return `${userId}.${exp}.${epoch}.${(await hmac(secret, sessionMessage(userId, exp, epoch))).slice(0, SIG_LEN)}`;
}

/** The account and epoch inside a session value, or null (tampered, expired, malformed). */
export async function readSessionFull(secret: string, value: string | null | undefined, nowMs = Date.now()): Promise<{ userId: string; epoch: number } | null> {
  const m = /^([A-Za-z0-9_-]{1,64})\.(\d{9,11})\.(\d{1,9})\.([0-9a-f]{32})$/.exec((value ?? "").trim());
  if (!m) return null;
  const [, userId, exp, epoch, sig] = m;
  if (Number(exp) * 1000 < nowMs) return null;
  return safeEqual(sig, (await hmac(secret, sessionMessage(userId, exp, epoch))).slice(0, SIG_LEN)) ? { userId, epoch: Number(epoch) } : null;
}

/** The user id inside a session value, or null. The router also checks the epoch against the account. */
export async function readSession(secret: string, value: string | null | undefined, nowMs = Date.now()): Promise<string | null> {
  return (await readSessionFull(secret, value, nowMs))?.userId ?? null;
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export const sessionCookie = (value: string): string =>
  `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_DAYS * 86_400}; HttpOnly; Secure; SameSite=Lax`;
export const clearSessionCookie = (): string => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const ITERATIONS = 100_000;
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}

export async function checkPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const m = /^pbkdf2\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored ?? "");
  if (!m) return false;
  const got = b64(await pbkdf2(password, unb64(m[2]), Number(m[1])));
  return safeEqual(got, m[3]);
}

/** Why a password is refused, or null when it is fine. Short rules a person can follow on a phone. */
export function passwordProblem(p: string): string | null {
  if (p.length < 8) return "Use at least 8 characters.";
  if (p.length > 200) return "That password is too long.";
  return null;
}

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
export const normalizeEmail = (s: string): string => s.trim().toLowerCase();

/**
 * A signed, time-limited link to a stored file (a person's upload or a finished clip), for the ones who cannot
 * carry the cookie: the video provider fetching a first frame, or a friend opening a shared clip.
 */
export async function signPath(secret: string, path: string, ttlSeconds: number, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const sig = (await hmac(secret, `kleo-studio-link:${path}:${exp}`)).slice(0, SIG_LEN);
  return `${path}?exp=${exp}&sig=${sig}`;
}

export async function checkSignedPath(secret: string, path: string, exp: string | null, sig: string | null, nowMs = Date.now()): Promise<boolean> {
  const e = Number(exp ?? 0);
  if (!e || e * 1000 < nowMs || !sig) return false;
  return safeEqual(sig, (await hmac(secret, `kleo-studio-link:${path}:${e}`)).slice(0, SIG_LEN));
}
