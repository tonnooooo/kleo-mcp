import type { Env } from "./env";
import { getUser, hasPaid, type User } from "./db";
import { cookieHandle, makeHandle, makeViewToken, verifyHandle, verifyViewToken } from "./accounts";
import { PACKS, sellingOpen, sellingAvailable, buyUrl } from "./stripe";
import { html, escapeHtml } from "./util";
import { tariffSentence, animaticRule } from "./templates";
import { redeemLaunchCode, trialOf, TRIAL_FILM_MAX_S, type TrialState } from "./launch.ts";
import { referralCodeFor, referralLink, referralRule } from "./referral.ts";
import { setContactEmail, removeContactEmail, contactEmailOf, emailConfigured, EMAIL_BONUS, type ContactEmail } from "./email.ts";

/** The one address a stranger can write to. It is also in the site footer; both must always say the same thing. */
const CONTACT = "kleooai@gmail.com";


/**
 * GET /credits?k=<view token> — the account page an assistant links to when the credits run out.
 * The token is read-only (accounts.ts): it opens the balance and the prices, it is NOT the Kleo key and it signs
 * nobody in, because this link travels through a chat log. The Kleo key is shown only to a browser whose own cookie
 * says it already owns the account, and the page never writes a cookie: a link cannot rebind a visitor's browser
 * to somebody else's account.
 *
 * POST /credits (27 September 2026): the page's own forms. `action=redeem` redeems a launch code (src/launch.ts) onto
 * the account the page shows — the view token in the form is enough, since a code can only ADD to an account.
 * `action=email` / `email_remove` set or remove the optional contact email (src/email.ts), and ONLY from the browser
 * that owns the account: an address receives the account's video links, and a shared link must never be able to
 * point them somewhere else.
 */
export async function handleCredits(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const url = new URL(request.url);
  const ownerId = await verifyHandle(env, cookieHandle(request.headers.get("cookie")));
  const form = request.method === "POST" ? await request.formData().catch(() => null) : null;
  const token = form ? String(form.get("k") ?? "") : url.searchParams.get("k");
  const userId = (await verifyViewToken(env, token)) ?? ownerId;
  let user = userId ? await getUser(env, userId) : null;
  if (!user) return html(page({ user: null, handle: "", env, open: false, paid: false, trial: null, viewToken: "" }), 404);
  let notice: Notice | null = null;
  if (form) {
    const action = String(form.get("action") ?? "");
    if (action === "redeem") {
      const r = await redeemLaunchCode(env, user.id, form.get("code"));
      notice = r.ok
        ? { ok: true, text: `Code ${r.code} redeemed: ${plural(r.credits, "credit")} added, and one free film of up to ${TRIAL_FILM_MAX_S} seconds is open on this account, paid with them (spending them on something else closes it). Ask your assistant for it.` }
        : { ok: false, text: r.message };
    } else if (action === "email" || action === "email_remove") {
      if (ownerId !== user.id) notice = { ok: false, text: "An email can be added only from the browser that owns this account (the one you connected Kleo from). Nothing was changed." };
      else if (action === "email_remove") notice = { ok: true, text: (await removeContactEmail(env, user.id, "account page")) ? "Your email was removed: Kleo will not email you again." : "There was no email on this account." };
      else {
        const r = await setContactEmail(env, user.id, form.get("email"), env.PUBLIC_URL || url.origin);
        notice = { ok: r.ok, text: r.message };
      }
    }
    user = (await getUser(env, user.id)) ?? user;
  }
  // Only the browser that IS this account sees the key; a shared link shows the balance and nothing worth stealing.
  const key = ownerId === user.id ? await makeHandle(env, user.id) : "";
  const paid = await hasPaid(env, user.id);
  const refCode = await referralCodeFor(env, user.id);
  const invite = refCode ? referralLink(env.PUBLIC_URL || url.origin, refCode) : null;
  return html(page({ user, handle: key, env, open: await sellingAvailable(env), paid, trial: paid ? null : await trialOf(env, user.id), viewToken: await makeViewToken(env, user.id), notice, invite,
    owner: ownerId === user.id, contact: await contactEmailOf(env, user.id) }), notice && !notice.ok ? 400 : 200);
}

/** What the page says after one of its forms was sent. */
interface Notice { ok: boolean; text: string }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * THE EMAIL BOX (27 September 2026, src/email.ts): what the account has (verified, waiting, none) and the form — only
 * for the browser that owns the account; a shared link is told where to do it instead. While Kleo cannot send email
 * (no RESEND_API_KEY) the box never promises the bonus as if it were one click away: the address can still be saved,
 * and the page says its link and its credits come when the emails are switched on.
 */
function emailBlock(o: PageOpts, hidden: string): string {
  const sending = emailConfigured(o.env);
  const use = "Kleo uses it only for your videos and Kleo news, and every email has a link to stop them.";
  const why = sending
    ? `+${EMAIL_BONUS} credits once it is verified, and every finished video's links in your inbox. ${use}`
    : `Kleo's emails are not switched on yet. An address saved here gets its verification link when they are, and +${EMAIL_BONUS} credits once it is verified, then every finished video's links in your inbox. ${use}`;
  if (!o.owner) return `<h2>Email (optional)</h2>
<p>Add an email: ${why} Open this page in the browser you connected Kleo from to add it: a shared link cannot change the account.</p>`;
  const c = o.contact ?? { email: null, verified: false };
  const form = (label: string) => `<form class="row" method="post" action="/credits">${hidden}<input type="hidden" name="action" value="email"><input name="email" type="email" autocomplete="email" placeholder="you@example.com" aria-label="Email" required maxlength="254"${c.email ? ` value="${escapeHtml(c.email)}"` : ""}><button type="submit">${label}</button></form>`;
  const remove = `<form method="post" action="/credits">${hidden}<input type="hidden" name="action" value="email_remove"><button class="link" type="submit">Remove my email</button></form>`;
  if (c.email && c.verified) return `<h2>Email</h2>
<p>Verified: ${escapeHtml(c.email)}. Kleo emails you the links of every finished video.</p>${remove}`;
  if (c.email && !sending) return `<h2>Email</h2>
<p>Saved, not verified yet: ${escapeHtml(c.email)}. ${why}</p>${remove}`;
  if (c.email) return `<h2>Email</h2>
<p>Waiting for verification: ${escapeHtml(c.email)}. Open the link Kleo sent (check the spam folder too); ${why}</p>${form("Send the link again")}${remove}`;
  return `<h2>Email (optional)</h2>
<p>Add your email: ${why}</p>${form("Add")}`;
}

interface PageOpts { user: User | null; handle: string; env: Env; open: boolean; paid: boolean; trial: TrialState | null; viewToken: string; notice?: Notice | null; invite?: string | null; owner?: boolean; contact?: ContactEmail }

function page(o: PageOpts): string {
  const { user, handle, env, paid, trial } = o;
  const open_ = o.open;
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
  const hidden = `<input type="hidden" name="k" value="${escapeHtml(o.viewToken)}">`;
  // THE LAUNCH CODE (27 September 2026, src/launch.ts): the box while the account has none; its state once it has one.
  const launch = paid ? "" : trial
    ? `<h2>Launch code</h2>
<p>${escapeHtml(trial.code)}: ${trial.available ? `one free film of up to ${TRIAL_FILM_MAX_S} seconds is open on this account, paid with the ${trial.price} credits the code added. Ask your assistant for it.` : trial.held_by ? `its free film is taken (video ${escapeHtml(trial.held_by)}).` : `its free film was paid with the ${trial.price} credits the code added, and ${trial.credits_short} of them have been spent on something else, so the film is no longer open. Any pack opens films again.`}</p>`
    : `<h2>Have a launch code?</h2>
<p>A code from Product Hunt, Hacker News, Reddit, X or TikTok opens one free film of up to ${TRIAL_FILM_MAX_S} seconds on this account, even before any pack. One code per account.</p>
<form class="row" method="post" action="/credits">${hidden}<input type="hidden" name="action" value="redeem"><input name="code" type="text" autocomplete="off" placeholder="PRODUCTHUNT" aria-label="Launch code" required maxlength="40" style="text-transform:uppercase"><button type="submit">Redeem</button></form>`;
  const notice = o.notice ? `<div class="${o.notice.ok ? "ok" : "badge"}" role="status">${escapeHtml(o.notice.text)}</div>` : "";
  const body = user
    ? `${notice}<h1>${escapeHtml(plural(user.credits, "credit"))} left</h1>
<p>${tariffSentence()}. A film (every shot a generated clip) is made for accounts that have bought a pack; the animatic is open to every account. ${paid ? "This account has bought a pack: it can order films and animatics." : `This account has not bought a pack yet: it can order animatics (${animaticRule().en}); the film opens with any pack${trial?.available ? `, and the launch code opens one film of up to ${TRIAL_FILM_MAX_S} seconds` : ""}.`} The credits come back in full if a render fails, or if you cancel it before it starts; cancelling part-way through gives back the part that was not rendered.</p>
${launch}
<h2>Credit packs</h2>
${open_ ? `<p>Payment is handled by Stripe: Kleo never sees your card. Credits land on this account within a few seconds of paying, and the page shows the new balance when you reload it.</p>` : configured ? `<div class="badge">Credit packs are paused for a moment: Kleo is topping up its rendering capacity so that every credit sold can actually be rendered. Try again in a little while - nothing is wrong with your account.</div>` : `<div class="badge">Card payments are not open yet - Kleo is free while it is in beta.</div>`}
<ul class="packs">${packs}</ul>
${open_ ? `<p>One payment, no subscription, nothing renews. Credits do not expire.</p>` : `<p>These are the prices the packs will have. When they open, this page is where you will buy them - nothing else about Kleo changes.</p>`}
${emailBlock(o, hidden)}
${o.invite ? `<h2>Invite a friend</h2>
<p>Share this link: ${referralRule()}.</p>
<code class="key">${escapeHtml(o.invite)}</code>` : ""}
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
.ok{border:1px solid #6FCF97;color:var(--ink);border-radius:8px;padding:10px 12px;font-size:.9rem;margin-bottom:14px}
.badge{margin-bottom:14px}
.row{display:flex;gap:8px;margin:8px 0 14px}.row input{flex:1;min-width:0;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit}
.row button{padding:10px 14px;border-radius:8px;border:0;background:var(--amber);color:var(--amber-ink);font:600 .95rem/1 inherit;cursor:pointer}
button.link{background:none;border:0;padding:0;color:var(--mute);font:inherit;font-size:.85rem;text-decoration:underline;cursor:pointer;margin-bottom:14px}
</style></head><body><main class="card">
<div class="brand"><svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="7" width="26" height="22" rx="5" fill="#F3B53F"/><path d="M3 12h26v4H3z" fill="#1A1200" opacity=".85"/><path d="M7 12l3.5 4M13 12l3.5 4M19 12l3.5 4" stroke="#F3B53F" stroke-width="1.6"/><path d="M10 19v8M10 23l6-4M10 23l6 4" stroke="#1A1200" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>Kleo <span>ACCOUNT</span></div>
${body}
</main></body></html>`;
}
