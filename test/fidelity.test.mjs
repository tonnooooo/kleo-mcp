/**
 * The fidelity judge (src/fidelity.ts, 24 September 2026): per MUST item of the user's spec, does the planned film keep
 * it, weaken it, lose it or contradict it — the model's reading merged with the deterministic coverage check, and
 * never a thrown error. The model is a fake here: every answer shape a Workers AI or OpenRouter model returns.
 * Run: node --test test/fidelity.test.mjs   (never calls a model)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgePlan, judgePrompt, fidelityFeedback, JUDGE_SYSTEM, VERDICT_STATUSES, JUDGE_LIMITS } from "../src/fidelity.ts";
import { repairSpec, specProblems } from "../src/spec.ts";

const REQ = "Mara, una pasticcera magra con i capelli biondi corti e il grembiule lilla, prepara una torta al limone per i bambini del paese. Poi i bambini le fanno una festa a sorpresa. Il narratore dice: «la torta più buona del mondo».";
const RAW = (over = {}) => ({
  v: 1, mode: "faithful", summary: "Mara bakes a lemon cake for the village children, who then throw her a surprise party.",
  cast: [{ id: "c1", name: "Mara", look: "a thin woman with short blonde hair", ref: null }],
  items: [
    { id: "R1", kind: "character", text: "Mara, a thin pastry chef", quote: "Mara, una pasticcera magra", must: true, who: "c1", order: null },
    { id: "R2", kind: "look", text: "Mara has short blonde hair", quote: "capelli biondi corti", must: true, who: "c1", order: null },
    { id: "R3", kind: "look", text: "Mara wears a lilac apron", quote: "grembiule lilla", must: true, who: "c1", order: null },
    { id: "R4", kind: "event", text: "Mara bakes a lemon cake for the village children", quote: "prepara una torta al limone per i bambini del paese", must: true, who: "c1", order: 1 },
    { id: "R5", kind: "event", text: "the children throw Mara a surprise party", quote: "i bambini le fanno una festa a sorpresa", must: true, who: null, order: 2 },
    { id: "R6", kind: "line", text: "the narrator says 'la torta più buona del mondo'", quote: "la torta più buona del mondo", must: true, who: null, order: null },
  ],
  refs: [], open: ["the ending"], narration: "lines", script: null,
  ...over,
});
const SPEC = (over = {}) => { const s = repairSpec(RAW(over), REQ); assert.ok(s, specProblems(RAW(over), REQ).join("\n")); return s; };

/** The plan: every must item claimed in the user's order, the line said. */
const BOARD = () => ({
  direction: { cast: [{ name: "Mara", look: "a thin woman with short blonde hair and a lilac apron", id: "c1" }] },
  scenes: [
    { id: "01-oven", voice: "All'alba Mara accende il forno. Dicono: la torta più buona del mondo.", shots: [
      { image_prompt: "Mara at the oven in her kitchen, a lemon cake rising", covers: ["R1", "R3", "R4"], cast: ["c1"], action: "she opens the oven door" },
      { image_prompt: "Close on Mara's short blonde hair tied up", covers: ["R2"], cast: ["c1"] },
    ] },
    { id: "02-party", voice: "Poi i bambini arrivano con i palloncini.", shots: [{ image_prompt: "The children surprise Mara with a party", covers: ["R5"], cast: ["c1"] }] },
  ],
});

/** A fake model: answers `answer` (or throws it), and records every call. */
function fake(answer) {
  const calls = [];
  const call = async (system, user, maxTokens) => {
    calls.push({ system, user, maxTokens });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(calls.length) : answer;
  };
  return { call, calls };
}

const byId = (f) => Object.fromEntries(f.verdicts.map((v) => [v.id, v]));

/* ------------------------------------------------------------------ the words */

test("the judge is asked for strict JSON with four defined statuses, and is shown the plan shot by shot", () => {
  assert.deepEqual([...VERDICT_STATUSES], ["kept", "paraphrased", "lost", "contradicted"]);
  assert.match(JUDGE_SYSTEM, /STRICT JSON/);
  assert.ok(JUDGE_SYSTEM.includes(`{"verdicts":[{"id":"R1","status":"kept|paraphrased|lost|contradicted","shots":["01-a-s1"],"note":"…"}],"inventions":["…"]}`), "the exact shape");
  assert.match(JUDGE_SYSTEM, /"contradicted": a picture or a line shows the OPPOSITE or something incompatible — the wrong colour, the wrong person, the wrong place, the wrong number, the events in the wrong order/);
  assert.match(JUDGE_SYSTEM, /"lost": nothing in the pictures or the narration shows or says it/);
  assert.match(JUDGE_SYSTEM, /"paraphrased": it is there but weakened, generic or partial/);
  assert.match(JUDGE_SYSTEM, /not what it claims in "covers"/, "the judge reads the pictures, not the bookkeeping");
  const p = judgePrompt(SPEC(), BOARD());
  assert.match(p, /R3 \[look, MUST\] Mara wears a lilac apron \(c1\) — user: "grembiule lilla"/);
  assert.match(p, /R4 \[event #1, MUST\]/);
  assert.match(p, /LEFT TO KLEO \(additions here are allowed, not inventions\): the ending/);
  assert.match(p, /SCENE 1 \(01-oven\) voice: "All'alba Mara accende il forno/);
  assert.match(p, / {2}01-oven-s1 \| image: Mara at the oven in her kitchen, a lemon cake rising \| action: she opens the oven door \| cast: c1 \| covers: R1, R3, R4/);
  assert.match(p, / {2}02-party-s1 \| image: The children surprise Mara/);
  assert.match(p, /Mara: a thin woman with short blonde hair and a lilac apron/, "the look the plan draws with is shown");
  assert.match(p, /JUDGE THESE: R1, R2, R3, R4, R5, R6\n/);
  const soft = judgePrompt(SPEC({ items: RAW().items.map((i) => (i.id === "R2" ? { ...i, must: false } : i)) }), BOARD());
  assert.match(soft, /JUDGE THESE: R1, R3, R4, R5, R6\n/, "only the must items are judged");
});

/* ------------------------------------------------------------------ the verdicts */

test("judgePlan reads the model's verdicts, keeps only real shots, fills the skipped items from coverage, and scores", async () => {
  const { call, calls } = fake({
    verdicts: [
      { id: "R1", status: "kept", shots: ["01-oven-s1"] },
      { id: "R2", status: "paraphrased", shots: ["01-oven-s2", "99-nowhere-s1", 7], note: "only 'blonde', not short" },
      { id: "R3", status: "contradicted", shots: ["01-oven-s1"], note: "the apron is red" },
      { id: " R4 ", status: " KEPT ", shots: ["01-oven-s1"] },
      { id: "R5", status: "lost", shots: [] },
      { id: "R5", status: "kept", shots: [] },
      { id: "R99", status: "kept", shots: [] },
    ],
    inventions: ["a grandmother who is not in the request", "", 42, "x".repeat(400)],
  });
  const f = await judgePlan(SPEC(), BOARD(), call, "llama-test");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, JUDGE_SYSTEM);
  assert.equal(calls[0].user, judgePrompt(SPEC(), BOARD()));
  assert.ok(calls[0].maxTokens >= 600 && calls[0].maxTokens <= 4000, String(calls[0].maxTokens));
  assert.equal(f.judge, "llama-test");
  assert.deepEqual(f.verdicts.map((v) => v.id), ["R1", "R2", "R3", "R4", "R5", "R6"], "one verdict per must item, in the spec's order; R99 is nobody");
  const v = byId(f);
  assert.deepEqual(v.R1, { id: "R1", status: "kept", shots: ["01-oven-s1"] });
  assert.deepEqual(v.R2, { id: "R2", status: "paraphrased", shots: ["01-oven-s2"], note: "only 'blonde', not short" }, "a shot that does not exist is dropped");
  assert.deepEqual(v.R3, { id: "R3", status: "contradicted", shots: ["01-oven-s1"], note: "the apron is red" });
  assert.equal(v.R4.status, "kept", "status and id are read trimmed and case-folded");
  assert.equal(v.R5.status, "lost", "the first verdict for an id counts");
  assert.deepEqual(v.R6, { id: "R6", status: "kept", shots: [] }, "an item the model skipped gets the deterministic verdict: the line is said");
  assert.deepEqual(f.inventions, ["a grandmother who is not in the request", "x".repeat(JUDGE_LIMITS.invention)]);
  // (kept 3 + half of 1 paraphrased) over 6 must items.
  assert.equal(f.score, Math.round((3.5 / 6) * 1000) / 1000);
  assert.deepEqual(f.coverage.uncovered, []);
});

test("where the deterministic check is certain, it overrules the model: the user's order, the user's words", async () => {
  // The party is drawn before the cake: whatever the model says about R5, it is contradicted.
  const swapped = BOARD();
  swapped.scenes[0].shots[0].covers = ["R1", "R3", "R5"];
  swapped.scenes[1].shots[0].covers = ["R4"];
  const all = (status) => ({ verdicts: ["R1", "R2", "R3", "R4", "R5", "R6"].map((id) => ({ id, status, shots: [] })), inventions: [] });
  const f = await judgePlan(SPEC(), swapped, fake(all("kept")).call, "m");
  const r5 = byId(f).R5;
  assert.equal(r5.status, "contradicted");
  assert.match(r5.note, /^shown out of the user's order/);
  assert.deepEqual(r5.shots, ["01-oven-s1"], "the shot that shows it too early");
  assert.equal(byId(f).R4.status, "kept");
  // The narrator never says the user's line: a model that calls it "kept" is corrected to "paraphrased".
  const mute = BOARD(); mute.scenes[0].voice = "All'alba Mara accende il forno.";
  const g = await judgePlan(SPEC(), mute, fake(all("kept")).call, "m");
  assert.equal(byId(g).R6.status, "paraphrased");
  assert.match(byId(g).R6.note, /^the narration does not say the user's words/);
  // The model saying lost or contradicted is kept: the semantic half sees what a "covers" claim cannot.
  const h = await judgePlan(SPEC(), BOARD(), fake(all("lost")).call, "m");
  assert.ok(h.verdicts.every((x) => x.status === "lost"));
  assert.equal(h.score, 0);
});

test("judgePlan never throws: a failing, silent or senseless model leaves the deterministic verdicts", async () => {
  const lost = BOARD(); lost.scenes[1].shots[0].covers = [];
  for (const answer of [new Error("503 capacity"), null, undefined, "I think the plan is fine.", 42, { verdicts: "all good" }, { verdicts: [{ id: "R99", status: "kept" }] }, { verdicts: [{ id: "R1", status: "maybe" }] }]) {
    const f = await judgePlan(SPEC(), lost, fake(answer).call, "m");
    assert.equal(f.judge, "deterministic", String(answer));
    assert.deepEqual(byId(f).R5, { id: "R5", status: "lost", shots: [], note: "no shot claims it" });
    assert.equal(byId(f).R4.status, "kept");
    assert.deepEqual(byId(f).R4.shots, ["01-oven-s1"], "the deterministic answer to where: the shots that claim it");
    assert.equal(f.score, Math.round((5 / 6) * 1000) / 1000);
    assert.deepEqual(f.inventions, []);
  }
  // The deterministic half alone still says what it is sure of.
  const swapped = BOARD(); swapped.scenes[0].shots[0].covers = ["R1", "R3", "R5"]; swapped.scenes[1].shots[0].covers = ["R4"];
  assert.equal(byId(await judgePlan(SPEC(), swapped, fake(new Error("x")).call, "m")).R5.status, "contradicted");
  const mute = BOARD(); mute.scenes[0].voice = "Mara accende il forno.";
  assert.deepEqual(byId(await judgePlan(SPEC(), mute, fake(null).call, "m")).R6, { id: "R6", status: "lost", shots: [], note: "the narration never says it" });
  // Garbage storyboards are not a crash either.
  const none = await judgePlan(SPEC(), null, fake(new Error("x")).call, "m");
  assert.ok(none.verdicts.every((x) => x.status === "lost"));
  assert.equal(none.score, 0);
});

test("the answer is read in every shape a model returns: an object, a JSON string in fences, a Workers AI envelope", async () => {
  const obj = { verdicts: [{ id: "R1", status: "lost", shots: [] }], inventions: ["a dog"] };
  const shapes = [
    "```json\n" + JSON.stringify(obj) + "\n```",
    `Here is my verdict: ${JSON.stringify(obj)} — hope it helps`,
    { response: obj },
    { response: JSON.stringify(obj) },
    { choices: [{ message: { content: JSON.stringify(obj) } }] },
  ];
  for (const shape of shapes) {
    const f = await judgePlan(SPEC(), BOARD(), fake(shape).call, "m");
    assert.equal(f.judge, "m", JSON.stringify(shape));
    assert.equal(byId(f).R1.status, "lost");
    assert.equal(byId(f).R2.status, "kept", "the rest from coverage");
    assert.deepEqual(f.inventions, ["a dog"]);
  }
});

test("a spec with no must item is kept whole without asking anyone", async () => {
  const { call, calls } = fake(new Error("must not be called"));
  const f = await judgePlan(SPEC({ items: RAW().items.map((i) => ({ ...i, must: false })) }), BOARD(), call, "m");
  assert.equal(calls.length, 0);
  assert.deepEqual(f.verdicts, []);
  assert.equal(f.score, 1);
  assert.equal(f.judge, "deterministic");
});

/* ------------------------------------------------------------------ the repair round */

test("fidelityFeedback: one sentence per item to fix and per invention, nothing for what is kept", async () => {
  const spec = SPEC();
  const f = await judgePlan(spec, BOARD(), fake({
    verdicts: [
      { id: "R1", status: "kept", shots: ["01-oven-s1"] },
      { id: "R2", status: "paraphrased", shots: ["01-oven-s2"], note: "only 'blonde', not short" },
      { id: "R3", status: "contradicted", shots: ["01-oven-s1"], note: "the apron is red" },
      { id: "R4", status: "contradicted", shots: ["02-party-s1"] },
      { id: "R5", status: "lost", shots: [] },
      { id: "R6", status: "lost", shots: [] },
    ],
    inventions: ["a grandmother"],
  }).call, "m");
  const fb = fidelityFeedback(f, spec);
  assert.equal(fb.length, 6, fb.join("\n"));
  assert.ok(!fb.some((s) => s.startsWith("R1 ")), "a kept item says nothing");
  assert.equal(fb[0], `R2 (look) "Mara has short blonde hair" — user: "capelli biondi corti" is only weakly there (shot 01-oven-s2): only 'blonde', not short — make it specific, exactly as the user described it (every attribute, in the image_prompt)`);
  assert.equal(fb[1], `R3 (look) "Mara wears a lilac apron" — user: "grembiule lilla" is CONTRADICTED (shot 01-oven-s1): the apron is red — the plan shows or says something else; change it so it is exactly what the user asked for`);
  assert.match(fb[2], /^R4 \(event\) .* is CONTRADICTED \(shot 02-party-s1\) — .*, in the user's order of events$/);
  assert.match(fb[3], /^R5 \(event\) .* is missing — show it: write it into the image_prompt of the shot where it happens and list "R5" in that shot's "covers"$/);
  assert.match(fb[4], /^R6 \(line\) .* is missing — the narrator must say it: put the user's words in a scene's "voice"$/);
  assert.equal(fb[5], "Not asked for: a grandmother — remove it, unless it is one of the things the user left to Kleo (the ending)");
});

test("fidelityFeedback adds the deterministic problems no verdict already sends back", async () => {
  const spec = SPEC();
  const odd = BOARD();
  odd.scenes[1].shots[0].covers = ["R99"];          // R5 now unclaimed, and an id that names nothing
  odd.scenes[0].shots[1].covers = [];               // R2 unclaimed too, but the model sees the hair in the picture
  const f = await judgePlan(spec, odd, fake({ verdicts: [{ id: "R2", status: "kept", shots: ["01-oven-s2"] }], inventions: [] }).call, "m");
  assert.equal(byId(f).R2.status, "kept", "the picture shows it, whatever covers says");
  assert.equal(byId(f).R5.status, "lost", "skipped by the model: coverage says nobody shows it");
  const fb = fidelityFeedback(f, spec);
  assert.equal(fb.filter((s) => /^R5 /.test(s)).length, 1, `R5 is sent back once, not twice:\n${fb.join("\n")}`);
  assert.ok(fb.some((s) => /^R2 \(look\): no shot shows "Mara has short blonde hair".*list "R2" in its "covers"$/.test(s)), `the missing claim is still asked for, because the stills engine reads it:\n${fb.join("\n")}`);
  assert.ok(fb.some((s) => /^"covers" names "R99"/.test(s)), fb.join("\n"));
  assert.deepEqual(fidelityFeedback({ verdicts: [], inventions: [], score: 1, judge: "deterministic", coverage: { uncovered: [], outOfOrder: [], unknownIds: [], unknownCast: [], problems: [] } }, spec), []);
});
