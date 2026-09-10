/**
 * Offline tests for src/storyboard.ts: a fake env.AI replays the defects seen with real Workers AI output
 * (invented icon names, "at " keys, beats without their fields, narration over 350 chars, metric without value,
 * garbled JSON, quota errors) and the generator must still produce a contract-valid storyboard.
 * Run: node --test test/storyboard.test.mjs   (never calls Workers AI)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateStoryboard, fixtureStoryboard, isTransientAiError, StoryboardError, styleFor, keouStyleFor, pickKleoStyle, planFor } from "../src/storyboard.ts";
import { validateStoryboard, pictureScenes, BEAT_ICONS, STORY_ACTS } from "../src/keou-contract.ts";

const job = (template, duration_s, format, language = "en", prompt = "Why your phone battery dies faster in winter and the two habits that keep it healthy.", style = undefined) =>
  ({ id: "gt_test", template, prompt, params: JSON.stringify({ duration_s, format, language, voice: null, ...(style ? { style } : {}) }) });

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
  const r = await generateStoryboard(env, job("viral-short", 45, "9:16", "en", undefined, "cyber"));
  const sb = r.storyboard;
  assert.equal(validateStoryboard(sb, { format: "9:16", language: "en" }).ok, true);
  assert.equal(sb.style, "cinema"); assert.equal(sb.kleo_style, "cyber"); assert.equal(r.style, "cyber"); assert.equal(sb.voice, "am_michael"); assert.equal(sb.speed, 1.1); assert.equal(sb.music, "bed"); assert.equal(sb.max_duration, 72);
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
  assert.equal(sb.style, "technical"); assert.equal(sb.kleo_style, "cyber", "an explainer defaults to the cyber look"); assert.equal(sb.voice, "af_heart"); assert.equal(garbled, 1);
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

test("fixture: used without an AI binding or with STORYBOARD_FIXTURE=example, adapted to the job, cartoon with a picture per scene", async () => {
  const r = await generateStoryboard({}, job("explainer", 240, "16:9", "it"));
  assert.equal(r.fixture, true); assert.equal(r.storyboard.format, "16:9"); assert.equal(r.storyboard.language, "it"); assert.equal(r.storyboard.voice, "if_sara");
  assert.equal(validateStoryboard(r.storyboard, { format: "16:9", language: "it" }).ok, true);
  assert.equal(r.storyboard.kleo_style, "cartoon"); assert.equal(r.style, "cartoon");
  assert.equal(pictureScenes(r.storyboard).length, r.storyboard.scenes.length, "every fixture scene has an image_prompt");
  for (const s of r.storyboard.scenes) { assert.ok(s.image_prompt.length <= 240 && !("image" in s)); }
  const real = fixtureStoryboard(job("viral-short", 45, "9:16", "en", undefined, "realistic"));
  assert.equal(real.kleo_style, "realistic"); assert.ok(real.scenes.every((s) => s.image_prompt));
  const cyber = fixtureStoryboard(job("viral-short", 45, "9:16", "en", undefined, "cyber"));
  assert.equal(cyber.kleo_style, "cyber"); assert.ok(cyber.scenes.every((s) => !("image_prompt" in s)));
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

test("kleo style: explicit or picked from the prompt; keou style follows it", () => {
  assert.equal(pickKleoStyle("viral-short", "How hackers steal your password with a fake login page"), "cyber");
  assert.equal(pickKleoStyle("story-documentary", "The pirates who found an island missing from every map"), "cartoon");
  assert.equal(pickKleoStyle("viral-short", "Is the new noise cancelling headphones worth the price? A quick review"), "realistic");
  assert.equal(pickKleoStyle("product-review", "Something without keywords"), "realistic");
  assert.equal(pickKleoStyle("explainer", "Something without keywords"), "cyber");
  assert.equal(pickKleoStyle("motivational", "Something without keywords"), "cartoon");
  assert.notEqual(pickKleoStyle("viral-short", "please make it a stickman"), "stickman", "stickman is never picked automatically");
  assert.equal(keouStyleFor("cartoon", "explainer", "16:9"), "cinema");
  assert.equal(keouStyleFor("realistic", "viral-short", "9:16"), "cinema");
  assert.equal(keouStyleFor("cyber", "explainer", "16:9"), "technical");
  assert.equal(keouStyleFor("cyber", "motivational", "16:9"), "editorial");
  assert.equal(keouStyleFor("stickman", "viral-short", "9:16"), "stickman");
  const p = planFor(job("story-documentary", 480, "16:9", "en", "The pirates who found an island", "cartoon"));
  assert.equal(p.style, "cinema"); assert.equal(p.pictures, true); assert.ok(p.scenes[1] <= 36, `long cartoon videos keep a sane scene count, got ${p.scenes}`);
});

test("cartoon: image_prompt is requested per scene, trimmed to 240 chars, and its absence is fed back once", async () => {
  let asked = 0, feedback = 0;
  const env = fakeEnv((kind, user, attempt, inputs) => {
    if (kind === "outline") return outlineFor(user, true);
    asked++;
    if (/missing "image_prompt"/.test(user)) feedback++;
    const [from, to] = chunkRange(user);
    const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
    const schema = inputs.response_format.json_schema.properties.scenes.items;
    assert.ok(schema.required.includes("image_prompt"), "the scene schema requires image_prompt for a picture style");
    const scenes = [];
    for (let i = from; i < to; i++) {
      const s = { id: `${String(i + 1).padStart(2, "0")}-part`, kind: i === total - 1 ? "closing" : "cinema", chapter: `0${i + 1} PART`, accent: "amber", title: `Part ${i + 1}`, hl: "Part",
        voice: `Scene ${i + 1} tells one small piece of the pirate story with a concrete detail and a twist.`, image: "img/hack.png",
        beats: [{ kind: "type", text: "PIRATES", slam: true }, { kind: "icon", name: "wave", at: "pirate" }, { kind: "people", total: 8, lit: 3, at: "twist" }, { kind: "dialog", text: "Land ahead", at: "story" }] };
      if (i === 1 && attempt === 1) { /* no image_prompt the first time */ } else s.image_prompt = i === 2 ? "A ".repeat(200) + "ship" : `A pirate ship anchored in a sandy bay, scene ${i + 1}`;
      scenes.push(s);
    }
    return { scenes };
  });
  const r = await generateStoryboard(env, job("viral-short", 45, "9:16", "en", "The pirates who found an island missing from every map"));
  const sb = r.storyboard;
  assert.equal(validateStoryboard(sb, { format: "9:16", language: "en" }).ok, true);
  assert.equal(sb.kleo_style, "cartoon"); assert.equal(sb.style, "cinema");
  assert.ok(feedback >= 1, "the missing image_prompt was fed back to the model");
  assert.equal(pictureScenes(sb).length, sb.scenes.length);
  assert.ok(sb.scenes.every((s) => s.image_prompt.length <= 240 && !("image" in s)));
  assert.ok(sb.scenes[2].image_prompt.length > 200 && sb.scenes[2].image_prompt.length <= 240 && !/\s$/.test(sb.scenes[2].image_prompt), "over-long prompts are cut at a word boundary");
});

test("stickman: story scenes with acts, cast, props and bubbles, repaired to the contract", async () => {
  const env = fakeEnv((kind, user) => {
    if (kind === "outline") return outlineFor(user, false);
    const [from, to] = chunkRange(user);
    const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
    const scenes = [];
    for (let i = from; i < to; i++) {
      scenes.push({ id: `${String(i + 1).padStart(2, "0")}-part`, kind: i === total - 1 ? "closing" : "story", act: i === 0 ? "dance" : "alarm", cast: ["thief", "thief", "hero", "ghost"], props: ["keyfob", "keyfob", "car", "laser", "house", "pouch"],
        fx: i === 0 ? "explode" : "relay", accent: i === 0 ? "cyan" : "red", bubble: i === 0 ? "This bubble is far too long for forty characters!!" : "Where is my car?", hl: "car", title: `Part ${i + 1}`,
        voice: `Scene ${i + 1}: the thief walks up with a relay box and the car opens by itself.`, beats: [{ kind: "type", text: "X" }], items: ["a", "b", "c"] });
    }
    return { scenes };
  });
  const r = await generateStoryboard(env, job("viral-short", 45, "9:16", "en", "Relay attack on keyless cars", "stickman"));
  const sb = r.storyboard;
  assert.deepEqual(validateStoryboard(sb, { format: "9:16", language: "en" }).ok ? [] : validateStoryboard(sb, { format: "9:16", language: "en" }).errors, []);
  assert.equal(sb.style, "stickman"); assert.equal(sb.kleo_style, "stickman"); assert.equal(r.style, "stickman");
  assert.ok(sb.scenes.length >= 3 && sb.scenes.at(-1).kind === "closing" && sb.scenes.slice(0, -1).every((s) => s.kind === "story"));
  const s0 = sb.scenes[0];
  assert.equal(s0.act, undefined, "unknown act dropped (engine default idle)"); assert.equal(s0.accent, undefined); assert.equal(s0.fx, undefined); assert.equal(s0.bubble, undefined);
  assert.deepEqual(s0.cast, ["hero", "thief"]); assert.deepEqual(s0.props, ["keyfob", "car", "house"]);
  assert.equal(s0.beats, undefined); assert.equal(s0.items, undefined);
  const s1 = sb.scenes[1];
  assert.ok(STORY_ACTS.includes(s1.act)); assert.equal(s1.fx, "relay"); assert.equal(s1.accent, "red"); assert.equal(s1.bubble, "Where is my car?");
  assert.equal(sb.scenes.at(-1).cast, undefined, "closing scenes carry no cast");
});
