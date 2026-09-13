/**
 * The treatment (src/treatment.ts) and its place in the planner (src/storyboard.ts step -1).
 * Run: node --test test/treatment.test.mjs   (never calls Workers AI)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  T, DEVICES, DEVICE_IDS, OPENING_IDS, MASTER_PROMPT, variationFor, treatmentPrompt, treatmentSchema,
  repairTreatment, treatmentProblems, treatmentOf, treatmentBlock, treatmentText, wordCount, languageOf,
} from "../src/treatment.ts";
import { generateStoryboard, TREATMENT_TEMPERATURE, writeTreatment, callModel } from "../src/storyboard.ts";
import { validateStoryboard } from "../src/keou-contract.ts";
import { ACTIVE_TEMPLATE, PUBLIC_TEMPLATES, filmTemplateFor, isPublicTemplate } from "../src/templates.ts";
import { TREATMENT_FIXTURE } from "./fixtures/treatment.mjs";

const v = variationFor("gt_test0001");

/* ------------------------------------------------------------------ the draw */

test("the draw is deterministic for a job and spreads across jobs", () => {
  assert.deepEqual(variationFor("gt_abc"), variationFor("gt_abc"));
  assert.equal(v.key, `${v.device}/${v.opening}`);
  const seeds = Array.from({ length: 60 }, (_, i) => `gt_${i.toString(36).padStart(8, "x")}`);
  const devices = new Set(seeds.map((s) => variationFor(s).device));
  const openings = new Set(seeds.map((s) => variationFor(s).opening));
  assert.ok(devices.size >= 6, `sixty jobs reach at least six of the ${DEVICE_IDS.length} devices, got ${devices.size}`);
  assert.ok(openings.size >= 4, `and at least four of the ${OPENING_IDS.length} openings, got ${openings.size}`);
  for (const s of seeds) assert.ok(DEVICE_IDS.includes(variationFor(s).device) && OPENING_IDS.includes(variationFor(s).opening));
});

/* ------------------------------------------------------------------ the words */

test("the master prompt is a method for a film Kleo can render, and the user message carries the request and the draw", () => {
  assert.match(MASTER_PROMPT, /NO music/i);
  assert.match(MASTER_PROMPT, /NO on-screen text/i);
  assert.match(MASTER_PROMPT, /never a named living person/i);
  for (const n of [1, 5, 10]) assert.match(MASTER_PROMPT, new RegExp(`^${n}\\. [A-Z]`, "m"), `step ${n} of the method is numbered`);
  assert.match(MASTER_PROMPT, /BANNED WORDS/);
  assert.match(MASTER_PROMPT, /Nothing else is invented: no statistics/);
  const p = treatmentPrompt({ prompt: "Crea un video sulla precisione delle diagnosi mediche", duration_s: 90, format: "16:9", language: "it" }, v);
  assert.match(p, /precisione delle diagnosi mediche/);
  assert.match(p, /90 seconds, narrated in Italian/);
  assert.match(p, /LANGUAGE OF THIS TREATMENT: ITALIAN/, "an Italian film is told its language up front, not only in the master prompt");
  assert.match(p, /Everything in Italian\.$/);
  assert.ok(!/LANGUAGE OF THIS TREATMENT/.test(treatmentPrompt({ prompt: "x y z", duration_s: 30, format: "9:16", language: "en" }, v)));
  assert.match(p, new RegExp(`narrative device: ${v.device} — ${DEVICES[v.device].slice(0, 20)}`));
  assert.match(p, /TASK: write the TREATMENT/);
  assert.match(p, new RegExp(`"device":"${v.device}"`));
  assert.match(p, /add up to 90/);
  assert.ok(!/REJECTED/.test(p));
  const again = treatmentPrompt({ prompt: "x y z", duration_s: 30, format: "9:16", language: "en" }, v, ["prose: 12 words, it needs at least 100"]);
  assert.match(again, /a vertical Short \(9:16\)/);
  assert.match(again, /REJECTED[\s\S]*prose: 12 words/);
  const schema = treatmentSchema();
  assert.deepEqual(schema.properties.device.enum, [...DEVICE_IDS]);
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes("prose") && schema.required.includes("acts"));
});

/* ------------------------------------------------------------------ repair and check */

test("a good treatment is fitted: acts rescaled to the film, names uppercase, lists clipped, prose bounded", () => {
  const raw = TREATMENT_FIXTURE(60);
  raw.acts = raw.acts.map((a) => ({ ...a, name: a.name.toLowerCase(), seconds: a.seconds * 2 })); // right proportions, wrong sum
  raw.motifs = [...raw.motifs, "four", "five", "six", "seven"];
  raw.prose = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" "); // a little over the limit: fitted, not refused
  const t = repairTreatment(raw, 60, v);
  assert.ok(t, `accepted: ${treatmentProblems(raw, 60).join("; ")}`);
  assert.ok(treatmentProblems({ ...raw, prose: Array.from({ length: 900 }, (_, i) => `w${i}`).join(" ") }, 60).some((m) => /^prose: 900 words, the limit is/.test(m)), "far over it is refused and sent back");
  assert.equal(t.acts.reduce((n, a) => n + a.seconds, 0), 60, "the acts add up to the film's length");
  assert.ok(t.acts.every((a) => a.name === a.name.toUpperCase()));
  assert.equal(t.motifs.length, T.motifs.max);
  assert.ok(wordCount(t.prose) <= T.prose.maxWords);
  assert.equal(t.device, "cold-open-mystery");
  assert.equal(t.variation, v.key, "a treatment written by the planner records its own draw");
});

test("what is not a treatment is refused in words, and the words name the field", () => {
  assert.deepEqual(treatmentProblems(TREATMENT_FIXTURE(45), 45), []);
  const bad = { ...TREATMENT_FIXTURE(45), logline: "short", acts: [{ name: "ONE", purpose: "x", seconds: 0 }], motifs: ["one"], prose: "twelve words are not a treatment, they are a caption, and Kleo says so." };
  const p = treatmentProblems(bad, 45);
  assert.ok(p.some((m) => /^logline:/.test(m)), p.join("; "));
  assert.ok(p.some((m) => /^acts: 1, it needs 2-7/.test(m)));
  assert.ok(p.some((m) => /act 1: needs a purpose/.test(m)));
  assert.ok(p.some((m) => /act 1: needs seconds/.test(m)));
  assert.ok(p.some((m) => /^motifs: 1/.test(m)));
  assert.ok(p.some((m) => /^prose: \d+ words, it needs at least 140/.test(m)));
  assert.equal(repairTreatment(bad, 45, v), null);
  assert.deepEqual(treatmentProblems("nope"), ["the treatment must be a JSON object"]);
  // A wrong device is a problem for a client (it is told), and falls back to the draw once the rest is fine.
  const wrongDevice = { ...TREATMENT_FIXTURE(45), device: "the-musical" };
  assert.ok(treatmentProblems(wrongDevice, 45).some((m) => /^device: "the-musical"/.test(m)));
  // Acts that add up to a different film are refused, not rescaled: the author chose those seconds for this length.
  const wrongSum = { ...TREATMENT_FIXTURE(45), acts: [{ name: "A", purpose: "the viewer learns a thing", seconds: 300 }, { name: "B", purpose: "the viewer learns another", seconds: 300 }] };
  assert.ok(treatmentProblems(wrongSum, 45).some((m) => /^acts: their seconds add up to 600, the film is 45/.test(m)));
});

test("the defects the production model really has are sent back in words: angle = logline, function names, the device said out loud, the wrong language", () => {
  const good = TREATMENT_FIXTURE(45);
  assert.deepEqual(treatmentProblems(good, 45, "en"), []);
  // 1. The angle restates the logline (measured: three out of three on the relay request).
  const restated = { ...good, logline: "A relay attack steals a keyless car in under a minute, but a cheap fix can prevent it", angle: "A relay attack can steal a keyless car in under a minute, but there is a cheap fix" };
  assert.ok(treatmentProblems(restated, 45).some((m) => /^angle: it restates the logline/.test(m)));
  // 2. Acts named for their function (measured: INTRO, SETUP, CONCLUSION, RESOLUTION, THE_CHALLENGE, INTRO 3 s).
  for (const name of ["INTRO", "Setup", "THE CONCLUSION", "THE_CHALLENGE", "RESOLUTION", "PART 2", "Introduzione"]) {
    const acts = [{ ...good.acts[0], name }, ...good.acts.slice(1)];
    assert.ok(treatmentProblems({ ...good, acts }, 45).some((m) => new RegExp(`^act 1: "${name}" is a function, not a name`).test(m)), name);
  }
  assert.deepEqual(treatmentProblems({ ...good, acts: [{ ...good.acts[0], name: "THE SECOND READING" }, ...good.acts.slice(1)] }, 45), []);
  // 3. The device named out loud ("A witness explains why bread rises").
  const told = { ...good, device: "the-witness", logline: "A witness explains why bread rises in a small bakery before dawn." };
  assert.ok(treatmentProblems(told, 45).some((m) => /names the narrative device \("witness"\)/.test(m)));
  assert.deepEqual(treatmentProblems({ ...good, device: "the-witness" }, 45), [], "the same device, unnamed, is fine");
  // 4. An Italian film treated in English (measured: five out of six Italian requests).
  assert.ok(treatmentProblems(good, 45, "it").some((m) => /^language: the treatment is written in English, the film is in Italian/.test(m)));
  const italian = { ...good, logline: "Una nave pirata trova un'isola che non è su nessuna mappa e il suo capitano decide di non segnarla.", angle: "Un'isola che non esiste sulle mappe vale più di una che c'è: la storia di chi sceglie di tacere.",
    prose: Array.from({ length: 12 }, (_, i) => `Frase ${i + 1}: la nave scivola nella nebbia mentre il capitano guarda la costa che non dovrebbe esserci, e nessuno della ciurma parla. `).join("") };
  assert.deepEqual(treatmentProblems(italian, 45, "it"), []);
  assert.equal(languageOf(italian.prose), "it"); assert.equal(languageOf(good.prose), "en"); assert.equal(languageOf("ok"), null);
  assert.ok(repairTreatment(italian, 45, v, "it"));
  assert.equal(repairTreatment(good, 45, v, "it"), null, "and the repair refuses what the check refuses");
});

test("treatmentOf reads a treatment back from params or a storyboard, and nothing from anything else", () => {
  const t = treatmentOf({ treatment: TREATMENT_FIXTURE(30) });
  assert.ok(t); assert.equal(t.acts.reduce((n, a) => n + a.seconds, 0), 30);
  assert.equal(treatmentOf({}), null);
  assert.equal(treatmentOf({ treatment: { logline: "x" } }), null);
  assert.equal(treatmentOf(null), null);
});

test("the block the stages read carries the acts, and the prose only when asked for", () => {
  const t = repairTreatment(TREATMENT_FIXTURE(45), 45, v);
  const short = treatmentBlock(t), full = treatmentBlock(t, true);
  assert.match(short, /^TREATMENT OF THIS FILM/);
  assert.match(short, /1\. THE EMPTY DRIVEWAY · \d+s — The viewer feels the loss/);
  assert.match(short, /Acts \(45s in all\)/);
  assert.ok(!/Paragraph 1:/.test(short), "the scene chunks do not get four hundred words of prose");
  assert.match(full, /The treatment, in prose:\nParagraph 1:/);
  const text = treatmentText(t);
  assert.match(text, /Logline: A stolen car/);
  assert.match(text, /Kleo decided on its own[\s\S]*- Set in an ordinary suburb/);
  assert.match(text, /pass the whole object as "treatment" to kleo_create_video/);
});

/* ------------------------------------------------------------------ in the planner */

const job = (prompt, params = {}) => ({ id: "gt_plantest", template: "film", prompt, params: JSON.stringify({ duration_s: 45, format: "9:16", language: "en", voice: null, style: "realistic", ...params }) });

/** A fake model that answers every stage well enough for a valid realistic film, and records what it was asked. */
function planner(opts = {}) {
  const calls = [];
  const env = {
    INTERNAL_SECRET: "x",
    AI: { async run(model, inputs) {
      const user = inputs.messages.at(-1).content, system = inputs.messages[0].content;
      const kind = /TASK: write the TREATMENT/.test(user) ? "treatment" : /TASK: write the DIRECTION/.test(user) ? "direction" : /TASK: plan the whole video/.test(user) ? "outline" : "chunk";
      calls.push({ kind, user, system, temperature: inputs.temperature, model });
      let out;
      if (kind === "treatment") out = opts.treatment ? opts.treatment(calls.filter((c) => c.kind === "treatment").length) : TREATMENT_FIXTURE(45);
      else if (kind === "direction") {
        const n = (user.match(/^ {2}\d+\. /gm) || []).length || 3;
        out = { direction: { subject: "A relay car theft", goal: "The viewer keeps their key in a pouch", audience: "Car owners", tone: "Calm and factual", must_keep: [],
          world: "A wet suburban street at dawn, cold blue outside and warm light inside", cast: [], objects: ["car", "key", "driveway", "pouch", "window"], forbidden: ["text in the picture", "logo", "real person", "wifi symbol"],
          sections: Array.from({ length: n }, (_, i) => ({ name: `0${i + 1} PART`, means: "a part of the story" })) } };
      } else if (kind === "outline") {
        const n = Number(/exactly (\d+) scenes/.exec(user)[1]);
        out = { title: "The forty seconds", description: "desc", tags: ["cars"], scenes: Array.from({ length: n }, (_, i) => ({ id: `${String(i + 1).padStart(2, "0")}-part`, kind: i === n - 1 ? "closing" : "cinema", label: `0${i + 1} PART`, accent: "cyan", summary: `part ${i + 1}`, words: 16 })) };
      } else {
        const m = /write scenes (\d+)–(\d+)/.exec(user); const from = Number(m[1]) - 1, to = Number(m[2]);
        const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
        out = { scenes: Array.from({ length: to - from }, (_, k) => { const i = from + k, closing = i === total - 1; return {
          id: `${String(i + 1).padStart(2, "0")}-part`, kind: closing ? "closing" : "cinema", chapter: `0${i + 1} PART`, accent: "cyan", title: `Part ${i + 1}`, hl: "Part",
          voice: `Scene ${i + 1} holds on the driveway and then on the window while the narrator says one plain thing.`,
          shots: closing ? [{ image_prompt: "The driveway at dusk, the car back, mist drifting across the tarmac" }]
            : [{ image_prompt: `An empty driveway at dawn, tyre marks glistening on wet tarmac, scene ${i + 1}` }, { image_prompt: "One kitchen window lit, curtains stirring in the draught", at: "on the window" }],
          ...(closing ? { button: "Follow" } : {}) }; }) };
      }
      return { response: out, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    } },
  };
  return { env, calls };
}

test("the treatment is written first, hot, under the master prompt; the direction and the scenes are written under it; the storyboard carries it", async () => {
  const { env, calls } = planner();
  const r = await generateStoryboard(env, job("A Short about relay car theft"));
  assert.equal(calls[0].kind, "treatment", "step -1 comes before the direction");
  assert.equal(calls[0].system, MASTER_PROMPT);
  assert.equal(calls[0].temperature, TREATMENT_TEMPERATURE);
  assert.equal(calls[1].kind, "direction");
  assert.equal(calls[1].temperature, 0.3, "everything after the treatment stays a document");
  assert.match(calls[1].user, /TREATMENT OF THIS FILM[\s\S]*Logline: A stolen car/);
  assert.match(calls[1].user, /The treatment, in prose:/, "the direction reads the prose");
  assert.match(calls[1].user, /The direction is written UNDER this treatment/);
  const outline = calls.find((c) => c.kind === "outline");
  assert.match(outline.user, /The treatment, in prose:/, "so does the outline");
  assert.match(outline.user, /The outline follows the treatment's acts/);
  const chunk = calls.find((c) => c.kind === "chunk");
  assert.match(chunk.user, /TREATMENT OF THIS FILM[\s\S]*Motifs \(return to these\)/);
  assert.ok(!/The treatment, in prose:/.test(chunk.user), "the scene chunks get the block without the prose");
  assert.ok(r.treatment, "the result reports the treatment");
  assert.equal(r.treatment.variation, variationFor("gt_plantest").key, "the draw is the job's own");
  assert.equal(r.storyboard.treatment.logline, r.treatment.logline, "the storyboard carries it, like the direction");
  assert.ok(validateStoryboard(r.storyboard, { format: "9:16", language: "en" }).ok, "and stays a valid storyboard with it on");
});

test("a treatment that never comes is not a failed film: two rejected answers, then the planner carries on without one", async () => {
  const { env, calls } = planner({ treatment: (n) => (n === 1 ? { logline: "too short to be one" } : "not even json") });
  const r = await generateStoryboard(env, job("A Short about relay car theft"));
  assert.equal(calls.filter((c) => c.kind === "treatment").length, 2, "two attempts, no more");
  assert.match(calls.filter((c) => c.kind === "treatment")[1].user, /REJECTED[\s\S]*prose:/, "the second attempt is told what was wrong");
  assert.equal(r.treatment, null);
  assert.ok(!("treatment" in r.storyboard));
  assert.ok(r.history.some((h) => h.some((m) => /^treatment: rejected/.test(m))));
  assert.ok(!/TREATMENT OF THIS FILM/.test(calls.find((c) => c.kind === "direction").user));
  assert.ok(validateStoryboard(r.storyboard, { format: "9:16", language: "en" }).ok);
});

test("a quota error on the treatment call is the planner's quota error: the job waits, it does not lose its treatment quietly", async () => {
  const { env } = planner({ treatment: () => { throw new Error("429 4006 you have used up your daily free allocation"); } });
  await assert.rejects(generateStoryboard(env, job("A Short about relay car theft")), /4006/);
});

test("a treatment handed in through params is planned under as it is, and the model is never asked for one", async () => {
  const given = TREATMENT_FIXTURE(45);
  given.logline = "The film the user already read about and approved.";
  const { env, calls } = planner({ treatment: () => { throw new Error("must not be called"); } });
  const r = await generateStoryboard(env, job("A Short about relay car theft", { treatment: given }));
  assert.equal(calls.filter((c) => c.kind === "treatment").length, 0);
  assert.equal(r.treatment.logline, given.logline);
  assert.match(calls.find((c) => c.kind === "direction").user, /Logline: The film the user already read about/);
  assert.equal(r.storyboard.treatment.logline, given.logline);
});

/* ------------------------------------------------------------------ one public template, two rows */

test("the public film template spans both internal rows: the length picks the row, and both ids stay accepted", () => {
  assert.equal(ACTIVE_TEMPLATE.id, "film");
  assert.equal(ACTIVE_TEMPLATE.minSeconds, 15); assert.equal(ACTIVE_TEMPLATE.maxSeconds, 300);
  assert.equal(filmTemplateFor(45), "film"); assert.equal(filmTemplateFor(90), "film");
  assert.equal(filmTemplateFor(91), "film-long"); assert.equal(filmTemplateFor(300), "film-long");
  assert.equal(filmTemplateFor(undefined), "film");
  assert.ok(isPublicTemplate("film") && isPublicTemplate("film-long"), "a job row planned as film-long is still a public film");
  assert.ok(!isPublicTemplate("viral-short") && !isPublicTemplate(undefined));
  assert.deepEqual(PUBLIC_TEMPLATES.map((t) => t.id), ["film"], "but the user is shown one template");
});

/* ------------------------------------------------------------------ the shapes a model answers in */

test("callModel reads the three answer shapes Workers AI models use: response, chat choices, responses output", async () => {
  const schema = { type: "object", properties: { a: { type: "number" } }, required: ["a"], additionalProperties: false };
  const env = (result) => ({ AI: { async run() { return result; } } });
  assert.deepEqual((await callModel(env({ response: { a: 1 }, usage: {} }), "m", [], schema, 10)).raw, { a: 1 });
  // gpt-oss-120b on Workers AI (measured 13 September): chat-completions, the JSON as a string in message.content.
  assert.deepEqual((await callModel(env({ choices: [{ message: { content: "{\n \"a\": 2\n}", reasoning: "…" } }], usage: {} }), "m", [], schema, 10)).raw, { a: 2 });
  assert.deepEqual((await callModel(env({ output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: '{"a":3}' }] }], usage: {} }), "m", [], schema, 10)).raw, { a: 3 });
});

/* ------------------------------------------------------------------ on its own, for kleo_adapt_prompt */

test("writeTreatment answers either way: a treatment, or the reason there is none", async () => {
  let n = 0;
  const env = { AI: { async run(_m, inputs) { n++; assert.equal(inputs.messages[0].content, MASTER_PROMPT); assert.equal(inputs.temperature, TREATMENT_TEMPERATURE); return { response: TREATMENT_FIXTURE(60), usage: { prompt_tokens: 3000, completion_tokens: 1200 } }; } }, AI_MODEL: "@cf/meta/llama-4-scout-17b-16e-instruct" };
  const r = await writeTreatment(env, { prompt: "A film about lighthouse keepers", duration_s: 60, format: "16:9", language: "en" }, { seed: "abc" });
  assert.ok(r.treatment); assert.equal(r.attempts, 1); assert.equal(n, 1);
  assert.equal(r.treatment.variation, variationFor("abc").key);
  assert.ok(r.est_neurons > 0 && r.est_neurons < 400, `one treatment on scout is a few hundred neurons at most, got ${r.est_neurons}`);
  const down = await writeTreatment({ AI: { async run() { throw new Error("503 capacity"); } } }, { prompt: "x", duration_s: 60, format: "16:9", language: "en" });
  assert.equal(down.treatment, null); assert.equal(down.transient, true); assert.equal(down.attempts, 1);
  const bad = await writeTreatment({ AI: { async run() { return { response: { logline: "no" } }; } } }, { prompt: "x", duration_s: 60, format: "16:9", language: "en" });
  assert.equal(bad.treatment, null); assert.equal(bad.transient, false); assert.equal(bad.attempts, 2);
  assert.ok(bad.history.every((h) => /^rejected: /.test(h)));
  const none = await writeTreatment({}, { prompt: "x", duration_s: 60, format: "16:9", language: "en" });
  assert.equal(none.treatment, null); assert.equal(none.transient, true);
});
