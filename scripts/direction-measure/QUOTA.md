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
