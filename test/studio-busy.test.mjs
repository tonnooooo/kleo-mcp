/**
 * A picture the provider drops for its own reasons (29 October 2026: a new account's first two Nano Banana 2 pictures
 * failed on ePhone in one and two seconds, "Rate limit exceeded, please retry later" and "Internal server error, Please
 * contact the administrator", and the person left). The pure rules (which failures are "busy", where the picture goes
 * instead), then the kleo-studio Worker bundled with esbuild on a D1 look-alike (node:sqlite, every migration applied):
 * the unseen retry on APIMart, then on ePhone, the busy offer when both fail, taking it once, declining it, and a
 * refusal keeping its FLUX 3 road. An order ePhone took and then refused as malformed (a quality spelling, an
 * output_format) is sent again changed, or to the backup, never as it was. Then the same net for video clips (29 October
 * 2026): the retry on APIMart, ePhone or WaveSpeed, never after a timeout the provider has not ended, the "was busy"
 * card with Wan 3.0 or Veo 3.1 Fast for no more than the clip cost, and the copyright and money roads left as they were.
 * Run: node --test test/studio-busy.test.mjs
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
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { busySwitchFor, closestAspect, isProviderBusy, isRequestRefusal, repairedInput, alternativeFor, imageAlternatives } from "../src/studio/image-models.ts";
import { busySwitchClip, clipCostUsd, wanCredits } from "../src/studio/models.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("busy: the provider's own failures, never a refusal of the picture nor an empty balance", () => {
  for (const m of [
    "Rate limit exceeded, please retry later",
    "Internal server error, Please contact the administrator",
    "当前分组上游负载已饱和，请稍后再试",
    "ephone.ai POST /v1/task/submit → 429: too many requests",
    "The model is overloaded. Please try again later.",
    "Resource has been exhausted (e.g. check quota).",
    "upstream returned 503 Service Unavailable",
  ]) assert.equal(isProviderBusy(m), true, m);
  for (const m of [
    "no image generated in response",
    "The output image may contain sensitive information",
    "Content Moderated: Protected Content",
    "quota is not enough",
    "预扣费额度失败, 用户剩余额度: $0.000000",
    "insufficient_user_quota",
    "Insufficient balance",
    "Height must be between 300px and 6000px",
    "invalid quality: high",
  ]) assert.equal(isProviderBusy(m), false, m);
  // A refusal keeps its own road (FLUX 3); a busy failure earns none of those second tries.
  const alts = imageAlternatives({ model: "nano-banana-2", aspect: "4:5", quality: "2K", count: 1 }, "a fox", []);
  assert.equal(alternativeFor(alts, "Rate limit exceeded, please retry later"), null);
  assert.ok(alternativeFor(alts, "no image generated in response"));
});

test("busy: the picture goes to a working free model, in the nearest shape it has", () => {
  assert.deepEqual(busySwitchFor({ model: "nano-banana-2", aspect: "4:5", quality: "2K", count: 1 }), { model: "seedream-5", aspect: "3:4", quality: "2K", count: 1 });
  assert.deepEqual(busySwitchFor({ model: "nano-banana-pro", aspect: "16:9", quality: "4K", count: 2 }), { model: "seedream-5", aspect: "16:9", quality: "2K", count: 2 });
  assert.deepEqual(busySwitchFor({ model: "seedream-5", aspect: "9:16", quality: "2K", count: 4 }), { model: "flux-2-pro", aspect: "9:16", quality: "1K", count: 4 });
  assert.deepEqual(busySwitchFor({ model: "nano-banana-2", aspect: "1:1", quality: "1K", count: 1 }, ["seedream-5"]), { model: "flux-2-pro", aspect: "1:1", quality: "1K", count: 1 });
  assert.equal(busySwitchFor({ model: "seedream-5", aspect: "1:1", quality: "2K", count: 1 }, ["flux-2-pro"]), null);
  assert.equal(closestAspect(["1:1", "4:3", "3:4", "16:9", "9:16"], "4:5"), "3:4");
  assert.equal(closestAspect(["1:1", "4:3", "3:4", "16:9", "9:16"], "21:9"), "16:9");
  assert.equal(closestAspect(["1:1", "4:5"], "4:5"), "4:5");
});

// ── the Worker ─────────────────────────────────────────────────────────────────────────────────────────────────────
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
class FakeImages {
  async info(stream) { await new Response(stream).arrayBuffer(); return { format: "image/png", fileSize: 1, width: 1024, height: 1280 }; }
  input(stream) {
    const t = { transform: () => t, draw: () => t, output: async (o) => { const bytes = new Uint8Array(await new Response(stream).arrayBuffer()); return { contentType: () => o.format, response: () => new Response(bytes, { headers: { "content-type": o.format } }) }; } };
    return t;
  }
}
globalThis.FixedLengthStream ??= class extends TransformStream { constructor() { super(); } };

let worker;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email"],
  });
  worker = (await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"))).default;
});

function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: new FakeR2(), IMAGES: new FakeImages(),
    ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", EPHONE_API_KEY: "ek", APIMART_API_KEY: "ak", FREE_CREDITS: "5",
    STUDIO_FREE_MODELS: "seedance-2.0-fast", STUDIO_DAILY_BUDGET_USD: "30", MAX_NEW_USERS_PER_IP_DAY: "50", MAX_ACCOUNTS_PER_ADDRESS: "50",
    STUDIO_WATERMARK: "off",
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
async function call(env, path, { method = "GET", body, cookie } = {}) {
  const h = { "x-kleo": "1" };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await worker.fetch(new Request(`https://app.kleo.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await Promise.allSettled(pending.splice(0));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, res };
}
async function account(env, email) {
  const r = await call(env, "/api/auth/signup", { method: "POST", body: { email, password: "long enough pw" } });
  assert.equal(r.status, 200, r.text);
  return (r.res.headers.get("set-cookie") ?? "").split(";")[0];
}
const old = (env) => env.DB.db.exec("UPDATE studio_generations SET checked_at = '2000-01-01T00:00:00.000Z'");
const events = (env, event) => env.DB.db.prepare("SELECT job_id, detail FROM audit WHERE event = ?").all(event).map((r) => ({ id: r.job_id, ...JSON.parse(r.detail ?? "{}") }));
const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const PNG = (() => { const b = new Uint8Array(4000).fill(5); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; })();

/**
 * A fake ePhone, APIMart and WaveSpeed: `ephone(n)` answers the n-th ePhone task (1-based) with a status object,
 * `apimart(n)` the n-th APIMart task and `wavespeed(n)` the n-th WaveSpeed prediction (null = that provider refuses
 * the order), and `submit(n)` may answer the n-th ePhone order itself (a Response; null = ePhone takes it).
 */
function providers({ ephone, apimart = () => null, wavespeed = () => null, submit = () => null }) {
  const sent = [];
  const real = globalThis.fetch;
  const refuse = () => new Response(JSON.stringify({ error: { code: 503, message: "busy" } }), { status: 503 });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = String(init.body); }
    sent.push({ url: u, method: init.method ?? "GET", body });
    if (u.startsWith("https://cloudflare-dns.com/dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }), { headers: { "content-type": "application/dns-json" } });
    if (u.endsWith("/v1/task/submit")) {
      const n = sent.filter((s) => s.url.endsWith("/v1/task/submit")).length;
      return submit(n) ?? ok({ id: `task_${n}` });
    }
    const et = /\/v1\/task\/task_(\d+)$/.exec(u);
    if (et) return ok(ephone(Number(et[1])));
    if (u === "https://api.apimart.ai/v1/images/generations" || u === "https://api.apimart.ai/v1/videos/generations") {
      const n = sent.filter((s) => /^https:\/\/api\.apimart\.ai\/v1\/(images|videos)\/generations$/.test(s.url)).length;
      return apimart(n) ? ok({ code: 200, data: [{ status: "submitted", task_id: `am_${n}` }] }) : refuse();
    }
    const at = /\/v1\/tasks\/am_(\d+)$/.exec(u);
    if (at) return ok({ code: 200, data: apimart(Number(at[1])) });
    if (u.startsWith("https://api.wavespeed.ai/api/v3/alibaba/")) {
      const n = sent.filter((s) => s.url.startsWith("https://api.wavespeed.ai/api/v3/alibaba/")).length;
      return wavespeed(n) ? ok({ code: 200, data: { id: `ws_${n}`, status: "created" } }) : refuse();
    }
    const wt = /^https:\/\/api\.wavespeed\.ai\/api\/v3\/predictions\/ws_(\d+)\/result$/.exec(u);
    if (wt) return ok({ code: 200, data: { id: `ws_${wt[1]}`, ...wavespeed(Number(wt[1])) } });
    if (u.startsWith("https://cdn.example/") && u.endsWith(".mp4")) return new Response(new Uint8Array(5000).fill(7), { headers: { "content-type": "video/mp4" } });
    if (u.startsWith("https://cdn.example/")) return new Response(PNG, { headers: { "content-type": "image/png" } });
    return new Response("?", { status: 404 });
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}
const failed = (error) => ({ status: "failed", error });
const done = (name) => ({ status: "completed", outputs: [`https://cdn.example/${name}.png`] });
const submits = (p, pred) => p.sent.filter((s) => s.method === "POST" && pred(s.url));

async function order(env, cookie, settings = { model: "nano-banana-2", quality: "2K", count: 1, aspect: "4:5" }) {
  const r = await call(env, "/api/generate", { method: "POST", cookie, body: { kind: "image", noChat: true, prompt: "Two young adults share a gentle kiss on a hilltop at golden hour", settings } });
  assert.equal(r.status, 200, r.text);
  return r.json.generation.id;
}
/** Polls the creation as the page does (each pass due at once) until it stops running. */
async function settle(env, cookie, id) {
  let g;
  for (let i = 0; i < 6; i++) {
    old(env);
    g = (await call(env, `/api/generations/${id}`, { cookie })).json.generation;
    if (g.status !== "running") break;
  }
  return g;
}
const creditsOf = async (env, cookie) => (await call(env, "/api/me", { cookie })).json.credits;

test("busy: ePhone drops the picture, APIMart makes it unseen, for the credits charged once", async () => {
  const env = newEnv();
  const cookie = await account(env, "ana@example.com");
  const p = providers({ ephone: () => failed("Rate limit exceeded, please retry later"), apimart: () => ({ status: "completed", result: { images: [{ url: ["https://cdn.example/am.png"] }] } }) });
  try {
    const before = await creditsOf(env, cookie);
    const id = await order(env, cookie);
    const g = await settle(env, cookie, id);
    assert.equal(g.status, "done", JSON.stringify(g));
    assert.equal(g.outputs.length, 1);
    assert.equal(submits(p, (u) => u.endsWith("/v1/task/submit")).length, 1, "ePhone was asked once");
    const am = submits(p, (u) => u.endsWith("/v1/images/generations"));
    assert.equal(am.length, 1);
    assert.equal(am[0].body.model, "gemini-3.1-flash-image-preview", "the same model on the backup");
    assert.equal(am[0].body.size, "4:5");
    assert.match(am[0].body.prompt, /golden hour/);
    const retry = events(env, "studio.busy_retry");
    assert.equal(retry.length, 1);
    assert.equal(retry[0].to, "apimart");
    assert.equal(await creditsOf(env, cookie), before - g.credits, "charged once, nothing refunded");
  } finally { p.restore(); }
});

test("busy: with no backup the picture goes to ePhone once more, and only once", async () => {
  const env = newEnv({ APIMART_API_KEY: "" });
  const cookie = await account(env, "bo@example.com");
  const p = providers({ ephone: (n) => (n === 1 ? failed("Internal server error, Please contact the administrator") : done("second")) });
  try {
    const g = await settle(env, cookie, await order(env, cookie));
    assert.equal(g.status, "done", JSON.stringify(g));
    const sent = submits(p, (u) => u.endsWith("/v1/task/submit"));
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].body, sent[0].body, "the same order again");
    assert.equal(events(env, "studio.busy_retry")[0].to, "ephone");
  } finally { p.restore(); }
});

test("busy: when the retry fails too, the credits come back and the picture offers a working model, taken once", async () => {
  const env = newEnv({ APIMART_API_KEY: "" });
  const cookie = await account(env, "cy@example.com");
  const p = providers({ ephone: (n) => (n <= 2 ? failed(n === 1 ? "Rate limit exceeded, please retry later" : "Internal server error, Please contact the administrator") : done("seedream")) });
  try {
    const before = await creditsOf(env, cookie);
    const id = await order(env, cookie);
    const g = await settle(env, cookie, id);
    assert.equal(g.status, "failed");
    assert.equal(g.refunded, true);
    assert.equal(g.error, "Nano Banana 2 was busy and couldn't make this one. Your credits are back.");
    assert.deepEqual(g.busy, { model: "seedream-5", name: "Seedream 5.0", from: "Nano Banana 2", credits: g.credits });
    assert.equal(submits(p, (u) => u.endsWith("/v1/task/submit")).length, 2, "one unseen retry, no more");
    assert.equal(await creditsOf(env, cookie), before);

    const r = await call(env, `/api/generations/${id}/switch`, { method: "POST", cookie, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.generation.model, "seedream-5");
    assert.equal(r.json.generation.settings.aspect, "3:4", "Seedream has no 4:5: the nearest shape");
    assert.equal(r.json.generation.credits, g.credits, "the credits the busy one cost");
    assert.equal(r.json.original.busy, null, "the offer is gone");
    assert.equal(submits(p, (u) => u.endsWith("/v1/task/submit")).at(-1).body.model, "doubao-seedream-5-0-260128");
    assert.equal(r.json.credits, before - g.credits);
    const again = await call(env, `/api/generations/${id}/switch`, { method: "POST", cookie, body: {} });
    assert.equal(again.status, 409, "taken once");
    const made = await settle(env, cookie, r.json.generation.id);
    assert.equal(made.status, "done");
    assert.equal(made.busy, null);
  } finally { p.restore(); }
});

test("busy: 'No thanks' drops the offer for good; a refused picture never gets it", async () => {
  const env = newEnv({ APIMART_API_KEY: "" });
  const cookie = await account(env, "di@example.com");
  const p = providers({ ephone: (n) => (n <= 2 ? failed("Rate limit exceeded, please retry later") : failed("no image generated in response")) });
  try {
    const id = await order(env, cookie);
    assert.ok((await settle(env, cookie, id)).busy);
    const no = await call(env, `/api/generations/${id}/switch`, { method: "POST", cookie, body: { decline: true } });
    assert.equal(no.status, 200, no.text);
    assert.equal(no.json.original.busy, null);
    assert.equal((await call(env, `/api/generations/${id}/switch`, { method: "POST", cookie, body: {} })).status, 409);

    // A refusal: FLUX 3 gets its second try (and refuses too here), never the busy retry nor the busy offer.
    const refused = await order(env, cookie, { model: "nano-banana-2", quality: "1K", count: 1, aspect: "1:1" });
    const g = await settle(env, cookie, refused);
    assert.equal(g.status, "failed");
    assert.equal(g.busy, null);
    assert.equal(events(env, "studio.busy_retry").filter((e) => e.id === refused).length, 0);
    assert.equal(events(env, "studio.fallback").filter((e) => e.id === refused).length, 1, "FLUX 3's second try");
  } finally { p.restore(); }
});

// ── Orders ePhone took and then refused as malformed (29 October 2026, two approved probes) ─────────────────────────
const QUALITY_REFUSAL = '[ { "code": "invalid_value", "values": [ "auto", "low", "medium", "high", "xhigh", "max" ], "path": [ "quality" ], "message": "Invalid option: expected one of \\"auto\\"|\\"low\\"|\\"medium\\"|\\"high\\"|\\"xhigh\\"|\\"max\\"" } ]';
const MIME_REFUSAL = "Invalid JSON payload received. Unknown name \"mimeType\" at 'generation_config.image_config': Cannot find field.";

test("refused orders: ePhone's two late refusals, and what changes in the order", () => {
  for (const m of [QUALITY_REFUSAL, MIME_REFUSAL]) {
    assert.equal(isRequestRefusal(m), true, m);
    assert.equal(isProviderBusy(m), false, m);
  }
  for (const m of ["no image generated in response", "Content Moderated: Protected Content", "Insufficient balance", "预扣费额度失败, 用户剩余额度: $0.000000", "Rate limit exceeded, please retry later"]) {
    assert.equal(isRequestRefusal(m), false, m);
  }
  const nb2 = { prompt: "a cup", aspect_ratio: "1:1", quality: "medium" };
  assert.deepEqual(repairedInput(nb2, QUALITY_REFUSAL), { ...nb2, quality: "1K" }, "the other spelling");
  assert.deepEqual(repairedInput({ ...nb2, quality: "1K" }, QUALITY_REFUSAL), nb2, "and back");
  assert.deepEqual(repairedInput({ ...nb2, output_format: "jpeg" }, MIME_REFUSAL), nb2, "no output_format");
  assert.equal(repairedInput(nb2, MIME_REFUSAL), null, "nothing to change: never the same order again");
  assert.equal(repairedInput({ prompt: "x", size: "2K" }, QUALITY_REFUSAL), null);
});

test("refused orders: a quality ePhone refuses after taking the order goes again in the other spelling, unseen", async () => {
  const env = newEnv({ APIMART_API_KEY: "" });
  const cookie = await account(env, "ed@example.com");
  const p = providers({ ephone: (n) => (n === 1 ? failed(QUALITY_REFUSAL) : done("second")) });
  try {
    const before = await creditsOf(env, cookie);
    const g = await settle(env, cookie, await order(env, cookie));
    assert.equal(g.status, "done", JSON.stringify(g));
    const sent = submits(p, (u) => u.endsWith("/v1/task/submit"));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].body.input.quality, "high");
    assert.deepEqual(sent[1].body.input, { ...sent[0].body.input, quality: "2K" }, "only the quality changes");
    const retry = events(env, "studio.busy_retry");
    assert.equal(retry.length, 1);
    assert.equal(retry[0].cause, "request");
    assert.equal(await creditsOf(env, cookie), before - g.credits, "charged once");
  } finally { p.restore(); }
});

test("refused orders: an order ePhone cannot read goes to the backup; with none, never the same order again", async () => {
  const env = newEnv();
  const cookie = await account(env, "fa@example.com");
  const p = providers({ ephone: () => failed(MIME_REFUSAL), apimart: () => ({ status: "completed", result: { images: [{ url: ["https://cdn.example/am.png"] }] } }) });
  try {
    const g = await settle(env, cookie, await order(env, cookie));
    assert.equal(g.status, "done", JSON.stringify(g));
    assert.equal(submits(p, (u) => u.endsWith("/v1/task/submit")).length, 1);
    assert.equal(events(env, "studio.busy_retry")[0].to, "apimart");
  } finally { p.restore(); }

  // No backup and nothing in the order to change: the credits come back, in plain words, with Seedream 5.0 offered.
  const bare = newEnv({ APIMART_API_KEY: "" });
  const c2 = await account(bare, "gi@example.com");
  const q = providers({ ephone: () => failed(MIME_REFUSAL) });
  try {
    const g = await settle(bare, c2, await order(bare, c2));
    assert.equal(g.status, "failed");
    assert.equal(g.refunded, true);
    assert.equal(submits(q, (u) => u.endsWith("/v1/task/submit")).length, 1, "the refused order is never sent again as it was");
    assert.equal(g.error, "Nano Banana 2 was busy and couldn't make this one. Your credits are back.", "never the provider's words");
    assert.equal(g.busy?.model, "seedream-5");
  } finally { q.restore(); }
});

// ── Video clips (29 October 2026) ──────────────────────────────────────────────────────────────────────────────────
test("busy clips: a Seedance clip goes to Wan 3.0 for less, a Veo 3.1 clip to Veo 3.1 Fast; nothing else moves", () => {
  const s = { model: "seedance-2.5", duration: 10, resolution: "1080p", aspect: "16:9", audio: true, imageRole: "none", videoRole: "none" };
  assert.deepEqual(busySwitchClip(s, clipCostUsd(s)), { model: "wan-3.0", settings: s });
  const fast = { ...s, model: "seedance-2.0-fast", resolution: "480p", duration: 5 };
  assert.equal(busySwitchClip(fast, clipCostUsd(fast))?.model, "wan-3.0", "Wan 3.0 costs no more than Seedance 2.0 Fast at 480p");
  assert.equal(busySwitchClip({ ...s, clips: 1, videoRole: "reference" }, 10), null, "Wan 3.0 takes no video or sound clips");
  assert.equal(busySwitchClip(s, 0.5), null, "never dearer than what the busy clip was priced at");
  const veo = { model: "veo-3.1", duration: 8, resolution: "1080p", aspect: "9:16", audio: true, imageRole: "first_frame" };
  assert.deepEqual(busySwitchClip(veo, clipCostUsd(veo)), { model: "veo-3.1-fast", settings: { ...veo, model: "veo-3.1-fast" } });
  assert.equal(busySwitchClip({ ...veo, model: "veo-3.1-fast" }, 10), null);
  assert.equal(busySwitchClip({ ...fast, model: "kling-3-omni", videoRole: "motion" }, 10), null);
  assert.equal(busySwitchClip({ ...s, model: "wan-3.0" }, 10), null);
  // Wan 3.0's credits are worked out as every clip's: WaveSpeed's price times the margin, then the video factor.
  assert.equal(wanCredits(fast, 1.6, 5 / 3), 2);
  assert.equal(wanCredits({ ...s, duration: 15 }, 1.6, 5 / 3), 19);
});

const PROMPT = "A red fox runs through the fresh snow at dawn, the camera close behind";
const vdone = (name) => ({ status: "completed", outputs: [`https://cdn.example/${name}.mp4`] });
async function clip(env, cookie, settings = { model: "seedance-2.0-fast", resolution: "480p", duration: 5, aspect: "9:16" }) {
  const r = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: PROMPT, settings } });
  assert.equal(r.status, 200, r.text);
  return r.json.generation;
}
async function paidAccount(env, email, credits = 100) {
  const cookie = await account(env, email);
  const me = (await call(env, "/api/me", { cookie })).json;
  env.DB.db.exec(`INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('manual_${me.id}', '${me.id}', 0, 0, 'eur', 'paid', 'tester'); UPDATE users SET credits = ${credits} WHERE id = '${me.id}'`);
  return cookie;
}
const ePhoneOrders = (p) => submits(p, (u) => u.endsWith("/v1/task/submit"));
const wanOrders = (p) => submits(p, (u) => u.startsWith("https://api.wavespeed.ai/api/v3/alibaba/"));

test("busy clips: ePhone drops the clip, APIMart makes it unseen, for the credits charged once", async () => {
  const env = newEnv();
  const cookie = await account(env, "eve@example.com");
  const p = providers({ ephone: () => failed("Rate limit exceeded, please retry later"), apimart: () => ({ status: "completed", result: { videos: [{ url: ["https://cdn.example/am.mp4"] }] } }) });
  try {
    const before = await creditsOf(env, cookie);
    const c = await clip(env, cookie);
    assert.equal(c.status, "running", JSON.stringify(c));
    const g = await settle(env, cookie, c.id);
    assert.equal(g.status, "done", JSON.stringify(g));
    assert.equal(g.video, `/media/${c.id}.mp4`);
    assert.equal(ePhoneOrders(p).length, 1, "ePhone was asked once");
    const am = submits(p, (u) => u === "https://api.apimart.ai/v1/videos/generations");
    assert.equal(am.length, 1);
    assert.deepEqual(am[0].body, { model: "seedance-2.0-fast", prompt: PROMPT, duration: 5, resolution: "480p", size: "9:16", generate_audio: true }, "the same clip on the backup");
    assert.deepEqual(events(env, "studio.busy_retry").map((e) => [e.id, e.from, e.to]), [[c.id, "ephone", "apimart"]]);
    assert.equal(await creditsOf(env, cookie), before - c.credits, "charged once, nothing refunded");
  } finally { p.restore(); }
});

test("busy clips: with no backup the clip goes to ePhone once more with the same order, and only once", async () => {
  const env = newEnv();
  const cookie = await paidAccount(env, "fay@example.com");
  const p = providers({ ephone: (n) => (n === 1 ? failed("当前分组上游负载已饱和，请稍后再试") : vdone("second")) });
  try {
    const c = await clip(env, cookie, { model: "seedance-2.5", resolution: "720p", duration: 5, aspect: "16:9" });
    const g = await settle(env, cookie, c.id);
    assert.equal(g.status, "done", JSON.stringify(g));
    const sent = ePhoneOrders(p);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].body, sent[0].body, "the same order again");
    assert.equal(events(env, "studio.busy_retry")[0].to, "ephone");
    assert.ok(!p.sent.some((s) => s.url.includes("apimart")), "Seedance 2.5 has no backup at its price");
  } finally { p.restore(); }
});

test("busy clips: when the retry fails too, the credits come back and the clip offers Wan 3.0 for less, taken once", async () => {
  const env = newEnv({ APIMART_API_KEY: "", WAVESPEED_API_KEY: "wk", STUDIO_VIDEO_FACTOR: "5/3" });
  const cookie = await account(env, "gus@example.com");
  const p = providers({
    ephone: (n) => failed(n === 1 ? "Rate limit exceeded, please retry later" : "Internal server error, Please contact the administrator"),
    wavespeed: (n) => (n === 1 ? failed("Too many requests, please retry later") : vdone("wan")),
  });
  try {
    const before = await creditsOf(env, cookie);
    const c = await clip(env, cookie);
    assert.equal(c.credits, 4, "Seedance 2.0 Fast at 480p is 4 credits with the video factor");
    const g = await settle(env, cookie, c.id);
    assert.equal(g.status, "failed");
    assert.equal(g.refunded, true);
    assert.equal(g.error, "Seedance 2.0 Fast was busy and couldn't make this one. Your credits are back.");
    assert.deepEqual(g.busy, { model: "wan-3.0", name: "Wan 3.0", from: "Seedance 2.0 Fast", credits: 2 });
    assert.equal(ePhoneOrders(p).length, 2, "one unseen retry, no more");
    assert.equal(await creditsOf(env, cookie), before);

    const r = await call(env, `/api/generations/${c.id}/switch`, { method: "POST", cookie, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ m: r.json.generation.model, n: r.json.generation.modelName, s: r.json.generation.status, c: r.json.generation.credits }, { m: "wan-3.0", n: "Wan 3.0", s: "running", c: 2 });
    assert.equal(r.json.original.busy, null, "the offer is gone");
    assert.equal(r.json.credits, before - 2, "Wan 3.0's own price, less than the busy clip cost");
    assert.equal(wanOrders(p).length, 1);
    assert.equal(wanOrders(p)[0].url, "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/text-to-video");
    assert.deepEqual(wanOrders(p)[0].body, { prompt: PROMPT, duration: 5, resolution: "480p", generate_audio: true, aspect_ratio: "9:16" });
    assert.equal((await call(env, `/api/generations/${c.id}/switch`, { method: "POST", cookie, body: {} })).status, 409, "taken once");
    assert.ok(events(env, "studio.busy_switch").some((e) => e.id === c.id && e.model === "wan-3.0"));

    // WaveSpeed drops the Wan clip once: it is sent there again, unseen, and made.
    const made = await settle(env, cookie, r.json.generation.id);
    assert.equal(made.status, "done", JSON.stringify(made));
    assert.equal(made.busy, null);
    assert.equal(wanOrders(p).length, 2);
    assert.deepEqual(wanOrders(p)[1].body, wanOrders(p)[0].body);
    assert.ok(events(env, "studio.busy_retry").some((e) => e.id === r.json.generation.id && e.from === "wavespeed" && e.to === "wavespeed"));
    assert.equal(await creditsOf(env, cookie), before - 2);
  } finally { p.restore(); }
});

test("busy clips: 'No thanks' drops the offer for good; a refusal and a copyright refusal keep their own roads", async () => {
  const env = newEnv({ APIMART_API_KEY: "", WAVESPEED_API_KEY: "wk" });
  const cookie = await account(env, "hal@example.com");
  let said = "Rate limit exceeded, please retry later";
  const p = providers({ ephone: () => failed(said) });
  try {
    const c = await clip(env, cookie);
    assert.ok((await settle(env, cookie, c.id)).busy);
    const no = await call(env, `/api/generations/${c.id}/switch`, { method: "POST", cookie, body: { decline: true } });
    assert.equal(no.status, 200, no.text);
    assert.equal(no.json.original.busy, null);
    assert.equal((await call(env, `/api/generations/${c.id}/switch`, { method: "POST", cookie, body: {} })).status, 409);

    said = "Content policy violation detected";
    const refused = await settle(env, cookie, (await clip(env, cookie)).id);
    assert.equal(refused.status, "failed");
    assert.equal(refused.busy, null);
    assert.equal(refused.error, "The video model could not make this one: Content policy violation detected. Your credits are back.");

    said = "The request failed because the output video may be related to copyright restrictions.";
    const cr = await settle(env, cookie, (await clip(env, cookie)).id);
    assert.equal(cr.busy, null);
    assert.equal(cr.offer?.name, "Wan 3.0", "a copyright refusal keeps its own offer");
    assert.equal(events(env, "studio.busy_retry").length, 1, "only the busy clip was sent again");
  } finally { p.restore(); }
});

test("busy clips: past its time a clip the provider still holds is never ordered twice; one it says failed is; one it finished is saved", async () => {
  const env = newEnv({ APIMART_API_KEY: "", WAVESPEED_API_KEY: "wk" });
  const cookie = await account(env, "ida@example.com");
  const state = {};
  const p = providers({ ephone: (n) => state[n] ?? { status: "in_progress" } });
  const late = (id) => env.DB.db.prepare("UPDATE studio_generations SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 50 * 60_000).toISOString(), id);
  const poll = async (id) => { old(env); return (await call(env, `/api/generations/${id}`, { cookie })).json.generation; };
  try {
    const a = await clip(env, cookie);
    late(a.id);
    const ga = await poll(a.id);
    assert.equal(ga.status, "failed");
    assert.equal(ga.refunded, true);
    assert.equal(ga.error, "Seedance 2.0 Fast was busy and couldn't make this one. Your credits are back.");
    assert.equal(ga.busy?.model, "wan-3.0");
    assert.equal(ePhoneOrders(p).length, 1, "never ordered again while it may still finish");

    const b = await clip(env, cookie);
    state[2] = failed("Rate limit exceeded, please retry later");
    late(b.id);
    assert.equal((await poll(b.id)).status, "running", "the provider said it is over: sent once more");
    assert.equal(ePhoneOrders(p).length, 3);
    state[3] = vdone("again");
    assert.equal((await poll(b.id)).status, "done", "the new task has its own time");

    const c = await clip(env, cookie);
    state[4] = vdone("just");
    late(c.id);
    assert.equal((await poll(c.id)).status, "done", "finished just past its time: saved, not refunded");
  } finally { p.restore(); }
});

test("busy clips: an order refused at the door for the provider's own reasons is busy at once, with no unseen retry; no money stays the money road", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "wk" });
  const cookie = await paidAccount(env, "jo@example.com");
  let door = () => new Response(JSON.stringify({ error: { message: "upstream returned 503 Service Unavailable" } }), { status: 503 });
  const p = providers({ ephone: () => ({ status: "in_progress" }), submit: () => door() });
  try {
    const c = await clip(env, cookie, { model: "seedance-2.5", resolution: "1080p", duration: 10, aspect: "16:9" });
    assert.equal(c.status, "failed", JSON.stringify(c));
    assert.equal(c.error, "Seedance 2.5 was busy and couldn't make this one. Your credits are back.");
    assert.deepEqual(c.busy, { model: "wan-3.0", name: "Wan 3.0", from: "Seedance 2.5", credits: 7 });
    assert.ok(c.busy.credits < c.credits, "Wan 3.0 at 1080p costs less than Seedance 2.5");
    assert.equal(ePhoneOrders(p).length, 1, "no unseen retry at the door");

    door = () => new Response(JSON.stringify({ error: { code: "insufficient_user_quota", message: "预扣费额度失败, 用户剩余额度: $0.000000" } }), { status: 403 });
    const m = await clip(env, cookie, { model: "seedance-2.5", resolution: "720p", duration: 5, aspect: "16:9" });
    assert.equal(m.status, "failed");
    assert.match(m.error, /recharged/);
    assert.equal(m.busy, null);
  } finally { p.restore(); }
});

test("busy clips: a Veo 3.1 clip offers Veo 3.1 Fast at its own price, made on the road every clip takes", async () => {
  const env = newEnv({ APIMART_API_KEY: "" });
  const cookie = await paidAccount(env, "kai@example.com");
  const p = providers({ ephone: (n) => (n <= 2 ? failed("Resource has been exhausted (e.g. check quota).") : vdone("fast")) });
  try {
    const c = await clip(env, cookie, { model: "veo-3.1", resolution: "1080p", duration: 8, aspect: "9:16" });
    assert.equal(c.credits, 7);
    const g = await settle(env, cookie, c.id);
    assert.equal(g.status, "failed");
    assert.equal(g.error, "Google Veo 3.1 was busy and couldn't make this one. Your credits are back.");
    assert.deepEqual(g.busy, { model: "veo-3.1-fast", name: "Veo 3.1 Fast", from: "Google Veo 3.1", credits: 3 });
    const first = ePhoneOrders(p);
    assert.equal(first.length, 2);
    assert.deepEqual(first[1].body, first[0].body);

    const r = await call(env, `/api/generations/${c.id}/switch`, { method: "POST", cookie, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ m: r.json.generation.model, c: r.json.generation.credits, from: r.json.generation.settings.from }, { m: "veo-3.1-fast", c: 3, from: c.id });
    assert.equal(r.json.credits, 100 - 3);
    const order = ePhoneOrders(p).at(-1).body;
    assert.equal(order.model, "veo-3.1-fast-generate-preview");
    assert.deepEqual(order.input, first[0].body.input, "the same clip");
    const made = await settle(env, cookie, r.json.generation.id);
    assert.equal(made.status, "done", JSON.stringify(made));
    assert.equal(made.busy, null);
  } finally { p.restore(); }
});
