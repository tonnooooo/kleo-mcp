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
  assert.deepEqual(me.allowedImages, ["nano-banana-2.1", "nano-banana-2", "seedream-5", "flux-2-pro", "flux-3"]);
  const locked = await call(env, "/api/generate", { method: "POST", cookie, body: { kind: "image", prompt: "a fox", settings: { model: "nano-banana-pro" } } });
  assert.equal(locked.json.code, "locked");
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
    assert.match(p.sent.filter((s) => s.url.endsWith("/v1/task/submit")).at(-1).body.input.first_frame, /\/media\/u\/up_/);
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
    assert.match(g.error, /^The video model won't make this one: it recognised characters, people or music protected by copyright/);
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
  // A NOBODY-checked address on an account that was USED is never handed over: sign in to it, then connect.
  const used = await signUp(env, "carla@gmail.com");
  const usedId = (await call(env, "/api/me", { cookie: used })).json.id;
  env.DB.db.exec(`INSERT INTO studio_chats (id, user_id, title) VALUES ('c_used00000001', '${usedId}', 'x')`);
  const refused = await social(env, "google", { sub: "g-carla", aud: "gid", email: "carla@gmail.com", email_verified: true });
  assert.equal(refused.location, "/?signin_error=claimed_google");
  assert.equal(refused.cookie, null);
  assert.equal((await call(env, "/api/me", { cookie: used })).json.id, usedId, "the used account is untouched by the refusal");
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
    assert.match(avatar.body.input.sound_file, /^https:\/\/app\.kleo\.test\/media\/u\/up_.*sig=/, "the spoken clip, by signed link");
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
    assert.match(page.res.headers.get("content-security-policy"), /script-src 'self' https:\/\/challenges\.cloudflare\.com https:\/\/static\.cloudflareinsights\.com;/, "the app runs only its own scripts (Turnstile and Cloudflare's analytics aside)");
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

