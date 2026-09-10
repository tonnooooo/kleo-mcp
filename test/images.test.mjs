/**
 * Unit tests for src/images.ts: the placeholder PNG encoder (IMAGE_FIXTURE=1), model inputs, response reading and the
 * generation loop against an in-memory env (no Workers AI, no network). Run: node --test test/images.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import {
  encodePng, placeholderPng, crc32, fnv1a, pickImageScenes, sizeFor, acceptsSize, modelInputs, readImageResult, sniffImage, fullPrompt,
  generateJobImages, DEFAULT_IMAGE_MODELS, IMAGE_NAME_RE, STYLE_SUFFIX,
} from "../src/images.ts";

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
  assert.equal(fnv1a("01-hook"), fnv1a("01-hook"));
  assert.notEqual(fnv1a("01-hook"), fnv1a("02-crew"));
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

test("placeholderPng: deterministic per scene id, portrait and landscape sizes, a visible stripe", async () => {
  const a = await placeholderPng("01-hook", 96, 168);
  const b = await placeholderPng("01-hook", 96, 168);
  const other = await placeholderPng("02-crew", 96, 168);
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
  assert.deepEqual(Object.keys(flux).sort(), ["prompt", "seed", "steps"]);
  const phoenix = modelInputs(DEFAULT_IMAGE_MODELS.realistic, "realistic", "A mountain road in rain", "16:9", 7);
  assert.equal(phoenix.width, 1344); assert.equal(phoenix.height, 768); assert.equal(phoenix.num_steps, 20);
  assert.ok(String(phoenix.negative_prompt).includes("text"));
  assert.ok(String(phoenix.prompt).endsWith(STYLE_SUFFIX.realistic));
  const sdxl = modelInputs("@cf/bytedance/stable-diffusion-xl-lightning", "realistic", "x", "9:16", 1);
  assert.equal(sdxl.width, 768); assert.equal(sdxl.guidance, 7.5);
  assert.equal(fullPrompt("cartoon", "no trailing dot"), `no trailing dot. ${STYLE_SUFFIX.cartoon}`);
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
  const files = new Map(), auditRows = [], kv = new Map();
  const db = {
    prepare(sql) {
      return {
        args: [], bind(...a) { this.args = a; return this; },
        async run() {
          if (sql.startsWith("INSERT OR REPLACE INTO job_files")) files.set(this.args[1], { job_id: this.args[0], name: this.args[1], key: this.args[2], size: this.args[3], content_type: this.args[4] });
          else if (sql.startsWith("INSERT INTO audit")) auditRows.push({ job_id: this.args[1], event: this.args[2], detail: this.args[3] });
          return { meta: { changes: 1 } };
        },
        async all() {
          if (sql.startsWith("SELECT * FROM job_files")) return { results: [...files.values()] };
          if (sql.includes("FROM audit")) return { results: auditRows.filter((r) => r.event === "images.error").map((r) => ({ detail: r.detail })) };
          return { results: [] };
        },
        async first() { return null; },
      };
    },
  };
  return { env: { DB: db, OAUTH_KV: { async put(k, v, o) { kv.set(k, { v, o }); }, async getWithMetadata(k) { const e = kv.get(k); return { value: e?.v ?? null, metadata: e?.o?.metadata }; } }, INTERNAL_SECRET: "s3cret", ...extra }, files, auditRows, kv };
}
const sceneList = (n) => Array.from({ length: n }, (_, i) => ({ id: `${String(i + 1).padStart(2, "0")}-s`, kind: "cinema", image_prompt: `picture ${i + 1}` }));
const jobFor = (style, n = 3, format = "9:16") => ({ id: "gt_img", user_id: "u1", params: JSON.stringify({ duration_s: 45, format, language: "en", voice: null, style }), storyboard: JSON.stringify({ style: "cinema", kleo_style: style, scenes: sceneList(n) }) });

test("fixture: one PNG per scene in job_files, signed /dl links, idempotent on a second call", async () => {
  const { env, files, auditRows, kv } = fakeEnv({ IMAGE_FIXTURE: "1" });
  const r = await generateJobImages(env, jobFor("cartoon"), "http://kleo.test");
  assert.equal(r.fixture, true); assert.equal(r.generated, 3); assert.equal(r.reused, 0); assert.deepEqual(r.missing, []);
  assert.deepEqual(Object.keys(r.images), ["01-s", "02-s", "03-s"]);
  for (const [id, url] of Object.entries(r.images)) {
    assert.match(url, new RegExp(`^http://kleo\\.test/dl/gt_img/img%2F${id}\\.png\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    assert.ok(IMAGE_NAME_RE.test(`img/${id}.png`));
    const f = files.get(`img/${id}.png`);
    assert.equal(f.key, `renders/gt_img/img/${id}.png`); assert.equal(f.content_type, "image/png"); assert.ok(f.size > 100);
    const stored = new Uint8Array(kv.get(`file:${f.key}`).v);
    assert.equal(sniffImage(stored), "png");
    assert.equal(be32(chunks(stored)[0].data, 0), 768); assert.equal(be32(chunks(stored)[0].data, 4), 1344);
  }
  assert.equal(auditRows.filter((a) => a.event === "images.generated").length, 1);
  const again = await generateJobImages(env, jobFor("cartoon"), "http://kleo.test");
  assert.equal(again.generated, 0); assert.equal(again.reused, 3); assert.equal(files.size, 3);
});

test("no pictures for cyber/stickman or without image_prompt; the cap spreads and lists the rest as missing", async () => {
  const { env } = fakeEnv({ IMAGE_FIXTURE: "1" });
  assert.deepEqual(await generateJobImages(env, jobFor("cyber"), "http://kleo.test"), { images: {}, missing: [], generated: 0, reused: 0, fixture: true });
  const r = await generateJobImages(env, jobFor("realistic", 14, "16:9"), "http://kleo.test");
  assert.equal(Object.keys(r.images).length, 10); assert.equal(r.missing.length, 4);
  assert.ok("01-s" in r.images && "14-s" in r.images, "first and last scenes keep their picture");
  const { env: env2 } = fakeEnv({ IMAGE_FIXTURE: "1", IMAGE_MAX_PER_JOB: "2" });
  const r2 = await generateJobImages(env2, jobFor("cartoon", 5), "http://kleo.test");
  assert.deepEqual(Object.keys(r2.images), ["01-s", "05-s"]); assert.deepEqual(r2.missing, ["02-s", "03-s", "04-s"]);
});

test("Workers AI: binary and base64 answers are stored with the right extension; errors and quota are never fatal and never retried", async () => {
  const calls = [];
  const png = await placeholderPng("ai", 16, 16);
  const ai = { async run(model, inputs) {
    calls.push({ model, inputs });
    if (inputs.prompt.startsWith("picture 1")) return new Blob([png]).stream();
    if (inputs.prompt.startsWith("picture 2")) return { image: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2]).toString("base64") };
    if (inputs.prompt.startsWith("picture 3")) throw new Error("AiError: 3010: model overloaded");
    throw new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons");
  } };
  const { env, files, auditRows } = fakeEnv({ AI: ai, IMAGE_MODEL_REALISTIC: "@cf/leonardo/lucid-origin" });
  const r = await generateJobImages(env, jobFor("realistic", 6), "http://kleo.test");
  assert.equal(r.fixture, false);
  assert.deepEqual(Object.keys(r.images), ["01-s", "02-s"]);
  assert.deepEqual(r.missing, ["03-s", "04-s", "05-s", "06-s"], "one AI error, one quota error, then the rest is skipped without a call");
  assert.equal(calls.length, 4);
  assert.equal(calls[0].model, "@cf/leonardo/lucid-origin"); assert.equal(calls[0].inputs.width, 768); assert.ok(calls[0].inputs.prompt.endsWith(STYLE_SUFFIX.realistic));
  assert.equal(files.get("img/01-s.png").content_type, "image/png"); assert.equal(files.get("img/02-s.jpg").content_type, "image/jpeg");
  const errors = auditRows.filter((a) => a.event === "images.error").map((a) => JSON.parse(a.detail));
  assert.deepEqual(errors.map((e) => e.scene), ["03-s", "04-s"]);
  assert.equal(errors[1].quota, true);
  // second call: the two pictures are reused, the two tried scenes are not retried, the untried ones get their one attempt
  const r2 = await generateJobImages(env, jobFor("realistic", 6), "http://kleo.test");
  assert.equal(r2.reused, 2); assert.equal(calls.length, 5, "05-s gets its single attempt (quota again), 06-s is skipped in the same call");
  assert.deepEqual(r2.missing, ["03-s", "04-s", "05-s", "06-s"]);
  const r3 = await generateJobImages(env, jobFor("realistic", 6), "http://kleo.test");
  assert.equal(calls.length, 6, "06-s gets its single attempt");
  assert.equal(r3.reused, 2);
  await generateJobImages(env, jobFor("realistic", 6), "http://kleo.test");
  assert.equal(calls.length, 6, "no scene is ever tried twice");
});

test("no AI binding and no fixture: everything is missing, nothing throws", async () => {
  const { env, auditRows } = fakeEnv();
  const r = await generateJobImages(env, jobFor("cartoon", 2), "http://kleo.test");
  assert.deepEqual(r.images, {}); assert.deepEqual(r.missing, ["01-s", "02-s"]);
  assert.ok(auditRows.some((a) => a.event === "images.error" && /no Workers AI binding/.test(a.detail)));
});
