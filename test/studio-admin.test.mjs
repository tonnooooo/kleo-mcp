/**
 * The admin console of Kleo Studio (src/studio/admin.ts, studio-web/admin.js) inside one process: the kleo-studio
 * Worker bundled with esbuild, on a D1 look-alike (node:sqlite, every migration applied) and an in-memory R2.
 * Covers who may open it, the sign-in addresses it now records (src/studio/ips.ts), every action on an account and
 * its audit row, payments with their Stripe links, creations with signed previews, failures by reason, the providers'
 * balances and key names (never values), and the address lookup in Cloudflare's logs. Then the console's own door
 * (src/studio/admin-auth.ts): the phone code set up once, the code at every visit, the admin session cookie, the fresh
 * code before dangerous writes, the lock after five wrong codes, and the e-mails to the owner. And the console's own host
 * (src/studio/admin-host.ts): nowhere else, and there only with the owner's client certificate.
 * Run: node --test test/studio-admin.test.mjs
 */
import { register } from "node:module";
// Workers' "cloudflare:email" does not exist in Node: a stand-in that keeps what it was given.
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "cloudflare:email") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export class EmailMessage { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } }") };
  return next(s, c);
}`));
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { base32Decode, hotp, stepAt } from "../src/studio/totp.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

class Stmt {
  constructor(db, sql) { this.stmt = db.prepare(sql); this.args = []; }
  bind(...a) { this.args = a.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)); return this; }
  async run() { const r = this.stmt.run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
  async first() { return this.stmt.get(...this.args) ?? null; }
  async all() { return { results: this.stmt.all(...this.args) }; }
}
class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}
class FakeR2 {
  constructor() { this.m = new Map(); }
  async put(key, body, opts) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    this.m.set(key, { bytes, type: opts?.httpMetadata?.contentType });
    return { size: bytes.byteLength };
  }
  async get(key) {
    const e = this.m.get(key);
    if (!e) return null;
    return { size: e.bytes.byteLength, httpEtag: '"x"', httpMetadata: { contentType: e.type }, body: new Response(e.bytes).body, arrayBuffer: async () => e.bytes.buffer };
  }
  async delete(keys) { for (const k of [].concat(keys)) this.m.delete(k); }
  async list({ prefix = "" } = {}) { return { objects: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; }
}
// Every outside call of these tests goes through `answer`: DNS for the e-mail check, then whatever a test scripts.
let answer = null;
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://cloudflare-dns.com/dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }), { headers: { "content-type": "application/dns-json" } });
    if (answer) return answer(u, init ?? {});
    return real(url, init);
  };
}
globalThis.FixedLengthStream ??= class extends TransformStream { constructor() { super(); } };

let worker, mod;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts"; export { failureKind, failureText, stripeLinks, providerOf, reasonOf, dangerous } from "./src/studio/admin.ts";
      export { pathsFor } from "./src/studio/ip-lookup.ts"; export { APP_PATH } from "./src/studio/site.ts"; export { ADMIN_SITE_PATH, CONSOLE_PATH } from "./src/studio/admin-host.ts";
      export { adminCookieValue, readAdminCookie, adminPasswordProblem } from "./src/studio/admin-auth.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email"],
  });
  mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
  worker = mod.default;
});

function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: new FakeR2(), ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", EPHONE_API_KEY: "ephone-secret-value", FREE_CREDITS: "5",
    STUDIO_FREE_MODELS: "seedance-2.0-fast", STUDIO_DAILY_BUDGET_USD: "30", MAX_NEW_USERS_PER_IP_DAY: "50", MAX_ACCOUNTS_PER_ADDRESS: "50",
    // The console's host and the owner's certificate (src/studio/admin-host.ts).
    ADMIN_HOST: "admin.kleo.test", ADMIN_CERT_SHA256: CERT_FP,
    // The owner's alerts (providers.ts mailOwner): every message is kept here.
    mails: [], OWNER_MAIL: { send: async (m) => { env.mails.push(m); } },
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
/** The owner's client certificate as Cloudflare reports it on the admin host (request.cf.tlsClientAuth). */
const CERT_FP = "3f".repeat(32);
const GOOD_TLS = { certPresented: "1", certVerified: "SUCCESS", certRevoked: "0", certFingerprintSHA256: CERT_FP, certIssuerDN: "CN=Cloudflare" };
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
const BERLIN = { ip: "95.33.163.20", cf: { country: "DE", region: "Berlin", city: "Berlin", asn: 3320, asOrganization: "Deutsche Telekom AG" } };
/**
 * One request. The console's paths (/admin, /api/admin/*) go to the admin host with the owner's certificate unless the
 * test says otherwise: `host: "app"` or `host: "admin"`, `tls` for another certificate (null: none).
 */
async function call(env, path, { method = "GET", body, cookie, header = true, from, host, tls } = {}) {
  const admin = host === "admin" || (host === undefined && /^\/(?:api\/)?admin(?:\/|$)/.test(path));
  const h = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)" };
  if (header) h["x-kleo"] = "1";
  if (cookie) h.cookie = cookie;
  if (from?.ip) h["cf-connecting-ip"] = from.ip;
  if (body !== undefined) h["content-type"] = "application/json";
  const req = new Request(`https://${admin ? "admin" : "app"}.kleo.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const cf = admin ? { ...(from?.cf ?? {}), ...(tls === null ? {} : { tlsClientAuth: tls ?? GOOD_TLS }) } : from?.cf;
  if (cf) Object.defineProperty(req, "cf", { value: cf });
  const res = await worker.fetch(req, env, ctx);
  await Promise.allSettled(pending.splice(0));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, res };
}
const cookieOf = (r) => (r.res.headers.get("set-cookie") ?? "").split(";")[0];
async function account(env, email, from = BERLIN) {
  const r = await call(env, "/api/auth/signup", { method: "POST", body: { email, password: "long enough pw" }, from });
  assert.equal(r.status, 200, r.text);
  const cookie = cookieOf(r);
  const me = await call(env, "/api/me", { cookie });
  return { cookie, id: me.json.id };
}
/** The phone's code `offset` steps from now (a code works once, so each test takes the next one). */
const codeAt = (secret, offset = 0) => hotp(secret, stepAt(Date.now()) + offset);
const NZ = { ip: "203.0.113.9", cf: { country: "NZ", city: "Auckland", asOrganization: "Spark New Zealand", asn: 4771 } };
/** Sets up the owner's phone: answers the secret, the recovery codes and the admin session cookie. */
async function enrol(env, studioCookie) {
  const e = await call(env, "/api/admin/auth/enroll", { method: "POST", cookie: studioCookie, body: { password: "long enough pw" }, from: NZ });
  assert.equal(e.status, 200, e.text);
  const secret = base32Decode(e.json.secret);
  const c = await call(env, "/api/admin/auth/enroll/confirm", { method: "POST", cookie: studioCookie, body: { code: await codeAt(secret, -1) }, from: NZ });
  assert.equal(c.status, 200, c.text);
  return { secret, recovery: c.json.recovery, admin: cookieOf(c), uri: e.json.uri, raw: c.res.headers.get("set-cookie") };
}
/** An env with the owner's admin account (console open) and one customer, both signed in. */
async function setup(over = {}, { open = true } = {}) {
  const env = newEnv(over);
  const owner = await account(env, "owner@example.com", NZ);
  env.STUDIO_ADMINS = owner.id;
  const ana = await account(env, "ana@example.com");
  owner.studio = owner.cookie;
  if (open) { owner.phone = await enrol(env, owner.studio); owner.cookie = `${owner.studio}; ${owner.phone.admin}`; }
  return { env, owner, ana };
}
const subjects = (env) => env.mails.map((m) => /Subject: (.*)/.exec(m.raw)?.[1]);
const auditOf = (env, id, event) => env.DB.db.prepare("SELECT detail FROM audit WHERE user_id = ? AND event = ? ORDER BY id DESC").all(id, event).map((r) => JSON.parse(r.detail));
const run = (env, sql, ...a) => env.DB.db.prepare(sql).run(...a);

test("only an admin opens the console: others are told it does not exist, and every call needs the X-Kleo header", async () => {
  const { env, owner, ana } = await setup();
  assert.equal((await call(env, "/api/admin/overview")).status, 401);
  assert.equal((await call(env, "/api/admin/overview", { cookie: ana.cookie })).status, 404);
  assert.equal((await call(env, `/api/admin/users/${ana.id}/credits`, { method: "POST", cookie: ana.cookie, body: { delta: 999, reason: "free money" } })).status, 404);
  assert.equal((await call(env, "/api/admin/overview", { cookie: owner.cookie, header: false })).status, 403, "a read without the header is refused too");
  const o = await call(env, "/api/admin/overview", { cookie: owner.cookie });
  assert.equal(o.status, 200, o.text);
  assert.equal(o.json.counts.users, 2);
  assert.equal(o.json.newest.length, 2);
  // The console's page and files belong to the admin host only.
  for (const p of ["/admin", "/admin/users", `/admin/users/${ana.id}`, "/admin.js", "/admin.css", "/qr.js"]) {
    assert.ok(mod.ADMIN_SITE_PATH.test(p), p);
    assert.ok(mod.CONSOLE_PATH.test(p) || !mod.APP_PATH.test(p), p);
  }
  assert.ok(!mod.ADMIN_SITE_PATH.test("/admin/users/u_x/../../x"));
});

test("sign-up and sign-in leave the address and the place Cloudflare saw; the list shows, searches and sorts them", async () => {
  const { env, owner, ana } = await setup();
  await call(env, "/api/auth/signin", { method: "POST", body: { email: "ana@example.com", password: "long enough pw" }, from: { ip: "2a02:8108:1:2:3:4:5:6", cf: { country: "DE", city: "Hamburg", region: "Hamburg" } } });
  const rows = env.DB.db.prepare("SELECT event, ip, ip_hash, country, city, as_org, ua FROM studio_ips WHERE user_id = ? ORDER BY id").all(ana.id);
  assert.deepEqual(rows.map((r) => [r.event, r.ip, r.city]), [["signup", "95.33.163.20", "Berlin"], ["signin", "2a02:8108:1:2:3:4:5:6", "Hamburg"]]);
  assert.equal(rows[0].as_org, "Deutsche Telekom AG");
  assert.match(rows[0].ua, /iPhone/);
  assert.equal(rows[0].ip_hash, env.DB.db.prepare("SELECT ip_hash FROM users WHERE id = ?").get(ana.id).ip_hash, "the fingerprint is the account's own");

  const list = await call(env, "/api/admin/users", { cookie: owner.cookie });
  const a = list.json.users.find((u) => u.id === ana.id);
  assert.equal(a.email, "ana@example.com");
  assert.equal(a.city, "Hamburg");
  assert.equal(a.ip, "2a02:8108:1:2:3:4:5:6");
  assert.ok(a.last_seen);
  for (const q of ["95.33.163", "ana@", "berlin", ana.id]) {
    const r = await call(env, `/api/admin/users?q=${encodeURIComponent(q)}`, { cookie: owner.cookie });
    assert.deepEqual(r.json.users.map((u) => u.id), [ana.id], q);
  }
  assert.equal((await call(env, "/api/admin/users?q=%25", { cookie: owner.cookie })).json.users.length, 0, "a % is a character, not a wildcard");
  run(env, "UPDATE users SET credits = 900 WHERE id = ?", ana.id);
  const sorted = await call(env, "/api/admin/users?sort=credits&dir=asc", { cookie: owner.cookie });
  assert.deepEqual(sorted.json.users.map((u) => u.id), [owner.id, ana.id]);
  assert.equal((await call(env, "/api/admin/users?filter=paid", { cookie: owner.cookie })).json.users.length, 0);
});

test("credits: a reason is required, the change is audited with the admin's id, and a removal stops at zero", async () => {
  const { env, owner, ana } = await setup();
  const path = `/api/admin/users/${ana.id}/credits`;
  assert.equal((await call(env, path, { method: "POST", cookie: owner.cookie, body: { delta: 10 } })).json.code, "reason");
  assert.equal((await call(env, path, { method: "POST", cookie: owner.cookie, body: { delta: 0, reason: "nothing" } })).json.code, "delta");
  const add = await call(env, path, { method: "POST", cookie: owner.cookie, body: { delta: 20, reason: "Clips failed on ePhone" } });
  assert.equal(add.json.credits, 25);
  assert.deepEqual(auditOf(env, ana.id, "admin.credits")[0], { admin: owner.id, reason: "Clips failed on ePhone", delta: 20, before: 5, after: 25 });
  const take = await call(env, path, { method: "POST", cookie: owner.cookie, body: { delta: -100, reason: "Chargeback" } });
  assert.equal(take.json.credits, 0);
});

test("block: the account's sessions, sign-ins and Kleo key stop at once; unblocked, it signs in again; an admin is never blocked", async () => {
  const { env, owner, ana } = await setup();
  const keyBefore = env.DB.db.prepare("SELECT key_version FROM users WHERE id = ?").get(ana.id).key_version;
  const b = await call(env, `/api/admin/users/${ana.id}/block`, { method: "POST", cookie: owner.cookie, body: { on: true, reason: "Card testing" } });
  assert.equal(b.status, 200, b.text);
  assert.equal((await call(env, "/api/me", { cookie: ana.cookie })).status, 401);
  const again = await call(env, "/api/auth/signin", { method: "POST", body: { email: "ana@example.com", password: "long enough pw" } });
  assert.equal(again.status, 403);
  assert.equal(again.json.code, "blocked");
  assert.ok(env.DB.db.prepare("SELECT key_version FROM users WHERE id = ?").get(ana.id).key_version > keyBefore, "the old key no longer opens it");
  assert.equal(auditOf(env, ana.id, "admin.block")[0].admin, owner.id);
  const detail = await call(env, `/api/admin/users/${ana.id}`, { cookie: owner.cookie });
  assert.ok(detail.json.user.blocked_at);
  assert.equal(detail.json.user.blocked_reason, "Card testing");
  assert.equal((await call(env, "/api/admin/users?filter=blocked", { cookie: owner.cookie })).json.users.length, 1);

  await call(env, `/api/admin/users/${ana.id}/block`, { method: "POST", cookie: owner.cookie, body: { on: false, reason: "Talked to her" } });
  assert.equal((await call(env, "/api/auth/signin", { method: "POST", body: { email: "ana@example.com", password: "long enough pw" } })).status, 200);
  const self = await call(env, `/api/admin/users/${owner.id}/block`, { method: "POST", cookie: owner.cookie, body: { on: true, reason: "oops" } });
  assert.equal(self.json.code, "admin_target");
});

test("address: the account's own address is blocked and freed; a stranger's address is refused", async () => {
  const { env, owner, ana } = await setup();
  const hash = env.DB.db.prepare("SELECT ip_hash FROM users WHERE id = ?").get(ana.id).ip_hash;
  const r = await call(env, `/api/admin/users/${ana.id}/address`, { method: "POST", cookie: owner.cookie, body: { on: true, reason: "Farm of accounts", days: 60 } });
  assert.equal(r.status, 200, r.text);
  const row = env.DB.db.prepare("SELECT reason, until FROM blocked_addresses WHERE ip_hash = ?").get(hash);
  assert.match(row.reason, /^admin: Farm of accounts/);
  assert.ok(Date.parse(row.until) > Date.now() + 59 * 86400e3);
  assert.equal((await call(env, `/api/admin/users/${ana.id}`, { cookie: owner.cookie })).json.address.blocks.length, 1);
  const stranger = env.DB.db.prepare("SELECT ip_hash FROM users WHERE id = ?").get(owner.id).ip_hash;
  assert.equal((await call(env, `/api/admin/users/${ana.id}/address`, { method: "POST", cookie: owner.cookie, body: { on: true, hash: stranger, reason: "x x x" } })).json.code, "foreign_address");
  await call(env, `/api/admin/users/${ana.id}/address`, { method: "POST", cookie: owner.cookie, body: { on: false, reason: "False alarm" } });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM blocked_addresses").get().n, 0);
  assert.deepEqual(auditOf(env, ana.id, "admin.address_unblock")[0], { admin: owner.id, reason: "False alarm", hash });
});

test("a new Kleo key and sign out everywhere end the account's sessions; delete wants DELETE and spares admins", async () => {
  const { env, owner, ana } = await setup();
  await call(env, `/api/admin/users/${ana.id}/key`, { method: "POST", cookie: owner.cookie, body: { reason: "Key leaked on X" } });
  assert.equal((await call(env, "/api/me", { cookie: ana.cookie })).status, 401);
  const back = await call(env, "/api/auth/signin", { method: "POST", body: { email: "ana@example.com", password: "long enough pw" } });
  await call(env, `/api/admin/users/${ana.id}/signout`, { method: "POST", cookie: owner.cookie, body: { reason: "Shared her password" } });
  assert.equal((await call(env, "/api/me", { cookie: cookieOf(back) })).status, 401);
  assert.equal(auditOf(env, ana.id, "admin.key_reset").length, 1);
  assert.equal(auditOf(env, ana.id, "admin.signout").length, 1);

  assert.equal((await call(env, `/api/admin/users/${ana.id}/delete`, { method: "POST", cookie: owner.cookie, body: { reason: "Asked by mail" } })).json.code, "confirm");
  assert.equal((await call(env, `/api/admin/users/${owner.id}/delete`, { method: "POST", cookie: owner.cookie, body: { reason: "x x x", confirm: "DELETE" } })).json.code, "admin_target");
  const del = await call(env, `/api/admin/users/${ana.id}/delete`, { method: "POST", cookie: owner.cookie, body: { reason: "Asked by mail", confirm: "DELETE" } });
  assert.equal(del.status, 200, del.text);
  const u = env.DB.db.prepare("SELECT email, credits FROM users WHERE id = ?").get(ana.id);
  assert.equal(u.email, `${ana.id}@deleted.kleo.invalid`);
  assert.equal(u.credits, 0);
  assert.equal(auditOf(env, ana.id, "admin.delete")[0].admin, owner.id);
  assert.equal((await call(env, "/api/admin/users?filter=deleted", { cookie: owner.cookie })).json.users[0].id, ana.id);
});

test("payments: every row with its status and Stripe links, totals by day and month; the user page lists them", async () => {
  const { env, owner, ana } = await setup();
  const pay = (sid, pi, cents, status, at) => run(env, "INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, email, payment_intent, status, country, at) VALUES (?, ?, ?, ?, 'eur', 'ana@pay.example', ?, ?, 'DE', ?)", sid, ana.id, cents / 40, cents, pi, status, at);
  const today = new Date().toISOString();
  pay("cs_live_a1", "pi_3Ua1", 4000, "paid", today);
  pay("cs_live_a2", "pi_3Ua2", 1500, "refunded", today);
  pay("in_1Plan", "pi_3Ua3", 900, "disputed", "2026-09-02T10:00:00.000Z");
  run(env, "INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status) VALUES ('admin_owner', ?, 1000000, 0, 'eur', 'paid')", owner.id);
  const r = await call(env, "/api/admin/payments", { cookie: owner.cookie });
  assert.equal(r.json.total, 4);
  const a1 = r.json.payments.find((p) => p.session_id === "cs_live_a1");
  assert.deepEqual(a1.links, [{ label: "Payment", url: "https://dashboard.stripe.com/payments/pi_3Ua1" }, { label: "Checkout", url: "https://dashboard.stripe.com/search?query=cs_live_a1" }]);
  assert.deepEqual(r.json.payments.find((p) => p.session_id === "in_1Plan").links[1], { label: "Invoice", url: "https://dashboard.stripe.com/invoices/in_1Plan" });
  assert.deepEqual(r.json.totals.map((t) => [t.currency, t.total, t.today]), [["eur", 4000, 4000]], "only paid money counts, the admin's tester row never");
  assert.equal(r.json.days.length, 1);
  assert.deepEqual(r.json.states.map((s) => s.status).sort(), ["disputed", "paid", "refunded"]);
  assert.equal((await call(env, "/api/admin/payments?status=refunded", { cookie: owner.cookie })).json.payments.length, 1);
  assert.deepEqual(mod.stripeLinks({ session_id: "cs_test_x", payment_intent: "pi_test_y" }).map((l) => l.url), ["https://dashboard.stripe.com/test/payments/pi_test_y", "https://dashboard.stripe.com/test/search?query=cs_test_x"]);
  const list = await call(env, "/api/admin/users?filter=paid", { cookie: owner.cookie });
  assert.deepEqual(list.json.users.map((u) => [u.id, u.paid_cent, u.currency, u.country]), [[ana.id, 4000, "eur", "DE"]]);
  const d = await call(env, `/api/admin/users/${ana.id}`, { cookie: owner.cookie });
  assert.equal(d.json.payments.length, 3);
  assert.deepEqual(d.json.totals.paid, [{ currency: "eur", cents: 4000 }]);
});

test("creations: every account's newest with a signed preview the admin can open; failures grouped by reason and provider; spend per account", async () => {
  const { env, owner, ana } = await setup();
  const gen = (id, o) => run(env, `INSERT INTO studio_generations (id, user_id, model, settings, prompt, credits, est_usd, status, task_id, error, file_key, kind, slots, refunded, created_at)
      VALUES (?, ?, ?, '{"resolution":"720p","duration":5}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, ana.id, o.model ?? "seedance-2.5", o.prompt ?? "a cat", o.credits ?? 4, o.usd ?? 0.5, o.status, o.task ?? null, o.error ?? null, o.file ?? null, o.kind ?? "video", o.slots ?? null, o.refunded ?? 0, o.at ?? new Date().toISOString());
  await env.RENDERS.put(`studio/${ana.id}/g_done1.mp4`, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "video/mp4" } });
  gen("g_done1", { status: "done", file: `studio/${ana.id}/g_done1.mp4`, task: "apimart:t1" });
  gen("g_fail1", { status: "failed", error: "Our generation engine is being recharged.", refunded: 1 });
  gen("g_fail2", { status: "failed", error: "Our generation engine is being recharged.", refunded: 1 });
  gen("g_fail3", { status: "failed", error: "The video model won't make this one: copyright.", task: "wavespeed:t9" });
  run(env, "INSERT INTO audit (user_id, job_id, event, detail) VALUES (?, 'g_fail1', 'studio.failed', ?)", ana.id, JSON.stringify({ why: "x", provider: "ephone.ai POST /v1/task/submit → 403: 预扣费额度失败, 用户剩余额度: ＄1.086812, 需要预扣费额度: ＄1.355940 (request id: abc)" }));

  const r = await call(env, "/api/admin/generations", { cookie: owner.cookie });
  assert.equal(r.json.generations.length, 4);
  const done = r.json.generations.find((g) => g.id === "g_done1");
  assert.equal(done.provider, "apimart");
  assert.equal(done.email, "ana@example.com");
  assert.match(done.outputs[0].url, /^\/media\/g_done1\.mp4\?exp=\d+&sig=[0-9a-f]{32}$/);
  assert.equal((await call(env, done.outputs[0].url, { cookie: owner.cookie })).status, 200, "the admin opens a customer's clip through the signed link");
  assert.equal((await call(env, "/media/g_done1.mp4", { cookie: owner.cookie })).status, 404, "never without it");
  assert.equal((await call(env, "/api/admin/generations?status=failed", { cookie: owner.cookie })).json.generations.length, 3);
  assert.equal((await call(env, `/api/admin/generations?user=${owner.id}`, { cookie: owner.cookie })).json.generations.length, 0);

  const f = await call(env, "/api/admin/failures?days=7", { cookie: owner.cookie });
  assert.equal(f.json.total, 3);
  assert.deepEqual(f.json.groups.map((g) => [g.kind, g.provider, g.count]), [["Provider out of credit", "ephone", 2], ["Copyright refusal", "wavespeed", 1]]);
  assert.doesNotMatch(f.json.groups[0].sample, /abc|1\.08/, "ids and amounts are left out of the grouped text");

  const s = await call(env, "/api/admin/spend?days=30", { cookie: owner.cookie });
  assert.deepEqual(s.json.users.map((u) => [u.id, u.gens, u.failed, u.usd]), [[ana.id, 4, 3, 0.5]]);
  const d = await call(env, `/api/admin/users/${ana.id}`, { cookie: owner.cookie });
  assert.equal(d.json.generations.length, 4);
  assert.equal(d.json.totals.failed, 3);
  assert.ok(d.json.audit.some((a) => a.event === "studio.failed"));
});

test("providers: key names only, never a value; WaveSpeed and APIMart read live; ePhone from its last refusal", async () => {
  const { env, owner, ana } = await setup({ WAVESPEED_API_KEY: "ws-secret-value", APIMART_API_KEY: "am-secret-value" });
  run(env, "INSERT INTO audit (user_id, job_id, event, detail) VALUES (?, 'g_x', 'studio.failed', ?)", ana.id, JSON.stringify({ provider: "ephone.ai POST /v1/task/submit → 403: 预扣费额度失败, 用户剩余额度: ＄1.086812, 需要预扣费额度: ＄2.44" }));
  const asked = [];
  answer = (u, init) => {
    asked.push([u, init.headers?.authorization]);
    if (u === "https://api.wavespeed.ai/api/v3/balance") return Response.json({ code: 200, message: "success", data: { balance: 11.25 } });
    if (u === "https://api.apimart.ai/v1/user/balance") return Response.json({ success: true, remain_balance: 3.5, used_balance: 2 });
    return new Response("no", { status: 500 });
  };
  try {
    const r = await call(env, "/api/admin/providers", { cookie: owner.cookie });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.balances.map((b) => [b.provider, b.usd, b.source]), [["ephone", 1.086812, "last_refusal"], ["wavespeed", 11.25, "live"], ["apimart", 3.5, "live"]]);
    assert.deepEqual(asked.filter((a) => /wavespeed|apimart/.test(a[0])).map((a) => a[1]), ["Bearer ws-secret-value", "Bearer am-secret-value"]);
    const set = Object.fromEntries(r.json.secrets.map((s) => [s.name, s.set]));
    assert.equal(set.EPHONE_API_KEY, true);
    assert.equal(set.STRIPE_SECRET_KEY, false);
    for (const v of ["ephone-secret-value", "ws-secret-value", "am-secret-value", "s3cret"]) assert.ok(!r.text.includes(v), `${v} never leaves the Worker`);
    assert.ok(r.json.settings.some((s) => s.name === "STUDIO_ADMINS" && s.value === owner.id));
  } finally { answer = null; }
});

test("finding a past address: off without the token; with it, the request of the event, remembered and audited", async () => {
  const { env, owner, ana } = await setup();
  run(env, "DELETE FROM studio_ips WHERE user_id = ?", ana.id);
  const created = env.DB.db.prepare("SELECT id, at FROM audit WHERE user_id = ? AND event = 'user.created'").get(ana.id);
  const path = `/api/admin/users/${ana.id}/ip-lookup`;
  assert.equal((await call(env, path, { method: "POST", cookie: owner.cookie, body: { audit: created.id } })).json.code, "no_token");
  env.CF_ANALYTICS_TOKEN = "cf-analytics-token";
  let sent = null;
  answer = (u, init) => {
    sent = { u, auth: init.headers?.authorization, body: JSON.parse(init.body) };
    const t = new Date(Date.parse(created.at) - 2000).toISOString().replace(/\.\d+Z$/, "Z");
    const row = (ip, host, method, path, extra = {}) => ({ count: 1, dimensions: { datetime: t, clientIP: ip, clientCountryName: "DE", clientRequestHTTPHost: host, clientRequestHTTPMethodName: method, clientRequestPath: path, userAgent: "Mozilla/5.0 (iPhone)", edgeResponseStatus: 200, ...extra } });
    return Response.json({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [
      row("174.138.33.1", "app.kleooai.com", "GET", "/"),
      row("2a06:98c0:3600::103", "app.kleooai.com", "POST", "/api/auth/signup"),
      row("95.33.163.20", "app.kleooai.com", "POST", "/api/auth/signup"),
    ] }] } } });
  };
  try {
    const r = await call(env, path, { method: "POST", cookie: owner.cookie, body: { audit: created.id } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.best.ip, "95.33.163.20");
    assert.equal(r.json.rows.length, 2, "the Worker's own Cloudflare address is left out");
    assert.equal(sent.u, "https://api.cloudflare.com/client/v4/graphql");
    assert.equal(sent.auth, "Bearer cf-analytics-token");
    assert.equal(sent.body.variables.zone, "8debd68bde1fd261514f4d54e249c08c");
    assert.equal(Date.parse(sent.body.variables.to) - Date.parse(sent.body.variables.from), 10_000);
    assert.doesNotMatch(sent.body.query, /clientAsn/, "Cloudflare refuses that field on this plan");
  } finally { answer = null; }
  const kept = env.DB.db.prepare("SELECT event, ip, at FROM studio_ips WHERE user_id = ?").all(ana.id);
  assert.deepEqual(kept.map((k) => [k.event, k.ip, k.at]), [["lookup", "95.33.163.20", created.at]]);
  assert.equal(auditOf(env, ana.id, "admin.ip_lookup")[0].found, true);
  assert.equal((await call(env, path, { method: "POST", cookie: owner.cookie, body: { audit: 999999 } })).json.code, "no_event", "only this account's own events");
  assert.deepEqual(mod.pathsFor("pay.session", null), ["/api/pay/session"]);
});

test("addresses older than 90 days are deleted by the cron, once an hour", async () => {
  const { env, ana } = await setup();
  run(env, "INSERT INTO studio_ips (user_id, at, event, ip) VALUES (?, '2026-01-01T00:00:00.000Z', 'signin', '1.2.3.4')", ana.id);
  const count = () => env.DB.db.prepare("SELECT COUNT(*) AS n FROM studio_ips WHERE user_id = ?").get(ana.id).n;
  assert.equal(count(), 2);
  await worker.scheduled({ scheduledTime: Date.parse("2026-10-23T10:05:00Z") }, env, ctx);
  assert.equal(count(), 2, "not at minute 5");
  await worker.scheduled({ scheduledTime: Date.parse("2026-10-23T10:17:00Z") }, env, ctx);
  assert.equal(count(), 1, "the old one went, the sign-up stayed");
});

test("the console page keeps the owner's rules: no browser pop-ups, no text under 13 px, every page drawn", () => {
  const js = readFileSync(join(ROOT, "studio-web", "admin.js"), "utf8");
  const css = readFileSync(join(ROOT, "studio-web", "admin.css"), "utf8");
  assert.doesNotMatch(js, /\b(?:window\.)?(?:alert|confirm|prompt)\(/, "questions go through the app's own ask()");
  for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]) >= 13, `font-size ${m[1]}px`);
  for (const page of ["overviewPage", "usersPage", "userPage", "paymentsPage", "creationsPage", "providersPage"]) assert.match(js, new RegExp(`async function ${page}\\(`));
  const app = readFileSync(join(ROOT, "studio-web", "app.js"), "utf8");
  assert.match(app, /import\("\/admin\.js\?v=\d+"\)/, "app.js loads the console only when it is opened");
});

test("failure reasons in plain words; a reason is never empty", () => {
  assert.equal(mod.failureKind("ephone.ai → 403: 预扣费额度失败, 用户剩余额度: ＄0"), "Provider out of credit");
  assert.equal(mod.failureKind("资源同步失败 … HeightTooSmall"), "Picture too small");
  assert.equal(mod.failureKind("The output was flagged as sensitive"), "Content refused");
  assert.equal(mod.failureKind("won't make this one: copyright"), "Copyright refusal");
  assert.equal(mod.failureKind("502 Bad Gateway"), "Provider error");
  assert.equal(mod.failureKind("something odd"), "Other");
  assert.equal(mod.failureText("x (request id: 2026abc) y ＄1.23 deadbeefdeadbeef"), "x y $… …");
  assert.equal(mod.providerOf({ kind: "image", task_id: null, slots: JSON.stringify([{ provider: "wavespeed" }]) }), "wavespeed");
  assert.equal(mod.providerOf({ kind: "video", task_id: "t1", slots: null }), "ephone");
  assert.throws(() => mod.reasonOf({ reason: "  " }), /reason/);
});

// ── the console's door (src/studio/admin-auth.ts) ────────────────────────────────────────────────────────────────

test("setting up the phone: password again, an otpauth link, ten recovery codes shown once, a sealed secret, a mail", async () => {
  const { env, owner } = await setup({}, { open: false });
  assert.equal((await call(env, "/api/admin/overview", { cookie: owner.studio })).json.code, "admin_enroll", "nothing opens before the phone is set up");
  const st = await call(env, "/api/admin/auth", { cookie: owner.studio });
  assert.deepEqual([st.json.enrolled, st.json.signedIn, st.json.hasPassword], [false, false, true]);
  const bad = await call(env, "/api/admin/auth/enroll", { method: "POST", cookie: owner.studio, body: { password: "not my password" }, from: NZ });
  assert.equal(bad.json.code, "admin_wrong", "a stolen session cannot set up its own phone");
  const p = await enrol(env, owner.studio);
  assert.match(p.uri, /^otpauth:\/\/totp\/Kleo%20admin:owner%40example\.com\?secret=[A-Z2-7]{32}&issuer=Kleo$/);
  assert.equal(p.recovery.length, 10);
  assert.ok(p.recovery.every((c) => /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/.test(c)));
  assert.match(p.raw, /^__Host-kleo_admin=[^;]+; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/);
  const row = env.DB.db.prepare("SELECT secret, recovery FROM studio_admin WHERE user_id = ?").get(owner.id);
  assert.match(row.secret, /^v1\./, "the secret is sealed, never stored in the clear");
  assert.ok(!JSON.parse(row.recovery).some((x) => p.recovery.includes(x)), "recovery codes are stored hashed");
  assert.ok(subjects(env).includes("Kleo admin: second factor set up"));
  assert.ok(env.mails.some((m) => /Address: 203\.0\.113\.9/.test(m.raw) && /Place: Auckland, NZ/.test(m.raw) && /Network: Spark New Zealand \(AS4771\)/.test(m.raw)));
  assert.equal((await call(env, "/api/admin/auth/enroll", { method: "POST", cookie: owner.studio, body: { password: "long enough pw" } })).json.code, "enrolled", "resetting is a terminal's job");
  assert.equal((await call(env, "/api/admin/overview", { cookie: `${owner.studio}; ${p.admin}` })).status, 200);
});

test("an admin's password: 14 characters at least, never the e-mail or the name; a weak one stops the set-up", async () => {
  assert.match(mod.adminPasswordProblem("short one", "o@x.com", null), /14 characters/);
  assert.match(mod.adminPasswordProblem("leonardo-is-the-boss-2026", "leonardo@gmail.com", null), /e-mail or your name/);
  assert.match(mod.adminPasswordProblem("correct horse battery tonon", "x@y.com", "Leo Tonon"), /e-mail or your name/);
  assert.equal(mod.adminPasswordProblem("four plain words here please", "leonardo@gmail.com", "Leo"), null);
  const env = newEnv();
  const r = await call(env, "/api/auth/signup", { method: "POST", body: { email: "boss@example.com", password: "only12chars!" } });
  const owner = { studio: cookieOf(r), id: (await call(env, "/api/me", { cookie: cookieOf(r) })).json.id };
  env.STUDIO_ADMINS = owner.id;
  assert.equal((await call(env, "/api/admin/auth/enroll", { method: "POST", cookie: owner.studio, body: { password: "only12chars!" } })).json.code, "weak_password");
  const change = await call(env, "/api/auth/password/change", { method: "POST", cookie: owner.studio, body: { current: "only12chars!", password: "still short" } });
  assert.equal(change.json.code, "weak_password", "an admin can't change to a weak password either");
  const ok = await call(env, "/api/auth/password/change", { method: "POST", cookie: owner.studio, body: { current: "only12chars!", password: "four plain words here please" } });
  assert.equal(ok.status, 200, ok.text);
});

test("the code at every visit: once each, five wrong lock for 15 minutes, a recovery code works once, the owner is told each time", async () => {
  const { env, owner } = await setup();
  const signin = (code) => call(env, "/api/admin/auth/signin", { method: "POST", cookie: owner.studio, body: { code }, from: NZ });
  const used = await codeAt(owner.phone.secret, -1);
  assert.equal((await signin(used)).json.code, "admin_wrong", "the code used at set-up never works again");
  const good = await signin(await codeAt(owner.phone.secret, 0));
  assert.equal(good.status, 200, good.text);
  assert.match(good.res.headers.get("set-cookie"), /^__Host-kleo_admin=/);
  assert.ok(subjects(env).includes("Kleo admin: sign-in"));
  for (let i = 0; i < 4; i++) assert.equal((await signin("000000")).json.code, "admin_wrong");
  const locked = await signin("000000");
  assert.equal(locked.status, 429);
  assert.equal(locked.json.code, "admin_locked");
  assert.equal((await signin(await codeAt(owner.phone.secret, 1))).json.code, "admin_locked", "not even the right code while locked");
  assert.ok(subjects(env).includes("Kleo admin: console locked"));
  assert.ok(subjects(env).filter((x) => x === "Kleo admin: wrong code").length >= 4);
  run(env, "UPDATE studio_admin SET locked_until = '2000-01-01T00:00:00.000Z' WHERE user_id = ?", owner.id);
  const rec = await signin(owner.phone.recovery[3].toUpperCase().replace(/-/g, " "));
  assert.equal(rec.json.via, "recovery", "a recovery code, however it is typed");
  assert.equal((await signin(owner.phone.recovery[3])).json.code, "admin_wrong", "each recovery code works once");
  assert.ok(subjects(env).includes("Kleo admin: recovery code used"));
  assert.equal((await call(env, "/api/admin/auth", { cookie: owner.studio })).json.recoveryLeft, 9);
});

test("the admin session: signed, bound to the account and its epochs, 30 minutes idle, 12 hours at most; both cookies needed", async () => {
  const { env, owner, ana } = await setup();
  const s = await mod.readAdminCookie("s3cret", owner.phone.admin.split("=")[1]);
  assert.equal(s.userId, owner.id);
  const forge = async (o) => `__Host-kleo_admin=${await mod.adminCookieValue("s3cret", { ...s, ...o })}`;
  const now = Math.floor(Date.now() / 1000);
  const tryIt = async (admin, studio = owner.studio) => (await call(env, "/api/admin/overview", { cookie: `${studio}; ${admin}` })).json?.code ?? "ok";
  assert.equal(await tryIt(owner.phone.admin), "ok");
  assert.equal(await tryIt(owner.phone.admin.replace(/.$/, (c) => (c === "0" ? "1" : "0"))), "admin_signin", "a forged signature");
  assert.equal(await tryIt(await forge({ seen: now - 31 * 60 })), "admin_signin", "31 idle minutes");
  assert.equal(await tryIt(await forge({ issued: now - 13 * 3600, seen: now })), "admin_signin", "13 hours old");
  assert.equal(await tryIt(await forge({ userId: "u_someoneelse" })), "admin_signin", "another account's");
  assert.equal((await call(env, "/api/admin/overview", { cookie: owner.phone.admin })).status, 401, "the admin cookie alone is not a session");
  const refreshed = await call(env, "/api/admin/overview", { cookie: owner.cookie });
  assert.match(refreshed.res.headers.get("set-cookie") ?? "", /^__Host-kleo_admin=.*SameSite=Strict/, "every call keeps it alive");
  // "Sign out everywhere" on the account page ends the console too.
  await call(env, "/api/auth/signout-all", { method: "POST", cookie: owner.studio });
  const back = await call(env, "/api/auth/signin", { method: "POST", body: { email: "owner@example.com", password: "long enough pw" } });
  assert.equal(await tryIt(owner.phone.admin, cookieOf(back)), "admin_signin");
  assert.ok(ana.id);
});

test("signing the console out, here or everywhere; the Security page lists sign-ins, methods and recovery codes left", async () => {
  const { env, owner } = await setup();
  const sec = await call(env, "/api/admin/security", { cookie: owner.cookie });
  assert.equal(sec.status, 200, sec.text);
  assert.equal(sec.json.recoveryLeft, 10);
  assert.deepEqual(sec.json.methods.map((m) => m.provider), ["password"]);
  assert.ok(sec.json.events.some((e) => e.event === "admin.2fa_enrolled" && JSON.parse(e.detail).city === "Auckland"));
  const out = await call(env, "/api/admin/auth/signout", { method: "POST", cookie: owner.cookie, body: { everywhere: true } });
  assert.match(out.res.headers.get("set-cookie"), /^__Host-kleo_admin=; .*Max-Age=0/);
  assert.equal((await call(env, "/api/admin/overview", { cookie: owner.cookie })).json.code, "admin_signin", "the old cookie is dead everywhere");
  const again = await call(env, "/api/admin/auth/signin", { method: "POST", cookie: owner.studio, body: { code: await codeAt(owner.phone.secret, 0) } });
  const fresh = `${owner.studio}; ${cookieOf(again)}`;
  const codes = await call(env, "/api/admin/auth/recovery", { method: "POST", cookie: fresh, body: { code: await codeAt(owner.phone.secret, 1) } });
  assert.equal(codes.json.recovery.length, 10);
  assert.ok(subjects(env).includes("Kleo admin: new recovery codes"));
});

test("dangerous writes want a code typed in the last 5 minutes; small ones don't", async () => {
  const { env, owner, ana } = await setup();
  const s = await mod.readAdminCookie("s3cret", owner.phone.admin.split("=")[1]);
  const stale = `${owner.studio}; __Host-kleo_admin=${await mod.adminCookieValue("s3cret", { ...s, fresh: s.fresh - 6 * 60 })}`;
  const act = (what, body, cookie = stale) => call(env, `/api/admin/users/${ana.id}/${what}`, { method: "POST", cookie, body: { reason: "testing the rule", ...body } });
  assert.equal((await act("credits", { delta: 50 })).status, 200, "a small credit change needs no code");
  for (const [what, body] of [["credits", { delta: 500 }], ["block", { on: true }], ["key", {}], ["signout", {}], ["delete", { confirm: "DELETE" }]]) {
    assert.equal((await act(what, body)).json.code, "fresh_code", what);
  }
  assert.equal((await act("credits", { delta: 500, code: "000000" })).json.code, "admin_wrong");
  const ok = await act("credits", { delta: 500, code: await codeAt(owner.phone.secret, 0) });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.res.headers.get("set-cookie"), /^__Host-kleo_admin=/, "the code typed now counts for the next 5 minutes");
  const later = `${owner.studio}; ${cookieOf(ok)}`;
  assert.equal((await act("key", {}, later)).status, 200, "inside the 5 minutes no new code is asked");
  assert.equal(mod.dangerous("signout", {}, owner.id, owner.id), false, "signing one's own account out is not dangerous");
});

test("the console's page and API are never indexed or cached, load nothing from other sites, and stay hidden from others", async () => {
  const { env, owner, ana } = await setup();
  const page = await call(env, "/admin/users", { cookie: owner.cookie });
  assert.equal(page.res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(page.res.headers.get("cache-control"), "no-store");
  const csp = page.res.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'self';/);
  assert.match(csp, /frame-src 'none'/);
  assert.doesNotMatch(csp, /stripe|challenges\.cloudflare|cloudflareinsights/);
  const api = await call(env, "/api/admin/overview", { cookie: owner.cookie });
  assert.equal(api.res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(api.res.headers.get("cache-control"), "no-store");
  assert.doesNotMatch((await call(env, "/video", {})).res.headers.get("content-security-policy") ?? "", /script-src 'self';/, "the rest of the app keeps its own CSP");
  for (const path of ["/api/admin/auth", "/api/admin/security"]) assert.equal((await call(env, path, { cookie: ana.cookie })).status, 404, path);
  assert.equal((await call(env, "/api/admin/auth/signin", { method: "POST", cookie: ana.cookie, body: { code: "123456" } })).status, 404);
  assert.ok(mod.ADMIN_SITE_PATH.test("/qr.js"));
});

test("the set-up QR code is drawn on this origin: right size, finder patterns, error correction M", async () => {
  const { qrMatrix, qrSvg } = await import("../studio-web/qr.js");
  const link = "otpauth://totp/Kleo%20admin:leonardotononn2006%40gmail.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Kleo";
  const m = qrMatrix(link);
  assert.equal(m.length, 45, "version 7 for a link of this length");
  // The three finder patterns: dark 7x7 frames with a dark 3x3 centre.
  for (const [x0, y0] of [[0, 0], [m.length - 7, 0], [0, m.length - 7]]) {
    for (let i = 0; i < 7; i++) assert.ok(m[y0][x0 + i] && m[y0 + 6][x0 + i] && m[y0 + i][x0] && m[y0 + i][x0 + 6]);
    assert.ok(m[y0 + 3][x0 + 3] && !m[y0 + 1][x0 + 1]);
  }
  // The format bits beside the top-left finder say error correction M (00) and pass their BCH check.
  const bits = [0, 1, 2, 3, 4, 5, 7, 8].map((y) => m[y][8]).concat([7, 5, 4, 3, 2, 1, 0].map((x) => m[8][x]));
  const word = bits.reduce((a, b, i) => a | ((b ? 1 : 0) << i), 0) ^ 0x5412;
  assert.equal(word >>> 13, 0, "level M");
  let rem = word >>> 10;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  assert.equal(((word >>> 10) << 10) | rem, word, "the BCH code matches");
  assert.match(qrSvg(link), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 53 53"/);
  const src = readFileSync(join(ROOT, "studio-web", "qr.js"), "utf8");
  assert.doesNotMatch(src.replace("http://www.w3.org/2000/svg", ""), /https?:\/\/|fetch\(|import\(/, "it asks nobody");
});

// ── the console's own host (src/studio/admin-host.ts) ────────────────────────────────────────────────────────────

/** The Kleo site behind the app, as GitHub serves it: only its 404 page exists here. */
function siteStub() {
  const asked = [];
  answer = (u) => {
    asked.push(u);
    if (u.startsWith("https://raw.githubusercontent.com/")) return u.endsWith("/404.html") ? new Response("<h1>Page not found</h1>", { status: 200 }) : new Response("404: Not Found", { status: 404 });
    return new Response("no", { status: 500 });
  };
  return asked;
}

test("on any other host the console does not exist: its page, files and API are the site's 404, whoever asks", async () => {
  const { env, owner } = await setup();
  const asked = siteStub();
  try {
    for (const path of ["/admin", "/admin/users", "/admin.js", "/admin.css", "/qr.js", "/api/admin/overview", "/api/admin/auth"]) {
      const r = await call(env, path, { host: "app", cookie: owner.cookie });
      assert.equal(r.status, 404, path);
      assert.match(r.text, /Page not found/, `${path}: the site's own 404 page, no hint`);
    }
    assert.ok(asked.some((u) => u.endsWith("/404.html")));
  } finally { answer = null; }
  const me = await call(env, "/api/me", { host: "app", cookie: owner.studio });
  assert.equal(me.json.adminUrl, "https://admin.kleo.test/admin", "the owner's app shows the way to the console");
});

test("the admin host opens only with the owner's certificate: none, unverified, revoked or another one get a bare 403", async () => {
  const { env, owner } = await setup();
  const cases = [["no certificate", null], ["not presented", { ...GOOD_TLS, certPresented: "0" }], ["not verified", { ...GOOD_TLS, certVerified: "FAILED:self signed certificate" }],
    ["revoked", { ...GOOD_TLS, certRevoked: "1" }], ["another certificate", { ...GOOD_TLS, certFingerprintSHA256: "ab".repeat(32) }]];
  for (const [what, tls] of cases) {
    for (const path of ["/admin", "/api/admin/overview", "/admin.js", "/api/config", "/"]) {
      const r = await call(env, path, { host: "admin", tls, cookie: owner.cookie, from: { ip: "198.51.100.66", cf: { country: "US" } } });
      assert.equal(r.status, 403, `${what} ${path}`);
      assert.equal(r.text, "Forbidden", "nothing says why");
    }
  }
  const rows = env.DB.db.prepare("SELECT detail FROM audit WHERE event = 'admin.cert_refused'").all().map((r) => JSON.parse(r.detail));
  assert.equal(rows.length, 1, "one audit row a minute per address, however many requests");
  assert.deepEqual([rows[0].ip, rows[0].country, rows[0].why], ["198.51.100.66", "US", "no_cert"]);
  assert.deepEqual(rows[0].cert, { tls: null }, "what Cloudflare said about the certificate is kept");
  await call(env, "/admin", { host: "admin", tls: { ...GOOD_TLS, certFingerprintSHA256: "ab".repeat(32) }, from: { ip: "198.51.100.77" } });
  const seen = JSON.parse(env.DB.db.prepare("SELECT detail FROM audit WHERE event = 'admin.cert_refused' ORDER BY id DESC").get().detail);
  assert.deepEqual([seen.why, seen.cert.fingerprint, seen.cert.verified], ["wrong_cert", "ab".repeat(32), "SUCCESS"], "the fingerprint seen is logged: it is not a secret");
  assert.equal(subjects(env).filter((x) => /without your certificate/.test(x)).length, 1, "one e-mail an hour");
  // The certificate's fingerprint may be written with colons and capitals, in the setting or in what Cloudflare sends.
  env.ADMIN_CERT_SHA256 = `ab12, ${CERT_FP.toUpperCase().match(/../g).join(":")}`;
  assert.equal((await call(env, "/api/admin/overview", { cookie: owner.cookie })).status, 200);
  env.ADMIN_CERT_SHA256 = CERT_FP;
  assert.equal((await call(env, "/api/admin/overview", { cookie: owner.cookie, tls: { ...GOOD_TLS, certFingerprintSHA256: CERT_FP.toUpperCase().match(/../g).join(":") } })).status, 200);
  // The live setting: the owner's certificate, and the admin host among the Worker's custom domains.
  const cfg = readFileSync(join(ROOT, "wrangler.studio.jsonc"), "utf8");
  assert.match(cfg, /"ADMIN_CERT_SHA256": "47f40b62f8a92ed84e56a939ad3f929cd6b3b501fdb2b5ab5cd204226e929f18"/);
  assert.match(cfg, /\{ "pattern": "admin\.kleooai\.com", "custom_domain": true \}/);
});

test("with no fingerprint set the admin host opens for nobody, even with a valid certificate", async () => {
  const { env, owner } = await setup();
  for (const pin of ["", "   ", "not-a-fingerprint"]) {
    env.ADMIN_CERT_SHA256 = pin;
    assert.equal((await call(env, "/api/admin/overview", { cookie: owner.cookie })).status, 403, JSON.stringify(pin));
    assert.equal((await call(env, "/admin", {})).status, 403);
  }
  delete env.ADMIN_CERT_SHA256;
  assert.equal((await call(env, "/admin", {})).status, 403, "missing setting: closed too");
});

test("with the certificate the admin host is the console and nothing else; its own sign-in is a password; app sessions don't carry over", async () => {
  const { env, owner, ana } = await setup();
  assert.equal((await call(env, "/api/admin/overview", { cookie: owner.cookie })).status, 200, "certificate + Studio session + admin session");
  const root = await call(env, "/", { host: "admin" });
  assert.equal(root.status, 302);
  assert.equal(root.res.headers.get("location"), "https://admin.kleo.test/admin");
  const page = await call(env, "/admin/users", { host: "admin" });
  assert.equal(page.status, 200);
  assert.equal(page.res.headers.get("x-robots-tag"), "noindex, nofollow");
  for (const path of ["/video", "/account", "/library", "/c/c_abc", "/mcp", "/pricing/", "/health", "/auth/google"]) {
    assert.equal((await call(env, path, { host: "admin" })).status, 404, `${path}: customers' pages are not on the admin host`);
  }
  for (const [path, method] of [["/api/chats", "GET"], ["/api/generations", "GET"], ["/api/auth/signup", "POST"], ["/api/auth/key", "POST"], ["/api/auth/forgot", "POST"], ["/api/pay/session", "POST"]]) {
    assert.equal((await call(env, path, { host: "admin", method, cookie: owner.studio, body: method === "POST" ? {} : undefined })).status, 404, path);
  }
  const cfg = await call(env, "/api/config", { host: "admin" });
  assert.deepEqual([cfg.json.adminSite, cfg.json.social, cfg.json.google], [true, [], false], "a password sign-in only there");
  const signin = await call(env, "/api/auth/signin", { host: "admin", method: "POST", body: { email: "owner@example.com", password: "long enough pw" } });
  assert.equal(signin.status, 200, signin.text);
  assert.match(signin.res.headers.get("set-cookie"), /^__Host-kleo_studio=[^;]+; Path=\/;.*HttpOnly; Secure/);
  assert.doesNotMatch(signin.res.headers.get("set-cookie"), /Domain=/i, "host-only: an app.kleooai.com session never reaches the admin host, nor the other way");
  assert.equal((await call(env, "/api/admin/overview", { cookie: ana.cookie })).status, 404, "a customer with the certificate still finds nothing");
  assert.equal((await call(env, "/api/admin/overview", { host: "app", cookie: owner.cookie })).status, 404);
});
