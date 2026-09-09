#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/usr/local/bin:$PATH"
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Bootstrap is for a fresh dedicated Linux worker. Local render: npm ci, npx playwright install chromium.' >&2
  exit 1
fi
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg espeak-ng curl xz-utils ca-certificates python3-venv rsync util-linux
if ! command -v node >/dev/null || ! node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'; then
  curl -fsSL https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz -o /tmp/keou-node.tar.xz
  curl -fsSL https://nodejs.org/dist/v22.23.2/SHASUMS256.txt -o /tmp/keou-node-sha.txt
  (cd /tmp && python3 - <<'PY'
from pathlib import Path
import hashlib
lines=Path('keou-node-sha.txt').read_text().splitlines()
expected=next(s.split()[0] for s in lines if s.endswith(' node-v22.23.2-linux-x64.tar.xz'))
assert hashlib.sha256(Path('keou-node.tar.xz').read_bytes()).hexdigest()==expected
PY
  )
  tar -xJf /tmp/keou-node.tar.xz -C /usr/local --strip-components=1
fi
python -m venv --system-site-packages .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci --no-audit --no-fund
npx playwright install --with-deps chromium
.venv/bin/python -m pip freeze > runtime-python.txt
node --version > runtime-node.txt
/usr/bin/ffmpeg -version > runtime-ffmpeg.txt
.venv/bin/python -c 'import torch; print("CUDA available:", torch.cuda.is_available())'
echo 'BOOTSTRAP_READY'
