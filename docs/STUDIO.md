# Kleo Studio

Kleo Studio is Kleo's consumer web app: a person signs in, chats with Kleo, attaches pictures and spends credits to
generate video clips. It sits next to the MCP server and does not replace it. One account, one balance and one
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

The tables are created on first use; `migrations/0017_studio.sql` holds the same SQL for the record.

## Demo

`https://app.kleooai.com/?demo=1` runs the whole page on fake data: no account, nothing charged, sample videos.

## Not done yet

- Password reset by e-mail (needs a sending service such as Resend). The sign-in page points to hello@kleooai.com.
- Image generation (the owner is deciding between Vast and a provider).
- Reference videos and audio for Seedance 2.5 (edit/extend a clip).
- A Stripe success URL that returns to Studio (today the Payment Links return where the owner configured them).
