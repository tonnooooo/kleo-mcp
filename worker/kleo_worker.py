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
Kleo pictures (keou engine only): a storyboard may carry "kleo_style" (cartoon | realistic | cyber | stickman) and, per
scene, an "image_prompt". For cartoon/realistic the worker asks POST /internal/jobs/{id}/images for the pictures the
server generated (one per scene with a prompt), downloads them into <project>/img/<sceneId>.<ext> and sets scene.image;
kleo_style and image_prompt are stripped before project.json is written. A missing or broken picture is never fatal:
the scene simply renders without it.
Tuning: KLEO_WIDTH_PORTRAIT (2160) / KLEO_WIDTH_LANDSCAPE (1920), KLEO_RENDER_TIMEOUT_MIN (100),
        KLEO_IMAGES_TIMEOUT_S (300: the images call, the server generates on the first request), KLEO_IMAGES_RETRY_WAIT_S (20),
        KLEO_KEOU_WORKERS (Chromium render workers for run.py: default min(8, cpu count); each one costs RAM),
        KLEO_KEOU_PYTHON (interpreter for run.py: default <engine>/.venv/bin/python if present, else this one).
Standard library only, so it runs in any image with python3 and ffmpeg.
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
WIDTH_PORTRAIT = int(os.environ.get("KLEO_WIDTH_PORTRAIT", "2160"))
WIDTH_LANDSCAPE = int(os.environ.get("KLEO_WIDTH_LANDSCAPE", "1920"))
KEOU_WORKERS = min(16, int(os.environ.get("KLEO_KEOU_WORKERS", "0") or 0))  # 0 → min(8, cpu count); the engine refuses more than 16
PART = 50 * 1024 * 1024
UA = "kleo-worker/1.0 (+https://github.com/tonnooooo/kleo-mcp)"
# Kleo pictures: kleo_style values that come with server-generated pictures, and the knobs of the images call.
PICTURE_STYLES = ("cartoon", "realistic")
IMAGES_TIMEOUT_S = float(os.environ.get("KLEO_IMAGES_TIMEOUT_S", "300"))      # the server generates the pictures on the first call
IMAGES_RETRY_WAIT_S = float(os.environ.get("KLEO_IMAGES_RETRY_WAIT_S", "20"))  # one retry after this long on 5xx / network errors
IMAGE_DOWNLOAD_TIMEOUT_S = 60
IMAGE_MAX_BYTES = 25 * 1024 * 1024
SCENE_ID = re.compile(r"[a-z0-9-]{1,50}")                                       # contract.py scene id slug → safe file name

# Mirrors contract.VOICES; the engine's own contract.py overrides it at run time (see load_voices()).
DEFAULT_VOICES = {"fr": ["ff_siwis"], "en": ["af_heart", "am_michael", "bf_emma"], "it": ["if_sara", "im_nicola"]}
# Kleo voice ids (src/templates.ts) → Kokoro voice ids.
KLEO_VOICE_MAP = {"narrator-en-m": "am_michael", "narrator-en-f": "af_heart", "narrator-it-m": "im_nicola", "narrator-it-f": "if_sara", "narrator-fr-f": "ff_siwis"}
FORBIDDEN_TOP = ("id", "script_file", "music_quiet")


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


def thumbnail_from(video, out_path, png=None):
    """JPEG thumbnail: the engine's QA still of the first scene when present, else the frame at 1 s."""
    if png and os.path.isfile(png):
        try:
            ffmpeg("-i", png, "-frames:v", "1", "-q:v", "3", out_path)
            return out_path
        except subprocess.CalledProcessError:
            log("thumbnail from QA still failed, falling back to the video frame")
    try:
        ffmpeg("-ss", "1", "-i", video, "-frames:v", "1", "-q:v", "3", out_path)
    except subprocess.CalledProcessError:  # shorter than 1 s: take the first frame
        ffmpeg("-i", video, "-frames:v", "1", "-q:v", "3", out_path)
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
    stale = [s.get("id") for s in c["scenes"] if isinstance(s, dict) and "image" in s]
    if stale:  # no asset travels with a job: only the pictures the worker downloads itself (attach_pictures) may be referenced
        log("dropping scene.image (assets never travel with a job):", stale)
        for s in c["scenes"]:
            if isinstance(s, dict):
                s.pop("image", None)

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
                f, total = int(parts[2]), int(parts[4])
                self.total = total
                self.max_frame = max(self.max_frame, f)
                frac = min(1.0, self.max_frame / total) if total else 0
                eta = None
                if self.render_started and frac > 0.02:
                    eta = round((time.time() - self.render_started) * (1 - frac) / frac / 60, 1)
                self.post("clips", 22 + 36 * frac, f"frame {self.max_frame}/{total}", eta_min=eta)
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


def run_keou(engine, project_json, n_scenes, log_path):
    workers = max(1, KEOU_WORKERS) if KEOU_WORKERS > 0 else min(8, os.cpu_count() or 2)
    cmd = [keou_python(engine), os.path.join(engine, "run.py"), project_json, "--workers", str(workers)]
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
# cartoon / realistic storyboards carry an image_prompt per scene; the server turns each one into a picture (once per
# job) and hands out signed download links. Everything in this section is optional for the render: any failure
# leaves the scene without picture and the video is made like a plain Keou project.
def picture_scene_ids(sb):
    """Ids of the scenes carrying an image_prompt, in scene order (whatever the style)."""
    return [s["id"] for s in (sb.get("scenes") or []) if isinstance(s, dict) and isinstance(s.get("id"), str)
            and isinstance(s.get("image_prompt"), str) and s["image_prompt"].strip()]


def wants_pictures(sb):
    """True when the server is expected to hold pictures for this storyboard: cartoon/realistic with at least one image_prompt."""
    return isinstance(sb, dict) and sb.get("kleo_style") in PICTURE_STYLES and bool(picture_scene_ids(sb))


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
    """{"images": {sceneId: url}, "missing": [sceneIds]} from the server, or None when it could not answer.
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


def download_picture(url, img_dir, scene_id):
    """GET a signed picture link (same User-Agent as api(); no bearer, the link is signed) into <img_dir>/<scene_id>.<ext>.
    Returns the file name, or None when anything is off (never raises)."""
    if not (isinstance(scene_id, str) and SCENE_ID.fullmatch(scene_id)):
        log(f"picture: scene id {scene_id!r} is not a slug, skipped")
        return None
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        log(f"picture {scene_id}: no usable link")
        return None
    try:
        req = urllib.request.Request(url, method="GET")
        req.add_header("User-Agent", UA)
        with urllib.request.urlopen(req, timeout=IMAGE_DOWNLOAD_TIMEOUT_S) as r:
            data = r.read(IMAGE_MAX_BYTES + 1)
    except Exception as e:
        log(f"picture {scene_id}: download failed: {e}")
        return None
    if len(data) > IMAGE_MAX_BYTES:
        log(f"picture {scene_id}: larger than {IMAGE_MAX_BYTES} bytes, skipped")
        return None
    ext = image_ext(data)
    if not ext:
        log(f"picture {scene_id}: not a PNG/JPEG/WebP file ({len(data)} bytes), skipped")
        return None
    os.makedirs(img_dir, exist_ok=True)
    name = scene_id + ext
    with open(os.path.join(img_dir, name), "wb") as f:
        f.write(data)
    return name


def attach_pictures(project, pdir, reply):
    """Downloads the server's pictures into <pdir>/img/ and sets scene.image = "img/<sceneId>.<ext>" on every scene that
    has an image_prompt. Returns (ready_ids, missing_ids): a scene without a link, or whose download fails, keeps no picture."""
    images = (reply or {}).get("images") or {}
    ready, missing = [], []
    for s in project.get("scenes") or []:
        if not (isinstance(s, dict) and isinstance(s.get("image_prompt"), str) and s["image_prompt"].strip()):
            continue
        sid = s.get("id")
        name = download_picture(images.get(sid), os.path.join(pdir, "img"), sid) if sid in images else None
        if name:
            s["image"] = "img/" + name
            ready.append(sid)
        else:
            missing.append(sid)
    return ready, missing


def strip_kleo_fields(project):
    """Removes what the engine does not know: kleo_style and every scene's image_prompt (the pictures stay as scene.image)."""
    project.pop("kleo_style", None)
    for s in project.get("scenes") or []:
        if isinstance(s, dict):
            s.pop("image_prompt", None)


def prepare_project(job, engine, projects_dir):
    """build_project + Kleo pictures + <projects_dir>/<id>/project.json. Returns (project, project_dir). No rendering here."""
    project = build_project(job, engine)
    pdir = os.path.join(projects_dir, project["id"])
    shutil.rmtree(pdir, ignore_errors=True)
    os.makedirs(pdir)
    pictures = "no pictures"
    if wants_pictures(project):
        progress("script", 4, message=f"fetching {len(picture_scene_ids(project))} pictures ({project['kleo_style']})")
        reply = fetch_pictures(JOB)
        if reply and reply["missing"]:
            log("pictures the server could not make:", reply["missing"])
        ready, missing = attach_pictures(project, pdir, reply)
        pictures = f"{len(ready)} pictures ready, {len(missing)} missing"
        log("pictures:", pictures, "ready", ready, "missing", missing)
        progress("script", 5, message=pictures)
    strip_kleo_fields(project)
    with open(os.path.join(pdir, "project.json"), "w") as f:
        json.dump(project, f, ensure_ascii=False, indent=2)
    log(f"project {project['id']}: {len(project['scenes'])} scenes, {project['format']} {project['width']}px {project['fps']} fps, "
        f"{project['language']}/{project['voice']}, style {project.get('style')}, {pictures}")
    return project, pdir


def render_keou(job, out_dir):
    engine = os.path.abspath(KEOU_DIR)
    run_py = os.path.join(engine, "run.py")
    if not os.path.isfile(run_py):
        # Not retried: a retry would rent another instance with the same image and fail the same way.
        raise RenderError(f"Keou engine not found at {engine} (VAST_IMAGE must ship the engine; set KLEO_KEOU_DIR or KLEO_ENGINE=placeholder)", retry=False)
    progress("script", 3, message="preparing the storyboard")
    project, pdir = prepare_project(job, engine, os.path.join(engine, "projects"))
    progress("script", 6, message=f"{len(project['scenes'])} scenes")

    run_keou(engine, os.path.join(pdir, "project.json"), len(project["scenes"]), os.path.join(out_dir, "log.txt"))

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


def render(job, out_dir):
    if ENGINE == "placeholder":
        return render_placeholder(job, out_dir)
    if ENGINE != "keou":
        raise RenderError(f"unknown KLEO_ENGINE {ENGINE!r} (keou or placeholder)", retry=False)
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
        out_dir = tempfile.mkdtemp(prefix="kleo-")
        files = render(job, out_dir)
        for name, path in files.items():
            progress("finishing", 97, message=f"uploading {name}")
            upload(path, name)
        upload_log(out_dir)
        cost = None
        dph = os.environ.get("KLEO_DPH")                      # optional: orchestrator can pass the hourly price
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
