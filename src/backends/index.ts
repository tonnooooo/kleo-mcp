import type { Env } from "../env";
import type { RenderBackend } from "./types";
import { mockBackend } from "./mock";
import { vastBackend } from "./vast";

export function getBackend(env: Env): RenderBackend {
  return env.RENDER_BACKEND === "vast" ? vastBackend : mockBackend;
}
export function backendFor(env: Env, name: string | null): RenderBackend {
  return name === "vast" ? vastBackend : name === "mock" ? mockBackend : getBackend(env);
}
