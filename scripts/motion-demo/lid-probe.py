#!/usr/bin/env python3
"""Is the footage VISIBLE under the graphics, or is there a lid? Runs ON THE BOX, before any clip is paid for.

    python3 scripts/motion-demo/lid-probe.py            -> prints LID_OK or LID_BLACK, exits 0 / 1

The 13 September lesson, twice over: a film was generated, saved, tracked, composited — and delivered as captions
on black. First an INK background painted over the footage (picture.js), then an opaque canvas context made at
load that init() could not make transparent (film.js). Both invisible to every unit test, both visible in one
frame of a real composite. So this probe MAKES that frame, with the real engine and the real ffmpeg overlay, on a
one-scene project whose "footage" is ffmpeg's colour bars: ~1 minute of the box, no model, no GPU work.

    LID_OK      the colour bars show through the middle of the frame (mean saturation high, luminance mid)
    LID_BLACK   the frame is dark where the bars should be: the graphics layer is opaque, do NOT film anything
"""
import json, os, shutil, subprocess, sys, tempfile

ENGINE = os.environ.get("KLEO_KEOU_DIR", "/opt/kleo/keou")
PY = os.environ.get("KLEO_KEOU_PYTHON", sys.executable)


def sh(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        print(r.stdout[-1500:], r.stderr[-1500:])
        raise SystemExit(f"failed: {' '.join(map(str, cmd))[:120]}")
    return r.stdout


def main():
    pdir = os.path.join(ENGINE, "projects", "lid-probe")
    shutil.rmtree(pdir, ignore_errors=True); os.makedirs(os.path.join(pdir, "build"))
    project = {
        "schema_version": 1, "editorial_status": "ready", "id": "lid-probe", "title": "Lid probe", "brand": "Kleo",
        "style": "picture", "look": "realistic", "backdrop": "video", "format": "16:9", "width": 1920, "fps": 30,
        "language": "en", "voice": "am_michael", "music": "none",
        "scenes": [{"id": "01-probe", "kind": "cinema", "chapter": "01 PROBE", "accent": "amber", "title": "Lid probe",
                    "voice": "Colour bars must show through this frame.", "hold": 0.3,
                    "shots": [{"image_prompt": "colour bars", "motion": "static_hold", "strength": 0}]}],
    }
    json.dump(project, open(os.path.join(pdir, "project.json"), "w"), indent=1)
    # the voice pass: the engine will not render without a timeline, and the timeline needs the words' timing
    sh([PY, os.path.join(ENGINE, "prepare.py"), os.path.join(pdir, "project.json")], cwd=ENGINE)
    tl = json.load(open(os.path.join(pdir, "build", "timeline.json")))
    dur = float(tl["duration"])
    # the "footage": colour bars, exactly the film's length and frame — what the real track would be
    sh(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"smptehdbars=size=1920x1080:rate=30:duration={dur + 0.5:.3f}",
        "-pix_fmt", "yuv420p", os.path.join(pdir, "build", "footage.mp4")])
    sh(["node", os.path.join(ENGINE, "engine", "render.mjs"), os.path.join(pdir, "project.json"), "--workers", "1"], cwd=ENGINE)
    parts = [f for f in os.listdir(os.path.join(pdir, "build")) if f.startswith("part-") and f.endswith(".mp4")]
    if not parts:
        raise SystemExit("the engine wrote no part")
    part = os.path.join(pdir, "build", sorted(parts)[0])
    # the middle band of a frame from the middle: mean of Y and of chroma spread, on the raw pixels
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{dur / 2:.2f}", "-i", part, "-frames:v", "1",
                          "-vf", "crop=iw*0.8:ih*0.4:iw*0.1:ih*0.3,scale=64:32,format=rgb24", "-f", "rawvideo", "-"],
                         capture_output=True).stdout
    px = [raw[i:i + 3] for i in range(0, len(raw), 3)]
    if not px:
        raise SystemExit("no frame")
    lum = sum(0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2] for p in px) / len(px) / 255
    sat = sum((max(p) - min(p)) for p in px) / len(px) / 255
    print(f"middle band: luminance {lum:.2f}, saturation {sat:.2f}  (bars under a veil: ~0.3-0.6 / >0.25; a lid: <0.1 / <0.05)")
    ok = lum > 0.12 and sat > 0.12
    print("LID_OK" if ok else "LID_BLACK", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
