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

test("pictures: a set of four, two fail, the share they stood for comes back; each picture is an upload", async () => {
  const env = newEnv();
  const cookie = await signUp(env);
  const me = (await call(env, "/api/me", { cookie })).json;
  assert.deepEqual(me.allowedImages, ["nano-banana-2", "seedream-5", "flux-2-pro"]);
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
    const done = await call(env, `/api/generations/${r.json.generation.id}`, { cookie });
    assert.equal(done.json.generation.status, "done", done.text);
    assert.equal(done.json.generation.outputs.length, 2);
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

test("password reset: off without an e-mail key; with one, a one-time link that dies when used", async () => {
  const off = newEnv();
  assert.equal((await call(off, "/api/auth/forgot", { method: "POST", body: { email: "a@b.co" } })).status, 503);
  const env = newEnv({ RESEND_API_KEY: "re_x" });
  await signUp(env, "rita@example.com");
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
  const stateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
  const p = fakeProvider((u, init) => {
    if (u.includes("oauth2.googleapis.com/token") || u.includes("login.microsoftonline.com/common/oauth2/v2.0/token")) {
      assert.match(String(init.body), /client_secret=/);
      return ok({ id_token: jwt(claims) });
    }
    return new Response("?", { status: 404 });
  });
  try {
    const cb = await worker.fetch(new Request(`https://app.kleo.test/auth/${key}/callback?code=c1&state=${tamper ? "st_forged" : state}`, { headers: { cookie: [stateCookie, cookie].filter(Boolean).join("; ") } }), env, ctx);
    const session = (cb.headers.getSetCookie?.() ?? [cb.headers.get("set-cookie") ?? ""]).find((c) => c.startsWith("kleo_studio=") && !c.startsWith("kleo_studio=;"));
    return { to, location: cb.headers.get("location"), cookie: session ? session.split(";")[0] : null };
  } finally { p.restore(); }
}
const MS_PERSONAL = "9188040d-6c67-4c5b-b112-36a304b66dad";

test("Google and Microsoft: off until configured; new accounts; verified e-mails join the existing account, unverified ones never do", async () => {
  const off = newEnv();
  assert.deepEqual((await call(off, "/api/config")).json.social, []);
  const env = newEnv({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs", MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "ms" });
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
  assert.equal((await call(env, "/api/me", { cookie: personal.cookie })).json.id, pwId, "a personal Microsoft account's address is verified: same person");
  assert.equal((await call(env, "/api/auth/signup", { method: "POST", body: { email: "luca@gmail.com", password: "long enough pw" } })).json.code, "use_google");
});

test("linking: the signed-in account gets Google; an account another person uses is refused; no session, no link", async () => {
  const env = newEnv({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs", MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "ms" });
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
  assert.equal(price.json.credits, 3, "max(9, 8 + 5) = 13 s at the reference rate");
  const p = fakeProvider(() => ok({ id: "task_r" }));
  try {
    const r = await call(env, "/api/generate", { method: "POST", cookie, body: { prompt: "a robot copies the dance of video 1", imageIds: [v.id], preset: "orbit-360", settings: { model: "seedance-2.0-fast", duration: 5, resolution: "720p" } } });
    assert.equal(r.status, 200, r.text);
    const input = p.sent.find((s) => s.url.endsWith("/v1/task/submit")).body.input;
    assert.equal(input.reference_videos.length, 1);
    assert.match(input.prompt, /360-degree orbit/);
    assert.equal(credits(env, id), 97);
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
    "/index.html": "<!doctype html><title>Kleo MCP</title>", "/pricing/index.html": "<!doctype html><title>Pricing</title>",
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
    assert.equal(home.res.headers.get("content-security-policy"), null, "the raw host's sandbox header is not passed on");
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

test("the app shell is served for any page path", async () => {
  const env = newEnv();
  const r = await call(env, "/c/c_whatever");
  assert.equal(r.status, 200);
  assert.match(r.text, /app/);
});
