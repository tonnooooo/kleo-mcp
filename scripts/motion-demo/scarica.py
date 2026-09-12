#!/usr/bin/env python3
"""Fetch the video model on the box, detached, while the rest of the setup goes on. ~10 GB, Apache 2.0, not gated.
Prints SCARICATO on success; a failure prints a Traceback. vero.sh waits for either."""
import os
os.environ.setdefault("HF_HUB_OFFLINE", "0")
from huggingface_hub import snapshot_download
print("SCARICATO", snapshot_download("Wan-AI/Wan2.2-TI2V-5B-Diffusers", max_workers=8), flush=True)
