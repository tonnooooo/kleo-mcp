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
      // Suno's answer (measured 22 September 2026): resultJson is {"code":200,"data":[{"audio_url":…},{…}]}, two tracks.
      const resultJson = state !== "success" ? "" : script.suno
        ? JSON.stringify({ code: 200, msg: "success", data: [{ audio_url: `https://cdn.kie.test/${taskId}-a.mp3`, duration: 38.4, title: "t" }, { audio_url: `https://cdn.kie.test/${taskId}-b.mp3`, duration: 38.4, title: "t" }], task_id: taskId })
        : JSON.stringify({ resultUrls: [`https://cdn.kie.test/${taskId}.mp4`] });
      const data = { taskId, state, resultJson, failCode: state === "fail" ? "500" : "", failMsg: state === "fail" ? "content policy" : "" };
      return new Response(JSON.stringify({ code: 200, msg: "success", data }), { status: 200 });
    }
    if (u.startsWith("https://cdn.kie.test/")) {
      calls.downloads++;
      if (u.endsWith(".mp3")) { const mp3 = new Uint8Array(6000); mp3.set([0x49, 0x44, 0x33], 0); return new Response(mp3, { status: 200, headers: { "content-length": String(mp3.length) } }); }   // "ID3"
      return new Response(mp4, { status: 200, headers: { "content-length": String(mp4.length) } });
    }
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
  // A gentle shot asks for a steady camera. It used to say "Gentle, slow motion of the camera", and a video model reads
  // "slow motion" as slow-mo (the fidelity review of 24 September 2026): the words now say what they mean.
  const gentle = m.kiePrompt({ image_prompt: "a compass", motion: "static_hold", strength: 0.2 });
  assert.ok(gentle.includes("The camera moves slowly and steadily.")); assert.ok(!/slow motion/i.test(gentle));
});

test("clipPrompt: the clip is asked from the STORED shot — what moves first, then the characters' full looks, the place, the camera, the look (24 September)", async () => {
  const spec = {
    v: 1, mode: "faithful", summary: "Mara decorates a cake at dawn.",
    cast: [{ id: "c1", name: "Mara", look: "a thin woman with short blonde hair tied up", ref: null }],
    items: [
      { id: "R1", kind: "look", text: "Mara wears a lilac apron", quote: "grembiule lilla", must: true, who: "c1", order: null },
      { id: "R2", kind: "text", text: "a shop sign reading \"Forno Mara\"", quote: "insegna Forno Mara", must: true, who: null, order: null },
    ],
    refs: [], open: [], narration: "free", script: null,
  };
  const sb = {
    style: "picture", kleo_style: "realistic", direction: { subject: "cake", world: "A village bakery at dawn", cast: [{ name: "Mara", look: "a blonde woman" }], objects: [], forbidden: [], sections: [] },
    scenes: [{ id: "01-hook", kind: "cinema", voice: "a line", shots: [
      { image_prompt: "Mara at the counter with a cake", action: "Mara lifts the piping bag and draws a slow spiral of cream", cast: ["c1"], covers: ["R1"] },
      { image_prompt: "The bakery sign above the door", covers: ["R2"] },
    ] }],
  };
  const stored = { storyboard: sb, spec };
  const p = m.clipPrompt({ id: "01-hook-s1", image_prompt: "ignored when the stored shot exists", motion: "push_in", strength: 0.2 }, "realistic", stored);
  assert.ok(p.startsWith("Mara lifts the piping bag and draws a slow spiral of cream. Mara: a thin woman with short blonde hair tied up; Mara wears a lilac apron. Setting: A village bakery at dawn. The camera pushes slowly forward"), p);
  assert.ok(p.includes("The camera moves slowly and steadily.")); assert.ok(p.endsWith(m.KIE_LOOKS.realistic));
  const sign = m.clipPrompt({ id: "01-hook-s2", image_prompt: "x", motion: "static_hold" }, "realistic", stored);
  assert.ok(sign.startsWith("The bakery sign above the door."), "no action: the image prompt");
  assert.ok(!/No text/.test(sign), "a shot that carries the user's sign is not told to show no text");
  assert.equal(m.clipPrompt({ id: "09-nope-s1", image_prompt: "a compass", motion: "push_in" }, "realistic", stored), m.kiePrompt({ image_prompt: "a compass", motion: "push_in" }), "a shot the server never planned keeps the old prompt");
  assert.equal(m.clipPrompt(SHOTS[0], "realistic", null), m.kiePrompt(SHOTS[0]));
  // Through the order itself: a job with a stored storyboard sends the composed prompt to kie.ai.
  const env = await newEnv();
  const job = await filmJob(env);
  job.storyboard = JSON.stringify(sb);
  job.params = JSON.stringify({ ...JSON.parse(job.params), spec });
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: [{ id: "01-hook-s1", image_prompt: "Mara at the counter with a cake", motion: "push_in", strength: 0.5, seconds: 3, still: "01-hook-s1.png" }], format: "9:16" });
  assert.equal(r.status, 200, JSON.stringify(r.reply));
  assert.ok(kie.calls.create[0].body.input.prompt.startsWith("Mara lifts the piping bag"), kie.calls.create[0].body.input.prompt);
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
  // 25 September 2026: with the stills on Nano Banana Pro (kie.ai) the same balance buys the pictures first, so the
  // pre-flight asks for both: 10 stills + 3 sheets at 0.09 $, times 1.3 for the redraws = 1.521 $ on top of 4.875 $.
  assert.equal(m.plannedStillsUsd({}, 10), 0, "klein on Workers AI costs kie.ai nothing");
  assert.equal(m.plannedStillsUsd({ STILL_MODEL: "kie:nano-banana-pro" }, 10), 1.521);
  globalThis.fetch = rich.fetch; // 5 $: enough for the clips alone, not for clips and pictures
  const both = await m.kiePreflight({ ...env, STILL_MODEL: "kie:nano-banana-pro" }, 60, 10, 24);
  assert.equal(both.ok, false); assert.equal(both.reason, "balance"); assert.equal(both.stills_usd, 1.521); assert.equal(both.planned_usd, 4.875);
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

/* ------------------------------------------------------------------ the user's music (22 September) */

test("requestMusic: one Suno task on the same road, $0.06 on the day's ceiling, instrumental in custom mode; then the track lands in R2 and the box streams it", async () => {
  const env = await newEnv();
  const job = await filmJob(env);
  const kie = fakeKie({ defaultState: "success" }); globalThis.fetch = kie.fetch;
  const r = await m.requestMusic(env, job, { brief: "sparse felt piano over a low pad, 60 bpm, patient", seconds: 39.4, title: "The Birth of a Brilliant Idea" });
  assert.equal(r.status, 200, JSON.stringify(r.reply));
  assert.equal(r.reply.state, "generating"); assert.equal(r.reply.cost_usd, 0.06); assert.equal(r.reply.model, "suno-v6");
  assert.equal(kie.calls.create.length, 1);
  const body = kie.calls.create[0].body;
  assert.equal(body.model, "ai-music-api/generate");
  assert.equal(body.input.instrumental, true); assert.equal(body.input.custom_mode, true); assert.equal(body.input.model, "V6", "duration is accepted only with V5_5 or a V6 (measured 22 September)");
  assert.match(body.input.style, /^sparse felt piano over a low pad, 60 bpm, patient\. Instrumental score for a narrated short film: no vocals/);
  assert.equal(body.input.title, "The Birth of a Brilliant Idea"); assert.equal(body.input.duration, 47, "the film's length plus a tail to cut on");
  assert.match(body.input.negative_tags, /vocals/);
  // Never twice: a second request while the first is in flight orders nothing.
  const again = await m.requestMusic(env, job, { brief: "anything", seconds: 39.4 });
  assert.equal(again.status, 200); assert.equal(kie.calls.create.length, 1);
  // The row is a footage row for the money and invisible to the clip lists the box reads.
  const rows = await m.footageRows(env, job.id);
  assert.deepEqual(rows.map((x) => x.shot_id), ["music"]); assert.equal(rows[0].cost_usd, 0.06);
  assert.equal(Math.round((await m.footageSpentTodayUsd(env)) * 100) / 100, 0.06, "counted the moment it is committed");
  const clips = await m.footageStatus(env, job, false);
  assert.deepEqual(clips.reply.pending, []); assert.deepEqual(clips.reply.clips, {}, "the track is not a clip");
  // The poll: success → the file is copied to R2 once, and the box is given its own route, never kie.ai's URL.
  const st = await m.musicStatus(env, job, true);
  assert.equal(st.reply.state, "ready"); assert.equal(st.reply.url, `/internal/jobs/${job.id}/music/file`);
  assert.equal(kie.calls.downloads, 1);
  assert.ok(env.RENDERS.m.has(`renders/${job.id}/music.mp3`));
  const file = await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}/music/file`, { headers: { authorization: "Bearer wsecret" } }), env);
  assert.equal(file.status, 200); assert.equal((await file.arrayBuffer()).byteLength, 4096);
  const spec = await (await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}`, { headers: { authorization: "Bearer wsecret" } }), env)).json();
  assert.deepEqual(spec.music, { available: true }, "the job spec says the road is open");
  const events = (await env.DB.prepare("SELECT event FROM audit WHERE job_id = ? ORDER BY id").bind(job.id).all()).results.map((x) => x.event);
  assert.deepEqual(events.filter((e) => e.startsWith("music.")), ["music.task", "music.ready"]);
});

test("music refusals are soft and cost nothing: no key → 409, the ceiling or an empty account → 402, a failed task → failed; the film goes on without it", async () => {
  const off = await newEnv({ KIE_API_KEY: undefined });
  const j0 = await filmJob(off);
  assert.equal((await m.requestMusic(off, j0, { brief: "x", seconds: 30 })).status, 409);
  assert.equal(m.musicOn({ KIE_API_KEY: "k", KLEO_MUSIC: "off" }), false); assert.equal(m.musicOn({ KIE_API_KEY: "k" }), true);
  const route = await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${j0.id}/music`, { method: "POST", headers: { authorization: "Bearer wsecret", "content-type": "application/json" }, body: JSON.stringify({ brief: "x", seconds: 30 }) }), off);
  assert.equal(route.status, 409); assert.equal((await route.json()).state, "off");
  assert.equal((await m.getJob(off, j0.id)).state, "rendering", "the route never fails the job for its music");
  const tight = await newEnv({ DAILY_FOOTAGE_BUDGET_USD: "0.05" });
  const j1 = await filmJob(tight);
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  const r = await m.requestMusic(tight, j1, { brief: "x", seconds: 30 });
  assert.equal(r.status, 402); assert.match(String(r.reply.error), /budget is spent/); assert.equal(kie.calls.create.length, 0);
  assert.deepEqual(await m.footageRows(tight, j1.id), [], "refused before a row exists");
  const poor = await newEnv();
  const j2 = await filmJob(poor);
  const empty = fakeKie({ credits: 2 }); globalThis.fetch = empty.fetch;   // 2 kie credits = $0.01
  const p = await m.requestMusic(poor, j2, { brief: "x", seconds: 30 });
  assert.equal(p.status, 402); assert.equal(p.reply.no_credit, true); assert.equal(empty.calls.create.length, 0);
  const env = await newEnv();
  const j3 = await filmJob(env);
  const failing = fakeKie({ defaultState: "fail" }); globalThis.fetch = failing.fetch;
  assert.equal((await m.requestMusic(env, j3, { brief: "x", seconds: 30 })).reply.state, "generating");
  const st = await m.musicStatus(env, j3, true);
  assert.equal(st.reply.state, "failed"); assert.match(st.reply.error, /content policy/);
  assert.equal((await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${j3.id}/music/file`, { headers: { authorization: "Bearer wsecret" } }), env)).status, 404);
  const none = await newEnv();
  assert.equal((await m.musicStatus(none, await filmJob(none), true)).status, 404, "no track ordered: none");
});

test("the real Suno answer shape: two tracks under data[].audio_url, the first is the film's, as an mp3", async () => {
  const env = await newEnv();
  const job = await filmJob(env);
  const kie = fakeKie({ defaultState: "success", suno: true }); globalThis.fetch = kie.fetch;
  await m.requestMusic(env, job, { brief: "warm strings", seconds: 30 });
  const st = await m.musicStatus(env, job, true);
  assert.equal(st.reply.state, "ready", JSON.stringify(st.reply));
  assert.equal(kie.calls.downloads, 1, "one track downloaded, the first");
  const stored = env.RENDERS.m.get(`renders/${job.id}/music.mp3`);
  assert.equal(stored.type, "audio/mpeg"); assert.equal(stored.buf.byteLength, 6000);
  assert.deepEqual(m.audioUrls({ resultJson: JSON.stringify({ code: 200, data: [{ audio_url: "https://x/a.mp3" }, { audio_url: "https://x/b.mp3" }] }) }), ["https://x/a.mp3", "https://x/b.mp3"]);
  assert.deepEqual(m.audioUrls({ resultJson: JSON.stringify({ resultUrls: ["https://x/c.mp4"] }) }), ["https://x/c.mp4"], "the clips' shape still reads");
  assert.deepEqual(m.audioUrls({ resultJson: "" }), []);
});

test("musicNote: a film ordered with music and delivered without it says so; one with the track, or none asked, says nothing", async () => {
  const env = await newEnv();
  const job = await filmJob(env);
  const asked = { ...job, params: JSON.stringify({ ...JSON.parse(job.params), music: "sparse piano" }) };
  assert.equal(await m.musicNote(env, job), null, "no music asked");
  assert.match(await m.musicNote(env, asked), /NOT on this video \(the track could not be ordered/, "asked, never ordered (an empty kie.ai account refuses before a row exists)");
  const kie = fakeKie({ defaultState: "fail" }); globalThis.fetch = kie.fetch;
  await m.requestMusic(env, job, { brief: "x", seconds: 30 }); await m.musicStatus(env, job, true);
  assert.match(await m.musicNote(env, asked), /NOT on this video: 500 content policy/, "a failed task, with kie.ai's reason");
  const env2 = await newEnv(); const job2 = await filmJob(env2);
  const ok = fakeKie({ defaultState: "success", suno: true }); globalThis.fetch = ok.fetch;
  await m.requestMusic(env2, job2, { brief: "x", seconds: 30 }); await m.musicStatus(env2, job2, true);
  assert.equal(await m.musicNote(env2, { ...job2, params: JSON.stringify({ ...JSON.parse(job2.params), music: "x" }) }), null, "the track is on the film: nothing to say");
});

test("Wan road: a shot that carries the user's sign is not told by the NEGATIVE prompt to erase it (24 September)", () => {
  // clipPrompt drops "No text" from the positive prompt of a shot that covers a text item; kieInput used to send the
  // whole KIE_NEGATIVES on Wan anyway — "text, letters, … subtitles" — so the sign the still was drawn with dissolved.
  const spec = {
    v: 1, mode: "faithful", summary: "A bakery at dawn.", cast: [],
    items: [{ id: "R2", kind: "text", text: "a shop sign reading \"Forno Mara\"", quote: "insegna Forno Mara", must: true, who: null, order: null }],
    refs: [], open: [], narration: "free", script: null,
  };
  const sb = { style: "picture", kleo_style: "realistic", direction: { subject: "bakery", world: "A village bakery", cast: [], objects: [], forbidden: [], sections: [] },
    scenes: [{ id: "01-hook", kind: "cinema", voice: "a line", shots: [{ image_prompt: "The bakery at dawn" }, { image_prompt: "The bakery sign above the door", covers: ["R2"] }] }] };
  const stored = { storyboard: sb, spec };
  assert.equal(m.clipKeepsText("01-hook-s2", stored), true);
  assert.equal(m.clipKeepsText("01-hook-s1", stored), false, "a shot without the text item keeps the no-text negative");
  assert.equal(m.clipKeepsText("09-nope-s1", stored), false);
  assert.equal(m.clipKeepsText("01-hook-s2", null), false);
  assert.equal(m.clipKeepsText("01-hook-s2", { storyboard: sb, spec: null }), false);
  for (const look of ["realistic", "animation"]) {
    const keep = m.kieNegativeFor(look, true);
    assert.ok(!/(^|, )(text|letters|subtitles)(,|$)/.test(keep), keep);
    assert.ok(keep.includes("watermark") && keep.includes("logo"), "watermarks and logos stay banned");
    assert.equal(m.kieNegativeFor(look, false), m.KIE_NEGATIVES[look]);
  }
  const p = { prompt: "x", imageUrl: "https://kleo.test/still.png", seconds: 3, format: "9:16", seed: 1, look: "realistic" };
  assert.equal(m.kieInput("wan-2.7", m.KIE_MODELS["wan-2.7"], p).negative_prompt, m.KIE_NEGATIVES.realistic);
  assert.equal(m.kieInput("wan-2.7", m.KIE_MODELS["wan-2.7"], { ...p, keepsText: true }).negative_prompt, m.kieNegativeFor("realistic", true));
  assert.equal(m.kieInput("minimax-h3", m.KIE_MODELS["minimax-h3"], { ...p, keepsText: true }).negative_prompt, undefined, "only the Wan dialect has a negative prompt");
});

/* ------------------------------------------------------------------ ePhone AI (25 September 2026) */

/** A fake ePhone AI (RixAPI): /v1/task/submit, /v1/task/{id}, the billing pair, the result file. */
function fakeEphone(script = {}) {
  const calls = { submit: [], query: [], downloads: 0, billing: 0 };
  let n = 0;
  const mp4 = new Uint8Array(4096); mp4.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0);
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === "https://api.ephone.ai/v1/task/submit") {
      calls.submit.push({ body: JSON.parse(init.body), headers: init.headers });
      // The real answer of an empty account, 25 September 2026.
      if (script.submitNoMoney) return new Response(JSON.stringify({ error: { message: "预扣费额度失败, 用户剩余额度: ＄0.000000, 需要预扣费额度: ＄0.006360 (request id: a407)", type: "rix_api_error", param: "", code: "insufficient_user_quota" } }), { status: 403 });
      return new Response(JSON.stringify({ id: `eph_${++n}`, status: "queued", created_at: 1 }), { status: 200 });
    }
    const q = /^https:\/\/api\.ephone\.ai\/v1\/task\/([^/?]+)$/.exec(u);
    if (q) {
      calls.query.push(q[1]);
      const status = script.status?.[q[1]] ?? script.defaultStatus ?? "in_progress";
      const body = { id: q[1], status, created_at: 1,
        ...(status === "completed" ? { outputs: [`https://cdn.ephone.test/${q[1]}.mp4`], usage: { type: "tokens", output_tokens: 38880, total_tokens: 38880 } } : {}),
        ...(status === "failed" ? { error: "Content policy violation detected" } : {}) };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (u.endsWith("/v1/dashboard/billing/subscription")) { calls.billing++; return new Response(JSON.stringify({ object: "billing_subscription", hard_limit_usd: script.limit ?? 10 }), { status: 200 }); }
    if (u.endsWith("/v1/dashboard/billing/usage")) return new Response(JSON.stringify({ object: "list", total_usage: script.usedCents ?? 250 }), { status: 200 });
    if (u.startsWith("https://cdn.ephone.test/")) { calls.downloads++; return new Response(mp4, { status: 200, headers: { "content-length": String(mp4.length) } }); }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { calls, fetch };
}

test("ePhone AI: a Seedance 2.5 model needs EPHONE_API_KEY, not kie.ai's; the price table knows it", () => {
  const j = { params: JSON.stringify({ duration_s: 15 }) };
  assert.equal(m.footageBackendFor({ KLEO_FOOTAGE_BACKEND: "kie", KIE_API_KEY: "k", KLEO_FOOTAGE_MODEL: "seedance-2.5-480p" }, j), "local", "no ePhone key: the API road is closed");
  assert.equal(m.footageBackendFor({ KLEO_FOOTAGE_BACKEND: "kie", EPHONE_API_KEY: "e", KLEO_FOOTAGE_MODEL: "seedance-2.5-480p" }, j), "kie");
  assert.equal(m.footageBackendFor({ KLEO_FOOTAGE_BACKEND: "kie", EPHONE_API_KEY: "e" }, j, { model: "seedance-2.5-720p" }), "kie", "the admin override picks the road too");
  const s480 = m.KIE_MODELS["seedance-2.5-480p"];
  assert.equal(s480.provider, "ephone"); assert.equal(s480.model, "doubao-seedance-2-5-260628"); assert.equal(s480.resolution, "480p");
  assert.equal(m.clipSecondsFor(s480, 2.4), 4, "4 s at least"); assert.equal(m.clipSecondsFor(s480, 22), 22, "up to 30 s in one clip");
  assert.deepEqual(m.ephoneInput("seedance-2.5-480p", s480, { prompt: "p", imageUrl: "https://kleo.test/a.png", seconds: 3.2, format: "9:16" }),
    { prompt: "p", first_frame: "https://kleo.test/a.png", duration: 4, resolution: "480p", aspect_ratio: "adaptive", generate_audio: false, watermark: false }, "with a first frame only 'adaptive' is accepted");
  assert.equal(m.ephoneInput("seedance-2.5-480p", s480, { prompt: "p", imageUrl: null, seconds: 4, format: "16:9" }).aspect_ratio, "16:9", "text-to-video keeps the film's format");
});

test("ePhone AI: requestFootage submits one task per shot on the official channels only, footageStatus collects the clip", async () => {
  const env = await newEnv({ KIE_API_KEY: undefined, EPHONE_API_KEY: "eph-key", KLEO_FOOTAGE_MODEL: "seedance-2.5-480p", KIE_MAX_VIDEO_S: "0" });
  const job = await filmJob(env);
  const eph = fakeEphone(); globalThis.fetch = eph.fetch;
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, look: "realistic", format: "9:16" });
  assert.equal(r.status, 200, JSON.stringify(r.reply)); assert.equal(r.reply.ordered, 3); assert.equal(r.reply.model, "seedance-2.5-480p");
  assert.equal(eph.calls.billing, 1, "the balance is read before the first task");
  const first = eph.calls.submit.find((c) => c.body.input.prompt.startsWith("a figure") || c.body.input.first_frame?.includes("01-hook-s1"));
  assert.equal(first.headers.authorization, "Bearer eph-key");
  assert.equal(first.headers["X-Provider-Order"], "official"); assert.equal(first.headers["X-Provider-Only"], "true");
  assert.equal(first.body.model, "doubao-seedance-2-5-260628");
  assert.match(first.body.input.first_frame, /^http:\/\/kleo\.test\/dl\/gt_test1234\/img%2F01-hook-s1\.png\?exp=\d+&sig=[0-9a-f]{64}$/);
  assert.deepEqual([first.body.input.duration, first.body.input.resolution, first.body.input.aspect_ratio, first.body.input.generate_audio], [4, "480p", "adaptive", false]);
  const rows = await m.footageRows(env, job.id);
  assert.deepEqual(rows.map((x) => [x.shot_id, x.state, x.cost_usd]), [["01-hook-s1", "generating", 0.35], ["01-hook-s2", "generating", 0.35], ["02-city-s1", "generating", 0.7]]);
  // One finishes, one fails, one is still running.
  const byShot = Object.fromEntries(rows.map((x) => [x.shot_id, x.task_id]));
  globalThis.fetch = fakeEphone({ status: { [byShot["01-hook-s1"]]: "completed", [byShot["01-hook-s2"]]: "failed" } }).fetch;
  const st = await m.footageStatus(env, job);
  assert.deepEqual(st.reply.ready, ["01-hook-s1"]); assert.deepEqual(st.reply.pending, ["02-city-s1"]);
  assert.match(st.reply.failed["01-hook-s2"], /Content policy/);
  assert.ok(await env.RENDERS.get(m.clipKey(job.id, "01-hook-s1")), "the clip is on R2");
});

test("ePhone AI: an empty account (RixAPI's 403 insufficient_user_quota) stops the order at once, and the balance refuses first when it is known", async () => {
  const env = await newEnv({ KIE_API_KEY: undefined, EPHONE_API_KEY: "eph-key", KLEO_FOOTAGE_MODEL: "seedance-2.5-480p", KIE_MAX_VIDEO_S: "0" });
  const job = await filmJob(env);
  const poor = fakeEphone({ submitNoMoney: true, limit: 0 }); globalThis.fetch = poor.fetch; // limit 0: the balance says nothing, the task decides
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r.status, 402); assert.equal(r.reply.no_credit, true); assert.match(r.reply.error, /ePhone AI balance is empty/);
  assert.equal(poor.calls.submit.length, 1, "the first refusal stops the order");
  const env2 = await newEnv({ KIE_API_KEY: undefined, EPHONE_API_KEY: "eph-key", KLEO_FOOTAGE_MODEL: "seedance-2.5-480p", KIE_MAX_VIDEO_S: "0" });
  const job2 = await filmJob(env2);
  const low = fakeEphone({ limit: 1, usedCents: 90 }); globalThis.fetch = low.fetch; // 0.10 $ left
  const r2 = await m.requestFootage(env2, job2, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r2.status, 402); assert.equal(low.calls.submit.length, 0, "nothing ordered"); assert.equal(r2.reply.balance_usd, 0.1);
  // The pre-flight reads the same account.
  const pre = await m.kiePreflight(env2, 30, 6, 24);
  assert.equal(pre.ok, false); assert.equal(pre.reason, "balance"); assert.equal(pre.balance_usd, 0.1);
});

test("ePhone AI music: Suno through the task API when KLEO_MUSIC_PROVIDER is ephone; the mp3 among the outputs is the track", async () => {
  const env = await newEnv({ KIE_API_KEY: undefined, EPHONE_API_KEY: "eph-key", KLEO_MUSIC_PROVIDER: "ephone" });
  const job = await filmJob(env);
  assert.equal(m.musicOn(env), true); assert.equal(m.musicOn({ ...env, KLEO_MUSIC_PROVIDER: "" }), false, "kie.ai's road needs kie.ai's key");
  const calls = [];
  const mp3 = new Uint8Array(6000); mp3.set([0x49, 0x44, 0x33], 0);
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (u === "https://api.ephone.ai/v1/task/submit") { calls.body = JSON.parse(init.body); return new Response(JSON.stringify({ id: "mus_1", status: "queued" }), { status: 200 }); }
    if (u.endsWith("/v1/dashboard/billing/subscription")) return new Response(JSON.stringify({ hard_limit_usd: 10000 }), { status: 200 });
    if (u.endsWith("/v1/dashboard/billing/usage")) return new Response(JSON.stringify({ total_usage: 0 }), { status: 200 });
    if (u === "https://api.ephone.ai/v1/task/mus_1") return new Response(JSON.stringify({ id: "mus_1", status: "completed", outputs: ["https://storage.test/a.jpeg", "https://storage.test/b.jpeg", "https://storage.test/c.mp3", "https://storage.test/d.mp3"] }), { status: 200 });
    if (u === "https://storage.test/c.mp3") return new Response(mp3, { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  };
  const r = await m.requestMusic(env, job, { brief: "epic orchestral pirate adventure", seconds: 15 });
  assert.equal(r.status, 200, JSON.stringify(r.reply));
  assert.equal(calls.body.model, "suno/music"); assert.equal(calls.body.input.instrumental, true); assert.equal(calls.body.input.custom, false);
  assert.match(calls.body.input.gpt_description_prompt, /^epic orchestral pirate adventure\. Instrumental film score/);
  const st = await m.musicStatus(env, job);
  assert.equal(st.reply.state, "ready"); assert.equal(st.reply.cost_usd, 0.064);
  assert.ok(calls.includes("https://storage.test/c.mp3") && !calls.includes("https://storage.test/a.jpeg"), "the first mp3, never a cover picture");
});
