/**
 * The dissolves between acts (src/transitions.ts, 22 September 2026): where they may sit, how many a film gets, that
 * the engine, the footage builder and the server agree on their length, and that both contracts accept the mark.
 * Run: node --test test/transitions.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { placeTransitions, actBoundaries, dissolveBudget, transitionOf, DISSOLVE_S, PER_SECONDS, TRANSITIONS } from "../src/transitions.ts";
import { finishForProduct } from "../src/templates.ts";
import { validateStoryboard } from "../src/keou-contract.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A picture storyboard of `n` scenes over `acts` chapters, every scene one sentence of `words` words. */
function scenes(n, acts, words = 12) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`, kind: "cinema", chapter: `0${Math.floor((i * acts) / n) + 1} ACT`, accent: "cyan", title: `t${i}`, hl: "t",
    voice: Array.from({ length: words }, (_, k) => `w${k}`).join(" "),
    // Two pictures a scene, the second cut on a word: the contract refuses a one-picture scene as a slideshow.
    shots: [{ image_prompt: `picture ${i} opens` }, { image_prompt: `picture ${i} closes`, at: "w2" }],
  }));
}

test("the constants: 0.8 s, one per 25 s, two words — and the engine and the footage builder carry the same number", () => {
  assert.equal(DISSOLVE_S, 0.8); assert.equal(PER_SECONDS, 25); assert.deepEqual([...TRANSITIONS], ["cut", "dissolve"]);
  const picture = readFileSync(join(ROOT, "worker", "keou", "engine", "picture.js"), "utf8");
  const m = /const DISSOLVE = (\.\d+|\d+(?:\.\d+)?);/.exec(picture);
  assert.ok(m, "picture.js declares DISSOLVE in its pure block");
  assert.equal(Number(m[1]), DISSOLVE_S, "the animatic dissolves for exactly the server's DISSOLVE_S");
  assert.ok(picture.indexOf("const DISSOLVE") < picture.indexOf("/* @end picture-plan */"), "DISSOLVE lives in the pure block render.mjs evaluates for shots.json");
  const video = readFileSync(join(ROOT, "worker", "kleo_video.py"), "utf8");
  assert.match(video, /plan\.get\("dissolve_s"\) or 0\.8/, "build_footage reads the plan's dissolve_s and falls back to the same number");
  assert.match(readFileSync(join(ROOT, "worker", "keou", "engine", "render.mjs"), "utf8"), /dissolve_s:plan\.DISSOLVE/, "render.mjs writes it into shots.json");
  assert.match(readFileSync(join(ROOT, "worker", "keou", "contract.py"), "utf8"), /transition must be cut or dissolve/, "contract.py accepts the mark");
});

test("a dissolve sits only where an act begins, never on the first scene, and never more than one per 25 seconds", () => {
  const sb = { scenes: scenes(6, 3) };
  assert.deepEqual(actBoundaries(sb.scenes), [2, 4]);
  assert.equal(dissolveBudget(30), 1); assert.equal(dissolveBudget(45), 2); assert.equal(dissolveBudget(60), 2); assert.equal(dissolveBudget(120), 5); assert.equal(dissolveBudget(300), 12);
  assert.deepEqual(placeTransitions(sb, 30), [2], "a 30-second film dissolves once, at the act change nearest its middle");
  assert.equal(transitionOf(sb.scenes[2]), "dissolve"); assert.equal(transitionOf(sb.scenes[4]), "cut"); assert.equal(transitionOf(sb.scenes[0]), "cut");
  assert.deepEqual(placeTransitions(sb, 60), [2, 4], "a minute has two, and this film has exactly two act changes");
  assert.deepEqual(placeTransitions(sb, 300), [2, 4], "never more than the act changes the film has");
  assert.deepEqual(placeTransitions({ scenes: scenes(4, 1) }, 60), [], "one act: nothing to dissolve between");
  assert.deepEqual(placeTransitions({ scenes: [] }, 60), []);
  // Idempotent: finished twice, the same marks.
  placeTransitions(sb, 30); assert.deepEqual(sb.scenes.map(transitionOf), ["cut", "cut", "dissolve", "cut", "cut", "cut"]);
  // Spread over the film's LENGTH, not over the scene count: with a long last act the middle of the words falls
  // nearer the second act change (counted by scene index the two changes would tie and the first would win).
  const uneven = { scenes: [...scenes(2, 1, 4), ...scenes(2, 1, 4).map((s, i) => ({ ...s, id: `m${i}`, chapter: "02 ACT" })), ...scenes(2, 1, 40).map((s, i) => ({ ...s, id: `e${i}`, chapter: "03 ACT" }))] };
  assert.deepEqual(placeTransitions(uneven, 30), [4], "the boundary nearest the middle of the WORDS, which is the film's clock here");
});

test("finishForProduct places them for both products when it knows the length, and the contract accepts the mark", () => {
  const film = finishForProduct({ music: "bed", scenes: scenes(6, 3) }, "film", 60);
  assert.deepEqual(film.scenes.map(transitionOf), ["cut", "cut", "dissolve", "cut", "dissolve", "cut"]);
  const anim = finishForProduct({ music: "bed", scenes: scenes(6, 3) }, "animatic", 30);
  assert.deepEqual(anim.scenes.map(transitionOf), ["cut", "cut", "dissolve", "cut", "cut", "cut"]);
  assert.equal(anim.music, "none", "an animatic still takes no bed");
  assert.equal(finishForProduct({ music: "track", music_brief: "cello" }, "animatic").music, "track", "the user's track stays on an animatic");
  assert.deepEqual(finishForProduct({ music: "bed", scenes: scenes(4, 2) }, "film").scenes.map(transitionOf), ["cut", "cut", "cut", "cut"], "no length known: nothing placed");
  const sb = {
    schema_version: 1, editorial_status: "ready", title: "t", style: "picture", kleo_style: "realistic", format: "16:9", language: "en", voice: "am_michael", speed: 1.1, music: "track", music_brief: "sparse felt piano", max_duration: 96,
    scenes: [...scenes(3, 1), { id: "end", kind: "closing", chapter: "02 END", accent: "green", title: "end", hl: "end", voice: "the end of it all", shots: [{ image_prompt: "an empty desk" }, { image_prompt: "the desk lamp off", at: "all" }] }],
  };
  placeTransitions(sb, 30);
  assert.equal(transitionOf(sb.scenes[3]), "dissolve", "the ending is an act too, and the most cinematic place for the one dissolve");
  const ok = validateStoryboard(structuredClone(sb), { format: "16:9", language: "en" });
  assert.ok(ok.ok, ok.ok ? "" : ok.errors.join("; "));
  assert.equal(ok.storyboard.scenes[3].transition, "dissolve", "the mark survives validation");
  assert.equal(ok.storyboard.music, "track"); assert.equal(ok.storyboard.music_brief, "sparse felt piano");
  const bad = validateStoryboard({ ...structuredClone(sb), scenes: sb.scenes.map((s, i) => ({ ...s, transition: i === 0 ? "dissolve" : i === 1 ? "wipe" : undefined })) }, { format: "16:9", language: "en" });
  assert.ok(!bad.ok);
  assert.ok(bad.errors.some((e) => /scene 1: the first scene cannot dissolve in/.test(e)), bad.errors.join("; "));
  assert.ok(bad.errors.some((e) => /scene 2: transition must be "cut" or "dissolve"/.test(e)), bad.errors.join("; "));
  const loud = validateStoryboard({ ...structuredClone(sb), music: "loud" }, { format: "16:9", language: "en" });
  assert.ok(loud.errors.includes("music must be bed, none or track"));
});
