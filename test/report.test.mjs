/**
 * What Kleo says about its own videos (27 September 2026, src/report.ts, worker/kleo_report.py): the worker uploads
 * report.json beside the deliverables, the user never gets a link to it, and two admin routes read it back. No Worker
 * runtime: the sources are bundled with esbuild and run against the D1 look-alike on node:sqlite with every migration
 * applied, and the files go through the KV branch of storage.ts, so the real SQL and the real upload rule are exercised.
 * Run: node --test test/report.test.mjs
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
  async batch(stmts) { return stmts.map((s) => ({ success: true, meta: { changes: Number(s.stmt.run(...s.args).changes) } })); }
}
class FakeKV {
  constructor() { this.m = new Map(); }
  async put(k, v, o) { this.m.set(k, { v, o }); }
  async get() { return null; }
  async getWithMetadata(k) { const e = this.m.get(k); return { value: e?.v ?? null, metadata: e?.o?.metadata ?? null }; }
  async delete(k) { this.m.delete(k); }
}

let m;
before(async () => {
  const r = await esbuild.build({
    stdin: {
      contents: `export * from "./src/db.ts"; export * from "./src/report.ts"; export { putFile } from "./src/storage.ts";
        export { resultLinks } from "./src/jobs.ts"; export { handleAdmin, handleInternal } from "./src/internal.ts";`,
      resolveDir: ROOT, loader: "ts",
    },
    alias: { "@cloudflare/workers-oauth-provider": join(ROOT, "test/fixtures/oauth-provider-stub.mjs") },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"],
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

async function newEnv() {
  const env = { DB: new FakeD1(), OAUTH_KV: new FakeKV(), RENDER_BACKEND: "manual", PUBLIC_URL: "http://kleo.test", INTERNAL_SECRET: "s3cret" };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  await m.createUser(env, { id: "u1", email: "u1@anon.kleo.invalid", credits: 20, inviteCode: null });
  return env;
}

function addJob(env, id, createdAt, params = { duration_s: 30, format: "16:9", language: "en" }) {
  env.DB.db.prepare("INSERT INTO jobs (id, user_id, template, prompt, params, state, credits, worker_secret, created_at, expires_at) VALUES (?, 'u1', 'film', 'a lighthouse', ?, 'done', 10, 'wk_secret', ?, '2026-10-04T00:00:00.000Z')")
    .run(id, JSON.stringify(params), createdAt);
}

async function addFile(env, jobId, name, body) {
  const key = `renders/${jobId}/${name}`;
  const size = await m.putFile(env, key, body, name.endsWith(".json") ? "application/json" : "video/mp4");
  await m.setFile(env, { job_id: jobId, name, key, size, content_type: "application/octet-stream" });
}

const REPORT = {
  version: 1, ordered_s: 30, video: { duration: 39.4, width: 3840, height: 2160, rate: 60, frames: 2364 },
  audio: { lufs: -16.1, true_peak: -1.6, voice_db: -18, pauses: [{ start: 4.1, seconds: 1.8, bed_db: -120 }], bed_db: -120, longest_pause_s: 1.8 },
  cuts: { count: 9, at: [], shortest_s: 0.9, short: [] }, frozen_s: 0, black: [], subtitles: null,
  problems: ["39.4 s delivered for a 30 s order (+9.4 s)", "1 silent pause(s) of 1.2 s or more: 1.8 s at 4.1 s"],
};

const admin = (env, path, secret = "s3cret") =>
  m.handleAdmin(new Request(`http://kleo.test${path}`, { headers: { authorization: `Bearer ${secret}` } }), env);

test("the report of one video comes back whole, and only with the operator's secret", async () => {
  const env = await newEnv();
  addJob(env, "gt_one", "2026-09-27T01:00:00.000Z");
  await addFile(env, "gt_one", "report.json", JSON.stringify(REPORT));
  const r = await admin(env, "/internal/admin/report?job_id=gt_one");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), REPORT);
  assert.equal((await admin(env, "/internal/admin/report?job_id=gt_one", "wrong")).status, 401);
  assert.equal((await admin(env, "/internal/admin/report?job_id=gt_none")).status, 404, "a video made before the report existed says so");
  assert.equal((await admin(env, "/internal/admin/report")).status, 400);
});

test("the latest reports: newest first, cut down to the order, the length and the problems", async () => {
  const env = await newEnv();
  addJob(env, "gt_old", "2026-09-26T01:00:00.000Z");
  addJob(env, "gt_new", "2026-09-27T01:00:00.000Z", { duration_s: 15, product: "animatic" });
  addJob(env, "gt_none", "2026-09-27T02:00:00.000Z");             // no report: not listed
  await addFile(env, "gt_old", "report.json", JSON.stringify(REPORT));
  await addFile(env, "gt_new", "report.json", JSON.stringify({ ...REPORT, ordered_s: 15, video: { ...REPORT.video, duration: 15.2 }, problems: [] }));
  const body = await (await admin(env, "/internal/admin/reports?limit=5")).json();
  assert.deepEqual(body.reports.map((x) => x.job_id), ["gt_new", "gt_old"]);
  assert.equal(body.reports[0].product, "animatic");
  assert.equal(body.reports[0].duration_s, 15.2);
  assert.deepEqual(body.reports[0].problems, []);
  assert.equal(body.reports[1].ordered_s, 30);
  assert.equal(body.reports[1].longest_pause_s, 1.8);
  assert.equal(body.reports[1].problems.length, 2);
});

test("the user's links never include the report", async () => {
  const env = await newEnv();
  addJob(env, "gt_links", "2026-09-27T01:00:00.000Z");
  await addFile(env, "gt_links", "video.mp4", "MP4");
  await addFile(env, "gt_links", "report.json", JSON.stringify(REPORT));
  const job = await m.getJob(env, "gt_links");
  const links = await m.resultLinks(env, "http://kleo.test", job);
  assert.ok(links.video_url, "the film is linked");
  assert.equal(links.report_url, undefined, "the report is the operator's, not the user's");
});

test("the worker may upload report.json with its own secret", async () => {
  const env = await newEnv();
  addJob(env, "gt_up", "2026-09-27T01:00:00.000Z");
  env.DB.db.prepare("UPDATE jobs SET state = 'finishing' WHERE id = 'gt_up'").run();
  const put = (name) => m.handleInternal(new Request(`http://kleo.test/internal/jobs/gt_up/files/${name}`, {
    method: "PUT", headers: { authorization: "Bearer wk_secret", "content-type": "application/json" }, body: JSON.stringify(REPORT),
  }), env);
  const r = await put("report.json");
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await m.readReport(env, "gt_up"), REPORT);
  assert.equal((await put("other.json")).status, 400, "only the names the worker is allowed to write");
});
