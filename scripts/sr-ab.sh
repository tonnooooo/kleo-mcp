#!/usr/bin/env bash
# The A/B of the neural finish (worker/kleo_sr.py) against today's chain, on a real job's bundle, on a rented card and
# never on the owner's computer. Run it ONLY through the guard, from the repo root, in WSL:
#
#     DEVBOX_STATE=<scratch>/.devbox-sr.json python3 scripts/devbox.py guarded scripts/sr-ab.sh
#
# DEVBOX_STATE goes on the guarded command line (the parent's `finally` reads it to destroy the box), and
# INTERNAL_SECRET must be in the environment or in .secrets.local: it signs, here, the two capabilities the box gets
# (a 3-hour link to the job's gen.tgz, a 3-hour upload right on the job's probe/ prefix) and the links printed at the
# end. The secret itself never leaves this machine, and neither capability is ever echoed.
#
# What comes back is TEXT only: the log, the summary lines, and signed /dl links to the evidence the box uploaded to
# R2 (src/probe.ts) — contact sheet, frames, the 4K60 wipe, both 4K60 films, results.json. No file of the probe is
# copied to this machine.
#
# `guarded` destroys the box whatever happens, so this script never calls `down` and may fail freely. Every long step
# runs detached (`bg`) and is followed with short polls (`wait`).
# Expected: one 8 GB Ampere-or-newer card for 40-50 min, about $0.05-0.12. Check `devbox.py status` and the Vast
# credit first: the account is shared with production.
set -euo pipefail
: "${DEVBOX_STATE:?set DEVBOX_STATE on the guarded command line}"
ROOT=$(cd "$(dirname "${GUARDED_SCRIPT:-$0}")/.." && pwd); cd "$ROOT"   # guarded runs a snapshot of this file
JOB=${SR_AB_JOB:-gt_ujavdzva}
API=${KLEO_API:-https://mcp.kleooai.com}
HOURS=${SR_AB_LINK_HOURS:-72}
D="python3 scripts/devbox.py"
export DEVBOX_MIN_VRAM_GB=${DEVBOX_MIN_VRAM_GB:-8} DEVBOX_MIN_CC=${DEVBOX_MIN_CC:-860} DEVBOX_MAX_DPH=${DEVBOX_MAX_DPH:-0.15} \
       DEVBOX_DISK_GB=${DEVBOX_DISK_GB:-60} DEVBOX_RUN_MIN=${DEVBOX_RUN_MIN:-60}

# The capabilities, minted before anything is rented: a missing secret stops the run while it still costs nothing.
GEN_URL=$(KLEO_API="$API" python3 scripts/sr-ab.py --sign "$JOB" gen.tgz --hours 3)
UP_Q=$(python3 scripts/sr-ab.py --sign-upload "$JOB" --hours 3)

$D up
$D sync
echo "== the job's bundle, straight from R2 to the box =="
$D run "set -e; mkdir -p /opt/kleo/ab && cd /opt/kleo/ab && curl -fsS --retry 3 -A kleo-sr-ab -o gen.tgz '$GEN_URL' && tar xzf gen.tgz && ls build clips | head -40"

echo "== spandrel and the weights on this box (today's image does not carry them); the CPU self-check of every network =="
$D bg "pip install -q --no-deps spandrel==0.4.2 einops==0.8.1 && python3 /opt/kleo/repo/worker/kleo_sr.py fetch /opt/kleo/sr && echo WEIGHTS_READY" /opt/kleo/ab/weights.log
$D wait /opt/kleo/ab/weights.log WEIGHTS_READY Traceback 15

echo "== the variants, the measures, the evidence, the upload (detached) =="
$D bg "cd /opt/kleo/repo && KLEO_API='$API' KLEO_PROBE_JOB='$JOB' KLEO_PROBE_UPLOAD='$UP_Q' KLEO_SR_DIR=/opt/kleo/sr PYTHONUNBUFFERED=1 python3 scripts/sr-ab.py --run /opt/kleo/ab --out /opt/kleo/ab/out" /opt/kleo/ab/ab.log
$D wait /opt/kleo/ab/ab.log AB_DONE AB_FAIL 75

echo "== the links for the owner (signed here, valid ${HOURS} h; the files are purged with the job's own) =="
NAMES=$($D run "cat /opt/kleo/ab/out/uploaded.txt")
KLEO_API="$API" python3 scripts/sr-ab.py --links "$JOB" $NAMES --hours "$HOURS"
$D status
