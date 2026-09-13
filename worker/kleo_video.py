#!/usr/bin/env python3
"""
Generated MOTION for Kleo's picture styles: a shot stops being a photograph with a zoom on it and becomes a clip
that was actually filmed by a camera that moved.

Run on the rented GPU by kleo_worker.py, next to kleo_pictures.py. The division is deliberate:

    kleo_pictures.py   one still per shot          (what the frame contains)
    kleo_video.py      that still, set in motion    (what the frame does)

Model: Wan 2.2 TI2V-5B (Apache 2.0, Alibaba). The licence is the reason it is this one and not a higher-scoring
model: HunyuanVideo and MiniMax Hailuo both carry community licences whose territory excludes the European Union,
and FLUX forbids commercial use of the output. A company that sells videos cannot be built on those.

MEASURED ON AN RTX 6000 Ada, 2026-09-11, nine probe clips at 1280x704, 49 frames, 30 steps:
  · the share of motion explainable as a pure zoom was 0.00-0.03 on every clip. Whatever moves, moves in depth.
    That is the whole point of this file: the Ken Burns it replaces scores ~1.0 on the same measure.
  · six of nine had full motion; the three that did not had NOTHING ALIVE IN THE SCENE (an empty road, a compass on
    a table) and froze at 0.03-0.38 px of flow. The camera instruction was not the problem, the subject was.
    So `alive()` below is not decoration: a shot whose description contains no moving thing gets one, or the model
    returns a still frame at video prices.
  · ~125 s per 2 s clip at 30 steps. A 40 s video of twelve shots is therefore ~40 min of GPU, ~0.50 USD.

Nothing here runs on the owner's computer, ever. torch and diffusers are imported inside the functions so the
module can be imported (and unit-tested with fakes) on a machine that has neither.
"""
import gc, hashlib, json, math, os, re, subprocess, sys, time

MODEL_ID = os.environ.get("KLEO_VIDEO_MODEL", "Wan-AI/Wan2.2-TI2V-5B-Diffusers")
MODEL_DIR = os.environ.get("KLEO_VIDEO_MODEL_DIR", "/workspace/models/wan22-ti2v-5b")
FPS_SRC = 24                                  # what the model generates at

# Two generator families behind the same shot -> clip contract. "wan": Wan 2.2 TI2V-5B, 704p, 32 GB, what shipped
# first. "ltx": LTX-2.5 (Lightricks, 22B, the owner's choice of 13 September): 960x544 in stage one, x2 latent
# upsample to 1920x1088 in stage two, distilled eight-step schedule, image conditioning with the same checkpoint;
# gated weights (HF_TOKEN), 72 GB on disk, an 80 GB card or fp8. The family is read off the model id so that
# switching is one env var, KLEO_VIDEO_MODEL, and nothing else has to know.
FAMILY = "ltx" if "ltx" in MODEL_ID.lower() else "wan"
SIZES = {"16:9": (1280, 704), "9:16": (704, 1280)} if FAMILY == "wan" else {"16:9": (960, 544), "9:16": (544, 960)}
LTX_UPSAMPLE = os.environ.get("KLEO_VIDEO_LTX_UPSAMPLE", "1").strip() != "0"    # stage two: x2 latent upsample
LTX_OFFLOAD = os.environ.get("KLEO_VIDEO_OFFLOAD", "0").strip() == "1"        # cpu offload for a 48 GB card
STEPS = int(os.environ.get("KLEO_VIDEO_STEPS", "30"))
GUIDANCE = float(os.environ.get("KLEO_VIDEO_GUIDANCE", "5.0"))
MAX_S = float(os.environ.get("KLEO_VIDEO_MAX_S", "5.0"))       # past this a generated clip starts to drift
MIN_S = 1.2

# The camera, in the dialect the model answers to. Same ten moves the shot grammar resolves to (src/shot-grammar.ts),
# each with the negations that stop the model turning a physical move into a digital zoom — the discipline is copied
# from how Higgsfield prompts its own presets.
MOVES = {
    "crash_zoom_in": "the camera rushes forward toward the subject and stops hard, a fast dolly on the axis. NOT a digital zoom, NOT a pull-back.",
    "push_in": "the camera pushes slowly forward toward the subject at a constant lens height, still moving when the shot ends. NOT a zoom, NOT a pull-back.",
    "push_in_dutch": "the camera pushes slowly forward while the horizon tilts a few degrees off level, still moving when the shot ends. NOT a zoom, NOT a roll in place.",
    "pull_out": "the camera pulls slowly backward away from the subject, more of the place entering the frame. NOT a zoom out, NOT a push in.",
    "track_left": "the camera tracks laterally to the left at a constant speed, the foreground passing faster than the background. NOT a pan, NOT a zoom.",
    "track_right": "the camera tracks laterally to the right at a constant speed, the foreground passing faster than the background. NOT a pan, NOT a zoom.",
    "track_alongside": "the camera travels alongside the subject at its own speed, holding it in the same part of the frame. NOT a pan, NOT a zoom.",
    "orbit_left": "the camera arcs around the subject to the left, the background sliding behind it. NOT a pan, NOT a zoom.",
    "orbit_right": "the camera arcs around the subject to the right, the background sliding behind it. NOT a pan, NOT a zoom.",
    "crane_down": "the camera cranes slowly downward from above toward eye level, the horizon rising in frame. NOT a tilt, NOT a zoom.",
    "crane_up": "the camera cranes slowly upward, the ground falling away below the frame. NOT a tilt, NOT a zoom.",
    "whip_pan": "the camera whips sideways in a fast blurred pan and settles. NOT a cut, NOT a zoom.",
    "static_hold": "the camera does not move at all: a locked-off frame on a tripod. The scene moves, the camera does not.",
}
LOOK = {
    "realistic": "cinematic live-action photography, 35mm anamorphic, shallow depth of field, natural light, film grain",
    "cartoon": "hand-painted 2D animation, bold clean linework, flat vivid colour, animated the way a feature cartoon moves",
}
NEGATIVE = ("blurry, low quality, worst quality, jpeg artifacts, watermark, text, letters, logo, subtitles, "
            "deformed, morphing, warping face, extra fingers, fused limbs, floating objects, "
            "static image, still frame, frozen, motionless, slideshow, photo montage")

# A shot with nothing alive in it comes back as a still frame. These are the things that read as "the world is
# running" without adding a character the story did not ask for; one is picked deterministically from the shot id.
ALIVE = [
    "dust turning slowly in the light", "a light breeze moving through the scene",
    "soft haze drifting across the frame", "the light shifting slowly as clouds pass",
    "small particles floating in the air", "a slow curl of steam crossing the frame",
]
# Words that already promise movement. If none of them appears, the shot gets one of the lines above.
MOVING = re.compile(
    r"\b(walk\w*|run\w*|ride\w*|driv\w*|fly\w*|flying|sail\w*|swim\w*|climb\w*|fall\w*|falling|drop\w*|"
    r"rise|rising|turn\w*|spin\w*|roll\w*|wave\w*|waving|swing\w*|shake\w*|shaking|blow\w*|blowing|"
    r"drift\w*|float\w*|flow\w*|pour\w*|splash\w*|break\w*|crash\w*|burn\w*|burning|flicker\w*|gutter\w*|"
    r"smoke|smok\w*|steam|mist|fog|rain|raining|snow\w*|wind|storm|surf|swell|current|"
    r"crowd|traffic|flame\w*|spark\w*|bubbl\w*|leaves|dust|reach\w*|lift\w*|open\w*|clos\w*|"
    r"enter\w*|exit\w*|pass\w*|cross\w*|approach\w*|leav\w*|moving|motion)\b", re.I)

_pipe = None


def log(*a):
    print(time.strftime("%H:%M:%S"), "video:", *a, flush=True)


def seed_for(shot_id):
    """The same shot always generates the same clip: a re-run after a crash costs nothing and looks identical."""
    return int.from_bytes(hashlib.sha256(str(shot_id).encode("utf-8")).digest()[:4], "big") & 0x7FFFFFFF


def has_motion(text):
    return bool(MOVING.search(str(text or "")))


def alive(shot_id):
    """A deterministic line of life for a scene that has none."""
    return ALIVE[seed_for("alive:" + str(shot_id)) % len(ALIVE)]


def frames_for(seconds):
    """Wan wants 4n+1 frames, LTX 8n+1. Clamped to what stays coherent: past ~5 s a generated clip drifts."""
    s = min(MAX_S, max(MIN_S, float(seconds or 3.0)))
    n = int(round(s * FPS_SRC))
    step = 8 if FAMILY == "ltx" else 4
    return max(17, (n // step) * step + 1)


def build_prompt(shot, look):
    """subject (+ life, if it has none) + the camera, in that order: the model reads the beginning most strongly."""
    subject = " ".join(str(shot.get("image_prompt") or "").split()).strip().rstrip(".")
    if not subject:
        return None
    parts = [subject]
    if not has_motion(subject):
        parts.append(alive(shot.get("id") or subject))
    style = LOOK.get(look)
    if style:
        parts.append(style)
    move = MOVES.get(shot.get("motion") or "", MOVES["static_hold"])
    return ". ".join([", ".join(parts), move])


def can_generate():
    """Whether this machine can do it at all. Never raises."""
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


# Two ways to ask the same weights for a clip. "t2v" invents the scene from the text; "i2v" ANIMATES A GIVEN
# FRAME — the shot's own still, which the picture model drew at 1344x768 with the composition the storyboard asked
# for. The frame arrives sharp and on purpose; the video model only has to make it move. That is how the
# commercial tools the owner measures against work (image first, motion second), and it is the difference
# between a scene the model half-imagined at 704 px and one it was handed.
def _hf_offline(enabled):
    """Flip huggingface_hub's offline mode at run time (same as kleo_pictures: the constant is read at import, so the
    module attribute is patched as well). Returns the previous (env, constant) pair for _hf_restore."""
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


KINDS = {"t2v": "WanPipeline", "i2v": "WanImageToVideoPipeline"}
_kind = None
_upsampler = None   # LTX stage two, built once next to the pipeline


def load_ltx():
    """LTX-2.5 through diffusers: one pipeline for text and image conditioning, plus the x2 latent upsampler for
    stage two. Read from the model card on 13 September, not assumed: LTX2Pipeline(image=..., prompt=...,
    sigmas=DISTILLED_SIGMA_VALUES, guidance_scale=1.0, ...) -> (video, audio); LTX2LatentUpsamplePipeline(vae,
    latent_upsampler) between the two stages."""
    global _pipe, _kind, _upsampler
    if _pipe is not None and _kind == "ltx":
        return _pipe
    if _pipe is not None:
        release()
    import torch, diffusers
    from diffusers import LTX2Pipeline
    src = MODEL_DIR if os.path.isdir(os.path.join(MODEL_DIR, "model_index.json")) else MODEL_ID
    t0 = time.time()
    prev = _hf_offline(False)
    try:
        pipe = LTX2Pipeline.from_pretrained(src, dtype=torch.bfloat16, token=os.environ.get("HF_TOKEN") or None)
        if LTX_OFFLOAD:
            pipe.enable_model_cpu_offload()
        else:
            pipe = pipe.to("cuda")
        if LTX_UPSAMPLE:
            from diffusers import LTX2LatentUpsamplePipeline
            from diffusers.pipelines.ltx2.latent_upsampler import LTX2LatentUpsamplerModel
            up = LTX2LatentUpsamplerModel.from_pretrained(src, subfolder="latent_upsampler", dtype=torch.bfloat16,
                                                          token=os.environ.get("HF_TOKEN") or None).to("cuda")
            _upsampler = LTX2LatentUpsamplePipeline(vae=pipe.vae, latent_upsampler=up)
    finally:
        _hf_restore(prev)
    try:
        pipe.vae.enable_tiling()
    except Exception as e:
        log("vae tiling unavailable:", e)
    try:
        pipe.set_progress_bar_config(disable=True)
    except Exception:
        pass
    log(f"ltx pipeline ready in {time.time() - t0:.0f} s from {src} (upsample {'on' if LTX_UPSAMPLE else 'off'})")
    _pipe, _kind = pipe, "ltx"
    return pipe


def ltx_clip(pipe, prompt, still, w, h, n, generator):
    """One shot with LTX-2.5: stage one at (w, h), then the x2 latent upsample and stage two when enabled.
    Returns frames T x H x W x 3 in [0, 1]. The audio the model also makes is dropped: the narration is ours."""
    from diffusers.pipelines.ltx2.utils import DEFAULT_NEGATIVE_PROMPT, DISTILLED_SIGMA_VALUES, STAGE_2_DISTILLED_SIGMA_VALUES
    shared = dict(prompt=prompt, negative_prompt=DEFAULT_NEGATIVE_PROMPT, frame_rate=float(FPS_SRC), guidance_scale=1.0,
                  audio_guidance_scale=1.0, stg_scale=0.0, audio_stg_scale=0.0, modality_scale=1.0, audio_modality_scale=1.0,
                  generator=generator, return_dict=False)
    if still is not None:
        shared["image"] = still
    if not (LTX_UPSAMPLE and _upsampler is not None):
        video, _audio = pipe(height=h, width=w, num_frames=n, sigmas=DISTILLED_SIGMA_VALUES, output_type="np", **shared)
        return video[0]
    latents, audio_latents = pipe(height=h, width=w, num_frames=n, sigmas=DISTILLED_SIGMA_VALUES, output_type="latent", **shared)
    up = _upsampler(latents=latents, output_type="latent", return_dict=False)[0]
    video, _audio = pipe(num_frames=n, sigmas=STAGE_2_DISTILLED_SIGMA_VALUES, latents=up, audio_latents=audio_latents,
                         noise_scale=STAGE_2_DISTILLED_SIGMA_VALUES[0], output_type="np", **shared)
    return video[0]


def load_pipeline(kind="t2v"):
    global _pipe, _kind
    if _pipe is not None and _kind == kind:
        return _pipe
    if _pipe is not None:
        release()                          # the two pipelines do not fit on a 40 GB card together
    import torch, diffusers
    from diffusers import AutoencoderKLWan
    cls = getattr(diffusers, KINDS[kind])
    src = MODEL_DIR if os.path.isdir(os.path.join(MODEL_DIR, "model_index.json")) else MODEL_ID
    t0 = time.time()
    # The image sets HF_HUB_OFFLINE=1 (for Kokoro) and does not bake this model — on purpose: every gigabyte in the
    # image is pulled again by every rented instance, and the 10 GB come from Hugging Face in about three minutes
    # on the instance itself. So the download must be allowed HERE, at run time, the way kleo_pictures does for the
    # realistic checkpoint; until 13 September production could never have filmed a shot: the worker inherited
    # offline mode, the model "was unavailable", and every video backdrop fell back to the stills.
    prev = _hf_offline(False)
    try:
        vae = AutoencoderKLWan.from_pretrained(src, subfolder="vae", torch_dtype=torch.float32)
        pipe = cls.from_pretrained(src, vae=vae, torch_dtype=torch.bfloat16).to("cuda")
    finally:
        _hf_restore(prev)
    try:
        pipe.vae.enable_tiling()          # the VAE is what runs out of memory first at 720p
    except Exception as e:
        log("vae tiling unavailable:", e)
    try:
        pipe.set_progress_bar_config(disable=True)
    except Exception:
        pass
    log(f"{kind} pipeline ready in {time.time() - t0:.0f} s from {src}")
    _pipe, _kind = pipe, kind
    return pipe


def first_frame(path, w, h):
    """The shot's still, as the frame the clip must start from: resized to the clip's own size (the still is
    1344x768 or 768x1344, the clip 1280x704 or 704x1280 — same aspect, a small resample, no crop)."""
    from PIL import Image, ImageOps
    im = Image.open(path).convert("RGB")
    if im.size != (w, h):
        im = ImageOps.fit(im, (w, h), Image.LANCZOS)   # cover and centre-crop: the aspects differ by a few percent, never squeeze
    return im


def release():
    """Give the card back before the Keou render starts: Chromium workers and Kokoro want it too."""
    global _pipe, _kind, _upsampler
    _pipe, _kind, _upsampler = None, None, None
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def write_clip(frames, path, fps=FPS_SRC):
    """frames (HxWx3 each: numpy float in [0,1], numpy uint8, or PIL) -> an H.264 mp4, written by ffmpeg over a
    raw RGB pipe. No imageio, no OpenCV. diffusers' export_to_video needs one of those two and the worker image
    ships neither: on 13 September all four shots of a film were generated — thirteen minutes of an A100 — and
    then lost at that one line, and the unit test never noticed because it had replaced export_to_video with a
    fake that wrote 64 zero bytes. ffmpeg is the one dependency the engine cannot run without, so it is the one
    the writer may rely on."""
    import numpy as np
    arr = []
    for f in frames:
        a = np.asarray(f)
        if a.dtype != np.uint8:
            a = (np.clip(a.astype(np.float32), 0, 1) * 255).round().astype(np.uint8)
        if a.ndim == 2:
            a = np.stack([a] * 3, -1)
        arr.append(np.ascontiguousarray(a[..., :3]))
    if not arr:
        raise RuntimeError("no frames to write")
    h, w = arr[0].shape[:2]
    w2, h2 = w - w % 2, h - h % 2          # yuv420p wants even sides
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps),
           "-i", "-", "-vf", f"crop={w2}:{h2}:0:0", "-c:v", "libx264", "-preset", "medium", "-crf", "10",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]
    p = subprocess.run(cmd, input=b"".join(a.tobytes() for a in arr), capture_output=True)
    if p.returncode != 0 or not os.path.isfile(path) or os.path.getsize(path) == 0:
        raise RuntimeError("ffmpeg could not write the clip: " + p.stderr.decode(errors="replace")[-300:])
    return path


def generate_clips(shots, look, fmt, out_dir, seconds_of=None):
    """shots: [{"id", "image_prompt", "motion", "strength"}] -> {shot_id: mp4 path} for the ones that were made.
    Never raises for one shot: a clip that fails is simply absent and the caller falls back to the still."""
    if not can_generate():
        log("no CUDA here: no motion is generated")
        return {}
    want = [s for s in (shots or []) if isinstance(s, dict) and s.get("id") and str(s.get("image_prompt") or "").strip()]
    if not want:
        return {}
    os.makedirs(out_dir, exist_ok=True)
    w, h = SIZES.get(fmt, SIZES["16:9"])
    # A shot that brings its still is animated from it; one without is invented from the text. Shots are grouped
    # by that, so the card swaps pipelines at most once instead of once per shot.
    def kind_of(s):
        im = s.get("image")
        return "i2v" if isinstance(im, str) and os.path.isfile(im) else "t2v"
    want.sort(key=lambda s: kind_of(s) != "i2v")
    import torch
    done, t_all = {}, time.time()
    for s in want:
        sid = s["id"]
        prompt = build_prompt(s, look)
        if not prompt:
            continue
        kind = kind_of(s)
        try:
            pipe = load_ltx() if FAMILY == "ltx" else load_pipeline(kind)
        except Exception as e:
            log("model unavailable:", e)
            break
        secs = (seconds_of or {}).get(sid) or s.get("dur") or 3.0
        n = frames_for(secs)
        path = os.path.join(out_dir, f"{sid}.mp4")
        t0 = time.time()
        try:
            base = seed_for(sid)
            still = first_frame(s["image"], w, h) if kind == "i2v" else None
            for attempt in range(RETRIES + 1):
                g = torch.Generator(device="cuda").manual_seed(base + attempt * 7919)
                if FAMILY == "ltx":
                    frames = ltx_clip(pipe, prompt, still, w, h, n, g)
                else:
                    args = dict(prompt=prompt, negative_prompt=NEGATIVE, height=h, width=w, num_frames=n,
                                num_inference_steps=STEPS, guidance_scale=GUIDANCE, generator=g)
                    if still is not None:
                        args["image"] = still
                    frames = pipe(**args).frames[0]
                write_clip(frames, path, fps=FPS_SRC)
                if not (os.path.isfile(path) and os.path.getsize(path) > 0):
                    raise RuntimeError("empty file written")
                moved = travel_px(path)
                if moved is None or moved >= MIN_TRAVEL_PX or attempt == RETRIES:
                    if moved is not None and moved < MIN_TRAVEL_PX:
                        log(f"{sid}: still {moved:.0f} px after {attempt + 1} tries, keeping it")
                    break
                log(f"{sid}: only {moved:.0f} px of travel, that is a still — regenerating with another seed")
            done[sid] = path
            log(f"{sid}: {n} frames ({n / FPS_SRC:.1f} s) in {time.time() - t0:.0f} s, "
                f"{'animated from its still' if still is not None else 'invented from the text'}")
        except Exception as e:
            log(f"{sid}: generation failed: {type(e).__name__}: {str(e)[:200]}")
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except Exception:
                pass
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
    log(f"{len(done)}/{len(want)} clips ({look}, {fmt}) in {time.time() - t_all:.0f} s")
    release()
    return done


# ---- did it actually move? ------------------------------------------------------------------------------------------
# The measured failure of this model is not a bad clip, it is a STILL one: 5 of 21 probe clips came back frozen
# (travel 4-15 px against 30-106 for a healthy one). Two things are now known about it and both are in this code:
#   · it is stochastic. The same description of a compass on a table gave 0.27 px with one seed and 1.63 with another,
#     and no prompt wording fixed it reliably: adding life helped one case, made another worse; raising guidance did
#     nothing. So the gate cannot live in the text alone — it has to look at the result.
#   · it is cheap to detect. Eight frame pairs of optical flow on a 720p clip take under a second, against the ~125 s
#     the clip cost to make, so measuring every clip and regenerating the dead ones is nearly free.
# Calibrated against 21 probe clips whose motion was also judged by eye and by a full-resolution optical-flow
# pass: everything a viewer calls frozen lands at 1.8-13.6 here, the weakest clip anyone called alive at 17.5.
MIN_TRAVEL_PX = float(os.environ.get("KLEO_VIDEO_MIN_TRAVEL", "18"))
RETRIES = int(os.environ.get("KLEO_VIDEO_RETRIES", "2"))


def travel_px(path, samples=8):
    """How far the frame travelled from the first to the last shot, in pixels: the median per-pair optical flow
    times the number of pairs. Per-pair flow alone lies — the same camera move spread over more frames reads as
    less motion — so a longer clip would look stiller than it is. Returns None when it cannot be measured."""
    try:
        import cv2, numpy as np
    except Exception:
        if not getattr(travel_px, "warned", False):
            travel_px.warned = True
            log("travel gate OFF: OpenCV is not installed here, so a frozen clip will pass as filmed "
                "(pip install opencv-python-headless; it is in requirements-pictures.txt from 13 September)")
        return None
    try:
        cap = cv2.VideoCapture(path)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        if total < 3:
            cap.release(); return None
        idx = {int(round(i)) for i in (np.linspace(0, total - 1, min(samples, total)))}
        got, i = [], 0
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            if i in idx:
                # The ruler was calibrated on 1280x704 clips shrunk to 320x176: long side to 320. A portrait clip
                # (704x1280) squeezed into the same 320x176 box read its vertical travel at ~0.55x and its horizontal
                # at ~1.8x, so every push/crane/crash move in a 9:16 film tripped the still gate for nothing (13 Sep:
                # 5 of 13 shots retried, 4 kept as "stills"). Same box, turned with the frame.
                h_, w_ = fr.shape[:2]
                small = (320, 176) if w_ >= h_ else (176, 320)
                got.append(cv2.cvtColor(cv2.resize(fr, small), cv2.COLOR_BGR2GRAY))
            i += 1
        cap.release()
        if len(got) < 2:
            return None
        mags = []
        for a, b in zip(got[:-1], got[1:]):
            fl = cv2.calcOpticalFlowFarneback(a, b, None, .5, 3, 15, 3, 5, 1.2, 0)
            mags.append(float(np.sqrt(fl[..., 0] ** 2 + fl[..., 1] ** 2).mean()))
        # The frames sampled are far apart in time, so each pair already carries the travel of the whole gap
        # between them: the total is the median gap times the number of gaps, not times the frame count.
        # Measured on a 320-wide frame, reported in the pixels of the real one.
        gaps = len(got) - 1
        return float(sorted(mags)[len(mags) // 2]) * gaps * (1280.0 / 320.0)   # long side: 1280 real px over 320 measured
    except Exception as e:
        log("could not measure:", e)
        return None


# ---- post: what turns a 24 fps 720p clip into something that belongs in a 4K film ----------------------------------

GRADE = ("curves=r='0/0.02 0.25/0.22 0.75/0.80 1/0.98':g='0/0.02 0.25/0.22 0.75/0.80 1/0.98':"
         "b='0/0.035 0.25/0.235 0.75/0.79 1/0.97',eq=saturation=0.92:contrast=1.06,noise=alls=6:allf=t+u")


def seconds_of(path):
    """Length of a file in seconds, or 0 when ffprobe cannot say. Never raises."""
    try:
        return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                                    capture_output=True, text=True).stdout.strip() or 0)
    except Exception:
        return 0.0


def finish_clip(src, dst, width, height, fps=60, grade=True, trim=0.12):
    """Upscale, interpolate and grade one clip. Lanczos, not a neural upscaler: per-frame networks shimmer on
    generated footage, and the grain pass hides more than they would have added. Returns dst or None."""
    try:
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
                                   capture_output=True, text=True).stdout.strip() or 0)
    except Exception:
        dur = 0
    keep = max(0.4, dur - 2 * trim) if dur else 0
    # INTERPOLATE FIRST, UPSCALE AFTER. Motion estimation is per pixel: at 3840x2160 it reads nine times the pixels
    # it reads at the 1280x704 the model produced, for a result nobody can tell apart — the frames it invents are
    # decided by where things move, not by how many pixels describe them. The other order was measured at about
    # seven minutes of a paid card per clip; this one is about eleven times faster and the only thing that changes
    # is the bill.
    vf = (f"minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,"
          f"scale={width}:{height}:flags=lanczos")
    if grade:
        vf += "," + GRADE
    cmd = ["ffmpeg", "-v", "error", "-y"]
    if keep:
        cmd += ["-ss", str(trim), "-t", str(keep)]
    cmd += ["-i", src, "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", dst]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0 or not os.path.isfile(dst):
        log(f"finish failed for {os.path.basename(src)}: {p.stderr[-300:]}")
        return None
    return dst


MAX_STRETCH = float(os.environ.get("KLEO_VIDEO_MAX_STRETCH", "1.6"))   # slow motion up to this before a frame is held
FROZEN_S = float(os.environ.get("KLEO_VIDEO_FROZEN_S", "0.6"))          # a run this long is repaired; QA rejects at 1.0


def frozen_runs(path, sample_fps=6):
    """Where the picture stops changing, measured with the DELIVERY QA's own ruler (qa.py: 6 fps, 270 px wide,
    frame md5): every run of identical sampled frames as (start_s, seconds). The master is rejected at one second
    of them, after thirty minutes of GPU; measuring each part with the same ruler before it is cut in is what
    makes that rejection unreachable from here. The 13 September film died exactly there: a push-in the model was
    told to 'decelerate into a static hold', a held tail on top, and the grain averaged away at 270 px."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-an", "-vf", f"fps={sample_fps},scale=270:-2",
                        "-f", "framemd5", "-"], capture_output=True, text=True)
    vals = [l.split(",")[-1].strip() for l in r.stdout.splitlines() if l and not l.startswith("#")]
    runs, k = [], 0
    while k < len(vals):
        j = k
        while j + 1 < len(vals) and vals[j + 1] == vals[k]:
            j += 1
        if j > k:
            runs.append((k / sample_fps, (j - k) / sample_fps))
        k = j + 1
    return runs


def finish_vf(width, height, fps, want, stretch=1.0):
    """The one filter chain that turns a 24 fps clip into `want` seconds of delivery-size footage: slow it by
    `stretch` (before the motion compensation, so slow motion stays smooth), interpolate to `fps`, scale, hold on
    the last frame only for whatever is still missing, grade."""
    slow = f"setpts={stretch:.4f}*PTS," if stretch > 1.0005 else ""
    return (f"{slow}minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,"
            f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={width}:{height},tpad=stop_mode=clone:stop_duration={want:.3f},{GRADE}")


def plan_fill(want, have, frozen_tail=0.0):
    """How to make `want` seconds from a clip of `have` whose last `frozen_tail` seconds do not move:
    (stretch, usable_seconds, held_seconds). The frozen tail is dropped, the rest is slowed up to MAX_STRETCH,
    and only what is still missing is a held frame — said out loud by the caller."""
    usable = max(0.5, have - max(0.0, frozen_tail))
    stretch = min(MAX_STRETCH, max(1.0, want / usable))
    held = max(0.0, want - usable * stretch)
    return stretch, usable, held


def build_footage(shots_json, clips, out_path, width, height, fps=60, log_fn=None):
    """One continuous video track for the whole film, exactly as long as the timeline, from the clips generated per
    shot. Built from build/shots.json — the cut times the ENGINE itself computed — so the footage and the graphics
    can never disagree about where a shot begins.

    A shot with no clip becomes black for its own length: a hole in the picture, never a hole in the timing, because
    a track that is even a frame short desynchronises everything after it. Returns out_path, or None.
    """
    say = log_fn or log
    try:
        plan = json.load(open(shots_json))
    except Exception as e:
        say("no shot plan:", e)
        return None
    parts, total = [], 0.0
    work = os.path.join(os.path.dirname(out_path), "footage-parts")
    os.makedirs(work, exist_ok=True)
    n = 0
    for scene in plan.get("scenes") or []:
        for sh in scene.get("shots") or []:
            want = max(0.04, float(sh.get("end", 0)) - float(sh.get("start", 0)))
            src = clips.get(f"{scene['id']}-s{int(sh.get('index', 0)) + 1}") or sh.get("clip")
            dst = os.path.join(work, f"{n:03d}.mp4")
            n += 1
            if src and os.path.isfile(src):
                # ONE encode per shot does the entire finish (finish_vf). 24 fps becomes 60 with real motion
                # compensation at the size the model produced, then Lanczos to the delivery size, then the film's
                # own grade — `fps=` on its own would merely duplicate frames, the judder that makes generated
                # footage look cheap. The curve is fixed, so grading each shot with it is the same film-wide grade
                # as grading the finished track once.
                #
                # A shot longer than its clip (a take is capped at MAX_S) is NOT filled by holding the last frame:
                # the clip is slowed, up to MAX_STRETCH, and only the remainder is held. And the clip's own frozen
                # tail — a model told to decelerate obeys — is dropped first, measured with the delivery QA's ruler.
                label = f"{scene['id']} shot {int(sh.get('index', 0)) + 1}"
                have = seconds_of(src) or want
                tail = 0.0
                for start, secs in frozen_runs(src):
                    if secs >= FROZEN_S and start + secs >= have - 0.25:
                        tail = have - start
                stretch, usable, held = plan_fill(want, have, tail)
                if tail:
                    say(f"{label}: the clip's last {tail:.1f} s do not move — dropped before the cut")
                if stretch > 1.0005:
                    say(f"{label}: {want:.1f} s of film from {usable:.1f} s of clip — slowed x{stretch:.2f}")
                if held > 0.15:
                    say(f"{label}: even slowed, the last {held:.1f} s is a held frame (the shot is too long for one take)")
                vf = finish_vf(width, height, fps, want, stretch)
                cmd = ["ffmpeg", "-v", "error", "-y", "-t", f"{usable:.3f}", "-i", src, "-vf", vf, "-t", f"{want:.3f}",
                       "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", dst]
            else:
                say(f"{scene['id']} shot {sh.get('index')}: no clip, that stretch stays black")
                cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                       f"color=c=black:s={width}x{height}:r={fps}:d={want:.3f}",
                       "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", dst]
            if subprocess.run(cmd, capture_output=True, text=True).returncode != 0 or not os.path.isfile(dst):
                say(f"could not prepare {os.path.basename(dst)}")
                return None
            # The same ruler the master will be judged by, on the finished part: what freezes here freezes there.
            worst = max((secs for _, secs in frozen_runs(dst)), default=0.0)
            if worst >= FROZEN_S:
                say(f"{os.path.basename(dst)}: STILL has {worst:.1f} s without motion after the finish — the master may be rejected")
            parts.append(dst)
            total += want
    if not parts:
        return None
    listing = os.path.join(work, "list.txt")
    with open(listing, "w") as f:
        for p in parts:
            f.write("file '%s'\n" % p.replace("'", "'\\''"))
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing,
                        "-c", "copy", out_path], capture_output=True, text=True)
    if r.returncode != 0 or not os.path.isfile(out_path):
        say("could not join the footage:", r.stderr[-300:])
        return None
    say(f"footage: {len(parts)} shots, {total:.1f} s, {os.path.getsize(out_path) / 1e6:.0f} MB")
    return out_path


if __name__ == "__main__":   # manual check on a GPU box
    shots = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else [
        {"id": "probe-1", "image_prompt": "a fisherman mending a net on a harbour wall at dawn", "motion": "push_in"}]
    made = generate_clips(shots, os.environ.get("LOOK", "realistic"), os.environ.get("FMT", "16:9"), "/workspace/clips")
    print(json.dumps(made, indent=1))
