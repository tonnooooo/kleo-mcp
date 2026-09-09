import type { Env } from "../env";
import type { RenderBackend } from "./types";
import { mockBackend } from "./mock";
import { vastBackend } from "./vast";
import { manualBackend } from "./manual";

export function getBackend(env: Env): RenderBackend {
  return env.RENDER_BACKEND === "vast" ? vastBackend : env.RENDER_BACKEND === "manual" ? manualBackend : mockBackend;
}
export function backendFor(env: Env, name: string | null): RenderBackend {
  return name === "vast" ? vastBackend : name === "mock" ? mockBackend : name === "manual" ? manualBackend : getBackend(env);
}
