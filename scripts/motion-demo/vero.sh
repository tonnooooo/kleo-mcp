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
ROOT=$(cd "$(dirname "${GUARDED_SCRIPT:-$0}")/../.." && pwd); cd "$ROOT"   # guarded runs a snapshot of this file
DB="python3 scripts/devbox.py"
OUT=${MOTION_OUT:-$ROOT/scripts/motion-demo/out}; mkdir -p "$OUT"
# Defaults, each overridable from the environment. The price cap is the one filter that decides whether there is
# a machine at all: on 13 September no ≥32 GB card sat under 0.55 $/h and the cheapest was an L40S at 0.825 —
# still under the owner's ceiling of one dollar an hour. The first version hard-coded 0.55 here and silently
# overrode the cap passed on the command line, so the run died twice on "no Vast offer matches".
export DEVBOX_MIN_VRAM_GB=${DEVBOX_MIN_VRAM_GB:-32} DEVBOX_MAX_DPH=${DEVBOX_MAX_DPH:-0.90} DEVBOX_MIN_CPU=${DEVBOX_MIN_CPU:-12} \
       DEVBOX_MIN_RAM_GB=${DEVBOX_MIN_RAM_GB:-32} DEVBOX_MIN_CC=${DEVBOX_MIN_CC:-800} DEVBOX_DISK_GB=${DEVBOX_DISK_GB:-90}

$DB up
$DB sync
# The engine in the image keeps its node_modules in /opt/kleo/keou: lay today's engine over it, on the box.
$DB run "rsync -a --exclude node_modules /opt/kleo/repo/worker/keou/ /opt/kleo/keou/ && echo engine ok"

echo "== the video model downloads now, detached, while nothing else is waiting on it =="
# The generator is chosen per run: KLEO_VIDEO_MODEL (default Wan 2.2 5B; Lightricks/LTX-2.5-Diffusers is the owner's
# choice of 13 September, gated: HF_TOKEN from .secrets.local travels to the box for the download only).
MODEL=${KLEO_VIDEO_MODEL:-Wan-AI/Wan2.2-TI2V-5B-Diffusers}
HFTOK=$(grep '^HF_TOKEN=' "$ROOT/.secrets.local" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
$DB bg "cd /opt/kleo/repo && HF_HUB_OFFLINE=0 HF_HOME=/opt/kleo/hf HF_TOKEN='$HFTOK' KLEO_VIDEO_MODEL='$MODEL' python3 scripts/motion-demo/scarica.py" /opt/kleo/wan.log
$DB wait /opt/kleo/wan.log SCARICATO Traceback 40
$DB run "du -sh /opt/kleo/hf"

# Until the image is rebuilt with requirements-pictures.txt of 13 September: the still gate needs OpenCV and the
# image-to-video pipeline needs ftfy (diffusers imports it lazily: six clips died in nine seconds on NameError).
$DB run "pip install -q opencv-python-headless==4.11.0.86 ftfy==6.3.1 && python3 -c 'import cv2, ftfy; from diffusers import WanImageToVideoPipeline, WanPipeline; print(\"video deps ok\", cv2.__version__)'"

echo "== RENDER, detached =="
$DB bg "cd /opt/kleo/repo && HF_HUB_OFFLINE=0 HF_HOME=/opt/kleo/hf HF_TOKEN='$HFTOK' KLEO_VIDEO_MODEL='$MODEL' KLEO_VIDEO_OFFLOAD=${KLEO_VIDEO_OFFLOAD:-0} KLEO_PICTURES=local KLEO_KEOU_DIR=/opt/kleo/keou KLEO_ENGINE=keou KLEO_KEOU_WORKERS=6 KLEO_RENDER_TIMEOUT_MIN=15 KLEO_VIDEO_STEPS=22 PYTHONUNBUFFERED=1 python3 scripts/motion-demo/film.py" /opt/kleo/gira.log
if ! $DB wait /opt/kleo/gira.log "== FATTO ==" "== FALLITO" 45; then
  # A failed film is the most valuable thing on the box — the first one was destroyed unread (13 September:
  # "one second of identical frames", master never seen). Pull what there is before the guard destroys it.
  $DB pull /opt/kleo/gira.log "$OUT/gira.log" || true
  $DB run "cd /opt/kleo/keou/projects && tar czf /opt/kleo/failed.tgz --exclude='*.wav' --exclude='clips' --exclude='footage-parts' */out */build 2>/dev/null; ls -la /opt/kleo/failed.tgz" || true
  $DB pull /opt/kleo/failed.tgz "$OUT/failed.tgz" || true
  $DB run "ls /opt/kleo/keou/projects/*/out/master.mp4 2>/dev/null" && $DB pull "/opt/kleo/keou/projects/gt-demo/out/master.mp4" "$OUT/MOTO-FAILED-master.mp4" || true
  exit 1
fi
# THE MASTER FIRST. On 13 September a finished 4K film sat on the box while the driver measured and transcoded,
# the credit ran out, Vast stopped the machine, and the film was never downloaded.
$DB pull /opt/kleo/out/video.mp4 "$OUT/MOTO-4K.mp4"
$DB pull /opt/kleo/out/thumbnail.jpg "$OUT/MOTO-thumb.jpg" || true
$DB pull /opt/kleo/gira.log "$OUT/gira.log" || true

echo "== measure the motion ON THE BOX with a meter the generator does not optimise =="
$DB run "cd /opt/kleo/repo && python3 scripts/motion-demo/misura.py /opt/kleo/out/video.mp4 /opt/kleo/keou/projects" | tee "$OUT/misura.txt"

echo "== web copy, made on the box =="
$DB bg "cd /opt/kleo/out && ffmpeg -v error -y -i video.mp4 -vf scale=1280:-2 -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k web.mp4 && echo WEB_FATTO" /opt/kleo/web.log
$DB wait /opt/kleo/web.log WEB_FATTO Error 10
$DB pull /opt/kleo/out/web.mp4 "$OUT/MOTO-web.mp4"
ls -la "$OUT"
