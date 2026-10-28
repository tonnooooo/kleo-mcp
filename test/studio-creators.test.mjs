/**
 * Kleo Creators (src/studio/creators.ts, studio-web/creators.js, the admin console's Creators page) inside one process:
 * the kleo-studio Worker bundled with esbuild, on a D1 look-alike (node:sqlite, every migration applied).
 * Covers the rules as numbers, the application with its automatic refusals (no plan, the thresholds, a second seat of
 * the same person, a payment from another country), the owner's review (bio code, approve, refuse, levels, ban), posts
 * read at day 7 with the bonus table and the monthly cap, program credits spent first and expiring, commissions as
 * credits or cash (held 60 days, reversed on a refund, void for a buyer who is the creator), the month's grants and
 * judgement, the Pro partner's plan from the program, and the public list.
 * Run: node --test test/studio-creators.test.mjs
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
const DAY = 86_400_000;

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
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://cloudflare-dns.com/dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }), { headers: { "content-type": "application/dns-json" } });
    return real(url, init);
  };
}
globalThis.FixedLengthStream ??= class extends TransformStream { constructor() { super(); } };

let worker, mod;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts"; export { APP_PATH } from "./src/studio/site.ts";
      export { bonusFor, entryProblems, cleanHandle, postAddress, netOf, monthOf, prevMonth, nextMonth, creatorsTick, judgeMonth, syncCommissions,
        expireProgramCredits, grantProgram, LEVELS, VIEW_BONUSES } from "./src/studio/creators.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email"],
  });
  mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
  worker = mod.default;
});

const CERT_FP = "3f".repeat(32);
const GOOD_TLS = { certPresented: "1", certVerified: "SUCCESS", certRevoked: "0", certFingerprintSHA256: CERT_FP, certIssuerDN: "CN=Cloudflare" };
function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: { put: async () => ({}), get: async () => null, delete: async () => {}, list: async () => ({ objects: [] }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", FREE_CREDITS: "5", MAX_NEW_USERS_PER_IP_DAY: "50", MAX_ACCOUNTS_PER_ADDRESS: "50",
    ADMIN_HOST: "admin.kleo.test", ADMIN_CERT_SHA256: CERT_FP, mails: [], OWNER_MAIL: { send: async (m) => { env.mails.push(m); } },
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
const BERLIN = { ip: "95.33.163.20", cf: { country: "DE", city: "Berlin" } };
const ROME = { ip: "151.20.1.9", cf: { country: "IT", city: "Rome" } };
const NZ = { ip: "203.0.113.9", cf: { country: "NZ", city: "Auckland" } };
async function call(env, path, { method = "GET", body, cookie, from, headers = {} } = {}) {
  const admin = /^\/(?:api\/)?admin(?:\/|$)/.test(path);
  const h = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)", "x-kleo": "1", ...headers };
  if (cookie) h.cookie = cookie;
  if (from?.ip) h["cf-connecting-ip"] = from.ip;
  if (body !== undefined) h["content-type"] = "application/json";
  const req = new Request(`https://${admin ? "admin" : "app"}.kleo.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const cf = admin ? { ...(from?.cf ?? {}), tlsClientAuth: GOOD_TLS } : from?.cf;
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
const codeAt = (secret, offset = 0) => hotp(secret, stepAt(Date.now()) + offset);
async function setup() {
  const env = newEnv();
  const owner = await account(env, "owner@example.com", NZ);
  env.STUDIO_ADMINS = owner.id;
  const e = await call(env, "/api/admin/auth/enroll", { method: "POST", cookie: owner.cookie, body: { password: "long enough pw" }, from: NZ });
  assert.equal(e.status, 200, e.text);
  const c = await call(env, "/api/admin/auth/enroll/confirm", { method: "POST", cookie: owner.cookie, body: { code: await codeAt(base32Decode(e.json.secret), -1) }, from: NZ });
  assert.equal(c.status, 200, c.text);
  owner.admin = `${owner.cookie}; ${cookieOf(c)}`;
  const ana = await account(env, "ana@example.com", BERLIN);
  return { env, owner, ana };
}
const run = (env, sql, ...a) => env.DB.db.prepare(sql).run(...a);
const get = (env, sql, ...a) => env.DB.db.prepare(sql).get(...a);
const giveLite = (env, id, country = "DE") => {
  run(env, "UPDATE users SET plan = 'lite', plan_period = 'month', plan_credits = 22, plan_until = ?, plan_status = 'active' WHERE id = ?", new Date(Date.now() + 20 * DAY).toISOString(), id);
  run(env, "INSERT OR IGNORE INTO payments (session_id, user_id, credits, amount_cent, currency, status, country, at) VALUES (?, ?, 22, 900, 'eur', 'paid', ?, ?)", `cs_plan_${id}`, id, country, new Date(Date.now() - 2 * DAY).toISOString());
};
const APP = {
  name: "Ana Rossi", platform: "instagram", handle: "@Ana.Makes.AI", followers: "12400", bestViews: "80000", accountSince: "2024-02", aiPosts: "40",
  usernameChanges: "0", country: "DE", bestUrl: "https://www.instagram.com/reel/ABC123/?igsh=xyz", about: "Short AI horror films.", accept: true,
};
const creditsOf = (env, id) => get(env, "SELECT credits, program_credits FROM users WHERE id = ?", id);
/** Applies, sees the bio code, approves: the account is a Creator with its /r/ link. */
async function approved(env, owner, who, body = APP, level = "creator") {
  giveLite(env, who.id, body.country);
  const a = await call(env, "/api/creators/apply", { method: "POST", cookie: who.cookie, body });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.state, "applied", a.text);
  assert.equal((await call(env, `/api/admin/creators/${who.id}/bio`, { method: "POST", cookie: owner.admin, body: {} })).status, 200);
  const ok = await call(env, `/api/admin/creators/${who.id}/approve`, { method: "POST", cookie: owner.admin, body: { reason: "Approved after review", level } });
  assert.equal(ok.status, 200, ok.text);
  return ok.json;
}

test("the rules as numbers: bonus table, entry thresholds, handles, post links, Stripe's fee", () => {
  assert.equal(mod.bonusFor(9_999), 0);
  assert.equal(mod.bonusFor(10_000), 15);
  assert.equal(mod.bonusFor(64_000), 40);
  assert.equal(mod.bonusFor(2_000_000), 80);
  const now = Date.parse("2026-10-28T00:00:00Z");
  assert.deepEqual(mod.entryProblems({ followers: 1500, bestViews: 0, accountSince: "2025-01", aiPosts: 9, usernameChanges: 2 }, now), []);
  assert.deepEqual(mod.entryProblems({ followers: 200, bestViews: 12_000, accountSince: "2025-01", aiPosts: 20, usernameChanges: 0 }, now), [], "a post with 10,000 views stands in for followers");
  const bad = mod.entryProblems({ followers: 200, bestViews: 500, accountSince: "2026-07", aiPosts: 3, usernameChanges: 3 }, now);
  assert.equal(bad.length, 4);
  assert.equal(mod.cleanHandle("instagram", "@Kleo.Ai"), "Kleo.Ai");
  assert.equal(mod.cleanHandle("instagram", "https://www.instagram.com/kleooai/?hl=en"), "kleooai");
  assert.equal(mod.cleanHandle("instagram", "https://www.tiktok.com/@kleooai"), "", "a link to another network is not a handle");
  assert.equal(mod.cleanHandle("tiktok", "bad handle!"), "");
  assert.deepEqual(mod.postAddress("instagram", "https://www.instagram.com/reel/ABC/?igsh=1"), { url: "https://www.instagram.com/reel/ABC/", key: "instagram.com/reel/abc" });
  assert.equal(mod.postAddress("youtube", "https://www.youtube.com/watch?v=xyz&t=3").key, "youtube.com/watch?v=xyz");
  assert.equal(mod.postAddress("instagram", "https://www.tiktok.com/@a/video/1"), null);
  assert.equal(mod.postAddress("instagram", "http://www.instagram.com/reel/ABC/"), null, "https only");
  assert.equal(mod.netOf(1000), 1000 - 29 - 30);
  assert.equal(mod.prevMonth("2026-01"), "2025-12");
  assert.equal(mod.nextMonth("2026-12"), "2027-01");
});

test("applying: a paid plan first, the agreement, then the numbers; a public list only of real creators", async () => {
  const { env, owner, ana } = await setup();
  const none = await call(env, "/api/creators/me", { cookie: ana.cookie });
  assert.equal(none.json.state, "none");
  assert.equal(none.json.plan, null);
  assert.equal(none.json.rules.levels.length, 3);
  const noPlan = await call(env, "/api/creators/apply", { method: "POST", cookie: ana.cookie, body: APP });
  assert.equal(noPlan.status, 402);
  assert.equal(noPlan.json.code, "creator_plan");
  giveLite(env, ana.id);
  assert.equal((await call(env, "/api/creators/apply", { method: "POST", cookie: ana.cookie, body: { ...APP, accept: false } })).json.code, "creator_terms");
  assert.equal((await call(env, "/api/creators/apply", { method: "POST", cookie: ana.cookie, body: { ...APP, bestUrl: "https://example.com/x" } })).json.code, "creator_best");
  const a = await call(env, "/api/creators/apply", { method: "POST", cookie: ana.cookie, body: APP });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.state, "applied");
  assert.equal(a.json.handle, "Ana.Makes.AI");
  assert.match(a.json.bioCode, /^KLEO-[A-Z0-9]{6}$/);
  assert.equal((await call(env, "/api/creators/apply", { method: "POST", cookie: ana.cookie, body: APP })).status, 409, "one application at a time");
  // Nobody is listed until the owner approves.
  assert.deepEqual((await call(env, "/api/creators/public")).json.creators, []);
  const pub = await call(env, "/api/creators/public");
  assert.equal(pub.res.headers.get("access-control-allow-origin"), "*", "the site's page on kleooai.com reads it");
  // The owner's list shows it, with the code to look for.
  const list = await call(env, "/api/admin/creators", { cookie: owner.admin });
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.applied.length, 1);
  assert.equal(list.json.applied[0].bio_code, a.json.bioCode);
  // Approve wants the bio code seen.
  const early = await call(env, `/api/admin/creators/${ana.id}/approve`, { method: "POST", cookie: owner.admin, body: { reason: "looks fine" } });
  assert.equal(early.json.code, "creator_bio");
  assert.equal((await call(env, "/api/creators/public")).json.creators.length, 0);
  assert.ok(mod.APP_PATH.test("/creators") && mod.APP_PATH.test("/creators.js"), "the page and its module are the app's");
});

test("automatic refusals: the thresholds are said, a second seat or another country is not", async () => {
  const { env, ana } = await setup();
  giveLite(env, ana.id);
  const young = await call(env, "/api/creators/apply", { method: "POST", cookie: ana.cookie, body: { ...APP, followers: "300", bestViews: "900", accountSince: "2026-09" } });
  assert.equal(young.json.state, "refused");
  assert.match(young.json.why, /1,000 followers/);
  assert.match(young.json.why, /6 months/);
  assert.equal((await call(env, "/api/creators/apply", { method: "POST", cookie: ana.cookie, body: APP })).json.code, "creator_wait", "again only after 30 days");

  // The same person on a second account (same sign-up address): refused, and not told why.
  const bea = await account(env, "bea@example.com", ROME);
  await approvedLike(env, bea);
  const twin = await account(env, "bea.second@example.com", ROME);
  giveLite(env, twin.id, "IT");
  const t = await call(env, "/api/creators/apply", { method: "POST", cookie: twin.cookie, body: { ...APP, handle: "bea.two", country: "IT" } });
  assert.equal(t.json.state, "refused");
  assert.equal(t.json.why, null, "a shared seat is not explained");
  assert.match(get(env, "SELECT flags FROM creators WHERE user_id = ?", twin.id).flags, /^seat:/);

  // Paid from one country, says another.
  const cy = await account(env, "cy@example.com", NZ);
  giveLite(env, cy.id, "VN");
  const c = await call(env, "/api/creators/apply", { method: "POST", cookie: cy.cookie, body: { ...APP, handle: "cy.ai", country: "GB" } });
  assert.equal(c.json.state, "refused");
  assert.equal(c.json.why, null);
  assert.match(get(env, "SELECT flags FROM creators WHERE user_id = ?", cy.id).flags, /country:VN/);
  // A handle belongs to one account.
  const dup = await call(env, "/api/creators/apply", { method: "POST", cookie: cy.cookie, body: APP });
  assert.ok(dup.status >= 400);
});
/** A waiting application for someone, through the API (no approval). */
async function approvedLike(env, who) {
  giveLite(env, who.id, "IT");
  const r = await call(env, "/api/creators/apply", { method: "POST", cookie: who.cookie, body: { ...APP, handle: "bea.makes", country: "IT" } });
  assert.equal(r.json.state, "applied", r.text);
}

test("approved: a /r/ link, the public list, posts read at day 7 with the bonus table and the monthly cap", async () => {
  const { env, owner, ana } = await setup();
  const d = await approved(env, owner, ana);
  assert.equal(d.creator.status, "active");
  assert.equal(d.creator.link_code, "c-ana-makes-ai");
  assert.ok(get(env, "SELECT 1 AS one FROM short_links WHERE code = 'c-ana-makes-ai'"), "the short link exists");
  const pub = await call(env, "/api/creators/public");
  assert.deepEqual(pub.json.creators.map((c) => [c.handle, c.level]), [["Ana.Makes.AI", "Creator"]]);
  const me = await call(env, "/api/creators/me", { cookie: ana.cookie });
  assert.equal(me.json.state, "active");
  assert.equal(me.json.link, "https://app.kleooai.com/r/c-ana-makes-ai");
  assert.equal(me.json.figures.posts.needed, 2);
  // Posts: on the creator's own network, each once.
  assert.equal((await call(env, "/api/creators/posts", { method: "POST", cookie: ana.cookie, body: { url: "https://www.tiktok.com/@x/video/1" } })).json.code, "creator_post_url");
  const urls = ["https://www.instagram.com/reel/P1/", "https://www.instagram.com/reel/P2/", "https://www.instagram.com/reel/P3/", "https://www.instagram.com/reel/P4/"];
  for (const url of urls) assert.equal((await call(env, "/api/creators/posts", { method: "POST", cookie: ana.cookie, body: { url } })).status, 200);
  assert.equal((await call(env, "/api/creators/posts", { method: "POST", cookie: ana.cookie, body: { url: "https://instagram.com/reel/P1?igsh=2" } })).json.code, "creator_post_dupe");
  const posts = (await call(env, "/api/admin/creators", { cookie: owner.admin })).json.posts;
  assert.equal(posts.length, 4);
  const before = creditsOf(env, ana.id);
  const approve = (id, views) => call(env, `/api/admin/creators/posts/${id}`, { method: "POST", cookie: owner.admin, body: { action: "approve", views } });
  const byUrl = (u) => posts.find((p) => p.url === u).id;
  assert.equal((await approve(byUrl(urls[0]), 120_000)).json.bonus, 80);
  assert.equal((await approve(byUrl(urls[1]), 60_000)).json.bonus, 40);
  assert.equal((await approve(byUrl(urls[2]), 200_000)).json.bonus, 30, "the 150-credit monthly cap");
  const rej = await call(env, `/api/admin/creators/posts/${byUrl(urls[3])}`, { method: "POST", cookie: owner.admin, body: { action: "reject", reason: "No Made with Kleo mark" } });
  assert.equal(rej.status, 200);
  const after = creditsOf(env, ana.id);
  assert.equal(after.credits - before.credits, 150);
  assert.equal(after.program_credits - before.program_credits, 150);
  const mine = (await call(env, "/api/creators/me", { cookie: ana.cookie })).json;
  assert.equal(mine.figures.posts.counted, 3);
  assert.equal(mine.figures.posts.bonus, 150);
  assert.equal(mine.posts.find((p) => p.status === "rejected").reason, "No Made with Kleo mark");
  assert.equal((await approve(byUrl(urls[0]), 1)).status, 400, "a post is read once");
});

test("program credits are spent first and only what is left of a grant expires", async () => {
  const { env, owner, ana } = await setup();
  await approved(env, owner, ana);
  run(env, "UPDATE users SET credits = 30 WHERE id = ?", ana.id); // 30 purchased credits
  await mod.grantProgram(env, ana.id, "manual", "t1", 20, "test");
  assert.deepEqual({ ...creditsOf(env, ana.id) }, { credits: 50, program_credits: 20 });
  assert.equal(await mod.grantProgram(env, ana.id, "manual", "t1", 20, "test"), 0, "one grant per ref");
  run(env, "UPDATE users SET credits = credits - 12 WHERE id = ?", ana.id); // a generation
  assert.deepEqual({ ...creditsOf(env, ana.id) }, { credits: 38, program_credits: 8 }, "the trigger took the spend off the program part");
  run(env, "UPDATE creator_credits SET expires_at = ? WHERE user_id = ?", new Date(Date.now() - 1000).toISOString(), ana.id);
  const gone = await mod.expireProgramCredits(env);
  assert.equal(gone, 8);
  assert.deepEqual({ ...creditsOf(env, ana.id) }, { credits: 30, program_credits: 0 }, "the 30 purchased credits stay");
  assert.equal(get(env, "SELECT left_amount, taken FROM creator_credits WHERE user_id = ? AND ref = 't1'", ana.id).taken, 8);
});

test("commission: credits at once, cash after 60 days, reversed on a refund, nothing for a buyer who is the creator", async () => {
  const { env, owner, ana } = await setup();
  await approved(env, owner, ana);
  const buyer = await account(env, "buyer@example.com", NZ);
  run(env, "INSERT INTO user_attribution (user_id, channel, link_code) VALUES (?, 'instagram', 'c-ana-makes-ai') ON CONFLICT (user_id) DO UPDATE SET link_code = excluded.link_code", buyer.id);
  run(env, "INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, at) VALUES ('cs_b1', ?, 110, 3900, 'eur', 'paid', ?)", buyer.id, new Date().toISOString());
  const before = creditsOf(env, ana.id).credits;
  const s1 = await mod.syncCommissions(env);
  assert.equal(s1.made, 1);
  const k = get(env, "SELECT * FROM creator_commissions WHERE session_id = 'cs_b1'");
  assert.equal(k.status, "credited");
  assert.equal(k.net_cent, mod.netOf(3900));
  assert.equal(k.commission_cent, Math.round(mod.netOf(3900) * 0.25));
  assert.equal(k.credits, Math.round(k.commission_cent * 1.5 / 50));
  assert.equal(creditsOf(env, ana.id).credits - before, k.credits);
  assert.equal((await mod.syncCommissions(env)).made, 0, "once per payment");
  // Refunded: the credits still unspent go back.
  run(env, "UPDATE payments SET status = 'refunded' WHERE session_id = 'cs_b1'");
  await mod.syncCommissions(env);
  assert.equal(get(env, "SELECT status, reason FROM creator_commissions WHERE session_id = 'cs_b1'").status, "void");
  assert.equal(creditsOf(env, ana.id).credits, before);

  // Cash: held 60 days, then ready, then paid by the owner with a reference.
  const pay = await call(env, "/api/creators/payout", { method: "POST", cookie: ana.cookie, body: { pref: "cash", email: "ana.paypal@example.com" } });
  assert.equal(pay.status, 200, pay.text);
  const paidAt = new Date(Date.now() - 61 * DAY).toISOString();
  run(env, "UPDATE users SET created_at = ? WHERE id = ?", new Date(Date.now() - 62 * DAY).toISOString(), buyer.id);
  run(env, "UPDATE creators SET approved_at = ? WHERE user_id = ?", new Date(Date.now() - 90 * DAY).toISOString(), ana.id);
  run(env, "INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, at) VALUES ('cs_b2', ?, 50, 1900, 'eur', 'paid', ?)", buyer.id, paidAt);
  await mod.syncCommissions(env);
  assert.equal(get(env, "SELECT status FROM creator_commissions WHERE session_id = 'cs_b2'").status, "ready", "past the 60 days at once");
  const due = (await call(env, "/api/admin/creators", { cookie: owner.admin })).json.due;
  assert.equal(due.length, 1);
  assert.equal(due[0].payout_email, "ana.paypal@example.com");
  const out = await call(env, `/api/admin/creators/${ana.id}/payout`, { method: "POST", cookie: owner.admin, body: { reason: "paid", method: "paypal", ref: "PP-123456" } });
  assert.equal(out.status, 200, out.text);
  assert.equal(get(env, "SELECT status FROM creator_commissions WHERE session_id = 'cs_b2'").status, "paid_out");
  assert.equal(get(env, "SELECT cents FROM creator_payouts WHERE creator_id = ?", ana.id).cents, Math.round(mod.netOf(1900) * 0.25));

  // A buyer on the creator's own sign-up address earns nothing.
  const self = await account(env, "ana.alt@example.com", BERLIN);
  run(env, "INSERT INTO user_attribution (user_id, channel, link_code) VALUES (?, 'instagram', 'c-ana-makes-ai') ON CONFLICT (user_id) DO UPDATE SET link_code = excluded.link_code", self.id);
  run(env, "INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, at) VALUES ('cs_self', ?, 10, 500, 'eur', 'paid', ?)", self.id, new Date().toISOString());
  await mod.syncCommissions(env);
  const v = get(env, "SELECT status, reason FROM creator_commissions WHERE session_id = 'cs_self'");
  assert.deepEqual({ ...v }, { status: "void", reason: "shared" });
});

test("the month: Partner credits on the 1st, the +50% for enough posts, one level down for a month without, out after two", async () => {
  const { env, owner, ana } = await setup();
  await approved(env, owner, ana);
  const month = mod.monthOf(Date.now());
  // Partner: the plan's 22 topped up to Starter's 50 at once, for this month.
  const lv = await call(env, `/api/admin/creators/${ana.id}/level`, { method: "POST", cookie: owner.admin, body: { level: "partner", reason: "30,000 views" } });
  assert.equal(lv.status, 200, lv.text);
  assert.equal(get(env, "SELECT amount FROM creator_credits WHERE user_id = ? AND kind = 'level' AND ref = ?", ana.id, month).amount, 28);
  // Last month judged: a full month with 4 posts gives +50% of 50.
  const last = mod.prevMonth(month);
  run(env, "UPDATE creators SET approved_at = ? WHERE user_id = ?", `${mod.prevMonth(last)}-15T00:00:00.000Z`, ana.id);
  for (let i = 0; i < 4; i++) run(env, "INSERT INTO creator_posts (id, user_id, url, url_key, month, status) VALUES (?, ?, ?, ?, ?, 'eligible')", `cp_m${i}`, ana.id, `https://www.instagram.com/reel/M${i}/`, `m${i}`, last);
  const j = await mod.judgeMonth(env, last);
  assert.equal(j.boosted, 1);
  assert.equal(get(env, "SELECT amount FROM creator_credits WHERE user_id = ? AND kind = 'boost' AND ref = ?", ana.id, last).amount, 25);
  // The month before had nothing: one level down; then another empty month ends the place.
  const older = mod.prevMonth(last);
  run(env, "UPDATE creators SET approved_at = ? WHERE user_id = ?", `${mod.prevMonth(older)}-15T00:00:00.000Z`, ana.id);
  const j2 = await mod.judgeMonth(env, older);
  assert.equal(j2.down, 1);
  const c = get(env, "SELECT level, misses, status FROM creators WHERE user_id = ?", ana.id);
  assert.deepEqual({ ...c }, { level: "creator", misses: 1, status: "active" });
  // A month that began before the approval is never held against the creator; one fully inside the program is.
  assert.equal((await mod.judgeMonth(env, mod.prevMonth(older))).ended, 0, "the approval month is a grace month");
  run(env, "UPDATE creators SET approved_at = ? WHERE user_id = ?", `${mod.prevMonth(mod.prevMonth(older))}-15T00:00:00.000Z`, ana.id);
  const j3 = await mod.judgeMonth(env, mod.prevMonth(older));
  assert.equal(j3.ended, 1);
  assert.equal(get(env, "SELECT status FROM creators WHERE user_id = ?", ana.id).status, "ended");
});

test("Pro partner: a plan from the program opens HD templates; no paid plan pauses a Creator; a ban takes credits back", async () => {
  const { env, owner, ana } = await setup();
  await approved(env, owner, ana);
  run(env, "UPDATE users SET plan = 'trial', plan_until = NULL WHERE id = ?", ana.id);
  assert.equal((await call(env, "/api/me", { cookie: ana.cookie })).json.hdTemplates, false);
  const pro = await call(env, `/api/admin/creators/${ana.id}/level`, { method: "POST", cookie: owner.admin, body: { level: "pro", reason: "10 paying people" } });
  assert.equal(pro.status, 200, pro.text);
  assert.ok(get(env, "SELECT comp_until FROM creators WHERE user_id = ?", ana.id).comp_until);
  assert.equal(get(env, "SELECT amount FROM creator_credits WHERE user_id = ? AND kind = 'comp'", ana.id).amount, 110);
  assert.equal((await call(env, "/api/me", { cookie: ana.cookie })).json.hdTemplates, true, "the program's plan opens what a plan opens");
  // Back to Creator with no plan: the next tick pauses the place.
  await call(env, `/api/admin/creators/${ana.id}/level`, { method: "POST", cookie: owner.admin, body: { level: "creator", reason: "test" } });
  assert.equal((await call(env, "/api/me", { cookie: ana.cookie })).json.hdTemplates, false);
  await mod.creatorsTick(env);
  assert.equal(get(env, "SELECT status FROM creators WHERE user_id = ?", ana.id).status, "paused");
  giveLite(env, ana.id);
  await mod.creatorsTick(env);
  assert.equal(get(env, "SELECT status FROM creators WHERE user_id = ?", ana.id).status, "active");
  // Ban: every program credit left goes, the place ends, the public list drops it.
  const left = creditsOf(env, ana.id);
  assert.ok(left.program_credits > 0);
  const ban = await call(env, `/api/admin/creators/${ana.id}/ban`, { method: "POST", cookie: owner.admin, body: { reason: "sold credits in DMs" } });
  assert.equal(ban.status, 200, ban.text);
  const after = creditsOf(env, ana.id);
  assert.equal(after.program_credits, 0);
  assert.equal(after.credits, left.credits - left.program_credits);
  assert.equal((await call(env, "/api/creators/public")).json.creators.length, 0);
  assert.equal((await call(env, "/api/creators/me", { cookie: ana.cookie })).json.state, "banned");
});

test("a creator leaves; an application can be withdrawn", async () => {
  const { env, owner, ana } = await setup();
  giveLite(env, ana.id);
  await call(env, "/api/creators/apply", { method: "POST", cookie: ana.cookie, body: APP });
  assert.equal((await call(env, "/api/creators/leave", { method: "POST", cookie: ana.cookie, body: {} })).status, 400, "needs a confirmation");
  const w = await call(env, "/api/creators/leave", { method: "POST", cookie: ana.cookie, body: { confirm: true } });
  assert.equal(w.json.state, "none");
  await approved(env, owner, ana);
  const l = await call(env, "/api/creators/leave", { method: "POST", cookie: ana.cookie, body: { confirm: true } });
  assert.equal(l.json.state, "ended");
  assert.match(l.json.endReason, /left/);
});
