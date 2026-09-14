# Nitidezza e concretezza: cosa è stato cambiato e cosa dice la misura (14 settembre 2026)

Direzione del proprietario, dopo i primi fotogrammi del livello grafico: «indirizza Kleo per qualità video: dettagli
nitidi, concretezza, nitidezza». Quattro punti descrivono l'immagine in Kleo, e tutti e quattro ora lo dicono:

| dove | cosa |
|---|---|
| prompt delle immagini fisse (`src/images.ts` = `worker/kleo_pictures.py`, tenuti uguali da un test) | suffisso «cinematic photograph, RAW photo, 35mm lens, natural light, sharp focus on the subject, real skin and fabric texture, high detail»; negativi con soft focus, cgi, 3d render, illustration, drawing, comic, anime, manga, line art, cartoon, painting, plastic skin, oversmooth |
| prompt delle clip kie.ai (`src/footage.ts` `KIE_LOOK` / `KIE_NEGATIVE`) | soggetto a fuoco nitido, tessitura reale delle superfici; negativi soft focus, cgi, 3d render, plastic, oversmooth |
| finitura 4K (`worker/kleo_video.py` `finish_vf`) | `unsharp=5:5:0.45` sulla sola luminanza dopo l'ingrandimento lanczos 2K → 4K (`KLEO_SHARPEN`, 0 = spento) |
| metodo del treatment (`src/treatment.ts`, VISUAL LANGUAGE) | «concrete and sharp»: superfici reali che la camera tiene a fuoco, un piano a fuoco per inquadratura, niente di liscio o renderizzato |

## La misura (`scripts/sharpness-ab.py`, macchina noleggiata, stesso seme, 4 immagini SDXL della fixture Voyager)

Numero: varianza del laplaciano (energia dei bordi; più alto = più nitido). Non distingue una foto nitida da un
disegno a linee, e l'ha dimostrato.

| inquadratura | prompt 13 set | v1 «fine surface texture, high detail, photographic realism» | v2 «RAW photo, real skin and fabric texture» |
|---|---|---|---|
| cielo notturno dalla stazione | 258 | 304 (+18 %) | 257 (−1 %) |
| pannelli solari | 1276 | 1356 (+6 %) | 1066 (−16 %) |
| astronauta al portatile | 669 | **2622 (+292 %): era diventato un fumetto** | 612 (−9 %), fotografia |
| stazione all'alba | 156 | 200 (+28 %) | 136 (−13 %) |

Lettura onesta: sul generatore delle immagini fisse (SDXL base) **il prompt non è una leva di nitidezza**. La v1 ha
alzato il numero facendo scivolare lo stile verso l'illustrazione; la v2 tiene la fotografia e resta nel rumore
della misura. I negativi della v2 restano perché impediscono lo scivolamento visto con la v1. Le leve vere sono
altrove, in quest'ordine:

1. **Il modello delle immagini fisse.** SDXL base è del 2023; un fine-tune fotorealistico (RealVisXL, Juggernaut
   XL) o FLUX dà dettaglio e materia che nessun prompt tira fuori dal base. Serve una ricostruzione dell'immagine
   del worker e la stessa misura, con lo stesso script, prima di adottarlo.
2. **La finitura.** L'unsharp sulla traccia 4K è in produzione ma non ancora misurato su un film vero (serve
   kie.ai).
3. **Il prompt delle clip.** Idem: si giudica sul film.
