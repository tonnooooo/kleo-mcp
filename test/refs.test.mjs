/**
 * REFERENCE IMAGES (24 September 2026): src/refs.ts and the upload page (src/upload.ts), with a fake R2 bucket, a fake
 * vision model and a fake fetch — no network, no Workers AI. What is pinned: the upload link's signature and expiry,
 * the magic-byte check (HEIC and GIF refused in words), the 12 MB limit, the handle's shape and stability, the
 * description written once per picture with the role the user gave, the account boundary (a handle or an upload link
 * is one account's own), and the page's round trip. Since the security pass of the same day: every redirect hop checked
 * (https, public host, at most three), a slow or broken body answered in words, the upload POST bounded before it is
 * buffered, the link's list an append that concurrent uploads cannot lose entries from and cannot push past eight,
 * and the retention (REF_TTL_DAYS after the last use, a per-account cap, the purge).
 * Run: node --test test/refs.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  imageKind, refHandle, ingestRef, refsOf, refImage, listUploads, recordUploads, resolveRefs, makeUploadToken, readUploadToken,
  checkRefUrl, fetchRefBytes, purgeOldRefs, RefError, REF_HANDLE_RE, REF_MAX_BYTES, REF_MAX_PER_USER, REF_MAX_REDIRECTS, REF_TTL_DAYS,
  UPLOAD_MAX_FILES, UPLOAD_TTL_S,
} from "../src/refs.ts";
import { handleUpload, UPLOAD_MAX_BODY } from "../src/upload.ts";

/* ------------------------------------------------------------------ fakes */

/**
 * An R2 bucket in memory: put / get / list / delete. Every put gets its own `uploaded` date one millisecond after the
 * last (R2's commit time, which the upload list orders by); `age` backdates an object for the retention tests.
 */
class FakeR2 {
  constructor() { this.m = new Map(); this.t = Date.now(); }
  async put(key, value, opts) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
    this.m.set(key, { bytes, type: opts?.httpMetadata?.contentType ?? null, uploaded: new Date(++this.t) });
    return { size: bytes.byteLength };
  }
  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = cursor ? Number(cursor) : 0;
    const page = keys.slice(from, from + limit);
    const truncated = from + limit < keys.length;
    return { objects: page.map((key) => ({ key, uploaded: this.m.get(key).uploaded, size: this.m.get(key).bytes.byteLength })), truncated, cursor: truncated ? String(from + limit) : undefined, delimitedPrefixes: [] };
  }
  async delete(keys) { for (const k of [].concat(keys)) this.m.delete(k); }
  age(key, days) { this.m.get(key).uploaded = new Date(Date.now() - days * 86_400_000); }
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

/* ------------------------------------------------------------------ security pass (24 September 2026) */

/** A fake fetch that answers from a route table and records every hop it was asked for, with its redirect mode. */
function routes(table) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url: String(url), redirect: init?.redirect });
    const r = table[String(url)];
    if (!r) throw new TypeError(`no route for ${url}`);
    return r(init);
  };
  f.seen = seen;
  return f;
}
const redirectTo = (to, status = 302) => () => new Response(null, { status, headers: to === null ? {} : { location: to } });
const imageAnswer = (bytes) => () => new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } });

test("redirects are followed by hand: every hop must be https and public, at most three, and the origin stored is the user's link", async () => {
  const ok = routes({
    "https://short.example/m?sig=SECRET": redirectTo("/img/m.jpg", 301),
    "https://short.example/img/m.jpg": redirectTo("https://cdn.example/m.jpg"),
    "https://cdn.example/m.jpg": imageAnswer(jpeg(41)),
  });
  const got = await withFetch(ok, () => fetchRefBytes("https://short.example/m?sig=SECRET"));
  assert.deepEqual([...got.bytes], [...jpeg(41)]);
  assert.equal(got.origin, "https://short.example/m", "the link the user gave, without its query");
  assert.deepEqual(ok.seen.map((s) => s.url), ["https://short.example/m?sig=SECRET", "https://short.example/img/m.jpg", "https://cdn.example/m.jpg"], "a relative Location is resolved against its hop");
  assert.ok(ok.seen.every((s) => s.redirect === "manual"), "the runtime never follows a redirect on its own");

  const plain = routes({ "https://a.example/p": redirectTo("http://b.example/p.jpg"), "http://b.example/p.jpg": imageAnswer(jpeg(42)) });
  await withFetch(plain, () => assert.rejects(() => fetchRefBytes("https://a.example/p"), (e) => e instanceof RefError && /not https/.test(e.message) && /Nothing was charged/.test(e.message)));
  assert.equal(plain.seen.length, 1, "the plaintext hop is never fetched");

  const inside = routes({ "https://a.example/q": redirectTo("https://127.0.0.1/x.jpg"), "https://127.0.0.1/x.jpg": imageAnswer(jpeg(43)) });
  await withFetch(inside, () => assert.rejects(() => fetchRefBytes("https://a.example/q"), (e) => e instanceof RefError && /127\.0\.0\.1/.test(e.message) && /not a public address/.test(e.message)));
  assert.equal(inside.seen.length, 1, "a private host is never asked");

  const chain = (n) => {
    const t = {};
    for (let i = 0; i < n; i++) t[`https://hop.example/${i}`] = redirectTo(`https://hop.example/${i + 1}`);
    t[`https://hop.example/${n}`] = imageAnswer(jpeg(44));
    return routes(t);
  };
  const three = chain(REF_MAX_REDIRECTS);
  assert.equal((await withFetch(three, () => fetchRefBytes("https://hop.example/0"))).bytes.length, 16, "three redirects are fine");
  const four = chain(REF_MAX_REDIRECTS + 1);
  await withFetch(four, () => assert.rejects(() => fetchRefBytes("https://hop.example/0"), (e) => e instanceof RefError && /more than 3 times/.test(e.message)));
  assert.equal(four.seen.length, REF_MAX_REDIRECTS + 1, "the fourth redirect is not followed");

  await withFetch(routes({ "https://nowhere.example/a": redirectTo(null) }),
    () => assert.rejects(() => fetchRefBytes("https://nowhere.example/a"), (e) => e instanceof RefError && /without saying where/.test(e.message)));
});

test("a host that stalls or breaks is answered in words: headers late, a body that trickles, a reset mid-body", async () => {
  const aborted = () => new DOMException("The operation was aborted", "AbortError");
  // Headers never come: the fetch itself is aborted.
  await withFetch(async (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(aborted()))),
    () => assert.rejects(() => fetchRefBytes("https://slow.example/a.jpg", { timeoutMs: 30 }), (e) => e instanceof RefError && /did not send the picture within/.test(e.message)));
  // Headers at once, then the body trickles past the timer: the pending read rejects with an AbortError.
  await withFetch(async (url, init) => new Response(new ReadableStream({
    start(c) { c.enqueue(jpeg(5)); init.signal.addEventListener("abort", () => c.error(aborted())); },
  })), () => assert.rejects(() => fetchRefBytes("https://slow.example/b.jpg", { timeoutMs: 30 }), (e) => e instanceof RefError && /did not send the picture within/.test(e.message) && /Nothing was charged/.test(e.message)));
  // A reset in the middle of the body.
  await withFetch(async () => new Response(new ReadableStream({
    start(c) { c.enqueue(jpeg(6)); },
    pull(c) { c.error(new TypeError("network connection lost")); },
  })), () => assert.rejects(() => fetchRefBytes("https://flaky.example/c.jpg"), (e) => e instanceof RefError && /could not finish downloading the picture from flaky\.example/.test(e.message)));
  // Through ingestRef (what kleo_adapt_prompt calls) it is the same sentence, never a raw AbortError.
  await withFetch(async () => new Response(new ReadableStream({ start(c) { c.enqueue(jpeg(7)); }, pull(c) { c.error(new TypeError("reset")); } })),
    () => assert.rejects(() => ingestRef(envOf(), "u", { url: "https://flaky.example/d.jpg" }), RefError));
});

test("the upload POST is bounded before it is buffered: by content-length when sent, by counting the bytes when not", async () => {
  const env = envOf();
  const { token } = await makeUploadToken(env, "u_mara");
  const url = `https://kleo.test/upload/${token}`;
  // A plain object stands in for the Request, so the headers are exactly what a hand-built client would send.
  const post = (headers, body) => handleUpload({ url, method: "POST", headers: new Headers(headers), body }, env);
  const declared = await post({ "content-length": String(UPLOAD_MAX_BODY + 1), "content-type": "multipart/form-data; boundary=x" }, null);
  assert.equal(declared.status, 413); assert.match((await declared.json()).error, /one picture at a time/);
  assert.ok(UPLOAD_MAX_BODY < 2 * REF_MAX_BYTES, "one picture per request, not eight");
  assert.equal((await post({ "content-length": "lots", "content-type": "multipart/form-data; boundary=x" }, null)).status, 400);
  // No content-length at all (chunked, HTTP/2): the stream is counted and dropped at the cap, not read to its end.
  let pulled = 0;
  const endless = new ReadableStream({ pull(c) { pulled++; if (pulled > 40) c.close(); else c.enqueue(new Uint8Array(1024 * 1024)); } });
  const chunked = await post({ "content-type": "multipart/form-data; boundary=x" }, endless);
  assert.equal(chunked.status, 413);
  assert.ok(pulled <= Math.ceil(UPLOAD_MAX_BODY / (1024 * 1024)) + 4, `stopped at the cap, not at 40 MB (pulled ${pulled} MB)`);
  assert.equal(env.AI.calls.length, 0, "nothing reached the vision model");
  assert.deepEqual(await listUploads(env, "u_mara", token), []);
});

test("concurrent uploads to one link lose no picture and never pass the cap", async () => {
  const env = envOf();
  const { token } = await makeUploadToken(env, "u_mara");
  const handles = [];
  for (let i = 0; i < UPLOAD_MAX_FILES + 2; i++) handles.push((await ingestRef(env, "u_mara", { bytes: png(400 + i), source: "upload" })).handle);
  // Eight at once: the old read-add-put list kept only the last writer's picture.
  const eight = await Promise.all(handles.slice(0, UPLOAD_MAX_FILES).map((h) => recordUploads(env, "u_mara", token, [h])));
  assert.ok(eight.every((r) => r.full.length === 0));
  assert.deepEqual(new Set(await listUploads(env, "u_mara", token)), new Set(handles.slice(0, UPLOAD_MAX_FILES)), "every picture is on the list");
  // Two more at once on a full link: both are taken back, the list stays at eight.
  const late = await Promise.all(handles.slice(UPLOAD_MAX_FILES).map((h) => recordUploads(env, "u_mara", token, [h])));
  assert.deepEqual(late.map((r) => r.full.length), [1, 1]);
  assert.equal((await listUploads(env, "u_mara", token)).length, UPLOAD_MAX_FILES);
  assert.equal([...env.RENDERS.m.keys()].filter((k) => k.includes("/up/")).length, UPLOAD_MAX_FILES, "the refused entries are deleted, not just hidden");

  // Through the page: seven on the link, two devices race for the last place; exactly one gets it.
  const env2 = envOf();
  const t2 = (await makeUploadToken(env2, "u_mara")).token;
  const seven = [];
  for (let i = 0; i < UPLOAD_MAX_FILES - 1; i++) seven.push((await ingestRef(env2, "u_mara", { bytes: png(500 + i) })).handle);
  await recordUploads(env2, "u_mara", t2, seven);
  const form = (n) => { const fd = new FormData(); fd.append("file", new File([png(n)], `p${n}.png`, { type: "image/png" })); return fd; };
  const [a, b] = await Promise.all([600, 601].map((n) => handleUpload(new Request(`https://kleo.test/upload/${t2}`, { method: "POST", body: form(n) }), env2)));
  const answers = [await a.json(), await b.json()];
  assert.equal(answers.filter((j) => j.uploaded.length === 1).length, 1, "one device keeps the eighth place");
  assert.equal(answers.filter((j) => j.errors.some((e) => /it is full/.test(e.error))).length, 1, "the other is told the link is full");
  assert.equal((await listUploads(env2, "u_mara", t2)).length, UPLOAD_MAX_FILES);
});

test("retention: pictures go REF_TTL_DAYS after their last use, a use keeps them, the purge throttles itself, and an account holds at most REF_MAX_PER_USER", async () => {
  const env = envOf();
  const r2 = env.RENDERS;
  const { token } = await makeUploadToken(env, "u_mara");
  const old = await ingestRef(env, "u_mara", { bytes: png(701), source: "upload" });
  const kept = await ingestRef(env, "u_mara", { bytes: png(702) });
  const used = await ingestRef(env, "u_mara", { bytes: png(703) });
  await recordUploads(env, "u_mara", token, [old.handle]);
  for (const h of [old.handle, used.handle]) { r2.age(`refs/u_mara/${h}.json`, REF_TTL_DAYS + 1); r2.age(`refs/u_mara/${h}.png`, REF_TTL_DAYS + 5); }
  // The sidecar remembers a use two days back; a use now (kleo_create_video naming it) rewrites it and so keeps it.
  const usedMeta = JSON.parse(new TextDecoder().decode(r2.m.get(`refs/u_mara/${used.handle}.json`).bytes));
  const back = new Date(Date.now() - 2 * 86_400_000).toISOString();
  await r2.put(`refs/u_mara/${used.handle}.json`, JSON.stringify({ ...usedMeta, last_used_at: back }));
  r2.age(`refs/u_mara/${used.handle}.json`, REF_TTL_DAYS + 1);
  await refsOf(env, "u_mara", [used.handle]);
  assert.notEqual(JSON.parse(new TextDecoder().decode(r2.m.get(`refs/u_mara/${used.handle}.json`).bytes)).last_used_at, back, "the use is written down");
  // An old entry of another link, an image whose sidecar never landed, and a fresh orphan.
  const oldEntry = `refs/u_mara/up/${"a".repeat(32)}/kref_0badf00d`;
  await r2.put(oldEntry, ""); r2.age(oldEntry, REF_TTL_DAYS + 3);
  await r2.put("refs/u_mara/kref_deadbeef.jpg", jpeg(1)); r2.age("refs/u_mara/kref_deadbeef.jpg", REF_TTL_DAYS + 9);
  await r2.put("refs/u_mara/kref_cafebabe.jpg", jpeg(2));

  const run = await purgeOldRefs(env, Date.now(), { force: true });
  assert.deepEqual(run, { ran: true, refs: 2, links: 1 }, "the unused picture and the old orphan; one old link entry");
  assert.ok(!r2.m.has(`refs/u_mara/${old.handle}.json`) && !r2.m.has(`refs/u_mara/${old.handle}.png`), "the picture and its description are gone");
  assert.ok(r2.m.has(`refs/u_mara/${kept.handle}.png`) && r2.m.has(`refs/u_mara/${used.handle}.png`), "a fresh picture and a used one stay");
  assert.ok(!r2.m.has("refs/u_mara/kref_deadbeef.jpg") && r2.m.has("refs/u_mara/kref_cafebabe.jpg"));
  assert.ok(!r2.m.has(oldEntry));
  // The link's own entry outlives the picture (48 h + REF_TTL_DAYS): the tool says what happened, in words.
  await assert.rejects(() => resolveRefs(env, "u_mara", [{ upload: token }]), (e) => e instanceof RefError && /were deleted/.test(e.message) && new RegExp(`${REF_TTL_DAYS} days`).test(e.message));
  // Throttled: a second call within six hours does nothing; later it runs again.
  assert.equal((await purgeOldRefs(env, Date.now())).ran, false);
  assert.equal((await purgeOldRefs(env, Date.now() + 7 * 3600_000)).ran, true);
  assert.deepEqual(await purgeOldRefs({}, Date.now()), { ran: false, refs: 0, links: 0 }, "no store, nothing to do");

  // The per-account cap: counted before the vision call, a known picture still passes.
  const many = envOf();
  for (let i = 0; i < REF_MAX_PER_USER; i++) await ingestRef(many, "u_many", { bytes: jpeg(1000 + i) });
  const calls = many.AI.calls.length;
  await assert.rejects(() => ingestRef(many, "u_many", { bytes: png(9999) }), (e) => e instanceof RefError && new RegExp(`already holds ${REF_MAX_PER_USER}`).test(e.message) && /Nothing was charged/.test(e.message));
  assert.equal(many.AI.calls.length, calls, "no vision call for a refused picture");
  assert.match((await ingestRef(many, "u_many", { bytes: jpeg(1000) })).handle, REF_HANDLE_RE, "a picture it already holds is fine");
  assert.match((await ingestRef(many, "u_other", { bytes: png(9999) })).handle, REF_HANDLE_RE, "the cap is per account");

  // The page tells the user how long the pictures stay.
  const html = await (await handleUpload(new Request(`https://kleo.test/upload/${token}`), env)).text();
  assert.match(html, new RegExp(`deleted ${REF_TTL_DAYS} days after Kleo last uses them`)); assert.match(html, new RegExp(`cancellate ${REF_TTL_DAYS} giorni`));
});
