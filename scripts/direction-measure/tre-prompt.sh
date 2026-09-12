#!/usr/bin/env bash
# I QUATTRO NUMERI CHE MANCANO, CON UN COMANDO SOLO, DA WORKTREE PULITI.
#
# Tre prompt di fase 0 e zero misure valide sul modello di produzione (docs/SCELTA-DEL-LOOK.md). Questo script
# li misura tutti nello stesso lotto, cosi' il confronto non attraversa giorni diversi:
#   1. 0a30b4a  (in produzione)   due volte di fila: la prima e' il numero, la seconda e' la soglia di rumore
#   2. 111c205  (ramo parts-first) una volta
#   3. 6f153e1  (il "prima")       una volta, se i neuroni bastano
#   4. d9d8216  (ramo confident)   una volta: aggiunge una frase al prompt, e un prompt diverso si misura
# ~7.000 neuroni su 10.000: si lancia a quota piena e da UNA sessione sola, con la riga in QUOTA.md prima
# (lo script la scrive lui, e run.mjs scrive quella a fine corsa).
#
# Ogni prompt gira nel suo worktree staccato sul suo commit, con il suo banco su una porta sua. Mai dalla cartella
# condivisa: la prima corsa di questa storia e' stata buttata perche' il banco impacchettava una cartella in cui
# un'altra sessione stava scrivendo il prompt, e wrangler dev ricarica a ogni salvataggio.
#
#   KLEO_SESSION="BOSS/regia" bash scripts/direction-measure/tre-prompt.sh            # tutto
#   KLEO_SESSION=... DRY=1 bash scripts/direction-measure/tre-prompt.sh               # solo la macchina, zero neuroni
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${CLOUDFLARE_ACCOUNT_ID:=e4a5a1308df5b44c65497b85210c6845}"
: "${KLEO_SESSION:?scrivi chi sei: KLEO_SESSION=\"BOSS/regia\"}"
export CLOUDFLARE_ACCOUNT_ID KLEO_SESSION
BASE=/tmp/kleo-tre-prompt; mkdir -p "$BASE"
OUT="$ROOT/scripts/direction-measure/results"; mkdir -p "$OUT"
STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
LEDGER="$ROOT/scripts/direction-measure/QUOTA.md"

# commit | etichetta | porta | ripetizioni
LOTTO=(
  "0a30b4a|produzione|8791|2"
  "111c205|parts-first|8792|1"
  "6f153e1|prima|8793|1"
  "d9d8216|confident|8794|1"     # ramo regia/confident: una frase in piu' nel prompt, quindi un prompt diverso
)

cd "$ROOT"; git fetch -q origin 'refs/heads/*:refs/remotes/origin/*' 2>/dev/null || true
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill -TERM -- "-$p" 2>/dev/null || true; done; sleep 1; for p in "${PIDS[@]:-}"; do kill -KILL -- "-$p" 2>/dev/null || true; done; for riga in "${LOTTO[@]}"; do IFS='|' read -r _ _ PORTA _ <<<"$riga"; fuser -k -KILL "$PORTA/tcp" >/dev/null 2>&1 || true; done; sleep 1; }
trap cleanup EXIT

echo "    $(date -u +%Y-%m-%dT%H:%MZ) | $KLEO_SESSION | tre-prompt.sh: lotto 0a30b4a x2, 111c205, 6f153e1, d9d8216 su scout | 135 | ~7000 stimati | IN CORSO" >> "$LEDGER"

for riga in "${LOTTO[@]}"; do
  IFS='|' read -r COMMIT NOME PORTA REP <<<"$riga"
  W="$BASE/$COMMIT"; rm -rf "$W"; git worktree prune
  git worktree add --detach "$W" "$COMMIT" >/dev/null 2>&1
  ln -sfn "$ROOT/node_modules" "$W/node_modules"
  [ "$(git -C "$W" status --porcelain | grep -v node_modules | wc -l)" = 0 ] || { echo "worktree $COMMIT sporco: mi fermo"; exit 1; }
  # IL PROMPT DAL COMMIT, IL BANCO DA OGGI. Il worktree fornisce src/, cioe' cio' che si misura; il Worker del banco
  # e la sua config vengono dalla cartella corrente, perche' i commit vecchi non hanno la rotta GET di salute (e
  # 6f153e1 nemmeno la guardia che impedisce ad adaptation.mjs di chiudere il processo all'import).
  cp "$ROOT/scripts/direction-measure/worker.ts" "$ROOT/scripts/direction-measure/wrangler.jsonc" "$W/scripts/direction-measure/"
  # LA PORTA SI LIBERA CON fuser -KILL, MAI CON pkill -f: il trap uccideva la subshell e non i workerd figli di npx;
  # pkill -f "--port N" ha ucciso la shell che lo lanciava, perche' il pattern stava anche nel suo comando; e a
  # TERM un workerd e' sopravvissuto. fuser uccide chi tiene la porta e nient'altro.
  fuser -k -KILL "$PORTA/tcp" >/dev/null 2>&1 || true; sleep 1
  (echo > "/dev/tcp/127.0.0.1/$PORTA") 2>/dev/null && { echo "porta $PORTA ancora occupata: mi fermo"; exit 1; }
  # setsid: il banco e' un gruppo di processi a se' (npm -> sh -> node wrangler -> workerd). Uccidere il solo workerd
  # non serve: wrangler lo supervisiona e lo RILANCIA. Il cleanup uccide il gruppo intero con kill -- -PGID.
  setsid bash -c "cd '$W' && exec npx wrangler dev --remote -c scripts/direction-measure/wrangler.jsonc --port '$PORTA' --ip 127.0.0.1" >"$BASE/$COMMIT.log" 2>&1 &
  PIDS+=($!)
  for i in $(seq 1 40); do curl -sf -m 3 "http://127.0.0.1:$PORTA" >/dev/null 2>&1 && break; sleep 3; done
  curl -sf -m 3 "http://127.0.0.1:$PORTA" >/dev/null || { echo "banco $NOME ($COMMIT) non risponde: vedi $BASE/$COMMIT.log"; exit 1; }
  echo "== $NOME  commit $COMMIT  porta $PORTA  modello $(curl -s "http://127.0.0.1:$PORTA" | sed 's/.*"model":"\([^"]*\)".*/\1/')"
  if [ "${DRY:-0}" = 1 ]; then echo "   DRY: banco pronto, nessuna chiamata"; continue; fi
  for r in $(seq 1 "$REP"); do
    echo "-- corsa $r/$REP"
    BENCH="http://127.0.0.1:$PORTA" node "$ROOT/scripts/direction-measure/run.mjs" --variant baseline \
      --out "$OUT/$STAMP-$COMMIT-$NOME-corsa$r.json" | grep -E 'IL MODELLO|LA LISTA|neuroni|QUOTA' || true
  done
done
echo "risultati in $OUT/$STAMP-*  e righe in $LEDGER"
