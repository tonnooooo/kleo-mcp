/**
 * A MAILBOX SPOKEN TO DIRECTLY (27 October 2026): SMTP to send and IMAP to read the replies, over Cloudflare's TCP
 * sockets, for the outreach e-mails (src/studio/outreach.ts). Cloudflare Email Sending carries only transactional mail,
 * so a first business e-mail to an agency goes out from a real mailbox (Google Workspace, Zoho, any provider with
 * SMTP and IMAP and an app password), exactly as if Leonardo had written it there: it sits in that mailbox's Sent
 * folder, and the answers arrive in its inbox, where IMAP reads them.
 *
 * Small on purpose: implicit TLS (SMTP 465, IMAP 993) or STARTTLS (SMTP 587), AUTH PLAIN, one message per connection;
 * IMAP LOGIN, SELECT INBOX, UID SEARCH and UID FETCH of the headers and the first few kilobytes of each new message.
 * The dialer is a parameter, so the tests talk to a scripted server instead of the network.
 */

export interface Conn {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls?(): Conn;
  close(): Promise<void> | void;
}
export type Dial = (host: string, port: number, tls: "on" | "starttls") => Promise<Conn>;

/**
 * Cloudflare's sockets, imported only when used (inside try, so a bundler that cannot resolve "cloudflare:sockets"
 * leaves it to the runtime, as with "cloudflare:email" in providers.ts).
 */
export const socketDial: Dial = async (host, port, tls) => {
  let sockets: { connect(a: { hostname: string; port: number }, o: { secureTransport: string; allowHalfOpen: boolean }): unknown };
  try { sockets = await import("cloudflare:sockets"); } catch { throw new MailboxError("TCP sockets are not available here."); }
  return sockets.connect({ hostname: host, port }, { secureTransport: tls, allowHalfOpen: false }) as Conn;
};

/** A refusal from the server, or a connection that broke: `code` is the SMTP reply code when there is one. */
export class MailboxError extends Error {
  constructor(message: string, readonly code = 0, readonly stage = "") { super(message); }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const TIMEOUT_MS = 20_000;

/** Bytes in, CRLF lines and counted literals out. */
class Wire {
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private buf = new Uint8Array(0);
  constructor(private conn: Conn) { this.attach(conn); }
  private attach(c: Conn) { this.reader = c.readable.getReader(); this.writer = c.writable.getWriter(); }
  async upgrade(): Promise<void> {
    if (!this.conn.startTls) throw new MailboxError("This connection cannot switch to TLS.");
    this.reader.releaseLock(); this.writer.releaseLock();
    this.conn = this.conn.startTls();
    this.buf = new Uint8Array(0);
    this.attach(this.conn);
  }
  private async more(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      this.reader.read(),
      new Promise<never>((_, no) => { timer = setTimeout(() => no(new MailboxError("The mail server stopped answering.")), TIMEOUT_MS); }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    if (r.done || !r.value) throw new MailboxError("The mail server closed the connection.");
    const next = new Uint8Array(this.buf.length + r.value.length);
    next.set(this.buf); next.set(r.value, this.buf.length);
    this.buf = next;
  }
  async line(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const l = dec.decode(this.buf.subarray(0, i));
          this.buf = this.buf.slice(i + 2);
          return l;
        }
      }
      await this.more();
    }
  }
  async bytes(n: number): Promise<string> {
    while (this.buf.length < n) await this.more();
    const out = dec.decode(this.buf.subarray(0, n));
    this.buf = this.buf.slice(n);
    return out;
  }
  async write(s: string): Promise<void> { await this.writer.write(enc.encode(s)); }
  async close(): Promise<void> {
    try { this.reader.releaseLock(); this.writer.releaseLock(); } catch { /* already released */ }
    try { await this.conn.close(); } catch { /* already closed */ }
  }
}

const b64 = (s: string): string => { let bin = ""; for (const b of enc.encode(s)) bin += String.fromCharCode(b); return btoa(bin); };

// ── SMTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SmtpConfig { host: string; port: number; user: string; pass: string }

async function smtpReply(w: Wire): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  let l: string;
  do { l = await w.line(); lines.push(l.slice(4)); } while (l.length > 3 && l[3] === "-");
  return { code: Number(l.slice(0, 3)) || 0, text: lines.join(" ").trim() };
}
async function smtpStep(w: Wire, ok: number[], stage: string, cmd?: string): Promise<{ code: number; text: string }> {
  if (cmd !== undefined) await w.write(`${cmd}\r\n`);
  const r = await smtpReply(w);
  if (!ok.includes(r.code)) throw new MailboxError(`${stage}: ${r.code} ${r.text}`.slice(0, 300), r.code, stage);
  return r;
}

/** Lines that start with a dot get a second one (RFC 5321 4.5.2); every line ends in CRLF. */
const dotStuff = (raw: string): string => raw.replace(/\r?\n/g, "\r\n").split("\r\n").map((l) => (l.startsWith(".") ? `.${l}` : l)).join("\r\n");

/**
 * One message through the mailbox's SMTP server; without `msg`, only the sign-in (the console's "Test" button). The
 * answer is the server's last words ("2.0.0 OK … – gsmtp"), which name the queued message.
 */
export async function smtpSend(dial: Dial, cfg: SmtpConfig, msg?: { from: string; to: string; raw: string }): Promise<string> {
  const tls = cfg.port === 465 ? "on" : "starttls";
  const w = new Wire(await dial(cfg.host, cfg.port, tls));
  try {
    await smtpStep(w, [220], "greeting");
    await smtpStep(w, [250], "EHLO", "EHLO kleooai.com");
    if (tls === "starttls") {
      await smtpStep(w, [220], "STARTTLS", "STARTTLS");
      await w.upgrade();
      await smtpStep(w, [250], "EHLO", "EHLO kleooai.com");
    }
    await smtpStep(w, [235], "AUTH", `AUTH PLAIN ${b64(`\u0000${cfg.user}\u0000${cfg.pass}`)}`);
    if (!msg) { await w.write("QUIT\r\n"); return "signed in"; }
    await smtpStep(w, [250], "MAIL FROM", `MAIL FROM:<${msg.from}>`);
    await smtpStep(w, [250, 251], "RCPT TO", `RCPT TO:<${msg.to}>`);
    await smtpStep(w, [354], "DATA", "DATA");
    await w.write(`${dotStuff(msg.raw)}\r\n.\r\n`);
    const done = await smtpStep(w, [250], "message");
    await w.write("QUIT\r\n");
    return done.text;
  } finally {
    await w.close();
  }
}

/** What a refusal means for whoever comes next: the address is bad, Kleo's side is wrong, or try again later. */
export function smtpTrouble(e: unknown): "address" | "sender" | "later" {
  const err = e as MailboxError;
  const code = err?.code ?? 0;
  const text = String(err?.message ?? e);
  if (err?.stage === "RCPT TO" && code >= 500) return "address";
  if (code === 535 || code === 534 || code === 530 || err?.stage === "AUTH" || /auth|credential|password|username/i.test(text) && code >= 500) return "sender";
  if (err?.stage === "MAIL FROM" && code >= 500) return "sender";
  return "later";
}

// ── the message ──────────────────────────────────────────────────────────────────────────────────────────────────

/** RFC 2047 for a header value that is not plain ASCII. */
const word = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?utf-8?B?${b64(s)}?=`);
const nameAddr = (name: string, addr: string): string => (name ? `${/^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "")}"` : word(name)} <${addr}>` : `<${addr}>`);

/** Quoted-printable (RFC 2045): UTF-8 bytes, soft breaks before 76 characters, CRLF kept as hard breaks. */
export function quotedPrintable(text: string): string {
  return text.replace(/\r?\n/g, "\n").split("\n").map((line) => {
    let out = "", cur = "";
    const bytes = enc.encode(line);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      const piece = plain ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      if (cur.length + piece.length > 75) { out += `${cur}=\r\n`; cur = ""; }
      cur += piece;
    }
    return out + cur;
  }).join("\r\n");
}

export interface Outgoing {
  fromName: string; fromAddr: string; to: string; subject: string; text: string; messageId: string;
  inReplyTo?: string | null; references?: string[]; unsubscribeUrl?: string; unsubscribeMailto?: string; date?: Date;
}

/** The whole message, headers and quoted-printable plain text, as the SMTP DATA wants it. */
export function buildMime(o: Outgoing): string {
  const h = [
    `From: ${nameAddr(o.fromName, o.fromAddr)}`,
    `To: <${o.to}>`,
    `Subject: ${word(o.subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${(o.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${o.messageId}`,
  ];
  if (o.inReplyTo) h.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.references?.length) h.push(`References: ${o.references.join(" ")}`);
  if (o.unsubscribeUrl) {
    h.push(`List-Unsubscribe: <${o.unsubscribeUrl}>${o.unsubscribeMailto ? `, <mailto:${o.unsubscribeMailto}?subject=unsubscribe>` : ""}`);
    h.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }
  h.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable");
  return `${h.join("\r\n")}\r\n\r\n${quotedPrintable(o.text)}`;
}

// ── IMAP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImapConfig { host: string; port: number; user: string; pass: string }
export interface Incoming {
  uid: number; from: string; fromName: string; subject: string; date: string | null; messageId: string | null;
  inReplyTo: string | null; references: string[]; autoSubmitted: string | null; failedRecipients: string[]; text: string;
}

const quote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const imapDate = (d: Date): string => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

/** One tagged command: every untagged line (with its literals, in order) until the tag's own answer. */
async function imapCmd(w: Wire, tag: string, cmd: string): Promise<{ lines: { text: string; literals: string[] }[]; done: string }> {
  await w.write(`${tag} ${cmd}\r\n`);
  const lines: { text: string; literals: string[] }[] = [];
  for (;;) {
    let text = await w.line();
    if (text.startsWith(`${tag} `)) {
      if (!/^\S+ OK/i.test(text)) throw new MailboxError(`${cmd.split(" ")[0]}: ${text.slice(tag.length + 1)}`.slice(0, 300), 0, cmd.split(" ")[0]);
      return { lines, done: text };
    }
    const literals: string[] = [];
    // A line that ends in {n} carries n bytes next, then the rest of the line.
    for (let m = text.match(/\{(\d+)\}$/); m; m = text.match(/\{(\d+)\}$/)) {
      literals.push(await w.bytes(Number(m[1])));
      text = `${text.slice(0, -m[0].length)}\u0000${await w.line()}`;
    }
    lines.push({ text, literals });
  }
}

/** RFC 2047 words in a header ("=?utf-8?Q?Re=3A_hi?=") back to text. */
export function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, charset: string, kind: string, data: string) => {
    try {
      const bytes = kind.toUpperCase() === "B"
        ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
        : Uint8Array.from(data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_x, hx: string) => String.fromCharCode(parseInt(hx, 16))), (c) => c.charCodeAt(0));
      return new TextDecoder(charset.toLowerCase() === "utf8" ? "utf-8" : charset).decode(bytes);
    } catch { return data; }
  });
}

/** Unfolded header fields, lower-case names. */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

const qpDecode = (s: string): string => {
  const bytes: number[] = [];
  const t = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(...enc.encode(t[i]));
  }
  return dec.decode(new Uint8Array(bytes));
};
const b64Decode = (s: string): string => { try { return dec.decode(Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0))); } catch { return ""; } };
const decodePart = (body: string, cte: string): string => /quoted-printable/i.test(cte) ? qpDecode(body) : /base64/i.test(cte) ? b64Decode(body) : body;
const stripHtml = (s: string): string => s.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, " ");

/**
 * The readable text of a message body (possibly cut short): the text/plain part of a multipart one, else its HTML
 * made plain; the quoted earlier message and the signature delimiter onwards are dropped.
 */
export function readableText(contentType: string, cte: string, body: string): string {
  let text = "";
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
  if (/multipart\//i.test(contentType) && boundary) {
    const parts = body.split(`--${boundary}`).slice(1).map((p) => {
      const cut = p.search(/\r?\n\r?\n/);
      const head = parseHeaders(cut >= 0 ? p.slice(0, cut) : "");
      return { type: head["content-type"] ?? "text/plain", cte: head["content-transfer-encoding"] ?? "", body: cut >= 0 ? p.slice(cut).replace(/^\r?\n\r?\n/, "") : "" };
    });
    const plain = parts.find((p) => /text\/plain/i.test(p.type));
    const html = parts.find((p) => /text\/html/i.test(p.type));
    const nested = parts.find((p) => /multipart\//i.test(p.type));
    text = plain ? decodePart(plain.body, plain.cte) : html ? stripHtml(decodePart(html.body, html.cte)) : nested ? readableText(nested.type, nested.cte, nested.body) : "";
  } else {
    text = decodePart(body, cte);
    if (/text\/html/i.test(contentType)) text = stripHtml(text);
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const keep: string[] = [];
  for (const l of lines) {
    if (/^On .{4,200}wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || l.trim() === "--" || /^From: .+@/i.test(l.trim())) break;
    if (!l.startsWith(">")) keep.push(l);
  }
  return keep.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const FIELDS = "FROM SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES AUTO-SUBMITTED X-FAILED-RECIPIENTS CONTENT-TYPE CONTENT-TRANSFER-ENCODING";

/**
 * The inbox's messages newer than `afterUid` (or, when the mailbox was rebuilt and its UIDVALIDITY changed, those of
 * the last few days), at most `max`, oldest first. Nothing is marked read: the owner still sees every reply as new.
 */
export async function imapFetch(dial: Dial, cfg: ImapConfig, since: { uidValidity: number | null; afterUid: number; days: number; max?: number }, now = new Date()): Promise<{ uidValidity: number; lastUid: number; messages: Incoming[] }> {
  const w = new Wire(await dial(cfg.host, cfg.port, "on"));
  let n = 0;
  const tag = () => `K${++n}`;
  try {
    const hello = await w.line();
    if (!/^\* (OK|PREAUTH)/i.test(hello)) throw new MailboxError(`greeting: ${hello}`.slice(0, 200), 0, "greeting");
    await imapCmd(w, tag(), `LOGIN ${quote(cfg.user)} ${quote(cfg.pass)}`);
    const sel = await imapCmd(w, tag(), "SELECT INBOX");
    const uidValidity = Number(sel.lines.map((l) => l.text.match(/UIDVALIDITY (\d+)/i)?.[1]).find(Boolean) ?? 0);
    const same = since.uidValidity !== null && since.uidValidity === uidValidity;
    const sinceDay = imapDate(new Date(now.getTime() - since.days * 86_400_000));
    const search = await imapCmd(w, tag(), same ? `UID SEARCH UID ${since.afterUid + 1}:* SINCE ${sinceDay}` : `UID SEARCH SINCE ${sinceDay}`);
    // "UID n:*" always answers the newest message even when it is older than n: keep only the new ones.
    const uids = search.lines.flatMap((l) => (/^\* SEARCH/i.test(l.text) ? l.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/).filter(Boolean).map(Number) : []))
      .filter((u) => Number.isFinite(u) && (!same || u > since.afterUid)).sort((a, b) => a - b).slice(0, since.max ?? 40);
    const messages: Incoming[] = [];
    if (uids.length) {
      const res = await imapCmd(w, tag(), `UID FETCH ${uids.join(",")} (UID BODY.PEEK[HEADER.FIELDS (${FIELDS})] BODY.PEEK[TEXT]<0.6000>)`);
      for (const l of res.lines) {
        if (!/^\* \d+ FETCH/i.test(l.text)) continue;
        const uid = Number(l.text.match(/UID (\d+)/i)?.[1] ?? 0);
        // Each literal follows the name of its section in the text before it.
        const segs = l.text.split("\u0000");
        let header = "", body = "";
        l.literals.forEach((lit, i) => { if (/HEADER/i.test(segs[i] ?? "")) header = lit; else if (/TEXT\]/i.test(segs[i] ?? "")) body = lit; });
        const f = parseHeaders(header);
        const fromRaw = decodeWords(f.from ?? "");
        const addr = (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? "").trim().toLowerCase();
        messages.push({
          uid, from: addr, fromName: fromRaw.replace(/<[^>]*>/, "").replace(/"/g, "").trim(), subject: decodeWords(f.subject ?? ""),
          date: f.date ?? null, messageId: f["message-id"] ?? null, inReplyTo: f["in-reply-to"] ?? null,
          references: (f.references ?? "").split(/\s+/).filter(Boolean), autoSubmitted: f["auto-submitted"] ?? null,
          failedRecipients: (f["x-failed-recipients"] ?? "").split(/[,\s]+/).filter((x) => x.includes("@")).map((x) => x.toLowerCase()),
          text: readableText(f["content-type"] ?? "text/plain", f["content-transfer-encoding"] ?? "", body).slice(0, 4000),
        });
      }
    }
    try { await w.write(`${tag()} LOGOUT\r\n`); } catch { /* closing anyway */ }
    const lastUid = Math.max(same ? since.afterUid : 0, ...uids, 0);
    return { uidValidity, lastUid, messages: messages.sort((a, b) => a.uid - b.uid) };
  } finally {
    await w.close();
  }
}

/** Signs in to IMAP and leaves: the console's check that the reading half works too. */
export async function imapLogin(dial: Dial, cfg: ImapConfig): Promise<void> {
  const w = new Wire(await dial(cfg.host, cfg.port, "on"));
  try {
    const hello = await w.line();
    if (!/^\* (OK|PREAUTH)/i.test(hello)) throw new MailboxError(`greeting: ${hello}`.slice(0, 200));
    await imapCmd(w, "K1", `LOGIN ${quote(cfg.user)} ${quote(cfg.pass)}`);
    try { await w.write("K2 LOGOUT\r\n"); } catch { /* closing anyway */ }
  } finally {
    await w.close();
  }
}
