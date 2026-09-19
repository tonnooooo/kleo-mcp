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
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"], // the planner on Claude (20 September) loads the SDK only when called, which no test here does
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
      if (script.createFails) return new Response(JSON.stringify({ code: 422, msg: "first_frame_url: unreachable" }), { status: 200 });
      // The real answer of 13 September 2026 once the account is empty: code 500, not the documented 402.
      if (typeof script.createNoCreditAfter === "number" && n >= script.createNoCreditAfter) return new Response(JSON.stringify({ code: 500, msg: "Credits insufficient : Your current balance isn’t enough to run this request. Please top up to continue." }), { status: 200 });
      return new Response(JSON.stringify({ code: 200, msg: "success", data: { taskId: `task_${++n}` } }), { status: 200 });
    }
    if (u.endsWith("/api/v1/chat/credit")) { calls.credit = (calls.credit ?? 0) + 1; return new Response(JSON.stringify({ code: 200, msg: "success", data: script.credits ?? 100000 }), { status: 200 }); }
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
async function filmJob(env, seconds = 18, paid = true) {
  await m.createUser(env, { id: "u1", email: "u1@example.com", credits: 100, inviteCode: null });
  // A paying customer (15 September: a film's clips are bought only for accounts with a payment on record).
  if (paid) await env.DB.prepare("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('cs_test_u1', 'u1', 10, 500, 'eur', 'paid', 'test')").run();
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
  assert.equal(m.kieModelFor({}).name, "minimax-h3", "the default is MiniMax H3 2K since 13 September");
  assert.equal(m.kieModelFor({ KLEO_FOOTAGE_MODEL: "wan-2.7" }).name, "wan-2.7");
  assert.equal(m.kieModelFor({ KLEO_FOOTAGE_MODEL: "wan-2.7" }, { model: "seedance-2.0" }).name, "seedance-2.0");
  assert.equal(m.kieModelFor({ KLEO_FOOTAGE_MODEL: "does-not-exist" }).name, "minimax-h3");
  for (const [k, spec] of Object.entries(m.KIE_MODELS)) assert.ok(spec.model && spec.usdPerSecond > 0 && spec.note, k);
});

test("the price table is the real kie.ai list of 13 September 2026, not the summer guesses", () => {
  const usd = (k) => m.KIE_MODELS[k].usdPerSecond;
  assert.equal(usd("minimax-h3"), 0.065); assert.equal(usd("kling-3.0"), 0.09); assert.equal(usd("kling-3.0-std"), 0.07);
  assert.equal(usd("kling-3.0-4k"), 0.335, "was guessed at 0.18"); assert.equal(usd("kling-v3-turbo"), 0.1125, "was guessed at 0.05");
  assert.equal(usd("wan-2.7"), 0.12, "was guessed at 0.05"); assert.equal(usd("seedance-2.0"), 0.51, "was guessed at 0.08");
  for (const [k, spec] of Object.entries(m.KIE_MODELS)) {
    if (!spec.usdPerClip) continue;
    assert.ok(Array.isArray(spec.seconds), `${k}: a per-clip model lists its clip lengths`);
    for (const d of spec.seconds) assert.ok(spec.usdPerClip[d] > 0, `${k}: a price for a ${d} s clip`);
    assert.equal(spec.usdPerSecond, Math.round(Math.max(...spec.seconds.map((d) => spec.usdPerClip[d] / d)) * 1e5) / 1e5, `${k}: usdPerSecond is the dearest per-second equivalent`);
  }
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
  const mm = m.KIE_MODELS["minimax-h3"], gem = m.KIE_MODELS["gemini-omni-flash"];
  assert.equal(m.clipSecondsFor(mm, 3.2), 4, "MiniMax starts at 4 s"); assert.equal(m.clipCostUsd(mm, 4), 0.26);
  assert.equal(m.clipSecondsFor(gem, 9), 10); assert.equal(m.clipCostUsd(gem, 4), 0.315, "per clip, not per second"); assert.equal(m.clipCostUsd(gem, 10), 0.63);
  assert.equal(m.clipCostUsd(gem, 7), 0.63, "a length the clip table does not list is charged at the dearest clip");
  assert.equal(m.clipCostUsd(veo, 8), 1.275, "Veo counts the Quality tier until the route is exercised");
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
  const mm = m.kieInput("minimax-h3", m.KIE_MODELS["minimax-h3"], p);
  assert.deepEqual(mm, { prompt: "x", first_frame_url: p.imageUrl, duration: 4, resolution: "2K" }, "MiniMax: integer duration, 2K, no aspect ratio (the frame decides), no audio field");
  assert.equal(m.kieInput("minimax-h3-768p", m.KIE_MODELS["minimax-h3-768p"], p).resolution, "768P");
  assert.equal(m.kieInput("minimax-h3", m.KIE_MODELS["minimax-h3"], { ...p, imageUrl: null }).first_frame_url, undefined, "no still: no frame field, kie.ai refuses, the shot fails honestly");
  const g = m.kieInput("gemini-omni-flash", m.KIE_MODELS["gemini-omni-flash"], p);
  assert.deepEqual(g, { prompt: "x", first_frame_url: p.imageUrl, duration: 4, resolution: "1080p", aspect_ratio: "9:16" });
  assert.equal(m.kieInput("gemini-omni-flash-4k", m.KIE_MODELS["gemini-omni-flash-4k"], { ...p, seconds: 9 }).resolution, "4k");
  assert.equal(m.seedFor("01-hook-s1"), m.seedFor("01-hook-s1")); assert.notEqual(m.seedFor("01-hook-s1"), m.seedFor("01-hook-s2"));
});

/* ------------------------------------------------------------------ the money and the rows */

test("requestFootage: one task per shot, priced at creation, the still as a signed link, and never twice", async () => {
  const env = await newEnv({ KLEO_FOOTAGE_MODEL: "kling-3.0" }); // Kling's dialect (string duration, image_urls) is what this test reads
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
  const env = await newEnv({ DAILY_FOOTAGE_BUDGET_USD: "1.00", KLEO_FOOTAGE_MODEL: "kling-3.0" });
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
  assert.match(r.reply.failed["01-hook-s1"], /422/);
  assert.equal(await m.footageSpentTodayUsd(env), 0, "a refused task is not money spent");
});

test("kie.ai out of money: the film stops at the first refusal, the route fails the job with the sentence and refunds, a top-up re-orders the refused shots", async () => {
  // 1. Halfway through: the first task goes in, the second is refused → no third call, 402 with the sentence.
  const env = await newEnv();
  const job = await filmJob(env);
  const kie = fakeKie({ createNoCreditAfter: 1 }); globalThis.fetch = kie.fetch;
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r.status, 402);
  assert.equal(r.reply.no_credit, true);
  assert.match(r.reply.error, /kie\.ai balance is empty: 1 of 3 shots/);
  assert.equal(kie.calls.create.length, 2, "the third shot was never asked for");
  let rows = await m.footageRows(env, job.id);
  assert.deepEqual(rows.map((x) => [x.shot_id, x.state, !!x.task_id]), [["01-hook-s1", "generating", true], ["01-hook-s2", "failed", false]], "the refused row has no task; the third has no row");
  assert.ok(m.isNoCredit(new m.KieError("kie.ai POST x → code 500: Credits insufficient : Your current balance isn’t enough", 500, true)));
  assert.ok(m.isNoCredit(new m.KieError("kie.ai POST x → code 402: insufficient credits", 402, false)));
  assert.ok(!m.isNoCredit(new m.KieError("kie.ai POST x → code 422: bad input", 422, false)));
  // 2. The account is topped up: the same request orders exactly the two shots that were never billed.
  const again = fakeKie(); globalThis.fetch = again.fetch;
  const r2 = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r2.status, 200);
  assert.equal(r2.reply.ordered, 2);
  assert.deepEqual(again.calls.create.map((c) => c.body.input.first_frame_url ? "still" : "text").length, 2);
  rows = await m.footageRows(env, job.id);
  assert.deepEqual(rows.map((x) => x.state), ["generating", "generating", "generating"]);
  assert.equal(rows.find((x) => x.shot_id === "01-hook-s2").error, null, "the old refusal is gone from the row");
  assert.equal(await m.footageSpentTodayUsd(env), 1.04, "4 s + 4 s + 8 s of MiniMax H3 at 0.065 $/s, each clip priced once");
  // 3. Through the worker's route: the job is failed on the spot with the sentence and the credits come back.
  const env2 = await newEnv();
  const job2 = await filmJob(env2);
  globalThis.fetch = fakeKie({ createNoCreditAfter: 0 }).fetch;
  const res = await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job2.id}/footage`, { method: "POST", headers: { authorization: "Bearer wsecret", "content-type": "application/json" }, body: JSON.stringify({ shots: SHOTS, format: "9:16" }) }), env2);
  assert.equal(res.status, 402);
  const after = env2.DB.db.prepare("SELECT state, error FROM jobs WHERE id = ?").get(job2.id);
  assert.equal(after.state, "failed");
  assert.match(after.error, /kie\.ai balance is empty: 0 of 3 shots/);
  assert.equal(env2.DB.db.prepare("SELECT credits FROM users WHERE id = 'u1'").get().credits, 107, "the 7 credits of the film are back");
});

test("the balance is read before the first task: an account that cannot pay the film orders nothing", async () => {
  const env = await newEnv();
  const job = await filmJob(env);
  const kie = fakeKie({ credits: 100 }); globalThis.fetch = kie.fetch; // 100 credits = 0.50 $, the film needs 1.04 $
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r.status, 402);
  assert.equal(r.reply.no_credit, true);
  assert.equal(r.reply.balance_usd, 0.5);
  assert.equal(kie.calls.create.length, 0, "no task, no money");
  assert.equal((await m.footageRows(env, job.id)).length, 0);
  // kie.ai not answering the balance call is not a refusal: the order goes through and createTask decides.
  const mute = fakeKie(); const inner = mute.fetch;
  globalThis.fetch = async (u, i) => { if (String(u).endsWith("/api/v1/chat/credit")) throw new Error("ECONNRESET"); return inner(u, i); };
  assert.equal((await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" })).status, 200);
  assert.equal(mute.calls.create.length, 3);
});

test("an animatic orders no clip whatever the box asks: the route answers 409 and kie.ai is never called (15 September)", async () => {
  const env = await newEnv({ KIE_MAX_VIDEO_S: "0" });
  const job = await filmJob(env, 30);
  job.params = JSON.stringify({ ...JSON.parse(job.params), product: "animatic" });
  await env.DB.prepare("UPDATE jobs SET params = ? WHERE id = ?").bind(job.params, job.id).run();
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r.status, 409);
  assert.match(r.reply.error, /animatic/);
  assert.equal(kie.calls.create.length, 0);
  assert.equal(kie.calls.credit ?? 0, 0, "not even the balance is read");
  assert.equal((await m.footageRows(env, job.id)).length, 0);
});

test("a film whose account never paid orders no clip on the box road either: 402 with the sentence, before the balance is read", async () => {
  // A job queued before the rule of 15 September, or reaching the box by any other road, meets the rule here.
  const env = await newEnv({ KIE_MAX_VIDEO_S: "0" });
  const job = await filmJob(env, 18, false);
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r.status, 402);
  assert.equal(r.reply.unpaid, true);
  assert.match(r.reply.error, /bought a credit pack[\s\S]*credits are refunded[\s\S]*animatic/);
  assert.equal(kie.calls.create.length, 0);
  assert.equal(kie.calls.credit ?? 0, 0);
  assert.equal((await m.footageRows(env, job.id)).length, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'footage.unpaid'").first()).n, 1);
});

test("the pre-flight prices a film before any card is rented: the storyboard's shots when there is one, the planner's density when not; silence never refuses", async () => {
  // 15 September, four films in a row: card rented, frames drawn, script voiced, then "kie.ai balance is empty" at
  // 0.07 $. The three audit rows all said planned 3.90 $ for ten 6-second clips on MiniMax H3 2K — this is that number.
  const env = await newEnv({ KIE_MAX_VIDEO_S: "0", KLEO_FOOTAGE_MODEL: "minimax-h3" });
  const ten = m.plannedFilmUsd(env, null, 60, 10, 24);
  assert.deepEqual(ten, { usd: Math.round(3.9 * m.PREFLIGHT_MARGIN * 1000) / 1000, shots: 10, model: "minimax-h3" }, "10 shots of 6 s at 0.065 $/s = 3.90 $ on the box, kept on the upper side by the margin");
  assert.equal(m.PREFLIGHT_MARGIN, 1.25);
  const guess = m.plannedFilmUsd(env, null, 60, null, 24);
  assert.equal(guess.shots, 24, "no storyboard: the Short density, capped by the storyboard");
  assert.equal(m.plannedFilmUsd(env, null, 15, null, 24).shots, 6, "never fewer than six");
  assert.equal(m.plannedFilmUsd(env, null, 300, null, 48).shots, 48, "never more than the storyboard cap");
  // an upper bound: never under the films the audit recorded (30 s Short = 15 × 4 s = 3.90 $; 15 s = 1.885 $; 60 s = 3.90 $)
  assert.ok(m.plannedFilmUsd(env, null, 30, null, 24).usd >= 3.9, "a 30 s Short is not under-estimated");
  assert.ok(m.plannedFilmUsd(env, null, 15, null, 24).usd >= 1.885, "nor a 15 s one");
  assert.ok(m.plannedFilmUsd(env, null, 60, null, 24).usd >= 3.9, "nor a 60 s film");
  const empty = fakeKie({ credits: 14 }); globalThis.fetch = empty.fetch; // 14 credits = 0.07 $, the balance of that morning
  const pre = await m.kiePreflight(env, 60, 10, 24);
  assert.deepEqual(pre, { ok: false, reason: "balance", balance_usd: 0.07, planned_usd: 4.875, spent_today_usd: 0, budget_usd: 5, shots: 10, model: "minimax-h3" });
  const rich = fakeKie({ credits: 1000 }); globalThis.fetch = rich.fetch; // 5 $
  assert.equal((await m.kiePreflight(env, 60, 10, 24)).ok, true);
  // today's ceiling is the first gate, and it needs no call to kie.ai
  const tight = { ...env, DAILY_FOOTAGE_BUDGET_USD: "4" };
  const overBudget = await m.kiePreflight(tight, 60, 10, 24);
  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.reason, "budget");
  assert.equal(overBudget.balance_usd, null, "the balance was not even read");
  globalThis.fetch = async (u, i) => { if (String(u).endsWith("/api/v1/chat/credit")) throw new Error("ECONNRESET"); return rich.fetch(u, i); };
  const mute = await m.kiePreflight(env, 60, 10, 24);
  assert.equal(mute.ok, true, "kie.ai not answering is not a refusal");
  assert.equal(mute.balance_usd, null);
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
  assert.equal(view.cost_usd, 1.04, "the default model, MiniMax H3: 4 s + 4 s (floor) + 8 s at 0.065 $/s");
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
  assert.deepEqual(spec.footage, { backend: "kie", model: "minimax-h3" }, "the default of the file is MiniMax H3");
  const admin = (method, body) => m.handleAdmin(new Request("http://kleo.test/internal/admin/footage", { method, headers: { authorization: "Bearer s3cret" }, body: body && JSON.stringify(body) }), env);
  globalThis.fetch = fakeKie({ credits: 2000 }).fetch;
  let v = await (await admin("GET")).json();
  assert.equal(v.backend, "kie"); assert.equal(v.key_configured, true); assert.equal(v.max_video_s, 20); assert.equal(v.budget_usd, 5); assert.ok(v.models["wan-2.7"]);
  assert.equal(v.balance_usd, 10, "2000 kie.ai credits at 0.005 $ each");
  assert.equal(v.model, "minimax-h3"); assert.deepEqual(v.models["gemini-omni-flash"].usd_per_clip, { 4: 0.315, 6: 0.42, 8: 0.525, 10: 0.63 }, "per-clip prices are shown to the admin");
  v = await (await admin("POST", { model: "seedance-2.0" })).json();
  assert.equal(v.model, "seedance-2.0");
  assert.equal((await (await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}`, { headers: { authorization: "Bearer wsecret" } }), env)).json()).footage.model, "seedance-2.0");
  assert.equal((await admin("POST", { model: "nope" })).status, 400);
  v = await (await admin("POST", { backend: "local" })).json();
  assert.equal(v.backend, "local"); assert.equal(v.model, "seedance-2.0", "the model survives a backend switch");
  v = await (await admin("POST", { reset: true })).json();
  assert.equal(v.backend, "kie"); assert.equal(v.model, "minimax-h3"); assert.equal(v.override, null);
  assert.equal((await m.handleAdmin(new Request("http://kleo.test/internal/admin/footage", { headers: { authorization: "Bearer wrong" } }), env)).status, 401);
});

test("kiePrompt: the animated film asks the clip model for drawn motion, never for 35mm photography (14 September)", () => {
  const real = m.kiePrompt(SHOTS[0]), anim = m.kiePrompt(SHOTS[0], "animation");
  assert.ok(real.endsWith(m.KIE_LOOKS.realistic) && real.includes("35mm"));
  assert.ok(anim.endsWith(m.KIE_LOOKS.animation), anim);
  assert.ok(!anim.includes("35mm") && !anim.includes("live-action"), "the animation look carries no photography");
  assert.match(anim, /^.+\. .+\. .*2D animated feature film/, "subject, camera, then the look — same order as the realistic one");
  assert.equal(m.filmLookOf("animation"), "animation"); assert.equal(m.filmLookOf("cartoon"), "realistic"); assert.equal(m.filmLookOf(undefined), "realistic");
  assert.match(m.KIE_NEGATIVES.animation, /photograph/); assert.ok(!/anime|cartoon|drawing/.test(m.KIE_NEGATIVES.animation));
  assert.equal(m.KIE_NEGATIVES.realistic, m.KIE_NEGATIVE);
});
