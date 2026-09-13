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
- Ogni task viene **prezzato alla creazione** dal listino `KIE_MODELS` e scritto nella tabella `footage`. Il tetto
  giornaliero `DAILY_FOOTAGE_BUDGET_USD` (5 $) somma le righe di oggi PRIMA di ordinare: oltre, la richiesta è
  rifiutata con la frase esatta e nessuna clip viene ordinata. Il listino è una **stima** (la pagina prezzi di
  kie.ai non è leggibile da macchina): Kling 3.0 pro 0,09 $/s, std 0,07 $/s; gli altri sono arrotondati per
  eccesso. Va riletto su kie.ai/pricing prima di aprire la beta.
- Un film da 20 s su Kling 3.0 pro: 6-8 inquadrature da 3-4 s → ~1,5-2,5 $ di clip, più ~0,10 $ di scheda.

## 3. Gli interruttori

| dove | cosa | valore oggi |
|---|---|---|
| `KLEO_FOOTAGE_BACKEND` | `kie` o `local` | `kie` (vale solo con la chiave caricata) |
| `KLEO_FOOTAGE_MODEL` | uno dei nomi di `KIE_MODELS` | `kling-3.0` (pro, 1080p) |
| `KIE_MAX_VIDEO_S` | oltre tanti secondi il film prende la strada locale | `20` (fase di prova; `0` = nessun tetto) |
| `DAILY_FOOTAGE_BUDGET_USD` | tetto di spesa stimata al giorno | `5.00` |

Senza deploy, dal telefono, con `Authorization: Bearer <INTERNAL_SECRET>`:

```bash
curl -s https://mcp.kleooai.com/internal/admin/footage -H "Authorization: Bearer $INTERNAL_SECRET"
```

```bash
curl -s -X POST https://mcp.kleooai.com/internal/admin/footage -H "Authorization: Bearer $INTERNAL_SECRET" -H "content-type: application/json" -d '{"model":"seedance-2.0"}'
```

`{"backend":"local"}` spegne kie.ai per i prossimi film; `{"reset":true}` torna alla configurazione del file.

## 4. I modelli (letti da docs.kie.ai il 13 settembre, pagina per pagina)

| nome Kleo | modello kie.ai | durate | note |
|---|---|---|---|
| `kling-3.0` | `kling-3.0/video`, mode `pro` | 3-15 s interi | 1920×1080; il default |
| `kling-3.0-std` | idem, mode `std` | 3-15 | 1280×720, più economico |
| `kling-3.0-4k` | idem, mode `4K` | 3-15 | 3840×2160 nativo, il più caro |
| `kling-v3-turbo` | `kling/v3-turbo-image-to-video` | 3-15 | veloce, 1080p |
| `veo-3.1` | `veo-3-1` (jobs API) | 4, 6, 8 | filtro di sicurezza severo; **rotta non ancora provata** |
| `wan-2.7` | `wan/2-7-image-to-video` | 2-15 | seed, negative prompt; l'economico |
| `seedance-2.0` | `bytedance/seedance-2` | 4-15 | fluido con le persone |

Ogni inquadratura viene girata alla durata intera più corta che la copre (3,2 s → 4 s) e tagliata sulla macchina
da `build_footage`, che già sapeva gestire clip più lunghe dello stacco. L'audio è sempre spento: la voce è nostra.

## 5. La rinuncia resta la stessa

Una clip che kie.ai rifiuta (filtro, credito finito, URL scaduto) è semplicemente **assente**: la regola di
`generate_footage` non cambia, una inquadratura senza clip e il film non è un film (`film_generate` rifiuta, i
crediti tornano). L'attesa ha una fine (`KLEO_FOOTAGE_WAIT_MIN`, 14 min sulla macchina; 30 min lato server per
task). Gli URL dei risultati di kie.ai scadono in ~24 h: la clip viene copiata su R2 nel momento in cui è vista.

## 6. Cosa manca

- Il listino va confermato sulla pagina prezzi ufficiale.
- La rotta Veo 3.1 usa i nomi dei campi della sua pagina di documentazione ma non è stata esercitata.
- Nessun callback: il server interroga kie.ai a ogni poll della macchina (ogni 12 s, N task). Basta per la prova;
  un callback verso `/internal/kie/callback` farebbe risparmiare qualche chiamata, non minuti.
- La misura del movimento (flusso ottico) non viene applicata alle clip API: rigenerare costa soldi veri, e i
  modelli hosted non hanno il difetto del fermo immagine. Si può riaccendere come solo log.
