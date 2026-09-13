# Kleo MCP server

Kleo is a remote [Model Context Protocol](https://modelcontextprotocol.io) server that renders YouTube videos and Shorts. A user connects one URL to Claude, ChatGPT, Grok, Claude Code, Cursor, VS Code, OpenCode or Gemini CLI, presses one button to get in (no email, no password, no invite code) and asks for a video in plain language. The render runs on a GPU machine rented for that job only (Vast.ai) with the Keou motion-design engine; the result comes back as signed download links (MP4, `.srt` subtitles, thumbnail) that last 7 days.

The server runs entirely on Cloudflare (Workers + KV + D1 + R2 + Workers AI + Cron), free plan. Production address: `https://kleo-mcp.plural-juice.workers.dev/mcp`. The public site (`../kleo-site`) reads that address from its `config.json`.

## Tools

| Tool | What it does |
|---|---|
| `kleo_list_templates` | The ten templates (format, length range, voices, credit cost) and the credits left on the account. |
| `kleo_storyboard_guide` | The storyboard format Kleo renders (styles, scene kinds, beats, icons, voices, rules) with examples, so the assistant can write an original storyboard. Optional: without one, Kleo plans the video from the prompt. |
| `kleo_create_video` | Queues a render from a template, a prompt and (optionally) a storyboard. Returns `job_id`, `eta_min` and the credits charged at once; nothing is charged on error. |
| `kleo_wait_for_video` | Waits (as long as the calling client allows: 45 s for ChatGPT/Grok, up to 5 min for OpenCode) and returns the links as soon as the video is ready, so the assistant keeps its spinner and delivers on its own. |
| `kleo_get_job` | State, current track, percent and minutes left; without `job_id`, the recent videos of the account. |
| `kleo_get_result` | Signed download links for a finished job. |
| `kleo_generate_thumbnail` | Not enabled yet in the beta (every render already includes a thumbnail): records the request and returns a notice. |
| `kleo_cancel_job` | Cancels a queued or running job and refunds the unused credits. |
| `kleo_account` | Credits left, the read-only link to the account page (`/credits`) and the "Kleo key" that carries the account to another browser. The link is safe to paste anywhere; the key is the account. |

Credits (`src/templates.ts`): the film is the one product, at 7 credits up to 90 s, 21 up to 5 minutes, +7 per extra minute (`tariffSentence()` is the sentence every page quotes). A new account starts with `FREE_FILMS` (1) films' worth of credits, computed from the film's price (`freeCreditsFor`), so the free tier follows the price instead of being a second number to keep in step. Accounts are anonymous: no email and no password, just an HMAC-signed handle (`src/accounts.ts`) kept in a cookie, which doubles as the pasteable "Kleo key". The D1 table `invites` survives only as an optional gift: a code typed into the collapsed field of the sign-in page adds credits on top of the free ones, and an unknown code never blocks anyone. Output: 2160×3840 for 9:16, 1920×1080 for 16:9, 60 fps, H.264 + AAC. A Short takes about 10–20 minutes including the machine boot; a long video takes proportionally longer, and the timeout a render is given follows the length it was quoted (`jobTimeoutMin`), never a flat number below it.

## How a job flows

```
client (Claude…) ──OAuth 2.1──▶ /mcp  (src/mcp.ts; login page in src/auth.ts)
                                │  D1: users, credits, gift codes, jobs, audit · KV: OAuth tokens · R2: rendered files
                                │  cron every minute (src/orchestrator.ts):
                                │    1. a storyboard for each queued job (Workers AI, src/storyboard.ts; validated by src/keou-contract.ts)
                                │    2. one Vast.ai instance per job (src/backends/vast.ts, image VAST_IMAGE)
                                │    3. watch running jobs, apply timeouts, purge expired files
                                ▼
                     Vast.ai instance → worker/kleo_worker.py (Keou engine) → uploads → POST /internal/jobs/:id/done → self-destroys
                     Free fallback: a GitHub Actions runner (.github/workflows/render-pool.yml) claims jobs that Vast could not start
                     (POST /internal/pool/claim with POOL_SECRET) and runs the same worker image.
```

Render backends (`RENDER_BACKEND`): `vast` (production: real GPUs, costs money), `mock` (simulated one-minute render with placeholder files, free; the server tells every client that renders are simulated), `pool` (only external runners), `manual` (a container you start by hand; used by `test/worker-e2e.mjs`).

## Worker image

`worker/Dockerfile.keou` builds `ghcr.io/tonnooooo/kleo-worker:keou` (about 11 GB: Keou engine, Chromium, Node, ffmpeg, Kokoro voices, faster-whisper). GitHub Actions (`.github/workflows/worker-image.yml`) builds and pushes it on every push to `main` that touches `worker/`, or by hand from the Actions tab. The package must stay public on ghcr.io so Vast.ai machines can pull it. Details: `worker/README-keou.md`.

## Local development

```bash
npm install
npm run db:migrate:local
npm run dev                # http://localhost:8787 with .dev.vars: simulated renders, no GPU, bundled storyboard (STORYBOARD_FIXTURE=example)
```

Connect Claude Code to the local server: `claude mcp add --transport http kleo-local http://localhost:8787/mcp`, then `/mcp` → Kleo → Authenticate and press the button; there is nothing to type.

## Tests

```bash
npm run test:smoke                                                  # starts its own wrangler dev on port 8799: OAuth, tools, queue, simulated render, signed download, cancel + refund
node --test test/keou-contract.test.mjs test/storyboard.test.mjs    # unit tests: storyboard validator and generator (offline, fake AI)
node --test test/accounts.test.mjs test/credits.test.mjs            # sign-in, signed handles, free credits, daily caps, credit lifecycle (offline, sqlite)
node test/worker-e2e.mjs                                            # real Keou render inside the container (podman, no GPU) against a local server in manual mode
node test/vast-e2e.mjs                                              # one real 20 s job on Vast.ai: costs a few cents, see the file header for the setup
npm run typecheck
```

## Deploy

Everything is provisioned: `npm run deploy` publishes `wrangler.jsonc` (every variable is explained there in a one-line comment). First-time setup, secrets and the step-by-step guide for the owner (Italian): `DEPLOY.md`. Secrets: `INTERNAL_SECRET`, `VAST_API_KEY` (set); `POOL_SECRET` (pool fallback); `RESEND_API_KEY` + `NOTIFY_FROM` (email notifications; not set, so `notify_email` is currently a no-op); `TURNSTILE_SECRET` (not set, so the bot check on the sign-in page is skipped). **`INTERNAL_SECRET` must never be rotated**: it signs the account handles as well as the download links, so a new value detaches every user from their credits.

To switch the GPUs off for a free demo, set `RENDER_BACKEND` to `mock` in `wrangler.jsonc` and deploy. To stop the spending right now, with no deploy: `POST /internal/admin/pause` with `Authorization: Bearer <INTERNAL_SECRET>` (`/internal/admin/resume` to start again). See DEPLOY.md section 5.

## Safety rails

Credits are debited when a job is queued and refunded on failure or cancellation; at most `MAX_JOBS_PER_USER` open jobs per account and `MAX_CONCURRENT_GPUS` instances in total; every job has a hard `JOB_TIMEOUT_MIN` after which the instance is destroyed, and a machine that stays silent for `START_TIMEOUT_MIN` after rental is destroyed and the job requeued; the worker carries its own watchdog and destroys its instance with Vast's restricted `CONTAINER_API_KEY`; after a "no credit / no offer" answer Vast is left alone for `VAST_RETRY_MIN`; download links are HMAC-signed and expire with the files; a prompt filter blocks forbidden content before any GPU money is spent.

Above all of those sits `DAILY_GPU_BUDGET_USD`: before renting anything, the orchestrator adds what today's rentals cost — finished, failed and cancelled alike, since `cost_usd` is written every time a machine is torn down — to what the paid machines running right now have already committed (each priced at `VAST_MAX_DPH` for its own timeout; free pool jobs commit nothing) and, over the ceiling, pauses rentals for an hour while the jobs keep their place in the queue. The figure is still an estimate: the price cap is an upper bound and the real number is the Vast.ai balance. New accounts are capped per day (`MAX_NEW_USERS_PER_DAY`) and per address per day (`MAX_NEW_USERS_PER_IP_DAY`, on a hash of the address), jobs per account per day (`MAX_JOBS_PER_DAY`, counting only the ones that were not refunded), and sign-in attempts per address per minute (the `SIGNUP_LIMIT` rate-limit binding, keyed on a hash of the address, never the address itself). Every limit runs inside the Worker and only on `/authorize`: never in front of `/mcp`, where a 403 or 429 breaks connectors before the application sees the request.

## Docs

- `DEPLOY.md` — current status, going live, day-to-day operations (Italian)
- `docs/MCP-GUIDA.md` — what MCP is, how each client connects, the seven tools (Italian)
- `docs/ARCHITETTURA.md` — the original feasibility analysis and architecture (Italian)
