/**
 * The explainer's drawings, executed.
 *
 * Every other test in the suite checks the storyboard. Nothing checked the code that turns a storyboard
 * into pixels, and that code only ever runs inside headless Chromium on a rented GPU — so a typo in one
 * of the fifty-nine drawings is found after the machine is paid for, in a render that dies at 40 %.
 *
 * This runs each drawing against a counting stub of CanvasRenderingContext2D. It produces no image; it
 * proves the builder executes for a drawing that is finished, one still being drawn, and one carrying
 * every flag at once, that it puts marks on the page, and that it leaves the context exactly as it
 * found it. The last one is the bug a still frame cannot show: a builder that forgets `restore()`
 * corrupts every drawing after it, in every later scene.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SKETCH_ART } from "../src/keou-contract.ts";

const SRC = readFileSync(resolve(import.meta.dirname, "../worker/keou/engine/sketch.js"), "utf8");

/** A context that counts instead of painting, and a window the style can register itself on. */
function harness() {
  const seen = { depth: 0, marks: 0 };
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === "canvas") return { width: 2160, height: 3840 };
      if (k === "save") return () => { seen.depth++ };
      if (k === "restore") return () => { seen.depth-- };
      if (k === "stroke" || k === "fill" || k === "fillRect" || k === "strokeRect" || k === "fillText" || k === "strokeText") return () => { seen.marks++ };
      if (k === "createRadialGradient" || k === "createLinearGradient") return () => ({ addColorStop() {} });
      if (k === "measureText") return () => ({ width: 100 });
      if (typeof k === "symbol") return undefined;
      return () => {};
    },
    set() { return true },
  });
  const win = { document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) } };
  const sandbox = { window: win, document: win.document, __ART: null };
  const fn = new Function("window", "document", "globalThis_", SRC.replace("const ART = {};", "const ART = {}; globalThis_.__ART = ART;"));
  fn(win, win.document, sandbox);
  win.KEOU_SKETCH.attach({ ctx, W: 2160, H: 3840 });
  return { art: sandbox.__ART, seen };
}

/** A finished drawing, one mid-stroke, and one asked for every option at once. */
const STATES = [
  { es: 99 },
  { es: 0.2 },
  { es: 0.5, no: true, flash: true, xray: true, flip: true, sweat: true, leader: true, count: 12, open: 1, open_to: 0.6, swing_over: 1.2, text: "TO: TOKYO", mood: "scared", tint: "red", led: "green", beam: "blue", chip: "yellow", reach: [200, -80] },
];

test("every drawing the contract allows executes, draws something, and leaves the canvas as it found it", () => {
  const { art, seen } = harness();
  const problems = [];
  for (const name of SKETCH_ART) {
    const fn = art[name];
    if (!fn) { problems.push(`ART.${name} does not exist`); continue }
    for (const t of [0, 0.7, 2.3]) {
      for (const o of STATES) {
        seen.depth = 0;
        const before = seen.marks;
        try { fn(t, 0.5, { ...o }) } catch (e) { problems.push(`${name}: threw "${e.message}" at t=${t}`); continue }
        if (seen.depth !== 0) problems.push(`${name}: leaves the context ${seen.depth > 0 ? "saved" : "restored"} ${Math.abs(seen.depth)} time(s) — every drawing after it inherits that`);
        if (o.es === 99 && seen.marks === before) problems.push(`${name}: a finished drawing that puts nothing on the page`);
      }
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

test("the engine draws nothing the contract does not allow", () => {
  const { art } = harness();
  const extra = Object.keys(art).filter((n) => !SKETCH_ART.includes(n));
  assert.deepEqual(extra, [], "a drawing no author can reach is a drawing the guide never teaches");
});
