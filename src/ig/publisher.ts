/**
 * KLEO INSTAGRAM PUBLISHER — THE MINUTE-BY-MINUTE JOB (29 October 2026).
 *
 * The owner: reels scheduled with Instagram's own scheduler come out at 720p, so he deleted them, posted by hand at the
 * chosen time, and asked for that to happen by itself. This Worker does it through the official Instagram API
 * (developers.facebook.com/docs/instagram-platform/content-publishing), on graph.facebook.com with a Facebook Login
 * token (a system user's, which never expires) or on graph.instagram.com with an Instagram Login token: the token
 * decides (loginOf, src/ig/graph.ts), and the calls are the same:
 *   1. POST /<IG_ID>/media           media_type=REELS, video_url, caption, share_to_feed=true, is_ai_generated=true
 *   2. GET  /<container>?fields=status_code   once a minute until FINISHED, at most 5 times
 *   3. POST /<IG_ID>/media_publish   creation_id, at the chosen minute
 *   4. GET  /<media>?fields=permalink         into the log, and an e-mail to the owner
 *   with GET /<IG_ID>/content_publishing_limit (Meta's 24-hour quota) before 1 and 3. Step 1 runs LEAD_MIN (20) minutes
 *   early, so that the reel goes live on the minute and a failure still leaves the owner time to post by hand; Meta has
 *   no schedule parameter of its own.
 *
 * A post enters through scripts/ig-schedule.mjs as 'new'. Every minute the cron moves each post one step:
 *   new        the cloud check, which is the dry-run: the entry's rules, the token and its account, the quota, three
 *              hours from the account's real last posts, the file in R2 and its moov box against Meta's specification,
 *              the public address Meta will fetch, and the exact request. GET requests only  -> checked | invalid,
 *              or -> probing when the post asks for the probe (the default)
 *   probing    Meta's own verdict without publishing: a container made from the very request, polled like a real one,
 *              never given to media_publish (it expires unpublished after 24 hours). FINISHED -> checked;
 *              ERROR or EXPIRED -> invalid with Meta's words; still processing after 5 polls -> checked, with a warning
 *   checked    waits for the owner's "sì" for this one post (approved_at; approved_hash covers the post and the file's
 *              R2 etag as they were approved). LEAD_MIN before the time: the check again, then the container -> container
 *   container  FINISHED -> ready; ERROR or EXPIRED -> failed; still processing after 5 polls -> one more container,
 *              then failed
 *   ready      at the time: the account's last posts once more (a reel posted by hand meanwhile stops this one), then
 *              media_publish -> published, or publishing when Meta's answer was lost
 *   publishing the container's status decides: PUBLISHED -> published, FINISHED -> ready again (3 tries in all)
 * A post that cannot go out within GRACE_MIN of its time becomes 'missed': late is never silent and never automatic.
 * The owner gets an e-mail when an approved post is published, failed, missed or refused at its last check.
 * Nothing logs or stores the token (src/ig/graph.ts, src/ig/token.ts).
 */
import { approvalHash, containerParams, COVER_EXT, fmtNz, gapProblems, LEAD_MIN, MEDIA_HOST, mediaKey, postProblems, VIDEO_EXT, type Post } from "./rules.ts";
import { inspectMp4, mp4Summary, specProblems } from "./mp4.ts";
import { FACEBOOK_HOST, GraphError, graphClient, igUser, loginOf, publishingQuota, recentMedia, redact, whoAmI, type Fetcher, type Graph, type RecentMedia } from "./graph.ts";
import { expiryWarning, refusedAlarm, renewIfDue, TOKEN_SCHEMA, tokenNow } from "./token.ts";

export interface IgEnv {
  DB: D1Database;
  /** The R2 bucket kleo-media, served at media.kleooai.com. */
  MEDIA: R2Bucket;
  OWNER_MAIL?: SendEmail;
  /** An Instagram Login token ("IG...") or a Facebook Login system-user token ("EAA..."). */
  IG_ACCESS_TOKEN?: string;
  /** @kleooai's Instagram account ID: required with a Facebook Login token, checked against the token's account otherwise. */
  IG_USER_ID?: string;
  IG_TOKEN_KEY?: string;
  IG_API_VERSION?: string;
  IG_USERNAME?: string;
  IG_MEDIA_HOST?: string;
}

export const POLLS_MAX = 5;
export const CONTAINER_TRIES = 2;
export const PUBLISH_TRIES = 3;
export const GRACE_MIN = 15;
const LEASE_MIN = 3;
const MIN = 60_000, DAY = 24 * 60 * MIN;
const iso = (ms: number): string => new Date(ms).toISOString();
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ig_posts (
    id TEXT PRIMARY KEY, video_url TEXT NOT NULL, caption TEXT NOT NULL, publish_at TEXT NOT NULL, at_local TEXT NOT NULL,
    cover_url TEXT, thumb_offset_ms INTEGER, trial TEXT, outside_window INTEGER NOT NULL DEFAULT 0,
    probe INTEGER NOT NULL DEFAULT 1, probe_container TEXT, probe_polls INTEGER NOT NULL DEFAULT 0, probe_at TEXT,
    state TEXT NOT NULL DEFAULT 'new', check_json TEXT, checked_at TEXT, video_etag TEXT,
    approved_at TEXT, approved_hash TEXT, approved_note TEXT,
    container_id TEXT, container_at TEXT, polls INTEGER NOT NULL DEFAULT 0, container_tries INTEGER NOT NULL DEFAULT 0,
    publish_tries INTEGER NOT NULL DEFAULT 0, publish_started_at TEXT,
    media_id TEXT, permalink TEXT, published_at TEXT, error TEXT, lease_until TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS ig_posts_state ON ig_posts (state, publish_at)",
  "CREATE TABLE IF NOT EXISTS ig_events (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT, at TEXT NOT NULL, what TEXT NOT NULL)",
  TOKEN_SCHEMA,
];

export interface PostRow extends Post {
  probe_container: string | null;
  probe_polls: number;
  probe_at: string | null;
  state: string;
  check_json: string | null;
  checked_at: string | null;
  video_etag: string | null;
  approved_at: string | null;
  approved_hash: string | null;
  approved_note: string | null;
  container_id: string | null;
  container_at: string | null;
  polls: number;
  container_tries: number;
  publish_tries: number;
  publish_started_at: string | null;
  media_id: string | null;
  permalink: string | null;
  published_at: string | null;
  error: string | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface Report {
  ok: boolean;
  /** Nothing is wrong with the post itself: Instagram or an address did not answer. It is checked again next minute. */
  transient: boolean;
  at: string;
  errors: string[];
  warnings: string[];
  /** The R2 etags of the video (and the cover) as checked: the owner's "sì" covers these exact files. */
  etag: string | null;
  video: string | null;
  account: string | null;
  quota: string | null;
  quotaFull: boolean;
  /** POST /<IG_ID>/media exactly as it would go; the token travels in the Authorization header. */
  request: Record<string, unknown>;
  /** Meta's verdict on the probe container, once it came. */
  probe: string | null;
}

const schemaReady = new WeakSet<object>();
export async function ensureSchema(env: { DB: D1Database }): Promise<void> {
  if (schemaReady.has(env.DB)) return;
  for (const sql of SCHEMA) await env.DB.prepare(sql).run();
  schemaReady.add(env.DB);
}

type Account = { ok: true; graph: Graph; igId: string; username: string; type: string } | { ok: false; error: string; transient: boolean };
interface Ctx { env: IgEnv; nowMs: number; fetcher: Fetcher; host: string; account: Promise<Account> | null }

/**
 * The token's account, asked once per minute: it must be @kleooai (IG_USERNAME). An Instagram Login token names its
 * own account (/me), which must equal IG_USER_ID when that is set; a Facebook Login token publishes to IG_USER_ID, and
 * Meta must say that this ID is @kleooai.
 */
function accountOf(ctx: Ctx): Promise<Account> {
  ctx.account ??= (async (): Promise<Account> => {
    const t = await tokenNow(ctx.env, ctx.nowMs);
    if (!t) return { ok: false, error: "No Instagram token yet: the owner's one-time steps (docs/IG-PUBLISHER.md) end with the IG_ACCESS_TOKEN secret.", transient: false };
    const facebook = loginOf(t.token) === "facebook";
    const id = (ctx.env.IG_USER_ID ?? "").trim();
    if (facebook && !/^\d{5,25}$/.test(id)) {
      return { ok: false, error: "A Facebook Login token publishes to IG_USER_ID, which is not set: it belongs in wrangler.ig.jsonc (vars).", transient: false };
    }
    const graph = graphClient(t.token, ctx.env.IG_API_VERSION || "v26.0", ctx.fetcher, facebook ? { host: FACEBOOK_HOST } : {});
    const want = (ctx.env.IG_USERNAME || "kleooai").toLowerCase();
    try {
      const me = facebook ? await igUser(graph, id) : await whoAmI(graph);
      if (me.username.toLowerCase() !== want) return { ok: false, error: `The token is for @${me.username}, not @${want}: nothing is published with it.`, transient: false };
      if (id && id !== me.userId) return { ok: false, error: `IG_USER_ID is ${id}, but the token's account @${me.username} is ${me.userId}.`, transient: false };
      if (me.accountType && !/^(business|media_creator|creator)$/i.test(me.accountType)) {
        return { ok: false, error: `@${me.username} is a ${me.accountType} account; publishing needs a professional (Creator or Business) account.`, transient: false };
      }
      return { ok: true, graph, igId: me.userId, username: me.username, type: facebook ? "Facebook Login" : me.accountType ?? "type not given" };
    } catch (e) {
      const transient = !(e instanceof GraphError) || e.uncertain;
      const refused = e instanceof GraphError && e.code === 190;
      if (refused && facebook) {
        // A system user's token never expires: Meta refusing it means it was revoked, and nothing goes out until a new one.
        const text = `Meta refused the Facebook Login token (${why(e)}): nothing is published until the owner pastes a new system-user token into IG_ACCESS_TOKEN (docs/IG-PUBLISHER.md).`;
        if (await refusedAlarm(ctx.env, ctx.nowMs)) {
          await event(ctx.env, null, text, ctx.nowMs);
          await mailOwner(ctx.env, "Kleo Instagram: the token was refused",
            `${text}\n\nIn Meta's Business Settings (portfolio "Kleo"): Users, System users, the publisher's system user, Generate token, app "Kleo Reels Publisher", expiry Never, the five permissions. Then paste it into the kleo-ig-publisher secret IG_ACCESS_TOKEN in Cloudflare (docs/IG-PUBLISHER.md).\n`, ctx.nowMs);
        }
        return { ok: false, error: text, transient: false };
      }
      const text = refused
        ? `Instagram refused the token (${why(e)}): the owner makes a new one (docs/IG-PUBLISHER.md).`
        : `Instagram did not confirm the account: ${why(e)}`;
      return { ok: false, error: text, transient };
    }
  })();
  return ctx.account;
}

async function event(env: IgEnv, postId: string | null, what: string, nowMs: number): Promise<void> {
  const text = redact(what, [env.IG_ACCESS_TOKEN]).slice(0, 2000);
  await env.DB.prepare("INSERT INTO ig_events (post_id, at, what) VALUES (?, ?, ?)").bind(postId, iso(nowMs), text).run();
  console.log(JSON.stringify({ ig: postId, what: text }));
}

const ALERT_FROM = "alerts@kleooai.com", OWNER_TO = "kleooai@gmail.com";
/** The same plain-text e-mail as the Studio's owner alerts (src/studio/providers.ts ownerMime), from alerts@kleooai.com. */
function mime(subject: string, text: string, nowMs: number): string {
  const id = `${nowMs.toString(36)}.${Math.random().toString(36).slice(2, 10)}@kleooai.com`;
  return [
    `From: Kleo alerts <${ALERT_FROM}>`, `To: ${OWNER_TO}`, `Subject: ${subject.replace(/[\r\n]+/g, " ")}`, `Message-ID: <${id}>`,
    `Date: ${new Date(nowMs).toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit",
    "", text.replace(/\r?\n/g, "\r\n"),
  ].join("\r\n");
}
async function mailOwner(env: IgEnv, subject: string, text: string, nowMs: number): Promise<void> {
  if (!env.OWNER_MAIL) return;
  try {
    const { EmailMessage } = await import("cloudflare:email");
    await env.OWNER_MAIL.send(new EmailMessage(ALERT_FROM, OWNER_TO, mime(subject, redact(text, [env.IG_ACCESS_TOKEN]), nowMs)));
  } catch (e) {
    console.error("ig owner mail", why(e));
  }
}

type Fields = Partial<Record<keyof PostRow, string | number | null>>;
/** Moves a post from the state it was read in, or does nothing when another minute moved it first. */
async function move(ctx: Ctx, p: PostRow, to: string, fields: Fields = {}): Promise<boolean> {
  const keys = Object.keys(fields) as (keyof PostRow)[];
  const sets = ["state = ?", "updated_at = ?", ...keys.map((k) => `${k} = ?`)].join(", ");
  const r = await ctx.env.DB.prepare(`UPDATE ig_posts SET ${sets} WHERE id = ? AND state = ?`)
    .bind(to, iso(ctx.nowMs), ...keys.map((k) => fields[k] ?? null), p.id, p.state).run();
  if (r.meta.changes !== 1) return false;
  Object.assign(p, fields, { state: to });
  return true;
}

/** An approved post that will not go out: the log, and an e-mail so that the owner can post it by hand. */
async function fail(ctx: Ctx, p: PostRow, text: string, state = "failed", report?: Report): Promise<void> {
  const fields: Fields = { error: text };
  if (report) { fields.check_json = JSON.stringify(report); fields.checked_at = iso(ctx.nowMs); }
  if (!(await move(ctx, p, state, fields))) return;
  await event(ctx.env, p.id, `${state}: ${text}`, ctx.nowMs);
  if (!p.approved_at) return;
  const when = fmtNz(Date.parse(p.publish_at));
  await mailOwner(ctx.env, `Kleo Instagram: reel NOT published (${p.id})`,
    `The reel "${p.id}" for ${when} was not published.\n\n${text}\n\nVideo: ${p.video_url}\n\nNothing more will be tried for it: post it from the app if it should still go out.\n`, ctx.nowMs);
}

/** The public address answers with the very file R2 holds (what Meta will fetch). */
async function servedProblem(ctx: Ctx, url: string, size: number): Promise<{ text: string; soft: boolean } | null> {
  try {
    const res = await ctx.fetcher(url, { method: "HEAD", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const cached = res.status === 404 ? " A 404 seen before the upload stays cached for hours: upload under a new name." : "";
      return { text: `${url} answers HTTP ${res.status}, so Meta could not fetch it.${cached}`, soft: res.status >= 500 };
    }
    const len = Number(res.headers.get("content-length"));
    if (len > 0 && len !== size) return { text: `${url} serves ${len} bytes but R2 holds ${size}: an older copy is cached. Upload under a new name.`, soft: false };
    return null;
  } catch (e) {
    return { text: `${url} did not answer: ${why(e)}`, soft: true };
  }
}

/** The cloud check (the dry-run). Reads only: Instagram is asked GET questions, nothing is created there. */
export async function check(ctx: Ctx, p: PostRow): Promise<Report> {
  const { env, nowMs } = ctx;
  const errors: string[] = [], soft: string[] = [], warnings: string[] = [];
  const at = Date.parse(p.publish_at);
  const v = postProblems(p, ctx.host);
  errors.push(...v.errors);
  warnings.push(...v.warnings);
  if (at + GRACE_MIN * MIN < nowMs) errors.push(`${fmtNz(at)} has passed.`);

  // Three hours from every other post in the schedule...
  const others = (await env.DB.prepare(`SELECT id, publish_at, published_at, media_id FROM ig_posts
      WHERE id != ? AND state IN ('new', 'probing', 'checked', 'container', 'ready', 'publishing', 'published')`).bind(p.id)
    .all<{ id: string; publish_at: string; published_at: string | null; media_id: string | null }>()).results ?? [];
  errors.push(...gapProblems(at, others.map((o) => {
    const ms = Date.parse(o.published_at ?? o.publish_at);
    return { label: `${o.id} (${fmtNz(ms)})`, ms };
  })));
  const ours = new Set(others.map((o) => o.media_id).filter((x): x is string => !!x));

  // ...the account, its quota, and its real last posts (from the app, the web or this Worker).
  let account: string | null = null, quota: string | null = null, quotaFull = false;
  const a = await accountOf(ctx);
  if (!a.ok) (a.transient ? soft : errors).push(a.error);
  else {
    account = `@${a.username} (${a.type}, ${a.igId})`;
    try {
      const q = await publishingQuota(a.graph, a.igId);
      quota = `${q.usage} of ${q.total} posts in the last 24 hours`;
      quotaFull = q.usage >= q.total;
      if (quotaFull) warnings.push(`Meta's 24-hour publishing quota is full (${quota}): the post waits for room.`);
    } catch (e) {
      warnings.push(`The publishing quota could not be read: ${why(e)}`);
    }
    try {
      const recent = (await recentMedia(a.graph, a.igId)).filter((m) => !ours.has(m.id));
      errors.push(...gapProblems(at, recent.map((m) => ({ label: `the post ${m.permalink ?? m.id} (${fmtNz(m.ms)})`, ms: m.ms }))));
    } catch (e) {
      (e instanceof GraphError && !e.uncertain ? errors : soft).push(`The account's last posts could not be read: ${why(e)}`);
    }
  }

  // The files: in R2, a reel Meta takes, and served at the public address Meta will fetch. The address is asked only
  // once R2 has the file: a 404 asked before the upload stays in media.kleooai.com's cache for hours.
  const etags: string[] = [];
  let video: string | null = null;
  const key = mediaKey(p.video_url, ctx.host, VIDEO_EXT);
  if (key) {
    const head = await env.MEDIA.head(key);
    if (!head) errors.push(`${p.video_url} is not in the R2 bucket kleo-media. Upload it first (scripts/ig-schedule.mjs upload), and never open the address before the upload: media.kleooai.com keeps a 404 for hours.`);
    else {
      etags.push(head.etag);
      const type = head.httpMetadata?.contentType ?? "";
      if (!/^video\/(mp4|quicktime)$/i.test(type)) errors.push(`${p.video_url} is stored as "${type || "no type"}": upload it again as video/mp4.`);
      const info = await inspectMp4(head.size, async (offset, length) => {
        const o = await env.MEDIA.get(key, { range: { offset, length } });
        if (!o) throw new Error("the file disappeared while it was read");
        return new Uint8Array(await o.arrayBuffer());
      });
      const s = specProblems(info);
      errors.push(...s.errors);
      warnings.push(...s.warnings);
      video = mp4Summary(info);
      const served = await servedProblem(ctx, p.video_url, head.size);
      if (served) (served.soft ? soft : errors).push(served.text);
    }
  }
  const ckey = p.cover_url ? mediaKey(p.cover_url, ctx.host, COVER_EXT) : null;
  if (p.cover_url && ckey) {
    const head = await env.MEDIA.head(ckey);
    if (!head) errors.push(`The cover ${p.cover_url} is not in kleo-media: upload it first, and never open its address before.`);
    else {
      etags.push(head.etag);
      const type = head.httpMetadata?.contentType ?? "";
      if (!/^image\/jpe?g$/i.test(type)) errors.push(`The cover is stored as "${type || "no type"}": upload it again as image/jpeg.`);
      const served = await servedProblem(ctx, p.cover_url, head.size);
      if (served) (served.soft ? soft : errors).push(served.text);
    }
  }
  return {
    ok: !errors.length && !soft.length, transient: !errors.length && soft.length > 0, at: iso(nowMs),
    errors: [...errors, ...soft], warnings, etag: etags.length ? etags.join("|") : null, video, account, quota, quotaFull,
    request: containerParams(p), probe: null,
  };
}

/** A container's status_code, with Meta's error text when it has one ("status"; asked without it if Meta knows no such field). */
async function statusOf(g: Graph, container: string): Promise<{ status_code?: string; status?: string }> {
  try {
    return await g.get<{ status_code?: string; status?: string }>(container, { fields: "status_code,status" });
  } catch (e) {
    if (!(e instanceof GraphError) || e.code !== 100) throw e;
    return g.get<{ status_code?: string }>(container, { fields: "status_code" });
  }
}

async function permalinkOf(g: Graph, mediaId: string): Promise<string | null> {
  try { return (await g.get<{ permalink?: string }>(mediaId, { fields: "permalink" })).permalink ?? null; } catch { return null; }
}

async function published(ctx: Ctx, a: Account & { ok: true }, p: PostRow, mediaId: string): Promise<void> {
  if (!(await move(ctx, p, "published", { media_id: mediaId, published_at: iso(ctx.nowMs), error: null }))) return;
  const link = await permalinkOf(a.graph, mediaId);
  if (link) await ctx.env.DB.prepare("UPDATE ig_posts SET permalink = ? WHERE id = ?").bind(link, p.id).run();
  await event(ctx.env, p.id, `published: media ${mediaId}${link ? ` ${link}` : ""}`, ctx.nowMs);
  await mailOwner(ctx.env, `Kleo Instagram: reel published (${p.id})`,
    `The reel "${p.id}" is live on @${a.username}: ${link ?? `media ${mediaId}`}\n\nPlanned for ${fmtNz(Date.parse(p.publish_at))}, published at ${fmtNz(ctx.nowMs)} through the Instagram API, with the AI label on.\n`, ctx.nowMs);
}

/** Instagram says the container went out: its media is the account's first post since the publish began. */
async function settle(ctx: Ctx, a: Account & { ok: true }, p: PostRow): Promise<void> {
  const since = Date.parse(p.publish_started_at ?? p.container_at ?? p.publish_at) - 2 * MIN;
  let found: RecentMedia | undefined;
  try { found = (await recentMedia(a.graph, a.igId, 5)).filter((m) => m.ms >= since).sort((x, y) => x.ms - y.ms)[0]; } catch { found = undefined; }
  if (found) await published(ctx, a, p, found.id);
  else await event(ctx.env, p.id, "Instagram says the reel went out; its id is not among the account's last posts yet", ctx.nowMs);
}

/** The check passed: Meta is asked to take the reel, in a container that will never be published. */
async function startProbe(ctx: Ctx, p: PostRow, r: Report): Promise<void> {
  const a = await accountOf(ctx);
  if (!a.ok) return;
  let id = "";
  try {
    id = String((await a.graph.post<{ id?: string | number }>(`${a.igId}/media`, containerParams(p))).id ?? "");
    if (!id) throw new GraphError("Instagram answered without a container id", 200, null, null, false);
  } catch (e) {
    if (e instanceof GraphError && !e.uncertain) {
      const text = `Meta refused the reel at the probe: ${e.message}`;
      const report: Report = { ...r, ok: false, errors: [...r.errors, text], probe: text };
      if (await move(ctx, p, "invalid", { check_json: JSON.stringify(report), checked_at: iso(ctx.nowMs), video_etag: r.etag, error: text })) {
        await event(ctx.env, p.id, `check failed: ${text}`, ctx.nowMs);
      }
    } else await event(ctx.env, p.id, `the probe waits for Instagram: ${why(e)}`, ctx.nowMs);
    return;
  }
  if (await move(ctx, p, "probing", { check_json: JSON.stringify(r), checked_at: iso(ctx.nowMs), video_etag: r.etag, probe_container: id, probe_polls: 0, probe_at: iso(ctx.nowMs), error: null })) {
    await event(ctx.env, p.id, `probe container ${id}: Meta fetches the reel and judges the request; it is never published`, ctx.nowMs);
  }
}

/** Meta's verdict joins the check's report: FINISHED and slow -> checked (slow with a warning), refused -> invalid. */
async function probeDone(ctx: Ctx, p: PostRow, verdict: "taken" | "slow" | "refused", text: string): Promise<void> {
  const r = JSON.parse(p.check_json ?? "null") as Report | null;
  if (!r) return;
  r.probe = text;
  if (verdict === "refused") { r.ok = false; r.errors = [...r.errors, text]; }
  if (verdict === "slow") r.warnings = [...r.warnings, text];
  if (!(await move(ctx, p, verdict === "refused" ? "invalid" : "checked", { check_json: JSON.stringify(r), error: verdict === "refused" ? text : null }))) return;
  const n = r.warnings.length;
  await event(ctx.env, p.id, verdict === "refused" ? `check failed: ${text}`
    : `checked, ${text} Waits for the owner's "sì"${n ? ` (${n} warning${n > 1 ? "s" : ""})` : ""}.`, ctx.nowMs);
}

async function pollProbe(ctx: Ctx, p: PostRow): Promise<void> {
  const a = await accountOf(ctx);
  if (!a.ok || !p.probe_container) return;
  let st: { status_code?: string; status?: string };
  try { st = await statusOf(a.graph, p.probe_container); } catch (e) {
    if (e instanceof GraphError && !e.uncertain) await probeDone(ctx, p, "refused", `Meta lost the probe container: ${why(e)}`);
    return;
  }
  const code = String(st.status_code ?? "").toUpperCase();
  const took = Math.max(1, Math.round((ctx.nowMs - Date.parse(p.probe_at ?? p.updated_at)) / MIN));
  if (code === "FINISHED") { await probeDone(ctx, p, "taken", `Meta fetched the video and accepted the request (FINISHED after ${took} min; the probe container is never published).`); return; }
  if (code === "ERROR" || code === "EXPIRED") {
    await probeDone(ctx, p, "refused", `Meta refused the reel at the probe (${code}${st.status ? `: ${st.status}` : ""}).`);
    return;
  }
  if (code === "PUBLISHED") {
    await probeDone(ctx, p, "refused", `The probe container ${p.probe_container} was published, and never by this Worker: look at @kleooai before anything else.`);
    return;
  }
  const polls = p.probe_polls + 1;
  if (polls < POLLS_MAX) {
    await ctx.env.DB.prepare("UPDATE ig_posts SET probe_polls = ?, updated_at = ? WHERE id = ? AND state = 'probing'").bind(polls, iso(ctx.nowMs), p.id).run();
    return;
  }
  await probeDone(ctx, p, "slow", `Meta was still processing the probe after ${POLLS_MAX} minutes: nothing was refused, and at the time the real container gets ${CONTAINER_TRIES} tries.`);
}

async function makeContainer(ctx: Ctx, p: PostRow): Promise<void> {
  const r = await check(ctx, p);
  if (r.transient) { await event(ctx.env, p.id, `the last check waits: ${r.errors.join(" | ")}`, ctx.nowMs); return; }
  if (!r.ok) { await fail(ctx, p, `The check before publishing failed: ${r.errors.join(" | ")}`, "invalid", r); return; }
  if ((await approvalHash(p, r.etag)) !== p.approved_hash) {
    await fail(ctx, p, "The post or its file changed after the owner approved it: it needs a new check and a new \"sì\".", "invalid", r);
    return;
  }
  if (r.quotaFull) { await event(ctx.env, p.id, `waiting for room in Meta's quota (${r.quota})`, ctx.nowMs); return; }
  const a = await accountOf(ctx);
  if (!a.ok) return;
  const tries = p.container_tries + 1;
  let id = "";
  try {
    id = String((await a.graph.post<{ id?: string | number }>(`${a.igId}/media`, containerParams(p))).id ?? "");
    if (!id) throw new Error("Instagram answered without a container id");
  } catch (e) {
    await ctx.env.DB.prepare("UPDATE ig_posts SET container_tries = ?, error = ?, updated_at = ? WHERE id = ? AND state = 'checked'")
      .bind(tries, why(e), iso(ctx.nowMs), p.id).run();
    p.container_tries = tries;
    if (tries >= CONTAINER_TRIES) await fail(ctx, p, `Instagram refused the reel: ${why(e)}`);
    else await event(ctx.env, p.id, `container refused, trying again next minute: ${why(e)}`, ctx.nowMs);
    return;
  }
  await move(ctx, p, "container", { container_id: id, container_at: iso(ctx.nowMs), polls: 0, container_tries: tries, check_json: JSON.stringify(r), checked_at: iso(ctx.nowMs), error: null });
  await event(ctx.env, p.id, `container ${id} made${r.video ? ` (${r.video})` : ""}`, ctx.nowMs);
}

async function poll(ctx: Ctx, p: PostRow): Promise<void> {
  const a = await accountOf(ctx);
  if (!a.ok || !p.container_id) return;
  let st: { status_code?: string; status?: string };
  try { st = await statusOf(a.graph, p.container_id); } catch (e) {
    if (e instanceof GraphError && !e.uncertain) await fail(ctx, p, `Instagram lost the container: ${why(e)}`);
    return;
  }
  const code = String(st.status_code ?? "").toUpperCase();
  if (code === "FINISHED") {
    await move(ctx, p, "ready", { polls: p.polls + 1 });
    await event(ctx.env, p.id, "Instagram processed the video: ready", ctx.nowMs);
    if (ctx.nowMs >= Date.parse(p.publish_at)) await publish(ctx, p);
    return;
  }
  if (code === "PUBLISHED") { await settle(ctx, a, p); return; }
  if (code === "ERROR" || code === "EXPIRED") { await fail(ctx, p, `Instagram could not take the video (${code}${st.status ? `: ${st.status}` : ""}).`); return; }
  const polls = p.polls + 1;
  if (polls < POLLS_MAX) {
    await ctx.env.DB.prepare("UPDATE ig_posts SET polls = ?, updated_at = ? WHERE id = ? AND state = 'container'").bind(polls, iso(ctx.nowMs), p.id).run();
    return;
  }
  if (p.container_tries < CONTAINER_TRIES) {
    await move(ctx, p, "checked", { polls, container_id: null });
    await event(ctx.env, p.id, `still processing after ${POLLS_MAX} minutes: a new container next minute`, ctx.nowMs);
    return;
  }
  await fail(ctx, p, `Instagram was still processing the video after ${POLLS_MAX} minutes, twice.`);
}

/** Meta's codes for "not now" (rate limits, a service hiccup, media not ready yet): the same call later may work. */
const retryable = (e: GraphError): boolean => e.status === 429 || [1, 2, 4, 17, 32, 341, 613, 9007].includes(e.code ?? -1);

async function publish(ctx: Ctx, p: PostRow): Promise<void> {
  const a = await accountOf(ctx);
  if (!a.ok || !p.container_id) return;
  try {
    const q = await publishingQuota(a.graph, a.igId);
    if (q.usage >= q.total) { await event(ctx.env, p.id, `waiting for room in Meta's quota (${q.usage} of ${q.total})`, ctx.nowMs); return; }
  } catch { /* media_publish enforces the quota itself */ }
  // The last check was LEAD_MIN ago: a reel the owner posted by hand since then (this one, maybe) stops it here.
  try {
    const ours = new Set(((await ctx.env.DB.prepare("SELECT media_id FROM ig_posts WHERE media_id IS NOT NULL").all<{ media_id: string }>()).results ?? []).map((r) => r.media_id));
    const near = gapProblems(Date.parse(p.publish_at), (await recentMedia(a.graph, a.igId)).filter((m) => !ours.has(m.id))
      .map((m) => ({ label: `the post ${m.permalink ?? m.id} (${fmtNz(m.ms)})`, ms: m.ms })));
    if (near.length) { await fail(ctx, p, `Something went out on the account meanwhile, so this reel did not. ${near.join(" ")}`); return; }
  } catch { /* the check LEAD_MIN ago saw none */ }
  if (!(await move(ctx, p, "publishing", { publish_tries: p.publish_tries + 1, publish_started_at: iso(ctx.nowMs) }))) return;
  let mediaId = "";
  try {
    mediaId = String((await a.graph.post<{ id?: string | number }>(`${a.igId}/media_publish`, { creation_id: p.container_id })).id ?? "");
  } catch (e) {
    if (e instanceof GraphError && !e.uncertain) {
      if (retryable(e) && p.publish_tries < PUBLISH_TRIES) {
        await move(ctx, p, "ready", { error: e.message });
        await event(ctx.env, p.id, `Instagram said not now, publishing again next minute: ${e.message}`, ctx.nowMs);
      } else await fail(ctx, p, `Instagram refused to publish it: ${e.message}`);
      return;
    }
    await event(ctx.env, p.id, `no answer from media_publish (${why(e)}): the container's status decides next minute`, ctx.nowMs);
    return;
  }
  if (!mediaId) { await event(ctx.env, p.id, "media_publish answered without a media id: the container's status decides next minute", ctx.nowMs); return; }
  await published(ctx, a, p, mediaId);
}

/** The answer of media_publish was lost: published or not, the container knows. */
async function resolvePublishing(ctx: Ctx, p: PostRow): Promise<void> {
  if (ctx.nowMs > Date.parse(p.publish_started_at ?? p.publish_at) + 60 * MIN) {
    await fail(ctx, p, "Instagram never said whether the reel went out. Look at @kleooai before posting it again.");
    return;
  }
  const a = await accountOf(ctx);
  if (!a.ok || !p.container_id) return;
  let st: { status_code?: string; status?: string };
  try { st = await statusOf(a.graph, p.container_id); } catch { return; }
  const code = String(st.status_code ?? "").toUpperCase();
  if (code === "PUBLISHED") { await settle(ctx, a, p); return; }
  if (code === "FINISHED") {
    if (ctx.nowMs > Date.parse(p.publish_at) + GRACE_MIN * MIN) await fail(ctx, p, "It did not go out, and its time has passed.", "missed");
    else if (p.publish_tries >= PUBLISH_TRIES) await fail(ctx, p, `Instagram did not publish it after ${PUBLISH_TRIES} tries.`);
    else if (await move(ctx, p, "ready")) {
      await event(ctx.env, p.id, "it did not go out: publishing again", ctx.nowMs);
      await publish(ctx, p);
    }
    return;
  }
  if (code === "ERROR" || code === "EXPIRED") await fail(ctx, p, `Instagram could not publish it (${code}${st.status ? `: ${st.status}` : ""}).`);
}

async function step(ctx: Ctx, p: PostRow): Promise<void> {
  const at = Date.parse(p.publish_at);
  if (p.state === "published") {
    if (!p.media_id || p.permalink) return;
    const a = await accountOf(ctx);
    const link = a.ok ? await permalinkOf(a.graph, p.media_id) : null;
    if (link) {
      await ctx.env.DB.prepare("UPDATE ig_posts SET permalink = ? WHERE id = ?").bind(link, p.id).run();
      await event(ctx.env, p.id, `permalink ${link}`, ctx.nowMs);
    }
    return;
  }
  if (p.state === "new") {
    const r = await check(ctx, p);
    if (r.transient) {
      await ctx.env.DB.prepare("UPDATE ig_posts SET check_json = ?, checked_at = ?, error = ?, updated_at = ? WHERE id = ? AND state = 'new'")
        .bind(JSON.stringify(r), iso(ctx.nowMs), r.errors[0] ?? null, iso(ctx.nowMs), p.id).run();
      return;
    }
    if (r.ok && p.probe) { await startProbe(ctx, p, r); return; }
    if (!(await move(ctx, p, r.ok ? "checked" : "invalid", { check_json: JSON.stringify(r), checked_at: iso(ctx.nowMs), video_etag: r.etag, error: r.ok ? null : r.errors[0] }))) return;
    const n = r.warnings.length;
    await event(ctx.env, p.id, r.ok ? `checked: waits for the owner's "sì"${n ? ` (${n} warning${n > 1 ? "s" : ""})` : ""}` : `check failed: ${r.errors.join(" | ")}`, ctx.nowMs);
    return;
  }
  if (p.state === "publishing") { await resolvePublishing(ctx, p); return; }
  if (ctx.nowMs > at + GRACE_MIN * MIN) {
    if (p.approved_at) await fail(ctx, p, `Its time (${fmtNz(at)}) passed before it could go out${p.error ? `: ${p.error}` : "."}`, "missed");
    else if (await move(ctx, p, "missed", { error: "never approved" })) await event(ctx.env, p.id, "missed: the owner never approved it", ctx.nowMs);
    return;
  }
  if (p.state === "probing") { await pollProbe(ctx, p); return; }
  if (p.state === "checked") {
    if (p.approved_at && ctx.nowMs >= at - LEAD_MIN * MIN) await makeContainer(ctx, p);
    return;
  }
  if (p.state === "container") { await poll(ctx, p); return; }
  if (p.state === "ready" && ctx.nowMs >= at) await publish(ctx, p);
}

/** Whether a post has anything to do this minute: a post that only waits costs no write. */
function due(p: { state: string; publish_at: string; approved_at: string | null }, nowMs: number): boolean {
  const at = Date.parse(p.publish_at);
  if (nowMs > at + GRACE_MIN * MIN) return true;
  if (p.state === "checked") return !!p.approved_at && nowMs >= at - LEAD_MIN * MIN;
  if (p.state === "ready") return nowMs >= at;
  return true;
}

/** One cron minute: every post one step, then the token's renewal and its expiry warning. */
export async function tick(env: IgEnv, nowMs = Date.now(), fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<void> {
  await ensureSchema(env);
  const ctx: Ctx = { env, nowMs, fetcher, host: env.IG_MEDIA_HOST || MEDIA_HOST, account: null };
  const rows = (await env.DB.prepare(`SELECT id, state, publish_at, approved_at FROM ig_posts
      WHERE state IN ('new', 'probing', 'checked', 'container', 'ready', 'publishing')
      OR (state = 'published' AND permalink IS NULL AND media_id IS NOT NULL AND published_at > ?) ORDER BY publish_at, id`)
    .bind(iso(nowMs - DAY)).all<{ id: string; state: string; publish_at: string; approved_at: string | null }>()).results ?? [];
  for (const { id } of rows.filter((p) => due(p, nowMs))) {
    // A lease, so that a minute that runs long and the next one never work on the same post.
    const lease = `${iso(nowMs + LEASE_MIN * MIN)}#${Math.random().toString(36).slice(2, 10)}`;
    const got = await env.DB.prepare("UPDATE ig_posts SET lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)").bind(lease, id, iso(nowMs)).run();
    if (got.meta.changes !== 1) continue;
    try {
      const p = await env.DB.prepare("SELECT * FROM ig_posts WHERE id = ?").bind(id).first<PostRow>();
      if (p) await step(ctx, p);
    } catch (e) {
      await event(env, id, `error: ${why(e)}`, nowMs).catch(() => undefined);
    } finally {
      await env.DB.prepare("UPDATE ig_posts SET lease_until = NULL WHERE id = ? AND lease_until = ?").bind(id, lease).run();
    }
  }
  const renewed = await renewIfDue(env, nowMs, fetcher).catch((e) => `token renewal error: ${why(e)}`);
  if (renewed) await event(env, null, renewed, nowMs);
  const warning = await expiryWarning(env, nowMs).catch(() => null);
  if (warning) {
    await event(env, null, warning, nowMs);
    await mailOwner(env, "Kleo Instagram: the token needs you", `${warning}\n\nMake a new one in the Meta app (Instagram, API setup with Instagram login, Generate token) and paste it into the kleo-ig-publisher secret IG_ACCESS_TOKEN (docs/IG-PUBLISHER.md, step 5).\n`, nowMs);
  }
}
