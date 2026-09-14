# La modalità animazione (14 settembre 2026)

Direzione del proprietario, dopo aver visto come nascono i fotogrammi del realismo: «così deve fare per modalità
realismo e tipo animazione». Da oggi Kleo vende **due look dello stesso film**, `realistic` e `animation`, sulla
stessa pipeline: treatment → fotogramma di riferimento per ogni inquadratura → clip kie.ai animata da quel
fotogramma → montaggio 4K 60 fps con la voce e, se il treatment lo decide, il livello grafico. Il vecchio look
"cartoon" (illustrazione vettoriale piatta, SD1.5, immagini fisse zoomate, bocciato il 13 settembre) resta solo
nel codice interno e non è in vendita.

## Cosa decide il look

1. **Il treatment, al passo 0 del metodo.** Se la richiesta lo nomina (cartone, animato, anime, disegnato,
   «tipo Pixar» → animation; filmato, footage, documentario, fotografato → realistic) o lo fissa la chiamata,
   quello è il look. Altrimenti realistic, tranne quando il soggetto non si può fotografare (un animale che parla,
   una fiaba, un mondo che non esiste, l'interno di un corpo): allora animation, e la scelta finisce fra le decisioni.
2. **`style` sugli strumenti MCP** (`kleo_adapt_prompt`, `kleo_storyboard_guide`, `kleo_create_video`):
   `"realistic"` o `"animation"`. Omesso, decide il treatment; senza treatment, lo `kleo_style` dello storyboard;
   senza nessuno dei due, realistic. Se treatment e `style` non concordano, `kleo_create_video` rifiuta a parole
   prima di addebitare («look: the treatment says "animation" but the film was asked in "realistic"»).

## Cosa cambia per look

| punto | realistic | animation |
|---|---|---|
| metodo del treatment (VISUAL LANGUAGE) | superfici reali, un piano a fuoco | la linea, gli sfondi dipinti, i personaggi disegnati una volta in parole e ripetuti uguali, ombreggiatura cel, tre colori |
| regole del planner per le immagini (`PICTURE_RULES`) | «cinematic photograph» | «one frame of a 2D animated feature», niente di fotografico |
| guida per chi scrive lo storyboard | fotografia cinematografica | fotogramma di film animato 2D |
| suffisso dell'immagine fissa (`src/images.ts` = `worker/kleo_pictures.py`) | RAW photo, 35mm… | frame from a 2D animated feature film, hand-painted background, cel shading… |
| negativo dell'immagine fissa (`STYLE_NEGATIVE`) | vieta il disegno (illustration, anime, cartoon…) | vieta la fotografia (photograph, photorealistic, live action, real skin…) |
| prompt della clip kie.ai (`KIE_LOOKS` / `KIE_NEGATIVES`) | live-action, 35mm | hand-drawn character animation over painted backgrounds |
| modello dell'immagine fissa | SDXL base 1344×768 | SDXL-class, scelto con il confronto qui sotto |
| motore (tipografia del livello, capitoli) | famiglia cinema | famiglia cinema |
| prezzo | dalla lunghezza | dalla lunghezza, identico |

I contratti (`src/keou-contract.ts`, `worker/keou/contract.py`) accettano `kleo_style: "animation"` con lo stile
Keou `picture`; il worker lo scrive come `look: "animation"` del progetto e chiede a kie.ai le clip con quel look.

## Il modello dell'immagine fissa: la misura

`scripts/animation-models.py` (nella copia isolata del devbox) disegna gli stessi otto prompt (cinque dei pirati con
personaggi, tre di Voyager) con tre candidati SDXL, stesso seme, stesso suffisso, e produce un foglio affiancato per
prompt. Candidati: SDXL base (30 passi, guidance 6), DreamShaper XL v2 Turbo (8 passi, guidance 2, DPM++ SDE Karras),
Animagine XL 3.1 (28 passi, guidance 7, Euler a, con i suoi tag di qualità). Il giudizio è a occhio, del
proprietario: nessun numero distingue un bel fotogramma animato da uno brutto. Il modello scelto sta in
`worker/kleo_pictures.py MODELS["animation"]` e nella copia di `worker/prewarm_models.py`; i suoi passi, guidance e
sampler in `STEPS_BY_STYLE` / `GUIDANCE_BY_STYLE` / `SCHEDULER_BY_STYLE`. Il risultato del confronto è in fondo a
questo file quando c'è.

## Cosa manca

- Un film animato vero, fino in fondo: richiede la ricarica kie.ai (il proprietario ha detto di non usarla per ora).
- Il sito: `styles.html` mostra ancora la riga "Cartoon" del vecchio look. Va sostituita da una riga "Animation"
  con un campione vero, quando ci sarà il primo film animato.
- L'unsharp della finitura 4K (`KLEO_SHARPEN`) è tarato sulla fotografia; su linee e colori piatti va misurato.
