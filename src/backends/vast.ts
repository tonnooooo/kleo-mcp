import type { RenderBackend, StartResult } from "./types";
import type { Env } from "../env";
import type { Job } from "../db";
import { int, num, minutesSince } from "../util";

/**
 * Vast.ai backend: one ephemeral instance per job.
 * REST API: https://console.vast.ai/api/v0, header `Authorization: Bearer <VAST_API_KEY>`.
 * Verified against docs.vast.ai (Sept 2026):
 *   search offers    POST   /bundles/              body: filter object  → { offers: [...] }
 *   create instance  PUT    /asks/{offer_id}/      body: image, env, disk, onstart, runtype, label, cancel_unavail → { success, new_contract }
 *   show instance    GET    /instances/{id}/       → { instances: { actual_status, start_date, dph_total, ... } }
 *   destroy          DELETE /instances/{id}/
 * Inside the container Vast injects CONTAINER_ID and CONTAINER_API_KEY (restricted to that instance),
 * so the worker can destroy itself without ever seeing the account key.
 */
const BASE = "https://console.vast.ai/api/v0";

async function vast<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  if (!env.VAST_API_KEY) throw new Error("VAST_API_KEY is not set");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${env.VAST_API_KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vast ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface Offer { id: number; dph_total: number; gpu_name: string; inet_down: number; reliability2?: number; disk_space: number; cuda_max_good?: number; geolocation?: string; }
interface Instance { actual_status?: string | null; cur_state?: string; start_date?: number; dph_total?: number; status_msg?: string; }

export async function searchOffers(env: Env): Promise<Offer[]> {
  const disk = int(env.VAST_DISK_GB, 80);
  const query = {
    verified: { eq: true },
    rentable: { eq: true },
    external: { eq: false },
    num_gpus: { eq: 1 },
    gpu_name: { eq: env.VAST_GPU_NAME ?? "RTX 4090" },
    inet_down: { gte: 500 },
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

export const vastBackend: RenderBackend = {
  name: "vast",

  async start(env: Env, job: Job): Promise<StartResult> {
    if (!env.VAST_IMAGE || env.VAST_IMAGE.includes("REPLACE_ME")) throw new Error("VAST_IMAGE is not configured");
    const offers = await searchOffers(env);
    if (!offers.length) throw new Error("no Vast.ai offer matches the filters (gpu/price/network)");
    const timeoutMin = int(env.JOB_TIMEOUT_MIN, 120);
    let lastErr: unknown = null;
    for (const [i, offer] of offers.slice(0, 3).entries()) {
      if (i > 0) await sleep(1500); // create endpoint is rate-limited
      try {
        const body: Record<string, unknown> = {
          client_id: "me",
          image: env.VAST_IMAGE,
          disk: int(env.VAST_DISK_GB, 80),
          label: `gatto-${job.id}`,
          runtype: "ssh",
          cancel_unavail: true,
          onstart: "env >> /etc/environment; cd /opt/gatto && nohup python3 gatto_worker.py >> /var/log/gatto.log 2>&1 &",
          env: {
            GATTO_API: env.PUBLIC_URL,
            GATTO_JOB_ID: job.id,
            GATTO_SECRET: job.worker_secret,
            GATTO_SELF_DESTRUCT_MIN: String(Math.max(10, timeoutMin - 5)),
          },
        };
        const r = await vast<{ success: boolean; new_contract?: number; msg?: string; error?: string }>(env, "PUT", `/asks/${offer.id}/`, body);
        if (!r.success || !r.new_contract) throw new Error(r.msg ?? r.error ?? "create instance failed");
        return { instanceId: String(r.new_contract), meta: { offer: offer.id, gpu: offer.gpu_name, dph: offer.dph_total, inet_down: offer.inet_down, geo: offer.geolocation } };
      } catch (e) {
        lastErr = e; // 404/410: the offer was taken meanwhile → next one
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
    try {
      await vast(env, "DELETE", `/instances/${job.instance_id}/`);
    } catch (e) {
      if (!String(e).includes("404")) throw e;
    }
    return cost;
  },
};
