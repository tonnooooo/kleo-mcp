# Kleo: messa online, passo per passo

*Per te, in italiano. Aggiornato all'11 settembre 2026.*

## Stato (11 settembre 2026)

Kleo è online e produce video veri. **La produzione usa GPU a pagamento: ogni video creato sul server pubblico noleggia una macchina su Vast.ai.** Per provare gratis usa il server locale (sezione 6).

| Cosa | Dove / valore | Stato |
|---|---|---|
| Sito | https://tonnooooo.github.io/kleo-site/ | online (GitHub Pages); legge l'indirizzo MCP da `config.json` |
| Server MCP | https://kleo-mcp.plural-juice.workers.dev/mcp | online, permanente, account Cloudflare "Plural Juice" (`e4a5a1308df5b44c65497b85210c6845`) |
| Render | `RENDER_BACKEND=vast` | GPU vere su Vast.ai: RTX 4090, massimo 0,40 $/h, almeno 16 core e 32 GB di RAM, con almeno 1200 Mbit/s in discesa (scaricare l'immagine era metà del conto). Un video cartoon/realistico ha bisogno per forza di una GPU (le immagini le disegna lei), quindi non passa mai alla riserva gratuita di GitHub: se Vast non ha offerte resta in coda e l'utente lo legge nel messaggio di stato |
| Immagine del worker | `ghcr.io/tonnooooo/kleo-worker:keou` (pubblica) | motore Keou, Chromium, ffmpeg, voci Kokoro, whisper e i due modelli Stable Diffusion per le immagini (cartoon: Dreamshaper-8, realistico: Realistic Vision 5.1) già dentro (~15 GB); la costruisce GitHub Actions (`worker-image.yml`) a ogni modifica di `worker/` |
| Riserva gratuita | GitHub Actions `render-pool.yml`, ogni 5 minuti | prende i video che Vast non riesce ad avviare (credito finito, nessuna offerta) dopo `POOL_AFTER_MIN` minuti; richiede il segreto `POOL_SECRET` sul Worker e `KLEO_API` + `KLEO_POOL_SECRET` nel repository GitHub |
| Storyboard | scritto dall'assistente dell'utente con `kleo_storyboard_guide` (preferito, gratis) oppure da Workers AI (`AI_MODEL` llama-4-scout) | la quota gratuita di Workers AI (10k neuroni/giorno) finisce presto: quando è in pausa `kleo_create_video` chiede all'assistente di scrivere lo storyboard |
| Treatment (adapt prompt, 14 set) | `kleo_adapt_prompt` → oggetto `treatment` → `kleo_create_video(treatment)`; senza, il pianificatore lo scrive da sé come passo -1 (`src/treatment.ts`, `docs/ADAPT-PROMPT.md`) | la richiesta dell'utente diventa il film che un producer ne farebbe (angolo, apertura, atti coi secondi, finale, mondo visivo, ritmo, narratore, motivi, e la lista delle decisioni prese da Kleo) PRIMA della direction; un dispositivo narrativo e un'apertura vengono estratti per ogni film dall'id del job, così la stessa richiesta non dà mai lo stesso film. ~170 neuroni a chiamata sul modello di produzione; tetto `ADAPT_MAX_PER_DAY` (12) per account; con la quota finita risponde onestamente. Qualità MISURATA il 13 set sul modello di produzione, prima e dopo la correzione del master prompt (tabella in docs/ADAPT-PROMPT.md §6: angolo = logline da 8/15 a 0, nomi da scaletta da 13/15 a 0, italiano in inglese da 6/6 a 0). Si rimisura senza PC con `POST /internal/admin/treatment` e `INTERNAL_SECRET` |
| Stili | `kleo_style`: `cartoon`, `realistic` (stile motore **picture**), `cyber` (look Keou originale), `stickman` | cartoon e realistic non usano piu' l'impaginazione cyber: ogni scena e' fatta di 1-4 **shot**, inquadrature con una immagine ciascuna che si tagliano sulla parola giusta della voce, con Ken Burns, dissolvenza corta tra shot e stacco netto tra scene. Nessuna icona, nessun HUD. Tipografia dedicata (Baloo 2 cartoon, Oswald realistico) e sottotitoli karaoke. Gli shot sono **1-4** su una scena cinema e **1-2** sulla scena di chiusura (`SHOTS_PER_SCENE`, di solito 2-3 e 1). Il campo `at` che decide il taglio deve essere un pezzo continuo della voce di quella scena, copiato lettera per lettera (punteggiatura compresa) e allineato a **parole intere**: "swam back" va bene, "wam bac" e "1720 Captain" (da "In 1720, Captain Mara") no. Questi stili hanno bisogno della GPU: la riserva gratuita non li prende mai, quindi durante un buco di Vast restano in coda e `kleo_get_job` / `kleo_wait_for_video` lo spiegano all'utente senza addebitare nulla in piu'. Specifica: `docs/PICTURE-STYLE.md` |
| Immagini | fino a 24 per Short (48 per i video lunghi), id `<scena>-s<n>` | oggi `IMAGE_SERVER_MAX=0`: le disegna **tutte la GPU noleggiata** (circa 0,004 $ per 24), così la quota gratuita giornaliera di Workers AI resta intera per gli storyboard, che è ciò che limita davvero quanti video Kleo sa progettare in un giorno (`worker/kleo_pictures.py`: Dreamshaper-8 cartoon, Realistic Vision realistico; circa 6 s a immagine su RTX 3060) |
| Database D1 `kleo-db` · KV `OAUTH_KV` · R2 `kleo-renders` | stesso account | attivi; file cancellati dopo 7 giorni |
| Cron ogni minuto | attivo | orchestratore: storyboard, noleggio GPU, controllo dei render, pulizia |
| Segreti Cloudflare | `INTERNAL_SECRET`, `VAST_API_KEY`, `POOL_SECRET`, `KIE_API_KEY` (13 set: le clip dei film da kie.ai, `docs/FOOTAGE-KIE.md`; finché manca, i film restano sul modello locale) | caricati (copia in `.secrets.local`, fuori da git); manca `GITHUB_TOKEN` (token fine-grained, Actions read/write su kleo-mcp) per far partire la riserva gratuita dal server. `INVITE_CODES` non serve più: si può cancellare con `npx wrangler secret delete INVITE_CODES` |
| Accesso | un solo bottone, nessun campo da scrivere | niente email, niente password, niente codice invito. L'account è anonimo e vive in un cookie firmato del browser; la stessa stringa è la "chiave Kleo" che lo riporta su un altro browser (il link alla pagina `/credits` invece è firmato in modo diverso: si può incollare ovunque, non fa entrare nessuno). I codici della tabella `invites` restano come **regalo** (crediti in più a chi ne scrive uno), mai come porta |
| Prova gratuita | `FREE_FILMS` = 1 per ogni nuovo account (dal 14 set) | Si conta in **film**, non in crediti: il server dà `FREE_FILMS × prezzo del film` (oggi 7) e se il prezzo cambia la prova segue da sola. Prima era `FREE_CREDITS` = 2 dai tempi degli Short a 1 credito: dopo il reset del 13 set non compravano niente e un nuovo utente veniva rimbalzato da "non bastano" a "pagamenti chiusi" (falso: i pacchetti Stripe erano già in vendita sulla pagina `/credits`). Ora `kleo_account`, la pagina di accesso e la pagina crediti leggono prezzo e stato dei pagamenti dal codice che li applica |
| Tetto di spesa | `DAILY_GPU_BUDGET_USD` = 1,00 $ al giorno | il vero muro: oltre quella cifra Kleo smette di noleggiare GPU per un'ora e i video restano in coda con una spiegazione onesta. È una STIMA: conta i noleggi finiti, quelli falliti e quelli annullati (il costo viene scritto ogni volta che una macchina viene spenta) più quelle accese in questo momento, valutate al prezzo massimo; la cifra vera resta il saldo su console.vast.ai |
| Limiti per abuso | 25 nuovi account al giorno (e al massimo 5 dallo stesso indirizzo, di cui si salva solo un'impronta) · 3 tentativi al minuto per indirizzo · 2 video al giorno e 1 alla volta per account, senza contare quelli falliti o annullati che sono stati rimborsati · massimo 2 GPU accese | tutti dentro il Worker e solo su `/authorize`: mai davanti a `/mcp`, altrimenti i client si rompono prima di arrivare al server |
| Crediti | 7 per un film fino a 90 s · 21 fino a 5 minuti · +7 per ogni minuto in più (`tariffSentence()` in `src/templates.ts`) | scalati alla messa in coda; restituiti **per intero** se il video fallisce, se resta in coda più di `QUEUE_MAX_WAIT_MIN` (3 ore) o se viene annullato prima di partire. Se lo si annulla a render iniziato torna indietro solo la parte non ancora renderizzata (`refundFor` in `src/jobs.ts`): uno Short annullato oltre il 50% non restituisce niente |
| Strumenti MCP | 9 (elenco in `docs/MCP-GUIDA.md`, sezione 4) | `kleo_generate_thumbnail` non è ancora attivo: risponde con un avviso, ogni video ha già la sua thumbnail |
| Test | sezione 6 | i test Node (`node --test test/`) + 48 Python + `tsc`, eseguiti **sulla macchina noleggiata**, mai sul computer di casa (`python3 scripts/devbox.py up / sync / run "..."`, circa 0,10 $/h). Prova visiva rapida di uno stile senza server: `python3 scripts/devrender.py test/fixtures/cartoon-pirates.json` sulla stessa macchina. Prova di produzione: `node test/vast-e2e.mjs` |

Tempi reali misurati il 10 settembre sulla catena di produzione (RTX 4090): Short cartoon di 40 secondi consegnato in 23 minuti dal noleggio, di cui 13 solo per scaricare l'immagine del worker, 29 secondi per disegnare 13 immagini sulla GPU e 8 minuti di render vero. Costo GPU: 0,067 $. Un video lungo richiede molto di più: il tempo massimo concesso a un render si alza da solo con la durata (stima del video + attesa massima per lo scaricamento dell'immagine, `src/templates.ts`), quindi circa 2 ore per un video di 8 minuti.

Fatto l'11 settembre 2026: il vecchio codice condiviso `KLEO-BETA` è spento sul database vivo (`max_uses = 0`, dopo 19 usi), applicando la migrazione `0005_kleo_beta_off.sql`. Erano circa 25 $ di crediti che nessuno controllava più. Resta un segreto che non si usa più e si può cancellare quando vuoi:

```bash
npx wrangler secret delete INVITE_CODES
```

I codici personali (`MARCO-1`, `CRISTIANO-1`) puoi lasciarli: ora valgono come regalo, cioè crediti **in più** ai 2 gratuiti per chi li scrive nel campo facoltativo della pagina di accesso.

Cosa manca ancora: l'email a fine render (`notify_email`) non parte perché `RESEND_API_KEY` non è impostata; le thumbnail alternative; i pagamenti con carta (la pagina `/credits` lo dice apertamente invece di far finta); il controllo anti-robot Turnstile sulla pagina di accesso (il codice c'è già ed è spento finché manca il segreto `TURNSTILE_SECRET`).

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
| Migrazioni del database | `migrations/` (`npm run db:migrate` in produzione, `npm run db:migrate:local` in locale). Questa versione ne aggiunge due: `0005` spegne il vecchio codice `KLEO-BETA` su un database nuovo, `0006` aggiunge la colonna `queued_at`. Vanno applicate **prima** del deploy |
| Test | `test/` (sezione 6) |
| Sito | repository `kleo-site`: `index.html` + `config.json` (indirizzo MCP e nota mostrata sopra le schede "Connect") |
| Guida ai client e agli strumenti | `docs/MCP-GUIDA.md` |

## 3. Account e login (fatto)

Non creo account e non gestisco password. L'account Cloudflare è il tuo ("Plural Juice"), collegato con `npx wrangler login`; il repository GitHub è `tonnooooo/kleo-mcp`. Se cambi computer: `npx wrangler login` di nuovo, oppure un API token (My Profile → API Tokens → modello "Edit Cloudflare Workers" con D1, KV e R2) nella variabile `CLOUDFLARE_API_TOKEN`.

## 4. Installazione su Cloudflare (fatta; per rifarla da zero)

```bash
bash scripts/finish-install.sh https://kleo-mcp.plural-juice.workers.dev
```

Lo script crea KV, D1 e R2 se mancano, scrive gli id in `wrangler.jsonc`, applica le migrazioni, carica `INTERNAL_SECRET` da `.secrets.local` e fa il deploy. **`INTERNAL_SECRET` non va mai cambiato**: oltre a firmare i link di download firma anche l'identità degli account anonimi, quindi un valore nuovo scollega tutti gli utenti dai loro crediti, senza modo di tornare indietro. La chiave Vast va caricata a parte: `npx wrangler secret put VAST_API_KEY` (la incolli tu nel terminale, non in chat; consiglio una chiave "Instance management only"). Per un aggiornamento normale basta `npm run deploy`.

**`wrangler deploy` impacchetta la cartella così com'è, non il commit.** Non guarda git: se un file è modificato e non ancora committato, quel file finisce in produzione lo stesso, e in produzione gira codice che non esiste in nessun commit — quindi nessuno può dire cosa sia vivo, e il deploy successivo da un albero pulito lo cancella senza che nessuno se ne accorga. Con più sessioni che lavorano sulla stessa cartella succede senza fare niente di sbagliato: basta che un'altra stia salvando un file nel momento in cui parte il deploy. Il rimedio è deployare da una copia pulita del ramo, che non può contenere il lavoro a metà di nessuno:

```bash
git fetch origin main
git worktree add --detach /tmp/kleo-deploy origin/main
ln -s "$PWD/node_modules" /tmp/kleo-deploy/node_modules
cd /tmp/kleo-deploy && npx wrangler deploy --message "origin/main $(git rev-parse --short HEAD)"
cd - && git worktree remove /tmp/kleo-deploy
```

Il `--message` finisce nella lista dei deploy (`npx wrangler deployments list`): scriverci dentro il commit è l'unico modo per sapere, mesi dopo, quale codice stava girando.

**Prima di deployare, guarda se la CI è verde su quel commit.** `tests.yml` gira su GitHub a ogni push, su qualunque ramo, e fa gli stessi tre controlli che altrimenti si pagano noleggiando una macchina: `tsc --noEmit`, i test Node e i test Python del worker. Costa zero e ci mette quaranta secondi.

```bash
gh run list --repo tonnooooo/kleo-mcp --branch main --workflow tests --limit 1
```

Se il commit che stai per deployare non è quello che la CI ha passato, la differenza si legge in una riga — e se sono solo documenti, la verifica vale lo stesso:

```bash
git diff --stat <commit-verde> <commit-da-deployare>
```

La macchina noleggiata serve solo per quello che la CI non può fare: un render vero, un'immagine disegnata davvero, il tempo che ci mette. Per i tipi e i test, noleggiare è buttare soldi.

**E lo stato dell'albero si legge in un comando che non spedisce niente.** Sembra ovvio e non lo è: la prima volta che questa regola è servita, `git status` e `wrangler deploy` erano nello stesso comando, quindi lo stato è arrivato sotto gli occhi *dopo* che il pacchetto era già partito. Un controllo che si legge dopo l'azione non è un controllo, è un referto.

```bash
git status --short && git log --oneline -1
```

Se stampa qualcosa che non è tuo, non deployare da lì: usa il worktree qui sopra.

**Kleo ha DUE canali che si aggiornano in momenti diversi, e il deploy ne muove uno solo.** Il deploy porta `src/` e `wrangler.jsonc` sul Worker; tutto ciò che sta in `worker/` — il motore che disegna, il validatore che gira sulla GPU, i modelli delle immagini — arriva solo quando GitHub ricostruisce l'immagine (`worker-image.yml`, circa sette minuti). Una riparazione in `worker/` non è viva dopo un deploy: è viva dopo una build riuscita.

E le build si annullano da sole: `worker-image.yml` cancella quella in corso quando arriva una spinta più recente, quindi nella lista si vedono `cancelled` che non sono guasti. Quello che conta non è l'ultima build, è **l'ultima build RIUSCITA, e se contiene il commit che ti interessa**:

```bash
gh run list --repo tonnooooo/kleo-mcp --workflow worker-image --limit 20 --json headSha,conclusion
git merge-base --is-ancestor <il tuo commit> <sha dell'ultima build riuscita> && echo DENTRO || echo FUORI
```

Un `FUORI` su una riparazione del motore significa che le GPU noleggiate da adesso in poi useranno ancora la versione vecchia, e nessun deploy lo cambierà.

**Una colonna nuova ha due copie, e l'ordine fra loro conta.** Ogni colonna aggiunta a `jobs` sta sia in `migrations/` sia in `ensureColumns` (`src/schema.ts`), che la ripara al primo avvio del Worker e ingoia il "duplicate column". Quindi se il Worker nuovo va in produzione **prima** di `npm run db:migrate`, il cron la crea entro un minuto e la migrazione poi fallisce per colonna duplicata (SQLite non ha `ADD COLUMN IF NOT EXISTS`). Ordine giusto: migrazione, poi deploy. Se è andata al contrario, la migrazione va segnata come applicata a mano invece di riscriverla:

```bash
npx wrangler d1 execute kleo-db --remote --command "INSERT INTO d1_migrations (name, applied_at) VALUES ('0010_plan_note.sql', CURRENT_TIMESTAMP)"
```

Codici regalo (facoltativi, non servono per entrare): `npx wrangler d1 execute kleo-db --remote --command "INSERT INTO invites (code,credits,max_uses,note) VALUES ('NOME-1',3,1,'Nome')"`. Chi scrive `NOME-1` nel campo facoltativo della pagina di accesso riceve quei crediti **in più** ai 2 gratuiti; chi non scrive niente entra lo stesso.

## 5. GPU vere: come funzionano, come spegnerle, la riserva gratuita

Ogni video: l'orchestratore scrive lo storyboard (Workers AI, oppure lo ha già scritto l'assistente), cerca su Vast.ai una RTX 4090 sotto 0,40 $/h con almeno 16 core, 32 GB di RAM e 1200 Mbit/s in discesa, noleggia la macchina con l'immagine `ghcr.io/tonnooooo/kleo-worker:keou`, le passa l'indirizzo del server e un segreto valido solo per quel video. Il worker rende, carica MP4, `.srt` e thumbnail, segna il video come pronto e distrugge la macchina.

Protezioni attive, dalla più importante alla meno: **il tetto di spesa giornaliero** (`DAILY_GPU_BUDGET_USD`, oggi 1,00 $) sopra a tutto; massimo 2 GPU accese in totale (`MAX_CONCURRENT_GPUS`, cioè al massimo 0,80 $ l'ora nel caso peggiore) e 1 video alla volta per utente, 2 al giorno; ogni macchina viene distrutta a fine tempo in ogni caso, sia dal server sia da un timer dentro il container che riceve lo stesso numero: almeno 60 minuti (`JOB_TIMEOUT_MIN`) e di più per i video lunghi, perché un limite più basso della stima annunciata all'utente ucciderebbe solo render sani; una macchina che non dà segni di vita entro 25 minuti dal noleggio viene distrutta e il video rimesso in coda; un video che dopo 3 ore non ha ancora trovato una GPU fallisce e i crediti tornano indietro (`QUEUE_MAX_WAIT_MIN`); i crediti si scalano alla messa in coda e tornano indietro per intero se il video fallisce o se viene annullato prima di partire (annullato a metà render torna la parte non fatta); i link scadono con i file dopo 7 giorni.

### Il tetto di 1 $ al giorno, spiegato

Prima di noleggiare una GPU, Kleo somma quello che i noleggi **di oggi** sono costati — finiti, falliti e annullati: il costo viene scritto ogni volta che una macchina viene spenta — e quello che le GPU **accese in questo momento** si sono già impegnate a costare (una GPU accesa vale il prezzo massimo per tutta la durata massima di quel video; le GPU gratuite di GitHub Actions non contano, perché non costano niente). Se il totale arriva a `DAILY_GPU_BUDGET_USD`, Kleo mette in pausa i noleggi per un'ora: nessun video viene perso e nessun credito viene bruciato, i video restano in coda e l'assistente dell'utente spiega che stanno aspettando una GPU. Alla mezzanotte UTC il conto riparte da zero.

Due cose da sapere, dette chiaramente: **è una stima e sta sotto la realtà**, perché un noleggio *fallito* non scrive mai il proprio costo da nessuna parte, e quindi Vast può addebitare minuti che questo conto non vede. La cifra vera è una sola: il saldo su console.vast.ai. Il tetto serve a limitare i danni, non a fare contabilità.

### Fermare tutto dal telefono, senza computer

Non serve più modificare `wrangler.jsonc` e rifare il deploy. Basta una richiesta con il segreto `INTERNAL_SECRET` (quello in `.secrets.local`):

```bash
# ferma i noleggi di GPU per 12 ore (max 168): i runner gratuiti di GitHub continuano a lavorare
curl -X POST -H "Authorization: Bearer $INTERNAL_SECRET" -H "content-type: application/json" \
  -d '{"hours":12}' https://kleo-mcp.plural-juice.workers.dev/internal/admin/pause

# ferma DAVVERO tutto, anche i runner gratuiti: da usare quando il problema non e' la spesa ma cosa si sta renderizzando
curl -X POST -H "Authorization: Bearer $INTERNAL_SECRET" -H "content-type: application/json" \
  -d '{"hours":12,"everything":true}' https://kleo-mcp.plural-juice.workers.dev/internal/admin/pause

# riparti (toglie anche una pausa automatica dovuta al tetto di spesa)
curl -X POST -H "Authorization: Bearer $INTERNAL_SECRET" \
  https://kleo-mcp.plural-juice.workers.dev/internal/admin/resume

# come va: in pausa? quanto si è speso oggi?
curl -H "Authorization: Bearer $INTERNAL_SECRET" \
  https://kleo-mcp.plural-juice.workers.dev/internal/admin/pause
```

Dal telefono, senza terminale: iPhone → app **Comandi** (Shortcuts) → "Ottieni contenuto dell'URL" → metodo POST, intestazione `Authorization` = `Bearer <il segreto>`. Tre comandi, uno per pausa, uno per riparti, uno per lo stato, e li premi da casa. In pausa i video restano in coda con i loro crediti; i runner gratuiti di GitHub Actions continuano a lavorare, perché non costano niente — a meno di chiedere `"everything": true`, che ferma anche loro: è l'interruttore da premere quando il problema è un prompt da non renderizzare e non il conto.

**Spegnere del tutto i render** (per una demo gratuita o se il credito Vast è finito; per fermare solo la spesa basta la pausa qui sopra): in `wrangler.jsonc` metti `"RENDER_BACKEND": "mock"` e `npm run deploy`. In modalità mock il render finisce in un minuto con file segnaposto e il server lo dice chiaramente a ogni assistente collegato. Per riaccenderle: `"vast"` e deploy.

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

# Con uno storyboard scritto a mano, come lo manderebbe un assistente. Da qui in poi lo storyboard DEVE portare il
# blocco "direction" (la regia): senza, il server lo rifiuta prima di addebitare. L'unico fixture completo e' questo,
# gli altri sono la forma del pianificatore e non hanno la regia apposta.
STORYBOARD_FILE=test/fixtures/cartoon-pirates-directed.json node test/vast-e2e.mjs
```

Da Claude Code sul tuo computer: `claude mcp add --transport http kleo-local http://localhost:8787/mcp`, poi `/mcp` → Kleo → Authenticate e un solo clic sul bottone: non c'è niente da scrivere.

Per provare da Claude.ai, ChatGPT o Grok serve un indirizzo HTTPS pubblico: il server di produzione (a pagamento) oppure, per un test di un'ora, un tunnel temporaneo `cloudflared tunnel --url http://localhost:8787` che dà un URL `trycloudflare.com` senza account.

## 7. Aggiornare il worker (immagine Docker)

Non serve costruire nulla sul tuo computer. Ogni push su `main` che tocca `worker/` fa partire `worker-image.yml` su GitHub Actions (circa 20–30 minuti): l'immagine finisce su `ghcr.io/tonnooooo/kleo-worker:keou` e il video successivo la usa. Si può lanciare anche a mano: GitHub → Actions → worker-image → Run workflow. Il pacchetto `kleo-worker` deve restare **pubblico** (GitHub → il tuo profilo → Packages → kleo-worker → Package settings → Change visibility), altrimenti Vast non può scaricarlo.

## 8. Se cambiamo nome

Nel server: `name` in `wrangler.jsonc` e in `src/mcp.ts` (il nome che i client mostrano), il titolo della pagina di accesso in `src/auth.ts`, i nomi delle risorse (`kleo-db`, `kleo-renders`) se vuoi. Nel sito: cerca e sostituisci "Kleo"/"kleo" in `index.html`; l'indirizzo del server si cambia solo in `config.json`. Nei repository: rinominali da GitHub, i link vecchi vengono reindirizzati; se cambia il nome dell'immagine, aggiorna `VAST_IMAGE` e i due workflow.
