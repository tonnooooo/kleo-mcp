/**
 * Offline tests for src/storyboard.ts: a fake env.AI replays the defects seen with real Workers AI output
 * (invented icon names, "at " keys, beats without their fields, narration over 350 chars, metric without value,
 * garbled JSON, quota errors) and the generator must still produce a contract-valid storyboard.
 * Run: node --test test/storyboard.test.mjs   (never calls Workers AI)
 */
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { generateStoryboard, fixtureStoryboard, isTransientAiError, StoryboardError, styleFor, keouStyleFor, pickKleoStyle, planFor, normalizeStoryboard } from "../src/storyboard.ts";
import { guideText, EXAMPLE_SCENES } from "../src/guide.ts";
import { stillness } from "../src/direction.ts";
import { validateStoryboard, pictureScenes, quotesVoice, BEAT_ICONS, STORY_ACTS } from "../src/keou-contract.ts";
import { assignShotKinds } from "../src/storyboard.ts";
import { SHOT_KINDS, presetFor, moveClassOf, isLoud, needsStaticHold, LOUD_MAX_PER_WINDOW } from "../src/shot-grammar.ts";

const moveOfKind = (k) => presetFor(k).move;
const classOfKind = (k) => moveClassOf(moveOfKind(k));
/** Every shot of a picture storyboard, flattened in scene → shot order, with the scene it belongs to. */
const flatShots = (sb) => sb.scenes.flatMap((sc) => (sc.shots ?? []).map((sh) => ({ ...sh, scene: sc.id })));
/**
 * The sequencing rules a storyboard must already satisfy when it leaves the planner: one kind per shot, no two
 * consecutive shots of the same move class, no two adjacent loud moves, one screen direction per scene.
 * Two forced static holds in a row are the one pair the planner leaves standing (only a new picture fixes it).
 */
function sequenceProblems(shots) {
  const bad = [];
  shots.forEach((sh, i) => {
    if (!SHOT_KINDS.includes(sh.shot_kind)) bad.push(`shot ${i + 1}: shot_kind ${JSON.stringify(sh.shot_kind)} is not one of the ten kinds`);
    if (Array.isArray(sh.shot_kind)) bad.push(`shot ${i + 1}: one move per shot, never a list`);
    // The validator RESOLVES shot_kind into motion on purpose, so the worker and the engine never need the grammar.
    // What must never survive is a motion that contradicts the kind, or one on a shot with no kind at all.
    if ("motion" in sh && !("shot_kind" in sh)) bad.push(`shot ${i + 1}: a camera move with no kind behind it`);
  });
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1].shot_kind, b = shots[i].shot_kind;
    if (a === "static_forced" && b === "static_forced") continue;
    if (classOfKind(a) === classOfKind(b)) bad.push(`shot ${i + 1}: move class ${classOfKind(b)} repeats shot ${i} (${a} → ${b})`);
    if (isLoud(moveOfKind(a)) && isLoud(moveOfKind(b))) bad.push(`shot ${i + 1}: two loud moves in a row (${a} → ${b})`);
  }
  for (let i = 1; i < shots.length; i++) {
    if (shots[i].scene !== shots[i - 1].scene) continue; // "the same subject" is the scene
    const a = presetFor(shots[i - 1].shot_kind).scale, b = presetFor(shots[i].shot_kind).scale;
    if (a === b) bad.push(`shot ${i + 1}: scale ${b} repeats shot ${i} inside scene ${shots[i].scene}`);
  }
  const dir = new Map();
  shots.forEach((sh, i) => {
    const d = presetFor(sh.shot_kind).move;
    const dd = { track_right: "right", track_alongside: "right", orbit_right: "right", whip_pan: "right", track_left: "left", orbit_left: "left" }[d];
    if (!dd) return;
    const had = dir.get(sh.scene);
    if (!had) dir.set(sh.scene, dd);
    else if (had !== dd) bad.push(`shot ${i + 1}: screen direction flips inside scene ${sh.scene}`);
  });
  return bad;
}

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

/**
 * A direction the planner accepts: the sections tile exactly the scene count the direction prompt asks for, and no two
 * neighbouring sections share an accent. It deliberately names NO style, so the look each test expects (chosen by the
 * template or by the caller) is left alone, and it lists no facts, so the fidelity gate has nothing to demand.
 */
const directionFor = (user) => {
  const n = Number(/add up to exactly (\d+)/.exec(user)?.[1] ?? 5);
  const accents = ["amber", "red", "cyan", "green"];
  const per = Math.max(1, Math.ceil(n / 3));
  const sections = [];
  for (let left = n, i = 0; left > 0; i++) {
    const take = Math.min(left, per);
    sections.push({ name: `0${i + 1} PART`, accent: accents[i % accents.length], means: "a part of the story", scenes: take });
    left -= take;
  }
  // Two sections is the floor; a one-scene film would otherwise produce one.
  if (sections.length < 2) { sections[0].scenes -= 1; sections.push({ name: "02 PART", accent: "red", means: "the end", scenes: 1 }); }
  return {
    direction: {
      subject: "Why a phone battery dies faster in winter",
      goal: "The viewer keeps their battery healthy in the cold",
      audience: "Anyone with a phone",
      tone: "Calm and factual",
      must_keep: [],
      world: "Ordinary winter streets and warm indoor rooms, cold blue light outside and warm light inside",
      cast: [],
      objects: ["phone", "coat pocket", "charger", "snow"],
      forbidden: ["text in the picture", "brand logo", "real person", "wifi symbol"],
      sections,
    },
  };
};

/**
 * Fake AI: `respond(kind, user, attempt)` returns the raw model output (object or string) or throws.
 * The direction call (step 0 of the planner) is answered by `directionFor` unless a test passes its own handler as
 * `opts.direction` — so every test here exercises the direction stage without having to know it exists, and the ones
 * that care about it can still drive it.
 */
function fakeEnv(respond, opts = {}) {
  const attempts = new Map();
  return {
    AI: { async run(_model, inputs) {
      const user = inputs.messages.at(-1).content;
      const kind = /TASK: write the DIRECTION/.test(user) ? "direction"
        : /TASK: plan the whole video/.test(user) ? "outline" : "chunk";
      const key = kind === "chunk" ? `chunk-${chunkRange(user).join("-")}` : kind;
      const a = (attempts.get(key) ?? 0) + 1; attempts.set(key, a);
      const handler = kind === "direction" ? (opts.direction ?? directionFor) : respond;
      const out = kind === "direction" && !opts.direction ? handler(user) : await handler(kind, user, a, inputs);
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
  for (const s of scenes) for (const [i, sh] of s.shots.entries()) {
    if (i === 0) { assert.equal(sh.at, undefined); continue; }
    // Whole words, never a fragment ("ver came"): the engine anchors a cut on a run of the scene's words.
    if ("at" in sh) assert.ok(quotesVoice(sh.at, s.voice), `${s.id} shot ${i + 1}: "${sh.at}" must quote whole words of the voice`);
  }
  assert.ok(scenes.filter((s) => s.shots.length > 1).every((s) => "at" in s.shots[1]), "every fixture scene with two pictures cuts the second on the narration");
  const pics = pictureScenes(r.storyboard);
  assert.ok(pics.length > scenes.length, `several pictures per scene, got ${pics.length} for ${scenes.length} scenes`);
  assert.deepEqual(pics.slice(0, 2).map((x) => x.id), [`${scenes[0].id}-s1`, `${scenes[0].id}-s2`]);
  // The shot grammar reaches the fixture too: story kinds only, a shootable sequence, and the routing rule
  // pinning the one picture that would melt under a camera move (two hooded figures holding an amplifier).
  const shots = flatShots(r.storyboard);
  assert.deepEqual(sequenceProblems(shots), []);
  assert.equal(shots[0].shot_kind, "hook"); assert.equal(shots.at(-1).shot_kind, "closing");
  const relay = r.storyboard.scenes.find((sc) => sc.id === "02-relay");
  assert.equal(relay.shots[0].shot_kind, "static_forced", "two hooded figures holding something is forced to a static hold");
  // No shot names a move by hand; the ones that carry `motion` carry the one the validator resolved from their kind.
  assert.ok(shots.every((sh) => !("motion" in sh) || "shot_kind" in sh), "the fixture writes no camera moves by hand");
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
    assert.ok(!("motion" in schema.properties.shots.items.properties), "the picture schema no longer offers a camera move");
    assert.deepEqual(schema.properties.shots.items.properties.shot_kind.enum, [...SHOT_KINDS]);
    assert.ok(/2-4 shots|2–4 shots|"shots"/.test(user), "the task text names the shots");
    const scenes = [];
    for (let i = from; i < to; i++) {
      const closing = i === total - 1;
      const voice = `Scene ${i + 1} tells one small piece of the pirate story with a concrete detail and a twist.`;
      const shots = closing
        ? [{ image_prompt: "A treasure chest half buried in the sand at dawn" }, { image_prompt: "The same beach empty at noon" }, { image_prompt: "A third one, over the cap" }]
        : [
            { image_prompt: `A pirate ship anchored in a sandy bay, scene ${i + 1}`, caption: "PIRATES AHEAD", hl: "PIRATES", at: "one small piece", shot_kind: "hook" }, // at on the first shot → dropped
            { image_prompt: "A ".repeat(200) + "crew hauling ropes on the deck", at: "concrete detail", shot_kind: "slow zoom in" },                                 // prompt cut, camera language dropped
            { image_prompt: "The same crew in a storm at night", at: "bananas and cake", caption: "A CAPTION THAT IS FAR TOO LONG TO FIT ON THE SCREEN", hl: "STORM", motion: "in" }, // at, caption, hl and motion dropped
            { caption: "NO PICTURE HERE" },                                                                                                                          // no image_prompt → shot dropped
            { image_prompt: "A map spread on a wooden table in lantern light", at: "a twist", shot_kind: "detail" },
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
  assert.equal(first.shots[1].at, "concrete detail");
  assert.notEqual(first.shots[2].at, "bananas and cake", "an at that is not in the voice is dropped");
  assert.ok(quotesVoice(first.shots[2].at, first.voice), "and Kleo picks a legal anchor in its place, so the cut still lands on a word the viewer hears");
  for (const sc of sb.scenes) sc.shots.forEach((sh, i) => assert.ok(i === 0 || quotesVoice(sh.at, sc.voice), `${sc.id} shot ${i + 1}: every cut after the first is anchored`));
  assert.equal(first.shots[2].caption, undefined); assert.equal(first.shots[2].hl, undefined);
  assert.equal(first.shots[3].shot_kind, "detail", "the kind the author wrote is kept");
  // The shot grammar: story kinds only, never a camera move, and a sequence that is already shootable.
  const shots = flatShots(sb);
  assert.deepEqual(sequenceProblems(shots), []);
  assert.equal(shots[0].shot_kind, "hook", "the first shot of the video is the hook");
  assert.equal(shots.at(-1).shot_kind, "closing", "the last shot of the video is the closing");
  assert.ok(SHOT_KINDS.includes(first.shots[1].shot_kind), "an invented camera phrase is replaced by a real kind");
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
  // The shorthand becomes shot 1 — and, having named nothing that moves, it is given something: a still description
  // comes back as a frozen frame once the shot is a generated clip (measured at 0.03 px), so the planner repairs it.
  assert.equal(a.shots.length, 1);
  assert.equal(a.shots[0].shot_kind, "hook", "the first picture of the video opens it");
  assert.ok(a.shots[0].image_prompt.startsWith("A wooden ship at anchor in a turquoise bay under a stormy sky"), a.shots[0].image_prompt);
  assert.ok(stillness(a.shots[0].image_prompt).alive, "something in it is doing something");
  assert.ok(!("image_prompt" in a) && !("beats" in a) && !("eyebrow" in a) && !("visual" in a) && !("items" in a));
  const z = sb.scenes[1];
  assert.equal(z.shots.length, 2, "a closing shows one picture, two at most");
  assert.equal(z.shots[1].at, "part two");
  assert.equal(z.button, undefined, "a button longer than 24 characters is dropped");
  assert.ok(!("detail" in z), "the picture style has no detail line");
  // The shorthand normalises, but one picture for a whole narrated line is refused however it was written — and that
  // is the ONLY thing left wrong with this storyboard.
  const one = validateStoryboard(sb, { format: "9:16", language: "en" });
  assert.equal(one.ok, false);
  assert.deepEqual(one.errors.filter((e) => !/a scene needs at least 2/.test(e)), []);
  // A scene the model left without any usable picture still renders: the title becomes the prompt.
  const bare = normalizeStoryboard({ title: "T", scenes: [
    { id: "01-a", kind: "cinema", chapter: "01 A", accent: "red", title: "A quiet street at dawn", hl: "quiet", voice: "A quiet street at dawn, and nobody is watching the door.", shots: [{ caption: "NOTHING" }] },
    { id: "02-b", kind: "closing", accent: "green", title: "Follow", voice: "Follow for part two.", shots: [{ image_prompt: "An empty street at noon" }] },
  ] }, plan);
  assert.deepEqual(bare.scenes[0].shots, [{ image_prompt: "A quiet street at dawn", shot_kind: "hook" }]);
  const rescued = validateStoryboard(bare, { format: "9:16", language: "en" });
  assert.equal(rescued.ok, false, "it renders, but it is still one picture for a whole line");
  assert.deepEqual(rescued.errors.filter((e) => !/a scene needs at least 2/.test(e)), []);
  // An "at" the engine could not anchor is dropped here, quietly: it would otherwise cost a whole model round trip.
  const cuts = normalizeStoryboard({ title: "T", scenes: [
    { id: "01-part-s2", kind: "cinema", chapter: 7, hl: "   ", title: "The morning after", voice: "Whatever came next, nobody saw it coming.", shots: [
      { image_prompt: "A wide empty street at dawn" },
      { image_prompt: "A key on a kitchen bench", at: "ver came" },              // mid-word fragment → dropped
      { image_prompt: "A door left open", at: "  nobody saw  " },                // whole words with stray spaces → trimmed and kept
      { image_prompt: "A car pulling away", at: "nobody, saw" },                 // whole words but not a substring of the voice → dropped
    ] },
    { id: "01-part-s2", kind: "closing", title: "Follow", voice: "Follow for part two.", shots: [{ image_prompt: "An empty street at noon" }] },
  ] }, plan);
  assert.deepEqual(cuts.scenes.map((s) => s.id), ["01-part-p2", "01-part-p2-2"], '"-s<number>" is reserved for picture ids, so the scene is renamed');
  // An "at" the engine could not anchor is dropped, and Kleo then chooses a legal one in its place: the cut lands on a
  // word the viewer hears either way, and the model is not sent round the loop over a mis-quote.
  const ats = cuts.scenes[0].shots.map((sh) => sh.at);
  assert.equal(ats[0], undefined, "the first shot opens the scene");
  assert.equal(ats[2], "nobody saw", "an anchor the author quoted correctly is left alone");
  for (const [i, at] of ats.entries())
    if (i) assert.ok(typeof at === "string" && quotesVoice(at, cuts.scenes[0].voice), `shot ${i + 1}: "${at}" must quote the voice`);
  assert.equal(new Set(ats.slice(1)).size, ats.length - 1, "and no two pictures cut on the same words");
  assert.ok(!("chapter" in cuts.scenes[0]) && !("hl" in cuts.scenes[0]), "a chapter that is not text and a blank hl are dropped");
  assert.deepEqual(validateStoryboard(cuts, { format: "9:16", language: "en" }).errors ?? [], []);
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

/* ------------------------------------------------------------------ shot grammar */

const pictureScene = (i, n, shots) => ({
  id: `${String(i + 1).padStart(2, "0")}-part`, kind: i === n - 1 ? "closing" : "cinema", chapter: `0${i + 1} PART`, accent: "cyan",
  title: `Part ${i + 1}`, hl: "Part", voice: `Scene ${i + 1} of the story, told in one line.`, shots,
});

test("shot grammar: a missing shot_kind is filled by rule and the sequence comes out shootable", () => {
  const prompts = [
    "A lighthouse on a black cliff above a cold sea at dawn",
    "A rusted anchor half buried in grey shingle",
    "A wooden rowing boat drifting out of the bay",
    "An empty lifebuoy swinging from a rail in the wind",
    "The lighthouse lamp lit against a violet sky",
    "A long stone jetty running out into flat water",
    "A gull turning over the swell",
    "The bay seen from the cliff top at last light",
  ];
  const scenes = [0, 1, 2, 3].map((i) => pictureScene(i, 4, prompts.slice(i * 2, i * 2 + 2).map((image_prompt) => ({ image_prompt }))));
  assignShotKinds(scenes, "9:16");
  const shots = scenes.flatMap((sc) => sc.shots.map((sh) => ({ ...sh, scene: sc.id })));
  assert.deepEqual(sequenceProblems(shots), []);
  assert.equal(shots[0].shot_kind, "hook", "the first shot of the video is the hook");
  assert.equal(shots.at(-1).shot_kind, "closing", "a shot of the last scene is the closing");
  assert.ok(shots.every((sh) => SHOT_KINDS.includes(sh.shot_kind)), "every shot ends up with one of the ten story kinds");
  // Running it again changes nothing: the kinds it wrote are the kinds it keeps.
  const before = shots.map((sh) => sh.shot_kind);
  assignShotKinds(scenes, "9:16");
  assert.deepEqual(scenes.flatMap((sc) => sc.shots.map((sh) => sh.shot_kind)), before, "assigning twice is idempotent");
});

test("shot grammar: the routing rule beats the author, hands/crowd/signage/mechanism/two people all pin the camera", () => {
  const breaks = [
    "A close view of gloved hands soldering a green circuit board",       // hands
    "A crowd filling the square in front of the old town hall",           // crowd
    "A red neon sign glowing above a narrow doorway in the rain",         // signage
    "The gears of a harbour crane turning against a grey sky",            // mechanism
    "Two hooded figures facing each other under a street lamp at night",  // two people interacting
  ];
  for (const image_prompt of breaks) {
    assert.equal(needsStaticHold(image_prompt), true, `should break under motion: ${image_prompt}`);
    const scenes = [pictureScene(0, 2, [{ image_prompt, shot_kind: "hook" }]), pictureScene(1, 2, [{ image_prompt: "An empty pier at dawn" }])];
    assignShotKinds(scenes, "9:16");
    assert.equal(scenes[0].shots[0].shot_kind, "static_forced", `the routing rule must overrule "hook" for: ${image_prompt}`);
  }
  // A picture with nothing to break keeps the kind its author chose.
  const ok = [
    pictureScene(0, 3, [{ image_prompt: "An empty pier at dawn under a low grey sky", shot_kind: "hook" }, { image_prompt: "A mooring rope coiled on the wet boards" }]),
    pictureScene(1, 3, [{ image_prompt: "The same pier at noon, flat water on both sides" }]),
    pictureScene(2, 3, [{ image_prompt: "The pier from the headland at last light" }]),
  ];
  assignShotKinds(ok, "9:16");
  assert.equal(ok[0].shots[0].shot_kind, "hook");
});

test("shot grammar: loud moves stay rare and never touch, even when every shot asks to be loud", () => {
  const n = 20;
  const scenes = Array.from({ length: 5 }, (_, i) =>
    pictureScene(i, 5, Array.from({ length: 4 }, (_, j) => ({ image_prompt: `A cliff path above the sea, view ${i * 4 + j + 1}`, shot_kind: "hook" }))));
  assignShotKinds(scenes, "9:16");
  const shots = scenes.flatMap((sc) => sc.shots.map((sh) => ({ ...sh, scene: sc.id })));
  assert.equal(shots.length, n);
  assert.deepEqual(sequenceProblems(shots), []);
  const loud = shots.filter((sh) => isLoud(moveOfKind(sh.shot_kind))).length;
  assert.ok(loud <= LOUD_MAX_PER_WINDOW, `a 40s video takes at most ${LOUD_MAX_PER_WINDOW} loud moves, got ${loud}`);
});

test("the storyboard guide teaches shot_kind and never a camera move", () => {
  // The guide is built by src/guide.ts now, so this reads what a caller is actually handed, not the source of a
  // template literal. Only the picture looks have shot kinds; cyber and stickman have no camera to talk about.
  for (const style of [null, "cartoon", "realistic"]) {
    const block = guideText({ duration_s: 45, style, languages: ["en", "it"] });
    for (const kind of SHOT_KINDS) assert.ok(block.includes(kind), `${style}: the guide must name the shot kind "${kind}"`);
    assert.ok(/shot_kind says what the shot is FOR/.test(block), `${style}: the guide has a shot-kind section`);
    assert.ok(!/"motion":"(in|out|left|right)"/.test(block), `${style}: no worked example writes a camera move by hand`);
    assert.ok(/NEVER write a camera move/.test(block), `${style}: the guide forbids camera language outright`);
  }

  // The worked example must itself obey the sequencing rules: an example that breaks them teaches the model to.
  const shots = EXAMPLE_SCENES.flatMap((sc) => sc.shots.map((sh) => ({ ...sh, scene: sc.id })));
  assert.ok(shots.every((sh) => !sh.shot_kind || SHOT_KINDS.includes(sh.shot_kind)), "every kind in the example is one of the ten");
  assert.deepEqual(sequenceProblems(shots.map((sh) => ({ ...sh, shot_kind: sh.shot_kind ?? "establish" }))), []);
  assert.equal(shots[0].shot_kind, "hook", "the example opens on the hook");
  for (const sc of EXAMPLE_SCENES)
    sc.shots.forEach((sh, i) => assert.ok(i === 0 || (typeof sh.at === "string" && sh.at), `${sc.id} shot ${i + 1}: every picture after the first in a scene is anchored`));
});

test("shot grammar: whatever the model writes, the storyboard that comes out is one the contract will shoot", () => {
  // A deterministic sweep: every shape a model realistically hands back — no kinds at all, every kind loud, kinds
  // that repeat, a camera move written by hand, and pictures that trip the routing rule — over several lengths.
  const wild = ["hook", "tension", "detail_orbit", "hook", undefined, "closing", "face", "static_forced", "detail", "establish"];
  const breaks = ["A crowd filling the square at noon", "Gloved hands soldering a circuit board", "A red neon sign over a doorway", "The gears of a harbour crane turning"];
  const plain = ["An empty pier at dawn", "A lighthouse on a black cliff", "A rowing boat drifting out of the bay", "A gull turning over the swell", "A stone jetty in flat water"];
  for (const [duration, sceneCount] of [[30, 4], [45, 6], [120, 12], [300, 20]]) {
    for (const flavour of ["none", "wild", "breaking"]) {
      const j = job("viral-short", duration, "9:16", "en", "The lighthouse nobody was ever posted to", "cartoon");
      const plan = planFor(j);
      let n = 0;
      const scenes = Array.from({ length: sceneCount }, (_, i) => {
        const closing = i === sceneCount - 1;
        const shots = Array.from({ length: closing ? 1 : 2 + (i % 3) }, () => {
          const k = n++;
          const image_prompt = flavour === "breaking" && k % 3 === 0 ? breaks[k % breaks.length] : `${plain[k % plain.length]}, view ${k + 1}`;
          const shot = { image_prompt };
          if (flavour === "wild") { const w = wild[k % wild.length]; if (w) shot.shot_kind = w; else shot.motion = "in"; }
          return shot;
        });
        return { id: `${String(i + 1).padStart(2, "0")}-part`, kind: closing ? "closing" : "cinema", chapter: `0 PART`, accent: "cyan",
          title: `Part ${i + 1}`, hl: "Part", voice: `Scene ${i + 1} of the story, one line of narration and nothing more.`, shots };
      });
      const sb = normalizeStoryboard({ title: "Sweep", description: "d", tags: ["a"], scenes }, plan);
      const where = `${duration}s / ${sceneCount} scenes / ${flavour}`;
      const shots = flatShots(sb);
      assert.ok(shots.every((sh) => !("motion" in sh) || "shot_kind" in sh), `${where}: a camera move with no kind behind it`);
      assert.ok(shots.every((sh) => SHOT_KINDS.includes(sh.shot_kind)), `${where}: a shot came out without a story kind`);
      const r = validateStoryboard(sb, { format: "9:16", language: "en" });
      assert.deepEqual(r.ok ? [] : r.errors, [], `${where}: the contract refuses the plan`);
    }
  }
});

test("the direction is step zero: it reaches the storyboard, the colour law is applied, and a missing fact is fed back", async () => {
  let chunkCalls = 0;
  let sawDirectionBlock = 0;
  const env = fakeEnv((kind, user, attempt) => {
    if (kind === "outline") {
      // The outline must be told which section each scene sits in, and which facts it owes.
      assert.match(user, /SECTIONS \(fixed; every scene wears its section's accent/);
      assert.match(user, /FACTS TO PLACE/);
      const o = outlineFor(user, true);
      o.scenes.forEach((sc, i) => { sc.keeps = i === 1 ? [0] : []; });
      return o;
    }
    chunkCalls++;
    if (/DIRECTION OF THIS FILM/.test(user)) sawDirectionBlock++;
    const [from, to] = chunkRange(user);
    const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
    const scenes = [];
    for (let i = from; i < to; i++) {
      const closing = i === total - 1;
      // Scene 2 owes the fact "1720". The first attempt drops it; the retry says it.
      const voice = i === 1 && attempt === 1
        ? "The crew sailed away one grey morning and nobody wrote down the year at all."
        : i === 1
        ? "In 1720 the crew sailed away one grey morning and nobody ever saw them again."
        : `Scene ${i + 1} of the story, told in one line with a concrete detail in it.`;
      scenes.push({
        id: `${String(i + 1).padStart(2, "0")}-part`, kind: closing ? "closing" : "cinema", chapter: `0${i + 1} PART`,
        accent: "cyan", title: `Part ${i + 1}`, hl: "Part", voice, hold: 0.2,
        shots: closing
          ? [{ image_prompt: "An empty beach at noon, the tide coming in" }]
          : [{ image_prompt: `A wooden ship at anchor in a sandy bay, scene ${i + 1}` }, { image_prompt: "The same bay from the cliff above, empty" }],
      });
    }
    return { scenes };
  }, {
    direction: (kind, user) => {
      assert.match(user, /TASK: write the DIRECTION of this one film/);
      const n = Number(/add up to exactly (\d+)/.exec(user)[1]);
      return {
        style: "cartoon",
        why: "a story wants drawings",
        direction: {
          subject: "The crew that sailed away and never came back",
          goal: "The viewer wants to know where they went",
          audience: "People who like sea stories",
          tone: "Warm and a little eerie",
          must_keep: ["1720"],
          world: "A tropical bay in 1720, golden sand, turquoise water, wooden ships with red sails",
          cast: [{ name: "the captain", look: "a pirate captain with a red bandana and a long dark braid" }],
          objects: ["wooden ship", "sandy bay", "cliff", "rope"],
          forbidden: ["wifi symbol", "phone", "brand logo", "text in the picture"],
          sections: [
            { name: "01 THE BAY", accent: "amber", means: "where it began", scenes: 1 },
            { name: "02 THE CREW", accent: "red", means: "who left", scenes: n - 2 },
            { name: "03 THE QUESTION", accent: "green", means: "what is left", scenes: 1 },
          ],
        },
      };
    },
  });

  const r = await generateStoryboard(env, job("viral-short", 45, "9:16", "en", "The crew that sailed away in 1720 and never came back"));
  const sb = r.storyboard;
  assert.deepEqual(validateStoryboard(sb, { format: "9:16", language: "en" }).ok ? [] : validateStoryboard(sb, { format: "9:16", language: "en" }).errors, []);

  // The direction the film was planned under travels with it.
  assert.equal(sb.direction.subject, "The crew that sailed away and never came back");
  assert.deepEqual(r.direction.must_keep, ["1720"]);
  assert.equal(r.style, "cartoon", "the direction chose the look, not a keyword match on the prompt");
  assert.equal(sb.kleo_style, "cartoon"); assert.equal(sb.style, "picture");
  assert.ok(sawDirectionBlock === chunkCalls && chunkCalls >= 1, "every scene-writing call carried the direction");

  // The colour law: every scene wears its section's accent, whatever the model wrote.
  const accents = sb.scenes.map((s) => s.accent);
  assert.equal(accents[0], "amber");
  assert.equal(accents.at(-1), "green");
  assert.ok(accents.slice(1, -1).every((a) => a === "red"), accents.join(","));
  assert.ok(!accents.includes("cyan"), "the accent the model wrote is overwritten by the section it belongs to");

  // The fidelity gate: the fact was fed back and the finished narration says it.
  assert.match(sb.scenes[1].voice, /1720/);
  assert.deepEqual(r.missing_facts, []);
  assert.ok(r.history.some((h) => h.some((m) => /never says "1720"/.test(m))), JSON.stringify(r.history));
});

test("without a valid direction the planner still ships a video", async () => {
  const env = fakeEnv((kind, user) => {
    if (kind === "outline") {
      assert.doesNotMatch(user, /SECTIONS \(fixed/, "no direction means no section table");
      return outlineFor(user, true);
    }
    const [from, to] = chunkRange(user);
    const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
    const scenes = [];
    for (let i = from; i < to; i++) {
      const closing = i === total - 1;
      scenes.push({
        id: `${String(i + 1).padStart(2, "0")}-part`, kind: closing ? "closing" : "cinema", chapter: `0${i + 1} PART`,
        accent: "cyan", title: `Part ${i + 1}`, hl: "Part", hold: 0.2,
        voice: `Scene ${i + 1} of the story, told in one line with a concrete detail in it.`,
        shots: closing ? [{ image_prompt: "An empty beach at noon" }]
          : [{ image_prompt: `A ship at anchor, scene ${i + 1}` }, { image_prompt: "The same bay from the cliff above" }],
      });
    }
    return { scenes };
  }, { direction: () => ({ direction: { subject: "" } }) }); // rejected twice, then given up on

  const r = await generateStoryboard(env, job("viral-short", 45, "9:16", "en", "The crew that sailed away"));
  assert.equal(r.direction, null);
  assert.equal(r.storyboard.direction, undefined, "no direction travels with the storyboard");
  assert.deepEqual(validateStoryboard(r.storyboard, { format: "9:16", language: "en" }).ok ? [] : ["invalid"], []);
  assert.ok(r.history.some((h) => h.some((m) => /^direction: rejected/.test(m))), JSON.stringify(r.history));
});
