/**
 * kleo_adapt_prompt and the `treatment` argument of kleo_create_video, driven through a real MCP client over an
 * in-memory transport: the tool descriptions, the arguments, the answers an assistant reads. Same recipe as
 * test/credits.test.mjs (esbuild bundle + a D1 look-alike on node:sqlite); the model is a fake.
 * Run: node --test test/mcp-adapt.test.mjs   (never calls Workers AI)
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { TREATMENT_FIXTURE } from "./fixtures/treatment.mjs";
import { MASTER_PROMPT } from "../src/treatment.ts";

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
    stdin: { contents: `export { buildServer } from "./src/mcp.ts"; export { handleAdmin } from "./src/internal.ts"; export * from "./src/db.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022", logLevel: "silent",
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

/** A fake Workers AI: `answer(inputs, n)` returns the model's raw output for the n-th call, or throws. */
function fakeAi(answer) {
  const calls = [];
  return { calls, async run(model, inputs) { calls.push({ model, inputs }); const out = await answer(inputs, calls.length); return { response: out, usage: { prompt_tokens: 3000, completion_tokens: 1200, total_tokens: 4200 } }; } };
}

async function studio(ai, extra = {}) {
  const env = {
    DB: new FakeD1(), OAUTH_KV: new FakeKV(), AI: ai, RENDER_BACKEND: "manual", PUBLIC_URL: "http://kleo.test", INTERNAL_SECRET: "s3cret",
    MAX_CONCURRENT_GPUS: "5", MAX_JOBS_PER_USER: "2", MAX_JOBS_PER_DAY: "500", JOB_TIMEOUT_MIN: "120", FREE_FILMS: "1", RESULT_TTL_DAYS: "7",
    AI_MODEL: "@cf/meta/llama-4-scout-17b-16e-instruct", ...extra,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const user = await m.createUser(env, { id: "u_test", email: "t@example.com", credits: 70, inviteCode: null });
  const server = m.buildServer(env, user, "http://kleo.test");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test-assistant", version: "1.0.0" });
  await client.connect(ct);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { ...r, text: r.content?.map((c) => c.text ?? "").join("\n") ?? "" }; };
  const audit = async (event) => (await env.DB.prepare("SELECT detail FROM audit WHERE event = ? ORDER BY id").bind(event).all()).results.map((r) => JSON.parse(r.detail));
  return { env, user, client, call, audit };
}

test("the tools an assistant sees: adapt first, and create_video takes the treatment back", async () => {
  const s = await studio(fakeAi(() => TREATMENT_FIXTURE(60)));
  const tools = (await s.client.listTools()).tools;
  const adapt = tools.find((t) => t.name === "kleo_adapt_prompt");
  assert.ok(adapt, "kleo_adapt_prompt is registered");
  assert.match(adapt.description, /TREATMENT/);
  assert.ok(adapt.inputSchema.properties.prompt && adapt.inputSchema.properties.language, "prompt and language are arguments");
  const create = tools.find((t) => t.name === "kleo_create_video");
  assert.ok(create.inputSchema.properties.treatment, "kleo_create_video takes a treatment");
  assert.match(create.inputSchema.properties.treatment.description, /kleo_adapt_prompt/);
});

test("kleo_account quotes the film's price and the real state of the shop, never a sentence typed by hand", async () => {
  // 13 September: a new account with 2 free credits was told "1 credit = 1 Short" and "card payments are not open
  // yet" while a film cost 7 and the account page was selling packs. An assistant repeated both to the user.
  const closed = await studio(fakeAi(() => TREATMENT_FIXTURE(60)));
  const a = await closed.call("kleo_account", {});
  const d = a.structuredContent;
  assert.equal(d.film_credits, 7);
  assert.equal(d.free_tier, "1 free film on sign-up (7 credits), no signup form");
  assert.equal(d.payments_open, false, "no Stripe links configured: the shop is closed and the tool says so");
  assert.match(a.text, /A film costs 7 credits up to 90 seconds/);
  assert.match(a.text, /7 credits per film up to 90 seconds, 21 up to 5 minutes, \+7 per extra minute/);
  assert.doesNotMatch(a.text, /1 credit = 1 Short|free while it is in beta/);
  assert.match(a.text, /payments are paused/);

  const live = { STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_LINK_5: "https://buy.stripe.com/a", STRIPE_LINK_15: "https://buy.stripe.com/b", STRIPE_LINK_40: "https://buy.stripe.com/c" };
  const open = await studio(fakeAi(() => TREATMENT_FIXTURE(60)), live);
  const b = await open.call("kleo_account", {});
  assert.match(b.text, /Credit packs are on the account page, paid through Stripe \(from 5 EUR for 10 credits/);
  assert.equal(b.structuredContent.payments_open, true, "with live links and a webhook secret the tool reports the shop open");
});

test("a request with no length is answered with the question and no model call", async () => {
  const ai = fakeAi(() => { throw new Error("must not be called"); });
  const s = await studio(ai);
  const r = await s.call("kleo_adapt_prompt", { prompt: "Create a video about accuracy in medicine" });
  assert.ok(!r.isError);
  assert.equal(r.structuredContent.treatment, null);
  assert.equal(r.structuredContent.ready_to_render, false);
  assert.match(r.text, /How long should the video be/);
  assert.equal(ai.calls.length, 0);
  assert.deepEqual(await s.audit("treatment.adapt"), [], "nothing is counted against the day");
});

test("a complete request gets a treatment written under the master prompt, hot, and the assistant is told what to do with it", async () => {
  const ai = fakeAi(() => TREATMENT_FIXTURE(60));
  const s = await studio(ai);
  const r = await s.call("kleo_adapt_prompt", { prompt: "Create a video about accuracy in medicine", duration_s: 60, format: "16:9" });
  assert.ok(!r.isError, r.text);
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].inputs.messages[0].content, MASTER_PROMPT);
  assert.equal(ai.calls[0].inputs.temperature, 0.85);
  assert.match(ai.calls[0].inputs.messages[1].content, /accuracy in medicine[\s\S]*60 seconds, narrated in English/);
  const t = r.structuredContent.treatment;
  assert.equal(t.logline, TREATMENT_FIXTURE(60).logline);
  assert.equal(t.acts.reduce((n, a) => n + a.seconds, 0), 60);
  assert.match(t.variation, /^[a-z-]+\/[a-z-]+$/);
  assert.equal(r.structuredContent.ready_to_render, true);
  assert.match(r.text, /Treatment written/);
  assert.match(r.text, /Kleo decided on its own/);
  assert.match(r.text, /NEXT STEP: tell the user the logline and the decisions/);
  const rows = await s.audit("treatment.adapt");
  assert.equal(rows.length, 1); assert.equal(rows[0].ok, true); assert.ok(rows[0].est_neurons > 0);
});

test("when the model is down the tool says so and points at kleo_create_video; it never throws", async () => {
  const s = await studio(fakeAi(() => { throw new Error("429 4006 you have used up your daily free allocation"); }));
  const r = await s.call("kleo_adapt_prompt", { prompt: "A film about lighthouse keepers, 45 seconds" });
  assert.ok(!r.isError, "not an error: the video can still be made");
  assert.equal(r.structuredContent.treatment, null);
  assert.equal(r.structuredContent.note, "model unavailable");
  assert.match(r.text, /could not write the treatment just now[\s\S]*call kleo_create_video with the prompt/);
  const rows = await s.audit("treatment.adapt");
  assert.equal(rows.length, 1); assert.equal(rows[0].transient, true);
});

test("the daily cap refuses the next call in words and leaves the road to kleo_create_video open", async () => {
  const s = await studio(fakeAi(() => TREATMENT_FIXTURE(45)), { ADAPT_MAX_PER_DAY: "1" });
  const first = await s.call("kleo_adapt_prompt", { prompt: "A film about lighthouse keepers, 45 seconds" });
  assert.ok(!first.isError && first.structuredContent.treatment);
  const second = await s.call("kleo_adapt_prompt", { prompt: "A film about lighthouse keepers, 45 seconds" });
  assert.ok(second.isError);
  assert.match(second.text, /asked for 1 treatment today, and the limit is 1 a day[\s\S]*kleo_create_video[\s\S]*Nothing was charged/);
});

test("kleo_create_video keeps the treatment the user approved and says so; a broken one is refused before any charge", async () => {
  const s = await studio(fakeAi(() => TREATMENT_FIXTURE(45)));
  const a = await s.call("kleo_adapt_prompt", { prompt: "A film about lighthouse keepers, 45 seconds", format: "9:16" });
  const t = a.structuredContent.treatment;
  const bad = await s.call("kleo_create_video", { prompt: "A film about lighthouse keepers", duration_s: 45, format: "9:16", treatment: { ...t, logline: "no", acts: [] } });
  assert.ok(bad.isError);
  assert.match(bad.text, /The treatment has \d+ problems \(nothing was charged\)[\s\S]*- logline:[\s\S]*- acts: 0/);
  assert.equal((await m.getUser(s.env, "u_test")).credits, 70, "a refused treatment moves no credits");
  const ok = await s.call("kleo_create_video", { prompt: "A film about lighthouse keepers", duration_s: 45, format: "9:16", treatment: t });
  assert.ok(!ok.isError, ok.text);
  assert.match(ok.text, /Planned under your treatment: "A stolen car/);
  const job = await m.getUserJob(s.env, "u_test", ok.structuredContent.job_id);
  const params = JSON.parse(job.params);
  assert.equal(params.treatment.logline, t.logline);
  assert.equal(params.treatment.acts.reduce((n, x) => n + x.seconds, 0), 45, "fitted to the length the video was priced at");
  assert.equal(params.treatment.variation, t.variation, "the draw travels with the job");
  const created = (await s.audit("job.created")).at(-1);
  assert.equal(created.treatment, "client");
  // Without one, the answer says Kleo writes it and how to see it next time.
  const plain = await s.call("kleo_create_video", { prompt: "A film about lighthouse keepers", duration_s: 45, format: "9:16" });
  assert.ok(!plain.isError, plain.text);
  assert.match(plain.text, /Kleo writes the film's treatment itself while planning \(call kleo_adapt_prompt first/);
});

/* ------------------------------------------------------------------ the admin route: the measurement without a laptop */

test("POST /internal/admin/treatment writes N treatments on the Worker's own model and measures their distance", async () => {
  let n = 0;
  const ai = fakeAi(() => { n++; const t = TREATMENT_FIXTURE(60); if (n === 2) { t.logline = "A lighthouse keeper counts the ships that never come back."; t.prose = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: fog, brass, salt, a lamp turning over black water and a man who writes the names down. `).join(""); } return t; });
  const s = await studio(ai);
  const post = (body, secret = "s3cret") => m.handleAdmin(new Request("http://kleo.test/internal/admin/treatment", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }), s.env);
  assert.equal((await post({ prompt: "A film about lighthouse keepers", n: 2 }, "wrong")).status, 401);
  assert.equal((await post({ prompt: "short" })).status, 400);
  const r = await (await post({ prompt: "A film about lighthouse keepers", duration_s: 60, n: 2 })).json();
  assert.equal(r.ok, true); assert.equal(r.written, 2); assert.equal(ai.calls.length, 2);
  assert.equal(r.treatments.length, 2);
  assert.ok(r.distance.min > 0.3 && r.distance.min <= 1, `two different proses are far apart, got ${JSON.stringify(r.distance)}`);
  assert.equal(r.draws.length, 2);
  assert.ok(r.neurons > 0);
  const rows = await s.audit("admin.treatment");
  assert.equal(rows.length, 1); assert.equal(rows[0].written, 2);
  assert.deepEqual(await s.audit("treatment.adapt"), [], "never counted against an account");
  // The model down: the answer says so, with the reason, and is not an HTTP error.
  const down = await studio(fakeAi(() => { throw new Error("429 4006 daily free allocation"); }));
  const dr = await (await m.handleAdmin(new Request("http://kleo.test/internal/admin/treatment", { method: "POST", headers: { authorization: "Bearer s3cret", "content-type": "application/json" }, body: JSON.stringify({ prompt: "A film about lighthouse keepers" }) }), down.env)).json();
  assert.equal(dr.ok, false); assert.equal(dr.written, 0); assert.equal(dr.transient, true); assert.match(dr.problems[0][0], /4006/);
});
