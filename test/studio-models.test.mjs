/**
 * Kleo Studio, the pure parts: model catalog and prices, the provider input per model, sessions, passwords and
 * signed links, the agent's proposals. Imports the TypeScript sources directly (Node 22.18+ strips the types).
 * Run: node --test test/studio-models.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, normalizeSettings, clipCredits, clipCostUsd, taskInput, freeModels, publicCatalog, modelByKey } from "../src/studio/models.ts";
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
  assert.equal(c("seedance-2.0-fast", 5, "480p"), 1);
  assert.equal(c("seedance-2.0-fast", 5, "720p"), 2);
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
