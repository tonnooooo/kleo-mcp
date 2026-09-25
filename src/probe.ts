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
 *
 * Bounded, because the capability sits in a third-party host's command line for hours: every request must declare
 * its length (411 without one) and carry at most PROBE_REQUEST_MAX_BYTES (413); a multipart upload has at most
 * PROBE_PARTS_MAX parts; and every write under a job's probe/ prefix — a PUT, a part, the start of a multipart
 * upload — is entered in the audit table BEFORE it is made (event "admin.probe.write", its bytes), so a job takes at
 * most PROBE_JOB_WRITES_MAX writes and PROBE_JOB_BYTES_MAX bytes in all, retries included (409 / 413 past either).
 */
export const PROBE_NAME_RE = /^probe\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const PROBE_TOKEN_MAX_S = 24 * 3600;
/** One PUT or one part (sr-ab.py sends ≤ 90 MiB whole files and 50 MiB parts). */
export const PROBE_REQUEST_MAX_BYTES = 100 * 1024 * 1024;
/** Parts of one multipart upload: 40 x 50 MiB = 2 GiB, far above a 4K60 film of a few minutes. */
export const PROBE_PARTS_MAX = 40;
/** Everything one job's probe/ prefix may take, retries included: two 4K60 films, the wipe, frames, results. */
export const PROBE_JOB_BYTES_MAX = 3 * 1024 * 1024 * 1024;
export const PROBE_JOB_WRITES_MAX = 400;
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
  // Every write is entered in the ledger before it is made, and refused past the job's caps.
  const reserve = async (bytes: number): Promise<Response | null> => {
    const used = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(detail, '$.bytes')), 0) AS bytes FROM audit WHERE job_id = ? AND event = 'admin.probe.write'")
      .bind(jobId).first<{ n: number; bytes: number }>();
    const n = Number(used?.n ?? 0), total = Number(used?.bytes ?? 0);
    if (n >= PROBE_JOB_WRITES_MAX) return json({ error: `this job's probe/ prefix has taken its ${PROBE_JOB_WRITES_MAX} writes` }, 409);
    if (total + bytes > PROBE_JOB_BYTES_MAX) return json({ error: `this job's probe/ prefix would pass ${PROBE_JOB_BYTES_MAX} bytes (${total} used)` }, 413);
    await audit(env, null, jobId, "admin.probe.write", { name, bytes });
    return null;
  };
  // The declared length of a request that carries data: required, and at most PROBE_REQUEST_MAX_BYTES.
  const declared = (): number | Response => {
    const raw = request.headers.get("content-length");
    const len = raw === null ? NaN : Number(raw);
    if (!Number.isInteger(len) || len < 0) return json({ error: "Content-Length is required" }, 411);
    if (len > PROBE_REQUEST_MAX_BYTES) return json({ error: `at most ${PROBE_REQUEST_MAX_BYTES} bytes per request` }, 413);
    return len;
  };
  const record = async (size: number) => {
    await setFile(env, { job_id: jobId, name, key, size, content_type: ctype });
    await audit(env, null, jobId, "admin.probe.file", { name, size });
  };

  if (!uploads && request.method === "PUT") {
    const len = declared();
    if (len instanceof Response) return len;
    const refused = await reserve(len);
    if (refused) return refused;
    const size = await putFile(env, key, request.body ?? new ArrayBuffer(0), ctype);
    await record(size);
    return json({ ok: true, name, size });
  }
  if (uploads && !uploadId && request.method === "POST") {
    if (!env.RENDERS) return json({ error: "multipart uploads need an R2 bucket; use a single PUT on this deployment" }, 501);
    const refused = await reserve(0);
    if (refused) return refused;
    const mpu = await env.RENDERS.createMultipartUpload(key, { httpMetadata: { contentType: ctype } });
    return json({ uploadId: mpu.uploadId, key });
  }
  if (uploadId && step?.startsWith("parts/") && request.method === "PUT") {
    if (!env.RENDERS) return json({ error: "no R2 bucket" }, 501);
    const n = parseInt(partNo!, 10);
    if (!(n >= 1 && n <= PROBE_PARTS_MAX)) return json({ error: `partNumber must be 1..${PROBE_PARTS_MAX}` }, 400);
    const len = declared();
    if (len instanceof Response) return len;
    const refused = await reserve(len);
    if (refused) return refused;
    const body = await request.arrayBuffer();
    if (body.byteLength > PROBE_REQUEST_MAX_BYTES) return json({ error: `at most ${PROBE_REQUEST_MAX_BYTES} bytes per request` }, 413);
    const part = await env.RENDERS.resumeMultipartUpload(key, uploadId).uploadPart(n, body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  }
  if (uploadId && step === "complete" && request.method === "POST") {
    if (!env.RENDERS) return json({ error: "no R2 bucket" }, 501);
    const b = (await request.json().catch(() => ({}))) as { parts?: { partNumber: number; etag: string }[] };
    if (!Array.isArray(b.parts) || !b.parts.length || b.parts.length > PROBE_PARTS_MAX) return json({ error: `parts: the list of 1..${PROBE_PARTS_MAX} {partNumber, etag}` }, 400);
    const obj = await env.RENDERS.resumeMultipartUpload(key, uploadId).complete(b.parts);
    await record(obj.size);
    return json({ ok: true, name, size: obj.size });
  }
  return json({ error: "bad upload request" }, 400);
}
