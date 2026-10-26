/**
 * ONE ACCOUNT EVERYWHERE (19 October 2026, the owner: "quando connette l'MCP… gli devi far creare un account su
 * Kleo… i crediti arriveranno nell'account… gli stessi crediti che la persona avrà nell'app").
 *
 * Until today, adding Kleo to Grok, Claude or ChatGPT opened an ANONYMOUS account with one press (src/auth.ts). A
 * customer then signed up again in Kleo Studio with their e-mail, paid from the assistant's link, and found the credits
 * on the other account. Now (MCP_SIGNIN = "studio"):
 *
 *   1. /authorize (this worker) sends the browser to Kleo Studio's sign-in, /connect?r=<signed request>. A `__Host-`
 *      cookie with a fresh nonce stays behind on this host.
 *   2. Studio signs the person in (Google, e-mail and password, or a Kleo key) and answers POST /api/connect with a
 *      signed, five-minute "finish" ticket naming the account (src/studio/index.ts).
 *   3. /authorize/finish (this worker) checks the ticket and the nonce cookie — the same browser that started — and
 *      completes the OAuth grant for that account. The assistant and the app share one balance from then on.
 *
 * Accounts opened the old way are joined, never stranded: the browser's old anonymous account (its kleo_id cookie)
 * rides along in the request and is merged into the signed-in one; an assistant still connected to an anonymous
 * account gets, on its next tool call, a sign-in link instead of a result (`signInRequiredReply`), and after the merge
 * its existing grant keeps working on the real account through users.merged_into (src/index.ts).
 *
 * A MERGE NEEDS THE BROWSER THAT HOLDS THE ACCOUNT (26 October 2026, the security review): a signed link alone proves
 * nothing about who opened it, and a forwarded or leaked one used to pour a stranger's anonymous account into whoever
 * was signed in. The request's account is merged only at /authorize/finish, behind its nonce cookie; an assistant's
 * sign-in link first sends the browser to this worker's /authorize/merge, which checks the kleo_id cookie of that very
 * account and only then hands Studio a short "held" ticket for the same Studio account (src/auth.ts handleConnectMerge).
 *
 * Every token here is HMAC-signed with INTERNAL_SECRET, which both workers share; each kind has its own label, so one
 * can never be passed off as another.
 */
import type { Env } from "./env";
import { getUser, audit, type User } from "./db";

export const CONNECT_COOKIE = "__Host-kleo_connect";
export const ANON_DOMAIN = "@anon.kleo.invalid";
const REQUEST_TTL_S = 30 * 60;
const FINISH_TTL_S = 5 * 60;
const MERGE_TTL_S = 14 * 24 * 3600;

export type ConnectLabel = "request" | "finish" | "merge" | "claim" | "held";
export interface RequestToken { q: string; n: string; a: string | null; c: string; o: string; exp: number }
/** `a`: the anonymous account the starting browser held, merged at /authorize/finish once the nonce matches. */
export interface FinishToken { u: string; n: string; q: string; a?: string | null; exp: number }
/** `o`: the origin of this worker the assistant reached, where its browser keeps the kleo_id cookie (older links: none). */
export interface MergeToken { a: string; o?: string; exp: number }
/** "claim": Studio asks this worker whether the browser holds `a` for account `u`; "held": this worker's yes, for Studio. */
export interface ClaimToken { u: string; a: string; exp: number }

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string): string => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};
async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))));
}
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function signToken(env: Pick<Env, "INTERNAL_SECRET">, label: ConnectLabel, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(env.INTERNAL_SECRET, `kleo-connect:${label}:${body}`)}`;
}

/** The payload of a token of this kind, or null when it is forged, of another kind, damaged or expired. */
export async function readToken<T extends { exp: number }>(env: Pick<Env, "INTERNAL_SECRET">, label: ConnectLabel, token: string | null | undefined, now = Date.now()): Promise<T | null> {
  const [body, sig] = String(token ?? "").split(".");
  if (!body || !sig || body.length > 8000) return null;
  if (!sameString(sig, await hmac(env.INTERNAL_SECRET, `kleo-connect:${label}:${body}`))) return null;
  try {
    const p = JSON.parse(fromB64url(body)) as T;
    return typeof p?.exp === "number" && p.exp * 1000 > now ? p : null;
  } catch { return null; }
}

export const nowS = (): number => Math.floor(Date.now() / 1000);
export const newNonce = (): string => b64url(crypto.getRandomValues(new Uint8Array(18)));
export const requestTtl = (): number => nowS() + REQUEST_TTL_S;
export const finishTtl = (): number => nowS() + FINISH_TTL_S;
export const mergeTtl = (): number => nowS() + MERGE_TTL_S;
export const connectCookie = (nonce: string): string => `${CONNECT_COOKIE}=${nonce}; Path=/; Max-Age=${REQUEST_TTL_S}; HttpOnly; Secure; SameSite=Lax`;
export const clearConnectCookie = (): string => `${CONNECT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
export function readConnectCookie(header: string | null | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === CONNECT_COOKIE) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** "studio": the assistant connects only through a Kleo account (production). Anything else: the old one-press page. */
export const studioSignIn = (env: Partial<Env>): boolean => String((env as Env).MCP_SIGNIN ?? "").trim().toLowerCase() === "studio";
export const studioUrl = (env: Partial<Env>): string => String((env as Env).STUDIO_URL || "https://app.kleooai.com").replace(/\/+$/, "");

/** True for an account opened by the old one-press page that nobody has signed in to since (no Studio sign-in). */
export async function isAnonymous(env: Env, user: Pick<User, "id" | "email">): Promise<boolean> {
  if (!String(user.email ?? "").endsWith(ANON_DOMAIN)) return false;
  try {
    const login = await env.DB.prepare("SELECT 1 AS x FROM studio_logins WHERE user_id = ? LIMIT 1").bind(user.id).first();
    return !login;
  } catch { return true; } // no studio_logins table yet: nobody has a Studio sign-in
}

/** The account a grant made for `user` acts on today: the account it was merged into, if any (one hop). */
export async function activeAccount(env: Env, user: User): Promise<User> {
  const into = (user as User & { merged_into?: string | null }).merged_into;
  if (!into) return user;
  return (await getUser(env, into)) ?? user;
}

/**
 * Joins an anonymous account into a real one: its credits and films move, and the old id points at the new one so the
 * grants made for it keep working. Refuses anything that is not an anonymous account, or that was merged already.
 * Answers the credits moved (0 is a valid answer), or null when nothing was merged.
 */
export async function mergeAnonymous(env: Env, fromId: string, intoId: string, why: string): Promise<number | null> {
  if (!fromId || !intoId || fromId === intoId) return null;
  const from = await getUser(env, fromId) as (User & { merged_into?: string | null }) | null;
  const into = await getUser(env, intoId) as (User & { merged_into?: string | null }) | null;
  if (!from || !into || from.merged_into || into.merged_into) return null;
  if (!(await isAnonymous(env, from))) return null;
  const credits = Math.max(0, Number(from.credits) || 0);
  await env.DB.batch([
    // The guard on merged_into makes a second, simultaneous merge a no-op: only one of them moves the credits.
    env.DB.prepare("UPDATE users SET merged_into = ?, credits = 0 WHERE id = ? AND merged_into IS NULL").bind(intoId, fromId),
    env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ? AND (SELECT merged_into FROM users WHERE id = ?) = ?").bind(credits, intoId, fromId, intoId),
    env.DB.prepare("UPDATE jobs SET user_id = ? WHERE user_id = ? AND (SELECT merged_into FROM users WHERE id = ?) = ?").bind(intoId, fromId, fromId, intoId),
  ]);
  const done = (await getUser(env, fromId) as (User & { merged_into?: string | null }) | null)?.merged_into === intoId;
  if (!done) return null;
  await audit(env, intoId, null, "account.merged_in", { from: fromId, credits, why });
  await audit(env, fromId, null, "account.merged_out", { into: intoId, credits, why });
  return credits;
}

/** What an assistant connected to an anonymous account is told instead of running a tool: sign in, here. */
export async function signInLink(env: Env, userId: string, origin?: string): Promise<string> {
  return `${studioUrl(env)}/connect?m=${await signToken(env, "merge", { a: userId, ...(origin ? { o: origin } : {}), exp: mergeTtl() } satisfies MergeToken)}`;
}
export function signInRequiredReply(rpcId: unknown, link: string): Record<string, unknown> {
  const text = "Kleo now works with a Kleo account, so your credits are the same here and in the Kleo app. "
    + `Sign in or create your free account here, then ask again — your credits and videos come with you: ${link}`;
  return { jsonrpc: "2.0", id: rpcId ?? null, result: { content: [{ type: "text", text }], isError: true } };
}

/**
 * Step 2, on Kleo Studio (POST /api/connect, src/studio/index.ts), for the signed-in account:
 *   { r } — an assistant is connecting: hand back the finish link, which takes in the browser's old anonymous account
 *           at /authorize/finish, once its nonce cookie proves it is the browser that started;
 *   { m } — an assistant still on an anonymous account sent its owner here: send the browser to /authorize/merge to show
 *           it holds that account, which comes back here as { m: <held ticket> } and only then takes the account in.
 */
export async function studioConnect(env: Env, userId: string, b: { r?: unknown; m?: unknown }): Promise<{ url?: string; client?: string; merged: number | null } | { error: string; code?: string }> {
  // A Kleo key alone is not an account any more: the assistant must land on an account with Google or an e-mail.
  const me = await getUser(env, userId);
  if (!me || (await isAnonymous(env, me))) return { error: "Sign in with Google or your e-mail to connect Kleo. Your Kleo key's credits come with you.", code: "anonymous" };
  // An old account merged into another one connects nothing: its assistant would act on that other account (27 October 2026).
  if ((me as User & { merged_into?: string | null }).merged_into) return { error: "This account is now part of another Kleo account. Sign in to that account to connect Kleo.", code: "merged" };
  if (typeof b.r === "string" && b.r) {
    const r = await readToken<RequestToken>(env, "request", b.r);
    if (!r) return { error: "This connection link has expired. Go back to your assistant and connect Kleo again." };
    const ticket = await signToken(env, "finish", { u: userId, n: r.n, q: r.q, a: r.a, exp: finishTtl() } satisfies FinishToken);
    return { url: `${r.o}/authorize/finish?t=${ticket}`, client: r.c, merged: null };
  }
  if (typeof b.m === "string" && b.m) {
    // A "held" ticket: /authorize/merge saw this browser hold the account, for this same signed-in account only.
    const held = await readToken<ClaimToken>(env, "held", b.m);
    if (held && held.u !== userId) return { error: "This link was opened in another Kleo account, so nothing was moved. Ask your assistant to use Kleo again for a new one." };
    const m: { a: string; o?: string } | null = held ?? await readToken<MergeToken>(env, "merge", b.m);
    if (!m) return { error: "This sign-in link has expired. Ask your assistant to use Kleo again for a new one." };
    const from = await getUser(env, m.a) as (User & { merged_into?: string | null }) | null;
    if (from?.merged_into === userId) return { merged: 0 }; // already done: the link was opened twice
    if (from?.merged_into) return { error: "That assistant is already connected to another Kleo account." };
    if (held) return { merged: await mergeAnonymous(env, m.a, userId, "assistant-link") };
    // Nothing a merge could take in (mergeAnonymous's own guards): the same answer as ever, with no detour.
    if (!from || m.a === userId || (me as User & { merged_into?: string | null }).merged_into || !(await isAnonymous(env, from))) return { merged: null };
    const claim = await signToken(env, "claim", { u: userId, a: m.a, exp: finishTtl() } satisfies ClaimToken);
    return { url: `${String(m.o || env.PUBLIC_URL).replace(/\/+$/, "")}/authorize/merge?t=${claim}`, merged: null };
  }
  return { error: "Nothing to connect." };
}
