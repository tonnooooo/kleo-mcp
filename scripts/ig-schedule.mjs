#!/usr/bin/env node
/**
 * The owner's side of kleo-ig-publisher (src/ig/, docs/IG-PUBLISHER.md): puts @kleooai's reels in the schedule that the
 * Worker publishes at the chosen minute. Runs on the owner's PC with wrangler's own Cloudflare login (D1 kleo-db, R2
 * kleo-media); it never talks to Instagram and never sees the Instagram token.
 *
 *   node scripts/ig-schedule.mjs upload <file.mp4|.mov|.jpg> [--name <slug>] [--check]
 *        checks the file against Meta's Reels specification here, then uploads it to kleo-media/ig/ under a name never
 *        used before (media.kleooai.com caches what it served, a 404 included) and prints its address;
 *        --check stops after the check
 *   node scripts/ig-schedule.mjs add <entry.json> [--dry-run [--offline]] [--no-probe]
 *        checks the entry here (rules, 3 hours from the schedule) and prints the exact request. --dry-run writes
 *        nothing (--offline: not even a D1 read). Without it the post is queued as 'new' and the Worker's cloud check
 *        follows: the token's account, the quota, the account's last posts, the file in R2, the public address, then
 *        the probe (a container Meta judges and nobody publishes; --no-probe skips it)
 *   node scripts/ig-schedule.mjs list | show <id>
 *   node scripts/ig-schedule.mjs approve <id> --owner "<the owner's own words>"
 *        ONLY after the owner's explicit "sì" for this one post; his words are stored with the approval
 *   node scripts/ig-schedule.mjs cancel <id> | recheck <id>
 *
 * entry.json: { "video": "https://media.kleooai.com/ig/….mp4", "caption": "…", "at": "2026-11-02 13:30", "ai": true,
 *   "cover"?: "https://media.kleooai.com/ig/….jpg", "thumb_offset_ms"?: 1200, "trial"?: "MANUAL",
 *   "outside_window"?: true, "probe"?: false, "id"?: "…" }      "at" is New Zealand time.
 * wrangler: this checkout's node_modules, or KLEO_WRANGLER=<another checkout>/node_modules/wrangler/bin/wrangler.js.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { approvalHash, containerParams, fmtNz, gapProblems, LEAD_MIN, MEDIA_HOST, NZ, validateEntry } from "../src/ig/rules.ts";
import { inspectMp4, mp4Summary, specProblems } from "../src/ig/mp4.ts";
import { approveSql, cancelSql, insertPostSql, recheckSql, sqlText } from "../src/ig/sql.ts";
import { SCHEMA } from "../src/ig/publisher.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT = "e4a5a1308df5b44c65497b85210c6845"; // Cloudflare "Plural Juice": wrangler's login sees two accounts
const LIVE = "('new', 'probing', 'checked', 'container', 'ready', 'publishing', 'published')";

function die(text) { console.error(text); process.exit(1); }

function wrangler(args) {
  const js = process.env.KLEO_WRANGLER || join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(js)) die(`wrangler is not at ${js}: run npm ci here, or set KLEO_WRANGLER to another checkout's node_modules/wrangler/bin/wrangler.js`);
  return spawnSync(process.execPath, [js, ...args], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
  });
}

/** The rows of the last statement, or { error } when wrangler failed. */
function d1Try(sql) {
  const r = wrangler(["d1", "execute", "kleo-db", "--remote", "--json", "--config", "wrangler.ig.jsonc", "--command", sql]);
  const out = r.stdout ?? "";
  if (r.status !== 0) return { error: `${out}\n${r.stderr ?? ""}`.trim().slice(-2000) || `exit ${r.status}` };
  try { return { rows: JSON.parse(out.slice(out.indexOf("["))).at(-1)?.results ?? [] }; } catch { return { error: `wrangler answered something that is not JSON:\n${out.slice(0, 2000)}` }; }
}
function d1(sql) {
  const r = d1Try(sql);
  if (r.error) die(`D1 failed:\n${r.error}`);
  return r.rows;
}
const ensureSchema = () => d1(SCHEMA.join(";\n"));
const getPost = (id) => d1(`SELECT * FROM ig_posts WHERE id = ${sqlText(id)}`)[0] ?? null;

async function inspectFile(path, size) {
  const fd = openSync(path, "r");
  try {
    return await inspectMp4(size, async (offset, length) => {
      const b = Buffer.alloc(length);
      const n = readSync(fd, b, 0, length, offset);
      return new Uint8Array(b.buffer, b.byteOffset, n);
    });
  } finally { closeSync(fd); }
}

const nzDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: NZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "reel";
const tag = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

async function upload(file, name, checkOnly) {
  const path = resolve(file);
  if (!existsSync(path)) die(`${file} does not exist.`);
  const ext = extname(path).toLowerCase();
  const type = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" }[ext];
  if (!type) die("upload takes an .mp4, .mov or .jpg file.");
  const size = statSync(path).size;
  if (type.startsWith("video/")) {
    const info = await inspectFile(path, size);
    const s = specProblems(info);
    console.log(`  ${mp4Summary(info)}`);
    for (const w of s.warnings) console.log(`  warning: ${w}`);
    for (const e of s.errors) console.log(`  ERROR: ${e}`);
    if (s.errors.length) die("Meta would refuse this file: nothing uploaded.");
  }
  if (checkOnly) { console.log("Check only: nothing uploaded."); return; }
  const key =`ig/${nzDate(Date.now())}-${slug(name ?? basename(path, extname(path)))}-${tag()}${ext === ".jpeg" ? ".jpg" : ext}`;
  const r = wrangler(["r2", "object", "put", `kleo-media/${key}`, "--file", path, "--content-type", type, "--remote"]);
  if (r.status !== 0) die(`The upload failed (exit ${r.status}):\n${`${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().slice(-2000)}`);
  console.log(`https://${MEDIA_HOST}/${key}`);
}

function printReport(report) {
  console.log(report.ok ? "  cloud check: OK" : report.transient ? "  cloud check: waiting for Instagram or an address to answer" : "  cloud check: FAILED");
  for (const e of report.errors ?? []) console.log(`  ERROR: ${e}`);
  for (const w of report.warnings ?? []) console.log(`  warning: ${w}`);
  if (report.account) console.log(`  account: ${report.account}`);
  if (report.quota) console.log(`  quota: ${report.quota}`);
  if (report.video) console.log(`  video: ${report.video}`);
  if (report.probe) console.log(`  Meta's probe: ${report.probe}`);
  console.log(`  request: POST /<IG_ID>/media ${JSON.stringify(report.request)}`);
}

const BOM = String.fromCharCode(0xfeff);

async function add(file, { dryRun, offline, noProbe }) {
  let entry;
  try {
    const text = readFileSync(resolve(file), "utf8");
    entry = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
  } catch (e) { die(`${file}: ${e.message}`); }
  if (noProbe && entry && typeof entry === "object") entry.probe = false;
  const nowMs = Date.now();
  const v = validateEntry(entry, nowMs);
  const errors = [...v.errors];
  if (v.post) {
    const sql = `SELECT id, publish_at, published_at FROM ig_posts WHERE state IN ${LIVE}`;
    const read = offline ? { rows: [] } : dryRun ? d1Try(sql) : (ensureSchema(), { rows: d1(sql) });
    const rows = read.error?.includes("no such table") ? [] : read.error ? die(`D1 failed:\n${read.error}`) : read.rows;
    if (offline) console.log("  offline: the schedule in D1 was not read, so the 3 hours from other posts are not checked here");
    if (rows.some((r) => r.id === v.post.id)) errors.push(`The schedule already has a post "${v.post.id}": give this one another "id".`);
    errors.push(...gapProblems(Date.parse(v.post.publish_at), rows.filter((r) => r.id !== v.post.id)
      .map((r) => { const ms = Date.parse(r.published_at ?? r.publish_at); return { label: `${r.id} (${fmtNz(ms)})`, ms }; })));
    console.log(`  ${v.post.id}: ${fmtNz(Date.parse(v.post.publish_at))}`);
    console.log(`  request: POST https://graph.instagram.com/v26.0/<IG_ID>/media (Authorization: Bearer <token>)\n  ${JSON.stringify(containerParams(v.post))}`);
  }
  for (const w of v.warnings) console.log(`  warning: ${w}`);
  for (const e of errors) console.log(`  ERROR: ${e}`);
  if (errors.length) die("Not added.");
  if (dryRun) { console.log("Dry run: the entry is valid, nothing was written."); return; }
  d1(insertPostSql(v.post, new Date(nowMs).toISOString()));
  console.log(`Queued "${v.post.id}" for the Worker's cloud check (it runs every minute; nothing is published without the owner's "sì").`);
  // The check takes a minute; Meta's probe up to five more.
  let seen = "new";
  for (let i = 0; i < 32; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    const p = getPost(v.post.id);
    if (!p) die(`"${v.post.id}" is gone from the schedule.`);
    if (p.state !== seen) { seen = p.state; console.log(`  state: ${p.state}`); }
    if (p.state === "checked" || p.state === "invalid") { printReport(JSON.parse(p.check_json)); return; }
  }
  console.log(`Not finished yet (${seen}): is kleo-ig-publisher deployed? Look later with: node scripts/ig-schedule.mjs show ${v.post.id}`);
}

function list() {
  const r = d1Try("SELECT id, publish_at, state, approved_at, permalink, error FROM ig_posts ORDER BY publish_at DESC LIMIT 40");
  if (r.error?.includes("no such table")) { console.log("The schedule is empty."); return; }
  if (r.error) die(`D1 failed:\n${r.error}`);
  if (!r.rows.length) console.log("The schedule is empty.");
  for (const p of r.rows) console.log(`${fmtNz(Date.parse(p.publish_at))}  ${p.state}${p.approved_at ? " (approved)" : ""}  ${p.id}  ${p.permalink ?? p.error ?? ""}`);
}

function show(id) {
  const p = getPost(id);
  if (!p) die(`No post "${id}".`);
  console.log(`${p.id}  ${p.state}${p.approved_at ? `, approved ${p.approved_at} ("${p.approved_note}")` : ", not approved"}`);
  console.log(`  at: ${fmtNz(Date.parse(p.publish_at))} (${p.at_local})\n  video: ${p.video_url}${p.cover_url ? `\n  cover: ${p.cover_url}` : ""}`);
  console.log(`  caption: ${JSON.stringify(p.caption)}`);
  if (p.probe_container) console.log(`  probe container: ${p.probe_container} (never published)`);
  if (p.container_id) console.log(`  container: ${p.container_id} (polls ${p.polls}, tries ${p.container_tries})`);
  if (p.media_id) console.log(`  media: ${p.media_id} ${p.permalink ?? ""}`);
  if (p.error) console.log(`  last error: ${p.error}`);
  if (p.check_json) printReport(JSON.parse(p.check_json));
  for (const e of d1(`SELECT at, what FROM ig_events WHERE post_id = ${sqlText(id)} ORDER BY id`)) console.log(`  ${e.at}  ${e.what}`);
}

async function approve(id, owner) {
  if (!owner?.trim()) die("approve needs --owner \"<the owner's own words>\": only his explicit \"sì\" for this post approves it.");
  const p = getPost(id);
  if (!p) die(`No post "${id}".`);
  if (p.state !== "checked" || p.approved_at) die(`"${id}" is ${p.state}${p.approved_at ? ", already approved" : ""}: only a post that passed the cloud check and waits can be approved.`);
  const report = p.check_json ? JSON.parse(p.check_json) : null;
  if (!report?.ok) die("Its cloud check did not pass.");
  if (Date.parse(p.publish_at) < Date.now() + 2 * 60_000) die("Its time is less than 2 minutes away.");
  const hash = await approvalHash(p, p.video_etag);
  const after = d1(`${approveSql(id, hash, owner.trim(), new Date().toISOString())};\nSELECT approved_at FROM ig_posts WHERE id = ${sqlText(id)}`);
  if (!after[0]?.approved_at) die("Not approved: the post changed meanwhile. Look at it with show.");
  console.log(`Approved: "${id}" goes out at ${fmtNz(Date.parse(p.publish_at))}; its container is made ${LEAD_MIN} minutes before.`);
}

function change(id, sql, done) {
  const after = d1(`${sql};\nSELECT state FROM ig_posts WHERE id = ${sqlText(id)}`);
  if (!after[0]) die(`No post "${id}".`);
  console.log(after[0].state === done ? `"${id}" is ${done}.` : `"${id}" stays ${after[0].state}: that change is not allowed from there.`);
}

async function main(argv) {
  const [cmd, arg] = argv;
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const now = () => new Date().toISOString();
  if (cmd === "upload" && arg) return upload(arg, flag("--name"), argv.includes("--check"));
  if (cmd === "add" && arg) {
    const offline = argv.includes("--offline");
    if (offline && !argv.includes("--dry-run")) die("--offline goes with --dry-run only: a real add writes to D1.");
    return add(arg, { dryRun: argv.includes("--dry-run"), offline, noProbe: argv.includes("--no-probe") });
  }
  if (cmd === "list") return list();
  if (cmd === "show" && arg) return show(arg);
  if (cmd === "approve" && arg) return approve(arg, flag("--owner"));
  if (cmd === "cancel" && arg) return change(arg, cancelSql(arg, now()), "cancelled");
  if (cmd === "recheck" && arg) return change(arg, recheckSql(arg, now()), "new");
  const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
  die(lines.slice(2, lines.findIndex((l) => l.startsWith(" */"))).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((e) => die(e instanceof Error ? e.message : String(e)));
}
