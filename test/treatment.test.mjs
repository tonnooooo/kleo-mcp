/**
 * The treatment (src/treatment.ts) and its place in the planner (src/storyboard.ts step -1).
 * Run: node --test test/treatment.test.mjs   (never calls Workers AI)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  T, DEVICES, DEVICE_IDS, OPENING_IDS, MASTER_PROMPT, variationFor, treatmentPrompt, treatmentSchema,
  repairTreatment, treatmentProblems, treatmentOf, treatmentBlock, treatmentText, wordCount, languageOf, proseFloor,
  faithfulVariation, DRAWN_DEVICES, DRAWN_OPENINGS, treatmentTemperature, treatmentMethodText,
} from "../src/treatment.ts";
import { generateStoryboard, TREATMENT_TEMPERATURE, writeTreatment, callModel } from "../src/storyboard.ts";
import { validateStoryboard } from "../src/keou-contract.ts";
import { ACTIVE_TEMPLATE, PUBLIC_TEMPLATES, filmTemplateFor, isPublicTemplate } from "../src/templates.ts";
import { TREATMENT_FIXTURE } from "./fixtures/treatment.mjs";
import { repairSpec } from "../src/spec.ts";

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
  assert.match(MASTER_PROMPT, /MUSIC exists only when the user asked for it \(step 12\)/, "music is the user's option since 22 September, never the studio's default");
  assert.match(MASTER_PROMPT, /^12\. MUSIC\./m);
  assert.match(MASTER_PROMPT, /may DISSOLVE \(a clean 0\.8-second cross-dissolve, one per 25 seconds of film, never inside an act\)/);
  assert.match(MASTER_PROMPT, /NO karaoke captions, NO icons, NO logos/i);
  assert.match(MASTER_PROMPT, /there may be a LAYER, decided in step 11/, "the layer is the treatment's to decide, from a closed grammar (14 September)");
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
  assert.ok(schema.required.includes("prose") && schema.required.includes("acts") && schema.required.includes("music"));
  assert.match(p, /THE SOUND: the user was not asked about music — write "music": null\./, "an internal call without the answers leaves music off");
  const asked = treatmentPrompt({ prompt: "x y z", duration_s: 30, format: "9:16", language: "en", sound: { music: { wanted: true, brief: "warm strings" }, subtitles: true } }, v);
  assert.match(asked, /THE SOUND: the user WANTS MUSIC and asked for "warm strings"/); assert.match(asked, /SUBTITLES: the user WANTS them/);
  const declined = treatmentPrompt({ prompt: "x y z", duration_s: 30, format: "9:16", language: "en", sound: { music: { wanted: false, brief: null }, subtitles: false } }, v);
  assert.match(declined, /the user wants NO music/); assert.match(declined, /SUBTITLES: the user wants NONE/);
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
  // Measured on the production model: an act named as a shot description is cut at a word, never inside one, and
  // "the period is contemporary" is dropped from the decisions because it decides nothing.
  const long = { ...TREATMENT_FIXTURE(60), acts: [{ name: "a lab technician examining samples under the lamp", purpose: "the viewer sees the sample", seconds: 30 }, { name: "the second reading", purpose: "the viewer sees the second reading", seconds: 30 }],
    decisions: ["The period is contemporary.", "The tone is informative and calm.", "The setting is a small bakery at dawn", "Ai giorni nostri", "The narrator is the baker's daughter"] };
  const fitted = repairTreatment(long, 60, v);
  assert.equal(fitted.acts[0].name, "A LAB TECHNICIAN EXAMINING", `cut at a word: ${fitted.acts[0].name}`);
  assert.ok(fitted.acts[0].name.length <= T.acts.name);
  assert.deepEqual(fitted.decisions, ["The setting is a small bakery at dawn", "The narrator is the baker's daughter"]);
  // The prompt asks for more prose than the floor refuses: the floor is what a small model aims at.
  assert.match(treatmentPrompt({ prompt: "x y z", duration_s: 60, format: "9:16", language: "en" }, v), /"prose":"180-350 words/);
  assert.match(treatmentPrompt({ prompt: "x y z", duration_s: 30, format: "9:16", language: "en" }, v), /"prose":"120-350 words/, "a 30-second film is asked for less prose");
  assert.ok(T.prose.target[0] > T.prose.minWords);
  assert.equal(proseFloor(30), 60); assert.equal(proseFloor(45), 72); assert.equal(proseFloor(120), 100); assert.equal(proseFloor(undefined), 100);
  // The second attempt's rule: a prose between 60 and 100 words is kept, under it still refused, and nothing else softens.
  const thin = { ...TREATMENT_FIXTURE(60), prose: Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ") };
  assert.equal(repairTreatment(thin, 60, v), null, "strict: 80 words is refused");
  assert.ok(repairTreatment(thin, 60, v, "en", { lenient: true }), "lenient: 80 words is kept");
  assert.equal(repairTreatment({ ...thin, prose: "ten words only, a caption, not a film at all here" }, 60, v, "en", { lenient: true }), null);
  assert.equal(repairTreatment({ ...thin, acts: [{ ...thin.acts[0], name: "INTRO" }, ...thin.acts.slice(1)] }, 60, v, "en", { lenient: true }), null, "lenient softens the prose only");
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
  assert.ok(p.some((m) => /^prose: \d+ words, it needs at least \d+/.test(m)));
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
      const kind = /TASK: take this request apart into the spec/.test(user) ? "spec" : /TASK: write the TREATMENT/.test(user) ? "treatment" : /TASK: write the DIRECTION/.test(user) ? "direction" : /TASK: plan the whole video/.test(user) ? "outline" : "chunk";
      calls.push({ kind, user, system, temperature: inputs.temperature, model });
      let out;
      // The spec call (24 September 2026) is answered with something that is not a spec: the plan goes on without one,
      // which is the path these tests pin.
      if (kind === "spec") out = {};
      else if (kind === "treatment") out = opts.treatment ? opts.treatment(calls.filter((c) => c.kind === "treatment").length) : TREATMENT_FIXTURE(45);
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
          voice: `Scene ${i + 1} holds on the driveway and then on the window while a dog barks once somewhere down the street.`,
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
  // The spec (step -2, 24 September 2026) is asked first; the treatment is the first creative call after it.
  const first = calls.find((c) => c.kind !== "spec");
  assert.equal(first.kind, "treatment", "step -1 comes before the direction");
  assert.equal(first.system, MASTER_PROMPT);
  assert.equal(first.temperature, TREATMENT_TEMPERATURE);
  const second = calls.filter((c) => c.kind !== "spec")[1];
  assert.equal(second.kind, "direction");
  assert.equal(second.temperature, 0.3, "everything after the treatment stays a document");
  assert.match(second.user, /TREATMENT OF THIS FILM[\s\S]*Logline: A stolen car/);
  assert.match(second.user, /The treatment, in prose:/, "the direction reads the prose");
  assert.match(second.user, /The direction is written UNDER this treatment/);
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

test("a thin prose is asked to be fixed once, then kept: the second answer is read under the lenient rule", async () => {
  const thin = { ...TREATMENT_FIXTURE(45), prose: Array.from({ length: 65 }, (_, i) => `w${i}`).join(" ") };   // under the 45-second floor (72), over the lenient one (60)
  const { env, calls } = planner({ treatment: () => thin });
  const r = await generateStoryboard(env, job("A Short about relay car theft"));
  const tcalls = calls.filter((c) => c.kind === "treatment");
  assert.equal(tcalls.length, 2, "the first answer is sent back for its prose");
  assert.match(tcalls[1].user, /REJECTED[\s\S]*prose: 65 words, it needs at least 72/);
  assert.ok(r.treatment, "the identical second answer is kept");
  assert.equal(wordCount(r.treatment.prose), 65);
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

/* ------------------------------------------------------------------ the look (14 September): realistic or animation */

test("the method decides the look in step 0, and the treatment carries it as a closed field", () => {
  assert.match(MASTER_PROMPT, /^0\. LOOK\. "realistic" or "animation"/m, "step 0 of the method is the look");
  assert.match(MASTER_PROMPT, /REALISTIC \(live-action photography\) or ANIMATION \(a 2D animated feature/);
  assert.match(MASTER_PROMPT, /IN ANIMATION the same sentence names the drawn world/, "the visual language has an animation reading");
  assert.doesNotMatch(MASTER_PROMPT, /NO animation,/, "animation is no longer on the list of what Kleo cannot render");
  const schema = treatmentSchema();
  assert.deepEqual(schema.properties.look, { type: "string", enum: ["realistic", "animation"] });
  assert.ok(schema.required.includes("look"));
  const v = variationFor("look-test");
  const p = treatmentPrompt({ prompt: "A fox who learns to swim", duration_s: 45, format: "9:16", language: "en", look: "animation" }, v);
  assert.match(p, /THE LOOK: ANIMATION, fixed by the request or the tool call — write "look":"animation"/);
  assert.match(p, /"look":"realistic\|animation"/, "the shape names the field");
  const open = treatmentPrompt({ prompt: "A fox who learns to swim", duration_s: 45, format: "9:16", language: "en" }, v);
  assert.match(open, /THE LOOK: not named — decide it in step 0/);
});

test("the look is checked, forced by the call, and read back by every stage", () => {
  const v = variationFor("look-test");
  const raw = TREATMENT_FIXTURE(60);
  assert.deepEqual(treatmentProblems({ ...raw, look: "3d" }, 60, "en"), ['look: "3d" is not one of realistic, animation']);
  assert.deepEqual(treatmentProblems({ ...raw, look: "animation" }, 60, "en", { look: "realistic" }), ['look: the treatment says "animation" but the film was asked in "realistic" — write it for that look, or pass style "animation"']);
  assert.deepEqual(treatmentProblems({ ...raw, look: "animation" }, 60, "en", { look: "animation" }), []);
  assert.equal(repairTreatment(raw, 60, v, "en").look, "realistic", "a treatment written before the field existed is realistic");
  assert.equal(repairTreatment({ ...raw, look: "animation" }, 60, v, "en").look, "animation");
  assert.equal(repairTreatment(raw, 60, v, "en", { look: "animation" }).look, "animation", "the call's look wins over an absent field");
  const t = repairTreatment({ ...raw, look: "animation" }, 60, v, "en");
  assert.match(treatmentBlock(t), /^Look: ANIMATION — a 2D animated film: every picture is a drawn frame/m, "the direction and the scenes read the look first");
  assert.match(treatmentText(t), /^Look: animation \(a 2D animated film\)/m);
  assert.match(treatmentText(repairTreatment(raw, 60, v, "en")), /^Look: realistic \(filmed\)/m);
  assert.equal(treatmentOf({ treatment: { ...t } }).look, "animation", "read back from a job's params");
});

/* ------------------------------------------------------------------ faithful mode (24 September 2026) */

/** A faithful spec as src/spec.ts repairSpec() returns it: a named character, her look, two events in order. */
const FAITHFUL_SPEC = () => ({
  v: 1, mode: "faithful", summary: "Mara, a pastry chef, bakes a lemon cake for the village children, who then throw her a surprise party.",
  cast: [{ id: "c1", name: "Mara", look: "a thin woman in her thirties with short blonde hair tied up and a lilac apron" }],
  items: [
    { id: "R1", kind: "character", text: "Mara, a pastry chef", quote: "Mara, una pasticcera", must: true, who: "c1", order: null },
    { id: "R2", kind: "look", text: "Mara wears a lilac apron", quote: "grembiule lilla", must: true, who: "c1", order: null },
    { id: "R3", kind: "event", text: "Mara bakes a lemon cake for the village children", quote: "prepara una torta al limone per i bambini", must: true, who: "c1", order: 1 },
    { id: "R4", kind: "event", text: "the children throw Mara a surprise party", quote: "le fanno una festa a sorpresa", must: true, who: null, order: 2 },
  ],
  refs: [], open: ["the ending"], narration: "free", script: null,
});
const OPEN_SPEC = () => ({ ...FAITHFUL_SPEC(), mode: "open" });

test("a faithful film is not drawn: as-told/as-asked, never handed out by variationFor", () => {
  assert.deepEqual(faithfulVariation(), { device: "as-told", opening: "as-asked", key: "as-told/as-asked" });
  assert.ok(DEVICE_IDS.includes("as-told") && OPENING_IDS.includes("as-asked"), "both are legal values of a treatment");
  assert.ok(!DRAWN_DEVICES.includes("as-told") && !DRAWN_OPENINGS.includes("as-asked"), "neither is ever drawn");
  assert.equal(DRAWN_DEVICES.length, 8); assert.equal(DRAWN_OPENINGS.length, 5);
  for (let i = 0; i < 300; i++) { const d = variationFor(`gt_${i}`); assert.ok(d.device !== "as-told" && d.opening !== "as-asked", d.key); }
  assert.equal(variationFor("gt_test0001").key, v.key, "an open film's draw is exactly the one it was before");
  assert.ok(treatmentSchema().properties.device.enum.includes("as-told"), "the schema lets the model write it");
  assert.equal(treatmentTemperature(FAITHFUL_SPEC()), 0.4);
  assert.equal(treatmentTemperature(OPEN_SPEC()), 0.85);
  assert.equal(treatmentTemperature(null), 0.85); assert.equal(treatmentTemperature(undefined), 0.85);
});

test("the pirate spec a writer called faithful is open: a drawn device, at the producer's temperature, and a story", () => {
  // 25 September 2026: "fammi un video dei pirati" came back FAITHFUL on one generic character, was told as-told at
  // temperature 0.4, and the film was a pirate standing at a rail. Kleo's rule makes it OPEN.
  const request = "fammi un video in orizzontale, dei pirati di 15 secondi";
  const spec = repairSpec({ v: 1, mode: "faithful", summary: "A video about pirates.", cast: [], refs: [], open: ["the story"], narration: "free", script: null,
    items: [{ id: "R1", kind: "character", text: "pirates", quote: "dei pirati", must: true, who: null, order: null }] }, request);
  assert.equal(spec.mode, "open");
  assert.equal(treatmentTemperature(spec), 0.85);
  const p = treatmentPrompt({ prompt: request, duration_s: 15, format: "16:9", language: "en", spec }, v);
  assert.ok(p.includes(`narrative device: ${v.device}`), "the draw is printed");
  assert.doesNotMatch(p, /THE DRAW FOR THIS FILM: as-told/);
  assert.match(MASTER_PROMPT, /OPEN mode[^\n]*when the subject is fiction, a genre or creatures[^\n]*the film is a STORY, not a portrait of the subject: one character with a want, a hook in the first 3 seconds, a turn at about two thirds of the film, and an ending that pays off the opening/);
});

test("the master prompt has a FIDELITY section: the request is the brief", () => {
  assert.match(MASTER_PROMPT, /FIDELITY — THE REQUEST IS THE BRIEF/);
  assert.match(MASTER_PROMPT, /Every MUST item is in the film: SEEN .* or HEARD/);
  assert.match(MASTER_PROMPT, /The user's EVENTS happen in the user's ORDER/);
  assert.match(MASTER_PROMPT, /called by the names the user gave them/);
  assert.match(MASTER_PROMPT, /every addition is one line in "decisions"/);
  assert.match(MASTER_PROMPT, /FAITHFUL mode .* the ANGLE \(step 1\) is the point of the user's own story/);
  assert.match(MASTER_PROMPT, /^1\. ANGLE\. In FAITHFUL mode: the point of the user's own story/m);
  assert.match(MASTER_PROMPT, /Where the user did not ask for spectacle, human scale beats spectacle/, "spectacle the user asked for is shown");
  assert.match(MASTER_PROMPT, /a FICTIONAL character the user named keeps the user's name/);
  assert.match(MASTER_PROMPT, /never a named living person/i, "and still never a real one");
});

test("the treatment prompt prints the spec above everything; a faithful one replaces the draw", () => {
  const input = { prompt: "Mara, una pasticcera con il grembiule lilla, prepara una torta al limone per i bambini; poi le fanno una festa a sorpresa.", duration_s: 45, format: "9:16", language: "it" };
  const p = treatmentPrompt({ ...input, spec: FAITHFUL_SPEC() }, v);
  assert.ok(p.startsWith("THE USER'S REQUEST, AS REQUIREMENTS"), p.slice(0, 80));
  assert.ok(p.indexOf("R3 [event #1, MUST]") < p.indexOf("USER REQUEST (read it as a request"), "the requirements come before the request's prose");
  assert.match(p, /THE DRAW FOR THIS FILM: as-told\/as-asked — nothing is drawn/);
  assert.match(p, /"device":"as-told"/);
  assert.ok(!p.includes(`narrative device: ${v.device}`), "the caller's random draw is not printed");
  assert.match(p, /"angle":"<=\d+, the point of the user's own story in one sentence/);
  assert.match(p, /only what LEFT TO KLEO allows/);
  // An open spec is printed too, and keeps the draw.
  const o = treatmentPrompt({ ...input, spec: OPEN_SPEC() }, v);
  assert.match(o, /^THE USER'S REQUEST, AS REQUIREMENTS \(the brief — OPEN/);
  assert.match(o, new RegExp(`narrative device: ${v.device}`));
  // No spec: exactly the prompt it was.
  const none = treatmentPrompt(input, v);
  assert.ok(none.startsWith("USER REQUEST (read it as a request"));
  assert.ok(!/REQUIREMENTS/.test(none));
  // The method handed to an assistant carries the same spec and the same (non-)draw.
  const m = treatmentMethodText({ ...input, spec: FAITHFUL_SPEC() }, variationFor("random-uuid"));
  assert.match(m, /THE USER'S REQUEST, AS REQUIREMENTS/);
  assert.match(m, /Add "variation":"as-told\/as-asked"/);
  assert.match(m, /This is the user's film \(FAITHFUL\)/);
  assert.ok(!/This is the user's film/.test(treatmentMethodText(input, v)));
});

test("a faithful treatment may restate the logline in its angle and is told as-told; an open one may not claim as-told", () => {
  const faithful = { ...TREATMENT_FIXTURE(45), logline: "Mara bakes a lemon cake for the village children, and the children throw her a surprise party.", angle: "Mara bakes for the village children, and the children throw her a surprise party in return." };
  assert.ok(treatmentProblems(faithful, 45, "en").some((m) => /^angle: it restates the logline/.test(m)), "open: the overlap rule stands");
  assert.deepEqual(treatmentProblems(faithful, 45, "en", { faithful: true }), [], "faithful: the angle is the point of the user's own story");
  // A treatment that says "as-told" is read as faithful when nobody says otherwise (a client's, or one read back)…
  assert.deepEqual(treatmentProblems({ ...faithful, device: "as-told" }, 45, "en"), []);
  // …and refused when the film was left open and given a draw.
  assert.ok(treatmentProblems({ ...faithful, device: "as-told" }, 45, "en", { faithful: false }).some((m) => /^device: "as-told" is the device of a film the user described/.test(m)));
  // The repair tells a faithful film as-told whatever the model wrote, and records no random draw.
  const t = repairTreatment({ ...faithful, device: "countdown", variation: "countdown/the-face" }, 45, v, "en", { faithful: true });
  assert.equal(t.device, "as-told"); assert.equal(t.variation, "as-told/as-asked");
  assert.match(treatmentBlock(t), /Device: as-told — tell it the way the user told it/);
  // Read back from a job's params, it stays a treatment.
  const back = treatmentOf({ treatment: t });
  assert.ok(back, "a faithful treatment is not refused on the way back for its angle");
  assert.equal(back.device, "as-told"); assert.equal(back.variation, "as-told/as-asked");
});

test("the assistant writes the spec and the treatment in one breath: the draw is conditional on the spec it wrote", () => {
  // kleo_adapt_prompt hands the assistant both methods before any spec exists (24 September 2026). An unconditional
  // draw told it "tell the film as the-witness" for a story the user had described scene by scene.
  const v = variationFor("gt_draw1234");
  const input = { prompt: "Una pasticcera bionda organizza una festa a sorpresa", duration_s: 30, format: "9:16", language: "it", look: "animation", specPending: true };
  const text = treatmentMethodText(input, v);
  assert.match(text, /THE DRAW DEPENDS ON THE SPEC YOU WROTE/);
  assert.match(text, /If its mode is FAITHFUL[\s\S]*device "as-told"[\s\S]*ONLY if its mode is OPEN/);
  assert.ok(text.includes(`narrative device: ${v.device}`), "the open draw is still offered");
  assert.match(text, /"device":"as-told" \(faithful spec\) or "/);
  assert.match(text, /"variation":"as-told\/as-asked" when your spec is faithful/);
  // Without the flag (the server road, which knows its spec) the draw is printed as before.
  const plain = treatmentMethodText({ ...input, specPending: false }, v);
  assert.ok(!/THE DRAW DEPENDS ON THE SPEC/.test(plain));
  assert.ok(plain.includes(`"variation":"${v.key}"`));
});
