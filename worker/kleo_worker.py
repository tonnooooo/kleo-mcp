#!/usr/bin/env python3
"""
Kleo GPU worker — runs INSIDE the ephemeral Vast.ai instance, one job per instance.

It talks only to the Kleo API (KLEO_API) with the per-job secret (KLEO_SECRET):
  1. fetch the job spec              GET  /internal/jobs/{id}   (template, prompt, params, storyboard, brand)
  2. report progress                 POST /internal/jobs/{id}/progress
  3. render (see render() below)     Keou engine: Playwright canvas frames → ffmpeg, Kokoro TTS, whisper captions
  4. upload the outputs              PUT  /internal/jobs/{id}/files/{name}  (multipart for big files)
  5. mark done / failed              POST /internal/jobs/{id}/done | /failed
  6. destroy this very instance      DELETE https://console.vast.ai/api/v0/instances/$CONTAINER_ID/  (CONTAINER_API_KEY)
A watchdog timer (KLEO_SELF_DESTRUCT_MIN) destroys the instance even if the render hangs.

Engines (KLEO_ENGINE):
  keou (default)  the real motion-design renderer shipped in KLEO_KEOU_DIR (default /opt/kleo/keou);
                  the job must carry a "storyboard" (a Keou project without id/script_file/music_quiet/image scenes).
  placeholder     ffmpeg-only dark frame with the prompt as text; no storyboard needed (container contract tests).
Kleo pictures (keou engine only): a storyboard may carry "kleo_style" (cartoon | realistic | animation | cyber | stickman); for
cartoon/realistic (style "picture", see docs/PICTURE-STYLE.md) every scene carries "shots", each shot one full-screen
picture described by an "image_prompt". Picture id = "<sceneId>-s<n>" (1-based shot index). The worker asks
POST /internal/jobs/{id}/images for the pictures the server generated, downloads them into
<project>/img/<pictureId>.<ext> and sets shot.image (plus scene.image = the scene's first picture, kept for
compatibility); the pictures the server could not make are then drawn on the instance's own GPU by kleo_pictures.py
(Stable Diffusion 1.5, diffusers, weights baked into the image) when one is present. KLEO_PICTURES=auto (default:
server first, GPU for the rest) | server (never generate locally) | local (never ask the server). kleo_style and every
image_prompt are stripped before project.json is written, and the engine's own "look" (cartoon | realistic | animation) is written
at the top level. A missing or broken picture is never fatal: the shot simply renders as a flat gradient.
Kleo video (keou engine only): a storyboard may also declare backdrop "video", which asks for shots that were
FILMED instead of photographs with a zoom on them. The worker then voices the script itself, asks the engine when
each shot cuts (render.mjs --shots), films every shot with kleo_video.py on this instance's GPU (Wan 2.2 TI2V-5B),
lays the clips into build/footage.mp4 exactly as long as the timeline, hangs each clip on its shot, and renders
with --skip-voice over the alignment already on disk. That order is forced: the cut times come from the engine,
the engine needs the word alignment, and the alignment comes from the voice pass. If even ONE shot does not film,
the backdrop comes off and the film is drawn from the stills — see the note above generate_footage().
Kleo footage over an API: with KLEO_FOOTAGE_BACKEND=kie (set by the server on the box) the clips are NOT made here.
The worker uploads each shot's reference frame (PUT /internal/jobs/{id}/stills/{pictureId}.png), sends the shot plan
(POST /internal/jobs/{id}/footage), polls (GET /internal/jobs/{id}/footage) while the SERVER runs one kie.ai task per
shot (Kling, Veo...) and stores the clips on R2, then downloads them (GET /internal/jobs/{id}/clips/{shotId}). The rest —
the track, the narration, the 4K 60 fps finish — is exactly the same as for locally filmed clips (src/footage.ts).
Tuning: KLEO_WIDTH_PORTRAIT (2160) / KLEO_WIDTH_LANDSCAPE (3840): both formats deliver 4K, KLEO_RENDER_TIMEOUT_MIN (100),
        KLEO_VOICE_TIMEOUT_MIN (25) / KLEO_SHOTS_TIMEOUT_MIN (5): the two passes that precede the filming,
        KLEO_IMAGES_TIMEOUT_S (300: the images call, the server generates on the first request), KLEO_IMAGES_RETRY_WAIT_S (20),
        KLEO_PICTURES (auto | server | local), KLEO_PICTURES_CPU=1 (let kleo_pictures draw on the CPU: tests only),
        KLEO_KEOU_WORKERS (Chromium render workers for run.py: default min(8, cpu count); each one costs RAM),
        KLEO_KEOU_PYTHON (interpreter for run.py: default <engine>/.venv/bin/python if present, else this one).
Standard library only (kleo_pictures.py and kleo_video.py, next to this file, are optional and imported lazily),
so it runs in any image with python3 and ffmpeg.
"""
import copy, glob, json, os, re, shutil, sys, time, threading, subprocess, tempfile, urllib.request, urllib.error, traceback
from collections import deque

API = os.environ.get("KLEO_API", "").rstrip("/")
JOB = os.environ.get("KLEO_JOB_ID", "")
SECRET = os.environ.get("KLEO_SECRET", "")
SELF_DESTRUCT_MIN = int(os.environ.get("KLEO_SELF_DESTRUCT_MIN", "110"))
ENGINE = os.environ.get("KLEO_ENGINE", "keou").strip().lower()
KEOU_DIR = os.environ.get("KLEO_KEOU_DIR", "/opt/kleo/keou")
RENDER_TIMEOUT_MIN = float(os.environ.get("KLEO_RENDER_TIMEOUT_MIN", "100"))
# DELIVERY SIZE, and the two formats now cost the same to make. The engine draws into a fixed design space
# (1080x1920 or 1920x1080) and scales it to whatever width is asked for, so the delivered size is decoupled from
# the layout: portrait has been going 1080 -> 2160 every day since the beginning, and landscape going 1920 -> 3840
# is the identical doubling of a vector drawing.
# Why it changed: portrait delivered 2160x3840 and landscape 1920x1080 for the same price, four times the pixels
# per frame for the same credits (docs/PREZZO-E-COSTO.md). The owner asked for 4K everywhere, and 4K landscape is
# 8.3 Mpixel — exactly what every portrait Short has already been rendered at and sold at. So the cost per frame
# is not a guess here, it is the one this service already pays. etaFor() in src/templates.ts, and the job timeout
# derived from it, were already written for "4K 60 fps": until now landscape simply did not deliver what they
# promised. What is still worth measuring is wall clock on the LONGEST landscape videos, where four times the
# pixels eats into a timeout budget that was generous while the frames were small.
WIDTH_PORTRAIT = int(os.environ.get("KLEO_WIDTH_PORTRAIT", "2160"))      # 2160x3840
WIDTH_LANDSCAPE = int(os.environ.get("KLEO_WIDTH_LANDSCAPE", "3840"))    # 3840x2160
KEOU_WORKERS = min(16, int(os.environ.get("KLEO_KEOU_WORKERS", "0") or 0))  # 0 → min(8, cpu count); the engine refuses more than 16
PART = 50 * 1024 * 1024
UA = "kleo-worker/1.0 (+https://github.com/tonnooooo/kleo-mcp)"
# Kleo pictures: kleo_style values that come with server-generated pictures, and the knobs of the images call.
PICTURE_STYLES = ("cartoon", "realistic", "animation")
IMAGES_TIMEOUT_S = float(os.environ.get("KLEO_IMAGES_TIMEOUT_S", "300"))      # the server generates the pictures on the first call
IMAGES_RETRY_WAIT_S = float(os.environ.get("KLEO_IMAGES_RETRY_WAIT_S", "20"))  # one retry after this long on 5xx / network errors
IMAGE_DOWNLOAD_TIMEOUT_S = 60
PICTURES_POLICY = (os.environ.get("KLEO_PICTURES", "auto").strip().lower() or "auto")  # auto | server | local (see pictures_policy())
IMAGE_MAX_BYTES = 25 * 1024 * 1024
SCENE_ID = re.compile(r"[a-z0-9-]{1,50}")                                       # contract.py scene id slug → safe file name
PICTURE_ID = re.compile(r"[a-z0-9-]{1,56}")                                     # <sceneId>-s<n>: the slug plus the shot suffix
IMAGE_KINDS = ("image", "cinema", "story", "closing")                          # contract.py: the only kinds that accept scene.image
# Kleo footage over an API (kie.ai). The SERVER talks to kie.ai and keeps the key; this box only uploads the reference
# frames, asks for the clips, waits, and downloads them. KLEO_FOOTAGE_BACKEND is set by the server on the box (vast.ts)
# and repeated in the job spec ("footage": {"backend": ...}) for runners that get no env from Vast.
FOOTAGE_BACKEND = (os.environ.get("KLEO_FOOTAGE_BACKEND", "").strip().lower())
FOOTAGE_WAIT_MIN = float(os.environ.get("KLEO_FOOTAGE_WAIT_MIN", "14"))     # how long the box waits for kie.ai before giving up
FOOTAGE_POLL_S = float(os.environ.get("KLEO_FOOTAGE_POLL_S", "12"))         # between two status calls
CLIP_MAX_BYTES = 400 * 1024 * 1024
# THE USER'S MUSIC (22 September 2026): when the storyboard says music "track", the box asks the server for the track
# (kie.ai / Suno, src/footage.ts), waits at most MUSIC_WAIT_MIN, and lays it under the narration at MUSIC_LUFS before
# the mix ducks it further under every spoken word. A track that never comes is silence, never the old sine bed.
MUSIC_WAIT_MIN = float(os.environ.get("KLEO_MUSIC_WAIT_MIN", "8"))
MUSIC_POLL_S = float(os.environ.get("KLEO_MUSIC_POLL_S", "10"))
# -30, not -27: on the first real animatic (gt_hxed87em, 22 September) the track sat only 3 dB under the voice in the
# gaps between sentences (-23.4 dB RMS against -20.3), because the final loudnorm lifts the whole mix; -30 puts it
# 6 dB under there, and the sidechain still takes it further down under every word.
MUSIC_LUFS = float(os.environ.get("KLEO_MUSIC_LUFS", "-30"))     # integrated, before the sidechain; the voice lands at -16
MUSIC_MAX_BYTES = 40 * 1024 * 1024

# Mirrors contract.VOICES; the engine's own contract.py overrides it at run time (see load_voices()).
DEFAULT_VOICES = {"fr": ["ff_siwis"], "en": ["af_heart", "am_michael", "bf_emma"], "it": ["if_sara", "im_nicola"]}
# Kleo voice ids (src/templates.ts) → Kokoro voice ids.
KLEO_VOICE_MAP = {"narrator-en-m": "am_michael", "narrator-en-f": "af_heart", "narrator-it-m": "im_nicola", "narrator-it-f": "if_sara", "narrator-fr-f": "ff_siwis"}
FORBIDDEN_TOP = ("id", "script_file", "music_quiet", "look")  # look is the engine's own field: only strip_kleo_fields writes it


class RenderError(Exception):
    """A render failure with an explicit retry hint for the server (contract errors are not retried)."""
    def __init__(self, message, retry=True):
        super().__init__(message)
        self.retry = retry


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def api(method, path, data=None, raw=None, ctype="application/json", retries=3):
    body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
    req = urllib.request.Request(f"{API}{path}", data=body, method=method)
    req.add_header("Authorization", f"Bearer {SECRET}")
    req.add_header("User-Agent", UA)  # workers.dev refuses Python's default user agent (Cloudflare error 1010)
    if body is not None:
        req.add_header("Content-Type", ctype)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                txt = r.read().decode() or "{}"
                return json.loads(txt) if txt.startswith("{") else txt
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:
                raise
            log("api error", e.code, "retrying")
        except Exception as e:  # network hiccup
            log("api error", e, "retrying")
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"api {method} {path} failed after {retries} tries")


def progress(track, percent, eta_min=None, message=None):
    try:
        api("POST", f"/internal/jobs/{JOB}/progress", {"track": track, "percent": percent, "eta_min": eta_min, "message": message})
    except Exception as e:
        log("progress report failed:", e)


def download(name, path):
    """A file of this job from R2, through the internal API (the finish box fetching the GPU phase's bundle)."""
    req = urllib.request.Request(f"{API}/internal/jobs/{JOB}/files/{name}")
    req.add_header("Authorization", f"Bearer {SECRET}")
    req.add_header("User-Agent", UA)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=600) as r, open(path, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            if os.path.getsize(path) > 0:
                return path
        except Exception as e:
            log("download error", e, "retrying")
        time.sleep(3 * (attempt + 1))
    raise RenderError(f"could not fetch {name}", retry=True)


def upload(path, name):
    size = os.path.getsize(path)
    if size <= 90 * 1024 * 1024:
        with open(path, "rb") as f:
            api("PUT", f"/internal/jobs/{JOB}/files/{name}", raw=f.read(), ctype="application/octet-stream")
        return
    up = api("POST", f"/internal/jobs/{JOB}/files/{name}/uploads")
    uid, parts, n = up["uploadId"], [], 1
    with open(path, "rb") as f:
        while True:
            chunk = f.read(PART)
            if not chunk:
                break
            r = api("PUT", f"/internal/jobs/{JOB}/files/{name}/uploads/{uid}/parts/{n}", raw=chunk, ctype="application/octet-stream")
            parts.append({"partNumber": r["partNumber"], "etag": r["etag"]})
            log(f"uploaded part {n} of {name}")
            n += 1
    api("POST", f"/internal/jobs/{JOB}/files/{name}/uploads/{uid}/complete", {"parts": parts})


def self_destruct(reason):
    """Destroy this instance with the restricted key Vast injects into every container."""
    log("self-destruct:", reason)
    cid, key = os.environ.get("CONTAINER_ID"), os.environ.get("CONTAINER_API_KEY")
    if cid and key:
        try:
            req = urllib.request.Request(f"https://console.vast.ai/api/v0/instances/{cid}/", method="DELETE")
            req.add_header("Authorization", f"Bearer {key}")
            req.add_header("User-Agent", UA)
            urllib.request.urlopen(req, timeout=30).read()
            return
        except Exception as e:
            log("direct destroy failed:", e)
    try:
        api("POST", f"/internal/jobs/{JOB}/selfdestruct")
    except Exception as e:
        log("server-side destroy failed:", e)


def watchdog():
    t = threading.Timer(SELF_DESTRUCT_MIN * 60, lambda: (api_safe_fail("watchdog timeout"), self_destruct("watchdog")))
    t.daemon = True
    t.start()


def api_safe_fail(msg, retry=True):
    try:
        api("POST", f"/internal/jobs/{JOB}/failed", {"error": msg, "retry": bool(retry)})
    except Exception:
        pass


# ----------------------------------------------------------------------------------------------
# RENDER PIPELINE. render() must write video.mp4, subtitles.srt and thumbnail.jpg into out_dir and call progress().
# Tracks and percent ranges expected by the server: script 0-8, voice 8-16, clips 16-64, edit 64-78, finishing 78-99.
# ----------------------------------------------------------------------------------------------
def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", *args], check=True)


THUMB_AT_S = float(os.environ.get("KLEO_THUMB_AT_S", "1.5"))   # oltre l'entrata del titolo, dentro la prima scena


def thumbnail_from(video, out_path, png=None):
    """JPEG thumbnail, PRESA DAL MASTER e non dal provino della pagina di controllo.

    Le immagini in out/qa/ sono disegnate su un canvas largo 540 px (render.mjs le fa nel passaggio di layout),
    mentre il video esce a 2160x3840: la miniatura usciva a 540x960, cioe' un sedicesimo del fotogramma, sotto il
    minimo consigliato da YouTube. Ed e' la sola cosa che una persona vede PRIMA di decidere se guardare il video.
    Il provino resta come ultima spiaggia, se il master non si lascia leggere.

    Il momento non e' l'inizio: a un secondo e mezzo il titolo della prima scena ha finito di entrare, quindi la
    miniatura mostra una scritta ferma invece di una a meta' animazione."""
    for args in (("-ss", str(THUMB_AT_S), "-i", video), ("-i", video)):
        try:
            ffmpeg(*args, "-frames:v", "1", "-q:v", "2", out_path)
            return out_path
        except subprocess.CalledProcessError:
            continue
    if png and os.path.isfile(png):
        log("thumbnail: the master could not be read, falling back to the 540 px QA still")
        try:
            ffmpeg("-i", png, "-frames:v", "1", "-q:v", "2", out_path)
        except subprocess.CalledProcessError:
            log("thumbnail: the QA still failed too; the video ships without one")
    return out_path


def render_placeholder(job, out_dir):
    """Fallback engine (KLEO_ENGINE=placeholder): dark frame with the prompt as text, right geometry, 60 fps, real length."""
    p = job.get("params") or {}
    dur = int(p.get("duration_s", 45))
    w, h = (2160, 3840) if p.get("format") == "9:16" else (3840, 2160)
    prompt = job.get("prompt") or "Kleo"

    progress("script", 3, message="writing script")
    progress("voice", 10, message="synthesizing voice")
    progress("clips", 20, message="generating clips")
    video = os.path.join(out_dir, "video.mp4")
    txt = prompt.replace("'", "").replace(":", " ")[:60]
    vf = f"drawtext=text='{txt}':fontcolor=white:fontsize={h//30}:x=(w-text_w)/2:y=(h-text_h)/2"
    base = ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x0F1216:s={w}x{h}:d={dur}:r=60",
            "-f", "lavfi", "-i", f"sine=f=220:d={dur}"]
    enc = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-shortest", video]
    if subprocess.run(base + ["-vf", vf] + enc).returncode != 0:
        subprocess.run(base + enc, check=True)               # no font available: skip the text
    progress("edit", 70, message="editing")
    srt = os.path.join(out_dir, "subtitles.srt")
    with open(srt, "w") as f:
        f.write(f"1\n00:00:00,000 --> 00:00:05,000\n{prompt[:90]}\n")
    progress("finishing", 85, message="encoding")
    thumb = thumbnail_from(video, os.path.join(out_dir, "thumbnail.jpg"))
    progress("finishing", 95, message="encoded")
    return {"video.mp4": video, "subtitles.srt": srt, "thumbnail.jpg": thumb}


# ---- Keou engine ------------------------------------------------------------------------------
def load_voices(engine):
    """VOICES from the engine's own contract.py, so the worker follows the installed engine (e.g. new languages)."""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("keou_contract", os.path.join(engine, "contract.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        v = {k: sorted(s) for k, s in mod.VOICES.items()}
        if v:
            return v
    except Exception as e:
        log("could not read engine contract VOICES, using built-in table:", e)
    return DEFAULT_VOICES


def project_id_for(job_id):
    pid = re.sub(r"[^a-z0-9-]", "-", str(job_id).lower().replace("_", "-")).strip("-")
    if not pid or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", pid):
        pid = "job-" + (pid or "x")
    return pid[:70]


def build_project(job, engine):
    """storyboard + id/brand/format/width/fps/language/voice → a Keou project dict. Never keeps forbidden fields."""
    sb = job.get("storyboard")
    if isinstance(sb, str):
        try:
            sb = json.loads(sb)
        except ValueError:
            sb = None
    if not isinstance(sb, dict) or not isinstance(sb.get("scenes"), list) or not sb["scenes"]:
        raise RenderError("job has no storyboard: the server must attach a Keou project (scenes) before the worker can render", retry=False)
    c = copy.deepcopy(sb)
    for k in FORBIDDEN_TOP:
        c.pop(k, None)
    dropped = [s.get("id") for s in c["scenes"] if isinstance(s, dict) and s.get("kind") == "image"]
    if dropped:
        log("dropping image scenes (no assets on the worker):", dropped)
        c["scenes"] = [s for s in c["scenes"] if not (isinstance(s, dict) and s.get("kind") == "image")]
    if not c["scenes"]:
        raise RenderError("storyboard has no renderable scenes", retry=False)
    stale = [s.get("id") for s in c["scenes"] if isinstance(s, dict)
             and ("image" in s or any(isinstance(sh, dict) and "image" in sh for sh in shots_of(s)))]
    if stale:  # no asset travels with a job: only the pictures the worker downloads itself (attach_pictures) may be referenced
        log("dropping scene.image / shot.image (assets never travel with a job):", stale)
        for s in c["scenes"]:
            if isinstance(s, dict):
                s.pop("image", None)
                for sh in shots_of(s):
                    if isinstance(sh, dict):
                        sh.pop("image", None)

    p = job.get("params") or {}
    fmt = p.get("format") or c.get("format") or "9:16"
    if fmt not in ("9:16", "16:9"):
        raise RenderError(f"unsupported format {fmt!r}", retry=False)
    c["id"] = project_id_for(job.get("job_id") or JOB)
    c["brand"] = (job.get("brand") or c.get("brand") or "Kleo")[:28]
    c["format"] = fmt
    c["width"] = WIDTH_PORTRAIT if fmt == "9:16" else WIDTH_LANDSCAPE
    c["fps"] = 60
    c.setdefault("schema_version", 1)
    c.setdefault("editorial_status", "ready")
    if not c.get("title"):
        c["title"] = (job.get("prompt") or "Kleo video").strip()[:120] or "Kleo video"

    voices = load_voices(engine)
    lang = c.get("language") or p.get("language") or "en"
    if lang not in voices:
        raise RenderError(f"language {lang!r} is not supported by the render engine (available: {', '.join(sorted(voices))})", retry=False)
    c["language"] = lang
    voice = c.get("voice") or p.get("voice") or ""
    voice = KLEO_VOICE_MAP.get(voice, voice)
    if voice not in voices[lang]:
        fallback = voices[lang][0]
        if voice:
            log(f"voice {voice!r} is not legal for language {lang!r}; using {fallback!r}")
        voice = fallback
    c["voice"] = voice
    return c


class EngineProgress:
    """Maps Keou's stdout (STAGE / VOICE_NEW / FRAME / SEGMENT_OK / …) onto the server's progress tracks."""
    def __init__(self, n_scenes, workers):
        self.n_scenes, self.workers = max(1, n_scenes), max(1, workers)
        self.voiced = self.segments = 0
        self.max_frame = 0
        self.frames = {}          # worker id -> its latest ABSOLUTE frame; see the FRAME branch
        self.total = None
        self.render_started = None
        self.last_post = 0.0
        self.last_percent = 0

    def post(self, track, percent, message=None, eta_min=None, force=False):
        percent = int(max(self.last_percent, min(99, percent)))
        if not force and percent == self.last_percent and time.time() - self.last_post < 15:
            return
        self.last_percent, self.last_post = percent, time.time()
        progress(track, percent, eta_min=eta_min, message=message)

    def line(self, line):
        parts = line.split()
        if not parts:
            return
        head = parts[0]
        if head == "STAGE" and len(parts) > 1:
            stage = parts[1]
            if stage == "voice":
                self.post("voice", 10, "synthesizing voice", force=True)
            elif stage == "audio":
                self.post("voice", 16, "mixing audio", force=True)
            elif stage in ("render", "layout"):
                self.render_started = time.time()
                self.post("clips", 20, "rendering frames", force=True)
            elif stage == "quality":
                self.post("edit", 70, "quality checks", force=True)
            elif stage == "preview":
                self.post("finishing", 85, "captions + preview", force=True)
        elif head in ("VOICE_NEW", "VOICE_CACHE"):
            self.voiced += 1
            self.post("voice", 10 + 5 * min(1.0, self.voiced / self.n_scenes), f"voice {self.voiced}/{self.n_scenes}")
        elif head == "LAYOUT_PASS":
            self.post("clips", 22, "layout checked", force=True)
        elif head == "FRAME" and len(parts) >= 5:            # FRAME <worker> <frame> / <total>
            try:
                wid, f, total = int(parts[1]), int(parts[2]), int(parts[4])
                self.total = total
                self.max_frame = max(self.max_frame, f)
                # EACH WORKER DRAWS ITS OWN BLOCK, and the frame number it prints is ABSOLUTE. So the highest
                # number seen belongs to the LAST worker, who reaches the end of the film first — while five
                # others are still in the middle of theirs. Reading it as progress put the bar at the top of its
                # band, and the ETA at nearly zero, for minutes of real work: measured on the first 4K render,
                # where the bar sat at 57% while the slowest worker was at 300 of its 341 frames.
                # The blocks are render.mjs's own: first = floor(total * id / workers).
                self.frames[wid] = f
                done = sum(v - (total * k // max(1, self.workers)) + 1 for k, v in self.frames.items())
                frac = min(1.0, max(0.0, done / total)) if total else 0
                eta = None
                if self.render_started and frac > 0.02:
                    eta = round((time.time() - self.render_started) * (1 - frac) / frac / 60, 1)
                self.post("clips", 22 + 36 * frac, f"frame {done}/{total}", eta_min=eta)
            except ValueError:
                pass
        elif head in ("SEGMENT_OK", "RESUME_VALIDATED"):
            self.segments += 1
            self.post("clips", 22 + 36 * min(1.0, self.segments / self.workers), f"segment {self.segments}/{self.workers}")
        elif head == "RENDER_COMPLETE":
            self.post("clips", 60, "frames encoded", force=True)
        elif head == "DELIVERED":
            self.post("finishing", 90, "delivered", force=True)


def keou_python(engine):
    p = os.environ.get("KLEO_KEOU_PYTHON")
    if p:
        return p
    venv = os.path.join(engine, ".venv", "bin", "python")
    return venv if os.path.isfile(venv) else sys.executable


def run_keou(engine, project_json, n_scenes, log_path, skip_voice=False):
    workers = max(1, KEOU_WORKERS) if KEOU_WORKERS > 0 else min(8, os.cpu_count() or 2)
    cmd = [keou_python(engine), os.path.join(engine, "run.py"), project_json, "--workers", str(workers)]
    if skip_voice:
        # The worker already voiced the script, because the shot cut times are computed from that alignment and
        # the footage had to be filmed to those lengths before this render could start. run.py checks the cached
        # timeline still matches the script, so a stale alignment cannot slip through.
        cmd.append("--skip-voice")
    log("engine:", " ".join(cmd))
    env = dict(os.environ, PYTHONUNBUFFERED="1")
    proc = subprocess.Popen(cmd, cwd=engine, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
                            env=env, start_new_session=True)
    timed_out = threading.Event()

    def kill():
        timed_out.set()
        log(f"render timeout after {RENDER_TIMEOUT_MIN} min: killing the engine")
        try:
            os.killpg(proc.pid, 15)
        except Exception:
            pass
        time.sleep(10)
        try:
            os.killpg(proc.pid, 9)
        except Exception:
            pass

    timer = threading.Timer(RENDER_TIMEOUT_MIN * 60, kill)
    timer.daemon = True
    timer.start()
    tail = deque(maxlen=60)
    tracker = EngineProgress(n_scenes, workers)
    try:
        with open(log_path, "a") as lf:
            for line in proc.stdout:
                line = line.rstrip("\n")
                lf.write(line + "\n")
                print("  │", line, flush=True)
                tail.append(line)
                try:
                    tracker.line(line)
                except Exception as e:
                    log("progress parse error:", e)
        code = proc.wait()
    finally:
        timer.cancel()
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, 9)
            except Exception:
                pass
    if timed_out.is_set():
        raise RenderError(f"render exceeded {RENDER_TIMEOUT_MIN:g} minutes", retry=True)
    if code != 0:
        contract = [l for l in tail if re.match(r"^\s*ValueError:\s*\S", l)]
        if contract:
            msg = contract[-1].split("ValueError:", 1)[1].strip()
            raise RenderError(f"storyboard rejected by the engine: {msg}"[:480], retry=False)
        detail = " | ".join(l for l in list(tail)[-6:] if l.strip())
        raise RenderError(f"engine exited with code {code}: {detail}"[:480], retry=True)


# ---- Kleo pictures ----------------------------------------------------------------------------
# cartoon / realistic storyboards (style "picture") carry a list of shots per scene, each shot one image_prompt; the
# server turns each one into a picture (once per job) and hands out signed download links, keyed by picture id
# "<sceneId>-s<n>". Everything in this section is optional for the render: any failure leaves the shot without picture
# (the engine draws a flat accent gradient) and the video is made like a plain Keou project.
def shots_of(scene):
    """The scene's shots as a list (empty when the scene has none: cyber/stickman scenes, or a legacy picture scene)."""
    shots = scene.get("shots") if isinstance(scene, dict) else None
    return shots if isinstance(shots, list) else []


def picture_units(sb):
    """Every shot that asks for a picture, in scene → shot order:
        [{"id": "<sceneId>-s<n>", "scene": <scene dict>, "shot": <shot dict | None>, "image_prompt": <text>}, ...]
    The id is the picture id the server keys its images / missing maps by (n = 1-based shot index). A scene with no
    shots but a scene-level image_prompt (the pre-shots format: the server normalises it away before storing, so it
    should not reach the worker any more) counts as that scene's shot 1, with "shot": None — the picture is then
    attached to the scene itself. Malformed entries are skipped: a scene id that is not a slug, a shot that is not an
    object, an empty prompt, a picture id no longer usable as a file name, or a duplicate id."""
    units, seen = [], set()
    for s in (sb.get("scenes") if isinstance(sb, dict) else None) or []:
        if not isinstance(s, dict):
            continue
        shots = shots_of(s)
        entries = ([(i + 1, sh, sh.get("image_prompt") if isinstance(sh, dict) else None) for i, sh in enumerate(shots)]
                   if shots else [(1, None, s.get("image_prompt"))])
        entries = [(n, shot, p) for n, shot, p in entries if isinstance(p, str) and p.strip()]
        if not entries:
            continue
        sid = s.get("id")
        if not (isinstance(sid, str) and SCENE_ID.fullmatch(sid)):
            log(f"picture: scene id {sid!r} is not a slug, skipped")
            continue
        for n, shot, prompt in entries:
            pid = f"{sid}-s{n}"
            if not PICTURE_ID.fullmatch(pid) or pid in seen:
                log(f"picture {pid!r}: unusable picture id, skipped")
                continue
            seen.add(pid)
            units.append({"id": pid, "scene": s, "shot": shot, "image_prompt": prompt})
    return units


def picture_ids(sb):
    """The picture ids of a storyboard, in scene → shot order."""
    return [u["id"] for u in picture_units(sb)]


def wants_pictures(sb):
    """True when the server is expected to hold pictures for this storyboard: cartoon/realistic with at least one shot prompt."""
    return isinstance(sb, dict) and sb.get("kleo_style") in PICTURE_STYLES and bool(picture_units(sb))


def request_pictures(job_id):
    """One POST /internal/jobs/{id}/images (empty body, job secret) → the parsed JSON reply. Raises on any failure."""
    req = urllib.request.Request(f"{API}/internal/jobs/{job_id}/images", data=b"", method="POST")
    req.add_header("Authorization", f"Bearer {SECRET}")
    req.add_header("User-Agent", UA)
    with urllib.request.urlopen(req, timeout=IMAGES_TIMEOUT_S) as r:
        reply = json.loads(r.read().decode() or "{}")
    if not isinstance(reply, dict):
        raise ValueError("images reply is not a JSON object")
    return reply


def fetch_pictures(job_id, retry_wait_s=None):
    """{"images": {pictureId: url}, "missing": [pictureIds]} from the server, or None when it could not answer.
    A 5xx, a network error or a garbled reply is retried once after retry_wait_s (default IMAGES_RETRY_WAIT_S);
    a 4xx (no such endpoint, job in the wrong state) is final. Never raises: pictures are optional."""
    wait = IMAGES_RETRY_WAIT_S if retry_wait_s is None else retry_wait_s
    err = None
    for attempt in (1, 2):
        try:
            reply = request_pictures(job_id)
            images = reply.get("images") if isinstance(reply.get("images"), dict) else {}
            missing = [m for m in (reply.get("missing") if isinstance(reply.get("missing"), list) else []) if isinstance(m, str)]
            return {"images": images, "missing": missing}
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:
                try:
                    detail = e.read(200).decode("utf-8", "replace")
                except Exception:
                    detail = ""
                log(f"pictures: server answered {e.code} {detail!r}; rendering without pictures")
                return None
            err = f"HTTP {e.code}"
        except Exception as e:  # URLError, timeout, bad JSON
            err = repr(e)
        if attempt == 1:
            log(f"pictures: request failed ({err}); retrying once in {wait:g} s")
            time.sleep(wait)
    log(f"pictures: request failed again ({err}); rendering without pictures")
    return None


def image_ext(data):
    """File extension for PNG / JPEG / WebP bytes (sniffed: the link's content-type is not trusted), else None."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def download_picture(url, img_dir, picture_id):
    """GET a signed picture link (same User-Agent as api(); no bearer, the link is signed) into <img_dir>/<picture_id>.<ext>.
    Returns the file name, or None when anything is off (never raises)."""
    if not (isinstance(picture_id, str) and PICTURE_ID.fullmatch(picture_id)):
        log(f"picture: id {picture_id!r} is not a slug, skipped")
        return None
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        log(f"picture {picture_id}: no usable link")
        return None
    try:
        req = urllib.request.Request(url, method="GET")
        req.add_header("User-Agent", UA)
        with urllib.request.urlopen(req, timeout=IMAGE_DOWNLOAD_TIMEOUT_S) as r:
            data = r.read(IMAGE_MAX_BYTES + 1)
    except Exception as e:
        log(f"picture {picture_id}: download failed: {e}")
        return None
    if len(data) > IMAGE_MAX_BYTES:
        log(f"picture {picture_id}: larger than {IMAGE_MAX_BYTES} bytes, skipped")
        return None
    ext = image_ext(data)
    if not ext:
        log(f"picture {picture_id}: not a PNG/JPEG/WebP file ({len(data)} bytes), skipped")
        return None
    os.makedirs(img_dir, exist_ok=True)
    name = picture_id + ext
    with open(os.path.join(img_dir, name), "wb") as f:
        f.write(data)
    return name


def attach_picture(unit, name):
    """Points a picture unit at the file it just got: shot.image, or scene.image for a legacy scene-level prompt."""
    target = unit["shot"] if isinstance(unit["shot"], dict) else unit["scene"]
    target["image"] = "img/" + name


def set_scene_images(project):
    """scene.image = the scene's first shot picture (compatibility: the picture style draws the shots themselves).
    A scene whose shots got no picture at all is left alone (a legacy scene-level picture stays where it is)."""
    for s in project.get("scenes") or []:
        if not isinstance(s, dict):
            continue
        first = next((sh["image"] for sh in shots_of(s) if isinstance(sh, dict) and isinstance(sh.get("image"), str)), None)
        if first:
            s["image"] = first


def attach_pictures(project, pdir, reply):
    """Downloads the server's pictures into <pdir>/img/ and sets shot.image = "img/<pictureId>.<ext>" on every shot that
    asked for one, then scene.image on every scene that got a picture. Returns (ready_ids, missing_ids): a picture
    without a link, or whose download fails, simply stays missing."""
    images = (reply or {}).get("images") or {}
    ready, missing = [], []
    for u in picture_units(project):
        pid, scene = u["id"], u["scene"]
        if scene.get("kind") not in IMAGE_KINDS:  # the engine refuses pictures elsewhere; better no picture than no video
            log(f"picture {pid}: a {scene.get('kind')!r} scene cannot carry a picture, skipped")
            missing.append(pid)
            continue
        name = download_picture(images.get(pid), os.path.join(pdir, "img"), pid) if pid in images else None
        if name:
            attach_picture(u, name)
            ready.append(pid)
        else:
            missing.append(pid)
    set_scene_images(project)
    return ready, missing


def pictures_policy():
    """KLEO_PICTURES normalised: auto (server first, GPU for the rest), server (never local), local (never the server)."""
    return PICTURES_POLICY if PICTURES_POLICY in ("auto", "server", "local") else "auto"


def local_pictures_module():
    """kleo_pictures (next to this file) or None when it is not shipped. Never raises."""
    try:
        import kleo_pictures
        return kleo_pictures
    except ImportError:
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
            try:
                import kleo_pictures
                return kleo_pictures
            except ImportError:
                pass
    except Exception as e:
        log("kleo_pictures could not be imported:", e)
    return None


def local_pictures_available():
    """True when this instance can draw pictures itself (kleo_pictures present + a CUDA GPU, or KLEO_PICTURES_CPU=1)."""
    mod = local_pictures_module()
    if mod is None:
        return False
    try:
        return bool(mod.can_generate())
    except Exception as e:
        log("local pictures unavailable:", e)
        return False


def generate_local_pictures(project, pdir, ids):
    """Draws the listed pictures (those still missing) with kleo_pictures on this machine into <pdir>/img/<pictureId>.png
    and sets shot.image on each success. Returns the ids that got a picture, in scene → shot order. Never raises."""
    mod = local_pictures_module()
    if mod is None or not ids:
        return []
    wanted = set(ids)
    units = [u for u in picture_units(project) if u["id"] in wanted and u["scene"].get("kind") in IMAGE_KINDS]
    if not units:
        return []
    img_dir = os.path.join(pdir, "img")
    try:
        # The scene's accent and the film's direction travel with every picture: the colour law and the exclusion
        # list are only real once the image model sees them, and until now they stopped at the caption furniture.
        made = mod.generate_pictures([{"id": u["id"], "image_prompt": u["image_prompt"], "accent": u["scene"].get("accent")} for u in units],
                                     project.get("kleo_style"), project.get("format") or "9:16", img_dir,
                                     direction=project.get("direction"))
    except Exception as e:
        log("local picture generation failed:", e)
        return []
    if not isinstance(made, dict):
        return []
    done = []
    for u in units:
        path = made.get(u["id"])
        if not (isinstance(path, str) and os.path.isfile(path) and os.path.getsize(path) > 0):
            continue
        name = os.path.basename(path)
        if os.path.dirname(os.path.abspath(path)) != os.path.abspath(img_dir) or not name.startswith(u["id"] + "."):
            log(f"picture {u['id']}: unexpected path {path!r}, skipped")
            continue
        attach_picture(u, name)
        done.append(u["id"])
    set_scene_images(project)
    return done


# ---- Kleo footage over the API: the server films, this box waits -----------------------------------------------------
def footage_backend():
    """"kie" when the server said the clips come from kie.ai through it, else "local" (this box's own model)."""
    return "kie" if FOOTAGE_BACKEND == "kie" else "local"


def set_footage_backend(job):
    """The env wins (vast.ts writes it on the box); a job spec's "footage" fills in for runners without one."""
    global FOOTAGE_BACKEND
    if FOOTAGE_BACKEND in ("kie", "local"):
        return FOOTAGE_BACKEND
    spec = job.get("footage") if isinstance(job, dict) else None
    if isinstance(spec, dict) and spec.get("backend") in ("kie", "local"):
        FOOTAGE_BACKEND = spec["backend"]
    return footage_backend()


def upload_still(path, picture_id):
    """PUT the shot's reference frame to the server so kie.ai can read it (image-to-video). Returns the stored name."""
    ext = os.path.splitext(path)[1].lower().lstrip(".") or "png"
    with open(path, "rb") as f:
        r = api("PUT", f"/internal/jobs/{JOB}/stills/{picture_id}.{ext}", raw=f.read(),
                ctype={"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(ext, "application/octet-stream"))
    return r.get("name") if isinstance(r, dict) else None


def request_remote_footage(plan):
    """POST the shots to film (id, prompt, camera, seconds, still) → the server creates one kie.ai task per shot
    that has none yet. Idempotent: calling it twice creates nothing twice. Raises on a 4xx (budget, config)."""
    return api("POST", f"/internal/jobs/{JOB}/footage", plan)


def poll_remote_footage():
    """GET the state of every shot: {"clips": {id: state}, "ready": [...], "pending": [...], "failed": {id: why}}."""
    return api("GET", f"/internal/jobs/{JOB}/footage")


def download_clip(shot_id, path):
    """One finished clip, streamed from the server (R2) with the job secret. Returns path or None; never raises."""
    for attempt in range(3):
        try:
            req = urllib.request.Request(f"{API}/internal/jobs/{JOB}/clips/{shot_id}")
            req.add_header("Authorization", f"Bearer {SECRET}")
            req.add_header("User-Agent", UA)
            with urllib.request.urlopen(req, timeout=600) as r, open(path, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                head = f.read(12)
            if 0 < size <= CLIP_MAX_BYTES and head[4:8] == b"ftyp":
                return path
            log(f"clip {shot_id}: not an mp4 ({size} bytes), discarded")
            try:
                os.remove(path)
            except OSError:
                pass
            return None
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:
                log(f"clip {shot_id}: server answered {e.code}")
                return None
            log(f"clip {shot_id}: download error {e.code}, retrying")
        except Exception as e:
            log(f"clip {shot_id}: download error {e}, retrying")
        time.sleep(3 * (attempt + 1))
    return None


def remote_clips(units, look, fmt, out_dir, seconds_of=None, wait_min=None, poll_s=None):
    """The kie.ai road: same contract as kleo_video.generate_clips ({shot_id: mp4 path} for the shots that were made),
    but the filming happens on the server's account and this box only waits. A shot that fails is simply absent, so
    the caller's rule still holds: one missing clip and the film is not a film."""
    os.makedirs(out_dir, exist_ok=True)
    shots = []
    for u in units:
        sid = u.get("id")
        if not sid or not str(u.get("image_prompt") or "").strip():
            continue
        still = u.get("image")
        name = None
        if isinstance(still, str) and os.path.isfile(still):
            try:
                name = upload_still(still, sid)
            except Exception as e:
                log(f"{sid}: could not upload the reference frame ({e}); kie.ai will invent the frame from the text")
        secs = (seconds_of or {}).get(sid) or u.get("dur") or 3.0
        shots.append({"id": sid, "image_prompt": u["image_prompt"], "motion": u.get("motion"), "strength": u.get("strength"),
                      "seconds": round(float(secs), 3), "still": name})
    if not shots:
        return {}
    try:
        reply = request_remote_footage({"shots": shots, "look": look, "format": fmt})
    except urllib.error.HTTPError as e:
        try:
            detail = e.read(300).decode("utf-8", "replace")
        except Exception:
            detail = ""
        log(f"footage: the server refused the request ({e.code} {detail!r})")
        return {}
    except Exception as e:
        log("footage: the request failed:", e)
        return {}
    log(f"footage: {len(shots)} shots sent to the server ({reply.get('model') if isinstance(reply, dict) else '?'})")
    wait = FOOTAGE_WAIT_MIN if wait_min is None else wait_min
    step = FOOTAGE_POLL_S if poll_s is None else poll_s
    deadline, done, last = time.time() + wait * 60, {}, None
    wanted = [s["id"] for s in shots]
    while True:
        try:
            st = poll_remote_footage()
        except Exception as e:
            log("footage: status call failed:", e)
            st = None
        if isinstance(st, dict):
            ready = [i for i in (st.get("ready") or []) if i in wanted and i not in done]
            for sid in ready:
                path = download_clip(sid, os.path.join(out_dir, f"{sid}.mp4"))
                if path:
                    done[sid] = path
            failed = st.get("failed") or {}
            pending = [i for i in (st.get("pending") or []) if i in wanted]
            summary = f"{len(done)} ready, {len(pending)} pending, {len(failed)} failed"
            if summary != last:
                log("footage:", summary, *(f"{k}: {v}" for k, v in list(failed.items())[:4]))
                progress("clips", 12 + int(40 * len(done) / max(1, len(wanted))), message=f"kie.ai: {summary}")
                last = summary
            if not pending or all(i in done or i in failed for i in wanted):
                break
        if time.time() > deadline:
            log(f"footage: gave up after {wait:g} min with {len(done)}/{len(wanted)} clips")
            break
        time.sleep(step)
    return done


# ---- Kleo video: the shot is filmed, not photographed ---------------------------------------------------------
# A storyboard asks for generated motion by declaring backdrop "video". src/keou-contract.ts lets that ask through
# and, in the same breath, forbids a storyboard from carrying the clips themselves — they are made here, on the
# rented card, because they cost minutes and dollars and must never travel with a job. Fulfilling the ask is this
# section's whole job: film every shot, lay the clips into one track exactly as long as the timeline, and hand the
# engine a project whose shots each carry their own clip.
#
# THE ORDER IS FORCED, and that is why this lives in the worker and not in the engine. The cut times belong to the
# engine (render.mjs --shots); the engine cannot work them out without the word alignment (build/timeline.json);
# and that alignment is made by the voice stage inside run.py. So the worker runs the voice itself, asks the engine
# when each shot cuts, films to exactly those lengths, and only then lets run.py render with --skip-voice over the
# alignment that is already on disk. Nothing in the engine was changed for any of this: it already lays
# build/footage.mp4 under the graphics whenever the project declares the backdrop.
#
# THE FALLBACK IS THE POINT OF THE DESIGN. If even one shot comes back without a clip, the backdrop comes off the
# project and the film is drawn from the stills, exactly as it was before any of this existed. contract.py refuses
# a video backdrop with a missing clip deliberately: a hole in the track is a black hole in the delivered film, and
# the only thing that ever finds it is the person watching the video they have already paid for.
VOICE_TIMEOUT_MIN = float(os.environ.get("KLEO_VOICE_TIMEOUT_MIN", "25"))
SHOTS_TIMEOUT_MIN = float(os.environ.get("KLEO_SHOTS_TIMEOUT_MIN", "5"))
CLIPS_DIR = "clips"                       # contract.py: a clip is legal only inside the project's clips/ folder


def wants_footage(project):
    """True when the storyboard asked to be filmed. Only the picture style may ask (contract.py refuses the rest)."""
    return isinstance(project, dict) and project.get("backdrop") == "video" and project.get("style") == "picture"


def video_units(project):
    """The shots to film, each with the camera the server already resolved into `motion`. Must be read BEFORE
    strip_kleo_fields takes the prompts away, and it keeps the shot object itself so the clip can be hung on it."""
    units = []
    for u in picture_units(project):
        shot = u["shot"]
        if not isinstance(shot, dict):
            continue          # the pre-shots format has no shot object to hang a clip on
        units.append({"id": u["id"], "image_prompt": u["image_prompt"], "shot": shot,
                      "motion": shot.get("motion"), "strength": shot.get("strength")})
    return units


def local_video_module():
    """kleo_video (next to this file) or None when it is not shipped. Never raises."""
    try:
        import kleo_video
        return kleo_video
    except ImportError:
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
            try:
                import kleo_video
                return kleo_video
            except ImportError:
                pass
    except Exception as e:
        log("kleo_video could not be imported:", e)
    return None


def engine_step(cmd, engine, log_path, what, timeout_min):
    """One engine command, streamed into the same log the render writes into. Raises RenderError on failure."""
    cmd = [str(c) for c in cmd]
    log("engine:", " ".join(cmd))
    proc = subprocess.Popen(cmd, cwd=engine, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            errors="replace", env=dict(os.environ, PYTHONUNBUFFERED="1"), start_new_session=True)
    timed_out = threading.Event()

    def kill():
        timed_out.set()
        log(f"{what}: timeout after {timeout_min:g} min, killing it")
        for sig in (15, 9):
            try:
                os.killpg(proc.pid, sig)
            except Exception:
                pass
            time.sleep(5)

    timer = threading.Timer(timeout_min * 60, kill)
    timer.daemon = True
    timer.start()
    tail = deque(maxlen=25)
    try:
        with open(log_path, "a") as lf:
            for line in proc.stdout:
                line = line.rstrip("\n")
                lf.write(line + "\n")
                print("  │", line, flush=True)
                tail.append(line)
        code = proc.wait()
    finally:
        timer.cancel()
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, 9)
            except Exception:
                pass
    if timed_out.is_set():
        raise RenderError(f"{what} exceeded {timeout_min:g} minutes", retry=True)
    if code != 0:
        detail = " | ".join(l for l in list(tail)[-5:] if l.strip())
        raise RenderError(f"{what} exited with code {code}: {detail}"[:480], retry=True)


def shot_plan(build):
    """build/shots.json: the frame the engine will draw in, and when every shot cuts, keyed by the same picture ids
    picture_units builds — so the clip a shot gets is the clip that shot's graphics were timed against."""
    try:
        with open(os.path.join(build, "shots.json")) as f:
            plan = json.load(f)
    except Exception as e:
        log("could not read the shot plan:", e)
        return None, {}
    seconds = {}
    for scene in plan.get("scenes") or []:
        sid = scene.get("id")
        for sh in scene.get("shots") or []:
            try:
                n, secs = int(sh.get("index", 0)) + 1, float(sh.get("end", 0)) - float(sh.get("start", 0))
            except (TypeError, ValueError):
                continue
            if sid and secs > 0:
                seconds[f"{sid}-s{n}"] = secs
    return plan, seconds


def still_of(shot, pdir):
    """Absolute path of the shot's picture if it exists on disk, else None."""
    im = shot.get("image") if isinstance(shot, dict) else None
    if not isinstance(im, str) or not im:
        return None
    path = os.path.join(pdir, im)
    return path if os.path.isfile(path) else None


def generate_footage(project, pdir, engine, log_path, units, lay_track=True):
    """Voice → cut times → film every shot → build/footage.mp4, with each shot's clip hung on the shot itself.
    Returns True when the project keeps its video backdrop, False when the film falls back to the stills.
    With lay_track=False it stops after the clips (the GPU phase of a two-phase film): the track is laid on a
    cheaper machine by lay_footage()."""
    mod = local_video_module()
    if mod is None:
        log("no generated motion: kleo_video is not in this image")
        return False
    remote = footage_backend() == "kie"
    if not remote:
        try:
            if not mod.can_generate():
                log("no generated motion: this machine has no usable GPU")
                return False
        except Exception as e:
            log("no generated motion:", e)
            return False
    if not units:
        log("no generated motion: no shot carries a description to film")
        return False

    project_json, build = os.path.join(pdir, "project.json"), os.path.join(pdir, "build")
    os.makedirs(build, exist_ok=True)
    progress("voice", 8, message="voicing the script to find the cuts")
    engine_step([keou_python(engine), os.path.join(engine, "prepare.py"), project_json],
                engine, log_path, "the voice pass", VOICE_TIMEOUT_MIN)
    engine_step(["node", os.path.join(engine, "engine", "render.mjs"), project_json, "--shots"],
                engine, log_path, "the shot timing pass", SHOTS_TIMEOUT_MIN)
    plan, seconds = shot_plan(build)
    if not plan or not seconds:
        log("no generated motion: the engine did not say when the shots cut")
        return False
    # The frame comes from the plan, never recomputed here: the footage has to match the canvas the graphics will
    # be drawn on to the pixel, and the engine is the only thing entitled to decide what that is.
    width, height, fps = int(plan["width"]), int(round(plan["height"])), int(plan.get("fps") or 60)
    look, fmt, n = project.get("look") or "realistic", project.get("format") or "9:16", len(units)

    progress("clips", 12, eta_min=(round(n * 0.4) + 2) if remote else (round(n * 2.6) or None),
             message=f"filming {n} shots ({'kie.ai' if remote else look}, {width}x{height})")
    try:
        # Each shot brings its own still when the picture pass drew one (shot.image = "img/<file>" under the
        # project): the video model animates THAT frame instead of inventing the scene from the text again.
        shots = [{"id": u["id"], "image_prompt": u["image_prompt"], "motion": u["motion"], "strength": u["strength"],
                  "image": still_of(u["shot"], pdir)} for u in units]
        # Two roads to the same dict: kie.ai through the server, or this box's own model.
        made = (remote_clips(shots, look, fmt, os.path.join(pdir, CLIPS_DIR), seconds_of=seconds) if remote
                else mod.generate_clips(shots, look, fmt, os.path.join(pdir, CLIPS_DIR), seconds_of=seconds))
    except Exception as e:
        log("filming failed:", e)
        return False
    made = made if isinstance(made, dict) else {}
    missing = [u["id"] for u in units
               if not (isinstance(made.get(u["id"]), str) and os.path.isfile(made[u["id"]]))]
    if missing:
        log(f"{len(missing)} of {n} shots did not film ({', '.join(missing[:6])}): drawing from the stills instead")
        return False

    for u in units:
        # contract.py validates this path: it must resolve inside the project's clips/ folder and exist.
        u["shot"]["clip"] = f"{CLIPS_DIR}/{os.path.basename(made[u['id']])}"
    if not lay_track:
        progress("clips", 55, message=f"{n} shots filmed; the track is laid on the finish box")
        return True
    progress("clips", 55, message=f"{n} shots filmed, laying the track")
    if not lay_footage(pdir, made, width, height, fps):
        return False
    progress("clips", 62, message="the track is under the graphics")
    return True


def lay_footage(pdir, made, width, height, fps):
    """build/footage.mp4 from the clips: the 60 fps 4K track. CPU work (minterpolate, Lanczos, the grade): the
    finish phase of a two-phase film runs exactly this on a box that costs cents."""
    mod = local_video_module()
    build = os.path.join(pdir, "build")

    def report(done, total):
        # One report per finished part: the server's silence sensor (RENDER_SILENCE_MIN) must hear this stage.
        progress("clips", 62 + int(14 * done / max(1, total)), message=f"track: {done}/{total} parts finished")

    try:
        import inspect
        # Only a build_footage that knows how to report gets the callback (the fakes in the tests, and any older
        # kleo_video on a box, do not): the track is laid either way.
        extra = {"progress_fn": report} if "progress_fn" in inspect.signature(mod.build_footage).parameters else {}
        track = mod.build_footage(os.path.join(build, "shots.json"), made, os.path.join(build, "footage.mp4"),
                                  width, height, fps=fps, log_fn=log, **extra)
    except Exception as e:
        log("could not lay the track:", e)
        return False
    return bool(track)


def strip_kleo_fields(project):
    """Turns a Kleo storyboard into an engine project: drops kleo_style and every image_prompt (scene and shot level;
    the pictures stay as shot.image / scene.image) and writes the engine's own top-level "look" (cartoon | realistic | animation)
    for the picture style, so the engine knows which typography to draw. cyber / stickman never get a look."""
    style = project.pop("kleo_style", None)
    if style in PICTURE_STYLES and project.get("style") == "picture":
        project["look"] = style
    else:
        project.pop("look", None)  # the engine refuses a look outside the picture style
    for s in project.get("scenes") or []:
        if isinstance(s, dict):
            s.pop("image_prompt", None)
            for sh in shots_of(s):
                if isinstance(sh, dict):
                    sh.pop("image_prompt", None)
                    # Authoring fields: the server has already turned shot_kind into the concrete `motion` and
                    # `strength` the engine draws with, so the kind and its planned duration stop here.
                    for f in ("shot_kind", "dur"):
                        sh.pop(f, None)


def prepare_project(job, engine, projects_dir):
    """build_project + Kleo pictures + <projects_dir>/<id>/project.json. Returns (project, project_dir). No rendering here."""
    project = build_project(job, engine)
    pdir = os.path.join(projects_dir, project["id"])
    shutil.rmtree(pdir, ignore_errors=True)
    os.makedirs(pdir)
    pictures = "no pictures"
    if wants_pictures(project):
        # Policy (KLEO_PICTURES): auto → the server first, then this machine's GPU for whatever is still missing;
        # server → only the server; local → only this machine (no images call at all).
        policy, style, ids = pictures_policy(), project["kleo_style"], picture_ids(project)
        ready, generated, missing = [], [], list(ids)
        if policy != "local":
            progress("script", 4, message=f"fetching {len(ids)} pictures ({style})")
            reply = fetch_pictures(JOB)
            if reply and reply["missing"]:
                log("pictures the server could not make:", reply["missing"])
            ready, missing = attach_pictures(project, pdir, reply)
        if missing and policy != "server":
            if local_pictures_available():
                progress("script", 5, message=f"generating {len(missing)} pictures on the GPU ({style})")
                generated = generate_local_pictures(project, pdir, missing)
                missing = [m for m in missing if m not in generated]
            else:
                log(f"pictures: {len(missing)} missing and no GPU here (policy {policy}); rendering without them")
        pictures = f"{len(ready)} pictures from server, {len(generated)} generated on the GPU, {len(missing)} missing"
        log("pictures:", pictures, "server", ready, "gpu", generated, "missing", missing, "policy", policy)
        progress("script", 5, message=pictures)
    # Read the shots to film BEFORE the strip: it is about to take every image_prompt out of the project.
    units = video_units(project) if wants_footage(project) else []
    # AND TAKE THE BACKDROP STRAIGHT BACK OFF. The storyboard declares it as a REQUEST; the project on disk may
    # only declare it as a FACT, and it is not a fact until the clips exist. contract.py refuses a video backdrop
    # with a missing clip, and the voice pass validates this very file before the clips can possibly exist — the
    # cut times come from the timeline the voice pass is about to make. So the request lives in `units` from here
    # on, and render_keou writes the backdrop back only once every clip is on disk.
    project.pop("backdrop", None)
    strip_kleo_fields(project)
    write_project(project, pdir)
    log(f"project {project['id']}: {len(project['scenes'])} scenes, {project['format']} {project['width']}px {project['fps']} fps, "
        f"{project['language']}/{project['voice']}, style {project.get('style')}, {pictures}"
        + (f", {len(units)} shots to film" if units else ""))
    return project, pdir, units


def write_project(project, pdir):
    """project.json, written whole. It is written twice for a filmed project: once so the voice and timing passes
    have something to read, and again once the clips are attached — or once the backdrop has been taken off."""
    with open(os.path.join(pdir, "project.json"), "w") as f:
        json.dump(project, f, ensure_ascii=False, indent=2)


def render_keou(job, out_dir):
    engine = os.path.abspath(KEOU_DIR)
    run_py = os.path.join(engine, "run.py")
    if not os.path.isfile(run_py):
        # Not retried: a retry would rent another instance with the same image and fail the same way.
        raise RenderError(f"Keou engine not found at {engine} (VAST_IMAGE must ship the engine; set KLEO_KEOU_DIR or KLEO_ENGINE=placeholder)", retry=False)
    progress("script", 3, message="preparing the storyboard")
    project, pdir, units = prepare_project(job, engine, os.path.join(engine, "projects"))
    progress("script", 6, message=f"{len(project['scenes'])} scenes")
    log_path = os.path.join(out_dir, "log.txt")

    # `units` is the request to film: prepare_project fills it only when the storyboard asked, and it took the
    # backdrop off the project on the way past. The backdrop goes back on ONLY here, and only once the clips are
    # real — never as a promise. Without a track the engine would draw the graphics onto a transparent canvas with
    # nothing behind them, which is worse than the stills it replaced.
    if units:
        if generate_footage(project, pdir, engine, log_path, units):
            project["backdrop"] = "video"
        else:
            for u in units:
                u["shot"].pop("clip", None)
            log("no track: this film is drawn from the stills")
        write_project(project, pdir)

    # THE USER'S MUSIC (22 September): the voice pass first (it writes the timeline the track is cut to, and a silent
    # music.wav), then the track over that file, then the render with the voice already on disk. A track that does
    # not come leaves the silence the voice pass wrote: the film is never late or lost for its music.
    if wants_music(project):
        build = os.path.join(pdir, "build")
        if not os.path.isfile(os.path.join(build, "timeline.json")):
            progress("voice", 8, message="voicing the script")
            engine_step([keou_python(engine), os.path.join(engine, "prepare.py"), os.path.join(pdir, "project.json")],
                        engine, log_path, "the voice pass", VOICE_TIMEOUT_MIN)
        fetch_music(project, build, log_path)
    # If anything above needed the shot times, the script is already voiced; run.py checks that alignment itself
    # against the script before it trusts it.
    run_keou(engine, os.path.join(pdir, "project.json"), len(project["scenes"]), log_path,
             skip_voice=os.path.isfile(os.path.join(pdir, "build", "timeline.json")))

    out = os.path.join(pdir, "out")
    master, captions = os.path.join(out, "master.mp4"), os.path.join(out, "captions.srt")
    if not os.path.isfile(master) or os.path.getsize(master) == 0:
        raise RenderError("engine finished without out/master.mp4", retry=True)
    if not os.path.isfile(captions):
        raise RenderError("engine finished without out/captions.srt", retry=True)
    progress("finishing", 92, message="packaging")
    video = os.path.join(out_dir, "video.mp4")
    srt = os.path.join(out_dir, "subtitles.srt")
    shutil.copy2(master, video)
    shutil.copy2(captions, srt)
    stills = sorted(glob.glob(os.path.join(out, "qa", "001-*.png")))
    thumb = thumbnail_from(video, os.path.join(out_dir, "thumbnail.jpg"), stills[0] if stills else None)
    progress("finishing", 95, message="encoded")
    return {"video.mp4": video, "subtitles.srt": srt, "thumbnail.jpg": thumb}


# The narration alone, cleaned and normalised to -16 LUFS: run.py's voice chain without the music bus.
VOICE_CHAIN = ("aresample=48000,highpass=f=75,lowpass=f=12000,acompressor=threshold=0.15:ratio=2:attack=15:release=180,"
               "volume=1.6,loudnorm=I=-16:TP=-1.5:LRA=7,aresample=48000,aformat=channel_layouts=stereo")
# The narration WITH the user's track: run.py's own mix (the voice cleaned, the music ducked under every spoken word by
# the sidechain, the two summed and normalised to -16 LUFS). Inputs: [1:a] the voice, [2:a] the shaped track.
# Both inputs of the sidechain are forced to one format (25 September 2026, job gt_ujavdzva): the narration is mono and
# the shaped track stereo, and ffmpeg refused the graph ("The following filters could not choose their formats:
# Parsed_sidechaincompress_7"), so the first film with a music track failed at its last step.
MIX_FMT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
MIX_CHAIN = ("[1:a]aresample=48000,highpass=f=75,lowpass=f=12000,acompressor=threshold=0.15:ratio=2:attack=15:release=180,"
             "volume=1.6," + MIX_FMT + ",asplit=2[v][s];[2:a]aresample=48000," + MIX_FMT + "[m];[m][s]sidechaincompress=threshold=0.025:ratio=5:attack=15:release=320[bed];"
             "[v][bed]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=7,aresample=48000,aformat=channel_layouts=stereo[a]")


def wants_music(project):
    """True when the storyboard asked for the user's track (music "track", src/storyboard.ts header)."""
    return isinstance(project, dict) and project.get("music") == "track"


def shape_music(src, dst, duration):
    """The composer's track cut to the film: looped if shorter, trimmed to `duration`, a soft fade in and a longer fade
    out, levelled to MUSIC_LUFS as a 48 kHz stereo wav — the file run.py's mix (and MIX_CHAIN) reads as build/music.wav."""
    dur = max(1.0, float(duration))
    fade_out = min(3.0, dur / 4)
    af = (f"afade=t=in:st=0:d=1.2,afade=t=out:st={dur - fade_out:.3f}:d={fade_out:.3f},"
          f"loudnorm=I={MUSIC_LUFS:.1f}:TP=-3:LRA=9,aresample=48000,aformat=channel_layouts=stereo")
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-stream_loop", "-1", "-i", src, "-t", f"{dur:.3f}", "-af", af,
                        "-ac", "2", "-ar", "48000", "-c:a", "pcm_s24le", dst], capture_output=True, text=True)
    return r.returncode == 0 and os.path.isfile(dst) and os.path.getsize(dst) > 0


def fetch_music(project, build, log_path=None):
    """The user's track from the server (POST /music orders it from kie.ai, GET /music polls, GET /music/file streams
    it), shaped over build/music.wav. Returns True when the track is under the film, False when the film goes on
    without it — the reason is in the log, and nothing here raises: music is never worth the film."""
    brief = str(project.get("music_brief") or "").strip() or "a quiet instrumental bed that fits the film's mood, under the narration"
    try:
        timeline = json.load(open(os.path.join(build, "timeline.json")))
        duration = float(timeline["duration"])
    except (OSError, ValueError, KeyError, TypeError) as e:
        log("music: no timeline to cut the track to:", e)
        return False
    progress("music", 9, message="ordering the music track")
    try:
        st = api("POST", f"/internal/jobs/{JOB}/music", {"brief": brief, "seconds": round(duration, 2), "title": str(project.get("title") or "")[:72]})
    except urllib.error.HTTPError as e:
        log(f"music: the server refused the track ({e.code}); the film goes on without it")
        return False
    except Exception as e:
        log("music: the request failed:", e, "; the film goes on without it")
        return False
    deadline = time.time() + MUSIC_WAIT_MIN * 60
    state = (st or {}).get("state") if isinstance(st, dict) else None
    while state not in ("ready", "failed", "off", "none"):
        if time.time() > deadline:
            log(f"music: not ready after {MUSIC_WAIT_MIN:.0f} min; the film goes on without it")
            return False
        time.sleep(MUSIC_POLL_S)
        try:
            st = api("GET", f"/internal/jobs/{JOB}/music")
        except Exception as e:
            log("music: status call failed:", e)
            continue
        state = (st or {}).get("state") if isinstance(st, dict) else None
    if state != "ready":
        log(f"music: {state}: {(st or {}).get('error', '')}; the film goes on without it")
        return False
    src = os.path.join(build, "music.src")
    try:
        req = urllib.request.Request(f"{API}/internal/jobs/{JOB}/music/file")
        req.add_header("Authorization", f"Bearer {SECRET}")
        req.add_header("User-Agent", UA)
        with urllib.request.urlopen(req, timeout=300) as r, open(src, "wb") as f:
            shutil.copyfileobj(r, f, 1 << 20)
        if not 0 < os.path.getsize(src) <= MUSIC_MAX_BYTES:
            raise ValueError(f"track is {os.path.getsize(src)} bytes")
    except Exception as e:
        log("music: could not download the track:", e, "; the film goes on without it")
        return False
    dst = os.path.join(build, "music.wav")
    if not shape_music(src, dst, duration):
        log("music: could not shape the track; the film goes on without it")
        try: os.remove(dst)
        except OSError: pass
        return False
    log(f"music: the track is under the film ({duration:.1f} s, {MUSIC_LUFS:.0f} LUFS before the duck)")
    progress("music", 10, message="the music is under the film")
    return True


def srt_time(t):
    ms = int(round(max(0.0, t) * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def write_srt(timeline, path):
    """A sidecar .srt from the caption groups the voice pass aligned. Nothing is burnt into the film; the file is
    for whoever wants captions on the platform's side."""
    n, lines = 0, []
    for sc in timeline.get("scenes") or []:
        for c in sc.get("captions") or []:
            text = str(c.get("text") or "").strip()
            if not text:
                continue
            n += 1
            lines += [str(n), f"{srt_time(float(c['start']))} --> {srt_time(float(c['end']))}", text, ""]
    with open(path, "w") as f:
        f.write("\n".join(lines))
    return path


def film_checks(video, timeline):
    """The delivery checks that matter for a film with nothing drawn on it: its length is the narration's, no
    black interval, no second without motion. Raises RenderError (no retry: a second card would film the same)."""
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                               capture_output=True, text=True).stdout.strip() or 0)
    want = float(timeline.get("duration") or 0)
    if abs(dur - want) > 0.25:
        raise RenderError(f"the film is {dur:.2f} s, the narration {want:.2f} s", retry=False)
    dec = subprocess.run(["ffmpeg", "-nostdin", "-v", "info", "-i", video, "-vf", "scale=270:-2,blackdetect=d=0.15:pic_th=0.98:pix_th=0.02",
                          "-an", "-f", "null", "-"], capture_output=True, text=True).stderr
    black = re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", dec)
    if black:
        raise RenderError(f"black interval in the film: {black[:3]}", retry=False)
    mod = local_video_module()
    worst = max((secs for _, secs in mod.frozen_runs(video)), default=0.0) if mod and hasattr(mod, "frozen_runs") else 0.0
    if worst >= 1.0:
        raise RenderError(f"{worst:.1f} s of the film without motion", retry=False)
    return dur, worst


GEN_BUNDLE = "gen.tgz"      # what the GPU phase hands to the finish phase, through R2


def film_generate(job, out_dir, lay_track=True):
    """Phase one of the film: reference frames, the voice pass, the shot plan, the clips (and the track when this
    box also finishes). Returns (project, pdir). Where render_keou falls back to the stills when filming fails,
    this refuses: a film that was not filmed is not this product."""
    engine = os.path.abspath(KEOU_DIR)
    if not os.path.isfile(os.path.join(engine, "run.py")):
        raise RenderError(f"Keou engine not found at {engine}", retry=False)
    progress("script", 3, message="preparing the storyboard")
    project, pdir, units = prepare_project(job, engine, os.path.join(engine, "projects"))
    if not units:
        raise RenderError("no shot carries a description to film: a film needs shots", retry=False)
    log_path = os.path.join(out_dir, "log.txt")
    if not generate_footage(project, pdir, engine, log_path, units, lay_track=lay_track):
        raise RenderError("the shots did not film (see log.txt); there is no film without them", retry=False)
    return project, pdir


def pack_gen(pdir, out_dir):
    """gen.tgz: everything the finish box needs and nothing else — the plan, the timings, the voice and the raw
    clips (tens of MB). Not the engine, not the model. The pictures travel ONLY when the film carries a layer:
    film_overlay runs the engine over the footage, and contract.py refuses a project whose shot.image is not on
    disk (video gt_rvhmhx55, 15 September 2026: five clips filmed and paid, then "Asset must exist inside the
    project: img/01-whale-s1.png" at 80%). A film with no layer never opens the engine again, so it keeps the
    bundle small."""
    bundle = os.path.join(out_dir, GEN_BUNDLE)
    members = ["project.json", "build/timeline.json", "build/shots.json", "build/voice.wav", CLIPS_DIR]
    if project_has_layer(pdir):
        members.append(IMG_DIR)
    present = [m for m in members if os.path.exists(os.path.join(pdir, m))]
    for need in ("build/timeline.json", "build/shots.json", "build/voice.wav", CLIPS_DIR):
        if need not in present:
            raise RenderError(f"the GPU phase ended without {need}", retry=True)
    r = subprocess.run(["tar", "czf", bundle, "-C", pdir, *present], capture_output=True, text=True)
    if r.returncode != 0 or not os.path.isfile(bundle):
        raise RenderError("could not pack the bundle: " + r.stderr[-300:], retry=True)
    log(f"bundle: {os.path.getsize(bundle) / 1e6:.0f} MB ({', '.join(present)})")
    return bundle


def unpack_gen(bundle, engine):
    """The finish box's project dir, rebuilt from the bundle. Returns pdir."""
    pdir = os.path.join(os.path.abspath(engine), "projects", project_id_for(JOB))
    shutil.rmtree(pdir, ignore_errors=True); os.makedirs(pdir)
    r = subprocess.run(["tar", "xzf", bundle, "-C", pdir], capture_output=True, text=True)
    if r.returncode != 0:
        raise RenderError("could not unpack the bundle: " + r.stderr[-300:], retry=True)
    return pdir


def film_finish(pdir, out_dir, lay_track=False):
    """Phase two: the track (when it is not there yet), the narration on it, the checks, the deliverables."""
    build = os.path.join(pdir, "build")
    footage, voice = os.path.join(build, "footage.mp4"), os.path.join(build, "voice.wav")
    timeline = json.load(open(os.path.join(build, "timeline.json")))
    if lay_track or not os.path.isfile(footage):
        plan, _ = shot_plan(build)
        if not plan:
            raise RenderError("the bundle carries no shot plan", retry=False)
        made = {}
        for sc in plan.get("scenes") or []:
            for sh in sc.get("shots") or []:
                cid = f"{sc['id']}-s{int(sh.get('index', 0)) + 1}"
                path = os.path.join(pdir, CLIPS_DIR, cid + ".mp4")
                if os.path.isfile(path):
                    made[cid] = path
        if not made:
            raise RenderError("the bundle carries no clips", retry=False)
        progress("clips", 62, message=f"laying the track from {len(made)} clips")
        if not lay_footage(pdir, made, int(plan["width"]), int(round(plan["height"])), int(plan.get("fps") or 60)):
            raise RenderError("could not lay the track", retry=True)
    for need in (footage, voice):
        if not os.path.isfile(need) or os.path.getsize(need) == 0:
            raise RenderError(f"missing {os.path.basename(need)} after the footage pass", retry=True)
    video = os.path.join(out_dir, "video.mp4")
    project_json = os.path.join(pdir, "project.json")
    try:
        project = json.load(open(project_json))
    except (OSError, ValueError):
        project = {}
    # THE USER'S MUSIC (22 September): fetched here, on the finish box, over build/music.wav; a layer's engine run
    # mixes that file, the plain mux below takes it as its third input.
    music = os.path.join(build, "music.wav")
    with_music = wants_music(project) and fetch_music(project, build)
    if isinstance(project.get("graphics"), dict):
        # THE LAYER (src/graphics.ts): this film has something drawn over it, decided by its treatment. The engine
        # draws it on a transparent canvas and render.mjs composites it onto build/footage.mp4 inside the encoder;
        # the mix (the voice, and the user's track when there is one) comes out of the same run.
        progress("film", 80, message="drawing the layer over the film")
        film_overlay(pdir, project, timeline, out_dir, video)
    else:
        progress("film", 80, message="the narration goes on the film" + (" with the music" if with_music else ""))
        if with_music and os.path.isfile(music):
            cmd = ["ffmpeg", "-v", "error", "-y", "-i", footage, "-i", voice, "-i", music, "-filter_complex", MIX_CHAIN]
        else:
            cmd = ["ffmpeg", "-v", "error", "-y", "-i", footage, "-i", voice, "-filter_complex", f"[1:a]{VOICE_CHAIN}[a]"]
        r = subprocess.run(cmd + ["-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
                                  "-t", f"{float(timeline['duration']):.3f}", video], capture_output=True, text=True)
        if r.returncode != 0 or not os.path.isfile(video):
            raise RenderError("could not put the narration on the film: " + r.stderr[-300:], retry=True)
    dur, worst = film_checks(video, timeline)
    log(f"film: {dur:.1f} s, longest run without motion {worst:.1f} s, {os.path.getsize(video) / 1e6:.0f} MB")
    progress("finishing", 92, message="packaging")
    thumb = thumbnail_from(video, os.path.join(out_dir, "thumbnail.jpg"), None)
    progress("finishing", 95, message="encoded")
    # The subtitles as a sidecar, always (22 September): burned in only when the user said yes (then they are the
    # layer's cinema subtitles, drawn by the engine); the .srt is for the platform's own caption track either way.
    srt = write_srt(timeline, os.path.join(out_dir, "subtitles.srt"))
    return {"video.mp4": video, "subtitles.srt": srt, "thumbnail.jpg": thumb}


IMG_DIR = "img"                           # the pictures the shots were filmed from; contract.py wants shot.image on disk
# A 1x1 transparent PNG: the stand-in for a picture the finish box does not have. The layer is drawn on a transparent
# canvas over build/footage.mp4, so the picture behind it is never seen — but the contract still wants a file.
BLANK_PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082")


def project_has_layer(pdir):
    """True when <pdir>/project.json carries a graphics object: the finish box will run the engine over the film."""
    try:
        project = json.load(open(os.path.join(pdir, "project.json")))
    except (OSError, ValueError):
        return False
    return isinstance(project, dict) and isinstance(project.get("graphics"), dict)


def bind_shot_clips(pdir, project):
    """Every shot gets its clip path before the engine looks: with a video backdrop the contract wants "clip" on
    each shot, and the bundle's project.json was written before the GPU box filmed anything (the one-box path sets
    shot.clip in memory after filming; the two-phase path never wrote it back — video gt_645zn2k8, 15 September:
    "every shot needs a 'clip' when the project has a video backdrop" at 80%). The clip of shot n of a scene is
    clips/<scene id>-s<n>.mp4, the name the GPU box gave it. A shot whose clip is not on disk is a hole in the
    track, so it is refused here in one sentence instead of by the contract. Returns the number of shots bound."""
    clips_dir = os.path.join(pdir, CLIPS_DIR)
    on_disk = sorted(n for n in os.listdir(clips_dir) if n.endswith(".mp4")) if os.path.isdir(clips_dir) else []
    if not on_disk:
        # A track laid from the stills (no clip was ever filmed): nothing to bind, the engine decides what it accepts.
        return 0
    bound = 0
    for sc in project.get("scenes") or []:
        for i, sh in enumerate(sc.get("shots") or []):
            if not isinstance(sh, dict):
                continue
            cid = f"{sc.get('id')}-s{i + 1}"
            rel = f"{CLIPS_DIR}/{cid}.mp4"
            if not os.path.isfile(os.path.join(pdir, rel)):
                raise RenderError(f"the bundle carries no clip for shot {cid}; the layer cannot be drawn over a hole", retry=False)
            sh["clip"] = rel
            bound += 1
    return bound


def ensure_shot_pictures(pdir, project):
    """Every shot.image / scene.image the project names exists under <pdir> before the engine checks it. Pictures the
    bundle carried are left alone; a missing one becomes BLANK_PNG (never drawn: the backdrop is the video). Returns
    the list of paths it had to stand in for."""
    stood_in = []
    for sc in project.get("scenes") or []:
        refs = [sc.get("image")] + [sh.get("image") for sh in (sc.get("shots") or []) if isinstance(sh, dict)]
        for ref in refs:
            if not isinstance(ref, str) or not ref.strip():
                continue
            path = os.path.join(pdir, ref)
            if os.path.isfile(path):
                continue
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(BLANK_PNG)
            stood_in.append(ref)
    return stood_in


def film_overlay(pdir, project, timeline, out_dir, video):
    """The engine over the footage: project.json gets its backdrop back (the track is on disk now), the user's music
    stays "track" when fetch_music laid it over build/music.wav (else none, and a missing music.wav becomes silence
    of the film's length: run.py's mix expects the file), and run.py renders with --skip-voice: hud.js draws the
    layer on a transparent canvas, render.mjs composites it onto build/footage.mp4 and muxes the mix. out/master.mp4
    is the film."""
    engine = os.path.abspath(KEOU_DIR)
    build = os.path.join(pdir, "build")
    project = json.loads(json.dumps(project))   # a deep copy: the shots below are edited in place
    project["backdrop"] = "video"
    if not (wants_music(project) and os.path.isfile(os.path.join(build, "music.wav"))):
        project["music"] = "none"
        project.pop("music_brief", None)
    bound = bind_shot_clips(pdir, project)
    missing = ensure_shot_pictures(pdir, project)
    with open(os.path.join(pdir, "project.json"), "w") as f:
        json.dump(project, f, ensure_ascii=False, indent=2)
    log(f"layer: {bound} shot(s) bound to their clips")
    if missing:
        log(f"layer: {len(missing)} picture(s) not in the bundle, blank stand-ins written ({', '.join(missing[:3])}{', …' if len(missing) > 3 else ''})")
    music = os.path.join(build, "music.wav")
    if not os.path.isfile(music):
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                            "-t", f"{float(timeline['duration']):.3f}", "-c:a", "pcm_s24le", music], capture_output=True, text=True)
        if r.returncode != 0 or not os.path.isfile(music):
            raise RenderError("could not make the silent music track for the layer: " + r.stderr[-300:], retry=True)
    run_keou(engine, os.path.join(pdir, "project.json"), len(project.get("scenes") or []), os.path.join(out_dir, "log.txt"), skip_voice=True)
    master = os.path.join(pdir, "out", "master.mp4")
    if not os.path.isfile(master) or os.path.getsize(master) == 0:
        raise RenderError("the engine finished the layer without out/master.mp4", retry=True)
    shutil.copy2(master, video)
    return video


def render_film(job, out_dir):
    """The film, pure, on ONE box: both phases here. Used when the server did not split the job (KLEO_PHASE unset)."""
    project, pdir = film_generate(job, out_dir, lay_track=True)
    return film_finish(pdir, out_dir)


def wants_film(job):
    """A storyboard that asks to be filmed gets the film, pure; everything else still goes through the engine."""
    sb = job.get("storyboard")
    if isinstance(sb, str):
        try: sb = json.loads(sb)
        except ValueError: sb = None
    return isinstance(sb, dict) and sb.get("backdrop") == "video"


def render(job, out_dir):
    if ENGINE == "placeholder":
        return render_placeholder(job, out_dir)
    if ENGINE != "keou":
        raise RenderError(f"unknown KLEO_ENGINE {ENGINE!r} (keou or placeholder)", retry=False)
    if wants_film(job):
        return render_film(job, out_dir)
    return render_keou(job, out_dir)


def upload_log(out_dir):
    p = os.path.join(out_dir or "", "log.txt")
    try:
        if out_dir and os.path.isfile(p) and os.path.getsize(p) > 0:
            upload(p, "log.txt")
    except Exception as e:
        log("log upload failed:", e)


def main():
    if not (API and JOB and SECRET):
        log("missing KLEO_API / KLEO_JOB_ID / KLEO_SECRET"); sys.exit(2)
    watchdog()
    started = time.time()
    out_dir = None
    try:
        job = api("GET", f"/internal/jobs/{JOB}")
        log("job", JOB, job.get("template"), job.get("params"), "engine", ENGINE, "storyboard" if job.get("storyboard") else "no storyboard")
        progress("script", 1, message="worker started")
        log("footage backend:", set_footage_backend(job))
        out_dir = tempfile.mkdtemp(prefix="kleo-")
        phase = (os.environ.get("KLEO_PHASE") or job.get("phase") or "").strip().lower()
        cost = None
        dph = os.environ.get("KLEO_DPH")                      # optional: orchestrator can pass the hourly price
        if phase == "gen" and wants_film(job):
            # The GPU half of a two-phase film: frames, voice, plan, clips — then the bundle goes up, the card goes
            # back, and a box that costs cents lays the track. Every minute this card spends on ffmpeg is a minute
            # of the dearest machine on the account doing CPU work.
            project, pdir = film_generate(job, out_dir, lay_track=False)
            bundle = pack_gen(pdir, out_dir)
            progress("clips", 58, message="uploading the clips for the finish box")
            upload(bundle, GEN_BUNDLE)
            upload_log(out_dir)
            api("POST", f"/internal/jobs/{JOB}/phase", {"phase": "finish"})
            log("gen phase done in %.0f s; handed over" % (time.time() - started))
            self_destruct("gen phase done")
            return
        if phase == "finish":
            engine = os.path.abspath(KEOU_DIR)
            bundle = os.path.join(out_dir, GEN_BUNDLE)
            progress("clips", 60, message="fetching the clips")
            download(GEN_BUNDLE, bundle)
            pdir = unpack_gen(bundle, engine)
            files = film_finish(pdir, out_dir, lay_track=True)
        else:
            files = render(job, out_dir)
        for name, path in files.items():
            progress("finishing", 97, message=f"uploading {name}")
            upload(path, name)
        upload_log(out_dir)
        if dph:
            cost = round(float(dph) * (time.time() - started) / 3600, 4)
        api("POST", f"/internal/jobs/{JOB}/done", {"cost_usd": cost})
        log("done in %.0f s" % (time.time() - started))
        self_destruct("finished")
    except Exception as e:
        retry = getattr(e, "retry", True)
        log("FAILED:", e, "(retry)" if retry else "(no retry)"); traceback.print_exc()
        upload_log(out_dir)
        api_safe_fail(str(e)[:500], retry=retry)
        self_destruct("failed")


if __name__ == "__main__":
    main()
