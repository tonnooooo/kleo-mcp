import type { Env } from "../env";
import type { Job } from "../db";

export interface StartResult {
  instanceId: string;
  meta?: Record<string, unknown>;
}

export interface RenderBackend {
  readonly name: "mock" | "vast";
  /** Provision a GPU for this job and start the worker. Must be quick (API calls only). */
  start(env: Env, job: Job): Promise<StartResult>;
  /** Optional liveness check for a running job. "gone" means the instance died. */
  poll?(env: Env, job: Job): Promise<"running" | "gone" | "unknown">;
  /** Tear the GPU down. Idempotent. May return an estimated cost in USD. */
  destroy(env: Env, job: Job): Promise<number | undefined>;
}
