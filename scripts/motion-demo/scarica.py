#!/usr/bin/env python3
"""Fetch the video model on the box, detached, while the rest of the setup goes on. ~10 GB, Apache 2.0, not gated.
Prints SCARICATO on success; a failure prints a Traceback. vero.sh waits for either."""
import os
os.environ.setdefault("HF_HUB_OFFLINE", "0")
from huggingface_hub import snapshot_download
model = os.environ.get("KLEO_VIDEO_MODEL", "Wan-AI/Wan2.2-TI2V-5B-Diffusers")
# LTX-2.5 ships two transformers; the distilled one (subfolder "transformer") is what we run. The full one is 38 GB
# more that nothing here loads.
skip = ["transformer_full/*"] if "ltx" in model.lower() else None
print("SCARICATO", snapshot_download(model, max_workers=8, token=os.environ.get("HF_TOKEN") or None, ignore_patterns=skip), flush=True)
