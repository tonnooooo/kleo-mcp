/**
 * The bindings and settings of the kleo-studio Worker (wrangler.studio.jsonc). It shares the MCP server's D1
 * database (users, credits, payments, audit) and R2 bucket, so a credit bought anywhere is spendable everywhere.
 */
export interface StudioEnv {
  DB: D1Database;
  /** Workers AI: checks that a viral template's photo shows a real person before any charge (src/studio/person-check.ts). */
  AI?: Ai;
  RENDERS: R2Bucket;
  ASSETS: Fetcher;
  /** The MCP Worker (service binding): Kleo films are ordered there (src/studio-film.ts). */
  MCP?: Fetcher;
  /** Same value as the MCP server's: it signs sessions, links and verifies a pasted Kleo key. */
  INTERNAL_SECRET: string;
  EPHONE_API_KEY?: string;
  EPHONE_API_URL?: string;
  /** ePhone's CONSOLE access token and the account's user id (23 October 2026): the API key above cannot read the
   *  account's balance ("This is an API key (sk-...) for model calls, not a console access token"); these can, through
   *  /api/user/self (src/studio/providers.ts readBalance). Secrets. */
  EPHONE_ACCESS_TOKEN?: string;
  EPHONE_USER_ID?: string;
  /** ePhone's admin key ("sk-admin-…", scope account:read only): reads the account balance with nothing else allowed.
   *  Preferred over the console token above. Secret. */
  EPHONE_ADMIN_KEY?: string;
  /** WaveSpeed AI (src/wavespeed.ts): the viral templates' Wan 3.0 video edit, and the backup of GPT Image 2.5 and
   *  Character Swap's first frame when ePhone cannot take an order (src/studio/backups.ts). */
  WAVESPEED_API_KEY?: string;
  /** APIMart (src/apimart.ts): the backup of most models when ePhone cannot take an order (src/studio/backups.ts). */
  APIMART_API_KEY?: string;
  /** "off" keeps every order on ePhone, even when it is out of credit (default: backups on). */
  STUDIO_BACKUPS?: string;
  /** Where the owner's alerts go (src/studio/providers.ts): a send_email binding whose destination is verified in
   *  Email Routing, and that address (default kleooai@gmail.com, the only one verified on 23 October 2026). */
  OWNER_MAIL?: SendEmail;
  OWNER_MAIL_TO?: string;
  /** Cloudflare Email Sending (27 October 2026): the welcome e-mails from hello@kleooai.com to any address, the domain
   *  onboarded in Email Sending (src/studio/onboarding.ts). Before that it reaches only the verified Email Routing address. */
  EMAIL?: SendEmail;
  /** Welcome e-mails one UTC day may send (default 300) and one 5-minute tick (default 12). */
  STUDIO_MAIL_DAILY_CAP?: string;
  STUDIO_MAIL_PER_TICK?: string;
  /** Dollars under which a provider's balance warns the owner, e.g. "wavespeed:20,apimart:5" (defaults in providers.ts). */
  STUDIO_PROVIDER_LOW_USD?: string;
  /** Public address of the MCP server (for the "use Kleo in Claude/ChatGPT" line). */
  PUBLIC_URL: string;
  /** The one host of the app (kleooai.com); www. and app. hosts redirect to it. Empty: no redirect. */
  CANONICAL_HOST?: string;
  /** Videos and templates cost their credits times this, rounded up ("5/3": 6 credits become 10). src/studio/models.ts videoFactor. */
  STUDIO_VIDEO_FACTOR?: string;
  /** Public address of Studio itself, used when no request is at hand (cron). */
  STUDIO_URL?: string;
  STRIPE_LINK_5?: string;
  STRIPE_LINK_15?: string;
  STRIPE_LINK_40?: string;
  /** Monthly plans (src/plans.ts): JSON {"lite:month": "https://buy.stripe.com/…", "pro:year": …, "agency-620:month": …}. */
  STRIPE_PLAN_LINKS?: string;
  /** The restricted key the in-app Apple Pay / Google Pay button pays with (src/studio/pay.ts); secret. */
  STRIPE_SECRET_KEY?: string;
  /** The account's publishable key, for Stripe.js in the page (public). */
  STRIPE_PUBLISHABLE_KEY?: string;
  /** Credits a new Studio account starts with (default 5, the MCP server's FREE_CREDITS). */
  FREE_CREDITS?: string;
  MAX_NEW_USERS_PER_DAY?: string;
  MAX_NEW_USERS_PER_IP_DAY?: string;
  /** Models an account that never paid may use: comma separated keys or "*" (default "seedance-2.0-fast"). */
  STUDIO_FREE_MODELS?: string;
  /** Apps an account that never paid may use (default face-swap,outfit-swap,voice,music,sfx; "*" = all). */
  STUDIO_FREE_TOOLS?: string;
  /** Image models an account that never paid may use (default all but Nano Banana Pro). */
  STUDIO_FREE_IMAGE_MODELS?: string;
  /** Resend key and sender for the password-reset e-mail (src/email.ts); without the key, reset is by hand. */
  RESEND_API_KEY?: string;
  NOTIFY_FROM?: string;
  /** Price over cost (default 1.6). */
  STUDIO_MARGIN?: string;
  /** Hard ceiling on provider dollars Studio may commit in one UTC day (default 30). */
  STUDIO_DAILY_BUDGET_USD?: string;
  /** The part of that day accounts which never paid may use together (default 8): free credits cannot fill the day. */
  STUDIO_FREE_DAILY_BUDGET_USD?: string;
  /** Uploads one account may add in one UTC day (default 200 files, 2 GB). */
  STUDIO_UPLOADS_PER_DAY?: string;
  STUDIO_UPLOAD_MB_PER_DAY?: string;
  /** Clips one account may have generating at once (default 3). */
  STUDIO_MAX_RUNNING?: string;
  /** The chat model, an ePhone OpenAI-compatible model id (default claude-haiku-5-5). */
  STUDIO_AGENT_MODEL?: string;
  /** The fast model behind Enhance (default gpt-4.1-mini: ~1.7 s on ePhone). */
  STUDIO_ENHANCE_MODEL?: string;
  /** Agent messages one account may send in a UTC day (default 200). */
  STUDIO_AGENT_PER_DAY?: string;
  /** The owner's admin account ids, comma separated (src/studio/generate.ts isAdmin): every model, no limits. */
  STUDIO_ADMINS?: string;
  /** Picture models taken out of service for now (comma separated keys; src/studio/image-models.ts pausedImageModels). */
  STUDIO_PAUSED_IMAGE_MODELS?: string;
  /** Video resolutions an account that never paid may use (default "480p"; "*" for all). */
  STUDIO_FREE_RESOLUTIONS?: string;
  /** How new accounts are opened once Google is set: "google" (default, Google only) or "all" (e-mail too). */
  STUDIO_SIGNUP?: string;
  /** What the never-paid accounts opened from ONE address may spend together in a UTC day, in dollars (default 2). */
  STUDIO_FREE_PER_ADDRESS_DAY_USD?: string;
  /** One gift per person (src/abuse.ts): see src/env.ts. */
  MAX_GIFTS_PER_ADDRESS?: string;
  GIFT_WINDOW_DAYS?: string;
  MAX_ACCOUNTS_PER_ADDRESS?: string;
  ADDRESS_BLOCK_DAYS?: string;
  /** Google sign-in (OAuth client of type "Web application"); the button shows only when both are set. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Microsoft sign-in (Entra app registration, any account type, Web redirect /auth/microsoft/callback). */
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  /** Sign in with Apple: the Services ID (client id), the team id, and a Sign in with Apple key (its id and its .p8
   *  PEM, a secret); the button shows only when all four are set. Return URL: /auth/apple/callback. */
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  TURNSTILE_SITEKEY?: string;
  TURNSTILE_SECRET?: string;
  /** Workers rate limit on the sign-in routes (per hashed address). */
  AUTH_LIMIT?: RateLimit;
  /** A Cloudflare API token with Zone > Analytics > Read on kleooai.com (secret): the admin console's "Find the
   *  address" button reads the request logs of past sign-ins with it (src/studio/ip-lookup.ts). Unset: no button. */
  CF_ANALYTICS_TOKEN?: string;
  /** The kleooai.com zone those logs belong to (default the live zone's id). */
  CF_ZONE_ID?: string;
  /** The admin console's own host(s), comma separated (default admin.kleooai.com; src/studio/admin-host.ts). */
  ADMIN_HOST?: string;
  /** SHA-256 fingerprints (hex) of the client certificates that open the admin host; empty: nothing opens. */
  ADMIN_CERT_SHA256?: string;
}
