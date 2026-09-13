-- 13 settembre 2026: le clip di un film possono arrivare da kie.ai (Kling, Veo...) invece che dal modello sulla
-- scheda noleggiata. Una riga per inquadratura: task_id e' quello che il server chiede a kie.ai, `state` e' il nostro
-- (queued -> generating -> ready | failed), `key` e' la clip su R2 una volta scaricata, cost_usd e' la stima del
-- listino scritta alla CREAZIONE del task, cosi' il tetto giornaliero (DAILY_FOOTAGE_BUDGET_USD) conta i soldi nel
-- momento in cui vengono impegnati. Rispecchia la voce in schema.ts STATEMENTS.
CREATE TABLE IF NOT EXISTS footage (
  job_id TEXT NOT NULL,
  shot_id TEXT NOT NULL,
  model TEXT NOT NULL,
  task_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  seconds REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  result_url TEXT,
  key TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  PRIMARY KEY (job_id, shot_id)
);
CREATE INDEX IF NOT EXISTS footage_created ON footage(created_at);
