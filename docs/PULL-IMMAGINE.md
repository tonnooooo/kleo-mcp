# Perché una macchina noleggiata sta venti minuti senza fare niente (11 settembre 2026)

Un video generato costa circa quaranta minuti dal noleggio al link. **Fino a metà di quel tempo la scheda è accesa,
pagata, e non sta ancora renderizzando niente**: sta tirando giù e scompattando l'immagine del worker. È il singolo
pezzo più grosso del tempo di consegna e nessuno lo guarda, perché non produce log interessanti.

Questo documento esiste perché la misura era stata fatta il 10 settembre e viveva in una cartella temporanea. Una
diagnosi che sta in `/tmp` è una diagnosi che muore con la sessione che l'ha scritta.

## La misura

`ghcr.io/tonnooooo/kleo-worker:keou`, riverificata dal registro l'11 settembre:

| | |
|---|---|
| strati | 23 |
| totale compresso | **7,8 GB** |
| scompattato | ~11,5 GB |
| strato più grosso | **4,25 GB** (base pytorch/conda) |
| secondo | **2,72 GB** (dipendenze pip + modelli) |

Velocità misurata da una macchina Vast (Wisconsin, banda reale 99 MB/s):

| | |
|---|---|
| ghcr.io serve a | 46,6 MB/s → 7,8 GB in **circa 3 minuti** |
| il pull reale dura | **13-20 minuti** → 6,5 MB/s effettivi |

**Quindi non è la rete.** Sette volte più lento di quanto la rete permetta, su un host che dichiara 1355 Mbit/s.
Il collo di bottiglia è la **scompattazione**: gzip lavora con **un thread per strato**, e due strati da soli fanno
7 GB dei 7,8. Prendere un host con più banda non sposta niente, ed è il motivo per cui `VAST_MIN_INET` non ha mai
migliorato i tempi di avvio quanto ci si aspettava.

## Le due leve, in ordine di efficacia

**1. Compressione zstd invece di gzip.** Si scompatta 3-5 volte più in fretta a parità di dimensione.

    buildx: --output type=registry,compression=zstd,force-compression=true

**RISCHIO, ed è il motivo per cui non è già stata tirata**: se il Docker delle macchine Vast è vecchio non capisce
zstd e il pull **fallisce del tutto**, invece di essere lento. Non si prova sulla produzione. Si costruisce un tag
separato (`:keou-zstd`), si noleggia una macchina e si misurano i due tag fianco a fianco. Lo strumento c'è già ed è
`scripts/pulltest.py`, che noleggia un'istanza per tag, guarda lo stato di Vast fino a `running` e distrugge tutto
alla fine, anche su Ctrl-C.

**2. Meno strati grossi.** 4,25 GB in un solo strato è un solo thread per tutta la sua durata. Spezzarlo fa lavorare
la scompattazione in parallelo, e la base slim è la strada già aperta per questo.

## Una fragilità separata, trovata mentre si cercava altro

La produzione tira `ghcr.io/tonnooooo/kleo-worker:keou`, che è un tag **mutabile**, e `worker-image.yml` lo
**riscrive a ogni push su main** che tocchi `worker/**`. Cioè un commit può cambiare l'immagine sotto i piedi di un
render già partito.

**Attenzione a non concludere troppo**: questo NON spiega il fallimento di `gt_7f7gnsjt` dell'11 settembre. Quel job
ha fallito tre volte, e il secondo tentativo (14:50-15:13 UTC) è andato male senza nessuna ricostruzione in corso.
La causa di quei tre fallimenti resta ignota. La fragilità del tag mutabile è vera lo stesso e va chiusa lo stesso,
fissando il **digest** al momento del noleggio invece del nome del tag: così un job rende sempre con l'immagine con
cui è partito, qualunque cosa succeda su main nel frattempo.

## Cosa NON è il problema

- **Non è la banda dell'host.** Misurato: 46,6 MB/s disponibili contro 6,5 MB/s effettivi.
- **Non è ghcr.io.** Serve alla velocità che la rete permette.
- **Non è la dimensione in sé.** 7,8 GB a 46 MB/s sono tre minuti. Il tempo se ne va altrove.
