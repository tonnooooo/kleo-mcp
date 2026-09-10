import type { Env } from "./env";
import { getJob, setFile, audit, type Job, claimQueuedJob, transitionJob, ACTIVE_STATES, OPEN_STATES } from "./db";
import { json, safeEqual, nowIso, int } from "./util";
import { isFlagActive } from "./schema";
import { finishJob, failJob, trackFor } from "./orchestrator";
import { backendFor } from "./backends";
import { FILE_NAMES } from "./jobs";
import { putFile } from "./storage";
import { generateStoryboard, StoryboardError } from "./storyboard";
import { findTemplate } from "./templates";
import { generateJobImages } from "./images";

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
 *   POST /internal/jobs/:id/images     (empty body) → {images: {pictureId: url}, missing: [pictureId]}  scene pictures (cartoon/realistic)
 *   POST /internal/jobs/:id/done       {cost_usd?}
 *   POST /internal/jobs/:id/failed     {error, retry?}
 *   POST /internal/jobs/:id/selfdestruct                      ask the server to destroy the GPU (fallback)
 *
 * Idempotency: every state change is an atomic transition (db.ts transitionJob). Repeating "done" or "failed"
 * answers 200 with the current state and changes nothing; a call that contradicts a final state (progress or
 * "failed" after done/cancelled/failed) answers 409 and changes nothing, so credits move exactly once per job.
 */
export async function handleInternal(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/internal/pool/claim") return handlePoolClaim(request, env);
  const m = url.pathname.match(/^\/internal\/jobs\/([A-Za-z0-9_]+)(?:\/(.*))?$/);
  if (!m) return json({ error: "not found" }, 404);
  const job = await getJob(env, m[1]);
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!job || !token || !safeEqual(token, job.worker_secret)) return json({ error: "unauthorized" }, 401);
  const rest = m[2] ?? "";

  if (rest === "" && request.method === "GET") {
    const params = JSON.parse(job.params) as { style?: string };
    return json({ job_id: job.id, template: job.template, prompt: job.prompt, params, state: job.state, style: params.style ?? null,
      storyboard: job.storyboard ? JSON.parse(job.storyboard) : null, brand: env.BRAND || "Kleo",
      files: { video: FILE_NAMES.video.name, subtitles: FILE_NAMES.subtitles.name, thumbnail: FILE_NAMES.thumbnail.name }, part_size_bytes: 50 * 1024 * 1024 });
  }
  if (rest === "selfdestruct" && request.method === "POST") { // allowed in any state: it is the worker's last call
    try { await backendFor(env, job.backend).destroy(env, job); } catch (e) { await audit(env, job.user_id, job.id, "backend.destroy.error", String(e)); }
    await audit(env, job.user_id, job.id, "worker.selfdestruct", { at: nowIso(), state: job.state });
    return json({ ok: true });
  }
  const isOpen = (OPEN_STATES as string[]).includes(job.state);
  if (!isOpen) {
    // Repeats of the final call the job already took are fine (the worker may retry after a network hiccup); anything else is a conflict.
    if (request.method === "POST" && ((rest === "done" && job.state === "done") || (rest === "failed" && job.state === "failed"))) return json({ ok: true, state: job.state, already: true });
    return json({ error: `job is ${job.state}`, state: job.state }, 409);
  }

  if (rest === "images" && request.method === "POST") {
    // Pictures are generated once; AI errors and quota exhaustion only move scenes to "missing" (audited as images.error).
    const r = await generateJobImages(env, job, url.origin);
    return json({ images: r.images, missing: r.missing, generated: r.generated, reused: r.reused, fixture: r.fixture });
  }

  if (rest === "progress" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { track?: string; percent?: number; eta_min?: number; message?: string };
    const percent = Math.max(0, Math.min(99, Math.round(Number(b.percent ?? job.percent))));
    const auto = trackFor(percent);
    const applied = await transitionJob(env, job.id, ACTIVE_STATES, { percent, track: b.track ?? auto.track, state: auto.state,
      eta_min: b.eta_min ?? job.eta_min, last_report_at: new Date().toISOString() });
    if (!applied) return json({ error: "job is not running any more", state: (await getJob(env, job.id))?.state ?? job.state }, 409);
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
    const applied = await finishJob(env, job, typeof b.cost_usd === "number" ? b.cost_usd : null);
    if (applied) return json({ ok: true, state: "done" });
    const now = (await getJob(env, job.id))?.state ?? job.state;
    return now === "done" ? json({ ok: true, state: now, already: true }) : json({ error: `job is ${now}`, state: now }, 409);
  }
  if (rest === "failed" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { error?: string; retry?: boolean };
    const outcome = await failJob(env, job, `worker: ${b.error ?? "unknown error"}`, b.retry !== false);
    if (outcome !== "ignored") return json({ ok: true, state: outcome === "requeued" ? "queued" : "failed", outcome });
    const now = (await getJob(env, job.id))?.state ?? job.state;
    return now === "failed" ? json({ ok: true, state: now, already: true }) : json({ error: `job is ${now}`, state: now }, 409);
  }
  return json({ error: "not found" }, 404);
}

export type { Job };

/**
 * Dev-only: GET /internal/dev/plan?template=viral-short&prompt=...&duration_s=45&format=9:16&language=en&voice=
 * Runs the storyboard generator against Workers AI without creating a job. Enabled with DEV_ROUTES=1,
 * authenticated with `Authorization: Bearer <INTERNAL_SECRET>`.
 */
export async function handleDevPlan(request: Request, env: Env): Promise<Response> {
  if (env.DEV_ROUTES !== "1") return json({ error: "not found" }, 404);
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.INTERNAL_SECRET || !token || !safeEqual(token, env.INTERNAL_SECRET)) return json({ error: "unauthorized" }, 401);
  const q = new URL(request.url).searchParams;
  const t = findTemplate(q.get("template") ?? "");
  if (!t) return json({ error: "unknown template" }, 400);
  const prompt = (q.get("prompt") ?? "").trim();
  if (prompt.length < 8) return json({ error: "prompt too short" }, 400);
  const format = (q.get("format") || t.formats[0]) as "16:9" | "9:16";
  const duration_s = Math.round(Number(q.get("duration_s") || t.defaultSeconds));
  const params = { duration_s, format, language: q.get("language") || "en", voice: q.get("voice") || null };
  const job = { id: `dev_${Date.now().toString(36)}`, template: t.id, prompt, params: JSON.stringify(params) };
  try {
    const r = await generateStoryboard(env, job, { model: q.get("model") || undefined });
    return json({ ok: true, ...r });
  } catch (e) {
    return json({ ok: false, error: String(e), errors: e instanceof StoryboardError ? e.errors : undefined, draft: e instanceof StoryboardError ? e.draft : undefined }, 422);
  }
}

/**
 * POST /internal/pool/claim  (Authorization: Bearer <POOL_SECRET>, body {"runner": "gha-123"})
 * Hands one planned job to an external runner. In vast mode a runner only gets jobs Vast did not pick up
 * (provider flagged unavailable, or queued longer than POOL_AFTER_MIN); otherwise any planned job.
 */
async function handlePoolClaim(request: Request, env: Env): Promise<Response> {
  if (!env.POOL_SECRET) return json({ error: "pool disabled" }, 404);
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !safeEqual(token, env.POOL_SECRET)) return json({ error: "unauthorized" }, 401);
  const body = (await request.json().catch(() => ({}))) as { runner?: string };
  const runner = String(body.runner ?? "runner").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) || "runner";
  const vastFirst = env.RENDER_BACKEND === "vast" && !(await isFlagActive(env, "vast_unavailable"));
  const job = await claimQueuedJob(env, runner, vastFirst ? int(env.POOL_AFTER_MIN, 3) : 0);
  if (!job) return json({ job: null });
  await audit(env, job.user_id, job.id, "job.started", { backend: "pool", instance: runner });
  return json({ job_id: job.id, worker_secret: job.worker_secret, api: env.PUBLIC_URL, template: job.template, format: (JSON.parse(job.params) as { format: string }).format });
}
