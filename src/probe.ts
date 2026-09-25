import type { Env } from "./env";
import { getJob, setFile, audit } from "./db.ts";
import { json, safeEqual, hmacHex } from "./util.ts";
import { putFile } from "./storage.ts";

/**
 * THE PROBE'S OUTPUTS, AS EXTRA FILES OF AN EXISTING JOB (25 September 2026, scripts/sr-ab.py).
 *
 * An A/B probe runs on a rented box against a real job's bundle (the neural finish against today's chain, on
 * gt_ujavdzva). Nothing of it may pass through the owner's computer, so the box stores what it produced — contact
 * sheet, side-by-side frames, the 4K60 clips, results.json — next to that job's own files on R2, and the operator
 * hands the owner signed /dl links. The worker's own upload route cannot do it: it answers only the job's worker
 * secret, and only while the job is open; the probe's job is long finished.
 *
 *   PUT  /internal/admin/probe/:jobId/:name                              one file (≤ ~90 MB)
 *   POST /internal/admin/probe/:jobId/:name/uploads                      start a multipart upload → {uploadId}
 *   PUT  /internal/admin/probe/:jobId/:name/uploads/:uid/parts/:n        one part (≥ 5 MB except the last) → {partNumber, etag}
 *   POST /internal/admin/probe/:jobId/:name/uploads/:uid/complete        {parts:[{partNumber, etag}]} → {size}
 *
 * Auth: `Authorization: Bearer <INTERNAL_SECRET>`, or `?exp=<unix>&sig=<hmac(INTERNAL_SECRET, "probe/<jobId>/<exp>")>`
 * — a capability for ONE job's probe/ prefix that expires within a day, minted by the operator (sr-ab.py --sign-upload)
 * so the rented box never holds INTERNAL_SECRET itself.
 *
 * Narrow on purpose: names are flat and land under probe/ only (renders/<job>/probe/<name>, job_files "probe/<name>"),
 * so a probe can never overwrite a delivered file; /dl serves them with a signed link; resultLinks never lists them to
 * the user; and the purge removes them with the job's other files, on the job's own TTL.
 */
export const PROBE_NAME_RE = /^probe\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const PROBE_TOKEN_MAX_S = 24 * 3600;
/** A probe's evidence among a job's files: the operator's, never one of the user's result links (jobs.ts resultLinks). */
export const isProbeFile = (name: string): boolean => name.startsWith("probe/");
const TYPES: Record<string, string> = { mp4: "video/mp4", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", json: "application/json", txt: "text/plain", log: "text/plain" };

/** The signature of an upload capability for one job's probe/ prefix, valid until `exp` (unix seconds). */
export const probeUploadSig = (secret: string, jobId: string, exp: number): Promise<string> => hmacHex(secret, `probe/${jobId}/${exp}`);

export async function handleProbe(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/internal\/admin\/probe\/([A-Za-z0-9_]+)\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(\/uploads(?:\/([A-Za-z0-9_=+\/-]+)\/(parts\/(\d+)|complete))?)?$/);
  if (!m) return json({ error: "not found" }, 404);
  const [, jobId, base, uploads, uploadId, step, partNo] = m;
  if (!env.INTERNAL_SECRET) return json({ error: "unauthorized" }, 401);
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  let ok = !!token && safeEqual(token, env.INTERNAL_SECRET);
  if (!ok) {
    const exp = parseInt(url.searchParams.get("exp") ?? "0", 10);
    const now = Date.now() / 1000;
    const sig = url.searchParams.get("sig") ?? "";
    ok = Number.isFinite(exp) && exp > now && exp <= now + PROBE_TOKEN_MAX_S && safeEqual(sig, await probeUploadSig(env.INTERNAL_SECRET, jobId, exp));
  }
  if (!ok) return json({ error: "unauthorized" }, 401);
  const job = await getJob(env, jobId);
  if (!job) return json({ error: "no such job" }, 404);
  if (job.purged_at) return json({ error: "the job's files are purged" }, 410);

  const name = `probe/${base}`;
  const key = `renders/${jobId}/${name}`;
  const ctype = TYPES[base.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
  const record = async (size: number) => {
    await setFile(env, { job_id: jobId, name, key, size, content_type: ctype });
    await audit(env, null, jobId, "admin.probe.file", { name, size });
  };

  if (!uploads && request.method === "PUT") {
    const size = await putFile(env, key, request.body ?? new ArrayBuffer(0), ctype);
    await record(size);
    return json({ ok: true, name, size });
  }
  if (uploads && !uploadId && request.method === "POST") {
    if (!env.RENDERS) return json({ error: "multipart uploads need an R2 bucket; use a single PUT on this deployment" }, 501);
    const mpu = await env.RENDERS.createMultipartUpload(key, { httpMetadata: { contentType: ctype } });
    return json({ uploadId: mpu.uploadId, key });
  }
  if (uploadId && step?.startsWith("parts/") && request.method === "PUT") {
    if (!env.RENDERS) return json({ error: "no R2 bucket" }, 501);
    const part = await env.RENDERS.resumeMultipartUpload(key, uploadId).uploadPart(parseInt(partNo!, 10), await request.arrayBuffer());
    return json({ partNumber: part.partNumber, etag: part.etag });
  }
  if (uploadId && step === "complete" && request.method === "POST") {
    if (!env.RENDERS) return json({ error: "no R2 bucket" }, 501);
    const b = (await request.json().catch(() => ({}))) as { parts?: { partNumber: number; etag: string }[] };
    if (!Array.isArray(b.parts) || !b.parts.length) return json({ error: "parts: the list of {partNumber, etag}" }, 400);
    const obj = await env.RENDERS.resumeMultipartUpload(key, uploadId).complete(b.parts);
    await record(obj.size);
    return json({ ok: true, name, size: obj.size });
  }
  return json({ error: "bad upload request" }, 400);
}
