/**
 * Who decides that a video gets FILMED shots instead of one picture with a window moved over it.
 *
 * The answer has to be one answer, because four things depend on it and they are owned by different parts of the
 * code: what the video costs (STYLE_CREDITS), what card it needs (STYLE_MACHINE), how many may run at once
 * (isVideoStyle → MAX_CONCURRENT_VIDEO_GPUS), and whether the storyboard tells the worker to go and film
 * (backdrop: "video"). This project has already shipped one rule in four copies and paid for it; so the fourth is
 * DERIVED from the first three rather than written down again, and these tests exist to prove the derivation
 * actually holds — including on the day someone flips the switch, which is simulated here rather than waited for.
 *
 * The switch is deliberately still OFF: realistic renders still pictures. The first test asserts exactly that, so
 * that turning it on cannot happen by accident, and the second proves that when it IS turned on, all four move
 * together in one step.
 *
 * Run: node --test test/filmed-backdrop.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planFor, normalizeStoryboard, fixtureStoryboard } from "../src/storyboard.ts";
import { STYLE_MACHINE, STYLE_CREDITS, VIDEO, isVideoStyle, machineFor, creditsFor } from "../src/templates.ts";
import { validateStoryboard } from "../src/keou-contract.ts";

const KLEO_STYLES = ["cartoon", "realistic", "cyber", "stickman", "explainer"];

const job = (style, format = "16:9", duration_s = 40) => ({
  id: "gt_test", template: "story-documentary", prompt: "A night run through a rain-soaked city.",
  params: JSON.stringify({ duration_s, format, language: "en", voice: null, style }),
});

const scenesFor = (n = 3) => Array.from({ length: n }, (_, i) => ({
  id: `${String(i + 1).padStart(2, "0")}-part`, kind: i === n - 1 ? "closing" : "cinema",
  chapter: `0${i + 1} PART`, accent: "amber", title: `part ${i + 1}`,
  voice: `This is the ${i + 1} line of a story that has to be said out loud.`,
}));

const normalized = (style, extra = {}) => {
  const plan = planFor(job(style), style);
  return { plan, sb: normalizeStoryboard({ title: "Night run", description: "d", tags: ["a"], scenes: scenesFor(), ...extra }, plan) };
};

/** Flip one style's machine for the length of one test, and always put the table back. */
const withMachine = (style, machine, fn) => {
  const before = STYLE_MACHINE[style];
  STYLE_MACHINE[style] = machine;
  try { fn(); } finally { STYLE_MACHINE[style] = before; }
};

test("the switch is off: nothing is filmed today, and no storyboard asks to be", () => {
  for (const style of KLEO_STYLES) {
    assert.equal(isVideoStyle(style), false, `${style} must still render pictures`);
    assert.equal(STYLE_CREDITS[style], 1, `${style} is still priced as a picture style`);
  }
  for (const style of ["cartoon", "realistic"]) {
    const { sb } = normalized(style);
    assert.equal("backdrop" in sb, false, `${style} must not ask to be filmed while it is not`);
  }
});

test("flipping one entry to VIDEO moves the price, the card, the limit and the storyboard together", () => {
  withMachine("realistic", VIDEO, () => {
    assert.equal(isVideoStyle("realistic"), true, "the concurrency limit follows the machine");
    assert.equal(machineFor("realistic").minVramGb, 32, "24 GB dies with OutOfMemory at the first shot");
    assert.equal(machineFor("realistic").minComputeCap, 800, "compute 7.0 has no bf16 and is about five times slower");

    const { sb } = normalized("realistic");
    assert.equal(sb.backdrop, "video", "the storyboard must tell the worker to go and film");
    assert.equal(sb.style, "picture");
    assert.equal(sb.kleo_style, "realistic");

    // The one thing that does NOT follow on its own, and must not: the price is a separate line in the same commit.
    assert.equal(creditsFor(40, "realistic"), 1,
      "the price is deliberately not derived from the machine — it is the human decision of the same commit");
  });
  assert.equal(isVideoStyle("realistic"), false, "the table is restored");
});

test("cartoon is filmed too the day its machine says so", () => {
  withMachine("cartoon", VIDEO, () => {
    assert.equal(normalized("cartoon").sb.backdrop, "video");
  });
});

test("a style that is not the picture style is never filmed, whatever its machine says", () => {
  // The engine creates its canvas once, when the page loads: a transparent canvas is a property of the whole
  // project. contract.py and keou-contract.ts both refuse a backdrop outside the picture style, so a storyboard
  // that asked for one here would be a job that dies at validation, after the card has been paid for.
  withMachine("cyber", VIDEO, () => {
    const { plan, sb } = normalized("cyber");
    assert.notEqual(plan.style, "picture");
    assert.equal("backdrop" in sb, false, "the cyber style has no pictures to lay a track under");
  });
});

test("a storyboard that arrived already asking to be filmed does not get filmed for free", () => {
  // Without the deletion this is a seven-credit render sold at the price of a one-credit one: the field simply
  // travels in on a storyboard the caller wrote, and the worker obeys it.
  const { sb } = normalized("realistic", { backdrop: "video" });
  assert.equal("backdrop" in sb, false, "the plan decides what is filmed, never the incoming storyboard");
});

test("the fixture describes the same product as the real path", () => {
  assert.equal("backdrop" in fixtureStoryboard(job("realistic")), false);
  withMachine("realistic", VIDEO, () => {
    assert.equal(fixtureStoryboard(job("realistic")).backdrop, "video",
      "a fixture that skipped this would test a product we do not ship");
  });
});

test("what the switch produces still passes the validator that guards the render", () => {
  withMachine("realistic", VIDEO, () => {
    const { sb } = normalized("realistic");
    const r = validateStoryboard(sb, { format: "16:9", maxDuration: 90, style: "picture", kleo: "realistic" });
    assert.ok(!r.errors?.some((e) => /backdrop/i.test(e)), "the backdrop must not be what breaks it: " + JSON.stringify(r.errors));
  });
});

test("the two machine profiles really do differ, or none of this means anything", () => {
  // isVideoStyle is derived from exactly this difference; if the ordinary profile ever grew to 32 GB, every style
  // would silently become a "video style" and take the concurrency limit and the dear card with it.
  const ordinary = machineFor("stickman");
  assert.ok(VIDEO.minVramGb > ordinary.minVramGb,
    `the video profile must ask for more memory than the ordinary one (${VIDEO.minVramGb} vs ${ordinary.minVramGb})`);
});
