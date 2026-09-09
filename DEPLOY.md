# Kleo: messa online, passo per passo

*Per te, in italiano. Aggiornato al 9 settembre 2026, sera.*

## 0. Stato adesso (9 settembre, 11:35 UTC): installazione completata

| Cosa | Indirizzo | Stato |
|---|---|---|
| Sito | https://tonnooooo.github.io/kleo-site/ | online, permanente (GitHub Pages) |
| Server MCP | https://kleo-mcp.plural-juice.workers.dev/mcp | online, **permanente**, nel tuo account Cloudflare "Plural Juice" (id `e4a5a1308df5b44c65497b85210c6845`), account creato dal claim |
| Database D1 `kleo-db` | stesso account | migrazioni applicate |
| KV `kleo-mcp-oauth-kv` | stesso account | token OAuth |
| R2 `kleo-renders` | stesso account | file dei render, cancellati dopo 7 giorni (regola di sicurezza a 8) |
| Cron ogni minuto | attivo | orchestratore |
| Segreti | `INTERNAL_SECRET`, `INVITE_CODES`, `VAST_API_KEY` | caricati come secret Cloudflare (copia in `.secrets.local`) |
| Backend render | `mock` | passare a `vast` cambiando la variabile in `wrangler.jsonc` e `npm run deploy` |
| Test end-to-end | contro l'indirizzo definitivo | superato |

Da fare, quando vuoi:
1. ~~Abilitare R2~~ fatto il 9 settembre alle 11:42 UTC: bucket creato, binding attivo, test superato.
2. **GitHub, permesso pacchetti** (facoltativo): serve solo per pubblicare l'immagine Docker del worker su ghcr.io. Oggi non è necessario, perché l'istanza Vast usa l'immagine pubblica `nvidia/cuda` e scarica lo script del worker al boot. Quando vorrai un'immagine con ComfyUI e i modelli preinstallati, tornerà utile.
3. **Pipeline vera** nella funzione `render()` di `worker/kleo_worker.py`.

## 0b. Test reale su GPU (9 settembre, 11:00 UTC): superato

Con la tua chiave Vast.ai ho fatto un giro completo dal server locale, esposto con un tunnel temporaneo, senza toccare la produzione:

| Passo | Quando | Nota |
|---|---|---|
| job creato via MCP | 0 s | template `did-you-know`, 20 s, 9:16 |
| GPU noleggiata | 2 s | RTX 4090, Norvegia, 0,56 $/h, 832 Mbps, istanza 50376761 |
| worker avviato nell'istanza | 2 min 31 s | immagine pubblica `nvidia/cuda`, ffmpeg installato al boot, script scaricato dal repo pubblico |
| render + upload | 3 min 0 s | MP4 2160×3840, 60 fps, 20 s, 637 KB (segnaposto ffmpeg) |
| job `done`, istanza autodistrutta | 3 min 12 s | 0 istanze rimaste; credito Vast: 5,15 → 5,06 $ |

Cosa vuol dire: il contratto tra orchestratore, Vast.ai e worker funziona davvero. Resta da sostituire il render segnaposto con la tua pipeline (ComfyUI, Wan o LTX, SeedVR2, RIFE) dentro `render()` in `worker/kleo_worker.py`.

La chiave Vast è in `.secrets.local` (fuori da git) e andrà come secret Cloudflare appena wrangler è collegato. In produzione consiglio di restare su `RENDER_BACKEND=mock` finché la pipeline vera non è dentro il worker: il mock è gratis e istantaneo e mostra il giro completo a chi prova; il passaggio a `vast` è una variabile.

## 1. La decisione: tutto su Cloudflare, nessuna macchina virtuale, zero euro

Hai chiesto se Oracle Always Free a 0 € è una buona scelta. **No, non per un servizio che deve stare in piedi.** Ho verificato lo stato a settembre 2026:

- la quota gratuita è stata dimezzata a giugno (2 OCPU e 12 GB) senza avviso, e le istanze sopra il limite sono state terminate dal 18 agosto;
- "Out of host capacity" è ancora la norma: la gente aspetta giorni con script di retry per ottenere una macchina;
- Oracle spegne le istanze gratuite "inattive" (CPU, rete e memoria sotto il 20% per 7 giorni): un server MCP a basso traffico ci rientra;
- la registrazione richiede una carta vera (niente prepagate) e fallisce spesso con errori generici.

Se un giorno servirà una macchina, la scelta è Hetzner (6 € al mese, affidabile). Ma oggi non serve: **il server MCP gira come Cloudflare Worker**, con database D1, storage R2, KV per i token OAuth e un cron ogni minuto per l'orchestratore. Tutto nel piano gratuito (100 000 richieste al giorno, 10 ms di CPU per richiesta, che per noi bastano). Il sito statico sta su GitHub Pages, sempre gratis. Un solo account da creare: Cloudflare. Il piano a pagamento (5 $ al mese) serve solo se un giorno la CPU non basta.

## 2. Cosa esiste già

| Cosa | Dove | Stato |
|---|---|---|
| Sito in inglese | repository GitHub `kleo-site`, GitHub Pages | online |
| Server MCP | repository GitHub privato `kleo-mcp` (questa cartella) | online su Cloudflare (account temporaneo), test end-to-end superato anche contro l'indirizzo pubblico |
| Worker GPU per Vast.ai | `worker/kleo_worker.py` + `worker/Dockerfile` | pronto, con pipeline segnaposto (ffmpeg) da sostituire con la tua |
| Test end-to-end | `npm run test:smoke` | passa: login OAuth, 6 strumenti, coda, render simulato, download firmato, annullamento con rimborso |

## 3. Cosa devi fare tu (dieci minuti)

Non creo account e non gestisco password: è una regola fissa, anche se me lo chiedi. Tutto resta sotto i tuoi account Google e GitHub, e non c'è nessuna password mia da darti.

1. **Account Cloudflare.** Vai su `https://dash.cloudflare.com/sign-up` e scegli **Sign in with Google** con il tuo account solito: crea l'account senza carta. Piano Free.
2. **Autorizzami a fare il deploy.** Nel terminale del tuo computer, dentro la cartella `kleo-mcp`:
   ```bash
   npx wrangler login
   ```
   Si apre il browser, clicchi **Allow**. Da quel momento posso creare le risorse e pubblicare dal tuo computer, senza che nessuna chiave passi in chat. Alternativa: crea un API token (My Profile → API Tokens → Create Token → modello "Edit Cloudflare Workers", aggiungendo D1, KV e R2) e impostalo come variabile `CLOUDFLARE_API_TOKEN` prima di lanciarmi.
3. **Dominio (facoltativo, quando vuoi).** Senza dominio il server risponde su `https://kleo-mcp.<tuo-account>.workers.dev/mcp`, che funziona già con Claude, ChatGPT e Grok. Con un dominio: aggiungilo a Cloudflare, il server va su `mcp.tuodominio` e il sito su `tuodominio`.

## 4. Cosa faccio io appena hai fatto il login (cinque minuti)

```bash
npx wrangler kv namespace create OAUTH_KV      # id → wrangler.jsonc
npx wrangler d1 create kleo-db                 # id → wrangler.jsonc
npx wrangler r2 bucket create kleo-renders
npm run db:migrate
openssl rand -hex 32 | npx wrangler secret put INTERNAL_SECRET
echo "KLEO-BETA,CRISTIANO-1" | npx wrangler secret put INVITE_CODES
# PUBLIC_URL in wrangler.jsonc → l'URL workers.dev (o il dominio)
npm run deploy
```

Poi ti do l'indirizzo. Lo incolli in Claude (Impostazioni → Connettori → Aggiungi connettore personalizzato), fai l'accesso con la tua email e il codice invito, e chiedi il primo video. In modalità `mock` il render finisce in un minuto e il link scarica un MP4 di prova: serve a vedere tutto il giro funzionare da dentro Claude prima di accendere le GPU.

I segreti generati (INTERNAL_SECRET, codici invito) li salvo in `kleo-mcp/.secrets.local`, file escluso da git, così li hai tu. Le chiavi Cloudflare non le vedo mai: vivono nel login di wrangler sul tuo computer.

## 5. Accendere le GPU vere (Vast.ai)

1. Nel file `worker/kleo_worker.py` la funzione `render()` è un segnaposto che produce un MP4 con ffmpeg alla risoluzione giusta. Ci mettiamo la tua procedura di oggi (ComfyUI, Wan o LTX, SeedVR2, RIFE). Il contratto col server non cambia: `progress()`, poi i tre file, poi `done`.
2. Costruiamo l'immagine (`podman build`, ce l'hai già) e la pubblichiamo su Docker Hub con il tuo account; il nome finisce in `VAST_IMAGE`.
3. La tua chiave Vast.ai va messa come secret: `npx wrangler secret put VAST_API_KEY` (la incolli tu nel terminale, non in chat). Consiglio una chiave con permesso "Instance management only".
4. `RENDER_BACKEND` da `mock` a `vast`, deploy. Il primo job reale: uno Short con il template `viral-short`.

Protezioni già attive: massimo 5 GPU accese in totale e 2 job per utente; ogni istanza viene distrutta dopo 120 minuti in ogni caso, sia dal server sia da un timer dentro il container (che usa la chiave ristretta che Vast inietta, non la tua); i crediti si scalano all'ingresso in coda; i link scadono con i file dopo 7 giorni.

## 6. Provare in locale, senza account

```bash
cd kleo-mcp
npm install
npm run db:migrate:local
npm run dev                 # http://localhost:8787
npm run test:smoke          # l'intero giro, in 40 secondi
```

Da Claude Code sul tuo computer: `claude mcp add --transport http kleo-local http://localhost:8787/mcp`, poi `/mcp` → Kleo → Authenticate, email qualsiasi e codice `KLEO-BETA`.

Per provare da Claude.ai, ChatGPT o Grok serve un indirizzo HTTPS pubblico: o il deploy su Cloudflare (punto 4) o, per un test di un'ora, un tunnel temporaneo `cloudflared tunnel --url http://localhost:8787` che dà un URL `trycloudflare.com` senza account.

## 7. Se cambiamo nome

Nel server: `name` in `wrangler.jsonc` e in `src/mcp.ts` (è il nome che i client mostrano), il titolo della pagina di login in `src/auth.ts`, i nomi delle risorse (`kleo-db`, `kleo-renders`) se vuoi. Nel sito: cerca e sostituisci "Kleo"/"kleo" e il dominio nei tre snippet. Nei repository: rinominali da GitHub, i link vecchi vengono reindirizzati.
