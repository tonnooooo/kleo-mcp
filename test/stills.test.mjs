/**
 * Unit tests for src/stills.ts, the stills engine of 24 September 2026: the prompt compiler (what goes first, what
 * the picture model reads about each character, the text allowance, the sizes), the draw → judge → redraw loop
 * against a fake FLUX.2 + vision binding (a failed must is drawn again with the failure named first, the best try is
 * kept, a refused reference is dropped, an unanswering judge does not burn the quota; since the fidelity bench of the
 * same day: two tries, a must-free try is kept whatever its score, 9B only for a look, identity or text miss, an
 * identity question per character drawn from a sheet, a flagged draw moves to the next seed), and a whole job's stills
 * persisted the way /images and /dl read them (character sheets first, R2 names, audit rows, params.stills,
 * fidelity.json). Since 25 September 2026 also the two external roads a still model id can name — OpenRouter's chat
 * completions and kie.ai's jobs API, both behind a fake `fetch` (globalThis.fetch replaced, as test/footage.test.mjs
 * does) — the signed reference links kie.ai is given, the fallback to klein-4B after a refusal for money, and the cost
 * of a job's pictures. No network, no Workers AI. Run: node --test test/stills.test.mjs
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  compileStill, feedbackFor, drawStill, drawCastSheet, drawJobStills, stillsEngineOn, stillsHold, stillCast, stillShotsOf,
  STILL_SIZES, STILL_PROMPT_MAX, STYLE_SENTENCE, NO_TEXT_SENTENCE, FRAMING, DEFAULT_FRAMING, DEFAULT_STILL_MODEL, DEFAULT_STRONG_STILL_MODEL, EST_STILL_MS, castSheetKey,
  stillsErrorVerdict, pauseStills,
  drawImage, isFlaggedError, fallbackReason, stillProviderOf, strongStillModel, fallbackStillModel, stillPriceUsd, aspectRatioOf, imageTierOf,
  openRouterImageUrl, kieStillInput, KIE_STILL_POLL, SHEET_SIZE, REFERENCE_LINK_RE, referenceLinkKey, sheetLinkName,
  isTaskFailure, isTransientStillError, stillsGiveUpMin, STILLS_GIVE_UP_MIN, StillDrawError,
} from "../src/stills.ts";
import { KieError, kieRetryable, isNoCredit } from "../src/kie.ts";
import { isTransientError } from "../src/images.ts";
import { handleDownload } from "../src/dl.ts";

// The external roads' tests (25 September 2026) replace globalThis.fetch and shorten kie.ai's polling: both are put
// back after every test, so no test sees another's network.
const POLL0 = { ...KIE_STILL_POLL };
let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; Object.assign(KIE_STILL_POLL, { firstMs: 1, everyMs: 2, minMs: 2_000, maxMs: 4_000 }); });
afterEach(() => { globalThis.fetch = realFetch; Object.assign(KIE_STILL_POLL, POLL0); });

/* ------------------------------------------------------------------ fixtures */

/** The pastry chef of the audit (gt_7f7aaac6): the look that used to come back as a brunette in a red apron. */
const SPEC = {
  v: 1, mode: "faithful", summary: "Mara, a thin pastry chef, decorates a cake in her village bakery at dawn.",
  cast: [{ id: "c1", name: "Mara", look: "a thin woman in her thirties with short blonde hair tied up", ref: null }],
  items: [
    { id: "R1", kind: "character", text: "Mara, a pastry chef", quote: "Mara la pasticcera", must: true, who: "c1", order: null },
    { id: "R2", kind: "look", text: "Mara has short blonde hair tied up", quote: "capelli biondi corti raccolti", must: true, who: "c1", order: null },
    { id: "R3", kind: "look", text: "Mara wears a lilac apron", quote: "grembiule lilla", must: true, who: "c1", order: null },
    { id: "R4", kind: "place", text: "a village bakery at dawn", quote: "forno del paese all'alba", must: true, who: null, order: null },
    { id: "R5", kind: "text", text: "a shop sign reading \"Forno Mara\"", quote: "insegna Forno Mara", must: true, who: null, order: null },
    { id: "R6", kind: "exclude", text: "no dogs", quote: "niente cani", must: true, who: null, order: null },
    { id: "R7", kind: "style", text: "warm pastel colours", quote: "colori pastello", must: true, who: null, order: null },
  ],
  refs: [], open: ["the ending"], narration: "free", script: null,
};
const DIRECTION = { subject: "Mara's cake", world: "A country village bakery at dawn, flour in the air", cast: [{ name: "Mara", look: "a thin blonde woman" }], objects: [], forbidden: ["logos"], sections: [] };
const IMG = (n) => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 9, 9, 9]), mime: "image/jpeg" });
const shot = (extra = {}) => ({ id: "01-sc-s1", image_prompt: "Mara pipes cream onto a two-tier cake", shot_kind: "face", covers: ["R2", "R3"], cast: ["c1"], action: null, ...extra });
const input = (extra = {}) => ({ shot: shot(), spec: SPEC, direction: DIRECTION, look: "realistic", format: "9:16", visual: "Soft window light on flour-dusted wood, cream and lilac", refs: [{ label: "Mara", image: IMG(1) }], ...extra });

/**
 * A fake binding: FLUX.2 draws (multipart) answer {image: base64 jpeg} with the draw's number in byte 4; the vision
 * judge answers each numbered question through `answer(question, draws)` — by default what a faithful picture gets
 * (yes, except "no" to text and to excluded things).
 */
function fakeAi({ answer, draw, visionThrows } = {}) {
  const calls = { draws: [], judges: [] };
  const ai = { async run(model, inputs) {
    if (inputs.multipart) {
      const fd = await new Response(inputs.multipart.body, { headers: { "content-type": inputs.multipart.contentType } }).formData();
      const d = { model, prompt: fd.get("prompt"), width: Number(fd.get("width")), height: Number(fd.get("height")), seed: Number(fd.get("seed")), refs: [0, 1, 2, 3].filter((i) => fd.get(`input_image_${i}`)).length };
      calls.draws.push(d);
      if (draw) await draw(d, calls.draws.length);
      return { image: Buffer.from([0xff, 0xd8, 0xff, 0xe0, calls.draws.length, 1, 2, 3]).toString("base64") };
    }
    if (inputs.messages) {
      if (visionThrows) throw new Error("AiError: 3040: vision model unavailable");
      const content = inputs.messages[0].content;
      const qs = [...content[0].text.matchAll(/^(q\d+): (.*)$/gm)].map((m) => ({ key: m[1], q: m[2] }));
      calls.judges.push({ qs, images: content.filter((c) => c.type === "image_url").length, draw: calls.draws.length });
      const ans = {};
      for (const { key, q } of qs) ans[key] = answer ? answer(q, calls.draws.length) : (/any written text|any of this/i.test(q) ? "no" : "yes");
      return { response: JSON.stringify(ans) };
    }
    throw new Error("unexpected AI call");
  } };
  return { ai, calls };
}
const drawnNo = (bytes) => bytes[4];

/* ------------------------------------------------------------------ the prompt */

test("compileStill: framing, then the author's sentence, then each character with the reference it is drawn from, then place, visual, style, no text, exclusions", () => {
  const c = compileStill(input());
  const p = c.prompt;
  assert.ok(p.startsWith(`${FRAMING.face}, vertical 9:16 frame. Mara pipes cream onto a two-tier cake.`), p);
  const at = (s) => { const i = p.indexOf(s); assert.ok(i >= 0, `missing "${s}" in: ${p}`); return i; };
  assert.ok(at("Mara (reference image 1): a thin woman in her thirties with short blonde hair tied up; Mara wears a lilac apron") > at("two-tier cake"), "the spec's full look, every look item folded in, never the direction's paraphrase");
  assert.ok(!p.includes("a thin blonde woman"), "the direction's shorter look is not used for a spec character");
  assert.ok(at("Setting: A country village bakery at dawn") > at("Mara (reference image 1)"));
  assert.ok(at("Visual language: Soft window light") > at("Setting:"));
  assert.ok(at(STYLE_SENTENCE.realistic) > at("Visual language:"));
  assert.ok(at("Style: warm pastel colours") > at(STYLE_SENTENCE.realistic), "the user's style items ride on the look's sentence");
  assert.ok(at(NO_TEXT_SENTENCE) > at(STYLE_SENTENCE.realistic));
  assert.ok(at("Without dogs") > at(NO_TEXT_SENTENCE), "the user's exclusions, phrased as without …");
  assert.ok(p.includes("without logos"), "the direction's forbidden list too");
  assert.ok(p.length <= STILL_PROMPT_MAX);
  assert.deepEqual([c.width, c.height], [896, 1600]);
  const ids = c.checks.map((x) => x.id);
  for (const id of ["style", "R2", "R3", "R7", "exclude:R6", "no-text"]) assert.ok(ids.includes(id), `check ${id} in ${ids}`);
  // The owner, 24 September 2026: "a whisk on a cake that is already finished". Every still is asked whether it makes sense.
  assert.ok(ids.includes("logic")); assert.ok(c.prompt.includes("physically and logically plausible"), c.prompt);
  assert.equal(new Set(ids).size, ids.length, "no check is asked twice");
});

test("compileStill: failures go FIRST, a text item lifts the no-text rule and is spelled out, sizes are multiples of 16 in both formats", () => {
  const p = compileStill(input(), ["the picture clearly shows Mara wears a lilac apron."]).prompt;
  assert.ok(p.startsWith("It is essential that: the picture clearly shows Mara wears a lilac apron. Close-up"), p);
  const sign = compileStill(input({ shot: shot({ covers: ["R4", "R5"], shot_kind: "establish", cast: [] , image_prompt: "The bakery front with its shop sign" }) }));
  assert.ok(sign.prompt.startsWith(FRAMING.establish));
  assert.ok(sign.prompt.includes('Written clearly and legibly ON an object in the scene (a note, a sign, a label, a cake, a screen), spelled exactly as given, never floating in the air: a shop sign reading "Forno Mara".'), sign.prompt);
  assert.ok(!sign.prompt.includes(NO_TEXT_SENTENCE), "a shot that must carry words is not told to carry none");
  assert.ok(!sign.checks.some((x) => x.id === "no-text")); assert.ok(sign.checks.some((x) => x.id === "R5" && /readable/.test(x.question)));
  assert.ok(!sign.prompt.includes("(reference image 1)"), "a sheet whose character is not in the shot is not claimed as that character");
  for (const f of ["9:16", "16:9"]) for (const v of Object.values(STILL_SIZES[f])) { assert.equal(v % 16, 0); assert.ok(v >= 256 && v <= 1920); }
  assert.deepEqual(compileStill(input({ format: "16:9" })), { ...compileStill(input({ format: "16:9" })), width: 1600, height: 896 });
  assert.ok(compileStill(input({ shot: shot({ shot_kind: "detail" }) })).prompt.startsWith("Extreme close-up of the object"));
  assert.ok(compileStill(input({ shot: shot({ shot_kind: null }) })).prompt.startsWith(DEFAULT_FRAMING));
  assert.ok(compileStill(input({ look: "animation" })).prompt.includes(STYLE_SENTENCE.animation));
});

test("compileStill: a long visual sentence and long looks are shortened, never the feedback or the author's sentence", () => {
  const long = "Grain of old oak, brass fittings, frost on the glass, a copper kettle catching the first light ".repeat(20);
  const c = compileStill(input({ visual: long }), ["Mara's hair is short and blonde"]);
  assert.ok(c.prompt.length <= STILL_PROMPT_MAX, `${c.prompt.length}`);
  assert.ok(c.prompt.startsWith("It is essential that: Mara's hair is short and blonde."));
  assert.ok(c.prompt.includes("Mara pipes cream onto a two-tier cake."));
  assert.ok(c.prompt.includes("lilac apron"), "the look survives the cut");
});

test("stillCast: the shot's own cast first, then names in the prompt; a lone character is also 'she'; no spec reads the direction", () => {
  assert.deepEqual(stillCast(shot(), SPEC, DIRECTION).map((m) => m.id), ["c1"]);
  assert.deepEqual(stillCast({ image_prompt: "She kneads the dough", covers: [], cast: [] }, SPEC, DIRECTION).map((m) => m.name), ["Mara"]);
  assert.deepEqual(stillCast({ image_prompt: "An empty street at dawn", covers: [], cast: [] }, SPEC, DIRECTION), []);
  const d = stillCast({ image_prompt: "Mara at the oven", covers: [], cast: [] }, null, DIRECTION);
  assert.deepEqual(d, [{ id: null, name: "Mara", look: "a thin blonde woman" }]);
  assert.deepEqual(stillCast({ image_prompt: "the counter", covers: ["R3"], cast: [] }, SPEC, null).map((m) => m.id), ["c1"], "covering a look item shows its owner");
});

test("feedbackFor: a failed check becomes what the picture must do, in positive words", () => {
  const checks = compileStill(input()).checks;
  const pick = (id) => checks.find((c) => c.id === id);
  const f = feedbackFor([pick("R3"), pick("style"), pick("exclude:R6"), pick("no-text")], SPEC, "realistic");
  assert.deepEqual(f, [
    "the picture clearly shows Mara wears a lilac apron",
    "the picture is a real photograph, not a drawing, a painting or a 3D render",
    "none of this is visible anywhere: dogs",
    "there is no text, lettering, caption or watermark anywhere",
  ]);
});

/* ------------------------------------------------------------------ draw, judge, redraw */

test("drawStill: a failed must is drawn again with the failure named first and a new seed; the passing try is kept", async () => {
  const { ai, calls } = fakeAi({ answer: (q, n) => (n === 1 && /lilac apron/.test(q) ? "no" : /any written text|any of this/i.test(q) ? "no" : "yes") });
  const r = await drawStill({ AI: ai }, input(), { seedBase: 100 });
  assert.equal(calls.draws.length, 2);
  assert.equal(calls.draws[0].model, DEFAULT_STILL_MODEL);
  // Two tries by default (24 September 2026): the second is the last, and a missed LOOK is what 9B draws better.
  assert.equal(calls.draws[1].model, DEFAULT_STRONG_STILL_MODEL);
  assert.deepEqual(calls.draws.map((d) => d.seed), [100, 101]);
  assert.equal(calls.draws[0].refs, 1, "the character's sheet goes in as input_image_0");
  assert.equal(calls.judges[0].images, 2, "the judge sees the picture and the sheet it is compared with");
  assert.ok(!calls.draws[0].prompt.startsWith("It is essential"));
  assert.ok(calls.draws[1].prompt.startsWith("It is essential that: the picture clearly shows Mara wears a lilac apron."), calls.draws[1].prompt);
  assert.equal(drawnNo(r.bytes), 2); assert.equal(r.mustFailed, 0); assert.equal(r.score, 1);
  assert.deepEqual(r.tries.map((t) => t.failed), [["R3"], []]);
});

test("drawStill: when every try fails, the best one is kept — fewest failed musts, then the highest score", async () => {
  const fails = { 1: /blonde|lilac/, 2: /lilac/, 3: /blonde|lilac|photograph/ };
  const { ai, calls } = fakeAi({ answer: (q, n) => (fails[n].test(q) ? "no" : /any written text|any of this/i.test(q) ? "no" : "yes") });
  const r = await drawStill({ AI: ai }, input(), { attempts: 3 });
  assert.equal(calls.draws.length, 3);
  assert.equal(drawnNo(r.bytes), 2, "the second try failed one must, the first three and the third four");
  assert.equal(r.mustFailed, 1); assert.deepEqual(r.failed, ["R3"]);
  assert.equal(r.tries.length, 3);
  // Cost-neutral (24 September 2026): the cheap model draws, the strong one only the last try after failed musts —
  // here a look (the lilac apron), which 9B draws better.
  assert.deepEqual(calls.draws.map((d) => d.model), [DEFAULT_STILL_MODEL, DEFAULT_STILL_MODEL, DEFAULT_STRONG_STILL_MODEL]);
  assert.equal(r.tries[2].model, DEFAULT_STRONG_STILL_MODEL); assert.equal(r.tries[0].model, undefined);
  // "none" switches the escalation off.
  const off = fakeAi({ answer: (q, n) => (fails[n].test(q) ? "no" : /any written text|any of this/i.test(q) ? "no" : "yes") });
  await drawStill({ AI: off.ai, STILL_MODEL_STRONG: "none" }, input(), { attempts: 3 });
  assert.ok(off.calls.draws.every((d) => d.model === DEFAULT_STILL_MODEL));
});

test("drawStill: a refused reference image is dropped and the still drawn without it; a quota answer with nothing drawn is thrown; a silent judge keeps the first picture", async () => {
  const refused = fakeAi({ draw: (d) => { if (d.refs) throw new Error("AiError: 5006: input_image_0 exceeds the allowed size"); } });
  const r = await drawStill({ AI: refused.ai }, input());
  assert.deepEqual(refused.calls.draws.map((d) => d.refs), [1, 0]);
  assert.ok(!refused.calls.draws[1].prompt.includes("(reference image 1)"), "the prompt no longer names a reference it does not pass");
  assert.equal(r.mustFailed, 0);
  const quota = fakeAi({ draw: () => { throw new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons"); } });
  await assert.rejects(drawStill({ AI: quota.ai }, input()), /4006/);
  assert.equal(quota.calls.draws.length, 1, "a transient refusal is not retried without references");
  const blind = fakeAi({ visionThrows: true });
  const b = await drawStill({ AI: blind.ai }, input(), { attempts: 3 });
  assert.equal(blind.calls.draws.length, 1, "no judge, no redraw: redrawing blind only spends the quota");
  assert.equal(b.judged, false); assert.deepEqual(b.failed, ["unjudged"]);
});

test("drawCastSheet: a full figure from the full look, judged attribute by attribute; the user's photo is reference image 1", async () => {
  const { ai, calls } = fakeAi();
  const s = await drawCastSheet({ AI: ai }, SPEC, SPEC.cast[0], "animation", null, { seedBase: 7 });
  assert.equal(s.score, 1);
  const p = calls.draws[0].prompt;
  assert.ok(p.startsWith("Character reference sheet of Mara: a thin woman in her thirties with short blonde hair tied up; Mara wears a lilac apron."), p);
  assert.ok(p.includes("Full figure, front view, neutral pose, plain light background, even light.")); assert.ok(p.includes(STYLE_SENTENCE.animation));
  assert.deepEqual([calls.draws[0].width, calls.draws[0].height], [768, 1024]);
  const qs = calls.judges[0].qs.map((x) => x.q).join(" | ");
  assert.match(qs, /short blonde hair/); assert.match(qs, /lilac apron/); assert.match(qs, /drawn 2D animation frame/);
  const withPhoto = fakeAi();
  await drawCastSheet({ AI: withPhoto.ai }, SPEC, SPEC.cast[0], "realistic", IMG(5));
  assert.ok(withPhoto.calls.draws[0].prompt.startsWith("Character reference sheet of Mara, the same person as in reference image 1:"));
  assert.equal(withPhoto.calls.draws[0].refs, 1);
});

/* ------------------------------------------------------------------ a whole job */

function fakeEnv(extra = {}) {
  const files = new Map(), auditRows = [], kv = new Map(), jobs = new Map();
  const db = {
    prepare(sql) {
      return {
        args: [], bind(...a) { this.args = a; return this; },
        async run() {
          if (sql.startsWith("INSERT OR REPLACE INTO job_files")) files.set(this.args[1], { job_id: this.args[0], name: this.args[1], key: this.args[2], size: this.args[3], content_type: this.args[4] });
          else if (sql.startsWith("INSERT INTO audit")) auditRows.push({ job_id: this.args[1], event: this.args[2], detail: this.args[3], at: new Date().toISOString() });
          else if (sql.startsWith("UPDATE jobs SET params = ? WHERE id = ? AND params = ?")) {
            const j = jobs.get(this.args[1]);
            if (!j || j.params !== this.args[2]) return { meta: { changes: 0 } };
            j.params = this.args[0];
          }
          return { meta: { changes: 1 } };
        },
        async all() {
          if (sql.startsWith("SELECT * FROM job_files")) return { results: [...files.values()] };
          if (sql.includes("FROM audit")) { const ev = sql.match(/event = '([^']+)'/)?.[1]; return { results: auditRows.filter((r) => r.event === ev).map((r) => ({ detail: r.detail, at: r.at })) }; }
          return { results: [] };
        },
        async first() {
          if (sql.startsWith("SELECT * FROM jobs")) return jobs.get(this.args[0]) ?? null; // getJob, for the /dl round trip
          return sql.startsWith("SELECT params FROM jobs") ? (jobs.has(this.args[0]) ? { params: jobs.get(this.args[0]).params } : null) : null;
        },
      };
    },
  };
  const OAUTH_KV = { async put(k, v, o) { kv.set(k, { v, o }); }, async getWithMetadata(k) { const e = kv.get(k); return { value: e?.v ?? null, metadata: e?.o?.metadata }; }, async delete(k) { kv.delete(k); } };
  return { env: { DB: db, OAUTH_KV, INTERNAL_SECRET: "s3cret", ...extra }, files, auditRows, kv, jobs };
}
const STORYBOARD = {
  style: "picture", kleo_style: "realistic", direction: DIRECTION, treatment: { visual: "Soft window light on flour-dusted wood" },
  scenes: [
    { id: "01-sc", kind: "cinema", voice: "a line", shots: [{ image_prompt: "Mara ties her lilac apron", shot_kind: "face", covers: ["R2", "R3"], cast: ["c1"] }, { image_prompt: "The bakery front and its sign", shot_kind: "establish", covers: ["R4", "R5"], cast: [] }] },
    { id: "02-sc", kind: "closing", voice: "a line", shots: [{ image_prompt: "Mara smiles at the finished cake", shot_kind: "closing", covers: ["R1"], cast: ["c1"] }] },
  ],
};
const jobOf = (jobs, extra = {}) => {
  const job = { id: "gt_stills", user_id: "u1", params: JSON.stringify({ duration_s: 30, format: "9:16", language: "it", voice: null, style: "realistic", spec: SPEC, ...extra }), storyboard: JSON.stringify(STORYBOARD), phase: null, queued_at: new Date().toISOString(), created_at: new Date().toISOString() };
  jobs.set(job.id, job);
  return job;
};
const paramsNow = (jobs) => JSON.parse(jobs.get("gt_stills").params);

test("stillShotsOf reads the planner's authoring fields off the stored storyboard", () => {
  const s = stillShotsOf(STORYBOARD);
  assert.deepEqual(s.map((x) => x.id), ["01-sc-s1", "01-sc-s2", "02-sc-s1"]);
  assert.deepEqual(s[0].covers, ["R2", "R3"]); assert.deepEqual(s[0].cast, ["c1"]); assert.equal(s[0].shot_kind, "face");
});

test("drawJobStills: the sheet first, then every still with the sheet as reference, stored under the img/ names; audit, params.stills and fidelity.json; a second run reuses everything", async () => {
  const { ai, calls } = fakeAi();
  const { env, files, auditRows, kv, jobs } = fakeEnv({ AI: ai });
  const job = jobOf(jobs);
  const r = await drawJobStills(env, job, { deadline: Date.now() + 120_000 });
  assert.deepEqual(r, { state: "done", drawn: 3, total: 3 });
  assert.ok(calls.draws[0].prompt.startsWith("Character reference sheet of Mara"), "the character sheet is drawn before any shot");
  assert.ok(kv.has(`file:${castSheetKey("gt_stills", "c1")}`), "the sheet is kept on R2 for the next tick");
  assert.ok(![...files.keys()].some((n) => n.startsWith("cast/")), "a sheet is not a job file: it never reaches the user's links");
  const shots = calls.draws.slice(1);
  assert.equal(shots.length, 3);
  const mara = shots.find((d) => d.prompt.includes("ties her lilac apron"));
  assert.equal(mara.refs, 1, "a shot that shows Mara is drawn from her sheet");
  // The style anchor (24 September 2026): the film's first still is drawn alone, then passed to every other one.
  assert.ok(shots[0].prompt.includes("ties her lilac apron"), "the first still is drawn first, alone");
  const front = shots.find((d) => d.prompt.includes("bakery front"));
  assert.equal(front.refs, 1, "a shot without her carries no sheet, only the first still as the style anchor");
  assert.ok(front.prompt.includes("the drawing style of this film"), front.prompt);
  for (const id of ["01-sc-s1", "01-sc-s2", "02-sc-s1"]) {
    const f = files.get(`img/${id}.jpg`);
    assert.equal(f.key, `renders/gt_stills/img/${id}.jpg`); assert.equal(f.content_type, "image/jpeg");
  }
  const ev = (e) => auditRows.filter((a) => a.event === e).map((a) => JSON.parse(a.detail));
  assert.equal(ev("stills.sheet").length, 1); assert.equal(ev("stills.sheet")[0].cast, "c1");
  assert.deepEqual(ev("stills.judge").map((d) => d.picture).sort(), ["01-sc-s1", "01-sc-s2", "02-sc-s1"]);
  assert.equal(ev("stills.judge")[0].score, 1);
  assert.equal(ev("stills.done").length, 1);
  assert.equal(paramsNow(jobs).stills.state, "done"); assert.equal(paramsNow(jobs).stills.drawn, 3); assert.equal(paramsNow(jobs).stills.total, 3);
  assert.equal(paramsNow(jobs).spec.v, 1, "the rest of the params is untouched");
  const report = JSON.parse(new TextDecoder().decode(kv.get("file:renders/gt_stills/fidelity.json").v));
  assert.equal(report.v, 1); assert.deepEqual(Object.keys(report.stills).sort(), ["01-sc-s1", "01-sc-s2", "02-sc-s1"]);
  assert.equal(report.sheets.c1.score, 1); assert.equal(report.summary.pictures, 3); assert.equal(report.summary.mean_score, 1);
  assert.ok(files.has("fidelity.json"));
  const n = calls.draws.length;
  assert.deepEqual(await drawJobStills(env, { ...job, params: jobs.get("gt_stills").params }, { deadline: Date.now() + 120_000 }), { state: "done", drawn: 3, total: 3 });
  assert.equal(calls.draws.length, n, "nothing is drawn twice");
});

test("drawJobStills: past the deadline it stops and says drawing; a quota answer fails the job's engine so the GPU draws the rest", async () => {
  const { ai, calls } = fakeAi();
  const { env, jobs } = fakeEnv({ AI: ai });
  const job = jobOf(jobs);
  const r = await drawJobStills(env, job, { deadline: Date.now() + EST_STILL_MS - 1000 });
  assert.equal(r.state, "drawing"); assert.equal(calls.draws.length, 0);
  assert.equal(paramsNow(jobs).stills.state, "drawing");
  const quota = fakeAi({ draw: () => { throw new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons"); } });
  const { env: env2, jobs: jobs2, auditRows } = fakeEnv({ AI: quota.ai });
  const q = await drawJobStills(env2, jobOf(jobs2), { deadline: Date.now() + 120_000 });
  assert.equal(q.state, "failed");
  assert.equal(JSON.parse(jobs2.get("gt_stills").params).stills.state, "failed");
  assert.match(JSON.parse(jobs2.get("gt_stills").params).stills.note, /4006/);
  assert.ok(auditRows.some((a) => a.event === "stills.sheet" && /4006/.test(a.detail)));
});

test("stillsEngineOn / stillsHold: the two film looks with an AI binding; the GPU waits only while the stills are drawing, and never past the give-up", () => {
  const job = { id: "j", user_id: "u", params: JSON.stringify({ format: "9:16" }), storyboard: JSON.stringify(STORYBOARD), phase: null };
  const ai = { run: async () => ({}) };
  assert.equal(stillsEngineOn({ AI: ai }, job), true);
  assert.equal(stillsEngineOn({ AI: ai, STILLS_ENGINE: "legacy" }, job), false);
  assert.equal(stillsEngineOn({}, job), false, "no binding, no engine");
  assert.equal(stillsEngineOn({ AI: ai, IMAGE_FIXTURE: "1" }, job), false);
  assert.equal(stillsEngineOn({ AI: ai }, { ...job, storyboard: JSON.stringify({ ...STORYBOARD, kleo_style: "cartoon" }) }), false, "cartoon keeps the old road");
  assert.equal(stillsEngineOn({ AI: ai }, { ...job, storyboard: null }), false);
  const withStills = (stills) => ({ ...job, params: JSON.stringify({ format: "9:16", stills }) });
  assert.equal(stillsHold({ AI: ai }, job), true, "not started yet: the next cron draws them");
  assert.equal(stillsHold({ AI: ai }, withStills({ state: "drawing", at: new Date().toISOString() })), true);
  assert.equal(stillsHold({ AI: ai }, withStills({ state: "drawing", at: new Date(Date.now() - 25 * 60_000).toISOString() })), false, "twenty minutes is the limit");
  assert.equal(stillsHold({ AI: ai }, withStills({ state: "done", at: new Date().toISOString() })), false);
  assert.equal(stillsHold({ AI: ai }, withStills({ state: "failed", at: new Date().toISOString() })), false);
  assert.equal(stillsHold({ AI: ai }, { ...job, phase: "finish" }), false, "the finish box never waits for stills");
});

/* ------------------------------------------------------------------ pauses, refusals, deadlines (24 September) */

test("stillsErrorVerdict: only the daily quota and a plain bug fail the engine; every other hiccup only pauses it", () => {
  assert.equal(stillsErrorVerdict(new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons")), "failed");
  for (const msg of ["AiError: 3040: Capacity temporarily exceeded, please try again later.", "still draw (x) timed out after 90000 ms", "429 Too Many Requests", "AiError: 503 Service Unavailable", "TypeError: fetch failed", "Error: Network connection lost.", "D1_ERROR: internal error"])
    assert.equal(stillsErrorVerdict(new Error(msg)), "pause", msg);
  assert.equal(stillsErrorVerdict(new TypeError("env.RENDERS.put is not a function")), "failed");
  assert.equal(stillsErrorVerdict(new TypeError("Cannot read properties of undefined (reading 'put')")), "failed");
});

test("pauseStills: still drawing, the start of the drawing kept (the give-up clock runs from it), one more pause counted", async () => {
  const { env, jobs, auditRows } = fakeEnv();
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const job = jobOf(jobs, { stills: { state: "drawing", at, drawn: 1, total: 3, pauses: 2 } });
  const r = await pauseStills(env, job, "AiError: 3040: Capacity temporarily exceeded");
  assert.deepEqual(r, { state: "drawing", drawn: 1, total: 3 });
  const st = paramsNow(jobs).stills;
  assert.equal(st.state, "drawing"); assert.equal(st.at, at); assert.equal(st.pauses, 3); assert.match(st.note, /3040/);
  assert.equal(JSON.parse(auditRows.find((a) => a.event === "stills.paused").detail).pauses, 3);
});

test("drawJobStills: a transient error on one still PAUSES the drawing (counted) instead of handing the film to the GPU; the next tick draws the rest", async () => {
  // 24 September: one "Capacity temporarily exceeded" on one picture of 48 used to mark the engine failed for the
  // whole film, and the GPU drew the other 47 with the 77-token SDXL although the next minute would have worked.
  let n = 0;
  const { ai } = fakeAi({ draw: (d) => { if (!d.prompt.startsWith("Character reference sheet") && ++n === 1) throw new Error("AiError: 3040: Capacity temporarily exceeded, please try again later."); } });
  const { env, jobs, auditRows } = fakeEnv({ AI: ai });
  const job = jobOf(jobs);
  const r = await drawJobStills(env, job, { deadline: Date.now() + 120_000 });
  assert.equal(r.state, "drawing"); assert.ok(r.drawn < 3);
  const st = paramsNow(jobs).stills;
  assert.equal(st.state, "drawing", "not failed: the GPU keeps waiting for the engine"); assert.equal(st.pauses, 1); assert.match(st.note, /3040/);
  assert.ok(auditRows.some((a) => a.event === "stills.paused"));
  assert.ok(auditRows.some((a) => a.event === "stills.error" && JSON.parse(a.detail).transient === true), "the picture is not given up for good");
  const r2 = await drawJobStills(env, { ...job, params: jobs.get("gt_stills").params }, { deadline: Date.now() + 120_000 });
  assert.deepEqual(r2, { state: "done", drawn: 3, total: 3 });
  assert.equal(paramsNow(jobs).stills.pauses, 1, "the count survives the end of the drawing, for the owner to read");
});

test("drawJobStills: a store that fails to keep a drawn still pauses too — the picture is drawn again next tick, never given up", async () => {
  const { ai } = fakeAi();
  const { env, jobs, auditRows } = fakeEnv({ AI: ai });
  const put = env.OAUTH_KV.put;
  let failures = 0;
  env.OAUTH_KV.put = async (k, v, o) => { if (k.includes("/img/") && failures++ === 0) throw new Error("Network connection lost."); return put(k, v, o); };
  const job = jobOf(jobs);
  const r = await drawJobStills(env, job, { deadline: Date.now() + 120_000 });
  assert.equal(r.state, "drawing");
  assert.equal(paramsNow(jobs).stills.pauses, 1);
  assert.ok(auditRows.some((a) => a.event === "stills.store_error"));
  assert.ok(!auditRows.some((a) => a.event === "stills.error"), "no picture is marked as refused");
  const r2 = await drawJobStills(env, { ...job, params: jobs.get("gt_stills").params }, { deadline: Date.now() + 120_000 });
  assert.deepEqual(r2, { state: "done", drawn: 3, total: 3 });
});

test("drawJobStills: a sheet the model refuses is asked for once, not on every tick; that character's shots are drawn from the words", async () => {
  let stillDraws = 0;
  const { ai, calls } = fakeAi({ draw: (d) => {
    if (d.prompt.startsWith("Character reference sheet")) throw new Error("AiError: 5016: the prompt was flagged by the safety filter");
    if (++stillDraws === 1) throw new Error("AiError: 3040: Capacity temporarily exceeded"); // so a second tick is needed
  } });
  const { env, jobs, auditRows } = fakeEnv({ AI: ai });
  const job = jobOf(jobs);
  const sheetDraws = () => calls.draws.filter((d) => d.prompt.startsWith("Character reference sheet")).length;
  assert.equal((await drawJobStills(env, job, { deadline: Date.now() + 120_000 })).state, "drawing");
  // A flagged answer is a failed try, not a lost sheet (24 September 2026): both seeds of the sheet are drawn, and
  // only when every try is flagged is the sheet given up.
  assert.equal(sheetDraws(), 2);
  assert.notEqual(calls.draws[0].seed, calls.draws[1].seed, "the second try is another seed");
  const refused = auditRows.filter((a) => a.event === "stills.sheet").map((a) => JSON.parse(a.detail));
  assert.equal(refused.length, 1); assert.equal(refused[0].transient, false); assert.match(refused[0].error, /5016/);
  const r2 = await drawJobStills(env, { ...job, params: jobs.get("gt_stills").params }, { deadline: Date.now() + 120_000 });
  assert.deepEqual(r2, { state: "done", drawn: 3, total: 3 });
  assert.equal(sheetDraws(), 2, "the refused sheet is not asked for again");
  const stills = calls.draws.filter((d) => !d.prompt.startsWith("Character reference sheet"));
  assert.ok(stills.every((d) => d.refs === 0 || d.prompt.includes("the drawing style of this film")), "no sheet: the only reference is the style anchor");
});

test("drawJobStills: the sheets a tick drew are in fidelity.json even when the tick stops before the stills", async () => {
  const { ai, calls } = fakeAi();
  const { env, jobs, kv } = fakeEnv({ AI: ai });
  const job = jobOf(jobs);
  job.storyboard = JSON.stringify({ ...STORYBOARD, direction: { ...DIRECTION, cast: [...DIRECTION.cast, { name: "Tomas", look: "a tall old baker with a grey beard" }] } });
  // Since 25 September 2026 the sheets are drawn side by side (STILLS_CONCURRENCY): both start before the stop.
  const r = await drawJobStills(env, job, { deadline: Date.now() + 120_000, stop: () => calls.draws.length >= 1 });
  assert.equal(r.state, "drawing"); assert.equal(calls.draws.length, 2, "the two sheets, then the tick stops before any still");
  assert.ok(calls.draws.every((d) => d.prompt.startsWith("Character reference sheet of")));
  const report = () => JSON.parse(new TextDecoder().decode(kv.get("file:renders/gt_stills/fidelity.json").v));
  assert.deepEqual(Object.keys(report().sheets).sort(), ["c1", "d-tomas"], "the sheets drawn before the stop are reported");
  const r2 = await drawJobStills(env, { ...job, params: jobs.get("gt_stills").params }, { deadline: Date.now() + 120_000 });
  assert.equal(r2.state, "done");
  assert.deepEqual(Object.keys(report().sheets).sort(), ["c1", "d-tomas"]);
});

test("drawStill: past `until` no redraw starts — the first try stands, so a still in flight at a tick's deadline cannot outlive the tick", async () => {
  const late = fakeAi({ answer: () => "no" }); // every must fails
  const r = await drawStill({ AI: late.ai }, input(), { attempts: 3, until: Date.now() - 1 });
  assert.equal(late.calls.draws.length, 1); assert.ok(r.mustFailed > 0);
  const early = fakeAi({ answer: () => "no" });
  await drawStill({ AI: early.ai }, input(), { attempts: 3, until: Date.now() + 60_000 });
  assert.equal(early.calls.draws.length, 3, "with time left the tries run as before");
});

/* ------------------------------------------------------------------ the fidelity bench fixes (24 September) */

/** Fails the questions matching `re` on the first draw only: "no" to one that expects yes, "yes" to one that expects no. */
const failFirst = (re) => (q, n) => {
  const negative = /any written text|any of this/i.test(q);
  const fail = n === 1 && re.test(q);
  return negative ? (fail ? "yes" : "no") : (fail ? "no" : "yes");
};
const FLAGGED = "AiError: 3030: Your output has been flagged. Please choose another prompt / input image combination";

test("checks: one identity question per character drawn from a sheet; none without the sheet, none on the sheet itself", async () => {
  const c = compileStill(input());
  assert.deepEqual(c.checks.find((x) => x.id === "identity:c1"), { id: "identity:c1", question: "Is the main character in the first image the same individual as the reference image of Mara (same face, hair and clothes)?", expect: "yes", must: true });
  assert.equal(c.checks.filter((x) => x.id.startsWith("identity:")).length, 1);
  assert.ok(!compileStill(input({ refs: [] })).checks.some((x) => x.id.startsWith("identity:")), "no sheet, no identity question");
  assert.ok(!compileStill(input({ refs: [{ label: "the place (a bakery)", image: IMG(2) }] })).checks.some((x) => x.id.startsWith("identity:")), "a place is not a character");
  // Two characters from two sheets: each is asked whether SOME character is them, not whether the main one is.
  const two = compileStill(input({
    direction: { ...DIRECTION, cast: [...DIRECTION.cast, { name: "Tomas", look: "a tall old baker with a grey beard" }] },
    shot: shot({ cast: ["c1", "Tomas"] }), refs: [{ label: "Mara", image: IMG(1) }, { label: "Tomas", image: IMG(2) }],
  }));
  assert.deepEqual(two.checks.filter((x) => x.id.startsWith("identity:")).map((x) => [x.id, x.question]), [
    ["identity:c1", "Does the first image show a character who is the same individual as the reference image of Mara (same face, hair and clothes)?"],
    ["identity:tomas", "Does the first image show a character who is the same individual as the reference image of Tomas (same face, hair and clothes)?"],
  ]);
  // With two characters the identity questions are soft: the judge mixed them up on the first production probe.
  assert.ok(two.checks.filter((x) => x.id.startsWith("identity:")).every((x) => x.must === false));
  // The judge is asked it with the sheet after the picture; a miss is written back as what the picture must do.
  const { ai, calls } = fakeAi({ answer: failFirst(/same individual/) });
  const r = await drawStill({ AI: ai }, input());
  assert.ok(calls.judges[0].qs.some((x) => /same individual as the reference image of Mara/.test(x.q)));
  assert.equal(calls.judges[0].images, 2);
  assert.deepEqual(r.tries.map((t) => t.failed), [["identity:c1"], []]);
  assert.ok(calls.draws[1].prompt.startsWith("It is essential that: Mara is exactly the same person as in their reference image, with the same face, the same hair and the same clothes."), calls.draws[1].prompt);
  assert.ok(r.checks.includes("identity:c1"));
  // The sheet IS the reference: it is never judged against itself, nor against the user's photo it was drawn from.
  const sheet = fakeAi();
  await drawCastSheet({ AI: sheet.ai }, SPEC, SPEC.cast[0], "realistic", IMG(5));
  assert.ok(!sheet.calls.judges[0].qs.some((x) => /same individual/.test(x.q)));
});

test("drawStill: a try with no failed must is the still, whatever its score — a soft miss never buys a redraw", async () => {
  // The bench: stills whose musts all passed were drawn again for a weighted score under STILL_PASS (0.85).
  const spec = { ...SPEC, items: [...SPEC.items, { id: "R8", kind: "event", text: "Mara organizes a surprise party for her best friend", quote: "festa a sorpresa", must: true, who: "c1", order: 1 }] };
  const soft = fakeAi({ answer: (q) => (/any of this/i.test(q) ? "no" : /any written text/i.test(q) ? "yes" : /moment of this|in this style/i.test(q) ? "no" : "yes") });
  const r = await drawStill({ AI: soft.ai }, input({ spec, shot: shot({ covers: ["R2", "R3", "R8"] }) }));
  assert.equal(soft.calls.draws.length, 1, "one draw: nothing a must asked for was missing");
  assert.equal(r.mustFailed, 0); assert.ok(r.score < 0.85, String(r.score));
  assert.deepEqual([...r.failed].sort(), ["R7", "R8", "no-text"]);
  assert.equal(soft.calls.judges[0].qs.find((x) => /surprise party/.test(x.q)).q, "Could this image be a moment of this: Mara organizes a surprise party for her best friend?", "a story beat is asked softly");
});

test("drawStill: two tries by default (was three), the last on 9B after a missed look; STILL_ATTEMPTS still sets it", async () => {
  const two = fakeAi({ answer: () => "no" });
  const r = await drawStill({ AI: two.ai }, input());
  assert.equal(two.calls.draws.length, 2); assert.ok(r.mustFailed > 0);
  assert.deepEqual(two.calls.draws.map((d) => d.model), [DEFAULT_STILL_MODEL, DEFAULT_STRONG_STILL_MODEL]);
  const three = fakeAi({ answer: () => "no" });
  await drawStill({ AI: three.ai, STILL_ATTEMPTS: "3" }, input());
  assert.equal(three.calls.draws.length, 3);
});

test("drawStill: the strong model redraws only a missed look, identity or text; a missed style, exclusion or place is redrawn on the cheap one", async () => {
  const second = async (re, inp = input()) => {
    const { ai, calls } = fakeAi({ answer: failFirst(re) });
    const r = await drawStill({ AI: ai }, inp);
    assert.equal(calls.draws.length, 2, String(re));
    assert.equal(r.mustFailed, 0, String(re));
    return calls.draws[1].model;
  };
  const sign = input({ shot: shot({ covers: ["R4", "R5"], shot_kind: "establish", cast: [], image_prompt: "The bakery front with its shop sign" }), refs: [] });
  assert.equal(await second(/lilac apron/), DEFAULT_STRONG_STILL_MODEL, "a look");
  assert.equal(await second(/same individual/), DEFAULT_STRONG_STILL_MODEL, "an identity");
  assert.equal(await second(/character matching this description/, input({ spec: null })), DEFAULT_STRONG_STILL_MODEL, "a character's whole look");
  assert.equal(await second(/clearly written and readable/, sign), DEFAULT_STRONG_STILL_MODEL, "a text");
  assert.equal(await second(/real photograph/), DEFAULT_STILL_MODEL, "the style");
  assert.equal(await second(/any of this/), DEFAULT_STILL_MODEL, "an exclusion");
  assert.equal(await second(/village bakery/, sign), DEFAULT_STILL_MODEL, "a place");
});

test("drawStill: a flagged draw is a failed try — the next seed is drawn; two in a row, once without the sheets; only all flagged fails the still", async () => {
  // The bench: "AiError: 3030: Your output has been flagged" (a warrior with a sword) lost the whole still as an error.
  const once = fakeAi({ draw: (d, n) => { if (n === 1) throw new Error(FLAGGED); } });
  const r = await drawStill({ AI: once.ai }, input(), { seedBase: 200 });
  assert.deepEqual(once.calls.draws.map((d) => [d.seed, d.refs, d.model]), [[200, 1, DEFAULT_STILL_MODEL], [201, 1, DEFAULT_STILL_MODEL]], "the sheet kept, the seed changed, no escalation on a refusal");
  assert.equal(once.calls.judges.length, 1); assert.equal(drawnNo(r.bytes), 2); assert.equal(r.mustFailed, 0);
  assert.deepEqual(r.tries.map((t) => t.failed), [["flagged"], []]);
  // Two flagged answers in a row: one more try WITHOUT the reference images, even past the two tries.
  const twice = fakeAi({ draw: (d) => { if (d.refs) throw new Error(FLAGGED); } });
  const t = await drawStill({ AI: twice.ai }, input(), { seedBase: 300 });
  assert.deepEqual(twice.calls.draws.map((d) => [d.seed, d.refs]), [[300, 1], [301, 1], [302, 0]]);
  assert.ok(!twice.calls.draws[2].prompt.includes("(reference image 1)"), "the prompt no longer names a reference it does not pass");
  assert.equal(t.mustFailed, 0); assert.ok(!t.checks.some((id) => id.startsWith("identity:")), "no sheet passed, no identity asked");
  // Every try flagged: the still fails as before, with the refusal's own message (drawJobStills gives the picture up).
  const always = fakeAi({ draw: () => { throw new Error(FLAGGED); } });
  await assert.rejects(drawStill({ AI: always.ai }, input()), /flagged/);
  assert.equal(always.calls.draws.length, 3, "two seeds with the sheet, one without");
  assert.equal(always.calls.judges.length, 0);
  const bare = fakeAi({ draw: () => { throw new Error(FLAGGED); } });
  await assert.rejects(drawStill({ AI: bare.ai }, input({ refs: [] })), /3030/);
  assert.equal(bare.calls.draws.length, 2, "no reference to drop: the two tries, then the refusal");
});

/* ------------------------------------------------------------------ the external roads (25 September 2026) */

// The owner, 25 September 2026: stills at Higgsfield quality. Nano Banana Pro through OpenRouter or kie.ai, klein-4B
// the fallback when the account cannot pay. Every network call below goes to a fake `fetch` (restored after each test,
// with the kie.ai poll timing, by the hooks at the top of this file).
const PNG = () => { const b = new Uint8Array(64); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };
const JPG = (n = 1) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 7, 7, 7]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const jsonRes = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const NBP_OR = "openrouter:google/gemini-3-pro-image-preview";

/** A fake OpenRouter: records every request, answers `reply(body, n)` (a Response), by default one PNG in message.images with usage.cost. */
function fakeOpenRouter(reply) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), headers: init.headers, body });
    if (reply) return reply(body, calls.length);
    return jsonRes({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64(PNG())}` } }] } }], usage: { cost: 0.138 } });
  };
  return { calls, fetch };
}

/**
 * A fake kie.ai for the image models: createTask answers a task id (or what `script.create` returns), recordInfo says
 * "generating" on a task's first look and "success" on the second (or what `script.state(taskId, n)` says), with
 * creditsConsumed; the result file is a small JPEG.
 */
function fakeKieImages(script = {}) {
  const calls = { create: [], record: 0, downloads: 0 };
  const polls = new Map();
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === "https://api.kie.ai/api/v1/jobs/createTask") {
      const body = JSON.parse(init.body);
      calls.create.push({ body, auth: init.headers.authorization });
      const custom = script.create?.(body, calls.create.length);
      if (custom) return custom;
      return jsonRes({ code: 200, msg: "success", data: { taskId: `task_${calls.create.length}` } });
    }
    if (u.startsWith("https://api.kie.ai/api/v1/jobs/recordInfo?")) {
      calls.record++;
      const taskId = new URL(u).searchParams.get("taskId");
      const n = (polls.get(taskId) ?? 0) + 1; polls.set(taskId, n);
      const state = script.state?.(taskId, n) ?? (n < 2 ? "generating" : "success");
      const done = state === "success";
      return jsonRes({ code: 200, msg: "success", data: {
        taskId, state, resultJson: done ? JSON.stringify({ resultUrls: [`https://tempfile.kie.test/${taskId}.jpg`] }) : "",
        failCode: state === "fail" ? (script.failCode ?? "400") : "", failMsg: state === "fail" ? (script.failMsg ?? "bad input") : "",
        creditsConsumed: done ? (script.credits === undefined ? 18 : script.credits) : null,
      } });
    }
    if (u.startsWith("https://tempfile.kie.test/")) { calls.downloads++; return new Response(JPG(calls.downloads), { status: 200 }); }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { calls, fetch };
}
const rejection = async (p) => { try { await p; } catch (e) { return e; } assert.fail("expected a rejection"); };

test("stillProviderOf / strongStillModel / fallbackStillModel / sizes / prices: the id names the road; an external main model has no klein-9B escalation", () => {
  assert.deepEqual(stillProviderOf(DEFAULT_STILL_MODEL), { provider: "workers-ai", id: DEFAULT_STILL_MODEL });
  assert.deepEqual(stillProviderOf(NBP_OR), { provider: "openrouter", id: "google/gemini-3-pro-image-preview" });
  assert.deepEqual(stillProviderOf("kie:nano-banana-pro"), { provider: "kie", id: "nano-banana-pro" });
  assert.equal(strongStillModel({}), DEFAULT_STRONG_STILL_MODEL, "the klein ladder is unchanged");
  assert.equal(strongStillModel({ STILL_MODEL: "kie:nano-banana-pro" }), null, "nothing on Workers AI draws better than Nano Banana Pro");
  assert.equal(strongStillModel({ STILL_MODEL: "kie:nano-banana-2", STILL_MODEL_STRONG: "kie:nano-banana-pro" }), "kie:nano-banana-pro", "an explicit escalation is honoured");
  assert.equal(fallbackStillModel({}), DEFAULT_STILL_MODEL);
  assert.equal(fallbackStillModel({ STILL_MODEL_FALLBACK: "none" }), null);
  assert.equal(aspectRatioOf(STILL_SIZES["9:16"]), "9:16"); assert.equal(aspectRatioOf(STILL_SIZES["16:9"]), "16:9"); assert.equal(aspectRatioOf(SHEET_SIZE), "3:4");
  assert.equal(imageTierOf(STILL_SIZES["9:16"]), "2K"); assert.equal(imageTierOf(SHEET_SIZE), "1K");
  assert.equal(stillPriceUsd("kie:nano-banana-pro", STILL_SIZES["9:16"]), 0.09);
  assert.equal(stillPriceUsd("kie:nano-banana-2", STILL_SIZES["9:16"]), 0.06); assert.equal(stillPriceUsd("kie:nano-banana-2", SHEET_SIZE), 0.04);
  assert.equal(stillPriceUsd(NBP_OR, STILL_SIZES["9:16"]), 0.138);
  assert.equal(stillPriceUsd(DEFAULT_STILL_MODEL, STILL_SIZES["9:16"]), 0.0023, "8 tiles of 512x512");
  assert.equal(stillPriceUsd(DEFAULT_STRONG_STILL_MODEL, STILL_SIZES["9:16"]), 0.016);
  assert.equal(stillPriceUsd("kie:some-other-model", STILL_SIZES["9:16"]), null);
});

test("drawImage on @cf/…: the Workers AI binding as before, never the network; the price from the table", async () => {
  globalThis.fetch = async () => { throw new Error("no network on the Workers AI road"); };
  const { ai, calls } = fakeAi();
  const d = await drawImage({ AI: ai }, DEFAULT_STILL_MODEL, "a prompt", STILL_SIZES["9:16"], [{ ...IMG(1), url: "https://kleo.test/x" }], 5);
  assert.equal(calls.draws.length, 1); assert.equal(calls.draws[0].refs, 1, "the bytes go as input_image_0; the url is not needed");
  assert.deepEqual([calls.draws[0].width, calls.draws[0].height, calls.draws[0].seed], [896, 1600, 5]);
  assert.equal(d.bytes[0], 0xff); assert.equal(d.usd, 0.0023); assert.equal(d.reported, false);
});

test("drawImage on openrouter:…: one chat completion — prompt, references as data URLs, aspect ratio and 1K — the picture from message.images, the cost from usage.cost", async () => {
  const or = fakeOpenRouter(); globalThis.fetch = or.fetch;
  const d = await drawImage({ IMAGE_API_KEY: "or-key", PLAN_API_KEY: "plan-key" }, NBP_OR, "Two friends at the bakery door", STILL_SIZES["9:16"], [{ ...IMG(1), url: "https://kleo.test/a" }, IMG(2)], 42);
  assert.equal(or.calls.length, 1);
  const { url, headers, body } = or.calls[0];
  assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(headers.authorization, "Bearer or-key", "IMAGE_API_KEY wins over PLAN_API_KEY");
  assert.equal(body.model, "google/gemini-3-pro-image-preview");
  assert.deepEqual(body.modalities, ["image", "text"]);
  assert.deepEqual(body.image_config, { aspect_ratio: "9:16", image_size: "1K" }, "1K, the size measured: a 2K PNG would travel inline to the judge");
  assert.equal(body.seed, 42);
  const content = body.messages[0].content;
  assert.equal(body.messages[0].role, "user");
  assert.deepEqual(content[0], { type: "text", text: "Two friends at the bakery door" });
  assert.equal(content.length, 3, "the prompt, then every reference in order");
  assert.equal(content[1].type, "image_url"); assert.equal(content[1].image_url.url, `data:image/jpeg;base64,${b64(IMG(1).bytes)}`);
  assert.equal(d.bytes[0], 0x89, "the PNG of message.images[0]"); assert.equal(d.usd, 0.138); assert.equal(d.reported, true);
  // Another base URL and the planner's key; the picture as a content part, no usage: the price table says 0.138.
  const alt = fakeOpenRouter(() => jsonRes({ choices: [{ message: { content: [{ type: "text", text: "here it is" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64(JPG(9))}` } }] } }] }));
  globalThis.fetch = alt.fetch;
  const s = await drawImage({ IMAGE_API_URL: "https://proxy.test/v1/", PLAN_API_KEY: "plan-key" }, NBP_OR, "a sheet", SHEET_SIZE, [], 1);
  assert.equal(alt.calls[0].url, "https://proxy.test/v1/chat/completions"); assert.equal(alt.calls[0].headers.authorization, "Bearer plan-key");
  assert.deepEqual(alt.calls[0].body.image_config, { aspect_ratio: "3:4", image_size: "1K" }, "a sheet is asked at 1K, 3:4");
  assert.equal(alt.calls[0].body.messages[0].content.length, 1);
  assert.equal(s.bytes[4], 9); assert.equal(s.usd, 0.138); assert.equal(s.reported, false);
  assert.equal(openRouterImageUrl({ content: `Sure! ![img](data:image/png;base64,${b64(PNG())})` }), `data:image/png;base64,${b64(PNG())}`, "a data URL written in the text");
  assert.equal(openRouterImageUrl({ content: "I cannot draw that." }), null);
  // A model that is not Gemini gets no image_size.
  const flux = fakeOpenRouter(); globalThis.fetch = flux.fetch;
  await drawImage({ IMAGE_API_KEY: "k" }, "openrouter:black-forest-labs/flux-2-pro", "p", STILL_SIZES["16:9"], [], 1);
  assert.deepEqual(flux.calls[0].body.image_config, { aspect_ratio: "16:9" });
});

test("drawImage on openrouter:…: no key, 402 and a 200 carrying error 402 are money (fallback); 429 is 'not now' (pause); an answer without a picture is flagged, and billed", async () => {
  const none = await rejection(drawImage({}, NBP_OR, "p", STILL_SIZES["9:16"], [], 1));
  assert.equal(fallbackReason(none), "unauthorized");
  globalThis.fetch = fakeOpenRouter(() => jsonRes({ error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/credits" } }, 402)).fetch;
  const poor = await rejection(drawImage({ IMAGE_API_KEY: "k" }, NBP_OR, "p", STILL_SIZES["9:16"], [], 1));
  assert.equal(fallbackReason(poor), "no credit"); assert.equal(isTransientError(poor), false);
  globalThis.fetch = fakeOpenRouter(() => jsonRes({ error: { code: 402, message: "This request requires more credits" } }, 200)).fetch;
  assert.equal(fallbackReason(await rejection(drawImage({ IMAGE_API_KEY: "k" }, NBP_OR, "p", STILL_SIZES["9:16"], [], 1))), "no credit");
  globalThis.fetch = fakeOpenRouter(() => jsonRes({ error: { code: 401, message: "No auth credentials found" } }, 401)).fetch;
  assert.equal(fallbackReason(await rejection(drawImage({ IMAGE_API_KEY: "k" }, NBP_OR, "p", STILL_SIZES["9:16"], [], 1))), "unauthorized");
  globalThis.fetch = fakeOpenRouter(() => jsonRes({ error: { code: 429, message: "Rate limit exceeded" } }, 429)).fetch;
  const busy = await rejection(drawImage({ IMAGE_API_KEY: "k" }, NBP_OR, "p", STILL_SIZES["9:16"], [], 1));
  assert.equal(fallbackReason(busy), null); assert.equal(isTransientError(busy), true); assert.equal(stillsErrorVerdict(busy), "pause");
  globalThis.fetch = fakeOpenRouter(() => jsonRes({ error: { code: 502, message: "Provider returned error" } }, 502)).fetch;
  assert.equal(stillsErrorVerdict(await rejection(drawImage({ IMAGE_API_KEY: "k" }, NBP_OR, "p", STILL_SIZES["9:16"], [], 1))), "pause");
  globalThis.fetch = fakeOpenRouter(() => jsonRes({ choices: [{ finish_reason: "stop", message: { content: "I can't generate images of real people." } }], usage: { cost: 0.01 } })).fetch;
  const refused = await rejection(drawImage({ IMAGE_API_KEY: "k" }, NBP_OR, "p", STILL_SIZES["9:16"], [], 1));
  assert.equal(isFlaggedError(refused), true, "drawJudged draws the next seed"); assert.equal(fallbackReason(refused), null); assert.equal(refused.usd, 0.01);
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  assert.equal(stillsErrorVerdict(await rejection(drawImage({ IMAGE_API_KEY: "k" }, NBP_OR, "p", STILL_SIZES["9:16"], [], 1))), "pause");
});

test("drawImage on kie:nano-banana-pro: createTask with the signed links only, 2K JPEG, polled until success; the cost from creditsConsumed", async () => {
  const kie = fakeKieImages(); globalThis.fetch = kie.fetch;
  const sheetUrl = "https://kleo.test/dl/gt_x/ref%2Fcast%2Fc1.jpg?exp=1&sig=ab";
  const d = await drawImage({ KIE_API_KEY: "kie-key" }, "kie:nano-banana-pro", "Mara at the counter", STILL_SIZES["9:16"], [{ ...IMG(1), url: sheetUrl }, IMG(2)], 7);
  assert.deepEqual(kie.calls.create[0].body, { model: "nano-banana-pro", input: { prompt: "Mara at the counter", image_input: [sheetUrl], aspect_ratio: "9:16", resolution: "2K", output_format: "jpg" } });
  assert.equal(kie.calls.create[0].auth, "Bearer kie-key");
  assert.equal(kie.calls.record, 2, "generating, then success"); assert.equal(kie.calls.downloads, 1);
  assert.equal(d.bytes[0], 0xff); assert.equal(d.usd, 0.09, "18 credits of 0.005 $"); assert.equal(d.reported, true);
  // Nano Banana 2, a sheet: 1K, 3:4; no creditsConsumed → the price table.
  const nb2 = fakeKieImages({ credits: null }); globalThis.fetch = nb2.fetch;
  const s = await drawImage({ KIE_API_KEY: "kie-key" }, "kie:nano-banana-2", "a sheet", SHEET_SIZE, [], 1);
  assert.deepEqual(nb2.calls.create[0].body.input, { prompt: "a sheet", image_input: [], aspect_ratio: "3:4", resolution: "1K", output_format: "jpg" });
  assert.equal(nb2.calls.create[0].body.model, "nano-banana-2");
  assert.equal(s.usd, 0.04); assert.equal(s.reported, false);
  assert.deepEqual(kieStillInput("nano-banana-2-lite", { prompt: "p", urls: ["https://a"], size: STILL_SIZES["16:9"] }), { prompt: "p", image_urls: ["https://a"], aspect_ratio: "16:9" });
  // A recordInfo hiccup is asked again, not counted against the task (the task is paid for either way).
  let hiccup = 0;
  const flaky = fakeKieImages();
  globalThis.fetch = async (u, i) => (String(u).includes("recordInfo") && hiccup++ === 0 ? jsonRes({ code: 503, msg: "busy" }, 503) : flaky.fetch(u, i));
  assert.equal((await drawImage({ KIE_API_KEY: "k" }, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [], 1)).usd, 0.09);
});

test("drawImage on kie:…: a failed task (flagged when kie.ai names a policy), a timeout that pauses, and a refusal for money", async () => {
  globalThis.fetch = fakeKieImages({ state: () => "fail", failCode: "400", failMsg: "The content violates the content policy" }).fetch;
  const flagged = await rejection(drawImage({ KIE_API_KEY: "k" }, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [], 1));
  assert.match(String(flagged), /failed \[code_400\]: The content violates the content policy \(flagged\)/); assert.equal(isFlaggedError(flagged), true);
  // A task that RAN and failed — even with "500" and "timed out" in its words — is a failed try: never a pause (the
  // next tick would collect the same failed task and pause again until the give-up), never the account.
  globalThis.fetch = fakeKieImages({ state: () => "fail", failCode: "500", failMsg: "internal error 500, generation timed out" }).fetch;
  const broke = await rejection(drawImage({ KIE_API_KEY: "k" }, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [], 1));
  assert.equal(isFlaggedError(broke), false); assert.equal(isTaskFailure(broke), true);
  assert.equal(isTransientError(broke), true, "the generic reader would have paused on it");
  assert.equal(isTransientStillError(broke), false, "so drawJobStills never pauses on it"); assert.equal(fallbackReason(broke), null);
  assert.match(String(broke), /\[code_500\]/);
  // Never finished: polled until the window closes, then a timeout — a pause for the job, never a fallback.
  Object.assign(KIE_STILL_POLL, { firstMs: 5, everyMs: 5, minMs: 40, maxMs: 80 });
  const slow = fakeKieImages({ state: () => "generating" }); globalThis.fetch = slow.fetch;
  const t0 = Date.now();
  const late = await rejection(drawImage({ KIE_API_KEY: "k" }, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [], 1));
  assert.match(String(late), /timed out after \d+ ms \(kie\.ai task task_1 still generating\)/);
  assert.ok(Date.now() - t0 >= 35, "it waited its minimum"); assert.ok(slow.calls.record >= 2);
  assert.equal(isTransientError(late), true); assert.equal(stillsErrorVerdict(late), "pause"); assert.equal(fallbackReason(late), null);
  assert.equal(late.usd, 0.09, "the task was created, so it is paid for: the timeout carries its price");
  // Money: code 402, and the code 500 "Credits insufficient" kie.ai really answered on 13 September.
  globalThis.fetch = fakeKieImages({ create: () => jsonRes({ code: 402, msg: "insufficient credits" }) }).fetch;
  assert.equal(fallbackReason(await rejection(drawImage({ KIE_API_KEY: "k" }, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [], 1))), "no credit");
  globalThis.fetch = fakeKieImages({ create: () => jsonRes({ code: 500, msg: "Credits insufficient : Your current balance isn’t enough to run this request." }) }).fetch;
  assert.equal(fallbackReason(await rejection(drawImage({ KIE_API_KEY: "k" }, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [], 1))), "no credit");
  globalThis.fetch = fakeKieImages({ create: () => jsonRes({ code: 401, msg: "You do not have access permissions" }, 401) }).fetch;
  assert.equal(fallbackReason(await rejection(drawImage({ KIE_API_KEY: "k" }, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [], 1))), "unauthorized");
  assert.equal(fallbackReason(await rejection(drawImage({}, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [], 1))), "unauthorized", "no KIE_API_KEY");
});

test("drawStill on kie:…: a reference without a link is not passed, not named in the prompt, not asked about; after a 402 the same try is redrawn on klein-4B WITH it", async () => {
  const kie = fakeKieImages(); globalThis.fetch = kie.fetch;
  const { ai, calls } = fakeAi();
  const env = { AI: ai, STILL_MODEL: "kie:nano-banana-pro", KIE_API_KEY: "k" };
  const r = await drawStill(env, input());
  assert.equal(calls.draws.length, 0, "drawn on kie.ai, judged on Workers AI");
  assert.deepEqual(kie.calls.create[0].body.input.image_input, []);
  assert.ok(!kie.calls.create[0].body.input.prompt.includes("(reference image 1)"), "the prompt never names an image the model does not get");
  assert.ok(!calls.judges[0].qs.some((x) => /same individual/.test(x.q)), "no identity question against a sheet the model never saw");
  assert.equal(calls.judges[0].images, 1);
  assert.equal(r.usd, 0.09); assert.equal(r.tries[0].usd, 0.09); assert.equal(r.tries[0].model, undefined, "no escalation, no fallback: no model tag");
  // With a signed link the sheet goes, and the identity question comes back.
  const kie2 = fakeKieImages(); globalThis.fetch = kie2.fetch;
  const judged = fakeAi();
  await drawStill({ ...env, AI: judged.ai }, input({ refs: [{ label: "Mara", image: IMG(1), url: "https://kleo.test/dl/gt/ref%2Fcast%2Fc1.jpg?exp=1&sig=a" }] }));
  assert.equal(kie2.calls.create[0].body.input.image_input.length, 1);
  assert.ok(kie2.calls.create[0].body.input.prompt.includes("Mara (reference image 1)"));
  assert.ok(judged.calls.judges[0].qs.some((x) => /same individual as the reference image of Mara/.test(x.q)));
  // No credit: the same try, same seed, on klein-4B with the sheet's bytes; a forced model (the bench) is never swapped.
  globalThis.fetch = fakeKieImages({ create: () => jsonRes({ code: 402, msg: "insufficient credits" }) }).fetch;
  const poor = fakeAi();
  const f = await drawStill({ ...env, AI: poor.ai }, input(), { seedBase: 300 });
  assert.equal(poor.calls.draws.length, 1); assert.equal(poor.calls.draws[0].model, DEFAULT_STILL_MODEL); assert.equal(poor.calls.draws[0].seed, 300);
  assert.equal(poor.calls.draws[0].refs, 1); assert.ok(poor.calls.draws[0].prompt.includes("Mara (reference image 1)"));
  assert.equal(f.tries[0].model, DEFAULT_STILL_MODEL, "a try drawn after a fallback says by what"); assert.equal(f.usd, 0.0023);
  const forced = await rejection(drawStill({ ...env, AI: fakeAi().ai }, input(), { model: "kie:nano-banana-pro" }));
  assert.equal(fallbackReason(forced), "no credit");
});

test("drawJobStills on kie:nano-banana-pro: the sheet, then every still with its references as signed /dl links (the sheet, the first still as style anchor); /dl serves them, none is a job file; stills.done says 0.36 $", async () => {
  const kie = fakeKieImages(); globalThis.fetch = kie.fetch;
  const { ai, calls } = fakeAi();
  const { env, jobs, files, auditRows, kv } = fakeEnv({ AI: ai, STILL_MODEL: "kie:nano-banana-pro", KIE_API_KEY: "kie-key", PUBLIC_URL: "https://kleo.test" });
  const job = jobOf(jobs);
  assert.deepEqual(await drawJobStills(env, job, { deadline: Date.now() + 120_000 }), { state: "done", drawn: 3, total: 3 });
  assert.equal(calls.draws.length, 0, "no picture drawn on Workers AI");
  const bodies = kie.calls.create.map((c) => c.body);
  assert.equal(bodies.length, 4, "one sheet, three stills, one try each");
  const sheet = bodies[0].input;
  assert.ok(sheet.prompt.startsWith("Character reference sheet of Mara"), sheet.prompt);
  assert.deepEqual([sheet.image_input, sheet.resolution, sheet.aspect_ratio, sheet.output_format], [[], "1K", "3:4", "jpg"]);
  const link = (name) => new RegExp(`^https://kleo\\.test/dl/gt_stills/${encodeURIComponent(name).replace(/[.]/g, "\\.")}\\?exp=\\d+&sig=[0-9a-f]{64}$`);
  const byPrompt = (s) => bodies.find((b) => b.input.prompt.includes(s)).input;
  const apron = byPrompt("ties her lilac apron"), front = byPrompt("bakery front"), smile = byPrompt("smiles at the finished cake");
  assert.equal(apron.image_input.length, 1); assert.match(apron.image_input[0], link(sheetLinkName("c1")), "Mara's shot is drawn from her sheet");
  assert.deepEqual([apron.resolution, apron.aspect_ratio], ["2K", "9:16"]);
  assert.equal(front.image_input.length, 1); assert.match(front.image_input[0], link("img/01-sc-s1.jpg"), "the first still is the style anchor");
  assert.equal(smile.image_input.length, 2); assert.match(smile.image_input[0], link(sheetLinkName("c1"))); assert.match(smile.image_input[1], link("img/01-sc-s1.jpg"));
  assert.ok(![...files.keys()].some((n) => n.startsWith("ref/") || n.startsWith("cast/")), "a reference link is never a job file");
  // The links kie.ai was given are served by /dl: the sheet from its key, the anchor from the job files.
  for (const url of [apron.image_input[0], front.image_input[0]]) {
    const res = await handleDownload(new Request(url), env);
    assert.equal(res.status, 200, url); assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(new Uint8Array(await res.arrayBuffer())[0], 0xff);
  }
  assert.equal((await handleDownload(new Request(apron.image_input[0].replace(/sig=[0-9a-f]{64}/, `sig=${"0".repeat(64)}`)), env)).status, 403, "the signature still guards it");
  const done = auditRows.filter((a) => a.event === "stills.done").map((a) => JSON.parse(a.detail));
  assert.equal(done.length, 1); assert.equal(done[0].model, "kie:nano-banana-pro"); assert.equal(done[0].usd, 0.36, "four pictures at 18 credits");
  assert.equal(done[0].fallback, undefined);
  const report = JSON.parse(new TextDecoder().decode(kv.get("file:renders/gt_stills/fidelity.json").v));
  assert.equal(report.summary.usd, 0.36); assert.equal(report.sheets.c1.usd, 0.09); assert.equal(report.stills["01-sc-s1"].usd, 0.09);
});

test("referenceLinkKey: a sheet name maps under the job, a kref under the job OWNER's refs; anything else is refused", async () => {
  assert.equal(await referenceLinkKey({}, { id: "gt_x", user_id: "u1" }, "ref/cast/c1.jpg"), castSheetKey("gt_x", "c1"));
  const RENDERS = { async get(k) { return k === "refs/u1/kref_0a1b2c3d.json" ? { text: async () => JSON.stringify({ handle: "kref_0a1b2c3d", mime: "image/png" }) } : null; } };
  assert.equal(await referenceLinkKey({ RENDERS }, { id: "gt_x", user_id: "u1" }, "ref/kref_0a1b2c3d"), "refs/u1/kref_0a1b2c3d.png");
  assert.equal(await referenceLinkKey({ RENDERS }, { id: "gt_x", user_id: "u2" }, "ref/kref_0a1b2c3d"), null, "another account's picture is not there");
  for (const bad of ["ref/cast/../x.jpg", "ref/cast/C1.jpg", "ref/kref_xyz", "cast/c1.jpg", "ref/refs/u1/kref_0a1b2c3d.png"]) assert.equal(REFERENCE_LINK_RE.test(bad), false, bad);
});

test("drawJobStills: kie.ai has no credit → one stills.fallback row, the job moves to klein-4B at once (the sheet redrawn there), and the next tick never asks kie.ai again", async () => {
  const kie = fakeKieImages({ create: () => jsonRes({ code: 402, msg: "insufficient credits" }) }); globalThis.fetch = kie.fetch;
  const { ai, calls } = fakeAi();
  const { env, jobs, auditRows } = fakeEnv({ AI: ai, STILL_MODEL: "kie:nano-banana-pro", KIE_API_KEY: "kie-key", PUBLIC_URL: "https://kleo.test" });
  const job = jobOf(jobs);
  const r1 = await drawJobStills(env, job, { deadline: Date.now() + 120_000, stop: () => calls.draws.length >= 1 });
  assert.equal(r1.state, "drawing", "the tick stopped after the sheet");
  assert.equal(kie.calls.create.length, 1, "kie.ai was asked once");
  const rows = () => auditRows.filter((a) => a.event === "stills.fallback").map((a) => JSON.parse(a.detail));
  assert.equal(rows().length, 1);
  assert.deepEqual({ ...rows()[0], error: undefined }, { from: "kie:nano-banana-pro", to: DEFAULT_STILL_MODEL, reason: "no credit", error: undefined });
  assert.match(rows()[0].error, /code 402/);
  assert.ok(calls.draws[0].prompt.startsWith("Character reference sheet of Mara")); assert.equal(calls.draws[0].model, DEFAULT_STILL_MODEL);
  assert.ok(!auditRows.some((a) => a.event === "stills.paused"), "a refusal for money is not a pause");
  const r2 = await drawJobStills(env, { ...job, params: jobs.get("gt_stills").params }, { deadline: Date.now() + 120_000 });
  assert.deepEqual(r2, { state: "done", drawn: 3, total: 3 });
  assert.equal(kie.calls.create.length, 1, "the fallback holds for the rest of the job");
  assert.equal(rows().length, 1, "and is not written twice");
  assert.ok(calls.draws.every((d) => d.model === DEFAULT_STILL_MODEL));
  const done = JSON.parse(auditRows.find((a) => a.event === "stills.done").detail);
  assert.equal(done.model, DEFAULT_STILL_MODEL);
  assert.deepEqual(done.fallback, [{ from: "kie:nano-banana-pro", to: DEFAULT_STILL_MODEL, reason: "no credit" }]);
  assert.equal(done.usd, 0.008, "a 4-tile sheet (0.0011) and three 8-tile stills (0.0023) on klein-4B");
});

test("drawJobStills: a kie.ai 503 is 'not now' — the drawing pauses, nothing falls back, nothing is given up", async () => {
  const kie = fakeKieImages({ create: () => jsonRes({ code: 503, msg: "Service busy" }, 503) }); globalThis.fetch = kie.fetch;
  const { ai, calls } = fakeAi();
  const { env, jobs, auditRows } = fakeEnv({ AI: ai, STILL_MODEL: "kie:nano-banana-pro", KIE_API_KEY: "kie-key", PUBLIC_URL: "https://kleo.test" });
  const r = await drawJobStills(env, jobOf(jobs), { deadline: Date.now() + 120_000 });
  assert.equal(r.state, "drawing"); assert.equal(paramsNow(jobs).stills.pauses, 1);
  assert.equal(calls.draws.length, 0); assert.equal(kie.calls.create.length, 1);
  assert.ok(!auditRows.some((a) => a.event === "stills.fallback"));
  const sheet = auditRows.filter((a) => a.event === "stills.sheet").map((a) => JSON.parse(a.detail));
  assert.equal(sheet.length, 1); assert.equal(sheet[0].transient, true, "the sheet is asked for again next tick");
});

test("drawJobStills: STILL_MODEL_FALLBACK=none — no fallback; the refused sheet leaves Mara to the words and the stills to the GPU, as any refused picture", async () => {
  globalThis.fetch = fakeKieImages({ create: () => jsonRes({ code: 402, msg: "insufficient credits" }) }).fetch;
  const { ai, calls } = fakeAi();
  const { env, jobs, auditRows } = fakeEnv({ AI: ai, STILL_MODEL: "kie:nano-banana-pro", STILL_MODEL_FALLBACK: "none", KIE_API_KEY: "kie-key", PUBLIC_URL: "https://kleo.test" });
  const r = await drawJobStills(env, jobOf(jobs), { deadline: Date.now() + 120_000 });
  assert.equal(r.state, "done"); assert.equal(r.drawn, 0, "every picture refused: the GPU draws them");
  assert.equal(calls.draws.length, 0);
  assert.ok(!auditRows.some((a) => a.event === "stills.fallback"));
  assert.equal(auditRows.filter((a) => a.event === "stills.error").length, 3);
});

/* ------------------------------------------------------------------ the review of the Nano Banana switch (25 September 2026) */

test("kie.ai answers: 408 and 455 are 'not now', 505 is a model switched off, 433 is money", () => {
  for (const c of [429, 408, 455, 500, 502, 503]) assert.equal(kieRetryable(c), true, String(c));
  for (const c of [400, 401, 402, 422, 433, 505]) assert.equal(kieRetryable(c), false, String(c));
  const maint = new KieError("kie.ai POST x → code 455: Service unavailable (temporarily unavailable)", 455, true);
  assert.equal(isTransientStillError(maint), true, "maintenance pauses the job instead of giving pictures up");
  const off = new KieError("kie.ai POST x → code 505: feature disabled", 505, false);
  assert.equal(fallbackReason(off), "model unavailable");
  const sub = new KieError("kie.ai POST x → code 433: sub-key usage exceeded the limit", 433, false);
  assert.equal(isNoCredit(sub), true); assert.equal(fallbackReason(sub), "no credit");
  const budget = new StillDrawError("still draw (kie:nano-banana-pro): stills budget: today's pictures have spent $10.00", 402, "kie");
  assert.equal(fallbackReason(budget), "budget");
  const moderated = new StillDrawError("still draw (openrouter:x) → openrouter 403: Input was moderated (flagged)", 403, "openrouter");
  assert.equal(fallbackReason(moderated), null, "a moderated picture is not a refused key"); assert.equal(isFlaggedError(moderated), true);
});

test("the kie.ai ledger: a task written down is collected, not bought again (cost 0 here); a cap refuses before createTask", async () => {
  const kie = fakeKieImages(); globalThis.fetch = kie.fetch;
  const rows = [];
  const book = { find: (k) => (k === "known" ? "task_old" : null), refuse: () => null, created: async (key, task, model, usd) => { rows.push({ key, task, model, usd }); } };
  const again = await drawImage({ KIE_API_KEY: "k" }, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [], 1, { ledger: { key: "known", book } });
  assert.equal(kie.calls.create.length, 0, "no new task"); assert.equal(again.usd, 0, "paid for when the earlier tick gave up on it");
  const fresh = await drawImage({ KIE_API_KEY: "k" }, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [], 1, { ledger: { key: "new", book } });
  assert.equal(kie.calls.create.length, 1); assert.equal(fresh.usd, 0.09);
  assert.deepEqual(rows, [{ key: "new", task: "task_1", model: "kie:nano-banana-pro", usd: 0.09 }], "written down the moment kie.ai answered");
  const capped = { ...book, refuse: () => "this film's pictures have spent $5.00 on kie.ai (STILLS_JOB_MAX_USD $5.00)" };
  const refused = await rejection(drawImage({ KIE_API_KEY: "k" }, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [], 1, { ledger: { key: "other", book: capped } }));
  assert.equal(kie.calls.create.length, 1, "kie.ai was never asked"); assert.equal(fallbackReason(refused), "budget");
  // A task that succeeded but whose picture cannot be fetched is a pause (collected next tick), never a redraw without references.
  const broken = fakeKieImages(); globalThis.fetch = async (u, i) => (String(u).startsWith("https://tempfile.kie.test/") ? new Response("gone", { status: 404 }) : broken.fetch(u, i));
  const gone = await rejection(drawImage({ KIE_API_KEY: "k" }, "kie:nano-banana-pro", "p", STILL_SIZES["9:16"], [{ ...IMG(1), url: "https://kleo.test/a" }], 1));
  assert.equal(isTransientStillError(gone), true); assert.equal(gone.usd, 0.09);
});

test("drawStill on kie:…: a task that failed for itself draws the next seed WITH the references; one that could not read them goes without", async () => {
  const ref = { label: "Mara", image: IMG(1), url: "https://kleo.test/dl/gt/ref%2Fcast%2Fc1.jpg?exp=1&sig=a" };
  const kie = fakeKieImages({ state: (id, n) => (id === "task_1" ? "fail" : n < 2 ? "generating" : "success"), failCode: "501", failMsg: "Generation failed" });
  globalThis.fetch = kie.fetch;
  const { ai } = fakeAi();
  const r = await drawStill({ AI: ai, STILL_MODEL: "kie:nano-banana-pro", KIE_API_KEY: "k" }, input({ refs: [ref] }), { seedBase: 10 });
  assert.equal(kie.calls.create.length, 2, "the failed task, then the next seed");
  assert.deepEqual(kie.calls.create.map((c) => c.body.input.image_input.length), [1, 1], "the references stay: the failure was not about them");
  assert.deepEqual(r.tries.map((t) => t.failed[0] ?? "ok"), ["task failed", "ok"]);
  const unreadable = fakeKieImages({ state: (id, n) => (id === "task_1" ? "fail" : n < 2 ? "generating" : "success"), failCode: "400", failMsg: "Failed to download the image_input url" });
  globalThis.fetch = unreadable.fetch;
  await drawStill({ AI: fakeAi().ai, STILL_MODEL: "kie:nano-banana-pro", KIE_API_KEY: "k" }, input({ refs: [ref] }), { seedBase: 10 });
  assert.deepEqual(unreadable.calls.create.map((c) => c.body.input.image_input.length), [1, 0], "a task that could not read its references is drawn again without them, same seed");
});

test("drawJobStills on kie.ai: a task that outlives the tick is written down, and the next tick collects it instead of paying again", async () => {
  let slow = true;
  const kie = fakeKieImages({ state: (id, n) => (slow ? "generating" : "success") }); globalThis.fetch = kie.fetch;
  Object.assign(KIE_STILL_POLL, { firstMs: 1, everyMs: 2, minMs: 20, maxMs: 40 });
  const { ai } = fakeAi();
  const { env, jobs, auditRows } = fakeEnv({ AI: ai, STILL_MODEL: "kie:nano-banana-pro", KIE_API_KEY: "kie-key", PUBLIC_URL: "https://kleo.test" });
  const job = jobOf(jobs);
  const r1 = await drawJobStills(env, job, { deadline: Date.now() + 120_000 });
  assert.equal(r1.state, "drawing", "the sheet timed out: a pause"); assert.equal(kie.calls.create.length, 1);
  const ev = (e) => auditRows.filter((a) => a.event === e).map((a) => JSON.parse(a.detail));
  assert.equal(ev("stills.task").length, 1); assert.equal(ev("stills.task")[0].task, "task_1"); assert.equal(ev("stills.task")[0].usd, 0.09);
  assert.equal(ev("stills.sheet")[0].usd, 0.09, "the abandoned wait is counted once, when it is abandoned");
  assert.equal(paramsNow(jobs).stills.road, "kie");
  slow = false;
  const r2 = await drawJobStills(env, { ...job, params: jobs.get("gt_stills").params }, { deadline: Date.now() + 120_000 });
  assert.deepEqual(r2, { state: "done", drawn: 3, total: 3 });
  assert.equal(kie.calls.create.length, 4, "the sheet was collected (task_1), only the three stills were created");
  const done = ev("stills.done")[0];
  assert.equal(done.usd, 0.36, "one sheet and three stills, each paid once");
});

test("drawJobStills on kie.ai: past STILLS_DAILY_USD the job moves to klein-4B with a 'budget' fallback row", async () => {
  const kie = fakeKieImages(); globalThis.fetch = kie.fetch;
  const { ai, calls } = fakeAi();
  // The film's own cap grows with the film (every picture and sheet twice: 0.72 $ here), so the day's cap is the one met.
  const { env, jobs, auditRows } = fakeEnv({ AI: ai, STILL_MODEL: "kie:nano-banana-pro", KIE_API_KEY: "kie-key", PUBLIC_URL: "https://kleo.test", STILLS_JOB_MAX_USD: "0.1", STILLS_DAILY_USD: "0.1" });
  const r = await drawJobStills(env, jobOf(jobs), { deadline: Date.now() + 120_000 });
  assert.deepEqual(r, { state: "done", drawn: 3, total: 3 });
  assert.equal(kie.calls.create.length, 1, "the sheet fitted the cap, nothing after it");
  assert.equal(calls.draws.length, 3, "the three stills on klein-4B");
  const fb = auditRows.filter((a) => a.event === "stills.fallback").map((a) => JSON.parse(a.detail));
  assert.equal(fb.length, 1); assert.equal(fb[0].reason, "budget"); assert.match(fb[0].error, /STILLS_DAILY_USD/);
});

test("drawJobStills on kie.ai: tasks failing one after the other (an outage) move the job to klein-4B; no picture is given up", async () => {
  const kie = fakeKieImages({ state: () => "fail", failCode: "500", failMsg: "internal error" }); globalThis.fetch = kie.fetch;
  const { ai, calls } = fakeAi();
  const { env, jobs, auditRows } = fakeEnv({ AI: ai, STILL_MODEL: "kie:nano-banana-pro", KIE_API_KEY: "kie-key", PUBLIC_URL: "https://kleo.test" });
  const r = await drawJobStills(env, jobOf(jobs), { deadline: Date.now() + 120_000 });
  assert.deepEqual(r, { state: "done", drawn: 3, total: 3 });
  assert.equal(kie.calls.create.length, 2, "two failed tasks in a row, then no more kie.ai");
  const fb = auditRows.filter((a) => a.event === "stills.fallback").map((a) => JSON.parse(a.detail));
  assert.equal(fb.length, 1); assert.equal(fb[0].reason, "model unavailable");
  assert.ok(calls.draws[0].prompt.startsWith("Character reference sheet of Mara"), "the sheet is drawn again on klein-4B");
  assert.equal(calls.draws.length, 4, "the sheet and the three stills");
  assert.equal(auditRows.filter((a) => a.event === "stills.error").length, 0);
});

test("stillsGiveUpMin: twenty minutes on Workers AI; on an external road it grows with the film", () => {
  assert.equal(stillsGiveUpMin(null), STILLS_GIVE_UP_MIN);
  assert.equal(stillsGiveUpMin({ road: "workers-ai", total: 48 }), STILLS_GIVE_UP_MIN);
  assert.equal(stillsGiveUpMin({ road: "kie", total: 15 }), 20, "a 30 s Short");
  assert.equal(stillsGiveUpMin({ road: "kie", total: 24 }), 22);
  assert.equal(stillsGiveUpMin({ road: "kie", total: 48 }), 34);
  const ai = fakeAi().ai;
  const job = { id: "gt_x", user_id: "u", storyboard: JSON.stringify(STORYBOARD), params: JSON.stringify({ stills: { state: "drawing", at: new Date(Date.now() - 25 * 60_000).toISOString(), road: "kie", total: 48 } }) };
  assert.equal(stillsHold({ AI: ai }, job), true, "25 minutes into a 48-picture film on kie.ai: still drawing");
});

test("a sheet link names the key the sheet is stored under, whatever the id's length (safeId is idempotent)", async () => {
  const id = `d-${"a".repeat(29)}-bbb`;
  assert.equal(await referenceLinkKey({}, { id: "gt_x", user_id: "u1" }, sheetLinkName(id)), castSheetKey("gt_x", id));
});

test("drawImage on ephone:…: ePhone's chat road — its base URL and key, official_cheap first, the picture as a data URL in the text, the price from the table; an empty account is money", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return jsonRes({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: `![image](data:image/jpeg;base64,${b64(JPG(5))})` } }], usage: { prompt_tokens: 60, completion_tokens: 1557 } });
  };
  const d = await drawImage({ EPHONE_API_KEY: "eph-key", IMAGE_API_KEY: "or-key" }, "ephone:gemini-3-pro-image-preview", "a pirate at the rail", STILL_SIZES["16:9"], [{ ...IMG(1), url: null }], 3);
  assert.equal(calls[0].url, "https://api.ephone.ai/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, "Bearer eph-key", "ePhone's key, never OpenRouter's");
  assert.equal(calls[0].headers["X-Provider-Order"], "official_cheap,official");
  assert.equal(calls[0].body.model, "gemini-3-pro-image-preview");
  assert.deepEqual(calls[0].body.image_config, { aspect_ratio: "16:9", image_size: "1K" });
  assert.equal(calls[0].body.messages[0].content.length, 2, "the reference goes as a data URL: no public link needed");
  assert.equal(d.bytes[4], 5); assert.equal(d.usd, 0.074); assert.equal(d.reported, false);
  assert.deepEqual(stillProviderOf("ephone:gemini-3-pro-image-preview"), { provider: "ephone", id: "gemini-3-pro-image-preview" });
  assert.equal(strongStillModel({ STILL_MODEL: "ephone:gemini-3-pro-image-preview" }), null);
  // The empty account, as ePhone really answered it on 25 September 2026.
  globalThis.fetch = async () => jsonRes({ error: { message: "用户额度不足, 剩余额度: ＄-0.348831 (request id: a407)", type: "rix_api_error", code: "insufficient_user_quota" } }, 403);
  const poor = await rejection(drawImage({ EPHONE_API_KEY: "eph-key" }, "ephone:gemini-3-pro-image-preview", "p", STILL_SIZES["16:9"], [], 1));
  assert.equal(fallbackReason(poor), "no credit", "the job falls back to klein-4B");
  assert.equal(fallbackReason(await rejection(drawImage({}, "ephone:gemini-3-pro-image-preview", "p", STILL_SIZES["16:9"], [], 1))), "unauthorized", "no EPHONE_API_KEY");
});

/* ------------------------------------------------------------------ the money caps on every road (26 September 2026) */

test("drawJobStills on ephone:…: the money caps bound the chat road too — every paid draw is booked, and past STILLS_DAILY_USD the job moves to klein-4B", async () => {
  const chat = [];
  globalThis.fetch = async (url) => {
    chat.push(String(url));
    return jsonRes({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: `![image](data:image/jpeg;base64,${b64(JPG(5))})` } }], usage: { prompt_tokens: 60, completion_tokens: 1557 } });
  };
  const { ai, calls } = fakeAi();
  // The film's own cap grows with the film (every picture and sheet twice: 0.59 $ here), so the day's cap is the one met.
  const { env, jobs, auditRows } = fakeEnv({ AI: ai, STILL_MODEL: "ephone:gemini-3-pro-image-preview", EPHONE_API_KEY: "eph-key", PUBLIC_URL: "https://kleo.test", STILLS_JOB_MAX_USD: "0.1", STILLS_DAILY_USD: "0.1" });
  const r = await drawJobStills(env, jobOf(jobs), { deadline: Date.now() + 120_000 });
  assert.deepEqual(r, { state: "done", drawn: 3, total: 3 });
  assert.equal(chat.length, 1, "the sheet fitted the cap (0.074 $), nothing after it");
  assert.equal(calls.draws.length, 3, "the three stills on klein-4B");
  const ev = (e) => auditRows.filter((a) => a.event === e).map((a) => JSON.parse(a.detail));
  assert.equal(ev("stills.task").length, 1, "the chat draw is written down like a kie.ai task");
  assert.equal(ev("stills.task")[0].usd, 0.074); assert.equal(ev("stills.task")[0].task, "", "nothing to collect: the answer was the picture");
  const fb = ev("stills.fallback");
  assert.equal(fb.length, 1); assert.equal(fb[0].reason, "budget"); assert.match(fb[0].error, /STILLS_DAILY_USD/); assert.doesNotMatch(fb[0].error, /kie\.ai/);
});

test("drawImage on a chat road with a ledger: refused before the call past a cap, booked after it at what it cost; no ledger, no booking", async () => {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return jsonRes({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: `![image](data:image/jpeg;base64,${b64(JPG(5))})` } }], usage: {} }); };
  const rows = [];
  const book = { find: () => null, refuse: () => null, created: async (key, task, model, usd) => { rows.push({ key, task, model, usd }); } };
  const d = await drawImage({ EPHONE_API_KEY: "eph-key" }, "ephone:gemini-3-pro-image-preview", "p", STILL_SIZES["9:16"], [], 1, { ledger: { key: "k1", book } });
  assert.equal(d.usd, 0.074);
  assert.deepEqual(rows, [{ key: "k1", task: "", model: "ephone:gemini-3-pro-image-preview", usd: 0.074 }]);
  const capped = { ...book, refuse: () => "this film's pictures have spent $5.00 (STILLS_JOB_MAX_USD $5.00)" };
  const refused = await rejection(drawImage({ EPHONE_API_KEY: "eph-key" }, "ephone:gemini-3-pro-image-preview", "p", STILL_SIZES["9:16"], [], 1, { ledger: { key: "k2", book: capped } }));
  assert.equal(fallbackReason(refused), "budget"); assert.equal(calls.length, 1, "ePhone was never asked");
  // OpenRouter reports its own cost: that is what is booked.
  globalThis.fetch = async () => jsonRes({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${b64(JPG(6))}` } }] } }], usage: { cost: 0.138 } });
  await drawImage({ IMAGE_API_KEY: "or-key" }, "openrouter:google/gemini-3-pro-image-preview", "p", STILL_SIZES["9:16"], [], 1, { ledger: { key: "k3", book } });
  assert.equal(rows.at(-1).usd, 0.138);
  await drawImage({ IMAGE_API_KEY: "or-key" }, "openrouter:google/gemini-3-pro-image-preview", "p", STILL_SIZES["9:16"], [], 1);
  assert.equal(rows.length, 2, "without a ledger nothing is booked");
});
