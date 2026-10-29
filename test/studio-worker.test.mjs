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
  async head(key) { const e = this.m.get(key); return e ? { size: e.bytes.byteLength, httpEtag: '"x"', httpMetadata: { contentType: e.type } } : null; }
  async delete(keys) { for (const k of [].concat(keys)) this.m.delete(k); }
  async list({ prefix = "" } = {}) { return { objects: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; }
}
// DNS for the e-mail check (src/abuse.ts mailDomainOk), answered here: "nomail.example" does not exist, every other
// domain receives mail. Installed under every test; fakeProvider wraps it like any other fetch.
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith("https://cloudflare-dns.com/dns-query")) return real(url, init);
    const name = new URL(u).searchParams.get("name");
    return new Response(JSON.stringify(name === "nomail.example" ? { Status: 3 } : { Status: 0, Answer: [{ type: 15 }] }), { headers: { "content-type": "application/dns-json" } });
  };
}
// The Workers runtime's FixedLengthStream, as a plain pass-through.
globalThis.FixedLengthStream ??= class extends TransformStream { constructor() { super(); } };

let worker, accounts;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts"; export { makeHandle, verifyHandle } from "./src/accounts.ts"; export { looksEnglish } from "./src/studio/translate.ts";`, resolveDir: ROOT, loader: "ts" },
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
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
async function call(env, path, { method = "GET", body, cookie, header = true, raw, headers = {}, cf } = {}) {
  const h = { ...headers };
  if (header) h["x-kleo"] = "1";
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["content-type"] = "application/json";
  const req = new Request(`https://app.kleo.test${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  // What Cloudflare tells the Worker about the visitor's network (request.cf), when a test needs it.
  if (cf) Object.defineProperty(req, "cf", { value: cf });
  const res = await worker.fetch(req, env, ctx);
  await Promise.allSettled(pending.splice(0));
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
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = String(init.body); }
    sent.push({ url: u, method: init.method ?? "GET", body, headers: init.headers ?? {} });
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
  // The key is a credential: never in /api/me, only on an explicit request; a new one retires the old everywhere.
  assert.equal(me.json.kleoKey, undefined);
  assert.equal((await call(env, "/api/me/key", { method: "POST", cookie: cookieOf(r), body: {} })).json.key, key);
  const second = await call(env, "/api/auth/key", { method: "POST", body: { key } }); // the leaked key's own session
  const rotated = await call(env, "/api/me/key", { method: "POST", cookie: cookieOf(r), body: { reset: true } });
  const fresh = rotated.json.key;
  assert.notEqual(fresh, key);
  assert.equal(rotated.res.headers.get("cache-control"), "no-store");
  assert.equal((await call(env, "/api/me", { cookie: cookieOf(second) })).status, 401, "a session opened with the old key ends with it");
  assert.equal((await call(env, "/api/me", { cookie: cookieOf(r) })).status, 401, "every session does");
  assert.equal((await call(env, "/api/me", { cookie: cookieOf(rotated) })).json.id, "u_mcpuser00001", "but the browser that asked is signed in again");
  assert.equal(await accounts.verifyHandle(env, key), null, "the old key no longer opens the account (MCP sign-in included)");
  assert.equal(await accounts.verifyHandle(env, fresh), "u_mcpuser00001");
  assert.equal((await call(env, "/api/auth/key", { method: "POST", body: { key } })).status, 401);
  // Sign out everywhere: every cookie of the account stops working.
  const other = await call(env, "/api/auth/key", { method: "POST", body: { key: fresh } });
  assert.equal((await call(env, "/api/auth/signout-all", { method: "POST", cookie: cookieOf(other) })).status, 200);
  assert.equal((await call(env, "/api/me", { cookie: cookieOf(r) })).status, 401);
  assert.equal((await call(env, "/api/me", { cookie: cookieOf(other) })).status, 401);
});

test("the Kleo key of an account merged into another one opens neither account", async () => {
  const env = newEnv();
  const owner = await signUp(env, "owner@example.com");
  const ownerId = (await call(env, "/api/me", { cookie: owner })).json.id;
  // An old anonymous account taken in by the signed-in one (src/connect.ts mergeAnonymous sets merged_into).
  env.DB.db.prepare("INSERT INTO users (id, email, credits, merged_into) VALUES ('u_anonmerged1', 'u_anonmerged1@anon.kleo.invalid', 0, ?)").run(ownerId);
  const key = await accounts.makeHandle(env, "u_anonmerged1");
  assert.equal(await accounts.verifyHandle(env, key), "u_anonmerged1", "the key itself is still well signed");
  const r = await call(env, "/api/auth/key", { method: "POST", body: { key } });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, "merged_key");
  assert.equal(r.res.headers.get("set-cookie"), null, "no session is opened, for either account");
  assert.equal((await call(env, "/api/me", { cookie: owner })).json.id, ownerId, "the account it joined keeps its own sign-in");
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
    assert.equal(r.json.credits, 3);
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
    assert.equal(done.json.credits, 3, "a finished clip keeps its price");
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
    // Delete: never another account's, never without the header; then the row, the file and the share link are gone.
    assert.equal((await call(env, `/api/generations/${id}`, { method: "DELETE", cookie: other })).status, 404);
    assert.equal((await call(env, `/api/generations/${id}`, { method: "DELETE", cookie, header: false })).status, 403);
    const fileKey = [...env.RENDERS.m.keys()].find((k) => k.includes(id));
    assert.ok(fileKey, "the clip is stored");
    const del = await call(env, `/api/generations/${id}`, { method: "DELETE", cookie });
    assert.equal(del.status, 200, del.text);
    assert.ok(!env.RENDERS.m.has(fileKey), "the file is gone");
    assert.equal((await call(env, "/api/generations", { cookie })).json.generations.length, 0);
    assert.equal((await call(env, shared.pathname + shared.search)).status, 404, "the shared link dies with it");
    assert.equal(credits(env, me.id), 3, "deleting never moves credits");
  } finally { p.restore(); }
});

test("a clip the provider fails is refunded once, however many times it is polled", async () => {
  const env = newEnv();
  const cookie = await signUp(env);
  const me = (await call(env, "/api/me", { cookie })).json;
  const p = fakeProvider((u) => u.endsWith("/v1/task/submit") ? ok({ id: "task_9" }) : ok({ id: "task_9", status: "failed", error: "Content policy violation detected" }));
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "x", settings: { model: "seedance-2.0-fast", resolution: "480p" } } });
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
  assert.equal((await call(env, "/api/me", { cookie })).json.allowed.length, 6, "Seedance x3, Veo x2 and Kling 3.0 (copy motion)");
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

test("pictures: a set of four, two fail, the share they stood for comes back; each picture is an upload", async () => {
  const env = newEnv();
  const cookie = await signUp(env);
  const me = (await call(env, "/api/me", { cookie })).json;
  assert.deepEqual(me.allowedImages, ["nano-banana-2", "seedream-5", "flux-2-pro"]);
  const locked = await call(env, "/api/generate", { method: "POST", cookie, body: { kind: "image", prompt: "a fox", settings: { model: "nano-banana-pro" } } });
  assert.equal(locked.json.code, "locked");
  for (const model of ["nano-banana-2.1", "flux-3", "gpt-image-2.5"]) {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { kind: "image", prompt: "a fox", settings: { model, quality: "1K", count: 4 } } });
    assert.equal(r.status, 402, `${model} is locked for an account that never paid`);
    assert.equal(r.json.code, "locked");
  }
  assert.equal((await call(env, "/api/me", { cookie })).json.credits, me.credits, "nothing was charged");
  env.DB.db.exec(`INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('manual_i', '${me.id}', 0, 0, 'eur', 'paid', 'tester')`);
  let n = 0;
  const png = new Uint8Array(4000); png.set([0x89, 0x50, 0x4e, 0x47]);
  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/task/submit")) return ok({ id: `task_i${++n}` });
    const m = u.match(/task_i(\d)$/);
    if (m) return Number(m[1]) <= 2 ? ok({ status: "completed", outputs: [`https://cdn.example/p${m[1]}.png`] }) : ok({ status: "failed", error: "blocked by safety" });
    if (u.startsWith("https://cdn.example/p")) return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { kind: "image", prompt: "a fox in a hat", settings: { model: "nano-banana-pro", count: 4, aspect: "4:5" } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.generation.kind, "image");
    assert.equal(r.json.credits, 3, "4 Nano Banana Pro pictures cost 2 credits");
    const submits = p.sent.filter((s) => s.url.endsWith("/v1/task/submit"));
    assert.equal(submits.length, 4);
    assert.equal(submits[0].body.model, "gemini-3-pro-image");
    assert.equal(submits[0].body.input.aspect_ratio, "4:5");
    assert.equal(submits[0].headers["X-Provider-Order"], "official_cheap");
    old(env);
    // The two refused pictures get their second try on FLUX 3 (19 October 2026), at BFL's default tolerance.
    const retry = await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
    assert.equal(retry.json.generation.status, "running", retry.text);
    const seconds = p.sent.filter((s) => s.url.endsWith("/v1/task/submit")).slice(4);
    assert.deepEqual(seconds.map((s) => [s.body.model, s.body.input.safety_tolerance, s.body.input.aspect_ratio]), [["flux-3-image", 2, "4:5"], ["flux-3-image", 2, "4:5"]]);
    old(env);
    const done = await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
    assert.equal(done.json.generation.status, "done", done.text);
    assert.equal(done.json.generation.outputs.length, 2);
    assert.equal(p.sent.filter((s) => s.url.endsWith("/v1/task/submit")).length, 6, "a safety refusal on FLUX 3 is not asked again");
    assert.equal(done.json.credits, 4, "two failed pictures of four give back 1 of the 2 credits");
    const pic = done.json.generation.outputs[0];
    assert.equal((await call(env, pic.url, { cookie })).status, 200);
    // A finished picture can start a video at once (it is an upload of this account).
    const anim = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "the fox winks", imageIds: [pic.upload], settings: { model: "seedance-2.0-fast" } } });
    assert.equal(anim.status, 200, anim.text);
    assert.match(p.sent.filter((s) => s.url.endsWith("/v1/task/submit")).at(-1).body.input.first_frame, /\/media\/raw\/up_/, "the provider reads the clean file");
    const share = await call(env, `/api/generations/${r.json.generation.id}/share`, { method: "POST", cookie, body: { upload: pic.upload } });
    assert.match(share.json.url, /\/media\/u\/up_.*sig=/);
  } finally { p.restore(); }
});

test("a well-known character Google refuses is made on FLUX 3; BFL's Protected Content is asked once more at tolerance 4", async () => {
  // The owner's WALL-E edit, 19 October 2026: Nano Banana 2.1 answered no image, Seedream "sensitive information",
  // FLUX 3 at tolerance 2 "Protected Content", FLUX 3 at 4 made it.
  const env = newEnv();
  const { cookie, id } = await paidAccount(env);
  const ref = await upload(env, cookie, jpegBytes());
  let n = 0;
  const png = new Uint8Array(4000); png.set([0x89, 0x50, 0x4e, 0x47]);
  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/task/submit")) return ok({ id: `task_w${++n}` });
    if (/task_w1$/.test(u)) return ok({ status: "failed", error: "no image generated in response" });
    if (/task_w2$/.test(u)) return ok({ status: "failed", error: 'Content Moderated: {"Moderation Reasons":["Protected Content"]}' });
    if (/task_w3$/.test(u)) return ok({ status: "completed", outputs: ["https://cdn.example/w.png"] });
    if (u === "https://cdn.example/w.png") return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { kind: "image", prompt: "three robots at a counter", imageIds: [ref.id], settings: { model: "nano-banana-2.1", aspect: "16:9", quality: "4K" } } });
    assert.equal(r.status, 200, r.text);
    const paid = credits(env, id);
    const subs = () => p.sent.filter((s) => s.url.endsWith("/v1/task/submit"));
    for (let i = 0; i < 3; i++) { old(env); await call(env, `/api/generations/${r.json.generation.id}`, { cookie }); }
    assert.deepEqual(subs().map((s) => [s.body.model, s.body.input.safety_tolerance ?? null, s.body.input.resolution ?? null]),
      [["gemini-nano-banana-2.1", null, null], ["flux-3-image", 2, "2k"], ["flux-3-image", 4, "2k"]], "4K on Nano Banana is made at 2K on FLUX 3");
    assert.equal(subs()[1].headers["X-Provider-Order"], "official_cheap");
    assert.equal(subs()[1].body.input.images.length, 1, "the same references");
    const done = await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
    assert.equal(done.json.generation.status, "done", done.text);
    assert.equal(done.json.generation.modelName, "FLUX 3", "the card names the model that drew it");
    assert.equal(done.json.generation.outputs.length, 1);
    assert.equal(credits(env, id), paid, "same credits, nothing refunded, nothing more charged");
  } finally { p.restore(); }
});

test("a copyright refusal reads plainly and has no request id; a song downloads under its own name", async () => {
  // The owner's first customer, 19 October 2026: Seedance refused her video three times, and the 50-character
  // request id ran off her phone's screen.
  const env = newEnv();
  const { cookie, id } = await paidAccount(env);
  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/task/submit")) return ok({ id: "task_cr" });
    if (/task_cr$/.test(u)) return ok({ status: "failed", error: "The request failed because the output video may be related to copyright restrictions. Request id: 02179238171945500000000000000000000ffffac158e25999f35" });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "three singers dance", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } } });
    assert.equal(r.status, 200, r.text);
    old(env);
    const g = (await call(env, `/api/generations/${r.json.generation.id}`, { cookie })).json.generation;
    assert.equal(g.status, "failed");
    // Since 20 October 2026 the card names the model that refused it, with the Wan 3.0 offer under it.
    assert.match(g.error, /^Seedance 2\.0 Fast won't make this one: it recognised characters, people or music protected by copyright/);
    assert.equal(g.offer?.name, "Wan 3.0");
    assert.ok(!/Request id|0217/.test(g.error), g.error);
    assert.equal(g.refunded, true);
    assert.equal(credits(env, id), 100);
  } finally { p.restore(); }
  const up = await upload(env, cookie, jpegBytes(), "image/jpeg");
  const named = await call(env, `/media/u/${up.id}?dl=1&name=song-2-abc123`, { cookie });
  assert.match(named.res.headers.get("content-disposition"), /attachment; filename="kleo-song-2-abc123\.jpg"/);
  const odd = await call(env, `/media/u/${up.id}?dl=1&name=..%2Fx`, { cookie });
  assert.match(odd.res.headers.get("content-disposition"), new RegExp(`filename="kleo-${up.id}\.jpg"`), "anything but a plain slug falls back to the id");
});

test("password reset: off without an e-mail key; with one, a one-time link that dies when used", async () => {
  const off = newEnv();
  assert.equal((await call(off, "/api/auth/forgot", { method: "POST", body: { email: "a@b.co" } })).status, 503);
  const env = newEnv({ RESEND_API_KEY: "re_x" });
  const before = await signUp(env, "rita@example.com");
  const oldKey = (await call(env, "/api/me/key", { method: "POST", cookie: before, body: {} })).json.key;
  let mail;
  const p = fakeProvider((u, init) => { if (u.includes("api.resend.com")) { mail = JSON.parse(init.body); return ok({ id: "m1" }); } return new Response("?", { status: 404 }); });
  try {
    assert.equal((await call(env, "/api/auth/forgot", { method: "POST", body: { email: "nobody@example.com" } })).status, 200, "same answer for unknown addresses");
    assert.equal(mail, undefined);
    assert.equal((await call(env, "/api/auth/forgot", { method: "POST", body: { email: "rita@example.com" } })).status, 200);
    const token = decodeURIComponent(mail.text.match(/reset\?t=(\S+)/)[1]);
    assert.equal((await call(env, "/api/auth/reset", { method: "POST", body: { token, password: "brand new pass" } })).status, 200);
    assert.equal((await call(env, "/api/auth/reset", { method: "POST", body: { token, password: "another pass 2" } })).status, 400, "the link died with the old password");
    assert.equal((await call(env, "/api/auth/signin", { method: "POST", body: { email: "rita@example.com", password: "brand new pass" } })).status, 200);
    assert.equal((await call(env, "/api/me", { cookie: before })).status, 401, "a reset ends every session made with the old password");
    assert.equal(await accounts.verifyHandle(env, oldKey), null, "and renews the Kleo key, so an assistant connected with the old one is out too");
  } finally { p.restore(); }
});

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64u({ alg: "RS256" })}.${b64u(claims)}.sig`;
/** One full social round trip: start (state cookie), then the callback with the provider answering `claims`. */
async function social(env, key, claims, { cookie = "", link = false, tamper = false } = {}) {
  const start = await worker.fetch(new Request(`https://app.kleo.test/auth/${key}${link ? "?link=1" : ""}`, { headers: cookie ? { cookie } : {} }), env, ctx);
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get("location"));
  const state = to.searchParams.get("state");
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  assert.ok(to.searchParams.get("code_challenge") && to.searchParams.get("nonce"), "PKCE and a nonce on every sign-in");
  const stateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(stateCookie, new RegExp(`^__Host-kleo_ostate_${key}=`));
  const p = fakeProvider((u, init) => {
    if (u.includes("oauth2.googleapis.com/token") || u.includes("login.microsoftonline.com/common/oauth2/v2.0/token")) {
      assert.match(String(init.body), /client_secret=/);
      assert.match(String(init.body), /code_verifier=/);
      return ok({ id_token: jwt({ nonce: to.searchParams.get("nonce"), ...claims }) });
    }
    return new Response("?", { status: 404 });
  });
  try {
    const cb = await worker.fetch(new Request(`https://app.kleo.test/auth/${key}/callback?code=c1&state=${tamper ? "st_forged" : state}`, { headers: { cookie: [stateCookie, cookie].filter(Boolean).join("; ") } }), env, ctx);
    const session = (cb.headers.getSetCookie?.() ?? [cb.headers.get("set-cookie") ?? ""]).find((c) => c.startsWith("__Host-kleo_studio=") && !c.startsWith("__Host-kleo_studio=;"));
    return { to, location: cb.headers.get("location"), cookie: session ? session.split(";")[0] : null };
  } finally { p.restore(); }
}
const MS_PERSONAL = "9188040d-6c67-4c5b-b112-36a304b66dad";

test("Google and Microsoft: off until configured; new accounts; verified e-mails join the existing account, unverified ones never do", async () => {
  const off = newEnv();
  assert.deepEqual((await call(off, "/api/config")).json.social, []);
  const env = newEnv({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs", MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "ms", STUDIO_SIGNUP: "all" });
  assert.deepEqual((await call(env, "/api/config")).json.social, ["google", "microsoft"]);

  // A brand-new Google person.
  const g = await social(env, "google", { sub: "g-1", aud: "gid", email: "Luca@Gmail.com", email_verified: true });
  assert.equal(g.to.host, "accounts.google.com");
  assert.equal(g.to.searchParams.get("redirect_uri"), "https://app.kleo.test/auth/google/callback");
  assert.equal(g.location, "/");
  const gm = (await call(env, "/api/me", { cookie: g.cookie })).json;
  assert.equal(gm.email, "luca@gmail.com");
  assert.equal(gm.credits, 5);
  assert.deepEqual(gm.methods, ["google"]);
  // Back again with the same Google account: the same Kleo account.
  const g2 = await social(env, "google", { sub: "g-1", aud: "gid", email: "luca@gmail.com", email_verified: true });
  assert.equal((await call(env, "/api/me", { cookie: g2.cookie })).json.id, gm.id);
  // A token for another app is refused.
  assert.match((await social(env, "google", { sub: "g-9", aud: "someone-else" })).location, /signin_error=google/);
  // A forged state is refused.
  assert.match((await social(env, "google", { sub: "g-1", aud: "gid" }, { tamper: true })).location, /signin_error=state/);

  // A password account, then Microsoft with the same address.
  const pw = await signUp(env, "anna@outlook.com");
  const pwId = (await call(env, "/api/me", { cookie: pw })).json.id;
  const work = await social(env, "microsoft", { sub: "m-work", aud: "mid", tid: "some-company-tenant", email: "anna@outlook.com" });
  const workMe = (await call(env, "/api/me", { cookie: work.cookie })).json;
  assert.notEqual(workMe.id, pwId, "a work tenant's e-mail claim is not proof: no takeover of the password account");
  const personal = await social(env, "microsoft", { sub: "m-home", aud: "mid", tid: MS_PERSONAL, preferred_username: "anna@outlook.com" });
  assert.equal((await call(env, "/api/me", { cookie: personal.cookie })).json.id, pwId, "a personal Microsoft account's address is verified: the untouched account is hers");
  // Whoever typed her address at sign-up is out: the password login is gone and the old session ended.
  assert.equal((await call(env, "/api/me", { cookie: pw })).status, 401, "the claimant's session ended");
  assert.equal((await call(env, "/api/auth/signin", { method: "POST", body: { email: "anna@outlook.com", password: "long enough pw" } })).status, 401, "and the claimed password no longer opens it");
  assert.equal((await call(env, "/api/auth/signup", { method: "POST", body: { email: "luca@gmail.com", password: "long enough pw" } })).json.code, "use_google");
  // An account that was USED, holding the address only by a password, goes to the address's owner too (25 October 2026,
  // the owner's own old account was refused): Google signs in to it, its creations and credits stay, and whoever typed
  // the address is out — the password no longer opens it and the old session has ended.
  const used = await signUp(env, "carla@gmail.com");
  const usedId = (await call(env, "/api/me", { cookie: used })).json.id;
  env.DB.db.exec(`INSERT INTO studio_chats (id, user_id, title) VALUES ('c_used00000001', '${usedId}', 'x'); UPDATE users SET credits = 42 WHERE id = '${usedId}'`);
  const handed = await social(env, "google", { sub: "g-carla", aud: "gid", email: "carla@gmail.com", email_verified: true });
  assert.equal(handed.location, "/?linked=google", "the page says the account now opens with Google");
  const carla = (await call(env, "/api/me", { cookie: handed.cookie })).json;
  assert.deepEqual([carla.id, carla.credits, carla.methods], [usedId, 42, ["google"]], "the same account, its credits kept, Google its only way in");
  assert.equal((await call(env, `/api/chats/c_used00000001`, { cookie: handed.cookie })).status, 200, "its chats are there");
  assert.equal((await call(env, "/api/me", { cookie: used })).status, 401, "the password's old session has ended");
  assert.equal((await call(env, "/api/auth/signin", { method: "POST", body: { email: "carla@gmail.com", password: "long enough pw" } })).status, 401, "and the password no longer opens it");
  assert.equal(JSON.parse(env.DB.db.prepare("SELECT detail FROM audit WHERE user_id = ? AND event = 'studio.email_claim_evicted'").get(usedId).detail).used, true);
  // The same Google account again: straight in, no second hand-over.
  assert.equal((await social(env, "google", { sub: "g-carla", aud: "gid", email: "carla@gmail.com", email_verified: true })).location, "/");
  // An ADMIN account is never handed over: its password and phone code open the console.
  const boss = await signUp(env, "boss@gmail.com");
  const bossId = (await call(env, "/api/me", { cookie: boss })).json.id;
  env.STUDIO_ADMINS = bossId;
  const refused = await social(env, "google", { sub: "g-boss", aud: "gid", email: "boss@gmail.com", email_verified: true });
  assert.equal(refused.location, "/?signin_error=claimed_google");
  assert.equal(refused.cookie, null);
  assert.equal((await call(env, "/api/me", { cookie: boss })).json.id, bossId, "the admin account is untouched by the refusal");
  delete env.STUDIO_ADMINS;
  // A reply from the provider made for another sign-in (wrong nonce) is refused.
  assert.match((await social(env, "google", { sub: "g-1", aud: "gid", nonce: "someone-elses" })).location, /signin_error=google/);
});

test("an evicted claimant is out by every road: their linked Google, their Kleo key and their sessions no longer open the account", async () => {
  const env = newEnv({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs", STUDIO_SIGNUP: "all" });
  // Someone signs up with Vera's address, links their OWN Google account to it, and keeps the Kleo key.
  const squat = await signUp(env, "vera@gmail.com");
  const squatId = (await call(env, "/api/me", { cookie: squat })).json.id;
  assert.equal((await social(env, "google", { sub: "g-squatter", aud: "gid", email: "squatter@gmail.com", email_verified: true }, { cookie: squat, link: true })).location, "/?linked=google");
  const key = (await call(env, "/api/me/key", { method: "POST", cookie: squat, body: {} })).json.key;
  // Vera signs in with Google: the untouched account is hers.
  const vera = await social(env, "google", { sub: "g-vera", aud: "gid", email: "vera@gmail.com", email_verified: true });
  assert.equal((await call(env, "/api/me", { cookie: vera.cookie })).json.id, squatId);
  assert.deepEqual((await call(env, "/api/me", { cookie: vera.cookie })).json.methods, ["google"], "only her own sign-in is left on it");
  // The squatter's Google now finds nothing of hers: a fresh, separate account.
  const back = await social(env, "google", { sub: "g-squatter", aud: "gid", email: "squatter@gmail.com", email_verified: true });
  assert.notEqual((await call(env, "/api/me", { cookie: back.cookie })).json.id, squatId);
  assert.equal(await accounts.verifyHandle(env, key), null, "the key they kept is retired");
  assert.equal((await call(env, "/api/me", { cookie: squat })).status, 401, "and their session ended");
});

test("an old anonymous account merged into another opens nothing in Studio: its session ends at the merge, and no key, password, Google sign-in or connection opens it (27 October 2026)", async () => {
  const env = newEnv({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs", STUDIO_SIGNUP: "all" });
  // Vera's account, and an old anonymous account whose holder signed in to Studio with its key BEFORE it was merged into
  // Vera's (src/connect.ts mergeAnonymous). That session used to survive and could add a password or a Google sign-in.
  const vera = await signUp(env, "vera@gmail.com");
  const veraId = (await call(env, "/api/me", { cookie: vera })).json.id;
  env.DB.db.exec("INSERT INTO users (id, email, credits) VALUES ('u_anonmerged01', 'u_anonmerged01@anon.kleo.invalid', 0)");
  const anonKey = await accounts.makeHandle(env, "u_anonmerged01");
  const anon = cookieOf(await call(env, "/api/auth/key", { method: "POST", body: { key: anonKey } }));
  assert.equal((await call(env, "/api/me", { cookie: anon })).json.id, "u_anonmerged01");
  env.DB.db.prepare("UPDATE users SET merged_into = ? WHERE id = 'u_anonmerged01'").run(veraId);
  // The merge ends that session at once: nothing can be added to the merged account, and nothing connected from it.
  assert.equal((await call(env, "/api/me", { cookie: anon })).status, 401, "its session ended with the merge");
  assert.equal((await call(env, "/api/auth/password", { method: "POST", cookie: anon, body: { email: "anon@x.io", password: "long enough pw" } })).status, 401);
  assert.equal((await call(env, "/api/connect", { method: "POST", cookie: anon, body: { r: "x" } })).status, 401);
  const linked = await social(env, "google", { sub: "g-anon", aud: "gid", email: "anon@gmail.com", email_verified: true }, { cookie: anon, link: true });
  assert.match(linked.location ?? "", /signin_error=signin/, "no session, so no Google sign-in is added to it");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM studio_logins WHERE user_id = 'u_anonmerged01'").get().n, 0);
  // Its key opens nothing either: never the account it went into.
  assert.equal(await accounts.verifyHandle(env, anonKey), "u_anonmerged01", "merging alone retires no key");
  const viaKey = await call(env, "/api/auth/key", { method: "POST", body: { key: anonKey } });
  assert.equal(viaKey.status, 401);
  assert.equal(viaKey.json.code, "merged_key");
  // A sign-in the merged account already held (an account merged by hand) opens nothing: password or Google.
  env.DB.db.exec("INSERT INTO users (id, email, credits) VALUES ('u_anonmerged02', 'u_anonmerged02@anon.kleo.invalid', 0)");
  const pw = await call(env, "/api/auth/signup", { method: "POST", body: { email: "old@x.io", password: "long enough pw" } });
  const oldId = (await call(env, "/api/me", { cookie: cookieOf(pw) })).json.id;
  env.DB.db.prepare("UPDATE users SET merged_into = ? WHERE id = ?").run(veraId, oldId);
  const signin = await call(env, "/api/auth/signin", { method: "POST", body: { email: "old@x.io", password: "long enough pw" } });
  assert.equal(signin.status, 403, signin.text);
  assert.equal(signin.json.code, "merged");
  env.DB.db.prepare("INSERT INTO studio_logins (provider, subject, user_id, email) VALUES ('google', 'g-old', ?, 'old@gmail.com')").run(oldId);
  const g = await social(env, "google", { sub: "g-old", aud: "gid", email: "old@gmail.com", email_verified: true });
  assert.match(g.location ?? "", /signin_error=merged/);
  assert.equal(g.cookie, null, "no session");
  // Vera's controls still retire the merged accounts' keys (src/accounts.ts rotateKey).
  const rotated = await call(env, "/api/me/key", { method: "POST", cookie: vera, body: { reset: true } });
  assert.equal(rotated.status, 200, rotated.text);
  assert.equal(await accounts.verifyHandle(env, anonKey), null, "a new Kleo key retires the merged account's key");
});

test("Apple: off until its four keys are set; the answer is a form POST; our client secret is a signed ES256 JWT; a verified e-mail opens the account", async () => {
  const { generateKeyPairSync, verify } = await import("node:crypto");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  assert.deepEqual((await call(newEnv({ APPLE_CLIENT_ID: "com.kleooai.web" }), "/api/config")).json.social, [], "a client id alone is not enough");
  const env = newEnv({ APPLE_CLIENT_ID: "com.kleooai.web", APPLE_TEAM_ID: "TEAM123456", APPLE_KEY_ID: "KEY1234567", APPLE_PRIVATE_KEY: pem.replace(/\n/g, "\n") });
  assert.deepEqual((await call(env, "/api/config")).json.social, ["apple"]);
  const start = await worker.fetch(new Request("https://app.kleo.test/auth/apple"), env, ctx);
  const to = new URL(start.headers.get("location"));
  assert.equal(to.host, "appleid.apple.com");
  assert.equal(to.searchParams.get("response_mode"), "form_post");
  assert.equal(to.searchParams.get("scope"), "name email");
  assert.equal(to.searchParams.get("code_challenge"), null, "Apple takes no PKCE: the state and the nonce bind the answer");
  const stateCookie = start.headers.get("set-cookie");
  assert.match(stateCookie, /^__Host-kleo_ostate_apple=.*SameSite=None/, "or the browser would not send it with Apple's cross-site POST");
  let secret = null, sentBody = "";
  const p = fakeProvider((u, init) => {
    if (u === "https://appleid.apple.com/auth/token") {
      sentBody = String(init.body);
      secret = new URLSearchParams(sentBody).get("client_secret");
      return ok({ id_token: jwt({ sub: "001234.apple", aud: "com.kleooai.web", nonce: to.searchParams.get("nonce"), email: "Mia@privaterelay.appleid.com", email_verified: "true", is_private_email: "true" }) });
    }
    return new Response("?", { status: 404 });
  });
  try {
    const form = new URLSearchParams({ code: "c1", state: to.searchParams.get("state"), user: JSON.stringify({ name: { firstName: "Mia" } }) });
    const cb = await worker.fetch(new Request("https://app.kleo.test/auth/apple/callback", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: stateCookie.split(";")[0] }, body: form }), env, ctx);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/");
    assert.doesNotMatch(sentBody, /code_verifier=/);
    const [h64, c64, s64] = secret.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h64, "base64url")), { alg: "ES256", kid: "KEY1234567" });
    const c = JSON.parse(Buffer.from(c64, "base64url"));
    assert.equal(c.iss, "TEAM123456"); assert.equal(c.sub, "com.kleooai.web"); assert.equal(c.aud, "https://appleid.apple.com");
    assert.ok(c.exp > c.iat && c.exp - c.iat <= 600);
    assert.ok(verify("sha256", Buffer.from(`${h64}.${c64}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s64, "base64url")), "signed with the .p8 key");
    const session = cb.headers.getSetCookie().find((x) => x.startsWith("__Host-kleo_studio=") && !x.startsWith("__Host-kleo_studio=;"));
    const me = (await call(env, "/api/me", { cookie: session.split(";")[0] })).json;
    assert.equal(me.email, "mia@privaterelay.appleid.com");
    assert.deepEqual(me.methods, ["apple"]);
    // A POST that did not start here (no state cookie) is refused.
    const forged = await worker.fetch(new Request("https://app.kleo.test/auth/apple/callback", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }), env, ctx);
    assert.match(forged.headers.get("location"), /signin_error=state/);
  } finally { p.restore(); }
  // Google and Microsoft answer with a redirect, never a POST.
  const g = newEnv({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs" });
  assert.equal((await worker.fetch(new Request("https://app.kleo.test/auth/google/callback", { method: "POST", body: "code=x" }), g, ctx)).status, 404);
});

test("linking: the signed-in account gets Google; an account another person uses is refused; no session, no link", async () => {
  const env = newEnv({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs", MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "ms", STUDIO_SIGNUP: "all" });
  const a = await signUp(env, "a@example.com");
  const aId = (await call(env, "/api/me", { cookie: a })).json.id;
  const linked = await social(env, "google", { sub: "g-a", aud: "gid", email: "a.other@gmail.com", email_verified: true }, { cookie: a, link: true });
  assert.equal(linked.location, "/?linked=google");
  assert.deepEqual((await call(env, "/api/me", { cookie: a })).json.methods.sort(), ["google", "password"]);
  const viaGoogle = await social(env, "google", { sub: "g-a", aud: "gid" });
  assert.equal((await call(env, "/api/me", { cookie: viaGoogle.cookie })).json.id, aId);
  const b = await signUp(env, "b@example.com");
  assert.equal((await social(env, "google", { sub: "g-a", aud: "gid" }, { cookie: b, link: true })).location, "/?signin_error=taken_google");
  assert.equal((await social(env, "microsoft", { sub: "m-x", aud: "mid", tid: MS_PERSONAL }, { link: true })).location, "/?signin_error=signin");
});

function mp4Bytes(seconds, width = 1280, height = 720) {
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, "ascii");
    return Buffer.concat([head, body]);
  };
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(width * 65536, 76); tkhd.writeUInt32BE(height * 65536, 80);
  return new Uint8Array(Buffer.concat([box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isommp42")), box("moov", box("mvhd", mvhd), box("trak", box("tkhd", tkhd))), box("mdat", Buffer.alloc(800))]));
}
function wavBytes(seconds, rate = 24000) {
  const samples = Math.round(seconds * rate), h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + samples * 2, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.alloc(samples * 2)]));
}
const jpegBytes = () => { const b = new Uint8Array(3000); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
async function upload(env, cookie, bytes, type = "application/octet-stream") {
  const r = await call(env, "/api/uploads", { method: "POST", cookie, raw: bytes, headers: { "content-type": type } });
  assert.equal(r.status, 200, r.text);
  return r.json;
}
async function paidAccount(env, email = "pro@example.com", credits = 100) {
  const cookie = await signUp(env, email);
  const me = (await call(env, "/api/me", { cookie })).json;
  env.DB.db.exec(`INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('manual_${me.id}', '${me.id}', 0, 0, 'eur', 'paid', 'tester'); UPDATE users SET credits = ${credits} WHERE id = '${me.id}'`);
  return { cookie, id: me.id };
}

test("uploads: video and sound clips are measured by the Worker; unknown files are refused", async () => {
  const env = newEnv();
  const cookie = await signUp(env);
  const v = await upload(env, cookie, mp4Bytes(8.5, 1920, 1080));
  assert.deepEqual({ k: v.kind, d: v.duration, w: v.width, h: v.height }, { k: "video", d: 8.5, w: 1920, h: 1080 });
  const a = await upload(env, cookie, wavBytes(3));
  assert.deepEqual({ k: a.kind, d: a.duration }, { k: "audio", d: 3 });
  assert.equal((await call(env, "/api/uploads", { method: "POST", cookie, raw: new Uint8Array(500).fill(9) })).status, 415);
  const cfg = (await call(env, "/api/config")).json;
  assert.ok(cfg.presets.length >= 20 && cfg.tools.length >= 10);
  assert.deepEqual((await call(env, "/api/me", { cookie })).json.allowedTools, ["face-swap", "outfit-swap", "voice", "music", "sfx"]);
});

test("video with a reference clip and a preset: priced on the clip's seconds, sent as omni reference", async () => {
  const env = newEnv();
  const { cookie, id } = await paidAccount(env);
  const v = await upload(env, cookie, mp4Bytes(8));
  const price = await call(env, "/api/price", { method: "POST", cookie, body: { imageIds: [v.id], settings: { model: "seedance-2.0-fast", duration: 5, resolution: "720p" } } });
  assert.equal(price.json.credits, 5, "max(9, 8 + 5) = 13 s at the reference rate, Fast 720p x1.5");
  const p = fakeProvider(() => ok({ id: "task_r" }));
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "a robot copies the dance of video 1", imageIds: [v.id], preset: "orbit-360", settings: { model: "seedance-2.0-fast", duration: 5, resolution: "720p" } } });
    assert.equal(r.status, 200, r.text);
    const input = p.sent.find((s) => s.url.endsWith("/v1/task/submit")).body.input;
    assert.equal(input.reference_videos.length, 1);
    assert.match(input.prompt, /360-degree orbit/);
    assert.equal(credits(env, id), 95);
  } finally { p.restore(); }
});

test("templates and Motion Control stay locked for an account that never paid, whatever its balance", async () => {
  // 20 October 2026, the owner: free accounts may look and upload, never generate the dear things. Some templates cost
  // under 5 credits at 480p (Fernandez Celebration: 3), so the lock, not the price, is what keeps the gift off them.
  const env = newEnv();
  const cookie = await signUp(env, "farm@example.com");
  const me = (await call(env, "/api/me", { cookie })).json;
  env.DB.db.exec(`UPDATE users SET credits = 100 WHERE id = '${me.id}'`);
  const pic = await upload(env, cookie, jpegBytes(), "image/jpeg");
  const moves = await upload(env, cookie, mp4Bytes(8));
  const trends = (await call(env, "/api/config")).json.tools.filter((t) => t.group === "trend");
  assert.ok(trends.length >= 20, "every template is checked");
  const p = fakeProvider(() => ok({ id: "task_never" }));
  try {
    for (const t of trends) {
      const inputs = Object.fromEntries(t.seats.map((s) => [s.key, pic.id]));
      const r = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: t.key, consent: true, inputs: { ...inputs, quality: "480p" } } });
      assert.equal(r.status, 402, `${t.key}: ${r.text}`);
      assert.equal(r.json.code, "locked", t.key);
    }
    const motion = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "motion-control", inputs: { image: pic.id, video: moves.id } } });
    assert.equal(motion.json.code, "locked");
    assert.equal(p.sent.length, 0, "no provider was asked");
    assert.equal(credits(env, me.id), 100, "nothing was charged");
  } finally { p.restore(); }
});

test("apps: face swap (consent, two pictures), talking photo (speech first, exact price), voiceover, music; locked for free accounts", async () => {
  const env = newEnv();
  const free = await signUp(env, "free@example.com");
  const locked = await call(env, "/api/tools/run", { method: "POST", cookie: free, body: { tool: "motion-control", inputs: {} } });
  assert.equal(locked.status, 400, "the form is checked before the lock: nothing attached");
  const { cookie, id } = await paidAccount(env);
  const t = await upload(env, cookie, jpegBytes(), "image/jpeg"), f = await upload(env, cookie, jpegBytes(), "image/jpeg");
  const jpg = jpegBytes();
  let n = 0;
  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/audio/speech")) return new Response(wavBytes(2.5), { status: 200, headers: { "content-type": "audio/wav" } });
    if (u.endsWith("/v1/task/submit")) return ok({ id: `task_t${++n}` });
    if (/task_t1$/.test(u)) return ok({ status: "completed", outputs: ["https://cdn.example/swap.jpg"] });
    if (/task_t2$/.test(u)) return ok({ status: "completed", outputs: ["https://cdn.example/talk.mp4"] });
    if (/task_t3$/.test(u)) return ok({ status: "completed", outputs: ["https://cdn.example/a.jpeg", "https://cdn.example/a.mp3", "https://cdn.example/b.mp3"] });
    if (u === "https://cdn.example/swap.jpg" || u === "https://cdn.example/a.jpeg") return new Response(jpg, { status: 200 });
    if (u === "https://cdn.example/talk.mp4") return new Response(mp4Bytes(2.5), { status: 200 });
    if (u.endsWith(".mp3")) { const m = new Uint8Array(16000); m.set([0xff, 0xfb, 0x90, 0x00]); return new Response(m, { status: 200 }); }
    return new Response("?", { status: 404 });
  });
  try {
    const noConsent = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "face-swap", inputs: { target: t.id, face: f.id } } });
    assert.equal(noConsent.json.code, "consent");
    const swap = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "face-swap", consent: true, inputs: { target: t.id, face: f.id } } });
    assert.equal(swap.status, 200, swap.text);
    const sub = p.sent.filter((s) => s.url.endsWith("/v1/task/submit"))[0];
    assert.equal(sub.body.model, "gemini-3-pro-image");
    assert.equal(sub.body.input.images.length, 2);
    old(env);
    const swapDone = await call(env, `/api/generations/${swap.json.generation.id}`, { cookie });
    assert.equal(swapDone.json.generation.status, "done", swapDone.text);
    assert.equal(swapDone.json.generation.outputs[0].type, "image");

    const price = await call(env, "/api/tools/price", { method: "POST", cookie, body: { tool: "talking-photo", inputs: { image: t.id, script: "Hello everyone, welcome back!" } } });
    assert.equal(price.json.credits, 1);
    assert.equal(price.json.estimate, true);
    const talk = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "talking-photo", consent: true, inputs: { image: t.id, script: "Hello everyone, welcome back!", voice: "onyx", tone: "excited" } } });
    assert.equal(talk.status, 200, talk.text);
    const tts = p.sent.find((s) => s.url.endsWith("/v1/audio/speech"));
    assert.deepEqual({ v: tts.body.voice, f: tts.body.response_format }, { v: "onyx", f: "wav" });
    const avatar = p.sent.filter((s) => s.url.endsWith("/v1/task/submit"))[1];
    assert.equal(avatar.body.model, "kling_avatar_image2video");
    assert.match(avatar.body.input.sound_file, /^https:\/\/app\.kleo\.test\/media\/raw\/up_.*sig=/, "the spoken clip, by signed link");
    old(env);
    const talkDone = await call(env, `/api/generations/${talk.json.generation.id}`, { cookie });
    assert.equal(talkDone.json.generation.outputs[0].type, "video");

    const voice = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "voice", inputs: { script: "Ciao a tutti!", voice: "nova" } } });
    assert.equal(voice.json.generation.status, "done", "a voiceover is ready at once");
    assert.equal(voice.json.generation.outputs[0].type, "audio");
    assert.equal((await call(env, voice.json.generation.outputs[0].url, { cookie })).status, 200);

    const music = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "music", inputs: { prompt: "lofi beats", vocals: "none" } } });
    old(env);
    const musicDone = await call(env, `/api/generations/${music.json.generation.id}`, { cookie });
    assert.equal(musicDone.json.generation.outputs.length, 2, "both songs, not the cover picture");
    assert.ok(musicDone.json.generation.outputs.every((o) => o.type === "audio"));
    assert.equal(musicDone.json.credits, credits(env, id));
    const list = await call(env, "/api/generations?model=music", { cookie });
    assert.equal(list.json.generations.length, 1);
  } finally { p.restore(); }
});

test("the site behind the app: /mcp is the site's home, other pages keep their address, videos seek, unknown paths 404", async () => {
  const env = newEnv();
  const files = {
    "/mcp/index.html": "<!doctype html><title>Kleo MCP</title>", "/pricing/index.html": "<!doctype html><title>Pricing</title>",
    "/site.css": "body{}", "/404.html": "<!doctype html><title>Not found</title>", "/samples/a.mp4": "0123456789",
  };
  const p = fakeProvider((u) => {
    const path = decodeURIComponent(u.replace("https://raw.githubusercontent.com/tonnooooo/kleo-site/main", ""));
    return files[path] !== undefined ? new Response(files[path], { status: 200, headers: { "content-type": "text/plain", "content-security-policy": "sandbox" } }) : new Response("404", { status: 404 });
  });
  try {
    const home = await call(env, "/mcp");
    assert.equal(home.status, 200);
    assert.match(home.text, /Kleo MCP/);
    assert.match(home.res.headers.get("content-type"), /text\/html/);
    assert.doesNotMatch(home.res.headers.get("content-security-policy"), /sandbox/, "the raw host's sandbox header is not passed on");
    assert.match(home.res.headers.get("content-security-policy"), /fonts\.googleapis\.com/, "the site's own policy instead");
    assert.equal((await call(env, "/pricing/")).text.includes("Pricing"), true);
    const bare = await call(env, "/pricing");
    assert.equal(bare.status, 301);
    assert.match(bare.res.headers.get("location"), /\/pricing\/$/);
    assert.match((await call(env, "/site.css")).res.headers.get("content-type"), /text\/css/);
    const part = await call(env, "/samples/a.mp4", { headers: { range: "bytes=2-5" } });
    assert.equal(part.status, 206);
    assert.equal(part.text, "2345");
    assert.equal(part.res.headers.get("content-range"), "bytes 2-5/10");
    const missing = await call(env, "/nope.html");
    assert.equal(missing.status, 404);
    assert.match(missing.text, /Not found/);
    // Only what a browser needs: no repository tooling, no dot-folders, no Markdown.
    for (const hidden of ["/.github/workflows/publish-x.yml", "/tools/check.py", "/README.md", "/.gitignore", "/a/%2e%2e%2f%2e%2e%2fsecret"]) {
      const before = p.sent.length;
      assert.equal((await call(env, hidden)).status, 404, hidden);
      assert.ok(p.sent.slice(before).every((s) => s.url.endsWith("/404.html")), `${hidden}: only the 404 page was fetched`);
    }
    // The app's own pages are not the site.
    assert.match((await call(env, "/video")).text, /app/);
    assert.match((await call(env, "/")).text, /app/);
  } finally { p.restore(); }
});

test("one host: www and app. redirect to the canonical host once it is set", async () => {
  const env = newEnv({ CANONICAL_HOST: "app.kleo.test" });
  const r = await worker.fetch(new Request("https://www.app.kleo.test/video?x=1"), env, ctx);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://app.kleo.test/video?x=1");
  const same = await worker.fetch(new Request("https://app.kleo.test/health"), env, ctx);
  assert.equal(same.status, 200);
});

test("security: plain HTTP goes to HTTPS; every answer carries HSTS, nosniff, no framing and a CSP that fits it", async () => {
  const env = newEnv();
  const plain = await worker.fetch(new Request("http://app.kleooai.com/video?x=1"), env, ctx);
  assert.equal(plain.status, 301);
  assert.equal(plain.headers.get("location"), "https://app.kleooai.com/video?x=1");
  const p = fakeProvider((u) => u.includes("raw.githubusercontent.com") ? new Response("<!doctype html><title>MCP</title>", { headers: { "content-type": "text/plain" } }) : new Response("?", { status: 404 }));
  try {
    const page = await call(env, "/");
    const site = await call(env, "/mcp");
    const api = await call(env, "/health");
    for (const r of [page, site, api]) {
      assert.match(r.res.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
      assert.equal(r.res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.res.headers.get("x-frame-options"), "DENY");
      assert.match(r.res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'|default-src 'none'/);
    }
    assert.match(page.res.headers.get("content-security-policy"), /script-src 'self' https:\/\/challenges\.cloudflare\.com https:\/\/static\.cloudflareinsights\.com https:\/\/js\.stripe\.com https:\/\/\*\.js\.stripe\.com;/, "the app runs only its own scripts (Turnstile, Cloudflare's analytics and Stripe.js aside)");
    assert.match(site.res.headers.get("content-security-policy"), /fonts\.googleapis\.com/, "site pages get the site's policy");
    assert.match(api.res.headers.get("content-security-policy"), /^default-src 'none'/, "JSON and files can never run as a page");
  } finally { p.restore(); }
});

test("Kleo films in the chat: the agent proposes, the MCP server prices and orders, Studio follows the job and keeps the video", async () => {
  const env = newEnv();
  const { cookie, id } = await paidAccount(env, "film@example.com", 100);
  const orders = [];
  env.MCP = {
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      assert.equal(init.headers.authorization, "Bearer s3cret");
      if (String(url).endsWith("/internal/studio/film/quote")) return new Response(JSON.stringify({ film: { credits: 40, allowed: true, min_s: 15, max_s: 300 }, animatic: { credits: 10, allowed: true, max_s: 60 }, has_paid: true, credits: 100, credits_for_choice: body.product === "animatic" ? 10 : 40 }));
      orders.push(body);
      env.DB.db.exec(`UPDATE users SET credits = credits - 40 WHERE id = '${body.userId}'`);
      env.DB.db.exec(`INSERT INTO jobs (id, user_id, template, prompt, params, state, credits, worker_secret) VALUES ('gt_film1', '${body.userId}', 'film', 'p', '{}', 'queued', 40, 'x')`);
      return new Response(JSON.stringify({ job: { job_id: "gt_film1", credits: 40, eta_min: 30 }, credits_left: 60 }));
    },
  };
  const p = fakeProvider((u) => u.endsWith("/v1/chat/completions")
    ? ok({ choices: [{ message: { content: "Here's your film!", tool_calls: [{ function: { name: "propose_film", arguments: JSON.stringify({ title: "The whale", prompt: "a lighthouse keeper befriends a whale", duration_s: 60, format: "16:9", style: "realistic", product: "film", music: true, subtitles: false, language: "it" }) } }] } }] })
    : new Response("?", { status: 404 }));
  try {
    const chat = await call(env, "/api/chat", { method: "POST", cookie, body: { text: "fammi un film su un guardiano del faro e una balena" } });
    assert.equal(chat.status, 200, chat.text);
    const card = chat.json.messages.find((m) => m.role === "assistant");
    assert.equal(card.proposal.kind, "film");
    assert.equal(card.proposal.credits, 40);
    assert.equal(card.proposal.settings.language, "it");
    const q = await call(env, "/api/film/quote", { method: "POST", cookie, body: { settings: { ...card.proposal.settings, product: "animatic" } } });
    assert.equal(q.json.credits_for_choice, 10);
    const g = await call(env, "/api/generate", { method: "POST", cookie, body: { proposalId: card.id, settings: { subtitles: true } } });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.generation.kind, "film");
    assert.equal(g.json.generation.modelName, "Kleo Film");
    assert.equal(orders[0].prompt, "a lighthouse keeper befriends a whale");
    assert.equal(orders[0].subtitles, true, "the card's edit reaches the order");
    assert.equal(orders[0].language, "it");
    assert.equal(credits(env, id), 60, "the MCP server charged, Studio did not charge again");
    // The job moves on the MCP side; Studio mirrors it.
    env.DB.db.exec("UPDATE jobs SET state = 'rendering', percent = 42, track = 'clips', eta_min = 12 WHERE id = 'gt_film1'");
    old(env);
    const mid = await call(env, `/api/generations/${g.json.generation.id}`, { cookie });
    assert.deepEqual({ p: mid.json.generation.progress.percent, l: mid.json.generation.progress.label }, { p: 42, l: "Filming the scenes" });
    await env.RENDERS.put("renders/gt_film1/video.mp4", new Uint8Array(4000).fill(1), { httpMetadata: { contentType: "video/mp4" } });
    env.DB.db.exec("INSERT INTO job_files (job_id, name, key, size, content_type) VALUES ('gt_film1', 'video.mp4', 'renders/gt_film1/video.mp4', 4000, 'video/mp4')");
    env.DB.db.exec("UPDATE jobs SET state = 'done', percent = 100 WHERE id = 'gt_film1'");
    old(env);
    const done = await call(env, `/api/generations/${g.json.generation.id}`, { cookie });
    assert.equal(done.json.generation.status, "done", done.text);
    const video = await call(env, done.json.generation.video, { cookie });
    assert.equal(video.status, 200);
    assert.equal(video.text.length, 4000);
    assert.ok(env.RENDERS.m.has(`studio/${id}/${g.json.generation.id}.mp4`), "a copy that outlives the MCP server's 7 days");
  } finally { p.restore(); }
});

test("a film the MCP server failed is shown failed and refunded there, never refunded twice by Studio", async () => {
  const env = newEnv();
  const { cookie, id } = await paidAccount(env, "film2@example.com", 100);
  env.MCP = { fetch: async (url) => String(url).endsWith("/quote")
    ? new Response(JSON.stringify({ film: { credits: 20, allowed: true }, animatic: { credits: 10, allowed: true }, has_paid: true, credits: 100, credits_for_choice: 20 }))
    : (env.DB.db.exec(`INSERT INTO jobs (id, user_id, template, prompt, params, state, credits, worker_secret) VALUES ('gt_film2', '${id}', 'film', 'p', '{}', 'queued', 20, 'x')`), new Response(JSON.stringify({ job: { job_id: "gt_film2", credits: 20, eta_min: 30 } }))) };
  const p = fakeProvider((u) => u.endsWith("/v1/chat/completions") ? ok({ choices: [{ message: { content: "ok", tool_calls: [{ function: { name: "propose_film", arguments: JSON.stringify({ title: "x", prompt: "a short film about bees", duration_s: 30 }) } }] } }] }) : new Response("?", { status: 404 }));
  try {
    const chat = await call(env, "/api/chat", { method: "POST", cookie, body: { text: "a film about bees" } });
    const card = chat.json.messages.find((m) => m.role === "assistant");
    const g = await call(env, "/api/generate", { method: "POST", cookie, body: { proposalId: card.id } });
    env.DB.db.exec("UPDATE jobs SET state = 'failed' WHERE id = 'gt_film2'");
    old(env);
    const f = await call(env, `/api/generations/${g.json.generation.id}`, { cookie });
    assert.equal(f.json.generation.status, "failed");
    assert.equal(credits(env, id), 100, "Studio charged nothing and refunded nothing (the MCP server does both)");
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'credits.refund'").get().n, 0);
  } finally { p.restore(); }
});

test("free credits draw on their own daily pool; speech is never made for an account that cannot pay; uploads have a daily allowance", async () => {
  const env = newEnv({ STUDIO_FREE_DAILY_BUDGET_USD: "0.01", STUDIO_UPLOADS_PER_DAY: "2" });
  const free = await signUp(env, "free2@example.com");
  const p = fakeProvider((u) => u.endsWith("/v1/audio/speech") ? new Response(wavBytes(1), { status: 200 }) : ok({ id: "task_free" }));
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie: free, body: { prompt: "a cat", settings: { model: "seedance-2.0-fast", duration: 5 } } });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "free_capacity", "the free pool is full; paying customers are not affected");
    const { cookie: paid } = await paidAccount(env, "payer@example.com", 50);
    const ok2 = await call(env, "/api/generate", { method: "POST", cookie: paid, body: { prompt: "a cat", settings: { model: "seedance-2.0-fast", duration: 5 } } });
    assert.equal(ok2.status, 200, ok2.text);
    // An account with no credits asks for a voiceover: refused BEFORE any speech is made.
    env.DB.db.exec("UPDATE users SET credits = 0 WHERE email = 'free2@example.com'");
    const before = p.sent.filter((s) => s.url.endsWith("/v1/audio/speech")).length;
    const voice = await call(env, "/api/tools/run", { method: "POST", cookie: free, body: { tool: "voice", inputs: { script: "Hello there, this is a long enough script to cost something.", voice: "nova" } } });
    assert.notEqual(voice.status, 200);
    assert.equal(p.sent.filter((s) => s.url.endsWith("/v1/audio/speech")).length, before, "no speech was bought");
  } finally { p.restore(); }
  // Pictures and speech Kleo made for the account are upload rows too (outside its up/ prefix): they do not count.
  const freeId = (await call(env, "/api/me", { cookie: free })).json.id;
  for (const [i, key] of [`studio/${freeId}/g_made0000001/0.jpg`, `studio/${freeId}/g_made0000001/1.jpg`, `studio/${freeId}/speech/up_spoken000001.wav`].entries()) {
    env.DB.db.prepare("INSERT INTO studio_uploads (id, user_id, key, content_type, size) VALUES (?, ?, ?, 'image/jpeg', 1000)").run(`up_made${i}`, freeId, key);
  }
  await upload(env, free, jpegBytes(), "image/jpeg");
  await upload(env, free, jpegBytes(), "image/jpeg");
  const third = await call(env, "/api/uploads", { method: "POST", cookie: free, raw: jpegBytes(), headers: { "content-type": "image/jpeg" } });
  assert.equal(third.status, 429);
  assert.equal(third.json.code, "uploads");
});

test("speech refused after it was made is deleted and counted; past five a day no more is made", async () => {
  const env = newEnv();
  const { cookie, id } = await paidAccount(env, "talker@example.com", 50);
  const t = await upload(env, cookie, jpegBytes(), "image/jpeg");
  // The voice runs past a minute although the words were estimated under it (slow, with pauses): refused once timed.
  const p = fakeProvider((u) => u.endsWith("/v1/audio/speech") ? new Response(wavBytes(70), { status: 200 }) : ok({ id: "task_x" }));
  const speeches = () => p.sent.filter((s) => s.url.endsWith("/v1/audio/speech")).length;
  const run = () => call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "talking-photo", consent: true, inputs: { image: t.id, script: "Hello... everyone... welcome... back!" } } });
  try {
    for (let i = 1; i <= 5; i++) {
      const r = await run();
      assert.equal(r.status, 400, r.text);
      assert.match(r.json.error, /more than a minute of speech/);
      assert.equal(speeches(), i);
    }
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM studio_uploads WHERE user_id = ? AND kind = 'audio'").get(id).n, 0, "no orphan clip is kept");
    assert.equal([...env.RENDERS.m.keys()].filter((k) => k.includes("/speech/")).length, 0, "the refused speech files are deleted too");
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE user_id = ? AND event = 'studio.speech_refused'").get(id).n, 5);
    const sixth = await run();
    assert.equal(sixth.status, 429);
    assert.equal(sixth.json.code, "speech_limit");
    assert.equal(speeches(), 5, "no sixth voice was bought");
    assert.equal(credits(env, id), 50, "nothing was charged at any point");
  } finally { p.restore(); }
});

test("account page: a name, the activity, a password change that ends other sessions, and deleting the account for good", async () => {
  const env = newEnv();
  const cookie = await signUp(env, "acct@example.com");
  const me = (await call(env, "/api/me", { cookie })).json;
  assert.equal((await call(env, "/api/me/profile", { method: "POST", cookie, body: { name: "  Ada   Lovelace " } })).json.name, "Ada Lovelace");
  assert.equal((await call(env, "/api/me", { cookie })).json.name, "Ada Lovelace");
  env.DB.db.exec(`INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('cs_a1', '${me.id}', 10, 500, 'eur', 'paid', 'x')`);
  const act = (await call(env, "/api/me/activity", { cookie })).json;
  assert.deepEqual(act.purchases.map((p) => [p.credits, p.amount_cent]), [[10, 500]]);
  assert.ok(Array.isArray(act.usage));
  // Password change: the current one is required; other sessions end, this browser gets a fresh one.
  const other = cookieOf(await call(env, "/api/auth/signin", { method: "POST", body: { email: "acct@example.com", password: "long enough pw" } }));
  assert.equal((await call(env, "/api/auth/password/change", { method: "POST", cookie, body: { current: "nope nope", password: "brand new pass" } })).status, 401);
  const changed = await call(env, "/api/auth/password/change", { method: "POST", cookie, body: { current: "long enough pw", password: "brand new pass" } });
  assert.equal(changed.status, 200, changed.text);
  assert.equal((await call(env, "/api/me", { cookie: other })).status, 401, "the other device is signed out");
  const fresh = cookieOf(changed);
  assert.equal((await call(env, "/api/me", { cookie: fresh })).status, 200, "this browser stays in");
  // Delete the account: type DELETE; files, rows and sign-in go, the payment record stays.
  await env.RENDERS.put(`studio/${me.id}/up/up_x.jpg`, new Uint8Array(10));
  assert.equal((await call(env, "/api/me/delete", { method: "POST", cookie: fresh, body: { confirm: "yes" } })).status, 400);
  const gone = await call(env, "/api/me/delete", { method: "POST", cookie: fresh, body: { confirm: "delete" } });
  assert.equal(gone.status, 200, gone.text);
  assert.ok(![...env.RENDERS.m.keys()].some((k) => k.startsWith(`studio/${me.id}/`)), "every file is gone");
  assert.equal((await call(env, "/api/me", { cookie: fresh })).status, 401);
  assert.equal((await call(env, "/api/auth/signin", { method: "POST", body: { email: "acct@example.com", password: "brand new pass" } })).status, 401);
  const row = env.DB.db.prepare("SELECT email, credits, display_name FROM users WHERE id = ?").get(me.id);
  assert.deepEqual([row.email, row.credits, row.display_name], [`${me.id}@deleted.kleo.invalid`, 0, null]);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ?").get(me.id).n, 1, "the books keep the payment");
});

test("Enhance: Kleo's adapt rules on a fast model, the clip's length and shape in the brief, a failure said out loud; the agent sends no sampling parameters", async () => {
  const env = newEnv();
  const cookie = await signUp(env, "enh@example.com");
  const p = fakeProvider((u) => u.endsWith("/v1/chat/completions")
    ? ok({ choices: [{ message: { content: "\"A red race car leaves the pit lane at dusk, low tracking shot, sodium light, engine roar.\"" } }] })
    : new Response("?", { status: 404 }));
  try {
    const r = await call(env, "/api/enhance", { method: "POST", cookie, body: { kind: "video", prompt: "una corsa automobilistica", seconds: 5, aspect: "9:16", model: "Seedance 2.0 Fast" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.prompt, "A red race car leaves the pit lane at dusk, low tracking shot, sodium light, engine roar.");
    const sent = p.sent.find((s) => s.url.endsWith("/v1/chat/completions")).body;
    assert.equal(sent.model, "gpt-4.1-mini");
    assert.equal(sent.temperature, undefined);
    assert.match(sent.messages[0].content, /FIDELITY/);
    assert.match(sent.messages[0].content, /5 seconds, 9:16/);
    const music = await call(env, "/api/enhance", { method: "POST", cookie, body: { kind: "music", prompt: "lofi" } });
    assert.equal(music.status, 200);
    assert.match(p.sent.at(-1).body.messages[0].content, /MUSIC model/);
  } finally { p.restore(); }
  const down = fakeProvider(() => new Response("nope", { status: 500 }));
  try {
    const r = await call(env, "/api/enhance", { method: "POST", cookie, body: { kind: "image", prompt: "a cat" } });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "enhance");
  } finally { down.restore(); }
  // The chat agent: Claude 5 on ePhone refuses temperature, so the call carries none.
  const q = fakeProvider((u) => u.endsWith("/v1/chat/completions") ? ok({ choices: [{ message: { content: "Hi!" } }] }) : new Response("?", { status: 404 }));
  try {
    await call(env, "/api/chat", { method: "POST", cookie, body: { text: "ciao" } });
    const agentCall = q.sent.find((s) => s.url.endsWith("/v1/chat/completions"));
    assert.ok(agentCall, "the agent was called");
    assert.equal(agentCall.body.temperature, undefined);
  } finally { q.restore(); }
});

test("the app shell is served for any page path", async () => {
  const env = newEnv();
  const r = await call(env, "/c/c_whatever");
  assert.equal(r.status, 200);
  assert.match(r.text, /app/);
});

test("one gift per person: per connection, per browser, never to Tor or a server farm; one inbox; no throwaway mail; a farm of accounts is blocked", async () => {
  const env = newEnv();
  const join = (email, headers = {}, cf) => call(env, "/api/auth/signup", { method: "POST", body: { email, password: "long enough pw" }, headers, cf });
  const home = { "cf-connecting-ip": "203.0.113.20" };
  const first = await join("ana@example.com", home);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.gift, 5);
  assert.match(first.res.headers.get("set-cookie"), /__Host-kleo_gift=1;.*HttpOnly/);
  // Same connection, a new account: it opens, at zero, and the page says why.
  const second = await join("bea@example.com", home);
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.gift, 0);
  assert.match(second.json.note, /one per person/);
  assert.doesNotMatch(second.res.headers.get("set-cookie"), /kleo_gift/);
  assert.equal((await call(env, "/api/me", { cookie: cookieOf(second) })).json.credits, 0);
  // A browser that already had the gift, from another connection.
  assert.equal((await join("cy@example.com", { "cf-connecting-ip": "198.51.100.30", cookie: "__Host-kleo_gift=1" })).json.gift, 0);
  // Tor, and a server farm (VPNs and scripts live there); a home or phone network gets it.
  assert.equal((await join("dee@example.com", { "cf-connecting-ip": "198.51.100.31", "cf-ipcountry": "T1" })).json.gift, 0);
  assert.equal((await join("eve@example.com", { "cf-connecting-ip": "198.51.100.32" }, { asn: 14061, asOrganization: "DigitalOcean, LLC" })).json.gift, 0);
  assert.equal((await join("fay@example.com", { "cf-connecting-ip": "198.51.100.33" }, { asn: 65000, asOrganization: "Example Rented Servers Hosting" })).json.gift, 0);
  assert.equal((await join("gia@example.com", { "cf-connecting-ip": "198.51.100.34" }, { asn: 1136, asOrganization: "KPN B.V." })).json.gift, 5);
  assert.equal((await join("hal@example.com", { "cf-connecting-ip": "198.51.100.35" }, { asn: 13335, asOrganization: "Cloudflare, Inc." })).json.gift, 5, "WARP and iCloud Private Relay are people");
  // One inbox, one account: Gmail ignores dots and "+tags", and googlemail.com is gmail.com.
  assert.equal((await join("john.smith@gmail.com", { "cf-connecting-ip": "198.51.100.40" })).status, 200);
  const alias = await join("johnsmith+kleo@googlemail.com", { "cf-connecting-ip": "198.51.100.41" });
  assert.equal(alias.status, 409);
  assert.equal(alias.json.code, "exists");
  // Throwaway mailboxes and domains that cannot receive mail are refused.
  assert.equal((await join("zed@mailinator.com", { "cf-connecting-ip": "198.51.100.42" })).json.code, "email_domain");
  assert.equal((await join("zed@nomail.example", { "cf-connecting-ip": "198.51.100.43" })).json.code, "email_domain");
  // A farm: the third account of one address still opens, the fourth is refused and the address is blocked.
  assert.equal((await join("ida@example.com", home)).status, 200);
  const farm = await join("jo@example.com", home);
  assert.equal(farm.status, 403);
  assert.equal(farm.json.code, "address_blocked");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM blocked_addresses").get().n, 1);
  assert.equal((await join("kim@example.com", home)).json.code, "address_blocked", "and it stays blocked");
  // The never-paid accounts of a blocked address stop generating for free; nothing is charged.
  const r = await call(env, "/api/generate", { method: "POST", cookie: cookieOf(first), body: { prompt: "a fox", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } } });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, "address_blocked");
  assert.equal((await call(env, "/api/me", { cookie: cookieOf(first) })).json.credits, 5);
});

test("free generations: the never-paid accounts of one address share one small daily allowance", async () => {
  const env = newEnv({ STUDIO_FREE_PER_ADDRESS_DAY_USD: "0.0001" });
  const a = await call(env, "/api/auth/signup", { method: "POST", body: { email: "lia@example.com", password: "long enough pw" }, headers: { "cf-connecting-ip": "203.0.113.50" } });
  const r = await call(env, "/api/generate", { method: "POST", cookie: cookieOf(a), body: { prompt: "a fox", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } } });
  assert.equal(r.status, 429, r.text);
  assert.equal(r.json.code, "free_address");
  assert.equal((await call(env, "/api/me", { cookie: cookieOf(a) })).json.credits, 5, "nothing was charged");
});

test("once Google sign-in is on, new accounts are opened with Google only; e-mail accounts still sign in", async () => {
  const env = newEnv({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs" });
  assert.equal((await call(env, "/api/config")).json.signup, "google");
  const refused = await call(env, "/api/auth/signup", { method: "POST", body: { email: "max@example.com", password: "long enough pw" } });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "use_google");
  // An e-mail account made before keeps working.
  const open = newEnv({ STUDIO_SIGNUP: "all" });
  assert.equal((await call(open, "/api/config")).json.signup, "all");
  // Without Google configured nobody is locked out: e-mail sign-up stays.
  assert.equal((await call(newEnv(), "/api/config")).json.signup, "all");
  const g = await social(env, "google", { sub: "g-new", aud: "gid", email: "new@gmail.com", email_verified: true });
  assert.equal(g.location, "/");
  assert.equal((await call(env, "/api/me", { cookie: g.cookie })).json.credits, 5);
});

test("free credits make 480p: 720p and 1080p are locked until the first pack, and the agent proposes 480p", async () => {
  const env = newEnv();
  const cookie = await signUp(env);
  const me = (await call(env, "/api/me", { cookie })).json;
  assert.deepEqual(me.freeResolutions, ["480p"]);
  const locked = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "a fox", settings: { model: "seedance-2.0-fast", resolution: "720p", duration: 5 } } });
  assert.equal(locked.status, 402, locked.text);
  assert.equal(locked.json.code, "locked");
  assert.match(locked.json.error, /720p unlocks with your first credit pack\. Free credits make 480p videos\./);
  assert.equal(credits(env, me.id), 5, "nothing was charged");
  // A paid account has every resolution.
  const paid = await paidAccount(env);
  assert.equal((await call(env, "/api/me", { cookie: paid.cookie })).json.freeResolutions, null);
});

test("any language in, English to the model: a prompt that is not English is translated, quotes kept; English goes straight through", () => {
  for (const t of ["A paper boat sails down a rainy street at dusk", "a cat in the rain", "Close up of a man walking, slow motion"]) assert.equal(accounts.looksEnglish(t), true, t);
  for (const t of ["Un gatto nero cammina sotto la pioggia a Venezia", "gatto nero", "Девушка танцует на крыше", "Un vieux pêcheur répare son filet sur un quai",
    "Un perro corre por la playa al atardecer", "Ein Hund läuft am Strand", "一只猫在雨中行走"]) assert.equal(accounts.looksEnglish(t), false, t);
  // Words in quotes are what someone says: their language does not decide.
  assert.equal(accounts.looksEnglish('A woman in a red coat turns to the camera and says "Che freddo stasera!"'), true);
});

test("a video typed in Italian reaches the model in English; the card keeps the Italian; a preset is added after", async () => {
  const env = newEnv();
  const cookie = await signUp(env);
  const p = fakeProvider((u, init) => {
    if (u.endsWith("/v1/chat/completions")) return ok({ choices: [{ message: { content: 'A black cat walks in the rain in Venice. It says: "Che freddo!"' } }] });
    if (u.endsWith("/v1/task/submit")) return ok({ id: "task_tr" });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: 'Un gatto nero cammina sotto la pioggia a Venezia. Dice: "Che freddo!"', preset: "crash-zoom", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } } });
    assert.equal(r.status, 200, r.text);
    const chat = p.sent.find((s) => s.url.endsWith("/v1/chat/completions"));
    assert.ok(chat, "the Italian prompt was translated");
    assert.match(chat.body.messages[0].content, /stay exactly as written/);
    const sent = p.sent.find((s) => s.url.endsWith("/v1/task/submit")).body.input.prompt;
    assert.match(sent, /^A black cat walks in the rain in Venice\. It says: "Che freddo!"/);
    assert.match(sent, /crash zoom/);
    assert.match(r.json.generation.prompt, /^Un gatto nero/, "the card shows the person's own words");
    // English goes straight through: no translation call.
    const before = p.sent.filter((s) => s.url.endsWith("/v1/chat/completions")).length;
    assert.equal((await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "a fox in the snow", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } } })).status, 200);
    assert.equal(p.sent.filter((s) => s.url.endsWith("/v1/chat/completions")).length, before);
  } finally { p.restore(); }
});


test("every camera, effect and style preset comes with its example picture", async () => {
  const presets = (await call(newEnv(), "/api/config")).json.presets;
  assert.equal(presets.length, 24);
  for (const p of presets) assert.equal(p.art, `https://media.kleooai.com/app/presets/${p.key}.jpg?v=1`, p.key);
});

test("a paused picture model is shown as paused, takes no order and charges nothing; the default moves to one that works", async () => {
  const env = newEnv({ STUDIO_PAUSED_IMAGE_MODELS: "nano-banana-2,nano-banana-pro" });
  const cfg = (await call(env, "/api/config")).json;
  assert.equal(cfg.defaultImageModel, "flux-2-pro");
  assert.deepEqual(cfg.imageModels.filter((m) => m.paused).map((m) => m.key).sort(), ["nano-banana-2", "nano-banana-pro"]);
  const cookie = await signUp(env);
  const me = (await call(env, "/api/me", { cookie })).json;
  assert.ok(!me.allowedImages.includes("nano-banana-2"));
  const r = await call(env, "/api/generate", { method: "POST", cookie, body: { kind: "image", prompt: "a red apple", settings: { model: "nano-banana-2", aspect: "1:1", quality: "1K", count: 1 } } });
  assert.equal(r.status, 503, r.text);
  assert.equal(r.json.code, "paused");
  assert.equal(credits(env, me.id), 5, "nothing was charged");
});


test("the owner's admin account: every model at any resolution, no budget, and its spend never fills the day for customers", async () => {
  const env = newEnv({ STUDIO_DAILY_BUDGET_USD: "1" });
  const cookie = await signUp(env, "owner@example.com");
  const me = (await call(env, "/api/me", { cookie })).json;
  env.STUDIO_ADMINS = me.id;
  env.DB.db.exec(`UPDATE users SET credits = 1000000 WHERE id = '${me.id}'`); // as in production: a balance that cannot run out
  const again = (await call(env, "/api/me", { cookie })).json;
  assert.equal(again.admin, true);
  assert.equal(again.paid, true);
  assert.equal(again.freeResolutions, null);
  const p = fakeProvider(() => ok({ id: "task_admin" }));
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "a fox", settings: { model: "seedance-2.5", resolution: "1080p", duration: 5 } } });
    assert.equal(r.status, 200, r.text);
  } finally { p.restore(); }
  // A customer's order is not blocked by the admin's spend.
  const other = await signUp(env, "customer@example.com");
  const q = fakeProvider(() => ok({ id: "task_c" }));
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie: other, body: { prompt: "a cat", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } } });
    assert.equal(r.status, 200, `the admin's ~2.40 $ is not counted in the 1 $ day: ${r.text}`);
  } finally { q.restore(); }
});

test("Character Swap runs in two steps: the redrawn first frame, then the video edited from it", async () => {
  const env = newEnv();
  const { cookie } = await paidAccount(env);
  const v = await upload(env, cookie, mp4Bytes(5, 1080, 1920));
  const c = await upload(env, cookie, jpegBytes());
  const f = await upload(env, cookie, jpegBytes());
  let n = 0;
  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/task/submit")) return ok({ id: `task_s${++n}` });
    if (/task_s1$/.test(u)) return ok({ status: "completed", outputs: ["https://cdn.example/frame.jpeg"] });
    if (/task_s2$/.test(u)) return ok({ status: "completed", outputs: ["https://cdn.example/swap.mp4"] });
    if (u === "https://cdn.example/swap.mp4") return new Response(mp4Bytes(5, 1080, 1920), { status: 200 });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "character-swap", consent: true, inputs: { video: v.id, image: c.id, frame: f.id } } });
    assert.equal(r.status, 200, r.text);
    const subs = () => p.sent.filter((s) => s.url.endsWith("/v1/task/submit"));
    assert.equal(subs().length, 1, "only the first step goes out at once");
    assert.equal(subs()[0].body.model, "flux-2-pro");
    old(env);
    const mid = await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
    assert.equal(mid.json.generation.status, "running", "the frame is ready, the video is on its way");
    assert.equal(subs().length, 2);
    assert.equal(subs()[1].body.model, "kling-o1/omni-video");
    assert.deepEqual(subs()[1].body.input.contents.filter((c) => c.type === "refer_image")[0].url, "https://cdn.example/frame.jpeg", "the redrawn frame is Kling's reference");
    old(env);
    const done = await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
    assert.equal(done.json.generation.status, "done", done.text);
    assert.equal(done.json.generation.outputs[0].type, "video");
  } finally { p.restore(); }
});


// ── Backups (20 October 2026): ePhone out of credit, the order moves to APIMart where it costs the same or less ──────
const EMPTY = () => new Response(JSON.stringify({ error: { code: "insufficient_user_quota", message: "预扣费额度失败, 用户剩余额度: $0.000000" } }), { status: 403 });

test("ePhone out of credit: a Seedance 2.0 Fast clip is made on APIMart for the same credits, polled and saved there", async () => {
  const env = newEnv({ APIMART_API_KEY: "ak" });
  const cookie = await signUp(env);
  const me = (await call(env, "/api/me", { cookie })).json;
  const p = fakeProvider((u) => {
    if (u.startsWith("https://api.ephone.ai/")) return EMPTY();
    if (u === "https://api.apimart.ai/v1/videos/generations") return ok({ code: 200, data: [{ status: "submitted", task_id: "task_am1" }] });
    if (u === "https://api.apimart.ai/v1/tasks/task_am1") return ok({ code: 200, data: { id: "task_am1", status: "completed", cost: 0.2, result: { videos: [{ url: ["https://upload.apimart.ai/f/video/out.mp4"] }] } } });
    if (u === "https://upload.apimart.ai/f/video/out.mp4") return new Response(new Uint8Array(5000).fill(7), { status: 200, headers: { "content-type": "video/mp4" } });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "a fox in the snow", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5, aspect: "9:16" } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.generation.status, "running", r.json.generation.error);
    assert.equal(credits(env, me.id), 3, "the same 2 credits as on ePhone");
    const am = p.sent.find((s) => s.url === "https://api.apimart.ai/v1/videos/generations");
    assert.deepEqual(am.body, { model: "seedance-2.0-fast", prompt: "a fox in the snow", duration: 5, resolution: "480p", size: "9:16", generate_audio: true });
    assert.equal(am.headers.authorization, "Bearer ak");
    const row = env.DB.db.prepare("SELECT task_id FROM studio_generations WHERE id = ?").get(r.json.generation.id);
    assert.equal(row.task_id, "apimart:task_am1");
    const moved = env.DB.db.prepare("SELECT detail FROM audit WHERE event = 'studio.backup' AND job_id = ?").get(r.json.generation.id);
    assert.match(moved.detail, /apimart:seedance-2\.0-fast/);
    old(env);
    const done = await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
    assert.equal(done.json.generation.status, "done", done.text);
    assert.equal((await call(env, `/media/${r.json.generation.id}.mp4`, { cookie })).text.length, 5000);
    assert.ok(!p.sent.some((s) => s.url.includes("ephone.ai/v1/task/task_am1")), "never asked ePhone about APIMart's task");
    assert.equal(credits(env, me.id), 3);
  } finally { p.restore(); }
});

test("ePhone out of credit: a model that costs more elsewhere stays on ePhone and is refunded; no key, no backup; a refusal never moves", async () => {
  const env = newEnv({ APIMART_API_KEY: "ak" });
  const { cookie, id } = await paidAccount(env);
  const p = fakeProvider((u) => (u.startsWith("https://api.ephone.ai/") ? EMPTY() : ok({ code: 200, data: [{ task_id: "nope" }] })));
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "x", settings: { model: "seedance-2.5", resolution: "720p" } } });
    assert.equal(r.json.generation.status, "failed");
    assert.match(r.json.generation.error, /recharged/);
    assert.ok(!p.sent.some((s) => s.url.includes("apimart")), "Seedance 2.5 is dearer on APIMart: never sent there");
    assert.equal(credits(env, id), 100);
  } finally { p.restore(); }
  // Without an APIMart key the old behaviour holds.
  const bare = newEnv();
  const c2 = await signUp(bare);
  const p2 = fakeProvider((u) => (u.startsWith("https://api.ephone.ai/") ? EMPTY() : new Response("?", { status: 404 })));
  try {
    const r = await call(bare, "/api/generate", { method: "POST", cookie: c2, body: { prompt: "x", settings: { model: "seedance-2.0-fast", resolution: "480p" } } });
    assert.match(r.json.generation.error, /recharged/);
    assert.ok(!p2.sent.some((s) => s.url.includes("apimart")));
  } finally { p2.restore(); }
  // A refusal of the request itself stays a refusal.
  const env3 = newEnv({ APIMART_API_KEY: "ak" });
  const c3 = await signUp(env3);
  const p3 = fakeProvider((u) => (u.startsWith("https://api.ephone.ai/") ? new Response(JSON.stringify({ error: { message: "prompt violates policy" } }), { status: 400 }) : ok({ code: 200, data: [{ task_id: "t" }] })));
  try {
    const r = await call(env3, "/api/generate", { method: "POST", cookie: c3, body: { prompt: "x", settings: { model: "seedance-2.0-fast", resolution: "480p" } } });
    assert.equal(r.json.generation.status, "failed");
    assert.ok(!p3.sent.some((s) => s.url.includes("apimart")));
  } finally { p3.restore(); }
});

test("ePhone out of credit: a Nano Banana 2 picture is made on APIMart's ext route; a song on APIMart's Suno", async () => {
  const env = newEnv({ APIMART_API_KEY: "ak" });
  const cookie = await signUp(env);
  const png = new Uint8Array(4000); png.set([0x89, 0x50, 0x4e, 0x47]);
  const mp3 = new Uint8Array(4000); mp3.set([0x49, 0x44, 0x33]);
  const p = fakeProvider((u) => {
    if (u.startsWith("https://api.ephone.ai/")) return EMPTY();
    if (u === "https://api.apimart.ai/v1/images/generations") return ok({ code: 200, data: [{ status: "submitted", task_id: "task_img" }] });
    if (u === "https://api.apimart.ai/v1/tasks/task_img") return ok({ code: 200, data: { status: "completed", result: { images: [{ url: ["https://upload.apimart.ai/f/image/a.png"], expires_at: 1 }] } } });
    if (u === "https://upload.apimart.ai/f/image/a.png") return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    if (u === "https://api.apimart.ai/v1/music/generations") return ok({ code: 200, data: [{ status: "submitted", task_id: "task_song" }] });
    if (u === "https://api.apimart.ai/v1/music/tasks/task_song") return ok({ code: 200, data: { status: "completed", result: { music: [{ audio_url: "https://cdn.apimart.ai/s1.mp3", image_url: "https://cdn.apimart.ai/s1.jpg" }, { audio_url: "https://cdn.apimart.ai/s2.mp3" }] } } });
    if (u.startsWith("https://cdn.apimart.ai/s")) return new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg" } });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { kind: "image", prompt: "a fox in a hat", settings: { model: "nano-banana-2", aspect: "4:5", quality: "2K" } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.generation.status, "running", r.json.generation.error);
    const am = p.sent.find((s) => s.url === "https://api.apimart.ai/v1/images/generations");
    assert.deepEqual(am.body, { model: "gemini-3.1-flash-image-preview", prompt: "a fox in a hat", size: "4:5", resolution: "2K", n: 1, official_fallback: false });
    old(env);
    const done = await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
    assert.equal(done.json.generation.status, "done", done.text);
    assert.equal(done.json.generation.outputs.length, 1);

    const song = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "music", inputs: { prompt: "upbeat pop for a birthday", vocals: "none" } } });
    assert.equal(song.status, 200, song.text);
    const sent = p.sent.find((s) => s.url === "https://api.apimart.ai/v1/music/generations");
    assert.deepEqual(sent.body, { model: "suno", custom: false, version: "v6", prompt: "upbeat pop for a birthday", instrumental: true });
    old(env);
    const made = await call(env, `/api/generations/${song.json.generation.id}`, { cookie });
    assert.equal(made.json.generation.status, "done", made.text);
    assert.deepEqual(made.json.generation.outputs.map((o) => o.type), ["audio", "audio"], "two songs, no cover picture");
  } finally { p.restore(); }
});

// ── Wan 3.0 after a copyright refusal (20 October 2026) ─────────────────────────────────────────────────────────────
const COPYRIGHT = "The request failed because the output video may be related to copyright restrictions. Request id: 0217923817194550";
const mp4Reply = () => new Response(new Uint8Array(5000).fill(7), { status: 200, headers: { "content-type": "video/mp4" } });

test("a Seedance copyright refusal offers Wan 3.0: the same credits, everything the clip asked for, taken once", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "wk" });
  const { cookie, id } = await paidAccount(env);
  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/task/submit")) return ok({ id: "task_cr" });
    if (/\/v1\/task\/task_cr$/.test(u)) return ok({ status: "failed", error: COPYRIGHT });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/text-to-video") return ok({ code: 200, data: { id: "ws_1", status: "created" } });
    if (u === "https://api.wavespeed.ai/api/v3/predictions/ws_1/result") return ok({ code: 200, data: { id: "ws_1", status: "completed", outputs: ["https://cdn.wavespeed.test/out.mp4"] } });
    if (u === "https://cdn.wavespeed.test/out.mp4") return mp4Reply();
    return new Response("?", { status: 404 });
  });
  try {
    const prompt = "Rumi, Mira and Zoey from KPop Demon Hunters sing on a neon stage";
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt, settings: { model: "seedance-2.5", resolution: "720p", duration: 10, aspect: "21:9", audio: false } } });
    assert.equal(r.status, 200, r.text);
    const paid = r.json.generation.credits;
    old(env);
    const g = (await call(env, `/api/generations/${r.json.generation.id}`, { cookie })).json.generation;
    assert.equal(g.status, "failed");
    assert.deepEqual(g.offer, { model: "wan-3.0", name: "Wan 3.0", from: "Seedance 2.5", credits: paid });
    assert.match(g.error, /^Seedance 2\.5 won't make this one: it recognised characters/);
    assert.equal(credits(env, id), 100, "the refusal gave the credits back");

    const w = await call(env, `/api/generations/${g.id}/wan`, { method: "POST", cookie, body: {} });
    assert.equal(w.status, 200, w.text);
    assert.deepEqual({ m: w.json.generation.model, n: w.json.generation.modelName, s: w.json.generation.status }, { m: "wan-3.0", n: "Wan 3.0", s: "running" });
    assert.equal(w.json.credits, 100 - paid, "charged the credits the refused clip cost");
    assert.equal(w.json.original.offer, null);
    assert.match(w.json.original.error, /you sent it to Wan 3\.0\.$/);
    const sent = p.sent.filter((s) => s.url.startsWith("https://api.wavespeed.ai/api/v3/alibaba/"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/text-to-video");
    assert.deepEqual(sent[0].body, { prompt, duration: 10, resolution: "720p", generate_audio: false, aspect_ratio: "16:9" }, "21:9 becomes Wan's nearest shape");
    assert.equal(sent[0].headers.authorization, "Bearer wk");
    assert.ok(!p.sent.some((s) => /spicy/.test(s.url)), "never a -spicy route");
    const row = env.DB.db.prepare("SELECT task_id, est_usd, model FROM studio_generations WHERE id = ?").get(w.json.generation.id);
    assert.deepEqual({ ...row }, { task_id: "wavespeed:ws_1", est_usd: 0.95, model: "wan-3.0" });
    assert.ok(env.DB.db.prepare("SELECT 1 FROM audit WHERE event = 'studio.wan_retry' AND job_id = ?").get(g.id), "the switch is in the audit");

    const again = await call(env, `/api/generations/${g.id}/wan`, { method: "POST", cookie, body: {} });
    assert.equal(again.status, 409);
    assert.equal(credits(env, id), 100 - paid, "a second tap starts nothing and charges nothing");
    assert.equal(p.sent.filter((s) => s.url.startsWith("https://api.wavespeed.ai/api/v3/alibaba/")).length, 1);

    old(env);
    const done = (await call(env, `/api/generations/${w.json.generation.id}`, { cookie })).json.generation;
    assert.equal(done.status, "done", JSON.stringify(done));
    assert.equal((await call(env, `/media/${done.id}.mp4`, { cookie })).text.length, 5000);
    assert.equal(done.offer, null);
  } finally { p.restore(); }
});

test("a refusal at the door offers Wan 3.0 too; a picture's clip goes to image-to-video; No thanks drops the offer", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "wk" });
  const { cookie, id } = await paidAccount(env);
  const up = await upload(env, cookie, jpegBytes(), "image/jpeg");
  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/task/submit")) return new Response(JSON.stringify({ error: { message: COPYRIGHT } }), { status: 400, headers: { "content-type": "application/json" } });
    if (u === "https://api.wavespeed.ai/api/v3/media/uploads") return ok({ code: 200, data: { download_url: "https://cdn.wavespeed.test/in.jpg", upload: { method: "PUT", url: "https://up.wavespeed.test/put" } } });
    if (u === "https://up.wavespeed.test/put") return new Response("", { status: 200 });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/image-to-video") return ok({ code: 200, data: { id: "ws_2" } });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "she draws her sword", imageIds: [up.id], settings: { model: "seedance-2.0", resolution: "480p", duration: 5 } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.generation.status, "failed");
    assert.equal(r.json.generation.offer?.name, "Wan 3.0", "the offer is there as soon as the order is refused");
    const w = await call(env, `/api/generations/${r.json.generation.id}/wan`, { method: "POST", cookie, body: {} });
    assert.equal(w.status, 200, w.text);
    const sent = p.sent.find((s) => s.url === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/image-to-video");
    assert.deepEqual(sent.body, { prompt: "she draws her sword", duration: 5, resolution: "480p", generate_audio: true, image: "https://cdn.wavespeed.test/in.jpg" },
      "the first frame, copied into WaveSpeed's storage; no shape, so the clip keeps the picture's");
    assert.deepEqual(w.json.generation.images, [`/media/u/${up.id}`]);

    const r2 = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "she draws her sword", settings: { model: "seedance-2.0", resolution: "480p", duration: 5 } } });
    const before = credits(env, id);
    const no = await call(env, `/api/generations/${r2.json.generation.id}/wan`, { method: "POST", cookie, body: { decline: true } });
    assert.equal(no.status, 200, no.text);
    assert.equal(no.json.original.offer, null);
    assert.match(no.json.original.error, /^The video model won't make this one/);
    assert.equal((await call(env, `/api/generations/${r2.json.generation.id}`, { cookie })).json.generation.offer, null, "it stays declined");
    assert.equal((await call(env, `/api/generations/${r2.json.generation.id}/wan`, { method: "POST", cookie, body: {} })).status, 409);
    assert.equal(credits(env, id), before);
    // Only the owner of a clip can take its offer.
    const other = await signUp(env, "other@example.com");
    assert.equal((await call(env, `/api/generations/${r2.json.generation.id}/wan`, { method: "POST", cookie: other, body: {} })).status, 404);
  } finally { p.restore(); }
});

test("with the automatic switch on, a refused clip goes on on Wan 3.0 in the same card, for the credits already paid", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "wk" });
  const { cookie, id } = await paidAccount(env);
  assert.equal((await call(env, "/api/me", { cookie })).json.autoWan, false);
  const on = await call(env, "/api/me/auto-wan", { method: "POST", cookie, body: { on: true } });
  assert.equal(on.json.autoWan, true);
  assert.equal((await call(env, "/api/me", { cookie })).json.autoWan, true);
  let door = false;
  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/task/submit")) return door ? new Response(JSON.stringify({ error: { message: COPYRIGHT } }), { status: 400 }) : ok({ id: "task_cr" });
    if (/\/v1\/task\/task_cr$/.test(u)) return ok({ status: "failed", error: COPYRIGHT });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/text-to-video") return ok({ code: 200, data: { id: door ? "ws_4" : "ws_3" } });
    if (/\/api\/v3\/predictions\/ws_[34]\/result$/.test(u)) return ok({ code: 200, data: { status: "completed", outputs: ["https://cdn.wavespeed.test/out.mp4"] } });
    if (u === "https://cdn.wavespeed.test/out.mp4") return mp4Reply();
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "Rumi from KPop Demon Hunters on a rooftop", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5, aspect: "9:16" } } });
    const paid = r.json.generation.credits;
    old(env);
    const g = (await call(env, `/api/generations/${r.json.generation.id}`, { cookie })).json.generation;
    assert.deepEqual({ s: g.status, m: g.model, n: g.modelName, from: g.switchedFrom, refunded: g.refunded, offer: g.offer },
      { s: "running", m: "wan-3.0", n: "Wan 3.0", from: "Seedance 2.0 Fast", refunded: false, offer: null });
    assert.equal(credits(env, id), 100 - paid, "no refund and no second charge");
    assert.equal(env.DB.db.prepare("SELECT task_id FROM studio_generations WHERE id = ?").get(g.id).task_id, "wavespeed:ws_3");
    assert.match(env.DB.db.prepare("SELECT detail FROM audit WHERE event = 'studio.wan_auto' AND job_id = ?").get(g.id).detail, /alibaba\/wan-3\.0\/text-to-video/);
    assert.deepEqual(p.sent.find((s) => s.url.endsWith("/wan-3.0/text-to-video")).body, { prompt: "Rumi from KPop Demon Hunters on a rooftop", duration: 5, resolution: "480p", generate_audio: true, aspect_ratio: "9:16" });
    old(env);
    const done = (await call(env, `/api/generations/${g.id}`, { cookie })).json.generation;
    assert.equal(done.status, "done", JSON.stringify(done));

    // Refused at the door: the order itself goes to Wan 3.0, and the card is running from the start.
    door = true;
    const r2 = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "Zoey from KPop Demon Hunters waves", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } } });
    assert.deepEqual({ s: r2.json.generation.status, m: r2.json.generation.model }, { s: "running", m: "wan-3.0" });
    assert.equal(credits(env, id), 100 - paid - r2.json.generation.credits);

    // Switched off again: the next refusal asks first.
    door = false;
    await call(env, "/api/me/auto-wan", { method: "POST", cookie, body: { on: false } });
    const r3 = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "Mira from KPop Demon Hunters", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } } });
    old(env);
    const g3 = (await call(env, `/api/generations/${r3.json.generation.id}`, { cookie })).json.generation;
    assert.equal(g3.status, "failed");
    assert.equal(g3.offer?.name, "Wan 3.0");
  } finally { p.restore(); }
});

test("a copyright refusal in Chinese (版权) earns the offer too; a picture too small does not", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "wk" });
  const { cookie } = await paidAccount(env);
  let said = "";
  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/task/submit")) return new Response(JSON.stringify({ error: { message: said } }), { status: 400 });
    return new Response("?", { status: 404 });
  });
  try {
    said = "输出视频可能涉及版权限制";
    const a = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "Rumi sings", settings: { model: "seedance-2.5", resolution: "480p", duration: 5 } } });
    assert.equal(a.json.generation.offer?.name, "Wan 3.0", a.text);
    said = "资源同步失败: url=https://app.kleo.test/media/u/up_x, DoCall CreateAsset: InvalidParameter.HeightTooSmall: Height must be between 300px and 6000px.";
    const b = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "a fox", settings: { model: "seedance-2.5", resolution: "480p", duration: 5 } } });
    assert.equal(b.json.generation.status, "failed");
    assert.equal(b.json.generation.offer, null);
  } finally { p.restore(); }
});

test("in a chat, the clip made again on Wan 3.0 comes as Kleo's next message", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "wk" });
  const { cookie } = await paidAccount(env);
  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/task/submit")) return new Response(JSON.stringify({ error: { message: COPYRIGHT } }), { status: 400 });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/text-to-video") return ok({ code: 200, data: { id: "ws_5" } });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "Rumi sings", kind: "video", settings: { model: "seedance-2.5", resolution: "480p", duration: 5 } } });
    assert.equal(r.status, 200, r.text);
    const w = await call(env, `/api/generations/${r.json.generation.id}/wan`, { method: "POST", cookie, body: {} });
    assert.equal(w.status, 200, w.text);
    assert.equal(w.json.message.generation.id, w.json.generation.id);
    const chat = await call(env, `/api/chats/${r.json.chat.id}`, { cookie });
    const last = chat.json.messages.find((m) => m.generation?.id === w.json.generation.id);
    assert.ok(last, "the new clip is in the chat");
    assert.equal(last.generation.modelName, "Wan 3.0");
  } finally { p.restore(); }
});

// ── Pictures Seedance cannot take (20 October 2026) ─────────────────────────────────────────────────────────────────
test("a picture Seedance cannot take is refused before any charge; a provider's asset error reads plainly", async () => {
  const env = newEnv();
  const { cookie, id } = await paidAccount(env);
  const pic = async (w, h) => (await call(env, "/api/uploads", { method: "POST", cookie, raw: jpegBytes(), headers: { "content-type": "image/jpeg", "x-width": String(w), "x-height": String(h) } })).json;
  const tiny = await pic(387, 297), thin = await pic(400, 1100), fine = await pic(1024, 768);
  const p = fakeProvider((u) => {
    if (u.endsWith("/v1/task/submit")) return ok({ id: "task_px" });
    if (/\/v1\/task\/task_px$/.test(u)) return ok({ status: "failed", error: "资源同步失败: url=https://app.kleooai.com/media/u/up_h6rbdkq8wcdp?exp=1792477318&sig=0123456789abcdef0123456789abcdef, DoCall CreateAsset: InvalidParameter.HeightTooSmall: Height must be between 300px and 6000px. status code: 400, request id: 2021234567890" });
    return new Response("?", { status: 404 });
  });
  try {
    const small = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "they dance", imageIds: [fine.id, tiny.id], settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } } });
    assert.equal(small.status, 400, small.text);
    assert.equal(small.json.code, "picture_size");
    assert.match(small.json.error, /^A picture is too small for Seedance 2\.0 Fast \(387×297 px\): it needs at least 300 px on each side\. Add it again and Kleo will enlarge it — nothing was charged\.$/);
    const tall = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "she walks", imageIds: [thin.id], settings: { model: "seedance-2.5", resolution: "480p", duration: 5 } } });
    assert.equal(tall.status, 400, tall.text);
    assert.match(tall.json.error, /too tall or too wide for Seedance 2\.5 \(400×1100 px\)/);
    assert.equal(credits(env, id), 100, "nothing was charged");
    assert.ok(!p.sent.some((s) => s.url.endsWith("/v1/task/submit")), "nothing was ordered");
    // Veo states no such limit: the small picture goes through to it.
    const veo = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "she smiles", imageIds: [tiny.id], settings: { model: "veo-3.1-fast", resolution: "720p", duration: 8 } } });
    assert.equal(veo.status, 200, veo.text);

    // An order that still fails on a picture (an old row, another limit) says why in plain words.
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, prompt: "they dance", imageIds: [fine.id], settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } } });
    assert.equal(r.status, 200, r.text);
    old(env);
    const g = (await call(env, `/api/generations/${r.json.generation.id}`, { cookie })).json.generation;
    assert.equal(g.status, "failed");
    assert.equal(g.error, "The video model could not make this one: one of the pictures was refused (Height must be between 300px and 6000px). Your credits are back.");
    assert.equal(g.offer, null, "not a copyright refusal");
  } finally { p.restore(); }
});

// ── Fewer copyright dead ends (21 October 2026) ─────────────────────────────────────────────────────────────────────
const chatReply = (text) => ok({ choices: [{ message: { content: text } }] });
const DESCRIBED = "Three young women in glittering stage outfits, one with a long purple braid, one with wild red hair, one with a short black bob, sing on a neon stage";
/** The small model behind the name check (names), the rewrite (describes) and the translation (echo). */
function chatScript(names, u, init) {
  if (!u.endsWith("/v1/chat/completions")) return null;
  const body = JSON.parse(init.body);
  const sys = String(body.messages?.[0]?.content ?? "");
  if (sys.startsWith("You check prompts")) return names === "down" ? new Response("upstream error", { status: 500 }) : chatReply(JSON.stringify({ names }));
  if (sys.startsWith("Rewrite the user's prompt")) return chatReply(DESCRIBED);
  return chatReply(String(body.messages?.[1]?.content ?? ""));
}

test("the name check asks before a Seedance clip that names well-known characters; the choice goes through for the same credits", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "wk" });
  const { cookie, id } = await paidAccount(env);
  const p = fakeProvider((u, init) => {
    const c = chatScript(["Rumi", "KPop Demon Hunters"], u, init); if (c) return c;
    if (u.endsWith("/v1/task/submit")) return ok({ id: "task_sd" });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/text-to-video") return ok({ code: 200, data: { id: "ws_pre" } });
    return new Response("?", { status: 404 });
  });
  try {
    const order = { noChat: true, prompt: "Rumi from KPop Demon Hunters sings on a rooftop", settings: { model: "seedance-2.5", resolution: "480p", duration: 5 } };
    const asked = await call(env, "/api/generate", { method: "POST", cookie, body: order });
    assert.equal(asked.status, 409, asked.text);
    assert.equal(asked.json.code, "names");
    assert.equal(asked.json.error, "Seedance 2.5 usually refuses Rumi and KPop Demon Hunters: they are protected by copyright.");
    assert.deepEqual(asked.json.names, ["Rumi", "KPop Demon Hunters"]);
    assert.deepEqual({ ...asked.json.offer, credits: typeof asked.json.offer.credits }, { model: "wan-3.0", name: "Wan 3.0", credits: "number" });
    assert.equal(credits(env, id), 100, "nothing was charged");
    assert.ok(!p.sent.some((s) => s.url.endsWith("/v1/task/submit") || s.url.includes("wavespeed")), "nothing was ordered");

    const checks = () => p.sent.filter((s) => s.url.endsWith("/v1/chat/completions") && String(s.body.messages[0].content).startsWith("You check prompts")).length;
    const wan = await call(env, "/api/generate", { method: "POST", cookie, body: { ...order, engine: "wan" } });
    assert.equal(wan.status, 200, wan.text);
    assert.deepEqual({ m: wan.json.generation.model, n: wan.json.generation.modelName, pre: wan.json.generation.preRouted, s: wan.json.generation.status }, { m: "wan-3.0", n: "Wan 3.0", pre: true, s: "running" });
    assert.equal(credits(env, id), 100 - asked.json.offer.credits, "the credits the notice named");
    assert.equal(p.sent.find((s) => s.url.endsWith("/wan-3.0/text-to-video")).body.prompt, order.prompt);
    assert.ok(!p.sent.some((s) => s.url.endsWith("/v1/task/submit")), "Seedance is never asked");
    assert.ok(env.DB.db.prepare("SELECT 1 FROM audit WHERE event = 'studio.wan_pre' AND job_id = ?").get(wan.json.generation.id));
    assert.equal(checks(), 1, "a chosen engine is not checked again");

    const sd = await call(env, "/api/generate", { method: "POST", cookie, body: { ...order, engine: "seedance" } });
    assert.equal(sd.status, 200, sd.text);
    assert.equal(sd.json.generation.model, "seedance-2.5");
    assert.ok(p.sent.some((s) => s.url.endsWith("/v1/task/submit")), "Seedance is tried as asked");
    assert.equal(checks(), 1);
  } finally { p.restore(); }
});

test("with the automatic switch on, a named character goes straight to Wan 3.0; a check that cannot run lets the order go on", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "wk" });
  const { cookie } = await paidAccount(env);
  await call(env, "/api/me/auto-wan", { method: "POST", cookie, body: { on: true } });
  let names = ["Spider-Man"];
  const p = fakeProvider((u, init) => {
    const c = chatScript(names, u, init); if (c) return c;
    if (u.endsWith("/v1/task/submit")) return ok({ id: "task_sd" });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/text-to-video") return ok({ code: 200, data: { id: "ws_auto" } });
    return new Response("?", { status: 404 });
  });
  try {
    const order = { noChat: true, prompt: "Spider-Man swings over a city at dusk", settings: { model: "seedance-2.0-fast", resolution: "480p", duration: 5 } };
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: order });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ m: r.json.generation.model, pre: r.json.generation.preRouted }, { m: "wan-3.0", pre: true });
    names = "down";
    const r2 = await call(env, "/api/generate", { method: "POST", cookie, body: order });
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r2.json.generation.model, "seedance-2.0-fast", "no answer from the checker: Seedance as before");
    names = [];
    const r3 = await call(env, "/api/generate", { method: "POST", cookie, body: { ...order, prompt: "a fox in the snow" } });
    assert.equal(r3.json.generation.model, "seedance-2.0-fast");
  } finally { p.restore(); }
});

test("when Wan 3.0 refuses too, the clip can be made once more with its names turned into descriptions", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "wk" });
  const { cookie, id } = await paidAccount(env);
  let n = 0;
  const p = fakeProvider((u, init) => {
    const c = chatScript([], u, init); if (c) return c;
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/text-to-video") return ok({ code: 200, data: { id: `ws_r${++n}` } });
    if (/\/predictions\/ws_r\d\/result$/.test(u)) return ok({ code: 200, data: { status: "failed", error: "Content flagged as potentially sensitive. Please try different prompts or images.", outputs: [] } });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, engine: "wan", prompt: "Rumi, Mira and Zoey from KPop Demon Hunters sing", settings: { model: "seedance-2.5", resolution: "480p", duration: 5 } } });
    assert.equal(r.status, 200, r.text);
    old(env);
    const g = (await call(env, `/api/generations/${r.json.generation.id}`, { cookie })).json.generation;
    assert.equal(g.status, "failed");
    assert.deepEqual(g.rewrite, { name: "Wan 3.0", credits: g.credits });
    assert.match(g.error, /^Wan 3\.0 won't make this one either: it recognised characters/);
    assert.equal(credits(env, id), 100, "refunded");

    const w = await call(env, `/api/generations/${g.id}/describe`, { method: "POST", cookie, body: {} });
    assert.equal(w.status, 200, w.text);
    assert.equal(w.json.generation.prompt, DESCRIBED, "the card shows the rewritten prompt");
    assert.deepEqual({ m: w.json.generation.modelName, s: w.json.generation.status }, { m: "Wan 3.0", s: "running" });
    assert.equal(w.json.credits, 100 - g.credits, "the credits it cost");
    assert.equal(w.json.original.rewrite, null);
    const sent = p.sent.filter((s) => s.url.endsWith("/wan-3.0/text-to-video"));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.prompt, DESCRIBED);
    assert.equal((await call(env, `/api/generations/${g.id}/describe`, { method: "POST", cookie, body: {} })).status, 409, "once only");
    assert.equal(credits(env, id), 100 - g.credits);

    old(env);
    const again = (await call(env, `/api/generations/${w.json.generation.id}`, { cookie })).json.generation;
    assert.equal(again.status, "failed");
    assert.equal(again.rewrite, null, "a rewritten clip is not rewritten again");

    // No thanks drops the offer.
    const r2 = await call(env, "/api/generate", { method: "POST", cookie, body: { noChat: true, engine: "wan", prompt: "Zoey waves", settings: { model: "seedance-2.5", resolution: "480p", duration: 5 } } });
    old(env);
    await call(env, `/api/generations/${r2.json.generation.id}`, { cookie });
    const no = await call(env, `/api/generations/${r2.json.generation.id}/describe`, { method: "POST", cookie, body: { decline: true } });
    assert.equal(no.json.original.rewrite, null);
    assert.equal((await call(env, `/api/generations/${r2.json.generation.id}/describe`, { method: "POST", cookie, body: {} })).status, 409);
  } finally { p.restore(); }
});

test("a picture FLUX 3 refuses too can be drawn once more on FLUX 3 with its names turned into descriptions", async () => {
  const env = newEnv();
  const { cookie, id } = await paidAccount(env);
  let n = 0;
  const png = new Uint8Array(4000); png.set([0x89, 0x50, 0x4e, 0x47]);
  const p = fakeProvider((u, init) => {
    const c = chatScript([], u, init); if (c) return c;
    if (u.endsWith("/v1/task/submit")) return ok({ id: `task_i${++n}` });
    if (/task_i[1-3]$/.test(u)) return ok({ status: "failed", error: n === 1 ? "no image generated in response" : 'Content Moderated: {"Moderation Reasons":["Protected Content"]}' });
    if (/task_i4$/.test(u)) return ok({ status: "completed", outputs: ["https://cdn.example/i.png"] });
    if (u === "https://cdn.example/i.png") return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { kind: "image", noChat: true, prompt: "Rumi from KPop Demon Hunters on a poster", settings: { model: "nano-banana-2.1", aspect: "3:4", quality: "2K" } } });
    assert.equal(r.status, 200, r.text);
    for (let i = 0; i < 3; i++) { old(env); await call(env, `/api/generations/${r.json.generation.id}`, { cookie }); }
    const g = (await call(env, `/api/generations/${r.json.generation.id}`, { cookie })).json.generation;
    assert.equal(g.status, "failed", JSON.stringify(g));
    assert.deepEqual(g.rewrite, { name: "FLUX 3", credits: g.credits });
    const before = credits(env, id);
    const w = await call(env, `/api/generations/${g.id}/describe`, { method: "POST", cookie, body: {} });
    assert.equal(w.status, 200, w.text);
    assert.equal(w.json.generation.prompt, DESCRIBED);
    assert.equal(w.json.generation.model, "flux-3");
    assert.equal(credits(env, id), before - g.credits, "the credits the refused picture cost");
    const last = p.sent.filter((s) => s.url.endsWith("/v1/task/submit")).at(-1);
    assert.deepEqual([last.body.model, last.body.input.prompt, last.body.input.safety_tolerance], ["flux-3-image", DESCRIBED, 2]);
    old(env);
    const done = (await call(env, `/api/generations/${w.json.generation.id}`, { cookie })).json.generation;
    assert.equal(done.status, "done", JSON.stringify(done));
  } finally { p.restore(); }
});

// ── Apple Pay / Google Pay inside the app (21 October 2026) ─────────────────────────────────────────────────────────
test("the in-app wallet button pays a Checkout Session for the same Stripe Price, tied to the account; no keys, no button", async () => {
  const PRICES = { data: [
    { id: "price_pack10", currency: "eur", unit_amount: 500, type: "one_time", recurring: null },
    { id: "price_pack35", currency: "eur", unit_amount: 1500, type: "one_time", recurring: null },
    { id: "price_pro_m", currency: "eur", unit_amount: 3900, type: "recurring", recurring: { interval: "month" } },
    { id: "price_pro_y", currency: "eur", unit_amount: 37200, type: "recurring", recurring: { interval: "year" } },
    { id: "price_usd", currency: "usd", unit_amount: 500, type: "one_time", recurring: null },
  ] };
  const none = newEnv();
  const c0 = (await paidAccount(none)).cookie;
  const off = await call(none, "/api/pay/session", { method: "POST", cookie: c0, body: { pack: 10 } });
  assert.equal(off.status, 503);
  assert.equal(off.json.code, "pay_unavailable", "without the keys the page opens Stripe's checkout instead");

  const env = newEnv({ STRIPE_SECRET_KEY: "rk_live_test", STRIPE_PUBLISHABLE_KEY: "pk_live_test" });
  assert.equal((await call(env, "/api/pay/session", { method: "POST", body: { pack: 10 } })).status, 401, "a visitor gets nothing");
  const { cookie, id } = await paidAccount(env, "buyer@example.com");
  const p = fakeProvider((u, init) => {
    if (u.startsWith("https://api.stripe.com/v1/prices")) return ok(PRICES);
    if (u === "https://api.stripe.com/v1/checkout/sessions") return ok({ id: "cs_live_x", client_secret: "cs_live_x_secret_y" });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/pay/session", { method: "POST", cookie, body: { pack: 10 } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { clientSecret: "cs_live_x_secret_y", publishableKey: "pk_live_test", label: "10 credits", cents: 500 });
    const made = p.sent.find((s) => s.url === "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(made.headers.authorization, "Bearer rk_live_test");
    const form = Object.fromEntries(new URLSearchParams(made.body));
    assert.deepEqual(form, {
      mode: "payment", ui_mode: "elements", "line_items[0][price]": "price_pack10", "line_items[0][quantity]": "1",
      client_reference_id: id, return_url: "https://app.kleo.test/?paid=1", locale: "en",
      "metadata[kleo_user]": id, "metadata[kleo_source]": "studio-wallet", customer_email: "buyer@example.com",
    }, "the webhook names the account by client_reference_id and the pack by the EUR amount, as for a Payment Link");

    const plan = await call(env, "/api/pay/session", { method: "POST", cookie, body: { plan: "pro", tier: 0, period: "year" } });
    assert.equal(plan.status, 200, plan.text);
    const f2 = Object.fromEntries(new URLSearchParams(p.sent.filter((s) => s.url.endsWith("/v1/checkout/sessions")).at(-1).body));
    assert.deepEqual([f2.mode, f2["line_items[0][price]"]], ["subscription", "price_pro_y"]);
    assert.equal(p.sent.filter((s) => s.url.startsWith("https://api.stripe.com/v1/prices")).length, 1, "the prices are read once");

    assert.equal((await call(env, "/api/pay/session", { method: "POST", cookie, body: { pack: 7 } })).status, 400, "no such pack");
    const missing = await call(env, "/api/pay/session", { method: "POST", cookie, body: { pack: 100 } });
    assert.equal(missing.json.code, "pay_unavailable", "a pack with no live Stripe Price falls back to the checkout");
    assert.ok(env.DB.db.prepare("SELECT 1 FROM audit WHERE event = 'pay.session' AND user_id = ?").get(id), "every session is in the audit");
  } finally { p.restore(); }
  const page = await call(env, "/");
  assert.match(page.res.headers.get("permissions-policy"), /payment=\(self "https:\/\/js\.stripe\.com" "https:\/\/\*\.js\.stripe\.com"\)/, "payments allowed for Stripe's frames only");
  assert.match(page.res.headers.get("content-security-policy"), /connect-src 'self' https:\/\/cloudflareinsights\.com https:\/\/api\.stripe\.com;/);
});

// ── Two people in a template written shot by shot: two runs, one person each (23 October 2026) ──────────────────────
test("a two-person shot-by-shot template runs twice: the first person and the place, then the second person alone on that video", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "k" });
  const { cookie, id } = await paidAccount(env, "two@example.com", 100);
  const up = async () => (await call(env, "/api/uploads", { method: "POST", cookie, raw: jpegBytes(), headers: { "content-type": "image/jpeg", "x-width": "1080", "x-height": "1920" } })).json;
  const a = await up(), b = await up();
  const made = new Uint8Array(Buffer.from(mp4Bytes(6, 480, 854)));
  let n = 0;
  const p = fakeProvider((u) => {
    if (u === "https://api.wavespeed.ai/api/v3/media/uploads") { n++; return ok({ code: 200, data: { download_url: `https://cdn.wavespeed.test/photo${n}.jpg`, upload: { method: "PUT", url: "https://up.wavespeed.test/put" } } }); }
    if (u === "https://up.wavespeed.test/put") return new Response("", { status: 200 });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/video-edit") return ok({ code: 200, data: { id: p.sent.filter((x) => x.url === u).length === 1 ? "ws_one" : "ws_two", status: "created" } });
    if (u === "https://api.wavespeed.ai/api/v3/predictions/ws_one/result") return ok({ code: 200, data: { id: "ws_one", status: "completed", outputs: ["https://cdn.wavespeed.test/one.mp4"] } });
    if (u === "https://api.wavespeed.ai/api/v3/predictions/ws_two/result") return ok({ code: 200, data: { id: "ws_two", status: "completed", outputs: ["https://cdn.wavespeed.test/two.mp4"] } });
    if (u === "https://cdn.wavespeed.test/two.mp4") return new Response(made, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(made.byteLength) } });
    return new Response("?", { status: 404 });
  });
  try {
    const before = credits(env, id);
    const run = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "trend-crossover-king-pt2", consent: true, inputs: { person1: a.id, person2: b.id, court: "street", quality: "480p" } } });
    assert.equal(run.status, 200, run.text);
    assert.equal(before - credits(env, id), 5, "two runs at 480p: $1.20, 5 credits");
    let edits = p.sent.filter((x) => x.url.endsWith("/alibaba/wan-3.0/video-edit"));
    assert.equal(edits.length, 1, "the second run waits for the first");
    assert.match(edits[0].body.prompt, /^Edit Video 1: replace THE DUNKER with the person from Image 1, and change the place/);
    assert.equal(edits[0].body.reference_images.length, 1);
    old(env);
    let g = await call(env, `/api/generations/${run.json.generation.id}`, { cookie });
    edits = p.sent.filter((x) => x.url.endsWith("/alibaba/wan-3.0/video-edit"));
    assert.equal(edits.length, 2, g.text);
    assert.equal(edits[1].body.video, "https://cdn.wavespeed.test/one.mp4", "the second run works on the first run's video");
    assert.match(edits[1].body.prompt, /^Edit Video 1: replace only THE DEFENDER with the person from the reference image\./);
    assert.equal(edits[1].body.reference_images.length, 1);
    assert.notEqual(edits[1].body.reference_images[0], edits[0].body.reference_images[0], "each run has its own photo");
    old(env);
    g = await call(env, `/api/generations/${run.json.generation.id}`, { cookie });
    assert.equal(g.json.generation.status, "done", g.text);
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'studio.next_step'").get().n, 1);
  } finally { p.restore(); }
});

// The review of the two runs (24 October 2026): a second run starts once, survives a busy WaveSpeed, and when WaveSpeed
// refuses it the customer gets the first run's video with half the credits back.
async function twoPhotoOrder(env, cookie) {
  const up = async () => (await call(env, "/api/uploads", { method: "POST", cookie, raw: jpegBytes(), headers: { "content-type": "image/jpeg", "x-width": "1080", "x-height": "1920" } })).json;
  const a = await up(), b = await up();
  const run = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "trend-crossover-king-pt2", consent: true, inputs: { person1: a.id, person2: b.id, quality: "480p" } } });
  assert.equal(run.status, 200, run.text);
  return run.json.generation.id;
}
const wanScript = (second) => {
  let n = 0, e = 0;
  return (u) => {
    if (u === "https://api.wavespeed.ai/api/v3/media/uploads") { n++; return ok({ code: 200, data: { download_url: `https://cdn.wavespeed.test/photo${n}.jpg`, upload: { method: "PUT", url: "https://up.wavespeed.test/put" } } }); }
    if (u === "https://up.wavespeed.test/put") return new Response("", { status: 200 });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/video-edit") { e++; return e === 1 ? ok({ code: 200, data: { id: "ws_one", status: "created" } }) : second(e); }
    if (u === "https://api.wavespeed.ai/api/v3/predictions/ws_one/result") return ok({ code: 200, data: { id: "ws_one", status: "completed", outputs: ["https://cdn.wavespeed.test/one.mp4"] } });
    if (u.includes("/predictions/ws_two")) return ok({ code: 200, data: { status: "processing" } });
    if (u === "https://cdn.wavespeed.test/one.mp4") { const m = mp4Bytes(6, 480, 854); return new Response(m, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(m.byteLength) } }); }
    return new Response("?", { status: 404 });
  };
};

test("a template's second run starts once, even when the cron works from a copy read before a poll started it", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "k" });
  const { cookie } = await paidAccount(env, "race@example.com", 100);
  const p = fakeProvider(wanScript((e) => ok({ code: 200, data: { id: `ws_two_${e}`, status: "created" } })));
  try {
    const gid = await twoPhotoOrder(env, cookie);
    old(env);
    // The cron reads its rows; before it reaches this one, the customer's poll starts the second run.
    const realPrepare = env.DB.prepare.bind(env.DB);
    let fired = false;
    env.DB.prepare = (sql) => {
      const st = realPrepare(sql);
      if (!fired && /checked_at IS NULL OR checked_at </.test(sql)) {
        const all = st.all.bind(st);
        st.all = async () => { const r = await all(); fired = true; env.DB.prepare = realPrepare; await call(env, `/api/generations/${gid}`, { cookie }); return r; };
      }
      return st;
    };
    await worker.scheduled({ scheduledTime: Date.now() }, env, ctx);
    await Promise.allSettled(pending.splice(0));
    assert.ok(fired, "the poll ran inside the cron's window");
    assert.equal(p.sent.filter((x) => x.url.endsWith("/alibaba/wan-3.0/video-edit")).length, 2, "one first run, one second run, never a third");
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'studio.next_step'").get().n, 1);
  } finally { p.restore(); }
});

test("a template's second run waits out a busy WaveSpeed, and a refused one leaves the first video and half the credits", async () => {
  // Busy (429) once: tried again on the next pass, not failed.
  const env = newEnv({ WAVESPEED_API_KEY: "k" });
  const a1 = await paidAccount(env, "busy@example.com", 100);
  let p = fakeProvider(wanScript((e) => (e === 2 ? new Response("too many requests", { status: 429 }) : ok({ code: 200, data: { id: "ws_two", status: "created" } }))));
  try {
    const gid = await twoPhotoOrder(env, a1.cookie);
    old(env);
    let g = await call(env, `/api/generations/${gid}`, { cookie: a1.cookie });
    assert.equal(g.json.generation.status, "running", g.text);
    old(env);
    g = await call(env, `/api/generations/${gid}`, { cookie: a1.cookie });
    assert.equal(p.sent.filter((x) => x.url.endsWith("/alibaba/wan-3.0/video-edit")).length, 3, "the busy answer was tried again");
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'studio.next_step'").get().n, 1);
    assert.equal(g.json.generation.status, "running");
  } finally { p.restore(); }

  // Refused (400): the first run's video is the result, half the credits come back.
  const env2 = newEnv({ WAVESPEED_API_KEY: "k" });
  const a2 = await paidAccount(env2, "refused@example.com", 100);
  p = fakeProvider(wanScript(() => new Response(JSON.stringify({ code: 400, message: "bad input" }), { status: 400 })));
  try {
    const gid = await twoPhotoOrder(env2, a2.cookie);
    const after = credits(env2, a2.id);
    assert.equal(100 - after, 5, "two runs at 480p");
    old(env2);
    const g = await call(env2, `/api/generations/${gid}`, { cookie: a2.cookie });
    assert.equal(g.json.generation.status, "done", g.text);
    assert.equal(g.json.generation.outputs.length, 1, "the first run's video");
    assert.equal(credits(env2, a2.id), after + 2, "half of the 5 credits back, rounded down");
    assert.equal(env2.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'studio.next_step_failed'").get().n, 1);
  } finally { p.restore(); }
});

// ── A template's video reaches the customer byte for byte (21 October 2026) ─────────────────────────────────────────
// The owner: "assicurati che kleo prenda il contenuto generato da WaveSpeed e lo dia al cliente alla massima qualità".
test("a template's video reaches the customer byte for byte: WaveSpeed's file is stored, shown and downloaded unchanged, at the quality chosen", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "k" });
  const { cookie, id } = await paidAccount(env, "tpl@example.com", 100);
  // 1080p templates come with a plan (25 October 2026): this account has one.
  env.DB.db.exec(`UPDATE users SET plan = 'pro', plan_until = '2099-01-01T00:00:00.000Z' WHERE id = '${id}'`);
  const photo = await call(env, "/api/uploads", { method: "POST", cookie, raw: jpegBytes(), headers: { "content-type": "image/jpeg", "x-width": "1080", "x-height": "1920" } });
  assert.equal(photo.status, 200, photo.text);
  // A 14 s 1080p clip with a long patterned tail, so a change to any single byte shows.
  const made = new Uint8Array(Buffer.concat([Buffer.from(mp4Bytes(14, 1080, 1920)), Buffer.from(Array.from({ length: 50_000 }, (_, i) => (i * 31 + 7) % 256))]));
  const p = fakeProvider((u) => {
    if (u === "https://api.wavespeed.ai/api/v3/media/uploads") return ok({ code: 200, data: { download_url: "https://cdn.wavespeed.test/person.jpg", upload: { method: "PUT", url: "https://up.wavespeed.test/put" } } });
    if (u === "https://up.wavespeed.test/put") return new Response("", { status: 200 });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/video-edit") return ok({ code: 200, data: { id: "ws_tpl", status: "created" } });
    if (u === "https://api.wavespeed.ai/api/v3/predictions/ws_tpl/result") return ok({ code: 200, data: { id: "ws_tpl", status: "completed", outputs: ["https://cdn.wavespeed.test/tpl.mp4"] } });
    if (u === "https://cdn.wavespeed.test/tpl.mp4") return new Response(made, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(made.byteLength) } });
    return new Response("?", { status: 404 });
  });
  try {
    const run = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "trend-paris-fire-dance", consent: true, inputs: { person1: photo.json.id, quality: "1080p" } } });
    assert.equal(run.status, 200, run.text);
    const sent = p.sent.find((s) => s.url.endsWith("/alibaba/wan-3.0/video-edit"));
    assert.equal(sent.body.resolution, "1080p", "the quality the customer chose is the quality ordered");
    old(env);
    const done = await call(env, `/api/generations/${run.json.generation.id}`, { cookie });
    assert.equal(done.json.generation.status, "done", done.text);
    const out = done.json.generation.outputs[0];
    assert.equal(out.type, "video");
    for (const path of [out.url, `${out.url}?dl=1`]) {
      const res = await worker.fetch(new Request(`https://app.kleo.test${path}`, { headers: { cookie } }), env, ctx);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("content-type"), "video/mp4");
      const got = new Uint8Array(await res.arrayBuffer());
      assert.equal(got.byteLength, made.byteLength, `${path}: same size`);
      assert.ok(Buffer.from(got).equals(Buffer.from(made)), `${path}: the very bytes WaveSpeed made, nothing re-encoded or shrunk`);
    }
  } finally { p.restore(); }
});

// ── You Tweaking on Wan 3.0 Prime (26 October 2026) ───────────────────────────────────────────────────────────────
// The owner, after the standard model's run came back wrong: "no niente prova, costa troppo devi essere sicuro che tutto
// funzioni". The whole order with WaveSpeed faked: what is sent, what is charged, what the customer gets.
test("You Tweaking: what the vision check reads on the photos reaches the fixed prompt, numbered like the photos", async () => {
  const ai = { run: async () => ({ response: '{"person": true, "people": 2, "colour": "greyscale", "framing": "waist-up", "face": "medium", "hair": "black", "beard": false, "glasses": false}' }) };
  const env = newEnv({ WAVESPEED_API_KEY: "k", AI: ai });
  const { cookie } = await paidAccount(env, "tweak-facts@example.com", 100);
  const up = async () => (await call(env, "/api/uploads", { method: "POST", cookie, raw: jpegBytes(), headers: { "content-type": "image/jpeg", "x-width": "1080", "x-height": "1920" } })).json;
  const a = await up(), b = await up();
  const p = fakeProvider((u) => {
    if (u === "https://api.wavespeed.ai/api/v3/media/uploads") return ok({ code: 200, data: { download_url: "https://cdn.wavespeed.test/p.jpg", upload: { method: "PUT", url: "https://up.wavespeed.test/put" } } });
    if (u === "https://up.wavespeed.test/put") return new Response("", { status: 200 });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0-prime/video-edit") return ok({ code: 200, data: { id: "ws_ytf", status: "created" } });
    return new Response("?", { status: 404 });
  });
  try {
    const r = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "trend-you-tweaking", consent: true, inputs: { person1: a.id, person2: b.id, quality: "480p" } } });
    assert.equal(r.status, 200, r.text);
    const sent = p.sent.find((x) => x.url.endsWith("/alibaba/wan-3.0-prime/video-edit")).body;
    assert.match(sent.prompt, /^Replace the two people in Video 1/);
    assert.match(sent.prompt, /\n\nABOUT THE PHOTOS\nImage 1 is a black-and-white photo[^\n]*\nImage 1 shows more than one person[^\n]*\nImage 2 is a black-and-white photo[^\n]*\nImage 2 shows more than one person[^\n]*$/);
  } finally { p.restore(); }
});

test("You Tweaking: one photo is refused before any charge; two photos make one Prime run with the fixed prompt, charged as priced, its video delivered byte for byte", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "k" });
  const { cookie, id } = await paidAccount(env, "tweak@example.com", 100);
  env.DB.db.exec(`UPDATE users SET plan = 'pro', plan_until = '2099-01-01T00:00:00.000Z' WHERE id = '${id}'`);
  const up = async () => (await call(env, "/api/uploads", { method: "POST", cookie, raw: jpegBytes(), headers: { "content-type": "image/jpeg", "x-width": "1080", "x-height": "1920" } })).json;
  const a = await up(), b = await up();
  // Wan answers 4:3 at 720p: 1108x832.
  const made = new Uint8Array(Buffer.concat([Buffer.from(mp4Bytes(15, 1108, 832)), Buffer.from(Array.from({ length: 20_000 }, (_, i) => (i * 13 + 5) % 256))]));
  let n = 0;
  const p = fakeProvider((u) => {
    if (u === "https://api.wavespeed.ai/api/v3/media/uploads") { n++; return ok({ code: 200, data: { download_url: `https://cdn.wavespeed.test/photo${n}.jpg`, upload: { method: "PUT", url: "https://up.wavespeed.test/put" } } }); }
    if (u === "https://up.wavespeed.test/put") return new Response("", { status: 200 });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0-prime/video-edit") return ok({ code: 200, data: { id: "ws_yt", status: "created" } });
    if (u === "https://api.wavespeed.ai/api/v3/predictions/ws_yt/result") return ok({ code: 200, data: { id: "ws_yt", status: "completed", outputs: ["https://cdn.wavespeed.test/yt.mp4"] } });
    if (u === "https://cdn.wavespeed.test/yt.mp4") return new Response(made, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(made.byteLength) } });
    return new Response("?", { status: 404 });
  });
  try {
    const tool = "trend-you-tweaking";
    const start = credits(env, id);
    // One photo: refused before any charge, nothing sent to WaveSpeed.
    const one = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool, consent: true, inputs: { person1: a.id, quality: "720p" } } });
    assert.equal(one.status, 400, one.text);
    assert.match(one.text, /each of the 2 people/);
    assert.equal(credits(env, id), start);
    assert.equal(p.sent.filter((s) => s.url.includes("video-edit")).length, 0);
    // The price the page shows is the price charged.
    const price = await call(env, "/api/tools/price", { method: "POST", cookie, body: { tool, inputs: { person1: a.id, person2: b.id, quality: "720p" } } });
    assert.equal(price.status, 200, price.text);
    assert.ok(price.json.credits > 0, price.text);
    const run = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool, consent: true, inputs: { person1: a.id, person2: b.id, quality: "720p" } } });
    assert.equal(run.status, 200, run.text);
    assert.equal(start - credits(env, id), price.json.credits);
    const sent = p.sent.filter((s) => s.url.includes("video-edit"));
    assert.deepEqual(sent.map((s) => s.url), ["https://api.wavespeed.ai/api/v3/alibaba/wan-3.0-prime/video-edit"], "one run, on Prime");
    const body = sent[0].body;
    assert.equal(body.video, "https://media.kleooai.com/app/templates/you-tweaking/base-30.mp4");
    assert.deepEqual(body.reference_images, ["https://cdn.wavespeed.test/photo1.jpg", "https://cdn.wavespeed.test/photo2.jpg"], "both photos, in seat order, on WaveSpeed's own storage");
    assert.equal(body.resolution, "720p");
    assert.equal(body.generate_audio, false, "the clip's own sound");
    assert.equal(body.enable_prompt_expansion, false);
    assert.match(body.prompt, /^Replace the two people in Video 1 with the people from Image 1 and Image 2/);
    assert.match(body.prompt, /Never add a second person to a shot\./);
    old(env);
    const done = await call(env, `/api/generations/${run.json.generation.id}`, { cookie });
    assert.equal(done.json.generation.status, "done", done.text);
    const out = done.json.generation.outputs[0];
    assert.equal(out.type, "video");
    const res = await worker.fetch(new Request(`https://app.kleo.test${out.url}?dl=1`, { headers: { cookie } }), env, ctx);
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(new Uint8Array(await res.arrayBuffer())).equals(Buffer.from(made)), "WaveSpeed's very bytes");
    assert.equal(sent.length, 1, "never a second run");
  } finally { p.restore(); }
});

// ── HD templates come with a plan (25 October 2026) ──────────────────────────────────────────────────────────────
// The owner: "480p con qualsiasi acquisto, 720p e 1080p solo con abbonamento, e prezzi nascosti fino ad allora".
test("templates: 480p for any paying account; 720p and 1080p need a running plan, refused before any charge; the price check tells only the 480p price until then", async () => {
  const env = newEnv({ WAVESPEED_API_KEY: "k" });
  const tpl = "trend-paris-fire-dance";
  // Never paid: the 480p price only, whatever quality is asked.
  const free = await signUp(env, "free-tpl@example.com");
  const freePhoto = await upload(env, free, jpegBytes(), "image/jpeg");
  const fp = await call(env, "/api/tools/price", { method: "POST", cookie: free, body: { tool: tpl, inputs: { person1: freePhoto.id, quality: "1080p" } } });
  assert.deepEqual([fp.json.credits, fp.json.locked, fp.json.from], [null, "pack", 6], fp.text);
  // Paid with a pack, no plan: 480p in full, HD only as "from" and refused at the order.
  const { cookie, id } = await paidAccount(env, "pack-tpl@example.com", 100);
  const photo = await upload(env, cookie, jpegBytes(), "image/jpeg");
  const price = (quality) => call(env, "/api/tools/price", { method: "POST", cookie, body: { tool: tpl, inputs: { person1: photo.id, ...(quality ? { quality } : {}) } } });
  assert.equal((await price("480p")).json.credits, 6);
  for (const q of ["720p", "1080p", null]) {
    const r = await price(q);
    assert.deepEqual([r.json.credits, r.json.locked, r.json.from], [null, "plan", 6], `${q}: ${r.text}`);
  }
  assert.equal((await call(env, "/api/me", { cookie })).json.hdTemplates, false);
  const p = fakeProvider(() => ok({}));
  try {
    for (const q of ["720p", "1080p"]) {
      const r = await call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: tpl, consent: true, inputs: { person1: photo.id, quality: q } } });
      assert.equal(r.status, 402, r.text);
      assert.equal(r.json.code, "plan_required");
    }
    assert.equal(p.sent.length, 0, "no provider was asked");
    assert.equal(credits(env, id), 100, "nothing was charged");
  } finally { p.restore(); }
  // A running plan: every quality, the full price.
  env.DB.db.exec(`UPDATE users SET plan = 'lite', plan_until = '2099-01-01T00:00:00.000Z' WHERE id = '${id}'`);
  assert.equal((await call(env, "/api/me", { cookie })).json.hdTemplates, true);
  assert.equal((await price("720p")).json.credits, 11);
  assert.equal((await price("1080p")).json.credits, 21);
  // A plan that ran out is no plan.
  env.DB.db.exec(`UPDATE users SET plan_until = '2020-01-01T00:00:00.000Z' WHERE id = '${id}'`);
  assert.equal((await price("720p")).json.locked, "plan");
  // The app's other apps are untouched: a video app's price is told in full to a paying account.
  const pic = await upload(env, cookie, jpegBytes(), "image/jpeg");
  const swap = await call(env, "/api/tools/price", { method: "POST", cookie, body: { tool: "face-swap", inputs: { target: pic.id, face: pic.id } } });
  assert.ok(swap.json.credits > 0, swap.text);
});

test("a shot-by-shot template reads the photo facts into its instruction, and a photo gone from storage is refused before any charge", async () => {
  const ai = { run: async () => ({ response: '{"person": true, "people": 1, "colour": "greyscale", "framing": "knees-up", "face": "medium", "hair": "brown", "beard": false, "glasses": false}' }) };
  const env = newEnv({ WAVESPEED_API_KEY: "k", AI: ai });
  const { cookie, id } = await paidAccount(env, "ck@example.com", 100);
  const up = async () => (await call(env, "/api/uploads", { method: "POST", cookie, raw: jpegBytes(), headers: { "content-type": "image/jpeg", "x-width": "1080", "x-height": "1920" } })).json;
  const order = (photoId) => call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "trend-crossover-king-pt1", consent: true, inputs: { person1: photoId, court: "street", light: "day", quality: "480p" } } });
  const p = fakeProvider((u) => {
    if (u === "https://api.wavespeed.ai/api/v3/media/uploads") return ok({ code: 200, data: { download_url: "https://cdn.wavespeed.test/p.jpg", upload: { method: "PUT", url: "https://up.wavespeed.test/put" } } });
    if (u === "https://up.wavespeed.test/put") return new Response("", { status: 200 });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/video-edit") return ok({ code: 200, data: { id: "ws_ck", status: "created" } });
    return new Response("?", { status: 404 });
  });
  try {
    const photo = await up();
    const r = await order(photo.id);
    assert.equal(r.status, 200, r.text);
    const sent = p.sent.find((x) => x.url.endsWith("/alibaba/wan-3.0/video-edit")).body;
    assert.match(sent.prompt, /^Edit Video 1: replace THE DUNKER with the person from Image 1/);
    assert.match(sent.prompt, /Image 1 is a black-and-white photo: give that person natural, realistic colour/);
    assert.match(sent.prompt, /- LIGHT: bright daylight/);
    assert.doesNotMatch(sent.prompt, /night/);
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'studio.photo_facts'").get().n, 1);

    // The photo is gone from storage: Wan 3.0 could not read it either, so nothing is ordered and nothing charged.
    const gone = await up();
    for (const k of [...env.RENDERS.m.keys()]) if (k.includes(gone.id)) env.RENDERS.m.delete(k);
    const before = credits(env, id), asked = p.sent.length;
    const r2 = await order(gone.id);
    assert.equal(r2.status, 400, r2.text);
    assert.equal(r2.json.code, "photo_missing");
    assert.match(r2.json.error, /Person 1's photo could not be read\. Add it again — nothing was charged\./);
    assert.equal(credits(env, id), before, "nothing was charged");
    assert.equal(p.sent.length, asked, "WaveSpeed was never asked");
  } finally { p.restore(); }
});

test("a template refuses a photo with no person in it before any charge; a real person goes through; no check, no block", async () => {
  const seen = [];
  const ai = (answer) => ({ run: async (model, input) => { seen.push({ model, input }); return { response: answer }; } });
  const order = async (env, cookie, photoId) => call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "trend-bby-wow", consent: true, inputs: { person1: photoId, quality: "480p" } } });
  const wan = () => fakeProvider((u) => {
    if (u === "https://api.wavespeed.ai/api/v3/media/uploads") return ok({ code: 200, data: { download_url: "https://cdn.wavespeed.test/p.jpg", upload: { method: "PUT", url: "https://up.wavespeed.test/put" } } });
    if (u === "https://up.wavespeed.test/put") return new Response("", { status: 200 });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/video-edit") return ok({ code: 200, data: { id: "ws_bw", status: "created" } });
    return new Response("?", { status: 404 });
  });

  // The cartoon sausage: refused, nothing charged, WaveSpeed never asked.
  const env = newEnv({ WAVESPEED_API_KEY: "k", AI: ai('{"person": false}') });
  const { cookie, id } = await paidAccount(env, "bw@example.com", 100);
  const photo = (await call(env, "/api/uploads", { method: "POST", cookie, raw: jpegBytes(), headers: { "content-type": "image/jpeg", "x-width": "1080", "x-height": "1920" } })).json;
  let p = wan();
  try {
    const r = await order(env, cookie, photo.id);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, "no_person");
    assert.match(r.json.error, /Bby Wow swaps people: Person 1 needs a clear photo of a real person/);
    assert.equal(credits(env, id), 100, "nothing was charged");
    assert.ok(!p.sent.some((s) => s.url.includes("wavespeed")), "WaveSpeed was never asked");
    assert.equal(seen.length, 1);
    assert.match(seen[0].model, /llama-4-scout/);
    assert.match(seen[0].input.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'studio.no_person'").get().n, 1);
  } finally { p.restore(); }

  // A real person: the order goes on as before.
  const env2 = newEnv({ WAVESPEED_API_KEY: "k", AI: ai('{"person": true}') });
  const a2 = await paidAccount(env2, "bw2@example.com", 100);
  const photo2 = (await call(env2, "/api/uploads", { method: "POST", cookie: a2.cookie, raw: jpegBytes(), headers: { "content-type": "image/jpeg", "x-width": "1080", "x-height": "1920" } })).json;
  p = wan();
  try {
    const r = await order(env2, a2.cookie, photo2.id);
    assert.equal(r.status, 200, r.text);
    assert.ok(p.sent.some((s) => s.url.endsWith("/alibaba/wan-3.0/video-edit")));
  } finally { p.restore(); }

  // A check that cannot answer (an error) never blocks the order.
  const env3 = newEnv({ WAVESPEED_API_KEY: "k", AI: { run: async () => { throw new Error("quota"); } } });
  const a3 = await paidAccount(env3, "bw3@example.com", 100);
  const photo3 = (await call(env3, "/api/uploads", { method: "POST", cookie: a3.cookie, raw: jpegBytes(), headers: { "content-type": "image/jpeg", "x-width": "1080", "x-height": "1920" } })).json;
  p = wan();
  try {
    assert.equal((await order(env3, a3.cookie, photo3.id)).status, 200);
  } finally { p.restore(); }
});

test("Locker Room takes a character (27 October 2026, Ted): the person says which seat, that seat's line is swapped, a photo that looks like no person in an unmarked seat is refused for free", async () => {
  const wan = () => fakeProvider((u) => {
    if (u === "https://api.wavespeed.ai/api/v3/media/uploads") return ok({ code: 200, data: { download_url: "https://cdn.wavespeed.test/p.jpg", upload: { method: "PUT", url: "https://up.wavespeed.test/put" } } });
    if (u === "https://up.wavespeed.test/put") return new Response("", { status: 200 });
    if (u === "https://api.wavespeed.ai/api/v3/alibaba/wan-3.0-prime/video-edit") return ok({ code: 200, data: { id: "ws_ted", status: "created" } });
    return new Response("?", { status: 404 });
  });
  // The check reads the man as a person and the bear as no person, in seat order, as it did on the owner's photos.
  const reads = (...answers) => { let n = 0; return { run: async () => { const a = answers[n++ % answers.length]; if (a instanceof Error) throw a; return { response: a }; } }; };
  const man = '{"person": true, "people": 1, "colour": "colour", "framing": "waist-up", "face": "large"}', bear = '{"person": false, "people": 0, "colour": "colour", "framing": "full-body", "face": "small"}';
  const setup = async (ai, email) => {
    const env = newEnv({ WAVESPEED_API_KEY: "k", AI: ai });
    const { cookie, id } = await paidAccount(env, email, 100);
    const up = async () => (await call(env, "/api/uploads", { method: "POST", cookie, raw: jpegBytes(), headers: { "content-type": "image/jpeg", "x-width": "1494", "x-height": "806" } })).json;
    const a = await up(), b = await up();
    const order = (character) => call(env, "/api/tools/run", { method: "POST", cookie, body: { tool: "trend-locker-room", consent: true, inputs: { person1: a.id, person2: b.id, quality: "480p", ...(character ? { character } : {}) } } });
    return { env, id, order };
  };
  const t = (await import("../src/studio/trends.ts")).trendByKey("trend-locker-room");
  const { toolCredits } = await import("../src/studio/tools.ts");
  const human = t.prompt.split("\n").find((l) => l.startsWith(t.seats[1].asCharacter.line));
  const tedWords = t.prompt.replace(human, t.seats[1].asCharacter.text);

  // Marked: Person 2 is a character. One Prime run, charged as priced, Ted's own line in place.
  const one = await setup(reads(man, bear), "ted@example.com");
  let p = wan();
  try {
    const cfg = await call(one.env, "/api/config");
    assert.equal(cfg.json.tools.find((x) => x.key === "trend-locker-room").characters, true);
    assert.ok(cfg.json.tools.find((x) => x.key === "trend-locker-room").fields.some((f) => f.key === "character"));
    assert.equal(cfg.json.tools.find((x) => x.key === "trend-bby-wow").characters, undefined);
    const r = await one.order("person2");
    assert.equal(r.status, 200, r.text);
    assert.equal(credits(one.env, one.id), 100 - toolCredits(1.65), "charged as priced: $1.65 at 480p, as for a real person");
    const sent = p.sent.filter((x) => x.url.endsWith("/alibaba/wan-3.0-prime/video-edit"));
    assert.equal(sent.length, 1, "one paid run");
    assert.equal(sent[0].body.prompt, tedWords);
    assert.equal(one.env.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'studio.no_person'").get().n, 0);
    assert.equal(one.env.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'studio.photo_facts' AND detail LIKE '%\"character\":true%'").get().n, 1);
  } finally { p.restore(); }

  // Not marked (forgotten, or "No"): the bear is refused before any charge, and the sentence says what to choose.
  const two = await setup(reads(man, bear), "ted2@example.com");
  p = wan();
  try {
    for (const c of [undefined, "none"]) {
      const r = await two.order(c);
      assert.equal(r.status, 400, r.text);
      assert.equal(r.json.code, "no_person");
      assert.equal(r.json.error, `Person 2's photo looks like a character, not a real person. If it is one, choose Person 2 under "Is anyone a character?" — nothing was charged.`);
    }
    assert.equal(credits(two.env, two.id), 100, "nothing was charged");
    assert.ok(!p.sent.some((s) => s.url.includes("/alibaba/")), "WaveSpeed was never asked to make anything");
  } finally { p.restore(); }

  // Marked, and the check reads the bear as a person: Ted's words all the same, and the audit says it was a character.
  const four = await setup(reads(man, man), "ted4@example.com");
  p = wan();
  try {
    const r = await four.order("person2");
    assert.equal(r.status, 200, r.text);
    assert.equal(p.sent.find((x) => x.url.endsWith("/alibaba/wan-3.0-prime/video-edit")).body.prompt, tedWords);
    assert.equal(four.env.DB.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'studio.photo_facts' AND detail LIKE '%\"character\":true%'").get().n, 1);
  } finally { p.restore(); }

  // Marked, but the check cannot answer: Ted's words all the same (they follow the choice, not the check).
  const three = await setup(reads(new Error("Capacity temporarily exceeded")), "ted3@example.com");
  p = wan();
  try {
    const r = await three.order("person2");
    assert.equal(r.status, 200, r.text);
    assert.equal(p.sent.find((x) => x.url.endsWith("/alibaba/wan-3.0-prime/video-edit")).body.prompt, tedWords);
  } finally { p.restore(); }
});
