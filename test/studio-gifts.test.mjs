/**
 * A gift from the Kleo team (src/studio/gifts.ts, the admin console's "Gift credits", studio-web/app.js giftModal) inside
 * one process: the kleo-studio Worker bundled with esbuild, on a D1 look-alike (node:sqlite, every migration applied).
 * Covers the console's action (the credits at once through the same audited path as Add credits, its
 * CREDITS_WITHOUT_CODE rule and fresh code, the gift's row only with its audit row), the e-mail (through the welcome
 * e-mails' sending, the Kleo Creators line, an address on the stop list, a refusal that never undoes the gift), the app's
 * side (/api/me carries the gift until the page says it was seen: once, for its own account only), the console's
 * account page and previews, and the owner's rules for the pages (his words, no browser pop-ups, no small print).
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
    // Cloudflare Email Sending (onboarding.ts deliver): every message is kept here; `refuse` makes it say no.
    sent: [], refuse: null,
    EMAIL: { send: async (m) => { if (env.refuse) throw new Error(env.refuse); env.sent.push(m); return { messageId: `m${env.sent.length}` }; } },
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
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

test("Gift credits: the credits go in at once through the audited path, the gift waits for the app, the e-mail goes out", async () => {
  const { env, owner, kal } = await setup();
  const r = await gift(env, owner.admin, kal.id, { credits: 20, reason: "Thank you, our best customer", email: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.credits, 25, "5 from the sign-up, 20 from the team");
  const g = get(env, "SELECT * FROM studio_gifts WHERE user_id = ?", kal.id);
  assert.equal(r.json.gift.id, g.id);
  assert.match(g.id, /^gf_[a-z0-9]{12}$/);
  assert.deepEqual([g.credits, g.reason, g.message, g.by_admin, g.seen_at, g.mail, g.mail_status, g.mail_to, g.mail_error],
    [20, "Thank you, our best customer", null, owner.id, null, 1, "sent", "kal@example.com", null]);
  // The same audit row as Add credits, with the gift's id: it counts toward CREDITS_WITHOUT_CODE like any other change.
  assert.deepEqual(auditOf(env, kal.id, "admin.credits"), [{ admin: owner.id, reason: "Thank you, our best customer", delta: 20, before: 5, gift: g.id, after: 25 }]);
  assert.deepEqual(auditOf(env, kal.id, "admin.gift"), [{ admin: owner.id, reason: "Thank you, our best customer", gift: g.id, credits: 20, message: false, mail: "sent" }]);
  // The e-mail, through the welcome e-mails' sending: from hello@kleooai.com, with the stop link.
  assert.equal(env.sent.length, 1);
  const m = env.sent[0];
  assert.equal(m.to, "kal@example.com");
  assert.deepEqual(m.from, { email: "hello@kleooai.com", name: "Leonardo from Kleo" });
  assert.equal(m.subject, "The Kleo team sent you 20 free credits");
  assert.match(m.text, /A little gift from all of us at Kleo: 20 free credits\. They're already in your account, so you have 25 credits now\./);
  assert.match(m.text, /Thanks for creating with Kleo, enjoy them!/);
  assert.match(m.text, /Kleo Creators, with 25% of every sale from your link for 12 months/);
  assert.match(m.text, /https:\/\/app\.kleooai\.com\/creators\?utm_source=email&utm_medium=gift/);
  assert.match(m.html, /href="https:\/\/app\.kleooai\.com\/creators\?utm_source=email[^"]*"[^>]*>app\.kleooai\.com\/creators<\/a>/);
  assert.ok(m.text.indexOf("20 free credits") < m.text.indexOf("Kleo Creators"), "the gift first, then the invitation");
  assert.match(m.headers["List-Unsubscribe"], /\/email\/stop\?u=/);
  assert.equal(m.headers["X-Kleo-Mail"], "gift");
  assert.equal(get(env, "SELECT COUNT(*) AS n FROM studio_mail_log WHERE user_id = ? AND mail = 'gift' AND kind = 'gift' AND ok = 1", kal.id).n, 1);
});

test("the app gets the gift until it says it was seen: once, for its own account only, never again", async () => {
  const { env, owner, kal, bo } = await setup();
  const r = await gift(env, owner.admin, kal.id, { credits: 20, reason: "Best customer", message: "  You made 40 videos\n   this month!  ", email: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.gift.mail, null, "no e-mail unless asked");
  assert.equal(env.sent.length, 0);
  assert.equal(get(env, "SELECT mail FROM studio_gifts WHERE id = ?", r.json.gift.id).mail, 0);
  let me = await call(env, "/api/me", { cookie: kal.cookie });
  assert.deepEqual(me.json.gift, { ids: [r.json.gift.id], credits: 20, message: "You made 40 videos this month!" });
  assert.equal(me.json.creator, null, "not in Kleo Creators: the app follows with the invitation");
  assert.equal((await call(env, "/api/me", { cookie: bo.cookie })).json.gift, null);
  // Another account can't mark it seen.
  assert.equal((await call(env, "/api/me/gift/seen", { method: "POST", cookie: bo.cookie, body: { ids: [r.json.gift.id] } })).json.seen, 0);
  assert.equal(get(env, "SELECT seen_at FROM studio_gifts WHERE id = ?", r.json.gift.id).seen_at, null);
  // A second gift before the first was seen: one pop-up for both, with the newest message.
  const r2 = await gift(env, owner.admin, kal.id, { credits: 5, reason: "Sorry about the failed clips", email: false });
  me = await call(env, "/api/me", { cookie: kal.cookie });
  assert.deepEqual(me.json.gift, { ids: [r.json.gift.id, r2.json.gift.id], credits: 25, message: "You made 40 videos this month!" });
  const seen = await call(env, "/api/me/gift/seen", { method: "POST", cookie: kal.cookie, body: { ids: me.json.gift.ids } });
  assert.equal(seen.status, 200, seen.text);
  assert.equal(seen.json.seen, 2);
  assert.equal((await call(env, "/api/me", { cookie: kal.cookie })).json.gift, null, "never again, here or on another device");
  assert.equal((await call(env, "/api/me/gift/seen", { method: "POST", cookie: kal.cookie, body: { ids: me.json.gift.ids } })).json.seen, 0);
  assert.equal((await call(env, "/api/me/gift/seen", { method: "POST", cookie: kal.cookie, body: { ids: ["nope", 3, null, "gf_x' OR 1=1"] } })).json.seen, 0);
  assert.equal((await call(env, "/api/me/gift/seen", { method: "POST", body: { ids: me.json.gift.ids } })).status, 401, "signed in only");
  assert.equal(auditOf(env, kal.id, "gift.seen").length, 1);
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
  assert.equal(get(env, "SELECT COUNT(*) AS n FROM studio_gifts").n, 1, "a refused gift leaves no row");
  assert.equal(get(env, "SELECT credits FROM users WHERE id = ?", kal.id).credits, 105, "and moves nothing");
  assert.equal(env.sent.length, 0, "and sends nothing");
  assert.equal((await gift(env, stale, kal.id, { credits: 500, reason: "a big thank you", email: false, code: "000000" })).json.code, "admin_wrong");
  const ok = await gift(env, stale, kal.id, { credits: 500, reason: "a big thank you", email: false, code: await codeAt(owner.secret, 0) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.credits, 605);
  assert.equal(get(env, "SELECT COUNT(*) AS n FROM studio_gifts WHERE user_id = ?", kal.id).n, 2);
  assert.deepEqual(auditOf(env, kal.id, "admin.credits").map((a) => [a.delta, a.after, !!a.gift]), [[500, 605, true], [40, 105, true], [60, 65, false]]);
});

test("the e-mail: the Creators line only outside the program; an unsubscribed address gets nothing; a refusal never undoes the gift", async () => {
  const { env, owner, kal, bo } = await setup();
  // Already in the program: no invitation, in the e-mail or in the app.
  run(env, `INSERT INTO creators (user_id, status, platform, handle, handle_key, profile_url, bio_code, terms_version, terms_at)
    VALUES (?, 'active', 'instagram', 'kal', 'kal', 'https://www.instagram.com/kal/', 'KLEO-ABC123', '2026-10-28', '2026-10-28T00:00:00.000Z')`, kal.id);
  let r = await gift(env, owner.admin, kal.id, { credits: 1, reason: "a thank you", email: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.gift.mail.status, "sent");
  assert.equal(env.sent[0].subject, "The Kleo team sent you 1 free credit");
  assert.match(env.sent[0].text, /It's already in your account, so you have 6 credits now\./);
  assert.doesNotMatch(env.sent[0].text, /Kleo Creators|\/creators/);
  assert.equal((await call(env, "/api/me", { cookie: kal.cookie })).json.creator.status, "active", "the app reads the same row and skips the invitation");
  // An address that unsubscribed: no e-mail, the gift and its pop-up all the same.
  run(env, "INSERT INTO mail_suppress (email, reason, source) VALUES ('bo@example.com', 'unsubscribe', 'onboarding')");
  r = await gift(env, owner.admin, bo.id, { credits: 10, reason: "a thank you", email: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.gift.mail, { status: "skipped", to: "bo@example.com", error: "This address unsubscribed from Kleo's e-mails." });
  assert.equal(r.json.credits, 15);
  assert.equal(env.sent.length, 1, "nothing more went out");
  assert.equal((await call(env, "/api/me", { cookie: bo.cookie })).json.gift.credits, 10);
  // Email Sending says no: the gift stays, and the console hears why.
  run(env, "DELETE FROM mail_suppress");
  env.refuse = "Too many e-mails right now";
  r = await gift(env, owner.admin, bo.id, { credits: 2, reason: "again", email: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.credits, 17);
  assert.equal(r.json.gift.mail.status, "failed");
  assert.match(r.json.gift.mail.error, /Too many e-mails right now/);
  assert.equal(get(env, "SELECT mail_status FROM studio_gifts WHERE id = ?", r.json.gift.id).mail_status, "failed");
  assert.equal(get(env, "SELECT COUNT(*) AS n FROM studio_mail_log WHERE mail = 'gift' AND ok = 0").n, 1);
  assert.equal(auditOf(env, bo.id, "admin.gift")[0].mail, "failed");
});

test("a gift wants a reason, a whole number, a short message and an open account; only an admin sends one", async () => {
  const { env, owner, kal, bo } = await setup();
  const path = `/api/admin/users/${kal.id}/gift`;
  assert.equal((await call(env, path, { method: "POST", cookie: owner.admin, body: { credits: 20 } })).json.code, "reason");
  for (const credits of [0, -5, "abc", null]) {
    assert.equal((await call(env, path, { method: "POST", cookie: owner.admin, body: { credits, reason: "a thank you" } })).json.code, "credits", String(credits));
  }
  const long = await call(env, path, { method: "POST", cookie: owner.admin, body: { credits: 5, reason: "a thank you", message: "x".repeat(mod.GIFT_MESSAGE_MAX + 1) } });
  assert.equal(long.json.code, "gift_message");
  assert.equal((await call(env, path, { method: "POST", cookie: kal.cookie, body: { credits: 5, reason: "free money" } })).status, 404, "a customer finds nothing there");
  run(env, "UPDATE users SET blocked_at = '2026-10-30T00:00:00.000Z' WHERE id = ?", bo.id);
  assert.equal((await gift(env, owner.admin, bo.id, { credits: 5, reason: "a thank you" })).json.code, "gift_closed");
  assert.equal(get(env, "SELECT COUNT(*) AS n FROM studio_gifts").n, 0);
  assert.equal(get(env, "SELECT credits FROM users WHERE id = ?", kal.id).credits, 5);
  assert.equal(mod.giftMessage("   "), null);
  assert.equal(mod.giftMessage("Two\nlines\tand  spaces"), "Two lines and spaces");
});

test("the e-mail's words: the amount and its plural, the message, the sign-off, no em dash; previewed and sent to the owner with the others", async () => {
  const many = mod.composeGift({ name: "Kalahyn", credits: 20, balance: 124, message: "We love your videos.", creator: false });
  const one = mod.composeGift({ name: null, credits: 1, balance: 1, message: null, creator: true });
  const words = (m) => JSON.stringify(m);
  assert.equal(many.subject, "The Kleo team sent you 20 free credits");
  assert.equal(one.subject, "The Kleo team sent you 1 free credit");
  assert.match(words(many), /Hi Kalahyn,/);
  assert.match(words(many), /We love your videos\./);
  assert.match(words(many), /you have 124 credits now/);
  assert.match(words(many), /Leonardo and the Kleo team/);
  assert.match(words(one), /Hi there,/);
  assert.match(words(one), /you have 1 credit now/);
  assert.match(words(one), /enjoy it!/);
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

test("the pages keep the owner's rules: his words, the X and one button, no browser pop-ups, nothing under 16 px", () => {
  const app = readFileSync(join(ROOT, "studio-web", "app.js"), "utf8");
  const css = readFileSync(join(ROOT, "studio-web", "app.css"), "utf8");
  const admin = readFileSync(join(ROOT, "studio-web", "admin.js"), "utf8");
  const part = app.slice(app.indexOf("// ── A gift from the Kleo team"), app.indexOf("// ── Create: the chat with Kleo"));
  assert.ok(part.length > 2000, "the gift's part of app.js is there, before the chat");
  for (const words of ["\"A gift from the Kleo team\"", "already in your account. Thanks for creating with Kleo, enjoy", "ok: \"Claim\"", "\"aria-label\": \"Close\"",
    "\"Become a Kleo Creator\"", "25% of every sale from your link, for 12 months", "Bonus credits for your views", "Extra credits in the months you post",
    "ok: \"Apply\"", "go(\"/creators\")", "/api/me/gift/seen"]) assert.ok(part.includes(words), words);
  assert.match(part, /S\.me\.creator/, "no invitation for an account already in Kleo Creators");
  assert.match(app, /await route\(\);\s*\/\/[^\n]*\n\s*maybeShowGift\(\);/, "enter() shows it, after the page it opens");
  for (const js of [part, admin]) assert.doesNotMatch(js, /\b(?:window\.)?(?:alert|confirm|prompt)\(/, "no browser pop-ups");
  assert.doesNotMatch(part, /[—–]/, "no em dashes");
  const rules = css.slice(css.indexOf("/* A gift from the Kleo team"));
  assert.ok(rules.includes(".gp-card") && rules.includes(".gp-ok"), "the card's styles are there");
  for (const m of rules.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]) >= 16, `font-size ${m[1]}px`);
  assert.match(admin, /"Gift credits"/);
  assert.match(admin, /postFresh\(`\/api\/admin\/users\/\$\{id\}\/gift`/, "the console sends it through the fresh-code path");
  assert.match(admin, /"E-mail them"/);
});
