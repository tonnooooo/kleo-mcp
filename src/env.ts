import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  DB: D1Database;
  RENDERS?: R2Bucket; // optional: temporary accounts have no R2; files then go to KV (mock sizes only)
  AI?: Ai; // Workers AI (storyboard generation, scene pictures); absent in local dev without a login → fixtures

  IMAGE_MODEL_CARTOON?: string;   // Workers AI text-to-image model for the cartoon style (default images.ts DEFAULT_IMAGE_MODELS)
  IMAGE_MODEL_REALISTIC?: string; // idem for the realistic style
  // Pictures the SERVER draws with Workers AI per video; the rest is left to the GPU worker. Unset (or unreadable)
  // means 10; "0" is honoured and switches server-side drawing off entirely, leaving EVERY picture to the GPU worker.
  IMAGE_SERVER_MAX?: string;
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
  MAX_JOBS_PER_USER: string;   // videos one account may have open at the same time
  MAX_JOBS_PER_DAY?: string;   // videos one account may START in a UTC day (default 2): the open-jobs limit only counts concurrent ones
  QUEUE_MAX_WAIT_MIN?: string; // a job that never got a GPU in this many minutes fails and is refunded (default 180)
  DAILY_GPU_BUDGET_USD?: string; // hard ceiling on GPU dollars per UTC day (default 1.00); over it, rentals pause and jobs stay queued
  JOB_TIMEOUT_MIN: string;
  START_TIMEOUT_MIN?: string;
  LOADING_TIMEOUT_MIN?: string; // max minutes an instance may stay in "loading" (image pull) before it is destroyed // minutes a GPU may stay silent after rental before it is destroyed and the job requeued
  LOADING_RETRY_MIN?: string;   // minutes of image pull after which the job moves to another host (default 14)
  FREE_CREDITS: string;         // credits a brand-new anonymous account is given (1 credit = 1 Short)
  MAX_NEW_USERS_PER_DAY?: string; // new accounts created in a UTC day (default 25); past it the page says come back tomorrow
  MAX_NEW_USERS_PER_IP_DAY?: string; // new accounts in a UTC day from one hashed address (default 5), so 25 requests
                                     // from a single visitor cannot consume the whole day's allowance
  RESULT_TTL_DAYS: string;
  MOCK_TOTAL_SECONDS?: string;

  INTERNAL_SECRET: string;      // also signs the account handle (cookie + "Kleo key"): rotating it logs everybody out
  TURNSTILE_SITEKEY?: string;   // public key of the Cloudflare Turnstile widget (Phase 2; the sign-in page has no widget yet)
  TURNSTILE_SECRET?: string;    // Turnstile server key; while it is unset the bot check is skipped entirely (src/accounts.ts)
  SIGNUP_LIMIT?: RateLimit;     // optional Workers rate-limit binding on /authorize (config only, no external account)

  VAST_API_KEY?: string;
  VAST_IMAGE?: string;
  VAST_GPU_NAME?: string;
  VAST_MAX_DPH?: string;
  VAST_DISK_GB?: string;
  VAST_MIN_INET?: string;   // Mbit/s down the host must have (default 800): the image pull is the slowest part of a job
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
