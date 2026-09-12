#!/bin/bash
# The realistic video with GENERATED motion (Wan 2.2 footage under Italian voice and text), rendered on a rented
# card and never on the owner's computer. Run it ONLY like this, from the repo root:
#
#     python3 scripts/devbox.py guarded scripts/motion-demo/vero.sh
#
# `guarded` destroys the box in a `finally` whatever happens here, so this script must NOT call `down` and may
# fail freely. Every long step runs detached on the box (`bg`) and is followed with short polls (`wait`): an ssh
# drop costs one poll, never the job — the 11 September orphan cannot happen along this path.
#
# Expected: ~4 min for the box, ~4 min for the model, 15-25 min for the render on a ≥32 GB card at ~$0.45/h.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
DB="python3 scripts/devbox.py"
OUT=${MOTION_OUT:-$ROOT/scripts/motion-demo/out}; mkdir -p "$OUT"
export DEVBOX_MIN_VRAM_GB=32 DEVBOX_MAX_DPH=0.55 DEVBOX_MIN_CPU=12 DEVBOX_MIN_RAM_GB=32 DEVBOX_MIN_CC=800 DEVBOX_DISK_GB=90

$DB up
$DB sync
# The engine in the image keeps its node_modules in /opt/kleo/keou: lay today's engine over it, on the box.
$DB run "rsync -a --exclude node_modules /opt/kleo/repo/worker/keou/ /opt/kleo/keou/ && echo engine ok"

echo "== the video model downloads now, detached, while nothing else is waiting on it =="
$DB bg "cd /opt/kleo/repo && HF_HUB_OFFLINE=0 HF_HOME=/opt/kleo/hf python3 scripts/motion-demo/scarica.py" /opt/kleo/wan.log
$DB wait /opt/kleo/wan.log SCARICATO Traceback 25
$DB run "du -sh /opt/kleo/hf"

echo "== RENDER, detached =="
$DB bg "cd /opt/kleo/repo && HF_HUB_OFFLINE=0 HF_HOME=/opt/kleo/hf KLEO_PICTURES=local KLEO_KEOU_DIR=/opt/kleo/keou KLEO_ENGINE=keou KLEO_KEOU_WORKERS=6 KLEO_RENDER_TIMEOUT_MIN=15 KLEO_VIDEO_STEPS=22 PYTHONUNBUFFERED=1 python3 scripts/motion-demo/gira.py" /opt/kleo/gira.log
$DB wait /opt/kleo/gira.log "== FATTO ==" "== FALLITO" 45
$DB pull /opt/kleo/gira.log "$OUT/gira.log"

echo "== measure the motion ON THE BOX with a meter the generator does not optimise =="
$DB run "cd /opt/kleo/repo && python3 scripts/motion-demo/misura.py /opt/kleo/out/video.mp4 /opt/kleo/keou/projects" | tee "$OUT/misura.txt"

echo "== web copy, made on the box =="
$DB bg "cd /opt/kleo/out && ffmpeg -v error -y -i video.mp4 -vf scale=1280:-2 -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k web.mp4 && echo WEB_FATTO" /opt/kleo/web.log
$DB wait /opt/kleo/web.log WEB_FATTO Error 10
$DB pull /opt/kleo/out/web.mp4 "$OUT/MOTO-web.mp4"
$DB pull /opt/kleo/out/video.mp4 "$OUT/MOTO-4K.mp4"
$DB pull /opt/kleo/out/thumbnail.jpg "$OUT/MOTO-thumb.jpg" || true
ls -la "$OUT"
