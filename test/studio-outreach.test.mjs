/**
 * Kleo's outreach e-mails (src/studio/outreach.ts, src/studio/mailbox.ts, the admin console's Outreach page), inside one
 * process: the kleo-studio Worker bundled with esbuild, on a D1 look-alike (node:sqlite, every migration applied), with
 * "cloudflare:sockets" answered by a scripted SMTP and IMAP server. Covers the message (quoted-printable, headers, dot
 * stuffing), SMTP (implicit TLS and STARTTLS, a refused address, a refused password), IMAP (literals, multipart, quoted
 * text dropped, only new messages), who may be added (published business address, page, country), the sequence (business
 * hours where the business is, warm-up, the gap between e-mails, follow-ups in the same thread), the replies (interested
 * tells the owner and stops, "remove me" and bounces stop for good, out-of-office waits), the unsubscribe link, and the
 * console's routes.
 * Run: node --test test/studio-outreach.test.mjs
 */
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "cloudflare:email") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export class EmailMessage { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } }") };
  if (s === "cloudflare:sockets") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export function connect(a, o) { return globalThis.__kleoConnect(a, o); }") };
  return next(s, c);
}`));
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { base32Decode, hotp, stepAt } from "../src/studio/totp.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const te = new TextEncoder(), td = new TextDecoder();

class Stmt {
  constructor(db, sql) { this.stmt = db.prepare(sql); this.args = []; }
  bind(...a) { this.args = a.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)); return this; }
  async run() { const r = this.stmt.run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
  async first() { const r = this.stmt.get(...this.args); return r ? { ...r } : null; }
  async all() { return { results: this.stmt.all(...this.args).map((r) => ({ ...r })) }; }
}
class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(s.stmt.reader ? await s.all() : await s.run()); return out; }
}
class FakeR2 { async put() { return {}; } async get() { return null; } async delete() {} async list() { return { objects: [], truncated: false }; } }

let mxOk = true;
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://cloudflare-dns.com/dns-query")) return new Response(JSON.stringify(mxOk ? { Status: 0, Answer: [{ type: 15 }] } : { Status: 3 }), { headers: { "content-type": "application/dns-json" } });
    return real(url, init);
  };
}

// ── the scripted mail server ─────────────────────────────────────────────────────────────────────────────────────
/** One connection: the client's bytes are read as lines (or a DATA block); the server answers through push(). */
function fakeConn(server) {
  let push, closed = false;
  const readable = new ReadableStream({ start(c) { push = (s) => { if (!closed) c.enqueue(te.encode(s)); }; } });
  let buf = "";
  const writable = new WritableStream({ write(chunk) {
    buf += td.decode(chunk);
    for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) { const line = buf.slice(0, i); buf = buf.slice(i + 2); server.line(line, push); }
  } });
  queueMicrotask(() => server.open(push));
  const conn = { readable, writable, close() { closed = true; }, startTls() { server.tls = true; return fakeConn({ ...server, open() {} , line: server.line }); } };
  return conn;
}
const MB = {
  user: "leo@getkleo.test", pass: "abcdabcdabcdabcd", sent: [], refuseRcpt: new Set(), refuseAuth: false, connections: [],
  inbox: [], uidValidity: 7, lastSelect: null,
};
function smtpServer(port) {
  const st = { data: false, msg: [], from: null, to: null, tls: port === 465 };
  return {
    open(push) { push("220 smtp.getkleo.test ESMTP ready\r\n"); },
    line(l, push) {
      if (st.data) {
        if (l === ".") { st.data = false; MB.sent.push({ from: st.from, to: st.to, raw: st.msg.join("\r\n"), tls: st.tls }); st.msg = []; push("250 2.0.0 OK 1730 - gsmtp\r\n"); }
        else st.msg.push(l);
        return;
      }
      if (/^EHLO/.test(l)) push(`250-smtp.getkleo.test\r\n250-SIZE 35882577\r\n${st.tls ? "" : "250-STARTTLS\r\n"}250 AUTH PLAIN LOGIN\r\n`);
      else if (l === "STARTTLS") { st.tls = true; push("220 2.0.0 Ready to start TLS\r\n"); }
      else if (l.startsWith("AUTH PLAIN ")) {
        const [, u, p] = Buffer.from(l.slice(11), "base64").toString("utf8").split("\u0000");
        push(!MB.refuseAuth && u === MB.user && p === MB.pass ? "235 2.7.0 Accepted\r\n" : "535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 https://support.google.com/mail/?p=BadCredentials\r\n");
      } else if (l.startsWith("MAIL FROM:")) { st.from = l.slice(11, -1); push("250 2.1.0 OK\r\n"); }
      else if (l.startsWith("RCPT TO:")) { st.to = l.slice(9, -1); push(MB.refuseRcpt.has(st.to) ? "550-5.1.1 The email account that you tried to reach does not exist.\r\n550 5.1.1 gsmtp\r\n" : "250 2.1.5 OK\r\n"); }
      else if (l === "DATA") { st.data = true; push("354 Go ahead\r\n"); }
      else if (l === "QUIT") push("221 2.0.0 closing connection\r\n");
      else push("502 5.5.1 Unrecognized command.\r\n");
    },
  };
}
function imapServer() {
  return {
    open(push) { push("* OK Gimap ready\r\n"); },
    line(l, push) {
      const [tag, ...rest] = l.split(" ");
      const cmd = rest.join(" ");
      if (/^LOGIN /.test(cmd)) { push(MB.refuseAuth ? `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n` : `${tag} OK leo authenticated\r\n`); }
      else if (cmd === "SELECT INBOX") push(`* ${MB.inbox.length} EXISTS\r\n* OK [UIDVALIDITY ${MB.uidValidity}] UIDs valid.\r\n${tag} OK [READ-WRITE] INBOX selected.\r\n`);
      else if (/^UID SEARCH/.test(cmd)) {
        const after = Number(cmd.match(/UID (\d+):\*/)?.[1] ?? 1) - 1;
        // Like a real server, "n:*" also answers the newest message when nothing is newer.
        let uids = MB.inbox.map((m) => m.uid).filter((u) => u > after);
        if (!uids.length && /UID \d+:\*/.test(cmd) && MB.inbox.length) uids = [MB.inbox.at(-1).uid];
        push(`* SEARCH${uids.map((u) => ` ${u}`).join("")}\r\n${tag} OK SEARCH completed\r\n`);
      } else if (/^UID FETCH/.test(cmd)) {
        const want = cmd.match(/UID FETCH ([\d,]+)/)[1].split(",").map(Number);
        let out = "";
        MB.inbox.filter((m) => want.includes(m.uid)).forEach((m, i) => {
          const head = m.headers.join("\r\n") + "\r\n\r\n", body = m.body;
          out += `* ${i + 1} FETCH (UID ${m.uid} BODY[HEADER.FIELDS (FROM SUBJECT)] {${te.encode(head).length}}\r\n${head} BODY[TEXT]<0> {${te.encode(body).length}}\r\n${body})\r\n`;
        });
        push(`${out}${tag} OK Success\r\n`);
      } else if (cmd === "LOGOUT") push(`* BYE LOGOUT Requested\r\n${tag} OK 73 good day\r\n`);
      else push(`${tag} BAD Unknown command\r\n`);
    },
  };
}
globalThis.__kleoConnect = ({ hostname, port }) => {
  MB.connections.push(`${hostname}:${port}`);
  if (hostname === "smtp.getkleo.test") return fakeConn(smtpServer(port));
  if (hostname === "imap.getkleo.test") return fakeConn(imapServer());
  throw new Error(`no fake server for ${hostname}`);
};
beforeEach(() => { Object.assign(MB, { sent: [], refuseRcpt: new Set(), refuseAuth: false, connections: [], inbox: [], uidValidity: 7 }); mxOk = true; });

let worker, mod, box;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts";
      export * from "./src/studio/outreach.ts";
      export * as box from "./src/studio/mailbox.ts";
      export { morningDigest } from "./src/studio/digest.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk", "cloudflare:email", "cloudflare:sockets"],
  });
  mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
  worker = mod.default;
  box = mod.box;
});

const CERT_FP = "3f".repeat(32);
const GOOD_TLS = { certPresented: "1", certVerified: "SUCCESS", certRevoked: "0", certFingerprintSHA256: CERT_FP };
function newEnv(over = {}) {
  const env = {
    DB: new FakeD1(), RENDERS: new FakeR2(), ASSETS: { fetch: async () => new Response("<!doctype html>app", { headers: { "content-type": "text/html" } }) },
    INTERNAL_SECRET: "s3cret", PUBLIC_URL: "https://mcp.kleo.test", EPHONE_API_KEY: "ek", FREE_CREDITS: "5",
    MAX_NEW_USERS_PER_IP_DAY: "50", MAX_ACCOUNTS_PER_ADDRESS: "50", ADMIN_HOST: "admin.kleo.test", ADMIN_CERT_SHA256: CERT_FP,
    mails: [], OWNER_MAIL: { send: async (m) => { env.mails.push(m); } },
    AI: { calls: 0, answer: '{"class":"other","summary":"Said something."}', async run() { this.calls++; return { response: this.answer }; } },
    ...over,
  };
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) env.DB.db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return env;
}
const rows = (env, sql, ...a) => env.DB.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const one = (env, sql, ...a) => { const r = env.DB.db.prepare(sql).get(...a); return r ? { ...r } : r; };
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
async function call(env, path, { method = "GET", body, cookie, header = true, host, headers = {}, raw } = {}) {
  const admin = host === "admin" || (host === undefined && /^\/(?:api\/)?admin(?:\/|$)/.test(path));
  const h = { "user-agent": "Mozilla/5.0 Safari/604.1", ...headers };
  if (header) h["x-kleo"] = "1";
  if (cookie) h.cookie = cookie;
  if (body !== undefined && raw === undefined) h["content-type"] = "application/json";
  const req = new Request(`https://${admin ? "admin" : "app"}.kleo.test${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
  if (admin) Object.defineProperty(req, "cf", { value: { tlsClientAuth: GOOD_TLS } });
  const res = await worker.fetch(req, env, ctx);
  await Promise.allSettled(pending.splice(0));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, res };
}
const cookiesOf = (res) => res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""].filter(Boolean);
async function setupAdmin(env) {
  const r = await call(env, "/api/auth/signup", { method: "POST", body: { email: "owner@example.com", password: "long enough pw" } });
  const cookie = cookiesOf(r.res).find((c) => c.startsWith("__Host-kleo_studio="))?.split(";")[0];
  const me = await call(env, "/api/me", { cookie });
  env.STUDIO_ADMINS = me.json.id;
  const e = await call(env, "/api/admin/auth/enroll", { method: "POST", cookie, body: { password: "long enough pw" } });
  const secret = base32Decode(e.json.secret);
  const c = await call(env, "/api/admin/auth/enroll/confirm", { method: "POST", cookie, body: { code: await hotp(secret, stepAt(Date.now()) - 1) } });
  return { admin: `${cookie}; ${cookiesOf(c.res).find((x) => x.startsWith("__Host-kleo_admin="))?.split(";")[0]}`, code: () => hotp(secret, stepAt(Date.now())) };
}

const SENDER = { fromName: "Leonardo", fromAddr: "leo@getkleo.test", user: "leo@getkleo.test", smtpHost: "smtp.getkleo.test", smtpPort: 465, imapHost: "imap.getkleo.test", imapPort: 993, postal: "PO Box 123, Auckland 1010, New Zealand", dailyMax: 40 };
function configure(env, over = {}) {
  env.OUTREACH_SMTP_PASS = MB.pass;
  env.DB.db.prepare("INSERT OR REPLACE INTO studio_meta (key, value) VALUES ('outreach_sender', ?)").run(JSON.stringify({ ...SENDER, ...over }));
  env.DB.db.prepare("INSERT OR REPLACE INTO studio_meta (key, value) VALUES ('outreach_mode', 'on')").run();
}
const P = (over = {}) => ({ company: "Bright Reels", website: "https://brightreels.example", email: "hello@brightreels.example", email_source_url: "https://brightreels.example/contact",
  country: "US", state: "NY", city: "Brooklyn", type: "social-media-agency", contact_first_name: "Maya", opener: "Saw that you run TikTok for three Brooklyn coffee roasters.", ...over });
async function addApproved(env, list) {
  const r = await mod.addProspects(env, list, "test");
  env.DB.db.prepare("UPDATE outreach_prospects SET status = 'approved', approved_at = '2026-10-01T00:00:00.000Z' WHERE status = 'new'").run();
  return r;
}
/** Monday 2 November 2026, 10:30 in New York (EST). */
const MON = Date.parse("2026-11-02T15:30:00.000Z");
const MIN = 60_000, HOUR = 3_600_000, DAY = 24 * HOUR;
const qpDecode = (s) => Buffer.from(s.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
const bodyOf = (raw) => qpDecode(raw.slice(raw.indexOf("\r\n\r\n") + 4));
const header = (raw, name) => raw.split("\r\n").find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim() ?? null;

// ── the message ──────────────────────────────────────────────────────────────────────────────────────────────────

test("message: quoted-printable lines stay under 77 characters, non-ASCII and '=' are encoded, headers are right", () => {
  const long = "Ciao Chloé = ok " + "word ".repeat(40) + "end ";
  const qp = box.quotedPrintable(long + "\n.second line starts with a dot");
  assert.ok(qp.split("\r\n").every((l) => l.length <= 76), qp);
  assert.match(qp, /Chlo=C3=A9 =3D ok/);
  assert.match(qp, /d=20\r\n\.second/, "a trailing space is encoded");
  assert.equal(qpDecode(qp).replace(/\r\n/g, "\n"), long + "\n.second line starts with a dot");
  const raw = box.buildMime({ fromName: "Léo", fromAddr: "leo@getkleo.test", to: "a@b.example", subject: "Vidéo for you", text: "Hi", messageId: "<x@getkleo.test>",
    inReplyTo: "<a@getkleo.test>", references: ["<a@getkleo.test>"], unsubscribeUrl: "https://app.kleooai.com/email/out?p=p_x&s=y", unsubscribeMailto: "leo@getkleo.test", date: new Date(MON) });
  assert.match(header(raw, "From"), /^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <leo@getkleo\.test>$/);
  assert.match(header(raw, "Subject"), /^=\?utf-8\?B\?/);
  assert.equal(box.decodeWords(header(raw, "Subject")), "Vidéo for you");
  assert.equal(header(raw, "In-Reply-To"), "<a@getkleo.test>");
  assert.equal(header(raw, "List-Unsubscribe-Post"), "List-Unsubscribe=One-Click");
  assert.equal(header(raw, "Content-Transfer-Encoding"), "quoted-printable");
  assert.match(header(raw, "Date"), /^Mon, 02 Nov 2026 15:30:00 \+0000$/);
});

test("readable text: the plain part of a multipart reply, decoded, without the quoted earlier e-mail", () => {
  const body = "--b1\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nYes please, sounds gre=\r\nat =E2=80=94 send it over.\r\n\r\nOn Mon, 2 Nov 2026 at 10:30, Leonardo <leo@getkleo.test> wrote:\r\n> Hi Maya,\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>Yes</p>\r\n--b1--";
  assert.equal(box.readableText('multipart/alternative; boundary="b1"', "", body), "Yes please, sounds great — send it over.");
  assert.equal(box.readableText("text/html", "", "<p>Hi<br>there &amp; you</p>"), "Hi\nthere & you");
});

// ── SMTP and IMAP ────────────────────────────────────────────────────────────────────────────────────────────────

test("SMTP: implicit TLS and STARTTLS both deliver, dot-stuffed; a refused address and a refused password say which", async () => {
  const raw = box.buildMime({ fromName: "Leonardo", fromAddr: MB.user, to: "x@y.example", subject: "Hi", text: "line one\n.starts with a dot", messageId: "<m1@getkleo.test>" });
  await box.smtpSend(box.socketDial, { host: "smtp.getkleo.test", port: 465, user: MB.user, pass: MB.pass }, { from: MB.user, to: "x@y.example", raw });
  await box.smtpSend(box.socketDial, { host: "smtp.getkleo.test", port: 587, user: MB.user, pass: MB.pass }, { from: MB.user, to: "x@y.example", raw });
  assert.equal(MB.sent.length, 2);
  assert.ok(MB.sent.every((m) => m.tls), "never in the clear");
  assert.match(MB.sent[0].raw, /\r\n\.\.starts with a dot/);
  MB.refuseRcpt.add("nobody@y.example");
  await assert.rejects(box.smtpSend(box.socketDial, { host: "smtp.getkleo.test", port: 465, user: MB.user, pass: MB.pass }, { from: MB.user, to: "nobody@y.example", raw }),
    (e) => box.smtpTrouble(e) === "address" && /550/.test(e.message));
  await assert.rejects(box.smtpSend(box.socketDial, { host: "smtp.getkleo.test", port: 465, user: MB.user, pass: "wrong" }), (e) => box.smtpTrouble(e) === "sender" && /535/.test(e.message));
});

test("IMAP: only the messages after the last one read, literals in UTF-8, headers decoded", async () => {
  MB.inbox = [
    { uid: 5, headers: ["From: Maya Lee <maya@brightreels.example>", "Subject: =?UTF-8?Q?Re:_Short-form_video_=E2=80=94_Bright_Reels?=", "Message-ID: <r1@brightreels.example>", "In-Reply-To: <m1@getkleo.test>", "Content-Type: text/plain; charset=utf-8"], body: "Interessante — how much is it?\r\n" },
    { uid: 6, headers: ["From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Subject: Delivery Status Notification (Failure)", "X-Failed-Recipients: gone@old.example"], body: "Address not found\r\n" },
  ];
  const cfg = { host: "imap.getkleo.test", port: 993, user: MB.user, pass: MB.pass };
  const a = await box.imapFetch(box.socketDial, cfg, { uidValidity: null, afterUid: 0, days: 14 }, new Date(MON));
  assert.equal(a.uidValidity, 7);
  assert.equal(a.lastUid, 6);
  assert.equal(a.messages.length, 2);
  assert.equal(a.messages[0].from, "maya@brightreels.example");
  assert.equal(a.messages[0].subject, "Re: Short-form video — Bright Reels");
  assert.equal(a.messages[0].inReplyTo, "<m1@getkleo.test>");
  assert.equal(a.messages[0].text, "Interessante — how much is it?");
  assert.deepEqual(a.messages[1].failedRecipients, ["gone@old.example"]);
  const b = await box.imapFetch(box.socketDial, cfg, { uidValidity: 7, afterUid: 6, days: 14 }, new Date(MON));
  assert.equal(b.messages.length, 0, "the newest one again is not new");
  assert.equal(b.lastUid, 6);
});

// ── who may be added ─────────────────────────────────────────────────────────────────────────────────────────────

test("prospects: a business address seen on its own site, in US, CA, GB, AU or NZ; nothing else gets in", async () => {
  const env = newEnv();
  env.DB.db.prepare("INSERT INTO mail_suppress (email, reason, source) VALUES ('no@said.example', 'unsubscribe', 'onboarding')").run();
  const r = await mod.addProspects(env, [
    P(), P({ email: "maya@gmail.com" }), P({ email: "x@nopage.example", email_source_url: "" }), P({ email: "x@de.example", country: "DE" }),
    P({ email: "no@said.example" }), P({ email: "HELLO@brightreels.example" }), P({ email: "studio@north.example", country: "gb", state: "", company: "North UGC" }),
  ], "t");
  assert.equal(r.added, 2);
  assert.deepEqual(r.skipped.map((s) => s.why), ["a free mailbox, not a business address", "no https page where the address is published", "country not in US, CA, GB, AU, NZ", "said no before", "already in the list"]);
  const p = one(env, "SELECT * FROM outreach_prospects WHERE email = 'hello@brightreels.example'");
  assert.equal(p.status, "new");
  assert.equal(p.tz, "America/New_York");
  assert.equal(one(env, "SELECT tz FROM outreach_prospects WHERE company = 'North UGC'").tz, "Europe/London");
  assert.deepEqual(mod.parseCsv('company,email,source_url\n"Acme, Inc",a@acme.example,https://acme.example/contact\n'), [{ company: "Acme, Inc", email: "a@acme.example", source_url: "https://acme.example/contact" }]);
});

// ── the sequence ─────────────────────────────────────────────────────────────────────────────────────────────────

test("first e-mail: in New York's working hours, from the mailbox, personal, the law's footer, then a gap before the next", async () => {
  const env = newEnv();
  configure(env);
  await addApproved(env, [P(), P({ email: "hi@second.example", company: "Second Studio", contact_first_name: "" })]);
  // Saturday, and a weekday at 7:00 there: nothing.
  assert.equal((await mod.outreachTick(env, MON - 2 * DAY, { random: () => 0.5 })).sent, 0);
  assert.equal((await mod.outreachTick(env, MON - 3.5 * HOUR, { random: () => 0.5 })).sent, 0);
  const t = await mod.outreachTick(env, MON, { random: () => 0.5 });
  assert.equal(t.sent, 1);
  const m = MB.sent[0];
  assert.equal(m.from, "leo@getkleo.test");
  assert.equal(m.to, "hello@brightreels.example");
  const text = bodyOf(m.raw);
  assert.match(header(m.raw, "Subject"), /^Short-form video for Bright Reels$/);
  assert.match(text, /^Hi Maya,\r?\n\r?\nSaw that you run TikTok for three Brooklyn coffee roasters\./);
  assert.match(text, /free credits to try it on a real brief\?/);
  assert.match(text, /hello@brightreels\.example is listed on brightreels\.example/);
  assert.match(text, /Kleo \(Kanaky Tech, New Zealand\), PO Box 123, Auckland 1010, New Zealand/);
  assert.match(header(m.raw, "List-Unsubscribe"), /^<https:\/\/app\.kleooai\.com\/email\/out\?p=p_[a-z0-9]+&s=[0-9a-f]{32}>, <mailto:leo@getkleo\.test\?subject=unsubscribe>$/);
  assert.doesNotMatch(m.raw, /<img|<html|utm_/i, "plain text, no tracking");
  const p = one(env, "SELECT * FROM outreach_prospects WHERE email = 'hello@brightreels.example'");
  assert.equal(p.status, "active");
  assert.equal(p.step, 1);
  assert.equal(p.thread_id, header(m.raw, "Message-ID"));
  // The follow-up: three working days later (Thursday), between 9:30 and 15:30 in New York.
  const next = new Date(p.next_at);
  const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false }).formatToParts(next);
  assert.equal(ny.find((x) => x.type === "weekday").value, "Thu");
  assert.ok(Number(ny.find((x) => x.type === "hour").value) >= 9 && Number(ny.find((x) => x.type === "hour").value) <= 15);
  // Five minutes later: still inside the 7–14 minute gap.
  assert.equal((await mod.outreachTick(env, MON + 5 * MIN, { random: () => 0.5 })).sent, 0);
  // Fifteen minutes later the second business, "Hi there" without a name.
  assert.equal((await mod.outreachTick(env, MON + 15 * MIN, { random: () => 0.5 })).sent, 1);
  assert.match(bodyOf(MB.sent[1].raw), /^Hi there,/);
});

test("warm-up: five e-mails in the first 24 hours, however many are approved", async () => {
  const env = newEnv();
  configure(env);
  await addApproved(env, Array.from({ length: 9 }, (_, i) => P({ email: `team@studio${i}.example`, company: `Studio ${i}` })));
  for (let t = 0; t < 6 * HOUR; t += 15 * MIN) await mod.outreachTick(env, MON + t, { random: () => 0.5 });
  assert.equal(MB.sent.length, 5);
  assert.equal(mod.warmupQuota(1, 40), 5);
  assert.equal(mod.warmupQuota(10, 40), 15);
  assert.equal(mod.warmupQuota(30, 40), 40);
  assert.equal(mod.warmupQuota(30, 20), 20);
});

test("follow-ups: in the same thread, Re: subject, then the last one, then done", async () => {
  const env = newEnv();
  configure(env);
  await addApproved(env, [P()]);
  await mod.outreachTick(env, MON, { random: () => 0 });
  const first = header(MB.sent[0].raw, "Message-ID");
  const p1 = one(env, "SELECT next_at FROM outreach_prospects");
  await mod.outreachTick(env, Date.parse(p1.next_at) + MIN, { random: () => 0 });
  assert.equal(MB.sent.length, 2);
  assert.equal(header(MB.sent[1].raw, "Subject"), "Re: Short-form video for Bright Reels");
  assert.equal(header(MB.sent[1].raw, "In-Reply-To"), first);
  assert.match(bodyOf(MB.sent[1].raw), /app\.kleooai\.com\/explore/);
  const p2 = one(env, "SELECT next_at FROM outreach_prospects");
  await mod.outreachTick(env, Date.parse(p2.next_at) + MIN, { random: () => 0 });
  assert.equal(MB.sent.length, 3);
  assert.match(bodyOf(MB.sent[2].raw), /I'll stop here/);
  assert.deepEqual(one(env, "SELECT status, step, next_at FROM outreach_prospects"), { status: "done", step: 3, next_at: null });
});

// ── the replies ──────────────────────────────────────────────────────────────────────────────────────────────────

test("replies: interested stops the sequence and tells the owner; 'remove me' and a bounce stop for good; out-of-office waits", async () => {
  const env = newEnv();
  configure(env);
  await addApproved(env, [P(), P({ email: "hi@two.example", company: "Two" }), P({ email: "hi@three.example", company: "Three" }), P({ email: "hi@four.example", company: "Four" })]);
  for (let t = 0; t < 2 * HOUR; t += 15 * MIN) await mod.outreachTick(env, MON + t, { random: () => 0 });
  assert.equal(MB.sent.length, 4);
  const mid = (to) => header(MB.sent.find((m) => m.to === to).raw, "Message-ID");
  env.AI.answer = '```json\n{"class": "question", "summary": "Asks what the Agency plan costs."}\n```';
  MB.inbox = [
    { uid: 11, headers: ["From: Maya <maya@brightreels.example>", "Subject: Re: Short-form video for Bright Reels", `In-Reply-To: ${mid("hello@brightreels.example")}`], body: "Hi Leonardo, what does the agency plan cost?\r\n" },
    { uid: 12, headers: ["From: hi@two.example", "Subject: Re: Short-form video for Two"], body: "Please remove me from your list.\r\n" },
    { uid: 13, headers: ["From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Subject: Delivery Status Notification (Failure)", "X-Failed-Recipients: hi@three.example"], body: "Your message wasn't delivered to hi@three.example\r\n" },
    { uid: 14, headers: ["From: hi@four.example", "Subject: Automatic reply: Short-form video for Four", "Auto-Submitted: auto-replied"], body: "I'm away until Monday.\r\n" },
    { uid: 15, headers: ["From: someone@unrelated.example", "Subject: Hello"], body: "Not about Kleo.\r\n" },
  ];
  await mod.outreachTick(env, MON + 2 * HOUR + 15 * MIN, { random: () => 0 });
  const st = Object.fromEntries(rows(env, "SELECT email, status, reply_class FROM outreach_prospects").map((r) => [r.email, r]));
  assert.equal(st["hello@brightreels.example"].status, "replied");
  assert.equal(st["hello@brightreels.example"].reply_class, "question");
  assert.equal(st["hi@two.example"].status, "stopped");
  assert.equal(st["hi@three.example"].status, "bounced");
  assert.equal(st["hi@four.example"].status, "active");
  assert.ok(Date.parse(one(env, "SELECT next_at FROM outreach_prospects WHERE email = 'hi@four.example'").next_at) >= MON + 7 * DAY);
  assert.deepEqual(rows(env, "SELECT email, reason FROM mail_suppress ORDER BY email"), [{ email: "hi@three.example", reason: "bounce" }, { email: "hi@two.example", reason: "unsubscribe" }]);
  assert.equal(env.AI.calls, 1, "the rules decide the obvious ones; Workers AI only the real answer");
  assert.equal(env.mails.length, 1);
  assert.match(env.mails[0].raw, /Bright Reels replied \(question\)/);
  assert.match(env.mails[0].raw, /Asks what the Agency plan costs\./);
  assert.equal(rows(env, "SELECT * FROM outreach_replies").length, 4, "the unrelated e-mail is ignored");
  // Read again later: nothing is handled twice, and nobody who answered gets a follow-up.
  await mod.outreachTick(env, MON + 2 * HOUR + 30 * MIN, { random: () => 0 });
  assert.equal(rows(env, "SELECT * FROM outreach_replies").length, 4);
  for (let t = 3 * DAY; t < 4 * DAY; t += 15 * MIN) await mod.outreachTick(env, MON + t, { random: () => 0 });
  assert.deepEqual(MB.sent.slice(4).map((m) => m.to), [], "no follow-up to anyone who answered, bounced or is away");
});

test("refusals: a dead address is bounced and suppressed; a refused password pauses outreach and tells the owner once", async () => {
  const env = newEnv();
  configure(env);
  await addApproved(env, [P({ email: "gone@dead.example", company: "Dead" }), P()]);
  MB.refuseRcpt.add("gone@dead.example");
  await mod.outreachTick(env, MON, { random: () => 0 });
  assert.equal(one(env, "SELECT status FROM outreach_prospects WHERE email = 'gone@dead.example'").status, "bounced");
  assert.equal(one(env, "SELECT reason FROM mail_suppress WHERE email = 'gone@dead.example'").reason, "bounce");
  MB.refuseAuth = true;
  const t = await mod.outreachTick(env, MON + 15 * MIN, { random: () => 0 });
  assert.equal(t.paused, "sender");
  assert.equal(env.mails.length, 1);
  assert.match(env.mails[0].raw, /paused/);
  assert.equal((await mod.outreachTick(env, MON + 30 * MIN, { random: () => 0 })).paused, "sender");
  assert.equal(env.mails.length, 1, "once");
  assert.equal(one(env, "SELECT status FROM outreach_prospects WHERE email = 'hello@brightreels.example'").status, "approved", "nobody is lost");
  // No mail server at all: never written to.
  mxOk = false;
  MB.refuseAuth = false;
  env.DB.db.prepare("DELETE FROM studio_meta WHERE key IN ('outreach_paused', 'outreach_paused_at')").run();
  await mod.outreachTick(env, MON + 45 * MIN, { random: () => 0 });
  assert.equal(one(env, "SELECT status FROM outreach_prospects WHERE email = 'hello@brightreels.example'").status, "invalid");
});

test("off, or not set up: nothing is read or sent", async () => {
  const env = newEnv();
  await addApproved(env, [P()]);
  assert.deepEqual(await mod.outreachTick(env, MON), { sent: 0, replies: 0 });
  env.DB.db.prepare("INSERT INTO studio_meta (key, value) VALUES ('outreach_mode', 'on')").run();
  assert.equal((await mod.outreachTick(env, MON)).paused, "setup");
  assert.equal(MB.connections.length, 0);
});

// ── the unsubscribe link and the console ─────────────────────────────────────────────────────────────────────────

test("unsubscribe: GET asks, POST (or the mail client's one click) stops it and suppresses the address", async () => {
  const env = newEnv();
  configure(env);
  await addApproved(env, [P()]);
  await mod.outreachTick(env, MON, { random: () => 0 });
  const link = header(MB.sent[0].raw, "List-Unsubscribe").match(/<(https:[^>]+)>/)[1].replace("https://app.kleooai.com", "");
  const look = await call(env, link, { header: false });
  assert.equal(look.status, 200);
  assert.equal(one(env, "SELECT status FROM outreach_prospects").status, "active");
  assert.equal((await call(env, link.replace(/s=[0-9a-f]+/, "s=" + "1".repeat(32)), { method: "POST", header: false, raw: "List-Unsubscribe=One-Click" })).status, 400);
  const r = await call(env, link, { method: "POST", header: false, raw: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(r.status, 200);
  assert.equal(one(env, "SELECT status, stop_reason FROM outreach_prospects").stop_reason, "unsubscribe");
  assert.equal(one(env, "SELECT reason FROM mail_suppress").reason, "unsubscribe");
});

test("console: overview, the sender saved only after both sign-ins, approvals, preview, import, and the switch's checks", async () => {
  const env = newEnv();
  const o = await setupAdmin(env);
  await mod.addProspects(env, [P(), P({ email: "hi@two.example", company: "Two" })], "research");
  let r = await call(env, "/api/admin/outreach", { cookie: o.admin });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.ready, { sender: false, password: false, postal: false, approved: 0, ok: false });
  r = await call(env, "/api/admin/outreach/mode", { method: "POST", cookie: o.admin, body: { on: true, code: await o.code() } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "not_ready");
  // A Gmail or kleooai.com sender is refused; a wrong password saves nothing.
  r = await call(env, "/api/admin/outreach/sender", { method: "POST", cookie: o.admin, body: { ...SENDER, fromAddr: "kleooai@gmail.com", password: MB.pass, code: await o.code() } });
  assert.equal(r.json.code, "from_domain");
  r = await call(env, "/api/admin/outreach/sender", { method: "POST", cookie: o.admin, body: { ...SENDER, password: "wrongwrongwrong1" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "smtp");
  assert.equal(one(env, "SELECT value FROM studio_meta WHERE key = 'outreach_sender'"), undefined);
  r = await call(env, "/api/admin/outreach/sender", { method: "POST", cookie: o.admin, body: { ...SENDER, password: "abcd abcd abcd abcd" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.tested, true);
  const sealed = one(env, "SELECT sealed, last4 FROM key_overrides WHERE name = 'OUTREACH_SMTP_PASS'");
  assert.equal(sealed.last4, "abcd");
  assert.doesNotMatch(sealed.sealed, /abcd/);
  r = await call(env, "/api/admin/outreach", { cookie: o.admin });
  assert.deepEqual(r.json.ready, { sender: true, password: true, postal: true, approved: 0, ok: false });
  assert.equal(r.json.sender.passwordEnds, "abcd");
  assert.ok(!JSON.stringify(r.json).includes(MB.pass), "the password never comes back");
  const list = await call(env, "/api/admin/outreach/prospects?status=new", { cookie: o.admin });
  assert.equal(list.json.prospects.length, 2);
  const pv = await call(env, `/api/admin/outreach/preview?id=${list.json.prospects[0].id}`, { cookie: o.admin });
  assert.equal(pv.json.steps.length, 3);
  assert.match(pv.json.steps[0].text, /PO Box 123/);
  r = await call(env, `/api/admin/outreach/prospects/${list.json.prospects[0].id}`, { method: "POST", cookie: o.admin, body: { action: "reject" } });
  assert.equal(r.status, 200);
  r = await call(env, "/api/admin/outreach/approve-new", { method: "POST", cookie: o.admin, body: {} });
  assert.equal(r.json.approved, 1);
  r = await call(env, "/api/admin/outreach/import", { method: "POST", cookie: o.admin, body: { csv: "company,email,source_url,country\nAcme,team@acme.example,https://acme.example/contact,AU\nBad,bad@gmail.com,https://x.example,AU\n" } });
  assert.equal(r.json.added, 1);
  assert.equal(r.json.skipped.length, 1);
  r = await call(env, "/api/admin/outreach/test", { method: "POST", cookie: o.admin, body: {} });
  assert.equal(r.status, 200, r.text);
  assert.equal(MB.sent.at(-1).to, "leo@getkleo.test");
  r = await call(env, "/api/admin/outreach/mode", { method: "POST", cookie: o.admin, body: { on: true, code: await o.code() } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await call(env, "/api/admin/outreach", { cookie: o.admin })).json.on, true);
});

test("morning e-mail: at 8:00 in Auckland, once a day, only while something is on, with the interested replies by name", async () => {
  const env = newEnv();
  configure(env);
  await addApproved(env, [P(), P({ email: "hi@two.example", company: "Two" })]);
  for (let t = 0; t < HOUR; t += 15 * MIN) await mod.outreachTick(env, MON + t, { random: () => 0 });
  env.AI.answer = '{"class":"interested","summary":"Wants a trial for the team."}';
  MB.inbox = [{ uid: 21, headers: ["From: maya@brightreels.example", "Subject: Re: Short-form video for Bright Reels", `In-Reply-To: ${header(MB.sent[0].raw, "Message-ID")}`], body: "Yes, we'd like to try it with the team next week.\r\n" }];
  await mod.outreachTick(env, MON + HOUR + 15 * MIN, { random: () => 0 });
  env.mails.length = 0;
  // Tuesday 3 November 2026, 8:10 in Auckland (NZDT, UTC+13) = Monday 19:10 UTC.
  const eight = Date.parse("2026-11-02T19:10:00.000Z");
  assert.equal(await mod.morningDigest(env, eight - HOUR), false, "7:10 is not 8");
  assert.equal(await mod.morningDigest(env, eight), true);
  assert.equal(await mod.morningDigest(env, eight + 20 * MIN), false, "once a day");
  assert.equal(env.mails.length, 1);
  const raw = env.mails[0].raw;
  assert.match(raw, /Subject: Kleo e-mails, 2026-11-03/);
  assert.match(raw, /Sent in the last 24 hours: 2 \(2 first e-mails, 0 follow-ups\)/);
  assert.match(raw, /Bright Reels \(interested\): Wants a trial for the team\./);
  assert.doesNotMatch(raw, /WELCOME E-MAILS/, "the welcome e-mails are off");
  env.DB.db.prepare("UPDATE studio_meta SET value = 'off' WHERE key = 'outreach_mode'").run();
  assert.equal(await mod.morningDigest(env, eight + DAY), false, "nothing on, nothing sent");
});
