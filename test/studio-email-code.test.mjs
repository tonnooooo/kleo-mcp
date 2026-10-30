/**
 * Signing in with an e-mail code (src/studio/auth.ts, "Sign in with an e-mail code"; the screens in studio-web/app.js).
 * Google refuses to sign in inside the browsers of Facebook, Instagram and TikTok, so a six-digit code mailed to the
 * address signs in, or opens the account, without leaving the app. Covers: the switches (off, "signin", "on", the
 * gift), the mail (code in the subject, no unsubscribe link), what is stored (only the HMAC, live only after the send),
 * one use, the wrong tries (per code and per day, atomic), the waits and the hour's cap, the expiry, ONE INBOX ONE
 * BUDGET (other spellings share every limit and open nothing), a new account (gift, attribution, the "email" sign-in),
 * the account a vouched sign-in holds, a claimed account handed to the inbox's owner, the admin account that never
 * opens this way, Google joining a code account, bounced addresses, the human check, the throttle, and the screen.
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
// Every outside call: DNS for the e-mail check (every domain here has a mail server), then whatever a test scripts.
let answer = null;
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://cloudflare-dns.com/dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }), { headers: { "content-type": "application/dns-json" } });
    if (answer) return answer(u, init ?? {});
    return real(url, init);
  };
}

let worker, mod;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts"; export { sixDigits, codeMail, CODE_NO_GIFT_SENTENCE } from "./src/studio/auth.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email"],
  });
  mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
  worker = mod.default;
});

function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: new FakeR2(), ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", EPHONE_API_KEY: "ek", FREE_CREDITS: "5", STUDIO_FREE_MODELS: "seedance-2.0-fast",
    MAX_NEW_USERS_PER_IP_DAY: "50", MAX_ACCOUNTS_PER_ADDRESS: "50", STUDIO_EMAIL_CODE: "on", STUDIO_EMAIL_CODE_GIFT: "on",
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
const start = (env, email, headers = {}) => call(env, "/api/auth/email/start", { method: "POST", body: { email }, headers });
/** Asks for a code and answers it, as it came in the e-mail. */
async function askCode(env, email, headers = {}) {
  const r = await start(env, email, headers);
  assert.equal(r.status, 200, r.text);
  return codeOf(env.sent.at(-1));
}
const verify = (env, email, code, headers = {}) => call(env, "/api/auth/email/verify", { method: "POST", body: { email, code }, headers });
/** Lets the clock run for an inbox: its last send as if it happened `ms` earlier. */
const age = (env, inbox, ms) => env.DB.db.prepare("UPDATE studio_email_codes SET sent_at = sent_at - ?, window_start = window_start - ? WHERE inbox = ?").run(ms, ms, inbox);
const otherThan = (code) => (code === "123456" ? "654321" : "123456");
const signUpWithPassword = async (env, email) => {
  const r = await call(env, "/api/auth/signup", { method: "POST", body: { email, password: "long enough pw" } });
  assert.equal(r.status, 200, r.text);
  return { cookie: sessionOf(r), id: (await call(env, "/api/me", { cookie: sessionOf(r) })).json.id };
};

test("the switches: off without STUDIO_EMAIL_CODE or the EMAIL binding; 'signin' opens existing accounts only", async () => {
  for (const env of [newEnv({ STUDIO_EMAIL_CODE: "" }), newEnv({ EMAIL: undefined })]) {
    assert.equal((await call(env, "/api/config")).json.emailCode, false);
    const r = await start(env, "ann@example.com");
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "no_email_code");
  }
  assert.equal((await call(newEnv(), "/api/config")).json.emailCode, "on");
  const env = newEnv({ STUDIO_EMAIL_CODE: "signin" });
  assert.equal((await call(env, "/api/config")).json.emailCode, "signin");
  const none = await verify(env, "new@example.com", await askCode(env, "new@example.com"));
  assert.equal(none.status, 403);
  assert.equal(none.json.code, "no_account");
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM users WHERE email = 'new@example.com'").n, 0, "no account opened");
  // A refusal does not spend the code: once the owner opens sign-ups, the same code works.
  const code = codeOf(env.sent.at(-1));
  env.STUDIO_EMAIL_CODE = "on";
  const later = await verify(env, "new@example.com", code);
  assert.equal(later.status, 200, later.text);
});

test("the e-mail: the code in the subject and body, from hello@kleooai.com, no unsubscribe link; only its HMAC is kept", async () => {
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
  const row = one(env, "SELECT * FROM studio_email_codes WHERE inbox = 'ann@example.com'");
  assert.equal(row.address, "ann@example.com");
  assert.equal(row.code_hash.length, 64);
  assert.ok(!JSON.stringify(row).includes(code), "the code itself is never stored");
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM audit WHERE event = 'studio.email_code_sent'").n, 1);
  for (let i = 0; i < 200; i++) assert.match(mod.sixDigits(), /^\d{6}$/);
});

test("a failed send opens nothing: the code becomes live only once the e-mail went out", async () => {
  const env = newEnv();
  const ok = env.EMAIL;
  env.EMAIL = { send: async () => { throw Object.assign(new Error("domain not verified"), { code: "E_SENDER_NOT_VERIFIED" }); } };
  const r = await start(env, "fay@example.com");
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "code_not_sent");
  assert.equal(one(env, "SELECT code_hash FROM studio_email_codes WHERE inbox = 'fay@example.com'").code_hash, "");
  for (const guess of ["000000", "123456"]) assert.equal((await verify(env, "fay@example.com", guess)).json.code, "code_expired");
  env.EMAIL = ok;
  age(env, "fay@example.com", 31_000);
  assert.equal((await verify(env, "fay@example.com", await askCode(env, "fay@example.com"))).status, 200);
});

test("a code from Facebook's browser opens a new account: the gift, the source, the 'email' sign-in; it works once", async () => {
  const env = newEnv();
  const code = await askCode(env, "bea@example.com", { "user-agent": FB_UA });
  const bad = await verify(env, "bea@example.com", otherThan(code), { "user-agent": FB_UA });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "wrong_code");
  assert.equal(one(env, "SELECT attempts FROM studio_email_codes WHERE inbox = 'bea@example.com'").attempts, 1);
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
  assert.equal((await verify(env, "bea@example.com", code)).json.code, "code_expired", "used once");
  age(env, "bea@example.com", 31_000);
  const back = await verify(env, "bea@example.com", await askCode(env, "bea@example.com"));
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json.gift, undefined, "an account that exists gets no second gift");
  assert.equal((await call(env, "/api/me", { cookie: sessionOf(back) })).json.id, me.json.id);
});

test("STUDIO_EMAIL_CODE_GIFT off: a new account opens with no credits, and the page says why", async () => {
  const env = newEnv({ STUDIO_EMAIL_CODE_GIFT: "" });
  const r = await verify(env, "gus@example.com", await askCode(env, "gus@example.com"));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.gift, 0);
  assert.equal(r.json.note, mod.CODE_NO_GIFT_SENTENCE);
  assert.equal((await call(env, "/api/me", { cookie: sessionOf(r) })).json.credits, 0);
  assert.equal(cookiesOf(r.res).some((c) => c.startsWith("__Host-kleo_gift=")), false);
});

test("limits per inbox: half a minute, five an hour, five tries a code, ten a day, ten minutes, no throwaway or bounced box", async () => {
  const env = newEnv();
  await askCode(env, "cal@example.com");
  assert.equal((await start(env, "cal@example.com")).json.code, "code_wait");
  for (let i = 0; i < 4; i++) { age(env, "cal@example.com", 31_000); await askCode(env, "cal@example.com"); }
  age(env, "cal@example.com", 31_000);
  assert.equal((await start(env, "cal@example.com")).json.code, "code_hour");
  assert.equal(env.sent.length, 5);
  age(env, "cal@example.com", 3_600_000);
  const code = await askCode(env, "cal@example.com");
  assert.equal(one(env, "SELECT window_sends FROM studio_email_codes WHERE inbox = 'cal@example.com'").window_sends, 1, "a new hour starts its own count");

  for (let i = 0; i < 5; i++) assert.equal((await verify(env, "cal@example.com", otherThan(code))).json.code, "wrong_code");
  const locked = await verify(env, "cal@example.com", code);
  assert.equal(locked.status, 429);
  assert.equal(locked.json.code, "code_tries", "after five wrong tries even the right code fails");
  assert.equal(one(env, "SELECT attempts FROM studio_email_codes WHERE inbox = 'cal@example.com'").attempts, 5, "the count never passes the cap");

  // Five more wrong tries on a new code reach the day's ten: then nothing opens and no code goes out until tomorrow.
  age(env, "cal@example.com", 31_000);
  const second = await askCode(env, "cal@example.com");
  for (let i = 0; i < 5; i++) assert.equal((await verify(env, "cal@example.com", otherThan(second))).json.code, "wrong_code");
  assert.equal((await verify(env, "cal@example.com", second)).json.code, "code_day");
  age(env, "cal@example.com", 31_000);
  assert.equal((await start(env, "cal@example.com")).json.code, "code_day");

  const env2 = newEnv();
  const late = await askCode(env2, "dot@example.com");
  env2.DB.db.prepare("UPDATE studio_email_codes SET expires_at = ? WHERE inbox = 'dot@example.com'").run(Date.now() - 1);
  assert.equal((await verify(env2, "dot@example.com", late)).json.code, "code_expired");
  assert.equal((await verify(env2, "nobody@example.com", "123456")).json.code, "code_expired", "no code asked, nothing opens");
  assert.equal((await verify(env2, "dot@example.com", "12345")).json.code, "wrong_code");
  assert.equal((await start(env2, "x@mailinator.com")).json.code, "email_domain");
  assert.equal((await start(env2, "not an address")).status, 400);
  env2.DB.db.prepare("INSERT INTO mail_suppress (email, reason, source) VALUES ('gone@example.com', 'bounce', 'onboarding'), ('quiet@example.com', 'unsubscribe', 'onboarding')").run();
  assert.equal((await start(env2, "gone@example.com")).json.code, "email_suppressed", "a bounced address gets no more mail");
  assert.equal((await start(env2, "quiet@example.com")).status, 200, "one that stopped the welcome e-mails still gets the code it asks for");
});

test("one inbox, one budget: other spellings share every limit, and open no account that the inbox already has", async () => {
  const env = newEnv();
  // Gmail ignores dots and +tags: these land in one box, so they share the wait, and a code works only for its spelling.
  const code = await askCode(env, "zed@gmail.com");
  assert.equal((await start(env, "z.ed+fb@gmail.com")).json.code, "code_wait");
  assert.equal((await verify(env, "z.ed@gmail.com", code)).json.code, "code_expired", "the code opens the spelling it went to");
  assert.equal((await verify(env, "z.ed+fb@gmail.com", code)).json.code, "code_expired");
  // Five wrong tries end the code; tries under other spellings open nothing, so they buy no guesses either.
  for (let i = 0; i < 5; i++) assert.equal((await verify(env, "zed@gmail.com", otherThan(code))).json.code, "wrong_code");
  assert.equal((await verify(env, "zed@gmail.com", code)).json.code, "code_tries");
  assert.equal((await verify(env, "z.ed@gmail.com", code)).json.code, "code_expired");

  // An account made with one spelling is never handed to another one, even when a code proves that other spelling.
  const eve = await signUpWithPassword(env, "eve.lyn@gmail.com");
  const canon = await verify(env, "evelyn+fb@gmail.com", await askCode(env, "evelyn+fb@gmail.com"));
  assert.equal(canon.status, 409);
  assert.equal(canon.json.code, "other_spelling");
  assert.equal(sessionOf(canon), null);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM studio_logins WHERE user_id = ? AND provider = 'password'", eve.id).n, 1, "the account keeps its password");
  assert.equal((await call(env, "/api/me", { cookie: eve.cookie })).status, 200, "and its sessions");

  // A catch-all domain: "ann+x@corp.com" may reach someone else's box. Ann's Google account stays hers.
  env.DB.db.prepare("INSERT INTO users (id, email, credits, email_canon) VALUES ('u_anncorp0001', 'ann@corp.com', 3, 'ann@corp.com')").run();
  env.DB.db.prepare("INSERT INTO studio_logins (provider, subject, user_id, email) VALUES ('google', 'g-ann', 'u_anncorp0001', 'ann@corp.com')").run();
  const catchAll = await verify(env, "ann+x@corp.com", await askCode(env, "ann+x@corp.com"));
  assert.equal(catchAll.json.code, "other_spelling");
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM studio_logins WHERE user_id = 'u_anncorp0001'").n, 1, "nothing of Ann's account changes");
});

test("the inbox's owner: the account a vouched sign-in holds, a claimed account handed over, never the admin", async () => {
  const env = newEnv();
  // A password account (passwords are open here: no Google keys) only CLAIMS its address.
  const dan = await signUpWithPassword(env, "dan@example.com");
  const handed = await verify(env, "dan@example.com", await askCode(env, "dan@example.com"));
  assert.equal(handed.status, 200, handed.text);
  assert.equal(handed.json.linked, "email");
  assert.equal(handed.json.gift, undefined);
  assert.equal((await call(env, "/api/me", { cookie: sessionOf(handed) })).json.id, dan.id);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM studio_logins WHERE user_id = ? AND provider = 'password'", dan.id).n, 0, "the claimant's password goes");
  assert.equal((await call(env, "/api/me", { cookie: dan.cookie })).status, 401, "the claimant's session ends");
  // Now the address signs in with codes: a password sign-up with it is refused.
  assert.equal((await call(env, "/api/auth/signup", { method: "POST", body: { email: "dan@example.com", password: "long enough pw" } })).json.code, "use_email");

  // An address Google vouches for finds that account, as it is.
  env.DB.db.prepare("INSERT INTO users (id, email, credits) VALUES ('u_giagoogle01', 'gia@gmail.com', 7)").run();
  env.DB.db.prepare("INSERT INTO studio_logins (provider, subject, user_id, email) VALUES ('google', 'g-1', 'u_giagoogle01', 'gia@gmail.com')").run();
  const g = await verify(env, "gia@gmail.com", await askCode(env, "gia@gmail.com"));
  assert.equal(g.status, 200, g.text);
  assert.equal(g.json.linked, undefined);
  assert.equal((await call(env, "/api/me", { cookie: sessionOf(g) })).json.id, "u_giagoogle01");
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM studio_logins WHERE user_id = 'u_giagoogle01' AND provider = 'google'").n, 1, "Google stays");

  // The admin account opens with its password (or Google) only.
  const boss = await signUpWithPassword(env, "boss@example.com");
  env.STUDIO_ADMINS = boss.id;
  const no = await verify(env, "boss@example.com", await askCode(env, "boss@example.com"));
  assert.equal(no.status, 403);
  assert.equal(no.json.code, "admin_code");
  assert.equal(sessionOf(no), null);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM studio_logins WHERE user_id = ? AND provider = 'password'", boss.id).n, 1, "nothing of the admin's changes");
});

test("Google on an account opened with a code: the same account, nothing evicted, no session ended", async () => {
  const env = newEnv({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs" });
  const r = await verify(env, "hal@gmail.com", await askCode(env, "hal@gmail.com"));
  assert.equal(r.status, 200, r.text);
  const hal = (await call(env, "/api/me", { cookie: sessionOf(r) })).json.id;
  const startG = await worker.fetch(new Request("https://app.kleo.test/auth/google"), env, ctx);
  const to = new URL(startG.headers.get("location"));
  const state = cookiesOf(startG)[0].split(";")[0];
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  answer = (u) => (u.includes("oauth2.googleapis.com/token")
    ? new Response(JSON.stringify({ id_token: `${b64u({ alg: "RS256" })}.${b64u({ sub: "g-hal", aud: "gid", nonce: to.searchParams.get("nonce"), email: "hal@gmail.com", email_verified: true })}.sig` }), { headers: { "content-type": "application/json" } })
    : new Response("?", { status: 404 }));
  try {
    const cb = await worker.fetch(new Request(`https://app.kleo.test/auth/google/callback?code=c1&state=${to.searchParams.get("state")}`, { headers: { cookie: state } }), env, ctx);
    await Promise.allSettled(pending.splice(0));
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/");
  } finally { answer = null; }
  assert.equal(one(env, "SELECT user_id FROM studio_logins WHERE provider = 'google' AND subject = 'g-hal'").user_id, hal);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM studio_logins WHERE user_id = ? AND provider = 'email'", hal).n, 1, "the code sign-in stays");
  assert.equal((await call(env, "/api/me", { cookie: sessionOf(r) })).status, 200, "the code's session still works");
});

test("the human check and the throttle: Turnstile when configured, AUTH_LIMIT per visitor and per inbox", async () => {
  const env = newEnv({ TURNSTILE_SECRET: "ts" });
  const r = await start(env, "ivy@example.com");
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "turnstile");
  assert.equal(env.sent.length, 0);

  const keys = [];
  const env2 = newEnv({ AUTH_LIMIT: { limit: async ({ key }) => { keys.push(key); return { success: !key.startsWith("signin:") }; } } });
  const t = await start(env2, "J.O.E+fb@Gmail.com");
  assert.equal(t.status, 429);
  assert.equal(t.json.code, "rate");
  assert.ok(keys.includes("signin:joe@gmail.com"), `the per-address key is the inbox: ${keys.join(", ")}`);
  assert.equal((await verify(env2, "joe@gmail.com", "123456")).status, 429);
});

test("the sign-in screen: the e-mail code first in an app's browser, a button elsewhere, the six digits typed easily", () => {
  const app = readFileSync(join(ROOT, "studio-web", "app.js"), "utf8");
  const auth = app.slice(app.indexOf("function renderAuth("), app.indexOf("function renderForgot("));
  assert.match(auth, /codeFirst \? codeBox\(mode\) : hop \? hopBox\(mode\) : null,/, "in an app's browser the code replaces the step to Safari or Chrome");
  assert.match(auth, /codeOn && !codeFirst \? emailButton\(mode\) : null/, "elsewhere it is one more way in, next to Google");
  assert.match(auth, /S\.config\?\.emailCode === "signin" && mode === "signin"/, "'signin' shows the code on the sign-in screen only");
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
