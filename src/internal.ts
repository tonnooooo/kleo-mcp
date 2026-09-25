import type { Env } from "./env";
import { getJob, setFile, listFiles, audit, type Job, claimQueuedJob, countRunning, transitionJob, updateJobParams, ACTIVE_STATES, OPEN_STATES } from "./db";
import { json, safeEqual, nowIso, int, num, rid } from "./util";
import { isFlagActive, setFlagUntil, releaseLock } from "./schema";
import { finishJob, failJob, trackFor, budgetSpentUsd, handoverToFinish } from "./orchestrator";
import { backendFor } from "./backends";
import { FILE_NAMES } from "./jobs";
import { putFile, getFile } from "./storage";
import { generateStoryboard, StoryboardError, writeTreatment } from "./storyboard";
import { proseDistance } from "./treatment.ts";
import { stripForWorker } from "./keou-contract.ts";
import { findTemplate, aiUpscaleJob } from "./templates";
import { generateJobImages, IMAGE_NAME_RE } from "./images";
import { ephoneBalanceUsd } from "./ephone.ts";
import { footageBackendFor, footageConfig, setFootageConfig, kieModelFor, clipLengthsSpec, requestFootage, footageStatus, footageSpentTodayUsd, kieBalanceUsd, clipKey, footageRows, KIE_MODELS, SHOT_ID_RE, STILL_NAME_RE, type ShotRequest, requestMusic, musicStatus, musicOn, musicKey, MUSIC_ID, type MusicRequest } from "./footage";

const ALLOWED_FILES = new Set([FILE_NAMES.video.name, FILE_NAMES.subtitles.name, FILE_NAMES.thumbnail.name, "thumbnail.svg", "log.txt", "gen.tgz"]);
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
 *   PUT  /internal/jobs/:id/stills/:pictureId.png             a shot's reference frame, for kie.ai to animate (footage.ts)
 *   POST /internal/jobs/:id/footage    {shots, look, format}  order the clips from kie.ai; GET polls them (footage.ts)
 *   GET  /internal/jobs/:id/clips/:shotId                     a finished clip, streamed from R2
 *   POST /internal/jobs/:id/music      {brief, seconds, title}  order the user's music track from kie.ai (Suno); GET polls it (footage.ts)
 *   GET  /internal/jobs/:id/music/file                        the finished track, streamed from R2
 *   POST /internal/jobs/:id/done       {cost_usd?, sr?}                sr: the AI upscale's report (settled in orchestrator.ts)
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
    // The spec, the reference handles and the intake answers are the server's (planner, stills engine): the box never
    // reads them, and a spec is kilobytes the worker would print into every log line that shows the params.
    const { spec: _spec, refs: _refs, brief: _brief, stills: _stills, ...params } = JSON.parse(job.params) as { style?: string; spec?: unknown; refs?: unknown; brief?: unknown; stills?: unknown };
    const cfg = await footageConfig(env);
    const film = kieModelFor(env, cfg);
    return json({ job_id: job.id, template: job.template, prompt: job.prompt, params, state: job.state, style: params.style ?? null, phase: job.phase ?? "gen",
      // Where the clips come from: repeated here for runners that get no env from Vast (the box's env wins when set).
      // And the clip lengths the model films: the box cuts the film's scenes to whole clips of them (clipLengthsSpec).
      footage: { backend: footageBackendFor(env, job, cfg), model: film.name, ...clipLengthsSpec(film.spec) },
      // Whether the user's music track can be ordered here at all (22 September): the box skips the road when it cannot.
      music: { available: musicOn(env) },
      // The worker gets the storyboard WITHOUT the server's authoring fields (covers, cast, action on the shots; a
      // top-level spec): worker/keou/contract.py refuses any shot key it does not know, on a card already paid for.
      storyboard: job.storyboard ? stripForWorker(JSON.parse(job.storyboard)) : null, brand: env.BRAND || "Kleo",
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

  // The GPU phase hands over: gen.tgz is on R2, the card goes back, a finish box takes the rest of the film.
  if (rest === "phase" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { phase?: string };
    if (b.phase !== "finish") return json({ error: "phase must be 'finish'" }, 400);
    if (!(await listFiles(env, job.id)).some((f) => f.name === "gen.tgz")) return json({ error: "gen.tgz was not uploaded" }, 409);
    const ok = await handoverToFinish(env, job);
    return ok ? json({ ok: true, phase: "finish" }) : json({ error: `job is ${(await getJob(env, job.id))?.state}` }, 409);
  }
  // The finish box fetches what the GPU left: the bundle, streamed from R2 with the worker's own secret.
  const g = rest.match(/^files\/([A-Za-z0-9._-]+)$/);
  if (g && request.method === "GET") {
    if (!ALLOWED_FILES.has(g[1])) return json({ error: "no such file" }, 404);
    const f = await getFile(env, `renders/${job.id}/${g[1]}`, null);
    if (!f) return json({ error: "not uploaded" }, 404);
    return new Response(f.body as ReadableStream | ArrayBuffer, { status: 200, headers: { "content-type": f.contentType, "content-length": String(f.size), etag: f.etag } });
  }

  // The kie.ai road (footage.ts). The still lands under the same img/ name rule as the server-drawn pictures, so
  // dl.ts can sign a link to it for kie.ai without learning a new name.
  const st = rest.match(/^stills\/([a-z0-9-]{1,56}\.(?:png|jpg|webp))$/);
  if (st && request.method === "PUT") {
    const name = `img/${st[1]}`;
    if (!IMAGE_NAME_RE.test(name) && !STILL_NAME_RE.test(st[1])) return json({ error: "bad still name" }, 400);
    const ctype = st[1].endsWith(".png") ? "image/png" : st[1].endsWith(".webp") ? "image/webp" : "image/jpeg";
    const buf = await request.arrayBuffer();
    if (buf.byteLength < 64 || buf.byteLength > 25 * 1024 * 1024) return json({ error: `still is ${buf.byteLength} bytes` }, 400);
    const key = `renders/${job.id}/${name}`;
    const size = await putFile(env, key, buf, ctype);
    await setFile(env, { job_id: job.id, name, key, size, content_type: ctype });
    return json({ ok: true, name: st[1], size });
  }
  if (rest === "footage" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { shots?: ShotRequest[]; look?: string; format?: string };
    const r = await requestFootage(env, job, url.origin, { shots: b.shots ?? [], look: b.look, format: b.format });
    // 402 is definitive (no kie.ai money, or today's ceiling): the box cannot film without the clips and would only
    // report the generic "the shots did not film" later. Fail the job here, with the sentence, and refund at once.
    if (r.status === 402) await failJob(env, job, String(r.reply.error ?? "the clips could not be ordered from kie.ai"), false);
    return json(r.reply, r.status);
  }
  if (rest === "footage" && request.method === "GET") {
    const r = await footageStatus(env, job, true);
    return json(r.reply, r.status);
  }
  // The user's music (footage.ts, 22 September 2026). Refusals are soft: the box makes the film without the track.
  if (rest === "music" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as Partial<MusicRequest>;
    const r = await requestMusic(env, job, { brief: String(b.brief ?? ""), seconds: Number(b.seconds) || 30, title: typeof b.title === "string" ? b.title : undefined });
    return json(r.reply, r.status);
  }
  if (rest === "music" && request.method === "GET") {
    const r = await musicStatus(env, job, true);
    return json(r.reply, r.status);
  }
  if (rest === "music/file" && request.method === "GET") {
    const row = (await footageRows(env, job.id)).find((r) => r.shot_id === MUSIC_ID);
    if (!row || row.state !== "ready") return json({ error: "the track is not ready" }, 404);
    const f = await getFile(env, row.key ?? musicKey(job.id), null);
    if (!f) return json({ error: "the track is missing from storage" }, 404);
    return new Response(f.body as ReadableStream | ArrayBuffer, { status: 200, headers: { "content-type": f.contentType || "audio/mpeg", "content-length": String(f.size), etag: f.etag } });
  }
  const cl = rest.match(/^clips\/([a-z0-9-]{1,56})$/);
  if (cl && request.method === "GET") {
    if (!SHOT_ID_RE.test(cl[1])) return json({ error: "bad shot id" }, 400);
    const row = (await footageRows(env, job.id)).find((r) => r.shot_id === cl[1]);
    if (!row || row.state !== "ready" || !row.key) return json({ error: "clip is not ready" }, 404);
    const f = await getFile(env, row.key ?? clipKey(job.id, cl[1]), null);
    if (!f) return json({ error: "clip is missing from storage" }, 404);
    return new Response(f.body as ReadableStream | ArrayBuffer, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(f.size), etag: f.etag } });
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
    // `sr` (25 September 2026): what the finish box's neural finish did — {parts, applied, model, gpu, reason} — read
    // only for a film sold the AI upscale, whose extra credits go back when it was not applied to every shot.
    const b = (await request.json().catch(() => ({}))) as { cost_usd?: number; sr?: unknown };
    const applied = await finishJob(env, job, typeof b.cost_usd === "number" ? b.cost_usd : null, b.sr);
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
 * The kill switch, reachable from a phone with one request and no deploy:
 *   POST /internal/admin/pause    {"hours": 12}                      stop renting GPUs (default 12 hours, at most 7 days)
 *   POST /internal/admin/pause    {"hours": 12, "everything": true}  stop the free GitHub pool as well: nothing renders at all
 *   POST /internal/admin/resume                   start again, and clear an automatic budget pause too
 *   GET  /internal/admin/pause                    what is on right now, and today's spend estimate
 * All three: `Authorization: Bearer <INTERNAL_SECRET>`, the same shape as /internal/dev/plan and /internal/pool/claim.
 * The "paused" flag is read by the orchestrator exactly where vast_unavailable is, so the queue keeps its jobs and
 * its credits and simply stops spending; the free GitHub runners keep going, because they cost nothing — unless
 * "everything" is asked for, which is the switch to press when the problem is what is being rendered, not the bill.
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.INTERNAL_SECRET || !token || !safeEqual(token, env.INTERNAL_SECRET)) return json({ error: "unauthorized" }, 401);
  const path = new URL(request.url).pathname;
  const state = async () => ({
    paused: await isFlagActive(env, "paused"),
    paused_all: await isFlagActive(env, "paused_all"),
    budget_pause: await isFlagActive(env, "budget_pause"),
    running: await countRunning(env),
    spend_today_usd: Math.round((await budgetSpentUsd(env)) * 1000) / 1000,
    budget_usd: num(env.DAILY_GPU_BUDGET_USD, 1),
  });
  if (request.method === "GET" && path === "/internal/admin/pause") return json(await state());
  // The kie.ai switch and model, changeable from a phone between two test videos, no deploy:
  //   GET  /internal/admin/footage                      what is on, the models Kleo knows, today's kie.ai spend
  //   POST /internal/admin/footage {"backend":"kie","model":"kling-3.0"}   ({"reset":true} goes back to the config)
  if (path === "/internal/admin/footage") {
    const view = async () => {
      const cfg = await footageConfig(env);
      const probe = { params: JSON.stringify({ duration_s: 1 }) };
      return { backend: footageBackendFor(env, probe, cfg), model: kieModelFor(env, cfg).name, override: cfg,
        key_configured: !!(env.KIE_API_KEY && env.KIE_API_KEY.trim()), max_video_s: int(env.KIE_MAX_VIDEO_S, 20),
        spend_today_usd: Math.round((await footageSpentTodayUsd(env)) * 1000) / 1000, budget_usd: num(env.DAILY_FOOTAGE_BUDGET_USD, 5),
        balance_usd: await kieBalanceUsd(env), // what the kie.ai account can still spend (null when kie.ai did not answer)
        ephone_key_configured: !!(env.EPHONE_API_KEY && env.EPHONE_API_KEY.trim()),
        ephone_balance_usd: await ephoneBalanceUsd(env), // the same for ePhone AI (null when it did not answer or no key)
        models: Object.fromEntries(Object.entries(KIE_MODELS).map(([k, m]) => [k, { provider: m.provider ?? "kie", usd_per_s: m.usdPerSecond, ...(m.usdPerClip ? { usd_per_clip: m.usdPerClip } : {}), seconds: m.seconds, verified: m.verified, note: m.note }])) };
    };
    if (request.method === "GET") return json(await view());
    if (request.method !== "POST") return json({ error: "method" }, 405);
    const b = (await request.json().catch(() => ({}))) as { backend?: string; model?: string; reset?: boolean };
    if (b.reset) { await setFootageConfig(env, null); await audit(env, null, null, "admin.footage", { reset: true }); return json({ ok: true, ...(await view()) }); }
    const o: { backend?: "kie" | "local"; model?: string } = { ...(await footageConfig(env)) };
    if (b.backend !== undefined) { if (b.backend !== "kie" && b.backend !== "local") return json({ error: "backend must be kie or local" }, 400); o.backend = b.backend; }
    if (b.model !== undefined) { if (!KIE_MODELS[b.model]) return json({ error: `unknown model; one of ${Object.keys(KIE_MODELS).join(", ")}` }, 400); o.model = b.model; }
    await setFootageConfig(env, o);
    await audit(env, null, null, "admin.footage", o);
    return json({ ok: true, ...(await view()) });
  }
  // The treatment on its own, from anywhere with the secret and no laptop: N treatments of one request on the
  // Worker's own AI binding, with the distance between their proses. It is how the adapt-prompt gets MEASURED
  // (docs/ADAPT-PROMPT.md §6) once the Workers AI quota is back — the same call kleo_adapt_prompt makes, minus the
  // account, so it is never billed to a user and never counted against one.
  //   POST /internal/admin/treatment {"prompt":"…","duration_s":60,"format":"16:9","language":"en","n":2,"model":"<optional>"}
  if (path === "/internal/admin/treatment") {
    if (request.method !== "POST") return json({ error: "method" }, 405);
    const b = (await request.json().catch(() => ({}))) as { prompt?: unknown; duration_s?: unknown; format?: unknown; language?: unknown; n?: unknown; model?: unknown };
    const prompt = String(b.prompt ?? "").trim();
    if (prompt.length < 8 || prompt.length > 4000) return json({ error: "prompt: 8 to 4000 characters" }, 400);
    const n = Math.min(5, Math.max(1, Math.round(Number(b.n ?? 1)) || 1));
    const duration_s = Math.min(300, Math.max(15, Math.round(Number(b.duration_s ?? 60)) || 60));
    const format = b.format === "9:16" ? "9:16" : "16:9";
    const language = b.language === "it" ? "it" : "en";
    const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined;
    const results = [];
    for (let i = 0; i < n; i++) results.push(await writeTreatment(env, { prompt, duration_s, format, language }, { model }));
    const written = results.filter((r) => r.treatment);
    const d: number[] = [];
    for (let i = 0; i < written.length; i++) for (let j = i + 1; j < written.length; j++)
      d.push(proseDistance(`${written[i].treatment!.logline} ${written[i].treatment!.prose}`, `${written[j].treatment!.logline} ${written[j].treatment!.prose}`));
    const neurons = results.reduce((s, r) => s + (r.est_neurons ?? 0), 0);
    const distance = d.length ? { min: Math.round(Math.min(...d) * 100) / 100, mean: Math.round((d.reduce((a, x) => a + x, 0) / d.length) * 100) / 100 } : null;
    await audit(env, null, null, "admin.treatment", { n, written: written.length, neurons, model: results[0]?.model, distance, transient: results.some((r) => r.transient) });
    return json({
      ok: written.length === n, model: results[0]?.model ?? null, asked: n, written: written.length, neurons, distance,
      draws: written.map((r) => r.treatment!.variation), loglines: written.map((r) => r.treatment!.logline),
      treatments: results.map((r) => r.treatment), problems: results.map((r) => r.history), transient: results.some((r) => r.transient),
    });
  }
  if (request.method !== "POST") return json({ error: "method" }, 405);
  //   POST /internal/admin/retry {"job_id":"gt_…"}   a film that failed in its FINISH phase goes back in the queue with
  //   everything it already paid for: the gen bundle, the clip rows (ready), the music. Only a finish box is rented again;
  //   the credits refunded on failure are NOT taken back (the failure was Kleo's). 22 September 2026: gt_nyhb8aj9 died
  //   three times on "Invalid master" with 1.68 $ of clips and music bought, and the fix was already on the image.
  if (path === "/internal/admin/retry") {
    const b = (await request.json().catch(() => ({}))) as { job_id?: unknown };
    const id = String(b.job_id ?? "").trim();
    const job = id ? await getJob(env, id) : null;
    if (!job) return json({ error: "job_id: no such video" }, 404);
    if (job.state !== "failed" || (job.phase ?? "gen") !== "finish") return json({ error: `only a film that failed in its finish phase can be retried (this one is ${job.state}, phase ${job.phase ?? "gen"})` }, 409);
    const ok = await transitionJob(env, job.id, ["failed"], {
      state: "queued", backend: null, instance_id: null, instance_meta: null, started_at: null, finished_at: null, last_report_at: null, queued_at: nowIso(),
      percent: 58, track: "clips", error: null, attempts: 0, worker_secret: rid("wk", 32),
    });
    // A film sold the AI upscale: its credits came back with the failure, so the retry's finish refunds nothing again,
    // and a verdict a /done left on the failed row is not this attempt's (review, 25 September 2026).
    if (ok && aiUpscaleJob(job)) await updateJobParams(env, job.id, { ai_upscale_result: undefined, ai_upscale_refunded: true });
    await audit(env, job.user_id, job.id, "admin.retry", { from: "failed", phase: job.phase, previous_error: (job.error ?? "").slice(0, 200), ok });
    return json({ ok, job_id: job.id, state: ok ? "queued" : job.state, phase: "finish", note: "the finish box is rented again; clips and music are reused, no credit is charged" });
  }
  if (path === "/internal/admin/pause") {
    const b = (await request.json().catch(() => ({}))) as { hours?: number; everything?: boolean };
    const hours = Math.min(168, Math.max(1, Math.round(Number(b.hours ?? 12)) || 12));
    await setFlagUntil(env, "paused", hours * 3600);
    // Money and content are two different emergencies. The plain pause stops the SPENDING and lets the free runners
    // keep working; {"everything": true} is for the other one — a prompt that must not be rendered at all — and stops
    // the free pool too, which is the only thing that can still deliver a video while Kleo is paused.
    if (b.everything) await setFlagUntil(env, "paused_all", hours * 3600);
    await audit(env, null, null, "admin.paused", { hours, everything: !!b.everything });
    return json({ ok: true, paused_for_hours: hours, ...(await state()) });
  }
  if (path === "/internal/admin/resume") {
    await releaseLock(env, "paused");
    await releaseLock(env, "paused_all");
    await releaseLock(env, "budget_pause"); // an automatic pause is the commonest reason to press resume
    await audit(env, null, null, "admin.resumed", {});
    return json({ ok: true, ...(await state()) });
  }
  return json({ error: "not found" }, 404);
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
  // The money pause leaves the free runners alone on purpose; "paused_all" is the switch that stops rendering itself.
  if (await isFlagActive(env, "paused_all")) return json({ job: null, paused: true });
  const body = (await request.json().catch(() => ({}))) as { runner?: string };
  const runner = String(body.runner ?? "runner").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) || "runner";
  const vastFirst = env.RENDER_BACKEND === "vast" && !(await isFlagActive(env, "vast_unavailable"));
  const job = await claimQueuedJob(env, runner, vastFirst ? int(env.POOL_AFTER_MIN, 3) : 0);
  if (!job) return json({ job: null });
  await audit(env, job.user_id, job.id, "job.started", { backend: "pool", instance: runner });
  return json({ job_id: job.id, worker_secret: job.worker_secret, api: env.PUBLIC_URL, template: job.template, format: (JSON.parse(job.params) as { format: string }).format });
}
