import type { RenderBackend } from "./types";
import { rid } from "../util";

/** Mock backend: no GPU. Progress is simulated by the orchestrator (see orchestrator.ts advanceMock). */
export const mockBackend: RenderBackend = {
  name: "mock",
  async start() {
    return { instanceId: rid("mock", 6), meta: { note: "simulated render" } };
  },
  async poll() {
    return "running";
  },
  async destroy() {
    return 0;
  },
};
