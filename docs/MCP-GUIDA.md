# Gatto e l'MCP: come funziona, come si collega, come si costruisce

*Guida per te, in italiano. Il sito resta in inglese. "Gatto" è un nome provvisorio: quando lo cambiamo, la sezione 9 dice cosa toccare.*

## 1. Cos'è un MCP, in cinque righe

Il Model Context Protocol è il modo standard con cui un assistente AI usa strumenti esterni. Ci sono due ruoli: il **client** (Claude, ChatGPT, Grok, Cursor, Claude Code) e il **server** (Gatto). Il server dichiara una lista di **strumenti**, ognuno con un nome, una descrizione e uno schema dei parametri. Il modello legge quelle descrizioni e decide da solo quando chiamare uno strumento. Un server "remoto" è semplicemente un indirizzo HTTPS pubblico, per esempio `https://mcp.gatto.ai/mcp`: chi lo incolla nel proprio assistente ottiene i tuoi strumenti.

La tua azienda quindi non vende un'app: vende un indirizzo. Tutta l'interfaccia utente è quella dell'assistente che il cliente usa già.

## 2. Cosa succede quando Cristiano incolla l'indirizzo

1. Il client chiama l'indirizzo e trova `/.well-known/oauth-protected-resource`, che dice "per usarmi serve un token, l'accesso lo gestisce questo authorization server".
2. Il client si registra come applicazione presso Gatto (in automatico, standard OAuth 2.1) e apre nel browser la **pagina di accesso di Gatto**. Cristiano entra (Google, oppure un codice invito nella beta) e acconsente.
3. Gatto rilascia un token. Da quel momento ogni richiesta del client porta quel token e Gatto sa che è Cristiano, quanti crediti ha, quanti job ha in corso.
4. Il client chiama `tools/list` e mostra al modello i sei strumenti con le loro descrizioni.
5. Cristiano scrive "fammi uno Short sui pirati". Il modello capisce che serve `create_video`, compila i parametri e il client manda `tools/call`. Gatto risponde in meno di un secondo con un `job_id`. Il modello lo dice a Cristiano: "avviato, ci vogliono circa 25 minuti".
6. Venti minuti dopo Cristiano chiede "a che punto è?". Il modello chiama `get_job`, legge "82%, finitura 4K", e lo riferisce. Quando è pronto, `get_result` restituisce i link. Se Cristiano ha lasciato un'email, riceve anche un avviso.

Tutto questo funziona uguale in Claude, ChatGPT, Grok e Cursor, perché lo standard è lo stesso. Cambia solo dove si incolla l'indirizzo.

## 3. Perché le chiamate devono essere brevi

Un tool MCP ha lo stesso tempo di una pagina web: i client aspettano al massimo qualche decina di secondi. Un render dura 25 minuti. La regola è quindi: **nessuno strumento fa aspettare la chat**. `create_video` mette il lavoro in coda e torna subito; il lavoro vero lo fa l'orchestratore in un altro processo. Lo standard MCP (revisione 2026-07-28) prevede anche l'estensione **Tasks**: la chiamata può restituire un "task" e il client lo interroga da solo. La useremo quando i client la supportano; `get_job` resta comunque, perché funziona ovunque.

## 4. I sei strumenti, con le descrizioni che legge il modello

Le descrizioni sono il manuale del modello: se sono scritte bene, il modello sceglie lo strumento giusto e compila i parametri giusti senza che l'utente sappia nulla di tecnico.

```jsonc
// list_templates — "List the video templates Gatto can render. Call this before create_video
//                   when the user hasn't named a template, and pick the best match."
{ } // nessun parametro

// create_video — "Start rendering a video. Returns immediately with a job_id; rendering takes
//                 15–70 minutes. Tell the user the estimate and offer to check progress later."
{
  "template":   { "type": "string", "enum": ["story-documentary","top-10","viral-short","reddit-story",
                  "motivational","explainer","weekly-news","cinematic-trailer","product-review","did-you-know"] },
  "prompt":     { "type": "string", "description": "What the video is about, in the user's words. Include names, facts, tone." },
  "duration_s": { "type": "integer", "minimum": 15, "maximum": 900 },
  "format":     { "type": "string", "enum": ["16:9","9:16"] },
  "language":   { "type": "string", "enum": ["en","it"], "default": "en" },
  "voice":      { "type": "string", "description": "Optional voice id from list_templates; default per template." },
  "notify_email": { "type": "string", "format": "email", "description": "Optional. Email the download link when done." }
}
// → { "job_id": "gt_7f3k", "eta_min": 25, "credits_used": 1 }

// get_job — "Check a render job. Returns state (queued|rendering|done|failed|cancelled), current
//            track, percent and ETA. Call when the user asks for progress."
{ "job_id": { "type": "string" } }
// → { "state": "rendering", "track": "finishing", "percent": 82, "eta_min": 4 }

// get_result — "Get download links for a finished job (mp4, srt, thumbnail). Links expire in 7 days."
{ "job_id": { "type": "string" } }
// → { "mp4_url": "...", "srt_url": "...", "thumb_url": "...", "expires_at": "2026-09-16T10:00:00Z" }

// generate_thumbnail — "Generate three thumbnail options from a finished job or from a text prompt."
{ "job_id": { "type": "string" }, "prompt": { "type": "string" } } // uno dei due

// cancel_job — "Cancel a queued or running job. Unused credits are refunded."
{ "job_id": { "type": "string" } }
```

Regole che il server applica sempre, indipendentemente da cosa chiede il modello:
- i crediti si scalano quando il job entra in coda, non alla fine;
- massimo 2 job contemporanei per utente, massimo 5 GPU accese in totale (il tetto di spesa oraria è così sempre noto);
- prompt controllati per contenuti vietati prima di accendere una GPU;
- ogni chiamata registrata con utente, strumento, costo.

## 5. Il lato server, pezzo per pezzo

```
client MCP ──HTTPS──▶ /mcp  (server MCP: tools/list, tools/call)
                      /authorize, /token  (OAuth 2.1: login e token)
                      DB: utenti, crediti, job, log
                      orchestratore: ogni 30–60 s guarda la coda
                          │ crea GPU effimera (Vast.ai) con env: GATTO_API, GATTO_JOB_ID, GATTO_SECRET
                          │ ascolta il callback "done" / "failed"
                          │ distrugge la GPU, aggiorna il job
                      storage (R2): renders/{job_id}/video.mp4, subs.srt, thumb.jpg  (scadenza 7 gg)
                      /internal/jobs/{id}/progress e /done  (chiamati solo dal worker, con un segreto)
```

Il sito pubblico è una pagina statica separata: non parla con il server, se non per il link "connect".

## 6. Il worker GPU: cosa fa dentro l'istanza

È la tua procedura manuale di oggi, scritta in uno script che parte da solo:

1. **Avvio**: l'istanza nasce da un'immagine Docker tua (ComfyUI, nodi, ffmpeg, SeedVR2, RIFE già dentro). Riceve `GATTO_API` (l'indirizzo del server), `GATTO_JOB_ID`, `GATTO_SECRET` (segreto valido solo per quel job) e `GATTO_SELF_DESTRUCT_MIN`.
2. **Modelli**: scarica i pesi da R2 in parallelo (`aria2c -x16`). Egress R2 gratis, 50 GB in pochi minuti su host con `inet_down > 500`.
3. **Le cinque tracce**: script (API di un modello linguistico) → voce (TTS) → clip per scena, in parallelo (Wan 2.2 o LTX-2.5) → montaggio (ffmpeg, sottotitoli ASS, musica) → finitura (SeedVR2 a 2160p, RIFE a 60 fps, H.265). A ogni passo manda `POST progress` con percentuale e traccia.
4. **Consegna**: carica MP4, SRT, JPG sul server (a pezzi da 50 MB per i file grandi), chiama `POST done`.
5. **Autodistruzione**: un timer avviato all'inizio chiama l'API Vast per distruggere l'istanza dopo `SELF_DESTRUCT_MIN` anche se lo script muore. Il server fa lo stesso dal suo lato. Doppia sicurezza contro le bollette a sorpresa.

Se un host Vast è lento o fallisce, l'orchestratore rimette il job in coda su un altro host, al massimo due volte, poi segna `failed` e restituisce i crediti.

## 7. Come si collega, client per client

| Client | Dove incollare l'indirizzo | Note |
|---|---|---|
| Claude (web e app) | Impostazioni → Connettori → Aggiungi connettore personalizzato | Tutti i piani; il gratuito ammette un connettore. Accetta anche server senza login, ma noi lo vogliamo con login. |
| Claude Code | `claude mcp add --transport http gatto https://mcp.gatto.ai/mcp` poi `/mcp` per autenticarsi | `--scope user` per averlo in tutti i progetti |
| ChatGPT | Impostazioni → Sicurezza e accesso → Modalità sviluppatore, poi Connettori → Crea | Plus, Pro, Business, Enterprise; non il piano gratuito |
| Grok | grok.com o app → Connectors → New connector → Custom | Disponibile da maggio 2026 |
| Cursor | `.cursor/mcp.json` con `{"mcpServers":{"gatto":{"url":"https://mcp.gatto.ai/mcp"}}}` | Login OAuth al primo uso |
| VS Code | `.vscode/mcp.json` con `{"servers":{"gatto":{"type":"http","url":"https://mcp.gatto.ai/mcp"}}}` | |
| Gemini CLI | `gemini mcp add --transport http gatto https://mcp.gatto.ai/mcp` | |
| App Gemini | Impostazioni → App collegate → App personalizzate | Oggi solo Google AI Pro/Ultra, account personale, USA |

Requisito comune a tutti: l'indirizzo deve essere **HTTPS pubblico**. In locale si prova con Claude Code e con l'Inspector; per provare da Claude.ai o ChatGPT serve il deploy (vedi `gatto-mcp/DEPLOY.md`) oppure un tunnel temporaneo.

## 8. Cosa vede l'utente, in pratica

- In Claude: dopo il collegamento, nel menu strumenti compare "Gatto" con l'interruttore. Le chiamate compaiono come schede "gatto · create_video" con i parametri, esattamente come nel mockup del sito.
- In ChatGPT: chiede conferma prima di ogni chiamata che modifica qualcosa (create_video, cancel_job); le letture (get_job) passano senza conferma se lo strumento è marcato "read-only".
- In Cursor e Claude Code: il modello può anche scaricare il file con `curl` nella cartella del progetto, perché ha un terminale.

## 9. Quando cambiamo nome

Da toccare, in ordine:
1. Sito: cerca e sostituisci "Gatto" e "gatto" in `index.html` (testo, `data-copy`, snippet). Il favicon e il marchio SVG nel nav.
2. Dominio: `mcp.gatto.ai` nei tre snippet del sito e nel documento di architettura.
3. Server: il nome del server MCP (quello che i client mostrano), il nome del progetto Cloudflare o della VM, il nome del repository GitHub.
4. Email di contatto nel footer.

Tutto il resto (strumenti, schema, pipeline) non cambia.

## 10. Glossario

- **Client MCP**: l'assistente che usa gli strumenti (Claude, ChatGPT...).
- **Server MCP**: chi espone gli strumenti (Gatto).
- **Streamable HTTP**: il trasporto standard attuale: una sola rotta `/mcp`, richieste JSON, risposte anche in streaming.
- **OAuth 2.1**: lo schema di login con cui il client ottiene un token a nome dell'utente senza vedere la sua password.
- **Job**: un render in coda o in corso, identificato da `job_id`.
- **GPU effimera**: un'istanza noleggiata per un solo job e distrutta alla fine.
- **URL firmato**: un link a un file su storage che funziona solo per un certo tempo.
