/**
 * A CHOICE THE MODEL IS OFFERED BUT NEVER TAUGHT IS A CHOICE IT WILL NEVER MAKE.
 *
 * Step zero of the planner asks a model to read the request and pick the look. The JSON schema it decodes
 * into has always allowed every Kleo style — the grammar was open. The prompt text listed four of the five
 * and said nothing about the drawn explainer, so for weeks the model could not choose a thing it was never
 * told existed, and every measurement of "can Kleo pick the right look" was really a measurement of the
 * keyword fallback underneath it.
 *
 * Nothing caught that, because the schema and the prose that explains the schema are two different strings
 * and no test compared them. This is that comparison, and it generalises: every value a model is offered
 * in an enum has to appear in the words it is given, or the option is decoration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { directionPrompt, directionSchema, planFor } from "../src/storyboard.ts";
import { KLEO_STYLES } from "../src/keou-contract.ts";

const job = (prompt = "How a hotel key card can be forged in thirty seconds.", template = "viral-short") =>
  ({ id: "gt_t", template, prompt, params: JSON.stringify({ duration_s: 45, format: "9:16", language: "en", voice: null }) });

/** Every enum the direction schema offers the model, by JSON path. */
function enums(node, path = "", out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node.enum)) out.push({ path, values: node.enum });
  for (const [k, v] of Object.entries(node.properties ?? {})) enums(v, `${path}.${k}`, out);
  if (node.items) enums(node.items, `${path}[]`, out);
  return out;
}

/**
 * The section where the look is actually chosen, not the whole prompt. The first version of this test
 * looked for the style name ANYWHERE in the text and passed on a prompt that never taught the explainer,
 * because the word appears in a template id elsewhere. A test that passes on the defect it was written for
 * is worse than no test, so it is anchored here.
 */
function choiceBlock(text) {
  const from = text.search(/CHOOSE THE STYLE/i);
  assert.ok(from >= 0, "the direction prompt must have a section that chooses the style");
  const rest = text.slice(from);
  const to = rest.indexOf("\n- ", 10);
  return to > 0 ? rest.slice(0, to) : rest;
}

test("every look the direction schema allows is explained where the look is chosen", () => {
  const text = directionPrompt(job(), planFor(job()));
  const block = choiceBlock(text);
  const line = /\{"style":"([^"]+)"/.exec(text)?.[1] ?? "";
  for (const style of KLEO_STYLES) {
    assert.ok(line.split("|").includes(style),
      `the shape line shows "${line}" — "${style}" is decodable but not offered there, so the model does not see it as an option`);
    assert.ok(block.includes(style),
      `"${style}" is never named where the prompt chooses the look: the model cannot choose what it was not told exists`);
    const at = block.indexOf(style);
    const described = block.slice(at + style.length, at + style.length + 90);
    assert.ok(/[a-z]{4,}[\s\S]{20,}/.test(described),
      `"${style}" is listed but not described — naming a look without saying when to choose it is a coin toss`);
  }
});

test("the boundary that cannot be guessed from the topic is spelled out", () => {
  // Twenty-seven prompts written blind proved that cyber and explainer cannot be told apart by subject:
  // the same words, opposite right answers. The only thing that separates them is the shape of the answer,
  // so the prompt has to say that, in those terms, or the model falls back to matching the topic.
  const text = directionPrompt(job(), planFor(job()));
  assert.match(text, /shape of the answer/i, "the discriminator has to be named as the shape of the answer");
  assert.match(text, /never by its topic|not by (its )?topic/i, "and the topic has to be ruled out explicitly");
  const cyberAt = text.search(/cyber/i), explAt = text.search(/explainer/i);
  assert.ok(cyberAt > 0 && explAt > 0, "both sides of the boundary must appear");
  assert.ok(Math.abs(cyberAt - explAt) < 1200, "they must be described together, where the choice is actually made");
});

test("no enum anywhere in the direction schema is offered without being mentioned", () => {
  // The general form of the same defect, over every choice the model is handed at once.
  const text = directionPrompt(job(), planFor(job())).toLowerCase();
  const unmentioned = [];
  for (const { path, values } of enums(directionSchema())) {
    for (const v of values) {
      if (typeof v !== "string" || v.length < 3) continue;
      if (!text.includes(v.toLowerCase())) unmentioned.push(`${path || "(root)"} = "${v}"`);
    }
  }
  assert.deepEqual(unmentioned, [],
    "these values are decodable but never mentioned in the prompt, so the model will not produce them");
});
