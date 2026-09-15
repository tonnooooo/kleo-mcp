import type { Env } from "./env";
import { getUser, hasPaid, type User } from "./db";
import { cookieHandle, makeHandle, verifyHandle, verifyViewToken } from "./accounts";
import { PACKS, sellingOpen, sellingAvailable, buyUrl } from "./stripe";
import { html, escapeHtml } from "./util";
import { tariffSentence, ANIMATIC_CREDITS, ANIMATIC_MAX_S } from "./templates";

/** The one address a stranger can write to. It is also in the site footer; both must always say the same thing. */
const CONTACT = "kleooai@gmail.com";


/**
 * GET /credits?k=<view token> — the account page an assistant links to when the credits run out.
 * The token is read-only (accounts.ts): it opens the balance and the prices, it is NOT the Kleo key and it signs
 * nobody in, because this link travels through a chat log. The Kleo key is shown only to a browser whose own cookie
 * says it already owns the account, and the page never writes a cookie: a link cannot rebind a visitor's browser
 * to somebody else's account.
 */
export async function handleCredits(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const ownerId = await verifyHandle(env, cookieHandle(request.headers.get("cookie")));
  const userId = (await verifyViewToken(env, url.searchParams.get("k"))) ?? ownerId;
  const user = userId ? await getUser(env, userId) : null;
  if (!user) return html(page(null, "", env, false, false), 404);
  // Only the browser that IS this account sees the key; a shared link shows the balance and nothing worth stealing.
  const key = ownerId === user.id ? await makeHandle(env, user.id) : "";
  return html(page(user, key, env, await sellingAvailable(env), await hasPaid(env, user.id)));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function page(user: User | null, handle: string, env: Env, open_: boolean, paid: boolean): string {
  const configured = sellingOpen(env);
  // The buttons exist only when selling is actually configured. Until then the same three packs are shown as plain
  // text with an honest badge: a page that offers a button nobody can pay through is worse than one that says wait.
  const packs = PACKS.map((p) => {
    const href = open_ && user ? buyUrl(env, p, user.id) : null;
    return href
      ? `<li><a class="buy" href="${escapeHtml(href)}"><b>${p.label}</b> - ${p.credits} credits</a></li>`
      : `<li><b>${p.label}</b> - ${p.credits} credits</li>`;
  }).join("");
  const key = handle
    ? `<h2>Your Kleo key</h2>
<p>This is your account. Paste it on the Kleo sign-in page of another browser or another computer to come back to these same credits. Anyone who has it can use your credits, so keep it to yourself.</p>
<code class="key">${escapeHtml(handle)}</code>
<div class="foot">Kleo remembers this account in this browser. Clearing your cookies loses it unless you saved the key above.</div>`
    : `<h2>Using Kleo somewhere else</h2>
<p>This page is read-only, so it does not show the key that carries the account to another browser: ask your assistant for kleo_account and it will show it to you there.</p>`;
  const body = user
    ? `<h1>${escapeHtml(plural(user.credits, "credit"))} left</h1>
<p>${tariffSentence()}. A film (every shot a generated clip) is made for accounts that have bought a pack; the animatic is open to every account. ${paid ? "This account has bought a pack: it can order films and animatics." : `This account has not bought a pack yet: it can order animatics (${ANIMATIC_CREDITS} credits, up to ${ANIMATIC_MAX_S} s); the film opens with any pack.`} The credits come back in full if a render fails, or if you cancel it before it starts; cancelling part-way through gives back the part that was not rendered.</p>
<h2>Credit packs</h2>
${open_ ? `<p>Payment is handled by Stripe: Kleo never sees your card. Credits land on this account within a few seconds of paying, and the page shows the new balance when you reload it.</p>` : configured ? `<div class="badge">Credit packs are paused for a moment: Kleo is topping up its rendering capacity so that every credit sold can actually be rendered. Try again in a little while - nothing is wrong with your account.</div>` : `<div class="badge">Card payments are not open yet - Kleo is free while it is in beta.</div>`}
<ul class="packs">${packs}</ul>
${open_ ? `<p>One payment, no subscription, nothing renews. Credits do not expire.</p>` : `<p>These are the prices the packs will have. When they open, this page is where you will buy them - nothing else about Kleo changes.</p>`}
<div class="foot">Out of credits, or something went wrong? Write to <a href="mailto:${CONTACT}">${CONTACT}</a>.</div>
${key}`
    : `<h1>This account link is not valid</h1>
<p>The link may have been cut short when it was copied. Ask your assistant for kleo_account: it gives you the full link and your Kleo key.</p>
<div class="foot">Still stuck? Write to <a href="mailto:${CONTACT}">${CONTACT}</a>.</div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Kleo account</title>
<style>
:root{color-scheme:dark;--bg:#0F1216;--bg2:#151920;--line:#262C36;--ink:#ECEAE4;--mute:#838B99;--amber:#F3B53F;--amber-ink:#1A1200}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 "Instrument Sans","Helvetica Neue",Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}
.card{width:min(480px,100%);background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:28px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.25rem;letter-spacing:-.02em;margin-bottom:18px}
.brand span{font:500 .66rem/1 monospace;letter-spacing:.12em;border:1px solid var(--line);border-radius:4px;padding:3px 6px;color:var(--mute)}
h1{font-size:1.6rem;margin:0 0 6px;letter-spacing:-.01em}h2{font-size:.95rem;margin:22px 0 6px}
p{margin:0 0 14px;color:var(--mute);font-size:.95rem}
.badge{border:1px solid var(--amber);color:var(--amber);border-radius:8px;padding:10px 12px;font-size:.9rem}
.packs{list-style:none;margin:12px 0 14px;padding:0}.packs li{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:6px;font-size:.95rem}
.packs b{color:var(--amber)}a{color:var(--amber)}
.packs a.buy{display:block;text-decoration:none;color:var(--s-ink,var(--ink))}
.packs li:has(a.buy){border-color:var(--amber);cursor:pointer}
.packs li:has(a.buy):hover{background:rgba(243,181,63,.08)}
.key{display:block;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font:.85rem/1.5 monospace;word-break:break-all;color:var(--ink)}
.foot{margin-top:16px;font-size:.8rem;color:var(--mute)}
</style></head><body><main class="card">
<div class="brand"><svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="7" width="26" height="22" rx="5" fill="#F3B53F"/><path d="M3 12h26v4H3z" fill="#1A1200" opacity=".85"/><path d="M7 12l3.5 4M13 12l3.5 4M19 12l3.5 4" stroke="#F3B53F" stroke-width="1.6"/><path d="M10 19v8M10 23l6-4M10 23l6 4" stroke="#1A1200" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>Kleo <span>ACCOUNT</span></div>
${body}
</main></body></html>`;
}
