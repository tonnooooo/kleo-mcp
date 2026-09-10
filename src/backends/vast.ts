import type { RenderBackend, StartResult } from "./types";
import type { Env } from "../env";
import type { Job } from "../db";
import { int, num, minutesSince } from "../util";

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

export interface Offer { id: number; dph_total: number; gpu_name: string; inet_down: number; reliability2?: number; disk_space: number; cuda_max_good?: number; geolocation?: string; cpu_cores_effective?: number; cpu_ram?: number; }
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

export async function searchOffers(env: Env): Promise<Offer[]> {
  const disk = int(env.VAST_DISK_GB, 80);
  const query = {
    verified: { eq: true },
    rentable: { eq: true },
    external: { eq: false },
    num_gpus: { eq: 1 },
    gpu_name: { eq: env.VAST_GPU_NAME ?? "RTX 4090" },
    inet_down: { gte: 500 },
    cpu_cores_effective: { gte: int(env.VAST_MIN_CPU, 16) },
    cpu_ram: { gte: int(env.VAST_MIN_RAM_GB, 32) * 1024 },
    reliability2: { gte: 0.98 },
    disk_space: { gte: disk },
    dph_total: { lte: num(env.VAST_MAX_DPH, 0.6) },
    cuda_max_good: { gte: 12.4 },
    type: "on-demand",
    allocated_storage: disk,
    order: [["dph_total", "asc"]],
    limit: 10,
  };
  const r = await vast<{ offers?: Offer[] }>(env, "POST", "/bundles/", query);
  return r.offers ?? [];
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
    const offers = await searchOffers(env);
    if (!offers.length) throw new Error("no Vast.ai offer matches the filters (gpu/price/network)");
    const timeoutMin = int(env.JOB_TIMEOUT_MIN, 120);
    let lastErr: unknown = null;
    // Anchor for adoption: nothing that existed before this call can belong to it (see adoptOrphan).
    const attemptStart = Date.now();
    for (const [i, offer] of offers.slice(0, 3).entries()) {
      if (i > 0) await sleep(1500); // create endpoint is rate-limited
      try {
        const body: Record<string, unknown> = {
          client_id: "me",
          image: env.VAST_IMAGE,
          disk: int(env.VAST_DISK_GB, 80),
          label: jobLabel(job.id), // never inline the prefix: create and sweep must read the same label
          runtype: "ssh",
          cancel_unavail: true,
          onstart: onstartScript(env),
          env: {
            KLEO_API: env.PUBLIC_URL,
            KLEO_JOB_ID: job.id,
            KLEO_SECRET: job.worker_secret,
            KLEO_SELF_DESTRUCT_MIN: String(Math.max(10, timeoutMin - 5)),
            KLEO_DPH: String(offer.dph_total),
            KLEO_KEOU_WORKERS: String(Math.min(16, Math.max(2, Math.floor(offer.cpu_cores_effective ?? 8)))), // whole box, but the engine caps render workers at 16
            ...renderEnv(env),
          },
        };
        const r = await vast<{ success: boolean; new_contract?: number; msg?: string; error?: string }>(env, "PUT", `/asks/${offer.id}/`, body);
        // A well-formed refusal ("offer taken", no credit...): the request was understood and declined, nothing was rented.
        if (!r.success || !r.new_contract) throw new VastCallError(r.msg ?? r.error ?? "create instance failed", 200, false);
        return { instanceId: String(r.new_contract), meta: { offer: offer.id, gpu: offer.gpu_name, dph: offer.dph_total, inet_down: offer.inet_down, geo: offer.geolocation, cpu: offer.cpu_cores_effective, ram_mb: offer.cpu_ram } };
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
export async function vastStatus(env: Env, job: Job): Promise<string | null> {
  if (!job.instance_id) return null;
  try {
    const r = await vast<{ instances?: Instance | null }>(env, "GET", `/instances/${job.instance_id}/`);
    return r.instances?.actual_status ?? null;
  } catch {
    return null;
  }
}
