/**
 * Unit tests for src/images.ts: the placeholder PNG encoder (IMAGE_FIXTURE=1), model inputs, response reading and the
 * generation loop against an in-memory env (no Workers AI, no network), plus the /dl round trip of a signed picture
 * link (src/dl.ts serves the same names images.ts signs). Run: node --test test/images.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import {
  encodePng, placeholderPng, crc32, fnv1a, pickImageScenes, sizeFor, acceptsSize, modelInputs, readImageResult, sniffImage, fullPrompt,
  generateJobImages, DEFAULT_IMAGE_MODELS, DEFAULT_SERVER_MAX, IMAGE_NAME_RE, STYLE_SUFFIX, MAX_PICTURES, imageFileName,
  isQuotaError, isTransientError, NEGATIVE_PROMPT, STYLE_NEGATIVE,
} from "../src/images.ts";
import { handleDownload } from "../src/dl.ts";

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
/** Walks the chunks of a PNG, checking each CRC. */
function chunks(png) {
  const out = [];
  let o = 8;
  while (o < png.length) {
    const len = be32(png, o), type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const body = png.subarray(o + 4, o + 8 + len);
    assert.equal(be32(png, o + 8 + len), crc32(body), `bad CRC on ${type}`);
    out.push({ type, data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

test("crc32 and fnv1a match the reference values", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(fnv1a(""), 0x811c9dc5);
  assert.equal(fnv1a("a"), 0xe40c292c);
  assert.equal(fnv1a("01-hook-s1"), fnv1a("01-hook-s1"));
  assert.notEqual(fnv1a("01-hook-s1"), fnv1a("01-hook-s2"));
});

test("encodePng: signature, IHDR (size, 8-bit RGB), IDAT inflates to the raw scanlines, IEND", async () => {
  const png = await encodePng(5, 3, (x, y) => [x * 40, y * 100, 7]);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const c = chunks(png);
  assert.deepEqual(c.map((x) => x.type), ["IHDR", "IDAT", "IEND"]);
  const ihdr = c[0].data;
  assert.equal(ihdr.length, 13);
  assert.equal(be32(ihdr, 0), 5); assert.equal(be32(ihdr, 4), 3);
  assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0]);
  const raw = inflateSync(Buffer.from(c[1].data));
  assert.equal(raw.length, 3 * (5 * 3 + 1));
  assert.equal(raw[0], 0, "filter byte");
  assert.deepEqual([...raw.subarray(1, 4)], [0, 0, 7]);
  assert.deepEqual([...raw.subarray(16 + 1 + 4 * 3, 16 + 1 + 4 * 3 + 3)], [160, 100, 7]);
  assert.equal(c[2].data.length, 0);
});

test("placeholderPng: deterministic per picture id, portrait and landscape sizes, a visible stripe", async () => {
  const a = await placeholderPng("01-hook-s1", 96, 168);
  const b = await placeholderPng("01-hook-s1", 96, 168);
  const other = await placeholderPng("01-hook-s2", 96, 168);
  assert.deepEqual([...a], [...b]);
  assert.notDeepEqual([...a], [...other]);
  assert.equal(sniffImage(a), "png");
  const ihdr = chunks(a)[0].data;
  assert.equal(be32(ihdr, 0), 96); assert.equal(be32(ihdr, 4), 168);
  const raw = inflateSync(Buffer.from(chunks(a)[1].data));
  const px = (x, y) => [...raw.subarray(y * (96 * 3 + 1) + 1 + x * 3, y * (96 * 3 + 1) + 4 + x * 3)];
  assert.deepEqual(px(0, 0), px(1, 1), "on the diagonal: stripe colour");
  assert.notDeepEqual(px(0, 0), px(95, 0), "corner off the diagonal: base colour");
  const wide = await placeholderPng("x", 168, 96);
  assert.equal(be32(chunks(wide)[0].data, 0), 168);
  assert.deepEqual(sizeFor("9:16"), { width: 768, height: 1344 });
  assert.deepEqual(sizeFor("16:9"), { width: 1344, height: 768 });
});

test("pickImageScenes spreads the cap over the video", () => {
  const ids = Array.from({ length: 25 }, (_, i) => i);
  assert.deepEqual(pickImageScenes(ids, 10), [0, 3, 5, 8, 11, 13, 16, 19, 21, 24]);
  assert.deepEqual(pickImageScenes([1, 2, 3], 10), [1, 2, 3]);
  assert.deepEqual(pickImageScenes(ids, 1), [0]);
  assert.deepEqual(pickImageScenes(ids, 0), []);
});

test("model inputs: style suffix, size only for models that take one, negative prompt", () => {
  assert.equal(acceptsSize(DEFAULT_IMAGE_MODELS.cartoon), false);
  assert.equal(acceptsSize(DEFAULT_IMAGE_MODELS.realistic), true);
  const flux = modelInputs(DEFAULT_IMAGE_MODELS.cartoon, "cartoon", "Pirates on a beach. ", "9:16", 7);
  assert.equal(flux.prompt, `Pirates on a beach. ${STYLE_SUFFIX.cartoon}`);
  assert.deepEqual(Object.keys(flux).sort(), ["prompt", "steps"]); // FLUX schnell rejects seed (AiError 5006)
  assert.equal(flux.steps, 4);
  const sd = modelInputs("@cf/lykon/dreamshaper-8-lcm", "cartoon", "x", "9:16", 7);
  assert.equal(sd.seed, 7); assert.equal(sd.guidance, 7.5);
  const phoenix = modelInputs(DEFAULT_IMAGE_MODELS.realistic, "realistic", "A mountain road in rain", "16:9", 7);
  assert.equal(phoenix.width, 1344); assert.equal(phoenix.height, 768); assert.equal(phoenix.num_steps, 20);
  assert.ok(String(phoenix.negative_prompt).includes("text"));
  assert.ok(String(phoenix.prompt).endsWith(STYLE_SUFFIX.realistic));
  const sdxl = modelInputs("@cf/bytedance/stable-diffusion-xl-lightning", "realistic", "x", "9:16", 1);
  assert.equal(sdxl.width, 768); assert.equal(sdxl.guidance, 7.5);
  assert.equal(fullPrompt("cartoon", "no trailing dot"), `no trailing dot. ${STYLE_SUFFIX.cartoon}`);
  // The section's light is written into no look's pictures any more (a colour cast on the animation's turbo model,
  // gt_ad2musq5, and on the realistic RealVisXL, gt_hxed87em). Same rule as worker/kleo_pictures.py lights_pictures().
  const d = { world: "A country village at dawn", cast: [{ name: "the pastry chef", look: "a thin woman with short blonde hair tied up, lilac apron" }], objects: [], forbidden: [] };
  assert.ok(!fullPrompt("realistic", "the pastry chef at her oven", d, "red").includes("light source"));
  assert.ok(!fullPrompt("animation", "the pastry chef at her oven", d, "red").includes("light source"));
  assert.ok(fullPrompt("animation", "the pastry chef at her oven", d, "red").includes("the pastry chef: a thin woman"), "the cast look still travels");
});

test("readImageResult: binary stream, bytes and base64 JSON; sniffImage tells PNG from JPEG", async () => {
  const png = await placeholderPng("s", 8, 8);
  const fromStream = await readImageResult(new Blob([png]).stream());
  assert.deepEqual([...fromStream], [...png]);
  assert.deepEqual([...(await readImageResult(png.buffer.slice(0)))], [...png]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const b64 = Buffer.from(jpeg).toString("base64");
  assert.deepEqual([...(await readImageResult({ image: b64 }))], [...jpeg]);
  assert.deepEqual([...(await readImageResult({ image: `data:image/jpeg;base64,${b64}` }))], [...jpeg]);
  assert.equal(sniffImage(jpeg), "jpg"); assert.equal(sniffImage(png), "png"); assert.equal(sniffImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), null);
  await assert.rejects(readImageResult({ nope: 1 }), /unexpected image model response/);
});

/* ------------------------------------------------------------------ generation loop on a fake env */

function fakeEnv(extra = {}) {
  const files = new Map(), auditRows = [], kv = new Map(), jobs = new Map();
  const db = {
    prepare(sql) {
      return {
        args: [], bind(...a) { this.args = a; return this; },
        async run() {
          if (sql.startsWith("INSERT OR REPLACE INTO job_files")) files.set(this.args[1], { job_id: this.args[0], name: this.args[1], key: this.args[2], size: this.args[3], content_type: this.args[4] });
          // `at` mirrors the column default (schema.ts: strftime ISO); the retry of a transient failure reads it back.
          else if (sql.startsWith("INSERT INTO audit")) auditRows.push({ job_id: this.args[1], event: this.args[2], detail: this.args[3], at: new Date().toISOString() });
          return { meta: { changes: 1 } };
        },
        async all() {
          if (sql.startsWith("SELECT * FROM job_files")) return { results: [...files.values()] };
          if (sql.includes("FROM audit")) return { results: auditRows.filter((r) => r.event === "images.error").map((r) => ({ detail: r.detail, at: r.at })) };
          return { results: [] };
        },
        async first() { return (sql.startsWith("SELECT * FROM jobs") ? jobs.get(this.args[0]) : null) ?? null; },
      };
    },
  };
  return { env: { DB: db, OAUTH_KV: { async put(k, v, o) { kv.set(k, { v, o }); }, async getWithMetadata(k) { const e = kv.get(k); return { value: e?.v ?? null, metadata: e?.o?.metadata }; } }, INTERNAL_SECRET: "s3cret", ...extra }, files, auditRows, kv, jobs };
}
/** Ages every audit row by `min` minutes, as if the call had happened that long ago. */
const backdate = (auditRows, min) => { for (const r of auditRows) r.at = new Date(Date.parse(r.at) - min * 60_000).toISOString(); };
/** A picture-style storyboard: `n` scenes of `shots` shots each, prompts numbered over the flattened list. */
function storyboardFor(style, n, shots) {
  let k = 0;
  return {
    style: "picture", kleo_style: style,
    scenes: Array.from({ length: n }, (_, i) => ({
      id: `${String(i + 1).padStart(2, "0")}-sc`, kind: i === n - 1 ? "closing" : "cinema", title: `scene ${i + 1}`, voice: "a line",
      shots: Array.from({ length: shots }, () => ({ image_prompt: `picture ${++k}` })),
    })),
  };
}
const jobFor = (style, n = 3, format = "9:16", { shots = 1, duration_s = 45 } = {}) =>
  ({ id: "gt_img", user_id: "u1", params: JSON.stringify({ duration_s, format, language: "en", voice: null, style }), storyboard: JSON.stringify(storyboardFor(style, n, shots)) });
/** The picture ids of a job, in order (what the endpoint keys its answer by). */
const idsOf = (n, shots) => Array.from({ length: n }, (_, i) => Array.from({ length: shots }, (_, j) => `${String(i + 1).padStart(2, "0")}-sc-s${j + 1}`)).flat();

test("fixture: one PNG per shot in job_files, keyed by picture id, signed /dl links, idempotent on a second call", async () => {
  const { env, files, auditRows, kv } = fakeEnv({ IMAGE_FIXTURE: "1" });
  const r = await generateJobImages(env, jobFor("cartoon", 3, "9:16", { shots: 2 }), "http://kleo.test");
  assert.equal(r.fixture, true); assert.equal(r.generated, 6); assert.equal(r.reused, 0); assert.deepEqual(r.missing, []);
  assert.deepEqual(Object.keys(r.images), idsOf(3, 2));
  for (const [id, url] of Object.entries(r.images)) {
    assert.match(url, new RegExp(`^http://kleo\\.test/dl/gt_img/img%2F${id}\\.png\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    assert.ok(IMAGE_NAME_RE.test(imageFileName(id, "png")), `${id} makes a legal file name`);
    const f = files.get(`img/${id}.png`);
    assert.equal(f.key, `renders/gt_img/img/${id}.png`); assert.equal(f.content_type, "image/png"); assert.ok(f.size > 100);
    const stored = new Uint8Array(kv.get(`file:${f.key}`).v);
    assert.equal(sniffImage(stored), "png");
    assert.equal(be32(chunks(stored)[0].data, 0), 768); assert.equal(be32(chunks(stored)[0].data, 4), 1344);
  }
  assert.notDeepEqual([...new Uint8Array(kv.get("file:renders/gt_img/img/01-sc-s1.png").v)], [...new Uint8Array(kv.get("file:renders/gt_img/img/01-sc-s2.png").v)], "two shots of one scene are two different pictures");
  assert.equal(auditRows.filter((a) => a.event === "images.generated").length, 1);
  const again = await generateJobImages(env, jobFor("cartoon", 3, "9:16", { shots: 2 }), "http://kleo.test");
  assert.equal(again.generated, 0); assert.equal(again.reused, 6); assert.equal(files.size, 6);
});

test("no pictures for cyber/stickman or without shots; the server cap spreads and lists the rest as missing", async () => {
  const { env } = fakeEnv({ IMAGE_FIXTURE: "1" });
  assert.deepEqual(await generateJobImages(env, jobFor("cyber"), "http://kleo.test"), { images: {}, missing: [], generated: 0, reused: 0, fixture: true });
  assert.deepEqual(await generateJobImages(env, jobFor("stickman"), "http://kleo.test"), { images: {}, missing: [], generated: 0, reused: 0, fixture: true });
  const empty = { id: "gt_img", user_id: "u1", params: JSON.stringify({ duration_s: 45, format: "9:16", language: "en", voice: null, style: "cartoon" }), storyboard: JSON.stringify({ style: "picture", kleo_style: "cartoon", scenes: [{ id: "01-sc", kind: "cinema" }] }) };
  assert.deepEqual((await generateJobImages(env, empty, "http://kleo.test")).images, {}, "a scene without shots asks for nothing");
  assert.equal(DEFAULT_SERVER_MAX, 10);
  const r = await generateJobImages(env, jobFor("realistic", 7, "16:9", { shots: 2 }), "http://kleo.test");
  assert.equal(Object.keys(r.images).length, 10); assert.equal(r.missing.length, 4);
  assert.ok("01-sc-s1" in r.images && "07-sc-s2" in r.images, "the first and last pictures are always drawn");
  const { env: env2 } = fakeEnv({ IMAGE_FIXTURE: "1", IMAGE_SERVER_MAX: "2" });
  const r2 = await generateJobImages(env2, jobFor("cartoon", 5), "http://kleo.test");
  assert.deepEqual(Object.keys(r2.images), ["01-sc-s1", "05-sc-s1"]); assert.deepEqual(r2.missing, ["02-sc-s1", "03-sc-s1", "04-sc-s1"]);
  const { env: env3 } = fakeEnv({ IMAGE_FIXTURE: "1", IMAGE_MAX_PER_JOB: "1" });
  const r3 = await generateJobImages(env3, jobFor("cartoon", 5), "http://kleo.test");
  assert.deepEqual(Object.keys(r3.images), ["01-sc-s1"], "the legacy variable name still caps the server");
});

test("the video cap (MAX_PICTURES) bounds the whole list: extra shots are neither drawn nor listed", async () => {
  const { env } = fakeEnv({ IMAGE_FIXTURE: "1" });
  const short = await generateJobImages(env, jobFor("cartoon", 15, "9:16", { shots: 2, duration_s: 45 }), "http://kleo.test");
  assert.equal(MAX_PICTURES(45), 24);
  assert.equal(Object.keys(short.images).length + short.missing.length, 24, "a 45 s Short considers 24 pictures out of 30");
  const listed = new Set([...Object.keys(short.images), ...short.missing]);
  assert.ok(listed.has("12-sc-s2") && !listed.has("13-sc-s1"), "the list is cut after the 24th picture, in order");
  const { env: env2 } = fakeEnv({ IMAGE_FIXTURE: "1" });
  const long = await generateJobImages(env2, jobFor("cartoon", 15, "9:16", { shots: 2, duration_s: 300 }), "http://kleo.test");
  assert.equal(MAX_PICTURES(300), 48);
  assert.equal(Object.keys(long.images).length + long.missing.length, 30, "a long video keeps all 30");
});

test("Workers AI: binary and base64 answers are stored with the right extension; errors and quota are never fatal and never retried", async () => {
  const calls = [];
  const png = await placeholderPng("ai", 16, 16);
  const ai = { async run(model, inputs) {
    calls.push({ model, inputs });
    if (inputs.prompt.startsWith("picture 1.")) return new Blob([png]).stream();
    if (inputs.prompt.startsWith("picture 2.")) return { image: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2]).toString("base64") };
    if (inputs.prompt.startsWith("picture 3.")) throw new Error("AiError: 3010: model overloaded");
    throw new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons");
  } };
  // STILLS_ENGINE "legacy": since 24 September a realistic film with an AI binding has its stills drawn by the server
  // engine (src/stills.ts, tested below and in test/stills.test.mjs); this test pins the legacy one-shot road.
  const { env, files, auditRows } = fakeEnv({ AI: ai, IMAGE_MODEL_REALISTIC: "@cf/leonardo/lucid-origin", STILLS_ENGINE: "legacy" });
  const r = await generateJobImages(env, jobFor("realistic", 6), "http://kleo.test");
  assert.equal(r.fixture, false);
  assert.deepEqual(Object.keys(r.images), ["01-sc-s1", "02-sc-s1"]);
  assert.deepEqual(r.missing, ["03-sc-s1", "04-sc-s1", "05-sc-s1", "06-sc-s1"], "one AI error, one quota error, then the rest is skipped without a call");
  assert.equal(calls.length, 4);
  assert.equal(calls[0].model, "@cf/leonardo/lucid-origin"); assert.equal(calls[0].inputs.width, 768); assert.ok(calls[0].inputs.prompt.endsWith(STYLE_SUFFIX.realistic));
  assert.equal(files.get("img/01-sc-s1.png").content_type, "image/png"); assert.equal(files.get("img/02-sc-s1.jpg").content_type, "image/jpeg");
  const errors = auditRows.filter((a) => a.event === "images.error").map((a) => JSON.parse(a.detail));
  assert.deepEqual(errors.map((e) => e.picture), ["03-sc-s1", "04-sc-s1"]);
  assert.equal(errors[1].quota, true);
  // second call: the two pictures are reused, the two tried ones are not retried, the untried ones get their one attempt
  const r2 = await generateJobImages(env, jobFor("realistic", 6), "http://kleo.test");
  assert.equal(r2.reused, 2); assert.equal(calls.length, 5, "05-sc-s1 gets its single attempt (quota again), 06-sc-s1 is skipped in the same call");
  assert.deepEqual(r2.missing, ["03-sc-s1", "04-sc-s1", "05-sc-s1", "06-sc-s1"]);
  const r3 = await generateJobImages(env, jobFor("realistic", 6), "http://kleo.test");
  assert.equal(calls.length, 6, "06-sc-s1 gets its single attempt");
  assert.equal(r3.reused, 2);
  await generateJobImages(env, jobFor("realistic", 6), "http://kleo.test");
  assert.equal(calls.length, 6, "no picture is ever tried twice");
});

test("no AI binding and no fixture: everything is missing, nothing throws", async () => {
  const { env, auditRows } = fakeEnv();
  const r = await generateJobImages(env, jobFor("cartoon", 2), "http://kleo.test");
  assert.deepEqual(r.images, {}); assert.deepEqual(r.missing, ["01-sc-s1", "02-sc-s1"]);
  assert.ok(auditRows.some((a) => a.event === "images.error" && /no Workers AI binding/.test(a.detail)));
});

test("isTransientError: quota, rate limits and gateway hiccups say \"not now\"; a model error about the prompt does not", () => {
  assert.ok(isQuotaError("AiError: 4006: you have used up your daily free allocation of 10000 neurons"));
  for (const e of ["AiError: 4006: daily free allocation", "429 Too Many Requests", "rate limit exceeded", "503 Service Unavailable",
                   "fetch failed", "request timed out", "the service is temporarily unavailable"]) assert.ok(isTransientError(e), e);
  for (const e of ["AiError: 3010: model overloaded", "AiError: 5006: invalid property \"seed\"", "model returned 12 bytes that are neither PNG nor JPEG",
                   "no Workers AI binding (env.AI)"]) assert.equal(isTransientError(e), false, e);
});

test("a 50-char scene id: the name images.ts signs is the name /dl serves (one shared IMAGE_NAME_RE)", async () => {
  const { env, jobs } = fakeEnv({ IMAGE_FIXTURE: "1" });
  const sceneId = `07-${"a".repeat(47)}`; // the contract allows a scene id of 50 chars
  assert.equal(sceneId.length, 50);
  const job = {
    id: "gt_long", user_id: "u1", params: JSON.stringify({ duration_s: 45, format: "9:16", language: "en", voice: null, style: "cartoon" }),
    storyboard: JSON.stringify({ style: "picture", kleo_style: "cartoon", scenes: [{ id: sceneId, kind: "cinema", title: "t", voice: "a line", shots: [{ image_prompt: "p1" }, { image_prompt: "p2" }] }] }),
  };
  jobs.set(job.id, { ...job, purged_at: null });
  const r = await generateJobImages(env, job, "http://kleo.test");
  const pictureId = `${sceneId}-s2`;
  assert.equal(pictureId.length, 53, "a picture id runs past the 50 chars of its scene id");
  const url = r.images[pictureId];
  assert.ok(url, "the picture is generated, stored and signed");
  const res = await handleDownload(new Request(url), env);
  assert.equal(res.status, 200, "and served: the serve side must not refuse a name the store side signed");
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(sniffImage(new Uint8Array(await res.arrayBuffer())), "png");
  // the guards around that name are untouched
  assert.equal((await handleDownload(new Request(url.replace(/sig=[0-9a-f]{64}/, `sig=${"0".repeat(64)}`)), env)).status, 403);
  assert.equal((await handleDownload(new Request(url.replace(/exp=\d+/, "exp=1")), env)).status, 410, "an expired link is refused before the lookup");
  const exp = new URL(url).searchParams.get("exp");
  assert.equal((await handleDownload(new Request(`http://kleo.test/dl/gt_long/img%2F${"z".repeat(57)}.png?exp=${exp}&sig=${"0".repeat(64)}`), env)).status, 404, "past 56 chars the name is not a picture name");
  assert.equal((await handleDownload(new Request(`http://kleo.test/dl/gt_long/img%2FNOPE.gif?exp=${exp}&sig=${"0".repeat(64)}`), env)).status, 404);
});

test('IMAGE_SERVER_MAX="0" leaves every picture to the GPU worker; only an unset/unreadable value defaults to 10', async () => {
  const { env, files, auditRows } = fakeEnv({ IMAGE_FIXTURE: "1", IMAGE_SERVER_MAX: "0" });
  const r = await generateJobImages(env, jobFor("cartoon", 3), "http://kleo.test");
  assert.deepEqual(r.images, {}); assert.deepEqual(r.missing, idsOf(3, 1));
  assert.equal(r.generated, 0); assert.equal(files.size, 0, "not one picture drawn, not one file stored");
  assert.equal(auditRows.filter((a) => a.event === "images.error").length, 0, "off is not an error");
  const { env: env2 } = fakeEnv({ IMAGE_FIXTURE: "1", IMAGE_MAX_PER_JOB: "0" });
  assert.deepEqual((await generateJobImages(env2, jobFor("cartoon", 3), "http://kleo.test")).images, {}, "the legacy variable name switches it off too");
  for (const v of [undefined, "", "off"]) {
    const { env: env3 } = fakeEnv({ IMAGE_FIXTURE: "1", ...(v === undefined ? {} : { IMAGE_SERVER_MAX: v }) });
    assert.equal(Object.keys((await generateJobImages(env3, jobFor("cartoon", 12), "http://kleo.test")).images).length, DEFAULT_SERVER_MAX, `IMAGE_SERVER_MAX=${JSON.stringify(v)}`);
  }
});

test("quota exhaustion is not a picture's one attempt: it is retried later, a real model error never is", async () => {
  const calls = [];
  let quotaOut = true;
  const png = await placeholderPng("ai", 16, 16);
  const ai = { async run(_model, inputs) {
    calls.push(inputs.prompt.slice(0, 9));
    if (inputs.prompt.startsWith("picture 2.")) throw new Error('AiError: 5006: invalid property "shots"');
    if (quotaOut) throw new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons");
    return new Blob([png]).stream();
  } };
  const { env, auditRows } = fakeEnv({ AI: ai });
  const job = () => jobFor("cartoon", 2);
  const r1 = await generateJobImages(env, job(), "http://kleo.test");
  assert.deepEqual(r1.missing, ["01-sc-s1", "02-sc-s1"]);
  assert.deepEqual(calls, ["picture 1"], "the quota answer stops the rest of THIS call");
  const r2 = await generateJobImages(env, job(), "http://kleo.test");
  assert.deepEqual(calls, ["picture 1", "picture 2"], "seconds later the quota is still out: 01 is held back, 02 spends its attempt");
  assert.deepEqual(r2.missing, ["01-sc-s1", "02-sc-s1"]);
  const flags = auditRows.filter((a) => a.event === "images.error").map((a) => JSON.parse(a.detail));
  assert.deepEqual(flags.map((f) => [f.picture, f.quota, f.transient]), [["01-sc-s1", true, true], ["02-sc-s1", false, false]]);

  backdate(auditRows, 11); // the allocation is back and the cool-off has passed
  quotaOut = false;
  const r3 = await generateJobImages(env, job(), "http://kleo.test");
  assert.deepEqual(calls, ["picture 1", "picture 2", "picture 1"], "01 is drawn at last; 02 keeps its verdict for good");
  assert.equal(r3.generated, 1);
  assert.deepEqual(Object.keys(r3.images), ["01-sc-s1"]); assert.deepEqual(r3.missing, ["02-sc-s1"]);
  const r4 = await generateJobImages(env, job(), "http://kleo.test");
  assert.equal(r4.reused, 1); assert.equal(calls.length, 3, "a stored picture is reused and a genuine error is never retried");
});

/* ------------------------------------------------------------------ the stills engine (24 September 2026) */

/** A fake FLUX.2 + vision binding: draws answer {image: base64 jpeg} (distinct bytes per draw), the judge says yes to
 *  everything a good picture shows and no to "is there text / anything excluded". */
function fakeFluxAi() {
  const calls = { draws: [], judges: 0 };
  const ai = { async run(model, inputs) {
    if (inputs.multipart) {
      const fd = await new Response(inputs.multipart.body, { headers: { "content-type": inputs.multipart.contentType } }).formData();
      calls.draws.push({ model, prompt: fd.get("prompt"), width: Number(fd.get("width")), height: Number(fd.get("height")) });
      return { image: Buffer.from([0xff, 0xd8, 0xff, 0xe0, calls.draws.length, 1, 2, 3]).toString("base64") };
    }
    if (inputs.messages) {
      calls.judges++;
      const text = inputs.messages[0].content[0].text;
      const ans = {};
      for (const m of text.matchAll(/^(q\d+): (.*)$/gm)) ans[m[1]] = /any written text|any of this/i.test(m[2]) ? "no" : "yes";
      return { response: JSON.stringify(ans) };
    }
    throw new Error("unexpected AI call");
  } };
  return { ai, calls };
}

test("stills engine: a realistic film's pictures are drawn on the server whatever IMAGE_SERVER_MAX says, then reused; a failed engine only serves what is stored", async () => {
  const { ai, calls } = fakeFluxAi();
  const { env, files } = fakeEnv({ AI: ai, IMAGE_SERVER_MAX: "0" });
  const r = await generateJobImages(env, jobFor("realistic", 3), "http://kleo.test");
  assert.deepEqual(Object.keys(r.images).sort(), idsOf(3, 1), "IMAGE_SERVER_MAX=0 bounds the legacy road, not the engine");
  assert.deepEqual(r.missing, []); assert.equal(r.generated, 3); assert.equal(r.reused, 0);
  assert.equal(calls.draws.length, 3, "one FLUX.2 draw per picture: the judge passed each at the first try");
  assert.equal(calls.draws[0].model, "@cf/black-forest-labs/flux-2-klein-9b");
  assert.deepEqual([calls.draws[0].width, calls.draws[0].height], [896, 1600], "portrait still for a 9:16 job");
  assert.equal(files.get("img/01-sc-s1.jpg").content_type, "image/jpeg");
  assert.ok(files.has("fidelity.json"), "every judgement lands in the job's fidelity report");
  const again = await generateJobImages(env, jobFor("realistic", 3), "http://kleo.test");
  assert.equal(again.reused, 3); assert.equal(again.generated, 0); assert.equal(calls.draws.length, 3, "stored stills are never drawn twice");
  // The engine gave up on this job (quota, an outage): what is stored is served, the rest is the GPU's, at once.
  const failed = jobFor("realistic", 4);
  failed.params = JSON.stringify({ ...JSON.parse(failed.params), stills: { state: "failed", at: new Date().toISOString() } });
  const f = await generateJobImages(env, failed, "http://kleo.test");
  assert.equal(Object.keys(f.images).length, 3); assert.deepEqual(f.missing, ["04-sc-s1"]);
  assert.equal(calls.draws.length, 3, "a failed engine is not asked again while the GPU waits");
  // cartoon and the legacy switch keep the old road
  const { ai: ai2, calls: calls2 } = fakeFluxAi();
  const { env: legacy } = fakeEnv({ AI: ai2, STILLS_ENGINE: "legacy", IMAGE_SERVER_MAX: "0" });
  assert.deepEqual((await generateJobImages(legacy, jobFor("realistic", 2), "http://kleo.test")).images, {});
  assert.equal(calls2.draws.length, 0);
});

/* ------------------------------------------------------------------ the two sides draw for the same video */

test("the GPU's style suffix and negative prompt are the server's, character for character", () => {
  // Kleo can draw a scene's pictures in two places — the server (Workers AI) and the rented GPU — and both can
  // happen inside ONE video, which is why a difference between them is not a detail: it is a film in two looks.
  // Nothing enforced it until now, and they had already drifted without anyone noticing: the GPU's negative prompt
  // carried "low quality, worst quality" and the server's did not.
  const py = readFileSync(new URL("../worker/kleo_pictures.py", import.meta.url), "utf8");
  const lit = (re, what) => {
    const m = py.match(re);
    assert.ok(m, `worker/kleo_pictures.py no longer declares ${what} in the shape this test reads: check by hand`);
    return m[1];
  };
  // Scoped to the STYLE_SUFFIX block on purpose: "cartoon" is also a key of the MODELS table a few lines above,
  // and an unanchored search happily compared the suffix against "Lykon/dreamshaper-8".
  const block = py.match(/STYLE_SUFFIX\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(block, "worker/kleo_pictures.py no longer declares STYLE_SUFFIX as a dict literal");
  const suffix = (look) => {
    const m = block[1].match(new RegExp(`"${look}":\\s*"([^"]+)"`));
    assert.ok(m, `STYLE_SUFFIX has no ${look} entry`);
    return m[1];
  };
  assert.equal(suffix("cartoon"), STYLE_SUFFIX.cartoon);
  assert.equal(suffix("realistic"), STYLE_SUFFIX.realistic);
  assert.equal(suffix("animation"), STYLE_SUFFIX.animation);
  assert.equal(lit(/^NEGATIVE_PROMPT\s*=\s*"([^"]+)"/m, "the negative prompt"), NEGATIVE_PROMPT);
  // The per-look negative (14 September): the two photographic looks share the product-wide one, animation has its own.
  const neg = py.match(/STYLE_NEGATIVE\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(neg, "worker/kleo_pictures.py no longer declares STYLE_NEGATIVE as a dict literal");
  assert.match(neg[1], /"cartoon":\s*NEGATIVE_PROMPT/); assert.match(neg[1], /"realistic":\s*NEGATIVE_PROMPT/);
  assert.equal(neg[1].match(/"animation":\s*"([^"]+)"/)?.[1], STYLE_NEGATIVE.animation);
  assert.equal(STYLE_NEGATIVE.realistic, NEGATIVE_PROMPT); assert.equal(STYLE_NEGATIVE.cartoon, NEGATIVE_PROMPT);
  assert.match(STYLE_NEGATIVE.animation, /photograph/); assert.ok(!/anime|cartoon|drawing/.test(STYLE_NEGATIVE.animation), "the animation look must not ban the drawing");
  assert.ok(!/photograph/.test(NEGATIVE_PROMPT), "the realistic look must not ban the photograph");
});

test("no style suffix asks for something by forbidding it", () => {
  // CLIP does not read negation in the positive prompt: in SD1.5 "no text" is a documented way of getting MORE
  // text. Anything to be kept out belongs in NEGATIVE_PROMPT, where negation is structural and works.
  for (const [look, suffix] of Object.entries(STYLE_SUFFIX))
    assert.ok(!/\bno\s+\w/.test(suffix), `${look} suffix negates inside the positive prompt: "${suffix}"`);
});
