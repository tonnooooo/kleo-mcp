/**
 * Offline tests for src/storyboard.ts: a fake env.AI replays the defects seen with real Workers AI output
 * (invented icon names, "at " keys, beats without their fields, narration over 350 chars, metric without value,
 * garbled JSON, quota errors) and the generator must still produce a contract-valid storyboard.
 * Run: node --test test/storyboard.test.mjs   (never calls Workers AI)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateStoryboard, fixtureStoryboard, isTransientAiError, StoryboardError, styleFor } from "../src/storyboard.ts";
import { validateStoryboard, BEAT_ICONS } from "../src/keou-contract.ts";

const job = (template, duration_s, format, language = "en", prompt = "Why your phone battery dies faster in winter and the two habits that keep it healthy.") =>
  ({ id: "gt_test", template, prompt, params: JSON.stringify({ duration_s, format, language, voice: null }) });

const outlineFor = (user, cinema) => {
  const n = Number(/exactly (\d+) scenes/.exec(user)[1]);
  const scenes = Array.from({ length: n }, (_, i) => ({
    id: `${String(i + 1).padStart(2, "0")}-part`, kind: i === n - 1 ? "closing" : cinema ? "cinema" : ["hero", "metric", "list", "quote", "compare", "steps"][i % 6],
    label: cinema ? `0${i + 1} PART` : "SECTION", accent: cinema ? "cyan" : undefined, summary: `part ${i + 1}`, words: 20,
  }));
  return { title: "Test video", description: "desc", tags: ["a"], scenes };
};
const chunkRange = (user) => { const m = /write scenes (\d+)–(\d+)/.exec(user); return [Number(m[1]) - 1, Number(m[2])]; };

/** Fake AI: `respond(kind, user, attempt)` returns the raw model output (object or string) or throws. */
function fakeEnv(respond) {
  const attempts = new Map();
  return {
    AI: { async run(_model, inputs) {
      const user = inputs.messages.at(-1).content;
      const kind = /TASK: plan the whole video/.test(user) ? "outline" : "chunk";
      const key = kind === "outline" ? "outline" : `chunk-${chunkRange(user).join("-")}`;
      const a = (attempts.get(key) ?? 0) + 1; attempts.set(key, a);
      const out = await respond(kind, user, a, inputs);
      return { response: out, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    } },
    INTERNAL_SECRET: "x",
  };
}

test("cinema: defective beats are repaired, not fatal", async () => {
  const env = fakeEnv((kind, user, attempt) => {
    if (kind === "outline") return outlineFor(user, true);
    const [from, to] = chunkRange(user);
    const scenes = [];
    for (let i = from; i < to; i++) {
      const last = i === to - 1 && /VIDEO OUTLINE \((\d+) scenes/.exec(user)[1] == to;
      const voice = i === 0
        ? "Your phone battery dies faster in winter. " + "It is the chemistry of the cell in the cold. ".repeat(9) // > 350 chars
        : `Scene ${i + 1} explains one habit that keeps the battery healthy in winter, every single day.`;
      scenes.push({
        id: `${String(i + 1).padStart(2, "0")}-part`, kind: last ? "closing" : "cinema", chapter: `0${i + 1} PART`, accent: "cyan", title: `Part ${i + 1}`, hl: "Part", voice, hold: 0.2,
        beats: [
          { kind: "type", text: "BATTERY DIES FASTER", hl: "NOWHERE", slam: true, icon: "battery" },   // hl not in text → dropped; icon synonym → phone
          { kind: "icon", name: "battery", "at ": "winter", label: "a label that is far too long for twenty four chars" }, // key trim, synonym, label dropped
          { kind: "icon", name: "unicorn", at: "habit" },                                              // unknown icon → beat dropped
          { kind: "steps", lit: 2 },                                                                   // no items → dropped
          { kind: "people", total: 20, lit: 30, at: "healthy" },                                        // clamped to 12 / 12
          { kind: "split", items: ["phone", "snow"], fx: "sparkle", at: "not in the voice at all" },   // snow → wave, fx dropped, at dropped
          { kind: "bars", labels: ["A", "B"], values: [1, 2, 3] },                                     // mismatch → dropped
          { kind: "cta", label: "SUBSCRIBE", toggles: ["ON", "OFF", "MAYBE", "EXTRA"] },
        ],
      });
    }
    return { scenes };
  });
  const r = await generateStoryboard(env, job("viral-short", 45, "9:16"));
  const sb = r.storyboard;
  assert.equal(validateStoryboard(sb, { format: "9:16", language: "en" }).ok, true);
  assert.equal(sb.style, "cinema"); assert.equal(sb.voice, "am_michael"); assert.equal(sb.speed, 1.1); assert.equal(sb.music, "bed"); assert.equal(sb.max_duration, 72);
  assert.ok(sb.scenes.length >= 4 && sb.scenes.at(-1).kind === "closing");
  assert.ok(sb.scenes[0].voice.length <= 350 && /\.$/.test(sb.scenes[0].voice), "voice fitted at a sentence boundary");
  const b = sb.scenes[1].beats;
  assert.deepEqual(b.map((x) => x.kind), ["type", "icon", "people", "split", "cta"]);
  assert.equal(b[0].icon, "phone"); assert.equal(b[0].hl, undefined);
  assert.equal(b[1].name, "phone"); assert.equal(b[1].at, "winter"); assert.equal(b[1].label, undefined);
  assert.deepEqual([b[2].total, b[2].lit], [12, 12]);
  assert.deepEqual(b[3].items, ["phone", "wave"]); assert.equal(b[3].fx, undefined); assert.equal(b[3].at, undefined);
  assert.deepEqual(b[4].toggles, ["ON", "OFF", "MAYBE"]);
  for (const s of sb.scenes) for (const x of s.beats) if (x.kind === "icon") assert.ok(BEAT_ICONS.includes(x.name));
  assert.ok(r.attempts >= 3 && r.words > 0 && r.history.length >= 1, "soft problems were fed back once");
});

test("editorial: garbled JSON is retried, under-specified scenes are downgraded, junk fields removed", async () => {
  let garbled = 0;
  const env = fakeEnv((kind, user, attempt) => {
    if (kind === "outline") return outlineFor(user, false);
    const [from, to] = chunkRange(user);
    if (from === 0 && attempt === 1) { garbled++; return '{"scenes": [{"id": "01-part", "kind": "hero", "voice": "oops\', \'visual\': \'focus\'}, {'; }
    const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
    const scenes = [];
    for (let i = from; i < to; i++) {
      const kinds = ["metric", "list", "quote", "compare", "steps", "hero"];
      const kind = i === total - 1 ? "closing" : kinds[i % kinds.length];
      const s = { id: `${String(i + 1).padStart(2, "0")}-part`, kind, eyebrow: "A SECTION LABEL THAT IS LONGER THAN FORTY CHARACTERS", title: `Part ${i + 1}`, visual: "diagram",
        voice: "Public keys can be shared with anyone. The private key stays with you, and only it can open what the public key locked. That is the whole trick.",
        items: ["one", "two", "three", "four"], value: "1,000", animate_value: true, quote: "", button: "Subscribe", detail: "and a detail" };
      if (kind === "metric") delete s.unit; // metric without unit → hero
      scenes.push(s);
    }
    return { scenes };
  });
  const r = await generateStoryboard(env, job("explainer", 240, "16:9"));
  const sb = r.storyboard;
  assert.equal(validateStoryboard(sb, { format: "16:9", language: "en" }).ok, true);
  assert.equal(sb.style, "technical"); assert.equal(sb.voice, "af_heart"); assert.equal(garbled, 1);
  assert.ok(sb.scenes.length >= 12, `expected a long-form scene count, got ${sb.scenes.length}`);
  for (const s of sb.scenes) {
    assert.ok(s.eyebrow.length <= 40); assert.equal(s.visual, undefined);
    if (s.kind === "list" || s.kind === "steps") assert.equal(s.items.length, 3);
    if (s.kind === "compare") assert.equal(s.items.length, 2);
    if (s.kind === "quote") assert.equal(s.quote, s.title);
    if (s.kind === "hero") assert.equal(s.items, undefined);
    if (s.kind !== "metric") assert.equal(s.animate_value, undefined);
    if (s.kind === "closing") assert.ok(!(s.button && s.detail));
  }
  assert.ok(!sb.scenes.some((s) => s.kind === "metric"), "metric scenes without unit were downgraded");
  assert.ok(r.history.some((h) => h.some((m) => /downgraded to hero/.test(m))), "the downgrade was fed back to the model");
});

test("quota exhaustion is transient: rejects with the AI error, not a StoryboardError", async () => {
  const env = fakeEnv(() => { throw new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons"); });
  await assert.rejects(generateStoryboard(env, job("viral-short", 45, "9:16")), (e) => !(e instanceof StoryboardError) && isTransientAiError(e));
  assert.equal(isTransientAiError(new Error("scene 1: unknown composition")), false);
  assert.equal(isTransientAiError("AiError: 3046: Request timeout"), false);
});

test("a persistently invalid model answer fails with the validator's problems", async () => {
  const env = fakeEnv((kind, user) => (kind === "outline" ? outlineFor(user, false) : { scenes: [{ id: "x", kind: "hero", eyebrow: "E", title: "T", voice: "v" }] }));
  await assert.rejects(generateStoryboard(env, job("explainer", 240, "16:9")), (e) => e instanceof StoryboardError && e.errors.some((m) => /expected exactly \d+ scenes/.test(m)));
});

test("fixture: used without an AI binding or with STORYBOARD_FIXTURE=example, adapted to the job", async () => {
  const r = await generateStoryboard({}, job("explainer", 240, "16:9", "it"));
  assert.equal(r.fixture, true); assert.equal(r.storyboard.format, "16:9"); assert.equal(r.storyboard.language, "it"); assert.equal(r.storyboard.voice, "if_sara");
  assert.equal(validateStoryboard(r.storyboard, { format: "16:9", language: "it" }).ok, true);
  const r2 = await generateStoryboard({ AI: { run() { throw new Error("must not be called"); } }, STORYBOARD_FIXTURE: "example" }, job("viral-short", 45, "9:16"));
  assert.equal(r2.fixture, true);
  assert.equal(fixtureStoryboard(job("viral-short", 45, "9:16")).scenes.at(-1).kind, "closing");
});

test("template → style mapping", () => {
  assert.equal(styleFor("viral-short", "9:16"), "cinema");
  assert.equal(styleFor("motivational", "16:9"), "editorial");
  assert.equal(styleFor("cinematic-trailer", "16:9"), "cinema");
  assert.equal(styleFor("top-10", "16:9"), "illustrated");
  assert.equal(styleFor("explainer", "16:9"), "technical");
});
