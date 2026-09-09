# Kleo GPU worker image. Build & push, then set VAST_IMAGE to it.
#   docker build -t docker.io/YOURUSER/kleo-worker:latest worker/ && docker push docker.io/YOURUSER/kleo-worker:latest
# Add your ComfyUI, custom nodes and model download steps below; models themselves live on R2/HF and are
# fetched at boot (fast, free egress), not baked in.
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg aria2 git fonts-dejavu-core curl ca-certificates openssh-server \
    && rm -rf /var/lib/apt/lists/*
# --- your pipeline (example) ---
# RUN git clone https://github.com/comfyanonymous/ComfyUI /opt/ComfyUI && pip3 install --break-system-packages -r /opt/ComfyUI/requirements.txt
WORKDIR /opt/kleo
COPY kleo_worker.py onstart.sh ./
RUN chmod +x onstart.sh
CMD ["python3", "/opt/kleo/kleo_worker.py"]
