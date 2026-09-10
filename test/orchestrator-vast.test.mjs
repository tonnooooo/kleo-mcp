/**
 * Vast.ai rental safety: no GPU is ever left running without the job row knowing about it.
 * Same recipe as credits.test.mjs (esbuild bundle + a D1 look-alike on node:sqlite), plus a fake Vast REST API
 * on global fetch, so the real code of backends/vast.ts and orchestrator.ts is exercised. No network, no GPU.
 * Run: node --test test/orchestrator-vast.test.mjs
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

let m;
before(async () => {
  const r = await esbuild.build({
    stdin: {
      contents: `export * from "./src/jobs.ts"; export * from "./src/orchestrator.ts"; export * from "./src/db.ts";
        export * from "./src/schema.ts"; export * from "./src/templates.ts";
        export { vastBackend, listKleoInstances, jobLabel } from "./src/backends/vast.ts";`,
      resolveDir: ROOT, loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent",
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

async function newEnv(extra = {}) {
  const env = {
    DB: new FakeD1(), RENDER_BACKEND: "vast", PUBLIC_URL: "http://kleo.test", INTERNAL_SECRET: "s3cret",
    VAST_API_KEY: "k".repeat(64), VAST_IMAGE: "ghcr.io/kleo/worker:test", JOB_TIMEOUT_MIN: "120",
    MAX_CONCURRENT_GPUS: "5", MAX_JOBS_PER_USER: "2", FREE_CREDITS: "10", RESULT_TTL_DAYS: "7",
    // Out of the way unless a test is about them: the daily job cap and the GPU budget have their own tests below.
    MAX_JOBS_PER_DAY: "500", DAILY_GPU_BUDGET_USD: "1000",
    ...extra,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const user = (env, credits = 10) => m.createUser(env, { id: "u_test", email: "t@example.com", credits, inviteCode: null });
const short = (env, u, extra = {}) => m.createJob(env, u, { template: "viral-short", prompt: "Pirates find an island missing from every map", duration_s: 45, format: "9:16", ...extra });
const events = async (env, name) => (await env.DB.prepare("SELECT job_id, event, detail FROM audit WHERE event = ? ORDER BY id").bind(name).all()).results.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));

/* ------------------------------------------------------------------ fake Vast REST API */
const OFFERS = [
  { id: 11, dph_total: 0.3, gpu_name: "RTX 4090", inet_down: 900, disk_space: 120, cpu_cores_effective: 16, cpu_ram: 65536, geolocation: "FR" },
  { id: 22, dph_total: 0.35, gpu_name: "RTX 4090", inet_down: 800, disk_space: 120, cpu_cores_effective: 16, cpu_ram: 65536, geolocation: "DE" },
  { id: 33, dph_total: 0.4, gpu_name: "RTX 4090", inet_down: 700, disk_space: 120, cpu_cores_effective: 16, cpu_ram: 65536, geolocation: "US" },
];
/** Word-for-word what console.vast.ai answers today on the v0 listing — HTTP 200, so it reads as "no instances". */
const DEPRECATED_V0_LIST = { success: false, error: "deprecated_endpoint", msg: "/api/v0/instances/ is deprecated. Use /api/v1/instances/ instead." };
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * `instances` is the account state; `onCreate(offerId, body, state)` decides what PUT /asks/{offer}/ does — that is the
 * whole point of these tests: it may create the instance and still answer with an error (the lost answer).
 * The listing is served from /api/v1/ ONLY, exactly like the real API; /api/v0/instances/ answers the deprecation body.
 * `pageSize` splits the v1 listing into next_token pages.
 */
function fakeVast({ instances = [], onCreate = () => ({ success: true }), listFails = false, pageSize = 0 } = {}) {
  const state = { instances: [...instances], calls: [], rawCalls: [], nextId: 900 };
  state.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const api = /^\/api\/v(\d)\b/.exec(u.pathname)?.[1] ?? "?";
    const path = u.pathname.replace(/^\/api\/v\d/, "") + (u.search || "");
    const method = init.method ?? "GET";
    state.calls.push(`${method} ${path}`);
    state.rawCalls.push(`${method} ${u.pathname}${u.search}`);
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && path === "/bundles/") return json({ offers: OFFERS });
    const ask = path.match(/^\/asks\/(\d+)\/$/);
    if (method === "PUT" && ask) {
      const r = onCreate(Number(ask[1]), JSON.parse(init.body), state);
      if (r.create) state.instances.push({ id: r.create, label: JSON.parse(init.body).label, actual_status: "loading", dph_total: 0.3, start_date: r.start_date ?? nowSec() });
      return r.status && r.status >= 400 ? new Response(r.text ?? "boom", { status: r.status }) : json(r.body ?? { success: true, new_contract: r.create ?? ++state.nextId });
    }
    // The listing (no instance id in the path).
    if (method === "GET" && /^\/instances\/(\?|$)/.test(path)) {
      if (api === "0") return json(DEPRECATED_V0_LIST); // deprecated: a 200 that looks like an empty account
      if (listFails) return new Response("upstream down", { status: 503 });
      const all = state.instances;
      if (!pageSize) return json({ success: true, instances: all, instances_found: all.length });
      const from = Number(u.searchParams.get("next_token") ?? 0);
      const page = all.slice(from, from + pageSize);
      const next = from + pageSize < all.length ? String(from + pageSize) : null;
      return json({ success: true, instances: page, instances_found: all.length, next_token: next });
    }
    const one = path.match(/^\/instances\/(\d+)\/$/);
    if (one) {
      const i = state.instances.find((x) => String(x.id) === one[1]);
      if (method === "DELETE") { state.instances = state.instances.filter((x) => String(x.id) !== one[1]); return json({ success: true }); }
      return i ? json({ instances: i }) : new Response("not found", { status: 404 });
    }
    throw new Error(`unexpected Vast call: ${method} ${path}`);
  };
  return state;
}
function withVast(state, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = state.fetch;
  return (async () => { try { return await fn(); } finally { globalThis.fetch = orig; } })();
}
const count = (state, needle) => state.calls.filter((c) => c.startsWith(needle)).length;
/** Listing calls, by API version: the only endpoint whose version is load-bearing. */
const listCalls = (state, version) => state.rawCalls.filter((c) => c.startsWith(`GET /api/v${version}/instances/`) && !/\/instances\/\d+\//.test(c)).length;

/* ------------------------------------------------------------------ lost create answer */
test("start: a create whose answer is lost is adopted by its label, not left orphaned", async () => {
  const env = await newEnv();
  const job = { id: "gt_lost1", worker_secret: "wk_1" };
  // Vast really creates instance 777, then the answer dies on the way back (5xx after creation).
  const v = fakeVast({ onCreate: () => ({ create: 777, status: 502, text: "bad gateway" }) });
  const r = await withVast(v, () => m.vastBackend.start(env, job));
  assert.equal(r.instanceId, "777", "the instance the lost answer created is what start() returns");
  assert.equal(r.meta.adopted, true);
  assert.equal(count(v, "PUT /asks/"), 1, "no second GPU is rented once the first one is found");
  assert.deepEqual(v.instances.map((i) => i.id), [777], "and it is still alive: adopted, not thrown away");
});

test("start: two lost answers for the same job → the newest is adopted and the duplicate destroyed", async () => {
  const env = await newEnv();
  const job = { id: "gt_lost2", worker_secret: "wk_2" };
  const label = m.jobLabel(job.id);
  const v = fakeVast({
    // Another lost answer from this same start(), a couple of seconds ago: same secret, so either would do.
    instances: [{ id: 500, label, actual_status: "loading", dph_total: 0.3, start_date: nowSec() - 2 }],
    onCreate: () => ({ create: 900, status: 500 }),
  });
  const r = await withVast(v, () => m.vastBackend.start(env, job));
  assert.equal(r.instanceId, "900");
  assert.equal(r.meta.duplicates_destroyed, 1);
  assert.deepEqual(v.instances.map((i) => i.id), [900], "only the recorded instance survives");
});

test("start: an instance labelled for another job is never adopted", async () => {
  const env = await newEnv();
  const v = fakeVast({ instances: [{ id: 111, label: m.jobLabel("gt_someone_else"), actual_status: "running" }], onCreate: () => ({ create: 42 }) });
  const r = await withVast(v, () => m.vastBackend.start(env, { id: "gt_mine", worker_secret: "wk_3" }));
  assert.equal(r.instanceId, "42");
  assert.ok(!r.meta.adopted);
  assert.ok(v.instances.some((i) => i.id === 111), "the other job's GPU is untouched");
});

test("start: a failing orphan lookup neither hides the create error nor stops the next offer", async () => {
  const env = await newEnv();
  const v = fakeVast({ listFails: true, onCreate: (offer) => (offer === OFFERS[0].id ? { status: 500, text: "offer exploded" } : { create: 43 }) });
  const r = await withVast(v, () => m.vastBackend.start(env, { id: "gt_look", worker_secret: "wk_4" }));
  assert.equal(r.instanceId, "43", "the loop still moves on to the second offer");

  const v2 = fakeVast({ listFails: true, onCreate: () => ({ status: 500, text: "offer exploded" }) });
  await withVast(v2, () => assert.rejects(
    m.vastBackend.start(env, { id: "gt_look2", worker_secret: "wk_5" }),
    (e) => /could not rent an instance/.test(e.message) && /offer exploded/.test(e.message) && /orphan lookup failed/.test(e.message),
  ));
});

test("start: a clean refusal never triggers an orphan lookup, so a stale GPU is never adopted", async () => {
  const env = await newEnv();
  const job = { id: "gt_clean", worker_secret: "wk_new" };
  const stale = { id: 300, label: m.jobLabel(job.id), actual_status: "running", dph_total: 0.3, start_date: nowSec() - 3600 };
  // "Offer taken" (410) is a definite refusal: Vast understood and declined, so nothing was rented and there is
  // nothing of this attempt's to find. Looking anyway would turn a plain retry into an adoption of the stale GPU.
  const v = fakeVast({ instances: [stale], onCreate: (offer) => (offer === OFFERS[0].id ? { status: 410, text: "offer no longer available" } : { create: 301 }) });
  const r = await withVast(v, () => m.vastBackend.start(env, job));
  assert.equal(r.instanceId, "301", "the next offer is taken, normally");
  assert.ok(!r.meta.adopted);
  assert.equal(listCalls(v, 1), 0, "a definite refusal costs no listing call at all");
});

test("start: an instance from an earlier attempt is destroyed, never adopted (its worker secret is stale)", async () => {
  const env = await newEnv();
  // failJob() rotates worker_secret on every requeue, so instance 400 — rented half an hour ago for an earlier
  // attempt at this same job — carries a secret the API now rejects. Adopting it would park the job on a GPU whose
  // worker 401s until the start timeout expires; the only useful thing to do with it is to stop paying for it.
  const job = { id: "gt_stale", worker_secret: "wk_rotated" };
  const stale = { id: 400, label: m.jobLabel(job.id), actual_status: "running", dph_total: 0.3, start_date: nowSec() - 30 * 60 };
  const v = fakeVast({ instances: [stale], onCreate: (offer) => (offer === OFFERS[0].id ? { status: 503, text: "gateway" } : { create: 401 }) });
  const r = await withVast(v, () => m.vastBackend.start(env, job));
  assert.equal(r.instanceId, "401", "an ambiguous 5xx stays a retry, it never becomes a stall");
  assert.ok(!r.meta.adopted);
  assert.deepEqual(v.instances.map((i) => i.id), [401], "and the stale rental is not left burning either");
});

/* ------------------------------------------------------------------ the account listing lives on /api/v1/ */
test("listing: instances are listed through /api/v1/, never the deprecated v0 endpoint", async () => {
  const env = await newEnv();
  const v = fakeVast({ instances: [
    { id: 70, label: m.jobLabel("gt_a"), actual_status: "running", dph_total: 0.3 },
    { id: 71, label: "not-kleo", actual_status: "running" },
  ] });
  const rows = await withVast(v, () => m.listKleoInstances(env));
  assert.deepEqual(rows, [{ id: 70, jobId: "gt_a", status: "running", dph: 0.3 }]);
  assert.equal(listCalls(v, 1), 1);
  // GET /api/v0/instances/ answers {"success":false,"error":"deprecated_endpoint"} with HTTP 200: a call there reads
  // as "the account has no instances", which is how the sweep went blind and an orphan GPU could bill for hours.
  assert.equal(listCalls(v, 0), 0, "the listing must never go back to /api/v0/instances/");
});

test("listing: a success:false answer is an error, not an empty account", async () => {
  const env = await newEnv();
  const v = fakeVast({ instances: [{ id: 80, label: m.jobLabel("gt_b"), actual_status: "running" }] });
  const real = v.fetch;
  v.fetch = async (url, init) => (new URL(url).pathname === "/api/v1/instances/" && (init?.method ?? "GET") === "GET"
    ? new Response(JSON.stringify(DEPRECATED_V0_LIST), { status: 200, headers: { "content-type": "application/json" } })
    : real(url, init));
  await withVast(v, () => assert.rejects(m.listKleoInstances(env), /deprecated_endpoint/));
});

test("listing: next_token pages are followed to the end", async () => {
  const env = await newEnv();
  const instances = [1, 2, 3, 4, 5].map((n) => ({ id: 100 + n, label: m.jobLabel(`gt_p${n}`), actual_status: "running", dph_total: 0.3 }));
  const v = fakeVast({ instances, pageSize: 2 });
  const rows = await withVast(v, () => m.listKleoInstances(env));
  assert.deepEqual(rows.map((r) => r.id), [101, 102, 103, 104, 105], "an orphan on page three is found like any other");
  assert.equal(listCalls(v, 1), 3);
});

test("tick: an adopted instance is recorded on the job, so destroy() can reach it", async () => {
  const env = await newEnv();
  const u = await user(env, 3);
  const job = await short(env, u);
  await m.updateJob(env, job.id, { storyboard: JSON.stringify({ style: "cinema", scenes: [] }) });
  const v = fakeVast({ onCreate: () => ({ create: 606, status: 500 }) });
  await withVast(v, () => m.tick(env));
  const j = await m.getJob(env, job.id);
  assert.equal(j.state, "starting");
  assert.equal(j.instance_id, "606", "the GPU the lost answer created is the one the job holds");
  assert.equal(JSON.parse(j.instance_meta).adopted, true);
  assert.equal((await events(env, "job.started")).length, 1);
  // and from there the normal path works: cancelling gives the GPU back
  await withVast(v, () => m.cancelJob(env, u, job.id));
  assert.deepEqual(v.instances, [], "the adopted instance is destroyed with the job");
});

/* ------------------------------------------------------------------ sweep */
test("sweep: instances whose job is over (or superseded) are destroyed, the others are left alone", async () => {
  const env = await newEnv();
  const u = await user(env, 10);
  const done = await short(env, u), running = await short(env, u);
  await m.updateJob(env, done.id, { state: "done", backend: "vast", instance_id: "10" });
  await m.updateJob(env, running.id, { state: "rendering", backend: "vast", instance_id: "20" });
  // Being started right now = state 'starting' with no instance_id yet: reserveJob writes 'starting' BEFORE
  // backend.start() runs, so this — not 'queued' — is what an in-flight rental looks like.
  const starting = await short(env, u);
  await m.updateJob(env, starting.id, { state: "starting", backend: "vast" });
  const v = fakeVast({ instances: [
    { id: 10, label: m.jobLabel(done.id), actual_status: "running", dph_total: 0.3 },   // job finished → orphan
    { id: 20, label: m.jobLabel(running.id), actual_status: "running" },                 // the job's own GPU → keep
    { id: 21, label: m.jobLabel(running.id), actual_status: "running" },                 // a second GPU for the same job → orphan
    { id: 30, label: m.jobLabel(starting.id), actual_status: "loading" },                 // rental in flight → keep
    { id: 40, label: m.jobLabel("gt_other_env"), actual_status: "running" },              // another deployment → never touched
    { id: 50, label: "not-kleo", actual_status: "running" },                              // not ours at all
  ] });
  const destroyed = await withVast(v, () => m.sweepVastOrphans(env));
  assert.equal(destroyed, 2);
  assert.deepEqual(v.instances.map((i) => i.id), [20, 30, 40, 50]);
  const swept = await events(env, "vast.orphan.swept");
  assert.deepEqual(swept.map((e) => e.detail.instance).sort(), [10, 21]);
  assert.equal(swept.find((e) => e.detail.instance === 21).detail.kept, "20");
  // one listing per SWEEP_MIN: the next tick must not hammer the API
  const again = await withVast(v, () => m.sweepVastOrphans(env));
  assert.equal(again, 0);
  assert.equal(listCalls(v, 1), 1);
});

test("sweep: a live instance labelled for a QUEUED job is money burning, and is destroyed", async () => {
  const env = await newEnv();
  const u = await user(env, 10);
  const queued = await short(env, u); // still 'queued': reserveJob has not run, so nothing legitimately rented for it
  assert.equal((await m.getJob(env, queued.id)).state, "queued");
  const v = fakeVast({ instances: [{ id: 60, label: m.jobLabel(queued.id), actual_status: "running", dph_total: 0.3 }] });
  assert.equal(await withVast(v, () => m.sweepVastOrphans(env)), 1);
  assert.deepEqual(v.instances, [], "a queued job can never own a live GPU: leaving it alive burns money unwatched");
  const [swept] = await events(env, "vast.orphan.swept");
  assert.equal(swept.detail.job_state, "queued");
  assert.equal(swept.detail.kept, null);
});

test("sweep: a listing that fails is audited and never throws (the tick must keep going)", async () => {
  const env = await newEnv();
  const v = fakeVast({ listFails: true });
  assert.equal(await withVast(v, () => m.sweepVastOrphans(env)), 0);
  assert.equal((await events(env, "vast.orphan.sweep.error")).length, 1);
  assert.equal(await withVast(v, () => m.sweepVastOrphans(env)), 0, "still throttled after a failure");
});

test("sweep: without a Vast key nothing is listed, and no other backend's instance is ever touched", async () => {
  const env = await newEnv({ VAST_API_KEY: undefined });
  const v = fakeVast({ instances: [{ id: 10, label: m.jobLabel("gt_x"), actual_status: "running" }] });
  assert.equal(await withVast(v, () => m.sweepVastOrphans(env)), 0);
  assert.deepEqual(v.calls, []);
});

/* ------------------------------------------------------------------ picture jobs waiting for a GPU */
const PICTURE = JSON.stringify({ style: "picture", scenes: [] });

test("picture jobs: while Vast is down the wait is explained on the job and audited once", async () => {
  const env = await newEnv();
  const u = await user(env, 10);
  const pic = await short(env, u, { style: "cartoon" });
  const cyber = await short(env, u, { style: "cyber" });
  await m.updateJob(env, pic.id, { storyboard: PICTURE });
  await m.updateJob(env, cyber.id, { storyboard: JSON.stringify({ style: "cinema", scenes: [] }) });
  await m.setFlagUntil(env, "vast_unavailable", 30 * 60); // the outage the user is sitting through

  const v = fakeVast();
  await withVast(v, () => m.tick(env));
  const j = await m.getJob(env, pic.id);
  assert.equal(j.state, "queued");
  assert.equal(j.error, m.GPU_ONLY_WAIT, "the job now says why it is not moving");
  assert.equal((await m.getJob(env, cyber.id)).error, null, "a cyber job can run on the free pool: nothing to explain");
  const waiting = await events(env, "job.waiting_for_gpu");
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].job_id, pic.id);
  assert.equal(waiting[0].detail.reason, "vast_unavailable");
  assert.equal(waiting[0].detail.style, "cartoon");
  assert.equal(count(v, "PUT /asks/"), 0, "no GPU is rented while the provider is flagged down");

  await withVast(v, () => m.tick(env));
  assert.equal((await events(env, "job.waiting_for_gpu")).length, 1, "the same wait is not audited every minute");
  // the pool is not an option for it, which is exactly why the message exists
  assert.equal(await m.poolWaitingJobs(env, 0), 1, "only the cyber job is offered to the pool");
});

test("picture jobs: a real start error is kept, the explanation is added in front of it", async () => {
  const env = await newEnv();
  const u = await user(env, 10);
  const pic = await short(env, u, { style: "cartoon" });
  const realError = "could not start a GPU: no Vast.ai offer matches the filters (gpu/price/network)";
  await m.updateJob(env, pic.id, { storyboard: PICTURE, error: realError });
  await m.setFlagUntil(env, "vast_unavailable", 30 * 60);

  const v = fakeVast();
  await withVast(v, () => m.tick(env));
  const j = await m.getJob(env, pic.id);
  assert.ok(j.error.startsWith(m.GPU_ONLY_WAIT), "the explanation leads, so the reader knows why nothing is moving");
  assert.match(j.error, /no Vast\.ai offer matches the filters/, "and the real error it replaced is still readable");
  assert.equal((await events(env, "job.waiting_for_gpu"))[0].detail.previous_error, realError);

  await withVast(v, () => m.tick(env));
  assert.equal((await events(env, "job.waiting_for_gpu")).length, 1, "an explained job is filtered out in SQL, not explained again");
});

test("picture jobs: past the query's page size, the stranded jobs are still explained", async () => {
  // queuedPictureJobs pages 20 at a time. Without an "already explained" filter in SQL those same twenty came back
  // every minute and job 21 onwards was never told anything, however long it waited.
  const env = await newEnv({ MAX_JOBS_PER_USER: "100" });
  const u = await user(env, 200);
  const ids = [];
  for (let i = 0; i < 22; i++) {
    const j = await short(env, u, { style: "cartoon" });
    await m.updateJob(env, j.id, { storyboard: PICTURE });
    ids.push(j.id);
  }
  await m.setFlagUntil(env, "vast_unavailable", 30 * 60);
  const v = fakeVast();
  await withVast(v, () => m.tick(env));
  assert.equal((await events(env, "job.waiting_for_gpu")).length, 20, "one page on the first pass");
  await withVast(v, () => m.tick(env));
  const explained = await events(env, "job.waiting_for_gpu");
  assert.equal(explained.length, 22, "and the rest on the next, instead of the same twenty for ever");
  assert.deepEqual([...new Set(explained.map((e) => e.job_id))].sort(), [...ids].sort());
  for (const id of ids) assert.ok((await m.getJob(env, id)).error.startsWith(m.GPU_ONLY_WAIT));
});

test("picture jobs: the explanation is cleared as soon as a GPU is really reserved", async () => {
  const env = await newEnv();
  const u = await user(env, 10);
  const pic = await short(env, u, { style: "realistic" });
  await m.updateJob(env, pic.id, { storyboard: PICTURE, error: m.GPU_ONLY_WAIT });
  const v = fakeVast({ onCreate: () => ({ create: 808 }) });
  await withVast(v, () => m.tick(env));
  const j = await m.getJob(env, pic.id);
  assert.equal(j.state, "starting");
  assert.equal(j.error, null);
  assert.equal(j.instance_id, "808");
});

/* ------------------------------------------------------------------ the daily GPU budget */
test("budget: the estimate counts money already committed, not only money already spent", async () => {
  // cost_usd is written when a rental ENDS, so a bare SUM reads 0.00 while GPUs burn. Each running job is therefore
  // priced at the worst case it can still reach: VAST_MAX_DPH for its own timeout (per job, src/templates.ts).
  const env = await newEnv({ VAST_MAX_DPH: "0.40", JOB_TIMEOUT_MIN: "60", MAX_JOBS_PER_USER: "10" });
  const u = await user(env, 10);
  assert.equal(await m.budgetSpentUsd(env), 0);

  const rent = async (backend) => {
    const j = await short(env, u);
    await m.updateJob(env, j.id, { state: "starting", backend, instance_id: `i-${j.id}`, started_at: new Date().toISOString() });
    return j;
  };
  await rent("vast"); await rent("vast");
  assert.equal(Math.round((await m.budgetSpentUsd(env)) * 100) / 100, 0.8, "two rented GPUs are worth 0.80, not 0.00");

  // A job claimed by the free GitHub pool has committed nothing: counting it would shut the paid path down over
  // money that was never spent, and audit a budget.paused the owner cannot reconcile with his Vast balance.
  await rent("pool");
  assert.equal(Math.round((await m.budgetSpentUsd(env)) * 100) / 100, 0.8, "free work costs nothing and must not price anything");

  const done = await short(env, u);
  await m.updateJob(env, done.id, { state: "done", cost_usd: 0.17, finished_at: new Date().toISOString() });
  assert.equal(Math.round((await m.budgetSpentUsd(env)) * 100) / 100, 0.97, "today's bill plus what is in flight");
});

test("budget: a rental is priced at what it was actually taken at, not at the cap", async () => {
  // The cap is a stand-in for a price we do not know yet. Once the backend has taken an offer it writes the real
  // hourly price into instance_meta, and using it matters the day one style needs a card dearer than the others:
  // pricing every job at a cap raised to fit that card would pause Kleo over money it never spent.
  const env = await newEnv({ VAST_MAX_DPH: "0.80", JOB_TIMEOUT_MIN: "60", MAX_JOBS_PER_USER: "10" });
  const u = await user(env, 10);

  const cheap = await short(env, u);
  await m.updateJob(env, cheap.id, {
    state: "rendering", backend: "vast", instance_id: "i-cheap", started_at: new Date().toISOString(),
    instance_meta: JSON.stringify({ offer: 1, gpu: "RTX 4090", dph: 0.30 }),
  });
  assert.equal(Math.round((await m.budgetSpentUsd(env)) * 100) / 100, 0.30, "the machine costs 0.30, not the 0.80 the cap allows");

  // Still being chosen: no meta, so the cap is the only honest guess and the estimate stays pessimistic.
  const starting = await short(env, u);
  await m.updateJob(env, starting.id, { state: "starting", backend: "vast", started_at: new Date().toISOString() });
  assert.equal(Math.round((await m.budgetSpentUsd(env)) * 100) / 100, 1.10, "0.30 taken plus 0.80 not yet known");

  // A meta that cannot be read must never round down to zero: money is the one place to stay pessimistic.
  const broken = await short(env, u);
  await m.updateJob(env, broken.id, {
    state: "rendering", backend: "vast", instance_id: "i-broken", started_at: new Date().toISOString(),
    instance_meta: "{not json",
  });
  assert.equal(Math.round((await m.budgetSpentUsd(env)) * 100) / 100, 1.90, "an unreadable meta falls back to the cap");
});

test("budget: a long video is priced at its own timeout, not at a Short's", async () => {
  // The timeout follows the video (templates.ts jobTimeoutMin), so the money term has to follow it too: a video the
  // server itself announces in 80 minutes is allowed to run that long, and is worth that many GPU minutes.
  const env = await newEnv({ VAST_MAX_DPH: "0.40", JOB_TIMEOUT_MIN: "60", LOADING_TIMEOUT_MIN: "40", MAX_JOBS_PER_USER: "10" });
  const u = await user(env, 10);
  const long = await m.createJob(env, u, { template: "story-documentary", prompt: "The island that was never on any map", duration_s: 480 });
  await m.updateJob(env, long.id, { state: "rendering", backend: "vast", instance_id: "i-long", started_at: new Date().toISOString() });
  // etaFor(480) = 80 min of render + 40 min of tolerated image pull = 120 min at 0.40 $/h.
  assert.equal(Math.round((await m.budgetSpentUsd(env)) * 100) / 100, 0.8);
});

test("budget: yesterday's spending does not count against today", async () => {
  const env = await newEnv();
  const u = await user(env, 10);
  const old = await short(env, u);
  await m.updateJob(env, old.id, { state: "done", cost_usd: 5, finished_at: new Date(Date.now() - 48 * 3600_000).toISOString() });
  assert.equal(await m.budgetSpentUsd(env), 0, "the wall is a daily one, so it resets at midnight UTC");
});

test("budget: over the ceiling no GPU is rented, the job keeps its place and its credits", async () => {
  const env = await newEnv({ DAILY_GPU_BUDGET_USD: "0.50", VAST_MAX_DPH: "0.40", JOB_TIMEOUT_MIN: "60" });
  const u = await user(env, 10);
  const spent = await short(env, u);
  await m.updateJob(env, spent.id, { state: "done", cost_usd: 0.60, finished_at: new Date().toISOString() });
  const waiting = await short(env, u, { style: "cartoon" });
  await m.updateJob(env, waiting.id, { storyboard: PICTURE });

  const v = fakeVast({ onCreate: () => ({ create: 909 }) });
  await withVast(v, () => m.tick(env));
  assert.equal(count(v, "PUT /asks/"), 0, "nothing is rented once the day's budget is gone");
  const j = await m.getJob(env, waiting.id);
  assert.equal(j.state, "queued", "the job waits, it is not failed and not refunded");
  assert.equal(await m.getUser(env, u.id).then((x) => x.credits), 8, "and the credits stay debited, as for any queued job");
  assert.ok(j.error.startsWith(m.GPU_ONLY_WAIT), "the same wait machinery explains it, no second mechanism");
  const paused = await events(env, "budget.paused");
  assert.equal(paused.length, 1);
  assert.equal(paused[0].detail.budget_usd, 0.5);
  assert.equal((await events(env, "job.waiting_for_gpu"))[0].detail.reason, "budget_pause");

  // The pause lasts an hour: a second tick must not audit it again, and must still refuse to rent.
  await withVast(v, () => m.tick(env));
  assert.equal((await events(env, "budget.paused")).length, 1);
  assert.equal(count(v, "PUT /asks/"), 0);
});

test("budget: under the ceiling the rental happens exactly as before", async () => {
  const env = await newEnv({ DAILY_GPU_BUDGET_USD: "1.00", VAST_MAX_DPH: "0.40", JOB_TIMEOUT_MIN: "60" });
  const u = await user(env, 10);
  const job = await short(env, u);
  await m.updateJob(env, job.id, { storyboard: JSON.stringify({ style: "cinema", scenes: [] }) });
  const v = fakeVast({ onCreate: () => ({ create: 910 }) });
  await withVast(v, () => m.tick(env));
  assert.equal((await m.getJob(env, job.id)).state, "starting");
  assert.equal((await events(env, "budget.paused")).length, 0);
});

/* ------------------------------------------------------------------ the pause switch */
test("pause: the flag stops GPU rentals the same way a Vast outage does", async () => {
  const env = await newEnv();
  const u = await user(env, 10);
  const job = await short(env, u);
  await m.updateJob(env, job.id, { storyboard: JSON.stringify({ style: "cinema", scenes: [] }) });
  await m.setFlagUntil(env, "paused", 3600);
  const v = fakeVast({ onCreate: () => ({ create: 911 }) });
  await withVast(v, () => m.tick(env));
  assert.equal(count(v, "PUT /asks/"), 0, "the switch really does stop the spending");
  assert.equal((await m.getJob(env, job.id)).state, "queued");
  await m.releaseLock(env, "paused");
  await withVast(v, () => m.tick(env));
  assert.equal((await m.getJob(env, job.id)).state, "starting", "and resuming starts the queue again");
});

/* ------------------------------------------------------------------ jobs that never got a GPU */
test("queue: a job that waited longer than QUEUE_MAX_WAIT_MIN fails and is refunded", async () => {
  const env = await newEnv({ QUEUE_MAX_WAIT_MIN: "180" });
  const u = await user(env, 10);
  const job = await short(env, u);
  assert.equal(await m.getUser(env, u.id).then((x) => x.credits), 9);
  const waited = new Date(Date.now() - 200 * 60_000).toISOString();
  await m.updateJob(env, job.id, { created_at: waited, queued_at: waited, storyboard: JSON.stringify({ style: "cinema", scenes: [] }) });
  const v = fakeVast({ onCreate: () => ({ status: 500 }) }); // no GPU to be had, which is what the job is waiting for
  await withVast(v, () => m.tick(env));
  const j = await m.getJob(env, job.id);
  assert.equal(j.state, "failed");
  assert.match(j.error, /no GPU was free in time/);
  assert.equal(await m.getUser(env, u.id).then((x) => x.credits), 10, "credits taken for a video that never ran come back");
});

test("queue: the wait is counted from the last time the job entered the queue, and names the right culprit", async () => {
  const env = await newEnv({ QUEUE_MAX_WAIT_MIN: "180", MAX_JOBS_PER_USER: "10" });
  const u = await user(env, 10);
  const longAgo = new Date(Date.now() - 400 * 60_000).toISOString();

  // Rendered for hours, failed, went back to the queue: the clock restarts, or the job is killed on the spot for a
  // wait it never made and the two retries it still had are thrown away.
  const retried = await short(env, u);
  await m.updateJob(env, retried.id, { created_at: longAgo, queued_at: longAgo, storyboard: JSON.stringify({ style: "cinema", scenes: [] }),
    state: "rendering", backend: "manual", attempts: 1, started_at: longAgo });
  await m.failJob(env, await m.getJob(env, retried.id), "worker: crashed", true);
  assert.equal((await m.getJob(env, retried.id)).state, "queued");
  assert.deepEqual((await m.staleQueuedJobs(env, 180)).map((j) => j.id), [], "the wait for a GPU starts when the job entered the queue");

  // A job with no storyboard never asked for a GPU at all: it was the planner that held it, and so the message must say.
  const unplanned = await short(env, u);
  await m.updateJob(env, unplanned.id, { created_at: longAgo, queued_at: longAgo });
  const v = fakeVast();
  await withVast(v, () => m.tick(env));
  const j = await m.getJob(env, unplanned.id);
  assert.equal(j.state, "failed");
  assert.match(j.error, /could not write the storyboard/);
  assert.ok(!/no GPU was free/.test(j.error), "pointing at Vast for a Workers AI outage sends the owner to the wrong place");
});

/* ------------------------------------------------------------------ a retry has to move host */

test("retry: the machine that just failed is remembered before the row forgets it", async () => {
  // Measured on gt_7f7gnsjt (11 September): attempt two abandoned an instance for still downloading after 23
  // minutes, and attempt three rented the SAME offer. Not bad luck — the requeue cleared instance_meta, the search
  // orders by price, and the freed machine came back to the top.
  const env = await newEnv({ VAST_MAX_DPH: "0.40", MAX_JOBS_PER_USER: "10" });
  const u = await user(env, 10);
  const j = await short(env, u);
  await m.updateJob(env, j.id, {
    state: "starting", backend: "vast", instance_id: "i-slow", started_at: new Date().toISOString(),
    instance_meta: JSON.stringify({ offer: 44217727, machine: 9911, key: "m:9911", dph: 0.336 }),
  });

  const outcome = await m.failJob(env, { ...(await m.getJob(env, j.id)) }, "still downloading the renderer after 23 min", true);
  assert.equal(outcome, "requeued");

  const back = await m.getJob(env, j.id);
  assert.equal(back.state, "queued");
  assert.equal(back.instance_meta, null, "the row still forgets the instance, as it must");
  assert.deepEqual(m.triedMachines(back), ["m:9911"], "but the machine survives the forgetting");
});

test("retry: a second failure adds to the list and never loses the first", async () => {
  const env = await newEnv({ MAX_JOBS_PER_USER: "10" });
  const u = await user(env, 10);
  const j = await short(env, u);
  for (const [id, key] of [["i-a", "m:1"], ["i-b", "o:2"]]) {
    await m.updateJob(env, j.id, {
      state: "starting", backend: "vast", instance_id: id, started_at: new Date().toISOString(),
      instance_meta: JSON.stringify(key.startsWith("m:") ? { machine: Number(key.slice(2)) } : { offer: Number(key.slice(2)) }),
    });
    await m.failJob(env, { ...(await m.getJob(env, j.id)) }, "too slow", true);
  }
  assert.deepEqual(m.triedMachines(await m.getJob(env, j.id)), ["m:1", "o:2"]);

  // Twice the same machine is not two entries: the list is a preference, and a duplicate would only waste room.
  await m.rememberTriedMachine(env, j.id, "m:1");
  assert.deepEqual(m.triedMachines(await m.getJob(env, j.id)), ["m:1", "o:2"]);
});

test("retry: an unreadable or empty memory is an empty list, never a crash", () => {
  assert.deepEqual(m.triedMachines({ tried_machines: null }), []);
  assert.deepEqual(m.triedMachines({ tried_machines: "{not json" }), []);
  assert.deepEqual(m.triedMachines({ tried_machines: '"a string"' }), [], "a shape that is not a list is not a list");
  assert.deepEqual(m.triedMachines({ tried_machines: '["m:1", 7, null, "o:2"]' }), ["m:1", "o:2"], "only the strings survive");
});

/* ------------------------------------------------------------------ paying for the work you ask for */

const pirates = () => JSON.parse(readFileSync(join(ROOT, "test/fixtures/cartoon-pirates.json"), "utf8"));

test("price cap: a storyboard within its length is not touched", () => {
  const sb = pirates();
  assert.deepEqual(m.overPaidFor(sb, 45), [], "the fixture is what a well-behaved 45-second Short looks like");
});

test("price cap: more pictures than the length allows is refused, and says the way out", () => {
  // MAX_PICTURES is 24 for a Short. Nothing bounded this for a caller's storyboard: images.ts only ever sliced the
  // list the SERVER draws, and with IMAGE_SERVER_MAX=0 the rented GPU drew every one of them, for one credit.
  const sb = pirates();
  const scene = sb.scenes.find((s) => Array.isArray(s.shots) && s.shots.length);
  // Short lines on purpose: 40 scenes of real narration would ALSO bust the word budget, and this test is about
  // the pictures. That the two can fire together is the next test.
  sb.scenes = Array.from({ length: 40 }, (_, i) => ({ ...scene, id: `x${i}`, voice: "A line.", shots: scene.shots.slice(0, 1) }));
  const [problem, ...rest] = m.overPaidFor(sb, 45);
  assert.equal(rest.length, 0, "one problem, because only one thing is wrong");
  assert.match(problem, /asks for 40 pictures/);
  assert.match(problem, /allows 24/, "it says the number allowed, not just that the number is wrong");
  assert.match(problem, /fewer shots, or ask for a longer video/, "and how to pass");
  assert.match(problem, /Nothing was charged/);
});

test("price cap: narration far past the length is refused — the voice decides how long the video really is", () => {
  const sb = pirates();
  sb.scenes = sb.scenes.map((s) => ({ ...s, voice: Array.from({ length: 60 }, () => "word").join(" ") }));
  const problem = m.overPaidFor(sb, 45).find((p) => /words of narration/.test(p));
  assert.ok(problem, "300 words in a 45-second Short must not pass");
  assert.match(problem, /fits about 114/, "wordBudget(45).max — the ceiling, not the target of 104");
  assert.match(problem, /shorten the narration, or ask for a longer video/);
});

test("price cap: a longer video is allowed more of both, because it paid for more", () => {
  const sb = pirates();
  const scene = sb.scenes.find((s) => Array.isArray(s.shots) && s.shots.length);
  sb.scenes = Array.from({ length: 40 }, (_, i) => ({ ...scene, id: `x${i}`, shots: scene.shots.slice(0, 1) }));
  assert.deepEqual(m.overPaidFor(sb, 600).filter((p) => /pictures/.test(p)), [],
    "40 pictures are over the 24 of a Short and inside the 48 of a long video: the cap follows what was paid");
});

test("price cap: a storyboard with no pictures and no words cannot be refused for having too many", () => {
  assert.deepEqual(m.overPaidFor({}, 45), []);
  assert.deepEqual(m.overPaidFor(null, 45), []);
  assert.deepEqual(m.overPaidFor({ scenes: [] }, 45), []);
});

test("price cap: two things wrong are said together, not one refusal at a time", () => {
  const sb = pirates();
  const scene = sb.scenes.find((s) => Array.isArray(s.shots) && s.shots.length);
  sb.scenes = Array.from({ length: 40 }, (_, i) => ({ ...scene, id: `x${i}`, shots: scene.shots.slice(0, 1) }));
  const problems = m.overPaidFor(sb, 45);
  assert.equal(problems.length, 2, "40 scenes of real narration are over BOTH ceilings");
  assert.ok(problems.some((p) => /pictures/.test(p)) && problems.some((p) => /words of narration/.test(p)),
    "and createJob joins them, so one call learns everything that is wrong instead of one thing per attempt");
});

test("price cap: Kleo may guess a look, but never one that costs extra", async () => {
  // A style the caller NAMED is always honoured. A style Kleo picked from the topic is a HUNCH — and the planner's
  // own accuracy was measured at 35% on 11 September — so a hunch must never reach for the credits of an expensive
  // style. Today nothing is expensive, so the tables are flipped inside the test to make the guard reachable.
  const env = await newEnv({ MAX_JOBS_PER_USER: "10", MAX_JOBS_PER_DAY: "10" });
  const u = await user(env, 20);
  const machine = m.STYLE_MACHINE, credits = m.STYLE_CREDITS;
  const before = { cartoon: machine.cartoon, realistic: machine.realistic, cc: credits.cartoon, cr: credits.realistic };
  try {
    machine.cartoon = m.VIDEO; machine.realistic = m.VIDEO;   // the two a pirate prompt would plausibly land on
    credits.cartoon = 7; credits.realistic = 7;
    const guessed = await short(env, u);                       // no style argument: Kleo has to pick one
    const picked = JSON.parse(guessed.params).style;
    assert.equal(m.isVideoStyle(picked), false, `guessed "${picked}", which costs extra: a hunch must not spend 7 credits`);
    assert.equal(guessed.credits, 1, "and the debit follows the style that was actually used");

    // Naming it is a decision, not a hunch, and is honoured whatever it costs.
    const asked = await short(env, u, { style: "cartoon" });
    assert.equal(JSON.parse(asked.params).style, "cartoon");
    assert.equal(asked.credits, 7, "7 credits, because the user asked for the expensive look with open eyes");
  } finally {
    machine.cartoon = before.cartoon; machine.realistic = before.realistic;
    credits.cartoon = before.cc; credits.realistic = before.cr;
  }
});
