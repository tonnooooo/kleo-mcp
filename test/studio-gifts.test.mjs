/**
 * A gift from the Kleo team (src/studio/gifts.ts, the admin console's "Gift credits", studio-web/app.js giftModal) inside
 * one process: the kleo-studio Worker bundled with esbuild, on a D1 look-alike (node:sqlite, every migration applied).
 * Covers the console's action (the credits at once through the same audited path as Add credits, its
 * CREDITS_WITHOUT_CODE rule and fresh code, the gift's id made once per sheet so a repeat gives nothing, the gift's row
 * only with its credits), the accounts a gift refuses (closed, merged, deleted, used only by an AI assistant), the
 * e-mail (through the welcome e-mails' sending, to the address the console's sheet shows, the Kleo Creators line only
 * for accounts that paid and are not in the program, the stop list, a temporary refusal that waits for "Send the e-mail
 * again", which goes out at most once, a refused address), the app's side (/api/me carries each gift until the page
 * says it was seen: once, for its own account only, junk ignored), the deletion of an account (the gift keeps its
 * credits, not its address or words), the console's account page and previews, and the owner's rules for the pages.
 * Run: node --test test/studio-gifts.test.mjs
 */
import { register } from "node:module";
// Workers' "cloudflare:email" does not exist in Node: a stand-in that keeps what it was given.
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "cloudflare:email") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export class EmailMessage { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } }") };
  return next(s, c);
}`));
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { base32Decode, hotp, stepAt } from "../src/studio/totp.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * D1's meta.changes is total_changes() after the statement minus before (miniflare's D1, database.worker.js), so the rows
 * a trigger changes count too (users_program_credits_spent); node:sqlite's own `changes` (sqlite3_changes) leaves them out.
 */
const d1Changes = (db) => Number(db.prepare("SELECT total_changes() AS n").get().n);
class Stmt {
  constructor(db, sql) { this.db = db; this.stmt = db.prepare(sql); this.sql = sql; this.args = []; }
  bind(...a) { this.args = a.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)); return this; }
  async run() { const n = d1Changes(this.db); this.stmt.run(...this.args); return { success: true, meta: { changes: d1Changes(this.db) - n } }; }
  async first() { return this.stmt.get(...this.args) ?? null; }
  async all() { return { results: this.stmt.all(...this.args) }; }
}
class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://cloudflare-dns.com/dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }), { headers: { "content-type": "application/dns-json" } });
    return real(url, init);
  };
}
globalThis.FixedLengthStream ??= class extends TransformStream { constructor() { super(); } };

let worker, mod;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts";
      export { composeGift, giftMessage, sampleGift, GIFT_MESSAGE_MAX } from "./src/studio/gifts.ts";
      export { adminCookieValue, readAdminCookie } from "./src/studio/admin-auth.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email"],
  });
  mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
  worker = mod.default;
});

const CERT_FP = "3f".repeat(32);
const GOOD_TLS = { certPresented: "1", certVerified: "SUCCESS", certRevoked: "0", certFingerprintSHA256: CERT_FP, certIssuerDN: "CN=Cloudflare" };
function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: { put: async () => ({}), get: async () => null, delete: async () => {}, list: async () => ({ objects: [] }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", FREE_CREDITS: "5", MAX_NEW_USERS_PER_IP_DAY: "50", MAX_ACCOUNTS_PER_ADDRESS: "50",
    ADMIN_HOST: "admin.kleo.test", ADMIN_CERT_SHA256: CERT_FP, mails: [], OWNER_MAIL: { send: async (m) => { env.mails.push(m); } },
    // Cloudflare Email Sending (onboarding.ts deliver): every message is kept here; `refuse` makes it say no with that text.
    sent: [], refuse: null,
    EMAIL: { send: async (m) => { if (env.refuse) throw new Error(env.refuse); env.sent.push(m); return { messageId: `m${env.sent.length}` }; } },
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const pending = [];
// Work handed to waitUntil is counted: the gift's e-mail must run there, so a closed console tab cannot cut it off.
const ctx = { waited: 0, waitUntil(p) { ctx.waited++; pending.push(p); }, passThroughOnException() {} };
const BERLIN = { ip: "95.33.163.20", cf: { country: "DE", city: "Berlin" } };
const ROME = { ip: "151.20.1.9", cf: { country: "IT", city: "Rome" } };
const NZ = { ip: "203.0.113.9", cf: { country: "NZ", city: "Auckland" } };
async function call(env, path, { method = "GET", body, cookie, from, headers = {} } = {}) {
  const admin = /^\/(?:api\/)?admin(?:\/|$)/.test(path);
  const h = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)", "x-kleo": "1", ...headers };
  if (cookie) h.cookie = cookie;
  if (from?.ip) h["cf-connecting-ip"] = from.ip;
  if (body !== undefined) h["content-type"] = "application/json";
  const req = new Request(`https://${admin ? "admin" : "app"}.kleo.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const cf = admin ? { ...(from?.cf ?? {}), tlsClientAuth: GOOD_TLS } : from?.cf;
  if (cf) Object.defineProperty(req, "cf", { value: cf });
  const res = await worker.fetch(req, env, ctx);
  await Promise.allSettled(pending.splice(0));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, res };
}
const cookieOf = (r) => (r.res.headers.get("set-cookie") ?? "").split(";")[0];
async function account(env, email, from = BERLIN) {
  const r = await call(env, "/api/auth/signup", { method: "POST", body: { email, password: "long enough pw" }, from });
  assert.equal(r.status, 200, r.text);
  const cookie = cookieOf(r);
  const me = await call(env, "/api/me", { cookie });
  return { cookie, id: me.json.id };
}
const codeAt = (secret, offset = 0) => hotp(secret, stepAt(Date.now()) + offset);
/** The owner (an admin, the console open with a code just typed) and two customers, Kal and Bo, with 5 credits each. */
async function setup() {
  const env = newEnv();
  const owner = await account(env, "owner@example.com", NZ);
  env.STUDIO_ADMINS = owner.id;
  const e = await call(env, "/api/admin/auth/enroll", { method: "POST", cookie: owner.cookie, body: { password: "long enough pw" }, from: NZ });
  assert.equal(e.status, 200, e.text);
  owner.secret = base32Decode(e.json.secret);
  const c = await call(env, "/api/admin/auth/enroll/confirm", { method: "POST", cookie: owner.cookie, body: { code: await codeAt(owner.secret, -1) }, from: NZ });
  assert.equal(c.status, 200, c.text);
  owner.adminCookie = cookieOf(c);
  owner.admin = `${owner.cookie}; ${owner.adminCookie}`;
  const kal = await account(env, "kal@example.com", BERLIN);
  const bo = await account(env, "bo@example.com", ROME);
  return { env, owner, kal, bo };
}
const run = (env, sql, ...a) => env.DB.db.prepare(sql).run(...a);
const get = (env, sql, ...a) => env.DB.db.prepare(sql).get(...a);
const auditOf = (env, id, event) => env.DB.db.prepare("SELECT detail FROM audit WHERE user_id = ? AND event = ? ORDER BY id DESC").all(id, event).map((r) => JSON.parse(r.detail));
const gift = (env, cookie, id, body) => call(env, `/api/admin/users/${id}/gift`, { method: "POST", cookie, body });
const mailAgain = (env, cookie, id, giftId) => call(env, `/api/admin/users/${id}/gifts/${giftId}/mail`, { method: "POST", cookie, body: {} });
/** A paid payment on the account (what Kleo Creators asks for), with the address Stripe gave, if any. */
let paySeq = 0;
const pay = (env, id, email = null) => run(env, "INSERT INTO payments (session_id, user_id, credits, amount_cent, currency, email, status, at) VALUES (?, ?, 10, 500, 'eur', ?, 'paid', ?)",
  `cs_test_gift${++paySeq}`, id, email, new Date(Date.now() - 86_400_000).toISOString());
/** A gift id in the console's shape (studio-web/admin.js giftId). */
let idSeq = 0;
const giftIdOf = () => `gf_testgift${String(++idSeq).padStart(4, "0")}`;
const credits = (env, id) => get(env, "SELECT credits FROM users WHERE id = ?", id).credits;
const count = (env, sql, ...a) => get(env, sql, ...a).n;

test("Gift credits: the credits go in at once through the audited path, the gift waits for the app, the e-mail goes out", async () => {
  const { env, owner, kal } = await setup();
  pay(env, kal.id);
  const id = giftIdOf();
  const r = await gift(env, owner.admin, kal.id, { id, credits: 20, reason: "Thank you, our best customer", email: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.credits, 25, "5 from the sign-up, 20 from the team");
  assert.equal(r.json.gift.id, id, "the console's own id is the gift's");
  const g = get(env, "SELECT * FROM studio_gifts WHERE user_id = ?", kal.id);
  assert.deepEqual([g.id, g.credits, g.reason, g.message, g.by_admin, g.seen_at, g.mail, g.mail_status, g.mail_to, g.mail_error],
    [id, 20, "Thank you, our best customer", null, owner.id, null, 1, "sent", "kal@example.com", null]);
  // The same audit row as Add credits, with the gift's id: it counts toward CREDITS_WITHOUT_CODE like any other change.
  assert.deepEqual(auditOf(env, kal.id, "admin.credits"), [{ admin: owner.id, reason: "Thank you, our best customer", delta: 20, before: 5, gift: id, after: 25 }]);
  assert.deepEqual(auditOf(env, kal.id, "admin.gift"), [{ admin: owner.id, reason: "Thank you, our best customer", gift: id, credits: 20, message: false, mail: "sent" }]);
  // The e-mail, through the welcome e-mails' sending: from hello@kleooai.com, with the stop link.
  assert.equal(env.sent.length, 1);
  const m = env.sent[0];
  assert.equal(m.to, "kal@example.com");
  assert.deepEqual(m.from, { email: "hello@kleooai.com", name: "Leonardo from Kleo" });
  assert.equal(m.subject, "The Kleo team sent you 20 free credits");
  assert.match(m.text, /A little gift from all of us at Kleo: 20 free credits\. They're already in your account, so you have 25 credits now\./);
  assert.match(m.text, /Thanks for creating with Kleo, enjoy them!/);
  assert.match(m.text, /Kleo Creators, with 25% of every sale from your link for 12 months/, "an account that paid is invited");
  assert.match(m.text, /https:\/\/app\.kleooai\.com\/creators\?utm_source=email&utm_medium=gift/);
  assert.match(m.html, /href="https:\/\/app\.kleooai\.com\/creators\?utm_source=email[^"]*"[^>]*>app\.kleooai\.com\/creators<\/a>/);
  assert.ok(m.text.indexOf("20 free credits") < m.text.indexOf("Kleo Creators"), "the gift first, then the invitation");
  assert.match(m.headers["List-Unsubscribe"], /\/email\/stop\?u=/);
  assert.equal(m.headers["X-Kleo-Mail"], "gift");
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM studio_mail_log WHERE user_id = ? AND mail = 'gift' AND kind = 'gift' AND ok = 1", kal.id), 1);
  // The sheet shows the address the e-mail just used.
  assert.equal((await call(env, `/api/admin/users/${kal.id}`, { cookie: owner.admin })).json.giftTo, "kal@example.com");
});

test("the same gift id twice (a second click, a try after a lost answer) gives nothing more: no credits, no audit row, no e-mail", async () => {
  const { env, owner, kal, bo } = await setup();
  const id = giftIdOf();
  const body = { id, credits: 20, reason: "Thank you", message: "For your 40 videos", email: true };
  const first = await gift(env, owner.admin, kal.id, body);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.credits, 25);
  const again = await gift(env, owner.admin, kal.id, { ...body, message: "Typo fixed meanwhile" });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.again, true);
  assert.equal(again.json.credits, 25, "the balance is the same");
  assert.deepEqual(again.json.gift, { id, credits: 20, message: "For your 40 videos", mail: { status: "sent", to: "kal@example.com", error: null } }, "the first gift, as it is");
  assert.equal(credits(env, kal.id), 25);
  assert.equal(env.sent.length, 1, "one e-mail");
  assert.equal(auditOf(env, kal.id, "admin.credits").length, 1, "one audit row of the change");
  assert.equal(auditOf(env, kal.id, "admin.gift").length, 1);
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM studio_gifts"), 1);
  // Another account can't take that id, and a malformed one is refused before anything moves.
  assert.equal((await gift(env, owner.admin, bo.id, body)).json.code, "gift_id");
  assert.equal((await gift(env, owner.admin, bo.id, { ...body, id: "gift-1" })).json.code, "gift_id");
  assert.equal(credits(env, bo.id), 5);
  // A try the code rule refused leaves nothing, so the same id goes through once the code is typed, then never again.
  const s = await mod.readAdminCookie("s3cret", owner.adminCookie.split("=")[1]);
  const stale = `${owner.cookie}; __Host-kleo_admin=${await mod.adminCookieValue("s3cret", { ...s, fresh: s.fresh - 6 * 60 })}`;
  const big = { id: giftIdOf(), credits: 150, reason: "A big thank you", email: false };
  assert.equal((await gift(env, stale, bo.id, big)).json.code, "fresh_code");
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM studio_gifts WHERE id = ?", big.id), 0);
  const ok = await gift(env, stale, bo.id, { ...big, code: await codeAt(owner.secret, 0) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.credits, 155);
  assert.equal((await gift(env, `${owner.cookie}; ${cookieOf(ok)}`, bo.id, big)).json.again, true);
  assert.equal(credits(env, bo.id), 155);
});

test("the app gets each gift until it says it was seen: once, for its own account only; junk and other accounts change nothing", async () => {
  const { env, owner, kal, bo } = await setup();
  const r = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 20, reason: "Best customer", message: "  You made 40 videos\n   this month!  ", email: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.gift.mail, null, "no e-mail unless asked");
  assert.equal(env.sent.length, 0);
  assert.equal(get(env, "SELECT mail FROM studio_gifts WHERE id = ?", r.json.gift.id).mail, 0);
  const id = r.json.gift.id;
  let me = await call(env, "/api/me", { cookie: kal.cookie });
  assert.deepEqual(me.json.gift, { items: [{ id, credits: 20, message: "You made 40 videos this month!" }], credits: 20 });
  assert.equal(me.json.creator, null);
  assert.equal(me.json.paid, false, "never paid: the app leaves the Creators card out");
  assert.deepEqual((await call(env, "/api/me", { cookie: bo.cookie })).json.gift, { items: [], credits: 0 }, "no gifts is an answer, not an error");
  // While the gift is still unseen: junk, a body without `ids`, and another account's try leave it unseen.
  const seen = (cookie, b) => call(env, "/api/me/gift/seen", { method: "POST", cookie, body: b });
  assert.equal((await seen(kal.cookie, { ids: ["nope", 3, null, "gf_x' OR 1=1", "gf_notthere1234"] })).json.seen, 0);
  assert.equal((await seen(kal.cookie, { gifts: [id] })).json.seen, 0, "only `ids` counts");
  assert.equal((await seen(bo.cookie, { ids: [id] })).json.seen, 0);
  assert.equal(get(env, "SELECT seen_at FROM studio_gifts WHERE id = ?", id).seen_at, null);
  assert.equal(auditOf(env, kal.id, "gift.seen").length, 0);
  // A second gift before the first was seen: both listed, each with its own credits, so the app announces only the new one.
  const r2 = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 5, reason: "Sorry about the failed clips", email: false });
  me = await call(env, "/api/me", { cookie: kal.cookie });
  assert.deepEqual(me.json.gift, { items: [{ id, credits: 20, message: "You made 40 videos this month!" }, { id: r2.json.gift.id, credits: 5, message: null }], credits: 25 });
  // The app shows the first and says so; then a focus says it again with the second: only what was still unseen changes.
  assert.equal((await seen(kal.cookie, { ids: [id] })).json.seen, 1);
  assert.equal((await seen(kal.cookie, { ids: [id, r2.json.gift.id] })).json.seen, 1);
  assert.deepEqual((await call(env, "/api/me", { cookie: kal.cookie })).json.gift, { items: [], credits: 0 }, "never again, here or on another device");
  assert.equal((await seen(kal.cookie, { ids: [id, r2.json.gift.id] })).json.seen, 0);
  assert.equal((await call(env, "/api/me/gift/seen", { method: "POST", body: { ids: [id] } })).status, 401, "signed in only");
  assert.equal(auditOf(env, kal.id, "gift.seen").length, 2);
  // The console's account page lists both, newest first, seen.
  const d = await call(env, `/api/admin/users/${kal.id}`, { cookie: owner.admin });
  assert.equal(d.status, 200, d.text);
  assert.deepEqual(d.json.gifts.map((x) => [x.credits, x.reason, !!x.seen_at]), [[5, "Sorry about the failed clips", true], [20, "Best customer", true]]);
});

test("gifts keep Add credits' rule: small ones add up with every credit change, past 100 the next wants a code, a big one wants it at once", async () => {
  const { env, owner, kal } = await setup();
  const s = await mod.readAdminCookie("s3cret", owner.adminCookie.split("=")[1]);
  const stale = `${owner.cookie}; __Host-kleo_admin=${await mod.adminCookieValue("s3cret", { ...s, fresh: s.fresh - 6 * 60 })}`;
  assert.equal((await call(env, `/api/admin/users/${kal.id}/credits`, { method: "POST", cookie: stale, body: { delta: 60, reason: "a grant in pieces" } })).json.credits, 65);
  const small = await gift(env, stale, kal.id, { credits: 40, reason: "the rest as a gift", email: false });
  assert.equal(small.status, 200, small.text);
  assert.equal(small.json.credits, 105, "60 + 40: still within the 100 a code is not needed for");
  assert.equal((await gift(env, stale, kal.id, { credits: 1, reason: "one more", email: true })).json.code, "fresh_code", "the 101st credit wants a code, gift or not");
  assert.equal((await gift(env, stale, kal.id, { credits: 500, reason: "a big thank you", email: true })).json.code, "fresh_code", "over 100 at once wants one too");
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM studio_gifts"), 1, "a refused gift leaves no row");
  assert.equal(credits(env, kal.id), 105, "and moves nothing");
  assert.equal(env.sent.length, 0, "and sends nothing");
  assert.equal((await gift(env, stale, kal.id, { credits: 500, reason: "a big thank you", email: false, code: "000000" })).json.code, "admin_wrong");
  const ok = await gift(env, stale, kal.id, { credits: 500, reason: "a big thank you", email: false, code: await codeAt(owner.secret, 0) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.credits, 605);
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM studio_gifts WHERE user_id = ?", kal.id), 2);
  assert.deepEqual(auditOf(env, kal.id, "admin.credits").map((a) => [a.delta, a.after, !!a.gift]), [[500, 605, true], [40, 105, true], [60, 65, false]]);
});

test("the Creators line only for accounts that paid and are not in the program; the stop list; a temporary refusal waits, a refused address fails", async () => {
  const { env, owner, kal, bo } = await setup();
  // Never paid: no invitation, in the e-mail or (S.me.paid false) in the app.
  let r = await gift(env, owner.admin, bo.id, { id: giftIdOf(), credits: 5, reason: "Sorry about the failed clips", email: true });
  assert.equal(r.json.gift.mail.status, "sent");
  assert.doesNotMatch(env.sent.at(-1).text, /Kleo Creators|\/creators/);
  // Paid, and already in the program: no invitation either.
  pay(env, kal.id);
  run(env, `INSERT INTO creators (user_id, status, platform, handle, handle_key, profile_url, bio_code, terms_version, terms_at)
    VALUES (?, 'active', 'instagram', 'kal', 'kal', 'https://www.instagram.com/kal/', 'KLEO-ABC123', '2026-10-28', '2026-10-28T00:00:00.000Z')`, kal.id);
  r = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 1, reason: "a thank you", email: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(env.sent.at(-1).subject, "The Kleo team sent you 1 free credit");
  assert.match(env.sent.at(-1).text, /It's already in your account, so you have 6 credits now\./);
  assert.doesNotMatch(env.sent.at(-1).text, /Kleo Creators|\/creators/);
  assert.equal((await call(env, "/api/me", { cookie: kal.cookie })).json.creator.status, "active", "the app reads the same row and skips the card");
  // Bo pays: now he is invited.
  pay(env, bo.id);
  r = await gift(env, owner.admin, bo.id, { id: giftIdOf(), credits: 5, reason: "Thanks for buying", email: true });
  assert.match(env.sent.at(-1).text, /you're invited to Kleo Creators/);
  assert.equal((await call(env, "/api/me", { cookie: bo.cookie })).json.paid, true, "and the app shows him the card");
  const sentSoFar = env.sent.length;
  // An address that unsubscribed: no e-mail, the gift and its pop-up all the same.
  run(env, "INSERT INTO mail_suppress (email, reason, source) VALUES ('bo@example.com', 'unsubscribe', 'onboarding')");
  r = await gift(env, owner.admin, bo.id, { id: giftIdOf(), credits: 10, reason: "a thank you", email: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.gift.mail, { status: "skipped", to: "bo@example.com", error: "This address unsubscribed from Kleo's e-mails." });
  assert.equal(env.sent.length, sentSoFar, "nothing more went out");
  assert.equal((await mailAgain(env, owner.admin, bo.id, r.json.gift.id)).json.code, "gift_mail_state", "a skipped e-mail is not sent again");
  run(env, "DELETE FROM mail_suppress");
  // Email Sending says "later" (a rate limit): the gift stays, its e-mail waits for "Send the e-mail again".
  env.refuse = "Rate limit exceeded, try later";
  r = await gift(env, owner.admin, bo.id, { id: giftIdOf(), credits: 2, reason: "again", email: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.gift.mail.status, "waiting");
  assert.match(r.json.gift.mail.error, /Rate limit exceeded/);
  const waiting = r.json.gift.id;
  assert.equal(get(env, "SELECT mail_status FROM studio_gifts WHERE id = ?", waiting).mail_status, "waiting");
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM studio_mail_log WHERE mail = 'gift' AND ok = 0"), 1);
  assert.equal(auditOf(env, bo.id, "admin.gift")[0].mail, "waiting");
  const bal = credits(env, bo.id);
  env.refuse = null;
  const again = await mailAgain(env, owner.admin, bo.id, waiting);
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.json.mail, { status: "sent", to: "bo@example.com", error: null });
  assert.equal(env.sent.at(-1).to, "bo@example.com");
  assert.equal(credits(env, bo.id), bal, "sending again moves no credits");
  const twice = await mailAgain(env, owner.admin, bo.id, waiting);
  assert.equal(twice.status, 409, "at most once");
  assert.equal(twice.json.code, "gift_mail_state");
  assert.equal(auditOf(env, bo.id, "admin.gift_mail")[0].mail, "sent");
  assert.equal((await mailAgain(env, owner.admin, kal.id, waiting)).status, 404, "only on its own account");
  // The address itself is refused: that is final.
  env.refuse = "Invalid recipient address";
  r = await gift(env, owner.admin, bo.id, { id: giftIdOf(), credits: 1, reason: "once more", email: true });
  assert.equal(r.json.gift.mail.status, "failed");
  assert.equal((await mailAgain(env, owner.admin, bo.id, r.json.gift.id)).status, 409);
});

test("no gift for an account only an AI assistant uses; the sheet's address is the e-mail's, payments included", async () => {
  const { env, owner, kal, bo } = await setup();
  // Bo becomes an assistant-only account: no Kleo sign-in, a synthetic address.
  run(env, "UPDATE users SET email = id || '@anon.kleo.invalid' WHERE id = ?", bo.id);
  run(env, "DELETE FROM studio_logins WHERE user_id = ?", bo.id);
  const refused = await gift(env, owner.admin, bo.id, { id: giftIdOf(), credits: 20, reason: "a thank you", email: true });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, "gift_anonymous");
  assert.match(refused.json.error, /Use Add credits instead/);
  assert.equal(credits(env, bo.id), 5);
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM studio_gifts"), 0);
  assert.equal((await call(env, `/api/admin/users/${bo.id}`, { cookie: owner.admin })).json.user.anonymous, 1, "the console hides Gift credits for it");
  assert.equal((await call(env, `/api/admin/users/${bo.id}/credits`, { method: "POST", cookie: owner.admin, body: { delta: 20, reason: "Add credits still works" } })).json.credits, 25);
  // Kal keeps his sign-in but its address goes, and his own is synthetic: the address left is his payment's.
  run(env, "UPDATE users SET email = id || '@anon.kleo.invalid' WHERE id = ?", kal.id);
  run(env, "UPDATE studio_logins SET email = NULL WHERE user_id = ?", kal.id);
  assert.equal((await call(env, `/api/admin/users/${kal.id}`, { cookie: owner.admin })).json.giftTo, null, "no address on record: the switch is off");
  let r = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 3, reason: "a thank you", email: true });
  assert.deepEqual(r.json.gift.mail, { status: "skipped", to: null, error: "This account has no e-mail address on record." });
  pay(env, kal.id, "payer@example.com");
  assert.equal((await call(env, `/api/admin/users/${kal.id}`, { cookie: owner.admin })).json.giftTo, "payer@example.com");
  r = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 3, reason: "a thank you", email: true });
  assert.equal(r.json.gift.mail.status, "sent");
  assert.equal(env.sent.at(-1).to, "payer@example.com", "the e-mail goes where the sheet said");
});

test("deleting the account clears the gift's address and words; its credits and audit rows stay", async () => {
  const { env, owner, kal } = await setup();
  const r = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 20, reason: "Thank you", message: "Thanks Kal Smith for your 40 videos", email: true });
  assert.equal(r.json.gift.mail.status, "sent");
  const del = await call(env, "/api/me/delete", { method: "POST", cookie: kal.cookie, body: { confirm: "DELETE" } });
  assert.equal(del.status, 200, del.text);
  const g = get(env, "SELECT * FROM studio_gifts WHERE id = ?", r.json.gift.id);
  assert.deepEqual([g.mail_to, g.message, g.mail_error], [null, null, null]);
  assert.equal(g.credits, 20);
  assert.equal(auditOf(env, kal.id, "admin.credits").length, 1);
  const page = await call(env, `/api/admin/users/${kal.id}`, { cookie: owner.admin });
  assert.doesNotMatch(JSON.stringify(page.json.gifts), /kal@example\.com|Kal Smith/);
  assert.equal((await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 5, reason: "a thank you" })).json.code, "gift_closed", "and no new gift");
});

test("a gift wants a reason, a whole number, a short message and an open account; only an admin sends one", async () => {
  const { env, owner, kal, bo } = await setup();
  const path = `/api/admin/users/${kal.id}/gift`;
  assert.equal((await call(env, path, { method: "POST", cookie: owner.admin, body: { credits: 20 } })).json.code, "reason");
  for (const n of [0, -5, "abc", null]) {
    assert.equal((await call(env, path, { method: "POST", cookie: owner.admin, body: { credits: n, reason: "a thank you" } })).json.code, "credits", String(n));
  }
  const long = await call(env, path, { method: "POST", cookie: owner.admin, body: { credits: 5, reason: "a thank you", message: "x".repeat(mod.GIFT_MESSAGE_MAX + 1) } });
  assert.equal(long.json.code, "gift_message");
  assert.equal((await call(env, path, { method: "POST", cookie: kal.cookie, body: { credits: 5, reason: "free money" } })).status, 404, "a customer finds nothing there");
  run(env, "UPDATE users SET blocked_at = '2026-10-30T00:00:00.000Z' WHERE id = ?", bo.id);
  assert.equal((await gift(env, owner.admin, bo.id, { credits: 5, reason: "a thank you" })).json.code, "gift_closed");
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM studio_gifts"), 0);
  assert.equal(credits(env, kal.id), 5);
  assert.equal(mod.giftMessage("   "), null);
  assert.equal(mod.giftMessage("Two\nlines\tand  spaces"), "Two lines and spaces");
});

test("the e-mail's words: the amount and its plural, the message, the invitation when asked, no em dash; previewed and sent to the owner", async () => {
  const many = mod.composeGift({ name: "Kalahyn", credits: 20, balance: 124, message: "We love your videos.", invite: true });
  const one = mod.composeGift({ name: null, credits: 1, balance: 1, message: null, invite: false });
  const words = (m) => JSON.stringify(m);
  assert.equal(many.subject, "The Kleo team sent you 20 free credits");
  assert.equal(one.subject, "The Kleo team sent you 1 free credit");
  assert.match(words(many), /Hi Kalahyn,/);
  assert.match(words(many), /We love your videos\./);
  assert.match(words(many), /you have 124 credits now/);
  assert.match(words(many), /Leonardo and the Kleo team/);
  assert.match(words(many), /Kleo Creators/);
  assert.match(words(one), /Hi there,/);
  assert.match(words(one), /you have 1 credit now/);
  assert.match(words(one), /enjoy it!/);
  assert.doesNotMatch(words(one), /Kleo Creators/);
  for (const m of [many, one, mod.composeGift(mod.sampleGift())]) assert.doesNotMatch(words(m), /[—–]/, "no em or en dash");
  const { env, owner } = await setup();
  const list = await call(env, "/api/admin/emails", { cookie: owner.admin });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.mails.find((x) => x.key === "gift"), { key: "gift", name: "Gift · from the Kleo team", subject: "The Kleo team sent you 20 free credits" });
  const p = await call(env, "/api/admin/emails/preview?key=gift", { cookie: owner.admin });
  assert.equal(p.status, 200, p.text);
  assert.match(p.json.html, /<!doctype html>/);
  assert.match(p.json.text, /Kleo Creators/);
});

test("the pages keep the owner's rules and the review's: his words, the card waits and keeps the keyboard only on top, no browser pop-ups, 16 px and up", () => {
  const app = readFileSync(join(ROOT, "studio-web", "app.js"), "utf8");
  const css = readFileSync(join(ROOT, "studio-web", "app.css"), "utf8");
  const admin = readFileSync(join(ROOT, "studio-web", "admin.js"), "utf8");
  const part = app.slice(app.indexOf("// ── A gift from the Kleo team"), app.indexOf("// ── Create: the chat with Kleo"));
  assert.ok(part.length > 4000, "the gift's part of app.js is there, before the chat");
  for (const words of ["\"A gift from the Kleo team\"", "already in your account. Thanks for creating with Kleo, enjoy", "ok: \"Claim\"", "\"aria-label\": \"Close\"",
    "\"Become a Kleo Creator\"", "25% of every sale from your link, for 12 months", "Bonus credits for your views", "Extra credits in the months you post",
    "ok: \"Apply\"", "go(\"/creators\")"]) assert.ok(part.includes(words), words);
  // Seen: the shown ids, in the body the server reads, with keepalive and a retry; until the server answers they stay in
  // this browser, and the next load reports them without showing the card again (F).
  assert.match(part, /fetch\("\/api\/me\/gift\/seen", \{ method: "POST", keepalive: true,/);
  assert.match(part, /body: JSON\.stringify\(\{ ids \}\)/);
  assert.match(part, /for \(let i = 0; i < 2; i\+\+\)/);
  assert.match(part, /keepShown\(ids\);/);
  assert.match(part, /if \(res\.ok\) \{ dropShown\(ids\); return; \}/);
  assert.match(part, /const items = giftItems\(S\.me\.gift\);\s*seedShown\(items, giftAnswered\(S\.me\)\);/, "a reload first takes the kept ids as shown");
  assert.match(part, /store\.get\(GIFT_KEEP, \{\}\)/, "kept through the app's storage helper (try/catch)");
  assert.match(part, /filter\(\(x\) => GIFTS_SHOWN\.has\(x\.id\)\)[^\n]*\n\s*if \(again\.length\) giftsSeen\(again\);/);
  assert.match(part, /const fresh = items\.filter\(\(x\) => !GIFTS_SHOWN\.has\(x\.id\)\);/, "it announces only what this page has not shown");
  // The Creators card: paid accounts outside the program only.
  assert.match(part, /if \(!S\.me \|\| !S\.me\.paid \|\| S\.me\.creator/);
  // It waits for the viewer, sheets, menus, questions and typing, and reads /api/me again when it had to wait.
  assert.match(part, /const giftWaits = \(\) => document\.visibilityState === "hidden" \|\| !!openLayer \|\| !!document\.querySelector\("\.ask-scrim, \.gp-scrim"\) \|\| videoPlaysAloud\(\)/);
  assert.match(part, /const videoPlaysAloud = \(\) => \[\.\.\.document\.querySelectorAll\("video"\)\]\.some\(\(v\) => !v\.paused && !v\.ended && !v\.muted/, "any video with sound (D)");
  assert.match(part, /if \(waited && !DEMO\) \{[\s\S]{0,200}await api\("\/api\/me"\)/);
  // The keyboard: only on top, the card itself focused, the focus given back.
  // E: over sheets, menus and the viewer the card keeps Esc, Tab, Enter and Space; only a question above it takes them.
  assert.match(part, /const onTop = \(\) => !document\.querySelector\("\.ask-scrim"\);/);
  assert.doesNotMatch(part.slice(part.indexOf("const onTop")).split("\n")[0], /openLayer/, "a sheet under the card doesn't take its keys");
  assert.match(part, /\(e\.key === "Enter" \|\| e\.key === " "\) && !card\.contains\(document\.activeElement\)/);
  assert.match(part, /e\.stopImmediatePropagation\(\)/);
  assert.match(part, /tabindex: "-1"/);
  assert.match(part, /card\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(part, /yes\.focus\(/, "never a button that a keystroke could press");
  assert.match(part, /focusBack\(back\)/);
  assert.match(app, /await route\(\);\s*\/\/[^\n]*\n\s*maybeShowGift\(\);/, "enter() shows it, after the page it opens");
  for (const js of [part, admin]) assert.doesNotMatch(js, /\b(?:window\.)?(?:alert|confirm|prompt)\(/, "no browser pop-ups");
  assert.doesNotMatch(part, /[—–]/, "no em dashes");
  const rules = css.slice(css.indexOf("/* A gift from the Kleo team"));
  assert.ok(rules.includes(".gp-card") && rules.includes(".gp-ok"), "the card's styles are there");
  for (const m of rules.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]) >= 16, `font-size ${m[1]}px`);
  const z = (sel) => Number(new RegExp(`${sel} \\{[^}]*z-index: (\\d+)`).exec(css)?.[1]);
  assert.ok(z("\\.gp-scrim") < z("#toast") && z("\\.gp-scrim") > z("\\.viewer"), "under the toasts, over the page's layers");
  // The console: one id per sheet, a busy button, the server's address, no gift for an assistant-only account, a real resend.
  assert.match(admin, /"Gift credits"/);
  assert.match(admin, /postFresh\(`\/api\/admin\/users\/\$\{id\}\/gift`, \{ id: st\.id,/);
  assert.match(admin, /const st = \{ email: !!to, busy: false, id: giftId\(\) \};/);
  assert.match(admin, /send\.disabled = st\.busy \|\|/);
  assert.match(admin, /const to = d\.giftTo \|\| null;/);
  assert.match(admin, /u\.anonymous \|\| blocked \? null : h\("button", \{ class: "btn btn-quiet", onclick: giftSheet \}/);
  assert.match(admin, /"Send the e-mail again"/);
  assert.match(admin, /"E-mail them"/);
  // C: a deleted account's gift never reads "null"; B: a stale send offers the button again.
  for (const t of ["E-mail sent (address removed with the account)", "No e-mail (reason removed with the account)", "E-mail refused (reason removed with the account)"]) assert.ok(admin.includes(t), t);
  assert.doesNotMatch(admin, /`E-mail sent to \$\{g\.mail_to\}` : g\.mail_status/, "no address printed without checking it is there");
  assert.match(admin, /const giftStale = \(g\) => g\.mail_status === "sending" && \(!g\.mailed_at \|\| Date\.now\(\) - toDate\(g\.mailed_at\)\.getTime\(\) > 5 \* 60e3\);/);
  // The button: waiting, never sent, or a stale send (giftUnsent), on an account that still exists.
  assert.match(admin, /const giftUnsent = \(g\) => g\.mail_status === "waiting" \|\| !g\.mail_status \|\| giftStale\(g\);/);
  assert.match(admin, /const canSend = !u\.deleted && !g\.cancelled_at && g\.mail && giftUnsent\(g\);/);
});

// ── The follow-up (after PR #157 went live): errors after the commit, stale sends, the claim, D1 errors after a send ──

/** Makes the next `times` statements whose SQL matches `re` fail when they run, the way D1 does when its connection drops. */
function failOn(env, re, times = 1) {
  const real = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const st = real(sql);
    if (times > 0 && re.test(sql)) { times--; st.run = async () => { throw new Error("D1_ERROR: Network connection lost."); }; }
    return st;
  };
}
/** A gift whose e-mail is waiting: Email Sending said "later" (a rate limit) when it was given. */
async function waitingGift(env, owner, who) {
  env.refuse = "Rate limit exceeded, try later";
  const r = await gift(env, owner.admin, who.id, { id: giftIdOf(), credits: 2, reason: "a thank you", email: true });
  env.refuse = null;
  assert.equal(r.json.gift.mail.status, "waiting", r.text);
  return r.json.gift.id;
}

test("A: an error after this request's own batch went in still sends the e-mail and writes the audit row; only the id conflict is a repeat", async () => {
  const { env, owner, kal } = await setup();
  // The batch commits, then its answer is lost.
  const realBatch = env.DB.batch.bind(env.DB);
  let lose = 1;
  env.DB.batch = async (stmts) => {
    const out = await realBatch(stmts);
    if (lose > 0 && /^INSERT INTO studio_gifts/.test(stmts[0]?.sql ?? "")) { lose--; throw new Error("D1_ERROR: Network connection lost."); }
    return out;
  };
  const r = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 20, reason: "Thank you", email: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.again, undefined, "it is this request's own gift, not a repeat");
  assert.equal(r.json.credits, 25);
  assert.equal(r.json.gift.mail.status, "sent");
  assert.equal(env.sent.length, 1, "the e-mail went out");
  assert.equal(auditOf(env, kal.id, "admin.gift").length, 1, "and the audit row is there");
  assert.equal(auditOf(env, kal.id, "admin.credits").length, 1);
  // The same id sent twice at once: the second request's check misses the first's row, its batch fails on the id and
  // is rolled back. That one, and only that one, is answered as a repeat.
  const id = r.json.gift.id;
  const realPrepare = env.DB.prepare.bind(env.DB);
  let hide = 1;
  env.DB.prepare = (sql) => {
    const st = realPrepare(sql);
    if (hide > 0 && sql === "SELECT * FROM studio_gifts WHERE id = ?") { hide--; st.first = async () => null; }
    return st;
  };
  const twin = await gift(env, owner.admin, kal.id, { id, credits: 20, reason: "Thank you", email: true });
  assert.equal(twin.status, 200, twin.text);
  assert.equal(twin.json.again, true);
  assert.equal(credits(env, kal.id), 25, "no credits moved twice");
  assert.equal(env.sent.length, 1, "no second e-mail");
  assert.equal(auditOf(env, kal.id, "admin.credits").length, 1);
  assert.equal(auditOf(env, kal.id, "admin.gift").length, 1);
});

test("B: a send cut off after its claim waits 5 minutes, then can go again; the claim's time is stamped; it all runs under waitUntil", async () => {
  const { env, owner, kal } = await setup();
  const before = ctx.waited;
  const r = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 20, reason: "Thank you", email: true });
  assert.equal(r.json.gift.mail.status, "sent");
  assert.ok(ctx.waited > before, "the e-mail and the audit row run under ctx.waitUntil");
  const id = await waitingGift(env, owner, kal);
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  // Claimed a minute ago, no outcome yet: it is on its way, and nothing sends it twice.
  run(env, "UPDATE studio_gifts SET mail_status = 'sending', mailed_at = ? WHERE id = ?", ago(1), id);
  const busy = await mailAgain(env, owner.admin, kal.id, id);
  assert.equal(busy.status, 409);
  assert.match(busy.json.error, /on its way/);
  const sent = env.sent.length;
  // Claimed ten minutes ago, still no outcome (the request was cut off): it counts as waiting again.
  run(env, "UPDATE studio_gifts SET mailed_at = ? WHERE id = ?", ago(10), id);
  const w0 = ctx.waited;
  const again = await mailAgain(env, owner.admin, kal.id, id);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.mail.status, "sent");
  assert.equal(env.sent.length, sent + 1);
  assert.ok(ctx.waited > w0, "sending again runs under waitUntil too");
  // A claim from before the claim's time was stamped (no mailed_at) counts as stale as well.
  const old = await waitingGift(env, owner, kal);
  run(env, "UPDATE studio_gifts SET mail_status = 'sending', mailed_at = NULL WHERE id = ?", old);
  assert.equal((await mailAgain(env, owner.admin, kal.id, old)).json.mail.status, "sent");
  // The claim stamps its time: when the outcome can't be written, the row keeps 'sending' with the claim's time.
  failOn(env, /^UPDATE studio_gifts SET mail_status = \?, mail_to = \?/);
  const cut = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 1, reason: "Thank you", email: true });
  const row = get(env, "SELECT mail_status, mailed_at FROM studio_gifts WHERE id = ?", cut.json.gift.id);
  assert.equal(row.mail_status, "sending");
  assert.ok(Date.now() - Date.parse(row.mailed_at) < 60_000, "the claim's time");
});

test("G: a D1 error after a successful send keeps the gift sent; the claim sends once under concurrency, and only for its own account", async () => {
  const { env, owner, kal, bo } = await setup();
  // The mail log's write fails after the send: the gift is sent, and says so.
  failOn(env, /^INSERT INTO studio_mail_log/);
  let r = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 20, reason: "Thank you", email: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.gift.mail.status, "sent");
  assert.equal(get(env, "SELECT mail_status FROM studio_gifts WHERE id = ?", r.json.gift.id).mail_status, "sent");
  assert.equal(env.sent.length, 1);
  // The outcome's own write fails after the send: the answer still says sent, never failed.
  failOn(env, /^UPDATE studio_gifts SET mail_status = \?, mail_to = \?/);
  r = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 1, reason: "Thank you", email: true });
  assert.equal(r.json.gift.mail.status, "sent");
  assert.equal(env.sent.length, 2);
  // Two "Send the e-mail again" at once for one waiting gift: one sends, the other is told it is on its way.
  const id = await waitingGift(env, owner, kal);
  const sent = env.sent.length;
  const both = await Promise.all([mailAgain(env, owner.admin, kal.id, id), mailAgain(env, owner.admin, kal.id, id)]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  assert.equal(env.sent.length, sent + 1, "exactly one e-mail");
  // Another account's path never sends it, and leaves it waiting for its own.
  const bos = await waitingGift(env, owner, bo);
  const n = env.sent.length;
  assert.equal((await mailAgain(env, owner.admin, kal.id, bos)).status, 404);
  assert.equal(env.sent.length, n);
  assert.equal(get(env, "SELECT mail_status FROM studio_gifts WHERE id = ?", bos).mail_status, "waiting");
  assert.equal((await mailAgain(env, owner.admin, bo.id, bos)).json.mail.status, "sent");
});

// ── The last follow-up (after PR #158 went live): one waitUntil from the credit batch on, a failed gift lookup, deleted accounts ──

test("1: the whole gift, credit batch included, runs under waitUntil: it is registered before the batch's answer comes back", async () => {
  const { env, owner, kal } = await setup();
  const realBatch = env.DB.batch.bind(env.DB);
  let atBatchEnd = null;
  env.DB.batch = async (stmts) => {
    const out = await realBatch(stmts);
    if (/^INSERT INTO studio_gifts/.test(stmts[0]?.sql ?? "")) atBatchEnd = ctx.waited;
    return out;
  };
  const start = ctx.waited;
  const r = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 20, reason: "Thank you", email: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.gift.mail.status, "sent");
  assert.ok(atBatchEnd !== null && atBatchEnd > start, "a tab closed during the credit batch can't cut off the e-mail or the audit row");
  assert.equal(auditOf(env, kal.id, "admin.gift").length, 1);
  // A refusal inside that work (20 + 81 is past the 100 a code is not needed for) still reaches the console as itself.
  const s = await mod.readAdminCookie("s3cret", owner.adminCookie.split("=")[1]);
  const stale = `${owner.cookie}; __Host-kleo_admin=${await mod.adminCookieValue("s3cret", { ...s, fresh: s.fresh - 6 * 60 })}`;
  const refused = await gift(env, stale, kal.id, { id: giftIdOf(), credits: 81, reason: "one more", email: false });
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json.code, "fresh_code");
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM studio_gifts WHERE user_id = ?", kal.id), 1, "and nothing moved");
});

test("2: /api/me tells no gifts (gift: { items: [] }) apart from a lookup that failed (giftError, no gift); the app forgets kept ids only on a real answer", async () => {
  const { env, kal } = await setup();
  let me = await call(env, "/api/me", { cookie: kal.cookie });
  assert.deepEqual(me.json.gift, { items: [], credits: 0 });
  assert.equal(me.json.giftError, undefined);
  // The gift lookup fails for a moment: /api/me still answers, says so, and lists nothing as "no gifts".
  const real = env.DB.prepare.bind(env.DB);
  let fail = 1;
  env.DB.prepare = (sql) => {
    const st = real(sql);
    if (fail > 0 && /^SELECT id, credits, message FROM studio_gifts/.test(sql)) { fail--; st.all = async () => { throw new Error("D1_ERROR: Network connection lost."); }; }
    return st;
  };
  me = await call(env, "/api/me", { cookie: kal.cookie });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json.giftError, true);
  assert.ok(!("gift" in me.json), "no gift field when the lookup failed");
  assert.equal(me.json.id, kal.id, "the rest of the answer is there");
  // The app side of it.
  const app = readFileSync(join(ROOT, "studio-web", "app.js"), "utf8");
  const part = app.slice(app.indexOf("// ── A gift from the Kleo team"), app.indexOf("// ── Create: the chat with Kleo"));
  assert.match(part, /function seedShown\(items, answered\)/);
  assert.match(part, /if \(answered && gone\.length\) dropShown\(gone\);/, "kept ids are forgotten only when the server answered the lookup");
  assert.match(part, /const giftAnswered = \(me\) => !!me && !me\.giftError && Array\.isArray\(me\.gift\?\.items\);/);
  assert.match(part, /seedShown\(items, giftAnswered\(me\)\);/, "the re-read after a wait too");
});

test("3: on a deleted account a gift e-mail still to go reads 'No e-mail: the account was deleted', with no button", async () => {
  const { env, owner, kal } = await setup();
  env.refuse = "Rate limit exceeded, try later";
  const r = await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 5, reason: "Thank you", email: true });
  env.refuse = null;
  assert.equal(r.json.gift.mail.status, "waiting");
  assert.equal((await call(env, "/api/me/delete", { method: "POST", cookie: kal.cookie, body: { confirm: "DELETE" } })).status, 200);
  const d = await call(env, `/api/admin/users/${kal.id}`, { cookie: owner.admin });
  assert.equal(d.json.user.deleted, 1);
  assert.deepEqual(d.json.gifts.map((g) => [g.mail_status, g.mail_error]), [["waiting", null]], "what the console's line is drawn from");
  // A send for it would only be skipped: the account is closed.
  const again = await mailAgain(env, owner.admin, kal.id, r.json.gift.id);
  assert.equal(again.json.mail.status, "skipped");
  assert.equal(env.sent.length, 0);
  const admin = readFileSync(join(ROOT, "studio-web", "admin.js"), "utf8");
  assert.match(admin, /const giftUnsent = \(g\) => g\.mail_status === "waiting" \|\| !g\.mail_status \|\| giftStale\(g\);/);
  assert.match(admin, /if \(u\.deleted && giftUnsent\(g\)\) return "No e-mail: the account was deleted";/);
  assert.match(admin, /const canSend = !u\.deleted && !g\.cancelled_at && g\.mail && giftUnsent\(g\);/);
  // A stale send on a deleted account may have gone out: its own line comes first and never claims "No e-mail".
  const stale = admin.indexOf('if (u.deleted && giftStale(g)) return "No more e-mail: the account was deleted (an earlier send may have gone out)";');
  assert.ok(stale > 0, "the deleted account's stale-send line");
  assert.ok(stale < admin.indexOf('if (u.deleted && giftUnsent(g)) return "No e-mail: the account was deleted";'), "checked before the plain deleted line");
});

// ── Cancel a gift (30 October 2026: a gift went to a creator too early, and Take credits away left its pop-up pending) ──

const cancelGift = (env, cookie, id, giftId, body = { reason: "Sent too early" }) => call(env, `/api/admin/users/${id}/gifts/${giftId}/cancel`, { method: "POST", cookie, body });

test("cancel: the credits come back and the pop-up never shows; audited like Take credits away; twice changes nothing", async () => {
  const { env, owner, kal } = await setup();
  const g = (await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 20, reason: "Thank you", email: false })).json.gift;
  assert.equal(credits(env, kal.id), 25);
  assert.equal((await call(env, "/api/me", { cookie: kal.cookie })).json.gift.items.length, 1);
  assert.equal((await cancelGift(env, owner.admin, kal.id, g.id, {})).json.code, "reason", "a reason first");
  const r = await cancelGift(env, owner.admin, kal.id, g.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.again, undefined);
  assert.equal(r.json.credits, 5);
  assert.equal(r.json.gift.cancelled_credits, 20);
  assert.ok(r.json.gift.cancelled_at);
  assert.equal(credits(env, kal.id), 5);
  assert.deepEqual((await call(env, "/api/me", { cookie: kal.cookie })).json.gift, { items: [], credits: 0 }, "the pop-up never shows");
  const row = get(env, "SELECT cancelled_at, cancelled_credits, seen_at FROM studio_gifts WHERE id = ?", g.id);
  assert.ok(row.cancelled_at && row.seen_at, "cancelled, and seen so nothing ever shows it");
  assert.equal(row.cancelled_credits, 20);
  // The take-back is an admin.credits row with the gift's id, next to the gift's own cancel row.
  const back = auditOf(env, kal.id, "admin.credits")[0];
  assert.deepEqual([back.delta, back.before, back.after, back.gift, back.cancel, back.reason, back.admin], [-20, 25, 5, g.id, true, "Sent too early", owner.id]);
  const gc = auditOf(env, kal.id, "admin.gift")[0];
  assert.deepEqual([gc.action, gc.gift, gc.credits, gc.reason, gc.admin], ["cancel", g.id, 20, "Sent too early", owner.id]);
  // Twice: answered as it is, nothing moves.
  const again = await cancelGift(env, owner.admin, kal.id, g.id);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.again, true);
  assert.equal(again.json.gift.cancelled_credits, 20);
  assert.equal(credits(env, kal.id), 5);
  assert.equal(auditOf(env, kal.id, "admin.credits").length, 2, "the gift and its take-back, nothing more");
  assert.equal(auditOf(env, kal.id, "admin.gift").filter((a) => a.action === "cancel").length, 1);
  // The console's account page has what its card shows: Cancelled, when, and the credits that came back.
  const d = await call(env, `/api/admin/users/${kal.id}`, { cookie: owner.admin });
  assert.deepEqual(d.json.gifts.map((x) => [x.id, !!x.cancelled_at, x.cancelled_credits]), [[g.id, true, 20]]);
});

test("cancel: only on its own account (404 elsewhere); never more than the balance; a gift seen already is refused; its e-mail never goes", async () => {
  const { env, owner, kal, bo } = await setup();
  const g = (await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 20, reason: "Thank you", email: false })).json.gift;
  const wrong = await cancelGift(env, owner.admin, bo.id, g.id);
  assert.equal(wrong.status, 404);
  assert.equal(get(env, "SELECT cancelled_at FROM studio_gifts WHERE id = ?", g.id).cancelled_at, null);
  assert.deepEqual([credits(env, bo.id), credits(env, kal.id)], [5, 25]);
  // Kal spent most of it: only what is there comes back, and the balance stops at zero.
  run(env, "UPDATE users SET credits = 7 WHERE id = ?", kal.id);
  const r = await cancelGift(env, owner.admin, kal.id, g.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.gift.cancelled_credits, 7);
  assert.equal(credits(env, kal.id), 0);
  assert.deepEqual([auditOf(env, kal.id, "admin.credits")[0].delta, auditOf(env, kal.id, "admin.credits")[0].after], [-7, 0]);
  // A gift the person saw already: its pop-up said it, so taking it back is Take credits away's job.
  const seen = (await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 5, reason: "Thank you", email: false })).json.gift;
  await call(env, "/api/me/gift/seen", { method: "POST", cookie: kal.cookie, body: { ids: [seen.id] } });
  const late = await cancelGift(env, owner.admin, kal.id, seen.id);
  assert.equal(late.status, 409);
  assert.equal(late.json.code, "gift_seen");
  assert.equal(credits(env, kal.id), 5);
  // A cancelled gift's e-mail, waiting when it was cancelled, never goes.
  env.refuse = "Rate limit exceeded, try later";
  const w = (await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 3, reason: "Thank you", email: true })).json.gift;
  env.refuse = null;
  assert.equal(w.mail.status, "waiting");
  assert.equal((await cancelGift(env, owner.admin, kal.id, w.id)).status, 200);
  const m = await mailAgain(env, owner.admin, kal.id, w.id);
  assert.equal(m.status, 409);
  assert.match(m.json.error, /cancelled/);
  assert.equal(env.sent.length, 0);
});

test("cancel: the take-back counts toward CREDITS_WITHOUT_CODE exactly like Take credits away", async () => {
  const { env, owner, kal } = await setup();
  const g = (await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 20, reason: "Thank you", email: false })).json.gift;
  const s = await mod.readAdminCookie("s3cret", owner.adminCookie.split("=")[1]);
  const stale = `${owner.cookie}; __Host-kleo_admin=${await mod.adminCookieValue("s3cret", { ...s, fresh: s.fresh - 6 * 60 })}`;
  // 20 given and 61 added are 81 in the window: taking 20 back would make 101.
  assert.equal((await call(env, `/api/admin/users/${kal.id}/credits`, { method: "POST", cookie: stale, body: { delta: 61, reason: "a grant" } })).status, 200);
  const refused = await cancelGift(env, stale, kal.id, g.id);
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json.code, "fresh_code");
  assert.equal(get(env, "SELECT cancelled_at FROM studio_gifts WHERE id = ?", g.id).cancelled_at, null, "a refused cancel changes nothing");
  assert.equal(credits(env, kal.id), 86);
  assert.equal(auditOf(env, kal.id, "admin.gift").filter((a) => a.action === "cancel").length, 0);
  const ok = await cancelGift(env, stale, kal.id, g.id, { reason: "Sent too early", code: await codeAt(owner.secret, 0) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(credits(env, kal.id), 66);
  // Over 100 at once wants the code first, whatever the window holds.
  const big = (await gift(env, `${owner.cookie}; ${cookieOf(ok)}`, kal.id, { id: giftIdOf(), credits: 150, reason: "A big thank you", email: false })).json.gift;
  assert.equal((await cancelGift(env, stale, kal.id, big.id)).json.code, "fresh_code");
  assert.equal(get(env, "SELECT cancelled_at FROM studio_gifts WHERE id = ?", big.id).cancelled_at, null);
});

test("cancel: a creator's program credits stay theirs; only the gift's ordinary credits go (users_program_credits_spent)", async () => {
  const { env, owner, kal, bo } = await setup();
  const balance = (id) => ({ ...get(env, "SELECT credits, program_credits AS program FROM users WHERE id = ?", id) });
  // Kal: 110 credits, all from the program (a Pro partner's month). A 50-credit gift goes in as ordinary credits.
  run(env, "UPDATE users SET credits = 110, program_credits = 110 WHERE id = ?", kal.id);
  const g = (await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 50, reason: "Thank you", email: false })).json.gift;
  assert.deepEqual(balance(kal.id), { credits: 160, program: 110 });
  const r = await cancelGift(env, owner.admin, kal.id, g.id);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(balance(kal.id), { credits: 110, program: 110 }, "the trigger took 50 off the program credits; the batch put them back");
  const back = auditOf(env, kal.id, "admin.credits")[0];
  assert.deepEqual([back.delta, back.before, back.after, back.program_before], [-50, 160, 110, 110]);
  // Bo: 30 program credits, a 50-credit gift, then 10 spent (the trigger takes those off the program credits first).
  run(env, "UPDATE users SET credits = 30, program_credits = 30 WHERE id = ?", bo.id);
  const g2 = (await gift(env, owner.admin, bo.id, { id: giftIdOf(), credits: 50, reason: "Thank you", email: false })).json.gift;
  run(env, "UPDATE users SET credits = credits - 10 WHERE id = ?", bo.id);
  assert.deepEqual(balance(bo.id), { credits: 70, program: 20 });
  assert.equal((await cancelGift(env, owner.admin, bo.id, g2.id)).status, 200);
  assert.deepEqual(balance(bo.id), { credits: 20, program: 20 }, "the program's 20 are left, never more than the balance");
});

test("cancel with takeBack: false only stops the pop-up: no credits move, no admin.credits row, no code even for a big gift", async () => {
  const { env, owner, kal } = await setup();
  const g = (await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 20, reason: "Thank you", email: false })).json.gift;
  // The incident: the credits were taken away by hand, and the gift stayed pending.
  assert.equal((await call(env, `/api/admin/users/${kal.id}/credits`, { method: "POST", cookie: owner.admin, body: { delta: -20, reason: "Sent too early" } })).status, 200);
  assert.equal(credits(env, kal.id), 5);
  assert.equal((await call(env, "/api/me", { cookie: kal.cookie })).json.gift.items.length, 1, "its pop-up still waits");
  const r = await cancelGift(env, owner.admin, kal.id, g.id, { reason: "Credits taken by hand", takeBack: false });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.credits, r.json.gift.cancelled_credits], [5, 0]);
  assert.equal(credits(env, kal.id), 5, "their own 5 credits stay");
  assert.deepEqual(auditOf(env, kal.id, "admin.credits").map((a) => a.delta), [-20, 20], "the gift and the take-away by hand, nothing more");
  const gc = auditOf(env, kal.id, "admin.gift")[0];
  assert.deepEqual([gc.action, gc.takeBack, gc.credits, gc.gift, gc.reason], ["cancel", false, 0, g.id, "Credits taken by hand"]);
  const row = get(env, "SELECT cancelled_at, cancelled_credits, seen_at FROM studio_gifts WHERE id = ?", g.id);
  assert.ok(row.cancelled_at && row.seen_at);
  assert.equal(row.cancelled_credits, 0);
  assert.deepEqual((await call(env, "/api/me", { cookie: kal.cookie })).json.gift, { items: [], credits: 0 }, "the pop-up never shows");
  assert.equal((await cancelGift(env, owner.admin, kal.id, g.id, { reason: "again", takeBack: false })).json.again, true, "twice changes nothing");
  // Nothing moves, so no code: a 150-credit gift stops its pop-up from a console whose code is old.
  const big = (await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 150, reason: "A big thank you", email: false })).json.gift;
  const s = await mod.readAdminCookie("s3cret", owner.adminCookie.split("=")[1]);
  const stale = `${owner.cookie}; __Host-kleo_admin=${await mod.adminCookieValue("s3cret", { ...s, fresh: s.fresh - 6 * 60 })}`;
  assert.equal((await cancelGift(env, stale, kal.id, big.id)).json.code, "fresh_code", "taking 150 back wants the code");
  const only = await cancelGift(env, stale, kal.id, big.id, { reason: "Pop-up only", takeBack: false });
  assert.equal(only.status, 200, only.text);
  assert.equal(credits(env, kal.id), 155);
});

test("cancel never takes more than the amount it checked: a refund landing between the check and the batch stays", async () => {
  const { env, owner, kal } = await setup();
  const g = (await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 150, reason: "A big thank you", email: false })).json.gift;
  // The gift went in with a code typed more than 5 minutes ago: its own row no longer counts toward the 100.
  run(env, "UPDATE audit SET at = ? WHERE user_id = ?", new Date(Date.now() - 10 * 60_000).toISOString(), kal.id);
  run(env, "UPDATE users SET credits = 90 WHERE id = ?", kal.id);
  const s = await mod.readAdminCookie("s3cret", owner.adminCookie.split("=")[1]);
  const stale = `${owner.cookie}; __Host-kleo_admin=${await mod.adminCookieValue("s3cret", { ...s, fresh: s.fresh - 6 * 60 })}`;
  // The cancel reads 90 (so 90 may go without a code); a clip's refund brings the balance to 150 before its batch runs.
  const batch = env.DB.batch.bind(env.DB);
  let refunded = false;
  env.DB.batch = async (stmts) => {
    if (!refunded && stmts.some((st) => /UPDATE studio_gifts SET cancelled_at/.test(st.sql))) { refunded = true; run(env, "UPDATE users SET credits = 150 WHERE id = ?", kal.id); }
    return batch(stmts);
  };
  const r = await cancelGift(env, stale, kal.id, g.id);
  assert.equal(r.status, 200, r.text);
  assert.ok(refunded, "the batch ran after the refund");
  assert.equal(r.json.gift.cancelled_credits, 90, "the 90 it checked, not the 150 there by then");
  assert.equal(credits(env, kal.id), 60);
  const back = auditOf(env, kal.id, "admin.credits")[0];
  assert.deepEqual([back.delta, back.before, back.after], [-90, 150, 60]);
  assert.equal(auditOf(env, kal.id, "admin.gift")[0].credits, 90);
});

test("cancel in the console: a real button on a gift not seen yet, the console's own sheet with two choices, the card and timeline say Cancelled", () => {
  const admin = readFileSync(join(ROOT, "studio-web", "admin.js"), "utf8");
  assert.match(admin, /const canCancel = !g\.cancelled_at && !g\.seen_at;/);
  assert.match(admin, /const cancel = canCancel \? h\("button", \{ class: "btn btn-quiet btn-sm adm-gift-cancel", type: "button" \}, icon\("x", 15\), "Cancel gift"\) : null;/);
  assert.match(admin, /cancel\?\.addEventListener\("click", \(\) => cancelGift\(g, cancel\)\);/, "wired");
  assert.match(admin, /again \|\| cancel \? h\("div", \{ class: "adm-gift-btns" \}, again, cancel\) : null\)\);\n  \}\)\)\) : null;/, "placed in the gift's row");
  const fn = admin.slice(admin.indexOf("function cancelGift(g, btn) {"), admin.indexOf("const gifts = d.gifts?.length"));
  assert.ok(fn.length > 500, "the sheet's code");
  assert.ok(fn.indexOf("btn.disabled = true;") > 0 && fn.indexOf("btn.disabled = true;") < fn.indexOf("await post(`gifts/${g.id}/cancel`"), "disabled before it is sent");
  assert.match(fn, /catch \(e\) \{ st\.busy = false; draw\(\); btn\.disabled = false; oops\(e\); \}/);
  assert.match(fn, /`Cancel and take back up to \$\{count\(n, "credit"\)\}`/);
  assert.match(fn, /"Only stop the pop-up"/);
  assert.match(fn, /taken \? \[stop, back\] : \[back, stop\]/, "the pop-up first after a take-away by hand");
  assert.match(fn, /await post\(`gifts\/\$\{g\.id\}\/cancel`, \{ reason: reasonIn\.value\.trim\(\), takeBack \}\)/);
  assert.match(fn, /back\?\.addEventListener\("click", \(\) => send\(true\)\);\s*stop\.addEventListener\("click", \(\) => send\(false\)\);/);
  assert.match(admin, /a\.event === "admin\.credits" && toDate\(a\.at\)\.getTime\(\) >= toDate\(g\.created_at\)\.getTime\(\)/);
  assert.match(admin, /const removedBy = \(x\) => Math\.max\(0, x\.before != null && x\.after != null \? Number\(x\.before\) - Number\(x\.after\) : -Number\(x\.delta\)\) \|\| 0;/,
    "what each row really removed (before - after), the delta asked for only on a row without them");
  assert.match(admin, /\.filter\(\(x\) => Number\(x\.delta\) < 0 && !x\.cancel\)\.reduce\(\(sum, x\) => sum \+ Math\.min\(-Number\(x\.delta\), removedBy\(x\)\), 0\)/,
    "only decreases, never more than each asked for, never another gift's cancel");
  assert.match(admin, /pill\(`Cancelled \$\{day\(g\.cancelled_at\)\}`, "bad"\)/);
  // A cancelled gift's stale send may have gone out: its line comes first and never claims "No e-mail".
  const staleLine = admin.indexOf('if (g.cancelled_at && giftStale(g)) return "Cancelled; an earlier e-mail may have gone out";');
  assert.ok(staleLine > 0, "the cancelled gift's stale-send line");
  assert.ok(staleLine < admin.indexOf('if (g.cancelled_at && giftUnsent(g)) return "No e-mail: the gift was cancelled";'), "checked before the plain cancelled line");
  assert.match(admin, /const eventName = \(a\) => \(giftCancelOf\(a\) \? "Admin cancelled a gift" : EVENTS\[a\.event\] \|\| a\.event\);/);
  assert.match(admin, /h\("b", \{\}, eventName\(a\)\), h\("span", \{\}, stamp\(a\.at\)\), eventText\(a\) \? h\("p", \{\}, eventText\(a\)\) : null/);
  assert.match(admin, /const canSend = !u\.deleted && !g\.cancelled_at && g\.mail && giftUnsent\(g\);/);
  assert.doesNotMatch(admin, /\b(?:window\.)?(?:alert|confirm|prompt)\(/);
  // The schema: the Worker adds the columns on a live table (skipping one already there); the migration has them for
  // a new database.
  const store = readFileSync(join(ROOT, "src", "studio", "store.ts"), "utf8");
  const sql = readFileSync(join(ROOT, "migrations", "0036_gift_cancel.sql"), "utf8");
  for (const c of ["cancelled_at TEXT", "cancelled_credits INTEGER"]) {
    assert.ok(store.includes(`"ALTER TABLE studio_gifts ADD COLUMN ${c}"`), `runtime ${c}`);
    assert.ok(sql.includes(`ALTER TABLE studio_gifts ADD COLUMN ${c};`), `migration ${c}`);
  }
});

// ── The console itself: studio-web/admin.js draws the account page from the Worker's own answers, on a stand-in DOM ──

/** A text node of the stand-in DOM. */
class FakeText {
  constructor(t) { this.data = String(t); this.parentNode = null; }
  get textContent() { return this.data; }
}
/** Just enough of an element for the console's account page, its sheets and its buttons. */
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = {}; this.childNodes = []; this.parentNode = null; this.handlers = {}; this.style = {};
    this.disabled = false; this.hidden = false; this.value = "";
    const cls = (this.cls = new Set());
    this.classList = {
      add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c),
      toggle: (c, on) => { const v = on === undefined ? !cls.has(c) : !!on; if (v) cls.add(c); else cls.delete(c); return v; },
    };
  }
  get className() { return [...this.cls].join(" "); }
  set className(v) { this.cls.clear(); for (const c of String(v).split(/\s+/)) if (c) this.cls.add(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "disabled") this.disabled = true; else if (k === "hidden") this.hidden = true; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] ?? []).filter((f) => f !== fn); }
  fire(type) { const e = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }; for (const f of this.handlers[type] ?? []) f(e); }
  /** A tap, as a browser gives it: none at all on a disabled button. */
  click() { if (!this.disabled) this.fire("click"); }
  typeIn(text) { this.value = text; this.fire("input"); }
  append(...kids) {
    for (const k of kids) {
      const n = k instanceof FakeEl || k instanceof FakeText ? k : new FakeText(k);
      if (n.parentNode) n.parentNode.childNodes = n.parentNode.childNodes.filter((x) => x !== n);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  replaceChildren(...kids) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...kids); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((x) => x !== this); this.parentNode = null; }
  get parentElement() { return this.parentNode; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === globalThis.document?.body; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.replaceChildren(String(v)); }
  focus() {} blur() {} select() {}
  *all() { for (const c of this.childNodes) if (c instanceof FakeEl) { yield c; yield* c.all(); } }
  find(fn) { for (const e of this.all()) if (fn(e)) return e; return null; }
  findAll(fn) { return [...this.all()].filter(fn); }
  querySelector(sel) { const c = /^\.([\w-]+)$/.exec(sel); return c ? this.find((e) => e.cls.has(c[1])) : null; }
  closest(sel) { const c = /^\.([\w-]+)$/.exec(sel); for (let n = this; n instanceof FakeEl; n = n.parentNode) if (c && n.cls.has(c[1])) return n; return null; }
}
/** The kit app.js hands the console (adminModule.render), on the stand-in DOM; what the console shows is kept to look at. */
function fakeKit(body) {
  const h = (tag, attrs, ...kids) => {
    const el = new FakeEl(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    el.append(...kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
    return el;
  };
  const view = h("div", { class: "view" });
  body.append(view);
  const kit = {
    h, toasts: [], errors: [], asked: [], layer: null,
    icon: (name) => h("svg", { "data-icon": name }),
    bolt: () => h("svg"),
    fill: (el, ...kids) => { el?.replaceChildren(...kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)); return el; },
    setView: (cls, ...kids) => kit.fill(view, ...kids),
    toast: (msg) => { kit.toasts.push(String(msg)); },
    closeLayer: () => { kit.layer?.remove(); kit.layer = null; },
    sheet: (title, sub, ...content) => {
      kit.closeLayer();
      kit.layer = h("div", { class: "sheet", role: "dialog", "aria-label": title }, h("h2", {}, title), sub ? h("p", { class: "sheet-sub" }, sub) : null, ...content);
      body.append(kit.layer);
      return kit.layer;
    },
    ask: async (q) => { kit.asked.push(q); return null; },
    spinner: () => h("span", { class: "spin" }),
    handleError: (e) => { kit.errors.push(e); },
    go: () => {}, api: async () => ({}), viewEl: () => view, nameOf: (m) => m, DEMO: false, me: null,
  };
  return kit;
}

test("cancel in the console, drawn for real: the button in the gift's row, the sheet's two choices (a take-away by hand named, the pop-up first), busy while it is sent", async () => {
  const { env, owner, kal, bo } = await setup();
  // Kal: a 20-credit gift, 10 of the 25 credits spent on a film, then the gift taken away by hand (the incident): Take
  // credits away asked for 20 but stops at zero, so 15 went. The film failed and its 10 credits came back. And a
  // 3-credit gift, cancelled, whose e-mail send was cut off with no outcome more than 5 minutes ago.
  const a = (await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 20, reason: "Thank you", email: false })).json.gift;
  run(env, "UPDATE users SET credits = credits - 10 WHERE id = ?", kal.id);
  assert.equal((await call(env, `/api/admin/users/${kal.id}/credits`, { method: "POST", cookie: owner.admin, body: { delta: -20, reason: "Sent too early" } })).json.credits, 0);
  run(env, "UPDATE users SET credits = credits + 10 WHERE id = ?", kal.id);
  const b = (await gift(env, owner.admin, kal.id, { id: giftIdOf(), credits: 3, reason: "Thank you", email: true })).json.gift;
  run(env, "UPDATE studio_gifts SET mail_status = 'sending', mailed_at = ? WHERE id = ?", new Date(Date.now() - 10 * 60_000).toISOString(), b.id);
  assert.equal((await cancelGift(env, owner.admin, kal.id, b.id)).status, 200);
  // Bo: a gift nothing happened to.
  await gift(env, owner.admin, bo.id, { id: giftIdOf(), credits: 10, reason: "Thank you", email: false });

  // The browser, as far as the account page needs it. The console's own fetches go to the Worker with the owner's cookie;
  // a write can be held on its way, to look at the page meanwhile.
  const saved = { fetch: globalThis.fetch, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const body = new FakeEl("body");
  const writes = [];
  let hold = null;
  globalThis.document = { body, hidden: false, visibilityState: "visible", activeElement: null, addEventListener() {}, removeEventListener() {},
    querySelector: (sel) => body.querySelector(sel), createElement: (t) => new FakeEl(t) };
  globalThis.window = { scrollY: 0, scrollTo() {}, getSelection: () => null };
  globalThis.setInterval = () => 0; // the page's own refresh (admin.js liveStart) never runs here
  globalThis.clearInterval = () => {};
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (!path.startsWith("/api/")) return saved.fetch(url, init);
    const method = init.method || "GET", sent = init.body ? JSON.parse(init.body) : undefined;
    if (method !== "GET") { writes.push({ path, body: sent }); await hold; }
    const r = await call(env, path, { method, body: sent, cookie: owner.admin });
    return new Response(r.text, { status: r.status, headers: { "content-type": "application/json" } });
  };
  const kit = fakeKit(body);
  const until = async (what, fn) => {
    for (let i = 0; i < 400; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
    assert.fail(`never: ${what}. On the page: ${body.textContent.slice(0, 1500)} Errors: ${kit.errors.map((e) => e?.message).join("; ")}`);
  };
  const giftRow = (n) => body.find((e) => e.cls.has("adm-gift-row") && (e.find((x) => x.tagName === "B")?.textContent ?? "").startsWith(`${n} credits`));
  const cancels = () => writes.filter((w) => w.path.endsWith("/cancel"));
  try {
    globalThis.location = new URL(`https://admin.kleo.test/admin/users/${kal.id}`);
    const admin = await import(pathToFileURL(join(ROOT, "studio-web", "admin.js")).href);
    admin.render(kit);
    const rowA = await until("Kal's gifts drawn", () => giftRow(20));
    const cancelA = rowA.find((e) => e.tagName === "BUTTON" && e.cls.has("adm-gift-cancel"));
    assert.ok(cancelA, "a Cancel gift button in the gift's own row");
    assert.equal(cancelA.textContent, "Cancel gift");
    assert.ok(cancelA.isConnected, "on the page");
    // The cancelled 3-credit gift: what came back, its e-mail line, and no button.
    const rowB = giftRow(3);
    assert.match(rowB.textContent, /3 credits came back/);
    assert.match(rowB.textContent, /Cancelled; an earlier e-mail may have gone out/);
    assert.doesNotMatch(rowB.textContent, /No e-mail: the gift was cancelled/);
    assert.equal(rowB.find((e) => e.tagName === "BUTTON"), null, "no Cancel and no resend on a cancelled gift");
    // The timeline names the cancel a cancel, with the credits that came back; the two gifts stay "sent".
    const events = body.findAll((e) => e.cls.has("adm-ev")).map((e) => e.textContent);
    assert.equal(events.filter((t) => t.startsWith("Admin cancelled a gift")).length, 1, events.join("\n"));
    assert.ok(events.some((t) => t.startsWith("Admin cancelled a gift") && t.includes("3 credits came back")), events.join("\n"));
    assert.equal(events.filter((t) => t.startsWith("Admin sent a gift")).length, 2, events.join("\n"));

    // Cancel the 20-credit gift: the console's own sheet, the take-away by hand named, "Only stop the pop-up" first.
    cancelA.click();
    const sheet = kit.layer;
    assert.ok(sheet, "the button opens the console's sheet");
    assert.equal(sheet.find((e) => e.tagName === "H2").textContent, "Cancel this gift?");
    assert.match(sheet.find((e) => e.cls.has("adm-gift-taken"))?.textContent ?? "", /After this gift, 15 credits were taken away from this account with Take credits away\./);
    const choices = sheet.find((e) => e.cls.has("adm-gift-choice")).childNodes;
    assert.deepEqual(choices.map((x) => x.textContent), ["Only stop the pop-up", "Cancel and take back up to 10 credits"]);
    assert.ok(choices.every((x) => x.disabled), "both wait for a reason");
    sheet.find((e) => e.tagName === "INPUT").typeIn("Credits taken by hand");
    assert.ok(choices.every((x) => !x.disabled));
    // While it is on its way, neither choice nor the gift's own button sends it again.
    let release;
    hold = new Promise((r) => { release = r; });
    choices[0].click();
    await until("the cancel sent", () => cancels().length === 1);
    assert.deepEqual(cancels()[0], { path: `/api/admin/users/${kal.id}/gifts/${a.id}/cancel`, body: { reason: "Credits taken by hand", takeBack: false } });
    assert.ok(cancelA.disabled, "the gift's button is off while it is sent");
    assert.ok(choices.every((x) => x.disabled), "and so are both choices");
    for (const x of [...choices, cancelA]) x.click();
    assert.equal(cancels().length, 1, "nothing more goes");
    release();
    hold = null;
    await until("its answer", () => kit.toasts.length === 1);
    assert.deepEqual(kit.toasts, ["Gift cancelled: its pop-up won't show, and no credits moved."]);
    assert.equal(kit.layer, null, "the sheet closes");
    assert.equal(credits(env, kal.id), 10, "their own credits stay");
    assert.equal(get(env, "SELECT cancelled_credits FROM studio_gifts WHERE id = ?", a.id).cancelled_credits, 0);
    const done = await until("the card redrawn", () => (giftRow(20)?.textContent.includes("no credits moved, only the pop-up stopped") ? giftRow(20) : null));
    assert.equal(done.find((e) => e.tagName === "BUTTON"), null);

    // Bo's gift, with nothing taken away by hand: no note, the take-back first, and its credits come back.
    globalThis.location = new URL(`https://admin.kleo.test/admin/users/${bo.id}`);
    admin.render(kit);
    const rowC = await until("Bo's gift drawn", () => giftRow(10));
    rowC.find((e) => e.cls.has("adm-gift-cancel")).click();
    assert.equal(kit.layer.find((e) => e.cls.has("adm-gift-taken")), null, "no note");
    const two = kit.layer.find((e) => e.cls.has("adm-gift-choice")).childNodes;
    assert.deepEqual(two.map((x) => x.textContent), ["Cancel and take back up to 10 credits", "Only stop the pop-up"]);
    kit.layer.find((e) => e.tagName === "INPUT").typeIn("Sent too early");
    two[0].click();
    await until("its answer", () => kit.toasts.length === 2);
    assert.equal(kit.toasts[1], "Gift cancelled: 10 credits came back.");
    assert.deepEqual(cancels()[1].body, { reason: "Sent too early", takeBack: true });
    assert.equal(credits(env, bo.id), 5);
    await until("Bo's card redrawn", () => giftRow(10)?.textContent.includes("10 credits came back"));
    assert.deepEqual(kit.errors.map((e) => e?.message ?? String(e)), [], "no error on the way");
    assert.deepEqual(kit.asked, [], "no code asked: the console's code is fresh");
  } finally {
    Object.assign(globalThis, saved);
    for (const k of ["document", "window", "location"]) delete globalThis[k];
  }
});
