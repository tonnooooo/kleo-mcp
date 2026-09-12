# Registro della quota gratuita di Workers AI (10.000 neuroni al giorno)

Chi misura sul modello scrive UNA RIGA PRIMA di lanciare e la aggiorna DOPO. Il secchio e' uno solo per tutte le
sessioni dell'account e nessuna vede le altre: il 12 settembre una sessione ha speso 1.550 neuroni credendo di
essere sola, un'altra i restanti 8.450, e la seconda corsa della prima e' morta alla prima richiesta. Un rifiuto
costa zero neuroni, ma una misura a meta' non vale niente.

Il file si chiamava QUOTA.log ed e' stato annunciato con quel nome a due sessioni: `*.log` e' nel `.gitignore`,
`git add -A` l'ha saltato senza dire niente, e per venti minuti il registro e' esistito solo in un worktree gia'
cancellato. Un file che git ignora non e' condiviso, e' privato per sbaglio.

`run.mjs` aggiunge la sua riga da solo a fine corsa (`KLEO_SESSION` nell'ambiente dice chi).

    UTC | sessione | cosa | richieste | neuroni (~50 su scout, ~130 sul 70B) | esito

    2026-09-12T22:25Z | BOSS/regia | fase 0, prompt 6f153e1, scout, 27 held-out | 28 | ~1550 | 19/27 = 70%
    2026-09-12T22:33Z | BOSS/regia | fase 0, prompt 0a30b4a, scout, ripetizione | 0 | 0 | RIFIUTATA 4006: quota finita da altri

## 2026-09-12/13 — KLEO-3 explainer (aggiunto a posteriori: il registro non esisteva ancora)

| ora UTC | sessione | richieste | perché | esito |
|---|---|---|---|---|
| 2026-09-12 ~22:30 | KLEO-3 | 27 × fase 0, modello **70B** (non produzione) | look-benchmark.mjs, prompt 0a30b4a | 22/27 — numero NON valido per la produzione, modello sbagliato |
| 2026-09-12 ~22:40 | KLEO-3 | ~200 (8 film completi, planner intero) | rigenerare gli 8 soggetti col blocco regole tagliato | 8/8 validi, 60,0 parole/film, 7,6 regole rotte |
| 2026-09-12 ~23:00 | KLEO-3 | 27 × fase 0, 70B | seconda corsa dello stesso benchmark | 22/27 |
| 2026-09-12 ~23:20 | KLEO-3 | 27 × fase 0, **scout** (prod.), ramo explainer/parts-first | prima misura sul modello vero | **0/27, tutte 429: quota esaurita** — spesa quasi tutta dalle ~250 chiamate sopra |

Lezione: ~8.400 dei 10.000 neuroni del giorno li ha presi questa sessione, senza che l'altra sessione che
misurava lo stesso prompt potesse vederlo. Da qui in poi: una riga qui PRIMA di lanciare.
