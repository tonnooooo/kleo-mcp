/**
 * The Kleo mark on free renders, server side (src/mark.ts, src/jobs.ts createJob, 29 October 2026): the video of an
 * account that never paid is ordered with params.mark, frozen on the row, and handed to the box with the job spec, so
 * worker/kleo_mark.py burns "Made with Kleo" into it. A payment, a Kleo Creators Pro partner's plan, a Studio admin or
 * STUDIO_WATERMARK=off order it clean. No Worker runtime: the sources bundled with esbuild on a node:sqlite D1.
 * Run: node --test test/render-mark.test.mjs
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
const DAY = 86_400_000;

// The D1 stand-in is test/fake-d1.mjs: meta.changes as D1 counts it, the rows a trigger changes included.
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
    stdin: { contents: `export * from "./src/jobs.ts"; export * from "./src/internal.ts"; export * from "./src/db.ts"; export { marksAccount } from "./src/mark.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"],
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), OAUTH_KV: new FakeKV(), RENDER_BACKEND: "manual", PUBLIC_URL: "http://kleo.test", INTERNAL_SECRET: "s3cret",
    MAX_CONCURRENT_GPUS: "5", MAX_JOBS_PER_USER: "5", JOB_TIMEOUT_MIN: "120", FREE_CREDITS: "7", RESULT_TTL_DAYS: "7", MOCK_TOTAL_SECONDS: "60",
    MAX_JOBS_PER_DAY: "500", STORYBOARD_FIXTURE: "example",
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const sb = () => JSON.parse(readFileSync(join(ROOT, "scripts", "motion-demo", "samples", "venezia-16x9.json"), "utf8"));
const order = (extra = {}) => ({ template: "film", prompt: "L'acqua alta a Venezia, cento volte l'anno", duration_s: 30, format: "16:9", language: "it", style: "realistic", storyboard: sb(), ...extra });
const account = (env, id, credits = 100) => m.createUser(env, { id, email: `${id}@example.com`, credits, inviteCode: null });
const pay = (env, id) => env.DB.prepare("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES (?, ?, 10, 500, 'eur', 'paid', 'test')").bind(`cs_${id}`, id).run();
const created = async (env, id) => JSON.parse((await env.DB.prepare("SELECT detail FROM audit WHERE job_id = ? AND event = 'job.created'").bind(id).first()).detail);
async function spec(env, job) {
  const res = await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}`, { headers: { authorization: `Bearer ${job.worker_secret}` } }), env);
  assert.equal(res.status, 200);
  return res.json();
}

test("an animatic of an account that never paid is ordered with the mark, and the box is told so with the job spec", async () => {
  const env = newEnv();
  const free = await account(env, "u_free");
  const job = await m.createJob(env, free, order({ product: "animatic" }));
  assert.equal(JSON.parse(job.params).mark, true);
  assert.equal(JSON.parse((await m.getJob(env, job.id)).params).mark, true, "frozen on the row");
  assert.equal((await created(env, job.id)).mark, true, "and in the job.created audit");
  const s = await spec(env, job);
  assert.equal(s.params.mark, true, "GET /internal/jobs/:id hands it to the GPU box and to the finish box alike");
});

test("a paying account's film and animatic carry no mark key at all", async () => {
  const env = newEnv();
  const payer = await account(env, "u_payer");
  await pay(env, payer.id);
  for (const extra of [{}, { product: "animatic" }]) {
    const job = await m.createJob(env, await m.getUser(env, payer.id), order({ ...extra, prompt: `Venezia ${extra.product ?? "film"}, l'acqua alta` }));
    assert.equal("mark" in JSON.parse(job.params), false, JSON.stringify(extra));
    assert.equal("mark" in (await created(env, job.id)), false);
    assert.equal("mark" in (await spec(env, job)).params, false, "an old image and a new one read the same: no key, no mark");
  }
  // A refunded payment is no payment: the next animatic is marked again.
  await env.DB.prepare("UPDATE payments SET status = 'refunded' WHERE user_id = ?").bind(payer.id).run();
  const after = await m.createJob(env, await m.getUser(env, payer.id), order({ product: "animatic", prompt: "Venezia dopo il rimborso" }));
  assert.equal(JSON.parse(after.params).mark, true);
});

test("a Kleo Creators Pro partner, a Studio admin and the off switch order clean animatics", async () => {
  const env = newEnv();
  const partner = await account(env, "u_partner");
  env.DB.db.prepare(`INSERT INTO creators (user_id, status, level, platform, handle, handle_key, profile_url, bio_code, terms_version, terms_at, comp_until)
    VALUES (?, 'active', 'pro', 'tiktok', 'partner', 'partner', 'https://www.tiktok.com/@partner', 'KLEO-AB12', 'v1', ?, ?)`).run(partner.id, new Date().toISOString(), new Date(Date.now() + 20 * DAY).toISOString());
  const p = await m.createJob(env, partner, order({ product: "animatic" }));
  assert.equal("mark" in JSON.parse(p.params), false, "a plan from the program, with no Stripe payment");

  const admin = await account(env, "u_admin");
  env.STUDIO_ADMINS = "u_someone, u_admin";
  const a = await m.createJob(env, admin, order({ product: "animatic", prompt: "Venezia, il giro dell'admin" }));
  assert.equal("mark" in JSON.parse(a.params), false);

  const free = await account(env, "u_free");
  env.STUDIO_WATERMARK = "off";
  const off = await m.createJob(env, free, order({ product: "animatic", prompt: "Venezia, senza marchio" }));
  assert.equal("mark" in JSON.parse(off.params), false);
  delete env.STUDIO_WATERMARK;
  assert.equal(await m.marksAccount(env, free.id), true);
  assert.equal(await m.marksAccount(env, free.id, true), false, "a caller that already knows of a payment skips the read");
});

test("the box says what it did with /done: marked, failed with its reason, or nothing from an image older than the mark", async () => {
  const env = newEnv();
  const free = await account(env, "u_free");
  const payer = await account(env, "u_payer");
  await pay(env, payer.id);
  const rows = (id) => env.DB.db.prepare("SELECT event, detail FROM audit WHERE job_id = ? AND event LIKE 'job.mark%' ORDER BY id").all(id).map((r) => [r.event, JSON.parse(r.detail ?? "{}")]);
  async function done(job, body) {
    await m.updateJob(env, job.id, { state: "rendering", backend: "manual", instance_id: `gpu-${job.id}`, started_at: new Date().toISOString() });
    const res = await m.handleInternal(new Request(`http://kleo.test/internal/jobs/${job.id}/done`, { method: "POST", headers: { authorization: `Bearer ${job.worker_secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
    assert.equal(res.status, 200, await res.text());
  }
  const ok = await m.createJob(env, free, order({ product: "animatic", prompt: "Venezia, la prima prova" }));
  await done(ok, { cost_usd: 0.05, mark: { applied: true, why: null, seconds: 41.2 } });
  assert.deepEqual(rows(ok.id), [["job.marked", { seconds: 41.2 }]]);

  const bad = await m.createJob(env, free, order({ product: "animatic", prompt: "Venezia, la seconda prova" }));
  await done(bad, { cost_usd: 0.05, mark: { applied: false, why: "x".repeat(400), seconds: 3 } });
  const [[event, detail]] = rows(bad.id);
  assert.equal(event, "job.mark_failed");
  assert.equal(detail.why.length, 300, "the box's words, cut like every other box text");

  const old = await m.createJob(env, free, order({ product: "animatic", prompt: "Venezia, la terza prova" }));
  await done(old, { cost_usd: 0.05 });
  assert.deepEqual(rows(old.id), [["job.mark_missing", {}]], "a box that never heard of the mark");

  const clean = await m.createJob(env, await m.getUser(env, payer.id), order({ product: "animatic", prompt: "Venezia, il cliente" }));
  await done(clean, { cost_usd: 0.05 });
  assert.deepEqual(rows(clean.id), [], "a job ordered without the mark writes nothing about it");
  assert.equal(m.markOutcome({ params: "not json" }, { applied: true }), null);
});
