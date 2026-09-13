/**
 * Footage over kie.ai (src/footage.ts + the worker-facing routes in src/internal.ts), no network: kie.ai is a fake
 * `fetch`, D1 is node:sqlite, R2 is a Map. What is under test is the money and the contract, not the pictures:
 * which road a job takes, what one task costs, that a second request orders nothing twice, that the daily ceiling
 * refuses BEFORE a task is created, and that a finished clip is copied to R2 once and served to the box.
 * Run: node --test test/footage.test.mjs
 */
import { test, before, beforeEach, afterEach } from "node:test";
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
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}
class FakeKV {
  constructor() { this.m = new Map(); }
  async put(k, v) { this.m.set(k, v); }
  async get(k) { return this.m.get(k) ?? null; }
  async getWithMetadata(k) { return { value: this.m.get(k) ?? null, metadata: null }; }
  async delete(k) { this.m.delete(k); }
}
class FakeR2 {
  constructor() { this.m = new Map(); }
  async put(key, body, o) { const buf = body instanceof ArrayBuffer ? new Uint8Array(body) : body; this.m.set(key, { buf, type: o?.httpMetadata?.contentType }); return { size: buf.byteLength }; }
  async get(key) { const e = this.m.get(key); return e ? { body: e.buf.buffer, size: e.buf.byteLength, httpMetadata: { contentType: e.type }, httpEtag: '"x"' } : null; }
  async delete(key) { this.m.delete(key); }
}

let m;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export * from "./src/footage.ts"; export * from "./src/internal.ts"; export * from "./src/db.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent",
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

/** A fake kie.ai: records every createTask body, answers recordInfo from a script, serves the clip bytes. */
function fakeKie(script = {}) {
  const calls = { create: [], record: [], downloads: 0 };
  let n = 0;
  const mp4 = new Uint8Array(4096); mp4.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0); // "ftyp" at byte 4
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/api/v1/jobs/createTask")) {
      const body = JSON.parse(init.body);
      calls.create.push({ body, auth: init.headers.authorization });
      if (script.createFails) return new Response(JSON.stringify({ code: 402, msg: "insufficient credits" }), { status: 200 });
      return new Response(JSON.stringify({ code: 200, msg: "success", data: { taskId: `task_${++n}` } }), { status: 200 });
    }
    if (u.includes("/api/v1/jobs/recordInfo")) {
      const taskId = new URL(u).searchParams.get("taskId");
      calls.record.push(taskId);
      const state = script.state?.[taskId] ?? script.defaultState ?? "generating";
      const data = { taskId, state, resultJson: state === "success" ? JSON.stringify({ resultUrls: [`https://cdn.kie.test/${taskId}.mp4`] }) : "", failCode: state === "fail" ? "500" : "", failMsg: state === "fail" ? "content policy" : "" };
      return new Response(JSON.stringify({ code: 200, msg: "success", data }), { status: 200 });
    }
    if (u.startsWith("https://cdn.kie.test/")) { calls.downloads++; return new Response(mp4, { status: 200, headers: { "content-length": String(mp4.length) } }); }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { calls, fetch };
}

async function newEnv(extra = {}) {
  const env = { DB: new FakeD1(), OAUTH_KV: new FakeKV(), RENDERS: new FakeR2(), PUBLIC_URL: "http://kleo.test", INTERNAL_SECRET: "s3cret",
    KIE_API_KEY: "kie-test-key", KLEO_FOOTAGE_BACKEND: "kie", ...extra };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
async function filmJob(env, seconds = 18) {
  await m.createUser(env, { id: "u1", email: "u1@example.com", credits: 100, inviteCode: null });
  const job = { id: "gt_test1234", user_id: "u1", template: "film", prompt: "a night run", params: JSON.stringify({ duration_s: seconds, format: "9:16", language: "en", voice: null, style: "realistic" }),
    state: "rendering", track: "clips", percent: 12, eta_min: 5, credits: 7, backend: "manual", instance_id: null, instance_meta: null, worker_secret: "wsecret", attempts: 1, error: null,
    notify_email: null, created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, expires_at: null, purged_at: null, cost_usd: null, storyboard: null, plan_attempts: 0, plan_error: null };
  await m.insertJob(env, job);
  return job;
}
const SHOTS = [
  { id: "01-hook-s1", image_prompt: "a figure in a heavy coat running through neon rain", motion: "crash_zoom_in", strength: 0.8, seconds: 3.2, still: "01-hook-s1.png" },
  { id: "01-hook-s2", image_prompt: "water spraying up from every step", motion: "track_alongside", strength: 0.6, seconds: 2.4, still: null },
  { id: "02-city-s1", image_prompt: "a vast rain-lashed city from above", motion: "crane_down", strength: 0.5, seconds: 7.5, still: "02-city-s1.png" },
];

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

/* ------------------------------------------------------------------ the decision */

test("footageBackendFor: off unless the switch says kie AND a key exists AND the film is under the cap", () => {
  const j = (s) => ({ params: JSON.stringify({ duration_s: s }) });
  assert.equal(m.footageBackendFor({}, j(15)), "local", "nothing configured");
  assert.equal(m.footageBackendFor({ KLEO_FOOTAGE_BACKEND: "kie" }, j(15)), "local", "switch without a key");
  assert.equal(m.footageBackendFor({ KLEO_FOOTAGE_BACKEND: "kie", KIE_API_KEY: "k" }, j(15)), "kie");
  assert.equal(m.footageBackendFor({ KLEO_FOOTAGE_BACKEND: "kie", KIE_API_KEY: "k" }, j(20)), "kie", "the cap is inclusive");
  assert.equal(m.footageBackendFor({ KLEO_FOOTAGE_BACKEND: "kie", KIE_API_KEY: "k" }, j(21)), "local", "over the 20 s test cap the local road stays");
  assert.equal(m.footageBackendFor({ KLEO_FOOTAGE_BACKEND: "kie", KIE_API_KEY: "k", KIE_MAX_VIDEO_S: "60" }, j(45)), "kie");
  assert.equal(m.footageBackendFor({ KLEO_FOOTAGE_BACKEND: "kie", KIE_API_KEY: "k", KIE_MAX_VIDEO_S: "0" }, j(300)), "kie", "0 removes the cap");
  assert.equal(m.footageBackendFor({ KIE_API_KEY: "k" }, j(15), { backend: "kie" }), "kie", "the admin override turns it on");
  assert.equal(m.footageBackendFor({ KLEO_FOOTAGE_BACKEND: "kie", KIE_API_KEY: "k" }, j(15), { backend: "local" }), "local", "and off");
  assert.equal(m.footageBackendFor({ KLEO_FOOTAGE_BACKEND: "kie", KIE_API_KEY: "k" }, { params: "not json" }), "kie", "unreadable params: the cap cannot say no");
});

test("kieModelFor: config, override, and an unknown name falls back to the default", () => {
  assert.equal(m.kieModelFor({}).name, "kling-3.0");
  assert.equal(m.kieModelFor({ KLEO_FOOTAGE_MODEL: "wan-2.7" }).name, "wan-2.7");
  assert.equal(m.kieModelFor({ KLEO_FOOTAGE_MODEL: "wan-2.7" }, { model: "seedance-2.0" }).name, "seedance-2.0");
  assert.equal(m.kieModelFor({ KLEO_FOOTAGE_MODEL: "does-not-exist" }).name, "kling-3.0");
  for (const [k, spec] of Object.entries(m.KIE_MODELS)) assert.ok(spec.model && spec.usdPerSecond > 0 && spec.note, k);
});

test("clipSecondsFor: the shortest length the model offers that covers the shot", () => {
  const kling = m.KIE_MODELS["kling-3.0"], veo = m.KIE_MODELS["veo-3.1"], wan = m.KIE_MODELS["wan-2.7"];
  assert.equal(m.clipSecondsFor(kling, 3.2), 4);
  assert.equal(m.clipSecondsFor(kling, 3.0), 3);
  assert.equal(m.clipSecondsFor(kling, 3.04), 3, "a hair over a whole second is that second");
  assert.equal(m.clipSecondsFor(kling, 1.0), 3, "under the floor: the floor");
  assert.equal(m.clipSecondsFor(kling, 40), 15, "over the ceiling: the ceiling (the box holds the rest)");
  assert.equal(m.clipSecondsFor(veo, 3.2), 4);
  assert.equal(m.clipSecondsFor(veo, 5), 6);
  assert.equal(m.clipSecondsFor(veo, 9), 8);
  assert.equal(m.clipSecondsFor(wan, 1.5), 2);
  assert.equal(m.clipCostUsd(kling, 4), 0.36);
});

/* ------------------------------------------------------------------ the words */

test("kiePrompt: subject first, then the camera in plain words, then the look; no negations, no double spaces", () => {
  const p = m.kiePrompt(SHOTS[0]);
  assert.ok(p.startsWith("a figure in a heavy coat running through neon rain. The camera rushes forward"), p);
  assert.ok(p.includes("Cinematic live-action film"));
  assert.ok(!/NOT /.test(p) && !/\s{2}/.test(p));
  assert.ok(m.kiePrompt({ image_prompt: "a compass on a table", motion: "unknown_move" }).includes("pushes slowly forward"), "an unknown move is a push-in");
  assert.ok(m.kiePrompt({ image_prompt: "a compass", motion: "static_hold", strength: 0.2 }).includes("Gentle, slow motion"));
});

test("kieInput speaks each model's dialect: Kling strings, Veo generation_type, Wan first frame + seed, Seedance audio off", () => {
  const p = { prompt: "x", imageUrl: "https://kleo.test/dl/j/img%2Fa.png?exp=1&sig=2", seconds: 3.2, format: "9:16", seed: 42 };
  const k = m.kieInput("kling-3.0", m.KIE_MODELS["kling-3.0"], p);
  assert.deepEqual(k, { prompt: "x", image_urls: [p.imageUrl], duration: "4", aspect_ratio: "9:16", mode: "pro", sound: false, multi_shots: false });
  assert.equal(m.kieInput("kling-3.0-std", m.KIE_MODELS["kling-3.0-std"], p).mode, "std");
  assert.equal(m.kieInput("kling-3.0-4k", m.KIE_MODELS["kling-3.0-4k"], p).mode, "4K");
  assert.equal(m.kieInput("kling-3.0", m.KIE_MODELS["kling-3.0"], { ...p, imageUrl: null }).image_urls, undefined, "no still: text-to-video, no empty array");
  const v = m.kieInput("veo-3.1", m.KIE_MODELS["veo-3.1"], p);
  assert.equal(v.generation_type, "FIRST_AND_LAST_FRAMES_2_VIDEO"); assert.equal(v.duration, 4); assert.equal(v.resolution, "1080p");
  assert.equal(m.kieInput("veo-3.1", m.KIE_MODELS["veo-3.1"], { ...p, imageUrl: null }).generation_type, "TEXT_2_VIDEO");
  const w = m.kieInput("wan-2.7", m.KIE_MODELS["wan-2.7"], p);
  assert.equal(w.first_frame_url, p.imageUrl); assert.equal(w.seed, 42); assert.equal(w.duration, 4); assert.ok(w.negative_prompt.includes("watermark"));
  const s = m.kieInput("seedance-2.0", m.KIE_MODELS["seedance-2.0"], p);
  assert.equal(s.first_frame_url, p.imageUrl); assert.equal(s.generate_audio, false); assert.equal(s.duration, 4); assert.equal(s.aspect_ratio, "9:16");
  assert.equal(m.seedFor("01-hook-s1"), m.seedFor("01-hook-s1")); assert.notEqual(m.seedFor("01-hook-s1"), m.seedFor("01-hook-s2"));
});

/* ------------------------------------------------------------------ the money and the rows */

test("requestFootage: one task per shot, priced at creation, the still as a signed link, and never twice", async () => {
  const env = await newEnv();
  const job = await filmJob(env);
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, look: "realistic", format: "9:16" });
  assert.equal(r.status, 200, JSON.stringify(r.reply));
  assert.equal(r.reply.ordered, 3);
  assert.deepEqual(r.reply.pending.sort(), ["01-hook-s1", "01-hook-s2", "02-city-s1"]);
  assert.equal(r.reply.model, "kling-3.0");
  assert.equal(kie.calls.create.length, 3);
  const first = kie.calls.create.find((c) => c.body.input.prompt.startsWith("a figure"));
  assert.equal(first.auth, "Bearer kie-test-key");
  assert.equal(first.body.model, "kling-3.0/video");
  assert.equal(first.body.input.duration, "4");
  assert.match(first.body.input.image_urls[0], /^http:\/\/kleo\.test\/dl\/gt_test1234\/img%2F01-hook-s1\.png\?exp=\d+&sig=[0-9a-f]{64}$/);
  const second = kie.calls.create.find((c) => c.body.input.prompt.startsWith("water"));
  assert.equal(second.body.input.image_urls, undefined, "a shot whose still did not upload is asked as text-to-video");
  const rows = await m.footageRows(env, job.id);
  assert.deepEqual(rows.map((x) => [x.shot_id, x.state, x.cost_usd, x.seconds]), [["01-hook-s1", "generating", 0.36, 3.2], ["01-hook-s2", "generating", 0.27, 2.4], ["02-city-s1", "generating", 0.72, 7.5]]);
  assert.equal(await m.footageSpentTodayUsd(env), 1.35);
  // Again: nothing new is ordered, the same answer comes back.
  const r2 = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r2.reply.ordered, 0);
  assert.equal(kie.calls.create.length, 3);
});

test("requestFootage refuses BEFORE ordering when today's ceiling would be crossed, and when the job is not on the kie road", async () => {
  const env = await newEnv({ DAILY_FOOTAGE_BUDGET_USD: "1.00" });
  const job = await filmJob(env);
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r.status, 402);
  assert.match(r.reply.error, /budget/);
  assert.equal(kie.calls.create.length, 0, "no task was created");
  assert.equal((await m.footageRows(env, job.id)).length, 0);
  const env2 = await newEnv({ KLEO_FOOTAGE_BACKEND: "local" });
  const job2 = await filmJob(env2);
  assert.equal((await m.requestFootage(env2, job2, "http://kleo.test", { shots: SHOTS, format: "9:16" })).status, 409);
  const env3 = await newEnv();
  const job3 = await filmJob(env3, 45); // over the 20 s cap
  assert.equal((await m.requestFootage(env3, job3, "http://kleo.test", { shots: SHOTS, format: "9:16" })).status, 409);
});

test("a task kie.ai refuses is a failed row that costs nothing; the others still go through", async () => {
  const env = await newEnv();
  const job = await filmJob(env);
  const kie = fakeKie({ createFails: true }); globalThis.fetch = kie.fetch;
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS.slice(0, 1), format: "9:16" });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.reply.failed), ["01-hook-s1"]);
  assert.match(r.reply.failed["01-hook-s1"], /402/);
  assert.equal(await m.footageSpentTodayUsd(env), 0, "a refused task is not money spent");
});

test("footageStatus: success is copied to R2 once and served to the box; fail is a failed row; transient errors keep polling", async () => {
  const env = await newEnv();
  const job = await filmJob(env);
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  // Nothing finished yet.
  let s = await m.footageStatus(env, job, true);
  assert.equal(kie.calls.record.length, 3);
  assert.deepEqual(s.reply.ready, []);
  // One succeeds, one fails, one is still generating.
  kie.calls.record.length = 0;
  const rows = await m.footageRows(env, job.id);
  const byShot = Object.fromEntries(rows.map((r) => [r.shot_id, r.task_id]));
  globalThis.fetch = fakeKie({ state: { [byShot["01-hook-s1"]]: "success", [byShot["01-hook-s2"]]: "fail" } }).fetch;
  s = await m.footageStatus(env, job, true);
  assert.deepEqual(s.reply.ready, ["01-hook-s1"]);
  assert.deepEqual(s.reply.pending, ["02-city-s1"]);
  assert.match(s.reply.failed["01-hook-s2"], /content policy/);
  assert.ok(env.RENDERS.m.has("renders/gt_test1234/clips/01-hook-s1.mp4"), "the clip is on R2 under the job");
  // The box fetches it through the internal route with the job secret; a pending one is 404.
  const get = (path) => m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}/${path}`, { headers: { authorization: "Bearer wsecret" } }), env);
  const clip = await get("clips/01-hook-s1");
  assert.equal(clip.status, 200);
  assert.equal(clip.headers.get("content-type"), "video/mp4");
  assert.equal((await clip.arrayBuffer()).byteLength, 4096);
  assert.equal((await get("clips/02-city-s1")).status, 404);
  // A second poll does not download the finished clip again.
  const again = fakeKie({ state: { [byShot["01-hook-s1"]]: "success" } }); globalThis.fetch = again.fetch;
  await m.footageStatus(env, job, true);
  assert.equal(again.calls.downloads, 0, "ready rows are not asked about again");
  assert.deepEqual(again.calls.record, [byShot["02-city-s1"]], "only the generating one is polled");
  // A network failure leaves the row generating for the next poll.
  globalThis.fetch = async () => { throw new Error("ECONNRESET"); };
  s = await m.footageStatus(env, job, true);
  assert.deepEqual(s.reply.pending, ["02-city-s1"]);
  // The worker's own view through the route.
  const view = await (await get("footage")).json();
  assert.deepEqual(view.ready, ["01-hook-s1"]);
  assert.equal(view.cost_usd, 1.35);
});

test("PUT stills: the reference frame lands under the img/ name the download route signs; junk is refused", async () => {
  const env = await newEnv();
  const job = await filmJob(env);
  const put = (name, body) => m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}/stills/${name}`, { method: "PUT", headers: { authorization: "Bearer wsecret" }, body }), env);
  const png = new Uint8Array(200); png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const r = await put("01-hook-s1.png", png);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, name: "01-hook-s1.png", size: 200 });
  assert.ok(env.RENDERS.m.has("renders/gt_test1234/img/01-hook-s1.png"));
  assert.ok((await m.listFiles(env, job.id)).some((f) => f.name === "img/01-hook-s1.png"), "listed like a server-drawn picture, so dl.ts serves it");
  assert.equal((await put("01-hook-s1.png", new Uint8Array(10))).status, 400, "too small to be a picture");
  assert.equal((await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}/stills/01-hook-s1.png`, { method: "PUT", headers: { authorization: "Bearer wrong" }, body: png }), env)).status, 401);
  assert.equal((await put("../evil.png", png)).status, 404, "not a still name: falls through to not found");
});

test("the job spec tells the box which road and which model; the admin route switches both without a deploy", async () => {
  const env = await newEnv();
  const job = await filmJob(env);
  const spec = await (await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}`, { headers: { authorization: "Bearer wsecret" } }), env)).json();
  assert.deepEqual(spec.footage, { backend: "kie", model: "kling-3.0" });
  const admin = (method, body) => m.handleAdmin(new Request("http://kleo.test/internal/admin/footage", { method, headers: { authorization: "Bearer s3cret" }, body: body && JSON.stringify(body) }), env);
  let v = await (await admin("GET")).json();
  assert.equal(v.backend, "kie"); assert.equal(v.key_configured, true); assert.equal(v.max_video_s, 20); assert.equal(v.budget_usd, 5); assert.ok(v.models["wan-2.7"]);
  v = await (await admin("POST", { model: "seedance-2.0" })).json();
  assert.equal(v.model, "seedance-2.0");
  assert.equal((await (await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}`, { headers: { authorization: "Bearer wsecret" } }), env)).json()).footage.model, "seedance-2.0");
  assert.equal((await admin("POST", { model: "nope" })).status, 400);
  v = await (await admin("POST", { backend: "local" })).json();
  assert.equal(v.backend, "local"); assert.equal(v.model, "seedance-2.0", "the model survives a backend switch");
  v = await (await admin("POST", { reset: true })).json();
  assert.equal(v.backend, "kie"); assert.equal(v.model, "kling-3.0"); assert.equal(v.override, null);
  assert.equal((await m.handleAdmin(new Request("http://kleo.test/internal/admin/footage", { headers: { authorization: "Bearer wrong" } }), env)).status, 401);
});
