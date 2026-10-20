/**
 * Kleo Studio, the pure parts: model catalog and prices, the provider input per model, sessions, passwords and
 * signed links, the agent's proposals. Imports the TypeScript sources directly (Node 22.18+ strips the types).
 * Run: node --test test/studio-models.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, normalizeSettings, clipCredits, clipCostUsd, taskInput, freeModels, publicCatalog, modelByKey, pictureProblem, wanCostUsd, wanOffered, wanOrder } from "../src/studio/models.ts";
import { makeSession, readSession, hashPassword, checkPassword, passwordProblem, signPath, checkSignedPath, readCookie } from "../src/studio/session.ts";
import { proposalFrom, fallbackProposal, systemPrompt, chatTitle, runAgent } from "../src/studio/agent.ts";

test("every model has a price for every resolution it offers, and defaults it offers", () => {
  for (const m of MODELS) {
    for (const r of m.resolutions) assert.ok(m.usdPerSecond[r] > 0, `${m.key} ${r}`);
    assert.ok(m.durations.includes(m.defaultDuration), m.key);
    assert.ok(m.resolutions.includes(m.defaultResolution), m.key);
    assert.ok(m.aspects.includes("16:9") && m.aspects.includes("9:16"), m.key);
  }
});

test("credits: the price table the owner signs off (margin 1.6, 1 credit = 0.44 $)", () => {
  const c = (model, duration, resolution) => clipCredits({ model, duration, resolution, aspect: "16:9", audio: true, imageRole: "none" });
  // 15 October 2026: the owner's mark-up on Fast (480p ×2, 720p ×1.5): 2/4/6 and 3/6/9 credits.
  assert.equal(c("seedance-2.0-fast", 5, "480p"), 2);
  assert.equal(c("seedance-2.0-fast", 10, "480p"), 4);
  assert.equal(c("seedance-2.0-fast", 15, "480p"), 6);
  assert.equal(c("seedance-2.0-fast", 5, "720p"), 3);
  assert.equal(c("seedance-2.0", 5, "720p"), 3);
  assert.equal(c("seedance-2.5", 5, "480p"), 2);
  assert.equal(c("seedance-2.5", 5, "720p"), 4);
  assert.equal(c("seedance-2.5", 5, "1080p"), 9);
  assert.equal(c("veo-3.1-fast", 8, "1080p"), 3);
  assert.equal(c("veo-3.1", 8, "1080p"), 7);
  // Never sold under 1.5× its provider cost.
  for (const m of MODELS) for (const r of m.resolutions) for (const d of m.durations) {
    const s = { model: m.key, duration: d, resolution: r, aspect: "16:9", audio: true, imageRole: "none" };
    assert.ok(clipCredits(s) * 0.44 >= clipCostUsd(s) * 1.5, `${m.key} ${r} ${d}s`);
  }
});

test("settings are always made valid for the model", () => {
  const veo = normalizeSettings({ model: "veo-3.1", duration: 5, resolution: "480p", aspect: "1:1" }, 0);
  assert.deepEqual([veo.duration, veo.resolution, veo.aspect, veo.imageRole], [6, "1080p", "16:9", "none"]);
  const unknown = normalizeSettings({ model: "sora-9" }, 0);
  assert.equal(unknown.model, "seedance-2.5");
  assert.equal(normalizeSettings({ model: "seedance-2.5", duration: 30 }, 0).duration, 15);
  assert.equal(normalizeSettings({ model: "seedance-2.5" }, 1).imageRole, "first_frame");
  assert.equal(normalizeSettings({ model: "seedance-2.5", imageRole: "first_frame" }, 3).imageRole, "reference");
  assert.equal(normalizeSettings({ model: "seedance-2.5", audio: false }, 0).audio, false);
});

test("provider input: Seedance first frame forces the adaptive ratio; Veo takes images[] or reference_images", () => {
  const s = normalizeSettings({ model: "seedance-2.5", aspect: "9:16" }, 1);
  const i = taskInput(s, "a cat", ["https://x/a.jpg"], "abc");
  assert.equal(i.first_frame, "https://x/a.jpg");
  assert.equal(i.aspect_ratio, "adaptive");
  assert.equal(i.watermark, false);
  assert.equal(i.safety_identifier, "abc");
  const text = taskInput(normalizeSettings({ model: "seedance-2.0-fast", aspect: "9:16", resolution: "480p" }, 0), "a cat", []);
  assert.deepEqual({ a: text.aspect_ratio, r: text.resolution, d: text.duration, f: text.first_frame }, { a: "9:16", r: "480p", d: 5, f: undefined });
  const refs = taskInput(normalizeSettings({ model: "seedance-2.0" }, 3), "p", ["1", "2", "3"]);
  assert.deepEqual(refs.reference_images, ["1", "2", "3"]);
  const veo = taskInput(normalizeSettings({ model: "veo-3.1", aspect: "9:16" }, 1), "p", ["u"]);
  assert.deepEqual(veo.images, ["u"]);
  assert.equal(veo.aspect_ratio, "9:16");
  assert.equal(veo.duration, 8);
  const veoRefs = taskInput(normalizeSettings({ model: "veo-3.1-fast" }, 5), "p", ["1", "2", "3", "4", "5"]);
  assert.equal(veoRefs.reference_images.length, 3);
  assert.equal(modelByKey("veo-3.1").routing["X-Provider-Order"], "official_cheap");
});

test("free models: default, list and star", () => {
  assert.deepEqual(freeModels(undefined), ["seedance-2.0-fast"]);
  assert.deepEqual(freeModels("seedance-2.0, nope ,veo-3.1-fast"), ["seedance-2.0", "veo-3.1-fast"]);
  assert.equal(freeModels("*").length, MODELS.length);
  const cat = publicCatalog(1.6, ["seedance-2.0-fast"]);
  assert.equal(cat.find((m) => m.key === "seedance-2.0-fast").free, true);
  assert.equal(cat.find((m) => m.key === "seedance-2.5").prices["720p"][5], 4);
  assert.ok(!JSON.stringify(cat).includes("ephone") && !JSON.stringify(cat).includes("doubao"), "no provider names reach the page");
});

test("sessions: signed, expiring, tamper-proof", async () => {
  const v = await makeSession("sec", "u_abc", Date.parse("2026-10-13T00:00:00Z"));
  assert.equal(await readSession("sec", v, Date.parse("2026-10-14T00:00:00Z")), "u_abc");
  assert.equal(await readSession("other", v, Date.parse("2026-10-14T00:00:00Z")), null);
  assert.equal(await readSession("sec", v.replace("u_abc", "u_abd"), Date.parse("2026-10-14T00:00:00Z")), null);
  assert.equal(await readSession("sec", v, Date.parse("2027-01-01T00:00:00Z")), null, "60 days, then gone");
  assert.equal(readCookie("a=1; kleo_studio=xyz; b=2", "kleo_studio"), "xyz");
});

test("passwords: PBKDF2, salted, verified", async () => {
  const h1 = await hashPassword("correct horse", 1000), h2 = await hashPassword("correct horse", 1000);
  assert.notEqual(h1, h2);
  assert.equal(await checkPassword("correct horse", h1), true);
  assert.equal(await checkPassword("wrong horse", h1), false);
  assert.equal(await checkPassword("x", null), false);
  assert.equal(passwordProblem("short"), "Use at least 8 characters.");
  assert.equal(passwordProblem("long enough"), null);
});

test("signed links: path-bound and time-limited", async () => {
  const now = Date.parse("2026-10-13T00:00:00Z");
  const link = await signPath("sec", "/media/g_abc.mp4", 3600, now);
  const u = new URL("https://x" + link);
  assert.equal(await checkSignedPath("sec", "/media/g_abc.mp4", u.searchParams.get("exp"), u.searchParams.get("sig"), now), true);
  assert.equal(await checkSignedPath("sec", "/media/g_abd.mp4", u.searchParams.get("exp"), u.searchParams.get("sig"), now), false);
  assert.equal(await checkSignedPath("sec", "/media/g_abc.mp4", u.searchParams.get("exp"), u.searchParams.get("sig"), now + 7200e3), false);
});

const ctx = (over = {}) => ({ history: [], text: "a dragon over Venice", uploads: [], ui: { model: "seedance-2.5", duration: 5, resolution: "720p", aspect: "16:9" }, credits: 10, allowed: ["seedance-2.5", "seedance-2.0", "seedance-2.0-fast", "veo-3.1", "veo-3.1-fast"], margin: 1.6, ...over });

test("agent proposals: priced, valid, and never a model the account cannot use", () => {
  const p = proposalFrom({ title: "Dragon", prompt: "A dragon glides over Venice", model: "veo-3.1", duration: 8, aspect: "9:16" }, ctx());
  assert.equal(p.settings.model, "veo-3.1");
  assert.equal(p.settings.aspect, "9:16");
  assert.equal(p.credits, 7);
  const locked = proposalFrom({ title: "Dragon", prompt: "x", model: "veo-3.1" }, ctx({ allowed: ["seedance-2.0-fast"], ui: { model: "seedance-2.5" } }));
  assert.equal(locked.settings.model, "seedance-2.0-fast");
  assert.equal(proposalFrom({ title: "x", prompt: "  " }, ctx()), null);
  const withPic = proposalFrom({ title: "x", prompt: "y", image_role: "none" }, ctx({ uploads: [{ id: "up_a" }] }));
  assert.deepEqual(withPic.imageIds, []);
  assert.equal(fallbackProposal(ctx({ text: "" })), null);
  assert.ok(systemPrompt(ctx({ allowed: ["seedance-2.0-fast"] })).includes("[LOCKED"));
  assert.equal(chatTitle("", true), "Animate a picture");
  assert.ok(chatTitle("x".repeat(80), false).length <= 42);
});

test("agent: a tool call becomes a card; an unreachable model still gives a usable card", async () => {
  const real = globalThis.fetch;
  try {
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      return new Response(JSON.stringify({ choices: [{ message: { content: "Here it is!", tool_calls: [{ function: { name: "propose_video", arguments: JSON.stringify({ title: "Dragon", prompt: "A red dragon over Venice at dawn", model: "seedance-2.5", duration: 10 }) } }] } }] }), { status: 200 });
    };
    const r = await runAgent({ EPHONE_API_KEY: "k" }, ctx(), ["data:image/jpeg;base64,AAAA"]);
    assert.equal(r.text, "Here it is!");
    assert.equal(r.proposal.settings.duration, 10);
    assert.equal(sent.body.model, "claude-haiku-5-5");
    assert.equal(sent.body.tools[0].function.name, "propose_video");
    assert.equal(sent.body.messages.at(-1).content.at(-1).image_url.url, "data:image/jpeg;base64,AAAA");
    assert.match(sent.url, /\/v1\/chat\/completions$/);
    globalThis.fetch = async () => new Response("boom", { status: 500 });
    const f = await runAgent({ EPHONE_API_KEY: "k" }, ctx(), []);
    assert.equal(f.fallback, true);
    assert.equal(f.proposal.prompt, "a dragon over Venice");
  } finally { globalThis.fetch = real; }
});

import { IMAGE_MODELS, normalizeImageSettings, imageCredits, imageCostUsd, imageTaskInput, freeImageModels, publicImageCatalog, imageAlternatives, alternativeFor, isContentRefusal, gptImageSize } from "../src/studio/image-models.ts";
import { imageProposalFrom } from "../src/studio/agent.ts";

test("image models: every quality priced; credits per set; never under 1.5× cost", () => {
  for (const m of IMAGE_MODELS) for (const q of m.qualities) assert.ok(m.usd[q] > 0, `${m.key} ${q}`);
  const c = (model, quality, count) => imageCredits({ model, aspect: "1:1", quality, count });
  assert.equal(c("nano-banana-pro", "2K", 1), 1);
  assert.equal(c("nano-banana-pro", "2K", 4), 2);
  assert.equal(c("nano-banana-2", "2K", 4), 1);
  assert.equal(c("seedream-5", "2K", 4), 1);
  for (const m of IMAGE_MODELS) for (const q of m.qualities) for (const n of [1, 2, 4]) {
    const s = { model: m.key, aspect: "1:1", quality: q, count: n };
    assert.ok(imageCredits(s) * 0.44 >= imageCostUsd(s) * 1.5, `${m.key} ${q} ×${n}`);
  }
  assert.deepEqual(freeImageModels(undefined), ["nano-banana-2", "seedream-5", "flux-2-pro"], "Nano Banana Pro, 2.1, FLUX 3 and GPT Image 2.5 unlock with the first purchase");
  assert.equal(c("nano-banana-2.1", "4K", 4), 1, "Nano Banana 2.1: 4 pictures at 4K cost about $0.26, one credit");
  assert.equal(publicImageCatalog(1.6, ["seedream-5"]).find((m) => m.key === "seedream-5").prices["2K"][4], 1);
});

test("image settings and provider input per model", () => {
  const s = normalizeImageSettings({ model: "seedream-5", aspect: "9:16", quality: "4K", count: 3 });
  assert.deepEqual(s, { model: "seedream-5", aspect: "9:16", quality: "2K", count: 1 });
  const sd = imageTaskInput(s, "a cat", ["https://x/a.jpg"]);
  assert.equal(sd.size, "1440x2560");
  assert.equal(sd.watermark, false, "Seedream watermarks by default");
  assert.deepEqual(sd.images, ["https://x/a.jpg"]);
  const nb = imageTaskInput(normalizeImageSettings({ model: "nano-banana-pro", aspect: "4:5", quality: "4K" }), "a cat", []);
  assert.deepEqual({ a: nb.aspect_ratio, q: nb.quality, i: nb.images }, { a: "4:5", q: "max", i: undefined }, "Gemini takes auto|low|medium|high|xhigh|max since 15 Oct 2026");
  assert.equal(imageTaskInput(normalizeImageSettings({ model: "nano-banana-pro", quality: "4K" }), "a cat", [], true).quality, "4K", "the retry uses the other spelling");
  const nb21 = imageTaskInput(normalizeImageSettings({ model: "nano-banana-2.1", aspect: "4:5", quality: "1K" }), "a cat", []);
  assert.deepEqual(nb21, { prompt: "a cat", aspect_ratio: "4:5", quality: "1K" }, "2.1 follows its schema: 1K/2K/4K, no output_format");
  assert.equal(imageTaskInput(normalizeImageSettings({ model: "nano-banana-2.1", quality: "2K" }), "x", [], true).quality, "high");
  const fx = imageTaskInput(normalizeImageSettings({ model: "flux-2-pro", aspect: "16:9" }), "x", []);
  assert.equal(fx.aspect_ratio, "16:9");
  assert.equal(normalizeImageSettings({ model: "nope" }).model, "nano-banana-2");
});

test("FLUX 3 and GPT Image 2.5 (19 October 2026): their schemas, their prices", () => {
  const f = imageTaskInput(normalizeImageSettings({ model: "flux-3", aspect: "16:9", quality: "4K" }), "x", ["https://x/a.jpg"]);
  assert.deepEqual(f, { prompt: "x", aspect_ratio: "16:9", resolution: "4k", safety_tolerance: 2, grounding: false, images: ["https://x/a.jpg"] });
  assert.equal(imageCredits({ model: "flux-3", aspect: "1:1", quality: "2K", count: 1 }), 1);
  assert.equal(imageCredits({ model: "flux-3", aspect: "1:1", quality: "4K", count: 1 }), 2, "4K is $0.607 a picture");
  const g = imageTaskInput(normalizeImageSettings({ model: "gpt-image-2.5", aspect: "16:9", quality: "2K" }), "x", ["https://x/a.jpg"]);
  assert.deepEqual(g, { prompt: "x", size: "2048x1152", quality: "high", n: 1, moderation: "low", output_format: "jpeg", output_compression: 95, images: ["https://x/a.jpg"], input_fidelity: "high" });
  assert.equal(imageTaskInput(normalizeImageSettings({ model: "gpt-image-2.5" }), "x", []).input_fidelity, undefined, "text-to-image takes no input_fidelity");
  for (const a of ["1:1", "4:5", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "21:9"]) for (const q of ["1K", "2K"]) {
    const [w, h] = gptImageSize(a, q).split("x").map(Number);
    assert.ok(w % 16 === 0 && h % 16 === 0 && w * h >= 655_360 && w * h <= 3_686_400 && Math.max(w, h) <= 3840 && Math.max(w / h, h / w) <= 3, `${a} ${q}: ${w}x${h}`);
  }
});

test("a refused picture: Google/ByteDance/OpenAI go to FLUX 3; only Protected Content raises FLUX 3's tolerance", () => {
  assert.ok(isContentRefusal("no image generated in response"));
  assert.ok(isContentRefusal("The request failed because the output image may contain sensitive information. Request id: 0217"));
  assert.ok(isContentRefusal('Content Moderated: {"Moderation Reasons":["Protected Content"]}'));
  assert.ok(!isContentRefusal("quality must be one of 1K, 2K, 4K"), "a quality spelling refusal is not a content refusal");
  assert.ok(!isContentRefusal("quota is not enough"));
  const nb = imageAlternatives(normalizeImageSettings({ model: "nano-banana-pro", aspect: "4:5", quality: "4K" }), "x", ["https://x/a.jpg"]);
  assert.deepEqual(nb.map((a) => [a.when, a.model, a.input.safety_tolerance, a.input.resolution]), [["refusal", "flux-3-image", 2, "2k"], ["protected", "flux-3-image", 4, "2k"]]);
  const own = imageAlternatives(normalizeImageSettings({ model: "flux-3", quality: "4K" }), "x", []);
  assert.deepEqual(own.map((a) => [a.when, a.input.safety_tolerance, a.input.resolution]), [["protected", 4, "4k"]], "FLUX 3 itself: only the Protected Content retry, same resolution");
  assert.deepEqual(imageAlternatives(normalizeImageSettings({ model: "flux-2-pro" }), "x", []), []);
  assert.equal(alternativeFor(nb, "no image generated in response").when, "refusal");
  assert.equal(alternativeFor(own, "Content Moderated: NSFW"), null, "nudity is never retried at a higher tolerance");
  assert.equal(alternativeFor(own, 'Content Moderated: {"Moderation Reasons":["Protected Content"]}').input.safety_tolerance, 4);
});

test("agent picture cards: priced, on an allowed model", () => {
  const ctx = { history: [], text: "logo", uploads: [{ id: "up_a" }], ui: {}, uiImage: { model: "nano-banana-2" }, mode: "image", credits: 5, allowed: [], allowedImages: ["nano-banana-2"], margin: 1.6 };
  const p = imageProposalFrom({ title: "Logo", prompt: "A fox logo", model: "nano-banana-pro", count: 4 }, ctx);
  assert.equal(p.kind, "image");
  assert.equal(p.settings.model, "nano-banana-2");
  assert.equal(p.settings.count, 4);
  assert.deepEqual(p.imageIds, ["up_a"]);
  assert.deepEqual(imageProposalFrom({ title: "x", prompt: "y", use_images: false }, ctx).imageIds, []);
});

test("copy motion: one picture + one video becomes Kling 3.0 Omni with the picture as first frame and the video as feature video", () => {
  const refs = { images: 1, videos: 1, audios: 0, videoSeconds: 6 };
  const s = normalizeSettings({ model: "seedance-2.5", videoRole: "motion", resolution: "720p", duration: 5 }, 1, { ...refs, videoSeconds: 5.2 });
  assert.deepEqual(s, { model: "kling-3-omni", duration: 5, resolution: "720p", aspect: "16:9", audio: false, imageRole: "first_frame", videoRole: "motion" });
  assert.equal(normalizeSettings({ videoRole: "motion", duration: 10 }, 1, { ...refs, videoSeconds: 3.83 }).duration, 4, "as long as the clip it copies: no time left to start the movement again");
  assert.equal(normalizeSettings({ videoRole: "motion" }, 1, { ...refs, videoSeconds: 2.1 }).duration, 3, "Kling's shortest");
  assert.equal(normalizeSettings({ videoRole: "motion" }, 2, { ...refs, images: 2 }).model, "seedance-2.5", "two pictures: no single first frame, Seedance reference");
  assert.equal(normalizeSettings({ videoRole: "motion" }, 2, { ...refs, images: 2 }).videoRole, "reference");
  assert.equal(normalizeSettings({ model: "kling-3-omni" }, 0, { images: 0, videos: 0, audios: 0, videoSeconds: 0 }).model, "seedance-2.5", "Kling is only for copying motion");
  const input = taskInput(s, "The shot starts on the first frame.", ["https://k/img"], "safety", { videos: ["https://k/vid"], audios: [] });
  assert.deepEqual(input.contents.map((c) => [c.type, c.url ?? null]), [["prompt", null], ["first_frame", "https://k/img"], ["feature_video", "https://k/vid"]]);
  assert.match(input.contents[0].text, /^The shot starts on the first frame\. One continuous take that ends exactly where the reference video ends.*never bends, melts, morphs/);
  assert.deepEqual(input.settings, { resolution: "720p", aspect_ratio: "16:9", duration: 5, audio: "off", multi_shot: false });
  assert.equal(clipCredits(s, 1.6, 6), 2, "5 s 720p: 5 x 0.9 x 0.8 CNY = $0.51");
  assert.equal(clipCredits({ ...s, resolution: "1080p" }, 1.6, 6), 3, "5 s 1080p: $0.69");
  assert.equal(publicCatalog(1.6).find((m) => m.key === "kling-3-omni").motionOnly, true, "never offered in the picker");
});

test("Wan 3.0 after a copyright refusal: offered for Seedance clips only, always within the credits, the right route", () => {
  const s = (o) => normalizeSettings(o, o.images ?? 0);
  // Every Seedance length and resolution costs less on Wan 3.0 than the price its credits were set from.
  for (const m of MODELS.filter((x) => x.family === "seedance")) {
    for (const res of m.resolutions) for (const d of m.durations) {
      const x = s({ model: m.key, resolution: res, duration: d });
      assert.ok(wanOffered(x), `${m.key} ${res} ${d}`);
      assert.ok(wanCostUsd(x) <= clipCostUsd(x) + 1e-9, `${m.key} ${res} ${d}: ${wanCostUsd(x)} > ${clipCostUsd(x)}`);
    }
  }
  assert.equal(wanCostUsd(s({ model: "seedance-2.5", resolution: "1080p", duration: 5 })), 0.95);
  assert.equal(wanCostUsd(s({ model: "seedance-2.0-fast", resolution: "480p", duration: 5 })), 0.2375);
  assert.equal(wanOffered(s({ model: "veo-3.1", resolution: "1080p", duration: 8 })), false, "Veo is not Seedance");
  // Clips made with video or sound clips attached (omni reference, edit, extend) get no offer.
  assert.equal(wanOffered(normalizeSettings({ model: "seedance-2.5", videoRole: "edit" }, 0, { images: 0, videos: 1, audios: 0, videoSeconds: 6 })), false);
  assert.equal(wanOffered({ ...normalizeSettings({ model: "seedance-2.5" }, 0, { images: 0, videos: 0, audios: 1, videoSeconds: 0 }), clips: 1 }), false, "a sound clip alone: the stored clip count says so");

  const t2v = wanOrder(s({ model: "seedance-2.5", resolution: "720p", duration: 15, aspect: "21:9" }), " a castle ", []);
  assert.deepEqual(t2v, { slug: "alibaba/wan-3.0/text-to-video", body: { prompt: "a castle", duration: 15, resolution: "720p", generate_audio: true, aspect_ratio: "16:9" } });
  const i2v = wanOrder(s({ model: "seedance-2.0", resolution: "480p", duration: 5, images: 1 }), "", ["https://x/1.jpg"]);
  assert.equal(i2v.slug, "alibaba/wan-3.0/image-to-video");
  assert.deepEqual(i2v.body, { prompt: "Bring this picture to life with natural, cinematic motion.", duration: 5, resolution: "480p", generate_audio: true, image: "https://x/1.jpg" });
  const r2v = wanOrder(s({ model: "seedance-2.5", resolution: "1080p", duration: 10, aspect: "9:16", audio: false, images: 3 }), "they meet", ["a", "b", "c"]);
  assert.deepEqual(r2v, { slug: "alibaba/wan-3.0/reference-to-video", body: { prompt: "they meet", duration: 10, resolution: "1080p", generate_audio: false, reference_images: ["a", "b", "c"], aspect_ratio: "9:16" } });
  for (const o of [t2v, i2v, r2v]) assert.ok(!/spicy/.test(o.slug), "never a -spicy route");
});

test("Seedance's picture sizes: 300-6000 px a side, sides at most 2.5 times each other; other models and unknown sizes pass", () => {
  assert.equal(pictureProblem("Seedance 2.5", "seedance", 1024, 768), null);
  assert.equal(pictureProblem("Seedance 2.5", "seedance", 300, 750), null, "exactly 2.5 passes");
  assert.match(pictureProblem("Seedance 2.5", "seedance", 387, 297), /too small .*387×297/);
  assert.match(pictureProblem("Seedance 2.5", "seedance", 6100, 3000), /too big/);
  assert.match(pictureProblem("Seedance 2.5", "seedance", 300, 751), /too tall or too wide/);
  assert.match(pictureProblem("Seedance 2.5", "seedance", 100, 4000), /too tall or too wide/, "a thin strip is told to crop, not that it is small");
  assert.equal(pictureProblem("Veo 3.1", "veo", 100, 100), null);
  assert.equal(pictureProblem("Seedance 2.5", "seedance", null, null), null);
  assert.equal(pictureProblem("Seedance 2.5", "seedance", 0, 297), null);
});
