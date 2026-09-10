/**
 * The narrative table is the ONE place the structure of a video is written down.
 *
 * Before it, the same thing was said in three: the template description the assistant reads out to the
 * user, the brief in the planner, and the storyboard guide. They drifted, because nothing made them
 * agree. This file is what makes them agree — and, in particular, what stops the table itself from
 * quietly becoming three tables again through overrides.
 *
 * The rule the coordinating session set, encoded here so nobody has to remember it: if a template's
 * override rewrites more than three fields, it is not a template any more, it is a family nobody has
 * written down yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, FAMILIES, narrativeFor, sceneSplit, hookOf, turnOf } from "../src/templates.ts";
import { EXPLAINER_WORDS, EXPLAINER_GUIDANCE } from "../src/explainer-plan.ts";
import { STYLES } from "../src/keou-contract.ts";

const MAX_OVERRIDE_FIELDS = 3;

test("every template names a family that exists", () => {
  for (const t of TEMPLATES) assert.ok(FAMILIES[t.family], `${t.id} names family "${t.family}", which is not written down`);
});

test("an override says only what the format forces", () => {
  for (const t of TEMPLATES) {
    const n = Object.keys(t.override ?? {}).length;
    assert.ok(n <= MAX_OVERRIDE_FIELDS,
      `${t.id} overrides ${n} fields of "${t.family}". More than ${MAX_OVERRIDE_FIELDS} means it wants its own family, not an override.`);
  }
});

test("a family's sections tile the film exactly once", () => {
  for (const [id, f] of Object.entries(FAMILIES)) {
    const sum = f.sections.reduce((a, s) => a + s.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${id}: the sections add up to ${sum}, not 1 — part of the film belongs to nobody`);
    assert.ok(f.sections.length >= 3, `${id}: fewer than three sections is not a structure`);
    for (const s of f.sections) {
      assert.ok(s.weight > 0, `${id}/${s.name}: a section with no share of the film is not a section`);
      assert.ok(s.role.length > 20, `${id}/${s.name}: the role is what the planner hands the model — write it`);
      assert.match(s.name, /^\d\d /, `${id}/${s.name}: sections are numbered so the outline can be read in order`);
    }
    assert.ok(f.guidance.length > 120, `${id}: the brief is what the model actually reads`);
    assert.ok(STYLES.includes(f.keouStyle), `${id}: ${f.keouStyle} is not a style the engine can draw`);
    assert.ok(f.wordsPerScene[0] < f.wordsPerScene[1], `${id}: the word window is inverted`);
    assert.ok(f.shotSeconds > 0 && f.shotSeconds < 10, `${id}: shotSeconds ${f.shotSeconds} is not a shot`);
  }
});

test("the hook is the first section and the turn is not the hook", () => {
  for (const [id, f] of Object.entries(FAMILIES)) {
    assert.equal(hookOf(f), f.sections[0], `${id}: the hook must be first`);
    assert.notEqual(turnOf(f), hookOf(f), `${id}: nothing turns`);
  }
});

test("every scene belongs to exactly one section, at any length", () => {
  for (const t of TEMPLATES) {
    const f = narrativeFor(t.id);
    for (const scenes of [f.sections.length, 6, 12, 30, 60]) {
      const split = sceneSplit(f, scenes);
      assert.equal(split.length, f.sections.length, `${t.id}: a section vanished at ${scenes} scenes`);
      assert.ok(split.every((n) => n >= 1), `${t.id}: a section got no scene at ${scenes} scenes`);
      const total = split.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - scenes) <= 0, `${t.id}: ${total} scenes handed out of ${scenes}`);
    }
  }
});

test("the explainer reads its numbers from the table and nowhere else", () => {
  // The drift this whole file exists to prevent, on the pair that proved the design.
  assert.deepEqual(EXPLAINER_WORDS.short, narrativeFor("explainer-short").wordsPerScene);
  assert.deepEqual(EXPLAINER_WORDS.long, narrativeFor("explainer-long").wordsPerScene);
  assert.equal(EXPLAINER_GUIDANCE.short, narrativeFor("explainer-short").guidance);
  assert.equal(EXPLAINER_GUIDANCE.long, narrativeFor("explainer-long").guidance);
  // Same family, different length: that is the whole point of the split.
  assert.equal(narrativeFor("explainer-short").keouStyle, narrativeFor("explainer-long").keouStyle);
  assert.deepEqual(narrativeFor("explainer-short").sections, narrativeFor("explainer-long").sections);
  assert.notDeepEqual(narrativeFor("explainer-short").wordsPerScene, narrativeFor("explainer-long").wordsPerScene);
});

test("a Short's shape fits in a Short", () => {
  // A family whose sections need more scenes than the template's seconds can carry is a family that
  // will be silently truncated by the planner, and the truncation always eats the last section.
  for (const t of TEMPLATES) {
    const f = narrativeFor(t.id);
    const seconds = t.defaultSeconds;
    const scenes = Math.floor((seconds * 2.6) / ((f.wordsPerScene[0] + f.wordsPerScene[1]) / 2));
    assert.ok(scenes >= f.sections.length,
      `${t.id}: ${seconds}s at ${f.wordsPerScene.join("-")} words gives about ${scenes} scenes, but "${f.id}" needs ${f.sections.length}`);
  }
});

/* ------------------------------------------------------------------ the only road to the drawn look */

/**
 * The explainer is chosen BY NAME, and the twenty-seven blind prompts proved that is not a preference but
 * the only thing that works: a request with no technical vocabulary in it ("why boiling water sometimes
 * freezes before cold water") is classified as cartoon, because the drawn look is only ever reached
 * through a word list borrowed from the cyber one. Reaching it from a prompt would need a vocabulary that
 * cannot exist, since what separates it from cyber is the SHAPE of the answer — one idea taken apart
 * versus something to diagram — and the shape is not in the words of the request.
 *
 * So the template is the road, and it is the only road. That makes it the single point of failure for the
 * whole look: if the template stops resolving to it, a user who asked for the drawn Short silently gets
 * cartoon pictures, the job validates, the GPU is rented, and a video comes back in the wrong style.
 * Nothing else in the suite covers this path — the planner sweep names the style explicitly, so it tests
 * the road that is already safe.
 */
test("the explainer templates reach the drawn look on their own, with no style named and no keyword to help", async () => {
  const { planFor, pickKleoStyle } = await import("../src/storyboard.ts");
  const job = (template, format, duration_s, prompt) =>
    ({ id: "gt_test", template, prompt, params: JSON.stringify({ duration_s, format, language: "en", voice: null }) });

  // Deliberately free of anything a word list could catch: no cyber, no product, no story.
  const PLAIN = [
    "Why boiling water sometimes freezes before cold water does.",
    "Perché il pane di una volta durava una settimana.",
    "What actually happens in the first ten minutes of a cold shower.",
  ];
  for (const [template, format, dur] of [["explainer-short", "9:16", 45], ["explainer-long", "16:9", 300]]) {
    for (const prompt of PLAIN) {
      const j = job(template, format, dur, prompt);
      assert.equal(pickKleoStyle(template, prompt), "explainer",
        `${template} must be the look itself: "${prompt.slice(0, 40)}…" has nothing for a keyword to find`);
      const plan = planFor(j);
      assert.equal(plan.kleo, "explainer");
      assert.equal(plan.style, "sketch", `${template} planned ${plan.style}: the drawn engine would never be loaded`);
      assert.deepEqual(plan.brief.wordsPerScene, narrativeFor(template).wordsPerScene);
    }
  }
  // And a style the caller names still wins over the template, which is the rule everywhere else.
  const named = planFor({ ...job("explainer-short", "9:16", 45, PLAIN[0]), params: JSON.stringify({ duration_s: 45, format: "9:16", language: "en", voice: null, style: "cartoon" }) });
  assert.equal(named.kleo, "cartoon", "the caller's own choice is never overridden by the template");
});
