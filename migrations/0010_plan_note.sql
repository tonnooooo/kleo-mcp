-- Cio' che il pianificatore voleva dire all'utente e non aveva dove: un look scelto senza esserne sicuro, un look
-- piu' caro voluto e rifiutato, un fatto promesso che la narrazione non dice. Scritta una volta da planOne, letta
-- dagli strumenti di stato. Rispecchiata in src/schema.ts (ensureColumns) per un database che questa migrazione non
-- raggiunge; qui perche' il database dei test nasce dalle migrazioni, e senza questa riga il tick non partiva.
-- Va applicata PRIMA del deploy del Worker che la scrive.
ALTER TABLE jobs ADD COLUMN plan_note TEXT;
