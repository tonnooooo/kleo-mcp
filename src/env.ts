import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  DB: D1Database;
  RENDERS?: R2Bucket; // optional: temporary accounts have no R2; files then go to KV (mock sizes only)
  AI?: Ai; // Workers AI (storyboard generation, scene pictures); absent in local dev without a login → fixtures

  IMAGE_MODEL_CARTOON?: string;   // Workers AI text-to-image model for the cartoon style (default images.ts DEFAULT_IMAGE_MODELS)
  IMAGE_MODEL_REALISTIC?: string; // idem for the realistic style
  IMAGE_SERVER_MAX?: string;      // pictures the SERVER draws with Workers AI per video (default 10); the rest is left to the GPU worker
  IMAGE_MAX_PER_JOB?: string;     // legacy name of IMAGE_SERVER_MAX (still honoured by a deployed config)
  IMAGE_FIXTURE?: string;         // "1" (dev only): placeholder PNGs instead of Workers AI pictures

  AI_MODEL?: string; // default: storyboard.ts DEFAULT_MODEL
  STORYBOARD_FIXTURE?: string; // "example" (dev only): use the bundled cinema example instead of calling AI
  DEV_ROUTES?: string; // "1" enables GET /internal/dev/plan (bearer INTERNAL_SECRET)
  BRAND?: string; // on-screen brand handed to the render worker (default "Kleo")

  PUBLIC_URL: string;
  RENDER_BACKEND: "mock" | "vast" | "manual" | "pool";
  POOL_SECRET?: string;
  GITHUB_TOKEN?: string;     // fine-grained token (Actions: write on the repo) so the server can start a pool runner itself
  GITHUB_REPO?: string;      // owner/repo of the render-pool workflow (default tonnooooo/kleo-mcp)      // shared secret for external runners (GitHub Actions) that claim queued jobs
  POOL_AFTER_MIN?: string;   // in vast mode, runners may take a job that waited this long (default 3)
  VAST_RETRY_MIN?: string;   // after "no credit"/"no offer", leave Vast alone this long (default 30)
  MAX_CONCURRENT_GPUS: string;
  MAX_JOBS_PER_USER: string;
  JOB_TIMEOUT_MIN: string;
  START_TIMEOUT_MIN?: string;
  LOADING_TIMEOUT_MIN?: string; // max minutes an instance may stay in "loading" (image pull) before it is destroyed // minutes a GPU may stay silent after rental before it is destroyed and the job requeued
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
