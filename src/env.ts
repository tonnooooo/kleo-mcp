import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  DB: D1Database;
  RENDERS?: R2Bucket; // optional: temporary accounts have no R2; files then go to KV (mock sizes only)
  AI?: Ai; // Workers AI (storyboard generation, scene pictures); absent in local dev without a login → fixtures

  IMAGE_MODEL_ANIMATION?: string; // Workers AI text-to-image model for the animation look (falls back to the cartoon one)
  IMAGE_MODEL_CARTOON?: string;   // Workers AI text-to-image model for the cartoon style (default images.ts DEFAULT_IMAGE_MODELS)
  IMAGE_MODEL_REALISTIC?: string; // idem for the realistic style
  // Pictures the SERVER draws with Workers AI per video; the rest is left to the GPU worker. Unset (or unreadable)
  // means 10; "0" is honoured and switches server-side drawing off entirely, leaving EVERY picture to the GPU worker.
  IMAGE_SERVER_MAX?: string;
  IMAGE_MAX_PER_JOB?: string;     // legacy name of IMAGE_SERVER_MAX (still honoured by a deployed config)
  IMAGE_FIXTURE?: string;         // "1" (dev only): placeholder PNGs instead of Workers AI pictures

  AI_MODEL?: string; // default: storyboard.ts DEFAULT_MODEL
  /**
   * THE FIDELITY ENGINE (24 September 2026, docs/FEDELTA.md). STILLS_ENGINE "flux2" (default) draws every still on the
   * server with STILL_MODEL, the cast's reference sheets as input images, and has each one judged by VISION_MODEL
   * against the spec before any GPU is rented (src/stills.ts); "legacy" leaves the stills to the rented GPU (SDXL).
   */
  STILLS_ENGINE?: string;
  /** Workers AI model that draws the stills (default @cf/black-forest-labs/flux-2-klein-9b: long prompts, up to 4 reference images). */
  STILL_MODEL?: string;
  /** Draws per still before the best one is kept (default 3). */
  STILL_ATTEMPTS?: string;
  /** Weighted pass rate a still needs, with no must check failed, to be accepted at once (default 0.85). */
  STILL_PASS?: string;
  /** Workers AI vision model that judges the stills and describes reference images (src/vision.ts DEFAULT_VISION_MODEL). */
  VISION_MODEL?: string;
  /** The model that writes the SPEC (src/spec.ts) on the server; unset = the planning model. */
  SPEC_MODEL?: string;
  /** The model that judges a planned storyboard against the spec (src/fidelity.ts); unset = the planning model. */
  JUDGE_MODEL?: string;
  /** Workers AI model the planner falls back to when the external road refuses (no credit, bad key): unset = AI_MODEL. */
  PLAN_FALLBACK_MODEL?: string;
  /** New reference pictures one account may have described per UTC day (src/mcp.ts REFS_MAX_PER_DAY, default 30). */
  REFS_MAX_PER_DAY?: string;
  /** Minutes one planning attempt may take (default 4, storyboard.ts PLAN_BUDGET_MS): a slower, better model needs more. */
  PLAN_BUDGET_MIN?: string;
  /** The model for every planning call when a road to it exists (PLAN_API_URL + PLAN_API_KEY, or ANTHROPIC_API_KEY for claude-…). */
  PLAN_MODEL?: string;
  /** An OpenAI-compatible endpoint base ("https://openrouter.ai/api/v1"): OpenRouter, OpenAI, DeepSeek, xAI, Mistral, Groq. */
  PLAN_API_URL?: string;
  /** Secret: the key for PLAN_API_URL. */
  PLAN_API_KEY?: string;
  /** Secret: the Anthropic API key, the direct road for a claude-… PLAN_MODEL (or the key of the proxy below). */
  ANTHROPIC_API_KEY?: string;
  /** A proxy that speaks the Anthropic Messages API (kie.ai: "https://api.kie.ai/claude"); unset = api.anthropic.com. */
  ANTHROPIC_BASE_URL?: string;
  /** "bearer" when the proxy wants the key as Authorization: Bearer (kie.ai); unset = x-api-key. */
  ANTHROPIC_AUTH?: string;
  /** The model that writes the TREATMENT (src/treatment.ts) when it should differ from AI_MODEL; unset = AI_MODEL. */
  TREATMENT_MODEL?: string;
  /** Treatments one account may ask kleo_adapt_prompt for in a UTC day (default 12): each one spends Workers AI quota. */
  ADAPT_MAX_PER_DAY?: string;
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
  MAX_CONCURRENT_VIDEO_GPUS?: string; // how many generated-video renders may run at once (default 1); see templates.ts isVideoStyle
  MAX_JOBS_PER_USER: string;   // videos one account may have open at the same time
  MAX_JOBS_PER_DAY?: string;   // videos one account may START in a UTC day (default 2): the open-jobs limit only counts concurrent ones
  QUEUE_MAX_WAIT_MIN?: string; // a job that never got a GPU in this many minutes fails and is refunded (default 180)
  DAILY_GPU_BUDGET_USD?: string; // hard ceiling on GPU dollars per UTC day (default 1.00); over it, rentals pause and jobs stay queued
  JOB_TIMEOUT_MIN: string;
  START_TIMEOUT_MIN?: string;
  RENDER_SILENCE_MIN?: string; // minutes a RENDERING worker may stay silent before the GPU is taken back (default 20)
  LOADING_TIMEOUT_MIN?: string; // max minutes an instance may stay in "loading" (image pull) before it is destroyed // minutes a GPU may stay silent after rental before it is destroyed and the job requeued
  LOADING_RETRY_MIN?: string;   // minutes of image pull after which the job moves to another host (default 14)
  FREE_CREDITS: string;         // credits given to a brand-new anonymous account (7): deliberately below the shortest film (10), so the gift needs the 5 EUR pack to become a film (templates.ts freeCreditsFor)
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
  VAST_MAX_DPH?: string;
  VAST_DISK_GB?: string;
  /** The generated-motion model the worker runs (KLEO_VIDEO_MODEL). Default Wan-AI/Wan2.2-TI2V-5B-Diffusers (32 GB card);
   *  Lightricks/LTX-2.5-Diffusers is the owner's choice of 13 September (80 GB card, 150 GB disk, gated: needs HF_TOKEN). */
  KLEO_VIDEO_MODEL?: string;
  /** Hugging Face token (secret) for gated video weights. Passed to the worker only; never logged. */
  HF_TOKEN?: string;
  /** Optional overrides for the video machine profile (see templates.ts VIDEO): VRAM floor and price ceiling. */
  VIDEO_MIN_VRAM_GB?: string;
  /** Disk for the finish box (default 40 GB: the image, the clips, the 4K film). */
  FINISH_DISK_GB?: string;
  VIDEO_MAX_DPH?: string;
  /** kie.ai (https://kie.ai): the clips of a filmed video come from its API instead of a model on the rented card.
   *  KIE_API_KEY is a Cloudflare SECRET (wrangler secret put): it never reaches the box, the audit or a job row. */
  KIE_API_KEY?: string;
  /** "kie" routes the clips through kie.ai (needs KIE_API_KEY); anything else, or unset, keeps the local model. */
  KLEO_FOOTAGE_BACKEND?: string;
  /** kie.ai model id for the clips (src/footage.ts KIE_MODELS); the admin route can override it without a deploy. */
  KLEO_FOOTAGE_MODEL?: string;
  /** A video longer than this (seconds) is NOT sent to kie.ai and takes the local road (default 20: the test cap). */
  KIE_MAX_VIDEO_S?: string;
  /** Hard ceiling on estimated kie.ai dollars per UTC day (default 5.00); over it the footage call refuses. */
  DAILY_FOOTAGE_BUDGET_USD?: string;
  /** The Suno version kie.ai's "ai-music-api/generate" is asked for (default V6; `duration` needs V5_5 or a V6): the user's optional music track (src/footage.ts). */
  KIE_MUSIC_VERSION?: string;
  /** "off" refuses every music order (the film is made without its track); anything else, or unset, orders it when KIE_API_KEY is set. */
  KLEO_MUSIC?: string;
  VAST_MIN_INET?: string;   // Mbit/s down the host must have (default 800): the image pull is the slowest part of a job
  VAST_GEO_EXCLUDE?: string; // country codes never rented, comma-separated (default "CN": ghcr.io crawls from there, 25+ min pulls)
  VAST_MIN_CPU?: string;      // effective cores required (the Keou renderer is CPU-bound)
  VAST_MIN_RAM_GB?: string;
  VAST_BOOTSTRAP_URL?: string; // raw URL of worker/kleo_worker.py, for images that do not ship it

  // Selling credits. All optional: without them sellingOpen() is false and the account page says "not open yet",
  // the same way notify.ts stays silent without RESEND_API_KEY. The secret is pasted by the owner into the
  // Cloudflare dashboard and never lives in a file.
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_LINK_5?: string;
  STRIPE_LINK_15?: string;
  STRIPE_LINK_40?: string;
  VAST_MIN_BALANCE_TO_SELL?: string; // dollars of Vast balance under which the buy buttons hide themselves (default 1.00); the webhook still honours anyone who already paid

  RESEND_API_KEY?: string;
  NOTIFY_FROM?: string;
}

/** What the OAuth provider stores in the token and hands back as ctx.props on /mcp. */
export interface AuthProps {
  userId: string;
  email: string;
}
