/**
 * THE KLEO MARK ON FREE CREATIONS (28 October 2026). The owner launched Kleo Creators the same day: creators pay a plan,
 * so what they post is clean, and everything an account that never paid makes carries "Made with Kleo", so every free
 * picture and clip shared online advertises Kleo.
 *
 *   saving    the clean file goes to R2 as before; for an account that shows the mark (generate.ts showsMark) a marked
 *             copy is saved next to it, under the same name with ".mark" before the extension
 *             (studio/<user>/<gen>.mp4 → studio/<user>/<gen>.mark.mp4), so deleting the account's prefix deletes both.
 *   pictures  Cloudflare Images (the IMAGES binding) draws the mark: one transformation per picture, 5,000 a month
 *             included, then $0.50 per 1,000.
 *   clips     the kleo-watermark Worker (the WATERMARK service binding, watermark/) burns it in with ffmpeg inside a
 *             Cloudflare Container: measured $0.000061 per 10-second 480p clip and $0.000125 at 720p after the Workers
 *             Paid allowance, which alone covers about 11,000 free clips a month (watermark/README.md).
 *   films     animatics (and the launch-code trial film) are 4K 60 fps: the mark is burned in on the GPU box before the
 *             video is uploaded (src/mark.ts decides at order time, params.mark; worker/kleo_mark.py), so Studio's
 *             copy, the MCP /dl links and the job-done e-mail all carry it. Studio copies and serves them as they are.
 *   serving   /media/... sends the marked copy while the owner still shows the mark and the copy exists; the first
 *             purchase takes the mark off every picture and clip the account made (not off an animatic: its mark is
 *             in the video itself). Providers read the clean file through /media/raw/<upload> (signed links only),
 *             so a free picture animated into a clip is not marked twice.
 *
 * Fails open: a picture or a clip the mark could not be put on is kept and served clean, and the miss is written to
 * the audit (studio.mark_failed). A creation never fails because of its mark. A picture missing its copy gets one the
 * next time it is served (servedKey, healPicture).
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { audit } from "../db.ts";
import { mailOwner } from "./providers.ts";

/** The mark (studio-web/made-with-kleo.png, the same file as kleooai.com/brand/made-with-kleo.png) and its size. */
export const MARK_PATH = "/made-with-kleo.png";
export const MARK_W = 1428;
export const MARK_H = 384;
/** The pill is already 78% opaque; drawn at 0.9 it stays readable on a white picture and quiet on a dark one. */
export const MARK_OPACITY = 0.9;
/**
 * How long Studio waits for kleo-watermark on one clip. Only Studio's own clips come here (480p-1080p, at most 15 s:
 * a 10 s 720p clip takes 16 s on the Container); animatics and films carry the mark from the GPU render. The clip's
 * download (90 s) plus this wait stay under the 4 minutes after which refreshGeneration takes a "saving" row back.
 * watermark/server.py stops its ffmpeg a little before this.
 */
export const VIDEO_MARK_TIMEOUT_MS = 120_000;
/** The Images binding's largest input (developers.cloudflare.com/images/get-started/limits): bigger pictures stay clean. */
export const IMAGES_MAX_INPUT = 20 * 1024 * 1024;

export interface MarkPlace { width: number; height: number; x: number; y: number }

/** A picture over the Images binding's input: expected (a 4K PNG), written to the audit, never an alert. */
class TooBigForImages extends Error {}

/**
 * Where the mark goes on a frame of w × h pixels, as its size and its top-left corner. watermark/server.py has the
 * same rule for clips: change both together.
 *  - Tall frames (9:16 Reels and TikToks, 3:4): top left, 8% down. The bottom and the right edge of a vertical feed are
 *    under the caption and the like/comment/share buttons, the top 6-7% under the app's own header.
 *  - Square and landscape frames: bottom right, where a mark is expected.
 * Width 32% of a tall frame and 22% of the others, never under 96 px (smaller and "Made with" stops being legible
 * on a phone), with a margin of 4% of the width.
 */
export function markPlacement(w: number, h: number): MarkPlace | null {
  if (!(w >= 64 && h >= 64)) return null;
  const tall = h >= w * 1.25;
  const margin = Math.round(w * 0.04);
  const room = w - 2 * margin;
  const width = Math.min(room, Math.max(96, Math.round(w * (tall ? 0.32 : 0.22))));
  const height = Math.max(1, Math.round((width * MARK_H) / MARK_W));
  if (height > h - 2 * margin) return null;
  return tall ? { width, height, x: margin, y: Math.round(h * 0.08) } : { width, height, x: w - width - margin, y: h - height - margin };
}

/** The marked copy's key: ".mark" before the extension, in the same folder. */
export function markedKey(key: string): string {
  const m = /^(.*?)(\.[a-z0-9]{1,5})?$/i.exec(key)!;
  return `${m[1]}.mark${m[2] ?? ""}`;
}

/** True for a file Kleo made for the account (never the person's own uploads under studio/<user>/up/). */
export const madeByKleo = (key: string, userId: string): boolean => key.startsWith(`studio/${userId}/`) && !key.startsWith(`studio/${userId}/up/`);

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Blob([bytes]).stream();

let markBytes: Uint8Array | null = null;
async function mark(env: StudioEnv): Promise<Uint8Array> {
  if (markBytes) return markBytes;
  const res = await env.ASSETS.fetch(new Request(`https://assets.kleo${MARK_PATH}`));
  const bytes = new Uint8Array(await res.arrayBuffer());
  // The asset fallback answers the app's HTML for a missing file: only a PNG is the mark.
  if (!res.ok || bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error(`the mark ${MARK_PATH} is missing from studio-web`);
  return (markBytes = bytes);
}

const PICTURE_FORMATS: Record<string, "image/jpeg" | "image/png" | "image/webp"> = { "image/jpeg": "image/jpeg", "image/png": "image/png", "image/webp": "image/webp" };

/** The picture with the mark drawn on it, in its own format; null when it cannot carry one (no binding, a GIF, too small). */
export async function markPicture(env: StudioEnv, bytes: Uint8Array, type: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  const format = PICTURE_FORMATS[type];
  if (!env.IMAGES || !format) return null;
  if (bytes.byteLength > IMAGES_MAX_INPUT) throw new TooBigForImages(`the picture is ${Math.round(bytes.byteLength / 1048576)} MB, over the Images binding's 20 MB input`);
  const info = await env.IMAGES.info(streamOf(bytes));
  if (!("width" in info)) return null;
  const at = markPlacement(info.width, info.height);
  if (!at) return null;
  const out = await env.IMAGES.input(streamOf(bytes))
    .draw(env.IMAGES.input(streamOf(await mark(env))).transform({ width: at.width }), { top: at.y, left: at.x, opacity: MARK_OPACITY })
    .output({ format, quality: 92 });
  return { bytes: new Uint8Array(await out.response().arrayBuffer()), type: out.contentType() };
}

/**
 * Sends the clip saved at `key` through the kleo-watermark Worker and saves what comes back at markedKey(key).
 * Null when the Worker is not bound (the clip stays clean). Streams both ways, so no clip is held in memory.
 */
export async function markVideo(env: StudioEnv, key: string): Promise<{ key: string; size: number; cpuS: number | null } | null> {
  if (!env.WATERMARK) return null;
  const src = await env.RENDERS.get(key);
  if (!src) throw new Error("the clip is not in storage");
  const body = new FixedLengthStream(src.size);
  const [res] = await Promise.all([
    env.WATERMARK.fetch("https://kleo-watermark/mark", { method: "POST", body: body.readable, headers: { "content-type": "video/mp4" }, signal: AbortSignal.timeout(VIDEO_MARK_TIMEOUT_MS) }),
    src.body.pipeTo(body.writable),
  ]);
  if (!res.ok || !res.body) throw new Error(`kleo-watermark answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const out = markedKey(key);
  const len = Number(res.headers.get("content-length") ?? 0);
  let size: number;
  if (len > 0) {
    const fixed = new FixedLengthStream(len);
    const [obj] = await Promise.all([env.RENDERS.put(out, fixed.readable, { httpMetadata: { contentType: "video/mp4" } }), res.body.pipeTo(fixed.writable)]);
    size = obj?.size ?? len;
  } else {
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1000) throw new Error("kleo-watermark answered an empty clip");
    size = (await env.RENDERS.put(out, buf, { httpMetadata: { contentType: "video/mp4" } }))?.size ?? buf.byteLength;
  }
  const cpu = Number(res.headers.get("x-mark-cpu-s"));
  return { key: out, size, cpuS: Number.isFinite(cpu) && cpu > 0 ? cpu : null };
}

/**
 * Saves the marked copy of one file Kleo just saved for an account that shows the mark. Never throws: a miss is
 * written to the audit and the file stays clean. `bytes` are the picture's (a clip is read back from R2).
 */
export async function saveMarkedCopy(env: StudioEnv, who: { userId: string; genId: string }, key: string, kind: "image" | "video" | "audio", bytes?: Uint8Array, type?: string): Promise<boolean> {
  try {
    if (kind === "image" && bytes && type) {
      const m = await markPicture(env, bytes, type);
      if (!m) return false;
      await env.RENDERS.put(markedKey(key), m.bytes, { httpMetadata: { contentType: m.type } });
      return true;
    }
    if (kind === "video") {
      const m = await markVideo(env, key);
      if (m) await audit(env as unknown as Env, who.userId, who.genId, "studio.marked", { kind, size: m.size, cpu_s: m.cpuS });
      return !!m;
    }
    return false;
  } catch (e) {
    const why = String(e instanceof Error ? e.message : e).slice(0, 300);
    await audit(env as unknown as Env, who.userId, who.genId, "studio.mark_failed", { kind, key, error: why }).catch(() => {});
    if (!(e instanceof TooBigForImages)) await alertOwner(env, kind, why);
    return false;
  }
}

/**
 * The owner hears about a mark that failed for a reason other than a picture's size (Images' monthly limit, error
 * 9422; a Container that does not answer): free files are going out clean. One e-mail every 6 hours at most, claimed
 * in studio_meta first, so two requests never both send it.
 */
const ALERT_EVERY_MS = 6 * 3_600_000;
async function alertOwner(env: StudioEnv, kind: string, why: string, nowMs = Date.now()): Promise<void> {
  try {
    const claim = await env.DB.prepare(`INSERT INTO studio_meta (key, value) VALUES ('mark_alerted_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(studio_meta.value AS INTEGER) < ?`).bind(String(nowMs), nowMs - ALERT_EVERY_MS).run();
    if (claim.meta?.changes !== 1) return;
    await mailOwner(env, "Kleo: free creations are going out without the Kleo mark", [
      `A ${kind === "video" ? "clip" : "picture"} of an account that never paid could not be marked, so it is served without "Made with Kleo".`,
      "",
      `Error: ${why}`,
      "",
      "If it says 9422, the Cloudflare Images Free plan has used its 5,000 transformations this month: buy Images Paid in the Cloudflare dashboard (Images, Plans). Pictures get their mark the next time they are viewed once marking works again.",
      "If it names kleo-watermark, the clip Container did not answer: open the kleo-watermark Worker in the Cloudflare dashboard.",
      "",
      "Every miss is in the audit as studio.mark_failed. This e-mail goes out at most once every 6 hours.",
    ].join("\n"), nowMs);
  } catch { /* an alert never breaks a save or a view */ }
}

/**
 * The key to serve: the marked copy when the owner shows the mark and the copy exists, else the clean file.
 * A picture with no copy yet gets one drawn now (healPicture): one made before the mark existed, while the account
 * was paying (a refund or a dispute made it "never paid" again), or whose mark failed when it was saved.
 */
export async function servedKey(env: StudioEnv, ownerId: string, key: string, showsMark: (userId: string) => Promise<boolean>, kind?: string | null): Promise<{ key: string; marked: boolean }> {
  if (!madeByKleo(key, ownerId) || !(await showsMark(ownerId))) return { key, marked: false };
  const copy = markedKey(key);
  if (await env.RENDERS.head(copy)) return { key: copy, marked: true };
  return kind === "image" && (await healPicture(env, ownerId, key)) ? { key: copy, marked: true } : { key, marked: false };
}

/** Pictures this isolate could not mark lately: a miss is tried again after an hour, not on every view. */
const missed = new Map<string, number>();
const MISS_RETRY_MS = 3_600_000;

async function healPicture(env: StudioEnv, ownerId: string, key: string): Promise<boolean> {
  const at = missed.get(key);
  if (at !== undefined && Date.now() - at < MISS_RETRY_MS) return false;
  const miss = (): false => {
    if (missed.size > 5000) missed.clear();
    missed.set(key, Date.now());
    return false;
  };
  try {
    const obj = await env.RENDERS.get(key);
    if (!obj) return miss();
    if (obj.size > IMAGES_MAX_INPUT) { await obj.body.cancel().catch(() => {}); return miss(); }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const m = await markPicture(env, bytes, obj.httpMetadata?.contentType ?? "");
    if (!m) return miss();
    await env.RENDERS.put(markedKey(key), m.bytes, { httpMetadata: { contentType: m.type } });
    await audit(env as unknown as Env, ownerId, null, "studio.marked", { kind: "image", key, late: true }).catch(() => {});
    return true;
  } catch (e) {
    const why = String(e instanceof Error ? e.message : e).slice(0, 300);
    await audit(env as unknown as Env, ownerId, null, "studio.mark_failed", { kind: "image", key, late: true, error: why }).catch(() => {});
    if (!(e instanceof TooBigForImages)) await alertOwner(env, "image", why);
    return miss();
  }
}
