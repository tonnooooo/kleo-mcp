#!/usr/bin/env python3
"""
Local picture generation for Kleo cartoon / realistic storyboards, run on the Vast.ai GPU by kleo_worker.py.

The server draws the shot pictures with Cloudflare Workers AI; when its quota is gone the pictures come back "missing"
and this module fills the gap with Stable Diffusion 1.5 checkpoints (diffusers, fp16 on CUDA):

    cartoon    Lykon/dreamshaper-8                    illustration-friendly SD1.5 fine-tune
    realistic  SG161222/Realistic_Vision_V5.1_noVAE   photo-look SD1.5 fine-tune (SD1.5's own VAE is fine)

Sizes 512x896 (9:16) / 896x512 (16:9), 22 DPM++ steps, guidance 6.5 (cartoon) / 5.5 (realistic), the same style suffix
and negative prompt the server uses, a deterministic seed per picture id ("<sceneId>-s<n>", one per shot), the safety
checker disabled (it blanks harmless pictures; prompts are validated by the server before the job exists), attention
slicing on.

generate_pictures() never raises for a picture: it returns only the successes. Without CUDA it returns {} at once
(the CPU pool keeps using the server pictures) unless KLEO_PICTURES_CPU=1 (fp32, minutes per picture: tests only).
Weights are expected in HF_HOME (the image pre-downloads them in prewarm_models.py; HF_HUB_OFFLINE=1 is set there).
When a model is not cached and KLEO_PICTURES_DOWNLOAD is not "0", the load temporarily lifts the offline flag and
downloads it from Hugging Face (~2 GB fp16 each) — a fallback for hand-built images, never the normal path.

torch / diffusers are imported inside the functions only: kleo_worker.py and the unit tests import this module on
machines without them (the tests inject fakes through sys.modules).
"""
import hashlib, os, re, sys, time

MODELS = {"cartoon": "Lykon/dreamshaper-8", "realistic": "SG161222/Realistic_Vision_V5.1_noVAE"}
# Same spirit as src/images.ts STYLE_SUFFIX / NEGATIVE_PROMPT so server and GPU pictures look alike within one video.
STYLE_SUFFIX = {
    "cartoon": "flat vector cartoon illustration, bold clean outlines, vivid warm colors, simple shapes, no text, no letters",
    "realistic": "cinematic photograph, 35mm lens, dramatic natural light, high detail, no text",
}
NEGATIVE_PROMPT = "text, letters, words, watermark, logo, signature, caption, subtitles, blurry, deformed, low quality, worst quality"
GUIDANCE = {"cartoon": 6.5, "realistic": 5.5}
STEPS = 22
SIZES = {"9:16": (512, 896), "16:9": (896, 512)}  # (width, height): SD1.5 is trained at 512, ~1.75:1 still holds together
PROMPT_MAX = 240                                    # src/keou-contract.ts IMAGE_PROMPT_MAX
BASE_MAX = 150                                      # scene text kept in the SD prompt (CLIP: 77 tokens in total)
CONTEXT_MAX = 110                                   # the film's direction (cast look + section light) inside that budget
NEGATIVE_MAX = 320                                  # the negative side of CLIP has its own 77 tokens; stay under them
# Mirrors src/direction.ts ACCENT_LIGHT: a named colour, because diffusion models follow colour names and ignore hex.
ACCENT_LIGHT = {
    "red": "a single warm red light source",
    "amber": "a single warm amber light source",
    "green": "a single cool green light source",
    "cyan": "a single cold cyan light source",
}
SCENE_ID = re.compile(r"[a-z0-9-]{1,56}")           # picture id "<sceneId>-s<n>" (contract.py slug ≤ 50 + shot suffix) → safe file name
_pipelines = {}                                     # style → loaded pipeline (one job per instance, but a job may need one style only)


def log(*a):
    print(time.strftime("%H:%M:%S"), "pictures:", *a, flush=True)


def seed_for(scene_id):
    """Deterministic 31-bit seed from the picture id: the same shot always draws the same picture (re-runs, retries)."""
    return int.from_bytes(hashlib.sha256(str(scene_id).encode("utf-8")).digest()[:4], "big") & 0x7FFFFFFF


def full_prompt(image_prompt, style, context=""):
    """<scene prompt>, <direction context>, <style suffix>. SD1.5's CLIP encoder reads 77 tokens only.

    THE STYLE SUFFIX IS LAST, SO IT IS WHAT FALLS. An earlier version of this comment claimed the character budget
    protected it; it does not, because CLIP truncates from the tail and the tail is the suffix. Measured on the 23
    real image prompts of the three cartoon films delivered so far: without a direction they run 46-54 tokens and
    none overflows. Attach a direction and the same prompts run 69-77, and 3 of the 23 cross the line. What falls
    is "no letters" — a term the negative prompt already carries, so today the loss costs nothing.

    What it costs is the MARGIN. The next terms in the tail are "simple shapes", "vivid warm colors", "bold clean
    outlines": the look itself. One longer scene sentence, or one longer character look, and the picture stops
    being drawn in the film's style. Whoever raises CONTEXT_MAX or PROMPT_MAX must re-run that measurement first.

    The ceiling belongs to SD1.5's CLIP, not to Kleo: an encoder with room (FLUX reads 512 tokens through T5) makes
    all three budgets here obsolete, and the direction could then carry its world sentence too instead of dropping it.

    The context is the film's direction as src/direction.ts pictureContext() builds it — the verbatim look of the
    characters in this picture, and the light of the section it belongs to. It is what keeps the captain looking like
    the captain across twelve independently drawn pictures. The server has room for the world sentence as well; here
    the token budget does not stretch that far, so the cast comes first: a face that changes is what a viewer sees."""
    base = " ".join(str(image_prompt or "").split())[:PROMPT_MAX].strip()
    if len(base) > BASE_MAX:
        base = base[:BASE_MAX].rsplit(" ", 1)[0] if " " in base[:BASE_MAX] else base[:BASE_MAX]
    base = base.strip().rstrip(",.;")
    # The context arrives already fitted by context_for(); this is the last guard, and it cuts on a word boundary so
    # nothing can reach CLIP as a fragment.
    ctx = " ".join(str(context or "").split()).strip()
    if len(ctx) > CONTEXT_MAX:
        ctx = ctx[:CONTEXT_MAX].rsplit(" ", 1)[0] if " " in ctx[:CONTEXT_MAX] else ""
    ctx = ctx.rstrip(",.;")
    suffix = STYLE_SUFFIX[style]
    return ", ".join([x for x in (base, ctx, suffix) if x])


def negative_for(direction):
    """The product-wide negative prompt plus everything THIS film's direction forbids, capped so the negative side of
    CLIP cannot overflow either. One fixed ten-word negative for every video Kleo will ever make is what let a wifi
    symbol into a pirate storm; an exclusion list written for one film is what stops it."""
    terms = []
    if isinstance(direction, dict):
        for t in direction.get("forbidden") or []:
            t = " ".join(str(t).split()).strip().rstrip(",.;")
            if t and t.lower() not in NEGATIVE_PROMPT.lower():
                terms.append(t)
    joined = NEGATIVE_PROMPT
    for t in terms:
        if len(joined) + len(t) + 2 > NEGATIVE_MAX:
            break
        joined += ", " + t
    return joined


def context_for(direction, image_prompt, accent, budget=None):
    """The direction's extra sentences for ONE picture: the look of whichever cast members it names, then the light of
    its section. Mirrors src/direction.ts pictureContext(), minus the world sentence the CLIP budget cannot afford.

    `budget` is the room the prompt has for all of this. Each sentence goes in WHOLE or not at all: a real render on a
    rented GPU showed the old blind cut turning "a single cool green light source" into "a si", and four characters of
    a chopped word are not a light, they are noise fed to CLIP. The cast comes first because a face that changes is
    what a viewer notices; the light is dropped before a character ever is."""
    if not isinstance(direction, dict):
        return ""
    lowered = str(image_prompt or "").lower()
    room = CONTEXT_MAX if budget is None else int(budget)
    bits, used = [], 0
    def add(text):
        nonlocal used
        text = " ".join(str(text or "").split()).strip().rstrip(",.;")
        if not text:
            return
        cost = len(text) + (2 if bits else 0)          # ". " between sentences
        if used + cost > room:
            return                                      # whole or not at all
        bits.append(text)
        used += cost
    for m in direction.get("cast") or []:
        if not isinstance(m, dict):
            continue
        name = " ".join(str(m.get("name") or "").split()).strip()
        look = " ".join(str(m.get("look") or "").split()).strip()
        if name and look and name.lower() in lowered:
            add(f"{name}: {look}")
    add(ACCENT_LIGHT.get(accent))
    return ". ".join(bits)


def size_for(fmt):
    return SIZES.get(fmt, SIZES["9:16"])


def cpu_allowed():
    return os.environ.get("KLEO_PICTURES_CPU", "").strip() == "1"


def cuda_available():
    """True when torch is installed and sees a CUDA device. Never raises."""
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def can_generate():
    """Whether generate_pictures() would do anything here: a CUDA GPU, or KLEO_PICTURES_CPU=1 (with torch installed)."""
    if cuda_available():
        return True
    if cpu_allowed():
        try:
            import torch  # noqa: F401
            return True
        except Exception:
            return False
    return False


def _hf_offline(enabled):
    """Flip huggingface_hub's offline mode at run time (the image sets HF_HUB_OFFLINE=1 for Kokoro; the constant is read at
    import, so the module attribute is patched as well). Returns the previous (env, constant) pair for restoring."""
    prev_env = os.environ.get("HF_HUB_OFFLINE")
    os.environ["HF_HUB_OFFLINE"] = "1" if enabled else "0"
    prev_const = None
    try:
        from huggingface_hub import constants
        prev_const = getattr(constants, "HF_HUB_OFFLINE", None)
        constants.HF_HUB_OFFLINE = bool(enabled)
    except Exception:
        pass
    return prev_env, prev_const


def _hf_restore(prev):
    prev_env, prev_const = prev
    if prev_env is None:
        os.environ.pop("HF_HUB_OFFLINE", None)
    else:
        os.environ["HF_HUB_OFFLINE"] = prev_env
    if prev_const is not None:
        try:
            from huggingface_hub import constants
            constants.HF_HUB_OFFLINE = prev_const
        except Exception:
            pass


def load_pipeline(style, device=None):
    """The StableDiffusionPipeline for a style, cached per process. fp16 on CUDA, fp32 on CPU. Tries the cached fp16
    variant first, then the plain safetensors, then (unless KLEO_PICTURES_DOWNLOAD=0) the same two with downloads allowed."""
    if style in _pipelines:
        return _pipelines[style]
    import torch
    from diffusers import StableDiffusionPipeline
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.float16 if device == "cuda" else torch.float32
    model = MODELS[style]
    common = dict(torch_dtype=dtype, safety_checker=None, requires_safety_checker=False, use_safetensors=True)
    attempts = [("fp16", True), (None, True)]
    if os.environ.get("KLEO_PICTURES_DOWNLOAD", "1").strip() != "0":
        attempts += [("fp16", False), (None, False)]
    pipe, errors = None, []
    for variant, local_only in attempts:
        kw = dict(common, local_files_only=local_only)
        if variant:
            kw["variant"] = variant
        prev = _hf_offline(local_only)
        try:
            t0 = time.time()
            pipe = StableDiffusionPipeline.from_pretrained(model, **kw)
            log(f"loaded {model} variant={variant or 'default'} local_files_only={local_only} in {time.time() - t0:.1f} s")
            break
        except Exception as e:
            errors.append(f"variant={variant or 'default'} local={local_only}: {type(e).__name__}: {str(e)[:160]}")
        finally:
            _hf_restore(prev)
    if pipe is None:
        raise RuntimeError(f"could not load {model}: " + " | ".join(errors))
    try:  # DPM++ 2M Karras: SD1.5 looks finished at ~22 steps (the default PNDM/DDIM needs 30-50)
        from diffusers import DPMSolverMultistepScheduler
        pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True)
    except Exception as e:
        log("keeping the default scheduler:", e)
    pipe = pipe.to(device)
    if device != "cuda":  # slicing trades speed for memory: useful on a CPU / small card, slower on a 24 GB GPU
        try:
            pipe.enable_attention_slicing()
        except Exception as e:
            log("attention slicing unavailable:", e)
    try:
        pipe.set_progress_bar_config(disable=True)
    except Exception:
        pass
    _pipelines[style] = pipe
    return pipe


def generate_pictures(scenes, style, fmt, out_dir, device=None, direction=None):
    """scenes: [{"id": <pictureId>, "image_prompt": <text>, "accent": <accent | None>}, ...] → {pictureId: absolute PNG
    path} for the pictures made. style: cartoon | realistic; fmt: 9:16 | 16:9; out_dir is created. `direction` is the
    storyboard's art direction (src/direction.ts): its cast, its accents and its exclusion list shape every prompt.
    Returns {} without CUDA (unless KLEO_PICTURES_CPU=1), for an unknown style, or when the model cannot be loaded;
    a failing scene is logged and skipped."""
    if style not in MODELS:
        log(f"style {style!r} has no local model")
        return {}
    wanted = [s for s in (scenes or []) if isinstance(s, dict) and isinstance(s.get("id"), str) and SCENE_ID.fullmatch(s["id"])
              and isinstance(s.get("image_prompt"), str) and s["image_prompt"].strip()]
    if not wanted:
        return {}
    if device is None:
        if cuda_available():
            device = "cuda"
        elif can_generate():
            device = "cpu"
            log("no CUDA device; KLEO_PICTURES_CPU=1 so generating on the CPU (slow)")
        else:
            log("no CUDA device: leaving the pictures to the server")
            return {}
    try:
        pipe = load_pipeline(style, device)
    except Exception as e:
        log(f"model for {style} unavailable: {e}")
        return {}
    import torch
    width, height = size_for(fmt)
    negative = negative_for(direction)
    os.makedirs(out_dir, exist_ok=True)
    done = {}
    t_all = time.time()
    for s in wanted:
        sid, seed = s["id"], seed_for(s["id"])
        path = os.path.join(out_dir, sid + ".png")
        t0 = time.time()
        try:
            gen = torch.Generator(device=device).manual_seed(seed)
            prompt = full_prompt(s["image_prompt"], style, context_for(direction, s["image_prompt"], s.get("accent")))
            result = pipe(prompt=prompt, negative_prompt=negative, width=width, height=height,
                          num_inference_steps=STEPS, guidance_scale=GUIDANCE[style], generator=gen)
            image = result.images[0]
            image.save(path, format="PNG")
            if not os.path.isfile(path) or os.path.getsize(path) == 0:
                raise RuntimeError("empty file written")
            done[sid] = path
            log(f"{sid}: {width}x{height} seed {seed} in {time.time() - t0:.1f} s")
        except Exception as e:
            log(f"{sid}: generation failed: {type(e).__name__}: {str(e)[:200]}")
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except Exception:
                pass
            _empty_cache()  # after an OOM the next scene needs the memory back
    log(f"{len(done)}/{len(wanted)} pictures ({style}, {fmt}) on {device} in {time.time() - t_all:.1f} s")
    release()  # the Keou render (Chromium workers, Kokoro on the same GPU) runs next: give the VRAM and RAM back
    return done


def _empty_cache():
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def release():
    """Drops the loaded pipelines and frees the GPU memory. Called at the end of generate_pictures; safe to call twice."""
    _pipelines.clear()
    try:
        import gc
        gc.collect()
    except Exception:
        pass
    _empty_cache()


if __name__ == "__main__":  # manual check on a GPU box: python3 kleo_pictures.py cartoon 9:16 /tmp/pics "a pirate ship at anchor"
    style, fmt, out = sys.argv[1], sys.argv[2], sys.argv[3]
    prompts = sys.argv[4:] or ["a wooden pirate ship at anchor in a turquoise bay, palm trees, a red parrot on the bow"]
    made = generate_pictures([{"id": f"scene-{i + 1}-s1", "image_prompt": p} for i, p in enumerate(prompts)], style, fmt, out)
    print(made)
