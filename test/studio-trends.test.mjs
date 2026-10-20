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
    for (const s of t.seats) if (s.at) assert.ok(s.at[0] > 0 && s.at[0] < 100 && s.at[1] > 0 && s.at[1] < 100, s.key);
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

test("Wings & Vibes (20 October 2026): one seat, 15 s, the prompt written for that seat, the clip's own sound", () => {
  const t = trendByKey("trend-wings-and-vibes");
  assert.ok(t && !t.prompt, "a seat-by-seat prompt, not a fixed one");
  assert.equal(t.seats.length, 1);
  assert.equal(t.baseUrl, "https://media.kleooai.com/app/templates/wings-and-vibes/base.mp4");
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => toolCredits(trendCostUsd(t, q))), [6, 11, 22], "15 + 15 billed seconds");
  const plan = planTool(t.key, { quality: "720p" }, { person1: photo("up_w") });
  assert.equal(plan.usd, 3);
  const input = plan.tasks[0].input;
  assert.deepEqual(input.reference_images, [photo("up_w").url]);
  assert.equal(input.generate_audio, false);
  assert.match(input.prompt, /one person is replaced by the person from Image 1/);
  assert.match(input.prompt, /Image 1 replaces the person sitting in the beige office chair on the RIGHT/);
  assert.match(input.prompt, /no cream over-ear headphones/);
  assert.match(input.prompt, /8-12s leans back in the chair/);
  assert.match(input.prompt, /Domino's box of chicken wings/);
  assert.throws(() => planTool(t.key, {}, {}), ToolRefusal, "a photo is needed");
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

test("imported templates: their own prompt in WaveSpeed's words, every seat needed, at most 15 s billed twice", () => {
  const imported = TRENDS.filter((t) => t.prompt);
  assert.ok(imported.length >= 20, `${imported.length}`);
  for (const t of imported) {
    // No ausar.ai cite left: "@Image1" and "@[Video 1](video_1)" are "Image 1" and "Video 1".
    assert.doesNotMatch(t.prompt, /@\[|@Image|@Video|@photo|@Bild/, t.key);
    assert.match(t.prompt, /image 1/i, t.key);
    assert.ok(t.baseSeconds > 0 && t.baseSeconds <= 15.05, t.key);
    assert.ok(trendCostUsd(t, "720p") <= 3, t.key);
    assert.ok(t.baseUrl.startsWith("https://media.kleooai.com/app/templates/"), t.key);
    const app = toolByKey(t.key);
    const photos = app.fields.filter((f) => f.kind === "image");
    assert.equal(photos.length, t.seats.length, t.key);
    assert.ok(photos.every((f) => f.required && f.hint), t.key);
  }
  // The four clips with ausar.ai's own mascot are not in the catalog.
  for (const slug of ["burning-bridges-trend", "doja-trend", "pop-star-trend", "rain-dance"]) assert.equal(trendByKey(`trend-${slug}`), null);
  assert.equal(TRENDS.filter((t) => t.key === YTBM).length, 1);
});

test("imported template plan: refused until every seat has its photo, then the fixed prompt with the photos in order", () => {
  const t = trendByKey("trend-apt");
  assert.ok(t);
  assert.throws(() => planTool(t.key, {}, { person1: photo("up_a") }), (e) => e instanceof ToolRefusal && /each of the 2 people/.test(e.message));
  const plan = planTool(t.key, { quality: "480p" }, { person1: photo("up_a"), person2: photo("up_b") });
  assert.equal(plan.tasks[0].input.prompt, t.prompt);
  assert.deepEqual(plan.tasks[0].input.reference_images, [photo("up_a").url, photo("up_b").url]);
  assert.equal(plan.usd, trendCostUsd(t, "480p"));
  const one = TRENDS.find((x) => x.prompt && x.seats.length === 1);
  assert.throws(() => planTool(one.key, {}, {}), (e) => e instanceof ToolRefusal && /Add your photo/.test(e.message));
});

test("the Templates page is served by the app, not the website's 404", async () => {
  const { APP_PATH } = await import("../src/studio/site.ts");
  assert.ok(APP_PATH.test("/templates"));
  assert.ok(APP_PATH.test("/apps/trend-apt"));
  assert.ok(!APP_PATH.test("/templates/x"));
});

test("plan: a photo too small or too big for Wan 3.0 is refused before any charge", () => {
  const tiny = { ...photo("up_t"), width: 200, height: 180 };
  assert.throws(() => planTool(YTBM, {}, { person1: tiny }), (e) => e instanceof ToolRefusal && /too small \(180 pixels\)/.test(e.message));
  const huge = { ...photo("up_h"), width: 8064, height: 6048 };
  assert.throws(() => planTool(YTBM, {}, { person1: huge }), (e) => e instanceof ToolRefusal && /too big \(8064 pixels\)/.test(e.message));
  // Unknown sizes are let through (the page measures every picture it uploads).
  assert.equal(planTool(YTBM, { quality: "480p" }, { person1: { ...photo("up_u"), width: null, height: null } }).usd, 1.4);
});

test("wavespeed upload: a ticket, then the bytes PUT to the ticket's address with its headers, answering download_url", async () => {
  const real = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method, headers: init?.headers, size: init?.body?.byteLength ?? null, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      if (String(url).endsWith("/api/v3/media/uploads")) return new Response(JSON.stringify({ code: 200, data: { download_url: "https://cdn.example/m/up_a.jpg", upload: { method: "PUT", url: "https://store.example/signed", headers: { "Content-Type": "image/jpeg", "If-None-Match": "*" } } } }));
      if (String(url) === "https://store.example/signed") return new Response("", { status: 200 });
      return new Response("no", { status: 500 });
    };
    const { wavespeedUpload } = await import("../src/wavespeed.ts");
    const url = await wavespeedUpload({ WAVESPEED_API_KEY: "k" }, new Uint8Array(1234), "up_a.jpg", "image/jpeg");
    assert.equal(url, "https://cdn.example/m/up_a.jpg");
    assert.deepEqual(calls[0].body, { filename: "up_a.jpg", size: 1234, content_type: "image/jpeg" });
    assert.equal(calls[0].headers.authorization, "Bearer k");
    assert.equal(calls[1].method, "PUT");
    assert.equal(calls[1].size, 1234);
    assert.equal(calls[1].headers.authorization, undefined);
    assert.equal(calls[1].headers["If-None-Match"], "*");
  } finally { globalThis.fetch = real; }
});
