/**
 * The props (27 September 2026): the recurring objects of a film get ONE description, the way the cast does, and
 * every still and clip prompt that shows them carries it. The test film of 22 September drew its pencil yellow in one
 * shot and brown in the next and its line blue in a third, because direction.objects was a vocabulary of nouns that
 * reached no picture at all; and a one-person film seen only as hands drew an old man's hand in one shot, because
 * "a hand draws a line" named nobody. Pure functions only: the direction, the stills compiler, the contract, the
 * planner's text helpers and the plan judge's prompt.
 * Run: node --test test/props.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  D, directionProblems, propsFor, pictureContext, castFor, foreignPictureFields, negativeFor, thinPropLook, PRONOUN_HINTS,
} from "../src/direction.ts";
import { compileStill, stillProps, stillShotsOf, feedbackFor } from "../src/stills.ts";
import { validateStoryboard, pictureScenes, stripForWorker, AUTHORING_SHOT_FIELDS, CINEMA_ACCENTS, SHOT_PROPS_MAX } from "../src/keou-contract.ts";
import { directionBlock, applyEnglishFields, englishFieldsPrompt, englishFieldsSchema, directionSchema } from "../src/storyboard.ts";
import { judgePrompt } from "../src/fidelity.ts";
import { EXAMPLE_DIRECTION, EXAMPLE_SCENES } from "../src/guide.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const opts = { accents: CINEMA_ACCENTS };
const PENCIL = { name: "the pencil", look: "a short yellow hexagonal HB pencil with a worn pink eraser, drawing a thin grey graphite line" };
const LAMP = { name: "the desk lamp", look: "a black enamel desk lamp on a jointed arm, a warm tungsten bulb, a dented shade" };

const good = (over = {}) => ({
  subject: "The moment an idea is born on paper",
  goal: "The viewer feels the spark of a first sketch",
  audience: "Makers and students",
  tone: "Quiet and warm",
  must_keep: [],
  world: "A small desk by one window before dawn, cream paper, brass fittings, slate blue shadows",
  cast: [{ name: "the writer", look: "a young woman seen only as hands and forearms, slim fingers, short clean nails, a cream wool sleeve" }],
  objects: ["pencil", "paper", "desk lamp", "window"],
  forbidden: ["text in the picture", "brand logo", "phone", "blue ink"],
  props: [PENCIL, LAMP],
  sections: [
    { name: "01 THE BLANK PAGE", accent: "amber", means: "what is not there yet", scenes: 1 },
    { name: "02 THE LINE", accent: "cyan", means: "the idea arriving", scenes: 1 },
  ],
  ...over,
});

/* ------------------------------------------------------------------ the direction */

test("props: optional, bounded, described once, never under a character's name", () => {
  assert.deepEqual(directionProblems(good(), { ...opts, scenes: 2 }), []);
  const { props: _, ...legacy } = good();
  assert.deepEqual(directionProblems(legacy, { ...opts, scenes: 2 }), [], "a direction written before props existed is still valid");
  assert.deepEqual(directionProblems(good({ props: [] }), { ...opts, scenes: 2 }), []);
  assert.equal(D.props.max, 6); assert.equal(D.props.name, 36); assert.equal(D.props.look, 300);
  const has = (d, re) => directionProblems(d, opts).some((p) => re.test(p));
  assert.ok(has(good({ props: "a pencil" }), /direction\.props must be an array/));
  assert.ok(has(good({ props: Array.from({ length: 7 }, (_, i) => ({ name: `prop ${i}`, look: PENCIL.look })) }), /props has 7 entries, the limit is 6/));
  assert.ok(has(good({ props: [{ name: "the pencil" }] }), /props\[0\]\.look is required/));
  assert.ok(has(good({ props: [{ name: "the pencil", look: "a yellow pencil" }] }), /props\[0\]\.look "a yellow pencil" is a name, not a look/));
  assert.ok(has(good({ props: [PENCIL, { name: "The Pencil", look: LAMP.look }] }), /props\[1\] repeats the prop "The Pencil"/));
  assert.ok(has(good({ props: [{ name: "the writer", look: PENCIL.look }] }), /props\[0\] is called "the writer" like a character of the cast/));
  assert.ok(has(good({ props: [{ name: "x".repeat(37), look: PENCIL.look }] }), /props\[0\]\.name is 37 characters, the limit is 36/));
  assert.equal(thinPropLook("a short yellow hexagonal pencil"), false, "five words fix colour and shape");
  assert.equal(thinPropLook("an old brass key"), true);
});

test("propsFor: the shot's own list decides, then the prop's name or its unique head noun; never a pronoun", () => {
  const d = good();
  const names = (prompt, shot) => propsFor(d, prompt, shot).map((m) => m.name);
  assert.deepEqual(names("A hand draws a line with the pencil on cream paper"), ["the pencil"], "the whole name");
  assert.deepEqual(names("A hand lifts a pencil from the desk"), ["the pencil"], "the name without its article, or the head noun");
  assert.deepEqual(names("The lamp flickers on above the page"), ["the desk lamp"], "the head noun of 'the desk lamp'");
  assert.deepEqual(names("It rolls across the page"), [], "'it' can mean anything");
  assert.deepEqual(names("A pencil case on the shelf", ["the desk lamp"]), ["the desk lamp"], "the shot's list wins over the words");
  assert.deepEqual(names("The lamp and the pencil", ["The Pencil"]), ["the pencil"], "by name, case and article folded");
  assert.deepEqual(names("The pencil by the lamp", ["the ghost"]), ["the pencil", "the desk lamp"], "a list that names nothing known falls back to the words");
  // Two props sharing a head noun: only the whole name counts ("the red pencil" / "the blue pencil").
  const two = { props: [{ name: "the red pencil", look: PENCIL.look }, { name: "the blue pencil", look: PENCIL.look.replace("yellow", "blue") }] };
  assert.deepEqual(propsFor(two, "A pencil on the desk").map((m) => m.name), []);
  assert.deepEqual(propsFor(two, "The red pencil on the desk").map((m) => m.name), ["the red pencil"]);
  // A direction with no props, or an old one, adds nothing anywhere.
  assert.deepEqual(propsFor({ props: undefined }, "the pencil"), []);
  assert.deepEqual(propsFor(null, "the pencil"), []);
  assert.deepEqual(propsFor({ props: ["pencil"] }, "the pencil"), [], "a malformed entry is ignored, not pasted");
});

test("pictureContext: the cast first, then the props, then the world; the negative side reads the props too", () => {
  const d = good();
  const ctx = pictureContext(d, "The writer's hand draws a line with the pencil", null, "realistic");
  assert.ok(ctx.startsWith("the writer: a young woman"), ctx);
  const at = (s) => ctx.indexOf(s);
  assert.ok(at("the pencil: a short yellow hexagonal HB pencil") > at("the writer:"), ctx);
  assert.ok(at(d.world) > at("the pencil:"), ctx);
  assert.ok(!ctx.includes("desk lamp"), "a prop the shot does not show is not pasted");
  assert.ok(pictureContext(d, "The lamp", null, "realistic", null, null, ["the pencil"]).includes("the pencil:"), "the shot's props list reaches pictureContext");
  const neg = negativeFor(good({ props: [{ name: "the pencil", look: "a plain grey pencil with no eraser and no markings at all" }] }), "base");
  assert.match(neg, /eraser/);
  const it = foreignPictureFields(good({ props: [PENCIL, { name: "la lampada", look: "una lampada nera con il braccio snodato e la luce calda" }] }));
  assert.deepEqual(it, ["props[1]"], "a prop look is a sentence, checked like a cast look");
});

test("the hands: in a one-character film a hand, fingers or a forearm are that character", () => {
  const one = [{ name: "the writer", look: good().cast[0].look }];
  const names = (cast, p) => castFor(cast, p).map((m) => m.name);
  for (const p of ["A hand draws a thin line across the page", "Fingers tap the pencil against the desk", "A forearm rests on the paper", "Two hands smooth the sheet flat"])
    assert.deepEqual(names(one, p), ["the writer"], p);
  assert.deepEqual(names(one, "An empty desk at dawn"), [], "nobody named, nobody drawn");
  const two = [...one, { name: "the teacher", look: "a tall grey-haired man in a tweed jacket and round glasses" }];
  assert.deepEqual(names(two, "A hand draws a line"), [], "with two people a hand could be either");
  assert.ok(PRONOUN_HINTS.test("her fingertips")); assert.ok(!PRONOUN_HINTS.test("handsome scenery"), "a whole word only");
});

/* ------------------------------------------------------------------ the stills */

test("compileStill: every prop the shot shows is written with its look after the characters, and judged softly", () => {
  const d = good();
  const input = (shot) => ({ shot: { id: "01-a-s1", ...shot }, spec: null, direction: d, look: "realistic", format: "9:16", refs: [] });
  const c = compileStill(input({ image_prompt: "The writer's hand draws a line with the pencil across cream paper", props: ["the pencil"] }));
  const at = (s) => c.prompt.indexOf(s);
  assert.ok(at("the writer: a young woman") > at("The writer's hand draws"), c.prompt);
  assert.ok(at("the pencil: a short yellow hexagonal HB pencil with a worn pink eraser, drawing a thin grey graphite line.") > at("the writer: a young woman"), c.prompt);
  assert.ok(at("Setting:") > at("the pencil:"), c.prompt);
  assert.ok(!c.prompt.includes("desk lamp:"), c.prompt);
  const check = c.checks.find((x) => x.id === "prop:the-pencil");
  assert.ok(check, c.checks.map((x) => x.id).join(", "));
  assert.equal(check.must, false, "soft: a small object in a wide shot is what a judge answers unreliably");
  assert.match(check.question, /^Is there an object matching this description: the pencil, a short yellow hexagonal HB pencil/);
  assert.deepEqual(feedbackFor([{ ...check, must: true }], null, "realistic"), [`this object looks exactly like this: ${PENCIL.name}, ${PENCIL.look}`]);
  // No props, no prop line and no prop check: a film planned before 27 September draws exactly as it did.
  const { props: _, ...legacy } = d;
  const old = compileStill({ ...input({ image_prompt: "The writer's hand draws a line with the pencil" }), direction: legacy });
  assert.ok(!old.prompt.includes("the pencil:")); assert.ok(!old.checks.some((x) => x.id.startsWith("prop:")));
  // A long film's worth of looks still fits, and the author's sentence and the "Without" list survive the shrink.
  const crowded = good({ cast: [{ name: "the writer", look: `${good().cast[0].look}, ${"with a very particular detail ".repeat(12)}`.slice(0, 420) }], world: "w ".repeat(90).trim(), props: Array.from({ length: 6 }, (_, i) => ({ name: `the thing ${i}`, look: `object number ${i} made of ${"brass and oak and paper ".repeat(12)}`.slice(0, 300) })) });
  const big = compileStill({ shot: { id: "x", image_prompt: "The writer's hand with every thing on the desk", props: crowded.props.map((p) => p.name) }, spec: null, direction: crowded, look: "realistic", format: "9:16", refs: [] });
  assert.ok(big.prompt.length <= 1800, `${big.prompt.length}`);
  assert.ok(big.prompt.includes("The writer's hand with every thing on the desk."));
});

test("stillProps and stillShotsOf read the shot's props from the stored storyboard", () => {
  const sb = { style: "picture", kleo_style: "realistic", direction: good(), scenes: [{ id: "01-a", kind: "cinema", voice: "v", shots: [{ image_prompt: "The lamp glows over an empty page", props: ["the desk lamp"] }, { image_prompt: "A pencil lies on the desk" }] }] };
  const shots = stillShotsOf(sb);
  assert.deepEqual(shots.map((s) => s.props), [["the desk lamp"], []]);
  assert.deepEqual(stillProps(shots[0], sb.direction).map((m) => m.name), ["the desk lamp"]);
  assert.deepEqual(stillProps(shots[1], sb.direction).map((m) => m.name), ["the pencil"], "no list: the words");
  assert.deepEqual(pictureScenes(sb)[0].props, ["the desk lamp"]);
});

/* ------------------------------------------------------------------ the contract */

test("a shot may list its props; the list is typed, stored, and never reaches the GPU", () => {
  assert.deepEqual([...AUTHORING_SHOT_FIELDS], ["covers", "cast", "action", "props"]);
  assert.equal(SHOT_PROPS_MAX, D.props.max);
  const sb = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "cartoon-pirates-directed.json"), "utf8"));
  sb.direction.props = [{ name: "the chest", look: "a small oak chest bound with black iron bands and a rusty padlock" }];
  sb.scenes[0].shots[0].props = ["the chest"];
  const r = validateStoryboard(sb, { format: sb.format, language: sb.language, requireDirection: true });
  assert.deepEqual(r.ok ? [] : r.errors, []);
  assert.deepEqual(r.storyboard.scenes[0].shots[0].props, ["the chest"]);
  const worker = stripForWorker(r.storyboard);
  assert.ok(!("props" in worker.scenes[0].shots[0]), "contract.py refuses unknown shot fields on a rented GPU");
  assert.deepEqual(worker.direction.props, sb.direction.props, "the direction itself travels (the GPU fallback reads it)");
  const bad = JSON.parse(JSON.stringify(sb)); bad.scenes[0].shots[0].props = "the chest";
  const rb = validateStoryboard(bad, { format: sb.format, language: sb.language });
  assert.ok(!rb.ok && rb.errors.some((e) => /props: a list of at most 6 short strings/.test(e)), JSON.stringify(rb.errors));
  const thin = JSON.parse(JSON.stringify(sb)); thin.direction.props = [{ name: "the chest", look: "a chest" }];
  const rt = validateStoryboard(thin, { format: sb.format, language: sb.language });
  assert.ok(!rt.ok && rt.errors.some((e) => /props\[0\]\.look "a chest" is a name, not a look/.test(e)), JSON.stringify(rt.errors));
});

test("the guide's example teaches a prop, and it is legal", () => {
  assert.equal(EXAMPLE_DIRECTION.props[0].name, "the chest");
  assert.deepEqual(directionProblems(EXAMPLE_DIRECTION, { ...opts, scenes: 2 }), []);
  assert.deepEqual(EXAMPLE_SCENES[0].shots[0].props, ["the chest"]);
});

/* ------------------------------------------------------------------ the planner and the judge */

test("the planner asks for props, prints them to every scene writer, and translates them", () => {
  const schema = directionSchema();
  const dp = schema.properties.direction;
  assert.ok(dp.properties.props, "the grammar can decode props");
  assert.ok(!dp.required.includes("props"), "optional: an answer without props is still a direction");
  const block = directionBlock(good());
  assert.match(block, /Props, the SAME object every time it appears/);
  assert.match(block, /  - the pencil: a short yellow hexagonal HB pencil/);
  assert.doesNotMatch(directionBlock(good({ props: undefined })), /Props,/);
  // The English pass: the props travel only when there are any, and come back one for one.
  const d = good({ props: [{ name: "la matita", look: "una matita gialla esagonale con la gomma rosa consumata" }] });
  assert.match(englishFieldsPrompt(d, "it"), /"props":\[\{"name":"la matita"/);
  assert.doesNotMatch(englishFieldsPrompt(good({ props: undefined }), "it"), /"props"/);
  assert.ok(englishFieldsSchema().properties.props);
  applyEnglishFields(d, { world: d.world, cast: d.cast, objects: d.objects, forbidden: d.forbidden, props: [{ name: "the pencil", look: "a yellow hexagonal pencil with a worn pink eraser" }] });
  assert.deepEqual(d.props, [{ name: "the pencil", look: "a yellow hexagonal pencil with a worn pink eraser" }]);
  const kept = good();
  applyEnglishFields(kept, { world: kept.world, cast: kept.cast, objects: kept.objects, forbidden: kept.forbidden, props: [PENCIL] });
  assert.deepEqual(kept.props, [PENCIL, LAMP], "an answer of another length changes nothing");
});

test("the plan judge sees the props and which shot lists them", () => {
  const spec = { v: 1, mode: "open", summary: "an idea on paper", cast: [], items: [{ id: "R1", kind: "object", text: "a yellow pencil", quote: "matita gialla", must: true, who: null, order: null }], refs: [], open: [], narration: "free", script: null };
  const sb = { direction: good(), scenes: [{ id: "01-a", voice: "v", shots: [{ image_prompt: "A hand with the pencil", props: ["the pencil"], covers: ["R1"] }] }] };
  const p = judgePrompt(spec, sb);
  assert.match(p, /The recurring objects as the plan draws them/);
  assert.match(p, /  the pencil: a short yellow hexagonal HB pencil/);
  assert.match(p, /01-a-s1 \| image: A hand with the pencil \| props: the pencil \| covers: R1/);
});
