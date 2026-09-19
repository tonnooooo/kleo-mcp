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

# UN MODELLO PER STILE, E LA SUA FAMIGLIA, perche' la famiglia decide la classe di pipeline, la misura e i passi.
# 11 settembre 2026, misurato su una 3090 noleggiata con le stesse sei descrizioni e lo stesso seme:
# SD1.5 (Realistic_Vision) a 896x512 contro SDXL base a 1344x768. SDXL vince sui due difetti che il proprietario
# ha nominato -- il dettaglio (la venatura del legno e i mattoni si vedono) e la fedelta' alla descrizione (l'unica
# inquadratura che chiedeva "un palo pietrificato tirato sulla banchina" usciva come assi sparse con una cascata
# inventata, e con SDXL esce come un trave con le crepe). Costa 16 s per immagine invece di 7, cioe' 6,5 minuti
# invece di 3 per le 24 di uno Short, dentro un video che ne dura quaranta.
# Il CARTOON resta su dreamshaper-8 perche' NON e' stato misurato: SD1.5 regge molto meglio l'illustrazione del
# fotorealismo, e cambiare per analogia e' esattamente il modo in cui oggi ci siamo fatti male quattro volte.
MODELS = {"cartoon": "Lykon/dreamshaper-8", "realistic": "stabilityai/stable-diffusion-xl-base-1.0", "animation": "Lykon/dreamshaper-xl-v2-turbo"}
FAMILY = {"cartoon": "sd15", "realistic": "sdxl", "animation": "sdxl"}
# EXACTLY src/images.ts STYLE_SUFFIX / NEGATIVE_PROMPT, character for character: the two sides draw pictures for the
# SAME video, so a difference between them is a film in two looks. test/images.test.mjs reads these three literals
# out of this file and fails if they drift. They used to differ already, and nobody had noticed: the negative here
# carried "low quality, worst quality" and the server's did not.
# No negation in the positive prompt: CLIP does not read it there (in SD1.5 "no text" is a documented way of getting
# more text), and those tokens sat at the end, which is the end CLIP truncates first.
STYLE_SUFFIX = {
    "cartoon": "flat vector cartoon illustration, bold clean outlines, vivid warm colors, simple shapes",
    "realistic": "cinematic photograph, RAW photo, 35mm lens, natural light, sharp focus on the subject, real skin and fabric texture, high detail",
    "animation": "frame from a 2D animated feature film, hand-painted background, clean expressive character design, cel shading, rich colour, cinematic composition, high detail",
}
NEGATIVE_PROMPT = "text, letters, watermark, logo, caption, subtitles, blurry, soft focus, cgi, 3d render, illustration, drawing, comic, anime, manga, line art, cartoon, painting, plastic skin, oversmooth, low detail, deformed, low quality"
# The negative side per look: the photographic looks share the product-wide one; ANIMATION bans the photograph instead
# of the drawing. EXACTLY src/images.ts STYLE_NEGATIVE, read by the same drift test.
STYLE_NEGATIVE = {
    "cartoon": NEGATIVE_PROMPT,
    "realistic": NEGATIVE_PROMPT,
    "animation": "text, letters, watermark, logo, caption, subtitles, photograph, photorealistic, live action, real skin, 3d render, cgi, blurry, low detail, deformed, extra fingers, low quality",
}
GUIDANCE = {"cartoon": 6.5, "realistic": 5.5, "animation": 6.0}
STEPS = 22
# La misura comoda di ciascuna famiglia, non un desiderio: SD1.5 e' addestrato a 512 e si sfalda sopra ~768;
# SDXL e' addestrato attorno al megapixel. Il fotogramma consegnato e' 2160x3840, quindi anche 1344x768 resta un
# ingrandimento -- ma di 2,9 volte lineari invece di 4,3, cioe' 2,2 volte i pixel veri.
SIZES = {
    "sd15": {"9:16": (512, 896), "16:9": (896, 512)},
    "sdxl": {"9:16": (768, 1344), "16:9": (1344, 768)},
}
STEPS_BY_FAMILY = {"sd15": 22, "sdxl": 30}
GUIDANCE_BY_FAMILY = {"sd15": None, "sdxl": 6.0}   # None = usa GUIDANCE[style], la taratura di SD1.5
# Per-look overrides of the family defaults, for a fine-tune that samples differently from its base (a turbo model
# wants few steps, low guidance and the SDE sampler). An absent entry falls through to the family.
# ANIMATION = DreamShaper XL v2 Turbo, chosen on a rented box on 14 September against SDXL base and Animagine XL 3.1 on
# the same prompts and seeds: the only one whose characters read as a painted animated feature and stay themselves
# from shot to shot, and the fastest (8 steps: 5 pictures in 30 s against 83 for SDXL base). A turbo model wants few
# steps, low guidance and the SDE sampler; anything else washes it out.
STEPS_BY_STYLE = {"animation": 8}
GUIDANCE_BY_STYLE = {"animation": 2.0}
SCHEDULER_BY_STYLE = {"animation": "sde"}   # "sde" = DPM++ SDE Karras, "euler_a" = Euler ancestral; otherwise DPM++ 2M Karras
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


def lights_pictures(style):
    """Whether the section's accent goes into the prompt as a light source. Not for the ANIMATION look: on the turbo
    SDXL model that draws it (8 steps, guidance 2) "a single warm red light source" is not a light but a colour cast —
    the first frame of a pastel story about a pastry chef came back as a red kitchen, a red apron and a red sauce
    (job gt_ad2musq5, 19 September 2026), and the apron asked for was lilac. A drawn film keeps its colour law on the
    layer; the photographic looks keep the light. Mirrors src/direction.ts lightsPictures()."""
    return style != "animation"


SCENE_ID = re.compile(r"[a-z0-9-]{1,56}")           # picture id "<sceneId>-s<n>" (contract.py slug ≤ 50 + shot suffix) → safe file name
_pipelines = {}                                     # style → loaded pipeline (one job per instance, but a job may need one style only)


def log(*a):
    print(time.strftime("%H:%M:%S"), "pictures:", *a, flush=True)


def seed_for(scene_id):
    """Deterministic 31-bit seed from the picture id: the same shot always draws the same picture (re-runs, retries)."""
    return int.from_bytes(hashlib.sha256(str(scene_id).encode("utf-8")).digest()[:4], "big") & 0x7FFFFFFF


def full_prompt(image_prompt, style, context="", lead=""):
    """<lead>, <scene prompt>, <direction context>, <style suffix>. SD1.5's CLIP encoder reads 77 tokens only.

    THE LEAD IS THE CAST. What comes first weighs most for a diffusion model, and the one thing a viewer notices
    across ten independently drawn pictures is a face that changes: a thin blonde pastry chef in a lilac apron was
    drawn as three different women (job gt_ad2musq5, 19 September 2026) with her look appended AFTER the scene. So
    generate_pictures() passes the look of whoever the picture shows as `lead`, in front of the author's sentence;
    the light of the section (the `context`) stays behind it, where a light belongs.

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
    head = " ".join(str(lead or "").split()).strip()
    if len(head) > CONTEXT_MAX:
        head = head[:CONTEXT_MAX].rsplit(" ", 1)[0] if " " in head[:CONTEXT_MAX] else ""
    head = head.rstrip(",.;")
    suffix = STYLE_SUFFIX[style]
    return ", ".join([x for x in (head, base, ctx, suffix) if x])


def negative_for(direction, style="realistic"):
    """The product-wide negative prompt plus everything THIS film's direction forbids, capped so the negative side of
    CLIP cannot overflow either. One fixed ten-word negative for every video Kleo will ever make is what let a wifi
    symbol into a pirate storm; an exclusion list written for one film is what stops it."""
    base = STYLE_NEGATIVE.get(style, NEGATIVE_PROMPT)
    terms = []
    if isinstance(direction, dict):
        for t in direction.get("forbidden") or []:
            t = " ".join(str(t).split()).strip().rstrip(",.;")
            if t and t.lower() not in base.lower():
                terms.append(t)
    joined = base
    for t in terms:
        if len(joined) + len(t) + 2 > NEGATIVE_MAX:
            break
        joined += ", " + t
    return joined


# The pronouns and generic words that can only mean the film's one character. Mirrors src/direction.ts PRONOUN_HINTS.
PRONOUN_HINTS = re.compile(r"(?<![^\W\d_])(?:she|her|hers|herself|he|him|his|himself|the character|the protagonist)(?![^\W\d_])", re.IGNORECASE)


def head_noun_in(name, image_prompt):
    """The head noun of a cast name ("chef" of "the pastry chef") as a whole word of the prompt, four letters or more.
    Mirrors src/direction.ts headNounIn()."""
    parts = name.strip().lower().split()
    head = parts[-1] if parts else ""
    if len(head) < 4:
        return False
    return re.search(r"(?<![^\W\d_])" + re.escape(head) + r"(?![^\W\d_])", image_prompt, re.IGNORECASE) is not None


def cast_in(direction, image_prompt):
    """The cast members this picture shows, as [{"name", "look"}]: named in the prompt (whole name or its head noun),
    or — when the film has ONE recurring character — meant by "she", "her", "he", "the character". Measured on job
    gt_7f7aaac6 (19 September 2026): "She holds a spoon and mixes a bowl of batter" carried no look and came back as
    a brunette in a red apron between eight pictures of the blonde pastry chef in lilac. Mirrors src/direction.ts castFor()."""
    if not isinstance(direction, dict):
        return []
    lowered = str(image_prompt or "").lower()
    cast = []
    for m in direction.get("cast") or []:
        if not isinstance(m, dict):
            continue
        name = " ".join(str(m.get("name") or "").split()).strip()
        look = " ".join(str(m.get("look") or "").split()).strip()
        if name and look:
            cast.append({"name": name, "look": look})
    named = [m for m in cast if m["name"].lower() in lowered or head_noun_in(m["name"], str(image_prompt or ""))]
    if named or len(cast) != 1:
        return named
    return cast if PRONOUN_HINTS.search(str(image_prompt or "")) else []


def cast_for(direction, image_prompt, budget=None):
    """The look of whichever cast members this picture names — "the pastry chef: a thin woman with short blonde hair
    tied up, lilac apron" — whole sentences inside `budget`, or "". It is what generate_pictures() puts FIRST."""
    return context_for(direction, image_prompt, None, budget)


def light_for(accent, style=None):
    """The section's light as a prompt sentence, or "" — never for a look lights_pictures() excludes."""
    return (ACCENT_LIGHT.get(accent) or "") if lights_pictures(style) else ""


def context_for(direction, image_prompt, accent, budget=None, style=None):
    """The direction's extra sentences for ONE picture: the look of whichever cast members it names, then the light of
    its section (none for a look lights_pictures() excludes). Mirrors src/direction.ts pictureContext(), minus the
    world sentence the CLIP budget cannot afford.

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
    for m in cast_in(direction, image_prompt):
        add(f"{m['name']}: {m['look']}")
    if lights_pictures(style):
        add(ACCENT_LIGHT.get(accent))
    return ". ".join(bits)


def family_of(style):
    return FAMILY.get(style, "sd15")


def size_for(fmt, style="realistic"):
    per = SIZES.get(family_of(style), SIZES["sd15"])
    return per.get(fmt, per["9:16"])


def steps_for(style):
    return int(os.environ.get("KLEO_PICTURES_STEPS") or STEPS_BY_STYLE.get(style) or STEPS_BY_FAMILY.get(family_of(style), STEPS))


def guidance_for(style):
    g = GUIDANCE_BY_STYLE.get(style)
    if g is None:
        g = GUIDANCE_BY_FAMILY.get(family_of(style))
    return GUIDANCE[style] if g is None else g


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
    # La classe di pipeline segue la famiglia. SDXL non ha safety_checker fra i suoi argomenti: passarglielo solleva.
    fam = family_of(style)
    if fam == "sdxl":
        from diffusers import StableDiffusionXLPipeline as Pipe
    else:
        from diffusers import StableDiffusionPipeline as Pipe
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.float16 if device == "cuda" else torch.float32
    model = MODELS[style]
    common = dict(torch_dtype=dtype, use_safetensors=True)
    if fam != "sdxl":
        common.update(safety_checker=None, requires_safety_checker=False)
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
            pipe = Pipe.from_pretrained(model, **kw)
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
        kind = SCHEDULER_BY_STYLE.get(style)
        if kind == "euler_a":
            from diffusers import EulerAncestralDiscreteScheduler
            pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(pipe.scheduler.config)
        elif kind == "sde":
            pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True, algorithm_type="sde-dpmsolver++")
        else:
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
    path} for the pictures made. style: cartoon | realistic | animation; fmt: 9:16 | 16:9; out_dir is created. `direction` is the
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
    width, height = size_for(fmt, style)
    negative = negative_for(direction, style)
    os.makedirs(out_dir, exist_ok=True)
    done = {}
    t_all = time.time()
    for s in wanted:
        sid, seed = s["id"], seed_for(s["id"])
        path = os.path.join(out_dir, sid + ".png")
        t0 = time.time()
        try:
            gen = torch.Generator(device=device).manual_seed(seed)
            prompt = full_prompt(s["image_prompt"], style, light_for(s.get("accent"), style), lead=cast_for(direction, s["image_prompt"]))
            result = pipe(prompt=prompt, negative_prompt=negative, width=width, height=height,
                          num_inference_steps=steps_for(style), guidance_scale=guidance_for(style), generator=gen)
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
