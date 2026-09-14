/**
 * The open door: signed anonymous accounts, the one-button sign-in page, the free credits and the caps that
 * protect them. Same recipe as credits.test.mjs (esbuild bundle + a D1 look-alike on node:sqlite), with a fake
 * OAuth provider so the real /authorize code of src/auth.ts is exercised end to end. No network, no Worker.
 * Run: node --test test/accounts.test.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ D1 on node:sqlite */
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

let m;
before(async () => {
  const r = await esbuild.build({
    stdin: {
      contents: `export * from "./src/auth.ts"; export * from "./src/accounts.ts"; export * from "./src/credits.ts";
        export * from "./src/db.ts"; export * from "./src/schema.ts";`,
      resolveDir: ROOT, loader: "ts",
    },
    // The OAuth library cannot be bundled outside the Workers runtime; see the stub's own comment.
    alias: { "@cloudflare/workers-oauth-provider": join(ROOT, "test/fixtures/oauth-provider-stub.mjs") },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent",
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

/* ------------------------------------------------------------------ a fake OAuth provider */
const REDIRECT = "http://localhost:9999/cb";
const OAUTH_QUERY = new URLSearchParams({
  response_type: "code", client_id: "client_1", redirect_uri: REDIRECT, scope: "video:create video:read", state: "xyz",
}).toString();

function fakeProvider() {
  const granted = [];
  return {
    granted,
    async parseAuthRequest(request) {
      const q = new URL(request.url).searchParams;
      return { clientId: q.get("client_id"), redirectUri: q.get("redirect_uri"), scope: (q.get("scope") ?? "").split(" ").filter(Boolean), state: q.get("state") };
    },
    async lookupClient(clientId) { return { clientId, clientName: "Test Assistant" }; },
    async completeAuthorization(o) {
      granted.push(o);
      return { redirectTo: `${REDIRECT}?code=code_${o.userId}&state=${o.request.state}` };
    },
  };
}

async function newEnv(extra = {}) {
  const env = {
    DB: new FakeD1(), OAUTH_PROVIDER: fakeProvider(), RENDER_BACKEND: "mock", PUBLIC_URL: "http://kleo.test",
    INTERNAL_SECRET: "s3cret", FREE_FILMS: "0", MAX_NEW_USERS_PER_DAY: "25", RESULT_TTL_DAYS: "7",
    MAX_CONCURRENT_GPUS: "2", MAX_JOBS_PER_USER: "1", JOB_TIMEOUT_MIN: "60",
    ...extra,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}

/** One press of the button. `cookie` is the browser's kleo_id, `form` the two optional fields, `ip` the address
 *  Cloudflare would put on the request (only its fingerprint ever reaches the database). */
const press = (env, { cookie, form, ip } = {}) =>
  m.handleAuthorize(new Request("http://kleo.test/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      ...(ip ? { "CF-Connecting-IP": ip } : {}),
    },
    body: new URLSearchParams({ oauth_query: OAUTH_QUERY, ...form }),
  }), env);

const openPage = (env, cookie) =>
  m.handleAuthorize(new Request(`http://kleo.test/authorize?${OAUTH_QUERY}`, { headers: cookie ? { cookie } : {} }), env);

/** The kleo_id the browser is told to keep, straight out of the Set-Cookie header. */
const cookieOf = (res) => `kleo_id=${(res.headers.get("set-cookie") ?? "").match(/kleo_id=([^;]*)/)?.[1] ?? ""}`;
const handleOf = (res) => cookieOf(res).slice("kleo_id=".length);
const users = (env) => env.DB.db.prepare("SELECT * FROM users").all();
const audits = (env, event) => env.DB.db.prepare("SELECT * FROM audit WHERE event = ?").all(event).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));

/* ------------------------------------------------------------------ the signed handle */
test("handle: a round trip returns the user id, and one changed character does not", async () => {
  const env = await newEnv();
  const handle = await m.makeHandle(env, "u_abcdefgh1234");
  assert.equal(await m.verifyHandle(env, handle), "u_abcdefgh1234");
  assert.match(handle, /^u_abcdefgh1234\.[0-9a-f]{32}$/, "user id, a dot, half a SHA-256: pasteable by hand");

  const flip = (s, i) => s.slice(0, i) + (s[i] === "a" ? "b" : "a") + s.slice(i + 1);
  assert.equal(await m.verifyHandle(env, flip(handle, handle.length - 1)), null, "a tampered signature is refused");
  assert.equal(await m.verifyHandle(env, flip(handle, 2)), null, "and so is a swapped user id");
  assert.equal(await m.verifyHandle(env, handle.slice(0, -1)), null, "a truncated key (copy-paste cut short) is refused");
  assert.equal(await m.verifyHandle(env, "u_abcdefgh1234"), null, "an unsigned id is worth nothing");
  assert.equal(await m.verifyHandle(env, ""), null);
  assert.equal(await m.verifyHandle(env, null), null);
  assert.equal(await m.verifyHandle(env, ".".repeat(40)), null);

  // The signature is the secret, not the format: another deployment's key never opens this one.
  const other = await newEnv({ INTERNAL_SECRET: "different" });
  assert.equal(await m.verifyHandle(other, handle), null);
});

test("handle: the cookie value is found among other cookies, and only when it is there", () => {
  assert.equal(m.cookieHandle("a=1; kleo_id=u_x.ab12; b=2"), "u_x.ab12");
  assert.equal(m.cookieHandle("kleo_id=u_x.ab12"), "u_x.ab12");
  assert.equal(m.cookieHandle("kleo_idx=nope"), null, "a cookie whose name merely starts the same is not ours");
  assert.equal(m.cookieHandle("kleo_id="), null);
  assert.equal(m.cookieHandle(null), null);
});

/* ------------------------------------------------------------------ the one button */
test("sign-in: one press creates an anonymous account with one film's worth of credits (FREE_FILMS) and remembers it", async () => {
  const env = await newEnv();
  const res = await press(env);
  assert.equal(res.status, 302);
  // Response.redirect() has immutable headers, so the cookie could never ride on it: the 302 is built by hand.
  assert.match(res.headers.get("location"), /^http:\/\/localhost:9999\/cb\?code=code_u_/);
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "without this header the browser is a new visitor every time");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.ok(Number(setCookie.match(/Max-Age=(\d+)/)[1]) > 300 * 24 * 3600, "the account is meant to outlive the session");

  const rows = users(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].credits, 0, "FREE_FILMS=0 since 14 September: a new account starts at zero, and the number is computed, never typed");
  assert.equal(rows[0].email, `${rows[0].id}@anon.kleo.invalid`, "the synthetic address satisfies NOT NULL UNIQUE, so no migration was needed");
  assert.equal(rows[0].invite_code, null);
  assert.equal(await m.verifyHandle(env, handleOf(res)), rows[0].id);
  const created = audits(env, "user.created");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].detail, { source: "open", credits: 0, ip: null }, "no CF-Connecting-IP in this request, and an address is never stored raw anyway");
  assert.equal(env.OAUTH_PROVIDER.granted[0].userId, rows[0].id, "and the OAuth grant is completed for that same account");
});

test("sign-in: the same browser comes back to the same account and is given NO new credits", async () => {
  const env = await newEnv();
  const first = await press(env);
  const id = await m.verifyHandle(env, handleOf(first));

  const again = await press(env, { cookie: cookieOf(first) });
  assert.equal(again.status, 302);
  assert.equal(await m.verifyHandle(env, handleOf(again)), id, "same account");
  assert.equal(users(env).length, 1, "connecting a second assistant must not mint a second account");
  assert.equal((await m.getUser(env, id)).credits, 0, "and must not refill the free credits either");
  assert.equal(audits(env, "user.created").length, 1);
});

test("sign-in: a Kleo key carries the account to a browser that has no cookie", async () => {
  const env = await newEnv();
  const first = await press(env);
  const id = await m.verifyHandle(env, handleOf(first));

  const moved = await press(env, { form: { account_key: handleOf(first) } });
  assert.equal(moved.status, 302);
  assert.equal(await m.verifyHandle(env, handleOf(moved)), id);
  assert.equal(users(env).length, 1);
  assert.equal((await m.getUser(env, id)).credits, 0, "the balance travels with the key, including an empty one");
});

test("sign-in: a Kleo key that is not valid is refused, and no account is created for it", async () => {
  const env = await newEnv();
  const res = await press(env, { form: { account_key: "u_nosuchthing.0123456789abcdef0123456789abcdef" } });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Kleo key is not valid/);
  assert.equal(users(env).length, 0, "a wrong key must not silently start a new account and hide the mistake");
});

test("sign-in: a typed Kleo key wins over the cookie this browser already has", async () => {
  // The flow the key exists for is precisely the one where the browser has a cookie of its own: somebody who already
  // pressed the button on the new laptop and now wants their real account back.
  const env = await newEnv();
  const mine = await press(env);
  const mineId = await m.verifyHandle(env, handleOf(mine));
  const other = await m.createUser(env, { id: "u_other", email: "u_other@anon.kleo.invalid", credits: 7 });

  const moved = await press(env, { cookie: cookieOf(mine), form: { account_key: await m.makeHandle(env, other.id) } });
  assert.equal(moved.status, 302);
  assert.equal(await m.verifyHandle(env, handleOf(moved)), "u_other", "the account that was typed in is the one that comes back");
  assert.equal(env.OAUTH_PROVIDER.granted.at(-1).userId, "u_other", "and the OAuth grant follows it, not the cookie");
  assert.equal((await m.getUser(env, mineId)).credits, 0, "the browser's own account is left untouched");
  assert.equal(users(env).length, 2, "and no third account is created");
});

test("sign-in: a Kleo key that is not valid is an error even when the cookie would have worked", async () => {
  const env = await newEnv();
  const first = await press(env);
  const res = await press(env, { cookie: cookieOf(first), form: { account_key: "u_nosuchthing.0123456789abcdef0123456789abcdef" } });
  assert.equal(res.status, 400, "silently signing them into the browser's own account hides the mistake");
  assert.match(await res.text(), /Kleo key is not valid/);
  assert.equal(users(env).length, 1);
});

test("sign-in: a bonus code works on the account this browser already has, and only once", async () => {
  const env = await newEnv();
  env.DB.db.exec("INSERT INTO invites (code, credits, max_uses, note) VALUES ('MARCO-1', 1, 5, 'referral: Marco')");
  const first = await press(env);
  const id = await m.verifyHandle(env, handleOf(first));
  const uses = () => env.DB.db.prepare("SELECT uses FROM invites WHERE code = 'MARCO-1'").get().uses;

  await press(env, { cookie: cookieOf(first), form: { bonus: "marco-1" } });
  assert.equal((await m.getUser(env, id)).credits, 1, "a gift handed out at a meet-up must reach a person who is already in");
  assert.equal(uses(), 1);
  assert.equal(audits(env, "bonus.applied").length, 1);

  await press(env, { cookie: cookieOf(first), form: { bonus: "MARCO-1" } });
  assert.equal((await m.getUser(env, id)).credits, 1, "and cannot be typed again on every reconnection");
  assert.equal(uses(), 1, "a refused gift does not spend a use either");
  assert.equal(audits(env, "bonus.rejected").length, 1, "but it IS written down, so a lost gift can be traced");
});

test("sign-in: a bonus code adds credits on top of the free ones; an unknown one just adds nothing", async () => {
  const env = await newEnv();
  env.DB.db.exec("INSERT INTO invites (code, credits, max_uses, note) VALUES ('MARCO-1', 1, 1, 'referral: Marco')");

  await press(env, { form: { bonus: "marco-1" } }); // typed in lower case, like a person would
  const withBonus = users(env)[0];
  assert.equal(withBonus.credits, 1, "0 free + 1 bonus");
  assert.equal(withBonus.invite_code, "MARCO-1");
  assert.equal(env.DB.db.prepare("SELECT uses FROM invites WHERE code = 'MARCO-1'").get().uses, 1);
  assert.equal(audits(env, "bonus.applied").length, 1, "the gift is applied after the account exists, so it is its own audit row");

  // A code is a gift, never a gate: an unknown or spent one must still let the person in.
  const plain = await press(env, { form: { bonus: "NOT-A-CODE" } });
  assert.equal(plain.status, 302);
  const second = users(env).find((u) => u.id !== withBonus.id);
  assert.equal(second.credits, 0);
  assert.equal(second.invite_code, null, "a code that gave nothing is not recorded as if it had");

  const spent = await press(env, { form: { bonus: "MARCO-1" } });
  assert.equal(spent.status, 302, "an exhausted code is not an error either");
  assert.equal(users(env).find((u) => u.id !== withBonus.id && u.id !== second.id).credits, 0);
});

test("sign-in: past MAX_NEW_USERS_PER_DAY no account and no credits are created, and nobody is accused", async () => {
  const env = await newEnv({ MAX_NEW_USERS_PER_DAY: "1" });
  assert.equal((await press(env)).status, 302);
  const full = await press(env);
  assert.equal(full.status, 429);
  const body = await full.text();
  // The message is escaped into the page, so "today's" arrives as "today&#39;s": match around the apostrophe.
  assert.match(body, /Kleo has handed out today/);
  assert.match(body, /free credits\. Come back tomorrow/);
  assert.equal(users(env).length, 1, "the cap is inside the INSERT: no user, no credits, no audit row");
  assert.equal(audits(env, "user.created").length, 1);

  // The cap is about NEW accounts: somebody who already has one still gets in.
  const known = await m.createUser(env, { id: "u_known", email: "u_known@anon.kleo.invalid", credits: 5 });
  const back = await press(env, { cookie: `kleo_id=${await m.makeHandle(env, known.id)}` });
  assert.equal(back.status, 302);
  assert.equal((await m.getUser(env, "u_known")).credits, 5);
});

test("sign-in: one address cannot eat the whole day, and everybody else still gets in", async () => {
  const env = await newEnv({ MAX_NEW_USERS_PER_DAY: "25", MAX_NEW_USERS_PER_IP_DAY: "2" });
  assert.equal((await press(env, { ip: "203.0.113.7" })).status, 302);
  assert.equal((await press(env, { ip: "203.0.113.7" })).status, 302);

  const third = await press(env, { ip: "203.0.113.7" });
  assert.equal(third.status, 429);
  assert.match(await third.text(), /giving out its free credits slowly today/, "soft wording: whole offices share one address");
  assert.equal(users(env).length, 2, "and no third account was written");

  // The wall is per address, not global: the day is not over for anybody else.
  assert.equal((await press(env, { ip: "198.51.100.4" })).status, 302);
  assert.equal(users(env).length, 3);

  const stored = users(env).map((u) => u.ip_hash);
  assert.equal(new Set(stored).size, 2, "two addresses, two fingerprints");
  assert.ok(stored.every((h) => h && !h.includes("203.0.113") && !h.includes("198.51.100")), "the address itself is never stored");
});

test("sign-in: a press a cap refuses does not burn a use of the gift code that came with it", async () => {
  const env = await newEnv({ MAX_NEW_USERS_PER_DAY: "1" });
  env.DB.db.exec("INSERT INTO invites (code, credits, max_uses, note) VALUES ('CRISTIANO-1', 5, 1, 'Cristiano')");
  assert.equal((await press(env)).status, 302);

  const refused = await press(env, { form: { bonus: "CRISTIANO-1" } });
  assert.equal(refused.status, 429);
  assert.equal(env.DB.db.prepare("SELECT uses FROM invites WHERE code = 'CRISTIANO-1'").get().uses, 0,
    "the code is claimed only after the account exists, so a refused day cannot swallow somebody's gift");
});

test("sign-in: the rate limit binding, when there is one, answers before any account is touched", async () => {
  const seen = [];
  const env = await newEnv({ SIGNUP_LIMIT: { async limit({ key }) { seen.push(key); return { success: false }; } } });
  const res = await press(env);
  assert.equal(res.status, 429);
  assert.equal(users(env).length, 0);
  assert.ok(seen[0] && !seen[0].includes("unknown"), "the key is an HMAC, so no address is ever written down");
  assert.match(seen[0], /^[0-9a-f]{64}$/);
});

/* ------------------------------------------------------------------ the page itself */
test("page: one button and nothing to fill in; a returning browser is greeted with its balance instead", async () => {
  const env = await newEnv();
  const first = await openPage(env);
  const fresh = await first.text();
  assert.match(fresh, /<button type="submit">Start<\/button>/, "no free credits: the button promises nothing");
  assert.match(fresh, /1 credit buys 2 seconds of film, 10 credits minimum: 15 credits for a 30-second Short, 30 for a minute, 150 for five minutes\. A new account starts at zero credits: connecting is free, the first film is paid\./, "the page quotes the tariff and says plainly that nothing is free, both computed");
  assert.match(fresh, /No email\. No password\. No card\. No invite code\./);
  assert.ok(!/type="email"/.test(fresh), "there is no email field any more");
  assert.ok(!/type="checkbox"/.test(fresh), "and no consent box: pressing the button is the consent");
  assert.ok(!/Invite code/.test(fresh), "and no invite wall");
  assert.match(fresh, /<details><summary>Have a bonus code, or a Kleo key\?/, "the two rare fields are there, closed");

  const res = await press(env);
  const back = await (await openPage(env, cookieOf(res))).text();
  assert.match(back, /Welcome back - 0 credits left/);
  assert.match(back, />Continue</);
  assert.ok(!/Start free/.test(back));
});

/* ------------------------------------------------------------------ the account page */
test("/credits: the link is read-only, is not the Kleo key, and never binds this browser to the account", async () => {
  const env = await newEnv();
  const res = await press(env);
  const handle = handleOf(res);
  const id = await m.verifyHandle(env, handle);
  const link = await m.makeViewToken(env, id);

  const page = await m.handleCredits(new Request(`http://kleo.test/credits?k=${encodeURIComponent(link)}`), env);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /0 credits left/, "a new account starts at zero since 14 September");
  assert.match(body, /not open yet/, "the page is honest about payments while there are none");
  assert.match(body, /5 EUR/, "and it does say how to get more, which is what the chat message promised");
  assert.match(body, /kleooai@gmail\.com/, "there is a human to write to");
  assert.ok(!body.includes(handle), "the link travels through a chat log: it must not print the string that owns the account");
  assert.equal(page.headers.get("set-cookie"), null, "and opening a link must never rebind this browser to that account");

  // The two strings are not interchangeable in either direction: one opens a page, the other owns the account.
  assert.equal(await m.verifyHandle(env, link), null);
  assert.equal(await m.verifyViewToken(env, handle), null);
  assert.equal((await m.handleCredits(new Request(`http://kleo.test/credits?k=${encodeURIComponent(handle)}`), env)).status, 404);

  const guessed = await m.handleCredits(new Request(`http://kleo.test/credits?k=${id}`), env);
  assert.equal(guessed.status, 404, "knowing (or guessing) a user id must not open their account");
  assert.equal((await m.handleCredits(new Request("http://kleo.test/credits"), env)).status, 404);

  const byCookie = await m.handleCredits(new Request("http://kleo.test/credits", { headers: { cookie: cookieOf(res) } }), env);
  assert.equal(byCookie.status, 200, "and the browser that owns the account needs no link at all");
  assert.ok((await byCookie.text()).includes(handle), "only that browser is shown the key");
});
