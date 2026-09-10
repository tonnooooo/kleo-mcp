-- Le macchine gia' provate per QUESTO video, come lista JSON di chiavi ("m:<machine_id>" quando l'host fisico e'
-- noto, "o:<offer_id>" altrimenti). Senza questa colonna il requeue cancellava instance_id e instance_meta subito
-- prima del tentativo che avrebbe dovuto evitare quella macchina, e il tentativo successivo ripescava la stessa
-- offerta: appena l'istanza viene distrutta l'offerta torna libera, la ricerca ordina per prezzo e la rimette in
-- cima. Successo l'11 settembre 2026 sul job gt_7f7gnsjt, terzo tentativo sullo stesso offer 44217727 che il
-- secondo aveva appena dichiarato troppo lento.
-- Rispecchia la voce ["jobs", "tried_machines", "TEXT"] di schema.ts ensureColumns. Applicare PRIMA di distribuire
-- un Worker che la contiene; sono sicure in quest'ordine (ensureColumns ingoia "duplicate column", questa no).
ALTER TABLE jobs ADD COLUMN tried_machines TEXT;
