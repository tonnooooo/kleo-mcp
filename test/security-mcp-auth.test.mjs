/**
 * The security pass on the MCP Worker's sign-in (14 October 2026): the login-CSRF guard on POST /authorize and
 * POST /credits (src/util.ts crossSiteRequest), the consent page naming the host the code goes back to, Cloudflare
 * Turnstile asked only of the press that creates a NEW account, and the parts of src/accounts.ts the pass changed
 * (IPv6 /64 buckets, versioned Kleo keys that old keys survive, rotateKey). Same recipe as accounts.test.mjs: esbuild
 * bundle, a D1 look-alike on node:sqlite with every migration applied, the OAuth provider faked, and the one network
 * call (Turnstile's siteverify) answered by a fake fetch. Offline and deterministic.
 * Run: node --test test/security-mcp-auth.test.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
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
        export * from "./src/db.ts"; export { crossSiteRequest } from "./src/util.ts";`,
      resolveDir: ROOT, loader: "ts",
    },
    // The OAuth library cannot be bundled outside the Workers runtime; see the stub's own comment.
    alias: { "@cloudflare/workers-oauth-provider": join(ROOT, "test/fixtures/oauth-provider-stub.mjs") },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"],
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
    clientName: "Test Assistant",
    async parseAuthRequest(request) {
      const q = new URL(request.url).searchParams;
      return { clientId: q.get("client_id"), redirectUri: q.get("redirect_uri"), scope: (q.get("scope") ?? "").split(" ").filter(Boolean), state: q.get("state") };
    },
    async lookupClient(clientId) { return { clientId, clientName: this.clientName }; },
    async completeAuthorization(o) {
      granted.push(o);
      return { redirectTo: `${o.request.redirectUri}?code=code_${o.userId}&state=${o.request.state}` };
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

/** One press of the button. `headers` are what the browser adds (Sec-Fetch-Site, Origin), `cookie` its kleo_id,
 *  `form` the optional fields (and the Turnstile token), `ip` the address Cloudflare would put on the request. */
const press = (env, { cookie, form, ip, headers } = {}) =>
  m.handleAuthorize(new Request("http://kleo.test/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      ...(ip ? { "CF-Connecting-IP": ip } : {}),
      ...headers,
    },
    body: new URLSearchParams({ oauth_query: OAUTH_QUERY, ...form }),
  }), env);

const openPage = (env, cookie, query = OAUTH_QUERY) =>
  m.handleAuthorize(new Request(`http://kleo.test/authorize?${query}`, { headers: cookie ? { cookie } : {} }), env);

const handleOf = (res) => (res.headers.get("set-cookie") ?? "").match(/kleo_id=([^;]*)/)?.[1] ?? "";
const users = (env) => env.DB.db.prepare("SELECT * FROM users").all();
const newUser = (env, id, credits = 7) => m.createUser(env, { id, email: `${id}@anon.kleo.invalid`, credits });
const cookieFor = async (env, id) => `kleo_id=${await m.makeHandle(env, id)}`;
/** The kleo_id signature exactly as it was computed before key versions existed. */
const oldSignature = (secret, id) => createHmac("sha256", secret).update(`kleo-id:${id}`).digest("hex").slice(0, 32);

/* ------------------------------------------------------------------ the fake siteverify */
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TS = { TURNSTILE_SECRET: "ts_secret", TURNSTILE_SITEKEY: "0x4AAAAAAA-site" };

/** A stand-in for Cloudflare's siteverify that records every call; any other address fails the test loudly. */
function fakeSiteverify(accept) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url !== SITEVERIFY) throw new Error(`unexpected network call: ${url}`);
    const body = init.body;
    const call = { secret: body.get("secret"), response: body.get("response"), remoteip: body.get("remoteip") };
    calls.push(call);
    return new Response(JSON.stringify({ success: accept(call) }), { headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

/* ------------------------------------------------------------------ cross-site posts */
test("crossSiteRequest: Sec-Fetch-Site decides when it is there, Origin when it is not, and neither means no browser", () => {
  const req = (headers) => new Request("https://mcp.kleooai.com/authorize", { method: "POST", headers });
  assert.equal(m.crossSiteRequest(req({ "Sec-Fetch-Site": "cross-site" })), true);
  assert.equal(m.crossSiteRequest(req({ "Sec-Fetch-Site": "same-site" })), true, "a sibling subdomain is not this page either");
  assert.equal(m.crossSiteRequest(req({ "Sec-Fetch-Site": "same-origin" })), false);
  assert.equal(m.crossSiteRequest(req({ "Sec-Fetch-Site": "Same-Origin " })), false, "read case- and space-insensitively");
  assert.equal(m.crossSiteRequest(req({ "Sec-Fetch-Site": "none" })), false, "typed or bookmarked: the user's own act");

  assert.equal(m.crossSiteRequest(req({ Origin: "https://evil.example" })), true, "an older browser is judged by Origin");
  assert.equal(m.crossSiteRequest(req({ Origin: "null" })), true, "a sandboxed frame or a data: page is foreign");
  assert.equal(m.crossSiteRequest(req({ Origin: "http://mcp.kleooai.com" })), true, "another scheme is another origin");
  assert.equal(m.crossSiteRequest(req({ Origin: "https://mcp.kleooai.com" })), false);

  assert.equal(m.crossSiteRequest(req({})), false, "curl, the e2e scripts, Node's fetch: no victim's cookies ride on them");
});

test("login CSRF: a press another site started is refused before the form is read, and no cookie is set", async () => {
  const env = await newEnv();
  // The attack: the attacker's own Kleo key, auto-posted from their page, would bind the victim's browser to it.
  await newUser(env, "u_attacker");
  const attackerKey = await m.makeHandle(env, "u_attacker");

  for (const headers of [
    { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site", Origin: "https://other.kleo.test" },
    { Origin: "https://evil.example" }, // a browser too old for Sec-Fetch-Site still sends Origin on a form POST
    { Origin: "null" },
  ]) {
    const res = await press(env, { headers, form: { account_key: attackerKey } });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(res.headers.get("set-cookie"), null, `no cookie may come back: ${JSON.stringify(headers)}`);
    assert.match(await res.text(), /only be sent from Kleo's own page/);
  }
  const fresh = await press(env, { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(fresh.status, 403, "and no account is opened for a cross-site press either");
  assert.equal(users(env).length, 1, "only the attacker's own account exists");
  assert.equal(env.OAUTH_PROVIDER.granted.length, 0, "no OAuth grant was completed");
});

test("login CSRF: Kleo's own form, and a request with neither header, sign in as before", async () => {
  const env = await newEnv();
  const own = await press(env, { headers: { "Sec-Fetch-Site": "same-origin", Origin: "http://kleo.test" } });
  assert.equal(own.status, 302);
  assert.ok(await m.verifyHandle(env, handleOf(own)), "the press from the page itself gets its cookie");

  const oldBrowser = await press(env, { headers: { Origin: "http://kleo.test" } });
  assert.equal(oldBrowser.status, 302, "an older browser posting from this origin is let through by Origin");

  const plain = await press(env);
  assert.equal(plain.status, 302, "no Sec-Fetch-Site and no Origin: not a browser, nothing to forge");
  assert.equal(users(env).length, 3);
});

test("/credits: a cross-site POST cannot change the account (here: point its video links at another inbox)", async () => {
  const env = await newEnv();
  await newUser(env, "u_a");
  const k = await m.makeViewToken(env, "u_a");
  const cookie = await cookieFor(env, "u_a");
  const contact = () => env.DB.db.prepare("SELECT contact_email FROM users WHERE id = 'u_a'").get().contact_email;
  const post = (headers, form) => m.handleCredits(new Request("http://kleo.test/credits", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie, ...headers }, body: new URLSearchParams({ k, ...form }),
  }), env);

  const forged = await post({ "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" }, { action: "email", email: "thief@evil.example" });
  assert.equal(forged.status, 403);
  assert.equal(forged.headers.get("set-cookie"), null);
  assert.equal(contact(), null, "the owner's cookie rode along, and still nothing was written");
  assert.equal((await post({ Origin: "https://evil.example" }, { action: "redeem", code: "HN" })).status, 403, "Origin alone, on an older browser");

  const own = await post({ "Sec-Fetch-Site": "same-origin", Origin: "http://kleo.test" }, { action: "email", email: "ann@example.com" });
  assert.equal(own.status, 200, "the page's own form still works");
  assert.equal(contact(), "ann@example.com");

  // GET is untouched: the account link is opened from a chat, which IS a cross-site navigation.
  const link = await m.handleCredits(new Request(`http://kleo.test/credits?k=${encodeURIComponent(k)}`, { headers: { "Sec-Fetch-Site": "cross-site" } }), env);
  assert.equal(link.status, 200);
});

/* ------------------------------------------------------------------ the host on the consent page */
test("returnHost: a web address by its host, an app's own scheme kept, nothing for nothing", () => {
  assert.equal(m.returnHost("https://claude.ai/api/mcp/auth_callback"), "claude.ai");
  assert.equal(m.returnHost("http://localhost:33418/callback"), "localhost:33418");
  assert.equal(m.returnHost("https://Claude.AI:443/x"), "claude.ai", "normalised the way the browser will go there");
  assert.equal(m.returnHost("cursor://anysphere.cursor-retrieval/oauth/x/callback"), "cursor://anysphere.cursor-retrieval");
  assert.equal(m.returnHost("com.example.app:/callback"), "com.example.app:");
  assert.equal(m.returnHost(""), "");
  assert.equal(m.returnHost(null), "");
  assert.equal(m.returnHost(undefined), "");
  assert.equal(m.returnHost("not a url"), "");
});

test("consent page: names the host the code goes back to, on the page and when it comes back with an error", async () => {
  const env = await newEnv();
  const page = await (await openPage(env)).text();
  assert.match(page, /After you continue you go back to <b>localhost:9999<\/b>\. If that is not the assistant you are connecting, close this page\./);

  // Any client can register itself under any name: the name says "Claude", the address says who gets the code.
  env.OAUTH_PROVIDER.clientName = "Claude";
  const phish = new URLSearchParams({ response_type: "code", client_id: "client_x", redirect_uri: "https://evil.example/cb", scope: "video:create", state: "s" }).toString();
  const lure = await (await openPage(env, null, phish)).text();
  assert.match(lure, /Connect Claude to Kleo/);
  assert.match(lure, /go back to <b>evil\.example<\/b>/);

  // An app scheme may carry quotes and ampersands in its host: they reach the page escaped.
  const odd = new URLSearchParams({ response_type: "code", client_id: "client_y", redirect_uri: 'x-app://a"b&c/cb', state: "s" }).toString();
  const oddPage = await (await openPage(env, null, odd)).text();
  assert.match(oddPage, /go back to <b>x-app:\/\/a&quot;b&amp;c<\/b>/);
  assert.ok(!oddPage.includes('x-app://a"b&c'), "never raw");

  env.OAUTH_PROVIDER.clientName = "Test Assistant";
  const bad = await press(env, { form: { account_key: "u_nosuchthing.0123456789abcdef0123456789abcdef" } });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /go back to <b>localhost:9999<\/b>/, "the error re-render names it too");
});

/* ------------------------------------------------------------------ Turnstile */
test("Turnstile: with a site key the widget sits inside the form for a new visitor; a returning browser is not shown it", async () => {
  const widget = '<div class="cf-turnstile" data-sitekey="0x4AAAAAAA-site" data-theme="dark" data-appearance="interaction-only"></div>';
  const script = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';

  const env = await newEnv(TS);
  const page = await (await openPage(env)).text();
  assert.ok(page.includes(script), "the implicit-render script is loaded");
  const at = page.indexOf(widget);
  assert.ok(at > page.indexOf("<form") && at < page.indexOf("</form>"), "inside the form, so its hidden token field is posted with it");

  await newUser(env, "u_back");
  const back = await (await openPage(env, await cookieFor(env, "u_back"))).text();
  assert.match(back, /Welcome back/);
  assert.ok(!back.includes('class="cf-turnstile"') && !back.includes("challenges.cloudflare.com"), "a returning browser is never asked, so it loads nothing");

  const off = await (await openPage(await newEnv())).text();
  assert.ok(!off.includes('class="cf-turnstile"') && !off.includes("challenges.cloudflare.com"), "no site key, no widget");
});

test("Turnstile: a returning browser, or a pasted Kleo key, gets in with no token and no call to Cloudflare", async () => {
  const env = await newEnv(TS);
  await newUser(env, "u_back");
  const cookie = await cookieFor(env, "u_back");
  const key = await m.makeHandle(env, "u_back");
  const sv = fakeSiteverify(() => false); // a checker that would refuse everybody

  const res = await withFetch(sv.fetch, () => press(env, { cookie }));
  assert.equal(res.status, 302);
  assert.equal(await m.verifyHandle(env, handleOf(res)), "u_back");
  const moved = await withFetch(sv.fetch, () => press(env, { form: { account_key: key } }));
  assert.equal(moved.status, 302, "a key brings an account that exists: nothing new is handed out");
  assert.equal(await m.verifyHandle(env, handleOf(moved)), "u_back");

  assert.equal(sv.calls.length, 0, "the check was never asked");
  assert.equal(users(env).length, 1);
});

test("Turnstile: a new visitor without a token is refused, with no account and no cookie", async () => {
  const env = await newEnv(TS);
  const sv = fakeSiteverify((c) => c.response === "good-token");

  const none = await withFetch(sv.fetch, () => press(env));
  assert.equal(none.status, 403);
  assert.equal(none.headers.get("set-cookie"), null);
  const body = await none.text();
  assert.match(body, /could not check that you are a person/);
  assert.ok(body.includes('class="cf-turnstile"'), "the page comes back with the widget, ready for another try");
  assert.equal(sv.calls.length, 0, "an empty token is refused without asking Cloudflare");

  const forged = await withFetch(sv.fetch, () => press(env, { form: { "cf-turnstile-response": "made-up" } }));
  assert.equal(forged.status, 403, "a token Cloudflare does not accept is refused too");
  assert.equal(sv.calls.length, 1);

  // A cookie that verifies but whose account is gone is a new visitor, and is asked like one.
  const ghostCookie = await cookieFor(env, "u_gone");
  assert.equal(await m.verifyHandle(env, ghostCookie.slice("kleo_id=".length)), "u_gone", "the signature itself is fine");
  const ghost = await withFetch(sv.fetch, () => press(env, { cookie: ghostCookie }));
  assert.equal(ghost.status, 403);

  assert.equal(users(env).length, 0);
  assert.equal(env.OAUTH_PROVIDER.granted.length, 0);
});

test("Turnstile: a new visitor whose token Cloudflare accepts gets an account", async () => {
  const env = await newEnv(TS);
  const sv = fakeSiteverify((c) => c.response === "good-token");
  const res = await withFetch(sv.fetch, () => press(env, { form: { "cf-turnstile-response": "good-token" }, ip: "203.0.113.9" }));
  assert.equal(res.status, 302);
  const rows = users(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].credits, 7);
  assert.equal(await m.verifyHandle(env, handleOf(res)), rows[0].id);
  assert.deepEqual(sv.calls, [{ secret: "ts_secret", response: "good-token", remoteip: "203.0.113.9" }]);
});

/* ------------------------------------------------------------------ src/accounts.ts */
test("ipBucket: IPv4 whole, IPv6 by its /64, IPv4-mapped IPv6 as the IPv4 it is", () => {
  assert.equal(m.ipBucket("203.0.113.7"), "203.0.113.7");
  assert.equal(m.ipBucket("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(m.ipBucket("2001:db8:1:2::9"), "2001:db8:1:2::/64", "one home's /64, however it is written");
  assert.equal(m.ipBucket("2001:0DB8:0001:0002:ffff::1"), "2001:db8:1:2::/64", "case and leading zeros do not make a new visitor");
  assert.equal(m.ipBucket("2001:db8::1"), "2001:db8:0:0::/64", "the :: inside the first four groups is expanded");
  assert.equal(m.ipBucket("::ffff:1.2.3.4"), "1.2.3.4");
});

test("ipBucket: one /64 is one visitor for the rate limit and for the per-address cap", async () => {
  const env = await newEnv({ MAX_NEW_USERS_PER_IP_DAY: "1" });
  assert.equal(await m.signupRateKey(env, "2001:db8:1:2:3:4:5:6"), await m.signupRateKey(env, "2001:db8:1:2::9"));
  assert.notEqual(await m.signupRateKey(env, "2001:db8:1:2::9"), await m.signupRateKey(env, "2001:db8:1:3::9"));

  assert.equal((await press(env, { ip: "2001:db8:1:2:3:4:5:6" })).status, 302);
  assert.equal((await press(env, { ip: "2001:db8:1:2::9" })).status, 429, "rotating inside the /64 does not open a second free account");
  assert.equal((await press(env, { ip: "2001:db8:1:3::9" })).status, 302, "the next /64 is somebody else");
  assert.equal(users(env).length, 2);
});

test("makeHandle: key_version 0 signs exactly as before versions existed, so every key handed out still works", async () => {
  const env = await newEnv();
  await newUser(env, "u_old");
  assert.equal(env.DB.db.prepare("SELECT key_version FROM users WHERE id = 'u_old'").get().key_version, 0);
  const legacy = `u_old.${oldSignature("s3cret", "u_old")}`;
  assert.equal(await m.makeHandle(env, "u_old"), legacy);
  assert.equal(await m.makeHandle(env, "u_old", 0), legacy);
  assert.equal(await m.verifyHandle(env, legacy), "u_old", "a key printed before 14 October opens its account");

  const res = await press(env, { cookie: `kleo_id=${legacy}` });
  assert.equal(res.status, 302);
  assert.equal(await m.verifyHandle(env, handleOf(res)), "u_old", "and an old cookie signs in to the same account");
  assert.equal(users(env).length, 1);
});

test("rotateKey: the old key stops working everywhere, the new one opens the same account", async () => {
  const env = await newEnv();
  await newUser(env, "u_rot", 12);
  const oldKey = await m.makeHandle(env, "u_rot");
  const newKey = await m.rotateKey(env, "u_rot");

  assert.notEqual(newKey, oldKey);
  assert.equal(newKey, `u_rot.${createHmac("sha256", "s3cret").update("kleo-id:u_rot:1").digest("hex").slice(0, 32)}`);
  assert.equal(env.DB.db.prepare("SELECT key_version FROM users WHERE id = 'u_rot'").get().key_version, 1);
  assert.equal(await m.verifyHandle(env, oldKey), null, "the retired key is refused");
  assert.equal(await m.verifyHandle(env, newKey), "u_rot");

  const pasted = await press(env, { form: { account_key: oldKey } });
  assert.equal(pasted.status, 400, "a retired key pasted on the sign-in page is refused");
  assert.match(await pasted.text(), /Kleo key is not valid/);
  const fresh = await press(env, { form: { account_key: newKey } });
  assert.equal(fresh.status, 302);
  assert.equal(await m.verifyHandle(env, handleOf(fresh)), "u_rot");
  assert.equal(users(env).find((u) => u.id === "u_rot").credits, 12, "the balance stays with the account");

  const third = await m.rotateKey(env, "u_rot");
  assert.equal(await m.verifyHandle(env, newKey), null, "every rotation retires the key before it");
  assert.equal(await m.verifyHandle(env, third), "u_rot");
});

test("an assistant's grant carries the key version it was made under: a new Kleo key disconnects it", async () => {
  const env = await newEnv();
  await newUser(env, "u_grant", 12);
  const key = await m.makeHandle(env, "u_grant");
  // An assistant connected with the key (a pasted key, or the kleo_id cookie it set): its props say version 0.
  assert.equal((await press(env, { form: { account_key: key } })).status, 302);
  const [grant] = env.OAUTH_PROVIDER.granted;
  assert.deepEqual(grant.props, { userId: "u_grant", email: "u_grant@anon.kleo.invalid", keyVersion: 0 });
  assert.equal(await m.grantStillValid(env, "u_grant", grant.props.keyVersion), true);
  assert.equal(await m.grantStillValid(env, "u_grant", undefined), true, "a grant made before versions existed is version 0");
  // The key leaked; the owner makes a new one (Studio's "New Kleo key", a password reset, an eviction): every grant
  // made under the old key stops opening /mcp, the old-format one included.
  const fresh = await m.rotateKey(env, "u_grant");
  assert.equal(await m.grantStillValid(env, "u_grant", grant.props.keyVersion), false);
  assert.equal(await m.grantStillValid(env, "u_grant", undefined), false);
  // Connected again with the new key: a grant of the current version, which the next rotation retires in turn.
  assert.equal((await press(env, { form: { account_key: fresh } })).status, 302);
  const again = env.OAUTH_PROVIDER.granted[1];
  assert.equal(again.props.keyVersion, 1);
  assert.equal(await m.grantStillValid(env, "u_grant", again.props.keyVersion), true);
  await m.rotateKey(env, "u_grant");
  assert.equal(await m.grantStillValid(env, "u_grant", again.props.keyVersion), false);
});

test("a browser whose Kleo key was replaced is asked for the new key, not handed a new empty account", async () => {
  const env = await newEnv();
  await newUser(env, "u_stale", 30);
  const oldCookie = `kleo_id=${await m.makeHandle(env, "u_stale")}`;
  const newKey = await m.rotateKey(env, "u_stale");
  const users = () => env.DB.db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const before = users();
  const asked = await press(env, { cookie: oldCookie });
  assert.equal(asked.status, 409);
  assert.match(await asked.text(), /new Kleo key/);
  assert.match(asked.headers.get("set-cookie") ?? "", /^kleo_id=; Path=\/; Max-Age=0/, "the stale cookie is cleared");
  assert.equal(users(), before, "no account was opened");
  const back = await press(env, { cookie: oldCookie, form: { account_key: newKey } });
  assert.equal(back.status, 302);
  assert.equal(await m.verifyHandle(env, handleOf(back)), "u_stale", "the new key brings the same account back");
  const fresh = await press(env);
  assert.equal(fresh.status, 302, "with no cookie left, pressing again starts a new account");
  assert.equal(users(), before + 1);
});
