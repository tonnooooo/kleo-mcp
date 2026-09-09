import type { Env } from "./env";
import { getJob, listFiles } from "./db";
import { hmacHex, safeEqual } from "./util";
import { getFile } from "./storage";

/** GET /dl/:jobId/:file?exp=<unix>&sig=<hmac>  — signed, time-limited download straight from R2. */
export async function handleDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/dl\/([A-Za-z0-9_]+)\/([A-Za-z0-9._-]+)$/);
  if (!m) return new Response("Not found", { status: 404 });
  const [, jobId, name] = m;
  const exp = parseInt(url.searchParams.get("exp") ?? "0", 10);
  const sig = url.searchParams.get("sig") ?? "";
  if (!exp || Date.now() / 1000 > exp) return new Response("This link has expired.", { status: 410 });
  const expected = await hmacHex(env.INTERNAL_SECRET, `${jobId}/${name}/${exp}`);
  if (!safeEqual(sig, expected)) return new Response("Invalid link.", { status: 403 });

  const job = await getJob(env, jobId);
  if (!job || job.purged_at) return new Response("Gone.", { status: 410 });
  const file = (await listFiles(env, jobId)).find((f) => f.name === name);
  if (!file) return new Response("Not found", { status: 404 });

  const f = await getFile(env, file.key, request.headers.get("range"));
  if (!f) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "content-type": f.contentType, etag: f.etag, "accept-ranges": "bytes", "cache-control": "private, max-age=3600",
    "content-disposition": `attachment; filename="kleo-${jobId}-${name}"` });
  if (f.range) {
    headers.set("content-range", `bytes ${f.range.offset}-${f.range.offset + f.range.length - 1}/${f.size}`);
    headers.set("content-length", String(f.range.length));
    return new Response(f.body as BodyInit, { status: 206, headers });
  }
  headers.set("content-length", String(f.size));
  return new Response(f.body as BodyInit, { status: 200, headers });
}
