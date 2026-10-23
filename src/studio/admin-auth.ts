/**
 * KLEO STUDIO — SIGNING IN TO THE ADMIN CONSOLE (23 October 2026, the owner: "fai tutta la security per admin pannel").
 *
 * The console sits behind three locks, all checked on the server for every /api/admin/* call:
 *   1. the normal Studio session of an account listed in STUDIO_ADMINS (anyone else is told the console does not exist);
 *   2. a second factor: a 6-digit code from the owner's phone (RFC 6238, src/studio/totp.ts), or once each one of ten
 *      recovery codes;
 *   3. a separate admin session, the `__Host-kleo_admin` cookie: HttpOnly, Secure, SameSite=Strict, signed, bound to
 *      the account, its Studio epoch and the console's own session epoch. It ends after 30 idle minutes and 12 hours
 *      at most, at "sign out everywhere", and when the owner signs the console out.
 *
 * The dangerous writes (delete or close an account, a credit change over 100, a new Kleo key, signing another account
 * out everywhere) also want a code typed in the last 5 minutes (`fresh`).
 *
 * Five wrong codes lock the console for 15 minutes. The owner gets an e-mail (providers.ts mailOwner) at every console
 * sign-in, every wrong code, a lock, a second factor set up and a recovery code used, with the address, place, network
 * and device of the request.
 *
 * SETTING UP happens once and needs the account's password typed again (or a Google sign-in in the last 5 minutes), so
 * a stolen Studio cookie cannot enrol a thief's phone. RESETTING is not possible from the page: the owner deletes the
 * row with wrangler, then sets up again (docs/ADMIN-SECURITY.md).
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { audit } from "../db.ts";
import { StudioError } from "./generate.ts";
import { checkPassword, readCookie, safeEqual } from "./session.ts";
import { getLogin, loginsOf } from "./store.ts";
import { mailOwner } from "./providers.ts";
import { whereFrom } from "./ips.ts";
import {
  base32Encode, hashRecovery, newRecoveryCodes, newSecret, normalizeRecovery, openSecret, otpauthUri, sealSecret, stepAt, verifyTotp,
} from "./totp.ts";

export const ADMIN_COOKIE = "__Host-kleo_admin";
export const ADMIN_IDLE_MIN = 30;
export const ADMIN_MAX_H = 12;
export const FRESH_MIN = 5;
export const LOCK_AFTER = 5;
export const LOCK_MIN = 15;
export const REAUTH_MIN = 5;
const PENDING_MIN = 15;

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const sec = (ms: number) => Math.floor(ms / 1000);

export interface AdminRow {
  user_id: string; secret: string | null; pending: string | null; pending_at: string | null; enrolled_at: string | null;
  recovery: string | null; session_epoch: number; failed: number; locked_until: string | null; last_step: number;
}
const rowOf = (env: StudioEnv, userId: string) => env.DB.prepare("SELECT * FROM studio_admin WHERE user_id = ?").bind(userId).first<AdminRow>();
async function ensureRow(env: StudioEnv, userId: string): Promise<AdminRow> {
  await env.DB.prepare("INSERT OR IGNORE INTO studio_admin (user_id) VALUES (?)").bind(userId).run();
  return (await rowOf(env, userId))!;
}
const recoveryOf = (r: AdminRow | null): string[] => { try { return JSON.parse(r?.recovery ?? "[]"); } catch { return []; } };

// ── the admin session cookie ─────────────────────────────────────────────────────────────────────────────────────

/** All times in seconds: when the console was opened, last used, and when a code was last typed. */
export interface AdminSession { userId: string; epoch: number; sessEpoch: number; issued: number; seen: number; fresh: number }
const sessionMsg = (s: AdminSession) => `kleo-admin-session:${s.userId}:${s.epoch}:${s.sessEpoch}:${s.issued}:${s.seen}:${s.fresh}`;
async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function adminCookieValue(secret: string, s: AdminSession): Promise<string> {
  return `${s.userId}.${s.epoch}.${s.sessEpoch}.${s.issued}.${s.seen}.${s.fresh}.${(await hmacHex(secret, sessionMsg(s))).slice(0, 40)}`;
}
export async function readAdminCookie(secret: string, value: string | null | undefined): Promise<AdminSession | null> {
  const m = /^([A-Za-z0-9_-]{1,64})\.(\d{1,9})\.(\d{1,9})\.(\d{9,11})\.(\d{9,11})\.(\d{1,11})\.([0-9a-f]{40})$/.exec((value ?? "").trim());
  if (!m) return null;
  const s: AdminSession = { userId: m[1], epoch: Number(m[2]), sessEpoch: Number(m[3]), issued: Number(m[4]), seen: Number(m[5]), fresh: Number(m[6]) };
  return safeEqual(m[7], (await hmacHex(secret, sessionMsg(s))).slice(0, 40)) ? s : null;
}
export const adminCookie = (value: string): string => `${ADMIN_COOKIE}=${value}; Path=/; Max-Age=${ADMIN_MAX_H * 3600}; HttpOnly; Secure; SameSite=Strict`;
export const clearAdminCookie = (): string => `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

const studioEpoch = async (env: StudioEnv, userId: string): Promise<number> =>
  Number((await env.DB.prepare("SELECT studio_epoch FROM users WHERE id = ?").bind(userId).first<{ studio_epoch: number | null }>())?.studio_epoch ?? 0) || 0;

/** The open admin session of this request, or null (missing, forged, idle, too old, or ended since). */
export async function adminSessionOf(env: StudioEnv, request: Request, userId: string, nowMs = Date.now()): Promise<AdminSession | null> {
  const s = await readAdminCookie(env.INTERNAL_SECRET, readCookie(request.headers.get("cookie"), ADMIN_COOKIE));
  if (!s || s.userId !== userId) return null;
  const now = sec(nowMs);
  if (now - s.seen > ADMIN_IDLE_MIN * 60 || now - s.issued > ADMIN_MAX_H * 3600 || s.seen > now + 60) return null;
  const row = await rowOf(env, userId);
  if (!row?.secret || row.session_epoch !== s.sessEpoch) return null;
  return s.epoch === (await studioEpoch(env, userId)) ? s : null;
}

async function openSession(env: StudioEnv, userId: string, nowMs: number): Promise<string> {
  const row = await rowOf(env, userId);
  const now = sec(nowMs);
  return adminCookie(await adminCookieValue(env.INTERNAL_SECRET, { userId, epoch: await studioEpoch(env, userId), sessEpoch: row?.session_epoch ?? 0, issued: now, seen: now, fresh: now }));
}
/** The same session, used now (and with a code typed now when `fresh`). */
export async function touchSession(env: StudioEnv, s: AdminSession, nowMs = Date.now(), fresh = false): Promise<string> {
  const now = sec(nowMs);
  return adminCookie(await adminCookieValue(env.INTERNAL_SECRET, { ...s, seen: now, fresh: fresh ? now : s.fresh }));
}
export const isFresh = (s: AdminSession, nowMs = Date.now()): boolean => sec(nowMs) - s.fresh <= FRESH_MIN * 60;

// ── what the owner is told ───────────────────────────────────────────────────────────────────────────────────────

function where(request: Request): string {
  const w = whereFrom(request);
  return [
    `Address: ${w.ip ?? "unknown"}`,
    `Place: ${[w.city, w.region, w.country].filter(Boolean).join(", ") || "unknown"}`,
    `Network: ${w.asOrg ?? "unknown"}${w.asn ? ` (AS${w.asn})` : ""}`,
    `Device: ${w.ua ?? "unknown"}`,
    `Time: ${new Date().toUTCString()}`,
  ].join("\n");
}
const NOT_YOU = "If this was not you: change your Kleo password, then reset the admin code as docs/ADMIN-SECURITY.md says.";
async function tell(env: StudioEnv, request: Request, subject: string, lead: string, nowMs: number): Promise<void> {
  await mailOwner(env, `Kleo admin: ${subject}`, `${lead}\n\n${where(request)}\n\n${NOT_YOU}\n`, nowMs);
}
const auditDetail = (request: Request, extra: Record<string, unknown> = {}) => {
  const w = whereFrom(request);
  return { ip: w.ip, country: w.country, city: w.city, network: w.asOrg, ua: w.ua?.slice(0, 120), ...extra };
};

// ── checking a code ──────────────────────────────────────────────────────────────────────────────────────────────

function lockedFor(row: AdminRow | null, nowMs: number): number {
  const until = row?.locked_until ? Date.parse(row.locked_until) : 0;
  return until > nowMs ? Math.ceil((until - nowMs) / 60_000) : 0;
}
const lockedError = (min: number) => new StudioError(`Too many wrong codes. The console is locked for ${min} more ${min === 1 ? "minute" : "minutes"}.`, 429, "admin_locked", { minutes: min });

/** A wrong code (or password at set-up): counted, audited, mailed; the fifth in a row locks the console. */
async function wrong(env: StudioEnv, request: Request, userId: string, what: string, nowMs: number): Promise<never> {
  const row = await ensureRow(env, userId);
  const failed = (row.failed ?? 0) + 1;
  const lock = failed >= LOCK_AFTER;
  await env.DB.prepare("UPDATE studio_admin SET failed = ?, locked_until = ? WHERE user_id = ?")
    .bind(lock ? 0 : failed, lock ? new Date(nowMs + LOCK_MIN * 60_000).toISOString() : row.locked_until, userId).run();
  await audit(asEnv(env), userId, null, lock ? "admin.locked" : "admin.code_wrong", auditDetail(request, { what, tries: failed }));
  await tell(env, request, lock ? "console locked" : `wrong ${what}`,
    lock ? `${LOCK_AFTER} wrong codes in a row: the admin console is locked for ${LOCK_MIN} minutes.` : `A wrong ${what} was typed on the admin console (${failed} of ${LOCK_AFTER} before it locks).`, nowMs);
  if (lock) throw lockedError(LOCK_MIN);
  throw new StudioError(what === "password" ? "That password isn't right." : "That code isn't right. Check the time on your phone and try the newest code.", 401, "admin_wrong", { left: LOCK_AFTER - failed });
}

/** The step of a right code (TOTP only), or null. A code is never accepted twice. */
async function totpStep(env: StudioEnv, row: AdminRow, code: string, nowMs: number): Promise<number | null> {
  if (!row.secret) return null;
  const secret = await openSecret(env.INTERNAL_SECRET, row.user_id, row.secret);
  return verifyTotp(secret, code, nowMs, row.last_step ?? 0);
}
async function codeOk(env: StudioEnv, userId: string, step: number): Promise<void> {
  await env.DB.prepare("UPDATE studio_admin SET failed = 0, locked_until = NULL, last_step = MAX(last_step, ?) WHERE user_id = ?").bind(step, userId).run();
}

/** A fresh code for a dangerous write: right, or counted as wrong. */
export async function checkFreshCode(env: StudioEnv, request: Request, userId: string, code: unknown, nowMs = Date.now()): Promise<void> {
  const row = await rowOf(env, userId);
  const min = lockedFor(row, nowMs);
  if (min) throw lockedError(min);
  const step = row ? await totpStep(env, row, String(code ?? ""), nowMs) : null;
  if (step === null) await wrong(env, request, userId, "code", nowMs);
  await codeOk(env, userId, step!);
}

// ── the admin password rule ──────────────────────────────────────────────────────────────────────────────────────

/** Why a password is too weak for an admin account, or null: 14 characters at least, and not its own e-mail or name. */
export function adminPasswordProblem(password: string, email: string | null, name: string | null): string | null {
  const p = String(password ?? "");
  if (p.length < 14) return "An admin password needs at least 14 characters. A sentence of four or five words works well.";
  const low = p.toLowerCase();
  const parts = [String(email ?? "").split("@")[0], ...String(name ?? "").split(/\s+/)].map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((x) => x.length >= 3);
  if (parts.some((x) => low.replace(/[^a-z0-9]/g, "").includes(x))) return "An admin password can't contain your e-mail or your name.";
  return null;
}

// ── the routes: /api/admin/auth/* ────────────────────────────────────────────────────────────────────────────────

const json = (data: unknown, status = 200, cookie?: string): Response => {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" });
  if (cookie) h.append("set-cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers: h });
};
async function body(request: Request): Promise<Record<string, unknown>> {
  try { return (await request.json()) as Record<string, unknown>; } catch { return {}; }
}
async function accountOf(env: StudioEnv, userId: string): Promise<{ email: string | null; name: string | null; hasPassword: boolean; passwordSubject: string | null }> {
  const u = await env.DB.prepare("SELECT email, display_name, contact_email FROM users WHERE id = ?").bind(userId).first<{ email: string; display_name: string | null; contact_email: string | null }>();
  const logins = await loginsOf(env, userId);
  const pw = logins.find((l) => l.provider === "password");
  const email = logins.find((l) => l.email)?.email ?? (u && !u.email.endsWith(".invalid") ? u.email : u?.contact_email ?? null);
  return { email, name: u?.display_name ?? null, hasPassword: !!pw, passwordSubject: pw?.subject ?? null };
}

/**
 * The console's own sign-in routes. They need the Studio session of an admin (the router checked it) but no admin
 * session yet. Answers null for any other path.
 */
export async function adminAuthApi(env: StudioEnv, request: Request, url: URL, userId: string, nowMs = Date.now()): Promise<Response | null> {
  const path = url.pathname, method = request.method;
  if (!path.startsWith("/api/admin/auth")) return null;
  const row = await rowOf(env, userId);
  const acct = await accountOf(env, userId);

  if (path === "/api/admin/auth" && method === "GET") {
    const s = await adminSessionOf(env, request, userId, nowMs);
    return json({
      enrolled: !!row?.secret, signedIn: !!s, lockedMinutes: lockedFor(row, nowMs), recoveryLeft: recoveryOf(row).length,
      hasPassword: acct.hasPassword, email: acct.email, enrolledAt: row?.enrolled_at ?? null,
      session: s ? { issued: new Date(s.issued * 1000).toISOString(), seen: new Date(s.seen * 1000).toISOString(), fresh: new Date(s.fresh * 1000).toISOString() } : null,
      idleMinutes: ADMIN_IDLE_MIN, maxHours: ADMIN_MAX_H,
    });
  }
  if (method !== "POST") return json({ error: "Not found." }, 404);
  const b = await body(request);
  const min = lockedFor(row, nowMs);

  // Setting up, step 1: who is asking is proved again (password, or a Google sign-in just now), then a new secret.
  if (path === "/api/admin/auth/enroll") {
    if (row?.secret) throw new StudioError("The second factor is already set up. Resetting it is done from a terminal (docs/ADMIN-SECURITY.md).", 409, "enrolled");
    if (min) throw lockedError(min);
    if (acct.hasPassword) {
      const full = await getLogin(env, "password", acct.passwordSubject!);
      if (!(await checkPassword(String(b.password ?? ""), full?.secret))) await wrong(env, request, userId, "password", nowMs);
      const weak = adminPasswordProblem(String(b.password), acct.email, acct.name);
      if (weak) throw new StudioError(`${weak} Change it on the Account page first, then come back.`, 400, "weak_password");
    } else {
      const recent = await env.DB.prepare(`SELECT 1 AS one FROM studio_logins WHERE user_id = ? AND provider != 'password' AND last_login_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`)
        .bind(userId, `-${REAUTH_MIN} minutes`).first();
      if (!recent) throw new StudioError(`Sign out, sign in with Google again, and set up within ${REAUTH_MIN} minutes.`, 401, "reauth");
    }
    const secret = newSecret();
    await ensureRow(env, userId);
    await env.DB.prepare(`UPDATE studio_admin SET pending = ?, pending_at = ${NOW} WHERE user_id = ?`).bind(await sealSecret(env.INTERNAL_SECRET, userId, secret), userId).run();
    const b32 = base32Encode(secret);
    return json({ secret: b32, uri: otpauthUri(acct.email ?? userId, b32) });
  }
  // Setting up, step 2: the first code proves the phone has it; the recovery codes are shown this once.
  if (path === "/api/admin/auth/enroll/confirm") {
    if (row?.secret) throw new StudioError("The second factor is already set up.", 409, "enrolled");
    if (min) throw lockedError(min);
    if (!row?.pending || !row.pending_at || Date.parse(row.pending_at.endsWith("Z") ? row.pending_at : `${row.pending_at}Z`) < nowMs - PENDING_MIN * 60_000) {
      throw new StudioError("Setting up took too long. Start again.", 400, "pending_expired");
    }
    const step = await verifyTotp(await openSecret(env.INTERNAL_SECRET, userId, row.pending), String(b.code ?? ""), nowMs);
    if (step === null) await wrong(env, request, userId, "code", nowMs);
    const codes = newRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hashRecovery(env.INTERNAL_SECRET, userId, c)));
    await env.DB.prepare(`UPDATE studio_admin SET secret = pending, pending = NULL, pending_at = NULL, enrolled_at = ${NOW}, recovery = ?, failed = 0,
        locked_until = NULL, last_step = ?, session_epoch = session_epoch + 1 WHERE user_id = ?`).bind(JSON.stringify(hashes), step, userId).run();
    await audit(asEnv(env), userId, null, "admin.2fa_enrolled", auditDetail(request));
    await tell(env, request, "second factor set up", "A phone was set up for the Kleo admin console's codes.", nowMs);
    return json({ ok: true, recovery: codes }, 200, await openSession(env, userId, nowMs));
  }
  // Signing in to the console: a code from the phone, or a recovery code.
  if (path === "/api/admin/auth/signin") {
    if (!row?.secret) throw new StudioError("Set up the second factor first.", 400, "not_enrolled");
    if (min) throw lockedError(min);
    const typed = String(b.code ?? "").trim();
    let via = "code";
    const step = await totpStep(env, row, typed, nowMs);
    if (step !== null) await codeOk(env, userId, step);
    else {
      const left = recoveryOf(row);
      const h = normalizeRecovery(typed).length === 12 ? await hashRecovery(env.INTERNAL_SECRET, userId, typed) : "";
      if (!h || !left.includes(h)) await wrong(env, request, userId, "code", nowMs);
      const rest = left.filter((x) => x !== h);
      await env.DB.prepare("UPDATE studio_admin SET recovery = ?, failed = 0, locked_until = NULL WHERE user_id = ?").bind(JSON.stringify(rest), userId).run();
      via = "recovery";
      await audit(asEnv(env), userId, null, "admin.recovery_used", auditDetail(request, { left: rest.length }));
      await tell(env, request, "recovery code used", `A recovery code opened the admin console. ${rest.length} ${rest.length === 1 ? "is" : "are"} left.`, nowMs);
    }
    await audit(asEnv(env), userId, null, "admin.signin", auditDetail(request, { via }));
    await tell(env, request, "sign-in", `The Kleo admin console was opened${via === "recovery" ? " with a recovery code" : ""}.`, nowMs);
    return json({ ok: true, via }, 200, await openSession(env, userId, nowMs));
  }
  // A fresh code before a dangerous write.
  if (path === "/api/admin/auth/step-up") {
    const s = await adminSessionOf(env, request, userId, nowMs);
    if (!s) throw new StudioError("Your admin session ended. Sign in to the console again.", 401, "admin_signin");
    await checkFreshCode(env, request, userId, b.code, nowMs);
    return json({ ok: true }, 200, await touchSession(env, s, nowMs, true));
  }
  // Signing the console out: this browser, or every one ("everywhere" ends every admin session at once).
  if (path === "/api/admin/auth/signout") {
    if (b.everywhere === true && row) {
      await env.DB.prepare("UPDATE studio_admin SET session_epoch = session_epoch + 1 WHERE user_id = ?").bind(userId).run();
      await audit(asEnv(env), userId, null, "admin.signout_sessions", auditDetail(request));
    }
    return json({ ok: true }, 200, clearAdminCookie());
  }
  // New recovery codes (the old ones stop working); wants a fresh code.
  if (path === "/api/admin/auth/recovery") {
    const s = await adminSessionOf(env, request, userId, nowMs);
    if (!s) throw new StudioError("Your admin session ended. Sign in to the console again.", 401, "admin_signin");
    await checkFreshCode(env, request, userId, b.code, nowMs);
    const codes = newRecoveryCodes();
    await env.DB.prepare("UPDATE studio_admin SET recovery = ? WHERE user_id = ?").bind(JSON.stringify(await Promise.all(codes.map((c) => hashRecovery(env.INTERNAL_SECRET, userId, c)))), userId).run();
    await audit(asEnv(env), userId, null, "admin.recovery_renewed", auditDetail(request));
    await tell(env, request, "new recovery codes", "New recovery codes were made for the admin console; the old ones no longer work.", nowMs);
    return json({ ok: true, recovery: codes }, 200, await touchSession(env, s, nowMs, true));
  }
  return json({ error: "Not found." }, 404);
}

/** The Security page: the console's sign-ins, the account's sign-in methods, what is left of the recovery codes. */
export async function securityInfo(env: StudioEnv, userId: string, s: AdminSession): Promise<Record<string, unknown>> {
  const row = await rowOf(env, userId);
  const events = (await env.DB.prepare(`SELECT id, at, event, detail FROM audit WHERE user_id = ? AND event IN
      ('admin.signin','admin.code_wrong','admin.locked','admin.2fa_enrolled','admin.recovery_used','admin.recovery_renewed','admin.signout_sessions')
      ORDER BY id DESC LIMIT 40`).bind(userId).all()).results;
  const methods = (await env.DB.prepare("SELECT provider, email, created_at, last_login_at FROM studio_logins WHERE user_id = ? ORDER BY created_at").bind(userId).all()).results;
  return {
    events, methods, recoveryLeft: recoveryOf(row).length, enrolledAt: row?.enrolled_at ?? null,
    session: { issued: new Date(s.issued * 1000).toISOString(), seen: new Date(s.seen * 1000).toISOString(), fresh: new Date(s.fresh * 1000).toISOString() },
    idleMinutes: ADMIN_IDLE_MIN, maxHours: ADMIN_MAX_H, freshMinutes: FRESH_MIN, lockAfter: LOCK_AFTER, lockMinutes: LOCK_MIN,
  };
}
