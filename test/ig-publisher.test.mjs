/**
 * The Instagram publisher (src/ig/, wrangler.ig.jsonc, the SQL of scripts/ig-schedule.mjs), inside one process: the
 * Worker's minute (tick) on a D1 look-alike (node:sqlite), an in-memory R2 holding hand-built MP4 files, and a scripted
 * graph.instagram.com. Covers the entry's rules (New Zealand time and its clock changes, the US-evening slot, hashtags,
 * bait, the 3-hour gap, the address), the MP4 reader against Meta's Reels specification, and the job: the cloud check
 * creates nothing, an unapproved post never goes out, the container 7 minutes early, polling at most 5 times, a second
 * container, publishing on the minute, a lost answer that never publishes twice, Meta's quota, a change after the "sì",
 * the account the token belongs to, two minutes running at once, the token renewed and sealed, and the token never in a
 * URL, a row, an event, a log line or an e-mail.
 * Run: node --test test/ig-publisher.test.mjs
 */
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "cloudflare:email") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export class EmailMessage { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } }") };
  return next(s, c);
}`));
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  approvalHash, captionProblems, containerParams, defaultId, fmtNz, gapProblems, hashtags, inUsEvening, mediaKey, parseAt,
  validateEntry, VIDEO_EXT,
} from "../src/ig/rules.ts";
import { inspectMp4, mp4Summary, specProblems } from "../src/ig/mp4.ts";
import { POLLS_MAX, SCHEMA, tick } from "../src/ig/publisher.ts";
import { approveSql, cancelSql, insertPostSql, recheckSql } from "../src/ig/sql.ts";
import { graphClient } from "../src/ig/graph.ts";

const MIN = 60_000, DAY = 24 * 60 * MIN;

// ── D1, R2 ───────────────────────────────────────────────────────────────────────────────────────────────────────

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
}
class FakeR2 {
  constructor() { this.objects = new Map(); this.n = 0; }
  put(key, bytes, contentType) { this.objects.set(key, { bytes, contentType, etag: `etag${++this.n}` }); }
  async head(key) {
    const o = this.objects.get(key);
    return o ? { key, size: o.bytes.length, etag: o.etag, httpMetadata: { contentType: o.contentType } } : null;
  }
  async get(key, opts) {
    const o = this.objects.get(key);
    if (!o) return null;
    const offset = opts?.range?.offset ?? 0, length = opts?.range?.length ?? o.bytes.length - offset;
    const part = o.bytes.slice(offset, offset + length);
    return { async arrayBuffer() { return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength); } };
  }
}

// ── MP4 files built box by box ───────────────────────────────────────────────────────────────────────────────────

const te = new TextEncoder();
const u8 = (...n) => Uint8Array.from(n);
const zeros = (n) => new Uint8Array(n);
const ascii = (s) => te.encode(s);
function cat(...parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; }
const box = (type, ...payload) => { const body = cat(...payload); return cat(u32(8 + body.length), ascii(type), body); };
const full = (type, version, ...payload) => box(type, u8(version, 0, 0, 0), ...payload);

const IDENTITY = cat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));
const ROT90 = cat(u32(0), u32(0x10000), u32(0), u32(0xffff0000), u32(0), u32(0), u32(0), u32(0), u32(0x40000000));
const tkhd = (w, h, matrix = IDENTITY) =>
  full("tkhd", 0, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(w * 65536), u32(h * 65536));
const mdhd = (timescale, duration) => full("mdhd", 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
const hdlr = (kind) => full("hdlr", 0, u32(0), ascii(kind), zeros(12), u8(0));
const avcC = (profile, chroma) => box("avcC", u8(1, profile, 0, 40, 0xff, 0xe1), u16(4), u8(0x67, profile, 0, 40), u8(1), u16(2), u8(0x68, 0xce),
  ...(chroma === undefined ? [] : [u8(0xfc | chroma, 0xf8, 0xf8, 0)]));
const hvcC = (chroma) => box("hvcC", u8(1, 1), zeros(14), u8(0xfc | chroma, 0xf8, 0xf8, 0, 0, 0x0f));

function videoTrak({ w = 1080, h = 1920, fps = 30, seconds = 15, codec = "avc1", profile = 100, chroma, kbps = 12_000, matrix, editTime } = {}) {
  const timescale = 15360, delta = timescale / fps, frames = Math.round(seconds * fps);
  const each = Math.round(((kbps * 1000) / 8) * seconds / frames);
  const config = codec.startsWith("avc") ? avcC(profile, chroma) : hvcC(chroma ?? 1);
  const entry = box(codec, zeros(6), u16(1), zeros(16), u16(w), u16(h), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff), config);
  const stbl = box("stbl", full("stsd", 0, u32(1), entry), full("stts", 0, u32(1), u32(frames), u32(delta)), full("stsz", 0, u32(each), u32(frames)));
  const edts = editTime === undefined ? [] : [box("edts", full("elst", 0, u32(1), u32(seconds * 1000), u32(editTime), u32(0x10000)))];
  return box("trak", tkhd(w, h, matrix), ...edts, box("mdia", mdhd(timescale, frames * delta), hdlr("vide"), box("minf", stbl)));
}
function audioTrak({ rate = 48_000, channels = 2, seconds = 15, kbps = 320, codec = "mp4a" } = {}) {
  const frames = Math.round((seconds * rate) / 1024), each = Math.round(((kbps * 1000) / 8) * seconds / frames);
  const entry = box(codec, zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(rate * 65536));
  const stbl = box("stbl", full("stsd", 0, u32(1), entry), full("stts", 0, u32(1), u32(frames), u32(1024)), full("stsz", 0, u32(each), u32(frames)));
  return box("trak", tkhd(0, 0), box("mdia", mdhd(rate, frames * 1024), hdlr("soun"), box("minf", stbl)));
}
function mp4({ faststart = true, seconds = 15, video = {}, audio = {}, sound = true } = {}) {
  const moov = box("moov", full("mvhd", 0, u32(0), u32(0), u32(1000), u32(seconds * 1000), zeros(80)),
    videoTrak({ seconds, ...video }), ...(sound ? [audioTrak({ seconds, ...audio })] : []));
  const ftyp = box("ftyp", ascii("isom"), u32(512), ascii("isomiso2avc1mp41"));
  const mdat = box("mdat", zeros(4096));
  return faststart ? cat(ftyp, moov, mdat) : cat(ftyp, mdat, moov);
}
const readerOf = (bytes) => async (offset, length) => bytes.slice(offset, offset + length);
const inspect = (bytes, size = bytes.length) => inspectMp4(size, readerOf(bytes));

// ── graph.instagram.com, scripted ────────────────────────────────────────────────────────────────────────────────

const TOKEN = "IGAAtest-long-lived-token-0123456789abcdef";
const RENEWED = "IGAArenewed-token-fedcba9876543210zz";
const PASTED = "IGAAanother-pasted-token-5555555555";
const KEY = "dGVzdC1zZWFsaW5nLWtleS0zMi1ieXRlcy1sb25nIQ==";
const IG_ID = "17841400000000001";
const VIDEO = "https://media.kleooai.com/ig/2026-11-03-rx7-reveal-k2m4.mp4";
const T0 = Date.parse("2026-11-03T00:30:00Z"); // Tue 3 Nov 2026, 13:30 NZDT = 19:30 EST on the 2nd
const ENTRY = { video: VIDEO, caption: "This RX-7 doesn't exist. Made with Kleo. #rx7 #jdm #aivideo #kleo", at: "2026-11-03 13:30", ai: true };
const igStamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");

function setup(opts = {}) {
  const { username = "kleooai", statuses = ["IN_PROGRESS", "FINISHED"], recent = [], video } = opts;
  // "token" and "key" may be given as undefined on purpose: no token pasted, no sealing key.
  const token = "token" in opts ? opts.token : TOKEN, key = "key" in opts ? opts.key : KEY;
  const env = {
    DB: new FakeD1(), MEDIA: new FakeR2(), IG_ACCESS_TOKEN: token, IG_TOKEN_KEY: key, IG_API_VERSION: "v26.0", IG_USERNAME: "kleooai",
    IG_MEDIA_HOST: "media.kleooai.com", OWNER_MAIL: { sent: [], async send(m) { this.sent.push(m); } },
  };
  env.MEDIA.put("ig/2026-11-03-rx7-reveal-k2m4.mp4", video ?? mp4(), "video/mp4");
  const g = {
    calls: [], valid: new Set([TOKEN, PASTED]), statuses: [...statuses], recent: [...recent], quota: { usage: 3, total: 100 },
    username, published: [], containers: 0, media: 0, publishFails: [], now: 0,
  };
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const fetcher = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? "GET", auth = init.headers?.authorization ?? null;
    const body = init.body ? JSON.parse(init.body) : null;
    g.calls.push({ method, url, host: u.hostname, path: u.pathname, auth, body, query: Object.fromEntries(u.searchParams) });
    if (u.hostname === "media.kleooai.com") {
      const o = env.MEDIA.objects.get(decodeURIComponent(u.pathname.slice(1)));
      return o ? new Response(null, { status: 200, headers: { "content-length": String(o.bytes.length) } }) : new Response(null, { status: 404 });
    }
    assert.equal(u.hostname, "graph.instagram.com");
    if (u.pathname === "/refresh_access_token") {
      if (!g.valid.has(u.searchParams.get("access_token")) || u.searchParams.get("grant_type") !== "ig_refresh_token") return json({ error: { message: "bad", code: 190 } }, 400);
      g.valid.add(RENEWED);
      return json({ access_token: RENEWED, token_type: "bearer", expires_in: 5_184_000 });
    }
    const given = auth?.replace(/^Bearer /, "") ?? u.searchParams.get("access_token") ?? body?.access_token;
    if (!g.valid.has(given)) return json({ error: { message: "Invalid OAuth access token - Cannot parse access token", type: "OAuthException", code: 190 } }, 400);
    g.lastToken = given;
    const p = u.pathname.replace(/^\/v26\.0\//, "");
    if (method === "GET" && p === "me") return json({ user_id: IG_ID, username: g.username, account_type: "MEDIA_CREATOR", id: "999" });
    if (method === "GET" && p === `${IG_ID}/content_publishing_limit`) return json({ data: [{ quota_usage: g.quota.usage, config: { quota_total: g.quota.total, quota_duration: 86400 } }] });
    if (method === "GET" && p === `${IG_ID}/media`) return json({ data: g.recent.map((m) => ({ id: m.id, timestamp: igStamp(m.ms), permalink: m.permalink })) });
    if (method === "POST" && p === `${IG_ID}/media`) return json({ id: `c${++g.containers}` });
    if (method === "POST" && p === `${IG_ID}/media_publish`) {
      const fail = g.publishFails.shift();
      if (fail === "lost-before") throw new TypeError("network connection lost");
      if (fail === "refused") return json({ error: { message: "The video could not be published", code: 100, error_subcode: 2207051 } }, 400);
      const id = `m${++g.media}`;
      g.published.push(body.creation_id);
      g.recent.unshift({ id, ms: g.now, permalink: `https://www.instagram.com/reel/RX7${g.media}/` });
      if (fail === "lost-after") throw new TypeError("network connection lost");
      return json({ id });
    }
    const container = /^c\d+$/.exec(p);
    if (method === "GET" && container) {
      const code = g.published.includes(p) ? "PUBLISHED" : g.statuses.length > 1 ? g.statuses.shift() : g.statuses[0];
      return json({ id: p, status_code: code, ...(code === "ERROR" ? { status: "Error: the video format is not supported (2207026)" } : {}) });
    }
    const media = /^m\d+$/.exec(p);
    if (method === "GET" && media) return json({ id: p, permalink: g.recent.find((m) => m.id === p)?.permalink });
    return json({ error: { message: `unknown path ${method} ${p}`, code: 100 } }, 400);
  };
  const logs = [];
  const run = async (ms) => {
    g.now = ms;
    const log = console.log, error = console.error;
    console.log = (...a) => logs.push(a.join(" "));
    console.error = (...a) => logs.push(a.join(" "));
    try { await tick(env, ms, fetcher); } finally { console.log = log; console.error = error; }
  };
  return { env, g, run, logs, fetcher };
}

const row = (env, id) => ({ ...env.DB.db.prepare("SELECT * FROM ig_posts WHERE id = ?").get(id) });
const events = (env, id) => env.DB.db.prepare("SELECT what FROM ig_events WHERE post_id = ? ORDER BY id").all(id).map((e) => e.what);
function addPost(env, entry, nowMs) {
  for (const sql of SCHEMA) env.DB.db.exec(sql);
  const v = validateEntry(entry, nowMs);
  assert.deepEqual(v.errors, []);
  env.DB.db.exec(insertPostSql(v.post, new Date(nowMs).toISOString()));
  return v.post;
}
async function approve(env, id, nowMs) {
  const p = row(env, id);
  env.DB.db.exec(approveSql(id, await approvalHash(p, p.video_etag), "sì", new Date(nowMs).toISOString()));
  assert.ok(row(env, id).approved_at, "approved");
}
const posts = (g, path) => g.calls.filter((c) => c.method === "POST" && c.path.endsWith(path));
function assertNoToken(env, g, logs, ...tokens) {
  const stored = JSON.stringify([env.DB.db.prepare("SELECT * FROM ig_posts").all(), env.DB.db.prepare("SELECT * FROM ig_events").all(),
    env.DB.db.prepare("SELECT * FROM ig_token").all()]);
  const mails = env.OWNER_MAIL.sent.map((m) => m.raw).join("\n");
  for (const t of tokens) {
    assert.ok(!stored.includes(t), "a token in D1");
    assert.ok(!logs.join("\n").includes(t), "a token in the logs");
    assert.ok(!mails.includes(t), "a token in an e-mail");
    for (const c of g.calls) if (c.path !== "/refresh_access_token") assert.ok(!c.url.includes(t) && !JSON.stringify(c.body ?? {}).includes(t), `a token in ${c.method} ${c.path}`);
  }
}

// ── the rules ────────────────────────────────────────────────────────────────────────────────────────────────────

test("New Zealand time: NZDT, NZST, the night the clocks jump, ISO times", () => {
  assert.deepEqual(parseAt("2026-10-31 13:30"), { ms: Date.parse("2026-10-31T00:30:00Z") });
  assert.deepEqual(parseAt("2027-05-01 12:00"), { ms: Date.parse("2027-05-01T00:00:00Z") });
  assert.deepEqual(parseAt("2026-11-02T13:30+13:00"), { ms: Date.parse("2026-11-02T00:30:00Z") });
  assert.match(parseAt("2026-09-27 02:30").error, /does not exist/);
  assert.match(parseAt("tomorrow at 1").error, /not a time/);
  assert.match(parseAt("2026-13-01 10:00").error, /not a time/);
  assert.match(fmtNz(T0), /13:30 NZDT/);
});

test("the US-evening slot: 12:00-17:00 NZDT until 1 Nov, 13:00-18:00 NZDT from 2 Nov (ACCOUNT_RULES 18)", () => {
  const nz = (s) => parseAt(s).ms;
  assert.equal(inUsEvening(nz("2026-10-30 12:00")), true);
  assert.equal(inUsEvening(nz("2026-10-30 11:59")), false);
  assert.equal(inUsEvening(nz("2026-10-30 17:00")), true);
  assert.equal(inUsEvening(nz("2026-10-30 17:01")), false);
  assert.equal(inUsEvening(nz("2026-11-02 13:00")), true);
  assert.equal(inUsEvening(nz("2026-11-02 12:30")), false);
  assert.equal(inUsEvening(nz("2026-11-02 18:00")), true);
  assert.equal(inUsEvening(nz("2026-11-02 18:01")), false);
});

test("the caption: 5 hashtags at most, no #fyp/#viral, no bait, 2,200 characters", () => {
  assert.deepEqual(captionProblems("Five. #a1 #b2 #c3 #d4 #e5").errors, []);
  assert.match(captionProblems("Six. #a1 #b2 #c3 #d4 #e5 #f6").errors[0], /6 hashtags/);
  assert.deepEqual(hashtags("#Kleo #kleo and #KLEO, not a#tag, &#39;"), ["kleo"]);
  assert.match(captionProblems("#FYP #cars").errors.join(), /#fyp/);
  assert.match(captionProblems("#viralvideo").errors.join(), /#viralvideo/);
  assert.match(captionProblems("Follow for part 2!").errors.join(), /engagement bait/);
  assert.match(captionProblems("Tag a friend who needs this").errors.join(), /engagement bait/);
  assert.match(captionProblems("Comment KLEO for the link").warnings.join(), /DMs/);
  assert.match(captionProblems("x".repeat(2201)).errors.join(), /2201 characters/);
  assert.deepEqual(captionProblems("🚗 ".repeat(1100)).errors, []);
});

test("the entry: AI label on, known fields, far enough ahead, in the slot unless the owner chose otherwise, one address", () => {
  const now = T0 - DAY;
  const ok = validateEntry(ENTRY, now);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.post.id, "ig-2026-11-03-rx7-reveal-k2m4");
  assert.equal(ok.post.publish_at, "2026-11-03T00:30:00.000Z");
  assert.match(validateEntry({ ...ENTRY, ai: false }, now).errors.join(), /AI label/);
  assert.match(validateEntry({ ...ENTRY, AI: true }, now).errors.join(), /Unknown field "AI"/);
  assert.match(validateEntry(ENTRY, T0 - 5 * MIN).errors.join(), /too soon/);
  assert.match(validateEntry(ENTRY, T0 - 60 * DAY).errors.join(), /more than 45 days/);
  const early = { ...ENTRY, at: "2026-11-03 10:00" };
  assert.match(validateEntry(early, now).errors.join(), /US-evening slot/);
  const chosen = validateEntry({ ...early, outside_window: true }, now);
  assert.deepEqual(chosen.errors, []);
  assert.match(chosen.warnings.join(), /owner's choice/);
  assert.match(validateEntry({ ...ENTRY, video: "https://example.com/ig/a.mp4" }, now).errors.join(), /must be an \.mp4/);
  assert.equal(mediaKey("http://media.kleooai.com/ig/a.mp4", "media.kleooai.com", VIDEO_EXT), null);
  assert.equal(mediaKey("https://media.kleooai.com/ig/a.mp4?v=2", "media.kleooai.com", VIDEO_EXT), null);
  assert.equal(mediaKey("https://media.kleooai.com/ig/a b.mp4", "media.kleooai.com", VIDEO_EXT), null);
  assert.equal(mediaKey("https://media.kleooai.com/ig/a.mp4.exe", "media.kleooai.com", VIDEO_EXT), null);
  assert.equal(mediaKey("https://media.kleooai.com/ig/a.mp4", "media.kleooai.com", VIDEO_EXT), "ig/a.mp4");
  assert.equal(defaultId("https://media.kleooai.com/ig/My Reel!.mp4", T0), "ig-2026-11-03-my-reel");
});

test("three hours between posts (ACCOUNT_RULES 16), and the request Meta receives", async () => {
  assert.equal(gapProblems(T0, [{ label: "a", ms: T0 - 179 * MIN }]).length, 1);
  assert.equal(gapProblems(T0, [{ label: "a", ms: T0 + 180 * MIN }]).length, 0);
  const post = validateEntry({ ...ENTRY, trial: "MANUAL", thumb_offset_ms: 1200 }, T0 - DAY).post;
  assert.deepEqual(containerParams(post), {
    media_type: "REELS", video_url: VIDEO, caption: ENTRY.caption, share_to_feed: true, is_ai_generated: true,
    thumb_offset: 1200, trial_params: { graduation_strategy: "MANUAL" },
  });
  const covered = validateEntry({ ...ENTRY, cover: "https://media.kleooai.com/ig/c.jpg", thumb_offset_ms: 5 }, T0 - DAY);
  assert.equal(containerParams(covered.post).cover_url, "https://media.kleooai.com/ig/c.jpg");
  assert.equal(containerParams(covered.post).thumb_offset, undefined);
  const h = await approvalHash(post, "e1");
  assert.notEqual(h, await approvalHash({ ...post, caption: `${post.caption}!` }, "e1"));
  assert.notEqual(h, await approvalHash(post, "e2"));
});

test("the SQL of the owner's side: any caption goes in intact; approve, cancel and re-check only from the states they may", () => {
  const db = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) db.exec(sql);
  const caption = "It's \"real\"? No ' -- ; DROP TABLE ig_posts; 🚗\nline two #kleo";
  const post = validateEntry({ ...ENTRY, caption }, T0 - DAY).post;
  db.exec(insertPostSql(post, "2026-11-01T00:00:00.000Z"));
  const get = () => db.prepare("SELECT * FROM ig_posts WHERE id = ?").get(post.id);
  assert.equal(get().caption, caption);
  assert.equal(get().state, "new");
  db.exec(approveSql(post.id, "h", "sì", "2026-11-01T00:00:00.000Z"));
  assert.equal(get().approved_at, null, "a post not yet checked cannot be approved");
  db.exec(recheckSql(post.id, "2026-11-01T00:00:00.000Z"));
  assert.equal(get().state, "new");
  db.prepare("UPDATE ig_posts SET state = 'checked' WHERE id = ?").run(post.id);
  db.exec(approveSql(post.id, "h", "sì", "2026-11-01T00:00:00.000Z"));
  assert.equal(get().approved_note, "sì");
  db.exec(recheckSql(post.id, "2026-11-01T00:00:00.000Z"));
  assert.equal(get().state, "checked", "an approved post is not re-checked");
  db.prepare("UPDATE ig_posts SET state = 'publishing' WHERE id = ?").run(post.id);
  db.exec(cancelSql(post.id, "2026-11-01T00:00:00.000Z"));
  assert.equal(get().state, "publishing", "a post being published cannot be cancelled");
  db.prepare("UPDATE ig_posts SET state = 'ready' WHERE id = ?").run(post.id);
  db.exec(cancelSql(post.id, "2026-11-01T00:00:00.000Z"));
  assert.equal(get().state, "cancelled");
});

// ── the file ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("MP4: the owner's file is read from its moov box and passes Meta's specification", async () => {
  const info = await inspect(mp4());
  assert.equal(info.faststart, true);
  assert.deepEqual(info.boxes, ["ftyp", "moov", "mdat"]);
  assert.equal(info.durationS, 15);
  assert.equal(info.video.codec, "avc1");
  assert.equal(info.video.width, 1080);
  assert.equal(info.video.height, 1920);
  assert.equal(info.video.fps, 30);
  assert.equal(info.video.profile, 100);
  assert.equal(info.video.chroma, 1);
  assert.ok(Math.abs(info.video.kbps - 12_000) < 50, String(info.video.kbps));
  assert.equal(info.audio.sampleRate, 48_000);
  assert.equal(info.audio.channels, 2);
  assert.ok(Math.abs(info.audio.kbps - 320) < 5, String(info.audio.kbps));
  const s = specProblems(info);
  assert.deepEqual(s.errors, []);
  assert.match(s.warnings.join(), /128 kb\/s/);
  assert.match(mp4Summary(info), /^1080x1920 H\.264 30 fps 12\.0 Mb\/s · AAC 48 kHz stereo 3\d\d kb\/s · 15\.0 s · .* · moov at the front$/);
});

test("MP4: what Meta refuses is an error, what only misses the owner's quality is a warning", async () => {
  const errs = async (o, size) => specProblems(await inspect(mp4(o), size)).errors.join(" | ");
  const warns = async (o) => specProblems(await inspect(mp4(o))).warnings.join(" | ");
  assert.match(await errs({ faststart: false }), /moov box is after/);
  assert.match(await errs({ video: { w: 2160, h: 3840 } }), /1920 columns/);
  assert.match(await errs({ video: { fps: 20 } }), /23 to 60/);
  assert.match(await errs({ video: { kbps: 30_000 } }), /at most 25/);
  assert.match(await errs({ video: { profile: 122, chroma: 2 } }), /4:2:0/);
  assert.match(await errs({ seconds: 2 }), /at least 3 s/);
  assert.match(await errs({ seconds: 1000 }), /at most 15/);
  assert.match(await errs({}, 400 * 1024 * 1024), /300 MB/);
  assert.match(await errs({ audio: { rate: 44_100, channels: 6 } }), /mono or stereo/);
  assert.match(await errs({ audio: { codec: "Opus" } }), /takes AAC/);
  assert.match(await warns({ video: { w: 720, h: 1280 } }), /720x1280; the owner's Instagram file is 1080x1920/);
  assert.match(await warns({ video: { fps: 60 } }), /plays reels at 30/);
  assert.match(await warns({ video: { editTime: 1024 } }), /edit list/);
  assert.match(await warns({ sound: false }), /no sound/);
  assert.deepEqual(specProblems(await inspect(mp4({ video: { codec: "hvc1", chroma: 1 } }))).errors, []);
  const turned = await inspect(mp4({ video: { w: 1920, h: 1080, matrix: ROT90 } }));
  assert.deepEqual([turned.video.width, turned.video.height], [1080, 1920]);
  const cut = mp4({ faststart: false });
  assert.match(specProblems(await inspect(cut.slice(0, cut.length - 200))).errors.join(), /cut short|broken|No moov/);
});

// ── the job ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("an approved reel: the cloud check creates nothing, the container 7 minutes early, published on the minute", async () => {
  const { env, g, run, logs } = setup();
  const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
  await run(T0 - 60 * MIN);
  let r = row(env, post.id);
  assert.equal(r.state, "checked", r.error);
  const report = JSON.parse(r.check_json);
  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.account, `@kleooai (MEDIA_CREATOR, ${IG_ID})`);
  assert.equal(report.quota, "3 of 100 posts in the last 24 hours");
  assert.match(report.video, /^1080x1920 H\.264 30 fps/);
  assert.deepEqual(report.request, { media_type: "REELS", video_url: VIDEO, caption: ENTRY.caption, share_to_feed: true, is_ai_generated: true });
  assert.equal(g.calls.filter((c) => c.method !== "GET" && c.method !== "HEAD").length, 0, "the check only asks");
  assert.ok(g.calls.some((c) => c.method === "HEAD" && c.host === "media.kleooai.com"), "the public address Meta will fetch is checked");

  await run(T0 - 7 * MIN);
  assert.equal(row(env, post.id).state, "checked", "nothing happens without the owner's sì");
  await approve(env, post.id, T0 - 30 * MIN);
  await run(T0 - 8 * MIN);
  assert.equal(row(env, post.id).state, "checked", "not before the lead time");
  await run(T0 - 7 * MIN);
  r = row(env, post.id);
  assert.equal(r.state, "container");
  assert.equal(r.container_id, "c1");
  const create = posts(g, `${IG_ID}/media`);
  assert.equal(create.length, 1);
  assert.deepEqual(create[0].body, { media_type: "REELS", video_url: VIDEO, caption: ENTRY.caption, share_to_feed: true, is_ai_generated: true });
  assert.equal(create[0].auth, `Bearer ${TOKEN}`);
  assert.match(create[0].url, /^https:\/\/graph\.instagram\.com\/v26\.0\//);

  await run(T0 - 6 * MIN);
  assert.equal(row(env, post.id).state, "container");
  await run(T0 - 5 * MIN);
  assert.equal(row(env, post.id).state, "ready");
  await run(T0 - 1 * MIN);
  assert.equal(posts(g, "/media_publish").length, 0, "not before its minute");
  await run(T0);
  r = row(env, post.id);
  assert.equal(r.state, "published");
  assert.equal(r.media_id, "m1");
  assert.equal(r.permalink, "https://www.instagram.com/reel/RX71/");
  assert.equal(r.published_at, new Date(T0).toISOString());
  assert.deepEqual(posts(g, "/media_publish").map((c) => c.body), [{ creation_id: "c1" }]);
  assert.ok(events(env, post.id).some((e) => e.includes("published: media m1 https://www.instagram.com/reel/RX71/")));
  assert.equal(env.OWNER_MAIL.sent.length, 1);
  assert.match(env.OWNER_MAIL.sent[0].raw, /Subject: Kleo Instagram: reel published/);
  assert.match(env.OWNER_MAIL.sent[0].raw, /https:\/\/www\.instagram\.com\/reel\/RX71\//);
  await run(T0 + MIN);
  assert.equal(posts(g, "/media_publish").length, 1);
  assertNoToken(env, g, logs, TOKEN);
});

test("never approved: no container, missed after the grace minutes, no e-mail", async () => {
  const { env, g, run } = setup();
  const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
  for (const m of [-60, -7, -6, -1, 0, 5, 15]) await run(T0 + m * MIN);
  assert.equal(row(env, post.id).state, "checked");
  await run(T0 + 16 * MIN);
  assert.equal(row(env, post.id).state, "missed");
  assert.equal(g.calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(env.OWNER_MAIL.sent.length, 0);
});

test("the cloud check refuses: no token, another account, the file missing (its address never asked), not faststart, a post 1 h before", async () => {
  {
    const { env, run } = setup({ token: undefined });
    const post = addPost(env, ENTRY, T0 - DAY);
    await run(T0 - DAY + MIN);
    assert.equal(row(env, post.id).state, "invalid");
    assert.match(row(env, post.id).error, /No Instagram token yet/);
  }
  {
    const { env, run } = setup({ username: "someone_else" });
    const post = addPost(env, ENTRY, T0 - DAY);
    await run(T0 - DAY + MIN);
    assert.match(row(env, post.id).error, /not @kleooai/);
  }
  {
    const { env, g, run } = setup();
    env.MEDIA.objects.clear();
    const post = addPost(env, ENTRY, T0 - DAY);
    await run(T0 - DAY + MIN);
    assert.match(row(env, post.id).error, /not in the R2 bucket kleo-media/);
    assert.equal(g.calls.filter((c) => c.host === "media.kleooai.com").length, 0, "a 404 asked before the upload stays cached for hours");
  }
  {
    const { env, run } = setup({ video: mp4({ faststart: false }) });
    const post = addPost(env, ENTRY, T0 - DAY);
    await run(T0 - DAY + MIN);
    assert.match(JSON.parse(row(env, post.id).check_json).errors.join(), /moov box is after/);
  }
  {
    const { env, run } = setup({ recent: [{ id: "m0", ms: T0 - 60 * MIN, permalink: "https://www.instagram.com/reel/BYHAND/" }] });
    const post = addPost(env, ENTRY, T0 - DAY);
    await run(T0 - DAY + MIN);
    assert.match(row(env, post.id).error, /Only 1 h from the post https:\/\/www\.instagram\.com\/reel\/BYHAND\/.*ACCOUNT_RULES 16/);
  }
});

test("the container fails: ERROR stops it and tells the owner; still processing after 5 polls gets one more container", async () => {
  {
    const { env, g, run } = setup({ statuses: ["ERROR"] });
    const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
    await run(T0 - 60 * MIN);
    await approve(env, post.id, T0 - 30 * MIN);
    await run(T0 - 7 * MIN);
    await run(T0 - 6 * MIN);
    assert.equal(row(env, post.id).state, "failed");
    assert.match(row(env, post.id).error, /ERROR: Error: the video format is not supported/);
    assert.equal(posts(g, "/media_publish").length, 0);
    assert.match(env.OWNER_MAIL.sent[0].raw, /Subject: Kleo Instagram: reel NOT published/);
  }
  {
    const { env, g, run } = setup({ statuses: [...Array(POLLS_MAX).fill("IN_PROGRESS"), "FINISHED"] });
    const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
    await run(T0 - 60 * MIN);
    await approve(env, post.id, T0 - 30 * MIN);
    for (let m = -7; m <= 0; m++) await run(T0 + m * MIN);
    const r = row(env, post.id);
    assert.equal(r.state, "published");
    assert.equal(r.container_id, "c2");
    assert.equal(posts(g, `${IG_ID}/media`).length, 2);
    assert.deepEqual(posts(g, "/media_publish").map((c) => c.body), [{ creation_id: "c2" }]);
  }
  {
    const { env, g, run } = setup({ statuses: ["IN_PROGRESS"] });
    const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
    await run(T0 - 60 * MIN);
    await approve(env, post.id, T0 - 30 * MIN);
    for (let m = -7; m <= 6; m++) await run(T0 + m * MIN);
    assert.equal(row(env, post.id).state, "failed");
    assert.equal(posts(g, `${IG_ID}/media`).length, 2);
    assert.equal(posts(g, "/media_publish").length, 0);
  }
});

test("a lost answer never publishes twice; a refusal stops; Meta's quota makes it wait", async () => {
  {
    const { env, g, run } = setup({ statuses: ["FINISHED"] });
    g.publishFails.push("lost-after");
    const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
    await run(T0 - 60 * MIN);
    await approve(env, post.id, T0 - 30 * MIN);
    for (let m = -7; m <= 0; m++) await run(T0 + m * MIN);
    assert.equal(row(env, post.id).state, "publishing");
    await run(T0 + MIN);
    await run(T0 + 2 * MIN);
    assert.equal(row(env, post.id).state, "published");
    assert.equal(row(env, post.id).media_id, "m1");
    assert.equal(posts(g, "/media_publish").length, 1, "published once");
  }
  {
    const { env, g, run } = setup({ statuses: ["FINISHED"] });
    g.publishFails.push("lost-before");
    const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
    await run(T0 - 60 * MIN);
    await approve(env, post.id, T0 - 30 * MIN);
    for (let m = -7; m <= 1; m++) await run(T0 + m * MIN);
    assert.equal(row(env, post.id).state, "published");
    assert.equal(posts(g, "/media_publish").length, 2);
    assert.equal(g.media, 1, "one reel on the account");
  }
  {
    const { env, g, run } = setup({ statuses: ["FINISHED"] });
    g.publishFails.push("refused");
    const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
    await run(T0 - 60 * MIN);
    await approve(env, post.id, T0 - 30 * MIN);
    for (let m = -7; m <= 2; m++) await run(T0 + m * MIN);
    assert.equal(row(env, post.id).state, "failed");
    assert.match(row(env, post.id).error, /could not be published \(code 100\/2207051\)/);
    assert.equal(posts(g, "/media_publish").length, 1);
  }
  {
    const { env, g, run } = setup({ statuses: ["FINISHED"] });
    const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
    await run(T0 - 60 * MIN);
    await approve(env, post.id, T0 - 30 * MIN);
    g.quota = { usage: 100, total: 100 };
    await run(T0 - 7 * MIN);
    assert.equal(row(env, post.id).state, "checked");
    assert.equal(posts(g, `${IG_ID}/media`).length, 0);
    g.quota = { usage: 99, total: 100 };
    await run(T0 - 6 * MIN);
    assert.equal(row(env, post.id).state, "container");
  }
});

test("a change after the owner's sì is never published, and neither is a post whose time passed", async () => {
  {
    const { env, g, run } = setup();
    const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
    await run(T0 - 60 * MIN);
    await approve(env, post.id, T0 - 30 * MIN);
    env.DB.db.prepare("UPDATE ig_posts SET caption = caption || ' #fast' WHERE id = ?").run(post.id);
    await run(T0 - 7 * MIN);
    assert.equal(row(env, post.id).state, "invalid");
    assert.match(row(env, post.id).error, /changed after the owner approved it/);
    assert.equal(g.calls.filter((c) => c.method === "POST").length, 0);
    assert.equal(env.OWNER_MAIL.sent.length, 1);
  }
  {
    const { env, g, run } = setup();
    const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
    await run(T0 - 60 * MIN);
    await approve(env, post.id, T0 - 30 * MIN);
    env.MEDIA.put("ig/2026-11-03-rx7-reveal-k2m4.mp4", mp4({ seconds: 14 }), "video/mp4");
    await run(T0 - 7 * MIN);
    assert.match(row(env, post.id).error, /changed after the owner approved it/);
    assert.equal(g.calls.filter((c) => c.method === "POST").length, 0);
  }
  {
    const { env, g, run } = setup();
    const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
    await run(T0 - 60 * MIN);
    await approve(env, post.id, T0 - 30 * MIN);
    await run(T0 + 20 * MIN);
    assert.equal(row(env, post.id).state, "missed");
    assert.equal(g.calls.filter((c) => c.method === "POST").length, 0);
    assert.match(env.OWNER_MAIL.sent[0].raw, /NOT published/);
  }
});

test("two minutes running at once publish once", async () => {
  const { env, g, run, fetcher } = setup({ statuses: ["FINISHED"] });
  const post = addPost(env, ENTRY, T0 - 2 * 60 * MIN);
  await run(T0 - 60 * MIN);
  await approve(env, post.id, T0 - 30 * MIN);
  await run(T0 - 7 * MIN);
  await run(T0 - 6 * MIN);
  assert.equal(row(env, post.id).state, "ready");
  g.now = T0;
  await Promise.all([tick(env, T0, fetcher), tick(env, T0, fetcher), tick(env, T0, fetcher)]);
  assert.equal(row(env, post.id).state, "published");
  assert.equal(posts(g, "/media_publish").length, 1);
});

test("the token: renewed after 7 days, sealed in D1, used from then on; a pasted token wins; no key, a warning", async () => {
  const { env, g, run, logs } = setup();
  await run(T0);
  const seeded = env.DB.db.prepare("SELECT * FROM ig_token").get();
  assert.equal(seeded.sealed, null);
  await run(T0 + 6 * DAY);
  assert.equal(g.calls.filter((c) => c.path === "/refresh_access_token").length, 0);
  await run(T0 + 7 * DAY);
  const refresh = g.calls.filter((c) => c.path === "/refresh_access_token");
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0].query.grant_type, "ig_refresh_token");
  const sealed = env.DB.db.prepare("SELECT * FROM ig_token").get();
  assert.match(sealed.sealed, /^v1\./);
  assert.equal(sealed.expires_at, new Date(T0 + 7 * DAY + 5_184_000_000).toISOString());
  assert.ok(env.DB.db.prepare("SELECT what FROM ig_events WHERE post_id IS NULL").all().some((e) => e.what.startsWith("token renewed")));

  const post = addPost(env, { ...ENTRY, at: "2026-11-10 16:30" }, T0 + 7 * DAY + MIN);
  await run(T0 + 7 * DAY + 2 * MIN);
  assert.equal(row(env, post.id).state, "checked");
  assert.equal(g.lastToken, RENEWED);
  env.IG_ACCESS_TOKEN = PASTED;
  env.DB.db.exec(recheckSql(post.id, new Date().toISOString()));
  await run(T0 + 7 * DAY + 3 * MIN);
  assert.equal(g.lastToken, PASTED);
  assertNoToken(env, g, logs, TOKEN, RENEWED, PASTED);

  const unkeyed = setup({ key: undefined });
  await unkeyed.run(T0);
  await unkeyed.run(T0 + 49 * DAY);
  assert.equal(unkeyed.env.OWNER_MAIL.sent.length, 0);
  await unkeyed.run(T0 + 51 * DAY);
  await unkeyed.run(T0 + 51 * DAY + 60 * MIN);
  assert.equal(unkeyed.env.OWNER_MAIL.sent.length, 1, "once a day");
  assert.match(unkeyed.env.OWNER_MAIL.sent[0].raw, /expires on .*IG_TOKEN_KEY is not set/s);
  assert.equal(unkeyed.g.calls.filter((c) => c.path === "/refresh_access_token").length, 0);
});

// Last on purpose: the fallback switches this isolate to the access_token parameter for every later call.
test("a Meta that ignores the Authorization header: the call is made again with access_token, once", async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url, auth: init.headers?.authorization ?? null });
    if (!u.searchParams.get("access_token")) return new Response(JSON.stringify({ error: { message: "An active access token must be used", code: 2500 } }), { status: 400 });
    return new Response(JSON.stringify({ user_id: IG_ID, username: "kleooai" }), { status: 200 });
  };
  const g = graphClient(TOKEN, "v26.0", fetcher);
  assert.deepEqual(await g.get("me", { fields: "user_id,username" }), { user_id: IG_ID, username: "kleooai" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
  assert.match(calls[1].url, /access_token=/);
});
