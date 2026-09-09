# Kleo MCP server

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that renders YouTube videos and Shorts. Users connect one URL to Claude, ChatGPT, Grok, Cursor or Claude Code and ask for a video in plain language; rendering happens on an ephemeral GPU (Vast.ai), the result comes back as a signed download link.

Runs entirely on Cloudflare (Workers + KV + D1 + R2 + Cron), free plan.

```
client (Claude…) ──OAuth 2.1──▶ /mcp  tools: list_templates · create_video · get_job · get_result · generate_thumbnail · cancel_job
                                │
                     D1 (users, credits, jobs)   KV (OAuth)   R2 (renders, 7-day links)
                                │  cron every minute: start queued jobs, watch running ones, purge expired files
                                ▼
                     Vast.ai instance per job → worker/kleo_worker.py → uploads → POST /internal/jobs/:id/done → self-destroys
```

## Local development

```bash
npm install
npm run db:migrate:local
npm run dev                # http://localhost:8787  (RENDER_BACKEND=mock: simulated renders, no GPU)
npm run test:smoke         # full OAuth + MCP + render + download flow against a local dev server
```

Connect Claude Code to the local server: `claude mcp add --transport http kleo-local http://localhost:8787/mcp`, then `/mcp` → Kleo → Authenticate (invite code `KLEO-BETA` in dev).

## Deploy (first time)

```bash
npx wrangler login
npx wrangler kv namespace create OAUTH_KV        # paste id into wrangler.jsonc
npx wrangler d1 create kleo-db                  # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create kleo-renders
npm run db:migrate
npx wrangler secret put INTERNAL_SECRET          # long random string
npx wrangler secret put INVITE_CODES             # e.g. KLEO-BETA,CRISTIANO-1
# set PUBLIC_URL in wrangler.jsonc to the final https URL (workers.dev or custom domain)
npm run deploy
```

Switch to real GPUs: build and push `worker/Dockerfile`, set `VAST_IMAGE`, `npx wrangler secret put VAST_API_KEY`, set `RENDER_BACKEND` to `vast`.

## Safety rails

Credits are debited when a job is queued; at most `MAX_JOBS_PER_USER` open jobs per account and `MAX_CONCURRENT_GPUS` instances in total; every job has a hard `JOB_TIMEOUT_MIN` after which the instance is destroyed; the worker carries its own watchdog and destroys its instance with Vast's restricted `CONTAINER_API_KEY`; download links are HMAC-signed and expire with the files.
