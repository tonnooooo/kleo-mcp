#!/usr/bin/env bash
# I NUMERI CHE MANCANO, CON UN COMANDO SOLO, DA WORKTREE PULITI, SENZA BANCHI.
#
# Quattro prompt di fase 0 e nessuna misura valida sul modello di produzione (docs/SCELTA-DEL-LOOK.md). Ogni commit
# viene messo in un worktree staccato e run-rest.mjs costruisce il prompt DAL SUO src/storyboard.ts e lo manda a
# Workers AI via REST: niente `wrangler dev`, niente porte, niente processi da uccidere, niente ricaricamento a caldo.
# La prima versione di questo script faceva partire un Worker per commit; e' costata quattro dry-run e un'ora, ed e'
# la ragione per cui questa non fa partire niente.
#   1. 0a30b4a  produzione       due volte: la prima e' il numero, la seconda la soglia di rumore fra due corse
#   2. 111c205  parts-first      ramo di chat 3
#   3. 6f153e1  prima            il "prima"
#   4. 46cbba5  confident        ramo con una frase in piu' nel prompt (dopo la revisione avversaria)
# ~7.000 neuroni su 10.000: a quota piena, da UNA sessione, con la riga in QUOTA.md (la scrive run-rest.mjs).
# A quota finita ogni chiamata torna 4006 a costo zero: e' il modo per provare l'intera catena gratis.
#
#   KLEO_SESSION="BOSS/regia" bash scripts/direction-measure/tre-prompt.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${KLEO_SESSION:?scrivi chi sei: KLEO_SESSION=\"BOSS/regia\"}"
export KLEO_SESSION
BASE=/tmp/kleo-tre-prompt; mkdir -p "$BASE"
LOTTO=(
  "0a30b4a|produzione|2"
  "111c205|parts-first|1"
  "6f153e1|prima|1"
  "46cbba5|confident|1"
)
cd "$ROOT"; git fetch -q origin 'refs/heads/*:refs/remotes/origin/*' 2>/dev/null || true
for riga in "${LOTTO[@]}"; do
  IFS='|' read -r COMMIT NOME REP <<<"$riga"
  W="$BASE/$COMMIT"; rm -rf "$W"; git worktree prune
  git worktree add --detach "$W" "$COMMIT" >/dev/null 2>&1
  ln -sfn "$ROOT/node_modules" "$W/node_modules"
  [ "$(git -C "$W" status --porcelain | grep -v node_modules | wc -l)" = 0 ] || { echo "worktree $COMMIT sporco: mi fermo"; exit 1; }
  node "$ROOT/scripts/direction-measure/run-rest.mjs" --src "$W" --label "$NOME" --repeat "$REP"
done
echo "risultati in $ROOT/scripts/direction-measure/results/ ; registro in scripts/direction-measure/QUOTA.md"
