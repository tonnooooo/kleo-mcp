// The planner knew three things and told nobody: that its look was a bet it was not sure of, that a dearer look was
// wanted and refused, that a promised fact never made it into the narration. Each was computed and then dropped on
// the floor of planOne. These tests hold the new path: the model is ASKED whether it was sure, the answer is kept,
// and the three sentences reach the job as plan_note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { directionSchema, directionPrompt, planFor, planNoteFor } from "../src/storyboard.ts";

const job = (template = "viral-short", prompt = "Why does my sourdough smell like nail polish?") =>
  ({ id: "gt_t", template, prompt, params: JSON.stringify({ duration_s: 45, format: "9:16", language: "en", voice: null }) });

test("the direction schema demands the model say whether it was sure", () => {
  const s = directionSchema();
  assert.ok(s.required.includes("confident"), "confident is required, or a model that never says it is never asked");
  assert.deepEqual(s.properties.confident, { type: "boolean" });
});

test("the prompt explains confident where the look is chosen, and shows it in the shape line", () => {
  const text = directionPrompt(job(), planFor(job()));
  const from = text.search(/CHOOSE THE STYLE/i);
  assert.ok(from >= 0);
  const block = text.slice(from, text.indexOf("\n- ", from + 10));
  assert.match(block, /confident is your honesty/, "a field the model is not taught is a coin toss (see direction-teaches)");
  assert.match(text, /"confident":<true when/, "the shape line has to offer it, or the model does not see it as a field");
});

test("planNoteFor says the three things, in the user's terms, and nothing when there is nothing to say", () => {
  assert.equal(planNoteFor({ style: "cartoon", confident: true, blocked_upgrade: null, missing_facts: [] }), null);
  assert.equal(planNoteFor({ style: "cartoon", confident: null, blocked_upgrade: null, missing_facts: [] }), null,
    "null means the client named the look: nothing to confess");
  const unsure = planNoteFor({ style: "explainer", confident: false, blocked_upgrade: null, missing_facts: [] });
  assert.match(unsure, /"explainer" look/); assert.match(unsure, /not sure/); assert.match(unsure, /say cartoon, realistic, cyber or explainer/);
  const all = planNoteFor({ style: "cartoon", confident: false, blocked_upgrade: "Kleo would have used realistic, but it costs 3 credits.", missing_facts: ["in Naples", "5 mistakes"] });
  assert.match(all, /not sure/); assert.match(all, /would have used realistic/); assert.match(all, /never says "in Naples", "5 mistakes"/);
});
