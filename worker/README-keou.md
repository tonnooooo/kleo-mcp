# kleo-worker:keou — the Keou engine container

`localhost/kleo-worker:keou` runs the Keou motion-design engine end to end on CPU or GPU
(Playwright headless Chromium draws the frames, ffmpeg encodes, Kokoro-82M speaks, faster-whisper
aligns captions) and starts the Kleo job worker (`/opt/kleo/kleo_worker.py`) as its command.

## What the image contains (about 15 GB with the picture models; 10.8 GB before them)

| Piece | Where | Notes |
|---|---|---|
| Base | `pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime` | Python 3.11 (`/opt/conda`), torch 2.8.0+cu128; CUDA used automatically when a GPU is present, CPU otherwise |
| System | apt | ffmpeg 4.4.2, espeak-ng, curl, xz-utils, ca-certificates, rsync, util-linux, fonts-dejavu-core |
| Node 22.23.2 | `/usr/local` | official tarball, SHA-256 verified against `SHASUMS256.txt` (same recipe as `keou/bootstrap.sh`) |
| Engine | `/opt/kleo/keou` | copy of `worker/keou` (run.py, contract.py, prepare.py, qa.py, engine/, examples/) + `node_modules` (playwright 1.63.0) |
| Chromium | `/opt/kleo/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`) | `npx playwright install --with-deps chromium` |
| Python deps | `/opt/conda` | `keou/requirements.txt` (kokoro 0.9.4, misaki[en], faster-whisper 1.2.1, spacy 3.8.16, ...) + spaCy `en_core_web_sm` 3.8.0 pre-installed (misaki would otherwise download it on first run) |
| Picture deps | `/opt/conda` | `worker/requirements-pictures.txt`: diffusers 0.40.0, accelerate 1.15.0, safetensors 0.8.0, pillow (torch from the base image, transformers 5.16.1 from `keou/requirements.txt`) |
| Models | `/opt/kleo/hf` (`HF_HOME`, 779 MB + ~4 GB of picture models) | Kokoro-82M weights + every voice in `contract.VOICES` (en: af_heart, am_michael, bf_emma; fr: ff_siwis; it: if_sara, im_nicola), faster-whisper `small` int8, and the two SD1.5 checkpoints for Kleo pictures (`Lykon/dreamshaper-8`, `SG161222/Realistic_Vision_V5.1_noVAE`: fp16 safetensors + configs, no safety checker, ~2 GB each) — warmed at build time by `worker/prewarm_models.py`, which reads the voice list from `contract.py` and keeps its own copy of the picture model table (`PICTURE_MODELS`, checked against `kleo_pictures.MODELS` by `test_kleo_pictures.py`); `--build-arg PREWARM_PICTURES=0` builds without them |
| Worker | `/opt/kleo/kleo_worker.py`, `/opt/kleo/kleo_pictures.py` | whatever `worker/kleo_worker.py` / `worker/kleo_pictures.py` are at build time; `CMD python3 /opt/kleo/kleo_worker.py` |

`HF_HUB_OFFLINE=1` is set in the image: nothing is downloaded at boot, and a render works with
networking disabled (verified with `podman run --network none`). Adding a voice therefore means
editing `contract.VOICES` and rebuilding (the prewarm layer is keyed on `contract.py` and `prewarm_models.py`;
editing `kleo_pictures.py` or `kleo_worker.py` only rebuilds the last, seconds-long layers).

## Rebuild

```sh
cd /home/madiva/kleo/kleo-mcp
podman build -f worker/Dockerfile.keou -t kleo-worker:keou .
```

The build context is the repo root (`.dockerignore` drops node_modules, .wrangler, .git, example
build/out directories). Layer order: apt → Node → `npm ci` + Chromium → pip → pip (pictures) → models → source, so
editing engine files, `kleo_worker.py` or `kleo_pictures.py` only rebuilds the last (seconds) layers. A cold build took
about 12 minutes on an 8-core laptop before the picture models, 165 s of which is the model warm-up; the base image
alone is 7.7 GB. The picture warm-up adds the download of ~4 GB from Hugging Face (a few minutes on a fast line) and
about 4 GB to the image; `--build-arg PREWARM_PICTURES=0` skips it (the worker then falls back to the server pictures
only, or downloads the checkpoint at first use when `KLEO_PICTURES_DOWNLOAD` is not `0` — slow and not the normal path).

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
3. for the scenes still missing, draws the pictures itself on the instance's GPU (see *Local GPU pictures* below)
   into `<project>/img/<sceneId>.png`;
4. sets `scene.image = "img/<sceneId>.<ext>"`, strips `kleo_style` and every `image_prompt`, writes `project.json`
   and reports `progress("script", 5, "N pictures from server, M generated on the GPU, K missing")`.

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
  then asserts the worker log says `2 pictures from server, 0 generated on the GPU, 0 missing`.
- `python3 worker/test_kleo_pictures.py -v` (also `cd worker && python3 -m unittest test_kleo_pictures`): fake `torch` /
  `diffusers` modules injected through `sys.modules` (no GPU, no model, no network) prove the file naming, the per-scene
  seed, the style suffix / negative prompt / sizes / steps / guidance, the `{}` answer without CUDA, the cache-then-download
  load order with `HF_HUB_OFFLINE` restored, and the `KLEO_PICTURES` auto / server / local ordering in `prepare_project`
  (the images call mocked, a fake `kleo_pictures` recording what it was asked to draw).
- `test/fixtures/cartoon-pirates.json`: the first real cartoon Short (cinema, 5 scenes, ~105 words, `am_michael`,
  an `image_prompt` on every scene with the same captain, ship and parrot throughout).

## Local GPU pictures (`worker/kleo_pictures.py`)

The server draws the pictures with Cloudflare Workers AI, whose free quota (10k neurons/day) runs out: scenes then come
back `missing` and the video renders without pictures. The Vast instance has an RTX 4090-class GPU, so the worker draws
the missing pictures itself with Stable Diffusion 1.5 through diffusers (fp16 on CUDA, weights baked into the image).

**Policy — `KLEO_PICTURES`** (read by `prepare_project()`, cartoon / realistic storyboards only):

| Value | What happens |
|---|---|
| `auto` (default) | ask the server as before; every scene still missing is generated on the GPU; no GPU → those stay missing |
| `server` | the server only, never generate locally (the pre-GPU behaviour) |
| `local` | never call `POST /internal/jobs/:id/images`; every prompted scene is generated on the GPU (nothing at all without a GPU) |

Progress / log line: `N pictures from server, M generated on the GPU, K missing` (preceded by `generating K pictures on
the GPU (cartoon)` while the GPU works). The images call, the download and the local generation are each optional and
never fatal: a scene without picture renders like a plain Keou scene.

**Models and settings** (`kleo_pictures.py`, same spirit as `src/images.ts`):

| Style | Checkpoint (HF) | Prompt suffix | Guidance |
|---|---|---|---|
| cartoon | `Lykon/dreamshaper-8` (SD1.5, illustration-friendly) | `flat vector cartoon illustration, bold clean outlines, vivid warm colors, simple shapes, no text, no letters` | 6.5 |
| realistic | `SG161222/Realistic_Vision_V5.1_noVAE` (SD1.5, photo look; SD1.5's own VAE) | `cinematic photograph, 35mm lens, dramatic natural light, high detail, no text` | 5.5 |

Common: 512x896 for 9:16, 896x512 for 16:9 (SD1.5 is trained at 512; the engine scales the picture full-bleed with the
Ken Burns move, so 512 wide is plenty behind 2160 px beats), 22 steps of DPM++ 2M Karras, negative prompt `text, letters,
words, watermark, logo, signature, caption, subtitles, blurry, deformed, low quality, worst quality`, one PNG per scene at
`<project>/img/<sceneId>.png`, seed = first 31 bits of `sha256(sceneId)` (a retry of the same job draws the same pictures),
safety checker disabled (it blanks harmless pictures; prompts are validated by the server before the job exists),
attention slicing on, the pipeline loaded once per style and kept for the job.

**Timings to expect** (SD1.5 fp16, RTX 4090): about 1.5 s per 512x896 picture at 22 steps, plus 3-6 s to load the
pipeline from the image's cache the first time; a 10-scene cartoon Short therefore costs ~20 s of GPU before the voice
stage. On an RTX 3090 / A5000 count 3-4 s per picture, on a T4 ~10 s. VRAM: under 4 GB, so it never competes with Kokoro.

**Weights**: `prewarm_models.py` downloads both checkpoints at build time into `HF_HOME` (`/opt/kleo/hf`) — configs,
tokenizer files and the fp16 safetensors of `text_encoder` / `unet` / `vae` only, never the safety checker nor the
`.bin` / `.ckpt` duplicates (~2 GB per model, the image grows by about 4 GB) — and loads each pipeline once, offline, to
prove the cache is complete. At run time `load_pipeline()` tries the cached fp16 variant, then the cached plain
safetensors; only when neither exists and `KLEO_PICTURES_DOWNLOAD` is not `0` does it lift `HF_HUB_OFFLINE` for the
duration of one `from_pretrained` and download from Hugging Face (a fallback for hand-built images, slow on Vast).

**CPU note**: without CUDA `generate_pictures()` returns `{}` immediately and the worker keeps the server pictures (the
CPU pool changes nothing). `KLEO_PICTURES_CPU=1` forces fp32 CPU generation — minutes per picture, only for checking the
plumbing on a box without GPU; never set it in production. The owner's laptop never runs models: the unit tests inject
fake `torch` / `diffusers` modules and need neither installed.

Manual check on a GPU box (inside the container):

```sh
python3 /opt/kleo/kleo_pictures.py cartoon 9:16 /tmp/pics "a wooden pirate ship at anchor in a turquoise bay, a red parrot on the bow"
# → HH:MM:SS pictures: loaded Lykon/dreamshaper-8 variant=fp16 local_files_only=True in 4.2 s
#   HH:MM:SS pictures: scene-1: 512x896 seed 1234567 in 1.6 s
#   HH:MM:SS pictures: 1/1 pictures (cartoon, 9:16) on cuda in 6.1 s
```
