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
import { SPEC_METHOD } from "../src/spec.ts";

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
    stdin: { contents: `export { buildServer, summarizeFidelity } from "./src/mcp.ts"; export { makeHandle } from "./src/accounts.ts"; export { handleAdmin } from "./src/internal.ts"; export * from "./src/db.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"],
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

/** A fake Workers AI: `answer(inputs, n)` returns the model's raw output for the n-th call, or throws. */
function fakeAi(answer) {
  const calls = [];
  return { calls, async run(model, inputs) { calls.push({ model, inputs }); const out = await answer(inputs, calls.length); return { response: out, usage: { prompt_tokens: 3000, completion_tokens: 1200, total_tokens: 4200 } }; } };
}

/** The spec the server's spec call writes for "Create a video about accuracy in medicine": a bare subject, so OPEN. */
const SPEC_FIXTURE = {
  v: 1, mode: "open", summary: "A video about accuracy in medicine.", cast: [], refs: [], open: ["the angle", "the story"], narration: "free", script: null,
  items: [{ id: "R1", kind: "object", text: "accuracy in medicine is what the film is about", quote: "accuracy in medicine", must: true }],
};
/** A fake that answers the spec call (system message = SPEC_METHOD) with `spec` and every other call with `other()`. */
const specAware = (spec, other) => fakeAi((inputs, n) => (inputs.messages?.[0]?.content === SPEC_METHOD ? spec : other(inputs, n)));
/** A vision-model answer for a reference picture. */
const DESCRIBED = "A thin woman in her thirties with short blonde hair tied up and a lilac apron over a white shirt.";

/** An R2 bucket in memory: what src/refs.ts reads and writes. */
class FakeR2 {
  constructor() { this.m = new Map(); }
  async put(key, value, opts) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.m.set(key, { bytes, type: opts?.httpMetadata?.contentType ?? null });
    return { size: bytes.byteLength };
  }
  async get(key) {
    const e = this.m.get(key);
    if (!e) return null;
    return { size: e.bytes.byteLength, body: e.bytes, httpEtag: '"x"', httpMetadata: { contentType: e.type }, text: async () => new TextDecoder().decode(e.bytes), arrayBuffer: async () => e.bytes.slice().buffer };
  }
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 7, 7, 0, 0]);
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
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
  assert.match(r.text, /4\. Do you want music under the narration\?/); assert.match(r.text, /5\. Do you want subtitles burned into the video/);
  assert.deepEqual(r.structuredContent.questions.length, 5); assert.equal(r.structuredContent.optional_questions.length, 3);
  assert.match(r.text, /do not fill any of these in yourself/);
  // Answered on the call, the same request is ready: nothing was assumed, everything came from the user.
  const again = await s.call("kleo_adapt_prompt", { prompt: "Create a video about accuracy in medicine", duration_s: 60, format: "16:9", style: "realistic", audience: "nurses", tone: "calm", must_keep: "the number 30%", music: "no", subtitles: "no" });
  assert.equal(again.structuredContent.ready_to_render, true);
  assert.match(again.text, /- Length: 60s \(the user's answer\)/); assert.match(again.text, /- Look: realistic \(the user's answer\)/); assert.match(again.text, /- Must appear: the number 30% \(the user's answer\)/);
  assert.match(again.text, /- Audience: nurses/); assert.match(again.text, /- Tone: calm/);
  // Said in the request's own words, nothing is asked twice.
  const said = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about accuracy in medicine, 60 seconds, for YouTube, no music, no subtitles" });
  assert.equal(said.structuredContent.ready_to_render, true, said.text);
  assert.match(said.text, /- Length: 60s \(from the request\)/); assert.match(said.text, /- Format: 16:9 \(from the request\)/); assert.match(said.text, /- Look: realistic \(from the request\)/);
  assert.equal(ai.calls.length, 0);
  assert.deepEqual(await s.audit("treatment.adapt"), [], "nothing is counted against the day");
});

test("a complete request gets a spec (cold) and a treatment written under it (hot), and the assistant is told what to do with them", async () => {
  // 24 September 2026: the server's road writes the SPEC first — extraction at temperature 0, SPEC_METHOD as the
  // system message — and the treatment under it. It used to be one call (the treatment alone); the test pinned that.
  const ai = specAware(SPEC_FIXTURE, () => TREATMENT_FIXTURE(60));
  const s = await studio(ai);
  const r = await s.call("kleo_adapt_prompt", { prompt: "Create a video about accuracy in medicine", duration_s: 60, format: "16:9", style: "realistic", music: "no", subtitles: "no", author: "server" });
  assert.ok(!r.isError, r.text);
  assert.equal(ai.calls.length, 2, "one spec call, one treatment call");
  assert.equal(ai.calls[0].inputs.messages[0].content, SPEC_METHOD);
  assert.equal(ai.calls[0].inputs.temperature, 0, "the spec is extraction: no creativity");
  assert.match(ai.calls[0].inputs.messages[1].content, /Create a video about accuracy in medicine/);
  assert.equal(ai.calls[1].inputs.messages[0].content, MASTER_PROMPT);
  assert.equal(ai.calls[1].inputs.temperature, 0.85, "an OPEN spec keeps the producer's temperature");
  assert.match(ai.calls[1].inputs.messages[1].content, /accuracy in medicine[\s\S]*60 seconds, narrated in English/);
  assert.match(ai.calls[1].inputs.messages[1].content, /AS REQUIREMENTS/, "the treatment is written under the spec");
  assert.equal(r.structuredContent.spec.items[0].id, "R1"); assert.equal(r.structuredContent.spec.mode, "open");
  assert.match(r.structuredContent.spec_text, /^What Kleo understood/);
  assert.match(r.text, /What Kleo understood \(a subject Kleo will develop\)/);
  assert.match(r.structuredContent.next, /this same "spec"/);
  const specRows = await s.audit("spec.adapt");
  assert.equal(specRows.length, 1); assert.equal(specRows[0].ok, true); assert.equal(specRows[0].mode, "open");
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
  const r = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds", format: "9:16", music: "no", subtitles: "no" });
  assert.ok(!r.isError, r.text);
  assert.equal(ai.calls.length, 0, "no model call on the server");
  assert.equal(r.structuredContent.author, "assistant"); assert.equal(r.structuredContent.treatment, null); assert.equal(r.structuredContent.ready_to_render, true);
  assert.match(r.structuredContent.variation, /^[a-z-]+\/[a-z-]+$/);
  assert.match(r.text, /WRITE THE TREATMENT YOURSELF/);
  assert.match(r.text, /You are the producer and showrunner of Kleo/, "the master prompt travels whole");
  assert.match(r.text, /TASK: write the TREATMENT/); assert.match(r.text, /45 seconds, narrated in English/);
  // The spec is written in the same breath, so the draw is conditional (24 September 2026): as-told/as-asked when the
  // assistant's spec is FAITHFUL, the random draw only when it is OPEN.
  assert.match(r.text, /"variation":"as-told\/as-asked" when your spec is faithful/);
  assert.match(r.text, new RegExp(`"${r.structuredContent.variation}" when it is open`));
  assert.match(r.text, /THE DRAW DEPENDS ON THE SPEC YOU WROTE/);
  assert.deepEqual(await s.audit("treatment.adapt"), [], "nothing counted against the day's cap");
  assert.equal((await s.audit("treatment.method")).length, 1);
  // THE SPEC FIRST (24 September 2026): the requirements are extracted before anybody is creative with them, so the
  // spec method comes before the producer's, and the next step says to show the user what Kleo understood.
  const specAt = r.text.indexOf("STEP A — WRITE THE SPEC FIRST"), treatAt = r.text.indexOf("WRITE THE TREATMENT YOURSELF");
  assert.ok(specAt > 0 && treatAt > specAt, "the spec method, then the treatment method");
  assert.match(r.text, /You are Kleo's script supervisor/, "the spec method travels whole");
  assert.equal(r.structuredContent.spec, null);
  assert.match(r.structuredContent.next, /^STEP A: write the SPEC/);
  assert.match(r.structuredContent.next, /show them what Kleo understood[\s\S]*wait for their yes or their corrections/);
  assert.match(r.structuredContent.next, /"as-told\/as-asked"/, "a faithful spec is told the user's way, with no drawn device");
  assert.match(r.structuredContent.next, /the object as "spec", the object as "treatment"/);
});

/* ------------------------------------------------------------------ the spec and the pictures (24 September) */

test("the intake's answers travel: the spec method quotes them and the next step hands them to kleo_create_video", async () => {
  const s = await studio(fakeAi(() => { throw new Error("must not be called"); }));
  const r = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds", format: "9:16", music: "no", subtitles: "no", audience: "children", tone: "warm", must_keep: "the red lamp" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /THE USER ALSO ANSWERED[\s\S]*must appear, or must never appear: "the red lamp"[\s\S]*the film is for: "children"[\s\S]*the tone: "warm"/);
  assert.equal(r.structuredContent.must_keep, "the red lamp"); assert.equal(r.structuredContent.audience, "children"); assert.equal(r.structuredContent.tone, "warm");
  assert.match(r.structuredContent.next, /must_keep: "the red lamp"/); assert.match(r.structuredContent.next, /audience: "children"/);
});

test("reference pictures: a URL is taken in, described and handed back as a handle; an upload link is this account's own", async () => {
  const ai = fakeAi(() => DESCRIBED);   // the only model call on this road is the vision model's description
  const s = await studio(ai, { RENDERS: new FakeR2() });
  const r = await withFetch(async () => new Response(PNG, { status: 200 }),
    () => s.call("kleo_adapt_prompt", { prompt: "A realistic film about Mara, a pastry chef, 45 seconds", format: "9:16", music: "no", subtitles: "no", references: [{ url: "https://example.com/mara.png", role: "character", name: "Mara" }] }));
  assert.ok(!r.isError, r.text);
  const ref = r.structuredContent.references[0];
  assert.match(ref.handle, /^kref_[0-9a-f]{8}$/); assert.equal(ref.role, "character"); assert.equal(ref.name, "Mara"); assert.equal(ref.description, DESCRIBED);
  assert.equal(ai.calls.length, 1, "described once, by the vision model");
  assert.match(r.text, new RegExp(`REFERENCE PICTURES KLEO HOLDS FOR THIS FILM[\\s\\S]*${ref.handle} \\(character: Mara\\): A thin woman`));
  assert.match(r.text, new RegExp(`IMAGES KLEO HOLDS FOR THIS FILM: ${ref.handle}`), "the spec method lists it for the spec's refs");
  assert.match(r.structuredContent.next, new RegExp(`references \\["${ref.handle}"\\]`));
  // A link that is not https is refused in words before anything else.
  const http = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about Mara, 45 seconds", references: [{ url: "http://example.com/mara.png" }] });
  assert.ok(http.isError); assert.match(http.text, /only fetches pictures over https/);
  // The upload link: signed, on this server, and empty until the user uploads through it.
  const link = await s.call("kleo_upload_link", {});
  assert.ok(!link.isError, link.text);
  assert.match(link.structuredContent.upload_url, /^http:\/\/kleo\.test\/upload\/[A-Za-z0-9_-]+\.[0-9a-f]{32}$/);
  assert.equal(link.structuredContent.upload_url, `http://kleo.test/upload/${link.structuredContent.token}`);
  assert.equal(link.structuredContent.max_images, 8);
  assert.match(link.text, /Give it to the user as a plain link/);
  const early = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about Mara, 45 seconds", references: [{ upload: link.structuredContent.token }] });
  assert.ok(early.isError); assert.match(early.text, /Nothing has been uploaded through that link yet/);
  const forged = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about Mara, 45 seconds", references: [{ upload: "e30.00000000000000000000000000000000" }] });
  assert.ok(forged.isError); assert.match(forged.text, /not an upload link of this account/);
});

const MARA = "Mara, a thin pastry chef with short blonde hair and a lilac apron, opens her tiny shop at dawn and waits for the old man who never comes; no dogs in the shop.";
const maraSpec = (extra = {}) => ({
  v: 1, mode: "faithful", summary: "Mara the pastry chef opens her shop at dawn and waits for an old man who never comes.",
  cast: [{ id: "c1", name: "Mara", look: "a thin woman with short blonde hair and a lilac apron", ref: null }],
  items: [
    { id: "R1", kind: "character", text: "Mara, a thin pastry chef", quote: "Mara, a thin pastry chef", must: true, who: "c1" },
    { id: "R2", kind: "look", text: "Mara's apron is lilac", quote: "a lilac apron", must: true, who: "c1" },
    { id: "R3", kind: "event", text: "Mara opens her tiny shop at dawn", quote: "opens her tiny shop at dawn", must: true, order: 1 },
    { id: "R4", kind: "exclude", text: "no dogs in the shop", quote: "no dogs in the shop", must: true },
    { id: "R5", kind: "mood", text: "made for children", quote: "children", must: true },
  ],
  refs: [], open: ["the ending"], narration: "free", script: null, ...extra,
});

test("kleo_create_video takes the spec: an invented quote is refused before any charge; a good one is stored with the answers", async () => {
  const s = await studio(fakeAi(() => { throw new Error("must not be called"); }));
  const bad = await s.call("kleo_create_video", { prompt: MARA, duration_s: 45, format: "9:16", style: "animation", audience: "children", spec: maraSpec({ items: [...maraSpec().items, { id: "R6", kind: "object", text: "a black cat on the counter", quote: "un gatto nero", must: true }] }) });
  assert.ok(bad.isError);
  assert.match(bad.text, /The spec has 1 problem \(nothing was charged\)[\s\S]*R6: the quote "un gatto nero" is not in the user's request/);
  assert.equal((await m.getUser(s.env, "u_test")).credits, 70, "a refused spec moves no credits");
  // R5 quotes the user's AUDIENCE answer, not the prompt: the answers are part of what the user said.
  const noAnswer = await s.call("kleo_create_video", { prompt: MARA, duration_s: 45, format: "9:16", style: "animation", spec: maraSpec() });
  assert.ok(noAnswer.isError, "without the audience answer, \"children\" is nobody's words"); assert.match(noAnswer.text, /R5: the quote "children"/);
  const ok = await s.call("kleo_create_video", { prompt: MARA, duration_s: 45, format: "9:16", style: "animation", audience: "children", must_keep: "the lilac apron", spec: maraSpec() });
  assert.ok(!ok.isError, ok.text);
  assert.match(ok.text, /Kleo will check the film against your 5 requirements \(your film, as you described it\)/);
  const params = JSON.parse((await m.getUserJob(s.env, "u_test", ok.structuredContent.job_id)).params);
  assert.equal(params.spec.mode, "faithful"); assert.deepEqual(params.spec.items.map((i) => i.id), ["R1", "R2", "R3", "R4", "R5"]);
  assert.deepEqual(params.brief, { must_keep: "the lilac apron", audience: "children", tone: null });
  assert.equal(params.refs, undefined, "no pictures, no refs");
  assert.equal((await s.audit("job.created")).at(-1).spec, "faithful");
});

test("kleo_create_video: references resolve to this account's handles; the look is read off the request when nothing names it", async () => {
  const ai = fakeAi(() => DESCRIBED);
  const s = await studio(ai, { RENDERS: new FakeR2() });
  const a = await withFetch(async () => new Response(PNG, { status: 200 }),
    () => s.call("kleo_adapt_prompt", { prompt: MARA, duration_s: 45, format: "9:16", style: "animation", music: "no", subtitles: "no", references: [{ url: "https://example.com/mara.png", role: "character", name: "Mara" }] }));
  const handle = a.structuredContent.references[0].handle;
  const unknown = await s.call("kleo_create_video", { prompt: MARA, duration_s: 45, format: "9:16", references: ["kref_00000000"] });
  assert.ok(unknown.isError); assert.match(unknown.text, /not a picture Kleo received from this account[\s\S]*Nothing was charged/);
  const spec = maraSpec({ cast: [{ id: "c1", name: "Mara", look: "a thin woman with short blonde hair and a lilac apron", ref: "ref1" }], refs: [{ id: "ref1", handle, role: "character", for: "c1", description: DESCRIBED }] });
  const ok = await s.call("kleo_create_video", { prompt: MARA, duration_s: 45, format: "9:16", audience: "children", references: [handle], spec });
  assert.ok(!ok.isError, ok.text);
  assert.match(ok.text, /It draws from 1 reference picture\./);
  const params = JSON.parse((await m.getUserJob(s.env, "u_test", ok.structuredContent.job_id)).params);
  assert.deepEqual(params.refs, [handle]); assert.equal(params.spec.refs[0].handle, handle);
  await s.call("kleo_cancel_job", { job_id: ok.structuredContent.job_id });
  // No style, no treatment, no storyboard: the request's own words name the look (it used to be realistic, always).
  const drawn = await s.call("kleo_create_video", { prompt: "Un cartone animato su una volpe che impara a nuotare", duration_s: 45, format: "9:16", language: "it" });
  assert.ok(!drawn.isError, drawn.text);
  assert.equal(JSON.parse((await m.getUserJob(s.env, "u_test", drawn.structuredContent.job_id)).params).style, "animation");
});

test("with the assistant's own storyboard, the spec is checked against it: an item no shot claims is refused before any charge", async () => {
  const s = await studio(fakeAi(() => { throw new Error("must not be called"); }));
  const sb = JSON.parse(readFileSync(join(ROOT, "scripts", "motion-demo", "samples", "venezia-16x9.json"), "utf8"));
  const prompt = "L'acqua alta a Venezia, cento volte l'anno";
  const spec = { v: 1, mode: "faithful", summary: "Venice's high water, a hundred times a year.", cast: [], refs: [], open: [], narration: "lines", script: null,
    items: [
      { id: "R1", kind: "place", text: "Venice flooded by high water", quote: "L'acqua alta a Venezia", must: true },
      { id: "R2", kind: "line", text: "the narrator says it happens a hundred times a year", quote: "cento volte l'anno", must: true },
    ] };
  const args = { prompt, duration_s: 30, format: "16:9", language: "it", style: "realistic" };
  const bad = await s.call("kleo_create_video", { ...args, spec, storyboard: JSON.parse(JSON.stringify(sb)) });
  assert.ok(bad.isError);
  assert.match(bad.text, /The storyboard does not show everything the spec asks for: 1 problem \(nothing was charged\)[\s\S]*R1 \(place\): no shot shows "Venice flooded by high water"/);
  assert.doesNotMatch(bad.text, /R2/, "the line is said in the voice: covered");
  assert.equal((await m.getUser(s.env, "u_test")).credits, 70);
  const fixed = JSON.parse(JSON.stringify(sb)); fixed.scenes[0].shots[0].covers = ["R1"];
  const ok = await s.call("kleo_create_video", { ...args, spec, storyboard: fixed });
  assert.ok(!ok.isError, ok.text);
  assert.equal(JSON.parse((await m.getUserJob(s.env, "u_test", ok.structuredContent.job_id)).params).spec.mode, "faithful");
});

test("kleo_get_result reads the fidelity report: how many of the user's requirements the pictures show, and which they miss", async () => {
  const s = await studio(fakeAi(() => { throw new Error("must not be called"); }));
  const made = await s.call("kleo_create_video", { prompt: MARA, duration_s: 45, format: "9:16", style: "animation", audience: "children", spec: maraSpec() });
  assert.ok(!made.isError, made.text);
  const id = made.structuredContent.job_id;
  const report = { v: 1, stills: {
    "01-open-s1": { score: 0.95, checks: ["style", "R1", "R3", "no-text"], failed: [] },
    "01-open-s2": { score: 0.6, checks: ["style", "R2", "cast:c1"], failed: [{ id: "R2", question: "Does the image show this: Mara's apron is lilac?" }, { id: "cast:c1" }] },
    "02-wait-s1": { score: 1, answers: { style: "yes", R2: "yes", "exclude:R4": "no" }, failed: [] },
    "02-wait-s2": { score: 0.5, answers: { style: "yes", R3: "yes", "cast:c1": "no" }, failed: ["cast:c1"] },
  } };
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  await s.env.OAUTH_KV.put(`file:renders/${id}/fidelity.json`, bytes.buffer, { metadata: { contentType: "application/json", size: bytes.byteLength } });
  await s.env.DB.prepare("INSERT INTO job_files (job_id, name, key, size, content_type) VALUES (?, 'fidelity.json', ?, ?, 'application/json')").bind(id, `renders/${id}/fidelity.json`, bytes.byteLength).run();
  await s.env.DB.prepare("INSERT INTO job_files (job_id, name, key, size, content_type) VALUES (?, 'video.mp4', ?, 10, 'video/mp4')").bind(id, `renders/${id}/video.mp4`).run();
  await s.env.DB.prepare("UPDATE jobs SET state = 'done', percent = 100, finished_at = ?, expires_at = ? WHERE id = ?").bind(new Date().toISOString(), new Date(Date.now() + 7 * 86400_000).toISOString(), id).run();
  const r = await s.call("kleo_get_result", { job_id: id });
  assert.ok(!r.isError, r.text);
  // Checked: R1, R3, R2, cast:c1, R4 (the style and the no-text questions are not the user's requirements). R2 failed
  // on one picture and showed on another: kept. The cast look failed wherever it was asked: a miss, said by name.
  assert.match(r.text, /Fidelity: 4 of 5 requirements checked on the pictures; misses: cast:c1 \(Mara looking as described\)\./);
  assert.deepEqual(r.structuredContent.fidelity, { checked: 5, kept: 4, misses: [{ id: "cast:c1", text: "Mara looking as described" }], pictures: 4, plan_score: null });
  assert.ok(r.structuredContent.video_url, "the links are still there");
  assert.equal(r.structuredContent.fidelity_url, undefined, "the report is summarised, not handed over as a file");

  // The stills engine's own shape (src/stills.ts): per picture only what FAILED, no list of what was asked. The
  // questions are recomputed from the spec and the stored shots (src/spec.ts visualChecks), the same ones the judge got.
  const sb = { kleo_style: "animation", scenes: [{ id: "01-open", voice: "Mara opens the shop.", shots: [
    { image_prompt: "Mara unlocks her tiny pastry shop at dawn", covers: ["R1", "R3"], cast: ["c1"] },
    { image_prompt: "Close on Mara's lilac apron", covers: ["R2"], cast: ["c1"] },
  ] }] };
  const engine = { v: 1, plan: { score: 0.9 }, summary: { pictures: 2, drawn: 2, model: "@cf/black-forest-labs/flux-2-klein-9b", mean_score: 0.75, must_failed_pictures: 1 }, stills: {
    "01-open-s1": { score: 1, mustFailed: 0, failed: [], tries: [], judged: true },
    "01-open-s2": { score: 0.5, mustFailed: 1, failed: ["cast:c1"], tries: [], judged: true },
  } };
  const eb = new TextEncoder().encode(JSON.stringify(engine));
  await s.env.OAUTH_KV.put(`file:renders/${id}/fidelity.json`, eb.buffer, { metadata: { contentType: "application/json", size: eb.byteLength } });
  await s.env.DB.prepare("UPDATE jobs SET storyboard = ? WHERE id = ?").bind(JSON.stringify(sb), id).run();
  const r2 = await s.call("kleo_get_result", { job_id: id });
  assert.ok(!r2.isError, r2.text);
  // Asked: R3, R2 (Mara's look item, folded in by the cast), exclude R4 on the first; R2, Mara's look, R4 on the second.
  // R1 (Mara herself, a character of the cast) asks nothing of its own since 24 September: a role is not something a
  // frame proves, she is checked by her look (src/spec.ts visualChecks).
  assert.deepEqual(r2.structuredContent.fidelity, { checked: 4, kept: 3, misses: [{ id: "cast:c1", text: "Mara looking as described" }], pictures: 2, plan_score: 0.9 });
  assert.match(r2.text, /Fidelity: 3 of 4 requirements checked on the pictures; misses: cast:c1/);
  // The identity question against Kleo's own character sheet is not one of the user's requirements: never counted.
  assert.deepEqual(m.summarizeFidelity({ v: 1, stills: { a: { checks: ["style", "R2", "identity:c1"], failed: ["identity:c1"] } } }, maraSpec()), { checked: 1, kept: 1, misses: [], pictures: 1, plan_score: null });
});

test("when the model is down the tool says so and points at kleo_create_video; it never throws", async () => {
  const s = await studio(fakeAi(() => { throw new Error("429 4006 you have used up your daily free allocation"); }));
  const r = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds, vertical, no music, no subtitles", author: "server" });
  assert.ok(!r.isError, "not an error: the video can still be made");
  assert.equal(r.structuredContent.treatment, null);
  assert.equal(r.structuredContent.note, "model unavailable");
  assert.match(r.text, /could not write the treatment just now[\s\S]*call kleo_create_video with the prompt/);
  const rows = await s.audit("treatment.adapt");
  assert.equal(rows.length, 1); assert.equal(rows[0].transient, true);
});

test("the daily cap refuses the next call in words and leaves the road to kleo_create_video open", async () => {
  const s = await studio(fakeAi(() => TREATMENT_FIXTURE(45)), { ADAPT_MAX_PER_DAY: "1" });
  const first = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds, vertical, no music, no subtitles", author: "server" });
  assert.ok(!first.isError && first.structuredContent.treatment);
  const second = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds, vertical, no music, no subtitles", author: "server" });
  assert.ok(second.isError);
  assert.match(second.text, /asked for 1 treatment today, and the limit is 1 a day[\s\S]*kleo_create_video[\s\S]*Nothing was charged/);
});

test("kleo_create_video keeps the treatment the user approved and says so; a broken one is refused before any charge", async () => {
  const s = await studio(fakeAi(() => TREATMENT_FIXTURE(45)));
  const a = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds", format: "9:16", music: "no", subtitles: "no", author: "server" });
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
  const r = await s.call("kleo_adapt_prompt", { prompt: "A fox who learns to swim, 45 seconds", format: "9:16", style: "animation", music: "no", subtitles: "no" });
  assert.ok(!r.isError, r.text);
  assert.equal(r.structuredContent.style, "animation");
  assert.match(r.text, /THE LOOK: ANIMATION, fixed by the request or the tool call/);
  assert.match(r.structuredContent.next, /style \(the look the treatment names\)/, "the assistant is told to pass the look on");
  assert.match(r.text, /- Look: animation, a 2D animated film/, "the brief says the look");
  const open = await s.call("kleo_adapt_prompt", { prompt: "A fox who learns to swim, 45 seconds", format: "9:16", music: "no", subtitles: "no" });
  assert.equal(open.structuredContent.style, null, "no look named");
  assert.equal(open.structuredContent.ready_to_render, false, "the look is asked, never guessed (the intake, 14 September)");
  assert.match(open.text, /- Look: MISSING — ask/); assert.match(open.text, /1\. How do you want it: realistic \(filmed, cinematic photography\) or animation/);
  const drawn = await s.call("kleo_adapt_prompt", { prompt: "Un cartone animato su una volpe che impara a nuotare, 45 secondi", format: "9:16", music: "no", subtitles: "no" });
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

/* ------------------------------------------------------------------ music and subtitles (22 September) */

test("the user's two answers travel: the method is told them, and kleo_create_video writes them on the job and into the treatment", async () => {
  const s = await studio(fakeAi(() => { throw new Error("must not be called"); }));
  const r = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds", format: "9:16", music: "slow cello and sea wind", subtitles: "yes" });
  assert.ok(!r.isError, r.text); assert.equal(r.structuredContent.ready_to_render, true);
  assert.match(r.text, /- Music: yes — slow cello and sea wind \(the user's answer\)/); assert.match(r.text, /- Subtitles: cinema \(burned in\) \(the user's answer\)/);
  assert.match(r.text, /THE SOUND: the user WANTS MUSIC and asked for "slow cello and sea wind"/);
  assert.match(r.text, /SUBTITLES: the user WANTS them — "graphics" MUST be a layer with "subtitles":"cinema"/);
  assert.match(r.text, /12\. MUSIC\./, "the method has a twelfth step for the composer's brief");
  assert.match(r.structuredContent.next, /music and subtitles \(the user's answers/);
  const t = { ...TREATMENT_FIXTURE(45), music: "sparse cello, 60 bpm, sea wind under it, swells once in act two" };
  const ok = await s.call("kleo_create_video", { prompt: "A film about lighthouse keepers", duration_s: 45, format: "9:16", treatment: t, music: "slow cello and sea wind", subtitles: "yes" });
  assert.ok(!ok.isError, ok.text);
  const params = JSON.parse((await m.getUserJob(s.env, "u_test", ok.structuredContent.job_id)).params);
  assert.equal(params.music, t.music, "the treatment's own brief wins over the user's words when it has one");
  assert.equal(params.subtitles, true);
  assert.equal(params.treatment.music, t.music);
  assert.equal(params.treatment.graphics.subtitles, "cinema", "a yes to subtitles makes the layer");
  assert.deepEqual(params.treatment.graphics.hud, []);
  await s.call("kleo_cancel_job", { job_id: ok.structuredContent.job_id });
  // "no" to both: no brief, no layer, and the answer is written down as a no (not as a gap).
  const none = await s.call("kleo_create_video", { prompt: "A film about lighthouse keepers", duration_s: 45, format: "9:16", treatment: { ...t, graphics: { accent: "#ffb347", subtitles: "cinema", chapters: "none", hud: [] } }, music: "no", subtitles: false });
  assert.ok(!none.isError, none.text);
  const p2 = JSON.parse((await m.getUserJob(s.env, "u_test", none.structuredContent.job_id)).params);
  assert.equal(p2.music, null); assert.equal(p2.subtitles, false);
  assert.equal(p2.treatment.music, null, "the user said no: the treatment's brief goes");
  assert.equal(p2.treatment.graphics, null, "subtitles off on a layer that had nothing else: no layer");
  await s.call("kleo_cancel_job", { job_id: none.structuredContent.job_id });
  // A yes with no brief and a treatment with none: the user's words, or the plain bed sentence.
  const bare = await s.call("kleo_create_video", { prompt: "A film about lighthouse keepers", duration_s: 45, format: "9:16", treatment: TREATMENT_FIXTURE(45), music: "yes" });
  assert.ok(!bare.isError, bare.text);
  const p3 = JSON.parse((await m.getUserJob(s.env, "u_test", bare.structuredContent.job_id)).params);
  assert.match(p3.music, /quiet instrumental bed/); assert.equal(p3.subtitles, undefined, "not asked on this call: not written");
});

/* ------------------------------------------------------------------ review fixes (24 September 2026) */

/** The fixture treatment told the user's way: what kleo_adapt_prompt tells the assistant to write under a faithful spec. */
const AS_TOLD = () => ({ ...TREATMENT_FIXTURE(45), device: "as-told", variation: "as-told/as-asked" });
const PIETRO = "A film about my grandfather Pietro, the lighthouse keeper of Capo Testa";
const pietroSpec = (extra = {}) => ({
  v: 1, mode: "faithful", summary: "A film about the user's grandfather Pietro, a lighthouse keeper.",
  cast: [{ id: "c1", name: "Pietro", look: "an old man with a white beard and a wool cap", ref: null }],
  items: [{ id: "R1", kind: "character", text: "the user's grandfather Pietro", quote: "my grandfather Pietro", must: true, who: "c1" }],
  refs: [], open: ["the look of Pietro", "the story"], narration: "free", script: null, ...extra,
});

test("an as-told treatment is accepted with no spec or a faithful one, refused only under a spec that is OPEN", async () => {
  const s = await studio(fakeAi(() => { throw new Error("must not be called"); }));
  const args = { prompt: PIETRO, duration_s: 45, format: "9:16", style: "realistic" };
  // No spec (the spec refusal says "leave the spec out"): the treatment's own device says it is the user's film.
  const bare = await s.call("kleo_create_video", { ...args, treatment: AS_TOLD() });
  assert.ok(!bare.isError, bare.text);
  const p1 = JSON.parse((await m.getUserJob(s.env, "u_test", bare.structuredContent.job_id)).params);
  assert.equal(p1.treatment.variation, "as-told/as-asked"); assert.equal(p1.treatment.device, "as-told");
  await s.call("kleo_cancel_job", { job_id: bare.structuredContent.job_id });
  // The writer's FAITHFUL on one character item ("my grandfather Pietro") is kept, and the as-told treatment with it.
  const faithful = await s.call("kleo_create_video", { ...args, spec: pietroSpec(), treatment: AS_TOLD() });
  assert.ok(!faithful.isError, faithful.text);
  const p2 = JSON.parse((await m.getUserJob(s.env, "u_test", faithful.structuredContent.job_id)).params);
  assert.equal(p2.spec.mode, "faithful"); assert.equal(p2.treatment.variation, "as-told/as-asked");
  await s.call("kleo_cancel_job", { job_id: faithful.structuredContent.job_id });
  // A spec that is OPEN (a topic, not the user's story): "as-told" is not its device.
  const open = await s.call("kleo_create_video", { ...args, spec: pietroSpec({ mode: "open", cast: [], items: [{ id: "R1", kind: "place", text: "the lighthouse of Capo Testa", quote: "lighthouse keeper of Capo Testa", must: true }] }), treatment: AS_TOLD() });
  assert.ok(open.isError);
  assert.match(open.text, /device: "as-told" is the device of a film the user described/);
  assert.equal((await m.getUser(s.env, "u_test")).credits, 70, "the refusals and the cancels leave the credits whole");
});

test("the user's corrections after the read-back travel in their own argument, and a spec item may quote them", async () => {
  const s = await studio(fakeAi(() => { throw new Error("must not be called"); }));
  const tools = (await s.client.listTools()).tools;
  assert.match(tools.find((t) => t.name === "kleo_create_video").inputSchema.properties.corrections.description, /IN THEIR OWN WORDS/);
  const adapt = await s.call("kleo_adapt_prompt", { prompt: "A realistic film about lighthouse keepers, 45 seconds", format: "9:16", music: "no", subtitles: "no" });
  assert.match(adapt.structuredContent.next, /"corrections" \(their corrections, word for word\)/);
  const pepe = { id: "R6", kind: "character", text: "the user's dog Pepe with a red collar", quote: "add my dog Pepe with a red collar", must: true };
  const spec = maraSpec({ items: [...maraSpec().items, pepe] });
  const args = { prompt: MARA, duration_s: 45, format: "9:16", style: "animation", audience: "children", spec };
  const refused = await s.call("kleo_create_video", args);
  assert.ok(refused.isError); assert.match(refused.text, /R6: the quote "add my dog Pepe with a red collar" is not in the user's request[\s\S]*"corrections"/);
  const ok = await s.call("kleo_create_video", { ...args, corrections: "add my dog Pepe with a red collar" });
  assert.ok(!ok.isError, ok.text);
  const params = JSON.parse((await m.getUserJob(s.env, "u_test", ok.structuredContent.job_id)).params);
  assert.ok(params.spec.items.some((i) => i.id === "R6"), "the correction is a checked requirement, not one of Kleo's decisions");
  assert.deepEqual(params.brief, { must_keep: null, audience: "children", tone: null, corrections: "add my dog Pepe with a red collar" });
});

test("the fidelity report: an exclusion broken on one picture is a miss, whatever the other pictures say", () => {
  const spec = { v: 1, mode: "faithful", summary: "s", cast: [], refs: [], open: [], narration: "free", script: null,
    items: [{ id: "R3", kind: "object", text: "a lemon cake", quote: "q", must: true }, { id: "R5", kind: "exclude", text: "no dogs", quote: "q", must: true }] };
  const stills = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, { checks: ["style", "R3", "exclude:R5"], failed: i === 3 ? ["exclude:R5"] : [] }]));
  const f = m.summarizeFidelity({ v: 1, stills }, spec);
  assert.deepEqual(f.misses, [{ id: "R5", text: "no dogs" }], "nine clean pictures do not hide the one with a dog");
  assert.equal(f.checked, 2); assert.equal(f.kept, 1);
  // A positive item keeps the "some picture shows it" rule; an exclusion that never failed is kept.
  const clean = m.summarizeFidelity({ v: 1, stills: { a: { checks: ["R3", "exclude:R5"], failed: ["R3"] }, b: { checks: ["R3", "exclude:R5"], failed: [] } } }, spec);
  assert.deepEqual(clean.misses, []); assert.equal(clean.kept, 2);
});

test("reference pictures are metered: one link is fetched and described once per call, and the vision calls have a daily cap", async () => {
  const ai = fakeAi(() => DESCRIBED);
  const s = await studio(ai, { RENDERS: new FakeR2(), REFS_MAX_PER_DAY: "1" });
  let fetches = 0;
  const serve = (bytes) => async () => { fetches++; return new Response(bytes, { status: 200 }); };
  const PNG2 = new Uint8Array(PNG); PNG2[15] = 9;
  const ask = (references) => s.call("kleo_adapt_prompt", { prompt: "A realistic film about Mara, a pastry chef, 45 seconds", format: "9:16", music: "no", subtitles: "no", references });
  // Eight entries of the same link with flipping roles: one fetch, one vision call, one handle (the first role kept).
  const roles = ["character", "style", "character", "style", "character", "style", "character", "style"];
  const r = await withFetch(serve(PNG), () => ask(roles.map((role) => ({ url: "https://example.com/mara.png", role, name: "Mara" }))));
  assert.ok(!r.isError, r.text);
  assert.equal(fetches, 1); assert.equal(ai.calls.length, 1);
  assert.equal(r.structuredContent.references.length, 1); assert.equal(r.structuredContent.references[0].role, "character");
  assert.equal((await s.audit("refs.describe")).length, 1);
  // The same picture again in a new role, past the day's cap: kept with the description it has, no vision call.
  const again = await withFetch(serve(PNG), () => ask([{ url: "https://example.com/mara-copy.png", role: "style" }]));
  assert.ok(!again.isError, again.text);
  assert.equal(ai.calls.length, 1, "no second description past the cap");
  assert.equal(again.structuredContent.references[0].handle, r.structuredContent.references[0].handle, "named by its bytes, not its link");
  assert.equal(again.structuredContent.references[0].description, DESCRIBED);
  // A NEW picture past the cap is refused in words, before any vision call.
  const fresh = await withFetch(serve(PNG2), () => ask([{ url: "https://example.com/other.png", role: "character" }]));
  assert.ok(fresh.isError);
  assert.match(fresh.text, /has had 1 picture described today, and the limit is 1 a day[\s\S]*Nothing was charged/);
  assert.equal(ai.calls.length, 1);
});

test("upload links are counted per day too", async () => {
  const s = await studio(fakeAi(() => { throw new Error("must not be called"); }), { UPLOAD_LINKS_MAX_PER_DAY: "1" });
  const first = await s.call("kleo_upload_link", {});
  assert.ok(!first.isError, first.text);
  const second = await s.call("kleo_upload_link", {});
  assert.ok(second.isError);
  assert.match(second.text, /asked for 1 upload link today, and the limit is 1 a day[\s\S]*Nothing was charged/);
});


test("plugin tools declare their side effects and account replies contain no reusable account credential", async () => {
  const s = await studio(fakeAi(() => TREATMENT_FIXTURE(60)));
  const tools = (await s.client.listTools()).tools;
  for (const tool of tools) {
    for (const key of ["readOnlyHint", "destructiveHint", "openWorldHint"])
      assert.equal(typeof tool.annotations?.[key], "boolean", `${tool.name} needs ${key}`);
  }
  for (const name of ["kleo_adapt_prompt", "kleo_upload_link"])
    assert.equal(tools.find(t => t.name === name).annotations.readOnlyHint, false, `${name} writes records`);
  const reply = await s.call("kleo_account", {});
  assert.equal(reply.structuredContent.account_key, undefined);
  assert.ok(reply.structuredContent.account_url, "balance page remains available");
  // The exact private handle must be absent from every model-visible output, not only one field.
  const privateKey = await m.makeHandle(s.env, s.user.id);
  assert.equal(JSON.stringify(reply).includes(privateKey), false);
  assert.doesNotMatch(JSON.stringify(reply), /"account_key"\s*:/);
  assert.doesNotMatch(tools.find(t => t.name === "kleo_account").description, /Show account_key/);
  await s.client.close();
});
