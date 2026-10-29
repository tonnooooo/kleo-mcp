/**
 * KLEO INSTAGRAM PUBLISHER — WHAT A SCHEDULED REEL MUST BE (29 October 2026).
 *
 * Why the publisher exists: every reel scheduled with Instagram's own scheduler, from instagram.com or from the phone
 * app, was stored at 720x1280 (6 of 6 read through media info on 29 Oct 2026, SHA-checked 1080x1920 files included),
 * while the owner's reels published at once from the app keep 1080x1920. So the kleo-ig-publisher Worker
 * (src/ig/index.ts) publishes them itself, at the chosen minute, through the official Instagram API with Instagram
 * Login (graph.instagram.com; docs/IG-PUBLISHER.md). Whether the API keeps 1080p is not documented: the first post says.
 *
 * This file is pure, shared by the Worker and by scripts/ig-schedule.mjs (which adds entries from the owner's PC):
 *  - marketing/ACCOUNT_RULES.md: at most 5 hashtags and none of #fyp/#viral (14), no engagement bait (15), 3 hours
 *    between posts (16), the US-evening slot (18), the per-post AI label on (19);
 *  - Meta: a caption of at most 2,200 characters and 20 @mentions, the video on a public server when Meta fetches it.
 */

export const NZ = "Pacific/Auckland";
export const MEDIA_HOST = "media.kleooai.com";
export const MAX_HASHTAGS = 5;
export const MIN_GAP_H = 3;
export const MAX_CAPTION = 2200;
export const MAX_MENTIONS = 20;
/** Minutes before the publish time when the container is made, so that the reel goes live on the minute. */
export const LEAD_MIN = 7;
/** An entry must reach the schedule this early: the cloud check runs first, then the owner says "sì". */
export const MIN_AHEAD_MIN = 10;
/** A date further away is more likely a typo (a wrong month or year) than a plan. */
export const MAX_AHEAD_DAYS = 45;
export const VIDEO_EXT = /\.(mp4|mov)$/i;
export const COVER_EXT = /\.(jpe?g)$/i;
export const TRIALS = ["MANUAL", "SS_PERFORMANCE"] as const;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** One post as the owner's side writes it (scripts/ig-schedule.mjs add <entry.json>). */
export interface Entry {
  /** https://media.kleooai.com/ig/<file>.mp4: the R2 bucket kleo-media, uploaded with scripts/ig-schedule.mjs upload. */
  video: string;
  caption: string;
  /** New Zealand time, "2026-11-02 13:30" (or an ISO time with its offset). */
  at: string;
  /** Instagram's "AI info" label (is_ai_generated): always true (ACCOUNT_RULES 19). */
  ai: boolean;
  /** A cover picture on media.kleooai.com (JPEG); without one, thumb_offset_ms picks the frame (default the first). */
  cover?: string;
  thumb_offset_ms?: number;
  /** A Trial Reel (ACCOUNT_RULES 20): shown to non-followers first. MANUAL or SS_PERFORMANCE. */
  trial?: string;
  /** The owner asked for a time outside the US-evening slot (ACCOUNT_RULES 18 is a default, not a law). */
  outside_window?: boolean;
  id?: string;
}

/** One post as D1 keeps it (ig_posts), before anything happened to it. */
export interface Post {
  id: string;
  video_url: string;
  caption: string;
  /** UTC, ISO. */
  publish_at: string;
  /** The time as the entry wrote it. */
  at_local: string;
  cover_url: string | null;
  thumb_offset_ms: number | null;
  trial: string | null;
  outside_window: number;
}

export interface Verdict { errors: string[]; warnings: string[] }

// ── time ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Wall { y: number; mo: number; d: number; h: number; mi: number }
function wall(ms: number, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(ms);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: n("year"), mo: n("month"), d: n("day"), h: n("hour"), mi: n("minute") };
}
const offsetMin = (ms: number, timeZone: string): number => {
  const w = wall(ms, timeZone);
  return (Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(ms / MIN) * MIN) / MIN;
};

/** The instant a wall-clock time names in a time zone, or null when that time does not exist there (clocks jumped). */
export function zonedToMs(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number | null {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let ms = want - offsetMin(want, timeZone) * MIN;
  ms = want - offsetMin(ms, timeZone) * MIN;
  const w = wall(ms, timeZone);
  return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi ? ms : null;
}

/** "2026-11-02 13:30" in New Zealand, or an ISO time with Z or an offset. */
export function parseAt(at: string): { ms: number } | { error: string } {
  const s = at.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(s);
  if (local) {
    const [y, mo, d, h, mi] = local.slice(1).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return { error: `"${at}" is not a time` };
    const ms = zonedToMs(y, mo, d, h, mi, NZ);
    return ms === null ? { error: `${s} does not exist in New Zealand (the clocks jump that night)` } : { ms };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return { ms };
  }
  return { error: `"${at}" is not a time: write New Zealand time as "2026-11-02 13:30"` };
}

/** "Mon 2 Nov 2026, 13:30 NZDT" */
export function fmtNz(ms: number): string {
  if (!Number.isFinite(ms)) return "an unknown time";
  const f = new Intl.DateTimeFormat("en-NZ", {
    timeZone: NZ, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(ms);
  const v = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return `${v("weekday")} ${v("day")} ${v("month")} ${v("year")}, ${v("hour")}:${v("minute")} ${v("timeZoneName")}`;
}

/**
 * ACCOUNT_RULES 18: "12:00-17:00 NZDT (13:00-18:00 from 2 Nov, when US clocks go back)", that is the US evening,
 * 19:00 to midnight in New York. Kept as New York time so that it stays right through every clock change on either
 * side (on 30 Oct 2026 19:00 EDT is 12:00 NZDT; on 2 Nov 19:00 EST is 13:00 NZDT). Both ends are inside.
 */
export function inUsEvening(ms: number): boolean {
  const w = wall(ms, "America/New_York");
  const m = w.h * 60 + w.mi;
  return m >= 19 * 60 || m === 0;
}

// ── the caption ──────────────────────────────────────────────────────────────────────────────────────────────────

export function hashtags(caption: string): string[] {
  const tags = [...caption.matchAll(/(?:^|[^\p{L}\p{N}_&#])#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase());
  return [...new Set(tags)];
}
export function mentions(caption: string): string[] {
  return [...caption.matchAll(/(?:^|[^\p{L}\p{N}_.@])@([A-Za-z0-9._]{1,30})/gu)].map((m) => m[1].toLowerCase());
}
/** ACCOUNT_RULES 14: no #fyp or #viral (and their obvious variants). */
const BANNED_TAG = /^(fyp|foryou|viral)/;
/** ACCOUNT_RULES 15: asks made only to inflate engagement, which both platforms treat as bait. */
const BAIT: [RegExp, string][] = [
  [/follow\s+(?:me\s+|us\s+)?for\s+(?:a\s+)?part\s*(?:2|two)\b/i, "\"follow for part 2\""],
  [/comment\s+["'“‘]?yes\b/i, "\"comment YES\""],
  [/tag\s+(?:a|your)\s+(?:friend|bestie|buddy|mate)\b/i, "\"tag a friend\""],
];

export function captionProblems(caption: string): Verdict {
  const errors: string[] = [], warnings: string[] = [];
  const chars = [...caption].length;
  if (chars > MAX_CAPTION) errors.push(`The caption has ${chars} characters; Instagram takes at most ${MAX_CAPTION}.`);
  if (!caption.trim()) warnings.push("The caption is empty.");
  const tags = hashtags(caption);
  if (tags.length > MAX_HASHTAGS) errors.push(`The caption has ${tags.length} hashtags; at most ${MAX_HASHTAGS} (ACCOUNT_RULES 14): ${tags.map((t) => `#${t}`).join(" ")}`);
  const banned = tags.filter((t) => BANNED_TAG.test(t));
  if (banned.length) errors.push(`No ${banned.map((t) => `#${t}`).join(", ")}: ACCOUNT_RULES 14 rules out #fyp and #viral.`);
  const ats = mentions(caption);
  if (ats.length > MAX_MENTIONS) errors.push(`The caption has ${ats.length} @mentions; Instagram takes at most ${MAX_MENTIONS}.`);
  for (const [re, what] of BAIT) if (re.test(caption)) errors.push(`The caption asks ${what}: engagement bait (ACCOUNT_RULES 15).`);
  if (/comment\s+["'“‘]?kleo\b/i.test(caption)) warnings.push("\"Comment KLEO\" only if the link really arrives in the DMs (ACCOUNT_RULES 15).");
  return { errors, warnings };
}

// ── the files ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The R2 key behind https://media.kleooai.com/<key>, or null for any other address. */
export function mediaKey(url: string, host: string, ext: RegExp): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== host || u.port || u.search || u.hash || u.username) return null;
  let key: string;
  try { key = decodeURIComponent(u.pathname.slice(1)); } catch { return null; }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(key) || key.includes("..") || key.includes("//")) return null;
  return ext.test(key) ? key : null;
}

// ── the gap between posts ────────────────────────────────────────────────────────────────────────────────────────

const span = (ms: number): string => {
  const m = Math.round(Math.abs(ms) / MIN);
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
};
/** ACCOUNT_RULES 16: at least 3 hours between posts on Instagram, never two at once. */
export function gapProblems(atMs: number, others: { label: string; ms: number }[]): string[] {
  return others.filter((o) => Number.isFinite(o.ms) && Math.abs(o.ms - atMs) < MIN_GAP_H * HOUR)
    .map((o) => `Only ${span(o.ms - atMs)} from ${o.label}: ACCOUNT_RULES 16 wants at least ${MIN_GAP_H} hours between posts.`);
}

// ── one entry, one post ──────────────────────────────────────────────────────────────────────────────────────────

const KNOWN = new Set(["video", "caption", "at", "ai", "cover", "thumb_offset_ms", "trial", "outside_window", "id"]);

/** The rules every post must keep whenever it is looked at: when it is added, at its cloud check, before it goes out. */
export function postProblems(p: Post, host = MEDIA_HOST): Verdict {
  const v = captionProblems(p.caption);
  const errors = [...v.errors], warnings = [...v.warnings];
  const at = Date.parse(p.publish_at);
  if (!Number.isFinite(at)) errors.push(`"${p.publish_at}" is not a time.`);
  else if (!inUsEvening(at)) {
    const where = `${fmtNz(at)} is outside the US-evening slot (ACCOUNT_RULES 18: 12:00-17:00 NZDT, 13:00-18:00 NZDT from 2 Nov)`;
    if (p.outside_window) warnings.push(`${where}, by the owner's choice.`);
    else errors.push(`${where}. Set "outside_window": true only when the owner asked for this time.`);
  }
  if (!mediaKey(p.video_url, host, VIDEO_EXT)) errors.push(`The video must be an .mp4 or .mov at https://${host}/… (the R2 bucket kleo-media): ${p.video_url}`);
  if (p.cover_url && !mediaKey(p.cover_url, host, COVER_EXT)) errors.push(`The cover must be a .jpg at https://${host}/…: ${p.cover_url}`);
  if (p.cover_url && p.thumb_offset_ms !== null) warnings.push("thumb_offset_ms is ignored: the cover picture wins.");
  if (p.thumb_offset_ms !== null && !(Number.isInteger(p.thumb_offset_ms) && p.thumb_offset_ms >= 0 && p.thumb_offset_ms <= 15 * MIN)) errors.push("thumb_offset_ms is a whole number of milliseconds into the video.");
  if (p.trial !== null && !(TRIALS as readonly string[]).includes(p.trial)) errors.push(`"trial" is ${TRIALS.join(" or ")}.`);
  if (!/^[a-z0-9][a-z0-9-]{2,59}$/.test(p.id)) errors.push(`The id "${p.id}" may hold only a-z, 0-9 and "-" (3 to 60).`);
  return { errors, warnings };
}

/** "ig-2026-11-02-rx7-reveal": the New Zealand date and the video's file name. */
export function defaultId(videoUrl: string, atMs: number): string {
  const w = wall(atMs, NZ);
  const date = `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
  let base = "";
  try { base = decodeURIComponent(new URL(videoUrl).pathname.split("/").pop() ?? ""); } catch { /* not a URL: the date alone */ }
  base = base.replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (base.startsWith(date)) base = base.slice(date.length).replace(/^-+/, "");
  return `ig-${date}${base ? `-${base}` : ""}`.slice(0, 60).replace(/-+$/, "");
}

/** An entry from the owner's side checked and turned into the post D1 keeps, or what is wrong with it. */
export function validateEntry(input: unknown, nowMs: number, host = MEDIA_HOST): Verdict & { post: Post | null } {
  const errors: string[] = [], warnings: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { errors: ["The entry is a JSON object."], warnings, post: null };
  const e = input as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!KNOWN.has(k)) errors.push(`Unknown field "${k}" (known: ${[...KNOWN].join(", ")}).`);
  const str = (k: string): string | null => (typeof e[k] === "string" ? (e[k] as string) : null);
  const video = str("video"), caption = str("caption"), at = str("at");
  if (!video) errors.push("\"video\" is the reel's https://media.kleooai.com/… address.");
  if (caption === null) errors.push("\"caption\" is the text under the reel.");
  if (!at) errors.push("\"at\" is the New Zealand time to publish, \"2026-11-02 13:30\".");
  if (e.ai !== true) errors.push("\"ai\": true is required: every Kleo reel carries Instagram's AI label (ACCOUNT_RULES 19).");
  if (e.cover !== undefined && typeof e.cover !== "string") errors.push("\"cover\" is a https://media.kleooai.com/….jpg address.");
  if (e.thumb_offset_ms !== undefined && typeof e.thumb_offset_ms !== "number") errors.push("\"thumb_offset_ms\" is a number.");
  if (e.trial !== undefined && typeof e.trial !== "string") errors.push(`"trial" is ${TRIALS.join(" or ")}.`);
  if (e.outside_window !== undefined && typeof e.outside_window !== "boolean") errors.push("\"outside_window\" is true or false.");
  if (e.id !== undefined && typeof e.id !== "string") errors.push("\"id\" is a short name.");
  if (!video || caption === null || !at) return { errors, warnings, post: null };
  const when = parseAt(at);
  if ("error" in when) return { errors: [...errors, when.error], warnings, post: null };
  if (when.ms < nowMs + MIN_AHEAD_MIN * MIN) errors.push(`${fmtNz(when.ms)} is too soon: at least ${MIN_AHEAD_MIN} minutes ahead, so the cloud check and the owner's "sì" come first.`);
  if (when.ms > nowMs + MAX_AHEAD_DAYS * 24 * HOUR) errors.push(`${fmtNz(when.ms)} is more than ${MAX_AHEAD_DAYS} days away: check the date.`);
  const post: Post = {
    id: str("id") ?? defaultId(video, when.ms),
    video_url: video.trim(),
    caption: caption.replace(/\r\n/g, "\n").trim(),
    publish_at: new Date(when.ms).toISOString(),
    at_local: at.trim(),
    cover_url: str("cover")?.trim() || null,
    thumb_offset_ms: typeof e.thumb_offset_ms === "number" ? e.thumb_offset_ms : null,
    trial: str("trial"),
    outside_window: e.outside_window === true ? 1 : 0,
  };
  const v = postProblems(post, host);
  return { errors: [...errors, ...v.errors], warnings: [...warnings, ...v.warnings], post };
}

// ── what Meta receives ───────────────────────────────────────────────────────────────────────────────────────────

/** The body of POST /<IG_ID>/media for this reel; the token travels in the Authorization header, never here. */
export function containerParams(p: Post): Record<string, unknown> {
  const out: Record<string, unknown> = {
    media_type: "REELS", video_url: p.video_url, caption: p.caption, share_to_feed: true, is_ai_generated: true,
  };
  if (p.cover_url) out.cover_url = p.cover_url;
  else if (p.thumb_offset_ms !== null) out.thumb_offset = p.thumb_offset_ms;
  if (p.trial) out.trial_params = { graduation_strategy: p.trial };
  return out;
}

/**
 * What the owner's "sì" covers: the post exactly as it was checked, and the video file by its R2 etag. The Worker
 * recomputes it right before the container: a caption, a time or a file changed afterwards is never published.
 */
export async function approvalHash(p: Post, etag: string | null): Promise<string> {
  const text = JSON.stringify([p.id, p.video_url, p.caption, p.publish_at, p.cover_url, p.thumb_offset_ms, p.trial, p.outside_window, etag]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
