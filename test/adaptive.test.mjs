import test from "node:test";
import assert from "node:assert/strict";
import { adaptPrompt, adaptivePromptText, intakeText, INTAKE, REQUIRED_INTAKE } from "../src/adaptive.ts";

test("the intake is a fixed list: four things Kleo refuses to guess, three it offers to ask (14 September)", () => {
  assert.deepEqual(INTAKE.map((i) => i.key), ["subject", "duration", "format", "look", "audience", "tone", "must_keep"]);
  assert.deepEqual([...REQUIRED_INTAKE], ["subject", "duration", "format", "look"]);
  for (const i of INTAKE) { assert.ok(i.question.it.includes("?"), `${i.key}: the Italian question is a question`); assert.ok(i.question.en.includes("?"), `${i.key}: the English question is a question`); }
});

test("what the request says is read, what it does not say is asked — in the request's language, required first", () => {
  const brief = adaptPrompt("Creami un video realistico su una corsa automobilistica");
  assert.equal(brief.language, "it");
  assert.equal(brief.look, "realistic", "'realistico' names the look");
  assert.equal(brief.duration_s, null); assert.equal(brief.format, null, "nothing says where it goes: asked, not assumed 16:9");
  assert.deepEqual(brief.intake.missing, ["duration", "format"]);
  assert.deepEqual(brief.intake.optional, ["audience", "tone", "must_keep"]);
  assert.deepEqual(brief.questions, ["Quanto deve durare? (da 15 secondi a 5 minuti)", "Per dove è: YouTube (orizzontale, 16:9) o Short / TikTok / Reel (verticale, 9:16)?"]);
  assert.equal(brief.optional_questions.length, 3); assert.match(brief.optional_questions[0], /Per chi è\?/);
  const text = adaptivePromptText(brief);
  assert.match(text, /- Length: MISSING — ask/); assert.match(text, /- Look: realistic \(from the request\)/);
  assert.match(text, /ASK THE USER NOW, in ONE message, in Italian/); assert.match(text, /1\. Quanto deve durare/); assert.match(text, /2\. Per dove è/);
  assert.match(text, /Optional, in the SAME message/);
});

test("a complete request asks nothing, and the answers passed on the call count as the user's", () => {
  const said = adaptPrompt("Create a realistic film about a night race, 2 minutes, YouTube landscape");
  assert.equal(said.duration_s, 120); assert.equal(said.format, "16:9"); assert.equal(said.look, "realistic");
  assert.deepEqual(said.questions, []); assert.deepEqual(said.intake.missing, []);
  assert.equal(said.intake.answered.duration.from, "request"); assert.equal(said.intake.answered.format.from, "request");
  const answered = adaptPrompt("A film about a night race", { duration_s: 120, format: "16:9", look: "animation", audience: "kids", tone: "warm", must_keep: "the number 7" });
  assert.deepEqual(answered.questions, []); assert.deepEqual(answered.optional_questions, []);
  assert.equal(answered.intake.answered.look.from, "call"); assert.equal(answered.intake.answered.must_keep.value, "the number 7");
  assert.match(adaptivePromptText(answered), /Adaptive film brief ready/); assert.match(adaptivePromptText(answered), /- Must appear: the number 7/);
  assert.ok(answered.assumptions.some((value) => /no music/i.test(value)));
  assert.match(intakeText(answered), /- Look: animation \(the user's answer\)/);
});

test("the language is read from the words only one language owns: 'video' decides nothing", () => {
  assert.equal(adaptPrompt("Create a video about accuracy in medicine").language, "en");
  assert.equal(adaptPrompt("A film about a night race, 2 minutes").language, "en");
  assert.equal(adaptPrompt("Fammi un video sui pirati, 30 secondi").language, "it");
  assert.equal(adaptPrompt("Un documentario sulla laguna di Venezia").language, "it");
});

test("the frame and the look are read only from words that say them", () => {
  assert.equal(adaptPrompt("A realistic vertical Short about rain", { duration_s: 30 }).format, "9:16");
  assert.equal(adaptPrompt("Un video per YouTube sui pirati").format, "16:9");
  assert.equal(adaptPrompt("Un reel sui pirati").format, "9:16");
  assert.equal(adaptPrompt("Un video sui pirati").format, null);
  assert.equal(adaptPrompt("Un cartone animato sui pirati").look, "animation");
  assert.equal(adaptPrompt("Un documentario sui pirati").look, "realistic");
  assert.equal(adaptPrompt("Un video sui pirati").look, null);
  assert.ok(adaptPrompt("Un video sui pirati").questions.some((q) => /Come lo vuoi: realistico/.test(q)));
});
