#!/usr/bin/env bash
# Completes the Cloudflare installation after `wrangler login` (claimed account).
# Idempotent: safe to re-run. Usage: bash scripts/finish-install.sh [PUBLIC_URL]
set -euo pipefail
cd "$(dirname "$0")/.."
W=./node_modules/.bin/wrangler
PUBLIC_URL="${1:-}"

echo "== account =="; $W whoami | grep -E "Account Name|Account ID|You are logged in" || true

echo "== KV =="
KV_ID=$($W kv namespace list 2>/dev/null | python3 -c 'import sys,json; ns=json.load(sys.stdin); m=[n for n in ns if "oauth" in n["title"].lower() or "OAUTH_KV" in n["title"]]; print(m[0]["id"] if m else "")')
if [ -z "$KV_ID" ]; then $W kv namespace create OAUTH_KV >/dev/null; KV_ID=$($W kv namespace list | python3 -c 'import sys,json; print([n for n in json.load(sys.stdin) if "OAUTH_KV" in n["title"]][0]["id"])'); fi
echo "OAUTH_KV = $KV_ID"

echo "== D1 =="
D1_ID=$($W d1 list --json 2>/dev/null | python3 -c 'import sys,json; d=[x for x in json.load(sys.stdin) if x["name"]=="kleo-db"]; print(d[0]["uuid"] if d else "")')
if [ -z "$D1_ID" ]; then $W d1 create kleo-db >/dev/null; D1_ID=$($W d1 list --json | python3 -c 'import sys,json; print([x for x in json.load(sys.stdin) if x["name"]=="kleo-db"][0]["uuid"])'); fi
echo "kleo-db = $D1_ID"

echo "== R2 =="
$W r2 bucket list 2>/dev/null | grep -q "kleo-renders" || $W r2 bucket create kleo-renders
echo "kleo-renders ok"

echo "== config =="
python3 - "$KV_ID" "$D1_ID" "$PUBLIC_URL" <<'PY'
import re,sys
kv,d1,pub=sys.argv[1],sys.argv[2],sys.argv[3]
p='wrangler.jsonc'; s=open(p).read()
s=re.sub(r'("binding": "OAUTH_KV", "id": ")[^"]*(")', r'\g<1>'+kv+r'\2', s)
s=re.sub(r'("database_id": ")[^"]*(")', r'\g<1>'+d1+r'\2', s)
if pub: s=re.sub(r'("PUBLIC_URL": ")[^"]*(")', r'\g<1>'+pub+r'\2', s)
open(p,'w').write(s); print("wrangler.jsonc updated")
PY

echo "== migrations =="
$W d1 migrations apply kleo-db --remote

echo "== secrets =="
# Solo INTERNAL_SECRET: firma i link di download E l'identita' degli account anonimi, quindi ricaricarlo con un
# valore diverso da quello gia' in produzione sloggherebbe tutti. Non esistono piu' codici invito da caricare.
SECRET=$(grep '^INTERNAL_SECRET=' .secrets.local | cut -d= -f2)
printf '%s' "$SECRET" | $W secret put INTERNAL_SECRET

echo "== deploy =="
$W deploy
echo "== done =="
