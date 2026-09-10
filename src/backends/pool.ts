import type { RenderBackend } from "./types";

/**
 * Pool backend: jobs are not started by the orchestrator; external runners (GitHub Actions, any box you own)
 * claim them via POST /internal/pool/claim with the POOL_SECRET and then behave exactly like a Vast worker.
 * Used as the free fallback when Vast.ai cannot rent (no credit, no offers) or as the only backend (RENDER_BACKEND=pool).
 */
export const poolBackend: RenderBackend = {
  name: "pool",
  async start() {
    throw new Error("pool jobs are claimed by runners, not started by the orchestrator");
  },
  async poll() {
    return "running";
  },
  async destroy() {
    return 0;
  },
};
