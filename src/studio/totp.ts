/**
 * KLEO STUDIO — THE ADMIN CONSOLE'S SECOND FACTOR, THE CRYPTOGRAPHY (23 October 2026).
 *
 * Time-based one-time codes as RFC 6238 defines them and every authenticator reads them: HMAC-SHA-1, 6 digits, a new
 * code every 30 seconds, the shared secret in base32 (RFC 4648). The iPhone Passwords app, Google Authenticator and
 * 1Password all take the same `otpauth://totp/...` link. A code is accepted one step either side of now (clock drift),
 * and never twice: the caller keeps the last step used.
 *
 * The secret is stored encrypted (AES-GCM, a key derived from INTERNAL_SECRET), the recovery codes only as keyed
 * hashes. Pure WebCrypto, so the tests import it under Node's type stripping.
 */
const enc = new TextEncoder();
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let out = "", bits = 0, value = 0;
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("Not base32.");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** RFC 4226: the code of one counter value. */
export async function hotp(secret: Uint8Array, counter: number, digits = 6): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const TOTP_STEP_S = 30;
export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_S);

/**
 * The step a typed code belongs to, within `window` steps of now and after `afterStep` (a code is used once), or null.
 * Every candidate is computed, so the time taken says nothing about which one matched.
 */
export async function verifyTotp(secret: Uint8Array, code: string, nowMs = Date.now(), afterStep = 0, window = 1): Promise<number | null> {
  const typed = String(code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const now = stepAt(nowMs);
  let hit: number | null = null;
  for (let s = now - window; s <= now + window; s++) {
    const ok = sameText(await hotp(secret, s), typed);
    if (ok && s > afterStep && hit === null) hit = s;
  }
  return hit;
}

export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** The link an authenticator adds with one tap (on an iPhone, the Passwords app). */
export function otpauthUri(account: string, secretB32: string, issuer = "Kleo"): string {
  const label = `${encodeURIComponent(`${issuer} admin`)}:${encodeURIComponent(account)}`;
  // SHA-1, 6 digits and 30 seconds are every app's defaults: left out, the QR code stays small and easy to scan.
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}`;
}

export const newSecret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(20));

// ── storage ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function aesKey(masterSecret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`kleo-admin-totp-key:${masterSecret}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** "v1.<iv>.<ciphertext>", both base64; the user id is bound in as additional data. */
export async function sealSecret(masterSecret: string, userId: string, secret: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(userId) }, await aesKey(masterSecret), secret));
  return `v1.${b64(iv)}.${b64(ct)}`;
}
export async function openSecret(masterSecret: string, userId: string, sealed: string): Promise<Uint8Array> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unknown sealed secret.");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(userId) }, await aesKey(masterSecret), unb64(ct)));
}

// ── recovery codes ───────────────────────────────────────────────────────────────────────────────────────────────

const RC = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i: read aloud and typed on a phone
/** Ten codes like "k7m2-q9xd-4tpa", each good for one sign-in when the phone is lost. */
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const r = crypto.getRandomValues(new Uint8Array(12));
    const s = [...r].map((b) => RC[b % RC.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
  });
}
export const normalizeRecovery = (code: string): string => String(code ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
export async function hashRecovery(masterSecret: string, userId: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(masterSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`kleo-admin-recovery:${userId}:${normalizeRecovery(code)}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}
