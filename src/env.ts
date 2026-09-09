import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  DB: D1Database;
  RENDERS: R2Bucket;

  PUBLIC_URL: string;
  RENDER_BACKEND: "mock" | "vast";
  MAX_CONCURRENT_GPUS: string;
  MAX_JOBS_PER_USER: string;
  JOB_TIMEOUT_MIN: string;
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

  RESEND_API_KEY?: string;
  NOTIFY_FROM?: string;
}

/** What the OAuth provider stores in the token and hands back as ctx.props on /mcp. */
export interface AuthProps {
  userId: string;
  email: string;
}
