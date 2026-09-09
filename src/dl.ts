import type { Env } from "./env";
import { getJob, listFiles } from "./db";
import { hmacHex, safeEqual } from "./util";

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

  const wantsRange = request.headers.has("range");
  const obj = await env.RENDERS.get(file.key, wantsRange ? { range: request.headers, onlyIf: request.headers } : { onlyIf: request.headers });
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=3600");
  headers.set("content-disposition", `attachment; filename="gatto-${jobId}-${name}"`);
  if (!("body" in obj) || !obj.body) return new Response(null, { status: 304, headers });
  let status = 200;
  if (wantsRange && obj.range && "offset" in obj.range) {
    const start = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - start;
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    status = 206;
  } else {
    headers.set("content-length", String(obj.size));
  }
  return new Response(obj.body, { status, headers });
}
