/**
 * Where Kleo Studio accounts come from (src/studio/attribution.ts, the admin console's Sources page in src/studio/admin.ts
 * and studio-web/admin.js), inside one process: the kleo-studio Worker bundled with esbuild, on a D1 look-alike
 * (node:sqlite, every migration applied). Covers how a visit's source is read (tags, ?src=, referrer, in-app browser as a
 * guess), the first-touch cookie and who never gets one, the first-visit counts, the short links (/r/<code>: click
 * counted, visit tagged, page opened), the account's row at sign-up (password and Google), and the funnel the console
 * shows per network and per link, with the accounts from before tracking.
 * Run: node --test test/studio-attribution.test.mjs
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
import { base32Decode, hotp, stepAt } from "../src/studio/totp.ts";

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
  constructor() { this.m = new Map(); }
  async put(key, body) { this.m.set(key, body); return {}; }
  async get() { return null; }
  async delete(keys) { for (const k of [].concat(keys)) this.m.delete(k); }
  async list() { return { objects: [], truncated: false }; }
}
// Every outside call goes through `answer`: DNS for the e-mail check, then whatever a test scripts (Google's token).
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
    stdin: { contents: `export { default } from "./src/studio/index.ts";
      export { touchOf, readTouch, touchCookie, isBot, inAppOf, channelOfSource, channelOfHost, pathTag, SOURCE_COOKIE } from "./src/studio/attribution.ts";
      export { slugOf, linkTargetProblem } from "./src/studio/admin.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email"],
  });
  mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
  worker = mod.default;
});

const CERT_FP = "3f".repeat(32);
const GOOD_TLS = { certPresented: "1", certVerified: "SUCCESS", certRevoked: "0", certFingerprintSHA256: CERT_FP };
function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: new FakeR2(), ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", EPHONE_API_KEY: "ek", FREE_CREDITS: "5", STUDIO_FREE_MODELS: "seedance-2.0-fast",
    MAX_NEW_USERS_PER_IP_DAY: "50", MAX_ACCOUNTS_PER_ADDRESS: "50", ADMIN_HOST: "admin.kleo.test", ADMIN_CERT_SHA256: CERT_FP,
    mails: [], OWNER_MAIL: { send: async (m) => { env.mails.push(m); } },
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };

const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
const IG_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22H31 Instagram 402.0.0.31.104 (iPhone16,2; iOS 18_7; en_US; en; scale=3.00; 1290x2796; 812345678)";
const TIKTOK_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_41.8.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/NZ";
const TIKTOK_ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP4A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0 Mobile Safari/537.36 trill_410800 BytedanceWebview/d8a21c6";
const FB_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.40.100;FBBV/700000000;FBDV/iPhone16,2]";

/** A page load of a browser on the app host (or a short link), the way Safari sends one. */
async function visit(env, path, { headers = {}, method = "GET" } = {}) {
  const req = new Request(`https://app.kleo.test${path}`, { method, headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "user-agent": SAFARI, ...headers }, redirect: "manual" });
  const res = await worker.fetch(req, env, ctx);
  await Promise.allSettled(pending.splice(0));
  return res;
}
const cookiesOf = (res) => res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""].filter(Boolean);
const sourceCookie = (res) => cookiesOf(res).find((c) => c.startsWith("__Host-kleo_src=") && !c.startsWith("__Host-kleo_src=;"))?.split(";")[0] ?? null;

async function call(env, path, { method = "GET", body, cookie, header = true, host, headers = {} } = {}) {
  const admin = host === "admin" || (host === undefined && /^\/(?:api\/)?admin(?:\/|$)/.test(path));
  const h = { "user-agent": SAFARI, ...headers };
  if (header) h["x-kleo"] = "1";
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["content-type"] = "application/json";
  const req = new Request(`https://${admin ? "admin" : "app"}.kleo.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  if (admin) Object.defineProperty(req, "cf", { value: { tlsClientAuth: GOOD_TLS } });
  const res = await worker.fetch(req, env, ctx);
  await Promise.allSettled(pending.splice(0));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, res };
}
const sessionOf = (r) => cookiesOf(r.res).find((c) => c.startsWith("__Host-kleo_studio="))?.split(";")[0] ?? null;
async function signUp(env, email, { cookie, headers = {} } = {}) {
  const r = await call(env, "/api/auth/signup", { method: "POST", body: { email, password: "long enough pw" }, cookie, headers });
  assert.equal(r.status, 200, r.text);
  const session = sessionOf(r);
  const me = await call(env, "/api/me", { cookie: session });
  return { cookie: session, id: me.json.id, res: r.res };
}
const codeAt = (secret, offset = 0) => hotp(secret, stepAt(Date.now()) + offset);
/** The owner's admin account with the console open, and one customer. */
async function setup(over = {}) {
  const env = newEnv(over);
  const owner = await signUp(env, "owner@example.com");
  env.STUDIO_ADMINS = owner.id;
  const e = await call(env, "/api/admin/auth/enroll", { method: "POST", cookie: owner.cookie, body: { password: "long enough pw" } });
  assert.equal(e.status, 200, e.text);
  const c = await call(env, "/api/admin/auth/enroll/confirm", { method: "POST", cookie: owner.cookie, body: { code: await codeAt(base32Decode(e.json.secret), -1) } });
  assert.equal(c.status, 200, c.text);
  owner.admin = `${owner.cookie}; ${cookiesOf(c.res).find((x) => x.startsWith("__Host-kleo_admin="))?.split(";")[0]}`;
  return { env, owner };
}
// node:sqlite answers objects with no prototype: copied into plain ones, so deepStrictEqual compares the values.
const rows = (env, sql, ...a) => env.DB.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const one = (env, sql, ...a) => { const r = env.DB.db.prepare(sql).get(...a); return r ? { ...r } : r; };
const today = () => new Date().toISOString().slice(0, 10);

test("a visit's source: a short link, its tags, ?src=, the referring host, else the in-app browser as a guess", () => {
  const t = (url, headers = {}) => mod.touchOf(new Request(url, { headers }), new URL(url));
  assert.equal(t("https://app.kleo.test/?utm_source=ig&utm_medium=social&utm_campaign=Lupin").channel, "instagram");
  assert.equal(t("https://app.kleo.test/?utm_source=TikTok").channel, "tiktok");
  assert.equal(t("https://app.kleo.test/?utm_source=newsletter").channel, "email");
  assert.equal(t("https://app.kleo.test/?utm_source=l.instagram.com").channel, "instagram");
  assert.equal(t("https://app.kleo.test/?utm_source=somewhere").channel, "other");
  assert.equal(t("https://app.kleo.test/?src=producthunt").channel, "producthunt");
  assert.equal(t("https://app.kleo.test/?ref=producthunt").src, "producthunt");
  for (const [ref, ch] of [["https://l.instagram.com/", "instagram"], ["https://www.tiktok.com/", "tiktok"], ["https://t.co/abc", "x"], ["https://m.youtube.com/watch?v=1", "youtube"],
    ["https://www.google.it/", "google"], ["https://gemini.google.com/app", "gemini"], ["https://chatgpt.com/", "chatgpt"], ["https://lm.facebook.com/l.php", "facebook"],
    ["https://kleooai.com/pricing/", "site"], ["https://mcp.kleooai.com/mcp", "site"], ["https://linktr.ee/kleooai", "linktree"], ["https://example.org/x?secret=1", "other"]]) {
    const x = t("https://app.kleo.test/", { referer: ref });
    assert.equal(x.channel, ch, ref);
    assert.equal(x.guessed, false, ref);
  }
  assert.equal(t("https://app.kleo.test/", { referer: "https://example.org/x?secret=1" }).ref, "example.org", "the host only, never the address");
  // This host, and the sign-in and payment pages a person comes back from, are not where a visit came from.
  assert.equal(t("https://app.kleo.test/video", { referer: "https://app.kleo.test/" }).channel, "direct");
  assert.equal(t("https://app.kleo.test/", { referer: "https://accounts.google.com/" }).channel, "direct");
  assert.equal(t("https://app.kleo.test/", { referer: "https://checkout.stripe.com/c/pay" }).channel, "direct");
  // No tag, no referrer: the in-app browser's name, as a guess.
  for (const [ua, ch] of [[IG_UA, "instagram"], [TIKTOK_UA, "tiktok"], [TIKTOK_ANDROID, "tiktok"], [FB_UA, "facebook"]]) {
    const x = t("https://app.kleo.test/", { "user-agent": ua });
    assert.deepEqual([x.channel, x.guessed, x.app], [ch, true, ch], ua);
  }
  assert.deepEqual([t("https://app.kleo.test/", { "user-agent": SAFARI }).channel, t("https://app.kleo.test/", { "user-agent": SAFARI }).app], ["direct", null]);
  // A referrer beats the guess; tags beat the referrer.
  const igRef = t("https://app.kleo.test/", { "user-agent": IG_UA, referer: "https://l.instagram.com/" });
  assert.deepEqual([igRef.channel, igRef.guessed, igRef.app], ["instagram", false, "instagram"]);
  assert.equal(t("https://app.kleo.test/?utm_source=tiktok", { referer: "https://l.instagram.com/" }).channel, "tiktok");
  // The landing page never keeps its query (a reset link carries a token).
  assert.equal(t("https://app.kleo.test/reset?t=u_1.123.abc").landing, "/reset");
  // A page opened with a short link's tags but without the link (Instagram's browser to Safari) names the code.
  assert.equal(t("https://app.kleo.test/templates?utm_source=tiktok&utm_medium=social&utm_campaign=tt-lupin").link, "tt-lupin");
  assert.equal(t("https://app.kleo.test/?utm_source=tiktok&utm_medium=cpc&utm_campaign=tt-lupin").link, null);
});

test("robots and link previews are robots; people in in-app browsers are people", () => {
  for (const ua of ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Twitterbot/1.0", "WhatsApp/2.24.1 A", "curl/8.4.0", "python-requests/2.32", "Mozilla/5.0 (compatible; bingbot/2.0)", "", null, "Mozilla/5.0 (compatible; Bytespider)"]) assert.equal(mod.isBot(ua), true, String(ua));
  for (const ua of [SAFARI, IG_UA, TIKTOK_UA, TIKTOK_ANDROID, FB_UA]) assert.equal(mod.isBot(ua), false, ua);
});

test("the cookie: what goes in comes back, and whatever a browser makes up is checked again", () => {
  const url = "https://app.kleo.test/templates?utm_source=ig&utm_campaign=Lupin%20Paris";
  const t = mod.touchOf(new Request(url, { headers: { referer: "https://l.instagram.com/", "user-agent": IG_UA } }), new URL(url));
  const set = mod.touchCookie(t);
  assert.match(set, /^__Host-kleo_src=[A-Za-z0-9_-]+; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
  const back = mod.readTouch(new Request("https://app.kleo.test/", { headers: { cookie: `a=b; ${set.split(";")[0]}; c=d` } }));
  assert.deepEqual(back, t);
  const forged = (o) => mod.readTouch(new Request("https://app.kleo.test/", { headers: { cookie: `__Host-kleo_src=${Buffer.from(JSON.stringify(o)).toString("base64url")}` } }));
  assert.equal(forged({ c: "" }), null, "no channel, no touch");
  assert.equal(forged({ c: "<script>" }).channel, "other", "a channel Kleo does not know is just other");
  const odd = forged({ c: "x", r: "evil host/../", p: "nope", l: "Bad Code!", us: "<b>hi</b>", t: "soon" });
  assert.deepEqual([odd.channel, odd.ref, odd.landing, odd.link, odd.utmSource, odd.at], ["x", null, null, null, "bhib", 0]);
  assert.equal(mod.readTouch(new Request("https://app.kleo.test/", { headers: { cookie: "__Host-kleo_src=%%%" } })), null);
});

test("a first page load gets the cookie and is counted once; signed-in, private, robot and script requests never are", async () => {
  const env = newEnv();
  const first = await visit(env, "/?utm_source=tiktok&utm_campaign=lupin", { headers: { referer: "https://www.tiktok.com/" } });
  assert.equal(first.status, 200);
  const c = sourceCookie(first);
  assert.ok(c, "the first visit is tagged");
  assert.match(cookiesOf(first).join("\n"), /__Host-kleo_src=[^;]+; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax/);
  assert.deepEqual(rows(env, "SELECT day, channel, link_code, guessed, n FROM first_visits"), [{ day: today(), channel: "tiktok", link_code: "", guessed: 0, n: 1 }]);
  // The same browser again, with its cookie: first touch stays, nothing more is counted.
  const again = await visit(env, "/?utm_source=instagram", { headers: { cookie: c } });
  assert.equal(sourceCookie(again), null);
  assert.equal(one(env, "SELECT SUM(n) AS n FROM first_visits").n, 1);
  // None of these is a first visit.
  for (const [path, headers] of [["/", { cookie: "__Host-kleo_studio=u_x.1.sig" }], ["/", { "sec-gpc": "1" }], ["/", { dnt: "1" }],
    ["/", { "user-agent": "facebookexternalhit/1.1" }], ["/app.js", { "sec-fetch-dest": "script" }], ["/", { "sec-purpose": "prefetch" }]]) {
    assert.equal(sourceCookie(await visit(env, path, { headers })), null, JSON.stringify(headers));
  }
  // An Instagram in-app browser with no referrer: counted, as a guess.
  await visit(env, "/", { headers: { "user-agent": IG_UA } });
  assert.deepEqual(one(env, "SELECT channel, guessed, n FROM first_visits WHERE channel = 'instagram'"), { channel: "instagram", guessed: 1, n: 1 });
  // A fetch of the page's API is never a page load.
  assert.equal(sourceCookie((await call(env, "/api/config")).res), null);
});

test("short links: made in the console, counted per day, tagged, and opening their page with utm tags", async () => {
  const { env, owner } = await setup();
  const make = (b) => call(env, "/api/admin/sources/links", { method: "POST", cookie: owner.admin, body: b });
  const lupin = await make({ channel: "tiktok", label: "Lupin Paris Fire Dance", target: "/templates" });
  assert.equal(lupin.status, 200, lupin.text);
  assert.equal(lupin.json.link.code, "tt-lupin-paris-fire-dance");
  assert.equal(lupin.json.link.url, "https://app.kleooai.com/r/tt-lupin-paris-fire-dance");
  assert.equal((await make({ channel: "tiktok", label: "Lupin Paris Fire Dance" })).json.link.code, "tt-lupin-paris-fire-dance-2", "a code is never reused");
  assert.equal((await make({ channel: "instagram", label: "Michael Scott quinceañera" })).json.link.code, "ig-michael-scott-quinceaner");
  assert.equal((await make({ channel: "instagram", label: "Instagram bio", code: "ig-bio" })).json.link.code, "ig-bio");
  assert.equal((await make({ channel: "instagram", label: "Again", code: "ig-bio" })).json.code, "code_taken");
  assert.equal((await make({ channel: "facebook", label: "Nope" })).json.code, "channel");
  assert.equal((await make({ channel: "x", label: "" })).json.code, "label");
  assert.equal((await make({ channel: "x", label: "Bad code", code: "Hello World" })).json.code, "code");
  for (const target of ["https://evil.example/", "//evil.example/x", "/r/ig-bio", "/api/me", "/admin", "javascript:alert(1)", "/a\\b"]) {
    assert.equal((await make({ channel: "x", label: "Bad page", target })).json.code, "target", target);
  }
  assert.equal(mod.linkTargetProblem("/video?prompt=a%20cat&aspect=9:16"), null, "a deep link with its query is a page");
  assert.equal(mod.slugOf("Alan — Argentina célébration!"), "alan-argentina-celebrati");
  const audit = rows(env, "SELECT user_id, detail FROM audit WHERE event = 'admin.link_created'").map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  assert.equal(audit.length, 4);
  assert.deepEqual(audit[0], { user_id: owner.id, detail: { admin: owner.id, code: "tt-lupin-paris-fire-dance", channel: "tiktok", label: "Lupin Paris Fire Dance", target: "/templates" } });

  // A tap from TikTok.
  const tap = await visit(env, "/r/tt-lupin-paris-fire-dance", { headers: { referer: "https://www.tiktok.com/", "sec-fetch-dest": "document" } });
  assert.equal(tap.status, 302);
  assert.equal(tap.headers.get("location"), "/templates?utm_source=tiktok&utm_medium=social&utm_campaign=tt-lupin-paris-fire-dance");
  assert.equal(tap.headers.get("cache-control"), "no-store");
  const c = sourceCookie(tap);
  const t = mod.readTouch(new Request("https://app.kleo.test/", { headers: { cookie: c } }));
  assert.deepEqual([t.channel, t.link, t.ref, t.landing, t.utmMedium], ["tiktok", "tt-lupin-paris-fire-dance", "tiktok.com", "/templates", "social"]);
  assert.deepEqual(rows(env, "SELECT code, day, clicks FROM short_link_clicks"), [{ code: "tt-lupin-paris-fire-dance", day: today(), clicks: 1 }]);
  assert.deepEqual(rows(env, "SELECT channel, link_code, n FROM first_visits"), [{ channel: "tiktok", link_code: "tt-lupin-paris-fire-dance", n: 1 }]);
  // The page it lands on keeps the link's first touch.
  assert.equal(sourceCookie(await visit(env, "/templates?utm_source=tiktok&utm_medium=social&utm_campaign=tt-lupin-paris-fire-dance", { headers: { cookie: c } })), null);
  // A second tap is a click, not a first visit; robots, previews and HEAD are not clicks; the code's case doesn't matter.
  await visit(env, "/r/TT-Lupin-Paris-Fire-Dance", { headers: { cookie: c } });
  await visit(env, "/r/tt-lupin-paris-fire-dance", { headers: { "user-agent": "facebookexternalhit/1.1" } });
  await visit(env, "/r/tt-lupin-paris-fire-dance", { method: "HEAD" });
  await visit(env, "/r/tt-lupin-paris-fire-dance", { headers: { "sec-purpose": "prefetch" } });
  assert.equal(one(env, "SELECT clicks FROM short_link_clicks").clicks, 2);
  assert.equal(one(env, "SELECT SUM(n) AS n FROM first_visits").n, 1);
  // An unknown code opens the app; nothing is counted. The admin host has no short links.
  const lost = await visit(env, "/r/nothing-here");
  assert.deepEqual([lost.status, lost.headers.get("location")], [302, "/"]);
  assert.equal((await call(env, "/r/ig-bio", { host: "admin" })).status, 404);

  // Change and hide: a hidden link keeps working.
  const ch = await call(env, "/api/admin/sources/links/ig-bio", { method: "POST", cookie: owner.admin, body: { label: "Instagram bio @kleooai", target: "/templates", archived: true } });
  assert.equal(ch.status, 200, ch.text);
  assert.deepEqual([ch.json.link.label, ch.json.link.target, ch.json.link.archived], ["Instagram bio @kleooai", "/templates", true]);
  assert.equal((await visit(env, "/r/ig-bio")).headers.get("location"), "/templates?utm_source=instagram&utm_medium=social&utm_campaign=ig-bio");
  assert.equal(rows(env, "SELECT 1 FROM audit WHERE event = 'admin.link_changed'").length, 1);
  assert.equal((await call(env, "/api/admin/sources/links/nope", { method: "POST", cookie: owner.admin, body: { label: "x y" } })).status, 404);

  // Only the owner, on the admin host (the app host answers /api/admin with the site's 404: test/studio-admin.test.mjs).
  const ana = await signUp(env, "ana@example.com");
  assert.equal((await call(env, "/api/admin/sources", { cookie: ana.cookie })).status, 404);
  assert.equal((await call(env, "/api/admin/sources/links", { method: "POST", cookie: ana.cookie, body: { channel: "x", label: "Mine" } })).status, 404);
});

test("a new account keeps where it came from: the cookie becomes its row and is cleared; no cookie, a guess or 'untracked'", async () => {
  const { env, owner } = await setup();
  await call(env, "/api/admin/sources/links", { method: "POST", cookie: owner.admin, body: { channel: "tiktok", label: "TikTok bio", code: "tt-bio" } });
  const tap = await visit(env, "/r/tt-bio", { headers: { referer: "https://www.tiktok.com/", "user-agent": TIKTOK_UA } });
  const mia = await signUp(env, "mia@example.com", { cookie: sourceCookie(tap), headers: { "user-agent": TIKTOK_UA } });
  const row = one(env, "SELECT * FROM user_attribution WHERE user_id = ?", mia.id);
  assert.deepEqual([row.channel, row.guessed, row.link_code, row.utm_source, row.utm_medium, row.utm_campaign, row.ref_host, row.landing, row.in_app],
    ["tiktok", 0, "tt-bio", "tiktok", "social", "tt-bio", "tiktok.com", "/", "tiktok"]);
  assert.ok(Date.parse(row.first_seen_at) <= Date.now());
  assert.ok(cookiesOf(mia.res).some((x) => /^__Host-kleo_src=; Path=\/; Max-Age=0/.test(x)), "the cookie is cleared once the account exists");
  assert.ok(cookiesOf(mia.res)[0].startsWith("__Host-kleo_studio="), "the session cookie stays the first one");

  // No cookie: Instagram's browser is a guess; a private browser, or an ordinary one, is "untracked".
  const leo = await signUp(env, "leo@example.com", { headers: { "user-agent": IG_UA } });
  assert.deepEqual(one(env, "SELECT channel, guessed, in_app FROM user_attribution WHERE user_id = ?", leo.id), { channel: "instagram", guessed: 1, in_app: "instagram" });
  const pia = await signUp(env, "pia@example.com", { headers: { "user-agent": IG_UA, "sec-gpc": "1" } });
  assert.equal(one(env, "SELECT channel FROM user_attribution WHERE user_id = ?", pia.id).channel, "untracked");
  assert.equal(one(env, "SELECT channel FROM user_attribution WHERE user_id = ?", owner.id).channel, "untracked");
  assert.equal(cookiesOf(leo.res).some((x) => x.startsWith("__Host-kleo_src=")), false, "no cookie came, none is cleared");
  // A made-up link code is not kept.
  const fake = mod.touchCookie({ ...mod.readTouch(new Request("https://x/", { headers: { cookie: sourceCookie(tap) } })), link: "tt-nothing" }).split(";")[0];
  const zoe = await signUp(env, "zoe@example.com", { cookie: fake });
  assert.deepEqual(one(env, "SELECT channel, link_code FROM user_attribution WHERE user_id = ?", zoe.id), { channel: "tiktok", link_code: null });

  // Google: the cookie comes back with Google's redirect, and the account is tagged the same way.
  env.GOOGLE_CLIENT_ID = "gid"; env.GOOGLE_CLIENT_SECRET = "gs";
  const igTap = await visit(env, "/?utm_source=ig&utm_campaign=batman", { headers: { "user-agent": IG_UA, referer: "https://l.instagram.com/" } });
  const start = await worker.fetch(new Request("https://app.kleo.test/auth/google", { headers: { cookie: sourceCookie(igTap) } }), env, ctx);
  const to = new URL(start.headers.get("location"));
  const state = cookiesOf(start)[0].split(";")[0];
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  answer = (u) => (u.includes("oauth2.googleapis.com/token")
    ? new Response(JSON.stringify({ id_token: `${b64u({ alg: "RS256" })}.${b64u({ sub: "g-77", aud: "gid", nonce: to.searchParams.get("nonce"), email: "gia@gmail.com", email_verified: true })}.sig` }), { headers: { "content-type": "application/json" } })
    : new Response("?", { status: 404 }));
  try {
    const cb = await worker.fetch(new Request(`https://app.kleo.test/auth/google/callback?code=c1&state=${to.searchParams.get("state")}`, { headers: { cookie: `${state}; ${sourceCookie(igTap)}`, "user-agent": IG_UA } }), env, ctx);
    await Promise.allSettled(pending.splice(0));
    assert.equal(cb.status, 302);
    const gia = one(env, "SELECT user_id FROM studio_logins WHERE provider = 'google' AND subject = 'g-77'").user_id;
    assert.deepEqual(one(env, "SELECT channel, guessed, utm_campaign, ref_host, in_app FROM user_attribution WHERE user_id = ?", gia),
      { channel: "instagram", guessed: 0, utm_campaign: "batman", ref_host: "l.instagram.com", in_app: "instagram" });
    assert.ok(cookiesOf(cb).some((x) => /^__Host-kleo_src=; Path=\/; Max-Age=0/.test(x)));
  } finally { answer = null; }
});

test("the Sources page: a funnel per network and per link, accounts from before tracking, admins left out", async () => {
  const { env, owner } = await setup();
  await call(env, "/api/admin/sources/links", { method: "POST", cookie: owner.admin, body: { channel: "tiktok", label: "Lupin Paris Fire Dance", code: "tt-lupin", target: "/templates" } });
  const tap = await visit(env, "/r/tt-lupin", { headers: { referer: "https://www.tiktok.com/" } });
  await visit(env, "/r/tt-lupin", { headers: { cookie: sourceCookie(tap) } });
  const mia = await signUp(env, "mia@example.com", { cookie: sourceCookie(tap) });
  const leo = await signUp(env, "leo@example.com", { headers: { "user-agent": IG_UA } });
  await visit(env, "/", { headers: { "user-agent": IG_UA } });
  await visit(env, "/", { headers: { referer: "https://chatgpt.com/" } });
  env.DB.db.prepare("INSERT INTO studio_generations (id, user_id, model, settings, prompt, credits, status) VALUES ('g_m1', ?, 'seedance-2.0-fast', '{}', 'x', 2, 'done')").run(mia.id);
  env.DB.db.prepare("INSERT INTO studio_generations (id, user_id, model, settings, prompt, credits, status) VALUES ('g_l1', ?, 'seedance-2.0-fast', '{}', 'x', 2, 'failed')").run(leo.id);
  env.DB.db.prepare("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status) VALUES ('cs_1', ?, 100, 4000, 'eur', 'paid'), ('cs_2', ?, 10, 900, 'usd', 'paid'), ('cs_3', ?, 10, 500, 'eur', 'refunded')").run(mia.id, mia.id, mia.id);
  env.DB.db.prepare("INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, status) VALUES ('admin_owner', ?, 1000000, 0, 'eur', 'paid')").run(owner.id);
  // An account from before tracking began, and one opened outside the app afterwards (the MCP server's sign-in).
  const twoDaysAgo = new Date(Date.now() - 2 * 86400e3).toISOString();
  env.DB.db.prepare("UPDATE studio_meta SET value = ? WHERE key = 'attribution_since'").run(new Date(Date.now() - 86400e3).toISOString());
  env.DB.db.prepare("INSERT INTO users (id, email, credits, created_at) VALUES ('u_old', 'old@example.com', 0, ?), ('u_mcp', 'u_mcp@anon.kleo.invalid', 0, ?)").run(twoDaysAgo, new Date().toISOString());

  const r = await call(env, "/api/admin/sources?days=30", { cookie: owner.admin });
  assert.equal(r.status, 200, r.text);
  const ch = Object.fromEntries(r.json.channels.map((c) => [c.channel, c]));
  assert.deepEqual(ch.tiktok, { channel: "tiktok", visits: 1, clicks: 2, signups: 1, guessed: 0, made: 1, paying: 1, paid: { eur: 4000, usd: 900 } });
  assert.deepEqual([ch.instagram.visits, ch.instagram.signups, ch.instagram.guessed, ch.instagram.made, ch.instagram.paying], [1, 1, 1, 0, 0]);
  assert.deepEqual([ch.chatgpt.visits, ch.chatgpt.signups], [1, 0]);
  assert.equal(ch.before.signups, 1);
  assert.equal(ch.assistant.signups, 1);
  assert.equal(ch.untracked, undefined, "the owner's own account is left out");
  assert.deepEqual([r.json.total.signups, r.json.total.paying, r.json.total.paid], [4, 1, { eur: 4000, usd: 900 }]);
  const link = r.json.links.find((l) => l.code === "tt-lupin");
  assert.deepEqual([link.url, link.clicks, link.clicks_all, link.visits, link.signups, link.made, link.paying, link.paid], ["https://app.kleooai.com/r/tt-lupin", 2, 2, 1, 1, 1, 1, { eur: 4000, usd: 900 }]);
  const newest = Object.fromEntries(r.json.newest.map((u) => [u.id, u]));
  assert.deepEqual([newest[mia.id].channel, newest[mia.id].link_label, newest[mia.id].email], ["tiktok", "Lupin Paris Fire Dance", "mia@example.com"]);
  assert.equal(newest.u_old.channel, "before");
  assert.equal(newest[owner.id], undefined);
  // One day: the account from two days ago is out of the period.
  assert.equal((await call(env, "/api/admin/sources?days=1", { cookie: owner.admin })).json.channels.find((c) => c.channel === "before"), undefined);
  // The account page says where it came from.
  const d = await call(env, `/api/admin/users/${mia.id}`, { cookie: owner.admin });
  assert.deepEqual([d.json.attribution.channel, d.json.attribution.link_code, d.json.attribution.link_label], ["tiktok", "tt-lupin", "Lupin Paris Fire Dance"]);
  assert.equal((await call(env, "/api/admin/users/u_old", { cookie: owner.admin })).json.attribution, null);
  // A deleted account's row goes with its data; the account still counts, as "deleted".
  const del = await call(env, `/api/admin/users/${leo.id}/delete`, { method: "POST", cookie: owner.admin, body: { reason: "Asked by mail", confirm: "DELETE" } });
  assert.equal(del.status, 200, del.text);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM user_attribution WHERE user_id = ?", leo.id).n, 0);
  const after = Object.fromEntries((await call(env, "/api/admin/sources?days=30", { cookie: owner.admin })).json.channels.map((c) => [c.channel, c.signups]));
  assert.deepEqual([after.deleted, after.instagram], [1, 0]);
});

test("the Sources page follows the console's rules: drawn, no browser pop-ups, nothing under 13 px", () => {
  const js = readFileSync(join(ROOT, "studio-web", "admin.js"), "utf8");
  const css = readFileSync(join(ROOT, "studio-web", "admin.css"), "utf8");
  assert.match(js, /async function sourcesPage\(/);
  assert.match(js, /key: "sources", label: "Sources"/);
  assert.doesNotMatch(js, /\b(?:window\.)?(?:alert|confirm|prompt)\(/);
  for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]) >= 13, `font-size ${m[1]}px`);
  // The migration and the code create the same tables.
  const sql = readFileSync(join(ROOT, "migrations", "0028_attribution.sql"), "utf8");
  for (const t of ["user_attribution", "short_links", "short_link_clicks", "first_visits", "studio_meta"]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} `));
});
