# Kleo Studio

Kleo Studio is Kleo's consumer web app: a person signs in, chats with Kleo, attaches pictures and spends credits to
generate video clips and pictures. It sits next to the MCP server and does not replace it. One account, one balance and one
payment history work in both.

- Address: `https://app.kleooai.com` (custom domain set in `wrangler.studio.jsonc`; the workers.dev address is off).
- Code: `src/studio/` (Worker), `studio-web/` (the page), `wrangler.studio.jsonc` (config), `migrations/0017_studio.sql`.
- Tests: `test/studio-models.test.mjs` (pure parts) and `test/studio-worker.test.mjs` (the whole Worker on a fake D1,
  R2 and provider). They run on GitHub Actions with the rest of the suite.

## What a person can do

1. Sign up with an e-mail and password, with Google (once configured), or with the Kleo key of an existing MCP account.
   A new account gets `FREE_CREDITS` (5).
2. Chat with the agent (on by default). The agent answers in the person's language and shows a card with a polished
   prompt, a model, the settings and the price. Nothing is spent until the person taps **Generate** on the card.
   The card's prompt and settings can be edited first.
3. Or switch the agent off and send the prompt straight to the model with the chosen settings.
4. Attach up to 6 pictures. With one picture the clip starts from it (start frame) or uses it as a style reference
   (tap the label to switch). With several pictures they are references.
5. Watch the clip appear in the chat, then download, share (a 30-day link) or remix it. **My videos** lists every clip.
6. Buy credits through the same Stripe Payment Links as the MCP server (`client_reference_id` = the account id), so the
   existing webhook on the MCP server credits the account.

## Models and prices

All models are bought through ePhone AI's unified task API (`POST /v1/task/submit`, `GET /v1/task/{id}`).

| Key | Shown as | ePhone model | Durations | Resolutions | Credits (default clip) |
| --- | --- | --- | --- | --- | --- |
| `seedance-2.5` | Seedance 2.5 | `doubao-seedance-2-5-260628` | 5/10/15 s | 480p, 720p, 1080p | 4 (5 s 720p) |
| `seedance-2.0` | Seedance 2.0 | `doubao-seedance-2-0-260128` | 5/10/15 s | 480p, 720p, 1080p | 3 (5 s 720p) |
| `seedance-2.0-fast` | Seedance 2.0 Fast | `doubao-seedance-2-0-fast-260128` | 5/10/15 s | 480p, 720p | 2 (5 s 720p), 1 at 480p |
| `veo-3.1` | Google Veo 3.1 | `veo-3.1-generate-preview` | 4/6/8 s | 720p, 1080p | 7 (8 s) |
| `veo-3.1-fast` | Veo 3.1 Fast | `veo-3.1-fast-generate-preview` | 4/6/8 s | 720p, 1080p | 3 (8 s) |

Credits = `ceil(provider dollars × STUDIO_MARGIN / 0.44)`, at least 1. The provider dollars come from ePhone's public price
list read on 13 October 2026 (`src/studio/models.ts` has the per-second figures and the channel ratios). Veo is routed to
the `official_cheap` channel only; a Veo order that finds no such channel fails and is refunded.

**Free accounts** (no Stripe payment on record) can use only `STUDIO_FREE_MODELS` (default: Seedance 2.0 Fast). This is
the owner's rule of 15 September 2026: gifted credits must not buy the expensive models. The first pack unlocks all.

## Pictures

Same task API, one task per picture; a generation is a set of 1, 2 or 4 pictures (`slots` in `studio_generations`).

| Key | Shown as | ePhone model | Qualities | Credits (1 / 4 pictures) |
| --- | --- | --- | --- | --- |
| `nano-banana-pro` | Nano Banana Pro | `gemini-3-pro-image` | 1K, 2K, 4K | 1 / 2 |
| `nano-banana-2` | Nano Banana 2 | `gemini-3.1-flash-image` | 1K, 2K, 4K | 1 / 1 (4K ×4: 2) |
| `seedream-5` | Seedream 5.0 | `doubao-seedream-5-0-260128` | 2K | 1 / 1 |
| `flux-2-pro` | FLUX.2 Pro | `flux-2-pro` | 1K | 1 / 1 |

Gemini and FLUX go to the `official_cheap` channel only. Free accounts may use `STUDIO_FREE_IMAGE_MODELS` (all but Nano
Banana Pro). If some pictures of a set fail, the share of credits they stood for comes back (rounded down). Every
finished picture is also a `studio_uploads` row, so the page can animate it into a video (start frame) or use it as a
reference with one tap. The agent proposes pictures with a second tool, `propose_image`; the composer has a
Video / Image switch.

## The Kleo mark on free creations

Since 28 Oct 2026 every picture, clip and animatic an account that never paid makes carries "Made with Kleo"
(`studio-web/made-with-kleo.png`), so free creations shared online advertise Kleo. Any payment (a pack or a plan), an
admin and a Kleo Creators Pro partner see no mark; `STUDIO_WATERMARK=off` turns it off for everyone. Sounds are never
marked, nor the person's own uploads.

- The clean file is saved as before; a marked copy goes next to it (`<name>.mark.<ext>`). `/media/...` sends the marked
  copy while the owner still shows the mark, so the first purchase takes it off every picture and clip made before.
- Pictures: Cloudflare Images (`IMAGES` binding), 5,000 a month included, then $0.50 per 1,000.
- Clips: the `kleo-watermark` Worker (`watermark/`, ffmpeg in a Cloudflare Container, service binding `WATERMARK`):
  measured $0.000061 per 10 s 480p clip, $0.000125 at 720p, about 11,000 free clips a month inside the Workers Paid
  allowance; see `watermark/README.md` for the measurements and how to deploy it.
- Animatics (and the launch-code trial film) are 4K 60 fps, too big for the Container: kleo-mcp marks the job when it is
  ordered (`src/mark.ts`, `params.mark`, the same rule as Studio's) and the GPU box burns the mark into `video.mp4`
  before the upload (`worker/kleo_mark.py`, one libx264 pass, under a cent of box time), so Studio's copy, the MCP
  `/dl` links and the job-done e-mail all carry it. The mark is in the video for good: a purchase does not remove it.
- Providers read a person's files through `/media/raw/<upload>` (signed links only): always the clean file.
- Fails open: a file the mark could not be put on is served clean (`studio.mark_failed` in the audit). A picture with
  no marked copy (made before 29 Oct 2026, made while paying then refunded, or a failed mark) gets one the next time
  it is served; a miss is retried once an hour.
- Pictures over 20 MB cannot go through the Images binding, so a free account's "Rewrite and make it" on FLUX 3 runs
  at 2K at most, like Kleo's own FLUX 3 retries.

## Password reset

`POST /api/auth/forgot` mails a one-hour link (`/reset?t=<user>.<exp>.<sig>`, signed over the current password hash, so
it dies when the password changes); three mails per account per day; the same answer for unknown addresses. It needs
the `RESEND_API_KEY` secret and kleooai.com verified as a sending domain in Resend; until then the page sends people to
hello@kleooai.com.

## Money safety

- Credits are debited before the order and refunded once if the provider refuses or fails (compare-and-set on the clip
  row, so two polls never refund twice).
- `STUDIO_DAILY_BUDGET_USD` (default 30) caps the provider dollars Studio may commit in one UTC day.
- `STUDIO_MAX_RUNNING` (default 3) clips per account at the same time.
- An empty ePhone balance refuses the order and refunds at once ("Our video engine is being recharged").
- Every movement is in the `audit` table (`credits.debit`, `credits.refund`, `studio.create`, `studio.submitted`,
  `studio.done`, `studio.failed`, `studio.budget`).
- The cron (every minute) finishes, saves or refunds clips whose page was closed. A clip still with the provider after
  45 minutes is refunded.

## The agent

`src/studio/agent.ts`. An OpenAI-compatible chat model bought through ePhone (`STUDIO_AGENT_MODEL`, default
`claude-haiku-5-5`, a fraction of a cent per message) with one tool, `propose_video`. It sees attached pictures. If the
model cannot be reached, the person still gets a card made from their own words. `STUDIO_AGENT_PER_DAY` (200) messages
per account per day.

## Deploy

```bash
npx wrangler deploy --config wrangler.studio.jsonc
```

Secrets, once (`npx wrangler secret put NAME --config wrangler.studio.jsonc`):

- `INTERNAL_SECRET`: the same value as the MCP server's.
- `EPHONE_API_KEY`: the ePhone key.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (optional): Google Cloud Console → APIs & Services → Credentials → OAuth
  client ID → Web application, authorised redirect URI `https://app.kleooai.com/auth/google/callback`.
- `TURNSTILE_SECRET` (optional) with the `TURNSTILE_SITEKEY` var.

The tables are created on first use; `migrations/0017_studio.sql` and `0018_studio_images.sql` hold the same SQL for the
record and are already marked applied in production's `d1_migrations` (14 Oct 2026), so `migrations apply` skips them.

## Demo

`https://app.kleooai.com/?demo=1` runs the whole page on fake data: no account, nothing charged, sample videos.

## Not done yet

- Resend account (password-reset mails): code ready, secret not set.
- Google OAuth client: code ready, secrets not set.
- Reference videos and audio for Seedance 2.5 (edit/extend a clip).
- A Stripe success URL that returns to Studio (today the Payment Links return where the owner configured them).
