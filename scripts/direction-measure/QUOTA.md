# Registro della quota gratuita di Workers AI (10.000 neuroni al giorno)

Chi misura sul modello scrive UNA RIGA PRIMA di lanciare e la aggiorna DOPO. Il secchio e' uno solo per tutte le
sessioni dell'account e nessuna vede le altre: il 12 settembre una sessione ha speso 1.550 neuroni credendo di
essere sola, un'altra i restanti 8.450, e la seconda corsa della prima e' morta alla prima richiesta. Un rifiuto
costa zero neuroni, ma una misura a meta' non vale niente.

Il file si chiamava QUOTA.log ed e' stato annunciato con quel nome a due sessioni: `*.log` e' nel `.gitignore`,
`git add -A` l'ha saltato senza dire niente, e per venti minuti il registro e' esistito solo in un worktree gia'
cancellato. Un file che git ignora non e' condiviso, e' privato per sbaglio.

`run-rest.mjs` scrive una riga prima di partire e una a fine corsa (`KLEO_SESSION` nell'ambiente dice chi).

    UTC | sessione | cosa | richieste | neuroni (~50 su scout, ~130 sul 70B) | esito

    2026-09-12T22:25Z | BOSS/regia | fase 0, prompt NON ATTRIBUIBILE (banco avviato dalla cartella condivisa mentre un'altra sessione ci scriveva il prompt; wrangler dev ricarica a ogni salvataggio), scout | 28 | ~1550 | 19/27, DA BUTTARE
    2026-09-12T22:33Z | BOSS/regia | fase 0, prompt 0a30b4a, scout, ripetizione | 0 | 0 | RIFIUTATA 4006: quota finita da altri

## 2026-09-12/13 — KLEO-3 explainer (aggiunto a posteriori; stesso formato di run-rest.mjs)

    2026-09-12T22:30Z | KLEO-3 | fase 0, prompt 0a30b4a, 70B (NON produzione), 27 held-out | 27 | ~3500 | 22/27 = 81% — non valido: modello sbagliato
    2026-09-12T22:40Z | KLEO-3 | 8 film interi (planner completo), blocco regole tagliato | ~200 | ~4400 | 8/8 validi, 60,0 parole/film, 7,6 regole rotte
    2026-09-12T23:00Z | KLEO-3 | fase 0, prompt 0a30b4a, 70B, seconda corsa | 27 | ~3500 | 22/27
    2026-09-12T23:20Z | KLEO-3 | fase 0, ramo explainer/parts-first, SCOUT (produzione) | 0 | 0 | RIFIUTATA 4006: quota finita — spesa dalle ~250 chiamate sopra

Lezione: ~8.400 dei 10.000 neuroni del giorno li ha presi questa sessione senza che l'altra potesse vederlo.
Da qui in poi: una riga qui PRIMA di lanciare.

    2026-09-13T12:20Z | BOSS/treatment | treatment-make.mjs: 2 treatment su scout + 1 su gpt-oss-120b, richiesta "accuracy in medicine" 60 s | 3 | 0 | RIFIUTATA 4006 alle 12:16Z: quota gia' finita (job di produzione di altre sessioni); la misura sul modello vero resta da fare

    2026-09-13T13:05Z | BOSS/treatment | POST /internal/admin/treatment in produzione, "accuracy in medicine" 60 s, n=2, scout | 2 | ~350 se risponde | RIFIUTATA 4006 (quota ancora finita alle 13:05Z); la rotta funziona, la misura resta da fare dopo le 00:00Z
