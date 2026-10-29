"""
THE KLEO MARK ON FREE RENDERS (29 October 2026).

The video of an account that never paid (the animatic its gift buys, or the launch-code trial film) leaves the box
with "Made with Kleo" burned in, so every road it travels (Studio's copy, the MCP /dl links, the job-done e-mail)
advertises Kleo. The server decides when the job is created (src/mark.ts, params.mark); this module obeys an explicit
True only, and fails open: a video it cannot mark ships clean, on time and whole, never broken.

One pass on the finished video.mp4, right before the upload (kleo_worker.main), so every engine and both film phases
go through it: overlay of made-with-kleo.png (the same file as studio-web/made-with-kleo.png), libx264 veryfast CRF 17
like the engine's own master (keou/engine/render.mjs), audio copied, then checked against the input. Every decoded
frame is encoded once with its own timestamp (passthrough): a master joined from parts can sit a hair off the 1/60
grid, and a constant-rate output would add a frame there. The blend runs in YUV, so the 4K frames are never converted
to RGB and back; only the small mark is.

WHERE, and why not where Studio puts it on pictures and clips (src/studio/watermark.ts markPlacement): the engine's own
layer owns those corners (keou/engine/picture.js geo(), in 1080x1920 / 1920x1080 design pixels):
  - 9:16: the chapter pill top left at 12%, the "Kleo" brand top right, the captions from about 27% down, the bottom 22%
    under the platform's buttons. The mark goes on the left, 20% down: under the pill and a HUD stamp, above the
    captions. A HUD readout (up to four rows) top left reaches that spot, so the mark moves to the right; with readouts
    in both top corners it goes down to 50%, between the captions and the subtitles.
  - 16:9: the chapter top left, the captions bottom left, the subtitles bottom centre, the brand bottom right. The mark
    goes on the right, 22% down.
Same sizes as Studio's: 32% of a tall frame's width, 22% of a wide one's, never under 96 px, a margin of 4% of the width.
At 2160x3840 that is 691x186 at (86, 768); at 3840x2160, 845x227 at (2841, 475).

Kleo product code: it runs on the rented box and in GitHub's tests (worker/test_kleo_mark.py), never on the owner's PC.
"""
import json, os, re, subprocess, time

MARK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "made-with-kleo.png")
MARK_W, MARK_H = 1428, 384
MARK_OPACITY = 0.9


def js_round(x):
    """Math.round of JavaScript (half up; Python's round() halves to even), the rounding of every other copy of the rule."""
    return int(x + 0.5)


def placement(w, h, busy=frozenset()):
    """(width, height, x, y) of the mark on a w x h render, or None when the frame is too small for it.
    `busy`: the corners where the job's HUD draws a readout (hud_corners)."""
    if w < 64 or h < 64:
        return None
    tall = h >= w * 1.25
    margin = js_round(w * 0.04)
    width = min(w - 2 * margin, max(96, js_round(w * (0.32 if tall else 0.22))))
    height = max(1, js_round(width * MARK_H / MARK_W))
    if not tall:
        x, y = w - width - margin, js_round(h * 0.22)
    elif "top-left" not in busy:
        x, y = margin, js_round(h * 0.20)
    elif "top-right" not in busy:
        x, y = w - width - margin, js_round(h * 0.20)
    else:
        x, y = margin, js_round(h * 0.50)
    if y + height > h - margin:
        return None
    return (width, height, x, y)


def hud_corners(job):
    """The corners where the storyboard's layer draws a HUD readout (keou/engine/hud.js): its rows can reach the mark."""
    sb = (job or {}).get("storyboard")
    if isinstance(sb, str):
        try:
            sb = json.loads(sb)
        except ValueError:
            return frozenset()
    g = sb.get("graphics") if isinstance(sb, dict) else None
    hud = g.get("hud") if isinstance(g, dict) else None
    if not isinstance(hud, list):
        return frozenset()
    return frozenset(e.get("corner") for e in hud if isinstance(e, dict) and e.get("kind") == "readout" and isinstance(e.get("corner"), str))


_SYNC = None


def sync_args():
    """Every decoded frame out once, with its own timestamp. -fps_mode exists from ffmpeg 5.1; the box's 4.4 has -vsync."""
    global _SYNC
    if _SYNC is None:
        new = False
        try:
            v = subprocess.run(["ffmpeg", "-hide_banner", "-version"], capture_output=True, text=True, timeout=30).stdout
            m = re.search(r"ffmpeg version n?(\d+)\.(\d+)", v)
            new = (int(m.group(1)), int(m.group(2))) >= (5, 1) if m else v.startswith("ffmpeg version N-")
        except Exception:
            pass
        _SYNC = ["-fps_mode", "passthrough"] if new else ["-vsync", "passthrough"]
    return _SYNC


def wanted(job):
    """True only when the server put mark: true on the job's params (a string or a dict)."""
    p = (job or {}).get("params") or {}
    if isinstance(p, str):
        try:
            p = json.loads(p)
        except ValueError:
            return False
    return isinstance(p, dict) and p.get("mark") is True


def probe(path):
    """What the pass must keep: size, frame count, frame rate, length and whether there is a sound track."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-count_packets", "-show_entries",
         "stream=codec_type,width,height,nb_read_packets,r_frame_rate:format=duration", "-of", "json", path],
        check=True, capture_output=True, text=True, timeout=180,
    ).stdout
    j = json.loads(out)
    streams = j.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    num, _, den = (v.get("r_frame_rate") or "0/1").partition("/")
    fps = float(num or 0) / float(den or 1) if float(den or 1) else 0.0
    return {
        "w": int(v.get("width") or 0), "h": int(v.get("height") or 0), "frames": int(v.get("nb_read_packets") or 0),
        "fps": fps, "duration": float((j.get("format") or {}).get("duration") or 0),
        "audio": any(s.get("codec_type") == "audio" for s in streams),
    }


def burn(src, dst, timeout=None, busy=frozenset()):
    """Writes src with the mark burned in to dst and checks it. Returns (input probe, placement). Raises on any problem."""
    if not os.path.isfile(MARK):
        raise RuntimeError("made-with-kleo.png is not in the image")
    got_in = probe(src)
    at = placement(got_in["w"], got_in["h"], busy)
    if not at:
        raise RuntimeError("a %dx%d video is too small for the mark" % (got_in["w"], got_in["h"]))
    mw, mh, x, y = at
    graph = (f"[1:v]scale={mw}:{mh}:flags=lanczos,format=rgba,colorchannelmixer=aa={MARK_OPACITY},format=yuva420p[m];"
             f"[0:v][m]overlay={x}:{y}:format=yuv420[v]")
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src, "-i", MARK, "-filter_complex", graph,
         "-map", "[v]", "-map", "0:a?", *sync_args(), "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-profile:v", "high",
         "-pix_fmt", "yuv420p", "-c:a", "copy", "-map_metadata", "0", "-movflags", "+faststart", dst],
        check=True, capture_output=True, timeout=timeout or max(180, 6 * got_in["duration"]),
    )
    out = probe(dst)
    wrong = []
    if (out["w"], out["h"]) != (got_in["w"], got_in["h"]):
        wrong.append("size %dx%d, not %dx%d" % (out["w"], out["h"], got_in["w"], got_in["h"]))
    if got_in["frames"] and out["frames"] != got_in["frames"]:
        wrong.append("%d frames, not %d" % (out["frames"], got_in["frames"]))
    if got_in["fps"] and abs(out["fps"] - got_in["fps"]) > 0.1:
        wrong.append("%.3f fps, not %.3f" % (out["fps"], got_in["fps"]))
    if abs(out["duration"] - got_in["duration"]) > max(2.0 / (got_in["fps"] or 30), 0.05):
        wrong.append("%.3f s long, not %.3f" % (out["duration"], got_in["duration"]))
    if got_in["audio"] and not out["audio"]:
        wrong.append("the sound track was lost")
    if wrong:
        raise RuntimeError("the marked video does not match the render: " + "; ".join(wrong))
    return got_in, at


def mark_files(job, files, out_dir, log=print, progress=None, thumbnail=None):
    """(files, outcome): the delivered files with the mark burned into video.mp4 when the server asked for it, and what
    happened ({"applied": bool, "why": str or None, "seconds": float}; None when the job is not marked). The files are
    untouched when it is not asked, and when the pass fails (fail open: the video ships clean, the outcome says why).

    `thumbnail(video, out_path)` cuts the poster again from the marked video, so the poster carries the mark too."""
    if not wanted(job):
        return files, None
    started = time.time()
    video = (files or {}).get("video.mp4")
    if not video or not os.path.isfile(video):
        log("mark: no video.mp4 to mark")
        return files, {"applied": False, "why": "no video.mp4 to mark", "seconds": 0.0}
    if progress:
        progress("finishing", 96, message="adding the Kleo mark")
    tmp = os.path.join(out_dir, "video.marked.mp4")
    try:
        info, (mw, mh, x, y) = burn(video, tmp, busy=hud_corners(job))
    except Exception as e:
        said = getattr(e, "stderr", None) or str(e) or type(e).__name__
        if isinstance(said, bytes):
            said = said.decode("utf-8", "replace")
        why = str(said).strip()[-300:]
        log("mark: FAILED, the video ships without it:", why)
        try:
            os.remove(tmp)
        except OSError:
            pass
        return files, {"applied": False, "why": why, "seconds": round(time.time() - started, 1)}
    os.replace(tmp, video)
    log("mark: %dx%d at %d,%d on %dx%d, %d frames, in %.0f s" % (mw, mh, x, y, info["w"], info["h"], info["frames"], time.time() - started))
    thumb = files.get("thumbnail.jpg")
    if thumb and thumbnail:
        fresh = os.path.join(out_dir, "thumbnail.marked.jpg")
        try:
            thumbnail(video, fresh)
            if os.path.isfile(fresh) and os.path.getsize(fresh) > 0:
                os.replace(fresh, thumb)
            else:
                log("mark: the thumbnail could not be cut again from the marked video; the old one ships")
        except Exception as e:
            log("mark: the thumbnail could not be cut again:", e)
    return files, {"applied": True, "why": None, "seconds": round(time.time() - started, 1)}
