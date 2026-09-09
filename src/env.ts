import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  DB: D1Database;
  RENDERS?: R2Bucket; // optional: temporary accounts have no R2; files then go to KV (mock sizes only)
  AI?: Ai; // Workers AI (storyboard generation); absent in local dev without a login → fixture

  AI_MODEL?: string; // default: storyboard.ts DEFAULT_MODEL
  STORYBOARD_FIXTURE?: string; // "example" (dev only): use the bundled cinema example instead of calling AI
  DEV_ROUTES?: string; // "1" enables GET /internal/dev/plan (bearer INTERNAL_SECRET)
  BRAND?: string; // on-screen brand handed to the render worker (default "Kleo")

  PUBLIC_URL: string;
  RENDER_BACKEND: "mock" | "vast" | "manual";
  MAX_CONCURRENT_GPUS: string;
  MAX_JOBS_PER_USER: string;
  JOB_TIMEOUT_MIN: string;
  START_TIMEOUT_MIN?: string; // minutes a GPU may stay silent after rental before it is destroyed and the job requeued
  FREE_CREDITS: string;
  RESULT_TTL_DAYS: string;
  MOCK_TOTAL_SECONDS?: string;

  INTERNAL_SECRET: string;
  INVITE_CODES?: string;

  VAST_API_KEY?: string;
  VAST_IMAGE?: string;
  VAST_GPU_NAME?: string;
  VAST_MAX_DPH?: string;
  VAST_DISK_GB?: string;
  VAST_MIN_CPU?: string;      // effective cores required (the Keou renderer is CPU-bound)
  VAST_MIN_RAM_GB?: string;
  VAST_BOOTSTRAP_URL?: string; // raw URL of worker/kleo_worker.py, for images that do not ship it

  RESEND_API_KEY?: string;
  NOTIFY_FROM?: string;
}

/** What the OAuth provider stores in the token and hands back as ctx.props on /mcp. */
export interface AuthProps {
  userId: string;
  email: string;
}
