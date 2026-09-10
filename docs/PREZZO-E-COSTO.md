# Quello che il cliente scrive, quello che la GPU fa, quello che paga

*Aggiornato all'11 settembre 2026. Session: KLEO-4 costi.*

Kleo fa pagare con `creditsFor(durata, stile)` — **due** numeri. Ma quanto costa davvero un
render dipende da **nove** cose che un client può scrivere. Le sette che il prezzo non vede sono
il buco nel fatturato, e questa pagina è l'elenco.

La domanda, ogni volta che si aggiunge un campo: **il worker lo obbedisce? il prezzo lo vede?**
Se la prima risposta è sì e la seconda è no, o si prezza o si mette un tetto.

## Il quadro

| Campo | Il worker lo obbedisce | Il prezzo lo vede | Stato |
|---|---|---|---|
| `duration_s` | sì | **sì** | prezzato |
| `style` | sì | **sì** (`STYLE_CREDITS`) | prezzato |
| `template` | solo come limiti di durata | via durata | a posto |
| `language`, `voice` | sì | no | **innocuo**: è voce, costa CPU, non GPU |
| `notify_email` | no (solo il server) | no | a posto |
| `prompt` | no (lo legge il pianificatore) | no | a posto (quota Workers AI, non GPU) |
| `format` | **sì, e cambia i pixel** | no | ⚠️ **falla aperta** |
| `storyboard.*` shot con `image_prompt` | **sì, una immagine ciascuno** | no | ⚠️ **falla aperta** |
| `storyboard.*` testo parlato | **sì, e decide la durata vera** | no | ⚠️ **falla aperta** |
| `storyboard.backdrop` | sì (clip generate) | no | ✅ chiusa l'11/9: la mette il piano, quella del client si cancella |
| `storyboard.fps` / `width` / `brand` | sì | no | ✅ chiuse: `storyboard.ts` le cancella (righe 857, 1119) |
| `storyboard.id` / `script_file` / `music_quiet` | sì | no | ✅ chiuse: `FORBIDDEN_FIELDS` |
| `storyboard.image` sulle scene | sì | no | ✅ chiusa: `FORBIDDEN_SCENE_FIELDS` |

## Le tre falle aperte, in ordine di quanto costano

### 1. `format` — lo stesso credito compra quattro volte i pixel

`worker/kleo_worker.py:54-55`: il verticale si disegna a **2160** di larghezza, l'orizzontale a
**1920**. Cioè 2160×3840 contro 1920×1080: **quattro volte i pixel per fotogramma**, a parità di
durata e quindi a parità di crediti. Il formato lo sceglie il client (dentro i formati che il
template permette).

Non è un abuso: è il listino che non descrive il lavoro. O il verticale costa di più, o si
riconosce che il prezzo di uno Short è già calcolato sul caso caro e l'orizzontale è in regalo —
ma va deciso, non subìto. Nota che il 16:9 **non è in 4K** oggi, e alzarlo (`KLEO_WIDTH_LANDSCAPE`
a 3840) quadruplica il lavoro per fotogramma anche lì: quel giorno questa riga diventa la più
cara di tutte.

### 2. Il numero di immagini non ha tetto sullo storyboard del client

`MAX_PICTURES(durata)` è 24 per uno Short e 48 per un video lungo, e sta in due soli posti:

- `src/images.ts:259` — `pictureScenes(sb).slice(0, MAX_PICTURES(...))`, che taglia **la lista che
  disegna il server**, non quella che disegna la GPU;
- `src/guide.ts:108` — un consiglio in inglese all'autore dello storyboard.

`validateStoryboard` non lo importa nemmeno. Il validatore accetta **2–240 scene**
(`keou-contract.ts:712`) con 1–4 shot per scena cinema, e ogni shot con un `image_prompt` è una
immagine che qualcuno deve disegnare. Con `IMAGE_SERVER_MAX=0` le disegna **tutte la GPU
noleggiata**. Uno Short da **1 credito** può quindi chiedere centinaia di immagini.

### 3. La lunghezza del parlato non ha tetto sullo storyboard del client

`wordBudget()` è chiamata da `guide.ts:213`, `mcp.ts:143` e `storyboard.ts:348` — cioè quando il
**server** pianifica o quando **consiglia**. Mai dal validatore. Le scene le tempra il TTS vero,
non il `duration_s` su cui è stato fatto il prezzo: uno "Short da 90 secondi" può contenere dieci
minuti di parlato, e la macchina lavora finché non scade il timeout.

## Cosa le limita oggi, e perché non basta

Solo due cose, ed entrambe sono reti di sicurezza, non prezzi:

- `jobTimeoutMin` — 60 minuti per uno Short, poi la GPU viene distrutta e i crediti restituiti;
- `DAILY_GPU_BUDGET_USD` — 1,00 $ al giorno, in tutto.

Cioè: **un solo account gratuito, con i suoi 2 crediti, può arrivare a consumare l'intero tetto
giornaliero.** Che è precisamente il buco che i 2 crediti gratis dovevano chiudere.

## La cura, e dove va messa

Non nel validatore: quella è una regola di **contratto** ("questo storyboard è scritto male"), e
questa è una regola di **prezzo** ("questo storyboard chiede più lavoro di quello che hai
pagato"). Va in `createJob` (`src/jobs.ts`), **prima dell'addebito**, e rifiuta senza addebitare:

> this storyboard asks for 84 pictures and a 45-second video allows 24 — split it into shorter
> videos, or ask for a longer one. Nothing was charged.

Stessa forma per le parole contro `wordBudget(durata).max`. È dove stanno già tutte le altre
difese sui soldi: il controllo sta dove stanno i crediti, non dove sta il testo.

**Non ancora scritta.** Una modifica non verificata sul percorso dei soldi è il modo in cui si fa
il danno mentre lo si ripara, e la verifica vuole una macchina noleggiata (sei minuti, un
centesimo) che l'11 settembre alle 03:30 non si poteva aprire: credito a 1,06 $ e un render di
produzione in corso.

## La regola, per chi aggiunge il prossimo campo

Un campo che il client può scrivere e che cambia cosa fa il worker **deve** passare da una di
queste tre porte, e va scelta nello stesso commit che aggiunge il campo:

1. **lo cancella il server** (come `fps`, `width`, `brand`, `backdrop`), oppure
2. **lo vede il prezzo** (come `duration_s` e `style`), oppure
3. **ha un tetto fatto rispettare prima dell'addebito** (come dovranno avere immagini e parole).

Non ce n'è una quarta. Un campo che non passa da nessuna delle tre è lavoro regalato, e lo si
scopre dal saldo di Vast, non dai log.
