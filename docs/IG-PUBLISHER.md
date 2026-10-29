# kleo-ig-publisher: @kleooai's reels at the chosen minute, at full quality

**Why (29 Oct 2026).** Every reel scheduled with Instagram's own scheduler, from instagram.com or from the phone app,
was stored at 720x1280: 6 of 6, read through media info (`original_width/height`), SHA-checked 1080x1920 files
included. The owner's reels published at once from the app are stored at 1080x1920. So this Worker publishes the reels
itself, at the chosen minute, through the official **Instagram API with Instagram Login** (`graph.instagram.com`,
v26.0). Neither Instagram's scheduler nor hand posting is needed.

Whether a reel published through the API keeps 1080p is **not documented**. The first real post settles it (see
"First post" below).

## Where it runs and why

A Cloudflare Worker of its own, `kleo-ig-publisher` (`wrangler.ig.jsonc`, code in `src/ig/`), with a Cron Trigger
every minute. It was picked over a GitHub Actions cron in `kleo-ads` for four reasons:

- **The minute.** Cron Triggers fire on the minute. GitHub's scheduled workflows are best effort: they often start
  5-30 minutes late and can be dropped under load.
- **The token.** A Worker keeps the renewed token in its own storage. An Action cannot rewrite its own repository
  secret without an admin token.
- **The files.** The Worker binds the R2 bucket `kleo-media` and reads the reel's moov box before Meta is asked to
  fetch it.
- **Workflow files and cost.** Claude's GitHub token cannot push workflow files (no `workflow` scope), so the owner
  would have to add the file by hand. A cron every few minutes would also burn the free Actions minutes of a private
  repository. The Worker cron is free inside Workers Paid.

It is deployed on its own: a release never touches `kleo-mcp` or `kleo-studio`. It has **no HTTP surface**:
workers.dev and preview URLs are off, and no route points to it. It shares D1 `kleo-db` in its own tables
(`ig_posts`, `ig_events`, `ig_token`), created on first use.

## How a post goes out

Each post is one entry. The `video` file lives on `media.kleooai.com` (R2 `kleo-media`). `at` is New Zealand time:

```json
{ "video": "https://media.kleooai.com/ig/2026-11-03-rx7-reveal-k2m4.mp4",
  "caption": "This RX-7 doesn't exist. #rx7 #jdm #aivideo #kleo",
  "at": "2026-11-03 13:30", "ai": true }
```

Optional fields:

- `cover`: a .jpg on `media.kleooai.com`.
- `thumb_offset_ms`: the cover frame, in milliseconds.
- `trial`: `MANUAL` or `SS_PERFORMANCE`, for a Trial Reel.
- `outside_window`: `true` only when the owner asked for a time outside the slot.
- `probe`: `false` skips Meta's probe (see `probing` below). It is on by default.
- `id`

The owner's side is `scripts/ig-schedule.mjs`. It runs on the PC with wrangler's own Cloudflare login, and it never
talks to Instagram or sees the token:

```
node scripts/ig-schedule.mjs upload reel.mp4 --check             # checks the MP4 against Meta's specification, uploads nothing
node scripts/ig-schedule.mjs upload reel.mp4 --name rx7-reveal   # checks it, uploads under a new name, prints the URL
node scripts/ig-schedule.mjs add entry.json --dry-run --offline  # the rules here + the exact request; no network at all
node scripts/ig-schedule.mjs add entry.json --dry-run            # the same, plus 3 hours from the schedule in D1; writes nothing
node scripts/ig-schedule.mjs add entry.json                      # queues it as 'new' and prints the cloud check and Meta's probe
node scripts/ig-schedule.mjs approve <id> --owner "sì"           # ONLY after the owner's "sì" for this one post
node scripts/ig-schedule.mjs list | show <id> | cancel <id> | recheck <id>
```

The worktrees have no `node_modules`. Set `KLEO_WRANGLER` to another checkout's
`node_modules/wrangler/bin/wrangler.js` for the commands that use D1 or R2; `upload --check` and
`add --dry-run --offline` need no wrangler.

Every minute the Worker moves each post one step (`src/ig/publisher.ts`):

| State | What happens |
|---|---|
| `new` | **The cloud check, which is the dry-run.** It covers:<br>- the entry's rules;<br>- the token and its account (must be @kleooai, a Creator or Business account);<br>- Meta's 24-hour quota;<br>- 3 hours from the account's real last posts (app, web or API) and from the schedule;<br>- the file in R2 and its moov box against Meta's Reels specification;<br>- the public address Meta will fetch;<br>- the exact `POST /<IG_ID>/media` body.<br>Only GET requests. Next state: `probing`, or `checked` without the probe, or `invalid`. |
| `probing` | **Meta's own verdict, without publishing.** A container is made from the very request. Meta fetches the file from `media.kleooai.com` and judges it and the parameters. It is polled like a real one and is **never given to `media_publish`**: it expires unpublished after 24 hours.<br>- `FINISHED` leads to `checked`.<br>- `ERROR` or a refusal leads to `invalid`, with Meta's own words.<br>- Still processing after 5 polls leads to `checked`, with a warning. |
| `checked` | Waits for the owner's "sì". `approve` stores his words and a hash of the post plus the file's R2 etag. 20 minutes before the time (`LEAD_MIN`), the check runs again. A post or file changed since the "sì" is refused. Then `POST /<IG_ID>/media` with `media_type=REELS`, `video_url`, `caption`, `share_to_feed=true`, `is_ai_generated=true`. |
| `container` | `GET /<container>?fields=status_code` once a minute. `FINISHED` leads to `ready`. `ERROR` or `EXPIRED` leads to `failed`. Still processing after 5 polls: one more container, then `failed`. Even then the e-mail arrives about 9 minutes before the time, so the owner can still post by hand. |
| `ready` | At the minute:<br>- `content_publishing_limit`;<br>- the account's last posts once more: a reel posted by hand since the last check stops this one, so there is never a double post;<br>- then `POST /<IG_ID>/media_publish`.<br>The media id and permalink go to `ig_events` and to the owner's e-mail. |
| `publishing` | Meta's answer was lost. The container's status decides: `PUBLISHED` means it is done, `FINISHED` means publish again (3 tries in all). It never publishes twice. |

More rules:

- A post that cannot go out within 15 minutes of its time becomes `missed`, never silently late.
- The owner gets an e-mail (alerts@kleooai.com to kleooai@gmail.com) when an approved post is published, failed, missed
  or refused at its last check.

**Rules kept** (`marketing/ACCOUNT_RULES.md`):

- at most 5 hashtags, none of #fyp or #viral (14);
- no engagement bait (15);
- at least 3 hours between posts (16);
- the US-evening slot, 12:00-17:00 NZDT, or 13:00-18:00 NZDT from 2 Nov (18): kept as 19:00-24:00 New York time, so it
  follows every clock change;
- the AI label on every post (19).

**Meta's limits:**

- 2,200 caption characters and 20 @mentions.
- Reels file: MP4 or MOV, moov at the front, H.264 or HEVC, 4:2:0, 23-60 fps, at most 1920 columns, at most 25 Mb/s,
  AAC at most 48 kHz, 3 s to 15 min, at most 300 MB. Edit lists and AAC over 128 kb/s are warnings.
- 100 API posts per 24 hours. Meta's pages also say 50 in places; the Worker reads the real number.
- **No licensed library music through the API.** A trend song can only be added in the app.

**The token** (`src/ig/token.ts`):

- The owner pastes it once into the secret `IG_ACCESS_TOKEN`.
- Every 7 days the Worker renews it (`refresh_access_token`) and keeps the new one in D1, sealed with AES-GCM under
  `IG_TOKEN_KEY`.
- A token pasted again wins over the renewed one.
- If renewing keeps failing, the owner gets an e-mail 10 days before the token dies.
- The token is never in a URL (Authorization header), a row, an event, a log line or an e-mail. The tests check all
  five.

## Deploy (after the owner's "sì" and the merge)

1. Put a detached worktree on `origin/main` and check that `git diff --stat HEAD origin/main` is empty. See the
   memories "deploy only from main" and "colon files".
2. `npx wrangler deploy --config wrangler.ig.jsonc --message "main <sha>"`
3. Set the sealing key once. It is random and never printed:
   `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put IG_TOKEN_KEY --config wrangler.ig.jsonc`
4. The owner's steps below.
5. Make a test entry and run `add`, with the probe on. The cloud check must report `@kleooai`, and Meta's probe must
   come back `FINISHED`. Nothing is published.

With no token, the Worker does nothing but write "No Instagram token yet" into the check of any post that is added.

Checked on 30 Oct 2026: `media.kleooai.com` serves its files to Meta's fetchers (`facebookexternalhit/1.1` and
`meta-externalagent/1.1`) with `206 video/mp4` and no Cloudflare challenge. The probe confirms it from Meta's own
servers on the first post.

## First post: the 1080p question

After the first real post the owner approves:

1. Read its stored size in the owner's Chrome, signed in to Instagram:
   `GET https://www.instagram.com/api/v1/media/<media_id>/info/` with the header `X-IG-App-ID: 936619743392459`.
   `<media_id>` is Instagram's own numeric id, not the Graph API's: decode the permalink's shortcode (base64url
   alphabet `A-Z a-z 0-9 - _`, most significant character first).
2. `original_width/height` 1080x1920 means the API keeps full quality. 720x1280 means it does not: say so plainly.
3. Also open the permalink signed out, to confirm a Development-mode app's post is public.

## Passi del proprietario (una volta sola, circa 15 minuti)

Solo tu puoi farli: entrare in Meta e accettare i termini. Il passo 5 si fa dopo che il Worker è online (lo metto online
io dopo il tuo "sì").

1. Vai su **developers.facebook.com** ed entra con il tuo Facebook. Se te lo chiede, registrati come sviluppatore e
   accetta i termini di Meta.
2. **Le mie app → Crea app.** Caso d'uso: **"Gestisci messaggi e contenuti su Instagram"** (Instagram API). Tipo:
   **Business**. Nome: **Kleo Publisher**. Crea.
3. Nell'app apri **Instagram → Configurazione API con login Instagram** (API setup with Instagram login). Poi
   **Genera token di accesso → Aggiungi account**. Entra come **@kleooai** e accetta i permessi
   (`instagram_business_basic`, `instagram_business_content_publish`).
   - Se dice che l'account non ha un ruolo: **Ruoli dell'app → Ruoli → Aggiungi persone → Tester Instagram →
     kleooai**. Poi su Instagram: **Impostazioni → App e siti web → Inviti tester → Accetta**. Riprova.
   - Se ancora rifiuta: in **Impostazioni app → Di base** metti la privacy policy `https://kleooai.com/privacy` e una
     categoria, poi passa l'app in **Live**.
   - Altrimenti lasciala in **Sviluppo**: serve solo al tuo account, senza App Review.
4. Clicca **Genera token** accanto a @kleooai e **copialo subito** (si vede una volta sola). Annota anche il **numero
   dell'account** (ID) mostrato lì.
5. Vai su **dash.cloudflare.com**, account **Plural Juice**. Apri **Workers e Pages → kleo-ig-publisher →
   Impostazioni → Variabili e segreti → Aggiungi**:
   - Tipo **Segreto**, nome `IG_ACCESS_TOKEN`, valore: il token.
   - Tipo **Segreto**, nome `IG_USER_ID`, valore: l'ID dell'account.

   Poi **Distribuisci**. **Non incollare mai il token in chat.**
6. Scrivimi **"fatto"**. Faccio il dry-run sul primo reel e ti chiedo il **"sì"** prima di pubblicarlo.

Il token dura 60 giorni e il Worker lo rinnova da solo ogni settimana. Se un giorno smette di funzionare, ti arriva una
mail 10 giorni prima: rifai solo i passi 4 e 5.
