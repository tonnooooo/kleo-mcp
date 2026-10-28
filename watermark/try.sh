#!/usr/bin/env bash
# Tries the kleo-watermark image the way Cloudflare runs it (instance type "basic": 1/4 vCPU, 1 GiB) on two test clips,
# checks what comes back, and prints what one clip costs. Runs on GitHub's runners (.github/workflows/watermark.yml),
# never on the owner's PC. Writes frames with the mark to $OUT (uploaded as the run's artifact).
set -euo pipefail
IMAGE=${IMAGE:-kleo-watermark}
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT" && chmod 777 "$OUT"
ff() { docker run --rm -u 0 -v "$OUT:/w" --entrypoint "$1" "$IMAGE" "${@:2}"; }

# The test clips: moving test pattern and a tone, made with the image's own ffmpeg.
clip() { # name size seconds
  ff ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=$2:rate=24" -f lavfi -i "sine=frequency=440:sample_rate=44100" \
    -t "$3" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "/w/$1.mp4"
}
clip 720p-16x9 1280x720 10
clip 480p-9x16 480x854 10

docker rm -f marker >/dev/null 2>&1 || true
docker run -d --name marker --cpus 0.25 --memory 1g -p 8080:8080 "$IMAGE" >/dev/null
for _ in $(seq 1 60); do curl -sf localhost:8080/ >/dev/null && break; sleep 0.5; done

report="[]"
for name in 720p-16x9 480p-9x16; do
  curl -sS --fail-with-body -D "$OUT/$name.headers" -H "content-type: video/mp4" --data-binary @"$OUT/$name.mp4" \
    localhost:8080/mark -o "$OUT/$name.mark.mp4"
  cpu=$(grep -i '^x-mark-cpu-s:' "$OUT/$name.headers" | tr -d '\r' | awk '{print $2}')
  wall=$(grep -i '^x-mark-wall-s:' "$OUT/$name.headers" | tr -d '\r' | awk '{print $2}')
  read -r w0 h0 d0 < <(ff ffprobe -v error -select_streams v:0 -show_entries stream=width,height:format=duration -of csv=p=0:s=' ' "/w/$name.mp4" | tr '\n' ' ')
  read -r w1 h1 d1 < <(ff ffprobe -v error -select_streams v:0 -show_entries stream=width,height:format=duration -of csv=p=0:s=' ' "/w/$name.mark.mp4" | tr '\n' ' ')
  audio=$(ff ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "/w/$name.mark.mp4")
  [ "${w0}x${h0}" = "${w1}x${h1}" ] || { echo "::error::$name came back ${w1}x${h1}, sent ${w0}x${h0}"; exit 1; }
  awk -v a="$d0" -v b="$d1" 'BEGIN { exit (a - b > 0.1 || b - a > 0.1) }' || { echo "::error::$name came back ${d1}s long, sent ${d0}s"; exit 1; }
  [ "$audio" = "aac" ] || { echo "::error::$name lost its sound ($audio)"; exit 1; }
  ff ffmpeg -hide_banner -loglevel error -ss 5 -i "/w/$name.mark.mp4" -frames:v 1 "/w/$name.mark.png"
  # Cloudflare Containers, Workers Paid (developers.cloudflare.com/containers/pricing, 28 Oct 2026): $0.000020 per
  # active vCPU-second, $0.0000025 per GiB-second and $0.00000007 per GB-second of disk while the instance runs
  # ("basic": 1 GiB, 4 GB disk), after 375 vCPU-minutes, 25 GiB-hours and 200 GB-hours included each month.
  report=$(jq -c --arg n "$name" --argjson cpu "$cpu" --argjson wall "$wall" --argjson d "$d1" '. + [{
    clip: $n, seconds: $d, cpu_s: $cpu, wall_s: $wall,
    usd_after_allowance: (($cpu * 0.000020) + ($wall * 1 * 0.0000025) + ($wall * 4 * 0.00000007) | . * 1000000 | round / 1000000),
    clips_in_allowance: ([375 * 60 / $cpu, 25 * 3600 / $wall, 200 * 3600 / (4 * $wall)] | min | floor)
  }]' <<<"$report")
done
docker logs marker
docker rm -f marker >/dev/null
echo "$report" | jq . | tee "$OUT/cost.json"
# An idle Container keeps billing memory and disk until sleepAfter (2 minutes) ends: about $0.0003 per wake-up.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Kleo mark on a clip, measured on 1/4 vCPU"; echo; echo '| clip | length | CPU s | wall s | $ per clip after the allowance | clips inside the monthly allowance |'; echo '|---|---|---|---|---|---|'
    echo "$report" | jq -r '.[] | "| \(.clip) | \(.seconds) s | \(.cpu_s) | \(.wall_s) | \(.usd_after_allowance) | \(.clips_in_allowance) |"'; } >> "$GITHUB_STEP_SUMMARY"
fi
