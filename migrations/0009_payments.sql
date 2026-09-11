-- Un pagamento riuscito, uno per riga, con l'id della sessione Stripe come CHIAVE PRIMARIA.
-- E' li' che sta l'idempotenza, e serve davvero: Stripe rimanda lo stesso evento finche' non riceve un 200, e
-- ritenta per giorni. Senza questa tabella un webhook lento o una risposta persa accrediterebbe due, cinque, dieci
-- volte lo stesso acquisto — e sarebbero crediti regalati che nessuno ha pagato.
-- L'accredito avviene SOLO se questa INSERT ha inserito davvero (changes = 1): l'unicita' della chiave e' la
-- guardia, non un controllo fatto prima e sperando che nel frattempo non arrivi il gemello.
CREATE TABLE IF NOT EXISTS payments (
  session_id  TEXT PRIMARY KEY,          -- cs_live_... di Stripe
  user_id     TEXT NOT NULL REFERENCES users(id),
  credits     INTEGER NOT NULL,
  amount_cent INTEGER NOT NULL,
  currency    TEXT NOT NULL,
  email       TEXT,                      -- quella che Stripe ha raccolto: l'unico modo per ritrovare un account anonimo
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id, at);
