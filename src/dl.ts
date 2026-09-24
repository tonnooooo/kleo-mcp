import type { Env } from "./env";
import { getJob, listFiles } from "./db.ts";
import { hmacHex, safeEqual } from "./util.ts";
import { getFile } from "./storage.ts";
import { IMAGE_NAME_RE } from "./images.ts";
import { REFERENCE_LINK_RE, referenceLinkKey } from "./stills.ts";

/** The render outputs (mp4, srt, …) live at the top level of the job. */
const OUTPUT_NAME_RE = /^[A-Za-z0-9._-]+$/;
/**
 * File names a link may point to: a render output, or a shot picture the worker downloads (img/<pictureId>.png|jpg,
 * picture id = "<sceneId>-s<n>"). The picture rule is IMPORTED, never re-typed: a second copy here once capped the id
 * at 50 chars while images.ts signed up to 56, so every picture of a long-named scene was drawn, billed, signed — and
 * then answered 404 before the signature was even checked.
 *
 * Since 25 September 2026 also a REFERENCE a still is drawn from ("ref/cast/<id>.jpg", "ref/<kref_…>"), which kie.ai's
 * image models fetch by link (src/stills.ts referenceLinkKey). Those are not job files: they are resolved to their
 * stored key by the stills engine's own rule, and never listed among the user's results.
 */
const allowedName = (name: string): boolean => OUTPUT_NAME_RE.test(name) || IMAGE_NAME_RE.test(name) || REFERENCE_LINK_RE.test(name);

/** GET /dl/:jobId/:file?exp=<unix>&sig=<hmac>  — signed, time-limited download straight from R2. */
export async function handleDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/dl\/([A-Za-z0-9_]+)\/([A-Za-z0-9._%-]+(?:\/[A-Za-z0-9._-]+)?)$/);
  if (!m) return new Response("Not found", { status: 404 });
  const jobId = m[1];
  let name: string;
  try { name = decodeURIComponent(m[2]); } catch { return new Response("Not found", { status: 404 }); }
  if (!allowedName(name)) return new Response("Not found", { status: 404 });
  const exp = parseInt(url.searchParams.get("exp") ?? "0", 10);
  const sig = url.searchParams.get("sig") ?? "";
  if (!exp || Date.now() / 1000 > exp) return new Response("This link has expired.", { status: 410 });
  const expected = await hmacHex(env.INTERNAL_SECRET, `${jobId}/${name}/${exp}`);
  if (!safeEqual(sig, expected)) return new Response("Invalid link.", { status: 403 });

  const job = await getJob(env, jobId);
  if (!job || job.purged_at) return new Response("Gone.", { status: 410 });
  const key = REFERENCE_LINK_RE.test(name)
    ? await referenceLinkKey(env, job, name)
    : (await listFiles(env, jobId)).find((f) => f.name === name)?.key ?? null;
  if (!key) return new Response("Not found", { status: 404 });

  const f = await getFile(env, key, request.headers.get("range"));
  if (!f) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "content-type": f.contentType, etag: f.etag, "accept-ranges": "bytes", "cache-control": "private, max-age=3600",
    "content-disposition": `attachment; filename="kleo-${jobId}-${name.replace(/\//g, "-")}"` });
  if (f.range) {
    headers.set("content-range", `bytes ${f.range.offset}-${f.range.offset + f.range.length - 1}/${f.size}`);
    headers.set("content-length", String(f.range.length));
    return new Response(f.body as BodyInit, { status: 206, headers });
  }
  headers.set("content-length", String(f.size));
  return new Response(f.body as BodyInit, { status: 200, headers });
}
