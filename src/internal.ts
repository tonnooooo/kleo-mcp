import type { Env } from "./env";
import { getJob, updateJob, setFile, audit, type Job } from "./db";
import { json, safeEqual, nowIso } from "./util";
import { finishJob, failJob, trackFor } from "./orchestrator";
import { backendFor } from "./backends";
import { FILE_NAMES } from "./jobs";
import { putFile } from "./storage";

const ALLOWED_FILES = new Set([FILE_NAMES.video.name, FILE_NAMES.subtitles.name, FILE_NAMES.thumbnail.name, "thumbnail.svg", "log.txt"]);
const TYPES: Record<string, string> = { mp4: "video/mp4", srt: "application/x-subrip", jpg: "image/jpeg", svg: "image/svg+xml", txt: "text/plain" };

/**
 * Worker-facing API. Only the GPU worker of a given job calls these, authenticated with the
 * per-job secret it received as KLEO_SECRET:  Authorization: Bearer <worker_secret>
 *
 *   GET  /internal/jobs/:id                                   job spec for the worker
 *   POST /internal/jobs/:id/progress   {track, percent, eta_min?, message?}
 *   PUT  /internal/jobs/:id/files/:name                       single-shot upload (≤ ~95 MB)
 *   POST /internal/jobs/:id/files/:name/uploads               start multipart → {uploadId}
 *   PUT  /internal/jobs/:id/files/:name/uploads/:uid/parts/:n upload one part (≥ 5 MB except last) → {etag}
 *   POST /internal/jobs/:id/files/:name/uploads/:uid/complete {parts:[{partNumber, etag}]}
 *   POST /internal/jobs/:id/done       {cost_usd?}
 *   POST /internal/jobs/:id/failed     {error}
 *   POST /internal/jobs/:id/selfdestruct                      ask the server to destroy the GPU (fallback)
 */
export async function handleInternal(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/internal\/jobs\/([A-Za-z0-9_]+)(?:\/(.*))?$/);
  if (!m) return json({ error: "not found" }, 404);
  const job = await getJob(env, m[1]);
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!job || !token || !safeEqual(token, job.worker_secret)) return json({ error: "unauthorized" }, 401);
  const rest = m[2] ?? "";

  if (rest === "" && request.method === "GET") {
    return json({ job_id: job.id, template: job.template, prompt: job.prompt, params: JSON.parse(job.params), state: job.state,
      files: { video: FILE_NAMES.video.name, subtitles: FILE_NAMES.subtitles.name, thumbnail: FILE_NAMES.thumbnail.name }, part_size_bytes: 50 * 1024 * 1024 });
  }
  if (rest === "selfdestruct" && request.method === "POST") { // allowed in any state: it is the worker's last call
    try { await backendFor(env, job.backend).destroy(env, job); } catch (e) { await audit(env, job.user_id, job.id, "backend.destroy.error", String(e)); }
    await audit(env, job.user_id, job.id, "worker.selfdestruct", { at: nowIso(), state: job.state });
    return json({ ok: true });
  }
  if (!["queued", "starting", "rendering", "finishing"].includes(job.state)) return json({ error: `job is ${job.state}` }, 409);

  if (rest === "progress" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { track?: string; percent?: number; eta_min?: number; message?: string };
    const percent = Math.max(0, Math.min(99, Math.round(Number(b.percent ?? job.percent))));
    const auto = trackFor(percent);
    await updateJob(env, job.id, { percent, track: b.track ?? auto.track, state: auto.state, eta_min: b.eta_min ?? job.eta_min });
    if (b.message) await audit(env, job.user_id, job.id, "worker.progress", { percent, track: b.track, message: b.message });
    return json({ ok: true });
  }

  const f = rest.match(/^files\/([A-Za-z0-9._-]+)(?:\/uploads(?:\/([A-Za-z0-9_=+\/-]+)\/(parts\/(\d+)|complete))?)?$/);
  if (f) {
    const name = f[1];
    if (!ALLOWED_FILES.has(name)) return json({ error: `file name must be one of ${[...ALLOWED_FILES].join(", ")}` }, 400);
    const key = `renders/${job.id}/${name}`;
    const ctype = TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream";
    const record = (size: number) => setFile(env, { job_id: job.id, name, key, size, content_type: ctype });

    if (!f[2] && f[0] === `files/${name}` && request.method === "PUT") {
      const size = await putFile(env, key, request.body ?? new ArrayBuffer(0), ctype);
      await record(size);
      return json({ ok: true, size });
    }
    if (f[0].endsWith("/uploads") && request.method === "POST") {
      if (!env.RENDERS) return json({ error: "multipart uploads need an R2 bucket; use a single PUT (max 20 MB) on this deployment" }, 501);
      const mpu = await env.RENDERS.createMultipartUpload(key, { httpMetadata: { contentType: ctype } });
      return json({ uploadId: mpu.uploadId, key });
    }
    if (f[3]?.startsWith("parts/") && request.method === "PUT") {
      if (!env.RENDERS) return json({ error: "no R2 bucket" }, 501);
      const mpu = env.RENDERS.resumeMultipartUpload(key, f[2]!);
      const part = await mpu.uploadPart(parseInt(f[4]!, 10), await request.arrayBuffer());
      return json({ partNumber: part.partNumber, etag: part.etag });
    }
    if (f[3] === "complete" && request.method === "POST") {
      if (!env.RENDERS) return json({ error: "no R2 bucket" }, 501);
      const b = (await request.json()) as { parts: { partNumber: number; etag: string }[] };
      const mpu = env.RENDERS.resumeMultipartUpload(key, f[2]!);
      const obj = await mpu.complete(b.parts);
      await record(obj.size);
      return json({ ok: true, size: obj.size });
    }
    return json({ error: "bad upload request" }, 400);
  }

  if (rest === "done" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { cost_usd?: number };
    await finishJob(env, job, typeof b.cost_usd === "number" ? b.cost_usd : null);
    return json({ ok: true });
  }
  if (rest === "failed" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { error?: string; retry?: boolean };
    await failJob(env, job, `worker: ${b.error ?? "unknown error"}`, b.retry !== false);
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

export type { Job };
