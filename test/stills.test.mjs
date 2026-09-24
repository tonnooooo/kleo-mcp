/**
 * Unit tests for src/stills.ts, the stills engine of 24 September 2026: the prompt compiler (what goes first, what
 * the picture model reads about each character, the text allowance, the sizes), the draw → judge → redraw loop
 * against a fake FLUX.2 + vision binding (a failed must is drawn again with the failure named first, the best try is
 * kept, a refused reference is dropped, an unanswering judge does not burn the quota), and a whole job's stills
 * persisted the way /images and /dl read them (character sheets first, R2 names, audit rows, params.stills,
 * fidelity.json). No network, no Workers AI. Run: node --test test/stills.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileStill, feedbackFor, drawStill, drawCastSheet, drawJobStills, stillsEngineOn, stillsHold, stillCast, stillShotsOf,
  STILL_SIZES, STILL_PROMPT_MAX, STYLE_SENTENCE, NO_TEXT_SENTENCE, FRAMING, DEFAULT_FRAMING, DEFAULT_STILL_MODEL, EST_STILL_MS, castSheetKey,
  stillsErrorVerdict, pauseStills,
} from "../src/stills.ts";

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
  assert.equal(new Set(ids).size, ids.length, "no check is asked twice");
});

test("compileStill: failures go FIRST, a text item lifts the no-text rule and is spelled out, sizes are multiples of 16 in both formats", () => {
  const p = compileStill(input(), ["the picture clearly shows Mara wears a lilac apron."]).prompt;
  assert.ok(p.startsWith("It is essential that: the picture clearly shows Mara wears a lilac apron. Close-up"), p);
  const sign = compileStill(input({ shot: shot({ covers: ["R4", "R5"], shot_kind: "establish", cast: [] , image_prompt: "The bakery front with its shop sign" }) }));
  assert.ok(sign.prompt.startsWith(FRAMING.establish));
  assert.ok(sign.prompt.includes('Written clearly and legibly in the picture, spelled exactly as given: a shop sign reading "Forno Mara".'));
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
        async first() { return sql.startsWith("SELECT params FROM jobs") ? (jobs.has(this.args[0]) ? { params: jobs.get(this.args[0]).params } : null) : null; },
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
  assert.equal(shots.find((d) => d.prompt.includes("bakery front")).refs, 0, "a shot without her carries no sheet");
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
  assert.equal(sheetDraws(), 1);
  const refused = auditRows.filter((a) => a.event === "stills.sheet").map((a) => JSON.parse(a.detail));
  assert.equal(refused.length, 1); assert.equal(refused[0].transient, false); assert.match(refused[0].error, /5016/);
  const r2 = await drawJobStills(env, { ...job, params: jobs.get("gt_stills").params }, { deadline: Date.now() + 120_000 });
  assert.deepEqual(r2, { state: "done", drawn: 3, total: 3 });
  assert.equal(sheetDraws(), 1, "the refused sheet is not asked for again");
  assert.ok(calls.draws.filter((d) => !d.prompt.startsWith("Character reference sheet")).every((d) => d.refs === 0), "no sheet, no reference image");
});

test("drawJobStills: the sheets a tick drew are in fidelity.json even when the tick runs out of time before the next sheet", async () => {
  const { ai, calls } = fakeAi();
  const { env, jobs, kv } = fakeEnv({ AI: ai });
  const job = jobOf(jobs);
  job.storyboard = JSON.stringify({ ...STORYBOARD, direction: { ...DIRECTION, cast: [...DIRECTION.cast, { name: "Tomas", look: "a tall old baker with a grey beard" }] } });
  const r = await drawJobStills(env, job, { deadline: Date.now() + 120_000, stop: () => calls.draws.length >= 1 });
  assert.equal(r.state, "drawing"); assert.equal(calls.draws.length, 1, "Mara's sheet, then the tick stops");
  const report = () => JSON.parse(new TextDecoder().decode(kv.get("file:renders/gt_stills/fidelity.json").v));
  assert.deepEqual(Object.keys(report().sheets), ["c1"], "the sheet drawn before the stop is reported");
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
