# Adapt prompt: il treatment (14 settembre 2026)

Perché: fino a ieri Kleo leggeva la frase dell'utente («create a video about accuracy in medicine») e passava
direttamente alla direction: soggetto, mondo, cast, oggetti, poi le scene. Nessun passaggio decideva **che film**
fosse. Due richieste identiche davano due video quasi uguali; una richiesta di sei parole dava un video generico.
Il proprietario ha chiesto la cosa che fa una casa di produzione: un **master prompt** professionale che trasforma
ogni richiesta nel film che un producer ne farebbe, con un margine di creatività per cui lo stesso prompt non dà
mai lo stesso film. Questo documento è quel passaggio. Il codice: `src/treatment.ts` (le parole, la forma, la
riparazione, la variazione), `src/storyboard.ts` (la chiamata, passo -1 del pianificatore, e `writeTreatment`),
`src/mcp.ts` (`kleo_adapt_prompt` e il campo `treatment` di `kleo_create_video`), `src/jobs.ts` (il controllo
all'ingresso).

## 1. Cos'è il treatment

È il documento che una produzione scrive prima della sceneggiatura. Per Kleo è un oggetto con dodici campi, tutti
decisi per QUESTA richiesta:

| campo | cosa decide |
|---|---|
| `logline` | il film in una frase con un verbo |
| `angle` | l'unica idea che il film sostiene («la precisione medica» è un soggetto, non un angolo) |
| `device` | il dispositivo narrativo (uno di otto, vedi §3) |
| `opening` | i primi tre secondi come immagine, non come frase |
| `acts` | da 2 a 7 atti con nome, scopo e secondi; i secondi sommano alla durata |
| `ending` | l'ultima immagine e cosa resta in mano allo spettatore |
| `visual` | obiettivo, luce, palette, ora del giorno, temperamento della camera: UN mondo |
| `pacing` | ritmo dei tagli atto per atto, e dove il film rallenta apposta |
| `narrator` | persona, tempo verbale, lunghezza delle frasi, cosa non dice mai |
| `motifs` | 2-5 immagini a cui il film torna |
| `decisions` | ogni scelta che la richiesta non chiedeva, in parole semplici, perché l'utente la veda e la cambi |
| `prose` | il treatment vero e proprio: 100-520 parole, dal primo fotogramma all'ultimo |

Più `variation`, l'estrazione con cui è stato scritto (§3), così due video dalla stessa richiesta si distinguono.

## 2. Il master prompt

`MASTER_PROMPT` in `src/treatment.ts` è il messaggio di sistema della chiamata. **È un metodo, non un testo da
copiare**: dice cosa Kleo sa girare (footage generato da un fotogramma, 4-12 s a inquadratura, una voce, niente
musica, niente scritte, niente sottotitoli, niente persone famose), le dieci decisioni che un producer prende in
ordine, la barra (la disciplina di una buona sequenza documentaria: concreta, a misura d'uomo, un'immagine forte
per battuta), le regole sui fatti (quelli della richiesta si tengono tutti; nessuna statistica, citazione, data o
nome inventati) e le parole vietate («stunning», «journey», «delve», «in a world where», i droni sulle città al
tramonto). Si modifica a mano, è fatto per essere letto da persone.

Il messaggio utente (`treatmentPrompt`) porta la richiesta tra virgolette, la lunghezza, il formato, la lingua,
l'estrazione e la forma JSON da restituire con i limiti di ogni campo (tabella `T`). Le risposte passano da uno
schema JSON chiuso (decodifica vincolata) e poi da `repairTreatment`: i secondi degli atti vengono riscalati alla
durata (un modello che scrive 70 s per un film da 60 ha scritto le proporzioni giuste e la somma sbagliata, e una
somma non è una cosa da ritentare), i nomi degli atti in maiuscolo, le liste tagliate, la prosa tenuta sotto il
tetto. Ciò che non è un treatment (logline mancante, un atto, prosa da dodici parole) viene rifiutato con
`treatmentProblems`, in parole che dicono il campo, e il secondo tentativo le riceve.

## 3. La variazione: perché due richieste uguali non danno lo stesso film

Per ogni film si **estraggono** un dispositivo narrativo (otto: cold-open-mystery, one-day, then-and-now,
the-object, countdown, question-and-reveal, the-witness, cause-to-consequence) e una famiglia di apertura (cinque:
in-medias-res, the-detail-first, the-wide-silence, the-contradiction, the-face). L'estrazione (`variationFor`) è
un hash dell'id del job: stabile per lo stesso video (una ripianificazione dopo una pausa di quota scrive lo stesso
film), diversa da un video all'altro. Il modello riceve l'estrazione come «make them work for this subject, never
mention them in the film»; se la richiesta impone lei una struttura (una lista, un confronto, un come-si-fa),
quella vince e il dispositivo resta un sapore. La chiamata gira a temperatura 0,85 (tutto il resto del
pianificatore resta a 0,3, perché direction e scene devono essere documenti validi). Sessanta job coprono almeno
sei dispositivi e quattro aperture (test).

## 4. Dove passa

```
richiesta → kleo_adapt_prompt → treatment (mostrato all'utente: logline + decisioni) → kleo_create_video(treatment)
                                                                                          ↓
                                          params.treatment → pianificatore: passo -1 SALTATO, direction e scene scritte SOTTO il treatment
richiesta → kleo_create_video (senza treatment) → pianificatore: passo -1 scrive il treatment, poi direction, outline, scene
```

- **Passo -1 del pianificatore** (`generateStoryboard`): prima della direction. Due tentativi, i problemi
  del primo passati al secondo; può fallire come la direction (un film senza treatment è quello che Kleo faceva
  fino al 13 settembre, non un film rotto); un errore di quota è l'errore di quota del pianificatore (il job
  aspetta). La direction e l'outline leggono il treatment **con la prosa**; le scene a blocchi solo il blocco
  strutturato (otto copie di quattrocento parole non comprano niente che una scena usi). Il treatment viaggia in
  cima allo storyboard come `direction`, arriva al worker e il motore lo ignora.
- **`kleo_adapt_prompt`**: prima legge lingua, durata e formato dalla richiesta senza modello (`src/adaptive.ts`)
  e, se manca il soggetto o la durata, risponde con la domanda e non spende niente. Poi chiede il treatment a
  Workers AI (`writeTreatment`, un'estrazione casuale perché il job non esiste ancora) e lo restituisce con la
  frase da dire all'utente e l'ordine di passarlo a `kleo_create_video` tale e quale, o modificato come l'utente
  chiede. Ogni chiamata finisce nell'audit come `treatment.adapt` (modello, tentativi, neuroni, estrazione).
  Tetto per account: `ADAPT_MAX_PER_DAY` (12 al giorno); con `plan_pause` attivo (quota finita) o modello muto
  risponde onestamente e rimanda a `kleo_create_video`, che scriverà il treatment da sé quando pianifica.
- **`kleo_create_video`** accetta `treatment`; `createJob` lo controlla con `treatmentProblems` (rifiuto in
  parole, niente addebitato), lo adatta con `repairTreatment` e lo mette in `params.treatment`. Con uno storyboard
  scritto dal client il pianificatore non gira, e il treatment viene attaccato allo storyboard lì.

## 5. Costo

Una chiamata in più per film. Stima sul modello di produzione (`llama-4-scout-17b`, 0,27 $/M in, 0,85 $/M out,
1 neurone = 0,000011 $): circa 3.000 token in ingresso e 1.200 in uscita, **~170 neuroni** (~0,002 $). Il tetto
gratuito è 10.000 neuroni al giorno: il treatment ne pesa il 2 %, un film intero (direction + outline + scene)
1.000-1.500. `TREATMENT_MODEL` permette un modello diverso solo per questa chiamata (candidato:
`@cf/openai/gpt-oss-120b`, 0,35/0,75 $/M, più adatto alla prosa lunga), ma **la scelta va misurata**, non
decisa a tavolino.

## 6. Cosa è provato e cosa no

Provato (CI, `test/treatment.test.mjs`): l'estrazione è deterministica e si distribuisce; il prompt porta richiesta
e estrazione; la riparazione riscala gli atti e tiene la prosa nei limiti; il rifiuto nomina il campo; nel
pianificatore il treatment è la prima chiamata, a 0,85 e sotto il master prompt, la direction e l'outline lo
leggono con la prosa, le scene senza, lo storyboard lo porta; due risposte cattive non rompono il film; un errore
di quota lo ferma; un treatment passato in `params` salta la chiamata.

**Non ancora misurato: la qualità sul modello vero.** Il 13 settembre alle 12:16 UTC la quota gratuita era già
finita (job di produzione di altre sessioni) e `scripts/treatment-make.mjs` è stato rifiutato con 4006. La misura
da fare, con una riga in `scripts/direction-measure/QUOTA.md` prima di lanciare:

```bash
node scripts/treatment-make.mjs "Create a video about accuracy in medicine" --n 3 --duration 60 --format 16:9 --out /tmp/treat
```

Stampa i tre treatment, i neuroni spesi e una **distanza** fra le prose (quota di parole non condivise: 0 = lo
stesso film, 1 = niente in comune; `proseDistance` in `src/treatment.ts`). Cosa guardare: che l'angolo sia
un'idea e non il soggetto ripetuto; che gli atti sommino alla durata; che nella prosa non compaia una statistica
che la richiesta non conteneva; che la distanza fra due corse sia sopra 0,5. Poi la stessa cosa con
`--model @cf/openai/gpt-oss-120b`, e si sceglie.

**Senza PC**: la stessa misura si fa dal server, da qualunque terminale o telefono con `INTERNAL_SECRET`, sul
modello che usa il Worker (niente conto utente, niente quota per account, finisce nell'audit come
`admin.treatment`):

```bash
curl -s -X POST https://mcp.kleooai.com/internal/admin/treatment -H "Authorization: Bearer $INTERNAL_SECRET" -H "content-type: application/json" -d '{"prompt":"Create a video about accuracy in medicine","duration_s":60,"format":"16:9","language":"en","n":3}'
```

Risponde con `written` su `asked`, i neuroni, `distance` (min e media), le logline, i treatment interi e, se il
modello non ha risposto, `transient: true` col motivo. `"model":"@cf/openai/gpt-oss-120b"` nel corpo prova
l'altro modello.
