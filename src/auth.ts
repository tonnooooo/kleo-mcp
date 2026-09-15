import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, AuthProps } from "./env";
import { type User, getUser, createUserIfUnderCaps, getInvite, useInvite, applyBonusToUser, touchUser, audit } from "./db";
import { accountCookie, cookieHandle, ipFingerprint, makeHandle, signupRateKey, verifyHandle, verifyTurnstile } from "./accounts";
import { html, escapeHtml, rid, int } from "./util";
import { MIN_FILM_CREDITS, ANIMATIC_CREDITS, ANIMATIC_MAX_S, freeCreditsFor, tariffSentence } from "./templates";

/**
 * /authorize: the page an MCP client (Claude, ChatGPT, Grok, Cursor…) opens in the browser.
 * One button, nothing to type: the click creates an anonymous account with FREE_CREDITS credits (below a film on purpose) and
 * remembers it in a signed cookie (src/accounts.ts). A returning browser keeps its balance instead of
 * being given free credits again, which is also the main defence against multiplying the free tier.
 */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const freeCredits = freeCreditsFor(env);
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

  const resolved = await resolveAccount(env, { cookie: cookieHandle(request.headers.get("cookie")), key: pastedKey, bonus: bonusCode, ip });
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
 * A pasted Kleo key FIRST, then the cookie, then a new account — and ONLY the new account is given free credits.
 * The key comes first on purpose: typing one is an explicit "this is my account", while a cookie is merely what this
 * browser happens to hold, and the very case the key exists for (an account left on another computer) is the case
 * where this browser already has a cookie of its own. Whichever branch wins, a gift code typed alongside is applied.
 * The daily caps are part of the INSERT itself, so a day that is over creates neither a user nor credits.
 */
async function resolveAccount(env: Env, o: { cookie: string | null; key: string; bonus: string; ip: string | null }): Promise<Resolved> {
  const accountFor = async (handle: string | null) => {
    const userId = await verifyHandle(env, handle);
    return userId ? await getUser(env, userId) : null;
  };
  if (o.key) {
    // A typed key that does not work is always an error, even here where the cookie would have done: silently signing
    // the person into the browser's own account is how somebody ends up on the wrong balance and never finds out.
    const user = await accountFor(o.key);
    if (!user) return { error: "That Kleo key is not valid. Check that you copied all of it, or leave the field empty to start a new account.", status: 400 };
    return { user: await applyBonus(env, user, o.bonus) };
  }
  const known = await accountFor(o.cookie);
  if (known) return { user: await applyBonus(env, known, o.bonus) };

  // Both daily caps live inside the INSERT (db.ts createUserIfUnderCaps): the day cap, and the per-address one that
  // stops 25 requests from one place closing the free tier for everybody until midnight. The address is stored only
  // as a fingerprint, and the refusal is worded so it never accuses anybody — whole offices share one address.
  const ip = await ipFingerprint(env, o.ip);
  const id = rid("u", 12);
  // users.email is NOT NULL UNIQUE and an anonymous account has no address: this synthetic one satisfies the
  // constraint. .invalid can never be a real domain (RFC 2606).
  const { verdict, user } = await createUserIfUnderCaps(
    env,
    { id, email: `${id}@anon.kleo.invalid`, credits: freeCreditsFor(env), ipHash: ip },
    { perDay: int(env.MAX_NEW_USERS_PER_DAY, 25), perAddressDay: int(env.MAX_NEW_USERS_PER_IP_DAY, 5) },
  );
  if (!user)
    return verdict === "day_full"
      ? { error: "Kleo has handed out today's free credits. Come back tomorrow and this button will work again.", status: 429 }
      : { error: "Kleo is giving out its free credits slowly today. Try again in a little while, and your account will be waiting.", status: 429 };
  await audit(env, user.id, null, "user.created", { source: "open", credits: user.credits, ip });
  // The gift is applied only now, to an account that exists: a sign-up a cap refused must never burn one of the
  // code's uses, which is what claiming it before the INSERT did.
  return { user: await applyBonus(env, user, o.bonus) };
}

/**
 * A gift code typed by a browser that already has an account. Nothing is blocked either way — a code is a gift,
 * never a gate — but the outcome is always written down, because a code that silently does nothing is a gift the
 * owner handed out and neither side can trace.
 */
async function applyBonus(env: Env, user: User, code: string): Promise<User> {
  if (!code) return user;
  const reject = async (reason: string) => { await audit(env, user.id, null, "bonus.rejected", { code, reason }); return user; };
  if (user.invite_code) return reject("this account has already used a bonus code");
  const credits = await claimBonus(env, code);
  if (!credits) return reject("unknown code, or every use of it is gone");
  if (!(await applyBonusToUser(env, user.id, code, credits))) return reject("this account has already used a bonus code");
  await audit(env, user.id, null, "bonus.applied", { code, credits });
  return (await getUser(env, user.id)) ?? user;
}

/**
 * Claims ONE use of a gift code and returns what it is worth (0: unknown, or every use gone). The atomic UPDATE
 * comes first and the credits are granted only if it changed a row — reading the row and granting before claiming
 * let twenty simultaneous presses all see uses = 0 and mint a one-use code twenty times over.
 */
async function claimBonus(env: Env, code: string): Promise<number> {
  const row = await getInvite(env, code);
  if (!row) return 0;
  const r = await useInvite(env, code);
  return (r.meta.changes ?? 0) === 1 ? row.credits : 0;
}

async function parseOrError(request: Request, env: Env): Promise<AuthRequest | Response> {
  try {
    return await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri) return html(page({ error: error.description ?? "This connection request is not valid. Please try connecting Kleo again from your assistant.", clientName: "", oauthQuery: "", freeCredits: freeCreditsFor(env) }), 400);
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
  // The price is the table's, not a number typed here: this page said "1 credit = 1 Short" for a day after the
  // film became the only product at 7 credits. Since 14 September the gift (7) sits under the shortest film (10):
  // the sentence below says so in as many words, instead of promising a film the credits cannot buy.
  // Since 15 September the gift buys an ANIMATIC (the drawn frames with the camera over them, narrated, 4K 60 fps,
  // no generated clip) and a film needs a pack: the clips are generated at Kleo's expense, so they are for accounts
  // that have paid — whatever their balance.
  const animatics = Math.floor(o.freeCredits / ANIMATIC_CREDITS);
  const start = o.freeCredits > 0
    ? `You start with ${plural(o.freeCredits, "credit")}: ${animatics > 0 ? `${plural(animatics, "animatic")} on the house (${ANIMATIC_CREDITS} credits each, up to ${ANIMATIC_MAX_S} seconds: your storyboard as drawn frames with the camera moving over them, narrated, 4K 60 fps)` : `not yet an animatic (${ANIMATIC_CREDITS} credits)`}. A film — every shot a generated clip — starts at ${MIN_FILM_CREDITS} credits and is made for accounts that have bought a pack: the 5 EUR pack takes you to ${o.freeCredits + 10}, a 20-second film or a 30-second Short with what you have.`
    : "A new account starts at zero credits: connecting is free, every video is paid. Credit packs (from 5 EUR) are on your account page, one click away in the chat.";
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
<button type="submit">${o.returning ? "Continue" : o.freeCredits > 0 ? `Start free - ${plural(o.freeCredits, "credit")} included` : "Start"}</button>
<p class="note">No email. No password. No card. No invite code. Your Kleo account lives in this browser.</p>
<details><summary>Have a bonus code, or a Kleo key?</summary>
<label for="bonus">Bonus code</label><input id="bonus" name="bonus" type="text" autocomplete="off" placeholder="Leave empty" style="text-transform:uppercase">
<label for="account_key">Kleo key</label><input id="account_key" name="account_key" type="text" autocomplete="off" placeholder="Leave empty">
<p class="note">A bonus code adds credits, to a new account or to the one this browser already has. A Kleo key brings an account you already have on another browser: ask your assistant for kleo_account to see yours.</p>
</details>
<div class="foot">${tariffSentence()}. ${start} When credits run out, Kleo gives you a link in the chat.</div>
</form></body></html>`;
}
