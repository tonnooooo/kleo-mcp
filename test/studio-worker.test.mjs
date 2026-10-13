/**
 * Kleo Studio end to end inside one process: the kleo-studio Worker (src/studio/index.ts) bundled with esbuild and
 * driven through its fetch handler, on a D1 look-alike (node:sqlite, every migration applied), an in-memory R2 and a
 * fake ePhone. Covers the money paths: sign-up credits, the free-model lock, the debit, the saved video, the refund
 * on a failed clip and on an empty provider balance, the agent's proposal turned into a clip, and who may read what.
 * Run: node --test test/studio-worker.test.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
}
// The Workers runtime's FixedLengthStream, as a plain pass-through.
globalThis.FixedLengthStream ??= class extends TransformStream { constructor() { super(); } };

let worker, accounts;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts"; export { makeHandle } from "./src/accounts.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"],
  });
  const mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
  worker = mod.default; accounts = mod;
});

function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: new FakeR2(), ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", EPHONE_API_KEY: "ek", FREE_CREDITS: "5",
    STUDIO_FREE_MODELS: "seedance-2.0-fast", STUDIO_DAILY_BUDGET_USD: "30",
    STRIPE_LINK_5: "https://buy.stripe.com/a", STRIPE_LINK_15: "https://buy.stripe.com/b", STRIPE_LINK_40: "https://buy.stripe.com/c",
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const ctx = { waitUntil() {}, passThroughOnException() {} };
async function call(env, path, { method = "GET", body, cookie, header = true, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (header) h["x-kleo"] = "1";
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await worker.fetch(new Request(`https://app.kleo.test${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env, ctx);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, res };
}
const cookieOf = (r) => (r.res.headers.get("set-cookie") ?? "").split(";")[0];
async function signUp(env, email = "ana@example.com") {
  const r = await call(env, "/api/auth/signup", { method: "POST", body: { email, password: "long enough pw" } });
  assert.equal(r.status, 200, r.text);
  return cookieOf(r);
}

/** A fake ePhone: records what was sent, answers what the test scripted. */
function fakeProvider(script) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    sent.push({ url: u, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} });
    return script(u, init, sent);
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}
const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const old = (env) => env.DB.db.exec("UPDATE studio_generations SET checked_at = '2000-01-01T00:00:00.000Z'");
const credits = (env, id) => env.DB.db.prepare("SELECT credits FROM users WHERE id = ?").get(id).credits;

test("writes need the X-Kleo header; sign-up gives the free credits and only the free model", async () => {
  const env = newEnv();
  assert.equal((await call(env, "/api/auth/signup", { method: "POST", body: { email: "a@b.co", password: "long enough pw" }, header: false })).status, 403);
  assert.equal((await call(env, "/api/auth/signup", { method: "POST", body: { email: "nope", password: "long enough pw" } })).status, 400);
  assert.equal((await call(env, "/api/auth/signup", { method: "POST", body: { email: "a@b.co", password: "short" } })).status, 400);
  const cookie = await signUp(env, "A@B.co");
  const me = await call(env, "/api/me", { cookie });
  assert.equal(me.json.credits, 5);
  assert.equal(me.json.email, "a@b.co");
  assert.deepEqual(me.json.allowed, ["seedance-2.0-fast"]);
  assert.equal(me.json.paid, false);
  assert.match(me.json.packs[0].url, /client_reference_id=u_/);
  assert.equal((await call(env, "/api/auth/signup", { method: "POST", body: { email: "a@b.co", password: "long enough pw" } })).status, 409);
  assert.equal((await call(env, "/api/me")).status, 401);
  assert.equal((await call(env, "/api/auth/signin", { method: "POST", body: { email: "a@b.co", password: "wrong password" } })).status, 401);
  const back = await call(env, "/api/auth/signin", { method: "POST", body: { email: "a@b.co", password: "long enough pw" } });
  assert.equal(back.status, 200);
  assert.equal((await call(env, "/api/me", { cookie: cookieOf(back) })).json.id, me.json.id);
});

test("a Kleo key from the MCP server signs in to that same account", async () => {
  const env = newEnv();
  env.DB.db.exec("INSERT INTO users (id, email, credits) VALUES ('u_mcpuser00001', 'u_mcpuser00001@anon.kleo.invalid', 12)");
  const key = await accounts.makeHandle(env, "u_mcpuser00001");
  assert.equal((await call(env, "/api/auth/key", { method: "POST", body: { key: key + "x" } })).status, 401);
  const r = await call(env, "/api/auth/key", { method: "POST", body: { key } });
  assert.equal(r.status, 200);
  const me = await call(env, "/api/me", { cookie: cookieOf(r) });
  assert.equal(me.json.credits, 12);
  assert.equal(me.json.email, null);
  assert.equal((await call(env, "/api/auth/password", { method: "POST", cookie: cookieOf(r), body: { email: "mcp@x.io", password: "long enough pw" } })).status, 200);
  assert.equal((await call(env, "/api/auth/signin", { method: "POST", body: { email: "mcp@x.io", password: "long enough pw" } })).status, 200);
});

test("free account: a locked model is refused before any money moves; the free one debits, saves and serves", async () => {
  const env = newEnv();
  const cookie = await signUp(env);
  const me = (await call(env, "/api/me", { cookie })).json;
  const locked = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "a fox", settings: { model: "veo-3.1" } } });
  assert.equal(locked.status, 402);
  assert.equal(locked.json.code, "locked");
  assert.equal(credits(env, me.id), 5);

  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/task/submit")) return ok({ id: "task_1", status: "queued" });
    if (u.endsWith("/v1/task/task_1")) return ok({ id: "task_1", status: "completed", outputs: ["https://cdn.example/out.mp4"], usage: { type: "tokens", total_tokens: 100 } });
    if (u === "https://cdn.example/out.mp4") return new Response(new Uint8Array(5000).fill(7), { status: 200, headers: { "content-type": "video/mp4" } });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "a fox in the snow", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5, aspect: "9:16" } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.generation.status, "running");
    assert.equal(r.json.credits, 4);
    assert.equal(r.json.messages.length, 2);
    const submit = p.sent.find((s) => s.url.endsWith("/v1/task/submit"));
    assert.equal(submit.body.model, "doubao-seedance-2-0-fast-260128");
    assert.deepEqual({ d: submit.body.input.duration, r: submit.body.input.resolution, a: submit.body.input.aspect_ratio }, { d: 5, r: "480p", a: "9:16" });
    assert.equal(submit.headers["X-Provider-Order"], "official");
    assert.equal(submit.headers.authorization, "Bearer ek");

    const id = r.json.generation.id;
    old(env);
    const done = await call(env, `/api/generations/${id}`, { cookie });
    assert.equal(done.json.generation.status, "done", done.text);
    assert.equal(done.json.generation.video, `/media/${id}.mp4`);
    assert.equal(done.json.credits, 4, "a finished clip keeps its price");
    const video = await call(env, `/media/${id}.mp4`, { cookie });
    assert.equal(video.status, 200);
    assert.equal(video.text.length, 5000);
    assert.equal((await call(env, `/media/${id}.mp4`)).status, 404, "no cookie, no signature: nothing");
    const other = await signUp(env, "eve@example.com");
    assert.equal((await call(env, `/media/${id}.mp4`, { cookie: other })).status, 404, "another account cannot read it");
    assert.equal((await call(env, `/api/generations/${id}`, { cookie: other })).status, 404);
    const share = await call(env, `/api/generations/${id}/share`, { method: "POST", cookie });
    const shared = new URL(share.json.url);
    assert.equal((await call(env, shared.pathname + shared.search)).status, 200, "a share link opens without an account");
    const list = await call(env, "/api/generations", { cookie });
    assert.equal(list.json.generations.length, 1);
    const chats = await call(env, "/api/chats", { cookie });
    assert.equal(chats.json.chats.length, 1);
  } finally { p.restore(); }
});

test("a clip the provider fails is refunded once, however many times it is polled", async () => {
  const env = newEnv();
  const cookie = await signUp(env);
  const me = (await call(env, "/api/me", { cookie })).json;
  const p = fakeProvider((u) => u.endsWith("/v1/task/submit") ? ok({ id: "task_9" }) : ok({ id: "task_9", status: "failed", error: "Content policy violation detected" }));
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "x", settings: { model: "seedance-2.0-fast", resolution: "720p" } } });
    assert.equal(credits(env, me.id), 3);
    old(env);
    const f = await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
    assert.equal(f.json.generation.status, "failed");
    assert.equal(f.json.generation.refunded, true);
    assert.match(f.json.generation.error, /Content policy/);
    old(env);
    await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
    await worker.scheduled({}, env, ctx);
    assert.equal(credits(env, me.id), 5);
    const refunds = env.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'credits.refund' AND job_id = ?").get(r.json.generation.id).n;
    assert.equal(refunds, 1);
  } finally { p.restore(); }
});

test("an empty provider balance refuses the order and gives the credits back at once", async () => {
  const env = newEnv();
  const cookie = await signUp(env);
  const me = (await call(env, "/api/me", { cookie })).json;
  const p = fakeProvider(() => new Response(JSON.stringify({ error: { code: "insufficient_user_quota", message: "预扣费额度失败" } }), { status: 403 }));
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "x", settings: { model: "seedance-2.0-fast" } } });
    assert.equal(r.json.generation.status, "failed");
    assert.match(r.json.generation.error, /recharged/);
    assert.ok(!/ephone/i.test(r.json.generation.error));
    assert.equal(credits(env, me.id), 5);
  } finally { p.restore(); }
});

test("paid account: every model; not enough credits is refused; the daily budget stops new orders", async () => {
  const env = newEnv({ STUDIO_DAILY_BUDGET_USD: "2" });
  const cookie = await signUp(env);
  const me = (await call(env, "/api/me", { cookie })).json;
  env.DB.db.exec(`INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('manual_t', '${me.id}', 0, 0, 'eur', 'paid', 'tester')`);
  assert.equal((await call(env, "/api/me", { cookie })).json.allowed.length, 5);
  const poor = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "x", settings: { model: "veo-3.1", duration: 8 } } });
  assert.equal(poor.status, 402);
  assert.equal(poor.json.code, "credits");
  env.DB.db.exec(`UPDATE users SET credits = 100 WHERE id = '${me.id}'`);
  const p = fakeProvider(() => ok({ id: "task_v" }));
  try {
    const veo = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "x", settings: { model: "veo-3.1", duration: 8, aspect: "9:16" } } });
    assert.equal(veo.status, 200, veo.text);
    const submit = p.sent.find((s) => s.url.endsWith("/v1/task/submit"));
    assert.equal(submit.body.model, "veo-3.1-generate-preview");
    assert.equal(submit.headers["X-Provider-Order"], "official_cheap");
    assert.equal(credits(env, me.id), 93);
    const over = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "x", settings: { model: "veo-3.1", duration: 8 } } });
    assert.equal(over.status, 503, "1.70 $ + 1.70 $ is past the 2 $ day");
    assert.equal(credits(env, me.id), 93);
  } finally { p.restore(); }
});

test("pictures: only the owner (or the provider's signed link) can fetch them; the agent sees them and proposes; the card generates", async () => {
  const env = newEnv();
  const cookie = await signUp(env);
  const jpeg = new Uint8Array(2000); jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal((await call(env, "/api/uploads", { method: "POST", cookie, raw: new Uint8Array(100).fill(1), headers: { "content-type": "image/jpeg" } })).status, 415);
  const up = await call(env, "/api/uploads", { method: "POST", cookie, raw: jpeg, headers: { "content-type": "image/jpeg", "x-width": "1024", "x-height": "768" } });
  assert.equal(up.status, 200, up.text);
  assert.equal((await call(env, up.json.url, { cookie })).status, 200);
  const other = await signUp(env, "eve@example.com");
  assert.equal((await call(env, up.json.url, { cookie: other })).status, 404);

  const p = fakeProvider((u, init) => {
    if (u.endsWith("/v1/chat/completions")) return ok({ choices: [{ message: { content: "Let's bring it to life!", tool_calls: [{ function: { name: "propose_video", arguments: JSON.stringify({ title: "Living photo", prompt: "The woman in the photo turns and smiles, wind in her hair", model: "seedance-2.5", image_role: "first_frame" }) } }] } }] });
    if (u.endsWith("/v1/task/submit")) return ok({ id: "task_p" });
    return new Response("?", { status: 404 });
  });
  try {
    const chat = await call(env, "/api/chat", { method: "POST", cookie, body: { text: "animate this", imageIds: [up.json.id], settings: { model: "seedance-2.0-fast" } } });
    assert.equal(chat.status, 200, chat.text);
    const llm = p.sent.find((s) => s.url.endsWith("/v1/chat/completions"));
    assert.match(llm.body.messages.at(-1).content[1].image_url.url, /^data:image\/jpeg;base64,/);
    const bot = chat.json.messages.find((m) => m.role === "assistant");
    assert.equal(bot.proposal.settings.model, "seedance-2.0-fast", "a free account's card is moved to a model it can use");
    assert.equal(bot.proposal.settings.imageRole, "first_frame");
    assert.deepEqual(bot.proposal.imageIds, [up.json.id]);
    const g = await call(env, "/api/generate", { method: "POST", cookie, body: { proposalId: bot.id, prompt: "The woman turns and smiles, wind in her hair, golden light" } });
    assert.equal(g.status, 200, g.text);
    const submit = p.sent.find((s) => s.url.endsWith("/v1/task/submit"));
    assert.equal(submit.body.input.aspect_ratio, "adaptive");
    assert.equal(submit.body.input.prompt, "The woman turns and smiles, wind in her hair, golden light", "the edited prompt is the one sent");
    const link = new URL(submit.body.input.first_frame);
    assert.equal(link.origin, "https://app.kleo.test");
    assert.equal((await call(env, link.pathname + link.search)).status, 200, "the provider can fetch the picture through its signed link");
    const thread = await call(env, `/api/chats/${chat.json.chat.id}`, { cookie });
    const card = thread.json.messages.find((m) => m.id === bot.id);
    assert.equal(card.generations.length, 1);
    assert.equal((await call(env, `/api/chats/${chat.json.chat.id}`, { cookie: other })).status, 404);
  } finally { p.restore(); }
});

test("the app shell is served for any page path", async () => {
  const env = newEnv();
  const r = await call(env, "/c/c_whatever");
  assert.equal(r.status, 200);
  assert.match(r.text, /app/);
});
