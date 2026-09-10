/**
 * Offline tests for src/storyboard.ts: a fake env.AI replays the defects seen with real Workers AI output
 * (invented icon names, "at " keys, beats without their fields, narration over 350 chars, metric without value,
 * garbled JSON, quota errors) and the generator must still produce a contract-valid storyboard.
 * Run: node --test test/storyboard.test.mjs   (never calls Workers AI)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateStoryboard, fixtureStoryboard, isTransientAiError, StoryboardError, styleFor, keouStyleFor, pickKleoStyle, planFor, normalizeStoryboard } from "../src/storyboard.ts";
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

test("fixture: used without an AI binding or with STORYBOARD_FIXTURE=example, adapted to the job, cartoon with shots", async () => {
  const r = await generateStoryboard({}, job("explainer", 240, "16:9", "it"));
  assert.equal(r.fixture, true); assert.equal(r.storyboard.format, "16:9"); assert.equal(r.storyboard.language, "it"); assert.equal(r.storyboard.voice, "if_sara");
  assert.equal(validateStoryboard(r.storyboard, { format: "16:9", language: "it" }).ok, true);
  assert.equal(r.storyboard.kleo_style, "cartoon"); assert.equal(r.storyboard.style, "picture"); assert.equal(r.style, "cartoon");
  const scenes = r.storyboard.scenes;
  for (const s of scenes) {
    assert.ok(Array.isArray(s.shots) && s.shots.length >= 1, "every fixture scene carries shots");
    assert.ok(!("beats" in s) && !("image_prompt" in s) && !("image" in s), "no beats, no scene-level picture");
    for (const sh of s.shots) assert.ok(sh.image_prompt.length <= 240 && !("image" in sh));
  }
  assert.equal(scenes.at(-1).kind, "closing"); assert.equal(scenes.at(-1).shots.length, 1);
  assert.equal(scenes[0].shots[0].at, undefined, "the first shot opens the scene");
  assert.ok(scenes[0].voice.toLowerCase().includes(String(scenes[0].shots[1].at).toLowerCase()), "the second shot cuts on words of the voice");
  const pics = pictureScenes(r.storyboard);
  assert.ok(pics.length > scenes.length, `several pictures per scene, got ${pics.length} for ${scenes.length} scenes`);
  assert.deepEqual(pics.slice(0, 2).map((x) => x.id), [`${scenes[0].id}-s1`, `${scenes[0].id}-s2`]);
  const real = fixtureStoryboard(job("viral-short", 45, "9:16", "en", undefined, "realistic"));
  assert.equal(real.kleo_style, "realistic"); assert.equal(real.style, "picture");
  assert.ok(real.scenes.every((s) => s.shots.length >= 1));
  const cyber = fixtureStoryboard(job("viral-short", 45, "9:16", "en", undefined, "cyber"));
  assert.equal(cyber.kleo_style, "cyber"); assert.equal(cyber.style, "cinema");
  assert.ok(cyber.scenes.every((s) => !("shots" in s) && !("image_prompt" in s)), "the cyber fixture keeps the plain cinema look");
  assert.ok(cyber.scenes.some((s) => Array.isArray(s.beats) && s.beats.length), "with its beats");
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
  assert.equal(keouStyleFor("cartoon", "explainer", "16:9"), "picture");
  assert.equal(keouStyleFor("realistic", "viral-short", "9:16"), "picture");
  assert.equal(keouStyleFor("cyber", "explainer", "16:9"), "technical");
  assert.equal(keouStyleFor("cyber", "motivational", "16:9"), "editorial");
  assert.equal(keouStyleFor("stickman", "viral-short", "9:16"), "stickman");
  const p = planFor(job("story-documentary", 480, "16:9", "en", "The pirates who found an island", "cartoon"));
  assert.equal(p.style, "picture"); assert.equal(p.pictures, true); assert.ok(p.scenes[1] <= 36, `long cartoon videos keep a sane scene count, got ${p.scenes}`);
});

test("picture: the schema asks for shots, a lone shot is fed back once, the result is a valid picture storyboard", async () => {
  let feedback = 0;
  const env = fakeEnv((kind, user, attempt, inputs) => {
    if (kind === "outline") return outlineFor(user, true);
    if (/only one picture/.test(user)) feedback++;
    const [from, to] = chunkRange(user);
    const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
    const schema = inputs.response_format.json_schema.properties.scenes.items;
    assert.ok(schema.required.includes("shots"), "the scene schema requires shots");
    assert.ok(!("beats" in schema.properties), "the picture schema knows nothing about beats");
    assert.deepEqual(schema.properties.shots.items.required, ["image_prompt"]);
    assert.deepEqual(schema.properties.shots.items.properties.motion.enum, ["in", "out", "left", "right"]);
    assert.ok(/2-4 shots|2–4 shots|"shots"/.test(user), "the task text names the shots");
    const scenes = [];
    for (let i = from; i < to; i++) {
      const closing = i === total - 1;
      const voice = `Scene ${i + 1} tells one small piece of the pirate story with a concrete detail and a twist.`;
      const shots = closing
        ? [{ image_prompt: "A treasure chest half buried in the sand at dawn" }, { image_prompt: "The same beach empty at noon" }, { image_prompt: "A third one, over the cap" }]
        : [
            { image_prompt: `A pirate ship anchored in a sandy bay, scene ${i + 1}`, caption: "PIRATES AHEAD", hl: "PIRATES", at: "one small piece", motion: "in" }, // at on the first shot → dropped
            { image_prompt: "A ".repeat(200) + "crew hauling ropes on the deck", at: "concrete detail", motion: "zoom" },                                            // prompt cut, motion dropped
            { image_prompt: "The same crew in a storm at night", at: "bananas and cake", caption: "A CAPTION THAT IS FAR TOO LONG TO FIT ON THE SCREEN", hl: "STORM" }, // at, caption and hl dropped
            { caption: "NO PICTURE HERE" },                                                                                                                          // no image_prompt → shot dropped
            { image_prompt: "A map spread on a wooden table in lantern light", at: "a twist", motion: "out" },
          ];
      const s = { id: `${String(i + 1).padStart(2, "0")}-part`, kind: closing ? "closing" : "cinema", chapter: `0${i + 1} PART`, accent: "amber", title: `Part ${i + 1}`, hl: "Part",
        voice, image: "img/hack.png", beats: [{ kind: "type", text: "PIRATES", slam: true }], button: closing ? "Follow" : undefined, shots };
      if (i === 1 && attempt === 1) s.shots = [shots[0]]; // one picture for the whole line the first time
      scenes.push(s);
    }
    return { scenes };
  });
  const r = await generateStoryboard(env, job("viral-short", 45, "9:16", "en", "The pirates who found an island missing from every map"));
  const sb = r.storyboard;
  assert.deepEqual(validateStoryboard(sb, { format: "9:16", language: "en" }).ok ? [] : validateStoryboard(sb, { format: "9:16", language: "en" }).errors, []);
  assert.equal(sb.kleo_style, "cartoon"); assert.equal(sb.style, "picture"); assert.equal(r.style, "cartoon");
  assert.ok(feedback >= 1, "a scene with a single picture was fed back to the model");
  for (const s of sb.scenes) {
    assert.ok(!("beats" in s) && !("image" in s) && !("image_prompt" in s), "no beats and no scene-level picture survive");
    assert.ok(s.shots.length >= 1 && s.shots.length <= (s.kind === "closing" ? 2 : 4));
    for (const sh of s.shots) assert.ok(sh.image_prompt.length >= 2 && sh.image_prompt.length <= 240);
  }
  const first = sb.scenes[0];
  assert.equal(first.shots.length, 4, "the shot without a picture is dropped, the rest kept");
  assert.equal(first.shots[0].at, undefined, "the first shot cannot carry at");
  assert.equal(first.shots[0].caption, "PIRATES AHEAD"); assert.equal(first.shots[0].hl, "PIRATES");
  assert.ok(first.shots[1].image_prompt.length <= 240 && !/\s$/.test(first.shots[1].image_prompt), "an over-long prompt is cut at a word boundary");
  assert.equal(first.shots[1].motion, undefined, "an unknown motion is dropped");
  assert.equal(first.shots[1].at, "concrete detail");
  assert.equal(first.shots[2].at, undefined, "an at that is not in the voice is dropped");
  assert.equal(first.shots[2].caption, undefined); assert.equal(first.shots[2].hl, undefined);
  assert.equal(first.shots[3].motion, "out");
  const closing = sb.scenes.at(-1);
  assert.equal(closing.kind, "closing"); assert.equal(closing.shots.length, 2, "the closing keeps at most two pictures"); assert.equal(closing.button, "Follow");
  const pics = pictureScenes(sb);
  assert.equal(pics.length, sb.scenes.reduce((n, s) => n + s.shots.length, 0));
  assert.deepEqual(pics.slice(0, 2).map((p) => p.id), ["01-part-s1", "01-part-s2"]);
});

test("picture: normalizeStoryboard turns a scene image_prompt into shots and keeps the closing to one picture", () => {
  const j = job("viral-short", 45, "9:16", "en", "The pirates who found an island missing from every map", "realistic");
  const plan = planFor(j);
  assert.equal(plan.style, "picture"); assert.equal(plan.kleo, "realistic");
  const raw = { title: "Test", scenes: [
    { id: "01 Hook!", kind: "cinema", chapter: "01 HOOK", accent: "amber", title: "the island", hl: "island", voice: "The crew found an island that was not on any map, and three days later it was gone.",
      image_prompt: "  A wooden ship at anchor in a turquoise bay under a stormy sky  ", beats: [{ kind: "type", text: "GONE" }], eyebrow: "JUNK", visual: "focus", items: ["a", "b"] },
    { id: "02-closing", kind: "closing", accent: "cyan", title: "Follow for part two", voice: "Was it a mirage, or something the sea wanted to keep? Follow for part two.",
      button: "Follow for the whole story", detail: "a detail line", shots: [
        { image_prompt: "Empty open sea at sunset seen from the deck" },
        { image_prompt: "The same sea at night, a lantern on the rail", at: "part two" },
        { image_prompt: "One picture too many for a closing" }] },
  ] };
  const sb = normalizeStoryboard(structuredClone(raw), plan);
  assert.equal(sb.style, "picture"); assert.equal(sb.kleo_style, "realistic");
  const a = sb.scenes[0];
  assert.equal(a.id, "01-hook", "ids are slugged");
  assert.deepEqual(a.shots, [{ image_prompt: "A wooden ship at anchor in a turquoise bay under a stormy sky" }], "the old scene-level prompt becomes shot 1");
  assert.ok(!("image_prompt" in a) && !("beats" in a) && !("eyebrow" in a) && !("visual" in a) && !("items" in a));
  const z = sb.scenes[1];
  assert.equal(z.shots.length, 2, "a closing shows one picture, two at most");
  assert.equal(z.shots[1].at, "part two");
  assert.equal(z.button, undefined, "a button longer than 24 characters is dropped");
  assert.ok(!("detail" in z), "the picture style has no detail line");
  assert.equal(validateStoryboard(sb, { format: "9:16", language: "en" }).ok, true);
  // A scene the model left without any usable picture still renders: the title becomes the prompt.
  const bare = normalizeStoryboard({ title: "T", scenes: [
    { id: "01-a", kind: "cinema", chapter: "01 A", accent: "red", title: "A quiet street at dawn", hl: "quiet", voice: "A quiet street at dawn, and nobody is watching the door.", shots: [{ caption: "NOTHING" }] },
    { id: "02-b", kind: "closing", accent: "green", title: "Follow", voice: "Follow for part two.", shots: [{ image_prompt: "An empty street at noon" }] },
  ] }, plan);
  assert.deepEqual(bare.scenes[0].shots, [{ image_prompt: "A quiet street at dawn" }]);
  assert.equal(validateStoryboard(bare, { format: "9:16", language: "en" }).ok, true);
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
