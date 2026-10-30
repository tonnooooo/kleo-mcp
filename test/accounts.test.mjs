/**
 * The open door: signed anonymous accounts, the one-button sign-in page, the free credits and the caps that
 * protect them. Same recipe as credits.test.mjs (esbuild bundle + a D1 look-alike on node:sqlite), with a fake
 * OAuth provider so the real /authorize code of src/auth.ts is exercised end to end. No network, no Worker.
 * Run: node --test test/accounts.test.mjs
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

/* ------------------------------------------------------------------ D1 on node:sqlite */
// The D1 stand-in is test/fake-d1.mjs: meta.changes as D1 counts it, the rows a trigger changes included.

let m;
before(async () => {
  const r = await esbuild.build({
    stdin: {
      contents: `export * from "./src/auth.ts"; export * from "./src/accounts.ts"; export * from "./src/credits.ts";
        export * from "./src/db.ts"; export * from "./src/schema.ts"; export * from "./src/connect.ts"; export { readJsonBounded } from "./src/util.ts";`,
      resolveDir: ROOT, loader: "ts",
    },
    // The OAuth library cannot be bundled outside the Workers runtime; see the stub's own comment.
    alias: { "@cloudflare/workers-oauth-provider": join(ROOT, "test/fixtures/oauth-provider-stub.mjs") },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"], // the planner on Claude (20 September) loads the SDK only when called, which no test here does
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
    INTERNAL_SECRET: "s3cret", FREE_CREDITS: "7", MAX_NEW_USERS_PER_DAY: "25", RESULT_TTL_DAYS: "7",
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
test("sign-in: one press creates an anonymous account with the FREE_CREDITS gift (below a film on purpose) and remembers it", async () => {
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
  assert.equal(rows[0].credits, 7, "FREE_CREDITS=7 since 14 September: a gift that cannot buy the 10-credit film by itself");
  assert.equal(rows[0].email, `${rows[0].id}@anon.kleo.invalid`, "the synthetic address satisfies NOT NULL UNIQUE, so no migration was needed");
  assert.equal(rows[0].invite_code, null);
  assert.equal(await m.verifyHandle(env, handleOf(res)), rows[0].id);
  const created = audits(env, "user.created");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].detail, { source: "open", credits: 7, ip: null }, "no CF-Connecting-IP in this request, and an address is never stored raw anyway");
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
  assert.equal((await m.getUser(env, id)).credits, 7, "and must not refill the free credits either");
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
  assert.equal((await m.getUser(env, id)).credits, 7, "the balance travels with the key");
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
  assert.equal((await m.getUser(env, mineId)).credits, 7, "the browser's own account is left untouched");
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
  assert.equal((await m.getUser(env, id)).credits, 8, "a gift handed out at a meet-up must reach a person who is already in");
  assert.equal(uses(), 1);
  assert.equal(audits(env, "bonus.applied").length, 1);

  await press(env, { cookie: cookieOf(first), form: { bonus: "MARCO-1" } });
  assert.equal((await m.getUser(env, id)).credits, 8, "and cannot be typed again on every reconnection");
  assert.equal(uses(), 1, "a refused gift does not spend a use either");
  assert.equal(audits(env, "bonus.rejected").length, 1, "but it IS written down, so a lost gift can be traced");
});

test("sign-in: a bonus code adds credits on top of the free ones; an unknown one just adds nothing", async () => {
  const env = await newEnv();
  env.DB.db.exec("INSERT INTO invites (code, credits, max_uses, note) VALUES ('MARCO-1', 1, 1, 'referral: Marco')");

  await press(env, { form: { bonus: "marco-1" } }); // typed in lower case, like a person would
  const withBonus = users(env)[0];
  assert.equal(withBonus.credits, 8, "7 free + 1 bonus");
  assert.equal(withBonus.invite_code, "MARCO-1");
  assert.equal(env.DB.db.prepare("SELECT uses FROM invites WHERE code = 'MARCO-1'").get().uses, 1);
  assert.equal(audits(env, "bonus.applied").length, 1, "the gift is applied after the account exists, so it is its own audit row");

  // A code is a gift, never a gate: an unknown or spent one must still let the person in.
  const plain = await press(env, { form: { bonus: "NOT-A-CODE" } });
  assert.equal(plain.status, 302);
  const second = users(env).find((u) => u.id !== withBonus.id);
  assert.equal(second.credits, 7);
  assert.equal(second.invite_code, null, "a code that gave nothing is not recorded as if it had");

  const spent = await press(env, { form: { bonus: "MARCO-1" } });
  assert.equal(spent.status, 302, "an exhausted code is not an error either");
  assert.equal(users(env).find((u) => u.id !== withBonus.id && u.id !== second.id).credits, 7);
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
  assert.match(fresh, /Start free - 7 credits included/);
  assert.match(fresh, /1 credit buys 1\.5 seconds of film, 10 credits minimum: 10 credits for a 15-second film, 20 for a 30-second Short, 40 for a minute, 200 for five minutes; an animatic of the same storyboard \([^)]*\) costs 5 credits up to 20 seconds, 10 up to 60 seconds\. You start with 7 credits: a short animatic on the house \(up to 20 seconds[^)]*\)\. A film — every shot a generated clip — starts at 10 credits \(15 seconds\) and is made for accounts that have bought a pack: the 5 EUR pack alone is a 15-second film, and a launch code opens one for free\./, "the page quotes the tariff, says the gift buys an animatic and that a film needs a pack, all computed");
  assert.match(fresh, /No email\. No password\. No card\. No invite code\./);
  assert.ok(!/type="email"/.test(fresh), "there is no email field any more");
  assert.ok(!/type="checkbox"/.test(fresh), "and no consent box: pressing the button is the consent");
  assert.ok(!/Invite code/.test(fresh), "and no invite wall");
  assert.match(fresh, /<details><summary>Have a bonus code, or a Kleo key\?/, "the two rare fields are there, closed");

  const res = await press(env);
  const back = await (await openPage(env, cookieOf(res))).text();
  assert.match(back, /Welcome back - 7 credits left/);
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
  assert.match(body, /7 credits left/);
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

test("sign-in: one gift per person — a second account from the same address, or from a browser that had one, starts at zero; a farm of accounts is blocked", async () => {
  const env = await newEnv({ MAX_NEW_USERS_PER_DAY: "25", MAX_NEW_USERS_PER_IP_DAY: "10" });
  const first = await press(env, { ip: "203.0.113.60" });
  assert.equal(first.status, 302);
  assert.match(first.headers.get("set-cookie"), /__Host-kleo_gift=1; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax/);
  const second = await press(env, { ip: "203.0.113.60" });
  assert.equal(second.status, 302, "the account still opens: connecting is free, the gift is not");
  assert.doesNotMatch(second.headers.get("set-cookie"), /kleo_gift/);
  assert.deepEqual(users(env).map((u) => u.credits).sort(), [0, 7]);
  // Another address, but a browser that already had the gift.
  assert.equal((await press(env, { ip: "198.51.100.61", cookie: "__Host-kleo_gift=1" })).status, 302);
  assert.equal(users(env).filter((u) => u.credits === 0).length, 2);
  // The third account of one address opens; the fourth is refused, and the address is blocked.
  assert.equal((await press(env, { ip: "203.0.113.60" })).status, 302);
  const farm = await press(env, { ip: "203.0.113.60" });
  assert.equal(farm.status, 403);
  assert.match(await farm.text(), /No new Kleo accounts can be opened from this connection/);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM blocked_addresses").get().n, 1);
  // Everybody else is unaffected.
  assert.equal((await press(env, { ip: "198.51.100.62" })).status, 302);
  assert.equal(users(env).at(-1).credits, 7);
});

/* ------------------------------------------------------------------ one account everywhere (19 October 2026) */
const addUser = (env, id, email, credits = 0) => env.DB.db.prepare("INSERT INTO users (id, email, credits) VALUES (?, ?, ?)").run(id, email, credits);
const userRow = (env, id) => env.DB.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
const finishRequest = (path, cookie) => new Request(`http://kleo.test${path}`, { headers: cookie ? { cookie } : {} });

test("studio sign-in: /authorize sends the browser to Kleo Studio with the request signed, opens no account, and the one-press form is gone", async () => {
  const env = await newEnv({ MCP_SIGNIN: "studio", STUDIO_URL: "https://app.kleo.test" });
  const anon = await press(await newEnv()); // an old anonymous account in another deployment: its cookie means nothing here
  addUser(env, "u_anon00000001", "u_anon00000001@anon.kleo.invalid", 4);
  const held = `kleo_id=${await m.makeHandle(env, "u_anon00000001")}`;
  const res = await openPage(env, held);
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://app.kleo.test/connect");
  const nonce = (res.headers.get("set-cookie") ?? "").match(/__Host-kleo_connect=([^;]+);.*HttpOnly; Secure; SameSite=Lax/)?.[1];
  assert.ok(nonce, "the nonce stays behind in a __Host- cookie");
  const r = await m.readToken(env, "request", to.searchParams.get("r"));
  assert.equal(r.q, OAUTH_QUERY);
  assert.equal(r.n, nonce);
  assert.equal(r.a, "u_anon00000001", "the browser's old anonymous account rides along, to be merged");
  assert.equal(r.o, "http://kleo.test");
  assert.equal(users(env).length, 1, "no account was opened");
  assert.equal(await m.readToken(env, "finish", to.searchParams.get("r")), null, "a request token is never a finish ticket");
  assert.equal((await press(env)).status, 410, "nothing can open an anonymous account behind the page");
  assert.ok(anon);
});

test("studio sign-in: /authorize/finish grants the account Studio signed, only in the browser that started, only in time", async () => {
  const env = await newEnv({ MCP_SIGNIN: "studio" });
  addUser(env, "u_real00000001", "ana@example.com", 12);
  const ticket = (o = {}) => m.signToken(env, "finish", { u: "u_real00000001", n: "nonce-1", q: OAUTH_QUERY, exp: Math.floor(Date.now() / 1000) + 300, ...o });
  const ok = await m.handleConnectFinish(finishRequest(`/authorize/finish?t=${await ticket()}`, "__Host-kleo_connect=nonce-1"), env);
  assert.equal(ok.status, 302, await ok.clone().text());
  assert.equal(ok.headers.get("location"), `${REDIRECT}?code=code_u_real00000001&state=xyz`);
  assert.equal(env.OAUTH_PROVIDER.granted.at(-1).props.userId, "u_real00000001");
  assert.equal(env.OAUTH_PROVIDER.granted.at(-1).props.email, "ana@example.com");
  assert.match(ok.headers.get("set-cookie"), /kleo_id=u_real00000001\./);
  assert.equal(audits(env, "oauth.granted").at(-1).detail.via, "studio");
  const before = env.OAUTH_PROVIDER.granted.length;
  assert.equal((await m.handleConnectFinish(finishRequest(`/authorize/finish?t=${await ticket()}`, "__Host-kleo_connect=other"), env)).status, 403, "another browser cannot finish it");
  assert.equal((await m.handleConnectFinish(finishRequest(`/authorize/finish?t=${await ticket()}`), env)).status, 403);
  assert.equal((await m.handleConnectFinish(finishRequest(`/authorize/finish?t=${await ticket({ exp: 1 })}`, "__Host-kleo_connect=nonce-1"), env)).status, 400, "an old ticket is dead");
  const forged = (await ticket()).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.equal((await m.handleConnectFinish(finishRequest(`/authorize/finish?t=${forged}`, "__Host-kleo_connect=nonce-1"), env)).status, 400);
  assert.equal(env.OAUTH_PROVIDER.granted.length, before, "none of those granted anything");
});

test("merging an old anonymous account: credits and films move, the old id points at the real account, and it happens once", async () => {
  const env = await newEnv();
  addUser(env, "u_anon00000002", "u_anon00000002@anon.kleo.invalid", 12);
  addUser(env, "u_real00000002", "bo@example.com", 3);
  env.DB.db.prepare("INSERT INTO jobs (id, user_id, template, prompt, params, state, credits, worker_secret) VALUES ('j_1', 'u_anon00000002', 'film', 'p', '{}', 'done', 5, 'w')").run();
  assert.equal(await m.mergeAnonymous(env, "u_anon00000002", "u_real00000002", "test"), 12);
  assert.equal(userRow(env, "u_real00000002").credits, 15);
  assert.equal(userRow(env, "u_anon00000002").credits, 0);
  assert.equal(userRow(env, "u_anon00000002").merged_into, "u_real00000002");
  assert.equal(env.DB.db.prepare("SELECT user_id FROM jobs WHERE id = 'j_1'").get().user_id, "u_real00000002");
  assert.equal((await m.activeAccount(env, await m.getUser(env, "u_anon00000002"))).id, "u_real00000002", "the old grant now acts on the real account");
  assert.equal(await m.mergeAnonymous(env, "u_anon00000002", "u_real00000002", "again"), null, "a second merge moves nothing");
  assert.equal(userRow(env, "u_real00000002").credits, 15);
  addUser(env, "u_real00000003", "cy@example.com", 9);
  assert.equal(await m.mergeAnonymous(env, "u_real00000003", "u_real00000002", "test"), null, "a real account is never swallowed");
  assert.equal(audits(env, "account.merged_in").length, 1);
});

test("an account merged into another connects no assistant: neither Studio's ticket nor /authorize/finish (27 October 2026)", async () => {
  const env = await newEnv({ MCP_SIGNIN: "studio" });
  addUser(env, "u_real00000020", "target@example.com", 5);
  addUser(env, "u_real00000021", "old@example.com", 0);
  env.DB.db.prepare("UPDATE users SET merged_into = 'u_real00000020' WHERE id = 'u_real00000021'").run();
  const r = await m.signToken(env, "request", { q: OAUTH_QUERY, n: "n21", a: null, c: "Grok", o: "https://mcp.kleo.test", exp: Math.floor(Date.now() / 1000) + 600 });
  const out = await m.studioConnect(env, "u_real00000021", { r });
  assert.equal(out.code, "merged");
  assert.equal(out.url, undefined);
  const before = env.OAUTH_PROVIDER.granted.length;
  const t = await m.signToken(env, "finish", { u: "u_real00000021", n: "nonce-21", q: OAUTH_QUERY, exp: Math.floor(Date.now() / 1000) + 300 });
  assert.equal((await m.handleConnectFinish(finishRequest(`/authorize/finish?t=${t}`, "__Host-kleo_connect=nonce-21"), env)).status, 403);
  assert.equal(env.OAUTH_PROVIDER.granted.length, before, "no grant that would act on the account it went into");
});

test("studio connect: the signed-in account gets a finish ticket naming the browser's anonymous account; a bare Kleo key is not enough", async () => {
  const env = await newEnv();
  addUser(env, "u_anon00000004", "u_anon00000004@anon.kleo.invalid", 7);
  addUser(env, "u_real00000004", "di@example.com", 1);
  const r = await m.signToken(env, "request", { q: OAUTH_QUERY, n: "n4", a: "u_anon00000004", c: "Grok", o: "https://mcp.kleo.test", exp: Math.floor(Date.now() / 1000) + 600 });
  const out = await m.studioConnect(env, "u_real00000004", { r });
  assert.equal(out.merged, null, "nothing is merged until the browser that started proves it at /authorize/finish");
  assert.equal(out.client, "Grok");
  const t = new URL(out.url);
  assert.equal(t.origin + t.pathname, "https://mcp.kleo.test/authorize/finish");
  const fin = await m.readToken(env, "finish", t.searchParams.get("t"));
  assert.deepEqual({ u: fin.u, n: fin.n, q: fin.q, a: fin.a }, { u: "u_real00000004", n: "n4", q: OAUTH_QUERY, a: "u_anon00000004" });
  assert.equal(userRow(env, "u_real00000004").credits, 1);
  assert.equal(userRow(env, "u_anon00000004").merged_into, null);
  // The link an assistant on an anonymous account hands out: alone it merges nothing, it sends the browser to prove it.
  addUser(env, "u_anon00000005", "u_anon00000005@anon.kleo.invalid", 2);
  const link = new URL(await m.signInLink({ ...env, STUDIO_URL: "https://app.kleo.test" }, "u_anon00000005"));
  assert.equal(link.origin + link.pathname, "https://app.kleo.test/connect");
  const first = await m.studioConnect(env, "u_real00000004", { m: link.searchParams.get("m") });
  assert.equal(first.merged, null);
  assert.match(first.url, /^http:\/\/kleo\.test\/authorize\/merge\?t=/, "a link without an origin in it goes to PUBLIC_URL");
  assert.equal(userRow(env, "u_anon00000005").merged_into, null);
  // Signed in to Studio with nothing but an anonymous account's key: refused, so the assistant lands on a real account.
  addUser(env, "u_anon00000006", "u_anon00000006@anon.kleo.invalid", 5);
  assert.equal((await m.studioConnect(env, "u_anon00000006", { r })).code, "anonymous");
  assert.match((await m.studioConnect(env, "u_real00000004", { r: "nope.nope" })).error, /expired/);
  const reply = m.signInRequiredReply(9, "https://app.kleo.test/connect?m=x");
  assert.equal(reply.id, 9);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /https:\/\/app\.kleo\.test\/connect\?m=x/);
});

test("the sign-in gate sees a tools/call alone or inside a batch, and reads at most the size limit (27 October 2026)", async () => {
  assert.deepEqual(m.firstToolCall({ jsonrpc: "2.0", id: 3, method: "tools/call" }), { jsonrpc: "2.0", id: 3, method: "tools/call" });
  assert.equal(m.firstToolCall([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "tools/call" }]).id, 2, "a batch does not slip past");
  assert.equal(m.firstToolCall({ jsonrpc: "2.0", id: 1, method: "tools/list" }), null);
  assert.equal(m.firstToolCall(null), null);
  assert.equal(m.firstToolCall([null, 7, "x"]), null);
  const req = (body) => new Request("https://mcp.kleo.test/mcp", { method: "POST", body });
  assert.deepEqual(await m.readJsonBounded(req('{"a":1}'), 100), { a: 1 });
  assert.equal(await m.readJsonBounded(req("x".repeat(101)), 100), null, "past the limit: nothing is parsed");
  assert.equal(await m.readJsonBounded(req("not json"), 100), null);
  const broken = new ReadableStream({ pull(c) { c.error(new Error("upload cut")); } });
  assert.equal(await m.readJsonBounded(new Request("https://mcp.kleo.test/mcp", { method: "POST", body: broken, duplex: "half" }), 100), null, "a broken upload is null, not a throw");
});

const inSeconds = (s) => Math.floor(Date.now() / 1000) + s;

test("studio connect: a forwarded r link merges nothing; only the browser that started merges its account, at /authorize/finish", async () => {
  const env = await newEnv({ MCP_SIGNIN: "studio" });
  addUser(env, "u_anon00000007", "u_anon00000007@anon.kleo.invalid", 6);
  addUser(env, "u_evil00000007", "eve@example.com", 0);
  addUser(env, "u_real00000007", "fay@example.com", 1);
  const r = await m.signToken(env, "request", { q: OAUTH_QUERY, n: "n7", a: "u_anon00000007", c: "Grok", o: "http://kleo.test", exp: inSeconds(600) });
  // Somebody else, signed in to Studio, opens the forwarded link: nothing moves, and their finish link is dead elsewhere.
  const evil = new URL((await m.studioConnect(env, "u_evil00000007", { r })).url);
  assert.equal(userRow(env, "u_anon00000007").merged_into, null);
  for (const cookie of [undefined, "__Host-kleo_connect=other"]) {
    assert.equal((await m.handleConnectFinish(finishRequest(evil.pathname + evil.search, cookie), env)).status, 403);
  }
  assert.equal(userRow(env, "u_anon00000007").merged_into, null, "a browser without the nonce merges nothing");
  assert.equal(userRow(env, "u_evil00000007").credits, 0);
  assert.equal(env.OAUTH_PROVIDER.granted.length, 0);
  // The browser that started, with its nonce cookie: the anonymous account comes in as the grant is made.
  const mine = new URL((await m.studioConnect(env, "u_real00000007", { r })).url);
  const ok = await m.handleConnectFinish(finishRequest(mine.pathname + mine.search, "__Host-kleo_connect=n7"), env);
  assert.equal(ok.status, 302);
  assert.equal(userRow(env, "u_anon00000007").merged_into, "u_real00000007");
  assert.equal(userRow(env, "u_real00000007").credits, 7);
  assert.equal(audits(env, "account.merged_in").at(-1).detail.why, "connect");
});

test("studio connect: an assistant's sign-in link merges only in the browser holding that account, then ends on Studio's confirmation", async () => {
  const env = await newEnv({ STUDIO_URL: "https://app.kleo.test" });
  addUser(env, "u_anon00000008", "u_anon00000008@anon.kleo.invalid", 3);
  addUser(env, "u_anon00000009", "u_anon00000009@anon.kleo.invalid", 4); // another browser's anonymous account
  addUser(env, "u_real00000008", "gus@example.com", 1);
  const link = new URL(await m.signInLink(env, "u_anon00000008", "https://mcp.kleo.test"));
  const out = await m.studioConnect(env, "u_real00000008", { m: link.searchParams.get("m") });
  assert.equal(out.merged, null);
  const claim = new URL(out.url);
  assert.equal(claim.origin + claim.pathname, "https://mcp.kleo.test/authorize/merge", "the host the assistant reached, where its cookie is");
  const at = (cookie, path = claim.pathname + claim.search) => m.handleConnectMerge(finishRequest(path, cookie), env);
  // Forwarded to a browser without that account's cookie, or holding another one: refused, nothing moved.
  for (const cookie of [undefined, `kleo_id=${await m.makeHandle(env, "u_anon00000009")}`, `kleo_id=${await m.makeHandle(env, "u_real00000008")}`, "kleo_id=u_anon00000008.00000000000000000000000000000000"]) {
    const res = await at(cookie);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("location"), null);
  }
  const holder = `kleo_id=${await m.makeHandle(env, "u_anon00000008")}`;
  const expired = await m.signToken(env, "claim", { u: "u_real00000008", a: "u_anon00000008", exp: 1 });
  assert.equal((await at(holder, `/authorize/merge?t=${expired}`)).status, 400, "an old claim is dead");
  assert.equal((await at(holder, `/authorize/merge?t=${link.searchParams.get("m")}`)).status, 400, "a sign-in link is not a claim");
  assert.equal(userRow(env, "u_anon00000008").merged_into, null);
  assert.equal(userRow(env, "u_real00000008").credits, 1);
  // The claim is no proof by itself: Studio does not take it back as a link.
  assert.match((await m.studioConnect(env, "u_real00000008", { m: claim.searchParams.get("t") })).error, /expired/);
  // The browser that holds it is sent back to Studio, at its configured address, with a held ticket; nothing merged here.
  const res = await at(holder);
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get("location"));
  assert.equal(back.origin + back.pathname, "https://app.kleo.test/connect");
  assert.equal(userRow(env, "u_anon00000008").merged_into, null);
  const held = back.searchParams.get("m");
  assert.equal(await m.readToken(env, "merge", held), null, "a held ticket is not a sign-in link");
  // Studio's /connect posts it: the merge is made there and confirmed with the credits it moved.
  assert.deepEqual(await m.studioConnect(env, "u_real00000008", { m: held }), { merged: 3 });
  assert.equal(userRow(env, "u_anon00000008").merged_into, "u_real00000008");
  assert.equal(userRow(env, "u_real00000008").credits, 4);
  assert.equal(audits(env, "account.merged_in").at(-1).detail.why, "assistant-link");
  assert.deepEqual(await m.studioConnect(env, "u_real00000008", { m: held }), { merged: 0 }, "a second post is fine");
  assert.deepEqual(await m.studioConnect(env, "u_real00000008", { m: link.searchParams.get("m") }), { merged: 0 }, "and so is opening the link again");
  assert.equal(userRow(env, "u_anon00000009").merged_into, null);
});

test("studio connect: a claim forwarded to the account's owner cannot pour it into the account that made the claim", async () => {
  const env = await newEnv({ STUDIO_URL: "https://app.kleo.test" });
  addUser(env, "u_anon00000010", "u_anon00000010@anon.kleo.invalid", 5); // the owner's anonymous account
  addUser(env, "u_evil00000010", "eve@example.com", 0);
  addUser(env, "u_real00000010", "hal@example.com", 0); // the owner's own Studio account
  const leaked = new URL(await m.signInLink(env, "u_anon00000010", "http://kleo.test"));
  const claim = new URL((await m.studioConnect(env, "u_evil00000010", { m: leaked.searchParams.get("m") })).url);
  // The owner's browser follows the forwarded claim: it holds the account, so it is sent back to Studio…
  const res = await m.handleConnectMerge(finishRequest(claim.pathname + claim.search, `kleo_id=${await m.makeHandle(env, "u_anon00000010")}`), env);
  const held = new URL(res.headers.get("location")).searchParams.get("m");
  // …where the session is not the account that made the claim: refused, whoever is signed in there.
  assert.match((await m.studioConnect(env, "u_real00000010", { m: held })).error, /another Kleo account/);
  assert.equal(userRow(env, "u_anon00000010").merged_into, null);
  assert.equal(userRow(env, "u_evil00000010").credits, 0);
});

test("studio connect: a sign-in link with nothing to take in answers { merged: null } as before, with no detour", async () => {
  const env = await newEnv();
  addUser(env, "u_real00000011", "ida@example.com", 2);
  addUser(env, "u_anon00000011", "u_anon00000011@anon.kleo.invalid", 3);
  env.DB.db.prepare("INSERT INTO studio_logins (provider, subject, user_id, email) VALUES ('google', 'g-11', 'u_anon00000011', 'ida2@example.com')").run();
  const mOf = async (a) => new URL(await m.signInLink(env, a, "http://kleo.test")).searchParams.get("m");
  assert.deepEqual(await m.studioConnect(env, "u_real00000011", { m: await mOf("u_anon00000011") }), { merged: null }, "signed in to Studio since: no longer anonymous");
  assert.deepEqual(await m.studioConnect(env, "u_real00000011", { m: await mOf("u_real00000011") }), { merged: null }, "the account's own link");
  assert.deepEqual(await m.studioConnect(env, "u_real00000011", { m: await mOf("u_gone00000011") }), { merged: null }, "an account that no longer exists");
  assert.equal(userRow(env, "u_anon00000011").merged_into, null);
  assert.equal(userRow(env, "u_real00000011").credits, 2);
});

