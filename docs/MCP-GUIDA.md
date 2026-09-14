# Kleo e l'MCP: come funziona, come si collega, come si costruisce

*Guida per te, in italiano. Il sito resta in inglese. Aggiornata all'11 settembre 2026. "Kleo" è un nome provvisorio: la sezione 9 dice cosa toccare per cambiarlo.*

## 1. Cos'è un MCP, in cinque righe

Il Model Context Protocol è il modo standard con cui un assistente AI usa strumenti esterni. Ci sono due ruoli: il **client** (Claude, ChatGPT, Grok, Cursor, Claude Code, VS Code, OpenCode, Gemini CLI) e il **server** (Kleo). Il server dichiara una lista di **strumenti**, ognuno con un nome, una descrizione e uno schema dei parametri. Il modello legge quelle descrizioni e decide da solo quando chiamare uno strumento. Un server "remoto" è semplicemente un indirizzo HTTPS pubblico: il nostro è `https://kleo-mcp.plural-juice.workers.dev/mcp`. Chi lo incolla nel proprio assistente ottiene i tuoi strumenti.

La tua azienda quindi non vende un'app: vende un indirizzo. Tutta l'interfaccia utente è quella dell'assistente che il cliente usa già.

## 2. Cosa succede quando Cristiano incolla l'indirizzo

1. Il client chiama l'indirizzo e trova `/.well-known/oauth-protected-resource`, che dice "per usarmi serve un token, l'accesso lo gestisce questo authorization server".
2. Il client si registra come applicazione presso Kleo (in automatico, standard OAuth 2.1) e apre nel browser la **pagina di accesso di Kleo**. Cristiano non scrive niente: c'è un solo bottone, "Start free", e premerlo è il consenso. In quel momento nasce un account anonimo con 2 crediti, ricordato da un cookie firmato di quel browser. Se un domani collega Kleo anche a ChatGPT dallo stesso computer, ritrova lo stesso account e gli stessi crediti, non altri due gratis.
3. Kleo rilascia un token. Da quel momento ogni richiesta del client porta quel token e Kleo sa che è Cristiano, quanti crediti ha, quanti video ha in corso.
4. Il client chiama `tools/list` e mostra al modello i nove strumenti con le loro descrizioni.
5. Cristiano scrive "fammi uno Short sui pirati". Il modello legge i template (`kleo_list_templates`), di solito chiede la guida (`kleo_storyboard_guide`) e scrive lui lo storyboard, poi chiama `kleo_create_video`. Kleo risponde in meno di un secondo con un numero di video (`job_id`) e una stima. Il modello lo dice a Cristiano: "avviato, ci vogliono circa 15 minuti".
6. Dieci minuti dopo Cristiano chiede "a che punto è?". Il modello chiama `kleo_get_job`, legge "70%, sta disegnando le scene", e lo riferisce. Quando è pronto, `kleo_get_result` restituisce i link a MP4, sottotitoli e thumbnail, validi 7 giorni.

Tutto questo funziona uguale in ogni client, perché lo standard è lo stesso. Cambia solo dove si incolla l'indirizzo.

## 3. Perché le chiamate devono essere brevi

Un tool MCP ha lo stesso tempo di una pagina web: i client aspettano al massimo qualche decina di secondi. Un render dura 10–20 minuti per uno Short e fino a un'ora per un video lungo. La regola è quindi: **nessuno strumento fa aspettare la chat**. `kleo_create_video` mette il lavoro in coda e torna subito; il lavoro vero lo fa l'orchestratore (un cron ogni minuto) su una macchina noleggiata. Lo standard MCP (revisione 2026-07-28) prevede anche l'estensione **Tasks**: la useremo quando i client la supportano; `kleo_get_job` resta comunque, perché funziona ovunque.

## 4. I nove strumenti, con le descrizioni che legge il modello

Le descrizioni sono il manuale del modello: se sono scritte bene, il modello sceglie lo strumento giusto e compila i parametri giusti senza che l'utente sappia nulla di tecnico. Le descrizioni vere e complete stanno in `src/mcp.ts`; qui il riassunto.

```jsonc
// kleo_adapt_prompt — passo 1 (14 settembre). "Turns the user's request into the TREATMENT of the film: Kleo's
//                     producer reads the request, keeps every fact in it, and decides the angle, the opening image,
//                     the acts with their seconds, the ending, the visual language, the pacing, the narrator and the
//                     motifs — and lists every decision it took that the user did not ask for."
{ "prompt": "…", "duration_s": 60, "format": "16:9", "language": "en" } // solo prompt obbligatorio; lingua, durata e formato letti dalla richiesta
// → { brief, treatment: { logline, angle, device, opening, ending, acts, visual, pacing, narrator, motifs, decisions, prose, variation }, ready_to_render }
//   Se manca il soggetto o la durata risponde con la domanda e non spende niente. L'assistente dice all'utente
//   logline e decisioni, poi passa l'oggetto tale e quale (o modificato) a kleo_create_video come "treatment".
//   Dettagli: docs/ADAPT-PROMPT.md

// kleo_list_templates — "Lists the templates Kleo can render and the credits left on the account.
//                        Call it when the user has not named a template, then pick the closest match."
{ } // nessun parametro
// → { templates: [{ id, name, formats, duration_s: {min, max, default}, credits, voices, description }], credits_available, pricing }

// kleo_storyboard_guide — passo 2, consigliato. "Returns the storyboard format Kleo renders (styles, scene kinds,
//                          beats, icons, effects, voices, limits, rules) with two examples, so you can write an
//                          original storyboard and pass it to kleo_create_video. Call it once per conversation."
{ "template": "viral-short", "duration_s": 45 } // entrambi facoltativi
// → il testo della guida, più { words_target, credits }

// kleo_create_video — passo 3. "Starts rendering a video or Short from a template and a prompt (plus your storyboard,
//                      if you wrote one). Returns at once with the job_id, the estimated minutes and the credits used.
//                      If the tool returns an error, nothing was charged."
{
  "template":     { "enum": ["story-documentary","top-10","viral-short","reddit-story","motivational",
                             "explainer","weekly-news","cinematic-trailer","product-review","did-you-know"] },
  "prompt":       { "type": "string", "minLength": 8, "maxLength": 4000 },   // il video, con le parole dell'utente
  "duration_s":   { "type": "integer", "minimum": 15, "maximum": 900 },      // dentro il range del template
  "format":       { "enum": ["16:9", "9:16"] },                              // default: primo formato del template
  "language":     { "enum": ["en", "it"], "default": "en" },
  "voice":        { "type": "string" },                                      // facoltativo, dalla lista dei template
  "notify_email": { "type": "string", "format": "email" },                   // facoltativo (oggi l'email non parte: manca RESEND_API_KEY)
  "storyboard":   { "type": "object" },                                      // facoltativo: lo storyboard scritto dall'assistente, validato dal server
  "treatment":    { "type": "object" }                                       // facoltativo: l'oggetto restituito da kleo_adapt_prompt; il pianificatore scrive direction e scene sotto di lui
}
// → { job_id: "gt_ab12cd34", state: "queued", eta_min: 25, credits: 1, message }

// kleo_get_job — passo 4. "Progress of a video: state (queued, starting, rendering, finishing, done, failed, cancelled),
//                 what it is doing now, percent done and minutes left. Without a job_id it lists the recent videos."
{ "job_id": { "type": "string" } } // facoltativo
// → { job_id, state: "rendering", track: "clips", percent: 70, eta_min: 4, ... }

// kleo_get_result — passo 5. "Download links for a finished video: the MP4, the subtitles (.srt) and the thumbnail.
//                    Only works when the state is done. Links stop working after 7 days."
{ "job_id": { "type": "string" } }
// → { video_url, subtitles_url, thumbnail_url, expires_at }

// kleo_generate_thumbnail — "Not available yet in this beta: every finished video already comes with a thumbnail."
{ "job_id": { "type": "string" }, "prompt": { "type": "string" } } // uno dei due; oggi risponde con un avviso

// kleo_cancel_job — "Cancels a video that is waiting or rendering. Credits are given back in full if it had not
//                    started, otherwise in proportion to the work left."
{ "job_id": { "type": "string" } }
// → { job_id, state: "cancelled", refunded }

// kleo_account — "The credits left, the link to the account page and the Kleo key that carries the same account
//                 to another browser."
{ } // nessun parametro
// → { credits_available, free_tier, account_key, account_url, payments_open }
```

`account_key` è la "chiave Kleo": è la stessa stringa del cookie, quindi chi ce l'ha prende l'account e ne spende i crediti. Il modello la mostra solo se l'utente la chiede; la pagina `/credits` la mostra solo al browser che quell'account ce l'ha già. Il link `account_url` invece lo può dare sempre: porta a una pagina di sola lettura (saldo, prezzi, indirizzo a cui scrivere) che non fa entrare nessuno, ed è quello che `kleo_create_video` restituisce quando i crediti sono finiti.

Regole che il server applica sempre, indipendentemente da cosa chiede il modello:
- i crediti (1 credito = 2 secondi di film, minimo 10: 20 s = 10, 30 s = 15, 60 s = 30, 5 minuti = 150; 7 crediti regalati all'iscrizione, che da soli non bastano per un film: il primo film richiede il pacchetto da 5 EUR) si scalano quando il video entra in coda e tornano indietro per intero se fallisce o se viene annullato prima di partire; annullato a render iniziato torna solo la parte non ancora renderizzata;
- 1 video alla volta per utente e 2 al giorno (contano solo quelli riusciti o in corso: uno fallito o annullato viene rimborsato e non occupa il posto), massimo 2 GPU accese in totale, e sopra a tutto un tetto di spesa giornaliero (`DAILY_GPU_BUDGET_USD`, oggi 1,00 $): oltre quella cifra Kleo smette di noleggiare GPU per un'ora e i video restano in coda;
- lo storyboard, scritto dall'assistente o da Workers AI, passa il validatore (`src/keou-contract.ts`) prima di accendere una GPU: uno storyboard sbagliato torna indietro con l'elenco dei problemi e niente viene addebitato;
- prompt controllati per contenuti vietati prima di spendere;
- ogni chiamata registrata nella tabella `audit` con utente, strumento, costo.

Se la quota giornaliera gratuita di Workers AI finisce, `kleo_create_video` non fallisce in silenzio: risponde chiedendo all'assistente di scrivere lo storyboard con `kleo_storyboard_guide` e riprovare.

### 4.1 L'attesa automatica e gli stili (aggiunti il 10 settembre)

`kleo_wait_for_video` è lo strumento che tiene l'assistente "in attesa con la rotella": lo chiama subito dopo `kleo_create_video` e resta appeso per il tempo massimo che quel client tollera (ChatGPT e Grok circa 45 secondi, Claude circa 3 minuti, Claude Code 2 minuti, OpenCode 5 minuti), poi torna con "ancora in corso, richiamami" oppure con i link finiti. Il modello lo richiama da solo finché il video non è pronto, così l'utente non deve scrivere "a che punto è?". Il server riconosce il client dal nome che dichiara (`clientInfo`) o dallo User-Agent e regola l'attesa; ogni chiamata viene registrata nell'audit come `wait.call` con il nome del client.

`kleo_create_video` accetta anche `style`: **cartoon** (illustrazioni piatte disegnate per l'argomento), **realistic** (look fotografico cinematografico), **cyber** (il look Keou originale, sfondo scuro e icone luminose) e **stickman** (l'omino disegnato a mano, solo 9:16). Cartoon e realistic usano lo stile Keou `picture` (vedi `docs/PICTURE-STYLE.md`): ogni scena si divide in `shots`, da due a quattro immagini a tutto schermo, ognuna con il suo `image_prompt` e con `at`, la parola della narrazione su cui l'immagine cambia; la scena di chiusura ne ha una sola. Oggi le disegna tutte la GPU noleggiata su Vast (`IMAGE_SERVER_MAX=0`), così la quota gratuita giornaliera di Workers AI resta intera per gli storyboard; ogni immagine ha un movimento lento, una sfumatura scura in basso per i sottotitoli e, quando serve, una scritta grande di due o tre parole. Niente icone, niente HUD, niente beats: un video sui pirati mostra spiagge, sabbia e velieri, uno sullo spazio razzi e stazioni.

## 5. Il lato server, pezzo per pezzo

```
client MCP ──HTTPS──▶ /mcp  (server MCP: tools/list, tools/call)                      src/mcp.ts
                      /authorize, /token, /register  (OAuth 2.1: pagina di accesso e token)   src/auth.ts
                      /credits  (pagina dell'account: crediti, chiave Kleo)                   src/credits.ts
                      D1: utenti, crediti, codici regalo, video, log                          src/db.ts
                      orchestratore (cron ogni minuto):                                       src/orchestrator.ts
                          │ scrive lo storyboard dei video in coda (Workers AI)              src/storyboard.ts
                          │ noleggia una GPU Vast.ai per video, con l'immagine Keou          src/backends/vast.ts
                          │ ascolta progress / done / failed, distrugge la GPU, aggiorna il video
                          │ riserva gratuita: i runner GitHub prendono i video che Vast non avvia   src/backends/pool.ts
                      R2: renders/{job_id}/video.mp4, subtitles.srt, thumbnail.jpg  (scadenza 7 giorni)
                      /internal/jobs/{id}/...  (chiamati solo dal worker, con un segreto per video)   src/internal.ts
                      /dl/{job_id}/{file}?exp&sig  (link firmati, a tempo)                   src/dl.ts
```

Il sito pubblico è una pagina statica separata: non parla con il server, se non per l'indirizzo che l'utente copia.

## 6. Il worker: cosa fa dentro la macchina noleggiata

L'immagine `ghcr.io/tonnooooo/kleo-worker:keou` contiene il motore Keou (il tuo motore di motion design), Chromium, Node, ffmpeg, le voci Kokoro (inglese e italiano) e whisper per allineare i sottotitoli: niente da scaricare all'avvio. Il worker (`worker/kleo_worker.py`) parte da solo:

1. **Avvio**: riceve `KLEO_API` (l'indirizzo del server), `KLEO_JOB_ID`, `KLEO_SECRET` (segreto valido solo per quel video), `KLEO_SELF_DESTRUCT_MIN` e il numero di core da usare. Scarica la specifica del video, storyboard compreso.
2. **Voce**: Kokoro legge la narrazione di ogni scena; whisper la riascolta e allinea i sottotitoli parola per parola. La voce detta i tempi di tutto il resto.
3. **Scene**: Chromium disegna ogni scena fotogramma per fotogramma a 60 fps (testi grandi, icone, grafici, personaggi), più scene in parallelo, una per core.
4. **Montaggio e finitura**: ffmpeg mette insieme scene, voce e musica; un controllo di qualità automatico verifica il file; poi MP4 (2160×3840 per i 9:16, 3840×2160 per i 16:9: 4K in tutti e due i formati, H.264 + AAC), `.srt` e thumbnail.
5. **Consegna**: carica i tre file sul server (a pezzi per i file grandi), chiama `done`. A ogni passo manda `progress` con percentuale e fase.
6. **Autodistruzione**: un timer avviato all'inizio distrugge la macchina dopo `KLEO_SELF_DESTRUCT_MIN` anche se lo script muore, usando la chiave ristretta che Vast inietta nel container (mai la tua). Il server fa lo stesso dal suo lato. Doppia sicurezza contro le bollette a sorpresa.

Se una macchina Vast è lenta o fallisce, l'orchestratore rimette il video in coda su un'altra, al massimo tre tentativi, poi lo segna `failed` e restituisce i crediti. Su Vast il render è lavoro di CPU (la GPU aiuta solo la voce): per questo le offerte sono filtrate per almeno 16 core.

## 7. Come si collega, client per client

L'indirizzo è lo stesso per tutti: `https://kleo-mcp.plural-juice.workers.dev/mcp`. Al primo uso ogni client apre la pagina di accesso di Kleo: un bottone, niente da scrivere.

| Client | Dove incollare l'indirizzo | Note |
|---|---|---|
| Claude (web e app) | Impostazioni → Connettori → Aggiungi connettore personalizzato | Tutti i piani; il gratuito ammette un connettore |
| ChatGPT | Impostazioni → App e connettori (o Connettori) → Impostazioni avanzate → Modalità sviluppatore; poi Connettori → Crea, autenticazione OAuth | Plus, Pro, Business, Enterprise; non il piano gratuito. Chiede conferma prima di ogni render |
| Grok | grok.com o app → Impostazioni → Connectors → Add connector → Custom | |
| Claude Code | `claude mcp add --transport http kleo https://kleo-mcp.plural-juice.workers.dev/mcp` poi `/mcp` → Kleo → Authenticate | `--scope user` per averlo in tutti i progetti |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers":{"kleo":{"url":"https://kleo-mcp.plural-juice.workers.dev/mcp"}}}` | Login OAuth al primo uso (Settings → MCP → Connect) |
| VS Code | `.vscode/mcp.json`: `{"servers":{"kleo":{"type":"http","url":"https://kleo-mcp.plural-juice.workers.dev/mcp"}}}` | Clic su "Start" sopra il server; strumenti in Copilot Chat, modalità Agent |
| OpenCode | `~/.config/opencode/opencode.jsonc`: `{"mcp":{"kleo":{"type":"remote","url":"https://kleo-mcp.plural-juice.workers.dev/mcp","enabled":true}}}` poi `opencode mcp auth kleo` | Il login si fa dal terminale, apre il browser |
| Gemini CLI | `gemini mcp add --transport http kleo https://kleo-mcp.plural-juice.workers.dev/mcp` poi `/mcp auth kleo` nella sessione | |
| App Gemini | Impostazioni → App collegate → App personalizzate | Oggi solo Google AI Pro/Ultra, account personale |
| Windsurf | Settings → MCP → Add server (`"serverUrl"` in `mcp_config.json`) | |

Requisito comune a tutti: l'indirizzo deve essere **HTTPS pubblico**. In locale si prova con Claude Code (`http://localhost:8787/mcp`); per provare da Claude.ai o ChatGPT serve il server di produzione oppure un tunnel temporaneo (vedi `DEPLOY.md`, sezione 6). Il sito mostra gli stessi snippet, con pulsante "Copy", nella sezione Connect.

## 8. Cosa vede l'utente, in pratica

- In Claude: dopo il collegamento, nel menu strumenti compare "Kleo" con l'interruttore. Le chiamate compaiono come schede "kleo_create_video" con i parametri.
- In ChatGPT: chiede conferma prima di ogni chiamata che modifica qualcosa (`kleo_create_video`, `kleo_cancel_job`); le letture (`kleo_get_job`, `kleo_get_result`) passano senza conferma perché sono marcate "read-only".
- In Cursor, Claude Code, VS Code, OpenCode: il modello può anche scaricare il file con `curl` nella cartella del progetto, perché ha un terminale.
- Se qualcosa non va (crediti finiti, storyboard rifiutato, troppi video in corso), lo strumento risponde con una frase chiara e niente viene addebitato; il modello la riferisce all'utente.

## 9. Quando cambiamo nome

Da toccare, in ordine:
1. Sito: cerca e sostituisci "Kleo" e "kleo" in `index.html` (testo, `data-copy`, snippet). Il favicon e il marchio SVG nel nav. L'indirizzo del server sta solo in `config.json`.
2. Server: il nome del server MCP in `src/mcp.ts` (quello che i client mostrano), il titolo della pagina di accesso in `src/auth.ts`, `name` in `wrangler.jsonc`, il nome del repository GitHub e, se vuoi, dell'immagine (`VAST_IMAGE` e i due workflow).
3. Email di contatto nel footer del sito.

Tutto il resto (strumenti, schema, motore) non cambia.

## 10. Glossario

- **Client MCP**: l'assistente che usa gli strumenti (Claude, ChatGPT...).
- **Server MCP**: chi espone gli strumenti (Kleo).
- **Streamable HTTP**: il trasporto standard attuale: una sola rotta `/mcp`, richieste JSON, risposte anche in streaming.
- **OAuth 2.1**: lo schema di login con cui il client ottiene un token a nome dell'utente senza vedere la sua password.
- **Job / video**: un render in coda o in corso, identificato da `job_id` (per l'utente: "il numero del video").
- **Storyboard**: il piano del video (scene, narrazione, testi, effetti) nel formato del motore Keou.
- **GPU effimera**: una macchina noleggiata per un solo video e distrutta alla fine.
- **URL firmato**: un link a un file su storage che funziona solo per un certo tempo.
