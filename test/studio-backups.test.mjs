/**
 * Kleo Studio's backup providers (20 October 2026): which ePhone orders may move to APIMart or WaveSpeed when ePhone
 * cannot take them, what each backup is sent, that a backup never costs more than ePhone for any clip or picture Kleo
 * sells, and the APIMart client's reading of its answers. Imports the TypeScript sources directly (Node 22.18+).
 * Run: node --test test/studio-backups.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { backupRoutes, geminiTier, gptAspect, withinBudget } from "../src/studio/backups.ts";
import { MODELS, clipCostUsd, taskInput } from "../src/studio/models.ts";
import { IMAGE_MODELS, imageCostUsd, imageTaskInput } from "../src/studio/image-models.ts";
import { planTool } from "../src/studio/tools.ts";
import { apimart, apimartSubmit, apimartTask, readApimartTask, MUSIC_PREFIX } from "../src/apimart.ts";

const pic = (id) => ({ id, url: `https://app.example/media/u/${id}?sig=x`, kind: "image", seconds: null, width: 1000, height: 1000, type: "image/jpeg" });
const clip = (id, seconds = 5, height = 1080) => ({ id, url: `https://app.example/media/u/${id}?sig=x`, kind: "video", seconds, width: Math.round(height * 16 / 9), height, type: "video/mp4" });
const settings = (model, resolution, duration, extra = {}) => ({ model, resolution, duration, aspect: "16:9", audio: true, imageRole: "none", videoRole: "none", ...extra });

test("only the models whose backup costs the same or less move; the dearer ones never do", () => {
  const moves = (model, s) => backupRoutes(MODELS.find((m) => m.key === model).ephoneModel, taskInput(s, "a fox", [])).length > 0;
  assert.equal(moves("seedance-2.0-fast", settings("seedance-2.0-fast", "480p", 5)), true);
  assert.equal(moves("seedance-2.0-fast", settings("seedance-2.0-fast", "720p", 10)), true);
  assert.equal(moves("veo-3.1-fast", settings("veo-3.1-fast", "720p", 8)), true);
  // Dearer on every other provider (kleo\PROVIDER_COSTS.md, section 6): they stay on ePhone.
  for (const r of ["480p", "720p", "1080p"]) {
    assert.equal(moves("seedance-2.5", settings("seedance-2.5", r, 5)), false, `2.5 ${r}`);
    assert.equal(moves("seedance-2.0", settings("seedance-2.0", r, 5)), false, `2.0 ${r}`);
    // WaveSpeed's Wan 3.0 is about 38% dearer than ePhone's (29 October 2026).
    assert.equal(moves("wan-3.0", settings("wan-3.0", r, 10)), false, `Wan 3.0 ${r}`);
  }
  assert.equal(moves("veo-3.1", settings("veo-3.1", "720p", 8)), false);
  assert.equal(moves("veo-3.1-fast", settings("veo-3.1-fast", "1080p", 8)), false, "APIMart's 1080p Veo Fast is 21% dearer");
  for (const k of ["flux-3-image", "flux-2-pro"]) assert.deepEqual(backupRoutes(k, { prompt: "x", aspect_ratio: "1:1" }), [], k);
  assert.deepEqual(backupRoutes("flux-2-pro", { prompt: "x", images: ["https://a/1.jpg"] }), [], "one reference costs less on ePhone");
  for (const k of ["kling_avatar_image2video", "kling_advanced_lip_sync", "aleph2/video-to-video", "flux-tools/vto-v1", "flux-tools/video-edit-v1", "flux-tools/video-upscale-v1"]) {
    assert.deepEqual(backupRoutes(k, { prompt: "x" }), [], k);
  }
});

test("a backup never costs more than ePhone, for any clip or picture Kleo sells", () => {
  for (const m of MODELS) {
    for (const res of m.resolutions) for (const d of m.durations) {
      const s = settings(m.key, res, d);
      for (const r of withinBudget(backupRoutes(m.ephoneModel, taskInput(s, "a fox", [])), clipCostUsd(s))) {
        assert.ok(r.usd !== null && r.usd <= clipCostUsd(s) * 1.01, `${m.key} ${res} ${d}s: ${r.usd} vs ${clipCostUsd(s)}`);
      }
    }
  }
  for (const m of IMAGE_MODELS) for (const q of m.qualities) {
    const s = { model: m.key, aspect: "1:1", quality: q, count: 1 };
    for (const refs of [[], ["https://a/1.jpg"], ["https://a/1.jpg", "https://a/2.jpg", "https://a/3.jpg"]]) {
      for (const r of withinBudget(backupRoutes(m.ephoneModel, imageTaskInput(s, "a fox", refs)), imageCostUsd(s))) {
        assert.ok(r.usd !== null && r.usd <= imageCostUsd(s) * 1.01, `${m.key} ${q} ${refs.length} refs: ${r.usd} vs ${imageCostUsd(s)}`);
      }
    }
  }
  // Every backup Kleo would take survives the budget it was priced at (only FLUX.2 Pro's plain picture drops, below).
  for (const m of MODELS) for (const res of m.resolutions) {
    const s = settings(m.key, res, m.defaultDuration);
    assert.equal(withinBudget(backupRoutes(m.ephoneModel, taskInput(s, "x", [])), clipCostUsd(s)).length, backupRoutes(m.ephoneModel, taskInput(s, "x", [])).length, `${m.key} ${res}`);
  }
  const flux = imageTaskInput({ model: "flux-2-pro", aspect: "1:1", quality: "1K", count: 1 }, "x", ["https://a/1.jpg", "https://a/2.jpg"]);
  assert.equal(backupRoutes("flux-2-pro", flux).length, 1);
  assert.deepEqual(withinBudget(backupRoutes("flux-2-pro", flux), imageCostUsd({ model: "flux-2-pro", aspect: "1:1", quality: "1K", count: 1 })), [], "a $0.016 picture never goes to a $0.06 edit");
  const swap = planTool("character-swap", { engine: "kling", quality: "720p" }, { video: clip("v"), image: pic("c"), frame: pic("f") });
  assert.equal(withinBudget(backupRoutes(swap.tasks[0].model, swap.tasks[0].input), swap.usd).length, 1, "Character Swap's frame does");
  const music = planTool("music", { prompt: "upbeat pop", vocals: "female" }, {});
  assert.ok(backupRoutes(music.tasks[0].model, music.tasks[0].input)[0].usd <= music.usd);
  const sfx = planTool("sfx", { prompt: "thunder" }, {});
  assert.ok(backupRoutes(sfx.tasks[0].model, sfx.tasks[0].input)[0].usd <= sfx.usd);
});

test("Seedance 2.0 Fast on APIMart: the same clip, first frame, references and clips", () => {
  const text = backupRoutes("doubao-seedance-2-0-fast-260128", taskInput(settings("seedance-2.0-fast", "480p", 10, { aspect: "9:16" }), "a fox", []))[0];
  assert.equal(text.provider, "apimart");
  assert.equal(text.path, "/v1/videos/generations");
  assert.deepEqual(text.body, { model: "seedance-2.0-fast", prompt: "a fox", duration: 10, resolution: "480p", size: "9:16", generate_audio: true });
  assert.equal(text.usd, 0.3984);
  const first = backupRoutes("doubao-seedance-2-0-fast-260128", taskInput(settings("seedance-2.0-fast", "720p", 5, { imageRole: "first_frame" }), "go", ["https://a/p.jpg"]))[0];
  assert.deepEqual(first.body.image_with_roles, [{ url: "https://a/p.jpg", role: "first_frame" }]);
  assert.equal(first.body.size, "adaptive");
  const omni = backupRoutes("doubao-seedance-2-0-fast-260128", taskInput(settings("seedance-2.0-fast", "480p", 5, { imageRole: "reference", videoRole: "reference" }), "image 1 dances like video 1", ["https://a/p.jpg"], undefined, { videos: ["https://a/v.mp4"], audios: ["https://a/s.mp3"] }))[0];
  assert.deepEqual([omni.body.image_urls, omni.body.video_urls, omni.body.audio_urls], [["https://a/p.jpg"], ["https://a/v.mp4"], ["https://a/s.mp3"]]);
  assert.equal(omni.body.image_with_roles, undefined);
});

test("Veo 3.1 Fast at 720p, Kling copy-motion, Character Swap, Motion Control and Video Face Swap on APIMart", () => {
  const veo = backupRoutes("veo-3.1-fast-generate-preview", taskInput(settings("veo-3.1-fast", "720p", 8, { imageRole: "first_frame" }), "a fox", ["https://a/p.jpg"]))[0];
  assert.equal(veo.body.model, "veo3.1-fast-official");
  assert.equal(veo.body.first_frame_image, "https://a/p.jpg");
  assert.equal(veo.body.resolution, "720p");
  assert.equal(veo.usd, 0.64);
  assert.deepEqual(backupRoutes("veo-3.1-fast-generate-preview", taskInput(settings("veo-3.1-fast", "720p", 8, { imageRole: "reference" }), "x", ["https://a/1.jpg", "https://a/2.jpg"])), [], "no reference pictures on APIMart's Veo");

  const k = backupRoutes("kling-3.0-omni/omni-video", taskInput(settings("kling-3-omni", "1080p", 6, { imageRole: "first_frame", videoRole: "motion" }), "a car", ["https://a/p.jpg"], undefined, { videos: ["https://a/v.mp4"], audios: [] }))[0];
  assert.equal(k.body.model, "kling-v3-omni");
  assert.equal(k.body.mode, "pro");
  assert.deepEqual(k.body.image_with_roles, [{ url: "https://a/p.jpg", role: "first_frame" }]);
  assert.deepEqual(k.body.video_list, [{ video_url: "https://a/v.mp4", refer_type: "feature", keep_original_sound: "no" }]);
  assert.equal(k.body.audio, undefined, "APIMart refuses audio next to a video");

  const swap = planTool("character-swap", { engine: "kling", quality: "1080p" }, { video: clip("v"), image: pic("c"), frame: pic("f") });
  const frame = backupRoutes(swap.tasks[0].model, swap.tasks[0].input)[0];
  assert.deepEqual([frame.provider, frame.model, frame.usd], ["wavespeed", "wavespeed-ai/flux-2-pro/edit", 0.06]);
  const next = JSON.parse(JSON.stringify(swap.tasks[0].then.input).split("{{prev}}").join("https://cdn/frame.jpg"));
  const o1 = backupRoutes(swap.tasks[0].then.model, next)[0];
  assert.equal(o1.body.model, "kling-video-o1");
  assert.equal(o1.body.mode, "pro");
  assert.deepEqual(o1.body.video_list, [{ video_url: clip("v").url, refer_type: "base", keep_original_sound: "yes" }]);
  assert.deepEqual(o1.body.image_with_roles.map((x) => x.url), ["https://cdn/frame.jpg", pic("c").url]);
  assert.match(o1.body.prompt, /^<<<image_1>>> is reference image 1\. <<<image_2>>> is reference image 2\. Reference image 1 is the first frame/);

  const mc = planTool("motion-control", { quality: "720p", prompt: "neon stage" }, { image: pic("c"), video: clip("v", 8) });
  const m = backupRoutes(mc.tasks[0].model, mc.tasks[0].input)[0];
  assert.deepEqual(m.body, { model: "kling-v3-motion-control", prompt: "neon stage", image_url: pic("c").url, video_url: clip("v", 8).url, character_orientation: "video", mode: "std", keep_original_sound: "yes" });

  const fs = planTool("video-face-swap", {}, { video: clip("v", 8), face: pic("f") });
  const h = backupRoutes(fs.tasks[0].model, fs.tasks[0].input)[0];
  assert.deepEqual([h.body.model, h.body.video_url, h.body.image_urls, h.body.resolution, h.body.audio_setting], ["happyhorse-1.0", clip("v", 8).url, [pic("f").url], "720P", "origin"]);
});

test("pictures: Nano Banana on APIMart's ext route with no paid fallback, Seedream Lite, GPT Image on WaveSpeed", () => {
  const nbp = IMAGE_MODELS.find((m) => m.key === "nano-banana-pro");
  const r = backupRoutes(nbp.ephoneModel, imageTaskInput({ model: "nano-banana-pro", aspect: "4:5", quality: "4K", count: 1 }, "a fox", ["https://a/1.jpg"]))[0];
  assert.deepEqual(r.body, { model: "gemini-3-pro-image-preview", prompt: "a fox", size: "4:5", resolution: "4K", n: 1, official_fallback: false, image_urls: ["https://a/1.jpg"] });
  assert.equal(r.usd, 0.04);
  assert.equal(backupRoutes("gemini-3.1-flash-image", { prompt: "x", aspect_ratio: "1:1", quality: "high" })[0].body.model, "gemini-3.1-flash-image-preview");
  assert.equal(backupRoutes("gemini-nano-banana-2.1", { prompt: "x", aspect_ratio: "1:1", quality: "1K" })[0].body.model, "gemini-nano-banana-2.1-ext");
  assert.deepEqual(["medium", "high", "max", "1K", "2K", "4K", undefined].map(geminiTier), ["1K", "2K", "4K", "1K", "2K", "4K", "1K"]);
  // Face Swap and Photo Character Swap are Nano Banana Pro too.
  const face = planTool("face-swap", {}, { target: pic("t"), face: pic("f") });
  assert.equal(backupRoutes(face.tasks[0].model, face.tasks[0].input)[0].body.resolution, "2K");

  const sd = backupRoutes("doubao-seedream-5-0-260128", imageTaskInput({ model: "seedream-5", aspect: "16:9", quality: "2K", count: 1 }, "a fox", []))[0];
  assert.deepEqual([sd.body.model, sd.body.size, sd.body.resolution], ["seedream-5-0-lite", "16:9", "2K"]);

  const gpt = backupRoutes("gpt-image-2.5-sunburst", imageTaskInput({ model: "gpt-image-2.5", aspect: "16:9", quality: "2K", count: 1 }, "a fox", ["https://a/1.jpg", "https://a/2.jpg"]))[0];
  assert.deepEqual([gpt.provider, gpt.path, gpt.body.aspect_ratio, gpt.body.resolution, gpt.body.quality], ["wavespeed", "openai/gpt-image-2.5-sunburst/edit", "16:9", "2k", "high"]);
  assert.equal(gpt.usd, 0.18);
  assert.deepEqual(backupRoutes("gpt-image-2.5-sunburst", { prompt: "x", size: "1024x1024", images: ["1", "2", "3", "4"].map((n) => `https://a/${n}.jpg`) }), [], "four references would cost more than Kleo charges");
  assert.deepEqual(gptAspect("1024x1536"), { aspect: "2:3", resolution: "1k" });
});

test("music and sound effects on APIMart's Suno, read at the music address", () => {
  const song = planTool("music", { prompt: "upbeat K-pop", vocals: "male" }, {});
  const s = backupRoutes(song.tasks[0].model, song.tasks[0].input)[0];
  assert.deepEqual(s.body, { model: "suno", custom: false, version: "v6", prompt: "upbeat K-pop", instrumental: false, vocal_gender: "Male" });
  assert.deepEqual([s.path, s.music], ["/v1/music/generations", true]);
  const fx = planTool("sfx", { prompt: "thunder", loop: "loop" }, {});
  const f = backupRoutes(fx.tasks[0].model, fx.tasks[0].input)[0];
  assert.deepEqual([f.path, f.body], ["/v1/music/generations/sounds", { model: "suno", version: "v6", prompt: "thunder", type: "loop" }]);
});

test("the APIMart client: task ids, results of every kind, failures, and an empty balance read as 402", async () => {
  const done = readApimartTask({ id: "task_1", status: "completed", cost: 0.03, result: { images: [{ url: ["https://upload.apimart.ai/f/image/a.png"], expires_at: 1 }] } });
  assert.deepEqual([done.status, done.outputs, done.cost], ["completed", ["https://upload.apimart.ai/f/image/a.png"], 0.03]);
  assert.deepEqual(readApimartTask({ status: "completed", result: { videos: [{ url: "https://x/v.mp4", cover: "https://x/c.jpg" }] } }).outputs, ["https://x/v.mp4", "https://x/c.jpg"]);
  const song = readApimartTask({ status: "completed", result: { music: [{ audio_url: "https://x/1.mp3", image_url: "https://x/1.jpg" }, { audio_url: "https://x/2.mp3" }] } });
  assert.deepEqual(song.outputs, ["https://x/1.mp3", "https://x/2.mp3"], "only the songs, not their covers");
  assert.equal(readApimartTask({ status: "processing" }).status, "in_progress");
  assert.equal(readApimartTask({ status: "pending" }).status, "in_progress");
  const failed = readApimartTask({ status: "failed", error: { code: "task_failed", message: "content flagged" } });
  assert.deepEqual([failed.status, failed.error], ["failed", "content flagged"]);

  const real = globalThis.fetch;
  const sent = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      sent.push({ url: String(url), init });
      if (String(url).endsWith("/v1/videos/generations")) return new Response(JSON.stringify({ code: 200, data: [{ status: "submitted", task_id: "task_01K" }] }));
      if (String(url).includes("/v1/music/tasks/m_1")) return new Response(JSON.stringify({ code: 200, data: { status: "completed", result: { music: [{ audio_url: "https://x/1.mp3" }] } } }));
      if (String(url).endsWith("/v1/images/generations")) return new Response(JSON.stringify({ error: { code: 402, message: "Insufficient balance", type: "payment_required" } }), { status: 402 });
      return new Response(JSON.stringify({ error: { code: 400, message: "bad size", type: "invalid_request_error" } }), { status: 400 });
    };
    const env = { APIMART_API_KEY: "ak" };
    assert.equal(await apimartSubmit(env, "/v1/videos/generations", { model: "seedance-2.0-fast" }), "task_01K");
    assert.equal(sent[0].init.headers.authorization, "Bearer ak");
    assert.deepEqual((await apimartTask(env, `${MUSIC_PREFIX}m_1`)).outputs, ["https://x/1.mp3"]);
    await assert.rejects(apimartSubmit(env, "/v1/images/generations", {}), (e) => e.status === 402);
    await assert.rejects(apimart(env, "POST", "/v1/other", {}), (e) => e.status === 400 && /bad size/.test(e.message) && !e.retryable);
    await assert.rejects(apimart({}, "GET", "/v1/tasks/x"), /APIMART_API_KEY is not set/);
  } finally { globalThis.fetch = real; }
});
