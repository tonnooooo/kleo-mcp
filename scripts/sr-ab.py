#!/usr/bin/env python3
"""
The A/B of the neural finish (worker/kleo_sr.py: Real-ESRGAN + RIFE 4.25 on the card) against today's chain
(Lanczos + minterpolate on the CPU), on a real job's bundle, with the production code itself — kleo_video.build_footage
on the job's own shots.json and clips, once per variant. Driven by scripts/sr-ab.sh through `devbox.py guarded`.

Nothing of the probe passes through the owner's computer: the box uploads its evidence to R2 as extra files of the job
(PUT /internal/admin/probe/<job>/<name>, src/probe.ts) and the operator hands the owner signed /dl links.

    ON THE OPERATOR'S MACHINE (INTERNAL_SECRET from the environment or .secrets.local; never printed)
      sr-ab.py --sign <job> <file> [--hours H]        a signed /dl link to one of the job's files (gen.tgz, probe/…)
      sr-ab.py --sign-upload <job> [--hours H]        the query string of an upload capability for <job>'s probe/ prefix
      sr-ab.py --links <job> <name>... [--hours H]    signed /dl links of the probe files the box uploaded
    ON THE BOX (the job's gen.tgz unpacked in <dir>; KLEO_API, KLEO_PROBE_JOB, KLEO_PROBE_UPLOAD in the environment)
      sr-ab.py --run <dir> --out <out>                every variant, the measures, the evidence, the upload
      sr-ab.py --upload <out>                         the upload alone (a retry)

Variants (each is the whole footage track of the film, 4K 60 fps, the way the finish box lays it):
    A    today: KLEO_SR=off                        -> finish_vf (minterpolate + Lanczos + unsharp 0.45)
    B2   the default: SR x4 (x4v3 dn 0.5, or animevideov3 for an animated look) -> RIFE -> finish_vf_sr, sharpen 0.2
    B0   the same with sharpen 0
    C    RealESRGAN_x2plus x2 -> RIFE -> Lanczos x2.25 (the cheaper alternative)
    D    one shot only (the one that moves most): RIFE at the source size, THEN SR on every 60 fps frame — the order
         question, measured instead of argued
The log's last lines carry the summary; results.json carries everything. Prints AB_DONE or AB_FAIL at the very end.
"""
import argparse, glob, hashlib, hmac, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.environ.get("KLEO_API", "https://mcp.kleooai.com").rstrip("/")
UA = "kleo-sr-ab/1.0 (+https://kleooai.com)"   # Cloudflare refuses Python's default user agent (error 1010)
PART = 50 * 1024 * 1024
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def say(*a):
    print(*a, flush=True)


# ---- the operator's side: links and capabilities, signed locally ------------------------------------------------------

def secret():
    s = os.environ.get("INTERNAL_SECRET", "").strip()
    if not s:
        try:
            for line in open(os.path.join(REPO, ".secrets.local")):
                if line.startswith("INTERNAL_SECRET="):
                    s = line.split("=", 1)[1].strip().strip('"')
        except OSError:
            pass
    if not s:
        raise SystemExit("INTERNAL_SECRET is not set (environment or .secrets.local)")
    return s


def sign(job, name, hours):
    """/dl/<job>/<name>?exp&sig, the same HMAC as src/util.ts hmacHex over "<job>/<name>/<exp>" (src/dl.ts)."""
    exp = int(time.time() + hours * 3600)
    sig = hmac.new(secret().encode(), f"{job}/{name}/{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{PUBLIC}/dl/{job}/{urllib.parse.quote(name, safe='')}?exp={exp}&sig={sig}"


def sign_upload(job, hours):
    """exp=…&sig=… for PUT /internal/admin/probe/<job>/… (src/probe.ts probeUploadSig); at most a day."""
    exp = int(time.time() + min(hours, 23.5) * 3600)
    sig = hmac.new(secret().encode(), f"probe/{job}/{exp}".encode(), hashlib.sha256).hexdigest()
    return f"exp={exp}&sig={sig}"


# ---- the box's side: upload -------------------------------------------------------------------------------------------

def _call(method, path, body=None, ctype="application/octet-stream"):
    q = os.environ["KLEO_PROBE_UPLOAD"]
    req = urllib.request.Request(f"{PUBLIC}{path}?{q}", data=body, method=method, headers={"User-Agent": UA, "Content-Type": ctype})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:
                raise RuntimeError(f"{method} {path.split('?')[0]} -> {e.code}")
        except Exception as e:
            say(f"  upload hiccup ({type(e).__name__}), retrying")
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"{method} {path} failed four times")


def upload_one(path, name):
    job = os.environ["KLEO_PROBE_JOB"]
    base = f"/internal/admin/probe/{job}/{name}"
    size = os.path.getsize(path)
    if size <= 90 * 1024 * 1024:
        with open(path, "rb") as f:
            return _call("PUT", base, f.read())
    uid = _call("POST", base + "/uploads")["uploadId"]
    parts, n = [], 1
    with open(path, "rb") as f:
        while True:
            chunk = f.read(PART)
            if not chunk:
                break
            r = _call("PUT", f"{base}/uploads/{urllib.parse.quote(uid, safe='/=+')}/parts/{n}", chunk)
            parts.append({"partNumber": r["partNumber"], "etag": r["etag"]})
            n += 1
    return _call("POST", f"{base}/uploads/{urllib.parse.quote(uid, safe='/=+')}/complete", json.dumps({"parts": parts}).encode(), "application/json")


def upload(out):
    """Every file of the evidence, flat, as probe/<name> of the job. Writes out/uploaded.txt (the names)."""
    files = sorted(glob.glob(os.path.join(out, "*.*")) + glob.glob(os.path.join(out, "frames", "*.jpg")))
    files = [p for p in files if not p.endswith(("uploaded.txt", ".part"))]
    done, failed = [], []
    for p in files:
        name = os.path.basename(p)
        try:
            upload_one(p, name)
        except Exception as e:                   # one file refused is no reason to lose the others
            failed.append(name)
            say(f"  could not upload probe/{name}: {str(e)[:160]}")
            continue
        done.append(f"probe/{name}")
        say(f"  uploaded probe/{name} ({os.path.getsize(p) / 1e6:.1f} MB)")
        open(os.path.join(out, "uploaded.txt"), "w").write(" ".join(done) + "\n")
    if failed:
        raise RuntimeError(f"{len(failed)} file(s) not uploaded: {', '.join(failed)[:200]}")
    return done


# ---- the box's side: measures ----------------------------------------------------------------------------------------

def laplacian_var(gray):
    """Edge energy, higher = sharper (the same measure as scripts/sharpness-ab.py)."""
    import numpy as np
    g = gray.astype(np.float64)
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(lap.var())


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,r_frame_rate:format=duration", "-of", "json", path], capture_output=True, text=True)
    j = json.loads(r.stdout or "{}")
    st = (j.get("streams") or [{}])[0]
    num, _, den = str(st.get("r_frame_rate", "0/1")).partition("/")
    return {"width": st.get("width"), "height": st.get("height"), "fps": round(float(num) / float(den or 1), 3),
            "duration": round(float((j.get("format") or {}).get("duration") or 0), 3)}


def frame(path, t, png):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", png], check=True)
    return png


def gray_frames(path, t, n, w, h):
    """n consecutive frames from t, half size, grey, as numpy arrays."""
    import numpy as np
    hw, hh = w // 2, h // 2
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", path, "-frames:v", str(n), "-vf",
                          f"scale={hw}:{hh},format=gray", "-f", "rawvideo", "-"], capture_output=True).stdout
    k = len(raw) // (hw * hh)
    return [np.frombuffer(raw[i * hw * hh:(i + 1) * hw * hh], np.uint8).reshape(hh, hw) for i in range(k)]


def flicker(frames):
    """Mean |high-pass(f_t) - high-pass(f_t+1)| where the picture does not move (Farneback flow under ~1 px): detail
    that changes where nothing moves is shimmer, not motion. Lower is steadier."""
    import cv2
    import numpy as np
    vals = []
    for a, b in zip(frames[:-1], frames[1:]):
        ha = a.astype(np.float32) - cv2.GaussianBlur(a, (0, 0), 2).astype(np.float32)
        hb = b.astype(np.float32) - cv2.GaussianBlur(b, (0, 0), 2).astype(np.float32)
        sa, sb = cv2.resize(a, (a.shape[1] // 4, a.shape[0] // 4)), cv2.resize(b, (b.shape[1] // 4, b.shape[0] // 4))
        fl = cv2.calcOpticalFlowFarneback(sa, sb, None, .5, 3, 15, 3, 5, 1.2, 0)
        mag = cv2.resize(np.sqrt(fl[..., 0] ** 2 + fl[..., 1] ** 2), (a.shape[1], a.shape[0])) * 4
        mask = mag < 1.0
        if mask.mean() > 0.02:
            vals.append(float(np.abs(hb - ha)[mask].mean()))
    return round(float(np.mean(vals)), 4) if vals else None


class GpuSampler:
    """nvidia-smi in the background while a variant runs: mean utilisation and peak memory."""

    def __init__(self, path):
        self.path = path
        self.p = subprocess.Popen(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits",
                                   "-lms", "500"], stdout=open(path, "w"), stderr=subprocess.DEVNULL)

    def stop(self):
        self.p.terminate()
        self.p.wait()
        rows = []
        for line in open(self.path):
            try:
                u, m = (float(x) for x in line.split(","))
                rows.append((u, m))
            except ValueError:
                pass
        if not rows:
            return {}
        return {"gpu_util_mean": round(sum(u for u, _ in rows) / len(rows), 1),
                "gpu_util_busy_share": round(sum(1 for u, _ in rows if u > 50) / len(rows), 2),
                "vram_peak_mb": max(m for _, m in rows)}


# ---- the box's side: the variants -------------------------------------------------------------------------------------

def run_variant(tag, kv, srm, shots_json, clips, width, height, fps, root, sharpen=None, force_factor=None, sr=True):
    os.environ["KLEO_SR"] = "auto" if sr else "off"
    kv.SR_BUDGET_MIN = 1e9                        # the probe measures; the estimate is kept from the log line
    kv.SR_DEADLINE_MIN = float(os.environ.get("SR_AB_VARIANT_MIN", "30"))   # a hung card still ends the variant
    kv.SHARPEN_SR = 0.2 if sharpen is None else sharpen
    orig_plan = srm.plan
    if force_factor:
        srm.plan = lambda *a: force_factor
    lines = []
    out = os.path.join(root, tag, "footage.mp4")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    gpu = GpuSampler(os.path.join(root, tag, "gpu.csv"))
    t0 = time.time()
    error = None
    try:
        track = kv.build_footage(shots_json, clips, out, width, height, fps=fps,
                                 log_fn=lambda *a: (lines.append(" ".join(str(x) for x in a)), say(f"  [{tag}]", *a)))
    except Exception as e:                       # one variant failing is a result; the others still run
        track, error = None, f"{type(e).__name__}: {str(e)[:300]}"
    finally:
        wall = time.time() - t0
        srm.plan = orig_plan
        g = gpu.stop()
    info = {"minutes": round(wall / 60, 2), **g, "log": lines}
    info["sr"] = next((l for l in lines if l.startswith("SR on") or l.startswith("SR off")), None)
    info["fallbacks"] = [l for l in lines if "Lanczos path" in l]
    if not track:
        info["error"] = error or "build_footage returned nothing"
        return None, info
    info["track"] = probe(track)
    info["frozen_max_s"] = max((s for _, s in kv.frozen_runs(track)), default=0.0)
    return track, info


def variant_d(kv, srm, src, usable, stretch, want, fps, factor, look, width, height, out):
    """The other order, on one part: RIFE at the source size first, then SR on every output frame."""
    import torch
    name = srm.model_for(look, factor)
    d, s, half = srm.load_sr(name, "cuda")
    net = srm.load_rife("cuda")
    w, h, sfps, matrix = srm.probe(src)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-t", f"{usable:.3f}", "-i", src, "-an", "-vf",
                          f"scale=in_color_matrix={matrix},format=rgb24", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True).stdout
    n = w * h * 3
    frames = [srm._to_tensor(raw[k * n:(k + 1) * n], w, h, torch.device("cuda"), half) for k in range(len(raw) // n)]
    mid = out[:-4] + "-mid.mp4"
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w * s}x{h * s}", "-r", str(fps),
                            "-i", "-", "-vf", f"scale=out_color_matrix={matrix}:out_range=tv,format=yuv420p", "-c:v", "libx264",
                            "-preset", "ultrafast", "-crf", "10", mid], stdin=subprocess.PIPE)
    t0 = time.time()
    for i, t in srm.timeline(sfps, fps, stretch, min(want, usable * stretch), n_src=len(frames)):
        a = frames[i]
        y = srm._rife_frame(net, a, frames[min(i + 1, len(frames) - 1)], t, 1.0) if t else a
        z = srm._sr_frame(d, s, y, None)
        enc.stdin.write((z[0] * 255.0).round_().clamp_(0, 255).to(torch.uint8).permute(1, 2, 0).contiguous().cpu().numpy().tobytes())
    enc.stdin.close()
    enc.wait()
    gpu_s = time.time() - t0
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mid, "-vf", kv.finish_vf_sr(width, height, want), "-t", f"{want:.3f}",
                    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", out], check=True)
    os.remove(mid)
    return {"gpu_seconds": round(gpu_s, 1), "frames_sr": len(srm.timeline(sfps, fps, stretch, min(want, usable * stretch)))}


def dump(results, out):
    """results.json as it stands: written after every variant and on the way out, so a late failure still leaves the
    evidence of everything measured before it (and the error) for upload()."""
    try:
        os.makedirs(out, exist_ok=True)
        tmp = os.path.join(out, "results.json.part")
        with open(tmp, "w") as f:
            json.dump(results, f, indent=1, default=str)
        os.replace(tmp, os.path.join(out, "results.json"))
    except Exception as e:
        say(f"  results.json could not be written ({e})")


def run(ab, out):
    """Every variant and every measure; results.json whatever happens (a partial one carries "error"). Raises on failure."""
    os.makedirs(os.path.join(out, "frames"), exist_ok=True)
    results = {"job": os.environ.get("KLEO_PROBE_JOB"), "variants": {}, "shots": {}}
    try:
        _measure(ab, out, results)
    except BaseException as e:
        results["error"] = f"{type(e).__name__}: {str(e)[:300]}"
        raise
    finally:
        dump(results, out)
    for k, v in (results.get("summary") or {}).items():
        say(f"SUMMARY {k}: {json.dumps(v)}"[:158])
    return results


def _measure(ab, out, results):
    sys.path.insert(0, os.path.join(REPO, "worker"))
    import kleo_video as kv
    import kleo_sr as srm
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    root = os.path.join(ab, "var")
    shots_json = os.path.join(ab, "build", "shots.json")
    plan = json.load(open(shots_json))
    width, height, fps = int(plan["width"]), int(round(plan["height"])), int(plan.get("fps") or 60)
    look = kv._look_of(shots_json)
    shots, clips, part = [], {}, 0
    for sc in plan.get("scenes") or []:
        for sh in sc.get("shots") or []:
            cid = f"{sc['id']}-s{int(sh.get('index', 0)) + 1}"
            path = os.path.join(ab, "clips", cid + ".mp4")
            if os.path.isfile(path):
                clips[cid] = path
                # `part`: the index build_footage gives this shot's file (footage-parts/NNN.mp4), black shots included
                shots.append({"id": cid, "start": float(sh["start"]), "end": float(sh["end"]), "part": part})
            part += 1
    if not clips:
        raise SystemExit("the bundle carries no clips")
    say(f"job {os.environ.get('KLEO_PROBE_JOB')}: {len(clips)} clips, {width}x{height} {fps} fps, look {look}, GPU {srm.gpu_name()}")
    ok, why = srm.available()
    say(f"kleo_sr.available(): {ok} ({why})")
    results.update({"gpu": srm.gpu_name(), "look": look, "size": f"{width}x{height}", "fps": fps, "available": [ok, why]})
    try:
        results["weights"] = open(os.path.join(srm.SR_DIR, srm.MANIFEST)).read().splitlines()   # the sha256 of every weight used
    except OSError:
        results["weights"] = None
    w0, h0 = kv._size_of(next(iter(clips.values())))
    factor = srm.plan(w0, h0, width, height)
    results["source"] = f"{w0}x{h0}"
    results["factor"] = factor
    tracks = {}
    for tag, kw in (("A", {"sr": False}), ("B2", {"sharpen": 0.2}), ("B0", {"sharpen": 0.0}), ("C", {"force_factor": 2})):
        say(f"== variant {tag} ==")
        tracks[tag], results["variants"][tag] = run_variant(tag, kv, srm, shots_json, clips, width, height, fps, root, **kw)
        v = results["variants"][tag]
        say(f"  {tag}: {v.get('minutes')} min, {v.get('sr')}, track {v.get('track')}, frozen max {v.get('frozen_max_s')}")
        srm.release()
        dump(results, out)

    # Per shot, at the same instant in every track: sharpness, shimmer, luma, and the pictures to look at.
    font = ImageFont.truetype(FONT, 48) if os.path.isfile(FONT) else ImageFont.load_default()
    thumbs = []
    for sh in shots:
        t = (sh["start"] + sh["end"]) / 2
        row = {"t": round(t, 3), "lap": {}, "flicker": {}, "luma": {}}
        imgs = {}
        for tag, track in tracks.items():
            if not track:
                continue
            png = frame(track, t, os.path.join(root, f"{sh['id']}-{tag}.png"))
            im = Image.open(png).convert("RGB")
            imgs[tag] = im
            g = np.asarray(im.convert("L"))
            row["lap"][tag] = round(laplacian_var(g), 1)
            row["luma"][tag] = round(float(g.mean()), 2)
            row["flicker"][tag] = flicker(gray_frames(track, max(0.0, t - 0.1), 13, width, height))
        results["shots"][sh["id"]] = row
        if "A" in imgs and "B2" in imgs:
            a, b = imgs["A"], imgs["B2"]
            side = Image.new("RGB", (a.width * 2 + 16, a.height), (255, 255, 255))
            side.paste(a, (0, 0)); side.paste(b, (a.width + 16, 0))
            dr = ImageDraw.Draw(side)
            dr.text((40, 40), "A  today", fill=(255, 255, 255), font=font, stroke_width=3, stroke_fill=(0, 0, 0))
            dr.text((a.width + 56, 40), "B  neural", fill=(255, 255, 255), font=font, stroke_width=3, stroke_fill=(0, 0, 0))
            side.save(os.path.join(out, "frames", f"frame-{sh['id']}-AB.jpg"), quality=90)
            c = 960
            crops = [(tag, imgs[tag]) for tag in ("A", "B0", "B2", "C") if tag in imgs]
            strip = Image.new("RGB", (c * len(crops) + 8 * (len(crops) - 1), c), (255, 255, 255))
            for k, (tag, im) in enumerate(crops):
                x0, y0 = (im.width - c) // 2, (im.height - c) // 2
                strip.paste(im.crop((x0, y0, x0 + c, y0 + c)), (k * (c + 8), 0))
                ImageDraw.Draw(strip).text((k * (c + 8) + 24, 24), tag, fill=(255, 255, 255), font=font, stroke_width=3, stroke_fill=(0, 0, 0))
            strip.save(os.path.join(out, "frames", f"frame-{sh['id']}-crop.jpg"), quality=92)
            tw = 360
            thumbs.append((sh["id"], a.resize((tw, int(a.height * tw / a.width))), b.resize((tw, int(b.height * tw / b.width)))))
    if thumbs:
        tw, th = thumbs[0][1].size
        sheet = Image.new("RGB", (len(thumbs) * (tw + 8) + 8, 2 * th + 24), (20, 20, 20))
        for k, (_, a, b) in enumerate(thumbs):
            sheet.paste(a, (8 + k * (tw + 8), 8)); sheet.paste(b, (8 + k * (tw + 8), th + 16))
        sheet.save(os.path.join(out, "contact.jpg"), quality=90)

    # The order question, on the shot that moves most.
    moving = sorted(shots, key=lambda s: -(kv.travel_px(clips[s["id"]]) or 0.0))
    hero = moving[0] if moving else None
    if hero and tracks.get("B2") and ok:
        try:
            src = clips[hero["id"]]
            want = hero["end"] - hero["start"]
            have = kv.seconds_of(src) or want
            tail = 0.0
            for start, secs in kv.frozen_runs(src):
                if secs >= kv.FROZEN_S and start + secs >= have - 0.25:
                    tail = have - start
            stretch, usable, _ = kv.plan_fill(want, have, tail)
            dpart = os.path.join(root, "D", "part.mp4"); os.makedirs(os.path.dirname(dpart), exist_ok=True)
            d = variant_d(kv, srm, src, usable, stretch, want, fps, factor, look, width, height, dpart)
            bpart = os.path.join(root, "B2", "footage-parts", f"{hero['part']:03d}.mp4")
            tm = want / 2
            dg, bg = gray_frames(dpart, max(0.0, tm - 0.1), 13, width, height), gray_frames(bpart, max(0.0, tm - 0.1), 13, width, height)
            d.update({"shot": hero["id"], "flicker": {"D": flicker(dg), "B2": flicker(bg)},
                      "lap": {"D": round(laplacian_var(dg[0]), 1) if dg else None, "B2": round(laplacian_var(bg[0]), 1) if bg else None}})
            results["variants"]["D"] = d
        except Exception as e:
            results["variants"]["D"] = {"error": str(e)[:300]}
        srm.release()

    # The clips the owner watches: an 8 s wipe on the shot that moves most, and the two whole films with the voice.
    voice = os.path.join(ab, "build", "voice.wav")
    if tracks.get("A") and tracks.get("B2"):
        dur = results["variants"]["A"]["track"]["duration"]
        t0 = max(0.0, min(hero["start"] if hero else 0.0, dur - 8.0))
        seg = min(8.0, dur)
        vf = (f"[0:v]crop=iw/2:ih:0:0[a];[1:v]crop=iw/2:ih:iw/2:0[b];[a][b]hstack,drawbox=x=iw/2-3:y=0:w=6:h=ih:color=white@0.9:t=fill,"
              f"drawtext=fontfile={FONT}:text='A today':x=40:y=40:fontsize=72:fontcolor=white:borderw=4:bordercolor=black,"
              f"drawtext=fontfile={FONT}:text='B neural':x=w/2+40:y=40:fontsize=72:fontcolor=white:borderw=4:bordercolor=black[v]")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t0:.3f}", "-t", f"{seg:.3f}", "-i", tracks["A"], "-ss", f"{t0:.3f}", "-t", f"{seg:.3f}",
                        "-i", tracks["B2"], "-filter_complex", vf, "-map", "[v]", "-r", str(fps), "-c:v", "libx264", "-preset", "veryfast",
                        "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", os.path.join(out, "split-4k60.mp4")], check=True)
        for tag, name in (("A", "film-A-4k60.mp4"), ("B2", "film-B-4k60.mp4")):
            cmd = ["ffmpeg", "-v", "error", "-y", "-i", tracks[tag]]
            cmd += (["-i", voice, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "192k", "-shortest"] if os.path.isfile(voice) else [])
            subprocess.run(cmd + ["-c:v", "copy", "-movflags", "+faststart", os.path.join(out, name)], check=True)

    # The summary: what the gate reads.
    import statistics as st
    def ratio(metric, a, b):
        vals = [r[metric][b] / r[metric][a] for r in results["shots"].values() if r[metric].get(a) and r[metric].get(b)]
        return round(st.median(vals), 2) if vals else None
    va, vb = results["variants"].get("A", {}), results["variants"].get("B2", {})
    shifts = [r["luma"]["B2"] - r["luma"]["A"] for r in results["shots"].values() if "B2" in r["luma"] and "A" in r["luma"]]
    results["summary"] = {
        "minutes": {k: v.get("minutes") for k, v in results["variants"].items() if isinstance(v, dict) and "minutes" in v},
        "sharpness_x_B2_over_A": ratio("lap", "A", "B2"), "sharpness_x_B0_over_A": ratio("lap", "A", "B0"), "sharpness_x_C_over_A": ratio("lap", "A", "C"),
        "flicker_x_B2_over_A": ratio("flicker", "A", "B2"), "flicker_x_B0_over_A": ratio("flicker", "A", "B0"), "flicker_x_C_over_A": ratio("flicker", "A", "C"),
        "luma_shift_B2_minus_A": round(st.mean(shifts), 2) if shifts else None,
        "same_length": (va.get("track") or {}).get("duration") == (vb.get("track") or {}).get("duration"),
        "frozen_max_s": {k: v.get("frozen_max_s") for k, v in results["variants"].items() if isinstance(v, dict) and "frozen_max_s" in v},
        "sr_line_B2": vb.get("sr"), "fallbacks_B2": len(vb.get("fallbacks") or []),
    }
    s = results["summary"]
    s["gate"] = {"sharpness_1_5x": (s["sharpness_x_B2_over_A"] or 0) >= 1.5, "flicker_le_1_15x": (s["flicker_x_B2_over_A"] or 99) <= 1.15,
                 "no_new_frozen": (s["frozen_max_s"].get("B2") or 0) <= (s["frozen_max_s"].get("A") or 0) + 1e-6, "same_length": s["same_length"]}
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sign", nargs=2, metavar=("JOB", "FILE"))
    ap.add_argument("--sign-upload", metavar="JOB")
    ap.add_argument("--links", nargs="+", metavar="JOB NAME")
    ap.add_argument("--hours", type=float, default=72.0)
    ap.add_argument("--run", metavar="DIR")
    ap.add_argument("--out", default="/opt/kleo/ab/out")
    ap.add_argument("--upload", metavar="OUT")
    a = ap.parse_args()
    if a.sign:
        print(sign(a.sign[0], a.sign[1], a.hours)); return
    if a.sign_upload:
        print(sign_upload(a.sign_upload, a.hours)); return
    if a.links:
        job, names = a.links[0], [n for n in a.links[1:] if n.startswith("probe/")]
        for n in names:
            print(f"{n}: {sign(job, n, a.hours)}")
        return
    for k in ("KLEO_PROBE_JOB", "KLEO_PROBE_UPLOAD"):
        if not os.environ.get(k):
            raise SystemExit(f"{k} is not set")
    sys.exit(box(a.run, a.upload or a.out))


def box(ab, out):
    """The box's whole run: the measures (when `ab`), then the upload of whatever evidence exists — ALWAYS, even
    after a failure 40 minutes in, because the box is destroyed right after and a lost probe must be paid for again.
    Prints AB_DONE, or AB_FAIL with the first error; returns the exit code."""
    import traceback
    failure = None
    if ab:
        try:
            run(ab, out)
        except BaseException as e:
            traceback.print_exc()
            failure = e
    try:
        names = upload(out)
        say(f"PROBE_FILES {len(names)} uploaded")
    except BaseException as e:
        traceback.print_exc()
        failure = failure or e
    if failure is not None:
        say(f"AB_FAIL {type(failure).__name__}: {str(failure)[:200]}")
        return 1
    say("AB_DONE")
    return 0


if __name__ == "__main__":
    main()
