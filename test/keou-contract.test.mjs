/**
 * Unit tests for src/keou-contract.ts (the TypeScript mirror of worker/keou/contract.py).
 * Run: node --test test/keou-contract.test.mjs   (Node ≥ 22.18 strips the types natively)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStoryboard, defaultVoice, wordBudget, kleoStyleOf, pictureScenes, VOICES, FORBIDDEN_FIELDS, FORBIDDEN_KINDS, FORBIDDEN_SCENE_FIELDS, KLEO_STYLES, IMAGE_PROMPT_MAX, MAX_PICTURES, SHOT_MOTION, SHOT_FIELDS, SHOTS_PER_SCENE } from "../src/keou-contract.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(ROOT, "worker", "keou", "examples");
const load = (name) => JSON.parse(readFileSync(join(EXAMPLES, name, "project.json"), "utf8"));

/** What the server stores: the project without the worker-owned fields and without asset scenes. */
function toStoryboard(project) {
  const sb = structuredClone(project);
  for (const f of ["id", "script_file", "music_quiet"]) delete sb[f];
  sb.scenes = sb.scenes.filter((s) => s.kind !== "image");
  for (const s of sb.scenes) { delete s.image; delete s.image_credit; } // pictures are attached by the worker, never sent by a client
  return sb;
}
const opts = (p) => ({ format: p.format, language: p.language });
const errorsOf = (sb, o) => { const r = validateStoryboard(sb, o); assert.equal(r.ok, false, "expected a validation failure"); return r.errors; };
const cinema = () => toStoryboard(load("short-relay-cinema"));
const editorial = () => toStoryboard(load("galactic-black-hole"));
/** The picture-style storyboards a client would send (test/fixtures), not the engine projects. */
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "test", "fixtures", `${name}.json`), "utf8"));
const pirates = () => fixture("cartoon-pirates");
const space = () => fixture("realistic-space");

test("every example project validates once turned into a storyboard", () => {
  const names = readdirSync(EXAMPLES).filter((n) => !n.startsWith("."));
  assert.ok(names.length >= 4, `expected the Keou examples, found ${names.length}`);
  for (const name of names) {
    const p = load(name);
    // A picture-style example is an engine project (look + img/ assets on its shots), never a client storyboard.
    if (p.style === "picture") { assert.equal(typeof p.look, "string", `${name} is a picture project and needs a look`); continue; }
    const r = validateStoryboard(toStoryboard(p), opts(p));
    assert.deepEqual(r.ok ? [] : r.errors, [], `${name} should validate`);
  }
});

test("image scenes are refused (no assets travel with a job)", () => {
  const p = load("galactic-black-hole");
  const sb = structuredClone(p); delete sb.id; delete sb.script_file;
  const errors = errorsOf(sb, opts(p));
  assert.ok(errors.some((e) => /scene 1: image scenes are not allowed/.test(e)), errors.join("\n"));
  assert.deepEqual([...FORBIDDEN_KINDS], ["image"]);
});

test("forbidden top-level fields are reported", () => {
  const sb = cinema();
  sb.id = "x"; sb.script_file = "script.txt"; sb.music_quiet = { from: "01-gone", to: "02-relay" };
  const errors = errorsOf(sb, { format: "9:16", language: "en" });
  for (const f of FORBIDDEN_FIELDS) assert.ok(errors.some((e) => e.startsWith(`${f} must not be part of a storyboard`)), `missing error for ${f}`);
});

test("bad enum: unknown style and unknown beat icon", () => {
  const sb = cinema();
  sb.style = "neon";
  assert.ok(errorsOf(sb, { format: "9:16", language: "en" }).some((e) => e.startsWith("style must be one of ['cinema', 'editorial'")));
  const sb2 = cinema();
  sb2.scenes[0].beats[1].name = "dragon";
  assert.ok(errorsOf(sb2, { format: "9:16", language: "en" }).some((e) => e.startsWith("scene 1 beat 2: icon name must be one of")));
});

test("beat `at` must quote words from the scene voice", () => {
  const sb = cinema();
  sb.scenes[1].beats[2].at = "bananas";
  const errors = errorsOf(sb, { format: "9:16", language: "en" });
  assert.ok(errors.includes("scene 2 beat 3: at must quote words from this scene's voice"), errors.join("\n"));
});

test("last scene must be a closing", () => {
  const sb = editorial();
  sb.scenes.pop();
  assert.ok(errorsOf(sb, { format: "9:16", language: "en" }).includes("Last scene must be a closing"));
});

test("too many beats (max 8) and too many items", () => {
  const sb = cinema();
  const s = sb.scenes[1];
  while (s.beats.length < 9) s.beats.push({ kind: "icon", name: "car" });
  assert.ok(errorsOf(sb, { format: "9:16", language: "en" }).includes("scene 2: beats must list one to eight hero visuals"));
  const sb2 = editorial();
  const list = sb2.scenes.find((x) => x.kind === "list");
  list.items.push("one more");
  assert.ok(errorsOf(sb2, { format: "9:16", language: "en" }).some((e) => /: 3 items required$/.test(e)));
});

test("stickman is portrait only; story scenes need stickman", () => {
  const sb = {
    schema_version: 1, editorial_status: "ready", title: "t", style: "stickman", format: "16:9", language: "en", voice: "am_michael",
    scenes: [{ id: "a", kind: "story", title: "A", voice: "hello there" }, { id: "z", kind: "closing", title: "Z", voice: "bye" }],
  };
  const errors = errorsOf(sb, { format: "16:9", language: "en" });
  assert.ok(errors.includes("The stickman style is laid out for 9:16 only"), errors.join("\n"));
  const sb2 = editorial();
  sb2.scenes[0] = { id: "s", kind: "story", title: "S", voice: "a story scene in the wrong style" };
  assert.ok(errorsOf(sb2, { format: "9:16", language: "en" }).includes("scene 1: story scenes need the stickman style"));
});

test("text limits: voice ≤ 350, title ≤ 90, type text ≤ 40, hl ≤ 20", () => {
  const sb = editorial();
  sb.scenes[0].voice = "word ".repeat(80);
  sb.scenes[1].title = "x".repeat(91);
  const errors = errorsOf(sb, { format: "9:16", language: "en" });
  assert.ok(errors.includes("scene 1 voice: required text, maximum 350 characters"), errors.join("\n"));
  assert.ok(errors.includes("scene 2 title: required text, maximum 90 characters"));
  const sb2 = cinema();
  sb2.scenes[0].beats[0].text = "THIS HEADLINE IS FAR TOO LONG FOR ONE SLAMMED CARD";
  sb2.scenes[0].beats[0].hl = "TWENTYONECHARACTERSXX";
  const e2 = errorsOf(sb2, { format: "9:16", language: "en" });
  assert.ok(e2.includes("scene 1 beat 1 text: required text, maximum 40 characters"));
  assert.ok(e2.includes("scene 1 beat 1 hl: required text, maximum 20 characters"));
});

test("unknown voice for the language; language/format must match the job", () => {
  const sb = editorial();
  sb.voice = "ff_siwis";
  assert.ok(errorsOf(sb, { format: "9:16", language: "en" }).includes("Unsupported language/voice combination"));
  const sb2 = editorial();
  sb2.language = "it"; sb2.voice = "if_sara";
  assert.ok(errorsOf(sb2, { format: "9:16", language: "en" }).some((e) => e.startsWith("language must be en for this job")));
  const sb3 = editorial();
  assert.ok(errorsOf(sb3, { format: "16:9", language: "en" }).some((e) => e.startsWith("format must be 16:9 for this job")));
  const it = editorial(); it.language = "it"; it.voice = "im_nicola";
  assert.equal(validateStoryboard(it, { format: "9:16", language: "it" }).ok, true);
  assert.deepEqual(VOICES.it, ["if_sara", "im_nicola"]);
});

test("cinema style only draws cinema and closing scenes; closing needs button xor detail", () => {
  const sb = cinema();
  sb.scenes[0].kind = "hero";
  assert.ok(errorsOf(sb, { format: "9:16", language: "en" }).includes("scene 1: the cinema style only draws cinema and closing scenes"));
  const sb2 = editorial();
  sb2.scenes.at(-1).detail = "and a detail";
  assert.ok(errorsOf(sb2, { format: "9:16", language: "en" }).some((e) => /: use either a closing button or a detail line$/.test(e)));
});

test("metric, quote, hold, speed, music, scene count and duplicate ids", () => {
  const sb = editorial();
  const metric = sb.scenes.find((s) => s.kind === "metric");
  metric.value = "4 MILLION MILLION";
  sb.scenes[0].hold = 5;
  sb.speed = 2; sb.music = "loud";
  sb.scenes[1].id = sb.scenes[0].id;
  const errors = errorsOf(sb, { format: "9:16", language: "en" });
  assert.ok(errors.some((e) => /value: required text, maximum 12 characters$/.test(e)), errors.join("\n"));
  assert.ok(errors.includes("scene 1 hold: expected a number between 0.15 and 3"));
  assert.ok(errors.includes("speed: expected a number between 0.8 and 1.3"));
  assert.ok(errors.includes("music must be bed or none"));
  assert.ok(errors.includes("Scene IDs must be unique slugs"));
  const one = editorial(); one.scenes = [one.scenes.at(-1)];
  assert.ok(errorsOf(one, { format: "9:16", language: "en" }).includes("A project needs 2–240 scenes"));
});

test("at most 10 errors are collected and garbage input never throws", () => {
  const sb = editorial();
  for (const s of sb.scenes) { s.title = ""; s.voice = ""; }
  assert.equal(errorsOf(sb, { format: "9:16", language: "en" }).length, 10);
  assert.equal(validateStoryboard(null, { format: "9:16", language: "en" }).ok, false);
  assert.equal(validateStoryboard("nope", { format: "9:16", language: "en" }).ok, false);
  assert.equal(validateStoryboard({ scenes: "x" }, { format: "9:16", language: "en" }).ok, false);
});

test("helpers: defaultVoice and wordBudget", () => {
  assert.equal(defaultVoice("en", "viral-short"), "am_michael");
  assert.equal(defaultVoice("en", "story-documentary"), "bf_emma");
  assert.equal(defaultVoice("en", "explainer"), "af_heart");
  assert.equal(defaultVoice("it", "explainer"), "if_sara");
  assert.equal(defaultVoice("it", "viral-short", "narrator-it-m"), "im_nicola");
  assert.equal(defaultVoice("en", "explainer", "narrator-it-m"), "am_michael", "keeps the gender, switches the language");
  assert.equal(defaultVoice("en", "explainer", "bf_emma"), "bf_emma");
  const b = wordBudget(45);
  assert.ok(b.target >= 100 && b.target <= 108, `45 s ≈ 104 words, got ${b.target}`);
  assert.ok(wordBudget(300).target >= 680 && wordBudget(300).target <= 700);
  assert.ok(b.min < b.target && b.target < b.max);
});

/* ------------------------------------------------------------------ Kleo styles and pictures (docs/PICTURE-STYLE.md) */

test("kleo_style: enum, default cyber, cartoon/realistic need the picture style, stickman needs stickman", () => {
  assert.deepEqual([...KLEO_STYLES], ["cartoon", "realistic", "cyber", "stickman"]);
  const plain = cinema();
  assert.equal(validateStoryboard(plain, { format: "9:16", language: "en" }).ok, true);
  assert.equal(kleoStyleOf(plain), "cyber");
  const cyber = cinema(); cyber.kleo_style = "cyber";
  assert.equal(validateStoryboard(cyber, { format: "9:16", language: "en" }).ok, true, "cyber keeps the cinema look");
  assert.equal(kleoStyleOf(cyber), "cyber");
  for (const sb of [pirates(), space()]) {
    assert.deepEqual(validateStoryboard(sb, opts(sb)).ok ? [] : validateStoryboard(sb, opts(sb)).errors, [], `${sb.kleo_style} fixture should validate`);
    assert.equal(kleoStyleOf(sb), sb.kleo_style);
    assert.equal(sb.style, "picture");
  }
  const bad = cinema(); bad.kleo_style = "anime";
  assert.ok(errorsOf(bad, { format: "9:16", language: "en" }).some((e) => e.startsWith("kleo_style must be one of ['cartoon', 'cyber', 'realistic', 'stickman']")));
  const ed = editorial(); ed.kleo_style = "cartoon";
  assert.ok(errorsOf(ed, { format: "9:16", language: "en" }).some((e) => /kleo_style cartoon needs the Keou style "picture"/.test(e)), "the message names the picture style");
  const asCinema = pirates(); asCinema.style = "cinema";
  assert.ok(errorsOf(asCinema, { format: "9:16", language: "en" }).some((e) => /kleo_style cartoon needs the Keou style "picture" \(full-screen shots cut on the narration\), not "cinema"/.test(e)));
  const ed2 = editorial(); ed2.kleo_style = "cyber";
  assert.equal(validateStoryboard(ed2, { format: "9:16", language: "en" }).ok, true, "cyber keeps the editorial look");
  const wrong = cinema(); wrong.kleo_style = "stickman";
  assert.ok(errorsOf(wrong, { format: "9:16", language: "en" }).some((e) => /kleo_style stickman needs the Keou style "stickman"/.test(e)));
  assert.equal(kleoStyleOf({ style: "picture" }), "cartoon", "a picture project without kleo_style reads as cartoon");
});

test("the picture style belongs to cartoon/realistic only, and shots need it", () => {
  const cyberPic = pirates(); cyberPic.kleo_style = "cyber";
  assert.ok(errorsOf(cyberPic, { format: "9:16", language: "en" }).some((e) => /the Keou style "picture" is the cartoon\/realistic look: set kleo_style to "cartoon" or "realistic", not "cyber"/.test(e)));
  const noStyle = pirates(); delete noStyle.kleo_style;
  assert.ok(errorsOf(noStyle, { format: "9:16", language: "en" }).some((e) => /the Keou style "picture" is the cartoon\/realistic look/.test(e)));
  const shotsInCinema = cinema();
  shotsInCinema.scenes[0].shots = [{ image_prompt: "a car in a driveway at night" }];
  assert.ok(errorsOf(shotsInCinema, { format: "9:16", language: "en" }).includes("scene 1: shots need the picture style (kleo_style cartoon or realistic)"));
});

test("cartoon and realistic render in 16:9 too; stickman in 16:9 is refused with a clear message", () => {
  const wide = space(); wide.format = "16:9";
  assert.equal(validateStoryboard(wide, { format: "16:9", language: "en" }).ok, true);
  const stick = {
    schema_version: 1, editorial_status: "ready", title: "t", style: "stickman", kleo_style: "stickman", format: "16:9", language: "en", voice: "am_michael",
    scenes: [{ id: "a", kind: "story", title: "A", voice: "hello there" }, { id: "z", kind: "closing", title: "Z", voice: "bye" }],
  };
  const errors = errorsOf(stick, { format: "16:9", language: "en" });
  assert.ok(errors.some((e) => e.startsWith("The stickman style makes 9:16 Shorts only")), errors.join("\n"));
  stick.format = "9:16";
  assert.equal(validateStoryboard(stick, { format: "9:16", language: "en" }).ok, true);
  assert.equal(kleoStyleOf({ style: "stickman" }), "stickman", "a stickman project without kleo_style is the stickman style");
});

test("shots: 1-4 on a cinema scene, 1-2 on a closing, only cinema/closing kinds", () => {
  const sb = pirates();
  sb.scenes[0].shots = [];
  assert.ok(errorsOf(sb, { format: "9:16", language: "en" }).includes("scene 1: shots must list 1–4 full-screen pictures"));
  const many = pirates();
  while (many.scenes[0].shots.length < 5) many.scenes[0].shots.push({ image_prompt: "one more picture of the same beach" });
  assert.ok(errorsOf(many, { format: "9:16", language: "en" }).includes("scene 1: shots must list 1–4 full-screen pictures"));
  const closing = pirates();
  closing.scenes.at(-1).shots.push({ image_prompt: "a second closing picture of the chest" }, { image_prompt: "a third one" });
  assert.ok(errorsOf(closing, { format: "9:16", language: "en" }).includes("scene 5: shots must list 1–2 full-screen pictures"));
  const two = pirates();
  two.scenes.at(-1).shots.push({ image_prompt: "the same beach a moment later, the chest closed again" });
  assert.equal(validateStoryboard(two, { format: "9:16", language: "en" }).ok, true, "a closing may hold two pictures");
  const none = pirates(); delete none.scenes[1].shots;
  assert.ok(errorsOf(none, { format: "9:16", language: "en" }).includes("scene 2: shots must list 1–4 full-screen pictures"), "shots are required");
  const hero = pirates(); hero.scenes[1].kind = "hero";
  assert.ok(errorsOf(hero, { format: "9:16", language: "en" }).includes("scene 2: the picture style only draws cinema and closing scenes"));
});

test("shot fields: image_prompt 2-240 required, caption ≤ 40, hl ≤ 20, motion enum, no shot.image", () => {
  const sb = pirates();
  delete sb.scenes[0].shots[1].image_prompt;
  assert.ok(errorsOf(sb, { format: "9:16", language: "en" }).includes(`scene 1 shot 2 image_prompt: required text, maximum ${IMAGE_PROMPT_MAX} characters`));
  const long = pirates(); long.scenes[0].shots[0].image_prompt = "x".repeat(IMAGE_PROMPT_MAX + 1);
  assert.ok(errorsOf(long, { format: "9:16", language: "en" }).includes(`scene 1 shot 1 image_prompt: required text, maximum ${IMAGE_PROMPT_MAX} characters`));
  const tiny = pirates(); tiny.scenes[0].shots[0].image_prompt = "a";
  assert.ok(errorsOf(tiny, { format: "9:16", language: "en" }).includes("scene 1 shot 1 image_prompt: required text, minimum 2 characters"));
  const blank = pirates(); blank.scenes[0].shots[0].image_prompt = "   ";
  assert.ok(errorsOf(blank, { format: "9:16", language: "en" }).some((e) => e.startsWith("scene 1 shot 1 image_prompt: required text")));
  const caption = pirates(); caption.scenes[0].shots[0].caption = "A CAPTION THAT IS FAR TOO LONG FOR THE SCREEN";
  assert.ok(errorsOf(caption, { format: "9:16", language: "en" }).includes("scene 1 shot 1 caption: required text, maximum 40 characters"));
  const hl = pirates(); hl.scenes[0].shots[0].hl = "TWENTYONECHARACTERSXX";
  assert.ok(errorsOf(hl, { format: "9:16", language: "en" }).includes("scene 1 shot 1 hl: required text, maximum 20 characters"));
  const motion = pirates(); motion.scenes[0].shots[0].motion = "spin";
  assert.ok(errorsOf(motion, { format: "9:16", language: "en" }).includes("scene 1 shot 1: motion must be one of ['in', 'left', 'out', 'right']"));
  assert.deepEqual([...SHOT_MOTION], ["in", "out", "left", "right"]);
  for (const m of SHOT_MOTION) { const ok = pirates(); ok.scenes[0].shots[0].motion = m; assert.equal(validateStoryboard(ok, { format: "9:16", language: "en" }).ok, true, m); }
  const img = pirates(); img.scenes[0].shots[0].image = "img/01-hook-s1.png";
  assert.ok(errorsOf(img, { format: "9:16", language: "en" }).some((e) => /scene 1 shot 1: image is not allowed in a storyboard/.test(e)));
  const notObj = pirates(); notObj.scenes[0].shots[1] = "a picture";
  assert.ok(errorsOf(notObj, { format: "9:16", language: "en" }).includes("scene 1 shot 2: must be an object"));
});

test("a shot carrying a field the engine does not know is refused here, not after the render", () => {
  assert.deepEqual([...SHOT_FIELDS], ["image_prompt", "caption", "hl", "at", "motion"]);
  const one = pirates(); one.scenes[0].shots[0].note = "remember to make her look tired";
  assert.ok(errorsOf(one, { format: "9:16", language: "en" }).includes("scene 1 shot 1: unknown shot fields ['note']"));
  const many = pirates();
  Object.assign(many.scenes[1].shots[2], { seed: 42, duration: 2.5, prompt: "a duplicate of image_prompt" });
  assert.ok(errorsOf(many, { format: "9:16", language: "en" }).includes("scene 2 shot 3: unknown shot fields ['duration', 'prompt', 'seed']"), "sorted, like contract.py");
  // `image` keeps its own message: it is a real engine field, only forbidden in a storyboard.
  const img = pirates(); img.scenes[0].shots[0].image = "img/01-hook-s1.png";
  const errors = errorsOf(img, { format: "9:16", language: "en" });
  assert.ok(errors.some((e) => /scene 1 shot 1: image is not allowed/.test(e)) && !errors.some((e) => /unknown shot fields/.test(e)), errors.join("\n"));
  // The five accepted fields together still validate.
  const all = pirates();
  Object.assign(all.scenes[0].shots[1], { caption: "SHE WALKED AWAY", hl: "AWAY", at: "never came back", motion: "left" });
  assert.equal(validateStoryboard(all, { format: "9:16", language: "en" }).ok, true);
});

test("shot `at`: ≤ 24 chars, quoted verbatim from the scene voice, never on the first shot", () => {
  const sb = pirates();
  sb.scenes[0].shots[1].at = "bananas";
  assert.ok(errorsOf(sb, { format: "9:16", language: "en" }).includes("scene 1 shot 2: at must quote words from this scene's voice"));
  const first = pirates(); first.scenes[0].shots[0].at = "Skull Beach";
  assert.ok(errorsOf(first, { format: "9:16", language: "en" }).includes("scene 1 shot 1: the first shot opens the scene, it cannot carry at"));
  const long = pirates(); long.scenes[0].shots[1].at = "she never came back for it at all";
  assert.ok(errorsOf(long, { format: "9:16", language: "en" }).includes("scene 1 shot 2 at: required text, maximum 24 characters"));
  const cased = pirates(); cased.scenes[0].shots[1].at = "NEVER CAME BACK";
  assert.equal(validateStoryboard(cased, { format: "9:16", language: "en" }).ok, true, "the quote is compared case-insensitively");
});

test("shot `at` is matched on whole words, the way the engine anchors the cut", () => {
  const miss = "at must quote words from this scene's voice";
  // A fragment inside a word is a substring of the voice but no run of words: picture.js would find no anchor and
  // fall back to the even split, so the server must not accept it.
  const cut = pirates(); cut.scenes[1].shots[1].at = "orty pirates";
  assert.ok(errorsOf(cut, { format: "9:16", language: "en" }).includes(`scene 2 shot 2: ${miss}`), "a cut word is not a quote");
  const head = pirates(); head.scenes[0].shots[1].at = "he never came back";
  assert.ok(errorsOf(head, { format: "9:16", language: "en" }).includes(`scene 1 shot 2: ${miss}`), '"he" is not the word "she"');
  // Whole words are not enough on their own: contract.py still runs its raw substring test on the GPU.
  const comma = pirates(); comma.scenes[1].shots[1].at = "the Red Gull was";
  assert.ok(errorsOf(comma, { format: "9:16", language: "en" }).includes(`scene 2 shot 2: ${miss}`), "the voice has a comma the quote drops");
  const punct = pirates(); punct.scenes[0].shots[1].at = ".";
  assert.ok(errorsOf(punct, { format: "9:16", language: "en" }).includes(`scene 1 shot 2: ${miss}`), "punctuation alone carries no word");
  // Punctuation *inside* a quote that is otherwise verbatim is fine: both engine checks find it.
  const inner = pirates(); inner.scenes[1].shots[1].at = "Red Gull, was";
  assert.equal(validateStoryboard(inner, { format: "9:16", language: "en" }).ok, true);
});

test("beats are forbidden in the picture style; the closing button is ≤ 24", () => {
  const sb = pirates();
  sb.scenes[0].beats = [{ kind: "type", text: "SHE NEVER CAME BACK", slam: true }];
  const errors = errorsOf(sb, { format: "9:16", language: "en" });
  assert.ok(errors.includes('scene 1: beats belong to the cinema style; the picture style cuts between "shots" instead'), errors.join("\n"));
  const button = pirates(); button.scenes.at(-1).button = "Follow for the second part";
  assert.ok(errorsOf(button, { format: "9:16", language: "en" }).includes("scene 5 button: required text, maximum 24 characters"));
  const ok = pirates(); ok.scenes.at(-1).button = "Follow";
  assert.equal(validateStoryboard(ok, { format: "9:16", language: "en" }).ok, true);
});

test("scene ids never end with the shot suffix (it belongs to picture ids)", () => {
  const sb = pirates();
  sb.scenes[1].id = "02-ship-s2";
  assert.ok(errorsOf(sb, { format: "9:16", language: "en" }).includes('scene 2 id: "-s" followed by a number is reserved for picture ids (02-ship-s2-s1, …); rename the scene'));
  const fine = pirates(); fine.scenes[1].id = "02-ship-s";
  assert.equal(validateStoryboard(fine, { format: "9:16", language: "en" }).ok, true, "only a trailing -s<number> is reserved");
  const cy = cinema(); cy.scenes[0].id = "01-gone-s12";
  assert.ok(errorsOf(cy, { format: "9:16", language: "en" }).some((e) => /^scene 1 id: "-s" followed by a number is reserved/.test(e)), "the rule holds in every style");
});

test("a scene-level image_prompt is normalised into shots[0] and disappears", () => {
  const sb = pirates();
  const scene = sb.scenes[1];
  delete scene.shots;
  scene.image_prompt = "  The Red Gull racing over turquoise waves under a clear sky  ";
  const r = validateStoryboard(sb, { format: "9:16", language: "en" });
  assert.deepEqual(r.ok ? [] : r.errors, []);
  assert.deepEqual(r.storyboard.scenes[1].shots, [{ image_prompt: "The Red Gull racing over turquoise waves under a clear sky" }]);
  assert.ok(!("image_prompt" in r.storyboard.scenes[1]), "the stored storyboard carries no scene-level image_prompt");
  assert.equal(pictureScenes(r.storyboard)[3].id, "02-ship-s1");
  const both = pirates();
  both.scenes[0].image_prompt = "a beach";
  const errors = errorsOf(both, { format: "9:16", language: "en" });
  assert.ok(errors.some((e) => /scene 1: put the picture on a shot/.test(e)), errors.join("\n"));
  const cyber = cinema(); cyber.scenes[0].image_prompt = "ignored in the cyber look";
  assert.equal(validateStoryboard(cyber, { format: "9:16", language: "en" }).ok, true, "a legacy cyber storyboard may still carry one");
  const ed = editorial(); ed.scenes[1].image_prompt = "a black hole seen from a distant moon";
  assert.equal(validateStoryboard(ed, { format: "9:16", language: "en" }).ok, true);
  const tooLong = cinema(); tooLong.scenes[0].image_prompt = "x".repeat(IMAGE_PROMPT_MAX + 1);
  assert.ok(errorsOf(tooLong, { format: "9:16", language: "en" }).includes(`scene 1 image_prompt: required text, maximum ${IMAGE_PROMPT_MAX} characters`));
});

test("pictureScenes flattens scene → shot in order, with `<sceneId>-s<n>` ids", () => {
  const sb = pirates();
  const pics = pictureScenes(sb);
  assert.equal(pics.length, sb.scenes.reduce((n, s) => n + s.shots.length, 0));
  assert.deepEqual(pics.slice(0, 4).map((p) => p.id), ["01-hook-s1", "01-hook-s2", "01-hook-s3", "02-ship-s1"]);
  assert.equal(pics.at(-1).id, "05-closing-s1");
  assert.equal(pics[0].image_prompt, sb.scenes[0].shots[0].image_prompt);
  assert.deepEqual(pictureScenes(space()).slice(0, 2).map((p) => p.id), ["01-hook-s1", "01-hook-s2"]);
  assert.deepEqual(pictureScenes(cinema()), [], "a legacy cyber storyboard asks for no picture");
  const legacyCyber = cinema(); legacyCyber.scenes.forEach((s) => { s.image_prompt = "a car at night"; });
  assert.deepEqual(pictureScenes(legacyCyber), [], "not even with image prompts on every scene");
  assert.deepEqual(pictureScenes(null), []);
  assert.deepEqual(pictureScenes({ kleo_style: "cartoon", scenes: "nope" }), []);
  const shorthand = { kleo_style: "realistic", scenes: [{ id: "01-a", image_prompt: "a rocket on the pad at dawn" }] };
  assert.deepEqual(pictureScenes(shorthand), [{ id: "01-a-s1", image_prompt: "a rocket on the pad at dawn" }], "the old shorthand still maps to shot 1");
  const gap = { kleo_style: "cartoon", scenes: [{ id: "01-a", shots: [{ image_prompt: "a beach" }, { caption: "NO PICTURE" }, { image_prompt: "a ship" }] }] };
  assert.deepEqual(pictureScenes(gap).map((p) => p.id), ["01-a-s1", "01-a-s3"], "ids follow the shot number, not the position in the answer");
});

test("MAX_PICTURES: 24 for a Short, 48 for a long video", () => {
  assert.equal(MAX_PICTURES(30), 24);
  assert.equal(MAX_PICTURES(90), 24);
  assert.equal(MAX_PICTURES(91), 48);
  assert.equal(MAX_PICTURES(600), 48);
});

/**
 * src/mcp.ts is the guide the calling model reads before it writes a storyboard, so every claim it makes has to be
 * one this validator agrees with: a drifted guide costs a whole rejected job. `guide` is the prose part (the tail,
 * from EXAMPLE A on, is checked by parsing and validating the examples themselves).
 */
const MCP_SRC = readFileSync(join(ROOT, "src", "mcp.ts"), "utf8");
const guideText = () => MCP_SRC.slice(MCP_SRC.indexOf("KLEO STORYBOARD GUIDE"), MCP_SRC.indexOf("EXAMPLE A"));
/** The guide is a template literal: drop the `${...}` holes so a check reads the prose, not the interpolation. */
const literalOnly = (text) => text.replace(/\$\{[^}]*\}/g, "");

test("the storyboard guide's examples validate against this contract", () => {
  const src = MCP_SRC;
  const examples = src.match(/\{"schema_version"[\s\S]*?\]\}\n/g) ?? [];
  assert.ok(examples.length >= 2, `expected the cartoon and realistic examples in the guide, found ${examples.length}`);
  const styles = new Set();
  for (const raw of examples) {
    const sb = JSON.parse(raw);
    styles.add(sb.kleo_style);
    assert.equal(sb.style, "picture");
    const r = validateStoryboard(sb, opts(sb));
    assert.deepEqual(r.ok ? [] : r.errors, [], `the ${sb.kleo_style} example should validate`);
    assert.ok(pictureScenes(sb).length >= sb.scenes.length, "every scene of an example carries at least one shot");
  }
  assert.deepEqual([...styles].sort(), ["cartoon", "realistic"]);
});

test("the guide only offers languages and voices kleo_create_video accepts", () => {
  const jobLangs = ["en", "it"];
  assert.match(MCP_SRC, /const JOB_LANGUAGES = \["en", "it"\] as const;/, "the job languages are declared once");
  assert.match(MCP_SRC, /z\.enum\(JOB_LANGUAGES\)/, "the tool schema and the guide read the same list");
  const guide = guideText();
  for (const lang of Object.keys(VOICES).filter((l) => !jobLangs.includes(l)))
    for (const v of VOICES[lang]) assert.ok(!guide.includes(v), `the guide must not offer ${v} (${lang} is not a job language)`);
  assert.ok(!/"fr"/.test(guide), "fr is not a language a job can have: the validator rejects a storyboard in it");
  assert.match(guide, /must equal the "format" and "language" you pass to kleo_create_video/);
});

test("the guide never suggests a field the validator forbids on a scene", () => {
  const guide = guideText();
  assert.ok(!guide.includes("JSON.stringify(MOTION)"), "scene motion backgrounds are a forbidden scene field");
  // "motion" is legal on a SHOT and forbidden on a scene: check the guide with the shot line taken out.
  const sceneLines = guide.split("\n").filter((l) => !l.trimStart().startsWith("SHOT:")).join("\n");
  for (const f of FORBIDDEN_SCENE_FIELDS)
    assert.ok(!new RegExp(`"${f}":`).test(sceneLines), `${f} must not be offered as a scene field`);
});

test("every shot count in the guide comes from SHOTS_PER_SCENE", () => {
  for (const [what, text] of [["guide", guideText()], ["instructions", MCP_SRC.slice(MCP_SRC.indexOf("const INSTRUCTIONS"), MCP_SRC.indexOf("const ok ="))]]) {
    assert.ok(!/\d ?- ?\d (?:pictures|shots)/.test(literalOnly(text)), `${what}: no hard-coded shot range, interpolate shotRange()`);
    assert.ok(!/exactly 1|has exactly one shot/.test(text), `${what}: the closing takes 1-2 shots, not exactly 1`);
  }
  assert.deepEqual(SHOTS_PER_SCENE.cinema, [1, 4]);
  assert.deepEqual(SHOTS_PER_SCENE.closing, [1, 2]);
  assert.match(MCP_SRC, /const shotRange = \(kind: "cinema" \| "closing"\) => SHOTS_PER_SCENE\[kind\]\.join\("-"\)/);
});
