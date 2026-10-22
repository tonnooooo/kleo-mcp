/**
 * A provider out of money (23 October 2026): a paying customer's clips must stop BEFORE the charge, not fail after it,
 * and the owner must hear about it once, not a hundred times. Imports the TypeScript sources directly (Node 22.18+).
 * Run: node --test test/studio-providers.test.mjs
 */
import { register } from "node:module";
// Workers' "cloudflare:email" does not exist in Node: a stand-in that keeps what it was given.
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "cloudflare:email") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export class EmailMessage { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } }") };
  return next(s, c);
}`));

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  ALERT_EVERY_H, PROVIDER_STATUS_SCHEMA, SHORT_MIN, alertOwner, anyRouteReady, canTake, handleProviderResume, leftInRefusal,
  noteNoMoney, pausedText, refreshBalances, spent,
} from "../src/studio/providers.ts";
import { checkSignedPath } from "../src/studio/session.ts";

/* ------------------------------------------------------------------ D1 look-alike */
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a.map((v) => (v === undefined ? null : v)); return this; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}
function newEnv(extra = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), user_id TEXT, job_id TEXT, event TEXT NOT NULL, detail TEXT)");
  db.exec(PROVIDER_STATUS_SCHEMA);
  const mails = [];
  const env = {
    DB: { db, prepare: (sql) => new Stmt(db, sql), batch: async (sts) => Promise.all(sts.map((s) => s.run())) },
    INTERNAL_SECRET: "s".repeat(32), STUDIO_URL: "https://app.kleooai.com",
    OWNER_MAIL: { send: async (m) => { mails.push(m); } },
    ...extra,
  };
  return { env, mails, audit: (event) => db.prepare("SELECT detail FROM audit WHERE event = ?").all(event).map((r) => JSON.parse(r.detail)) };
}
const T0 = Date.parse("2026-10-22T21:30:00Z");
const EPHONE_403 = "ephone.ai POST /v1/task/submit → 403: 预扣费额度失败, 用户剩余额度: ＄1.086812, 需要预扣费额度: ＄1.355940 (request id: a4eb9c876c73)";
const WAVESPEED_400 = "wavespeed.ai POST /api/v3/alibaba/wan-3.0/video-edit → 400: Insufficient credits. Please top up your account to continue.";

test("ePhone's refusal says what is left; other words say nothing", () => {
  assert.equal(leftInRefusal(EPHONE_403), 1.086812);
  assert.equal(leftInRefusal("预扣费额度失败, 用户剩余额度: $0.279880, 需要预扣费额度: $0.477807"), 0.27988);
  assert.equal(leftInRefusal(WAVESPEED_400), null);
  assert.equal(leftInRefusal("The request failed because the output video may be related to copyright restrictions."), null);
});

test("22 October replayed: after ePhone's first refusal, a clip it cannot pay for stops before the charge; a cheap one still goes", async () => {
  const { env } = newEnv();
  assert.equal(await canTake(env, "ephone", 1.291, T0), true, "nothing known yet: the order goes, as before");
  await noteNoMoney(env, "ephone", EPHONE_403, T0);
  assert.equal(await canTake(env, "ephone", 1.291, T0 + 60_000), false, "the Seedance 2.5 clip Malte tried next: refused before the charge");
  assert.equal(await canTake(env, "ephone", 0.476, T0 + 60_000), true, "a 0.48 $ clip fits in 1.09 $ with ePhone's pre-charge");
  await spent(env, "ephone", 0.476);
  assert.equal(await canTake(env, "ephone", 0.476, T0 + 90_000), false, "what went out is counted: 0.61 $ left");
  assert.equal(await canTake(env, "ephone", 1.291, T0 + (SHORT_MIN + 1) * 60_000), true, "after the window the next order finds out again");
});

test("WaveSpeed's refusal names no figure: nothing goes until the balance is read again", async () => {
  const { env } = newEnv({ WAVESPEED_API_KEY: "ws" });
  await noteNoMoney(env, "wavespeed", WAVESPEED_400, T0);
  assert.equal(await canTake(env, "wavespeed", 1.5, T0 + 1000), false);
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes("wavespeed") ? { code: 200, data: { balance: 50 } } : {}), { status: 200 });
  try { await refreshBalances(env, T0 + 6 * 60_000); } finally { globalThis.fetch = real; }
  assert.equal(await canTake(env, "wavespeed", 6, T0 + 7 * 60_000), true, "topped up: the template goes again");
});

test("the cron reads WaveSpeed and APIMart, warns under the line, and stops a 1080p template the balance cannot pay", async () => {
  const { env, mails } = newEnv({ WAVESPEED_API_KEY: "ws", APIMART_API_KEY: "am" });
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push(String(url));
    assert.match(init.headers.authorization, /^Bearer (ws|am)$/);
    if (String(url).includes("wavespeed")) return new Response(JSON.stringify({ code: 200, message: "success", data: { balance: 3.8565 } }));
    return new Response(JSON.stringify({ remain_balance: 8.1634, success: true }));
  };
  try {
    const read = await refreshBalances(env, T0);
    assert.deepEqual(read, { wavespeed: 3.8565, apimart: 8.1634 }, "the figures of 23 October");
    await refreshBalances(env, T0 + 2 * 60_000);
    assert.equal(asked.length, 2, "not read again within five minutes");
  } finally { globalThis.fetch = real; }
  assert.equal(await canTake(env, "wavespeed", 6.0, T0 + 60_000), false, "Paris Fire Dance at 1080p (6 $) does not fit in 3.86 $");
  assert.equal(await canTake(env, "wavespeed", 3.0, T0 + 60_000), true, "at 720p (3 $) it does");
  assert.equal(await canTake(env, "wavespeed", 6.0, T0 + 20 * 60_000), true, "a balance older than fifteen minutes is not trusted to refuse");
  assert.equal(mails.length, 1, "one warning: WaveSpeed under 10 $; APIMart over its 5 $ line");
  assert.match(mails[0].raw, /Subject: Kleo: WaveSpeed is running low \(\$3\.86\)/);
});

test("the owner hears once per provider and level every six hours; 'empty' after 'low' goes out at once", async () => {
  const { env, mails, audit } = newEnv();
  await noteNoMoney(env, "ephone", EPHONE_403, T0);
  await noteNoMoney(env, "ephone", EPHONE_403, T0 + 60_000);
  await noteNoMoney(env, "ephone", EPHONE_403, T0 + 3600_000);
  assert.equal(mails.length, 1, "fourteen refusals in a night are one e-mail");
  await noteNoMoney(env, "ephone", EPHONE_403, T0 + (ALERT_EVERY_H * 3600 + 60) * 1000);
  assert.equal(mails.length, 2, "and another six hours later if still empty");
  assert.equal(audit("provider.no_money").length, 4, "every refusal is in the audit");

  const two = newEnv();
  await alertOwner(two.env, "wavespeed", "low", 3.86, T0);
  await alertOwner(two.env, "wavespeed", "low", 3.5, T0 + 60_000);
  await alertOwner(two.env, "wavespeed", "empty", 0, T0 + 120_000);
  assert.equal(two.mails.length, 2);
});

test("the e-mail: from alerts@kleooai.com to the verified address, with a resume link that checks out", async () => {
  const { env, mails } = newEnv();
  await noteNoMoney(env, "ephone", EPHONE_403, T0);
  const m = mails[0];
  assert.equal(m.from, "alerts@kleooai.com");
  assert.equal(m.to, "kleooai@gmail.com");
  assert.match(m.raw, /^From: Kleo alerts <alerts@kleooai\.com>\r\nTo: kleooai@gmail\.com\r\nSubject: Kleo: ePhone is out of money, orders on it are paused\r\nMessage-ID: <[^>]+@kleooai\.com>\r\n/);
  assert.match(m.raw, /holds \$1\.09/);
  const link = new URL(/https:\/\/app\.kleooai\.com\/api\/provider-resume\/ephone\?\S+/.exec(m.raw)[0]);
  assert.equal(await checkSignedPath(env.INTERNAL_SECRET, link.pathname, link.searchParams.get("exp"), link.searchParams.get("sig"), T0 + 86_400_000), true);
  assert.ok(!/\n(?<!\r)/.test(m.raw.replace(/\r\n/g, "")), "CRLF line ends only");
});

test("no mail binding: the alert is still claimed and written down, nothing throws", async () => {
  const { env, audit } = newEnv({ OWNER_MAIL: undefined });
  await noteNoMoney(env, "ephone", EPHONE_403, T0);
  assert.deepEqual(audit("provider.alert").map((a) => [a.provider, a.mailed]), [["ephone", false]]);
});

test("the resume link: GET only asks (mail scanners open links), POST resumes, an unsigned one does nothing", async () => {
  const { env, audit } = newEnv();
  await noteNoMoney(env, "ephone", EPHONE_403, T0);
  const url = new URL("https://app.kleooai.com/api/provider-resume/ephone?exp=1&sig=x");
  const get = await handleProviderResume(env, new Request(url, { method: "GET" }), url, "ephone", true);
  assert.match(await get.text(), /<form method="post"/);
  assert.equal(await canTake(env, "ephone", 1.291, T0 + 60_000), false, "a GET changed nothing");
  const bad = await handleProviderResume(env, new Request(url, { method: "POST" }), url, "ephone", false);
  assert.equal(bad.status, 403);
  assert.equal(await canTake(env, "ephone", 1.291, T0 + 60_000), false);
  const ok = await handleProviderResume(env, new Request(url, { method: "POST" }), url, "ephone", true);
  assert.equal(ok.status, 200);
  assert.equal(await canTake(env, "ephone", 1.291, T0 + 60_000), true);
  assert.equal(audit("provider.resumed").length, 1);
});

test("an order goes when any of its routes can pay: ePhone empty, its APIMart backup not", async () => {
  const { env } = newEnv();
  await noteNoMoney(env, "ephone", EPHONE_403.replace("1.086812", "0.10"), T0);
  assert.equal(await anyRouteReady(env, [{ provider: "ephone", usd: 0.4 }], T0 + 1000), false);
  assert.equal(await anyRouteReady(env, [{ provider: "ephone", usd: 0.4 }, { provider: "apimart", usd: 0.4 }], T0 + 1000), true, "Seedance 2.0 Fast moves to APIMart");
});

test("a status that cannot be read never stops an order", async () => {
  const env = { DB: { prepare: () => { throw new Error("D1 is down"); } } };
  assert.equal(await canTake(env, "ephone", 100, T0), true);
});

test("the sentence the customer reads names the model and says nothing was charged", () => {
  assert.equal(pausedText("Seedance 2.5"), "Seedance 2.5 is unavailable for a little while: its engine is being recharged. Nothing was charged. Try another model, or come back soon.");
});

test("generate.ts: every order passes the provider check before the charge, and every refusal for money is written down", () => {
  const src = readFileSync(new URL("../src/studio/generate.ts", import.meta.url), "utf8");
  const gate = src.slice(src.indexOf("async function gate("), src.indexOf("async function charge("));
  assert.equal((gate.match(/await providersReady\(env, userId, o\)/g) ?? []).length, 2, "for customers and for the admin account");
  assert.ok(gate.lastIndexOf("providersReady") > gate.indexOf("user.credits < o.credits"), "after every other check, so a locked or empty account hears that first");
  for (const fn of ["export async function createGeneration(", "async function createImageGeneration(", "export async function runTool("]) {
    const body = src.slice(src.indexOf(fn), src.indexOf("\n}\n", src.indexOf(fn)));
    assert.match(body, /routes[:,]/, `${fn} gives its routes to the gate`);
  }
  const place = src.slice(src.indexOf("export async function placeTask("), src.indexOf("async function noticeMoney("));
  assert.match(place, /noticeMoney\(env, "ephone", e\)/);
  assert.match(place, /noticeMoney\(env, r\.provider, e2\)/);
  assert.match(src, /catch \(e\) \{ await noticeMoney\(env, "wavespeed", e\); throw e; \}/, "templates and Wan 3.0 too");
});
