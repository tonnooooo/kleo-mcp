#!/usr/bin/env python3
"""Build-time model warm-up: every model the Keou engine needs lands in the image's
HF cache (HF_HOME) so a Vast instance boots and renders without any download.
Reads the voice list from contract.py so the cache always matches the contract.
Also fetches the two Stable Diffusion 1.5 checkpoints kleo_pictures.py draws the cartoon / realistic
scene pictures with (fp16 safetensors + configs only, ~2 GB each; PREWARM_PICTURES=0 skips them).
PICTURE_MODELS is a copy of kleo_pictures.MODELS on purpose: importing kleo_pictures here would key this
(slow, 4 GB) layer on a file that changes often; test_kleo_pictures.py checks the two tables agree."""
import importlib.util, os, sys, time
from pathlib import Path

PICTURE_MODELS = {"cartoon": "Lykon/dreamshaper-8", "realistic": "stabilityai/stable-diffusion-xl-base-1.0", "animation": "stabilityai/stable-diffusion-xl-base-1.0"}
# La famiglia decide la classe di pipeline con cui il modello si carica: SDXL non si apre con
# StableDiffusionPipeline. Copia deliberata di kleo_pictures.FAMILY, verificata dal test che confronta le tabelle.
PICTURE_FAMILY = {"cartoon": "sd15", "realistic": "sdxl", "animation": "sdxl"}
# Which of them are baked into the image. Every gigabyte here is downloaded again by every rented instance before
# it can start (a 15 GB image took 16 minutes to pull on a 900 Mbit host), while the same weights come from
# Hugging Face at ~2 GB in half a minute, once, on the instance itself. So only the common look travels in the
# image; PREWARM_PICTURES=all bakes both, =0 bakes none.
BAKED = os.environ.get("PREWARM_PICTURES", "1")

# Configs, tokenizer files and fp16 weights of the parts the pipeline loads; the safety checker (disabled at run time,
# 1.2 GB) and the .bin / .ckpt duplicates never enter the image.
PICTURE_ALLOW_FP16 = ["*.json", "*.txt", "text_encoder/*.fp16.safetensors", "unet/*.fp16.safetensors", "vae/*.fp16.safetensors"]
PICTURE_ALLOW_FULL = ["*.json", "*.txt", "text_encoder/*.safetensors", "unet/*.safetensors", "vae/*.safetensors"]
PICTURE_IGNORE = ["safety_checker/*", "*.bin", "*.ckpt", "*.msgpack", "*.onnx", "*.h5"]


def picture_models():
    """The models this build bakes in: all of them with PREWARM_PICTURES=all, otherwise cartoon only."""
    if BAKED == 'all':
        return PICTURE_MODELS
    return {k: v for k, v in PICTURE_MODELS.items() if k == 'cartoon'}


def prewarm_pictures():
    """snapshot_download of each picture model into HF_HOME. Tries the fp16 variant first; a repo without fp16 files
    (the unet is the tell) gets its plain safetensors instead (loaded as fp16 at run time all the same)."""
    from huggingface_hub import snapshot_download
    for style, repo in sorted(picture_models().items()):
        t0 = time.time()
        path = snapshot_download(repo, allow_patterns=PICTURE_ALLOW_FP16, ignore_patterns=PICTURE_IGNORE)
        variant = "fp16"
        if not list(Path(path, "unet").glob("*.fp16.safetensors")):
            path = snapshot_download(repo, allow_patterns=PICTURE_ALLOW_FULL, ignore_patterns=PICTURE_IGNORE)
            variant = "default"
        files = [p for p in Path(path).rglob("*") if p.is_file()]
        size = sum(p.stat().st_size for p in files) / 1e9
        assert Path(path, "model_index.json").is_file(), f"{repo}: no model_index.json"
        assert any(p.suffix == ".safetensors" and p.parent.name == "unet" for p in files), f"{repo}: no unet weights"
        print(f"PREWARM picture {style} {repo} variant={variant} {len(files)} files {size:.2f} GB in {time.time() - t0:.0f}s", flush=True)


contract = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location('contract', contract); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
LANG = {'en': None, 'fr': 'f', 'it': 'i'}
SAMPLE = {'en': 'The render pipeline is ready.', 'fr': 'Le moteur de rendu est prêt.', 'it': 'Il motore di rendering è pronto.'}

import numpy as np
from kokoro import KPipeline
from faster_whisper import WhisperModel

t0 = time.time()
for language, voices in sorted(mod.VOICES.items()):
    for voice in sorted(voices):
        lang = LANG.get(language) or ('b' if voice.startswith('b') else 'a')
        pipe = KPipeline(lang_code=lang, device='cpu', repo_id='hexgrad/Kokoro-82M')
        audio = np.concatenate([np.asarray(ch.audio) for ch in pipe(SAMPLE[language], voice=voice)])
        assert np.isfinite(audio).all() and len(audio) > 24000 * .3, f'{voice}: synthesis failed'
        print(f'PREWARM voice {language}/{voice} lang_code={lang} {len(audio)/24000:.2f}s', flush=True)
asr = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=2)
segments, _ = asr.transcribe(np.zeros(24000, dtype=np.float32), language='en', beam_size=1)
list(segments)
print(f'PREWARM asr small/int8 ok', flush=True)
import spacy; spacy.load('en_core_web_sm'); print('PREWARM spacy en_core_web_sm ok', flush=True)
if os.environ.get('PREWARM_PICTURES', '1') != '0':
    prewarm_pictures()
    # Load once on the CPU, offline, exactly as kleo_pictures.load_pipeline does at run time: proves the cached files are
    # enough (no weights are run: KLEO_PICTURES_CPU is not set, so no picture is drawn here).
    import torch
    from diffusers import StableDiffusionPipeline, StableDiffusionXLPipeline
    for style, repo in sorted(picture_models().items()):
        sdxl = PICTURE_FAMILY.get(style) == 'sdxl'
        Pipe = StableDiffusionXLPipeline if sdxl else StableDiffusionPipeline
        extra = {} if sdxl else dict(safety_checker=None, requires_safety_checker=False)
        try:
            _pipe = Pipe.from_pretrained(repo, torch_dtype=torch.float16, variant='fp16',
                                         use_safetensors=True, local_files_only=True, **extra)
        except Exception:
            _pipe = Pipe.from_pretrained(repo, torch_dtype=torch.float16,
                                         use_safetensors=True, local_files_only=True, **extra)
        print(f'PREWARM picture pipeline {style} loads offline', flush=True)
        del _pipe; import gc; gc.collect()
print(f'PREWARM_DONE {time.time()-t0:.0f}s HF_HOME={os.environ.get("HF_HOME")}', flush=True)
