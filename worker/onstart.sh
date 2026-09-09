#!/bin/bash
# Vast.ai runs /root/onstart.sh on boot. The orchestrator passes an equivalent one-liner as `onstart`;
# this file is for manual tests: `vastai create instance <offer> --image YOURUSER/kleo-worker --env '-e KLEO_API=... -e KLEO_JOB_ID=... -e KLEO_SECRET=...' --onstart worker/onstart.sh`
env >> /etc/environment
cd /opt/kleo && nohup python3 kleo_worker.py >> /var/log/kleo.log 2>&1 &
