# Le clip da kie.ai — come un film si gira senza scheda da 80 GB (13 settembre 2026)

Perché: il modello aperto sulla scheda noleggiata (LTX-2.5, prima Wan 2.2 5B) costa 1,5-2,6 $/h di GPU, ~125 s per
clip, un quarto di clip ferme, e resta sotto la barra Higgsfield che il proprietario ha chiesto. kie.ai
(https://kie.ai) espone in un'unica API Kling 3.0, Veo 3.1, Wan 2.7, Seedance 2.0: una clip in 60-90 s, 1080p,
niente pesi da scaricare. Questo documento è la catena che li usa. Il codice: `src/footage.ts` (server) e il
tratto "footage over the API" di `worker/kleo_worker.py` (macchina noleggiata).

## 1. Cosa si sposta e cosa resta

Si sposta **solo la ripresa**. La macchina noleggiata disegna ancora i fotogrammi di riferimento (kleo_pictures),
fa la voce, chiede al motore quando stacca ogni inquadratura — è quello che decide quanto dura ogni clip — e poi,
invece di caricare un modello da 22B, **carica i fotogrammi sul server, chiede le clip, aspetta e le scarica**.
Traccia, narrazione e finitura 4K 60 fps sono lo stesso codice di prima (`kleo_video.py build_footage`, fase
finish sulla macchina da centesimi). Quindi un film sulla strada kie noleggia la **scheda da 16 GB a 0,40 $/h**
(il profilo delle immagini) e non la scheda video.

```
prompt → MCP → storyboard + immagini (Workers AI o GPU) → Vast 16 GB: voce + tempi di stacco
      → PUT stills → POST footage → [server → kie.ai createTask × inquadratura] → GET footage (poll) → GET clips
      → Vast: traccia 60 fps 4K → gen.tgz → finish box: narrazione, controlli, upload → R2 → link
```

## 2. La chiave e i soldi

- `KIE_API_KEY` è un **segreto Cloudflare**: `npx wrangler secret put KIE_API_KEY`. La macchina noleggiata non la
  vede mai: parla solo con il server, col segreto del proprio job. I fotogrammi arrivano a kie.ai attraverso gli
  stessi link firmati `/dl/` che le immagini usano già (`dl.ts`).
- **Conto kie.ai vuoto** (dal 13 set sera, dopo il job `gt_sw48sch9`: 13 clip pagate, poi `Credits insufficient` sulle
  ultime 3 e film morto lo stesso). Prima di ordinare, il server legge il saldo (`GET /api/v1/chat/credit`, 1 credito =
  0,005 $): se non copre il film risponde 402 con la frase "kie.ai balance is empty: 0 of N shots could be ordered…"
  e non crea nessun task; se kie.ai non risponde al saldo si procede lo stesso. Se il rifiuto arriva a metà (codice
  402, o il 500 "Credits insufficient" che kie.ai manda davvero), il server **si ferma alla prima clip rifiutata**:
  gli shot dopo non vengono chiesti e non hanno riga. In entrambi i casi la rotta `/footage` **fallisce subito il
  job** con quella frase e rimborsa i crediti (`failJob`, nessun tentativo su un'altra scheda), invece di lasciare la
  macchina ad aspettare le clip e morire con il generico "the shots did not film". Dopo la ricarica, una nuova
  richiesta riordina solo gli shot mai fatturati (righe `failed` senza `task_id`, e quelli senza riga). Il saldo si
  legge anche in `GET /internal/admin/footage` (`balance_usd`, `null` se kie.ai non ha risposto).
- **Pre-volo alla creazione (15 set).** Il controllo qui sopra stava DOPO il noleggio: la mattina del 15 quattro film
  (`gt_wduqqahb`, `gt_wachuyzg`, `gt_wrbfg8sv`, `gt_dsqacdbp`) hanno noleggiato una RTX 3090, disegnato i fotogrammi
  e doppiato lo script per scoprire alle clip che il saldo era 0,07 $ (fermo dal 13): ~20 minuti dell'utente e quattro
  noleggi per imparare un numero che il server sapeva già. Ora `createJob` chiama `kiePreflight` (`src/footage.ts`)
  per ogni film sulla strada kie: stima il costo (inquadrature dello storyboard × secondi/inquadratura × prezzo del
  modello; senza storyboard circa un'inquadratura ogni 3 s, minimo 6, massimo il tetto delle immagini) e legge il
  saldo; se non basta rifiuta **prima di addebitare e di noleggiare**, con la frase che dice i due numeri e offre
  l'animatic (`product: "animatic"`, 5 crediti, nessuna clip), e scrive `footage.preflight` nell'audit con
  `owner_action: "top up kie.ai"`. Il silenzio di kie.ai non rifiuta. Il negozio non si chiude per questo: regola del
  proprietario, kie.ai si ricarica quando qualcuno paga — e il film è comunque solo per chi ha pagato (`hasPaid`).
- **Un animatic non ordina clip.** `requestFootage` risponde 409 a un job con `params.product = "animatic"` qualunque
  cosa chieda la macchina: i suoi fotogrammi vanno al motore con la camera sopra (`picture.js`), e il conto kie.ai
  non lo vede mai.
- Ogni task viene **prezzato alla creazione** dal listino `KIE_MODELS` e scritto nella tabella `footage`. Il tetto
  giornaliero `DAILY_FOOTAGE_BUDGET_USD` (15 $ dal 13 set sera, prima 5) somma le righe di oggi PRIMA di ordinare: oltre, la richiesta è
  rifiutata con la frase esatta e nessuna clip viene ordinata. Il listino è quello **vero**, letto il 13 settembre
  dall'API del listino di kie.ai (la pagina HTML rifiuta i fetcher, l'API no):
  `curl -X POST https://api.kie.ai/client/v1/model-pricing/page -H 'content-type: application/json' -H 'origin: https://kie.ai' -d '{"pageNum":1,"pageSize":100}'`
  (5 pagine, 482 righe; 1 credito kie.ai = 0,005 $). Le stime di prima erano sbagliate in peggio fino a 6 volte
  (Seedance 0,08 contro 0,51 $/s): un tetto che somma stime basse non è un tetto.
- Un film da 20 s: 6-8 inquadrature da 4 s → ~1,3 $ su MiniMax H3, ~1,8 $ su Kling 3.0 pro, più ~0,10 $ di scheda.

## 3. Gli interruttori

| dove | cosa | valore oggi |
|---|---|---|
| `KLEO_FOOTAGE_BACKEND` | `kie` o `local` | `kie` (vale solo con la chiave caricata) |
| `KLEO_FOOTAGE_MODEL` | uno dei nomi di `KIE_MODELS` | `minimax-h3` (2K; `kling-3.0` pro è la riserva collaudata) |
| `KIE_MAX_VIDEO_S` | oltre tanti secondi il film prende la strada locale | `0` = nessun tetto (dal 13 set sera). Era `20` (fase di prova): uno Short da 30 s lo superava, andava sulla strada locale LTX-2.5 (scheda da 80 GB, 1,5 $/h) e moriva con "the shots did not film" (job `gt_5b8r3hna`); quella strada non ha mai consegnato un film in produzione |
| `DAILY_FOOTAGE_BUDGET_USD` | tetto di spesa stimata al giorno | `15.00` (era 5: un solo film al giorno; uno Short da 30 s = ~15 shot da 4 s ≈ 3,9 $ su MiniMax H3 2K) |

Senza deploy, dal telefono, con `Authorization: Bearer <INTERNAL_SECRET>`:

```bash
curl -s https://mcp.kleooai.com/internal/admin/footage -H "Authorization: Bearer $INTERNAL_SECRET"
```

```bash
curl -s -X POST https://mcp.kleooai.com/internal/admin/footage -H "Authorization: Bearer $INTERNAL_SECRET" -H "content-type: application/json" -d '{"model":"seedance-2.0"}'
```

`{"backend":"local"}` spegne kie.ai per i prossimi film; `{"reset":true}` torna alla configurazione del file.

## 4. I modelli (schede lette su docs.kie.ai, prezzi dal listino, classifica Artificial Analysis i2v senza audio)

| nome Kleo | modello kie.ai | prezzo | durate | Elo | note |
|---|---|---|---|---|---|
| **`minimax-h3`** | `minimax-h3/image-to-video`, 2K | 0,065 $/s | 4-15 s interi | 1351 (3º) | **il default dal 13 settembre**; first_frame_url, niente aspect ratio (decide il fotogramma) |
| `minimax-h3-768p` | idem, 768P | 0,04 $/s | 4-15 | — | stesso modello, meno pixel per l'upscale |
| `gemini-omni-flash` | `google/gemini-omni-flash-1-1`, 1080p | **a clip**: 0,315 $ (4 s) · 0,42 (6) · 0,525 (8) · 0,63 (10) | 4/6/8/10 | 1365 (1º) | lo sfidante; conviene con inquadrature lunghe |
| `gemini-omni-flash-4k` | idem, 4k nativo | a clip: 0,735 · 0,84 · 0,945 · 1,05 $ | 4/6/8/10 | — | il 4K nativo meno caro del listino |
| `kling-3.0` | `kling-3.0/video`, mode `pro` | 0,09 $/s | 3-15 | 1302 | 1920×1080; la riserva collaudata |
| `kling-3.0-std` | idem, mode `std` | 0,07 $/s | 3-15 | 1292 | 1280×720 |
| `kling-3.0-4k` | idem, mode `4K` | 0,335 $/s | 3-15 | — | 3840×2160 nativo, 3,7 volte il pro |
| `kling-v3-turbo` | `kling/v3-turbo-image-to-video` | 0,1125 $/s | 3-15 | — | più veloce, non più economico |
| `veo-3.1` | `veo-3-1` (jobs API) | a clip, tetto Quality 1,275 $ (Fast 0,325, Lite 0,175) | 4, 6, 8 | 1304 | filtro severo; **rotta non provata**, il gate conta il caso caro |
| `wan-2.7` | `wan/2-7-image-to-video` | 0,12 $/s | 2-15 | 1275 | seed, negative prompt; più caro di Kling pro |
| `seedance-2.0` | `bytedance/seedance-2`, 1080p | 0,51 $/s | 4-15 | 1342 (a 720p) | fluido con le persone, ma 5,7 volte Kling: solo confronti |

Perché MiniMax H3 è il default: terzo al mondo nella classifica a voti ciechi, sopra Kling pro, Veo 3.1 e Wan 2.7;
nativo 2K, quindi l'upscale a 4K sulla macchina parte da il doppio dei pixel di Kling 1080p; il 28 % meno di Kling.
Con i 7 crediti dello stile realistic (2,80-3,50 €) è l'unico modello di fascia alta che almeno pareggia a 60 s.
Uno Short da 60 s costa ~4 $ su MiniMax, ~5,5 $ su Kling pro, ~30 $ su Seedance 1080p. Il prezzo a lunghezza
(1 credito ogni 5 s di film) è la strada per il margine; la decisione è del proprietario.

Ogni inquadratura viene girata alla durata intera più corta che la copre (3,2 s → 4 s) e tagliata sulla macchina
da `build_footage`, che già sapeva gestire clip più lunghe dello stacco. L'audio è sempre spento: la voce è nostra.
MiniMax e Gemini senza fotogramma di riferimento non hanno una strada text-to-video su questo id: la task viene
rifiutata da kie.ai e l'inquadratura resta assente, che è l'esito giusto.

## 5. La rinuncia resta la stessa

Una clip che kie.ai rifiuta (filtro, credito finito, URL scaduto) è semplicemente **assente**: la regola di
`generate_footage` non cambia, una inquadratura senza clip e il film non è un film (`film_generate` rifiuta, i
crediti tornano). L'attesa ha una fine (`KLEO_FOOTAGE_WAIT_MIN`, 14 min sulla macchina; 30 min lato server per
task). Gli URL dei risultati di kie.ai scadono in ~24 h: la clip viene copiata su R2 nel momento in cui è vista.

## 6. Cosa manca

- MiniMax H3 e Gemini Omni Flash hanno i campi delle loro pagine di documentazione ma **non sono ancora stati
  esercitati** da un film vero: il primo test da ≤ 20 s (~1,3 $) dice se il default regge.
- La rotta Veo 3.1 usa i nomi dei campi della sua pagina di documentazione ma non è stata esercitata; il gate la
  conta al prezzo Quality finché non si sa quale livello fattura.
- Nessun callback: il server interroga kie.ai a ogni poll della macchina (ogni 12 s, N task). Basta per la prova;
  un callback verso `/internal/kie/callback` farebbe risparmiare qualche chiamata, non minuti.
- La misura del movimento (flusso ottico) non viene applicata alle clip API: rigenerare costa soldi veri, e i
  modelli hosted non hanno il difetto del fermo immagine. Si può riaccendere come solo log.

## La traccia musicale sulla stessa strada (22 settembre 2026)

Quando l'utente risponde sì alla domanda sulla musica, la stessa API (`createTask` / `recordInfo`) ordina **una** traccia
Suno (`ai-music-api/generate`, strumentale, custom mode, 12 crediti = 0,06 $), scritta nella tabella `footage` con
`shot_id = "music"` per il tetto giornaliero e servita alla macchina da `/internal/jobs/:id/music/file`. Rifiuti
morbidi: il film esce senza traccia. Tutto in `docs/MUSICA-SOTTOTITOLI-DISSOLVENZE.md`.
