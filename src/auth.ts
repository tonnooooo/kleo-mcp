import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, AuthProps } from "./env";
import { getUserByEmail, createUser, getInvite, useInvite, touchUser, audit } from "./db";
import { html, escapeHtml, rid, int } from "./util";

/**
 * /authorize: the page an MCP client (Claude, ChatGPT, Grok, Cursor…) opens in the browser.
 * Beta login = email + invite code. The code is bound to the email at first use; later logins
 * need the same pair. Swap this for Google sign-in when the beta opens up.
 */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const parsed = await parseOrError(request, env);
    if (parsed instanceof Response) return parsed;
    const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
    if (!client) return html(page({ error: "This connection request is not valid. Please add Kleo again from your assistant's connector settings.", clientName: parsed.clientId, oauthQuery: "" }), 400);
    return html(page({ clientName: client.clientName ?? parsed.clientId, oauthQuery: url.search.slice(1) }));
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const invite = String(form.get("invite") ?? "").trim().toUpperCase();
  const oauthQuery = String(form.get("oauth_query") ?? "");
  const consent = form.get("consent") === "yes";

  const replay = new Request(`${url.origin}/authorize?${oauthQuery}`, { method: "GET", headers: request.headers });
  const parsed = await parseOrError(replay, env);
  if (parsed instanceof Response) return parsed;
  const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
  const clientName = client?.clientName ?? parsed.clientId;
  const back = (error: string, status = 400) => html(page({ error, clientName, oauthQuery, email, invite }), status);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return back("Please enter a valid email address, like you@example.com.");
  if (!invite) return back("Please enter the invite code you received from the Kleo team.");
  if (!consent) return back(`Please tick the box to let ${clientName} create videos for you.`);

  let user = await getUserByEmail(env, email);
  if (user) {
    if (user.invite_code && user.invite_code !== invite) return back("This email is already registered with a different invite code. Please use the same code you signed up with.", 403);
  } else {
    const grant = await validInvite(env, invite);
    if (!grant) return back("This invite code is not valid or has already been used. Check the code you received, or ask the Kleo team for a new one.", 403);
    user = await createUser(env, { id: rid("u", 12), email, credits: grant.credits, inviteCode: invite });
    if (grant.fromTable) await useInvite(env, invite);
    await audit(env, user.id, null, "user.created", { invite, credits: grant.credits });
  }
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
  return Response.redirect(redirectTo, 302);
}

async function validInvite(env: Env, code: string): Promise<{ credits: number; fromTable: boolean } | null> {
  const row = await getInvite(env, code);
  if (row) return row.uses < row.max_uses ? { credits: row.credits, fromTable: true } : null;
  const envCodes = (env.INVITE_CODES ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return envCodes.includes(code) ? { credits: int(env.FREE_CREDITS, 3), fromTable: false } : null;
}

async function parseOrError(request: Request, env: Env): Promise<AuthRequest | Response> {
  try {
    return await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri) return html(page({ error: error.description ?? "This connection request is not valid. Please try connecting Kleo again from your assistant.", clientName: "", oauthQuery: "" }), 400);
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    if (error.description) redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect.toString(), 302);
  }
}

function page(o: { clientName: string; oauthQuery: string; error?: string; email?: string; invite?: string }): string {
  const client = escapeHtml(o.clientName || "your assistant");
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
input[type=text],input[type=email]{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit}
.chk{display:flex;gap:10px;align-items:flex-start;margin:18px 0;font-size:.9rem;color:var(--ink)}.chk input{margin-top:4px}
button{width:100%;padding:13px;border-radius:10px;border:0;background:var(--amber);color:var(--amber-ink);font:600 1rem/1 inherit;cursor:pointer;margin-top:6px}
.err{background:rgba(245,139,139,.12);border:1px solid var(--rose);color:var(--ink);padding:10px 12px;border-radius:8px;font-size:.9rem;margin-bottom:12px}
.foot{margin-top:16px;font-size:.8rem;color:var(--mute)}
</style></head><body><form class="card" method="post" action="/authorize">
<div class="brand"><svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="7" width="26" height="22" rx="5" fill="#F3B53F"/><path d="M3 12h26v4H3z" fill="#1A1200" opacity=".85"/><path d="M7 12l3.5 4M13 12l3.5 4M19 12l3.5 4" stroke="#F3B53F" stroke-width="1.6"/><path d="M10 19v8M10 23l6-4M10 23l6 4" stroke="#1A1200" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>Kleo <span>MCP</span></div>
<h1>Connect ${client} to Kleo</h1>
<p>${client} wants to create videos with Kleo for you. Sign in with your email and the invite code you received.</p>
${o.error ? `<div class="err" role="alert">${escapeHtml(o.error)}</div>` : ""}
<input type="hidden" name="oauth_query" value="${escapeHtml(o.oauthQuery)}">
<label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email" value="${escapeHtml(o.email ?? "")}" placeholder="you@example.com">
<label for="invite">Invite code</label><input id="invite" name="invite" type="text" required autocomplete="off" value="${escapeHtml(o.invite ?? "")}" placeholder="KLEO-XXXX" style="text-transform:uppercase">
<label class="chk" style="text-transform:none;letter-spacing:0"><input type="checkbox" name="consent" value="yes" required> Allow ${client} to create videos, check their progress and get the download links for me.</label>
<button type="submit">Connect</button>
<div class="foot">Each video uses credits from your account (1 credit per Short). You can remove this access any time from ${client}'s connector settings.</div>
</form></body></html>`;
}
