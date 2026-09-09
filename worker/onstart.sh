#!/bin/bash
# Vast.ai runs /root/onstart.sh on boot. The orchestrator passes an equivalent one-liner as `onstart`;
# this file is for manual tests: `vastai create instance <offer> --image YOURUSER/gatto-worker --env '-e GATTO_API=... -e GATTO_JOB_ID=... -e GATTO_SECRET=...' --onstart worker/onstart.sh`
env >> /etc/environment
cd /opt/gatto && nohup python3 gatto_worker.py >> /var/log/gatto.log 2>&1 &
