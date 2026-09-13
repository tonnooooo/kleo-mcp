import test from "node:test";
import assert from "node:assert/strict";
import { adaptPrompt } from "../src/adaptive.ts";

test("adaptive planning asks only for missing production facts", () => {
  const brief = adaptPrompt("Creami un video realistico su una corsa automobilistica");
  assert.equal(brief.format, "16:9");
  assert.equal(brief.duration_s, null);
  assert.equal(brief.language, "it");
  assert.equal(brief.questions.length, 1);
  assert.match(brief.questions[0], /durare/i);
});

test("adaptive planning preserves an explicit film brief", () => {
  const brief = adaptPrompt("Create a realistic film about a night race, 2 minutes, YouTube landscape", {
    duration_s: 120,
    format: "16:9",
  });
  assert.equal(brief.duration_s, 120);
  assert.equal(brief.format, "16:9");
  assert.equal(brief.questions.length, 0);
  assert.ok(brief.assumptions.some((value) => /no music/i.test(value)));
});

test("portrait is selected only when the request says so", () => {
  assert.equal(adaptPrompt("A realistic vertical Short about rain", { duration_s: 30 }).format, "9:16");
});
