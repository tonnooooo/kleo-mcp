/**
 * The smaller findings of the 14 October 2026 security review, on the MCP Worker: a chargeback delivered twice at the
 * same moment takes the credits back once (src/stripe.ts), a length that is not a number never reaches a price
 * (src/jobs.ts createJob; the Studio route has its own test in studio-film.test.mjs), and referral rewards cannot be
 * farmed — at most REFERRER_REWARDS_PER_DAY paid to a referrer per UTC day, none from the referrer's own address
 * (src/referral.ts). Same recipe as growth.test.mjs: the sources bundled with esbuild, a D1 look-alike on node:sqlite
 * with every migration applied, Stripe events signed here with a test secret. Offline and deterministic.
 * Run: node --test test/security-mcp-misc.test.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import * as esbuild from "esbuild";

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
class FakeKV { constructor() { this.m = new Map(); } async put(k, v) { this.m.set(k, v); } async get() { return null; } async delete(k) { this.m.delete(k); } }

let m;
before(async () => {
  const r = await esbuild.build({
    stdin: {
      contents: `export * from "./src/jobs.ts"; export * from "./src/db.ts"; export * from "./src/referral.ts";
        export { handleStripeWebhook } from "./src/stripe.ts"; export { redeemLaunchCode } from "./src/launch.ts";`,
      resolveDir: ROOT, loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"],
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

const WHSEC = "whsec_test";
function newEnv(extra = {}) {
  const env = {
    DB: new FakeD1(), OAUTH_KV: new FakeKV(), RENDER_BACKEND: "manual", PUBLIC_URL: "http://kleo.test", INTERNAL_SECRET: "s3cret",
    MAX_CONCURRENT_GPUS: "5", MAX_JOBS_PER_USER: "3", MAX_JOBS_PER_DAY: "500", JOB_TIMEOUT_MIN: "120", FREE_CREDITS: "5", RESULT_TTL_DAYS: "7",
    STORYBOARD_FIXTURE: "example", STRIPE_WEBHOOK_SECRET: WHSEC, ...extra,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
/** An account with the address fingerprint the sign-in would have stored (null: none, as in local dev). */
const newUser = async (env, id, credits = 0, ipHash = null) =>
  (await m.createUserIfUnderCaps(env, { id, email: `${id}@anon.kleo.invalid`, credits, ipHash }, { perDay: 1000, perAddressDay: 1000 })).user;
const balance = (env, id) => env.DB.db.prepare("SELECT credits FROM users WHERE id = ?").get(id).credits;
const audits = (env, event) => env.DB.db.prepare("SELECT * FROM audit WHERE event = ? ORDER BY id").all(event).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
const count = (env, sql) => env.DB.db.prepare(sql).get().n;

const signedPost = (env, obj) => {
  const body = JSON.stringify(obj);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${body}`).digest("hex")}`;
  return m.handleStripeWebhook(new Request("https://k/stripe/webhook", { method: "POST", body, headers: { "stripe-signature": sig } }), env);
};
const pays = (env, userId, session, cents = 500) => signedPost(env, { id: `evt_${session}`, type: "checkout.session.completed", livemode: true,
  data: { object: { id: session, client_reference_id: userId, amount_total: cents, currency: "eur", payment_status: "paid", payment_intent: `pi_${session}`, customer_details: { email: null } } } });
const dispute = (env, session) => signedPost(env, { id: `evt_d_${session}`, type: "charge.dispute.created", livemode: true, data: { object: { payment_intent: `pi_${session}` } } });
const refund = (env, session) => signedPost(env, { id: `evt_r_${session}`, type: "charge.refunded", livemode: true, data: { object: { payment_intent: `pi_${session}` } } });

/**
 * Holds every read of a payment by its intent until `n` deliveries have made it, then lets them all go on: the two
 * deliveries of the race both see the row as it was BEFORE either of them wrote, which is the interleaving the review
 * found, made certain instead of left to timing.
 */
function holdIntentReads(env, n = 2) {
  const prepare = env.DB.prepare.bind(env.DB);
  const waiting = [];
  env.DB.prepare = (sql) => {
    const st = prepare(sql);
    if (!/^SELECT \* FROM payments WHERE payment_intent = \?/.test(sql)) return st;
    const first = st.first.bind(st);
    st.first = async () => {
      const row = await first(); // read now, like D1 would
      await new Promise((resolve) => { waiting.push(resolve); if (waiting.length >= n) waiting.splice(0).forEach((go) => go()); });
      return row;
    };
    return st;
  };
}

/* ------------------------------------------------------------------ 7. a dispute delivered twice */

test("a dispute delivered twice at the same moment takes the credits back once", { timeout: 10_000 }, async () => {
  const env = newEnv();
  await newUser(env, "u_buyer", 0);
  assert.equal((await pays(env, "u_buyer", "cs_1")).status, 200);
  assert.equal(balance(env, "u_buyer"), 10);

  holdIntentReads(env, 2);
  const [a, b] = await Promise.all([dispute(env, "cs_1"), dispute(env, "cs_1")]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, "a duplicate is a normal event: never a non-2xx that makes Stripe retry");
  const bodies = [await a.json(), await b.json()];
  assert.equal(bodies.filter((x) => x.marked === "disputed").length, 1, "exactly one delivery claims the dispute");
  assert.equal(bodies.filter((x) => x.already === "disputed").length, 1, "and the other finds it claimed");
  assert.equal(balance(env, "u_buyer"), 0, "10 bought, 10 taken back: not -10");
  assert.equal(audits(env, "credits.chargeback").length, 1);
  assert.equal(audits(env, "stripe.disputed").length, 1);
  assert.equal(env.DB.db.prepare("SELECT status FROM payments WHERE session_id = 'cs_1'").get().status, "disputed");
});

test("a refund after a dispute does not reopen it: the dispute delivered again takes nothing more", async () => {
  const env = newEnv();
  await newUser(env, "u_buyer", 0);
  await pays(env, "u_buyer", "cs_1");
  await dispute(env, "cs_1");
  assert.equal(balance(env, "u_buyer"), 0);
  const r = await refund(env, "cs_1");
  assert.equal(r.status, 200);
  assert.equal(env.DB.db.prepare("SELECT status FROM payments WHERE session_id = 'cs_1'").get().status, "disputed", "'refunded' never overwrites 'disputed'");
  await dispute(env, "cs_1");
  assert.equal(balance(env, "u_buyer"), 0, "still taken back once");
  assert.equal(audits(env, "credits.chargeback").length, 1);

  // The other order still works as before: a refund is only marked, and a dispute after it takes the credits back.
  await newUser(env, "u_two", 0);
  await pays(env, "u_two", "cs_2");
  await refund(env, "cs_2");
  assert.equal(balance(env, "u_two"), 10, "a refund alone takes nothing: it can still fail");
  await dispute(env, "cs_2");
  assert.equal(balance(env, "u_two"), 0);
});

/* ------------------------------------------------------------------ 9. a length that is not a number */

test("createJob refuses a length that is not a finite number before any range or price check, and charges nothing", async () => {
  const env = newEnv();
  const u = await newUser(env, "u_len", 50);
  env.DB.db.exec("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('manual_t', 'u_len', 0, 0, 'eur', 'paid', 'tester')");
  const film = (duration_s, product) => ({ template: "film", prompt: "A lighthouse keeper's last night before the automation", duration_s, format: "9:16", language: "en", ...(product ? { product } : {}) });
  for (const bad of [NaN, "abc", Infinity, -Infinity, "30"]) {
    for (const product of [undefined, "animatic"]) {
      await assert.rejects(() => m.createJob(env, u, film(bad, product)),
        (e) => e instanceof m.JobError && /number of seconds/.test(e.message) && /Nothing was charged/.test(e.message),
        `duration_s ${String(bad)} (${product ?? "film"})`);
    }
  }
  assert.equal(balance(env, "u_len"), 50, "nothing charged");
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM jobs"), 0, "and no job written");
});

test("createJob's pre-flight measures a launch-code film against the trial pool and a paying customer's against the paid pool", async () => {
  // Both pools nearly empty, each of its own size: the audit row of each refusal says which pool was asked.
  const env = newEnv({ KLEO_FOOTAGE_BACKEND: "kie", KIE_API_KEY: "kie-test-key", TRIAL_FOOTAGE_BUDGET_USD: "0.01", DAILY_FOOTAGE_BUDGET_USD: "0.02" });
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`unexpected network call: ${url}`); }; // the budget refuses before any balance read
  try {
    const film = (duration_s) => ({ template: "film", prompt: "A lighthouse keeper's last night before the automation", duration_s, format: "9:16", language: "en" });
    const free = await newUser(env, "u_trialpf", 0);
    assert.equal((await m.redeemLaunchCode(env, "u_trialpf", "PRODUCTHUNT")).ok, true);
    await assert.rejects(() => m.createJob(env, { ...free, credits: balance(env, "u_trialpf") }, film(15)),
      (e) => e instanceof m.JobError && /fully booked/.test(e.message) && /Nothing was charged/.test(e.message));
    const payer = await newUser(env, "u_payerpf", 50);
    env.DB.db.exec("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('manual_pf', 'u_payerpf', 0, 0, 'eur', 'paid', 'tester')");
    await assert.rejects(() => m.createJob(env, payer, film(18)), (e) => e instanceof m.JobError && /fully booked/.test(e.message));
    const [trial, paid] = audits(env, "footage.preflight").map((a) => a.detail);
    assert.deepEqual([trial.pool, trial.budget_usd], ["trial", 0.01], "the free film is checked where /footage will count it");
    assert.match(trial.owner_action, /TRIAL_FOOTAGE_BUDGET_USD/);
    assert.deepEqual([paid.pool, paid.budget_usd], ["paid", 0.02]);
    assert.match(paid.owner_action, /DAILY_FOOTAGE_BUDGET_USD/);
    assert.equal(count(env, "SELECT COUNT(*) AS n FROM jobs"), 0, "no job, no rental, no pictures");
    assert.equal(balance(env, "u_payerpf"), 50);
  } finally { globalThis.fetch = real; }
});

/* ------------------------------------------------------------------ 10. referral farming */

test("a referrer is paid at most 3 rewards per UTC day; past it the friend still gets their bonus, and the next day pays again", async () => {
  const env = newEnv();
  await newUser(env, "u_ref", 0, "fp_ref");
  const code = await m.referralCodeFor(env, "u_ref");
  for (let i = 1; i <= 5; i++) {
    await newUser(env, `u_f${i}`, 0, `fp_f${i}`);
    assert.equal(await m.linkReferral(env, `u_f${i}`, code, "test"), true);
  }
  for (let i = 1; i <= 3; i++) assert.equal((await pays(env, `u_f${i}`, `cs_f${i}`)).status, 200);
  assert.equal(balance(env, "u_ref"), 30, "three friends, three rewards");

  const fourth = await pays(env, "u_f4", "cs_f4");
  assert.equal(fourth.status, 200, "a capped reward never makes Stripe retry a payment");
  assert.equal((await fourth.json()).referral_bonus, 5, "the friend's own bonus was promised to them and is still given");
  assert.equal(balance(env, "u_ref"), 30, "the fourth reward of the day is not paid to the referrer");
  assert.equal(balance(env, "u_f4"), 10 + 5);
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM referrals"), 4, "still one row per referred account");
  assert.equal(env.DB.db.prepare("SELECT referrer_credits FROM referrals WHERE referred_id = 'u_f4'").get().referrer_credits, 0);
  assert.equal(audits(env, "referral.capped").length, 1, "the capped reward is written down");
  await pays(env, "u_f4", "cs_f4"); // Stripe delivers it again
  assert.equal(balance(env, "u_ref"), 30);
  assert.equal(balance(env, "u_f4"), 15);

  // A dispute of the capped one takes back only what was given: the friend's 5, nothing from the referrer.
  await dispute(env, "cs_f4");
  assert.equal(balance(env, "u_ref"), 30);

  // The cap is per UTC day: the rewards of an earlier day do not count against today.
  env.DB.db.exec("UPDATE referrals SET at = '2000-01-01T12:00:00.000Z'");
  await pays(env, "u_f5", "cs_f5");
  assert.equal(balance(env, "u_ref"), 40, "a new day, a paid reward");
});

test("no reward on either side when the referred account was opened from the referrer's own address", async () => {
  const env = newEnv();
  await newUser(env, "u_ref", 0, "fp_same");
  const code = await m.referralCodeFor(env, "u_ref");
  await newUser(env, "u_self", 0, "fp_same");
  await m.linkReferral(env, "u_self", code, "test");
  const r = await pays(env, "u_self", "cs_self");
  assert.equal(r.status, 200, "the pack itself is still credited");
  assert.equal((await r.json()).referral_bonus, undefined);
  assert.equal(balance(env, "u_self"), 10, "the pack and nothing more");
  assert.equal(balance(env, "u_ref"), 0, "no reward for referring yourself");
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM referrals"), 0);
  assert.deepEqual(audits(env, "referral.refused").map((a) => [a.user_id, a.detail.referrer, a.detail.reason]), [["u_self", "u_ref", "same address as the referrer"]]);
  await pays(env, "u_self", "cs_self_2");
  assert.equal(audits(env, "referral.refused").length, 1, "a later payment is not a first one and is not written down again");

  // A missing fingerprint is not judged by it: an account without one is rewarded as before (the day cap still holds).
  await newUser(env, "u_nofp", 0, null);
  await m.linkReferral(env, "u_nofp", code, "test");
  await pays(env, "u_nofp", "cs_nofp");
  assert.equal(balance(env, "u_ref"), 10);
  assert.equal(balance(env, "u_nofp"), 15);
});
