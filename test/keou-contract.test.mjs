/**
 * Unit tests for src/keou-contract.ts (the TypeScript mirror of worker/keou/contract.py).
 * Run: node --test test/keou-contract.test.mjs   (Node ≥ 22.18 strips the types natively)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGuide, guideText, EXAMPLE_DIRECTION, EXAMPLE_SCENES } from "../src/guide.ts";
import { validateStoryboard, defaultVoice, wordBudget, kleoStyleOf, pictureScenes, directionProblems, sectionOfScene, CINEMA_ACCENTS, SHOTS_MIN_CINEMA, shotRangeText, VOICES, FORBIDDEN_FIELDS, FORBIDDEN_KINDS, FORBIDDEN_SCENE_FIELDS, KLEO_STYLES, IMAGE_PROMPT_MAX, MAX_PICTURES, SHOT_MOTION, SHOT_FIELDS, SHOTS_PER_SCENE, SHOT_KINDS, SHOT_GRAMMAR, durationFor, MOTION_ALIASES, MOTION_MOVES, MAX_SHOT_S, MAX_PERSON_SHOT_S, LOUD_WINDOW_S, LOUD_MAX_PER_WINDOW } from "../src/keou-contract.ts";

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
  // The message must name the voices that would work, or the model just guesses again on the next call.
  const voiceErr = errorsOf(sb, { format: "9:16", language: "en" }).find((e) => e.startsWith('voice "ff_siwis"'));
  assert.ok(voiceErr, "the rejected voice is named");
  assert.match(voiceErr, /does not speak en/);
  for (const v of ["af_heart", "am_michael", "bf_emma"]) assert.ok(voiceErr.includes(v), `suggests ${v}`);
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
  assert.deepEqual([...KLEO_STYLES], ["cartoon", "realistic", "animation", "cyber", "stickman", "explainer"]);
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
  assert.ok(errorsOf(bad, { format: "9:16", language: "en" }).some((e) => e.startsWith("kleo_style must be one of ['animation', 'cartoon', 'cyber', 'explainer', 'realistic', 'stickman']")));
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
  assert.ok(errorsOf(cyberPic, { format: "9:16", language: "en" }).some((e) => /the Keou style "picture" is the cartoon\/realistic\/animation look: set kleo_style to one of cartoon, realistic, animation, not "cyber"/.test(e)));
  const noStyle = pirates(); delete noStyle.kleo_style;
  assert.ok(errorsOf(noStyle, { format: "9:16", language: "en" }).some((e) => /the Keou style "picture" is the cartoon\/realistic\/animation look/.test(e)));
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
  const closingVoice = two.scenes.at(-1).voice.split(/\s+/).slice(0, 2).join(" ");
  two.scenes.at(-1).shots.push({ image_prompt: "the same beach a moment later, the chest closed again", at: closingVoice });
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
  assert.ok(errorsOf(motion, { format: "9:16", language: "en" }).some((e) => /^scene 1 shot 1: motion is deprecated/.test(e)));
  assert.deepEqual([...SHOT_MOTION], ["in", "out", "left", "right"]);
  for (const m of SHOT_MOTION) { const ok = pirates(); ok.scenes.at(-1).shots[0].motion = m; assert.equal(validateStoryboard(ok, { format: "9:16", language: "en" }).ok, true, m); }
  const img = pirates(); img.scenes[0].shots[0].image = "img/01-hook-s1.png";
  assert.ok(errorsOf(img, { format: "9:16", language: "en" }).some((e) => /scene 1 shot 1: image is not allowed in a storyboard/.test(e)));
  const notObj = pirates(); notObj.scenes[0].shots[1] = "a picture";
  assert.ok(errorsOf(notObj, { format: "9:16", language: "en" }).includes("scene 1 shot 2: must be an object"));
});

test("a shot carrying a field the engine does not know is refused here, not after the render", () => {
  assert.deepEqual([...SHOT_FIELDS], ["image_prompt", "caption", "hl", "at", "shot_kind", "strength", "dur", "motion"]);
  const one = pirates(); one.scenes[0].shots[0].note = "remember to make her look tired";
  assert.ok(errorsOf(one, { format: "9:16", language: "en" }).includes("scene 1 shot 1: unknown shot fields ['note']"));
  const many = pirates();
  Object.assign(many.scenes[1].shots[2], { seed: 42, duration: 2.5, prompt: "a duplicate of image_prompt" });
  assert.ok(errorsOf(many, { format: "9:16", language: "en" }).includes("scene 2 shot 3: unknown shot fields ['duration', 'prompt', 'seed']"), "sorted, like contract.py");
  // `image` keeps its own message: it is a real engine field, only forbidden in a storyboard.
  const img = pirates(); img.scenes[0].shots[0].image = "img/01-hook-s1.png";
  const errors = errorsOf(img, { format: "9:16", language: "en" });
  assert.ok(errors.some((e) => /scene 1 shot 1: image is not allowed/.test(e)) && !errors.some((e) => /unknown shot fields/.test(e)), errors.join("\n"));
  // The deprecated set of fields still validates together.
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
  // The shorthand becomes shot 1 of the scene, and the scene-level key is gone from what gets stored. The storyboard
  // is refused all the same: one picture held for a whole narrated line is a slideshow, whichever way it was written.
  const sb = pirates();
  delete sb.scenes[1].shots;
  sb.scenes[1].image_prompt = "  The Red Gull racing over turquoise waves under a clear sky  ";
  const lone = validateStoryboard(sb, { format: "9:16", language: "en" });
  assert.equal(lone.ok, false, "one picture for a whole line is refused");
  assert.ok(lone.errors.some((e) => /1 picture, a scene needs at least 2/.test(e)), lone.errors.join("\n"));
  // The validator works on a copy and hands it back, so the normalisation is read from the RESULT and never from
  // the object that was passed in. The closing is the one scene a single picture is enough for, so it is where the shorthand can be read on a
  // storyboard that actually validates. Everywhere else one picture for a whole narrated line is a slideshow and
  // the storyboard is refused, whichever way it was written — which is what the two assertions above check.
  const shorthand = pirates();
  const closing = shorthand.scenes.at(-1);
  delete closing.shots;
  closing.image_prompt = "  A half-buried chest on the sand at dawn, gold spilling out  ";
  const norm = validateStoryboard(shorthand, { format: "9:16", language: "en" });
  assert.equal(norm.ok, true, JSON.stringify(norm.errors));
  const out = norm.storyboard.scenes.at(-1);
  assert.equal(out.image_prompt, undefined, "the scene-level key is gone from what is stored");
  assert.deepEqual(out.shots.map((sh) => sh.image_prompt),
    ["A half-buried chest on the sand at dawn, gold spilling out"], "the shorthand became shot 1, trimmed");
  assert.equal(closing.image_prompt !== undefined, true, "and the caller's own object still has it");

  // The picture ids follow the shot numbers, shorthand or not.
  const ids = pictureScenes(norm.storyboard).map((p) => p.id);
  assert.equal(ids.at(-1), `${out.id}-s1`, "the shorthand picture is shot 1 of its scene");
  assert.ok(ids.includes("02-ship-s1"), ids.join(", "));
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

test("validateStoryboard never writes into what it was given", () => {
  // It normalises as it validates — a scene-level image_prompt becomes shots[0], a missing anchor is chosen — and it
  // used to do that in place, so every caller depended on a side effect. Validating the same object twice then gave
  // two different answers, and a test that passed alone failed beside another one.
  const sb = pirates();
  delete sb.scenes[1].shots;
  sb.scenes[1].image_prompt = "The Red Gull racing over turquoise waves under a clear sky";
  const before = JSON.stringify(sb);
  const r1 = validateStoryboard(sb, { format: "9:16", language: "en" });
  assert.equal(JSON.stringify(sb), before, "the caller's object is exactly as it was");
  assert.ok(!r1.ok, "one picture for a whole line is still refused");
  assert.ok(r1.normalised.scenes[1].shots, "and the normalised copy carries the repair");
  assert.ok(!("image_prompt" in r1.normalised.scenes[1]), "which the caller's object must not have");

  // Twice in a row gives the same answer, which is the property that was actually broken.
  const r2 = validateStoryboard(sb, { format: "9:16", language: "en" });
  assert.deepEqual(r2.errors, r1.errors);

  // On the happy path the returned storyboard is the repaired one, and validating IT again changes nothing.
  const good = pirates();
  const ok1 = validateStoryboard(good, { format: "9:16", language: "en" });
  assert.equal(ok1.ok, true, JSON.stringify(ok1.errors));
  const ok2 = validateStoryboard(ok1.storyboard, { format: "9:16", language: "en" });
  assert.equal(ok2.ok, true);
  assert.deepEqual(ok2.storyboard, ok1.storyboard, "normalising is idempotent");
});

test("pictureScenes flattens scene → shot in order, with `<sceneId>-s<n>` ids", () => {
  const sb = pirates();
  const pics = pictureScenes(sb);
  assert.equal(pics.length, sb.scenes.reduce((n, s) => n + s.shots.length, 0));
  assert.deepEqual(pics.slice(0, 4).map((p) => p.id), ["01-hook-s1", "01-hook-s2", "01-hook-s3", "02-ship-s1"]);
  assert.equal(pics.at(-1).id, "05-closing-s1");
  assert.equal(pics[0].image_prompt, sb.scenes[0].shots[0].image_prompt);
  assert.equal(pics[0].accent, sb.scenes[0].accent, "a picture carries its scene's accent, so the image model can see the colour law");
  assert.deepEqual(pictureScenes(space()).slice(0, 2).map((p) => p.id), ["01-hook-s1", "01-hook-s2"]);
  assert.deepEqual(pictureScenes(cinema()), [], "a legacy cyber storyboard asks for no picture");
  const legacyCyber = cinema(); legacyCyber.scenes.forEach((s) => { s.image_prompt = "a car at night"; });
  assert.deepEqual(pictureScenes(legacyCyber), [], "not even with image prompts on every scene");
  assert.deepEqual(pictureScenes(null), []);
  assert.deepEqual(pictureScenes({ kleo_style: "cartoon", scenes: "nope" }), []);
  const shorthand = { kleo_style: "realistic", scenes: [{ id: "01-a", image_prompt: "a rocket on the pad at dawn" }] };
  assert.deepEqual(pictureScenes(shorthand), [{ id: "01-a-s1", image_prompt: "a rocket on the pad at dawn", accent: null }], "the old shorthand still maps to shot 1");
  const gap = { kleo_style: "cartoon", scenes: [{ id: "01-a", shots: [{ image_prompt: "a beach" }, { caption: "NO PICTURE" }, { image_prompt: "a ship" }] }] };
  assert.deepEqual(pictureScenes(gap).map((p) => p.id), ["01-a-s1", "01-a-s3"], "ids follow the shot number, not the position in the answer");
});

test("MAX_PICTURES: 24 for a Short, 48 for a long video", () => {
  assert.equal(MAX_PICTURES(30), 24);
  assert.equal(MAX_PICTURES(90), 24);
  assert.equal(MAX_PICTURES(91), 48);
  assert.equal(MAX_PICTURES(600), 48);
});

/* ------------------------------------------------------------------ *
 * The shot grammar (src/shot-grammar.ts) and the sequencing rules.    *
 * ------------------------------------------------------------------ */

/** Pictures with nothing in them the routing rule cares about: no hands at work, no crowd, no sign, no mechanism. */
const NEUTRAL = [
  "An empty golden beach at sunset, palm trees and a calm turquoise bay",
  "A wooden chest half buried in dry sand under a big white moon",
  "Dry pale sand with one worn rope end lying across it",
  "A red-sailed ship anchored far out on a calm empty sea at dawn",
  "A black rock cliff above an empty grey sea under low clouds",
  "Wet sand at the waterline, one shell, the tide sliding back",
];
/** A picture storyboard written in the grammar: one list of shot_kinds per scene, the last scene is the closing. */
function grammar(kinds, format = "9:16") {
  let n = 0;
  return {
    schema_version: 1, editorial_status: "ready", title: "The beach nobody came back to", style: "picture", kleo_style: "cartoon",
    format, language: "en", voice: "am_michael", speed: 1.1, music: "bed", max_duration: 75,
    scenes: kinds.map((list, i) => ({
      id: `0${i + 1}-scene`, kind: i === kinds.length - 1 ? "closing" : "cinema",
      title: "the empty beach", voice: "The beach is empty now, and the tide keeps coming back for it.",
      shots: list.map((shot_kind) => ({ shot_kind, image_prompt: NEUTRAL[n++ % NEUTRAL.length] })),
    })),
  };
}
const G = { format: "9:16", language: "en" };
const WIDE = { format: "16:9", language: "en" };
/** A legal run: the class alternates, the scale cuts, screen direction holds, no loud move anywhere. */
const LEGAL = [["establish", "face", "detail"], ["reveal", "detail", "establish"], ["closing"]];
const errsOf = (sb, o = G) => { const r = validateStoryboard(sb, o); return r.ok ? [] : r.errors; };
const has = (errors, re) => errors.some((e) => re.test(e));

test("shot_kind is the story term: ten kinds, one per shot, never camera language", () => {
  assert.deepEqual([...SHOT_KINDS].sort(), ["action", "closing", "detail", "detail_orbit", "establish", "face", "hook", "reveal", "static_forced", "tension"]);
  assert.deepEqual(errsOf(grammar(LEGAL)), [], "a storyboard that respects the grammar validates");
  // Every kind is a value the validator knows (its neighbours may still break a sequencing rule, which is not this test).
  for (const k of SHOT_KINDS) {
    const errors = errsOf(grammar([["static_forced"], [k], ["closing"]]));
    assert.ok(!has(errors, /shot_kind must be one of/), `${k} should be a known kind: ${errors.join("\n")}`);
  }
  const unknown = grammar(LEGAL); unknown.scenes[0].shots[1].shot_kind = "dolly_zoom";
  assert.ok(has(errsOf(unknown), /^scene 1 shot 2: shot_kind must be one of \['action', 'closing', 'detail'/), "the message lists the kinds");
  const list = grammar(LEGAL); list.scenes[0].shots[1].shot_kind = ["face", "detail"];
  assert.ok(errsOf(list).includes("scene 1 shot 2: one move per shot — shot_kind names a single kind, never a list of them"));
  const motionList = pirates(); motionList.scenes[0].shots[0].motion = ["in", "left"];
  assert.ok(has(errsOf(motionList), /^scene 1 shot 1: one move per shot — motion names a single move, never a list of them/));
  // The camera never reaches the storyboard: a shot names a kind, and the preset table names the move.
  for (const kind of SHOT_KINDS) assert.equal(typeof SHOT_GRAMMAR[kind].move, "string");
});

test("strength is optional and lives between 0 and 1 — 0 is the locked frame", () => {
  for (const s of [0, 0.1, 0.25, 0.6, 1]) {
    const ok = grammar(LEGAL); ok.scenes[0].shots[1].strength = s;
    assert.deepEqual(errsOf(ok), [], `strength ${s} should be accepted`);
  }
  for (const bad of [-0.2, 1.4, "hard", null]) {
    const sb = grammar(LEGAL); sb.scenes[0].shots[1].strength = bad;
    assert.ok(errsOf(sb).includes("scene 1 shot 2 strength: expected a number between 0 and 1"), `strength ${bad} should be refused`);
  }
  // A static_forced shot resolves to strength 0, and the storyboard it produces has to validate again unchanged.
  const held = grammar(LEGAL); held.scenes[0].shots[1] = { shot_kind: "static_forced", image_prompt: "an empty room at dawn" };
  const r = validateStoryboard(held, { format: "9:16", language: "en" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.storyboard.scenes[0].shots[1].strength, 0, "a locked frame resolves to strength 0");
  // And the storyboard that comes out has to validate again unchanged: the resolution must be a fixed point.
  assert.deepEqual(errsOf(r.storyboard), [], "and again on a second pass");
});

test("dur must fall inside the kind's window, after the format factor", () => {
  const RE = /^scene 1 shot 2 dur: a (\w+) shot runs ([\d.]+)–([\d.]+) s in (\S+);/;
  const window = (sb, o) => {
    const errors = errsOf(sb, o);
    const line = errors.find((e) => RE.test(e));
    assert.ok(line, `expected a dur window message, got ${errors.join("\n") || "no error"}`);
    const [, kind, lo, hi, fmt] = line.match(RE);
    return { kind, lo: Number(lo), hi: Number(hi), fmt };
  };
  // face is 2.5–3.5 s; a 9:16 Short multiplies by 0.7, so 3 s is outside a window that stops at 2.45.
  const over = grammar(LEGAL); over.scenes[0].shots[1].dur = 3;
  const face = window(over, G);
  assert.equal(face.kind, "face");
  assert.equal(face.fmt, "9:16");
  assert.ok(Math.abs(face.lo - 2.5 * 0.7) < 0.01 && Math.abs(face.hi - 3.5 * 0.7) < 0.01, `9:16 face window ${face.lo}–${face.hi} should be the 2.5–3.5 s window times 0.7`);
  assert.deepEqual(durationFor("face", "9:16"), { min: face.lo, max: face.hi }, "the message quotes the table, it does not compute its own");
  const ok = grammar(LEGAL); ok.scenes[0].shots[1].dur = 2;
  assert.deepEqual(errsOf(ok), [], "2 s is inside the shortened face window");
  // establish is 3.5–4.5 s: times 0.7 that is 2.45–3.15, and 9:16 caps every shot at 3 s.
  const est = [["face", "establish", "detail"], ["closing"]];
  const capped = grammar(est); capped.scenes[0].shots[1].dur = 3.1;
  const wide = window(capped, G);
  assert.equal(wide.kind, "establish");
  assert.equal(wide.hi, 3, "the 9:16 cap is 3 s, not 3.15");
  const at3 = grammar(est); at3.scenes[0].shots[1].dur = 3;
  assert.deepEqual(errsOf(at3), [], "3 s is the longest a 9:16 shot runs");
  // 16:9 keeps the table as written: the factor is a Shorts rule.
  const long = grammar(est, "16:9"); long.scenes[0].shots[1].dur = 4;
  assert.deepEqual(errsOf(long, WIDE), [], "4 s is inside the 16:9 establish window");
  const short = grammar(est, "16:9"); short.scenes[0].shots[1].dur = 2;
  assert.deepEqual(window(short, WIDE), { kind: "establish", lo: 3.5, hi: 4.5, fmt: "16:9" });
  const orphan = pirates(); orphan.scenes[0].shots[0].dur = 2;
  assert.ok(errsOf(orphan).includes("scene 1 shot 1: dur needs shot_kind — the kind is what says how long the shot may run"));
  const forever = grammar(LEGAL); forever.scenes[0].shots[1].dur = 6;
  assert.deepEqual(errsOf(forever), [`scene 1 shot 2: duration 6s is over the ${MAX_SHOT_S}s maximum — shorten dur, or cut the shot in two`], "the ceiling answers instead of the window");
});

test("a picture with a person in it holds four seconds at most", () => {
  const person = "A woman standing alone on the empty beach at dusk, her face turned to the sea";
  const est = [["face", "establish", "detail"], ["closing"]];
  const sb = grammar(est, "16:9");
  sb.scenes[0].shots[1].dur = 4.4;
  sb.scenes[0].shots[1].image_prompt = person;
  assert.deepEqual(errsOf(sb, WIDE), [`scene 1 shot 2: duration 4.4s is over the ${MAX_PERSON_SHOT_S}s maximum for a shot with a person in it — shorten dur, or cut the shot in two`]);
  const empty = grammar(est, "16:9"); empty.scenes[0].shots[1].dur = 4.4;
  assert.deepEqual(errsOf(empty, WIDE), [], "a landscape may hold longer than a face");
  const shorter = grammar(est, "16:9");
  shorter.scenes[0].shots[1].dur = 3.8;
  shorter.scenes[0].shots[1].image_prompt = person;
  assert.deepEqual(errsOf(shorter, WIDE), []);
});

test("static_forced is routing, not taste: hands, a crowd, signage or a mechanism", () => {
  const breaks = [
    ["Two hands tying a knot in a thick rope, close up on the fingers", "hands doing something"],
    ["A crowd of forty pirates packed on the deck, all shouting at once", "a crowd, or two people interacting"],
    ["A painted signpost at the head of the empty beach, its lettering still readable", "signage the viewer can read"],
    ["The ship's windlass, all its gears and moving parts caught mid-turn", "a mechanism with moving parts"],
  ];
  for (const [image_prompt, why] of breaks) {
    const moving = grammar(LEGAL); moving.scenes[0].shots[1].image_prompt = image_prompt;
    // Repaired, not refused: hands at work get a locked frame and the author is never sent back to rewrite the
    // shot. `why` still names the category the router matched.
    void why;
    // The repair is read from the storyboard the validator HANDS BACK: it works on a copy, so the caller's own
    // object is never rewritten under it.
    const rep = validateStoryboard(moving, { format: "9:16", language: "en" });
    assert.equal(rep.ok, true, image_prompt);
    assert.equal(rep.storyboard.scenes[0].shots[1].shot_kind, "static_forced", "the router locked the frame");
    assert.equal(rep.storyboard.scenes[0].shots[1].motion, "static_hold", "and the resolved move followed it");
    assert.notEqual(moving.scenes[0].shots[1].shot_kind, "static_forced", "and the caller's object was left alone");
    const held = grammar(LEGAL); held.scenes[0].shots[1] = { shot_kind: "static_forced", image_prompt };
    assert.deepEqual(errsOf(held), [], "static_forced is the answer, so it is never asked for again");
  }
  assert.deepEqual(errsOf(grammar(LEGAL)), [], "an empty beach is routed nowhere");
});

test("sequencing: the move class alternates, across the cut too", () => {
  const same = grammar([["establish", "face", "reveal"], ["detail"], ["closing"]]);
  assert.deepEqual(errsOf(same), ["scene 1 shot 3: move class PUSH repeats scene 1 shot 2 ('push_in' then 'pull_out') — change one of the two shot_kinds so the class alternates (PUSH / LATERAL / VERTICAL / STILL)"]);
  const across = grammar([["establish", "face", "detail"], ["action", "face", "establish"], ["closing"]]);
  assert.deepEqual(errsOf(across), ["scene 2 shot 1: move class LATERAL repeats scene 1 shot 3 ('track_right' then 'track_alongside') — change one of the two shot_kinds so the class alternates (PUSH / LATERAL / VERTICAL / STILL)"], "a scene cut does not reset the rule");
});

test("sequencing: two shots in a row never sit at the same scale on the same subject", () => {
  const twice = grammar([["establish", "face", "detail_orbit"], ["closing"]]);
  assert.deepEqual(errsOf(twice), ["scene 1 shot 3: scale 'close' repeats scene 1 shot 2 on the same subject '01-scene' — change shot_kind so the cut changes the scale"]);
  // Across a scene cut the subject changes, and the same scale is allowed there.
  const cut = grammar([["establish", "detail", "face"], ["detail_orbit", "establish"], ["closing"]]);
  assert.deepEqual(errsOf(cut), [], "the rule is about one subject, not about the whole video");
});

test("sequencing: at most two loud moves per 40 s, and never two in a row", () => {
  const pair = grammar([["tension", "detail_orbit", "establish"], ["closing"]]);
  assert.deepEqual(errsOf(pair), ["scene 1 shot 2: loud move 'orbit_left' is adjacent to the loud move at scene 1 shot 1 — put a quiet shot between them"]);
  const three = grammar([["hook", "establish", "tension", "establish"], ["detail_orbit", "establish"], ["closing"]]);
  assert.deepEqual(errsOf(three), [`scene 2 shot 1: more than ${LOUD_MAX_PER_WINDOW} loud moves within ${LOUD_WINDOW_S}s (scene 1 shot 1, scene 1 shot 3, scene 2 shot 1) — keep ${LOUD_MAX_PER_WINDOW} loud moves per ${LOUD_WINDOW_S} s and let the rest be quiet`]);
  const two = grammar([["hook", "establish", "tension", "establish"], ["face", "detail"], ["closing"]]);
  assert.deepEqual(errsOf(two), [], "two loud moves are the budget, not the limit");
});

test("sequencing: screen direction stays the same inside a scene", () => {
  const flip = grammar([["detail", "establish", "detail_orbit"], ["closing"]]);
  assert.deepEqual(errsOf(flip), ["scene 1 shot 3: screen direction flips inside scene '01-scene' (right at scene 1 shot 1, left here) — keep one direction inside a scene: flip the shot, not the camera"]);
  const own = grammar([["detail", "establish", "face"], ["detail_orbit", "establish"], ["closing"]]);
  assert.deepEqual(errsOf(own), [], "each scene keeps its own direction");
});

test("motion is the deprecated alias: accepted silently, normalised away, and it says so", () => {
  assert.deepEqual(MOTION_ALIASES, { in: "push_in", out: "pull_out", left: "track_left", right: "track_right" });
  assert.deepEqual([...MOTION_MOVES], ["push_in", "pull_out", "track_left", "track_right"]);
  const r = validateStoryboard(pirates(), G);
  assert.deepEqual(r.ok ? [] : r.errors, [], "a storyboard written before the grammar still renders");
  assert.deepEqual(r.storyboard.scenes[0].shots.map((s) => s.motion), ["push_in", "track_left", "pull_out"], "the old names never reach the engine");
  assert.equal(r.storyboard.scenes[1].shots[1].motion, "track_right");
  // Normalising is idempotent: what the server stores validates again, unchanged.
  const again = validateStoryboard(structuredClone(r.storyboard), G);
  assert.deepEqual(again.ok ? [] : again.errors, []);
  assert.deepEqual(again.storyboard, r.storyboard);
  const bad = pirates(); bad.scenes[0].shots[0].motion = "zoom";
  const errors = errsOf(bad);
  assert.ok(has(errors, /^scene 1 shot 1: motion is deprecated: it names the camera move by hand/), errors.join("\n"));
  assert.ok(has(errors, /normalise to push_in, pull_out, track_left, track_right/), "the message names the mapping");
  assert.ok(has(errors, /Say what the shot is FOR with shot_kind — one of \['action', 'closing', 'detail'/), "and what to write instead");
  const both = grammar(LEGAL); both.scenes[0].shots[1].motion = "in";
  assert.ok(has(errsOf(both), /^scene 1 shot 2: a shot names its move once — shot_kind face already asks for push_in, so drop motion \(motion is deprecated/), errsOf(both).join("\n"));
});

test("a storyboard that is legal today stays legal", () => {
  for (const [name, sb] of [["cartoon-pirates", pirates()], ["realistic-space", space()], ["cinema", cinema()], ["editorial", editorial()]])
    assert.deepEqual(errsOf(sb), [], `${name} should still validate`);
  // The grammar judges the shots that speak it: a legacy run of push_in after push_in is never read as a sequence.
  const pushy = pirates();
  for (const s of pushy.scenes) for (const sh of s.shots) sh.motion = "in";
  assert.deepEqual(errsOf(pushy), [], "the sequencing rules do not fire on shots without shot_kind");
  const bare = pirates();
  for (const s of bare.scenes) for (const sh of s.shots) delete sh.motion;
  assert.deepEqual(errsOf(bare), [], "a shot may still carry nothing but a picture");
  // A legacy shot is a gap in the run, not a licence: the grammar shots on either side are still judged on their own.
  const mixed = grammar([["establish", "face", "detail"], ["reveal", "detail", "establish"], ["closing"]]);
  delete mixed.scenes[0].shots[1].shot_kind;
  mixed.scenes[0].shots[1].motion = "in";
  assert.deepEqual(errsOf(mixed), []);
});

/**
 * The guide the calling model reads before it writes a storyboard, so every claim it makes has to be one this
 * validator agrees with: a drifted guide costs a whole rejected job. It used to be a template literal inside
 * src/mcp.ts and these tests scraped it with regular expressions; it is now built by src/guide.ts from the
 * contract's own constants, so the tests call the builder and read what a caller actually receives.
 */
const MCP_SRC = readFileSync(join(ROOT, "src", "mcp.ts"), "utf8");
const guideFor = (style) => guideText({ duration_s: 45, style, languages: ["en", "it"] });
/** The rules half, without the worked example, for the checks that are about what the guide CLAIMS. */
const rulesFor = (style) => buildGuide({ duration_s: 45, style, languages: ["en", "it"] });

test("the storyboard guide's examples validate against this contract", () => {
  // The example is exported as data, so it goes through the real validator instead of through a regular expression.
  const direction = structuredClone(EXAMPLE_DIRECTION);
  const scenes = structuredClone(EXAMPLE_SCENES);
  scenes.push({ id: "zz-end", kind: "closing", chapter: "99 END", accent: "green", title: "what happened to it",
    hl: "happened", voice: "Nobody has found the chest on Skull Beach since. Would you go and look?",
    shots: [{ image_prompt: "An empty beach at noon, the tide coming in over old footprints" }], button: "Follow" });
  direction.sections.push({ name: "03 THE QUESTION", accent: "green", means: "what you are left with", scenes: 1 });
  const sb = { schema_version: 1, editorial_status: "ready", title: "The treasure nobody came back for",
    kleo_style: "cartoon", style: "picture", format: "9:16", language: "en", voice: "am_michael",
    speed: 1.1, music: "bed", max_duration: 72, direction, scenes };

  assert.deepEqual(directionProblems(direction, { accents: CINEMA_ACCENTS, scenes: scenes.length }), [], "the example's direction is legal");
  const r = validateStoryboard(sb, { format: "9:16", language: "en" });
  assert.deepEqual(r.ok ? [] : r.errors, [], "the guide's own example must validate");
  assert.ok(pictureScenes(sb).length >= sb.scenes.length, "every scene of the example carries at least one shot");
  // And the text a caller receives really contains it, so the guide cannot drift from the data it claims to show.
  for (const style of ["cartoon", "realistic", "animation"]) {
    const text = guideFor(style);
    assert.ok(text.includes(EXAMPLE_DIRECTION.world), `${style}: the example's world is in the guide`);
    assert.ok(text.includes(EXAMPLE_SCENES[0].shots[0].image_prompt), `${style}: the example's first picture is in the guide`);
  }
});

test("the guide only offers languages and voices kleo_create_video accepts", () => {
  const jobLangs = ["en", "it"];
  assert.match(MCP_SRC, /const JOB_LANGUAGES = \["en", "it"\] as const;/, "the job languages are declared once");
  assert.match(MCP_SRC, /z\.enum\(JOB_LANGUAGES\)/, "the tool schema and the guide read the same list");
  for (const style of [null, "cartoon", "realistic", "animation", "cyber", "stickman", "explainer"]) {
    const guide = guideFor(style);
    for (const lang of Object.keys(VOICES).filter((l) => !jobLangs.includes(l)))
      for (const v of VOICES[lang]) assert.ok(!guide.includes(v), `${style}: the guide must not offer ${v} (${lang} is not a job language)`);
    assert.ok(!/"fr"/.test(guide), `${style}: fr is not a language a job can have`);
    assert.match(guide, /must equal what you pass to kleo_create_video/);
  }
});

test("the guide never suggests a field the validator forbids on a scene", () => {
  for (const style of [null, "cartoon", "cyber", "stickman", "explainer"]) {
    const guide = rulesFor(style);
    // "motion" is legal on a SHOT and forbidden on a scene: check the guide with the shot line taken out.
    const sceneLines = guide.split("\n").filter((l) => !l.trimStart().startsWith("SHOT:")).join("\n");
    for (const f of FORBIDDEN_SCENE_FIELDS)
      assert.ok(!new RegExp(`"${f}":`).test(sceneLines), `${style}: ${f} must not be offered as a scene field`);
  }
});

test("every shot count the caller is told comes from the contract, and they all agree", () => {
  assert.deepEqual(SHOTS_PER_SCENE.cinema, [1, 4], "the contract's floor stays 1: worker/keou/contract.py has the same one");
  assert.deepEqual(SHOTS_PER_SCENE.closing, [1, 2]);
  assert.equal(SHOTS_MIN_CINEMA, 2, "but a NEW storyboard is held to two pictures a scene");
  assert.equal(shotRangeText("cinema"), "2-4");
  assert.equal(shotRangeText("closing"), "1-2");
  // The guide, the tool instructions and the planner rules must all quote that one range and never a literal.
  const texts = [["guide", rulesFor("cartoon")], ["instructions", MCP_SRC.slice(MCP_SRC.indexOf("const INSTRUCTIONS"), MCP_SRC.indexOf("const ok ="))]];
  for (const [what, text] of texts) {
    assert.ok(!/1 ?- ?4 (?:pictures|shots)/.test(text), `${what}: the old 1-4 range is still written down`);
    assert.ok(!/exactly 1 shot|has exactly one shot/.test(text), `${what}: the closing takes 1-2 shots, not exactly 1`);
  }
  assert.match(rulesFor("cartoon"), /EVERY SCENE SHOWS AT LEAST 2 PICTURES/);
  assert.match(MCP_SRC, /const shotRange = shotRangeText;/, "the tool instructions read the contract, not a copy of it");
});