/**
 * A picture the provider drops for its own reasons (29 October 2026: a new account's first two Nano Banana 2 pictures
 * failed on ePhone in one and two seconds, "Rate limit exceeded, please retry later" and "Internal server error, Please
 * contact the administrator", and the person left). The pure rules (which failures are "busy", where the picture goes
 * instead), then the kleo-studio Worker bundled with esbuild on a D1 look-alike (node:sqlite, every migration applied):
 * the unseen retry on APIMart, then on ePhone, the busy offer when both fail, taking it once, declining it, and a
 * refusal keeping its FLUX 3 road.
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
import { busySwitchFor, closestAspect, isProviderBusy, alternativeFor, imageAlternatives } from "../src/studio/image-models.ts";

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
 * A fake ePhone and APIMart: `ephone(n)` answers the n-th ePhone task (1-based) with a status object, `apimart(n)` the
 * n-th APIMart task (null = APIMart refuses the order).
 */
function providers({ ephone, apimart = () => null }) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = String(init.body); }
    sent.push({ url: u, method: init.method ?? "GET", body });
    if (u.startsWith("https://cloudflare-dns.com/dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }), { headers: { "content-type": "application/dns-json" } });
    if (u.endsWith("/v1/task/submit")) return ok({ id: `task_${sent.filter((s) => s.url.endsWith("/v1/task/submit")).length}` });
    const et = /\/v1\/task\/task_(\d+)$/.exec(u);
    if (et) return ok(ephone(Number(et[1])));
    if (u === "https://api.apimart.ai/v1/images/generations") {
      const n = sent.filter((s) => s.url === u).length;
      return apimart(n) ? ok({ code: 200, data: [{ status: "submitted", task_id: `am_${n}` }] }) : new Response(JSON.stringify({ error: { code: 503, message: "busy" } }), { status: 503 });
    }
    const at = /\/v1\/tasks\/am_(\d+)$/.exec(u);
    if (at) return ok({ code: 200, data: apimart(Number(at[1])) });
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
  const cookie = await account(env, "ana@kleo.test");
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
  const cookie = await account(env, "bo@kleo.test");
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
  const cookie = await account(env, "cy@kleo.test");
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
  const cookie = await account(env, "di@kleo.test");
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
