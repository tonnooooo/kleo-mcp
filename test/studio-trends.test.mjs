/**
 * Kleo Studio's viral templates (src/studio/trends.ts) and their provider (src/wavespeed.ts): the price WaveSpeed
 * quoted, the edit instruction for any set of filled seats, the app each template becomes, and the client's reading
 * of WaveSpeed's answers. Imports the TypeScript sources directly (Node 22.18+ strips the types).
 * Run: node --test test/studio-trends.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TRENDS, trendByKey, trendCostUsd, trendBilledSeconds, trendPrompt, trendTaskInput, trendQuality, WAN30_EDIT_MODEL } from "../src/studio/trends.ts";
import { TOOLS, planTool, publicTools, toolByKey, toolCredits, ToolRefusal } from "../src/studio/tools.ts";
import { wavespeed, wavespeedSubmit, wavespeedTask } from "../src/wavespeed.ts";

const YTBM = "trend-you-talking-bout-me";
const photo = (id) => ({ id, url: `https://app.example/media/u/${id}?sig=x`, kind: "image", seconds: null, width: 800, height: 1000, type: "image/jpeg" });

test("price: the same as WaveSpeed's own quote for the 14 s clip (19 October 2026)", () => {
  const t = trendByKey(YTBM);
  assert.equal(trendBilledSeconds(t), 28);
  assert.equal(trendCostUsd(t, "480p"), 1.4);
  assert.equal(trendCostUsd(t, "720p"), 2.8);
  assert.equal(trendCostUsd(t, "1080p"), 5.6);
  // A clip over 15 s is billed as 15 + 15.
  assert.equal(trendBilledSeconds({ baseSeconds: 22 }), 30);
  // Credits at margin 1.6 and 0.44 $ a credit: 6 / 11 / 21.
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => toolCredits(trendCostUsd(t, q))), [6, 11, 21]);
  assert.equal(trendQuality("4k"), "720p");
});

test("every template is an app: one photo box per seat, a quality, consent, its own key", () => {
  for (const t of TRENDS) {
    const app = toolByKey(t.key);
    assert.ok(app, t.key);
    assert.equal(app.group, "trend");
    assert.equal(app.consent, true);
    assert.deepEqual(app.fields.filter((f) => f.kind === "image").map((f) => f.key), t.seats.map((s) => s.key));
    assert.ok(app.fields.some((f) => f.key === "quality"));
    assert.ok(app.preview?.endsWith("-p.mp4") && app.guide);
    for (const s of t.seats) assert.ok(s.at[0] > 0 && s.at[0] < 100 && s.at[1] > 0 && s.at[1] < 100, s.key);
  }
  assert.equal(new Set(TOOLS.map((x) => x.key)).size, TOOLS.length);
  const card = publicTools().find((x) => x.key === YTBM);
  assert.equal(card.from, 6);
});

test("plan: only the filled seats are swapped, in seat order, on WaveSpeed's Wan 3.0 edit with the clip's own sound", () => {
  const plan = planTool(YTBM, { quality: "480p" }, { person1: photo("up_a"), person3: photo("up_c") });
  assert.equal(plan.usd, 1.4);
  assert.equal(plan.output, "video");
  assert.equal(plan.tasks.length, 1);
  const task = plan.tasks[0];
  assert.equal(task.provider, "wavespeed");
  assert.equal(task.model, WAN30_EDIT_MODEL);
  assert.equal(task.input.video, trendByKey(YTBM).baseUrl);
  assert.deepEqual(task.input.reference_images, [photo("up_a").url, photo("up_c").url]);
  assert.equal(task.input.resolution, "480p");
  assert.equal(task.input.generate_audio, false);
  const p = task.input.prompt;
  assert.match(p, /Image 1 replaces the person in the FRONT/);
  assert.match(p, /Image 2 replaces the person FURTHEST/);
  assert.match(p, /The person in the MIDDLE[^\n]* stays exactly as in Video 1/);
  assert.match(p, /no black cap/);
  assert.match(p, /no red patterned shirt/);
  assert.doesNotMatch(p, /no grey printed T-shirt/);
  assert.match(p, /- Image 1: 0-4s leans toward the camera/);
});

test("plan: no photo is a refusal a person can act on; a video in a seat is refused", () => {
  assert.throws(() => planTool(YTBM, {}, {}), (e) => e instanceof ToolRefusal && /at least one person/.test(e.message));
  assert.throws(() => planTool(YTBM, {}, { person1: { ...photo("up_v"), kind: "video" } }), (e) => e instanceof ToolRefusal && /picture/.test(e.message));
  // The default quality is 720p.
  assert.equal(planTool(YTBM, {}, { person2: photo("up_b") }).usd, 2.8);
});

test("prompt: one, two or three people read naturally", () => {
  const t = trendByKey(YTBM);
  assert.match(trendPrompt(t, ["person1"]), /^Recreate Video 1 exactly, frame for frame, with a new cast: one person is replaced by the person from Image 1\./);
  assert.match(trendPrompt(t, ["person1", "person2"]), /2 people are replaced by the people from Image 1 and Image 2\./);
  assert.match(trendPrompt(t, ["person1", "person2", "person3"]), /the people from Image 1, Image 2 and Image 3\. Everything else stays identical to Video 1\./);
  assert.equal(trendTaskInput(t, ["person2"], ["u2"], "1080p").reference_images.length, 1);
});

test("wavespeed client: submit, a running and a finished prediction, an empty balance as 402", async () => {
  const real = globalThis.fetch;
  const env = { WAVESPEED_API_KEY: "k" };
  try {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([String(url), init?.method, init?.headers?.authorization]);
      if (String(url).endsWith("/api/v3/alibaba/wan-3.0/video-edit")) return new Response(JSON.stringify({ code: 200, message: "success", data: { id: "p1", status: "created" } }));
      if (String(url).includes("/predictions/p1/")) return new Response(JSON.stringify({ code: 200, data: { id: "p1", status: "processing", outputs: [] } }));
      if (String(url).includes("/predictions/p2/")) return new Response(JSON.stringify({ code: 200, data: { id: "p2", status: "completed", outputs: ["https://cdn.example/out.mp4"] } }));
      if (String(url).includes("/predictions/p3/")) return new Response(JSON.stringify({ code: 200, data: { id: "p3", status: "failed", outputs: [], error: "Content flagged as potentially sensitive. Please try different prompts or images." } }));
      return new Response(JSON.stringify({ code: 400, message: "Insufficient credits. Please top up your account to continue." }), { status: 400 });
    };
    assert.equal(await wavespeedSubmit(env, "alibaba/wan-3.0/video-edit", { prompt: "x" }), "p1");
    assert.deepEqual(calls[0], ["https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/video-edit", "POST", "Bearer k"]);
    assert.equal((await wavespeedTask(env, "p1")).status, "in_progress");
    const done = await wavespeedTask(env, "p2");
    assert.equal(done.status, "completed");
    assert.deepEqual(done.outputs, ["https://cdn.example/out.mp4"]);
    const failed = await wavespeedTask(env, "p3");
    assert.equal(failed.status, "failed");
    assert.match(String(failed.error), /flagged/);
    await assert.rejects(wavespeedSubmit(env, "x/y", {}), (e) => e.status === 402);
    await assert.rejects(wavespeed({}, "GET", "/api/v3/x"), /WAVESPEED_API_KEY is not set/);
  } finally { globalThis.fetch = real; }
});
