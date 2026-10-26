/**
 * KLEO STUDIO — THE ADMIN CONSOLE'S KEYS PAGE (23 October 2026, the owner: "una sezione per le key, in modo che posso
 * cambiare le api key quando ho bisogno nel pannello admin"). Storage and the override itself: src/key-overrides.ts.
 *
 *   GET  /api/admin/keys                 every changeable key: where the one in use comes from, its last 4 characters
 *   POST /api/admin/keys/:name/test      asks the provider whether the key in use works (free reads only)
 *   POST /api/admin/keys/:name           {value, reason, code}  a new key: checked for shape, tried live, then stored
 *   POST /api/admin/keys/:name/revert    {reason, code}         back to the Worker secret
 *
 * A change or a revert is a dangerous write: it wants a code from the owner's phone typed in the last 5 minutes, is
 * audited with the key's last 4 characters only, and mails the owner. A key that fails its live test is not stored.
 * No answer ever carries a key.
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { audit } from "../db.ts";
import { StudioError } from "./generate.ts";
import { mailOwner } from "./providers.ts";
import { EDITABLE_KEYS, forgetKeys, isEditableKey, keyShapeProblem, last4, sealKey, type OverrideRow } from "../key-overrides.ts";
import { senderOf } from "./outreach.ts";
import { smtpSend, socketDial } from "./mailbox.ts";

/** Secrets that stay terminal-only, listed so the page says where they are changed. */
export const TERMINAL_ONLY = ["INTERNAL_SECRET", "STRIPE_SECRET_KEY", "GOOGLE_CLIENT_SECRET", "TURNSTILE_SECRET"];

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });

async function getJson(url: string, auth: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(8_000) });
  let body: any = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}
const usd = (n: unknown) => `$${Number(n).toFixed(2)}`;

/** Whether a key works, asked of its provider with a free read. Never throws. */
export async function testKey(env: Pick<StudioEnv, "EPHONE_API_URL">, name: string, value: string): Promise<{ ok: boolean; detail: string }> {
  if (!value) return { ok: false, detail: "No key is set." };
  const ephone = (env.EPHONE_API_URL ?? "https://api.ephone.ai").replace(/\/v1\/?$/, "").replace(/\/$/, "");
  try {
    if (name === "EPHONE_API_KEY") {
      const r = await getJson(`${ephone}/api/usage/token`, `Bearer ${value}`);
      return r.status === 200 && r.body?.code === true ? { ok: true, detail: "ePhone accepts this key." } : { ok: false, detail: `ePhone refused this key (${r.status}).` };
    }
    if (name === "EPHONE_ADMIN_KEY") {
      const r = await getJson(`${ephone}/api/user/self`, `Bearer ${value}`);
      return r.status === 200 && r.body?.success !== false && r.body?.data?.balance !== undefined
        ? { ok: true, detail: `ePhone accepts this key: ${usd(r.body.data.balance)} on the account.` } : { ok: false, detail: `ePhone refused this key (${r.status}).` };
    }
    if (name === "WAVESPEED_API_KEY") {
      const r = await getJson("https://api.wavespeed.ai/api/v3/balance", `Bearer ${value}`);
      return r.status === 200 && r.body?.data?.balance !== undefined ? { ok: true, detail: `WaveSpeed accepts this key: ${usd(r.body.data.balance)} on the account.` } : { ok: false, detail: `WaveSpeed refused this key (${r.status}).` };
    }
    if (name === "APIMART_API_KEY") {
      const r = await getJson("https://api.apimart.ai/v1/user/balance", `Bearer ${value}`);
      return r.status === 200 && r.body?.success !== false && r.body?.remain_balance !== undefined ? { ok: true, detail: `APIMart accepts this key: ${usd(r.body.remain_balance)} left.` } : { ok: false, detail: `APIMart refused this key (${r.status}).` };
    }
    if (name === "RESEND_API_KEY") {
      // A sending-only key may not list domains (401 restricted_api_key), and that still proves the key exists.
      const r = await getJson("https://api.resend.com/domains", `Bearer ${value}`);
      return r.status === 200 || (r.status === 401 && /restricted/i.test(JSON.stringify(r.body ?? ""))) ? { ok: true, detail: "Resend accepts this key." } : { ok: false, detail: `Resend refused this key (${r.status}).` };
    }
    if (name === "OUTREACH_SMTP_PASS") {
      const s = await senderOf(env as StudioEnv);
      if (!s.smtpHost || !s.user) return { ok: false, detail: "Set the outreach sender first, on the Outreach page." };
      await smtpSend(socketDial, { host: s.smtpHost, port: s.smtpPort, user: s.user, pass: value.replace(/\s+/g, "") });
      return { ok: true, detail: `${s.smtpHost} accepts this password for ${s.user}.` };
    }
    if (name === "CF_ANALYTICS_TOKEN") {
      const r = await getJson("https://api.cloudflare.com/client/v4/user/tokens/verify", `Bearer ${value}`);
      return r.status === 200 && r.body?.result?.status === "active" ? { ok: true, detail: "Cloudflare says this token is active." } : { ok: false, detail: `Cloudflare refused this token (${r.status}).` };
    }
  } catch {
    return { ok: false, detail: "The provider did not answer. Try again in a minute." };
  }
  return { ok: false, detail: "This key can't be tested." };
}

/** The Keys page: every changeable key and where the one in use comes from (never the key). */
export async function listKeys(env: StudioEnv): Promise<Record<string, unknown>> {
  const rows = new Map<string, OverrideRow>();
  try { for (const r of (await env.DB.prepare("SELECT name, last4, set_at, set_by FROM key_overrides").all<OverrideRow>()).results) rows.set(r.name, r); } catch { /* no table yet */ }
  const e = env as unknown as Record<string, unknown>;
  return {
    keys: EDITABLE_KEYS.map(({ name, purpose }) => {
      const row = rows.get(name);
      const value = typeof e[name] === "string" ? (e[name] as string) : "";
      return row ? { name, purpose, source: "console", last4: row.last4, setAt: row.set_at, setBy: row.set_by }
        : { name, purpose, source: value ? "worker" : "none", last4: value ? last4(value) : null };
    }),
    terminalOnly: TERMINAL_ONLY.map((name) => ({ name, set: typeof e[name] === "string" && (e[name] as string).length > 0 })),
  };
}

/** Change, revert or test one key. `fresh` is asked for by the router (admin.ts) before a change or a revert. */
export async function keyAction(env: StudioEnv, adminId: string, name: string, action: "set" | "revert" | "test", b: Record<string, unknown>, reason: string): Promise<Response> {
  if (!isEditableKey(name)) throw new StudioError("That key can't be changed from the console.", 404, "not_found");
  const e = env as unknown as Record<string, unknown>;
  if (action === "test") return json(await testKey(env, name, typeof e[name] === "string" ? (e[name] as string) : ""));
  const log = (event: string, detail: Record<string, unknown>) => audit(env as unknown as Env, null, null, event, { admin: adminId, reason, key: name, ...detail });
  if (action === "revert") {
    await env.DB.prepare("DELETE FROM key_overrides WHERE name = ?").bind(name).run();
    forgetKeys();
    await log("admin.key_revert", {});
    await mailOwner(env, `Kleo admin: ${name} is back to its Worker secret`, `${name} was set back to the Worker secret from the admin console.\n\nReason: ${reason}\n`);
    return json({ ok: true });
  }
  const value = String(b.value ?? "").trim();
  const bad = keyShapeProblem(name, value);
  if (bad) throw new StudioError(bad, 400, "key_shape");
  const tried = await testKey(env, name, value);
  if (!tried.ok) throw new StudioError(`${tried.detail} Nothing was changed.`, 400, "key_test", { detail: tried.detail });
  await env.DB.prepare(`INSERT INTO key_overrides (name, sealed, last4, set_at, set_by) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
      ON CONFLICT(name) DO UPDATE SET sealed = excluded.sealed, last4 = excluded.last4, set_at = excluded.set_at, set_by = excluded.set_by`)
    .bind(name, await sealKey(env.INTERNAL_SECRET, name, value), last4(value), adminId).run();
  forgetKeys();
  await log("admin.key_set", { last4: last4(value) });
  await mailOwner(env, `Kleo admin: ${name} was changed (…${last4(value)})`, `${name} was changed from the admin console. The new key ends in ${last4(value)} and passed its live test: ${tried.detail}\n\nReason: ${reason}\n\nIf this was not you, sign the console out everywhere and change your password.\n`);
  return json({ ok: true, last4: last4(value), detail: tried.detail });
}
