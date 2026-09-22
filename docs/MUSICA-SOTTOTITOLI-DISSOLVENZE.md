# Musica, sottotitoli e dissolvenze: le tre opzioni del 22 settembre 2026

Perché: il proprietario ha guardato la prima animatic del giorno (`gt_w4tuqvgh`, «La nascita di un'idea geniale»,
30 s, 16:9, chiesta da un utente via Grok) e ha detto tre cose. Rimettere **sottotitoli e musica**, non obbligatori,
ma **chiesti sempre**: se l'utente li vuole si mettono, se non li vuole no. Aggiungere **qualche dissolvenza**,
«molto clean, non bullshit», una o al massimo due su 30 secondi e di più su un film più lungo. E trovare gli errori
di quella chat. Questo documento è quello che ne è uscito. Il codice: `src/adaptive.ts` (le due domande),
`src/treatment.ts` (il passo 12 del metodo e il brief del compositore), `src/transitions.ts` (dove stanno le
dissolvenze), `src/footage.ts` e `src/internal.ts` (la traccia da kie.ai), `worker/kleo_worker.py` (`fetch_music`,
il mix), `worker/kleo_video.py` (`xfade_parts`), `worker/keou/engine/picture.js` (la dissolvenza dell'animatic),
`worker/keou/prepare.py` (le pause).

## 1. La scaletta ha due voci in più, e si chiedono sempre

`INTAKE` in `src/adaptive.ts` passa da quattro a sei voci obbligatorie:

| voce | domanda (it) | come si risponde nella chiamata |
|---|---|---|
| musica | Vuoi la musica sotto la voce? Se sì, di che tipo (un'atmosfera o un genere…); se no, dì no. | `music: "no"` oppure `music: "sì"` oppure `music: "pianoforte quieto"` |
| sottotitoli | Vuoi i sottotitoli impressi nel video (sì o no)? | `subtitles: "yes"` / `"no"` |

«No» è una risposta come le altre: viene scritta sul job (`params.music = null`, `params.subtitles = false`) e
onorata. Le due voci si leggono anche dalla richiesta quando lo dice («senza musica», «with subtitles»), il
negativo prima del positivo. Nel `kleo_create_video` gli stessi due argomenti (`music`, `subtitles`) portano la
risposta sul job; `applySoundOptions` in `src/treatment.ts` la applica al treatment, chiunque lo abbia scritto:
un sì ai sottotitoli fa nascere il livello (`graphics.subtitles: "cinema"`, hud vuoto), un no lo toglie; un sì alla
musica tiene il brief del treatment o, se manca, le parole dell'utente.

**«Stupiscimi».** Nella chat di Grok l'utente ha detto due volte «stupiscimi tu» e Kleo ha rifatto tre volte la
stessa domanda. Ora `adaptPrompt` riconosce la delega (`stupiscimi`, `scegli tu`, `surprise me`, `you choose`…),
toglie quelle parole dal soggetto e, al posto della domanda, dice all'assistente di **proporre 3-5 soggetti
concreti** nello stesso messaggio e di far scegliere. Non si rende niente finché l'utente non ha scelto: la regola
del credito resta.

## 2. La musica: una traccia da kie.ai (Suno), sotto la voce

Il treatment ha un campo in più, `music`: il **brief del compositore**, una riga (strumentale, genere o strumenti,
tempo, umore, come segue gli atti), scritta solo quando l'utente ha detto sì (passo 12 del master prompt; `THE
SOUND` nel messaggio dice cosa ha risposto l'utente). Lo storyboard lo porta come `music: "track"` +
`music_brief`; i due contratti accettano `bed | none | track`.

Sulla macchina: dopo il passo della voce (che per `track` scrive **silenzio** in `build/music.wav`, mai più il
letto sinusoidale), `fetch_music` chiede al server `POST /internal/jobs/:id/music {brief, seconds, title}`; il
server (`requestMusic`) crea **un task** su `https://api.kie.ai/api/v1/jobs/createTask` con modello
`ai-music-api/generate`, `custom_mode: true`, `instrumental: true`, `style` = brief + «no vocals, no lyrics…»,
`duration` = durata del film + 8 s, versione Suno da `KIE_MUSIC_VERSION` (default `V6`: `duration` è accettato solo con V5_5 o una V6, misurato il 22 settembre con una chiamata vera, 22 s per una traccia di 38,4 s; la risposta è nella forma di Suno, `data[].audio_url`, due tracce, si usa la prima). Prezzo letto dal listino
kie.ai: **12 crediti = 0,06 $ a richiesta**, scritti nella tabella `footage` con `shot_id = "music"` così il tetto
giornaliero li conta al momento dell'impegno (la riga è tolta dalle liste delle clip che la macchina legge). La
macchina fa `GET /music` finché `ready`, scarica `GET /music/file` (la traccia è copiata su R2 in
`renders/<job>/music.mp3` una volta sola), la **taglia alla durata del film** (loop se corta, fade in 1,2 s, fade
out fino a 3 s), la porta a `KLEO_MUSIC_LUFS` (default −27) e la scrive su `build/music.wav`. Il mix è quello di
sempre di `run.py`: la voce pulita, la musica **abbassata sotto ogni parola** dal sidechain, il tutto a −16 LUFS.
Il film senza livello passa per `MIX_CHAIN` in `kleo_worker.py`, che è la stessa catena.

Ogni rifiuto è **morbido**: niente chiave o `KLEO_MUSIC=off` (409), tetto giornaliero o conto vuoto (402), task
fallito, otto minuti senza risposta — il film esce **senza traccia**, con la riga nel log, mai senza film.
La musica è aperta anche all'animatic (6 centesimi), non solo al film pagato.

## 3. I sottotitoli

Erano già nella grammatica del livello (`subtitles: "cinema"`, sottili, bianchi, minuscoli, due righe, niente
karaoke, `hud.js`). Quel che cambia: **li decide l'utente**, non il treatment. Un sì crea il livello anche se il
film non ha altro da mostrare; un no li toglie qualunque cosa il livello porti. Il file `.srt` si consegna
**sempre**, anche per il film (prima il film puro non lo consegnava e `kleo_get_result` diceva «no subtitles»).

## 4. Le dissolvenze: una punteggiatura, non uno stile

`src/transitions.ts`: una dissolvenza sta **solo dove comincia un atto** (cambio di `chapter`), mai fra due shot
della stessa scena (picture.js aveva misurato cos'è una dissolvenza fra due immagini generate a caso: una doppia
esposizione), al massimo **una ogni 25 secondi** (30 s → 1, 60 s → 2, 120 s → 5), mai più dei confini d'atto
che il film ha, distribuite sulla lunghezza del film (il confine più vicino a k/(n+1), con le parole della voce
come orologio). Il segno è una parola sulla scena che entra: `transition: "dissolve"`. La mette `finishForProduct`
per entrambi i prodotti, quando conosce la durata.

Dura **0,8 s** (`DISSOLVE_S`, uguale a `DISSOLVE` in picture.js: il test lo tiene fermo). Nell'animatic
picture.js disegna l'ultima immagine dell'atto prima sotto la prima del nuovo, **che continua a muoversi** (il suo
Ken Burns corre su span + 0,8 s sia quando lo disegna la sua scena sia quando sta sotto: nessun salto sul
fotogramma del cambio). Nel film `render.mjs` scrive `transition` e `dissolve_s` in `build/shots.json`,
`build_footage` taglia l'ultimo shot dell'atto che esce 0,8 s più lungo e fonde le due parti con `xfade`
(`xfade_parts`): la traccia resta lunga esattamente quanto la timeline.

## 5. Gli errori trovati nella chat e nel video di Grok

- **30 s chiesti, 39,4 s consegnati.** Sei pause di 1,75-1,87 s (11 s di silenzio su 39). Causa: Kokoro
  restituisce ogni frase con ~0,5 s di vuoto in testa e in coda, più `lead` 0,22 e il pavimento landscape del
  `hold` (0,65 s, la soglia «editoriale» dello stile cinema). Ora `prepare.py` **taglia i bordi muti** della
  sintesi (tiene 0,12 s prima della prima parola e 0,18 dopo l'ultima, PRIMA dell'allineamento e della cache) e lo
  stile picture ha il suo pavimento (0,3 s; 0,9 sull'ultima scena). Atteso: le stesse frasi in ~32 s.
- **Contraddizioni sul prodotto.** Grok ha detto «niente sottotitoli né musica» (dalle istruzioni del server) e poi
  ha consegnato un link `subtitles.srt`; `kleo_get_result` diceva «No subtitles or music are delivered» mentre
  l'animatic li consegnava. Testi allineati: musica e sottotitoli a richiesta, `.srt` sempre.
- **«Stupiscimi» rifiutato tre volte.** Vedi §1.
- **Continuità delle immagini.** Il cast («mano con dita macchiate d'inchiostro, polsino di maglia marrone») compare
  in una sola inquadratura; la finestra guarda su un bosco all'alba e poi su Manhattan di notte; il «segno a
  matita» diventa fiori d'acquerello blu. È il limite noto degli still (RealVisXL, cast look): non è toccato qui.
- **Stima dei minuti incoerente** («15 minuti» al 22 %, «1 minuto» al 54 %, finito in 20). Non toccata.

## 6. Cosa non è ancora provato

Il primo film con traccia e sottotitoli renderizzato dopo il deploy è la prova che manca: il test Node prova la
strada del server con un kie.ai finto, i test Python provano il mix, la forma della traccia e la dissolvenza su
clip di 128×72 con ffmpeg vero, il test del motore prova le due immagini sotto la dissolvenza su un contesto 2D
registrato. Il formato del `input` di Suno e della risposta è stato esercitato con una chiamata vera (task `03d4a341…`,
0,06 $): `duration` vuole V5_5 o V6, la risposta è `data[].audio_url`.
