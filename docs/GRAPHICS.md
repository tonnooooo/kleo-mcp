# Il livello grafico adattivo: la "sezione HUD" riaperta (14 settembre 2026)

Perché: il 13 settembre il film realistico ha perso in un colpo tutto ciò che stava sopra l'immagine — didascalie,
pillole di capitolo, karaoke, musica — perché veniva tutto dal look, uguale per ogni soggetto, e un film sui pirati
portava i mobili di un explainer sulla cybersecurity. Il 14 settembre il proprietario ha chiesto di riaprire la
sezione HUD a una condizione: **che si adatti al prompt, senza la linea fissa dei vecchi template**. Quindi il
livello non è uno stile. È una **grammatica chiusa** di elementi che significano qualcosa, e il **treatment** decide
per ogni film se c'è un livello, quali elementi ha, cosa vuol dire ciascuno e di che colore è scritto. "Nessuno" è
una risposta legittima, e la più comune per un film che è un luogo, un volto o una cosa.

Il codice: `src/graphics.ts` (la grammatica, i controlli, le riparazioni, le parole che legge il modello),
`src/keou-contract.ts` e `worker/keou/contract.py` (il rifiuto di uno storyboard fuori grammatica, sui due lati),
`src/treatment.ts` (l'undicesima decisione del master prompt), `src/storyboard.ts` (le scene scritte sotto il
livello), `worker/keou/engine/hud.js` (il disegno), `worker/kleo_worker.py` (`film_overlay`: il motore sopra il
girato).

## 1. La grammatica

| elemento | cos'è | cosa decide ogni scena |
|---|---|---|
| **line** | una linea sottile lungo il bordo basso o alto, con un solo significato per tutto il film ("la salute del collegamento") | lo **stato**: `steady`, `pulse` (un impulso che viaggia), `square` (un'onda 1 0 1 0 che scorre), `broken` (frastagliata, deterministica), `flat`, `off` |
| **readout** | un blocco monospazio in un angolo, 1-4 righe con etichetta fissa e valore | i **valori**, uno per riga (`EARTH 2023-11-14 · VOYAGER 2023-11-13 · ONE-WAY 22h 34m`) |
| **stamp** | una riga di maiuscole spaziate in un angolo (luogo, data, ora) | il **testo** |
| **cards** | un numero o una data che lo spettatore deve LEGGERE, da solo, al centro, su un velo scuro, per circa due secondi | al massimo **una per scena**, agganciata a una parola della voce come uno shot (`at`) |
| **subtitles** | `cinema` (sottili, bianchi, minuscoli, due righe al massimo, niente karaoke) o `none` — dal 22 settembre li decide **l'utente** (la scaletta li chiede sempre; un sì crea il livello anche vuoto, vedi `docs/MUSICA-SOTTOTITOLI-DISSOLVENZE.md`) | — |
| **chapters** | `film` (il capitolo della scena in maiuscole leggere dietro una riga d'accento) o `none` | — |
| **accent** | un colore esadecimale preso dalla palette del film: l'unico inchiostro del livello | — |

Al massimo tre elementi persistenti. Niente icone, niente loghi, niente sottopancia, niente frasi sulle card, niente
musica: quello che la grammatica non nomina non esiste. Le misure stanno in `GL` (`src/graphics.ts`) e sono le stesse
che il prompt stampa, il validatore impone e il motore disegna.

## 2. Come nasce, film per film

1. **Il treatment decide.** Il master prompt ha un'undicesima decisione, "THE LAYER": il modello risponde
   `"graphics": {"layer":"none"}` oppure `"layer"` con accento, sottotitoli, capitoli e gli elementi con il loro
   significato. Un livello si guadagna il posto solo quando il film parla di qualcosa che va letto: un numero che
   cambia, una data, un ritardo, una distanza, uno stato che regge per tutto il film.
2. **Le scene lo riempiono.** Il blocco del livello entra nel prompt delle scene, lo schema JSON offre esattamente gli
   id di questo film, e ogni scena scrive `hud` (stato o valori per ciascun elemento, che cambiano solo quando la
   storia li cambia) e `cards` (una al massimo). Il pianificatore ripara ciò che non torna: un elemento che non
   esiste sparisce, i valori in più si tagliano, una card con l'aggancio sbagliato apre con la scena.
3. **Lo storyboard lo porta.** `graphics` in cima, come `direction`; `hud` e `cards` sulle scene. Il validatore
   rifiuta una scena che parla a elementi che il film non ha, e uno storyboard con `hud` senza `graphics`.
   `music` diventa `none`: un film col livello passa dal mix del motore, che altrimenti gli metterebbe sotto il
   vecchio letto musicale.
4. **Il worker lo disegna.** Sulla macchina di finitura, se il progetto ha `graphics`, `film_overlay` rimette il
   fondo video (il girato è su disco), crea `music.wav` di silenzio (il pacchetto non lo porta) e lancia il motore
   con `--skip-voice`: `hud.js` disegna il livello su tela trasparente, `render.mjs` lo compone sopra
   `build/footage.mp4` dentro il codificatore e mette il mix. `out/master.mp4` è il film. Senza `graphics` il
   film si mixa come prima e il motore non parte.

Un treatment scritto da un assistente (la strada gratuita, vedi `docs/ADAPT-PROMPT.md`) può portare il livello
allo stesso modo: `kleo_create_video` lo controlla con le stesse parole.

## 3. Cosa costa

Il livello si disegna a 4K 60 fps con Chromium: sulla macchina di finitura servono i 16 core che il noleggio già
chiede (`VAST_MIN_CPU`), e circa i tempi del vecchio render (misurati il 10 settembre: 8 minuti per uno Short di 40
secondi con 16 worker). Un film senza livello non paga niente di questo.

## 4. Cosa è provato e cosa no

Provato in CI (`test/graphics.test.mjs`, `worker/test_kleo_worker_graphics.py`): la grammatica e i rifiuti in
parole; il contratto sui due lati con lo stesso film e gli stessi errori; il treatment che porta il livello; il
pianificatore che lo scrive dal treatment, lo chiede alle scene con lo schema di questo film, lo ripara e lo mette
nello storyboard senza musica; il blocco puro di `hud.js` (dove stanno gli elementi, la forma della linea in ogni
stato, quando parte una card, senza tela e senza orologio); il cablaggio di `film.html` e `picture.js`; il worker
che manda al motore un film col livello e lascia stare gli altri.

**Non ancora provato: un fotogramma vero.** Il disegno si giudica guardandolo: un render su una macchina noleggiata
(`scripts/devrender.py` con `test/fixtures/realistic-layer.json`) è il passo che manca prima di un film reale.
