/**
 * KLEO STUDIO — ACCOUNTS. A Studio account IS a Kleo account: the same `users` row, the same credits, the same
 * payments as the MCP server. What Studio adds is a way to sign in that a person can remember:
 *
 *   e-mail + password   studio_logins (provider 'password', subject = the e-mail), PBKDF2 (session.ts)
 *   Google, Microsoft,  studio_logins (provider 'google' | 'microsoft' | 'apple', subject = the provider's `sub`); each
 *   Apple               one is on only when its keys are set (SOCIAL below)
 *   e-mail code         studio_logins (provider 'email', subject = the e-mail): a six-digit code mailed to the
 *                       address, for the browsers inside Facebook, Instagram and TikTok where Google refuses to
 *                       sign in (see "Sign in with an e-mail code" below)
 *   Kleo key            the "<userId>.<sig>" key the MCP sign-in page shows (src/accounts.ts verifyHandle): someone who
 *                       already uses Kleo in Claude or ChatGPT brings that account, credits included, and may then
 *                       add an e-mail and password to it
 *
 * A new account starts with FREE_CREDITS (5) and goes through the same daily caps as the MCP sign-in page
 * (createUserIfUnderCaps: per day, per hashed address), so Studio is no side door around them.
 *
 * ONE GIFT PER PERSON (15 October 2026, src/abuse.ts): the gift goes to one account per connection, browser and inbox;
 * a throwaway mailbox is refused; and once Google sign-in is on, new accounts are opened with Google only
 * (STUDIO_SIGNUP, default "google"): a Google account is a real person's, an e-mail typed here was never checked.
 * Existing e-mail accounts keep signing in with their password.
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { createUserIfUnderCaps, getUser, getUserByEmail, audit, countAuditTodayForUser } from "../db.ts";
import { emailConfigured, sendEmail } from "../email.ts";
import { verifyHandle, ipFingerprint, verifyTurnstile, makeHandle, rotateKey } from "../accounts.ts";
import { hmacHex, rid } from "../util.ts";
import { addLogin, getLogin, loginsOf, touchLogin } from "./store.ts";
import { EMAIL_RE, checkPassword, hashPassword, makeSession, normalizeEmail, passwordProblem, readCookie, safeEqual, sessionCookie } from "./session.ts";
import { StudioError, isAdmin } from "./generate.ts";
import { adminPasswordProblem } from "./admin-auth.ts";
import { canonicalEmail, giftBlocker, giftCookie, mailDomainOk, type Visitor } from "../abuse.ts";
import { recordIp } from "./ips.ts";
import { arrivalOf, clearTouchCookie, recordAttribution, type Arrival } from "./attribution.ts";
import { deliver, type Mail } from "./onboarding.ts";

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const int = (v: string | undefined, d: number): number => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : d; };

export const googleEnabled = (env: StudioEnv): boolean => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
/** How new accounts are opened: "google" (Google only, once it is configured) or "all" (e-mail and password too). */
export const signupMode = (env: StudioEnv): "google" | "all" =>
  googleEnabled(env) && (env.STUDIO_SIGNUP ?? "google").trim().toLowerCase() !== "all" ? "google" : "all";
export const microsoftEnabled = (env: StudioEnv): boolean => !!(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);

/** The account's session epoch (users.studio_epoch): a session made under an older one is no longer valid. */
export async function epochOf(env: StudioEnv, userId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT studio_epoch FROM users WHERE id = ?").bind(userId).first<{ studio_epoch: number | null }>().catch(() => null);
  return Number(r?.studio_epoch ?? 0) || 0;
}

/** Signs the account out of every browser and phone at once (a password reset, "sign out everywhere"). */
export async function endAllSessions(env: StudioEnv, userId: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET studio_epoch = COALESCE(studio_epoch, 0) + 1 WHERE id = ?").bind(userId).run();
}

/**
 * Signs out every old anonymous account merged into this one (users.merged_into, src/connect.ts). Called wherever the
 * account's key is retired (rotateKey retires theirs with it). Since 27 October 2026 a merged account opens no
 * session at all (accountMerged); this stays as a second lock.
 */
export async function endMergedSessions(env: StudioEnv, userId: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET studio_epoch = COALESCE(studio_epoch, 0) + 1 WHERE merged_into = ?").bind(userId).run();
}

const newSession = async (env: StudioEnv, userId: string): Promise<string> =>
  sessionCookie(await makeSession(env.INTERNAL_SECRET, userId, Date.now(), await epochOf(env, userId)));

/** What a person reads when the owner closed their account from the console (src/studio/admin.ts). */
export const BLOCKED_SENTENCE = "This account is closed. If you think this is a mistake, write to hello@kleooai.com.";
/** True while the owner keeps the account closed (users.blocked_at): no session opens it, and no sign-in. */
export async function accountBlocked(env: StudioEnv, userId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT blocked_at FROM users WHERE id = ?").bind(userId).first<{ blocked_at: string | null }>().catch(() => null);
  return !!r?.blocked_at;
}

/** What a person reads when they try to open an old anonymous account that was merged into another one. */
export const MERGED_SENTENCE = "This account is now part of another Kleo account. Sign in to that account with Google or your e-mail instead.";
/**
 * True for an old anonymous account merged into another one (users.merged_into, src/connect.ts mergeAnonymous). Its
 * credits and films moved with the merge, so it opens no session and no sign-in (27 October 2026, the security
 * review): a session kept on it could otherwise add a password or a Google sign-in and connect an assistant that,
 * through merged_into, acts on the account it went into, out of reach of that account's own controls.
 */
export async function accountMerged(env: StudioEnv, userId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT merged_into FROM users WHERE id = ?").bind(userId).first<{ merged_into: string | null }>().catch(() => null);
  return !!r?.merged_into;
}

/** Sets the session cookie for an account on a JSON answer. */
export async function signedIn(env: StudioEnv, userId: string, body: unknown = { ok: true }): Promise<Response> {
  if (await accountBlocked(env, userId)) throw new StudioError(BLOCKED_SENTENCE, 403, "blocked");
  if (await accountMerged(env, userId)) throw new StudioError(MERGED_SENTENCE, 403, "merged");
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8", "set-cookie": await newSession(env, userId) },
  });
}

/**
 * Creates a brand-new Kleo account for a person who signs up in Studio; answers it with the credits it was given. `from`
 * is where the browser came from (src/studio/attribution.ts): it becomes the account's user_attribution row.
 */
async function newAccount(env: StudioEnv, email: string | null, v: Visitor, from: Arrival | null = null): Promise<{ id: string; gifted: number }> {
  const id = rid("u", 12);
  const ipHash = await ipFingerprint(asEnv(env), v.ip);
  const blocker = giftBlocker(v);
  // users.email is UNIQUE and NOT NULL: a real address when we have one, the MCP server's synthetic one otherwise.
  const r = await createUserIfUnderCaps(asEnv(env),
    { id, email: email ?? `${id}@anon.kleo.invalid`, credits: Math.max(0, int(env.FREE_CREDITS, 5)), ipHash, gift: !blocker, emailCanon: email ? canonicalEmail(email) : null },
    { perDay: int(env.MAX_NEW_USERS_PER_DAY, 150), perAddressDay: int(env.MAX_NEW_USERS_PER_IP_DAY, 5) });
  if (r.verdict === "day_full") throw new StudioError("Kleo is full for new accounts today. Please come back tomorrow.", 429, "day_full");
  if (r.verdict === "address_full") throw new StudioError("Too many new accounts from this connection today. Please try again tomorrow.", 429, "address_full");
  if (r.verdict === "address_blocked") throw new StudioError("No new accounts can be opened from this connection for now. Sign in to the account you already have.", 403, "address_blocked");
  await env.DB.prepare("UPDATE users SET src = COALESCE(src, 'studio') WHERE id = ?").bind(id).run().catch(() => undefined);
  const gifted = r.gifted ?? 0;
  await audit(asEnv(env), id, null, "user.created", { via: "studio", credits: gifted, ip: ipHash, ...(gifted ? {} : { no_gift: blocker ?? "address" }) });
  await recordAttribution(env, id, from);
  return { id, gifted };
}

export async function signUp(env: StudioEnv, body: { email?: string; password?: string; turnstile?: string }, v: Visitor, from: Arrival | null = null): Promise<{ userId: string; gifted: number }> {
  if (signupMode(env) === "google") throw new StudioError("New Kleo accounts are opened with Google. Use “Continue with Google”.", 403, "use_google");
  const email = normalizeEmail(String(body.email ?? ""));
  const password = String(body.password ?? "");
  if (!EMAIL_RE.test(email)) throw new StudioError("That e-mail doesn't look right.");
  const bad = passwordProblem(password);
  if (bad) throw new StudioError(bad);
  if (!(await verifyTurnstile(asEnv(env), String(body.turnstile ?? ""), v.ip))) throw new StudioError("Please complete the check and try again.", 400, "turnstile");
  if (await getLogin(env, "password", email)) throw new StudioError("You already have an account with this e-mail. Sign in instead.", 409, "exists");
  // The same address may already be on a Google, Microsoft or Apple sign-in: one person, one account.
  const social = await env.DB.prepare(`SELECT provider FROM studio_logins WHERE provider IN (${SOCIAL_SQL}) AND email = ? LIMIT 1`).bind(email).first<{ provider: string }>();
  if (social) {
    const name = SOCIAL[social.provider as SocialKey]?.label ?? "Google";
    throw new StudioError(`This e-mail signs in with ${name}. Use “Continue with ${name}”.`, 409, `use_${social.provider}`);
  }
  // One inbox, one account: the same Gmail with dots or a "+tag" is the account it already has.
  if (await env.DB.prepare("SELECT 1 AS one FROM users WHERE email_canon = ? LIMIT 1").bind(canonicalEmail(email)).first()) {
    throw new StudioError("You already have an account with this e-mail. Sign in instead.", 409, "exists");
  }
  if (!(await mailDomainOk(email.slice(email.lastIndexOf("@") + 1)))) {
    throw new StudioError("Please use an e-mail address you keep: this one can't receive mail, or it is a throwaway mailbox.", 400, "email_domain");
  }
  const existing = await getUserByEmail(asEnv(env), email);
  const made = existing ? null : await newAccount(env, email, v, from);
  if (!made) throw new StudioError("You already have an account with this e-mail. Sign in instead.", 409, "exists");
  if (!(await addLogin(env, { provider: "password", subject: email, userId: made.id, email, secret: await hashPassword(password) }))) {
    throw new StudioError("You already have an account with this e-mail. Sign in instead.", 409, "exists");
  }
  return { userId: made.id, gifted: made.gifted };
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
  const keyId = await verifyHandle(asEnv(env), key.trim());
  const held = keyId ? await getUser(asEnv(env), keyId) as (Awaited<ReturnType<typeof getUser>> & { merged_into?: string | null }) | null : null;
  if (!keyId || !held) throw new StudioError("That Kleo key isn't valid.", 401, "wrong_key");
  // The key of an old connector account that was merged into another one (src/connect.ts mergeAnonymous) opens
  // nothing. It must never open the account it was merged into: that account's owner never held this key and none of
  // their controls (new Kleo key, password change, sign out everywhere) can retire it, so whoever kept the old key would
  // hold a permanent way into somebody else's account. Its credits and films moved with the merge; that account signs
  // in with its own sign-in.
  if (held.merged_into) {
    throw new StudioError("This Kleo key's account is now part of another Kleo account. Sign in to that account with Google or your e-mail instead.", 401, "merged_key");
  }
  await audit(asEnv(env), keyId, null, "studio.key_signin", {});
  return keyId;
}

/** An admin account's password follows the console's stricter rule (admin-auth.ts): 14 characters, not its e-mail or name. */
async function adminRule(env: StudioEnv, userId: string, password: string, email: string | null = null): Promise<void> {
  if (!isAdmin(env, userId)) return;
  const u = await env.DB.prepare("SELECT email, display_name FROM users WHERE id = ?").bind(userId).first<{ email: string; display_name: string | null }>();
  const login = (await loginsOf(env, userId)).find((l) => l.email)?.email ?? null;
  const bad = adminPasswordProblem(password, email ?? login ?? u?.email ?? null, u?.display_name ?? null);
  if (bad) throw new StudioError(bad, 400, "weak_password");
}

/** Adds an e-mail and password to an account that has none (an MCP account brought in with its key). */
export async function addPassword(env: StudioEnv, userId: string, body: { email?: string; password?: string }): Promise<void> {
  const email = normalizeEmail(String(body.email ?? ""));
  if (!EMAIL_RE.test(email)) throw new StudioError("That e-mail doesn't look right.");
  const bad = passwordProblem(String(body.password ?? ""));
  if (bad) throw new StudioError(bad);
  await adminRule(env, userId, String(body.password), email);
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
  const email = logins.find((l) => l.email)?.email ?? (user.email.endsWith("@anon.kleo.invalid") ? null : user.email)
    ?? ((user as unknown as { contact_email?: string | null }).contact_email ?? null);
  return {
    id: user.id, email, credits: user.credits,
    name: (user as unknown as { display_name?: string | null }).display_name ?? null, since: user.created_at,
    methods: logins.map((l) => l.provider),
    // The Kleo key is a credential (whoever holds it owns the account): it is handed out only on an explicit request
    // (kleoKeyOf), never in the answer every page load reads.
    mcpUrl: `${env.PUBLIC_URL.replace(/\/+$/, "")}/mcp`,
  };
}

// ── The account page (14 October 2026, the owner: "impostazioni profilo molto minime, fai come higgsfield") ─────────

/** The name shown in the app (users.display_name); empty clears it. */
export async function setName(env: StudioEnv, userId: string, raw: unknown): Promise<string | null> {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || null;
  await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(name, userId).run();
  return name;
}

/** Changes the password of an account that has one; every other session ends, this browser gets a new one. */
export async function changePassword(env: StudioEnv, userId: string, body: { current?: string; password?: string }): Promise<void> {
  const login = (await loginsOf(env, userId)).find((l) => l.provider === "password");
  const full = login ? await getLogin(env, "password", login.subject) : null;
  if (!full?.secret) throw new StudioError("This account has no password yet. Add one below.", 400, "no_password");
  if (!(await checkPassword(String(body.current ?? ""), full.secret))) throw new StudioError("Your current password isn't right.", 401, "wrong");
  const bad = passwordProblem(String(body.password ?? ""));
  if (bad) throw new StudioError(bad);
  await adminRule(env, userId, String(body.password), full.subject);
  await env.DB.prepare("UPDATE studio_logins SET secret = ? WHERE provider = 'password' AND subject = ?").bind(await hashPassword(String(body.password)), full.subject).run();
  await endAllSessions(env, userId);
  await audit(asEnv(env), userId, null, "studio.password_changed", {});
}

/** What the credits went on, and what was bought: the account page's two lists. */
export async function activity(env: StudioEnv, userId: string): Promise<{ usage: unknown[]; purchases: unknown[] }> {
  const usage = (await env.DB.prepare(`SELECT id, kind, model, credits, status, refunded, created_at, substr(prompt, 1, 90) AS prompt
      FROM studio_generations WHERE user_id = ? ORDER BY created_at DESC LIMIT 60`).bind(userId).all()).results;
  const purchases = (await env.DB.prepare(`SELECT credits, amount_cent, currency, status, at FROM payments
      WHERE user_id = ? AND amount_cent > 0 ORDER BY at DESC LIMIT 30`).bind(userId).all()).results;
  return { usage, purchases };
}

/**
 * Deletes the account's data for good: every creation and upload (rows and files), chats, sign-in methods; the account
 * row keeps only what the law and the books need (payments), with no address, no name and no credits. Sessions end and
 * the Kleo key is retired, so neither a browser nor an assistant can open it again.
 */
export async function deleteAccount(env: StudioEnv, userId: string, confirm: unknown): Promise<void> {
  if (String(confirm ?? "").trim().toUpperCase() !== "DELETE") throw new StudioError("Type DELETE to confirm.", 400, "confirm");
  const prefix = `studio/${userId}/`;
  for (let cursor: string | undefined, i = 0; i < 50; i++) {
    const page = await env.RENDERS.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.RENDERS.delete(keys);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM studio_generations WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM studio_uploads WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM studio_messages WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM studio_chats WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM studio_logins WHERE user_id = ?1 OR user_id IN (SELECT id FROM users WHERE merged_into = ?1)").bind(userId),
    // Where the account came from (attribution.ts): the privacy page promises it goes with the account.
    env.DB.prepare("DELETE FROM user_attribution WHERE user_id = ?").bind(userId),
    env.DB.prepare("UPDATE users SET email = ?, display_name = NULL, contact_email = NULL, credits = 0 WHERE id = ?").bind(`${userId}@deleted.kleo.invalid`, userId),
  ]);
  await endAllSessions(env, userId);
  await rotateKey(asEnv(env), userId);
  await endMergedSessions(env, userId);
  await audit(asEnv(env), userId, null, "studio.account_deleted", {});
}

/**
 * The account's Kleo key, on request. `fresh` retires the old one first (src/accounts.ts rotateKey) and with it every
 * way in the old key opened (14 October 2026, the review's second pass): the assistants connected with it (their OAuth
 * grants carry the key version they were made under, src/index.ts mcpApi) and every Studio session, one of which may
 * have been opened with the leaked key itself (/api/auth/key). The caller signs the asking browser in again.
 */
export async function kleoKeyOf(env: StudioEnv, userId: string, fresh = false): Promise<string> {
  if (!fresh) return makeHandle(asEnv(env), userId);
  const key = await rotateKey(asEnv(env), userId);
  await endAllSessions(env, userId);
  await endMergedSessions(env, userId);
  await audit(asEnv(env), userId, null, "studio.key_rotated", {});
  return key;
}

// ── Password reset ─────────────────────────────────────────────────────────────────────────────────────────────────
// The link carries "<userId>.<exp>.<sig>"; the signature covers the CURRENT password hash, so a link stops working
// the moment the password changes (used once, or reset another way). One hour, three mails per account per day.
const RESET_TTL_S = 3600;
const RESETS_PER_DAY = 3;

async function resetSig(env: StudioEnv, userId: string, exp: number, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.INTERNAL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`kleo-studio-reset:${userId}:${exp}:${secret}`));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const resetAvailable = (env: StudioEnv): boolean => emailConfigured(env as unknown as Env);

/**
 * Checks the request and answers the work to do in the background (ctx.waitUntil): the page gets the same answer, in
 * the same time, whether or not the address has an account.
 */
export function forgotPassword(env: StudioEnv, body: { email?: string }, origin: string): Promise<void> {
  if (!resetAvailable(env)) throw new StudioError("Password reset by e-mail is not on yet. Write to hello@kleooai.com and we'll help.", 503, "no_email");
  const email = normalizeEmail(String(body.email ?? ""));
  if (!EMAIL_RE.test(email)) throw new StudioError("That e-mail doesn't look right.");
  return sendResetLink(env, email, origin).catch((e) => console.error("studio reset mail", e instanceof Error ? e.message : e));
}

async function sendResetLink(env: StudioEnv, email: string, origin: string): Promise<void> {
  const login = await getLogin(env, "password", email);
  if (!login?.secret) return;
  if ((await countAuditTodayForUser(asEnv(env), login.user_id, "studio.reset_sent")) >= RESETS_PER_DAY) return;
  const exp = Math.floor(Date.now() / 1000) + RESET_TTL_S;
  const token = `${login.user_id}.${exp}.${await resetSig(env, login.user_id, exp, login.secret)}`;
  const sent = await sendEmail(asEnv(env), {
    to: email, subject: "Reset your Kleo password",
    text: `Someone (hopefully you) asked to reset the password of your Kleo account.\n\nChoose a new password here (the link works for one hour):\n${origin}/reset?t=${encodeURIComponent(token)}\n\nIf it wasn't you, ignore this e-mail: nothing changes.\n\nKleo`,
  });
  await audit(asEnv(env), login.user_id, null, "studio.reset_sent", { sent });
}

/** Sets the new password from a reset link; answers the account id (the person is signed in). */
export async function resetPassword(env: StudioEnv, body: { token?: string; password?: string }): Promise<string> {
  const m = /^([A-Za-z0-9_-]{1,64})\.(\d{9,11})\.([0-9a-f]{32})$/.exec(String(body.token ?? "").trim());
  const bad = () => new StudioError("This reset link is no longer valid. Ask for a new one.", 400, "bad_link");
  if (!m || Number(m[2]) * 1000 < Date.now()) throw bad();
  const login = (await loginsOf(env, m[1])).find((l) => l.provider === "password");
  const full = login ? await getLogin(env, "password", login.subject) : null;
  if (!full?.secret || !safeEqual(m[3], await resetSig(env, m[1], Number(m[2]), full.secret))) throw bad();
  const problem = passwordProblem(String(body.password ?? ""));
  if (problem) throw new StudioError(problem);
  await adminRule(env, m[1], String(body.password), full.subject);
  await env.DB.prepare("UPDATE studio_logins SET secret = ? WHERE provider = 'password' AND subject = ?").bind(await hashPassword(String(body.password)), full.subject).run();
  // Whoever had the old password may still hold a session: every one of them ends here (the new one is made after).
  // And the Kleo key is renewed (the review's second pass): with the password one could ask for the key and connect an
  // assistant with it, which then read the key back (kleo_account) and kept the account through any number of resets.
  // A new key ends those assistants' grants (src/index.ts mcpApi); the page tells the person to reconnect them.
  await endAllSessions(env, m[1]);
  await rotateKey(asEnv(env), m[1]);
  await endMergedSessions(env, m[1]);
  await audit(asEnv(env), m[1], null, "studio.reset_done", {});
  return m[1];
}

// ── Google and Microsoft ───────────────────────────────────────────────────────────────────────────────────────────
// OpenID Connect code flow. The id_token is read straight from the provider's token endpoint over TLS, in exchange for
// our client secret, so it needs no signature check (OIDC core 3.1.3.7); its audience must still be our client id.
//
// E-MAIL TRUST. An address links a social sign-in to an existing account only when the provider vouches for it:
// Google's `email_verified`, or a PERSONAL Microsoft account (consumer tenant), whose address is its verified sign-in
// name. A work or school Microsoft account's `email` claim can be set by that tenant's admin to anything (the
// "nOAuth" takeover), so it is shown but never used to find an account.
//
// CLAIMED vs VOUCHED (14 October 2026). An e-mail typed at sign-up (or added with a password) was never checked: anybody
// can sign up with somebody else's address before they arrive. So a vouched-for social sign-in joins an account by
// e-mail only when that account holds the address through another VOUCHED sign-in. An account that merely CLAIMS it
// (password login or users.email, never verified) is handed to the verified person, and the claimant is evicted: every
// sign-in of it goes, every session ends, the Kleo key is retired. The verified person comes in through Google or
// Microsoft from then on and keeps everything the account holds.
//
// USED ACCOUNTS TOO (25 October 2026, the owner, refused with his own old test account: "devi venire incontro al
// cliente"). Until today an account that had been used (a creation, an upload, a chat, a film or a payment) was never
// handed over: the person had to sign in with the password and connect Google from the account page, and someone who no
// longer knew that password (no reset e-mail is sent) was locked out of their own account. Two things changed since the
// rule was written: new accounts open with Google only (since 18 October, STUDIO_SIGNUP), so nobody can register a
// stranger's address with a password at sign-up any more; and the inbox's owner is who the address belongs to. Whoever
// typed an address that Google now vouches for is evicted either way, so a planted password never keeps a way in. What
// is still refused: an admin account (STUDIO_ADMINS), whose password and phone code open the console and must never be
// replaced by a Google sign-in; the person signs in with the password and connects Google from the account page.
//
// PKCE (S256) and a nonce bind the provider's answer to the browser that started the sign-in; the state cookie is
// `__Host-` (this host only, HTTPS, Path=/), so no sibling *.kleooai.com host can plant one.
//
// LINKING. A signed-in person can add Google or Microsoft to the account they are in (/auth/<p>?link=1). The account
// to link is read from the session cookie at the callback, never from the state cookie, so a forged state cannot
// attach a stranger's Google account to somebody else's Kleo account.
//
// APPLE (18 October 2026, the owner: "accedi con Apple"). The same code flow with three differences Apple imposes:
// its answer comes back as a form POST from appleid.apple.com (response_mode=form_post, required when asking for the
// e-mail), so the state cookie is SameSite=None or the browser would not send it with that POST; there is no PKCE, the
// state and the nonce bind the answer instead; and the client secret is a short JWT we sign with the .p8 key from
// the Apple developer account (ES256, appleClientSecret). Apple vouches for the e-mail it gives ("email_verified",
// sometimes the string "true"), including its "Hide My Email" relay address, which is one fixed address per person.

export type SocialKey = "google" | "microsoft" | "apple";
export const MS_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

interface Social {
  label: string;
  authorize: string;
  token: string;
  scope: string;
  id: (env: StudioEnv) => string | undefined;
  secret: (env: StudioEnv) => string | undefined;
  extra: Record<string, string>;
  /** The address the provider vouches for (may link accounts), or null. */
  verifiedEmail: (c: Record<string, any>) => string | null;
  /** Any address to show the person, verified or not. */
  shownEmail: (c: Record<string, any>) => string | null;
  /** The answer comes back as a cross-site form POST (Apple): no PKCE, a SameSite=None state cookie. */
  formPost?: boolean;
  /** A client secret made per sign-in instead of a fixed one (Apple's signed JWT). */
  mintSecret?: (env: StudioEnv) => Promise<string>;
}

const msEmail = (c: Record<string, any>): string | null => {
  const e = String(c.email ?? c.preferred_username ?? "").trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
};

export const SOCIAL: Record<SocialKey, Social> = {
  google: {
    label: "Google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    id: (env) => env.GOOGLE_CLIENT_ID, secret: (env) => env.GOOGLE_CLIENT_SECRET,
    extra: { prompt: "select_account" },
    verifiedEmail: (c) => (c.email && c.email_verified ? normalizeEmail(String(c.email)) : null),
    shownEmail: (c) => (c.email ? normalizeEmail(String(c.email)) : null),
  },
  apple: {
    label: "Apple",
    authorize: "https://appleid.apple.com/auth/authorize",
    token: "https://appleid.apple.com/auth/token",
    scope: "name email",
    id: (env) => env.APPLE_CLIENT_ID,
    secret: (env) => (env.APPLE_TEAM_ID && env.APPLE_KEY_ID ? env.APPLE_PRIVATE_KEY : undefined),
    mintSecret: (env) => appleClientSecret(env),
    extra: { response_mode: "form_post" },
    formPost: true,
    verifiedEmail: (c) => (c.email && (c.email_verified === true || c.email_verified === "true") ? normalizeEmail(String(c.email)) : null),
    shownEmail: (c) => (c.email ? normalizeEmail(String(c.email)) : null),
  },
  microsoft: {
    label: "Microsoft",
    // "common": personal Microsoft accounts (Outlook, Hotmail, Xbox) and work or school accounts.
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "openid email profile",
    id: (env) => env.MICROSOFT_CLIENT_ID, secret: (env) => env.MICROSOFT_CLIENT_SECRET,
    extra: { prompt: "select_account", response_mode: "query" },
    verifiedEmail: (c) => (c.tid === MS_CONSUMER_TENANT ? msEmail(c) : null),
    shownEmail: msEmail,
  },
};

export const socialEnabled = (env: StudioEnv, key: SocialKey): boolean => !!(SOCIAL[key].id(env) && SOCIAL[key].secret(env));
export const enabledSocial = (env: StudioEnv): SocialKey[] => (Object.keys(SOCIAL) as SocialKey[]).filter((k) => socialEnabled(env, k));
const SOCIAL_SQL = (Object.keys(SOCIAL) as SocialKey[]).map((k) => `'${k}'`).join(",");

const stateCookieName = (key: SocialKey) => `__Host-kleo_ostate_${key}`;
const stateSameSite = (key: SocialKey) => (SOCIAL[key].formPost ? "None" : "Lax");
const clearState = (key: SocialKey) => `${stateCookieName(key)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=${stateSameSite(key)}`;

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (n = 32): string => b64url(crypto.getRandomValues(new Uint8Array(n)));
const pkceChallenge = async (verifier: string): Promise<string> =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

/**
 * Apple's client secret: a JWT signed with the private key (.p8, PKCS#8 PEM) of a "Sign in with Apple" key, naming
 * the team, the key and the Services ID. Valid ten minutes: one is made for every sign-in, so nothing expires unseen.
 */
async function appleClientSecret(env: StudioEnv): Promise<string> {
  const pem = String(env.APPLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: "ES256", kid: env.APPLE_KEY_ID })}.${part({ iss: env.APPLE_TEAM_ID, iat: now, exp: now + 600, aud: "https://appleid.apple.com", sub: env.APPLE_CLIENT_ID })}`;
  // WebCrypto's ECDSA signature is already r||s, the form JWS wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function socialStart(env: StudioEnv, key: SocialKey, origin: string, link: boolean): Promise<Response> {
  const p = SOCIAL[key];
  const state = randomToken(18), verifier = randomToken(32), nonce = randomToken(18);
  const url = new URL(p.authorize);
  url.searchParams.set("client_id", p.id(env)!);
  url.searchParams.set("redirect_uri", `${origin}/auth/${key}/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", p.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  if (!p.formPost) {
    url.searchParams.set("code_challenge", await pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(p.extra)) url.searchParams.set(k, v);
  return new Response(null, {
    status: 302,
    headers: { location: url.toString(), "set-cookie": `${stateCookieName(key)}=${state}.${link ? "link" : "in"}.${verifier}.${nonce}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=${stateSameSite(key)}` },
  });
}

/** True when the account was never used: nothing made, uploaded, chatted, filmed or paid. */
async function untouched(env: StudioEnv, userId: string): Promise<boolean> {
  const r = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM studio_generations WHERE user_id = ?1) + (SELECT COUNT(*) FROM studio_uploads WHERE user_id = ?1)
    + (SELECT COUNT(*) FROM studio_chats WHERE user_id = ?1) + (SELECT COUNT(*) FROM jobs WHERE user_id = ?1)
    + (SELECT COUNT(*) FROM payments WHERE user_id = ?1) AS n`).bind(userId).first<{ n: number }>();
  return Number(r?.n ?? 1) === 0;
}

/**
 * Takes an untouched account away from whoever claimed its e-mail: every sign-in of it gone, sessions ended, key
 * retired — and with the key, every assistant the claimant connected (its grant carries the old key version, src/index.ts
 * mcpApi). Every sign-in, not only the password (the review's second pass): a claimant who had linked their own Google
 * or Microsoft account to it would otherwise sign straight back in. The verified person's sign-in is added right after.
 */
async function evictClaimant(env: StudioEnv, userId: string, provider: SocialKey | "email", used = false): Promise<void> {
  await env.DB.prepare("DELETE FROM studio_logins WHERE user_id = ?1 OR user_id IN (SELECT id FROM users WHERE merged_into = ?1)").bind(userId).run();
  await endAllSessions(env, userId);
  await rotateKey(asEnv(env), userId);
  await endMergedSessions(env, userId);
  await audit(asEnv(env), userId, null, "studio.email_claim_evicted", { provider, ...(used ? { used: true } : {}) });
}

/** The provider's answer: code, then id_token, then the account (found, linked or created), then the session. */
export async function socialCallback(env: StudioEnv, key: SocialKey, request: Request, origin: string, sessionUserId: string | null, v: Visitor): Promise<Response> {
  const p = SOCIAL[key];
  const url = new URL(request.url);
  // Apple answers with a form POST; the others with a redirect carrying the same fields in the query.
  const params = request.method === "POST" ? new URLSearchParams(await request.text().catch(() => "")) : url.searchParams;
  const state = params.get("state") ?? "";
  const [savedState, intent, verifier, nonce] = (readCookie(request.headers.get("cookie"), stateCookieName(key)) ?? "").split(".");
  const back = (q: string) => new Response(null, { status: 302, headers: { location: `/?${q}`, "set-cookie": clearState(key) } });
  if (!state || !savedState || !verifier || !nonce || !safeEqual(state, savedState)) return back("signin_error=state");
  const code = params.get("code");
  if (!code) return back("signin_error=cancelled");
  let secret: string;
  try { secret = p.mintSecret ? await p.mintSecret(env) : p.secret(env)!; } catch { return back(`signin_error=${key}`); }
  const form = new URLSearchParams({ code, client_id: p.id(env)!, client_secret: secret, redirect_uri: `${origin}/auth/${key}/callback`, grant_type: "authorization_code" });
  if (!p.formPost) { form.set("scope", p.scope); form.set("code_verifier", verifier); }
  const tok = await fetch(p.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
  }).then((r) => r.json() as Promise<{ id_token?: string }>).catch(() => ({} as { id_token?: string }));
  const claims = decodeJwt(tok.id_token ?? "");
  if (!claims?.sub || claims.aud !== p.id(env) || typeof claims.nonce !== "string" || !safeEqual(claims.nonce, nonce)) return back(`signin_error=${key}`);
  const subject = String(claims.sub);
  const verified = p.verifiedEmail(claims);
  const shown = p.shownEmail(claims);
  const owner = (await getLogin(env, key, subject))?.user_id ?? null;

  if (intent === "link") {
    if (!sessionUserId) return back("signin_error=signin");
    if (owner && owner !== sessionUserId) return back(`signin_error=taken_${key}`);
    if (!owner) await addLogin(env, { provider: key, subject, userId: sessionUserId, email: verified, secret: null });
    await audit(asEnv(env), sessionUserId, null, "studio.login_linked", { provider: key });
    return back(`linked=${key}`);
  }

  let userId = owner;
  // A sign-in held by an old account merged into another one opens nothing (accountMerged).
  if (userId && (await accountMerged(env, userId))) return back("signin_error=merged");
  let gifted: number | null = null;
  let handedOver = false;
  // Where the browser came from (attribution.ts): Google's redirect back here carries the first-touch cookie (SameSite=Lax).
  // Apple's form POST would not; Apple sign-in is off.
  const from = arrivalOf(request);
  if (!userId && verified) {
    // The address is already VOUCHED for by the other provider: same person, same account.
    userId = (await env.DB.prepare(`SELECT user_id FROM studio_logins WHERE provider IN (${SOCIAL_SQL}) AND email = ? LIMIT 1`).bind(verified).first<{ user_id: string }>())?.user_id ?? null;
    if (!userId) {
      // An account that only CLAIMS the address (a password sign-up, or the e-mail on the account row).
      const claimant = (await getLogin(env, "password", verified))?.user_id ?? (await getUserByEmail(asEnv(env), verified))?.id ?? null;
      if (claimant) {
        // An admin account is never handed over: its password opens the console (see USED ACCOUNTS TOO above).
        if (isAdmin(env, claimant)) {
          await audit(asEnv(env), claimant, null, "studio.email_claim_refused", { provider: key, admin: true });
          return back(`signin_error=claimed_${key}`);
        }
        const used = !(await untouched(env, claimant));
        await evictClaimant(env, claimant, key, used);
        userId = claimant;
        handedOver = true;
      }
    }
  }
  try {
    if (!userId) {
      const made = await newAccount(env, verified, v, from);
      userId = made.id;
      gifted = made.gifted;
      // An address the provider does not vouch for is kept only as the contact address, to show; it finds no account.
      if (!verified && shown) await env.DB.prepare("UPDATE users SET contact_email = COALESCE(contact_email, ?) WHERE id = ?").bind(shown, userId).run().catch(() => undefined);
    }
  } catch (e) {
    return back(`signin_error=${encodeURIComponent(e instanceof StudioError ? e.code : "error")}`);
  }
  // Only a vouched-for address is stored on the sign-in: it is what finds and joins accounts later.
  if (await accountMerged(env, userId)) return back("signin_error=merged");
  if (!owner) await addLogin(env, { provider: key, subject, userId, email: verified, secret: null });
  // An account the owner closed from the console opens no session (src/studio/admin.ts).
  if (await accountBlocked(env, userId)) return back("signin_error=blocked");
  await touchLogin(env, key, subject);
  await recordIp(env, userId, gifted === null ? "signin" : "signup", request);
  // A new account that started without the gift lands on "/?gift=none", where the page says why (src/abuse.ts); an
  // account handed over to its address's owner lands on "/?linked=<provider>", where the page says it now opens that way.
  const headers: [string, string][] = [["location", gifted === 0 ? "/?gift=none" : handedOver ? `/?linked=${key}` : "/"], ["set-cookie", await newSession(env, userId)], ["set-cookie", clearState(key)]];
  if (gifted) headers.push(["set-cookie", giftCookie()]);
  // The account exists now: the first-touch cookie has done its job.
  if (from.hadCookie) headers.push(["set-cookie", clearTouchCookie()]);
  return new Response(null, { status: 302, headers });
}

// ── Sign in with an e-mail code (30 October 2026) ──────────────────────────────────────────────────────────────────
// Google refuses to sign in inside the browsers Facebook, Instagram, TikTok and Messenger open links in (inapp.js), so a
// person who taps a Kleo link there had to move to Safari or Chrome first, and many stop on that step. A six-digit code
// mailed to the address signs them in, or opens their account, without leaving the app.
//
// A code proves the inbox: the same thing Google's `email_verified` vouches for. So it follows E-MAIL TRUST above. The
// address finds its own "email" sign-in, else the account where Google, Microsoft or Apple vouch for it. An account that
// only CLAIMS it (a password sign-up, the account row, the same Gmail with dots or a "+tag") is handed to whoever holds
// the inbox, and the claimant is evicted. Otherwise a new account opens, through the same caps and the one-gift rule.
// An admin account (STUDIO_ADMINS) never opens this way: it signs in with its password, or with Google.
//
// Only the code's HMAC is stored, for ten minutes and five wrong tries, and a code works once. One address gets a code
// at most every 30 seconds and five an hour; a throwaway mailbox gets none; the human check runs when it is configured.
// STUDIO_EMAIL_CODE "on" turns it on; it needs the EMAIL binding (Cloudflare Email Sending, onboarding.ts deliver).

const CODE_TTL_MS = 10 * 60_000;
const CODE_TRIES = 5;
const CODE_GAP_MS = 30_000;
const CODE_SENDS_PER_HOUR = 5;
const HOUR_MS = 3_600_000;

export const emailCodeOn = (env: StudioEnv): boolean => (env.STUDIO_EMAIL_CODE ?? "").trim().toLowerCase() === "on" && !!env.EMAIL;

const codeHash = (env: StudioEnv, email: string, code: string): Promise<string> => hmacHex(env.INTERNAL_SECRET, `kleo-email-code:${email}:${code}`);

/** Six digits, each value as likely as the others: draws at or above 4,294,000,000 are thrown away, so the modulo is fair. */
export function sixDigits(): string {
  const n = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(n);
    if (n[0] < 4_294_000_000) return String(n[0] % 1_000_000).padStart(6, "0");
  }
}

/** The e-mail that carries a code: the code is in the subject too, so the phone's notification shows it. */
export const codeMail = (code: string): Mail => ({
  key: "signin-code", subject: `${code} is your Kleo code`, preheader: "It works for 10 minutes.",
  blocks: [
    { p: "Here is your code to sign in to Kleo:" },
    { h: code },
    { p: "It works for 10 minutes. Type it on the page where you asked for it." },
    { p: "If you didn't ask for it, ignore this e-mail. Nobody can sign in without the code." },
  ],
  footer: "You're getting this because someone asked to sign in to Kleo with this address.",
});

const ADMIN_CODE_SENTENCE = "This account signs in with its password, or with Google.";

/** Mails a new code to the address. The same answer whether or not it has an account: the code opens one if not. */
export async function startEmailCode(env: StudioEnv, body: { email?: string; turnstile?: string }, v: Visitor): Promise<void> {
  if (!emailCodeOn(env)) throw new StudioError("Signing in with an e-mail code is not on. Use Google.", 503, "no_email_code");
  const email = normalizeEmail(String(body.email ?? ""));
  if (!EMAIL_RE.test(email)) throw new StudioError("That e-mail doesn't look right.");
  if (!(await verifyTurnstile(asEnv(env), String(body.turnstile ?? ""), v.ip))) throw new StudioError("Please complete the check and try again.", 400, "turnstile");
  if (!(await mailDomainOk(email.slice(email.lastIndexOf("@") + 1)))) {
    throw new StudioError("Please use an e-mail address you keep: this one can't receive mail, or it is a throwaway mailbox.", 400, "email_domain");
  }
  const now = Date.now();
  const row = await env.DB.prepare("SELECT sent_at, window_start, window_sends FROM studio_email_codes WHERE email = ?").bind(email)
    .first<{ sent_at: number; window_start: number; window_sends: number }>();
  if (row && now - Number(row.sent_at) < CODE_GAP_MS) throw new StudioError("A code is on its way. Wait half a minute before asking for another one.", 429, "code_wait");
  if (row && now - Number(row.window_start) < HOUR_MS && Number(row.window_sends) >= CODE_SENDS_PER_HOUR) {
    throw new StudioError("Too many codes for this address. Try again in an hour.", 429, "code_hour");
  }
  const code = sixDigits();
  await env.DB.prepare(`INSERT INTO studio_email_codes (email, code_hash, expires_at, attempts, sent_at, window_start, window_sends)
      VALUES (?1, ?2, ?3, 0, ?4, ?4, 1)
      ON CONFLICT(email) DO UPDATE SET code_hash = ?2, expires_at = ?3, attempts = 0, sent_at = ?4,
        window_sends = CASE WHEN ?4 - window_start >= ${HOUR_MS} THEN 1 ELSE window_sends + 1 END,
        window_start = CASE WHEN ?4 - window_start >= ${HOUR_MS} THEN ?4 ELSE window_start END`)
    .bind(email, await codeHash(env, email, code), now + CODE_TTL_MS, now).run();
  const sent = await deliver(env, email, codeMail(code), null, "signin-code");
  await audit(asEnv(env), null, null, "studio.email_code_sent", { ok: sent.ok, domain: email.slice(email.lastIndexOf("@") + 1), ...(sent.ok ? {} : { error: sent.code }) });
  if (!sent.ok) throw new StudioError("The code could not be sent. Try again in a minute, or use Google.", 503, "code_not_sent");
}

/**
 * Checks a code and answers the account it opens: found, handed over to the inbox's owner, or new (`gifted` is the new
 * account's gift, null for an account that already existed). The caller sets the session.
 */
export async function verifyEmailCode(env: StudioEnv, body: { email?: string; code?: string }, v: Visitor, from: Arrival | null = null): Promise<{ userId: string; gifted: number | null; handedOver: boolean }> {
  if (!emailCodeOn(env)) throw new StudioError("Signing in with an e-mail code is not on. Use Google.", 503, "no_email_code");
  const email = normalizeEmail(String(body.email ?? ""));
  const code = String(body.code ?? "").replace(/\D/g, "");
  const wrong = () => new StudioError("That code isn't right. Check the e-mail and try again.", 400, "wrong_code");
  const expired = () => new StudioError("This code no longer works. Ask for a new one.", 400, "code_expired");
  if (!EMAIL_RE.test(email) || code.length !== 6) throw wrong();
  const row = await env.DB.prepare("SELECT code_hash, expires_at, attempts FROM studio_email_codes WHERE email = ?").bind(email)
    .first<{ code_hash: string; expires_at: number; attempts: number }>();
  if (!row?.code_hash || Number(row.expires_at) <= Date.now()) throw expired();
  if (Number(row.attempts) >= CODE_TRIES) throw new StudioError("Too many wrong codes. Ask for a new one.", 429, "code_tries");
  const hash = await codeHash(env, email, code);
  if (!safeEqual(hash, row.code_hash)) {
    await env.DB.prepare("UPDATE studio_email_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    throw wrong();
  }
  // A code works once: whoever spends it first signs in. The row stays, so the hour's send count stays too.
  const spent = await env.DB.prepare("UPDATE studio_email_codes SET code_hash = '', expires_at = 0 WHERE email = ? AND code_hash = ?").bind(email, hash).run();
  if ((spent.meta.changes ?? 0) !== 1) throw expired();

  const refuseAdmin = async (id: string): Promise<StudioError> => {
    await audit(asEnv(env), id, null, "studio.email_code_refused", { admin: true });
    return new StudioError(ADMIN_CODE_SENTENCE, 403, "admin_code");
  };
  let userId: string | null = (await getLogin(env, "email", email))?.user_id
    ?? (await env.DB.prepare(`SELECT user_id FROM studio_logins WHERE provider IN (${SOCIAL_SQL}) AND email = ? LIMIT 1`).bind(email).first<{ user_id: string }>())?.user_id
    ?? null;
  let handedOver = false;
  if (!userId) {
    const claimant = (await getLogin(env, "password", email))?.user_id ?? (await getUserByEmail(asEnv(env), email))?.id
      ?? (await env.DB.prepare("SELECT id FROM users WHERE email_canon = ? LIMIT 1").bind(canonicalEmail(email)).first<{ id: string }>())?.id ?? null;
    if (claimant) {
      if (isAdmin(env, claimant)) throw await refuseAdmin(claimant);
      if (await accountMerged(env, claimant)) throw new StudioError(MERGED_SENTENCE, 403, "merged");
      await evictClaimant(env, claimant, "email", !(await untouched(env, claimant)));
      userId = claimant;
      handedOver = true;
    }
  }
  if (userId && isAdmin(env, userId)) throw await refuseAdmin(userId);
  let gifted: number | null = null;
  if (!userId) {
    const made = await newAccount(env, email, v, from);
    userId = made.id;
    gifted = made.gifted;
  }
  if (await accountMerged(env, userId)) throw new StudioError(MERGED_SENTENCE, 403, "merged");
  await addLogin(env, { provider: "email", subject: email, userId, email, secret: null });
  await touchLogin(env, "email", email);
  await audit(asEnv(env), userId, null, "studio.email_code_signin", { ...(gifted !== null ? { created: true } : {}), ...(handedOver ? { handed_over: true } : {}) });
  return { userId, gifted, handedOver };
}

function decodeJwt(t: string): Record<string, any> | null {
  const part = t.split(".")[1];
  if (!part) return null;
  try { return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))); } catch { return null; }
}
