/**
 * The narration fills the film (25 September 2026). Live film gt_t2cxm2md, 15 s on the API road (clip floor 4 s,
 * Seedance 2.5 on ePhone), was planned at 27 words in three lines of 7, 13 and 7: the box could fit only the middle
 * line to whole clips, the film ran 11.2 s and bought 12 s of clips. These tests hold the numbers, the word plan, the
 * feedback the planner sends back and the last resort that joins a line too short for its clip.
 * Run: node --test test/narration-length.test.mjs   (never calls a model)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILM_WPS, KOKORO_WPS, spokenSeconds, wordBudget, speedFor, clipWordsPerShot, mergeThinScenes, trimShots, validateStoryboard, CINEMA_ACCENTS, directionProblems,
} from "../src/keou-contract.ts";
import { spreadWords, lengthShortfalls, planFor } from "../src/storyboard.ts";
import { treatmentBlock, treatmentPrompt, repairTreatment, variationFor, MASTER_PROMPT } from "../src/treatment.ts";
import { guideText } from "../src/guide.ts";
import { TREATMENT_FIXTURE } from "./fixtures/treatment.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The three lines of gt_t2cxm2md, word for word. */
const LIVE = ["Pirates know the price before the treasure.", "She gives the map, the squall takes two fingers, and the boy runs.", "The map is gone. The price remains."];
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
/** worker/kleo_worker.py: FIT_MAX_PAD (1 s) and the pause a 16:9 line keeps after it (hold_floor, 0.3 s; 0.15 on 9:16). */
const FIT_MAX_PAD = 1.0, HOLD_16x9 = 0.3;

test("the two speech rates: 2.45 words a second of film, 3.3 of Kokoro speech, and they agree on the clip floor", () => {
  assert.equal(FILM_WPS, 2.45); assert.equal(KOKORO_WPS, 3.3);
  // Measured on the live voices at speed 1.0: 27 words in 8.19 s (2.19 + 3.71 + 2.29).
  assert.ok(Math.abs(27 / (2.19 + 3.71 + 2.29) - KOKORO_WPS) < 0.05);
  assert.ok(Math.abs(spokenSeconds(7) - 2.19) < 0.3 && Math.abs(spokenSeconds(7) - 2.29) < 0.3 && Math.abs(spokenSeconds(13) - 3.71) < 0.3);
  // The budget the planner writes to: 40 words for 15 s, 81 for 30 s, 162 for 60 s (2.7 a second at speed 1.1), and
  // the floor under which a film runs short: 32, 65, 130.
  assert.deepEqual([15, 30, 60].map((d) => wordBudget(d).target), [40, 81, 162]);
  assert.deepEqual([15, 30, 60].map((d) => wordBudget(d).min), [32, 65, 130]);
  // A 4-second clip carries eleven words: at the planner's speed they are 3.03 s of speech, and with the line's pause
  // the scene is inside the box's 1-second pad limit; the live seven-word lines were not.
  assert.equal(clipWordsPerShot(4), 11);
  assert.ok(spokenSeconds(11, 1.1) + HOLD_16x9 >= 4 - FIT_MAX_PAD, "eleven words fill a 4 s clip");
  assert.ok(spokenSeconds(7, 1.1) + HOLD_16x9 < 4 - FIT_MAX_PAD, "seven words leave more than a second of dead air");
  assert.ok(spokenSeconds(7, speedFor(27, 15)) + HOLD_16x9 < 4 - FIT_MAX_PAD, "and so did the live film, said at speed 1.0");
  // A 15 s film of eleven-word lines is three clips: 33 words at the least, inside the 40 of its budget.
  assert.ok(3 * clipWordsPerShot(4) <= wordBudget(15).target);
});

test("spreadWords: every scene gets one clip's worth of words, the total stays the budget", () => {
  assert.deepEqual(spreadWords([7, 13, 7], 40, 11), [11, 18, 11], "the live film's shape, planned at its budget");
  assert.deepEqual(spreadWords([5, 30, 5], 40, 11), [11, 18, 11], "a five-word hook becomes a line");
  assert.deepEqual(spreadWords([20, 20, 20], 40, 11), [13, 13, 13]);
  assert.deepEqual(spreadWords([20, 20, 20, 20], 40, 11), [11, 11, 11, 11], "when the floor alone is more than the budget, the floor wins");
  // No floor: exactly the old scaling.
  assert.deepEqual(spreadWords([5, 30, 5], 40, 0), [5, 30, 5]);
  assert.deepEqual(spreadWords([10, 20], 60, 0), [20, 40]);
  for (const w of [[3, 3, 40, 3], [1, 1, 1], [50, 2, 2, 2, 2]]) {
    const out = spreadWords(w, 81, 11);
    assert.ok(out.every((x) => x >= 11), `${w}: ${out}`);
    assert.ok(Math.abs(out.reduce((a, b) => a + b, 0) - Math.max(81, w.length * 11)) <= w.length, `${w}: ${out} sums near the budget`);
  }
});

test("lengthShortfalls: the planner is told, line by line, how many words are missing", () => {
  const scenes = LIVE.map((voice) => ({ voice }));
  const plan = { clipFloor: 4, duration: 15 };
  const p = lengthShortfalls(scenes, [11, 18, 11], plan);
  assert.equal(p.length, 3, JSON.stringify(p));
  assert.match(p[0], /^scene 1: its voice has 7 words, 4 short of the 11 that fill one paid 4-second clip — add 4 or more \(about 11 in all\)/);
  assert.match(p[1], /^scene 3: its voice has 7 words, 4 short/);
  assert.match(p[2], /^the narration of these scenes is 13 words short: 27 words for about 40 \(scene 1 about 11, scene 2 about 18, scene 3 about 11\) — this 15-second film is only as long as its voice/);
  // The middle line has its eleven words: nothing is asked of it.
  assert.ok(!p.some((x) => /^scene 2:/.test(x)));
  // How to lengthen follows the mode: a faithful film grows from the user's own story, never a new event.
  assert.ok(lengthShortfalls(scenes, [11, 18, 11], plan, { mode: "faithful" }).every((x) => /never a new event or character/.test(x)));
  assert.ok(lengthShortfalls(scenes, [11, 18, 11], plan, { mode: "open" }).every((x) => /a concrete detail of that moment/.test(x)));
  // The local road has no clip floor, only the length: one problem, the total.
  const local = lengthShortfalls(scenes, [11, 18, 11], { clipFloor: 0, duration: 15 });
  assert.equal(local.length, 1); assert.match(local[0], /^the narration of these scenes is 13 words short/);
  // Within 80 % of the plan and every line a clip's worth: nothing to say.
  const full = ["Every pirate on this island knows the price long before he ever sees the treasure.", "She gives the boy the map, the squall takes two of his fingers, and the boy runs.", "The map is gone now, lost to the sea, but the price remains."].map((voice) => ({ voice }));
  assert.deepEqual(lengthShortfalls(full, [11, 18, 11], plan), []);
});

/** A picture storyboard with a direction of one section per scene. */
function film(voices, accents = ["red", "amber", "green"], extra = {}) {
  const n = voices.length;
  return {
    style: "picture", ...extra,
    direction: { sections: voices.map((_, i) => ({ name: `0${i + 1} PART`, accent: accents[i], means: "a part", scenes: 1 })) },
    scenes: voices.map((voice, i) => ({
      id: `0${i + 1}-part`, kind: i === n - 1 ? "closing" : "cinema", chapter: `0${i + 1} PART`, accent: accents[i], title: `Part ${i + 1}`, hl: "Part", voice,
      shots: [{ image_prompt: `picture ${i + 1}` }], ...(i === n - 1 ? { button: "Follow", hold: 0.4 } : { hold: 0.2 }),
    })),
  };
}

test("mergeThinScenes: a line under a clip's worth of words is joined to its neighbour, word for word", () => {
  const sb = film(LIVE);
  const seen = [];
  const notes = mergeThinScenes(sb, 4, { onMerge: (at, keepFirst) => seen.push([at, keepFirst]) });
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.match(notes[0], /^scenes 1 and 2 \("01-part", 7 words; "02-part", 13 words\) were joined into one line of 20 words: a line under 11 words cannot fill a 4-second clip/);
  assert.deepEqual(seen, [[0, false]], "the joined scene is the longer one's: the outline is joined in step");
  assert.equal(sb.scenes.length, 2, "never under two scenes");
  const [a, end] = sb.scenes;
  // Nothing invented, nothing lost: the words are the two lines, in order.
  assert.equal(a.voice, `${LIVE[0]} ${LIVE[1]}`);
  assert.deepEqual(sb.scenes.flatMap((s) => s.voice.split(/\s+/)), LIVE.join(" ").split(/\s+/));
  assert.equal(a.id, "02-part"); assert.equal(a.accent, "amber"); assert.equal(a.kind, "cinema");
  assert.equal(a.shots.length, 1, "twenty words pay for one clip"); assert.equal(a.shots[0].at, undefined);
  assert.equal(end.kind, "closing"); assert.equal(end.voice, LIVE[2]);
  // The sections follow: the hook's section gave up its only scene.
  assert.deepEqual(sb.direction.sections.map((s) => [s.accent, s.scenes]), [["amber", 1], ["green", 1]]);
  assert.deepEqual(directionProblems(sb.direction, { accents: CINEMA_ACCENTS, scenes: sb.scenes.length }).filter((p) => /sections/.test(p)), []);
});

test("mergeThinScenes: the second line's first picture cuts on words the first line does not say; the pictures follow the budget", () => {
  const second = "The map was the only thing she ever owned, and the storm took it on the night the boy ran.";
  assert.equal(words(second), 20);
  const sb = film(["The map is gone", second, "Nobody on that island ever spoke of the map or the boy again."]);
  sb.scenes[1].shots = [{ image_prompt: "picture 2" }, { image_prompt: "picture 3", at: "the storm" }];
  const notes = mergeThinScenes(sb, 4);
  assert.equal(notes.length, 1);
  const [a] = sb.scenes;
  assert.equal(a.voice, `The map is gone. ${second}`, "a line without an end gets one before the next begins");
  assert.equal(words(a.voice), 24);
  assert.deepEqual(a.shots.map((s) => s.image_prompt), ["picture 1", "picture 2"], "24 words carry two clips; the third picture goes");
  assert.equal(a.shots[1].at, "The map was", "\"The\" and \"The map\" are said by the first line: the cut would land early");
  assert.equal(a.shots[0].at, undefined);
});

test("mergeThinScenes: the colour law and the contract's two scenes are never broken; no floor, no join", () => {
  // The thin line sits alone in its section between two red ones: joining it either way leaves red beside red.
  const law = film(["Every pirate on this island knows the price long before he ever sees it.", "The map is gone.", "Nobody on that island ever spoke of the map or the boy again."], ["red", "amber", "red"]);
  const before = JSON.stringify(law);
  assert.deepEqual(mergeThinScenes(law, 4), []);
  assert.equal(JSON.stringify(law), before, "a join the direction refuses is not made");
  // Two scenes are the floor.
  const two = film(["The map is gone.", "The price remains."], ["red", "green"]);
  assert.deepEqual(mergeThinScenes(two, 4), []); assert.equal(two.scenes.length, 2);
  // The local road and the animatic buy nothing per shot.
  const local = film(LIVE);
  assert.deepEqual(mergeThinScenes(local, 0), []); assert.equal(local.scenes.length, 3);
  // Without a direction the join still happens.
  const bare = film(LIVE); delete bare.direction;
  assert.equal(mergeThinScenes(bare, 4).length, 1); assert.equal(bare.scenes.length, 2);
});

test("mergeThinScenes: a thin closing is joined to the scene before it and stays the closing, its button kept", () => {
  const sb = film(["Every pirate on this island knows the price long before he ever sees the treasure.", "She gives the boy the map, and the storm takes it from both of them.", "The price remains."]);
  const notes = mergeThinScenes(sb, 4);
  assert.equal(notes.length, 1);
  assert.equal(sb.scenes.length, 2);
  const end = sb.scenes[1];
  assert.equal(end.kind, "closing"); assert.equal(end.button, "Follow"); assert.equal(end.hold, 0.4);
  assert.equal(end.id, "02-part", "the longer line's scene is the one kept");
  assert.ok(end.shots.length <= 2);
  // What comes out is still a storyboard the contract accepts, and trimming it again changes nothing.
  assert.equal(trimShots(sb, null, 4), 0);
});

test("the planner's scene count leaves room for the floor: three lines of eleven or more in a 15 s film", () => {
  const job = { id: "gt_t", template: "viral-short", prompt: "Pirates and the price of a treasure", params: JSON.stringify({ duration_s: 15, format: "16:9", language: "en", voice: null, style: "realistic", clip_floor_s: 4 }) };
  const p = planFor(job);
  assert.deepEqual(p.scenes, [3, 3]);
  assert.ok(p.scenes[1] * clipWordsPerShot(p.clipFloor) <= p.words.target);
});

test("the treatment's narrator cannot starve the word budget", () => {
  const t = repairTreatment({ ...TREATMENT_FIXTURE(45), narrator: "Third person, present tense, sentences of five to eight words, never a question." }, 45, variationFor("gt_test0001"));
  assert.ok(t);
  const told = treatmentBlock(t, false, { target: 40, perLine: 11 });
  assert.match(told, /Narrator: Third person, present tense, sentences of five to eight words/);
  assert.match(told, /that sentence length is the narrator's register, never the word count: the narration still totals about 40 words, and every scene's line has 11 or more — short sentences come two or three to a line/);
  assert.doesNotMatch(treatmentBlock(t), /register, never the word count/, "without a budget the block is what it was");
  assert.doesNotMatch(treatmentBlock(t, false, { target: 81 }), /every scene's line has/, "no floor, no per-line number");
  // The treatment is written knowing the budget, and that sentence length is a register.
  const p = treatmentPrompt({ prompt: "Pirates and the price of a treasure", duration_s: 15, format: "16:9", language: "en", clipFloorS: 4 }, variationFor("gt_t2cxm2md"));
  assert.match(p, /15 seconds, narrated in English: about 40 words of narration in all, at least 11 under every shot/);
  assert.match(p, /"narrator":"<=\d+, person, tense, sentence length \(a register, never a cap on the words\)/);
  assert.match(treatmentPrompt({ prompt: "x y z", duration_s: 30, format: "9:16", language: "en" }, variationFor("gt_a")), /30 seconds, narrated in English: about 81 words of narration in all \(/);
  assert.match(MASTER_PROMPT, /Sentence length is a register, never a budget/);
});

test("the guide asks for a clip's worth on every line, and for the length", () => {
  const api = guideText({ duration_s: 15, style: "realistic", languages: ["en", "it"], clipFloorS: 4 });
  assert.match(api, /The hook and the closing too — a punch is a short first sentence inside the line, not a short line/);
  assert.match(api, /A line still under 11 words is joined by Kleo to its neighbour, word for word/);
  assert.match(api, /and not much under 32 either/);
  assert.doesNotMatch(guideText({ duration_s: 15, style: "realistic", languages: ["en", "it"] }), /joined by Kleo to its neighbour/, "the local road buys no clip");
});

test("a joined film still validates: the Venice sample, two nine-word lines on the API road", () => {
  const sb = JSON.parse(readFileSync(join(ROOT, "scripts", "motion-demo", "samples", "venezia-16x9.json"), "utf8"));
  assert.ok(validateStoryboard(sb, { format: "16:9", language: "it", clipFloorS: 4 }).ok, "the sample is valid before");
  const before = sb.scenes.map((s) => s.voice).join(" ").split(/\s+/);
  const notes = mergeThinScenes(sb, 4);
  assert.equal(notes.length, 2, JSON.stringify(notes));
  assert.equal(sb.scenes.length, 2);
  assert.ok(sb.scenes.every((s) => words(s.voice) >= clipWordsPerShot(4)), "every line fills its clip now");
  assert.deepEqual(sb.scenes.map((s) => s.voice).join(" ").split(/\s+/), before, "and the narration is the same words, in the same order");
  const r = validateStoryboard(sb, { format: "16:9", language: "it", clipFloorS: 4, requireDirection: true });
  assert.deepEqual(r.ok ? [] : r.errors, []);
});
