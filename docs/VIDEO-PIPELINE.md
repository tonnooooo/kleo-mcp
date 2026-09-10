# Generated video — how a shot becomes footage (11 settembre 2026)

Perché: fino a ieri lo stile realistico era una fotografia con sopra uno zoom lento. Il proprietario l'ha bocciato
con una frase esatta: «non sono neanche dei video, sono delle immagini con lo zoom». Questo documento è la catena
che lo sostituisce, e ogni numero qui dentro è misurato su GPU noleggiata, non stimato.

## 1. Il modello, e perché proprio quello

`Wan-AI/Wan2.2-TI2V-5B-Diffusers`, Alibaba, **licenza Apache 2.0**.

Non è il modello aperto più forte in classifica. È l'unico su cui si possa costruire un'azienda europea che vende
video: HunyuanVideo e MiniMax Hailuo hanno licenze «community» il cui territorio **esclude esplicitamente l'Unione
Europea**, e FLUX vieta l'uso commerciale dei risultati senza contratto. Il divario di qualità che accettiamo è
reale (siamo dalle parti di Kling 1.6, non di Kling 3.0) ed è un prezzo consapevole.

Requisiti hardware, misurati:

| scheda | memoria | esito |
|---|---|---|
| RTX PRO 4000 Blackwell | 24 GB | **OutOfMemory** a 1280×704, 49 fotogrammi |
| RTX 6000 Ada | 48 GB | gira, ~125 s per clip da 2 s |
| Tesla V100 | 32 GB | **da evitare**: compute 7.0, niente bf16 né flash attention, ~5× più lenta |

Da cui il vincolo per il noleggio: **almeno 32 GB di memoria e compute capability ≥ 8.0**, mai il filtro per nome
della scheda (esistono 4090 modificate da 48 GB: il nome mente, il numero no).

## 2. Le due misure che governano tutto

**a) Il movimento è vero.** Su ventuno clip, la quota di movimento spiegabile con un modello di zoom puro
(R² di un fit radiale sul flusso ottico) è compresa fra **0,00 e 0,03**. L'effetto Ken Burns che sostituiamo
segna ~1,0 sulla stessa misura. Quando Wan muove qualcosa, lo muove in profondità: il primo piano scorre più
veloce dello sfondo, ed è esattamente ciò che una foto ingrandita non può fare.

**b) Circa un quarto delle clip torna FERMA, e non è colpa del testo.** Questa è la scoperta che ha cambiato il
progetto. Prove controllate sulle tre inquadrature fallite, quattro varianti ciascuna a parità di seme:

| variante | strada | bussola (gru) | bussola (carrello) |
|---|---|---|---|
| base | 31,7 | 78,3 | **4,9** |
| + vita nella scena | 20,1 | 106,3 | **9,3** |
| + aderenza al prompt 6,5 e 40 passi | 30,3 | 92,9 | **4,0** |
| tutto + clip lunga | **15,3** | 96,6 | 88,9 |

(px di viaggio del fotogramma; sotto ~20 è un fermo immagine)

Nessuna leva funziona in modo coerente: aggiungere vita ha aiutato un caso e peggiorato l'altro, alzare
l'aderenza non ha fatto nulla. E la stessa identica descrizione della bussola ha dato **0,27 px con un seme e
1,63 con un altro**. Il congelamento è in buona parte **stocastico**.

Conseguenza pratica, e vale per chiunque scriva prompt in questo progetto: **nessuna regola sul testo può
eliminarlo.** Una regola sul testo serve — toglie di mezzo le descrizioni che sono ferme *per scrittura* — ma deve
essere permissiva, perché un cancello severo rifiuterebbe roba buona per un difetto che nel testo non c'è.

## 3. La catena, stadio per stadio

1. **Prompt** (`worker/kleo_video.py`, `build_prompt`): soggetto per primo, poi il look, poi la camera. Il modello
   legge l'inizio con più peso. Ogni movimento porta le sue negazioni («carrello in avanti, NON uno zoom digitale,
   NON una carrellata indietro»), disciplina copiata da come Higgsfield istruisce i propri preset.
2. **Vita**: se la descrizione non nomina nulla che si muova, ne riceve una, in modo deterministico. Invariante
   obbligatoria: *ogni frase che il modulo può aggiungere deve essere riconosciuta come viva dalla regola stessa*,
   altrimenti la riparazione si accumula a ogni passata. (La chat della direzione artistica ci è cascata: la sua
   frase «clouds moving across the sky» non era riconosciuta e l'inquadratura riparata risultava ancora ferma.)
3. **Generazione**: 1280×704 (16:9) o 704×1280 (9:16), 4n+1 fotogrammi a 24 fps, massimo ~5 s perché oltre la clip
   comincia a derivare. Seme derivato dall'id dell'inquadratura: la stessa inquadratura dà sempre la stessa clip.
4. **Misura e rigenerazione**: otto campioni di flusso ottico su una copia a 320 px, meno di un secondo contro i
   ~125 s che la clip è costata. Sotto i 18 px di viaggio la clip è un fermo immagine e viene rigenerata con un
   altro seme, fino a due volte. Soglia calibrata su ventuno clip giudicate anche a occhio: tutto ciò che un
   umano chiama fermo sta fra 1,8 e 13,6; la più debole che qualcuno ha chiamato viva sta a 17,5.
5. **Rifinitura**: taglio di testa e coda (una clip generata si assesta nei primi fotogrammi e deriva negli
   ultimi), **interpolazione a 60 fps con compensazione di movimento e solo dopo** l'ingrandimento Lanczos alla
   misura di consegna. Quest'ordine non è un dettaglio: la stima del movimento legge ogni pixel, e i fotogrammi che
   inventa li decide da dove si spostano le cose, non da quanti pixel le descrivono. L'ordine opposto era stato
   misurato a ~7 minuti di scheda pagata per clip; questo è circa **undici volte più veloce** e il risultato è
   indistinguibile. **Non** un ingrandimento neurale: su materiale generato produce sfarfallio, costa minuti per
   clip, e la grana finale nasconde più di quanto quello avrebbe aggiunto.
6. **Montaggio** (`scripts/assemble.py`): dissolvenza incrociata di 0,35 s fra le inquadrature — è ciò che impedisce
   a otto generazioni indipendenti di sembrare otto video separati — e **una sola** correzione colore su tutto il
   film, mai per clip: neri sollevati, ombra fredda e alta luce calda, contrasto gentile, grana pellicola, matte
   2,00:1.

## 4. Costi e tempi, misurati

| | immagini ferme (oggi) | video generato |
|---|---|---|
| GPU per uno Short di 40 s | 0,067 $ | ~0,50 $ tipico, fino a ~1,50 $ nel caso peggiore |
| tempo dal noleggio al link | 23 min | ~40 min |
| per inquadratura | — | ~125 s, più le rigenerazioni |

Da cui: **7 crediti tipici, 10 come tetto**, e i video con movimento generato vanno **serializzati uno alla volta**
(due 6000 Ada in parallelo fanno 1,52 $/h, ed è l'unico modo in cui il credito può sparire senza che nessuno se ne
accorga).

## 5. La composizione, e dove vive

Il motore Keou disegna **solo grafica e testi su fondo trasparente** (canvas in `alpha: true`) e ffmpeg sovrappone
le due tracce dentro il codificatore che sta già girando per ogni worker: nessun passaggio intermedio con canale
alfa, e il testo a 4K finisce direttamente sul filmato a 4K. Si attiva **solo** per i progetti che dichiarano
`backdrop: "video"`; ogni altro stile renderizza esattamente come prima.

**L'ordine è obbligato, ed è il motivo per cui la catena vive nel worker e non nel motore.** I tempi di stacco
appartengono al motore (`render.mjs --shots`), il motore non può calcolarli senza l'allineamento parola per parola
(`build/timeline.json`), e quell'allineamento lo produce il passaggio della voce. Quindi il worker: fa la voce,
chiede al motore quando stacca ogni inquadratura, gira le clip esattamente di quella lunghezza, monta la traccia,
e solo allora lancia il render con `--skip-voice` sull'allineamento già su disco. La misura del fotogramma esce dal
piano del motore e **non viene mai ricalcolata**: un fotogramma calcolato due volte è un fotogramma che può
discordare una volta, e il filmato sta esattamente sotto il testo.

**La rinuncia è il cuore del disegno.** Se anche **una sola** inquadratura non si gira, il fondo video viene tolto
dal progetto e il film si disegna dalle immagini ferme, esattamente come prima che tutto questo esistesse. Non è
prudenza, è il contratto: `contract.py` rifiuta un fondo video con una clip mancante, e lo verifica in cima a
`run.py` — dopo aver noleggiato la scheda, scaricato il modello e pagato tutte le altre clip. Un worker che attacca
il fondo e dimentica una clip non produce un video brutto: non produce nessun video, e l'utente paga lo stesso.

## 6. Quello che manca ancora

**Il 16:9 non è 4K.** `KLEO_WIDTH_LANDSCAPE` è 1920, quindi un video orizzontale esce a 1920×1080; il verticale
esce a 2160×3840. Il proprietario ha chiesto «sempre 4K»: portarlo a 3840 quadruplica i pixel che Chromium disegna
per ogni fotogramma, quindi va **misurato su macchina noleggiata prima di cambiarlo**, non deciso a tavolino. È
l'unico punto in cui la consegna non corrisponde ancora a quello che è stato chiesto.

**La coda muta del render, e quanto e' larga davvero.** Fra l'ultimo `FRAME` stampato dal motore e `STAGE quality`
nessuno manda niente al server, e il server adesso spegne una scheda che tace da `RENDER_SILENCE_MIN` (20 min). In
quel tratto, e nei due successivi, ci sono **quattro passate complete sul master**, tutte mute:

| dove | cosa | costo |
|---|---|---|
| `render.mjs` linea 87 | `validPart(temp,total)` → ffprobe `-count_frames` | decodifica ogni fotogramma |
| `qa.py` linea 16 | ffprobe `-count_frames` | decodifica ogni fotogramma, **di nuovo** |
| `qa.py` linea 27 | ffmpeg `blackdetect` | decodifica ogni fotogramma, terza volta |
| `run.py` stage preview | ffmpeg libx264 verso 540/960 px | decodifica a 4K, ricodifica in piccolo |

Il montaggio finale **non** e' fra questi: usa `-c:v copy`, quindi e' rapido anche a 4K.

**Stima, dichiarata come stima.** A 250-700 fotogrammi al secondo di decodifica 4K, una passata su un video da otto
minuti a 60 fps sta fra **0,7 e 1,9 minuti**; quattro passate fra tre e otto. Cioe' **sotto i venti**, ma con un
margine che nessuno ha misurato: quei numeri di decodifica sono ipotesi, non misure su una macchina Vast.

Un Corto non e' in discussione (0,1-0,2 minuti a passata, e sono 27 job su 29). Il rischio riguarda solo i video
lunghi, e sono due.

**Cosa fare, in ordine.** Prima misurare: il primo render 4K vero dice quanto dura davvero quella coda, e va
cronometrato apposta. Se serve un tampone prima, **non** alzare `RENDER_SILENCE_MIN` in blocco — allargarlo per
tutti paga in soldi il silenzio dei worker davvero morti — ma farlo **crescere con la durata**, che e' esattamente
la variabile da cui dipende la lunghezza delle quattro passate. La cura vera, se la misura dice che serve, e' far
parlare quelle operazioni: `-progress pipe:1` su ffmpeg da' un avanzamento reale, e la validazione a conteggio
fotogrammi puo' essere fatta da un ffmpeg che decodifica **e** riferisce, invece che da un ffprobe muto.

**L'immagine ferma come primo fotogramma.** Wan 2.2 TI2V accetta anche un'immagine di partenza. Oggi la clip nasce
dal solo testo, quindi la fotografia che il modello delle immagini ha già disegnato per quell'inquadratura viene
usata soltanto come rete di sicurezza. Partire da quella darebbe continuità fra i due modelli e toglierebbe una
variabile al congelamento stocastico. Non misurato.
