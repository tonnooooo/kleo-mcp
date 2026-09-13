-- Un video filmato si fa in due fasi su due macchine (13 settembre 2026): la GPU genera fotogrammi e riprese e
-- consegna un pacchetto (gen.tgz) su R2; poi una macchina da pochi centesimi l'ora stende la traccia 4K 60, mette
-- la voce, controlla e carica. Fino a oggi la scheda restava noleggiata anche per i 10-12 minuti di lavoro da CPU
-- di ogni film: un terzo del conto. `phase` dice quale delle due fasi il job aspetta: 'gen' (default) o 'finish'.
-- Rispecchia la voce ["jobs", "phase", "TEXT NOT NULL DEFAULT 'gen'"] di schema.ts ensureColumns.
ALTER TABLE jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'gen';
