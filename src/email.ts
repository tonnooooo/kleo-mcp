import type { Env } from "./env";
import { audit, countAuditTodayForUser } from "./db.ts";
import { escapeHtml, hmacHex, html, rid, safeEqual } from "./util.ts";

/**
 * THE OPTIONAL, VERIFIED EMAIL (27 September 2026, the owner: "attract people and make them stay"). Kleo accounts are
 * anonymous and stay so: users.email is a synthetic <id>@anon.kleo.invalid. An owner may add a real address on the
 * account page (/credits, src/credits.ts — only from the browser that owns the account, never through a shared link);
 * Kleo mails a verification link, and once it is opened:
 *  · +EMAIL_BONUS credits, once per account AND once per address (email_bonus: the address is the primary key and
 *    the account is unique, so neither a second address nor a second account gets it again);
 *  · every finished video's links are mailed to that address (src/notify.ts), with an unsubscribe link that removes it.
 * The address is used for delivery and Kleo news only, and never leaves Kleo except to the mail provider.
 *
 * The provider is the one Kleo already had for notify_email: Resend (RESEND_API_KEY, NOTIFY_FROM). Without the key
 * nothing is sent: the address is kept unverified, no bonus is given, and the page says the emails are not switched
 * on yet — the same way notify.ts always stayed silent without it.
 */

export const EMAIL_BONUS = 3;
/** Verification mails one account may ask for in a UTC day: a form must not become a way to mail strangers. */
export const VERIFY_SENDS_PER_DAY = 3;
/** How long a verification link works. */
const VERIFY_TTL_S = 3 * 24 * 3600;

/** An address as stored: trimmed, lower case, one @, a dot in the domain, no spaces; null when it is not one. */
export function normalizeEmail(raw: unknown): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/.test(e)) return null;
  if (e.endsWith(".invalid")) return null;
  return e;
}

export const emailConfigured = (env: Pick<Env, "RESEND_API_KEY">): boolean => !!(env.RESEND_API_KEY && env.RESEND_API_KEY.trim());

/**
 * One email through Resend. True when Resend accepted it; false without a key or on any refusal (the caller writes
 * the audit row). `unsubscribe` adds the List-Unsubscribe header mail clients show as a button.
 */
export async function sendEmail(env: Env, m: { to: string; subject: string; text: string; unsubscribe?: string }): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  const body: Record<string, unknown> = {
    from: env.NOTIFY_FROM || "Kleo <noreply@kleooai.com>",
    to: [m.to], subject: m.subject, text: m.text,
    ...(m.unsubscribe ? { headers: { "List-Unsubscribe": `<${m.unsubscribe}>` } } : {}),
  };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface ContactEmail { email: string | null; verified: boolean }
export async function contactEmailOf(env: Env, userId: string): Promise<ContactEmail> {
  const r = await env.DB.prepare("SELECT contact_email, contact_email_verified_at FROM users WHERE id = ?").bind(userId)
    .first<{ contact_email: string | null; contact_email_verified_at: string | null }>();
  return { email: r?.contact_email ?? null, verified: !!(r?.contact_email && r.contact_email_verified_at) };
}

const b64url = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string): string | null => {
  try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))); } catch { return null; }
};

export async function verifyLink(env: Env, base: string, userId: string, email: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const exp = nowS + VERIFY_TTL_S;
  const sig = await hmacHex(env.INTERNAL_SECRET, `kleo-email:${userId}:${email}:${exp}`);
  return `${base}/email/verify?u=${encodeURIComponent(userId)}&e=${b64url(email)}&exp=${exp}&sig=${sig}`;
}
export async function unsubscribeLink(env: Env, base: string, userId: string): Promise<string> {
  const sig = (await hmacHex(env.INTERNAL_SECRET, `kleo-unsub:${userId}`)).slice(0, 32);
  return `${base}/email/unsubscribe?u=${encodeURIComponent(userId)}&sig=${sig}`;
}

export type SetEmailResult =
  | { ok: true; sent: boolean; email: string; message: string }
  | { ok: false; message: string };

/**
 * Stores the address the owner typed (unverified until its link is opened) and mails the link. The same address
 * already verified is left as it is; a new one replaces the old and has to be verified again.
 */
export async function setContactEmail(env: Env, userId: string, raw: unknown, base: string): Promise<SetEmailResult> {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, message: "That does not look like an email address. Nothing was changed." };
  const now = await contactEmailOf(env, userId);
  if (now.email === email && now.verified) return { ok: true, sent: false, email, message: `${email} is already verified on this account.` };
  if (now.email !== email)
    await env.DB.prepare("UPDATE users SET contact_email = ?, contact_email_verified_at = NULL WHERE id = ?").bind(email, userId).run();
  await audit(env, userId, null, "email.set", { domain: email.split("@")[1] });
  if (!emailConfigured(env))
    return { ok: true, sent: false, email, message: `${email} is saved on this account. Kleo's emails are not switched on yet, so it cannot be verified today: the ${EMAIL_BONUS} credits come when it is.` };
  if ((await countAuditTodayForUser(env, userId, "email.verify_sent")) >= VERIFY_SENDS_PER_DAY)
    return { ok: false, message: `Kleo has already sent ${VERIFY_SENDS_PER_DAY} verification emails for this account today. Check your inbox and spam folder, or try again tomorrow.` };
  const link = await verifyLink(env, base, userId, email);
  const sent = await sendEmail(env, {
    to: email,
    subject: "Verify your email for Kleo",
    text: `Open this link to verify your email on your Kleo account and get ${EMAIL_BONUS} free credits:\n\n${link}\n\nOnce it is verified, Kleo emails you the links of every finished video. Kleo uses this address only for your videos and Kleo news, and every email has a link to stop them.\n\nIf you did not ask for this, ignore this email: nothing happens without the click.`,
  });
  await audit(env, userId, null, sent ? "email.verify_sent" : "email.verify_failed", { domain: email.split("@")[1] });
  return sent
    ? { ok: true, sent: true, email, message: `A verification link is on its way to ${email}. Open it and ${EMAIL_BONUS} credits land on this account.` }
    : { ok: false, message: `Kleo could not send the verification email to ${email} right now. The address is saved; try again in a little while.` };
}

/** Removes the address (the account page's button, or the unsubscribe link): no more emails, nothing else changes. */
export async function removeContactEmail(env: Env, userId: string, via: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE users SET contact_email = NULL, contact_email_verified_at = NULL WHERE id = ? AND contact_email IS NOT NULL").bind(userId).run();
  const removed = (r.meta.changes ?? 0) === 1;
  if (removed) await audit(env, userId, null, "email.removed", { via });
  return removed;
}

/**
 * Opens a verification link: the signature, the expiry and the address still being the account's. Verifies it and
 * gives the bonus once — one batch, the email_bonus row (address primary key, account unique) first, the credits only
 * if THAT row (its nonce) exists.
 */
export async function verifyContactEmail(env: Env, q: URLSearchParams, nowS = Math.floor(Date.now() / 1000)): Promise<{ ok: boolean; bonus: number; message: string }> {
  const userId = q.get("u") ?? "";
  const email = unb64url(q.get("e") ?? "") ?? "";
  const exp = Number(q.get("exp") ?? 0);
  const sig = q.get("sig") ?? "";
  const bad = { ok: false, bonus: 0, message: "This verification link is not valid. Ask for a new one on your Kleo account page." };
  if (!userId || !email || !Number.isFinite(exp) || !sig) return bad;
  if (!safeEqual(sig, await hmacHex(env.INTERNAL_SECRET, `kleo-email:${userId}:${email}:${exp}`))) return bad;
  if (exp < nowS) return { ok: false, bonus: 0, message: "This verification link has expired. Ask for a new one on your Kleo account page." };
  const now = await contactEmailOf(env, userId);
  if (now.email !== email) return { ok: false, bonus: 0, message: "This address is no longer the one on the account. Ask for a new link on your Kleo account page." };
  await env.DB.prepare("UPDATE users SET contact_email_verified_at = COALESCE(contact_email_verified_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ? AND contact_email = ?").bind(userId, email).run();
  const nonce = rid("em", 12);
  const rows = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO email_bonus (email, user_id, credits, nonce) VALUES (?, ?, ?, ?)").bind(email, userId, EMAIL_BONUS, nonce),
    env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ? AND EXISTS (SELECT 1 FROM email_bonus WHERE user_id = ? AND nonce = ?)").bind(EMAIL_BONUS, userId, userId, nonce),
  ]);
  const bonus = (rows[0]?.meta.changes ?? 0) === 1 ? EMAIL_BONUS : 0;
  await audit(env, userId, null, "email.verified", { domain: email.split("@")[1], ...(bonus ? { amount: bonus } : {}) });
  return { ok: true, bonus, message: bonus
    ? `Your email is verified: ${EMAIL_BONUS} credits were added to your Kleo account, and every finished video's links will be emailed to ${email}.`
    : `Your email is verified: every finished video's links will be emailed to ${email}. (The ${EMAIL_BONUS}-credit bonus is given once per account and once per address.)` };
}

/** Where a finished job's links are mailed: the address given with the job, else the account's verified one. */
export async function deliveryAddressFor(env: Env, job: { user_id: string; notify_email: string | null }): Promise<{ to: string; contact: boolean } | null> {
  if (job.notify_email) return { to: job.notify_email, contact: false };
  const c = await contactEmailOf(env, job.user_id);
  return c.email && c.verified ? { to: c.email, contact: true } : null;
}

/** GET /email/verify and GET /email/unsubscribe: the two links Kleo mails, answered with a one-line page. */
export async function handleEmailLink(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/email/verify") {
    const r = await verifyContactEmail(env, url.searchParams);
    return html(emailPage(r.ok ? "Email verified" : "Link not valid", r.message), r.ok ? 200 : 400);
  }
  if (url.pathname === "/email/unsubscribe") {
    const userId = url.searchParams.get("u") ?? "";
    const sig = url.searchParams.get("sig") ?? "";
    const want = userId ? (await hmacHex(env.INTERNAL_SECRET, `kleo-unsub:${userId}`)).slice(0, 32) : "";
    if (!userId || !safeEqual(sig, want)) return html(emailPage("Link not valid", "This unsubscribe link is not valid. Write to kleooai@gmail.com and we will remove your address by hand."), 400);
    await removeContactEmail(env, userId, "unsubscribe");
    return html(emailPage("Unsubscribed", "Your address was removed from your Kleo account: Kleo will not email you again. Your account and credits are unchanged."));
  }
  return new Response("Not found", { status: 404 });
}

const emailPage = (title: string, text: string): string => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Kleo</title><meta name="robots" content="noindex">
<style>:root{color-scheme:dark}body{margin:0;background:#0F1216;color:#ECEAE4;font:16px/1.55 "Helvetica Neue",Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px 16px}
main{width:min(460px,100%);background:#151920;border:1px solid #262C36;border-radius:14px;padding:28px}h1{font-size:1.3rem;margin:0 0 8px}p{color:#838B99}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`;
