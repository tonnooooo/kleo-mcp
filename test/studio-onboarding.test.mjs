/**
 * Kleo Studio's welcome e-mails (src/studio/onboarding.ts, the admin console's Emails page in src/studio/admin.ts and
 * studio-web/admin.js), inside one process: the kleo-studio Worker bundled with esbuild, on a D1 look-alike (node:sqlite,
 * every migration applied), with Cloudflare Email Sending faked. Covers the words (every e-mail renders, names are escaped,
 * nothing reads "undefined"), the switch (off sends nothing), the welcome series (first e-mail 20 minutes after sign-up,
 * one a day after, daytime only, the rescue e-mail once after a failed first try), the comeback series (once, the right
 * e-mail for what each account did, never to payers or the owner), the unsubscribe link (GET asks, POST and the one-click
 * POST stop), refusals (sender side pauses and tells the owner once, a bad address is suppressed), the daily cap, the
 * console's API, and the owner's preview route.
 * Run: node --test test/studio-onboarding.test.mjs
 */
import { register } from "node:module";
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
  async first() { const r = this.stmt.get(...this.args); return r ? { ...r } : null; }
  async all() { return { results: this.stmt.all(...this.args).map((r) => ({ ...r })) }; }
}
class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(s.stmt.reader ? await s.all() : await s.run()); return out; }
}
class FakeR2 {
  constructor() { this.m = new Map(); }
  async put(key, body) { this.m.set(key, body); return {}; }
  async get() { return null; }
  async delete(keys) { for (const k of [].concat(keys)) this.m.delete(k); }
  async list() { return { objects: [], truncated: false }; }
}
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://cloudflare-dns.com/dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }), { headers: { "content-type": "application/dns-json" } });
    return real(url, init);
  };
}

let worker, mod;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts";
      export * from "./src/studio/onboarding.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email"],
  });
  mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
  worker = mod.default;
});

const CERT_FP = "3f".repeat(32);
const GOOD_TLS = { certPresented: "1", certVerified: "SUCCESS", certRevoked: "0", certFingerprintSHA256: CERT_FP };
/** Email Sending, faked: every structured send is kept; `refuse` makes the next sends throw like the binding does. */
function fakeEmail() {
  const e = { sent: [], refuse: null, n: 0 };
  e.send = async (m) => {
    if (e.refuse) { const err = new Error(e.refuse.message); err.code = e.refuse.code; throw err; }
    e.sent.push(m);
    return { messageId: `m_${++e.n}` };
  };
  return e;
}
function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: new FakeR2(), ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", EPHONE_API_KEY: "ek", FREE_CREDITS: "5", STUDIO_FREE_MODELS: "seedance-2.0-fast",
    MAX_NEW_USERS_PER_IP_DAY: "50", MAX_ACCOUNTS_PER_ADDRESS: "50", ADMIN_HOST: "admin.kleo.test", ADMIN_CERT_SHA256: CERT_FP, STUDIO_VIDEO_FACTOR: "5/3",
    mails: [], OWNER_MAIL: { send: async (m) => { env.mails.push(m); } }, EMAIL: fakeEmail(),
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";

async function call(env, path, { method = "GET", body, cookie, header = true, host, headers = {}, raw } = {}) {
  const admin = host === "admin" || (host === undefined && /^\/(?:api\/)?admin(?:\/|$)/.test(path));
  const h = { "user-agent": SAFARI, ...headers };
  if (header) h["x-kleo"] = "1";
  if (cookie) h.cookie = cookie;
  if (body !== undefined && raw === undefined) h["content-type"] = "application/json";
  const req = new Request(`https://${admin ? "admin" : "app"}.kleo.test${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
  if (admin) Object.defineProperty(req, "cf", { value: { tlsClientAuth: GOOD_TLS } });
  const res = await worker.fetch(req, env, ctx);
  await Promise.allSettled(pending.splice(0));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, res };
}
const cookiesOf = (res) => res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""].filter(Boolean);
const sessionOf = (r) => cookiesOf(r.res).find((c) => c.startsWith("__Host-kleo_studio="))?.split(";")[0] ?? null;
async function signUp(env, email) {
  const r = await call(env, "/api/auth/signup", { method: "POST", body: { email, password: "long enough pw" } });
  assert.equal(r.status, 200, r.text);
  const session = sessionOf(r);
  const me = await call(env, "/api/me", { cookie: session });
  return { cookie: session, id: me.json.id };
}
const codeAt = (secret, offset = 0) => hotp(secret, stepAt(Date.now()) + offset);
async function setupAdmin(env) {
  const owner = await signUp(env, "owner@example.com");
  env.STUDIO_ADMINS = owner.id;
  const e = await call(env, "/api/admin/auth/enroll", { method: "POST", cookie: owner.cookie, body: { password: "long enough pw" } });
  assert.equal(e.status, 200, e.text);
  const c = await call(env, "/api/admin/auth/enroll/confirm", { method: "POST", cookie: owner.cookie, body: { code: await codeAt(base32Decode(e.json.secret), -1) } });
  assert.equal(c.status, 200, c.text);
  owner.admin = `${owner.cookie}; ${cookiesOf(c.res).find((x) => x.startsWith("__Host-kleo_admin="))?.split(";")[0]}`;
  owner.secret = base32Decode(e.json.secret);
  return owner;
}
const rows = (env, sql, ...a) => env.DB.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const one = (env, sql, ...a) => { const r = env.DB.db.prepare(sql).get(...a); return r ? { ...r } : r; };
const prices = () => mod.livePrices({ STUDIO_FREE_MODELS: "seedance-2.0-fast", STUDIO_VIDEO_FACTOR: "5/3" });
const HOUR = 3_600_000, DAY = 24 * HOUR;
/** Turns the e-mails on at `atMs` (what the console's switch writes). */
function switchOn(env, atMs) {
  env.DB.db.prepare("INSERT INTO studio_meta (key, value) VALUES ('onboarding_mode', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'").run();
  env.DB.db.prepare("INSERT OR REPLACE INTO studio_meta (key, value) VALUES ('onboarding_on_since', ?)").run(new Date(atMs).toISOString());
}
const setCreated = (env, id, ms) => env.DB.db.prepare("UPDATE users SET created_at = ? WHERE id = ?").run(new Date(ms).toISOString(), id);
const addGen = (env, userId, status, error = null) => env.DB.db.prepare("INSERT INTO studio_generations (id, user_id, model, settings, prompt, credits, status, error, refunded) VALUES (?, ?, 'seedance-2.0-fast', '{}', 'p', 4, ?, ?, ?)")
  .run(`g_${Math.random().toString(36).slice(2, 10)}`, userId, status, error, status === "failed" ? 1 : 0);
const pay = (env, userId) => env.DB.db.prepare("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status) VALUES (?, ?, 10, 500, 'eur', 'paid')").run(`cs_${Math.random().toString(36).slice(2)}`, userId);
/** A noon in UTC, so "daytime" for a person with no known country (treated as UTC) is now. */
const NOON = Date.parse("2026-11-02T12:00:00.000Z");

// ── the words ────────────────────────────────────────────────────────────────────────────────────────────────────

test("every e-mail renders for every kind of account: no undefined, NaN or null, a stop link, the right greeting", () => {
  const x = prices();
  assert.ok(x.freeVideo >= 1 && x.bestVideo >= x.freeVideo && /^€\d/.test(x.packFrom) && x.templates > 10, JSON.stringify(x));
  const people = [mod.sampleFacts(), mod.sampleFacts({ name: null, credits: 0 }), mod.sampleFacts({ paid: true, plan: "pro", credits: 90, made: 3 }), mod.sampleFacts({ failed: 2, copyright: true })];
  for (const key of mod.ALL_MAILS) for (const f of people) {
    const m = mod.compose(key, f, x);
    const html = mod.renderHtml(m, "https://app.kleooai.com/email/stop?u=u_x&s=y");
    const text = mod.renderText(m, "https://app.kleooai.com/email/stop?u=u_x&s=y");
    for (const out of [m.subject, html, text]) assert.doesNotMatch(out, /undefined|NaN|\bnull\b|\[object/, `${key}: ${out.slice(0, 200)}`);
    assert.ok(m.subject.length > 5 && m.subject.length < 80, `${key} subject: ${m.subject}`);
    assert.match(text, f.name ? new RegExp(`^Hi ${f.name},`) : /^Hi there,/);
    assert.match(html, /email\/stop\?u=u_x&amp;s=y/);
    assert.match(text, /Stop these e-mails: https:\/\/app\.kleooai\.com\/email\/stop/);
    assert.doesNotMatch(text, /\*\*|\]\(/, `${key}: markup left in the text version`);
  }
  // Day 2 to Day 7 say so in the subject, like Superhuman's.
  assert.equal(mod.compose("w1-templates", people[0], x).subject, "Day 2 of 7: Put yourself in a viral video");
  assert.match(mod.compose("w6-founder", people[0], x).subject, /^Day 7 of 7/);
  // Free accounts read the free price; a paying one reads its plan and never "free credits".
  assert.match(mod.renderText(mod.compose("w0-welcome", people[0], x), "s"), new RegExp(`costs ${x.freeVideo} credits, and you have 5`));
  assert.doesNotMatch(mod.renderText(mod.compose("w3-apps", people[2], x), "s"), /free credits/);
  assert.match(mod.renderText(mod.compose("w5-credits", people[2], x), "s"), /You're on the Pro plan, with 90 credits/);
  // A copyright refusal gets its own advice.
  assert.match(mod.renderText(mod.compose("rescue", people[3], x), "s"), /famous person, a brand or a protected character/);
});

test("names and links are escaped in the HTML; links carry the e-mail's tags", () => {
  const m = mod.compose("w0-welcome", mod.sampleFacts({ name: "<b>Eve</b>" }), prices());
  const html = mod.renderHtml(m, "https://app.kleooai.com/email/stop?u=u_x&s=y");
  assert.doesNotMatch(html, /<b>Eve<\/b>/);
  assert.match(html, /utm_source=email&amp;utm_medium=onboarding&amp;utm_campaign=w0-welcome/);
  assert.equal(mod.firstName("maria rossi"), "Maria");
  for (const bad of ["u_6avhjrtnzrsa", "leo@x.com", "1234", "", null, "x".repeat(30)]) assert.equal(mod.firstName(bad), null, String(bad));
  assert.equal(mod.firstName("Chloé"), "Chloé");
});

test("daytime: a moment at night moves to the next 9:00 there; a daytime one stays", () => {
  const night = Date.parse("2026-11-02T02:30:00.000Z"); // 15:30 in Auckland, 21:30 in New York the day before
  assert.equal(mod.inDaytime(night, "Pacific/Auckland"), night);
  const ny = mod.inDaytime(night, "America/New_York");
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date(ny)));
  assert.equal(hour, 9);
  assert.ok(ny > night && ny - night < 13 * HOUR);
  assert.equal(mod.zoneOf("it"), "Europe/Rome");
  assert.equal(mod.zoneOf(null), "UTC");
});

// ── the series ───────────────────────────────────────────────────────────────────────────────────────────────────

test("off: nothing is enrolled or sent", async () => {
  const env = newEnv();
  await signUp(env, "a@example.com");
  const r = await mod.mailTick(env, prices(), NOON + 2 * HOUR);
  assert.deepEqual(r, { sent: 0, skipped: 0, failed: 0 });
  assert.equal(rows(env, "SELECT * FROM studio_mail").length, 0);
  assert.equal(env.EMAIL.sent.length, 0);
});

test("welcome: the first e-mail 20 minutes after sign-up, then one a day, seven in all, from Leonardo with a one-click stop", async () => {
  const env = newEnv();
  switchOn(env, NOON - DAY);
  const a = await signUp(env, "maria@example.com");
  env.DB.db.prepare("UPDATE users SET display_name = 'Maria Rossi' WHERE id = ?").run(a.id);
  setCreated(env, a.id, NOON);
  let r = await mod.mailTick(env, prices(), NOON + 10 * 60_000);
  assert.equal(r.sent, 0, "not before 20 minutes");
  assert.equal(one(env, "SELECT track, step FROM studio_mail WHERE user_id = ?", a.id).track, "welcome");
  r = await mod.mailTick(env, prices(), NOON + 21 * 60_000);
  assert.equal(r.sent, 1);
  const m = env.EMAIL.sent[0];
  assert.equal(m.to, "maria@example.com");
  assert.deepEqual(m.from, { email: "hello@kleooai.com", name: "Leonardo from Kleo" });
  assert.equal(m.replyTo, "hello@kleooai.com");
  assert.equal(m.subject, "Welcome to Kleo, Maria");
  assert.match(m.headers["List-Unsubscribe"], /^<https:\/\/app\.kleooai\.com\/email\/stop\?u=u_[a-z0-9]+&s=[0-9a-f]{32}>, <mailto:hello@kleooai\.com\?subject=unsubscribe>$/);
  assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(m.html, /Hi Maria,/);
  // Nothing more the same day.
  r = await mod.mailTick(env, prices(), NOON + 3 * HOUR);
  assert.equal(r.sent, 0);
  // Then one a day, in order, and the series ends after Day 7.
  const subjects = [m.subject];
  for (let d = 1; d <= 8; d++) {
    await mod.mailTick(env, prices(), NOON + d * DAY + 2 * HOUR);
    subjects.push(...env.EMAIL.sent.slice(subjects.length).map((x) => x.subject));
  }
  assert.equal(subjects.length, 7, subjects.join(" | "));
  assert.match(subjects[1], /^Day 2 of 7/);
  assert.match(subjects[6], /^Day 7 of 7/);
  assert.equal(one(env, "SELECT status FROM studio_mail WHERE user_id = ?", a.id).status, "done");
  assert.equal(rows(env, "SELECT * FROM studio_mail_log WHERE kind = 'live' AND ok = 1").length, 7);
});

test("rescue: a failed first try with nothing made gets the rescue e-mail once, in place of the next day's", async () => {
  const env = newEnv();
  switchOn(env, NOON - DAY);
  const a = await signUp(env, "fail@example.com");
  setCreated(env, a.id, NOON);
  await mod.mailTick(env, prices(), NOON + 25 * 60_000);
  addGen(env, a.id, "failed", "the model refused: copyright");
  await mod.mailTick(env, prices(), NOON + DAY + 2 * HOUR);
  assert.equal(env.EMAIL.sent.at(-1).subject, "Your first video didn't come out");
  assert.match(env.EMAIL.sent.at(-1).text, /famous person/);
  await mod.mailTick(env, prices(), NOON + 2 * DAY + 2 * HOUR);
  assert.match(env.EMAIL.sent.at(-1).subject, /^Day 2 of 7/, "the series goes on where it was");
  await mod.mailTick(env, prices(), NOON + 3 * DAY + 2 * HOUR);
  assert.match(env.EMAIL.sent.at(-1).subject, /^Day 3 of 7/, "and the rescue never comes twice");
});

test("comeback: once, for the 30 days before the switch, the e-mail that fits; never payers, the owner or older accounts", async () => {
  const env = newEnv();
  const owner = await signUp(env, "owner@example.com");
  env.STUDIO_ADMINS = owner.id;
  const unused = await signUp(env, "unused@example.com");
  const failed = await signUp(env, "failed@example.com");
  const made = await signUp(env, "made@example.com");
  const payer = await signUp(env, "payer@example.com");
  const old = await signUp(env, "old@example.com");
  for (const u of [owner, unused, failed, made, payer]) setCreated(env, u.id, NOON - 5 * DAY);
  setCreated(env, old.id, NOON - 40 * DAY);
  addGen(env, failed.id, "failed", "timeout");
  addGen(env, made.id, "done");
  pay(env, payer.id);
  switchOn(env, NOON);
  await mod.mailTick(env, prices(), NOON + 1);
  const enrolled = rows(env, "SELECT user_id, track FROM studio_mail ORDER BY user_id").map((r) => r.user_id).sort();
  assert.deepEqual(enrolled, [unused.id, failed.id, made.id].sort());
  // Spread out: run the day and check who got which.
  for (let t = 0; t < 4 * HOUR; t += 5 * 60_000) await mod.mailTick(env, prices(), NOON + t);
  const got = Object.fromEntries(env.EMAIL.sent.map((m) => [m.to, m.subject]));
  assert.equal(got["unused@example.com"], "Your 5 Kleo credits are still here");
  assert.equal(got["failed@example.com"], "Sorry about your first Kleo video");
  assert.equal(got["made@example.com"], "Three things to try next on Kleo");
  assert.equal(Object.keys(got).length, 3);
  // Three days later the founder's question; a purchase in between stops that account.
  pay(env, made.id);
  for (let t = 3 * DAY; t < 3 * DAY + 6 * HOUR; t += 5 * 60_000) await mod.mailTick(env, prices(), NOON + t);
  const second = env.EMAIL.sent.slice(3).map((m) => m.to).sort();
  assert.deepEqual(second, ["failed@example.com", "unused@example.com"]);
  assert.equal(one(env, "SELECT stop_reason FROM studio_mail WHERE user_id = ?", made.id).stop_reason, "paid");
  // Switching off and on again never sends the comeback a second time.
  env.DB.db.prepare("UPDATE studio_meta SET value = 'off' WHERE key = 'onboarding_mode'").run();
  switchOn(env, NOON);
  env.DB.db.prepare("DELETE FROM studio_mail").run();
  await mod.mailTick(env, prices(), NOON + 5 * DAY);
  assert.equal(rows(env, "SELECT * FROM studio_mail WHERE track = 'comeback'").length, 0);
});

// ── stopping ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("unsubscribe: GET only asks; the button and the one-click POST stop it for good; a forged link stops nothing", async () => {
  const env = newEnv();
  switchOn(env, NOON - DAY);
  const a = await signUp(env, "stop@example.com");
  setCreated(env, a.id, NOON);
  await mod.mailTick(env, prices(), NOON + 25 * 60_000);
  const link = env.EMAIL.sent[0].headers["List-Unsubscribe"].match(/<(https:[^>]+)>/)[1];
  const path = link.replace("https://app.kleooai.com", "");
  const look = await call(env, path, { header: false });
  assert.equal(look.status, 200);
  assert.match(look.text, /Stop Kleo&#39;s e-mails\?/);
  assert.equal(one(env, "SELECT status FROM studio_mail WHERE user_id = ?", a.id).status, "active", "a GET (a mail scanner) stops nothing");
  const bad = await call(env, path.replace(/s=[0-9a-f]+/, "s=" + "0".repeat(32)), { method: "POST", header: false, raw: "List-Unsubscribe=One-Click" });
  assert.equal(bad.status, 400);
  const click = await call(env, path, { method: "POST", header: false, raw: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(click.status, 200);
  assert.match(click.text, /You&#39;re unsubscribed/);
  assert.equal(one(env, "SELECT reason FROM mail_suppress WHERE email = 'stop@example.com'").reason, "unsubscribe");
  assert.equal(one(env, "SELECT status FROM studio_mail WHERE user_id = ?", a.id).status, "stopped");
  await mod.mailTick(env, prices(), NOON + 2 * DAY);
  assert.equal(env.EMAIL.sent.length, 1);
});

test("refusals: Kleo's side pauses everything and tells the owner once; a bad address is suppressed; quota waits", async () => {
  const env = newEnv();
  switchOn(env, NOON - DAY);
  const a = await signUp(env, "one@example.com");
  const b = await signUp(env, "two@example.com");
  setCreated(env, a.id, NOON); setCreated(env, b.id, NOON);
  env.EMAIL.refuse = { code: "E_SENDER_NOT_VERIFIED", message: "Sender domain not verified" };
  let r = await mod.mailTick(env, prices(), NOON + 25 * 60_000);
  assert.equal(r.paused, "sender");
  assert.equal(env.mails.length, 1, "the owner hears");
  assert.match(env.mails[0].raw, /waiting/);
  await mod.mailTick(env, prices(), NOON + 30 * 60_000);
  assert.equal(env.mails.length, 1, "once, not every tick");
  assert.equal(rows(env, "SELECT * FROM studio_mail WHERE status = 'active'").length, 2, "nobody is dropped");
  env.EMAIL.refuse = { code: "E_RATE_LIMIT_EXCEEDED", message: "Daily sending quota exceeded" };
  r = await mod.mailTick(env, prices(), NOON + 35 * 60_000);
  assert.equal(r.paused, "rate");
  env.EMAIL.refuse = { code: "E_RECIPIENT_SUPPRESSED", message: "Recipient is on the suppression list (hard bounce)" };
  r = await mod.mailTick(env, prices(), NOON + 40 * 60_000);
  assert.equal(r.failed, 2);
  assert.equal(rows(env, "SELECT * FROM mail_suppress WHERE reason = 'bounce'").length, 2);
  assert.equal(rows(env, "SELECT * FROM studio_mail WHERE status = 'stopped'").length, 2);
});

test("caps: never more than the daily cap in one UTC day, nor the per-tick number", async () => {
  const env = newEnv({ STUDIO_MAIL_DAILY_CAP: "3", STUDIO_MAIL_PER_TICK: "2" });
  switchOn(env, NOON - DAY);
  for (let i = 0; i < 5; i++) { const u = await signUp(env, `p${i}@example.com`); setCreated(env, u.id, NOON); }
  let r = await mod.mailTick(env, prices(), NOON + 25 * 60_000);
  assert.equal(r.sent, 2);
  r = await mod.mailTick(env, prices(), NOON + 30 * 60_000);
  assert.equal(r.sent, 1);
  r = await mod.mailTick(env, prices(), NOON + 35 * 60_000);
  assert.equal(r.paused, "daily cap");
});

// ── the console and the owner's preview ──────────────────────────────────────────────────────────────────────────

test("console: the Emails page, every preview, the switch, the test send to the owner, one address stopped by hand", async () => {
  const env = newEnv();
  const owner = await setupAdmin(env);
  const c = await signUp(env, "someone@example.com");
  let r = await call(env, "/api/admin/emails", { cookie: owner.admin });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.on, false);
  assert.equal(r.json.mails.length, 12);
  assert.equal(r.json.comeback.total, 1, "the customer, never the owner");
  for (const m of r.json.mails) {
    const p = await call(env, `/api/admin/emails/preview?key=${m.key}`, { cookie: owner.admin });
    assert.equal(p.status, 200, m.key);
    assert.match(p.json.html, /<!doctype html>/);
    assert.equal(p.json.subject, m.subject);
  }
  // A customer cannot reach any of it.
  assert.equal((await call(env, "/api/admin/emails", { cookie: c.cookie })).status, 404);
  r = await call(env, "/api/admin/emails/mode", { method: "POST", cookie: owner.admin, body: { on: true, code: await codeAt(owner.secret) } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await call(env, "/api/admin/emails", { cookie: owner.admin })).json.on, true);
  r = await call(env, "/api/admin/emails/test", { method: "POST", cookie: owner.admin, body: {} });
  assert.equal(r.json.sent, 12);
  assert.ok(env.EMAIL.sent.every((m) => m.to === "kleooai@gmail.com" && /^\[Preview \d+\/12\]/.test(m.subject)));
  r = await call(env, "/api/admin/emails/suppress", { method: "POST", cookie: owner.admin, body: { email: "Someone@Example.com", on: true } });
  assert.equal(r.status, 200);
  assert.equal(one(env, "SELECT reason FROM mail_suppress WHERE email = 'someone@example.com'").reason, "manual");
  r = await call(env, "/api/admin/emails/mode", { method: "POST", cookie: owner.admin, body: { on: false } });
  assert.equal((await call(env, "/api/admin/emails", { cookie: owner.admin })).json.on, false);
});

test("the owner's preview route: the INTERNAL_SECRET as bearer, and only to the owner's own inbox", async () => {
  const env = newEnv();
  assert.equal((await call(env, "/api/internal/mail/preview", { method: "POST", header: false })).status, 404);
  assert.equal((await call(env, "/api/internal/mail/preview", { method: "POST", header: false, headers: { authorization: "Bearer nope" } })).status, 404);
  const r = await call(env, "/api/internal/mail/preview", { method: "POST", header: false, headers: { authorization: "Bearer s3cret" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.sent, 12);
  assert.deepEqual([...new Set(env.EMAIL.sent.map((m) => m.to))], ["kleooai@gmail.com"]);
});
