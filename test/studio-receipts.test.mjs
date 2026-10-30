/**
 * Kleo Studio's payment e-mails (src/studio/receipts.ts), inside one process: the kleo-studio Worker bundled with
 * esbuild, on a D1 look-alike (node:sqlite, every migration applied), with Cloudflare Email Sending faked. Covers the
 * words (every model, app and template the catalogue has, the plan's bonus and dates, nothing undefined), which
 * payment gets which e-mail (a pack, a first purchase, a plan, a renewal), once each, only payments after the switch,
 * no unsubscribe headers on a receipt, a refusal on Kleo's side retried later, and the switch.
 * Run: node --test test/studio-receipts.test.mjs
 */
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "cloudflare:email") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export class EmailMessage { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } }") };
  return next(s, c);
}`));
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
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://cloudflare-dns.com/dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }), { headers: { "content-type": "application/dns-json" } });
    return real(url, init);
  };
}

let worker, mod;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts";
      export * from "./src/studio/receipts.ts";
      export { MODELS } from "./src/studio/models.ts";
      export { IMAGE_MODELS } from "./src/studio/image-models.ts";
      export { TOOLS } from "./src/studio/tools.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email", "cloudflare:sockets"],
  });
  mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
  worker = mod.default;
});

function fakeEmail() {
  const e = { sent: [], refuse: null };
  e.send = async (m) => { if (e.refuse) { const err = new Error(e.refuse.message); err.code = e.refuse.code; throw err; } e.sent.push(m); return { messageId: `m_${e.sent.length}` }; };
  return e;
}
function newEnv() {
  const env = {
    DB: new FakeD1(), RENDERS: { put: async () => ({}), get: async () => null, delete: async () => {}, list: async () => ({ objects: [] }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", EPHONE_API_KEY: "ek", FREE_CREDITS: "5", MAX_NEW_USERS_PER_IP_DAY: "50", MAX_ACCOUNTS_PER_ADDRESS: "50",
    mails: [], OWNER_MAIL: { send: async (m) => { env.mails.push(m); } }, EMAIL: fakeEmail(),
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const ctx = { waitUntil() {}, passThroughOnException() {} };
const cookiesOf = (res) => res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""].filter(Boolean);
async function signUp(env, email) {
  const res = await worker.fetch(new Request("https://app.kleo.test/api/auth/signup", { method: "POST", headers: { "x-kleo": "1", "content-type": "application/json", "user-agent": "Mozilla/5.0 Safari/604.1" }, body: JSON.stringify({ email, password: "long enough pw" }) }), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  const cookie = cookiesOf(res).find((c) => c.startsWith("__Host-kleo_studio="))?.split(";")[0];
  const me = await (await worker.fetch(new Request("https://app.kleo.test/api/me", { headers: { cookie, "user-agent": "Mozilla/5.0 Safari/604.1" } }), env, ctx)).json();
  return me.id;
}
const one = (env, sql, ...a) => { const r = env.DB.db.prepare(sql).get(...a); return r ? { ...r } : r; };
const rows = (env, sql, ...a) => env.DB.db.prepare(sql).all(...a).map((r) => ({ ...r }));
let n = 0;
const pay = (env, userId, cents, credits, { at = new Date().toISOString(), event = "checkout.session.completed" } = {}) =>
  env.DB.db.prepare("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, email, status, event_type, at) VALUES (?, ?, ?, ?, 'eur', 'checkout@example.com', 'paid', ?, ?)")
    .run(`cs_test_${++n}`, userId, credits, cents, event, at);
const text = (m) => m.text;

test("the words: a plan lists every model, picture model, app and template of the live catalogue, its bonus and its dates", () => {
  const f = mod.sampleReceipt("plan");
  const m = mod.composeReceipt("plan", f);
  assert.equal(m.subject, "Welcome to Kleo Pro: everything you unlocked");
  const plain = m.blocks.map((b) => b.p ?? b.h ?? (b.list ?? []).join(" ") ?? "").join(" ");
  for (const x of [...mod.MODELS, ...mod.IMAGE_MODELS]) assert.ok(plain.includes(x.name), x.name);
  for (const t of mod.TOOLS.filter((t) => t.group !== "trend")) assert.ok(plain.includes(t.name), t.name);
  assert.match(plain, new RegExp(`All ${mod.TOOLS.filter((t) => t.group === "trend").length} viral templates in 480p, 720p and 1080p`));
  assert.match(plain, /\+15% credits on every top-up/);
  assert.match(plain, /110 new credits every month/);
  assert.match(plain, /Your next 110 credits arrive on \d{1,2} \w+ 20\d\d/);
  assert.match(plain, /reply to this e-mail/);
  for (const kind of ["pack", "plan", "renewal"]) {
    for (const f2 of [mod.sampleReceipt(kind), { ...mod.sampleReceipt(kind), name: null, first: false, nextGrant: null, until: null }]) {
      const mm = mod.composeReceipt(kind, f2);
      const all = JSON.stringify(mm);
      assert.doesNotMatch(all, /undefined|NaN|\bnull\b(?!")|\[object/, `${kind}: ${all.slice(0, 200)}`);
    }
  }
  // A later pack is short; a first one says what it opened, and that HD templates come with a plan.
  const later = mod.composeReceipt("pack", { ...mod.sampleReceipt("pack"), first: false });
  assert.equal(later.subject, "Your 35 Kleo credits are in");
  assert.ok(!JSON.stringify(later).includes("What your first purchase unlocked"));
  const first = JSON.stringify(mod.composeReceipt("pack", mod.sampleReceipt("pack")));
  assert.match(first, /What your first purchase unlocked/);
  assert.match(first, /720p and 1080p come with a plan/);
});

test("a pack after the switch: one receipt to the account's address, no unsubscribe headers, the balance; never twice", async () => {
  const env = newEnv();
  const u = await signUp(env, "buyer@example.com");
  await mod.receiptsTick(env, Date.now() - 60_000); // the switch: payments from now on
  pay(env, u, 1500, 35, { at: new Date(Date.now() - 3_600_000).toISOString() }); // before: never gets one
  pay(env, u, 4000, 100);
  env.DB.db.prepare("UPDATE users SET credits = credits + 135 WHERE id = ?").run(u);
  let r = await mod.receiptsTick(env);
  assert.deepEqual(r, { sent: 1, skipped: 0, failed: 0 });
  const m = env.EMAIL.sent[0];
  assert.equal(m.to, "buyer@example.com");
  assert.deepEqual(m.from, { email: "hello@kleooai.com", name: "Leonardo from Kleo" });
  assert.equal(m.headers["List-Unsubscribe"], undefined);
  assert.equal(m.subject, "Your 100 Kleo credits are in", "not the first purchase: one was paid before");
  assert.match(m.text, /100 credits are on your account, and you have 140 in all/);
  assert.match(m.text, /This e-mail confirms a payment on your Kleo account/);
  r = await mod.receiptsTick(env);
  assert.equal(r.sent, 0);
  assert.equal(rows(env, "SELECT * FROM studio_receipts").length, 1);
});

test("a plan and its renewal: the welcome to the plan with everything unlocked, then a short renewal", async () => {
  const env = newEnv();
  const u = await signUp(env, "agency@example.com");
  await mod.receiptsTick(env, Date.now() - 60_000);
  pay(env, u, 3900, 110);
  env.DB.db.prepare("UPDATE users SET plan = 'pro', plan_period = 'month', plan_credits = 110, plan_status = 'active', plan_until = '2026-12-01T00:00:00.000Z', plan_next_grant = '2026-11-28T00:00:00.000Z', credits = credits + 110 WHERE id = ?").run(u);
  await mod.receiptsTick(env);
  let m = env.EMAIL.sent.at(-1);
  assert.equal(m.subject, "Welcome to Kleo Pro: everything you unlocked");
  assert.match(m.text, /Your next 110 credits arrive on 28 November 2026/);
  assert.match(m.text, /It renews on 1 December 2026, every month/);
  assert.match(m.html, /<ul/);
  pay(env, u, 3900, 110, { event: "invoice.paid" });
  await mod.receiptsTick(env);
  m = env.EMAIL.sent.at(-1);
  assert.equal(m.subject, "Your Kleo Pro renewed: 110 new credits");
  assert.equal(env.EMAIL.sent.length, 2);
});

test("refusals and the switch: Kleo's side waits and retries; off sends nothing; an amount that is neither pack nor plan is skipped", async () => {
  const env = newEnv();
  const u = await signUp(env, "late@example.com");
  await mod.receiptsTick(env, Date.now() - 60_000);
  pay(env, u, 500, 10);
  env.EMAIL.refuse = { code: "E_SENDER_NOT_VERIFIED", message: "Sender domain not verified" };
  let r = await mod.receiptsTick(env);
  assert.equal(r.failed, 1);
  assert.equal(rows(env, "SELECT * FROM studio_receipts").length, 0, "nothing written: it goes out later");
  env.EMAIL.refuse = null;
  r = await mod.receiptsTick(env);
  assert.equal(r.sent, 1);
  pay(env, u, 777, 3);
  r = await mod.receiptsTick(env);
  assert.equal(r.skipped, 1);
  env.DB.db.prepare("INSERT INTO studio_meta (key, value) VALUES ('receipts_mode', 'off')").run();
  pay(env, u, 1500, 35);
  r = await mod.receiptsTick(env);
  assert.deepEqual(r, { sent: 0, skipped: 0, failed: 0 });
});
