# Kleo: messa online, passo per passo

*Per te, in italiano. Aggiornato al 10 settembre 2026.*

## Stato (10 settembre 2026)

Kleo è online e produce video veri. **La produzione usa GPU a pagamento: ogni video creato sul server pubblico noleggia una macchina su Vast.ai.** Per provare gratis usa il server locale (sezione 6).

| Cosa | Dove / valore | Stato |
|---|---|---|
| Sito | https://tonnooooo.github.io/kleo-site/ | online (GitHub Pages); legge l'indirizzo MCP da `config.json` |
| Server MCP | https://kleo-mcp.plural-juice.workers.dev/mcp | online, permanente, account Cloudflare "Plural Juice" (`e4a5a1308df5b44c65497b85210c6845`) |
| Render | `RENDER_BACKEND=vast` | GPU vere su Vast.ai: RTX 4090, massimo 0,60 $/h, almeno 16 core e 32 GB di RAM |
| Immagine del worker | `ghcr.io/tonnooooo/kleo-worker:keou` (pubblica) | motore Keou, Chromium, ffmpeg, voci Kokoro, whisper e i due modelli Stable Diffusion per le immagini (cartoon: Dreamshaper-8, realistico: Realistic Vision 5.1) già dentro (~15 GB); la costruisce GitHub Actions (`worker-image.yml`) a ogni modifica di `worker/` |
| Riserva gratuita | GitHub Actions `render-pool.yml`, ogni 5 minuti | prende i video che Vast non riesce ad avviare (credito finito, nessuna offerta) dopo `POOL_AFTER_MIN` minuti; richiede il segreto `POOL_SECRET` sul Worker e `KLEO_API` + `KLEO_POOL_SECRET` nel repository GitHub |
| Storyboard | scritto dall'assistente dell'utente con `kleo_storyboard_guide` (preferito, gratis) oppure da Workers AI (`AI_MODEL` llama-4-scout) | la quota gratuita di Workers AI (10k neuroni/giorno) finisce presto: quando è in pausa `kleo_create_video` chiede all'assistente di scrivere lo storyboard |
| Stili | `kleo_style`: `cartoon`, `realistic` (stile motore **picture**), `cyber` (look Keou originale), `stickman` | cartoon e realistic non usano piu' l'impaginazione cyber: ogni scena e' fatta di 1-4 **shot**, inquadrature con una immagine ciascuna che si tagliano sulla parola giusta della voce, con Ken Burns, dissolvenza corta tra shot e stacco netto tra scene. Nessuna icona, nessun HUD. Tipografia dedicata (Baloo 2 cartoon, Oswald realistico) e sottotitoli karaoke. Specifica: `docs/PICTURE-STYLE.md` |
| Immagini | fino a 24 per Short (48 per i video lunghi), id `<scena>-s<n>` | le disegna prima Workers AI (massimo `IMAGE_SERVER_MAX`=10 per video, quota giornaliera limitata) e tutte le altre la GPU noleggiata (`worker/kleo_pictures.py`: Dreamshaper-8 cartoon, Realistic Vision realistico; circa 6 s a immagine su RTX 3060) |
| Database D1 `kleo-db` · KV `OAUTH_KV` · R2 `kleo-renders` | stesso account | attivi; file cancellati dopo 7 giorni |
| Cron ogni minuto | attivo | orchestratore: storyboard, noleggio GPU, controllo dei render, pulizia |
| Segreti Cloudflare | `INTERNAL_SECRET`, `INVITE_CODES`, `VAST_API_KEY`, `POOL_SECRET` | caricati (copia in `.secrets.local`, fuori da git); manca `GITHUB_TOKEN` (token fine-grained, Actions read/write su kleo-mcp) per far partire la riserva gratuita dal server |
| Codici invito | `KLEO-BETA` (condiviso, 50 usi) · `MARCO-1`, `CRISTIANO-1` (personali) | 10 crediti di prova ciascuno |
| Crediti | 1 per uno Short (fino a 90 s) · 3 per un video fino a 5 minuti · +1 per ogni minuto in più | scalati alla messa in coda; restituiti se il video fallisce o viene annullato |
| Strumenti MCP | 7 (elenco in `docs/MCP-GUIDA.md`, sezione 4) | `kleo_generate_thumbnail` non è ancora attivo: risponde con un avviso, ogni video ha già la sua thumbnail |
| Test | sezione 6 | 93 test Node + 48 Python + `tsc`, eseguiti **sulla macchina noleggiata**, mai sul computer di casa (`python3 scripts/devbox.py up / sync / run "..."`, circa 0,10 $/h). Prova visiva rapida di uno stile senza server: `python3 scripts/devrender.py test/fixtures/cartoon-pirates.json` sulla stessa macchina. Prova di produzione: `node test/vast-e2e.mjs` |

Tempi reali misurati il 10 settembre su Vast (RTX 4090, 16+ core): Short di 40 s pronto in 5–6 minuti dal noleggio (se la macchina deve ancora scaricare l'immagine da 15 GB si aggiungono 3–8 minuti); un video lungo fino a circa un'ora. Risoluzione: 2160×3840 (4K) per i 9:16, 1920×1080 (Full HD) per i 16:9, sempre 60 fps, H.264 con audio AAC, più sottotitoli `.srt` e thumbnail.

Da controllare, una volta: il codice `KLEO-BETA` sta nella tabella `invites` del database, che nasce con **3** crediti (migrazione `0001`), mentre i 10 crediti di `FREE_CREDITS` valgono per i codici del segreto `INVITE_CODES` che non stanno in tabella. Perché anche `KLEO-BETA` dia 10 crediti: `npx wrangler d1 execute kleo-db --remote --command "UPDATE invites SET credits=10 WHERE code='KLEO-BETA'"`.

Cosa manca ancora: l'email a fine render (`notify_email`) non parte perché `RESEND_API_KEY` non è impostata; le thumbnail alternative; il modulo "lista d'attesa" del sito salva l'email solo nel browser di chi la scrive.

## 1. La decisione: tutto su Cloudflare, nessuna macchina virtuale, zero euro fissi

Oracle Always Free non era adatto (quota dimezzata a giugno 2026, capacità spesso assente, istanze inattive spente, registrazione che fallisce). Se un giorno servirà una macchina, la scelta è Hetzner (6 € al mese). Oggi non serve: **il server MCP gira come Cloudflare Worker**, con database D1, storage R2, KV per i token OAuth, Workers AI per lo storyboard e un cron ogni minuto per l'orchestratore. Tutto nel piano gratuito (100 000 richieste al giorno). Il sito statico sta su GitHub Pages, gratis. Si paga solo la GPU, per i minuti in cui lavora (uno Short costa circa 10–20 centesimi di Vast).

## 2. Cosa c'è, file per file

| Cosa | Dove |
|---|---|
| Server MCP (strumenti, login, orchestratore, backend di render) | `src/` — `mcp.ts` strumenti, `auth.ts` pagina di accesso, `orchestrator.ts` cron, `backends/vast.ts` noleggio GPU, `storyboard.ts` + `keou-contract.ts` storyboard e validatore, `templates.ts` template, crediti e stime |
| Configurazione di produzione, con ogni variabile spiegata | `wrangler.jsonc` |
| Valori solo per il computer locale | `.dev.vars` (fuori da git) |
| Worker che gira dentro la GPU + motore Keou | `worker/kleo_worker.py`, `worker/keou/`, `worker/Dockerfile.keou`, `worker/README-keou.md` |
| Costruzione dell'immagine e riserva gratuita | `.github/workflows/worker-image.yml`, `.github/workflows/render-pool.yml` |
| Migrazioni del database | `migrations/` (`npm run db:migrate` in produzione, `npm run db:migrate:local` in locale) |
| Test | `test/` (sezione 6) |
| Sito | repository `kleo-site`: `index.html` + `config.json` (indirizzo MCP e nota mostrata sopra le schede "Connect") |
| Guida ai client e agli strumenti | `docs/MCP-GUIDA.md` |

## 3. Account e login (fatto)

Non creo account e non gestisco password. L'account Cloudflare è il tuo ("Plural Juice"), collegato con `npx wrangler login`; il repository GitHub è `tonnooooo/kleo-mcp`. Se cambi computer: `npx wrangler login` di nuovo, oppure un API token (My Profile → API Tokens → modello "Edit Cloudflare Workers" con D1, KV e R2) nella variabile `CLOUDFLARE_API_TOKEN`.

## 4. Installazione su Cloudflare (fatta; per rifarla da zero)

```bash
bash scripts/finish-install.sh https://kleo-mcp.plural-juice.workers.dev
```

Lo script crea KV, D1 e R2 se mancano, scrive gli id in `wrangler.jsonc`, applica le migrazioni, carica `INTERNAL_SECRET` e `INVITE_CODES` da `.secrets.local` e fa il deploy. La chiave Vast va caricata a parte: `npx wrangler secret put VAST_API_KEY` (la incolli tu nel terminale, non in chat; consiglio una chiave "Instance management only"). Per un aggiornamento normale basta `npm run deploy`.

Codici invito personali: `npx wrangler d1 execute kleo-db --remote --command "INSERT INTO invites (code,credits,max_uses,note) VALUES ('NOME-1',10,1,'Nome')"`. In alternativa aggiungili al segreto `INVITE_CODES` (separati da virgola): quelli ricevono `FREE_CREDITS` crediti.

## 5. GPU vere: come funzionano, come spegnerle, la riserva gratuita

Ogni video: l'orchestratore scrive lo storyboard (Workers AI, oppure lo ha già scritto l'assistente), cerca su Vast.ai una RTX 4090 sotto 0,60 $/h con almeno 16 core e 32 GB di RAM, noleggia la macchina con l'immagine `ghcr.io/tonnooooo/kleo-worker:keou`, le passa l'indirizzo del server e un segreto valido solo per quel video. Il worker rende, carica MP4, `.srt` e thumbnail, segna il video come pronto e distrugge la macchina.

Protezioni attive: massimo 5 GPU accese in totale (`MAX_CONCURRENT_GPUS`) e 2 video in corso per utente; ogni macchina viene distrutta dopo 120 minuti in ogni caso (`JOB_TIMEOUT_MIN`), sia dal server sia da un timer dentro il container; una macchina che non dà segni di vita entro 15 minuti dal noleggio viene distrutta e il video rimesso in coda; i crediti si scalano alla messa in coda e tornano indietro se il video fallisce; i link scadono con i file dopo 7 giorni.

**Spegnere le GPU** (per una demo gratuita o se il credito Vast è finito): in `wrangler.jsonc` metti `"RENDER_BACKEND": "mock"` e `npm run deploy`. In modalità mock il render finisce in un minuto con file segnaposto e il server lo dice chiaramente a ogni assistente collegato. Per riaccenderle: `"vast"` e deploy.

**Riserva gratuita** (`render-pool.yml`): ogni 5 minuti un runner di GitHub Actions chiede a Kleo un video che Vast non ha avviato (credito finito, nessuna offerta) e lo rende con la stessa immagine, gratis ma più lento (CPU sola, immagine da scaricare ogni volta). Per attivarla: `npx wrangler secret put POOL_SECRET` con una stringa lunga, e nel repository GitHub la variabile `KLEO_API` (= `https://kleo-mcp.plural-juice.workers.dev`) e il segreto `KLEO_POOL_SECRET` (stessa stringa). Con `RENDER_BACKEND=pool` la riserva diventa l'unico modo di rendere: zero costi, tempi lunghi.

Credito Vast: si ricarica su console.vast.ai; con il credito a zero i video restano in coda (e la riserva gratuita, se attiva, li prende).

## 6. Provare in locale, gratis

```bash
cd kleo-mcp
npm install
npm run db:migrate:local
npm run dev                 # http://localhost:8787 — render simulati, storyboard d'esempio, nessuna GPU
npm run test:smoke          # l'intero giro in circa 40 secondi: login, strumenti, coda, render simulato, download, annullamento con rimborso
node --test test/keou-contract.test.mjs test/storyboard.test.mjs   # test unitari, senza rete
node test/worker-e2e.mjs    # render vero con il motore Keou dentro il container (podman, ~5 minuti, senza GPU)
node test/vast-e2e.mjs      # un video vero di 20 s su Vast.ai: costa qualche centesimo, leggi l'intestazione del file prima
```

Da Claude Code sul tuo computer: `claude mcp add --transport http kleo-local http://localhost:8787/mcp`, poi `/mcp` → Kleo → Authenticate, email qualsiasi e codice `KLEO-BETA`.

Per provare da Claude.ai, ChatGPT o Grok serve un indirizzo HTTPS pubblico: il server di produzione (a pagamento) oppure, per un test di un'ora, un tunnel temporaneo `cloudflared tunnel --url http://localhost:8787` che dà un URL `trycloudflare.com` senza account.

## 7. Aggiornare il worker (immagine Docker)

Non serve costruire nulla sul tuo computer. Ogni push su `main` che tocca `worker/` fa partire `worker-image.yml` su GitHub Actions (circa 20–30 minuti): l'immagine finisce su `ghcr.io/tonnooooo/kleo-worker:keou` e il video successivo la usa. Si può lanciare anche a mano: GitHub → Actions → worker-image → Run workflow. Il pacchetto `kleo-worker` deve restare **pubblico** (GitHub → il tuo profilo → Packages → kleo-worker → Package settings → Change visibility), altrimenti Vast non può scaricarlo.

## 8. Se cambiamo nome

Nel server: `name` in `wrangler.jsonc` e in `src/mcp.ts` (il nome che i client mostrano), il titolo della pagina di accesso in `src/auth.ts`, i nomi delle risorse (`kleo-db`, `kleo-renders`) se vuoi. Nel sito: cerca e sostituisci "Kleo"/"kleo" in `index.html`; l'indirizzo del server si cambia solo in `config.json`. Nei repository: rinominali da GitHub, i link vecchi vengono reindirizzati; se cambia il nome dell'immagine, aggiorna `VAST_IMAGE` e i due workflow.
