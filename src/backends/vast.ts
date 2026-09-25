import type { RenderBackend, StartResult } from "./types";
import type { Env } from "../env";
import type { Job } from "../db";
import { triedMachines } from "../db";
import { int, num, minutesSince } from "../util";
import { jobTimeoutMin, machineFor, styleOfJob, isVideoStyle, filmedJob, videoMachineFor, videoModelIsGated, videoDiskGb, FINISH, FINISH_SR, aiUpscaleJob, aiUpscaleOn, type Machine } from "../templates";
import { footageBackendFor, footageConfig, kieModelFor, type FootageBackend } from "../footage";

/**
 * Vast.ai backend: one ephemeral instance per job.
 * REST API: https://console.vast.ai/api/v0, header `Authorization: Bearer <VAST_API_KEY>`.
 * Verified against docs.vast.ai and by hand against the live API (Sept 2026):
 *   search offers    POST   /api/v0/bundles/          body: filter object  → { offers: [...] }
 *   create instance  PUT    /api/v0/asks/{offer_id}/  body: image, env, disk, onstart, runtype, label, cancel_unavail → { success, new_contract }
 *   show instance    GET    /api/v0/instances/{id}/   → { instances: { actual_status, start_date, dph_total, ... } }
 *   destroy          DELETE /api/v0/instances/{id}/
 *   LIST instances   GET    /api/v1/instances/        → { success, instances: [{ id, label, actual_status, ... }], next_token }
 * The LIST endpoint, and only that one, moved to v1: /api/v0/instances/ (with or without ?owner=me) now answers
 * { "success": false, "error": "deprecated_endpoint", "msg": "... Use /api/v1/instances/ instead." }. That answer is a
 * *successful-looking* body, so the old code silently listed nothing: the orphan sweep and the label lookup found
 * nothing and a runaway GPU burned money until the worker's self-destruct. Everything else stays on v0.
 * Inside the container Vast injects CONTAINER_ID and CONTAINER_API_KEY (restricted to that instance),
 * so the worker can destroy itself without ever seeing the account key.
 */
const BASE = "https://console.vast.ai/api/v0";
/** Instance LISTING only (see above). Never point the single-instance / asks / bundles calls here: they are v0. */
const BASE_LIST = "https://console.vast.ai/api/v1";

/**
 * A Vast call that failed. `mayHaveCreated` is what start() needs after a PUT /asks/: false when the API clearly
 * rejected the request (4xx, or a well-formed `success: false` body) so nothing was rented, true when the request
 * may well have taken effect and only the answer was lost (5xx, 408, unreadable body, network abort).
 */
class VastCallError extends Error {
  constructor(message: string, readonly status: number, readonly mayHaveCreated: boolean) {
    super(message);
    this.name = "VastCallError";
  }
}
/** True unless Vast answered with a definite rejection: the pessimistic reading, used to decide whether to look for an orphan. */
const mayHaveCreated = (e: unknown) => !(e instanceof VastCallError) || e.mayHaveCreated;

async function vast<T>(env: Env, method: string, path: string, body?: unknown, base: string = BASE): Promise<T> {
  if (!env.VAST_API_KEY) throw new Error("VAST_API_KEY is not set");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${env.VAST_API_KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  // 4xx (bar 408 Request Timeout) is Vast refusing the request outright; 5xx and anything unreadable may have taken effect.
  if (!res.ok) throw new VastCallError(`Vast ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status, !(res.status >= 400 && res.status < 500 && res.status !== 408));
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new VastCallError(`Vast ${method} ${path} → ${res.status}: unreadable body ${text.slice(0, 120)}`, res.status, true);
  }
}

export interface Offer { id: number; machine_id?: number; dph_total: number; gpu_name: string; inet_down: number; reliability2?: number; disk_space: number; cuda_max_good?: number; geolocation?: string; cpu_cores_effective?: number; cpu_ram?: number; }
interface Instance { actual_status?: string | null; cur_state?: string; start_date?: number; dph_total?: number; status_msg?: string; }
interface InstanceRow extends Instance { id: number; label?: string | null; }

/**
 * Every instance is created with `label: "kleo-<job id>"`. That label is the ONLY handle on an instance whose
 * creation answer never came back (see start()), so nothing else may ever use this prefix on the account.
 */
export const LABEL_PREFIX = "kleo-";
export const jobLabel = (jobId: string) => `${LABEL_PREFIX}${jobId}`;

/** Pages of the listing to walk before giving up: 100+ Kleo instances at once would be a runaway of its own. */
const LIST_MAX_PAGES = 20;

/**
 * All instances of the account, via the v1 listing (v0's is deprecated — see the header). Returns an array of rows,
 * unlike GET /api/v0/instances/{id}/ which returns one object. Follows `next_token` to the end: an account with more
 * instances than one page would otherwise hide orphans on page two. A `success: false` body is an error here, not an
 * empty account — that is exactly how the v0 deprecation went unnoticed.
 */
async function listInstances(env: Env): Promise<InstanceRow[]> {
  const out: InstanceRow[] = [];
  const seen = new Set<number>();
  let token = "";
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const q = token ? `?next_token=${encodeURIComponent(token)}` : "";
    const r = await vast<{ success?: boolean; error?: string; msg?: string; instances?: InstanceRow[] | null; next_token?: string | number | null }>(
      env, "GET", `/instances/${q}`, undefined, BASE_LIST);
    if (r.success === false) throw new Error(`Vast GET /api/v1/instances/ refused: ${r.error ?? "unknown"} ${r.msg ?? ""}`.trim().slice(0, 300));
    const rows = Array.isArray(r.instances) ? r.instances.filter((i) => i && typeof i.id === "number") : [];
    for (const i of rows) if (!seen.has(i.id)) { seen.add(i.id); out.push(i); }
    const next = r.next_token == null ? "" : String(r.next_token);
    if (!next || next === token || !rows.length) break; // no more pages, or a token that would loop forever
    token = next;
  }
  return out;
}

/** The account's Kleo instances with the job each one was rented for (label). Feeds the orphan sweep in the orchestrator. */
export async function listKleoInstances(env: Env): Promise<{ id: number; jobId: string; status: string | null; dph: number | undefined }[]> {
  const out: { id: number; jobId: string; status: string | null; dph: number | undefined }[] = [];
  for (const i of await listInstances(env)) {
    const label = typeof i.label === "string" ? i.label : "";
    if (!label.startsWith(LABEL_PREFIX) || label.length === LABEL_PREFIX.length) continue;
    out.push({ id: i.id, jobId: label.slice(LABEL_PREFIX.length), status: i.actual_status ?? null, dph: i.dph_total });
  }
  return out;
}

/** Destroys one instance by id. Idempotent: a 404 means someone (the worker's self-destruct) got there first. */
export async function destroyInstance(env: Env, id: number | string): Promise<void> {
  try {
    await vast(env, "DELETE", `/instances/${id}/`);
  } catch (e) {
    if (!String(e).includes("404")) throw e;
  }
}

/** Clock slack between this Worker and Vast's `start_date`, so a genuinely fresh instance is never read as stale. */
const ADOPT_CLOCK_SKEW_MS = 90_000;

/**
 * Adopts the instance THIS attempt may already have created, after a create whose answer was lost. Same label → same
 * job id, so the worker secret and KLEO_API baked into that instance's env are this job's: adopting is better than
 * destroying, the rental is already paid for.
 *
 * "This attempt" is the whole point. failJob() rotates worker_secret on every requeue, so a same-label instance left
 * over from an EARLIER attempt carries a secret the API now rejects: adopting it hands the job a GPU whose worker
 * 401s forever, and the job stalls for the entire start timeout instead of simply retrying the next offer. Only an
 * instance whose start_date is at or after `notBefore` (this start() call, minus clock skew) qualifies; every other
 * same-label instance — older, or with no start_date to vouch for it — is destroyed rather than adopted, and so is
 * any duplicate beyond the newest, since only the instance we return is recorded on the job and therefore reachable
 * by poll() / destroy() later. Null = nothing of ours to keep, so the caller just moves on to the next offer.
 */
async function adoptOrphan(env: Env, job: Job, offer: Offer, notBefore: number): Promise<StartResult | null> {
  const label = jobLabel(job.id);
  const mine = (await listInstances(env)).filter((i) => i.label === label);
  if (!mine.length) return null;
  const fresh = mine.filter((i) => typeof i.start_date === "number" && i.start_date * 1000 >= notBefore - ADOPT_CLOCK_SKEW_MS);
  // Newest first: among several lost answers of this same start() call, the last one's env is the one we know about.
  const keep = fresh.length ? fresh.reduce((a, b) => (b.id > a.id ? b : a)) : null;
  let destroyed = 0;
  for (const i of mine) {
    if (keep && i.id === keep.id) continue;
    try { await destroyInstance(env, i.id); destroyed++; } catch { /* best effort: the sweep is the net */ }
  }
  if (!keep) return null;
  return {
    instanceId: String(keep.id),
    meta: { offer: offer.id, gpu: offer.gpu_name, dph: keep.dph_total ?? offer.dph_total, geo: offer.geolocation, adopted: true, duplicates_destroyed: destroyed },
  };
}

/**
 * How a machine is recognised across attempts. `machine_id` is the PHYSICAL host and is what we want: the same box
 * is offered under a new offer id the moment the previous rental is destroyed, so excluding the offer alone excludes
 * nothing. The offer id is the fallback for an answer that does not carry the machine.
 */
export const machineKey = (o: { machine_id?: number; id: number }): string =>
  o.machine_id ? `m:${o.machine_id}` : `o:${o.id}`;

/**
 * The machine a job needs right now: its phase first (a finish box is the cheapest thing that runs ffmpeg — or, for a
 * film sold the AI upscale while the kill switch is not off, the cheapest card that can run SR + RIFE), then its style.
 */
export function profileFor(env: Env, style: string | null | undefined, phase?: string | null, footage: FootageBackend = "local", drawn = false, upscale = false): { need: Machine; disk: number } {
  if (phase === "finish") return { need: upscale && aiUpscaleOn(env) ? FINISH_SR : FINISH, disk: int(env.FINISH_DISK_GB, 40) };
  // On the kie.ai road the box never loads a video model: it draws the frames, voices, times the cuts and waits.
  // That is the pictures job, on the pictures card — 16 GB at $0.40/h instead of 80 GB at $2.60/h. An ANIMATIC
  // (`drawn`: the stills with the camera over them, no clip at all) is that same job whatever the footage switch says.
  if (footage === "kie" || drawn) return { need: machineFor("cartoon"), disk: int(env.VAST_DISK_GB, 80) };
  // What this style needs of a machine (src/templates.ts): memory, architecture and its own price ceiling. The
  // global VAST_MAX_DPH stays the ceiling for everything ordinary — a cyber video must never pay for a card rented
  // to generate motion — and a style only ever raises it for itself. A filmed style's card and disk follow the
  // generator model (13 September: LTX-2.5 wants 80 GB and 150 GB of disk, Wan 2.2 5B 32 GB and 80 GB).
  const filmed = isVideoStyle(style);
  const need = filmed ? videoMachineFor(env.KLEO_VIDEO_MODEL, { minVramGb: env.VIDEO_MIN_VRAM_GB, maxDph: env.VIDEO_MAX_DPH }) : machineFor(style);
  const disk = filmed ? videoDiskGb(env.KLEO_VIDEO_MODEL, int(env.VAST_DISK_GB, 80)) : int(env.VAST_DISK_GB, 80);
  return { need, disk };
}

export async function searchOffers(env: Env, style?: string | null, phase?: string | null, footage: FootageBackend = "local", drawn = false, upscale = false): Promise<Offer[]> {
  const { need, disk } = profileFor(env, style, phase, footage, drawn, upscale);
  const query = {
    verified: { eq: true },
    rentable: { eq: true },
    external: { eq: false },
    num_gpus: { eq: 1 },
    // NOT the card's name. The name is not the constraint and never was: modified RTX 4090s with 48 GB exist, and a
    // Tesla V100 passes any name filter written for its memory while being the wrong card entirely (compute 7.0, no
    // bf16 tensor cores, several times slower on this exact work). Memory and architecture are the constraint.
    gpu_ram: { gte: need.minVramGb * 1024 },
    compute_cap: { gte: need.minComputeCap },
    // NOT because bandwidth is the biggest slice of time to first frame — that was the fifth place the mis-measured
    // twenty-minute pull was still written down, and the pull is about three minutes (docs/PULL-IMMAGINE.md). Measured
    // 11 September, dropping this filter entirely returns four more offers out of nine: it costs almost nothing and
    // still keeps out the hosts that crawl. The filter that actually decides how many machines exist is the price.
    inet_down: { gte: int(env.VAST_MIN_INET, 800) },
    cpu_cores_effective: { gte: int(env.VAST_MIN_CPU, 16) },
    cpu_ram: { gte: int(env.VAST_MIN_RAM_GB, 32) * 1024 },
    reliability2: { gte: 0.98 },
    disk_space: { gte: disk },
    dph_total: { lte: Math.max(num(env.VAST_MAX_DPH, 0.4), need.maxDph) },
    cuda_max_good: { gte: 12.4 },
    type: "on-demand",
    allocated_storage: disk,
    order: [["dph_total", "asc"]],
    limit: 10,
  };
  const r = await vast<{ offers?: Offer[] }>(env, "POST", "/bundles/", query);
  return (r.offers ?? []).filter((o) => !geoExcluded(env.VAST_GEO_EXCLUDE ?? DEFAULT_GEO_EXCLUDE, o.geolocation));
}

/**
 * Countries whose hosts cannot reach ghcr.io at speed: the worker image is 15 GB and every rental pulls it. Measured
 * 20 September 2026 — rental to the worker's first message was 0.6-6.6 min on 19 US/CA/EU/JP hosts, and a Shanghai
 * RTX 3090 with 1360 Mbit/s "down" was still pulling layers after 25 minutes (job gt_ebtbsbq4): the bandwidth figure
 * is measured to somewhere else. Vast's geolocation is "City, CC" on an offer and "CC" alone on some; both are read.
 */
export const DEFAULT_GEO_EXCLUDE = "CN";
export function geoExcluded(list: string, geo: string | null | undefined): boolean {
  const codes = list.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (!codes.length || !geo) return false;
  const cc = geo.trim().split(",").pop()?.trim().toUpperCase() ?? "";
  return codes.includes(cc);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot script (Vast limit: 4048 chars). With VAST_BOOTSTRAP_URL set, any public image with python3 works:
 * the script installs ffmpeg if missing and downloads the worker; otherwise the image must already ship /opt/kleo
 * (worker/Dockerfile: /opt/kleo/kleo_worker.py + the Keou engine in /opt/kleo/keou). Setting the URL on an image
 * that ships /opt/kleo is harmless: it only refreshes kleo_worker.py.
 */
function onstartScript(env: Env): string {
  const url = env.VAST_BOOTSTRAP_URL;
  const fetchWorker = url
    ? `mkdir -p /opt/kleo && (command -v ffmpeg >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg python3 curl ca-certificates >/dev/null)) && curl -fsSL '${url}' -o /opt/kleo/kleo_worker.py; `
    : "";
  return `env >> /etc/environment; ${fetchWorker}cd /opt/kleo && nohup python3 kleo_worker.py >> /var/log/kleo.log 2>&1 &`;
}

/** Optional render tuning forwarded to the worker verbatim when set on the Worker (wrangler vars or secrets). */
const RENDER_ENV_PASSTHROUGH = ["KLEO_WIDTH_PORTRAIT", "KLEO_WIDTH_LANDSCAPE", "KLEO_RENDER_TIMEOUT_MIN", "KLEO_PICTURES", "KLEO_PICTURES_DOWNLOAD"] as const; // KLEO_PICTURES: auto | server | local (where the scene pictures are drawn)
function renderEnv(env: Env): Record<string, string> {
  const bag = env as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of RENDER_ENV_PASSTHROUGH) {
    const v = bag[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

export const vastBackend: RenderBackend = {
  name: "vast",

  async start(env: Env, job: Job): Promise<StartResult> {
    if (!env.VAST_IMAGE || env.VAST_IMAGE.includes("REPLACE_ME")) throw new Error("VAST_IMAGE is not configured");
    // Decided ONCE per rental and written on the box: the machine, the env and the job spec must tell the same story.
    const footageCfg = await footageConfig(env);
    // A filmed job orders its clips on the footage road; an animatic (a video look, drawn) orders none and is a
    // pictures job on the pictures card, so `drawn` says so to the profile whatever the switch is set to.
    const filmed = filmedJob(job);
    const footage = filmed ? footageBackendFor(env, job, footageCfg) : "local";
    const drawn = !filmed && isVideoStyle(styleOfJob(job));
    // The AI upscale (25 September 2026) is the user's paid option: only such a job gets the SR card and KLEO_SR "auto".
    const upscale = aiUpscaleJob(job);
    const offers = await searchOffers(env, styleOfJob(job), job.phase, footage, drawn, upscale);
    if (!offers.length) {
      const { need } = profileFor(env, styleOfJob(job), job.phase, footage, drawn, upscale); // the card that was really searched for
      throw new Error(`no Vast.ai offer matches the filters: ${need.minVramGb} GB of VRAM, compute ${need.minComputeCap / 100}, at most $${Math.max(num(env.VAST_MAX_DPH, 0.4), need.maxDph)}/h`); // the ceiling really used: the audit of 12 September said "$0.4" while the search ran at 1.00, and the number was chased for nothing
    }
    // A retry must move HOST, which is the whole point of retrying a job that was still downloading after 23 minutes.
    // It could not: the requeue clears instance_id and instance_meta, and the search orders by price, so the machine
    // just declared too slow is freed, returns to the top and is rented again — measured on gt_7f7gnsjt, whose third
    // attempt took the same offer the second had abandoned. The job now carries what it has already tried.
    // It is a PREFERENCE, never a gate: a slow machine sometimes finishes, a job that rents nothing never does, so
    // when every candidate has been tried the full list is used again rather than failing the job.
    const tried = new Set(triedMachines(job));
    const fresh = offers.filter((o) => !tried.has(machineKey(o)));
    const candidates = fresh.length ? fresh : offers;
    // The same per-job number the orchestrator kills on (templates.ts), so the container's own watchdog and the
    // server always agree; a flat 120 here would let a machine run an hour past the moment the server gave up on it.
    const timeoutMin = jobTimeoutMin(env, job);
    let lastErr: unknown = null;
    // Anchor for adoption: nothing that existed before this call can belong to it (see adoptOrphan).
    const attemptStart = Date.now();
    for (const [i, offer] of candidates.slice(0, 3).entries()) {
      if (i > 0) await sleep(1500); // create endpoint is rate-limited
      try {
        const body: Record<string, unknown> = {
          client_id: "me",
          image: env.VAST_IMAGE,
          disk: profileFor(env, styleOfJob(job), job.phase, footage, drawn, upscale).disk,
          label: jobLabel(job.id), // never inline the prefix: create and sweep must read the same label
          runtype: "ssh",
          cancel_unavail: true,
          onstart: onstartScript(env),
          env: {
            KLEO_API: env.PUBLIC_URL,
            KLEO_JOB_ID: job.id,
            KLEO_SECRET: job.worker_secret,
            KLEO_SELF_DESTRUCT_MIN: String(Math.max(10, timeoutMin - 5)),
            // The engine gives up (and the worker reports a real failure) BEFORE the watchdog destroys the box, so a
            // render that overruns comes back as an error to retry instead of a machine that silently disappears.
            // Both are listed before renderEnv, so an explicit KLEO_RENDER_TIMEOUT_MIN in the config still wins.
            KLEO_RENDER_TIMEOUT_MIN: String(Math.max(5, timeoutMin - 10)),
            KLEO_DPH: String(offer.dph_total),
            KLEO_KEOU_WORKERS: String(Math.min(16, Math.max(2, Math.floor(offer.cpu_cores_effective ?? 8)))), // whole box, but the engine caps render workers at 16
            ...renderEnv(env),
            // The generator and, when its weights are gated, the token that fetches them. HF_TOKEN is a Cloudflare
            // secret: it reaches the box's environment and nothing else — not the audit, not the job row.
            ...(env.KLEO_VIDEO_MODEL ? { KLEO_VIDEO_MODEL: env.KLEO_VIDEO_MODEL } : {}),
            ...(env.HF_TOKEN && videoModelIsGated(env.KLEO_VIDEO_MODEL) && job.phase !== "finish" && footage !== "kie" && !drawn ? { HF_TOKEN: env.HF_TOKEN } : {}),
            // Where the clips come from. "kie": the box uploads the frames and waits for the server (footage.ts);
            // the kie.ai key itself never travels. The model name is for the log only.
            KLEO_FOOTAGE_BACKEND: footage,
            ...(footage === "kie" ? { KLEO_FOOTAGE_MODEL: kieModelFor(env, footageCfg).name } : {}),
            // Which phase this box is for. A finish box never loads a model and never gets the token.
            KLEO_PHASE: job.phase === "finish" ? "finish" : "gen",
            // The neural finish of the footage track (worker/kleo_sr.py), the AI upscale the user paid for: "auto" on
            // that job's boxes only, "off" on every other; the Worker's KLEO_SR "off" wins over all (25 September 2026).
            KLEO_SR: upscale && aiUpscaleOn(env) ? "auto" : "off",
          },
        };
        const r = await vast<{ success: boolean; new_contract?: number; msg?: string; error?: string }>(env, "PUT", `/asks/${offer.id}/`, body);
        // A well-formed refusal ("offer taken", no credit...): the request was understood and declined, nothing was rented.
        if (!r.success || !r.new_contract) throw new VastCallError(r.msg ?? r.error ?? "create instance failed", 200, false);
        return { instanceId: String(r.new_contract), meta: { offer: offer.id, machine: offer.machine_id ?? null, key: machineKey(offer), gpu: offer.gpu_name, dph: offer.dph_total, inet_down: offer.inet_down, geo: offer.geolocation, cpu: offer.cpu_cores_effective, ram_mb: offer.cpu_ram } };
      } catch (e) {
        lastErr = e; // 404/410: the offer was taken meanwhile → next one
        // PUT /asks/{offer}/ is the side-effectful call: Vast may have created the instance and only the ANSWER be
        // lost (network abort, 5xx after creation, unparsable body). Moving straight to the next offer would leave a
        // GPU nobody knows about: absent from the job row, so poll() and destroy() can never reach it, two GPUs render
        // the same job, and the orphan burns money until the worker's self-destruct — forever if the worker never booted.
        // But only then: on a clean refusal nothing was created, and looking anyway would find a stale same-label
        // instance from an earlier attempt and adopt it — turning a retryable "offer taken" into a 401 stall.
        if (!mayHaveCreated(e)) continue;
        try {
          const adopted = await adoptOrphan(env, job, offer, attemptStart);
          if (adopted) return adopted;
        } catch (lookupErr) {
          // Best effort only: a failed lookup must neither hide the create error nor stop the next offer (the sweep is the net).
          lastErr = new Error(`${String(e)} | orphan lookup failed: ${String(lookupErr)}`);
        }
      }
    }
    throw new Error(`could not rent an instance: ${String(lastErr)}`);
  },

  async poll(env: Env, job: Job) {
    if (!job.instance_id) return "unknown";
    try {
      const r = await vast<{ instances?: Instance | null }>(env, "GET", `/instances/${job.instance_id}/`);
      if (!r.instances) return "gone";
      const s = r.instances.actual_status ?? "";
      if (s === "exited" || s === "offline") return "gone";
      if (s === "unknown" && job.started_at && minutesSince(job.started_at) > 15) return "gone";
      return "running";
    } catch (e) {
      return String(e).includes("404") ? "gone" : "unknown";
    }
  },

  async destroy(env: Env, job: Job) {
    if (!job.instance_id) return undefined;
    let cost: number | undefined;
    try {
      const r = await vast<{ instances?: Instance | null }>(env, "GET", `/instances/${job.instance_id}/`);
      const inst = r.instances;
      if (inst?.start_date && inst.dph_total) cost = Math.round(((Date.now() / 1000 - inst.start_date) / 3600) * inst.dph_total * 10000) / 10000;
    } catch { /* estimate is best-effort */ }
    await destroyInstance(env, job.instance_id);
    return cost;
  },
};

/** Raw actual_status of a Vast instance ("loading" while the image is still being pulled, "running", "exited"...). */
/**
 * "gone" means the instance is not there any more — which Vast does NOT say with a 404: it answers 200 with a
 * stunted record that carries no status at all. Worth separating from null, because null used to mean both "the
 * machine has vanished" and "I could not ask", and those deserve opposite reactions: the first is a decision the
 * server can act on immediately, the second is a reason to wait and ask again.
 * A machine can vanish on its own for a good reason — the worker finished and destroyed it — and for a bad one.
 * Either way there is nothing left to wait for.
 */
export const GONE = "gone";

/**
 * The Vast.ai balance, in dollars, or null when it could not be read. Null is not zero: a failed call must not be
 * read as "the money is gone", or one API hiccup would close the shop.
 */
export async function vastCredit(env: Env): Promise<number | null> {
  try {
    const r = await vast<{ credit?: number }>(env, "GET", "/users/current/");
    return typeof r.credit === "number" ? r.credit : null;
  } catch {
    return null;
  }
}

export async function vastStatus(env: Env, job: Job): Promise<string | null> {
  if (!job.instance_id) return null;
  try {
    const r = await vast<{ instances?: Instance | null }>(env, "GET", `/instances/${job.instance_id}/`);
    const inst = r.instances;
    if (!inst || (!inst.actual_status && !inst.cur_state)) return GONE;
    return inst.actual_status ?? null;
  } catch {
    return null; // could not ask: not the same thing as an answer, and must not be read as one
  }
}
