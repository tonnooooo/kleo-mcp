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
        export * from "./src/schema.ts"; export { vastBackend, listKleoInstances, jobLabel } from "./src/backends/vast.ts";`,
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
