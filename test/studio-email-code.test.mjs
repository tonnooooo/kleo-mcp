/**
 * Signing in with an e-mail code (src/studio/auth.ts, "Sign in with an e-mail code"; the screens in studio-web/app.js).
 * Google refuses to sign in inside the browsers of Facebook, Instagram and TikTok, so a six-digit code mailed to the
 * address signs in, or opens the account, without leaving the app. Covers: the switch, the mail (code in the subject,
 * no unsubscribe link), what is stored (only the HMAC), one use, the wrong tries, the waits and the hour's cap, the
 * expiry, a new account (gift, attribution, the "email" sign-in), the account Google already vouches for, a claimed
 * account handed to the inbox's owner, the admin account that never opens this way, and the sign-in screen.
 * Run: node --test test/studio-email-code.test.mjs
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
class FakeR2 {
  async put() { return {}; }
  async get() { return null; }
  async delete() {}
  async list() { return { objects: [], truncated: false }; }
}
// The e-mail check asks DNS for the domain's mail servers: every domain here has one.
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
    stdin: { contents: `export { default } from "./src/studio/index.ts"; export { sixDigits, codeMail } from "./src/studio/auth.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email"],
  });
  mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
  worker = mod.default;
});

function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: new FakeR2(), ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", EPHONE_API_KEY: "ek", FREE_CREDITS: "5", STUDIO_FREE_MODELS: "seedance-2.0-fast",
    MAX_NEW_USERS_PER_IP_DAY: "50", MAX_ACCOUNTS_PER_ADDRESS: "50", STUDIO_EMAIL_CODE: "on",
    sent: [], EMAIL: { send: async (m) => { env.sent.push(m); return { messageId: `m${env.sent.length}` }; } },
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };

const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
const FB_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.40.100;FBBV/700000000;FBDV/iPhone16,2]";

async function call(env, path, { method = "GET", body, cookie, headers = {} } = {}) {
  const h = { "user-agent": SAFARI, "x-kleo": "1", ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await worker.fetch(new Request(`https://app.kleo.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }), env, ctx);
  await Promise.allSettled(pending.splice(0));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, res };
}
const cookiesOf = (res) => res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""].filter(Boolean);
const sessionOf = (r) => cookiesOf(r.res).find((c) => c.startsWith("__Host-kleo_studio="))?.split(";")[0] ?? null;
const one = (env, sql, ...a) => { const r = env.DB.db.prepare(sql).get(...a); return r ? { ...r } : r; };
const codeOf = (m) => /^(\d{6}) is your Kleo code$/.exec(m.subject)?.[1];
/** Asks for a code and answers it, as it came in the e-mail. */
async function askCode(env, email, headers = {}) {
  const r = await call(env, "/api/auth/email/start", { method: "POST", body: { email }, headers });
  assert.equal(r.status, 200, r.text);
  return codeOf(env.sent.at(-1));
}
const verify = (env, email, code, headers = {}) => call(env, "/api/auth/email/verify", { method: "POST", body: { email, code }, headers });
/** Lets the clock run: the code's row as if it was sent `ms` earlier. */
const age = (env, email, ms) => env.DB.db.prepare("UPDATE studio_email_codes SET sent_at = sent_at - ?, window_start = window_start - ? WHERE email = ?").run(ms, ms, email);

test("e-mail codes: off without the switch or the EMAIL binding, and the config says so", async () => {
  for (const env of [newEnv({ STUDIO_EMAIL_CODE: "" }), newEnv({ EMAIL: undefined })]) {
    assert.equal((await call(env, "/api/config")).json.emailCode, false);
    const r = await call(env, "/api/auth/email/start", { method: "POST", body: { email: "ann@example.com" } });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "no_email_code");
  }
  assert.equal((await call(newEnv(), "/api/config")).json.emailCode, true);
});

test("the e-mail: the code in the subject and in the body, from hello@kleooai.com, no unsubscribe link; only its HMAC is kept", async () => {
  const env = newEnv();
  const code = await askCode(env, "Ann@Example.com ");
  assert.match(code, /^\d{6}$/);
  const m = env.sent[0];
  assert.equal(m.to, "ann@example.com");
  assert.deepEqual(m.from, { email: "hello@kleooai.com", name: "Leonardo from Kleo" });
  assert.ok(m.html.includes(code) && m.text.includes(code));
  assert.equal(m.headers["List-Unsubscribe"], undefined, "a sign-in code is not a mailing");
  assert.equal(m.headers["X-Kleo-Mail"], "signin-code");
  assert.match(m.text, /someone asked to sign in to Kleo with this address/);
  assert.doesNotMatch(m.text, /confirms a payment/);
  const row = one(env, "SELECT * FROM studio_email_codes WHERE email = 'ann@example.com'");
  assert.equal(row.code_hash.length, 64);
  assert.ok(!JSON.stringify(row).includes(code), "the code itself is never stored");
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM audit WHERE event = 'studio.email_code_sent'").n, 1);
  // Each draw is six digits.
  for (let i = 0; i < 200; i++) assert.match(mod.sixDigits(), /^\d{6}$/);
});

test("a code from Facebook's browser opens a new account: the gift, the source, the 'email' sign-in; it works once", async () => {
  const env = newEnv();
  const code = await askCode(env, "bea@example.com", { "user-agent": FB_UA });
  const bad = await verify(env, "bea@example.com", code === "000000" ? "111111" : "000000", { "user-agent": FB_UA });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "wrong_code");
  assert.equal(one(env, "SELECT attempts FROM studio_email_codes WHERE email = 'bea@example.com'").attempts, 1);
  const ok = await verify(env, "bea@example.com", ` ${code.slice(0, 3)} ${code.slice(3)} `, { "user-agent": FB_UA });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.gift, 5);
  const session = sessionOf(ok);
  assert.ok(session, "signed in");
  assert.ok(cookiesOf(ok.res).some((c) => c.startsWith("__Host-kleo_gift=")), "the browser keeps the gift's mark");
  const me = await call(env, "/api/me", { cookie: session });
  assert.equal(me.json.credits, 5);
  assert.deepEqual(me.json.methods, ["email"]);
  assert.equal(me.json.email, "bea@example.com");
  assert.deepEqual(one(env, "SELECT channel, guessed, in_app FROM user_attribution WHERE user_id = ?", me.json.id), { channel: "facebook", guessed: 1, in_app: "facebook" });
  // Used once.
  const again = await verify(env, "bea@example.com", code);
  assert.equal(again.status, 400);
  assert.equal(again.json.code, "code_expired");
  // The next code signs in to the same account: no second gift.
  age(env, "bea@example.com", 31_000);
  const back = await verify(env, "bea@example.com", await askCode(env, "bea@example.com"));
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json.gift, undefined);
  assert.equal((await call(env, "/api/me", { cookie: sessionOf(back) })).json.id, me.json.id);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM users WHERE email = 'bea@example.com'").n, 1);
});

test("limits: half a minute between codes, five an hour, five wrong tries, ten minutes, no throwaway mailbox", async () => {
  const env = newEnv();
  await askCode(env, "cal@example.com");
  const soon = await call(env, "/api/auth/email/start", { method: "POST", body: { email: "cal@example.com" } });
  assert.equal(soon.status, 429);
  assert.equal(soon.json.code, "code_wait");
  for (let i = 0; i < 4; i++) { age(env, "cal@example.com", 31_000); await askCode(env, "cal@example.com"); }
  age(env, "cal@example.com", 31_000);
  const hour = await call(env, "/api/auth/email/start", { method: "POST", body: { email: "cal@example.com" } });
  assert.equal(hour.json.code, "code_hour");
  assert.equal(env.sent.length, 5);
  age(env, "cal@example.com", 3_600_000);
  const code = await askCode(env, "cal@example.com");
  assert.equal(one(env, "SELECT window_sends FROM studio_email_codes WHERE email = 'cal@example.com'").window_sends, 1, "a new hour starts its own count");

  const wrong = code === "123456" ? "654321" : "123456";
  for (let i = 0; i < 5; i++) assert.equal((await verify(env, "cal@example.com", wrong)).json.code, "wrong_code");
  const locked = await verify(env, "cal@example.com", code);
  assert.equal(locked.status, 429);
  assert.equal(locked.json.code, "code_tries", "after five wrong tries even the right code fails");

  age(env, "cal@example.com", 31_000);
  const late = await askCode(env, "cal@example.com");
  env.DB.db.prepare("UPDATE studio_email_codes SET expires_at = ? WHERE email = 'cal@example.com'").run(Date.now() - 1);
  assert.equal((await verify(env, "cal@example.com", late)).json.code, "code_expired");
  assert.equal((await verify(env, "nobody@example.com", "123456")).json.code, "code_expired", "no code asked, nothing opens");
  assert.equal((await verify(env, "cal@example.com", "12345")).json.code, "wrong_code");

  assert.equal((await call(env, "/api/auth/email/start", { method: "POST", body: { email: "x@mailinator.com" } })).json.code, "email_domain");
  assert.equal((await call(env, "/api/auth/email/start", { method: "POST", body: { email: "not an address" } })).status, 400);
});

test("the inbox's owner: the account Google vouches for, a claimed account handed over, never the admin", async () => {
  const env = newEnv();
  // A password account (sign-up is open to passwords here: no Google keys) only CLAIMS its address.
  const su = await call(env, "/api/auth/signup", { method: "POST", body: { email: "dan@example.com", password: "long enough pw" } });
  assert.equal(su.status, 200, su.text);
  const dan = (await call(env, "/api/me", { cookie: sessionOf(su) })).json.id;
  const handed = await verify(env, "dan@example.com", await askCode(env, "dan@example.com"));
  assert.equal(handed.status, 200, handed.text);
  assert.equal(handed.json.linked, "email");
  assert.equal(handed.json.gift, undefined, "an account that existed gets no gift");
  assert.equal((await call(env, "/api/me", { cookie: sessionOf(handed) })).json.id, dan);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM studio_logins WHERE user_id = ? AND provider = 'password'", dan).n, 0, "the claimant's password goes");
  assert.equal((await call(env, "/api/me", { cookie: sessionOf(su) })).status, 401, "the claimant's session ends");

  // The same Gmail with dots or a +tag is the same inbox, the same account.
  const gm = await call(env, "/api/auth/signup", { method: "POST", body: { email: "eve.lyn@gmail.com", password: "long enough pw" } });
  const eve = (await call(env, "/api/me", { cookie: sessionOf(gm) })).json.id;
  const canon = await verify(env, "evelyn+fb@gmail.com", await askCode(env, "evelyn+fb@gmail.com"));
  assert.equal((await call(env, "/api/me", { cookie: sessionOf(canon) })).json.id, eve);

  // An address Google already vouches for finds that account, as it is.
  const gia = "u_giagoogle01";
  env.DB.db.prepare("INSERT INTO users (id, email, credits) VALUES (?, 'gia@gmail.com', 7)").run(gia);
  env.DB.db.prepare("INSERT INTO studio_logins (provider, subject, user_id, email) VALUES ('google', 'g-1', ?, 'gia@gmail.com')").run(gia);
  const g = await verify(env, "gia@gmail.com", await askCode(env, "gia@gmail.com"));
  assert.equal(g.status, 200, g.text);
  assert.equal(g.json.linked, undefined);
  assert.equal((await call(env, "/api/me", { cookie: sessionOf(g) })).json.id, gia);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM studio_logins WHERE user_id = ? AND provider = 'google'", gia).n, 1, "Google stays");

  // The admin account opens with its password (or Google) only.
  const ad = await call(env, "/api/auth/signup", { method: "POST", body: { email: "boss@example.com", password: "long enough pw" } });
  env.STUDIO_ADMINS = (await call(env, "/api/me", { cookie: sessionOf(ad) })).json.id;
  const no = await verify(env, "boss@example.com", await askCode(env, "boss@example.com"));
  assert.equal(no.status, 403);
  assert.equal(no.json.code, "admin_code");
  assert.equal(sessionOf(no), null);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM studio_logins WHERE user_id = ? AND provider = 'password'", env.STUDIO_ADMINS).n, 1, "nothing of the admin's changes");
});

test("the sign-in screen: the e-mail code first in an app's browser, a button elsewhere, the six digits typed easily", () => {
  const app = readFileSync(join(ROOT, "studio-web", "app.js"), "utf8");
  const auth = app.slice(app.indexOf("function renderAuth("), app.indexOf("function renderForgot("));
  assert.match(auth, /codeFirst \? codeBox\(mode\) : hop \? hopBox\(mode\) : null,/, "in an app's browser the code replaces the step to Safari or Chrome");
  assert.match(auth, /codeOn && !codeFirst \? emailButton\(mode\) : null/, "elsewhere it is one more way in, next to Google");
  assert.match(auth, /autocomplete: "one-time-code"/, "the phone offers the code from the e-mail");
  assert.match(auth, /inputmode: "numeric"/);
  assert.match(auth, /\/api\/auth\/email\/start/);
  assert.match(auth, /\/api\/auth\/email\/verify/);
  assert.doesNotMatch(auth, /\b(?:window\.)?(?:alert|confirm|prompt)\(/);
  const css = readFileSync(join(ROOT, "studio-web", "app.css"), "utf8");
  const rules = css.slice(css.indexOf("/* Sign in with an e-mail code"));
  assert.ok(rules.includes(".code-input"));
  for (const m of rules.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]) >= 16, `font-size ${m[1]}px`);
});
