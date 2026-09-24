/**
 * REFERENCE IMAGES (24 September 2026): src/refs.ts and the upload page (src/upload.ts), with a fake R2 bucket, a fake
 * vision model and a fake fetch — no network, no Workers AI. What is pinned: the upload link's signature and expiry,
 * the magic-byte check (HEIC and GIF refused in words), the 12 MB limit, the handle's shape and stability, the
 * description written once per picture with the role the user gave, the account boundary (a handle or an upload link
 * is one account's own), and the page's round trip.
 * Run: node --test test/refs.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  imageKind, refHandle, ingestRef, refsOf, refImage, listUploads, recordUploads, resolveRefs, makeUploadToken, readUploadToken,
  checkRefUrl, RefError, REF_HANDLE_RE, REF_MAX_BYTES, UPLOAD_MAX_FILES, UPLOAD_TTL_S,
} from "../src/refs.ts";
import { handleUpload } from "../src/upload.ts";

/* ------------------------------------------------------------------ fakes */

class FakeR2 {
  constructor() { this.m = new Map(); }
  async put(key, value, opts) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
    this.m.set(key, { bytes, type: opts?.httpMetadata?.contentType ?? null });
    return { size: bytes.byteLength };
  }
  async get(key) {
    const e = this.m.get(key);
    if (!e) return null;
    return { size: e.bytes.byteLength, httpMetadata: { contentType: e.type }, text: async () => new TextDecoder().decode(e.bytes), arrayBuffer: async () => e.bytes.slice().buffer };
  }
}
/** A vision model that answers a fixed description and records every prompt it was asked. */
function fakeAi(answer = "A thin woman in her thirties with short blonde hair tied up and a lilac apron.") {
  const calls = [];
  return { calls, async run(model, inputs) { calls.push({ model, inputs }); if (answer instanceof Error) throw answer; return { response: answer }; } };
}
const envOf = (extra = {}) => ({ RENDERS: new FakeR2(), AI: fakeAi(), INTERNAL_SECRET: "s3cret", ...extra });
const promptOf = (call) => call.inputs.messages[0].content.find((c) => c.type === "text").text;

/** Minimal pictures by their magic bytes; `n` changes one byte so each one has its own SHA-256 (and handle). */
const png = (n = 0) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, n & 255, (n >> 8) & 255, 0, 0]);
const jpeg = (n = 0) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, n & 255, 0, 0, 0, 0]);
const webp = () => new Uint8Array([...new TextEncoder().encode("RIFF"), 8, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 "), 0, 0]);
const heic = () => new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 0, 0, 0, 0]);
const gif = () => new Uint8Array([...new TextEncoder().encode("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0]);

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

/* ------------------------------------------------------------------ bytes, handles */

test("a picture is known by its magic bytes: PNG, JPEG and WebP pass; HEIC and GIF are refused with the way out", () => {
  assert.deepEqual(imageKind(png()), { ok: true, mime: "image/png", ext: "png" });
  assert.deepEqual(imageKind(jpeg()), { ok: true, mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(imageKind(webp()), { ok: true, mime: "image/webp", ext: "webp" });
  const h = imageKind(heic());
  assert.equal(h.ok, false); assert.match(h.why, /HEIC/); assert.match(h.why, /JPEG/, "the refusal says what to send instead");
  const g = imageKind(gif());
  assert.equal(g.ok, false); assert.match(g.why, /GIF/);
  assert.match(imageKind(new TextEncoder().encode("<html><body>not a picture</body></html>")).why, /not a PNG, JPEG or WebP/);
  assert.equal(imageKind(new Uint8Array(3)).ok, false, "too small to be anything");
});

test("the handle is kref_ + 8 hex of the picture's SHA-256: the same picture is always the same handle", async () => {
  const a = await refHandle(png(1)), b = await refHandle(png(1)), c = await refHandle(png(2));
  assert.match(a, REF_HANDLE_RE); assert.equal(a, b); assert.notEqual(a, c);
  assert.ok(!REF_HANDLE_RE.test("kref_ABCDEF12") && !REF_HANDLE_RE.test("kref_123") && !REF_HANDLE_RE.test("ref_12345678"));
});

/* ------------------------------------------------------------------ the upload token */

test("the upload token is signed, belongs to one account and expires after 48 hours", async () => {
  const env = envOf();
  const now = Date.parse("2026-09-24T10:00:00Z");
  const { token, expires_at } = await makeUploadToken(env, "u_mara", now);
  assert.match(token, /^[A-Za-z0-9_-]+\.[0-9a-f]{32}$/, "URL-safe: base64url payload, hex signature");
  assert.equal(expires_at, new Date(now + UPLOAD_TTL_S * 1000).toISOString());
  const r = await readUploadToken(env, token, { nowMs: now + 3600_000 });
  assert.equal(r.ok, true); assert.equal(r.userId, "u_mara");
  assert.deepEqual(await readUploadToken(env, token, { nowMs: now + 49 * 3600_000 }), { ok: false, error: "expired" });
  assert.equal((await readUploadToken(env, token, { nowMs: now + 49 * 3600_000, allowExpired: true })).ok, true, "what was uploaded stays readable");
  const [payload, sig] = token.split(".");
  const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
  assert.deepEqual(await readUploadToken(env, `${payload}.${flipped}`, { nowMs: now }), { ok: false, error: "bad" }, "a forged signature");
  const other = Buffer.from(JSON.stringify({ u: "u_thief", e: Math.floor(now / 1000) + 3600, n: "00" })).toString("base64url");
  assert.deepEqual(await readUploadToken(env, `${other}.${sig}`, { nowMs: now }), { ok: false, error: "bad" }, "another account's name under this signature");
  assert.deepEqual(await readUploadToken({ INTERNAL_SECRET: "another" }, token, { nowMs: now }), { ok: false, error: "bad" }, "another server's secret");
  assert.deepEqual(await readUploadToken(env, "not-a-token"), { ok: false, error: "bad" });
  await assert.rejects(() => makeUploadToken({ INTERNAL_SECRET: "" }, "u_mara"), (e) => e instanceof RefError && /not configured/.test(e.message));
  assert.notEqual((await makeUploadToken(env, "u_mara", now)).token, token, "every link has its own nonce, so its own list of pictures");
});

/* ------------------------------------------------------------------ ingest */

test("a picture is stored with its sidecar and described ONCE, with the role the user gave", async () => {
  const env = envOf();
  const r = await ingestRef(env, "u_mara", { bytes: png(7), role: "character", name: "Mara" });
  assert.match(r.handle, REF_HANDLE_RE); assert.equal(r.role, "character"); assert.equal(r.mime, "image/png"); assert.equal(r.bytes, 16);
  assert.match(r.description, /short blonde hair/);
  assert.ok(env.RENDERS.m.has(`refs/u_mara/${r.handle}.png`), "the picture, under the account's own prefix");
  const meta = JSON.parse(new TextDecoder().decode(env.RENDERS.m.get(`refs/u_mara/${r.handle}.json`).bytes));
  assert.equal(meta.name, "Mara"); assert.equal(meta.role, "character"); assert.equal(meta.description, r.description); assert.equal(meta.source, "bytes");
  assert.equal(env.AI.calls.length, 1);
  assert.match(promptOf(env.AI.calls[0]), /illustrator could draw exactly them again/, "a character is described for a painter: face, hair, clothes");
  // The same picture again: the same handle, no second vision call.
  const again = await ingestRef(env, "u_mara", { bytes: png(7) });
  assert.equal(again.handle, r.handle); assert.equal(again.description, r.description); assert.equal(env.AI.calls.length, 1);
  // Given now as a STYLE, it is described again for what a style needs.
  await ingestRef(env, "u_mara", { bytes: png(7), role: "style" });
  assert.equal(env.AI.calls.length, 2); assert.match(promptOf(env.AI.calls[1]), /visual STYLE/);
});

test("ingest refuses in words: too big, not a picture, no store; a silent vision model still keeps the picture", async () => {
  const env = envOf();
  const big = new Uint8Array(REF_MAX_BYTES + 1); big.set(png());
  await assert.rejects(() => ingestRef(env, "u", { bytes: big }), (e) => e instanceof RefError && /12\.0 MB/.test(e.message) && /Nothing was charged/.test(e.message));
  await assert.rejects(() => ingestRef(env, "u", { bytes: heic() }), (e) => e instanceof RefError && /HEIC/.test(e.message));
  await assert.rejects(() => ingestRef(env, "u", { bytes: gif() }), (e) => e instanceof RefError && /GIF/.test(e.message));
  await assert.rejects(() => ingestRef({ AI: fakeAi() }, "u", { bytes: png() }), (e) => e instanceof RefError && /no file store/.test(e.message));
  await assert.rejects(() => ingestRef(env, "u", {}), (e) => e instanceof RefError && /https:\/\/ link or the picture itself/.test(e.message));
  const mute = envOf({ AI: fakeAi(new Error("vision down")) });
  const r = await ingestRef(mute, "u", { bytes: jpeg(3), role: "object" });
  assert.equal(r.description, "", "no description, but the picture is kept: the spec writer describes it");
  assert.ok(mute.RENDERS.m.has(`refs/u/${r.handle}.jpg`));
});

test("a URL is fetched over https only, bounded in size, and every failure is a sentence", async () => {
  assert.throws(() => checkRefUrl("http://example.com/a.png"), (e) => e instanceof RefError && /only fetches pictures over https/.test(e.message));
  assert.throws(() => checkRefUrl("https://localhost/a.png"), (e) => e instanceof RefError && /not a public address/.test(e.message));
  assert.throws(() => checkRefUrl("https://192.168.1.4/a.png"), RefError);
  assert.throws(() => checkRefUrl("a picture of my cat"), (e) => e instanceof RefError && /not a web address/.test(e.message));
  const env = envOf();
  const seen = [];
  const r = await withFetch(async (url) => { seen.push(String(url)); return new Response(jpeg(9), { status: 200, headers: { "content-type": "image/jpeg" } }); },
    () => ingestRef(env, "u_mara", { url: "https://cdn.example.com/photos/mara.jpg?token=SECRET", role: "character" }));
  assert.equal(seen.length, 1); assert.match(r.handle, REF_HANDLE_RE); assert.equal(r.mime, "image/jpeg");
  const meta = JSON.parse(new TextDecoder().decode(env.RENDERS.m.get(`refs/u_mara/${r.handle}.json`).bytes));
  assert.equal(meta.origin, "https://cdn.example.com/photos/mara.jpg", "the query string (a signed URL's secret) is never stored");
  assert.equal(meta.source, "url");
  await withFetch(async () => new Response("nope", { status: 404 }),
    () => assert.rejects(() => ingestRef(env, "u", { url: "https://example.com/missing.png" }), (e) => e instanceof RefError && /HTTP 404/.test(e.message)));
  await withFetch(async () => new Response(png(), { status: 200, headers: { "content-length": String(REF_MAX_BYTES + 10) } }),
    () => assert.rejects(() => ingestRef(env, "u", { url: "https://example.com/huge.png" }), (e) => e instanceof RefError && /up to 12\.0 MB/.test(e.message)));
  await withFetch(async () => new Response(new Uint8Array(REF_MAX_BYTES + 5)),
    () => assert.rejects(() => ingestRef(env, "u", { url: "https://example.com/streamed.png" }), (e) => e instanceof RefError && /12\.0 MB/.test(e.message)), "a body with no length is counted as it streams");
  await withFetch(async () => { throw new TypeError("fetch failed"); },
    () => assert.rejects(() => ingestRef(env, "u", { url: "https://example.com/a.png" }), (e) => e instanceof RefError && /could not reach example\.com/.test(e.message)));
  await withFetch(async () => new Response(new TextEncoder().encode("<html>a gallery page, not the picture</html>")),
    () => assert.rejects(() => ingestRef(env, "u", { url: "https://example.com/gallery" }), (e) => e instanceof RefError && /not a PNG, JPEG or WebP/.test(e.message)));
});

/* ------------------------------------------------------------------ reading back, the account boundary */

test("refsOf and refImage read one account's pictures; another account's handle is simply not there", async () => {
  const env = envOf();
  const a = await ingestRef(env, "u_mara", { bytes: png(11), role: "character", name: "Mara" });
  const got = await refsOf(env, "u_mara", [a.handle]);
  assert.deepEqual(got, [{ handle: a.handle, role: "character", description: a.description, key: `refs/u_mara/${a.handle}.png`, mime: "image/png", name: "Mara" }]);
  await assert.rejects(() => refsOf(env, "u_other", [a.handle]), (e) => e instanceof RefError && /not a picture Kleo received from this account/.test(e.message));
  assert.deepEqual(await refsOf(env, "u_other", [a.handle], { skipMissing: true }), []);
  const img = await refImage(env, "u_mara", a.handle);
  assert.equal(img.mime, "image/png"); assert.deepEqual([...img.bytes], [...png(11)]);
  assert.equal(await refImage(env, "u_other", a.handle), null);
  assert.equal(await refImage(env, "u_mara", "kref_00000000"), null);
});

test("resolveRefs: upload links expand to their pictures, only for their own account; at most eight", async () => {
  const env = envOf();
  const { token } = await makeUploadToken(env, "u_mara");
  await assert.rejects(() => resolveRefs(env, "u_mara", [{ upload: token }]), (e) => e instanceof RefError && /Nothing has been uploaded through that link yet/.test(e.message));
  const a = await ingestRef(env, "u_mara", { bytes: png(21), source: "upload" });
  const b = await ingestRef(env, "u_mara", { bytes: jpeg(22), source: "upload" });
  await recordUploads(env, "u_mara", token, [a.handle, b.handle, a.handle]);
  assert.deepEqual(await listUploads(env, "u_mara", token), [a.handle, b.handle], "deduplicated, in arrival order");
  const r = await resolveRefs(env, "u_mara", [{ upload: token, role: "character", name: "Mara" }, { handle: a.handle }]);
  assert.deepEqual(r.map((x) => x.handle), [a.handle, b.handle]);
  assert.equal(r[0].role, "character"); assert.equal(r[0].name, "Mara", "what the user said on the call wins");
  await assert.rejects(() => resolveRefs(env, "u_thief", [{ upload: token }]), (e) => e instanceof RefError && /not an upload link of this account/.test(e.message));
  await assert.rejects(() => resolveRefs(env, "u_mara", [{ role: "character" }]), (e) => e instanceof RefError && /needs a picture/.test(e.message));
  const many = [];
  for (let i = 0; i < 9; i++) many.push({ handle: (await ingestRef(env, "u_mara", { bytes: png(100 + i) })).handle });
  await assert.rejects(() => resolveRefs(env, "u_mara", many), (e) => e instanceof RefError && /at most 8 reference pictures/.test(e.message));
});

/* ------------------------------------------------------------------ the page */

test("the upload page: a phone-first page for a good link, a sentence for a bad or expired one, pictures in and thumbnails out", async () => {
  const env = envOf();
  const { token } = await makeUploadToken(env, "u_mara");
  const at = (path, init) => handleUpload(new Request(`https://kleo.test${path}`, init), env);
  const page = await at(`/upload/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await page.text();
  assert.match(html, /name="viewport"/); assert.ok(html.includes(token));
  assert.match(html, /Immagini per il tuo film Kleo/, "the Italian text ships with the English"); assert.match(html, /Pictures for your Kleo film/);
  assert.doesNotMatch(html, /<script[^>]+src=/, "nothing external");

  const fd = new FormData();
  fd.append("file", new File([png(31)], "mara.png", { type: "image/png" }));
  fd.append("file", new File([heic()], "IMG_0001.HEIC", { type: "image/heic" }));
  fd.append("role", "character"); fd.append("name", "Mara");
  const up = await at(`/upload/${token}`, { method: "POST", body: fd });
  assert.equal(up.status, 200);
  const j = await up.json();
  assert.equal(j.ok, true); assert.equal(j.uploaded.length, 1); assert.match(j.uploaded[0].handle, REF_HANDLE_RE);
  assert.equal(j.uploaded[0].thumb, `/upload/${token}/${j.uploaded[0].handle}`);
  assert.equal(j.errors.length, 1); assert.match(j.errors[0].error, /HEIC/); assert.doesNotMatch(j.errors[0].error, /Nothing was charged/, "the page is not a tool answer");
  assert.equal(j.total, 1); assert.equal(j.remaining, UPLOAD_MAX_FILES - 1);
  assert.deepEqual(await listUploads(env, "u_mara", token), [j.uploaded[0].handle]);
  assert.equal((await refsOf(env, "u_mara", [j.uploaded[0].handle]))[0].role, "character");
  const thumb = await at(j.uploaded[0].thumb);
  assert.equal(thumb.status, 200); assert.equal(thumb.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await thumb.arrayBuffer())], [...png(31)]);
  // Only pictures uploaded through THIS link are served.
  const stranger = await ingestRef(env, "u_mara", { bytes: png(32) });
  assert.equal((await at(`/upload/${token}/${stranger.handle}`)).status, 404);

  // Eight pictures per link, whatever arrives.
  const lots = new FormData();
  for (let i = 0; i < UPLOAD_MAX_FILES + 1; i++) lots.append("file", new File([png(200 + i)], `p${i}.png`, { type: "image/png" }));
  const full = await (await at(`/upload/${token}`, { method: "POST", body: lots })).json();
  assert.equal(full.total, UPLOAD_MAX_FILES); assert.equal(full.remaining, 0);
  assert.equal(full.errors.length, 2, "one picture was already there: seven more fit, two do not"); assert.match(full.errors[0].error, /it is full/);

  // A forged link and an expired one are refused with a page that says what to do.
  const bad = await at(`/upload/${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`);
  assert.equal(bad.status, 403); assert.match(await bad.text(), /not a valid Kleo upload link/);
  const old = await makeUploadToken(env, "u_mara", Date.now() - (UPLOAD_TTL_S + 60) * 1000);
  const gone = await at(`/upload/${old.token}`, { headers: { "accept-language": "it-IT,it;q=0.9" } });
  assert.equal(gone.status, 410); assert.match(await gone.text(), /è scaduto/);
  const late = await at(`/upload/${old.token}`, { method: "POST", body: fd });
  assert.equal(late.status, 410); assert.match((await late.json()).error, /expired/);
  assert.equal((await at("/upload/")).status, 404);
});
