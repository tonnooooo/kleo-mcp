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

async function readCapped(res: Response, max: number, where: string): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > max) throw new RefError(`The picture at ${where} is ${mb(len)}, and Kleo takes pictures up to ${mb(max)}. Send a smaller copy. Nothing was charged.`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, max + 1);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > max) {
      try { await reader.cancel(); } catch { /* the stream is being dropped anyway */ }
      throw new RefError(`The picture at ${where} is larger than ${mb(max)}, the most Kleo takes. Send a smaller copy. Nothing was charged.`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** Downloads a user's picture: https only, REF_FETCH_TIMEOUT_MS, REF_MAX_BYTES, every failure in words. */
export async function fetchRefBytes(raw: string): Promise<{ bytes: Uint8Array; origin: string }> {
  const u = checkRefUrl(raw);
  const where = u.hostname;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REF_FETCH_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(u.toString(), { signal: ctl.signal, redirect: "follow", headers: { accept: "image/png,image/jpeg,image/webp;q=0.9,image/*;q=0.5" } });
    } catch {
      throw new RefError(ctl.signal.aborted
        ? `${where} did not send the picture within ${REF_FETCH_TIMEOUT_MS / 1000} seconds. Try another link, or use kleo_upload_link. Nothing was charged.`
        : `Kleo could not reach ${where} to fetch the picture. Check the link, or use kleo_upload_link. Nothing was charged.`);
    }
    if (res.url && !res.url.startsWith("https:")) throw new RefError(`The link to ${where} redirected to a page that is not https, so Kleo did not follow it. Pass a direct https:// link to the picture. Nothing was charged.`);
    if (!res.ok) throw new RefError(`${where} answered HTTP ${res.status} instead of the picture${res.status === 401 || res.status === 403 ? " (the link is private or needs a sign-in)" : res.status === 404 ? " (the link points at nothing)" : ""}. Pass a public, direct link to the image file, or use kleo_upload_link. Nothing was charged.`);
    const bytes = await readCapped(res, REF_MAX_BYTES, where);
    return { bytes, origin: `${u.origin}${u.pathname}`.slice(0, 300) };
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
const uploadKey = (userId: string, token: string) => `refs/${userId}/up_${token}.json`;

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
      created_at: known?.created_at ?? new Date().toISOString(),
    };
    await writeJson(b, metaKey(userId, handle), meta);
    return { handle, role: meta.role, description, mime: kind.mime, bytes: bytes.byteLength };
  } catch (e) {
    if (e instanceof RefError) throw e;
    throw new RefError("Kleo could not store the picture just now. Try again in a moment. Nothing was charged.");
  }
}

/**
 * The references an account holds, by handle, in the order asked. A handle this account never gave is refused in
 * words (a handle is an account's own: another user's kref is simply not there), unless `skipMissing`.
 */
export async function refsOf(env: Pick<Env, "RENDERS">, userId: string, handles: string[], opts: { skipMissing?: boolean } = {}): Promise<{ handle: string; role: RefRole | null; description: string; key: string; mime: string; name: string | null }[]> {
  if (!handles.length) return [];
  const b = bucket(env);
  const out: { handle: string; role: RefRole | null; description: string; key: string; mime: string; name: string | null }[] = [];
  for (const h of [...new Set(handles)]) {
    const meta = REF_HANDLE_RE.test(h) ? await readJson<RefMeta>(b, metaKey(userId, h)) : null;
    if (!meta) {
      if (opts.skipMissing) continue;
      throw new RefError(`"${String(h).slice(0, 40)}" is not a picture Kleo received from this account. Pass the handle (kref_…) that kleo_adapt_prompt or the upload page returned, or the picture's https:// link. Nothing was charged.`);
    }
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

/** The handles uploaded through one link, in the order they arrived ([] when none, or the token is not one). */
export async function listUploads(env: Pick<Env, "RENDERS">, userId: string, token: string): Promise<string[]> {
  if (!env.RENDERS || !TOKEN_RE.test(token)) return [];
  const got = await readJson<{ handles?: unknown }>(env.RENDERS, uploadKey(userId, token));
  return Array.isArray(got?.handles) ? got.handles.filter((h): h is string => typeof h === "string" && REF_HANDLE_RE.test(h)) : [];
}

/** Adds handles to one link's list (deduplicated, in arrival order) and returns the whole list. */
export async function recordUploads(env: Pick<Env, "RENDERS">, userId: string, token: string, handles: string[]): Promise<string[]> {
  const b = bucket(env);
  const all = [...new Set([...(await listUploads(env, userId, token)), ...handles])];
  await writeJson(b, uploadKey(userId, token), { handles: all, updated_at: new Date().toISOString() });
  return all;
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
      for (const r of await refsOf(env, userId, handles)) add({ handle: r.handle, role: role ?? r.role, name: name ?? r.name, description: r.description, mime: r.mime });
    } else if (x.handle) {
      for (const r of await refsOf(env, userId, [x.handle.trim()])) add({ handle: r.handle, role: role ?? r.role, name: name ?? r.name, description: r.description, mime: r.mime });
    } else {
      throw new RefError("Each reference needs a picture: an https:// \"url\", an \"upload\" token from kleo_upload_link, or a \"handle\" (kref_…) Kleo returned. Nothing was charged.");
    }
    if (out.size > REF_MAX_PER_FILM) throw new RefError(`A film takes at most ${REF_MAX_PER_FILM} reference pictures; this call brings more. Keep the ones that show the characters and the places that matter most. Nothing was charged.`);
  }
  return [...out.values()];
}
