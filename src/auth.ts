import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, AuthProps } from "./env";
import { type User, getUser, createUser, getInvite, useInvite, touchUser, countUsersCreatedToday, audit } from "./db";
import { accountCookie, cookieHandle, makeHandle, signupRateKey, verifyHandle, verifyTurnstile } from "./accounts";
import { html, escapeHtml, rid, int } from "./util";

/**
 * /authorize: the page an MCP client (Claude, ChatGPT, Grok, Cursor…) opens in the browser.
 * One button, nothing to type: the click creates an anonymous account with FREE_CREDITS credits and
 * remembers it in a signed cookie (src/accounts.ts). A returning browser keeps its balance instead of
 * being given free credits again, which is also the main defence against multiplying the free tier.
 */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const freeCredits = int(env.FREE_CREDITS, 2);
  if (request.method === "GET") {
    const parsed = await parseOrError(request, env);
    if (parsed instanceof Response) return parsed;
    const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
    if (!client) return html(page({ error: "This connection request is not valid. Please add Kleo again from your assistant's connector settings.", clientName: parsed.clientId, oauthQuery: "", freeCredits }), 400);
    return html(page({ clientName: client.clientName ?? parsed.clientId, oauthQuery: url.search.slice(1), returning: await returningUser(env, request), freeCredits }));
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const form = await request.formData();
  const oauthQuery = String(form.get("oauth_query") ?? "");
  const bonusCode = String(form.get("bonus") ?? "").trim().toUpperCase();
  const pastedKey = String(form.get("account_key") ?? "").trim();

  const replay = new Request(`${url.origin}/authorize?${oauthQuery}`, { method: "GET", headers: request.headers });
  const parsed = await parseOrError(replay, env);
  if (parsed instanceof Response) return parsed;
  const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
  const clientName = client?.clientName ?? parsed.clientId;
  const returning = await returningUser(env, request);
  const back = (error: string, status = 400) => html(page({ error, clientName, oauthQuery, returning, freeCredits }), status);

  const ip = request.headers.get("CF-Connecting-IP");
  if (env.SIGNUP_LIMIT) {
    const { success } = await env.SIGNUP_LIMIT.limit({ key: await signupRateKey(env, ip) });
    if (!success) return back("Kleo is getting a lot of requests right now. Wait a few seconds and press the button again.", 429);
  }
  // Skipped entirely while TURNSTILE_SECRET is unset; the widget itself is Phase 2.
  if (!(await verifyTurnstile(env, String(form.get("cf-turnstile-response") ?? ""), ip)))
    return back("Kleo could not check that you are a person. Reload the page and press the button again.", 403);

  const resolved = await resolveAccount(env, { cookie: cookieHandle(request.headers.get("cookie")), key: pastedKey, bonus: bonusCode });
  if ("error" in resolved) return back(resolved.error, resolved.status);
  const user = resolved.user;
  await touchUser(env, user.id);

  const props: AuthProps = { userId: user.id, email: user.email };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: parsed,
    userId: user.id,
    metadata: { clientName, label: `${clientName} · ${new Date().toISOString().slice(0, 10)}` },
    scope: parsed.scope,
    props,
  });
  await audit(env, user.id, null, "oauth.granted", { client: clientName });
  // Response.redirect() hands back IMMUTABLE headers, so the cookie could never be attached to it: build the 302 by hand.
  return new Response(null, { status: 302, headers: { location: redirectTo, "set-cookie": accountCookie(await makeHandle(env, user.id)) } });
}

/** The account this browser already owns, if its cookie is valid and the row still exists. */
async function returningUser(env: Env, request: Request): Promise<User | undefined> {
  const userId = await verifyHandle(env, cookieHandle(request.headers.get("cookie")));
  return (userId ? await getUser(env, userId) : null) ?? undefined;
}

type Resolved = { user: User } | { error: string; status: number };

/**
 * Cookie first, then a pasted Kleo key, then a new account — and ONLY the new account is given free credits.
 * The daily cap is checked before createUser, so a day that is over creates neither a user nor credits.
 */
async function resolveAccount(env: Env, o: { cookie: string | null; key: string; bonus: string }): Promise<Resolved> {
  for (const handle of [o.cookie, o.key]) {
    const userId = await verifyHandle(env, handle);
    const user = userId ? await getUser(env, userId) : null;
    if (user) return { user };
  }
  if (o.key) return { error: "That Kleo key is not valid. Check that you copied all of it, or leave the field empty to start a new account.", status: 400 };

  if ((await countUsersCreatedToday(env)) >= int(env.MAX_NEW_USERS_PER_DAY, 25))
    return { error: "Kleo has handed out today's free Shorts. Come back tomorrow and this button will work again.", status: 429 };

  const bonus = o.bonus ? await bonusCredits(env, o.bonus) : 0;
  const credits = int(env.FREE_CREDITS, 2) + bonus;
  const id = rid("u", 12);
  // users.email is NOT NULL UNIQUE and an anonymous account has no address: this synthetic one satisfies the
  // constraint, so the open door needs no migration and no new column. .invalid can never be a real domain (RFC 2606).
  const user = await createUser(env, { id, email: `${id}@anon.kleo.invalid`, credits, inviteCode: bonus ? o.bonus : null });
  if (bonus) await useInvite(env, o.bonus);
  await audit(env, user.id, null, "user.created", { source: "open", credits, bonus });
  return { user };
}

/** The invites table survives as a GIFT, never as a gate: an unknown or exhausted code simply adds nothing. */
async function bonusCredits(env: Env, code: string): Promise<number> {
  const row = await getInvite(env, code);
  return row && row.uses < row.max_uses ? row.credits : 0;
}

async function parseOrError(request: Request, env: Env): Promise<AuthRequest | Response> {
  try {
    return await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri) return html(page({ error: error.description ?? "This connection request is not valid. Please try connecting Kleo again from your assistant.", clientName: "", oauthQuery: "", freeCredits: 2 }), 400);
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    if (error.description) redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect.toString(), 302);
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function page(o: { clientName: string; oauthQuery: string; freeCredits: number; error?: string; returning?: User }): string {
  const client = escapeHtml(o.clientName || "your assistant");
  const shorts = plural(o.freeCredits, "Short");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Kleo</title>
<style>
:root{color-scheme:dark;--bg:#0F1216;--bg2:#151920;--line:#262C36;--ink:#ECEAE4;--mute:#838B99;--amber:#F3B53F;--amber-ink:#1A1200;--rose:#F58B8B}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 "Instrument Sans","Helvetica Neue",Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}
.card{width:min(440px,100%);background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:28px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.25rem;letter-spacing:-.02em;margin-bottom:18px}
.brand span{font:500 .66rem/1 monospace;letter-spacing:.12em;border:1px solid var(--line);border-radius:4px;padding:3px 6px;color:var(--mute)}
h1{font-size:1.35rem;margin:0 0 6px;letter-spacing:-.01em}p{margin:0 0 18px;color:var(--mute);font-size:.95rem}
label{display:block;font-size:.8rem;color:var(--mute);margin:12px 0 6px;letter-spacing:.04em;text-transform:uppercase}
input[type=text]{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit}
button{width:100%;padding:15px;border-radius:10px;border:0;background:var(--amber);color:var(--amber-ink);font:600 1.05rem/1 inherit;cursor:pointer;margin-top:6px}
.err{background:rgba(245,139,139,.12);border:1px solid var(--rose);color:var(--ink);padding:10px 12px;border-radius:8px;font-size:.9rem;margin-bottom:12px}
.back{color:var(--ink);font-size:.95rem;margin-bottom:14px}
.note{margin:12px 0 0;font-size:.8rem;color:var(--mute)}
details{margin-top:22px;border-top:1px solid var(--line);padding-top:14px}
summary{cursor:pointer;font-size:.85rem;color:var(--mute)}
.foot{margin-top:16px;font-size:.8rem;color:var(--mute)}
</style></head><body><form class="card" method="post" action="/authorize">
<div class="brand"><svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="7" width="26" height="22" rx="5" fill="#F3B53F"/><path d="M3 12h26v4H3z" fill="#1A1200" opacity=".85"/><path d="M7 12l3.5 4M13 12l3.5 4M19 12l3.5 4" stroke="#F3B53F" stroke-width="1.6"/><path d="M10 19v8M10 23l6-4M10 23l6 4" stroke="#1A1200" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>Kleo <span>MCP</span></div>
<h1>Connect ${client} to Kleo</h1>
<p>${client} will be able to create videos for you, follow their progress and fetch the download links. You can remove this at any time from ${client}'s connector settings.</p>
${o.error ? `<div class="err" role="alert">${escapeHtml(o.error)}</div>` : ""}
${o.returning ? `<div class="back">Welcome back - ${plural(o.returning.credits, "credit")} left.</div>` : ""}
<input type="hidden" name="oauth_query" value="${escapeHtml(o.oauthQuery)}">
<button type="submit">${o.returning ? "Continue" : `Start free - ${shorts} included`}</button>
<p class="note">No email. No password. No card. No invite code. Your Kleo account lives in this browser.</p>
<details><summary>Have a bonus code, or a Kleo key?</summary>
<label for="bonus">Bonus code</label><input id="bonus" name="bonus" type="text" autocomplete="off" placeholder="Leave empty" style="text-transform:uppercase">
<label for="account_key">Kleo key</label><input id="account_key" name="account_key" type="text" autocomplete="off" placeholder="Leave empty">
<p class="note">A Kleo key brings an account you already have on another browser. Ask your assistant for kleo_account to see yours.</p>
</details>
<div class="foot">1 credit = 1 Short. You start with ${o.freeCredits}. When they run out, Kleo gives you a link in the chat.</div>
</form></body></html>`;
}
