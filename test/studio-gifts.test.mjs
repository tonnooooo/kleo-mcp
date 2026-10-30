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
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { base32Decode, hotp, stepAt } from "../src/studio/totp.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

class Stmt {
  constructor(db, sql) { this.stmt = db.prepare(sql); this.sql = sql; this.args = []; }
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
  assert.equal((await call(env, "/api/me", { cookie: bo.cookie })).json.gift, null);
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
  assert.equal((await call(env, "/api/me", { cookie: kal.cookie })).json.gift, null, "never again, here or on another device");
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
  assert.match(part, /const items = giftItems\(S\.me\.gift\);\s*seedShown\(items\);/, "a reload first takes the kept ids as shown");
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
  assert.match(admin, /const canSend = !u\.deleted && g\.mail && \(g\.mail_status === "waiting" \|\| !g\.mail_status \|\| giftStale\(g\)\);/);
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
