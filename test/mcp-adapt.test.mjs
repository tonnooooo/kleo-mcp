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
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"],
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

/** A fake Workers AI: `answer(inputs, n)` returns the model's raw output for the n-th call, or throws. */
function fakeAi(answer) {
  const calls = [];
  return { calls, async run(model, inputs) { calls.push({ model, inputs }); const out = await answer(inputs, calls.length); return { response: out, usage: { prompt_tokens: 3000, completion_tokens: 1200, total_tokens: 4200 } }; } };
}

async function studio(ai, extra = {}, opts = {}) {
  const env = {
    DB: new FakeD1(), OAUTH_KV: new FakeKV(), AI: ai, RENDER_BACKEND: "manual", PUBLIC_URL: "http://kleo.test", INTERNAL_SECRET: "s3cret",
    MAX_CONCURRENT_GPUS: "5", MAX_JOBS_PER_USER: "2", MAX_JOBS_PER_DAY: "500", JOB_TIMEOUT_MIN: "120", FREE_CREDITS: "7", RESULT_TTL_DAYS: "7",
    AI_MODEL: "@cf/meta/llama-4-scout-17b-16e-instruct", ...extra,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const user = await m.createUser(env, { id: "u_test", email: "t@example.com", credits: 70, inviteCode: null });
  // A paying customer (15 September: films are for accounts with a payment on record), unless a test says otherwise.
  if (opts.paid !== false) await env.DB.prepare("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status, raw_ref) VALUES ('cs_test_u_test', 'u_test', 10, 500, 'eur', 'paid', 'test')").run();
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
  assert.equal(d.film_credits, 30, "the active template's default film: 60 s");
  assert.equal(d.min_film_credits, 10);
  assert.equal(d.free_tier, "7 credits on sign-up, no signup form; they buy an animatic (5 credits, up to 60 s), and the shortest film is 10 credits and needs a pack (from 5 EUR: 7 + 10 = 17 credits, a 30-second Short)");
  assert.equal(d.has_paid, true, "this harness marks the tester as a paying customer");
  assert.equal(d.animatic_credits, 5);
  assert.equal(d.payments_open, false, "no Stripe links configured: the shop is closed and the tool says so");
  assert.match(a.text, /1 credit buys 2 seconds of film, 10 credits minimum: 15 credits for a 30-second Short, 30 for a minute, 150 for five minutes/);
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
  // THE INTAKE (14 September): every required item the request does not say is asked, in one message, never guessed.
  assert.match(r.text, /^INTAKE — what Kleo knows/m);
  assert.match(r.text, /- Subject: Create a video about accuracy in medicine \(from the request\)|- Subject: .*accuracy in medicine/);
  assert.match(r.text, /- Length: MISSING — ask/); assert.match(r.text, /- Format: MISSING — ask/); assert.match(r.text, /- Look: MISSING — ask/);
  assert.match(r.text, /- Audience: not given \(optional\)/);
  assert.match(r.text, /ASK THE USER NOW, in ONE message, in English/);
  assert.match(r.text, /1\. How long should it be\?/); assert.match(r.text, /2\. Where is it for: YouTube/); assert.match(r.text, /3\. How do you want it: realistic/);
  assert.match(r.text, /Optional, in the SAME message.*Who is it for\?/);
  assert.deepEqual(r.structuredContent.questions.length, 3); assert.equal(r.structuredContent.optional_questions.length, 3);
  assert.match(r.text, /do not fill any of these in yourself/);
  // Answered on the call, the same request is ready: nothing was assumed, everything came from the user.
  const again = await s.call("kleo_adapt_prompt", { prompt: "Create a video about accuracy in medicine", duration_s: 60, format: "16:9", style: "realistic", audience: "nurses", tone: "calm", must_keep: "the number 30%" });
  assert.equal(again.structuredContent.ready_to_render, true);
  assert.match(again.text, /- Length: 60s \(the user's answer\)/); assert.match(again.text, /- Look: realistic \(the user's answer\)/); assert.match(again.text, /- Must appear: the number 30% \(the user's answer\)/);
  assert.match(again.text, /- Audience: nurses/); assert.match(again.text, /- Tone: calm/);
  // Said in the request's own words, nothing is asked twice.
  const said = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about accuracy in medicine, 60 seconds, for YouTube" });
  assert.equal(said.structuredContent.ready_to_render, true, said.text);
  assert.match(said.text, /- Length: 60s \(from the request\)/); assert.match(said.text, /- Format: 16:9 \(from the request\)/); assert.match(said.text, /- Look: realistic \(from the request\)/);
  assert.equal(ai.calls.length, 0);
  assert.deepEqual(await s.audit("treatment.adapt"), [], "nothing is counted against the day");
});

test("a complete request gets a treatment written under the master prompt, hot, and the assistant is told what to do with it", async () => {
  const ai = fakeAi(() => TREATMENT_FIXTURE(60));
  const s = await studio(ai);
  const r = await s.call("kleo_adapt_prompt", { prompt: "Create a video about accuracy in medicine", duration_s: 60, format: "16:9", style: "realistic", author: "server" });
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

test("by default the tool hands the assistant the method and spends nothing: the assistant writes the treatment (the free road)", async () => {
  const ai = fakeAi(() => { throw new Error("must not be called"); });
  const s = await studio(ai);
  const r = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds", format: "9:16" });
  assert.ok(!r.isError, r.text);
  assert.equal(ai.calls.length, 0, "no model call on the server");
  assert.equal(r.structuredContent.author, "assistant"); assert.equal(r.structuredContent.treatment, null); assert.equal(r.structuredContent.ready_to_render, true);
  assert.match(r.structuredContent.variation, /^[a-z-]+\/[a-z-]+$/);
  assert.match(r.text, /WRITE THE TREATMENT YOURSELF/);
  assert.match(r.text, /You are the producer and showrunner of Kleo/, "the master prompt travels whole");
  assert.match(r.text, /TASK: write the TREATMENT/); assert.match(r.text, /45 seconds, narrated in English/);
  assert.match(r.text, new RegExp(`"variation":"${r.structuredContent.variation}"`));
  assert.deepEqual(await s.audit("treatment.adapt"), [], "nothing counted against the day's cap");
  assert.equal((await s.audit("treatment.method")).length, 1);
});

test("when the model is down the tool says so and points at kleo_create_video; it never throws", async () => {
  const s = await studio(fakeAi(() => { throw new Error("429 4006 you have used up your daily free allocation"); }));
  const r = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds, vertical", author: "server" });
  assert.ok(!r.isError, "not an error: the video can still be made");
  assert.equal(r.structuredContent.treatment, null);
  assert.equal(r.structuredContent.note, "model unavailable");
  assert.match(r.text, /could not write the treatment just now[\s\S]*call kleo_create_video with the prompt/);
  const rows = await s.audit("treatment.adapt");
  assert.equal(rows.length, 1); assert.equal(rows[0].transient, true);
});

test("the daily cap refuses the next call in words and leaves the road to kleo_create_video open", async () => {
  const s = await studio(fakeAi(() => TREATMENT_FIXTURE(45)), { ADAPT_MAX_PER_DAY: "1" });
  const first = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds, vertical", author: "server" });
  assert.ok(!first.isError && first.structuredContent.treatment);
  const second = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds, vertical", author: "server" });
  assert.ok(second.isError);
  assert.match(second.text, /asked for 1 treatment today, and the limit is 1 a day[\s\S]*kleo_create_video[\s\S]*Nothing was charged/);
});

test("kleo_create_video keeps the treatment the user approved and says so; a broken one is refused before any charge", async () => {
  const s = await studio(fakeAi(() => TREATMENT_FIXTURE(45)));
  const a = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds", format: "9:16", author: "server" });
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
  // A RETRY KEEPS ITS TREATMENT (19 September 2026): the same words again, same length, language and look, within
  // three hours and with no treatment handed in, is planned under the treatment of the job above — an assistant that
  // retries a failed video does not always send the treatment again, and the planner's own is the flat fallback.
  // (Two videos at a time per account: the earlier one is cancelled before each new one, which refunds it too.)
  await s.call("kleo_cancel_job", { job_id: ok.structuredContent.job_id });
  const again = await s.call("kleo_create_video", { prompt: "A film about lighthouse keepers", duration_s: 45, format: "9:16" });
  assert.ok(!again.isError, again.text);
  assert.match(again.text, /Planned under your treatment: "A stolen car/);
  const reused = (await s.audit("job.created")).at(-1);
  assert.equal(reused.treatment, "reused");
  assert.equal(reused.treatment_from, ok.structuredContent.job_id);
  assert.equal(JSON.parse((await m.getUserJob(s.env, "u_test", again.structuredContent.job_id)).params).treatment.logline, t.logline);
  // Other words, or another length: nothing to reuse, and the answer says Kleo writes it and how to see it next time.
  await s.call("kleo_cancel_job", { job_id: again.structuredContent.job_id });
  const plain = await s.call("kleo_create_video", { prompt: "A film about the keepers of a very different lighthouse", duration_s: 45, format: "9:16" });
  assert.ok(!plain.isError, plain.text);
  assert.match(plain.text, /Kleo writes the film's treatment itself while planning \(call kleo_adapt_prompt first/);
  assert.equal((await s.audit("job.created")).at(-1).treatment, "auto");
  await s.call("kleo_cancel_job", { job_id: plain.structuredContent.job_id });
  const longer = await s.call("kleo_create_video", { prompt: "A film about lighthouse keepers", duration_s: 60, format: "9:16" });
  assert.ok(!longer.isError, longer.text);
  assert.equal((await s.audit("job.created")).at(-1).treatment, "auto", "a treatment written for 45 seconds is not planned under at 60");
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

/* ------------------------------------------------------------------ the two looks (14 September) */

test("style names the look on every tool: the method is written for it, the guide draws it, create_video keeps it", async () => {
  const ai = fakeAi(() => { throw new Error("must not be called"); });
  const s = await studio(ai);
  const r = await s.call("kleo_adapt_prompt", { prompt: "A fox who learns to swim, 45 seconds", format: "9:16", style: "animation" });
  assert.ok(!r.isError, r.text);
  assert.equal(r.structuredContent.style, "animation");
  assert.match(r.text, /THE LOOK: ANIMATION, fixed by the request or the tool call/);
  assert.match(r.structuredContent.next, /style \(the look the treatment names\)/, "the assistant is told to pass the look on");
  assert.match(r.text, /- Look: animation, a 2D animated film/, "the brief says the look");
  const open = await s.call("kleo_adapt_prompt", { prompt: "A fox who learns to swim, 45 seconds", format: "9:16" });
  assert.equal(open.structuredContent.style, null, "no look named");
  assert.equal(open.structuredContent.ready_to_render, false, "the look is asked, never guessed (the intake, 14 September)");
  assert.match(open.text, /- Look: MISSING — ask/); assert.match(open.text, /1\. How do you want it: realistic \(filmed, cinematic photography\) or animation/);
  const drawn = await s.call("kleo_adapt_prompt", { prompt: "Un cartone animato su una volpe che impara a nuotare, 45 secondi", format: "9:16" });
  assert.equal(drawn.structuredContent.style, "animation", "the request named it: a cartoon is the animation look"); assert.match(drawn.text, /THE LOOK: ANIMATION/);
  const g = await s.call("kleo_storyboard_guide", { duration_s: 45, style: "animation", format: "9:16" });
  assert.ok(!g.isError, g.text);
  assert.equal(g.structuredContent.style, "animation"); assert.deepEqual(g.structuredContent.styles, ["realistic", "animation"]);
  assert.match(g.text, /KLEO STORYBOARD GUIDE — animation/); assert.match(g.text, /frame of a 2D animated feature film/);
  assert.match(g.text, /an ANIMATED film keeps this exact shape/);
  const t = { ...TREATMENT_FIXTURE(45), look: "animation" };
  const bad = await s.call("kleo_create_video", { prompt: "A fox who learns to swim", duration_s: 45, format: "9:16", style: "realistic", treatment: t });
  assert.ok(bad.isError); assert.match(bad.text, /look: the treatment says "animation" but the film was asked in "realistic"/);
  const ok = await s.call("kleo_create_video", { prompt: "A fox who learns to swim", duration_s: 45, format: "9:16", style: "animation", treatment: t });
  assert.ok(!ok.isError, ok.text);
  assert.match(ok.text, /Look: animation, a 2D animated film\./);
  const job = await m.getUserJob(s.env, "u_test", ok.structuredContent.job_id);
  assert.equal(JSON.parse(job.params).style, "animation"); assert.equal(JSON.parse(job.params).treatment.look, "animation");
  const byTreatment = await s.call("kleo_create_video", { prompt: "A fox who learns to swim", duration_s: 45, format: "9:16", treatment: t });
  assert.ok(!byTreatment.isError, byTreatment.text);
  assert.equal(JSON.parse((await m.getUserJob(s.env, "u_test", byTreatment.structuredContent.job_id)).params).style, "animation", "no style passed: the treatment's look is the film's");
});

test("an account that never paid is told it can order the animatic and not a film, by kleo_account and by kleo_create_video", async () => {
  // 15 September: the owner's rule — kie.ai clips are bought with his money, so a film is for accounts with a payment
  // on record; his own test account (48 credits typed in by hand) must be refused in words and offered the animatic.
  const s = await studio(fakeAi(() => TREATMENT_FIXTURE(60)), {}, { paid: false });
  const a = await s.call("kleo_account", {});
  assert.equal(a.structuredContent.has_paid, false);
  assert.equal(a.structuredContent.can_order_film, false);
  assert.match(a.structuredContent.products, /^animatic only/);
  assert.match(a.text, /has not bought a pack yet, so it can order the ANIMATIC \(5 credits, up to 60 seconds/);
  const film = await s.call("kleo_create_video", { prompt: "A film about lighthouse keepers", duration_s: 45, format: "9:16" });
  assert.equal(film.isError, true);
  assert.match(film.text, /A film is made only for accounts that have bought a credit pack[\s\S]*product: "animatic"[\s\S]*Nothing was charged/);
  const jobs = (await s.env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first()).n;
  assert.equal(jobs, 0, "nothing was created");
  assert.equal((await s.env.DB.prepare("SELECT credits FROM users WHERE id = 'u_test'").first()).credits, 70, "nothing was charged");
  const anim = await s.call("kleo_create_video", { prompt: "A film about lighthouse keepers", duration_s: 45, format: "9:16", product: "animatic" });
  assert.equal(anim.isError, undefined, anim.text);
  assert.equal(anim.structuredContent.credits, 5, "the animatic is 5 credits flat");
  assert.match(anim.text, /This is the ANIMATIC/);
  assert.equal((await s.env.DB.prepare("SELECT credits FROM users WHERE id = 'u_test'").first()).credits, 65);
  const tooLong = await s.call("kleo_create_video", { prompt: "A film about lighthouse keepers", duration_s: 90, format: "9:16", product: "animatic" });
  assert.equal(tooLong.isError, true);
  assert.match(tooLong.text, /An animatic is at most 60 seconds long/);
});
