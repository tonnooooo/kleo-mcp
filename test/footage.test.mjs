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
import { publicText } from "../src/util.ts";

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
    stdin: { contents: `export * from "./src/footage.ts"; export * from "./src/internal.ts"; export * from "./src/db.ts"; export { stillsHold } from "./src/stills.ts";`, resolveDir: ROOT, loader: "ts" },
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
  assert.match(r.reply.error, /filming capacity is fully booked/);
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
  assert.match(r.reply.error, /the video model could not take this film's order \(1 of 3 shots were placed before it stopped\)/);
  assert.doesNotMatch(r.reply.error, /kie|ephone|balance|top up/i, "the user reads no provider and no balance (26 September 2026)");
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
  assert.match(after.error, /could not take this film's order \(0 of 3 shots[\s\S]*credits are refunded/);
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
  // No storyboard: one shot per clip floor (MiniMax's shortest clip, 4 s), capped by the storyboard. Until 25 September
  // this was a shot every 2.5 s and never fewer than six — the density of films planned before the clip floor.
  const guess = m.plannedFilmUsd(env, null, 60, null, 24);
  assert.equal(guess.shots, 15, "60 s of 4-second clips");
  assert.equal(m.plannedFilmUsd(env, null, 15, null, 24).shots, 4, "the six-shot floor is gone");
  assert.equal(m.plannedFilmUsd(env, null, 300, null, 48).shots, 48, "never more than the storyboard cap");
  // Still an upper bound: never fewer billed seconds than the film has, and the margin on top.
  for (const s of [15, 30, 60]) assert.ok(m.plannedFilmUsd(env, null, s, null, 24).usd >= s * 0.065 * m.PREFLIGHT_MARGIN - 1e-9, `${s} s`);
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
  const both = await m.kiePreflight({ ...env, STILL_MODEL: "kie:nano-banana-pro", DAILY_FOOTAGE_BUDGET_USD: "50" }, 60, 10, 24);
  assert.equal(both.ok, false); assert.equal(both.reason, "balance"); assert.equal(both.stills_usd, 1.521); assert.equal(both.planned_usd, 4.875);
  // 26 September 2026: today's ceiling asks for the film's own pictures too (4.875 + 1.521 > the default 5 $), before
  // the balance is even read.
  const ceiling = await m.kiePreflight({ ...env, STILL_MODEL: "kie:nano-banana-pro" }, 60, 10, 24);
  assert.equal(ceiling.ok, false); assert.equal(ceiling.reason, "budget"); assert.equal(ceiling.stills_usd, 1.521); assert.equal(ceiling.balance_usd, null);
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
  assert.deepEqual(spec.footage, { backend: "kie", model: "minimax-h3", clip_min_s: 4, clip_max_s: 15 },
    "the default of the file is MiniMax H3, and the box is told the clip lengths it films (whole seconds 4-15)");
  const admin = (method, body) => m.handleAdmin(new Request("http://kleo.test/internal/admin/footage", { method, headers: { authorization: "Bearer s3cret" }, body: body && JSON.stringify(body) }), env);
  globalThis.fetch = fakeKie({ credits: 2000 }).fetch;
  let v = await (await admin("GET")).json();
  assert.equal(v.backend, "kie"); assert.equal(v.key_configured, true); assert.equal(v.max_video_s, 20); assert.equal(v.budget_usd, 5); assert.ok(v.models["wan-2.7"]);
  assert.equal(v.balance_usd, 10, "2000 kie.ai credits at 0.005 $ each");
  assert.equal(v.model, "minimax-h3"); assert.deepEqual(v.models["gemini-omni-flash"].usd_per_clip, { 4: 0.315, 6: 0.42, 8: 0.525, 10: 0.63 }, "per-clip prices are shown to the admin");
  v = await (await admin("POST", { model: "seedance-2.0" })).json();
  assert.equal(v.model, "seedance-2.0");
  assert.equal((await (await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}`, { headers: { authorization: "Bearer wsecret" } }), env)).json()).footage.model, "seedance-2.0");
  await admin("POST", { model: "veo-3.1" });
  assert.deepEqual((await (await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}`, { headers: { authorization: "Bearer wsecret" } }), env)).json()).footage,
    { backend: "kie", model: "veo-3.1", clip_min_s: 4, clip_max_s: 8, clip_seconds: [4, 6, 8] }, "a model that films a few lengths only says which");
  await admin("POST", { model: "seedance-2.0" });
  assert.equal((await admin("POST", { model: "nope" })).status, 400);
  v = await (await admin("POST", { backend: "local" })).json();
  assert.equal(v.backend, "local"); assert.equal(v.model, "seedance-2.0", "the model survives a backend switch");
  v = await (await admin("POST", { reset: true })).json();
  assert.equal(v.backend, "kie"); assert.equal(v.model, "minimax-h3"); assert.equal(v.override, null);
  assert.equal((await m.handleAdmin(new Request("http://kleo.test/internal/admin/footage", { headers: { authorization: "Bearer wrong" } }), env)).status, 401);
});

test("clipLengthsSpec: the lengths the box may order are exactly the lengths the server orders, for every model (25 September)", () => {
  for (const [name, spec] of Object.entries(m.KIE_MODELS)) {
    const told = m.clipLengthsSpec(spec);
    const lengths = told.clip_seconds ?? Array.from({ length: told.clip_max_s - told.clip_min_s + 1 }, (_, i) => told.clip_min_s + i);
    assert.equal(lengths[0], m.clipMinSeconds(spec), `${name}: the shortest clip`);
    assert.equal(Array.isArray(spec.seconds), Array.isArray(told.clip_seconds), `${name}: a list model sends its list, a range model its bounds`);
    // The worker orders a fitted shot at a whole length from this list: the server must film exactly that, not one more.
    for (const n of lengths) assert.equal(m.clipSecondsFor(spec, n), n, `${name}: a ${n} s shot is a ${n} s clip`);
  }
  assert.deepEqual(m.clipLengthsSpec(m.KIE_MODELS["seedance-2.5-480p"]), { clip_min_s: 4, clip_max_s: 30 });
});

test("a clip the box bought whole is ordered at exactly that length, billed for it, and asked as one continuous take (25 September)", async () => {
  const env = await newEnv({ KIE_API_KEY: undefined, EPHONE_API_KEY: "eph-key", KLEO_FOOTAGE_MODEL: "seedance-2.5-480p", KIE_MAX_VIDEO_S: "0" });
  const job = await filmJob(env);
  const eph = fakeEphone(); globalThis.fetch = eph.fetch;
  const whole = SHOTS.map((s, i) => ({ ...s, seconds: [4, 5, 7][i] }));
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: whole, look: "realistic", format: "9:16" });
  assert.equal(r.status, 200, JSON.stringify(r.reply)); assert.equal(r.reply.ordered, 3);
  // One task per shot, in the order the box sent them.
  assert.deepEqual(eph.calls.submit.map((c) => c.body.input.duration), [4, 5, 7], "the length the box asked for, not one second more");
  for (const c of eph.calls.submit) {
    assert.doesNotMatch(c.body.input.prompt, /the motion settles/, "nothing of the clip is left over to settle in");
    assert.match(c.body.input.prompt, /in one continuous movement/);
  }
  const rows = await m.footageRows(env, job.id);
  assert.deepEqual(rows.map((x) => [x.shot_id, x.seconds, x.cost_usd]), [["01-hook-s1", 4, 0.35], ["01-hook-s2", 5, 0.4375], ["02-city-s1", 7, 0.6125]]);
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
  assert.equal(r.status, 402); assert.equal(r.reply.no_credit, true); assert.match(r.reply.error, /could not take this film's order/); assert.doesNotMatch(r.reply.error, /ephone|kie/i);
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

test("the clip floor: a model's shortest clip; a film on the API road has one, the animatic and the local road none; the pre-flight prices it", () => {
  const min = (k) => m.clipMinSeconds(m.KIE_MODELS[k]);
  assert.equal(min("seedance-2.5-480p"), 4); assert.equal(min("seedance-2.5-720p"), 4); assert.equal(min("minimax-h3"), 4);
  assert.equal(min("kling-3.0"), 3); assert.equal(min("wan-2.7"), 2); assert.equal(min("veo-3.1"), 4, "a per-clip model: its shortest listed clip");
  const eph = { KLEO_FOOTAGE_BACKEND: "kie", EPHONE_API_KEY: "e", KLEO_FOOTAGE_MODEL: "seedance-2.5-480p", KIE_MAX_VIDEO_S: "0" };
  assert.equal(m.clipFloorFor(eph, { product: "film", duration_s: 15 }), 4);
  assert.equal(m.clipFloorFor(eph, { product: "animatic", duration_s: 15 }), 0, "an animatic buys no clip");
  assert.equal(m.clipFloorFor({}, { product: "film", duration_s: 15 }), 0, "the local road buys no clip");
  assert.equal(m.clipFloorFor({ ...eph, KIE_MAX_VIDEO_S: "20" }, { product: "film", duration_s: 45 }), 0, "over the API road's cap the film is local");
  // The pre-flight of a 15 s Seedance film: four 4-second clips, not six.
  const plan15 = m.plannedFilmUsd(eph, null, 15, null, 24);
  assert.equal(plan15.shots, 4); assert.ok(plan15.usd <= 2.0, `${plan15.usd} $`);
  const plan30 = m.plannedFilmUsd(eph, null, 30, null, 24);
  assert.ok(plan30.usd >= 30 * 0.0875 * 1.25, `${plan30.usd} $: never under the film's own seconds`);
});

/* ------------------------------------------------------------------ the Seedance prompt (25 September) */

const SEED_SPEC = () => ({
  v: 1, mode: "faithful", summary: "Mara decorates a cake at dawn.",
  cast: [{ id: "c1", name: "Mara", look: "a thin woman with short blonde hair tied up", ref: null }],
  items: [
    { id: "R1", kind: "look", text: "Mara wears a lilac apron", quote: "grembiule lilla", must: true, who: "c1", order: null },
    { id: "R2", kind: "text", text: "a shop sign reading \"Forno Mara\"", quote: "insegna Forno Mara", must: true, who: null, order: null },
  ],
  refs: [], open: [], narration: "free", script: null,
});
const SEED_SB = () => ({
  style: "picture", kleo_style: "realistic", direction: { subject: "cake", world: "A village bakery at dawn", cast: [{ name: "Mara", look: "a blonde woman" }], objects: [], forbidden: [], sections: [] },
  scenes: [{ id: "01-hook", kind: "cinema", voice: "a line", shots: [
    { image_prompt: "Mara at the counter with a cake", action: "Mara lifts the piping bag and draws a slow spiral of cream", cast: ["c1"], covers: ["R1"] },
    { image_prompt: "The bakery sign above the door", covers: ["R2"] },
    { image_prompt: "Close on Mara's face in the warm light", shot_kind: "face", cast: ["c1"] },
  ] }],
});
const FRAME = { clipSeconds: 4, usedSeconds: 3.2, keepsText: false, hasFrame: true };

test("seedancePrompt: the frame is continued, not described again; the action is timed inside the kept seconds; one camera move; the look in positive words", () => {
  const stored = { storyboard: SEED_SB(), spec: SEED_SPEC() };
  const p = m.seedancePrompt({ id: "01-hook-s1", image_prompt: "ignored", motion: "push_in" }, "realistic", stored, FRAME);
  assert.ok(p.startsWith("Continue from the first frame: Mara lifts the piping bag and draws a slow spiral of cream. Mara stays exactly as in the first frame."), p);
  assert.match(p, /Timing: 0s-3\.2s the action above; 3\.2s-4s the motion settles and the move carries on gently\./);
  assert.equal((p.match(/camera/gi) ?? []).length, 1, "exactly one camera sentence"); assert.match(p, /Camera: slow push-in toward the subject\./);
  for (const bad of [/\bfast\b/i, /35mm/i, /shallow depth of field/i]) assert.doesNotMatch(p, bad);
  assert.ok(!p.includes("a thin woman with short blonde hair tied up"), "a character in the frame is named, not re-described");
  assert.match(p, /live-action film look/); assert.match(p, /no slow motion/); assert.match(p, /no text, subtitles, logos or watermark\.$/);
  assert.ok(p.length >= 350 && p.length <= m.SEEDANCE_PROMPT_MAX, `${p.length} characters`);
  // The whole clip is the shot: no settle, the action fills it.
  const full = m.seedancePrompt({ id: "01-hook-s1", image_prompt: "x", motion: "push_in" }, "realistic", stored, { ...FRAME, usedSeconds: 4 });
  assert.match(full, /Timing: 0s-4s the action above, in one continuous movement\./); assert.doesNotMatch(full, /settles/);
  // No action: the shot's kind says what moves, never the image prompt again.
  const face = m.seedancePrompt({ id: "01-hook-s3", image_prompt: "x", motion: "static_hold" }, "realistic", stored, FRAME);
  assert.ok(face.startsWith(`Continue from the first frame: ${m.SEEDANCE_KIND_MOTION.face}.`), face);
  assert.doesNotMatch(face, /warm light/);
  assert.match(face, /Camera: locked off on a tripod, only the scene moves\./);
  const bare = m.seedancePrompt({ id: "01-hook-s2", image_prompt: "x", motion: "crash_zoom_in" }, "realistic", stored, FRAME);
  assert.ok(bare.startsWith(`Continue from the first frame: ${m.SEEDANCE_KIND_MOTION.default}.`), bare);
  assert.match(bare, /Camera: sudden push-in that snaps to a close-up\./);
  for (const move of Object.values(m.SEEDANCE_MOVES)) assert.doesNotMatch(move, /\bfast\b|camera/i, move);
});

test("seedancePrompt: 'fast' never reaches Seedance, not even from Kleo's own motion hint (review, 25 September)", () => {
  const sb = SEED_SB(); sb.scenes[0].shots[0].action = "the mist drifting fast across the frame";
  const p = m.seedancePrompt({ id: "01-hook-s1", image_prompt: "x", motion: "push_in" }, "realistic", { storyboard: sb, spec: SEED_SPEC() }, FRAME);
  assert.ok(p.startsWith("Continue from the first frame: the mist drifting steadily across the frame."), p);
  assert.doesNotMatch(p, /\bfast/i);
  const t2v = m.seedancePrompt({ id: "01-hook-s1", image_prompt: "x", motion: "push_in" }, "realistic", { storyboard: sb, spec: SEED_SPEC() }, { ...FRAME, hasFrame: false });
  assert.doesNotMatch(t2v, /\bfast/i);
  for (const [a, b] of [["clouds race fast over the ridge", "clouds race steadily over the ridge"], ["a fast car crosses the bridge", "a car crosses the bridge"],
    ["fast-moving clouds", "moving clouds"], ["the river moves very fast", "the river moves steadily"], ["she eats breakfast slowly", "she eats breakfast slowly"]])
    assert.equal(m.unhurried(a), b, a);
});

test("seedancePrompt: the drawn look, a text the user asked for, the text-to-video fallback, and the limit", () => {
  const stored = { storyboard: SEED_SB(), spec: SEED_SPEC() };
  const anim = m.seedancePrompt({ id: "01-hook-s1", image_prompt: "x", motion: "push_in" }, "animation", stored, FRAME);
  assert.match(anim, /nothing photographic/); assert.match(anim, /2D hand-drawn animation/); assert.doesNotMatch(anim, /live-action/);
  // The shop sign the user asked for is kept, not erased.
  const sign = m.seedancePrompt({ id: "01-hook-s2", image_prompt: "x", motion: "static_hold" }, "realistic", stored, { ...FRAME, keepsText: true });
  assert.match(sign, /the lettering on a shop sign reading "Forno Mara" stays exactly as in the first frame\.$/); assert.doesNotMatch(sign, /no text/);
  // No first frame: text-to-video, so the picture, every look in full and the setting are described.
  const t2v = m.seedancePrompt({ id: "01-hook-s1", image_prompt: "x", motion: "push_in" }, "realistic", stored, { ...FRAME, hasFrame: false });
  assert.ok(t2v.startsWith("Mara at the counter with a cake. Mara lifts the piping bag"), t2v);
  assert.match(t2v, /Mara: a thin woman with short blonde hair tied up; Mara wears a lilac apron\./); assert.match(t2v, /Setting: A village bakery at dawn\./);
  assert.doesNotMatch(t2v, /first frame/i);
  // Long looks never take it past Seedance's limit.
  const crowd = { ...SEED_SPEC(), cast: ["c1", "c2", "c3", "c4", "c5"].map((id) => ({ id, name: `Person ${id}`, look: `${"a very detailed description of a coat and a hat and a scarf ".repeat(12)}`, ref: null })) };
  const sb = SEED_SB(); sb.scenes[0].shots[0].cast = ["c1", "c2", "c3", "c4", "c5"]; sb.scenes[0].shots[0].action = "they all walk across the square ".repeat(30);
  const long = m.seedancePrompt({ id: "01-hook-s1", image_prompt: "x", motion: "push_in" }, "realistic", { storyboard: sb, spec: crowd }, { ...FRAME, hasFrame: false });
  assert.ok(long.length <= m.SEEDANCE_PROMPT_MAX, `${long.length} characters`);
});

test("the ePhone road asks in Seedance's words; the kie.ai models keep clipPrompt byte for byte", async () => {
  const sb = SEED_SB(), spec = SEED_SPEC();
  const shot = { id: "01-hook-s1", image_prompt: "Mara at the counter with a cake", motion: "push_in", strength: 0.5, seconds: 3.2, still: "01-hook-s1.png" };
  const env = await newEnv({ KIE_API_KEY: undefined, EPHONE_API_KEY: "eph-key", KLEO_FOOTAGE_MODEL: "seedance-2.5-480p", KIE_MAX_VIDEO_S: "0" });
  const job = await filmJob(env);
  job.storyboard = JSON.stringify(sb); job.params = JSON.stringify({ ...JSON.parse(job.params), spec });
  const eph = fakeEphone(); globalThis.fetch = eph.fetch;
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: [shot], format: "9:16" });
  assert.equal(r.status, 200, JSON.stringify(r.reply));
  const sent = eph.calls.submit[0].body.input.prompt;
  assert.equal(sent, m.seedancePrompt(shot, "realistic", { storyboard: sb, spec }, { clipSeconds: 4, usedSeconds: 3.2, keepsText: false, hasFrame: true }));
  assert.ok(sent.startsWith("Continue from the first frame:"));
  assert.equal(m.ephoneInput("seedance-2.5-480p", m.KIE_MODELS["seedance-2.5-480p"], { prompt: sent, imageUrl: "https://kleo.test/a.png", seconds: 3.2, format: "9:16" }).prompt, sent, "no new fields, the prompt as written");
  // MiniMax on kie.ai: exactly the prompt it had.
  const env2 = await newEnv({ KLEO_FOOTAGE_MODEL: "minimax-h3" });
  const job2 = await filmJob(env2);
  job2.storyboard = JSON.stringify(sb); job2.params = JSON.stringify({ ...JSON.parse(job2.params), spec });
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  await m.requestFootage(env2, job2, "http://kleo.test", { shots: [shot], format: "9:16" });
  assert.equal(kie.calls.create[0].body.input.prompt, m.clipPrompt(shot, "realistic", { storyboard: sb, spec }));
  assert.equal(m.usesSeedancePrompt("seedance-2.0", m.KIE_MODELS["seedance-2.0"]), true, "Seedance on kie.ai reads the same words");
  assert.equal(m.usesSeedancePrompt("kling-3.0", m.KIE_MODELS["kling-3.0"]), false);
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

/* ------------------------------------------------------------------ the public words (26 September 2026) */

test("publicText: what a user reads names no model gateway — a provider's URL, name or key becomes neutral words", () => {
  assert.equal(publicText("kie.ai POST https://api.kie.ai/api/v1/jobs/createTask → 402: insufficient credits"), "the model provider → 402: insufficient credits");
  assert.equal(publicText("ephone.ai GET /v1/task/abc → 500: boom"), "the model provider → 500: boom");
  assert.equal(publicText("the track could not be ordered: kie.ai's balance was empty"), "the track could not be ordered: the model provider's balance was empty");
  assert.equal(publicText("ePhone AI balance is empty; ePhone's queue; EPHONE_API_KEY is not set"), "the AI model gateway balance is empty; the AI model gateway's queue; the provider key is not set");
  assert.equal(publicText("a telephone rang in the scene"), "a telephone rang in the scene", "ordinary words are left alone");
  assert.equal(publicText("storyboard rejected by the engine"), "storyboard rejected by the engine");
});

test("the footage sentences a user can read name no provider and no dollar", async () => {
  for (const s of [m.noCreditSentence(2, 5, "kie"), m.noCreditSentence(0, 3, "ephone")]) assert.doesNotMatch(s, /kie|ephone|\$|balance/i, s);
  const env = await newEnv({ DAILY_FOOTAGE_BUDGET_USD: "0.01" });
  const job = await filmJob(env);
  globalThis.fetch = fakeKie().fetch;
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r.status, 402);
  assert.match(r.reply.error, /today's filming capacity is fully booked: no clip was ordered[\s\S]*credits are refunded/);
  assert.doesNotMatch(r.reply.error, /kie|ephone|\$|DAILY_FOOTAGE_BUDGET_USD/i);
  const row = (await env.DB.prepare("SELECT detail FROM audit WHERE event = 'footage.budget'").first()).detail;
  assert.match(row, /budget_usd/, "the operator keeps the numbers");
});

/* ------------------------------------------------------------------ the owner's cost report (26 September 2026) */

test("no clip while the server is still drawing the pictures: the order is refused, the route fails the job, nothing is bought", async () => {
  // The server's stills engine is on for a realistic film (a Workers AI binding and a stored storyboard). While it is
  // still drawing (not started, or drawing inside its give-up), the dispatcher holds the GPU (stillsHold) and a box
  // that asks for clips anyway is refused: the clips would be filmed from pictures that are about to change.
  const env = await newEnv({ AI: {} });
  const job = await filmJob(env);
  const sb = JSON.stringify({ style: "picture", kleo_style: "realistic", scenes: [] });
  const stillsAre = async (state, at = new Date().toISOString()) => {
    const p = JSON.parse(job.params); delete p.stills;
    if (state) p.stills = { state, at, drawn: 1, total: 3 };
    job.storyboard = sb; job.params = JSON.stringify(p);
    await env.DB.prepare("UPDATE jobs SET storyboard = ?, params = ? WHERE id = ?").bind(job.storyboard, job.params, job.id).run();
  };
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  for (const state of [null, "drawing"]) {
    await stillsAre(state);
    const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
    assert.equal(r.status, 409, String(state)); assert.equal(r.reply.not_validated, true);
    assert.match(r.reply.error, /pictures were still being drawn and checked against the request when its clips were ordered, so no clip was ordered[\s\S]*credits are refunded/);
  }
  assert.equal(kie.calls.create.length, 0, "nothing bought"); assert.equal(kie.calls.credit ?? 0, 0, "not even the balance read");
  assert.equal((await m.footageRows(env, job.id)).length, 0);
  const rows = (await env.DB.prepare("SELECT detail FROM audit WHERE event = 'footage.not_validated'").all()).results.map((x) => JSON.parse(x.detail));
  assert.deepEqual(rows.map((x) => x.why), ["stills not started", "stills drawing"]);
  // A plan that never passed: no storyboard, the planner's error on the row.
  const unplanned = { ...job, storyboard: null, plan_error: "the storyboard has 3 problems" };
  const p = await m.requestFootage(env, unplanned, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(p.status, 409); assert.match(p.reply.error, /storyboard did not pass validation/);
  // Through the worker's route: the job fails with the sentence on the spot, and its credits come back.
  await stillsAre("drawing");
  const res = await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}/footage`, { method: "POST", headers: { authorization: "Bearer wsecret", "content-type": "application/json" }, body: JSON.stringify({ shots: SHOTS, format: "9:16" }) }), env);
  assert.equal(res.status, 409);
  const after = env.DB.db.prepare("SELECT state, error FROM jobs WHERE id = ?").get(job.id);
  assert.equal(after.state, "failed"); assert.match(after.error, /pictures were still being drawn/);
  assert.equal(env.DB.db.prepare("SELECT credits FROM users WHERE id = 'u1'").get().credits, 107, "the 7 credits of the film are back");
  assert.equal(kie.calls.create.length, 0);
  // Pictures done: the same order goes through.
  const env2 = await newEnv({ AI: {} });
  const job2 = await filmJob(env2);
  const p2 = JSON.parse(job2.params); p2.stills = { state: "done", at: new Date().toISOString(), drawn: 3, total: 3 };
  job2.storyboard = sb; job2.params = JSON.stringify(p2);
  const ok = fakeKie(); globalThis.fetch = ok.fetch;
  const r2 = await m.requestFootage(env2, job2, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r2.status, 200, JSON.stringify(r2.reply)); assert.equal(ok.calls.create.length, 3);
  assert.equal(m.footageGate({ STILLS_ENGINE: "legacy", AI: {} }, { storyboard: sb, params: "{}", plan_error: null }), null, "the legacy engine draws on the GPU: no server stills to wait for");
});

test("the gate and the dispatcher agree: a drawing that failed or gave up rents the GPU, and that box's clips are bought", async () => {
  // The server's drawing failed (the Workers AI quota, a bug) or gave up past its window: stillsHold lets the
  // dispatcher rent the GPU, which draws the missing pictures itself, so /footage must take its order (until the fix
  // of 26 September the gate refused it and the film was failed with the rental and the pictures paid).
  const sb = JSON.stringify({ style: "picture", kleo_style: "realistic", scenes: [] });
  const long = new Date(Date.now() - 6 * 3600_000).toISOString();
  for (const stills of [{ state: "failed", at: new Date().toISOString(), note: "4006: daily neuron quota" }, { state: "failed", at: long, note: "gave up after 20 minutes of drawing; the GPU draws the rest" }, { state: "drawing", at: long, drawn: 1, total: 3 }]) {
    const env = await newEnv({ AI: {} });
    const job = await filmJob(env);
    const p = JSON.parse(job.params); p.stills = stills;
    job.storyboard = sb; job.params = JSON.stringify(p);
    await env.DB.prepare("UPDATE jobs SET storyboard = ?, params = ? WHERE id = ?").bind(job.storyboard, job.params, job.id).run();
    assert.equal(m.stillsHold(env, job), false, `${stills.state}: the dispatcher rents the GPU`);
    assert.equal(m.footageGate(env, job), null, `${stills.state}: and the gate lets its clips through`);
    const kie = fakeKie(); globalThis.fetch = kie.fetch;
    const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
    assert.equal(r.status, 200, JSON.stringify(r.reply)); assert.equal(kie.calls.create.length, 3);
    assert.equal(env.DB.db.prepare("SELECT state FROM jobs WHERE id = ?").get(job.id).state, "rendering", "the film goes on");
  }
  // A requeued box whose clips all exist orders nothing, so the gate is not even asked: a hold never refuses it.
  const env = await newEnv({ AI: {} });
  const job = await filmJob(env);
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  assert.equal((await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" })).status, 200);
  const p = JSON.parse(job.params); p.stills = { state: "drawing", at: new Date().toISOString(), drawn: 1, total: 3 };
  job.storyboard = sb; job.params = JSON.stringify(p);
  const again = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(again.status, 200, JSON.stringify(again.reply)); assert.equal(kie.calls.create.length, 3, "nothing more bought");
});

test("a requeued job never buys a clip twice: the ready, generating and failed rows of the first box are reused", async () => {
  const env = await newEnv();
  const job = await filmJob(env);
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  const first = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(first.reply.ordered, 3);
  const byShot = Object.fromEntries((await m.footageRows(env, job.id)).map((r) => [r.shot_id, r.task_id]));
  globalThis.fetch = fakeKie({ state: { [byShot["01-hook-s1"]]: "success", [byShot["01-hook-s2"]]: "fail" } }).fetch;
  await m.footageStatus(env, job, true);
  const spent = await m.footageSpentTodayUsd(env);
  // The box dies; the job is requeued with a fresh worker secret (orchestrator failJob), and the next box asks again.
  await env.DB.prepare("UPDATE jobs SET state = 'rendering', worker_secret = 'wsecret2', attempts = 2 WHERE id = ?").bind(job.id).run();
  const again = fakeKie(); globalThis.fetch = again.fetch;
  const res = await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}/footage`, { method: "POST", headers: { authorization: "Bearer wsecret2", "content-type": "application/json" }, body: JSON.stringify({ shots: SHOTS, format: "9:16" }) }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ordered, 0);
  assert.equal(again.calls.create.length, 0, "no clip bought a second time");
  assert.equal(again.calls.credit ?? 0, 0, "nothing to buy: the balance is not even read");
  assert.deepEqual(body.ready, ["01-hook-s1"]); assert.deepEqual(body.pending, ["02-city-s1"]); assert.ok(body.failed["01-hook-s2"]);
  assert.equal(await m.footageSpentTodayUsd(env), spent, "not a cent more");
  assert.equal((await m.footageRows(env, job.id)).length, 3);
});

test("the day's ceiling counts the pictures' dollars: stills.task rows of today are spent money", async () => {
  const env = await newEnv();
  assert.equal(await m.footageSpentTodayUsd(env), 0);
  await env.DB.prepare("INSERT INTO audit (user_id, job_id, event, detail) VALUES ('u1', 'gt_other', 'stills.task', ?)").bind(JSON.stringify({ key: "k", task: "", model: "ephone:gemini-3-pro-image-preview", usd: 4.5 })).run();
  assert.equal(await m.picturesSpentTodayUsd(env), 4.5);
  assert.equal(await m.footageSpentTodayUsd(env), 4.5);
  const job = await filmJob(env);
  globalThis.fetch = fakeKie().fetch;
  const r = await m.requestFootage(env, { ...job }, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r.status, 402, "1.04 $ of clips on top of 4.50 $ of pictures is over the default 5 $");
  assert.match(r.reply.error, /filming capacity is fully booked/);
  // The pre-flight sees them too, and on ePhone it asks the one account for the clips AND the pictures drawn there.
  assert.equal(m.plannedStillsUsd({ STILL_MODEL: "ephone:gemini-3-pro-image-preview" }, 10) > 0, true);
  // An animatic's pictures are not the films' ceiling: they are bounded by STILLS_DAILY_USD alone.
  await m.insertJob(env, { ...job, id: "gt_anim0001", params: JSON.stringify({ duration_s: 30, format: "9:16", language: "en", voice: null, style: "realistic", product: "animatic" }) });
  await env.DB.prepare("INSERT INTO audit (user_id, job_id, event, detail) VALUES ('u1', 'gt_anim0001', 'stills.task', ?)").bind(JSON.stringify({ key: "k2", task: "", model: "ephone:gemini-3-pro-image-preview", usd: 3 })).run();
  assert.equal(await m.picturesSpentTodayUsd(env), 4.5, "the animatic's 3 $ are not counted");
  await env.DB.prepare("INSERT INTO audit (user_id, job_id, event, detail) VALUES ('u1', ?, 'stills.task', ?)").bind(job.id, JSON.stringify({ key: "k3", task: "", model: "ephone:gemini-3-pro-image-preview", usd: 0.5 })).run();
  assert.equal(await m.picturesSpentTodayUsd(env), 5, "a film's own pictures are");
});

test("the pre-flight and /footage agree on the day's ceiling: a film is admitted with its own pictures, and not refused for them later", async () => {
  const STILL_MODEL = "ephone:gemini-3-pro-image-preview";
  const env0 = await newEnv({ STILL_MODEL });
  const clips = m.plannedFilmUsd(env0, null, 18, 3, 24).usd;
  const pictures = m.plannedStillsUsd(env0, 3);
  assert.ok(pictures > 0 && clips > 0);
  globalThis.fetch = fakeKie().fetch;
  // Room for the clips but not for the clips and this film's own pictures: refused at creation, nothing spent.
  const short = await m.kiePreflight({ ...env0, DAILY_FOOTAGE_BUDGET_USD: String(clips + pictures / 2) }, 18, 3, 24);
  assert.equal(short.ok, false); assert.equal(short.reason, "budget"); assert.equal(short.stills_usd, pictures); assert.equal(short.balance_usd, null);
  // Room for both: admitted. The film's pictures are then drawn (at most what was planned) and the box's order passes.
  const env = await newEnv({ STILL_MODEL, DAILY_FOOTAGE_BUDGET_USD: String(Math.ceil((clips + pictures) * 1000 + 1) / 1000) });
  const pre = await m.kiePreflight(env, 18, 3, 24);
  assert.equal(pre.ok, true, JSON.stringify(pre));
  const job = await filmJob(env);
  await env.DB.prepare("INSERT INTO audit (user_id, job_id, event, detail) VALUES ('u1', ?, 'stills.task', ?)").bind(job.id, JSON.stringify({ key: "k", task: "", model: STILL_MODEL, usd: pictures })).run();
  const kie = fakeKie(); globalThis.fetch = kie.fetch;
  const r = await m.requestFootage(env, job, "http://kleo.test", { shots: SHOTS, format: "9:16" });
  assert.equal(r.status, 200, JSON.stringify(r.reply)); assert.equal(kie.calls.create.length, 3);
});
