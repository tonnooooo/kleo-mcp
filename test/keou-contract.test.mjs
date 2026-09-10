/**
 * Unit tests for src/keou-contract.ts (the TypeScript mirror of worker/keou/contract.py).
 * Run: node --test test/keou-contract.test.mjs   (Node ≥ 22.18 strips the types natively)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStoryboard, defaultVoice, wordBudget, kleoStyleOf, pictureScenes, VOICES, FORBIDDEN_FIELDS, FORBIDDEN_KINDS, KLEO_STYLES, IMAGE_PROMPT_MAX } from "../src/keou-contract.ts";

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

test("every example project validates once turned into a storyboard", () => {
  const names = readdirSync(EXAMPLES).filter((n) => !n.startsWith("."));
  assert.ok(names.length >= 4, `expected the Keou examples, found ${names.length}`);
  for (const name of names) {
    const p = load(name);
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

/* ------------------------------------------------------------------ Kleo styles and pictures */

test("kleo_style: enum, default cyber, cartoon/realistic need cinema, stickman needs stickman", () => {
  assert.deepEqual([...KLEO_STYLES], ["cartoon", "realistic", "cyber", "stickman"]);
  const plain = cinema();
  assert.equal(validateStoryboard(plain, { format: "9:16", language: "en" }).ok, true);
  assert.equal(kleoStyleOf(plain), "cyber");
  for (const style of ["cartoon", "realistic", "cyber"]) {
    const sb = cinema(); sb.kleo_style = style;
    assert.equal(validateStoryboard(sb, { format: "9:16", language: "en" }).ok, true, `${style} on a cinema Short`);
    assert.equal(kleoStyleOf(sb), style);
  }
  const bad = cinema(); bad.kleo_style = "anime";
  assert.ok(errorsOf(bad, { format: "9:16", language: "en" }).some((e) => e.startsWith("kleo_style must be one of ['cartoon', 'cyber', 'realistic', 'stickman']")));
  const ed = editorial(); ed.kleo_style = "cartoon";
  assert.ok(errorsOf(ed, { format: "9:16", language: "en" }).some((e) => /kleo_style cartoon needs the Keou style "cinema"/.test(e)));
  const ed2 = editorial(); ed2.kleo_style = "cyber";
  assert.equal(validateStoryboard(ed2, { format: "9:16", language: "en" }).ok, true, "cyber keeps the editorial look");
  const wrong = cinema(); wrong.kleo_style = "stickman";
  assert.ok(errorsOf(wrong, { format: "9:16", language: "en" }).some((e) => /kleo_style stickman needs the Keou style "stickman"/.test(e)));
});

test("cartoon and realistic are accepted in 16:9 (beta); stickman in 16:9 is refused with a clear message", () => {
  const wide = cinema(); wide.format = "16:9"; wide.kleo_style = "realistic"; delete wide.width;
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

test("image_prompt: any kind, ≤ 240 chars, listed only for the picture styles; scene.image stays forbidden", () => {
  const sb = cinema(); sb.kleo_style = "cartoon";
  sb.scenes.forEach((s, i) => { s.image_prompt = `Picture ${i + 1}: a pirate ship at anchor in a sandy bay`; });
  assert.equal(validateStoryboard(sb, { format: "9:16", language: "en" }).ok, true);
  assert.equal(pictureScenes(sb).length, sb.scenes.length);
  assert.deepEqual(pictureScenes(sb)[0], { id: sb.scenes[0].id, image_prompt: "Picture 1: a pirate ship at anchor in a sandy bay" });
  const cyber = cinema(); cyber.scenes[0].image_prompt = "ignored in the cyber look";
  assert.equal(validateStoryboard(cyber, { format: "9:16", language: "en" }).ok, true);
  assert.deepEqual(pictureScenes(cyber), [], "no pictures without a picture style");
  const ed = editorial(); ed.scenes[1].image_prompt = "a black hole seen from a distant moon";
  assert.equal(validateStoryboard(ed, { format: "9:16", language: "en" }).ok, true, "image_prompt is allowed on editorial kinds too");
  const long = cinema(); long.kleo_style = "realistic"; long.scenes[0].image_prompt = "x".repeat(IMAGE_PROMPT_MAX + 1);
  assert.ok(errorsOf(long, { format: "9:16", language: "en" }).includes(`scene 1 image_prompt: required text, maximum ${IMAGE_PROMPT_MAX} characters`));
  const empty = cinema(); empty.kleo_style = "realistic"; empty.scenes[0].image_prompt = "   ";
  assert.ok(errorsOf(empty, { format: "9:16", language: "en" }).some((e) => e.startsWith("scene 1 image_prompt: required text")));
  const withImage = cinema(); withImage.kleo_style = "cartoon"; withImage.scenes[0].image = "img/01-gone.png";
  const errors = errorsOf(withImage, { format: "9:16", language: "en" });
  assert.ok(errors.some((e) => /scene 1: image is not allowed in a storyboard \(describe the picture in image_prompt instead/.test(e)), errors.join("\n"));
  const pirates = load("cartoon-pirates");
  assert.ok(pirates.scenes.some((s) => typeof s.image === "string"), "the cartoon example carries worker-attached pictures");
  assert.equal(validateStoryboard(pirates, opts(pirates)).ok, false, "raw example with scene.image is not a client storyboard");
  assert.equal(validateStoryboard(toStoryboard(pirates), opts(pirates)).ok, true);
});
