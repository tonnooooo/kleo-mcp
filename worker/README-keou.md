# kleo-worker:keou — the Keou engine container

`localhost/kleo-worker:keou` runs the Keou motion-design engine end to end on CPU or GPU
(Playwright headless Chromium draws the frames, ffmpeg encodes, Kokoro-82M speaks, faster-whisper
aligns captions) and starts the Kleo job worker (`/opt/kleo/kleo_worker.py`) as its command.

## What the image contains (10.8 GB)

| Piece | Where | Notes |
|---|---|---|
| Base | `pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime` | Python 3.11 (`/opt/conda`), torch 2.8.0+cu128; CUDA used automatically when a GPU is present, CPU otherwise |
| System | apt | ffmpeg 4.4.2, espeak-ng, curl, xz-utils, ca-certificates, rsync, util-linux, fonts-dejavu-core |
| Node 22.23.2 | `/usr/local` | official tarball, SHA-256 verified against `SHASUMS256.txt` (same recipe as `keou/bootstrap.sh`) |
| Engine | `/opt/kleo/keou` | copy of `worker/keou` (run.py, contract.py, prepare.py, qa.py, engine/, examples/) + `node_modules` (playwright 1.63.0) |
| Chromium | `/opt/kleo/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`) | `npx playwright install --with-deps chromium` |
| Python deps | `/opt/conda` | `keou/requirements.txt` (kokoro 0.9.4, misaki[en], faster-whisper 1.2.1, spacy 3.8.16, ...) + spaCy `en_core_web_sm` 3.8.0 pre-installed (misaki would otherwise download it on first run) |
| Models | `/opt/kleo/hf` (`HF_HOME`, 779 MB) | Kokoro-82M weights + every voice in `contract.VOICES` (en: af_heart, am_michael, bf_emma; fr: ff_siwis; it: if_sara, im_nicola) and faster-whisper `small` int8 — warmed at build time by `worker/prewarm_models.py`, which reads the voice list from `contract.py` |
| Worker | `/opt/kleo/kleo_worker.py` | whatever `worker/kleo_worker.py` is at build time; `CMD python3 /opt/kleo/kleo_worker.py` |

`HF_HUB_OFFLINE=1` is set in the image: nothing is downloaded at boot, and a render works with
networking disabled (verified with `podman run --network none`). Adding a voice therefore means
editing `contract.VOICES` and rebuilding (the prewarm layer is keyed on `contract.py`).

## Rebuild

```sh
cd /home/madiva/kleo/kleo-mcp
podman build -f worker/Dockerfile.keou -t kleo-worker:keou .
```

The build context is the repo root (`.dockerignore` drops node_modules, .wrangler, .git, example
build/out directories). Layer order: apt → Node → `npm ci` + Chromium → pip → models → source, so
editing engine files or `kleo_worker.py` only rebuilds the last (seconds) layers. A cold build took
about 12 minutes on an 8-core laptop, 165 s of which is the model warm-up; the base image alone is 7.7 GB.

Push for Vast: `podman tag kleo-worker:keou docker.io/<user>/kleo-worker:keou && podman push docker.io/<user>/kleo-worker:keou`,
then point `VAST_IMAGE` at it.

## Run a project manually

```sh
mkdir -p /tmp/proj && cp worker/keou/examples/short-relay-cinema/{project.json,script.txt} /tmp/proj/
podman run --rm -v /tmp/proj:/work:Z localhost/kleo-worker:keou \
  python3 /opt/kleo/keou/run.py /work/project.json --workers 4
# outputs: /tmp/proj/out/master.mp4 preview.mp4 captions.srt FINAL-QA.json delivery.json, /tmp/proj/build/timeline.json voice.wav
```

Add `--device nvidia.com/gpu=all` (podman) / `--gpus all` (docker) on a GPU host; `prepare.py` picks
CUDA for Kokoro automatically and keeps whisper on CPU. The engine needs about 2.5 GB RAM in the voice
stage and more with several render workers; `--workers 4` is fine on 8 cores. The job worker
(`kleo_worker.py`) passes `--workers min(8, cpu count)` unless `KLEO_KEOU_WORKERS` is set
(`test/worker-e2e.mjs` sets 4 so a laptop is not starved).

## Measured (CPU only, 8 cores, no GPU, network disabled)

`examples/short-relay-cinema` at width 1080 (9:16, 60 fps, 6 scenes, 38.5 s of video, voice `am_michael`):

| Stage | Wall time |
|---|---|
| voice (Kokoro + whisper alignment, 6 scenes) | 64.4 s |
| audio (ffmpeg mix) | 1.0 s |
| render (Chromium, 4 workers, 2310 frames) | 141.4 s |
| quality (qa.py full decode + loudness) | 14.2 s |
| preview | 10.0 s |
| **total** | **231 s** |

Result: `master.mp4` h264 1080x1920 @ 60/1, 38.502 s, 2310 frames, AAC 48 kHz stereo, 12.5 MB, `QA_PASS`.
Peak container memory 2.5 GB (voice stage). At the production width 2160 the render stage scales
roughly with pixel count (about 4x), so expect ~10 min on CPU for a 40 s Short; a GPU only helps the
voice stage (Chromium renders on CPU either way).

## Italian

Supported. kokoro 0.9.4 maps `it` → lang_code `i` (`KPipeline.ALIASES`/`LANG_CODES`) through
`misaki.espeak.EspeakG2P`, the same path French already uses. `contract.VOICES` has
`'it': {'if_sara', 'im_nicola'}` and `prepare.py` maps language `it` to `'i'` (en stays `a`/`b`, fr `f`).
Verified in the container offline: both voices synthesize "Il motore di rendering è pronto e funziona
senza connessione." (4.2 s / 4.6 s) and faster-whisper transcribes the sentence back verbatim.

## Kleo pictures (cartoon / realistic)

A Kleo storyboard is a Keou project plus a top-level `kleo_style` (`cartoon` | `realistic` | `cyber` | `stickman`,
default cyber) and, per scene, an optional `image_prompt` (≤ 240 chars). Clients never set `scene.image`: for
`cartoon` and `realistic` the **server** generates one picture per prompted scene (Workers AI, once per job, at
most 10) and the **worker** attaches them. Right after `build_project`, `prepare_project()` in `kleo_worker.py`:

1. `POST /internal/jobs/{id}/images` (empty body, the job secret, worker User-Agent) →
   `{"images": {"<sceneId>": "<signed download url>"}, "missing": ["<sceneId>", ...]}`;
   a 5xx, a network error or a garbled reply is retried **once after `KLEO_IMAGES_RETRY_WAIT_S`** (20 s), a 4xx is final;
2. downloads every link (same User-Agent, no bearer: the link is signed) into
   `<engine>/projects/<id>/img/<sceneId>.<ext>` — the extension is sniffed from the bytes (png / jpg / webp), anything
   else (an HTML error page, an empty body, > 25 MB) is discarded;
3. sets `scene.image = "img/<sceneId>.<ext>"`, strips `kleo_style` and every `image_prompt`, writes `project.json`
   and reports `progress("script", 5, "N pictures ready, M missing")`.

The engine then draws the picture as a full-bleed Ken Burns background behind cinema / closing scenes (and behind the
stickman on story scenes); `contract.py` accepts `image` on cinema, story and closing scenes with the usual
`local_asset` rules. Nothing here is fatal: a scene without picture renders exactly as before, `cyber` / `stickman`
never call the endpoint, and any `scene.image` a client managed to send is dropped by `build_project` (no asset
travels with a job). `KLEO_IMAGES_TIMEOUT_S` (300) bounds the images call: the server generates on the first request.

The worker script is baked into the image (`/opt/kleo/kleo_worker.py`): after editing it either rebuild (last layer,
seconds) or run the e2e with `KLEO_MOUNT_WORKER=1`.

Tests, none of which render anything:

- `python3 worker/test_kleo_worker_images.py -v` (also `node --test test/worker-images.test.mjs`): a local
  `http.server` plays the API and the signed `/dl` route (a real PNG, a JPEG, a 404, an expired link answering HTML);
  asserts the files land in `<project>/img/`, `scene.image` is set, the Kleo fields are stripped, the retry / 4xx
  paths, the progress message, and that the written `project.json` passes the engine's own `contract.validate()`.
- `node test/worker-e2e.mjs` (podman + the image + ffprobe, ~5 min on CPU) injects the short-relay-cinema storyboard as
  `kleo_style: cartoon` with an `image_prompt` on `01-gone` and `05-fix`, starts `wrangler dev --var IMAGE_FIXTURE:1`
  (deterministic placeholder PNGs, no Workers AI), checks `POST /internal/jobs/:id/images` and the PNG links itself,
  then asserts the worker log says `2 pictures ready, 0 missing`.
- `test/fixtures/cartoon-pirates.json`: the first real cartoon Short (cinema, 5 scenes, ~105 words, `am_michael`,
  an `image_prompt` on every scene with the same captain, ship and parrot throughout).
