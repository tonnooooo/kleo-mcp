/**
 * Credits lifecycle tests, no Worker runtime: the TypeScript sources are bundled with esbuild (already in
 * node_modules through wrangler) and run against a tiny D1 look-alike on node:sqlite, so the real SQL of
 * db.ts / jobs.ts / orchestrator.ts / internal.ts is exercised.
 * Run: node --test test/credits.test.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ D1 on node:sqlite */
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
class FakeKV {
  constructor() { this.m = new Map(); }
  async put(k, v, o) { this.m.set(k, { v, o }); }
  async get() { return null; }
  async getWithMetadata(k) { const e = this.m.get(k); return { value: e?.v ?? null, metadata: e?.o?.metadata ?? null }; }
  async delete(k) { this.m.delete(k); }
}

let m; // the bundled sources
before(async () => {
  const r = await esbuild.build({
    stdin: {
      contents: `export * from "./src/jobs.ts"; export * from "./src/orchestrator.ts"; export * from "./src/internal.ts";
        export * from "./src/db.ts"; export * from "./src/schema.ts"; export { manualBackend } from "./src/backends/manual.ts";`,
      resolveDir: ROOT, loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent",
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

async function newEnv(backend = "manual") {
  const env = {
    DB: new FakeD1(), OAUTH_KV: new FakeKV(), RENDER_BACKEND: backend, PUBLIC_URL: "http://kleo.test", INTERNAL_SECRET: "s3cret",
    MAX_CONCURRENT_GPUS: "5", MAX_JOBS_PER_USER: "2", JOB_TIMEOUT_MIN: "120", FREE_CREDITS: "10", RESULT_TTL_DAYS: "7", MOCK_TOTAL_SECONDS: "60",
    // The daily caps have their own tests (test/accounts.test.mjs); here they must never be what stops a job.
    MAX_JOBS_PER_DAY: "500",
    STORYBOARD_FIXTURE: "example",
  };
  // the migrations, applied directly (schema.ts caches its bootstrap per process; every test wants a fresh database)
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
/** Price units (13 September: one look, priced as a film): P = a Short, PL = a five-minute film. */
const P = 7, PL = 21;
const user = (env, credits = 10 * P) => m.createUser(env, { id: "u_test", email: "t@example.com", credits, inviteCode: null });
const balance = async (env, id = "u_test") => (await m.getUser(env, id)).credits;
const events = async (env, jobId, name) => (await env.DB.prepare("SELECT event, detail FROM audit WHERE job_id = ? AND event = ? ORDER BY id").bind(jobId, name).all()).results.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
const short = (env, u, extra = {}) => m.createJob(env, u, { template: "film", prompt: "Pirates find an island missing from every map", duration_s: 45, format: "9:16", ...extra });
const long = (env, u) => m.createJob(env, u, { template: "film-long", prompt: "The story of the island that was never on any map", duration_s: 300 });
const internal = (env, job, path, body, secret = job.worker_secret) =>
  m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}/${path}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }), env);

/* ------------------------------------------------------------------ refund math (pure) */
test("refundFor: full refund before rendering, rounded proportional refund while rendering", () => {
  assert.equal(m.refundFor(1, "queued", 0), 1);
  assert.equal(m.refundFor(1, "starting", 0), 1);
  assert.equal(m.refundFor(1, "starting", 7), 1, "a job still booting (starting, <8%) is refunded in full");
  assert.equal(m.refundFor(1, "rendering", 30), 1);
  assert.equal(m.refundFor(1, "rendering", 49), 1);
  assert.equal(m.refundFor(1, "rendering", 51), 0);
  assert.equal(m.refundFor(1, "finishing", 90), 0);
  assert.equal(m.refundFor(3, "rendering", 60), 1);
  assert.equal(m.refundFor(3, "rendering", 10), 3);
  assert.equal(m.refundFor(5, "rendering", 50), 3);
  assert.equal(m.refundFor(3, "rendering", 100), 0);
  assert.equal(m.refundFor(3, "rendering", -5), 3);
  assert.equal(m.refundFor(0, "queued", 0), 0);
});

/* ------------------------------------------------------------------ debit */
test("create: one atomic debit with a credits.debit audit row; a refused create charges nothing", async () => {
  const env = await newEnv();
  const u = await user(env, 1 * P);
  const job = await short(env, u);
  assert.equal(job.credits, 1 * P);
  assert.equal(await balance(env), 0 * P);
  const debits = await events(env, job.id, "credits.debit");
  assert.equal(debits.length, 1);
  assert.deepEqual(debits[0].detail, { amount: P, balance: 0 });
  await assert.rejects(short(env, await m.getUser(env, "u_test")), (e) => e instanceof m.JobError && new RegExp(`Not enough credits: this Short costs ${P} credits and you have 0 credits`).test(e.message));
  assert.equal(await balance(env), 0 * P);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'credits.debit'").first()).n, 1);
});

test("create: a client storyboard for a filmed style is stored asking to be filmed, at the filmed price", async () => {
  // 13 September, a real job: realistic had become a filmed style (7 credits, the big card), the assistant passed
  // its own storyboard, the validator stripped the backdrop and nothing put it back on this road — the worker saw
  // no backdrop and drew the stills with the graphics on top. Seven credits for the old product.
  const env = await newEnv(); const u = await user(env, 20 * P);
  const sb = JSON.parse(readFileSync(join(ROOT, "scripts", "motion-demo", "samples", "venezia-16x9.json"), "utf8"));
  const job = await m.createJob(env, u, { template: "film", prompt: "L'acqua alta a Venezia, cento volte l'anno", duration_s: 30,
    format: "16:9", language: "it", style: "realistic", storyboard: sb });
  const stored = JSON.parse((await m.getJob(env, job.id)).storyboard);
  assert.equal(stored.backdrop, "video", "the plan says filmed, so the stored storyboard must ask to be filmed");
  assert.equal(stored.kleo_style, "realistic");
  assert.equal(job.credits, P, "and it is charged as a filmed video");
  // and no other look can be bought at all — with or without a backdrop written in by the caller
  const c = JSON.parse(JSON.stringify(sb)); c.kleo_style = "cartoon"; c.backdrop = "video";
  await assert.rejects(() => m.createJob(env, u, { template: "film", prompt: "Pirati e tesori", duration_s: 30, format: "16:9", language: "it", style: "cartoon", storyboard: c }), /one look now/);
  await assert.rejects(() => m.createJob(env, u, { template: "film", prompt: "Pirati e tesori", duration_s: 30, format: "16:9", language: "it", storyboard: c }), /one look now/);
});

test("create: a filmed job on a gated model with no token on the server is refused before anything is charged", async () => {
  const env = { ...(await newEnv()), KLEO_VIDEO_MODEL: "Lightricks/LTX-2.5-Diffusers" };   // no HF_TOKEN
  const u = await user(env, 20 * P);
  const sb = JSON.parse(readFileSync(join(ROOT, "scripts", "motion-demo", "samples", "venezia-16x9.json"), "utf8"));
  await assert.rejects(
    () => m.createJob(env, u, { template: "film", prompt: "L'acqua alta a Venezia", duration_s: 30, format: "16:9", language: "it", style: "realistic", storyboard: sb }),
    /Hugging Face token.*Nothing was charged/);
  assert.equal(await balance(env), 20 * P, "nothing was charged");
  env.HF_TOKEN = "hf_x";
  const job = await m.createJob(env, u, { template: "film", prompt: "L'acqua alta a Venezia", duration_s: 30, format: "16:9", language: "it", style: "realistic", storyboard: sb });
  assert.equal(job.credits, P, "with the token configured the same request goes through");
});

test("create: validation errors say nothing was charged and move no credits", async () => {
  const env = await newEnv();
  const u = await user(env, 10 * P);
  const cases = [
    [{ template: "gatto" }, /There is no template called "gatto"/],
    [{ style: "cyber" }, /one look now/],
    [{ duration_s: 600 }, /makes videos of 15 to 90 seconds; 600 seconds is outside that range/],
    [{ prompt: "short" }, /The description is too short/],
    [{ voice: "morgan" }, /There is no voice called "morgan". Available voices: narrator-en-m/],
    [{ storyboard: { scenes: [] } }, /The storyboard has \d+ problems? \(nothing was charged\)/],
  ];
  for (const [extra, re] of cases) {
    await assert.rejects(short(env, u, extra), (e) => { assert.match(e.message, re); assert.match(e.message, /Nothing was charged|nothing was charged/); return true; });
  }
  assert.equal(await balance(env), 10 * P);
});

test("create: the open-jobs limit is enforced before the debit", async () => {
  const env = await newEnv();
  const u = await user(env, 10 * P);
  await short(env, u); await short(env, u);
  await assert.rejects(short(env, u), /You already have 2 videos in progress, and the limit is 2 at a time/);
  assert.equal(await balance(env), 8 * P);
});

test("create: the daily limit counts videos STARTED today, not only the ones still running", async () => {
  // The open-jobs limit above lets one account queue as fast as jobs finish; this is the one that does not.
  const env = await newEnv();
  env.MAX_JOBS_PER_DAY = "2";
  const u = await user(env, 10 * P);
  const a = await short(env, u), b = await short(env, u);
  await m.updateJob(env, a.id, { state: "done" });
  await m.updateJob(env, b.id, { state: "done" }); // nothing is running any more, and still:
  await assert.rejects(short(env, u), (e) => e instanceof m.JobError && /You have already started 2 videos today, and the limit is 2 a day/.test(e.message) && /Nothing was charged/.test(e.message));
  assert.equal(await balance(env), 8 * P, "the cap is checked before the debit");
});

test("create: with no credits left the message hands over the signed account link, not a team to ask", async () => {
  const env = await newEnv();
  const u = await user(env, 1 * P);
  await short(env, u);
  await assert.rejects(short(env, await m.getUser(env, "u_test")), (e) => {
    assert.match(e.message, new RegExp(`Not enough credits: this Short costs ${P} credits and you have 0 credits`));
    const url = e.message.match(/http:\/\/kleo\.test\/credits\?k=(\S+)/);
    assert.ok(url, "the user is given somewhere to go: " + e.message);
    return true;
  });
});

/* ------------------------------------------------------------------ cancel */
test("cancel queued: full refund, audited once; a second cancel refunds nothing", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const job = await short(env, u);
  const r = await m.cancelJob(env, u, job.id);
  assert.equal(r.refunded, 1 * P);
  assert.equal(await balance(env), 3 * P);
  assert.equal((await m.getJob(env, job.id)).state, "cancelled");
  assert.equal((await events(env, job.id, "credits.refund")).length, 1);
  await assert.rejects(m.cancelJob(env, u, job.id), /Short gt_\w+ was already cancelled/);
  await assert.rejects(m.cancelJob(env, u, "gt_nope"), /There is no video number "gt_nope" on this account/);
  assert.equal(await balance(env), 3 * P);
});

test("cancel while starting at 0%: full refund and the GPU is destroyed", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const job = await short(env, u);
  await m.updateJob(env, job.id, { state: "starting", backend: "manual", instance_id: "gpu-1", started_at: new Date().toISOString(), percent: 0 });
  const destroyed = [];
  const orig = m.manualBackend.destroy;
  m.manualBackend.destroy = async (_e, j) => { destroyed.push(j.instance_id); return 0; };
  try {
    const r = await m.cancelJob(env, u, job.id);
    assert.equal(r.refunded, 1 * P);
    assert.deepEqual(destroyed, ["gpu-1"]);
    assert.equal(await balance(env), 3 * P);
  } finally { m.manualBackend.destroy = orig; }
});

test("cancel while rendering: refund proportional to the work left (a five-minute film at 60% → 40% back, rounded)", async () => {
  const env = await newEnv();
  const u = await user(env, PL);
  const job = await long(env, u);
  assert.equal(job.credits, PL);
  assert.equal(await balance(env), 0);
  await m.updateJob(env, job.id, { state: "rendering", backend: "manual", instance_id: "gpu-2", started_at: new Date().toISOString(), percent: 60 });
  const r = await m.cancelJob(env, u, job.id);
  const back = Math.round(PL * 0.4);
  assert.equal(r.refunded, back);
  assert.equal(await balance(env), back);
  assert.deepEqual((await events(env, job.id, "credits.refund"))[0].detail, { amount: back, reason: "cancelled at 60% (rendering)", balance: back });
});

test("cancel on a finished job refunds nothing and points to the links", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const job = await short(env, u);
  await m.updateJob(env, job.id, { state: "rendering", backend: "manual", instance_id: "gpu-3", started_at: new Date().toISOString(), percent: 50 });
  assert.equal(await m.finishJob(env, await m.getJob(env, job.id), 0.4), true);
  await assert.rejects(m.cancelJob(env, u, job.id), /Short gt_\w+ is already finished, so there is nothing to cancel. Call kleo_get_result/);
  assert.equal(await balance(env), 2 * P);
});

/* ------------------------------------------------------------------ failures */
test("final failure refunds once; failing an already failed job refunds nothing", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const job = await short(env, u);
  await m.updateJob(env, job.id, { state: "rendering", backend: "manual", instance_id: "gpu-4", started_at: new Date().toISOString(), percent: 40, attempts: 3 });
  const j = await m.getJob(env, job.id);
  assert.equal(await m.failJob(env, j, "worker: engine crashed", true), "failed", "retry asked but attempts exhausted → final");
  assert.equal(await balance(env), 3 * P);
  assert.equal(await m.failJob(env, j, "timeout after 120 min", true), "ignored");
  assert.equal(await m.failJob(env, j, "GPU instance disappeared", false), "ignored");
  assert.equal(await balance(env), 3 * P);
  assert.equal((await events(env, job.id, "credits.refund")).length, 1);
  assert.equal((await events(env, job.id, "job.failed")).length, 1);
  assert.equal((await events(env, job.id, "job.fail.ignored")).length, 2);
});

test("planner / start failure of a queued job (no GPU) refunds in full", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const job = await short(env, u);
  assert.equal(await m.failJob(env, { ...job, attempts: 3 }, "could not start a GPU: no offers", false), "failed");
  assert.equal(await balance(env), 3 * P);
  assert.equal((await m.getJob(env, job.id)).state, "failed");
});

test("requeue: no refund, fresh worker secret, backend cleared; the later final failure refunds exactly once", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const job = await short(env, u);
  await m.updateJob(env, job.id, { state: "starting", backend: "manual", instance_id: "gpu-5", started_at: new Date().toISOString(), attempts: 1 });
  const before = await m.getJob(env, job.id);
  assert.equal(await m.failJob(env, before, "worker never started within 15 min", true), "requeued");
  const after = await m.getJob(env, job.id);
  assert.equal(after.state, "queued");
  assert.equal(after.backend, null);
  assert.equal(after.instance_id, null);
  assert.equal(after.started_at, null);
  assert.equal(after.percent, 0);
  assert.notEqual(after.worker_secret, before.worker_secret, "the secret rotates on requeue");
  assert.equal(await balance(env), 2 * P, "no refund on requeue");
  // the old GPU can no longer talk about this job
  assert.equal((await internal(env, before, "progress", { percent: 50 })).status, 401);
  // second attempt also dies, third dies for good
  await m.updateJob(env, job.id, { state: "starting", backend: "manual", instance_id: "gpu-6", started_at: new Date().toISOString(), attempts: 2 });
  assert.equal(await m.failJob(env, await m.getJob(env, job.id), "GPU instance disappeared", true), "requeued");
  await m.updateJob(env, job.id, { state: "rendering", backend: "manual", instance_id: "gpu-7", started_at: new Date().toISOString(), attempts: 3, percent: 33 });
  assert.equal(await m.failJob(env, await m.getJob(env, job.id), "timeout after 120 min", true), "failed");
  assert.equal(await balance(env), 3 * P);
  const refunds = await events(env, job.id, "credits.refund");
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].detail.amount, P);
  assert.equal((await events(env, job.id, "job.requeued")).length, 2);
});

test("failure after cancel: no second refund (the race the planner and the timeouts can hit)", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const job = await short(env, u);
  const stale = await m.getJob(env, job.id); // what a slow planner/tick still holds
  await m.cancelJob(env, u, job.id);
  assert.equal(await balance(env), 3 * P);
  assert.equal(await m.failJob(env, { ...stale, plan_attempts: 2 }, "could not plan the video", false), "ignored");
  assert.equal(await m.failJob(env, { ...stale, state: "rendering", attempts: 1 }, "timeout", true), "ignored");
  assert.equal(await balance(env), 3 * P);
  assert.equal((await m.getJob(env, job.id)).state, "cancelled");
  assert.equal((await m.getJob(env, job.id)).worker_secret, stale.worker_secret, "an ignored requeue does not touch the job");
});

test("done then failed, or done twice: the job stays done and nothing is refunded", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const job = await short(env, u);
  await m.updateJob(env, job.id, { state: "finishing", backend: "manual", instance_id: "gpu-8", started_at: new Date().toISOString(), percent: 95 });
  const j = await m.getJob(env, job.id);
  assert.equal(await m.finishJob(env, j, 0.5), true);
  assert.equal(await m.finishJob(env, j, 0.5), false);
  assert.equal(await m.failJob(env, j, "worker: late error", true), "ignored");
  const now = await m.getJob(env, job.id);
  assert.equal(now.state, "done");
  assert.equal(now.cost_usd, 0.5);
  assert.equal(await balance(env), 2 * P);
  assert.equal((await events(env, job.id, "job.done")).length, 1);
  assert.equal((await events(env, job.id, "credits.refund")).length, 0);
});

test("cancel racing with done: whichever transition lands first wins, the other is ignored", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const job = await short(env, u);
  await m.updateJob(env, job.id, { state: "finishing", backend: "manual", instance_id: "gpu-9", started_at: new Date().toISOString(), percent: 95 });
  const j = await m.getJob(env, job.id);
  const [c, d] = await Promise.all([m.cancelJob(env, u, j.id).catch((e) => e), m.finishJob(env, j, 0)]);
  const now = await m.getJob(env, job.id);
  if (now.state === "done") { assert.ok(c instanceof m.JobError); assert.equal(d, true); assert.equal(await balance(env), 2 * P); }
  else { assert.equal(now.state, "cancelled"); assert.equal(d, false); assert.equal(await balance(env), 2 + c.refunded); }
  assert.ok((await events(env, job.id, "credits.refund")).length <= 1);
});

/* ------------------------------------------------------------------ worker API */
test("internal API: done twice → 200/200 (already), failed after done → 409, progress after cancel → 409, wrong secret → 401", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const a = await short(env, u);
  await m.updateJob(env, a.id, { state: "starting", backend: "manual", instance_id: "gpu-10", started_at: new Date().toISOString() });
  let r = await internal(env, a, "progress", { percent: 56, track: "clips" });
  assert.equal(r.status, 200);
  assert.equal((await m.getJob(env, a.id)).state, "rendering");
  r = await internal(env, a, "done", { cost_usd: 0.3 });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, state: "done" });
  r = await internal(env, a, "done", { cost_usd: 0.3 });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, state: "done", already: true });
  r = await internal(env, a, "failed", { error: "late", retry: true });
  assert.equal(r.status, 409);
  r = await internal(env, a, "progress", { percent: 10 });
  assert.equal(r.status, 409);
  assert.equal((await m.getJob(env, a.id)).state, "done");
  assert.equal((await m.getJob(env, a.id)).percent, 100);
  assert.equal(await balance(env), 2 * P);
  assert.equal((await events(env, a.id, "job.done")).length, 1);

  const b = await short(env, u);
  await m.updateJob(env, b.id, { state: "rendering", backend: "manual", instance_id: "gpu-11", started_at: new Date().toISOString(), percent: 20 });
  await m.cancelJob(env, u, b.id);
  assert.equal(await balance(env), P + Math.round(P * 0.8), "cancelled at 20% of rendering: 80% of the film's price comes back");
  for (const [path, body] of [["progress", { percent: 30 }], ["done", {}], ["failed", { error: "x" }]]) {
    r = await internal(env, b, path, body);
    assert.equal(r.status, 409, path);
  }
  const bb = await m.getJob(env, b.id);
  assert.equal(bb.state, "cancelled"); assert.equal(bb.percent, 20);
  assert.equal(await balance(env), P + Math.round(P * 0.8), "still the proportional refund: no later call moves credits");
  assert.equal((await internal(env, b, "progress", { percent: 1 }, "wk_wrong")).status, 401);
  // "failed" twice with retry:false → 200 then 200 already, one refund
  const c = await short(env, u);
  await m.updateJob(env, c.id, { state: "rendering", backend: "manual", instance_id: "gpu-12", started_at: new Date().toISOString(), percent: 20, attempts: 1 });
  r = await internal(env, c, "failed", { error: "bad storyboard", retry: false });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, state: "failed", outcome: "failed" });
  r = await internal(env, c, "failed", { error: "bad storyboard", retry: false });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, state: "failed", already: true });
  assert.equal(await balance(env), P + Math.round(P * 0.8), "a final failure refunds the film in full: back to what b left");
  assert.equal((await events(env, c.id, "credits.refund")).length, 1);
});

/* ------------------------------------------------------------------ orchestrator */
test("tick never leaves a GPU rented for a job cancelled while it was being started", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const job = await short(env, u);
  await m.updateJob(env, job.id, { storyboard: "{}" }); // "planned": only a planned job may get a GPU
  const destroyed = [];
  const origStart = m.manualBackend.start, origDestroy = m.manualBackend.destroy;
  m.manualBackend.start = async (e, j) => { await m.cancelJob(e, u, j.id); return { instanceId: "gpu-late" }; };
  m.manualBackend.destroy = async (_e, j) => { destroyed.push(j.instance_id); return 0; };
  try {
    await m.tick(env);
  } finally { m.manualBackend.start = origStart; m.manualBackend.destroy = origDestroy; }
  const j = await m.getJob(env, job.id);
  assert.equal(j.state, "cancelled");
  assert.equal(j.instance_id, null);
  assert.deepEqual(destroyed, ["gpu-late"]);
  assert.equal(await balance(env), 3 * P);
  assert.equal((await events(env, job.id, "job.started.orphan")).length, 1);
  assert.equal((await events(env, job.id, "job.started")).length, 0);
});

test("tick: a cancelled or failed job is never picked up for a GPU; a queued job is started once with attempts=1", async () => {
  const env = await newEnv();
  const u = await user(env, 3 * P);
  const a = await short(env, u), b = await short(env, u);
  await m.updateJob(env, a.id, { storyboard: "{}" });
  await m.cancelJob(env, u, a.id);
  const starts = [];
  const origStart = m.manualBackend.start;
  m.manualBackend.start = async (_e, j) => { starts.push(j.id); return { instanceId: "gpu-" + j.id }; };
  try {
    await m.tick(env, { plan: true }); // plans b with the fixture storyboard, then rents for it (a is cancelled: not planned, not started)
    await m.tick(env, { plan: true });
  } finally { m.manualBackend.start = origStart; }
  assert.deepEqual(starts, [b.id]);
  const bb = await m.getJob(env, b.id);
  assert.ok(bb.storyboard && bb.storyboard !== "{}", "b was planned by the tick");
  assert.equal(bb.state, "starting"); assert.equal(bb.attempts, 1); assert.equal(bb.instance_id, "gpu-" + b.id);
  assert.equal((await m.getJob(env, a.id)).state, "cancelled");
  assert.equal((await events(env, a.id, "job.started")).length, 0);
  assert.equal(await balance(env), 2 * P);
});

test("mock progress does not resurrect a cancelled job", async () => {
  const env = await newEnv("mock");
  const u = await user(env, 3 * P);
  const job = await short(env, u);
  await m.updateJob(env, job.id, { state: "rendering", backend: "mock", instance_id: "mock-1", started_at: new Date(Date.now() - 30_000).toISOString(), percent: 40 });
  const stale = await m.getJob(env, job.id);
  await m.cancelJob(env, u, job.id);
  // simulate the tick having read the job before the cancel: run the mock step directly via tick (it re-reads active jobs → none)
  await m.tick(env);
  const now = await m.getJob(env, job.id);
  assert.equal(now.state, "cancelled");
  assert.equal(now.percent, 40);
  assert.equal(await balance(env), 2 * P + Math.round(P * 0.6), "cancelled at 40%: 60% back");
  assert.equal(stale.state, "rendering");
});
