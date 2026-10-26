/**
 * API KEYS CHANGED FROM THE ADMIN CONSOLE (23 October 2026, the owner: "una sezione per le key, in modo che posso
 * cambiare le api key quando ho bisogno nel pannello admin").
 *
 * A Worker's secrets can only be rewritten through Cloudflare's API with a token that may also upload the Worker's
 * code: kept in the Worker, a stolen console would own the whole app. So the console never touches Worker secrets.
 * A key typed there is stored in D1 instead (table key_overrides), sealed with AES-GCM under a key derived from
 * INTERNAL_SECRET and bound to the key's name, and on every request both Workers (kleo-studio and kleo-mcp, which share
 * D1 and INTERNAL_SECRET) read env through withKeys(): a stored key wins over the Worker secret of the same name.
 * Deleting the row goes back to the Worker secret.
 *
 * Only the provider keys below can be changed this way. INTERNAL_SECRET (it seals these rows and signs every session),
 * Stripe's and Google's secrets stay terminal-only. Nothing here ever returns a key: callers see its last four
 * characters. A row that cannot be read or opened is ignored, so a broken table never stops the app.
 */
const enc = new TextEncoder();

/** The keys the console may change, what each is for, and the shape a real one has. */
export const EDITABLE_KEYS: { name: string; purpose: string; shape: RegExp }[] = [
  { name: "EPHONE_API_KEY", purpose: "ePhone: every video, picture and app, and the chat agent", shape: /^sk-[A-Za-z0-9_-]{16,200}$/ },
  { name: "EPHONE_ADMIN_KEY", purpose: "ePhone admin key, read only (account:read): reads the balance live", shape: /^sk-admin-[A-Za-z0-9_-]{8,200}$/ },
  { name: "WAVESPEED_API_KEY", purpose: "WaveSpeed: viral templates and backups", shape: /^[A-Za-z0-9_-]{16,200}$/ },
  { name: "APIMART_API_KEY", purpose: "APIMart: backup of most models", shape: /^sk-[A-Za-z0-9_-]{16,200}$/ },
  { name: "RESEND_API_KEY", purpose: "Password reset e-mails", shape: /^re_[A-Za-z0-9_-]{8,200}$/ },
  { name: "CF_ANALYTICS_TOKEN", purpose: "Finds the address of past sign-ins in Cloudflare's logs", shape: /^[A-Za-z0-9_-]{30,200}$/ },
  // 27 Oct 2026: the outreach mailbox (src/studio/outreach.ts), usually set on the console's Outreach page with the sender.
  { name: "OUTREACH_SMTP_PASS", purpose: "Outreach mailbox: the app password Kleo sends and reads replies with", shape: /^[\x21-\x7e]{8,200}$/ },
];
export const isEditableKey = (name: string): boolean => EDITABLE_KEYS.some((k) => k.name === name);
/** Why a value cannot be the key `name`, or null. An ePhone admin key is never accepted as the model key (and back). */
export function keyShapeProblem(name: string, value: string): string | null {
  const k = EDITABLE_KEYS.find((x) => x.name === name);
  if (!k) return "That key can't be changed from the console.";
  if (!k.shape.test(value)) return "That doesn't look like this key: check you copied all of it, with no spaces.";
  if (name === "EPHONE_API_KEY" && value.startsWith("sk-admin-")) return "That is an ePhone admin key. This one is the key that makes videos (sk-…).";
  return null;
}

export const KEY_OVERRIDES_SCHEMA = `CREATE TABLE IF NOT EXISTS key_overrides (
    name TEXT PRIMARY KEY, sealed TEXT NOT NULL, last4 TEXT NOT NULL, set_at TEXT NOT NULL, set_by TEXT)`;

export interface OverrideRow { name: string; sealed: string; last4: string; set_at: string; set_by: string | null }

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`kleo-key-override:${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** "v1.<iv>.<ciphertext>", the key's name bound in as additional data (a row moved to another name does not open). */
export async function sealKey(secret: string, name: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(name) }, await aesKey(secret), enc.encode(value)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}
export async function openKey(secret: string, name: string, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unknown sealed key.");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(name) }, await aesKey(secret), unb64(ct)));
}
export const last4 = (value: string): string => value.slice(-4);

type KeyEnv = { DB: D1Database; INTERNAL_SECRET: string };
/** How long one isolate trusts what it read (a change made on another isolate reaches this one within this time). */
const CACHE_MS = 60_000;
let cache: { at: number; secret: string; values: Record<string, string> } | null = null;
/** Forgets what this isolate read: the console calls it after a change, so the change applies at once here. */
export const forgetKeys = (): void => { cache = null; };

/** The stored keys, opened. Never throws: an unreadable table or row gives fewer overrides, never an error. */
export async function storedKeys(env: KeyEnv, nowMs = Date.now()): Promise<Record<string, string>> {
  if (cache && cache.secret === env.INTERNAL_SECRET && nowMs - cache.at < CACHE_MS) return cache.values;
  const values: Record<string, string> = {};
  try {
    const rows = (await env.DB.prepare("SELECT name, sealed FROM key_overrides").all<{ name: string; sealed: string }>()).results ?? [];
    for (const r of rows) {
      if (!isEditableKey(r.name)) continue;
      try { values[r.name] = await openKey(env.INTERNAL_SECRET, r.name, r.sealed); } catch { /* a row that does not open is ignored */ }
    }
  } catch { /* no table yet */ }
  cache = { at: nowMs, secret: env.INTERNAL_SECRET, values };
  return values;
}

/** env with the console's keys in place of the Worker secrets of the same name; the same object when there are none. */
export async function withKeys<E extends KeyEnv>(env: E, nowMs = Date.now()): Promise<E> {
  const values = await storedKeys(env, nowMs);
  return Object.keys(values).length ? { ...env, ...values } : env;
}
