import type { RenderBackend } from "./types";
import { rid } from "../util";

/**
 * Manual backend: no GPU is provisioned and nothing is simulated. A job is marked "starting" and then
 * waits for an external worker (a container you run by hand with KLEO_API / KLEO_JOB_ID / KLEO_SECRET)
 * to report progress and upload the files. Used by test/worker-e2e.mjs and for debugging.
 */
export const manualBackend: RenderBackend = {
  name: "manual",
  async start() {
    return { instanceId: rid("manual", 6), meta: { note: "waiting for an external worker" } };
  },
  async poll() {
    return "running";
  },
  async destroy() {
    return 0;
  },
};
