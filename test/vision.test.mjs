/**
 * Unit tests for src/vision.ts, the eyes of the fidelity engine (24 September 2026): reading the answer out of every
 * shape Workers AI returns, finding the JSON in it, scoring the yes/no answers (a must weighs double, a missing
 * answer fails), and judging a picture in batches of QUESTIONS_PER_CALL with a fake binding. No network.
 * Run: node --test test/vision.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerText, firstJson, scoreAnswers, judgeImage, describeImage, toBase64, mimeOf, visionModel, DEFAULT_VISION_MODEL, QUESTIONS_PER_CALL } from "../src/vision.ts";

test("answerText reads a string response, an object response, OpenAI-style choices and a nested result", () => {
  assert.equal(answerText({ response: '{"q1":"yes"}' }), '{"q1":"yes"}');
  assert.equal(answerText({ response: { q1: "yes", q2: "no" } }), '{"q1":"yes","q2":"no"}', "llama-4-scout sometimes answers the object itself");
  assert.equal(answerText({ choices: [{ message: { content: '{"q1":"no"}' } }] }), '{"q1":"no"}');
  assert.equal(answerText({ result: { response: "hello" } }), "hello");
  assert.equal(answerText(null), ""); assert.equal(answerText({ choices: [{ message: { content: "  " } }] }), "");
});

test("firstJson finds the first object through fences, prose and trailing commas; null when there is none", () => {
  assert.deepEqual(firstJson('```json\n{"q1":"yes","q2":"no",}\n```'), { q1: "yes", q2: "no" });
  assert.deepEqual(firstJson('Sure! Here it is: {"a":{"b":1}} and {"c":2}'), { a: { b: 1 } });
  assert.equal(firstJson("no json here"), null);
  assert.equal(firstJson("{broken"), null);
  assert.deepEqual(firstJson(answerText({ response: { q1: "yes" } })), { q1: "yes" }, "the object shape round-trips");
});

test("scoreAnswers: a must weighs 2, a plain check 1, a missing answer fails, expect 'no' passes on no", () => {
  const checks = [
    { id: "style", question: "photo?", expect: "yes", must: true },
    { id: "R1", question: "apron?", expect: "yes", must: true },
    { id: "no-text", question: "text?", expect: "no", must: false },
  ];
  assert.deepEqual(scoreAnswers(checks, { style: "yes", R1: "yes", "no-text": "no" }), { failed: [], score: 1, mustFailed: 0 });
  const r = scoreAnswers(checks, { style: "yes", R1: "?", "no-text": "yes" });
  assert.deepEqual(r.failed.map((c) => c.id), ["R1", "no-text"]);
  assert.equal(r.mustFailed, 1); assert.equal(r.score, 2 / 5);
  assert.equal(scoreAnswers([], {}).score, 1, "nothing to check passes");
});

test("judgeImage asks QUESTIONS_PER_CALL at a time, maps q1..qN back to the checks, and a failed call is '?' for its batch only", async () => {
  const n = QUESTIONS_PER_CALL + 1;
  const checks = Array.from({ length: n }, (_, i) => ({ id: `R${i + 1}`, question: `Is thing ${i + 1} visible?`, expect: i === 2 ? "no" : "yes", must: i < 3 }));
  const calls = [];
  const ai = { async run(model, inputs) {
    const content = inputs.messages[0].content;
    const qs = [...content[0].text.matchAll(/^(q\d+): Is thing (\d+) visible\?$/gm)];
    calls.push({ model, qs: qs.length, images: content.filter((c) => c.type === "image_url").length, max: inputs.max_tokens, temperature: inputs.temperature });
    // "no" to thing 2, "yes" to the rest: thing 2 (a must) fails, thing 3 (expect no) fails too.
    const ans = Object.fromEntries(qs.map((m) => [m[1], m[2] === "2" ? "No." : "yes"]));
    return calls.length === 1 ? { response: ans } : { choices: [{ message: { content: "```json\n" + JSON.stringify(ans) + "\n```" } }] };
  } };
  const img = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]) };
  const r = await judgeImage({ AI: ai }, img, checks, [{ label: "Mara", image: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0]) } }]);
  assert.deepEqual(calls.map((c) => c.qs), [QUESTIONS_PER_CALL, 1]);
  assert.deepEqual(calls.map((c) => c.images), [2, 2], "the picture, then the reference, in every batch");
  assert.equal(calls[0].model, DEFAULT_VISION_MODEL); assert.equal(calls[0].temperature, 0);
  assert.equal(r.answers.R2, "no"); assert.equal(r.answers.R1, "yes"); assert.equal(r.answers[`R${n}`], "yes");
  assert.deepEqual(r.failed.map((c) => c.id), ["R2", "R3"]);
  assert.equal(r.mustFailed, 2);
  // a batch whose call throws answers "?" for its own questions and nothing else
  let k = 0;
  const flaky = { async run(_m, inputs) { if (++k === 2) throw new Error("AiError: 3040: capacity"); const qs = [...inputs.messages[0].content[0].text.matchAll(/^(q\d+):/gm)]; return { response: JSON.stringify(Object.fromEntries(qs.map((m) => [m[1], "yes"]))) }; } };
  const f = await judgeImage({ AI: flaky }, img, checks.map((c) => ({ ...c, expect: "yes" })));
  assert.equal(f.answers.R1, "yes"); assert.equal(f.answers[`R${n}`], "?");
  assert.deepEqual(f.failed.map((c) => c.id), [`R${n}`]);
});

test("describeImage, base64 and mime helpers; the model is VISION_MODEL when set", async () => {
  const ai = { async run(_m, inputs) { assert.match(inputs.messages[0].content[0].text, /illustrator could draw exactly them/); return { response: "  A tall man\n with a grey beard.  " }; } };
  assert.equal(await describeImage({ AI: ai }, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]) }, "character"), "A tall man with a grey beard.");
  const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"), "chunked encoding matches the reference");
  assert.equal(mimeOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), "image/png");
  assert.equal(mimeOf(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), "image/webp");
  assert.equal(mimeOf(new Uint8Array([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(visionModel({}), DEFAULT_VISION_MODEL); assert.equal(visionModel({ VISION_MODEL: "@cf/google/gemma-4-26b" }), "@cf/google/gemma-4-26b");
  await assert.rejects(describeImage({}, { bytes }, null), /no Workers AI binding/);
});
