#!/usr/bin/env python3
"""
Generated MOTION for Kleo's picture styles: a shot stops being a photograph with a zoom on it and becomes a clip
that was actually filmed by a camera that moved.

Run on the rented GPU by kleo_worker.py, next to kleo_pictures.py. The division is deliberate:

    kleo_pictures.py   one still per shot          (what the frame contains)
    kleo_video.py      that still, set in motion    (what the frame does)

Model: LTX-2.5 (Lightricks, 22B, LTX-2.x community licence: commercial use free under $10M revenue, gated weights
behind the owner's Hugging Face acceptance). Chosen on 13 September 2026 in place of Wan 2.2 5B, whose 704p films
the owner measured against Higgsfield and rejected. Two stages per clip: 960x544 and, through the latent
upsampler, 1920x1088; distilled eight-step schedule; the shot's own still as the first frame.

The one measured failure mode of generated motion — a clip that comes back FROZEN — is guarded twice: `alive()`
gives a shot with nothing moving in it something that moves (measured on the previous model: three of nine probe
clips froze, all with nothing alive in the scene), and travel_px() measures every clip and regenerates a still one.

Nothing here runs on the owner's computer, ever. torch and diffusers are imported inside the functions so the
module can be imported (and unit-tested with fakes) on a machine that has neither.
"""
import gc, hashlib, json, math, os, re, subprocess, sys, threading, time

# The generator: LTX-2.5 (Lightricks, 22B), the owner's choice of 13 September, and the only one. Stage one at
# 960x544 (544x960 portrait), x2 latent upsample and a stage-two pass to 1920x1088, distilled eight-step schedule,
# image conditioning with the same checkpoint. Gated weights (HF_TOKEN), 72 GB on disk, an 80 GB card in bf16 or
# a 48 GB one with KLEO_VIDEO_OFFLOAD=1. Wan 2.2 5B, which shipped first at 704p, was removed the same day: the
# owner judged its films against Higgsfield and there was no bridging that with a 5B model.
MODEL_ID = os.environ.get("KLEO_VIDEO_MODEL", "Lightricks/LTX-2.5-Diffusers")
MODEL_DIR = os.environ.get("KLEO_VIDEO_MODEL_DIR", "/workspace/models/ltx-2.5")
FPS_SRC = 24                                  # what the model generates at
SIZES = {"16:9": (960, 544), "9:16": (544, 960)}
LTX_UPSAMPLE = os.environ.get("KLEO_VIDEO_LTX_UPSAMPLE", "1").strip() != "0"    # stage two: x2 latent upsample
LTX_OFFLOAD = os.environ.get("KLEO_VIDEO_OFFLOAD", "0").strip() == "1"        # cpu offload for a 48 GB card
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
    "realistic": "cinematic live-action photography, 35mm anamorphic, subject in sharp focus, fine real surface texture, natural light, film grain",
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
    """LTX wants 8n+1 frames. Clamped to what stays coherent: past ~5 s a generated clip drifts."""
    s = min(MAX_S, max(MIN_S, float(seconds or 3.0)))
    n = int(round(s * FPS_SRC))
    return max(17, (n // 8) * 8 + 1)


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
    # A shot that brings its still is animated from it; one without is invented from the text. Same checkpoint,
    # same pipeline: LTX conditions on an image through the `image` argument.
    def has_still(s):
        im = s.get("image")
        return isinstance(im, str) and os.path.isfile(im)
    import torch
    done, t_all = {}, time.time()
    for s in want:
        sid = s["id"]
        prompt = build_prompt(s, look)
        if not prompt:
            continue
        try:
            pipe = load_ltx()
        except Exception as e:
            log("model unavailable:", e)
            break
        secs = (seconds_of or {}).get(sid) or s.get("dur") or 3.0
        n = frames_for(secs)
        path = os.path.join(out_dir, f"{sid}.mp4")
        t0 = time.time()
        try:
            base = seed_for(sid)
            still = first_frame(s["image"], w, h) if has_still(s) else None
            for attempt in range(RETRIES + 1):
                g = torch.Generator(device="cuda").manual_seed(base + attempt * 7919)
                frames = ltx_clip(pipe, prompt, still, w, h, n, g)
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
        return float(sorted(mags)[len(mags) // 2]) * gaps * (max(w_, h_) / 320.0)   # long side, real px over 320 measured
    except Exception as e:
        log("could not measure:", e)
        return None


# ---- post: what turns a 24 fps 720p clip into something that belongs in a 4K film ----------------------------------

SHARPEN = float(os.environ.get("KLEO_SHARPEN", "0.45"))   # luma unsharp amount on the 4K track; 0 = off
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
    """Upscale, interpolate and grade one clip (Lanczos + minterpolate; nothing calls it any more). The neural finish
    lives in build_footage now (kleo_sr: SR on the clip's true frames, then RIFE): the old objection here, per-frame
    networks shimmering, was measured on 1280x704 Wan clips upscaled frame by frame at 60 fps, which kleo_sr does not
    do — each source frame is upscaled once and the in-betweens are warps of it. Returns dst or None."""
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
# Past MAX_STRETCH, slower still rather than a held frame the QA rejects: up to this, only as far as it takes.
RESCUE_STRETCH = float(os.environ.get("KLEO_VIDEO_RESCUE_STRETCH", "2.0"))


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
    # A mild unsharp mask on the luma after the 2K -> 4K lanczos upscale (14 September, the owner's direction:
    # sharp, concrete): it restores the edge contrast the upscale softens, without ringing (0.45 is well under the
    # halo threshold), and never touches chroma.
    return (f"{slow}minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,"
            f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={width}:{height},unsharp=5:5:{SHARPEN:.2f}:5:5:0.0,tpad=stop_mode=clone:stop_duration={want:.3f},{GRADE}")


# ---- the neural finish (25 September 2026, worker/kleo_sr.py) ----------------------------------------------------------
# On a finish box with a usable GPU the two costly lies of finish_vf are replaced: Lanczos x4.5 from a 480p clip by a
# learned upscale of the clip's true frames, and minterpolate's block matching by RIFE. Everything else — the cut, the
# slow-down, the held frame, the dissolves, the grade, the concat — is decided exactly as before, and any doubt (no
# card, no weights, a projection over the budget, an error on a part) falls back to finish_vf for that part or film.
SHARPEN_SR = float(os.environ.get("KLEO_SHARPEN_SR", "0.2"))      # after SR there is real edge detail; the A/B decides
SR_BUDGET_MIN = float(os.environ.get("KLEO_SR_BUDGET_MIN", "20"))  # projected GPU minutes a film may spend on SR + RIFE
# The projection comes from twelve frames of the first clip; it cannot see a card that throttles after a few minutes
# or the CPU the other parts' encodes take. So the GPU time the parts really use is added up, and once it passes
# max(1.5 x projection, projection + SR_GRACE_MIN) — or SR_DEADLINE_MIN of wall clock since the decision — the parts
# not started yet take today's chain, and a part still on the card is cut off at that limit (its child is killed).
SR_GRACE_MIN = float(os.environ.get("KLEO_SR_GRACE_MIN", "5"))
SR_DEADLINE_MIN = float(os.environ.get("KLEO_SR_DEADLINE_MIN", "40"))
_clock = time.monotonic                                             # a module attribute so the tests can drive time
# What the neural finish did on the last build_footage, for the server (25 September 2026: the AI upscale is an option
# the user pays for, and its credits go back unless every part with a clip went through the GPU). kleo_worker sends it
# with /done: {"parts": parts with a clip, "applied": parts upscaled, "model", "gpu", "reason": why not, or None}.
LAST_SR = None


def finish_vf_sr(width, height, want):
    """The tail after the GPU pass: the frames are already `fps` and near delivery size, so only the last Lanczos step,
    a lighter unsharp, the hold for whatever is still missing, and the same grade (whose temporal grain also hides
    any residual flicker from the upscaler)."""
    return (f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,crop={width}:{height},"
            f"unsharp=5:5:{SHARPEN_SR:.2f}:5:5:0.0,tpad=stop_mode=clone:stop_duration={want:.3f},{GRADE}")


def _sr_module():
    """kleo_sr, next to this file; None when this image does not carry it."""
    try:
        import kleo_sr
        return kleo_sr
    except ImportError:
        pass
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kleo_sr.py")
    if not os.path.isfile(path):
        return None
    import importlib.util
    spec = importlib.util.spec_from_file_location("kleo_sr", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    sys.modules["kleo_sr"] = mod
    return mod


def _look_of(shots_json):
    """The film's look: the shot plan's own field if it has one, else project.json next to build/, else realistic."""
    for path in (shots_json, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(shots_json))), "project.json")):
        try:
            look = json.load(open(path)).get("look")
            if look:
                return str(look)
        except Exception:
            pass
    return "realistic"


def _size_of(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    w, h = (int(x) for x in r.stdout.strip().split(",")[:2])
    return w, h


def _part_problem(path, width, height, fps, want):
    """Why a finished part cannot go into the track (wrong size, rate or length), or None."""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,r_frame_rate:format=duration", "-of", "json", path], capture_output=True, text=True)
    try:
        j = json.loads(r.stdout)
        st, dur = j["streams"][0], float(j["format"]["duration"])
        num, _, den = st["r_frame_rate"].partition("/")
        rate = float(num) / float(den or 1)
    except Exception:
        return "unreadable part"
    if (int(st["width"]), int(st["height"])) != (width, height):
        return f"size {st['width']}x{st['height']}, not {width}x{height}"
    if abs(rate - fps) > 0.05:
        return f"{rate:.2f} fps, not {fps}"
    if abs(dur - want) > 1.5 / fps + 0.02:
        return f"{dur:.3f} s, not {want:.3f}"
    return None


def _sr_decision(srm, card, recipes, shots_json, width, height, fps, say, note=None):
    """Once per film: (factor, look, projected minutes) when the whole track can go through the GPU within the
    budget, else None. The card is asked through its child process (kleo_sr.Card), the benchmark with a time limit of
    its own. The look never changes in the middle of a film because of this: only an error on one part does, and
    says so. `note` (a dict), when given, receives the model and card, or the reason it is off (LAST_SR)."""
    note = note if note is not None else {}
    try:
        if srm is None:
            note["reason"] = "kleo_sr is not in this image"
            say("SR off: kleo_sr is not in this image — Lanczos + minterpolate as before")
            return None
        ok, why, gpu = card.available()
        if ok:
            look = _look_of(shots_json)
            first = next(iter(recipes.values()))[0]
            factor = srm.plan(*_size_of(first), width, height)
            with card.lock:
                bench = card.benchmark(first, factor, look)
            est = srm.estimate_minutes(bench, list(recipes.values()), fps)
            if est <= SR_BUDGET_MIN:
                model = srm.model_for(look, factor) or "no upscaler"
                note.update(model=model, gpu=gpu)
                say(f"SR on: {gpu or 'unknown GPU'}, {model} x{factor} + RIFE 4.25, est {est:.1f} min")
                return factor, look, est
            why = f"estimated {est:.0f} min over the {SR_BUDGET_MIN:g} min budget"
        note["reason"] = str(why)
        say(f"SR off: {why} — Lanczos + minterpolate as before")
    except Exception as e:
        note["reason"] = str(e)[:200]
        say(f"SR off: {e} — Lanczos + minterpolate as before")
    return None


def plan_fill(want, have, frozen_tail=0.0):
    """How to make `want` seconds from a clip of `have` whose last `frozen_tail` seconds do not move:
    (stretch, usable_seconds, held_seconds). The frozen tail is dropped, the rest is slowed up to MAX_STRETCH,
    and only what is still missing is a held frame — said out loud by the caller.

    A HELD FRAME THE QA WOULD REJECT IS WORSE THAN SLOWER MOTION (25 September 2026). On the API road a clip is
    bought at exactly its shot's length (kleo_worker.fit_to_clips): there is no spare second any more to absorb a
    frozen tail, and a held remainder of a second or more fails the whole film at film_checks, after every clip has
    been paid for. So when MAX_STRETCH would leave more than FROZEN_S held, the clip is slowed further, up to
    RESCUE_STRETCH, just enough to bring the held frame back to FROZEN_S."""
    usable = max(0.5, have - max(0.0, frozen_tail))
    stretch = min(MAX_STRETCH, max(1.0, want / usable))
    if want - usable * stretch > FROZEN_S:
        stretch = max(stretch, min(RESCUE_STRETCH, (want - FROZEN_S) / usable))
    held = max(0.0, want - usable * stretch)
    return stretch, usable, held


def xfade_parts(a, b, out, offset, seconds, fps=60):
    """A cross-dissolve of `seconds` between two finished parts: `a` runs `seconds` longer than its slot, `b` starts
    under it at `offset` (a's nominal length), and the result is exactly a_nominal + b long. Same size, same frame
    rate, same encode as every other part, so the concat that follows copies it without a second thought."""
    fc = f"[0:v][1:v]xfade=transition=fade:duration={seconds:.3f}:offset={offset:.3f},format=yuv420p[v]"
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a, "-i", b, "-filter_complex", fc, "-map", "[v]", "-r", str(fps),
                        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", out],
                       capture_output=True, text=True)
    return r.returncode == 0 and os.path.isfile(out) and os.path.getsize(out) > 0


def build_footage(shots_json, clips, out_path, width, height, fps=60, log_fn=None, progress_fn=None, workers=None):
    """One continuous video track for the whole film, exactly as long as the timeline, from the clips generated per
    shot. Built from build/shots.json — the cut times the ENGINE itself computed — so the footage and the graphics
    can never disagree about where a shot begins.

    A shot with no clip becomes black for its own length: a hole in the picture, never a hole in the timing, because
    a track that is even a frame short desynchronises everything after it. Returns out_path, or None.

    THE PARTS ARE FINISHED IN PARALLEL AND EACH ONE IS REPORTED. minterpolate is the cost of this stage and it is
    mostly one thread per file: seven 2K clips one after the other took the finish box past the twenty minutes of
    silence the server tolerates (13 September, gt_d2td9fb9: killed at 62% twice, the clips already paid for). Now
    `workers` files run at once (default: a quarter of the cores, at least 2) and progress_fn(done, total) is called
    as each part lands, which is what the worker turns into a progress report — the silence sensor stays at its
    number, the stage stops looking dead."""
    global LAST_SR
    LAST_SR = None
    say = log_fn or log
    try:
        plan = json.load(open(shots_json))
    except Exception as e:
        say("no shot plan:", e)
        return None
    work = os.path.join(os.path.dirname(out_path), "footage-parts")
    os.makedirs(work, exist_ok=True)
    # THE DISSOLVE BETWEEN TWO ACTS (22 September 2026, src/transitions.ts). The plan marks the scene that dissolves
    # IN; the LAST shot of the scene before it is cut `dissolve_s` longer than its slot, and after the encodes the two
    # parts are cross-faded with xfade over exactly that overlap — so the track keeps the timeline's length to the
    # frame and the film breathes where the animatic does (picture.js draws the same dissolve from the same plan).
    dissolve_s = float(plan.get("dissolve_s") or 0.8)
    scenes_in = plan.get("scenes") or []
    dissolves_out = {k for k in range(len(scenes_in) - 1) if (scenes_in[k + 1] or {}).get("transition") == "dissolve"}
    # Pass one, serial and cheap: decide every part (what to cut, how much to slow, what stays black).
    # `recipes` keeps what the GPU pass needs per part, beside `jobs` (whose 4-tuple pass three unpacks).
    jobs, total, n, recipes = [], 0.0, 0, {}
    for si, scene in enumerate(scenes_in):
        shots_in = scene.get("shots") or []
        for sj, sh in enumerate(shots_in):
            want = max(0.04, float(sh.get("end", 0)) - float(sh.get("start", 0)))
            extended = si in dissolves_out and sj == len(shots_in) - 1
            if extended:
                want += dissolve_s
            src = clips.get(f"{scene['id']}-s{int(sh.get('index', 0)) + 1}") or sh.get("clip")
            dst = os.path.join(work, f"{n:03d}.mp4")
            n += 1
            if src and os.path.isfile(src):
                # ONE encode per shot does the entire finish (finish_vf). 24 fps becomes 60 with real motion
                # compensation at the size the model produced, then Lanczos to the delivery size, then the film's
                # own grade — `fps=` on its own would merely duplicate frames, the judder that makes generated
                # footage look cheap. The curve is fixed, so grading each shot with it is the same film-wide grade
                # as grading the finished track once. On a finish box with a usable GPU the part goes through kleo_sr
                # instead (run_sr below: SR + RIFE, then finish_vf_sr), and this very command is its fallback.
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
                recipes[dst] = (src, usable, stretch, want, label)
            else:
                say(f"{scene['id']} shot {sh.get('index')}: no clip, that stretch stays black")
                cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                       f"color=c=black:s={width}x{height}:r={fps}:d={want:.3f}",
                       "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", dst]
            jobs.append((dst, cmd, want - (dissolve_s if extended else 0.0), extended))
            total += want - (dissolve_s if extended else 0.0)
    if not jobs:
        return None
    # Between the passes, once for the whole film: may the GPU finish these parts (kleo_sr)?
    srm = _sr_module() if recipes else None
    card = srm.Card() if srm is not None else None
    note = {} if recipes else {"reason": "no shot had a clip to upscale"}
    sr = _sr_decision(srm, card, recipes, shots_json, width, height, fps, say, note) if recipes else None
    breaker, breaker_lock = [False], threading.Lock()
    upscaled = []                                                   # the parts the GPU finished (LAST_SR)
    # What the GPU may still spend: the projection with headroom, and a wall clock from this moment (see SR_GRACE_MIN).
    gpu_used = [0.0]
    allowance_s = max(1.5 * sr[2], sr[2] + SR_GRACE_MIN) * 60.0 if sr else 0.0
    deadline = _clock() + SR_DEADLINE_MIN * 60.0

    def trip(why):
        with breaker_lock:
            if not breaker[0]:
                breaker[0] = True
                note.setdefault("reason", why)
                say(f"SR off for the parts not started yet: {why}")

    def run_sr(dst, rec):
        """The part through the GPU, then the tail encode; False (and said) when today's chain must do it instead."""
        src, usable, stretch, want, label = rec
        mid = dst[:-4] + "-sr.mp4"
        tile = None
        for attempt in (1, 2):
            try:
                with card.lock:
                    # Checked on the card, not before the wait for it: the part ahead may have used what was left.
                    if breaker[0]:
                        return False
                    left = min(allowance_s - gpu_used[0], deadline - _clock())
                    if left <= 0:
                        trip(f"the GPU has used {gpu_used[0] / 60:.1f} min against a projection of {sr[2]:.1f} min")
                        return False
                    t0 = _clock()
                    try:
                        stats = card.enhance(src, mid, usable, stretch, want, fps, sr[0], sr[1], tile=tile, timeout=left)
                    finally:
                        gpu_used[0] += _clock() - t0
                # The encode runs outside the lock: the CPU finishes this part while the card starts the next one.
                r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mid, "-vf", finish_vf_sr(width, height, want),
                                    "-t", f"{want:.3f}", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
                                    "-pix_fmt", "yuv420p", dst], capture_output=True, text=True)
                if r.returncode != 0 or not os.path.isfile(dst):
                    raise RuntimeError(f"the tail encode failed: {r.stderr[-200:]}")
                bad = _part_problem(dst, width, height, fps, want)
                if bad:
                    raise RuntimeError(bad)
                s = stats if isinstance(stats, dict) else {}
                say(f"{label}: SR x{sr[0]} + RIFE, {s.get('frames_in')} -> {s.get('frames_out')} frames"
                    f" (SR {s.get('sr_fps')} fps, RIFE {s.get('rife_fps')} fps, {s.get('vram_peak_gb')} GB)")
                return True
            except Exception as e:
                oom = srm.is_oom(e)
                if oom and attempt == 1:
                    tile = 256                            # the upscaler goes in tiles, on an emptied card
                    with card.lock:
                        card.kill()                       # a fresh child: nothing of the failed attempt stays on the card
                    continue
                note.setdefault("reason", f"{label}: {str(e)[:160]}")
                say(f"{label}: SR failed ({str(e)[:200]}), Lanczos path")
                if isinstance(e, srm.Overrun):
                    trip(f"a part overran the GPU's time ({gpu_used[0] / 60:.1f} min used, projection {sr[2]:.1f} min)")
                elif not oom:
                    trip("one failure is enough to stop trusting it for this film")
                return False
            finally:
                try:
                    os.remove(mid)
                except OSError:
                    pass
        return False

    # Pass two, parallel: the encodes. Order is kept by index; a failure anywhere fails the track.
    from concurrent.futures import ThreadPoolExecutor
    n_workers = max(1, int(workers)) if workers else max(2, (os.cpu_count() or 4) // 4)
    n_workers = min(n_workers, len(jobs))
    say(f"finishing {len(jobs)} parts, {n_workers} at a time, {width}x{height} {fps} fps")
    done, failed = 0, []

    def run(item):
        dst, cmd = item[0], item[1]
        rec = recipes.get(dst)
        if sr and rec and not breaker[0] and run_sr(dst, rec):
            upscaled.append(dst)
            return dst, True
        r = subprocess.run(cmd, capture_output=True, text=True)
        return dst, (r.returncode == 0 and os.path.isfile(dst))

    try:
        with ThreadPoolExecutor(max_workers=n_workers) as pool:
            for dst, ok in pool.map(run, jobs):
                done += 1
                if not ok:
                    failed.append(dst)
                    say(f"could not prepare {os.path.basename(dst)}")
                if progress_fn:
                    try:
                        progress_fn(done, len(jobs))
                    except Exception:
                        pass
    finally:
        if card is not None:
            try:
                card.close()
            except Exception:
                pass
    LAST_SR = {"parts": len(recipes), "applied": len(upscaled), "model": note.get("model"), "gpu": note.get("gpu"),
               "reason": None if recipes and len(upscaled) == len(recipes) else
               note.get("reason") or f"{len(upscaled)} of {len(recipes)} parts went through the GPU"}
    if failed:
        return None
    # Pass three: the dissolves. A part that was cut long dissolves into the part after it; the two become one file
    # of their nominal length, and that file may dissolve on into the next (a chain re-encodes what it has folded).
    parts, cur, cur_len, cur_ext = [], None, 0.0, False
    for k, (dst, _, nominal, extended) in enumerate(jobs):
        if cur is None:
            cur, cur_len, cur_ext = dst, nominal, extended
            continue
        if cur_ext:
            merged = os.path.join(work, f"x{k:03d}.mp4")
            if not xfade_parts(cur, dst, merged, cur_len, dissolve_s, fps):
                say(f"could not dissolve into {os.path.basename(dst)}; a hard cut instead")
                # The long tail must not stay: the part is cut back to its slot before it is joined.
                trimmed = os.path.join(work, f"t{k:03d}.mp4")
                r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", cur, "-t", f"{cur_len:.3f}", "-c:v", "libx264",
                                    "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", trimmed], capture_output=True, text=True)
                parts.append(trimmed if r.returncode == 0 and os.path.isfile(trimmed) else cur)
                cur, cur_len, cur_ext = dst, nominal, extended
            else:
                cur, cur_len, cur_ext = merged, cur_len + nominal, extended
        else:
            parts.append(cur)
            cur, cur_len, cur_ext = dst, nominal, extended
    parts.append(cur)
    if dissolves_out:
        say(f"{len(dissolves_out)} dissolve(s) between acts, {dissolve_s:.1f} s each")
    for dst in parts:
        # The same ruler the master will be judged by, on the finished part: what freezes here freezes there.
        worst = max((secs for _, secs in frozen_runs(dst)), default=0.0)
        if worst >= FROZEN_S:
            say(f"{os.path.basename(dst)}: STILL has {worst:.1f} s without motion after the finish — the master may be rejected")
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
