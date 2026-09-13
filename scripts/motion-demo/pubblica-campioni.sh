#!/bin/bash
# Put the re-rendered samples on the styles page: scripts/motion-demo/out/samples/<name>.web.mp4 + .jpg ->
# ../kleo-site/samples/<style>.mp4 + .jpg, then commit in kleo-site. Pushing is a separate, deliberate step.
#
#     scripts/motion-demo/pubblica-campioni.sh            copy + commit what is there (missing ones are skipped)
#     scripts/motion-demo/pubblica-campioni.sh --push     and push to GitHub Pages
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd); SITE=$ROOT/../kleo-site; OUT=$ROOT/scripts/motion-demo/out/samples
declare -A STYLE=([realistic-space]=realistic [cartoon-pirates]=cartoon [cyber-relay]=cyber [stickman-relay]=stickman)
done=()
for name in "${!STYLE[@]}"; do
  st=${STYLE[$name]}
  [ -s "$OUT/$name.web.mp4" ] || { echo "-- $st: no $name.web.mp4 yet, skipped"; continue; }
  cp "$OUT/$name.web.mp4" "$SITE/samples/$st.mp4"
  if [ -s "$OUT/$name.jpg" ]; then
    # poster at the page's own width: the render's thumbnail is 4K
    ffmpeg -v error -y -i "$OUT/$name.jpg" -vf "scale='min(1080,iw)':-2" -q:v 3 "$SITE/samples/$st.jpg"
  fi
  echo "== $st <- $name: $(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,bit_rate -of csv=p=0 "$SITE/samples/$st.mp4" | tr ',' ' ') ($(du -h "$SITE/samples/$st.mp4" | cut -f1))"
  done+=("$st")
done
[ ${#done[@]} -gt 0 ] || { echo "nothing to publish"; exit 1; }
cd "$SITE" && git add samples && git commit -q -m "Styles page: samples re-rendered with the repaired engine (${done[*]})

1080x1920 at crf 20 with the voice kept, in place of 608x1080 at 67-255 kbps. Realistic is filmed (generated
motion under the voice), not a still being zoomed.

Session: BOSS video

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git log --oneline -1 | cat
[ "${1:-}" = "--push" ] && git push -q origin HEAD && echo "pushed to GitHub Pages" || echo "(not pushed: run with --push)"
