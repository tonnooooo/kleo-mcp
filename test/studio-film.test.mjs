/**
 * Kleo films ordered from Kleo Studio (src/studio-film.ts on the MCP Worker): the same prices and rules as the MCP
 * tool — a film for accounts that paid, the animatic for every account, the open-jobs limit, nothing charged on a
 * refusal. Bundled with esbuild and run on a D1 look-alike (node:sqlite) with every migration applied.
 * Run: node --test test/studio-film.test.mjs
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
