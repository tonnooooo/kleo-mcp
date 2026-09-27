/**
 * The growth plan of 27 September 2026 (the owner: "attract people and make them stay"): launch codes and the free
 * 15-second film they open (src/launch.ts). No Worker runtime: the sources are bundled with esbuild and run against
 * the D1 look-alike on node:sqlite, with every migration applied, so the real SQL is exercised.
 * Run: node --test test/growth.test.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { createHmac } from "node:crypto";

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
  // A D1 batch is a transaction: all or nothing, and nothing else runs in between (synchronous on purpose, so two
  // batches started together cannot interleave, exactly as D1 serialises them).
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => ({ success: true, meta: { changes: Number(s.stmt.run(...s.args).changes) } }));
      this.db.exec("COMMIT");
      return out;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}
class FakeKV {
  constructor() { this.m = new Map(); }
  async put(k, v, o) { this.m.set(k, { v, o }); }
  async get() { return null; }
  async getWithMetadata(k) { const e = this.m.get(k); return { value: e?.v ?? null, metadata: e?.o?.metadata ?? null }; }
  async delete(k) { this.m.delete(k); }
}

let m;
before(async () => {
  const r = await esbuild.build({
    stdin: {
      contents: `export * from "./src/jobs.ts"; export * from "./src/db.ts"; export * from "./src/launch.ts";
        export { handleCredits } from "./src/credits.ts"; export { handleAdmin } from "./src/internal.ts";
        export { makeViewToken, makeHandle } from "./src/accounts.ts"; export * from "./src/referral.ts";
        export { handleStripeWebhook } from "./src/stripe.ts"; export { handleAuthorize, connectionHints } from "./src/auth.ts";`,
      resolveDir: ROOT, loader: "ts",
    },
    alias: { "@cloudflare/workers-oauth-provider": join(ROOT, "test/fixtures/oauth-provider-stub.mjs") },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"],
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

async function newEnv(extra = {}) {
  const env = {
    DB: new FakeD1(), OAUTH_KV: new FakeKV(), RENDER_BACKEND: "manual", PUBLIC_URL: "http://kleo.test", INTERNAL_SECRET: "s3cret",
    MAX_CONCURRENT_GPUS: "5", MAX_JOBS_PER_USER: "3", MAX_JOBS_PER_DAY: "500", JOB_TIMEOUT_MIN: "120", FREE_CREDITS: "5", RESULT_TTL_DAYS: "7",
    STORYBOARD_FIXTURE: "example", ...extra,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const newUser = (env, id, credits = 5) => m.createUser(env, { id, email: `${id}@anon.kleo.invalid`, credits, inviteCode: null });
const balance = async (env, id) => (await m.getUser(env, id)).credits;
const audits = (env, event) => env.DB.db.prepare("SELECT * FROM audit WHERE event = ? ORDER BY id").all(event).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
const film = (extra = {}) => ({ template: "film", prompt: "A lighthouse keeper's last night before the automation", duration_s: 15, format: "9:16", language: "en", ...extra });

/* ------------------------------------------------------------------ P4: launch codes */

test("launch codes: the five channels are seeded with 30 uses each; a code is case-blind and adds the 15-second film's credits", async () => {
  const env = await newEnv();
  const codes = await m.listLaunchCodes(env);
  assert.deepEqual(codes.map((c) => [c.code, c.channel, c.max_uses, c.uses]), [["HN", "hn", 30, 0], ["PRODUCTHUNT", "producthunt", 30, 0], ["REDDIT", "reddit", 30, 0], ["TIKTOK", "tiktok", 30, 0], ["X", "x", 30, 0]]);
  assert.equal(m.TRIAL_FILM_MAX_S, 15);
  await newUser(env, "u_a");
  const r = await m.redeemLaunchCode(env, "u_a", " producthunt ");
  assert.deepEqual(r, { ok: true, code: "PRODUCTHUNT", channel: "producthunt", credits: 10, balance: 15 });
  assert.equal(await balance(env, "u_a"), 15, "5 of the gift + 10, the price of a 15-second film");
  assert.equal((await m.getLaunchCode(env, "PRODUCTHUNT")).uses, 1);
  assert.deepEqual(audits(env, "launch.redeemed")[0].detail, { code: "PRODUCTHUNT", channel: "producthunt", amount: 10, balance: 15 });
  const trial = await m.trialOf(env, "u_a");
  assert.deepEqual(trial, { code: "PRODUCTHUNT", channel: "producthunt", available: true, max_s: 15, held_by: null });
});

test("launch codes: one per account whatever the code, a used-up code and an unknown one change nothing, and each refusal says why", async () => {
  const env = await newEnv();
  await newUser(env, "u_a"); await newUser(env, "u_b"); await newUser(env, "u_c");
  assert.equal((await m.redeemLaunchCode(env, "u_a", "HN")).ok, true);
  const again = await m.redeemLaunchCode(env, "u_a", "REDDIT");
  assert.equal(again.ok, false); assert.equal(again.reason, "already"); assert.match(again.message, /already used a launch code \(HN\): one per account/);
  assert.equal((await m.getLaunchCode(env, "REDDIT")).uses, 0, "a refused redemption uses nothing");
  assert.equal(await balance(env, "u_a"), 15);
  const unknown = await m.redeemLaunchCode(env, "u_b", "NOPE");
  assert.equal(unknown.reason, "unknown"); assert.match(unknown.message, /no launch code "NOPE"/);
  assert.equal((await m.redeemLaunchCode(env, "u_b", "no such thing!")).reason, "invalid");
  await m.upsertLaunchCode(env, { code: "HN", channel: "hn", max_uses: 1 });
  const full = await m.redeemLaunchCode(env, "u_b", "hn");
  assert.equal(full.reason, "used_up"); assert.match(full.message, /used 1 times, which is all it had/);
  await m.upsertLaunchCode(env, { code: "X", channel: "x", active: false });
  assert.equal((await m.redeemLaunchCode(env, "u_c", "X")).reason, "unknown", "a code switched off is no code");
  assert.equal(await balance(env, "u_b"), 5); assert.equal(await balance(env, "u_c"), 5);
  assert.deepEqual(audits(env, "launch.refused").map((a) => a.detail.reason), ["already", "unknown", "used_up", "unknown"], "rubbish that cannot be a code is not even written down");
});

test("launch codes: twenty presses at once redeem once", async () => {
  const env = await newEnv();
  await newUser(env, "u_a");
  const all = await Promise.all(Array.from({ length: 20 }, (_, i) => m.redeemLaunchCode(env, "u_a", i % 2 ? "TIKTOK" : "REDDIT")));
  assert.equal(all.filter((r) => r.ok).length, 1);
  assert.equal(await balance(env, "u_a"), 15);
  const uses = (await m.listLaunchCodes(env)).reduce((a, c) => a + c.uses, 0);
  assert.equal(uses, 1, "one use counted across every code");
});

test("the launch-code film: an account that never paid gets ONE film of at most 15 seconds; a failed one gives it back", async () => {
  const env = await newEnv();
  const u = await newUser(env, "u_a", 40);
  // Before the code: the film is refused, and the refusal names the code as a way on.
  await assert.rejects(() => m.createJob(env, u, film()), (e) => e instanceof m.JobError && /A film is made only for accounts that have bought a credit pack/.test(e.message) && /kleo_redeem/.test(e.message));
  await m.redeemLaunchCode(env, "u_a", "PRODUCTHUNT");
  const fresh = await m.getUser(env, "u_a");
  // Longer than the trial: refused in words, nothing charged.
  await assert.rejects(() => m.createJob(env, fresh, film({ duration_s: 30 })), (e) => /opens one free film of up to 15 seconds, and this one is 30/.test(e.message) && /Nothing was charged/.test(e.message));
  assert.equal(await balance(env, "u_a"), 50);
  const job = await m.createJob(env, fresh, film());
  assert.equal(job.credits, 10);
  assert.equal(await balance(env, "u_a"), 40);
  const p = JSON.parse(job.params);
  assert.equal(p.trial, true);
  assert.equal(audits(env, "job.created")[0].detail.trial, "PRODUCTHUNT");
  assert.equal((await m.trialOf(env, "u_a")).held_by, job.id);
  assert.equal(await m.trialHolds(env, job), true, "the footage gate lets this job through");
  // One per account: a second film is refused while the first is alive.
  const now = await m.getUser(env, "u_a");
  await assert.rejects(() => m.createJob(env, now, film({ prompt: "Another lighthouse, another night, another keeper" })), (e) => new RegExp(`already taken by video ${job.id}`).test(e.message));
  // The animatic stays open to the same account.
  const anim = await m.createJob(env, await m.getUser(env, "u_a"), film({ product: "animatic", prompt: "A lighthouse keeper's animatic, drawn frames" }));
  assert.equal(anim.credits, 5);
  // The film fails (its credits come back through failJob in production): the trial is free again for a new film.
  env.DB.db.prepare("UPDATE jobs SET state = 'failed' WHERE id = ?").run(job.id);
  assert.equal((await m.trialOf(env, "u_a")).available, true);
  assert.equal(await m.trialHolds(env, job), true, "the failed job still names the claim until another takes it");
  const second = await m.createJob(env, await m.getUser(env, "u_a"), film({ prompt: "The lighthouse keeper, a second try at the film" }));
  assert.equal(JSON.parse(second.params).trial, true);
  assert.equal(await m.trialHolds(env, job), false, "the new claim is the second job's");
  assert.equal(await m.trialHolds(env, second), true);
  assert.equal(await m.trialHolds(env, { ...second, params: JSON.stringify({ ...JSON.parse(second.params), duration_s: 30 }) }), false, "never past 15 seconds");
  assert.equal(await m.trialHolds(env, { ...anim }), false, "an animatic is not the trial");
});

test("the launch-code film never lets a paying account's films through the trial, and a paying account keeps its films", async () => {
  const env = await newEnv();
  const u = await newUser(env, "u_p", 60);
  env.DB.db.prepare("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('cs_p', 'u_p', 10, 500, 'eur', 'paid', 'test')").run();
  await m.redeemLaunchCode(env, "u_p", "HN");
  const job = await m.createJob(env, await m.getUser(env, "u_p"), film({ duration_s: 30 }));
  assert.equal(JSON.parse(job.params).trial, undefined, "a paid film is not the trial");
  assert.equal((await m.trialOf(env, "u_p")).available, true);
});

test("/credits: the launch-code box redeems onto the account the page shows; the page says what happened", async () => {
  const env = await newEnv();
  await newUser(env, "u_a");
  const k = await m.makeViewToken(env, "u_a");
  const get = await m.handleCredits(new Request(`http://kleo.test/credits?k=${encodeURIComponent(k)}`), env);
  const page = await get.text();
  assert.match(page, /Have a launch code\?/); assert.match(page, /name="action" value="redeem"/);
  const post = (code) => m.handleCredits(new Request("http://kleo.test/credits", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ k, action: "redeem", code }) }), env);
  const bad = await post("WRONG");
  assert.equal(bad.status, 400); assert.match(await bad.text(), /There is no launch code &quot;WRONG&quot;/);
  const good = await post("reddit");
  assert.equal(good.status, 200);
  const after = await good.text();
  assert.match(after, /Code REDDIT redeemed: 10 credits added/); assert.match(after, /15 credits left/);
  assert.match(after, /REDDIT: one free film of up to 15 seconds is open on this account/);
  assert.doesNotMatch(after, /Have a launch code\?/, "the box goes once a code is used");
  const forged = await m.handleCredits(new Request("http://kleo.test/credits", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ k: "u_a.vdeadbeef", action: "redeem", code: "HN" }) }), env);
  assert.equal(forged.status, 404, "a forged token opens nothing");
});

test("admin: launch codes are listed and added without a deploy, behind the secret", async () => {
  const env = await newEnv();
  const call = (method, body, secret = "s3cret") => m.handleAdmin(new Request("http://kleo.test/internal/admin/launch-codes", { method, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  assert.equal((await call("GET", null, "wrong")).status, 401);
  assert.equal((await (await call("GET")).json()).codes.length, 5);
  const add = await (await call("POST", { code: "discord", channel: "Discord", max_uses: 50 })).json();
  assert.deepEqual([add.code.code, add.code.channel, add.code.max_uses, add.code.uses, add.code.credits, add.code.active], ["DISCORD", "discord", 50, 0, null, 1]);
  assert.equal((await call("POST", { code: "bad code!" })).status, 400);
  await newUser(env, "u_a");
  assert.equal((await m.redeemLaunchCode(env, "u_a", "DISCORD")).credits, 10, "credits null: the trial film's price");
  const off = await (await call("POST", { code: "DISCORD", channel: "discord", max_uses: 50, active: false })).json();
  assert.equal(off.code.active, 0); assert.equal(off.code.uses, 1, "an update never resets the uses");
});

/* ------------------------------------------------------------------ P5: referrals */

const WHSEC = "whsec_test";
const stripeEnv = (env) => Object.assign(env, { STRIPE_WEBHOOK_SECRET: WHSEC });
const signedPost = (env, obj) => {
  const body = JSON.stringify(obj);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${body}`).digest("hex")}`;
  return m.handleStripeWebhook(new Request("https://k/stripe/webhook", { method: "POST", body, headers: { "stripe-signature": sig } }), env);
};
const pays = (env, userId, session, cents = 500) => signedPost(env, { id: `evt_${session}`, type: "checkout.session.completed", livemode: true,
  data: { object: { id: session, client_reference_id: userId, amount_total: cents, currency: "eur", payment_status: "paid", payment_intent: `pi_${session}`, customer_details: { email: null } } } });
const dispute = (env, session) => signedPost(env, { id: `evt_d_${session}`, type: "charge.dispute.created", livemode: true, data: { object: { payment_intent: `pi_${session}` } } });

test("referral codes: one per account, made once, R + seven characters; a link binds a new account once, never to itself", async () => {
  const env = await newEnv();
  await newUser(env, "u_ref"); await newUser(env, "u_new"); await newUser(env, "u_other");
  const code = await m.referralCodeFor(env, "u_ref");
  assert.match(code, /^R[A-Z0-9]{7}$/);
  assert.equal(await m.referralCodeFor(env, "u_ref"), code, "the same code every time");
  assert.equal(m.referralLink("http://kleo.test", code), `http://kleo.test/r/${code}`);
  assert.equal(m.normalizeReferral(` ${code.toLowerCase()} `), code);
  assert.equal(await m.linkReferral(env, "u_ref", code, "test"), false, "never to itself");
  assert.equal(await m.linkReferral(env, "u_new", "RNOBODY1", "test"), false, "never to a code nobody has");
  assert.equal(await m.linkReferral(env, "u_new", code, "test"), true);
  const other = await m.referralCodeFor(env, "u_other");
  assert.equal(await m.linkReferral(env, "u_new", other, "test"), false, "linked once, the first referrer stays");
  assert.equal(env.DB.db.prepare("SELECT referred_by FROM users WHERE id = 'u_new'").get().referred_by, "u_ref");
  assert.deepEqual(audits(env, "referral.linked").map((a) => a.detail), [{ referrer: "u_ref", code, via: "test" }]);
});

test("referral reward: the referred account's FIRST real payment gives the referrer 10 and the referred 5 on top, once; later payments and replays nothing", async () => {
  const env = stripeEnv(await newEnv());
  await newUser(env, "u_ref", 0); await newUser(env, "u_new", 5);
  await m.linkReferral(env, "u_new", await m.referralCodeFor(env, "u_ref"), "test");
  // A tester row (no amount, no webhook) is not a payment: it neither earns the reward nor spends it.
  env.DB.db.prepare("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('manual_t', 'u_new', 0, 0, 'eur', 'paid', 'tester')").run();
  const r = await pays(env, "u_new", "cs_first");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).referral_bonus, 5);
  assert.equal(await balance(env, "u_new"), 5 + 10 + 5, "gift + the 5 EUR pack + the referral bonus");
  assert.equal(await balance(env, "u_ref"), 10);
  await pays(env, "u_new", "cs_first"); // Stripe delivers the same event again
  await pays(env, "u_new", "cs_second"); // and a second purchase
  assert.equal(await balance(env, "u_new"), 5 + 10 + 5 + 10, "the second pack is a pack, nothing more");
  assert.equal(await balance(env, "u_ref"), 10, "never twice");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM referrals").get().n, 1);
  assert.deepEqual(audits(env, "referral.rewarded").map((a) => [a.user_id, a.detail.role, a.detail.amount]), [["u_ref", "referrer", 10], ["u_new", "referred", 5]]);
  // A dispute of the first payment takes the pack and both rewards back.
  await dispute(env, "cs_first");
  assert.equal(await balance(env, "u_ref"), 0);
  assert.equal(await balance(env, "u_new"), 5 + 10 + 5 + 10 - 10 - 5, "the pack's 10 and the bonus's 5 taken back");
  assert.equal(env.DB.db.prepare("SELECT status FROM referrals").get().status, "disputed");
  await dispute(env, "cs_first");
  assert.equal(await balance(env, "u_ref"), 0, "a second dispute event takes nothing more");
});

test("referral reward: nothing for an account nobody referred, and nothing for one whose first real payment came before the link", async () => {
  const env = stripeEnv(await newEnv());
  await newUser(env, "u_ref", 0); await newUser(env, "u_solo", 0); await newUser(env, "u_late", 0);
  await pays(env, "u_solo", "cs_solo");
  assert.equal(await balance(env, "u_solo"), 10);
  await pays(env, "u_late", "cs_late_1");
  await m.linkReferral(env, "u_late", await m.referralCodeFor(env, "u_ref"), "test");
  await pays(env, "u_late", "cs_late_2");
  assert.equal(await balance(env, "u_ref"), 0, "the reward is for the FIRST real payment only");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM referrals").get().n, 0);
});

function fakeProvider() {
  return {
    async parseAuthRequest(request) {
      const q = new URL(request.url).searchParams;
      return { clientId: q.get("client_id"), redirectUri: q.get("redirect_uri"), scope: (q.get("scope") ?? "").split(" ").filter(Boolean), state: q.get("state") };
    },
    async lookupClient(clientId) { return { clientId, clientName: "Test Assistant" }; },
    async completeAuthorization(o) { return { redirectTo: `http://localhost:9999/cb?code=code_${o.userId}&state=${o.request.state}` }; },
  };
}
const oauthQuery = (extra = {}) => new URLSearchParams({ response_type: "code", client_id: "client_1", redirect_uri: "http://localhost:9999/cb", scope: "video:create", state: "s", ...extra }).toString();
const signIn = (env, { cookie, form = {}, query = oauthQuery() } = {}) => m.handleAuthorize(new Request("http://kleo.test/authorize", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams({ oauth_query: query, ...form }),
}), env);
const newestUser = (env) => env.DB.db.prepare("SELECT * FROM users ORDER BY rowid DESC LIMIT 1").get();
const signInEnv = async () => Object.assign(await newEnv(), { OAUTH_PROVIDER: fakeProvider(), MAX_NEW_USERS_PER_DAY: "25", MAX_NEW_USERS_PER_IP_DAY: "25" });

test("sign-in: a referral code links the NEW account — from the /r/ cookie, the code field or the connector address — and never an existing one", async () => {
  const env = await signInEnv();
  await newUser(env, "u_ref");
  const code = await m.referralCodeFor(env, "u_ref");
  assert.equal((await signIn(env, { cookie: `kleo_ref=${code}` })).status, 302);
  assert.equal(newestUser(env).referred_by, "u_ref", "the cookie the /r/ page left");
  await signIn(env, { form: { bonus: code.toLowerCase() } });
  assert.equal(newestUser(env).referred_by, "u_ref", "typed in the code field");
  assert.equal(audits(env, "bonus.rejected").length, 0, "a referral code is not a failed bonus code");
  const resource = `http://kleo.test/mcp?ref=${code}&src=producthunt`;
  await signIn(env, { query: oauthQuery({ resource }) });
  assert.equal(newestUser(env).referred_by, "u_ref", "the connector address, sent as the OAuth resource");
  assert.deepEqual(m.connectionHints(oauthQuery({ resource })), { ref: code, src: "producthunt" });
  // A browser that already has an account keeps it, unlinked.
  await newUser(env, "u_existing");
  const before = env.DB.db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  await signIn(env, { cookie: `kleo_id=${await m.makeHandle(env, "u_existing")}; kleo_ref=${code}` });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, before, "no new account");
  assert.equal(env.DB.db.prepare("SELECT referred_by FROM users WHERE id = 'u_existing'").get().referred_by, null);
});

test("/r/<code>: the invitation page remembers a known code for sign-in and shows the connector address carrying it", async () => {
  const env = await newEnv();
  await newUser(env, "u_ref");
  const code = await m.referralCodeFor(env, "u_ref");
  const r = await m.handleReferralPage(new Request(`http://kleo.test/r/${code}`), env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie") ?? "", new RegExp(`^kleo_ref=${code}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`));
  const page = await r.text();
  assert.ok(page.includes(`http://kleo.test/mcp?ref=${code}`), "the connector address carries the code");
  assert.match(page, /you get 5 extra credits, and your friend gets 10/);
  const unknown = await m.handleReferralPage(new Request("http://kleo.test/r/RNOBODY1"), env);
  assert.equal(unknown.status, 404); assert.equal(unknown.headers.get("set-cookie"), null);
});
