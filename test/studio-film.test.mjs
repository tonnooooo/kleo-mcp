/**
 * Kleo films ordered from Kleo Studio (src/studio-film.ts on the MCP Worker): the same prices and rules as the MCP
 * tool — a film for accounts that paid, the animatic for every account, the open-jobs limit, nothing charged on a
 * refusal. Bundled with esbuild and run on a D1 look-alike (node:sqlite) with every migration applied.
 * Run: node --test test/studio-film.test.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FakeD1 } from "./fake-d1.mjs";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The D1 stand-in is test/fake-d1.mjs: meta.changes as D1 counts it, the rows a trigger changes included.
class FakeKV { constructor() { this.m = new Map(); } async put(k, v) { this.m.set(k, v); } async get() { return null; } async delete(k) { this.m.delete(k); } }

let m;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export * from "./src/studio-film.ts"; export * from "./src/db.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"],
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

function newEnv() {
  const env = {
    DB: new FakeD1(), OAUTH_KV: new FakeKV(), RENDER_BACKEND: "manual", PUBLIC_URL: "http://kleo.test", INTERNAL_SECRET: "s3cret",
    MAX_CONCURRENT_GPUS: "5", MAX_JOBS_PER_USER: "2", JOB_TIMEOUT_MIN: "120", FREE_CREDITS: "7", RESULT_TTL_DAYS: "7", MOCK_TOTAL_SECONDS: "60",
    MAX_JOBS_PER_DAY: "500", STORYBOARD_FIXTURE: "example",
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const call = (env, path, body, secret = "s3cret") => m.handleStudioFilm(new Request(`https://kleo-mcp${path}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
const credits = (env, id) => env.DB.db.prepare("SELECT credits FROM users WHERE id = ?").get(id).credits;

test("only Studio (the secret) may order; a quote says what this account may make", async () => {
  const env = newEnv();
  await m.createUser(env, { id: "u_free", email: "f@example.com", credits: 12, inviteCode: null });
  assert.equal((await call(env, "/internal/studio/film/quote", { userId: "u_free", duration_s: 60 }, "nope")).status, 401);
  const q = await (await call(env, "/internal/studio/film/quote", { userId: "u_free", duration_s: 60, style: "realistic" })).json();
  assert.equal(q.has_paid, false);
  assert.equal(q.film.allowed, false, "a film is for accounts that paid");
  assert.equal(q.film.credits, 40, "60 s at 1.5 s per credit");
  assert.equal(q.animatic.allowed, true);
  assert.equal(q.animatic.credits, 10);
});

test("an unpaid account orders the animatic; the film is refused with nothing charged; a paid account gets the film", async () => {
  const env = newEnv();
  await m.createUser(env, { id: "u_a", email: "a@example.com", credits: 60, inviteCode: null });
  const film = await call(env, "/internal/studio/film", { userId: "u_a", prompt: "A lighthouse keeper befriends a whale", duration_s: 30, format: "9:16", style: "animation", product: "film", music: "yes", subtitles: false, language: "en" });
  assert.notEqual(film.status, 200);
  assert.equal(credits(env, "u_a"), 60, "nothing charged on a refusal");
  const ani = await call(env, "/internal/studio/film", { userId: "u_a", prompt: "A lighthouse keeper befriends a whale", duration_s: 30, format: "9:16", style: "animation", product: "animatic", music: "yes", subtitles: false, language: "en" });
  assert.equal(ani.status, 200, await ani.clone().text());
  const a = await ani.json();
  assert.equal(a.job.product, "animatic");
  assert.equal(credits(env, "u_a"), 60 - a.job.credits);
  env.DB.db.exec("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('cs_x', 'u_a', 10, 500, 'eur', 'paid', 'test')");
  env.DB.db.exec("UPDATE users SET credits = 100 WHERE id = 'u_a'");
  const ok = await call(env, "/internal/studio/film", { userId: "u_a", prompt: "A lighthouse keeper befriends a whale", duration_s: 30, format: "16:9", style: "realistic", product: "film", music: "no", subtitles: true, language: "it" });
  assert.equal(ok.status, 200, await ok.clone().text());
  const f = await ok.json();
  assert.equal(f.job.product, "film");
  assert.equal(f.job.credits, 20);
  assert.equal(f.credits_left, 80);
  const busy = await call(env, "/internal/studio/film", { userId: "u_a", prompt: "Another film about the sea", duration_s: 15, product: "film" });
  assert.equal(busy.status, 429, "two films open is the limit");
});

test("14 October 2026: the route answers only over Studio's binding host; the public address is a 404 even with the secret", async () => {
  const env = newEnv();
  await m.createUser(env, { id: "u_pub", email: "p@example.com", credits: 60, inviteCode: null });
  const at = (host, path, body, secret = "s3cret") => m.handleStudioFilm(new Request(`https://${host}${path}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
  const quote = await at("mcp.kleooai.com", "/internal/studio/film/quote", { userId: "u_pub", duration_s: 30 });
  assert.equal(quote.status, 404, "a leaked secret alone must not reach the route from the internet");
  assert.equal((await at("mcp.kleooai.com", "/internal/studio/film/quote", { userId: "u_pub", duration_s: 30 }, "nope")).status, 404, "and the public door says nothing about the secret either");
  const order = await at("mcp.kleooai.com", "/internal/studio/film", { userId: "u_pub", prompt: "A lighthouse keeper befriends a whale", duration_s: 30, product: "animatic" });
  assert.equal(order.status, 404);
  assert.equal(credits(env, "u_pub"), 60, "nothing ordered, nothing charged");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
  assert.equal((await at("kleo-mcp", "/internal/studio/film/quote", { userId: "u_pub", duration_s: 30 })).status, 200, "the binding's own host still works");
});

test("14 October 2026: a length that is not a number is refused before any price, on the quote and on the order", async () => {
  const env = newEnv();
  await m.createUser(env, { id: "u_len", email: "l@example.com", credits: 60, inviteCode: null });
  // JSON has no NaN (JSON.stringify writes null, which is "no length", the default); "abc" and 1e999 (Infinity once
  // parsed) are what a caller can actually send, so the raw body is written by hand here.
  const raw = (path, body) => m.handleStudioFilm(new Request(`https://kleo-mcp${path}`, { method: "POST", headers: { authorization: "Bearer s3cret", "content-type": "application/json" }, body }), env);
  for (const len of ['"abc"', "1e999", '"Infinity"']) {
    const q = await raw("/internal/studio/film/quote", `{"userId":"u_len","duration_s":${len}}`);
    assert.equal(q.status, 400, `quote with duration_s ${len}`);
    assert.match((await q.json()).error, /number of seconds/);
    const o = await raw("/internal/studio/film", `{"userId":"u_len","prompt":"A lighthouse keeper befriends a whale","product":"animatic","duration_s":${len}}`);
    assert.equal(o.status, 400, `order with duration_s ${len}`);
  }
  assert.equal(credits(env, "u_len"), 60, "nothing charged");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0, "and no job written");
});
