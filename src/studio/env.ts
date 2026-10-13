/**
 * The bindings and settings of the kleo-studio Worker (wrangler.studio.jsonc). It shares the MCP server's D1
 * database (users, credits, payments, audit) and R2 bucket, so a credit bought anywhere is spendable everywhere.
 */
export interface StudioEnv {
  DB: D1Database;
  RENDERS: R2Bucket;
  ASSETS: Fetcher;
  /** Same value as the MCP server's: it signs sessions, links and verifies a pasted Kleo key. */
  INTERNAL_SECRET: string;
  EPHONE_API_KEY?: string;
  EPHONE_API_URL?: string;
  /** Public address of the MCP server (for the "use Kleo in Claude/ChatGPT" line). */
  PUBLIC_URL: string;
  /** Public address of Studio itself, used when no request is at hand (cron). */
  STUDIO_URL?: string;
  STRIPE_LINK_5?: string;
  STRIPE_LINK_15?: string;
  STRIPE_LINK_40?: string;
  /** Credits a new Studio account starts with (default 5, the MCP server's FREE_CREDITS). */
  FREE_CREDITS?: string;
  MAX_NEW_USERS_PER_DAY?: string;
  MAX_NEW_USERS_PER_IP_DAY?: string;
  /** Models an account that never paid may use: comma separated keys or "*" (default "seedance-2.0-fast"). */
  STUDIO_FREE_MODELS?: string;
  /** Price over cost (default 1.6). */
  STUDIO_MARGIN?: string;
  /** Hard ceiling on provider dollars Studio may commit in one UTC day (default 30). */
  STUDIO_DAILY_BUDGET_USD?: string;
  /** Clips one account may have generating at once (default 3). */
  STUDIO_MAX_RUNNING?: string;
  /** The chat model, an ePhone OpenAI-compatible model id (default claude-haiku-5-5). */
  STUDIO_AGENT_MODEL?: string;
  /** Agent messages one account may send in a UTC day (default 200). */
  STUDIO_AGENT_PER_DAY?: string;
  /** Google sign-in (OAuth client of type "Web application"); the button shows only when both are set. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TURNSTILE_SITEKEY?: string;
  TURNSTILE_SECRET?: string;
  /** Workers rate limit on the sign-in routes (per hashed address). */
  AUTH_LIMIT?: RateLimit;
}
