/**
 * The drift guard.
 *
 * Kleo validates a storyboard twice: here in TypeScript, before a GPU is rented, and again in
 * worker/keou/contract.py on the rented machine. Every rule that lives in one and not the other is a
 * job that passes the free gate, boots a GPU, spends a credit and dies. Nothing in the suite compared
 * the two until this file: it parses the Python literals out of contract.py — the same trick
 * test/shot-grammar.test.mjs uses — and asserts set equality, so a name added on one side alone fails
 * the build instead of a render.
 *
 * It also pins the two invariants the explainer cannot be drawn without: every art name has a builder
 * in engine/sketch.js, and the camera always pushes in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STYLES, KINDS, SKETCH_ACCENTS, SKETCH_ART, SKETCH_DROP, SKETCH_MOODS, SKETCH_MOTION, SKETCH_ENTER, SKETCH_EXIT,
  KLEO_STYLES, validateStoryboard, kleoStyleOf,
} from "../src/keou-contract.ts";
import { EXAMPLE_SKETCH_SCENES, guideExample } from "../src/guide.ts";
import { checkExplainer } from "../src/explainer-plan.ts";

const root = resolve(import.meta.dirname, "..");
const PY = readFileSync(resolve(root, "worker/keou/contract.py"), "utf8");
const SKETCH_JS = readFileSync(resolve(root, "worker/keou/engine/sketch.js"), "utf8");

/** The `{'a', 'b'}` literal assigned to `name` in contract.py, as a sorted array. */
function pySet(name) {
  const m = PY.match(new RegExp(`^${name}\\s*=\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(m, `contract.py should declare ${name}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}
const sorted = (a) => [...a].sort();

test("the two validators agree on every explainer name", () => {
  for (const [name, ts] of [
    ["STYLES", STYLES], ["KINDS", KINDS],
    ["SKETCH_ACCENTS", SKETCH_ACCENTS], ["SKETCH_ART", SKETCH_ART], ["SKETCH_MOODS", SKETCH_MOODS],
    ["SKETCH_MOTION", SKETCH_MOTION], ["SKETCH_ENTER", SKETCH_ENTER], ["SKETCH_EXIT", SKETCH_EXIT],
  ]) {
    assert.deepEqual(pySet(name), sorted(ts), `${name} drifted between TypeScript and Python`);
  }
});

test("both validators know how far every drawing reaches below its centre", () => {
  // SKETCH_DROP is what makes the caption safe area a fact instead of a guess, and a table that exists on
  // one side only is a storyboard the free gate accepts and the rented machine refuses.
  const m = PY.match(/^SKETCH_DROP\s*=\s*\{([\s\S]*?)\}/m);
  assert.ok(m, "contract.py should declare SKETCH_DROP");
  const py = Object.fromEntries([...m[1].matchAll(/'([^']+)':\s*(\d+)/g)].map((x) => [x[1], Number(x[2])]));
  assert.deepEqual(py, SKETCH_DROP, "SKETCH_DROP drifted between TypeScript and Python");
  for (const name of SKETCH_ART) assert.equal(typeof SKETCH_DROP[name], "number", `${name} has no measured extent`);
});

test("every drawing the contract allows exists in the engine", () => {
  const built = new Set([...SKETCH_JS.matchAll(/^\s*ART\.(\w+)\s*=/gm)].map((m) => m[1]));
  for (const name of SKETCH_ART) {
    assert.ok(built.has(name), `engine/sketch.js has no ART.${name}: the frame would draw nothing`);
  }
  // The reverse too: a builder no contract lets an author reach is dead weight the guide never teaches.
  for (const name of built) {
    assert.ok(SKETCH_ART.includes(name), `engine/sketch.js draws ART.${name}, which the contract does not allow`);
  }
});

/* ------------------------------------------------------------------ the scene rules */

const scene = (over = {}) => ({
  id: "01-card", kind: "sketch", accent: "red",
  voice: "This looks like a normal hotel key card. It isn't.",
  shot: { zoom: [1, 1.4], focus: [540, 860] },
  art: [{ name: "keycard", drawn: true }, { name: "hand", at: "a normal" }],
  hold: 0.05, ...over,
});
const board = (scenes, over = {}) => ({
  schema_version: 1, editorial_status: "ready", title: "Your hotel door isn't locked",
  style: "sketch", format: "9:16", language: "en", voice: "am_michael", music: "none", scenes, ...over,
});
const errorsOf = (sb, opts = { format: "9:16", language: "en" }) => validateStoryboard(sb, opts).errors ?? [];

test("an explainer storyboard needs no closing scene and no titles", () => {
  const sb = board([scene(), scene({ id: "02-room", art: [{ name: "room", drawn: true }] })]);
  assert.deepEqual(errorsOf(sb), []);
  assert.equal(kleoStyleOf(sb), "explainer");
});

test("the camera never stops pushing in", () => {
  for (const zoom of [[1, 1], [1.4, 1.2], [2, 0.9]]) {
    const errs = errorsOf(board([scene({ shot: { zoom, focus: [540, 860] } }), scene({ id: "02-x" })]));
    assert.ok(errs.some((e) => /zoom must increase/.test(e)), `zoom ${zoom.join("→")} should be refused`);
  }
  assert.deepEqual(errorsOf(board([scene({ shot: { zoom: [1, 1.01], focus: [540, 860] } }), scene({ id: "02-x" })])), []);
});

test("a cue must quote words the scene actually speaks", () => {
  const errs = errorsOf(board([scene({ art: [{ name: "keycard", drawn: true }, { name: "hand", at: "a passport" }] }), scene({ id: "02-x" })]));
  assert.ok(errs.some((e) => /must quote words from this scene's voice/.test(e)));
});

test("the art bounds follow the frame, so a 16:9 video may place art past 1080", () => {
  const wide = board([scene({ shot: { zoom: [1, 1.3], focus: [1500, 500] }, art: [{ name: "globe", x: 1500, y: 500 }] }), scene({ id: "02-x", art: [{ name: "room" }] })], { format: "16:9" });
  assert.deepEqual(errorsOf(wide, { format: "16:9", language: "en" }), []);
  // The same coordinates are off the page in portrait.
  const tall = board([scene({ shot: { zoom: [1, 1.3], focus: [1500, 500] }, art: [{ name: "globe", x: 1500, y: 500 }] }), scene({ id: "02-x", art: [{ name: "room" }] })]);
  assert.ok(errorsOf(tall).some((e) => /focus x/.test(e)));
});

test("the style and the scene kind are locked to each other", () => {
  const mixed = board([scene(), scene({ id: "02-x" })], { style: "cinema" });
  assert.ok(errorsOf(mixed).some((e) => /explainer scenes need the explainer style/.test(e)));
  const other = board([{ id: "01-a", kind: "hero", title: "Hello", voice: "One two three." }, scene({ id: "02-x" })]);
  assert.ok(errorsOf(other).some((e) => /the explainer style only draws explainer scenes/.test(e)));
});

test("explainer is a Kleo style and resolves to the sketch engine", () => {
  assert.ok(KLEO_STYLES.includes("explainer"));
  assert.equal(kleoStyleOf({ style: "sketch", scenes: [] }), "explainer");
});

test("the guide's worked example is a film the validator accepts and the rules approve of", () => {
  // A guide that teaches a shape the validator refuses is worse than no guide: every model that follows
  // it produces a job that dies on a machine the account has paid for.
  const sb = board(EXAMPLE_SKETCH_SCENES, { title: "Your hotel door isn't locked" });
  assert.deepEqual(errorsOf(sb), []);
  const broken = checkExplainer(EXAMPLE_SKETCH_SCENES, { duration: 45, language: "en" })
    .filter((v) => !["turn", "payoff", "colour"].includes(v.rule));   // two scenes of six cannot carry the whole arc
  assert.deepEqual(broken.map((v) => v.rule), []);
  const printed = guideExample("explainer");
  assert.match(printed, /"drawn":true/, "the example must show the drawing that is on the page at frame zero");
  assert.ok(!/cabin boy|image_prompt|shots/.test(printed), "the explainer guide must not fall back to the picture example");
});
