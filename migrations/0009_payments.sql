-- Un pagamento riuscito, uno per riga, con l'id della sessione Stripe come CHIAVE PRIMARIA.
-- E' li' che sta l'idempotenza, e serve davvero: Stripe rimanda lo stesso evento finche' non riceve un 200, e
-- ritenta per giorni. Senza questa chiave un webhook lento o una risposta persa accrediterebbe due, cinque, dieci
-- volte lo stesso acquisto. L'accredito avviene SOLO se questa INSERT ha inserito davvero (src/db.ts creditPurchase).
--
-- Due scelte che sembrano sbagliate e non lo sono:
--  · user_id e' ANNULLABILE e senza REFERENCES. Un pagamento il cui client_reference_id non corrisponde a nessun
--    account resta un pagamento che qualcuno ha fatto: va scritto lo stesso, altrimenti i soldi esistono e la
--    traccia no. I crediti, quelli, non vengono dati.
--  · payment_intent e' l'UNICO appiglio con cui arrivano rimborsi e contestazioni: quegli eventi portano un CHARGE,
--    mai l'id della sessione. Senza questa colonna risalire da una contestazione all'account non e' difficile, e'
--    impossibile. Aggiungerla adesso che la tabella e' vuota costa zero; dopo la prima vendita costa una
--    ricostruzione.
-- Rispecchia la riga di STATEMENTS in src/schema.ts: i due devono restare identici, o un database nuovo nasce
-- diverso da uno migrato.
CREATE TABLE IF NOT EXISTS payments (
  session_id     TEXT PRIMARY KEY,                 -- cs_... di Stripe
  user_id        TEXT,                             -- annullabile: vedi sopra
  credits        INTEGER NOT NULL DEFAULT 0,
  amount_cent    INTEGER NOT NULL,                 -- quello che Stripe dice essere stato pagato, non quello mostrato
  currency       TEXT NOT NULL,
  email          TEXT,                             -- raccolta da Stripe: l'unico modo di ritrovare un account anonimo
  payment_intent TEXT,                             -- pi_...: l'appiglio di rimborsi e contestazioni
  status         TEXT NOT NULL DEFAULT 'paid',     -- paid | refunded | disputed
  country        TEXT,
  event_id       TEXT,
  event_type     TEXT,
  raw_ref        TEXT,                             -- il client_reference_id com'e' arrivato, anche se non e' un account
  at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id, at);
CREATE INDEX IF NOT EXISTS payments_pi ON payments(payment_intent);
