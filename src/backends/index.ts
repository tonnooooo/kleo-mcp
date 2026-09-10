import type { Env } from "../env";
import type { RenderBackend } from "./types";
import { mockBackend } from "./mock";
import { vastBackend } from "./vast";
import { manualBackend } from "./manual";
import { poolBackend } from "./pool";

export function getBackend(env: Env): RenderBackend {
  return env.RENDER_BACKEND === "vast" ? vastBackend : env.RENDER_BACKEND === "manual" ? manualBackend : env.RENDER_BACKEND === "pool" ? poolBackend : mockBackend;
}
export function backendFor(env: Env, name: string | null): RenderBackend {
  return name === "vast" ? vastBackend : name === "mock" ? mockBackend : name === "manual" ? manualBackend : name === "pool" ? poolBackend : getBackend(env);
}
