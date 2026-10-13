/**
 * KLEO STUDIO — ACCOUNTS. A Studio account IS a Kleo account: the same `users` row, the same credits, the same
 * payments as the MCP server. What Studio adds is a way to sign in that a person can remember:
 *
 *   e-mail + password   studio_logins (provider 'password', subject = the e-mail), PBKDF2 (session.ts)
 *   Google              studio_logins (provider 'google', subject = Google's `sub`); on only when GOOGLE_CLIENT_ID and
 *                       GOOGLE_CLIENT_SECRET are set
 *   Kleo key            the "<userId>.<sig>" key the MCP sign-in page shows (src/accounts.ts verifyHandle): someone who
 *                       already uses Kleo in Claude or ChatGPT brings that account, credits included, and may then
 *                       add an e-mail and password to it
 *
 * A new account starts with FREE_CREDITS (5) and goes through the same daily caps as the MCP sign-in page
 * (createUserIfUnderCaps: per day, per hashed address), so Studio is no side door around them.
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { createUserIfUnderCaps, getUser, getUserByEmail, audit } from "../db.ts";
import { verifyHandle, ipFingerprint, verifyTurnstile, makeHandle } from "../accounts.ts";
import { rid } from "../util.ts";
import { addLogin, getLogin, loginsOf, touchLogin } from "./store.ts";
import { EMAIL_RE, checkPassword, hashPassword, makeSession, normalizeEmail, passwordProblem, readCookie, safeEqual, sessionCookie } from "./session.ts";
import { StudioError } from "./generate.ts";

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const int = (v: string | undefined, d: number): number => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : d; };

export const googleEnabled = (env: StudioEnv): boolean => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/** Sets the session cookie for an account on a JSON answer. */
export async function signedIn(env: StudioEnv, userId: string, body: unknown = { ok: true }): Promise<Response> {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8", "set-cookie": sessionCookie(await makeSession(env.INTERNAL_SECRET, userId)) },
  });
}

/** Creates a brand-new Kleo account for a person who signs up in Studio. */
async function newAccount(env: StudioEnv, email: string | null, ip: string | null): Promise<string> {
  const id = rid("u", 12);
  const ipHash = await ipFingerprint(asEnv(env), ip);
  // users.email is UNIQUE and NOT NULL: a real address when we have one, the MCP server's synthetic one otherwise.
  const r = await createUserIfUnderCaps(asEnv(env),
    { id, email: email ?? `${id}@anon.kleo.invalid`, credits: Math.max(0, int(env.FREE_CREDITS, 5)), ipHash },
    { perDay: int(env.MAX_NEW_USERS_PER_DAY, 150), perAddressDay: int(env.MAX_NEW_USERS_PER_IP_DAY, 5) });
  if (r.verdict === "day_full") throw new StudioError("Kleo is full for new accounts today. Please come back tomorrow.", 429, "day_full");
  if (r.verdict === "address_full") throw new StudioError("Too many new accounts from this connection today. Please try again tomorrow.", 429, "address_full");
  await env.DB.prepare("UPDATE users SET src = COALESCE(src, 'studio') WHERE id = ?").bind(id).run().catch(() => undefined);
  await audit(asEnv(env), id, null, "user.created", { via: "studio", credits: int(env.FREE_CREDITS, 5) });
  return id;
}

export async function signUp(env: StudioEnv, body: { email?: string; password?: string; turnstile?: string }, ip: string | null): Promise<string> {
  const email = normalizeEmail(String(body.email ?? ""));
  const password = String(body.password ?? "");
  if (!EMAIL_RE.test(email)) throw new StudioError("That e-mail doesn't look right.");
  const bad = passwordProblem(password);
  if (bad) throw new StudioError(bad);
  if (!(await verifyTurnstile(asEnv(env), String(body.turnstile ?? ""), ip))) throw new StudioError("Please complete the check and try again.", 400, "turnstile");
  if (await getLogin(env, "password", email)) throw new StudioError("You already have an account with this e-mail. Sign in instead.", 409, "exists");
  // The same address may already be on a Google sign-in: one person, one account.
  const google = (await env.DB.prepare("SELECT user_id FROM studio_logins WHERE provider = 'google' AND email = ? LIMIT 1").bind(email).first<{ user_id: string }>())?.user_id;
  if (google) throw new StudioError("This e-mail signs in with Google. Use “Continue with Google”.", 409, "use_google");
  const existing = await getUserByEmail(asEnv(env), email);
  const userId = existing ? null : await newAccount(env, email, ip);
  if (!userId) throw new StudioError("You already have an account with this e-mail. Sign in instead.", 409, "exists");
  if (!(await addLogin(env, { provider: "password", subject: email, userId, email, secret: await hashPassword(password) }))) {
    throw new StudioError("You already have an account with this e-mail. Sign in instead.", 409, "exists");
  }
  return userId;
}

export async function signIn(env: StudioEnv, body: { email?: string; password?: string }): Promise<string> {
  const email = normalizeEmail(String(body.email ?? ""));
  const login = await getLogin(env, "password", email);
  // The same answer for an unknown address and a wrong password: the page must not reveal who has an account.
  const ok = login ? await checkPassword(String(body.password ?? ""), login.secret) : (await hashPassword("x"), false);
  if (!login || !ok) throw new StudioError("Wrong e-mail or password.", 401, "wrong");
  await touchLogin(env, "password", email);
  return login.user_id;
}

/** Signs in with the Kleo key from the MCP server's sign-in page. */
export async function signInWithKey(env: StudioEnv, key: string): Promise<string> {
  const userId = await verifyHandle(asEnv(env), key.trim());
  if (!userId || !(await getUser(asEnv(env), userId))) throw new StudioError("That Kleo key isn't valid.", 401, "wrong_key");
  await audit(asEnv(env), userId, null, "studio.key_signin", {});
  return userId;
}

/** Adds an e-mail and password to an account that has none (an MCP account brought in with its key). */
export async function addPassword(env: StudioEnv, userId: string, body: { email?: string; password?: string }): Promise<void> {
  const email = normalizeEmail(String(body.email ?? ""));
  if (!EMAIL_RE.test(email)) throw new StudioError("That e-mail doesn't look right.");
  const bad = passwordProblem(String(body.password ?? ""));
  if (bad) throw new StudioError(bad);
  if ((await loginsOf(env, userId)).some((l) => l.provider === "password")) throw new StudioError("This account already has a password.", 409, "exists");
  if (!(await addLogin(env, { provider: "password", subject: email, userId, email, secret: await hashPassword(String(body.password)) }))) {
    throw new StudioError("This e-mail is already used by another account.", 409, "taken");
  }
  await env.DB.prepare("UPDATE users SET contact_email = COALESCE(contact_email, ?) WHERE id = ?").bind(email, userId).run().catch(() => undefined);
}

/** What the page shows about the signed-in person. */
export async function me(env: StudioEnv, userId: string): Promise<Record<string, unknown> | null> {
  const user = await getUser(asEnv(env), userId);
  if (!user) return null;
  const logins = await loginsOf(env, userId);
  const email = logins.find((l) => l.email)?.email ?? (user.email.endsWith("@anon.kleo.invalid") ? null : user.email);
  return {
    id: user.id, email, credits: user.credits,
    methods: logins.map((l) => l.provider),
    kleoKey: await makeHandle(asEnv(env), user.id),
    mcpUrl: `${env.PUBLIC_URL.replace(/\/+$/, "")}/mcp`,
  };
}

// ── Google ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const STATE_COOKIE = "kleo_gstate";

export function googleStart(env: StudioEnv, origin: string): Response {
  const state = rid("st", 16);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", `${origin}/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return new Response(null, {
    status: 302,
    headers: { location: url.toString(), "set-cookie": `${STATE_COOKIE}=${state}; Path=/auth/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax` },
  });
}

/** Google's answer: code → id_token (read straight from Google over TLS with our secret, so it needs no signature check). */
export async function googleCallback(env: StudioEnv, request: Request, origin: string): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const saved = readCookie(request.headers.get("cookie"), STATE_COOKIE) ?? "";
  const back = (q: string) => new Response(null, { status: 302, headers: { location: `/?${q}`, "set-cookie": `${STATE_COOKIE}=; Path=/auth/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  if (!state || !safeEqual(state, saved)) return back("signin_error=state");
  const code = url.searchParams.get("code");
  if (!code) return back("signin_error=cancelled");
  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: `${origin}/auth/google/callback`, grant_type: "authorization_code" }),
  }).then((r) => r.json() as Promise<{ id_token?: string }>).catch(() => ({} as { id_token?: string }));
  const claims = decodeJwt(tok.id_token ?? "");
  if (!claims?.sub || claims.aud !== env.GOOGLE_CLIENT_ID) return back("signin_error=google");
  const email = claims.email && claims.email_verified ? normalizeEmail(String(claims.email)) : null;
  let userId = (await getLogin(env, "google", String(claims.sub)))?.user_id ?? null;
  if (!userId && email) {
    // The same verified address already signs in with a password: same person, same account.
    userId = (await getLogin(env, "password", email))?.user_id ?? (await getUserByEmail(asEnv(env), email))?.id ?? null;
  }
  try {
    if (!userId) userId = await newAccount(env, email, request.headers.get("cf-connecting-ip"));
  } catch (e) {
    return back(`signin_error=${encodeURIComponent(e instanceof StudioError ? e.code : "error")}`);
  }
  await addLogin(env, { provider: "google", subject: String(claims.sub), userId, email, secret: null });
  await touchLogin(env, "google", String(claims.sub));
  return new Response(null, {
    status: 302,
    headers: [["location", "/"], ["set-cookie", sessionCookie(await makeSession(env.INTERNAL_SECRET, userId))],
      ["set-cookie", `${STATE_COOKIE}=; Path=/auth/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax`]],
  });
}

function decodeJwt(t: string): Record<string, any> | null {
  const part = t.split(".")[1];
  if (!part) return null;
  try { return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))); } catch { return null; }
}
