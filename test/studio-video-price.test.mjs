/**
 * The video price factor (25 October 2026, the owner: "alza il costo dei template e delle creazioni video … da 6 crediti
 * per 480p fai 10, stessa cosa con le altre risoluzioni"): every video clip, every template and every app that makes a
 * video costs its credits × STUDIO_VIDEO_FACTOR ("5/3"), rounded up; pictures and sounds keep their price. Covers the
 * factor's parsing and rounding (6 → 10 exactly), the clip and app prices, the catalog the page draws, the price check
 * and the charge's own number, and the live setting in wrangler.studio.jsonc.
 * Run: node --test test/studio-video-price.test.mjs
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
import { MODELS, clipCredits, publicCatalog, raiseCredits, videoFactor } from "../src/studio/models.ts";
import { TOOLS, publicTools, toolCredits, toolFactor } from "../src/studio/tools.ts";
import { TRENDS, trendCostUsd } from "../src/studio/trends.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const F = videoFactor("5/3");
const clip = (model, resolution, duration) => ({ model, duration, resolution, aspect: "16:9", audio: true, imageRole: "none" });

test("the factor is read as a fraction; anything odd means no change", () => {
  assert.equal(F, 5 / 3);
  assert.equal(videoFactor("1.5"), 1.5);
  assert.equal(videoFactor(" 5 / 3 "), 5 / 3);
  for (const raw of [undefined, "", "abc", "0.5", "0", "20", "5/0", "-2"]) assert.equal(videoFactor(raw), 1, String(raw));
});

test("credits × 5/3, rounded up: 6 is exactly 10, never 11", () => {
  assert.deepEqual([1, 2, 3, 4, 6, 7, 9, 11, 21, 22, 27].map((c) => raiseCredits(c, F)), [2, 4, 5, 7, 10, 12, 15, 19, 35, 37, 45]);
  assert.equal(raiseCredits(6, 1), 6, "factor 1 changes nothing");
});

test("every video model at every resolution and length costs its old price × 5/3, rounded up", () => {
  for (const m of MODELS) for (const res of m.resolutions) for (const d of m.durations) {
    const before = clipCredits(clip(m.key, res, d), 1.6);
    assert.equal(clipCredits(clip(m.key, res, d), 1.6, 0, F), Math.ceil(before * 5 / 3 - 1e-9), `${m.key} ${res} ${d}s`);
  }
  // The examples the site quotes.
  assert.equal(clipCredits(clip("seedance-2.0-fast", "480p", 5), 1.6, 0, F), 4);
  assert.equal(clipCredits(clip("seedance-2.5", "720p", 5), 1.6, 0, F), 7);
  assert.equal(clipCredits(clip("veo-3.1-fast", "1080p", 8), 1.6, 0, F), 5);
  assert.equal(clipCredits(clip("veo-3.1", "1080p", 8), 1.6, 0, F), 12);
});

test("templates: a 15-second one at 480p goes from 6 to 10, and the other qualities the same way", () => {
  const garden = TRENDS.find((t) => t.key === "trend-garden-dunk");
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => [toolCredits(trendCostUsd(garden, q), 1.6), toolCredits(trendCostUsd(garden, q), 1.6, toolFactor(garden.key, F))]),
    [[6, 10], [11, 19], [22, 37]]);
});

test("apps: every app that makes a video takes the factor; pictures and sounds do not", () => {
  for (const t of TOOLS) assert.equal(toolFactor(t.key, F), t.output === "video" ? F : 1, t.key);
  assert.equal(toolFactor("nope", F), 1);
  const before = Object.fromEntries(publicTools(1.6).map((t) => [t.key, t.from]));
  for (const t of publicTools(1.6, F)) {
    assert.equal(t.from, t.output === "video" ? Math.ceil(before[t.key] * 5 / 3 - 1e-9) : before[t.key], t.key);
  }
});

test("the catalog the page draws prices every clip with the factor", () => {
  const was = publicCatalog(1.6, []), now = publicCatalog(1.6, [], F);
  for (let i = 0; i < was.length; i++) {
    for (const [res, byD] of Object.entries(was[i].prices)) for (const [d, c] of Object.entries(byD)) {
      assert.equal(now[i].prices[res][d], Math.ceil(c * 5 / 3 - 1e-9), `${was[i].key} ${res} ${d}`);
    }
  }
});

test("the live setting is 5/3", () => {
  const cfg = readFileSync(join(ROOT, "wrangler.studio.jsonc"), "utf8");
  assert.match(cfg, /"STUDIO_VIDEO_FACTOR": "5\/3"/);
});

// ── the Worker: what the page reads and what the charge uses are the same number ─────────────────────────────────
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
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith("https://cloudflare-dns.com/dns-query")
    ? new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }), { headers: { "content-type": "application/dns-json" } })
    : real(url, init));
}
let worker;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email"],
  });
  worker = (await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"))).default;
});
const ctx = { waitUntil() {}, passThroughOnException() {} };
function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: { put: async () => ({}), get: async () => null, delete: async () => {}, list: async () => ({ objects: [], truncated: false }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", EPHONE_API_KEY: "ek", FREE_CREDITS: "5", STUDIO_FREE_MODELS: "seedance-2.0-fast",
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
async function call(env, path, { method = "GET", body, cookie } = {}) {
  const h = { "x-kleo": "1", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/604.1" };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await worker.fetch(new Request(`https://app.kleo.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  return { status: res.status, json: await res.json().catch(() => null), res };
}

test("the Worker: the catalog, the template prices and the price check all carry the factor; without it nothing changes", async () => {
  for (const [over, clip5, tpl] of [[{ STUDIO_VIDEO_FACTOR: "5/3" }, 7, 10], [{}, 4, 6]]) {
    const env = newEnv(over);
    const cfg = (await call(env, "/api/config")).json;
    assert.equal(cfg.models.find((m) => m.key === "seedance-2.5").prices["720p"]["5"], clip5);
    assert.equal(cfg.tools.find((t) => t.key === "trend-garden-dunk").from, tpl);
    assert.equal(cfg.tools.find((t) => t.key === "face-swap").from, publicTools(1.6).find((t) => t.key === "face-swap").from, "a picture app keeps its price");
    const up = await call(env, "/api/auth/signup", { method: "POST", body: { email: `p${clip5}@example.com`, password: "long enough pw" } });
    assert.equal(up.status, 200);
    const cookie = (up.res.headers.get("set-cookie") ?? "").split(";")[0];
    const price = await call(env, "/api/price", { method: "POST", cookie, body: { settings: { model: "seedance-2.5", resolution: "720p", duration: 5 } } });
    assert.equal(price.json.credits, clip5);
  }
});
