#!/bin/bash
# The four sample films for the styles page, on ONE rented card, one after the other. Run only as
#
#     DEVBOX_STATE=scripts/.devbox-samples.json python3 scripts/devbox.py guarded scripts/motion-demo/serie.sh
#
# (its own state file, so it can run beside another guarded box without either destroying the other's machine).
# No `down` in here: guarded owns the destroy. Long steps are bg + wait. A storyboard that fails does not stop the
# next one. Output: scripts/motion-demo/out/samples/<name>.{web.mp4,4K.mp4,jpg,log,misura.txt}
set -eu
ROOT=$(cd "$(dirname "${GUARDED_SCRIPT:-$0}")/../.." && pwd); cd "$ROOT"
DB="python3 scripts/devbox.py"
OUT=${SAMPLES_OUT:-$ROOT/scripts/motion-demo/out/samples}; mkdir -p "$OUT"
STORYBOARDS=${STORYBOARDS:-"realistic-space cartoon-pirates cyber-relay stickman-relay"}
export DEVBOX_MIN_VRAM_GB=${DEVBOX_MIN_VRAM_GB:-32} DEVBOX_MAX_DPH=${DEVBOX_MAX_DPH:-1.20} DEVBOX_MIN_CPU=${DEVBOX_MIN_CPU:-12} \
       DEVBOX_MIN_RAM_GB=${DEVBOX_MIN_RAM_GB:-32} DEVBOX_MIN_CC=${DEVBOX_MIN_CC:-800} DEVBOX_DISK_GB=${DEVBOX_DISK_GB:-90}
ENV="HF_HUB_OFFLINE=0 HF_HOME=/opt/kleo/hf KLEO_PICTURES=local KLEO_KEOU_DIR=/opt/kleo/keou KLEO_ENGINE=keou KLEO_KEOU_WORKERS=6 KLEO_RENDER_TIMEOUT_MIN=25 KLEO_VIDEO_STEPS=22 PYTHONUNBUFFERED=1"

$DB up
$DB sync
$DB run "rsync -a --exclude node_modules /opt/kleo/repo/worker/keou/ /opt/kleo/keou/ && echo engine ok"

if grep -lq '"backdrop": *"video"' $(for n in $STORYBOARDS; do echo scripts/motion-demo/samples/$n.json; done); then
  echo "== a storyboard asks to be filmed: the video model downloads now, detached =="
  $DB bg "cd /opt/kleo/repo && HF_HUB_OFFLINE=0 HF_HOME=/opt/kleo/hf python3 scripts/motion-demo/scarica.py" /opt/kleo/wan.log
  $DB wait /opt/kleo/wan.log SCARICATO Traceback 25
fi
# Until the image is rebuilt with requirements-pictures.txt of 13 September: the still gate needs OpenCV and the
# image-to-video pipeline needs ftfy (diffusers imports it lazily: six clips died in nine seconds on NameError).
$DB run "pip install -q opencv-python-headless==4.11.0.86 ftfy==6.3.1 && python3 -c 'import cv2, ftfy; from diffusers import WanImageToVideoPipeline, WanPipeline; print(\"video deps ok\", cv2.__version__)'"

for name in $STORYBOARDS; do
  echo; echo "==================== $name ===================="
  $DB bg "cd /opt/kleo/repo && env $ENV STORYBOARD=scripts/motion-demo/samples/$name.json OUT=/opt/kleo/out/$name JOB_ID=gt_$name python3 scripts/motion-demo/gira.py" /opt/kleo/gira-$name.log
  if ! $DB wait /opt/kleo/gira-$name.log "== FATTO ==" "== FALLITO" 75; then
    echo "!! $name did not finish; keeping its evidence, on to the next one"
    $DB pull /opt/kleo/gira-$name.log "$OUT/$name.log" || true
    $DB pull "/opt/kleo/keou/projects/gt-$name/out/master.mp4" "$OUT/$name.FAILED-master.mp4" || true
    $DB pull "/opt/kleo/keou/projects/gt-$name/out/decode.log" "$OUT/$name.decode.log" || true
    continue
  fi
  # THE MASTER FIRST (see vero.sh): a finished film was lost on 13 September one step before its download.
  $DB pull /opt/kleo/out/$name/video.mp4 "$OUT/$name.4K.mp4" || { echo "!! $name: could not pull the master"; continue; }
  $DB pull /opt/kleo/out/$name/thumbnail.jpg "$OUT/$name.jpg" || true
  $DB pull /opt/kleo/gira-$name.log "$OUT/$name.log" || true
  TL=$(grep '== TIMELINE' "$OUT/$name.log" | tail -1 | awk '{print $3}')
  $DB run "cd /opt/kleo/repo && python3 scripts/motion-demo/misura.py /opt/kleo/out/$name/video.mp4 $TL" | tee "$OUT/$name.misura.txt" || true
  # web copy at real quality: 1080x1920 or 1920x1080, crf 20, voice kept. The old samples were 608x1080 at 67-255 kbps.
  $DB bg "cd /opt/kleo/out/$name && ffmpeg -v error -y -i video.mp4 -vf \"scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2\" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 160k web.mp4 && echo WEB_FATTO" /opt/kleo/web-$name.log
  $DB wait /opt/kleo/web-$name.log WEB_FATTO Error 15 || { echo "!! $name: web copy failed (the 4K is home)"; continue; }
  $DB pull /opt/kleo/out/$name/web.mp4 "$OUT/$name.web.mp4" || true
done
ls -la "$OUT"
