/**
 * REFERENCE IMAGES (24 September 2026): the pictures a user gives Kleo so a character, an object or a place is drawn
 * from the picture itself and not from a sentence about it.
 *
 * Until this module there was no way in for an image at all. A user who attached a photo of her daughter and asked
 * for "a film where she is an astronaut" got a film about a generic child: the assistant described the photo in two
 * words, the direction cut the look to 140 characters, and the GPU prompt cut that to 77 CLIP tokens. The owner's
 * verdict on the whole pipeline — "it does not follow the images, it does not follow anything" — was literally true for
 * images: they were never followed because they never arrived.
 *
 * Now a picture arrives two ways: an https URL the assistant passes to kleo_adapt_prompt / kleo_create_video, or the
 * upload page (src/upload.ts) behind a signed link from kleo_upload_link, for the pictures a user attached to the chat
 * (an assistant cannot hand Kleo the bytes of an attachment, so the user hands them over directly). Either way the
 * image is checked (https only, 12 MB at most, PNG / JPEG / WebP by their magic bytes — HEIC and GIF refused in words),
 * named by its content ("kref_" + 8 hex of its SHA-256, so the same picture sent twice is one reference and is
 * described once), stored in R2 under refs/<userId>/ with a JSON sidecar, and described by the vision model
 * (src/vision.ts describeImage) for the spec. The stills engine (src/stills.ts) then passes the bytes to FLUX.2 as an
 * input image: measured the same day, a character's earlier picture as input_image_0 keeps the face and the clothes
 * across every shot.
 *
 * A picture is kept REF_TTL_DAYS after its last use and then deleted by purgeOldRefs, which the orchestrator calls; an
 * account holds at most REF_MAX_PER_USER at once (the security pass of 24 September 2026: until then nothing under
 * refs/ was ever deleted, redirects were followed unchecked, and a slow body escaped as a raw AbortError).
 *
 * Every failure is a RefError whose message is shown to the user as-is (the same contract as jobs.ts JobError): plain
 * words, what to do instead, and that nothing was charged. A raw fetch or R2 error never reaches the tool.
 *
 * Only plain TypeScript imports with the .ts extension and type-only ones, so test/refs.test.mjs loads it under Node's
 * type stripping.
 */
import type { Env } from "./env";
import type { RefRole } from "./spec.ts";
import { REF_ROLES } from "./spec.ts";
import { describeImage, toBase64, type VisionImage } from "./vision.ts";
import { hmacHex, safeEqual } from "./util.ts";

/** An error whose message is shown to the user as-is (src/mcp.ts guarded, src/jobs.ts wraps it in a JobError). */
export class RefError extends Error {}

export const REF_HANDLE_RE = /^kref_[0-9a-f]{8}$/;
/** 12 MB: a phone photo at full resolution is 3-8 MB; anything bigger is a RAW file or a video frame dump. */
export const REF_MAX_BYTES = 12 * 1024 * 1024;
/** One fetch of a user's URL may take this long before Kleo gives up and says so. */
export const REF_FETCH_TIMEOUT_MS = 20_000;
/** References one film can carry: the spec's own limit (src/spec.ts S.refs). */
export const REF_MAX_PER_FILM = 8;
/** An upload link lives 48 hours: long enough to find the photos, short enough that a leaked link dies on its own. */
export const UPLOAD_TTL_S = 48 * 3600;
/** Images one upload link takes. */
export const UPLOAD_MAX_FILES = 8;
/**
 * RETENTION (24 September 2026): a reference picture is deleted this many days after Kleo last USED it (an ingest, a
 * kleo_adapt_prompt or kleo_create_video that names it), by purgeOldRefs. Until this date nothing under refs/ was
 * ever deleted: job files went after RESULT_TTL_DAYS (7) while the photos of real people — the module's own example
 * is a user's daughter — and the vision model's description of them stayed in R2 for ever. Thirty days is long enough
 * for a user to come back for a second film with the same cast, and a film in progress always outlives it (a job's
 * render reads its pictures within hours of the call that touched them).
 */
export const REF_TTL_DAYS = 30;
/**
 * Pictures one account may hold at once (same day). kleo_upload_link mints a new link on every call and each link
 * takes UPLOAD_MAX_FILES, so a per-link cap alone let one account grow R2 without bound, one vision call per picture.
 * A hundred is more than any honest cast needs inside REF_TTL_DAYS; the refusal says how to go on.
 */
export const REF_MAX_PER_USER = 100;
const DAY_MS = 86_400_000;

export type RefMime = "image/png" | "image/jpeg" | "image/webp";
export interface RefMeta {
  handle: string;
  user: string;
  role: RefRole | null;
  name: string | null;
  note: string | null;
  mime: RefMime;
  bytes: number;
  /** What the vision model saw, in English; "" when it could not be asked (the spec writer describes it then). */
  description: string;
  source: "url" | "upload" | "bytes";
  /** Where a URL reference came from, without its query string (signed URLs carry secrets in it). */
  origin: string | null;
  created_at: string;
  /** When Kleo last used the picture (written at most once a day, see touchRef); absent on sidecars older than it. */
  last_used_at?: string;
}

const EXT: Record<RefMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const isRole = (x: unknown): x is RefRole => typeof x === "string" && (REF_ROLES as readonly string[]).includes(x);
const clip = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/* ------------------------------------------------------------------ what the bytes are */

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/**
 * What an image is, from its first bytes, never from a file name or a Content-Type header (both lie: a WhatsApp
 * forward named .jpg is often a WebP, and a CDN answers image/jpeg for a HEIC it did not convert). PNG, JPEG and WebP
 * are what FLUX.2 and the vision model read; HEIC (the iPhone default) and GIF are refused with the way out.
 */
export function imageKind(bytes: Uint8Array): { ok: true; mime: RefMime; ext: string } | { ok: false; why: string } {
  if (bytes.length < 12) return { ok: false, why: "the file is empty or too small to be a picture" };
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a) return { ok: true, mime: "image/png", ext: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ok: true, mime: "image/jpeg", ext: "jpg" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { ok: true, mime: "image/webp", ext: "webp" };
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12).toLowerCase();
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/.test(brand))
      return { ok: false, why: `this is a ${brand.startsWith("avi") ? "AVIF" : "HEIC"} picture (the iPhone's own format), which Kleo cannot read yet — export it as JPEG (on an iPhone: Settings → Camera → Formats → Most Compatible, or share it as JPEG) and send it again` };
  }
  if (ascii(bytes, 0, 4) === "GIF8") return { ok: false, why: "this is a GIF, which Kleo does not take — send a still picture as PNG or JPEG instead" };
  return { ok: false, why: "this is not a PNG, JPEG or WebP picture" };
}

/** "kref_" + the first 8 hex of the SHA-256 of the bytes: the same picture is always the same handle. */
export async function refHandle(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `kref_${[...d.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/* ------------------------------------------------------------------ fetching a URL, bounded */

/**
 * A host a user's URL must never point Kleo at: the Worker's fetch cannot reach a private network anyway, but a
 * refusal in words is better than a timeout, and the rule costs one line.
 */
function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

/** Checks a user's URL: https, a public host. Returns the parsed URL or a RefError. */
export function checkRefUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new RefError(`"${raw.slice(0, 120)}" is not a web address. Pass the full https:// link of the picture, or use kleo_upload_link for pictures on the user's device. Nothing was charged.`); }
  if (u.protocol !== "https:") throw new RefError(`Kleo only fetches pictures over https, and "${u.origin}" is ${u.protocol.replace(":", "")}. Pass an https:// link, or use kleo_upload_link. Nothing was charged.`);
  if (privateHost(u.hostname)) throw new RefError(`"${u.hostname}" is not a public address Kleo can fetch from. Pass a public https:// link, or use kleo_upload_link. Nothing was charged.`);
  return u;
}

/**
 * A body read with a running byte counter (24 September 2026): the bytes, or null the moment the count passes `max`
 * (the stream is cancelled there, so a 90 MB body costs Kleo 12 MB of memory, not 90). A content-length header is
 * never trusted to bound the read — it can be absent (chunked, HTTP/2) or wrong — so the counter runs whether or not
 * one was sent. A stream error (a reset, an abort) is thrown as it came; the caller turns it into words.
 */
export async function readBodyCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > max) {
      try { await reader.cancel(); } catch { /* the stream is being dropped anyway */ }
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

async function readCapped(res: Response, max: number, where: string): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > max) {
    try { await res.body?.cancel(); } catch { /* dropped */ }
    throw new RefError(`The picture at ${where} is ${mb(len)}, and Kleo takes pictures up to ${mb(max)}. Send a smaller copy. Nothing was charged.`);
  }
  const bytes = await readBodyCapped(res.body, max);
  if (!bytes) throw new RefError(`The picture at ${where} is larger than ${mb(max)}, the most Kleo takes. Send a smaller copy. Nothing was charged.`);
  return bytes;
}

/** Redirects Kleo follows from a user's link to the picture (a CDN hop or two, a short link): each one is checked. */
export const REF_MAX_REDIRECTS = 3;

/**
 * Downloads a user's picture: https only at EVERY hop, public hosts only at every hop, at most REF_MAX_REDIRECTS
 * redirects, REF_FETCH_TIMEOUT_MS for the whole thing (the redirects and the body included), REF_MAX_BYTES counted as
 * the body streams, and every failure in words.
 *
 * WHY THE REDIRECTS ARE FOLLOWED BY HAND (24 September 2026): with redirect "follow" the runtime walked the whole chain
 * unchecked and only the FINAL address was looked at, so https://a -> http://b -> https://c fetched b in plaintext and
 * still passed, and a hop to https://127.0.0.1/ was never put through privateHost. The rules the module states (https
 * only, public hosts only) were the rules of the first URL, not of the fetch. Now each Location is resolved against
 * the hop it came from and checked before Kleo asks for it.
 *
 * WHY THE BODY READ IS INSIDE THE WORDS (same day): the timer also runs while the body streams, so a host that sends
 * its headers at once and then trickles the picture made reader.read() reject with a bare AbortError, which no catch
 * turned into a sentence: kleo_adapt_prompt answered "The operation was aborted". A reset mid-body escaped the same way
 * as a raw TypeError. Both are RefErrors now. `timeoutMs` is for the tests only.
 */
export async function fetchRefBytes(raw: string, opts: { timeoutMs?: number } = {}): Promise<{ bytes: Uint8Array; origin: string }> {
  const first = checkRefUrl(raw);
  const where = first.hostname;
  const timeoutMs = opts.timeoutMs ?? REF_FETCH_TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const tooSlow = () => new RefError(`${where} did not send the picture within ${timeoutMs / 1000} seconds. Try another link, or use kleo_upload_link. Nothing was charged.`);
  const drop = async (res: Response) => { try { await res.body?.cancel(); } catch { /* dropped */ } };
  try {
    let u = first;
    let res: Response | null = null;
    for (let hop = 0; !res; hop++) {
      let got: Response;
      try {
        got = await fetch(u.toString(), { signal: ctl.signal, redirect: "manual", headers: { accept: "image/png,image/jpeg,image/webp;q=0.9,image/*;q=0.5" } });
      } catch {
        throw ctl.signal.aborted ? tooSlow() : new RefError(`Kleo could not reach ${u.hostname} to fetch the picture. Check the link, or use kleo_upload_link. Nothing was charged.`);
      }
      // A browser-style runtime hides a manual redirect behind an opaque answer: nothing to check, so nothing to follow.
      if ((got.type as string) === "opaqueredirect" || got.status === 0) throw new RefError(`The link to ${where} redirects somewhere Kleo cannot check. Pass a direct https:// link to the picture file. Nothing was charged.`);
      if (got.status < 300 || got.status >= 400 || got.status === 304) { res = got; break; }
      await drop(got);
      const loc = got.headers.get("location");
      if (!loc) throw new RefError(`${u.hostname} answered a redirect without saying where to. Pass a direct https:// link to the picture file. Nothing was charged.`);
      if (hop >= REF_MAX_REDIRECTS) throw new RefError(`The link to ${where} redirects more than ${REF_MAX_REDIRECTS} times, so Kleo stopped following it. Pass a direct https:// link to the picture file. Nothing was charged.`);
      let next: URL;
      try { next = new URL(loc, u); } catch { throw new RefError(`The link to ${where} redirects to an address that is not one. Pass a direct https:// link to the picture file. Nothing was charged.`); }
      if (next.protocol !== "https:") throw new RefError(`The link to ${where} redirected to a page that is not https (${next.protocol.replace(":", "")}), so Kleo did not follow it. Pass a direct https:// link to the picture. Nothing was charged.`);
      if (privateHost(next.hostname)) throw new RefError(`The link to ${where} redirected to "${next.hostname}", which is not a public address, so Kleo did not follow it. Pass a public https:// link, or use kleo_upload_link. Nothing was charged.`);
      u = next;
    }
    if (!res.ok) {
      await drop(res);
      throw new RefError(`${u.hostname} answered HTTP ${res.status} instead of the picture${res.status === 401 || res.status === 403 ? " (the link is private or needs a sign-in)" : res.status === 404 ? " (the link points at nothing)" : ""}. Pass a public, direct link to the image file, or use kleo_upload_link. Nothing was charged.`);
    }
    let bytes: Uint8Array;
    try { bytes = await readCapped(res, REF_MAX_BYTES, where); }
    catch (e) {
      if (e instanceof RefError) throw e;
      throw ctl.signal.aborted ? tooSlow() : new RefError(`Kleo could not finish downloading the picture from ${where}. Try again, or use kleo_upload_link. Nothing was charged.`);
    }
    return { bytes, origin: `${first.origin}${first.pathname}`.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ storage */

type Bucket = NonNullable<Env["RENDERS"]>;
function bucket(env: Pick<Env, "RENDERS">): Bucket {
  if (!env.RENDERS) throw new RefError("Kleo cannot keep reference pictures on this server (it has no file store configured), so the film will be drawn from words only. Describe the pictures in the request instead. Nothing was charged.");
  return env.RENDERS;
}
const metaKey = (userId: string, handle: string) => `refs/${userId}/${handle}.json`;
const imageKey = (userId: string, handle: string, mime: RefMime) => `refs/${userId}/${handle}.${EXT[mime]}`;
/**
 * One upload link's pictures: ONE R2 OBJECT PER PICTURE under refs/<userId>/up/<link id>/<handle> (24 September 2026).
 * The list used to be one JSON file rewritten on every upload (read, add, put), so two uploads to the same link from a
 * phone and a laptop at once both read the same list and the later put dropped the other's picture: stored, described,
 * and missing from the film. Separate objects cannot overwrite each other, and the list is an R2 list of the prefix.
 * The link id is the token's 32-hex signature: unique per link (the payload carries a nonce) and short.
 */
const uploadPrefix = (userId: string, token: string) => `refs/${userId}/up/${token.slice(token.lastIndexOf(".") + 1)}/`;
/** The throttle of purgeOldRefs: when it last ran. */
const PURGE_KEY = "refs/.purge.json";
const PURGE_EVERY_MS = 6 * 3600_000;

type Listed = { key: string; uploaded: number };
/** Every object under a prefix, page by page (R2 lists at most 1000 per call); `complete` is false when `maxPages` cut it. */
async function listAll(b: Bucket, prefix: string, maxPages: number): Promise<{ objects: Listed[]; complete: boolean }> {
  const objects: Listed[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await b.list({ prefix, cursor, limit: 1000 });
    for (const o of r.objects) objects.push({ key: o.key, uploaded: +new Date(o.uploaded) });
    if (!r.truncated) return { objects, complete: true };
    cursor = r.cursor;
  }
  return { objects, complete: false };
}

async function readJson<T>(b: Bucket, key: string): Promise<T | null> {
  try {
    const o = await b.get(key);
    if (!o) return null;
    return JSON.parse(await o.text()) as T;
  } catch { return null; }
}
async function writeJson(b: Bucket, key: string, data: unknown): Promise<void> {
  await b.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
}

/** The stored metadata of one reference, or null when this account never gave it. */
export async function refMeta(env: Pick<Env, "RENDERS">, userId: string, handle: string): Promise<RefMeta | null> {
  if (!REF_HANDLE_RE.test(handle) || !env.RENDERS) return null;
  return readJson<RefMeta>(env.RENDERS, metaKey(userId, handle));
}

/**
 * TAKES ONE PICTURE IN. From a URL (fetched here) or bytes (the upload page): checked, named by content, stored with
 * its sidecar, described by the vision model with the role the user gave. A picture this account already gave is not
 * described twice: its stored description is reused, unless a role is given now that differs from the one it was
 * described for (a "style" description says nothing about a face).
 */
export async function ingestRef(
  env: Pick<Env, "RENDERS" | "AI" | "VISION_MODEL">,
  userId: string,
  src: { url?: string | null; bytes?: Uint8Array | null; role?: RefRole | null; name?: string | null; note?: string | null; source?: "upload" | "bytes" },
): Promise<{ handle: string; role: RefRole | null; description: string; mime: string; bytes: number }> {
  const b = bucket(env);
  let bytes: Uint8Array;
  let origin: string | null = null;
  if (src.url) ({ bytes, origin } = await fetchRefBytes(src.url));
  else if (src.bytes) bytes = src.bytes;
  else throw new RefError("A reference picture needs either an https:// link or the picture itself. Nothing was charged.");
  if (bytes.byteLength > REF_MAX_BYTES) throw new RefError(`The picture is ${mb(bytes.byteLength)}, and Kleo takes pictures up to ${mb(REF_MAX_BYTES)}. Send a smaller copy. Nothing was charged.`);
  const kind = imageKind(bytes);
  if (!kind.ok) throw new RefError(`Kleo cannot use this picture${origin ? ` (${new URL(origin).hostname})` : ""}: ${kind.why}. Nothing was charged.`);
  const role = isRole(src.role) ? src.role : null;
  const handle = await refHandle(bytes);
  const known = await readJson<RefMeta>(b, metaKey(userId, handle));
  if (!known) await checkRoom(b, userId);   // before the vision call: a refused picture costs nothing
  const redescribe = !known || !known.description || (role !== null && role !== known.role);
  let description = known?.description ?? "";
  if (redescribe) {
    try { description = await describeImage(env, { bytes, mime: kind.mime }, role); }
    catch { description = known?.description ?? ""; }   // the picture is kept; the spec writer describes it in words
  }
  try {
    if (!known) await b.put(imageKey(userId, handle, kind.mime), bytes, { httpMetadata: { contentType: kind.mime } });
    const meta: RefMeta = {
      handle, user: userId, role: role ?? known?.role ?? null, name: clip(src.name, 60) ?? known?.name ?? null, note: clip(src.note, 300) ?? known?.note ?? null,
      mime: kind.mime, bytes: bytes.byteLength, description, source: src.url ? "url" : src.source ?? "bytes", origin: origin ?? known?.origin ?? null,
      created_at: known?.created_at ?? new Date().toISOString(), last_used_at: new Date().toISOString(),
    };
    await writeJson(b, metaKey(userId, handle), meta);
    return { handle, role: meta.role, description, mime: kind.mime, bytes: bytes.byteLength };
  } catch (e) {
    if (e instanceof RefError) throw e;
    throw new RefError("Kleo could not store the picture just now. Try again in a moment. Nothing was charged.");
  }
}

/**
 * REF_MAX_PER_USER, counted on the sidecars under the account's prefix (one R2 list: 100 pictures are 200 objects).
 * An R2 list that fails lets the picture in: this is a guard-rail against abuse, not a reason to refuse a user.
 */
async function checkRoom(b: Bucket, userId: string): Promise<void> {
  let held: number;
  try { held = (await listAll(b, `refs/${userId}/kref_`, 2)).objects.filter((o) => o.key.endsWith(".json")).length; }
  catch { return; }
  if (held >= REF_MAX_PER_USER) throw new RefError(`This account already holds ${REF_MAX_PER_USER} reference pictures, the most Kleo keeps at once; each one is deleted ${REF_TTL_DAYS} days after it was last used. Reuse the handles (kref_…) Kleo already returned for the same people and places. Nothing was charged.`);
}

/**
 * Marks a picture as used now, so purgeOldRefs keeps it REF_TTL_DAYS more. The sidecar is rewritten at most once a day
 * (a film's calls name the same pictures many times), and R2's own `uploaded` date of the sidecar is what the purge
 * reads, so it never has to open a sidecar. Best effort: a failed touch only means the picture may go a day earlier.
 */
async function touchRef(b: Bucket, userId: string, meta: RefMeta, nowMs = Date.now()): Promise<void> {
  const last = Date.parse(meta.last_used_at ?? meta.created_at);
  if (Number.isFinite(last) && nowMs - last < DAY_MS) return;
  try { await writeJson(b, metaKey(userId, meta.handle), { ...meta, last_used_at: new Date(nowMs).toISOString() }); } catch { /* best effort */ }
}

/**
 * The references an account holds, by handle, in the order asked. A handle this account never gave is refused in
 * words (a handle is an account's own: another user's kref is simply not there), unless `skipMissing`. Every picture
 * returned counts as used (touchRef): this is the read kleo_adapt_prompt and kleo_create_video go through.
 */
export async function refsOf(env: Pick<Env, "RENDERS">, userId: string, handles: string[], opts: { skipMissing?: boolean } = {}): Promise<{ handle: string; role: RefRole | null; description: string; key: string; mime: string; name: string | null }[]> {
  if (!handles.length) return [];
  const b = bucket(env);
  const out: { handle: string; role: RefRole | null; description: string; key: string; mime: string; name: string | null }[] = [];
  for (const h of [...new Set(handles)]) {
    const meta = REF_HANDLE_RE.test(h) ? await readJson<RefMeta>(b, metaKey(userId, h)) : null;
    if (!meta) {
      if (opts.skipMissing) continue;
      throw new RefError(`"${String(h).slice(0, 40)}" is not a picture Kleo received from this account (or it was deleted ${REF_TTL_DAYS} days after it was last used). Pass the handle (kref_…) that kleo_adapt_prompt or the upload page returned, or the picture's https:// link. Nothing was charged.`);
    }
    await touchRef(b, userId, meta);
    out.push({ handle: meta.handle, role: meta.role, description: meta.description, key: imageKey(userId, meta.handle, meta.mime), mime: meta.mime, name: meta.name });
  }
  return out;
}

/** The picture itself, for the stills engine and the vision judge; null when it is not there. */
export async function refImage(env: Pick<Env, "RENDERS">, userId: string, handle: string): Promise<VisionImage | null> {
  if (!REF_HANDLE_RE.test(handle) || !env.RENDERS) return null;
  try {
    const meta = await readJson<RefMeta>(env.RENDERS, metaKey(userId, handle));
    if (!meta) return null;
    const o = await env.RENDERS.get(imageKey(userId, handle, meta.mime));
    if (!o) return null;
    return { bytes: new Uint8Array(await o.arrayBuffer()), mime: meta.mime };
  } catch { return null; }
}

/** A small data: URL of a stored picture (the upload page's thumbnails come from the browser; this is for tests and tools). */
export const dataUrlOf = (img: VisionImage): string => `data:${img.mime ?? "image/jpeg"};base64,${toBase64(img.bytes)}`;

/* ------------------------------------------------------------------ the upload link */

const TOKEN_RE = /^[A-Za-z0-9_-]{8,300}\.[0-9a-f]{32}$/;
const b64url = (s: string) => toBase64(new TextEncoder().encode(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64url(s: string): string | null {
  try {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
  } catch { return null; }
}
const tokenSig = async (secret: string, payload: string) => (await hmacHex(secret, `kleo-upload/${payload}`)).slice(0, 32);

/**
 * A signed upload link's token: base64url of {u: userId, e: expiry (unix seconds), n: a nonce} + "." + an HMAC with
 * INTERNAL_SECRET (the same key dl.ts signs downloads with). The nonce gives every link its own list of pictures.
 */
export async function makeUploadToken(env: Pick<Env, "INTERNAL_SECRET">, userId: string, nowMs = Date.now()): Promise<{ token: string; expires_at: string }> {
  if (!env.INTERNAL_SECRET) throw new RefError("Uploads are not configured on this server. Pass the pictures as https:// links instead. Nothing was charged.");
  const e = Math.floor(nowMs / 1000) + UPLOAD_TTL_S;
  const n = [...crypto.getRandomValues(new Uint8Array(4))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const payload = b64url(JSON.stringify({ u: userId, e, n }));
  return { token: `${payload}.${await tokenSig(env.INTERNAL_SECRET, payload)}`, expires_at: new Date(e * 1000).toISOString() };
}

/**
 * Reads a token back: the account it belongs to and when it expires, or why it is refused. `allowExpired` is for
 * READING what was uploaded through an expired link (the pictures are the user's; only new uploads stop at 48 hours).
 */
export async function readUploadToken(env: Pick<Env, "INTERNAL_SECRET">, token: string, opts: { nowMs?: number; allowExpired?: boolean } = {}): Promise<{ ok: true; userId: string; exp: number } | { ok: false; error: "bad" | "expired" }> {
  if (!env.INTERNAL_SECRET || typeof token !== "string" || !TOKEN_RE.test(token)) return { ok: false, error: "bad" };
  const [payload, sig] = token.split(".");
  if (!safeEqual(sig, await tokenSig(env.INTERNAL_SECRET, payload))) return { ok: false, error: "bad" };
  const raw = unb64url(payload);
  let p: { u?: unknown; e?: unknown };
  try { p = JSON.parse(raw ?? "") as { u?: unknown; e?: unknown }; } catch { return { ok: false, error: "bad" }; }
  if (typeof p.u !== "string" || !p.u || typeof p.e !== "number") return { ok: false, error: "bad" };
  if (!opts.allowExpired && (opts.nowMs ?? Date.now()) / 1000 > p.e) return { ok: false, error: "expired" };
  return { ok: true, userId: p.u, exp: p.e };
}

/**
 * One link's pictures in the order they arrived: by R2's own commit time of each object, then by key. Every reader of
 * the prefix sees the same objects in the same order (R2 lists are strongly consistent), which is what lets two
 * concurrent uploads agree on which of them is the ninth picture.
 */
async function linkHandles(b: Bucket, userId: string, token: string): Promise<string[]> {
  const rows = (await listAll(b, uploadPrefix(userId, token), 2)).objects
    .map((o) => ({ ...o, handle: o.key.slice(o.key.lastIndexOf("/") + 1) }))
    .filter((o) => REF_HANDLE_RE.test(o.handle));
  rows.sort((x, y) => x.uploaded - y.uploaded || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return [...new Set(rows.map((o) => o.handle))];
}

/**
 * The handles uploaded through one link, in the order they arrived, at most UPLOAD_MAX_FILES ([] when none, when the
 * token is not one, or when the store cannot be listed).
 */
export async function listUploads(env: Pick<Env, "RENDERS">, userId: string, token: string): Promise<string[]> {
  if (!env.RENDERS || !TOKEN_RE.test(token)) return [];
  try { return (await linkHandles(env.RENDERS, userId, token)).slice(0, UPLOAD_MAX_FILES); } catch { return []; }
}

/**
 * Adds handles to one link (24 September 2026: an append that cannot lose entries, and a cap that holds under
 * concurrency). Each new handle is its own object, written with a plain put that overwrites nobody else's; then the
 * prefix is listed again and a handle of THIS call that landed past UPLOAD_MAX_FILES in arrival order is taken back
 * and returned in `full`. Two uploads racing for the last place both see the same order in that second list, so
 * exactly one of them keeps it — the old read-count-then-write let parallel POSTs each see room for eight.
 * `all` is the link's list after the call, at most UPLOAD_MAX_FILES.
 */
export async function recordUploads(env: Pick<Env, "RENDERS">, userId: string, token: string, handles: string[]): Promise<{ all: string[]; full: string[] }> {
  const b = bucket(env);
  if (!TOKEN_RE.test(token)) throw new RefError("That is not an upload link. Nothing was charged.");
  const prefix = uploadPrefix(userId, token);
  try {
    let listed = await linkHandles(b, userId, token);
    const mine: string[] = [];
    for (const h of new Set(handles)) {
      if (!REF_HANDLE_RE.test(h) || listed.includes(h) || mine.includes(h)) continue;
      await b.put(prefix + h, "", { httpMetadata: { contentType: "text/plain" } });
      mine.push(h);
    }
    if (!mine.length) return { all: listed.slice(0, UPLOAD_MAX_FILES), full: [] };
    listed = await linkHandles(b, userId, token);
    const full = listed.slice(UPLOAD_MAX_FILES).filter((h) => mine.includes(h));
    if (full.length) { try { await b.delete(full.map((h) => prefix + h)); } catch { /* listUploads never reads past the cap */ } }
    return { all: listed.filter((h) => !full.includes(h)).slice(0, UPLOAD_MAX_FILES), full };
  } catch (e) {
    if (e instanceof RefError) throw e;
    throw new RefError("Kleo could not note the picture on this link just now. Try again in a moment. Nothing was charged.");
  }
}

/* ------------------------------------------------------------------ retention */

/**
 * THE PURGE (24 September 2026): deletes every reference picture (and its sidecar) whose last use is older than
 * REF_TTL_DAYS, every upload-link entry older than the link's life plus REF_TTL_DAYS, and an image left without its
 * sidecar (a store that failed half-way) once it is as old. `now` is the orchestrator's clock in ms.
 *
 * The last use is R2's `uploaded` date of the sidecar, which touchRef and ingestRef rewrite on every use, so the purge
 * lists refs/ and never opens a file. It throttles itself to one run every six hours (refs/.purge.json), so the
 * orchestrator may call it on every tick; `force` is for the tests. A listing cut by `maxPages` deletes only what it
 * saw complete: an image is never taken for an orphan unless the whole prefix was listed.
 *
 * Exported for src/orchestrator.ts (its purge pass, next to the expired jobs): purgeOldRefs(env, Date.now()).
 */
export async function purgeOldRefs(env: Pick<Env, "RENDERS">, now: number = Date.now(), opts: { force?: boolean; maxPages?: number } = {}): Promise<{ ran: boolean; refs: number; links: number }> {
  if (!env.RENDERS) return { ran: false, refs: 0, links: 0 };
  const b = env.RENDERS;
  if (!opts.force) {
    const last = await readJson<{ at?: unknown }>(b, PURGE_KEY);
    if (typeof last?.at === "number" && now - last.at < PURGE_EVERY_MS) return { ran: false, refs: 0, links: 0 };
  }
  // Written first: two ticks that overlap do not both walk the bucket.
  await writeJson(b, PURGE_KEY, { at: now });
  const refCutoff = now - REF_TTL_DAYS * DAY_MS;
  const linkCutoff = now - UPLOAD_TTL_S * 1000 - REF_TTL_DAYS * DAY_MS;
  const { objects, complete } = await listAll(b, "refs/", opts.maxPages ?? 50);
  const doomed: string[] = [];
  let links = 0, refs = 0;
  const groups = new Map<string, { meta: Listed | null; images: Listed[] }>();
  for (const o of objects) {
    // An upload-link entry, or the one-file list the first version of the page wrote (refs/<user>/up_<token>.json).
    if (/^refs\/.+\/up\/[0-9a-f]{32}\/kref_[0-9a-f]{8}$/.test(o.key) || /^refs\/.+\/up_[^/]+\.json$/.test(o.key)) {
      if (o.uploaded < linkCutoff) { doomed.push(o.key); links++; }
      continue;
    }
    const m = o.key.match(/^(refs\/.+\/kref_[0-9a-f]{8})\.(json|png|jpg|webp)$/);
    if (!m) continue;
    const g = groups.get(m[1]) ?? { meta: null, images: [] };
    if (m[2] === "json") g.meta = o; else g.images.push(o);
    groups.set(m[1], g);
  }
  for (const g of groups.values()) {
    if (g.meta) {
      if (g.meta.uploaded < refCutoff) { doomed.push(g.meta.key, ...g.images.map((i) => i.key)); refs++; }
    } else if (complete && g.images.length && g.images.every((i) => i.uploaded < refCutoff)) {
      doomed.push(...g.images.map((i) => i.key)); refs++;
    }
  }
  for (let i = 0; i < doomed.length; i += 1000) await b.delete(doomed.slice(i, i + 1000));
  return { ran: true, refs, links };
}

/* ------------------------------------------------------------------ what a tool call passes */

/** One reference as a tool passes it: exactly one of url / upload / handle, plus what the user said about it. */
export interface RefInput { url?: string | null; upload?: string | null; handle?: string | null; role?: RefRole | null; name?: string | null; note?: string | null }
export interface ResolvedRef { handle: string; role: RefRole | null; name: string | null; description: string; mime: string }

/**
 * Turns what a tool call passed into the handles Kleo holds: a URL is fetched and ingested, an upload token is
 * expanded to what was uploaded through it (it must be this account's own link), a handle is looked up. The role and
 * the name the user gave on the call win over what was stored. At most REF_MAX_PER_FILM, deduplicated.
 */
export async function resolveRefs(env: Pick<Env, "RENDERS" | "AI" | "VISION_MODEL" | "INTERNAL_SECRET">, userId: string, inputs: RefInput[]): Promise<ResolvedRef[]> {
  const out = new Map<string, ResolvedRef>();
  const add = (r: ResolvedRef) => { const had = out.get(r.handle); out.set(r.handle, had ? { ...had, role: r.role ?? had.role, name: r.name ?? had.name } : r); };
  for (const x of inputs) {
    const role = isRole(x.role) ? x.role : null;
    const name = clip(x.name, 60);
    if (x.url) {
      const r = await ingestRef(env, userId, { url: x.url, role, name, note: x.note ?? null });
      add({ handle: r.handle, role: r.role, name, description: r.description, mime: r.mime });
    } else if (x.upload) {
      const t = await readUploadToken(env, x.upload.trim(), { allowExpired: true });
      if (!t.ok || t.userId !== userId) throw new RefError("That is not an upload link of this account. Call kleo_upload_link for a new one and give it to the user. Nothing was charged.");
      const handles = await listUploads(env, userId, x.upload.trim());
      if (!handles.length) throw new RefError("Nothing has been uploaded through that link yet. Ask the user to open it, add the pictures and say when it is done; then call again. Nothing was charged.");
      // skipMissing: a picture of an old link may have been purged (REF_TTL_DAYS) while the link's entry is still there.
      const held = await refsOf(env, userId, handles, { skipMissing: true });
      if (!held.length) throw new RefError(`The pictures uploaded through that link were deleted: Kleo keeps a reference picture ${REF_TTL_DAYS} days after it was last used. Call kleo_upload_link for a new link and ask the user to upload them again. Nothing was charged.`);
      for (const r of held) add({ handle: r.handle, role: role ?? r.role, name: name ?? r.name, description: r.description, mime: r.mime });
    } else if (x.handle) {
      for (const r of await refsOf(env, userId, [x.handle.trim()])) add({ handle: r.handle, role: role ?? r.role, name: name ?? r.name, description: r.description, mime: r.mime });
    } else {
      throw new RefError("Each reference needs a picture: an https:// \"url\", an \"upload\" token from kleo_upload_link, or a \"handle\" (kref_…) Kleo returned. Nothing was charged.");
    }
    if (out.size > REF_MAX_PER_FILM) throw new RefError(`A film takes at most ${REF_MAX_PER_FILM} reference pictures; this call brings more. Keep the ones that show the characters and the places that matter most. Nothing was charged.`);
  }
  return [...out.values()];
}
