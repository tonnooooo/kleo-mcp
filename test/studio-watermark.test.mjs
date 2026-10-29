/**
 * The Kleo mark on free creations (src/studio/watermark.ts, watermark/): the kleo-studio Worker bundled with esbuild
 * and driven through its fetch handler, on a D1 look-alike (node:sqlite, every migration applied), an in-memory R2,
 * a fake Cloudflare Images binding and a fake kleo-watermark service. Covers who shows the mark (never paid: yes;
 * a payment, an admin, a Kleo Creators Pro partner, STUDIO_WATERMARK=off: no), where it sits (and that the
 * Container's server.py agrees), the picture and the clip saved clean with a marked copy beside them, which copy the
 * owner, a share link and a provider get, the first purchase taking the mark off, a free animatic copied as the GPU
 * box marked it, a failed or missing marker leaving the creation clean and done, a missing picture copy drawn when it is
 * next served, the 2K cap of a free rewrite, and deleting a creation deleting both files.
 * Run: node --test test/studio-watermark.test.mjs
 */
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "cloudflare:email") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export class EmailMessage { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } }") };
  return next(s, c);
}`));
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARK_PNG = new Uint8Array(readFileSync(join(ROOT, "studio-web", "made-with-kleo.png")));
const MARKED = new TextEncoder().encode("MARKED:");
const concat = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
const DAY = 86_400_000;

class Stmt {
  constructor(db, sql) { this.stmt = db.prepare(sql); this.args = []; }
  bind(...a) { this.args = a.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)); return this; }
  async run() { const r = this.stmt.run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
  async first() { return this.stmt.get(...this.args) ?? null; }
  async all() { return { results: this.stmt.all(...this.args) }; }
}
class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}
class FakeR2 {
  constructor() { this.m = new Map(); }
  async put(key, body, opts) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    this.m.set(key, { bytes, type: opts?.httpMetadata?.contentType });
    return { size: bytes.byteLength };
  }
  async get(key) {
    const e = this.m.get(key);
    if (!e) return null;
    return { size: e.bytes.byteLength, httpEtag: '"x"', httpMetadata: { contentType: e.type }, body: new Response(e.bytes).body, arrayBuffer: async () => e.bytes.buffer };
  }
  async head(key) { const e = this.m.get(key); return e ? { size: e.bytes.byteLength, httpEtag: '"x"', httpMetadata: { contentType: e.type } } : null; }
  async delete(keys) { for (const k of [].concat(keys)) this.m.delete(k); }
  async list({ prefix = "" } = {}) { return { objects: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; }
}
/** Cloudflare Images as the binding is called: records each output (its draw options, the overlay's resize and first bytes). */
class FakeImages {
  constructor(width, height) { this.width = width; this.height = height; this.made = []; this.tries = 0; this.fail = null; }
  async info(stream) { await new Response(stream).arrayBuffer(); return { format: "image/png", fileSize: 1, width: this.width, height: this.height }; }
  input(stream) {
    const op = { stream, transforms: [], draws: [] };
    const t = {
      op,
      transform: (o) => { op.transforms.push(o); return t; },
      draw: (img, o) => { op.draws.push({ img, o }); return t; },
      output: async (o) => {
        this.tries++;
        if (this.fail) throw new Error(this.fail);
        const bytes = new Uint8Array(await new Response(op.stream).arrayBuffer());
        const draws = await Promise.all(op.draws.map(async (d) => ({ o: d.o, transforms: d.img.op.transforms, head: [...new Uint8Array(await new Response(d.img.op.stream).arrayBuffer()).slice(0, 4)] })));
        this.made.push({ format: o.format, quality: o.quality, draws });
        const out = concat(MARKED, bytes);
        return { contentType: () => o.format, response: () => new Response(out, { headers: { "content-type": o.format } }) };
      },
    };
    return t;
  }
}
/** The kleo-watermark Worker behind the service binding: answers the clip with MARKED: in front, or an error. */
function fakeMarker({ fail = false } = {}) {
  const got = [];
  return {
    got,
    fetch: async (url, init) => {
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      got.push({ url: String(url), method: init.method, size: bytes.length });
      if (fail) return new Response("ffmpeg died", { status: 422 });
      const out = concat(MARKED, bytes);
      return new Response(out, { headers: { "content-type": "video/mp4", "content-length": String(out.length), "x-mark-cpu-s": "3.20" } });
    },
  };
}
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://cloudflare-dns.com/dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }), { headers: { "content-type": "application/dns-json" } });
    return real(url, init);
  };
}
globalThis.FixedLengthStream ??= class extends TransformStream { constructor() { super(); } };

let worker, mod;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts"; export { markPlacement, markedKey, madeByKleo, VIDEO_MARK_TIMEOUT_MS, IMAGES_MAX_INPUT } from "./src/studio/watermark.ts";
      export { showsMark } from "./src/studio/generate.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email"],
  });
  mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
  worker = mod.default;
});

function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: new FakeR2(),
    ASSETS: { fetch: async (req) => new URL(String(req.url ?? req)).pathname === "/made-with-kleo.png" ? new Response(MARK_PNG, { headers: { "content-type": "image/png" } }) : new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    IMAGES: new FakeImages(1024, 1820),
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", EPHONE_API_KEY: "ek", FREE_CREDITS: "5",
    STUDIO_FREE_MODELS: "seedance-2.0-fast", STUDIO_DAILY_BUDGET_USD: "30", MAX_NEW_USERS_PER_IP_DAY: "50", MAX_ACCOUNTS_PER_ADDRESS: "50",
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
async function call(env, path, { method = "GET", body, raw, cookie, headers = {} } = {}) {
  const h = { "x-kleo": "1", ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await worker.fetch(new Request(`https://app.kleo.test${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env, ctx);
  await Promise.allSettled(pending.splice(0));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, bytes, res };
}
async function account(env, email) {
  const r = await call(env, "/api/auth/signup", { method: "POST", body: { email, password: "long enough pw" } });
  assert.equal(r.status, 200, r.text);
  const cookie = (r.res.headers.get("set-cookie") ?? "").split(";")[0];
  return { cookie, id: (await call(env, "/api/me", { cookie })).json.id };
}
const pay = (env, id) => env.DB.db.exec(`INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('manual_${id}', '${id}', 0, 500, 'eur', 'paid', 'tester')`);
const old = (env) => env.DB.db.exec("UPDATE studio_generations SET checked_at = '2000-01-01T00:00:00.000Z'");
const events = (env, event) => env.DB.db.prepare("SELECT job_id, detail FROM audit WHERE event = ?").all(event).map((r) => ({ id: r.job_id, ...JSON.parse(r.detail ?? "{}") }));
const startsMarked = (bytes) => MARKED.every((b, i) => bytes[i] === b);

/** A fake ePhone: records what was sent, answers what the test scripted. */
function fakeProvider(script) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = String(init.body); }
    sent.push({ url: u, body });
    return script(u, init, sent);
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}
const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const PNG = (() => { const b = new Uint8Array(4000).fill(5); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; })();
const CLIP = new Uint8Array(5000).fill(7);
const studio = (script, picture = PNG) => fakeProvider((u, init, sent) => {
  if (u.endsWith("/v1/task/submit")) return ok({ id: `task_${sent.filter((s) => s.url.endsWith("/v1/task/submit")).length}` });
  if (/\/v1\/task\/task_\d+$/.test(u)) {
    const n = Number(u.split("task_").pop());
    const submit = sent.filter((s) => s.url.endsWith("/v1/task/submit"))[n - 1];
    const picture = /image|banana|seedream|flux/.test(submit.body.model);
    return ok({ status: "completed", outputs: [picture ? `https://cdn.example/${n}.png` : `https://cdn.example/${n}.mp4`] });
  }
  if (u.startsWith("https://cdn.example/")) return u.endsWith(".png") ? new Response(picture, { headers: { "content-type": "image/png" } }) : new Response(CLIP, { headers: { "content-type": "video/mp4" } });
  return script?.(u, init, sent) ?? new Response("?", { status: 404 });
});
async function picture(env, cookie) {
  const r = await call(env, "/api/generate", { method: "POST", cookie, body: { kind: "image", noChat: true, prompt: "a fox in a hat", settings: { model: "nano-banana-2", quality: "1K", count: 1, aspect: "9:16" } } });
  assert.equal(r.status, 200, r.text);
  old(env);
  const done = await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
  assert.equal(done.json.generation.status, "done", done.text);
  return done.json.generation;
}
async function clip(env, cookie, extra = {}) {
  const r = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "a fox in the snow", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5, aspect: "9:16" }, ...extra } });
  assert.equal(r.status, 200, r.text);
  old(env);
  const done = await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
  assert.equal(done.json.generation.status, "done", done.text);
  return done.json.generation;
}

test("the mark sits top left on tall frames and bottom right on the others, sized to the frame; the copy keeps its folder", () => {
  const at = (w, h) => { const p = mod.markPlacement(w, h); return p && [p.width, p.height, p.x, p.y]; };
  assert.deepEqual(at(1080, 1920), [346, 93, 43, 154], "a 9:16 Reel: under the app's header, clear of the buttons");
  assert.deepEqual(at(480, 854), [154, 41, 19, 68], "the free 480p clip");
  assert.deepEqual(at(1280, 720), [282, 76, 947, 593], "16:9: bottom right");
  assert.deepEqual(at(1024, 1024), [225, 61, 758, 922]);
  assert.deepEqual(at(300, 200), [96, 26, 192, 162], "never narrower than 96 px");
  assert.equal(at(50, 50), null, "too small for a mark");
  assert.equal(mod.markedKey("studio/u_a/g_b.mp4"), "studio/u_a/g_b.mark.mp4");
  assert.equal(mod.markedKey("studio/u_a/g_b/0-1.png"), "studio/u_a/g_b/0-1.mark.png");
  assert.equal(mod.markedKey("studio/u_a/g_b/raw"), "studio/u_a/g_b/raw.mark");
  assert.equal(mod.madeByKleo("studio/u_a/g_b/0.png", "u_a"), true);
  assert.equal(mod.madeByKleo("studio/u_a/up/up_x.jpg", "u_a"), false, "the person's own uploads are never marked");
  assert.equal(mod.madeByKleo("studio/u_z/g_b.mp4", "u_a"), false);
});

const python = spawnSync("python3", ["--version"]).status === 0;
test("the Container's server.py puts the mark on the same pixels as the Worker", { skip: !python && "no python3 here" }, () => {
  const sizes = [[1080, 1920], [480, 854], [720, 1280], [1280, 720], [854, 480], [1920, 1080], [1024, 1024], [768, 1024], [3840, 2160], [300, 200], [64, 64], [50, 50], [1023, 1279], [1001, 1251]];
  const py = spawnSync("python3", ["-c", `import json, sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, "watermark"))}); from server import placement, FFMPEG_TIMEOUT_S; print(json.dumps({"at": [placement(w, h) for w, h in ${JSON.stringify(sizes)}], "ffmpeg_s": FFMPEG_TIMEOUT_S}))`], { encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  const want = sizes.map(([w, h]) => { const p = mod.markPlacement(w, h); return p && [p.width, p.height, p.x, p.y]; });
  const got = JSON.parse(py.stdout);
  assert.deepEqual(got.at, want);
  assert.ok(got.ffmpeg_s * 1000 < mod.VIDEO_MARK_TIMEOUT_MS, "the Container stops ffmpeg before Studio stops waiting");
});

test("who shows the mark: an account that never paid; not after a payment, not an admin, not a Creators Pro partner, not when it is off", async () => {
  const env = newEnv();
  const free = await account(env, "free@example.com");
  const payer = await account(env, "payer@example.com");
  const admin = await account(env, "owner@example.com");
  const partner = await account(env, "partner@example.com");
  pay(env, payer.id);
  env.STUDIO_ADMINS = admin.id;
  const soon = new Date(Date.now() + 20 * DAY).toISOString();
  env.DB.db.prepare(`INSERT INTO creators (user_id, status, level, platform, handle, handle_key, profile_url, bio_code, terms_version, terms_at, comp_until)
    VALUES (?, 'active', 'pro', 'tiktok', 'partner', 'partner', 'https://www.tiktok.com/@partner', 'KLEO-AB12', 'v1', ?, ?)`).run(partner.id, new Date().toISOString(), soon);
  assert.equal(await mod.showsMark(env, free.id), true);
  assert.equal(await mod.showsMark(env, payer.id), false, "a pack or a plan");
  assert.equal(await mod.showsMark(env, admin.id), false);
  assert.equal(await mod.showsMark(env, partner.id), false, "a plan from the program, with no Stripe payment");
  env.DB.db.prepare("UPDATE creators SET comp_until = ? WHERE user_id = ?").run(new Date(Date.now() - DAY).toISOString(), partner.id);
  assert.equal(await mod.showsMark(env, partner.id), true, "the program's plan ran out and nothing was paid");
  env.STUDIO_WATERMARK = "off";
  assert.equal(await mod.showsMark(env, free.id), false);
});

test("a free picture is saved clean with a marked copy; the owner and a share link get the mark, the provider the clean file; the first purchase takes it off", async () => {
  const env = newEnv();
  const ana = await account(env, "ana@example.com");
  const p = studio();
  try {
    const g = await picture(env, ana.cookie);
    const out = g.outputs[0];
    const key = [...env.RENDERS.m.keys()].find((k) => k.startsWith(`studio/${ana.id}/${g.id}/`) && !k.includes(".mark."));
    assert.deepEqual(env.RENDERS.m.get(key).bytes, PNG, "the clean picture is kept as it came");
    assert.ok(env.RENDERS.m.has(mod.markedKey(key)), "with its marked copy beside it");
    assert.equal(env.IMAGES.made.length, 1);
    assert.deepEqual(env.IMAGES.made[0], {
      format: "image/png", quality: 92,
      draws: [{ o: { top: 146, left: 41, opacity: 0.9 }, transforms: [{ width: 328 }], head: [0x89, 0x50, 0x4e, 0x47] }],
    }, "a 1024x1820 picture: the PNG mark, 328 px wide, top left");

    const mine = await call(env, out.url, { cookie: ana.cookie });
    assert.equal(mine.status, 200);
    assert.ok(startsMarked(mine.bytes), "the owner sees the mark");
    assert.equal(mine.res.headers.get("cache-control"), "private, max-age=600");
    const download = await call(env, `${out.url}?dl=1`, { cookie: ana.cookie });
    assert.ok(startsMarked(download.bytes), "and downloads it");
    const share = await call(env, `/api/generations/${g.id}/share`, { method: "POST", cookie: ana.cookie, body: { upload: out.upload } });
    const shared = new URL(share.json.url);
    assert.ok(startsMarked((await call(env, shared.pathname + shared.search)).bytes), "a share link carries it");

    // Animated into a clip, the picture reaches the provider clean (the clip gets its own mark at the end).
    const anim = await call(env, "/api/generate", { method: "POST", cookie: ana.cookie, body: { noChat: true, prompt: "the fox winks", imageIds: [out.upload], settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } } });
    assert.equal(anim.status, 200, anim.text);
    const link = new URL(p.sent.filter((s) => s.url.endsWith("/v1/task/submit")).at(-1).body.input.first_frame);
    assert.match(link.pathname, /^\/media\/raw\/up_/);
    assert.deepEqual((await call(env, link.pathname + link.search)).bytes, PNG, "the provider's signed link gets the clean file");
    assert.equal((await call(env, link.pathname)).status, 404, "never without the signature");
    assert.equal((await call(env, link.pathname, { cookie: ana.cookie })).status, 404, "not even for the owner");
    const forged = new URL(share.json.url);
    assert.equal((await call(env, forged.pathname.replace("/media/u/", "/media/raw/") + forged.search)).status, 404, "a share link's signature does not open the clean file");

    // Her own upload is never marked.
    const jpeg = new Uint8Array(2000); jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    const own = await call(env, "/api/uploads", { method: "POST", cookie: ana.cookie, raw: jpeg, headers: { "content-type": "image/jpeg", "x-width": "800", "x-height": "1000" } });
    assert.equal(own.status, 200, own.text);
    assert.deepEqual((await call(env, own.json.url, { cookie: ana.cookie })).bytes, jpeg);
    assert.equal(env.IMAGES.made.length, 1, "nothing drawn on it");

    pay(env, ana.id);
    const after = await call(env, out.url, { cookie: ana.cookie });
    assert.deepEqual(after.bytes, PNG, "after her first purchase the same link sends the clean picture");
    assert.equal(after.res.headers.get("cache-control"), "private, max-age=86400");
  } finally { p.restore(); }
});

test("a paying account's picture is never sent to Images; without the binding a free picture stays clean", async () => {
  const env = newEnv();
  const bo = await account(env, "bo@example.com");
  pay(env, bo.id);
  const p = studio();
  try {
    const g = await picture(env, bo.cookie);
    assert.equal(env.IMAGES.made.length, 0);
    assert.ok(![...env.RENDERS.m.keys()].some((k) => k.includes(".mark.")));
    assert.deepEqual((await call(env, g.outputs[0].url, { cookie: bo.cookie })).bytes, PNG);

    delete env.IMAGES;
    const cy = await account(env, "cy@example.com");
    const free = await picture(env, cy.cookie);
    assert.deepEqual((await call(env, free.outputs[0].url, { cookie: cy.cookie })).bytes, PNG, "fails open: clean, and done");
  } finally { p.restore(); }
});

test("a free clip goes through kleo-watermark: marked copy saved, its CPU seconds in the audit, both files deleted together", async () => {
  const marker = fakeMarker();
  const env = newEnv({ WATERMARK: marker });
  const ana = await account(env, "ana@example.com");
  const p = studio();
  try {
    const g = await clip(env, ana.cookie);
    assert.equal(marker.got.length, 1);
    assert.deepEqual(marker.got[0], { url: "https://kleo-watermark/mark", method: "POST", size: CLIP.length }, "the whole clip, streamed");
    const key = `studio/${ana.id}/${g.id}.mp4`;
    assert.deepEqual(env.RENDERS.m.get(key).bytes, CLIP);
    assert.ok(env.RENDERS.m.has(`studio/${ana.id}/${g.id}.mark.mp4`));
    assert.deepEqual(events(env, "studio.marked"), [{ id: g.id, kind: "video", size: CLIP.length + MARKED.length, cpu_s: 3.2 }]);
    const seen = await call(env, g.video, { cookie: ana.cookie });
    assert.equal(seen.status, 200);
    assert.ok(startsMarked(seen.bytes));
    assert.equal(seen.bytes.length, CLIP.length + MARKED.length);

    const gone = await call(env, `/api/generations/${g.id}`, { method: "DELETE", cookie: ana.cookie });
    assert.equal(gone.status, 200, gone.text);
    assert.ok(![...env.RENDERS.m.keys()].some((k) => k.includes(g.id)), "the clean file and its marked copy");
    assert.deepEqual(events(env, "studio.deleted").map((e) => e.files), [1], "the audit still counts the creation's own files");
  } finally { p.restore(); }
});

test("a clip the marker fails on, or with no marker bound, is done and served clean; a paying account's clip is never sent", async () => {
  const broken = fakeMarker({ fail: true });
  const env = newEnv({ WATERMARK: broken });
  const ana = await account(env, "ana@example.com");
  const p = studio();
  try {
    const g = await clip(env, ana.cookie);
    assert.equal(broken.got.length, 1);
    const [miss] = events(env, "studio.mark_failed");
    assert.equal(miss.id, g.id);
    assert.match(miss.error, /kleo-watermark answered 422: ffmpeg died/);
    assert.deepEqual((await call(env, g.video, { cookie: ana.cookie })).bytes, CLIP, "fails open");

    delete env.WATERMARK;
    const bo = await account(env, "bo@example.com");
    const h = await clip(env, bo.cookie);
    assert.deepEqual((await call(env, h.video, { cookie: bo.cookie })).bytes, CLIP);
    assert.equal(events(env, "studio.mark_failed").length, 1, "not bound yet is not a failure");

    const marker = fakeMarker();
    env.WATERMARK = marker;
    const cy = await account(env, "cy@example.com");
    pay(env, cy.id);
    const paid = await clip(env, cy.cookie);
    assert.equal(marker.got.length, 0);
    assert.deepEqual((await call(env, paid.video, { cookie: cy.cookie })).bytes, CLIP);
  } finally { p.restore(); }
});

test("an animatic comes marked from the GPU box: Studio copies and serves it as it is, never through kleo-watermark", async () => {
  const marker = fakeMarker();
  const env = newEnv({ WATERMARK: marker });
  const ana = await account(env, "ana@example.com");
  env.DB.db.prepare(`INSERT INTO jobs (id, user_id, template, prompt, params, state, credits, worker_secret, percent) VALUES ('j_anim1', ?, 'animatic', 'a fox', '{}', 'done', 5, 'x', 100)`).run(ana.id);
  env.DB.db.prepare("INSERT INTO job_files (job_id, name, key, size, content_type) VALUES ('j_anim1', 'video.mp4', 'jobs/j_anim1/video.mp4', ?, 'video/mp4')").run(CLIP.length);
  await env.RENDERS.put("jobs/j_anim1/video.mp4", CLIP, { httpMetadata: { contentType: "video/mp4" } });
  env.DB.db.prepare(`INSERT INTO studio_generations (id, user_id, model, settings, prompt, credits, status, task_id, kind)
    VALUES ('g_anim1', ?, 'kleo-animatic', '{"product":"animatic","duration":20,"format":"9:16","style":"animation"}', 'a fox', 0, 'running', 'j_anim1', 'film')`).run(ana.id);
  const done = await call(env, "/api/generations/g_anim1", { cookie: ana.cookie });
  assert.equal(done.json.generation.status, "done", done.text);
  assert.equal(marker.got.length, 0, "the mark is burned in on the box (params.mark, worker/kleo_mark.py), never twice");
  assert.ok(![...env.RENDERS.m.keys()].some((k) => k.includes(".mark.")));
  assert.deepEqual((await call(env, done.json.generation.video, { cookie: ana.cookie })).bytes, CLIP, "served as the box made it");
});

test("a free account's rewrite on FLUX 3 runs at 2K, under the Images 20 MB input; a paying account keeps its 4K", async () => {
  for (const paying of [false, true]) {
    const env = newEnv();
    const who = await account(env, paying ? "pro@example.com" : "free@example.com");
    if (paying) { pay(env, who.id); env.DB.db.exec(`UPDATE users SET credits = 100 WHERE id = '${who.id}'`); }
    let n = 0;
    const chat = (text) => ok({ choices: [{ message: { content: text } }] });
    const p = fakeProvider((u, init) => {
      if (u.endsWith("/v1/chat/completions")) {
        const body = JSON.parse(init.body);
        const sys = String(body.messages?.[0]?.content ?? "");
        if (sys.startsWith("You check prompts")) return chat(JSON.stringify({ names: [] }));
        if (sys.startsWith("Rewrite the user's prompt")) return chat("A singer with a long purple braid on a neon stage");
        return chat(String(body.messages?.[1]?.content ?? ""));
      }
      if (u.endsWith("/v1/task/submit")) return ok({ id: `task_r${++n}` });
      if (/task_r[1-3]$/.test(u)) return ok({ status: "failed", error: n === 1 ? "no image generated in response" : 'Content Moderated: {"Moderation Reasons":["Protected Content"]}' });
      if (/task_r4$/.test(u)) return ok({ status: "completed", outputs: ["https://cdn.example/r.png"] });
      if (u === "https://cdn.example/r.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
      return new Response("?", { status: 404 });
    });
    try {
      const r = await call(env, "/api/generate", { method: "POST", cookie: who.cookie, body: { kind: "image", noChat: true, prompt: "Rumi from KPop Demon Hunters on a poster", settings: { model: "nano-banana-2", aspect: "3:4", quality: "4K" } } });
      assert.equal(r.status, 200, r.text);
      for (let i = 0; i < 3; i++) { old(env); await call(env, `/api/generations/${r.json.generation.id}`, { cookie: who.cookie }); }
      const g = (await call(env, `/api/generations/${r.json.generation.id}`, { cookie: who.cookie })).json.generation;
      assert.equal(g.status, "failed", JSON.stringify(g));
      assert.equal(g.rewrite?.name, "FLUX 3");
      const w = await call(env, `/api/generations/${g.id}/describe`, { method: "POST", cookie: who.cookie, body: {} });
      assert.equal(w.status, 200, w.text);
      const last = p.sent.filter((s) => s.url.endsWith("/v1/task/submit")).at(-1);
      assert.equal(last.body.model, "flux-3-image");
      assert.equal(last.body.input.resolution, paying ? "4k" : "2k", paying ? "a paying account keeps what it asked for" : "a free account's picture stays small enough to carry the mark");
    } finally { p.restore(); }
  }
});

test("a free picture with no marked copy gets one when it is next served: made before the mark, made while paying then refunded, or a failed mark", async () => {
  const env = newEnv();
  const p = studio();
  try {
    // Saved with no copy, like a picture made before 29 October 2026.
    const ana = await account(env, "ana@example.com");
    const images = env.IMAGES;
    delete env.IMAGES;
    const g = await picture(env, ana.cookie);
    const key = [...env.RENDERS.m.keys()].find((k) => k.startsWith(`studio/${ana.id}/${g.id}/`));
    assert.ok(!env.RENDERS.m.has(mod.markedKey(key)));
    env.IMAGES = images;
    const seen = await call(env, g.outputs[0].url, { cookie: ana.cookie });
    assert.ok(startsMarked(seen.bytes), "drawn when it is next seen");
    assert.ok(env.RENDERS.m.has(mod.markedKey(key)));
    await call(env, g.outputs[0].url, { cookie: ana.cookie });
    assert.equal(images.made.length, 1, "drawn once");
    assert.deepEqual(events(env, "studio.marked").map((e) => [e.kind, e.late]), [["image", true]]);

    // Made while paying, then the payment was refunded: the account shows the mark again, and so does the picture.
    const bo = await account(env, "bo@example.com");
    pay(env, bo.id);
    const h = await picture(env, bo.cookie);
    assert.deepEqual((await call(env, h.outputs[0].url, { cookie: bo.cookie })).bytes, PNG);
    env.DB.db.exec(`UPDATE payments SET status = 'refunded' WHERE user_id = '${bo.id}'`);
    assert.ok(startsMarked((await call(env, h.outputs[0].url, { cookie: bo.cookie })).bytes));

    // A mark Images refuses (its monthly limit, say) is tried again an hour later, not on every view; clean meanwhile.
    // The owner gets one e-mail about it, not one per picture.
    env.mails = [];
    env.OWNER_MAIL = { send: async (msg) => { env.mails.push(msg); } };
    const cy = await account(env, "cy@example.com");
    images.fail = "ERROR 9422: transformation limit reached";
    const k = await picture(env, cy.cookie);
    const tries = images.tries;
    assert.deepEqual((await call(env, k.outputs[0].url, { cookie: cy.cookie })).bytes, PNG);
    assert.deepEqual((await call(env, k.outputs[0].url, { cookie: cy.cookie })).bytes, PNG);
    assert.equal(images.tries, tries + 1, "one late try, then the miss is remembered");
    assert.ok(events(env, "studio.mark_failed").some((e) => e.late === true && /9422/.test(e.error)));
    assert.equal(env.mails.length, 1, "one alert for the save and the view that both failed");
    assert.match(env.mails[0].raw, /without the Kleo mark/);
    assert.match(env.mails[0].raw, /9422/);
  } finally { p.restore(); }
});

test("a picture over the Images binding's 20 MB input stays clean, says why in the audit, and is never sent to Images", async () => {
  const env = newEnv({ mails: [] });
  env.OWNER_MAIL = { send: async (msg) => { env.mails.push(msg); } };
  const big = new Uint8Array(mod.IMAGES_MAX_INPUT + 1024).fill(5);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const p = studio(undefined, big);
  try {
    const ana = await account(env, "ana@example.com");
    const g = await picture(env, ana.cookie);
    const [miss] = events(env, "studio.mark_failed");
    assert.match(miss.error, /over the Images binding's 20 MB input/);
    const seen = await call(env, g.outputs[0].url, { cookie: ana.cookie });
    assert.equal(seen.bytes.length, big.length, "served clean");
    assert.equal(env.IMAGES.tries, 0);
    assert.equal(env.mails.length, 0, "an expected miss is no alert");
  } finally { p.restore(); }
});
