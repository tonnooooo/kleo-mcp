/**
 * Offline tests for src/storyboard.ts: a fake env.AI replays the defects seen with real Workers AI output
 * (invented icon names, "at " keys, beats without their fields, narration over 350 chars, metric without value,
 * garbled JSON, quota errors) and the generator must still produce a contract-valid storyboard.
 * Run: node --test test/storyboard.test.mjs   (never calls Workers AI)
 */
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { sectionSkeleton, generateStoryboard, fixtureStoryboard, isTransientAiError, StoryboardError, styleFor, keouStyleFor, pickKleoStyle, planFor, normalizeStoryboard, callModel, withTimeout, PlanBudgetError, TRANSLATOR_SYSTEM, planModel, setAnthropicFetch, isClaudeModel, setPlanFetch } from "../src/storyboard.ts";
import { guideText, EXAMPLE_SCENES } from "../src/guide.ts";
import { stillness } from "../src/direction.ts";
import { TEMPLATE_IDS } from "../src/templates.ts";
import { directionProblems, CINEMA_ACCENTS, notEnglish } from "../src/keou-contract.ts";
import { validateStoryboard, pictureScenes, quotesVoice, BEAT_ICONS, STORY_ACTS } from "../src/keou-contract.ts";
import { assignShotKinds } from "../src/storyboard.ts";
import { SHOT_KINDS, presetFor, moveClassOf, isLoud, needsStaticHold, LOUD_MAX_PER_WINDOW } from "../src/shot-grammar.ts";
import { TREATMENT_FIXTURE } from "./fixtures/treatment.mjs";

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
  // The prompt now PRINTS the shape instead of asking for one, so a fake reads the number of sections off it.
  const n = (user.match(/^ {2}\d+\. /gm) || []).length || 3;
  const sections = Array.from({ length: n }, (_, i) => ({ name: `0${i + 1} PART`, means: "a part of the story" }));
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
      // The treatment call (step -1 since 14 September) is answered by the fixture unless a test passes
      // `opts.treatment`, the same way the direction is: no test here has to know the step exists.
      const kind = /TASK: write the TREATMENT/.test(user) ? "treatment"
        : /TASK: write the DIRECTION/.test(user) ? "direction"
        : /TASK: plan the whole video/.test(user) ? "outline"
        // The English pass (19 September): the direction's picture fields, then the picture prompts, come back in
        // English. Answered as the identity unless a test cares (`respond` sees the kind like any other).
        : /TASK: return the same object with every value in natural English/.test(user) ? "english-fields"
        : /TASK: return \{"prompts":/.test(user) ? "english-prompts" : "chunk";
      const key = kind === "chunk" ? `chunk-${chunkRange(user).join("-")}` : kind;
      const a = (attempts.get(key) ?? 0) + 1; attempts.set(key, a);
      const handler = kind === "treatment" ? (opts.treatment ?? (() => TREATMENT_FIXTURE(Number(/THE FILM: .*?, (\d+) seconds/.exec(user)?.[1] ?? 45))))
        : kind === "direction" ? (opts.direction ?? directionFor) : respond;
      const out = (kind === "treatment" && !opts.treatment) || (kind === "direction" && !opts.direction) ? handler(user) : await handler(kind, user, a, inputs);
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

// 13 September: the editorial (cyber) look was removed from the product; every new job is the realistic film and the
// planner no longer reaches this path. The normalisation it guarded goes with the editorial planner when that code
// is deleted; until then the test is retired, not deleted, so the removal stays visible.
test("editorial: garbled JSON is retried, under-specified scenes are downgraded, junk fields removed", { skip: "the editorial look was removed from the product on 13 September 2026" }, async () => {
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
  assert.equal(sb.kleo_style, "realistic"); assert.equal(sb.style, "picture"); assert.equal(r.style, "realistic");   // one look (13 September)
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
      const n = (user.match(/^ {2}\d+\. /gm) || []).length;
      assert.ok(n >= 2, `the prompt must print the shape: ${n} sections found`);
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
          sections: Array.from({ length: n }, (_, i) => ({ name: `0${i + 1} OF THE STORY`, means: "what this part is for" })),
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
  // One look (13 September): the direction may say what it likes, the film is realistic.
  assert.equal(r.style, "realistic", "the direction's look is read and ignored: there is one look");
  assert.equal(sb.kleo_style, "realistic"); assert.equal(sb.style, "picture");
  assert.ok(sawDirectionBlock === chunkCalls && chunkCalls >= 1, "every scene-writing call carried the direction");

  // The colour law: every scene wears its section's accent, whatever the model wrote.
  // The colour law: the accents come from the TEMPLATE's shape, not from the model and not from the scene.
  const bones = sectionSkeleton("viral-short", sb.scenes.length);
  const want = bones.flatMap((b) => Array.from({ length: b.scenes }, () => b.accent));
  assert.deepEqual(sb.scenes.map((s) => s.accent), want, "every scene wears the accent of the section it sits in");
  assert.ok(new Set(want).size > 1, "and the film is not one colour throughout");

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

test("the shape of the film comes from the template, and it is legal before the model sees it", () => {
  // The direction used to make the model invent how many sections a film has, what colour each wears and how the
  // scenes divide — then repairDirection patched the sums. The shape arrives correct now, so the two rules the
  // direction is validated against hold by construction, at every length, for every template.
  for (const t of TEMPLATE_IDS) {
    for (const scenes of [3, 4, 6, 12, 30, 60]) {
      const bones = sectionSkeleton(t, scenes);
      assert.ok(bones.length >= 2, `${t}: ${bones.length} sections`);
      assert.equal(bones.reduce((a, b) => a + b.scenes, 0), scenes, `${t} at ${scenes}: the sections must tile the film`);
      assert.ok(bones.every((b) => b.scenes >= 1), `${t} at ${scenes}: a section with no scene is not a section`);
      bones.forEach((b, i) => {
        assert.ok(b.name && b.role, `${t}: section ${i + 1} needs a name and a role`);
        if (i) assert.notEqual(b.accent, bones[i - 1].accent, `${t}: sections ${i} and ${i + 1} share an accent`);
      });
      // And what it produces is a legal direction skeleton by the contract's own rules, with nothing to repair.
      const d = {
        subject: "x", goal: "y", audience: "z", tone: "w", world: "a place",
        must_keep: [], cast: [], objects: ["a", "b", "c"], forbidden: ["x1", "x2", "x3"],
        sections: bones.map((b) => ({ name: b.name, means: b.role.slice(0, 40), accent: b.accent, scenes: b.scenes })),
      };
      assert.deepEqual(directionProblems(d, { accents: CINEMA_ACCENTS, scenes }), [], `${t} at ${scenes}`);
    }
  }
});

test("the animation look (14 September) is a picture project planned in its own look, named or read off the row", () => {
  assert.equal(keouStyleFor("animation", "viral-short", "9:16"), "picture");
  assert.equal(keouStyleFor("animation", "youtube-long", "16:9"), "picture");
  const plan = planFor(job("viral-short", 45, "9:16", "en", "A fox who learns to swim, told as an animated film", "animation"));
  assert.equal(plan.kleo, "animation"); assert.equal(plan.style, "picture");
  assert.equal(planFor(job("viral-short", 45, "9:16", "en", "A fox who learns to swim")).kleo, "realistic", "unnamed stays realistic");
});


/* ------------------------------------------------------------------ the pictures speak English (19 September 2026) */

test("an Italian film: the direction's picture fields and every picture prompt come out in English, whatever the model wrote", async () => {
  // Job gt_ad2musq5: an Italian animatic whose cast look ("capelli biondi corti e raccolti, grembiule lilla") and
  // picture prompts reached the GPU in Italian, and came back as three different women in red aprons. The planner
  // now asks for English, and then makes sure of it: one call for the direction's picture fields, one for the
  // prompts the chunks still wrote in Italian.
  const asked = { fields: 0, prompts: [] };
  let chunkSystemSaidEnglish = 0;
  const env = fakeEnv((kind, user, attempt, inputs) => {
    if (kind === "outline") return outlineFor(user, true);
    if (kind === "english-fields") {
      asked.fields++;
      const f = JSON.parse(/^\{.*\}$/m.exec(user)[0]);
      assert.equal(f.cast[0].name, "la pasticcera", "the fields go out as the direction wrote them");
      return { world: "A country village of small houses and dirt roads", cast: [{ name: "the pastry chef", look: "a thin woman with short blonde hair tied up, in a lilac apron" }], objects: f.objects.map((_, i) => ["kitchen", "cake", "apron"][i]), forbidden: f.forbidden.map((_, i) => ["phone", "computer", "logos"][i]) };
    }
    if (kind === "english-prompts") {
      const { prompts } = JSON.parse(/^\{"prompts":.*\}$/m.exec(user)[0]);
      asked.prompts.push(...prompts);
      return { prompts: prompts.map((_, i) => `The pastry chef in her lilac apron setting a golden cake on the kitchen counter, picture ${i + 1}`) };
    }
    if (/IS WRITTEN IN ENGLISH/.test(inputs.messages[0].content)) chunkSystemSaidEnglish++;
    assert.match(user, /WRITTEN IN ENGLISH \(only the voice is in the narration's language\)/, "the chunk task says it too");
    const [from, to] = chunkRange(user);
    const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
    const scenes = [];
    for (let i = from; i < to; i++) {
      const closing = i === total - 1;
      scenes.push({
        id: `${String(i + 1).padStart(2, "0")}-parte`, kind: closing ? "closing" : "cinema", chapter: `0${i + 1} PARTE`,
        accent: "cyan", title: `Parte ${i + 1}`, hl: "Parte", hold: 0.2,
        voice: `Nella scena ${i + 1} la pasticcera prepara una torta dorata nella sua cucina calda e la porta ai bambini del paese.`,
        shots: closing ? [{ image_prompt: "La pasticcera seduta a un lungo tavolo all'aperto, circondata dai bambini e dalle famiglie" }]
          : [{ image_prompt: `La pasticcera con il grembiule lilla sistema una torta sul banco della cucina, scena ${i + 1}` }, { image_prompt: "I bambini del paese ricevono le torte sulla porta di casa, sorridendo" }],
      });
    }
    return { scenes };
  }, {
    direction: (kind, user) => {
      assert.match(user, /THE PICTURE FIELDS — "world", every cast "name" and "look", "objects" and "forbidden" — which are written in ENGLISH/);
      const n = (user.match(/^ {2}\d+\. /gm) || []).length;
      return {
        style: "animation", why: "a tale wants drawing",
        direction: {
          subject: "la storia di una pasticcera che aiuta i bambini poveri", goal: "capire il valore della generosità", audience: "bambini e adulti", tone: "dolce e gentile",
          must_keep: [], world: "Un paesino di campagna con case piccole e strade sterrate",
          cast: [{ name: "la pasticcera", look: "una donna magra con i capelli biondi corti e raccolti e il grembiule lilla" }],
          objects: ["cucina", "torta", "grembiule"], forbidden: ["telefono", "computer", "loghi"],
          sections: Array.from({ length: n }, (_, i) => ({ name: `0${i + 1} DELLA STORIA`, means: "a cosa serve questa parte" })),
        },
      };
    },
  });
  const r = await generateStoryboard(env, job("viral-short", 30, "9:16", "it", "Una dolce pasticcera magra con i capelli biondi corti e raccolti, con il grembiule lilla, prepara torte per i bambini poveri del paese.", "animation"));
  const sb = r.storyboard;
  const v = validateStoryboard(sb, { format: "9:16", language: "it" });
  assert.deepEqual(v.ok ? [] : v.errors, []);
  assert.deepEqual(v.warnings.filter((w) => /must be in English/.test(w)), [], v.warnings.join("\n"));
  assert.equal(asked.fields, 1, "one call for the direction's picture fields");
  assert.equal(sb.direction.world, "A country village of small houses and dirt roads");
  assert.deepEqual(sb.direction.cast, [{ name: "the pastry chef", look: "a thin woman with short blonde hair tied up, in a lilac apron" }]);
  assert.deepEqual(sb.direction.objects, ["kitchen", "cake", "apron"]);
  assert.deepEqual(sb.direction.forbidden, ["phone", "computer", "logos"]);
  assert.equal(sb.direction.subject, "la storia di una pasticcera che aiuta i bambini poveri", "the story fields stay in the film's language");
  const prompts = sb.scenes.flatMap((s) => s.shots.map((sh) => sh.image_prompt));
  assert.ok(prompts.length >= 5, `${prompts.length} pictures`);
  for (const p of prompts) { assert.ok(!notEnglish(p), p); assert.match(p, /^The pastry chef in her lilac apron/); }
  assert.equal(asked.prompts.length, prompts.length, "every Italian prompt went through the one translating call");
  assert.ok(sb.scenes.every((s) => /pasticcera/.test(s.voice)), "the narration is untouched");
  assert.ok(chunkSystemSaidEnglish >= 1, "the system prompt asked for English pictures");
  assert.ok(!r.history.flat().some((m) => /english pass/.test(m)), JSON.stringify(r.history));
  // Every shot still carries a resolved move: the translated prompts were routed again, nothing was left half-done.
  for (const s of sb.scenes) for (const sh of s.shots) assert.ok(typeof sh.motion === "string" && sh.shot_kind, JSON.stringify(sh));
});

test("an English film never pays for the English pass", async () => {
  let passes = 0;
  const env = fakeEnv((kind, user) => {
    if (kind === "english-fields" || kind === "english-prompts") { passes++; return {}; }
    if (kind === "outline") return outlineFor(user, true);
    const [from, to] = chunkRange(user);
    const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
    const scenes = [];
    for (let i = from; i < to; i++) {
      const closing = i === total - 1;
      scenes.push({ id: `${String(i + 1).padStart(2, "0")}-part`, kind: closing ? "closing" : "cinema", chapter: `0${i + 1} PART`, accent: "cyan", title: `Part ${i + 1}`, hl: "Part", hold: 0.2,
        voice: `Scene ${i + 1} of the story, told in one line with a concrete detail in it.`,
        shots: closing ? [{ image_prompt: "An empty beach at noon" }] : [{ image_prompt: `A ship at anchor, scene ${i + 1}` }, { image_prompt: "The same bay from the cliff above" }] });
    }
    return { scenes };
  });
  await generateStoryboard(env, job("viral-short", 45, "9:16", "en", "The crew that sailed away"));
  assert.equal(passes, 0);
});

test("gpt-oss on Workers AI is called with low reasoning, six times the room and no json_schema", async () => {
  // Measured 20 September 2026: with a json_schema the direction call spent all 3600 tokens and returned an empty
  // string; without it, 29 s and a clean object. The 17B and every other model keep the schema.
  const seen = [];
  const env = { AI: { async run(model, inputs) { seen.push({ model, inputs }); return { choices: [{ message: { content: "Sure:\n{\"ok\":1}" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }; } } };
  const out = await callModel(env, "@cf/openai/gpt-oss-120b", [{ role: "user", content: "x" }], { type: "object" }, 900);
  assert.deepEqual(out.raw, { ok: 1 });
  assert.equal(seen[0].inputs.response_format, undefined, "no constrained decoding for gpt-oss");
  assert.deepEqual(seen[0].inputs.reasoning, { effort: "low" });
  assert.equal(seen[0].inputs.max_tokens, 5400);
  await callModel(env, "@cf/meta/llama-4-scout-17b-16e-instruct", [{ role: "user", content: "x" }], { type: "object" }, 900);
  assert.ok(seen[1].inputs.response_format, "the 17B keeps the schema");
  assert.equal(seen[1].inputs.max_tokens, 900);
  assert.equal(seen[1].inputs.reasoning, undefined);
});

test("a model call that never answers times out, and the timeout is not a quota error", async () => {
  const env = { AI: { run: () => new Promise(() => {}) } };
  await assert.rejects(callModel(env, "@cf/meta/test", [{ role: "user", content: "x" }], {}, 10, 0.3, 40), /model call \(@cf\/meta\/test\) timed out after 0 s/);
  assert.equal(isTransientAiError(new Error("model call (m) timed out after 90 s")), false, "a stuck call retries the attempt, it does not pause planning for a quarter of an hour");
  assert.equal(await withTimeout(Promise.resolve(7), 1000, "x"), 7);
  assert.ok(new PlanBudgetError("x", ["y"]) instanceof StoryboardError, "the budget error is a planning error the orchestrator already knows how to fail");
});


/* ------------------------------------------------------------------ the planner on Claude (20 September 2026) */

test("PLAN_MODEL sends every planning call to the Anthropic API — only when the key is there", async () => {
  assert.equal(planModel({ PLAN_MODEL: "claude-opus-5" }), undefined, "no key, no Claude: the 17B keeps planning");
  assert.equal(planModel({ PLAN_MODEL: "anthropic/claude-sonnet-5", PLAN_API_URL: "https://openrouter.ai/api/v1" }), undefined, "an endpoint without its key is no road");
  assert.equal(planModel({ PLAN_MODEL: "anthropic/claude-sonnet-5", PLAN_API_URL: "https://openrouter.ai/api/v1", PLAN_API_KEY: "or-test" }), "anthropic/claude-sonnet-5");
  assert.equal(planModel({ PLAN_MODEL: "anthropic/claude-sonnet-5", ANTHROPIC_API_KEY: "sk" }), undefined, "an OpenRouter-named model cannot go down the Anthropic road");
  assert.equal(planModel({ PLAN_MODEL: "claude-opus-5", ANTHROPIC_API_KEY: "sk-test" }), "claude-opus-5");
  assert.equal(isClaudeModel("claude-sonnet-5"), true); assert.equal(isClaudeModel("@cf/meta/llama-4-scout-17b-16e-instruct"), false);
  const seen = [];
  setAnthropicFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), auth: init.headers?.get?.("x-api-key") ?? init.headers?.["x-api-key"], body });
    return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_details: null,
      content: [{ type: "text", text: "Here it is:\n```json\n{\"title\":\"Test\",\"scenes\":[]}\n```" }], usage: { input_tokens: 120, output_tokens: 30 } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const env = { ANTHROPIC_API_KEY: "sk-test", PLAN_MODEL: "claude-opus-5", AI: { run() { throw new Error("Workers AI must not be called"); } } };
    const out = await callModel(env, "claude-opus-5", [{ role: "system", content: "You output JSON." }, { role: "user", content: "Plan it." }], { type: "object" }, 700, 0.3, 5000);
    assert.deepEqual(out.raw, { title: "Test", scenes: [] }, "the JSON is read out of the text, fences and all");
    assert.deepEqual(out.usage, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /api\.anthropic\.com\/v1\/messages$/);
    assert.equal(seen[0].body.model, "claude-opus-5");
    assert.equal(seen[0].body.system, "You output JSON.");
    assert.deepEqual(seen[0].body.messages, [{ role: "user", content: "Plan it." }]);
    assert.equal(seen[0].body.temperature, undefined, "no sampling parameters on the 5-family");
    assert.ok(seen[0].body.max_tokens >= 8000, "room for the thinking that counts against max_tokens");
    // A refusal or an API error is an error the planner already knows how to retry or pause on.
    setAnthropicFetch(async () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429, headers: { "content-type": "application/json" } }));
    await assert.rejects(callModel(env, "claude-opus-5", [{ role: "user", content: "x" }], {}, 100, 0.3, 5000), (e) => /anthropic 429/.test(String(e)) && isTransientAiError(e));
    await assert.rejects(callModel({}, "claude-opus-5", [{ role: "user", content: "x" }], {}, 100), /needs the ANTHROPIC_API_KEY secret/);
  } finally { setAnthropicFetch(undefined); }
});


test("a narration that describes the video is sent back once; a thin cast look is rejected with the reason and fixed on the second try", async () => {
  // Job gt_6xchnk99 (20 September 2026): the 17B copied the request into the first line ("In a 30-second vertical
  // YouTube Short…") and wrote "a young Jedi-like warrior" as the whole look of the cast.
  const chunkAttempts = new Map();
  let directionCalls = 0;
  const env = fakeEnv((kind, user, attempt) => {
    if (kind === "outline") return outlineFor(user, true);
    const [from, to] = chunkRange(user);
    const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
    chunkAttempts.set(from, attempt);
    const scenes = [];
    for (let i = from; i < to; i++) {
      const closing = i === total - 1;
      const first = i === 0 && attempt === 1;
      scenes.push({ id: `${String(i + 1).padStart(2, "0")}-part`, kind: closing ? "closing" : "cinema", chapter: `0${i + 1} PART`, accent: "cyan", title: `Part ${i + 1}`, hl: "Part", hold: 0.2,
        voice: first ? "In a 30-second vertical YouTube Short, the young warrior receives a transmission from a dead planet." : `Scene ${i + 1}: the young warrior walks deeper into the ruined temple, one hand on the hilt.`,
        shots: closing ? [{ image_prompt: "The young warrior alone in the dark temple, the blade lighting his face" }] : [{ image_prompt: `The young warrior crossing the desert ruins, scene ${i + 1}` }, { image_prompt: "The young warrior reading a flickering hologram in the cockpit" }] });
    }
    return { scenes };
  }, {
    direction: (kind, user) => {
      directionCalls++;
      const n = (user.match(/^ {2}\d+\. /gm) || []).length;
      const thin = directionCalls === 1;
      if (!thin) assert.match(user, /YOUR PREVIOUS ANSWER WAS REJECTED[\s\S]*is a name, not a look/, "the second try is told why the first was refused");
      return { style: "realistic", why: "a place you could film", direction: {
        subject: "A young warrior finds the enemy alive", goal: "Dread", audience: "Sci-fi fans", tone: "Tense", must_keep: [],
        world: "A ruined desert planet under a twin sun, ancient stone temples", objects: ["temple", "energy sword", "spaceship", "hologram"], forbidden: ["logos", "text", "phones"],
        cast: [{ name: "the young warrior", look: thin ? "a young Jedi-like warrior" : "a young man in his twenties with short dark hair and light stubble, in a sand-coloured hooded robe" }],
        sections: Array.from({ length: n }, (_, i) => ({ name: `0${i + 1} OF THE STORY`, means: "what this part is for" })) } };
    },
  });
  const r = await generateStoryboard(env, job("viral-short", 30, "9:16", "en", "A 30-second vertical YouTube Short: a young warrior receives a transmission saying the enemy survived.", "realistic"));
  assert.equal(directionCalls, 2, "refused once, accepted once");
  assert.match(r.direction.cast[0].look, /^a young man in his twenties/);
  assert.ok(r.history.some((h) => h.some((m) => /direction: rejected \(direction\.cast\[0\]\.look "a young Jedi-like warrior" is a name/.test(m))), JSON.stringify(r.history));
  assert.ok(r.history.some((h) => h.some((m) => /scene 1: the narration talks about the video itself \("30-second"\)/.test(m))), JSON.stringify(r.history));
  assert.equal(chunkAttempts.get(0), 2, "the first chunk was asked again");
  assert.doesNotMatch(r.storyboard.scenes[0].voice, /30-second|Short/, "and the finished narration tells the story");
});


test("PLAN_API_URL + PLAN_API_KEY: every planning call goes to an OpenAI-compatible endpoint (OpenRouter), the JSON read out of the text", async () => {
  const seen = [];
  setPlanFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), auth: init.headers.authorization, body });
    if (body.model === "broken/model") return new Response(JSON.stringify({ error: { message: "model not found", code: 404 } }), { status: 200, headers: { "content-type": "application/json" } });
    if (body.model === "slow/model") return new Response("overloaded", { status: 503 });
    return new Response(JSON.stringify({ id: "gen-1", model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Here you go:\n```json\n{\"title\":\"Test\",\"scenes\":[]}\n```" } }], usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const env = { PLAN_API_URL: "https://openrouter.ai/api/v1/", PLAN_API_KEY: "or-test", PLAN_MODEL: "anthropic/claude-sonnet-5", AI: { run() { throw new Error("Workers AI must not be called"); } } };
    const out = await callModel(env, "anthropic/claude-sonnet-5", [{ role: "system", content: "You output JSON." }, { role: "user", content: "Plan it." }], { type: "object" }, 700, 0.3, 5000);
    assert.deepEqual(out.raw, { title: "Test", scenes: [] });
    assert.deepEqual(out.usage, { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 });
    assert.equal(seen[0].url, "https://openrouter.ai/api/v1/chat/completions", "one slash, whatever the base ends with");
    assert.equal(seen[0].auth, "Bearer or-test");
    assert.deepEqual(seen[0].body.messages, [{ role: "system", content: [{ type: "text", text: "You output JSON.", cache_control: { type: "ephemeral" } }] }, { role: "user", content: "Plan it." }], "the system prompt is cached on a Claude model");
    assert.equal(seen[0].body.temperature, undefined, "no sampling parameters for a Claude model, OpenRouter passes them through");
    assert.deepEqual(seen[0].body.reasoning, { effort: "low" }, "measured: 0 reasoning tokens, same JSON, 40% cheaper");
    assert.ok(seen[0].body.max_tokens >= 8000);
    const gpt = await callModel(env, "openai/gpt-5-mini", [{ role: "user", content: "x" }], {}, 700, 0.3, 5000);
    assert.deepEqual(gpt.raw, { title: "Test", scenes: [] });
    assert.equal(seen[1].body.temperature, 0.3, "other models keep the planner's temperature");
    assert.deepEqual(seen[1].body.messages, [{ role: "user", content: "x" }], "no cache block for a non-Claude model");
    // An error in a 200 body, and a real 5xx: both errors, the second one transient.
    await assert.rejects(callModel(env, "broken/model", [{ role: "user", content: "x" }], {}, 100, 0.3, 5000), /plan api: model not found/);
    await assert.rejects(callModel(env, "slow/model", [{ role: "user", content: "x" }], {}, 100, 0.3, 5000), (e) => /plan api 503/.test(String(e)) && isTransientAiError(e));
    // Without the road, an external model is refused in words; a Workers AI model never touches the endpoint.
    await assert.rejects(callModel({ AI: env.AI }, "openai/gpt-5-mini", [{ role: "user", content: "x" }], {}, 100), /no road to model openai\/gpt-5-mini/);
  } finally { setPlanFetch(undefined); }
});
