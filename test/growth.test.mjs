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
        export { makeViewToken, makeHandle } from "./src/accounts.ts";`,
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
  assert.deepEqual(audits(env, "launch.refused").map((a) => a.detail.reason), ["already", "unknown", "invalid", "used_up", "unknown"]);
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
