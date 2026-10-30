/**
 * Kleo's outreach e-mails (src/studio/outreach.ts, src/studio/mailbox.ts, the admin console's Outreach page), inside one
 * process: the kleo-studio Worker bundled with esbuild, on a D1 look-alike (node:sqlite, every migration applied), with
 * "cloudflare:sockets" answered by a scripted SMTP and IMAP server. Covers the message (quoted-printable, headers, dot
 * stuffing), SMTP (implicit TLS and STARTTLS, a refused address, a refused password), IMAP (literals, multipart, quoted
 * text dropped, only new messages), who may be added (published business address, page, country), the sequence (business
 * hours where the business is, warm-up, the gap between e-mails, follow-ups in the same thread), the replies (interested
 * tells the owner and stops, "remove me" and bounces stop for good, out-of-office waits), several mailboxes, Kleo's own
 * answer to a yes and the trial credits of a sign-up through the personal link, the versions of the first e-mail, the
 * scout (search, visible address, refusals, Workers AI's verdict, country), the unsubscribe link, and the console's routes.
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
import { FakeD1 } from "./fake-d1.mjs";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { base32Decode, hotp, stepAt } from "../src/studio/totp.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const te = new TextEncoder(), td = new TextDecoder();

// The D1 stand-in is test/fake-d1.mjs: meta.changes as D1 counts it, the rows a trigger changes included.
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
  accounts: { "leo@getkleo.test": "abcdabcdabcdabcd", "kim@getkleo2.test": "zyxwzyxwzyxwzyxw" },
  inbox: [], uidValidity: 7, lastSelect: null,
};
function smtpServer(port) {
  const st = { data: false, msg: [], from: null, to: null, tls: port === 465 };
  return {
    open(push) { push("220 smtp.getkleo.test ESMTP ready\r\n"); },
    line(l, push) {
      if (st.data) {
        if (l === ".") { st.data = false; MB.sent.push({ from: st.from, to: st.to, raw: st.msg.join("\r\n"), tls: st.tls, user: st.user }); st.msg = []; push("250 2.0.0 OK 1730 - gsmtp\r\n"); }
        else st.msg.push(l);
        return;
      }
      if (/^EHLO/.test(l)) push(`250-smtp.getkleo.test\r\n250-SIZE 35882577\r\n${st.tls ? "" : "250-STARTTLS\r\n"}250 AUTH PLAIN LOGIN\r\n`);
      else if (l === "STARTTLS") { st.tls = true; push("220 2.0.0 Ready to start TLS\r\n"); }
      else if (l.startsWith("AUTH PLAIN ")) {
        const [, u, p] = Buffer.from(l.slice(11), "base64").toString("utf8").split("\u0000");
        st.user = u;
        push(!MB.refuseAuth && MB.accounts[u] === p ? "235 2.7.0 Accepted\r\n" : "535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 https://support.google.com/mail/?p=BadCredentials\r\n");
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
  if (hostname.startsWith("smtp.")) return fakeConn(smtpServer(port));
  if (hostname.startsWith("imap.")) return fakeConn(imapServer());
  throw new Error(`no fake server for ${hostname}`);
};
beforeEach(() => { Object.assign(MB, { sent: [], refuseRcpt: new Set(), refuseAuth: false, connections: [], inbox: [], uidValidity: 7 }); mxOk = true; });

let worker, mod, box;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export { default } from "./src/studio/index.ts";
      export * from "./src/studio/outreach.ts";
      export * as box from "./src/studio/mailbox.ts";
      export { morningDigest } from "./src/studio/digest.ts";
      export * from "./src/studio/scout.ts";`, resolveDir: ROOT, loader: "ts" },
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
    // Workers AI, faked per job: sorting a reply, writing an opener, judging a website for the scout.
    AI: { calls: 0, answer: '{"class":"other","summary":"Said something."}', verdict: null, opener: "Saw the restaurant reels on your work page.",
      async run(_m, input) {
        this.calls++;
        const sys = String(input?.messages?.[0]?.content ?? "");
        if (/You qualify businesses/.test(sys)) return { response: JSON.stringify(this.verdict ?? { fit: true, company: "Scouted Studio", type: "ugc-agency", size: "2-10", country: "US", region: "TX", city: "Austin", reason: "Makes UGC ads for brands.", opener: "Saw the UGC ads for skincare brands on your work page." }) };
        if (/Write the first line/.test(sys)) return { response: this.opener };
        return { response: this.answer };
      } },
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

const SENDER = { fromName: "Leonardo", fromAddr: "leo@getkleo.test", user: "leo@getkleo.test", smtpHost: "smtp.getkleo.test", smtpPort: 465, imapHost: "imap.getkleo.test", imapPort: 993, dailyMax: 40 };
const SENDER2 = { fromName: "Leonardo", fromAddr: "kim@getkleo2.test", user: "kim@getkleo2.test", smtpHost: "smtp.getkleo2.test", smtpPort: 465, imapHost: "imap.getkleo2.test", imapPort: 993, dailyMax: 40, password: "zyxwzyxwzyxwzyxw" };
const POSTAL = "PO Box 123, Auckland 1010, New Zealand";
/** One mailbox (or the ones given), the postal address and the switch on, the way the console sets them. */
async function configure(env, { boxes = [{ ...SENDER, password: MB.pass }], settings = {} } = {}) {
  for (const b of boxes) await mod.saveSender(env, "u_owner", b);
  await mod.saveSettings(env, "u_owner", { postal: POSTAL, ...settings });
  env.DB.db.prepare("INSERT OR REPLACE INTO studio_meta (key, value) VALUES ('outreach_mode', 'on')").run();
  MB.sent.length = 0; MB.connections.length = 0;
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
/** The plain-text part (the whole body of a plain e-mail), and the HTML part of a multipart one. */
const partOf = (raw, type) => {
  const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
  const b = /boundary="([^"]+)"/.exec(raw.slice(0, raw.indexOf("\r\n\r\n")))?.[1];
  if (!b) return type === "text/plain" ? qpDecode(body) : null;
  const part = body.split(`--${b}`).find((x) => x.includes(`Content-Type: ${type}`));
  return part ? qpDecode(part.slice(part.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "")) : null;
};
const bodyOf = (raw) => partOf(raw, "text/plain");
const htmlOf = (raw) => partOf(raw, "text/html");
/** What a reader sees of the HTML: the words, not the addresses behind them. */
const visible = (html) => html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
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
  await configure(env);
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
  assert.match(header(m.raw, "Subject"), /^10 hooks for Bright Reels' next client$/);
  assert.match(text, /^Hi Maya,\r?\n\r?\nSaw that you run TikTok for three Brooklyn coffee roasters\.\r?\n\r?\nThat's the kind of work Kleo/);
  assert.match(text, /ten hooks to test, before anyone books a shoot/);
  assert.match(text, /free credits to try it on a real brief this week\?/);
  assert.doesNotMatch(text, /face swap|outfit swap|https:\/\/app\.kleooai\.com\/r\//i, "one hook, no list of features, no sign-up link in the first");
  assert.match(text, /hello@brightreels\.example is listed on brightreels\.example/);
  assert.match(text, /Kleo, PO Box 123, Auckland 1010, New Zealand · kleooai\.com/);
  // The HTML twin: the same words, the addresses behind them ("Kleo" links to kleooai.com, "unsubscribe here" to the stop page).
  assert.match(header(m.raw, "Content-Type"), /^multipart\/alternative; boundary="kleo-[A-Za-z0-9]+"$/);
  const html = htmlOf(m.raw);
  assert.match(html, /<a href="https:\/\/kleooai\.com"[^>]*>Kleo<\/a>/);
  assert.match(html, /<a href="https:\/\/app\.kleooai\.com\/email\/out\?p=p_[a-z0-9]+&amp;s=[0-9a-f]{32}"[^>]*>unsubscribe here<\/a>/);
  assert.doesNotMatch(visible(html), /app\.kleooai\.com|https?:/, "no bare address to read");
  assert.match(visible(html), /Saw that you run TikTok for three Brooklyn coffee roasters\./);
  assert.doesNotMatch(html, /<img|utm_/i);
  assert.match(header(m.raw, "List-Unsubscribe"), /^<https:\/\/app\.kleooai\.com\/email\/out\?p=p_[a-z0-9]+&s=[0-9a-f]{32}>, <mailto:leo@getkleo\.test\?subject=unsubscribe>$/);
  assert.doesNotMatch(m.raw, /<img|utm_/i, "no images, no tracking");
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
  // Fifteen minutes later the second business, "Hi Second Studio team" without a name.
  assert.equal((await mod.outreachTick(env, MON + 15 * MIN, { random: () => 0.5 })).sent, 1);
  assert.match(bodyOf(MB.sent[1].raw), /^Hi Second Studio team,/);
  // The legal ending is not part of the name a person says.
  assert.deepEqual(["2MAG LTD", "Acme Pty Ltd", "Bright Reels", "Studio Limited", "Loop, LLC", "Ltd Films"].map((company) => mod.nameOf({ company })),
    ["2MAG", "Acme", "Bright Reels", "Studio", "Loop", "Ltd Films"]);
});

test("warm-up: five e-mails in the first 24 hours, however many are approved", async () => {
  const env = newEnv();
  await configure(env);
  await addApproved(env, Array.from({ length: 9 }, (_, i) => P({ email: `team@studio${i}.example`, company: `Studio ${i}` })));
  for (let t = 0; t < 6 * HOUR; t += 15 * MIN) await mod.outreachTick(env, MON + t, { random: () => 0.5 });
  assert.equal(MB.sent.length, 5);
  assert.equal(mod.warmupQuota(1, 40), 5);
  assert.equal(mod.warmupQuota(10, 40), 15);
  assert.equal(mod.warmupQuota(30, 40), 40);
  assert.equal(mod.warmupQuota(30, 20), 20);
  assert.deepEqual([18, 25, 33, 40].map((d) => mod.warmupQuota(d, 60)), [25, 35, 45, 60], "steps of ten a week to the maximum");
});

test("follow-ups: in the same thread, Re: subject, then the last one, then done", async () => {
  const env = newEnv();
  await configure(env);
  await addApproved(env, [P()]);
  await mod.outreachTick(env, MON, { random: () => 0 });
  const first = header(MB.sent[0].raw, "Message-ID");
  const p1 = one(env, "SELECT next_at FROM outreach_prospects");
  await mod.outreachTick(env, Date.parse(p1.next_at) + MIN, { random: () => 0 });
  assert.equal(MB.sent.length, 2);
  assert.equal(header(MB.sent[1].raw, "Subject"), "Re: 10 hooks for Bright Reels' next client");
  assert.equal(header(MB.sent[1].raw, "In-Reply-To"), first);
  // The second carries the business's personal link with the trial credits: no need to write back.
  const code = one(env, "SELECT link_code FROM outreach_prospects").link_code;
  assert.match(code, /^bright-reels-[a-z0-9]+$/);
  assert.match(bodyOf(MB.sent[1].raw), new RegExp(`Easier than a call: I've set up Bright Reels' own link to try Kleo\\.\\r?\\n\\r?\\nKleo for Bright Reels\\r?\\n[^\\n]*\\r?\\nTry Kleo free: https://app\\.kleooai\\.com/r/${code}`));
  assert.match(bodyOf(MB.sent[1].raw), /no card needed\) and 20 free credits land on the account within a few minutes/);
  // In the HTML it is a button, the address behind it.
  assert.match(htmlOf(MB.sent[1].raw), new RegExp(`<td bgcolor="#111111"[^>]*><a href="https://app\\.kleooai\\.com/r/${code}"[^>]*>Try Kleo free&nbsp;&rarr;</a></td>`));
  // The offer card and the signature carry Kleo's icon from the public media bucket (the app host forbids embedding).
  assert.match(htmlOf(MB.sent[1].raw), />Kleo for Bright Reels</);
  assert.equal((htmlOf(MB.sent[1].raw).match(/<img src="https:\/\/media\.kleooai\.com\/email\/kleo-icon-192\.png"/g) ?? []).length, 1, "the icon once, in the card: the signature is words only");
  assert.doesNotMatch(htmlOf(MB.sent[0].raw), /<img/, "the first e-mail has no image");
  // Who Kleo is and why: one line in the first e-mail, a short list in the second.
  assert.match(bodyOf(MB.sent[0].raw), /same top video models as the big platforms, like Seedance, Veo and Kling, at some of the lowest prices on the market/);
  assert.match(htmlOf(MB.sent[1].raw), /Why teams pick Kleo<\/p>\s*<ul/);
  assert.match(bodyOf(MB.sent[1].raw), /- Always growing: Kleo started as a connector inside Claude, became a full studio in a chat, and we're now building our own AI models/);
  assert.doesNotMatch(visible(htmlOf(MB.sent[1].raw)), /app\.kleooai\.com/);
  assert.equal(one(env, "SELECT created_by, archived_at IS NOT NULL AS hidden FROM short_links WHERE code = ?", code).hidden, 1);
  const p2 = one(env, "SELECT next_at FROM outreach_prospects");
  await mod.outreachTick(env, Date.parse(p2.next_at) + MIN, { random: () => 0 });
  assert.equal(MB.sent.length, 3);
  assert.match(bodyOf(MB.sent[2].raw), /I'll stop here/);
  assert.deepEqual(one(env, "SELECT status, step, next_at FROM outreach_prospects"), { status: "done", step: 3, next_at: null });
});

// ── the replies ──────────────────────────────────────────────────────────────────────────────────────────────────

test("replies: interested stops the sequence and tells the owner; 'remove me' and a bounce stop for good; out-of-office waits", async () => {
  const env = newEnv();
  await configure(env);
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

test("out-of-office: the day they say they are back is read in their own words, their own date order and their own year", () => {
  const MEL = "Australia/Melbourne";
  /** Tuesday 27 October 2026, 12:14 in Melbourne. */
  const got = Date.parse("2026-10-27T01:14:00.000Z");
  const back = (text, at = got, zone = MEL, country = "AU") => mod.backOn(text, at, zone, country)?.label ?? null;
  const away = "Heya!\n\nThanks for getting in touch!\n\nI'm overseas on leave until November 6th.\n\nFor new projects, please directly contact Mar Jones mar@studio.example or call 03 9018 0000.\n\nCheers,\nSam\n--\nheads up - I'll be overseas Oct 26th - Nov 6th";
  assert.equal(back(away), "6 Nov 2026", "a name like Mar is not March, a phone number is not a date");
  assert.equal(back("I'm out of the office from 24 December, returning on Monday 5 January.", Date.parse("2026-12-20T00:00:00.000Z")), "5 Jan 2027",
    "next year; the start of the absence and the weekday beside the date do not count");
  assert.equal(back("Back 6/11."), "6 Nov 2026");
  assert.equal(back("Back 11/6.", got, "America/New_York", "US"), "6 Nov 2026");
  assert.equal(back("Back on 2026-11-09."), "9 Nov 2026");
  assert.equal(back("I'm away until Monday."), "2 Nov 2026");
  assert.equal(back("Away today, back tomorrow"), "28 Oct 2026");
  assert.equal(back("Our new reel went live on 3 November."), null, "a date that does not end the absence");
  assert.equal(back("Thanks for your e-mail, I'll answer soon."), null);
  assert.equal(back("On parental leave until 1 June 2027."), null, "too far ahead to wait for");
  assert.equal(back("Back on 20 October."), null, "a past date (next year's is too far) means nothing");
  // In Auckland noon UTC is already the next day: the instant still falls on the day named there.
  const nz = mod.backOn("Back on 9 November.", got, "Pacific/Auckland", "NZ");
  assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Pacific/Auckland", day: "numeric", month: "short" }).format(new Date(nz.ms)), "9 Nov");
});

test("out-of-office: the follow-up waits for the business day after they are back, and the console says when", async () => {
  const env = newEnv();
  await configure(env);
  // Wednesday 28 October 2026, 10:00 in Melbourne.
  const WED = Date.parse("2026-10-27T23:00:00.000Z");
  await addApproved(env, [P({ email: "info@studio.example", company: "Studio", country: "AU", state: "VIC", city: "Melbourne" })]);
  for (let t = 0; t < 2 * HOUR; t += 15 * MIN) await mod.outreachTick(env, WED + t, { random: () => 0 });
  assert.equal(MB.sent.length, 1);
  MB.inbox = [{ uid: 21, headers: ["From: Sam <sam@studio.example>", "Subject: Thanks For Getting in Touch! Re: Ten hooks for Studio", "Auto-Submitted: auto-replied",
    `In-Reply-To: ${header(MB.sent[0].raw, "Message-ID")}`], body: "Thanks for getting in touch!\r\n\r\nI'm overseas on leave until November 6th.\r\n" }];
  await mod.outreachTick(env, WED + 2 * HOUR + 15 * MIN, { random: () => 0 });
  const p = one(env, "SELECT status, next_at FROM outreach_prospects WHERE email = 'info@studio.example'");
  assert.equal(p.status, "active");
  assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Melbourne", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(p.next_at)),
    "Mon 9 Nov, 09:30", "Friday the 6th is the day back; the follow-up comes the next business day, in their morning");
  assert.equal(one(env, "SELECT summary FROM outreach_replies").summary, "Automatic out-of-office reply; back on 6 Nov 2026.");
  assert.equal(env.mails.length, 0, "an automatic reply does not wake the owner");
});

test("refusals: a dead address is bounced and suppressed; a refused password pauses that mailbox, tries again in 30 minutes, and tells the owner on the second", async () => {
  const env = newEnv();
  await configure(env);
  await addApproved(env, [P({ email: "gone@dead.example", company: "Dead" }), P()]);
  MB.refuseRcpt.add("gone@dead.example");
  await mod.outreachTick(env, MON, { random: () => 0 });
  assert.equal(one(env, "SELECT status FROM outreach_prospects WHERE email = 'gone@dead.example'").status, "bounced");
  assert.equal(one(env, "SELECT reason FROM mail_suppress WHERE email = 'gone@dead.example'").reason, "bounce");
  MB.refuseAuth = true;
  const t = await mod.outreachTick(env, MON + 15 * MIN, { random: () => 0 });
  assert.equal(t.paused, "sender");
  assert.equal(env.mails.length, 0, "one refusal is often Google's hiccup: no alarm yet");
  assert.equal(one(env, "SELECT status FROM outreach_senders").status, "paused");
  assert.equal((await mod.outreachTick(env, MON + 30 * MIN, { random: () => 0 })).paused, "sender", "waits 30 minutes");
  assert.equal(MB.connections.filter((c) => c.startsWith("smtp.")).length, 2, "no sign-in tried while it waits");
  await mod.outreachTick(env, MON + 50 * MIN, { random: () => 0 });
  assert.equal(env.mails.length, 1, "the second refusal in a row tells the owner");
  assert.match(env.mails[0].raw, /leo@getkleo\.test refused to send/);
  assert.equal((await mod.outreachTick(env, MON + 90 * MIN, { random: () => 0 })).paused, "sender", "then waits 2 hours");
  assert.equal(env.mails.length, 1, "once");
  assert.equal(one(env, "SELECT status FROM outreach_prospects WHERE email = 'hello@brightreels.example'").status, "approved", "nobody is lost");
  // The next working day it tries again by itself; with no mail server at the business, that one is never written to.
  mxOk = false;
  MB.refuseAuth = false;
  await mod.outreachTick(env, MON + DAY, { random: () => 0 });
  assert.equal(one(env, "SELECT status FROM outreach_prospects WHERE email = 'hello@brightreels.example'").status, "invalid");
  // A good send clears the count: the next refusal is again a hiccup first.
  mxOk = true;
  await addApproved(env, [P({ email: "hi@third.example", company: "Third" })]);
  await mod.outreachTick(env, MON + DAY + 20 * MIN, { random: () => 0 });
  assert.equal(one(env, "SELECT status FROM outreach_senders").status, "active");
  assert.equal(one(env, "SELECT value FROM studio_meta WHERE key LIKE 'sender_fails_%'"), undefined);
});

test("off, or not set up: nothing is read or sent", async () => {
  const env = newEnv();
  await addApproved(env, [P()]);
  assert.deepEqual(await mod.outreachTick(env, MON), { sent: 0, replies: 0, converted: 0 });
  env.DB.db.prepare("INSERT INTO studio_meta (key, value) VALUES ('outreach_mode', 'on')").run();
  assert.equal((await mod.outreachTick(env, MON)).paused, "setup");
  assert.equal(MB.connections.length, 0);
});

// ── many mailboxes, the answer to a yes, sign-ups, learning ─────────────────────────────────────────────────────────

test("two mailboxes: each sends from its own address with its own warm-up, and a business keeps the one that wrote first", async () => {
  const env = newEnv();
  await configure(env, { boxes: [{ ...SENDER, password: MB.pass }, SENDER2] });
  await addApproved(env, Array.from({ length: 14 }, (_, i) => P({ email: `team@studio${i}.example`, company: `Studio ${i}` })));
  for (let t = 0; t < 6 * HOUR; t += 15 * MIN) await mod.outreachTick(env, MON + t, { random: () => 0.5 });
  const by = (u) => MB.sent.filter((m) => m.user === u).length;
  assert.equal(by("leo@getkleo.test"), 5);
  assert.equal(by("kim@getkleo2.test"), 5);
  assert.ok(MB.sent.every((m) => m.from === m.user), "each from its own address");
  // The follow-up of a business goes from the mailbox that wrote to it first.
  const p = one(env, "SELECT id, email, sender_id, next_at FROM outreach_prospects WHERE sender_id = (SELECT id FROM outreach_senders WHERE from_addr = 'kim@getkleo2.test') LIMIT 1");
  MB.sent.length = 0;
  await mod.outreachTick(env, Date.parse(p.next_at) + MIN, { random: () => 0.5 });
  assert.deepEqual(MB.sent.filter((m) => m.to === p.email).map((m) => m.user), ["kim@getkleo2.test"]);
});

test("a yes: Kleo answers in the thread with the business's personal link; signing up through it adds the trial credits once", async () => {
  const env = newEnv();
  await configure(env, { settings: { trialCredits: 25 } });
  await addApproved(env, [P()]);
  await mod.outreachTick(env, MON, { random: () => 0 });
  const first = header(MB.sent[0].raw, "Message-ID");
  MB.inbox = [{ uid: 31, headers: ["From: Maya <maya@brightreels.example>", "Subject: Re: Short-form video for Bright Reels", `In-Reply-To: ${first}`, "Message-ID: <their1@brightreels.example>"], body: "Yes please!\r\n" }];
  await mod.outreachTick(env, MON + 15 * MIN, { random: () => 0 });
  const answer = MB.sent.at(-1);
  assert.equal(answer.to, "maya@brightreels.example");
  assert.equal(header(answer.raw, "In-Reply-To"), "<their1@brightreels.example>");
  assert.equal(header(answer.raw, "Subject"), "Re: Short-form video for Bright Reels");
  const p = one(env, "SELECT status, reply_class, link_code FROM outreach_prospects");
  assert.equal(p.status, "replied");
  assert.equal(p.reply_class, "interested");
  assert.match(p.link_code, /^bright-reels-[a-z0-9]{4}$/);
  assert.match(bodyOf(answer.raw), new RegExp(`https://app\\.kleooai\\.com/r/${p.link_code}`));
  assert.match(bodyOf(answer.raw), /25 free credits land on the account/);
  assert.match(htmlOf(answer.raw), new RegExp(`<a href="https://app\\.kleooai\\.com/r/${p.link_code}"[^>]*>Try Kleo free&nbsp;&rarr;</a>`));
  assert.doesNotMatch(visible(htmlOf(answer.raw)), /app\.kleooai\.com/);
  assert.ok(one(env, "SELECT archived_at FROM short_links WHERE code = ?", p.link_code).archived_at, "hidden from Sources, still working");
  assert.equal(env.AI.calls, 0, "a plain yes needs no AI");
  assert.match(env.mails.at(-1).raw, /Kleo already answered with their personal link/);
  // The business opens the link and signs up: the trial credits come, once, and the owner hears.
  const r = await call(env, `/r/${p.link_code}`, { header: false, headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" } });
  const touch = cookiesOf(r.res).find((x) => x.startsWith("__Host-kleo_src="))?.split(";")[0];
  assert.ok(touch, "the link tags the visit");
  const su = await call(env, "/api/auth/signup", { method: "POST", cookie: touch, body: { email: "maya@brightreels.example", password: "long enough pw" } });
  assert.equal(su.status, 200, su.text);
  const userId = one(env, "SELECT user_id FROM user_attribution WHERE link_code = ?", p.link_code).user_id;
  const before = one(env, "SELECT credits FROM users WHERE id = ?", userId).credits;
  const t = await mod.outreachTick(env, MON + HOUR, { random: () => 0 });
  assert.equal(t.converted, 1);
  assert.equal(one(env, "SELECT credits FROM users WHERE id = ?", userId).credits, before + 25);
  assert.equal(one(env, "SELECT converted_user FROM outreach_prospects").converted_user, userId);
  assert.match(env.mails.at(-1).raw, /Bright Reels signed up/);
  assert.equal((await mod.outreachTick(env, MON + 2 * HOUR, { random: () => 0 })).converted, 0, "once");
  assert.equal(one(env, "SELECT credits FROM users WHERE id = ?", userId).credits, before + 25);
});

test("learning: the version of the first e-mail that gets answered is picked more; every version renders cleanly", async () => {
  const rnd = (() => { let x = 7; return () => ((x = (x * 16807) % 2147483647) / 2147483647); })();
  const stats = [{ id: "a", name: "A", sent: 60, answered: 1 }, { id: "b", name: "B", sent: 60, answered: 12 }, { id: "c", name: "C", sent: 60, answered: 2 }];
  const picks = Array.from({ length: 400 }, () => mod.pickVariant(stats, rnd));
  const share = (id) => picks.filter((x) => x === id).length / picks.length;
  assert.ok(share("b") > 0.8, `b picked ${share("b")}`);
  // With nothing known yet, every version gets its turn.
  const fresh = Array.from({ length: 300 }, () => mod.pickVariant(stats.map((s) => ({ ...s, sent: 0, answered: 0 })), rnd));
  for (const id of ["a", "b", "c"]) assert.ok(fresh.filter((x) => x === id).length > 50, id);
  const p = { id: "p_x", email: "hi@x.example", domain: "x.example", company: "X Studio", website: null, country: "US", region: "NY", city: "Brooklyn", type: "ugc-agency", contact_name: "Ann",
    source_url: "https://x.example/contact", opener: "Saw the UGC ads on your work page.", status: "approved", step: 0, next_at: null, tz: null, thread_id: null, subject: null, batch: null,
    sender_id: null, variant: null, link_code: null, converted_user: null, reply_class: null };
  for (const v of mod.VARIANTS) for (const credits of [0, 20]) {
    const w = mod.writeStep({ ...p, variant: v.id }, 0, { fromName: "Leonardo", postal: POSTAL, credits }, "https://app.kleooai.com/email/out?p=p_x&s=y");
    assert.match(w.text, /^Hi Ann,\n\nSaw the UGC ads on your work page\.\n\n/);
    assert.match(w.text, /Kleo, PO Box 123, Auckland 1010, New Zealand · kleooai\.com/);
    assert.doesNotMatch(w.text + w.html, /Kanaky/, "Kanaky Tech is no longer part of Kleo");
    assert.equal(/free credits/.test(w.text), credits > 0, `${v.id} credits ${credits}`);
    assert.doesNotMatch(w.text, /undefined|null|NaN/);
  }
});

// ── the scout ────────────────────────────────────────────────────────────────────────────────────────────────────

const SITE = (email, extra = "") => `<html><head><title>Studio</title></head><body><nav><a href="/contact">Contact us</a></nav>
  <h1>UGC ads for DTC brands</h1><p>We make creator-style TikTok and Reels ads for skincare and supplement brands. ${extra}</p>
  <footer>Say hi: ${email}</footer></body></html>`;
function scoutDeps(sites, results) {
  const searched = [];
  return { searched, search: async (q) => { searched.push(q); return results.shift() ?? []; }, fetchPage: async (u) => sites[u] ?? null };
}

test("scout: finds a business, checks its visible address, its work and its country, and adds it with the page as proof", async () => {
  const env = newEnv();
  const deps = scoutDeps({
    "https://www.goodugc.com/": SITE("hello@goodugc.com"),
    "https://hiddenmail.com/": SITE("<a href=\"mailto:hi@hiddenmail.com\">Email us</a>"),
    "https://refuser.com/": SITE("hello@refuser.com", "No unsolicited emails or vendor pitches, please."),
    "https://freebox.com/": SITE("studio.freebox@gmail.com"),
    "https://www.goodugc.com/contact": "<html><body>Write to hello@goodugc.com or call us.</body></html>",
  }, [[{ url: "https://www.goodugc.com/about" }, { url: "https://hiddenmail.com/" }, { url: "https://refuser.com/" }, { url: "https://freebox.com/" },
    { url: "https://www.linkedin.com/company/x" }, { url: "https://clutch.co/agencies/ugc" }]]);
  const set = { ...mod.DEFAULT_SETTINGS, scoutOn: true, scoutDaily: 2 };
  let r = await mod.scoutTick(env, set, MON, deps);
  assert.deepEqual(deps.searched, ["TikTok marketing agency London UK"], "no postal address: the UK, Australia and New Zealand only");
  assert.equal(r.searched, 1);
  assert.equal(rows(env, "SELECT * FROM outreach_seen").length, 4, "directories and networks are never queued");
  r = await mod.scoutTick(env, set, MON + 5 * MIN, deps);
  r = await mod.scoutTick(env, set, MON + 10 * MIN, deps);
  const seen = Object.fromEntries(rows(env, "SELECT domain, result FROM outreach_seen").map((x) => [x.domain, x.result]));
  assert.equal(seen["goodugc.com"], "added");
  assert.equal(seen["hiddenmail.com"], "no visible business address");
  assert.equal(seen["refuser.com"], "refuses unsolicited messages");
  assert.equal(seen["freebox.com"], "no visible business address");
  const p = one(env, "SELECT * FROM outreach_prospects");
  assert.equal(p.email, "hello@goodugc.com");
  assert.equal(p.status, "new", "waits for the owner unless told otherwise");
  assert.equal(p.country, "US");
  assert.equal(p.region, "TX");
  assert.equal(p.tz, "America/Chicago");
  assert.match(p.batch, /^scout-/);
  assert.equal(p.opener, "Saw the UGC ads for skincare brands on your work page.");
  assert.match(p.source_url, /^https:\/\/www\.goodugc\.com\//);
  // Today's allowance: two searches, then none until tomorrow.
  assert.equal(deps.searched.length, 2, "two searches today, then none until tomorrow");
  assert.equal(one(env, "SELECT value FROM studio_meta WHERE key = 'scout_cursor_intl'").value, "2");
});

test("scout: a site that is not a fit, too big, in another country, or a person's address in Canada is left out; auto-approve works", async () => {
  const env = newEnv();
  const sites = {
    "https://seoonly.com/": SITE("hello@seoonly.com"), "https://bigco.com/": SITE("hello@bigco.com"), "https://german.de/": SITE("hallo@german.de"),
    "https://maplecreative.ca/": SITE("jane@maplecreative.ca"), "https://maplerole.ca/": SITE("hello@maplerole.ca"),
    "https://londonreels.co.uk/": SITE("hello@londonreels.co.uk"),
    "https://solouk.co.uk/": SITE("jane@solouk.co.uk", "Great work for brands with Limited Budgets."), "https://ltduk.co.uk/": SITE("tom@ltduk.co.uk", "Ltduk Ltd, registered in England and Wales."),
    "https://privco.co.uk/": SITE("sam@privco.co.uk", '<a href="/privacy">Privacy policy</a>'),
    "https://privco.co.uk/privacy": "<html><body>This website is run by PrivCo Media Limited, registered in England.</body></html>",
  };
  const verdicts = {
    "seoonly.com": { fit: false, reason: "SEO only." }, "bigco.com": { fit: true, size: "200+", country: "US" }, "german.de": { fit: true, size: "2-10", country: "DE" },
    "maplecreative.ca": { fit: true, size: "2-10", country: "CA", region: "ON", city: "Toronto", company: "Maple", type: "social-media-agency", opener: "Saw the Toronto restaurant reels on your site." },
    "maplerole.ca": { fit: true, size: "2-10", country: "CA", region: "ON", city: "Toronto", company: "Maple Role", type: "social-media-agency", opener: "Saw the Toronto restaurant reels on your site." },
    // Workers AI says "UK", not GB (seen live on 27 October 2026).
    "londonreels.co.uk": { fit: true, size: "2-10", country: "UK", city: "London", company: "London Reels", type: "short-form-video-agency", opener: "Saw the Reels you make for London restaurants." },
    // A person's address in the UK: only at a limited company (PECR).
    "solouk.co.uk": { fit: true, size: "solo", country: "GB", city: "Leeds", company: "Solo UK", type: "ugc-agency", opener: "Saw the UGC ads you make for Leeds cafes." },
    "ltduk.co.uk": { fit: true, size: "2-10", country: "GB", city: "Leeds", company: "Ltduk", type: "ugc-agency", opener: "Saw the UGC ads you make for Leeds gyms." },
    "privco.co.uk": { fit: true, size: "2-10", country: "GB", city: "Bristol", company: "PrivCo", type: "ugc-agency", opener: "Saw the UGC ads you make for Bristol bakeries." },
  };
  const realRun = env.AI.run.bind(env.AI);
  env.AI.run = async (m, input) => {
    const user = String(input?.messages?.[1]?.content ?? "");
    const dom = Object.keys(verdicts).find((d) => user.includes(`Website: ${d}`));
    if (dom) return { response: JSON.stringify(verdicts[dom]) };
    return realRun(m, input);
  };
  const deps = scoutDeps(sites, [Object.keys(sites).map((u) => ({ url: u }))]);
  const set = { ...mod.DEFAULT_SETTINGS, scoutOn: true, scoutDaily: 3, autoApprove: true };
  for (let i = 0; i < 3; i++) await mod.scoutTick(env, set, MON + i * 5 * MIN, deps);
  const seen = Object.fromEntries(rows(env, "SELECT domain, result FROM outreach_seen").map((x) => [x.domain, x.result]));
  assert.match(seen["seoonly.com"], /^not a fit/);
  assert.equal(seen["bigco.com"], "too big");
  assert.equal(seen["german.de"], "country DE");
  assert.equal(seen["maplecreative.ca"], "a person's address in Canada");
  assert.equal(seen["maplerole.ca"], "added");
  assert.equal(seen["londonreels.co.uk"], "added");
  assert.equal(seen["solouk.co.uk"], "a person's address at a UK business that may be a sole trader");
  assert.equal(seen["ltduk.co.uk"], "added");
  assert.equal(seen["privco.co.uk"], "added", "the company named on its privacy page");
  assert.deepEqual(rows(env, "SELECT email, status, country, region FROM outreach_prospects ORDER BY email"), [
    { email: "hello@londonreels.co.uk", status: "approved", country: "GB", region: null }, { email: "hello@maplerole.ca", status: "approved", country: "CA", region: "ON" },
    { email: "sam@privco.co.uk", status: "approved", country: "GB", region: null }, { email: "tom@ltduk.co.uk", status: "approved", country: "GB", region: null }]);
  assert.deepEqual(["© OK COOL LTD 11 Richmond", "Socially Powerful Media Limited", "Company No: 12345678", "brands with Limited Budgets", "For Brands With Limited Budgets", "rather than being limited by", "Ltd Films and Plc talk"].map(mod.ukCompany),
    [true, true, true, false, false, false, false]);
});

test("scout: the US and Canada are searched only with a postal address, in proportion; sites without video work cost no Workers AI", async () => {
  const env = newEnv();
  const deps = scoutDeps({ "https://plumbco.com/": "<html><body><h1>Plumbing in Leeds</h1><p>Boilers and taps. hello@plumbco.com</p></body></html>" }, [[{ url: "https://plumbco.com/" }]]);
  let set = { ...mod.DEFAULT_SETTINGS, scoutOn: true, scoutDaily: 200 };
  for (let i = 0; i < 12; i++) await mod.scoutTick(env, set, MON + i * 5 * MIN, deps);
  const na = (q) => (/ [A-Z]{2}$/.test(q) && !/ UK$/.test(q)) || /Canada$/.test(q);
  assert.equal(deps.searched.filter(na).length, 0, "no US or Canadian city without a postal address");
  assert.equal(one(env, "SELECT result FROM outreach_seen WHERE domain = 'plumbco.com'").result, "no video or social media work on the site");
  assert.equal(env.AI.calls, 0, "Workers AI never read it");
  assert.equal(one(env, "SELECT value FROM studio_meta WHERE key = 'scout_judged_2026-11-02'"), undefined);
  // With a postal address both walks run, the US and Canada about twice as often (213 cities against 110).
  const env2 = newEnv(), deps2 = scoutDeps({}, []);
  set = { ...set, postal: POSTAL };
  for (let i = 0; i < 30; i++) await mod.scoutTick(env2, set, MON + i * 5 * MIN, deps2);
  const n = deps2.searched.filter(na).length;
  assert.ok(n >= 18 && n <= 22, `${n} of 30 searches in the US or Canada`);
  assert.equal(deps2.searched[0], "TikTok marketing agency London UK");
  assert.equal(deps2.searched.filter(na)[0], "TikTok marketing agency New York NY");
});

test("scout: searching waits while too many websites or businesses wait, keeping the allowance; Workers AI reads at most three a day per search", async () => {
  const env = newEnv();
  const deps = { searched: [], search: async (q) => { deps.searched.push(q); return []; }, fetchPage: async (u) => SITE(`hello@${new URL(u).hostname}`) };
  const set = { ...mod.DEFAULT_SETTINGS, scoutOn: true, scoutDaily: 1 };
  const seen = env.DB.db.prepare("INSERT INTO outreach_seen (domain, status, url) VALUES (?, 'queued', ?)");
  for (let i = 0; i < 600; i++) seen.run(`queued${i}.com`, `https://queued${i}.com/`);
  let r = await mod.scoutTick(env, set, MON, deps);
  assert.equal(r.searched, 0);
  assert.match(one(env, "SELECT value FROM studio_meta WHERE key = 'scout_paused'").value, /^600 websites are waiting to be read/);
  assert.equal(one(env, "SELECT value FROM studio_meta WHERE key = 'scout_day_2026-11-02'"), undefined, "the allowance is kept");
  assert.equal(r.checked, 3, "three readings a day for one search a day");
  r = await mod.scoutTick(env, set, MON + 5 * MIN, deps);
  assert.equal(r.checked, 0, "today's readings are spent: the rest wait");
  assert.equal(r.searched, 1, "597 queued: searching goes on");
  assert.equal(one(env, "SELECT value FROM studio_meta WHERE key = 'scout_judged_2026-11-02'").value, "3");
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM outreach_seen WHERE status = 'queued'").n, 597);
  env.DB.db.prepare("DELETE FROM outreach_seen").run();
  env.DB.db.prepare("DELETE FROM outreach_prospects").run();
  // A thousand businesses per mailbox already waiting for a first e-mail (the US and Canada not counted without a postal address).
  const ins = env.DB.db.prepare("INSERT INTO outreach_prospects (id, email, domain, company, country, source_url, status) VALUES (?, ?, ?, 'Co', ?, 'https://x/', 'approved')");
  for (let i = 0; i < 1000; i++) ins.run(`p${i}`, `hello@co${i}.com`, `co${i}.com`, i < 10 ? "US" : "GB");
  r = await mod.scoutTick(env, set, MON + DAY, deps);
  assert.equal(r.searched, 1, "990 sendable without a postal address: it searches");
  env.DB.db.prepare("UPDATE outreach_prospects SET country = 'GB'").run();
  r = await mod.scoutTick(env, set, MON + 2 * DAY, deps);
  assert.equal(r.searched, 0);
  assert.match(one(env, "SELECT value FROM studio_meta WHERE key = 'scout_paused'").value, /^1000 businesses already wait for their first e-mail/);
  env.DB.db.prepare("DELETE FROM outreach_prospects WHERE id = 'p0'").run();
  r = await mod.scoutTick(env, set, MON + 2 * DAY + 5 * MIN, deps);
  assert.equal(r.searched, 1);
  assert.equal(one(env, "SELECT value FROM studio_meta WHERE key = 'scout_paused'"), undefined);
});

test("scout: the day's searches are spread over it, one a minute at most", async () => {
  const env = newEnv();
  const deps = scoutDeps({}, []);
  const MIDNIGHT = Date.parse("2026-11-02T00:00:20.000Z");
  const set = { ...mod.DEFAULT_SETTINGS, scoutOn: true, scoutDaily: 2 };
  assert.equal((await mod.scoutTick(env, set, MIDNIGHT, deps)).searched, 1, "the first of the day");
  assert.equal((await mod.scoutTick(env, set, MIDNIGHT + 5 * MIN, deps)).searched, 0, "the second waits for the second half of the day");
  assert.equal((await mod.scoutTick(env, set, MIDNIGHT + 12 * HOUR, deps)).searched, 1);
  assert.equal((await mod.scoutTick(env, set, MIDNIGHT + 23 * HOUR, deps)).searched, 0, "two a day");
  const fast = { ...set, scoutDaily: 1440 };
  const env2 = newEnv(), deps2 = scoutDeps({}, []);
  assert.equal((await mod.scoutTick(env2, fast, MIDNIGHT, deps2)).searched, 1);
  assert.equal((await mod.scoutTick(env2, fast, MIDNIGHT + 20_000, deps2)).searched, 0, "one a minute");
  assert.equal((await mod.scoutTick(env2, fast, MIDNIGHT + MIN, deps2)).searched, 1);
});

test("scout: no AI Gateway credits keeps today's allowance and says why; off does nothing", async () => {
  const env = newEnv();
  const set = { ...mod.DEFAULT_SETTINGS, scoutOn: true, scoutDaily: 3 };
  const deps = { search: async () => { throw new Error("Your AI Gateway credit balance is zero, so this search could not be billed."); }, fetchPage: async () => null };
  const r = await mod.scoutTick(env, set, MON, deps);
  assert.equal(r.searched, 0);
  assert.match(one(env, "SELECT value FROM studio_meta WHERE key = 'scout_error'").value, /credit balance is zero/);
  assert.equal(one(env, "SELECT value FROM studio_meta WHERE key = 'scout_cursor_intl'").value, "0", "the same search is tried again");
  assert.deepEqual(await mod.scoutTick(env, { ...set, scoutOn: false }, MON, deps), { searched: 0, checked: 0, added: 0 });
  // The endless walk: every kind in every city, then other wordings.
  const per = mod.SEGMENTS.length * mod.PLACES.length;
  assert.equal(mod.queryAt(0).q, "TikTok marketing agency New York NY");
  assert.equal(mod.queryAt(per).q, "TikTok marketing agency contact New York NY");
  assert.ok(new Set(Array.from({ length: per }, (_, i) => mod.queryAt(i).q)).size === per);
  assert.deepEqual(["GB", "AU", "NZ", "CA", "US"].map((c) => mod.PLACES.some((p) => p[2] === c)), [true, true, true, true, true]);
  assert.ok(mod.PLACES.length >= 300 && mod.SEGMENTS.length >= 20, "enough cities and kinds for 240 searches a day");
  assert.deepEqual([...new Set(mod.WALKS.intl.map((p) => p[2]))].sort(), ["AU", "GB", "NZ"]);
  assert.deepEqual([...new Set(mod.WALKS.na.map((p) => p[2]))].sort(), ["CA", "US"]);
  const intlPer = mod.SEGMENTS.length * mod.WALKS.intl.length;
  assert.ok(new Set(Array.from({ length: intlPer }, (_, i) => mod.queryAt(i, mod.WALKS.intl).q)).size === intlPer);
  // A first line is spoken to the business and ends with a full stop (seen live: "Saw they scale 150+ D2C brands").
  assert.equal(mod.goodOpener("Saw they scale 150+ D2C brands across the US"), null);
  assert.equal(mod.goodOpener("Saw TikTok Shop Services in their offerings"), null);
  assert.equal(mod.goodOpener("Saw that you make UGC ads for skincare brands"), "Saw that you make UGC ads for skincare brands.");
  assert.equal(mod.goodOpener("Noticed your Leeds studio shoots Reels for gyms."), "Noticed your Leeds studio shoots Reels for gyms.");
  assert.deepEqual(["UK", "uk", "United Kingdom", "USA", "Australia", "nz", "GB", "DE", null].map(mod.isoCountry), ["GB", "GB", "GB", "US", "AU", "NZ", "GB", "DE", ""]);
  assert.deepEqual(mod.visibleAddresses("<p>hello@a-studio.com.au, jobs@a-studio.com.au, x@gmail.com, info@other.com, me@a-studio.com.au</p>", "www.a-studio.com.au"), ["hello@a-studio.com.au", "me@a-studio.com.au"]);
});

// ── the unsubscribe link and the console ─────────────────────────────────────────────────────────────────────────

test("unsubscribe: GET asks, POST (or the mail client's one click) stops it and suppresses the address", async () => {
  const env = newEnv();
  await configure(env);
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

test("console: mailboxes saved only after both sign-ins, settings, approvals, preview, import, test, and the switch's checks", async () => {
  const env = newEnv();
  const o = await setupAdmin(env);
  await mod.addProspects(env, [P(), P({ email: "hi@two.example", company: "Two" })], "research");
  let r = await call(env, "/api/admin/outreach", { cookie: o.admin });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.ready, { senders: 0, postal: false, approved: 0, sendable: 0, ok: false });
  r = await call(env, "/api/admin/outreach/mode", { method: "POST", cookie: o.admin, body: { on: true, code: await o.code() } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "not_ready");
  // A Gmail or kleooai.com sender is refused; a wrong password keeps nothing.
  r = await call(env, "/api/admin/outreach/senders", { method: "POST", cookie: o.admin, body: { ...SENDER, fromAddr: "kleooai@gmail.com", password: MB.pass, code: await o.code() } });
  assert.equal(r.json.code, "from_domain");
  r = await call(env, "/api/admin/outreach/senders", { method: "POST", cookie: o.admin, body: { ...SENDER, password: "wrongwrongwrong1", code: await o.code() } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "smtp");
  assert.equal(rows(env, "SELECT * FROM outreach_senders").length, 0);
  r = await call(env, "/api/admin/outreach/senders", { method: "POST", cookie: o.admin, body: { ...SENDER, password: "abcd abcd abcd abcd", code: await o.code() } });
  assert.equal(r.status, 200, r.text);
  const row = one(env, "SELECT sealed_pass, pass_last4 FROM outreach_senders");
  assert.equal(row.pass_last4, "abcd");
  assert.doesNotMatch(row.sealed_pass, /abcd/);
  r = await call(env, "/api/admin/outreach/settings", { method: "POST", cookie: o.admin, body: { postal: POSTAL, trialCredits: 30 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.trialCredits, 30);
  // Switching the scout on, or approving its finds by itself, wants a fresh code.
  r = await call(env, "/api/admin/outreach/settings", { method: "POST", cookie: o.admin, body: { scoutOn: true, code: await o.code() } });
  assert.equal(r.json.scoutOn, true);
  r = await call(env, "/api/admin/outreach/settings", { method: "POST", cookie: o.admin, body: { scoutDaily: 9999 } });
  assert.equal(r.json.scoutDaily, 1440, "one search a minute at most");
  r = await call(env, "/api/admin/outreach/settings", { method: "POST", cookie: o.admin, body: { scoutDaily: 800 } });
  assert.equal(r.json.scoutDaily, 800);
  r = await call(env, "/api/admin/outreach", { cookie: o.admin });
  assert.deepEqual(r.json.ready, { senders: 1, postal: true, approved: 0, sendable: 0, ok: false });
  assert.equal(r.json.mailboxes[0].passwordEnds, "abcd");
  assert.ok(!JSON.stringify(r.json).includes(MB.pass), "the password never comes back");
  assert.equal(r.json.variants.length, 3);
  const list = await call(env, "/api/admin/outreach/prospects?status=new", { cookie: o.admin });
  assert.equal(list.json.prospects.length, 2);
  const pv = await call(env, `/api/admin/outreach/preview?id=${list.json.prospects[0].id}`, { cookie: o.admin });
  assert.equal(pv.json.first.length, 3);
  assert.equal(pv.json.followUps.length, 2);
  assert.match(pv.json.first[0].text, /PO Box 123/);
  assert.match(pv.json.yes, /30 free credits/);
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
  // To an address the owner names, to see it as a business would.
  r = await call(env, "/api/admin/outreach/test", { method: "POST", cookie: o.admin, body: { to: "Owner@Example.com" } });
  assert.equal(r.json.to, "owner@example.com");
  assert.equal(MB.sent.at(-1).to, "owner@example.com");
  r = await call(env, "/api/admin/outreach/test", { method: "POST", cookie: o.admin, body: { to: "not an address" } });
  assert.equal(r.json.to, "leo@getkleo.test", "anything else goes to the mailbox itself");
  // The second e-mail, to see its button; its stop link belongs to no business.
  r = await call(env, "/api/admin/outreach/test", { method: "POST", cookie: o.admin, body: { to: "owner@example.com", step: 1 } });
  assert.match(htmlOf(MB.sent.at(-1).raw), /<a href="https:\/\/app\.kleooai\.com\/"[^>]*>Try Kleo free&nbsp;&rarr;<\/a>/);
  assert.match(htmlOf(MB.sent.at(-1).raw), /email\/out\?p=p_testmail&amp;s=/);
  r = await call(env, "/api/admin/outreach/mode", { method: "POST", cookie: o.admin, body: { on: true, code: await o.code() } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await call(env, "/api/admin/outreach", { cookie: o.admin })).json.on, true);
  // A mailbox that never sent can go; switched off, it stops sending.
  const sid = one(env, "SELECT id FROM outreach_senders").id;
  r = await call(env, `/api/admin/outreach/senders/${sid}`, { method: "POST", cookie: o.admin, body: { action: "off" } });
  assert.equal(one(env, "SELECT status FROM outreach_senders").status, "off");
  r = await call(env, `/api/admin/outreach/senders/${sid}`, { method: "POST", cookie: o.admin, body: { action: "remove" } });
  assert.equal(rows(env, "SELECT * FROM outreach_senders").length, 0);
});

test("morning e-mail: at 8:00 in Auckland, once a day, only while something is on, with the interested replies by name", async () => {
  const env = newEnv();
  await configure(env);
  await addApproved(env, [P(), P({ email: "hi@two.example", company: "Two" })]);
  for (let t = 0; t < HOUR; t += 15 * MIN) await mod.outreachTick(env, MON + t, { random: () => 0 });
  env.AI.answer = '{"class":"interested","summary":"Wants a trial for the team."}';
  MB.inbox = [{ uid: 21, headers: ["From: maya@brightreels.example", "Subject: Re: Short-form video for Bright Reels", `In-Reply-To: ${header(MB.sent[0].raw, "Message-ID")}`], body: "We'd like to try it with the team next week.\r\n" }];
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
  assert.match(raw, /Sent in the last 24 hours: 2 \(2 first e-mails, 0 follow-ups\) from 1 mailbox\./);
  assert.match(raw, /Answers to a yes, with their link: 1\./);
  assert.match(raw, /Bright Reels \(interested\): Wants a trial for the team\./);
  assert.doesNotMatch(raw, /WELCOME E-MAILS/, "the welcome e-mails are off");
  env.DB.db.prepare("UPDATE studio_meta SET value = 'off' WHERE key = 'outreach_mode'").run();
  assert.equal(await mod.morningDigest(env, eight + DAY), false, "nothing on, nothing sent");
});

test("no postal address: the UK, Australia and New Zealand are written to, with the name, website and e-mail; the US and Canada wait", async () => {
  const env = newEnv();
  await configure(env, { settings: { postal: "" } });
  await addApproved(env, [P({ email: "team@usagency.example", company: "US Agency" }), P({ email: "kia@ora.example", company: "Ora Studio", country: "NZ", state: "", city: "Auckland" }),
    P({ email: "hi@maple.example", company: "Maple", country: "CA", state: "ON", city: "Toronto" })]);
  const ready = await mod.readiness(env);
  assert.deepEqual(ready, { senders: 1, postal: false, approved: 3, sendable: 1, ok: true });
  // Tuesday 3 November 2026, 10:30 in Auckland; then the US and Canada's own working hours the same week.
  const nzMorning = Date.parse("2026-11-02T21:30:00.000Z");
  for (let t = 0; t < 3 * DAY; t += HOUR) await mod.outreachTick(env, nzMorning + t, { random: () => 0 });
  assert.deepEqual([...new Set(MB.sent.map((m) => m.to))], ["kia@ora.example"], "the first e-mail and, three working days later, the follow-up");
  assert.match(bodyOf(MB.sent[0].raw), /Kleo · New Zealand · kleooai\.com · hello@kleooai\.com/);
  assert.equal(one(env, "SELECT status FROM outreach_prospects WHERE email = 'team@usagency.example'").status, "approved", "waits, still approved");
  // A postal address later: the US and Canada join.
  await mod.saveSettings(env, "u_owner", { postal: POSTAL });
  for (let t = 3 * DAY; t < 6 * DAY; t += HOUR) await mod.outreachTick(env, nzMorning + t, { random: () => 0 });
  assert.ok(MB.sent.some((m) => m.to === "team@usagency.example") && MB.sent.some((m) => m.to === "hi@maple.example"));
  assert.match(bodyOf(MB.sent.find((m) => m.to === "team@usagency.example").raw), /Kleo, PO Box 123/);
});
